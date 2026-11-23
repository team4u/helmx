/**
 * builtin:triggers -- the cron scheduling module.
 *
 * Uses `durable-scheduler.ts` primitives (`SchedulerClock`, `TimerHandle`, `defaultSchedulerClock`,
 * `parseNextCronTime`, `advanceCronAfterFire`, `armChunkedTimer`) for cron parsing, 24.8-day
 * chunked timer arming, and injectable clocks while managing multi-job state in the public `crons`
 * doc with `(id, rev)` generation guards, claim-flush-before-dispatch, single catch-up, overlap
 * skipping for in-flight automated runs, and decision-failure retry backoff.
 */

import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type HelmxPluginContext,
} from '@helmx/protocol'
import {
  advanceCronAfterFire,
  armChunkedTimer,
  defaultSchedulerClock,
  parseNextCronTime,
  type SchedulerClock,
  type TimerHandle,
} from '../durable-scheduler.js'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  MAX_TRIGGER_KEEP_LAST,
  normalizeTriggerTargetInput,
  type ProfileLookup,
  type TriggerSessionMode,
} from './contracts.js'
import type { TriggerDeliveryTarget, TriggerDispatchResult } from './delivery.js'

const CRON_DOC_NAME = 'crons'
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DECISION_RETRY_FLOOR_MS = 60_000

export type CronClock = SchedulerClock

export interface CronJob {
  id: string
  /** Creation generation (randomUUID) checked on claim/lastError write-backs against (id, rev). */
  rev: string
  description?: string
  /** Standard five-field cron expression (min hour day month weekday). */
  schedule: string
  /** IANA timezone, default 'UTC'. */
  timezone: string
  /** Text payload delivered at trigger time. */
  text: string
  enabled: boolean
  /** true: catch up missed intervals once after restart; false: jump to a future point. */
  catchUp: boolean
  /** Explicit existing conversation target (mutually exclusive with mode/profileId/keepLast/dedicatedConversationId). */
  targetConversationId?: number
  /** Automated session mode when targetConversationId is unset ('isolated' | 'dedicated'). */
  mode?: TriggerSessionMode
  /** Target Profile ID for automated sessions (defaults to 'assistant'). */
  profileId?: string
  /** Retention cap of settled isolated runs (only when mode === 'isolated'). */
  keepLast?: number
  /** Persisted dedicated conversation ID (only when mode === 'dedicated'). */
  dedicatedConversationId?: number
  lastRunAt?: number
  nextRunAt?: number
  lastError?: string
  /** Epoch ms of the latest scheduled tick skipped due to an overlapping in-flight run. */
  lastSkippedAt?: number
  lastSkipReason?: string
}

export interface CronDoc {
  version: 1
  jobs: CronJob[]
}

export interface CronDeps {
  dispatchTrigger(
    event: ExternalTriggerEnvelope,
    target: TriggerDeliveryTarget,
  ): Promise<TriggerDispatchResult>
  findActiveRun?(jobId: string): ConversationSummary | undefined
  profiles?: ProfileLookup
}

export interface CronRuntime {
  tickNow(): Promise<void>
  settle(): Promise<void>
  getJob(id: string): CronJob | undefined
}

// ---------------------------------------------------------------------------
// Validation, time computation & doc parsing
// ---------------------------------------------------------------------------

function failValidation(message: string, field: string, extra?: Record<string, unknown>): never {
  throw new HelmxError('validation_error', message, 400, { field, ...extra })
}

function failCorrupt(message: string, details?: Record<string, unknown>): never {
  throw new HelmxError('cron_doc_corrupt', `crons doc corrupted: ${message}`, 500, details)
}

/** Validate a five-field cron expression and IANA timezone. */
export function assertValidSchedule(schedule: string, timezone: string): void {
  if (typeof schedule !== 'string' || schedule.trim().length === 0) {
    failValidation('cron schedule must not be empty (standard five fields: min hour day month weekday)', 'schedule')
  }
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    failValidation(
      `cron schedule must be standard five fields (min hour day month weekday); got ${fields.length}: ${schedule}`,
      'schedule',
      { schedule },
    )
  }
  if (typeof timezone !== 'string' || timezone.length === 0) {
    failValidation('cron timezone must not be empty (an IANA zone name; defaults to UTC)', 'timezone')
  }
  try {
    // Evaluate `.next()` directly because cron-parser defers invalid-timezone errors until iteration.
    CronExpressionParser.parse(schedule, { tz: timezone }).next()
  } catch (err) {
    failValidation(`invalid cron schedule: ${err instanceof Error ? err.message : String(err)}`, 'schedule', {
      schedule,
      timezone,
    })
  }
}

/** Compute the next planned time strictly after `afterMs`; undefined when no future point exists. */
export function nextFireTime(schedule: string, timezone: string, afterMs: number): number | undefined {
  try {
    return parseNextCronTime(schedule, timezone, afterMs)
  } catch (err) {
    throw new HelmxError(
      'cron_next_time_unavailable',
      `failed to compute the next cron time (schedule=${schedule} tz=${timezone}): ${err instanceof Error ? err.message : String(err)}`,
      500,
      { schedule, timezone, afterMs },
    )
  }
}

/** Compute the next planned point after a fire, jumping past downtime instead of replaying interval by interval. */
export function advanceAfterFire(schedule: string, timezone: string, fireAt: number, now: number): number | undefined {
  try {
    return advanceCronAfterFire(schedule, timezone, fireAt, now)
  } catch (err) {
    throw new HelmxError(
      'cron_next_time_unavailable',
      `failed to compute the next cron time (schedule=${schedule} tz=${timezone}): ${err instanceof Error ? err.message : String(err)}`,
      500,
      { schedule, timezone, afterMs: fireAt },
    )
  }
}

/** Normalize creation input into a CronJob (pure; no doc writes or time computation). */
export function normalizeCronInput(input: {
  id: string
  schedule: string
  text: string
  description?: string
  timezone?: string
  enabled?: boolean
  catchUp?: boolean
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
}): CronJob {
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    failValidation(`invalid cron id (1..64 chars, alphanumeric _ - allowed, dots forbidden): ${String(input.id)}`, 'id')
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    failValidation('cron text must not be empty (the payload text delivered at trigger time)', 'text')
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
    failValidation('cron description must be a string of at most 500 chars', 'description')
  }
  const timezone = input.timezone ?? 'UTC'
  assertValidSchedule(input.schedule, timezone)

  const target = normalizeTriggerTargetInput({
    targetConversationId: input.targetConversationId,
    mode: input.mode,
    profileId: input.profileId,
    keepLast: input.keepLast,
  })
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    failValidation('enabled must be a boolean', 'enabled')
  }
  if (input.catchUp !== undefined && typeof input.catchUp !== 'boolean') {
    failValidation('catchUp must be a boolean', 'catchUp')
  }

  return {
    id: input.id,
    rev: randomUUID(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    schedule: input.schedule.trim(),
    timezone,
    text: input.text,
    enabled: input.enabled ?? true,
    catchUp: input.catchUp ?? false,
    ...(target.targetConversationId !== undefined ? { targetConversationId: target.targetConversationId } : {}),
    ...(target.mode !== undefined ? { mode: target.mode } : {}),
    ...(target.profileId !== undefined ? { profileId: target.profileId } : {}),
    ...(target.keepLast !== undefined ? { keepLast: target.keepLast } : {}),
  }
}

/** Strictly validate the persisted `crons` doc; corrupted data throws `cron_doc_corrupt`. */
export function parseCronDoc(raw: unknown): CronDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failCorrupt('the root must be an object', { actual: String(raw) })
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) failCorrupt(`invalid version: ${String(doc.version)} (expected 1)`, { version: doc.version })
  if (!Array.isArray(doc.jobs)) failCorrupt('jobs must be an array', { actual: typeof doc.jobs })
  const seen = new Set<string>()
  return { version: 1, jobs: doc.jobs.map((rawJob, index) => parseCronJob(rawJob, index, seen)) }
}

function parseCronJob(rawJob: unknown, index: number, seen: Set<string>): CronJob {
  const where = `jobs[${index}]`
  if (rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    failCorrupt(`${where} must be an object`, { index })
  }
  const job = rawJob as Record<string, unknown>
  if (typeof job.id !== 'string' || !ID_PATTERN.test(job.id)) {
    failCorrupt(`invalid ${where}.id: ${String(job.id)}`, { index })
  }
  const id = job.id
  if (typeof job.rev !== 'string' || job.rev.length === 0) {
    failCorrupt(`${where} (${id}) is missing the creation generation rev`, { index, id })
  }
  if (seen.has(id)) failCorrupt(`duplicate ${where}.id: ${id}`, { index })
  seen.add(id)
  if (typeof job.schedule !== 'string' || typeof job.text !== 'string') {
    failCorrupt(`${where} (${id}) is missing schedule/text`, { index, id })
  }
  if (typeof job.timezone !== 'string' || job.timezone.length === 0) {
    failCorrupt(`${where} (${id}) has an invalid timezone`, { index, id })
  }
  if (typeof job.enabled !== 'boolean' || typeof job.catchUp !== 'boolean') {
    failCorrupt(`${where} (${id}) enabled/catchUp must be booleans`, { index, id })
  }
  if ('targetProfileId' in job) {
    failCorrupt(`${where} (${id}) uses removed targetProfileId field (use mode + profileId)`, { index, id })
  }
  for (const field of ['description', 'profileId', 'lastError', 'lastSkipReason'] as const) {
    if (job[field] !== undefined && typeof job[field] !== 'string') {
      failCorrupt(`${where} (${id}) has an invalid ${field} type`, { index, id, field })
    }
  }
  if (typeof job.profileId === 'string' && (job.profileId.length === 0 || job.profileId.length > 64 || /\s|[/\\]/.test(job.profileId))) {
    failCorrupt(`${where} (${id}) has an invalid profileId`, { index, id })
  }
  if (job.mode !== undefined && job.mode !== 'isolated' && job.mode !== 'dedicated') {
    failCorrupt(`${where} (${id}) mode must be 'isolated' or 'dedicated'`, { index, id })
  }
  if (
    job.targetConversationId !== undefined &&
    (!Number.isInteger(job.targetConversationId) || (job.targetConversationId as number) <= 0)
  ) {
    failCorrupt(`${where} (${id}) has an invalid targetConversationId`, { index, id })
  }
  if (
    job.keepLast !== undefined &&
    (!Number.isInteger(job.keepLast) || (job.keepLast as number) < 1 || (job.keepLast as number) > MAX_TRIGGER_KEEP_LAST)
  ) {
    failCorrupt(`${where} (${id}) keepLast must be an integer 1..${MAX_TRIGGER_KEEP_LAST}`, { index, id })
  }
  if (
    job.dedicatedConversationId !== undefined &&
    (!Number.isInteger(job.dedicatedConversationId) || (job.dedicatedConversationId as number) <= 0)
  ) {
    failCorrupt(`${where} (${id}) has an invalid dedicatedConversationId`, { index, id })
  }
  if (job.targetConversationId !== undefined) {
    if (
      job.mode !== undefined ||
      job.profileId !== undefined ||
      job.keepLast !== undefined ||
      job.dedicatedConversationId !== undefined
    ) {
      failCorrupt(`${where} (${id}) targetConversationId is mutually exclusive with mode/profileId/keepLast/dedicatedConversationId`, {
        index,
        id,
      })
    }
  } else {
    if (job.mode !== 'isolated' && job.mode !== 'dedicated') {
      failCorrupt(`${where} (${id}) must declare mode ('isolated' | 'dedicated') when targetConversationId is unset`, {
        index,
        id,
      })
    }
    if (job.mode === 'isolated' && job.dedicatedConversationId !== undefined) {
      failCorrupt(`${where} (${id}) dedicatedConversationId is forbidden in isolated mode`, { index, id })
    }
    if (job.mode === 'dedicated' && job.keepLast !== undefined) {
      failCorrupt(`${where} (${id}) keepLast is forbidden in dedicated mode`, { index, id })
    }
  }
  for (const field of ['lastRunAt', 'nextRunAt', 'lastSkippedAt'] as const) {
    if (job[field] !== undefined && (typeof job[field] !== 'number' || !Number.isFinite(job[field]))) {
      failCorrupt(`${where} (${id}) ${field} must be finite numbers`, { index, id, field })
    }
  }
  return {
    id,
    rev: job.rev,
    ...(job.description !== undefined ? { description: job.description as string } : {}),
    schedule: job.schedule,
    timezone: job.timezone,
    text: job.text,
    enabled: job.enabled,
    catchUp: job.catchUp,
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId as number } : {}),
    ...(job.mode !== undefined ? { mode: job.mode as TriggerSessionMode } : {}),
    ...(job.profileId !== undefined ? { profileId: job.profileId as string } : {}),
    ...(job.keepLast !== undefined ? { keepLast: job.keepLast as number } : {}),
    ...(job.dedicatedConversationId !== undefined ? { dedicatedConversationId: job.dedicatedConversationId as number } : {}),
    ...(job.lastRunAt !== undefined ? { lastRunAt: job.lastRunAt as number } : {}),
    ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt as number } : {}),
    ...(job.lastError !== undefined ? { lastError: job.lastError as string } : {}),
    ...(job.lastSkippedAt !== undefined ? { lastSkippedAt: job.lastSkippedAt as number } : {}),
    ...(job.lastSkipReason !== undefined ? { lastSkipReason: job.lastSkipReason as string } : {}),
  }
}

// ---------------------------------------------------------------------------
// Scheduling decision & envelope construction
// ---------------------------------------------------------------------------

type TickDecision =
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

// ---------------------------------------------------------------------------
// Scheduler registration
// ---------------------------------------------------------------------------

export function registerCron(ctx: HelmxPluginContext, deps: CronDeps): CronRuntime {
  return createCronScheduler(ctx, deps, defaultSchedulerClock())
}

export function createCronScheduler(ctx: HelmxPluginContext, deps: CronDeps, clock: CronClock): CronRuntime {
  const doc = ctx.doc<CronDoc>(CRON_DOC_NAME, { version: 1, jobs: [] }, { public: true })
  let stopping = false
  let activeTickWrite: Promise<void> | undefined
  const inflight = new Map<string, Promise<void>>()
  const timers = new Map<string, TimerHandle>()

  const log = (message: string): void => console.error(`[cron] ${message}`)
  const emitError = (title: string, detail: unknown): void => {
    const message = detail instanceof Error ? detail.message : String(detail)
    try {
      ctx.host.emitEvent('notification', { type: 'notification', level: 'error', title, body: `[cron] ${message}` })
    } catch (eventErr) {
      log(`notification event publish failed: ${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
    }
    log(`${title}：${message}`)
  }

  const readDoc = (): CronDoc => parseCronDoc(doc.get())

  const tryUpdateJob = async (id: string, rev: string, mutate: (job: CronJob) => CronJob): Promise<boolean> => {
    while (activeTickWrite !== undefined) {
      await activeTickWrite
    }
    let releaseWrite!: () => void
    activeTickWrite = new Promise<void>((r) => {
      releaseWrite = r
    })
    try {
      const current = readDoc()
      const index = current.jobs.findIndex((j) => j.id === id)
      if (index < 0 || current.jobs[index]!.rev !== rev) return false
      const prevJob = current.jobs[index]!
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
    } finally {
      activeTickWrite = undefined
      releaseWrite()
    }
  }

  const buildTargetForJob = (job: CronJob): TriggerDeliveryTarget => {
    if (job.targetConversationId !== undefined) {
      return { kind: 'conversation', conversationId: job.targetConversationId }
    }
    if (job.mode === 'dedicated') {
      return {
        kind: 'dedicated',
        triggerKind: 'cron',
        triggerId: job.id,
        label: job.description,
        profileId: job.profileId,
        dedicatedConversationId: job.dedicatedConversationId,
        onDedicatedConversationId: async (conversationId) => {
          await tryUpdateJob(job.id, job.rev, (j) => ({ ...j, dedicatedConversationId: conversationId }))
        },
      }
    }
    return {
      kind: 'isolated',
      triggerKind: 'cron',
      triggerId: job.id,
      label: job.description,
      timezone: job.timezone,
      profileId: job.profileId,
      keepLast: job.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST,
    }
  }

  const runJobTick = async (id: string): Promise<void> => {
    if (stopping) return
    let rescheduledByBackoff = false
    const backoffOnFailure = (title: string, err: unknown): void => {
      emitError(title, err)
      rescheduledByBackoff = true
      scheduleJob(id, clock.now() + DECISION_RETRY_FLOOR_MS)
    }
    try {
      let job: CronJob | undefined
      let decision: TickDecision
      try {
        job = readDoc().jobs.find((j) => j.id === id)
        if (!job) return
        decision = decideTick(job, clock.now())
      } catch (err) {
        backoffOnFailure(`cron job ${id} scheduling decision failed`, err)
        return
      }
      if (decision.action === 'noop') return
      if (decision.action === 'skip-to-future') {
        try {
          await tryUpdateJob(id, job.rev, (j) => ({ ...j, nextRunAt: decision.to }))
        } catch (err) {
          backoffOnFailure(`cron job ${id} skip-to-future persistence failed`, err)
        }
        return
      }

      const fireAt = decision.at

      // Overlap protection for automated jobs: if a previous run is still working/blocked,
      // advance nextRunAt and record the skip rather than piling up concurrent runs.
      if (job.targetConversationId === undefined && deps.findActiveRun !== undefined) {
        const activeRun = deps.findActiveRun(job.id)
        if (activeRun !== undefined) {
          const reason = `previous run #${activeRun.id} is still ${activeRun.status}`
          try {
            await tryUpdateJob(id, job.rev, (j) => ({
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
        claimed = await tryUpdateJob(id, job.rev, (j) =>
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
      if (!claimed || stopping) return
      const currentJob = readDoc().jobs.find((current) => current.id === id && current.rev === job.rev && current.enabled)
      if (!currentJob) return

      try {
        await deps.dispatchTrigger(buildCronEnvelope(currentJob, fireAt), buildTargetForJob(currentJob))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        try {
          const written = await tryUpdateJob(id, job.rev, (j) => ({
            ...j,
            lastError: `delivery failed @${new Date(fireAt).toISOString()}: ${message}`,
          }))
          if (!written) log(`cron job ${id} delivery failed, but generation changed; lastError not written back`)
        } catch (writeErr) {
          log(`cron job ${id} lastError flush also failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`)
        }
        emitError(`cron job ${id} delivery failed`, err)
      }
    } finally {
      if (!rescheduledByBackoff) scheduleJob(id)
    }
  }

  const tickJob = (id: string): Promise<void> => {
    const existing = inflight.get(id)
    if (existing) return existing
    const task = runJobTick(id).finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  const scheduleJob = (id: string, notBefore?: number): void => {
    if (stopping) return
    timers.get(id)?.clear()
    timers.delete(id)
    let job: CronJob | undefined
    try {
      job = readDoc().jobs.find((j) => j.id === id)
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

  const idInputSchema = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
    required: ['id'],
    additionalProperties: false,
  } as const

  ctx.action({
    id: 'cron_list',
    description: 'List all cron jobs (incl. mode/lastRunAt/nextRunAt/lastError/lastSkippedAt scheduling state)',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { jobs: { type: 'array', items: { type: 'object' } } },
      required: ['jobs'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'list'] },
    handler: () => ({ jobs: readDoc().jobs.map((job) => structuredClone(job)) }),
  })

  ctx.action({
    id: 'cron_create',
    description:
      'Create a periodic cron job (5-field schedule, IANA timezone defaulting to UTC; defaults to isolated automated sessions with keepLast=10, or dedicated / explicit targetConversationId)',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        schedule: { type: 'string', description: 'Standard 5-field cron expression (min hour day month weekday, e.g. "*/30 * * * *")' },
        text: { type: 'string', minLength: 1, description: 'Self-contained task text delivered when triggered' },
        description: { type: 'string', maxLength: 500 },
        timezone: { type: 'string', description: 'IANA timezone name (e.g. Asia/Shanghai; defaults to UTC)' },
        enabled: { type: 'boolean' },
        catchUp: { type: 'boolean' },
        mode: {
          type: 'string',
          enum: ['isolated', 'dedicated'],
          description: 'Automated session mode when targetConversationId is omitted (isolated = fresh helmx conversation per run, default; dedicated = one persistent helmx conversation per job)',
        },
        profileId: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Target Profile ID for automated sessions (defaults to assistant; mutually exclusive with targetConversationId)',
        },
        keepLast: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TRIGGER_KEEP_LAST,
          description: `Number of settled isolated runs to retain automatically (1..${MAX_TRIGGER_KEEP_LAST}, default ${DEFAULT_TRIGGER_KEEP_LAST}; only valid in isolated mode)`,
        },
        targetConversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Explicit existing conversation ID to deliver into with followUp (mutually exclusive with mode/profileId/keepLast)',
        },
      },
      required: ['id', 'schedule', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { job: { type: 'object' } },
      required: ['job'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'create'] },
    handler: async (input: Record<string, unknown>) => {
      const job = normalizeCronInput(input as Parameters<typeof normalizeCronInput>[0])
      if (job.profileId !== undefined && deps.profiles !== undefined) {
        if ((await deps.profiles.get(job.profileId)) === undefined) {
          throw new HelmxError(
            'validation_error',
            `profileId does not exist: ${job.profileId} (refusing to schedule against the wrong role)`,
            400,
            { profileId: job.profileId },
          )
        }
      }
      const nextRunAt = nextFireTime(job.schedule, job.timezone, clock.now())
      if (nextRunAt === undefined) {
        throw new HelmxError(
          'cron_no_next_time',
          `cron schedule has no future matching point in ${job.timezone}; creation refused: ${job.schedule}`,
          400,
          { id: job.id, schedule: job.schedule, timezone: job.timezone },
        )
      }
      while (activeTickWrite !== undefined) {
        await activeTickWrite
      }
      let releaseCreate!: () => void
      activeTickWrite = new Promise<void>((r) => {
        releaseCreate = r
      })
      let created: CronJob
      try {
        const current = readDoc()
        if (current.jobs.some((j) => j.id === job.id)) {
          throw new HelmxError('cron_duplicate_id', `cron job already exists: ${job.id}`, 409, { id: job.id })
        }
        created = { ...job, nextRunAt }
        doc.set({ version: 1, jobs: [...current.jobs, created] })
        try {
          await doc.flush()
        } catch (err) {
          doc.set(current)
          throw err
        }
      } finally {
        activeTickWrite = undefined
        releaseCreate()
      }
      if (created.enabled) scheduleJob(created.id)
      return { job: structuredClone(created) }
    },
  })

  ctx.action({
    id: 'cron_delete',
    description: 'Delete a cron job (in-flight deliveries end naturally; nothing revives)',
    exposeToPrompt: false,
    inputSchema: idInputSchema,
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'delete'] },
    handler: async (input: { id: string }) => {
      const current = readDoc()
      const deletedJob = current.jobs.find((j) => j.id === input.id)
      if (!deletedJob) {
        throw new HelmxError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      }
      timers.get(input.id)?.clear()
      timers.delete(input.id)
      doc.set({ version: 1, jobs: current.jobs.filter((j) => j.id !== input.id) })
      try {
        await doc.flush()
      } catch (err) {
        try {
          const latest = readDoc()
          if (!latest.jobs.some((j) => j.id === input.id)) {
            doc.set({ version: 1, jobs: [...latest.jobs, deletedJob] })
          }
        } catch {
          doc.set(current)
        }
        scheduleJob(input.id)
        throw err
      }
      return { deleted: true }
    },
  })

  ctx.action({
    id: 'cron_trigger',
    description: 'Manually trigger a cron job once now (a real delivery; failures throw without affecting later scheduled runs)',
    exposeToPrompt: false,
    inputSchema: idInputSchema,
    outputSchema: {
      type: 'object',
      properties: {
        triggered: { type: 'boolean' },
        conversationId: { type: 'integer' },
      },
      required: ['triggered', 'conversationId'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'trigger'] },
    handler: async (input: { id: string }) => {
      const job = readDoc().jobs.find((j) => j.id === input.id)
      if (!job) throw new HelmxError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      const res = await deps.dispatchTrigger(
        { ...buildCronEnvelope(job, clock.now()), id: `cron:${job.id}:manual:${randomUUID()}` },
        buildTargetForJob(job),
      )
      return { triggered: true, conversationId: res.conversationId }
    },
  })

  ctx.service({
    id: 'cron-scheduler',
    liveTasks: () => [...inflight.keys()].map((id) => `cron-dispatch:${id}`),
    inUse: () =>
      parseCronDoc(doc.get())
        .jobs.filter((j) => j.enabled)
        .map((j) => ({ kind: 'cron_job', id: j.id, label: `cron job "${j.id}" (${j.schedule})` })),
    async start() {
      stopping = false
      try {
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
        for (const job of current.jobs) scheduleJob(job.id)
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
      while (activeTickWrite !== undefined) await activeTickWrite
    },
  })

  return {
    async tickNow() {
      const current = readDoc()
      await Promise.all(current.jobs.filter((j) => j.enabled).map((j) => tickJob(j.id)))
    },
    async settle() {
      for (let i = 0; i < 100 && inflight.size > 0; i++) {
        await Promise.allSettled([...inflight.values()])
        await new Promise((resolve) => setImmediate(resolve))
      }
      while (activeTickWrite !== undefined) await activeTickWrite
    },
    getJob(id: string) {
      return readDoc().jobs.find((j) => j.id === id)
    },
  }
}
