/**
 * Formatting pure functions shared between plugin client.tsx and the host (no
 * host dependencies). Base units and rounding rules are unified with the host
 * timeline / node drawer (the host reuses them via this package instead of
 * keeping separate copies).
 */
export {
  resolveConversationTiming,
  type ConversationTimingInput,
  type ConversationTimingSnapshot,
} from '@helmx/protocol/browser'

/**
 * Humanize a byte count: base 1024 with KiB / MiB / GiB labels.
 * Unified rounding: values < 100 keep one decimal, >= 100 are rounded to
 * integers; below 1 KiB the value is rounded to whole B. The placeholder is
 * parameterizable ('-' for the timeline, '--' for the node drawer); units and
 * labels never vary per caller.
 */
export function formatBytes(bytes: number | undefined, options?: { placeholder?: string }): string {
  const placeholder = options?.placeholder ?? '--'
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return placeholder
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** Humanize a millisecond duration (tool elapsed time / total workflow time); invalid or missing returns an empty string.
 * Tiers: <1s whole milliseconds; <60s one-decimal seconds; <1h `XmYs`; >=1h `XhYm` (minute granularity).
 * The total seconds are rounded before splitting, so no tier ever produces a
 * carry artifact (`60.0s` / `1m60s` / `59m60s`); the short-duration precision
 * contract is unchanged (`1.5s` / `5.0s` / `2m5s`). */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  // One-decimal-seconds tier: the boundary where rounding would reach 60.0s
  // (>=59_950ms) is handed to the minute/hour tier for splitting.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
  }
  return `${Math.floor(totalSeconds / 3600)}h${Math.floor((totalSeconds % 3600) / 60)}m`
}

/**
 * Compact timestamp `MM-DD HH:mm:ss` (log-style display, e.g. Herdr snapshot
 * time); 0 / missing returns the placeholder. The default placeholder is a
 * fixed English text of the SDK ("unknown"); pass options.placeholder to
 * override it for host-side localization.
 */
export function formatCompactTimestamp(ms: number, options?: { placeholder?: string }): string {
  if (!ms) return options?.placeholder ?? 'unknown'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Compact date-time `MM-DD HH:mm` (table display, e.g. quota refresh time / Worker creation time); local timezone, invalid or missing returns an empty string. */
export function formatTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format a millisecond elapsed duration for a 1Hz live stopwatch using monotonic whole-second flooring.
 * Invalid or negative inputs return `''`.
 * Tiers: `<60_000` -> `Xs` (`0s`, `12s`, `59s`); `<3_600_000` -> `XmYYs` (`1m05s`, `12m30s`);
 * `>=3_600_000` -> `XhYYm` (`1h05m`). Uses `Math.floor` throughout to avoid rounding rollovers
 * and pads minor units to 2 digits to prevent width jitter under `tabular-nums`.
 */
export function formatStopwatchMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}m${pad2(seconds)}s`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return `${hours}h${pad2(minutes)}m`
}

/**
 * Format a non-negative millisecond offset relative to an origin timestamp using `Math.floor` whole seconds.
 * Invalid or negative inputs return `''`.
 * Tiers: `<3_600_000` -> `+MM:SS` (`+00:15`, `+02:15`); `>=3_600_000` -> `+H:MM:SS` (`+1:02:15`).
 */
export function formatOffsetMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.floor(ms / 1000)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const seconds = totalSeconds % 60
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60)
    return `+${pad2(minutes)}:${pad2(seconds)}`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return `+${hours}:${pad2(minutes)}:${pad2(seconds)}`
}
