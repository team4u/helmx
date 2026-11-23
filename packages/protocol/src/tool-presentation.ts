import type { JsonSchema } from './plugin-dto.js'
import { isPlainObject } from './utils.js'

/** Hard UTF-8 JSON byte cap for persisted tool `presentationMeta` (`pi.tool-result.model[0].details`). */
export const TOOL_PRESENTATION_META_MAX_BYTES = 64 * 1024
/** Hard container nesting depth cap for persisted tool `presentationMeta` (root object = depth 1). */
export const TOOL_PRESENTATION_META_MAX_DEPTH = 12
/** Hard total visited JSON node cap for persisted tool `presentationMeta` (root + every value/element). */
export const TOOL_PRESENTATION_META_MAX_NODES = 2_000

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

export type EditToolResultValidation =
  | { ok: true; value: EditToolResult }
  | { ok: false; error: string }

const EDIT_RESULT_KEYS = ['path', 'nodeId', 'replaced', 'diff'] as const
const EDIT_RESULT_KEY_SET = new Set<string>(EDIT_RESULT_KEYS)
const EDIT_DIFF_KEYS = ['rows', 'addedLines', 'removedLines', 'firstChangedLine', 'truncated'] as const
const EDIT_DIFF_KEY_SET = new Set<string>(EDIT_DIFF_KEYS)
const CONTEXT_ROW_KEYS = ['kind', 'oldLine', 'newLine', 'text'] as const
const CONTEXT_ROW_KEY_SET = new Set<string>(CONTEXT_ROW_KEYS)
const REMOVE_ROW_KEYS = ['kind', 'oldLine', 'text'] as const
const REMOVE_ROW_KEY_SET = new Set<string>(REMOVE_ROW_KEYS)
const ADD_ROW_KEYS = ['kind', 'newLine', 'text'] as const
const ADD_ROW_KEY_SET = new Set<string>(ADD_ROW_KEYS)

function isSafeLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function isBoundedRowText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TOOL_DIFF_MAX_ROW_CHARS
}

function checkExactObjectKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  allowed: ReadonlySet<string>,
  path: string,
): string | null {
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      return `${path} must have required property '${key}'`
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return `${path} must NOT have additional properties ('${key}')`
    }
  }
  return null
}

/**
 * Dependency-free structural validator enforcing the exact {@link EDIT_TOOL_RESULT_SCHEMA}
 * contract for browser consumers (`@helmx/protocol/browser`) without pulling TypeBox into
 * eager web bundles.
 */
export function validateEditToolResult(value: unknown): EditToolResultValidation {
  if (!isPlainObject(value)) {
    return { ok: false, error: '(root) must be a plain object' }
  }
  const rootKeyErr = checkExactObjectKeys(value, EDIT_RESULT_KEYS, EDIT_RESULT_KEY_SET, '(root)')
  if (rootKeyErr !== null) return { ok: false, error: rootKeyErr }

  if (typeof value.path !== 'string' || value.path.length < 1) {
    return { ok: false, error: '/path must be a non-empty string' }
  }
  if (typeof value.nodeId !== 'string' || value.nodeId.length < 1) {
    return { ok: false, error: '/nodeId must be a non-empty string' }
  }
  if (value.replaced !== true) {
    return { ok: false, error: '/replaced must be true' }
  }
  if (!isPlainObject(value.diff)) {
    return { ok: false, error: '/diff must be a plain object' }
  }

  const diff = value.diff
  const diffKeyErr = checkExactObjectKeys(diff, EDIT_DIFF_KEYS, EDIT_DIFF_KEY_SET, '/diff')
  if (diffKeyErr !== null) return { ok: false, error: diffKeyErr }

  if (!Array.isArray(diff.rows)) {
    return { ok: false, error: '/diff/rows must be an array' }
  }
  if (diff.rows.length > TOOL_DIFF_MAX_ROWS) {
    return { ok: false, error: `/diff/rows must NOT have more than ${TOOL_DIFF_MAX_ROWS} items` }
  }

  for (let i = 0; i < diff.rows.length; i += 1) {
    if (!Object.hasOwn(diff.rows, i)) {
      return { ok: false, error: `/diff/rows/${i} must be a plain object` }
    }
    const row = diff.rows[i]
    const rowPath = `/diff/rows/${i}`
    if (!isPlainObject(row)) {
      return { ok: false, error: `${rowPath} must be a plain object` }
    }
    switch (row.kind) {
      case 'context': {
        const keyErr = checkExactObjectKeys(row, CONTEXT_ROW_KEYS, CONTEXT_ROW_KEY_SET, rowPath)
        if (keyErr !== null) return { ok: false, error: keyErr }
        if (!isSafeLineNumber(row.oldLine)) {
          return { ok: false, error: `${rowPath}/oldLine must be an integer >= 1` }
        }
        if (!isSafeLineNumber(row.newLine)) {
          return { ok: false, error: `${rowPath}/newLine must be an integer >= 1` }
        }
        if (!isBoundedRowText(row.text)) {
          return { ok: false, error: `${rowPath}/text must be a string of at most ${TOOL_DIFF_MAX_ROW_CHARS} chars` }
        }
        break
      }
      case 'remove': {
        const keyErr = checkExactObjectKeys(row, REMOVE_ROW_KEYS, REMOVE_ROW_KEY_SET, rowPath)
        if (keyErr !== null) return { ok: false, error: keyErr }
        if (!isSafeLineNumber(row.oldLine)) {
          return { ok: false, error: `${rowPath}/oldLine must be an integer >= 1` }
        }
        if (!isBoundedRowText(row.text)) {
          return { ok: false, error: `${rowPath}/text must be a string of at most ${TOOL_DIFF_MAX_ROW_CHARS} chars` }
        }
        break
      }
      case 'add': {
        const keyErr = checkExactObjectKeys(row, ADD_ROW_KEYS, ADD_ROW_KEY_SET, rowPath)
        if (keyErr !== null) return { ok: false, error: keyErr }
        if (!isSafeLineNumber(row.newLine)) {
          return { ok: false, error: `${rowPath}/newLine must be an integer >= 1` }
        }
        if (!isBoundedRowText(row.text)) {
          return { ok: false, error: `${rowPath}/text must be a string of at most ${TOOL_DIFF_MAX_ROW_CHARS} chars` }
        }
        break
      }
      default:
        return { ok: false, error: `${rowPath}/kind must be 'context', 'remove', or 'add'` }
    }
  }

  if (!isSafeNonNegativeInt(diff.addedLines)) {
    return { ok: false, error: '/diff/addedLines must be a safe non-negative integer' }
  }
  if (!isSafeNonNegativeInt(diff.removedLines)) {
    return { ok: false, error: '/diff/removedLines must be a safe non-negative integer' }
  }
  if (!isSafeLineNumber(diff.firstChangedLine)) {
    return { ok: false, error: '/diff/firstChangedLine must be an integer >= 1' }
  }
  if (typeof diff.truncated !== 'boolean') {
    return { ok: false, error: '/diff/truncated must be a boolean' }
  }

  return { ok: true, value: value as unknown as EditToolResult }
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

/**
 * Single source of truth of foundational kernel tool names installed under `helmx-core`
 * (`packages/kernel/src/runtime/tool-registry.ts`). Consumed by `PluginHost` /
 * `CapabilityRegistry` to reject plugin tool registrations that collide with kernel tools
 * without coupling the plugin host to runtime tool implementations.
 */
export const KERNEL_TOOL_NAMES = [
  'bash',
  'read',
  'write',
  'edit',
  'read_artifact',
  'register_artifact',
  'run_action',
] as const

export type KernelToolName = (typeof KERNEL_TOOL_NAMES)[number]

/** Shared lookup map from kernel built-in tool name to its declared `presentationMetaSchema`. */
export const KERNEL_TOOL_PRESENTATION_META_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  read: READ_TOOL_META_SCHEMA,
  write: WRITE_TOOL_META_SCHEMA,
  edit: EDIT_TOOL_RESULT_SCHEMA,
  bash: BASH_TOOL_META_SCHEMA,
  register_artifact: ARTIFACT_REGISTER_META_SCHEMA,
  read_artifact: ARTIFACT_READ_META_SCHEMA,
}
