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
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ExoticComponent,
  type ReactNode,
} from 'react'
import { Button, HelmxIcon, LoadingState, Stack, TooltipProvider } from '@helmx/plugin-client'
import { AgentStandbyPane } from './conversation/AgentStandbyPane.js'
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
import { useVersionWatcher, type VersionDeferReason } from './shell/use-version-watcher.js'
import { versionDeferHint } from './shell/version-watch-model.js'
import { useGlobalAttention } from './shell/use-attention-indicator.js'
import { composeAttentionSummary } from './shell/attention-model.js'
import { extractRailQuickEntries, sidebarBadgeCountLabel } from './shell/sidebar-model.js'
import { useSidebarBadges } from './shell/use-sidebar-badges.js'
import { MobileQuickNav } from './shell/MobileQuickNav.js'
import { useMobileDrawerSwipe } from './shell/use-mobile-drawer-swipe.js'
import { useIsMobileViewport, useMaxWidthMediaQuery } from './lib/use-media-query.js'
import { loadSplitRatio, saveSplitRatio } from './shell/split-ratio-model.js'
import { SplitResizeHandle } from './ui/SplitResizeHandle.js'

/** SSE 断线横幅展示防抖：短于 1500ms 的瞬断或页面初始握手不闪现重连提示。 */
const CONNECTION_BANNER_DELAY_MS = 1500
/** Matches `@media (max-width: 860px)` off-canvas mobile sidebar breakpoint in `responsive.css`. */
const MOBILE_DRAWER_MAX_WIDTH = 860
const MOBILE_SIDEBAR_ID = 'helmx-mobile-sidebar'
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function listFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false
    let cur: HTMLElement | null = el
    while (cur !== null && cur !== container) {
      if (cur.hidden || cur.hasAttribute('inert')) return false
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(cur)
        if (style.display === 'none' || style.visibility === 'hidden') return false
      }
      cur = cur.parentElement
    }
    return true
  })
}

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
            <Stack direction="horizontal" gap="sm" align="center" className="lazy-load-error-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  this.setState({ error: null })
                  this.props.onRetry()
                }}
              >
                {labels.retry}
              </Button>
              {this.props.onDismiss !== undefined && (
                <Button size="sm" onClick={this.props.onDismiss}>
                  {labels.close}
                </Button>
              )}
            </Stack>
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
const ShortcutsModal = lazyWithRetry(
  () => lazy(() => import('./modals/ShortcutsModal.js').then((m) => ({ default: m.ShortcutsModal }))),
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

interface VersionBannerSnapshot {
  updateAvailable: boolean
  deferReason: VersionDeferReason
  reloadNow: () => void
}

interface VersionBannerBus {
  getSnapshot: () => VersionBannerSnapshot
  subscribe: (listener: () => void) => () => void
  publish: (next: VersionBannerSnapshot) => void
  clearPreloadErrorRef: { current: (() => void) | null }
}

const DEFAULT_VERSION_BANNER_SNAPSHOT: VersionBannerSnapshot = {
  updateAvailable: false,
  deferReason: null,
  reloadNow: () => {},
}

const VersionBannerContext = createContext<VersionBannerBus | null>(null)

function createVersionBannerBus(): VersionBannerBus {
  let snapshot = DEFAULT_VERSION_BANNER_SNAPSHOT
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (next) => {
      if (
        snapshot.updateAvailable === next.updateAvailable &&
        snapshot.deferReason === next.deferReason &&
        snapshot.reloadNow === next.reloadNow
      ) {
        return
      }
      snapshot = next
      for (const listener of listeners) listener()
    },
    clearPreloadErrorRef: { current: null },
  }
}

/** Leaf watcher mount: isolates draft/focus/version state subscriptions from `HelmxShellInner`. */
function VersionWatcherMount({ bus }: { bus: VersionBannerBus }) {
  const versionWatch = useVersionWatcher()
  bus.clearPreloadErrorRef.current = versionWatch.clearPreloadError
  useEffect(() => {
    bus.publish({
      updateAvailable: versionWatch.updateAvailable,
      deferReason: versionWatch.deferReason,
      reloadNow: versionWatch.reloadNow,
    })
  }, [bus, versionWatch.updateAvailable, versionWatch.deferReason, versionWatch.reloadNow])
  return null
}

function VersionBannerSlot() {
  const bus = useContext(VersionBannerContext)
  const { t } = useWebLocale()
  const subscribe = useCallback(
    (listener: () => void) => (bus !== null ? bus.subscribe(listener) : () => {}),
    [bus],
  )
  const getSnapshot = useCallback(
    () => (bus !== null ? bus.getSnapshot() : DEFAULT_VERSION_BANNER_SNAPSHOT),
    [bus],
  )
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!snap.updateAvailable) return null
  return (
    <div className="version-banner" role="status">
      <HelmxIcon name="refresh-cw" size={13} />
      <span className="version-banner-text">
        {snap.deferReason !== null
          ? t('shell.version.bannerWithHint', { hint: versionDeferHint(snap.deferReason, t) })
          : t('shell.version.banner')}
      </span>
      <Button size="sm" onClick={snap.reloadNow}>
        {t('shell.version.refreshNow')}
      </Button>
    </div>
  )
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
  const mobileNavToggleRef = useRef<HTMLButtonElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const wasMobileDrawerOpenRef = useRef(false)
  const isMobileViewport = useIsMobileViewport()
  const isDrawerViewport = useMaxWidthMediaQuery(MOBILE_DRAWER_MAX_WIDTH)
  const isMobileDrawerOpen = isDrawerViewport && sidebarOpen
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

  useEffect(() => {
    if (!isDrawerViewport && sidebarOpen) {
      setSidebarOpen(false)
    }
  }, [isDrawerViewport, sidebarOpen])

  // Mobile modal sidebar focus entry on open and restoration on close.
  useEffect(() => {
    const wasOpen = wasMobileDrawerOpenRef.current
    wasMobileDrawerOpenRef.current = isMobileDrawerOpen

    if (isMobileDrawerOpen && !wasOpen) {
      const sidebar = sidebarRef.current
      if (!sidebar) return
      const active = document.activeElement
      if (active instanceof HTMLElement && sidebar.contains(active)) return
      sidebar.focus({ preventScroll: true })
      return
    }

    if (!isMobileDrawerOpen && wasOpen && isDrawerViewport && activeModal === null && drawerStack.length === 0) {
      const active = document.activeElement
      const sidebar = sidebarRef.current
      const focusLostOrInsideSidebar =
        active === null ||
        active === document.body ||
        (sidebar !== null && active instanceof Node && sidebar.contains(active))
      if (focusLostOrInsideSidebar) {
        mobileNavToggleRef.current?.focus({ preventScroll: true })
      }
    }
  }, [isMobileDrawerOpen, isDrawerViewport, activeModal, drawerStack.length])

  // Escape dismissal and modal Tab focus trap while mobile sidebar drawer is open.
  useEffect(() => {
    if (!isMobileDrawerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.preventDefault()
        setSidebarOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const sidebar = sidebarRef.current
      if (!sidebar) return
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        !sidebar.contains(active) &&
        active.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]') !== null
      ) {
        return
      }
      const focusables = listFocusableElements(sidebar)
      if (focusables.length === 0) {
        event.preventDefault()
        sidebar.focus()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const insideSidebar = active instanceof HTMLElement && sidebar.contains(active)
      if (event.shiftKey) {
        if (!insideSidebar || active === first || active === sidebar) {
          event.preventDefault()
          last.focus()
        }
      } else if (!insideSidebar || active === last || active === sidebar) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMobileDrawerOpen])

  if (!authReady) {
    return (
      <div className="app-loading-screen">
        <LoadingState label={t('shell.loading.connecting')} iconSize={14} />
      </div>
    )
  }

  if (authError) {
    return (
      <div className="connection-screen" role="alert">
        <strong>{t('shell.connection.cannotConnect')}</strong>
        <p>{authError}</p>
        <Button variant="primary" onClick={() => void checkAuth()}>{t('shell.connection.reconnect')}</Button>
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
        <Button
          ref={mobileNavToggleRef}
          variant="ghost"
          className="mobile-nav-toggle"
          icon={<HelmxIcon name="menu" />}
          title={mobileNavToggleLabel}
          aria-label={mobileNavToggleLabel}
          aria-expanded={isDrawerViewport ? sidebarOpen : undefined}
          aria-controls={isDrawerViewport ? MOBILE_SIDEBAR_ID : undefined}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {attention.indicator.totalCount > 0 && attention.indicator.tone !== null ? (
            <span className="overview-count-badge mobile-nav-badge" data-tone={attention.indicator.tone}>
              {sidebarBadgeCountLabel(attention.indicator.totalCount)}
            </span>
          ) : null}
        </Button>
        {/* 移动端首个 quickEntry 插件视图一键直达（会话总览与态势计数已合并进
            左上角汉堡按钮，省回顶栏宽度）；无插件 quickEntry 或已停在该视图时返回 null。 */}
        <MobileQuickNav quickEntry={firstQuickEntry} quickEntryBadge={quickEntryBadge} />
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <Sidebar
          id={MOBILE_SIDEBAR_ID}
          drawerMode={isDrawerViewport}
          drawerOpen={sidebarOpen}
          sidebarRef={sidebarRef}
          onClose={closeMobileSidebar}
        />

        <main
          className="helmx-main-stage"
          aria-hidden={isMobileDrawerOpen || undefined}
          inert={isMobileDrawerOpen || undefined}
        >
          {showConnectionBanner && !sseConnected && (
            <div className="connection-banner" role="status">
              <span>{connectionError ?? t('shell.connection.syncing')}</span>
              <span className="connection-banner-hint">{t('shell.connection.autoRefresh')}</span>
            </div>
          )}
          <VersionBannerSlot />
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
              <Suspense fallback={<div className="screen-loading"><LoadingState label={t('conv.shell.loadingView')} iconSize={13} /></div>}>
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
                  <Suspense fallback={<div className="screen-loading"><LoadingState label={t('conv.shell.loadingView')} iconSize={13} /></div>}>
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
          <Suspense fallback={<div className="screen-loading screen-loading-overlay"><LoadingState label={t('conv.shell.loadingCommandPalette')} iconSize={13} /></div>}>
            <CommandPaletteModal onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'shortcuts' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay"><LoadingState label={t('modals.shortcuts.loading')} iconSize={13} /></div>}>
            <ShortcutsModal onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'hub-changelog' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay"><LoadingState label={t('shell.hubChangelog.loading')} iconSize={13} /></div>}>
            <HubChangelogModal from={activeModal.from} onClose={closeModal} />
          </Suspense>
        )}
        {activeModal?.kind === 'artifact-preview' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay"><LoadingState label={t('conv.shell.loadingPreview')} iconSize={13} /></div>}>
            <ArtifactPreviewModal
              artifactId={activeModal.artifactId}
              conversationId={activeModal.conversationId}
              onClose={closeModal}
            />
          </Suspense>
        )}
        {activeModal?.kind === 'workspace-file' && (
          <Suspense fallback={<div className="screen-loading screen-loading-overlay"><LoadingState label={t('conv.shell.loadingPreview')} iconSize={13} /></div>}>
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
  )
}

export interface AppProps {
  connectionBannerDelayMs?: number
  escAbortWindowMs?: number
}

export function App({ connectionBannerDelayMs, escAbortWindowMs }: AppProps) {
  const versionBusRef = useRef<VersionBannerBus | null>(null)
  if (versionBusRef.current === null) {
    versionBusRef.current = createVersionBannerBus()
  }
  const versionBus = versionBusRef.current
  const clearPreloadError = useCallback(() => {
    versionBus.clearPreloadErrorRef.current?.()
  }, [versionBus])

  return (
    <HelmxStoreProvider {...(escAbortWindowMs !== undefined ? { escAbortWindowMs } : {})}>
      <TooltipProvider delayDuration={300}>
        <VersionBannerContext.Provider value={versionBus}>
          <LazyRetryContext.Provider value={clearPreloadError}>
            <QuietNotifierMount />
            <VersionWatcherMount bus={versionBus} />
            <HelmxShellInner {...(connectionBannerDelayMs !== undefined ? { connectionBannerDelayMs } : {})} />
          </LazyRetryContext.Provider>
        </VersionBannerContext.Provider>
      </TooltipProvider>
    </HelmxStoreProvider>
  )
}
