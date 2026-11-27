import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmxLocale,
  NodeInfo,
  PluginSummary,
  Profile,
  ProviderConfig,
  SkillSummary,
} from '@helmx/protocol/browser'
import type { ModelCatalogDefaults, ModelDescriptor } from './api.js'
import { isPluginSummaryActive } from './live-state.js'
import type {
  AuthSlice,
  CatalogSlice,
  ConversationBackgroundSlice,
  HelmxExternalStore,
  HelmxStoreActions,
  LocationTargetsSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  StoreDomainKey,
  WorkbenchParamsState,
  WorkbenchSlice,
} from './helmx-store.js'
import type { SessionDocKey } from './session-docs.js'
import type {
  ActiveModal,
  DrawerFrame,
  GroupedUiSpecs,
  HelmxStoreValue,
  ResolvedTarget,
  ToastNotice,
} from './types.js'
import type { WorkspaceLocationState } from './url-hash-model.js'
import type { WorkspaceConversationNode } from '../conversation/workspace-file-url.js'

export const HelmxExternalStoreContext = createContext<HelmxExternalStore | null>(null)

const UNSET = Symbol('helmx-store-unset')
const NOOP_UNSUBSCRIBE = () => {}
const EMPTY_TREE_WORKSPACES: ReadonlyArray<WorkspaceConversationNode> = Object.freeze([])

function subscribeLiveById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationLive(id, listener)
}
function readLiveById(store: HelmxExternalStore, id: number): ConversationLive | undefined {
  return store.getConversationLive(id)
}

function subscribeDetailById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationDetail(id, listener)
}
function readDetailById(store: HelmxExternalStore, id: number): ConversationDetail | undefined {
  return store.getConversationDetail(id)
}

function subscribeSummaryById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationSummary(id, listener)
}
function readSummaryById(store: HelmxExternalStore, id: number): ConversationSummary | undefined {
  return store.getConversationSummary(id)
}

function subscribeArtifactsById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeConversationArtifacts(id, listener)
}
function readArtifactsById(store: HelmxExternalStore, id: number): ArtifactMetadata[] | undefined {
  return store.getConversationArtifacts(id)
}

function subscribeHighlightById(store: HelmxExternalStore, id: number, listener: () => void): () => void {
  return store.subscribeHighlightForConversation(id, listener)
}
function readHighlightById(store: HelmxExternalStore, id: number): { conversationId: number; entryId: string } | null {
  return store.getHighlightedEntryForConversation(id)
}

function subscribeLoadErrorKey(store: HelmxExternalStore, key: string, listener: () => void): () => void {
  return store.subscribeLoadError(key, listener)
}
function readLoadErrorKey(store: HelmxExternalStore, key: string): string | undefined {
  return store.getLoadError(key)
}

function subscribePluginDocKey(store: HelmxExternalStore, docKey: string, listener: () => void): () => void {
  return store.subscribePluginDoc(docKey, listener)
}
function readPluginDocKey(store: HelmxExternalStore, docKey: string): unknown {
  return store.getPluginDoc(docKey)
}

function subscribePluginById(store: HelmxExternalStore, pluginId: string, listener: () => void): () => void {
  return store.subscribePlugin(pluginId, listener)
}
function readPluginById(store: HelmxExternalStore, pluginId: string): PluginSummary | undefined {
  return store.getPluginSummary(pluginId)
}

function useDomainSlice<T>(
  domain: StoreDomainKey,
  fromExternal: (store: HelmxExternalStore) => T,
  fallback?: () => T,
): T {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) => (external !== null ? external.subscribeDomain(domain, listener) : NOOP_UNSUBSCRIBE),
    [external, domain],
  )
  const getSnapshot = (): T | typeof UNSET => (external !== null ? fromExternal(external) : UNSET)
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  if (fallback !== undefined) return fallback()
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

function useKeyedSlice<K, T>(
  subscribeForKey: (store: HelmxExternalStore, key: K, listener: () => void) => () => void,
  fromExternal: (store: HelmxExternalStore, key: K) => T,
  key: K | undefined,
  emptyValue: T,
): T {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && key !== undefined ? subscribeForKey(external, key, listener) : NOOP_UNSUBSCRIBE,
    [external, subscribeForKey, key],
  )
  const getSnapshot = (): T | typeof UNSET =>
    external !== null ? (key !== undefined ? fromExternal(external, key) : emptyValue) : UNSET
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

/**
 * Full store snapshot hook (coarse consumers; subscribes to all domains, so
 * production components should prefer sliced hooks below).
 */
export function useHelmxStore(): HelmxStoreValue {
  return useDomainSlice('all', (s) => s.getSnapshot())
}

/** Stable store action bundle (never triggers re-renders inside <HelmxStoreProvider>). */
export function useStoreActions(): HelmxStoreActions {
  const external = useContext(HelmxExternalStoreContext)
  if (external !== null) return external.actions
  throw new Error('useStoreActions must be called inside <HelmxStoreProvider>')
}

export function useOptionalStoreActions(): HelmxStoreActions | null {
  return useContext(HelmxExternalStoreContext)?.actions ?? null
}

/** Direct imperative reference to external store (for event handlers that read without subscribing). */
export function useHelmxExternalStore(): HelmxExternalStore | null {
  return useContext(HelmxExternalStoreContext)
}

// ---- Narrow Domain Hooks --------------------------------------------------

export function useAuthConnection(): AuthSlice {
  return useDomainSlice('auth', (s) => s.getAuthSlice())
}

export function useAuthenticated(): boolean {
  return useDomainSlice('authenticated', (s) => s.getAuthenticated())
}

export function useSseConnected(): boolean {
  return useDomainSlice('sseConnected', (s) => s.getSseConnected())
}

export function useThemePreferencesState(): PrefsSlice {
  return useDomainSlice('prefs', (s) => s.getPrefsSlice())
}

export function useOptionalLocale(): HelmxLocale | undefined {
  return useDomainSlice('locale', (s) => s.getLocale(), () => undefined)
}

export function useProfilesSlice(): ProfilesSlice {
  return useDomainSlice('profiles', (s) => s.getProfilesSlice())
}

/** Profile list for surfaces that also render outside the store provider (SSR/plugin config form): undefined = catalog not provided. */
export function useOptionalProfiles(): Profile[] | undefined {
  return useDomainSlice('profiles', (s) => s.getProfilesSlice().profiles, () => undefined)
}

export function useCatalogAssets(): CatalogSlice {
  return useDomainSlice('catalog', (s) => s.getCatalogSlice())
}

export function useModels(): ModelDescriptor[] {
  return useDomainSlice('models', (s) => s.getModels())
}

export function useModelDefaults(): ModelCatalogDefaults {
  return useDomainSlice('models', (s) => s.getModelDefaults())
}

export function useOptionalModels(): ModelDescriptor[] | undefined {
  return useDomainSlice('models', (s) => s.getModels(), () => undefined)
}

export function useProviders(): ProviderConfig[] {
  return useDomainSlice('providers', (s) => s.getProviders())
}

export function useCredentials(): CredentialSummary[] {
  return useDomainSlice('credentials', (s) => s.getCredentials())
}

export function useSkills(): SkillSummary[] {
  return useDomainSlice('skills', (s) => s.getSkills())
}

export function useCatalogActions(enabled = true): ActionManifest[] {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && enabled ? external.subscribeDomain('actions', listener) : NOOP_UNSUBSCRIBE,
    [external, enabled],
  )
  const getSnapshot = (): ActionManifest[] | typeof UNSET =>
    external !== null ? (enabled ? external.getActionsList() : EMPTY_ACTIONS_LIST) : UNSET
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

const EMPTY_ACTIONS_LIST: ActionManifest[] = []

export function useConversations(): ConversationSummary[] {
  return useDomainSlice('conversations', (s) => s.getConversations())
}

export function useOptionalConversations(): ConversationSummary[] | undefined {
  return useDomainSlice('conversations', (s) => s.getConversations(), () => undefined)
}

export function usePendingAsks(): AskSpec[] {
  return useDomainSlice('pendingAsks', (s) => s.getPendingAsks())
}

export function usePlugins(): PluginSummary[] {
  return useDomainSlice('plugins', (s) => s.getPlugins())
}

export function useOptionalPlugins(): PluginSummary[] | undefined {
  return useDomainSlice('plugins', (s) => s.getPlugins(), () => undefined)
}

export function useGroupedUi(): GroupedUiSpecs {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi())
}

export function useOptionalGroupedUi(): GroupedUiSpecs | undefined {
  return useDomainSlice('groupedUi', (s) => s.getGroupedUi(), () => undefined)
}

export function usePluginsUi(): PluginsUiSlice {
  return useDomainSlice('pluginsUi', (s) => s.getPluginsUiSlice())
}

export function useNodes(): NodeInfo[] {
  return useDomainSlice('nodes', (s) => s.getNodes())
}

/** Nodes slice for surfaces that also render outside the store provider (SSR/plugin config form): undefined = catalog not provided. */
export function useOptionalNodes(): NodeInfo[] | undefined {
  return useDomainSlice('nodes', (s) => s.getNodes(), () => undefined)
}

export function useLoadErrorsMap(): Record<string, string> {
  return useDomainSlice('loadErrorsMap', (s) => s.getLoadErrorsMap())
}

export function usePluginDocsState(): Record<string, unknown> {
  return useDomainSlice('pluginDocsMap', (s) => s.getPluginDocsMap())
}

const EMPTY_PLUGIN_DOCS_SUBSET: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_LOAD_ERRORS_SUBSET: Readonly<Record<string, string>> = Object.freeze({})

interface KeyedSubsetCache<T> {
  keys: string
  map: Readonly<Record<string, T>>
}

/**
 * 按键集合订阅的通用子集 Hook：只注册给定 key 的监听（空集合零监听），
 * 快照按键读取并经 `cacheSame` 复用上一份引用，避免无关更新触发重渲染。
 */
function useKeyedSubsetMap<T>(
  subscribeKey: (store: HelmxExternalStore, key: string, listener: () => void) => () => void,
  readKey: (store: HelmxExternalStore, key: string) => T | undefined,
  keys: ReadonlyArray<string>,
  emptyMap: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  const external = useContext(HelmxExternalStoreContext)
  const serializedKeys = keys.length === 0 ? '' : JSON.stringify([...new Set(keys)].sort())
  const cacheRef = useRef<KeyedSubsetCache<T>>({ keys: '', map: emptyMap })
  const subscribe = useCallback(
    (listener: () => void) => {
      if (external === null || serializedKeys === '') return NOOP_UNSUBSCRIBE
      const unsubs = (JSON.parse(serializedKeys) as string[]).map((key) => subscribeKey(external, key, listener))
      return () => {
        for (const off of unsubs) off()
      }
    },
    [external, serializedKeys, subscribeKey],
  )
  const getSnapshot = (): Readonly<Record<string, T>> | typeof UNSET => {
    if (external === null) return UNSET
    if (serializedKeys === '') return emptyMap
    const next: Record<string, T> = {}
    for (const key of JSON.parse(serializedKeys) as string[]) {
      const value = readKey(external, key)
      if (value !== undefined) next[key] = value
    }
    const prev = cacheRef.current
    if (prev.keys === serializedKeys && cacheSame(prev.map, next)) {
      return prev.map
    }
    cacheRef.current = { keys: serializedKeys, map: next }
    return next
  }
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

/**
 * Subscribe only to the specified `pluginId/docName` keys rather than the global `pluginDocsMap` domain.
 * Registers zero store listeners when `docKeys` is empty.
 */
export function usePluginDocsSubset(docKeys: ReadonlyArray<string>): Readonly<Record<string, unknown>> {
  return useKeyedSubsetMap(
    subscribePluginDocKey,
    (store, key) => (store.hasPluginDoc(key) ? store.getPluginDoc(key) : undefined),
    docKeys,
    EMPTY_PLUGIN_DOCS_SUBSET,
  )
}

/**
 * Subscribe only to the specified `loadErrors` keys (e.g. `doc:pluginId/docName`) rather than all load errors.
 * Registers zero store listeners when `errorKeys` is empty.
 */
export function useLoadErrorsSubset(errorKeys: ReadonlyArray<string>): Readonly<Record<string, string>> {
  return useKeyedSubsetMap(subscribeLoadErrorKey, readLoadErrorKey, errorKeys, EMPTY_LOAD_ERRORS_SUBSET)
}

export function useConversationDetailsMap(): Record<number, ConversationDetail> {
  return useDomainSlice('conversationDetailsMap', (s) => s.getConversationDetailsMap())
}

export function useLocationTargets(): LocationTargetsSlice {
  return useDomainSlice('locationTargets', (s) => s.getLocationTargetsSlice())
}

export function usePrimaryTarget(): ResolvedTarget {
  return useDomainSlice('primaryTarget', (s) => s.getPrimaryTarget())
}

export function useSplitTarget(): ResolvedTarget | null {
  return useDomainSlice('splitTarget', (s) => s.getSplitTarget())
}

export function useSidebarCollapsed(): boolean {
  return useDomainSlice('sidebarCollapsed', (s) => s.getSidebarCollapsed())
}

export function useDrawerStack(): DrawerFrame[] {
  return useDomainSlice('drawerStack', (s) => s.getDrawerStack())
}

export function useWorkbenchState(): WorkbenchSlice {
  return useDomainSlice('workbench', (s) => s.getWorkbenchSlice())
}

export function useActiveModal(): ActiveModal {
  return useDomainSlice('activeModal', (s) => s.getActiveModal())
}

export function useLocationState(): WorkspaceLocationState {
  return useDomainSlice('locationState', (s) => s.getLocationState())
}

export function useHighlightedEntry(): { conversationId: number; entryId: string } | null {
  return useDomainSlice('highlightedEntry', (s) => s.getHighlightedEntry())
}

export function useHomeLandingPending(): boolean {
  return useDomainSlice('homeLanding', (s) => s.getHomeLandingPending())
}

export function useNotices(): ToastNotice[] {
  return useDomainSlice('notices', (s) => s.getNotices())
}

export function useConversationBackgroundSlice(): ConversationBackgroundSlice {
  return useDomainSlice('conversationBackground', (s) => s.getConversationBackgroundSlice())
}

// ---- Per-Key / Per-Conversation Hooks -------------------------------------

export function useConversationLive(
  conversationId: number | undefined,
  active = true,
): ConversationLive | undefined {
  const external = useContext(HelmxExternalStoreContext)
  const frozenRef = useRef<{ id: number | undefined; live: ConversationLive | undefined }>({
    id: conversationId,
    live: external !== null && conversationId !== undefined ? readLiveById(external, conversationId) : undefined,
  })
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && active && conversationId !== undefined
        ? subscribeLiveById(external, conversationId, listener)
        : NOOP_UNSUBSCRIBE,
    [external, conversationId, active],
  )
  const getSnapshot = (): ConversationLive | undefined | typeof UNSET => {
    if (external === null) return UNSET
    if (conversationId === undefined) return undefined
    if (!active && frozenRef.current.id === conversationId) {
      return frozenRef.current.live
    }
    const current = readLiveById(external, conversationId)
    frozenRef.current = { id: conversationId, live: current }
    return current
  }
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

export function useConversationDetail(conversationId: number | undefined): ConversationDetail | undefined {
  return useKeyedSlice(subscribeDetailById, readDetailById, conversationId, undefined)
}

function subscribeWorkspaceTopology(store: HelmxExternalStore, listener: () => void): () => void {
  return store.subscribeDomain('workspaceTopology', listener)
}

export function useConversationSummary(conversationId: number | undefined): ConversationSummary | undefined {
  return useKeyedSlice(subscribeSummaryById, readSummaryById, conversationId, undefined)
}

export function useConversationTreeWorkspaces(
  conversationId: number | undefined,
): ReadonlyArray<WorkspaceConversationNode> {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && conversationId !== undefined
        ? subscribeWorkspaceTopology(external, listener)
        : NOOP_UNSUBSCRIBE,
    [external, conversationId],
  )
  const getSnapshot = (): ReadonlyArray<WorkspaceConversationNode> | typeof UNSET => {
    if (external === null) return UNSET
    if (conversationId === undefined) return EMPTY_TREE_WORKSPACES
    return external.getConversationTreeWorkspaces(conversationId)
  }
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

export function useConversationArtifacts(conversationId: number | undefined): ArtifactMetadata[] | undefined {
  return useKeyedSlice(subscribeArtifactsById, readArtifactsById, conversationId, undefined)
}

export function useHighlightedEntryForConversation(
  conversationId: number | undefined,
): { conversationId: number; entryId: string } | null {
  return useKeyedSlice(subscribeHighlightById, readHighlightById, conversationId, null)
}

export function useLoadError(key: string | undefined): string | undefined {
  return useKeyedSlice(subscribeLoadErrorKey, readLoadErrorKey, key, undefined)
}

export function usePluginDoc(pluginId: string | undefined, docName: string | undefined): unknown {
  const docKey = pluginId && docName ? `${pluginId}/${docName}` : undefined
  return useKeyedSlice(subscribePluginDocKey, readPluginDocKey, docKey, undefined)
}

export function usePluginSummary(pluginId: string | undefined): PluginSummary | undefined {
  return useKeyedSlice(subscribePluginById, readPluginById, pluginId, undefined)
}

/**
 * Selective subscription to only a single plugin module's active `clientHashes[moduleRef]`:
 * avoids re-rendering mounted plugin views when unrelated plugins update OR when the same
 * plugin changes non-hash metadata (name, publicConfig, etc.).
 */
export function usePluginClientHash(
  pluginId: string,
  moduleRef: string | undefined,
): string | undefined {
  const external = useContext(HelmxExternalStoreContext)
  const subscribe = useCallback(
    (listener: () => void) =>
      external !== null && moduleRef !== undefined ? external.subscribePlugin(pluginId, listener) : NOOP_UNSUBSCRIBE,
    [external, pluginId, moduleRef],
  )
  const getSnapshot = (): string | undefined | typeof UNSET => {
    if (external === null) return UNSET
    if (moduleRef === undefined) return undefined
    const plugin = external.getPluginSummary(pluginId)
    return plugin !== undefined && isPluginSummaryActive(plugin)
      ? plugin.clientHashes?.[moduleRef]
      : undefined
  }
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (value !== UNSET) return value
  throw new Error('useHelmxStore must be called inside <HelmxStoreProvider>')
}

// ---------------------------------------------------------------------------
// Batch conversation-scoped plugin document (sessionDoc) subscription hooks
// (host-only): single-value / diagnostics subscriptions live in
// @helmx/plugin-client as usePluginSessionDocValue / usePluginSessionDocDiagnostics
// (port-driven; plugins and the host share one implementation).
// Ref-counted dedicated SSE streams connect only while mounted refs exist;
// see lib/session-docs.ts.
// ---------------------------------------------------------------------------

/**
 * Batch-subscribe multiple conversation-scoped docs of one plugin in one
 * conversation, returning `{ [docName]: value }`. A failing doc omits its key
 * and surfaces the error honestly on the snapshot (never a silent empty map).
 */
export function usePluginSessionDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
  conversationId: number | undefined,
): Record<string, unknown> {
  const { subscribeSessionDoc, getSessionDocState } = useStoreActions()
  const namesKey = JSON.stringify(docNames ?? [])
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!pluginId || conversationId === undefined) return () => {}
      const unsubs = (JSON.parse(namesKey) as string[]).map((name) =>
        subscribeSessionDoc({ pluginId, docName: name, conversationId }, listener))
      return () => { for (const off of unsubs) off() }
    },
    [pluginId, namesKey, conversationId, subscribeSessionDoc],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => {
      if (!pluginId || conversationId === undefined) return EMPTY_SESSION_DOCS_MAP
      const names = JSON.parse(namesKey) as string[]
      if (names.length === 0) return EMPTY_SESSION_DOCS_MAP
      const map: Record<string, unknown> = {}
      let error: string | undefined
      for (const name of names) {
        const s = getSessionDocState({ pluginId, docName: name, conversationId })
        if (s.error !== undefined) error = s.error
        else if (s.hasValue) map[name] = s.value
      }
      const cached = snapshotCache.get(subscribe)
      if (
        cached !== undefined && cached.pluginId === pluginId && cached.conversationId === conversationId &&
        cached.error === error && cacheSame(cached.map, map)
      ) {
        return cached.result
      }
      snapshotCache.set(subscribe, { pluginId, conversationId, map, error, result: map })
      return map
    },
    () => EMPTY_SESSION_DOCS_MAP,
  )
  return state
}

const EMPTY_SESSION_DOCS_MAP: Record<string, unknown> = {}
interface SessionDocsMapCache { pluginId?: string; conversationId?: number; map: Record<string, unknown>; error?: string; result: Record<string, unknown> }
const snapshotCache = new WeakMap<(listener: () => void) => () => void, SessionDocsMapCache>()

function cacheSame(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) return false
  }
  return true
}

export type { SessionDocKey }
export type {
  AuthSlice,
  CatalogSlice,
  ConversationBackgroundSlice,
  HelmxExternalStore,
  HelmxStoreActions,
  LocationTargetsSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  StoreDomainKey,
  WorkbenchParamsState,
  WorkbenchSlice,
}
