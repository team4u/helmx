/**
 * Plugin document subscription and compiled client bundle inspection commands (`plugins doc`, `plugins client`).
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isPlainObject, PLUGIN_CORE_OPERATIONS } from '@helmx/protocol'
import { CliError } from '../errors.js'
import type { HubClient } from '../hub-client.js'
import { printValue } from '../output.js'
import { watchJsonSse } from '../stream.js'
import { schemaFlagsForOperation } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  printPlainText,
  printResult,
  requirePositional,
  resolveConversationTarget,
} from './shared.js'

/**
 * Session document subscription (--watch): consumes dedicated SSE (GET /api/plugins/:id/docs/:name/events?conversationId=N).
 * - --json: emits NDJSON per frame (both snapshot and incremental frames verbatim);
 * - human mode: snapshot prints current value; incremental frames print a change summary line + new value;
 * - 404 on connect (plugin disabled / conversation deleted / document not public) fails explicitly and stops without retrying.
 */
async function watchSessionDoc(
  ctx: CommandContext,
  hub: HubClient,
  base: string,
  conversationId: number,
  pluginId: string,
  name: string,
): Promise<void> {
  const label = `${pluginId}/${name}#conversation-${conversationId}`
  await watchJsonSse(hub, ctx.io, `${base}/events?conversationId=${conversationId}`, (event, payload) => {
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
      return
    }
    if (event === 'snapshot') {
      const doc = isPlainObject(payload) && isPlainObject(payload['doc']) ? payload['doc'] : undefined
      ctx.io.out(`[${label}] snapshot\n`)
      printValue(ctx.io, doc?.['value'] ?? null, false)
      return
    }
    const seq = isPlainObject(payload) && typeof payload['seq'] === 'number' ? payload['seq'] : '?'
    const innerEvent = isPlainObject(payload) && isPlainObject(payload['event']) ? payload['event'] : undefined
    const doc = innerEvent && isPlainObject(innerEvent['doc']) ? innerEvent['doc'] : undefined
    ctx.io.out(`[${label}] update seq=${seq}${doc?.['deleted'] === true ? ' (deleted)' : ''}\n`)
    printValue(ctx.io, doc?.['value'] ?? null, false)
  })
}

async function writeTextFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath)
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
  try {
    await fsp.writeFile(tmpPath, content, 'utf8')
    await fsp.rename(tmpPath, targetPath)
  } catch (err) {
    try {
      await fsp.rm(tmpPath, { force: true })
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof Error) || (cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CliError(
          `failed to write ${targetPath} (${err instanceof Error ? err.message : String(err)}; cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`,
          'write_failed',
        )
      }
    }
    throw new CliError(
      `failed to write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      'write_failed',
    )
  }
}

const PLUGIN_DOC_SPEC = PLUGIN_CORE_OPERATIONS.find((op) => op.key === 'plugins.doc')!
const DOC_SCHEMA_FLAGS = new Map(
  schemaFlagsForOperation(PLUGIN_DOC_SPEC).map((flag) => [flag.name, flag] as const),
)

export const pluginsDocCommand: CommandSpec = {
  path: ['plugins', 'doc'],
  description:
    'Read a public plugin document (GET /api/plugins/:id/docs/:name; --conversation/--current reads a session doc; --watch subscribes to session doc SSE)',
  flags: [
    {
      ...(DOC_SCHEMA_FLAGS.get('conversation') ?? { name: 'conversation', type: 'number' as const }),
      help: 'target conversation ID for session document (mutually exclusive with --current)',
    },
    { name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID from environment (mutually exclusive with --conversation)' },
    { name: 'watch', type: 'boolean', help: 'subscribe to dedicated SSE for a session document (requires --conversation/--current; Ctrl-C to exit)' },
  ],
  positional: '<pluginId> <name>',
  async run(ctx: CommandContext) {
    const pluginId = ctx.positionals[0]
    const name = ctx.positionals[1]
    if (pluginId === undefined || name === undefined) {
      throw new CliError('missing positional arguments: plugins doc <pluginId> <name>', 'missing_id')
    }
    assertNoExtraPositionals(ctx.positionals, 2)
    const hasConversation = ctx.flags.has('conversation')
    const hasCurrent = ctx.flags.get('current') === true
    if (hasConversation && hasCurrent) {
      throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
    }
    let conversationId: number | undefined
    if (hasConversation) {
      const value = ctx.flags.get('conversation')
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new CliError('--conversation must be a positive integer conversation ID', 'invalid_flag_value')
      }
      conversationId = value
    } else if (hasCurrent) {
      conversationId = resolveConversationTarget(ctx.flags, undefined, ctx.env)
    }
    const base = `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`
    const hub = await ctx.hub()
    if (ctx.flags.get('watch') === true) {
      if (conversationId === undefined) {
        throw new CliError('--watch requires a target conversation (--conversation <id> or --current)', 'missing_conversation_target')
      }
      await watchSessionDoc(ctx, hub, base, conversationId, pluginId, name)
      return
    }
    const reqPath = conversationId === undefined ? base : `${base}?conversationId=${conversationId}`
    const doc = await hub.get<{
      pluginId: string
      name: string
      conversationId?: number
      value: unknown
      deleted?: boolean
    }>(reqPath)
    if (ctx.json) {
      printResult(ctx, doc)
      return
    }
    // Human mode: document name + value (preserve JSON fidelity; print string values verbatim)
    if (typeof doc.value === 'string') {
      ctx.io.out(`${doc.name}\n`)
      printPlainText(ctx, doc.value)
      return
    }
    printValue(ctx.io, doc.value, false)
  },
}

export const pluginsClientCommand: CommandSpec = {
  path: ['plugins', 'client'],
  description: 'Fetch compiled plugin client.tsx bundle (GET /api/plugins/:id/client.mjs?module=...; --module defaults to client.tsx)',
  flags: [
    { name: 'module', type: 'string', help: 'module path relative to plugin clientRoot (defaults to client.tsx)' },
    { name: 'chunk', type: 'string', help: 'optional chunk filename (e.g. vendor.js)' },
    { name: 'output', type: 'string', help: 'write output to file path (defaults to stdout; still writes file and prints metadata with --json)' },
  ],
  positional: '<id>',
  async run(ctx: CommandContext) {
    const id = requirePositional(ctx.positionals, 0, 'id')
    assertNoExtraPositionals(ctx.positionals, 1)
    const moduleRef = (ctx.flags.get('module') as string | undefined) ?? 'client.tsx'
    const chunk = ctx.flags.get('chunk') as string | undefined
    if (ctx.flags.has('output') && typeof ctx.flags.get('output') !== 'string') {
      throw new CliError('--output requires a file path', 'invalid_flag_value')
    }
    const outPathRaw = ctx.flags.get('output') as string | undefined
    const resolvedOutPath = outPathRaw !== undefined ? path.resolve(ctx.cwd, outPathRaw) : undefined
    const hub = await ctx.hub()
    let reqPath = `/api/plugins/${encodeURIComponent(id)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
    if (chunk !== undefined) reqPath += `&chunk=${encodeURIComponent(chunk)}`
    const response = await hub.raw(reqPath)
    const code = await response.text()
    const byteLength = Buffer.byteLength(code, 'utf8')
    const contentHash = response.headers.get('x-helmx-client-hash') ?? ''
    if (resolvedOutPath !== undefined) {
      await writeTextFileAtomic(resolvedOutPath, code)
    }
    if (ctx.json) {
      printResult(ctx, {
        pluginId: id,
        module: moduleRef,
        ...(chunk !== undefined ? { chunk } : {}),
        contentHash,
        bytes: byteLength,
        ...(resolvedOutPath !== undefined ? { outputPath: resolvedOutPath } : {}),
      })
      return
    }
    if (resolvedOutPath !== undefined) {
      ctx.io.out(`wrote ${resolvedOutPath} (${byteLength} bytes, hash ${contentHash})\n`)
      return
    }
    ctx.io.out(code)
  },
}
