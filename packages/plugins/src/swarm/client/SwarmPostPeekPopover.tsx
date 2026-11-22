/**
 * Inline peek popover for Swarm board `#seq` references:
 * - Renders the referenced post in full (no secondary collapse inside the card)
 *   without scrolling the user away from their current reading position;
 * - Supports nested `#seq` navigation inside the popover (`<- #<prev>`) so
 *   chains like `#18 -> #12 -> #5` can be explored and unwound in place;
 * - Honest states: loading (on-demand `board_read` when citing an earlier
 *   uncached post), explicit error with Retry, or explicit "not found" for
 *   non-existent sequence numbers;
 * - "Locate in list" jumps to the post in the main feed and pushes the origin
 *   onto the panel's jump-back stack.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import type { ReactNode, RefObject } from 'react'
import {
  Callout,
  HelmxIcon,
  Popover,
  PopoverAnchor,
  PopoverContent,
  resolveLocalizedText,
  usePluginLocale,
} from '@helmx/plugin-client'
import {
  extractPostRefs,
  postKindBadgeClass,
  type BoardPost,
} from './board-model.ts'
import {
  PANEL_RETRY,
  PEEK_CLOSE,
  PEEK_LOAD_FAILED,
  PEEK_LOCATE,
  panelPostTargets,
  panelRefJumpLabel,
  panelWorktreeSummary,
  peekBackLabel,
  peekLoadingLabel,
  peekNotFoundLabel,
  peekRegionAria,
  postKindLabel,
} from './copy.ts'
import {
  currentPeekSeq,
  previousPeekSeq,
  type PostPeekState,
} from './model-post-nav.ts'
import { PostBodyText } from './PostBodyText.tsx'

export interface SwarmPostPeekPopoverProps {
  peekState: PostPeekState
  anchorRef: RefObject<HTMLElement | null>
  post: BoardPost | undefined
  loading: boolean
  error: string | undefined
  showChannelBadge: boolean
  onPushRef: (seq: number) => void
  onBack: () => void
  onLocate: (seq: number) => void
  onRetry: () => void
  onClose: () => void
}

export function SwarmPostPeekPopover(props: SwarmPostPeekPopoverProps): ReactNode {
  const locale = usePluginLocale()
  const {
    peekState,
    anchorRef,
    post,
    loading,
    error,
    showChannelBadge,
    onPushRef,
    onBack,
    onLocate,
    onRetry,
    onClose,
  } = props
  const targetSeq = currentPeekSeq(peekState)
  const prevSeq = previousPeekSeq(peekState)
  const refs = post !== undefined ? extractPostRefs(post) : []

  return (
    <Popover
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        portalled={false}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="sw-peek-popover"
        aria-label={peekRegionAria(targetSeq, locale)}
        onEscapeKeyDown={(event) => {
          if (prevSeq !== undefined) {
            event.preventDefault()
            onBack()
          }
        }}
      >
        <div className="sw-peek-head">
          <div className="sw-peek-head-left">
            {prevSeq !== undefined ? (
              <button
                type="button"
                className="btn btn-xs btn-ghost sw-peek-back-btn"
                aria-label={peekBackLabel(prevSeq, locale)}
                title={peekBackLabel(prevSeq, locale)}
                onClick={onBack}
              >
                <HelmxIcon name="arrow-left" size={11} />
                <span className="mono tabular-nums">{`#${prevSeq}`}</span>
              </button>
            ) : null}
            <span className="badge badge-neutral mono tabular-nums sw-peek-seq">{`#${targetSeq}`}</span>
            {post !== undefined ? (
              <>
                <span className={`badge ${postKindBadgeClass(post.kind)}`}>{postKindLabel(post.kind, locale)}</span>
                {showChannelBadge && post.channel !== 'main' ? (
                  <span className="badge badge-neutral mono sw-panel-post-channel">#{post.channel}</span>
                ) : null}
                <span className="sw-peek-from">
                  {post.from === 'coordinator' ? 'coordinator' : `@${post.from}`}
                  {' -> '}
                  {panelPostTargets(post)}
                </span>
              </>
            ) : null}
          </div>
          <div className="sw-peek-head-actions">
            {post !== undefined ? (
              <button
                type="button"
                className="btn btn-xs btn-ghost sw-peek-locate-btn"
                onClick={() => onLocate(post.seq)}
              >
                <HelmxIcon name="corner-down-right" size={11} />
                <span>{resolveLocalizedText(PEEK_LOCATE, locale)}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-xs btn-ghost btn-icon-sm sw-peek-close-btn"
              aria-label={resolveLocalizedText(PEEK_CLOSE, locale)}
              title={resolveLocalizedText(PEEK_CLOSE, locale)}
              onClick={onClose}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          </div>
        </div>

        <div className="sw-peek-body">
          {post !== undefined ? (
            <>
              <PostBodyText
                body={post.body}
                collapsible={false}
                selfSeq={post.seq}
                onRefClick={(seq) => onPushRef(seq)}
              />
              {refs.length > 0 ? (
                <div className="sw-panel-post-refs sw-peek-refs">
                  {refs.map((refSeq) => (
                    <button
                      key={refSeq}
                      type="button"
                      className="sw-panel-post-ref mono tabular-nums"
                      aria-label={panelRefJumpLabel(refSeq, locale)}
                      onClick={() => onPushRef(refSeq)}
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
            </>
          ) : loading ? (
            <div className="loading-state sw-peek-status" role="status">
              {peekLoadingLabel(targetSeq, locale)}
            </div>
          ) : error !== undefined ? (
            <Callout tone="err" title={resolveLocalizedText(PEEK_LOAD_FAILED, locale)}>
              <p className="sw-panel-error-text">{error}</p>
              <button type="button" className="btn btn-xs" onClick={onRetry}>
                <HelmxIcon name="rotate-cw" size={11} />
                <span>{resolveLocalizedText(PANEL_RETRY, locale)}</span>
              </button>
            </Callout>
          ) : (
            <div className="sw-peek-not-found">{peekNotFoundLabel(targetSeq, locale)}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
