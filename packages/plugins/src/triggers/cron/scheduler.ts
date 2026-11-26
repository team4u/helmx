/**
 * cron 调度器：持有 timer 表与在途 tick 表（single-flight），把持久化 job 重排为
 * 24.8 天分片定时器，并以 `ctx.service` 暴露启动对账、停止排空与在用项。
 * 单次 tick 的决策与执行见 `./tick.ts`，动作声明见 `./actions.ts`。
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import { reportPluginError } from '../../shared-helpers.js'
import { armChunkedTimer, defaultSchedulerClock, type TimerHandle } from '../../durable-scheduler.js'
import { buildTriggerDeliveryTarget, type TriggerDeliveryTarget } from '../delivery.js'
import { registerCronActions } from './actions.js'
import type { CronClock, CronDeps, CronJob, CronRuntime } from './contracts.js'
import { createCronStore } from './store.js'
import { createJobTick } from './tick.js'

export function registerCron(ctx: HelmxPluginContext, deps: CronDeps): CronRuntime {
  return createCronScheduler(ctx, deps, defaultSchedulerClock())
}

export function createCronScheduler(ctx: HelmxPluginContext, deps: CronDeps, clock: CronClock): CronRuntime {
  const store = createCronStore(ctx, clock)
  let stopping = false
  const inflight = new Map<string, Promise<void>>()
  const timers = new Map<string, TimerHandle>()

  const log = (message: string): void => {
    console.error(`[cron] ${ctx.host.redact(message)}`)
  }
  const emitError = (title: string, detail: unknown): void => {
    reportPluginError(ctx.host, { logTag: 'cron', title, detail, bodyPrefix: '[cron]' })
  }
  const isStopping = (): boolean => stopping
  const clearJobTimer = (id: string): void => {
    timers.get(id)?.clear()
    timers.delete(id)
  }
  const targetForJob = (job: CronJob): TriggerDeliveryTarget =>
    buildTriggerDeliveryTarget({
      triggerKind: 'cron',
      id: job.id,
      description: job.description,
      timezone: job.timezone,
      targetConversationId: job.targetConversationId,
      mode: job.mode,
      profileId: job.profileId,
      keepLast: job.keepLast,
      dedicatedConversationId: job.dedicatedConversationId,
      onDedicatedConversationId: async (conversationId) => {
        await store.tryUpdateJob(job.id, job.rev, (j) => ({ ...j, dedicatedConversationId: conversationId }))
      },
    })

  const scheduleJob = (id: string, notBefore?: number): void => {
    if (stopping) return
    clearJobTimer(id)
    let job: CronJob | undefined
    try {
      job = store.findJob(id)
    } catch (err) {
      emitError(`cron job ${id} failed to read scheduling state`, err)
      return
    }
    if (!job || !job.enabled) return
    if (job.nextRunAt === undefined) {
      emitError(
        `cron job ${id} has no next time`,
        new HelmxError('cron_no_next_time', `schedule=${job.schedule} has no future matching point in ${job.timezone}`, 500, {
          id,
          schedule: job.schedule,
        }),
      )
      return
    }
    const targetAt = notBefore === undefined ? job.nextRunAt : Math.max(job.nextRunAt, notBefore)
    timers.set(
      id,
      armChunkedTimer(clock, targetAt, () => {
        timers.delete(id)
        void tickJob(id).catch((err) => emitError(`cron job ${id} tick exception`, err))
      }),
    )
  }

  const runJobTick = createJobTick({ ctx, store, deps, clock, isStopping, targetForJob, scheduleJob, emitError, log })

  const tickJob = (id: string): Promise<void> => {
    const existing = inflight.get(id)
    if (existing) return existing
    const task = runJobTick(id).finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  registerCronActions(ctx, { store, deps, clock, targetForJob, scheduleJob, clearJobTimer })

  ctx.service({
    id: 'cron-scheduler',
    liveTasks: () => [...inflight.keys()].map((id) => `cron-dispatch:${id}`),
    inUse: () => store.inUseItems(),
    async start() {
      stopping = false
      try {
        await store.reconcileOnStart()
        for (const job of store.readDoc().jobs) scheduleJob(job.id)
      } catch (err) {
        emitError('cron scheduling failed to start', err)
        throw err
      }
    },
    async stop() {
      stopping = true
      for (const handle of timers.values()) handle.clear()
      timers.clear()
      if (inflight.size > 0) await Promise.allSettled([...inflight.values()])
      await store.drainWrites()
    },
  })

  return {
    async tickNow() {
      const current = store.readDoc()
      await Promise.all(current.jobs.filter((j) => j.enabled).map((j) => tickJob(j.id)))
    },
    async settle() {
      for (let i = 0; i < 100 && inflight.size > 0; i++) {
        await Promise.allSettled([...inflight.values()])
        await new Promise((resolve) => setImmediate(resolve))
      }
      await store.drainWrites()
    },
    getJob: (id: string) => store.findJob(id),
  }
}
