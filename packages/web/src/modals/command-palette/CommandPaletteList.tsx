import React, { Fragment } from 'react'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../../shell/conversation-status-model.js'
import { CommandPaletteRowItem } from '../CommandPaletteRows.js'
import type { PaletteRow, PaletteSection } from '../command-palette-model.js'
import { GROUP_LABEL_KEYS } from './palette-group-labels.js'

export interface CommandPaletteListProps {
  listboxId: string
  rows: PaletteRow[]
  sections: PaletteSection[]
  /** 已 trim 的查询：空查询按分组渲染，否则平铺命中行。 */
  trimmedQuery: string
  selectedIdx: number
  rowIndexById: Map<string, number>
  navRowTitle: string
  background: ConversationBackgroundIndex
  t: WebMessageTranslator
  onExecute: (row: PaletteRow, forceSplit: boolean) => void
  onHover: (rowId: string, clientX: number, clientY: number, isMove: boolean) => void
}

/** 结果列表（listbox）：空查询按分组标题 + 行渲染，否则平铺全部行。 */
export function CommandPaletteList({
  listboxId,
  rows,
  sections,
  trimmedQuery,
  selectedIdx,
  rowIndexById,
  navRowTitle,
  background,
  t,
  onExecute,
  onHover,
}: CommandPaletteListProps): React.JSX.Element {
  const renderRow = (row: PaletteRow, idx: number) => (
    <CommandPaletteRowItem
      key={row.id}
      row={row}
      idx={idx}
      isSelected={idx === selectedIdx}
      optionId={`${listboxId}-opt-${idx}`}
      trimmedQuery={trimmedQuery}
      navRowTitle={navRowTitle}
      background={background}
      t={t}
      onExecute={onExecute}
      onHover={onHover}
    />
  )

  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t('modals.palette.resultsAria')}
      className="palette-listbox"
    >
      {trimmedQuery === ''
        ? sections.map((section) => (
            <Fragment key={section.key}>
              <div className="palette-group-header" role="presentation">
                {t(GROUP_LABEL_KEYS[section.key])}
              </div>
              {section.items.map((row) => {
                const idx = rowIndexById.get(row.id) ?? 0
                return renderRow(row, idx)
              })}
            </Fragment>
          ))
        : rows.map((row, idx) => renderRow(row, idx))}
    </div>
  )
}
