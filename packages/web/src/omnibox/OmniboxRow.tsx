import { Fragment, type MouseEvent } from 'react'
import { Badge, Button, HelmxIcon, Kbd } from '@helmx/ui'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import type { ConversationBackgroundIndex } from '../shell/conversation-status-model.js'
import { formatModShortcut } from '../shell/shortcuts-model.js'
import { resolveSnippetHighlightSegments, resolveTitleHighlightSegments } from './matcher.js'
import type { HighlightSegment, OmniboxItem } from './types.js'

function HighlightedText({ segments }: { segments: ReadonlyArray<HighlightSegment> }) {
  return (
    <>
      {segments.map((segment, idx) =>
        segment.highlighted ? (
          <mark key={idx} className="palette-highlight">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={idx}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}

export interface OmniboxRowProps {
  item: OmniboxItem
  idx: number
  isSelected: boolean
  optionId: string
  searchText: string
  navRowTitle: string
  background: ConversationBackgroundIndex
  t: WebMessageTranslator
  onExecute: (item: OmniboxItem, options?: { forceSplit?: boolean; secondary?: boolean }) => void
  onHover: (rowId: string, clientX: number, clientY: number, fromMove: boolean) => void
}

export function OmniboxRow({
  item,
  idx,
  isSelected,
  optionId,
  searchText,
  navRowTitle,
  background,
  t,
  onExecute,
  onHover,
}: OmniboxRowProps) {
  const isNavigable = item.intent.type === 'navigate'
  const hasSubtitle = item.subtitle !== undefined && item.subtitle !== ''
  const hasBreadcrumb = item.breadcrumb !== undefined && item.breadcrumb.length > 0
  const isMessage = item.kind === 'message'
  const showConvStatusDot = item.conv !== undefined || isMessage

  const rowTitle =
    isNavigable && item.secondaryAction !== undefined
      ? t('modals.omnibox.navRowTitleWithSecondary', {
          modEnter: formatModShortcut('Enter'),
          secondary: item.secondaryAction.label,
        })
      : isNavigable
        ? navRowTitle
        : undefined

  const titleSegments = resolveTitleHighlightSegments(item.title, item.titleHighlights, searchText)
  const snippetSegments =
    isMessage && hasSubtitle
      ? resolveSnippetHighlightSegments(item.subtitle!, item.snippetHighlights, searchText)
      : []

  const handlePrimaryClick = (e: MouseEvent<HTMLDivElement>) => {
    const forceSplit = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    onExecute(item, { forceSplit })
  }

  const handleSecondaryClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const forceSplit = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    onExecute(item, { forceSplit, secondary: true })
  }

  return (
    <div
      id={optionId}
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      data-idx={idx}
      data-omnibox-id={item.id}
      data-omnibox-kind={item.kind}
      title={rowTitle}
      className={`nav-item omnibox-row${hasSubtitle ? ' palette-hit-row omnibox-row-multiline' : ''}${isSelected ? ' nav-item-active' : ''}`}
      onClick={handlePrimaryClick}
      onMouseEnter={(e) => onHover(item.id, e.clientX, e.clientY, false)}
      onMouseMove={(e) => onHover(item.id, e.clientX, e.clientY, true)}
    >
      <span className="nav-item-main">
        {showConvStatusDot ? (
          <span className="nav-status-slot">
            {item.conv !== undefined ? (
              <ConversationStatusDot conv={item.conv} background={background.get(item.conv.id)} />
            ) : (
              <HelmxIcon name="message-square" size={14} />
            )}
          </span>
        ) : (
          <HelmxIcon name={item.icon ?? 'arrow-right'} size={14} />
        )}
        <span className="palette-hit-content">
          <span className="omnibox-row-title-line">
            <span className="nav-item-label">
              <HighlightedText segments={titleSegments} />
            </span>
            {hasBreadcrumb && (
              <span className="omnibox-breadcrumb">{item.breadcrumb!.join(' / ')}</span>
            )}
          </span>
          {hasSubtitle && (
            <span className={isMessage ? 'mono selectable palette-hit-snippet' : 'omnibox-subtitle'}>
              {isMessage ? <HighlightedText segments={snippetSegments} /> : item.subtitle}
            </span>
          )}
        </span>
      </span>

      {(item.statusBadge !== undefined ||
        item.metaText !== undefined ||
        item.shortcut !== undefined ||
        item.secondaryAction !== undefined) && (
        <span className="nav-item-meta omnibox-row-meta">
          {item.statusBadge !== undefined && (
            <Badge tone={item.statusBadge.tone ?? 'neutral'}>{item.statusBadge.label}</Badge>
          )}
          {item.metaText !== undefined && (
            <span className="mono tabular-nums">{item.metaText}</span>
          )}
          {item.shortcut !== undefined && <Kbd desktopOnly>{item.shortcut}</Kbd>}
          {item.secondaryAction !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="omnibox-secondary-btn"
              icon={
                item.secondaryAction.icon !== undefined ? (
                  <HelmxIcon name={item.secondaryAction.icon} size={12} />
                ) : undefined
              }
              title={`${item.secondaryAction.label} (Alt+Enter)`}
              aria-label={item.secondaryAction.label}
              onClick={handleSecondaryClick}
            >
              {item.secondaryAction.label}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}
