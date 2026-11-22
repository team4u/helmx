/**
 * Derived conversation background-activity slice computation.
 */
import type { ConversationSummary, HelmxLocale } from '@helmx/protocol/browser'
import { createWebTranslator } from '../../i18n/catalog.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
} from '../../shell/background-activity-model.js'
import type { GroupedUiSpecs } from '../types.js'
import {
  EMPTY_BACKGROUND_INDEX,
  EMPTY_BADGE_DOCS,
  EMPTY_PENDING_BADGE_DOCS,
  isSameBackgroundIndex,
  isSameBadgeDocs,
  isSameStringSet,
} from './helpers.js'
import type { ConversationBackgroundSlice } from './types.js'

export interface BackgroundRecomputeResult {
  changed: boolean
  slice: ConversationBackgroundSlice
  badgeDocKeys: Set<string>
}

export function recomputeConversationBackgroundSlice(input: {
  prevSlice: ConversationBackgroundSlice
  prevBadgeDocKeys: Set<string>
  workbenchPanels: GroupedUiSpecs['workbenchPanels']
  conversations: ConversationSummary[]
  pluginDocs: Record<string, unknown>
  locale: HelmxLocale
  triggers: { panelsOrConversations: boolean; locale: boolean; changedDocKeys?: ReadonlySet<string> }
}): BackgroundRecomputeResult {
  const { prevSlice, prevBadgeDocKeys, workbenchPanels, conversations, pluginDocs, locale, triggers } = input
  if (!triggers.panelsOrConversations && !triggers.locale) {
    if (triggers.changedDocKeys === undefined || triggers.changedDocKeys.size === 0) {
      return { changed: false, slice: prevSlice, badgeDocKeys: prevBadgeDocKeys }
    }
    let touchesBadgeDoc = false
    for (const key of triggers.changedDocKeys) {
      if (prevBadgeDocKeys.has(key)) {
        touchesBadgeDoc = true
        break
      }
    }
    if (!touchesBadgeDoc) {
      return { changed: false, slice: prevSlice, badgeDocKeys: prevBadgeDocKeys }
    }
  }

  let nextBadgeDocs = prevSlice.badgeDocs
  let nextBadgeDocKeys = prevBadgeDocKeys
  if (triggers.panelsOrConversations) {
    const collected = collectBackgroundBadgeDocs(workbenchPanels, conversations)
    if (!isSameBadgeDocs(prevSlice.badgeDocs, collected)) {
      nextBadgeDocs = collected.length === 0 ? EMPTY_BADGE_DOCS : Object.freeze(collected)
      nextBadgeDocKeys = new Set(nextBadgeDocs.map((ref) => `${ref.pluginId}/${ref.doc}`))
    }
  }

  const rawPending = new Set<string>()
  for (const ref of nextBadgeDocs) {
    const key = `${ref.pluginId}/${ref.doc}`
    if (!Object.hasOwn(pluginDocs, key)) rawPending.add(key)
  }
  const nextPendingBadgeDocs = isSameStringSet(prevSlice.pendingBadgeDocs, rawPending)
    ? prevSlice.pendingBadgeDocs
    : rawPending.size === 0
      ? EMPTY_PENDING_BADGE_DOCS
      : rawPending

  const nextUnknown = nextPendingBadgeDocs.size > 0
  const rawByConversation = summarizeConversationBackgroundActivity({
    panels: workbenchPanels,
    conversations,
    pluginDocs,
    locale,
    t: createWebTranslator(locale),
  })
  const nextSnapshot =
    prevSlice.snapshot.unknown === nextUnknown &&
    isSameBackgroundIndex(prevSlice.snapshot.byConversation, rawByConversation)
      ? prevSlice.snapshot
      : Object.freeze({
          unknown: nextUnknown,
          byConversation: rawByConversation.size === 0 ? EMPTY_BACKGROUND_INDEX : rawByConversation,
        })

  if (
    nextBadgeDocs === prevSlice.badgeDocs &&
    nextPendingBadgeDocs === prevSlice.pendingBadgeDocs &&
    nextSnapshot === prevSlice.snapshot
  ) {
    return { changed: false, slice: prevSlice, badgeDocKeys: nextBadgeDocKeys }
  }
  return {
    changed: true,
    slice: {
      badgeDocs: nextBadgeDocs,
      pendingBadgeDocs: nextPendingBadgeDocs,
      snapshot: nextSnapshot,
    },
    badgeDocKeys: nextBadgeDocKeys,
  }
}
