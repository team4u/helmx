/**
 * 会话总览（对话空间一级全量看板与治理大盘 `#/overview`）：
 *
 * - 入口定位：通过侧栏工作集底部（「查看全部 N 个会话」「已归档会话 (N)」及搜索态「在会话总览中查看匹配」）、
 *   全局命令面板（Mod+K）或 `#/overview` 深链按需进入；冷启动空 Hash 默认直进对话空间待命页，Hub 升级卡与
 *   被动升级提示条挂载于主舞台壳层而非本页；
 * - 复用态势模型的唯一树聚合口径：一张卡片 = 一棵根会话树（含安静树），
 *   卡面只呈现真实事实（根会话状态 + 树级后台在途的灯位、lastError /
 *   doing / 后台摘要 / 后代运行计数），绝不编造进度；
 * - 分层态势分组（Grouped Triage Stage）：默认按状态分为「需处理 → 进行中 →
 *   未读完成 → 近期安静」四节纵向排列（空节零占位），并支持切换按角色 /
 *   按节点分组及分节折叠；当筛选把分组维度收敛为单一值时自动去套娃平铺，
 *   搜索激活时自动临时展开分节防藏匿；活跃卡片展示最多 5 枚后代芯片，
 *   安静树默认收拢后代为单枚「N 个子会话」展开胶囊以消除网格高矮参差；
 * - 直进语义：卡片主体 / 后代芯片点击直达主屏会话（树内有等待人类的会话
 *   时直达最新审批现场），与会话列表点击完全一致；「抽屉速览」与「右分屏
 *   打开」收进卡片 `...` 菜单（prependItems 通用前置动作），托管/受保护卡
 *   也至少保留这两个只读视图动作；
 * - 顶栏「新话题」：单候选角色直进待命页，多候选下拉选角（最近活跃根会话
 *   所属角色置顶，远端节点 @后缀标注）；首次发送才落库，不预创建会话；
 * - 筛选：全部 / 需处理 / 进行中 / 未读 / 已归档（SegmentedControl）+ 角色 / 节点 /
 *   来源（SDK Select）+ 标题/摘要搜索，全部状态经唯一 URL Hash 导航模型
 *   持久化（overview 目标的 sp. / ssp. 路由参数，仅参数变化 replace，
 *   刷新/前进/后退/深链可恢复）；来源 = 常规对话 vs 托管会话，托管判定与
 *   侧栏 sidebarSection filterTag 同源，零插件 ID 特判；排序桶序 + createdAt
 *   倒序，流式输出不跳卡；
 * - 无结果语义：真实空系统与筛选无命中显式区分，无命中提供一键清除筛选；
 *   桶徽标计数在其余筛选上下文内统计（如实表达切桶后的剩余量）；
 * - 批量管理：选择集合始终收敛为当前可见可勾选卡片的子集（筛选变化与
 *   实时会话变化后隐藏项立即出局，绝不悄悄操作不可见对象）；托管/bot 会话
 *   保护与部分失败通知与侧栏同语义；
 * - 卡片元信息区挂 OVERVIEW_CARD_META_SLOT 只读插槽（插件贡献跳转胶囊等，
 *   插槽内可点元素自行拦截冒泡；无贡献零占位）；
 * - 审批仍走 AskDoc、后台通知仍走浏览器通知旧链路——本视图是态势的分发
 *   大堂，不是新的通知收件箱；
 * - 移动端主舞台自适应：筛选折行、卡片网格单列化（responsive 断点）。
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  Checkbox,
  HelmxIcon,
  IconButton,
  LoadingState,
  PluginSlot,
  SearchBox,
  SegmentedControl,
  Select,
  Tooltip,
} from '@helmx/plugin-client'
import { OVERVIEW_CARD_META_SLOT } from '@helmx/protocol/browser'
import {
  useAuthConnection,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { openStandbyWithFocus } from '../conversation/standby-focus.js'
import { BatchActionBar } from '../ui/BatchActionBar.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import {
  buildNewTopicCandidates,
  isConversationBulkSelectable,
} from '../shell/sidebar-model.js'
import { ElapsedTimer } from '../shell/ElapsedTimer.js'
import { NewTopicButton } from '../shell/NewTopicButton.js'
import { useBulkArchive } from '../shell/use-bulk-archive.js'
import { useCollapsibleGroups } from '../shell/use-collapsible-groups.js'
import { useGlobalAttention } from '../shell/use-attention-indicator.js'
import { formatDurationMs, formatFullTimestamp } from '../lib/format.js'
import {
  buildArchivedOverviewCards,
  buildOverviewCards,
  filterOverviewCards,
  groupOverviewCards,
  overviewBucketCounts,
  overviewFilterParamsRepair,
  overviewNodeOptions,
  overviewProfileOptions,
  overviewShouldShowSectionHeaders,
  parseOverviewFilterParams,
  resolveOverviewCardRunStartedAt,
  resolveOverviewCardTiming,
  resolveOverviewCardWaitingSince,
  resolveOverviewDescendantChipAnchor,
  OVERVIEW_DESCENDANT_LIMIT,
  type OverviewBucketFilter,
  type OverviewCard,
  type OverviewFilterParamKey,
  type OverviewGroupBy,
  type OverviewSourceFilter,
} from './overview-model.js'

const SEARCH_PARAM_DEBOUNCE_MS = 180

export interface ConversationOverviewProps {
  isSplit?: boolean
  onCloseSplit?: () => void
}

type BucketFilterValue = OverviewBucketFilter
type SourceFilterValue = OverviewSourceFilter

/** 单卡：根会话树聚合卡（只读）；卡面/芯片直进主屏会话。
 * 可访问性结构：外层 div 仅承载鼠标整卡点击便利（不挂交互 ARIA 角色，
 * 避免交互嵌套），真正的语义入口是标题簇真按钮（含状态灯可读标签，
 * 键盘 Enter/Space 可达）；菜单/勾选框/芯片/展开开关均为独立兄弟控件，
 * 绝不嵌套进按钮。批量模式下按钮与整卡点击变为勾选切换（aria-pressed）。 */
const OverviewCardView = memo(function OverviewCardView({
  card,
  onOpenConversation,
  onDrawerPeek,
  onOpenSplit,
  viewedConversationIds,
  batchMode = false,
  selectable = false,
  selected = false,
  expanded = false,
  onToggleSelect,
  onToggleExpanded,
}: {
  card: OverviewCard
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
  viewedConversationIds: ReadonlySet<number>
  batchMode?: boolean
  selectable?: boolean
  selected?: boolean
  /** 卡内后代芯片是否展开全量（确定性排序不变，仅补齐剩余）。 */
  expanded?: boolean
  onToggleSelect?: (conversationId: number) => void
  onToggleExpanded?: (rootConversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const attentionId = useId()
  const needsAttention = card.bucket === 'needs_attention'
  const errorText = card.representative.status === 'error' ? card.representative.lastError?.trim() : undefined
  const remoteNodeId = card.root.nodeId !== undefined && card.root.nodeId !== 'local' ? card.root.nodeId : null
  const waitingSince = resolveOverviewCardWaitingSince(card)
  const runningSince = resolveOverviewCardRunStartedAt(card)
  const staticTiming =
    waitingSince === undefined && runningSince === undefined ? resolveOverviewCardTiming(card) : undefined

  // 紧凑元信息行：角色 · @节点 · 耗时/秒表 · 摘要 同一行（远端节点与耗时折叠进来，
  // 不增加卡片高度）；摘要尾随弹性截断，角色/节点/耗时固定不丢事实。
  const leadingParts: ReactNode[] = []
  if (card.profileLabel !== '') {
    leadingParts.push(
      <span key="profile" className="overview-card-sub-profile">
        {card.profileLabel}
      </span>,
    )
  }
  if (remoteNodeId !== null) {
    leadingParts.push(
      <span key="node" className="overview-card-sub-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
        @{remoteNodeId}
      </span>,
    )
  }
  if (staticTiming?.settledRunMs !== undefined) {
    const createdText = formatFullTimestamp(card.root.createdAt)
    const updatedText = formatFullTimestamp(card.root.updatedAt)
    const timingTooltip = [
      createdText !== '' ? t('shell.overview.createdAt', { time: createdText }) : '',
      updatedText !== '' ? t('shell.overview.updatedAt', { time: updatedText }) : '',
    ].filter((line) => line !== '').join('\n')
    leadingParts.push(
      <span
        key="timing"
        className="overview-card-sub-time mono tabular-nums"
        title={timingTooltip || undefined}
      >
        {t('shell.overview.totalRun', { duration: formatDurationMs(staticTiming.settledRunMs) })}
      </span>,
    )
  }
  const trailingSummary =
    !needsAttention && card.summaryText !== '' ? (
      <span key="summary" className="overview-card-sub-summary" title={card.summaryText}>
        {card.summaryText}
      </span>
    ) : null
  const liveTimerNode =
    waitingSince !== undefined ? (
      <ElapsedTimer
        since={waitingSince}
        formatText={(duration) => t('shell.overview.waited', { duration })}
        className="overview-card-sub-time overview-card-sub-time-warn mono tabular-nums"
        leadingSeparator={leadingParts.length > 0}
        trailingSeparator={trailingSummary !== null}
      />
    ) : runningSince !== undefined ? (
      <ElapsedTimer
        since={runningSince}
        className="overview-card-sub-time mono tabular-nums"
        leadingSeparator={leadingParts.length > 0}
        trailingSeparator={trailingSummary !== null}
      />
    ) : null
  const hasMetaSub = leadingParts.length > 0 || liveTimerNode !== null || trailingSummary !== null
  const toggleCardSelect = (): void => {
    if (selectable) onToggleSelect?.(card.root.id)
  }
  const activateCard = (): void => {
    if (batchMode) {
      toggleCardSelect()
      return
    }
    onOpenConversation(card.targetConversationId)
  }
  const openLabel = t('shell.attention.openConversation', { id: card.targetConversationId })
  const cardTitleText = card.root.title || t('shell.conversationFallback', { id: card.root.id })
  // 批量模式按钮语义切换为勾选（aria-pressed 表态，名称如实描述切换动作）；
  // 普通模式不覆写 aria-label——可访问名称直接由内容组成（状态灯可读标签 +
  // 标题 + #id），异常/等待人类事实原样进入读屏。
  const buttonLabel = batchMode ? `${cardTitleText} · ${t('shell.overview.batchToggleCard')}` : openLabel
  const descendantItems = card.directDescendants
  const collapseDescendantsByDefault = card.bucket === 'quiet' || card.bucket === 'archived'
  const shownDescendants = expanded
    ? descendantItems
    : collapseDescendantsByDefault
      ? []
      : descendantItems.slice(0, OVERVIEW_DESCENDANT_LIMIT)
  const hiddenDirectDescendantCount = Math.max(0, descendantItems.length - OVERVIEW_DESCENDANT_LIMIT)
  const showDescendantToggle = collapseDescendantsByDefault
    ? descendantItems.length > 0
    : hiddenDirectDescendantCount > 0
  const descendantToggleLabel = expanded
    ? t('shell.overview.collapseDescendants')
    : collapseDescendantsByDefault
      ? descendantItems.length === 1
        ? t('shell.overview.quietDescendantOne')
        : t('shell.overview.quietDescendants', { count: descendantItems.length })
      : t('shell.overview.moreDescendants', { count: hiddenDirectDescendantCount })
  return (
    <article
      className={`overview-card overview-card-${card.bucket}${selected ? ' is-selected' : ''}`}
      onClick={activateCard}
    >
      <div className="overview-card-head">
        {batchMode && (
          <span className="overview-card-batch-check" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selected}
              aria-label={cardTitleText}
              disabled={!selectable}
              title={selectable ? undefined : t('shell.overview.batchProtected')}
              onChange={toggleCardSelect}
            />
          </span>
        )}
        {/* 语义主入口：真按钮包住标题簇（灯 + 标题 + #id）。按钮内容即
            标题提供可访问名称，需处理原因通过 aria-describedby 关联。 */}
        <button
          type="button"
          className="overview-card-open"
          title={buttonLabel}
          aria-label={batchMode ? buttonLabel : undefined}
          aria-pressed={batchMode ? selected : undefined}
          aria-describedby={needsAttention ? attentionId : undefined}
          disabled={batchMode && !selectable}
          onClick={(e) => {
            e.stopPropagation()
            activateCard()
          }}
        >
          <span className="nav-status-slot">
            {/* 灯位与侧栏会话行完全同构（通用统一口径）：根会话自身状态 +
                树级后台在途聚合，经同一 resolveStatusLight 单灯裁决——根 idle
                且树内有后台在途时同样渲染空心蓝环；子代理等后代状态由后代
                芯片各自的灯与诚实摘要承载，不在卡面灯位混入代表位语义。 */}
            <ConversationStatusDot
              conv={card.root}
              background={{ active: card.backgroundActive, summary: card.backgroundSummary }}
              showDone={card.root.unread && !viewedConversationIds.has(card.root.id)}
            />
          </span>
          <span className="overview-card-title">
            {cardTitleText}
          </span>
          <span className="overview-card-id tabular-nums">#{card.root.id}</span>
        </button>
        {!batchMode && (
          <span className="overview-card-actions" onClick={(e) => e.stopPropagation()}>
            <Tooltip content={t('shell.overview.drawerPeek')} side="top">
              <IconButton
                variant="ghost"
                size="xs"
                className="overview-card-peek-btn"
                icon={<HelmxIcon name="panel-right" size={13} />}
                aria-label={t('shell.overview.drawerPeek')}
                onClick={(e) => {
                  e.stopPropagation()
                  onDrawerPeek(card.targetConversationId)
                }}
              />
            </Tooltip>
            <ConversationRowActionsMenu
              conversation={card.root}
              enableDelete
              prependItems={[
                {
                  key: 'drawer-peek',
                  icon: 'panel-right',
                  label: t('shell.overview.drawerPeek'),
                  onSelect: () => onDrawerPeek(card.targetConversationId),
                },
                {
                  key: 'open-split',
                  icon: 'columns',
                  label: t('shell.sidebar.openInRightSplit'),
                  onSelect: () => onOpenSplit(card.targetConversationId),
                },
              ]}
            />
          </span>
        )}
      </div>
      {needsAttention && (
        <p id={attentionId} className="overview-card-attention" title={errorText}>
          {card.hasWaiting && t('shell.overview.waitingForYou')}
          {card.hasError && card.hasWaiting && ' · '}
          {card.hasError && t('shell.overview.hasError')}
          {errorText && ` · ${errorText}`}
        </p>
      )}
      {hasMetaSub && (
        <div className="overview-card-sub">
          {leadingParts.flatMap((part, index) =>
            index === 0
              ? [part]
              : [
                  <span key={`sep-${index}`} className="overview-card-sub-sep" aria-hidden="true">
                    ·
                  </span>,
                  part,
                ],
          )}
          {liveTimerNode}
          {liveTimerNode === null && leadingParts.length > 0 && trailingSummary !== null ? (
            <span className="overview-card-sub-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {trailingSummary}
        </div>
      )}
      {/* 插槽位于标题按钮之外，插件可点元素沿用 stopPropagation 契约。 */}
      <PluginSlot
        ownerPluginId="builtin:overview"
        name={OVERVIEW_CARD_META_SLOT}
        conversationId={card.root.id}
        slotProps={{ rootConversation: card.root, memberIds: card.memberIds }}
        className="overview-card-meta-slot"
      />
      {descendantItems.length > 0 && (
        <div className="overview-chips">
          {shownDescendants.map((descendant) => {
            const chipAnchor = resolveOverviewDescendantChipAnchor(descendant)
            return (
              <button
                key={descendant.conv.id}
                type="button"
                className="overview-chip"
                title={t('shell.attention.openConversation', { id: descendant.conv.id })}
                onClick={(e) => {
                  e.stopPropagation()
                  if (batchMode) {
                    toggleCardSelect()
                    return
                  }
                  onOpenConversation(descendant.conv.id)
                }}
              >
                <ConversationStatusDot
                  conv={descendant.conv}
                  background={descendant.backgroundActive ? { active: true, summary: '' } : undefined}
                  aggregate={{
                    activeCount: descendant.subtreeActiveCount,
                    errorCount: descendant.subtreeErrorCount,
                    waitingCount: descendant.subtreeWaitingCount,
                  }}
                  showDone={descendant.conv.unread && !viewedConversationIds.has(descendant.conv.id)}
                />
                <span className="overview-chip-label">
                  {descendant.conv.title || t('shell.conversationFallback', { id: descendant.conv.id })}
                </span>
                {(descendant.subtreeDescendantCount ?? 0) > 0 ? (
                  <span className="overview-chip-elapsed tabular-nums" title={t('shell.sidebar.overviewDirectSubBadge', { count: descendant.subtreeDescendantCount ?? 0 })}>
                    {descendant.subtreeDescendantCount}
                  </span>
                ) : null}
                {chipAnchor !== undefined ? (
                  <ElapsedTimer
                    since={chipAnchor.since}
                    className={`overview-chip-elapsed mono tabular-nums${chipAnchor.kind === 'waiting' ? ' overview-chip-elapsed-warn' : ''}`}
                  />
                ) : null}
              </button>
            )
          })}
          {/* 安静卡默认折叠全部后代为「N 个子会话」，活跃卡超过上限折叠为「还有 N 个」，
              点击均就地按同序展开补齐剩余后代，再点收起。 */}
          {showDescendantToggle && (
            <button
              type="button"
              className={`overview-chip-more tabular-nums${collapseDescendantsByDefault && !expanded ? ' overview-chip-quiet-summary' : ''}`}
              aria-expanded={expanded}
              title={descendantToggleLabel}
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpanded?.(card.root.id)
              }}
            >
              {descendantToggleLabel}
            </button>
          )}
        </div>
      )}
    </article>
  )
})

export function ConversationOverview({ isSplit = false, onCloseSplit }: ConversationOverviewProps): ReactNode {
  const { locale, t } = useWebLocale()
  const { openTarget, openConversationDrawer, setScreenParams, pushNotice } = useStoreActions()
  const { background, viewedConversationIds } = useGlobalAttention()
  const conversations = useConversations()
  const plugins = usePlugins()
  const groupedUi = useGroupedUi()
  const { profiles, assetsLoaded } = useProfilesSlice()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { sseConnected } = useAuthConnection()
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(new Set())
  const sectionIdPrefix = useId()
  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'overview' }),
  })

  // 筛选与分组状态接入唯一 URL Hash 导航模型：总览目标在 sp. / ssp. 命名
  // 空间携带 bucket/profile/node/source/q/group 路由参数（主屏 sp.、分屏 ssp.），
  // 经 store.setScreenParams 写入——仅参数变化默认 replace 不污染后退栈，
  // 刷新/前进/后退/深链恢复全由地址栏唯一事实源驱动；切换主屏目标时
  // 命名空间参数随之丢弃（重新进入总览即回到默认态）。
  const routeTarget = isSplit ? splitTarget : primaryTarget
  const overviewParams = routeTarget !== null && routeTarget.kind === 'overview' ? routeTarget.params : undefined
  const filter = useMemo(() => parseOverviewFilterParams(overviewParams), [overviewParams])
  const bucketFilter = filter.bucket
  const profileFilter = filter.profileId
  const nodeFilter = filter.nodeId
  const sourceFilter = filter.source
  const routeQueryFilter = filter.query
  const groupBy = filter.groupBy
  const [searchDraft, setSearchDraft] = useState(routeQueryFilter)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRouteQueryRef = useRef(routeQueryFilter)
  useEffect(() => {
    if (prevRouteQueryRef.current === routeQueryFilter) return
    prevRouteQueryRef.current = routeQueryFilter
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    setSearchDraft((prev) => (prev === routeQueryFilter ? prev : routeQueryFilter))
  }, [routeQueryFilter])
  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  }, [])
  const queryFilter = searchDraft
  const effectiveFilter = useMemo(
    () => ({
      bucket: bucketFilter,
      profileId: profileFilter,
      nodeId: nodeFilter,
      source: sourceFilter,
      groupBy,
      query: queryFilter,
    }),
    [bucketFilter, profileFilter, nodeFilter, sourceFilter, groupBy, queryFilter],
  )
  const applyFilterParam = useCallback(
    (patch: Partial<Record<OverviewFilterParamKey, string | undefined>>): void => {
      setScreenParams(patch, { split: isSplit === true })
    },
    [setScreenParams, isSplit],
  )
  const handleSearchChange = useCallback(
    (next: string): void => {
      setSearchDraft(next)
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      if (next === '') {
        applyFilterParam({ q: undefined })
        return
      }
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null
        applyFilterParam({ q: next.trim() === '' ? undefined : next })
      }, SEARCH_PARAM_DEBOUNCE_MS)
    },
    [applyFilterParam],
  )
  const clearSearchImmediately = useCallback((): void => {
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    setSearchDraft('')
    applyFilterParam({ q: undefined })
  }, [applyFilterParam])
  const clearAllFilters = useCallback((): void => {
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    setSearchDraft('')
    applyFilterParam({ bucket: undefined, profile: undefined, node: undefined, source: undefined, q: undefined })
  }, [applyFilterParam])
  // 深链自愈：手工拼写的非法枚举值/未知键（Hash 模型只能拦键形与空值）
  // 在组件边界一次性修正为规范形态（replace，不产生额外历史项）。
  useEffect(() => {
    const repair = overviewFilterParamsRepair(overviewParams)
    if (repair !== null) setScreenParams(repair, { split: isSplit === true })
  }, [overviewParams, isSplit, setScreenParams])

  const cards = useMemo(
    () => buildOverviewCards({ conversations, background, profiles, plugins, viewedConversationIds, t }),
    [conversations, background, profiles, plugins, viewedConversationIds, t],
  )
  const archivedCards = useMemo(
    () => buildArchivedOverviewCards({ conversations, background, profiles, plugins }),
    [conversations, background, profiles, plugins],
  )
  const isArchivedView = bucketFilter === 'archived'
  const showArchivedTab = archivedCards.length > 0 || isArchivedView
  const activePoolCards = isArchivedView ? archivedCards : cards
  const visibleCards = useMemo(
    () =>
      filterOverviewCards(activePoolCards, {
        bucket: isArchivedView ? 'all' : bucketFilter,
        profileId: profileFilter,
        nodeId: nodeFilter,
        source: isArchivedView ? 'all' : sourceFilter,
        query: queryFilter,
      }),
    [activePoolCards, isArchivedView, bucketFilter, profileFilter, nodeFilter, sourceFilter, queryFilter],
  )
  const showSectionHeaders = overviewShouldShowSectionHeaders(effectiveFilter)
  const cardGroups = useMemo(
    () => (showSectionHeaders ? groupOverviewCards(visibleCards, groupBy, t) : []),
    [showSectionHeaders, visibleCards, groupBy, t],
  )
  const { activeCollapsedKeys, toggleGroupCollapsed } = useCollapsibleGroups(queryFilter)
  const renderedCards = useMemo(() => {
    if (!showSectionHeaders) return visibleCards
    return cardGroups.flatMap((group) => (activeCollapsedKeys.has(group.key) ? [] : group.cards))
  }, [showSectionHeaders, visibleCards, cardGroups, activeCollapsedKeys])
  const dataReady = conversations.length > 0 || (assetsLoaded && sseConnected)
  const allKnownCards = useMemo(() => [...cards, ...archivedCards], [cards, archivedCards])
  const profileOptions = useMemo(() => overviewProfileOptions(allKnownCards), [allKnownCards])
  const nodeOptions = useMemo(() => overviewNodeOptions(allKnownCards), [allKnownCards])
  // 来源筛选仅在非已归档视图且存在自动化会话（或已选非默认 human，防深链困住）时展示。
  const hasAutomatedCards = useMemo(() => cards.some((card) => card.automated), [cards])
  const automatedNeedsAttentionCount = useMemo(
    () => cards.filter((card) => card.automated && card.bucket === 'needs_attention').length,
    [cards],
  )
  const sourcePoolTotal = useMemo(() => {
    if (isArchivedView) return archivedCards.length
    if (sourceFilter === 'human') return cards.filter((card) => !card.automated).length
    if (sourceFilter === 'automated') return cards.filter((card) => card.automated).length
    return cards.length
  }, [isArchivedView, archivedCards.length, cards, sourceFilter])
  const showSourceFilter = !isArchivedView && (sourceFilter !== 'human' || hasAutomatedCards)
  const anySubFilterActive =
    profileFilter !== '' ||
    nodeFilter !== '' ||
    (!isArchivedView && sourceFilter !== 'human') ||
    queryFilter.trim() !== ''
  const anyFilterActive = bucketFilter !== 'all' || anySubFilterActive

  // 桶计数在角色/节点/来源/搜索上下文内统计：徽标如实表达「切到该桶后
  // 剩几张卡」，避免全量计数与当前上下文错位造成误解。
  const bucketCounts = useMemo(
    () =>
      overviewBucketCounts(
        cards,
        {
          profileId: profileFilter,
          nodeId: nodeFilter,
          source: sourceFilter,
          query: queryFilter,
        },
        archivedCards,
      ),
    [cards, archivedCards, profileFilter, nodeFilter, sourceFilter, queryFilter],
  )

  // 批量管理勾选口径：人类自有根会话（可归档可删除）与空闲自动化历史会话
  // （仅可批量删除，如已结束的 swarm worker）的并集；在途（working/
  // blocked）helmx 会话不参与勾选，插件 manageConversation 托管保护由服务端
  // bulk-delete 逐项权威判定。且收起分节内的卡片不可见，不得进入可勾选与
  // 有效选择集。
  const renderedRoots = useMemo(() => renderedCards.map((card) => card.root), [renderedCards])
  const archiveSourceRoots = useMemo(() => activePoolCards.map((card) => card.root), [activePoolCards])
  const batch = useBulkArchive({
    renderedRoots,
    archiveSourceRoots,
    targetArchived: !isArchivedView,
    pushNotice,
    t,
  })
  const { selectableIds: selectableCardIds, archiving, effectiveArchivableSelectedIds, executeBatchArchive } = batch

  const toggleCardExpanded = useCallback((rootConversationId: number): void => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev)
      if (next.has(rootConversationId)) {
        next.delete(rootConversationId)
      } else {
        next.add(rootConversationId)
      }
      return next
    })
  }, [])

  const openConversation = useCallback(
    (conversationId: number): void => {
      // 直进语义：与会话列表点击完全一致（总览开在右分屏时进同侧分屏）。
      openTarget({ kind: 'conversation', conversationId }, isSplit ? { split: true } : undefined)
    },
    [openTarget, isSplit],
  )

  const drawerPeek = useCallback(
    (conversationId: number): void => {
      openConversationDrawer(conversationId)
    },
    [openConversationDrawer],
  )

  const openSplit = useCallback(
    (conversationId: number): void => {
      openTarget({ kind: 'conversation', conversationId }, { split: true })
    },
    [openTarget],
  )

  // 顶栏「新话题」候选：与侧栏总览模式共用 buildNewTopicCandidates，仅人类可选
  // 且可见的角色可开新聊；最近活跃根会话所属角色置顶，其余按站位序。
  const newTopicCandidates = useMemo(
    () =>
      buildNewTopicCandidates({
        profiles,
        conversations,
        plugins,
        sidebarItems: groupedUi.sidebarItems,
        locale,
      }),
    [profiles, conversations, plugins, groupedUi.sidebarItems, locale],
  )

  const openNewTopic = useCallback((profileId: string, opts?: { flush?: boolean }): void => {
    openStandbyWithFocus(
      { panel: isSplit ? 'split' : 'primary', profileId },
      () => openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined),
      opts,
    )
  }, [isSplit, openTarget])

  // 数据就绪门：会话快照未到（且资产未齐/SSE 未连）时如实展示加载态，
  // 绝不把「还没加载」伪报成「没有会话」；一旦有任何会话或资产+SSE 双就绪，
  // 空列表才是真实的空（此后瞬时断连保留既有快照，不闪加载）。

  return (
    <div className={`primary-center conversation-overview${isSplit ? ' is-split' : ''}`} data-view="conversation-overview">
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="activity" size={14} />
            <span>{t('shell.overview.title')}</span>
          </div>
          <span className="primary-center-subtitle tabular-nums">
            {isArchivedView
              ? anySubFilterActive
                ? t('shell.overview.statsArchivedFiltered', { count: visibleCards.length, total: archivedCards.length })
                : t('shell.overview.statsArchived', { count: visibleCards.length })
              : anyFilterActive
                ? t('shell.overview.statsFiltered', { count: visibleCards.length, total: sourcePoolTotal })
                : t('shell.overview.stats', { count: visibleCards.length })}
          </span>
        </div>
        <div className="primary-center-topbar-actions pane-actions">
          <NewTopicButton
            variant="toolbar"
            className="overview-newtopic-btn"
            candidates={newTopicCandidates}
            onSelectProfile={openNewTopic}
          />
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={isSplitActive}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      <div className="primary-center-toolbar overview-toolbar">
        <SegmentedControl<BucketFilterValue>
          value={bucketFilter}
          onValueChange={(value) => applyFilterParam({ bucket: value === 'all' ? undefined : value })}
          aria-label={t('shell.overview.title')}
          items={[
            { value: 'all', label: t('shell.overview.filterAll'), badge: <span className="tabular-nums">{bucketCounts.all}</span> },
            { value: 'needs_attention', label: t('shell.overview.filterNeeds'), badge: <span className="tabular-nums">{bucketCounts.needs_attention}</span> },
            { value: 'running', label: t('shell.overview.filterRunning'), badge: <span className="tabular-nums">{bucketCounts.running}</span> },
            { value: 'unread_done', label: t('shell.overview.filterUnread'), badge: <span className="tabular-nums">{bucketCounts.unread_done}</span> },
            ...(showArchivedTab
              ? [{ value: 'archived' as const, label: t('shell.overview.filterArchived'), badge: <span className="tabular-nums">{bucketCounts.archived}</span> }]
              : []),
          ]}
        />
        <div className="overview-filter-selects">
          <SearchBox
            className="search-box overview-search-box"
            clearButtonClassName="btn btn-ghost btn-icon-xs overview-search-clear"
            icon={<HelmxIcon name="search" size={13} />}
            clearIcon={<HelmxIcon name="x" size={12} />}
            value={searchDraft}
            onChange={handleSearchChange}
            onCleared={clearSearchImmediately}
            placeholder={t('shell.overview.searchPlaceholder')}
            ariaLabel={t('shell.overview.searchLabel')}
            clearLabel={t('shell.overview.clearSearch')}
            clearOnEscape
          />
          <Select
            className="overview-filter-select"
            aria-label={t('shell.overview.profileFilterLabel')}
            options={[
              { value: '', label: t('shell.overview.profileFilter') },
              ...profileOptions.map((option) => ({ value: option.id, label: option.label })),
            ]}
            value={profileFilter}
            onChange={(event) => applyFilterParam({ profile: event.target.value === '' ? undefined : event.target.value })}
          />
          <Select
            className="overview-filter-select"
            aria-label={t('shell.overview.nodeFilterLabel')}
            options={[
              { value: '', label: t('shell.overview.nodeFilter') },
              ...nodeOptions.map((nodeId) => ({
                value: nodeId,
                label: nodeId === 'local' ? t('shell.overview.localNode') : nodeId,
              })),
            ]}
            value={nodeFilter}
            onChange={(event) => applyFilterParam({ node: event.target.value === '' ? undefined : event.target.value })}
          />
          {showSourceFilter && (
            <Select
              className="overview-filter-select"
              aria-label={t('shell.overview.sourceFilterLabel')}
              options={[
                { value: 'human', label: t('shell.overview.sourceHuman') },
                { value: 'automated', label: t('shell.overview.sourceAutomated') },
                { value: 'all', label: t('shell.overview.sourceFilter') },
              ]}
              value={sourceFilter}
              onChange={(event) =>
                applyFilterParam({
                  source: event.target.value === 'human' ? undefined : (event.target.value as SourceFilterValue),
                })
              }
            />
          )}
          <Select<OverviewGroupBy>
            className="overview-filter-select overview-group-select"
            prefixIcon="layers"
            aria-label={t('shell.overview.groupByLabel')}
            options={[
              { value: 'status', label: t('shell.overview.groupByStatus') },
              { value: 'profile', label: t('shell.overview.groupByProfile') },
              { value: 'node', label: t('shell.overview.groupByNode') },
            ]}
            value={groupBy}
            onChange={(event) =>
              applyFilterParam({
                group: event.target.value === 'status' ? undefined : (event.target.value as OverviewGroupBy),
              })
            }
          />
        </div>
        <Tooltip content={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')} side="top">
          <IconButton
            variant="ghost"
            size="xs"
            className={`overview-batch-toggle${batch.batchMode ? ' is-active' : ''}`}
            icon="check-square"
            aria-label={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
            aria-pressed={batch.batchMode}
            onClick={batch.toggleBatchMode}
          />
        </Tooltip>
      </div>

      <div className="overview-scroll">
        {!isArchivedView && sourceFilter === 'human' && automatedNeedsAttentionCount > 0 && (
          <div className="overview-automated-banner-wrap">
            <div className="callout callout-warn overview-automated-banner" role="status">
              <HelmxIcon name="alert-triangle" size={13} />
              <span className="callout-text">
                {t('shell.overview.automatedNeedsAttention', { count: automatedNeedsAttentionCount })}
              </span>
              <Button
                size="xs"
                className="overview-automated-banner-btn"
                onClick={() => applyFilterParam({ source: 'automated', bucket: 'needs_attention' })}
              >
                {t('shell.overview.viewAutomatedAttention')}
              </Button>
            </div>
          </div>
        )}
        {batch.batchMode && (
          <div className="overview-batch-bar-wrap">
            <BatchActionBar
              className="overview-batch-bar"
              selectedCount={batch.selectedIds.size}
              selectableCount={selectableCardIds.length}
              isAllSelected={batch.isAllSelected}
              deleting={batch.deleting}
              busy={archiving}
              onExit={batch.exitBatchMode}
              onToggleSelectAll={batch.toggleSelectAll}
              extraActions={
                <Button
                  size="sm"
                  pending={archiving}
                  disabled={effectiveArchivableSelectedIds.length === 0 || batch.deleting}
                  onClick={() => void executeBatchArchive()}
                >
                  {isArchivedView
                    ? archiving
                      ? t('shell.archived.restoring')
                      : t('shell.archived.restoreCount', { count: effectiveArchivableSelectedIds.length })
                    : archiving
                      ? t('shell.agents.archiving')
                      : t('shell.agents.archiveCount', { count: effectiveArchivableSelectedIds.length })}
                </Button>
              }
              confirmOpen={batch.confirmOpen}
              onConfirmOpenChange={batch.setConfirmOpen}
              onRequestDelete={batch.requestDeleteConfirm}
              onConfirmDelete={() => void batch.executeBatchDelete()}
            />
          </div>
        )}

        {dataReady === false ? (
          <div className="overview-grid">
            <div className="overview-empty overview-loading">
              <LoadingState label={t('shell.overview.loading')} iconSize={13} />
            </div>
          </div>
        ) : visibleCards.length === 0 ? (
          <div className="overview-grid">
            {isArchivedView && archivedCards.length === 0 ? (
              <div className="overview-empty">
                <span>{t('shell.overview.emptyArchived')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="overview-clear-filters"
                  onClick={clearAllFilters}
                >
                  {t('shell.overview.clearFilters')}
                </Button>
              </div>
            ) : !isArchivedView && !anyFilterActive && sourcePoolTotal === 0 ? (
              <div className="overview-empty">{t('shell.overview.emptySystem')}</div>
            ) : (
              <div className="overview-empty">
                <span>{t('shell.overview.emptyFiltered')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="overview-clear-filters"
                  onClick={clearAllFilters}
                >
                  {t('shell.overview.clearFilters')}
                </Button>
              </div>
            )}
          </div>
        ) : showSectionHeaders ? (
          <div className="overview-sections">
            {cardGroups.map((group) => {
              const collapsed = activeCollapsedKeys.has(group.key)
              const headingId = `${sectionIdPrefix}-${group.key}`
              return (
                <section
                  key={group.key}
                  className={`overview-section overview-section-${group.kind}${group.bucket ? ` overview-section-${group.bucket}` : ''}`}
                  data-group-key={group.key}
                  aria-labelledby={headingId}
                >
                  <div className="overview-section-head">
                    <button
                      type="button"
                      id={headingId}
                      className="overview-section-toggle"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroupCollapsed(group.key)}
                    >
                      <HelmxIcon
                        name={collapsed ? 'chevron-right' : 'chevron-down'}
                        size={13}
                        className="overview-section-chevron"
                      />
                      {group.kind === 'bucket' && group.bucket !== undefined && (
                        <span
                          className={`overview-section-dot overview-section-dot-${group.bucket}`}
                          aria-hidden="true"
                        />
                      )}
                      {group.kind === 'profile' && (
                        <HelmxIcon name="bot" size={12} className="overview-section-icon" />
                      )}
                      {group.kind === 'node' && (
                        <HelmxIcon
                          name={group.nodeId === 'local' ? 'laptop' : 'server'}
                          size={12}
                          className="overview-section-icon"
                        />
                      )}
                      <span
                        className={`overview-section-title${group.kind === 'node' && group.nodeId !== 'local' ? ' mono' : ''}`}
                      >
                        {group.label}
                      </span>
                      <span className="overview-section-count tabular-nums">{group.cards.length}</span>
                    </button>
                    <span className="overview-section-rule" aria-hidden="true" />
                  </div>
                  {!collapsed && (
                    <div className="overview-grid">
                      {group.cards.map((card) => (
                        <OverviewCardView
                          key={card.root.id}
                          card={card}
                          onOpenConversation={openConversation}
                          onDrawerPeek={drawerPeek}
                          onOpenSplit={openSplit}
                          viewedConversationIds={viewedConversationIds}
                          batchMode={batch.batchMode}
                          selectable={isConversationBulkSelectable(card.root)}
                          selected={batch.selectedIds.has(card.root.id)}
                          expanded={expandedCardIds.has(card.root.id)}
                          onToggleSelect={batch.toggleSelect}
                          onToggleExpanded={toggleCardExpanded}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        ) : (
          <div className="overview-grid">
            {visibleCards.map((card) => (
              <OverviewCardView
                key={card.root.id}
                card={card}
                onOpenConversation={openConversation}
                onDrawerPeek={drawerPeek}
                onOpenSplit={openSplit}
                viewedConversationIds={viewedConversationIds}
                batchMode={batch.batchMode}
                selectable={isConversationBulkSelectable(card.root)}
                selected={batch.selectedIds.has(card.root.id)}
                expanded={expandedCardIds.has(card.root.id)}
                onToggleSelect={batch.toggleSelect}
                onToggleExpanded={toggleCardExpanded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
