/**
 * Highlighted search row and command row subcomponents extracted from CommandPaletteModal.
 */
import { Fragment, type MouseEvent } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import type { ConversationBackgroundIndex } from '../shell/conversation-status-model.js'
import {
  resolveSnippetHighlightSegments,
  resolveTitleHighlightSegments,
  type HighlightSegment,
  type PaletteRow,
} from './command-palette-model.js'

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

export interface CommandPaletteRowItemProps {
  row: PaletteRow
  idx: number
  isSelected: boolean
  optionId: string
  trimmedQuery: string
  navRowTitle: string
  background: ConversationBackgroundIndex
  t: WebMessageTranslator
  onExecute: (row: PaletteRow, forceSplit: boolean) => void
  onHover: (rowId: string, clientX: number, clientY: number, fromMove: boolean) => void
}

export function CommandPaletteRowItem({
  row,
  idx,
  isSelected,
  optionId,
  trimmedQuery,
  navRowTitle,
  background,
  t,
  onExecute,
  onHover,
}: CommandPaletteRowItemProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) =>
    onExecute(row, (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)

  if (row.kind === 'command') {
    const isNavigable = row.target !== undefined
    return (
      <button
        id={optionId}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={isSelected}
        data-idx={idx}
        title={isNavigable ? navRowTitle : undefined}
        className={`nav-item${isSelected ? ' nav-item-active' : ''}`}
        onClick={handleClick}
        onMouseEnter={(e) => onHover(row.id, e.clientX, e.clientY, false)}
        onMouseMove={(e) => onHover(row.id, e.clientX, e.clientY, true)}
      >
        <span className="nav-item-main">
          <HelmxIcon name={row.icon} size={14} />
          <span className="nav-item-label">
            {trimmedQuery ? (
              <HighlightedText segments={resolveTitleHighlightSegments(row.title, trimmedQuery)} />
            ) : (
              row.title
            )}
          </span>
        </span>
        {(row.hint || row.shortcut) && (
          <span className="nav-item-meta">
            {row.hint && <span className="mono">{row.hint}</span>}
            {row.shortcut && <kbd className="kbd-hint">{row.shortcut}</kbd>}
          </span>
        )}
      </button>
    )
  }

  const displayTitle =
    row.hit.title?.trim() ||
    row.conv?.title?.trim() ||
    t('shell.conversationFallback', { id: row.hit.conversationId })
  const rawSnippet =
    row.hit.snippet ||
    (row.conv !== undefined
      ? t('modals.palette.convSnippet', { id: row.hit.conversationId, profileId: row.conv.profileId })
      : '')
  const titleSegments = trimmedQuery
    ? resolveTitleHighlightSegments(displayTitle, trimmedQuery)
    : [{ text: displayTitle, highlighted: false }]
  const snippetSegments =
    trimmedQuery && rawSnippet !== ''
      ? resolveSnippetHighlightSegments(
          rawSnippet,
          row.isLocalConversation ? undefined : row.hit.highlights,
          trimmedQuery,
        )
      : rawSnippet !== ''
        ? [{ text: rawSnippet, highlighted: false }]
        : []

  return (
    <button
      id={optionId}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      data-idx={idx}
      title={navRowTitle}
      className={`nav-item palette-hit-row${isSelected ? ' nav-item-active' : ''}`}
      onClick={handleClick}
      onMouseEnter={(e) => onHover(row.id, e.clientX, e.clientY, false)}
      onMouseMove={(e) => onHover(row.id, e.clientX, e.clientY, true)}
    >
      <span className="nav-item-main">
        <span className="nav-status-slot">
          {row.conv !== undefined ? (
            <ConversationStatusDot conv={row.conv} background={background.get(row.conv.id)} />
          ) : (
            <HelmxIcon name="message-square" size={14} />
          )}
        </span>
        <span className="palette-hit-content">
          <span className="nav-item-label">
            <HighlightedText segments={titleSegments} />
          </span>
          {snippetSegments.length > 0 && (
            <span className="mono selectable palette-hit-snippet">
              <HighlightedText segments={snippetSegments} />
            </span>
          )}
        </span>
      </span>
      <span className="nav-item-meta tabular-nums">#{row.hit.conversationId}</span>
    </button>
  )
}
