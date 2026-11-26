/**
 * Pure display model for the Composer read-only duration readout
 * (shared by Composer.tsx and unit tests; zero React/DOM dependencies).
 *
 * Scope — the status row stays silent unless the conversation needs the human:
 * - `blocked` with a valid `waitingMs` anchor: live `等待审批 <waiting>` stopwatch (warn tone);
 * - everything else renders nothing (`null`): the per-turn stopwatch and settled turn footer
 *   already live in the timeline, and the cross-turn cumulative total lives in the title popover
 *   and the outline header, so the status row never duplicates either.
 */
import type { ConversationStatus } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { formatStopwatchMs, resolveConversationTiming } from '../lib/format.js'

export interface ConversationDurationInput {
  status: ConversationStatus
  runDurationMs?: number
  runStartedAt?: number
  pendingAskSince?: number
  pendingAskCount?: number
  completionSeq?: number
  createdAt?: number
  updatedAt?: number
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether the conversation has an active live anchor requiring a 1Hz stopwatch clock. */
export function conversationDurationNeedsLiveClock(conv: ConversationDurationInput): boolean {
  const hasPendingAsk = isPositiveFinite(conv.pendingAskCount)
  const isBlocked = conv.status === 'blocked' || hasPendingAsk
  if (isBlocked && (conv.pendingAskCount === undefined || hasPendingAsk) && isNonNegativeFinite(conv.pendingAskSince)) {
    return true
  }
  const isRunning = conv.status === 'working' || (isBlocked && isNonNegativeFinite(conv.runStartedAt))
  return isRunning && isNonNegativeFinite(conv.runStartedAt)
}

/** Waiting-approval stopwatch text for `.composer-status-row`; `null` renders nothing. */
export function conversationDurationLabel(
  conv: ConversationDurationInput,
  nowMs: number | undefined,
  t: WebMessageTranslator,
): string | null {
  const timing = resolveConversationTiming(conv, nowMs)
  if (!timing.isBlocked || timing.waitingMs === undefined) return null
  return t('composer.duration.waiting', { duration: formatStopwatchMs(timing.waitingMs) })
}
