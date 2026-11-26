/**
 * Canonical pure conversation time-observability resolution shared across protocol consumers
 * (`@helmx/cli`, `@helmx/plugin-client`, `@helmx/web`).
 */
import type { ConversationStatus } from './conversation.js'

export interface ConversationTimingInput {
  status?: ConversationStatus
  runDurationMs?: number
  runStartedAt?: number
  pendingAskSince?: number
  pendingAskCount?: number
}

export interface ConversationTimingSnapshot {
  settledRunMs: number
  currentRunMs?: number
  totalRunMs?: number
  waitingMs?: number
  isRunning: boolean
  isBlocked: boolean
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Pure timing resolver for a conversation summary/detail and an optional wall-clock reading `nowMs`.
 * Never fabricates missing start anchors and never leaks live wall-clock deltas into idle/done/error states.
 */
export function resolveConversationTiming(
  conv: ConversationTimingInput,
  nowMs?: number,
): ConversationTimingSnapshot {
  const settledRunMs = isNonNegativeFinite(conv.runDurationMs) ? conv.runDurationMs : 0
  const hasPendingAsk =
    typeof conv.pendingAskCount === 'number' &&
    Number.isFinite(conv.pendingAskCount) &&
    conv.pendingAskCount > 0
  const isBlocked = conv.status === 'blocked' || hasPendingAsk
  const hasRunStart = isNonNegativeFinite(conv.runStartedAt)
  const isRunning = conv.status === 'working' || (isBlocked && hasRunStart)
  const hasNow = isNonNegativeFinite(nowMs)

  const currentRunMs =
    isRunning && hasRunStart && hasNow ? Math.max(0, nowMs - conv.runStartedAt!) : undefined
  const waitingMs =
    isBlocked &&
    (conv.pendingAskCount === undefined || hasPendingAsk) &&
    isNonNegativeFinite(conv.pendingAskSince) &&
    hasNow
      ? Math.max(0, nowMs - conv.pendingAskSince!)
      : undefined
  const totalRunMs =
    currentRunMs !== undefined
      ? settledRunMs + currentRunMs
      : settledRunMs > 0
        ? settledRunMs
        : undefined

  return {
    settledRunMs,
    ...(currentRunMs !== undefined ? { currentRunMs } : {}),
    ...(totalRunMs !== undefined ? { totalRunMs } : {}),
    ...(waitingMs !== undefined ? { waitingMs } : {}),
    isRunning,
    isBlocked,
  }
}
