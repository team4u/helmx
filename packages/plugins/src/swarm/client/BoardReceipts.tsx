/**
 * Collapsible timeline receipt cards for swarm:board-report & swarm:board-wakeup (Fast Refresh compliant).
 */
import { useId, useMemo, useState, type ReactNode } from 'react'
import type { TimelineRendererProps } from '@helmx/protocol/browser'
import {
  Badge,
  HelmxIcon,
  IconButton,
  formatCompactTimestamp,
  resolveLocalizedText,
} from '@helmx/ui'
import { MarkdownView, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import {
  formatReceiptSeqRange,
  isReceiptDefaultOpen,
  parseBoardReportMeta,
  parseBoardWakeupMeta,
  postDigestLine,
  postKindBadgeTone,
  selectReceiptLeadPost,
  type BoardReceiptPost,
} from './board-model.ts'
import { SWARM_WORKBENCH_PANEL_ID } from './models.ts'
import * as C from './copy.ts'
import { PostWakeBadge, PostWorktreeLine } from './SwarmPostFragments.tsx'

interface BoardReceiptCardProps {
  audience: 'coordinator' | 'worker'
  conversationId: number | undefined
  title: string
  posts: readonly BoardReceiptPost[]
  fromSeq?: number
  toSeq?: number
  postCount?: number
  truncatedPostsCount?: number
  groupId?: string
  workerName?: string
  activeWorkingMembers?: readonly string[]
  createdAt?: number
}

function formatReceiptActor(
  audience: 'coordinator' | 'worker',
  leadPost: BoardReceiptPost | undefined,
  workerName: string | undefined,
): string | undefined {
  const fromLabel = leadPost
    ? (leadPost.from === 'coordinator' ? 'coordinator' : `@${leadPost.from}`)
    : undefined
  if (audience === 'coordinator') return fromLabel
  if (fromLabel !== undefined && workerName !== undefined) return `${fromLabel} -> @${workerName}`
  if (fromLabel !== undefined) return fromLabel
  return workerName !== undefined ? `@${workerName}` : undefined
}

function BoardReceiptCard(props: BoardReceiptCardProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const {
    audience, conversationId, title, posts, fromSeq, toSeq, postCount,
    truncatedPostsCount, groupId, workerName, activeWorkingMembers, createdAt,
  } = props
  const [open, setOpen] = useState(() => isReceiptDefaultOpen(posts))
  const bodyId = useId()

  const leadPost = useMemo(() => selectReceiptLeadPost(posts, audience), [posts, audience])
  const hasError = posts.some((p) => p.kind === 'blocker')
  const actorText = formatReceiptActor(audience, leadPost, workerName)
  const digest = leadPost ? postDigestLine(leadPost.body, 120) : ''
  const seqRange = formatReceiptSeqRange(fromSeq, toSeq)
  const displayPostCount = postCount ?? (posts.length > 0 ? posts.length : undefined)
  const focusSeq = leadPost?.seq ?? toSeq ?? fromSeq
  const openParams: Record<string, unknown> | undefined =
    groupId !== undefined || focusSeq !== undefined
      ? {
          ...(groupId !== undefined ? { groupId } : {}),
          ...(focusSeq !== undefined ? { postSeq: focusSeq } : {}),
        }
      : undefined
  const toggleLabel = C.swReceiptToggleLabel(actorText ? `${title} · ${actorText}` : title, open, locale)

  return (
    <div className={`trace-entry${hasError ? ' trace-entry-error' : ''}`}>
      <div className={`trace-row sw-receipt-row${hasError ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left sw-receipt-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          onClick={() => setOpen((v) => !v)}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="trace-row-chevron" />
          <HelmxIcon name={audience === 'coordinator' ? 'network' : 'bell'} size={12} />
          <span className="trace-tool-name sw-receipt-title">{title}</span>
          {leadPost ? (
            <Badge tone={postKindBadgeTone(leadPost.kind)} className="sw-receipt-kind">
              {C.postKindLabel(leadPost.kind, locale)}
            </Badge>
          ) : null}
          {actorText ? <span className="sw-receipt-actor mono">{actorText}</span> : null}
          {digest !== '' ? <span className="trace-tool-summary" title={digest}>{digest}</span> : null}
        </button>

        <span className="trace-row-right sw-receipt-right">
          {seqRange !== undefined ? (
            <Badge tone="neutral" className="sw-trace-badge tabular-nums">{seqRange}</Badge>
          ) : null}
          {displayPostCount !== undefined && displayPostCount > 1 ? (
            <span className="tabular-nums">{C.swReceiptCountCompact(displayPostCount, locale)}</span>
          ) : null}
          {createdAt !== undefined ? (
            <span className="trace-duration tabular-nums">{formatCompactTimestamp(createdAt)}</span>
          ) : null}
          <IconButton
            variant="ghost"
            size="xs"
            icon="external-link"
            className="sw-receipt-open-btn"
            label={resolveLocalizedText(C.SW_PILL_OPEN_WORKBENCH, locale)}
            onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_ID, openParams)}
          />
        </span>
      </div>

      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="trace-expanded-body sw-receipt-expanded selectable">
            {truncatedPostsCount !== undefined && truncatedPostsCount > 0 ? (
              <div className="sw-receipt-note">{C.swReceiptTruncatedPosts(truncatedPostsCount, locale)}</div>
            ) : null}
            {posts.length === 0 ? (
              <div className="sw-receipt-note">{resolveLocalizedText(C.SW_RECEIPT_EMPTY, locale)}</div>
            ) : (
              posts.map((post) => {
                const fromText = post.from === 'coordinator' ? 'coordinator' : `@${post.from}`
                const toText = C.panelPostTargets(post)
                return (
                  <div key={post.seq} className="sw-receipt-post">
                    <div className="sw-receipt-post-head">
                      <Badge tone={postKindBadgeTone(post.kind)}>{C.postKindLabel(post.kind, locale)}</Badge>
                      <PostWakeBadge post={post} locale={locale} />
                      <span className="sw-receipt-post-route mono">{`${fromText} -> ${toText}`}</span>
                      <span className="sw-receipt-post-meta">
                        {post.refs.length > 0 ? (
                          <span className="sw-receipt-post-refs mono tabular-nums">
                            {post.refs.map((refSeq) => (
                              <span key={refSeq} className="sw-receipt-post-ref">{`#${refSeq}`}</span>
                            ))}
                          </span>
                        ) : null}
                        <span className="sw-receipt-post-seq mono tabular-nums">{`#${post.seq}`}</span>
                      </span>
                    </div>
                    <MarkdownView
                      className="sw-receipt-post-md"
                      text={post.body}
                      conversationId={conversationId}
                    />
                    {post.bodyTruncated === true ? (
                      <div className="sw-receipt-note">{resolveLocalizedText(C.SW_RECEIPT_BODY_TRUNCATED, locale)}</div>
                    ) : null}
                    <PostWorktreeLine snapshot={post.worktreeSnapshot} locale={locale} />
                  </div>
                )
              })
            )}
            {audience === 'coordinator' && activeWorkingMembers !== undefined && activeWorkingMembers.length > 0 ? (
              <div className="sw-receipt-active-footer">
                {C.swReceiptActiveWorkers(activeWorkingMembers, locale)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function SwarmBoardReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = useMemo(() => parseBoardReportMeta(props), [props])
  const title = resolveLocalizedText(meta.idleCatchup ? C.SW_BOARD_IDLE_TITLE : C.SW_BOARD_MESSAGE_TITLE, locale)
  return (
    <BoardReceiptCard
      audience="coordinator"
      conversationId={props.conversationId ?? ctx.conversationId}
      title={title}
      posts={meta.posts}
      fromSeq={meta.fromSeq}
      toSeq={meta.toSeq}
      postCount={meta.postCount}
      truncatedPostsCount={meta.truncatedPostsCount}
      groupId={meta.groupId}
      activeWorkingMembers={meta.activeWorkingMembers}
      createdAt={meta.createdAt}
    />
  )
}

export function SwarmBoardWakeupCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = useMemo(() => parseBoardWakeupMeta(props), [props])
  const title = resolveLocalizedText(C.SW_BOARD_WAKEUP_TITLE, locale)
  return (
    <BoardReceiptCard
      audience="worker"
      conversationId={props.conversationId ?? ctx.conversationId}
      title={title}
      posts={meta.posts}
      fromSeq={meta.fromSeq}
      toSeq={meta.toSeq}
      postCount={meta.postCount}
      truncatedPostsCount={meta.truncatedPostsCount}
      groupId={meta.groupId}
      workerName={meta.workerName}
      createdAt={meta.createdAt}
    />
  )
}
