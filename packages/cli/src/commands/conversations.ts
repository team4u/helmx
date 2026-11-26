/**
 * Conversation commands composition: CRUD (`conversations-crud.ts`), streaming watchers
 * (`conversations-watch.ts`), and turn/context lifecycle commands (`reset`/`compact`/`fork`/`send`/`withdraw`/`abort`).
 */
import type { ConversationSummary } from '@helmx/protocol'
import { flagValue } from '../args.js'
import { CliError } from '../errors.js'
import { conversationCrudCommands } from './conversations-crud.js'
import { convFlags, printConversationRecord } from './conversations-shared.js'
import { conversationsWatchCommand, eventsWatchCommand } from './conversations-watch.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  enumFlag,
  printPlainText,
  printResult,
  requirePositional,
  resolveConversationTarget,
  validateEnum,
} from './shared.js'

const WHEN_BUSY = ['steer', 'followUp', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const

export function conversationsCommands(): CommandSpec[] {
  return [
    eventsWatchCommand(),
    ...conversationCrudCommands(),

    {
      path: ['conversations', 'reset'],
      description: 'Reset conversation context (POST /api/conversations/:id/reset; starts fresh context with handoff)',
      flags: [...convFlags, { name: 'handoff', type: 'string', help: 'handoff text used as the first user message after reset' }],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const body: Record<string, unknown> = {}
        const handoff = flagValue<string>(ctx.flags, 'handoff')
        if (handoff !== undefined) body.handoff = handoff
        const hub = await ctx.hub()
        printConversationRecord(ctx, await hub.post<ConversationSummary>(`/api/conversations/${id}/reset`, body))
      },
    },

    {
      path: ['conversations', 'compact'],
      description: 'Manually compact conversation context (POST /api/conversations/:id/compact; background summarization task)',
      flags: [...convFlags, { name: 'instructions', type: 'string', help: 'custom instructions for compaction summary' }],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const body: Record<string, unknown> = {}
        const instructions = flagValue<string>(ctx.flags, 'instructions')
        if (instructions !== undefined) body.instructions = instructions
        const hub = await ctx.hub()
        printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/compact`, body))
      },
    },

    {
      path: ['conversations', 'fork'],
      description: 'Fork a conversation from a specified entry or latest clean anchor (POST /api/conversations/:id/fork)',
      flags: [
        ...convFlags,
        { name: 'entry-id', type: 'number', help: 'entry ID to fork from (defaults to latest clean anchor)' },
        { name: 'title', type: 'string', help: 'title for the new conversation (defaults to "<source title> (fork)")' },
      ],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const entryId = flagValue<number>(ctx.flags, 'entry-id')
        if (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId <= 0)) {
          throw new CliError('--entry-id must be a positive integer', 'invalid_flag_value')
        }
        const body: Record<string, unknown> = {}
        if (entryId !== undefined) body.entryId = entryId
        const title = flagValue<string>(ctx.flags, 'title')
        if (title !== undefined) body.title = title
        const hub = await ctx.hub()
        printConversationRecord(ctx, await hub.post<ConversationSummary>(`/api/conversations/${id}/fork`, body))
      },
    },

    {
      path: ['send'],
      description: 'Submit input to a conversation (POST /api/conversations/:id/input; --wait waits for the reply)',
      flags: [
        ...convFlags,
        enumFlag('when-busy', WHEN_BUSY, 'policy when conversation is busy, defaults to steer'),
        enumFlag('origin', ORIGINS, 'input origin, defaults to human'),
        { name: 'meta', type: 'json', help: 'free-form metadata JSON object (forwarded to turn_settled)' },
        { name: 'attach', type: 'string', help: 'artifact ID(s) to attach (comma-separated)' },
        { name: 'replace-from', type: 'number', help: 'rewrite and resend starting from this history entry ID (truncates it and subsequent context)' },
        { name: 'wait', type: 'boolean', help: 'wait for the answer to this input (?wait=1; returns ConversationInputResult on success)' },
      ],
      positional: '[id] <text>',
      async run(ctx: CommandContext) {
        const useCurrent = ctx.flags.get('current') === true
        if (useCurrent && ctx.positionals.length === 2 && /^\d+$/.test(ctx.positionals[0]!)) {
          throw new CliError('conversation ID and --current are mutually exclusive', 'conflicting_flags')
        }
        const id = useCurrent
          ? resolveConversationTarget(ctx.flags, undefined, ctx.env)
          : resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        const textIndex = useCurrent ? 0 : 1
        const text = requirePositional(ctx.positionals, textIndex, 'text', 'missing_text')
        if (ctx.positionals.length > textIndex + 1) {
          throw new CliError(`unexpected positional argument: ${ctx.positionals.slice(textIndex + 1).join(' ')} (wrap text containing spaces in quotes)`, 'unexpected_positional')
        }
        const body: Record<string, unknown> = { text }
        const whenBusy = flagValue<string>(ctx.flags, 'when-busy')
        const origin = flagValue<string>(ctx.flags, 'origin')
        if (whenBusy !== undefined) body.whenBusy = validateEnum(whenBusy, WHEN_BUSY, 'when-busy')
        if (origin !== undefined) body.origin = validateEnum(origin, ORIGINS, 'origin')
        if (ctx.flags.has('meta')) body.meta = coerceMetaFlag(ctx.flags.get('meta'), 'meta')
        const attachRaw = flagValue<string>(ctx.flags, 'attach')
        if (attachRaw !== undefined) {
          const attachIds = attachRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
          if (attachIds.length > 0) body.attachments = attachIds
        }
        const replaceFrom = flagValue<number>(ctx.flags, 'replace-from')
        if (replaceFrom !== undefined) {
          if (!Number.isSafeInteger(replaceFrom) || replaceFrom <= 0) {
            throw new CliError(`--replace-from must be a positive integer, got "${replaceFrom}"`, 'invalid_flag_value')
          }
          body.replaceFromEntryId = replaceFrom
        }
        const hub = await ctx.hub()
        const wait = ctx.flags.get('wait') === true
        const result = await hub.request<unknown>(
          'POST',
          `/api/conversations/${id}/input${wait ? '?wait=1' : ''}`,
          { body, ...(wait ? { timeoutMs: 0 } : {}) },
        )
        if (wait && !ctx.json) {
          // Human mode: read authoritative redacted `result.text` directly (never reconstruct from entry.model).
          if (result !== null && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string') {
            const answer = (result as { text: string }).text
            if (answer !== '') printPlainText(ctx, answer)
            return
          }
          printPlainText(ctx, JSON.stringify(result))
          return
        }
        printResult(ctx, result)
      },
    },

    {
      path: ['conversations', 'withdraw'],
      description: 'Withdraw a queued input (POST /api/conversations/:id/withdraw)',
      flags: [...convFlags, { name: 'submission-id', type: 'number', required: true, help: 'queued submission ID to withdraw' }],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const submissionId = flagValue<number>(ctx.flags, 'submission-id')
        if (submissionId === undefined || !Number.isSafeInteger(submissionId) || submissionId <= 0) {
          throw new CliError('--submission-id must be a positive integer', 'invalid_flag_value')
        }
        const hub = await ctx.hub()
        printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/withdraw`, { submissionId }))
      },
    },

    {
      path: ['abort'],
      description: 'Abort the current turn of a conversation (POST /api/conversations/:id/abort)',
      flags: convFlags,
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const hub = await ctx.hub()
        printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/abort`))
      },
    },

    conversationsWatchCommand(),
  ]
}
