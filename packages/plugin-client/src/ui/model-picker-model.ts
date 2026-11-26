/**
 * Pure display/thinking-level helpers and the host panel-shortcut listener for
 * the shared ModelPickerControl (no component exports, Fast Refresh
 * compliant). The host and plugins share this single implementation; the web
 * app re-exports instead of keeping a private copy.
 */
import { useEffect, useRef } from 'react'
import { MODEL_TIER_PREFIX, parseModelTierRef, type HostModelsSlice } from '@helmx/protocol/browser'

/** Host composer/standby panel identity (the `data-helmx-panel` DOM convention). */
export type HelmxPanel = 'primary' | 'split'

/**
 * Host panel shortcut bridge event: the host global keydown layer dispatches
 * it on window (e.g. Ctrl+L -> `toggle-model-picker`); shared controls listen
 * and answer only for their own panel. This is a host DOM contract, not a
 * plugin ABI.
 */
export const HELMX_SHORTCUT_EVENT = 'helmx:shortcut' as const

export interface HelmxShortcutEventDetail {
  action:
    | 'toggle-model-picker'
    | 'toggle-process-groups'
    | 'toggle-plan-mode'
    | 'toggle-plus-menu'
    | 'focus-composer'
    | 'focus-search'
    | string
  panel: HelmxPanel | 'drawer'
  drawerConversationId?: number
}

/** Short model name for picker trigger buttons (keeps `tier/<id>` explicit; concrete models show the last path segment). */
export function formatModelShortName(modelId: string | undefined): string {
  if (modelId === undefined) return ''
  const trimmed = modelId.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith(`${MODEL_TIER_PREFIX}/`) && trimmed.length > MODEL_TIER_PREFIX.length + 1) {
    return trimmed
  }
  const slashIdx = trimmed.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < trimmed.length - 1) {
    return trimmed.slice(slashIdx + 1)
  }
  return trimmed
}

/** Split a catalog entry into primary display name and secondary source/route label. */
export interface ModelRowDisplay {
  /** Short model name (last path segment, matching the trigger button). */
  name: string
  /** Provider plus optional route/namespace prefix (e.g. `magpie/auto`). */
  source: string
}

/**
 * Split a model catalog entry into primary display name and secondary
 * source/route label: nested route prefixes (e.g. `magpie` + `auto/deepseek`)
 * move into the secondary line so the model name itself stays readable inside
 * narrow rows and alongside inline thinking-level chips.
 */
export function formatModelRowDisplay(model: { provider: string; modelId: string }): ModelRowDisplay {
  const provider = model.provider.trim()
  const rawModelId = model.modelId.trim()
  const slashIdx = rawModelId.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < rawModelId.length - 1) {
    const prefix = rawModelId.slice(0, slashIdx)
    const name = rawModelId.slice(slashIdx + 1)
    const source = prefix !== '' ? (provider !== '' ? `${provider}/${prefix}` : prefix) : provider
    return { name, source }
  }
  return {
    name: rawModelId !== '' ? rawModelId : provider,
    source: provider,
  }
}

/** Canonical thinking-level order, lowest to highest (pi-ai `EXTENDED_THINKING_LEVELS`). */
const THINKING_LEVEL_ORDER: ReadonlyArray<string> = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve the effective thinking level against the model's capability list,
 * mirroring the kernel's convergence (pi-ai `clampThinkingLevel`) so a stale
 * or preset level never displays as a different level than the one that runs:
 * a supported level passes through; an unsupported one clamps to the nearest
 * supported level (searching upward first, then downward); an explicit `'off'`
 * always passes (the kernel omits the reasoning parameter for it). An empty
 * level (unconfigured) displays as `'off'` or the lowest supported level; a
 * model without declared levels yields `''`. The default chain itself stays
 * server-authoritative; this only converges display.
 */
export function resolveEffectiveThinkingLevel(levels: ReadonlyArray<string>, activeLevel: string): string {
  if (levels.length === 0) return ''
  const fallback = levels.includes('off') ? 'off' : (levels[0] ?? '')
  if (activeLevel === '') return fallback
  if (levels.includes(activeLevel) || activeLevel === 'off') return activeLevel
  const requested = THINKING_LEVEL_ORDER.indexOf(activeLevel)
  if (requested < 0) return fallback
  for (let i = requested + 1; i < THINKING_LEVEL_ORDER.length; i++) {
    const candidate = THINKING_LEVEL_ORDER[i]
    if (candidate !== undefined && levels.includes(candidate)) return candidate
  }
  for (let i = requested - 1; i >= 0; i--) {
    const candidate = THINKING_LEVEL_ORDER[i]
    if (candidate !== undefined && levels.includes(candidate)) return candidate
  }
  return fallback
}

/**
 * Thinking level to display for a default-chain model reference (global default,
 * compaction default, Profile binding). A `tier/<id>` selection carries its own
 * preset, which the kernel ranks above the level configured beside the reference
 * (`tier preset > per-model default > Profile/global level`), so the preset wins the
 * display and the configured level only applies to concrete models or tiers without
 * one; the result converges against the target's supported levels. Per-model defaults
 * resolve server-side and are deliberately not folded in (same stance as the picker's
 * row chips). Returns `''` when nothing can be shown honestly: no reference, or a tier
 * whose preset or target capability is still unknown (a concrete reference outside the
 * catalog keeps its configured level as a plain config fact, merely unconverged).
 */
export function resolveDefaultChainThinkingLevel(
  catalog: Pick<HostModelsSlice, 'models' | 'modelTiers'> | undefined,
  modelRef: string | undefined,
  configuredLevel: string | undefined,
): string {
  const ref = modelRef?.trim() ?? ''
  if (ref === '') return ''
  const level = configuredLevel?.trim() ?? ''
  const tierId = parseModelTierRef(ref)
  if (tierId !== undefined) {
    const tier = catalog?.modelTiers?.find((entry) => entry.id === tierId)
    if (tier === undefined || tier.thinkingLevels === undefined) return ''
    return resolveEffectiveThinkingLevel(tier.thinkingLevels, tier.thinkingLevel ?? level)
  }
  const model = catalog?.models.find((entry) => entry.id === ref)
  return model === undefined ? level : resolveEffectiveThinkingLevel(model.thinkingLevels ?? [], level)
}

/**
 * When the picker opens with no search filter, leave activeIndex at -1 so no
 * row carries a forced hover/focus highlight by default; once the user types a
 * query, pre-highlight the first match for instant Enter.
 */
export function initialModelActiveIndex(models: ReadonlyArray<{ id: string }>, query = ''): number {
  if (models.length === 0) return -1
  return query.trim() !== '' ? 0 : -1
}

/** Step the picker highlight index cyclically with up/down arrows. */
export function stepActiveIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

/** Read the owning panel from a DOM ancestor `[data-helmx-panel]`, falling back to `fallback`. */
export function resolveElementPanel(el: Element | null | undefined, fallback: HelmxPanel = 'primary'): HelmxPanel {
  const attr = el?.closest?.('[data-helmx-panel]')?.getAttribute('data-helmx-panel')
  if (attr === 'primary' || attr === 'split') return attr
  return fallback
}

/**
 * Whether the current component should answer a `helmx:shortcut` event for the
 * target panel (a child-conversation drawer must not mis-answer main-panel
 * shortcuts).
 */
export function isShortcutPanelMatch(
  el: Element | null | undefined,
  targetPanel: unknown,
  fallback: HelmxPanel = 'primary',
): boolean {
  if (targetPanel !== 'primary' && targetPanel !== 'split') return false
  if (el?.closest?.('.conversation-drawer') && !el?.closest?.('[data-helmx-panel]')) {
    return false
  }
  return resolveElementPanel(el, fallback) === targetPanel
}

/**
 * Listen for window `helmx:shortcut` host events; the callback fires only when
 * `detail.action` matches and the current DOM's `[data-helmx-panel]` panel
 * matches the event (split views never mis-trigger each other).
 */
export function usePanelShortcut(
  rootRef: { current: Element | null },
  action: HelmxShortcutEventDetail['action'],
  handler: () => void,
  fallback: HelmxPanel = 'primary',
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onShortcut = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<HelmxShortcutEventDetail> | undefined>).detail
      if (detail === undefined || detail === null || detail.action !== action) return
      if (!isShortcutPanelMatch(rootRef.current, detail.panel, fallback)) return
      handlerRef.current()
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
  }, [rootRef, action, fallback])
}

/**
 * Control-internal display copy for ModelPickerControl. The control reads no
 * locale context (stable-render discipline): English SDK defaults live here,
 * and hosts pass their own localized strings via the `copy` prop.
 */
export interface ModelPickerControlCopy {
  /** Trigger aria-label template ({model}/{level}). */
  buttonAria: string
  /** Level suffix inside the trigger aria-label ({level}). */
  levelSuffix: string
  /** Trigger label when no model is effective and no placeholder was provided. */
  defaultLabel: string
  /** Optional segmented tab label for the default persistent model-switch mode. */
  defaultModeLabel?: string
  /** Optional aria-label for the mode switcher segmented bar. */
  modeBarAria?: string
  searchAria: string
  searchPlaceholder: string
  refreshCatalog: string
  /** Optional header for the model tiers section above the model list. */
  tiersHeader: string
  /** Tier row tooltip template ({tier}/{model}). */
  tierRowTitle: string
  listHeader: string
  /** Keyboard hint shown in the popover header. */
  navHint: string
  /** Loaded catalog with zero usable models. */
  emptyCatalog: string
  /** Optional button label to jump to Models & credentials from an empty catalog. */
  openModelsCenter?: string
  /** Search matched nothing. */
  noMatches: string
  /** Level-chip group aria-label. */
  thinkingHeader: string
  /** Row body title ({model}). */
  rowDefaultTitle: string
  /** Level chip title ({model}/{level}). */
  levelChipTitle: string
  /** Catalog facts unknowable (capability absent or first load in flight). */
  catalogUnavailable: string
  catalogPartialFailure: string
  catalogRefreshed: string
  catalogRefreshFailed: string
}

/** English SDK defaults (hosts localize via the copy prop). */
export const DEFAULT_MODEL_PICKER_COPY: Readonly<ModelPickerControlCopy> = Object.freeze({
  buttonAria: 'Model and thinking level: {model}{level}',
  levelSuffix: ' · {level}',
  defaultLabel: 'Default model',
  defaultModeLabel: 'Switch model',
  modeBarAria: 'Model selection mode',
  searchAria: 'Search models',
  searchPlaceholder: 'Search models…',
  refreshCatalog: 'Refresh dynamic model catalog',
  tiersHeader: 'Model tiers',
  tierRowTitle: 'Use {tier} ({model})',
  listHeader: 'Model list',
  navHint: '↑↓ select · Enter confirm',
  emptyCatalog: 'No models available; configure a provider key in Models & credentials first',
  openModelsCenter: 'Configure models',
  noMatches: 'No matching models',
  thinkingHeader: 'Thinking level',
  rowDefaultTitle: 'Use {model} (thinking level follows the default)',
  levelChipTitle: 'Use {model} · thinking {level}',
  catalogUnavailable: 'Model catalog unavailable',
  catalogPartialFailure: 'Some provider catalog refreshes failed',
  catalogRefreshed: 'Model catalog refreshed',
  catalogRefreshFailed: 'Failed to refresh model catalog',
})

/** Interpolate `{key}` placeholders in a copy string. */
export function formatModelPickerCopy(text: string, params: Record<string, string | number>): string {
  let out = text
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value))
  }
  return out
}
