/**
 * Declarative Core Operation Contract driving Hub HTTP API + `core:*` Actions + Static Core CLI
 * from one source of truth (server/CLI-only; never exported from `@helmx/protocol/browser`).
 */
import { NODE_ID_PATTERN } from '../agent-exec.js'
import type { ConversationScope } from '../conversation.js'
import type { ExecutionText } from '../locale.js'
import type {
  JsonSchema,
  PluginActionCliPositionalSpec,
  PluginActionVisibility,
} from '../plugin-contract-types.js'
import { REQUEST_SCHEMA_PATTERNS } from '../request-schemas.js'

export type CoreOperationHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type CoreOperationBodyMode = 'required' | 'optional' | 'none'

/** Built-in boundary validator names enforced on URL `:param` segments before JSON Schema check. */
export type CoreOperationParamValidator = 'id' | 'nodeId' | 'forwardId' | 'positiveInt' | 'nonEmpty'

export interface CoreOperationPositionalSpec extends PluginActionCliPositionalSpec {
  /** Optional CLI help placeholder name without angle brackets (defaults to `field`, e.g. `nodeId` for `id`). */
  readonly label?: string
}

export interface CoreOperationHttpSpec {
  readonly method: CoreOperationHttpMethod
  /** Full Hub API path, e.g. `/api/nodes`, `/api/nodes/:id`, `/api/nodes/:id/upgrade/check`. */
  readonly path: string
  /** HTTP success status code (defaults to `200`). */
  readonly status?: number
  /** Maps `:paramName` URL segments to property names on the validated input object. */
  readonly pathParams?: Readonly<Record<string, string>>
  /** Per-path-param boundary validators applied before schema validation. */
  readonly pathValidators?: Readonly<Record<string, CoreOperationParamValidator>>
  /** Query parameter names mapped from `url.searchParams` onto the input object. */
  readonly queryParams?: readonly string[]
  /** How HTTP request bodies are parsed (`'none'` skips body parsing; `'optional'` defaults empty body to `{}`). */
  readonly bodyMode?: CoreOperationBodyMode
  /** Extra headers added to the success HTTP response (e.g. `{ 'cache-control': 'no-store' }`). */
  readonly responseHeaders?: Readonly<Record<string, string>>
  /** Set to `false` to skip outbound SecretStash redaction (e.g. one-time plaintext token issuance). Defaults to `true`. */
  readonly redactResponse?: boolean
  /**
   * When `true`, requests whose path matches this route with an unmatched HTTP method return
   * `405 method_not_allowed` instead of falling through to `404 not_found`.
   */
  readonly methodNotAllowed?: boolean
}

export interface CoreOperationCliSpec {
  /** Static CLI command tokens after `helmx`, e.g. `['nodes', 'list']`. */
  readonly command: readonly string[]
  /** Optional CLI-specific help description (defaults to `spec.description`). */
  readonly description?: ExecutionText
  /** Ordered positional argument definitions mapped to fields on the input object. */
  readonly positional?: readonly CoreOperationPositionalSpec[]
  /** Map from input schema property name to CLI flag name (without leading `--`). */
  readonly flagAliases?: Readonly<Record<string, string>>
  /** Request timeout override in milliseconds (`0` disables timeout, e.g. `nodes.upgrade`). */
  readonly timeoutMs?: number
  /**
   * True when multiple operations share one composite CLI command (e.g. `nodes.upgrade` +
   * `nodes.upgrade_check` both map to `helmx nodes upgrade`). Auto-generation skips shared entries
   * so the composite `customHandler` owns the single CLI entry.
   */
  readonly sharedCommand?: boolean
}

export interface CoreOperationActionSpec {
  /** Whether the action is idempotent/read-only (default `false`). */
  readonly idempotent?: boolean
  /** Optional conversation execution scope restriction. */
  readonly scope?: ConversationScope
  /** Visibility tier in `ActionRegistry` (defaults to `'public'`). */
  readonly visibility?: PluginActionVisibility
  /** Override prompt catalog visibility (core actions default to `false`). */
  readonly exposeToPrompt?: boolean
  /** Optional extended input schema for `core:*` Action invocation when it diverges from HTTP `inputSchema` (e.g. CAS `expectedStateSeq` / `ownedBy`). */
  readonly inputSchema?: JsonSchema
}

export interface CoreOperationSpec<
  TKey extends string = string,
  TDomain extends string = string,
  TId extends string = string,
> {
  readonly key: TKey
  readonly domain: TDomain
  readonly id: TId
  readonly description: ExecutionText
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly http: CoreOperationHttpSpec
  readonly cli: CoreOperationCliSpec
  readonly action: CoreOperationActionSpec | false
}

export type CoreOperationKey<TOps extends readonly CoreOperationSpec[]> = TOps[number]['key']

export type CoreActionOperations<TOps extends readonly CoreOperationSpec[]> = Extract<
  TOps[number],
  { readonly action: CoreOperationActionSpec }
>

export type CoreActionOperationKey<TOps extends readonly CoreOperationSpec[]> =
  CoreActionOperations<TOps>['key']

// ---------------------------------------------------------------------------
// Shared JSON Schema & scope primitives for Core Operation declarations
// ---------------------------------------------------------------------------

export const CORE_HOST_GOVERNANCE_SCOPE: ConversationScope = { topLevelOnly: true, ownedBy: 'human' }
export const CORE_NO_CONVERSATION_SCOPE: ConversationScope = { conversationIds: [] }

export const CORE_EMPTY_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

export const CORE_OK_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
}

export const CORE_OBJECT_OUTPUT_SCHEMA: JsonSchema = { type: 'object' }
export const CORE_ARRAY_OUTPUT_SCHEMA: JsonSchema = { type: 'array', items: { type: 'object' } }

export const CORE_ID_SCHEMA: JsonSchema = { type: 'string', pattern: REQUEST_SCHEMA_PATTERNS.id.source }
export const CORE_NODE_ID_SCHEMA: JsonSchema = { type: 'string', pattern: NODE_ID_PATTERN }
export const CORE_FORWARD_ID_SCHEMA: JsonSchema = {
  type: 'string',
  pattern: '^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}

/** Deep-clone a TypeBox / protocol schema into a plain symbol-free JSON Schema object. */
export function cloneProtocolJsonSchema(schema: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema
}

/** Compose a strict object JSON Schema by extending a protocol schema with extra properties. */
export function extendCoreObjectSchema(
  base: unknown,
  extraProperties: Record<string, JsonSchema>,
  extraRequired: readonly string[] = [],
): JsonSchema {
  const cloned = cloneProtocolJsonSchema(base)
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
