import { useEffect, useRef, useState } from 'react'
import type { LocalizedText, LocaleTranslator } from '@helmx/protocol/browser'
import { HelmxIcon } from '../icons.js'
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from './Popover.js'
import { usePluginClientDataHandles, usePluginClientHost } from '../host-port.js'
import { useModels } from '../conversation-hooks.js'
import { usePluginTranslator } from '../i18n.js'
import { modelPickerCopy, uiCopy } from '../ui-copy.js'
import {
  formatModelRowDisplay,
  formatModelShortName,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
  type HelmxPanel,
} from './model-picker-model.js'

/** LocaleTranslator has no interpolation; shared control copy interpolates `{key}` locally. */
function tr(t: LocaleTranslator, text: LocalizedText, params: Record<string, string | number>): string {
  let out = t(text)
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value))
  }
  return out
}

// ---------------------------------------------------------------------------
// ModelPickerControl (shared by the host composer / standby / config forms and
// plugin clients): model and thinking-level picking in a Radix Popover over the
// host model catalog slice. Each model row carries its thinking levels inline
// on the right: one click on a level chip applies model + level together in a
// single commit; clicking the row body (or Enter in the search) applies the
// model alone so the level follows the default chain (server-authoritative).
// Only the effective model's row shows an active level chip (the default chain
// for other models resolves server-side, so pre-highlighting one would be
// dishonest).
// ---------------------------------------------------------------------------

export interface ModelPickerControlProps {
  /** Currently effective model id (button label, capability lookup, initial highlight). */
  effectiveModel: string | undefined
  /** Current thinking level (converged against the model's supported list). */
  activeThinkingLevel: string
  /** Panel fallback when no `[data-helmx-panel]` ancestor exists. */
  fallbackPanel?: HelmxPanel
  /** Copy for the clear-override button (label and title). */
  resetLabel: string
  resetTitle: string
  /** Trigger button title and disabled state. */
  buttonTitle: string
  /** Optional trigger button id / aria-label / unset placeholder (defaults to composer label). */
  buttonId?: string
  buttonAriaLabel?: string
  placeholderLabel?: string
  /** Popover placement side. */
  popoverSide?: 'top' | 'bottom'
  /** Enable the host Ctrl+L panel shortcut toggle. */
  enableShortcut?: boolean
  /** Hide inline thinking-level chips (plain model-id config fields, e.g. plugin config format:'model'). */
  showThinkingLevels?: boolean
  disabled?: boolean
  pending?: boolean
  /** Owning conversation id (refresh notices; omit outside conversations). */
  conversationId?: number
  /** Apply the candidate model; thinkingLevel null = follow the default chain. */
  onApply: (model: string, thinkingLevel: string | null) => void | Promise<void>
  onResetDefault: () => void | Promise<void>
  onCatalogRefreshed?: () => void | Promise<void>
}

export function ModelPickerControl({
  effectiveModel,
  activeThinkingLevel,
  fallbackPanel = 'primary',
  resetLabel,
  resetTitle,
  buttonTitle,
  buttonId,
  buttonAriaLabel,
  placeholderLabel,
  popoverSide = 'top',
  enableShortcut = true,
  showThinkingLevels = true,
  disabled = false,
  pending = false,
  conversationId,
  onApply,
  onResetDefault,
  onCatalogRefreshed,
}: ModelPickerControlProps) {
  const { unknown: catalogUnknown, models } = useModels()
  const handles = usePluginClientDataHandles()
  const port = usePluginClientHost()
  const t = usePluginTranslator()
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const interactedOutsideRef = useRef(false)

  usePanelShortcut(
    rootRef,
    'toggle-model-picker',
    () => {
      if (!enableShortcut) return
      if (disabled) {
        setOpen(false)
        return
      }
      setOpen((prev) => !prev)
    },
    fallbackPanel,
  )

  const filteredModels = models.filter(
    (model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(query.toLowerCase()),
  )
  const filteredKeys = filteredModels.map((model) => model.id).join('|')
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    setQuery('')
    interactedOutsideRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1)
      return
    }
    setActiveIndex(initialModelActiveIndex(filteredModels, query))
    // filteredKeys precisely expresses changes of the filtered result set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filteredKeys])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const notify = (title: string, tone: 'info' | 'warning' | 'error', body?: string): void => {
    // The port notification channel carries a single message; fold title/body
    // into one line so the diagnostic detail never silently disappears.
    port.notify(body !== undefined && body !== '' ? `${title} — ${body}` : title, tone, conversationId)
  }

  const refreshCatalog = async (): Promise<void> => {
    const refreshModels = handles?.refreshModels
    if (refreshModels === undefined) return
    setRefreshing(true)
    try {
      const res = await refreshModels()
      await onCatalogRefreshed?.()
      const errors = Object.entries(res.errors ?? {})
      if (errors.length > 0) {
        notify(t(modelPickerCopy.catalogPartialFailure), 'warning', errors.map(([p, err]) => `${p}: ${err}`).join('; '))
      } else {
        notify(
          t(modelPickerCopy.catalogRefreshed),
          'info',
          tr(t, modelPickerCopy.catalogCount, { count: res.modelCount }),
        )
      }
    } catch (err) {
      notify(t(modelPickerCopy.catalogRefreshFailed), 'error', err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const applySelection = (model: string | undefined, level: string | null): void => {
    if (model === undefined || model === '') return
    setOpen(false)
    void onApply(model, level)
  }

  const resetDefault = (): void => {
    setOpen(false)
    void onResetDefault()
  }

  const rawShortName = formatModelShortName(effectiveModel)
  const shortName = rawShortName !== '' ? rawShortName : (placeholderLabel ?? t(modelPickerCopy.defaultLabel))
  const currentModel = effectiveModel !== undefined && effectiveModel !== '' ? models.find((model) => model.id === effectiveModel) : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = showThinkingLevels && currentLevels.some((level) => level !== 'off')
  // Effective level display: prefer the actually effective level; when it is
  // not in the model's supported list, fall back to off or the first supported.
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, activeThinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const allUnavailable = models.length > 0 && models.every((model) => !model.available || model.disabled === true)
  const canRefresh = handles?.refreshModels !== undefined

  return (
    <span className="composer-picker-root" ref={rootRef}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={buttonId}
            type="button"
            className="btn btn-ghost btn-sm composer-model-button"
            disabled={disabled || pending}
            aria-expanded={open}
            aria-label={
              buttonAriaLabel ??
              tr(t, modelPickerCopy.buttonAria, {
                model: shortName,
                level: showLevel ? tr(t, modelPickerCopy.levelSuffix, { level: effectiveLevel }) : '',
              })
            }
            title={buttonTitle}
          >
            {pending ? <HelmxIcon name="loader" size={12} className="spin-slow" /> : null}
            <span className="composer-model-label">{shortName}</span>
            {showLevel ? <span className="composer-model-level">· {effectiveLevel}</span> : null}
            <HelmxIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent

            side={popoverSide}
            align="start"
            sideOffset={8}
            className="composer-popover composer-model-popover"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              searchInputRef.current?.focus()
            }}
            onCloseAutoFocus={(event) => {
              if (interactedOutsideRef.current) {
                interactedOutsideRef.current = false
                return
              }
              const textarea = rootRef.current
                ?.closest('.composer-box')
                ?.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
              if (textarea !== null && textarea !== undefined) {
                event.preventDefault()
                textarea.focus()
              }
            }}
            onInteractOutside={() => {
              interactedOutsideRef.current = true
            }}
            onEscapeKeyDown={(event) => {
              // Stop Esc from bubbling to the global double-Esc abort handler
              event.stopPropagation()
            }}
          >
            <button type="button" className="popover-item" disabled={disabled} onClick={resetDefault} title={resetTitle}>
              {resetLabel}
            </button>
            <div className="composer-model-search-bar">
              <div className="search-box composer-model-search-input">
                <HelmxIcon name="search" size={13} />
                <input
                  ref={searchInputRef}
                  aria-label={t(modelPickerCopy.searchAria)}
                  placeholder={t(modelPickerCopy.searchPlaceholder)}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, filteredModels.length, 1))
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, filteredModels.length, -1))
                    } else if (event.key === 'Enter') {
                      const chosen = filteredModels[activeIndex]
                      if (chosen !== undefined) {
                        event.preventDefault()
                        event.stopPropagation()
                        applySelection(chosen.id, null)
                      }
                    }
                  }}
                />
              </div>
              {canRefresh ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm composer-model-refresh-btn"
                  disabled={refreshing}
                  title={t(modelPickerCopy.refreshCatalog)}
                  aria-label={t(modelPickerCopy.refreshCatalog)}
                  onClick={(e) => {
                    e.stopPropagation()
                    void refreshCatalog()
                  }}
                >
                  <HelmxIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />
                </button>
              ) : null}
            </div>
            <div className="composer-model-scroll" onMouseLeave={() => setActiveIndex(-1)}>
              <div className="popover-header">
                <span>{t(modelPickerCopy.listHeader)}</span>
                <span className="kbd-hint popover-kbd-hint">{t(modelPickerCopy.navHint)}</span>
              </div>
              {filteredModels.map((m, idx) => {
                const levels = m.thinkingLevels ?? ['off']
                const rowSupportsThinking = showThinkingLevels && levels.some((level) => level !== 'off')
                const isCurrent = m.id === effectiveModel
                // Level highlight only for the effective model's row: for other
                // models the default chain resolves server-side.
                const activeRowLevel = isCurrent ? resolveEffectiveThinkingLevel(levels, activeThinkingLevel) : ''
                const display = formatModelRowDisplay(m)
                return (
                  <div
                    key={m.id}
                    ref={(node) => {
                      itemRefs.current[idx] = node
                    }}
                    className={`popover-item composer-model-row${idx === activeIndex ? ' popover-item-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <button
                      type="button"
                      className="composer-model-row-main"
                      title={tr(t, modelPickerCopy.rowDefaultTitle, { model: m.id })}
                      disabled={disabled}
                      aria-current={isCurrent ? 'true' : undefined}
                      onClick={() => applySelection(m.id, null)}
                    >
                      <span className="composer-model-row-name-line">
                        <span className="mono composer-model-row-name">{display.name}</span>
                        {isCurrent ? <HelmxIcon name="check" size={12} className="composer-model-row-check" /> : null}
                      </span>
                      <span className="popover-item-meta composer-model-row-source">{display.source}</span>
                    </button>
                    {rowSupportsThinking ? (
                      <span className="segmented-control composer-model-row-levels" role="group" aria-label={t(modelPickerCopy.thinkingHeader)}>
                        {levels.map((level) => (
                          <button
                            key={level}
                            type="button"
                            className="segmented-control-btn composer-model-level-chip"
                            disabled={disabled}
                            aria-pressed={m.id === effectiveModel && level === activeRowLevel ? 'true' : undefined}
                            title={tr(t, modelPickerCopy.levelChipTitle, { model: m.id, level })}
                            onClick={() => applySelection(m.id, level)}
                          >
                            {level}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </div>
                )
              })}
              {catalogUnknown ? (
                <div className="popover-item composer-model-empty">{t(uiCopy.modelCatalogUnavailable)}</div>
              ) : allUnavailable ? (
                <div className="popover-item composer-model-empty">{t(modelPickerCopy.emptyCatalog)}</div>
              ) : filteredModels.length === 0 ? (
                <div className="popover-item composer-model-empty">{t(modelPickerCopy.noMatches)}</div>
              ) : null}
            </div>
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}
