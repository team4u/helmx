import { useMemo, type ReactNode } from 'react'
import { HelmxIcon, Tooltip } from '@helmx/plugin-client'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useSidebarCollapsed,
  useStoreActions,
  useThemePreferencesState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { LocaleMenuButton } from '../ui/LocaleMenuButton.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import {
  isSameResolvedTarget,
  resolveTargetString,
  CENTER_TARGETS,
  spaceForTarget,
  type SidebarSpace,
} from '../lib/types.js'
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
import { SidebarConversationList } from './SidebarConversationList.js'
import { composeAttentionSummary, type GlobalAttentionIndicator } from './attention-model.js'
import { useGlobalAttention } from './use-attention-indicator.js'
import { useSidebarBadges } from './use-sidebar-badges.js'
import {
  HoverIconButton,
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
        aria-label={label}
        onClick={() => setActiveModal({ kind: 'hub-changelog' })}
      >
        <HelmxIcon name="file-text" size={16} />
      </button>
    </Tooltip>
  )
}

/**
 * Activity Rail（48px）：空间切换（对话/视图/设置）+ 插件快捷入口 + 主题与 changelog 入口。
 * 桌面与移动抽屉共用；三空间一律按 spaceForTarget(primaryTarget) 唯一高亮（含 #/overview 归属对话空间）。
 */
function ActivityRail({
  sseConnected,
  theme,
  themePreference,
  onToggleTheme,
  onToggleSidebarCollapsed,
  sidebarCollapsed,
  attentionIndicator,
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
  sidebarCollapsed: boolean
  attentionIndicator: GlobalAttentionIndicator
  space: SidebarSpace
  onOpenSpace: (space: SidebarSpace) => void
  quickEntries: SidebarViewItem[]
  store: SidebarStoreView
  onNavigate?: () => void
}) {
  const { t } = useWebLocale()
  const quickEntryBadges = useSidebarBadges(quickEntries)
  const attentionSummary = composeAttentionSummary(attentionIndicator, t)
  const hasAttentionSignal = attentionIndicator.totalCount > 0 && attentionIndicator.tone !== null
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
          aria-label={t('shell.sidebar.expandNav')}
          onClick={() => onToggleSidebarCollapsed?.()}
        >
          <HelmxIcon name="chevron-right" size={16} />
        </button>
      </Tooltip>
      <div className="activity-rail-spaces">
        {(Object.keys(SPACE_LABEL_KEYS) as SidebarSpace[]).map((key) => {
          const baseSpaceLabel = t(SPACE_LABEL_KEYS[key])
          const spaceActive = space === key
          const showBadgeAlways = key === 'conversations' && hasAttentionSignal && !spaceActive
          const showBadgeCollapsedOnly = key === 'conversations' && hasAttentionSignal && spaceActive && sidebarCollapsed
          const showSpaceBadge = showBadgeAlways || showBadgeCollapsedOnly
          const spaceLabel =
            showSpaceBadge && attentionSummary !== '' ? `${baseSpaceLabel} · ${attentionSummary}` : baseSpaceLabel
          return (
            <Tooltip content={spaceLabel} side="right" key={key}>
              <button
                type="button"
                className={`rail-btn rail-space-btn${spaceActive ? ' rail-btn-active' : ''}`}
                aria-label={spaceLabel}
                aria-current={spaceActive ? 'page' : undefined}
                onClick={() => onOpenSpace(key)}
              >
                <HelmxIcon name={SPACE_ICONS[key]} size={16} />
                {showSpaceBadge && attentionIndicator.tone !== null && (
                  <span
                    className={`overview-count-badge rail-space-badge${showBadgeCollapsedOnly ? ' rail-space-badge-collapsed-only' : ''}`}
                    data-tone={attentionIndicator.tone}
                  >
                    {sidebarBadgeCountLabel(attentionIndicator.totalCount)}
                  </span>
                )}
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
        <RailChangelogButton />
      </div>
    </nav>
  )
}

/** 设置空间导航：系统中心纵向列表，行结构与对话/视图空间一级导航项同构。 */
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
  const sidebarCollapsed = useSidebarCollapsed()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const conversations = useConversations()
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
      locale,
      openTarget,
      pushNotice,
    ],
  )

  const space = spaceForTarget(primaryTarget)
  const { indicator: attentionIndicator, background, viewedConversationIds } = useGlobalAttention()

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
      <ActivityRail
        sseConnected={sseConnected}
        theme={theme}
        themePreference={themePreference}
        onToggleTheme={toggleTheme}
        onToggleSidebarCollapsed={toggleSidebarCollapsed}
        sidebarCollapsed={sidebarCollapsed}
        attentionIndicator={attentionIndicator}
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
            <Tooltip content={quietNotifyTooltip} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon"
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
                aria-label={t('shell.sidebar.openCommandPalette')}
                onClick={() => setActiveModal({ kind: 'command-palette' })}
              >
                <HelmxIcon name="search" size={13} />
              </button>
            </Tooltip>
            <Tooltip content={collapseWithShortcut} side="bottom">
              <button
                type="button"
                className="btn btn-sm btn-icon desktop-sidebar-collapse-btn"
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
                  onClick={onClose}
                >
                  <HelmxIcon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="sidebar-scroll">
          {space === 'conversations' ? (
            <SidebarConversationList
              store={sidebarStore}
              background={background}
              attentionIndicator={attentionIndicator}
              viewedConversationIds={viewedConversationIds}
              onNavigate={onClose}
            />
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
