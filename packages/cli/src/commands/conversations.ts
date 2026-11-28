/**
 * Conversation commands composition: CRUD (`conversations-crud.ts`), streaming watchers
 * (`conversations-watch.ts`), and turn/context lifecycle commands (`reset`/`compact`/`fork`/`send`/`withdraw`/`abort`).
 *
 * Driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` via `commandsFromOperations`.
 */
import {
  CONVERSATION_CORE_OPERATIONS,
  MODEL_THINKING_LEVELS,
  REQUEST_SCHEMA_PATTERNS,
  type ConversationSummary,
} from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import {
  coerceOptionalConversationId,
  conversationCrudCommands,
  resolveOptionalConversationId,
} from './conversations-crud.js'
import { convFlags, printConversationRecord } from './conversations-shared.js'
import { conversationsWatchCommand, eventsWatchCommand } from './conversations-watch.js'
import { commandsFromOperations, schemaFlagsForOperation } from './from-operations.js'
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
const WHEN_PENDING_ASK = ['supersede', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const
const THINKING_INPUT_VALUES = ['', ...MODEL_THINKING_LEVELS] as const

type ConversationTurnKey =
  | 'conversations.reset'
  | 'conversations.compact'
  | 'conversations.fork'
  | 'conversations.send'
  | 'conversations.withdraw'
  | 'conversations.abort'

type ConversationTurnOperation = Extract<
  (typeof CONVERSATION_CORE_OPERATIONS)[number],
  { key: ConversationTurnKey }
>

const TURN_KEYS = new Set<ConversationTurnKey>([
  'conversations.reset',
  'conversations.compact',
  'conversations.fork',
  'conversations.send',
  'conversations.withdraw',
  'conversations.abort',
])

const CONVERSATION_TURN_OPERATIONS: readonly ConversationTurnOperation[] =
  CONVERSATION_CORE_OPERATIONS.filter((op): op is ConversationTurnOperation =>
    TURN_KEYS.has(op.key as ConversationTurnKey),
  )

const RESET_SPEC = CONVERSATION_TURN_OPERATIONS.find((op) => op.key === 'conversations.reset')!
const COMPACT_SPEC = CONVERSATION_TURN_OPERATIONS.find((op) => op.key === 'conversations.compact')!
const FORK_SPEC = CONVERSATION_TURN_OPERATIONS.find((op) => op.key === 'conversations.fork')!
const SEND_SPEC = CONVERSATION_TURN_OPERATIONS.find((op) => op.key === 'conversations.send')!

const SEND_SCHEMA_FLAGS = new Map(
  schemaFlagsForOperation(SEND_SPEC).map((flag) => [flag.name, flag] as const),
)

const SEND_FLAGS: readonly FlagSpec[] = [
  ...convFlags,
  {
    ...(SEND_SCHEMA_FLAGS.get('model') ?? { name: 'model', type: 'string' as const }),
    help: 'one-turn runtime model override (provider/model or tier/<id>; requires idle conversation)',
  },
  {
    ...(SEND_SCHEMA_FLAGS.get('thinking') ?? { name: 'thinking', type: 'string' as const }),
    help: `one-turn runtime thinking level override (${MODEL_THINKING_LEVELS.join('|')}; requires idle conversation)`,
  },
  enumFlag('when-busy', WHEN_BUSY, 'policy when conversation is busy, defaults to steer'),
  enumFlag('when-pending-ask', WHEN_PENDING_ASK, 'policy when conversation has a pending AskDoc, defaults to supersede'),
  enumFlag('origin', ORIGINS, 'input origin, defaults to human'),
  {
    ...(SEND_SCHEMA_FLAGS.get('meta') ?? { name: 'meta', type: 'json' as const }),
    help: 'free-form metadata JSON object (forwarded to turn_settled)',
  },
  { name: 'attach', type: 'string', help: 'artifact ID(s) to attach (comma-separated)' },
  {
    ...(SEND_SCHEMA_FLAGS.get('replace-from') ?? { name: 'replace-from', type: 'number' as const }),
    help: 'rewrite and resend starting from this history entry ID (truncates it and subsequent context)',
  },
  {
    ...(SEND_SCHEMA_FLAGS.get('wait') ?? { name: 'wait', type: 'boolean' as const }),
    help: 'wait for the answer to this input (?wait=1; returns ConversationInputResult on success)',
  },
]

export function conversationsCommands(): CommandSpec[] {
  return commandsFromOperations(CONVERSATION_TURN_OPERATIONS, {
    extraFlags: {
      'conversations.withdraw': convFlags,
      'conversations.abort': convFlags,
    },
    coercePositionals: {
      'conversations.withdraw': { conversationId: coerceOptionalConversationId },
      'conversations.abort': { conversationId: coerceOptionalConversationId },
    },
    validateInput: {
      'conversations.withdraw': (input, ctx) => {
        const conversationId = resolveOptionalConversationId(input, ctx)
        const submissionId = input.submissionId as number | undefined
        if (submissionId === undefined || !Number.isSafeInteger(submissionId) || submissionId <= 0) {
          throw new CliError('--submission-id must be a positive integer', 'invalid_flag_value')
        }
        return { ...input, conversationId, submissionId }
      },
      'conversations.abort': (input, ctx) => ({
        ...input,
        conversationId: resolveOptionalConversationId(input, ctx),
      }),
    },
    customHandlers: {
      'conversations reset': {
        description: 'Reset conversation context (POST /api/conversations/:id/reset; starts fresh context with handoff)',
        flags: [
          ...convFlags,
          ...schemaFlagsForOperation(RESET_SPEC).map((f) =>
            f.name === 'handoff'
              ? { ...f, help: 'handoff text used as the first user message after reset' }
              : f,
          ),
        ],
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

      'conversations compact': {
        description: 'Manually compact conversation context (POST /api/conversations/:id/compact; background summarization task)',
        flags: [
          ...convFlags,
          ...schemaFlagsForOperation(COMPACT_SPEC).map((f) =>
            f.name === 'instructions'
              ? { ...f, help: 'custom instructions for compaction summary' }
              : f,
          ),
        ],
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

      'conversations fork': {
        description: 'Fork a conversation from a specified entry or latest clean anchor (POST /api/conversations/:id/fork)',
        flags: [
          ...convFlags,
          ...schemaFlagsForOperation(FORK_SPEC).map((f) => {
            if (f.name === 'entry-id') return { ...f, help: 'entry ID to fork from (defaults to latest clean anchor)' }
            if (f.name === 'title') return { ...f, help: 'title for the new conversation (defaults to "<source title> (fork)")' }
            return f
          }),
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

      send: {
        description: 'Submit input to a conversation (POST /api/conversations/:id/input; --wait waits for the reply)',
        flags: SEND_FLAGS,
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
            throw new CliError(
              `unexpected positional argument: ${ctx.positionals.slice(textIndex + 1).join(' ')} (wrap text containing spaces in quotes)`,
              'unexpected_positional',
            )
          }
          const body: Record<string, unknown> = { text }
          const model = flagValue<string>(ctx.flags, 'model')
          const thinking = flagValue<string>(ctx.flags, 'thinking')
          const whenBusy = flagValue<string>(ctx.flags, 'when-busy')
          const whenPendingAsk = flagValue<string>(ctx.flags, 'when-pending-ask')
          const origin = flagValue<string>(ctx.flags, 'origin')
          if (model !== undefined) {
            const trimmedModel = model.trim()
            if (!REQUEST_SCHEMA_PATTERNS.modelRef.test(trimmedModel)) {
              throw new CliError(`--model expects provider/model or tier/<id>, got "${model}"`, 'invalid_flag_value')
            }
            body.model = trimmedModel
          }
          if (thinking !== undefined) {
            body.thinkingLevel = validateEnum(thinking, THINKING_INPUT_VALUES, 'thinking')
          }
          if (whenBusy !== undefined) body.whenBusy = validateEnum(whenBusy, WHEN_BUSY, 'when-busy')
          if (whenPendingAsk !== undefined) {
            body.whenPendingAsk = validateEnum(whenPendingAsk, WHEN_PENDING_ASK, 'when-pending-ask')
          }
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
    },
    extraCommands: [
      eventsWatchCommand(),
      ...conversationCrudCommands(),
      conversationsWatchCommand(),
    ],
  })
}
