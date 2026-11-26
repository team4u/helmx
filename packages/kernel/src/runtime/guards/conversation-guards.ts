/**
 * Conversation domain guards and query normalizers:
 *
 * Single source of truth shared by HTTP routes (`http/conversation-routes.ts`),
 * kernel `ConversationService` (`runtime/conversation-service.ts`), and `core:conversations.*`
 * actions (`runtime/core-actions.ts`):
 * - Watchdog Ownership Red Line (`AGENTS.md` §3): refuses `helmx`-owned sessions from mutating
 *   `human`-owned conversations (or cascading across `human`-owned descendants) and binds every
 *   automated mutation to kernel guarded APIs (`expectedOwnership: 'helmx'` + optional CAS watermark);
 * - Self-mutation guard: forbids a conversation from invoking destructive `abort`/`reset`/`delete`
 *   on itself (`409 self_mutation_forbidden`);
 * - Create/fork ownership guard: ensures automated (`helmx`-owned) callers never create or fork
 *   `human`-owned conversations (defaulting to `'helmx'` and rejecting explicit `'human'`);
 * - Search query/option validation and list filter normalization shared across HTTP and core actions.
 */
import {
  HelmxError,
  type ConversationListFilter,
  type ConversationOwnership,
  type ConversationSearchOptions,
  type ConversationStatus,
  type ConversationSummary,
  type GuardedMutationExpectation,
  type PluginActionContext,
} from '@helmx/protocol'
import { parseSearchTerms, validateSearchOptions } from '../fts-search.js'

const VALID_CONVERSATION_STATUSES = new Set<string>(['working', 'blocked', 'done', 'idle', 'error'])

export interface ConversationGuardDeps {
  readonly ownership: { getOwnership(conversationId: number): ConversationOwnership }
  readonly conversations: {
    listConversations(filter?: ConversationListFilter): ConversationSummary[]
    getConversation(conversationId: number): ConversationSummary
  }
}

export type ConversationMutationAccess =
  | { readonly guarded: false }
  | { readonly guarded: true; readonly guard: GuardedMutationExpectation }

export interface ConversationListQueryInput {
  readonly profileId?: string
  readonly status?: string
  readonly tag?: string
  readonly ownedBy?: string
  readonly parentConversationId?: number
  readonly topLevelOnly?: boolean
  readonly all?: boolean
}

/** Assert valid `'human' | 'helmx'` ownership value when explicitly provided. */
export function assertValidConversationOwnership(
  ownedBy: unknown,
  field = 'ownedBy',
): ConversationOwnership {
  if (ownedBy !== 'human' && ownedBy !== 'helmx') {
    throw new HelmxError(
      'validation_error',
      `invalid conversation ownership (${field}): expected 'human' | 'helmx', got ${String(ownedBy)}`,
      400,
      { field, ownedBy },
    )
  }
  return ownedBy
}

/** Forbid a session from invoking destructive `abort`/`reset`/`delete` on itself (`409 self_mutation_forbidden`). */
export function assertNotSelfConversationMutation(
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

/** Validate optional `expectedStateSeq` CAS watermark shape at boundary (`400 validation_error`). */
function assertOptionalExpectedStateSeq(expectedStateSeq: number | undefined): void {
  if (
    expectedStateSeq !== undefined &&
    (!Number.isSafeInteger(expectedStateSeq) || expectedStateSeq < 0)
  ) {
    throw new HelmxError(
      'validation_error',
      `expectedStateSeq must be a non-negative safe integer: got ${String(expectedStateSeq)}`,
      400,
      { expectedStateSeq },
    )
  }
}

/** Verify CAS watermark for direct / human-session callers when they explicitly opt into `expectedStateSeq`. */
function assertDirectExpectedStateSeq(
  deps: Pick<ConversationGuardDeps, 'conversations'>,
  targetConversationId: number,
  expectedStateSeq: number | undefined,
): void {
  if (expectedStateSeq === undefined) return
  const current = deps.conversations.getConversation(targetConversationId)
  if (current.stateChangeSeq !== expectedStateSeq) {
    throw new HelmxError(
      'state_seq_conflict',
      `conversation ${targetConversationId} authoritative watermark ${current.stateChangeSeq} does not match expected ${expectedStateSeq}`,
      409,
      {
        conversationId: targetConversationId,
        currentSeq: current.stateChangeSeq,
        expectedSeq: expectedStateSeq,
      },
    )
  }
}

/**
 * Authorize a conversation mutation and determine whether it must execute through the kernel's
 * atomic guarded mutation pipeline:
 * - Direct HTTP/CLI (`context.conversationId === undefined`) or `human`-owned session callers:
 *   honors optional `expectedStateSeq` and returns `{ guarded: false }`;
 * - `helmx`-owned (automated) session callers:
 *   1. Enforces Watchdog Ownership Red Line up-front (`403 ownership_violation`) on the target
 *      (and all derived descendants when `checkSubtree: true`);
 *   2. Returns `{ guarded: true, guard: { expectedOwnership: 'helmx', expectedStateSeq? } }` so the
 *      caller MUST execute through the corresponding `*Guarded` API, closing any mid-await TOCTOU
 *      human-ownership takeover race atomically inside `withMutationGate`.
 */
export function resolveConversationMutationAccess(
  deps: ConversationGuardDeps,
  context: PluginActionContext,
  targetConversationId: number,
  options?: { checkSubtree?: boolean; expectedStateSeq?: number },
): ConversationMutationAccess {
  assertOptionalExpectedStateSeq(options?.expectedStateSeq)
  if (context.conversationId === undefined) {
    assertDirectExpectedStateSeq(deps, targetConversationId, options?.expectedStateSeq)
    return { guarded: false }
  }
  const callerOwnedBy = deps.ownership.getOwnership(context.conversationId)
  if (callerOwnedBy !== 'helmx') {
    assertDirectExpectedStateSeq(deps, targetConversationId, options?.expectedStateSeq)
    return { guarded: false }
  }

  const targetOwnedBy = deps.ownership.getOwnership(targetConversationId)
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

  if (options?.checkSubtree === true) {
    const childrenOf = new Map<number, number[]>()
    for (const conv of deps.conversations.listConversations()) {
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
      const childOwnedBy = deps.ownership.getOwnership(childId)
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

  return {
    guarded: true,
    guard: {
      expectedOwnership: 'helmx',
      ...(options?.expectedStateSeq !== undefined ? { expectedStateSeq: options.expectedStateSeq } : {}),
    },
  }
}

/**
 * Resolve ownership for conversation creation/forking invoked from an action context:
 * - Automated (`helmx`-owned) callers cannot create or fork `human`-owned conversations
 *   (`403 ownership_violation` on explicit `'human'`), and default to `'helmx'` when omitted
 *   (never silently defaulting to `'human'`);
 * - Direct HTTP/CLI and `human`-owned session callers honor explicit `ownedBy`, or return
 *   `undefined` so `createConversation`/`forkConversation` inherit parent/source ownership.
 */
function resolveDerivedConversationOwnership(
  deps: Pick<ConversationGuardDeps, 'ownership'>,
  context: PluginActionContext,
  explicitOwnedBy: ConversationOwnership | undefined,
  operation: 'create' | 'fork',
): ConversationOwnership | undefined {
  const validated =
    explicitOwnedBy !== undefined ? assertValidConversationOwnership(explicitOwnedBy) : undefined
  if (context.conversationId === undefined) return validated
  const callerOwnedBy = deps.ownership.getOwnership(context.conversationId)
  if (callerOwnedBy !== 'helmx') return validated
  if (validated === 'human') {
    throw new HelmxError(
      'ownership_violation',
      `helmx-owned conversation ${context.conversationId} cannot ${operation} a human-owned conversation`,
      403,
      {
        callerConversationId: context.conversationId,
        callerOwnedBy,
        requestedOwnedBy: 'human',
        operation,
      },
    )
  }
  return 'helmx'
}

export function resolveCreateConversationOwnership(
  deps: Pick<ConversationGuardDeps, 'ownership'>,
  context: PluginActionContext,
  explicitOwnedBy?: ConversationOwnership,
): ConversationOwnership | undefined {
  return resolveDerivedConversationOwnership(deps, context, explicitOwnedBy, 'create')
}

export function resolveForkConversationOwnership(
  deps: Pick<ConversationGuardDeps, 'ownership'>,
  context: PluginActionContext,
  explicitOwnedBy?: ConversationOwnership,
): ConversationOwnership | undefined {
  return resolveDerivedConversationOwnership(deps, context, explicitOwnedBy, 'fork')
}

/**
 * Single-source boundary validation for conversation full-text search (shared across HTTP
 * `GET /api/search`, `core:conversations.search`, and `ConversationService.search`).
 */
export function normalizeConversationSearchInput(
  query: unknown,
  options?: ConversationSearchOptions,
): { query: string; options: ConversationSearchOptions | undefined } {
  if (typeof query !== 'string') {
    throw new HelmxError('validation_error', 'search query must be a string', 400)
  }
  if (query.trim().length === 0 || parseSearchTerms(query).terms.length === 0) {
    throw new HelmxError('validation_error', 'q cannot be empty', 400)
  }
  const validated = validateSearchOptions(options)
  if (validated === undefined) {
    return { query, options: undefined }
  }
  const normalized: ConversationSearchOptions = {
    ...(validated.profileId !== undefined ? { profileId: validated.profileId } : {}),
    ...(validated.ownedBy !== undefined ? { ownedBy: validated.ownedBy } : {}),
    ...(validated.topLevelOnly !== undefined ? { topLevelOnly: validated.topLevelOnly } : {}),
    ...(validated.limit !== undefined ? { limit: validated.limit } : {}),
    ...(validated.maxPerConversation !== undefined
      ? { maxPerConversation: validated.maxPerConversation }
      : {}),
  }
  return {
    query,
    options: Object.keys(normalized).length > 0 ? normalized : undefined,
  }
}

/**
 * Single-source conversation list filter normalization (shared across HTTP `GET /api/conversations`
 * and `core:conversations.list`): enforces mutually exclusive query flags and low-noise defaults
 * (top-level `human` conversations unless `parentConversationId`, `all`, `tag`, `ownedBy`, or
 * `topLevelOnly=false` is explicitly provided).
 */
export function normalizeConversationListFilter(
  input: ConversationListQueryInput,
): ConversationListFilter {
  if (input.status !== undefined && !VALID_CONVERSATION_STATUSES.has(input.status)) {
    throw new HelmxError('validation_error', 'status must be working|blocked|done|idle|error', 400)
  }
  if (input.ownedBy !== undefined && input.ownedBy !== 'human' && input.ownedBy !== 'helmx') {
    throw new HelmxError('validation_error', 'ownedBy must be human|helmx', 400)
  }
  if (
    input.parentConversationId !== undefined &&
    (!Number.isSafeInteger(input.parentConversationId) || input.parentConversationId < 1)
  ) {
    throw new HelmxError('validation_error', 'parent must be a positive integer conversation ID', 400)
  }
  if (input.all === true && input.parentConversationId !== undefined) {
    throw new HelmxError(
      'validation_error',
      'all and parentConversationId are mutually exclusive: cannot specify both full listing and parent conversation filter',
      400,
    )
  }
  if (input.topLevelOnly === true && input.parentConversationId !== undefined) {
    throw new HelmxError('validation_error', 'topLevelOnly and parentConversationId are mutually exclusive', 400)
  }
  if (input.topLevelOnly === true && input.all === true) {
    throw new HelmxError('validation_error', 'topLevelOnly and all are mutually exclusive', 400)
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

  return {
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.status !== undefined ? { status: input.status as ConversationStatus } : {}),
    ...(effectiveOwnedBy !== undefined ? { ownedBy: effectiveOwnedBy } : {}),
    ...(input.parentConversationId !== undefined
      ? { parentConversationId: input.parentConversationId }
      : {}),
    ...(effectiveTopLevelOnly === true ? { topLevelOnly: true } : {}),
  }
}
