/**
 * The merged Web message catalog: all domain tables plus the frozen common
 * table. `WebMessageKey` is the literal key union — typos in `t('...')` calls
 * fail typecheck instead of silently rendering the key.
 *
 * Cross-table key uniqueness is enforced by the web i18n unit tests (a spread
 * merge would otherwise let a later table silently shadow an earlier one).
 */
import type { HelmxLocale } from '@helmx/protocol/browser'
import { createMessageTranslator, type MessageTranslator } from './messages.js'
import { commonMessages } from './resources/common.js'
import { composerMessages } from './resources/composer.js'
import { conversationMessages } from './resources/conversation.js'
import { modalsMessages } from './resources/modals.js'
import { modelsMessages } from './resources/models.js'
import { nodesMessages } from './resources/nodes.js'
import { pluginsMessages } from './resources/plugins.js'
import { profilesMessages } from './resources/profiles.js'
import { shellMessages } from './resources/shell.js'
import { skillsMessages } from './resources/skills.js'
import { uiMessages } from './resources/ui.js'

/** Merged display-copy catalog for the whole Web UI. */
export const webMessages = {
  ...commonMessages,
  ...conversationMessages,
  ...composerMessages,
  ...shellMessages,
  ...uiMessages,
  ...modelsMessages,
  ...nodesMessages,
  ...pluginsMessages,
  ...profilesMessages,
  ...skillsMessages,
  ...modalsMessages,
}

/** Every valid message id (literal union; typo-proof at compile time). */
export type WebMessageKey = keyof typeof webMessages

/** Translator typed against the full catalog. */
export type WebMessageTranslator = MessageTranslator<typeof webMessages>

// Translators per locale are pure values: memoize so every consumer sharing a
// locale also shares one stable function identity (React deps friendly).
const translatorCache = new Map<HelmxLocale, WebMessageTranslator>()

/** Full-catalog translator bound to a locale (memoized; pure). */
export function createWebTranslator(locale: HelmxLocale): WebMessageTranslator {
  const cached = translatorCache.get(locale)
  if (cached !== undefined) return cached
  const created = createMessageTranslator(locale, webMessages)
  translatorCache.set(locale, created)
  return created
}

/** No-op in Node/SSR/tests where all locale tables are already synchronously in memory. */
export async function preloadWebLocale(_locale: HelmxLocale): Promise<void> {}

/** No-op subscription matching catalog.browser.ts (Node/tests never swap chunks). */
export function subscribeWebLocaleCatalog(_listener: () => void): () => void {
  return () => {}
}

/** Monotonic revision matching catalog.browser.ts. */
export function getWebLocaleCatalogRevision(): number {
  return 0
}

export type { MessageEntry, MessageTable, MessageParams } from './messages.js'
