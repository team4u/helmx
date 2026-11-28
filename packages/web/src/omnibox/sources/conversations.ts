/**
 * Local conversation catalog builders (0ms) and asynchronous FTS5 message hit mapper (200ms).
 * Both emit the unified `OmniboxItem` shape — zero `FakeSearchHitRow` split!
 */
import type { ConversationSummary, SearchHit } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../../shell/conversation-status-model.js'
import { selectRecentConversationsForPalette } from '../../shell/shortcuts-model.js'
import type { OmniboxItem, SearchHighlightSpan } from '../types.js'
import { dedupeStrings } from './helpers.js'

export type OmniboxMessageHit = SearchHit & {
  highlights?: ReadonlyArray<SearchHighlightSpan>
}

export function buildRecentConversationItems(
  conversations: ReadonlyArray<ConversationSummary>,
  activeConversationId: number | undefined,
  background: ConversationBackgroundIndex,
  t: WebMessageTranslator,
): OmniboxItem[] {
  return selectRecentConversationsForPalette(conversations, activeConversationId, 5, background).map(
    (conv) => ({
      id: `conv:${conv.id}`,
      kind: 'conversation',
      scope: 'conversations',
      group: 'recent',
      title: conv.title.trim() || t('shell.conversationFallback', { id: conv.id }),
      subtitle: t('modals.palette.recentSnippet', { id: conv.id, profileId: conv.profileId }),
      metaText: `#${conv.id}`,
      conv,
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([conv.title]),
        aliases: dedupeStrings([conv.profileId, `#${conv.id}`, String(conv.id), ...(conv.tags ?? [])]),
        exactTokens: [`#${conv.id}`],
      },
      intent: { type: 'navigate', target: { kind: 'conversation', conversationId: conv.id } },
    }),
  )
}

export function buildLocalConversationItems(
  conversations: ReadonlyArray<ConversationSummary>,
  t: WebMessageTranslator,
): OmniboxItem[] {
  return conversations.map((conv) => ({
    id: `conv:${conv.id}`,
    kind: 'conversation',
    scope: 'conversations',
    group: 'conversations',
    title: conv.title.trim() || t('shell.conversationFallback', { id: conv.id }),
    subtitle: t('modals.palette.convSnippet', { id: conv.id, profileId: conv.profileId }),
    metaText: `#${conv.id}`,
    conv,
    searchTerms: {
      primary: dedupeStrings([conv.title]),
      aliases: dedupeStrings([conv.profileId, `#${conv.id}`, String(conv.id), ...(conv.tags ?? [])]),
      exactTokens: [`#${conv.id}`],
    },
    intent: { type: 'navigate', target: { kind: 'conversation', conversationId: conv.id } },
  }))
}

export function buildAsyncMessageItems(
  hits: ReadonlyArray<OmniboxMessageHit>,
  conversations: ReadonlyArray<ConversationSummary>,
  t: WebMessageTranslator,
): OmniboxItem[] {
  const convById = new Map(conversations.map((c) => [c.id, c] as const))
  const seen = new Set<string>()
  const out: OmniboxItem[] = []

  for (const hit of hits) {
    const entryId = hit.entryId?.trim() || ''
    const key = `${hit.conversationId}:${entryId}`
    if (seen.has(key)) continue
    seen.add(key)

    const conv = convById.get(hit.conversationId)
    const title =
      hit.title?.trim() ||
      conv?.title?.trim() ||
      t('shell.conversationFallback', { id: hit.conversationId })
    const subtitle =
      hit.snippet ||
      (conv !== undefined
        ? t('modals.palette.convSnippet', { id: hit.conversationId, profileId: conv.profileId })
        : '')

    out.push({
      id: `msg:${key}`,
      kind: 'message',
      scope: 'conversations',
      group: 'messages',
      title,
      ...(subtitle !== '' ? { subtitle } : {}),
      metaText: `#${hit.conversationId}`,
      icon: 'message-square',
      ...(conv !== undefined ? { conv } : {}),
      ...(hit.highlights !== undefined ? { snippetHighlights: hit.highlights } : {}),
      isAsync: true,
      searchTerms: {
        primary: [title],
        aliases: [subtitle, `#${hit.conversationId}`],
      },
      intent: {
        type: 'navigate',
        target: { kind: 'conversation', conversationId: hit.conversationId },
        ...(entryId !== '' ? { highlightEntryId: entryId } : {}),
      },
    })
  }

  return out
}
