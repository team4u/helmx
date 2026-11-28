import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { MODEL_TIER_PREFIX, isOrchestratorTier, type HostModelEntry, type ModelTierCatalogEntry } from '@helmx/protocol/browser'
import {
  ComposerModelPickerModeContext,
  type ComposerModelPickerModeRegistration,
} from '../composer-model-modes.js'
import {
  Button,
  HelmxIcon,
  IconButton,
  Kbd,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverHeader,
  PopoverPortal,
  PopoverTrigger,
  SearchBox,
  SegmentedControl,
  useFieldControlProps,
} from '@helmx/ui'
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
// pre-highlighting one would be dishonest). The caller owns the default-chain
// policy and passes the level to display in `activeThinkingLevel` (hosts resolve
// it with `resolveDefaultChainThinkingLevel`); the control only falls back to a
// selected tier's own preset when that level is empty, and converges the result
// the way the kernel clamps, so a tier never displays a level other than the one
// that runs. The control reads no churning context: display copy arrives via the
// `copy` prop (English SDK defaults) and refresh notices via the `onNotice`
// callback.
// ---------------------------------------------------------------------------

const EMPTY_TIERS: ReadonlyArray<ModelTierCatalogEntry> = []
const EMPTY_MODELS: ReadonlyArray<HostModelEntry> = []
const EMPTY_NAV_ITEMS: ReadonlyArray<{ id: string }> = []
const EMPTY_REGISTERED_MODES: readonly ComposerModelPickerModeRegistration[] = Object.freeze([])
const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const getEmptyRegisteredModes = (): readonly ComposerModelPickerModeRegistration[] => EMPTY_REGISTERED_MODES
const DEFAULT_MODE_VALUE = '__default__'

interface ModelPickerHeaderProps {
  query: string
  onQueryChange: (value: string) => void
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  copy: ModelPickerControlCopy
  hasRegisteredModes: boolean
  activeMode: ComposerModelPickerModeRegistration | null
  registeredModes: readonly ComposerModelPickerModeRegistration[]
  onSelectModeKey: (modeKey: string | null) => void
  canRefresh: boolean
  refreshing: boolean
  onRefresh: () => void
}

function ModelPickerHeader({
  query,
  onQueryChange,
  onSearchKeyDown,
  searchInputRef,
  copy,
  hasRegisteredModes,
  activeMode,
  registeredModes,
  onSelectModeKey,
  canRefresh,
  refreshing,
  onRefresh,
}: ModelPickerHeaderProps): ReactNode {
  return (
    <div className="composer-model-header">
      <div className="composer-model-search-bar">
        <SearchBox
          variant="default"
          clearable={false}
          clearOnEscape={false}
          className="search-box composer-model-search-input"
          icon={<HelmxIcon name="search" size={13} />}
          inputRef={searchInputRef}
          ariaLabel={copy.searchAria}
          placeholder={copy.searchPlaceholder}
          value={query}
          onChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
        />
      </div>
      {hasRegisteredModes || canRefresh ? (
        <div className="composer-model-header-actions">
          {hasRegisteredModes ? (
            <div className="composer-model-mode-bar">
              <SegmentedControl
                size="sm"
                aria-label={copy.modeBarAria ?? DEFAULT_MODEL_PICKER_COPY.modeBarAria}
                value={activeMode !== null ? activeMode.key : DEFAULT_MODE_VALUE}
                onValueChange={(nextValue) => {
                  onSelectModeKey(nextValue === DEFAULT_MODE_VALUE ? null : nextValue)
                }}
                items={[
                  {
                    value: DEFAULT_MODE_VALUE,
                    label: copy.defaultModeLabel ?? DEFAULT_MODEL_PICKER_COPY.defaultModeLabel ?? 'Default',
                  },
                  ...registeredModes.map((entry) => ({
                    value: entry.key,
                    label: entry.spec.label,
                  })),
                ]}
              />
            </div>
          ) : null}
          {canRefresh ? (
            <IconButton
              icon={<HelmxIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />}
              variant="ghost"
              size="sm"
              className="composer-model-refresh-btn"
              disabled={refreshing}
              label={copy.refreshCatalog}
              title={copy.refreshCatalog}
              onClick={(e) => {
                e.stopPropagation()
                onRefresh()
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface ModelPickerTierRowProps {
  tier: ModelTierCatalogEntry
  index: number
  isActive: boolean
  isCurrent: boolean
  disabled: boolean
  perModelThinkingLevel?: string
  targetModelLevels?: ReadonlyArray<string>
  copy: ModelPickerControlCopy
  setItemRef: (index: number, node: HTMLElement | null) => void
  onHover: (index: number) => void
  onSelect: (modelId: string, level: string | null) => void
}

function ModelPickerTierRow({
  tier,
  index,
  isActive,
  isCurrent,
  disabled,
  perModelThinkingLevel,
  targetModelLevels,
  copy,
  setItemRef,
  onHover,
  onSelect,
}: ModelPickerTierRowProps): ReactNode {
  const tierRef = `${MODEL_TIER_PREFIX}/${tier.id}`
  const orchestrator = isOrchestratorTier(tier)
  const targetShort = formatModelShortName(tier.model)
  const executorShort = orchestrator ? formatModelShortName(tier.executorModel) : ''
  // The badge shows the level the kernel will actually run for this tier:
  // tier preset > per-model default, converged the way the kernel clamps.
  const rawTierLevel =
    tier.thinkingLevel !== undefined && tier.thinkingLevel !== ''
      ? tier.thinkingLevel
      : (perModelThinkingLevel ?? '').trim()
  const effectiveTierLevels = tier.thinkingLevels ?? targetModelLevels
  const tierSupportsThinking =
    effectiveTierLevels === undefined || effectiveTierLevels.some((level) => level !== 'off')
  const tierPresetBadge =
    rawTierLevel !== '' && tierSupportsThinking
      ? resolveEffectiveThinkingLevel(effectiveTierLevels ?? [rawTierLevel], rawTierLevel)
      : ''
  const titleModel = orchestrator && tier.executorModel !== undefined && tier.executorModel !== ''
    ? `${tier.model} -> ${tier.executorModel}`
    : tier.model
  const subtitle = tier.description || titleModel

  return (
    <div
      ref={(node) => setItemRef(index, node)}
      data-current={isCurrent ? 'true' : undefined}
      className={`popover-item composer-model-row${isActive ? ' popover-item-active' : ''}`}
      onMouseEnter={() => onHover(index)}
    >
      <button
        type="button"
        className="composer-model-row-main"
        title={formatModelPickerCopy(copy.tierRowTitle, { tier: tierRef, model: titleModel })}
        disabled={disabled}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onSelect(tierRef, null)}
      >
        <span className="composer-model-row-name-line">
          <HelmxIcon name={orchestrator ? 'workflow' : 'layers'} size={12} className="composer-model-tier-icon" />
          <span className="mono composer-model-row-name">{tierRef}</span>
          {orchestrator ? (
            <span className="popover-item-meta">
              {' · '}
              {targetShort}
              {' -> '}
              {executorShort}
            </span>
          ) : (
            <span className="popover-item-meta">· {targetShort}</span>
          )}
          {isCurrent ? <HelmxIcon name="check" size={12} className="composer-model-row-check" /> : null}
        </span>
        <span className="popover-item-meta composer-model-row-source">{subtitle}</span>
      </button>
      {orchestrator ? (
        <span className="badge badge-accent">auto</span>
      ) : tierPresetBadge !== '' ? (
        <span className="badge badge-neutral">{tierPresetBadge}</span>
      ) : null}
    </div>
  )
}

interface ModelPickerModelRowProps {
  model: HostModelEntry
  index: number
  isActive: boolean
  isCurrent: boolean
  activeThinkingLevel: string
  showThinkingLevels: boolean
  disabled: boolean
  copy: ModelPickerControlCopy
  setItemRef: (index: number, node: HTMLElement | null) => void
  onHover: (index: number) => void
  onSelect: (modelId: string, level: string | null) => void
}

function ModelPickerModelRow({
  model,
  index,
  isActive,
  isCurrent,
  activeThinkingLevel,
  showThinkingLevels,
  disabled,
  copy,
  setItemRef,
  onHover,
  onSelect,
}: ModelPickerModelRowProps): ReactNode {
  const levels = model.thinkingLevels ?? ['off']
  const rowSupportsThinking = showThinkingLevels && levels.some((level) => level !== 'off')
  // Level highlight only for the effective model's row: for other
  // models the default chain resolves server-side.
  const activeRowLevel = isCurrent ? resolveEffectiveThinkingLevel(levels, activeThinkingLevel) : ''
  const display = formatModelRowDisplay(model)

  return (
    <div
      ref={(node) => setItemRef(index, node)}
      data-current={isCurrent ? 'true' : undefined}
      className={`popover-item composer-model-row${isActive ? ' popover-item-active' : ''}`}
      onMouseEnter={() => onHover(index)}
    >
      <button
        type="button"
        className="composer-model-row-main"
        title={formatModelPickerCopy(copy.rowDefaultTitle, { model: model.id })}
        disabled={disabled}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => onSelect(model.id, null)}
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
              aria-pressed={isCurrent && level === activeRowLevel ? 'true' : undefined}
              title={formatModelPickerCopy(copy.levelChipTitle, { model: model.id, level })}
              onClick={() => onSelect(model.id, level)}
            >
              {level}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  )
}

interface ModelPickerEmptyStateProps {
  catalogUnknown: boolean
  allUnavailable: boolean
  hasItems: boolean
  copy: ModelPickerControlCopy
  onOpenModelsCenter?: () => void
  onClosePopover: () => void
}

function ModelPickerEmptyState({
  catalogUnknown,
  allUnavailable,
  hasItems,
  copy,
  onOpenModelsCenter,
  onClosePopover,
}: ModelPickerEmptyStateProps): ReactNode {
  if (catalogUnknown) {
    return <div className="popover-item composer-model-empty">{copy.catalogUnavailable}</div>
  }
  if (allUnavailable) {
    return (
      <div className="popover-item composer-model-empty">
        <span>{copy.emptyCatalog}</span>
        {onOpenModelsCenter !== undefined ? (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              onClosePopover()
              onOpenModelsCenter()
            }}
          >
            {copy.openModelsCenter}
          </Button>
        ) : null}
      </div>
    )
  }
  if (!hasItems) {
    return <div className="popover-item composer-model-empty">{copy.noMatches}</div>
  }
  return null
}

interface ModelPickerFooterProps {
  hasModeActive: boolean
  activeModeHint: string
  shouldShowReset: boolean
  disabled: boolean
  resetLabel?: string
  resetTitle?: string
  hasNavItems: boolean
  navHint: string
  onResetDefault: () => void
}

function ModelPickerFooter({
  hasModeActive,
  activeModeHint,
  shouldShowReset,
  disabled,
  resetLabel,
  resetTitle,
  hasNavItems,
  navHint,
  onResetDefault,
}: ModelPickerFooterProps): ReactNode {
  if (activeModeHint === '' && !shouldShowReset && !hasNavItems) return null
  return (
    <div className="composer-model-footer" data-mode-active={hasModeActive ? 'true' : undefined}>
      {activeModeHint !== '' ? (
        <span className="composer-model-mode-hint">
          <HelmxIcon name="sparkles" size={11} />
          <span>{activeModeHint}</span>
        </span>
      ) : null}
      {shouldShowReset ? (
        <button
          type="button"
          className="composer-model-reset"
          disabled={disabled}
          onClick={onResetDefault}
          title={resetTitle}
        >
          <HelmxIcon name="rotate-ccw" size={11} />
          <span>{resetLabel}</span>
        </button>
      ) : null}
      {hasNavItems ? <Kbd size="sm" desktopOnly className="popover-kbd-hint">{navHint}</Kbd> : null}
    </div>
  )
}

export type ModelPickerVariant = 'composer' | 'field'
export type ModelPickerSize = 'sm' | 'md'

export interface ModelPickerControlProps {
  /** Currently effective model id (button label, capability lookup, initial highlight). */
  effectiveModel: string | undefined
  /**
   * The thinking level to display, converged against the model's supported list.
   * Empty = no level to show for a concrete model; for a selected `tier/<id>` the
   * tier's own preset is used. Default-chain consumers (global default / Profile
   * binding) pass the chain result from `resolveDefaultChainThinkingLevel`; an
   * explicit conversation override is passed as-is.
   */
  activeThinkingLevel: string
  /**
   * Trigger visual variant:
   * - `'composer'` (default): compact ghost trigger for composer bars;
   * - `'field'`: full-width bordered form trigger matching `<Select>` (32px `md` / 28px `sm`)
   *   and automatically wiring to enclosing `<Field>` via `FieldContext`.
   */
  variant?: ModelPickerVariant
  /** Control height tier for `variant="field"` (default `'md'`: 32px; `'sm'`: 28px). */
  size?: ModelPickerSize
  /** Marks the trigger invalid (`aria-invalid="true"`) with error border styling. */
  invalid?: boolean
  /** Extra class name appended to the root container. */
  className?: string
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
  /** Enable ComposerModelPickerModeContext mode tabs inside the popover (host composer/standby only). */
  enableRegisteredModes?: boolean
  /** Hide inline thinking-level chips (plain model-id config fields, e.g. plugin config format:'model'). */
  showThinkingLevels?: boolean
  /** Include mounted runtime model tiers (`tier/<id>`) at the top of the picker (default `true`; pass `false` when selecting concrete models only). */
  allowTiers?: boolean
  /** Include human-only dual-phase orchestrator tiers (`kind: 'orchestrator'`) when `allowTiers` is enabled (default `false`). */
  allowOrchestratorTiers?: boolean
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
  variant = 'composer',
  size = 'md',
  invalid,
  className,
  fallbackPanel = 'primary',
  resetLabel,
  resetTitle,
  buttonTitle,
  buttonId,
  buttonAriaLabel,
  placeholderLabel,
  copy: copyOverride,
  popoverSide,
  open: openProp,
  onOpenChange,
  showResetDefault = true,
  renderTrigger,
  enableShortcut = true,
  enableRegisteredModes = false,
  showThinkingLevels = true,
  allowTiers = true,
  allowOrchestratorTiers = false,
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
  const modeRegistry = useContext(ComposerModelPickerModeContext)
  const registeredModes = useSyncExternalStore(
    enableRegisteredModes && modeRegistry !== undefined ? modeRegistry.subscribe : NOOP_SUBSCRIBE,
    enableRegisteredModes && modeRegistry !== undefined ? modeRegistry.getModes : getEmptyRegisteredModes,
    getEmptyRegisteredModes,
  )
  const copy: ModelPickerControlCopy = { ...DEFAULT_MODEL_PICKER_COPY, ...copyOverride }
  const models = catalog?.models ?? EMPTY_MODELS
  const catalogUnknown = catalog === undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [activeModeKey, setActiveModeKey] = useState<string | null>(null)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen
  const openRef = useRef(open)
  openRef.current = open
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)): void => {
      const resolved = typeof next === 'function' ? next(openRef.current) : next
      if (!resolved) {
        setActiveModeKey(null)
      }
      if (!isControlled) {
        setUncontrolledOpen(resolved)
      }
      onOpenChange?.(resolved)
    },
    [isControlled, onOpenChange],
  )
  const handlePopoverOpenChange = useCallback(
    (nextOpen: boolean): void => {
      // Trigger clicks and closures always return to default persistent-switch mode.
      setActiveModeKey(null)
      setOpen(nextOpen)
    },
    [setOpen],
  )
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const interactedOutsideRef = useRef(false)
  const mountedRef = useRef(true)
  const refreshGenRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshGenRef.current += 1
    }
  }, [])

  usePanelShortcut(
    rootRef,
    'toggle-model-picker',
    () => {
      if (!enableShortcut) return
      if (disabled || pending) {
        setActiveModeKey(null)
        setOpen(false)
        return
      }
      setActiveModeKey(null)
      setOpen((prev) => !prev)
    },
    fallbackPanel,
  )

  useEffect(() => {
    if (!enableRegisteredModes || modeRegistry === undefined || disabled || pending) return
    return modeRegistry.setOpenMode((modeKey) => {
      const exists = modeRegistry.getModes().some((entry) => entry.key === modeKey)
      if (!exists) return
      setActiveModeKey(modeKey)
      setOpen(true)
    })
  }, [enableRegisteredModes, modeRegistry, disabled, pending, setOpen])

  const activeMode =
    enableRegisteredModes && activeModeKey !== null
      ? (registeredModes.find((entry) => entry.key === activeModeKey) ?? null)
      : null

  useEffect(() => {
    if (!open) {
      setActiveModeKey(null)
    }
  }, [open])

  useEffect(() => {
    if (activeModeKey !== null && activeMode === null) {
      setActiveModeKey(null)
    }
  }, [activeModeKey, activeMode])

  const rawTiers = allowTiers ? (catalog?.modelTiers ?? EMPTY_TIERS) : EMPTY_TIERS
  const { filteredTiers, filteredModels, navItems, syncKey, initialActiveIndex, allUnavailable } = useMemo(() => {
    if (!open) {
      return {
        filteredTiers: EMPTY_TIERS,
        filteredModels: EMPTY_MODELS,
        navItems: EMPTY_NAV_ITEMS,
        syncKey: '',
        initialActiveIndex: -1,
        allUnavailable: false,
      }
    }
    const queryLower = query.toLowerCase()
    const canShowOrchestratorTiers = allowOrchestratorTiers && activeMode === null
    const nextTiers = rawTiers.filter((tier) => {
      if (!tier.available || tier.disabled === true) return false
      if (isOrchestratorTier(tier) && !canShowOrchestratorTiers) return false
      if (queryLower === '') return true
      const tierRef = `${MODEL_TIER_PREFIX}/${tier.id}`
      return (
        tierRef.toLowerCase().includes(queryLower) ||
        tier.model.toLowerCase().includes(queryLower) ||
        (tier.executorModel?.toLowerCase().includes(queryLower) ?? false) ||
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
      rawTiers.every((tier) => !tier.available || tier.disabled === true || (isOrchestratorTier(tier) && !canShowOrchestratorTiers))
    const filteredKeys = nextNavItems.map((item) => item.id).join('|')
    return {
      filteredTiers: nextTiers,
      filteredModels: nextModels,
      navItems: nextNavItems,
      syncKey: `${query}\0${filteredKeys}`,
      initialActiveIndex: initialModelActiveIndex(nextNavItems, query),
      allUnavailable: nextUnavailable,
    }
  }, [open, query, rawTiers, models, allowOrchestratorTiers, activeMode])
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    setQuery('')
    interactedOutsideRef.current = false
  }, [open])

  useEffect(() => {
    setActiveIndex(syncKey === '' ? -1 : initialActiveIndex)
  }, [syncKey, initialActiveIndex])

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
    const gen = ++refreshGenRef.current
    setRefreshing(true)
    try {
      const res = await refreshModels()
      if (!mountedRef.current || gen !== refreshGenRef.current) return
      await onCatalogRefreshed?.()
      if (!mountedRef.current || gen !== refreshGenRef.current) return
      const errors = Object.entries(res?.errors ?? {})
      if (errors.length > 0) {
        notify(`${copy.catalogPartialFailure} — ${errors.map(([p, err]) => `${p}: ${err}`).join('; ')}`, 'warning')
      } else {
        notify(copy.catalogRefreshed, 'info')
      }
    } catch (err) {
      if (!mountedRef.current || gen !== refreshGenRef.current) return
      notify(`${copy.catalogRefreshFailed} — ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      if (mountedRef.current && gen === refreshGenRef.current) {
        setRefreshing(false)
      }
    }
  }

  const applySelection = (model: string | undefined, level: string | null): void => {
    if (model === undefined || model === '') return
    const modeToApply = activeMode
    setActiveModeKey(null)
    setOpen(false)
    if (modeToApply !== null) {
      void modeToApply.spec.onApply({ modelKey: model, thinkingLevel: level ?? '' })
      return
    }
    void onApply(model, level)
  }

  const resetDefault = (): void => {
    setActiveModeKey(null)
    setOpen(false)
    void onResetDefault?.()
  }

  const setItemRef = useCallback((index: number, node: HTMLElement | null): void => {
    itemRefs.current[index] = node
  }, [])

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent?.isComposing === true || event.keyCode === 229) return
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
  }

  const rawShortName = formatModelShortName(effectiveModel)
  const shortName = rawShortName !== '' ? rawShortName : (placeholderLabel ?? copy.defaultLabel)
  const currentModel = effectiveModel !== undefined && effectiveModel !== '' ? models.find((model) => model.id === effectiveModel) : undefined
  const currentTier =
    effectiveModel !== undefined && effectiveModel.startsWith(`${MODEL_TIER_PREFIX}/`)
      ? (catalog?.modelTiers ?? EMPTY_TIERS).find((tier) => `${MODEL_TIER_PREFIX}/${tier.id}` === effectiveModel)
      : undefined
  const currentLevels = currentModel?.thinkingLevels ?? currentTier?.thinkingLevels ?? ['off']
  const supportsThinking = showThinkingLevels && currentLevels.some((level) => level !== 'off')
  // Effective level display: the caller's level, or a selected tier's own preset when
  // that level is empty, converged the way the kernel clamps.
  const displayLevelInput = activeThinkingLevel !== '' ? activeThinkingLevel : (currentTier?.thinkingLevel ?? '')
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, displayLevelInput)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const canRefresh = host.refreshModels !== undefined
  const customTrigger = renderTrigger !== undefined ? renderTrigger({ open, disabled, pending }) : undefined
  const hasCustomTrigger =
    customTrigger !== null && customTrigger !== undefined && customTrigger !== false
  const hasRegisteredModes = enableRegisteredModes && registeredModes.length > 0
  const hideResetForMode = activeMode !== null && activeMode.spec.hideResetDefault !== false
  const shouldShowReset = showResetDefault && onResetDefault !== undefined && !hideResetForMode
  const activeModeHint = activeMode?.spec.hint !== undefined && activeMode.spec.hint !== '' ? activeMode.spec.hint : ''
  const listEffectiveModel = activeMode !== null ? activeMode.spec.effectiveModel : effectiveModel
  const listActiveThinkingLevel = activeMode !== null ? (activeMode.spec.activeThinkingLevel ?? '') : activeThinkingLevel

  const isFieldVariant = variant === 'field'
  const popoverId = useId()
  const resolvedPopoverSide = popoverSide ?? (isFieldVariant ? 'bottom' : 'top')
  const fieldProps = useFieldControlProps({
    id: buttonId,
    required: undefined,
    invalid,
    'aria-invalid': undefined,
    'aria-describedby': undefined,
  })
  const resolvedButtonId = buttonId ?? (isFieldVariant ? fieldProps.id : undefined)
  const resolvedInvalid = isFieldVariant
    ? fieldProps['aria-invalid'] === true || fieldProps['aria-invalid'] === 'true'
    : invalid === true
  const resolvedAriaDescribedBy = isFieldVariant ? fieldProps['aria-describedby'] : undefined
  const isPlaceholder = rawShortName === ''
  const rootClassName = [
    'composer-picker-root',
    isFieldVariant ? 'helmx-model-picker-field' : undefined,
    isFieldVariant && size === 'sm' ? 'helmx-model-picker-sm' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const triggerClassName = isFieldVariant
    ? 'helmx-model-picker-trigger composer-model-button'
    : 'btn btn-ghost btn-sm composer-model-button'
  const labelClassName =
    isFieldVariant && isPlaceholder
      ? 'composer-model-label helmx-model-picker-placeholder'
      : 'composer-model-label'
  const resolvedTriggerAriaLabel =
    buttonAriaLabel ??
    formatModelPickerCopy(copy.buttonAria, {
      model: shortName,
      level: showLevel ? formatModelPickerCopy(copy.levelSuffix, { level: effectiveLevel }) : '',
    })
  const triggerBody = (
    <>
      {pending ? <HelmxIcon name="loader" size={12} className="spin-slow" /> : null}
      <span className={labelClassName}>{shortName}</span>
      {showLevel ? <span className="composer-model-level">· {effectiveLevel}</span> : null}
      <HelmxIcon
        name="chevron-down"
        size={12}
        className={isFieldVariant ? 'helmx-model-picker-chevron' : undefined}
      />
    </>
  )

  return (
    <span className={rootClassName} ref={rootRef}>
      <Popover open={open} onOpenChange={handlePopoverOpenChange}>
        {renderTrigger !== undefined ? (
          hasCustomTrigger ? (
            <PopoverTrigger asChild>{customTrigger}</PopoverTrigger>
          ) : (
            <PopoverAnchor asChild>
              <span className="helmx-model-picker-anchor" aria-hidden="true" />
            </PopoverAnchor>
          )
        ) : isFieldVariant ? (
          <PopoverTrigger asChild>
            <button
              id={resolvedButtonId}
              type="button"
              role="combobox"
              aria-haspopup="dialog"
              aria-controls={popoverId}
              className={triggerClassName}
              disabled={disabled || pending}
              aria-invalid={resolvedInvalid ? true : undefined}
              data-invalid={resolvedInvalid ? 'true' : undefined}
              aria-expanded={open}
              aria-describedby={resolvedAriaDescribedBy}
              aria-label={resolvedTriggerAriaLabel}
              title={buttonTitle}
            >
              {triggerBody}
            </button>
          </PopoverTrigger>
        ) : (
          <PopoverTrigger asChild>
            <button
              id={resolvedButtonId}
              type="button"
              className={triggerClassName}
              disabled={disabled || pending}
              data-invalid={resolvedInvalid ? 'true' : undefined}
              aria-expanded={open}
              aria-describedby={resolvedAriaDescribedBy}
              aria-label={resolvedTriggerAriaLabel}
              title={buttonTitle}
            >
              {triggerBody}
            </button>
          </PopoverTrigger>
        )}
        <PopoverPortal>
          <PopoverContent
            id={popoverId}
            ref={contentRef}
            tabIndex={-1}
            side={resolvedPopoverSide}
            align="start"
            sideOffset={8}
            collisionPadding={12}
            data-mode={activeMode !== null ? 'registered' : 'default'}
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
            <ModelPickerHeader
              query={query}
              onQueryChange={setQuery}
              onSearchKeyDown={handleSearchKeyDown}
              searchInputRef={searchInputRef}
              copy={copy}
              hasRegisteredModes={hasRegisteredModes}
              activeMode={activeMode}
              registeredModes={registeredModes}
              onSelectModeKey={setActiveModeKey}
              canRefresh={canRefresh}
              refreshing={refreshing}
              onRefresh={() => {
                void refreshCatalog()
              }}
            />
            <div className="composer-model-scroll" onMouseLeave={() => setActiveIndex(-1)}>
              {filteredTiers.length > 0 ? (
                <>
                  <PopoverHeader>
                    <span>{copy.tiersHeader}</span>
                  </PopoverHeader>
                  {filteredTiers.map((tier, idx) => (
                    <ModelPickerTierRow
                      key={`${MODEL_TIER_PREFIX}/${tier.id}`}
                      tier={tier}
                      index={idx}
                      isActive={idx === activeIndex}
                      isCurrent={`${MODEL_TIER_PREFIX}/${tier.id}` === listEffectiveModel}
                      disabled={disabled}
                      perModelThinkingLevel={catalog?.modelThinkingLevels?.[tier.model]}
                      targetModelLevels={models.find((m) => m.id === tier.model)?.thinkingLevels}
                      copy={copy}
                      setItemRef={setItemRef}
                      onHover={setActiveIndex}
                      onSelect={applySelection}
                    />
                  ))}
                </>
              ) : null}
              <PopoverHeader>
                <span>{copy.listHeader}</span>
              </PopoverHeader>
              {filteredModels.map((model, modelIdx) => {
                const idx = filteredTiers.length + modelIdx
                return (
                  <ModelPickerModelRow
                    key={model.id}
                    model={model}
                    index={idx}
                    isActive={idx === activeIndex}
                    isCurrent={model.id === listEffectiveModel}
                    activeThinkingLevel={listActiveThinkingLevel}
                    showThinkingLevels={showThinkingLevels}
                    disabled={disabled}
                    copy={copy}
                    setItemRef={setItemRef}
                    onHover={setActiveIndex}
                    onSelect={applySelection}
                  />
                )
              })}
              <ModelPickerEmptyState
                catalogUnknown={catalogUnknown}
                allUnavailable={allUnavailable}
                hasItems={navItems.length > 0}
                copy={copy}
                onOpenModelsCenter={onOpenModelsCenter}
                onClosePopover={() => setOpen(false)}
              />
            </div>
            <ModelPickerFooter
              hasModeActive={activeMode !== null}
              activeModeHint={activeModeHint}
              shouldShowReset={shouldShowReset}
              disabled={disabled}
              resetLabel={resetLabel}
              resetTitle={resetTitle}
              hasNavItems={navItems.length > 0}
              navHint={copy.navHint}
              onResetDefault={resetDefault}
            />
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}
