/** AskDoc commands: asks list / answer / cancel. */
import type { AskSpec } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue } from '../args.js'
import { printTableColumns } from '../output.js'
import { formatAskWaiting } from '../timing.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  enumFlag,
  printResult,
  requirePositional,
  resolveConversationTarget,
  validateEnum,
} from './shared.js'
import { resolveDisplayString } from '../output.js'

const ASK_STATUSES = ['pending', 'answered', 'cancelled', 'superseded'] as const

export function asksCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['asks', 'list'],
    description: 'List asks (GET /api/asks; filter with --conversation, --current, or --status)',
    flags: [
      { name: 'conversation', type: 'number', help: 'filter by conversation ID' },
      { name: 'current', type: 'boolean', help: 'filter by HELMX_CONVERSATION_ID from environment' },
      enumFlag('status', ASK_STATUSES, 'filter by ask status'),
    ],
    async run(ctx: CommandContext) {
      assertNoExtraPositionals(ctx.positionals, 0)
      const hasConv = ctx.flags.has('conversation')
      const useCurrent = ctx.flags.get('current') === true
      if (hasConv && useCurrent) {
        throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
      }
      const query = new URLSearchParams()
      if (hasConv) {
        const convId = flagValue<number>(ctx.flags, 'conversation')
        if (convId === undefined || !Number.isSafeInteger(convId) || convId < 1) {
          throw new CliError(`--conversation must be a positive integer, got "${String(convId)}"`, 'invalid_flag_value')
        }
        query.set('conversationId', String(convId))
      } else if (useCurrent) {
        const currentId = resolveConversationTarget(ctx.flags, undefined, ctx.env)
        query.set('conversationId', String(currentId))
      }
      const status = flagValue<string>(ctx.flags, 'status')
      if (status !== undefined) {
        query.set('status', validateEnum(status, ASK_STATUSES, 'status'))
      }
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const hub = await ctx.hub()
      const list = await hub.get<AskSpec[]>(`/api/asks${qs}`)
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
      { name: 'answers', type: 'json', required: true, help: 'JSON object mapping field names to string or string[] values' },
      { name: 'expected-state-seq', type: 'number', help: 'CAS sequence guard; resolves as superseded if terminal state advanced' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      assertNoExtraPositionals(ctx.positionals, 1)
      const answers = ctx.flags.get('answers')
      if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new CliError('--answers must be a JSON object mapping field names to string or string[] values', 'invalid_flag_value')
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
