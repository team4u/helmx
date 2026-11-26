/**
 * cron 动作层输入契约：`cron_*` 动作的 JSON Schema（HTTP / CLI / Tool 五端映射的唯一来源）、
 * `cron_update` 输入校验，以及基于已校验输入构建保留运行历史的更新后 job。
 */
import { randomUUID } from 'node:crypto'
import { HelmxError, type JsonSchema } from '@helmx/protocol'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  MAX_DESCRIPTION,
  MAX_TRIGGER_KEEP_LAST,
  assertTriggerTargetPatchSyntax,
  mergeTriggerTargetPatch,
} from '../contracts.js'
import { ID_PATTERN, failValidation, type CronJob, type CronUpdateInput } from './contracts.js'
import { assertValidSchedule, nextFireTime } from './parse.js'

export const CRON_ID_PROP: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }
export const CRON_ID_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { id: CRON_ID_PROP },
  required: ['id'],
  additionalProperties: false,
}
export const CRON_LIST_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { jobs: { type: 'array', items: { type: 'object' } } },
  required: ['jobs'],
  additionalProperties: false,
}
export const CRON_JOB_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { job: { type: 'object' } },
  required: ['job'],
  additionalProperties: false,
}
export const CRON_CREATE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: CRON_ID_PROP,
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
}
export const CRON_UPDATE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: CRON_ID_PROP,
    description: {
      type: 'string',
      maxLength: MAX_DESCRIPTION,
      description: 'Job description (empty string clears description)',
    },
    schedule: {
      type: 'string',
      description: 'Standard 5-field cron expression (min hour day month weekday, e.g. "*/30 * * * *")',
    },
    timezone: { type: 'string', description: 'IANA timezone name (e.g. Asia/Shanghai)' },
    text: { type: 'string', minLength: 1, description: 'Self-contained task text delivered when triggered' },
    enabled: { type: 'boolean' },
    catchUp: { type: 'boolean' },
    mode: {
      type: 'string',
      enum: ['isolated', 'dedicated'],
      description: 'Automated session mode when targetConversationId is omitted (isolated | dedicated)',
    },
    profileId: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Target Profile ID for automated sessions (mutually exclusive with targetConversationId)',
    },
    keepLast: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_TRIGGER_KEEP_LAST,
      description: `Number of settled isolated runs to retain automatically (1..${MAX_TRIGGER_KEEP_LAST}; only valid in isolated mode)`,
    },
    targetConversationId: {
      type: 'integer',
      minimum: 1,
      description: 'Explicit existing conversation ID to deliver into with followUp (mutually exclusive with mode/profileId/keepLast)',
    },
  },
  required: ['id'],
  additionalProperties: false,
}
export const CRON_DELETE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { deleted: { type: 'boolean' } },
  required: ['deleted'],
  additionalProperties: false,
}
export const CRON_TRIGGER_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    triggered: { type: 'boolean' },
    conversationId: { type: 'integer' },
  },
  required: ['triggered', 'conversationId'],
  additionalProperties: false,
}

export function parseCronUpdateInput(rawInput: Record<string, unknown>): CronUpdateInput {
  const input = rawInput as unknown as CronUpdateInput
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    failValidation(`invalid cron id (1..64 chars, alphanumeric _ - allowed, dots forbidden): ${String(input.id)}`, 'id')
  }
  const hasPatchField =
    input.description !== undefined ||
    input.schedule !== undefined ||
    input.timezone !== undefined ||
    input.text !== undefined ||
    input.enabled !== undefined ||
    input.catchUp !== undefined ||
    input.mode !== undefined ||
    input.profileId !== undefined ||
    input.keepLast !== undefined ||
    input.targetConversationId !== undefined
  if (!hasPatchField) {
    failValidation('cron_update requires at least one updatable field besides id', 'id')
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION)) {
    failValidation(`cron description must be a string of at most ${MAX_DESCRIPTION} chars`, 'description')
  }
  if (input.schedule !== undefined && typeof input.schedule !== 'string') {
    failValidation('cron schedule must be a string (standard five fields: min hour day month weekday)', 'schedule')
  }
  if (input.timezone !== undefined && (typeof input.timezone !== 'string' || input.timezone.length === 0)) {
    failValidation('cron timezone must not be empty (an IANA zone name; defaults to UTC)', 'timezone')
  }
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.trim().length === 0)) {
    failValidation('cron text must not be empty (the payload text delivered at trigger time)', 'text')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    failValidation('enabled must be a boolean', 'enabled')
  }
  if (input.catchUp !== undefined && typeof input.catchUp !== 'boolean') {
    failValidation('catchUp must be a boolean', 'catchUp')
  }
  assertTriggerTargetPatchSyntax({
    targetConversationId: input.targetConversationId,
    mode: input.mode,
    profileId: input.profileId,
    keepLast: input.keepLast,
  })
  return input
}

export function buildUpdatedCronJob(prevJob: CronJob, input: CronUpdateInput, now: number): CronJob {
  const nextScheduleRaw = input.schedule ?? prevJob.schedule
  const nextTimezone = input.timezone ?? prevJob.timezone
  assertValidSchedule(nextScheduleRaw, nextTimezone)
  const nextSchedule = nextScheduleRaw.trim()
  const nextTarget = mergeTriggerTargetPatch(prevJob, {
    targetConversationId: input.targetConversationId,
    mode: input.mode,
    profileId: input.profileId,
    keepLast: input.keepLast,
  })
  const nextDescription =
    input.description === undefined ? prevJob.description : input.description === '' ? undefined : input.description
  const nextEnabled = input.enabled ?? prevJob.enabled
  const nextCatchUp = input.catchUp ?? prevJob.catchUp
  const nextText = input.text ?? prevJob.text
  const nextRunAt = nextFireTime(nextSchedule, nextTimezone, now)
  if (nextRunAt === undefined && nextEnabled) {
    throw new HelmxError(
      'cron_no_next_time',
      `cron schedule has no future matching point in ${nextTimezone}; update refused: ${nextSchedule}`,
      400,
      { id: prevJob.id, schedule: nextSchedule, timezone: nextTimezone },
    )
  }
  return {
    id: prevJob.id,
    rev: randomUUID(),
    ...(nextDescription !== undefined ? { description: nextDescription } : {}),
    schedule: nextSchedule,
    timezone: nextTimezone,
    text: nextText,
    enabled: nextEnabled,
    catchUp: nextCatchUp,
    ...(nextTarget.targetConversationId !== undefined ? { targetConversationId: nextTarget.targetConversationId } : {}),
    ...(nextTarget.mode !== undefined ? { mode: nextTarget.mode } : {}),
    ...(nextTarget.profileId !== undefined ? { profileId: nextTarget.profileId } : {}),
    ...(nextTarget.keepLast !== undefined ? { keepLast: nextTarget.keepLast } : {}),
    ...(nextTarget.dedicatedConversationId !== undefined
      ? { dedicatedConversationId: nextTarget.dedicatedConversationId }
      : {}),
    ...(prevJob.lastRunAt !== undefined ? { lastRunAt: prevJob.lastRunAt } : {}),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    ...(prevJob.lastError !== undefined ? { lastError: prevJob.lastError } : {}),
    ...(prevJob.lastSkippedAt !== undefined ? { lastSkippedAt: prevJob.lastSkippedAt } : {}),
    ...(prevJob.lastSkipReason !== undefined ? { lastSkipReason: prevJob.lastSkipReason } : {}),
  }
}
