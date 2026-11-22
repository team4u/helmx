/**
 * Collapsible Markdown post body with clickable inline `#seq` reference triggers (Fast Refresh compliant).
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
  const rawText = !props.collapsible || expanded ? props.body : previewPostBody(props.body)
  const renderedText = useMemo(
    () => (props.onRefClick !== undefined ? linkifyPostRefs(rawText, props.selfSeq) : rawText),
    [rawText, props.selfSeq, props.onRefClick],
  )
  const handleLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      const seq = props.onRefClick ? parseSwarmPostHref(href) : undefined
      if (seq === undefined) return
      event.preventDefault()
      props.onRefClick!(seq, event.currentTarget)
    },
    [props.onRefClick],
  )

  return (
    <div className="sw-panel-post-body">
      <div className="sw-panel-post-text msg-ai-body">
        <MarkdownText text={renderedText} onLinkClick={props.onRefClick ? handleLinkClick : undefined} />
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
