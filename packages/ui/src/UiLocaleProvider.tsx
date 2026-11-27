/**
 * Locale provider for `@helmx/ui` primitives (decoupled from any host store).
 *
 * Pass a referentially stable `(subscribe, getLocale)` pair to connect to a
 * host external store via `useSyncExternalStore` without full-tree re-renders,
 * or pass a static `locale` prop for standalone / SSR / test rendering.
 *
 * Component & type exports only (Fast Refresh friendly).
 */
import { useMemo, type ReactNode } from 'react'
import type { HelmxLocale } from '@helmx/protocol/browser'
import { UiLocaleContext, type UiLocaleStore } from './ui-locale-context.js'

export interface UiLocaleProviderProps {
  /** Static locale override (standalone / SSR / test rendering). */
  locale?: HelmxLocale
  /** Reactive subscription callback paired with `getLocale` (host store integration). */
  subscribe?: (listener: () => void) => () => void
  /** Synchronous locale snapshot getter paired with `subscribe`. */
  getLocale?: () => HelmxLocale | undefined
  children?: ReactNode
}

export function UiLocaleProvider({
  locale,
  subscribe,
  getLocale,
  children,
}: UiLocaleProviderProps): ReactNode {
  const value = useMemo<UiLocaleStore>(
    () => ({
      ...(locale !== undefined ? { locale } : {}),
      ...(subscribe !== undefined ? { subscribe } : {}),
      ...(getLocale !== undefined ? { getLocale } : {}),
    }),
    [locale, subscribe, getLocale],
  )
  return <UiLocaleContext.Provider value={value}>{children}</UiLocaleContext.Provider>
}
