/**
 * Declarative Core Operation specifications for the `conversations` (incl. `search` and `artifacts_list`) domain.
 * Drives HTTP (`/api/conversations*`, `/api/search`), `core:conversations.*` actions, and static CLI commands.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_OBJECT_OUTPUT_SCHEMA,
  CORE_OK_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  extendCoreObjectSchema,
  type CoreOperationSpec,
} from './types.js'
import type { JsonSchema } from '../plugin-contract-types.js'

const MAX_SAFE_INTEGER = 9007199254740991
const SAFE_POSITIVE_INT: JsonSchema = { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER }
const SAFE_NON_NEGATIVE_INT: JsonSchema = { type: 'integer', minimum: 0, maximum: MAX_SAFE_INTEGER }
const OWNERSHIP_SCHEMA: JsonSchema = { type: 'string', enum: ['human', 'helmx'] }
const NON_EMPTY_STRING: JsonSchema = { type: 'string', minLength: 1 }

/**
 * Compose an action-only mutation request schema: required `conversationId`, optional action controls,
 * optional CAS `expectedStateSeq`, then the optional domain body (preserving exact property order).
 */
function conversationMutationActionInputSchema(
  body: unknown = CORE_EMPTY_INPUT_SCHEMA,
  controls: Record<string, JsonSchema> = {},
): JsonSchema {
  return extendCoreObjectSchema(
    body,
    { conversationId: SAFE_POSITIVE_INT, ...controls, expectedStateSeq: SAFE_NON_NEGATIVE_INT },
    ['conversationId'],
  )
}

export const CONVERSATION_CORE_OPERATIONS = [
  // Note: the first 13 actionable entries preserve the exact `core:conversations` manifest registration order.
  {
    key: 'conversations.search',
    domain: 'conversations',
    id: 'search',
    description: 'Full-text FTS5 search across conversation titles and message bodies',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationSearchQuery),
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/search',
      queryParams: ['q', 'limit', 'maxPerConversation', 'profileId', 'ownedBy', 'topLevelOnly'],
      bodyMode: 'none',
    },
    cli: {
      command: ['search'],
      positional: [{ field: 'q', required: true, label: 'query' }],
      flagAliases: { profileId: 'profile', topLevelOnly: 'top-level' },
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'conversations.list',
    domain: 'conversations',
    id: 'list',
    description:
      'List conversations with optional filters (defaults to top-level human conversations unless all/parentConversationId/tag/ownedBy/topLevelOnly=false is specified)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationListQuery),
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/conversations',
      queryParams: {
        profileId: 'profileId',
        status: 'status',
        tag: 'tag',
        ownedBy: 'ownedBy',
        parent: 'parentConversationId',
        topLevelOnly: 'topLevelOnly',
        all: 'all',
      },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'list'],
      flagAliases: { profileId: 'profile', parentConversationId: 'parent', topLevelOnly: 'top-level' },
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'conversations.get',
    domain: 'conversations',
    id: 'get',
    description:
      'Get conversation summary and paginated timeline entries (limit 1..500 or turn-aligned turns 1..50, mutually exclusive; use nextCursor for older pages)',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        turns: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: NON_EMPTY_STRING,
      },
      required: ['conversationId'],
      additionalProperties: false,
      not: { type: 'object', required: ['limit', 'turns'] },
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/conversations/:id',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      queryParams: ['limit', 'turns', 'cursor'],
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'get'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'conversations.entry',
    domain: 'conversations',
    id: 'entry',
    description: 'Read a single untruncated timeline entry from a conversation',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        entryId: SAFE_POSITIVE_INT,
      },
      required: ['conversationId', 'entryId'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/conversations/:id/entries/:entryId',
      pathParams: { id: 'conversationId', entryId: 'entryId' },
      pathValidators: { id: 'positiveInt', entryId: 'positiveInt' },
      bodyMode: 'none',
    },
    cli: {
      command: ['conversations', 'entry'],
      positional: [
        { field: 'conversationId', required: false, label: 'id' },
        { field: 'entryId', required: true, label: 'entryId' },
      ],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'conversations.create',
    domain: 'conversations',
    id: 'create',
    description:
      'Create a new conversation (automated helmx sessions default to ownedBy="helmx" and cannot create human-owned conversations)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationInit),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations',
      status: 201,
      bodyMode: 'required',
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'create'],
      flagAliases: { nodeId: 'node' },
    },
    action: {
      exposeToPrompt: false,
      inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.conversationInit, {
        ownedBy: OWNERSHIP_SCHEMA,
      }),
    },
  },
  {
    key: 'conversations.update',
    domain: 'conversations',
    id: 'update',
    description: 'Partially update conversation metadata, profile, model, thinking level, node, or cwd',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationPatch,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'PATCH',
      path: '/api/conversations/:id',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationPatch),
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'update'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
      flagAliases: { nodeId: 'node', thinkingLevel: 'thinking' },
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(REQUEST_SCHEMAS.conversationPatch),
    },
  },
  {
    key: 'conversations.send',
    domain: 'conversations',
    id: 'send',
    description:
      'Submit input to a conversation (optionally waiting for the reply); forces origin="agent" in session context and uses guarded CAS submission for automated callers',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationInput,
      { conversationId: SAFE_POSITIVE_INT, wait: { type: 'boolean' } },
      ['conversationId'],
    ),
    outputSchema: {
      type: 'object',
      properties: { submissionId: { type: 'string' } },
      required: ['submissionId'],
    },
    http: {
      method: 'POST',
      path: '/api/conversations/:id/input',
      status: 202,
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      queryParams: ['wait'],
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationInput),
    },
    cli: {
      command: ['send'],
      positional: [
        { field: 'conversationId', required: false, label: 'id' },
        { field: 'text', required: true, label: 'text' },
      ],
      flagAliases: { attachments: 'attach', replaceFromEntryId: 'replace-from', thinkingLevel: 'thinking' },
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(REQUEST_SCHEMAS.conversationInput, {
        wait: { type: 'boolean' },
      }),
    },
  },
  {
    key: 'conversations.withdraw',
    domain: 'conversations',
    id: 'withdraw',
    description: 'Withdraw a queued input submission from a conversation',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationWithdraw,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/:id/withdraw',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationWithdraw),
    },
    cli: {
      command: ['conversations', 'withdraw'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(REQUEST_SCHEMAS.conversationWithdraw),
    },
  },
  {
    key: 'conversations.abort',
    domain: 'conversations',
    id: 'abort',
    description:
      'Abort the currently running turn of another conversation (self-abort forbidden; uses guarded CAS abort for automated callers)',
    inputSchema: {
      type: 'object',
      properties: { conversationId: SAFE_POSITIVE_INT },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/:id/abort',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'none',
    },
    cli: {
      command: ['abort'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(),
    },
  },
  {
    key: 'conversations.reset',
    domain: 'conversations',
    id: 'reset',
    description: 'Reset context of another conversation with optional handoff text (self-reset forbidden)',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationReset,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/:id/reset',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'optional',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationReset),
    },
    cli: {
      command: ['conversations', 'reset'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(REQUEST_SCHEMAS.conversationReset),
    },
  },
  {
    key: 'conversations.compact',
    domain: 'conversations',
    id: 'compact',
    description: 'Enqueue manual context compaction for a conversation with optional instructions',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationCompact,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/:id/compact',
      status: 202,
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'optional',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationCompact),
    },
    cli: {
      command: ['conversations', 'compact'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(REQUEST_SCHEMAS.conversationCompact),
    },
  },
  {
    key: 'conversations.fork',
    domain: 'conversations',
    id: 'fork',
    description:
      'Fork a new conversation from a specified entry or latest clean anchor (inherits source ownership; automated helmx sessions always produce helmx-owned forks)',
    inputSchema: extendCoreObjectSchema(
      REQUEST_SCHEMAS.conversationFork,
      { conversationId: SAFE_POSITIVE_INT },
      ['conversationId'],
    ),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/:id/fork',
      status: 201,
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'optional',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationFork),
    },
    cli: {
      command: ['conversations', 'fork'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: {
      exposeToPrompt: false,
      inputSchema: extendCoreObjectSchema(
        REQUEST_SCHEMAS.conversationFork,
        { conversationId: SAFE_POSITIVE_INT, ownedBy: OWNERSHIP_SCHEMA },
        ['conversationId'],
      ),
    },
  },
  {
    key: 'conversations.delete',
    domain: 'conversations',
    id: 'delete',
    description: 'Delete another conversation and its derived child subtree (self-delete forbidden)',
    inputSchema: {
      type: 'object',
      properties: { conversationId: SAFE_POSITIVE_INT },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'DELETE',
      path: '/api/conversations/:id',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'delete'],
      sharedCommand: true,
    },
    action: {
      exposeToPrompt: false,
      inputSchema: conversationMutationActionInputSchema(),
    },
  },
  {
    key: 'conversations.bulk_delete',
    domain: 'conversations',
    id: 'bulk_delete',
    description:
      'Delete one or more conversations (POST /api/conversations/bulk-delete; cascades derived child conversations; plugin-managed conversations are protected and reported per item)',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.conversationBulkDelete),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/conversations/bulk-delete',
      bodyMode: 'required',
      methodNotAllowed: true,
    },
    cli: {
      command: ['conversations', 'delete'],
      positional: [{ field: 'ids', required: false, label: 'id...' }],
      sharedCommand: true,
    },
    action: false,
  },
  {
    key: 'conversations.artifacts_list',
    domain: 'conversations',
    id: 'artifacts_list',
    description: 'List conversation artifacts (GET /api/conversations/:id/artifacts)',
    inputSchema: {
      type: 'object',
      properties: { conversationId: SAFE_POSITIVE_INT },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/conversations/:id/artifacts',
      pathParams: { id: 'conversationId' },
      pathValidators: { id: 'positiveInt' },
      bodyMode: 'none',
    },
    cli: {
      command: ['artifacts', 'list'],
      positional: [{ field: 'conversationId', required: false, label: 'id' }],
    },
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export type ConversationCoreOperation = (typeof CONVERSATION_CORE_OPERATIONS)[number]
export type ConversationCoreOperationKey = ConversationCoreOperation['key']
