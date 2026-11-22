/**
 * Board post body with honest collapse semantics: collapsed shows the existing
 * preview slice and expands to the full stored text (never a fake "expand
 * everything" over truncated data). Both states render through the shared
 * MarkdownText primitive on the host's msg-ai-body typography (same instance
 * of react-markdown + GFM as the timeline; a truncated slice degrades the same
 * way streaming partials do — unclosed fences/tables stay honest previews).
 * When `onRefClick` is provided, `#seq` references in prose become clickable
 * inline triggers for the post peek popover.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useCallback, useMemo, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { MarkdownText, resolveLocalizedText, usePluginLocale } from '@helmx/plugin-client'
import { previewPostBody } from './board-model.ts'
import { SW_BODY_COLLAPSE, SW_BODY_EXPAND } from './copy.ts'
import { linkifyPostRefs, parseSwarmPostHref } from './model-post-nav.ts'

export interface PostBodyTextProps {
  body: string
  collapsible: boolean
  selfSeq?: number
  onRefClick?: (seq: number, anchorEl: HTMLElement) => void
}

export function PostBodyText(props: PostBodyTextProps): ReactNode {
  const locale = usePluginLocale()
  const [expanded, setExpanded] = useState(false)
  const showFull = !props.collapsible || expanded
  const rawText = showFull ? props.body : previewPostBody(props.body)
  const renderedText = useMemo(
    () => (props.onRefClick !== undefined ? linkifyPostRefs(rawText, props.selfSeq) : rawText),
    [rawText, props.selfSeq, props.onRefClick],
  )
  const handleLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (props.onRefClick === undefined) return
      const seq = parseSwarmPostHref(href)
      if (seq === undefined) return
      event.preventDefault()
      props.onRefClick(seq, event.currentTarget)
    },
    [props.onRefClick],
  )

  return (
    <div className="sw-panel-post-body">
      <div className="sw-panel-post-text msg-ai-body">
        <MarkdownText
          text={renderedText}
          onLinkClick={props.onRefClick !== undefined ? handleLinkClick : undefined}
        />
      </div>
      {props.collapsible ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost sw-panel-post-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span>{resolveLocalizedText(expanded ? SW_BODY_COLLAPSE : SW_BODY_EXPAND, locale)}</span>
        </button>
      ) : null}
    </div>
  )
}
