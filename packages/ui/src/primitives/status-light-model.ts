/**
 * Tone model for the shared StatusLight primitive (pure functions, zero
 * React/DOM dependencies): normalizes the zoo of raw status words used across
 * the host and plugins (running/completed/error/aborted/skipped/offline/...)
 * into the seven honest presentation tones behind a single status light.
 *
 * Tone semantics (shape + color + accessible name, never color alone):
 * - working: in flight (accent dot, soft pulse);
 * - blocked: waiting for approval/input (solid warn dot);
 * - done: settled successfully / online / connected (solid ok dot);
 * - failed: settled with error (solid err dot);
 * - aborted: stopped before settling — NOT plain gray: a hollow warn diamond,
 *   clearly distinct from blocked's solid dot and done/failed's solid dots;
 * - pending: not started / skipped / unknown (hollow neutral ring);
 * - idle: offline / disconnected / disabled / resting (small muted dot).
 */

/** Canonical list of the seven presentation tones of the unified status light. */
export const STATUS_LIGHT_TONES = [
  'working',
  'blocked',
  'done',
  'failed',
  'aborted',
  'pending',
  'idle',
] as const

/** The seven presentation tones of the unified status light. */
export type StatusLightTone = (typeof STATUS_LIGHT_TONES)[number]

/** Raw status word aliases collected from host + plugin card surfaces. */
const TONE_ALIASES: Readonly<Record<string, StatusLightTone>> = {
  // in flight
  working: 'working',
  running: 'working',
  active: 'working',
  streaming: 'working',
  executing: 'working',
  // awaiting decision
  blocked: 'blocked',
  waiting: 'blocked',
  approving: 'blocked',
  // settled ok / connected
  done: 'done',
  completed: 'done',
  success: 'done',
  succeeded: 'done',
  passed: 'done',
  ok: 'done',
  settled: 'done',
  configured: 'done',
  online: 'done',
  connected: 'done',
  // settled with error
  failed: 'failed',
  error: 'failed',
  err: 'failed',
  // stopped before settling
  aborted: 'aborted',
  cancelled: 'aborted',
  canceled: 'aborted',
  superseded: 'aborted',
  stopped: 'aborted',
  // not started / skipped / unknown
  pending: 'pending',
  queued: 'pending',
  skipped: 'pending',
  'not-configured': 'pending',
  unconfigured: 'pending',
  // resting / offline
  idle: 'idle',
  offline: 'idle',
  disconnected: 'idle',
  disabled: 'idle',
}

/**
 * Returns whether a raw status word is explicitly recognized by the shared
 * status-light alias vocabulary (case-insensitive, prototype-safe).
 */
export function isKnownStatusLightStatus(status: string | undefined): boolean {
  if (status === undefined || status === '') return false
  return Object.prototype.hasOwnProperty.call(TONE_ALIASES, status.toLowerCase())
}

/**
 * Normalize a raw status word (any case) into a StatusLightTone; unknown or
 * missing statuses map to the honest neutral `pending` ring (never a fake
 * done/failed verdict). Pure function with zero side effects.
 */
export function normalizeStatusLightTone(status: string | undefined): StatusLightTone {
  if (status === undefined || status === '') return 'pending'
  const key = status.toLowerCase()
  return Object.prototype.hasOwnProperty.call(TONE_ALIASES, key) ? TONE_ALIASES[key]! : 'pending'
}

/** CSS dot class for a tone (reuses the host .status-dot design-system vocabulary). */
export function statusLightDotClass(tone: StatusLightTone): string {
  if (tone === 'idle') return 'status-dot'
  if (tone === 'failed') return 'status-dot status-dot-error'
  return `status-dot status-dot-${tone}`
}
