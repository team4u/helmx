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

const lineNumber = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const
const text = { type: 'string', maxLength: TOOL_DIFF_MAX_ROW_CHARS } as const

/**
 * SDK output and the Web presentation entry share the same schema, rejecting forged line numbers and invalid data.
 * Typed with a structural schema shape (never TypeBox) so `@helmx/protocol/browser` validates directly against it.
 */
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
} as const

export type EditToolResultValidation =
  | { ok: true; value: EditToolResult }
  | { ok: false; error: string }

interface MiniSchemaNode {
  readonly type?: 'object' | 'array' | 'string' | 'integer' | 'boolean'
  readonly const?: unknown
  readonly minLength?: number
  readonly maxLength?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly maxItems?: number
  readonly properties?: Readonly<Record<string, MiniSchemaNode>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: MiniSchemaNode
  readonly oneOf?: readonly MiniSchemaNode[]
}

function validateMiniSchemaNode(schema: MiniSchemaNode, value: unknown, path: string): string | null {
  if (Object.hasOwn(schema, 'const')) {
    return value === schema.const ? null : `${path} must equal ${JSON.stringify(schema.const)}`
  }
  if (schema.oneOf !== undefined) {
    let matches = 0
    for (const branch of schema.oneOf) {
      if (validateMiniSchemaNode(branch, value, path) === null) {
        matches += 1
      }
    }
    return matches === 1 ? null : `${path} must match exactly one allowed shape`
  }
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) return `${path} must be a plain object`
      if (schema.required !== undefined) {
        for (const key of schema.required) {
          if (!Object.hasOwn(value, key)) return `${path} must have required property '${key}'`
        }
      }
      if (schema.additionalProperties === false && schema.properties !== undefined) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties, key)) {
            return `${path} must NOT have additional properties ('${key}')`
          }
        }
      }
      if (schema.properties !== undefined) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (!Object.hasOwn(value, key)) continue
          const err = validateMiniSchemaNode(propSchema, value[key], path === '(root)' ? `/${key}` : `${path}/${key}`)
          if (err !== null) return err
        }
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} must NOT have more than ${schema.maxItems} items`
      }
      if (schema.items !== undefined) {
        for (let i = 0; i < value.length; i += 1) {
          const itemPath = `${path}/${i}`
          if (!Object.hasOwn(value, i)) return `${itemPath} must not be a sparse array hole`
          const err = validateMiniSchemaNode(schema.items, value[i], itemPath)
          if (err !== null) return err
        }
      }
      return null
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must NOT have fewer than ${schema.minLength} characters`
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must NOT have more than ${schema.maxLength} characters`
      }
      return null
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${path} must be an integer`
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`
    default:
      return `${path} has unsupported schema node`
  }
}

/**
 * Dependency-free structural validator executing directly against {@link EDIT_TOOL_RESULT_SCHEMA}
 * for browser consumers (`@helmx/protocol/browser`) without pulling TypeBox into eager web bundles.
 */
export function validateEditToolResult(value: unknown): EditToolResultValidation {
  const error = validateMiniSchemaNode(EDIT_TOOL_RESULT_SCHEMA, value, '(root)')
  if (error !== null) return { ok: false, error }
  return { ok: true, value: value as EditToolResult }
}

const nonNegativeInt = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

/** Truncation telemetry schema emitted by paginated `read` when file output hits line or byte bounds. */
export const READ_TOOL_TRUNCATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    truncated: { type: 'boolean' },
    truncatedBy: { type: 'string', enum: ['lines', 'bytes'] },
    totalLines: nonNegativeInt,
    totalBytes: nonNegativeInt,
    outputLines: nonNegativeInt,
    outputBytes: nonNegativeInt,
    lastLinePartial: { type: 'boolean' },
    firstLineExceedsLimit: { type: 'boolean' },
    maxLines: nonNegativeInt,
    maxBytes: nonNegativeInt,
  },
  required: ['truncated', 'totalLines', 'totalBytes', 'outputLines', 'outputBytes', 'maxLines', 'maxBytes'],
  additionalProperties: false,
}

/** Presentation metadata schema for built-in `read` tool (omits full file content already in model output). */
export const READ_TOOL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    mimeType: { type: 'string', minLength: 1 },
    imageUnsupportedByModel: { type: 'string', minLength: 1 },
    truncation: READ_TOOL_TRUNCATION_SCHEMA,
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

/** Presentation metadata schema for built-in `ask_user` tool (summary of posed questions and human answers). */
export const ASK_USER_TOOL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    questionCount: { type: 'integer', minimum: 1, maximum: 4 },
    outcome: { type: 'string', enum: ['answered', 'cancelled', 'superseded', 'error'] },
    items: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          question: { type: 'string', minLength: 1, maxLength: 300 },
          answer: { type: 'string', maxLength: 1000 },
        },
        required: ['id', 'question', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'questionCount', 'outcome'],
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
  'ask_user',
  'load_skill',
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
  ask_user: ASK_USER_TOOL_META_SCHEMA,
}
