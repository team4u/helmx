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
  ConversationLive,
  ConversationSummary,
  CredentialSummary,
  HelmxLocale,
  HostModelsSlice,
  HostNodesSlice,
  HostProfilesSlice,
  LocalizedText,
  NodeInfo,
  PluginSummary,
  ProviderConfig,
  SkillSummary,
  UsePluginsResult,
} from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import { createWebTranslator, type WebMessageKey } from '../i18n/catalog.js'
import { resetStandbyDrafts } from '../conversation/standby-model.js'
import { ESC_ABORT_WINDOW_MS, getStoredSidebarCollapsed } from '../shell/shortcuts-model.js'
import { authApi, setStoredToken, type ModelCatalogDefaults, type ModelDescriptor } from './api.js'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import { DEFAULT_WORKBENCH_TAB, isSameDrawerStack, topDrawerFrame, type DrawerFrame } from './drawer-stack-model.js'
import { errorText } from './error-text.js'
import { emptyLiveState, type LiveState } from './live-state.js'
import { resetPluginClientCache } from './plugin-client.js'
import { StoreRequestManager } from './request-manager.js'
import { getSessionDocState, resetSessionDocSubscriptions, retrySessionDoc, subscribeSessionDoc } from './session-docs.js'
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
  groupUiContributions,
  type ActiveModal,
  type FocusedPanel,
  type GroupedUiSpecs,
  type HelmxStoreValue,
  type LocalePreference,
  type ResolvedTarget,
  type ThemeMode,
  type ThemePreference,
  type ToastNotice,
} from './types.js'
import { parseLocationHash, type WorkspaceLocationState } from './url-hash-model.js'
import type { SseCursor } from './use-sse-events.js'
import { recomputeConversationBackgroundSlice } from './store/background-slice.js'
import {
  addChangedRecordKeys,
  addChangedStringKeys,
  applyUpdater,
  EMPTY_BACKGROUND_INDEX,
  EMPTY_BADGE_DOCS,
  EMPTY_PENDING_ASKS,
  EMPTY_PENDING_BADGE_DOCS,
  emptyPlan,
  ESC_ABORT_NOTICE_ID,
  hasNotifyChanges,
  isSameAskArray,
  shallowEqualAuth,
} from './store/helpers.js'
import { createStoreNavActions, type StoreNavActions } from './store/nav-actions.js'
import { createStoreRequestActions, type StoreRequestActions } from './store/requests-actions.js'
import { StoreSubscriptionBus } from './store/subscriptions.js'
import type {
  AuthSlice,
  CatalogSlice,
  ConversationBackgroundSlice,
  HelmxStoreActions,
  LocationTargetsSlice,
  NavSlice,
  NotifyPlan,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  ResolvedAskEntry,
  StoreBootLocation,
  StoreDomainKey,
  StoreListener,
  StoreUpdater,
  WorkbenchParamsState,
  WorkbenchSlice,
} from './store/types.js'

export type {
  AuthSlice,
  CatalogSlice,
  ConversationBackgroundSlice,
  HelmxStoreActions,
  LocationTargetsSlice,
  NavSlice,
  PluginsUiSlice,
  PrefsSlice,
  ProfilesSlice,
  ResolvedAskEntry,
  StoreBootLocation,
  StoreDomainKey,
  StoreListener,
  StoreUpdater,
  WorkbenchParamsState,
  WorkbenchSlice,
}

const INFO_NOTICE_DURATION_MS = 6000
const NOTICE_RESUME_GRACE_MS = 800

interface NoticeTimerEntry {
  timer: ReturnType<typeof setTimeout> | null
  remainingMs: number
  startedAt: number | null
}

export class HelmxExternalStore {
  readonly requests = new StoreRequestManager()
  private readonly bus = new StoreSubscriptionBus()

  sseCursor: SseCursor | null = null
  lastSyncedLocation: WorkspaceLocationState
  pendingHistoryMode: 'push' | 'replace' | null = null

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
  private hostNodesSlice: HostNodesSlice | undefined = undefined
  private hostProfilesSlice: HostProfilesSlice | undefined = undefined
  private summaryById = new Map<number, ConversationSummary>()
  private pluginById = new Map<string, PluginSummary>()
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
  private readonly infoNoticeDurationMs: number
  private readonly noticeTimers = new Map<string, NoticeTimerEntry>()
  private logoutImpl: (() => void) | null = null
  private readonly requestActions: StoreRequestActions
  private readonly navActions: StoreNavActions

  // Bound public methods (delegated to domain action slices)
  readonly refreshAssets: StoreRequestActions['refreshAssets']
  readonly syncPlugins: StoreRequestActions['syncPlugins']
  readonly refreshNodes: StoreRequestActions['refreshNodes']
  readonly loadConversationDetail: StoreRequestActions['loadConversationDetail']
  readonly loadEarlierEntries: StoreRequestActions['loadEarlierEntries']
  readonly backfillConversationEntry: StoreRequestActions['backfillConversationEntry']
  readonly loadConversationArtifacts: StoreRequestActions['loadConversationArtifacts']
  readonly ensurePluginDoc: StoreRequestActions['ensurePluginDoc']
  readonly retryPluginDoc: StoreRequestActions['retryPluginDoc']
  readonly getPluginSessionDoc: StoreRequestActions['getPluginSessionDoc']
  readonly invokePluginAction: StoreRequestActions['invokePluginAction']

  readonly applyPrimaryTarget: StoreNavActions['applyPrimaryTarget']
  readonly setSplitTarget: StoreNavActions['setSplitTarget']
  readonly setFocusedPanel: StoreNavActions['setFocusedPanel']
  readonly closeSplit: StoreNavActions['closeSplit']
  readonly setSidebarCollapsed: StoreNavActions['setSidebarCollapsed']
  readonly toggleSidebarCollapsed: StoreNavActions['toggleSidebarCollapsed']
  readonly openConversationDrawer: StoreNavActions['openConversationDrawer']
  readonly openWorkbenchDrawer: StoreNavActions['openWorkbenchDrawer']
  readonly popDrawer: StoreNavActions['popDrawer']
  readonly truncateDrawerStack: StoreNavActions['truncateDrawerStack']
  readonly closeAllDrawers: StoreNavActions['closeAllDrawers']
  readonly pruneConversationFromDrawerStack: StoreNavActions['pruneConversationFromDrawerStack']
  readonly setWorkbenchOpen: StoreNavActions['setWorkbenchOpen']
  readonly setWorkbenchTab: StoreNavActions['setWorkbenchTab']
  readonly setActiveModal: StoreNavActions['setActiveModal']
  readonly openTarget: StoreNavActions['openTarget']
  readonly openSpace: StoreNavActions['openSpace']
  readonly setScreenParams: StoreNavActions['setScreenParams']
  readonly applyExternalLocation: StoreNavActions['applyExternalLocation']
  readonly performHomeLanding: StoreNavActions['performHomeLanding']
  readonly stepHighlightedEntry: StoreNavActions['stepHighlightedEntry']
  readonly clearEscAbortPrompt: StoreNavActions['clearEscAbortPrompt']
  readonly confirmOrArmEscAbort: StoreNavActions['confirmOrArmEscAbort']

  readonly actions: HelmxStoreActions

  constructor(bootLocation: WorkspaceLocationState, options?: { escAbortWindowMs?: number; infoNoticeDurationMs?: number }) {
    this.infoNoticeDurationMs = options?.infoNoticeDurationMs ?? INFO_NOTICE_DURATION_MS
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
      workbenchParams: null,
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
      workbenchParams: null,
    }
    this.locationStateCache = {
      primaryTarget: this.navState.primaryTarget,
      splitTarget: this.navState.splitTarget,
      drawerStack: this.navState.drawerStack,
      activeModal: this.navState.activeModal,
    }
    this.lastSyncedLocation = bootLocation

    this.requestActions = createStoreRequestActions({
      requests: this.requests,
      getLiveState: this.getLiveState,
      getConversationSummary: this.getConversationSummary,
      getConversationArtifactsMap: this.getConversationArtifactsMap,
      getLoadErrorsMap: this.getLoadErrorsMap,
      translate: this.translate,
      emit: this.emit,
      patchCatalog: (patch, plan, deferEmit) => this.patchCatalog(patch, plan, deferEmit),
      updateLive: this.updateLive,
      setConversationArtifacts: this.setConversationArtifacts,
      setLoadErrors: this.setLoadErrors,
      reportLoad: this.reportLoad,
      pushNotice: this.pushNotice,
    })

    this.refreshAssets = this.requestActions.refreshAssets
    this.syncPlugins = this.requestActions.syncPlugins
    this.refreshNodes = this.requestActions.refreshNodes
    this.loadConversationDetail = this.requestActions.loadConversationDetail
    this.loadEarlierEntries = this.requestActions.loadEarlierEntries
    this.backfillConversationEntry = this.requestActions.backfillConversationEntry
    this.loadConversationArtifacts = this.requestActions.loadConversationArtifacts
    this.ensurePluginDoc = this.requestActions.ensurePluginDoc
    this.retryPluginDoc = this.requestActions.retryPluginDoc
    this.getPluginSessionDoc = this.requestActions.getPluginSessionDoc
    this.invokePluginAction = this.requestActions.invokePluginAction

    this.navActions = createStoreNavActions(
      {
        requests: this.requests,
        setLastSyncedLocation: (value) => { this.lastSyncedLocation = value },
        setPendingHistoryMode: (value) => { this.pendingHistoryMode = value },
        getNavSlice: this.getNavSlice,
        getLocationState: this.getLocationState,
        getLiveState: this.getLiveState,
        getCatalogSlice: this.getCatalogSlice,
        getGroupedUi: this.getGroupedUi,
        getConversationSummary: this.getConversationSummary,
        getLoadErrorsMap: this.getLoadErrorsMap,
        getNotices: this.getNotices,
        translate: this.translate,
        tt: (key, params) => this.tt(key, params),
        emit: this.emit,
        patchNav: (patch, plan, deferEmit) => this.patchNav(patch, plan, deferEmit),
        setNotices: this.setNotices,
        pushNotice: this.pushNotice,
        loadEarlierEntries: this.loadEarlierEntries,
      },
      { escAbortWindowMs: options?.escAbortWindowMs ?? ESC_ABORT_WINDOW_MS },
    )

    this.navActions.rememberSpaceTarget(bootLocation.primaryTarget)

    this.applyPrimaryTarget = this.navActions.applyPrimaryTarget
    this.setSplitTarget = this.navActions.setSplitTarget
    this.setFocusedPanel = this.navActions.setFocusedPanel
    this.closeSplit = this.navActions.closeSplit
    this.setSidebarCollapsed = this.navActions.setSidebarCollapsed
    this.toggleSidebarCollapsed = this.navActions.toggleSidebarCollapsed
    this.openConversationDrawer = this.navActions.openConversationDrawer
    this.openWorkbenchDrawer = this.navActions.openWorkbenchDrawer
    this.popDrawer = this.navActions.popDrawer
    this.truncateDrawerStack = this.navActions.truncateDrawerStack
    this.closeAllDrawers = this.navActions.closeAllDrawers
    this.pruneConversationFromDrawerStack = this.navActions.pruneConversationFromDrawerStack
    this.setWorkbenchOpen = this.navActions.setWorkbenchOpen
    this.setWorkbenchTab = this.navActions.setWorkbenchTab
    this.setActiveModal = this.navActions.setActiveModal
    this.openTarget = this.navActions.openTarget
    this.openSpace = this.navActions.openSpace
    this.setScreenParams = this.navActions.setScreenParams
    this.applyExternalLocation = this.navActions.applyExternalLocation
    this.performHomeLanding = this.navActions.performHomeLanding
    this.stepHighlightedEntry = this.navActions.stepHighlightedEntry
    this.clearEscAbortPrompt = this.navActions.clearEscAbortPrompt
    this.confirmOrArmEscAbort = this.navActions.confirmOrArmEscAbort

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
      retryPluginDoc: this.retryPluginDoc,
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
      pauseNoticeTimer: this.pauseNoticeTimer,
      resumeNoticeTimer: this.resumeNoticeTimer,
      pushNotice: this.pushNotice,
      invokePluginAction: this.invokePluginAction,
    }
  }

  bindLogout(fn: () => void): void {
    this.logoutImpl = fn
  }

  dispose(): void {
    this.navActions.clearEscTimer()
    this.clearAllNoticeTimers()
    this.requests.dispose()
  }

  translate = (text: LocalizedText): string => resolveLocalizedText(text, this.prefsState.locale)

  private tt(key: WebMessageKey, params?: Record<string, string | number>): string {
    return createWebTranslator(this.prefsState.locale)(key, params as never)
  }

  // ---- Subscriptions --------------------------------------------------------

  subscribeDomain = (key: StoreDomainKey, listener: StoreListener): (() => void) =>
    this.bus.subscribeDomain(key, listener)

  subscribeAll = (listener: StoreListener): (() => void) => this.bus.subscribeDomain('all', listener)

  subscribeConversationLive = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeConversationLive(conversationId, listener)

  subscribeConversationDetail = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeConversationDetail(conversationId, listener)

  subscribeConversationSummary = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeConversationSummary(conversationId, listener)

  subscribeConversationArtifacts = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeConversationArtifacts(conversationId, listener)

  subscribeConversationPendingAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeConversationPendingAsks(conversationId, listener)

  subscribeResolvedAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeResolvedAsks(conversationId, listener)

  subscribeHighlightForConversation = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeHighlightForConversation(conversationId, listener)

  subscribeLoadError = (key: string, listener: StoreListener): (() => void) =>
    this.bus.subscribeLoadError(key, listener)

  subscribePluginDoc = (docKey: string, listener: StoreListener): (() => void) =>
    this.bus.subscribePluginDoc(docKey, listener)

  subscribePlugin = (pluginId: string, listener: StoreListener): (() => void) =>
    this.bus.subscribePlugin(pluginId, listener)

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
  getHostNodesSlice = (): HostNodesSlice | undefined => this.hostNodesSlice
  getHostProfilesSlice = (): HostProfilesSlice | undefined => this.hostProfilesSlice
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
  getPluginSummary = (pluginId: string): PluginSummary | undefined => this.pluginById.get(pluginId)
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
  hasPluginDoc = (docKey: string): boolean => Object.hasOwn(this.liveState.pluginDocs, docKey)
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
    const result = recomputeConversationBackgroundSlice({
      prevSlice: this.conversationBackgroundSlice,
      prevBadgeDocKeys: this.backgroundBadgeDocKeys,
      workbenchPanels: this.groupedUi.workbenchPanels,
      conversations: this.liveState.conversations,
      pluginDocs: this.liveState.pluginDocs,
      locale: this.prefsState.locale,
      triggers,
    })
    this.backgroundBadgeDocKeys = result.badgeDocKeys
    if (!result.changed) return
    this.conversationBackgroundSlice = result.slice
    plan.domains.add('conversationBackground')
  }

  // ---- Atomic Commit / Notification Engine ----------------------------------

  private emit = (plan: NotifyPlan): void => {
    if (!hasNotifyChanges(plan)) return
    this.fullSnapshotCache = null
    this.navActions.reconcileEscAbort(plan)
    this.bus.dispatch(plan)
  }

  // ---- Internal Mutators (also form the hydration surface for test/helpers/store.ts) ----

  private patchAuth(patch: Partial<AuthSlice>, plan = emptyPlan(), deferEmit = false): void {
    const prev = this.authState
    const next: AuthSlice = { ...prev, ...patch }
    if (shallowEqualAuth(prev, next)) return
    this.authState = next
    plan.domains.add('auth')
    plan.domains.add('all')
    if (next.authenticated !== prev.authenticated) plan.domains.add('authenticated')
    if (next.sseConnected !== prev.sseConnected) plan.domains.add('sseConnected')
    if (!deferEmit) this.emit(plan)
  }

  setSseConnected = (update: StoreUpdater<boolean>): void => {
    this.patchAuth({ sseConnected: applyUpdater(this.authState.sseConnected, update) })
  }

  setConnectionError = (update: StoreUpdater<string | null>): void => {
    this.patchAuth({ connectionError: applyUpdater(this.authState.connectionError, update) })
  }

  setKernelBootId = (update: StoreUpdater<string | null>): void => {
    this.patchAuth({ kernelBootId: applyUpdater(this.authState.kernelBootId, update) })
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
    if (next.theme !== prev.theme || next.themePreference !== prev.themePreference) plan.domains.add('theme')
    if (next.locale !== prev.locale || next.localePreference !== prev.localePreference) plan.domains.add('locale')
    if (next.locale !== prev.locale) {
      this.recomputeConversationBackground(plan, { panelsOrConversations: false, locale: true })
    }
    if (next.quietNotifyEnabled !== prev.quietNotifyEnabled) plan.domains.add('quietNotify')
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
      plan.domains.add('profiles')
      changed = true
    }
    if (
      next.profilesLoaded !== prev.profilesLoaded ||
      (next.profilesLoaded && next.profiles !== prev.profiles)
    ) {
      this.hostProfilesSlice = next.profilesLoaded ? next.profiles : undefined
      plan.domains.add('hostProfiles')
      changed = true
    }
    if (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults) {
      plan.domains.add('models')
      changed = true
    }
    if (
      next.assetsLoaded !== prev.assetsLoaded ||
      (next.assetsLoaded && (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults))
    ) {
      this.hostModelsSlice = next.assetsLoaded ? { models: next.models, ...next.modelDefaults } : undefined
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
        if (!this.pendingAsksByConv.has(convId)) plan.pendingAskIds.add(convId)
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
      const nextPluginMap = new Map<string, PluginSummary>()
      for (const plugin of next.plugins) nextPluginMap.set(plugin.id, plugin)
      for (const [id, prevPlugin] of this.pluginById) {
        if (nextPluginMap.get(id) !== prevPlugin) plan.pluginIds.add(id)
      }
      for (const [id, nextPlugin] of nextPluginMap) {
        if (this.pluginById.get(id) !== nextPlugin) plan.pluginIds.add(id)
      }
      this.pluginById = nextPluginMap
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
    if (
      next.nodesLoaded !== prev.nodesLoaded ||
      (next.nodesLoaded && next.nodes !== prev.nodes)
    ) {
      this.hostNodesSlice = next.nodesLoaded ? next.nodes : undefined
      plan.domains.add('hostNodes')
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
    if (!next.workbenchOpen || (next.workbenchParams !== null && next.workbenchParams.tab !== next.workbenchTab)) {
      next.workbenchParams = null
    }
    const primaryChanged = next.primaryTarget !== prev.primaryTarget
    const splitChanged = next.splitTarget !== prev.splitTarget
    const focusedChanged = next.focusedPanel !== prev.focusedPanel
    const collapsedChanged = next.sidebarCollapsed !== prev.sidebarCollapsed
    const escChanged = next.pendingEscAbortConversationId !== prev.pendingEscAbortConversationId
    const drawerStackChanged = !isSameDrawerStack(prev.drawerStack, next.drawerStack)
    if (!drawerStackChanged) next.drawerStack = prev.drawerStack
    const wbChanged =
      next.workbenchOpen !== prev.workbenchOpen ||
      next.workbenchTab !== prev.workbenchTab ||
      next.workbenchParams !== prev.workbenchParams
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
        workbenchParams: next.workbenchParams,
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

  private clearNoticeTimer(id: string): void {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.noticeTimers.delete(id)
  }

  private clearAllNoticeTimers(): void {
    for (const entry of this.noticeTimers.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
    }
    this.noticeTimers.clear()
  }

  private scheduleNoticeTimer(id: string, delayMs: number): void {
    this.clearNoticeTimer(id)
    const entry: NoticeTimerEntry = {
      timer: null,
      remainingMs: delayMs,
      startedAt: Date.now(),
    }
    entry.timer = setTimeout(() => {
      this.noticeTimers.delete(id)
      this.dismissNotice(id)
    }, delayMs)
    this.noticeTimers.set(id, entry)
  }

  dismissNotice = (id: string): void => {
    this.clearNoticeTimer(id)
    if (!this.noticesState.some((item) => item.id === id)) return
    this.setNotices((prev) => prev.filter((notice) => notice.id !== id))
  }

  pauseNoticeTimer = (id: string): void => {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined || entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
    const elapsed = entry.startedAt !== null ? Math.max(0, Date.now() - entry.startedAt) : 0
    const minGrace = Math.min(this.infoNoticeDurationMs, NOTICE_RESUME_GRACE_MS)
    entry.remainingMs = Math.max(minGrace, entry.remainingMs - elapsed)
    entry.startedAt = null
  }

  resumeNoticeTimer = (id: string): void => {
    const entry = this.noticeTimers.get(id)
    if (entry === undefined || entry.timer !== null) return
    if (!this.noticesState.some((item) => item.id === id)) {
      this.noticeTimers.delete(id)
      return
    }
    this.scheduleNoticeTimer(id, entry.remainingMs)
  }

  pushNotice = (notice: Omit<ToastNotice, 'id' | 'createdAt'>): void => {
    const id = `notice-${++this.noticeSequence}`
    for (const existing of this.noticesState) {
      if (existing.title === notice.title && existing.body === notice.body) {
        this.clearNoticeTimer(existing.id)
      }
    }
    this.setNotices((prev) => [
      ...prev.filter((item) => item.title !== notice.title || item.body !== notice.body),
      { ...notice, id, createdAt: Date.now() },
    ])
    if (notice.level === 'info') {
      this.scheduleNoticeTimer(id, this.infoNoticeDurationMs)
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

  /** Resets non-URL timers and caches before the provider resets window.history. */
  prepareLogoutHistoryReset(): void {
    this.navActions.clearEscTimer()
    this.clearAllNoticeTimers()
    this.requests.resetOnLogout()
    this.sseCursor = null
    resetStandbyDrafts()
    resetPluginClientCache()
    resetSessionDocSubscriptions()
    setStoredToken(null)
    this.lastSyncedLocation = parseLocationHash('#/settings/profiles')
    this.pendingHistoryMode = null
  }

  /** Clears all reactive store slices in one atomic batch on logout. */
  finishLogoutStateReset(): void {
    const plan = emptyPlan()
    this.patchAuth({ authenticated: false, sseConnected: false, connectionError: null }, plan, true)
    this.navActions.resetSpaceMemory({ settings: { kind: 'profiles' } })
    this.patchNav(
      {
        activeModal: null,
        splitTarget: null,
        focusedPanel: 'primary',
        primaryTarget: { kind: 'profiles' },
        drawerStack: [],
        workbenchTab: DEFAULT_WORKBENCH_TAB,
        workbenchParams: null,
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
}
