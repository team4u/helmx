/**
 * Keyed HTTP request deduplication, AbortController / epoch cancellation,
 * timed failed-doc retry suppression, asset-refresh generation tracking,
 * and lifecycle timers for HelmxExternalStore.
 */
import type { ArtifactsSyncWatermark } from './use-unread-sync.js'

/** Cooldown before a failed plugin public doc can be retried automatically (ms). */
export const FAILED_DOC_RETRY_COOLDOWN_MS = 30_000

export function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

export interface ControlledRequestContext {
  signal: AbortSignal
  isStale: () => boolean
}

export interface ControlledRequestOptions<T> {
  key: string
  onStart?: () => void
  onError?: (error: unknown) => void
  exec: (ctx: ControlledRequestContext) => Promise<T | undefined>
}

export interface ArtifactsInFlightMeta {
  active: boolean
  watermark: ArtifactsSyncWatermark | undefined
}

export class StoreRequestManager {
  sessionEpoch = 0
  readonly inFlight = new Map<string, Promise<unknown>>()
  readonly inFlightControllers = new Map<string, AbortController>()
  readonly requestEpochs = new Map<string, number>()
  /** Maps `doc:<pluginId>/<name>` -> failure timestamp (ms) for bounded retry cooldown. */
  readonly failedDocs = new Map<string, number>()
  /** Mutable cooldown window (ms) so unit tests can verify cooldown expiry deterministically. */
  failedDocRetryCooldownMs = FAILED_DOC_RETRY_COOLDOWN_MS
  readonly pluginEpoch = new Map<string, number>()
  readonly artifactsWatermarks = new Map<number, ArtifactsSyncWatermark>()
  readonly artifactsInFlight = new Map<number, ArtifactsInFlightMeta>()
  readonly dirtyArtifacts = new Set<number>()
  readonly prevVisibleConversationIds = new Set<number>()
  assetGeneration = 0
  assetsController: AbortController | null = null
  readonly timers = new Set<ReturnType<typeof setTimeout>>()

  delay = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  markDocFailed(key: string, now = Date.now()): void {
    this.failedDocs.set(key, now)
  }

  isDocFailureSuppressed(key: string, now = Date.now()): boolean {
    const failedAt = this.failedDocs.get(key)
    if (failedAt === undefined) return false
    if (now - failedAt >= this.failedDocRetryCooldownMs) {
      this.failedDocs.delete(key)
      return false
    }
    return true
  }

  clearDocFailure(key: string): void {
    this.failedDocs.delete(key)
  }

  invalidatePluginDocRequests(pluginId: string): void {
    const docPrefix = `doc:${pluginId}/`
    this.pluginEpoch.set(pluginId, (this.pluginEpoch.get(pluginId) ?? 0) + 1)
    for (const key of [...this.failedDocs.keys()]) {
      if (key.startsWith(docPrefix)) this.failedDocs.delete(key)
    }
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(docPrefix)) this.inFlight.delete(key)
    }
  }

  abortRequestKey = (key: string): void => {
    this.requestEpochs.set(key, (this.requestEpochs.get(key) ?? 0) + 1)
    if (key.startsWith('artifacts:')) {
      const id = Number(key.slice('artifacts:'.length))
      if (Number.isInteger(id)) {
        this.artifactsInFlight.delete(id)
        this.dirtyArtifacts.delete(id)
      }
    }
    const ctrl = this.inFlightControllers.get(key)
    if (ctrl !== undefined) {
      this.inFlightControllers.delete(key)
      ctrl.abort()
    }
    this.inFlight.delete(key)
  }

  abortInFlightConversationRequests = (): void => {
    const keys = new Set<string>([...this.inFlightControllers.keys(), ...this.inFlight.keys()])
    for (const key of keys) {
      if (key.startsWith('conversation:') || key.startsWith('history:') || key.startsWith('artifacts:')) {
        this.abortRequestKey(key)
      }
    }
  }

  abortAllInFlight = (): void => {
    const keys = new Set<string>([...this.inFlightControllers.keys(), ...this.inFlight.keys()])
    for (const key of keys) this.abortRequestKey(key)
    this.assetsController?.abort()
    this.assetsController = null
  }

  beginAssetRefresh(): { generation: number; controller: AbortController } {
    const generation = ++this.assetGeneration
    this.assetsController?.abort()
    const controller = new AbortController()
    this.assetsController = controller
    return { generation, controller }
  }

  finishAssetRefresh(controller: AbortController): void {
    if (this.assetsController === controller) {
      this.assetsController = null
    }
  }

  syncVisibleConversations(nextVisible: Set<number>): void {
    for (const prevId of this.prevVisibleConversationIds) {
      if (!nextVisible.has(prevId)) {
        this.abortRequestKey(`conversation:${prevId}`)
        this.abortRequestKey(`history:${prevId}`)
        this.abortRequestKey(`artifacts:${prevId}`)
      }
    }
    this.prevVisibleConversationIds.clear()
    for (const id of nextVisible) {
      this.prevVisibleConversationIds.add(id)
    }
  }

  runControlled<T>(opts: ControlledRequestOptions<T>): Promise<T | undefined> {
    const { key, onStart, onError, exec } = opts
    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T | undefined>

    onStart?.()
    const epoch = this.sessionEpoch
    const reqEpoch = (this.requestEpochs.get(key) ?? 0) + 1
    this.requestEpochs.set(key, reqEpoch)
    const controller = new AbortController()
    this.inFlightControllers.set(key, controller)

    const isStale = (): boolean =>
      this.sessionEpoch !== epoch ||
      controller.signal.aborted ||
      this.requestEpochs.get(key) !== reqEpoch

    const task = exec({ signal: controller.signal, isStale })
      .then((value): T | undefined => (isStale() ? undefined : value))
      .catch((error: unknown): undefined => {
        if (isAbortError(error) || isStale()) return undefined
        onError?.(error)
        return undefined
      })
      .finally(() => {
        if (this.inFlightControllers.get(key) === controller) this.inFlightControllers.delete(key)
        if (this.inFlight.get(key) === task) this.inFlight.delete(key)
      })

    this.inFlight.set(key, task)
    return task
  }

  resetOnSnapshot(): void {
    this.sessionEpoch++
    this.abortInFlightConversationRequests()
    this.inFlight.clear()
    this.failedDocs.clear()
  }

  resetOnLogout(): void {
    this.sessionEpoch++
    this.abortAllInFlight()
    this.inFlight.clear()
    this.failedDocs.clear()
    this.artifactsWatermarks.clear()
    this.artifactsInFlight.clear()
    this.dirtyArtifacts.clear()
    this.prevVisibleConversationIds.clear()
    this.assetGeneration++
  }

  dispose(): void {
    this.sessionEpoch++
    this.abortAllInFlight()
    this.artifactsInFlight.clear()
    this.dirtyArtifacts.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
