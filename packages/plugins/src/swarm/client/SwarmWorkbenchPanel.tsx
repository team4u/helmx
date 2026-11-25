/**
 * builtin:swarm right workbench panel (single sequential board orchestration card, Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge, Button, Callout, Checkbox, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle,
  EmptyState, HelmxIcon, IconButton, LoadingState, Stack, StatusLight, Tooltip, formatModelShortName, resolveLocalizedText,
  useConversations, usePluginContext, usePluginDoc, usePluginLocale, usePluginSessionDoc,
  type BadgeTone, type LocalizedText, type StatusLightTone,
} from '@helmx/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  extractPostRefs, mergeBoardViewWithRead, parseBoardView, postDigestLine, postKindBadgeTone,
  resolveConversationBoardLink, shouldCollapsePostBody, type BoardViewDoc,
} from './board-model.ts'
import { buildSwarmPanelModel } from './model-panel.ts'
import { resolveGroupTimingView, resolvePanelMemberTimingView, resolvePostTimeDisplay } from './model-timing.ts'
import { useElapsedNowMs, useSwarmBoardPeekPost, useSwarmBoardReadOnce, useSwarmBoardStatusFallback } from './hooks.ts'
import * as C from './copy.ts'
import {
  currentPeekSeq, openPostPeek, popJumpBack, popPostPeek, pushJumpBack, pushPostPeek, type PostPeekState,
} from './model-post-nav.ts'
import { PostBodyText } from './PostBodyText.tsx'
import { SwarmPostPeekPopover } from './SwarmPostPeekPopover.tsx'

const RECENT_LIMIT_COLLAPSED = 6
const LIVE_STATE_LIGHT: Record<string, StatusLightTone> = {
  working: 'working', blocked: 'blocked', error: 'failed', done: 'done', missing: 'pending', idle: 'idle',
}

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const peekAnchorRef = useRef<HTMLElement | null>(null)
  const appliedParamsRef = useRef<unknown>(undefined)

  const requestedPostSeq =
    typeof props?.params?.['postSeq'] === 'number' &&
    Number.isSafeInteger(props.params['postSeq']) &&
    props.params['postSeq'] > 0
      ? props.params['postSeq']
      : undefined
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [highlightedSeq, setHighlightedSeq] = useState<number | undefined>(requestedPostSeq)
  const [peekState, setPeekState] = useState<PostPeekState | undefined>(undefined)
  const [jumpBackStack, setJumpBackStack] = useState<number[]>([])
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeKeepWorktree, setCloseKeepWorktree] = useState(false)
  const [closeAbortRunning, setCloseAbortRunning] = useState(false)
  const [closeError, setCloseError] = useState<string | undefined>(undefined)

  useEffect(() => {
    appliedParamsRef.current = undefined
    setHistoryExpanded(false)
    setHighlightedSeq(undefined)
    setPeekState(undefined)
    setJumpBackStack([])
    setCloseDialogOpen(false)
    setCloseError(undefined)
  }, [conversationId])

  const link = useMemo(() => resolveConversationBoardLink(conversationId, index), [conversationId, index])
  const currentConv = props?.conversation ?? conversations.find((c) => c.id === conversationId)
  const hasArchivedTag =
    currentConv?.tags.includes('swarm-coordinator-archived') === true ||
    currentConv?.tags.includes('swarm-worker-archived') === true

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>(
    'board-view',
    link ? { conversationId: link.coordinatorConversationId } : undefined,
  )
  const liveBoard = useMemo(() => {
    const parsed = rawBoard !== undefined ? parseBoardView(rawBoard) : undefined
    return parsed && (!link || parsed.group.id === link.groupId) ? parsed : undefined
  }, [rawBoard, link])

  const needsFallback = (link !== undefined || hasArchivedTag) && liveBoard === undefined
  const fallback = useSwarmBoardStatusFallback(link?.groupId, {
    conversationId, enabled: needsFallback, allowConversationLookup: hasArchivedTag,
  })

  const board = liveBoard ?? fallback.view
  const loading = needsFallback && fallback.loading && !board
  const loadError = liveBoard ? undefined : fallback.error
  const isFallbackData = !liveBoard && Boolean(board)
  const resolvedGroupId = link?.groupId ?? board?.group.id

  const needsFullRead = historyExpanded && (isFallbackData || (board !== undefined && board.posts.length < board.group.headSeq))
  const readState = useSwarmBoardReadOnce(resolvedGroupId, needsFullRead, {
    conversationId, headSeq: board?.group.headSeq, initialOldestSeq: board?.posts[0]?.seq,
  })
  const boardWithHistory = useMemo(
    () => (board && readState.posts.length > 0 ? mergeBoardViewWithRead(board, readState.posts) : board),
    [board, readState.posts],
  )

  const peekTargetSeq = peekState ? currentPeekSeq(peekState) : undefined
  const peekNeedsExact =
    peekTargetSeq !== undefined && boardWithHistory !== undefined &&
    peekTargetSeq <= boardWithHistory.group.headSeq && !boardWithHistory.posts.some((p) => p.seq === peekTargetSeq)
  const peekReadState = useSwarmBoardPeekPost(resolvedGroupId, peekTargetSeq, { conversationId, enabled: peekNeedsExact })
  const effectiveBoard = useMemo(
    () => (boardWithHistory && peekReadState.posts.length > 0 ? mergeBoardViewWithRead(boardWithHistory, peekReadState.posts) : boardWithHistory),
    [boardWithHistory, peekReadState.posts],
  )

  const model = useMemo(
    () => (effectiveBoard ? buildSwarmPanelModel(effectiveBoard, conversations, { recentLimit: historyExpanded ? null : RECENT_LIMIT_COLLAPSED }) : undefined),
    [effectiveBoard, conversations, historyExpanded],
  )

  useEffect(() => {
    if (requestedPostSeq === undefined || props?.params === appliedParamsRef.current) return
    setHighlightedSeq(requestedPostSeq)
    if (effectiveBoard === undefined) return
    appliedParamsRef.current = props?.params
    if (!effectiveBoard.posts.slice(-RECENT_LIMIT_COLLAPSED).some((p) => p.seq === requestedPostSeq)) {
      setHistoryExpanded(true)
    }
  }, [conversationId, props?.params, requestedPostSeq, effectiveBoard])

  useEffect(() => {
    if (highlightedSeq !== undefined) {
      panelRef.current?.querySelector<HTMLElement>(`[data-post-seq="${highlightedSeq}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlightedSeq, model?.recentPosts])

  const timerActive =
    effectiveBoard !== undefined &&
    ((effectiveBoard.group.status === 'active' && effectiveBoard.group.createdAt > 0) ||
      (effectiveBoard.group.status === 'active' && effectiveBoard.members.some((m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked'))))
  const nowMs = useElapsedNowMs(timerActive)
  const groupTiming = effectiveBoard ? resolveGroupTimingView(effectiveBoard, conversations, nowMs, locale) : undefined

  if (conversationId === undefined || (!link && !hasArchivedTag)) {
    return (
      <div className="sw-panel">
        <EmptyState compact title={t(C.PANEL_EMPTY_TITLE)} hint={t(C.PANEL_EMPTY_HINT)} />
      </div>
    )
  }
  if (loading) {
    return <div className="sw-panel"><LoadingState label={t(C.PANEL_LOADING)} /></div>
  }
  if (!model || !effectiveBoard) {
    return (
      <div className="sw-panel">
        <Callout tone={loadError ? 'err' : 'warn'} title={t(C.PANEL_STATUS_LOAD_FAILED)}>
          {loadError ? <p className="sw-panel-error-text">{loadError}</p> : null}
          <Button size="xs" icon="rotate-cw" onClick={fallback.reload}>
            {t(C.PANEL_RETRY)}
          </Button>
        </Callout>
      </div>
    )
  }

  const isCoordinatorActive = effectiveBoard.group.status === 'active' && conversationId === effectiveBoard.group.coordinatorConversationId
  const headlineText = C.resolvePanelHeadlineText(effectiveBoard, locale)
  const visibleSeqs = new Set(model.recentPosts.map((p) => p.seq))

  const runAbortMember = (memberName: string): void => {
    if (busyAction) return
    setBusyAction(`abort:${memberName}`)
    void ctx
      .callAction('abort_worker', { groupId: effectiveBoard.group.id, name: memberName }, { conversationId })
      .catch((err: unknown) => ctx.notify(C.trayAbortFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
      .finally(() => setBusyAction(undefined))
  }

  const openCloseDialog = (): void => {
    setCloseKeepWorktree(effectiveBoard.members.some((m) => m.lifecycle === 'active' && m.worktreeId !== undefined))
    setCloseAbortRunning(effectiveBoard.activeWorkingMembers.length > 0)
    setCloseError(undefined)
    setCloseDialogOpen(true)
  }

  const confirmCloseGroup = (): void => {
    if (busyAction) return
    setBusyAction('close_group')
    setCloseError(undefined)
    void ctx
      .callAction(
        'close_group',
        { groupId: effectiveBoard.group.id, ...(closeKeepWorktree ? { keepWorktree: true } : {}), ...(closeAbortRunning ? { abortRunning: true } : {}) },
        { conversationId },
      )
      .then((res) => {
        setCloseDialogOpen(false)
        const uncleaned =
          res !== null && typeof res === 'object' && Array.isArray((res as { uncleanedWorktrees?: unknown }).uncleanedWorktrees)
            ? (res as { uncleanedWorktrees: unknown[] }).uncleanedWorktrees
            : []
        if (uncleaned.length > 0) {
          ctx.notify(C.panelCloseUncleanedNotice(uncleaned.length, locale), 'warning')
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setCloseError(msg)
        ctx.notify(C.panelCloseFailed(msg, locale), 'error')
      })
      .finally(() => setBusyAction(undefined))
  }

  const scrollAndHighlightPost = (seq: number): void => {
    if (!visibleSeqs.has(seq) && !effectiveBoard.posts.slice(-RECENT_LIMIT_COLLAPSED).some((p) => p.seq === seq)) setHistoryExpanded(true)
    setHighlightedSeq(seq)
  }

  const handleOpenPeek = (originSeq: number, targetSeq: number, anchorEl: HTMLElement): void => {
    peekAnchorRef.current = anchorEl
    setPeekState(openPostPeek(originSeq, targetSeq))
  }

  const handleLocateFromPeek = (targetSeq: number): void => {
    if (peekState) setJumpBackStack((prev) => pushJumpBack(prev, peekState.originSeq, targetSeq))
    setPeekState(undefined)
    scrollAndHighlightPost(targetSeq)
  }

  const handleJumpBack = (): void => {
    const { targetSeq, nextStack } = popJumpBack(jumpBackStack)
    setJumpBackStack(nextStack)
    if (targetSeq !== undefined) scrollAndHighlightPost(targetSeq)
  }

  const peekPost = peekTargetSeq !== undefined ? effectiveBoard.posts.find((p) => p.seq === peekTargetSeq) : undefined
  const jumpBackTop = jumpBackStack[jumpBackStack.length - 1]
  const statusLight: StatusLightTone = model.status === 'attention' ? 'blocked' : model.status === 'completed' ? 'done' : 'working'
  const statusBadgeTone: BadgeTone = model.status === 'attention' ? 'warn' : model.status === 'completed' ? 'neutral' : 'accent'

  return (
    <div ref={panelRef} className="sw-panel">
      <div className="sw-panel-head">
        <span className="sw-panel-head-left">
          <StatusLight tone={statusLight} label={C.panelStatusLabel(model.status, locale)} />
          <span className="sw-panel-title" title={effectiveBoard.group.title}>{effectiveBoard.group.title}</span>
          <Badge tone={statusBadgeTone}>{C.panelStatusLabel(model.status, locale)}</Badge>
          <Badge tone="neutral" className="tabular-nums">{`${model.progress.done}/${model.progress.total}`}</Badge>
          {groupTiming ? (
            <Tooltip content={groupTiming.tooltip} className="sw-timing-tooltip">
              <span className="sw-panel-elapsed tabular-nums">{groupTiming.label}</span>
            </Tooltip>
          ) : null}
        </span>
        <Stack direction="horizontal" gap="xs" align="center" className="sw-panel-head-actions">
          {isFallbackData ? (
            <>
              <Badge tone="neutral">{t(C.PANEL_FALLBACK_NOTE)}</Badge>
              <Button size="xs" icon="rotate-cw" onClick={fallback.reload}>
                {t(C.PANEL_REFRESH)}
              </Button>
            </>
          ) : null}
          {isCoordinatorActive ? (
            <Button size="xs" icon="check-circle" className="sw-panel-close-btn" disabled={busyAction !== undefined} onClick={openCloseDialog}>
              {t(C.PANEL_CLOSE_GROUP)}
            </Button>
          ) : null}
        </Stack>
      </div>

      {headlineText ? <p className={`sw-panel-headline sw-panel-headline-${model.headlineTone}`}>{headlineText}</p> : null}

      {model.objective !== undefined ? (
        <div className="sw-panel-objective">
          <span className="sw-panel-kv-key">{t(C.PANEL_OBJECTIVE)}</span>
          <p className="sw-panel-objective-text">{model.objective}</p>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{t(C.PANEL_MEMBERS_TITLE)}</span>
          <Badge tone="neutral" className="tabular-nums">{model.rows.length}</Badge>
        </div>
        {model.rows.length === 0 ? (
          <div className="sw-panel-empty-hint">{t(C.PANEL_MEMBERS_EMPTY)}</div>
        ) : (
          <div className="sw-panel-members">
            {model.rows.map((row) => {
              const activityText = row.latestActivity
                ? `${t(row.latestActivity.direction === 'received' ? C.PANEL_ACTIVITY_RECEIVED : C.PANEL_ACTIVITY_AUTHORED)} · ${C.postKindLabel(row.latestActivity.post.kind, locale)}: ${postDigestLine(row.latestActivity.post.body, 90)}`
                : undefined
              const canAbort = isCoordinatorActive && row.lifecycle === 'active' && (row.liveState === 'working' || row.liveState === 'blocked')
              const timing = resolvePanelMemberTimingView(row, effectiveBoard.group.status, nowMs, locale)
              return (
                <div key={row.name} className="sw-panel-member-item">
                  <button
                    type="button"
                    className="sw-panel-member-row"
                    aria-label={`@${row.name} — ${C.panelRowOpenLabel(row.name, locale)}`}
                    onClick={() => ctx.openConversationDrawer(row.conversationId)}
                  >
                    <span className="sw-panel-member-main">
                      <StatusLight tone={LIVE_STATE_LIGHT[row.liveState] ?? 'pending'} label={C.memberLiveStateLabel(row.liveState, locale)} />
                      <span className="sw-panel-member-name">@{row.name}</span>
                      {row.lifecycle === 'archived' ? <Badge tone="neutral">{t(C.PANEL_MEMBER_ARCHIVED)}</Badge> : null}
                      <Badge tone="neutral">{C.memberAccessLabel(row.access, locale)}</Badge>
                      {row.model ? <Badge tone="neutral" mono className="sw-panel-member-model" title={row.model}>{formatModelShortName(row.model)}</Badge> : null}
                      {row.doing ? <span className="sw-panel-member-doing" title={row.doing}>{row.doing}</span> : null}
                      {timing ? (
                        <Tooltip content={timing.tooltip} className="sw-timing-tooltip">
                          <span className={`sw-panel-member-elapsed mono tabular-nums${timing.tone === 'warn' ? ' sw-panel-member-elapsed-warn' : ''}`}>{timing.label}</span>
                        </Tooltip>
                      ) : null}
                    </span>
                    <span className="sw-panel-member-activity" title={activityText}>{activityText ?? `#${row.conversationId}`}</span>
                    {row.worktree ? (
                      <span className="sw-panel-member-worktree" title={`${row.worktree.worktreeId}${row.worktree.branch ? ` · ${row.worktree.branch}` : ''}`}>
                        <HelmxIcon name="git-branch" size={11} /><span>{C.panelWorktreeSummary(row.worktree, locale)}</span>
                      </span>
                    ) : null}
                  </button>
                  {canAbort ? (
                    <Button variant="danger" size="xs" icon="square" className="sw-panel-member-abort" disabled={busyAction !== undefined} onClick={() => runAbortMember(row.name)}>
                      {t(C.ACTION_ABORT)}
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {model.retainedWorktrees?.length ? (
        <div className="sw-panel-section">
          <div className="sw-panel-section-head">
            <span className="sw-panel-section-title">{t(C.PANEL_RETAINED_TITLE)}</span>
            <Badge tone="warn" className="tabular-nums">{model.retainedWorktrees.length}</Badge>
          </div>
          <ul className="sw-panel-retained">
            {model.retainedWorktrees.map((item) => (
              <li key={item.worktreeId} className="sw-panel-retained-item">
                <HelmxIcon name="git-branch" size={11} />
                <span title={`${item.path} · ${item.worktreeId}`}>{C.panelRetainedSummary(item, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="sw-panel-section">
        <div className="sw-panel-section-head">
          <span className="sw-panel-section-title">{t(C.PANEL_ACTIVITY_TITLE)}</span>
          <Button variant="ghost" size="xs" icon={historyExpanded ? 'chevron-up' : 'chevron-down'} className="sw-panel-history-toggle" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded((v) => !v)}>
            {t(historyExpanded ? C.PANEL_HISTORY_COLLAPSE : C.PANEL_HISTORY_TOGGLE)}
          </Button>
        </div>

        {jumpBackTop !== undefined ? (
          <div className="sw-panel-jump-back" role="status">
            <Button variant="ghost" size="xs" icon="arrow-left" className="sw-panel-jump-back-btn" onClick={handleJumpBack}>
              <span>{C.jumpBackLabel(jumpBackTop, locale)}</span>
              {jumpBackStack.length > 1 ? <Badge tone="neutral" className="tabular-nums">{jumpBackStack.length}</Badge> : null}
            </Button>
            <IconButton variant="ghost" size="sm" icon="x" className="sw-panel-jump-back-clear" label={t(C.JUMP_BACK_DISMISS)} onClick={() => setJumpBackStack([])} />
          </div>
        ) : null}

        {readState.hasEarlier ? (
          <Button variant="ghost" size="xs" icon="chevron-up" className="sw-panel-load-earlier" disabled={readState.loadingEarlier || readState.loading} onClick={readState.loadEarlier}>
            {t(readState.loadingEarlier ? C.PANEL_LOADING_EARLIER : C.PANEL_LOAD_EARLIER)}
          </Button>
        ) : null}

        {model.recentPosts.length === 0 ? (
          <div className="sw-panel-empty-hint">{t(C.PANEL_POSTS_EMPTY)}</div>
        ) : (
          <ol className="sw-panel-posts">
            {model.recentPosts.map((post) => {
              const refs = extractPostRefs(post)
              const postTime = resolvePostTimeDisplay(post.createdAt, effectiveBoard.group.createdAt)
              return (
                <li key={post.seq} data-post-seq={post.seq} className={`sw-panel-post${highlightedSeq === post.seq ? ' sw-panel-post-highlighted' : ''}`}>
                  <div className="sw-panel-post-head">
                    <Badge tone={postKindBadgeTone(post.kind)}>{C.postKindLabel(post.kind, locale)}</Badge>
                    <span className="sw-panel-post-from">{`${post.from === 'coordinator' ? 'coordinator' : `@${post.from}`} -> ${C.panelPostTargets(post)}`}</span>
                    <span className="sw-panel-post-meta">
                      {postTime ? (
                        <Tooltip content={postTime.fullTimestamp} className="sw-timing-tooltip">
                          <span className="sw-panel-post-time mono tabular-nums" aria-label={postTime.fullTimestamp}>{postTime.label}</span>
                        </Tooltip>
                      ) : null}
                      <span className="sw-panel-post-seq tabular-nums">{`#${post.seq}`}</span>
                    </span>
                  </div>
                  <PostBodyText body={post.body} collapsible={shouldCollapsePostBody(post.body)} selfSeq={post.seq} onRefClick={(refSeq, el) => handleOpenPeek(post.seq, refSeq, el)} />
                  {refs.length > 0 ? (
                    <div className="sw-panel-post-refs">
                      {refs.map((refSeq) => (
                        <button key={refSeq} type="button" className="sw-panel-post-ref mono tabular-nums" aria-label={C.panelRefJumpLabel(refSeq, locale)} onClick={(e) => handleOpenPeek(post.seq, refSeq, e.currentTarget)}>
                          {`#${refSeq}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {post.worktreeSnapshot ? (
                    <div className="sw-panel-post-worktree">
                      <HelmxIcon name="git-branch" size={11} /><span>{C.panelWorktreeSummary(post.worktreeSnapshot, locale)}</span>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}

        {peekState ? (
          <SwarmPostPeekPopover
            peekState={peekState} anchorRef={peekAnchorRef} post={peekPost}
            loading={peekReadState.loading && !peekPost} error={peekPost ? undefined : peekReadState.error}
            onPushRef={(seq) => setPeekState((prev) => (prev ? pushPostPeek(prev, seq) : prev))}
            onBack={() => setPeekState((prev) => (prev ? popPostPeek(prev) : undefined))}
            onLocate={handleLocateFromPeek} onRetry={peekReadState.retry} onClose={() => setPeekState(undefined)}
          />
        ) : null}

        {readState.error ? (
          <Stack direction="horizontal" gap="sm" align="center" className="sw-panel-empty-hint">
            <span>{readState.error}</span>
            <Button size="xs" icon="rotate-cw" onClick={readState.retry}>
              {t(C.PANEL_RETRY)}
            </Button>
          </Stack>
        ) : null}
      </div>

      {isCoordinatorActive ? (
        <Dialog open={closeDialogOpen} onOpenChange={(open) => { if (!open && busyAction !== 'close_group') { setCloseDialogOpen(false); setCloseError(undefined) } }}>
          <DialogPortal>
            <DialogOverlay />
            <DialogContent className="modal sw-close-dialog">
              <DialogTitle>{t(C.PANEL_CLOSE_DIALOG_TITLE)}</DialogTitle>
              <DialogDescription className="sw-close-dialog-desc">{t(C.PANEL_CLOSE_DIALOG_DESC)}</DialogDescription>
              <div className="sw-close-dialog-options">
                <Checkbox checked={closeKeepWorktree} onChange={setCloseKeepWorktree} disabled={busyAction === 'close_group'} label={t(C.PANEL_CLOSE_KEEP_WORKTREE)} />
                {effectiveBoard.activeWorkingMembers.length > 0 ? (
                  <Checkbox checked={closeAbortRunning} onChange={setCloseAbortRunning} disabled={busyAction === 'close_group'} label={t(C.PANEL_CLOSE_ABORT_RUNNING)} />
                ) : null}
              </div>
              {closeError ? <Callout tone="err" title={t(C.PANEL_CLOSE_DIALOG_TITLE)}><p className="sw-panel-error-text">{closeError}</p></Callout> : null}
              <div className="sw-close-dialog-actions">
                <Button size="sm" disabled={busyAction === 'close_group'} onClick={() => { setCloseDialogOpen(false); setCloseError(undefined) }}>{t(C.PANEL_CANCEL)}</Button>
                <Button variant="primary" size="sm" pending={busyAction === 'close_group'} className="sw-close-dialog-confirm" onClick={confirmCloseGroup}>{t(C.PANEL_CLOSE_CONFIRM)}</Button>
              </div>
            </DialogContent>
          </DialogPortal>
        </Dialog>
      ) : null}
    </div>
  )
}
