import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MODEL_TIER_PREFIX, type HostModelEntry, type ModelTierCatalogEntry } from '@helmx/protocol/browser'
import { HelmxIcon } from '../icons.js'
import { Popover, PopoverAnchor, PopoverContent, PopoverPortal, PopoverTrigger } from './Popover.js'
import { usePluginClientHost } from '../host-port.js'
import { useHostModels } from '../conversation-hooks.js'
import {
  DEFAULT_MODEL_PICKER_COPY,
  formatModelRowDisplay,
  formatModelShortName,
  formatModelPickerCopy,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
  type HelmxPanel,
  type ModelPickerControlCopy,
} from './model-picker-model.js'

// ---------------------------------------------------------------------------
// ModelPickerControl (shared by the host composer / standby / config forms and
// plugin clients): model and thinking-level picking in a Radix Popover over
// the host model catalog slice (useHostModels stable-handle read, isolated
// from host port value churn). Each model row carries its thinking levels
// inline on the right: one click on a level chip applies model + level
// together in a single commit; clicking the row body (or Enter in the search)
// applies the model alone so the level follows the default chain
// (server-authoritative). Only the effective model's row shows an active
// level chip (the default chain for other models resolves server-side, so
// pre-highlighting one would be dishonest). The control reads no churning
// context: display copy arrives via the `copy` prop (English SDK defaults)
// and refresh notices via the `onNotice` callback.
// ---------------------------------------------------------------------------

const EMPTY_TIERS: ReadonlyArray<ModelTierCatalogEntry> = []
const EMPTY_MODELS: ReadonlyArray<HostModelEntry> = []
const EMPTY_NAV_ITEMS: ReadonlyArray<{ id: string }> = []

export interface ModelPickerControlProps {
  /** Currently effective model id (button label, capability lookup, initial highlight). */
  effectiveModel: string | undefined
  /** Current thinking level (converged against the model's supported list). */
  activeThinkingLevel: string
  /** Panel fallback when no `[data-helmx-panel]` ancestor exists. */
  fallbackPanel?: HelmxPanel
  /** Copy for the clear-override button (label and title). */
  resetLabel?: string
  resetTitle?: string
  /** Trigger button title and disabled state. */
  buttonTitle?: string
  /** Optional trigger button id / aria-label / unset placeholder (defaults to composer label). */
  buttonId?: string
  buttonAriaLabel?: string
  placeholderLabel?: string
  /** Control-internal display copy (defaults to English; hosts pass localized strings). */
  copy?: Partial<ModelPickerControlCopy>
  /** Popover placement side. */
  popoverSide?: 'top' | 'bottom'
  /** Optional controlled open state; omit for uncontrolled behavior. */
  open?: boolean
  /** Optional open-state change callback (works in both controlled and uncontrolled modes). */
  onOpenChange?: (open: boolean) => void
  /** Show the top "reset to default" item inside the popover (default `true`). */
  showResetDefault?: boolean
  /**
   * Optional custom trigger renderer. Return `null` to mount a non-focusable
   * zero-width PopoverAnchor instead of a trigger button.
   */
  renderTrigger?: (state: { open: boolean; disabled: boolean; pending: boolean }) => ReactNode
  /** Enable the host Ctrl+L panel shortcut toggle. */
  enableShortcut?: boolean
  /** Hide inline thinking-level chips (plain model-id config fields, e.g. plugin config format:'model'). */
  showThinkingLevels?: boolean
  /** Include mounted runtime model tiers (`tier/<id>`) at the top of the picker (default `true`; pass `false` when selecting concrete models only). */
  allowTiers?: boolean
  disabled?: boolean
  pending?: boolean
  /**
   * Notice channel for catalog refresh outcomes. Absent = no toast (the
   * refresh action itself still runs and surfaces nothing silently fake);
   * hosts pass their notification pipeline here.
   */
  onNotice?: (message: string, tone: 'info' | 'warning' | 'error') => void
  /** Apply the candidate model; thinkingLevel null = follow the default chain. */
  onApply: (model: string, thinkingLevel: string | null) => void | Promise<void>
  onResetDefault?: () => void | Promise<void>
  onCatalogRefreshed?: () => void | Promise<void>
  /** Optional callback to open Models & credentials when the catalog has zero usable models. */
  onOpenModelsCenter?: () => void
  /**
   * Optional callback invoked when the picker closes via keyboard or selection
   * (not outside click). Return `true` after moving focus explicitly to prevent
   * Radix from restoring focus to the trigger button.
   */
  onReturnFocus?: () => boolean | void
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
  copy: copyOverride,
  popoverSide = 'top',
  open: openProp,
  onOpenChange,
  showResetDefault = true,
  renderTrigger,
  enableShortcut = true,
  showThinkingLevels = true,
  allowTiers = true,
  disabled = false,
  pending = false,
  onNotice,
  onApply,
  onResetDefault,
  onCatalogRefreshed,
  onOpenModelsCenter,
  onReturnFocus,
}: ModelPickerControlProps) {
  // Catalog slice via the stable host port: undefined = capability not
  // injected or first load in flight (explicit unknown state, never a
  // fabricated empty catalog); models: [] = loaded and genuinely empty.
  const catalog = useHostModels()
  const host = usePluginClientHost()
  const copy: ModelPickerControlCopy = { ...DEFAULT_MODEL_PICKER_COPY, ...copyOverride }
  const models = catalog?.models ?? []
  const catalogUnknown = catalog === undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen
  const openRef = useRef(open)
  openRef.current = open
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)): void => {
      const resolved = typeof next === 'function' ? next(openRef.current) : next
      if (!isControlled) {
        setUncontrolledOpen(resolved)
      }
      onOpenChange?.(resolved)
    },
    [isControlled, onOpenChange],
  )
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
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

  const rawTiers = allowTiers ? (catalog?.modelTiers ?? EMPTY_TIERS) : EMPTY_TIERS
  const { filteredTiers, filteredModels, navItems, filteredKeys, allUnavailable } = useMemo(() => {
    if (!open) {
      return {
        filteredTiers: EMPTY_TIERS,
        filteredModels: EMPTY_MODELS,
        navItems: EMPTY_NAV_ITEMS,
        filteredKeys: '',
        allUnavailable: false,
      }
    }
    const queryLower = query.toLowerCase()
    const nextTiers = rawTiers.filter((tier) => {
      if (!tier.available || tier.disabled === true) return false
      if (queryLower === '') return true
      const tierRef = `${MODEL_TIER_PREFIX}/${tier.id}`
      return (
        tierRef.toLowerCase().includes(queryLower) ||
        tier.model.toLowerCase().includes(queryLower) ||
        (tier.description?.toLowerCase().includes(queryLower) ?? false)
      )
    })
    const nextModels = models.filter(
      (model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(queryLower),
    )
    const nextNavItems: Array<{ id: string }> = [
      ...nextTiers.map((tier) => ({ id: `${MODEL_TIER_PREFIX}/${tier.id}` })),
      ...nextModels.map((model) => ({ id: model.id })),
    ]
    const nextUnavailable =
      models.every((model) => !model.available || model.disabled === true) &&
      rawTiers.every((tier) => !tier.available || tier.disabled === true)
    return {
      filteredTiers: nextTiers,
      filteredModels: nextModels,
      navItems: nextNavItems,
      filteredKeys: nextNavItems.map((item) => item.id).join('|'),
      allUnavailable: nextUnavailable,
    }
  }, [open, query, rawTiers, models])
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
    setActiveIndex(initialModelActiveIndex(navItems, query))
    // filteredKeys precisely expresses changes of the filtered result set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filteredKeys])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  const notify = (message: string, tone: 'info' | 'warning' | 'error'): void => {
    onNotice?.(message, tone)
  }

  const refreshCatalog = async (): Promise<void> => {
    const refreshModels = host.refreshModels
    if (refreshModels === undefined) return
    setRefreshing(true)
    try {
      const res = await refreshModels()
      await onCatalogRefreshed?.()
      const errors = Object.entries(res?.errors ?? {})
      if (errors.length > 0) {
        notify(`${copy.catalogPartialFailure} — ${errors.map(([p, err]) => `${p}: ${err}`).join('; ')}`, 'warning')
      } else {
        notify(copy.catalogRefreshed, 'info')
      }
    } catch (err) {
      notify(`${copy.catalogRefreshFailed} — ${err instanceof Error ? err.message : String(err)}`, 'error')
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
    void onResetDefault?.()
  }

  const rawShortName = formatModelShortName(effectiveModel)
  const shortName = rawShortName !== '' ? rawShortName : (placeholderLabel ?? copy.defaultLabel)
  const currentModel = effectiveModel !== undefined && effectiveModel !== '' ? models.find((model) => model.id === effectiveModel) : undefined
  const currentTier =
    effectiveModel !== undefined && effectiveModel.startsWith(`${MODEL_TIER_PREFIX}/`)
      ? (catalog?.modelTiers ?? []).find((tier) => `${MODEL_TIER_PREFIX}/${tier.id}` === effectiveModel)
      : undefined
  const currentLevels = currentModel?.thinkingLevels ?? currentTier?.thinkingLevels ?? ['off']
  const supportsThinking = showThinkingLevels && currentLevels.some((level) => level !== 'off')
  // Effective level display: prefer the actually effective level; when it is
  // not in the model's supported list, fall back to off or the first supported.
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, activeThinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const canRefresh = host.refreshModels !== undefined
  const customTrigger = renderTrigger !== undefined ? renderTrigger({ open, disabled, pending }) : undefined
  const hasCustomTrigger =
    customTrigger !== null && customTrigger !== undefined && customTrigger !== false
  const shouldShowReset = showResetDefault && onResetDefault !== undefined

  return (
    <span className="composer-picker-root" ref={rootRef}>
      <Popover open={open} onOpenChange={setOpen}>
        {renderTrigger !== undefined ? (
          hasCustomTrigger ? (
            <PopoverTrigger asChild>{customTrigger}</PopoverTrigger>
          ) : (
            <PopoverAnchor asChild>
              <span className="helmx-model-picker-anchor" aria-hidden="true" />
            </PopoverAnchor>
          )
        ) : (
          <PopoverTrigger asChild>
            <button
              id={buttonId}
              type="button"
              className="btn btn-ghost btn-sm composer-model-button"
              disabled={disabled || pending}
              aria-expanded={open}
              aria-label={
                buttonAriaLabel ??
                formatModelPickerCopy(copy.buttonAria, {
                  model: shortName,
                  level: showLevel ? formatModelPickerCopy(copy.levelSuffix, { level: effectiveLevel }) : '',
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
        )}
        <PopoverPortal>
          <PopoverContent
            ref={contentRef}
            tabIndex={-1}
            side={popoverSide}
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="composer-popover composer-model-popover"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              const isCoarseTouch =
                typeof window !== 'undefined' &&
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(hover: none) and (pointer: coarse)').matches
              if (isCoarseTouch) {
                contentRef.current?.focus({ preventScroll: true })
              } else {
                searchInputRef.current?.focus({ preventScroll: true })
              }
            }}
            onCloseAutoFocus={(event) => {
              if (interactedOutsideRef.current) {
                interactedOutsideRef.current = false
                return
              }
              if (onReturnFocus?.() === true) {
                event.preventDefault()
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
            {shouldShowReset ? (
              <button type="button" className="popover-item" disabled={disabled} onClick={resetDefault} title={resetTitle}>
                {resetLabel}
              </button>
            ) : null}
            <div className="composer-model-search-bar">
              <div className="search-box composer-model-search-input">
                <HelmxIcon name="search" size={13} />
                <input
                  ref={searchInputRef}
                  aria-label={copy.searchAria}
                  placeholder={copy.searchPlaceholder}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, navItems.length, 1))
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((prev) => stepActiveIndex(prev, navItems.length, -1))
                    } else if (event.key === 'Enter') {
                      const chosen = navItems[activeIndex]
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
                  title={copy.refreshCatalog}
                  aria-label={copy.refreshCatalog}
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
              {filteredTiers.length > 0 ? (
                <>
                  <div className="popover-header">
                    <span>{copy.tiersHeader}</span>
                    <span className="kbd-hint popover-kbd-hint">{copy.navHint}</span>
                  </div>
                  {filteredTiers.map((tier, idx) => {
                    const tierRef = `${MODEL_TIER_PREFIX}/${tier.id}`
                    const isCurrent = tierRef === effectiveModel
                    const targetShort = formatModelShortName(tier.model)
                    return (
                      <div
                        key={tierRef}
                        ref={(node) => {
                          itemRefs.current[idx] = node
                        }}
                        className={`popover-item composer-model-row${idx === activeIndex ? ' popover-item-active' : ''}`}
                        onMouseEnter={() => setActiveIndex(idx)}
                      >
                        <button
                          type="button"
                          className="composer-model-row-main"
                          title={formatModelPickerCopy(copy.tierRowTitle, { tier: tierRef, model: tier.model })}
                          disabled={disabled}
                          aria-current={isCurrent ? 'true' : undefined}
                          onClick={() => applySelection(tierRef, null)}
                        >
                          <span className="composer-model-row-name-line">
                            <span className="mono composer-model-row-name">{tierRef}</span>
                            <span className="popover-item-meta">· {targetShort}</span>
                            {isCurrent ? <HelmxIcon name="check" size={12} className="composer-model-row-check" /> : null}
                          </span>
                          <span className="popover-item-meta composer-model-row-source">
                            {tier.description || tier.model}
                          </span>
                        </button>
                        {tier.thinkingLevel !== undefined && tier.thinkingLevel !== '' ? (
                          <span className="badge badge-neutral">{tier.thinkingLevel}</span>
                        ) : null}
                      </div>
                    )
                  })}
                </>
              ) : null}
              <div className="popover-header">
                <span>{copy.listHeader}</span>
                {filteredTiers.length === 0 ? (
                  <span className="kbd-hint popover-kbd-hint">{copy.navHint}</span>
                ) : null}
              </div>
              {filteredModels.map((m, modelIdx) => {
                const idx = filteredTiers.length + modelIdx
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
                      title={formatModelPickerCopy(copy.rowDefaultTitle, { model: m.id })}
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
                      <span className="segmented-control composer-model-row-levels" role="group" aria-label={copy.thinkingHeader}>
                        {levels.map((level) => (
                          <button
                            key={level}
                            type="button"
                            className="segmented-control-btn composer-model-level-chip"
                            disabled={disabled}
                            aria-pressed={m.id === effectiveModel && level === activeRowLevel ? 'true' : undefined}
                            title={formatModelPickerCopy(copy.levelChipTitle, { model: m.id, level })}
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
                <div className="popover-item composer-model-empty">{copy.catalogUnavailable}</div>
              ) : allUnavailable ? (
                <div className="popover-item composer-model-empty">
                  <span>{copy.emptyCatalog}</span>
                  {onOpenModelsCenter !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => {
                        setOpen(false)
                        onOpenModelsCenter()
                      }}
                    >
                      {copy.openModelsCenter}
                    </button>
                  ) : null}
                </div>
              ) : navItems.length === 0 ? (
                <div className="popover-item composer-model-empty">{copy.noMatches}</div>
              ) : null}
            </div>
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}
