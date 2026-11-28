/**
 * Full-text search and Omnibox search commands: `search <query>` and `omnibox search <query>`.
 * Driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` (`conversations.search`) and
 * `OMNIBOX_CORE_OPERATIONS` (`omnibox.search`) via `commandsFromOperations`.
 */
import {
  CONVERSATION_CORE_OPERATIONS,
  HELMX_LOCALES,
  OMNIBOX_CORE_OPERATIONS,
  isHelmxLocale,
  type OmniboxSearchResponse,
  type SearchHit,
} from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { resolveDisplayString } from '../output.js'
import { commandsFromOperations, schemaFlagsForOperation } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult, resolveConversationTarget } from './shared.js'

const MAX_SEARCH_LIMIT = 100
const MAX_SEARCH_PER_CONVERSATION = 20

type SearchOperation = Extract<
  (typeof CONVERSATION_CORE_OPERATIONS)[number],
  { key: 'conversations.search' }
>

const SEARCH_OPERATIONS: readonly SearchOperation[] = CONVERSATION_CORE_OPERATIONS.filter(
  (op): op is SearchOperation => op.key === 'conversations.search',
)

const SEARCH_SPEC = SEARCH_OPERATIONS[0]!

const SEARCH_FLAG_HELP: Readonly<Record<string, string>> = {
  profile: 'filter by profileId',
  'owned-by': 'filter by ownership (human|helmx)',
  'top-level': 'search only top-level conversations',
  limit: 'maximum number of hits to return (1-100)',
  'max-per-conversation': 'maximum number of hits per conversation (1-20)',
}

const SEARCH_FLAG_BY_NAME = new Map(
  schemaFlagsForOperation(SEARCH_SPEC).map((flag) => [flag.name, flag] as const),
)

const SEARCH_FLAGS: readonly FlagSpec[] = [
  'profile',
  'owned-by',
  'top-level',
  'limit',
  'max-per-conversation',
].map((name) => {
  const base = SEARCH_FLAG_BY_NAME.get(name)!
  return { ...base, help: SEARCH_FLAG_HELP[name] ?? base.help }
})

const OMNIBOX_SPEC = OMNIBOX_CORE_OPERATIONS[0]!
const OMNIBOX_FLAG_BY_NAME = new Map(
  schemaFlagsForOperation(OMNIBOX_SPEC).map((flag) => [flag.name, flag] as const),
)
const OMNIBOX_FLAG_HELP: Readonly<Record<string, string>> = {
  limit: 'maximum number of hits per source (1-100; plugin hits capped at 8 per plugin)',
  locale: `preferred UI locale (${HELMX_LOCALES.join('|')})`,
  conversation: 'optional current conversation ID context (mutually exclusive with --current)',
}
const OMNIBOX_FLAGS: readonly FlagSpec[] = [
  ...['limit', 'locale', 'conversation'].map((name) => {
    const base = OMNIBOX_FLAG_BY_NAME.get(name)!
    return { ...base, help: OMNIBOX_FLAG_HELP[name] ?? base.help }
  }),
  {
    name: 'current',
    type: 'boolean',
    help: 'use HELMX_CONVERSATION_ID from environment as conversation context (mutually exclusive with --conversation)',
  },
]

export function searchCommands(): CommandSpec[] {
  return [
    ...commandsFromOperations(SEARCH_OPERATIONS, {
      customHandlers: {
        search: {
          description:
            'Full-text search across conversations (GET /api/search?q=; supports --profile, --owned-by, --top-level, --limit, --max-per-conversation)',
          flags: SEARCH_FLAGS,
          positional: '<query>',
          async run(ctx: CommandContext) {
            const query = ctx.positionals.join(' ')
            if (!query || query.trim().length === 0) {
              throw new CliError('missing <query> positional argument', 'missing_query')
            }
            const params: string[] = [`q=${encodeURIComponent(query)}`]
            const profile = flagValue<string>(ctx.flags, 'profile')
            if (profile !== undefined) {
              if (profile.trim() === '') {
                throw new CliError('--profile must be a non-empty string', 'invalid_flag_value')
              }
              params.push(`profileId=${encodeURIComponent(profile)}`)
            }
            const ownedBy = flagValue<string>(ctx.flags, 'owned-by')
            if (ownedBy !== undefined) {
              if (ownedBy !== 'human' && ownedBy !== 'helmx') {
                throw new CliError(`--owned-by must be human|helmx, got "${ownedBy}"`, 'invalid_flag_value')
              }
              params.push(`ownedBy=${encodeURIComponent(ownedBy)}`)
            }
            if (ctx.flags.get('top-level') === true) {
              params.push('topLevelOnly=1')
            }
            const limit = flagValue<number>(ctx.flags, 'limit')
            if (limit !== undefined) {
              if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
                throw new CliError(
                  `--limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}, got "${limit}"`,
                  'invalid_flag_value',
                )
              }
              params.push(`limit=${limit}`)
            }
            const maxPerConversation = flagValue<number>(ctx.flags, 'max-per-conversation')
            if (maxPerConversation !== undefined) {
              if (
                !Number.isSafeInteger(maxPerConversation) ||
                maxPerConversation < 1 ||
                maxPerConversation > MAX_SEARCH_PER_CONVERSATION
              ) {
                throw new CliError(
                  `--max-per-conversation must be an integer between 1 and ${MAX_SEARCH_PER_CONVERSATION}, got "${maxPerConversation}"`,
                  'invalid_flag_value',
                )
              }
              params.push(`maxPerConversation=${maxPerConversation}`)
            }
            const hub = await ctx.hub()
            const hits = await hub.get<SearchHit[]>(`/api/search?${params.join('&')}`)
            if (ctx.json) {
              printResult(ctx, hits)
              return
            }
            // Human table omits raw UTF-16 highlight offset arrays while keeping plain-text title & snippet readable.
            printResult(
              ctx,
              hits.map((hit) => ({
                conversationId: hit.conversationId,
                ...(hit.entryId !== undefined ? { entryId: hit.entryId } : {}),
                ...(hit.title !== undefined ? { title: hit.title } : {}),
                snippet: hit.snippet,
              })),
            )
          },
        },
      },
    }),
    ...commandsFromOperations(OMNIBOX_CORE_OPERATIONS, {
      customHandlers: {
        'omnibox search': {
          description:
            'Unified Omnibox search across conversation messages and active plugin search providers (GET /api/omnibox/search?q=)',
          flags: OMNIBOX_FLAGS,
          positional: '<query>',
          async run(ctx: CommandContext) {
            const query = ctx.positionals.join(' ')
            if (!query || query.trim().length === 0) {
              throw new CliError('missing <query> positional argument', 'missing_query')
            }
            const params: string[] = [`q=${encodeURIComponent(query)}`]
            const limit = flagValue<number>(ctx.flags, 'limit')
            if (limit !== undefined) {
              if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
                throw new CliError(
                  `--limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}, got "${limit}"`,
                  'invalid_flag_value',
                )
              }
              params.push(`limit=${limit}`)
            }
            const locale = flagValue<string>(ctx.flags, 'locale')
            if (locale !== undefined) {
              if (!isHelmxLocale(locale)) {
                throw new CliError(
                  `--locale must be ${HELMX_LOCALES.join('|')}, got "${locale}"`,
                  'invalid_flag_value',
                )
              }
              params.push(`locale=${encodeURIComponent(locale)}`)
            }
            const hasConversation = ctx.flags.has('conversation')
            const hasCurrent = ctx.flags.get('current') === true
            if (hasConversation && hasCurrent) {
              throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
            }
            if (hasConversation) {
              const conversationId = flagValue<number>(ctx.flags, 'conversation')
              if (conversationId === undefined || !Number.isSafeInteger(conversationId) || conversationId <= 0) {
                throw new CliError('--conversation must be a positive integer conversation ID', 'invalid_flag_value')
              }
              params.push(`conversationId=${conversationId}`)
            } else if (hasCurrent) {
              const conversationId = resolveConversationTarget(ctx.flags, undefined, ctx.env)
              params.push(`conversationId=${conversationId}`)
            }
            const hub = await ctx.hub()
            const res = await hub.get<OmniboxSearchResponse>(`/api/omnibox/search?${params.join('&')}`)
            if (ctx.json) {
              printResult(ctx, res)
              return
            }
            if (res.messagesUnavailable) {
              ctx.io.err('Warning: conversation full-text search was unavailable for this query\n')
            }
            if (res.failedPlugins && res.failedPlugins.length > 0) {
              ctx.io.err(`Warning: plugin search providers failed or timed out: ${res.failedPlugins.join(', ')}\n`)
            }
            const rows: Array<Record<string, unknown>> = [
              ...res.pluginItems.map((item) => ({
                source: item.pluginId,
                kind: item.kind ?? 'resource',
                title: resolveDisplayString(item.title),
                target: item.target,
              })),
              ...res.messages.map((hit) => ({
                source: `conversation:${hit.conversationId}`,
                kind: 'message',
                title: hit.title ?? `#${hit.conversationId}`,
                target: hit.snippet,
              })),
            ]
            printResult(ctx, rows)
          },
        },
      },
    }),
  ]
}
