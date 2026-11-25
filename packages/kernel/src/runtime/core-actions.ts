/**
 * Core kernel actions (`core:*` reserved namespace):
 *
 * Registers structured, schema-validated internal actions directly onto `PluginHost` via
 * `registerCoreAction`, reusing `@helmx/protocol` `REQUEST_SCHEMAS` and real kernel services
 * without duplicating business logic.
 *
 * Security & visibility invariants:
 * - Every `core:*` action sets `exposeToPrompt: false` and `cli: { hidden: true, command: [...] }`:
 *   hidden from `<available_actions>` prompt bloat and dynamic CLI registration (never colliding
 *   with `CORE_CLI_COMMAND_PATHS`), yet discoverable on demand via `run_action({ list: true, pluginId: "core:" })`;
 * - `core:*` never appears in `PluginHost.list()` / `GET /api/plugins` / Plugin Center;
 * - Watchdog Ownership Red Line (`AGENTS.md` §3): a `helmx`-owned session cannot mutate a `human`-owned
 *   conversation via `core:conversations.{update,send,withdraw,abort,reset,compact,delete}` (`403 ownership_violation`);
 * - Self-Mutation Guard: a session cannot `abort`, `reset`, or `delete` itself (`409 self_mutation_forbidden`);
 * - Honest `origin`: `core:conversations.send` always forces `origin: 'agent'` inside any conversation context;
 * - Host-governance mutations require top-level `human`-owned sessions (`scope: { topLevelOnly: true, ownedBy: 'human' }`);
 * - `core:asks.answer` and `core:skills.{list,read}` are blocked from all conversation contexts (`scope: { conversationIds: [] }`);
 * - `core:plugins.config_get` masks `secret: true` fields identically to `GET /api/plugins/:id/config`,
 *   `core:models.providers` exposes only sanitized summaries, and credential writes / `providers.set` /
 *   `nodes.issue` / `env.exec` are intentionally never exposed as `core:*` actions.
 */
import {
  HelmxError,
  NODE_ID_PATTERN,
  REQUEST_SCHEMAS,
  REQUEST_SCHEMA_PATTERNS,
  isStrictSemver,
  stripSemverVPrefix,
  type ConversationListFilter,
  type ConversationOwnership,
  type ConversationScope,
  type ConversationStatus,
  type JsonSchema,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginConfigFieldSchema,
  type Profile,
} from '@helmx/protocol'
import {
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseDocNameParam,
  parseInputBody,
  parseProfileBody,
  ValidationError,
} from '../http/validate.js'
import { assertDoctorTargetDir } from '../plugins/doctor-target.js'
import type { PluginHost } from '../plugins/plugin-host.js'
import { redactJsonValue } from '../redact.js'
import { parseSearchTerms } from './fts-search.js'
import type { KernelRuntime } from './runtime.js'

const MAX_SAFE_INTEGER = 9007199254740991

const SAFE_POSITIVE_INT: JsonSchema = { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER }
const ID_STRING: JsonSchema = { type: 'string', pattern: REQUEST_SCHEMA_PATTERNS.id.source }
const NODE_ID_STRING: JsonSchema = { type: 'string', pattern: NODE_ID_PATTERN }
const FORWARD_ID_STRING: JsonSchema = {
  type: 'string',
  pattern: '^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}
const DOC_NAME_STRING: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }
const NON_EMPTY_STRING: JsonSchema = { type: 'string', minLength: 1 }
const NON_WHITESPACE_STRING: JsonSchema = { type: 'string', pattern: '\\S' }

const EMPTY_INPUT_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false }
const OK_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
}
const OBJECT_OUTPUT_SCHEMA: JsonSchema = { type: 'object' }
const ARRAY_OF_OBJECTS_OUTPUT_SCHEMA: JsonSchema = { type: 'array', items: { type: 'object' } }

/** Host-governance mutations: allowed only from top-level human-owned sessions (or direct human HTTP/CLI). */
const HOST_GOVERNANCE_SCOPE: ConversationScope = { topLevelOnly: true, ownedBy: 'human' }
/** Human-only HTTP/CLI actions: blocked from every conversation context (`run_action` / session HTTP). */
const NO_CONVERSATION_SCOPE: ConversationScope = { conversationIds: [] }

/** Clone a TypeBox / protocol schema into a clean, symbol-free JSON Schema object. */
function toJsonSchema(schema: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema
}

/** Compose a strict object JSON Schema by extending a protocol `REQUEST_SCHEMAS.*` entry with extra properties. */
function extendRequestSchema(
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

function assertNotSelfMutation(
  context: PluginActionContext,
  targetConversationId: number,
  actionId: string,
): void {
  if (context.conversationId !== undefined && context.conversationId === targetConversationId) {
    throw new HelmxError(
      'self_mutation_forbidden',
      `conversation ${targetConversationId} cannot invoke core:conversations.${actionId} on itself`,
      409,
      { conversationId: targetConversationId, actionId },
    )
  }
}

/**
 * Watchdog Ownership Red Line (`AGENTS.md` §3):
 * When invoked from a `helmx`-owned background conversation, refuse any mutation targeting a `human`-owned
 * conversation (and, for cascading deletes, any `human`-owned descendant).
 */
function assertCanMutateConversation(
  runtime: KernelRuntime,
  context: PluginActionContext,
  targetConversationId: number,
  options?: { checkSubtree?: boolean },
): void {
  if (context.conversationId === undefined) return
  const callerOwnedBy = runtime.ownership.getOwnership(context.conversationId)
  if (callerOwnedBy !== 'helmx') return
  const targetOwnedBy = runtime.ownership.getOwnership(targetConversationId)
  if (targetOwnedBy === 'human') {
    throw new HelmxError(
      'ownership_violation',
      `helmx-owned conversation ${context.conversationId} cannot mutate human-owned conversation ${targetConversationId}`,
      403,
      {
        callerConversationId: context.conversationId,
        targetConversationId,
        callerOwnedBy,
        targetOwnedBy,
      },
    )
  }
  if (options?.checkSubtree !== true) return
  const childrenOf = new Map<number, number[]>()
  for (const conv of runtime.conversations.listConversations()) {
    if (conv.parentConversationId === undefined) continue
    const list = childrenOf.get(conv.parentConversationId)
    if (list !== undefined) list.push(conv.id)
    else childrenOf.set(conv.parentConversationId, [conv.id])
  }
  const queue = [...(childrenOf.get(targetConversationId) ?? [])]
  const visited = new Set<number>([targetConversationId])
  while (queue.length > 0) {
    const childId = queue.shift()!
    if (visited.has(childId)) continue
    visited.add(childId)
    const childOwnedBy = runtime.ownership.getOwnership(childId)
    if (childOwnedBy === 'human') {
      throw new HelmxError(
        'ownership_violation',
        `helmx-owned conversation ${context.conversationId} cannot delete conversation ${targetConversationId}: derived conversation ${childId} is owned by human`,
        403,
        {
          callerConversationId: context.conversationId,
          targetConversationId,
          blockedDescendantId: childId,
          callerOwnedBy,
          targetOwnedBy: childOwnedBy,
        },
      )
    }
    for (const grand of childrenOf.get(childId) ?? []) queue.push(grand)
  }
}

function assertProfileModelEnabled(runtime: KernelRuntime, profile: Profile): void {
  if (profile.model === undefined) return
  const slash = profile.model.indexOf('/')
  runtime.models.assertModelEnabled(profile.model.slice(0, slash), profile.model.slice(slash + 1))
}

function requireHttpUrl(raw: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} must be a valid http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must be an http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} must contain a hostname`)
  }
  return raw
}

function requireStrictSemverField(raw: string): string {
  if (raw.trim() === '') {
    throw new ValidationError('targetVersion must be a non-empty version (omit to upgrade to latest)')
  }
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strict SemVer (optional single v prefix, e.g. 1.2.3 or v1.2.3)')
  }
  return raw
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function looksLikePathTarget(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  )
}

function redactPluginConfigValues(
  raw: Record<string, unknown>,
  schema: Record<string, PluginConfigFieldSchema>,
  redactText: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(schema, key)) continue
    if (schema[key]?.secret === true) {
      out[key] = typeof value === 'string' && value.length > 0 ? '******' : ''
    } else {
      out[key] = redactJsonValue(value, redactText)
    }
  }
  return out
}

/**
 * Normalize kernel DTOs to strict JSON values by omitting object keys whose value is `undefined`
 * (matching HTTP `JSON.stringify` serialization so `CapabilityRegistry`'s strict `jsonClone` accepts
 * optional TypeScript fields like `parentConversationId: undefined` or `description: undefined`).
 */
function toStrictJsonValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) {
    throw new HelmxError('invalid_json_value', 'Core action output contains a circular reference', 500)
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toStrictJsonValue(item, seen)) as unknown as T
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      out[key] = toStrictJsonValue(entry, seen)
    }
    return out as T
  } finally {
    seen.delete(value)
  }
}

/** Register a single core action while normalizing returned kernel DTOs for strict JSON cloning. */
function registerCore<TIn, TOut>(
  pluginHost: PluginHost,
  ownerId: string,
  spec: PluginActionSpec<TIn, TOut>,
): void {
  pluginHost.registerCoreAction<TIn, TOut>(ownerId, {
    ...spec,
    handler: async (input: TIn, context) => toStrictJsonValue(await spec.handler(input, context)),
  })
}

/** Register all kernel-owned `core:*` actions onto `pluginHost`. */
export function registerCoreActions(runtime: KernelRuntime, pluginHost: PluginHost): void {
  const hostProxy = {
    registerCoreAction: <TIn, TOut>(ownerId: string, spec: PluginActionSpec<TIn, TOut>): void =>
      registerCore(pluginHost, ownerId, spec),
  } as Pick<PluginHost, 'registerCoreAction'>
  registerConversationCoreActions(runtime, hostProxy)
  registerProfileCoreActions(runtime, hostProxy)
  registerModelCoreActions(runtime, hostProxy)
  registerNodeCoreActions(runtime, hostProxy)
  registerPluginCoreActions(runtime, hostProxy, pluginHost)
  registerAskCoreActions(runtime, hostProxy)
  registerSkillCoreActions(runtime, hostProxy)
}

type CoreActionRegistrar = Pick<PluginHost, 'registerCoreAction'>

// ---------------------------------------------------------------------------
// core:conversations
// ---------------------------------------------------------------------------

function registerConversationCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:conversations'

  pluginHost.registerCoreAction(owner, {
    id: 'search',
    description: 'Full-text FTS5 search across conversation titles and message bodies',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['search'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.conversationSearchQuery),
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async (input: {
      q: string
      limit?: number
      maxPerConversation?: number
      profileId?: string
      ownedBy?: ConversationOwnership
      topLevelOnly?: boolean
    }) => {
      if (input.q.trim().length === 0 || parseSearchTerms(input.q).terms.length === 0) {
        throw new ValidationError('q cannot be empty')
      }
      const options = {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.maxPerConversation !== undefined ? { maxPerConversation: input.maxPerConversation } : {}),
        ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
        ...(input.ownedBy !== undefined ? { ownedBy: input.ownedBy } : {}),
        ...(input.topLevelOnly !== undefined ? { topLevelOnly: input.topLevelOnly } : {}),
      }
      return runtime.conversations.search(
        input.q,
        Object.keys(options).length > 0 ? options : undefined,
      )
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description:
      'List conversations with optional filters (defaults to top-level human conversations unless all/parentConversationId/tag/ownedBy/topLevelOnly=false is specified)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'list'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.conversationListQuery),
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: (input: {
      profileId?: string
      status?: ConversationStatus
      tag?: string
      ownedBy?: ConversationOwnership
      parentConversationId?: number
      topLevelOnly?: boolean
      all?: boolean
    }) => {
      if (input.all === true && input.parentConversationId !== undefined) {
        throw new ValidationError('all and parentConversationId are mutually exclusive')
      }
      if (input.topLevelOnly === true && input.parentConversationId !== undefined) {
        throw new ValidationError('topLevelOnly and parentConversationId are mutually exclusive')
      }
      if (input.topLevelOnly === true && input.all === true) {
        throw new ValidationError('topLevelOnly and all are mutually exclusive')
      }
      const effectiveTopLevelOnly =
        input.topLevelOnly !== undefined
          ? input.topLevelOnly
          : input.parentConversationId === undefined && input.all !== true
            ? true
            : undefined
      const effectiveOwnedBy: ConversationOwnership | undefined =
        input.ownedBy !== undefined
          ? input.ownedBy
          : input.parentConversationId === undefined &&
              input.all !== true &&
              input.tag === undefined &&
              input.topLevelOnly !== false
            ? 'human'
            : undefined
      const filter: ConversationListFilter = {
        ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
        ...(input.parentConversationId !== undefined ? { parentConversationId: input.parentConversationId } : {}),
        ...(effectiveTopLevelOnly === true ? { topLevelOnly: true } : {}),
      }
      return runtime.conversations.listConversations(filter)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'get',
    description: 'Get conversation summary and paginated timeline entries (use nextCursor for older pages)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'get'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        cursor: NON_EMPTY_STRING,
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; limit?: number; cursor?: string }) =>
      runtime.conversations.getConversationDetail(input.conversationId, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'entry',
    description: 'Read a single untruncated timeline entry from a conversation',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'entry'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        entryId: SAFE_POSITIVE_INT,
      },
      required: ['conversationId', 'entryId'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; entryId: number }) =>
      runtime.conversations.getConversationEntry(input.conversationId, input.entryId),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'create',
    description: 'Create a new conversation',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'create'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.conversationInit),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown>) =>
      runtime.conversations.createConversation(parseConversationInit(input)),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'update',
    description: 'Partially update conversation metadata, profile, model, thinking level, node, or cwd',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'update'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationPatch,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { conversationId: number }, context) => {
      assertCanMutateConversation(runtime, context, input.conversationId)
      const { conversationId, ...rest } = input
      return runtime.conversations.updateConversation(conversationId, parseConversationPatch(rest))
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'send',
    description: 'Submit input to a conversation (optionally waiting for the reply); forces origin="agent" in session context',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['send'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationInput,
      {
        conversationId: SAFE_POSITIVE_INT,
        wait: { type: 'boolean' },
      },
      ['conversationId'],
    ),
    outputSchema: {
      type: 'object',
      properties: { submissionId: { type: 'string' } },
      required: ['submissionId'],
    },
    handler: async (
      input: Record<string, unknown> & { conversationId: number; wait?: boolean },
      context,
    ) => {
      assertCanMutateConversation(runtime, context, input.conversationId)
      const { conversationId, wait, ...rest } = input
      const parsed = parseInputBody(rest)
      // Honest origin invariant: any session-scoped send is agent-originated and cannot spoof human/trigger.
      const effectiveOrigin = context.conversationId !== undefined ? 'agent' : parsed.origin
      const { submissionId } = await runtime.conversations.submitInput(conversationId, parsed.text, {
        ...(effectiveOrigin !== undefined ? { origin: effectiveOrigin } : {}),
        ...(parsed.whenBusy !== undefined ? { whenBusy: parsed.whenBusy } : {}),
        ...(parsed.meta !== undefined ? { meta: parsed.meta } : {}),
        ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
        ...(parsed.replaceFromEntryId !== undefined ? { replaceFromEntryId: parsed.replaceFromEntryId } : {}),
      })
      if (wait === true) {
        return runtime.conversations.waitForInput(conversationId, submissionId, context.signal)
      }
      return { submissionId }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'withdraw',
    description: 'Withdraw a queued input submission from a conversation',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'withdraw'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationWithdraw,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; submissionId: number }, context) => {
      assertCanMutateConversation(runtime, context, input.conversationId)
      return runtime.conversations.withdrawQueuedInput(input.conversationId, {
        submissionId: input.submissionId,
      })
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'abort',
    description: 'Abort the currently running turn of another conversation (self-abort forbidden)',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['abort'] },
    inputSchema: {
      type: 'object',
      properties: { conversationId: SAFE_POSITIVE_INT },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number }, context) => {
      assertNotSelfMutation(context, input.conversationId, 'abort')
      assertCanMutateConversation(runtime, context, input.conversationId)
      await runtime.conversations.abortConversation(input.conversationId)
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'reset',
    description: 'Reset context of another conversation with optional handoff text (self-reset forbidden)',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'reset'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationReset,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { conversationId: number }, context) => {
      assertNotSelfMutation(context, input.conversationId, 'reset')
      assertCanMutateConversation(runtime, context, input.conversationId)
      const { conversationId, ...rest } = input
      return runtime.conversations.resetConversation(conversationId, parseConversationResetBody(rest))
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'compact',
    description: 'Enqueue manual context compaction for a conversation with optional instructions',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'compact'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationCompact,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { conversationId: number }, context) => {
      assertCanMutateConversation(runtime, context, input.conversationId)
      const { conversationId, ...rest } = input
      return runtime.conversations.compactConversation(conversationId, parseConversationCompactBody(rest))
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'fork',
    description: 'Fork a new conversation from a specified entry or latest clean anchor',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'fork'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationFork,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { conversationId: number }) => {
      const { conversationId, ...rest } = input
      return runtime.conversations.forkConversation(conversationId, parseConversationForkBody(rest))
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'delete',
    description: 'Delete another conversation and its derived child subtree (self-delete forbidden)',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['conversations', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { conversationId: SAFE_POSITIVE_INT },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number }, context) => {
      assertNotSelfMutation(context, input.conversationId, 'delete')
      assertCanMutateConversation(runtime, context, input.conversationId, { checkSubtree: true })
      await runtime.conversations.deleteConversation(input.conversationId)
      return { ok: true }
    },
  })
}

// ---------------------------------------------------------------------------
// core:profiles
// ---------------------------------------------------------------------------

function registerProfileCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:profiles'

  const enrichProfile = async (profile: Profile): Promise<Profile> => ({
    ...profile,
    system: await runtime.profiles.getSystem(profile.id),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List all configured Profiles (summary metadata without SYSTEM.md body)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['profiles', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.profiles.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'get',
    description: 'Get a Profile by ID including its full SYSTEM.md text',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['profiles', 'get'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      const found = await runtime.profiles.get(input.id)
      if (found === undefined) {
        throw new HelmxError('not_found', `profile not found: ${input.id}`, 404)
      }
      return enrichProfile(found)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'create',
    description: 'Create a new Profile (rejects managedByPlugin spoofing and disabled models)',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['profiles', 'create'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.profileCreate),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown>) => {
      const profile = parseProfileBody(input, { requireId: true })
      if (profile.managedByPlugin !== undefined) {
        throw new HelmxError(
          'profile_managed_by_plugin',
          'managedByPlugin is declared by plugin bootstrap and cannot be set via profile create',
          403,
          { profileId: profile.id },
        )
      }
      const existing = await runtime.profiles.get(profile.id)
      if (existing?.managedByPlugin !== undefined) {
        throw new HelmxError(
          'profile_managed_by_plugin',
          `cannot overwrite plugin-managed profile ${profile.id}`,
          403,
          { profileId: profile.id, managedByPlugin: existing.managedByPlugin },
        )
      }
      assertProfileModelEnabled(runtime, profile)
      const saved = await runtime.profiles.save(profile)
      await runtime.conversations.alignProfileConversations(saved.id)
      return enrichProfile(saved)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'update',
    description:
      'Partially update an existing Profile (merges provided fields onto current config; managedByPlugin is immutable)',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['profiles', 'update'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.profileUpdate, { id: ID_STRING }, ['id']),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { id: string }) => {
      const existing = await runtime.profiles.get(input.id)
      if (existing === undefined) {
        throw new HelmxError('not_found', `profile not found: ${input.id}`, 404)
      }
      const patch = parseProfileBody(input, { requireId: false })
      if (
        Object.hasOwn(input, 'managedByPlugin') &&
        input.managedByPlugin !== existing.managedByPlugin
      ) {
        throw new HelmxError(
          'profile_managed_by_plugin',
          `profile ${input.id} hosting metadata is declared by a plugin and cannot be set, modified, or removed`,
          403,
          { profileId: input.id, managedByPlugin: existing.managedByPlugin },
        )
      }
      const updatableKeys = Object.keys(input).filter((k) => k !== 'id' && k !== 'managedByPlugin')
      if (updatableKeys.length === 0) {
        throw new ValidationError('profile update requires at least one updatable field')
      }
      const merged: Profile = { ...existing, id: input.id }
      if (Object.hasOwn(input, 'name')) merged.name = patch.name
      if (Object.hasOwn(input, 'model')) {
        if (input.model === '') delete merged.model
        else merged.model = patch.model
      }
      if (Object.hasOwn(input, 'thinkingLevel')) {
        if (input.thinkingLevel === '') delete merged.thinkingLevel
        else merged.thinkingLevel = patch.thinkingLevel
      }
      if (Object.hasOwn(input, 'nodeId')) merged.nodeId = patch.nodeId
      if (Object.hasOwn(input, 'cwd')) merged.cwd = patch.cwd
      if (Object.hasOwn(input, 'tags')) merged.tags = patch.tags
      if (Object.hasOwn(input, 'skills')) merged.skills = patch.skills
      if (Object.hasOwn(input, 'starters')) merged.starters = patch.starters
      if (Object.hasOwn(input, 'restrictToCwd')) merged.restrictToCwd = patch.restrictToCwd
      if (Object.hasOwn(input, 'system')) merged.system = patch.system
      if (existing.managedByPlugin !== undefined) {
        merged.managedByPlugin = existing.managedByPlugin
      } else {
        delete merged.managedByPlugin
      }
      assertProfileModelEnabled(runtime, merged)
      const saved = await runtime.profiles.save(merged)
      await runtime.conversations.alignProfileConversations(saved.id)
      return enrichProfile(saved)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'delete',
    description: 'Delete an unused, non-managed Profile by ID',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['profiles', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      const inUse = runtime.conversations.listConversations().some((c) => c.profileId === input.id)
      if (inUse) {
        throw new HelmxError(
          'profile_in_use',
          `profile ${input.id} is still bound by conversations; unbind before deleting`,
          409,
        )
      }
      const target = await runtime.profiles.get(input.id)
      if (target?.managedByPlugin !== undefined) {
        throw new HelmxError(
          'profile_managed_by_plugin',
          `profile ${input.id} is managed by plugin ${target.managedByPlugin} and cannot be deleted`,
          403,
          { profileId: input.id, managedByPlugin: target.managedByPlugin },
        )
      }
      await runtime.profiles.delete(input.id, {
        isProfileInUse: async (pid) =>
          runtime.conversations.listConversations().some((c) => c.profileId === pid),
      })
      return { ok: true }
    },
  })
}

// ---------------------------------------------------------------------------
// core:models
// ---------------------------------------------------------------------------

function registerModelCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:models'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List the available model catalog, thinking levels, and current defaults',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['models', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async () => runtime.models.listModels(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'providers',
    description: 'List sanitized model provider summaries (never exposes plaintext API keys or tokens)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['models', 'providers'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () =>
      redactJsonValue(runtime.models.listModelProviders(), (text) => runtime.stash.redact(text)),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'refresh',
    description: 'Refresh dynamic model catalogs for all or specified providers',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['models', 'refresh'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsRefresh),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { provider?: string; providers?: string[]; force?: boolean }) => {
      let providers: string[] | undefined
      if (input.provider !== undefined) providers = [input.provider]
      if (input.providers !== undefined) {
        providers = providers !== undefined ? [...providers, ...input.providers] : [...input.providers]
      }
      return runtime.models.refreshModels({
        ...(providers !== undefined ? { providers } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
      })
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'default',
    description: 'Set global default model, thinking level, compaction defaults, or per-model thinking defaults',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['models', 'default'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsDefaultPut),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: {
      model?: string
      thinkingLevel?: string
      compactionModel?: string
      compactionThinkingLevel?: string
      modelThinking?: string
      modelThinkingLevel?: string
      modelThinkingLevels?: Record<string, string>
    }) => {
      const hasModelThinking = 'modelThinking' in input || 'modelThinkingLevel' in input
      if (hasModelThinking && !('modelThinking' in input && 'modelThinkingLevel' in input)) {
        throw new ValidationError('models default: modelThinking and modelThinkingLevel must be set together')
      }
      const hasModelThinkingLevels = 'modelThinkingLevels' in input
      if (hasModelThinkingLevels && hasModelThinking) {
        throw new ValidationError('models default: modelThinkingLevels cannot be combined with a modelThinking pair')
      }
      const modelThinkingUpdate = hasModelThinking
        ? { model: input.modelThinking!, level: input.modelThinkingLevel! }
        : undefined
      await runtime.models.setDefaultModel(
        input.model,
        input.thinkingLevel,
        input.compactionModel,
        input.compactionThinkingLevel,
        input.modelThinkingLevels,
        modelThinkingUpdate,
      )
      const catalog = await runtime.models.listModels()
      return {
        ok: true,
        defaultModel: catalog.defaultModel ?? '',
        defaultThinkingLevel: catalog.defaultThinkingLevel ?? '',
        modelThinkingLevels: catalog.modelThinkingLevels ?? {},
        defaultCompactionModel: catalog.defaultCompactionModel ?? '',
        defaultCompactionThinkingLevel: catalog.defaultCompactionThinkingLevel ?? '',
      }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'filter',
    description: 'Set disabled models for a provider or clear all disabled model filters',
    exposeToPrompt: false,
    cli: { hidden: true, command: ['models', 'filter'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsFilterPut),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { provider?: string; disabledModels: string[] }) => {
      const catalog = await runtime.models.setDisabledModels(input.provider, input.disabledModels)
      return { ok: true, catalog }
    },
  })
}

// ---------------------------------------------------------------------------
// core:nodes
// ---------------------------------------------------------------------------

function registerNodeCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:nodes'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List registered compute nodes, online status, platform, and health metrics',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.nodes.listNodes(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'upgrade_check',
    description: 'Check available @helmx/node updates for a remote node (defaults to current conversation node when omitted)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'upgrade'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: NODE_ID_STRING,
        registryUrl: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id?: string; registryUrl?: string }, context) => {
      const nodeId =
        input.id ??
        (context.conversationId !== undefined
          ? runtime.conversations.getConversation(context.conversationId).nodeId ?? 'local'
          : undefined)
      if (nodeId === undefined) {
        throw new ValidationError('id is required when no conversation context is present')
      }
      const registryUrl =
        input.registryUrl !== undefined ? requireHttpUrl(input.registryUrl, 'registryUrl') : undefined
      return runtime.nodes.checkNodeUpgrade(nodeId, registryUrl !== undefined ? { registryUrl } : {})
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forwards',
    description: 'List active TCP port-forwarding sessions',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'forwards'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () => runtime.nodeForward.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forward_inspect',
    description: 'Inspect a single active TCP port-forwarding session by forwardId',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'forward-inspect'] },
    inputSchema: {
      type: 'object',
      properties: { id: FORWARD_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: (input: { id: string }) => {
      const session = runtime.nodeForward.get(input.id)
      if (session === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${input.id}`, 404)
      }
      return session
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'remove',
    description: 'Remove a registered remote BYOM node and disconnect it immediately',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'remove'] },
    inputSchema: {
      type: 'object',
      properties: { id: NODE_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await runtime.nodes.removeNode(input.id)
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'upgrade',
    description: 'Execute a self-upgrade on a registered online remote node',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'upgrade'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.nodeUpgrade, { id: NODE_ID_STRING }, ['id']),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string; targetVersion?: string; registryUrl?: string; force?: boolean }) => {
      const opts: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
      if (input.targetVersion !== undefined) {
        opts.targetVersion = requireStrictSemverField(input.targetVersion)
      }
      if (input.registryUrl !== undefined) {
        opts.registryUrl = requireHttpUrl(input.registryUrl, 'registryUrl')
      }
      if (input.force !== undefined) opts.force = input.force
      return runtime.nodes.upgradeNode(input.id, opts)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forward_stop',
    description: 'Stop an active TCP port-forwarding session by forwardId',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['nodes', 'forward-stop'] },
    inputSchema: {
      type: 'object',
      properties: { id: FORWARD_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      if (runtime.nodeForward.get(input.id) === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${input.id}`, 404)
      }
      await runtime.nodeForward.stop(input.id)
      return { ok: true }
    },
  })
}

// ---------------------------------------------------------------------------
// core:plugins
// ---------------------------------------------------------------------------

function registerPluginCoreActions(
  runtime: KernelRuntime,
  registrar: CoreActionRegistrar,
  pluginHost: PluginHost,
): void {
  const owner = 'core:plugins'

  registrar.registerCoreAction(owner, {
    id: 'list',
    description: 'List installed built-in and external plugins with status and capabilities',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () => pluginHost.list(),
  })

  registrar.registerCoreAction(owner, {
    id: 'manifest',
    description: 'Inspect read-only extension contract manifest for one plugin (by id) or all plugins',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'manifest'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      additionalProperties: false,
    },
    outputSchema: {
      anyOf: [OBJECT_OUTPUT_SCHEMA, ARRAY_OF_OBJECTS_OUTPUT_SCHEMA],
    },
    handler: (input: { id?: string }) =>
      input.id !== undefined ? pluginHost.getManifest(input.id) : pluginHost.listManifests(),
  })

  registrar.registerCoreAction(owner, {
    id: 'doc',
    description: 'Read a public global or session-scoped plugin document',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'doc'] },
    inputSchema: {
      type: 'object',
      properties: {
        pluginId: ID_STRING,
        name: DOC_NAME_STRING,
        conversationId: SAFE_POSITIVE_INT,
      },
      required: ['pluginId', 'name'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: (input: { pluginId: string; name: string; conversationId?: number }) => {
      const name = parseDocNameParam(input.name)
      if (input.conversationId !== undefined) {
        return pluginHost.getPublicSessionDoc(input.pluginId, name, input.conversationId)
      }
      return pluginHost.getPublicDoc(input.pluginId, name)
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'config_get',
    description: 'Read plugin configuration schema, sources, and masked values (secret fields are never exposed)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'config'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        values: { type: 'object' },
        schema: { type: 'object' },
        sources: { type: 'object' },
      },
      required: ['values', 'schema'],
    },
    handler: (input: { id: string }) => {
      const schema = pluginHost.getConfigSchema(input.id)
      const raw = pluginHost.getConfig(input.id)
      const sources = pluginHost.getConfigSources(input.id)
      const values = redactPluginConfigValues(raw, schema, (text) => runtime.stash.redact(text))
      return { values, schema, sources }
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'doctor',
    description: 'Run static dry-run diagnostics on an external plugin directory or registered external plugin ID',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'doctor'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginDoctor, {
      target: NON_WHITESPACE_STRING,
    }),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { target?: string; path?: string; id?: string }) => {
      const providedCount =
        (input.target !== undefined ? 1 : 0) +
        (input.path !== undefined ? 1 : 0) +
        (input.id !== undefined ? 1 : 0)
      if (providedCount === 0) {
        throw new ValidationError('must provide one of target, path (absolute directory), or id (registered plugin)')
      }
      if (providedCount > 1) {
        throw new ValidationError('target, path, and id are mutually exclusive; provide only one')
      }
      if (input.path !== undefined) {
        assertDoctorTargetDir(input.path, 'path')
        return pluginHost.doctorExternalPlugin({ dir: input.path })
      }
      if (input.id !== undefined) {
        return pluginHost.doctorExternalPlugin({ id: input.id })
      }
      const target = input.target!
      if (looksLikePathTarget(target)) {
        assertDoctorTargetDir(target, 'target')
        return pluginHost.doctorExternalPlugin({ dir: target })
      }
      return pluginHost.doctorExternalPlugin({ id: target })
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'config_set',
    description: 'Update plugin configuration values (pass null for a key to reset to default)',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'config'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginConfigPut, { id: ID_STRING }, ['id']),
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string; values: Record<string, unknown> }) => {
      await pluginHost.setConfig(input.id, { ...input.values })
      return { ok: true }
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'enable',
    description: 'Enable a registered plugin',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'enable'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await pluginHost.enable(input.id)
      return pluginHost.list()
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'disable',
    description: 'Disable a registered plugin (pass force: true to bypass persistent resource-in-use warnings; live tasks still block)',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'disable'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginDisable, { id: ID_STRING }, ['id']),
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async (input: { id: string; force?: boolean }) => {
      await pluginHost.disable(input.id, input.force === true ? { force: true } : undefined)
      return pluginHost.list()
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'reload',
    description: 'Hot-reload an external plugin with doctor preflight',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'reload'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => pluginHost.reloadExternalPlugin(input.id),
  })

  registrar.registerCoreAction(owner, {
    id: 'rescan',
    description: 'Incrementally rescan the external plugins directory and register newly discovered plugins as disabled',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['plugins', 'rescan'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async () => pluginHost.rescanExternalPlugins(),
  })
}

// ---------------------------------------------------------------------------
// core:asks
// ---------------------------------------------------------------------------

function registerAskCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:asks'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List AskDoc approval requests, optionally filtered by conversationId and/or status',
    idempotent: true,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['asks', 'list'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        status: { type: 'string', enum: ['pending', 'answered', 'cancelled', 'superseded'] },
      },
      additionalProperties: false,
    },
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: (input: { conversationId?: number; status?: string }) => {
      const asks = runtime.asks.listAsks(input.status)
      if (input.conversationId !== undefined) {
        return asks.filter((ask) => ask.conversationId === input.conversationId)
      }
      return asks
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'cancel',
    description: 'Cancel a pending AskDoc approval request',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['asks', 'cancel'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await runtime.asks.cancelAsk(input.id)
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'answer',
    description: 'Answer a pending AskDoc approval request (human HTTP/CLI only; blocked in all conversation contexts)',
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['asks', 'answer'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.askAnswer, { id: ID_STRING }, ['id']),
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string; answers: Record<string, string>; expectedStateSeq?: number }) => {
      await runtime.asks.answerAsk(input.id, { ...input.answers }, input.expectedStateSeq)
      return { ok: true }
    },
  })
}

// ---------------------------------------------------------------------------
// core:skills
// ---------------------------------------------------------------------------

function registerSkillCoreActions(runtime: KernelRuntime, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:skills'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List installed skills (human HTTP/CLI only; agents use load_skill instead)',
    idempotent: true,
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['skills', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.skills.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'read',
    description: 'Read a skill SKILL.md or relative reference file (human HTTP/CLI only; agents use load_skill instead)',
    idempotent: true,
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { hidden: true, command: ['skills', 'read'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_STRING,
        path: NON_EMPTY_STRING,
      },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: async (input: { id: string; path?: string }) => {
      if (input.path !== undefined && !isSafeRelativePath(input.path)) {
        throw new HelmxError('path_traversal', `skill file path out of bounds: ${input.id}/${input.path}`, 400)
      }
      const text = await runtime.skills.readFile(input.id, input.path)
      return { text }
    },
  })
}
