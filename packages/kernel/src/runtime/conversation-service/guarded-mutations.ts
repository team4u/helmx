/**
 * Guarded-mutation primitives: the single source of truth for the automation red line re-check that runs
 * synchronously (zero awaits) right before an irreversible SDK action.
 *
 * Two call sites share it: ConversationService.assertMutationGuard (automated abort / submit / update / withdraw /
 * reset / compact — action 'mutation') and ConversationLifecycleService.deleteConversationGuarded per-target
 * re-check inside the deletion subtree walk (action 'deletion', with the requested conversation when the target is
 * a derived conversation). Diagnostics name the action; code, status and details are identical for both.
 */

import type { ConversationOwnership, GuardedMutationExpectation } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { HelmxStore } from '../store.js'

export interface GuardedMutationHost {
  readonly store: HelmxStore
  /** Current ownership lookup (authoritative; `human` is always refused for automation). */
  readonly ownershipOf: (id: number) => ConversationOwnership
}

export interface GuardedTargetOptions {
  /** Action named in the diagnostic: automated mutation (default service paths) or cascade deletion re-check. */
  readonly action: 'mutation' | 'deletion'
  /** Present when the guarded target is a derived conversation of the requested one (cascade deletion). */
  readonly requestedConversationId?: number
}

/** Boundary validation for guard payload (throws 400 synchronously): expectedOwnership strictly forbids 'human'. */
export function assertGuardShape(guard: GuardedMutationExpectation): void {
  if (typeof guard !== 'object' || guard === null) {
    throw new HelmxError('validation_error', 'guarded mutation requires a guard object', 400)
  }
  if (guard.expectedOwnership !== undefined && guard.expectedOwnership !== 'helmx') {
    throw new HelmxError(
      'validation_error',
      `expectedOwnership only allows 'helmx' (automation invariant forbids human): got ${String(guard.expectedOwnership)}`,
      400,
      { expectedOwnership: guard.expectedOwnership },
    )
  }
  if (
    guard.expectedStateSeq !== undefined &&
    (!Number.isSafeInteger(guard.expectedStateSeq) || guard.expectedStateSeq < 0)
  ) {
    throw new HelmxError(
      'validation_error',
      `expectedStateSeq must be a non-negative safe integer: got ${String(guard.expectedStateSeq)}`,
      400,
      { expectedStateSeq: guard.expectedStateSeq },
    )
  }
}

/**
 * Synchronous guard re-check (zero awaits): verifies conversation existence, ownership (always rejects 'human'),
 * and optional CAS watermark. Callers guarantee zero event-loop yields between this check and the irreversible
 * SDK abort/submit call—in single-threaded JS, markOwnership cannot interleave, closing the human-ownership race window.
 *
 * - ownership: `human` is always refused; an explicit `expectedOwnership` must match the current owner (409 ownership_conflict);
 * - `expectedStateSeq`: the conversation must exist and not be tombstoned (404 not_found) and its authoritative
 *   `stateChangeSeq` must equal the probed value (409 state_seq_conflict).
 */
export function assertGuardedMutationTarget(
  host: GuardedMutationHost,
  id: number,
  guard: GuardedMutationExpectation,
  options: GuardedTargetOptions,
): void {
  const ownedBy = host.ownershipOf(id)
  if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
    throw new HelmxError(
      'ownership_conflict',
      `conversation ${id} is currently owned by ${ownedBy}${guard.expectedOwnership !== undefined ? ` (expected ${guard.expectedOwnership})` : ''}; refusing automated ${options.action} (human-ownership invariant)`,
      409,
      {
        conversationId: id,
        currentOwnership: ownedBy,
        ...(guard.expectedOwnership !== undefined ? { expectedOwnership: guard.expectedOwnership } : {}),
        ...(options.requestedConversationId !== undefined ? { requestedConversationId: options.requestedConversationId } : {}),
      },
    )
  }
  if (guard.expectedStateSeq !== undefined) {
    const meta = host.store.getConv(id)
    if (meta === undefined || host.store.isDeleted(id)) {
      throw new HelmxError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
    }
    if (meta.stateChangeSeq !== guard.expectedStateSeq) {
      throw new HelmxError(
        'state_seq_conflict',
        `conversation ${id} authoritative watermark ${meta.stateChangeSeq} does not match expected ${guard.expectedStateSeq} (stale probe snapshot; must not act on newer turn)`,
        409,
        { conversationId: id, currentSeq: meta.stateChangeSeq, expectedSeq: guard.expectedStateSeq },
      )
    }
  }
}
