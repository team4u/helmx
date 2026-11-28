/**
 * Kernel `read` tool: wraps `@earendil-works/pi-durable`'s `createReadTool` (line-based pagination via
 * `offset`/`limit`, UTF-8 BOM stripping, concurrent-mutation reread, multimodal image reading with
 * Photon auto-scaling, NFD/smart-quote filename fallbacks) over helmx's `EnvFabric` execution boundary.
 *
 * Host strategy enforced outside the upstream mechanism:
 * - Target `(nodeId, cwd)` platform normalization and `Profile.restrictToCwd` guardrail (blocks lexical
 *   escapes and `@../` prefix escapes before touching the filesystem);
 * - Explicit remote pre-guards (`env_fabric_missing` / `node_offline`, never falling back to Hub disk);
 * - SecretStash redaction across text output, diagnostics, and structuredOutput;
 * - `READ_TOOL_META_SCHEMA` compliance for `details` and explicit error text when image limits fail.
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import {
  createReadTool as createDurableReadTool,
  type ImageProcessor,
  type ReadToolDetails,
} from '@earendil-works/pi-durable/tools'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import {
  READ_TOOL_TRUNCATION_SCHEMA,
  isAbsoluteTargetPath,
  type JsonSchema,
} from '@helmx/protocol'
import { createLocalExecutionEnv } from '../../env/local-host-env.js'
import { targetPlatformForNode } from '../target-platform.js'
import { throwIfToolAborted, type HelmxToolDeps } from '../tool-deps.js'
import { cwdScopeViolationText } from './cwd-scope.js'
import { requireRemoteEnv } from './guards.js'
import { resolveTargetPath } from './target-path.js'

const UNICODE_SPACES_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

const readParameters = obj({
  path: str({ description: 'File path (relative to conversation cwd or absolute; supports ../ traversal)' }),
  offset: opt(num({ description: 'Optional 1-indexed line number to start reading from' })),
  limit: opt(num({ description: 'Optional maximum number of lines to read' })),
})

const READ_STRUCTURED_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Actual resolved absolute path read (canonicalized remotely; not raw input)',
    },
    nodeId: { type: 'string', description: 'Node where file was read' },
    content: { type: 'string' },
    image: {
      type: 'object',
      properties: {
        type: { const: 'image' },
        data: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['type', 'data', 'mimeType'],
      additionalProperties: false,
    },
    truncation: READ_TOOL_TRUNCATION_SCHEMA,
  },
  required: ['path', 'nodeId'],
  additionalProperties: false,
}

let sharedPhotonPromise: Promise<ImageProcessor> | undefined

function getSharedPhotonImages(): Promise<ImageProcessor> {
  if (sharedPhotonPromise === undefined) {
    sharedPhotonPromise = createNodePhotonImages().catch((error) => {
      sharedPhotonPromise = undefined
      throw error
    })
  }
  return sharedPhotonPromise
}

/** Lazily load Photon WASM only when an actual image is read (zero startup or text-read cost). */
const lazyPhotonImages: ImageProcessor = {
  async prepare(bytes, mimeType, limits) {
    const processor = await getSharedPhotonImages()
    return processor.prepare(bytes, mimeType, limits)
  },
}

const innerReadTool = createDurableReadTool({ images: lazyPhotonImages })

function extractTruncationMeta(raw: unknown): Record<string, JsonValue> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const t = raw as Record<string, unknown>
  if (
    typeof t['truncated'] !== 'boolean' ||
    typeof t['totalLines'] !== 'number' ||
    typeof t['totalBytes'] !== 'number' ||
    typeof t['outputLines'] !== 'number' ||
    typeof t['outputBytes'] !== 'number' ||
    typeof t['maxLines'] !== 'number' ||
    typeof t['maxBytes'] !== 'number'
  ) {
    return undefined
  }
  const truncatedBy = t['truncatedBy']
  return {
    truncated: t['truncated'],
    ...(truncatedBy === 'lines' || truncatedBy === 'bytes' ? { truncatedBy } : {}),
    totalLines: t['totalLines'],
    totalBytes: t['totalBytes'],
    outputLines: t['outputLines'],
    outputBytes: t['outputBytes'],
    ...(typeof t['lastLinePartial'] === 'boolean' ? { lastLinePartial: t['lastLinePartial'] } : {}),
    ...(typeof t['firstLineExceedsLimit'] === 'boolean' ? { firstLineExceedsLimit: t['firstLineExceedsLimit'] } : {}),
    maxLines: t['maxLines'],
    maxBytes: t['maxBytes'],
  }
}

function readFailureResult(text: string): ToolExecutionResult {
  return { output: [{ type: 'text', text }], isError: true }
}

/**
 * `read` tool: reads paginated text files (default 2,000 lines / 50 KiB with `offset`/`limit` continuation)
 * and supported images (`jpg`, `png`, `gif`, `webp`, `bmp`) on conversation `(nodeId, cwd)`.
 */
export function createReadTool(deps: HelmxToolDeps): ToolRegistration<typeof readParameters> {
  return defineTool({
    name: 'read',
    // Pure read-only with idempotent semantics: safe to replay after interruption.
    replay: 'safe',
    description:
      'Read text files or images (jpg, png, gif, webp, bmp). Paths resolve relative to conversation cwd and support ' +
      'absolute paths and ../ traversal (same as bash); reads from the bound node when running remotely. Text output is bounded ' +
      'to 2000 lines or 50 KiB per call — use offset (1-indexed) and limit to paginate large files.',
    parameters: readParameters,
    structuredOutputSchema: READ_STRUCTURED_OUTPUT_SCHEMA,
    async execute(args, api, context) {
      const ctx: Context = context ?? BACKGROUND_CONTEXT
      throwIfToolAborted(ctx.abortSignal)

      const raw = args.path
      const agent = await api.agent(ctx)
      throwIfToolAborted(ctx.abortSignal)

      const base = agent.cwd ?? deps.defaultCwd
      if (!isAbsoluteTargetPath(base)) {
        return readFailureResult(`read_failed: conversation cwd is not an absolute path (${base}); read rejected`)
      }

      const conversationId = api.conversationId as number
      const nodeId = deps.nodeIdOf?.(conversationId) ?? 'local'
      const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
      const platform = platformInfo.known ? platformInfo.platform : undefined

      const normalizedRaw = raw.replace(UNICODE_SPACES_RE, ' ')
      const resolvedR = resolveTargetPath(normalizedRaw, base, platform)
      if (!resolvedR.ok) {
        return readFailureResult(`invalid_path: ${resolvedR.reason}`)
      }
      let lexicalAbs = resolvedR.abs

      const restricted =
        deps.restrictToCwdOf !== undefined && (await deps.restrictToCwdOf(conversationId)) === true
      if (restricted) {
        const violation = cwdScopeViolationText(normalizedRaw, base, platform)
        if (violation !== undefined) {
          return readFailureResult(violation)
        }
      }

      let env: ExecutionEnv
      let ephemeralEnv: ExecutionEnv | undefined
      if (nodeId !== 'local') {
        const remote = requireRemoteEnv(deps.envFabric, nodeId, base, 'read')
        if ('error' in remote) {
          throwIfToolAborted(ctx.abortSignal)
          return readFailureResult(remote.error)
        }
        env = api.env ?? remote.env
      } else if (api.env !== undefined) {
        env = api.env
      } else if (deps.envFabric !== undefined) {
        env = deps.envFabric.envForTarget({ nodeId: 'local', cwd: base, conversationId })
      } else {
        ephemeralEnv = createLocalExecutionEnv({ cwd: base })
        env = ephemeralEnv
      }

      try {
        // Explicit `@file` prefix rescue only when the literal path is missing, re-enforcing `restrictToCwd`
        // BEFORE probing the stripped target so `@../escape` can never bypass the guardrail.
        if (normalizedRaw.startsWith('@')) {
          const literalExistsR = await env.exists(lexicalAbs, ctx)
          if (literalExistsR.ok && !literalExistsR.value) {
            const stripped = normalizedRaw.slice(1)
            if (stripped !== '') {
              if (restricted) {
                const violation = cwdScopeViolationText(stripped, base, platform)
                if (violation !== undefined) {
                  return readFailureResult(violation)
                }
              }
              const strippedR = resolveTargetPath(stripped, base, platform)
              if (strippedR.ok) {
                const strippedExistsR = await env.exists(strippedR.abs, ctx)
                if (strippedExistsR.ok && strippedExistsR.value) {
                  lexicalAbs = strippedR.abs
                }
              }
            }
          }
        }

        const canonR = await env.canonicalPath(lexicalAbs, ctx)
        if (!canonR.ok && canonR.error.code === 'aborted') {
          throwIfToolAborted(ctx.abortSignal)
        }
        const canonical = canonR.ok ? canonR.value : undefined
        const displayPath = nodeId !== 'local' ? (canonical ?? lexicalAbs) : lexicalAbs
        const statTarget = canonical ?? lexicalAbs

        const infoR = await env.fileInfo(statTarget, ctx)
        if (infoR.ok) {
          if (infoR.value.kind === 'directory') {
            return readFailureResult(`read_failed: ${raw} is directory; read only supports regular files`)
          }
          if (infoR.value.kind !== 'file') {
            return readFailureResult(`read_failed: ${raw} is not ordinary file (kind=${infoR.value.kind})`)
          }
        } else if (infoR.error.code === 'aborted') {
          throwIfToolAborted(ctx.abortSignal)
        } else if (infoR.error.code !== 'not_found') {
          return readFailureResult(`read_failed: ${deps.redact(infoR.error.message)}`)
        }

        const modelsPort =
          api.models !== undefined && typeof (api.models as { getModel?: unknown }).getModel === 'function'
            ? api.models
            : ({ getModel: () => undefined } as unknown as ToolExecutionApi['models'])
        const apiProxy: ToolExecutionApi = {
          ...api,
          get env() {
            return env
          },
          models: modelsPort,
          agent: async () => agent,
        }

        const upstream = await innerReadTool.execute(
          {
            path: statTarget,
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          apiProxy,
          ctx,
        )
        throwIfToolAborted(ctx.abortSignal)

        const rawOutput = upstream.output ?? []
        const redactedOutput = rawOutput.map((block) =>
          block.type === 'text' ? { ...block, text: deps.redact(block.text) } : block,
        )
        const redactedDiagnostics = upstream.diagnostics?.map((diag) => ({
          ...diag,
          message: deps.redact(diag.message),
        }))

        if (upstream.isError === true) {
          const hasText = redactedOutput.some((block) => block.type === 'text' && block.text !== '')
          if (!hasText) {
            const diagText = redactedDiagnostics?.map((d) => d.message).filter(Boolean).join('\n') ?? ''
            return {
              output: [{ type: 'text', text: diagText !== '' ? `read_failed: ${diagText}` : `read_failed: ${raw}` }],
              isError: true,
              ...(redactedDiagnostics !== undefined && redactedDiagnostics.length > 0
                ? { diagnostics: redactedDiagnostics }
                : {}),
            }
          }
          return {
            output: redactedOutput,
            isError: true,
            ...(redactedDiagnostics !== undefined && redactedDiagnostics.length > 0
              ? { diagnostics: redactedDiagnostics }
              : {}),
          }
        }

        const imageBlock = redactedOutput.find(
          (block): block is Extract<(typeof redactedOutput)[number], { type: 'image' }> => block.type === 'image',
        )
        const upstreamDetails = upstream.details as ReadToolDetails | undefined
        const truncationMeta = extractTruncationMeta(upstreamDetails?.truncation)
        const imageUnsupported =
          typeof upstreamDetails?.imageUnsupportedByModel === 'string' &&
          upstreamDetails.imageUnsupportedByModel !== ''
            ? upstreamDetails.imageUnsupportedByModel
            : undefined

        const details: Record<string, JsonValue> = {
          path: displayPath,
          nodeId,
          ...(imageBlock !== undefined ? { mimeType: imageBlock.mimeType } : {}),
          ...(imageUnsupported !== undefined ? { imageUnsupportedByModel: imageUnsupported } : {}),
          ...(truncationMeta !== undefined ? { truncation: truncationMeta } : {}),
        }

        if (imageBlock !== undefined) {
          return {
            output: redactedOutput,
            structuredOutput: {
              path: displayPath,
              nodeId,
              image: {
                type: 'image',
                data: imageBlock.data,
                mimeType: imageBlock.mimeType,
              },
            } as JsonValue,
            details: details as JsonValue,
            ...(redactedDiagnostics !== undefined && redactedDiagnostics.length > 0
              ? { diagnostics: redactedDiagnostics }
              : {}),
          }
        }

        const finalOutput =
          redactedOutput.length === 0 ? [{ type: 'text' as const, text: '' }] : redactedOutput
        const textContent = finalOutput
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')

        return {
          output: finalOutput,
          structuredOutput: {
            path: displayPath,
            nodeId,
            content: textContent,
            ...(truncationMeta !== undefined ? { truncation: truncationMeta } : {}),
          } as JsonValue,
          details: details as JsonValue,
          ...(redactedDiagnostics !== undefined && redactedDiagnostics.length > 0
            ? { diagnostics: redactedDiagnostics }
            : {}),
        }
      } catch (error) {
        throwIfToolAborted(ctx.abortSignal)
        const msg = error instanceof Error ? error.message : String(error)
        return readFailureResult(`read_failed: ${deps.redact(msg)}`)
      } finally {
        if (ephemeralEnv !== undefined) {
          await ephemeralEnv.cleanup(BACKGROUND_CONTEXT).catch(() => undefined)
        }
      }
    },
  })
}
