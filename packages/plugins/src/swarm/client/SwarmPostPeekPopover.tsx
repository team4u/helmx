/**
 * Inline peek popover for Swarm board `#seq` references (Fast Refresh compliant).
 */
import type { ReactNode, RefObject } from 'react'
import { Callout, HelmxIcon, Popover, PopoverAnchor, PopoverContent, resolveLocalizedText, usePluginLocale } from '@helmx/plugin-client'
import { extractPostRefs, postKindBadgeClass, type BoardPost } from './board-model.ts'
import * as C from './copy.ts'
import { currentPeekSeq, previousPeekSeq, type PostPeekState } from './model-post-nav.ts'
import { PostBodyText } from './PostBodyText.tsx'

export interface SwarmPostPeekPopoverProps {
  peekState: PostPeekState
  anchorRef: RefObject<HTMLElement | null>
  post: BoardPost | undefined
  loading: boolean
  error: string | undefined
  onPushRef: (seq: number) => void
  onBack: () => void
  onLocate: (seq: number) => void
  onRetry: () => void
  onClose: () => void
}

export function SwarmPostPeekPopover(props: SwarmPostPeekPopoverProps): ReactNode {
  const locale = usePluginLocale()
  const { peekState, anchorRef, post, loading, error, onPushRef, onBack, onLocate, onRetry, onClose } = props
  const targetSeq = currentPeekSeq(peekState)
  const prevSeq = previousPeekSeq(peekState)
  const refs = post ? extractPostRefs(post) : []

  return (
    <Popover open onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        portalled={false} side="top" align="start" sideOffset={6} collisionPadding={12}
        className="sw-peek-popover" aria-label={C.peekRegionAria(targetSeq, locale)}
        onEscapeKeyDown={(e) => { if (prevSeq !== undefined) { e.preventDefault(); onBack() } }}
      >
        <div className="sw-peek-head">
          <div className="sw-peek-head-left">
            {prevSeq !== undefined ? (
              <button type="button" className="btn btn-xs btn-ghost sw-peek-back-btn" aria-label={C.peekBackLabel(prevSeq, locale)} title={C.peekBackLabel(prevSeq, locale)} onClick={onBack}>
                <HelmxIcon name="arrow-left" size={11} /><span className="mono tabular-nums">{`#${prevSeq}`}</span>
              </button>
            ) : null}
            <span className="badge badge-neutral mono tabular-nums sw-peek-seq">{`#${targetSeq}`}</span>
            {post ? (
              <>
                <span className={`badge ${postKindBadgeClass(post.kind)}`}>{C.postKindLabel(post.kind, locale)}</span>
                <span className="sw-peek-from">{`${post.from === 'coordinator' ? 'coordinator' : `@${post.from}`} -> ${C.panelPostTargets(post)}`}</span>
              </>
            ) : null}
          </div>
          <div className="sw-peek-head-actions">
            {post ? (
              <button type="button" className="btn btn-xs btn-ghost sw-peek-locate-btn" onClick={() => onLocate(post.seq)}>
                <HelmxIcon name="corner-down-right" size={11} /><span>{resolveLocalizedText(C.PEEK_LOCATE, locale)}</span>
              </button>
            ) : null}
            <button type="button" className="btn btn-xs btn-ghost btn-icon-sm sw-peek-close-btn" aria-label={resolveLocalizedText(C.PEEK_CLOSE, locale)} title={resolveLocalizedText(C.PEEK_CLOSE, locale)} onClick={onClose}>
              <HelmxIcon name="x" size={12} />
            </button>
          </div>
        </div>

        <div className="sw-peek-body">
          {post ? (
            <>
              <PostBodyText body={post.body} collapsible={false} selfSeq={post.seq} onRefClick={(seq) => onPushRef(seq)} />
              {refs.length > 0 ? (
                <div className="sw-panel-post-refs sw-peek-refs">
                  {refs.map((refSeq) => (
                    <button key={refSeq} type="button" className="sw-panel-post-ref mono tabular-nums" aria-label={C.panelRefJumpLabel(refSeq, locale)} onClick={() => onPushRef(refSeq)}>
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
            </>
          ) : loading ? (
            <div className="loading-state sw-peek-status" role="status">{C.peekLoadingLabel(targetSeq, locale)}</div>
          ) : error ? (
            <Callout tone="err" title={resolveLocalizedText(C.PEEK_LOAD_FAILED, locale)}>
              <p className="sw-panel-error-text">{error}</p>
              <button type="button" className="btn btn-xs" onClick={onRetry}>
                <HelmxIcon name="rotate-cw" size={11} /><span>{resolveLocalizedText(C.PANEL_RETRY, locale)}</span>
              </button>
            </Callout>
          ) : (
            <div className="sw-peek-not-found">{C.peekNotFoundLabel(targetSeq, locale)}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
