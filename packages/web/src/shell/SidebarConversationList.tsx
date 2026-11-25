/**
 * 侧栏对话空间工作集列表（分组栏动作 + 活跃与近期根会话树）：
 *
 * - 入口收敛：「会话总览」位于侧栏顶栏（#/overview，带同源态势计数角标）；
 *   「新建话题」合并至工作集分组栏右侧操作区（单角色直进待命页，多角色下拉选角且最近活跃角色置顶）；
 * - 下方工作集（与 #/overview 共享 overview-model 的唯一树聚合、分桶与排序纯函数）：
 *   - 支持分组维度切换（按状态 / 按角色 / 按节点，localStorage 持久化）：
 *     - 按状态：活跃三桶（需处理 > 进行中 > 未读完成）全量展示（createdAt 倒序不跳行），
 *       近期安静区按 updatedAt 倒序取前 SIDEBAR_RECENT_QUIET_LIMIT 条并对在场会话保底；
 *     - 按角色：按可见智能体归组（含 0 会话可创建角色，组头带 + 开新话题），每组独立截取近期安静会话；
 *     - 按节点：按运行节点归组（活跃节点优先），每组独立截取近期安静会话；
 *   - 0 会话空态额外提供显式「+ 新话题」引导按钮；
 *   - 超限时底部呈现「查看全部 N 个会话」直达 #/overview（透传当前分组维度）；
 *   - 侧栏搜索突破近期上限检索全量未归档人类根树，底部提供带 ?sp.q 透传的「在会话总览中查看匹配」；
 * - 职责边界：侧栏专注快速切换、新开话题与当前工作集的批量选择/全选/归档/删除
 *   （已归档治理仍归一到 #/overview）；
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
  HelmxIcon,
  IconButton,
  SearchBox,
  Stack,
  Tooltip,
  useSharedNowMs,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { openStandbyWithFocus } from '../conversation/standby-focus.js'
import { formatStopwatchMs } from '../lib/format.js'
import { useAuthConnection, useProfilesSlice, useStoreActions } from '../lib/store-context.js'
import { BatchActionBar } from '../ui/BatchActionBar.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import { useBatchConversationDelete } from './use-batch-conversation-delete.js'
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
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { formatModShiftShortcut } from './shortcuts-model.js'
import {
  activeConversationIdsOf,
  buildAgentStandings,
  getConversationPresence,
  isConversationArchivable,
  isConversationBulkSelectable,
  openAgentStandby,
  presenceNavClassSuffix,
  resolveSidebarTargetPresence,
  shouldSkipNavRowClick,
  type AgentStanding,
  type SidebarStoreView,
} from './sidebar-model.js'
import { ConversationStatusDot, RemoteNodeTag, SidebarPaneTag } from './SidebarPrimitives.js'

export interface SidebarConversationListProps {
  store: SidebarStoreView
  background: ConversationBackgroundIndex
  viewedConversationIds: ReadonlySet<number>
  onNavigate?: () => void
}

const EMPTY_COLLAPSED_KEYS: ReadonlySet<string> = new Set()

function renderNewTopicMenuItems(
  candidates: ReadonlyArray<AgentStanding>,
  formatNewTopicUnder: (label: string) => string,
  onSelectProfile: (profileId: string) => void,
): ReactNode {
  return candidates.map((standing) => {
    const nodeId = standing.primaryConversation?.nodeId
    const remoteNodeId = nodeId !== undefined && nodeId !== '' && nodeId !== 'local' ? nodeId : null
    return (
      <DropdownMenuItem
        key={standing.profileId}
        title={formatNewTopicUnder(standing.label)}
        onSelect={() => onSelectProfile(standing.profileId)}
      >
        <span className="pane-more-item-label">
          <HelmxIcon name="bot" size={13} />
          {standing.label}
          {remoteNodeId !== null && <RemoteNodeTag nodeId={remoteNodeId} />}
        </span>
      </DropdownMenuItem>
    )
  })
}

/** 工作集分组栏右侧紧凑「新话题」图标按钮：单候选直进待命页，多候选下拉选角（不挂 .nav-item 防移动端误关抽屉）。 */
function SidebarNewTopicButton({
  candidates,
  store,
  onSelectProfile,
}: {
  candidates: ReadonlyArray<AgentStanding>
  store: SidebarStoreView
  onSelectProfile: (profileId: string, opts?: { flush?: boolean }) => void
}): ReactNode {
  const { t } = useWebLocale()
  const pickedRef = useRef(false)
  if (candidates.length === 0) return null

  const standbyPresence = resolveSidebarTargetPresence(store, (target) => target.kind === 'agent')
  const stateClass = standbyPresence.active
    ? ' is-active'
    : standbyPresence.splitSecondary
      ? ' is-split'
      : ''
  const buttonClassName = `sidebar-header-icon-btn sidebar-new-topic-btn${stateClass}${standbyPresence.focused ? ' nav-item-focused' : ''}`

  const newTopicShortcut = formatModShiftShortcut('O')
  const singleCandidate = candidates.length === 1 ? (candidates[0] ?? null) : null
  if (singleCandidate !== null) {
    const label = t('shell.agents.newTopicUnderWithShortcut', { label: singleCandidate.label, shortcut: newTopicShortcut })
    return (
      <Tooltip content={label} side="top">
        <IconButton
          variant="ghost"
          size="xs"
          className={buttonClassName}
          icon={<HelmxIcon name="plus" size={13} />}
          aria-label={t('conv.pane.newTopic')}
          aria-current={standbyPresence.active ? 'page' : undefined}
          onClick={() => onSelectProfile(singleCandidate.profileId)}
        />
      </Tooltip>
    )
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) pickedRef.current = false
      }}
    >
      <Tooltip content={t('conv.pane.newTopicWithShortcut', { shortcut: newTopicShortcut })} side="top">
        <DropdownMenuTrigger asChild>
          <IconButton
            variant="ghost"
            size="xs"
            className={buttonClassName}
            icon={<HelmxIcon name="plus" size={13} />}
            aria-label={t('conv.pane.newTopic')}
            aria-haspopup="menu"
            aria-current={standbyPresence.active ? 'page' : undefined}
          />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="pane-more-popover"
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(e) => {
            if (pickedRef.current) {
              pickedRef.current = false
              e.preventDefault()
            }
          }}
        >
          {renderNewTopicMenuItems(
            candidates,
            (label) => t('shell.agents.newTopicUnder', { label }),
            (profileId) => {
              pickedRef.current = true
              onSelectProfile(profileId, { flush: false })
            },
          )}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}

/** 0 会话空态显式「+ 新话题」引导按钮（独立类名，避免与工具栏 .sidebar-new-topic-btn 混用）。 */
function SidebarEmptyNewTopicButton({
  candidates,
  onSelectProfile,
}: {
  candidates: ReadonlyArray<AgentStanding>
  onSelectProfile: (profileId: string, opts?: { flush?: boolean }) => void
}): ReactNode {
  const { t } = useWebLocale()
  const pickedRef = useRef(false)
  if (candidates.length === 0) return null

  const newTopicShortcut = formatModShiftShortcut('O')
  const singleCandidate = candidates.length === 1 ? (candidates[0] ?? null) : null
  if (singleCandidate !== null) {
    return (
      <Button
        size="sm"
        className="sidebar-empty-new-topic-btn"
        icon={<HelmxIcon name="plus" size={12} />}
        title={t('shell.agents.newTopicUnderWithShortcut', { label: singleCandidate.label, shortcut: newTopicShortcut })}
        aria-label={t('conv.pane.newTopic')}
        onClick={() => onSelectProfile(singleCandidate.profileId)}
      >
        {t('conv.pane.newTopic')}
      </Button>
    )
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) pickedRef.current = false
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="sidebar-empty-new-topic-btn"
          icon={<HelmxIcon name="plus" size={12} />}
          title={t('conv.pane.newTopicWithShortcut', { shortcut: newTopicShortcut })}
          aria-label={t('conv.pane.newTopic')}
          aria-haspopup="menu"
        >
          <Stack inline direction="horizontal" gap="xs" align="center">
            <span>{t('conv.pane.newTopic')}</span>
            <HelmxIcon name="chevron-down" size={11} />
          </Stack>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="pane-more-popover"
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(e) => {
            if (pickedRef.current) {
              pickedRef.current = false
              e.preventDefault()
            }
          }}
        >
          {renderNewTopicMenuItems(
            candidates,
            (label) => t('shell.agents.newTopicUnder', { label }),
            (profileId) => {
              pickedRef.current = true
              onSelectProfile(profileId, { flush: false })
            },
          )}
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
              <span className="nav-status-slot">
                <ConversationStatusDot
                  conv={card.root}
                  background={{ active: card.backgroundActive, summary: card.backgroundSummary }}
                  showDone={card.root.unread && !viewedConversationIds.has(card.root.id)}
                />
              </span>
              <span className="nav-item-label">{titleText}</span>
            </button>
            {(rootPresence.paneTag !== null || !batchMode) && (
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
          <span className="nav-status-slot">
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
          </span>
          <span className="nav-item-label">{titleText}</span>
        </button>
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
        </span>
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

  const [archiving, setArchiving] = useState(false)
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
  const effectiveArchivableSelectedIds = useMemo(
    () =>
      renderedCards
        .filter((card) => batch.selectedIds.has(card.root.id) && isConversationArchivable(card.root))
        .map((card) => card.root.id),
    [renderedCards, batch.selectedIds],
  )

  const executeBatchArchive = async (): Promise<void> => {
    if (effectiveArchivableSelectedIds.length === 0 || archiving || batch.deleting) return
    setArchiving(true)
    try {
      const archivableSet = new Set(effectiveArchivableSelectedIds)
      const convs = renderedCards
        .filter((card) => archivableSet.has(card.root.id))
        .map((card) => card.root)
      if (convs.length === 0) return
      const outcome = await patchConversationsArchived(convs, true)
      store.pushNotice(archiveBatchNotice(true, outcome, t))
      batch.exitBatchMode()
    } finally {
      setArchiving(false)
    }
  }

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
          <SidebarNewTopicButton
            candidates={newTopicCandidates}
            store={store}
            onSelectProfile={openStandby}
          />
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
        <div className="sidebar-search-empty" role="status">
          {t('shell.overview.loading')}
        </div>
      ) : !workingSet.searchActive && workingSet.totalRootCount === 0 && cardGroups.length === 0 ? (
        <div className="sidebar-overview-empty">
          <span>{t('shell.sidebar.overviewEmpty')}</span>
          <SidebarEmptyNewTopicButton candidates={newTopicCandidates} onSelectProfile={openStandby} />
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
  )
}
