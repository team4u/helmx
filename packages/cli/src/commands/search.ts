/**
 * Full-text search command: search <query>.
 * Driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` (`conversations.search`) via `commandsFromOperations`.
 */
import { CONVERSATION_CORE_OPERATIONS, type SearchHit } from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { commandsFromOperations, schemaFlagsForOperation } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult } from './shared.js'

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

export function searchCommands(): CommandSpec[] {
  return commandsFromOperations(SEARCH_OPERATIONS, {
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
  })
}
