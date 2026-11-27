/**
 * Inline peek popover for Swarm board `#seq` references (Fast Refresh compliant).
 */
import type { ReactNode, RefObject } from 'react'
import { Badge, Button, Callout, IconButton, LoadingState, Popover, PopoverAnchor, PopoverContent, resolveLocalizedText, usePluginLocale } from '@helmx/plugin-client'
import { extractPostRefs, postKindBadgeTone, type BoardPost } from './board-model.ts'
import * as C from './copy.ts'
import { currentPeekSeq, previousPeekSeq, type PostPeekState } from './model-post-nav.ts'
import { PostBodyText } from './PostBodyText.tsx'
import { PostRefButtons, PostWakeBadge, PostWorktreeLine } from './SwarmPostFragments.tsx'

export interface SwarmPostPeekPopoverProps {
  peekState: PostPeekState
  anchorRef: RefObject<HTMLElement | null>
  post: BoardPost | undefined
  conversationId?: number
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
              <Button variant="ghost" size="xs" icon="arrow-left" className="sw-peek-back-btn" aria-label={C.peekBackLabel(prevSeq, locale)} title={C.peekBackLabel(prevSeq, locale)} onClick={onBack}>
                <span className="mono tabular-nums">{`#${prevSeq}`}</span>
              </Button>
            ) : null}
            <Badge tone="neutral" mono className="tabular-nums sw-peek-seq">{`#${targetSeq}`}</Badge>
            {post ? (
              <>
                <Badge tone={postKindBadgeTone(post.kind)}>{C.postKindLabel(post.kind, locale)}</Badge>
                <PostWakeBadge post={post} locale={locale} />
                <span className="sw-peek-from">{`${post.from === 'coordinator' ? 'coordinator' : `@${post.from}`} -> ${C.panelPostTargets(post)}`}</span>
              </>
            ) : null}
          </div>
          <div className="sw-peek-head-actions">
            {post ? (
              <Button variant="ghost" size="xs" icon="corner-down-right" className="sw-peek-locate-btn" onClick={() => onLocate(post.seq)}>
                {resolveLocalizedText(C.PEEK_LOCATE, locale)}
              </Button>
            ) : null}
            <IconButton variant="ghost" size="sm" icon="x" className="sw-peek-close-btn" label={resolveLocalizedText(C.PEEK_CLOSE, locale)} onClick={onClose} />
          </div>
        </div>

        <div className="sw-peek-body">
          {post ? (
            <>
              <PostBodyText body={post.body} collapsible={false} selfSeq={post.seq} conversationId={props.conversationId} onRefClick={(seq) => onPushRef(seq)} />
              <PostRefButtons refs={refs} locale={locale} className="sw-peek-refs" onPick={(refSeq) => onPushRef(refSeq)} />
              <PostWorktreeLine snapshot={post.worktreeSnapshot} locale={locale} />
            </>
          ) : loading ? (
            <LoadingState label={C.peekLoadingLabel(targetSeq, locale)} className="sw-peek-status" />
          ) : error ? (
            <Callout tone="err" title={resolveLocalizedText(C.PEEK_LOAD_FAILED, locale)}>
              <p className="sw-panel-error-text">{error}</p>
              <Button size="xs" icon="rotate-cw" onClick={onRetry}>
                {resolveLocalizedText(C.PANEL_RETRY, locale)}
              </Button>
            </Callout>
          ) : (
            <div className="sw-peek-not-found">{C.peekNotFoundLabel(targetSeq, locale)}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
