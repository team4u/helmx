/**
 * 移动端插件快捷入口（根挂载，紧随 .mobile-nav-toggle 同层）：
 *
 * - 仅承载首个已声明 quickEntry 的插件视图（会话态势计数徽标已收敛至左上角汉堡
 *   按钮 .mobile-nav-toggle，省回 40px 顶栏宽度）；
 * - 徽标按插件 sidebarItem 通用 badge 声明渲染计数徽标 / 安静圆点
 *   （mobile-quick-badge / mobile-quick-dot）；
 * - 主屏已停在该插件视图或无 quickEntry 时返回 null（零占位残留）；仅移动端视口渲染；
 * - 点击走标准 store 路由（openTarget），零插件 ID 特判。
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { HelmxIcon } from '@helmx/ui'
import { useConversations, useGroupedUi, usePrimaryTarget, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useIsMobileViewport } from '../lib/use-media-query.js'
import { isSameResolvedTarget } from '../lib/types.js'
import {
  composeSidebarBadgeLabel,
  extractRailQuickEntries,
  sidebarBadgeCountLabel,
  type ResolvedSidebarBadge,
  type SidebarViewItem,
} from './sidebar-model.js'
import { useSidebarBadges } from './use-sidebar-badges.js'

export interface MobileQuickNavProps {
  /** 首个已声明 quickEntry 的插件视图（无则为 null，不渲染任何内容）。 */
  quickEntry: SidebarViewItem | null
  /** quickEntry 视图的 sidebar.item badge 解析结果（无信号为 null，零渲染残留）。 */
  quickEntryBadge?: ResolvedSidebarBadge | null
}

export function MobileQuickNav({ quickEntry, quickEntryBadge = null }: MobileQuickNavProps): ReactNode {
  const { t } = useWebLocale()
  const { openTarget } = useStoreActions()
  const primaryTarget = usePrimaryTarget()
  const isMobileViewport = useIsMobileViewport()
  if (!isMobileViewport) return null
  const visibleQuickEntry =
    quickEntry !== null && !isSameResolvedTarget(primaryTarget, quickEntry.target) ? quickEntry : null
  if (visibleQuickEntry === null) return null
  const quickLabel = composeSidebarBadgeLabel(visibleQuickEntry.label, quickEntryBadge)
  return (
    <div className="mobile-quick-nav" role="group" aria-label={t('shell.overview.quickNavGroup')}>
      <button
        type="button"
        className="mobile-quick-btn"
        title={quickLabel}
        aria-label={quickLabel}
        onClick={() => openTarget(visibleQuickEntry.target)}
      >
        <HelmxIcon name={visibleQuickEntry.icon} size={15} />
        {quickEntryBadge !== null && !quickEntryBadge.dot && quickEntryBadge.count > 0 && (
          <span className="mobile-quick-badge" data-tone={quickEntryBadge.tone}>
            {sidebarBadgeCountLabel(quickEntryBadge.count)}
          </span>
        )}
        {quickEntryBadge !== null && quickEntryBadge.dot && (
          <span className="mobile-quick-dot" data-tone={quickEntryBadge.tone} />
        )}
      </button>
    </div>
  )
}

/** Isolates root shell from `useConversations` / `useGroupedUi` / `useSidebarBadges` churn. */
export function MobileQuickNavSlot({
  onVisibilityChange,
}: {
  onVisibilityChange: (visible: boolean) => void
}): ReactNode {
  const { locale } = useWebLocale()
  const isMobileViewport = useIsMobileViewport()
  const groupedUi = useGroupedUi()
  const conversations = useConversations()
  const primaryTarget = usePrimaryTarget()

  const firstQuickEntry = useMemo(
    () => extractRailQuickEntries(groupedUi.sidebarItems, groupedUi.screens, conversations, locale)[0] ?? null,
    [groupedUi.sidebarItems, groupedUi.screens, conversations, locale],
  )
  const quickBadgeItems = useMemo(() => (firstQuickEntry !== null ? [firstQuickEntry] : []), [firstQuickEntry])
  const quickEntryBadges = useSidebarBadges(quickBadgeItems)
  const quickEntryBadge = firstQuickEntry !== null ? (quickEntryBadges.get(firstQuickEntry.key) ?? null) : null
  const visible = isMobileViewport && firstQuickEntry !== null && !isSameResolvedTarget(primaryTarget, firstQuickEntry.target)

  useEffect(() => {
    onVisibilityChange(visible)
  }, [visible, onVisibilityChange])

  if (!isMobileViewport) return null
  return <MobileQuickNav quickEntry={firstQuickEntry} quickEntryBadge={quickEntryBadge} />
}
