/**
 * Shared foreground auto-refresh coordinator for builtin:magpie.
 *
 * State is stored on a `Symbol.for(...)` slot on `globalThis` so separately
 * compiled surface entrypoints (`composer-quota.tsx`, `settings.tsx`) share
 * the exact same polling cadence, in-flight lock, and manual-refresh timestamp.
 *
 * Design:
 * - Zero backend background loops: polling runs ONLY while at least one mounted
 *   Composer / Standby status widget is viewing a Magpie model and the document
 *   is visible (`visibilityState !== 'hidden'`);
 * - Split-pane deduplication: multiple mounted panes share a single timer and a
 *   single in-flight lock so two split Magpie conversations never double-poll;
 * - Clean teardown: unmounting the last subscriber immediately clears the timer
 *   and removes the visibility listener (zero handle leaks in browsers or tests).
 */

interface Subscriber {
  intervalMs: number
  run: () => Promise<void>
  onResult?: (checkedAt: number, error?: string) => void
}

interface AutoRefreshState {
  subscribers: Set<Subscriber>
  timer: ReturnType<typeof setInterval> | undefined
  activeIntervalMs: number
  inFlight: Promise<void> | null
  lastAttemptAt: number
  visibilityBound: boolean
  visibilityListener?: () => void
}

const AUTO_REFRESH_KEY = Symbol.for('helmx:builtin:magpie:auto-refresh')

function getState(): AutoRefreshState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[AUTO_REFRESH_KEY] as AutoRefreshState | undefined
  if (state === undefined) {
    state = {
      subscribers: new Set(),
      timer: undefined,
      activeIntervalMs: 0,
      inFlight: null,
      lastAttemptAt: 0,
      visibilityBound: false,
    }
    g[AUTO_REFRESH_KEY] = state
  }
  return state
}

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

function effectiveIntervalMs(state: AutoRefreshState): number {
  let minMs = 0
  for (const sub of state.subscribers) {
    if (sub.intervalMs <= 0) continue
    if (minMs === 0 || sub.intervalMs < minMs) minMs = sub.intervalMs
  }
  return minMs
}

function notifyResult(state: AutoRefreshState, checkedAt: number, error?: string): void {
  for (const sub of [...state.subscribers]) {
    sub.onResult?.(checkedAt, error)
  }
}

function triggerOnce(): void {
  const state = getState()
  if (state.subscribers.size === 0 || !isDocumentVisible() || state.inFlight !== null) return
  const runner = state.subscribers.values().next().value
  if (!runner) return
  state.lastAttemptAt = Date.now()
  state.inFlight = runner
    .run()
    .then(() => {
      notifyResult(state, Date.now(), undefined)
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      notifyResult(state, Date.now(), message)
    })
    .finally(() => {
      state.inFlight = null
    })
}

function onVisibilityChange(): void {
  if (!isDocumentVisible()) return
  const state = getState()
  const interval = effectiveIntervalMs(state)
  if (interval <= 0) return
  if (Date.now() - state.lastAttemptAt >= interval) {
    triggerOnce()
  }
}

function syncSchedule(triggerImmediatelyIfDue: boolean): void {
  const state = getState()
  const nextInterval = effectiveIntervalMs(state)

  if (state.subscribers.size === 0 || nextInterval <= 0) {
    if (state.timer !== undefined) {
      clearInterval(state.timer)
      state.timer = undefined
      state.activeIntervalMs = 0
    }
    if (state.visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', state.visibilityListener ?? onVisibilityChange)
      state.visibilityListener = undefined
      state.visibilityBound = false
    }
    return
  }

  if (!state.visibilityBound && typeof document !== 'undefined') {
    const listener = state.visibilityListener ?? onVisibilityChange
    state.visibilityListener = listener
    document.addEventListener('visibilitychange', listener)
    state.visibilityBound = true
  }

  if (state.timer === undefined || state.activeIntervalMs !== nextInterval) {
    if (state.timer !== undefined) clearInterval(state.timer)
    state.activeIntervalMs = nextInterval
    state.timer = globalThis.setInterval(() => {
      triggerOnce()
    }, nextInterval)
  }

  if (triggerImmediatelyIfDue && Date.now() - state.lastAttemptAt >= nextInterval) {
    triggerOnce()
  }
}

/**
 * Subscribe a mounted Magpie composer status widget to the shared foreground
 * refresh cadence (`intervalMs <= 0` disables periodic polling).
 */
export function subscribeMagpieAutoRefresh(options: {
  intervalMs: number
  run: () => Promise<void>
  onResult?: (checkedAt: number, error?: string) => void
}): () => void {
  const state = getState()
  const entry: Subscriber = {
    intervalMs: options.intervalMs,
    run: options.run,
    onResult: options.onResult,
  }
  state.subscribers.add(entry)
  syncSchedule(true)
  return () => {
    state.subscribers.delete(entry)
    syncSchedule(false)
  }
}

/** Record a manual refresh completion so the shared cadence does not immediately re-fire. */
export function noteMagpieManualRefresh(checkedAt = Date.now()): void {
  const state = getState()
  state.lastAttemptAt = checkedAt
  notifyResult(state, checkedAt, undefined)
}

/** Reset module state (used by deterministic unit tests). */
export function resetMagpieAutoRefreshForTest(): void {
  const state = getState()
  state.subscribers.clear()
  if (state.timer !== undefined) {
    clearInterval(state.timer)
    state.timer = undefined
  }
  state.activeIntervalMs = 0
  state.inFlight = null
  state.lastAttemptAt = 0
  if (state.visibilityBound && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', state.visibilityListener ?? onVisibilityChange)
    state.visibilityListener = undefined
    state.visibilityBound = false
  }
}
