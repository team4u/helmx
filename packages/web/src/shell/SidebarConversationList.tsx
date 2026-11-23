/**
 * 侧栏对话空间主列表（导航入口 + 活跃工作集）：
 *
 * - 顶部一级导航区：「会话总览」常驻置顶行（#/overview，带同源态势计数徽标、分屏微标与悬停右分屏钮）
 *   + 「新话题」常驻主入口（单角色直进待命页，多角色下拉选角且最近活跃角色置顶）；
 * - 下方工作集（与 #/overview 共享 overview-model 的唯一树聚合、分桶与排序纯函数）：
 *   - 活跃三桶（需处理 > 进行中 > 未读完成）全量展示，按 root.createdAt 倒序（流式不跳行）；
 *   - 近期安静区按 updatedAt 倒序取前 SIDEBAR_RECENT_QUIET_LIMIT 条，对当前主/分屏正在查看的
 *     安静会话树保底展示；超限时底部呈现「查看全部 N 个会话」直达 #/overview；
 *   - 侧栏搜索突破近期上限检索全量未归档根树，底部提供带 ?sp.q 透传的「在会话总览中查看匹配」；
 * - 职责边界：侧栏专注快速切换与新开话题，不包含批量管理栏、不渲染已归档分组（均归一到 #/overview）；
 * - 移动端防误关契约：多角色下拉触发按钮不挂 .nav-item，展开子会话与行尾动作菜单均显式 stopPropagation，
 *   避免冒泡触发 App 外层 .nav-item 关闭移动端抽屉。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
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
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import {
  buildNewTopicCandidates,
  buildOverviewCards,
  buildSidebarWorkingSet,
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
import {
  composeAttentionSummary,
  type GlobalAttentionIndicator,
  type GlobalAttentionTone,
} from './attention-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import {
  activeConversationIdsOf,
  getConversationPresence,
  openAgentStandby,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  sidebarBadgeCountLabel,
  type AgentStanding,
  type SidebarStoreView,
} from './sidebar-model.js'
import { ConversationStatusDot, HoverIconButton, RemoteNodeTag, SidebarPaneTag } from './SidebarPrimitives.js'

export interface SidebarConversationListProps {
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  attentionIndicator: GlobalAttentionIndicator
  viewedConversationIds: ReadonlySet<number>
  onNavigate?: () => void
}

const EMPTY_COLLAPSED_KEYS: ReadonlySet<string> = new Set()

function attentionToneBadgeClass(tone: Exclude<GlobalAttentionTone, null>): string {
  switch (tone) {
    case 'error':
      return 'badge-err'
    case 'blocked':
      return 'badge-warn'
    case 'running':
      return 'badge-accent'
    case 'done':
      return 'badge-ok'
  }
}

/** 顶部常驻「新话题」入口：单候选直进待命页，多候选下拉选角（不挂 .nav-item 防移动端打开菜单时误关抽屉）。 */
function SidebarNewTopicRow({
  candidates,
  store,
  onSelectProfile,
}: {
  candidates: ReadonlyArray<AgentStanding>
  store: SidebarStoreView
  onSelectProfile: (profileId: string) => void
}): ReactNode {
  const { t } = useWebLocale()
  if (candidates.length === 0) return null

  const standbyPresence = resolveSidebarTargetPresence(store, (target) => target.kind === 'agent')
  const stateClass = standbyPresence.active
    ? ' is-active'
    : standbyPresence.splitSecondary
      ? ' is-split'
      : ''

  const singleCandidate = candidates.length === 1 ? (candidates[0] ?? null) : null
  if (singleCandidate !== null) {
    const label = t('shell.agents.newTopicUnder', { label: singleCandidate.label })
    return (
      <button
        type="button"
        className={`sidebar-action-row sidebar-new-topic-btn${stateClass}${standbyPresence.focused ? ' nav-item-focused' : ''}`}
        title={label}
        aria-label={t('conv.pane.newTopic')}
        aria-current={standbyPresence.active ? 'page' : undefined}
        onClick={() => onSelectProfile(singleCandidate.profileId)}
      >
        <span className="nav-item-main">
          <HelmxIcon name="plus" size={14} />
          <span className="nav-item-label">{t('conv.pane.newTopic')}</span>
        </span>
        {standbyPresence.paneTag !== null && (
          <span className="nav-item-meta">
            <SidebarPaneTag paneTag={standbyPresence.paneTag} />
          </span>
        )}
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`sidebar-action-row sidebar-new-topic-btn${stateClass}${standbyPresence.focused ? ' nav-item-focused' : ''}`}
          title={t('conv.pane.newTopic')}
          aria-label={t('conv.pane.newTopic')}
          aria-haspopup="menu"
          aria-current={standbyPresence.active ? 'page' : undefined}
        >
          <span className="nav-item-main">
            <HelmxIcon name="plus" size={14} />
            <span className="nav-item-label">{t('conv.pane.newTopic')}</span>
          </span>
          <span className="nav-item-meta">
            <SidebarPaneTag paneTag={standbyPresence.paneTag} />
            <HelmxIcon name="chevron-down" size={12} className="sidebar-new-topic-chevron" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent className="pane-more-popover" align="start" sideOffset={4}>
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

/** 侧栏工作集单棵树：紧凑双行主项 + 按需展开的缩进子会话行。 */
function SidebarWorkingSetTreeItem({
  card,
  descendantSlice,
  expanded,
  nowMs,
  store,
  viewedConversationIds,
  onOpenConversation,
  onDrawerPeek,
  onOpenSplit,
  onToggleExpanded,
}: {
  card: OverviewCard
  descendantSlice: SidebarOverviewDescendantsSlice
  expanded: boolean
  nowMs?: number
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
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
        className={`nav-item sidebar-overview-item sidebar-overview-item-${card.bucket}${presenceNavClassSuffix(rootPresence)}${isBranchActive ? ' sidebar-overview-item-branch' : ''}`}
        onClick={(e) => {
          if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
          onOpenConversation(primaryTargetId)
        }}
      >
        <div className="sidebar-overview-head">
          <button
            type="button"
            className="nav-item-main nav-open sidebar-overview-open"
            onClick={() => onOpenConversation(primaryTargetId)}
            aria-current={rootPresence.active ? 'page' : undefined}
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
              nowMs={nowMs}
              store={store}
              viewedConversationIds={viewedConversationIds}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 缩进单行子会话。 */
function SidebarWorkingSetDescendantRow({
  descendant,
  nowMs,
  store,
  viewedConversationIds,
  onOpenConversation,
}: {
  descendant: OverviewDescendant
  nowMs?: number
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  onOpenConversation: (conversationId: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const presence = getConversationPresence(store, descendant.conv.id)
  const timing = resolveOverviewDescendantChipTiming(descendant, nowMs)
  const titleText = descendant.conv.title || t('shell.conversationFallback', { id: descendant.conv.id })

  const handleActivate = (_e: MouseEvent): void => {
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
        aria-current={presence.active ? 'page' : undefined}
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

export function SidebarConversationList({
  store,
  background,
  attentionIndicator,
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

  const workingSet = useMemo(
    () =>
      buildSidebarWorkingSet({
        cards: allCards,
        activeConversationIds,
        query: search,
      }),
    [allCards, activeConversationIds, search],
  )

  const cardGroups = useMemo(
    () => groupOverviewCards(workingSet.cards, 'status', t),
    [workingSet.cards, t],
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

  const openOverview = useCallback(
    (params?: Record<string, string>) => {
      store.openTarget(params !== undefined ? { kind: 'overview', params } : { kind: 'overview' })
      onNavigate?.()
    },
    [store, onNavigate],
  )

  const overviewPresence = resolveSidebarTargetPresence(store, (target) => target.kind === 'overview')
  const attentionSummary = composeAttentionSummary(attentionIndicator, t)
  const overviewLabel =
    attentionSummary !== '' ? `${t('shell.overview.title')} · ${attentionSummary}` : t('shell.overview.title')

  return (
    <>
      <div className="sidebar-group sidebar-conv-primary-nav">
        <div
          className={`nav-item sidebar-overview-entry${presenceNavClassSuffix(overviewPresence)}`}
          onClick={(e) => {
            if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
            openOverview()
          }}
        >
          <button
            type="button"
            className="nav-item-main nav-open"
            title={overviewLabel}
            aria-label={overviewLabel}
            aria-current={overviewPresence.active ? 'page' : undefined}
            onClick={() => openOverview()}
          >
            <HelmxIcon name="activity" size={14} />
            <span className="nav-item-label">{t('shell.overview.title')}</span>
          </button>
          <span className="nav-item-meta">
            <SidebarPaneTag paneTag={overviewPresence.paneTag} />
            {attentionIndicator.totalCount > 0 && attentionIndicator.tone !== null && (
              <span
                className={`badge ${attentionToneBadgeClass(attentionIndicator.tone)} tabular-nums sidebar-view-badge sidebar-overview-entry-badge`}
                data-tone={attentionIndicator.tone}
              >
                {sidebarBadgeCountLabel(attentionIndicator.totalCount)}
              </span>
            )}
            <span className="sidebar-split-action">
              <HoverIconButton
                className="split-toggle-btn sidebar-split-btn"
                title={t('shell.sidebar.openInRightSplit')}
                icon="columns"
                onClick={(e) => {
                  e.stopPropagation()
                  store.openTarget({ kind: 'overview' }, { split: true })
                  onNavigate?.()
                }}
              />
            </span>
          </span>
        </div>

        <SidebarNewTopicRow
          candidates={newTopicCandidates}
          store={store}
          onSelectProfile={openStandby}
        />
      </div>

      <div className="sidebar-group sidebar-overview-group">
        <div className="sidebar-group-header">
          <span>{t('shell.sidebar.workingSetTitle')}</span>
          <div className="sidebar-group-header-actions">
            <Tooltip
              content={filterOpen ? t('shell.agents.collapseFilters') : t('shell.sidebar.overviewFilter')}
              side="top"
            >
              <button
                type="button"
                className="btn btn-ghost btn-icon-xs"
                style={{ color: filterOpen ? 'var(--accent)' : undefined }}
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

        {!dataReady ? (
          <div className="sidebar-search-empty" role="status">
            {t('shell.overview.loading')}
          </div>
        ) : workingSet.totalRootCount === 0 ? (
          <div className="sidebar-overview-empty">
            <span>{t('shell.sidebar.overviewEmpty')}</span>
          </div>
        ) : cardGroups.length === 0 ? (
          <div className="sidebar-search-empty">{t('shell.overview.emptyFiltered')}</div>
        ) : (
          <div className="sidebar-overview-sections">
            {cardGroups.map((group) => {
              const collapsed = activeCollapsedKeys.has(group.key)
              const headingId = `${sectionIdPrefix}-${group.key}`
              const sectionTitle =
                group.bucket === 'quiet' && !workingSet.searchActive
                  ? t('shell.sidebar.sectionRecent')
                  : group.label
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
                    <span className="sidebar-overview-section-title">{sectionTitle}</span>
                    <span className="sidebar-overview-section-count tabular-nums">{group.cards.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="sidebar-overview-list">
                      {group.cards.map((card) => (
                        <SidebarWorkingSetTreeItem
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
                          onOpenConversation={openConversation}
                          onDrawerPeek={openConversationDrawer}
                          onOpenSplit={openSplit}
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

        {!workingSet.searchActive && workingSet.omittedQuietCount > 0 && (
          <button
            type="button"
            className="sidebar-view-all-btn"
            onClick={() => openOverview()}
          >
            <span>{t('shell.sidebar.viewAllConversations', { count: workingSet.totalRootCount })}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}

        {workingSet.searchActive && workingSet.cards.length > 0 && (
          <button
            type="button"
            className="sidebar-view-all-btn"
            onClick={() => openOverview({ q: normalizedQuery })}
          >
            <span>{t('shell.sidebar.viewMatchesInOverview')}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}
      </div>
    </>
  )
}
