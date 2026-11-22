import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { resolveLocalizedText, type CommandSpec, type ConversationSummary } from '@helmx/protocol/browser'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  SearchBox,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { searchApi } from '../lib/api.js'
import {
  commandActionPluginId,
  commandsForConversation,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { isAbortError } from '../lib/request-manager.js'
import {
  useAuthConnection,
  useConversationBackgroundSlice,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useSidebarCollapsed,
  useStoreActions,
  useThemePreferencesState,
  useWorkbenchState,
} from '../lib/store-context.js'
import type { LocalePreference } from '../lib/types.js'
import {
  activeTargetForPanel,
  isApplePlatform,
  resolveFocusedPanel,
} from '../shell/shortcuts-model.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { ConversationStatusDot } from '../shell/SidebarPrimitives.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import {
  buildPaletteContextCommands,
  buildPaletteNavigationCommands,
  buildPaletteRecentRows,
  buildPaletteUtilityCommands,
} from './command-palette-catalog.js'
import {
  buildPaletteRows,
  resolvePaletteEscapeAction,
  resolveRowNavigation,
  resolveSelectedIndex,
  resolveSnippetHighlightSegments,
  resolveTitleHighlightSegments,
  type HighlightSegment,
  type PaletteGroupKey,
  type PaletteRow,
  type PaletteSearchHit,
  type PaletteSearchHitRow,
} from './command-palette-model.js'

const GROUP_LABEL_KEYS: Record<
  PaletteGroupKey,
  'modals.palette.group.context' | 'modals.palette.group.recent' | 'modals.palette.group.navigation' | 'modals.palette.group.commands'
> = {
  context: 'modals.palette.group.context',
  recent: 'modals.palette.group.recent',
  navigation: 'modals.palette.group.navigation',
  commands: 'modals.palette.group.commands',
}

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

export function CommandPaletteModal({
  onClose,
  searchDebounceMs = 200,
}: {
  onClose: () => void
  searchDebounceMs?: number
}) {
  const conversations = useConversations()
  const { authenticated } = useAuthConnection()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const { workbenchOpen } = useWorkbenchState()
  const sidebarCollapsed = useSidebarCollapsed()
  const { themePreference, localePreference: storeLocalePref, quietNotifyEnabled } = useThemePreferencesState()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const { badgeDocs, pendingBadgeDocs, snapshot: backgroundSnapshot } = useConversationBackgroundSlice()
  const { profiles } = useProfilesSlice()
  const actions = useStoreActions()
  const { locale, t } = useWebLocale()

  const [query, setQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [hits, setHits] = useState<PaletteSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [settledQuery, setSettledQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewCmd, setPreviewCmd] = useState<{ pluginId: string; spec: CommandSpec } | null>(null)
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null)
  const [modalEl, setModalEl] = useState<HTMLDivElement | null>(null)

  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const attachInputRef = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el
    setInputEl(el)
  }, [])
  const listRef = useRef<HTMLDivElement | null>(null)
  const attachModalRef = useCallback((el: HTMLDivElement | null) => {
    setModalEl(el)
  }, [])
  const composingRef = useRef(false)
  const searchGenRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const settledQueryRef = useRef('')
  const ignoreHoverRef = useRef(false)
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    inputEl?.focus()
  }, [inputEl])

  useEffect(() => {
    if (!inputEl) return
    const onCompositionStart = () => {
      composingRef.current = true
      setIsComposing(true)
    }
    const onCompositionEnd = () => {
      composingRef.current = false
      setIsComposing(false)
    }
    inputEl.addEventListener('compositionstart', onCompositionStart)
    inputEl.addEventListener('compositionend', onCompositionEnd)
    return () => {
      inputEl.removeEventListener('compositionstart', onCompositionStart)
      inputEl.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [inputEl])

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

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next)
    setSelectedId(null)
    ignoreHoverRef.current = true
  }, [])

  // FTS5 full-text search: 200ms debounce + AbortController + generation guard + IME deferral.
  useEffect(() => {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null

    const q = query.trim()
    if (q === '') {
      searchGenRef.current += 1
      settledQueryRef.current = ''
      setSettledQuery('')
      setHits([])
      setSearching(false)
      setSearchFailed(false)
      return
    }

    if (isComposing) {
      setSearching(false)
      return
    }

    const gen = ++searchGenRef.current
    setSearching(true)
    setSearchFailed(false)
    if (settledQueryRef.current !== '' && !q.startsWith(settledQueryRef.current)) {
      setHits([])
    }

    const timer = setTimeout(() => {
      const controller = new AbortController()
      searchAbortRef.current = controller
      searchApi
        .query(q, { signal: controller.signal })
        .then((items) => {
          if (gen !== searchGenRef.current || controller.signal.aborted) return
          settledQueryRef.current = q
          setSettledQuery(q)
          setHits(items.slice(0, 8))
          setSearchFailed(false)
          setSearching(false)
        })
        .catch((err: unknown) => {
          if (gen !== searchGenRef.current || controller.signal.aborted || isAbortError(err)) return
          settledQueryRef.current = q
          setSettledQuery(q)
          setHits([])
          setSearchFailed(true)
          setSearching(false)
        })
    }, searchDebounceMs)

    return () => {
      clearTimeout(timer)
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
    }
  }, [query, isComposing, searchDebounceMs])

  const background = backgroundSnapshot.byConversation
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) {
      if (pendingBadgeDocs.has(`${ref.pluginId}/${ref.doc}`)) {
        void actions.ensurePluginDoc(ref.pluginId, ref.doc)
      }
    }
  }, [badgeDocs, pendingBadgeDocs, authenticated, actions.ensurePluginDoc])

  const close = useCallback(() => onClose(), [onClose])

  const activePanel = resolveFocusedPanel(focusedPanel ?? 'primary', splitTarget)
  const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, activePanel)
  const modEnterHint = isApplePlatform() ? '⌘Enter' : 'Ctrl+Enter'
  const navRowTitle = t('modals.palette.navRowTitle', { modEnter: modEnterHint })

  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])

  const paletteProfileId = useMemo(() => {
    let candidate: string | undefined
    if (activeTarget.kind === 'agent') candidate = activeTarget.profileId
    else if (activeTarget.kind === 'conversation') {
      candidate = conversations.find((c) => c.id === activeTarget.conversationId)?.profileId
    }
    if (candidate === undefined) return undefined
    const matched = profiles.find((p) => p.id === candidate)
    if (matched !== undefined && !isHumanSelectableProfile(matched, enabledPluginIds)) return undefined
    return candidate
  }, [activeTarget, conversations, profiles, enabledPluginIds])

  const paletteConversation = useMemo(() => {
    if (activeTarget.kind !== 'conversation') return undefined
    return conversations.find((c) => c.id === activeTarget.conversationId)
  }, [activeTarget, conversations])

  const contextCommands = useMemo(
    () =>
      buildPaletteContextCommands({
        activeTarget,
        activePanel,
        workbenchOpen,
        paletteProfileId,
        splitTarget,
        setWorkbenchOpen: actions.setWorkbenchOpen,
        closeSplit: actions.closeSplit,
        t,
      }),
    [activePanel, activeTarget, actions.closeSplit, actions.setWorkbenchOpen, paletteProfileId, splitTarget, t, workbenchOpen],
  )

  const recentConversationRows = useMemo(
    () => buildPaletteRecentRows(conversations, paletteConversation?.id, background, t),
    [conversations, paletteConversation?.id, background, t],
  )

  const navigationCommands = useMemo(
    () =>
      buildPaletteNavigationCommands({
        profiles,
        enabledPluginIds,
        screens: groupedUi.screens,
        plugins,
        locale,
        t,
      }),
    [profiles, enabledPluginIds, groupedUi.screens, plugins, locale, t],
  )

  const invokePluginCommand = useCallback(
    (cmd: QualifiedCommand) => {
      const actionId = cmd.spec.actionId
      if (!actionId) return
      void actions
        .invokePluginAction(commandActionPluginId(cmd), actionId, cmd.spec.input, paletteConversation?.id)
        .then(() =>
          actions.pushNotice({
            type: 'notification',
            level: 'info',
            title: t('modals.palette.cmdExecuted'),
            body: resolveLocalizedText(cmd.spec.title, locale),
          }),
        )
        .catch((err: unknown) =>
          actions.pushNotice({
            type: 'notification',
            level: 'error',
            title: t('modals.palette.cmdFailed'),
            body: err instanceof Error ? err.message : String(err),
          }),
        )
    },
    [actions, locale, paletteConversation?.id, t],
  )

  const scopedPluginCommands = useMemo(
    () => commandsForConversation(groupedUi.commands, paletteConversation),
    [groupedUi.commands, paletteConversation],
  )

  const localePref: LocalePreference = storeLocalePref ?? 'auto'

  const utilityCommands = useMemo(
    () =>
      buildPaletteUtilityCommands({
        scopedPluginCommands,
        locale,
        sidebarCollapsed,
        themePreference,
        localePref,
        quietNotifyEnabled,
        onPreviewCommand: setPreviewCmd,
        onInvokePluginCommand: invokePluginCommand,
        toggleSidebarCollapsed: actions.toggleSidebarCollapsed,
        toggleTheme: actions.toggleTheme,
        setLocalePreference: actions.setLocalePreference,
        setLocale: actions.setLocale,
        setQuietNotify: actions.setQuietNotify,
        t,
      }),
    [
      scopedPluginCommands,
      locale,
      sidebarCollapsed,
      themePreference,
      localePref,
      quietNotifyEnabled,
      invokePluginCommand,
      actions.toggleSidebarCollapsed,
      actions.toggleTheme,
      actions.setLocalePreference,
      actions.setLocale,
      actions.setQuietNotify,
      t,
    ],
  )

  const makeConversationRow = useCallback(
    (conv: ConversationSummary): PaletteSearchHitRow => ({
      kind: 'search-hit',
      id: `conv:${conv.id}`,
      group: 'recent',
      conv,
      isLocalConversation: true,
      hit: {
        conversationId: conv.id,
        title: conv.title,
        entryId: '',
        snippet: t('modals.palette.convSnippet', { id: conv.id, profileId: conv.profileId }),
      },
    }),
    [t],
  )

  const { sections, rows } = useMemo(
    () =>
      buildPaletteRows({
        query,
        contextCommands,
        recentConversations: recentConversationRows,
        navigationCommands,
        utilityCommands,
        conversations,
        ftsHits: hits,
        makeConversationRow,
      }),
    [
      query,
      contextCommands,
      recentConversationRows,
      navigationCommands,
      utilityCommands,
      conversations,
      hits,
      makeConversationRow,
    ],
  )

  const selectedIdx = useMemo(() => resolveSelectedIndex(rows, selectedId), [rows, selectedId])

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, idx) => map.set(row.id, idx))
    return map
  }, [rows])

  useEffect(() => {
    if (!inputEl) return
    inputEl.setAttribute('role', 'combobox')
    inputEl.setAttribute('aria-autocomplete', 'list')
    inputEl.setAttribute('aria-controls', listboxId)
    inputEl.setAttribute('aria-expanded', rows.length > 0 ? 'true' : 'false')
    if (selectedIdx >= 0 && rows[selectedIdx] !== undefined) {
      inputEl.setAttribute('aria-activedescendant', `${listboxId}-opt-${selectedIdx}`)
    } else {
      inputEl.removeAttribute('aria-activedescendant')
    }
  }, [inputEl, listboxId, rows, selectedIdx])

  const executeRow = useCallback(
    (row: PaletteRow, forceSplit: boolean) => {
      const nav = resolveRowNavigation(row, activePanel, forceSplit)
      if (nav !== null) {
        close()
        const opts =
          nav.split || nav.highlightEntryId !== undefined
            ? {
                ...(nav.split ? { split: true } : {}),
                ...(nav.highlightEntryId !== undefined ? { highlightEntryId: nav.highlightEntryId } : {}),
              }
            : undefined
        actions.openTarget(nav.target, opts)
        return
      }
      if (row.kind === 'command') {
        const isClientPreview = scopedPluginCommands.some(
          (c) => c.spec.client !== undefined && `plugin:${c.pluginId}/${c.spec.id}` === row.id,
        )
        if (isClientPreview) {
          row.run?.()
          return
        }
        close()
        row.run?.()
      }
    },
    [actions, activePanel, close, scopedPluginCommands],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      ignoreHoverRef.current = true
      if (rows.length === 0) return
      const nextIdx = selectedIdx < 0 ? 0 : (selectedIdx + 1) % rows.length
      const nextRow = rows[nextIdx]
      if (nextRow) setSelectedId(nextRow.id)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      ignoreHoverRef.current = true
      if (rows.length === 0) return
      const prevIdx = selectedIdx < 0 ? rows.length - 1 : (selectedIdx - 1 + rows.length) % rows.length
      const prevRow = rows[prevIdx]
      if (prevRow) setSelectedId(prevRow.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = selectedIdx >= 0 ? rows[selectedIdx] : undefined
      if (!row) return
      const forceSplit = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      executeRow(row, forceSplit)
    }
  }

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    const action = resolvePaletteEscapeAction({
      isComposing: composingRef.current || event.isComposing || event.keyCode === 229,
      hasPreview: previewCmd !== null,
      query,
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

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const handleRowPointerHover = (rowId: string, clientX: number, clientY: number, isMove: boolean) => {
    const prev = lastPointerPosRef.current
    if (isMove) {
      if (prev === null || clientX !== prev.x || clientY !== prev.y) {
        lastPointerPosRef.current = { x: clientX, y: clientY }
        ignoreHoverRef.current = false
        setSelectedId(rowId)
      }
      return
    }
    if (!ignoreHoverRef.current) setSelectedId(rowId)
  }

  const trimmedQuery = query.trim()
  const isSearchPending = trimmedQuery !== '' && (isComposing || searching || settledQuery !== trimmedQuery)
  const previewMatchingCommand = useMemo(
    () =>
      previewCmd !== null
        ? scopedPluginCommands.find(
            (c) => c.pluginId === previewCmd.pluginId && c.spec.id === previewCmd.spec.id,
          )
        : undefined,
    [previewCmd, scopedPluginCommands],
  )

  const renderRow = (row: PaletteRow, idx: number) => {
    const isSelected = idx === selectedIdx
    const optionId = `${listboxId}-opt-${idx}`
    if (row.kind === 'command') {
      const isNavigable = row.target !== undefined
      return (
        <button
          key={row.id}
          id={optionId}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={isSelected}
          data-idx={idx}
          title={isNavigable ? navRowTitle : undefined}
          className={`nav-item${isSelected ? ' nav-item-active' : ''}`}
          onClick={(e) => executeRow(row, (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)}
          onMouseEnter={(e) => handleRowPointerHover(row.id, e.clientX, e.clientY, false)}
          onMouseMove={(e) => handleRowPointerHover(row.id, e.clientX, e.clientY, true)}
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
        key={row.id}
        id={optionId}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={isSelected}
        data-idx={idx}
        title={navRowTitle}
        className={`nav-item palette-hit-row${isSelected ? ' nav-item-active' : ''}`}
        onClick={(e) => executeRow(row, (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)}
        onMouseEnter={(e) => handleRowPointerHover(row.id, e.clientX, e.clientY, false)}
        onMouseMove={(e) => handleRowPointerHover(row.id, e.clientX, e.clientY, true)}
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop palette-backdrop">
          <DialogContent
            ref={attachModalRef}
            className="modal palette-modal"
            aria-label={t('modals.palette.dialogTitle')}
            onKeyDown={onKeyDown}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <DialogTitle className="helmx-sr-only">{t('modals.palette.dialogTitle')}</DialogTitle>
            <div className="modal-header palette-header">
              <div className="palette-search-wrap">
                <SearchBox
                  className="search-box palette-search-box"
                  icon={<HelmxIcon name="search" size={15} />}
                  clearable
                  clearLabel={t('modals.palette.clearSearch')}
                  onCleared={() => {
                    setSelectedId(null)
                    inputRef.current?.focus()
                  }}
                  inputRef={attachInputRef}
                  ariaLabel={t('modals.palette.searchAria')}
                  placeholder={t('modals.palette.searchPlaceholder')}
                  value={query}
                  onChange={handleQueryChange}
                />
              </div>
              {searching && (
                <span className="palette-searching" role="status">
                  <HelmxIcon name="loader" size={12} className="spin-slow" />
                  {t('modals.palette.searching')}
                </span>
              )}
              <DialogClose asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs palette-close-btn"
                  aria-label={t('common.close')}
                >
                  <span className="palette-close-desktop badge badge-neutral">{t('modals.palette.escToClose')}</span>
                  <span className="palette-close-mobile">
                    <HelmxIcon name="x" size={13} />
                    <span className="palette-close-mobile-label">{t('common.close')}</span>
                  </span>
                </button>
              </DialogClose>
            </div>

            <div className="modal-body palette-body" ref={listRef}>
              {previewCmd && (
                <div className="palette-preview">
                  <div className="palette-preview-header">
                    <span className="palette-preview-title">
                      {resolveLocalizedText(previewCmd.spec.title, locale)} · {previewCmd.pluginId}
                    </span>
                    <span className="palette-preview-actions">
                      {previewCmd.spec.actionId !== undefined && previewMatchingCommand !== undefined && (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => {
                            close()
                            invokePluginCommand(previewMatchingCommand)
                          }}
                        >
                          {t('modals.palette.runAction')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setPreviewCmd(null)
                          inputRef.current?.focus()
                        }}
                        aria-label={t('modals.palette.closePreview')}
                      >
                        {t('common.collapse')}
                      </button>
                    </span>
                  </div>
                  <PluginUiView
                    pluginId={previewCmd.pluginId}
                    spec={previewCmd.spec}
                    conversationId={paletteConversation?.id}
                    slotProps={paletteConversation !== undefined ? { conversationId: paletteConversation.id } : undefined}
                    label={t('modals.palette.previewLabel', { id: previewCmd.spec.id })}
                  />
                </div>
              )}

              {searchFailed && settledQuery === trimmedQuery && trimmedQuery !== '' && (
                <div className="callout callout-warn palette-status-notice" role="status">
                  <HelmxIcon name="alert-triangle" size={13} />
                  <span>{t('modals.palette.searchUnavailable')}</span>
                </div>
              )}

              {rows.length === 0 && (
                <div className="palette-empty" role="status">
                  {trimmedQuery === ''
                    ? t('modals.palette.emptyHint')
                    : searchFailed && settledQuery === trimmedQuery
                      ? t('modals.palette.searchUnavailable')
                      : isSearchPending
                        ? t('modals.palette.searchingHint')
                        : t('modals.palette.noResults')}
                </div>
              )}

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
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
