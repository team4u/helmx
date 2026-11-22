/**
 * Plain Markdown text rendering primitive shared by plugins (react-markdown +
 * GFM from the same instance as the host).
 * Exported by @helmx/plugin-client (e.g. the Markdown primitive of
 * builtin:json-render); it contains no host conversation-specific logic such
 * as artifact links — those live in the host MarkdownView.
 */
import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from './artifact-url.js'

export interface MarkdownTextProps {
  text: string
  /** Optional click interceptor for rendered links (call event.preventDefault() to handle in-app). */
  onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void
}

export function MarkdownText({ text, onLinkClick }: MarkdownTextProps): React.JSX.Element {
  const components = useMemo<Components | undefined>(() => {
    if (onLinkClick === undefined) return undefined
    return {
      a({ href, onClick, children, ...rest }) {
        return (
          <a
            {...rest}
            href={href}
            onClick={(event) => {
              onClick?.(event)
              if (!event.defaultPrevented && typeof href === 'string') {
                onLinkClick(href, event)
              }
            }}
          >
            {children}
          </a>
        )
      },
    }
  }, [onLinkClick])

  return (
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform} components={components}>
      {text}
    </Markdown>
  )
}
