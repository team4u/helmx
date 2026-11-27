import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle, EmptyState, HelmxIcon, LoadingState } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { isImeComposing } from '../lib/ime.js'
import { formatModShortcut } from '../shell/shortcuts-model.js'
import { resolvePaletteEscapeAction } from './command-palette-model.js'
import { CommandPaletteFooter } from './command-palette/CommandPaletteFooter.js'
import { CommandPaletteHeader } from './command-palette/CommandPaletteHeader.js'
import { CommandPaletteList } from './command-palette/CommandPaletteList.js'
import { CommandPalettePreview } from './command-palette/CommandPalettePreview.js'
import { usePaletteCommands } from './command-palette/use-palette-commands.js'
import { usePaletteSearch } from './command-palette/use-palette-search.js'
import { usePaletteSelection } from './command-palette/use-palette-selection.js'

/**
 * 全局命令面板（居中轻量模态）：FTS 检索、分组命令目录、键盘 / 悬停选中与分层 Esc。
 * 检索、选中与命令装配分别在 ./command-palette/ 下的三个 Hook 中，本组件只负责编排与 DOM 骨架。
 */
export function CommandPaletteModal({
  onClose,
  searchDebounceMs = 200,
}: {
  onClose: () => void
  searchDebounceMs?: number
}) {
  const { locale, t } = useWebLocale()
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null)
  const [modalEl, setModalEl] = useState<HTMLDivElement | null>(null)

  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const attachInputRef = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el
    setInputEl(el)
  }, [])
  const attachModalRef = useCallback((el: HTMLDivElement | null) => {
    setModalEl(el)
  }, [])

  useEffect(() => {
    inputEl?.focus()
  }, [inputEl])

  // 软键盘弹出时按 visualViewport 高度约束面板高度，避免输入框被遮挡。
  useEffect(() => {
    if (!modalEl) return
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const syncViewportHeight = () => {
      modalEl.style.setProperty('--palette-vvh', `${Math.round(vv.height)}px`)
    }
    syncViewportHeight()
    vv.addEventListener('resize', syncViewportHeight)
    vv.addEventListener('scroll', syncViewportHeight)
    return () => {
      vv.removeEventListener('resize', syncViewportHeight)
      vv.removeEventListener('scroll', syncViewportHeight)
      modalEl.style.removeProperty('--palette-vvh')
    }
  }, [modalEl])

  const search = usePaletteSearch(inputEl, searchDebounceMs)
  const { setQuery } = search
  const commands = usePaletteCommands({ onClose, query: search.query, hits: search.hits })
  const selection = usePaletteSelection(commands.rows)
  const { rows, sections, scopedPluginCommands, previewCmd, setPreviewCmd, close, invokePluginCommand } = commands
  const { selectedIdx, rowIndexById, listRef, resetSelection, moveSelection, handleRowPointerHover } = selection

  const handleQueryChange = useCallback(
    (next: string) => {
      setQuery(next)
      resetSelection()
    },
    [setQuery, resetSelection],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (search.composingRef.current || isImeComposing(e)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = selectedIdx >= 0 ? rows[selectedIdx] : undefined
      if (!row) return
      const forceSplit = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      commands.executeRow(row, forceSplit)
    }
  }

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    const action = resolvePaletteEscapeAction({
      isComposing: search.composingRef.current || isImeComposing(event),
      hasPreview: previewCmd !== null,
      query: search.query,
    })
    if (action === 'ignore-ime') {
      event.preventDefault()
      return
    }
    if (action === 'close-preview') {
      event.preventDefault()
      setPreviewCmd(null)
      inputRef.current?.focus()
      return
    }
    if (action === 'clear-query') {
      event.preventDefault()
      handleQueryChange('')
      inputRef.current?.focus()
    }
  }

  const trimmedQuery = search.query.trim()
  const isSearchPending =
    trimmedQuery !== '' && (search.isComposing || search.searching || search.settledQuery !== trimmedQuery)
  const previewMatchingCommand = useMemo(
    () =>
      previewCmd !== null
        ? scopedPluginCommands.find(
            (c) => c.pluginId === previewCmd.pluginId && c.spec.id === previewCmd.spec.id,
          )
        : undefined,
    [previewCmd, scopedPluginCommands],
  )

  const activeDescendantId =
    selectedIdx >= 0 && rows[selectedIdx] !== undefined ? `${listboxId}-opt-${selectedIdx}` : undefined

  const searchUnavailable = search.searchFailed && search.settledQuery === trimmedQuery && trimmedQuery !== ''

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="helmx-modal-backdrop palette-backdrop">
          <DialogContent
            ref={attachModalRef}
            className="helmx-modal palette-modal"
            aria-label={t('modals.palette.dialogTitle')}
            onKeyDown={onKeyDown}
            onEscapeKeyDown={handleEscapeKeyDown}
            onCloseAutoFocus={commands.handleCloseAutoFocus}
          >
            <DialogTitle className="helmx-sr-only">{t('modals.palette.dialogTitle')}</DialogTitle>
            <CommandPaletteHeader
              query={search.query}
              onQueryChange={handleQueryChange}
              searching={search.searching}
              listboxId={listboxId}
              ariaExpanded={rows.length > 0}
              activeDescendantId={activeDescendantId}
              attachInputRef={attachInputRef}
              onCleared={() => {
                resetSelection()
                inputRef.current?.focus()
              }}
            />

            <div className="helmx-modal-body palette-body" ref={listRef}>
              {previewCmd && (
                <CommandPalettePreview
                  pluginId={previewCmd.pluginId}
                  spec={previewCmd.spec}
                  matchingCommand={previewMatchingCommand}
                  conversationId={commands.paletteConversation?.id}
                  locale={locale}
                  t={t}
                  onRun={() => {
                    close()
                    if (previewMatchingCommand !== undefined) invokePluginCommand(previewMatchingCommand)
                  }}
                  onCollapse={() => {
                    setPreviewCmd(null)
                    inputRef.current?.focus()
                  }}
                />
              )}

              {searchUnavailable && (
                <div className="callout callout-warn palette-status-notice" role="status">
                  <HelmxIcon name="alert-triangle" size={13} />
                  <span>{t('modals.palette.searchUnavailable')}</span>
                </div>
              )}

              {rows.length === 0 && (
                isSearchPending ? (
                  <LoadingState
                    label={t('modals.palette.searchingHint')}
                    iconSize={13}
                    className="palette-empty"
                  />
                ) : (
                  <div role="status">
                    <EmptyState
                      compact
                      className="palette-empty"
                      title={
                        trimmedQuery === ''
                          ? t('modals.palette.emptyHint')
                          : searchUnavailable
                            ? t('modals.palette.searchUnavailable')
                            : t('modals.palette.noResults')
                      }
                    />
                  </div>
                )
              )}

              <CommandPaletteList
                listboxId={listboxId}
                rows={rows}
                sections={sections}
                trimmedQuery={trimmedQuery}
                selectedIdx={selectedIdx}
                rowIndexById={rowIndexById}
                navRowTitle={t('modals.palette.navRowTitle', { modEnter: formatModShortcut('Enter') })}
                background={commands.background}
                t={t}
                onExecute={commands.executeRow}
                onHover={handleRowPointerHover}
              />
            </div>

            <CommandPaletteFooter onOpenShortcuts={commands.openShortcutsModal} />
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
