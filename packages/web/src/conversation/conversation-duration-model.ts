/**
 * Pure display model for the Composer read-only conversation duration readout
 * (shared by Composer.tsx and unit tests; zero React/DOM dependencies).
 *
 * Honesty & deduplication rules:
 * - `blocked` with valid `waitingMs`: `等待审批 <waiting>` (appends `· 累计 <total>` when totalRunMs > 0), warn tone;
 * - `working` with valid `currentRunMs`:
 *   - round 1 deduplication (`settledRunMs === 0`): `本轮 <current>` only;
 *   - round 2+ (`settledRunMs > 0`): `本轮 <current> · 累计 <total>`;
 * - idle / done / error (or active without a start anchor): only when `settledRunMs > 0`, show `累计 <settled>`;
 *   otherwise return `null` (never fabricate `0s` when start anchors or history are absent);
 * - Tooltip breakdown lists recorded total run, current turn (if active), waiting duration (if blocked),
 *   settled turns (`completionSeq`), creation timestamp, and honest session span.
 */
import type { ConversationStatus } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import {
  formatDurationMs,
  formatFullTimestamp,
  formatStopwatchMs,
  resolveConversationTiming,
} from '../lib/format.js'

export type ConversationDurationTone = 'default' | 'warn'

export interface ConversationDurationLabel {
  /** Compact read-only status text rendered in `.composer-status-row`. */
  text: string
  /** Semantic tone: warn while awaiting approval; default otherwise. */
  tone: ConversationDurationTone
  /** Multi-line hover breakdown shown inside Radix Tooltip. */
  tooltip: string
}

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

/** Derive the Composer read-only duration status label and tooltip breakdown; `null` renders nothing. */
export function conversationDurationLabel(
  conv: ConversationDurationInput,
  nowMs?: number,
  t: WebMessageTranslator = englishWebTranslator,
): ConversationDurationLabel | null {
  const timing = resolveConversationTiming(conv, nowMs)
  let text = ''
  let tone: ConversationDurationTone = 'default'

  if (timing.isBlocked && timing.waitingMs !== undefined) {
    const waitingText = formatStopwatchMs(timing.waitingMs)
    if (timing.totalRunMs !== undefined && timing.totalRunMs > 0) {
      text = t('composer.duration.waitingWithTotal', {
        waiting: waitingText,
        total: formatStopwatchMs(timing.totalRunMs),
      })
    } else {
      text = t('composer.duration.waiting', { duration: waitingText })
    }
    tone = 'warn'
  } else if (timing.isRunning && timing.currentRunMs !== undefined) {
    const turnText = formatStopwatchMs(timing.currentRunMs)
    if (timing.settledRunMs === 0) {
      text = t('composer.duration.currentTurn', { duration: turnText })
    } else {
      text = t('composer.duration.currentTurnWithTotal', {
        turn: turnText,
        total: formatStopwatchMs(timing.totalRunMs),
      })
    }
  } else if (timing.settledRunMs > 0) {
    text = t('composer.duration.total', { duration: formatDurationMs(timing.settledRunMs) })
  } else {
    return null
  }

  const tooltipLines: string[] = []
  if (timing.totalRunMs !== undefined && timing.totalRunMs > 0) {
    const totalFormatted =
      timing.currentRunMs !== undefined
        ? formatStopwatchMs(timing.totalRunMs)
        : formatDurationMs(timing.totalRunMs)
    tooltipLines.push(t('composer.duration.tooltipTotalRun', { duration: totalFormatted }))
  }
  if (timing.currentRunMs !== undefined) {
    tooltipLines.push(
      t('composer.duration.tooltipCurrentRun', { duration: formatStopwatchMs(timing.currentRunMs) }),
    )
  }
  if (timing.waitingMs !== undefined) {
    tooltipLines.push(
      t('composer.duration.tooltipWaiting', { duration: formatStopwatchMs(timing.waitingMs) }),
    )
  }
  if (typeof conv.completionSeq === 'number' && Number.isFinite(conv.completionSeq) && conv.completionSeq > 0) {
    tooltipLines.push(t('composer.duration.tooltipSettledTurns', { count: Math.trunc(conv.completionSeq) }))
  }
  const createdFull = formatFullTimestamp(conv.createdAt)
  if (createdFull !== '') {
    tooltipLines.push(t('composer.duration.tooltipCreatedAt', { time: createdFull }))
  }
  if (isPositiveFinite(conv.createdAt)) {
    const liveActive = timing.isRunning || timing.isBlocked
    const spanEnd =
      liveActive && isNonNegativeFinite(nowMs) && nowMs > conv.createdAt
        ? nowMs
        : isPositiveFinite(conv.updatedAt) && conv.updatedAt > conv.createdAt
          ? conv.updatedAt
          : undefined
    if (spanEnd !== undefined) {
      const spanMs = spanEnd - conv.createdAt
      const spanFormatted = liveActive && isNonNegativeFinite(nowMs)
        ? formatStopwatchMs(spanMs)
        : formatDurationMs(spanMs)
      if (spanFormatted !== '') {
        tooltipLines.push(t('composer.duration.tooltipSessionSpan', { duration: spanFormatted }))
      }
    }
  }

  return {
    text,
    tone,
    tooltip: tooltipLines.join('\n'),
  }
}
