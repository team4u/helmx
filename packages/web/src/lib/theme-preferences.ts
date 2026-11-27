/**
 * Storage read/write for theme, background-notification and UI-locale
 * preferences plus system color-scheme resolution (zero React dependencies,
 * independently unit-testable).
 */
import type { HelmxLocale } from '@helmx/protocol/browser'
import { normalizeLocaleTag } from '@helmx/protocol/browser'
import {
  readStorageItem,
  setOrRemoveStorageItem,
  type StorageReader,
  type StorageRemover,
  type StorageWriter,
} from './storage.js'
import type { LocalePreference, ThemeMode, ThemePreference } from './types.js'

export const THEME_STORAGE_KEY = 'helmx:theme'
export const QUIET_NOTIFY_STORAGE_KEY = 'helmx:quiet-notify'
export const LOCALE_STORAGE_KEY = 'helmx:locale'

/** Read the persisted theme preference; falls back to 'system' when storage is unavailable or the value is invalid. */
export function getStoredPreference(storage?: StorageReader | null): ThemePreference {
  const saved = readStorageItem(THEME_STORAGE_KEY, storage)
  if (saved === 'light' || saved === 'dark') return saved
  return 'system'
}

/** Persist the theme preference; 'system' removes the explicit key to follow the system color scheme. */
export function persistThemePreference(
  pref: ThemePreference,
  storage?: (StorageWriter & StorageRemover) | null,
): void {
  setOrRemoveStorageItem(THEME_STORAGE_KEY, pref === 'system' ? null : pref, storage)
}

/** Cycles the theme preference in system -> light -> dark -> system order. */
export function nextThemePreference(prev: ThemePreference): ThemePreference {
  if (prev === 'system') return 'light'
  if (prev === 'light') return 'dark'
  return 'system'
}

/** Background browser notification preference (localStorage 'helmx:quiet-notify' = '1'). */
export function getStoredQuietNotify(storage?: StorageReader | null): boolean {
  return readStorageItem(QUIET_NOTIFY_STORAGE_KEY, storage) === '1'
}

/** Persist the background browser notification toggle. */
export function persistQuietNotify(
  enabled: boolean,
  storage?: (StorageWriter & StorageRemover) | null,
): void {
  setOrRemoveStorageItem(QUIET_NOTIFY_STORAGE_KEY, enabled ? '1' : null, storage)
}

// ---------------------------------------------------------------------------
// UI locale preference (localStorage 'helmx:locale'; browser-derived default)
// ---------------------------------------------------------------------------

/** Read the persisted UI locale preference; returns 'auto' when the key is absent. */
export function getStoredLocalePreference(storage?: StorageReader | null): LocalePreference {
  const raw = readStorageItem(LOCALE_STORAGE_KEY, storage)
  return raw === null ? 'auto' : normalizeLocaleTag(raw)
}

/**
 * Persist the UI locale preference; 'auto' removes the explicit key so the
 * effective locale follows the browser language.
 */
export function persistLocalePreference(
  pref: LocalePreference,
  storage?: (StorageWriter & StorageRemover) | null,
): void {
  setOrRemoveStorageItem(LOCALE_STORAGE_KEY, pref === 'auto' ? null : pref, storage)
}

/** Resolve a LocalePreference into the effective HelmxLocale. */
export function resolveLocale(pref: LocalePreference, languages?: readonly string[]): HelmxLocale {
  return pref === 'auto' ? resolveBrowserLocale(languages) : pref
}

/**
 * Resolve the browser locale preference: takes the first usable language tag
 * (navigator.languages, falling back to navigator.language) and normalizes it
 * — zh-* -> zh-CN, everything else -> 'en'. Defaults to 'en' without a
 * navigator (SSR/tests).
 */
export function resolveBrowserLocale(languages?: readonly string[]): HelmxLocale {
  let candidates: readonly string[]
  if (languages !== undefined) {
    candidates = languages
  } else if (typeof navigator !== 'undefined') {
    candidates =
      navigator.languages !== undefined && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language]
  } else {
    candidates = []
  }
  const first = candidates.find((tag) => typeof tag === 'string' && tag.trim() !== '')
  return normalizeLocaleTag(first)
}

/**
 * Resolve the initial UI locale: the persisted preference wins, otherwise the
 * browser locale decides (zh-* -> zh-CN, others -> 'en').
 */
export function resolveInitialLocale(
  storage?: StorageReader | null,
  languages?: readonly string[],
): HelmxLocale {
  return resolveLocale(getStoredLocalePreference(storage), languages)
}

/** Sync the effective locale to the root document lang attribute. */
export function applyDocumentLocale(locale: HelmxLocale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

/** Resolve the current OS light/dark mode (defaults to 'light' without window/matchMedia). */
export function getSystemTheme(matchMediaFn?: (query: string) => { matches: boolean }): ThemeMode {
  if (matchMediaFn !== undefined) {
    return matchMediaFn('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** Resolve the theme preference into the actually effective light/dark theme. */
export function resolveTheme(pref: ThemePreference, systemTheme?: ThemeMode): ThemeMode {
  return pref === 'system' ? (systemTheme ?? getSystemTheme()) : pref
}

export const THEME_COLOR_LIGHT = '#f4f4f6'
export const THEME_COLOR_DARK = '#1a1a1e'

/** Sync the effective theme to the root document data-theme attribute and browser theme-color meta tags. */
export function applyDocumentTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  const themeColor = theme === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT
  for (const meta of document.querySelectorAll?.('meta[name="theme-color"]') ?? []) {
    meta.setAttribute('content', themeColor)
  }
}
