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
import type { ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { usePrimaryTarget, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useIsMobileViewport } from '../lib/use-media-query.js'
import { isSameResolvedTarget } from '../lib/types.js'
import {
  composeSidebarBadgeLabel,
  sidebarBadgeCountLabel,
  type ResolvedSidebarBadge,
  type SidebarViewItem,
} from './sidebar-model.js'

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
