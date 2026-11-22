/**
 * Conversation commands: conversations list/get/create/update/delete/reset/compact/fork,
 * send, abort, and events watch. create/update support --node <nodeId> to bind a compute node.
 */
import type {
  ConversationBulkDeleteResponse,
  ConversationStatus,
  ConversationSummary,
  ConversationDeletedEvent,
  ConversationUpsertEvent,
} from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue, type FlagSpec } from '../args.js'
import { printTableColumns } from '../output.js'
import { watchJsonSse } from '../stream.js'
import { formatConversationTiming, formatDurationMs, projectConversationForHuman } from '../timing.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  coerceTags,
  enumFlag,
  parsePositiveInt,
  printPlainText,
  printResult,
  requirePositional,
  resolveConversationTarget,
  resolveConversationTargets,
  validateEnum,
  writeDownloadedOutput,
} from './shared.js'

const WHEN_BUSY = ['steer', 'followUp', 'reject'] as const
const ORIGINS = ['human', 'agent', 'trigger'] as const

const convFlags: FlagSpec[] = [{ name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID from environment' }]

export function conversationsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  // ---- events watch (global SSE, shares print helpers with conversations) ----
  cmds.push({
    path: ['events', 'watch'],
    description: 'Subscribe to the global SSE event stream (GET /api/events; initial snapshot + incremental updates)',
    async run(ctx: CommandContext) {
      const hub = await ctx.hub()
      await watchJsonSse(hub, ctx.io, '/api/events', (event, payload) => {
        if (ctx.json) {
          // NDJSON: emit snapshot and incremental frames verbatim (one JSON value per line)
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          const snap = payload as { seq?: number; conversations?: unknown[]; pendingAsks?: unknown[]; plugins?: unknown[] }
          ctx.io.out(
            `snapshot seq=${snap.seq ?? '?'} conversations=${snap.conversations?.length ?? 0} pendingAsks=${snap.pendingAsks?.length ?? 0} plugins=${snap.plugins?.length ?? 0}\n`,
          )
          return
        }
        ctx.io.out(`${summarizeEvent(payload)}\n`)
      })
    },
  })

  // ---- conversations list ----
  cmds.push({
    path: ['conversations', 'list'],
    description: 'List conversations (GET /api/conversations; top-level only by default, --all includes child conversations, --parent filters direct children)',
    flags: [
      { name: 'profile', type: 'string', help: 'filter by profileId' },
      { name: 'status', type: 'string', help: 'filter by status (working|blocked|done|idle|error)' },
      { name: 'tag', type: 'string', help: 'filter by tag' },
      { name: 'all', type: 'boolean', help: 'list all conversations (including subagent/derived child conversations; top-level only by default)' },
      { name: 'parent', type: 'number', help: 'list only direct child conversations of this conversation' },
    ],
    async run(ctx: CommandContext) {
      assertNoExtraPositionals(ctx.positionals, 0)
      const query = new URLSearchParams()
      const profile = flagValue<string>(ctx.flags, 'profile')
      const status = flagValue<string>(ctx.flags, 'status')
      const tag = flagValue<string>(ctx.flags, 'tag')
      const all = ctx.flags.get('all') === true
      const parent = flagValue<number>(ctx.flags, 'parent')
      if (all && ctx.flags.has('parent')) {
        throw new CliError('--all and --parent are mutually exclusive: cannot list all conversations and filter direct children at the same time', 'invalid_flag_value')
      }
      if (parent !== undefined) {
        if (!Number.isInteger(parent) || parent < 1) {
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
  })

  // ---- conversations get ----
  cmds.push({
    path: ['conversations', 'get'],
    description: 'Get conversation details (GET /api/conversations/:id; includes paginated timeline)',
    flags: [
      ...convFlags,
      { name: 'limit', type: 'number', help: 'maximum timeline entries to return (default 50)' },
      { name: 'cursor', type: 'string', help: 'pagination cursor (pass back nextCursor from previous response)' },
    ],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
      assertNoExtraPositionals(ctx.positionals, 1)
      const query = new URLSearchParams()
      const limit = flagValue<number>(ctx.flags, 'limit')
      const cursor = flagValue<string>(ctx.flags, 'cursor')
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new CliError(`--limit must be a positive integer, got "${limit}"`, 'invalid_flag_value')
        }
        query.set('limit', String(limit))
      }
      if (cursor !== undefined) query.set('cursor', cursor)
      const qs = query.size > 0 ? `?${query.toString()}` : ''
      const hub = await ctx.hub()
      printConversationRecord(ctx, await hub.get<unknown>(`/api/conversations/${id}${qs}`))
    },
  })

  // ---- conversations entry (full text of a single timeline entry) ----
  cmds.push({
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
  })

  // ---- conversations file (workspace file read) ----
  cmds.push({
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
        baseMime === 'image/svg+xml' ||
        baseMime === 'text/yaml'
      if (!isText) {
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
  })

  // ---- conversations create (supports --node to bind a compute node) ----
  cmds.push({
    path: ['conversations', 'create'],
    description: 'Create a conversation (POST /api/conversations; --node binds a compute node)',
    flags: [
      { name: 'title', type: 'string' },
      { name: 'profile-id', type: 'string' },
      { name: 'node', type: 'string', help: 'compute node ID to bind (inherits from Profile or local by default)' },
      { name: 'cwd', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'tags', type: 'string', help: 'JSON array or comma-separated' },
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
      const hub = await ctx.hub()
      printConversationRecord(ctx, await hub.post<ConversationSummary>('/api/conversations', body))
    },
  })

  // ---- conversations update (supports --node to switch compute node) ----
  cmds.push({
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
      for (const key of ['pinned', 'unread'] as const) {
        const v = ctx.flags.get(key)
        if (v !== undefined) body[key] = v
      }
      if (Object.keys(body).length === 0) {
        throw new CliError('no update fields provided (--title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread)', 'missing_update_fields')
      }
      const hub = await ctx.hub()
      printConversationRecord(ctx, await hub.patch<ConversationSummary>(`/api/conversations/${id}`, body))
    },
  })

  // ---- conversations delete (single or bulk; always one bulk-delete request) ----
  cmds.push({
    path: ['conversations', 'delete'],
    description:
      'Delete one or more conversations (POST /api/conversations/bulk-delete; cascades derived child conversations; plugin-managed conversations are protected and reported per item)',
    flags: convFlags,
    positional: '[id...]',
    async run(ctx: CommandContext) {
      const ids = resolveConversationTargets(ctx.flags, ctx.positionals, ctx.env)
      // Self-delete guard: HELMX_ENV is a fail-closed managed binding absent from human terminals,
      // so HELMX_ENV=1 + a target matching HELMX_CONVERSATION_ID reliably means "this process is a
      // tool exec of the very conversation being deleted" — the server would abort the executing
      // turn mid-command, cutting the batch (and this reply) in half. Reject up front.
      if (ctx.env['HELMX_ENV'] === '1') {
        const selfId = Number(ctx.env['HELMX_CONVERSATION_ID'])
        if (Number.isSafeInteger(selfId) && selfId > 0 && ids.includes(selfId)) {
          throw new CliError(
            `refusing to delete conversation #${selfId}: it is the conversation executing this command (the turn would be aborted mid-delete); delete it from the Web UI or a human terminal, or unset HELMX_ENV if this really is an interactive terminal`,
            'self_delete_forbidden',
          )
        }
      }
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
  })

  // ---- conversations reset ----
  cmds.push({
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
  })

  // ---- conversations compact ----
  cmds.push({
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
  })

  // ---- conversations fork ----
  cmds.push({
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
  })

  // ---- send ----
  cmds.push({
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
        if (!Number.isInteger(replaceFrom) || replaceFrom <= 0) {
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
  })

  // ---- conversations withdraw ----
  cmds.push({
    path: ['conversations', 'withdraw'],
    description: 'Withdraw a queued input (POST /api/conversations/:id/withdraw)',
    flags: [...convFlags, { name: 'submission-id', type: 'number', required: true, help: 'queued submission ID to withdraw' }],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const id = resolveConversationTarget(ctx.flags, ctx.positionals[0], ctx.env)
      assertNoExtraPositionals(ctx.positionals, 1)
      const submissionId = flagValue<number>(ctx.flags, 'submission-id')
      if (submissionId === undefined || !Number.isInteger(submissionId) || submissionId <= 0) {
        throw new CliError('--submission-id must be a positive integer', 'invalid_flag_value')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/conversations/${id}/withdraw`, { submissionId }))
    },
  })

  // ---- abort ----
  cmds.push({
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
  })

  // ---- conversations watch (block until the current turn settles) ----
  // No --current by design: watching the conversation whose turn executes this command is a
  // circular wait (the turn cannot settle while this tool call is blocked), so the id is a
  // required positional and the managed-env guard below fails fast on self-watch.
  cmds.push({
    path: ['conversations', 'watch'],
    description:
      'Watch a conversation by id until its current turn settles (global SSE; exit 0 on done/idle, 1 on error, 124 on --timeout; self-watch is rejected)',
    flags: [
      { name: 'timeout', type: 'number', help: 'give up after this many milliseconds and exit 124' },
      { name: 'quiet', type: 'boolean', help: 'print only the final result line (scripting)' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = parsePositiveInt(
        requirePositional(ctx.positionals, 0, 'id', 'missing_conversation_target'),
        'conversation ID',
      )
      assertNoExtraPositionals(ctx.positionals, 1)
      const timeoutMs = flagValue<number>(ctx.flags, 'timeout')
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new CliError(`--timeout must be a positive integer (milliseconds), got "${timeoutMs}"`, 'invalid_flag_value')
      }
      // Self-watch guard: HELMX_ENV is a fail-closed managed binding absent from human terminals,
      // so HELMX_ENV=1 + matching HELMX_CONVERSATION_ID reliably means "this process is a tool exec
      // of the very conversation being watched" — a guaranteed deadlock, rejected up front.
      if (ctx.env['HELMX_ENV'] === '1') {
        const selfId = Number(ctx.env['HELMX_CONVERSATION_ID'])
        if (Number.isSafeInteger(selfId) && selfId > 0 && selfId === id) {
          throw new CliError(
            `refusing to watch conversation #${id}: it is the conversation executing this command (circular wait — the turn cannot settle while this tool call is blocked); watch a different conversation, or unset HELMX_ENV if this really is an interactive terminal`,
            'self_watch_forbidden',
          )
        }
      }
      const quiet = ctx.flags.get('quiet') === true
      const hub = await ctx.hub()

      const startedAt = Date.now()
      let snapshotSeen = false
      let missing = false
      let deleted = false
      let settled: ConversationStatus | undefined
      let lastStatus: ConversationStatus | undefined
      let lastDoing: string | undefined
      let summary: ConversationSummary | undefined

      const progress = (text: string, jsonValue: Record<string, unknown>): void => {
        if (quiet) return
        if (ctx.json) ctx.io.out(`${JSON.stringify(jsonValue)}\n`)
        else ctx.io.out(`${text}\n`)
      }
      const applySummary = (next: ConversationSummary, abort: () => void): void => {
        summary = next
        if (next.status !== lastStatus) {
          const from = lastStatus
          lastStatus = next.status
          if (from === undefined) {
            const timing = formatConversationTiming(next, Date.now())
            const timingSuffix = timing ? ` — ${timing}` : ''
            progress(`watching #${next.id} ${next.title} (${next.status})${timingSuffix}`, { type: 'watch', conversation: next })
          } else {
            progress(`[${clock(new Date())}] status: ${from} -> ${next.status}`, { type: 'status', conversationId: next.id, status: next.status })
          }
        }
        if (next.doing !== lastDoing) {
          lastDoing = next.doing
          if (next.doing) progress(`  doing: ${next.doing}`, { type: 'doing', conversationId: next.id, doing: next.doing })
        }
        if (WATCH_SETTLED_STATUSES.has(next.status)) {
          settled = next.status
          abort()
        }
      }

      const outcome = await watchJsonSse(
        hub,
        ctx.io,
        '/api/events',
        (event, payload, stream) => {
          if (settled !== undefined || deleted || missing) return
          if (event === 'snapshot') {
            snapshotSeen = true
            const snap = payload as { conversations?: unknown }
            const found = Array.isArray(snap.conversations)
              ? (snap.conversations as ConversationSummary[]).find((c) => c?.id === id)
              : undefined
            if (!found) {
              missing = true
              stream.abort()
              return
            }
            applySummary(found, stream.abort)
            return
          }
          const inner = (payload as { event?: { type?: string } }).event
          if (inner?.type === 'conversation.upsert') {
            const conversation = (inner as unknown as ConversationUpsertEvent).conversation
            if (conversation && conversation.id === id) applySummary(conversation, stream.abort)
            return
          }
          if (inner?.type === 'conversation.deleted') {
            if ((inner as unknown as ConversationDeletedEvent).conversationId === id) {
              deleted = true
              stream.abort()
            }
          }
        },
        { timeoutMs },
      )

      if (outcome.cancelled) return 0
      if (deleted) {
        throw new CliError(`conversation #${id} was deleted while watching`, 'conversation_deleted')
      }
      if (!snapshotSeen) {
        if (outcome.timedOut) throw new CliError(`conversation #${id} did not settle within ${timeoutMs}ms (no snapshot received)`, 'watch_timeout', 124)
        throw new CliError('event stream ended before the snapshot frame arrived', 'stream_closed')
      }
      if (missing) {
        throw new CliError(`conversation #${id} not found in the snapshot (it may have been deleted already)`, 'conversation_not_found')
      }
      if (settled === undefined) {
        const doingSuffix = lastDoing ? `, doing: ${lastDoing}` : ''
        if (outcome.timedOut) {
          throw new CliError(`conversation #${id} did not settle within ${timeoutMs}ms (last status: ${lastStatus ?? '?'}${doingSuffix})`, 'watch_timeout', 124)
        }
        throw new CliError(`event stream ended before conversation #${id} settled (last status: ${lastStatus ?? '?'})`, 'stream_closed')
      }

      // Settled: the final line is always printed (even with --quiet) so scripted consumers keep the outcome.
      const elapsedMs = Math.max(0, Date.now() - startedAt)
      const totalRunMs =
        typeof summary?.runDurationMs === 'number' && Number.isFinite(summary.runDurationMs) && summary.runDurationMs > 0
          ? summary.runDurationMs
          : undefined
      if (ctx.json) {
        const result: Record<string, unknown> = { type: 'result', conversationId: id, status: settled, elapsedMs }
        if (typeof summary?.runDurationMs === 'number' && Number.isFinite(summary.runDurationMs) && summary.runDurationMs >= 0) {
          result.runDurationMs = summary.runDurationMs
        }
        if (settled === 'error' && summary?.lastError !== undefined) result.lastError = summary.lastError
        ctx.io.out(`${JSON.stringify(result)}\n`)
      } else {
        const errorSuffix = settled === 'error' && summary?.lastError ? ` — ${summary.lastError}` : ''
        const totalSuffix = totalRunMs !== undefined ? `, total ${formatDurationMs(totalRunMs)}` : ''
        ctx.io.out(`#${id} ${summary?.title ?? ''} settled: ${settled}${errorSuffix} (in ${formatDurationMs(elapsedMs)}${totalSuffix})\n`)
      }
      return settled === 'error' ? 1 : 0
    },
  })

  return cmds
}

/**
 * Render a single conversation summary/detail object: `--json` emits raw server fields untouched
 * (preserving `runDurationMs`, `runStartedAt`, `pendingAskSince`); human mode synthesizes a clean
 * `timing` field when timing data exists and omits raw epoch/ms fields.
 */
function printConversationRecord(ctx: CommandContext, value: unknown): void {
  if (ctx.json || value === null || typeof value !== 'object' || Array.isArray(value)) {
    printResult(ctx, value)
    return
  }
  printResult(ctx, projectConversationForHuman(value as Record<string, unknown>, Date.now()))
}

/** Turn-terminal statuses for `conversations watch`: blocked keeps waiting (an Ask may still resolve it). */
const WATCH_SETTLED_STATUSES = new Set<ConversationStatus>(['done', 'idle', 'error'])

/** Local wall-clock time as HH:MM:SS (display-only progress prefix). */
function clock(date: Date): string {
  return date.toTimeString().slice(0, 8)
}

/** Single-line human-readable summary of an incremental SSE event. */
function summarizeEvent(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload)
  const frame = payload as { seq?: unknown; event?: Record<string, unknown> & { type?: string } }
  const seq = typeof frame.seq === 'number' ? frame.seq : '?'
  const event = frame.event
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    return `${seq}  ${JSON.stringify(payload)}`
  }
  let extra = ''
  switch (event.type) {
    case 'conversation.upsert': {
      const c = event.conversation as Partial<ConversationSummary> | undefined
      const timing = c ? formatConversationTiming(c, Date.now()) : ''
      extra = `#${c?.id ?? '?'} ${c?.title ?? ''} (${c?.status ?? '?'})${timing ? ` — ${timing}` : ''}`
      break
    }
    case 'conversation.deleted':
      extra = `#${String(event.conversationId ?? '?')}`
      break
    case 'ask.upsert': {
      const a = event.ask as { id?: string; title?: string } | undefined
      extra = `${a?.id ?? '?'} ${a?.title ?? ''}`
      break
    }
    case 'ask.resolved':
      extra = `${String(event.askId ?? '?')} -> ${String(event.status ?? '?')}`
      break
    case 'plugin.changed': {
      const p = event.plugin as { id?: string } | undefined
      extra = String(p?.id ?? '?')
      break
    }
    case 'notification':
      extra = String(event.title ?? '')
      break
    default:
      extra = JSON.stringify(event)
  }
  return `${seq}  ${event.type}  ${extra}`
}
