/**
 * Pure runtime parsers, eligibility guards, and presentation helpers for builtin:plan client.
 * Zero React or DOM dependencies (Fast Refresh friendly).
 */
import type { BadgeTone, StatusLightTone } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol/browser'
import {
  PLAN_PLUGIN_ID,
  type PlanApprovedInfo,
  type PlanDraftSummary,
  type PlanProposeOutcome,
  type PlanSessionView,
  type PlanToolPresentationMeta,
} from './types.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const VALID_PROPOSE_OUTCOMES: ReadonlySet<string> = new Set<PlanProposeOutcome>([
  'approved',
  'approved_handoff',
  'revised',
  'cancelled',
  'superseded',
  'error',
])

/**
 * Top-level human conversations only: standby drafts (`undefined`), subagents (`parentConversationId !== undefined`),
 * and `helmx`-owned background conversations are excluded from Plan controls.
 */
export function isPlanEligibleConversation(
  conversation: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): conversation is Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> {
  if (conversation === undefined) return false
  if (conversation.parentConversationId !== undefined) return false
  if ((conversation.ownedBy ?? 'human') !== 'human') return false
  return true
}

/** Whether a standby draft's `inputMeta` has armed `builtin:plan` for the first send. */
export function isStandbyPlanArmed(draftMeta: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!isPlainObject(draftMeta) || !Object.hasOwn(draftMeta, PLAN_PLUGIN_ID)) return false
  const entry = draftMeta[PLAN_PLUGIN_ID]
  return isPlainObject(entry) && Object.hasOwn(entry, 'mode') && entry['mode'] === 'planning'
}

function parsePlanDraftSummary(raw: unknown): PlanDraftSummary | undefined {
  if (!isPlainObject(raw)) return undefined
  const title = nonEmptyString(raw['title'])
  if (title === undefined || typeof raw['markdown'] !== 'string') return undefined
  if (!isPositiveSafeInt(raw['version']) || !isFiniteTimestamp(raw['updatedAt'])) return undefined
  return {
    title,
    markdown: raw['markdown'],
    version: raw['version'],
    updatedAt: raw['updatedAt'],
  }
}

function parsePlanApprovedInfo(raw: unknown): PlanApprovedInfo | undefined {
  if (!isPlainObject(raw)) return undefined
  const title = nonEmptyString(raw['title'])
  const artifactId = nonEmptyString(raw['artifactId'])
  const artifactName = nonEmptyString(raw['artifactName'])
  if (
    title === undefined ||
    artifactId === undefined ||
    artifactName === undefined ||
    !isPositiveSafeInt(raw['version']) ||
    !isFiniteTimestamp(raw['approvedAt']) ||
    typeof raw['handoffUsed'] !== 'boolean'
  ) {
    return undefined
  }
  const executionModel = nonEmptyString(raw['executionModel'])
  return {
    title,
    version: raw['version'],
    artifactId,
    artifactName,
    approvedAt: raw['approvedAt'],
    handoffUsed: raw['handoffUsed'],
    ...(executionModel !== undefined ? { executionModel } : {}),
  }
}

export function parsePlanSessionView(raw: unknown): PlanSessionView | undefined {
  if (!isPlainObject(raw)) return undefined
  const mode = raw['mode']
  if (mode !== 'normal' && mode !== 'planning') return undefined
  const awaitingApproval = typeof raw['awaitingApproval'] === 'boolean' ? raw['awaitingApproval'] : false
  const draft = parsePlanDraftSummary(raw['draft'])
  const approved = parsePlanApprovedInfo(raw['approved'])
  return {
    mode,
    awaitingApproval,
    ...(draft !== undefined ? { draft } : {}),
    ...(approved !== undefined ? { approved } : {}),
  }
}

export function parsePlanToolPresentationMeta(raw: unknown): PlanToolPresentationMeta | undefined {
  if (!isPlainObject(raw)) return undefined
  const kind = raw['kind']
  const title = nonEmptyString(raw['title'])

  const version = raw['version']
  if (title === undefined || !isPositiveSafeInt(version)) return undefined

  if (kind === 'save') {
    const lineCount = raw['lineCount']
    const charCount = raw['charCount']
    if (!isNonNegativeSafeInt(lineCount) || !isNonNegativeSafeInt(charCount)) return undefined
    return {
      kind: 'save',
      title,
      version,
      lineCount,
      charCount,
    }
  }

  if (kind === 'propose') {
    const outcome = raw['outcome']
    if (typeof outcome !== 'string' || !VALID_PROPOSE_OUTCOMES.has(outcome)) return undefined
    const artifactId = nonEmptyString(raw['artifactId'])
    const artifactName = nonEmptyString(raw['artifactName'])
    const executionModel = nonEmptyString(raw['executionModel'])
    return {
      kind: 'propose',
      title,
      version,
      outcome: outcome as PlanProposeOutcome,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(artifactName !== undefined ? { artifactName } : {}),
      ...(executionModel !== undefined ? { executionModel } : {}),
    }
  }

  return undefined
}

export function extractFallbackToolTitle(input: unknown): string | undefined {
  if (!isPlainObject(input)) return undefined
  return nonEmptyString(input['title'])
}

export function extractFirstErrorLine(result: unknown): string | undefined {
  if (typeof result !== 'string') return undefined
  for (const line of result.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed
    }
  }
  return undefined
}

export type PlanVisualState = 'normal' | 'planning' | 'awaiting'

export function resolvePlanVisualState(
  view: Pick<PlanSessionView, 'mode' | 'awaitingApproval'>,
): PlanVisualState {
  if (view.awaitingApproval) return 'awaiting'
  return view.mode === 'planning' ? 'planning' : 'normal'
}

export function resolveProposeOutcomeLightTone(outcome: PlanProposeOutcome): StatusLightTone {
  switch (outcome) {
    case 'approved':
    case 'approved_handoff':
      return 'done'
    case 'revised':
      return 'pending'
    case 'cancelled':
    case 'superseded':
      return 'aborted'
    case 'error':
      return 'failed'
  }
}

export function resolveProposeOutcomeBadgeTone(outcome: PlanProposeOutcome): BadgeTone {
  switch (outcome) {
    case 'approved':
      return 'ok'
    case 'approved_handoff':
      return 'accent'
    case 'revised':
      return 'warn'
    case 'cancelled':
    case 'superseded':
      return 'neutral'
    case 'error':
      return 'err'
  }
}
