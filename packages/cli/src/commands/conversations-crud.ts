/**
 * Conversation CRUD and workspace file read commands:
 * list / get / entry / file / create / update / delete.
 */
import type { ConversationBulkDeleteResponse, ConversationSummary } from '@helmx/protocol'
import { flagValue } from '../args.js'
import { CliError } from '../errors.js'
import { printTableColumns } from '../output.js'
import { formatConversationTiming } from '../timing.js'
import { convFlags, printConversationRecord } from './conversations-shared.js'
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

export function conversationCrudCommands(): CommandSpec[] {
  return [
    {
      path: ['conversations', 'list'],
      description:
        'List conversations (GET /api/conversations; top-level human conversations by default, --owned-by helmx lists automated sessions, --all includes everything, --parent filters direct children)',
      flags: [
        { name: 'profile', type: 'string', help: 'filter by profileId' },
        { name: 'status', type: 'string', help: 'filter by status (working|blocked|done|idle|error)' },
        { name: 'tag', type: 'string', help: 'filter by tag' },
        { name: 'owned-by', type: 'string', help: 'filter by ownership (human|helmx; defaults to human unless --all, --parent, or --tag is given)' },
        { name: 'all', type: 'boolean', help: 'list all conversations (including subagent/derived children and automated sessions)' },
        { name: 'parent', type: 'number', help: 'list only direct child conversations of this conversation' },
      ],
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const query = new URLSearchParams()
        const profile = flagValue<string>(ctx.flags, 'profile')
        const status = flagValue<string>(ctx.flags, 'status')
        const tag = flagValue<string>(ctx.flags, 'tag')
        const ownedBy = flagValue<string>(ctx.flags, 'owned-by')
        const all = ctx.flags.get('all') === true
        const parent = flagValue<number>(ctx.flags, 'parent')
        if (all && ctx.flags.has('parent')) {
          throw new CliError('--all and --parent are mutually exclusive: cannot list all conversations and filter direct children at the same time', 'invalid_flag_value')
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

    {
      path: ['conversations', 'get'],
      description: 'Get conversation details (GET /api/conversations/:id; includes paginated timeline)',
      flags: [
        ...convFlags,
        { name: 'limit', type: 'number', help: 'maximum timeline entries to return (1..500; mutually exclusive with --turns)' },
        { name: 'turns', type: 'number', help: 'turn-aligned pagination count (1..50; mutually exclusive with --limit)' },
        { name: 'cursor', type: 'string', help: 'pagination cursor (pass back nextCursor from previous response)' },
      ],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const query = new URLSearchParams()
        const limit = flagValue<number>(ctx.flags, 'limit')
        const turns = flagValue<number>(ctx.flags, 'turns')
        const cursor = flagValue<string>(ctx.flags, 'cursor')
        if (limit !== undefined && turns !== undefined) {
          throw new CliError('--limit and --turns are mutually exclusive', 'invalid_flag_value')
        }
        if (limit !== undefined) {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new CliError(`--limit must be an integer between 1 and 500, got "${limit}"`, 'invalid_flag_value')
          }
          query.set('limit', String(limit))
        }
        if (turns !== undefined) {
          if (!Number.isSafeInteger(turns) || turns < 1 || turns > 50) {
            throw new CliError(`--turns must be an integer between 1 and 50, got "${turns}"`, 'invalid_flag_value')
          }
          query.set('turns', String(turns))
        }
        if (cursor !== undefined) query.set('cursor', cursor)
        const qs = query.size > 0 ? `?${query.toString()}` : ''
        const hub = await ctx.hub()
        printConversationRecord(ctx, await hub.get<unknown>(`/api/conversations/${id}${qs}`))
      },
    },

    {
      path: ['conversations', 'entry'],
      description: 'Get a single timeline entry (GET /api/conversations/:id/entries/:entryId; returns full untruncated entry)',
      flags: convFlags,
      positional: '[id] <entryId>',
      async run(ctx: CommandContext) {
        const first = ctx.positionals[0]
        const second = ctx.positionals[1]
        assertNoExtraPositionals(ctx.positionals, 2)
        if (second === undefined && first === undefined) {
          throw new CliError('missing <entryId> positional argument ([id] <entryId>; use --current for target conversation)', 'missing_positional')
        }
        // Single positional means entryId: conversation target must come from --current (or env).
        const id = resolveConversationTarget(ctx.flags, second === undefined ? undefined : first, ctx.env)
        const entryId = parsePositiveInt((second ?? first) as string, 'entryId')
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<unknown>(`/api/conversations/${id}/entries/${entryId}`))
      },
    },

    {
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
          throw new CliError('missing <path> positional argument ([id] <path>, or pass --current for the conversation target)', 'missing_positional')
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
    },

    {
      path: ['conversations', 'create'],
      description: 'Create a conversation (POST /api/conversations; --node binds a compute node)',
      flags: [
        { name: 'title', type: 'string' },
        { name: 'profile-id', type: 'string' },
        { name: 'node', type: 'string', help: 'compute node ID to bind (inherits from Profile or local by default)' },
        { name: 'cwd', type: 'string' },
        { name: 'model', type: 'string' },
        { name: 'tags', type: 'string', help: 'JSON array or comma-separated' },
        { name: 'parent-conversation-id', type: 'number', help: 'parent conversation ID for creating a derived child conversation' },
      ],
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const body: Record<string, unknown> = {}
        for (const [flag, key] of [
          ['title', 'title'],
          ['profile-id', 'profileId'],
          ['node', 'nodeId'],
          ['cwd', 'cwd'],
          ['model', 'model'],
        ] as const) {
          const v = flagValue<string>(ctx.flags, flag)
          if (v !== undefined) body[key] = v
        }
        const tags = flagValue<string>(ctx.flags, 'tags')
        if (tags !== undefined) body.tags = coerceTags(tags)
        const parentConversationId = flagValue<number>(ctx.flags, 'parent-conversation-id')
        if (parentConversationId !== undefined) {
          if (!Number.isSafeInteger(parentConversationId) || parentConversationId <= 0) {
            throw new CliError(
              `--parent-conversation-id must be a positive integer, got "${parentConversationId}"`,
              'invalid_flag_value',
            )
          }
          body.parentConversationId = parentConversationId
        }
        const hub = await ctx.hub()
        printConversationRecord(ctx, await hub.post<ConversationSummary>('/api/conversations', body))
      },
    },

    {
      path: ['conversations', 'update'],
      description: 'Update a conversation (PATCH /api/conversations/:id; --node switches compute node)',
      flags: [
        ...convFlags,
        { name: 'title', type: 'string' },
        { name: 'model', type: 'string', help: 'explicit model override provider/model; empty string (--model= or --model "") clears override and recomputes inheritance chain' },
        { name: 'thinking', type: 'string', help: 'thinking level off/minimal/low/medium/high/xhigh/max; empty string clears override and inherits Profile/global' },
        { name: 'profile-id', type: 'string' },
        { name: 'node', type: 'string', help: 'switch bound compute node ID' },
        { name: 'cwd', type: 'string', help: 'switch working directory on the target node' },
        { name: 'tags', type: 'string', help: 'replace conversation tags (JSON array or comma-separated; empty string or [] clears)' },
        { name: 'pinned', type: 'boolean' },
        { name: 'unread', type: 'boolean' },
      ],
      positional: '[id]',
      async run(ctx: CommandContext) {
        const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
        assertNoExtraPositionals(ctx.positionals, 1)
        const body: Record<string, unknown> = {}
        for (const [flag, key] of [
          ['title', 'title'],
          ['model', 'model'],
          ['profile-id', 'profileId'],
          ['node', 'nodeId'],
          ['cwd', 'cwd'],
          ['thinking', 'thinkingLevel'],
        ] as const) {
          const v = flagValue<string>(ctx.flags, flag)
          if (v !== undefined) body[key] = v
        }
        const tags = flagValue<string>(ctx.flags, 'tags')
        if (tags !== undefined) body.tags = coerceTags(tags)
        for (const key of ['pinned', 'unread'] as const) {
          const v = ctx.flags.get(key)
          if (v !== undefined) body[key] = v
        }
        if (Object.keys(body).length === 0) {
          throw new CliError('no update fields provided (--title/--model/--thinking/--profile-id/--node/--cwd/--tags/--pinned/--unread)', 'missing_update_fields')
        }
        const hub = await ctx.hub()
        printConversationRecord(ctx, await hub.patch<ConversationSummary>(`/api/conversations/${id}`, body))
      },
    },

    {
      path: ['conversations', 'delete'],
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
          for (const failure of result.failures) ctx.io.err(`#${failure.id} failed [${failure.code}]: ${failure.message}\n`)
          ctx.io.out(`deleted ${result.deleted.length}, failed ${result.failures.length}\n`)
        }
        return result.failures.length > 0 ? 1 : 0
      },
    },
  ]
}
