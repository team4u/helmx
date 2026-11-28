import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  EmptyState,
  HelmxIcon,
  LoadingState,
} from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { isImeComposing } from '../lib/ime.js'
import { activeTargetForPanel, resolveFocusedPanel } from '../lib/panel-focus.js'
import { useLocationTargets } from '../lib/store-context.js'
import { formatModShortcut } from '../shell/shortcuts-model.js'
import { resolveNextOmniboxScope, resolveOmniboxEscapeAction } from './matcher.js'
import { stripOmniboxPrefix } from './omnibox-labels.js'
import { OmniboxFooter } from './OmniboxFooter.js'
import { OmniboxHeader } from './OmniboxHeader.js'
import { OmniboxList } from './OmniboxList.js'
import { OmniboxPreview } from './OmniboxPreview.js'
import { OmniboxScopeBar } from './OmniboxScopeBar.js'
import type { OmniboxScope } from './types.js'
import { useOmniboxCatalog } from './use-omnibox-catalog.js'
import { useOmniboxSearch } from './use-omnibox-search.js'
import { useOmniboxSelection } from './use-omnibox-selection.js'

export interface OmniboxModalProps {
  onClose: () => void
  searchDebounceMs?: number
}

/**
 * Global Omnibox ("Search Everywhere") modal:
 * - 4 scope tabs (`All`, `Pages & Settings`, `Commands`, `Conversations`) cycled via `Tab` / `Shift+Tab`
 * - 0ms synchronous upper zone (centers, sub-tabs, profiles, screens, providers/models, skills, nodes, plugins, core actions, settings panels, config fields, workbench tabs, commands, local conversations)
 * - 200ms single-request asynchronous lower zone (plugin resources + FTS messages) physically isolated from upper selection
 * - Single-entity dedup with `Alt+Enter` / trailing secondary action and `Cmd/Ctrl+Enter` split navigation
 */
export function OmniboxModal({ onClose, searchDebounceMs = 200 }: OmniboxModalProps) {
  const { locale, t } = useWebLocale()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const [scope, setScope] = useState<OmniboxScope>('all')
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

  // Sync mobile soft-keyboard visualViewport height onto `--palette-vvh` so the search bar never gets clipped.
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

  const activeConversationId = useMemo(() => {
    const panel = resolveFocusedPanel(focusedPanel ?? 'primary', splitTarget)
    const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, panel)
    return activeTarget.kind === 'conversation' ? activeTarget.conversationId : undefined
  }, [focusedPanel, primaryTarget, splitTarget])

  const search = useOmniboxSearch({
    inputEl,
    searchDebounceMs,
    locale,
    conversationId: activeConversationId,
  })
  const { setQuery } = search

  const catalog = useOmniboxCatalog({
    onClose,
    query: search.query,
    scope,
    asyncMessages: search.messages,
    asyncPluginHits: search.pluginItems,
  })
  const {
    parsed,
    effectiveScope,
    sections,
    rows,
    scopeCounts,
    scopedPluginCommands,
    previewCmd,
    setPreviewCmd,
    close,
    invokePluginCommand,
    executeItem,
  } = catalog

  const selection = useOmniboxSelection(rows)
  const { selectedIdx, rowIndexById, listRef, resetSelection, moveSelection, handleRowPointerHover } = selection

  const handleQueryChange = useCallback(
    (next: string) => {
      setQuery(next)
      resetSelection()
    },
    [setQuery, resetSelection],
  )

  const handleSelectScope = useCallback(
    (nextScope: OmniboxScope) => {
      setScope(nextScope)
      if (parsed.prefixMode !== null) {
        setQuery(stripOmniboxPrefix(search.query))
      }
      resetSelection()
      inputRef.current?.focus()
    },
    [parsed.prefixMode, resetSelection, search.query, setQuery],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (search.composingRef.current || isImeComposing(e)) return
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const nextScope = resolveNextOmniboxScope(effectiveScope, e.shiftKey ? -1 : 1)
      handleSelectScope(nextScope)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = selectedIdx >= 0 ? rows[selectedIdx] : undefined
      if (row === undefined) return
      const secondary = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && row.secondaryAction !== undefined
      const forceSplit = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      executeItem(row, { forceSplit, secondary })
    }
  }

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    const action = resolveOmniboxEscapeAction({
      isComposing: search.composingRef.current || isImeComposing(event),
      hasPreview: previewCmd !== null,
      query: search.query,
      scope,
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
      return
    }
    if (action === 'reset-scope') {
      event.preventDefault()
      setScope('all')
      resetSelection()
      inputRef.current?.focus()
    }
  }

  const remoteQuery = parsed.searchText
  const isSearchPending =
    remoteQuery !== '' && (search.isComposing || search.searching || search.settledQuery !== remoteQuery)
  const settledCurrentQuery = remoteQuery !== '' && search.settledQuery === remoteQuery

  const degradedMessages: string[] = []
  if (settledCurrentQuery && search.requestFailed) {
    degradedMessages.push(t('modals.omnibox.searchFailed'))
  } else if (settledCurrentQuery) {
    if (search.messagesUnavailable) {
      degradedMessages.push(t('modals.palette.searchUnavailable'))
    }
    if (search.failedPlugins.length > 0) {
      degradedMessages.push(t('modals.omnibox.failedPlugins', { plugins: search.failedPlugins.join(', ') }))
    }
  }

  const previewMatchingCommand = useMemo(
    () =>
      previewCmd !== null
        ? scopedPluginCommands.find(
            (c) => c.pluginId === previewCmd.pluginId && c.spec.id === previewCmd.spec.id,
          )
        : undefined,
    [previewCmd, scopedPluginCommands],
  )

  const selectedRow = selectedIdx >= 0 ? rows[selectedIdx] : undefined
  const activeDescendantId =
    selectedRow !== undefined ? `${listboxId}-opt-${selectedIdx}` : undefined

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
            onCloseAutoFocus={catalog.handleCloseAutoFocus}
          >
            <DialogTitle className="helmx-sr-only">{t('modals.palette.dialogTitle')}</DialogTitle>
            <OmniboxHeader
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

            <OmniboxScopeBar
              effectiveScope={effectiveScope}
              scopeCounts={scopeCounts}
              onSelectScope={handleSelectScope}
            />

            <div className="helmx-modal-body palette-body" ref={listRef}>
              {previewCmd && (
                <OmniboxPreview
                  pluginId={previewCmd.pluginId}
                  spec={previewCmd.spec}
                  matchingCommand={previewMatchingCommand}
                  conversationId={catalog.activeConversation?.id}
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

              {degradedMessages.length > 0 && (
                <div className="callout callout-warn palette-status-notice" role="status">
                  <HelmxIcon name="alert-triangle" size={13} />
                  <span>{degradedMessages.join(' · ')}</span>
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
                        remoteQuery === ''
                          ? t('modals.palette.emptyHint')
                          : degradedMessages.length > 0
                            ? degradedMessages[0]!
                            : t('modals.palette.noResults')
                      }
                    />
                  </div>
                )
              )}

              <OmniboxList
                listboxId={listboxId}
                rows={rows}
                sections={sections}
                searchText={parsed.searchText}
                selectedIdx={selectedIdx}
                rowIndexById={rowIndexById}
                navRowTitle={t('modals.palette.navRowTitle', { modEnter: formatModShortcut('Enter') })}
                background={catalog.background}
                t={t}
                onExecute={executeItem}
                onHover={handleRowPointerHover}
                onJumpScope={handleSelectScope}
              />
            </div>

            <OmniboxFooter
              secondaryActionLabel={selectedRow?.secondaryAction?.label}
              onOpenShortcuts={catalog.openShortcutsModal}
            />
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
