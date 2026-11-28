/**
 * Pure Omnibox label lookup and query-prefix helpers (kept outside .tsx files
 * so React Fast Refresh stays strictly component-only).
 */
import type { WebMessageKey } from '../i18n/catalog.js'
import type { OmniboxGroupKey, OmniboxScope } from './types.js'

const GROUP_LABEL_KEYS: Record<OmniboxGroupKey, WebMessageKey> = {
  'top-hit': 'modals.omnibox.group.topHit',
  context: 'modals.omnibox.group.context',
  recent: 'modals.omnibox.group.recent',
  quick: 'modals.omnibox.group.quick',
  pages: 'modals.omnibox.group.pages',
  commands: 'modals.omnibox.group.commands',
  conversations: 'modals.omnibox.group.conversations',
  resources: 'modals.omnibox.group.resources',
  messages: 'modals.omnibox.group.messages',
}

const SCOPE_LABEL_KEYS: Record<OmniboxScope, WebMessageKey> = {
  all: 'modals.omnibox.scope.all',
  pages: 'modals.omnibox.scope.pages',
  commands: 'modals.omnibox.scope.commands',
  conversations: 'modals.omnibox.scope.conversations',
}

export function omniboxGroupLabelKey(group: OmniboxGroupKey): WebMessageKey {
  return GROUP_LABEL_KEYS[group]
}

export function omniboxScopeLabelKey(scope: OmniboxScope): WebMessageKey {
  return SCOPE_LABEL_KEYS[scope]
}

/**
 * Strips an explicit leading `>` or `#` scope prefix so switching scope tabs
 * via `Tab` or pointer click takes effect cleanly without losing the user's
 * typed keywords.
 */
export function stripOmniboxPrefix(query: string): string {
  const trimmedStart = query.trimStart()
  if (trimmedStart.startsWith('>') || trimmedStart.startsWith('#')) {
    return trimmedStart.slice(1).trimStart()
  }
  return query
}
