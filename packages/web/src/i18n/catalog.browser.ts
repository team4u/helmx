/**
 * Browser-only split-locale Web message catalog (substituted for `catalog.ts`
 * by Vite's `splitWebLocalesPlugin` in `vite.config.ts`).
 *
 * Neither locale table is bundled into the initial `index-*.js` entry chunk:
 * `main.tsx` awaits `preloadWebLocale(resolveInitialLocale())` before mounting
 * React so ONLY the active locale chunk downloads on cold boot; switching
 * languages at runtime lazily loads the other locale chunk and notifies
 * `useWebLocale` subscribers via `useSyncExternalStore`.
 */
import type { HelmxLocale } from '@helmx/protocol/browser'
import { formatMessage, type MessageParams } from './messages.js'
import type { WebMessageKey, WebMessageTranslator } from './catalog.js'

type LocaleDictionary = Readonly<Record<string, string>>

const loadedPacks = new Map<HelmxLocale, LocaleDictionary>()
const pendingLoads = new Map<HelmxLocale, Promise<void>>()
const translatorCache = new Map<HelmxLocale, WebMessageTranslator>()
const listeners = new Set<() => void>()
let catalogRevision = 0

function notifyCatalogListeners(): void {
  catalogRevision += 1
  for (const listener of listeners) listener()
}

const LOCALE_LOADERS: Record<HelmxLocale, () => Promise<{ default: LocaleDictionary }>> = {
  en: () => import('virtual:helmx-i18n-en'),
  'zh-CN': () => import('virtual:helmx-i18n-zh-CN'),
}

/** Lazily load a single locale dictionary chunk (deduplicated; no-op once loaded). */
export function preloadWebLocale(locale: HelmxLocale): Promise<void> {
  if (loadedPacks.has(locale)) return Promise.resolve()
  const existing = pendingLoads.get(locale)
  if (existing !== undefined) return existing
  const promise = LOCALE_LOADERS[locale]()
    .then((mod) => {
      loadedPacks.set(locale, mod.default)
      translatorCache.delete(locale)
      notifyCatalogListeners()
    })
    .finally(() => {
      pendingLoads.delete(locale)
    })
  pendingLoads.set(locale, promise)
  return promise
}

export function subscribeWebLocaleCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getWebLocaleCatalogRevision(): number {
  return catalogRevision
}

/** Memoized per-locale translator backed by the lazily loaded locale chunk. */
export function createWebTranslator(locale: HelmxLocale): WebMessageTranslator {
  const cached = translatorCache.get(locale)
  if (cached !== undefined) return cached
  if (!loadedPacks.has(locale)) {
    void preloadWebLocale(locale)
  }
  const created: WebMessageTranslator = (key: WebMessageKey, params?: MessageParams): string => {
    const dict = loadedPacks.get(locale) ?? loadedPacks.get('en')
    const template = dict?.[key]
    if (template === undefined) return key
    return formatMessage(template, params)
  }
  translatorCache.set(locale, created)
  return created
}

/** Dynamic English bridge translator (always resolves against the loaded en pack). */
export const englishWebTranslator: WebMessageTranslator = (key, params) =>
  createWebTranslator('en')(key, params)

export type { WebMessageKey, WebMessageTranslator }
export type { MessageEntry, MessageTable, MessageParams } from './messages.js'
