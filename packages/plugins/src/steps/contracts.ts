/**
 * builtin:steps shared contracts, JSON Schemas, validation, and projection helpers (browser-safe).
 */
import {
  HelmxError,
  isJsonObject,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type PluginDefinition,
} from '@helmx/protocol'
import { isTopLevelHumanConversation } from '../shared-helpers.js'

export const STEPS_PLUGIN_ID = 'builtin:steps' as const
export const STEPS_KV_NAMESPACE = 'steps' as const
export const STEPS_SESSION_DOC = 'steps' as const
export const STEPS_TOOL_UPDATE = 'update_steps' as const

export const STEPS_MAX_ITEMS = 12 as const
export const STEPS_TITLE_MAX_CHARS = 120 as const

export const STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped', 'failed'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

export type StepsSettledOutcome = 'completed' | 'failed' | 'aborted'

export const STEPS_ELIGIBLE_SCOPE = {
  topLevelOnly: true,
  ownedBy: 'human',
} as const satisfies ConversationScope

export interface StepItem {
  title: string
  status: StepStatus
}

export interface StepsConversationRecord {
  steps: StepItem[]
  version: number
  updatedAt: number
  dismissedAtVersion?: number
  settledOutcome?: StepsSettledOutcome
}

export interface StepsSessionView {
  steps: StepItem[]
  version: number
  updatedAt: number
  dismissed: boolean
  allTerminal: boolean
  settledOutcome?: StepsSettledOutcome
}

export interface StepsToolPresentationMeta {
  version: number
  total: number
  done: number
  inProgressCount: number
  failedCount: number
  skippedCount: number
  allTerminal: boolean
  cleared: boolean
  inProgressTitle?: string
  steps: StepItem[]
}

export interface UpdateStepsInput {
  steps: StepItem[]
}

export type StepsPluginClientAssets = Pick<PluginDefinition, 'clientRoot' | 'prebuiltClientDir'>

export interface StepsPluginOptions {
  clientAssets?: StepsPluginClientAssets
  now?: () => number
}

const VALID_STEP_STATUSES: ReadonlySet<string> = new Set(STEP_STATUSES)
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const LEADING_STEP_INDEX_MAX_CHECK = STEPS_MAX_ITEMS

export const STEP_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: STEPS_TITLE_MAX_CHARS,
      description: `Short imperative step title (2-6 words, max ${STEPS_TITLE_MAX_CHARS} single-line characters).`,
    },
    status: {
      type: 'string',
      enum: [...STEP_STATUSES],
      description: 'Current step status.',
    },
  },
  required: ['title', 'status'],
  additionalProperties: false,
}

export const UPDATE_STEPS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      maxItems: STEPS_MAX_ITEMS,
      items: STEP_ITEM_SCHEMA,
      description: `Full ordered checklist of steps (at most ${STEPS_MAX_ITEMS}; empty array clears the checklist). Replaces any previous list.`,
    },
  },
  required: ['steps'],
  additionalProperties: false,
}

export const STEPS_PRESENTATION_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    version: { type: 'integer', minimum: 1, description: 'Monotonic checklist revision number.' },
    total: { type: 'integer', minimum: 0, maximum: STEPS_MAX_ITEMS, description: 'Total number of steps.' },
    done: { type: 'integer', minimum: 0, maximum: STEPS_MAX_ITEMS, description: 'Count of completed steps.' },
    inProgressCount: {
      type: 'integer',
      minimum: 0,
      maximum: STEPS_MAX_ITEMS,
      description: 'Count of steps currently in progress.',
    },
    failedCount: {
      type: 'integer',
      minimum: 0,
      maximum: STEPS_MAX_ITEMS,
      description: 'Count of failed steps.',
    },
    skippedCount: {
      type: 'integer',
      minimum: 0,
      maximum: STEPS_MAX_ITEMS,
      description: 'Count of skipped steps.',
    },
    allTerminal: {
      type: 'boolean',
      description: 'Whether every step is in a terminal state (done, skipped, or failed).',
    },
    cleared: {
      type: 'boolean',
      description: 'Whether this update cleared the checklist.',
    },
    inProgressTitle: {
      type: 'string',
      minLength: 1,
      maxLength: STEPS_TITLE_MAX_CHARS,
      description: 'Title of the first active step, if any.',
    },
    steps: {
      type: 'array',
      maxItems: STEPS_MAX_ITEMS,
      items: STEP_ITEM_SCHEMA,
      description: 'Snapshot of the ordered checklist items.',
    },
  },
  required: [
    'version',
    'total',
    'done',
    'inProgressCount',
    'failedCount',
    'skippedCount',
    'allTerminal',
    'cleared',
    'steps',
  ],
  additionalProperties: false,
}

export const STEPS_SESSION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      maxItems: STEPS_MAX_ITEMS,
      items: STEP_ITEM_SCHEMA,
      description: 'Ordered list of checklist items.',
    },
    version: { type: 'integer', minimum: 0, description: 'Checklist revision number (0 when empty).' },
    updatedAt: { type: 'number', minimum: 0, description: 'Epoch timestamp in milliseconds of the last update.' },
    dismissed: { type: 'boolean', description: 'Whether the user dismissed the checklist tray for this version.' },
    allTerminal: { type: 'boolean', description: 'Whether every step has reached a terminal state.' },
    settledOutcome: {
      type: 'string',
      enum: ['completed', 'failed', 'aborted'],
      description: 'Latest settled turn outcome while incomplete steps remain.',
    },
  },
  required: ['steps', 'version', 'updatedAt', 'dismissed', 'allTerminal'],
  additionalProperties: false,
}

export function isStepsConversationEligible(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): boolean {
  return isTopLevelHumanConversation(conv)
}

export function isStepTerminalStatus(status: StepStatus): boolean {
  return status === 'done' || status === 'skipped' || status === 'failed'
}

export function isStepsAllTerminal(steps: ReadonlyArray<Pick<StepItem, 'status'>>): boolean {
  return steps.length > 0 && steps.every((step) => isStepTerminalStatus(step.status))
}

export function createEmptyStepsSessionView(): StepsSessionView {
  return {
    steps: [],
    version: 0,
    updatedAt: 0,
    dismissed: false,
    allTerminal: false,
  }
}

export function toStepsSessionView(record: StepsConversationRecord | undefined): StepsSessionView | null {
  if (record === undefined || record.steps.length === 0) return null
  return {
    steps: record.steps.map((step) => ({ title: step.title, status: step.status })),
    version: record.version,
    updatedAt: record.updatedAt,
    dismissed: record.dismissedAtVersion === record.version,
    allTerminal: isStepsAllTerminal(record.steps),
    ...(record.settledOutcome !== undefined ? { settledOutcome: record.settledOutcome } : {}),
  }
}

export function toStepsActionView(record: StepsConversationRecord | undefined): StepsSessionView {
  return toStepsSessionView(record) ?? createEmptyStepsSessionView()
}

function normalizeOneStepItem(
  raw: unknown,
  index: number,
  redact?: (text: string) => string,
): StepItem {
  if (!isJsonObject(raw)) {
    throw new HelmxError('validation_error', `steps[${index}] must be an object`, 400, { index })
  }
  const allowedKeys = Object.keys(raw).every((k) => k === 'title' || k === 'status')
  if (!allowedKeys) {
    throw new HelmxError(
      'validation_error',
      `steps[${index}] contains unsupported properties (only title and status are allowed)`,
      400,
      { index },
    )
  }
  if (typeof raw['title'] !== 'string') {
    throw new HelmxError('validation_error', `steps[${index}].title must be a string`, 400, { index })
  }
  if (CONTROL_CHAR_RE.test(raw['title'])) {
    throw new HelmxError(
      'validation_error',
      `steps[${index}].title must be single-line plain text without control characters`,
      400,
      { index },
    )
  }
  const trimmed = (redact !== undefined ? redact(raw['title']) : raw['title']).trim()
  if (trimmed.length === 0 || trimmed.length > STEPS_TITLE_MAX_CHARS) {
    throw new HelmxError(
      'validation_error',
      `steps[${index}].title must be 1-${STEPS_TITLE_MAX_CHARS} non-whitespace characters`,
      400,
      { index, length: trimmed.length },
    )
  }
  const status = raw['status']
  if (typeof status !== 'string' || !VALID_STEP_STATUSES.has(status)) {
    throw new HelmxError(
      'validation_error',
      `steps[${index}].status must be one of: ${STEP_STATUSES.join(', ')}`,
      400,
      { index, status: String(status) },
    )
  }
  return {
    title: trimmed,
    status: status as StepStatus,
  }
}

/** Validate and normalize a full-list replacement array of step items (0..12 items). */
export function normalizeStepItems(
  raw: unknown,
  redact?: (text: string) => string,
): StepItem[] {
  if (!Array.isArray(raw)) {
    throw new HelmxError('validation_error', 'steps must be an array', 400)
  }
  if (raw.length > LEADING_STEP_INDEX_MAX_CHECK) {
    throw new HelmxError(
      'validation_error',
      `steps may contain at most ${STEPS_MAX_ITEMS} items (received ${raw.length})`,
      400,
      { count: raw.length, max: STEPS_MAX_ITEMS },
    )
  }
  return raw.map((item, idx) => normalizeOneStepItem(item, idx, redact))
}

export function buildStepsPresentationMeta(
  steps: ReadonlyArray<StepItem>,
  version: number,
): StepsToolPresentationMeta {
  let done = 0
  let inProgressCount = 0
  let failedCount = 0
  let skippedCount = 0
  let inProgressTitle: string | undefined

  for (const step of steps) {
    switch (step.status) {
      case 'done':
        done += 1
        break
      case 'in_progress':
        inProgressCount += 1
        if (inProgressTitle === undefined) inProgressTitle = step.title
        break
      case 'failed':
        failedCount += 1
        break
      case 'skipped':
        skippedCount += 1
        break
      case 'pending':
        break
    }
  }

  return {
    version,
    total: steps.length,
    done,
    inProgressCount,
    failedCount,
    skippedCount,
    allTerminal: isStepsAllTerminal(steps),
    cleared: steps.length === 0,
    ...(inProgressTitle !== undefined ? { inProgressTitle } : {}),
    steps: steps.map((step) => ({ title: step.title, status: step.status })),
  }
}

/** Compact one-line English confirmation returned to the model (avoids echoing JSON back into context). */
export function formatStepsToolOutput(meta: StepsToolPresentationMeta): string {
  if (meta.cleared) return 'Cleared steps.'
  if (meta.allTerminal && meta.failedCount === 0) {
    return `Updated steps: ${meta.done}/${meta.total} completed.`
  }
  if (meta.inProgressTitle !== undefined) {
    return `Updated steps: ${meta.done}/${meta.total} done, current: ${meta.inProgressTitle}.`
  }
  if (meta.failedCount > 0) {
    return `Updated steps: ${meta.done}/${meta.total} done (${meta.failedCount} failed).`
  }
  return `Updated steps: ${meta.done}/${meta.total} done.`
}

function parseStepItemArraySafe(raw: unknown): StepItem[] | undefined {
  if (!Array.isArray(raw) || raw.length > STEPS_MAX_ITEMS) return undefined
  const out: StepItem[] = []
  for (const item of raw) {
    if (!isJsonObject(item)) return undefined
    const title = typeof item['title'] === 'string' ? item['title'].trim() : ''
    const status = item['status']
    if (
      title.length === 0 ||
      title.length > STEPS_TITLE_MAX_CHARS ||
      CONTROL_CHAR_RE.test(title) ||
      typeof status !== 'string' ||
      !VALID_STEP_STATUSES.has(status)
    ) {
      return undefined
    }
    out.push({ title, status: status as StepStatus })
  }
  return out
}

export function parseStepsConversationRecord(raw: unknown): StepsConversationRecord | undefined {
  if (!isJsonObject(raw)) return undefined
  const steps = parseStepItemArraySafe(raw['steps'])
  if (steps === undefined || steps.length === 0) return undefined
  const version = raw['version']
  const updatedAt = raw['updatedAt']
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined
  }
  const dismissedAtVersion = raw['dismissedAtVersion']
  if (
    dismissedAtVersion !== undefined &&
    (typeof dismissedAtVersion !== 'number' || !Number.isSafeInteger(dismissedAtVersion) || dismissedAtVersion < 1)
  ) {
    return undefined
  }
  const settledOutcome = raw['settledOutcome']
  if (
    settledOutcome !== undefined &&
    settledOutcome !== 'completed' &&
    settledOutcome !== 'failed' &&
    settledOutcome !== 'aborted'
  ) {
    return undefined
  }
  return {
    steps,
    version,
    updatedAt,
    ...(dismissedAtVersion !== undefined ? { dismissedAtVersion } : {}),
    ...(settledOutcome !== undefined ? { settledOutcome } : {}),
  }
}

export function parseStepsToolPresentationMeta(raw: unknown): StepsToolPresentationMeta | undefined {
  if (!isJsonObject(raw)) return undefined
  const steps = parseStepItemArraySafe(raw['steps'])
  const version = raw['version']
  if (
    steps === undefined ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return undefined
  }
  return buildStepsPresentationMeta(steps, version)
}
