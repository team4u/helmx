import {
  Component,
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ExoticComponent,
  type ReactNode,
} from 'react'
import { HelmxIcon, TooltipProvider } from '@helmx/plugin-client'
import { ConversationPane } from './conversation/ConversationPane.js'
import { ConversationWindowStage } from './conversation/ConversationWindowStage.js'
import { standbyDraftKey } from './conversation/standby-model.js'
import { DrawerStackShell } from './conversation/DrawerStackShell.js'
import { useWebLocale } from './i18n/use-web-locale.js'
import { HelmxStoreProvider } from './lib/HelmxStoreProvider.js'
import {
  useActiveModal,
  useAuthConnection,
  useConversations,
  useDrawerStack,
  useGroupedUi,
  useLocationTargets,
  useProfilesSlice,
  useSidebarCollapsed,
  useStoreActions,
} from './lib/store-context.js'
import {
  hashHasPrimaryTarget,
  isSameLocationState,
  parseLocationHash,
  type WorkspaceLocationState,
} from './lib/url-hash-model.js'
import { isSameResolvedTarget, type ResolvedTarget } from './lib/types.js'
import { ScreenHost } from './screens/ScreenHost.js'
import { AuthGate } from './shell/AuthGate.js'
import { Sidebar } from './shell/Sidebar.js'
import { ToastOverlay } from './shell/ToastOverlay.js'
import { useQuietNotifier } from './shell/use-quiet-notifier.js'
import { useVersionWatcher } from './shell/use-version-watcher.js'
import { versionDeferHint } from './shell/version-watch-model.js'
import { useGlobalAttention } from './shell/use-attention-indicator.js'
import { composeAttentionSummary } from './shell/attention-model.js'
import { extractRailQuickEntries, sidebarBadgeCountLabel } from './shell/sidebar-model.js'
import { useSidebarBadges } from './shell/use-sidebar-badges.js'
import { MobileQuickNav } from './shell/MobileQuickNav.js'
import { useMobileDrawerSwipe } from './shell/use-mobile-drawer-swipe.js'
import { useIsMobileViewport } from './lib/use-media-query.js'
import { loadSplitRatio, saveSplitRatio } from './shell/split-ratio-model.js'
import { SplitResizeHandle } from './ui/SplitResizeHandle.js'

/** SSE 断线横幅展示防抖：短于 1500ms 的瞬断或页面初始握手不闪现重连提示。 */
const CONNECTION_BANNER_DELAY_MS = 1500

const LazyRetryContext = createContext<(() => void) | undefined>(undefined)

interface LazyLoadBoundaryProps {
  children: ReactNode
  onRetry: () => void
  onDismiss?: () => void
  overlay?: boolean
  labels: {
    title: string
    retry: string
    close: string
  }
}

interface LazyLoadBoundaryState {
  error: string | null
}

class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, LazyLoadBoundaryState> {
  state: LazyLoadBoundaryState = { error: null }

  static getDerivedStateFromError(err: unknown): LazyLoadBoundaryState {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const { labels } = this.props
    return (
      <div className={this.props.overlay ? 'lazy-load-error lazy-load-error-overlay' : 'lazy-load-error'} role="alert">
        <div className="callout callout-warn">
          <HelmxIcon name="alert-triangle" size={14} />
          <div className="lazy-load-error-body">
            <strong>{labels.title}</strong>
            <p>{this.state.error}</p>
            <div className="lazy-load-error-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  this.setState({ error: null })
                  this.props.onRetry()
                }}
              >
                {labels.retry}
              </button>
              {this.props.onDismiss !== undefined && (
                <button type="button" className="btn btn-sm" onClick={this.props.onDismiss}>
                  {labels.close}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }
}

function lazyWithRetry<P extends object>(
  createLazy: () => ExoticComponent<P>,
  options?: { overlay?: boolean },
): ComponentType<P> {
  let LazyComp = createLazy()
  return function RetryableLazyView(props: P): ReactNode {
    const { t } = useWebLocale()
    const [attempt, setAttempt] = useState(0)
    const clearPreloadError = useContext(LazyRetryContext)
    const propRecord = props as { onClose?: () => void; onCloseSplit?: () => void }
    const onDismiss = propRecord.onClose ?? propRecord.onCloseSplit
    return (
      <LazyLoadBoundary
        overlay={options?.overlay === true}
        labels={{
          title: t('conv.shell.loadViewFailed'),
          retry: t('common.retry'),
          close: t('common.close'),
        }}
        onRetry={() => {
          LazyComp = createLazy()
          clearPreloadError?.()
          setAttempt((value) => value + 1)
        }}
        {...(onDismiss !== undefined ? { onDismiss } : {})}
      >
        <LazyComp key={attempt} {...props} />
      </LazyLoadBoundary>
    )
  }
}

const AgentStandbyPane = lazyWithRetry(() =>
  lazy(() => import('./conversation/AgentStandbyPane.js').then((m) => ({ default: m.AgentStandbyPane }))),
)
const ConversationOverview = lazyWithRetry(() =>
  lazy(() => import('./overview/ConversationOverview.js').then((m) => ({ default: m.ConversationOverview }))),
)
const ModelCenter = lazyWithRetry(() =>
  lazy(() => import('./models/ModelCenter.js').then((m) => ({ default: m.ModelCenter }))),
)
const NodeCenter = lazyWithRetry(() =>
  lazy(() => import('./nodes/NodeCenter.js').then((m) => ({ default: m.NodeCenter }))),
)
const PluginCenter = lazyWithRetry(() =>
  lazy(() => import('./plugins/PluginCenter.js').then((m) => ({ default: m.PluginCenter }))),
)
const ProfileCenter = lazyWithRetry(() =>
  lazy(() => import('./profiles/ProfileCenter.js').then((m) => ({ default: m.ProfileCenter }))),
)
const SkillCenter = lazyWithRetry(() =>
  lazy(() => import('./skills/SkillCenter.js').then((m) => ({ default: m.SkillCenter }))),
)
const CommandPaletteModal = lazyWithRetry(
  () => lazy(() => import('./modals/CommandPaletteModal.js').then((m) => ({ default: m.CommandPaletteModal }))),
  { overlay: true },
)
const HubChangelogModal = lazyWithRetry(
  () => lazy(() => import('./modals/HubChangelogModal.js').then((m) => ({ default: m.HubChangelogModal }))),
  { overlay: true },
)
const ArtifactPreviewModal = lazyWithRetry(
  () => lazy(() => import('./conversation/ArtifactPreviewModal.js').then((m) => ({ default: m.ArtifactPreviewModal }))),
  { overlay: true },
)
const WorkspaceFilePreviewModal = lazyWithRetry(
  () => lazy(() => import('./conversation/WorkspaceFilePreviewModal.js').then((m) => ({ default: m.WorkspaceFilePreviewModal }))),
  { overlay: true },
)

function renderPaneTarget(
  target: ResolvedTarget,
  options: { panel: 'primary' | 'split'; onCloseSplit?: () => void },
): ReactNode {
  const { panel, onCloseSplit } = options
  const splitProps = panel === 'split' ? { isSplit: true as const, onCloseSplit } : {}

  switch (target.kind) {
    case 'conversation':
      // Primary conversations render through the keep-alive ConversationWindowStage.
      if (panel === 'primary') return null
      return (
        <ConversationPane
          key={`split-conv-${target.conversationId}`}
          conversationId={target.conversationId}
          {...splitProps}
        />
      )
    case 'agent':
      return (
        <AgentStandbyPane
          key={standbyDraftKey({ panel, ...target })}
          profileId={target.profileId}
          nodeId={target.nodeId}
          cwd={target.cwd}
          {...splitProps}
        />
      )
    case 'screen':
      return (
        <ScreenHost
          key={`${panel}-screen-${target.pluginId}-${target.screenId}`}
          pluginId={target.pluginId}
          screenId={target.screenId}
          {...splitProps}
        />
      )
    case 'overview':
      return <ConversationOverview key={`${panel}-overview`} {...splitProps} />
    case 'plugins':
      return <PluginCenter key={`${panel}-plugins`} {...splitProps} />
    case 'profiles':
      return <ProfileCenter key={`${panel}-profiles`} {...splitProps} />
    case 'skills':
      return <SkillCenter key={`${panel}-skills`} {...splitProps} />
    case 'nodes':
      return <NodeCenter key={`${panel}-nodes`} {...splitProps} />
    case 'models':
      return <ModelCenter key={`${panel}-models`} {...splitProps} />
  }
}

function QuietNotifierMount() {
  useQuietNotifier()
  return null
}

function HelmxShellInner({
  connectionBannerDelayMs = CONNECTION_BANNER_DELAY_MS,
}: {
  connectionBannerDelayMs?: number
}) {
  const { authReady, authError, authenticated, sseConnected, connectionError } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const sidebarCollapsed = useSidebarCollapsed()
  const drawerStack = useDrawerStack()
  const activeModal = useActiveModal()
  const { setActiveModal, setFocusedPanel, checkAuth, closeSplit } = useStoreActions()
  const { locale, t } = useWebLocale()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showConnectionBanner, setShowConnectionBanner] = useState(false)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const panesRef = useRef<HTMLDivElement | null>(null)
  const isMobileViewport = useIsMobileViewport()
  const openMobileSidebar = useCallback(() => setSidebarOpen(true), [])
  const closeMobileSidebar = useCallback(() => setSidebarOpen(false), [])
  useMobileDrawerSwipe({
    containerRef: shellRef,
    enabled: authReady && !authError && authenticated && isMobileViewport && activeModal === null && drawerStack.length === 0,
    sidebarOpen,
    onOpen: openMobileSidebar,
    onClose: closeMobileSidebar,
  })
  const [splitRatio, setSplitRatio] = useState<number>(() => loadSplitRatio())
  const [resizingSplit, setResizingSplit] = useState(false)
  const handleCommitSplitRatio = useCallback((next: number) => {
    setSplitRatio(saveSplitRatio(next))
  }, [])
  const [bootLanding] = useState<{ needsHomeLanding: boolean; initialLocation: WorkspaceLocationState | null }>(() => {
    if (typeof window === 'undefined') {
      return { needsHomeLanding: false, initialLocation: null }
    }
    const rawHash = window.location.hash
    const parsed = parseLocationHash(rawHash)
    return {
      needsHomeLanding: !hashHasPrimaryTarget(rawHash) && parsed.activeModal === null && parsed.drawerStack.length === 0,
      initialLocation: parsed,
    }
  })
  const [landingSettled, setLandingSettled] = useState(!bootLanding.needsHomeLanding)

  // Version awareness and auto refresh: mounted once globally (sleeps when no production entry is detected).
  const versionWatch = useVersionWatcher()
  // 全局并发态势（与侧栏总览入口及 #/overview 三活跃桶 1:1 同源的 indicator）。
  // 抽屉关闭时也保持计算——badge doc 的发现与按需加载内聚在 Hook；移动端
  // 快捷导航簇与侧栏总览入口共用同一 indicator。
  const attention = useGlobalAttention()
  const groupedUi = useGroupedUi()
  const conversations = useConversations()
  // 首个插件全局快捷入口（sidebar.item quickEntry，仅认当前启用插件真实存在
  // 的 screen）：移动端免开汉堡一键直达。
  const firstQuickEntry = useMemo(
    () => extractRailQuickEntries(groupedUi.sidebarItems, groupedUi.screens, conversations, locale)[0] ?? null,
    [groupedUi.sidebarItems, groupedUi.screens, conversations, locale],
  )
  // 快捷入口的 sidebar.item badge 解析（doc 按需发现加载内聚在 Hook）：
  // 无信号为 null，移动端快捷簇零渲染残留；插件停用后贡献与 doc 消失即归零。
  const quickBadgeItems = useMemo(() => (firstQuickEntry !== null ? [firstQuickEntry] : []), [firstQuickEntry])
  const quickEntryBadges = useSidebarBadges(quickBadgeItems)
  const quickEntryBadge = firstQuickEntry !== null ? (quickEntryBadges.get(firstQuickEntry.key) ?? null) : null
  const closeModal = useCallback(() => setActiveModal(null), [setActiveModal])
  const focusPrimary = useCallback(() => setFocusedPanel?.('primary'), [setFocusedPanel])
  const focusSplit = useCallback(() => setFocusedPanel?.('split'), [setFocusedPanel])

  useEffect(() => {
    if (landingSettled) return
    if (authenticated && assetsLoaded && sseConnected) {
      setLandingSettled(true)
    }
  }, [landingSettled, authenticated, assetsLoaded, sseConnected])

  useEffect(() => {
    if (!authenticated || sseConnected) {
      setShowConnectionBanner(false)
      return
    }
    const timer = setTimeout(() => {
      setShowConnectionBanner(true)
    }, connectionBannerDelayMs)
    return () => clearTimeout(timer)
  }, [authenticated, sseConnected, connectionBannerDelayMs])

  useEffect(() => {
    if (activeModal !== null || drawerStack.length > 0) {
      setSidebarOpen(false)
    }
  }, [activeModal, drawerStack.length])

  if (!authReady) {
    return (
      <div className="app-loading-screen" style={{ height: '100dvh' }}>
        {t('shell.loading.connecting')}
      </div>
    )
  }

  if (authError) {
    return (
      <div className="connection-screen" role="alert">
        <strong>{t('shell.connection.cannotConnect')}</strong>
        <p>{authError}</p>
        <button className="btn btn-primary" onClick={() => void checkAuth()}>{t('shell.connection.reconnect')}</button>
      </div>
    )
  }

  if (!authenticated) return <AuthGate />

  const currentLocation: WorkspaceLocationState = {
    primaryTarget,
    splitTarget,
    drawerStack,
    activeModal,
  }
  const homeLandingPending =
    !landingSettled &&
    bootLanding.initialLocation !== null &&
    isSameLocationState(currentLocation, bootLanding.initialLocation)

  const activeTarget =
    focusedPanel === 'split' && splitTarget !== null
      ? splitTarget
      : primaryTarget
  const fallbackTarget =
    focusedPanel === 'split' ? primaryTarget : splitTarget
  const activeConversationId =
    activeTarget.kind === 'conversation'
      ? activeTarget.conversationId
      : fallbackTarget?.kind === 'conversation'
        ? fallbackTarget.conversationId
        : undefined

  // 移动端插件快捷入口仅在「不在该视图上」时渲染（主屏已停在入口目标时就地隐藏）；
  // 顶栏左让位宽度（mq-quick-on）跟随真实可见性，会话态势角标已直接挂在汉堡按钮上。
  const mobileQuickEntryVisible =
    firstQuickEntry !== null && !isSameResolvedTarget(primaryTarget, firstQuickEntry.target)
  const attentionSummary = composeAttentionSummary(attention.indicator, t)
  const mobileNavToggleLabel =
    attentionSummary !== '' ? `${t('shell.nav.toggleNav')} · ${attentionSummary}` : t('shell.nav.toggleNav')

  return (
    <LazyRetryContext.Provider value={versionWatch.clearPreloadError}>
      <div
        ref={shellRef}
        className={`helmx-shell${sidebarOpen ? ' sidebar-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}${mobileQuickEntryVisible ? ' mq-quick-on' : ''}`}
        onClick={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('.nav-item')) {
            setSidebarOpen(false)
          }
        }}
      >
        <button
          type="button"
          className="btn btn-ghost mobile-nav-toggle"
          title={mobileNavToggleLabel}
          aria-label={mobileNavToggleLabel}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <HelmxIcon name="menu" />
          {attention.indicator.totalCount > 0 && attention.indicator.tone !== null && (
            <span className="overview-count-badge mobile-nav-badge" data-tone={attention.indicator.tone}>
              {sidebarBadgeCountLabel(attention.indicator.totalCount)}
            </span>
          )}
        </button>
        {/* 移动端首个 quickEntry 插件视图一键直达（会话总览与态势计数已合并进
            左上角汉堡按钮，省回顶栏宽度）；无插件 quickEntry 或已停在该视图时返回 null。 */}
        <MobileQuickNav quickEntry={firstQuickEntry} quickEntryBadge={quickEntryBadge} />
        {sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label={t('shell.nav.closeNav')}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <Sidebar onClose={() => setSidebarOpen(false)} />

        <main className="helmx-main-stage">
          {showConnectionBanner && !sseConnected && (
            <div className="connection-banner" role="status">
              <span>{connectionError ?? t('shell.connection.syncing')}</span>
              <span className="connection-banner-hint">{t('shell.connection.autoRefresh')}</span>
            </div>
          )}
          {versionWatch.updateAvailable && (
            <div className="version-banner" role="status">
              <HelmxIcon name="refresh-cw" size={13} />
              <span className="version-banner-text">
                {versionWatch.deferReason !== null
                  ? t('shell.version.bannerWithHint', { hint: versionDeferHint(versionWatch.deferReason, t) })
                  : t('shell.version.banner')}
              </span>
              <button type="button" className="btn btn-sm" onClick={versionWatch.reloadNow}>
                {t('shell.version.refreshNow')}
              </button>
            </div>
          )}
          <div
            ref={panesRef}
            className={`helmx-panes${splitTarget !== null ? ' has-split' : ''}${splitTarget !== null && resizingSplit ? ' is-resizing' : ''}`}
            style={
              splitTarget !== null
                ? ({ '--helmx-split-ratio': String(splitRatio) } as CSSProperties)
                : undefined
            }
          >
            <div
              className="helmx-primary-pane"
              data-helmx-panel="primary"
              data-helmx-panel-focused={splitTarget !== null && focusedPanel === 'primary' ? 'true' : undefined}
              onPointerDownCapture={focusPrimary}
              onFocusCapture={focusPrimary}
            >
              <Suspense fallback={<div className="screen-loading" role="status">{t('conv.shell.loadingView')}</div>}>
                {homeLandingPending ? (
                  <div className="home-landing-skeleton" role="status" aria-label={t('conv.shell.loadingWorkspace')}>
                    <div className="home-landing-skeleton-bar" />
                    <div className="home-landing-skeleton-body">
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-title" />
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-wide" />
                      <div className="home-landing-skeleton-line home-landing-skeleton-line-short" />
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 会话窗口保活舞台：主屏会话在此按 LRU 缓存于 <Activity>，切屏/切会话只翻
                        mode；非会话目标与舞台互斥渲染（舞台折叠为 display:none）。 */}
                    <ConversationWindowStage
                      activeConversationId={primaryTarget.kind === 'conversation' ? primaryTarget.conversationId : null}
                    />
                    {renderPaneTarget(primaryTarget, { panel: 'primary' })}
                  </>
                )}
              </Suspense>
            </div>

            {splitTarget && (
              <>
                <SplitResizeHandle
                  ratio={splitRatio}
                  containerRef={panesRef}
                  onChange={setSplitRatio}
                  onCommit={handleCommitSplitRatio}
                  onDraggingChange={setResizingSplit}
                />
                <div
                  className="helmx-split-pane"
                  data-helmx-panel="split"
                  data-helmx-panel-focused={focusedPanel === 'split' ? 'true' : undefined}
                  onPointerDownCapture={focusSplit}
                  onFocusCapture={focusSplit}
                >
                  <Suspense fallback={<div className="screen-loading" role="status">{t('conv.shell.loadingView')}</div>}>
                    {renderPaneTarget(splitTarget, { panel: 'split', onCloseSplit: closeSplit })}
                  </Suspense>
                </div>
              </>
            )}
          </div>
        </main>

        {drawerStack.length > 0 && (
          <DrawerStackShell activeConversationId={activeConversationId} />
        )}

        {activeModal?.kind === 'command-palette' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingCommandPalette')}</div>}>
            <CommandPaletteModal onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'hub-changelog' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('shell.hubChangelog.loading')}</div>}>
            <HubChangelogModal from={activeModal.from} onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'artifact-preview' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingPreview')}</div>}>
            <ArtifactPreviewModal
              artifactId={activeModal.artifactId}
              conversationId={activeModal.conversationId}
              onClose={closeModal}
            />
          </Suspense>
        )}
        {activeModal?.kind === 'workspace-file' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay" role="status">{t('conv.shell.loadingPreview')}</div>}>
            <WorkspaceFilePreviewModal
              conversationId={activeModal.conversationId}
              path={activeModal.path}
              startLine={activeModal.startLine}
              endLine={activeModal.endLine}
              onClose={closeModal}
            />
          </Suspense>
        )}

        <ToastOverlay />
      </div>
    </LazyRetryContext.Provider>
  )
}

export interface AppProps {
  connectionBannerDelayMs?: number
  escAbortWindowMs?: number
}

export function App({ connectionBannerDelayMs, escAbortWindowMs }: AppProps) {
  return (
    <HelmxStoreProvider {...(escAbortWindowMs !== undefined ? { escAbortWindowMs } : {})}>
      <TooltipProvider delayDuration={300}>
        <QuietNotifierMount />
        <HelmxShellInner {...(connectionBannerDelayMs !== undefined ? { connectionBannerDelayMs } : {})} />
      </TooltipProvider>
    </HelmxStoreProvider>
  )
}
