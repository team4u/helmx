/**
 * Reactive subscription hooks for plugin public docs / session-level docs
 * (host-port driven).
 *
 * - Plugin-facing (PLUGIN_CLIENT_SHARED_EXPORTS contract names):
 *   usePluginDoc(docName, pluginId?) / usePluginSessionDoc(docName, options?) —
 *   must be called from plugin components inside <PluginUiView>;
 * - Host-facing (explicit addressing, no plugin context needed):
 *   usePluginDocValue / usePluginSessionDocState / usePluginSessionDocValue —
 *   let host components and debug handles reuse the same implementation.
 *
 * Public docs subscribe per `${pluginId}/${docName}` key via `useSyncExternalStore`
 * (updates to unrelated docs or streaming conversation frames never wake consumers);
 * session-level subscriptions use a dedicated SSE stream keyed by the
 * (pluginId, docName, conversationId) tuple (ref-count shared; a connection is
 * opened only while a mounted reference exists), with no global events.
 * No component exports in this file (Fast Refresh friendly).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PluginSessionDocKey, PluginSessionDocState } from './host-port.js'
import { usePluginClientHost } from './host-port.js'
import { useRequiredPluginContextBase } from './plugin-context.js'

// ---------------------------------------------------------------------------
// Public doc: automatic GET on first access, then live updates via SSE plugin.doc.updated
// ---------------------------------------------------------------------------

/** Subscribe to a plugin's public doc (explicit addressing; use usePluginDoc inside plugin components). */
export function usePluginDocValue<T = unknown>(pluginId: string, docName: string): T | undefined {
  const port = usePluginClientHost()
  const docKey = `${pluginId}/${docName}`
  const subscribeDoc = useCallback(
    (listener: () => void) => port.subscribePluginDoc(docKey, listener),
    [port, docKey],
  )
  const getDocSnapshot = useCallback(
    (): T | undefined => port.getPluginDocValue(docKey) as T | undefined,
    [port, docKey],
  )
  const value = useSyncExternalStore(subscribeDoc, getDocSnapshot, getDocSnapshot)
  const authenticated = useSyncExternalStore(
    port.subscribeAuthenticated,
    port.getAuthenticated,
    port.getAuthenticated,
  )

  const { ensurePluginDoc } = port
  useEffect(() => {
    if (value === undefined && authenticated) void ensurePluginDoc(pluginId, docName)
  }, [pluginId, docName, value, authenticated, ensurePluginDoc])

  return value
}

/**
 * Reactively subscribe to a public doc: when pluginId is omitted, the current
 * ctx.pluginId (this plugin) is used; when passed, the public doc of another
 * plugin is subscribed (cross-plugin addressing).
 * Must be called from plugin components inside <PluginUiView>.
 */
export function usePluginDoc<T = unknown>(docName: string, pluginId?: string): T | undefined {
  const ctx = useRequiredPluginContextBase()
  return usePluginDocValue<T>(pluginId ?? ctx.pluginId, docName)
}

// ---------------------------------------------------------------------------
// Session-level public doc (sessionDoc): dedicated tuple-keyed SSE stream, ref-count shared
// ---------------------------------------------------------------------------

const EMPTY_SESSION_DOC: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }

/** Subscribe to the diagnostic state (error / connection status / deleted flag): for explicit display, never silently degraded. */
export function usePluginSessionDocState(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): PluginSessionDocState {
  const port = usePluginClientHost()
  const { subscribeSessionDoc, getSessionDocState } = port
  const pluginId = options?.pluginId
  const conversationId = options?.conversationId
  const key = useMemo<PluginSessionDocKey | null>(
    () => (pluginId !== undefined && conversationId !== undefined && docName !== '' ? { pluginId, docName, conversationId } : null),
    [pluginId, docName, conversationId],
  )
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : subscribeSessionDoc(key, listener)),
    [subscribeSessionDoc, key],
  )
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY_SESSION_DOC : getSessionDocState(key)),
    () => EMPTY_SESSION_DOC,
  )
}

/** Subscribe to the value: a delete frame (deleted=true) carries value=initial per protocol (reset semantics) and is returned as-is; missing / uninitialized / errored returns undefined. */
export function usePluginSessionDocValue<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const state = usePluginSessionDocState(docName, options)
  if (!state.hasValue || state.error !== undefined) return undefined
  return state.value as T | undefined
}

/**
 * Reactively subscribe to a session-level public doc: when pluginId is omitted,
 * the current ctx.pluginId is used; when conversationId is omitted, the
 * surrounding slot's ctx.conversationId is inherited; when both are missing
 * there is no conversation context — return undefined and open no subscription.
 * Must be called from plugin components inside <PluginUiView>.
 */
export function usePluginSessionDoc<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const ctx = useRequiredPluginContextBase()
  return usePluginSessionDocValue<T>(docName, {
    pluginId: options?.pluginId ?? ctx.pluginId,
    conversationId: options?.conversationId ?? ctx.conversationId,
  })
}
