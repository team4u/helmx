/**
 * 测试 store 工厂（纯 web 模块，不引入 @helmx/plugin-client 的 Radix 依赖图）：
 * happy-dom 环境下需要交互式展开 Radix 浮层的测试遵循「GlobalRegistrator.register()
 * 之后再动态加载」约定；本模块可被静态导入而不破坏该约定。Provider 栈见
 * helpers/host-store.ts（复用生产 PluginClientHostBridge，需按约定动态加载）。
 *
 * 工厂构造真实 HelmxExternalStore 并水合确定性默认值 + 用例覆写：
 * - live / artifacts / loadErrors 经公开同步 setter（updateLive 等，与 SSE 同链路）；
 * - auth / prefs / catalog / nav / notices 经 store 内部补丁方法（TS private 仅编译期，
 *   这里以结构化类型访问并做运行时守卫；store 内部改名时此处显式报错而非静默造假）；
 * - 动作函数不可覆写——真实 store 提供真实动作，用例经可观察状态断言行为。
 */
import { HelmxExternalStore, type AuthSlice, type CatalogSlice, type NavSlice, type PrefsSlice } from '../../src/lib/helmx-store.js'
import { emptyLiveState, resetSseClientTimings } from '../../src/lib/live-state.js'
import { resetSessionDocTimings } from '../../src/lib/session-docs.js'
import { resetVersionWatchTimings } from '../../src/shell/version-watch-model.js'
import { resetCompletionQueryDebounceMs } from '../../src/conversation/composer-completion-model.js'
import { resetSymmetricBackFallbackMs } from '../../src/lib/url-hash-model.js'
import { resetOverviewSearchDebounceMs } from '../../src/overview/overview-timing.js'
import { HelmxExternalStoreContext } from '../../src/lib/store-context.js'
import type { HelmxStoreValue, ToastNotice } from '../../src/lib/types.js'
import { testResetCallbacks } from './store-reset-registry.js'

export { HelmxExternalStoreContext }

const activeTestStores = new Set<HelmxExternalStore>()

/** 恢复所有可测试覆盖的 Web 时序默认值。 */
export function resetWebTestTimings(): void {
  resetSseClientTimings()
  resetSessionDocTimings()
  resetVersionWatchTimings()
  resetCompletionQueryDebounceMs()
  resetSymmetricBackFallbackMs()
  resetOverviewSearchDebounceMs()
}

/** 清理通过 `makeTestStore()` 创建且尚未手动释放的测试 store（消除泄漏定时器）。 */
export function disposeTestStores(): void {
  for (const store of [...activeTestStores]) {
    store.dispose()
  }
  activeTestStores.clear()
  resetWebTestTimings()
}

testResetCallbacks.add(disposeTestStores)
// 仅在 dom-shared 预加载器已初始化集合时登记（禁写 globalThis 属性，避免影响 AST 纯度分池）。
const domResetCallbacks = (globalThis as { __helmxDomResetCallbacks?: Set<() => void> }).__helmxDomResetCallbacks
domResetCallbacks?.add(disposeTestStores)

/** 状态覆写面：沿用历史字段名；groupedUi 由 store 从 uiContributions 派生（与生产同链路），
 * 动作函数不可覆写（真实 store 提供真实动作）——类型层显式排除，避免静默丢弃。 */
export type TestStoreOverrides = Omit<
  Partial<HelmxStoreValue>,
  | 'groupedUi'
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
  | 'focusSearchAnchor'
  | 'clearSearchFocusAnchor'
  | 'dismissNotice'
  | 'pauseNoticeTimer'
  | 'resumeNoticeTimer'
  | 'pushNotice'
  | 'invokePluginAction'
> & {
  modelDefaults?: CatalogSlice['modelDefaults']
}

/** HelmxExternalStore 的内部补丁面（仅测试水合使用）。 */
interface StoreHydrationSurface {
  patchAuth(patch: Partial<AuthSlice>): void
  patchPrefs(patch: Partial<PrefsSlice>): void
  patchCatalog(patch: Partial<CatalogSlice>): void
  patchNav(patch: Partial<NavSlice>): void
  setNotices(update: ToastNotice[] | ((prev: ToastNotice[]) => ToastNotice[])): void
}

function hydrationSurface(store: HelmxExternalStore): StoreHydrationSurface {
  const surface = store as unknown as StoreHydrationSurface
  for (const key of ['patchAuth', 'patchPrefs', 'patchCatalog', 'patchNav', 'setNotices'] as const) {
    if (typeof surface[key] !== 'function') {
      throw new Error(`HelmxExternalStore hydration surface changed: ${key} missing; update test/helpers/store.ts`)
    }
  }
  return surface
}

export function makeTestStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  const {
    authReady, authConfigured, authenticated, authError, connectionError, sseConnected, kernelBootId,
    theme, themePreference, locale, localePreference, quietNotifyEnabled,
    conversations, conversationDetails, conversationLives, pendingAsks,
    plugins, uiContributions, pluginDocs, nodes, nodesLoaded,
    conversationArtifacts, loadErrors,
    profiles, profilesLoaded, assetsLoaded, models, modelDefaults, providers, credentials, skills, actions, pluginConfigCatalog,
    primaryTarget, splitTarget, focusedPanel, sidebarCollapsed, pendingEscAbortConversationId,
    drawerStack, workbenchOpen, workbenchTab, activeModal, highlightedEntry, searchFocusAnchor,
    notices,
  } = overrides

  const initialDrawerStack =
    drawerStack !== undefined
      ? drawerStack
      : workbenchOpen
        ? [{ kind: 'workbench' as const, tab: workbenchTab ?? 'artifacts' }]
        : []

  const store = new HelmxExternalStore({
    primaryTarget: primaryTarget ?? { kind: 'conversation', conversationId: 1 },
    splitTarget: splitTarget ?? null,
    drawerStack: initialDrawerStack,
    activeModal: activeModal ?? null,
  })
  const hydrate = hydrationSurface(store)

  hydrate.patchAuth({
    authReady: authReady ?? true,
    authConfigured: authConfigured ?? true,
    authenticated: authenticated ?? true,
    authError: authError ?? null,
    connectionError: connectionError ?? null,
    sseConnected: sseConnected ?? true,
    kernelBootId: kernelBootId ?? null,
  })
  hydrate.patchPrefs({
    theme: theme ?? 'dark',
    themePreference: themePreference ?? 'system',
    locale: locale ?? 'en',
    localePreference: localePreference ?? locale ?? 'en',
    quietNotifyEnabled: quietNotifyEnabled ?? false,
  })
  hydrate.patchCatalog({
    profiles: profiles ?? [],
    profilesLoaded: profilesLoaded ?? true,
    assetsLoaded: assetsLoaded ?? true,
    models: models ?? [],
    ...(modelDefaults !== undefined ? { modelDefaults } : {}),
    providers: providers ?? [],
    credentials: credentials ?? [],
    skills: skills ?? [],
    actions: actions ?? [],
    pluginConfigCatalog: pluginConfigCatalog ?? [],
  })
  hydrate.patchNav({
    focusedPanel: focusedPanel ?? 'primary',
    sidebarCollapsed: sidebarCollapsed ?? false,
    pendingEscAbortConversationId: pendingEscAbortConversationId ?? null,
    ...(workbenchTab !== undefined ? { workbenchTab } : {}),
    highlightedEntry: highlightedEntry ?? null,
    searchFocusAnchor: searchFocusAnchor ?? null,
  })
  store.updateLive(() => ({
    ...emptyLiveState(),
    conversations: conversations ?? [],
    conversationDetails: conversationDetails ?? {},
    conversationLives: conversationLives ?? {},
    pendingAsks: pendingAsks ?? [],
    plugins: plugins ?? [],
    uiContributions: uiContributions ?? [],
    pluginDocs: pluginDocs ?? {},
    nodes: nodes ?? [],
    nodesLoaded: nodesLoaded ?? true,
  }))
  if (conversationArtifacts !== undefined) store.setConversationArtifacts(conversationArtifacts)
  if (loadErrors !== undefined) store.setLoadErrors(loadErrors)
  if (notices !== undefined) hydrate.setNotices(notices)
  activeTestStores.add(store)
  const origDispose = store.dispose.bind(store)
  store.dispose = () => {
    activeTestStores.delete(store)
    origDispose()
  }
  return store
}
