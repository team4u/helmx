/**
 * Module-scoped shared foreground auto-refresh coordinator for builtin:magpie.
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

const subscribers = new Set<Subscriber>()
let timer: ReturnType<typeof setInterval> | undefined
let activeIntervalMs = 0
let inFlight: Promise<void> | null = null
let lastAttemptAt = 0
let visibilityBound = false

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

function effectiveIntervalMs(): number {
  let minMs = 0
  for (const sub of subscribers) {
    if (sub.intervalMs <= 0) continue
    if (minMs === 0 || sub.intervalMs < minMs) minMs = sub.intervalMs
  }
  return minMs
}

function notifyResult(checkedAt: number, error?: string): void {
  for (const sub of [...subscribers]) {
    sub.onResult?.(checkedAt, error)
  }
}

function triggerOnce(): void {
  if (subscribers.size === 0 || !isDocumentVisible() || inFlight !== null) return
  const runner = subscribers.values().next().value
  if (!runner) return
  lastAttemptAt = Date.now()
  inFlight = runner
    .run()
    .then(() => {
      notifyResult(Date.now(), undefined)
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      notifyResult(Date.now(), message)
    })
    .finally(() => {
      inFlight = null
    })
}

function onVisibilityChange(): void {
  if (!isDocumentVisible()) return
  const interval = effectiveIntervalMs()
  if (interval <= 0) return
  if (Date.now() - lastAttemptAt >= interval) {
    triggerOnce()
  }
}

function syncSchedule(triggerImmediatelyIfDue: boolean): void {
  const nextInterval = effectiveIntervalMs()

  if (subscribers.size === 0 || nextInterval <= 0) {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
      activeIntervalMs = 0
    }
    if (visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = false
    }
    return
  }

  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }

  if (timer === undefined || activeIntervalMs !== nextInterval) {
    if (timer !== undefined) clearInterval(timer)
    activeIntervalMs = nextInterval
    timer = globalThis.setInterval(() => {
      triggerOnce()
    }, nextInterval)
  }

  if (triggerImmediatelyIfDue && Date.now() - lastAttemptAt >= nextInterval) {
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
  const entry: Subscriber = {
    intervalMs: options.intervalMs,
    run: options.run,
    onResult: options.onResult,
  }
  subscribers.add(entry)
  syncSchedule(true)
  return () => {
    subscribers.delete(entry)
    syncSchedule(false)
  }
}

/** Record a manual refresh completion so the shared cadence does not immediately re-fire. */
export function noteMagpieManualRefresh(checkedAt = Date.now()): void {
  lastAttemptAt = checkedAt
  notifyResult(checkedAt, undefined)
}

/** Reset module state (used by deterministic unit tests). */
export function resetMagpieAutoRefreshForTest(): void {
  subscribers.clear()
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  activeIntervalMs = 0
  inFlight = null
  lastAttemptAt = 0
  if (visibilityBound && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
  }
}
