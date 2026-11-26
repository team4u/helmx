/**
 * Unit tests for the guarded-mutation primitives shared by ConversationService (action 'mutation') and
 * ConversationLifecycleService.deleteConversationGuarded (action 'deletion'):
 * conversation-service/guarded-mutations.ts is the single source of the automation red line re-check.
 *
 * Locks the contract (code / status / details / diagnostic wording) of the synchronous ownership + CAS watermark
 * re-check with a fake store, independent of the end-to-end guarded-mutation.test.ts runtime coverage:
 * 1. human ownership is always refused (409 ownership_conflict), with or without an explicit expectedOwnership;
 * 2. expectedOwnership mismatch is refused and named in message + details;
 * 3. expectedStateSeq: missing/tombstoned → 404 not_found; stale → 409 state_seq_conflict with both watermarks;
 * 4. action word ('mutation' | 'deletion') and requestedConversationId (derived deletion target) are carried in the
 *    diagnostic; the CAS check is skipped when no expectedStateSeq is given (derived targets re-check ownership only).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmxError } from '@helmx/protocol'
import type { ConvMeta } from '../src/runtime/store.js'
import type { HelmxStore } from '../src/runtime/store.js'
import {
  assertGuardedMutationTarget,
  assertGuardShape,
} from '../src/runtime/conversation-service/guarded-mutations.js'

const timeout = { timeout: 60_000 } as const

function makeHost(options: { ownership: 'human' | 'helmx'; seq?: number; deleted?: boolean }) {
  const meta = { stateChangeSeq: options.seq ?? 7 } as ConvMeta
  const store = {
    getConv: () => (options.seq === undefined ? undefined : meta),
    isDeleted: () => options.deleted === true,
  } as unknown as HelmxStore
  return { store, ownershipOf: () => options.ownership }
}

function capture(fn: () => void): HelmxError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got ${String(err)}`)
    return err
  }
  throw new Error('expected the guard to throw')
}

test('assertGuardShape rejects non-object, human expectation and malformed stateSeq synchronously (400)', timeout, () => {
  assert.throws(() => assertGuardShape(null as never), (err: unknown) => err instanceof HelmxError && err.status === 400)
  assert.throws(
    () => assertGuardShape({ expectedOwnership: 'human' as never }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
  assert.throws(
    () => assertGuardShape({ expectedStateSeq: -1 }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
  assert.doesNotThrow(() => assertGuardShape({}))
  assert.doesNotThrow(() => assertGuardShape({ expectedOwnership: 'helmx', expectedStateSeq: 0 }))
})

test('human ownership is always refused with 409 ownership_conflict and the unified mutation wording', timeout, () => {
  const host = makeHost({ ownership: 'human', seq: 7 })
  const plain = capture(() => assertGuardedMutationTarget(host, 11, {}, { action: 'mutation' }))
  assert.ok(plain.code === 'ownership_conflict' && plain.status === 409)
  assert.equal(
    plain.message,
    'conversation 11 is currently owned by human; refusing automated mutation (human-ownership invariant)',
  )
  assert.deepEqual(plain.details, { conversationId: 11, currentOwnership: 'human' })

  const expected = capture(() =>
    assertGuardedMutationTarget(host, 11, { expectedOwnership: 'helmx' }, { action: 'mutation' }),
  )
  assert.ok(expected.code === 'ownership_conflict' && expected.status === 409)
  assert.equal(
    expected.message,
    'conversation 11 is currently owned by human (expected helmx); refusing automated mutation (human-ownership invariant)',
  )
  assert.deepEqual(expected.details, { conversationId: 11, currentOwnership: 'human', expectedOwnership: 'helmx' })
})

test('expectedStateSeq: missing or tombstoned conversation → 404 not_found; stale watermark → 409 state_seq_conflict', timeout, () => {
  const missing = capture(() =>
    assertGuardedMutationTarget(makeHost({ ownership: 'helmx' }), 3, { expectedStateSeq: 1 }, { action: 'mutation' }),
  )
  assert.ok(missing.code === 'not_found' && missing.status === 404)
  assert.deepEqual(missing.details, { conversationId: 3 })

  const tombstoned = capture(() =>
    assertGuardedMutationTarget(
      makeHost({ ownership: 'helmx', seq: 1, deleted: true }),
      3,
      { expectedStateSeq: 1 },
      { action: 'mutation' },
    ),
  )
  assert.ok(tombstoned.code === 'not_found' && tombstoned.status === 404)

  const stale = capture(() =>
    assertGuardedMutationTarget(makeHost({ ownership: 'helmx', seq: 9 }), 3, { expectedStateSeq: 8 }, { action: 'mutation' }),
  )
  assert.ok(stale.code === 'state_seq_conflict' && stale.status === 409)
  assert.equal(
    stale.message,
    'conversation 3 authoritative watermark 9 does not match expected 8 (stale probe snapshot; must not act on newer turn)',
  )
  assert.deepEqual(stale.details, { conversationId: 3, currentSeq: 9, expectedSeq: 8 })

  assert.doesNotThrow(() =>
    assertGuardedMutationTarget(makeHost({ ownership: 'helmx', seq: 9 }), 3, { expectedOwnership: 'helmx', expectedStateSeq: 9 }, {
      action: 'mutation',
    }),
  )
})

test('deletion action names the verb and the requested conversation for derived targets; CAS check only when requested', timeout, () => {
  const host = makeHost({ ownership: 'human', seq: 9 })
  const derived = capture(() =>
    assertGuardedMutationTarget(host, 12, { expectedOwnership: 'helmx' }, {
      action: 'deletion',
      requestedConversationId: 5,
    }),
  )
  assert.ok(derived.code === 'ownership_conflict' && derived.status === 409)
  assert.equal(
    derived.message,
    'conversation 12 is currently owned by human (expected helmx); refusing automated deletion (human-ownership invariant)',
  )
  assert.deepEqual(derived.details, {
    conversationId: 12,
    currentOwnership: 'human',
    expectedOwnership: 'helmx',
    requestedConversationId: 5,
  })

  // Derived target with no expectedStateSeq: the stale watermark of the target is irrelevant (ownership-only re-check).
  assert.doesNotThrow(() =>
    assertGuardedMutationTarget(makeHost({ ownership: 'helmx', seq: 9 }), 12, { expectedOwnership: 'helmx' }, {
      action: 'deletion',
      requestedConversationId: 5,
    }),
  )
  const root = capture(() =>
    assertGuardedMutationTarget(makeHost({ ownership: 'helmx', seq: 9 }), 5, { expectedOwnership: 'helmx', expectedStateSeq: 4 }, {
      action: 'deletion',
    }),
  )
  assert.ok(root.code === 'state_seq_conflict' && root.status === 409)
  assert.deepEqual(root.details, { conversationId: 5, currentSeq: 9, expectedSeq: 4 })
})
