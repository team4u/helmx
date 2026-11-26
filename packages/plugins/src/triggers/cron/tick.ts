/**
 * cron 单次 tick：纯决策（`decideTick`：fire / skip-to-future / noop）、投递信封构造，
 * 以及 `createJobTick` 的完整执行序列——持久 claim 先于 dispatch、单次 catch-up、
 * 在途运行重叠跳过、决策失败按最短间隔退避重排。
 */
import {
  HelmxError,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type HelmxPluginContext,
} from '@helmx/protocol'
import { errorMessageOf } from '../../shared-helpers.js'
import type { TriggerDeliveryTarget } from '../delivery.js'
import { DECISION_RETRY_FLOOR_MS, type CronClock, type CronDeps, type CronJob } from './contracts.js'
import { advanceAfterFire, nextFireTime } from './parse.js'
import type { CronStore } from './store.js'

export type TickDecision =
  | { action: 'fire'; at: number }
  | { action: 'skip-to-future'; from: number; to: number }
  | { action: 'noop' }

export function decideTick(job: CronJob, now: number): TickDecision {
  if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) return { action: 'noop' }
  const next = job.nextRunAt
  const subsequent = nextFireTime(job.schedule, job.timezone, next)
  if (subsequent === undefined || subsequent > now || job.catchUp) return { action: 'fire', at: next }
  const future = nextFireTime(job.schedule, job.timezone, now)
  if (future === undefined || future <= now) {
    throw new HelmxError(
      'cron_schedule_stalled',
      `cron job ${job.id} cannot jump to a future point (schedule=${job.schedule} tz=${job.timezone})`,
      500,
      { id: job.id, schedule: job.schedule, timezone: job.timezone },
    )
  }
  return { action: 'skip-to-future', from: next, to: future }
}

export function buildCronEnvelope(job: CronJob, fireAt: number): ExternalTriggerEnvelope {
  return {
    id: `cron:${job.id}:${fireAt}`,
    source: `cron:${job.id}`,
    text: job.text,
    whenBusy: 'followUp',
    createdAt: fireAt,
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId } : {}),
  }
}

function clearRunDiagnostics(job: CronJob): CronJob {
  const { lastError: _e, lastSkippedAt: _sa, lastSkipReason: _sr, ...rest } = job
  void _e
  void _sa
  void _sr
  return rest as CronJob
}

/** 单次 tick 依赖的调度器句柄（与 `createCronScheduler` 共享 timer 表、停止标志与错误上报）。 */
export interface CronTickRuntime {
  ctx: HelmxPluginContext
  store: CronStore
  deps: CronDeps
  clock: CronClock
  isStopping: () => boolean
  targetForJob: (job: CronJob) => TriggerDeliveryTarget
  scheduleJob: (id: string, notBefore?: number) => void
  emitError: (title: string, detail: unknown) => void
  log: (message: string) => void
}

export function createJobTick(rt: CronTickRuntime): (id: string) => Promise<void> {
  const { ctx, store, deps, clock, isStopping, targetForJob, scheduleJob, emitError, log } = rt

  return async function runJobTick(id: string): Promise<void> {
    if (isStopping()) return
    let rescheduledByBackoff = false
    let tickRev: string | undefined
    const backoffOnFailure = (title: string, err: unknown): void => {
      emitError(title, err)
      if (tickRev !== undefined) {
        try {
          const latest = store.findJob(id)
          if (latest !== undefined && latest.rev !== tickRev) {
            rescheduledByBackoff = true
            return
          }
        } catch {
          // Corrupt doc falls through to scheduleJob error reporting.
        }
      }
      rescheduledByBackoff = true
      scheduleJob(id, clock.now() + DECISION_RETRY_FLOOR_MS)
    }

    try {
      let job: CronJob | undefined
      let decision: TickDecision
      try {
        job = store.findJob(id)
        if (!job) return
        tickRev = job.rev
        decision = decideTick(job, clock.now())
      } catch (err) {
        backoffOnFailure(`cron job ${id} scheduling decision failed`, err)
        return
      }
      if (decision.action === 'noop') return
      if (decision.action === 'skip-to-future') {
        try {
          await store.tryUpdateJob(id, job.rev, (j) => ({ ...j, nextRunAt: decision.to }))
        } catch (err) {
          backoffOnFailure(`cron job ${id} skip-to-future persistence failed`, err)
        }
        return
      }

      const fireAt = decision.at
      if (job.targetConversationId === undefined && deps.findActiveRun !== undefined) {
        let activeRun: ConversationSummary | undefined
        try {
          activeRun = deps.findActiveRun(job.id)
        } catch (err) {
          backoffOnFailure(`cron job ${id} active-run check failed`, err)
          return
        }
        if (activeRun !== undefined) {
          const reason = `previous run #${activeRun.id} is still ${activeRun.status}`
          try {
            await store.tryUpdateJob(id, job.rev, (j) => ({
              ...j,
              nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
              lastSkippedAt: fireAt,
              lastSkipReason: reason,
            }))
          } catch (err) {
            backoffOnFailure(`cron job ${id} overlap skip persistence failed`, err)
          }
          return
        }
      }

      let claimed: boolean
      try {
        claimed = await store.tryUpdateJob(id, job.rev, (j) =>
          clearRunDiagnostics({
            ...j,
            lastRunAt: fireAt,
            nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
          }),
        )
      } catch (err) {
        backoffOnFailure(`cron job ${id} claim persistence failed; not delivering this time`, err)
        return
      }
      if (!claimed || isStopping()) return
      const currentJob = store.readDoc().jobs.find((current) => current.id === id && current.rev === job.rev && current.enabled)
      if (!currentJob) return

      try {
        await deps.dispatchTrigger(buildCronEnvelope(currentJob, fireAt), targetForJob(currentJob))
      } catch (err) {
        const safeMessage = ctx.host.redact(errorMessageOf(err))
        try {
          const written = await store.tryUpdateJob(id, job.rev, (j) => ({
            ...j,
            lastError: `delivery failed @${new Date(fireAt).toISOString()}: ${safeMessage}`,
          }))
          if (!written) log(`cron job ${id} delivery failed, but generation changed; lastError not written back`)
        } catch (writeErr) {
          log(`cron job ${id} lastError flush also failed: ${errorMessageOf(writeErr)}`)
        }
        emitError(`cron job ${id} delivery failed`, err)
      }
    } finally {
      if (!rescheduledByBackoff) scheduleJob(id)
    }
  }
}
