/**
 * Shared durable cron/timer scheduler for built-in plugins (`builtin:memory`, `builtin:triggers`).
 * Handles `MAX_TIMEOUT_MS` chunking, injectable clock, claim-advance-flush before execution,
 * single catch-up after downtime, claim-failure backoff, and clean `stop()` convergence.
 */
import { CronExpressionParser } from 'cron-parser'

/** Node.js setTimeout cap (2^31-1 ms ~= 24.8 days). */
export const MAX_TIMEOUT_MS = 2_147_483_647

export interface TimerHandle { clear(): void }
export interface SchedulerClock { now(): number; setTimeout(fn: () => void, ms: number): TimerHandle }

export function defaultSchedulerClock(): SchedulerClock {
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return { clear: () => clearTimeout(timer) }
    },
  }
}

export function parseNextCronTime(expr: string, timezone: string, afterMs: number): number | undefined {
  const iter = CronExpressionParser.parse(expr, { currentDate: new Date(afterMs), tz: timezone })
  return iter.hasNext() ? iter.next().getTime() : undefined
}

export function advanceCronAfterFire(expr: string, timezone: string, fireAt: number, now: number): number | undefined {
  const next = parseNextCronTime(expr, timezone, fireAt)
  return next === undefined || next > now ? next : parseNextCronTime(expr, timezone, now)
}

export function armChunkedTimer(clock: SchedulerClock, targetAt: number, onDue: () => void): TimerHandle {
  let cleared = false
  let handle: TimerHandle | undefined
  const arm = (): void => {
    const delay = Math.max(0, targetAt - clock.now())
    handle = clock.setTimeout(() => {
      handle = undefined
      if (cleared) return
      if (delay > MAX_TIMEOUT_MS && clock.now() < targetAt) arm()
      else onDue()
    }, Math.min(delay, MAX_TIMEOUT_MS))
  }
  arm()
  return { clear() { cleared = true; handle?.clear(); handle = undefined } }
}

export interface DurableSchedulerOptions {
  clock?: SchedulerClock
  retryFloorMs?: number
  claimErrorTitle: string
  runErrorTitle: string
  readState(): { enabled: boolean; nextRunAt?: number }
  computeNext(afterMs: number): number
  persistNextRunAt(nextRunAt: number): Promise<void>
  claimNext(nextRunAt: number): Promise<boolean>
  run(): Promise<void>
  onError(title: string, err: unknown): void
}

export interface DurableScheduler {
  readonly clock: SchedulerClock
  start(): Promise<void>
  beginStop(): void
  stop(): Promise<void>
  reschedule(atOverride?: number): void
  isRunning(): boolean
  isStopping(): boolean
  settle(): Promise<void>
}

export function createDurableScheduler(options: DurableSchedulerOptions): DurableScheduler {
  const clock = options.clock ?? defaultSchedulerClock()
  const retryFloorMs = options.retryFloorMs ?? 5 * 60_000
  let stopping = false
  let timer: TimerHandle | undefined
  let activeRun: Promise<void> | undefined
  let pendingReschedule = false

  const clearTimer = (): void => { timer?.clear(); timer = undefined }
  const reschedule = (atOverride?: number): void => {
    clearTimer()
    pendingReschedule = false
    if (stopping) return
    const { enabled, nextRunAt } = options.readState()
    if (enabled) timer = armChunkedTimer(clock, atOverride ?? nextRunAt ?? options.computeNext(clock.now()), launch)
  }

  const execute = async (): Promise<void> => {
    if (stopping) return
    let claimed = false
    try {
      try { claimed = await options.claimNext(options.computeNext(clock.now())) } catch (err) {
        options.onError(options.claimErrorTitle, err)
        reschedule(clock.now() + retryFloorMs)
        return
      }
      if (claimed && !stopping) await options.run()
    } finally {
      if (claimed) reschedule()
    }
  }

  const launch = (): void => {
    timer = undefined
    if (stopping) return
    if (activeRun !== undefined) {
      pendingReschedule = true
      return
    }
    const guarded = execute().catch((err) => {
      try { options.onError(options.runErrorTitle, err) } catch { /* never throw into timer */ }
    })
    activeRun = guarded
    void guarded.finally(() => {
      if (activeRun === guarded) activeRun = undefined
      if (pendingReschedule && !stopping) {
        pendingReschedule = false
        reschedule()
      }
    })
  }

  const beginStop = (): void => { stopping = true; pendingReschedule = false; clearTimer() }

  return {
    clock,
    async start() {
      stopping = false
      pendingReschedule = false
      const { enabled, nextRunAt } = options.readState()
      if (enabled) {
        const now = clock.now()
        if (nextRunAt === undefined) await options.persistNextRunAt(options.computeNext(now))
        else if (nextRunAt <= now) await options.persistNextRunAt(now + 1)
      }
      reschedule()
    },
    beginStop,
    async stop() { beginStop(); if (activeRun !== undefined) await Promise.allSettled([activeRun]) },
    reschedule,
    isRunning: () => activeRun !== undefined,
    isStopping: () => stopping,
    async settle() { if (activeRun !== undefined) await Promise.allSettled([activeRun]) },
  }
}
