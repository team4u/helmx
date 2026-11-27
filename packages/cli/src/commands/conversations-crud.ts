/**
 * Conversation CRUD and workspace file read commands:
 * list / get / entry / file / create / update / delete.
 *
 * JSON operations are driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` via
 * `commandsFromOperations`; `conversations file` stays outside `CORE_OPERATIONS` as a
 * raw binary/text download endpoint.
 */
import {
  CONVERSATION_CORE_OPERATIONS,
  type ConversationBulkDeleteResponse,
  type ConversationSummary,
} from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { printTableColumns } from '../output.js'
import { formatConversationTiming } from '../timing.js'
import { convFlags, printConversationRecord } from './conversations-shared.js'
import { commandsFromOperations, schemaFlagsForOperation } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  assertNotSelfTarget,
  coerceTags,
  parsePositiveInt,
  printPlainText,
  printResult,
  resolveConversationTarget,
  resolveConversationTargets,
  writeDownloadedOutput,
} from './shared.js'

type ConversationCrudKey =
  | 'conversations.list'
  | 'conversations.get'
  | 'conversations.entry'
  | 'conversations.create'
  | 'conversations.update'
  | 'conversations.delete'
  | 'conversations.bulk_delete'

type ConversationCrudOperation = Extract<
  (typeof CONVERSATION_CORE_OPERATIONS)[number],
  { key: ConversationCrudKey }
>

const CRUD_KEYS = new Set<ConversationCrudKey>([
  'conversations.list',
  'conversations.get',
  'conversations.entry',
  'conversations.create',
  'conversations.update',
  'conversations.delete',
  'conversations.bulk_delete',
])

const CONVERSATION_CRUD_OPERATIONS: readonly ConversationCrudOperation[] =
  CONVERSATION_CORE_OPERATIONS.filter((op): op is ConversationCrudOperation =>
    CRUD_KEYS.has(op.key as ConversationCrudKey),
  )

const LIST_SPEC = CONVERSATION_CRUD_OPERATIONS.find((op) => op.key === 'conversations.list')!

const LIST_FLAG_HELP: Readonly<Record<string, string>> = {
  profile: 'filter by profileId',
  status: 'filter by status (working|blocked|done|idle|error)',
  tag: 'filter by tag',
  'owned-by': 'filter by ownership (human|helmx; defaults to human unless --all, --parent, --tag, or --top-level=false is given)',
  'top-level': 'filter top-level conversations only (pass --top-level=false to include child conversations)',
  all: 'list all conversations (including subagent/derived children and automated sessions)',
  parent: 'list only direct child conversations of this conversation',
}

const LIST_FLAGS: readonly FlagSpec[] = schemaFlagsForOperation(LIST_SPEC).map((flag) => ({
  ...flag,
  help: LIST_FLAG_HELP[flag.name] ?? flag.help,
}))

export function coerceOptionalConversationId(raw: string, _pos: unknown, ctx: CommandContext): number {
  if (ctx.flags.get('current') === true) {
    throw new CliError('conversation ID and --current are mutually exclusive', 'conflicting_flags')
  }
  return parsePositiveInt(raw, 'conversation ID')
}

export function resolveOptionalConversationId(input: Record<string, unknown>, ctx: CommandContext): number {
  const explicit = input.conversationId as number | undefined
  if (explicit !== undefined && ctx.flags.get('current') === true) {
    throw new CliError('conversation ID and --current are mutually exclusive', 'conflicting_flags')
  }
  if (explicit !== undefined) return explicit
  return resolveConversationTarget(ctx.flags, undefined, ctx.env)
}

const CONVERSATIONS_FILE_COMMAND: CommandSpec = {
  path: ['conversations', 'file'],
  description: 'Read a file in a conversation workspace (GET /api/conversations/:id/files/content)',
  flags: [
    ...convFlags,
    { name: 'output', type: 'string', help: 'output file path (resolved against CLI caller cwd)' },
  ],
  positional: '[id] <path>',
  async run(ctx: CommandContext) {
    const first = ctx.positionals[0]
    const second = ctx.positionals[1]
    assertNoExtraPositionals(ctx.positionals, 2)
    if (first === undefined) {
      throw new CliError(
        'missing <path> positional argument ([id] <path>, or pass --current for the conversation target)',
        'missing_positional',
      )
    }
    const id = resolveConversationTarget(ctx.flags, second === undefined ? undefined : first, ctx.env)
    const filePath = (second ?? first) as string
    if (filePath.trim() === '') {
      throw new CliError('workspace file path cannot be empty', 'invalid_path')
    }
    const output = flagValue<string>(ctx.flags, 'output')
    const hub = await ctx.hub()
    const response = await hub.raw(`/api/conversations/${id}/files/content?path=${encodeURIComponent(filePath)}`)
    if (output !== undefined) {
      await writeDownloadedOutput(ctx, response, output, 'workspace file')
      return
    }
    const contentType = response.headers.get('content-type') ?? ''
    const baseMime = contentType.split(';', 1)[0]!.trim().toLowerCase()
    const isText =
      baseMime.startsWith('text/') ||
      baseMime === 'application/json' ||
      baseMime === 'application/xml' ||
      baseMime === 'image/svg+xml'
    if (!isText) {
      await response.body?.cancel().catch(() => {})
      throw new CliError(
        `workspace file is binary (${contentType || 'unknown type'}): use --output <path>`,
        'binary_content_requires_output',
      )
    }
    const text = await response.text()
    if (ctx.json) {
      printResult(ctx, { conversationId: id, path: filePath, contentType, text })
    } else {
      printPlainText(ctx, text)
    }
  },
}

export function conversationCrudCommands(): CommandSpec[] {
  return commandsFromOperations(CONVERSATION_CRUD_OPERATIONS, {
    extraFlags: {
      'conversations.get': convFlags,
      'conversations.create': [
        { name: 'tags', type: 'string', help: 'JSON array or comma-separated' },
      ],
      'conversations.update': [
        ...convFlags,
        {
          name: 'tags',
          type: 'string',
          help: 'replace conversation tags (JSON array or comma-separated; empty string or [] clears)',
        },
      ],
    },
    coercePositionals: {
      'conversations.get': { conversationId: coerceOptionalConversationId },
      'conversations.update': { conversationId: coerceOptionalConversationId },
    },
    validateInput: {
      'conversations.get': (input, ctx) => {
        const conversationId = resolveOptionalConversationId(input, ctx)
        const limit = input.limit as number | undefined
        const turns = input.turns as number | undefined
        if (limit !== undefined && turns !== undefined) {
          throw new CliError('--limit and --turns are mutually exclusive', 'invalid_flag_value')
        }
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
          throw new CliError(`--limit must be an integer between 1 and 500, got "${limit}"`, 'invalid_flag_value')
        }
        if (turns !== undefined && (!Number.isSafeInteger(turns) || turns < 1 || turns > 50)) {
          throw new CliError(`--turns must be an integer between 1 and 50, got "${turns}"`, 'invalid_flag_value')
        }
        return { ...input, conversationId }
      },
      'conversations.create': (input, ctx) => {
        const next: Record<string, unknown> = { ...input }
        if (ctx.flags.has('tags')) {
          next.tags = coerceTags(ctx.flags.get('tags'))
        }
        const parentId = next.parentConversationId as number | undefined
        if (parentId !== undefined && (!Number.isSafeInteger(parentId) || parentId <= 0)) {
          throw new CliError(
            `--parent-conversation-id must be a positive integer, got "${parentId}"`,
            'invalid_flag_value',
          )
        }
        return next
      },
      'conversations.update': (input, ctx) => {
        const conversationId = resolveOptionalConversationId(input, ctx)
        const next: Record<string, unknown> = { ...input, conversationId }
        if (ctx.flags.has('tags')) {
          next.tags = coerceTags(ctx.flags.get('tags'))
        }
        const hasUpdatableField = Object.keys(next).some((k) => k !== 'conversationId')
        if (!hasUpdatableField) {
          throw new CliError(
            'no update fields provided (--title/--model/--thinking/--profile-id/--node/--cwd/--tags/--pinned/--unread)',
            'missing_update_fields',
          )
        }
        return next
      },
    },
    formatHuman: {
      'conversations.get': (ctx, result) => {
        printConversationRecord(ctx, result)
      },
      'conversations.create': (ctx, result) => {
        printConversationRecord(ctx, result)
      },
      'conversations.update': (ctx, result) => {
        printConversationRecord(ctx, result)
      },
    },
    customHandlers: {
      'conversations list': {
        description:
          'List conversations (GET /api/conversations; top-level human conversations by default, --owned-by helmx lists automated sessions, --all includes everything, --parent filters direct children)',
        flags: LIST_FLAGS,
        async run(ctx: CommandContext) {
          assertNoExtraPositionals(ctx.positionals, 0)
          const query = new URLSearchParams()
          const profile = flagValue<string>(ctx.flags, 'profile')
          const status = flagValue<string>(ctx.flags, 'status')
          const tag = flagValue<string>(ctx.flags, 'tag')
          const ownedBy = flagValue<string>(ctx.flags, 'owned-by')
          const all = ctx.flags.get('all') === true
          const topLevel = flagValue<boolean>(ctx.flags, 'top-level')
          const parent = flagValue<number>(ctx.flags, 'parent')
          if (all && ctx.flags.has('parent')) {
            throw new CliError(
              '--all and --parent are mutually exclusive: cannot list all conversations and filter direct children at the same time',
              'invalid_flag_value',
            )
          }
          if (topLevel === true && ctx.flags.has('parent')) {
            throw new CliError(
              '--top-level and --parent are mutually exclusive: cannot filter top-level conversations and direct children at the same time',
              'invalid_flag_value',
            )
          }
          if (topLevel === true && all) {
            throw new CliError('--top-level and --all are mutually exclusive', 'invalid_flag_value')
          }
          if (parent !== undefined) {
            if (!Number.isSafeInteger(parent) || parent < 1) {
              throw new CliError(`--parent must be a positive integer conversation ID, got "${parent}"`, 'invalid_flag_value')
            }
            query.set('parent', String(parent))
          } else if (all) {
            query.set('all', '1')
          }
          if (profile !== undefined) query.set('profileId', profile)
          if (status !== undefined) {
            if (!['working', 'blocked', 'done', 'idle', 'error'].includes(status)) {
              throw new CliError(`--status must be working|blocked|done|idle|error, got "${status}"`, 'invalid_flag_value')
            }
            query.set('status', status)
          }
          if (tag !== undefined) query.set('tag', tag)
          if (ownedBy !== undefined) {
            if (ownedBy !== 'human' && ownedBy !== 'helmx') {
              throw new CliError(`--owned-by must be human|helmx, got "${ownedBy}"`, 'invalid_flag_value')
            }
            query.set('ownedBy', ownedBy)
          }
          if (topLevel !== undefined) {
            query.set('topLevelOnly', topLevel ? '1' : '0')
          }
          const qs = query.size > 0 ? `?${query.toString()}` : ''
          const hub = await ctx.hub()
          const list = await hub.get<ConversationSummary[]>(`/api/conversations${qs}`)
          if (ctx.json || !Array.isArray(list)) {
            printResult(ctx, list)
            return
          }
          const nowMs = Date.now()
          printTableColumns(ctx.io, list, [
            { label: 'id', value: (c) => String(c.id) },
            { label: 'status', value: (c) => c.status ?? '' },
            { label: 'timing', value: (c) => formatConversationTiming(c, nowMs) },
            { label: 'profile', value: (c) => c.profileId ?? '' },
            { label: 'node', value: (c) => c.nodeId ?? 'local' },
            { label: 'title', value: (c) => c.title ?? '' },
          ])
        },
      },

      'conversations entry': {
        description:
          'Get a single timeline entry (GET /api/conversations/:id/entries/:entryId; returns full untruncated entry)',
        flags: convFlags,
        positional: '[id] <entryId>',
        async run(ctx: CommandContext) {
          const first = ctx.positionals[0]
          const second = ctx.positionals[1]
          assertNoExtraPositionals(ctx.positionals, 2)
          if (second === undefined && first === undefined) {
            throw new CliError(
              'missing <entryId> positional argument ([id] <entryId>; use --current for target conversation)',
              'missing_positional',
            )
          }
          // Single positional means entryId: conversation target must come from --current (or env).
          const id = resolveConversationTarget(ctx.flags, second === undefined ? undefined : first, ctx.env)
          const entryId = parsePositiveInt((second ?? first) as string, 'entryId')
          const hub = await ctx.hub()
          printResult(ctx, await hub.get<unknown>(`/api/conversations/${id}/entries/${entryId}`))
        },
      },

      'conversations delete': {
        description:
          'Delete one or more conversations (POST /api/conversations/bulk-delete; cascades derived child conversations; plugin-managed conversations are protected and reported per item)',
        flags: convFlags,
        positional: '[id...]',
        async run(ctx: CommandContext) {
          const ids = resolveConversationTargets(ctx.flags, ctx.positionals, ctx.env)
          // Self-delete guard: HELMX_ENV is a fail-closed managed binding absent from human terminals,
          // so HELMX_ENV=1 + a target matching HELMX_CONVERSATION_ID reliably means "this process is a
          // tool exec of the very conversation being deleted" — reject up front.
          assertNotSelfTarget(
            ctx.env,
            ids,
            'self_delete_forbidden',
            (selfId) =>
              `refusing to delete conversation #${selfId}: it is the conversation executing this command (the turn would be aborted mid-delete); delete it from the Web UI or a human terminal, or unset HELMX_ENV if this really is an interactive terminal`,
          )
          const hub = await ctx.hub()
          const result = await hub.post<ConversationBulkDeleteResponse>('/api/conversations/bulk-delete', { ids })
          if (ctx.json) {
            ctx.io.out(`${JSON.stringify(result)}\n`)
          } else {
            for (const id of result.deleted) ctx.io.out(`#${id} deleted\n`)
            for (const failure of result.failures) {
              ctx.io.err(`#${failure.id} failed [${failure.code}]: ${failure.message}\n`)
            }
            ctx.io.out(`deleted ${result.deleted.length}, failed ${result.failures.length}\n`)
          }
          return result.failures.length > 0 ? 1 : 0
        },
      },
    },
    extraCommands: [CONVERSATIONS_FILE_COMMAND],
  })
}
