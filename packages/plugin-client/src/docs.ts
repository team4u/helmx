/**
 * Reactive subscription hooks for plugin public docs / session-level docs
 * (host-port driven).
 *
 * - Plugin-facing (PLUGIN_CLIENT_SHARED_EXPORTS contract names):
 *   usePluginDocState(docName, pluginId?) / usePluginDoc(docName, pluginId?) /
 *   usePluginSessionDocState(docName, conversationIdOrOptions?) /
 *   usePluginSessionDoc(docName, options?) —
 *   must be called from plugin components inside <PluginUiView>;
 * - Host-facing (explicit addressing, no plugin context needed):
 *   usePluginDocValueState / usePluginDocValue /
 *   usePluginSessionDocDiagnostics / usePluginSessionDocValue —
 *   let host components and tests reuse the same implementation.
 *
 * Public docs subscribe per `${pluginId}/${docName}` key (and `doc:${pluginId}/${docName}`
 * load error) via `useSyncExternalStore`; session-level subscriptions use a dedicated SSE
 * stream keyed by `(pluginId, docName, conversationId)` (ref-count shared; a connection is
 * opened only while a mounted reference exists), with no global events.
 * No component exports in this file (Fast Refresh friendly).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PluginDocLoadStatus, PluginDocState } from '@helmx/protocol/browser'
import type { PluginSessionDocKey, PluginSessionDocState } from './host-port.js'
import { usePluginClientHost } from './host-port.js'
import { useRequiredPluginContextBase } from './plugin-context.js'

export type { PluginDocLoadStatus, PluginDocState }

/** Second-argument shorthand for `usePluginSessionDocState`: numeric conversationId or explicit options object. */
export type PluginSessionDocOptions = number | { conversationId?: number; pluginId?: string }

// ---------------------------------------------------------------------------
// Public doc: automatic GET on first access, then live updates via SSE plugin.doc.updated
// ---------------------------------------------------------------------------

/** Subscribe to a plugin public doc with honest loading / ready / error state and manual retry (explicit addressing). */
export function usePluginDocValueState<T = unknown>(pluginId: string, docName: string): PluginDocState<T> {
  const port = usePluginClientHost()
  const docKey = `${pluginId}/${docName}`
  const errorKey = `doc:${docKey}`

  const subscribeDoc = useCallback(
    (listener: () => void) => port.subscribePluginDoc(docKey, listener),
    [port, docKey],
  )
  const getDocSnapshot = useCallback(
    (): T | undefined => port.getPluginDocValue(docKey) as T | undefined,
    [port, docKey],
  )
  const getHasDocSnapshot = useCallback(
    (): boolean => (port.hasPluginDoc !== undefined ? port.hasPluginDoc(docKey) : port.getPluginDocValue(docKey) !== undefined),
    [port, docKey],
  )
  const subscribeError = useCallback(
    (listener: () => void) => port.subscribeLoadError(errorKey, listener),
    [port, errorKey],
  )
  const getErrorSnapshot = useCallback(
    (): string | undefined => port.getLoadError(errorKey),
    [port, errorKey],
  )

  const value = useSyncExternalStore(subscribeDoc, getDocSnapshot, getDocSnapshot)
  const hasDoc = useSyncExternalStore(subscribeDoc, getHasDocSnapshot, getHasDocSnapshot)
  const error = useSyncExternalStore(subscribeError, getErrorSnapshot, getErrorSnapshot)
  const authenticated = useSyncExternalStore(
    port.subscribeAuthenticated,
    port.getAuthenticated,
    port.getAuthenticated,
  )

  const { ensurePluginDoc } = port
  useEffect(() => {
    if (!hasDoc && error === undefined && authenticated) {
      void ensurePluginDoc(pluginId, docName)
    }
  }, [pluginId, docName, hasDoc, error, authenticated, ensurePluginDoc])

  const retry = useCallback((): void => {
    if (port.retryPluginDoc !== undefined) {
      void port.retryPluginDoc(pluginId, docName)
    } else {
      void port.ensurePluginDoc(pluginId, docName)
    }
  }, [port, pluginId, docName])

  return useMemo<PluginDocState<T>>(() => {
    const status: PluginDocLoadStatus = error !== undefined ? 'error' : hasDoc ? 'ready' : 'loading'
    return {
      data: hasDoc ? value : undefined,
      status,
      ...(error !== undefined ? { error } : {}),
      retry,
    }
  }, [hasDoc, value, error, retry])
}

/** Subscribe to a plugin's public doc value (explicit addressing; use usePluginDoc inside plugin components). */
export function usePluginDocValue<T = unknown>(pluginId: string, docName: string): T | undefined {
  return usePluginDocValueState<T>(pluginId, docName).data
}

/**
 * Reactively subscribe to a public doc's `{ data, status, error?, retry }` state:
 * when `pluginId` is omitted, `ctx.pluginId` is used; when passed, another plugin's
 * public doc is subscribed (cross-plugin addressing).
 * Must be called from plugin components inside `<PluginUiView>`.
 */
export function usePluginDocState<T = unknown>(docName: string, pluginId?: string): PluginDocState<T> {
  const ctx = useRequiredPluginContextBase()
  return usePluginDocValueState<T>(pluginId ?? ctx.pluginId, docName)
}

/**
 * Reactively subscribe to a public doc value (thin wrapper over `usePluginDocState`):
 * when `pluginId` is omitted, `ctx.pluginId` is used; when passed, another plugin's
 * public doc is subscribed (cross-plugin addressing).
 * Must be called from plugin components inside `<PluginUiView>`.
 */
export function usePluginDoc<T = unknown>(docName: string, pluginId?: string): T | undefined {
  return usePluginDocState<T>(docName, pluginId).data
}

// ---------------------------------------------------------------------------
// Session-level public doc (sessionDoc): dedicated tuple-keyed SSE stream, ref-count shared
// ---------------------------------------------------------------------------

const EMPTY_SESSION_DOC: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }

/** Host-facing low-level diagnostic snapshot (error / connection status / deleted flag): for explicit display, never silently degraded. */
export function usePluginSessionDocDiagnostics(
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

/** Subscribe to the value (explicit addressing): delete frames carry value=initial per protocol (reset semantics); missing / uninitialized / errored returns undefined. */
export function usePluginSessionDocValue<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const state = usePluginSessionDocDiagnostics(docName, options)
  if (!state.hasValue || state.error !== undefined) return undefined
  return state.value as T | undefined
}

/**
 * Reactively subscribe to a conversation-scoped session doc's `{ data, status, error?, retry }` state:
 * - accepts an optional `conversationId` number OR `{ conversationId?, pluginId? }` options;
 * - inherits `ctx.pluginId` and `ctx.conversationId` when omitted;
 * - when no conversation context exists (or `docName` is empty), opens no stream and returns
 *   `{ data: undefined, status: 'ready', retry }`;
 * - `retry()` clears subscription error state and immediately reconnects the multiplexed stream.
 * Must be called from plugin components inside `<PluginUiView>`.
 */
export function usePluginSessionDocState<T = unknown>(
  docName: string,
  conversationIdOrOptions?: PluginSessionDocOptions,
): PluginDocState<T> {
  const ctx = useRequiredPluginContextBase()
  const port = usePluginClientHost()
  const pluginId =
    typeof conversationIdOrOptions === 'object' && conversationIdOrOptions !== null
      ? (conversationIdOrOptions.pluginId ?? ctx.pluginId)
      : ctx.pluginId
  const conversationId =
    typeof conversationIdOrOptions === 'number'
      ? conversationIdOrOptions
      : typeof conversationIdOrOptions === 'object' && conversationIdOrOptions !== null
        ? (conversationIdOrOptions.conversationId ?? ctx.conversationId)
        : ctx.conversationId
  const hasTarget = conversationId !== undefined && docName !== ''
  const raw = usePluginSessionDocDiagnostics(docName, {
    pluginId,
    ...(conversationId !== undefined ? { conversationId } : {}),
  })
  const retry = useCallback((): void => {
    if (!hasTarget) return
    port.retrySessionDoc?.({ pluginId, docName, conversationId })
  }, [hasTarget, port, pluginId, docName, conversationId])

  return useMemo<PluginDocState<T>>(() => {
    if (!hasTarget) {
      return { data: undefined, status: 'ready', retry }
    }
    if (raw.error !== undefined) {
      return { data: undefined, status: 'error', error: raw.error, retry }
    }
    if (raw.hasValue) {
      return { data: raw.value as T | undefined, status: 'ready', retry }
    }
    return { data: undefined, status: 'loading', retry }
  }, [hasTarget, raw.error, raw.hasValue, raw.value, retry])
}

/**
 * Reactively subscribe to a session-level public doc value (thin wrapper over `usePluginSessionDocState`):
 * when `pluginId` is omitted, `ctx.pluginId` is used; when `conversationId` is omitted, the
 * surrounding slot's `ctx.conversationId` is inherited; when both are missing there is no
 * conversation context — returns `undefined` and opens no subscription.
 * Must be called from plugin components inside `<PluginUiView>`.
 */
export function usePluginSessionDoc<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  return usePluginSessionDocState<T>(docName, options).data
}
