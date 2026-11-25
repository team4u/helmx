/** AskDoc commands: asks list / answer / cancel. */
import type { AskSpec } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue } from '../args.js'
import { printTableColumns } from '../output.js'
import { formatAskWaiting } from '../timing.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult, requirePositional } from './shared.js'
import { resolveDisplayString } from '../output.js'

export function asksCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['asks', 'list'],
    description: 'List pending asks (GET /api/asks)',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      const list = await hub.get<AskSpec[]>('/api/asks')
      if (ctx.json || !Array.isArray(list)) {
        printResult(ctx, list)
        return
      }
      const nowMs = Date.now()
      printTableColumns(ctx.io, list, [
        { label: 'id', value: (a) => a.id ?? '' },
        { label: 'conversation', value: (a) => (typeof a.conversationId === 'number' ? `#${a.conversationId}` : '') },
        { label: 'status', value: (a) => a.status ?? '' },
        { label: 'waiting', value: (a) => formatAskWaiting(a, nowMs) },
        { label: 'title', value: (a) => resolveDisplayString(a.title ?? '') },
      ])
    },
  })

  cmds.push({
    path: ['asks', 'answer'],
    description: 'Submit answers to a pending ask (POST /api/asks/:id/answer; supports CAS)',
    flags: [
      { name: 'answers', type: 'json', required: true, help: 'JSON object mapping fieldName to answer value' },
      { name: 'expected-state-seq', type: 'number', help: 'CAS sequence guard; resolves as superseded if terminal state advanced' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      assertNoExtraPositionals(ctx.positionals, 1)
      const answers = ctx.flags.get('answers')
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new CliError('--answers must be a JSON object mapping fieldName to answer value', 'invalid_flag_value')
      }
      const body: Record<string, unknown> = { answers }
      const seq = flagValue<number>(ctx.flags, 'expected-state-seq')
      if (seq !== undefined) body.expectedStateSeq = seq
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/answer`, body))
    },
  })

  cmds.push({
    path: ['asks', 'cancel'],
    description: 'Cancel a pending ask (POST /api/asks/:id/cancel)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      assertNoExtraPositionals(ctx.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/asks/${encodeURIComponent(id)}/cancel`))
    },
  })

  return cmds
}
