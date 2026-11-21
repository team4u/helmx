/**
 * Pure display/thinking-level helpers and the host panel-shortcut listener for
 * the shared ModelPickerControl (no component exports, Fast Refresh
 * compliant). The host and plugins share this single implementation; the web
 * app re-exports instead of keeping a private copy.
 */
import { useEffect, useRef } from 'react'

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
  action: 'toggle-model-picker' | 'toggle-process-groups' | string
  panel: HelmxPanel
}

/** Short model name for picker trigger buttons (last path segment of the canonical id). */
export function formatModelShortName(modelId: string | undefined): string {
  if (modelId === undefined) return ''
  const trimmed = modelId.trim()
  if (trimmed === '') return ''
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

/**
 * Resolve the effective thinking level against the model's capability list
 * (falling back to off or the first supported level by default). The default
 * chain itself stays server-authoritative; this only converges display.
 */
export function resolveEffectiveThinkingLevel(levels: ReadonlyArray<string>, activeLevel: string): string {
  const fallback = levels.includes('off') ? 'off' : (levels[0] ?? '')
  return levels.includes(activeLevel) ? activeLevel : fallback
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
