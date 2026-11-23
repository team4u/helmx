/**
 * Reactive hooks for conversations, the plugin registry, and shared elapsed-time tickers
 * (host-port driven via fine-grained domain/keyed `useSyncExternalStore` subscriptions,
 * live-synced over SSE, no polling and no mocks).
 * No component exports in this file (Fast Refresh friendly).
 */
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { AskSpec, ConversationDetail, ConversationLive, ConversationSummary, HostModelsSlice, UsePluginsResult } from '@helmx/protocol/browser'
import { PluginClientHostContext, usePluginClientHost, type PluginClientHostPort } from './host-port.js'
import { useRequiredPluginContextBase } from './plugin-context.js'

const EMPTY_PLUGIN_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_PENDING_ASKS: AskSpec[] = Object.freeze([]) as unknown as AskSpec[]

/** Stable no-op subscribe for optional host capabilities (returns a no-op unsubscribe). */
const NOOP_UNSUBSCRIBE = (): void => {}
const NOOP_SUBSCRIBE = (_listener: () => void): (() => void) => NOOP_UNSUBSCRIBE
/** Stable undefined snapshot: a missing capability reads as unknown, never as an empty truth. */
const UNDEFINED_SNAPSHOT = (): undefined => undefined

/** All conversation summaries (live-synced over SSE; isolated from `conversationLives` token frames). */
export function useConversations(): ConversationSummary[] {
  const port = usePluginClientHost()
  return useSyncExternalStore(port.subscribeConversations, port.getConversations, port.getConversations)
}

/**
 * Reactive read-only host model catalog slice via the stable host port:
 * normalized entries plus the global default chain. `undefined` = capability
 * not injected or catalog not yet first-loaded (render unknown/loading and
 * disable selection); a slice with `models: []` = loaded and genuinely empty
 * ("no models"). The two states are strictly distinct and must never leak into
 * each other. On the server the snapshot is always `undefined`; dynamic
 * refresh, when offered, is the port's optional refreshModels action (absent
 * = no refresh capability).
 */
export function useHostModels(): HostModelsSlice | undefined {
  const port = usePluginClientHost()
  return useSyncExternalStore(
    port.subscribeModels ?? NOOP_SUBSCRIBE,
    port.getModels ?? UNDEFINED_SNAPSHOT,
    UNDEFINED_SNAPSHOT,
  )
}

/**
 * Reactive snapshot of the host plugin registry and Screen contributions (same
 * SSE data source as the plugin center / left sidebar, no polling):
 * - plugins: all plugin summaries, updated live via plugin.changed / snapshot frames;
 * - screens: Screen contributions registered by enabled plugins (including
 *   pluginId); contributions of disabled plugins are removed immediately.
 * Usable outside <PluginUiView> (fullscreen views like the app center have no
 * conversation context and can still call it).
 */
export function usePlugins(): UsePluginsResult {
  const port = usePluginClientHost()
  return useSyncExternalStore(port.subscribePlugins, port.getPluginsSnapshot, port.getPluginsSnapshot)
}

/**
 * Reactive non-secret public configuration of the current plugin, projected
 * from `ctx.configSchema` into `PluginSummary.publicConfig` (excludes all
 * `secret: true` fields; returns a stable frozen `{}` when absent).
 * Must be called inside `<PluginUiView>`.
 */
export function usePluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  const { pluginId } = useRequiredPluginContextBase()
  const port = usePluginClientHost()
  const getConfig = useCallback(
    (): T => (port.getPluginsSnapshot().plugins.find((p) => p.id === pluginId)?.publicConfig ?? EMPTY_PLUGIN_CONFIG) as T,
    [port, pluginId],
  )
  return useSyncExternalStore(port.subscribePlugins, getConfig, getConfig)
}

/** Live per-conversation view returned by useConversation. */
export interface ConversationHookResult {
  /** Conversation summary (undefined until SSE pushes it; never a fabricated placeholder object). */
  summary: ConversationSummary | undefined
  /** Loaded conversation detail (entries etc.); undefined when not loaded. */
  detail: ConversationDetail | undefined
  /** Streaming live view (during working/blocked). */
  live: ConversationLive | undefined
  /** Pending approvals of this conversation. */
  pendingAsks: AskSpec[]
  /** Detail load failure text (host loadErrors[`conversation:<id>`]). */
  loadError: string | undefined
  /** Force-refetch the conversation detail. */
  reload: () => void
}

export interface ConversationHookOptions {
  /**
   * Auto-load conversation detail when missing and no error is recorded (default true).
   * Pass `false` when only `summary` / `live` / `pendingAsks` are needed to avoid eager detail fetches.
   */
  includeDetail?: boolean
  /**
   * Subscribe to streaming live frames (`conversationLives`, default true).
   * Pass `false` when only `summary` / `pendingAsks` / cached `detail` are needed to avoid token-rate re-renders.
   */
  includeLive?: boolean
}

/**
 * Subscribe to a single conversation via keyed `useSyncExternalStore` slices:
 * streaming frames (`conversationLives`) or detail/ask/error changes on other
 * conversations never notify this subscriber.
 *
 * The detail is auto-loaded by default when missing and no failure is recorded,
 * then updated live via SSE. When `options?.includeDetail === false`, auto-loading
 * is skipped while still returning any already-cached `detail` plus `summary`,
 * `live`, `pendingAsks`, `loadError`, and manual `reload`.
 * When `options?.includeLive === false`, live streaming updates are not subscribed
 * and `live` stays `undefined`.
 * When conversationId is undefined (no conversation context), an empty view is
 * returned and no request is made.
 */
export function useConversation(
  conversationId: number | undefined,
  options?: ConversationHookOptions,
): ConversationHookResult {
  const port = usePluginClientHost()
  const includeDetail = options?.includeDetail !== false
  const includeLive = options?.includeLive !== false
  const errorKey = conversationId !== undefined ? `conversation:${conversationId}` : undefined

  const subscribeSummary = useCallback(
    (listener: () => void): (() => void) =>
      conversationId !== undefined ? port.subscribeConversationSummary(conversationId, listener) : NOOP_UNSUBSCRIBE,
    [port, conversationId],
  )
  const getSummary = useCallback(
    (): ConversationSummary | undefined =>
      conversationId !== undefined ? port.getConversationSummary(conversationId) : undefined,
    [port, conversationId],
  )
  const summary = useSyncExternalStore(subscribeSummary, getSummary, getSummary)

  const subscribeDetail = useCallback(
    (listener: () => void): (() => void) =>
      conversationId !== undefined ? port.subscribeConversationDetail(conversationId, listener) : NOOP_UNSUBSCRIBE,
    [port, conversationId],
  )
  const getDetail = useCallback(
    (): ConversationDetail | undefined =>
      conversationId !== undefined ? port.getConversationDetail(conversationId) : undefined,
    [port, conversationId],
  )
  const detail = useSyncExternalStore(subscribeDetail, getDetail, getDetail)

  const subscribeLive = useCallback(
    (listener: () => void): (() => void) =>
      includeLive && conversationId !== undefined ? port.subscribeConversationLive(conversationId, listener) : NOOP_UNSUBSCRIBE,
    [port, includeLive, conversationId],
  )
  const getLive = useCallback(
    (): ConversationLive | undefined =>
      includeLive && conversationId !== undefined ? port.getConversationLive(conversationId) : undefined,
    [port, includeLive, conversationId],
  )
  const live = useSyncExternalStore(subscribeLive, getLive, getLive)

  const subscribePendingAsks = useCallback(
    (listener: () => void): (() => void) =>
      conversationId !== undefined ? port.subscribeConversationPendingAsks(conversationId, listener) : NOOP_UNSUBSCRIBE,
    [port, conversationId],
  )
  const getPendingAsks = useCallback(
    (): AskSpec[] =>
      conversationId !== undefined ? port.getConversationPendingAsks(conversationId) : EMPTY_PENDING_ASKS,
    [port, conversationId],
  )
  const pendingAsks = useSyncExternalStore(subscribePendingAsks, getPendingAsks, getPendingAsks)

  const subscribeError = useCallback(
    (listener: () => void): (() => void) => (errorKey !== undefined ? port.subscribeLoadError(errorKey, listener) : NOOP_UNSUBSCRIBE),
    [port, errorKey],
  )
  const getError = useCallback(
    (): string | undefined => (errorKey !== undefined ? port.getLoadError(errorKey) : undefined),
    [port, errorKey],
  )
  const loadError = useSyncExternalStore(subscribeError, getError, getError)

  const load = port.loadConversationDetail
  useEffect(() => {
    if (includeDetail && conversationId !== undefined && detail === undefined && loadError === undefined) {
      void load(conversationId)
    }
  }, [includeDetail, conversationId, detail, loadError, load])

  const reload = useCallback(() => {
    if (conversationId !== undefined) void load(conversationId, true)
  }, [conversationId, load])

  return { summary, detail, live, pendingAsks, loadError, reload }
}

// ---------------------------------------------------------------------------
// Shared module-level wall-clock ticker (`useSharedNowMs`)
// ---------------------------------------------------------------------------

interface SharedTickerEntry {
  source: PluginClientHostPort | null
  getServerNow: (() => number) | undefined
  notify: (now: number) => void
}

interface SharedTickerBucket {
  entries: Set<SharedTickerEntry>
  timer: ReturnType<typeof setInterval> | undefined
}

const sharedTickers = new Map<number, SharedTickerBucket>()

function normalizeIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 1000
  return Math.max(1, Math.trunc(intervalMs))
}

function sampleSharedNow(
  source: PluginClientHostPort | null,
  getServerNow: (() => number) | undefined,
): number {
  if (getServerNow === undefined) return Date.now()
  try {
    const value = getServerNow.call(source)
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

function subscribeSharedNow(
  intervalMs: number,
  source: PluginClientHostPort | null,
  getServerNow: (() => number) | undefined,
  notify: (now: number) => void,
): () => void {
  let bucket = sharedTickers.get(intervalMs)
  if (!bucket) {
    const entries = new Set<SharedTickerEntry>()
    const timer = globalThis.setInterval?.(() => {
      const samples = new Map<PluginClientHostPort | null, number>()
      for (const entry of [...entries]) {
        const key = entry.getServerNow !== undefined ? entry.source : null
        let now = samples.get(key)
        if (now === undefined) {
          now = sampleSharedNow(entry.source, entry.getServerNow)
          samples.set(key, now)
        }
        entry.notify(now)
      }
    }, intervalMs)
    bucket = { entries, timer }
    sharedTickers.set(intervalMs, bucket)
  }
  const entry: SharedTickerEntry = { source, getServerNow, notify }
  bucket.entries.add(entry)

  let released = false
  return () => {
    if (released) return
    released = true
    const current = sharedTickers.get(intervalMs)
    if (!current) return
    current.entries.delete(entry)
    if (current.entries.size === 0) {
      if (current.timer !== undefined) globalThis.clearInterval?.(current.timer)
      sharedTickers.delete(intervalMs)
    }
  }
}

/**
 * Shared stopwatch clock: returns `undefined` on SSR / initial render and whenever `active` is `false`.
 * On client `useEffect`, when `active` is `true`, immediately samples the optional host `getServerNow()`
 * (safely read from `PluginClientHostContext`, silently falling back to `Date.now()` outside a Provider
 * or when omitted) and subscribes to a single shared `setInterval` bucket per `intervalMs`, tearing down
 * the timer as soon as the last subscriber unmounts or deactivates.
 */
export function useSharedNowMs(active: boolean, intervalMs = 1000): number | undefined {
  const port = useContext(PluginClientHostContext)
  const getServerNow = port?.getServerNow
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  const effectiveIntervalMs = normalizeIntervalMs(intervalMs)

  useEffect(() => {
    if (!active) {
      setNowMs(undefined)
      return
    }
    const source = getServerNow !== undefined ? port : null
    setNowMs(sampleSharedNow(source, getServerNow))
    return subscribeSharedNow(effectiveIntervalMs, source, getServerNow, setNowMs)
  }, [active, effectiveIntervalMs, port, getServerNow])

  return active ? nowMs : undefined
}
