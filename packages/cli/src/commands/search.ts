/** Full-text search command: search <query>. */
import type { SearchHit } from '@helmx/protocol'
import { CliError } from '../errors.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult } from './shared.js'

export function searchCommands(): CommandSpec[] {
  return [
    {
      path: ['search'],
      description: 'Full-text search across conversations (GET /api/search?q=)',
      positional: '<query>',
      async run(ctx: CommandContext) {
        const query = ctx.positionals.join(' ')
        if (!query) throw new CliError('missing <query> positional argument', 'missing_query')
        const hub = await ctx.hub()
        const hits = await hub.get<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`)
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
  ]
}
