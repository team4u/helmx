import { HelmxError } from './error.js'
import { assertJsonSafe } from './json-safe.js'
import type { JsonSchema } from './plugin-dto.js'
import { validateOrThrow } from './schema.js'
import {
  TOOL_PRESENTATION_META_MAX_BYTES,
  TOOL_PRESENTATION_META_MAX_DEPTH,
  TOOL_PRESENTATION_META_MAX_NODES,
} from './tool-presentation.js'

const utf8Encoder = new TextEncoder()

export interface PresentationMetaBoundsOptions {
  /** Human-readable tool / callsite label included in error diagnostics. */
  label?: string
  /** Optional string redactor applied to keys and string values before byte-budget & schema validation. */
  redact?: (text: string) => string
  /** Optional JSON Schema validated against the redacted, bounded object. */
  schema?: JsonSchema
  /** Override max serialized UTF-8 byte length (defaults to {@link TOOL_PRESENTATION_META_MAX_BYTES}). */
  maxBytes?: number
  /** Override max container nesting depth (defaults to {@link TOOL_PRESENTATION_META_MAX_DEPTH}). */
  maxDepth?: number
  /** Override max total visited JSON nodes (defaults to {@link TOOL_PRESENTATION_META_MAX_NODES}). */
  maxNodes?: number
  /** Error code thrown on contract violation (defaults to `'invalid_tool_result'`). */
  code?: string
  /** HTTP status code attached to thrown {@link HelmxError} (defaults to `500`). */
  status?: number
}

/**
 * Validate, optionally redact, and deep-clone tool `presentationMeta` at the persistence boundary.
 *
 * Delegates strict plain-JSON traversal, depth/node bounds, and redaction to {@link assertJsonSafe},
 * then enforces serialized UTF-8 byte length <= `maxBytes` and optional `schema` conformance without truncation.
 */
export function assertBoundedPresentationMeta(
  value: unknown,
  options?: PresentationMetaBoundsOptions,
): Record<string, unknown> {
  const label = options?.label ?? 'tool'
  const maxBytes = options?.maxBytes ?? TOOL_PRESENTATION_META_MAX_BYTES
  const maxDepth = options?.maxDepth ?? TOOL_PRESENTATION_META_MAX_DEPTH
  const maxNodes = options?.maxNodes ?? TOOL_PRESENTATION_META_MAX_NODES
  const code = options?.code ?? 'invalid_tool_result'
  const status = options?.status ?? 500

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new HelmxError('validation_error', `invalid maxBytes bound: ${String(maxBytes)}`, 400)
  }

  const cloned = assertJsonSafe(value, {
    label,
    path: 'presentationMeta',
    requirePlainObject: true,
    ...(options?.redact !== undefined ? { redact: options.redact } : {}),
    maxDepth,
    maxNodes,
    code,
    status,
  })

  const bytes = utf8Encoder.encode(JSON.stringify(cloned)).byteLength
  if (bytes > maxBytes) {
    throw new HelmxError(
      code,
      `${label} presentationMeta exceeds max byte size (${bytes} > ${maxBytes} bytes)`,
      status,
      { maxBytes, actualBytes: bytes },
    )
  }

  if (options?.schema !== undefined) {
    validateOrThrow(
      options.schema,
      cloned,
      `${label} presentationMeta does not conform to presentationMetaSchema`,
      code,
      status,
    )
  }

  return cloned
}
