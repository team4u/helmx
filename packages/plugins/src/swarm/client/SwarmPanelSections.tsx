/**
 * Focused UI sections for `SwarmWorkbenchPanel` (Fast Refresh compliant: components & types only).
 */
import type { MutableRefObject, ReactNode } from 'react'
import type { HelmxLocale } from '@helmx/protocol/browser'
import {
  Badge, Button, Callout, Checkbox, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle,
  HelmxIcon, IconButton, PluginSlot, Stack, StatusLight, Tooltip, formatModelShortName, resolveLocalizedText,
  type LocalizedText, type StatusLightTone,
} from '@helmx/plugin-client'
import { extractPostRefs, postDigestLine, postKindBadgeTone, type BoardPost } from './board-model.ts'
import type { SwarmPanelModel } from './model-panel.ts'
import { resolvePanelMemberTimingView, resolvePostTimeDisplay } from './model-timing.ts'
import type { PostPeekState } from './model-post-nav.ts'
import * as C from './copy.ts'
import { PostBodyText } from './PostBodyText.tsx'
import { SwarmPostPeekPopover } from './SwarmPostPeekPopover.tsx'
import { PostRefButtons, PostWakeBadge, PostWorktreeLine } from './SwarmPostFragments.tsx'
import { shouldCollapsePostBody, type BoardViewDoc } from './board-model.ts'

const LIVE_STATE_LIGHT: Record<string, StatusLightTone> = {
  working: 'working',
  blocked: 'blocked',
  error: 'failed',
  done: 'done',
  missing: 'pending',
  idle: 'idle',
}

export interface SwarmMembersSectionProps {
  locale: HelmxLocale
  effectiveBoard: BoardViewDoc
  model: SwarmPanelModel
  nowMs: number | undefined
  isCoordinatorActive: boolean
  busyAction: string | undefined
  onOpenConversation: (conversationId: number) => void
  onAbortMember: (memberName: string) => void
}

export function SwarmMembersSection(props: SwarmMembersSectionProps): ReactNode {
  const { locale, effectiveBoard, model, nowMs, isCoordinatorActive, busyAction, onOpenConversation, onAbortMember } = props
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)

  return (
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
            const canAbort =
              isCoordinatorActive && row.lifecycle === 'active' && (row.liveState === 'working' || row.liveState === 'blocked')
            const timing = resolvePanelMemberTimingView(row, effectiveBoard.group.status, nowMs, locale)
            return (
              <div key={row.name} className="sw-panel-member-item">
                <button
                  type="button"
                  className="sw-panel-member-row"
                  aria-label={`@${row.name} — ${C.panelRowOpenLabel(row.name, locale)}`}
                  onClick={() => onOpenConversation(row.conversationId)}
                >
                  <span className="sw-panel-member-main">
                    <StatusLight
                      tone={LIVE_STATE_LIGHT[row.liveState] ?? 'pending'}
                      label={C.memberLiveStateLabel(row.liveState, locale)}
                    />
                    <span className="sw-panel-member-name">@{row.name}</span>
                    {row.lifecycle === 'archived' ? <Badge tone="neutral">{t(C.PANEL_MEMBER_ARCHIVED)}</Badge> : null}
                    <Badge tone="neutral">{C.memberAccessLabel(row.access, locale)}</Badge>
                    {row.model ? (
                      <Badge tone="neutral" mono className="sw-panel-member-model" title={row.model}>
                        {formatModelShortName(row.model)}
                      </Badge>
                    ) : null}
                    {row.doing ? <span className="sw-panel-member-doing" title={row.doing}>{row.doing}</span> : null}
                    {timing ? (
                      <Tooltip content={timing.tooltip} className="sw-timing-tooltip">
                        <span
                          className={`sw-panel-member-elapsed mono tabular-nums${timing.tone === 'warn' ? ' sw-panel-member-elapsed-warn' : ''}`}
                        >
                          {timing.label}
                        </span>
                      </Tooltip>
                    ) : null}
                  </span>
                  <span className="sw-panel-member-activity" title={activityText}>{activityText ?? `#${row.conversationId}`}</span>
                  {row.worktree ? (
                    <span
                      className="sw-panel-member-worktree"
                      title={`${row.worktree.worktreeId}${row.worktree.branch ? ` · ${row.worktree.branch}` : ''}`}
                    >
                      <HelmxIcon name="git-branch" size={11} />
                      <span>{C.panelWorktreeSummary(row.worktree, locale)}</span>
                    </span>
                  ) : null}
                </button>
                {row.worktreeId !== undefined || canAbort ? (
                  <div className="sw-panel-member-actions">
                    {row.worktreeId !== undefined ? (
                      <PluginSlot
                        name="worktree-actions"
                        inline
                        slotProps={{
                          worktreeId: row.worktreeId,
                          ...(row.worktree?.branch !== undefined ? { branch: row.worktree.branch } : {}),
                          nodeId: row.nodeId,
                          parentConversationId: effectiveBoard.group.coordinatorConversationId,
                          mode: 'member',
                        }}
                      />
                    ) : null}
                    {canAbort ? (
                      <Button
                        variant="danger"
                        size="xs"
                        icon="square"
                        className="sw-panel-member-abort"
                        disabled={busyAction !== undefined}
                        onClick={() => onAbortMember(row.name)}
                      >
                        {t(C.ACTION_ABORT)}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface SwarmRetainedWorktreesSectionProps {
  locale: HelmxLocale
  items: NonNullable<SwarmPanelModel['retainedWorktrees']>
  coordinatorConversationId?: number
}

export function SwarmRetainedWorktreesSection(props: SwarmRetainedWorktreesSectionProps): ReactNode {
  const { locale, items, coordinatorConversationId } = props
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">
        <span className="sw-panel-section-title">{t(C.PANEL_RETAINED_TITLE)}</span>
        <Badge tone="warn" className="tabular-nums">{items.length}</Badge>
      </div>
      <ul className="sw-panel-retained">
        {items.map((item) => (
          <li key={item.worktreeId} className="sw-panel-retained-item">
            <HelmxIcon name="git-branch" size={11} />
            <span className="sw-panel-retained-label" title={`${item.path} · ${item.worktreeId}`}>
              {C.panelRetainedSummary(item, locale)}
            </span>
            <span className="sw-panel-retained-actions">
              <PluginSlot
                name="worktree-actions"
                inline
                slotProps={{
                  worktreeId: item.worktreeId,
                  path: item.path,
                  branch: item.branch,
                  nodeId: item.nodeId,
                  ...(coordinatorConversationId !== undefined ? { parentConversationId: coordinatorConversationId } : {}),
                  mode: 'retained',
                }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface SwarmBoardPostsSectionProps {
  locale: HelmxLocale
  conversationId: number
  effectiveBoard: BoardViewDoc
  model: SwarmPanelModel
  historyExpanded: boolean
  highlightedSeq: number | undefined
  jumpBackStack: number[]
  peekState: PostPeekState | undefined
  peekPost: BoardPost | undefined
  peekAnchorRef: MutableRefObject<HTMLElement | null>
  peekLoading: boolean
  peekError: string | undefined
  hasEarlier: boolean
  loadingEarlier: boolean
  readLoading: boolean
  readError: string | undefined
  resolvePostConversationId: (post: { from: string }) => number
  onToggleHistory: () => void
  onJumpBack: () => void
  onDismissJumpBack: () => void
  onLoadEarlier: () => void
  onRetryRead: () => void
  onOpenPeek: (originSeq: number, targetSeq: number, anchorEl: HTMLElement) => void
  onPushPeekRef: (seq: number) => void
  onPopPeekRef: () => void
  onLocateFromPeek: (seq: number) => void
  onRetryPeek: () => void
  onClosePeek: () => void
}

export function SwarmBoardPostsSection(props: SwarmBoardPostsSectionProps): ReactNode {
  const {
    locale, conversationId, effectiveBoard, model, historyExpanded, highlightedSeq, jumpBackStack,
    peekState, peekPost, peekAnchorRef, peekLoading, peekError, hasEarlier, loadingEarlier, readLoading, readError,
    resolvePostConversationId, onToggleHistory, onJumpBack, onDismissJumpBack, onLoadEarlier, onRetryRead,
    onOpenPeek, onPushPeekRef, onPopPeekRef, onLocateFromPeek, onRetryPeek, onClosePeek,
  } = props
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const jumpBackTop = jumpBackStack[jumpBackStack.length - 1]

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">
        <span className="sw-panel-section-title">{t(C.PANEL_ACTIVITY_TITLE)}</span>
        <Button
          variant="ghost"
          size="xs"
          icon={historyExpanded ? 'chevron-up' : 'chevron-down'}
          className="sw-panel-history-toggle"
          aria-expanded={historyExpanded}
          onClick={onToggleHistory}
        >
          {t(historyExpanded ? C.PANEL_HISTORY_COLLAPSE : C.PANEL_HISTORY_TOGGLE)}
        </Button>
      </div>

      {jumpBackTop !== undefined ? (
        <div className="sw-panel-jump-back" role="status">
          <Button variant="ghost" size="xs" icon="arrow-left" className="sw-panel-jump-back-btn" onClick={onJumpBack}>
            <span>{C.jumpBackLabel(jumpBackTop, locale)}</span>
            {jumpBackStack.length > 1 ? <Badge tone="neutral" className="tabular-nums">{jumpBackStack.length}</Badge> : null}
          </Button>
          <IconButton
            variant="ghost"
            size="sm"
            icon="x"
            className="sw-panel-jump-back-clear"
            label={t(C.JUMP_BACK_DISMISS)}
            onClick={onDismissJumpBack}
          />
        </div>
      ) : null}

      {hasEarlier ? (
        <Button
          variant="ghost"
          size="xs"
          icon="chevron-up"
          className="sw-panel-load-earlier"
          disabled={loadingEarlier || readLoading}
          onClick={onLoadEarlier}
        >
          {t(loadingEarlier ? C.PANEL_LOADING_EARLIER : C.PANEL_LOAD_EARLIER)}
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
              <li
                key={post.seq}
                data-post-seq={post.seq}
                className={`sw-panel-post${highlightedSeq === post.seq ? ' sw-panel-post-highlighted' : ''}`}
              >
                <div className="sw-panel-post-head">
                  <Badge tone={postKindBadgeTone(post.kind)}>{C.postKindLabel(post.kind, locale)}</Badge>
                  <PostWakeBadge post={post} locale={locale} />
                  <span className="sw-panel-post-from">
                    {`${post.from === 'coordinator' ? 'coordinator' : `@${post.from}`} -> ${C.panelPostTargets(post)}`}
                  </span>
                  <span className="sw-panel-post-meta">
                    {postTime ? (
                      <Tooltip content={postTime.fullTimestamp} className="sw-timing-tooltip">
                        <span className="sw-panel-post-time mono tabular-nums" aria-label={postTime.fullTimestamp}>
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
                  conversationId={resolvePostConversationId(post)}
                  onRefClick={(refSeq, el) => onOpenPeek(post.seq, refSeq, el)}
                />
                <PostRefButtons refs={refs} locale={locale} onPick={(refSeq, anchor) => onOpenPeek(post.seq, refSeq, anchor)} />
                <PostWorktreeLine snapshot={post.worktreeSnapshot} locale={locale} />
              </li>
            )
          })}
        </ol>
      )}

      {peekState ? (
        <SwarmPostPeekPopover
          peekState={peekState}
          anchorRef={peekAnchorRef}
          post={peekPost}
          conversationId={peekPost ? resolvePostConversationId(peekPost) : conversationId}
          loading={peekLoading && !peekPost}
          error={peekPost ? undefined : peekError}
          onPushRef={onPushPeekRef}
          onBack={onPopPeekRef}
          onLocate={onLocateFromPeek}
          onRetry={onRetryPeek}
          onClose={onClosePeek}
        />
      ) : null}

      {readError ? (
        <Stack direction="horizontal" gap="sm" align="center" className="sw-panel-empty-hint">
          <span>{readError}</span>
          <Button size="xs" icon="rotate-cw" onClick={onRetryRead}>
            {t(C.PANEL_RETRY)}
          </Button>
        </Stack>
      ) : null}
    </div>
  )
}

export interface SwarmCloseGroupDialogProps {
  locale: HelmxLocale
  open: boolean
  closing: boolean
  keepWorktree: boolean
  abortRunning: boolean
  hasActiveWorkingMembers: boolean
  error: string | undefined
  onKeepWorktreeChange: (value: boolean) => void
  onAbortRunningChange: (value: boolean) => void
  onClose: () => void
  onConfirm: () => void
}

export function SwarmCloseGroupDialog(props: SwarmCloseGroupDialogProps): ReactNode {
  const {
    locale, open, closing, keepWorktree, abortRunning, hasActiveWorkingMembers, error,
    onKeepWorktreeChange, onAbortRunningChange, onClose, onConfirm,
  } = props
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent className="modal sw-close-dialog">
            <div className="modal-header">
              <DialogTitle className="modal-title">{t(C.PANEL_CLOSE_DIALOG_TITLE)}</DialogTitle>
            </div>
            <div className="modal-body">
              <DialogDescription className="sw-close-dialog-desc">{t(C.PANEL_CLOSE_DIALOG_DESC)}</DialogDescription>
              <div className="sw-close-dialog-options">
                <Checkbox checked={keepWorktree} onChange={onKeepWorktreeChange} disabled={closing} label={t(C.PANEL_CLOSE_KEEP_WORKTREE)} />
                {hasActiveWorkingMembers ? (
                  <Checkbox checked={abortRunning} onChange={onAbortRunningChange} disabled={closing} label={t(C.PANEL_CLOSE_ABORT_RUNNING)} />
                ) : null}
              </div>
              {error ? <Callout tone="err" title={t(C.PANEL_CLOSE_DIALOG_TITLE)}><p className="sw-panel-error-text">{error}</p></Callout> : null}
            </div>
            <div className="modal-footer sw-close-dialog-actions">
              <Button size="sm" disabled={closing} onClick={onClose}>{t(C.PANEL_CANCEL)}</Button>
              <Button variant="primary" size="sm" pending={closing} className="sw-close-dialog-confirm" onClick={onConfirm}>
                {t(C.PANEL_CLOSE_CONFIRM)}
              </Button>
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
