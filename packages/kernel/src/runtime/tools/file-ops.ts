/**
 * Kernel built-in writable file tools (`write` / `edit`): target conversation `(nodeId, cwd)`, converging
 * local and remote branches via `file-env.ts` unified execution adapters into a single template (equivalent
 * behavior; shares bash permission boundaries with optional `Profile.restrictToCwd` enforcement).
 *
 * `write`/`edit`: writes text and performs exact/fuzzy replacements. Existing targets resolve via
 * `canonicalPath`/`realpath` so symlink writes hit real files and align mutex keys; new files write at lexical
 * absolute paths; read-modify-write windows share per-node canonical path mutexes via `env/file-mutation-queue`
 * with plugin APIs. On success, `edit` computes real line-level diffs inside the lock prior to writing
 * (sole implementation in `runtime/tool-edit-diff.ts`; matches `@helmx/protocol` `EDIT_TOOL_RESULT_SCHEMA`).
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { arr, bool, obj, opt, str, type Static } from '@earendil-works/pi-schema'
import { EDIT_TOOL_RESULT_SCHEMA, type EditToolResult } from '@helmx/protocol'
import { computeMultiEditDiff } from '../tool-edit-diff.js'
import type { HelmxToolDeps } from '../tool-deps.js'
import { cwdScopeViolationText } from './cwd-scope.js'
import { applyEditOperations, extractEditOperations, prepareEditArguments } from './edit-engine.js'
import { resolveToolTarget } from './tool-target.js'
import {
  basenameForShape,
  dirnameForShape,
  resolveWritableTarget,
  writableEnvFor,
} from './file-env.js'

const writeParameters = obj({
  path: str({ description: 'Target file path (relative to conversation cwd or absolute; supports ../ traversal, creates missing files/directories)' }),
  content: str({ description: 'UTF-8 text content to write (replaces entire file)' }),
  artifact: opt(
    bool({
      description:
        'Whether to also register as a conversation artifact (visible/previewable/downloadable in Web UI; outputs [Artifact] id=<id> so replies can link [filename](artifact:<id>) or ![caption](artifact:<id>))',
    }),
  ),
})

/** Shared `write`/`edit` confirmation text (`'node ${nodeId}'` format preserved for test compatibility). */
const editOkText = (abs: string, nodeId: string, count: number): string =>
  `edit_ok: ${abs} (node ${nodeId}, replaced ${count} ${count === 1 ? 'occurrence' : 'occurrences'})`

/** `write` tool: writes UTF-8 text files on conversation `(nodeId, cwd)` (shares path/permission boundary with `bash`). */
export function createWriteTool(deps: HelmxToolDeps): ToolRegistration<typeof writeParameters> {
  return defineTool({
    name: 'write',
    description:
      'Write a UTF-8 text file (overwriting any existing content). Paths resolve relative to conversation cwd and support absolute paths and ../ traversal (same as bash), ' +
      'creating parent directories automatically; writes on the target node when bound remotely. Files are written to disk only by default (hidden in Web UI); pass artifact: true to also register as a conversation artifact for Web preview/download and reference via [filename](artifact:<id>) or ![title](artifact:<id>).',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Actual resolved absolute path written (canonicalized if pre-existing; not raw input)' },
        nodeId: { type: 'string', description: 'Node where file was written' },
        bytesWritten: { type: 'number' },
        artifactId: { type: 'string' },
      },
      required: ['path', 'nodeId', 'bytesWritten'],
    },
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `write_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      // Profile.restrictToCwd guardrail: lexical escapes (absolute paths / ../) reject before any IO or dir creation.
      if (
        deps.restrictToCwdOf !== undefined &&
        (await deps.restrictToCwdOf(api.conversationId as number)) === true
      ) {
        const violation = cwdScopeViolationText(args.path, base, platform)
        if (violation !== undefined) {
          return { output: [{ type: 'text', text: violation }], isError: true }
        }
      }
      try {
        const onWriteSuccess = async (targetAbs: string, bytes: number) => {
          if (args.artifact === true) {
            if (deps.artifacts.writeUploaded === undefined) {
              return {
                output: [
                  {
                    type: 'text' as const,
                    text: 'write_failed: artifact service does not support writeUploaded; cannot register conversation artifact',
                  },
                ],
                isError: true,
              }
            }
            const fileName = basenameForShape(targetAbs)
            const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
              name: fileName,
              bytes: Buffer.from(args.content, 'utf8'),
            })
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `write_ok: ${targetAbs} (node ${nodeId}, ${bytes} bytes)\n[Artifact] id=${meta.id} name=${meta.name}`,
                },
              ],
              structuredOutput: {
                path: targetAbs,
                nodeId,
                bytesWritten: bytes,
                artifactId: meta.id,
              } as JsonValue,
              details: { path: targetAbs, nodeId, bytesWritten: bytes, artifactId: meta.id } as JsonValue,
            }
          }
          return {
            output: [
              { type: 'text' as const, text: `write_ok: ${targetAbs} (node ${nodeId}, ${bytes} bytes)` },
            ],
            structuredOutput: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
            details: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
          }
        }

        // Unified execution env: remote (explicit failure on missing EnvFabric/offline, never falls back locally)
        // and local share the exact same write template.
        const envR = writableEnvFor(deps, nodeId, base, 'write')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // Mutex queue serializes read-modify-write windows across tools and plugins (see `env/file-mutation-queue.ts`);
        // creates missing parent directories recursively using target path shape rules (`win32` backslash separators).
        return await envR.env.withMutationQueue(target.abs, async () => {
          await envR.env.ensureDir(dirnameForShape(target.abs), context)
          await envR.env.writeFile(target.abs, args.content, context)
          return await onWriteSuccess(target.abs, bytes)
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `write_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const singleEditItemParameters = obj({
  oldText: str({ description: 'Exact text to replace (non-empty; include exact leading indentation/whitespace; unique unless replaceAll is true)' }),
  newText: str({ description: 'Complete literal drop-in replacement (no placeholder comments; pass "" to delete oldText)' }),
  replaceAll: opt(bool({ description: 'Replace every non-overlapping occurrence in the file (default false)' })),
  allowEmbeddedMatch: opt(bool({ description: 'Allow replaceAll to match inside larger identifiers' })),
})

const editParameters = obj({
  path: str({ description: 'Target file path (relative to conversation cwd or absolute; supports ../ traversal)' }),
  oldText: opt(str({ description: 'Exact text to replace in single-edit mode (non-empty; include exact leading indentation/whitespace; mutually exclusive with edits[])' })),
  newText: opt(str({ description: 'Complete literal drop-in replacement in single-edit mode (no placeholder comments; pass "" to delete oldText)' })),
  replaceAll: opt(bool({ description: 'Replace every non-overlapping occurrence in single-edit mode (default false)' })),
  allowEmbeddedMatch: opt(bool({ description: 'Allow replaceAll to match inside larger identifiers' })),
  edits: opt(
    arr(singleEditItemParameters, {
      description: 'Atomic multi-hunk replacements for non-adjacent regions (mutually exclusive with top-level oldText/newText; merge nearby changes into one edit)',
    }),
  ),
  artifact: opt(
    bool({
      description:
        'Whether to also register the updated file as a conversation artifact (visible/previewable/downloadable in Web UI; outputs [Artifact] id=<id> so replies can link [filename](artifact:<id>) or ![caption](artifact:<id>))',
    }),
  ),
})

/**
 * `edit` tool: targeted single or multi-hunk replacements (`oldText`/`newText` or `edits[]`), with optional
 * `replaceAll` (guarded by identifier-boundary isolation unless `allowEmbeddedMatch: true`), BOM + per-line ending
 * preservation, per-item fuzzy fallback on exact miss, and optional `artifact: true` registration. Diff runs inside
 * the canonical mutex lock prior to writing (`computeMultiEditDiff` matching `@helmx/protocol`
 * `EDIT_TOOL_RESULT_SCHEMA`).
 */
export function createEditTool(deps: HelmxToolDeps): ToolRegistration<typeof editParameters> {
  return defineTool({
    name: 'edit',
    description:
      'Replace targeted text in an existing file on the bound node (paths resolve relative to conversation cwd). Provide EITHER { path, oldText, newText } for one contiguous block OR { path, edits: [{ oldText, newText }, ...] } for multiple non-adjacent blocks in one atomic write (never both). Rules: 1) oldText must match exact file text including leading indentation/whitespace and be unique unless replaceAll is true; 2) newText must be a complete literal replacement with no ellipsis/placeholder comments (use "" to delete); 3) merge nearby edits into a single contiguous hunk to avoid overlaps. Pass artifact: true to also register the updated file as a conversation artifact for Web preview/download.',
    parameters: editParameters,
    prepareArguments: (raw) => prepareEditArguments(raw) as Static<typeof editParameters>,
    structuredOutputSchema: EDIT_TOOL_RESULT_SCHEMA,
    async execute(args, api, context) {
      const opsR = extractEditOperations(args)
      if (!opsR.ok) {
        return { output: [{ type: 'text', text: opsR.error }], isError: true }
      }
      if (args.artifact === true && deps.artifacts.writeUploaded === undefined) {
        return {
          output: [
            {
              type: 'text',
              text: 'edit_failed: artifact service does not support writeUploaded; cannot register conversation artifact',
            },
          ],
          isError: true,
        }
      }
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      // Profile.restrictToCwd guardrail: lexical escapes (absolute paths / ../) reject before any IO.
      if (
        deps.restrictToCwdOf !== undefined &&
        (await deps.restrictToCwdOf(api.conversationId as number)) === true
      ) {
        const violation = cwdScopeViolationText(args.path, base, platform)
        if (violation !== undefined) {
          return { output: [{ type: 'text', text: violation }], isError: true }
        }
      }
      try {
        // Unified execution env: remote (explicit failure on missing EnvFabric/offline, never falls back locally)
        // and local share the exact same read-modify-write template.
        const envR = writableEnvFor(deps, nodeId, base, 'edit')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        // Mutex queue covers the entire read-modify-write window so concurrent mutations cannot interleave.
        return await envR.env.withMutationQueue(target.abs, async () => {
          const rawContent = await envR.env.readTextFile(target.abs, context)
          const applied = applyEditOperations(rawContent, opsR.operations, target.abs, deps.redact)
          if (!applied.ok) {
            return {
              output: [{ type: 'text', text: applied.error }],
              isError: true,
            }
          }
          // Compute multi-hunk diff under lock before writing (pure function; throws cleanly without touching disk).
          const diff = computeMultiEditDiff(
            applied.lfOriginal,
            applied.lfUpdated,
            applied.appliedSpans,
            deps.redact,
          )
          await envR.env.writeFile(target.abs, applied.updatedFileContent, context)
          let artifactMeta: { id: string; name: string } | undefined
          if (args.artifact === true) {
            const fileName = basenameForShape(target.abs)
            try {
              const meta = await deps.artifacts.writeUploaded!(api.conversationId as number, {
                name: fileName,
                bytes: Buffer.from(applied.updatedFileContent, 'utf8'),
              })
              artifactMeta = { id: meta.id, name: meta.name }
            } catch (artifactError) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `edit_failed: file was updated at ${target.abs}, but artifact registration failed: ${deps.redact(String(artifactError))}`,
                  },
                ],
                isError: true,
              }
            }
          }
          const structured: EditToolResult = {
            path: target.abs,
            nodeId,
            replaced: true,
            diff,
            ...(artifactMeta !== undefined ? { artifactId: artifactMeta.id } : {}),
          }
          const okLine = editOkText(target.abs, nodeId, applied.totalReplacements)
          const outputText =
            artifactMeta !== undefined
              ? `${okLine}\n[Artifact] id=${artifactMeta.id} name=${artifactMeta.name}`
              : okLine
          return {
            output: [{ type: 'text', text: outputText }],
            structuredOutput: structured as unknown as JsonValue,
            // Web timeline diff UI reads persisted `details` (`structuredOutput` isn't persisted); both channels
            // carry identical values against the single `EDIT_TOOL_RESULT_SCHEMA` contract.
            details: structured as unknown as JsonValue,
          }
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `edit_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}
