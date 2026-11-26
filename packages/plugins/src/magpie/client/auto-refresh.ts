/**
 * Shared foreground auto-refresh coordinator for builtin:magpie.
 *
 * The default shared coordinator is stored via `Symbol.for(...)` on `globalThis` so separately
 * compiled surface entrypoints (`composer-quota.tsx`, `settings.tsx`) share a single timer,
 * in-flight lock, and manual-refresh timestamp, while `createMagpieAutoRefreshCoordinator()`
 * encapsulates isolated coordinator state for tests and non-global callers.
 */

export interface MagpieAutoRefreshSubscription {
  intervalMs: number
  run: () => Promise<void>
  onResult?: (checkedAt: number, error?: string) => void
}

export interface MagpieAutoRefreshCoordinator {
  subscribe(options: MagpieAutoRefreshSubscription): () => void
  noteManualRefresh(checkedAt?: number): void
  dispose(): void
}

const AUTO_REFRESH_KEY = Symbol.for('helmx:builtin:magpie:auto-refresh-coordinator')

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function createMagpieAutoRefreshCoordinator(): MagpieAutoRefreshCoordinator {
  const subscribers = new Set<MagpieAutoRefreshSubscription>()
  let timer: ReturnType<typeof setInterval> | undefined
  let activeIntervalMs = 0
  let inFlight: Promise<void> | null = null
  let lastAttemptAt = 0
  let visibilityBound = false

  const effectiveIntervalMs = (): number => {
    let minMs = 0
    for (const sub of subscribers) {
      if (sub.intervalMs <= 0) continue
      if (minMs === 0 || sub.intervalMs < minMs) minMs = sub.intervalMs
    }
    return minMs
  }

  const notifyResult = (checkedAt: number, error?: string): void => {
    for (const sub of [...subscribers]) {
      sub.onResult?.(checkedAt, error)
    }
  }

  const triggerOnce = (): void => {
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

  const onVisibilityChange = (): void => {
    if (!isDocumentVisible()) return
    const interval = effectiveIntervalMs()
    if (interval <= 0) return
    if (Date.now() - lastAttemptAt >= interval) {
      triggerOnce()
    }
  }

  const clearTimerAndListener = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
      activeIntervalMs = 0
    }
    if (visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = false
    }
  }

  const syncSchedule = (triggerImmediatelyIfDue: boolean): void => {
    const nextInterval = effectiveIntervalMs()
    if (subscribers.size === 0 || nextInterval <= 0) {
      clearTimerAndListener()
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

  return {
    subscribe(options: MagpieAutoRefreshSubscription): () => void {
      const entry: MagpieAutoRefreshSubscription = {
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
    },

    noteManualRefresh(checkedAt = Date.now()): void {
      lastAttemptAt = checkedAt
      notifyResult(checkedAt, undefined)
    },

    dispose(): void {
      subscribers.clear()
      clearTimerAndListener()
      inFlight = null
      lastAttemptAt = 0
    },
  }
}

function getSharedCoordinator(): MagpieAutoRefreshCoordinator {
  const g = globalThis as Record<PropertyKey, unknown>
  let coordinator = g[AUTO_REFRESH_KEY] as MagpieAutoRefreshCoordinator | undefined
  if (coordinator === undefined) {
    coordinator = createMagpieAutoRefreshCoordinator()
    g[AUTO_REFRESH_KEY] = coordinator
  }
  return coordinator
}

/**
 * Subscribe a mounted Magpie composer status widget to the shared foreground
 * refresh cadence (`intervalMs <= 0` disables periodic polling).
 */
export function subscribeMagpieAutoRefresh(options: MagpieAutoRefreshSubscription): () => void {
  return getSharedCoordinator().subscribe(options)
}

/** Record a manual refresh completion so the shared cadence does not immediately re-fire. */
export function noteMagpieManualRefresh(checkedAt = Date.now()): void {
  getSharedCoordinator().noteManualRefresh(checkedAt)
}
