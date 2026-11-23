/**
 * Shared slice, subscription, and notification types for HelmxExternalStore.
 */
import type {
  ActionManifest,
  CredentialSummary,
  HelmxLocale,
  PluginSummary,
  PluginUiContribution,
  Profile,
  ProviderConfig,
  SkillSummary,
} from '@helmx/protocol/browser'
import type { ModelCatalogDefaults, ModelDescriptor } from '../api.js'
import type { DrawerFrame } from '../drawer-stack-model.js'
import type {
  ActiveModal,
  FocusedPanel,
  GroupedUiSpecs,
  HelmxStoreValue,
  LocalePreference,
  ResolvedTarget,
  SidebarConversationMode,
  ThemeMode,
  ThemePreference,
} from '../types.js'
import type { WorkspaceLocationState } from '../url-hash-model.js'
import type { BackgroundBadgeDocRef, ConversationBackgroundIndex } from '../../shell/background-activity-model.js'

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
  sidebarConvMode: SidebarConversationMode
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

export interface WorkbenchParamsState {
  tab: string
  conversationId?: number
  params: Readonly<Record<string, unknown>>
}

export interface WorkbenchSlice {
  workbenchOpen: boolean
  workbenchTab: string
  workbenchParams: WorkbenchParamsState | null
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
  workbenchParams: WorkbenchParamsState | null
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
  | 'setSidebarConvMode'
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
  | 'retryPluginDoc'
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
  | 'sidebarConvMode'
  | 'catalog'
  | 'profiles'
  | 'hostProfiles'
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
  | 'hostNodes'
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

export interface NotifyPlan {
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
  pluginIds: Set<string>
}
