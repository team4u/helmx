import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as HelmxPluginClient from '@helmx/plugin-client'
import { collectDrawerConversationIds } from './drawer-stack-model.js'
import { HelmxExternalStore, type StoreBootLocation } from './helmx-store.js'
import { PluginClientHostBridge } from './plugin-host-bridge.js'
import {
  HelmxExternalStoreContext,
  useActiveModal,
  useAuthenticated,
  useConversationDetail,
  useDrawerStack,
  useHighlightedEntry,
  useLoadError,
  useLocationState,
  useLocationTargets,
  useProfilesSlice,
  useSseConnected,
  useThemePreferencesState,
} from './store-context.js'
import { registerBrowserNotificationNavigator } from './browser-notification.js'
import { applyDocumentLocale } from './theme-preferences.js'
import { formatLocationHash, isSameLocationState, parseLocationHash, readBootLocation, shouldPushLocationHistory } from './url-hash-model.js'
import { useGlobalShortcuts } from './use-global-shortcuts.js'
import { useSseEvents } from './use-sse-events.js'
import { useUnreadSync } from './use-unread-sync.js'

function HomeLandingWatcher({ store }: { store: HelmxExternalStore }) {
  const pendingRef = useRef(true)
  const authenticated = useAuthenticated()
  const { profilesLoaded } = useProfilesSlice()
  const sseConnected = useSseConnected()

  useEffect(() => {
    if (!pendingRef.current) return
    if (!authenticated || !profilesLoaded || !sseConnected) return
    pendingRef.current = false
    store.settleHomeLanding()
  }, [authenticated, profilesLoaded, sseConnected, store])

  return null
}

function HighlightedEntryActiveWatcher({
  store,
  conversationId,
  highlightedEntry,
}: {
  store: HelmxExternalStore
  conversationId: number
  highlightedEntry: { conversationId: number; entryId: string }
}) {
  const detail = useConversationDetail(conversationId)
  const historyError = useLoadError(`history:${conversationId}`)

  useEffect(() => {
    store.navActions.stepHighlightedEntry()
  }, [store, highlightedEntry, detail, historyError])

  return null
}

function HighlightedEntryWatcher({ store }: { store: HelmxExternalStore }) {
  const highlightedEntry = useHighlightedEntry()
  if (highlightedEntry === null) return null
  return (
    <HighlightedEntryActiveWatcher
      store={store}
      conversationId={highlightedEntry.conversationId}
      highlightedEntry={highlightedEntry}
    />
  )
}

function HelmxStoreEffects({ store, boot }: { store: HelmxExternalStore; boot: StoreBootLocation }) {
  const authenticated = useAuthenticated()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const drawerStack = useDrawerStack()
  const activeModal = useActiveModal()
  const locationState = useLocationState()
  const { locale, localePreference } = useThemePreferencesState()

  useEffect(() => {
    applyDocumentLocale(locale)
  }, [locale])

  useEffect(() => {
    if (typeof window === 'undefined' || localePreference !== 'auto') return
    const handler = () => store.handleBrowserLanguageChange()
    window.addEventListener('languagechange', handler)
    return () => window.removeEventListener('languagechange', handler)
  }, [localePreference, store])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => store.handleSystemThemeChange(e.matches)
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [store])

  useEffect(() => {
    if (authenticated) void store.actions.refreshAssets()
  }, [authenticated, store])

  useEffect(() => {
    const nextVisible = new Set<number>()
    if (primaryTarget.kind === 'conversation') nextVisible.add(primaryTarget.conversationId)
    if (splitTarget?.kind === 'conversation') nextVisible.add(splitTarget.conversationId)
    for (const id of collectDrawerConversationIds(drawerStack)) nextVisible.add(id)
    if (activeModal?.kind === 'artifact-preview' || activeModal?.kind === 'workspace-file') {
      if (activeModal.conversationId !== undefined) nextVisible.add(activeModal.conversationId)
    }
    store.requests.syncVisibleConversations(nextVisible)
  }, [primaryTarget, splitTarget, drawerStack, activeModal, store])

  const unreadSync = useUnreadSync({
    store,
    authenticated,
    primaryTarget,
    splitTarget,
    drawerStack,
    activeModal,
  })
  const { resetUnreadSync } = unreadSync

  useEffect(() => {
    void store.checkAuth()
    return () => store.dispose()
  }, [store])

  const logout = useCallback(() => {
    store.prepareLogoutHistoryReset()
    resetUnreadSync()
    // Resets the address bar to the default deep link (replaceState keeps the
    // history stack clean); writes stay disabled while unauthenticated to avoid
    // clobbering a user-pasted deep link.
    window.history.replaceState(null, '', '#/settings/profiles')
    store.finishLogoutStateReset()
  }, [resetUnreadSync, store])
  useEffect(() => store.bindLogout(logout), [store, logout])

  useEffect(() => {
    window.addEventListener('helmx:unauthorized', logout)
    return () => window.removeEventListener('helmx:unauthorized', logout)
  }, [logout])

  useEffect(() => {
    return registerBrowserNotificationNavigator((url) => {
      if (!url.startsWith('/#')) return
      const parsed = parseLocationHash(url.slice(1))
      if (isSameLocationState(parsed, store.lastSyncedLocation)) return
      store.navActions.applyExternalLocation(parsed)
    })
  }, [store])

  useEffect(() => {
    const applyUrlLocation = () => {
      const parsed = parseLocationHash(window.location.hash)
      if (isSameLocationState(parsed, store.lastSyncedLocation)) return
      store.navActions.applyExternalLocation(parsed)
    }
    window.addEventListener('hashchange', applyUrlLocation)
    window.addEventListener('popstate', applyUrlLocation)
    return () => {
      window.removeEventListener('hashchange', applyUrlLocation)
      window.removeEventListener('popstate', applyUrlLocation)
    }
  }, [store])

  useEffect(() => {
    if (!authenticated) return
    const nextHash = formatLocationHash(locationState)
    if (nextHash === window.location.hash) {
      store.lastSyncedLocation = locationState
      store.pendingHistoryMode = null
      return
    }
    const override = store.pendingHistoryMode
    if (override === 'push' || (override === null && shouldPushLocationHistory(store.lastSyncedLocation, locationState))) {
      window.history.pushState(null, '', nextHash)
    } else {
      window.history.replaceState(null, '', nextHash)
    }
    store.pendingHistoryMode = null
    store.lastSyncedLocation = locationState
  }, [authenticated, locationState, store])

  useGlobalShortcuts(store)

  useSseEvents({
    store,
    authenticated,
    logout,
    unreadSync,
  })

  return (
    <>
      {boot.needsHomeLanding ? <HomeLandingWatcher store={store} /> : null}
      <HighlightedEntryWatcher store={store} />
    </>
  )
}

export function HelmxStoreProvider({
  children,
  escAbortWindowMs,
}: {
  children: React.ReactNode
  escAbortWindowMs?: number
}) {
  const [boot] = useState<StoreBootLocation>(readBootLocation)

  const [store] = useState(
    () =>
      new HelmxExternalStore(boot.location, {
        needsHomeLanding: boot.needsHomeLanding,
        ...(escAbortWindowMs !== undefined ? { escAbortWindowMs } : {}),
      }),
  )

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__helmx_shared_react = React
    w.__helmx_shared_react_dom = ReactDom
    w.__helmx_shared_react_dom_client = ReactDomClient
    w.__helmx_shared_react_jsx_runtime = ReactJsxRuntime
    w.__helmx_shared_plugin_client = HelmxPluginClient
    return () => {
      delete w.__helmx_shared_react
      delete w.__helmx_shared_react_dom
      delete w.__helmx_shared_react_dom_client
      delete w.__helmx_shared_react_jsx_runtime
      delete w.__helmx_shared_lucide_react
      delete w.__helmx_shared_plugin_client
    }
  }, [])

  return (
    <HelmxExternalStoreContext.Provider value={store}>
      <HelmxStoreEffects store={store} boot={boot} />
      <PluginClientHostBridge store={store}>{children}</PluginClientHostBridge>
    </HelmxExternalStoreContext.Provider>
  )
}
