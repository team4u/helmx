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
import type { WorkspaceConversationNode } from '../conversation/workspace-file-url.js'
import { ESC_ABORT_WINDOW_MS, getStoredSidebarCollapsed } from '../shell/shortcuts-model.js'
import { setStoredToken, type ModelCatalogDefaults, type ModelDescriptor } from './api.js'
import { requestBrowserNotificationPermission } from './browser-notification.js'
import { DEFAULT_WORKBENCH_TAB, isSameDrawerStack, topDrawerFrame, type DrawerFrame } from './drawer-stack-model.js'
import { errorText } from './error-text.js'
import { emptyLiveState, type LiveState, type SseCursor } from './live-state.js'
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
import type {
  ActiveModal,
  FocusedPanel,
  GroupedUiSpecs,
  HelmxStoreValue,
  LocalePreference,
  ResolvedTarget,
  ThemeMode,
  ThemePreference,
  ToastNotice,
} from './types.js'
import { isSameLocationState, parseLocationHash, type WorkspaceLocationState } from './url-hash-model.js'
import { StoreAuthController } from './store/auth-controller.js'
import {
  addChangedRecordKeys,
  addChangedStringKeys,
  applyUpdater,
  emptyPlan,
  hasNotifyChanges,
  mergeNotifyPlan,
} from './store/helpers.js'
import { StoreLiveController } from './store/live-index.js'
import { createStoreNavActions, type StoreNavActions } from './store/nav-actions.js'
import { StoreNoticeController } from './store/notice-timers.js'
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
  StoreBootLocation,
  StoreDomainKey,
  StoreListener,
  StoreUpdater,
  WorkbenchParamsState,
  WorkbenchSlice,
}

const INFO_NOTICE_DURATION_MS = 6000

export class HelmxExternalStore {
  readonly requests = new StoreRequestManager()
  private readonly bus = new StoreSubscriptionBus()
  private readonly notices: StoreNoticeController
  private readonly auth: StoreAuthController
  private readonly live: StoreLiveController

  sseCursor: SseCursor | null = null
  lastSyncedLocation: WorkspaceLocationState
  pendingHistoryMode: 'push' | 'replace' | null = null

  private readonly bootInitialLocation: WorkspaceLocationState
  private readonly bootNeedsHomeLanding: boolean
  private homeLandingSettled: boolean
  private homeLandingPendingCache: boolean

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
  private hostModelsSlice: HostModelsSlice | undefined = undefined
  private modelsLoaded = false
  private hostProfilesSlice: HostProfilesSlice | undefined = undefined
  private artifactsState: Record<number, ArtifactMetadata[]> = {}
  private loadErrorsState: Record<string, string> = {}
  private navState: NavSlice
  private locationTargetsSlice: LocationTargetsSlice
  private workbenchSlice: WorkbenchSlice
  private locationStateCache: WorkspaceLocationState
  private fullSnapshotCache: HelmxStoreValue | null = null
  private batchDepth = 0
  private batchPlan: NotifyPlan | null = null

  readonly requestActions: StoreRequestActions
  readonly navActions: StoreNavActions
  readonly actions: HelmxStoreActions

  constructor(
    bootLocation: WorkspaceLocationState,
    options?: { needsHomeLanding?: boolean; escAbortWindowMs?: number; infoNoticeDurationMs?: number },
  ) {
    this.bootInitialLocation = bootLocation
    this.bootNeedsHomeLanding = options?.needsHomeLanding ?? false
    this.homeLandingSettled = !this.bootNeedsHomeLanding

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

    this.notices = new StoreNoticeController({
      infoNoticeDurationMs: options?.infoNoticeDurationMs ?? INFO_NOTICE_DURATION_MS,
      onEmit: this.emit,
    })
    this.auth = new StoreAuthController({
      onEmit: this.emit,
      tt: (key, params) => this.tt(key, params),
    })
    this.live = new StoreLiveController({
      onEmit: this.emit,
      getLocale: () => this.prefsState.locale,
    })

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
    this.homeLandingPendingCache = this.computeHomeLandingPending()

    this.requestActions = createStoreRequestActions({
      requests: this.requests,
      getLiveState: this.getLiveState,
      getConversationSummary: this.getConversationSummary,
      getConversationArtifactsMap: this.getConversationArtifactsMap,
      getLoadErrorsMap: this.getLoadErrorsMap,
      translate: this.translate,
      tt: (key, params) => this.tt(key, params),
      emit: this.emit,
      patchCatalog: (patch, plan, deferEmit) => this.patchCatalog(patch, plan, deferEmit),
      updateLive: this.updateLive,
      setConversationArtifacts: this.setConversationArtifacts,
      setLoadErrors: this.setLoadErrors,
      reportLoad: this.reportLoad,
      pushNotice: this.pushNotice,
    })

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
        loadEarlierEntries: this.requestActions.loadEarlierEntries,
      },
      { escAbortWindowMs: options?.escAbortWindowMs ?? ESC_ABORT_WINDOW_MS },
    )

    this.navActions.rememberSpaceTarget(bootLocation.primaryTarget)

    this.actions = {
      setTheme: this.setTheme,
      setThemePreference: this.setThemePreference,
      toggleTheme: this.toggleTheme,
      setLocale: this.setLocale,
      setLocalePreference: this.setLocalePreference,
      setQuietNotify: this.setQuietNotify,
      checkAuth: this.checkAuth,
      onAuthenticated: this.onAuthenticated,
      logout: this.logout,
      refreshAssets: this.requestActions.refreshAssets,
      syncPlugins: this.requestActions.syncPlugins,
      refreshNodes: this.requestActions.refreshNodes,
      loadConversationDetail: this.requestActions.loadConversationDetail,
      loadEarlierEntries: this.requestActions.loadEarlierEntries,
      backfillConversationEntry: this.requestActions.backfillConversationEntry,
      loadConversationArtifacts: this.requestActions.loadConversationArtifacts,
      ensurePluginDoc: this.requestActions.ensurePluginDoc,
      retryPluginDoc: this.requestActions.retryPluginDoc,
      subscribeSessionDoc,
      getSessionDocState,
      getPluginSessionDoc: this.requestActions.getPluginSessionDoc,
      retrySessionDoc,
      openTarget: this.navActions.openTarget,
      closeSplit: this.navActions.closeSplit,
      setFocusedPanel: this.navActions.setFocusedPanel,
      setSidebarCollapsed: this.navActions.setSidebarCollapsed,
      toggleSidebarCollapsed: this.navActions.toggleSidebarCollapsed,
      setScreenParams: this.navActions.setScreenParams,
      setWorkbenchOpen: this.navActions.setWorkbenchOpen,
      setWorkbenchTab: this.navActions.setWorkbenchTab,
      openConversationDrawer: this.navActions.openConversationDrawer,
      openWorkbenchDrawer: this.navActions.openWorkbenchDrawer,
      popDrawer: this.navActions.popDrawer,
      truncateDrawerStack: this.navActions.truncateDrawerStack,
      closeAllDrawers: this.navActions.closeAllDrawers,
      openSpace: this.navActions.openSpace,
      setActiveModal: this.navActions.setActiveModal,
      dismissNotice: this.dismissNotice,
      pauseNoticeTimer: this.pauseNoticeTimer,
      resumeNoticeTimer: this.resumeNoticeTimer,
      pushNotice: this.pushNotice,
      invokePluginAction: this.requestActions.invokePluginAction,
    }
  }

  bindLogout(fn: () => void): () => void {
    return this.auth.bindLogout(fn)
  }

  dispose(): void {
    this.auth.cancelInFlightAuthCheck()
    this.navActions.clearEscTimer()
    this.notices.clearAllTimers()
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

  subscribeHighlightForConversation = (conversationId: number, listener: StoreListener): (() => void) =>
    this.bus.subscribeHighlightForConversation(conversationId, listener)

  subscribeLoadError = (key: string, listener: StoreListener): (() => void) =>
    this.bus.subscribeLoadError(key, listener)

  subscribePluginDoc = (docKey: string, listener: StoreListener): (() => void) =>
    this.bus.subscribePluginDoc(docKey, listener)

  subscribePlugin = (pluginId: string, listener: StoreListener): (() => void) =>
    this.bus.subscribePlugin(pluginId, listener)

  // ---- Cached Snapshot Getters ----------------------------------------------

  getAuthSlice = (): AuthSlice => this.auth.getAuthSlice()
  getAuthenticated = (): boolean => this.auth.getAuthenticated()
  getSseConnected = (): boolean => this.auth.getSseConnected()
  getPrefsSlice = (): PrefsSlice => this.prefsState
  getTheme = (): ThemeMode => this.prefsState.theme
  getLocale = (): HelmxLocale => this.prefsState.locale
  getCatalogSlice = (): CatalogSlice => this.catalogState
  getProfilesSlice = (): ProfilesSlice => this.profilesSlice
  getModels = (): ModelDescriptor[] => this.catalogState.models
  getModelDefaults = (): ModelCatalogDefaults => this.catalogState.modelDefaults
  getHostModelsSlice = (): HostModelsSlice | undefined => this.hostModelsSlice
  getHostNodesSlice = (): HostNodesSlice | undefined => this.live.getHostNodesSlice()
  getHostProfilesSlice = (): HostProfilesSlice | undefined => this.hostProfilesSlice
  getProviders = (): ProviderConfig[] => this.catalogState.providers
  getCredentials = (): CredentialSummary[] => this.catalogState.credentials
  getSkills = (): SkillSummary[] => this.catalogState.skills
  getActionsList = (): ActionManifest[] => this.catalogState.actions
  getLiveState = (): LiveState => this.live.getLiveState()
  getConversations = (): ConversationSummary[] => this.live.getConversations()
  getConversationDetailsMap = (): Record<number, ConversationDetail> => this.live.getConversationDetailsMap()
  getConversationLivesMap = (): Record<number, ConversationLive> => this.live.getConversationLivesMap()
  getConversationArtifactsMap = (): Record<number, ArtifactMetadata[]> => this.artifactsState
  getPendingAsks = (): AskSpec[] => this.live.getPendingAsks()
  getPlugins = (): PluginSummary[] => this.live.getPlugins()
  getPluginSummary = (pluginId: string): PluginSummary | undefined => this.live.getPluginSummary(pluginId)
  getGroupedUi = (): GroupedUiSpecs => this.live.getGroupedUi()
  getPluginsUiSlice = (): PluginsUiSlice => this.live.getPluginsUiSlice()
  getPluginsSnapshot = (): UsePluginsResult => this.live.getPluginsSnapshot()
  getPluginDocsMap = (): Record<string, unknown> => this.live.getPluginDocsMap()
  getNodes = (): NodeInfo[] => this.live.getNodes()
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
  getConversationBackgroundSlice = (): ConversationBackgroundSlice => this.live.getConversationBackgroundSlice()
  getHighlightedEntry = (): { conversationId: number; entryId: string } | null => this.navState.highlightedEntry
  getHomeLandingPending = (): boolean => this.homeLandingPendingCache
  getNotices = (): ToastNotice[] => this.notices.getNotices()

  getConversationLive = (id: number): ConversationLive | undefined => this.live.getConversationLive(id)
  getConversationDetail = (id: number): ConversationDetail | undefined => this.live.getConversationDetail(id)
  getConversationSummary = (id: number): ConversationSummary | undefined => this.live.getConversationSummary(id)
  getConversationTreeWorkspaces = (id: number): ReadonlyArray<WorkspaceConversationNode> =>
    this.live.getConversationTreeWorkspaces(id)
  getConversationArtifacts = (id: number): ArtifactMetadata[] | undefined => this.artifactsState[id]
  getConversationPendingAsks = (id: number): AskSpec[] => this.live.getConversationPendingAsks(id)
  getHighlightedEntryForConversation = (id: number): { conversationId: number; entryId: string } | null =>
    this.navState.highlightedEntry?.conversationId === id ? this.navState.highlightedEntry : null
  getLoadError = (key: string): string | undefined => this.loadErrorsState[key]
  hasPluginDoc = (docKey: string): boolean => this.live.hasPluginDoc(docKey)
  getPluginDoc = (docKey: string): unknown => this.live.getPluginDoc(docKey)

  getSnapshot = (): HelmxStoreValue => {
    if (this.fullSnapshotCache !== null) return this.fullSnapshotCache
    const next: HelmxStoreValue = {
      ...this.live.getLiveSnapshotFields(),
      ...this.auth.getAuthSlice(),
      ...this.prefsState,
      profiles: this.catalogState.profiles,
      profilesLoaded: this.catalogState.profilesLoaded,
      assetsLoaded: this.catalogState.assetsLoaded,
      models: this.catalogState.models,
      providers: this.catalogState.providers,
      credentials: this.catalogState.credentials,
      skills: this.catalogState.skills,
      actions: this.catalogState.actions,
      conversationArtifacts: this.artifactsState,
      loadErrors: this.loadErrorsState,
      ...this.navState,
      notices: this.notices.getNotices(),
      ...this.actions,
    }
    this.fullSnapshotCache = next
    return next
  }

  // ---- Atomic Commit / Notification Engine ----------------------------------

  private emit = (plan: NotifyPlan): void => {
    if (!hasNotifyChanges(plan)) return
    this.fullSnapshotCache = null
    this.navActions.reconcileEscAbort(plan)
    if (this.batchDepth > 0 && this.batchPlan !== null) {
      mergeNotifyPlan(this.batchPlan, plan)
      return
    }
    this.bus.dispatch(plan)
  }

  /** Coalesce all synchronous store mutations within `fn` into a single deduplicated listener flush. */
  runInBatch = <T>(fn: () => T): T => {
    this.batchDepth += 1
    if (this.batchPlan === null) {
      this.batchPlan = emptyPlan()
    }
    try {
      return fn()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.batchPlan !== null) {
        const accumulated = this.batchPlan
        this.batchPlan = null
        if (hasNotifyChanges(accumulated)) {
          this.bus.dispatch(accumulated)
        }
      }
    }
  }

  // ---- Internal Mutators (also form the hydration surface for test/helpers/store.ts) ----

  private patchAuth(patch: Partial<AuthSlice>, plan = emptyPlan(), deferEmit = false): void {
    this.auth.patchAuth(patch, plan, deferEmit)
  }

  setSseConnected = (update: StoreUpdater<boolean>): void => {
    this.auth.setSseConnected(update)
  }

  setConnectionError = (update: StoreUpdater<string | null>): void => {
    this.auth.setConnectionError(update)
  }

  setKernelBootId = (update: StoreUpdater<string | null>): void => {
    this.auth.setKernelBootId(update)
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
      this.live.recomputeBackground(plan, { panelsOrConversations: false, locale: true })
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
    const prevModelsLoaded = this.modelsLoaded
    const nextModelsLoaded =
      patch.assetsLoaded === false
        ? false
        : patch.models !== undefined
          ? true
          : prevModelsLoaded
    if (nextModelsLoaded !== prevModelsLoaded) {
      this.modelsLoaded = nextModelsLoaded
      changed = true
    }
    if (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults) {
      plan.domains.add('models')
      changed = true
    }
    const prevHostModelsReady = prev.assetsLoaded && prevModelsLoaded
    const nextHostModelsReady = next.assetsLoaded && nextModelsLoaded
    if (
      nextHostModelsReady !== prevHostModelsReady ||
      (nextHostModelsReady && (next.models !== prev.models || next.modelDefaults !== prev.modelDefaults))
    ) {
      this.hostModelsSlice = nextHostModelsReady ? { models: next.models, ...next.modelDefaults } : undefined
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
    this.live.updateLive(update, plan, deferEmit)
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
    this.notices.setNotices(update, plan, deferEmit)
  }

  private computeHomeLandingPending(): boolean {
    if (this.homeLandingSettled || !this.bootNeedsHomeLanding) return false
    return isSameLocationState(this.locationStateCache, this.bootInitialLocation)
  }

  settleHomeLanding = (): void => {
    if (this.homeLandingSettled) return
    this.runInBatch(() => {
      this.homeLandingSettled = true
      if (this.homeLandingPendingCache) {
        this.homeLandingPendingCache = false
        const plan = emptyPlan()
        plan.domains.add('homeLanding')
        this.emit(plan)
      }
      this.navActions.performHomeLanding(this.bootInitialLocation)
    })
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
      const nextPending = this.computeHomeLandingPending()
      if (nextPending !== this.homeLandingPendingCache) {
        this.homeLandingPendingCache = nextPending
        plan.domains.add('homeLanding')
      }
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
        title: this.tt('shell.notify.unsupportedTitle'),
        body: this.tt('shell.notify.unsupportedBody'),
      })
      return
    }
    if (permission !== 'granted') {
      this.pushNotice({
        type: 'notification',
        level: 'warning',
        title: this.tt('shell.notify.permissionDeniedTitle'),
        body: this.tt('shell.notify.permissionDeniedBody'),
      })
      return
    }
    persistQuietNotify(true)
    this.patchPrefs({ quietNotifyEnabled: true })
  }

  // ---- Notices & Auth & Logout ----------------------------------------------

  dismissNotice = (id: string): void => {
    this.notices.dismissNotice(id)
  }

  pauseNoticeTimer = (id: string): void => {
    this.notices.pauseNoticeTimer(id)
  }

  resumeNoticeTimer = (id: string): void => {
    this.notices.resumeNoticeTimer(id)
  }

  pushNotice = (notice: Omit<ToastNotice, 'id' | 'createdAt'>): void => {
    this.notices.pushNotice(notice)
  }

  checkAuth = (): Promise<void> => this.auth.checkAuth()

  onAuthenticated = (token: string): Promise<void> => this.auth.onAuthenticated(token)

  logout = (): void => {
    this.auth.logout(() => {
      this.prepareLogoutHistoryReset()
      this.finishLogoutStateReset()
    })
  }

  /** Resets non-URL timers and caches before the provider resets window.history. */
  prepareLogoutHistoryReset(): void {
    this.auth.cancelInFlightAuthCheck()
    this.navActions.clearEscTimer()
    this.notices.clearAllTimers()
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
    this.auth.cancelInFlightAuthCheck()
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
    this.notices.clearEscAbortNotice(plan, true)
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
