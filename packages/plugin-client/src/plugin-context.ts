/**
 * Host context for plugin client.tsx components (return value of
 * usePluginContext) and the context factory.
 *
 * - PluginClientContext / usePluginContext: current plugin identity and
 *   conversation capabilities inside plugin components;
 * - createPluginClientContext: the host PluginUiView builds the plugin-ID-bound
 *   context implementation from the host port (callAction addresses across
 *   plugins, submitInput explicitly rejects without a conversation, navigation
 *   and notifications forward to the real host port, no mocks).
 *
 * No component exports in this file (Fast Refresh friendly).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import {
  DEFAULT_HELMX_LOCALE,
  createLocaleTranslator,
  type ComposerController,
  type HelmxLocale,
  type PluginClientContext as PluginClientContextType,
} from '@helmx/protocol/browser'
import type { PluginClientHostPort } from './host-port.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

const NOOP_UNSUBSCRIBE = (): void => {}
const contextHostPorts = new WeakMap<PluginClientContextType, PluginClientHostPort>()

/** Internal SDK helper: returns the stable host port when `ctx` was built via `createPluginClientContext`. */
export function getContextBoundHostPort(ctx: PluginClientContextType | null): PluginClientHostPort | undefined {
  return ctx !== null ? contextHostPorts.get(ctx) : undefined
}

/**
 * Internal SDK helper: reads the raw PluginClientContext identity/action surface
 * without subscribing to theme/locale prefs (used by data-only hooks like
 * `usePluginDoc`, `usePluginSessionDoc`, and `usePluginConfig` that only need
 * `ctx.pluginId` / `ctx.conversationId`).
 */
export function useRequiredPluginContextBase(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext must be called inside a plugin component rendered by <PluginUiView>')
  }
  return ctx
}

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  const boundPort = getContextBoundHostPort(ctx)
  const subscribePrefs = useCallback(
    (listener: () => void): (() => void) => (boundPort !== undefined ? boundPort.subscribePrefs(listener) : NOOP_UNSUBSCRIBE),
    [boundPort],
  )
  const getTheme = useCallback(
    (): 'light' | 'dark' => (boundPort !== undefined ? boundPort.getTheme() : (ctx?.theme ?? 'dark')),
    [boundPort, ctx],
  )
  const getLocale = useCallback(
    (): HelmxLocale =>
      boundPort !== undefined
        ? (boundPort.getLocale?.() ?? DEFAULT_HELMX_LOCALE)
        : (ctx?.locale ?? DEFAULT_HELMX_LOCALE),
    [boundPort, ctx],
  )
  const theme = useSyncExternalStore(subscribePrefs, getTheme, getTheme)
  const locale = useSyncExternalStore(subscribePrefs, getLocale, getLocale)

  const resolved = useMemo<PluginClientContextType | null>(() => {
    if (ctx === null) return null
    if (boundPort === undefined || (ctx.theme === theme && ctx.locale === locale)) return ctx
    return {
      ...ctx,
      theme,
      locale,
      translate: boundPort.getTranslate?.() ?? createLocaleTranslator(locale),
    }
  }, [ctx, boundPort, theme, locale])

  if (resolved === null) {
    throw new Error('usePluginContext must be called inside a plugin component rendered by <PluginUiView>')
  }
  return resolved
}

/** Validates a conversation ID as a positive safe integer (aligned with the kernel boundary); throws an explicit error otherwise. */
function assertConversationId(id: number, label: string): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive integer (received ${String(id)})`)
  }
}

const BUILTIN_WORKBENCH_TABS = new Set(['artifacts', 'files'])

/**
 * Resolves a plugin-facing workbench panel argument into the host workbench tab key:
 * - empty / undefined -> undefined (open drawer without forcing a tab switch);
 * - built-in host tabs (`'artifacts'`, `'files'`) or explicit `'plugin:...'` -> unchanged;
 * - short local panel ID (e.g. `'tasks'`, `'groups'`) -> `plugin:${pluginId}/${panelId}`.
 */
export function resolveWorkbenchPanelTabId(pluginId: string, panelId?: string): string | undefined {
  if (panelId === undefined) return undefined
  const trimmed = panelId.trim()
  if (trimmed === '') return undefined
  if (BUILTIN_WORKBENCH_TABS.has(trimmed) || trimmed.startsWith('plugin:')) return trimmed
  return `plugin:${pluginId}/${trimmed}`
}

/**
 * Build the plugin-ID-bound context implementation from the host port (used
 * internally by the host PluginUiView).
 * - callAction's third argument supports cross-plugin addressing (pluginId)
 *   and conversation association (conversationId);
 * - submitInput submits input to the real conversation through the host port
 *   and explicitly rejects when there is no conversation;
 * - getPluginDoc's second argument reads other plugins' public docs;
 * - locale/translate bind the host port locale (falling back to
 *   DEFAULT_HELMX_LOCALE / a derived translator when the host has not wired
 *   them yet) so plugin components can resolve LocalizedText display copy;
 * - composer is passed through only when the host provides it (composer slots).
 */
export function createPluginClientContext(
  port: PluginClientHostPort,
  pluginId: string,
  conversationId: number | undefined,
  composer?: ComposerController,
): PluginClientContextType {
  const locale = port.getLocale?.() ?? DEFAULT_HELMX_LOCALE
  const ctx: PluginClientContextType = {
    pluginId,
    callAction: (actionId, input, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      if (options?.conversationId !== undefined) assertConversationId(options.conversationId, 'options.conversationId')
      return port.invokePluginAction(
        targetPlugin,
        actionId,
        input,
        options?.conversationId ?? conversationId,
      )
    },
    submitInput: async (text, options) => {
      const target = options?.conversationId ?? conversationId
      if (target === undefined) {
        throw new Error('submitInput has no target conversation: the current slot has no conversation context and options.conversationId was not given')
      }
      assertConversationId(target, 'conversationId')
      await port.submitConversationInput(target, {
        text,
        origin: 'agent',
        ...(options?.whenBusy !== undefined ? { whenBusy: options.whenBusy } : {}),
      })
    },
    openScreen: (target) => port.openTarget(target),
    openSplitScreen: (target) => port.openTarget(target, { split: true }),
    openConversationDrawer: (targetConversationId) => port.openConversationDrawer(targetConversationId),
    openArtifact: (artifactId) => port.openArtifactPreview(artifactId, conversationId),
    openWorkbench: (panelId, params) => {
      const resolvedTab = resolveWorkbenchPanelTabId(pluginId, panelId)
      if (port.openWorkbench !== undefined) {
        port.openWorkbench({
          ...(resolvedTab !== undefined ? { tab: resolvedTab } : {}),
          ...(conversationId !== undefined ? { conversationId } : {}),
          ...(params !== undefined ? { params } : {}),
        })
        return
      }
      port.setWorkbenchOpen(true)
      if (resolvedTab !== undefined) port.setWorkbenchTab(resolvedTab)
    },
    closeWorkbench: () => port.setWorkbenchOpen(false),
    notify: (message, tone = 'info') => port.notify(message, tone, conversationId),
    getPluginDoc: (docName, pluginId2) => port.ensurePluginDoc(pluginId2 ?? pluginId, docName),
    getPluginSessionDoc: (docName, options) => {
      const targetPlugin = options?.pluginId ?? pluginId
      const target = options?.conversationId ?? conversationId
      if (target === undefined) {
        return Promise.reject(new Error('getPluginSessionDoc has no target conversation: the current slot has no conversation context and options.conversationId was not given'))
      }
      assertConversationId(target, 'conversationId')
      return port.getPluginSessionDoc(targetPlugin, docName, target)
    },
    ...(composer !== undefined ? { composer } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: port.getTheme(),
    locale,
    translate: port.getTranslate?.() ?? createLocaleTranslator(locale),
  }
  contextHostPorts.set(ctx, port)
  return ctx
}
