import React from 'react'
import { Button } from '@helmx/ui'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../shell/conversation-status-model.js'
import { omniboxGroupLabelKey } from './omnibox-labels.js'
import { OmniboxRow } from './OmniboxRow.js'
import type { DedicatedOmniboxScope, OmniboxItem, OmniboxSection } from './types.js'

export interface OmniboxListProps {
  listboxId: string
  rows: ReadonlyArray<OmniboxItem>
  sections: ReadonlyArray<OmniboxSection>
  searchText: string
  selectedIdx: number
  rowIndexById: ReadonlyMap<string, number>
  navRowTitle: string
  background: ConversationBackgroundIndex
  t: WebMessageTranslator
  onExecute: (item: OmniboxItem, options?: { forceSplit?: boolean; secondary?: boolean }) => void
  onHover: (rowId: string, clientX: number, clientY: number, fromMove: boolean) => void
  onJumpScope: (scope: DedicatedOmniboxScope) => void
}

export function OmniboxList({
  listboxId,
  rows,
  sections,
  searchText,
  selectedIdx,
  rowIndexById,
  navRowTitle,
  background,
  t,
  onExecute,
  onHover,
  onJumpScope,
}: OmniboxListProps): React.JSX.Element | null {
  if (rows.length === 0) return null

  return (
    <div id={listboxId} role="listbox" aria-label={t('modals.palette.resultsAria')} className="palette-listbox">
      {sections.map((section, sectionIdx) => {
        const prevZone = sectionIdx > 0 ? sections[sectionIdx - 1]?.zone : undefined
        const showAsyncDivider = section.zone === 'async' && prevZone !== undefined && prevZone !== 'async'

        return (
          <React.Fragment key={section.key}>
            {showAsyncDivider && <div className="omnibox-zone-divider" role="presentation" />}
            <div
              className="palette-group-header omnibox-section-head"
              role="presentation"
              data-omnibox-section={section.key}
            >
              <span>{t(omniboxGroupLabelKey(section.key))}</span>
              {section.viewAllScope !== undefined && (
                <Button
                  type="button"
                  variant="inline"
                  size="xs"
                  className="omnibox-view-all-btn"
                  onClick={() => onJumpScope(section.viewAllScope!)}
                >
                  {t('modals.omnibox.viewAll', { count: section.totalCount })}
                </Button>
              )}
            </div>
            {section.items.map((item) => {
              const idx = rowIndexById.get(item.id) ?? -1
              const isSelected = idx === selectedIdx
              return (
                <OmniboxRow
                  key={item.id}
                  item={item}
                  idx={idx}
                  isSelected={isSelected}
                  optionId={`${listboxId}-opt-${idx}`}
                  searchText={searchText}
                  navRowTitle={navRowTitle}
                  background={background}
                  t={t}
                  onExecute={onExecute}
                  onHover={onHover}
                />
              )
            })}
          </React.Fragment>
        )
      })}
    </div>
  )
}
