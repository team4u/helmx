/**
 * Decoupled UI locale context & translation helpers for `@helmx/ui` primitives.
 *
 * - `useUiLocale()` resolves the active UI locale: when `<UiLocaleProvider>`
 *   supplies a reactive `(subscribe, getLocale)` pair, subscribes strictly via
 *   `useSyncExternalStore` so unrelated host streaming frames never re-render
 *   UI controls (`Select`, `SearchBox`, `CopyButton`, `ViewBoundary`, etc.);
 *   otherwise falls back cleanly to a static `locale` prop or
 *   `DEFAULT_HELMX_LOCALE` (standalone / SSR safe);
 * - `useUiTranslator()` returns a referentially stable minimal translator bound
 *   to that locale;
 * - Pure locale essentials from `@helmx/protocol/browser` are re-exported so
 *   consumers and compiled plugin clients can resolve localized copy without
 *   importing `@helmx/protocol` directly.
 *
 * Pure `.ts` module (Fast Refresh friendly).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import {
  DEFAULT_HELMX_LOCALE,
  createLocaleTranslator,
  type HelmxLocale,
  type LocaleTranslator,
} from '@helmx/protocol/browser'

export interface UiLocaleStore {
  readonly subscribe?: (listener: () => void) => () => void
  readonly getLocale?: () => HelmxLocale | undefined
  readonly locale?: HelmxLocale
}

export const UiLocaleContext = createContext<UiLocaleStore | null>(null)

const NOOP_UNSUBSCRIBE = (): void => {}

/** Resolve the active UI locale via reactive store subscription, static provider locale, or `DEFAULT_HELMX_LOCALE`. */
export function useUiLocale(): HelmxLocale {
  const source = useContext(UiLocaleContext)
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      source?.subscribe !== undefined ? source.subscribe(listener) : NOOP_UNSUBSCRIBE,
    [source],
  )
  const getSnapshot = useCallback(
    (): HelmxLocale | undefined =>
      source?.getLocale !== undefined ? source.getLocale() : source?.locale,
    [source],
  )
  const resolved = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return resolved ?? source?.locale ?? DEFAULT_HELMX_LOCALE
}

/** Minimal translator bound to the active UI locale; referentially stable while locale is unchanged. */
export function useUiTranslator(): LocaleTranslator {
  const locale = useUiLocale()
  return useMemo(() => createLocaleTranslator(locale), [locale])
}

// Pure locale essentials re-exported from @helmx/protocol/browser.
export {
  HELMX_LOCALES,
  DEFAULT_HELMX_LOCALE,
  isHelmxLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  resolveLocalizedText,
  createLocaleTranslator,
} from '@helmx/protocol/browser'
export type { HelmxLocale, LocalizedText, ExecutionText, LocaleTranslator } from '@helmx/protocol/browser'
