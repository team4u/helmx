/**
 * builtin:swarm right workbench panel (conversation-scoped orchestration
 * card):
 * - resolves the current conversation's swarm group from the public `index`
 *   doc (coordinator-owned group for coordinator conversations, the same
 *   group's facts for worker conversations — never a global group index);
 * - live `board-view` session doc (keyed by coordinatorConversationId) while
 *   the group is active; explicit one-shot `board_status` fallback (plus
 *   on-demand `board_read` for the full record) for closed / detached groups
 *   or a not-yet-projected doc — failures surface with Retry, never a blank
 *   screen or a fabricated "running" state;
 * - one orchestration card: objective, natural status, member rows with one
 *   honest sentence of latest progress (click opens the ConversationDrawer),
 *   recent handoff activity with #seq as auxiliary info, worktree branch
 *   facts, and retained branches after close.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol'
import {
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  SegmentedControl,
  StatusLight,
  Tooltip,
  formatModelShortName,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  extractPostRefs,
  mergeBoardViewWithRead,
  parseBoardView,
  postDigestLine,
  postKindBadgeClass,
  resolveConversationBoardLink,
  shouldCollapsePostBody,
  type BoardViewDoc,
} from './board-model.ts'
import { buildSwarmPanelModel } from './model-panel.ts'
import {
  resolveGroupTimingView,
  resolvePanelMemberTimingView,
  resolvePostTimeDisplay,
} from './model-timing.ts'
import {
  useElapsedNowMs,
  useSwarmBoardPeekPost,
  useSwarmBoardReadOnce,
  useSwarmBoardStatusFallback,
} from './hooks.ts'
import {
  ACTION_ABORT,
  JUMP_BACK_DISMISS,
  PANEL_ACTIVITY_AUTHORED,
  PANEL_ACTIVITY_RECEIVED,
  PANEL_ACTIVITY_TITLE,
  PANEL_CANCEL,
  PANEL_CHANNEL_ALL,
  PANEL_CHANNEL_FILTER_ARIA,
  PANEL_CLOSE_ABORT_RUNNING,
  PANEL_CLOSE_CONFIRM,
  PANEL_CLOSE_DIALOG_DESC,
  PANEL_CLOSE_DIALOG_TITLE,
  PANEL_CLOSE_GROUP,
  PANEL_CLOSE_KEEP_WORKTREE,
  PANEL_EMPTY_HINT,
  PANEL_EMPTY_TITLE,
  PANEL_FALLBACK_NOTE,
  PANEL_HISTORY_COLLAPSE,
  PANEL_HISTORY_TOGGLE,
  PANEL_LOAD_EARLIER,
  PANEL_LOADING,
  PANEL_LOADING_EARLIER,
  PANEL_MEMBERS_EMPTY,
  PANEL_MEMBERS_TITLE,
  PANEL_OBJECTIVE,
  PANEL_POSTS_CHANNEL_EMPTY,
  PANEL_POSTS_EMPTY,
  PANEL_REFRESH,
  PANEL_RETAINED_TITLE,
  PANEL_RETRY,
  PANEL_STATUS_LOAD_FAILED,
  jumpBackLabel,
  panelCloseFailed,
  panelPostTargets,
  panelRefJumpLabel,
  panelRetainedSummary,
  panelRowOpenLabel,
  panelStatusLabel,
  panelWorktreeSummary,
  postKindLabel,
  memberLiveStateLabel,
  memberAccessLabel,
  resolvePanelHeadlineText,
  trayAbortFailed,
  PANEL_MEMBER_ARCHIVED,
} from './copy.ts'
import {
  currentPeekSeq,
  openPostPeek,
  popJumpBack,
  popPostPeek,
  pushJumpBack,
  pushPostPeek,
  type PostPeekState,
} from './model-post-nav.ts'
import { PostBodyText } from './PostBodyText.tsx'
import { SwarmPostPeekPopover } from './SwarmPostPeekPopover.tsx'

const RECENT_LIMIT_COLLAPSED = 6

const LIVE_STATE_LIGHT_STATUS: Record<string, string> = {
  working: 'running',
  blocked: 'blocked',
  error: 'failed',
  done: 'done',
  missing: 'pending',
  idle: 'idle',
}

function panelHeadLight(status: 'running' | 'attention' | 'completed'):
  | 'running'
  | 'blocked'
  | 'done' {
  if (status === 'attention') return 'blocked'
  if (status === 'completed') return 'done'
  return 'running'
}

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const peekAnchorRef = useRef<HTMLElement | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<string>('all')
  const [highlightedSeq, setHighlightedSeq] = useState<number | undefined>(undefined)
  const [peekState, setPeekState] = useState<PostPeekState | undefined>(undefined)
  const [jumpBackStack, setJumpBackStack] = useState<number[]>([])
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeKeepWorktree, setCloseKeepWorktree] = useState(false)
  const [closeAbortRunning, setCloseAbortRunning] = useState(false)
  const [closeError, setCloseError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setHistoryExpanded(false)
    setSelectedChannel('all')
    setHighlightedSeq(undefined)
    setPeekState(undefined)
    setJumpBackStack([])
    setCloseDialogOpen(false)
    setCloseError(undefined)
  }, [conversationId])

  const link = useMemo(
    () => resolveConversationBoardLink(conversationId, index),
    [conversationId, index],
  )
  const currentConv = props?.conversation ?? conversations.find((c) => c.id === conversationId)
  const hasArchivedSwarmTag =
    currentConv?.tags.includes('swarm-coordinator-archived') === true ||
    currentConv?.tags.includes('swarm-worker-archived') === true

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>(
    'board-view',
    link !== undefined ? { conversationId: link.coordinatorConversationId } : undefined,
  )
  const liveBoard = useMemo(() => {
    if (rawBoard === undefined) return undefined
    const parsed = parseBoardView(rawBoard)
    if (parsed === undefined) return undefined
    if (link !== undefined && parsed.group.id !== link.groupId) return undefined
    return parsed
  }, [rawBoard, link])

  const needsFallback = (link !== undefined || hasArchivedSwarmTag) && liveBoard === undefined
  const fallback = useSwarmBoardStatusFallback(link?.groupId, {
    conversationId,
    enabled: needsFallback,
    allowConversationLookup: hasArchivedSwarmTag,
  })

  const board = liveBoard ?? fallback.view
  const loading = needsFallback && fallback.loading && board === undefined
  const loadError = liveBoard === undefined ? fallback.error : undefined
  const isFallbackData = liveBoard === undefined && board !== undefined
  const resolvedGroupId = link?.groupId ?? board?.group.id

  const needsFullRead =
    historyExpanded &&
    (isFallbackData || (board !== undefined && board.posts.length < board.group.headSeq))
  const readState = useSwarmBoardReadOnce(
    resolvedGroupId,
    needsFullRead,
    {
      conversationId,
      headSeq: board?.group.headSeq,
      initialOldestSeq: board !== undefined && board.posts.length > 0 ? board.posts[0]!.seq : undefined,
    },
  )

  const boardWithHistory = useMemo(
    () =>
      board !== undefined && readState.posts.length > 0
        ? mergeBoardViewWithRead(board, readState.posts)
        : board,
    [board, readState.posts],
  )

  const peekTargetSeq = peekState !== undefined ? currentPeekSeq(peekState) : undefined
  const peekNeedsExactRead =
    peekTargetSeq !== undefined &&
    boardWithHistory !== undefined &&
    peekTargetSeq <= boardWithHistory.group.headSeq &&
    !boardWithHistory.posts.some((p) => p.seq === peekTargetSeq)
  const peekReadState = useSwarmBoardPeekPost(resolvedGroupId, peekTargetSeq, {
    conversationId,
    enabled: peekNeedsExactRead,
  })

  const effectiveBoard = useMemo(
    () =>
      boardWithHistory !== undefined && peekReadState.posts.length > 0
        ? mergeBoardViewWithRead(boardWithHistory, peekReadState.posts)
        : boardWithHistory,
    [boardWithHistory, peekReadState.posts],
  )

  const activeChannelFilter = useMemo(() => {
    if (selectedChannel === 'all' || effectiveBoard === undefined) return 'all'
    return effectiveBoard.group.channels.some((c) => c.name === selectedChannel && c.archived !== true)
      ? selectedChannel
      : 'all'
  }, [selectedChannel, effectiveBoard])

  const model = useMemo(
    () =>
      effectiveBoard !== undefined
        ? buildSwarmPanelModel(effectiveBoard, conversations, {
            recentLimit: historyExpanded ? null : RECENT_LIMIT_COLLAPSED,
            channel: activeChannelFilter,
          })
        : undefined,
    [effectiveBoard, conversations, historyExpanded, activeChannelFilter],
  )

  useEffect(() => {
    if (highlightedSeq === undefined) return
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-post-seq="${highlightedSeq}"]`)
    if (el !== null && el !== undefined) {
      el.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlightedSeq, model?.recentPosts])

  const hasLiveMember =
    effectiveBoard !== undefined &&
    effectiveBoard.group.status === 'active' &&
    effectiveBoard.members.some(
      (m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked'),
    )
  const timerActive =
    effectiveBoard !== undefined &&
    ((effectiveBoard.group.status === 'active' && effectiveBoard.group.createdAt > 0) || hasLiveMember)
  const nowMs = useElapsedNowMs(timerActive)
  const groupTiming =
    effectiveBoard !== undefined
      ? resolveGroupTimingView(effectiveBoard, conversations, nowMs, locale)
      : undefined

  if (conversationId === undefined || (link === undefined && !hasArchivedSwarmTag)) {
    return (
      <div className="sw-panel">
        <div className="empty-state empty-state-compact">
          <p className="empty-state-title">{resolveLocalizedText(PANEL_EMPTY_TITLE, locale)}</p>
          <p className="empty-state-hint">{resolveLocalizedText(PANEL_EMPTY_HINT, locale)}</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="sw-panel">
        <div className="loading-state" role="status">{resolveLocalizedText(PANEL_LOADING, locale)}</div>
      </div>
    )
  }

  if (model === undefined || effectiveBoard === undefined) {
    return (
      <div className="sw-panel">
        <Callout tone={loadError !== undefined ? 'err' : 'warn'} title={resolveLocalizedText(PANEL_STATUS_LOAD_FAILED, locale)}>
          {loadError !== undefined ? <p className="sw-panel-error-text">{loadError}</p> : null}
          <button type="button" className="btn btn-xs" onClick={fallback.reload}>
            <HelmxIcon name="rotate-cw" size={11} />
            <span>{resolveLocalizedText(PANEL_RETRY, locale)}</span>
          </button>
        </Callout>
      </div>
    )
  }

  const isCoordinatorActiveGroup =
    effectiveBoard.group.status === 'active' &&
    conversationId === effectiveBoard.group.coordinatorConversationId
  const headlineText = resolvePanelHeadlineText(effectiveBoard, locale)
  const visibleSeqs = new Set(model.recentPosts.map((p) => p.seq))

  const runAbortMember = (memberName: string): void => {
    if (busyAction !== undefined) return
    setBusyAction(`abort:${memberName}`)
    void ctx
      .callAction('abort_worker', { groupId: effectiveBoard.group.id, name: memberName }, { conversationId })
      .catch((err: unknown) => {
        ctx.notify(trayAbortFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => {
        setBusyAction(undefined)
      })
  }

  const openCloseDialog = (): void => {
    setCloseKeepWorktree(
      effectiveBoard.members.some((m) => m.lifecycle === 'active' && m.worktreeId !== undefined),
    )
    setCloseAbortRunning(effectiveBoard.activeWorkingMembers.length > 0)
    setCloseError(undefined)
    setCloseDialogOpen(true)
  }

  const confirmCloseGroup = (): void => {
    if (busyAction !== undefined) return
    setBusyAction('close_group')
    setCloseError(undefined)
    void ctx
      .callAction(
        'close_group',
        {
          groupId: effectiveBoard.group.id,
          ...(closeKeepWorktree ? { keepWorktree: true } : {}),
          ...(closeAbortRunning ? { abortRunning: true } : {}),
        },
        { conversationId },
      )
      .then(() => {
        setCloseDialogOpen(false)
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setCloseError(msg)
        ctx.notify(panelCloseFailed(msg, locale), 'error')
      })
      .finally(() => {
        setBusyAction(undefined)
      })
  }

  const scrollAndHighlightPost = (seq: number): void => {
    if (!visibleSeqs.has(seq)) {
      const inFullBoard = effectiveBoard.posts.find((p) => p.seq === seq)
      if (activeChannelFilter !== 'all' && (inFullBoard === undefined || inFullBoard.channel !== activeChannelFilter)) {
        setSelectedChannel('all')
      }
      const inCollapsedRecent = effectiveBoard.posts
        .slice(-RECENT_LIMIT_COLLAPSED)
        .some((p) => p.seq === seq)
      if (!inCollapsedRecent) {
        setHistoryExpanded(true)
      }
    }
    setHighlightedSeq(seq)
  }

  const handleOpenPeek = (originSeq: number, targetSeq: number, anchorEl: HTMLElement): void => {
    peekAnchorRef.current = anchorEl
    setPeekState(openPostPeek(originSeq, targetSeq))
  }

  const handleLocateFromPeek = (targetSeq: number): void => {
    if (peekState !== undefined) {
      setJumpBackStack((prev) => pushJumpBack(prev, peekState.originSeq, targetSeq))
    }
    setPeekState(undefined)
    scrollAndHighlightPost(targetSeq)
  }

  const handleJumpBack = (): void => {
    const { targetSeq, nextStack } = popJumpBack(jumpBackStack)
    setJumpBackStack(nextStack)
    if (targetSeq !== undefined) {
      scrollAndHighlightPost(targetSeq)
    }
  }

  const peekPost =
    peekTargetSeq !== undefined
      ? effectiveBoard.posts.find((p) => p.seq === peekTargetSeq)
      : undefined
  const jumpBackTop = jumpBackStack.length > 0 ? jumpBackStack[jumpBackStack.length - 1] : undefined

  const showChannelFilter = model.channels.length > 1
  const channelItems = showChannelFilter
    ? [
        { value: 'all', label: resolveLocalizedText(PANEL_CHANNEL_ALL, locale) },
        ...model.channels.map((ch) => ({
          value: ch.name,
          label: `#${ch.name}`,
          ...(ch.topic !== undefined ? { title: ch.topic } : {}),
        })),
      ]
    : []

  return (
    <div ref={panelRef} className="sw-panel">
      <div className="sw-panel-head">
        <span className="sw-panel-head-left">
          <StatusLight status={panelHeadLight(model.status)} label={panelStatusLabel(model.status, locale)} />
          <span className="sw-panel-title" title={effectiveBoard.group.title}>{effectiveBoard.group.title}</span>
          <span className={`badge ${model.status === 'attention' ? 'badge-warn' : model.status === 'completed' ? 'badge-neutral' : 'badge-accent'}`}>
            {panelStatusLabel(model.status, locale)}
          </span>
          <span className="badge badge-neutral tabular-nums">
            {`${model.progress.done}/${model.progress.total}`}
          </span>
          {groupTiming !== undefined ? (
            <Tooltip content={groupTiming.tooltip} className="sw-timing-tooltip">
              <span className="sw-panel-elapsed tabular-nums">{groupTiming.label}</span>
            </Tooltip>
          ) : null}
        </span>
        <span className="stack-row sw-panel-head-actions">
          {isFallbackData ? (
            <>
              <span className="badge badge-neutral">{resolveLocalizedText(PANEL_FALLBACK_NOTE, locale)}</span>
              <button type="button" className="btn btn-xs" onClick={fallback.reload}>
                <HelmxIcon name="rotate-cw" size={11} />
                <span>{resolveLocalizedText(PANEL_REFRESH, locale)}</span>
              </button>
            </>
          ) : null}
          {isCoordinatorActiveGroup ? (
            <button
              type="button"
              className="btn btn-xs sw-panel-close-btn"
              disabled={busyAction !== undefined}
              onClick={openCloseDialog}
            >
              <HelmxIcon name="check-circle" size={11} />
              <span>{resolveLocalizedText(PANEL_CLOSE_GROUP, locale)}</span>
            </button>
          ) : null}
        </span>
      </div>

      {headlineText !== '' ? (
        <p className={`sw-panel-headline sw-panel-headline-${model.headlineTone}`}>
          {headlineText}
        </p>
      ) : null}

      {model.objective !== undefined ? (
        <div className="sw-panel-objective">
          <span className="sw-panel-kv-key">{resolveLocalizedText(PANEL_OBJECTIVE, locale)}</span>
          <p className="sw-panel-objective-text">{model.objective}</p>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_MEMBERS_TITLE, locale)}</span>
          <span className="badge badge-neutral tabular-nums">{model.rows.length}</span>
        </div>
        {model.rows.length === 0 ? (
          <div className="sw-panel-empty-hint">{resolveLocalizedText(PANEL_MEMBERS_EMPTY, locale)}</div>
        ) : (
          <div className="sw-panel-members">
            {model.rows.map((row) => {
              const activityKind =
                row.latestActivity !== undefined ? postKindLabel(row.latestActivity.post.kind, locale) : undefined
              const activityText =
                row.latestActivity !== undefined
                  ? `${row.latestActivity.direction === 'received' ? resolveLocalizedText(PANEL_ACTIVITY_RECEIVED, locale) : resolveLocalizedText(PANEL_ACTIVITY_AUTHORED, locale)} · ${activityKind ?? ''}: ${postDigestLine(row.latestActivity.post.body, 90)}`
                  : undefined
              const canAbort =
                isCoordinatorActiveGroup &&
                row.lifecycle === 'active' &&
                (row.liveState === 'working' || row.liveState === 'blocked')
              const memberTiming = resolvePanelMemberTimingView(
                row,
                effectiveBoard.group.status,
                nowMs,
                locale,
              )
              return (
                <div key={row.name} className="sw-panel-member-item">
                  <button
                    type="button"
                    className="sw-panel-member-row"
                    aria-label={`@${row.name} — ${panelRowOpenLabel(row.name, locale)}`}
                    onClick={() => ctx.openConversationDrawer(row.conversationId)}
                  >
                    <span className="sw-panel-member-main">
                      <StatusLight
                        status={LIVE_STATE_LIGHT_STATUS[row.liveState] ?? 'pending'}
                        label={memberLiveStateLabel(row.liveState, locale)}
                      />
                      <span className="sw-panel-member-name">@{row.name}</span>
                      {row.lifecycle === 'archived' ? (
                        <span className="badge badge-neutral">{resolveLocalizedText(PANEL_MEMBER_ARCHIVED, locale)}</span>
                      ) : null}
                      <span className="badge badge-neutral">{memberAccessLabel(row.access, locale)}</span>
                      {row.model !== undefined ? (
                        <span className="badge badge-neutral mono sw-panel-member-model" title={row.model}>
                          {formatModelShortName(row.model)}
                        </span>
                      ) : null}
                      {row.doing !== undefined ? (
                        <span className="sw-panel-member-doing" title={row.doing}>{row.doing}</span>
                      ) : null}
                      {memberTiming !== undefined ? (
                        <Tooltip content={memberTiming.tooltip} className="sw-timing-tooltip">
                          <span
                            className={`sw-panel-member-elapsed mono tabular-nums${memberTiming.tone === 'warn' ? ' sw-panel-member-elapsed-warn' : ''}`}
                          >
                            {memberTiming.label}
                          </span>
                        </Tooltip>
                      ) : null}
                    </span>
                    <span className="sw-panel-member-activity" title={activityText}>
                      {activityText !== undefined ? activityText : `#${row.conversationId}`}
                    </span>
                    {row.worktree !== undefined ? (
                      <span
                        className="sw-panel-member-worktree"
                        title={`${row.worktree.worktreeId}${row.worktree.branch ? ` · ${row.worktree.branch}` : ''}`}
                      >
                        <HelmxIcon name="git-branch" size={11} />
                        <span>{panelWorktreeSummary(row.worktree, locale)}</span>
                      </span>
                    ) : null}
                  </button>
                  {canAbort ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger sw-panel-member-abort"
                      disabled={busyAction !== undefined}
                      onClick={() => runAbortMember(row.name)}
                    >
                      <HelmxIcon name="square" size={11} />
                      <span>{resolveLocalizedText(ACTION_ABORT, locale)}</span>
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {model.retainedWorktrees !== undefined && model.retainedWorktrees.length > 0 ? (
        <div className="sw-panel-section">
          <div className="sw-panel-section-head">
            <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_RETAINED_TITLE, locale)}</span>
            <span className="badge badge-warn tabular-nums">{model.retainedWorktrees.length}</span>
          </div>
          <ul className="sw-panel-retained">
            {model.retainedWorktrees.map((item) => (
              <li key={item.worktreeId} className="sw-panel-retained-item">
                <HelmxIcon name="git-branch" size={11} />
                <span title={`${item.path} · ${item.worktreeId}`}>{panelRetainedSummary(item, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{resolveLocalizedText(PANEL_ACTIVITY_TITLE, locale)}</span>
          <button
            type="button"
            className="btn btn-xs btn-ghost sw-panel-history-toggle"
            aria-expanded={historyExpanded}
            onClick={() => setHistoryExpanded((v) => !v)}
          >
            <HelmxIcon name={historyExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{resolveLocalizedText(historyExpanded ? PANEL_HISTORY_COLLAPSE : PANEL_HISTORY_TOGGLE, locale)}</span>
          </button>
        </div>
        {showChannelFilter ? (
          <div className="sw-panel-channels">
            <SegmentedControl
              size="sm"
              value={activeChannelFilter}
              onValueChange={(next) => setSelectedChannel(next)}
              items={channelItems}
              aria-label={resolveLocalizedText(PANEL_CHANNEL_FILTER_ARIA, locale)}
            />
          </div>
        ) : null}
        {jumpBackTop !== undefined ? (
          <div className="sw-panel-jump-back" role="status">
            <button
              type="button"
              className="btn btn-xs btn-ghost sw-panel-jump-back-btn"
              onClick={handleJumpBack}
            >
              <HelmxIcon name="arrow-left" size={11} />
              <span>{jumpBackLabel(jumpBackTop, locale)}</span>
              {jumpBackStack.length > 1 ? (
                <span className="badge badge-neutral tabular-nums">{jumpBackStack.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost btn-icon-sm sw-panel-jump-back-clear"
              aria-label={resolveLocalizedText(JUMP_BACK_DISMISS, locale)}
              title={resolveLocalizedText(JUMP_BACK_DISMISS, locale)}
              onClick={() => setJumpBackStack([])}
            >
              <HelmxIcon name="x" size={11} />
            </button>
          </div>
        ) : null}
        {readState.hasEarlier ? (
          <button
            type="button"
            className="btn btn-xs btn-ghost sw-panel-load-earlier"
            disabled={readState.loadingEarlier || readState.loading}
            onClick={readState.loadEarlier}
          >
            <HelmxIcon name="chevron-up" size={11} />
            <span>
              {resolveLocalizedText(
                readState.loadingEarlier ? PANEL_LOADING_EARLIER : PANEL_LOAD_EARLIER,
                locale,
              )}
            </span>
          </button>
        ) : null}
        {model.recentPosts.length === 0 ? (
          <div className="sw-panel-empty-hint">
            {resolveLocalizedText(
              activeChannelFilter !== 'all' ? PANEL_POSTS_CHANNEL_EMPTY : PANEL_POSTS_EMPTY,
              locale,
            )}
          </div>
        ) : (
          <ol className="sw-panel-posts">
            {model.recentPosts.map((post) => {
              const refs = extractPostRefs(post)
              const isHighlighted = highlightedSeq === post.seq
              const postTime = resolvePostTimeDisplay(post.createdAt, effectiveBoard.group.createdAt)
              return (
                <li
                  key={post.seq}
                  data-post-seq={post.seq}
                  className={`sw-panel-post${isHighlighted ? ' sw-panel-post-highlighted' : ''}`}
                >
                  <div className="sw-panel-post-head">
                    <span className={`badge ${postKindBadgeClass(post.kind)}`}>{postKindLabel(post.kind, locale)}</span>
                    {showChannelFilter && post.channel !== 'main' ? (
                      <span className="badge badge-neutral mono sw-panel-post-channel">#{post.channel}</span>
                    ) : null}
                    <span className="sw-panel-post-from">
                      {post.from === 'coordinator' ? 'coordinator' : `@${post.from}`}
                      {' -> '}
                      {panelPostTargets(post)}
                    </span>
                    <span className="sw-panel-post-meta">
                      {postTime !== undefined ? (
                        <Tooltip content={postTime.fullTimestamp} className="sw-timing-tooltip">
                          <span
                            className="sw-panel-post-time mono tabular-nums"
                            aria-label={postTime.fullTimestamp}
                          >
                            {postTime.label}
                          </span>
                        </Tooltip>
                      ) : null}
                      <span className="sw-panel-post-seq tabular-nums">{`#${post.seq}`}</span>
                    </span>
                  </div>
                  <PostBodyText
                    body={post.body}
                    collapsible={shouldCollapsePostBody(post.body)}
                    selfSeq={post.seq}
                    onRefClick={(refSeq, anchorEl) => handleOpenPeek(post.seq, refSeq, anchorEl)}
                  />
                  {refs.length > 0 ? (
                    <div className="sw-panel-post-refs">
                      {refs.map((refSeq) => (
                        <button
                          key={refSeq}
                          type="button"
                          className="sw-panel-post-ref mono tabular-nums"
                          aria-label={panelRefJumpLabel(refSeq, locale)}
                          onClick={(event) => handleOpenPeek(post.seq, refSeq, event.currentTarget)}
                        >
                          {`#${refSeq}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {post.worktreeSnapshot !== undefined ? (
                    <div className="sw-panel-post-worktree">
                      <HelmxIcon name="git-branch" size={11} />
                      <span>{panelWorktreeSummary(post.worktreeSnapshot, locale)}</span>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
        {peekState !== undefined ? (
          <SwarmPostPeekPopover
            peekState={peekState}
            anchorRef={peekAnchorRef}
            post={peekPost}
            loading={peekReadState.loading && peekPost === undefined}
            error={peekPost === undefined ? peekReadState.error : undefined}
            showChannelBadge={showChannelFilter}
            onPushRef={(seq) => setPeekState((prev) => (prev !== undefined ? pushPostPeek(prev, seq) : prev))}
            onBack={() => setPeekState((prev) => (prev !== undefined ? popPostPeek(prev) : undefined))}
            onLocate={handleLocateFromPeek}
            onRetry={peekReadState.retry}
            onClose={() => setPeekState(undefined)}
          />
        ) : null}
        {readState.error !== undefined ? (
          <div className="sw-panel-empty-hint stack-row">
            <span>{readState.error}</span>
            <button type="button" className="btn btn-xs" onClick={readState.retry}>
              <HelmxIcon name="rotate-cw" size={11} />
              <span>{resolveLocalizedText(PANEL_RETRY, locale)}</span>
            </button>
          </div>
        ) : null}
      </div>

      {isCoordinatorActiveGroup ? (
        <Dialog
          open={closeDialogOpen}
          onOpenChange={(open) => {
            if (!open && busyAction !== 'close_group') {
              setCloseDialogOpen(false)
              setCloseError(undefined)
            }
          }}
        >
          <DialogPortal>
            <DialogOverlay />
            <DialogContent className="modal sw-close-dialog">
              <DialogTitle>{resolveLocalizedText(PANEL_CLOSE_DIALOG_TITLE, locale)}</DialogTitle>
              <DialogDescription className="sw-close-dialog-desc">
                {resolveLocalizedText(PANEL_CLOSE_DIALOG_DESC, locale)}
              </DialogDescription>
              <div className="sw-close-dialog-options">
                <Checkbox
                  checked={closeKeepWorktree}
                  onChange={setCloseKeepWorktree}
                  disabled={busyAction === 'close_group'}
                  label={resolveLocalizedText(PANEL_CLOSE_KEEP_WORKTREE, locale)}
                />
                {effectiveBoard.activeWorkingMembers.length > 0 ? (
                  <Checkbox
                    checked={closeAbortRunning}
                    onChange={setCloseAbortRunning}
                    disabled={busyAction === 'close_group'}
                    label={resolveLocalizedText(PANEL_CLOSE_ABORT_RUNNING, locale)}
                  />
                ) : null}
              </div>
              {closeError !== undefined ? (
                <Callout tone="err" title={resolveLocalizedText(PANEL_CLOSE_DIALOG_TITLE, locale)}>
                  <p className="sw-panel-error-text">{closeError}</p>
                </Callout>
              ) : null}
              <div className="sw-close-dialog-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyAction === 'close_group'}
                  onClick={() => {
                    setCloseDialogOpen(false)
                    setCloseError(undefined)
                  }}
                >
                  {resolveLocalizedText(PANEL_CANCEL, locale)}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary sw-close-dialog-confirm"
                  disabled={busyAction === 'close_group'}
                  onClick={confirmCloseGroup}
                >
                  {resolveLocalizedText(PANEL_CLOSE_CONFIRM, locale)}
                </button>
              </div>
            </DialogContent>
          </DialogPortal>
        </Dialog>
      ) : null}
    </div>
  )
}
