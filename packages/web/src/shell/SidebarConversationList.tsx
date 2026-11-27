/**
 * 侧栏对话空间工作集列表（分组栏动作 + 活跃与近期根会话树）：
 *
 * - 入口收敛：「新建话题」位于工作集分组栏右侧操作区（单角色直进待命页，多角色下拉选角且最近活跃角色置顶）；
 *   会话总览（#/overview）降级为按需下钻大盘（侧栏顶栏不设常驻总览按钮），由工作集底部与命令面板触发；
 * - 下方工作集（与 #/overview 共享 overview-model 的唯一树聚合、分桶与排序纯函数）：
 *   - 支持分组维度切换（按状态 / 按角色 / 按节点，localStorage 持久化）：
 *     - 按状态：活跃三桶（需处理 > 进行中 > 未读完成）全量展示（createdAt 倒序不跳行），
 *       近期安静区按 updatedAt 倒序取前 SIDEBAR_RECENT_QUIET_LIMIT 条并对在场会话保底；
 *     - 按角色：按可见智能体归组（含 0 会话可创建角色，组头带 + 开新话题），每组独立截取近期安静会话；
 *     - 按节点：按运行节点归组（活跃节点优先），每组独立截取近期安静会话；
 *   - 0 会话空态额外提供显式「+ 新话题」引导按钮；
 *   - 超限时底部呈现「查看全部 N 个会话」直达 #/overview（透传当前分组维度）；
 *   - 存在可见人类已归档根树时，底部呈现「已归档会话 (N)」直达 #/overview?sp.bucket=archived；
 *   - 侧栏搜索突破近期上限检索全量未归档人类根树，命中或存在已归档会话时底部提供带 ?sp.q 透传的「在会话总览中查看匹配」；
 * - 职责边界：侧栏专注快速切换、新开话题与当前工作集的批量选择/全选/归档/删除
 *   （已归档治理归一到 #/overview）；
 * - 移动端防误关契约：工具栏按钮、批量操作栏与空态引导按钮不挂 .nav-item，批量模式下的行点击、
 *   勾选框、子会话行以及展开子会话和行尾动作菜单均显式 stopPropagation，
 *   避免冒泡触发 App 外层 .nav-item 关闭移动端抽屉。
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  EmptyState,
  HelmxIcon,
  IconButton,
  LoadingState,
  SearchBox,
  Tooltip,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { openStandbyWithFocus } from '../conversation/standby-focus.js'
import { useAuthConnection, useProfilesSlice, useStoreActions } from '../lib/store-context.js'
import { BatchActionBar } from '../ui/BatchActionBar.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import {
  buildArchivedOverviewCards,
  buildOverviewCards,
  buildSidebarGroupedWorkingSet,
  loadSidebarGroupBy,
  resolveOverviewCardRunStartedAt,
  resolveOverviewCardWaitingSince,
  resolveOverviewDescendantChipAnchor,
  resolveSidebarOverviewDescendants,
  resolveSidebarOverviewPrimaryTarget,
  saveSidebarGroupBy,
  type OverviewCard,
  type OverviewDescendant,
  type OverviewGroupBy,
  type SidebarOverviewDescendantsSlice,
} from '../overview/overview-model.js'
import { hasConversationStatusLight } from './background-activity-model.js'
import type { ConversationBackgroundIndex } from './conversation-status-model.js'
import { ElapsedTimer } from './ElapsedTimer.js'
import { NewTopicButton } from './NewTopicButton.js'
import { useBulkArchive } from './use-bulk-archive.js'
import { useCollapsibleGroups } from './use-collapsible-groups.js'
import {
  activeConversationIdsOf,
  buildAgentStandings,
  buildNewTopicCandidates,
  getConversationPresence,
  isConversationBulkSelectable,
  openAgentStandby,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  type SidebarStoreView,
} from './sidebar-model.js'
import { ConversationStatusDot, SidebarPaneTag } from './SidebarPrimitives.js'

export interface SidebarConversationListProps {
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  viewedConversationIds: ReadonlySet<number>
  onNavigate?: () => void
}

const EMPTY_DESCENDANT_SLICE: SidebarOverviewDescendantsSlice = Object.freeze({
  visible: [],
  hiddenCount: 0,
  hasCollapsibleQuiet: false,
})

// NewTopic and ElapsedTimer extracted to shell/NewTopicButton.tsx and shell/ElapsedTimer.tsx.

interface SidebarWorkingSetTreeItemProps {
  card: OverviewCard
  descendantSlice: SidebarOverviewDescendantsSlice
  expanded: boolean
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  hideProfileMeta?: boolean
  hideNodeMeta?: boolean
  batchMode: boolean
  selectable: boolean
  selected: boolean
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
  onToggleExpanded: (rootConversationId: number) => void
  onToggleSelect: (conversationId: number) => void
}

function sameSidebarPresence(a: SidebarStoreView, b: SidebarStoreView): boolean {
  return (
    a.primaryTarget === b.primaryTarget &&
    a.splitTarget === b.splitTarget &&
    a.focusedPanel === b.focusedPanel
  )
}

/** 侧栏工作集单棵树：紧凑双行主项 + 按需展开的缩进子会话行。 */
const SidebarWorkingSetTreeItem = memo(
  function SidebarWorkingSetTreeItem({
    card,
    descendantSlice,
    expanded,
    store,
    viewedConversationIds,
    hideProfileMeta = false,
    hideNodeMeta = false,
    batchMode,
    selectable,
    selected,
    onOpenConversation,
    onDrawerPeek,
    onOpenSplit,
    onToggleExpanded,
    onToggleSelect,
  }: SidebarWorkingSetTreeItemProps): ReactNode {
    const { t } = useWebLocale()
    const rootPresence = getConversationPresence(store, card.root.id)
    const hasActiveDescendant = card.descendants.some((descendant) => {
      const p = getConversationPresence(store, descendant.conv.id)
      return p.inPrimary || p.inSplit
    })
    const isBranchActive = !rootPresence.active && !rootPresence.splitSecondary && hasActiveDescendant
    const waitingSince = resolveOverviewCardWaitingSince(card)
    const runningSince = resolveOverviewCardRunStartedAt(card)
    const remoteNodeId = card.root.nodeId !== undefined && card.root.nodeId !== 'local' ? card.root.nodeId : null
    const titleText = card.root.title || t('shell.conversationFallback', { id: card.root.id })
    const errorText = card.representative.status === 'error' ? card.representative.lastError?.trim() : undefined
    const primaryTargetId = resolveSidebarOverviewPrimaryTarget(card, descendantSlice.visible)

    // 第二行元信息（严格按状态与 199px 可用宽度裁剪，不渲染静态累计耗时）：
    const leadingParts: ReactNode[] = []
    if (!hideProfileMeta && card.profileLabel !== '') {
      leadingParts.push(
        <span key="profile" className="sidebar-overview-meta-profile" title={card.profileLabel}>
          {card.profileLabel}
        </span>,
      )
    }

    let runningNode: ReactNode = null
    const trailingParts: ReactNode[] = []

    if (card.bucket === 'needs_attention') {
      if (card.hasWaiting) {
        leadingParts.push(
          <ElapsedTimer
            key="attention"
            since={waitingSince}
            prefixLabel={t('shell.overview.waitingForYou')}
            className="sidebar-overview-meta-warn tabular-nums"
          />,
        )
      } else if (card.hasError) {
        const errLabel = errorText ? `${t('shell.overview.hasError')} · ${errorText}` : t('shell.overview.hasError')
        leadingParts.push(
          <span key="attention" className="sidebar-overview-meta-err" title={errLabel}>
            {errLabel}
          </span>,
        )
      }
    } else if (card.bucket === 'running') {
      if (!hideNodeMeta && remoteNodeId !== null) {
        leadingParts.push(
          <span key="node" className="sidebar-overview-meta-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
            @{remoteNodeId}
          </span>,
        )
      }
      if (card.summaryText !== '' && (card.directDescendants.length === 0 || card.root.status === 'working')) {
        trailingParts.push(
          <span key="summary" className="sidebar-overview-meta-summary" title={card.summaryText}>
            {card.summaryText}
          </span>,
        )
      }
      if (runningSince !== undefined) {
        runningNode = (
          <ElapsedTimer
            since={runningSince}
            className="sidebar-overview-meta-time mono tabular-nums"
            separatorClassName="sidebar-overview-meta-sep"
            leadingSeparator={leadingParts.length > 0}
            trailingSeparator={trailingParts.length > 0}
          />
        )
      }
    } else if (!hideNodeMeta && remoteNodeId !== null) {
      leadingParts.push(
        <span key="node" className="sidebar-overview-meta-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
          @{remoteNodeId}
        </span>,
      )
    }

    const hasMetaContent = leadingParts.length > 0 || runningNode !== null || trailingParts.length > 0
    const showDescendantToggle = card.directDescendants.length > 0
    const activeDescendantCount = card.activeDescendantCount
    const descBadgeText = String(card.descendants.length)
    const descToggleLabel =
      activeDescendantCount > 0
        ? t('shell.sidebar.overviewSubBadgeWithActivity', {
            active: activeDescendantCount,
            total: card.descendants.length,
          })
        : t('shell.sidebar.overviewSubBadge', { count: card.descendants.length })
    const subtreeSignals = [
      card.hasError ? t('shell.overview.hasError') : '',
      card.hasWaiting ? t('shell.overview.waitingForYou') : '',
    ].filter(Boolean)
    const showDone = card.root.unread && !viewedConversationIds.has(card.root.id)
    const backgroundActivity = { active: card.backgroundActive, summary: card.backgroundSummary }
    const hasStatusLight = hasConversationStatusLight({
      conv: card.root,
      background: backgroundActivity,
      showDone,
    })

    return (
      <div className="sidebar-overview-tree">
        <div
          className={`nav-item sidebar-overview-item sidebar-overview-item-${card.bucket}${presenceNavClassSuffix(rootPresence)}${isBranchActive ? ' sidebar-overview-item-branch' : ''}${batchMode ? ' is-batch-mode' : ''}${selected ? ' is-selected' : ''}`}
          onClick={(e) => {
            if (batchMode) {
              e.stopPropagation()
              if (!shouldSkipNavRowClick(e.target, e.currentTarget) && selectable) {
                onToggleSelect(card.root.id)
              }
              return
            }
            if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
            onOpenConversation(primaryTargetId)
          }}
        >
          <div className="sidebar-overview-head">
            {batchMode && (
              <span className="sidebar-batch-check" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  className="sidebar-batch-checkbox"
                  checked={selected}
                  aria-label={titleText}
                  disabled={!selectable}
                  title={selectable ? undefined : t('shell.overview.batchProtected')}
                  onChange={() => {
                    if (selectable) onToggleSelect(card.root.id)
                  }}
                />
              </span>
            )}
            <button
              type="button"
              className="nav-item-main nav-open sidebar-overview-open"
              onClick={(e) => {
                if (batchMode) {
                  e.stopPropagation()
                  if (selectable) onToggleSelect(card.root.id)
                  return
                }
                onOpenConversation(primaryTargetId)
              }}
              aria-current={!batchMode && rootPresence.active ? 'page' : undefined}
              aria-pressed={batchMode ? selected : undefined}
              aria-label={batchMode ? `${titleText} · ${t('shell.overview.batchToggleCard')}` : undefined}
              disabled={batchMode && !selectable}
              title={titleText}
            >
              <span className="nav-item-label">{titleText}</span>
            </button>
            {(rootPresence.paneTag !== null || hasStatusLight || !batchMode) && (
              <span
                className={`nav-item-meta sidebar-overview-head-meta${rootPresence.paneTag === null && !hasStatusLight ? ' sidebar-overview-head-meta-actions-only' : ''}`}
              >
                <SidebarPaneTag paneTag={rootPresence.paneTag} />
                {hasStatusLight && (
                  <span className="sidebar-status-slot">
                    <ConversationStatusDot
                      conv={card.root}
                      background={backgroundActivity}
                      showDone={showDone}
                    />
                  </span>
                )}
                {!batchMode && (
                  <span className="nav-item-row-actions" onClick={(e) => e.stopPropagation()}>
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
              </span>
            )}
          </div>

          {(hasMetaContent || showDescendantToggle) && (
            <div className="sidebar-overview-meta">
              <div className="sidebar-overview-meta-text">
                {leadingParts.flatMap((part, index) =>
                  index === 0
                    ? [part]
                    : [
                        <span key={`sep-${index}`} className="sidebar-overview-meta-sep" aria-hidden="true">
                          ·
                        </span>,
                        part,
                      ],
                )}
                {runningNode}
                {runningNode === null && leadingParts.length > 0 && trailingParts.length > 0 ? (
                  <span className="sidebar-overview-meta-sep" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                {trailingParts.flatMap((part, index) =>
                  index === 0
                    ? [part]
                    : [
                        <span key={`trail-sep-${index}`} className="sidebar-overview-meta-sep" aria-hidden="true">
                          ·
                        </span>,
                        part,
                      ],
                )}
              </div>
              {showDescendantToggle && (
                <Tooltip content={subtreeSignals.length > 0 ? `${descToggleLabel} · ${subtreeSignals.join(' · ')}` : descToggleLabel} side="top">
                  <button
                    type="button"
                    className={`sidebar-overview-desc-toggle tabular-nums${expanded ? ' is-expanded' : ''}${card.hasError ? ' is-error' : card.hasWaiting ? ' is-warn' : activeDescendantCount > 0 ? ' is-active' : ''}`}
                    aria-expanded={expanded}
                    aria-label={descToggleLabel}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleExpanded(card.root.id)
                    }}
                  >
                    <HelmxIcon name="git-branch" size={10} />
                    <span>{descBadgeText}</span>
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {descendantSlice.visible.length > 0 && (
          <div className="sidebar-overview-descendants">
            {descendantSlice.visible.map((descendant) => (
              <SidebarWorkingSetDescendantRow
                key={descendant.conv.id}
                descendant={descendant}
                store={store}
                viewedConversationIds={viewedConversationIds}
                batchMode={batchMode}
                selectable={selectable}
                rootConversationId={card.root.id}
                onOpenConversation={onOpenConversation}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </div>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.card === next.card &&
    prev.descendantSlice === next.descendantSlice &&
    prev.expanded === next.expanded &&
    sameSidebarPresence(prev.store, next.store) &&
    prev.viewedConversationIds === next.viewedConversationIds &&
    prev.hideProfileMeta === next.hideProfileMeta &&
    prev.hideNodeMeta === next.hideNodeMeta &&
    prev.batchMode === next.batchMode &&
    prev.selectable === next.selectable &&
    prev.selected === next.selected &&
    prev.onOpenConversation === next.onOpenConversation &&
    prev.onDrawerPeek === next.onDrawerPeek &&
    prev.onOpenSplit === next.onOpenSplit &&
    prev.onToggleExpanded === next.onToggleExpanded &&
    prev.onToggleSelect === next.onToggleSelect,
)

interface SidebarWorkingSetDescendantRowProps {
  descendant: OverviewDescendant
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  batchMode: boolean
  selectable: boolean
  rootConversationId: number
  onOpenConversation: (conversationId: number) => void
  onToggleSelect: (conversationId: number) => void
}

/** 缩进单行子会话。 */
const SidebarWorkingSetDescendantRow = memo(
  function SidebarWorkingSetDescendantRow({
    descendant,
    store,
    viewedConversationIds,
    batchMode,
    selectable,
    rootConversationId,
    onOpenConversation,
    onToggleSelect,
  }: SidebarWorkingSetDescendantRowProps): ReactNode {
    const { t } = useWebLocale()
    const presence = getConversationPresence(store, descendant.conv.id)
    const chipAnchor = resolveOverviewDescendantChipAnchor(descendant)
    const titleText = descendant.conv.title || t('shell.conversationFallback', { id: descendant.conv.id })
    const descendantBranchLabel = t('shell.sidebar.overviewDirectSubBadge', { count: descendant.subtreeDescendantCount ?? 0 })
    const descendantSignals = [
      (descendant.subtreeErrorCount ?? 0) > 0
        ? t('shell.sidebar.overviewSubtreeError', { count: descendant.subtreeErrorCount ?? 0 })
        : '',
      (descendant.subtreeWaitingCount ?? 0) > 0
        ? t('shell.sidebar.overviewSubtreeWaiting', { count: descendant.subtreeWaitingCount ?? 0 })
        : '',
    ].filter(Boolean)
    const descendantMetaTitle = descendantSignals.length > 0
      ? `${descendantBranchLabel} · ${descendantSignals.join(' · ')}`
      : descendantBranchLabel

    const handleActivate = (e: MouseEvent): void => {
      if (batchMode) {
        e.stopPropagation()
        if (selectable) onToggleSelect(rootConversationId)
        return
      }
      onOpenConversation(descendant.conv.id)
    }

    const descShowDone = descendant.conv.unread && !viewedConversationIds.has(descendant.conv.id)
    const descBackground = descendant.backgroundActive ? { active: true, summary: '' } : undefined
    const descAggregate = {
      activeCount: descendant.subtreeActiveCount,
      errorCount: descendant.subtreeErrorCount,
      waitingCount: descendant.subtreeWaitingCount,
    }
    const descHasStatusLight = hasConversationStatusLight({
      conv: descendant.conv,
      background: descBackground,
      showDone: descShowDone,
      aggregate: descAggregate,
    })
    const hasDescMeta =
      (descendant.subtreeDescendantCount ?? 0) > 0 ||
      chipAnchor !== undefined ||
      presence.paneTag !== null ||
      descHasStatusLight

    return (
      <div
        className={`nav-item nav-item-sub sidebar-overview-descendant${presenceNavClassSuffix(presence)}`}
        onClick={(e) => {
          if (batchMode) {
            e.stopPropagation()
            if (!shouldSkipNavRowClick(e.target, e.currentTarget) && selectable) {
              onToggleSelect(rootConversationId)
            }
            return
          }
          if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
          handleActivate(e)
        }}
      >
        <button
          type="button"
          className="nav-item-main nav-open"
          onClick={handleActivate}
          aria-current={!batchMode && presence.active ? 'page' : undefined}
          disabled={batchMode && !selectable}
          title={titleText}
        >
          <span className="nav-item-label">{titleText}</span>
        </button>
        {hasDescMeta && (
          <span className="nav-item-meta">
            {(descendant.subtreeDescendantCount ?? 0) > 0 && (
              <span
                className={`sidebar-overview-desc-children tabular-nums${(descendant.subtreeActiveCount ?? 0) > 0 ? ' is-active' : ''}`}
                title={descendantMetaTitle}
              >
                <HelmxIcon name="git-branch" size={9} /> {descendant.subtreeDescendantCount}
              </span>
            )}
            {chipAnchor !== undefined && (
              <ElapsedTimer
                since={chipAnchor.since}
                className={`sidebar-overview-desc-time mono tabular-nums${chipAnchor.kind === 'waiting' ? ' is-warn' : ''}`}
              />
            )}
            <SidebarPaneTag paneTag={presence.paneTag} />
            {descHasStatusLight && (
              <span className="sidebar-status-slot">
                <ConversationStatusDot
                  conv={descendant.conv}
                  background={descBackground}
                  aggregate={descAggregate}
                  showDone={descShowDone}
                />
              </span>
            )}
          </span>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.descendant === next.descendant &&
    sameSidebarPresence(prev.store, next.store) &&
    prev.viewedConversationIds === next.viewedConversationIds &&
    prev.batchMode === next.batchMode &&
    prev.selectable === next.selectable &&
    prev.rootConversationId === next.rootConversationId &&
    prev.onOpenConversation === next.onOpenConversation &&
    prev.onToggleSelect === next.onToggleSelect,
)

export function SidebarConversationList({
  store,
  background,
  viewedConversationIds,
  onNavigate,
}: SidebarConversationListProps): ReactNode {
  const { t } = useWebLocale()
  const { sseConnected } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const { openConversationDrawer } = useStoreActions()
  const sectionIdPrefix = useId()

  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [groupBy, setGroupBy] = useState<OverviewGroupBy>(() => loadSidebarGroupBy())
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(new Set())
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const handleSelectGroupBy = useCallback((next: OverviewGroupBy): void => {
    setGroupBy(saveSidebarGroupBy(next))
    setGroupMenuOpen(false)
  }, [])

  const filterOpen = searchOpen || search !== ''

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const activeConversationIds = useMemo(
    () => activeConversationIdsOf(store),
    [store.primaryTarget, store.splitTarget],
  )

  const allCards = useMemo(
    () =>
      buildOverviewCards({
        conversations: store.conversations,
        background,
        profiles: store.profiles,
        plugins: store.plugins,
        viewedConversationIds,
        t,
      }),
    [store.conversations, background, store.profiles, store.plugins, viewedConversationIds, t],
  )

  const archivedCount = useMemo(
    () =>
      buildArchivedOverviewCards({
        conversations: store.conversations,
        background,
        profiles: store.profiles,
        plugins: store.plugins,
      }).length,
    [store.conversations, background, store.profiles, store.plugins],
  )

  const agentStandings = useMemo(
    () =>
      buildAgentStandings({
        profiles: store.profiles,
        conversations: store.conversations,
        plugins: store.plugins,
        sidebarItems: store.groupedUi.sidebarItems,
        locale: store.locale,
      }),
    [store.profiles, store.conversations, store.plugins, store.groupedUi.sidebarItems, store.locale],
  )

  const workingSet = useMemo(
    () =>
      buildSidebarGroupedWorkingSet({
        groupBy,
        cards: allCards,
        activeConversationIds,
        agentStandings,
        query: search,
        t,
      }),
    [groupBy, allCards, activeConversationIds, agentStandings, search, t],
  )

  const cardGroups = workingSet.groups
  const { activeCollapsedKeys, toggleGroupCollapsed, normalizedQuery } = useCollapsibleGroups(search)

  const toggleCardExpanded = useCallback((rootConversationId: number): void => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev)
      if (next.has(rootConversationId)) next.delete(rootConversationId)
      else next.add(rootConversationId)
      return next
    })
  }, [])

  const renderedCards = useMemo(
    () => cardGroups.flatMap((group) => (activeCollapsedKeys.has(group.key) ? [] : group.cards)),
    [cardGroups, activeCollapsedKeys],
  )

  const renderedRoots = useMemo(() => renderedCards.map((card) => card.root), [renderedCards])
  const batch = useBulkArchive({
    renderedRoots,
    targetArchived: true,
    pushNotice: store.pushNotice,
    t,
  })
  const { selectableIds: selectableCardIds, archiving, effectiveArchivableSelectedIds, executeBatchArchive } = batch

  const descendantSlicesByRoot = useMemo(() => {
    const map = new Map<number, SidebarOverviewDescendantsSlice>()
    for (const card of renderedCards) {
      map.set(
        card.root.id,
        resolveSidebarOverviewDescendants({
          card,
          expanded: expandedCardIds.has(card.root.id),
          activeConversationIds,
          query: search,
        }),
      )
    }
    return map
  }, [renderedCards, expandedCardIds, activeConversationIds, search])

  const dataReady = store.conversations.length > 0 || (assetsLoaded && sseConnected)

  const newTopicCandidates = useMemo(
    () =>
      buildNewTopicCandidates({
        profiles: store.profiles,
        conversations: store.conversations,
        plugins: store.plugins,
        sidebarItems: store.groupedUi.sidebarItems,
        locale: store.locale,
      }),
    [store.profiles, store.conversations, store.plugins, store.groupedUi.sidebarItems, store.locale],
  )

  const openStandby = useCallback(
    (profileId: string, opts?: { flush?: boolean }) =>
      openStandbyWithFocus(
        { panel: 'primary', profileId },
        () => openAgentStandby(store, profileId, onNavigate),
        opts,
      ),
    [store, onNavigate],
  )

  const openConversation = useCallback(
    (conversationId: number) => {
      store.openTarget({ kind: 'conversation', conversationId })
      onNavigate?.()
    },
    [store, onNavigate],
  )

  const openSplit = useCallback(
    (conversationId: number) => {
      store.openTarget({ kind: 'conversation', conversationId }, { split: true })
      onNavigate?.()
    },
    [store, onNavigate],
  )

  const openOverview = useCallback(
    (params?: Record<string, string>) => {
      store.openTarget(params !== undefined ? { kind: 'overview', params } : { kind: 'overview' })
      onNavigate?.()
    },
    [store, onNavigate],
  )

  const groupByOptions: ReadonlyArray<{ value: OverviewGroupBy; label: string; icon: string }> = [
    { value: 'status', label: t('shell.overview.groupByStatus'), icon: 'activity' },
    { value: 'profile', label: t('shell.overview.groupByProfile'), icon: 'bot' },
    { value: 'node', label: t('shell.overview.groupByNode'), icon: 'server' },
  ]
  const currentGroupLabel = groupByOptions.find((option) => option.value === groupBy)?.label ?? t('shell.overview.groupByStatus')
  const hasVisibleMatchedCards = cardGroups.some((group) => group.cards.length > 0)

  const standbyPresence = resolveSidebarTargetPresence(store, (target) => target.kind === 'agent')
  const standbyStateClass = standbyPresence.active
    ? ' is-active'
    : standbyPresence.splitSecondary
      ? ' is-split'
      : ''
  const newTopicButtonClass = `sidebar-header-icon-btn sidebar-new-topic-btn${standbyStateClass}${standbyPresence.focused ? ' nav-item-focused' : ''}`

  return (
    <div className="sidebar-group sidebar-overview-group">
      <div className="sidebar-group-header sidebar-working-set-header">
        <DropdownMenu open={groupMenuOpen} onOpenChange={setGroupMenuOpen}>
          <Tooltip content={t('shell.overview.groupByLabel')} side="top">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sidebar-group-by-btn"
                aria-label={`${t('shell.overview.groupByLabel')}: ${currentGroupLabel}`}
                aria-haspopup="menu"
                aria-expanded={groupMenuOpen}
              >
                <span className="sidebar-group-by-label">{currentGroupLabel}</span>
                <HelmxIcon name="chevrons-up-down" size={12} className="sidebar-group-by-chevron" />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuPortal>
            <DropdownMenuContent className="pane-more-popover" align="start" sideOffset={4}>
              {groupByOptions.map((option) => {
                const selected = groupBy === option.value
                return (
                  <DropdownMenuItem
                    key={option.value}
                    icon={option.icon}
                    checked={selected}
                    data-group-by-option={option.value}
                    data-active={selected ? 'true' : undefined}
                    aria-checked={selected}
                    onSelect={() => handleSelectGroupBy(option.value)}
                  >
                    {option.label}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
        <div className="sidebar-group-header-actions">
          <Tooltip
            content={filterOpen ? t('shell.agents.collapseFilters') : t('shell.sidebar.overviewFilter')}
            side="top"
          >
            <IconButton
              variant="ghost"
              size="xs"
              className="sidebar-header-icon-btn"
              icon={<HelmxIcon name="list-filter" size={13} />}
              aria-label={t('shell.sidebar.overviewFilter')}
              active={filterOpen}
              onClick={() => {
                if (filterOpen) {
                  setSearch('')
                  setSearchOpen(false)
                } else {
                  setSearchOpen(true)
                }
              }}
            />
          </Tooltip>
          <Tooltip
            content={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
            side="top"
          >
            <IconButton
              variant="ghost"
              size="xs"
              className="sidebar-header-icon-btn sidebar-batch-toggle"
              icon={<HelmxIcon name="check-square" size={13} />}
              aria-label={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
              active={batch.batchMode}
              disabled={batch.deleting || archiving}
              onClick={batch.toggleBatchMode}
            />
          </Tooltip>
          <NewTopicButton
            variant="icon"
            className={newTopicButtonClass}
            candidates={newTopicCandidates}
            active={standbyPresence.active}
            onSelectProfile={openStandby}
          />
        </div>
      </div>

      {filterOpen && (
        <SearchBox
          size="sm"
          surface="subtle"
          className="sidebar-search"
          inputClassName="sidebar-search-input"
          inputRef={searchInputRef}
          value={search}
          onChange={setSearch}
          placeholder={t('shell.sidebar.overviewFilterPlaceholder')}
          ariaLabel={t('shell.sidebar.overviewFilter')}
          clearLabel={t('shell.agents.clearFilter')}
          onCleared={() => {
            searchInputRef.current?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              if (search !== '') setSearch('')
              else setSearchOpen(false)
            }
          }}
        />
      )}

      {batch.batchMode && (
        <BatchActionBar
          className="sidebar-batch-bar"
          selectedCount={batch.selectedIds.size}
          selectableCount={selectableCardIds.length}
          isAllSelected={batch.isAllSelected}
          deleting={batch.deleting}
          busy={archiving}
          exitTitle={t('shell.agents.exitBulk')}
          onExit={batch.exitBatchMode}
          onToggleSelectAll={batch.toggleSelectAll}
          extraActions={
            <Button
              size="sm"
              pending={archiving}
              disabled={effectiveArchivableSelectedIds.length === 0 || batch.deleting}
              onClick={() => void executeBatchArchive()}
            >
              {archiving
                ? t('shell.agents.archiving')
                : t('shell.agents.archiveCount', { count: effectiveArchivableSelectedIds.length })}
            </Button>
          }
          confirmOpen={batch.confirmOpen}
          onConfirmOpenChange={batch.setConfirmOpen}
          onRequestDelete={batch.requestDeleteConfirm}
          onConfirmDelete={() => void batch.executeBatchDelete()}
        />
      )}

      {!dataReady ? (
        <LoadingState label={t('shell.overview.loading')} iconSize={12} className="sidebar-search-empty" />
      ) : !workingSet.searchActive && workingSet.totalRootCount === 0 && cardGroups.length === 0 ? (
        <EmptyState
          compact
          className="sidebar-overview-empty"
          title={t('shell.sidebar.overviewEmpty')}
          action={
            <NewTopicButton
              variant="empty"
              className="sidebar-empty-new-topic-btn"
              candidates={newTopicCandidates}
              onSelectProfile={openStandby}
            />
          }
        />
      ) : cardGroups.length === 0 ? (
        <EmptyState compact className="sidebar-search-empty" title={t('shell.overview.emptyFiltered')} />
      ) : (
          <div className="sidebar-overview-sections">
            {cardGroups.map((group) => {
              if (
                group.kind === 'profile' &&
                group.cards.length === 0 &&
                group.canCreateConversation === true &&
                group.profileId !== undefined
              ) {
                const profileId = group.profileId
                return (
                  <section
                    key={group.key}
                    className="sidebar-overview-section sidebar-overview-section-profile sidebar-overview-section-empty-profile"
                    data-group-key={group.key}
                  >
                    <div className="sidebar-overview-section-head">
                      <button
                        type="button"
                        className="sidebar-overview-section-toggle sidebar-overview-section-empty-agent"
                        title={t('shell.agents.newTopicUnder', { label: group.label })}
                        aria-label={t('shell.agents.newTopicUnder', { label: group.label })}
                        onClick={() => openStandby(profileId)}
                      >
                        <span className="sidebar-overview-section-title">{group.label}</span>
                        <span className="sidebar-section-plus-slot" aria-hidden="true">
                          <HelmxIcon name="plus" size={13} className="sidebar-overview-section-plus" />
                        </span>
                      </button>
                    </div>
                  </section>
                )
              }

              const collapsed = activeCollapsedKeys.has(group.key)
              const headingId = `${sectionIdPrefix}-${group.key}`
              const showCount = group.kind !== 'profile' || collapsed
              return (
                <section
                  key={group.key}
                  className={`sidebar-overview-section sidebar-overview-section-${group.kind}${group.bucket ? ` sidebar-overview-section-${group.bucket}` : ''}`}
                  data-group-key={group.key}
                  aria-labelledby={headingId}
                >
                  <div className="sidebar-overview-section-head">
                    <button
                      id={headingId}
                      type="button"
                      className="sidebar-overview-section-toggle"
                      aria-expanded={!collapsed}
                      onClick={() => toggleGroupCollapsed(group.key)}
                    >
                      <span
                        className={`sidebar-overview-section-title${group.kind === 'node' && group.nodeId !== 'local' ? ' mono' : ''}`}
                      >
                        {group.label}
                      </span>
                      <HelmxIcon
                        name={collapsed ? 'chevron-right' : 'chevron-down'}
                        size={12}
                        className="sidebar-overview-section-chevron"
                      />
                      {showCount && (
                        <span className="sidebar-overview-section-count tabular-nums">{group.cards.length}</span>
                      )}
                    </button>
                    {group.kind === 'profile' && group.canCreateConversation === true && group.profileId !== undefined && (
                      <Tooltip content={t('shell.agents.newTopicUnder', { label: group.label })} side="top">
                        <IconButton
                          variant="ghost"
                          size="xs"
                          className="sidebar-section-new-topic-btn"
                          icon={<HelmxIcon name="plus" size={13} />}
                          aria-label={t('shell.agents.newTopicUnder', { label: group.label })}
                          onClick={(e) => {
                            e.stopPropagation()
                            openStandby(group.profileId!)
                          }}
                        />
                      </Tooltip>
                    )}
                  </div>
                  {!collapsed && (
                    <div className="sidebar-overview-list">
                      {group.cards.map((card) => (
                        <SidebarWorkingSetTreeItem
                          key={card.root.id}
                          card={card}
                          descendantSlice={descendantSlicesByRoot.get(card.root.id) ?? EMPTY_DESCENDANT_SLICE}
                          expanded={expandedCardIds.has(card.root.id)}
                          store={store}
                          viewedConversationIds={viewedConversationIds}
                          hideProfileMeta={groupBy === 'profile'}
                          hideNodeMeta={groupBy === 'node'}
                          batchMode={batch.batchMode}
                          selectable={isConversationBulkSelectable(card.root)}
                          selected={batch.selectedIds.has(card.root.id)}
                          onOpenConversation={openConversation}
                          onDrawerPeek={openConversationDrawer}
                          onOpenSplit={openSplit}
                          onToggleExpanded={toggleCardExpanded}
                          onToggleSelect={batch.toggleSelect}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}

        {!workingSet.searchActive && workingSet.omittedQuietCount > 0 && (
          <button
            type="button"
            className="sidebar-view-all-btn"
            onClick={() => openOverview(groupBy !== 'status' ? { group: groupBy } : undefined)}
          >
            <span>{t('shell.sidebar.viewAllConversations', { count: workingSet.totalRootCount })}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}

        {!workingSet.searchActive && archivedCount > 0 && (
          <button
            type="button"
            className="sidebar-view-all-btn sidebar-view-archived-btn"
            onClick={() => openOverview({ bucket: 'archived' })}
          >
            <span>{t('shell.sidebar.viewArchivedConversations', { count: archivedCount })}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}

        {workingSet.searchActive && (hasVisibleMatchedCards || archivedCount > 0) && (
          <button
            type="button"
            className="sidebar-view-all-btn"
            onClick={() =>
              openOverview(groupBy !== 'status' ? { q: normalizedQuery, group: groupBy } : { q: normalizedQuery })
            }
          >
            <span>{t('shell.sidebar.viewMatchesInOverview')}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}
    </div>
  )
}
