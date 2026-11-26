/**
 * `core:conversations`: conversation search / read / create and the seven guarded mutations.
 * Ownership and self-mutation invariants are summarized in `./index.ts`.
 */
import { REQUEST_SCHEMAS, type ConversationOwnership, type ConversationStatus } from '@helmx/protocol'
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
} from '../guards/index.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
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

export function registerConversationCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:conversations'

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

  pluginHost.registerCoreAction(owner, {
    id: 'update',
    description: 'Partially update conversation metadata, profile, model, thinking level, node, or cwd',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'update'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationPatch,
      {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (
      input: Record<string, unknown> & { conversationId: number; expectedStateSeq?: number },
      context,
    ) => {
      const { conversationId, expectedStateSeq, ...rest } = input
      const access = resolveConversationMutationAccess(runtime, context, conversationId, {
        expectedStateSeq,
      })
      const patch = parseConversationPatch(rest)
      return access.guarded
        ? runtime.conversations.updateConversationGuarded(conversationId, patch, access.guard)
        : runtime.conversations.updateConversation(conversationId, patch)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'send',
    description: 'Submit input to a conversation (optionally waiting for the reply); forces origin="agent" in session context and uses guarded CAS submission for automated callers',
    exposeToPrompt: false,
    cli: { command: ['send'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationInput,
      {
        conversationId: SAFE_POSITIVE_INT,
        wait: { type: 'boolean' },
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      ['conversationId'],
    ),
    outputSchema: {
      type: 'object',
      properties: { submissionId: { type: 'string' } },
      required: ['submissionId'],
    },
    handler: async (
      input: Record<string, unknown> & {
        conversationId: number
        wait?: boolean
        expectedStateSeq?: number
      },
      context,
    ) => {
      const { conversationId, wait, expectedStateSeq, ...rest } = input
      const access = resolveConversationMutationAccess(runtime, context, conversationId, {
        expectedStateSeq,
      })
      const parsed = parseInputBody(rest)
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

  pluginHost.registerCoreAction(owner, {
    id: 'withdraw',
    description: 'Withdraw a queued input submission from a conversation',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'withdraw'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationWithdraw,
      {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (
      input: { conversationId: number; submissionId: number; expectedStateSeq?: number },
      context,
    ) => {
      const access = resolveConversationMutationAccess(runtime, context, input.conversationId, {
        expectedStateSeq: input.expectedStateSeq,
      })
      return access.guarded
        ? runtime.conversations.withdrawQueuedInputGuarded(
            input.conversationId,
            { submissionId: input.submissionId },
            access.guard,
          )
        : runtime.conversations.withdrawQueuedInput(input.conversationId, {
            submissionId: input.submissionId,
          })
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'abort',
    description: 'Abort the currently running turn of another conversation (self-abort forbidden; uses guarded CAS abort for automated callers)',
    exposeToPrompt: false,
    cli: { command: ['abort'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; expectedStateSeq?: number }, context) => {
      assertNotSelfConversationMutation(context, input.conversationId, 'abort')
      const access = resolveConversationMutationAccess(runtime, context, input.conversationId, {
        expectedStateSeq: input.expectedStateSeq,
      })
      if (access.guarded) {
        await runtime.conversations.abortConversationGuarded(input.conversationId, access.guard)
      } else {
        await runtime.conversations.abortConversation(input.conversationId)
      }
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'reset',
    description: 'Reset context of another conversation with optional handoff text (self-reset forbidden)',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'reset'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationReset,
      {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (
      input: Record<string, unknown> & { conversationId: number; expectedStateSeq?: number },
      context,
    ) => {
      assertNotSelfConversationMutation(context, input.conversationId, 'reset')
      const { conversationId, expectedStateSeq, ...rest } = input
      const access = resolveConversationMutationAccess(runtime, context, conversationId, {
        expectedStateSeq,
      })
      const parsed = parseConversationResetBody(rest)
      return access.guarded
        ? runtime.conversations.resetConversationGuarded(conversationId, parsed, access.guard)
        : runtime.conversations.resetConversation(conversationId, parsed)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'compact',
    description: 'Enqueue manual context compaction for a conversation with optional instructions',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'compact'] },
    inputSchema: extendRequestSchema(
      REQUEST_SCHEMAS.conversationCompact,
      {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      ['conversationId'],
    ),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (
      input: Record<string, unknown> & { conversationId: number; expectedStateSeq?: number },
      context,
    ) => {
      const { conversationId, expectedStateSeq, ...rest } = input
      const access = resolveConversationMutationAccess(runtime, context, conversationId, {
        expectedStateSeq,
      })
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

  pluginHost.registerCoreAction(owner, {
    id: 'delete',
    description: 'Delete another conversation and its derived child subtree (self-delete forbidden)',
    exposeToPrompt: false,
    cli: { command: ['conversations', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        expectedStateSeq: SAFE_NON_NEGATIVE_INT,
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { conversationId: number; expectedStateSeq?: number }, context) => {
      assertNotSelfConversationMutation(context, input.conversationId, 'delete')
      const access = resolveConversationMutationAccess(runtime, context, input.conversationId, {
        checkSubtree: true,
        expectedStateSeq: input.expectedStateSeq,
      })
      if (access.guarded) {
        await runtime.conversations.deleteConversationGuarded(input.conversationId, access.guard)
      } else {
        await runtime.conversations.deleteConversation(input.conversationId)
      }
      return { ok: true }
    },
  })
}
