/**
 * cron 存储层：以 `crons` 公共 doc 为唯一事实状态，提供按 (id, rev) 代次守卫的
 * 乐观写回、flush 失败回滚、启动期对账，以及跨写操作的串行写锁（含排空等待）。
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import { CRON_DOC_NAME, failCorrupt, type CronClock, type CronDoc, type CronJob, type CronUpdateInput } from './contracts.js'
import { buildUpdatedCronJob } from './inputs.js'
import { assertValidSchedule, nextFireTime, parseCronDoc } from './parse.js'

export interface CronStore {
  readDoc(): CronDoc
  findJob(id: string): CronJob | undefined
  inUseItems(): Array<{ kind: string; id: string; label: string }>
  tryUpdateJob(id: string, rev: string, mutate: (job: CronJob) => CronJob): Promise<boolean>
  createJob(job: Omit<CronJob, 'nextRunAt'> & { nextRunAt?: number }): Promise<CronJob>
  updateJob(input: CronUpdateInput, onBeforeFlush: () => void, onRollback: (prev: CronJob) => void): Promise<CronJob>
  deleteJob(id: string, onBeforeFlush: () => void, onRollback: (deleted: CronJob) => void): Promise<void>
  reconcileOnStart(): Promise<void>
  drainWrites(): Promise<void>
}

export function createCronStore(ctx: HelmxPluginContext, clock: CronClock): CronStore {
  const doc = ctx.doc<CronDoc>(CRON_DOC_NAME, { version: 1, jobs: [] }, { public: true })
  const readDoc = (): CronDoc => parseCronDoc(doc.get())

  let locked = false
  const lockWaiters: Array<() => void> = []
  const drainWaiters: Array<() => void> = []
  const releaseWriteLock = (): void => {
    const next = lockWaiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    locked = false
    for (const notify of drainWaiters.splice(0)) notify()
  }
  const withWriteLock = async <T>(op: () => Promise<T>): Promise<T> => {
    if (locked) {
      await new Promise<void>((resolve) => {
        lockWaiters.push(resolve)
      })
    } else {
      locked = true
    }
    try {
      return await op()
    } finally {
      releaseWriteLock()
    }
  }

  const tryUpdateJob = async (id: string, rev: string, mutate: (job: CronJob) => CronJob): Promise<boolean> =>
    withWriteLock(async () => {
      const current = readDoc()
      const index = current.jobs.findIndex((j) => j.id === id)
      const prevJob = index >= 0 ? current.jobs[index] : undefined
      if (prevJob === undefined || prevJob.rev !== rev) return false
      const jobs = [...current.jobs]
      jobs[index] = mutate(prevJob)
      doc.set({ version: 1, jobs })
      try {
        await doc.flush()
      } catch (err) {
        try {
          const latest = readDoc()
          const curIdx = latest.jobs.findIndex((j) => j.id === id && j.rev === rev)
          if (curIdx >= 0) {
            const rolledBack = [...latest.jobs]
            rolledBack[curIdx] = prevJob
            doc.set({ version: 1, jobs: rolledBack })
          }
        } catch {
          doc.set(current)
        }
        throw err
      }
      return true
    })

  return {
    readDoc,
    findJob: (id) => readDoc().jobs.find((j) => j.id === id),
    inUseItems: () =>
      parseCronDoc(doc.get())
        .jobs.filter((j) => j.enabled)
        .map((j) => ({ kind: 'cron_job', id: j.id, label: `cron job "${j.id}" (${j.schedule})` })),
    tryUpdateJob,

    async createJob(jobInput) {
      const nextRunAt = nextFireTime(jobInput.schedule, jobInput.timezone, clock.now())
      if (nextRunAt === undefined) {
        throw new HelmxError(
          'cron_no_next_time',
          `cron schedule has no future matching point in ${jobInput.timezone}; creation refused: ${jobInput.schedule}`,
          400,
          { id: jobInput.id, schedule: jobInput.schedule, timezone: jobInput.timezone },
        )
      }
      return withWriteLock(async () => {
        const current = readDoc()
        if (current.jobs.some((j) => j.id === jobInput.id)) {
          throw new HelmxError('cron_duplicate_id', `cron job already exists: ${jobInput.id}`, 409, { id: jobInput.id })
        }
        const created: CronJob = { ...jobInput, nextRunAt }
        doc.set({ version: 1, jobs: [...current.jobs, created] })
        try {
          await doc.flush()
        } catch (err) {
          doc.set(current)
          throw err
        }
        return created
      })
    },

    async updateJob(input, onBeforeFlush, onRollback) {
      return withWriteLock(async () => {
        const current = readDoc()
        const index = current.jobs.findIndex((j) => j.id === input.id)
        const prevJob = index >= 0 ? current.jobs[index] : undefined
        if (prevJob === undefined) {
          throw new HelmxError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
        }
        const updated = buildUpdatedCronJob(prevJob, input, clock.now())
        onBeforeFlush()
        const jobs = [...current.jobs]
        jobs[index] = updated
        doc.set({ version: 1, jobs })
        try {
          await doc.flush()
        } catch (err) {
          try {
            const latest = readDoc()
            const curIdx = latest.jobs.findIndex((j) => j.id === input.id && j.rev === updated.rev)
            if (curIdx >= 0) {
              const rolledBack = [...latest.jobs]
              rolledBack[curIdx] = prevJob
              doc.set({ version: 1, jobs: rolledBack })
            }
          } catch {
            doc.set(current)
          }
          onRollback(prevJob)
          throw err
        }
        return updated
      })
    },

    async deleteJob(id, onBeforeFlush, onRollback) {
      await withWriteLock(async () => {
        const current = readDoc()
        const deletedJob = current.jobs.find((j) => j.id === id)
        if (!deletedJob) {
          throw new HelmxError('not_found', `cron job does not exist: ${id}`, 404, { id })
        }
        onBeforeFlush()
        doc.set({ version: 1, jobs: current.jobs.filter((j) => j.id !== id) })
        try {
          await doc.flush()
        } catch (err) {
          try {
            const latest = readDoc()
            if (!latest.jobs.some((j) => j.id === id)) {
              doc.set({ version: 1, jobs: [...latest.jobs, deletedJob] })
            }
          } catch {
            doc.set(current)
          }
          onRollback(deletedJob)
          throw err
        }
      })
    },

    async reconcileOnStart() {
      const current = readDoc()
      for (const job of current.jobs) {
        assertValidSchedule(job.schedule, job.timezone)
        if (job.enabled && job.nextRunAt === undefined) {
          failCorrupt(`enabled cron job ${job.id} is missing nextRunAt`, { id: job.id })
        }
      }
      const now = clock.now()
      for (const job of current.jobs) {
        if (job.enabled && !job.catchUp && job.nextRunAt !== undefined && job.nextRunAt < now) {
          const nextRunAt = nextFireTime(job.schedule, job.timezone, now)
          if (nextRunAt === undefined) {
            throw new HelmxError('cron_no_next_time', `cron job ${job.id} has no future matching point`, 500, { id: job.id })
          }
          await tryUpdateJob(job.id, job.rev, (value) => ({ ...value, nextRunAt }))
        }
      }
    },

    async drainWrites() {
      while (locked) {
        await new Promise<void>((resolve) => {
          drainWaiters.push(resolve)
        })
      }
    },
  }
}
