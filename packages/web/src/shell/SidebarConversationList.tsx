/**
 * 侧栏对话空间主列表（导航入口 + 活跃工作集）：
 *
 * - 顶部一级导航区：「会话总览」常驻置顶行（#/overview，带同源态势计数徽标、分屏微标与悬停右分屏钮）
 *   + 「新话题」常驻主入口（单角色直进待命页，多角色下拉选角且最近活跃角色置顶）；
 * - 下方工作集（与 #/overview 共享 overview-model 的唯一树聚合、分桶与排序纯函数）：
 *   - 支持分组维度切换（按状态 / 按角色 / 按节点，localStorage 持久化）：
 *     - 按状态：活跃三桶（需处理 > 进行中 > 未读完成）全量展示（createdAt 倒序不跳行），
 *       近期安静区按 updatedAt 倒序取前 SIDEBAR_RECENT_QUIET_LIMIT 条并对在场会话保底；
 *     - 按角色：按可见智能体归组（含 0 会话可创建角色，组头带 + 开新话题），每组独立截取近期安静会话；
 *     - 按节点：按运行节点归组（活跃节点优先），每组独立截取近期安静会话；
 *   - 超限时底部呈现「查看全部 N 个会话」直达 #/overview（透传当前分组维度）；
 *   - 侧栏搜索突破近期上限检索全量未归档人类根树，底部提供带 ?sp.q 透传的「在会话总览中查看匹配」；
 * - 职责边界：侧栏专注快速切换与新开话题，不包含批量管理栏、不渲染已归档分组（均归一到 #/overview）；
 * - 移动端防误关契约：多角色下拉触发按钮不挂 .nav-item，展开子会话与行尾动作菜单均显式 stopPropagation，
 *   避免冒泡触发 App 外层 .nav-item 关闭移动端抽屉。
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
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
import {
  composeAttentionSummary,
  type GlobalAttentionIndicator,
  type GlobalAttentionTone,
} from './attention-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import {
  activeConversationIdsOf,
  buildAgentStandings,
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

/** 叶子秒表组件：将 1Hz `useSharedNowMs` 订阅收窄至单个计时文本节点，避免侧栏整树每秒重渲染。 */
function ElapsedTimer({
  since,
  prefixLabel,
  className,
  leadingSeparator = false,
  trailingSeparator = false,
}: {
  since?: number
  prefixLabel?: string
  className: string
  leadingSeparator?: boolean
  trailingSeparator?: boolean
}): ReactNode {
  const nowMs = useSharedNowMs(since !== undefined)
  if (since === undefined || nowMs === undefined) {
    if (prefixLabel !== undefined) {
      return (
        <span className={className} title={prefixLabel}>
          {prefixLabel}
        </span>
      )
    }
    return leadingSeparator && trailingSeparator ? (
      <span className="sidebar-overview-meta-sep" aria-hidden="true">
        ·
      </span>
    ) : null
  }
  const formatted = formatStopwatchMs(Math.max(0, nowMs - since))
  const text = prefixLabel !== undefined ? `${prefixLabel} ${formatted}` : formatted
  return (
    <>
      {leadingSeparator && (
        <span className="sidebar-overview-meta-sep" aria-hidden="true">
          ·
        </span>
      )}
      <span className={className} title={prefixLabel !== undefined ? text : undefined}>
        {text}
      </span>
      {trailingSeparator && (
        <span className="sidebar-overview-meta-sep" aria-hidden="true">
          ·
        </span>
      )}
    </>
  )
}

interface SidebarWorkingSetTreeItemProps {
  card: OverviewCard
  descendantSlice: SidebarOverviewDescendantsSlice
  expanded: boolean
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  hideProfileMeta?: boolean
  hideNodeMeta?: boolean
  onOpenConversation: (conversationId: number) => void
  onDrawerPeek: (conversationId: number) => void
  onOpenSplit: (conversationId: number) => void
  onToggleExpanded: (rootConversationId: number) => void
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
    onOpenConversation,
    onDrawerPeek,
    onOpenSplit,
    onToggleExpanded,
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
      if (card.summaryText !== '') {
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
                store={store}
                viewedConversationIds={viewedConversationIds}
                onOpenConversation={onOpenConversation}
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
    prev.onOpenConversation === next.onOpenConversation &&
    prev.onDrawerPeek === next.onDrawerPeek &&
    prev.onOpenSplit === next.onOpenSplit &&
    prev.onToggleExpanded === next.onToggleExpanded,
)

interface SidebarWorkingSetDescendantRowProps {
  descendant: OverviewDescendant
  store: SidebarStoreView
  viewedConversationIds: ReadonlySet<number>
  onOpenConversation: (conversationId: number) => void
}

/** 缩进单行子会话。 */
const SidebarWorkingSetDescendantRow = memo(
  function SidebarWorkingSetDescendantRow({
    descendant,
    store,
    viewedConversationIds,
    onOpenConversation,
  }: SidebarWorkingSetDescendantRowProps): ReactNode {
    const { t } = useWebLocale()
    const presence = getConversationPresence(store, descendant.conv.id)
    const chipAnchor = resolveOverviewDescendantChipAnchor(descendant)
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
          {chipAnchor !== undefined && (
            <ElapsedTimer
              since={chipAnchor.since}
              className={`sidebar-overview-desc-time mono tabular-nums${chipAnchor.kind === 'waiting' ? ' is-warn' : ''}`}
            />
          )}
          <SidebarPaneTag paneTag={presence.paneTag} />
        </span>
      </div>
    )
  },
  (prev, next) =>
    prev.descendant === next.descendant &&
    sameSidebarPresence(prev.store, next.store) &&
    prev.viewedConversationIds === next.viewedConversationIds &&
    prev.onOpenConversation === next.onOpenConversation,
)

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
  const [groupBy, setGroupBy] = useState<OverviewGroupBy>(() => loadSidebarGroupBy())
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchCollapseState, setSearchCollapseState] = useState<{ query: string; keys: Set<string> }>({
    query: '',
    keys: new Set(),
  })
  const [expandedCardIds, setExpandedCardIds] = useState<Set<number>>(new Set())
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const handleSelectGroupBy = useCallback((next: OverviewGroupBy): void => {
    setGroupBy(saveSidebarGroupBy(next))
    setGroupMenuOpen(false)
  }, [])

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
  const groupByOptions: ReadonlyArray<{ value: OverviewGroupBy; label: string; icon: string }> = [
    { value: 'status', label: t('shell.overview.groupByStatus'), icon: 'activity' },
    { value: 'profile', label: t('shell.overview.groupByProfile'), icon: 'bot' },
    { value: 'node', label: t('shell.overview.groupByNode'), icon: 'server' },
  ]
  const currentGroupLabel = groupByOptions.find((option) => option.value === groupBy)?.label ?? t('shell.overview.groupByStatus')
  const hasVisibleMatchedCards = cardGroups.some((group) => group.cards.length > 0)

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
                      className="sidebar-group-by-item"
                      data-group-by-option={option.value}
                      data-active={selected ? 'true' : undefined}
                      aria-checked={selected}
                      onSelect={() => handleSelectGroupBy(option.value)}
                    >
                      <span className="pane-more-item-label">
                        <HelmxIcon name={option.icon} size={13} />
                        {option.label}
                      </span>
                      {selected && <HelmxIcon name="check" size={12} className="sidebar-group-by-item-check" />}
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
              <button
                type="button"
                className={`sidebar-header-icon-btn${filterOpen ? ' is-active' : ''}`}
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
                <HelmxIcon name="search" size={13} />
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
        ) : !workingSet.searchActive && workingSet.totalRootCount === 0 && cardGroups.length === 0 ? (
          <div className="sidebar-overview-empty">
            <span>{t('shell.sidebar.overviewEmpty')}</span>
          </div>
        ) : cardGroups.length === 0 ? (
          <div className="sidebar-search-empty">{t('shell.overview.emptyFiltered')}</div>
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
              const sectionTitle =
                group.kind === 'bucket' && group.bucket === 'quiet' && !workingSet.searchActive
                  ? t('shell.sidebar.sectionRecent')
                  : group.label
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
                        {sectionTitle}
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
                        <button
                          type="button"
                          className="sidebar-section-new-topic-btn"
                          aria-label={t('shell.agents.newTopicUnder', { label: group.label })}
                          onClick={(e) => {
                            e.stopPropagation()
                            openStandby(group.profileId!)
                          }}
                        >
                          <HelmxIcon name="plus" size={13} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
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
                          store={store}
                          viewedConversationIds={viewedConversationIds}
                          hideProfileMeta={groupBy === 'profile'}
                          hideNodeMeta={groupBy === 'node'}
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
            onClick={() => openOverview(groupBy !== 'status' ? { group: groupBy } : undefined)}
          >
            <span>{t('shell.sidebar.viewAllConversations', { count: workingSet.totalRootCount })}</span>
            <HelmxIcon name="arrow-right" size={12} />
          </button>
        )}

        {workingSet.searchActive && hasVisibleMatchedCards && (
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
    </>
  )
}
