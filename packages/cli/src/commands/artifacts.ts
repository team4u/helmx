/**
 * Artifact commands: artifacts list / put / get.
 *
 * `artifacts list` is driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` (`conversations.artifacts_list`)
 * via `commandsFromOperations`; binary upload (`put`) and raw download (`get`) stay outside `CORE_OPERATIONS`.
 */
import { CONVERSATION_CORE_OPERATIONS } from '@helmx/protocol'
import path from 'node:path'
import { flagValue } from '../args.js'
import { CliError } from '../errors.js'
import { printValue } from '../output.js'
import { commandsFromOperations } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  parsePositiveInt,
  pathDetails,
  pathDiagLines,
  printPlainText,
  printResult,
  requirePositional,
  resolveCallerPath,
  resolveConversationTarget,
  writeDownloadedOutput,
} from './shared.js'

const convFlags = [{ name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID from environment' }] as const

type ArtifactsListOperation = Extract<
  (typeof CONVERSATION_CORE_OPERATIONS)[number],
  { key: 'conversations.artifacts_list' }
>

const ARTIFACTS_LIST_OPERATIONS: readonly ArtifactsListOperation[] = CONVERSATION_CORE_OPERATIONS.filter(
  (op): op is ArtifactsListOperation => op.key === 'conversations.artifacts_list',
)

const ARTIFACTS_PUT_COMMAND: CommandSpec = {
  path: ['artifacts', 'put'],
  description: 'Upload a local file as a conversation artifact (POST /api/conversations/:id/artifacts)',
  flags: [
    ...convFlags,
    { name: 'name', type: 'string', help: 'custom artifact name (defaults to local filename)' },
    { name: 'mime-type', type: 'string', help: 'explicit MIME type' },
  ],
  positional: '<filePath> [id]',
  async run(ctx: CommandContext) {
    const filePath = requirePositional(ctx.positionals, 0, 'filePath', 'missing_file_path')
    const id = resolveConversationTarget(ctx.flags, ctx.positionals[1], ctx.env)
    if (ctx.positionals.length > 2) {
      throw new CliError(`unexpected positional argument: ${ctx.positionals.slice(2).join(' ')}`, 'unexpected_positional')
    }
    const fsp = await import('node:fs/promises')
    const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, filePath)
    let bytes: Uint8Array
    try {
      const st = await fsp.stat(resolvedPath)
      if (!st.isFile()) {
        throw new CliError(
          `upload source is not a regular file (directory/device)${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
          'read_failed',
          1,
          pathDetails(filePath, resolvedPath, ctx, sessionCwd),
        )
      }
      const buffer = await fsp.readFile(resolvedPath)
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (err) {
      if (err instanceof CliError) throw err
      throw new CliError(
        `failed to read upload file (${err instanceof Error ? err.message : String(err)})${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
        'read_failed',
        1,
        pathDetails(filePath, resolvedPath, ctx, sessionCwd),
      )
    }
    const fileName = flagValue<string>(ctx.flags, 'name') ?? path.basename(resolvedPath)
    const mimeType = flagValue<string>(ctx.flags, 'mime-type')
    const hub = await ctx.hub()
    const metadata = await hub.uploadArtifact(id, fileName, bytes, mimeType)
    printResult(ctx, metadata)
    if (!ctx.json) {
      ctx.io.out(`[Artifact] id=${metadata.id} name=${metadata.name}\n`)
    }
  },
}

const ARTIFACTS_GET_COMMAND: CommandSpec = {
  path: ['artifacts', 'get'],
  description: 'Read artifact content (GET /api/artifacts/:id/content; prints text directly, requires --output for binary)',
  flags: [{ name: 'output', type: 'string', help: 'output file path for binary content (resolved relative to CLI cwd)' }],
  positional: '<id>',
  async run(ctx: CommandContext) {
    const id = requirePositional(ctx.positionals, 0, 'id')
    assertNoExtraPositionals(ctx.positionals, 1)
    const output = flagValue<string>(ctx.flags, 'output')
    const hub = await ctx.hub()
    const response = await hub.raw(`/api/artifacts/${encodeURIComponent(id)}/content`)
    const contentType = response.headers.get('content-type') ?? ''
    const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('yaml') || contentType === ''
    if (output !== undefined) {
      await writeDownloadedOutput(ctx, response, output, 'artifact')
      return
    }
    if (!isText) {
      await response.body?.cancel().catch(() => {})
      throw new CliError(`artifact is binary (${contentType || 'unknown type'}): use --output <path>`, 'binary_content_requires_output')
    }
    const text = await response.text()
    if (ctx.json) printValue(ctx.io, text, true)
    else printPlainText(ctx, text)
  },
}

export function artifactsCommands(): CommandSpec[] {
  return commandsFromOperations(ARTIFACTS_LIST_OPERATIONS, {
    extraFlags: {
      'conversations.artifacts_list': [...convFlags],
    },
    coercePositionals: {
      'conversations.artifacts_list': {
        conversationId: (raw, _pos, ctx) => {
          if (ctx.flags.get('current') === true) {
            throw new CliError('conversation ID and --current are mutually exclusive', 'conflicting_flags')
          }
          return parsePositiveInt(raw, 'conversation ID')
        },
      },
    },
    validateInput: {
      'conversations.artifacts_list': (input, ctx) => {
        const explicit = input.conversationId as number | undefined
        if (explicit !== undefined && ctx.flags.get('current') === true) {
          throw new CliError('conversation ID and --current are mutually exclusive', 'conflicting_flags')
        }
        const conversationId = explicit ?? resolveConversationTarget(ctx.flags, undefined, ctx.env)
        return { ...input, conversationId }
      },
    },
    extraCommands: [ARTIFACTS_PUT_COMMAND, ARTIFACTS_GET_COMMAND],
  })
}
