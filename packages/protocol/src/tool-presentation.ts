import { HelmxError } from './error.js'
import type { JsonSchema } from './plugin-dto.js'
import { validateOrThrow } from './schema.js'
import { isPlainObject } from './utils.js'

/** Hard UTF-8 JSON byte cap for persisted tool `presentationMeta` (`pi.tool-result.model[0].details`). */
export const TOOL_PRESENTATION_META_MAX_BYTES = 64 * 1024
/** Hard container nesting depth cap for persisted tool `presentationMeta` (root object = depth 1). */
export const TOOL_PRESENTATION_META_MAX_DEPTH = 12
/** Hard total visited JSON node cap for persisted tool `presentationMeta` (root + every value/element). */
export const TOOL_PRESENTATION_META_MAX_NODES = 2_000

const FORBIDDEN_META_KEYS = ['__proto__', 'constructor', 'prototype'] as const
const FORBIDDEN_META_KEY_SET = new Set<string>(FORBIDDEN_META_KEYS)
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
 * Enforces all structural & resource invariants without silent truncation or field dropping:
 * - top-level value must be a plain JSON object (rejects null, primitives, arrays, class instances);
 * - inspects `Reflect.ownKeys` on every object and array: rejects symbol own keys, non-enumerable own
 *   properties, extra own properties on arrays, non-plain array subclasses, and prototype keys
 *   (`__proto__`, `constructor`, `prototype`, both before and after redaction);
 * - rejects circular references, sparse arrays, `undefined`, non-finite numbers, and non-JSON values;
 * - enforces container depth <= `maxDepth` (root object = depth 1; primitive leaves do not consume depth),
 *   total visited nodes <= `maxNodes`, and serialized UTF-8 JSON byte length <= `maxBytes`;
 * - when `schema` is provided, validates the cloned (and redacted) object synchronously via `validateOrThrow`.
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
  const redact = options?.redact

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new HelmxError('validation_error', `invalid maxBytes bound: ${String(maxBytes)}`, 400)
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new HelmxError('validation_error', `invalid maxDepth bound: ${String(maxDepth)}`, 400)
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new HelmxError('validation_error', `invalid maxNodes bound: ${String(maxNodes)}`, 400)
  }

  if (!isPlainObject(value)) {
    throw new HelmxError(code, `${label} presentationMeta must be a plain JSON object`, status)
  }

  const visiting = new WeakSet<object>()
  let nodes = 0

  function visit(current: unknown, path: string, depth: number): unknown {
    nodes += 1
    if (nodes > maxNodes) {
      throw new HelmxError(
        code,
        `${label} presentationMeta exceeds max node count (${maxNodes}) at ${path}`,
        status,
        { maxNodes, path },
      )
    }
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return redact ? redact(current) : current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new HelmxError(
          code,
          `${label} presentationMeta contains a non-finite number at ${path}`,
          status,
          { path },
        )
      }
      return current
    }
    if (typeof current !== 'object') {
      throw new HelmxError(
        code,
        `${label} presentationMeta contains a non-JSON value (${typeof current}) at ${path}`,
        status,
        { path },
      )
    }
    if (visiting.has(current)) {
      throw new HelmxError(
        code,
        `${label} presentationMeta contains a circular reference at ${path}`,
        status,
        { path },
      )
    }
    if (depth > maxDepth) {
      throw new HelmxError(
        code,
        `${label} presentationMeta exceeds max nesting depth (${maxDepth}) at ${path}`,
        status,
        { maxDepth, path },
      )
    }
    visiting.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a non-plain array at ${path}`,
            status,
            { path },
          )
        }
        for (const forbidden of FORBIDDEN_META_KEYS) {
          if (Object.hasOwn(current, forbidden)) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains forbidden prototype key "${forbidden}" at ${path}`,
              status,
              { path, key: forbidden },
            )
          }
        }
        const out: unknown[] = []
        for (let i = 0; i < current.length; i += 1) {
          const desc = Object.getOwnPropertyDescriptor(current, i)
          if (desc === undefined) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a sparse array hole at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          if (!desc.enumerable) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a non-enumerable array element at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          if (desc.get !== undefined || desc.set !== undefined) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains an accessor array element at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          out.push(visit(desc.value, `${path}[${i}]`, depth + 1))
        }
        // Inspect all own keys (`Reflect.ownKeys`) to reject symbols, prototype keys, or extra named properties
        // on arrays that index loops / JSON.stringify would silently drop.
        for (const rawKey of Reflect.ownKeys(current)) {
          if (rawKey === 'length') continue
          if (typeof rawKey !== 'string') {
            const safeSym = redact ? redact(String(rawKey)) : String(rawKey)
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a symbol key (${safeSym}) on array at ${path}`,
              status,
              { path },
            )
          }
          if (FORBIDDEN_META_KEY_SET.has(rawKey)) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains forbidden prototype key "${rawKey}" at ${path}`,
              status,
              { path, key: rawKey },
            )
          }
          const idx = Number(rawKey)
          if (!Number.isInteger(idx) || idx < 0 || idx >= current.length || String(idx) !== rawKey) {
            const safeKey = redact ? redact(rawKey) : rawKey
            throw new HelmxError(
              code,
              `${label} presentationMeta contains an extra own property "${safeKey}" on array at ${path}`,
              status,
              { path, key: safeKey },
            )
          }
        }
        return out
      }
      if (!isPlainObject(current)) {
        throw new HelmxError(
          code,
          `${label} presentationMeta contains a non-plain object at ${path}`,
          status,
          { path },
        )
      }
      for (const forbidden of FORBIDDEN_META_KEYS) {
        if (Object.hasOwn(current, forbidden)) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains forbidden prototype key "${forbidden}" at ${path}`,
            status,
            { path, key: forbidden },
          )
        }
      }
      const out: Record<string, unknown> = {}
      const seenKeys = new Set<string>()
      for (const rawKey of Reflect.ownKeys(current)) {
        if (typeof rawKey !== 'string') {
          const safeSym = redact ? redact(String(rawKey)) : String(rawKey)
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a symbol key (${safeSym}) at ${path}`,
            status,
            { path },
          )
        }
        const desc = Object.getOwnPropertyDescriptor(current, rawKey)
        if (desc === undefined || !desc.enumerable) {
          const safeKey = redact ? redact(rawKey) : rawKey
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a non-enumerable property "${safeKey}" at ${path}`,
            status,
            { path, key: safeKey },
          )
        }
        if (desc.get !== undefined || desc.set !== undefined) {
          const safeKey = redact ? redact(rawKey) : rawKey
          throw new HelmxError(
            code,
            `${label} presentationMeta contains an accessor property "${safeKey}" at ${path}`,
            status,
            { path, key: safeKey },
          )
        }
        const key = redact ? redact(rawKey) : rawKey
        if (FORBIDDEN_META_KEY_SET.has(key)) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains forbidden prototype key "${key}" at ${path}`,
            status,
            { path, key },
          )
        }
        if (seenKeys.has(key)) {
          throw new HelmxError(
            'redacted_key_conflict',
            `${label} presentationMeta redacted fields collide at ${path}.${key}`,
            500,
            { path, key },
          )
        }
        seenKeys.add(key)
        out[key] = visit(desc.value, `${path}.${key}`, depth + 1)
      }
      return out
    } finally {
      visiting.delete(current)
    }
  }

  const cloned = visit(value, 'presentationMeta', 1) as Record<string, unknown>
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

/** Actual execution result of the built-in edit tool; presentation only consumes diffs corresponding to the written file. */
export type ToolDiffRow =
  | { kind: 'context'; oldLine: number; newLine: number; text: string }
  | { kind: 'remove'; oldLine: number; text: string }
  | { kind: 'add'; newLine: number; text: string }

export interface ToolEditDiff {
  rows: ToolDiffRow[]
  addedLines: number
  removedLines: number
  firstChangedLine: number
  /** Row or text budget caused part of the diff to be omitted; the counters still cover the whole replacement. */
  truncated: boolean
}

export interface EditToolResult {
  path: string
  nodeId: string
  replaced: true
  diff: ToolEditDiff
}

export const TOOL_DIFF_MAX_ROWS = 160
export const TOOL_DIFF_MAX_TEXT_CHARS = 32_768
export const TOOL_DIFF_MAX_ROW_CHARS = 4_096

const lineNumber = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const text = { type: 'string', maxLength: TOOL_DIFF_MAX_ROW_CHARS }

/** SDK output and the Web presentation entry share the same schema, rejecting forged line numbers and invalid data. */
export const EDIT_TOOL_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    replaced: { const: true },
    diff: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          maxItems: TOOL_DIFF_MAX_ROWS,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { const: 'context' }, oldLine: lineNumber, newLine: lineNumber, text },
                required: ['kind', 'oldLine', 'newLine', 'text'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { kind: { const: 'remove' }, oldLine: lineNumber, text },
                required: ['kind', 'oldLine', 'text'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { kind: { const: 'add' }, newLine: lineNumber, text },
                required: ['kind', 'newLine', 'text'],
                additionalProperties: false,
              },
            ],
          },
        },
        addedLines: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        removedLines: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        firstChangedLine: lineNumber,
        truncated: { type: 'boolean' },
      },
      required: ['rows', 'addedLines', 'removedLines', 'firstChangedLine', 'truncated'],
      additionalProperties: false,
    },
  },
  required: ['path', 'nodeId', 'replaced', 'diff'],
  additionalProperties: false,
}

const nonNegativeInt = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

/** Presentation metadata schema for built-in `read` tool (omits full file content already in model output). */
export const READ_TOOL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
  },
  required: ['path', 'nodeId'],
  additionalProperties: false,
}

/** Presentation metadata schema for built-in `write` tool. */
export const WRITE_TOOL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    bytesWritten: nonNegativeInt,
    artifactId: { type: 'string', minLength: 1 },
  },
  required: ['path', 'nodeId', 'bytesWritten'],
  additionalProperties: false,
}

/** Presentation metadata schema for built-in `bash` tool (omits stdout/stderr already in model output). */
export const BASH_TOOL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: ['integer', 'null'] },
    timedOut: { type: 'boolean' },
    nodeId: { type: 'string', minLength: 1 },
    cwd: { type: 'string', minLength: 1 },
  },
  required: ['ok', 'exitCode', 'timedOut'],
  additionalProperties: false,
}

/** Presentation metadata schema for built-in `register_artifact` tool. */
export const ARTIFACT_REGISTER_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    artifactId: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    size: nonNegativeInt,
    mimeType: { type: 'string', minLength: 1 },
  },
  required: ['artifactId', 'path', 'nodeId', 'name', 'size', 'mimeType'],
  additionalProperties: false,
}

/** Presentation metadata schema for built-in `read_artifact` tool (omits chunk text already in model output). */
export const ARTIFACT_READ_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    offset: nonNegativeInt,
    nextOffset: nonNegativeInt,
    bytes: nonNegativeInt,
  },
  required: ['id', 'offset', 'bytes'],
  additionalProperties: false,
}

/** Shared lookup map from kernel built-in tool name to its declared `presentationMetaSchema`. */
export const KERNEL_TOOL_PRESENTATION_META_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  read: READ_TOOL_META_SCHEMA,
  write: WRITE_TOOL_META_SCHEMA,
  edit: EDIT_TOOL_RESULT_SCHEMA,
  bash: BASH_TOOL_META_SCHEMA,
  register_artifact: ARTIFACT_REGISTER_META_SCHEMA,
  read_artifact: ARTIFACT_READ_META_SCHEMA,
}
