/**
 * `core:conversations`: conversation search / read / create and the seven guarded mutations.
 * Driven by `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` via `registerCoreActionsFromOperations`.
 * Ownership and self-mutation invariants are summarized in `./index.ts`.
 */
import {
  CONVERSATION_CORE_OPERATIONS,
  type ConversationOwnership,
  type MaybePromise,
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
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

/** Execute one conversation mutation with optional self-mutation guard and atomic Watchdog access resolution. */
function runConversationMutation<TIn extends { conversationId: number; expectedStateSeq?: number }>(
  runtime: CoreActionsRuntimeHost,
  context: PluginActionContext,
  input: TIn,
  actionId: string,
  options: { forbidSelfMutation?: boolean; checkSubtree?: boolean },
  mutate: (
    target: {
      conversationId: number
      rest: Omit<TIn, 'conversationId' | 'expectedStateSeq'>
      context: PluginActionContext
    },
    access: ConversationMutationAccess,
  ) => MaybePromise<unknown>,
): MaybePromise<unknown> {
  if (options.forbidSelfMutation === true) {
    assertNotSelfConversationMutation(context, input.conversationId, actionId)
  }
  const { conversationId, expectedStateSeq, ...rest } = input
  const access = resolveConversationMutationAccess(runtime, context, conversationId, {
    expectedStateSeq,
    ...(options.checkSubtree === true ? { checkSubtree: true } : {}),
  })
  return mutate({ conversationId, rest, context }, access)
}

export function registerConversationCoreActions(
  runtime: CoreActionsRuntimeHost,
  pluginHost: CoreActionRegistrar,
): void {
  registerCoreActionsFromOperations(pluginHost, CONVERSATION_CORE_OPERATIONS, {
    'conversations.search': (input) => {
      const options = {
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        ...(input.maxPerConversation !== undefined
          ? { maxPerConversation: input.maxPerConversation as number }
          : {}),
        ...(input.profileId !== undefined ? { profileId: input.profileId as string } : {}),
        ...(input.ownedBy !== undefined ? { ownedBy: input.ownedBy as ConversationOwnership } : {}),
        ...(input.topLevelOnly !== undefined ? { topLevelOnly: input.topLevelOnly as boolean } : {}),
      }
      return runtime.conversations.search(
        input.q as string,
        Object.keys(options).length > 0 ? options : undefined,
      )
    },

    'conversations.list': (input) =>
      runtime.conversations.listConversations(normalizeConversationListFilter(input)),

    'conversations.get': (input) =>
      runtime.conversations.getConversationDetail(input.conversationId as number, {
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        ...(input.turns !== undefined ? { turns: input.turns as number } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
      }),

    'conversations.entry': (input) =>
      runtime.conversations.getConversationEntry(
        input.conversationId as number,
        input.entryId as number,
      ),

    'conversations.create': (input, context) => {
      const { ownedBy, ...rest } = input as Record<string, unknown> & { ownedBy?: ConversationOwnership }
      const effectiveOwnedBy = resolveCreateConversationOwnership(runtime, context, ownedBy)
      const parsed = parseConversationInit(rest)
      return runtime.conversations.createConversation({
        ...parsed,
        ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
      })
    },

    'conversations.update': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number } & Record<string, unknown>,
        'update',
        {},
        ({ conversationId, rest }, access) => {
          const patch = parseConversationPatch(rest)
          return access.guarded
            ? runtime.conversations.updateConversationGuarded(conversationId, patch, access.guard)
            : runtime.conversations.updateConversation(conversationId, patch)
        },
      ),

    'conversations.send': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number; wait?: boolean } & Record<string, unknown>,
        'send',
        {},
        async ({ conversationId, rest, context: ctx }, access) => {
          const { wait, ...body } = rest
          const parsed = parseInputBody(body)
          // Honest origin invariant: any session-scoped send is agent-originated and cannot spoof human/trigger.
          const effectiveOrigin = ctx.conversationId !== undefined ? 'agent' : parsed.origin
          const submitOpts = {
            ...(effectiveOrigin !== undefined ? { origin: effectiveOrigin } : {}),
            ...(parsed.whenBusy !== undefined ? { whenBusy: parsed.whenBusy } : {}),
            ...(parsed.whenPendingAsk !== undefined ? { whenPendingAsk: parsed.whenPendingAsk } : {}),
            ...(parsed.meta !== undefined ? { meta: parsed.meta } : {}),
            ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
            ...(parsed.replaceFromEntryId !== undefined
              ? { replaceFromEntryId: parsed.replaceFromEntryId }
              : {}),
            ...(parsed.model !== undefined ? { model: parsed.model } : {}),
            ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
          }
          const { submissionId } = access.guarded
            ? await runtime.conversations.submitInputGuarded(
                conversationId,
                parsed.text,
                submitOpts,
                access.guard,
              )
            : await runtime.conversations.submitInput(conversationId, parsed.text, submitOpts)
          if (wait === true) {
            return runtime.conversations.waitForInput(conversationId, submissionId, ctx.signal)
          }
          return { submissionId }
        },
      ),

    'conversations.withdraw': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number; submissionId: number },
        'withdraw',
        {},
        ({ conversationId, rest }, access) =>
          access.guarded
            ? runtime.conversations.withdrawQueuedInputGuarded(
                conversationId,
                { submissionId: rest.submissionId },
                access.guard,
              )
            : runtime.conversations.withdrawQueuedInput(conversationId, {
                submissionId: rest.submissionId,
              }),
      ),

    'conversations.abort': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number },
        'abort',
        { forbidSelfMutation: true },
        async ({ conversationId }, access) => {
          if (access.guarded) {
            await runtime.conversations.abortConversationGuarded(conversationId, access.guard)
          } else {
            await runtime.conversations.abortConversation(conversationId)
          }
          return { ok: true }
        },
      ),

    'conversations.reset': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number } & Record<string, unknown>,
        'reset',
        { forbidSelfMutation: true },
        ({ conversationId, rest }, access) => {
          const parsed = parseConversationResetBody(rest)
          return access.guarded
            ? runtime.conversations.resetConversationGuarded(conversationId, parsed, access.guard)
            : runtime.conversations.resetConversation(conversationId, parsed)
        },
      ),

    'conversations.compact': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number } & Record<string, unknown>,
        'compact',
        {},
        ({ conversationId, rest }, access) => {
          const parsed = parseConversationCompactBody(rest)
          return access.guarded
            ? runtime.conversations.compactConversationGuarded(conversationId, parsed, access.guard)
            : runtime.conversations.compactConversation(conversationId, parsed)
        },
      ),

    'conversations.fork': (input, context) => {
      const { conversationId, ownedBy, ...rest } = input as Record<string, unknown> & {
        conversationId: number
        ownedBy?: ConversationOwnership
      }
      const effectiveOwnedBy = resolveForkConversationOwnership(runtime, context, ownedBy)
      const parsed = parseConversationForkBody(rest)
      return runtime.conversations.forkConversation(conversationId, {
        ...parsed,
        ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
      })
    },

    'conversations.delete': (input, context) =>
      runConversationMutation(
        runtime,
        context,
        input as { conversationId: number; expectedStateSeq?: number },
        'delete',
        { forbidSelfMutation: true, checkSubtree: true },
        async ({ conversationId }, access) => {
          if (access.guarded) {
            await runtime.conversations.deleteConversationGuarded(conversationId, access.guard)
          } else {
            await runtime.conversations.deleteConversation(conversationId)
          }
          return { ok: true }
        },
      ),
  })
}
