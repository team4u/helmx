/**
 * Pure time-observability human formatting helpers for CLI output.
 * Re-exports canonical `resolveConversationTiming` and timing types from `@helmx/protocol`.
 */
import {
  resolveConversationTiming,
  type ConversationTimingInput,
  type ConversationTimingSnapshot,
} from '@helmx/protocol'

export {
  resolveConversationTiming,
  type ConversationTimingInput,
  type ConversationTimingSnapshot,
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Humanize a settled millisecond duration (`450ms` / `12.4s` / `2m15s` / `1h5m`);
 * invalid or negative inputs return an empty string.
 */
export function formatDurationMs(ms: number | undefined): string {
  if (!isNonNegativeFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
  }
  return `${Math.floor(totalSeconds / 3600)}h${Math.floor((totalSeconds % 3600) / 60)}m`
}

/**
 * Humanize a live elapsed duration with whole-second flooring (`0s` / `45s` / `1m05s` / `2h07m`);
 * invalid or negative inputs return an empty string.
 */
export function formatStopwatchMs(ms: number | undefined): string {
  if (!isNonNegativeFinite(ms)) return ''
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m${pad2(totalSeconds % 60)}s`
  }
  return `${Math.floor(totalSeconds / 3600)}h${pad2(Math.floor((totalSeconds % 3600) / 60))}m`
}

/**
 * Compact human-readable timing label for conversation lists, details, and watch summaries:
 * - blocked with `pendingAskSince` -> `waiting <stopwatch>` (plus `(total <duration>)` when prior settled time exists)
 * - working with `runStartedAt` -> `running <stopwatch>` (plus `(total <stopwatch>)` when prior settled time exists)
 * - idle/done/error (or missing live anchor) with `runDurationMs > 0` -> `total <duration>`
 * - absent/zero data -> empty string (never fabricates `0s`)
 */
export function formatConversationTiming(conv: ConversationTimingInput, nowMs?: number): string {
  const timing = resolveConversationTiming(conv, nowMs)
  if (timing.waitingMs !== undefined) {
    const wait = `waiting ${formatStopwatchMs(timing.waitingMs)}`
    if (timing.settledRunMs > 0 && timing.totalRunMs !== undefined) {
      const total =
        timing.currentRunMs !== undefined
          ? formatStopwatchMs(timing.totalRunMs)
          : formatDurationMs(timing.totalRunMs)
      return `${wait} (total ${total})`
    }
    return wait
  }
  if (timing.currentRunMs !== undefined) {
    const run = `running ${formatStopwatchMs(timing.currentRunMs)}`
    if (timing.settledRunMs > 0 && timing.totalRunMs !== undefined) {
      return `${run} (total ${formatStopwatchMs(timing.totalRunMs)})`
    }
    return run
  }
  if (timing.totalRunMs !== undefined) {
    return `total ${formatDurationMs(timing.totalRunMs)}`
  }
  return ''
}

const RAW_CONVERSATION_TIMING_KEYS = new Set(['runDurationMs', 'runStartedAt', 'pendingAskSince'])

/**
 * Project a conversation summary/detail object for human key-value rendering:
 * replaces raw epoch/ms timing fields with a single synthesized `timing` field when meaningful,
 * and omits it completely when no timing data is present. Never used on `--json` output.
 */
export function projectConversationForHuman(
  record: Record<string, unknown>,
  nowMs: number,
): Record<string, unknown> {
  const timing = formatConversationTiming(record as ConversationTimingInput, nowMs)
  const out: Record<string, unknown> = {}
  let timingInserted = false
  for (const [key, value] of Object.entries(record)) {
    if (RAW_CONVERSATION_TIMING_KEYS.has(key)) continue
    out[key] = value
    if (key === 'status' && timing !== '') {
      out.timing = timing
      timingInserted = true
    }
  }
  if (!timingInserted && timing !== '') {
    out.timing = timing
  }
  return out
}

/** Waiting duration for a pending AskDoc row; returns empty string when non-pending or missing timestamp. */
export function formatAskWaiting(ask: { status?: string; createdAt?: number }, nowMs?: number): string {
  if (ask.status !== 'pending') return ''
  if (typeof ask.createdAt !== 'number' || !Number.isFinite(ask.createdAt) || ask.createdAt <= 0) return ''
  if (!isNonNegativeFinite(nowMs)) return ''
  return formatStopwatchMs(Math.max(0, nowMs - ask.createdAt))
}
