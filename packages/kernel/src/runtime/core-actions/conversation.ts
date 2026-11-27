/**
 * `core:conversations`: conversation search / read / create and the seven guarded mutations.
 * Ownership and self-mutation invariants are summarized in `./index.ts`.
 */
import {
  REQUEST_SCHEMAS,
  type ConversationOwnership,
  type ConversationStatus,
  type JsonSchema,
  type MaybePromise,
  type PluginActionCliSpec,
  type PluginActionContext,
} from '@helmx/protocol'
import {
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseInputBody,
} from '../../http/validate.js'
import {
  assertNotSelfConversationMutation,
  normalizeConversationListFilter,
  resolveConversationMutationAccess,
  resolveCreateConversationOwnership,
  resolveForkConversationOwnership,
  type ConversationMutationAccess,
} from '../guards/index.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  EMPTY_INPUT_SCHEMA,
  NON_EMPTY_STRING,
  OBJECT_OUTPUT_SCHEMA,
  OK_OUTPUT_SCHEMA,
  OWNERSHIP_SCHEMA,
  SAFE_NON_NEGATIVE_INT,
  SAFE_POSITIVE_INT,
  extendRequestSchema,
  toJsonSchema,
  type CoreActionRegistrar,
} from './shared.js'

const CONVERSATION_ACTIONS_OWNER = 'core:conversations'

/**
 * Compose a mutation request schema: the required target id, the action's own control fields, the optional CAS
 * watermark, then the optional domain body.
 */
function conversationMutationInputSchema(
  body: unknown = EMPTY_INPUT_SCHEMA,
  controls: Record<string, JsonSchema> = {},
): JsonSchema {
  return extendRequestSchema(
    body,
    { conversationId: SAFE_POSITIVE_INT, ...controls, expectedStateSeq: SAFE_NON_NEGATIVE_INT },
    ['conversationId'],
  )
}

/** Request target shared by every conversation mutation: the conversation plus its optional CAS watermark. */
interface ConversationMutationInput {
  conversationId: number
  expectedStateSeq?: number
}

/** `send` may additionally wait for the reply (the input body itself is parsed by `parseInputBody`). */
interface SendMutationInput extends ConversationMutationInput {
  wait?: boolean
}

/** `withdraw` additionally addresses the queued submission. */
interface WithdrawMutationInput extends ConversationMutationInput {
  submissionId: number
}

/**
 * Register one conversation mutation. Every mutation targets a required `conversationId` with an optional
 * `expectedStateSeq` CAS watermark, stays out of the prompt (`run_action` discovery only), and resolves mutation
 * access before the domain body runs: destructive actions first refuse self-mutation, then
 * `resolveConversationMutationAccess` enforces the ownership red line and decides guarded-vs-direct execution.
 */
function registerConversationMutation<TIn extends ConversationMutationInput = ConversationMutationInput>(
  runtime: CoreActionsRuntimeHost,
  pluginHost: CoreActionRegistrar,
  spec: {
    id: string
    description: string
    cli: PluginActionCliSpec
    inputSchema: JsonSchema
    /** Defaults to `OBJECT_OUTPUT_SCHEMA`. */
    outputSchema?: JsonSchema
    /** Destructive actions refuse self-mutation (`409 self_mutation_forbidden`) before access resolution. */
    forbidSelfMutation?: boolean
    /** `delete` also refuses cascading across `human`-owned descendants. */
    checkSubtree?: boolean
    /** `rest` is the request without the target fields; `context` is the caller's action context. */
    mutate: (
      target: {
        conversationId: number
        rest: Omit<TIn, keyof ConversationMutationInput>
        context: PluginActionContext
      },
      access: ConversationMutationAccess,
    ) => MaybePromise<unknown>
  },
): void {
  pluginHost.registerCoreAction<TIn, unknown>(CONVERSATION_ACTIONS_OWNER, {
    id: spec.id,
    description: spec.description,
    exposeToPrompt: false,
    cli: spec.cli,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema ?? OBJECT_OUTPUT_SCHEMA,
    handler: async (input, context) => {
      if (spec.forbidSelfMutation === true) {
        assertNotSelfConversationMutation(context, input.conversationId, spec.id)
      }
      const { conversationId, expectedStateSeq, ...rest } = input
      const access = resolveConversationMutationAccess(runtime, context, conversationId, {
        expectedStateSeq,
        ...(spec.checkSubtree === true ? { checkSubtree: true } : {}),
      })
      return spec.mutate({ conversationId, rest, context }, access)
    },
  })
}

export function registerConversationCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = CONVERSATION_ACTIONS_OWNER

  pluginHost.registerCoreAction(owner, {
    id: 'search',
    description: 'Full-text FTS5 search across conversation titles and message bodies',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['search'] },
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
    cli: { command: ['conversations', 'list'] },
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
    }) => runtime.conversations.listConversations(normalizeConversationListFilter(input)),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'get',
    description:
      'Get conversation summary and paginated timeline entries (limit 1..500 or turn-aligned turns 1..50, mutually exclusive; use nextCursor for older pages)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['conversations', 'get'] },
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
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; limit?: number; turns?: number; cursor?: string }) =>
      runtime.conversations.getConversationDetail(input.conversationId, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.turns !== undefined ? { turns: input.turns } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      }),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'entry',
    description: 'Read a single untruncated timeline entry from a conversation',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['conversations', 'entry'] },
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
    description:
      'Create a new conversation (automated helmx sessions default to ownedBy="helmx" and cannot create human-owned conversations)',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'create'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.conversationInit, {
      ownedBy: OWNERSHIP_SCHEMA,
    }),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { ownedBy?: ConversationOwnership }, context) => {
      const { ownedBy, ...rest } = input
      const effectiveOwnedBy = resolveCreateConversationOwnership(runtime, context, ownedBy)
      const parsed = parseConversationInit(rest)
      return runtime.conversations.createConversation({
        ...parsed,
        ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
      })
    },
  })

  registerConversationMutation(runtime, pluginHost, {
    id: 'update',
    description: 'Partially update conversation metadata, profile, model, thinking level, node, or cwd',
    cli: { command: ['conversations', 'update'] },
    inputSchema: conversationMutationInputSchema(REQUEST_SCHEMAS.conversationPatch),
    mutate: ({ conversationId, rest }, access) => {
      const patch = parseConversationPatch(rest)
      return access.guarded
        ? runtime.conversations.updateConversationGuarded(conversationId, patch, access.guard)
        : runtime.conversations.updateConversation(conversationId, patch)
    },
  })

  registerConversationMutation<SendMutationInput>(runtime, pluginHost, {
    id: 'send',
    description: 'Submit input to a conversation (optionally waiting for the reply); forces origin="agent" in session context and uses guarded CAS submission for automated callers',
    cli: { command: ['send'] },
    inputSchema: conversationMutationInputSchema(REQUEST_SCHEMAS.conversationInput, {
      wait: { type: 'boolean' },
    }),
    outputSchema: {
      type: 'object',
      properties: { submissionId: { type: 'string' } },
      required: ['submissionId'],
    },
    mutate: async ({ conversationId, rest, context }, access) => {
      const { wait, ...body } = rest
      const parsed = parseInputBody(body)
      // Honest origin invariant: any session-scoped send is agent-originated and cannot spoof human/trigger.
      const effectiveOrigin = context.conversationId !== undefined ? 'agent' : parsed.origin
      const submitOpts = {
        ...(effectiveOrigin !== undefined ? { origin: effectiveOrigin } : {}),
        ...(parsed.whenBusy !== undefined ? { whenBusy: parsed.whenBusy } : {}),
        ...(parsed.whenPendingAsk !== undefined ? { whenPendingAsk: parsed.whenPendingAsk } : {}),
        ...(parsed.meta !== undefined ? { meta: parsed.meta } : {}),
        ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
        ...(parsed.replaceFromEntryId !== undefined ? { replaceFromEntryId: parsed.replaceFromEntryId } : {}),
      }
      const { submissionId } = access.guarded
        ? await runtime.conversations.submitInputGuarded(conversationId, parsed.text, submitOpts, access.guard)
        : await runtime.conversations.submitInput(conversationId, parsed.text, submitOpts)
      if (wait === true) {
        return runtime.conversations.waitForInput(conversationId, submissionId, context.signal)
      }
      return { submissionId }
    },
  })

  registerConversationMutation<WithdrawMutationInput>(runtime, pluginHost, {
    id: 'withdraw',
    description: 'Withdraw a queued input submission from a conversation',
    cli: { command: ['conversations', 'withdraw'] },
    inputSchema: conversationMutationInputSchema(REQUEST_SCHEMAS.conversationWithdraw),
    mutate: ({ conversationId, rest }, access) =>
      access.guarded
        ? runtime.conversations.withdrawQueuedInputGuarded(
            conversationId,
            { submissionId: rest.submissionId },
            access.guard,
          )
        : runtime.conversations.withdrawQueuedInput(conversationId, {
            submissionId: rest.submissionId,
          }),
  })

  registerConversationMutation(runtime, pluginHost, {
    id: 'abort',
    description: 'Abort the currently running turn of another conversation (self-abort forbidden; uses guarded CAS abort for automated callers)',
    cli: { command: ['abort'] },
    inputSchema: conversationMutationInputSchema(),
    outputSchema: OK_OUTPUT_SCHEMA,
    forbidSelfMutation: true,
    mutate: async ({ conversationId }, access) => {
      if (access.guarded) {
        await runtime.conversations.abortConversationGuarded(conversationId, access.guard)
      } else {
        await runtime.conversations.abortConversation(conversationId)
      }
      return { ok: true }
    },
  })

  registerConversationMutation(runtime, pluginHost, {
    id: 'reset',
    description: 'Reset context of another conversation with optional handoff text (self-reset forbidden)',
    cli: { command: ['conversations', 'reset'] },
    inputSchema: conversationMutationInputSchema(REQUEST_SCHEMAS.conversationReset),
    forbidSelfMutation: true,
    mutate: ({ conversationId, rest }, access) => {
      const parsed = parseConversationResetBody(rest)
      return access.guarded
        ? runtime.conversations.resetConversationGuarded(conversationId, parsed, access.guard)
        : runtime.conversations.resetConversation(conversationId, parsed)
    },
  })

  registerConversationMutation(runtime, pluginHost, {
    id: 'compact',
    description: 'Enqueue manual context compaction for a conversation with optional instructions',
    cli: { command: ['conversations', 'compact'] },
    inputSchema: conversationMutationInputSchema(REQUEST_SCHEMAS.conversationCompact),
    mutate: ({ conversationId, rest }, access) => {
      const parsed = parseConversationCompactBody(rest)
      return access.guarded
        ? runtime.conversations.compactConversationGuarded(conversationId, parsed, access.guard)
        : runtime.conversations.compactConversation(conversationId, parsed)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'fork',
    description:
      'Fork a new conversation from a specified entry or latest clean anchor (inherits source ownership; automated helmx sessions always produce helmx-owned forks)',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'fork'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationFork,
      {
        conversationId: SAFE_POSITIVE_INT,
        ownedBy: OWNERSHIP_SCHEMA,
      },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (
      input: Record<string, unknown> & { conversationId: number; ownedBy?: ConversationOwnership },
      context,
    ) => {
      const { conversationId, ownedBy, ...rest } = input
      const effectiveOwnedBy = resolveForkConversationOwnership(runtime, context, ownedBy)
      const parsed = parseConversationForkBody(rest)
      return runtime.conversations.forkConversation(conversationId, {
        ...parsed,
        ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
      })
    },
  })

  registerConversationMutation(runtime, pluginHost, {
    id: 'delete',
    description: 'Delete another conversation and its derived child subtree (self-delete forbidden)',
    cli: { command: ['conversations', 'delete'] },
    inputSchema: conversationMutationInputSchema(),
    outputSchema: OK_OUTPUT_SCHEMA,
    forbidSelfMutation: true,
    checkSubtree: true,
    mutate: async ({ conversationId }, access) => {
      if (access.guarded) {
        await runtime.conversations.deleteConversationGuarded(conversationId, access.guard)
      } else {
        await runtime.conversations.deleteConversation(conversationId)
      }
      return { ok: true }
    },
  })
}
