/**
 * SSE streaming watch commands (`events watch` and `conversations watch`).
 */
import { isPlainObject, type ConversationStatus } from '@helmx/protocol'
import { flagValue } from '../args.js'
import { CliError } from '../errors.js'
import { watchJsonSse } from '../stream.js'
import { formatConversationTiming, formatDurationMs, type ConversationTimingInput } from '../timing.js'
import { clock, summarizeEvent, WATCH_SETTLED_STATUSES } from './conversations-shared.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, assertNotSelfTarget, parsePositiveInt, requirePositional } from './shared.js'

interface WatchedConversationSnapshot extends ConversationTimingInput {
  id: number
  title: string
  status: ConversationStatus
  doing?: string
  lastError?: string
}

const VALID_CONVERSATION_STATUSES = new Set<string>(['working', 'blocked', 'done', 'idle', 'error'])

function isConversationStatus(value: unknown): value is ConversationStatus {
  return typeof value === 'string' && VALID_CONVERSATION_STATUSES.has(value)
}

function asWatchedConversationSnapshot(raw: unknown): WatchedConversationSnapshot | undefined {
  if (!isPlainObject(raw)) return undefined
  const id = raw['id']
  const status = raw['status']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !isConversationStatus(status)) {
    return undefined
  }
  return {
    id,
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    status,
    ...(typeof raw['doing'] === 'string' ? { doing: raw['doing'] } : {}),
    ...(typeof raw['runDurationMs'] === 'number' ? { runDurationMs: raw['runDurationMs'] } : {}),
    ...(typeof raw['runStartedAt'] === 'number' ? { runStartedAt: raw['runStartedAt'] } : {}),
    ...(typeof raw['pendingAskSince'] === 'number' ? { pendingAskSince: raw['pendingAskSince'] } : {}),
    ...(typeof raw['pendingAskCount'] === 'number' ? { pendingAskCount: raw['pendingAskCount'] } : {}),
    ...(typeof raw['lastError'] === 'string' ? { lastError: raw['lastError'] } : {}),
  }
}

export function eventsWatchCommand(): CommandSpec {
  return {
    path: ['events', 'watch'],
    description: 'Subscribe to the global SSE event stream (GET /api/events; initial snapshot + incremental updates)',
    async run(ctx: CommandContext) {
      assertNoExtraPositionals(ctx.positionals, 0)
      const hub = await ctx.hub()
      await watchJsonSse(hub, ctx.io, '/api/events', (event, payload) => {
        if (ctx.json) {
          // NDJSON: emit snapshot and incremental frames verbatim (one JSON value per line)
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          if (!isPlainObject(payload)) {
            ctx.io.out('snapshot (invalid payload)\n')
            return
          }
          const seq = typeof payload['seq'] === 'number' ? payload['seq'] : '?'
          const convCount = Array.isArray(payload['conversations']) ? payload['conversations'].length : 0
          const askCount = Array.isArray(payload['pendingAsks']) ? payload['pendingAsks'].length : 0
          const pluginCount = Array.isArray(payload['plugins']) ? payload['plugins'].length : 0
          ctx.io.out(
            `snapshot seq=${seq} conversations=${convCount} pendingAsks=${askCount} plugins=${pluginCount}\n`,
          )
          return
        }
        ctx.io.out(`${summarizeEvent(payload)}\n`)
      })
    },
  }
}

export function conversationsWatchCommand(): CommandSpec {
  // No --current by design: watching the conversation whose turn executes this command is a
  // circular wait (the turn cannot settle while this tool call is blocked), so the id is a
  // required positional and the managed-env guard below fails fast on self-watch.
  return {
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
      assertNotSelfTarget(
        ctx.env,
        [id],
        'self_watch_forbidden',
        (selfId) =>
          `refusing to watch conversation #${selfId}: it is the conversation executing this command (circular wait — the turn cannot settle while this tool call is blocked); watch a different conversation, or unset HELMX_ENV if this really is an interactive terminal`,
      )
      const quiet = ctx.flags.get('quiet') === true
      const hub = await ctx.hub()

      const startedAt = Date.now()
      let snapshotSeen = false
      let missing = false
      let deleted = false
      let settled: ConversationStatus | undefined
      let lastStatus: ConversationStatus | undefined
      let lastDoing: string | undefined
      let summary: WatchedConversationSnapshot | undefined

      const progress = (text: string, jsonValue: Record<string, unknown>): void => {
        if (quiet) return
        if (ctx.json) ctx.io.out(`${JSON.stringify(jsonValue)}\n`)
        else ctx.io.out(`${text}\n`)
      }
      const applySummary = (next: WatchedConversationSnapshot, abort: () => void): void => {
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
          if (!isPlainObject(payload)) return
          if (event === 'snapshot') {
            snapshotSeen = true
            const rawConversations = payload['conversations']
            let found: WatchedConversationSnapshot | undefined
            if (Array.isArray(rawConversations)) {
              for (const item of rawConversations) {
                const candidate = asWatchedConversationSnapshot(item)
                if (candidate !== undefined && candidate.id === id) {
                  found = candidate
                  break
                }
              }
            }
            if (!found) {
              missing = true
              stream.abort()
              return
            }
            applySummary(found, stream.abort)
            return
          }
          const inner = payload['event']
          if (!isPlainObject(inner)) return
          if (inner['type'] === 'conversation.upsert') {
            const conversation = asWatchedConversationSnapshot(inner['conversation'])
            if (conversation && conversation.id === id) applySummary(conversation, stream.abort)
            return
          }
          if (inner['type'] === 'conversation.deleted' && inner['conversationId'] === id) {
            deleted = true
            stream.abort()
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
  }
}
