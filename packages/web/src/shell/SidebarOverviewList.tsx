/**
 * 侧栏「会话总览」精简列表（对话空间展示模式之一，与 AgentStandingsGroup 互斥切换）：
 *
 * - 与全屏 `#/overview` 共享同一套树聚合、筛选、分桶与排序纯函数（overview-model），
 *   一棵根会话树占一条紧凑双行项，按「需处理 > 进行中 > 未读完成 > 近期安静」可折叠分节，
 *   组内按 root.createdAt 倒序（流式输出不跳行）；
 * - 窄栏信息裁剪：操作区与分屏微标锚定在第一行右端不跨行遮挡；第二行仅呈现有行动价值的
 *   实时秒表与精简事实（省略已完成/安静会话的静态累计耗时，不挂载插件元信息插槽）；
 * - 后代子行按需浮现：活跃/待处理、当前在场或搜索命中的子会话自动展开为缩进子行，
 *   安静历史子会话收拢在第二行尾部紧凑分支开关后；审批子会话已展开时父行开根、子行开子，
 *   消除跳转高亮脱节与回不去根会话的死胡同；
 * - 移动端防误关契约：展开子会话、批量勾选与行尾动作菜单均显式 stopPropagation，
 *   避免冒泡触发 App 外层 `.nav-item` 关闭移动端抽屉。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  HelmxIcon,
  SearchBox,
  Tooltip,
  useSharedNowMs,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatStopwatchMs } from '../lib/format.js'
import { useAuthConnection, useProfilesSlice, useStoreActions } from '../lib/store-context.js'
import { BatchActionBar } from '../ui/BatchActionBar.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import {
  buildNewTopicCandidates,
  buildOverviewCards,
  filterOverviewCards,
  groupOverviewCards,
  resolveOverviewCardTiming,
  resolveOverviewDescendantChipTiming,
  resolveSidebarOverviewDescendants,
  resolveSidebarOverviewPrimaryTarget,
  sidebarOverviewCardsNeedLiveClock,
  type OverviewCard,
  type OverviewDescendant,
  type SidebarOverviewDescendantsSlice,
} from '../overview/overview-model.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import {
  activeConversationIdsOf,
  getConversationPresence,
  isConversationArchivable,
  isConversationBulkSelectable,
  openAgentStandby,
  presenceNavClassSuffix,
  shouldSkipNavRowClick,
  type AgentStanding,
  type SidebarStoreView,
} from './sidebar-model.js'
import { ConversationStatusDot, RemoteNodeTag, SidebarPaneTag } from './SidebarPrimitives.js'
import { useBatchConversationDelete } from './use-batch-conversation-delete.js'

export interface SidebarOverviewListProps {
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  viewedConversationIds: ReadonlySet<number>
  headerLeading?: ReactNode
  onNavigate?: () => void
}

const EMPTY_COLLAPSED_KEYS: ReadonlySet<string> = new Set()

/** 新话题入口（头栏图标钮或空态按钮）：单候选直进待命页，多候选下拉选角。 */
function OverviewNewTopicControl({
  candidates,
  variant,
  onSelectProfile,
}: {
  candidates: ReadonlyArray<AgentStanding>
  variant: 'icon' | 'button'
  onSelectProfile: (profileId: string) => void
}): ReactNode {
  const { t } = useWebLocale()
  if (candidates.length === 0) return null

  const singleCandidate = candidates.length === 1 ? (candidates[0] ?? null) : null
  if (singleCandidate !== null) {
    const label = t('shell.agents.newTopicUnder', { label: singleCandidate.label })
    if (variant === 'icon') {
      return (
        <Tooltip content={label} side="top">
          <button
            type="button"
            className="btn btn-ghost btn-icon-xs"
            title={label}
            aria-label={label}
            onClick={() => onSelectProfile(singleCandidate.profileId)}
          >
            <HelmxIcon name="plus" size={12} />
          </button>
        </Tooltip>
      )
    }
    return (
      <button
        type="button"
        className="btn btn-sm sidebar-overview-empty-action"
        title={label}
        onClick={() => onSelectProfile(singleCandidate.profileId)}
      >
        <HelmxIcon name="plus" size={12} />
        <span>{t('conv.pane.newTopic')}</span>
      </button>
    )
  }

  const triggerLabel = t('conv.pane.newTopicTitle')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'icon' ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon-xs"
            title={triggerLabel}
            aria-label={t('conv.pane.newTopic')}
            aria-haspopup="menu"
          >
            <HelmxIcon name="plus" size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm sidebar-overview-empty-action"
            title={triggerLabel}
            aria-label={t('conv.pane.newTopic')}
            aria-haspopup="menu"
          >
            <HelmxIcon name="plus" size={12} />
            <span>{t('conv.pane.newTopic')}</span>
            <HelmxIcon name="chevron-down" size={11} />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent className="pane-more-popover" align="end" sideOffset={4}>
          {candidates.map((standing) => {
            const nodeId = standing.primaryConversation?.nodeId
            const remoteNodeId = nodeId !== undefined && nodeId !== '' && nodeId !== 'local' ? nodeId : null
            return (
              <DropdownMenuItem
                key={standing.profileId}
                title={t('shell.agents.newTopicUnder', { label: standing.label })}
                onSelect={() => onSelectProfile(standing.profileId)}
              >
                <span className="pane-more-item-label">
                  <HelmxIcon name="bot" size={13} />
                  {standing.label}
                  {remoteNodeId !== null && <RemoteNodeTag nodeId={remoteNodeId} />}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}

/** 侧栏总览单棵树：紧凑双行主项 + 按需展开的缩进子会话行。 */
function SidebarOverviewTreeItem({
  card,
  descendantSlice,
  expanded,
  nowMs,
  store,
  viewedConversationIds,
  batchMode,
  selectable,
  selected,
  onOpenConversation,
  onDrawerPeek,
  onOpenSplit,
  onToggleSelect,
  onToggleExpanded,
}: {
  card: OverviewCard
  descendantSlice: SidebarOverviewDescendantsSlice
  expanded: boolean
  nowMs?: number
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  batchMode: boolean
  selectable: boolean
  selected: boolean
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
  onToggleSelect: (rootConversationId: number) => void
  onToggleExpanded: (rootConversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const rootPresence = getConversationPresence(store, card.root.id)
  const hasActiveDescendant = card.descendants.some((descendant) => {
    const p = getConversationPresence(store, descendant.conv.id)
    return p.inPrimary || p.inSplit
  })
  const isBranchActive = !rootPresence.active && !rootPresence.splitSecondary && hasActiveDescendant
  const cardTiming = resolveOverviewCardTiming(card, nowMs)
  const remoteNodeId = card.root.nodeId !== undefined && card.root.nodeId !== 'local' ? card.root.nodeId : null
  const titleText = card.root.title || t('shell.conversationFallback', { id: card.root.id })
  const errorText = card.representative.status === 'error' ? card.representative.lastError?.trim() : undefined
  const primaryTargetId = resolveSidebarOverviewPrimaryTarget(card, descendantSlice.visible)

  const handlePrimaryActivate = (e: MouseEvent): void => {
    if (batchMode) {
      e.stopPropagation()
      if (selectable) onToggleSelect(card.root.id)
      return
    }
    onOpenConversation(primaryTargetId)
  }

  // 第二行元信息（严格按状态与 199px 可用宽度裁剪，不渲染静态累计耗时）：
  const metaParts: ReactNode[] = []
  if (card.profileLabel !== '') {
    metaParts.push(
      <span key="profile" className="sidebar-overview-meta-profile" title={card.profileLabel}>
        {card.profileLabel}
      </span>,
    )
  }

  if (card.bucket === 'needs_attention') {
    if (card.hasWaiting) {
      const waitText =
        cardTiming.waitingMs !== undefined
          ? `${t('shell.overview.waitingForYou')} ${formatStopwatchMs(cardTiming.waitingMs)}`
          : t('shell.overview.waitingForYou')
      metaParts.push(
        <span key="attention" className="sidebar-overview-meta-warn tabular-nums" title={waitText}>
          {waitText}
        </span>,
      )
    } else if (card.hasError) {
      const errLabel = errorText ? `${t('shell.overview.hasError')} · ${errorText}` : t('shell.overview.hasError')
      metaParts.push(
        <span key="attention" className="sidebar-overview-meta-err" title={errLabel}>
          {errLabel}
        </span>,
      )
    }
  } else if (card.bucket === 'running') {
    if (remoteNodeId !== null) {
      metaParts.push(
        <span key="node" className="sidebar-overview-meta-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
          @{remoteNodeId}
        </span>,
      )
    }
    if (cardTiming.runningMs !== undefined) {
      metaParts.push(
        <span key="running" className="sidebar-overview-meta-time mono tabular-nums">
          {formatStopwatchMs(cardTiming.runningMs)}
        </span>,
      )
    }
    if (card.summaryText !== '') {
      metaParts.push(
        <span key="summary" className="sidebar-overview-meta-summary" title={card.summaryText}>
          {card.summaryText}
        </span>,
      )
    }
  } else if (remoteNodeId !== null) {
    metaParts.push(
      <span key="node" className="sidebar-overview-meta-node mono" title={t('shell.node.title', { id: remoteNodeId })}>
        @{remoteNodeId}
      </span>,
    )
  }

  const showDescendantToggle = descendantSlice.hasCollapsibleQuiet
  const descToggleLabel =
    descendantSlice.hiddenCount > 0
      ? t('shell.sidebar.overviewExpandSub', { count: descendantSlice.hiddenCount })
      : t('shell.sidebar.overviewCollapseSub')
  const descBadgeText =
    descendantSlice.hiddenCount > 0
      ? descendantSlice.visible.length > 0
        ? `+${descendantSlice.hiddenCount}`
        : String(card.descendants.length)
      : String(card.descendants.length)

  return (
    <div className="sidebar-overview-tree">
      <div
        className={`nav-item sidebar-overview-item sidebar-overview-item-${card.bucket}${presenceNavClassSuffix(rootPresence)}${isBranchActive ? ' sidebar-overview-item-branch' : ''}${batchMode && selected ? ' is-selected' : ''}`}
        onClick={(e) => {
          if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
          handlePrimaryActivate(e)
        }}
      >
        <div className="sidebar-overview-head">
          {batchMode && (
            <span onClick={(e) => e.stopPropagation()}>
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
            onClick={handlePrimaryActivate}
            disabled={batchMode && !selectable}
            aria-current={!batchMode && rootPresence.active ? 'page' : undefined}
            aria-pressed={batchMode ? selected : undefined}
            title={titleText}
          >
            <span className="nav-status-slot">
              <ConversationStatusDot
                conv={card.root}
                background={{ active: card.backgroundActive, summary: card.backgroundSummary }}
                showDone={card.root.unread && !viewedConversationIds.has(card.root.id)}
              />
            </span>
            <span className="nav-item-label">{titleText}</span>
          </button>
          <span className="nav-item-meta sidebar-overview-head-meta">
            <SidebarPaneTag paneTag={rootPresence.paneTag} />
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
        </div>

        {(metaParts.length > 0 || showDescendantToggle) && (
          <div className="sidebar-overview-meta">
            <div className="sidebar-overview-meta-text">
              {metaParts.flatMap((part, index) =>
                index === 0
                  ? [part]
                  : [
                      <span key={`sep-${index}`} className="sidebar-overview-meta-sep" aria-hidden="true">
                        ·
                      </span>,
                      part,
                    ],
              )}
            </div>
            {showDescendantToggle && (
              <Tooltip content={descToggleLabel} side="top">
                <button
                  type="button"
                  className={`sidebar-overview-desc-toggle tabular-nums${expanded ? ' is-expanded' : ''}`}
                  aria-expanded={expanded}
                  aria-label={descToggleLabel}
                  title={descToggleLabel}
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
            <SidebarOverviewDescendantRow
              key={descendant.conv.id}
              descendant={descendant}
              nowMs={nowMs}
              store={store}
              viewedConversationIds={viewedConversationIds}
              batchMode={batchMode}
              selectable={selectable}
              onOpenConversation={onOpenConversation}
              onToggleTreeSelect={() => onToggleSelect(card.root.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 缩进单行子会话（与侧栏二级会话行风格一致）。 */
function SidebarOverviewDescendantRow({
  descendant,
  nowMs,
  store,
  viewedConversationIds,
  batchMode,
  selectable,
  onOpenConversation,
  onToggleTreeSelect,
}: {
  descendant: OverviewDescendant
  nowMs?: number
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  batchMode: boolean
  selectable: boolean
  onOpenConversation: (conversationId: number) => void
  onToggleTreeSelect: () => void
}): ReactNode {
  const { t } = useWebLocale()
  const presence = getConversationPresence(store, descendant.conv.id)
  const timing = resolveOverviewDescendantChipTiming(descendant, nowMs)
  const titleText = descendant.conv.title || t('shell.conversationFallback', { id: descendant.conv.id })

  const handleActivate = (e: MouseEvent): void => {
    if (batchMode) {
      e.stopPropagation()
      if (selectable) onToggleTreeSelect()
      return
    }
    onOpenConversation(descendant.conv.id)
  }

  return (
    <div
      className={`nav-item nav-item-sub sidebar-overview-descendant${presenceNavClassSuffix(presence)}`}
      onClick={(e) => {
        if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
        handleActivate(e)
      }}
    >
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={handleActivate}
        aria-current={!batchMode && presence.active ? 'page' : undefined}
        title={titleText}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot
            conv={descendant.conv}
            background={descendant.backgroundActive ? { active: true, summary: '' } : undefined}
            showDone={descendant.conv.unread && !viewedConversationIds.has(descendant.conv.id)}
          />
        </span>
        <span className="nav-item-label">{titleText}</span>
      </button>
      <span className="nav-item-meta">
        {timing !== undefined && (
          <span
            className={`sidebar-overview-desc-time mono tabular-nums${timing.kind === 'waiting' ? ' is-warn' : ''}`}
          >
            {formatStopwatchMs(timing.elapsedMs)}
          </span>
        )}
        <SidebarPaneTag paneTag={presence.paneTag} />
      </span>
    </div>
  )
}

export function SidebarOverviewList({
  store,
  background,
  viewedConversationIds,
  headerLeading,
  onNavigate,
}: SidebarOverviewListProps): ReactNode {
  const { t } = useWebLocale()
  const { sseConnected } = useAuthConnection()
  const { assetsLoaded } = useProfilesSlice()
  const { openConversationDrawer } = useStoreActions()
  const sectionIdPrefix = useId()

  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchCollapseState, setSearchCollapseState] = useState<{ query: string; keys: Set<string> }>({
    query: '',
    keys: new Set(),
  })
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(new Set())
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const filterOpen = searchOpen || search !== ''
  const normalizedQuery = search.trim()
  const searchActive = normalizedQuery !== ''

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const activeConversationIds = useMemo(
    () => activeConversationIdsOf(store),
    [store.primaryTarget, store.splitTarget],
  )

  const cards = useMemo(
    () =>
      buildOverviewCards({
        conversations: store.conversations,
        background,
        profiles: store.profiles,
        plugins: store.plugins,
        t,
      }),
    [store.conversations, background, store.profiles, store.plugins, t],
  )

  const visibleCards = useMemo(
    () =>
      filterOverviewCards(cards, {
        bucket: 'all',
        profileId: '',
        nodeId: '',
        query: search,
      }),
    [cards, search],
  )

  const cardGroups = useMemo(
    () => groupOverviewCards(visibleCards, 'status', t),
    [visibleCards, t],
  )

  const activeCollapsedKeys = useMemo<ReadonlySet<string>>(() => {
    if (searchActive) {
      return searchCollapseState.query === normalizedQuery ? searchCollapseState.keys : EMPTY_COLLAPSED_KEYS
    }
    return collapsedGroups
  }, [searchActive, searchCollapseState, normalizedQuery, collapsedGroups])

  const toggleGroupCollapsed = (groupKey: string): void => {
    if (searchActive) {
      setSearchCollapseState((prev) => {
        const nextKeys = prev.query === normalizedQuery ? new Set(prev.keys) : new Set<string>()
        if (nextKeys.has(groupKey)) nextKeys.delete(groupKey)
        else nextKeys.add(groupKey)
        return { query: normalizedQuery, keys: nextKeys }
      })
      return
    }
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

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

  const needsLiveClock = useMemo(() => {
    const visibleByRoot = new Map<number, ReadonlyArray<OverviewDescendant>>()
    for (const [rootId, slice] of descendantSlicesByRoot) {
      visibleByRoot.set(rootId, slice.visible)
    }
    return sidebarOverviewCardsNeedLiveClock(renderedCards, visibleByRoot)
  }, [renderedCards, descendantSlicesByRoot])

  const nowMs = useSharedNowMs(needsLiveClock)
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
    (profileId: string) => openAgentStandby(store, profileId, onNavigate),
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

  const selectableCardIds = useMemo(
    () => renderedCards.filter((card) => isConversationBulkSelectable(card.root)).map((card) => card.root.id),
    [renderedCards],
  )

  const batch = useBatchConversationDelete({
    selectableIds: selectableCardIds,
    pushNotice: store.pushNotice,
    t,
    busy: archiving,
  })

  const archivableSelectedIds = useMemo(
    () =>
      renderedCards
        .filter((card) => batch.selectedIds.has(card.root.id) && isConversationArchivable(card.root))
        .map((card) => card.root.id),
    [renderedCards, batch.selectedIds],
  )

  const executeBatchArchive = async (): Promise<void> => {
    if (batch.selectedIds.size === 0 || archiving || batch.deleting) return
    setArchiving(true)
    try {
      const convs = renderedCards
        .filter((card) => batch.selectedIds.has(card.root.id) && isConversationArchivable(card.root))
        .map((card) => card.root)
      const outcome = await patchConversationsArchived(convs, true)
      store.pushNotice(archiveBatchNotice(true, outcome, t))
      batch.exitBatchMode()
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="sidebar-group sidebar-overview-group">
      <div className="sidebar-group-header">
        {headerLeading ?? <span>{t('shell.overview.title')}</span>}
        <div className="sidebar-group-header-actions">
          <OverviewNewTopicControl
            candidates={newTopicCandidates}
            variant="icon"
            onSelectProfile={openStandby}
          />
          <Tooltip
            content={filterOpen ? t('shell.agents.collapseFilters') : t('shell.sidebar.overviewFilter')}
            side="top"
          >
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{ color: filterOpen ? 'var(--accent)' : undefined }}
              title={filterOpen ? t('shell.agents.collapseFilters') : t('shell.sidebar.overviewFilter')}
              aria-label={t('shell.sidebar.overviewFilter')}
              aria-pressed={filterOpen}
              onClick={() => {
                if (filterOpen) {
                  setSearch('')
                  setSearchOpen(false)
                } else {
                  setSearchOpen(true)
                }
              }}
            >
              <HelmxIcon name="list-filter" size={12} />
            </button>
          </Tooltip>
          <Tooltip content={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{ color: batch.batchMode ? 'var(--accent)' : undefined }}
              title={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
              aria-label={batch.batchMode ? t('shell.agents.exitBulk') : t('shell.agents.manageBulk')}
              onClick={batch.toggleBatchMode}
            >
              <HelmxIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        </div>
      </div>

      {filterOpen && (
        <SearchBox
          className="sidebar-search"
          inputClassName="sidebar-search-input"
          clearButtonClassName="btn btn-ghost btn-icon-xs sidebar-search-clear"
          icon={<HelmxIcon name="search" size={12} />}
          clearIcon={<HelmxIcon name="x" size={11} />}
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
            <button
              type="button"
              className="btn btn-sm"
              disabled={archivableSelectedIds.length === 0 || batch.deleting || archiving}
              onClick={() => void executeBatchArchive()}
            >
              {archiving
                ? t('shell.agents.archiving')
                : t('shell.agents.archiveCount', { count: archivableSelectedIds.length })}
            </button>
          }
          confirmOpen={batch.confirmOpen}
          onConfirmOpenChange={batch.setConfirmOpen}
          onRequestDelete={batch.requestDeleteConfirm}
          onConfirmDelete={() => void batch.executeBatchDelete()}
        />
      )}

      {!dataReady ? (
        <div className="sidebar-search-empty" role="status">
          {t('shell.overview.loading')}
        </div>
      ) : cards.length === 0 ? (
        <div className="sidebar-overview-empty">
          <span>{t('shell.sidebar.overviewEmpty')}</span>
          <OverviewNewTopicControl
            candidates={newTopicCandidates}
            variant="button"
            onSelectProfile={openStandby}
          />
        </div>
      ) : cardGroups.length === 0 ? (
        <div className="sidebar-search-empty">{t('shell.overview.emptyFiltered')}</div>
      ) : (
        <div className="sidebar-overview-sections">
          {cardGroups.map((group) => {
            const collapsed = activeCollapsedKeys.has(group.key)
            const headingId = `${sectionIdPrefix}-${group.key}`
            return (
              <section
                key={group.key}
                className={`sidebar-overview-section${group.bucket ? ` sidebar-overview-section-${group.bucket}` : ''}`}
                aria-labelledby={headingId}
              >
                <button
                  id={headingId}
                  type="button"
                  className="sidebar-overview-section-toggle"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroupCollapsed(group.key)}
                >
                  <HelmxIcon
                    name={collapsed ? 'chevron-right' : 'chevron-down'}
                    size={11}
                    className="sidebar-overview-section-chevron"
                  />
                  {group.bucket !== undefined && (
                    <span
                      className={`overview-section-dot overview-section-dot-${group.bucket}`}
                      aria-hidden="true"
                    />
                  )}
                  <span className="sidebar-overview-section-title">{group.label}</span>
                  <span className="sidebar-overview-section-count tabular-nums">{group.cards.length}</span>
                </button>
                {!collapsed && (
                  <div className="sidebar-overview-list">
                    {group.cards.map((card) => (
                      <SidebarOverviewTreeItem
                        key={card.root.id}
                        card={card}
                        descendantSlice={
                          descendantSlicesByRoot.get(card.root.id) ?? {
                            visible: [],
                            hiddenCount: 0,
                            hasCollapsibleQuiet: false,
                          }
                        }
                        expanded={expandedCardIds.has(card.root.id)}
                        nowMs={nowMs}
                        store={store}
                        viewedConversationIds={viewedConversationIds}
                        batchMode={batch.batchMode}
                        selectable={isConversationBulkSelectable(card.root)}
                        selected={batch.selectedIds.has(card.root.id)}
                        onOpenConversation={openConversation}
                        onDrawerPeek={openConversationDrawer}
                        onOpenSplit={openSplit}
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
      )}
    </div>
  )
}
