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

/** 单次 tick 各阶段共享的执行上下文：调度器句柄、job id 与失败退避状态（退避写入，finally 读取）。 */
interface TickContext {
  rt: CronTickRuntime
  id: string
  /** 读到 job 时的 rev；失败退避据此判断 job 是否已被别的 tick 重排。 */
  tickRev: string | undefined
  /** 失败退避已自行处理重排（或确认他人已重排）时置位，finally 据此跳过默认重排。 */
  rescheduledByBackoff: boolean
}

type TickPlan = { job: CronJob; decision: TickDecision }

export function createJobTick(rt: CronTickRuntime): (id: string) => Promise<void> {
  const { isStopping, scheduleJob } = rt

  return async function runJobTick(id: string): Promise<void> {
    if (isStopping()) return
    const tick: TickContext = { rt, id, tickRev: undefined, rescheduledByBackoff: false }
    try {
      const plan = loadTickPlan(tick)
      if (plan === undefined || plan.decision.action === 'noop') return
      if (plan.decision.action === 'skip-to-future') {
        await skipToFuture(tick, plan.job, plan.decision.to)
        return
      }
      const fireAt = plan.decision.at
      if (await skipIfOverlapping(tick, plan.job, fireAt)) return
      const claimed = await claimForFire(tick, plan.job, fireAt)
      if (claimed === undefined) return
      await dispatchClaimed(tick, plan.job, claimed, fireAt)
    } finally {
      if (!tick.rescheduledByBackoff) scheduleJob(id)
    }
  }
}

/** 读取 job 并做调度决策；job 已不存在或决策失败（已退避）时返回 undefined，本 tick 到此结束。 */
function loadTickPlan(tick: TickContext): TickPlan | undefined {
  const { store, clock } = tick.rt
  try {
    const job = store.findJob(tick.id)
    if (!job) return undefined
    tick.tickRev = job.rev
    return { job, decision: decideTick(job, clock.now()) }
  } catch (err) {
    backoffOnFailure(tick, `cron job ${tick.id} scheduling decision failed`, err)
    return undefined
  }
}

/** 决策为 skip-to-future：把 nextRunAt 推到未来时点；落盘失败按最短间隔退避重排。 */
async function skipToFuture(tick: TickContext, job: CronJob, to: number): Promise<void> {
  try {
    await tick.rt.store.tryUpdateJob(tick.id, job.rev, (j) => ({ ...j, nextRunAt: to }))
  } catch (err) {
    backoffOnFailure(tick, `cron job ${tick.id} skip-to-future persistence failed`, err)
  }
}

/**
 * 无显式目标会话的 job：上一次运行仍在途（working / blocked）则跳过本计划点——写入
 * lastSkippedAt / lastSkipReason 并推进 nextRunAt。返回 true 表示本 tick 已处理完毕（含检查失败已退避）。
 */
async function skipIfOverlapping(tick: TickContext, job: CronJob, fireAt: number): Promise<boolean> {
  const { deps, store, clock } = tick.rt
  if (job.targetConversationId !== undefined || deps.findActiveRun === undefined) return false
  let activeRun: ConversationSummary | undefined
  try {
    activeRun = deps.findActiveRun(job.id)
  } catch (err) {
    backoffOnFailure(tick, `cron job ${tick.id} active-run check failed`, err)
    return true
  }
  if (activeRun === undefined) return false
  const reason = `previous run #${activeRun.id} is still ${activeRun.status}`
  try {
    await store.tryUpdateJob(tick.id, job.rev, (j) => ({
      ...j,
      nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
      lastSkippedAt: fireAt,
      lastSkipReason: reason,
    }))
  } catch (err) {
    backoffOnFailure(tick, `cron job ${tick.id} overlap skip persistence failed`, err)
  }
  return true
}

/**
 * 持久 claim：写入 lastRunAt、推进 nextRunAt 并清掉上一轮诊断，claim 成功才允许投递。
 * 未抢到（并发 tick 已处理）、调度器已停止或 job 代次已变 / 已停用时返回 undefined。
 */
async function claimForFire(tick: TickContext, job: CronJob, fireAt: number): Promise<CronJob | undefined> {
  const { store, clock, isStopping } = tick.rt
  let claimed: boolean
  try {
    claimed = await store.tryUpdateJob(tick.id, job.rev, (j) =>
      clearRunDiagnostics({
        ...j,
        lastRunAt: fireAt,
        nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
      }),
    )
  } catch (err) {
    backoffOnFailure(tick, `cron job ${tick.id} claim persistence failed; not delivering this time`, err)
    return undefined
  }
  if (!claimed || isStopping()) return undefined
  return store.readDoc().jobs.find((current) => current.id === tick.id && current.rev === job.rev && current.enabled)
}

/** 投递触发信封；失败只把脱敏后的错误写回 lastError 并上报，本计划点不重试。 */
async function dispatchClaimed(tick: TickContext, job: CronJob, currentJob: CronJob, fireAt: number): Promise<void> {
  const { deps, targetForJob, emitError } = tick.rt
  try {
    await deps.dispatchTrigger(buildCronEnvelope(currentJob, fireAt), targetForJob(currentJob))
  } catch (err) {
    await recordDeliveryFailure(tick, job, fireAt, err)
    emitError(`cron job ${tick.id} delivery failed`, err)
  }
}

/** 投递失败写回 lastError（经 redact 脱敏）；写回自身失败只记日志，不掩盖原始投递错误。 */
async function recordDeliveryFailure(tick: TickContext, job: CronJob, fireAt: number, err: unknown): Promise<void> {
  const { ctx, store, log } = tick.rt
  const safeMessage = ctx.host.redact(errorMessageOf(err))
  try {
    const written = await store.tryUpdateJob(tick.id, job.rev, (j) => ({
      ...j,
      lastError: `delivery failed @${new Date(fireAt).toISOString()}: ${safeMessage}`,
    }))
    if (!written) log(`cron job ${tick.id} delivery failed, but generation changed; lastError not written back`)
  } catch (writeErr) {
    log(`cron job ${tick.id} lastError flush also failed: ${errorMessageOf(writeErr)}`)
  }
}

/**
 * 决策 / 持久化失败：先上报，再按最短间隔退避重排；若 job 已被别的 tick 重排（rev 变化）
 * 则不重复排。两条出口都置 rescheduledByBackoff，finally 据此跳过默认重排。
 */
function backoffOnFailure(tick: TickContext, title: string, err: unknown): void {
  const { clock, emitError, scheduleJob } = tick.rt
  emitError(title, err)
  tick.rescheduledByBackoff = true
  if (alreadyRescheduledByAnotherTick(tick)) return
  scheduleJob(tick.id, clock.now() + DECISION_RETRY_FLOOR_MS)
}

/** job 的 rev 已不同于本 tick 读到的值，说明别的 tick 已接手重排；doc 损坏时视为未接手（交给 scheduleJob 报错）。 */
function alreadyRescheduledByAnotherTick(tick: TickContext): boolean {
  if (tick.tickRev === undefined) return false
  try {
    const latest = tick.rt.store.findJob(tick.id)
    return latest !== undefined && latest.rev !== tick.tickRev
  } catch {
    // Corrupt doc falls through to scheduleJob error reporting.
    return false
  }
}
