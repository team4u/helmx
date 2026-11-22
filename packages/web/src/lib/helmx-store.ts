/**
 * Domain-sliced external store for `@helmx/web`: decouples high-frequency
 * per-conversation live/detail/artifact updates from low-frequency catalog,
 * auth, preference, and navigation domains so React components subscribe via
 * `useSyncExternalStore` without full-tree re-render cascades.
 */
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmxLocale,
  HostModelsSlice,
  LocalizedText,
  NodeInfo,
  PluginSummary,
  PluginUiContribution,
  Profile,
  ProviderConfig,
  SkillSummary,
  UsePluginsResult,
} from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import {
  assetsApi,
  authApi,
  conversationsApi,
  nodesApi,
  pluginsApi,
  setStoredToken,
  type ModelCatalogDefaults,
  type ModelDescriptor,
} from './api.js'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import { errorText } from './error-text.js'
import {
  applyConversationEntry,
  emptyLiveState,
  entryMatchesReference,
  isPluginSummaryActive,
  mergeConversationDetail,
  omitPluginDocLoadErrors,
  reconcilePluginsState,
  sortNodes,
  type LiveState,
} from './live-state.js'
import { reconcilePluginClientCache, resetPluginClientCache } from './plugin-client.js'
import { isAbortError, StoreRequestManager } from './request-manager.js'
import {
  evictSessionDocSubscriptions,
  getSessionDocState,
  resetSessionDocSubscriptions,
  retrySessionDoc,
  subscribeSessionDoc,
} from './session-docs.js'
import {
  applyScreenParamsPatch,
  defaultSpaceTarget,
  hasVisibleConversationRoots,
  partitionScreenParamsPatch,
  resolveSpaceSwitch,
  type SpaceTargetInput,
} from './space-navigation.js'
import {
  applyDocumentLocale,
  applyDocumentTheme,
  getStoredLocalePreference,
  getStoredPreference,
  getStoredQuietNotify,
  nextThemePreference,
  persistLocalePreference,
  persistQuietNotify,
  persistThemePreference,
  resolveBrowserLocale,
  resolveLocale,
  resolveTheme,
} from './theme-preferences.js'
import {
  defaultConversationDetailLimit,
  groupUiContributions,
  resolveTargetString,
  spaceForTarget,
  type ActiveModal,
  type FocusedPanel,
  type GroupedUiSpecs,
  type HelmxStoreValue,
  type LocalePreference,
  type ResolvedTarget,
  type SidebarSpace,
  type ThemeMode,
  type ThemePreference,
  type ToastNotice,
} from './types.js'
import {
  DEFAULT_WORKBENCH_TAB,
  isSameDrawerStack,
  normalizeWorkbenchTab,
  popDrawerFrame,
  pushDrawerFrame,
  removeConversationFromDrawerStack,
  topConversationDrawerId,
  topDrawerFrame,
  truncateDrawerStackTo,
  updateTopWorkbenchTab,
  type DrawerFrame,
} from './drawer-stack-model.js'
import { isSameLocationState, parseLocationHash, type WorkspaceLocationState } from './url-hash-model.js'
import type { SseCursor } from './use-sse-events.js'
import { isConversationStatusActive } from './use-unread-sync.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import {
  activeTargetForPanel,
  ESC_ABORT_WINDOW_MS,
  getStoredSidebarCollapsed,
  isConversationAbortable,
  persistSidebarCollapsed,
  resolveFocusedPanel,
} from '../shell/shortcuts-model.js'
import { createWebTranslator, type WebMessageKey } from '../i18n/catalog.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
  type BackgroundBadgeDocRef,
  type ConversationBackgroundIndex,
} from '../shell/background-activity-model.js'

const ESC_ABORT_NOTICE_ID = 'esc-abort-confirm'
const EMPTY_PENDING_ASKS: AskSpec[] = Object.freeze([]) as unknown as AskSpec[]
const EMPTY_BADGE_DOCS: ReadonlyArray<BackgroundBadgeDocRef> = Object.freeze([])
const EMPTY_PENDING_BADGE_DOCS: ReadonlySet<string> = new Set<string>()
const EMPTY_BACKGROUND_INDEX: ConversationBackgroundIndex = new Map()

const ASSET_LOAD_FAILURE_TITLES: ReadonlyArray<LocalizedText> = [
  { en: 'Profiles failed to load', 'zh-CN': '角色加载失败' },
  { en: 'Models failed to load', 'zh-CN': '模型加载失败' },
  { en: 'Providers failed to load', 'zh-CN': '网关加载失败' },
  { en: 'Credentials failed to load', 'zh-CN': '凭据加载失败' },
  { en: 'Skills failed to load', 'zh-CN': '技能加载失败' },
  { en: 'Plugin actions failed to load', 'zh-CN': '插件动作加载失败' },
]

export type StoreListener = () => void
export type StoreUpdater<T> = T | ((prev: T) => T)

export interface AuthSlice {
  authReady: boolean
  authConfigured: boolean
  authenticated: boolean
  authError: string | null
  sseConnected: boolean
  connectionError: string | null
  kernelBootId: string | null
}

export interface PrefsSlice {
  theme: ThemeMode
  themePreference: ThemePreference
  locale: HelmxLocale
  localePreference: LocalePreference
  quietNotifyEnabled: boolean
}

export interface ProfilesSlice {
  profiles: Profile[]
  profilesLoaded: boolean
  assetsLoaded: boolean
}

export interface CatalogSlice {
  profiles: Profile[]
  profilesLoaded: boolean
  assetsLoaded: boolean
  models: ModelDescriptor[]
  /** GET /api/models 顶层全局默认链（HostModelsSlice 除 models 外的部分；首载前为空对象，由 assetsLoaded 门控读取）。 */
  modelDefaults: ModelCatalogDefaults
  providers: ProviderConfig[]
  credentials: CredentialSummary[]
  skills: SkillSummary[]
  actions: ActionManifest[]
}

export interface PluginsUiSlice {
  plugins: PluginSummary[]
  uiContributions: PluginUiContribution[]
  groupedUi: GroupedUiSpecs
}

export interface LocationTargetsSlice {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
}

export interface WorkbenchSlice {
  workbenchOpen: boolean
  workbenchTab: string
}

export interface NavSlice {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
  sidebarCollapsed: boolean
  pendingEscAbortConversationId: number | null
  drawerStack: DrawerFrame[]
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
  highlightedEntry: { conversationId: number; entryId: string } | null
}

export interface ConversationBackgroundSlice {
  /** Discovered per-conversation workbench badge docs for on-demand ensurePluginDoc. */
  badgeDocs: ReadonlyArray<BackgroundBadgeDocRef>
  /** Badge-doc keys (`${pluginId}/${doc}`) not yet present in `pluginDocs` (honest unknown gate). */
  pendingBadgeDocs: ReadonlySet<string>
  /** Standard background in-flight snapshot shared by host views and the SDK host port. */
  snapshot: {
    unknown: boolean
    byConversation: ConversationBackgroundIndex
  }
}

export type ResolvedAskEntry = HelmxStoreValue['resolvedAsksByConv'][number][number]

export type HelmxStoreActions = Pick<
  HelmxStoreValue,
  | 'setTheme'
  | 'setThemePreference'
  | 'toggleTheme'
  | 'setLocale'
  | 'setLocalePreference'
  | 'setQuietNotify'
  | 'checkAuth'
  | 'onAuthenticated'
  | 'logout'
  | 'refreshAssets'
  | 'syncPlugins'
  | 'refreshNodes'
  | 'loadConversationDetail'
  | 'loadEarlierEntries'
  | 'backfillConversationEntry'
  | 'loadConversationArtifacts'
  | 'ensurePluginDoc'
  | 'subscribeSessionDoc'
  | 'getSessionDocState'
  | 'getPluginSessionDoc'
  | 'retrySessionDoc'
  | 'openTarget'
  | 'closeSplit'
  | 'setFocusedPanel'
  | 'setSidebarCollapsed'
  | 'toggleSidebarCollapsed'
  | 'setScreenParams'
  | 'setWorkbenchOpen'
  | 'setWorkbenchTab'
  | 'openConversationDrawer'
  | 'openWorkbenchDrawer'
  | 'popDrawer'
  | 'truncateDrawerStack'
  | 'closeAllDrawers'
  | 'openSpace'
  | 'setActiveModal'
  | 'dismissNotice'
  | 'pushNotice'
  | 'invokePluginAction'
>

export type StoreDomainKey =
  | 'all'
  | 'auth'
  | 'authenticated'
  | 'sseConnected'
  | 'prefs'
  | 'locale'
  | 'theme'
  | 'quietNotify'
  | 'catalog'
  | 'profiles'
  | 'models'
  | 'hostModels'
  | 'providers'
  | 'credentials'
  | 'skills'
  | 'actions'
  | 'conversations'
  | 'conversationDetailsMap'
  | 'conversationLivesMap'
  | 'conversationArtifactsMap'
  | 'pendingAsks'
  | 'resolvedAsksMap'
  | 'asks'
  | 'plugins'
  | 'groupedUi'
  | 'pluginsUi'
  | 'pluginDocsMap'
  | 'nodes'
  | 'loadErrorsMap'
  | 'nav'
  | 'locationTargets'
  | 'primaryTarget'
  | 'splitTarget'
  | 'focusedPanel'
  | 'sidebarCollapsed'
  | 'pendingEscAbort'
  | 'drawerStack'
  | 'workbench'
  | 'activeModal'
  | 'locationState'
  | 'conversationBackground'
  | 'highlightedEntry'
  | 'notices'

export interface StoreBootLocation {
  location: WorkspaceLocationState
  needsHomeLanding: boolean
}

interface NotifyPlan {
  domains: Set<StoreDomainKey>
  liveIds: Set<number>
  detailIds: Set<number>
  summaryIds: Set<number>
  artifactIds: Set<number>
  pendingAskIds: Set<number>
  resolvedAskIds: Set<number>
  highlightIds: Set<number>
  loadErrorKeys: Set<string>
  pluginDocKeys: Set<string>
}

function emptyPlan(): NotifyPlan {
  return {
    domains: new Set(),
    liveIds: new Set(),
    detailIds: new Set(),
    summaryIds: new Set(),
    artifactIds: new Set(),
    pendingAskIds: new Set(),
    resolvedAskIds: new Set(),
    highlightIds: new Set(),
    loadErrorKeys: new Set(),
    pluginDocKeys: new Set(),
  }
}

function addChangedRecordKeys<V>(
  prev: Record<number, V>,
  next: Record<number, V>,
  out: Set<number>,
): void {
  for (const key of Object.keys(prev)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
  for (const key of Object.keys(next)) {
    const id = Number(key)
    if (prev[id] !== next[id]) out.add(id)
  }
}

function addChangedStringKeys<V>(
  prev: Record<string, V>,
  next: Record<string, V>,
  out: Set<string>,
): void {
  for (const key of Object.keys(prev)) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) out.add(key)
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(prev, key) || prev[key] !== next[key]) out.add(key)
  }
}

function applyUpdater<T>(prev: T, update: StoreUpdater<T>): T {
  return typeof update === 'function' ? (update as (p: T) => T)(prev) : update
}

function sameArtifactMetadata(a: ArtifactMetadata, b: ArtifactMetadata): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.conversationId === b.conversationId &&
      a.kind === b.kind &&
      a.name === b.name &&
      a.path === b.path &&
      a.mimeType === b.mimeType &&
      a.size === b.size &&
      a.createdAt === b.createdAt)
  )
}

/**
 * 复用未变更产物的数组与单项引用：内容完全一致时返回原数组以跳过订阅重渲染，
 * 列表变更时保留未变项原引用，避免预览模态框因元数据引用刷新误重置解码状态。
 */
function reconcileArtifactList(
  prev: ReadonlyArray<ArtifactMetadata> | undefined,
  next: ArtifactMetadata[],
): ArtifactMetadata[] {
  if (prev === undefined) return next
  const prevById = new Map(prev.map((item) => [item.id, item]))
  let allSame = prev.length === next.length
  const merged = next.map((item, index) => {
    const existing = prevById.get(item.id)
    if (existing !== undefined && sameArtifactMetadata(existing, item)) {
      if (allSame && prev[index] !== existing) allSame = false
      return existing
    }
    allSame = false
    return item
  })
  return allSame ? (prev as ArtifactMetadata[]) : merged
}

function shallowEqualAuth(a: AuthSlice, b: AuthSlice): boolean {
  return (
    a.authReady === b.authReady &&
    a.authConfigured === b.authConfigured &&
    a.authenticated === b.authenticated &&
    a.authError === b.authError &&
    a.sseConnected === b.sseConnected &&
    a.connectionError === b.connectionError &&
    a.kernelBootId === b.kernelBootId
  )
}

function isSameAskArray(a: ReadonlyArray<AskSpec>, b: ReadonlyArray<AskSpec>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isSameBadgeDocs(
  a: ReadonlyArray<BackgroundBadgeDocRef>,
  b: ReadonlyArray<BackgroundBadgeDocRef>,
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.pluginId !== b[i]!.pluginId || a[i]!.doc !== b[i]!.doc) return false
  }
  return true
}

function isSameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const key of a) {
    if (!b.has(key)) return false
  }
  return true
}

function isSameBackgroundIndex(a: ConversationBackgroundIndex, b: ConversationBackgroundIndex): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, entry] of a) {
    const other = b.get(id)
    if (other === undefined || other.active !== entry.active || other.summary !== entry.summary) return false
  }
  return true
}

export class HelmxExternalStore {
  readonly requests = new StoreRequestManager()
  readonly sseCursorRef: { current: SseCursor | null } = { current: null }
  readonly lastSyncedLocation: { current: WorkspaceLocationState }
  readonly pendingHistoryMode: { current: 'push' | 'replace' | null } = { current: null }
  readonly liveRef: { current: LiveState }
  readonly authenticatedRef: { current: boolean } = { current: false }
  readonly profilesRef: { current: Profile[] } = { current: [] }
  readonly profilesLoadedRef: { current: boolean } = { current: false }
  readonly assetsLoadedRef: { current: boolean } = { current: false }
  readonly conversationArtifactsRef: { current: Record<number, ArtifactMetadata[]> } = { current: {} }
  readonly targets: { current: { primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null } }
  readonly focusedPanelRef: { current: FocusedPanel } = { current: 'primary' }
  readonly drawerStackRef: { current: DrawerFrame[] }
  readonly workbenchOpenRef: { current: boolean }
  readonly activeModalRef: { current: ActiveModal }

  private authState: AuthSlice = {
    authReady: false,
    authConfigured: false,
    authenticated: false,
    authError: null,
    sseConnected: false,
    connectionError: null,
    kernelBootId: null,
  }
  private prefsState: PrefsSlice
  private catalogState: CatalogSlice = {
    profiles: [],
    profilesLoaded: false,
    assetsLoaded: false,
    models: [],
    modelDefaults: {},
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
  }
  private profilesSlice: ProfilesSlice = {
    profiles: [],
    profilesLoaded: false,
    assetsLoaded: false,
  }
  private liveState: LiveState = emptyLiveState()
  private groupedUi: GroupedUiSpecs = groupUiContributions([])
  private pluginsUiSlice: PluginsUiSlice
  private pluginsSnapshot: UsePluginsResult
  private hostModelsSlice: HostModelsSlice | undefined = undefined
  private summaryById = new Map<number, ConversationSummary>()
  private pendingAsksByConv = new Map<number, AskSpec[]>()
  private artifactsState: Record<number, ArtifactMetadata[]> = {}
  private loadErrorsState: Record<string, string> = {}
  private navState: NavSlice
  private locationTargetsSlice: LocationTargetsSlice
  private workbenchSlice: WorkbenchSlice
  private locationStateCache: WorkspaceLocationState
  private backgroundBadgeDocKeys = new Set<string>()
  private conversationBackgroundSlice: ConversationBackgroundSlice = {
    badgeDocs: EMPTY_BADGE_DOCS,
    pendingBadgeDocs: EMPTY_PENDING_BADGE_DOCS,
    snapshot: Object.freeze({ unknown: false, byConversation: EMPTY_BACKGROUND_INDEX }),
  }
  private noticesState: ToastNotice[] = []
  private fullSnapshotCache: HelmxStoreValue | null = null

  private noticeSequence = 0
  private spaceMemory: Partial<Record<SidebarSpace, ResolvedTarget>>
  private escAbortTimer: ReturnType<typeof setTimeout> | null = null
  private readonly escAbortWindowMs: number
  private logoutImpl: (() => void) | null = null

  private domainListeners = new Map<StoreDomainKey, Set<StoreListener>>()
  private liveListeners = new Map<number, Set<StoreListener>>()
  private detailListeners = new Map<number, Set<StoreListener>>()
  private summaryListeners = new Map<number, Set<StoreListener>>()
  private artifactsListeners = new Map<number, Set<StoreListener>>()
  private pendingAskListeners = new Map<number, Set<StoreListener>>()
  private resolvedAsksListeners = new Map<number, Set<StoreListener>>()
  private highlightListeners = new Map<number, Set<StoreListener>>()
  private loadErrorListeners = new Map<string, Set<StoreListener>>()
  private pluginDocListeners = new Map<string, Set<StoreListener>>()

  readonly actions: HelmxStoreActions

  constructor(bootLocation: WorkspaceLocationState, options?: { escAbortWindowMs?: number }) {
    this.escAbortWindowMs = options?.escAbortWindowMs ?? ESC_ABORT_WINDOW_MS
    const themePreference = getStoredPreference()
    const localePreference = getStoredLocalePreference()
    const locale = resolveLocale(localePreference)
    this.prefsState = {
      themePreference,
      theme: resolveTheme(themePreference),
      localePreference,
      locale,
      quietNotifyEnabled: getStoredQuietNotify(),
    }
    this.pluginsUiSlice = {
      plugins: this.liveState.plugins,
      uiContributions: this.liveState.uiContributions,
      groupedUi: this.groupedUi,
    }
    this.pluginsSnapshot = {
      plugins: this.liveState.plugins,
      screens: this.groupedUi.screens,
    }
    const initialTop = topDrawerFrame(bootLocation.drawerStack)
    const initialWbOpen = initialTop?.kind === 'workbench'
    const initialWbTab = initialTop?.kind === 'workbench' ? initialTop.tab : DEFAULT_WORKBENCH_TAB
    this.navState = {
      primaryTarget: bootLocation.primaryTarget,
      splitTarget: bootLocation.splitTarget,
      focusedPanel: 'primary',
      sidebarCollapsed: getStoredSidebarCollapsed(),
      pendingEscAbortConversationId: null,
      drawerStack: bootLocation.drawerStack,
      workbenchOpen: initialWbOpen,
      workbenchTab: initialWbTab,
      activeModal: bootLocation.activeModal,
      highlightedEntry: null,
    }
    this.locationTargetsSlice = {
      primaryTarget: this.navState.primaryTarget,
      splitTarget: this.navState.splitTarget,
      focusedPanel: this.navState.focusedPanel,
    }
    this.workbenchSlice = {
      workbenchOpen: this.navState.workbenchOpen,
      workbenchTab: this.navState.workbenchTab,
    }
    this.locationStateCache = {
      primaryTarget: this.navState.primaryTarget,
      splitTarget: this.navState.splitTarget,
      drawerStack: this.navState.drawerStack,
      activeModal: this.navState.activeModal,
    }
    this.spaceMemory = {}
    this.rememberSpaceTarget(bootLocation.primaryTarget)
    this.lastSyncedLocation = { current: bootLocation }
    this.liveRef = { current: this.liveState }
    this.targets = {
      current: {
        primaryTarget: this.navState.primaryTarget,
        splitTarget: this.navState.splitTarget,
      },
    }
    this.drawerStackRef = { current: this.navState.drawerStack }
    this.workbenchOpenRef = { current: this.navState.workbenchOpen }
    this.activeModalRef = { current: this.navState.activeModal }

    this.actions = {
      setTheme: this.setTheme,
      setThemePreference: this.setThemePreference,
      toggleTheme: this.toggleTheme,
      setLocale: this.setLocale,
      setLocalePreference: this.setLocalePreference,
      setQuietNotify: this.setQuietNotify,
      checkAuth: this.checkAuth,
      onAuthenticated: this.onAuthenticated,
      logout: () => {
        if (this.logoutImpl !== null) this.logoutImpl()
        else {
          this.prepareLogoutHistoryReset()
          this.finishLogoutStateReset()
        }
      },
      refreshAssets: this.refreshAssets,
      syncPlugins: this.syncPlugins,
      refreshNodes: this.refreshNodes,
      loadConversationDetail: this.loadConversationDetail,
      loadEarlierEntries: this.loadEarlierEntries,
      backfillConversationEntry: this.backfillConversationEntry,
      loadConversationArtifacts: this.loadConversationArtifacts,
      ensurePluginDoc: this.ensurePluginDoc,
      subscribeSessionDoc,
      getSessionDocState,
      getPluginSessionDoc: this.getPluginSessionDoc,
      retrySessionDoc,
      openTarget: this.openTarget,
      closeSplit: this.closeSplit,
      setFocusedPanel: this.setFocusedPanel,
      setSidebarCollapsed: this.setSidebarCollapsed,
      toggleSidebarCollapsed: this.toggleSidebarCollapsed,
      setScreenParams: this.setScreenParams,
      setWorkbenchOpen: this.setWorkbenchOpen,
      setWorkbenchTab: this.setWorkbenchTab,
      openConversationDrawer: this.openConversationDrawer,
      openWorkbenchDrawer: this.openWorkbenchDrawer,
      popDrawer: this.popDrawer,
      truncateDrawerStack: this.truncateDrawerStack,
      closeAllDrawers: this.closeAllDrawers,
      openSpace: this.openSpace,
      setActiveModal: this.setActiveModal,
      dismissNotice: this.dismissNotice,
      pushNotice: this.pushNotice,
      invokePluginAction: this.invokePluginAction,
    }
  }

  bindLogout(fn: () => void): void {
    this.logoutImpl = fn
  }

  dispose(): void {
    this.clearEscTimer()
    this.requests.dispose()
  }

  private clearEscTimer(): void {
    if (this.escAbortTimer !== null) {
      clearTimeout(this.escAbortTimer)
      this.escAbortTimer = null
    }
  }

  translate = (text: LocalizedText): string => resolveLocalizedText(text, this.prefsState.locale)

  private tt(key: WebMessageKey, params?: Record<string, string | number>): string {
    return createWebTranslator(this.prefsState.locale)(key, params as never)
  }

  // ---- Subscriptions --------------------------------------------------------

  subscribeDomain = (key: StoreDomainKey, listener: StoreListener): (() => void) => {
    return this.addListener(this.domainListeners, key, listener)
  }

  subscribeAll = (listener: StoreListener): (() => void) => this.subscribeDomain('all', listener)

  subscribeConversationLive = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.liveListeners, conversationId, listener)

  subscribeConversationDetail = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.detailListeners, conversationId, listener)

  subscribeConversationSummary = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.summaryListeners, conversationId, listener)

  subscribeConversationArtifacts = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.artifactsListeners, conversationId, listener)

  subscribeConversationPendingAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.pendingAskListeners, conversationId, listener)

  subscribeResolvedAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.resolvedAsksListeners, conversationId, listener)

  subscribeHighlightForConversation = (conversationId: number, listener: StoreListener): (() => void) =>
    this.addListener(this.highlightListeners, conversationId, listener)

  subscribeLoadError = (key: string, listener: StoreListener): (() => void) =>
    this.addListener(this.loadErrorListeners, key, listener)

  subscribePluginDoc = (docKey: string, listener: StoreListener): (() => void) =>
    this.addListener(this.pluginDocListeners, docKey, listener)

  private addListener<K>(map: Map<K, Set<StoreListener>>, key: K, listener: StoreListener): () => void {
    let set = map.get(key)
    if (set === undefined) {
      set = new Set()
      map.set(key, set)
    }
    set.add(listener)
    return () => {
      const current = map.get(key)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) map.delete(key)
    }
  }

  // ---- Cached Snapshot Getters ----------------------------------------------

  getAuthSlice = (): AuthSlice => this.authState
  getAuthenticated = (): boolean => this.authState.authenticated
  getSseConnected = (): boolean => this.authState.sseConnected
  getPrefsSlice = (): PrefsSlice => this.prefsState
  getTheme = (): ThemeMode => this.prefsState.theme
  getLocale = (): HelmxLocale => this.prefsState.locale
  getCatalogSlice = (): CatalogSlice => this.catalogState
  getProfilesSlice = (): ProfilesSlice => this.profilesSlice
  getModels = (): ModelDescriptor[] => this.catalogState.models
  getModelDefaults = (): ModelCatalogDefaults => this.catalogState.modelDefaults
  getHostModelsSlice = (): HostModelsSlice | undefined => this.hostModelsSlice
  getProviders = (): ProviderConfig[] => this.catalogState.providers
  getCredentials = (): CredentialSummary[] => this.catalogState.credentials
  getSkills = (): SkillSummary[] => this.catalogState.skills
  getActionsList = (): ActionManifest[] => this.catalogState.actions
  getLiveState = (): LiveState => this.liveState
  getConversations = (): ConversationSummary[] => this.liveState.conversations
  getConversationDetailsMap = (): Record<number, ConversationDetail> => this.liveState.conversationDetails
  getConversationLivesMap = (): Record<number, ConversationLive> => this.liveState.conversationLives
  getConversationArtifactsMap = (): Record<number, ArtifactMetadata[]> => this.artifactsState
  getPendingAsks = (): AskSpec[] => this.liveState.pendingAsks
  getResolvedAsksMap = (): Record<number, ResolvedAskEntry[]> => this.liveState.resolvedAsksByConv
  getPlugins = (): PluginSummary[] => this.liveState.plugins
  getGroupedUi = (): GroupedUiSpecs => this.groupedUi
  getPluginsUiSlice = (): PluginsUiSlice => this.pluginsUiSlice
  getPluginsSnapshot = (): UsePluginsResult => this.pluginsSnapshot
  getPluginDocsMap = (): Record<string, unknown> => this.liveState.pluginDocs
  getNodes = (): NodeInfo[] => this.liveState.nodes
  getLoadErrorsMap = (): Record<string, string> => this.loadErrorsState
  getNavSlice = (): NavSlice => this.navState
  getLocationTargetsSlice = (): LocationTargetsSlice => this.locationTargetsSlice
  getPrimaryTarget = (): ResolvedTarget => this.navState.primaryTarget
  getSplitTarget = (): ResolvedTarget | null => this.navState.splitTarget
  getFocusedPanel = (): FocusedPanel => this.navState.focusedPanel
  getSidebarCollapsed = (): boolean => this.navState.sidebarCollapsed
  getPendingEscAbort = (): number | null => this.navState.pendingEscAbortConversationId
  getDrawerStack = (): DrawerFrame[] => this.navState.drawerStack
  getWorkbenchSlice = (): WorkbenchSlice => this.workbenchSlice
  getActiveModal = (): ActiveModal => this.navState.activeModal
  getLocationState = (): WorkspaceLocationState => this.locationStateCache
  getConversationBackgroundSlice = (): ConversationBackgroundSlice => this.conversationBackgroundSlice
  getHighlightedEntry = (): { conversationId: number; entryId: string } | null => this.navState.highlightedEntry
  getNotices = (): ToastNotice[] => this.noticesState

  getConversationLive = (id: number): ConversationLive | undefined => this.liveState.conversationLives[id]
  getConversationDetail = (id: number): ConversationDetail | undefined => this.liveState.conversationDetails[id]
  getConversationSummary = (id: number): ConversationSummary | undefined => this.summaryById.get(id)
  getConversationArtifacts = (id: number): ArtifactMetadata[] | undefined => this.artifactsState[id]
  getConversationPendingAsks = (id: number): AskSpec[] => this.pendingAsksByConv.get(id) ?? EMPTY_PENDING_ASKS
  getResolvedAsks = (id: number): ResolvedAskEntry[] | undefined => this.liveState.resolvedAsksByConv[id]
  getHighlightedEntryForConversation = (id: number): { conversationId: number; entryId: string } | null =>
    this.navState.highlightedEntry?.conversationId === id ? this.navState.highlightedEntry : null
  getLoadError = (key: string): string | undefined => this.loadErrorsState[key]
  getPluginDoc = (docKey: string): unknown =>
    Object.hasOwn(this.liveState.pluginDocs, docKey) ? this.liveState.pluginDocs[docKey] : undefined

  getSnapshot = (): HelmxStoreValue => {
    if (this.fullSnapshotCache !== null) return this.fullSnapshotCache
    const next: HelmxStoreValue = {
      ...this.liveState,
      ...this.authState,
      ...this.prefsState,
      ...this.catalogState,
      groupedUi: this.groupedUi,
      conversationArtifacts: this.artifactsState,
      loadErrors: this.loadErrorsState,
      ...this.navState,
      notices: this.noticesState,
      ...this.actions,
    }
    this.fullSnapshotCache = next
    return next
  }

  private recomputeConversationBackground(
    plan: NotifyPlan,
    triggers: { panelsOrConversations: boolean; locale: boolean; changedDocKeys?: ReadonlySet<string> },
  ): void {
    const prev = this.conversationBackgroundSlice
    if (!triggers.panelsOrConversations && !triggers.locale) {
      if (triggers.changedDocKeys === undefined || triggers.changedDocKeys.size === 0) return
      let touchesBadgeDoc = false
      for (const key of triggers.changedDocKeys) {
        if (this.backgroundBadgeDocKeys.has(key)) {
          touchesBadgeDoc = true
          break
        }
      }
      if (!touchesBadgeDoc) return
    }

    let nextBadgeDocs = prev.badgeDocs
    if (triggers.panelsOrConversations) {
      const collected = collectBackgroundBadgeDocs(
        this.groupedUi.workbenchPanels,
        this.liveState.conversations,
      )
      if (!isSameBadgeDocs(prev.badgeDocs, collected)) {
        nextBadgeDocs = collected.length === 0 ? EMPTY_BADGE_DOCS : Object.freeze(collected)
        this.backgroundBadgeDocKeys = new Set(nextBadgeDocs.map((ref) => `${ref.pluginId}/${ref.doc}`))
      }
    }

    const rawPending = new Set<string>()
    for (const ref of nextBadgeDocs) {
      const key = `${ref.pluginId}/${ref.doc}`
      if (!Object.hasOwn(this.liveState.pluginDocs, key)) rawPending.add(key)
    }
    const nextPendingBadgeDocs = isSameStringSet(prev.pendingBadgeDocs, rawPending)
      ? prev.pendingBadgeDocs
      : rawPending.size === 0
        ? EMPTY_PENDING_BADGE_DOCS
        : rawPending

    const nextUnknown = nextPendingBadgeDocs.size > 0
    const rawByConversation = summarizeConversationBackgroundActivity({
      panels: this.groupedUi.workbenchPanels,
      conversations: this.liveState.conversations,
      pluginDocs: this.liveState.pluginDocs,
      locale: this.prefsState.locale,
      t: createWebTranslator(this.prefsState.locale),
    })
    const nextSnapshot =
      prev.snapshot.unknown === nextUnknown &&
      isSameBackgroundIndex(prev.snapshot.byConversation, rawByConversation)
        ? prev.snapshot
        : Object.freeze({
            unknown: nextUnknown,
            byConversation: rawByConversation.size === 0 ? EMPTY_BACKGROUND_INDEX : rawByConversation,
          })

    if (
      nextBadgeDocs === prev.badgeDocs &&
      nextPendingBadgeDocs === prev.pendingBadgeDocs &&
      nextSnapshot === prev.snapshot
    ) {
      return
    }
    this.conversationBackgroundSlice = {
      badgeDocs: nextBadgeDocs,
      pendingBadgeDocs: nextPendingBadgeDocs,
      snapshot: nextSnapshot,
    }
    plan.domains.add('conversationBackground')
  }

  // ---- Atomic Commit / Notification Engine ----------------------------------

  private emit(plan: NotifyPlan): void {
    const anyChanged =
      plan.domains.size > 0 ||
      plan.liveIds.size > 0 ||
      plan.detailIds.size > 0 ||
      plan.summaryIds.size > 0 ||
      plan.artifactIds.size > 0 ||
      plan.pendingAskIds.size > 0 ||
      plan.resolvedAskIds.size > 0 ||
      plan.highlightIds.size > 0 ||
      plan.loadErrorKeys.size > 0 ||
      plan.pluginDocKeys.size > 0
    if (!anyChanged) return

    this.fullSnapshotCache = null

    // Reconcile armed double-Esc abort synchronously on nav / conversation / detail shifts.
    this.reconcileEscAbort(plan)

    const listeners = new Set<StoreListener>()
    const collect = <K>(map: Map<K, Set<StoreListener>>, key: K) => {
      const set = map.get(key)
      if (set !== undefined) {
        for (const fn of set) listeners.add(fn)
      }
    }

    for (const domain of plan.domains) collect(this.domainListeners, domain)
    for (const id of plan.liveIds) collect(this.liveListeners, id)
    for (const id of plan.detailIds) collect(this.detailListeners, id)
    for (const id of plan.summaryIds) collect(this.summaryListeners, id)
    for (const id of plan.artifactIds) collect(this.artifactsListeners, id)
    for (const id of plan.pendingAskIds) collect(this.pendingAskListeners, id)
    for (const id of plan.resolvedAskIds) collect(this.resolvedAsksListeners, id)
    for (const id of plan.highlightIds) collect(this.highlightListeners, id)
    for (const key of plan.loadErrorKeys) collect(this.loadErrorListeners, key)
    for (const key of plan.pluginDocKeys) collect(this.pluginDocListeners, key)

    for (const fn of listeners) fn()
  }

  private reconcileEscAbort(plan: NotifyPlan): void {
    const pendingId = this.navState.pendingEscAbortConversationId
    if (pendingId === null) return
    const activeTarget = activeTargetForPanel(
      this.navState.primaryTarget,
      this.navState.splitTarget,
      this.navState.focusedPanel,
    )
    const targetInvalid = activeTarget.kind !== 'conversation' || activeTarget.conversationId !== pendingId
    const conv = this.summaryById.get(pendingId) ?? this.liveState.conversationDetails[pendingId]
    if (!targetInvalid && isConversationAbortable(conv)) return

    this.clearEscTimer()
    this.navState = { ...this.navState, pendingEscAbortConversationId: null }
    plan.domains.add('pendingEscAbort')
    plan.domains.add('nav')
    plan.domains.add('all')
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.noticesState = this.noticesState.filter((item) => item.id !== ESC_ABORT_NOTICE_ID)
      plan.domains.add('notices')
    }
  }

  // ---- Internal Mutators ----------------------------------------------------

  private patchAuth(patch: Partial<AuthSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.authState
    const next: AuthSlice = { ...prev, ...patch }
    if (shallowEqualAuth(prev, next)) return
    this.authState = next
    this.authenticatedRef.current = next.authenticated
    plan.domains.add('auth')
    plan.domains.add('all')
    if (next.authenticated !== prev.authenticated) {
      plan.domains.add('authenticated')
    }
    if (next.sseConnected !== prev.sseConnected) plan.domains.add('sseConnected')
    if (!deferEmit) this.emit(plan)
  }

  setSseConnected = (update: StoreUpdater<boolean>): void => {
    const next = applyUpdater(this.authState.sseConnected, update)
    this.patchAuth({ sseConnected: next })
  }

  setConnectionError = (update: StoreUpdater<string | null>): void => {
    const next = applyUpdater(this.authState.connectionError, update)
    this.patchAuth({ connectionError: next })
  }

  setKernelBootId = (update: StoreUpdater<string | null>): void => {
    const next = applyUpdater(this.authState.kernelBootId, update)
    this.patchAuth({ kernelBootId: next })
  }

  private patchPrefs(patch: Partial<PrefsSlice>, plan = emptyPlan()): void {
    const prev = this.prefsState
    const next: PrefsSlice = { ...prev, ...patch }
    if (
      prev.theme === next.theme &&
      prev.themePreference === next.themePreference &&
      prev.locale === next.locale &&
      prev.localePreference === next.localePreference &&
      prev.quietNotifyEnabled === next.quietNotifyEnabled
    ) {
      return
    }
    this.prefsState = next
    plan.domains.add('prefs')
    plan.domains.add('all')
    if (next.theme !== prev.theme || next.themePreference !== prev.themePreference) {
      plan.domains.add('theme')
    }
    if (next.locale !== prev.locale || next.localePreference !== prev.localePreference) {
      plan.domains.add('locale')
    }
    if (next.locale !== prev.locale) {
      this.recomputeConversationBackground(plan, { panelsOrConversations: false, locale: true })
    }
    if (next.quietNotifyEnabled !== prev.quietNotifyEnabled) {
      plan.domains.add('quietNotify')
    }
    this.emit(plan)
  }

  handleSystemThemeChange = (matchesDark: boolean): void => {
    if (this.prefsState.themePreference !== 'system') return
    const next: ThemeMode = matchesDark ? 'dark' : 'light'
    applyDocumentTheme(next)
    this.patchPrefs({ theme: next })
  }

  handleBrowserLanguageChange = (): void => {
    if (this.prefsState.localePreference !== 'auto') return
    const next = resolveBrowserLocale()
    applyDocumentLocale(next)
    this.patchPrefs({ locale: next })
  }

  private patchCatalog(patch: Partial<CatalogSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.catalogState
    const next: CatalogSlice = { ...prev, ...patch }
    let changed = false
    if (next.profiles !== prev.profiles || next.profilesLoaded !== prev.profilesLoaded || next.assetsLoaded !== prev.assetsLoaded) {
      this.profilesSlice = {
        profiles: next.profiles,
        profilesLoaded: next.profilesLoaded,
        assetsLoaded: next.assetsLoaded,
      }
      this.profilesRef.current = next.profiles
      this.profilesLoadedRef.current = next.profilesLoaded
      this.assetsLoadedRef.current = next.assetsLoaded
      plan.domains.add('profiles')
      changed = true
    }
    if (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults) { plan.domains.add('models'); changed = true }
    if (
      next.assetsLoaded !== prev.assetsLoaded ||
      (next.assetsLoaded && (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults))
    ) {
      this.hostModelsSlice = next.assetsLoaded
        ? { models: next.models, ...next.modelDefaults }
        : undefined
      plan.domains.add('hostModels')
      changed = true
    }
    if (next.providers !== prev.providers) { plan.domains.add('providers'); changed = true }
    if (next.credentials !== prev.credentials) { plan.domains.add('credentials'); changed = true }
    if (next.skills !== prev.skills) { plan.domains.add('skills'); changed = true }
    if (next.actions !== prev.actions) { plan.domains.add('actions'); changed = true }
    if (!changed) return
    this.catalogState = next
    plan.domains.add('catalog')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  updateLive = (update: (state: LiveState) => LiveState, plan = emptyPlan(), deferEmit = false): void => {
    const prev = this.liveState
    const next = update(prev)
    if (next === prev) return
    this.liveState = next
    this.liveRef.current = next

    if (next.conversationLives !== prev.conversationLives) {
      addChangedRecordKeys(prev.conversationLives, next.conversationLives, plan.liveIds)
      if (plan.liveIds.size > 0) {
        plan.domains.add('conversationLivesMap')
        plan.domains.add('all')
      }
    }
    if (next.conversationDetails !== prev.conversationDetails) {
      addChangedRecordKeys(prev.conversationDetails, next.conversationDetails, plan.detailIds)
      if (plan.detailIds.size > 0) {
        plan.domains.add('conversationDetailsMap')
        plan.domains.add('all')
      }
    }
    const conversationsChanged = next.conversations !== prev.conversations
    if (conversationsChanged) {
      const nextMap = new Map<number, ConversationSummary>()
      for (const conv of next.conversations) nextMap.set(conv.id, conv)
      for (const [id, prevConv] of this.summaryById) {
        if (nextMap.get(id) !== prevConv) plan.summaryIds.add(id)
      }
      for (const [id, nextConv] of nextMap) {
        if (this.summaryById.get(id) !== nextConv) plan.summaryIds.add(id)
      }
      this.summaryById = nextMap
      plan.domains.add('conversations')
      plan.domains.add('all')
    }
    if (next.pendingAsks !== prev.pendingAsks) {
      const nextByConv = new Map<number, AskSpec[]>()
      for (const ask of next.pendingAsks) {
        const list = nextByConv.get(ask.conversationId)
        if (list === undefined) nextByConv.set(ask.conversationId, [ask])
        else list.push(ask)
      }
      for (const [convId, prevList] of this.pendingAsksByConv) {
        const nextList = nextByConv.get(convId)
        if (nextList === undefined) {
          plan.pendingAskIds.add(convId)
        } else if (isSameAskArray(prevList, nextList)) {
          nextByConv.set(convId, prevList)
        } else {
          plan.pendingAskIds.add(convId)
        }
      }
      for (const convId of nextByConv.keys()) {
        if (!this.pendingAsksByConv.has(convId)) {
          plan.pendingAskIds.add(convId)
        }
      }
      this.pendingAsksByConv = nextByConv
      plan.domains.add('pendingAsks')
      plan.domains.add('asks')
      plan.domains.add('all')
    }
    if (next.resolvedAsksByConv !== prev.resolvedAsksByConv) {
      addChangedRecordKeys(prev.resolvedAsksByConv, next.resolvedAsksByConv, plan.resolvedAskIds)
      if (plan.resolvedAskIds.size > 0) {
        plan.domains.add('resolvedAsksMap')
        plan.domains.add('asks')
        plan.domains.add('all')
      }
    }
    if (next.plugins !== prev.plugins) {
      plan.domains.add('plugins')
      plan.domains.add('pluginsUi')
      plan.domains.add('all')
    }
    const uiChanged = next.uiContributions !== prev.uiContributions
    if (uiChanged) {
      this.groupedUi = groupUiContributions(next.uiContributions)
      plan.domains.add('groupedUi')
      plan.domains.add('pluginsUi')
      plan.domains.add('all')
    }
    if (next.plugins !== prev.plugins || uiChanged) {
      this.pluginsUiSlice = {
        plugins: next.plugins,
        uiContributions: next.uiContributions,
        groupedUi: this.groupedUi,
      }
      this.pluginsSnapshot = {
        plugins: next.plugins,
        screens: this.groupedUi.screens,
      }
    }
    if (next.pluginDocs !== prev.pluginDocs) {
      addChangedStringKeys(prev.pluginDocs, next.pluginDocs, plan.pluginDocKeys)
      if (plan.pluginDocKeys.size > 0) {
        plan.domains.add('pluginDocsMap')
        plan.domains.add('all')
      }
    }
    if (conversationsChanged || uiChanged || plan.pluginDocKeys.size > 0) {
      this.recomputeConversationBackground(plan, {
        panelsOrConversations: conversationsChanged || uiChanged,
        locale: false,
        changedDocKeys: plan.pluginDocKeys,
      })
    }
    if (next.nodes !== prev.nodes) {
      plan.domains.add('nodes')
      plan.domains.add('all')
    }
    if (!deferEmit) this.emit(plan)
  }

  setConversationArtifacts = (
    update: StoreUpdater<Record<number, ArtifactMetadata[]>>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.artifactsState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    addChangedRecordKeys(prev, next, plan.artifactIds)
    if (plan.artifactIds.size === 0) return
    this.artifactsState = next
    this.conversationArtifactsRef.current = next
    plan.domains.add('conversationArtifactsMap')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  setLoadErrors = (
    update: StoreUpdater<Record<string, string>>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.loadErrorsState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    addChangedStringKeys(prev, next, plan.loadErrorKeys)
    if (plan.loadErrorKeys.size === 0) return
    this.loadErrorsState = next
    plan.domains.add('loadErrorsMap')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  reportLoad = (key: string, error?: unknown): void => {
    if (error === undefined && !Object.hasOwn(this.loadErrorsState, key)) return
    const nextMessage = error === undefined ? undefined : errorText(error)
    if (error !== undefined && this.loadErrorsState[key] === nextMessage) return
    const next = { ...this.loadErrorsState }
    if (nextMessage === undefined) delete next[key]
    else next[key] = nextMessage
    this.setLoadErrors(next)
  }

  setNotices = (
    update: StoreUpdater<ToastNotice[]>,
    plan = emptyPlan(),
    deferEmit = false,
  ): void => {
    const prev = this.noticesState
    const next = applyUpdater(prev, update)
    if (next === prev) return
    this.noticesState = next
    plan.domains.add('notices')
    plan.domains.add('all')
    if (!deferEmit) this.emit(plan)
  }

  private patchNav(patch: Partial<NavSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.navState
    const next: NavSlice = { ...prev, ...patch }
    if (next.splitTarget === null && next.focusedPanel !== 'primary') {
      next.focusedPanel = 'primary'
    }
    const top = topDrawerFrame(next.drawerStack)
    next.workbenchOpen = top?.kind === 'workbench'
    if (top?.kind === 'workbench') {
      next.workbenchTab = top.tab
    }
    const primaryChanged = next.primaryTarget !== prev.primaryTarget
    const splitChanged = next.splitTarget !== prev.splitTarget
    const focusedChanged = next.focusedPanel !== prev.focusedPanel
    const collapsedChanged = next.sidebarCollapsed !== prev.sidebarCollapsed
    const escChanged = next.pendingEscAbortConversationId !== prev.pendingEscAbortConversationId
    const drawerStackChanged = !isSameDrawerStack(prev.drawerStack, next.drawerStack)
    if (!drawerStackChanged) {
      next.drawerStack = prev.drawerStack
    }
    const wbChanged = next.workbenchOpen !== prev.workbenchOpen || next.workbenchTab !== prev.workbenchTab
    const modalChanged = next.activeModal !== prev.activeModal
    const highlightChanged = next.highlightedEntry !== prev.highlightedEntry

    if (
      !primaryChanged &&
      !splitChanged &&
      !focusedChanged &&
      !collapsedChanged &&
      !escChanged &&
      !drawerStackChanged &&
      !wbChanged &&
      !modalChanged &&
      !highlightChanged
    ) {
      return
    }

    this.navState = next
    this.targets.current = { primaryTarget: next.primaryTarget, splitTarget: next.splitTarget }
    this.focusedPanelRef.current = next.focusedPanel
    this.drawerStackRef.current = next.drawerStack
    this.workbenchOpenRef.current = next.workbenchOpen
    this.activeModalRef.current = next.activeModal

    plan.domains.add('nav')
    plan.domains.add('all')
    if (primaryChanged) plan.domains.add('primaryTarget')
    if (splitChanged) plan.domains.add('splitTarget')
    if (focusedChanged) plan.domains.add('focusedPanel')
    if (primaryChanged || splitChanged || focusedChanged) {
      this.locationTargetsSlice = {
        primaryTarget: next.primaryTarget,
        splitTarget: next.splitTarget,
        focusedPanel: next.focusedPanel,
      }
      plan.domains.add('locationTargets')
    }
    if (collapsedChanged) plan.domains.add('sidebarCollapsed')
    if (escChanged) plan.domains.add('pendingEscAbort')
    if (drawerStackChanged) plan.domains.add('drawerStack')
    if (wbChanged) {
      this.workbenchSlice = {
        workbenchOpen: next.workbenchOpen,
        workbenchTab: next.workbenchTab,
      }
      plan.domains.add('workbench')
    }
    if (modalChanged) plan.domains.add('activeModal')
    if (primaryChanged || splitChanged || drawerStackChanged || modalChanged) {
      this.locationStateCache = {
        primaryTarget: next.primaryTarget,
        splitTarget: next.splitTarget,
        drawerStack: next.drawerStack,
        activeModal: next.activeModal,
      }
      plan.domains.add('locationState')
    }
    if (highlightChanged) {
      plan.domains.add('highlightedEntry')
      if (prev.highlightedEntry !== null) plan.highlightIds.add(prev.highlightedEntry.conversationId)
      if (next.highlightedEntry !== null) plan.highlightIds.add(next.highlightedEntry.conversationId)
    }

    if (!deferEmit) this.emit(plan)
  }

  // ---- Preferences Actions --------------------------------------------------

  setThemePreference = (pref: ThemePreference): void => {
    const effective = resolveTheme(pref)
    applyDocumentTheme(effective)
    persistThemePreference(pref)
    this.patchPrefs({ themePreference: pref, theme: effective })
  }

  setTheme = (next: ThemeMode): void => {
    this.setThemePreference(next)
  }

  toggleTheme = (): void => {
    this.setThemePreference(nextThemePreference(this.prefsState.themePreference))
  }

  setLocalePreference = (next: LocalePreference): void => {
    const effective = resolveLocale(next)
    applyDocumentLocale(effective)
    persistLocalePreference(next)
    this.patchPrefs({ localePreference: next, locale: effective })
  }

  setLocale = (next: HelmxLocale): void => {
    this.setLocalePreference(next)
  }

  setQuietNotify = async (on: boolean): Promise<void> => {
    if (!on) {
      persistQuietNotify(false)
      this.patchPrefs({ quietNotifyEnabled: false })
      return
    }
    const permission = await requestBrowserNotificationPermission()
    if (permission === 'unsupported') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Notifications unsupported in this browser', 'zh-CN': '当前浏览器不支持通知' }),
        body: this.translate({
          en: 'The browser notification API is unavailable, so background notification alerts cannot be enabled.',
          'zh-CN': '浏览器通知 API 不可用，无法开启后台通知提醒。',
        }),
      })
      return
    }
    if (permission !== 'granted') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Browser notification permission not granted', 'zh-CN': '浏览器通知权限未授予' }),
        body: this.translate({
          en: 'Allow notifications in the browser site settings, then enable background notifications again.',
          'zh-CN': '请在浏览器站点设置中允许通知后重新开启。',
        }),
      })
      return
    }
    persistQuietNotify(true)
    this.patchPrefs({ quietNotifyEnabled: true })
  }

  // ---- Notices & Auth & Logout ----------------------------------------------

  dismissNotice = (id: string): void => {
    if (!this.noticesState.some((item) => item.id === id)) return
    this.setNotices((prev) => prev.filter((notice) => notice.id !== id))
  }

  pushNotice = (notice: Omit<ToastNotice, 'id' | 'createdAt'>): void => {
    const id = `notice-${++this.noticeSequence}`
    this.setNotices((prev) => [
      ...prev.filter((item) => item.title !== notice.title || item.body !== notice.body),
      { ...notice, id, createdAt: Date.now() },
    ])
    if (notice.level === 'info') {
      this.requests.delay(() => this.dismissNotice(id), 6000)
    }
  }

  checkAuth = async (): Promise<void> => {
    this.patchAuth({ authError: null })
    try {
      const status = await authApi.status()
      this.patchAuth({ authConfigured: status.configured, authenticated: status.authenticated, authReady: true })
    } catch (error) {
      this.patchAuth({
        authReady: true,
        authError: this.translate({
          en: `Cannot connect to the Helmx kernel: ${errorText(error)}`,
          'zh-CN': `无法连接 Helmx 内核：${errorText(error)}`,
        }),
      })
    }
  }

  onAuthenticated = async (token: string): Promise<void> => {
    setStoredToken(token)
    this.patchAuth({ authConfigured: true, authError: null, authenticated: true })
  }

  /** Resets non-URL refs, timers, and caches before the provider resets window.history. */
  prepareLogoutHistoryReset(): void {
    this.clearEscTimer()
    this.requests.resetOnLogout()
    this.sseCursorRef.current = null
    resetStandbyDrafts()
    resetPluginClientCache()
    resetSessionDocSubscriptions()
    setStoredToken(null)
    this.lastSyncedLocation.current = parseLocationHash('#/settings/profiles')
    this.pendingHistoryMode.current = null
  }

  /** Clears all reactive store slices in one atomic batch on logout. */
  finishLogoutStateReset(): void {
    const plan = emptyPlan()
    this.patchAuth({ authenticated: false, sseConnected: false, connectionError: null }, plan, true)
    this.spaceMemory = { settings: { kind: 'profiles' } }
    this.patchNav(
      {
        activeModal: null,
        splitTarget: null,
        focusedPanel: 'primary',
        primaryTarget: { kind: 'profiles' },
        drawerStack: [],
        workbenchTab: DEFAULT_WORKBENCH_TAB,
        pendingEscAbortConversationId: null,
        highlightedEntry: null,
      },
      plan,
      true,
    )
    this.updateLive(emptyLiveState, plan, true)
    this.setConversationArtifacts({}, plan, true)
    this.setLoadErrors({}, plan, true)
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
    this.patchCatalog(
      {
        profilesLoaded: false,
        assetsLoaded: false,
        profiles: [],
        models: [],
        modelDefaults: {},
        providers: [],
        credentials: [],
        skills: [],
        actions: [],
      },
      plan,
      true,
    )
    this.emit(plan)
  }

  // ---- Assets, Plugins & Nodes ----------------------------------------------

  refreshAssets = async (): Promise<void> => {
    const { generation, controller } = this.requests.beginAssetRefresh()
    const signal = controller.signal
    const isStale = (): boolean => generation !== this.requests.assetGeneration.current || signal.aborted

    const profilesTask = assetsApi.listProfiles({ signal }).then(
      (list) => {
        if (isStale()) return
        const plan = emptyPlan()
        this.patchCatalog({ profiles: list, profilesLoaded: true }, plan, true)
        if (Object.hasOwn(this.loadErrorsState, 'assets:profiles')) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors['assets:profiles']
          this.setLoadErrors(nextErrors, plan, true)
        }
        this.emit(plan)
      },
      (reason: unknown) => {
        if (isAbortError(reason) || isStale()) return
        const plan = emptyPlan()
        this.patchCatalog({ profilesLoaded: true }, plan, true)
        const nextMessage = errorText(reason)
        if (this.loadErrorsState['assets:profiles'] !== nextMessage) {
          this.setLoadErrors({ ...this.loadErrorsState, 'assets:profiles': nextMessage }, plan, true)
        }
        this.emit(plan)
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.translate(ASSET_LOAD_FAILURE_TITLES[0]!),
          body: nextMessage,
        })
      },
    )

    const otherTasks = Promise.allSettled([
      assetsApi.listModels({ signal }),
      assetsApi.listProviders({ signal }),
      assetsApi.listCredentials({ signal }),
      assetsApi.listSkills({ signal }),
      pluginsApi.listActions({ signal }),
    ]).then((results) => {
      if (isStale()) return
      const patch: Partial<CatalogSlice> = {}
      if (results[0].status === 'fulfilled') {
        const catalog = results[0].value
        const { models, ...modelDefaults } = catalog
        patch.models = models
        patch.modelDefaults = modelDefaults
      }
      if (results[1].status === 'fulfilled') patch.providers = results[1].value
      if (results[2].status === 'fulfilled') patch.credentials = results[2].value
      if (results[3].status === 'fulfilled') patch.skills = results[3].value
      if (results[4].status === 'fulfilled') patch.actions = results[4].value
      this.patchCatalog(patch)
      results.forEach((result, index) => {
        if (result.status === 'rejected' && !isAbortError(result.reason)) {
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate(ASSET_LOAD_FAILURE_TITLES[index + 1]!),
            body: errorText(result.reason),
          })
        }
      })
    })

    await Promise.all([profilesTask, otherTasks])
    if (isStale()) return
    this.requests.finishAssetRefresh(controller)
    this.patchCatalog({ assetsLoaded: true })
  }

  /**
   * HTTP 全量插件摘要校准（如 PluginCenter 安装/更新/卸载后的 GET /api/plugins）：
   * - 按 `sameJsonValue` 保留未变更插件引用；
   * - 立即清理非 active（disabled / enabled=true,status=failed）及已移除插件的 `uiContributions`、
   *   `pluginDocs`、`sessionDocs` 与 doc 请求/错误；
   * - 对 active 插件的非纯配置变更（`clientHashes` / 非配置元数据变化）及非 active→active 恢复，
   *   清理对应 `doc:<pluginId>/` 文档缓存、`failedDocs`、`requests`、`loadErrors` 并递增 `pluginEpoch`；
   *   纯 `publicConfig` 变更全部保留；
   * - 按摘要增量对账 `reconcilePluginClientCache`（逐出停用/失败/移除或 hash 变更模块与样式，推进 revision）；
   * - 架构边界：`GET /api/plugins` 仅返回 `PluginSummary[]` 不含 `PluginUiContribution[]`（内核未暴露 HTTP `listUi`），
   *   对仍 active 插件保留既有 `uiContributions`，新增或结构变更的 UI 贡献仍由 SSE `plugin.changed` / `snapshot` 收敛。
   */
  syncPlugins = (next: PluginSummary[]): void => {
    if (!Array.isArray(next)) return
    const plan = emptyPlan()
    const reconciled = reconcilePluginsState(this.liveState, next)

    if (reconciled.state !== this.liveState) {
      this.updateLive(() => reconciled.state, plan, true)
    }

    if (reconciled.invalidatedDocPluginIds.size > 0) {
      for (const pluginId of reconciled.invalidatedDocPluginIds) {
        const docPrefix = `doc:${pluginId}/`
        this.requests.pluginEpoch.current.set(
          pluginId,
          (this.requests.pluginEpoch.current.get(pluginId) ?? 0) + 1,
        )
        for (const key of [...this.requests.failedDocs.current]) {
          if (key.startsWith(docPrefix)) this.requests.failedDocs.current.delete(key)
        }
        for (const key of [...this.requests.requests.current.keys()]) {
          if (key.startsWith(docPrefix)) this.requests.requests.current.delete(key)
        }
      }
      this.setLoadErrors(
        (prev) => omitPluginDocLoadErrors(prev, reconciled.invalidatedDocPluginIds),
        plan,
        true,
      )
    }

    reconcilePluginClientCache(reconciled.state.plugins)
    for (const pluginId of reconciled.inactivePluginIds) {
      evictSessionDocSubscriptions(pluginId)
    }

    this.emit(plan)
  }

  refreshNodes = async (): Promise<NodeInfo[] | undefined> => {
    const epoch = this.requests.session.current
    const nodesBeforeRequest = this.liveState.nodes
    try {
      const list = await nodesApi.list()
      if (epoch !== this.requests.session.current) return undefined
      const sorted = sortNodes(list)
      this.updateLive((state) => (state.nodes === nodesBeforeRequest ? { ...state, nodes: sorted } : state))
      return this.liveState.nodes
    } catch (error) {
      if (epoch === this.requests.session.current) {
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.translate({ en: 'Compute nodes failed to load', 'zh-CN': '计算节点加载失败' }),
          body: errorText(error),
        })
      }
      return undefined
    }
  }

  // ---- Conversations & Plugin Docs Requests ---------------------------------

  loadConversationDetail = async (
    id: number,
    force = false,
    opts?: { silent?: boolean; limit?: number },
  ): Promise<ConversationDetail | undefined> => {
    const key = `conversation:${id}`
    const existing = this.requests.requests.current.get(key)
    if (existing) return existing as Promise<ConversationDetail | undefined>
    if (!force && this.liveState.conversationDetails[id]) return this.liveState.conversationDetails[id]

    const silent = opts?.silent === true
    const hasCached = this.liveState.conversationDetails[id] !== undefined
    const limit = opts?.limit ?? defaultConversationDetailLimit()

    return this.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) this.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || this.liveState.conversationDetails[id] === undefined) {
          this.reportLoad(key, error)
        }
      },
      exec: async ({ signal, isStale }) => {
        const detail = await conversationsApi.getDetail(id, { limit, signal })
        if (isStale()) return undefined
        const plan = emptyPlan()
        if (Object.hasOwn(this.loadErrorsState, key)) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors[key]
          this.setLoadErrors(nextErrors, plan, true)
        }
        this.updateLive((state) => mergeConversationDetail(state, detail), plan, true)
        this.emit(plan)
        return detail
      },
    })
  }

  loadEarlierEntries = async (id: number): Promise<void> => {
    const detail = this.liveState.conversationDetails[id]
    if (!detail?.nextCursor) return
    const key = `history:${id}`
    if (this.requests.requests.current.has(key)) return
    const limit = defaultConversationDetailLimit()
    const cursor = detail.nextCursor

    await this.requests.runControlled<void>({
      key,
      onStart: () => {
        this.reportLoad(key)
      },
      onError: (error) => {
        this.reportLoad(key, error)
      },
      exec: async ({ signal, isStale }) => {
        const page = await conversationsApi.getDetail(id, { limit, cursor, signal })
        if (isStale()) return undefined
        this.updateLive((state) => mergeConversationDetail(state, page, true))
        return undefined
      },
    })
  }

  backfillConversationEntry = (conversationId: number, entry: ConversationEntry): void => {
    this.updateLive((state) => applyConversationEntry(state, conversationId, entry))
  }

  loadConversationArtifacts = async (
    id: number,
    opts?: { silent?: boolean },
  ): Promise<ArtifactMetadata[] | undefined> => {
    const key = `artifacts:${id}`
    const existing = this.requests.requests.current.get(key)
    if (existing) {
      const latest = this.summaryById.get(id) ?? this.liveState.conversationDetails[id]
      const inFlight = this.requests.artifactsInFlight.get(id)
      const latestActive = latest !== undefined && isConversationStatusActive(latest.status)
      if (
        latest !== undefined &&
        !latestActive &&
        (inFlight === undefined ||
          inFlight.active ||
          inFlight.watermark === undefined ||
          inFlight.watermark.stateChangeSeq !== latest.stateChangeSeq ||
          inFlight.watermark.lastEntryId !== latest.lastEntryId)
      ) {
        this.requests.dirtyArtifacts.add(id)
      }
      return existing as Promise<ArtifactMetadata[] | undefined>
    }

    const silent = opts?.silent === true
    const hasCached = this.artifactsState[id] !== undefined
    const sampledSummary = this.summaryById.get(id)
    const sampledActive = sampledSummary !== undefined && isConversationStatusActive(sampledSummary.status)
    const sampledWatermark =
      sampledSummary !== undefined && !sampledActive
        ? { stateChangeSeq: sampledSummary.stateChangeSeq, lastEntryId: sampledSummary.lastEntryId }
        : undefined
    const sessionEpoch = this.requests.session.current
    const reqEpochBefore = this.requests.requestEpochs.get(key) ?? 0
    this.requests.artifactsInFlight.set(id, { active: sampledActive, watermark: sampledWatermark })
    this.requests.dirtyArtifacts.delete(id)

    const result = await this.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) this.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || this.artifactsState[id] === undefined) {
          this.reportLoad(key, error)
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate({ en: 'Conversation artifacts failed to load', 'zh-CN': '会话产物加载失败' }),
            body: errorText(error),
            conversationId: id,
          })
        }
      },
      exec: async ({ signal, isStale }) => {
        const list = await conversationsApi.listArtifacts(id, { signal })
        if (isStale()) return undefined
        const plan = emptyPlan()
        if (Object.hasOwn(this.loadErrorsState, key)) {
          const nextErrors = { ...this.loadErrorsState }
          delete nextErrors[key]
          this.setLoadErrors(nextErrors, plan, true)
        }
        const reconciled = reconcileArtifactList(this.artifactsState[id], list)
        this.setConversationArtifacts(
          (prev) => (prev[id] === reconciled ? prev : { ...prev, [id]: reconciled }),
          plan,
          true,
        )
        this.emit(plan)
        const latestSummary = this.summaryById.get(id) ?? this.liveState.conversationDetails[id]
        const latestActive = latestSummary !== undefined && isConversationStatusActive(latestSummary.status)
        if (!sampledActive && !latestActive && !this.requests.dirtyArtifacts.has(id)) {
          const resolvedWatermark =
            sampledWatermark ??
            (latestSummary !== undefined
              ? { stateChangeSeq: latestSummary.stateChangeSeq, lastEntryId: latestSummary.lastEntryId }
              : undefined)
          if (resolvedWatermark !== undefined) this.requests.artifactsWatermarks.current.set(id, resolvedWatermark)
          else this.requests.artifactsWatermarks.current.delete(id)
        } else {
          this.requests.artifactsWatermarks.current.delete(id)
        }
        return reconciled
      },
    })

    if (sessionEpoch === this.requests.session.current && (this.requests.requestEpochs.get(key) ?? 0) === reqEpochBefore + 1) {
      this.requests.artifactsInFlight.delete(id)
      if (this.requests.dirtyArtifacts.delete(id)) {
        return await this.loadConversationArtifacts(id, { silent: true })
      }
    }
    return result
  }

  ensurePluginDoc = async (pluginId: string, name: string): Promise<unknown> => {
    const docKey = `${pluginId}/${name}`
    const key = `doc:${docKey}`
    if (Object.hasOwn(this.liveState.pluginDocs, docKey)) return this.liveState.pluginDocs[docKey]
    if (this.requests.failedDocs.current.has(key)) return undefined
    const existing = this.requests.requests.current.get(key)
    if (existing) return existing

    const epoch = this.requests.session.current
    const pluginVersion = this.requests.pluginEpoch.current.get(pluginId)
    const task = pluginsApi
      .getPublicDoc(pluginId, name)
      .then((doc) => {
        if (epoch !== this.requests.session.current || pluginVersion !== this.requests.pluginEpoch.current.get(pluginId)) {
          return undefined
        }
        if (this.liveState.plugins.some((p) => p.id === pluginId && isPluginSummaryActive(p))) {
          const plan = emptyPlan()
          this.requests.failedDocs.current.delete(key)
          if (!Object.hasOwn(this.liveState.pluginDocs, docKey)) {
            this.updateLive(
              (state) =>
                Object.hasOwn(state.pluginDocs, docKey) ||
                !state.plugins.some((p) => p.id === pluginId && isPluginSummaryActive(p))
                  ? state
                  : { ...state, pluginDocs: { ...state.pluginDocs, [docKey]: doc.value } },
              plan,
              true,
            )
          }
          if (Object.hasOwn(this.loadErrorsState, key)) {
            const nextErrors = { ...this.loadErrorsState }
            delete nextErrors[key]
            this.setLoadErrors(nextErrors, plan, true)
          }
          this.emit(plan)
        }
        return doc.value
      })
      .catch((error: unknown) => {
        if (epoch === this.requests.session.current && pluginVersion === this.requests.pluginEpoch.current.get(pluginId)) {
          this.requests.failedDocs.current.add(key)
          this.reportLoad(key, error)
          this.pushNotice({
            type: 'notification',
            level: 'error',
            title: this.translate({ en: 'Plugin state failed to load', 'zh-CN': '插件状态读取失败' }),
            body: this.translate({
              en: `${pluginId}/${name}: ${errorText(error)}`,
              'zh-CN': `${pluginId}/${name}：${errorText(error)}`,
            }),
          })
        }
        return undefined
      })
      .finally(() => {
        if (this.requests.requests.current.get(key) === task) this.requests.requests.current.delete(key)
      })
    this.requests.requests.current.set(key, task)
    return task
  }

  getPluginSessionDoc = async (pluginId: string, docName: string, conversationId: number): Promise<unknown> => {
    const doc = await pluginsApi.getPublicSessionDoc(pluginId, docName, conversationId)
    return doc.value
  }

  invokePluginAction = async (pluginId: string, actionId: string, input: unknown, conversationId?: number) =>
    pluginsApi.invokeAction(pluginId, actionId, input, conversationId)

  // ---- Navigation, Shortcuts & Esc-Abort ------------------------------------

  /** 空间记忆写入的唯一入口：总览是有专属入口的顶层目的地，不占对话空间
   *  的记忆位——boot 初始化、程序导航（applyPrimaryTarget/openTarget）与
   *  hashchange 同步（applyExternalLocation）全部经此收敛，「对话」空间按钮
   *  永远跳回最近的真实会话/待命目标，绝不被总览劫持（含 #/overview 直达
   *  后的刷新场景）。 */
  private rememberSpaceTarget(target: ResolvedTarget): void {
    if (target.kind === 'overview') return
    this.spaceMemory[spaceForTarget(target)] = target
  }

  applyPrimaryTarget = (target: ResolvedTarget): void => {
    this.rememberSpaceTarget(target)
    this.patchNav({ primaryTarget: target })
  }

  setSplitTarget = (update: StoreUpdater<ResolvedTarget | null>): void => {
    const next = applyUpdater(this.navState.splitTarget, update)
    this.patchNav({ splitTarget: next })
  }

  setFocusedPanel = (panel: FocusedPanel): void => {
    const next = resolveFocusedPanel(panel, this.navState.splitTarget)
    this.patchNav({ focusedPanel: next })
  }

  closeSplit = (): void => {
    this.patchNav({ splitTarget: null, focusedPanel: 'primary' })
  }

  setSidebarCollapsed = (collapsed: boolean): void => {
    persistSidebarCollapsed(collapsed)
    this.patchNav({ sidebarCollapsed: collapsed })
  }

  toggleSidebarCollapsed = (): void => {
    const next = !this.navState.sidebarCollapsed
    persistSidebarCollapsed(next)
    this.patchNav({ sidebarCollapsed: next })
  }

  private resolveActiveStageConversationId(): number | undefined {
    const focused = resolveFocusedPanel(this.navState.focusedPanel, this.navState.splitTarget)
    const activeTarget = activeTargetForPanel(this.navState.primaryTarget, this.navState.splitTarget, focused)
    const fallbackTarget = focused === 'split' ? this.navState.primaryTarget : this.navState.splitTarget
    if (activeTarget.kind === 'conversation') return activeTarget.conversationId
    if (fallbackTarget?.kind === 'conversation') return fallbackTarget.conversationId
    return undefined
  }

  openConversationDrawer = (conversationId: number): void => {
    const nextStack = pushDrawerFrame(this.navState.drawerStack, { kind: 'conversation', conversationId })
    this.patchNav({ drawerStack: nextStack })
  }

  openWorkbenchDrawer = (options?: { tab?: string; conversationId?: number }): void => {
    const top = topDrawerFrame(this.navState.drawerStack)
    const underlyingConvId = topConversationDrawerId(this.navState.drawerStack)
    const stageConvId = this.resolveActiveStageConversationId()
    let frameConversationId: number | undefined
    if (options?.conversationId !== undefined) {
      frameConversationId =
        underlyingConvId === undefined && options.conversationId === stageConvId
          ? undefined
          : options.conversationId
    } else if (top?.kind === 'workbench') {
      frameConversationId = top.conversationId
    } else if (underlyingConvId !== undefined) {
      frameConversationId = underlyingConvId
    }
    const tab = normalizeWorkbenchTab(
      options?.tab ?? (top?.kind === 'workbench' ? top.tab : this.navState.workbenchTab),
    )
    const nextFrame: DrawerFrame =
      frameConversationId !== undefined
        ? { kind: 'workbench', conversationId: frameConversationId, tab }
        : { kind: 'workbench', tab }
    const nextStack = pushDrawerFrame(this.navState.drawerStack, nextFrame)
    this.patchNav({ drawerStack: nextStack, workbenchTab: tab })
  }

  popDrawer = (): void => {
    if (this.navState.drawerStack.length === 0) return
    this.patchNav({ drawerStack: popDrawerFrame(this.navState.drawerStack) })
  }

  truncateDrawerStack = (index: number): void => {
    if (this.navState.drawerStack.length === 0) return
    this.patchNav({ drawerStack: truncateDrawerStackTo(this.navState.drawerStack, index) })
  }

  closeAllDrawers = (): void => {
    if (this.navState.drawerStack.length === 0) return
    this.patchNav({ drawerStack: [] })
  }

  pruneConversationFromDrawerStack = (conversationId: number): void => {
    const nextStack = removeConversationFromDrawerStack(this.navState.drawerStack, conversationId)
    if (nextStack !== this.navState.drawerStack) {
      this.patchNav({ drawerStack: nextStack })
    }
  }

  setWorkbenchOpen = (update: StoreUpdater<boolean>): void => {
    const currentlyOpen = topDrawerFrame(this.navState.drawerStack)?.kind === 'workbench'
    const next = applyUpdater(currentlyOpen, update)
    if (next === currentlyOpen) return
    if (next) {
      this.openWorkbenchDrawer()
    } else {
      this.popDrawer()
    }
  }

  setWorkbenchTab = (update: StoreUpdater<string>): void => {
    const top = topDrawerFrame(this.navState.drawerStack)
    const currentTab = top?.kind === 'workbench' ? top.tab : this.navState.workbenchTab
    const nextTab = normalizeWorkbenchTab(applyUpdater(currentTab, update))
    const nextStack = updateTopWorkbenchTab(this.navState.drawerStack, nextTab)
    this.patchNav({ drawerStack: nextStack, workbenchTab: nextTab })
  }

  setActiveModal = (update: StoreUpdater<ActiveModal>): void => {
    const next = applyUpdater(this.navState.activeModal, update)
    // 顶层预览弹窗（文件/产物/命令面板）与右侧抽屉栈正交：互不覆盖、各自按叠层关闭。
    this.patchNav({ activeModal: next })
  }

  openTarget = (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ): void => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, this.liveState.conversations) : target
    if (!resolved) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.targetNotReady'),
        body: typeof target === 'string' ? target : this.tt('shell.nav.invalidTarget'),
      })
      return
    }
    if (opts?.history !== undefined) this.pendingHistoryMode.current = opts.history
    const patch: Partial<NavSlice> = {}
    if (opts?.split) {
      patch.splitTarget = resolved
    } else {
      // 总览不占对话空间记忆位（rememberSpaceTarget 内置守卫，见其注释）。
      this.rememberSpaceTarget(resolved)
      patch.primaryTarget = resolved
      // 主屏导航离开当前视图时收起覆盖型抽屉栈：抽屉内徽标/通知等触发的
      // openTarget 若不收抽屉，新目标被抽屉遮挡，表现为「点击无反应」。
      // 深链恢复（applyExternalLocation）不走此路径，组合态仍可精确还原。
      if (this.navState.drawerStack.length > 0) patch.drawerStack = []
    }
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) {
      patch.highlightedEntry = { conversationId: resolved.conversationId, entryId: opts.highlightEntryId }
    }
    this.patchNav(patch)
  }

  openSpace = (space: SidebarSpace): void => {
    const input: SpaceTargetInput = {
      conversations: this.liveState.conversations,
      profiles: this.catalogState.profiles,
      plugins: this.liveState.plugins,
      assetsLoaded: this.catalogState.profilesLoaded || this.catalogState.assetsLoaded,
      grouped: this.groupedUi,
    }
    const resolution = resolveSpaceSwitch(space, this.navState.primaryTarget, this.spaceMemory, input)
    if (resolution.kind === 'already-in-space') return
    if (resolution.clearStaleMemory) delete this.spaceMemory[space]
    if (resolution.kind === 'unavailable') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.noOpenableEntry'),
        body: space === 'views' ? this.tt('shell.nav.noViewsBody') : this.tt('shell.nav.noConversationsBody'),
      })
      return
    }
    this.openTarget(resolution.target, { history: 'push' })
  }

  setScreenParams = (
    patch: Record<string, string | undefined>,
    options?: { split?: boolean; push?: boolean },
  ): void => {
    const { validEntries, invalidKeys } = partitionScreenParamsPatch(patch)
    for (const key of invalidKeys) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.translate({ en: 'Ignored invalid Screen parameter key', 'zh-CN': '已忽略非法 Screen 参数键' }),
        body: this.translate({
          en: `Parameter ${key} must use a valid key and a string value`,
          'zh-CN': `参数 ${key} 必须使用合法键和字符串值`,
        }),
      })
    }
    const currentTarget = options?.split ? this.navState.splitTarget : this.navState.primaryTarget
    if (validEntries.length === 0 || (currentTarget?.kind !== 'screen' && currentTarget?.kind !== 'overview')) return
    if (options?.push) this.pendingHistoryMode.current = 'push'
    if (options?.split) {
      this.setSplitTarget((current) => (current === null ? current : applyScreenParamsPatch(current, validEntries)))
    } else {
      this.applyPrimaryTarget(applyScreenParamsPatch(currentTarget, validEntries))
    }
  }

  applyExternalLocation = (parsed: WorkspaceLocationState): void => {
    this.pendingHistoryMode.current = null
    this.lastSyncedLocation.current = parsed
    this.rememberSpaceTarget(parsed.primaryTarget)
    const top = topDrawerFrame(parsed.drawerStack)
    this.patchNav({
      primaryTarget: parsed.primaryTarget,
      splitTarget: parsed.splitTarget,
      drawerStack: parsed.drawerStack,
      ...(top?.kind === 'workbench' ? { workbenchTab: top.tab } : {}),
      activeModal: parsed.activeModal,
    })
  }

  performHomeLanding(initialLocation: WorkspaceLocationState): void {
    if (!isSameLocationState(this.locationStateCache, initialLocation)) return
    const input: SpaceTargetInput = {
      conversations: this.liveState.conversations,
      profiles: this.catalogState.profiles,
      plugins: this.liveState.plugins,
      assetsLoaded: this.catalogState.profilesLoaded || this.catalogState.assetsLoaded,
      grouped: this.groupedUi,
    }
    // 并发主入口：非全新系统（存在可见根会话树，与总览暴露边界同口径）冷
    // 启动以 replace 落到会话总览；全新/清空系统回退对话空间缺省目标
    // （最新根会话所属角色的待命页，无会话时首个可用角色），保住首次
    // 部署打开即能打字的体验。
    if (hasVisibleConversationRoots(input)) {
      this.openTarget({ kind: 'overview' }, { history: 'replace' })
      return
    }
    const home = defaultSpaceTarget('conversations', input)
    if (home === null) return
    this.openTarget(home, { history: 'replace' })
  }

  stepHighlightedEntry(): void {
    const current = this.navState.highlightedEntry
    if (current === null) return
    const detail = this.liveState.conversationDetails[current.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, current.entryId))
    if (matched) {
      if (matched.id !== current.entryId) {
        this.patchNav({ highlightedEntry: { ...current, entryId: matched.id } })
        return
      }
      this.requests.delay(() => {
        if (this.navState.highlightedEntry === current) {
          this.patchNav({ highlightedEntry: null })
        }
      }, 5000)
    } else if (detail.nextCursor && !this.loadErrorsState[`history:${detail.id}`]) {
      void this.loadEarlierEntries(detail.id)
    } else if (!detail.nextCursor) {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.nav.searchEntryGone'),
        conversationId: detail.id,
      })
      this.patchNav({ highlightedEntry: null })
    }
  }

  clearEscAbortPrompt = (): void => {
    this.clearEscTimer()
    const plan = emptyPlan()
    if (this.navState.pendingEscAbortConversationId !== null) {
      this.patchNav({ pendingEscAbortConversationId: null }, plan, true)
    }
    if (this.noticesState.some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      this.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
    this.emit(plan)
  }

  private armEscAbortPrompt(conversationId: number): void {
    this.clearEscTimer()
    const plan = emptyPlan()
    this.patchNav({ pendingEscAbortConversationId: conversationId }, plan, true)
    this.setNotices(
      (prev) => [
        ...prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID),
        {
          id: ESC_ABORT_NOTICE_ID,
          type: 'notification',
          level: 'warning',
          title: this.tt('shell.esc.confirmTitle'),
          body: this.tt('shell.esc.confirmBody'),
          conversationId,
          createdAt: Date.now(),
        },
      ],
      plan,
      true,
    )
    this.emit(plan)

    this.escAbortTimer = setTimeout(() => {
      this.escAbortTimer = null
      this.clearEscAbortPrompt()
    }, this.escAbortWindowMs)
  }

  confirmOrArmEscAbort = (conversationId: number): void => {
    if (this.navState.pendingEscAbortConversationId === conversationId) {
      this.clearEscAbortPrompt()
      void conversationsApi.abort(conversationId).catch((error: unknown) => {
        this.pushNotice({
          type: 'notification',
          level: 'error',
          title: this.tt('shell.esc.abortFailedTitle'),
          body: errorText(error),
          conversationId,
        })
      })
    } else {
      this.armEscAbortPrompt(conversationId)
    }
  }
}
