/**
 * cron 解析层（纯函数、零状态）：五字段表达式 + IANA 时区校验、下一次触发点计算、
 * 创建输入归一化，以及持久化 `crons` doc 的严格校验（损坏即 `cron_doc_corrupt`）。
 */
import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { HelmxError } from '@helmx/protocol'
import { advanceCronAfterFire, parseNextCronTime } from '../../durable-scheduler.js'
import { MAX_TRIGGER_KEEP_LAST, normalizeTriggerTargetInput, type TriggerSessionMode } from '../contracts.js'
import { ID_PATTERN, failCorrupt, failValidation, type CronDoc, type CronJob } from './contracts.js'

function assertNextTimeAvailable(schedule: string, timezone: string, afterMs: number, err: unknown): never {
  throw new HelmxError(
    'cron_next_time_unavailable',
    `failed to compute the next cron time (schedule=${schedule} tz=${timezone}): ${err instanceof Error ? err.message : String(err)}`,
    500,
    { schedule, timezone, afterMs },
  )
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
    assertNextTimeAvailable(schedule, timezone, afterMs, err)
  }
}

/** Compute the next planned point after a fire, jumping past downtime instead of replaying interval by interval. */
export function advanceAfterFire(schedule: string, timezone: string, fireAt: number, now: number): number | undefined {
  try {
    return advanceCronAfterFire(schedule, timezone, fireAt, now)
  } catch (err) {
    assertNextTimeAvailable(schedule, timezone, fireAt, err)
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

type CronJobRaw = Record<string, unknown>

interface ParsedJobIdentity {
  id: string
  rev: string
}

/** 经 `assertJobFields` 校验后必为正确类型的核心字段。 */
interface JobCoreFields {
  schedule: string
  text: string
  timezone: string
  enabled: boolean
  catchUp: boolean
}

/** 形状、id/rev 与重复 id 校验（`where` 用于损坏诊断定位）。 */
function parseJobIdentity(rawJob: unknown, index: number, seen: Set<string>): CronJobRaw & ParsedJobIdentity {
  const where = `jobs[${index}]`
  if (rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    failCorrupt(`${where} must be an object`, { index })
  }
  const job = rawJob as CronJobRaw
  if (typeof job.id !== 'string' || !ID_PATTERN.test(job.id)) {
    failCorrupt(`invalid ${where}.id: ${String(job.id)}`, { index })
  }
  const id = job.id
  if (typeof job.rev !== 'string' || job.rev.length === 0) {
    failCorrupt(`${where} (${id}) is missing the creation generation rev`, { index, id })
  }
  if (seen.has(id)) failCorrupt(`duplicate ${where}.id: ${id}`, { index, id })
  seen.add(id)
  return job as CronJobRaw & ParsedJobIdentity
}

/** 必填字段与可选字符串/数值字段校验（通过后核心字段类型确定）。 */
function assertJobFields(job: CronJobRaw & ParsedJobIdentity, index: number): asserts job is CronJobRaw & ParsedJobIdentity & JobCoreFields {
  const { id } = job
  const where = `jobs[${index}]`
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
  for (const field of ['lastRunAt', 'nextRunAt', 'lastSkippedAt'] as const) {
    if (job[field] !== undefined && (typeof job[field] !== 'number' || !Number.isFinite(job[field]))) {
      failCorrupt(`${where} (${id}) ${field} must be finite numbers`, { index, id, field })
    }
  }
}

/** 投递目标约束：显式会话与自动化模式互斥；无显式会话时必须声明 mode 且 mode 决定可用字段。 */
function assertJobTargetShape(job: CronJobRaw & ParsedJobIdentity, index: number): void {
  const { id } = job
  const where = `jobs[${index}]`
  const hasAutomatedFields =
    job.mode !== undefined || job.profileId !== undefined || job.keepLast !== undefined || job.dedicatedConversationId !== undefined
  if (job.targetConversationId !== undefined) {
    if (hasAutomatedFields) {
      failCorrupt(`${where} (${id}) targetConversationId is mutually exclusive with mode/profileId/keepLast/dedicatedConversationId`, {
        index,
        id,
      })
    }
    return
  }
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

function parseCronJob(rawJob: unknown, index: number, seen: Set<string>): CronJob {
  const job = parseJobIdentity(rawJob, index, seen)
  assertJobFields(job, index)
  assertJobTargetShape(job, index)
  return {
    id: job.id,
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
