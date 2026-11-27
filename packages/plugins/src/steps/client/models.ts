/**
 * Pure runtime parsers, eligibility guards, and presentation view models for builtin:steps client.
 * Zero React or DOM dependencies (Fast Refresh friendly).
 */
import type { BadgeTone, StatusLightTone } from '@helmx/ui'
import type { ConversationStatus, ConversationSummary } from '@helmx/protocol/browser'
import type {
  StepItem,
  StepStatus,
  StepsSessionView,
  StepsSettledOutcome,
  StepsToolPresentationMeta,
} from './types.ts'

export const DESKTOP_DEFAULT_EXPAND_MIN_WIDTH = 680

const VALID_STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'pending',
  'in_progress',
  'done',
  'skipped',
  'failed',
])

const VALID_SETTLED_OUTCOMES: ReadonlySet<string> = new Set<StepsSettledOutcome>([
  'completed',
  'failed',
  'aborted',
])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseStepItems(raw: unknown): StepItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: StepItem[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) return undefined
    const title = typeof item['title'] === 'string' ? item['title'].trim() : ''
    const status = item['status']
    if (title === '' || typeof status !== 'string' || !VALID_STEP_STATUSES.has(status)) {
      return undefined
    }
    out.push({ title, status: status as StepStatus })
  }
  return out
}

export function isStepsEligibleConversation(
  conversation: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): conversation is Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> {
  if (conversation === undefined) return false
  if (conversation.parentConversationId !== undefined) return false
  if ((conversation.ownedBy ?? 'human') !== 'human') return false
  return true
}

export function parseStepsSessionView(raw: unknown): StepsSessionView | undefined {
  if (!isPlainObject(raw)) return undefined
  const steps = parseStepItems(raw['steps'])
  if (steps === undefined) return undefined
  const version = raw['version']
  const updatedAt = raw['updatedAt']
  if (
    !isNonNegativeSafeInt(version) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined
  }
  const dismissed = raw['dismissed'] === true
  const allTerminal =
    typeof raw['allTerminal'] === 'boolean'
      ? raw['allTerminal']
      : steps.length > 0 &&
        steps.every((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed')
  const settledRaw = raw['settledOutcome']
  const settledOutcome =
    typeof settledRaw === 'string' && VALID_SETTLED_OUTCOMES.has(settledRaw)
      ? (settledRaw as StepsSettledOutcome)
      : undefined
  return {
    steps,
    version,
    updatedAt,
    dismissed,
    allTerminal,
    ...(settledOutcome !== undefined ? { settledOutcome } : {}),
  }
}

export function parseStepsToolPresentationMeta(raw: unknown): StepsToolPresentationMeta | undefined {
  if (!isPlainObject(raw)) return undefined
  const steps = parseStepItems(raw['steps'])
  const version = raw['version']
  if (steps === undefined || !isPositiveSafeInt(version)) return undefined

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
    allTerminal:
      steps.length > 0 &&
      steps.every((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed'),
    cleared: steps.length === 0,
    ...(inProgressTitle !== undefined ? { inProgressTitle } : {}),
    steps,
  }
}

export function extractFirstErrorLine(result: unknown): string | undefined {
  if (typeof result !== 'string') return undefined
  const line = result
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (line === undefined || line === '') return undefined
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

export type StepsTrayVisualPhase =
  | 'completed'
  | 'completed_with_failures'
  | 'working'
  | 'paused'
  | 'interrupted'
  | 'pending'

export interface StepsTraySummary {
  total: number
  done: number
  failed: number
  skipped: number
  inProgress: number
  isWorking: boolean
  isInterrupted: boolean
  phase: StepsTrayVisualPhase
  statusTone: StatusLightTone
  badgeTone: BadgeTone
  warn: boolean
  activeTitle?: string
}

export function deriveStepsTraySummary(
  view: StepsSessionView,
  conversationStatus: ConversationStatus | undefined,
): StepsTraySummary {
  let done = 0
  let failed = 0
  let skipped = 0
  let inProgress = 0
  let firstInProgress: string | undefined
  let firstFailed: string | undefined
  let firstPending: string | undefined

  for (const step of view.steps) {
    if (step.status === 'done') done += 1
    else if (step.status === 'failed') {
      failed += 1
      if (firstFailed === undefined) firstFailed = step.title
    } else if (step.status === 'skipped') {
      skipped += 1
    } else if (step.status === 'in_progress') {
      inProgress += 1
      if (firstInProgress === undefined) firstInProgress = step.title
    } else if (step.status === 'pending' && firstPending === undefined) {
      firstPending = step.title
    }
  }

  const isWorking =
    conversationStatus !== undefined
      ? conversationStatus === 'working'
      : !view.allTerminal && view.settledOutcome === undefined

  const isInterrupted =
    !view.allTerminal &&
    !isWorking &&
    (view.settledOutcome === 'aborted' ||
      view.settledOutcome === 'failed' ||
      conversationStatus === 'error' ||
      inProgress > 0 ||
      view.settledOutcome === 'completed')

  let phase: StepsTrayVisualPhase
  let statusTone: StatusLightTone
  let badgeTone: BadgeTone
  let warn = false

  if (view.allTerminal) {
    if (failed > 0) {
      phase = 'completed_with_failures'
      statusTone = 'failed'
      badgeTone = 'err'
      warn = true
    } else {
      phase = 'completed'
      statusTone = 'done'
      badgeTone = 'ok'
    }
  } else if (isWorking) {
    phase = inProgress > 0 ? 'working' : 'pending'
    statusTone = inProgress > 0 ? 'working' : 'pending'
    badgeTone = 'accent'
  } else if (failed > 0 || view.settledOutcome === 'failed' || conversationStatus === 'error') {
    phase = 'interrupted'
    statusTone = 'failed'
    badgeTone = 'err'
    warn = true
  } else if (isInterrupted) {
    phase = 'paused'
    statusTone = view.settledOutcome === 'aborted' ? 'aborted' : 'blocked'
    badgeTone = 'warn'
    warn = true
  } else {
    phase = 'pending'
    statusTone = 'pending'
    badgeTone = 'neutral'
  }

  return {
    total: view.steps.length,
    done,
    failed,
    skipped,
    inProgress,
    isWorking,
    isInterrupted,
    phase,
    statusTone,
    badgeTone,
    warn,
    activeTitle: firstInProgress ?? firstFailed ?? firstPending,
  }
}

export function resolveStepItemVisualTone(
  status: StepStatus,
  isWorking: boolean,
  settledOutcome: StepsSettledOutcome | undefined,
): StatusLightTone {
  switch (status) {
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'in_progress':
      if (isWorking) return 'working'
      return settledOutcome === 'aborted' ? 'aborted' : 'blocked'
    case 'skipped':
      return 'idle'
    case 'pending':
      return 'pending'
  }
}
