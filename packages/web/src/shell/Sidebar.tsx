import { useMemo, type ReactNode } from 'react'
import { HelmxIcon, Tooltip } from '@helmx/plugin-client'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePendingAsks,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
  useThemePreferencesState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { LocaleMenuButton } from '../ui/LocaleMenuButton.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { isSameResolvedTarget, resolveTargetString, CENTER_TARGETS, spaceForTarget, type SidebarSpace } from '../lib/types.js'
import { readBrowserNotificationPermission } from '../lib/browser-notification.js'
import { formatModShortcut } from './shortcuts-model.js'
import {
  composeSidebarBadgeLabel,
  extractRailQuickEntries,
  extractSidebarViews,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  sidebarBadgeCountLabel,
  sidebarBadgeToneClass,
  type SidebarStoreView,
  type SidebarViewItem,
} from './sidebar-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { AgentStandingsGroup } from './SidebarAgentStandings.js'
import { ArchivedConversationsGroup } from './SidebarArchivedConversations.js'
import { useGlobalAttention } from './use-attention-indicator.js'
import { useSidebarBadges } from './use-sidebar-badges.js'
import {
  HoverIconButton,
  PendingAsksPanel,
  SidebarPaneTag,
  StatusDot,
} from './SidebarPrimitives.js'

/** 独立「视图」分组：screen: 导航项 + 无导航 target 的自定义客户端侧栏组件。 */
function ViewNavGroup({ store }: { store: SidebarStoreView }) {
  const { locale, t } = useWebLocale()
  const viewItems = useMemo(
    () => extractSidebarViews(store.groupedUi.sidebarItems, store.conversations, locale),
    [store.groupedUi.sidebarItems, store.conversations, locale],
  )
  // 视图项徽标（sidebar.item badge 声明）：doc 发现与按需加载内聚在 Hook，
  // 无信号不进映射；插件停用后贡献消失即归零，零插件 ID 特判。
  const viewBadges = useSidebarBadges(viewItems)
  const clientItems = store.groupedUi.sidebarItems.filter(
    (item) => item.spec.client !== undefined && resolveTargetString(item.spec.target ?? '', store.conversations) === null,
  )
  if (viewItems.length === 0 && clientItems.length === 0) return null

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-header">{t('shell.sidebar.viewsHeader')}</div>
      {clientItems.map((item) => (
        <div key={`client:${item.pluginId}/${item.spec.id}`} style={{ padding: '0 10px 6px' }}>
          <PluginUiView pluginId={item.pluginId} spec={item.spec} label={t('shell.sidebar.itemLabel', { id: item.spec.id })} />
        </div>
      ))}
      {viewItems.map((view) => {
        const presence = resolveSidebarTargetPresence(store, (t) => isSameResolvedTarget(t, view.target))
        const badge = viewBadges.get(view.key) ?? null
        const viewLabel = composeSidebarBadgeLabel(view.label, badge)
        return (
          <div
            key={view.key}
            className={`nav-item${presenceNavClassSuffix(presence)}`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
              store.openTarget(view.target)
            }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              title={viewLabel}
              aria-label={viewLabel}
              onClick={() => store.openTarget(view.target)}
              aria-current={presence.active ? 'page' : undefined}
            >
              <HelmxIcon name={view.icon} size={14} />
              <span className="nav-item-label">{view.label}</span>
            </button>
            <span className="nav-item-meta">
              <SidebarPaneTag paneTag={presence.paneTag} />
              {badge !== null && !badge.dot && badge.count > 0 && (
                <span className={`badge ${sidebarBadgeToneClass(badge.tone)} tabular-nums sidebar-view-badge`}>
                  {sidebarBadgeCountLabel(badge.count)}
                </span>
              )}
              {badge !== null && badge.dot && (
                <span className="sidebar-view-badge-dot" data-tone={badge.tone} aria-hidden="true" />
              )}
              <span className="sidebar-split-action">
                <HoverIconButton
                  className="split-toggle-btn sidebar-split-btn"
                  title={t('shell.sidebar.openInRightSplit')}
                  icon="columns"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.openTarget(view.target, { split: true })
                  }}
                />
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 系统中心目标键已迁至 lib/types（CENTER_TARGETS，与侧栏空间推导共用）。 */
type CenterKey = (typeof CENTER_TARGETS)[number]

const CENTER_ICONS: Record<CenterKey, string> = {
  profiles: 'bot',
  models: 'key',
  skills: 'sparkles',
  nodes: 'network',
  plugins: 'puzzle',
}

const CENTER_LABEL_KEYS: Record<
  CenterKey,
  'shell.center.profiles' | 'shell.center.models' | 'shell.center.skills' | 'shell.center.nodes' | 'shell.center.plugins'
> = {
  profiles: 'shell.center.profiles',
  models: 'shell.center.models',
  skills: 'shell.center.skills',
  nodes: 'shell.center.nodes',
  plugins: 'shell.center.plugins',
}

/** 侧栏空间由主屏目标唯一推导（spaceForTarget，lib/types.ts），不进 URL；
 * Rail 点击经 store.openSpace 直接导航该空间的主舞台目标（含会话内空间记忆）。 */

const SPACE_ICONS: Record<SidebarSpace, string> = {
  conversations: 'message-square',
  views: 'layout-grid',
  settings: 'settings',
}

const SPACE_LABEL_KEYS: Record<
  SidebarSpace,
  'shell.space.conversations' | 'shell.space.views' | 'shell.space.settings'
> = {
  conversations: 'shell.space.conversations',
  views: 'shell.space.views',
  settings: 'shell.space.settings',
}

/** 主题钮下方的常驻 changelog 入口（Activity Rail 底部，桌面与移动抽屉共用）。 */
function RailChangelogButton(): ReactNode {
  const { t } = useWebLocale()
  const { setActiveModal } = useStoreActions()
  const label = t('shell.hubChangelog.entry')
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        className="btn btn-ghost btn-sm sidebar-changelog-toggle"
        title={label}
        aria-label={label}
        onClick={() => setActiveModal({ kind: 'hub-changelog' })}
      >
        <HelmxIcon name="file-text" size={16} />
      </button>
    </Tooltip>
  )
}

/**
 * Activity Rail（48px）：仅空间切换（对话/视图/设置）+ 主题按钮与 changelog 入口。
 * 桌面与移动抽屉共用；空间按钮直接导航主舞台到对应空间的最近目标（store.openSpace），
 * 系统中心入口收敛到「设置」空间内的纵向列表。
 * 空间按钮本身不携带任何徽标：全局态势感知收敛到下方「会话总览」直达按钮的
 * tone 灯点（同源 indicator；总览页已有逐会话指示灯，入口计数冗余）。
 */
function ActivityRail({
  sseConnected,
  theme,
  themePreference,
  onToggleTheme,
  onToggleSidebarCollapsed,
  space,
  onOpenSpace,
  quickEntries,
  store,
  onNavigate,
}: {
  sseConnected: boolean
  theme: 'dark' | 'light'
  themePreference: 'system' | 'light' | 'dark'
  onToggleTheme: () => void
  onToggleSidebarCollapsed?: () => void
  space: SidebarSpace
  onOpenSpace: (space: SidebarSpace) => void
  quickEntries: SidebarViewItem[]
  store: SidebarStoreView
  onNavigate?: () => void
}) {
  const { t } = useWebLocale()
  // 快捷入口徽标（sidebar.item badge 声明）：与移动端快捷簇 / 视图行同源
  // 解析；doc 按需加载内聚在 Hook（ensurePluginDoc 幂等）。
  const quickEntryBadges = useSidebarBadges(quickEntries)
  const expandWithShortcut = t('shell.sidebar.expandNavWithShortcut', { shortcut: formatModShortcut('B') })
  const themeTooltip =
    themePreference === 'system'
      ? t('shell.auth.themeSystem', {
          current: t(theme === 'dark' ? 'shell.theme.currentDark' : 'shell.theme.currentLight'),
        })
      : themePreference === 'light'
        ? t('shell.auth.themeLight')
        : t('shell.auth.themeDark')
  const themeAriaLabel =
    themePreference === 'system'
      ? t('shell.theme.system')
      : themePreference === 'light'
        ? t('shell.theme.light')
        : t('shell.theme.dark')
  // 主屏是否停在总览：空间按钮高亮的归属判定（总览无 Rail 入口，由侧栏
  // 头部搜索钮旁的总览入口承载；主屏停总览时空间按钮一律不亮）。
  const onOverviewPrimary = store.primaryTarget?.kind === 'overview'

  return (
    <nav className="activity-rail" aria-label={t('shell.sidebar.mainNavigation')}>
      <div className="activity-rail-brand" title="Helmx">
        <HelmxIcon name="layers" size={17} />
        <StatusDot connected={sseConnected} />
      </div>
      <Tooltip content={expandWithShortcut} side="right">
        <button
          type="button"
          className="rail-btn desktop-sidebar-expand-btn"
          title={expandWithShortcut}
          aria-label={t('shell.sidebar.expandNav')}
          onClick={() => onToggleSidebarCollapsed?.()}
        >
          <HelmxIcon name="chevron-right" size={16} />
        </button>
      </Tooltip>
      <div className="activity-rail-spaces">
        {(Object.keys(SPACE_LABEL_KEYS) as SidebarSpace[]).map((key) => {
          const spaceLabel = t(SPACE_LABEL_KEYS[key])
          // 高亮只认主屏归属：主屏停在总览时空间按钮一律不亮（总览入口在
          // 侧栏头部，Rail 不再有总览按钮，杜绝双入口双高亮）。
          const spaceActive = space === key && !onOverviewPrimary
          return (
            <Tooltip content={spaceLabel} side="right" key={key}>
              <button
                type="button"
                className={`rail-btn rail-space-btn${spaceActive ? ' rail-btn-active' : ''}`}
                title={spaceLabel}
                aria-label={spaceLabel}
                aria-current={spaceActive ? 'page' : undefined}
                onClick={() => onOpenSpace(key)}
              >
                <HelmxIcon name={SPACE_ICONS[key]} size={16} />
              </button>
            </Tooltip>
          )
        })}
      </div>
      {quickEntries.length > 0 && (
        <div className="activity-rail-quick">
          {quickEntries.map((entry) => {
            const presence = resolveSidebarTargetPresence(store, (t) => isSameResolvedTarget(t, entry.target))
            const badge = quickEntryBadges.get(entry.key) ?? null
            const entryLabel = composeSidebarBadgeLabel(entry.label, badge)
            return (
              <Tooltip content={entryLabel} side="right" key={entry.key}>
                <button
                  type="button"
                  className={`rail-btn rail-quick-btn${presence.active ? ' rail-btn-active' : ''}`}
                  title={entryLabel}
                  aria-label={entryLabel}
                  aria-current={presence.active ? 'page' : undefined}
                  onClick={() => {
                    store.openTarget(entry.target)
                    onNavigate?.()
                  }}
                >
                  <HelmxIcon name={entry.icon} size={16} />
                  {badge !== null && !badge.dot && badge.count > 0 && (
                    <span className="rail-quick-badge" data-tone={badge.tone}>
                      {sidebarBadgeCountLabel(badge.count)}
                    </span>
                  )}
                  {badge !== null && badge.dot && <span className="rail-quick-dot" data-tone={badge.tone} />}
                </button>
              </Tooltip>
            )
          })}
        </div>
      )}
      <div className="activity-rail-footer">
        <LocaleMenuButton tooltipSide="right" menuSide="right" menuAlign="end" />
        <Tooltip content={themeTooltip} side="right">
          <button
            type="button"
            className="btn btn-ghost btn-sm sidebar-theme-toggle"
            title={themeTooltip}
            aria-label={themeAriaLabel}
            onClick={onToggleTheme}
          >
            <HelmxIcon
              name={
                themePreference === 'system'
                  ? 'monitor'
                  : themePreference === 'light'
                    ? 'sun'
                    : 'moon'
              }
              size={16}
            />
          </button>
        </Tooltip>
        {/* 已安装版本 changelog（随包分发的 CHANGELOG.md，离线可读）：主题钮下方的常驻入口 */}
        <RailChangelogButton />
      </div>
    </nav>
  )
}

/** 设置空间导航：系统中心纵向列表，行结构与智能体站位行同构
 * （nav-item-main 图标文本），保证两个空间的左缘视觉统一。 */
function SettingsNavGroup({ store, onNavigate }: { store: SidebarStoreView; onNavigate?: () => void }) {
  const { t } = useWebLocale()
  return (
    <div className="sidebar-group settings-nav">
      {CENTER_TARGETS.map((key) => {
        const presence = resolveSidebarTargetPresence(store, (target) => target.kind === key)
        return (
          <div
            key={key}
            className={`nav-item settings-nav-item${presenceNavClassSuffix(presence)}`}
            onClick={(e) => {
              if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
              store.openTarget({ kind: key })
              onNavigate?.()
            }}
          >
            <button
              type="button"
              className="nav-item-main nav-open"
              aria-current={presence.active ? 'page' : undefined}
              onClick={() => {
                store.openTarget({ kind: key })
                onNavigate?.()
              }}
            >
              <HelmxIcon name={CENTER_ICONS[key]} size={14} />
              <span className="nav-item-label">{t(CENTER_LABEL_KEYS[key])}</span>
            </button>
            {presence.paneTag !== null && (
              <span className="nav-item-meta">
                <SidebarPaneTag paneTag={presence.paneTag} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Sidebar({ onClose }: { onClose?: () => void } = {}) {
  const { sseConnected } = useAuthConnection()
  const { theme, themePreference, locale, quietNotifyEnabled } = useThemePreferencesState()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const conversations = useConversations()
  const pendingAsks = usePendingAsks()
  const { profiles } = useProfilesSlice()
  const {
    openTarget,
    pushNotice,
    openSpace,
    setQuietNotify,
    setActiveModal,
    toggleSidebarCollapsed,
    toggleTheme,
  } = useStoreActions()
  const { t } = useWebLocale()

  const sidebarStore = useMemo<SidebarStoreView>(
    () => ({
      primaryTarget,
      splitTarget,
      focusedPanel,
      conversations,
      profiles,
      plugins,
      groupedUi,
      pendingAsks,
      locale,
      openTarget,
      pushNotice,
    }),
    [
      primaryTarget,
      splitTarget,
      focusedPanel,
      conversations,
      profiles,
      plugins,
      groupedUi,
      pendingAsks,
      locale,
      openTarget,
      pushNotice,
    ],
  )

  // 侧栏空间由主屏目标唯一推导（不进 URL）；Rail 点击经 openSpace 直接导航
  // 该空间最近的主舞台目标，URL 即该空间真实锚点，刷新/前进/后退天然可还原。
  const space = spaceForTarget(primaryTarget)

  // 全局并发态势（总览入口脉冲灯点 + Rail/移动端快捷导航的总览灯点 + 后台在途
  // 索引）：badge doc 的按需加载内聚在 Hook（ensurePluginDoc 幂等，移动端合着
  // 抽屉也不漏后台任务）。插件停用后其 UI 贡献与 doc 均从 store 消失，态势自然归零。
  const { indicator: attentionIndicator, background } = useGlobalAttention()

  // 插件全局快捷入口（sidebar.item quickEntry，最薄通用声明）：仅收当前启用
  // 插件确实注册了的 screen（插件停用后贡献即时消失，入口零残留）；点击走标准
  // store 路由并收起移动抽屉——PC 折叠 Rail 与移动抽屉同源一键直达。
  const railQuickEntries = useMemo(
    () =>
      extractRailQuickEntries(
        groupedUi.sidebarItems,
        groupedUi.screens,
        conversations,
        locale,
      ),
    [groupedUi.sidebarItems, groupedUi.screens, conversations, locale],
  )

  // 后台浏览器通知开关：权限现场读取（浏览器设置可随时收回），
  // 偏好开而权限未授予时如实提示，绝不静默装作已开启。
  const quietNotifyTooltip = !quietNotifyEnabled
    ? t('shell.quietNotify.off')
    : readBrowserNotificationPermission() !== 'granted'
      ? t('shell.quietNotify.denied')
      : t('shell.quietNotify.on')
  const collapseWithShortcut = t('shell.sidebar.collapseNavWithShortcut', { shortcut: formatModShortcut('B') })
  const spaceHeaderLabel =
    space === 'conversations'
      ? t('shell.sidebar.spaceHeaderConversations')
      : space === 'views'
        ? t('shell.sidebar.viewsHeader')
        : t('shell.sidebar.spaceHeaderSettings')

  return (
    <aside className="helmx-sidebar">
      {/* Mobile drawer: stays expanded after switching spaces — the secondary list of the space
          (settings list / views list / agent list) renders naturally inside the drawer and closes it
          only when the user picks a concrete item (items carry onNavigate / the App nav-item close
          channel); closing here would whisk the user to the first target before they see the menu.
      The desktop sidebar is persistent; behavior unchanged. */}
      <ActivityRail
        sseConnected={sseConnected}
        theme={theme}
        themePreference={themePreference}
        onToggleTheme={toggleTheme}
        onToggleSidebarCollapsed={toggleSidebarCollapsed}
        space={space}
        onOpenSpace={(nextSpace) => {
          openSpace(nextSpace)
        }}
        quickEntries={railQuickEntries}
        store={sidebarStore}
        onNavigate={onClose}
      />
      <div className="sidebar-context">
        <div className="sidebar-header">
          <div className="sidebar-context-title">
            <HelmxIcon
              name={space === 'conversations' ? 'message-square' : space === 'views' ? 'layout-grid' : 'settings'}
              size={14}
            />
            <span>{spaceHeaderLabel}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content={t('shell.quietNotify.toggleTooltip')} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={quietNotifyTooltip}
                aria-label={quietNotifyTooltip}
                aria-pressed={quietNotifyEnabled}
                onClick={() => {
                  void setQuietNotify(!quietNotifyEnabled)
                }}
              >
                <HelmxIcon name={quietNotifyEnabled && readBrowserNotificationPermission() === 'granted' ? 'bell' : 'bell-off'} size={13} />
              </button>
            </Tooltip>
            <Tooltip content={t('shell.sidebar.openCommandPalette')} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={t('shell.sidebar.openCommandPalette')}
                aria-label={t('shell.sidebar.openCommandPalette')}
                onClick={() => setActiveModal({ kind: 'command-palette' })}
              >
                <HelmxIcon name="search" size={13} />
              </button>
            </Tooltip>
            {space === 'conversations' && (
              <Tooltip content={t('shell.overview.railTooltip')} side="bottom">
                <button
                  type="button"
                  className={`btn btn-sm btn-icon sidebar-overview-open-btn${primaryTarget.kind === 'overview' ? ' is-active' : ''}`}
                  title={t('shell.overview.railTooltip')}
                  aria-label={t('shell.overview.railTooltip')}
                  aria-current={primaryTarget.kind === 'overview' ? 'page' : undefined}
                  onClick={() => {
                    openTarget({ kind: 'overview' })
                    onClose?.()
                  }}
                >
                  <HelmxIcon name="activity" size={13} />
                  {attentionIndicator.totalCount > 0 && attentionIndicator.tone !== null && (
                    <span className="overview-count-badge" data-tone={attentionIndicator.tone}>
                      {sidebarBadgeCountLabel(attentionIndicator.totalCount)}
                    </span>
                  )}
                </button>
              </Tooltip>
            )}
            <Tooltip content={collapseWithShortcut} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon desktop-sidebar-collapse-btn"
                title={collapseWithShortcut}
                aria-label={t('shell.sidebar.collapseNav')}
                onClick={() => toggleSidebarCollapsed?.()}
              >
                <HelmxIcon name="chevron-left" size={13} />
              </button>
            </Tooltip>
            {onClose && (
              <Tooltip content={t('shell.nav.closeNav')} side="bottom">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mobile-sidebar-close"
                  aria-label={t('shell.nav.closeNav')}
                  title={t('shell.nav.closeNav')}
                  onClick={onClose}
                >
                  <HelmxIcon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="sidebar-scroll">
          {/* 会话总览入口收敛为侧栏头部搜索钮旁的素图标钮（仅对话空间）；
              逐树态势明细只在 #/overview 总览页呈现。 */}
          {space === 'conversations' ? (
            <>
              <PendingAsksPanel store={sidebarStore} />
              <AgentStandingsGroup store={sidebarStore} background={background} onNavigate={onClose} />
              <ArchivedConversationsGroup background={background} onNavigate={onClose} />
            </>
          ) : space === 'views' ? (
            <ViewNavGroup store={sidebarStore} />
          ) : (
            <SettingsNavGroup store={sidebarStore} onNavigate={onClose} />
          )}
        </div>
      </div>
    </aside>
  )
}
