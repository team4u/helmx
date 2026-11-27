/**
 * Shared building blocks for every `core:*` domain module: JSON Schema fragments, conversation
 * scope presets, schema helpers, and the strict-JSON normalizing registrar.
 *
 * Domain modules (`conversation.ts`, `profile.ts`, ...) depend on this module and the runtime
 * host only; nothing here knows about individual actions.
 */
import {
  NODE_ID_PATTERN,
  REQUEST_SCHEMA_PATTERNS,
  isStrictSemver,
  stripSemverVPrefix,
  type ConversationScope,
  type JsonSchema,
  type PluginActionSpec,
} from '@helmx/protocol'
import { ValidationError } from '../../http/validate.js'
import { stripUndefinedProperties } from '../../shared/json.js'
import type { PluginHost } from '../../plugins/plugin-host.js'

/** Registration surface consumed by each domain module (keeps them independent of the full `PluginHost`). */
export type CoreActionRegistrar = Pick<PluginHost, 'registerCoreAction'>

const MAX_SAFE_INTEGER = 9007199254740991

export const SAFE_POSITIVE_INT: JsonSchema = { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER }
export const SAFE_NON_NEGATIVE_INT: JsonSchema = { type: 'integer', minimum: 0, maximum: MAX_SAFE_INTEGER }
export const OWNERSHIP_SCHEMA: JsonSchema = { type: 'string', enum: ['human', 'helmx'] }
export const ID_STRING: JsonSchema = { type: 'string', pattern: REQUEST_SCHEMA_PATTERNS.id.source }
export const NODE_ID_STRING: JsonSchema = { type: 'string', pattern: NODE_ID_PATTERN }
export const FORWARD_ID_STRING: JsonSchema = {
  type: 'string',
  pattern: '^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}
export const DOC_NAME_STRING: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }
export const NON_EMPTY_STRING: JsonSchema = { type: 'string', minLength: 1 }
export const NON_WHITESPACE_STRING: JsonSchema = { type: 'string', pattern: '\\S' }

export const EMPTY_INPUT_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false }
export const OK_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
}
export const OBJECT_OUTPUT_SCHEMA: JsonSchema = { type: 'object' }
export const ARRAY_OF_OBJECTS_OUTPUT_SCHEMA: JsonSchema = { type: 'array', items: { type: 'object' } }

/** Host-governance mutations: allowed only from top-level human-owned sessions (or direct human HTTP/CLI). */
export const HOST_GOVERNANCE_SCOPE: ConversationScope = { topLevelOnly: true, ownedBy: 'human' }
/** Human-only HTTP/CLI actions: blocked from every conversation context (`run_action` / session HTTP). */
export const NO_CONVERSATION_SCOPE: ConversationScope = { conversationIds: [] }

/** Clone a TypeBox / protocol schema into a clean, symbol-free JSON Schema object. */
export function toJsonSchema(schema: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema
}

/** Compose a strict object JSON Schema by extending a protocol `REQUEST_SCHEMAS.*` entry with extra properties. */
export function extendRequestSchema(
  base: unknown,
  extraProperties: Record<string, JsonSchema>,
  extraRequired: readonly string[] = [],
): JsonSchema {
  const cloned = toJsonSchema(base)
  const baseProps = (cloned.properties ?? {}) as Record<string, unknown>
  const baseRequired = Array.isArray(cloned.required) ? (cloned.required as string[]) : []
  const required = [...new Set([...extraRequired, ...baseRequired])]
  return {
    type: 'object',
    properties: { ...extraProperties, ...baseProps },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export function requireStrictSemverField(raw: string): string {
  if (raw.trim() === '') {
    throw new ValidationError('targetVersion must be a non-empty version (omit to upgrade to latest)')
  }
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strict SemVer (optional single v prefix, e.g. 1.2.3 or v1.2.3)')
  }
  return raw
}

/**
 * Normalize kernel DTOs to strict JSON values by omitting object keys whose value is `undefined`
 * (matching HTTP `JSON.stringify` serialization so `CapabilityRegistry`'s strict `jsonClone` accepts
 * optional TypeScript fields like `parentConversationId: undefined` or `description: undefined`).
 */
export function toStrictJsonValue<T>(value: T): T {
  return stripUndefinedProperties(value, {
    onCycle: 'throw',
    cycleErrorMessage: 'Core action output contains a circular reference',
    objectFilter: 'all-objects',
  })
}

/** Register a single core action while normalizing returned kernel DTOs for strict JSON cloning. */
export function registerCore<TIn, TOut>(
  pluginHost: PluginHost,
  ownerId: string,
  spec: PluginActionSpec<TIn, TOut>,
): void {
  pluginHost.registerCoreAction<TIn, TOut>(ownerId, {
    ...spec,
    handler: async (input: TIn, context) => toStrictJsonValue(await spec.handler(input, context)),
  })
}
