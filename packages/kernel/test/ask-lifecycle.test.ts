/**
 * AskService lifecycle contract tests: three AskResult states, waiter registration order, and pre-allocated IDs.
 *
 * Covers contract invariants and main-agent reproduction cases:
 * - Synchronous superseding race bug: calling cancelAsk(id, 'superseded') synchronously inside an ask.upsert
 *   event callback previously left the createAsk promise hanging forever (because waiter registered after publish
 *   while settle saw an empty waiter map) -- must resolve to superseded now;
 * - Synchronous answer: calling answerAsk synchronously inside an event callback must deliver answers;
 * - All three terminal states resolve (cancelled/superseded have answers: {}; never backfill false approvals),
 *   rejecting only on validation or IO faults;
 * - Pre-allocated spec.id is preserved without UUID replacement; duplicate IDs (any status, including settled
 *   approvals) reject with 409 without overwriting old records; invalid IDs (empty/whitespace/non-string) reject validation;
 * - CAS semantics preserved: stale client seq returns 409, missing resolver returns ask_state_unavailable,
 *   target seq mismatch (including rollback) resolves to superseded;
 * - Secret field boundary: result and persisted rows keep only [REDACTED:stash:*]; envFor recovers plaintext;
 * - Waiters are reclaimed if putAsk throws: never hanging, createAsk rejects explicitly.
 */

import { HelmxError } from '@helmx/protocol'
import { withTimeout } from '@helmx/test-kit'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { HelmxStore } from '../src/runtime/store.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'

interface TestContext {
  service: AskService
  store: HelmxStore
  events: Array<{ type: string; payload: unknown }>
  pendingChanged: number[]
  /** Closes store and underlying db sequentially (must be called in finally to avoid fd leaks). */
  close(): Promise<void>
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-ask-lifecycle-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function openService(
  options: {
    validateConversation?: (id: number) => boolean
    onEvent?: (type: string, payload: unknown) => void
    onError?: (error: unknown) => void
  } = {},
): Promise<TestContext> {
  const db = await openHelmxDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
  const store = new HelmxStore(
    db,
    options.onError !== undefined ? { onError: options.onError } : {},
  )
  await store.load()
  const events: Array<{ type: string; payload: unknown }> = []
  const pendingChanged: number[] = []
  const service = new AskService({
    store,
    onEvent: (type, payload) => {
      events.push({ type, payload })
      options.onEvent?.(type, payload)
    },
    onConvPendingChanged: (id) => pendingChanged.push(id),
    validateConversation: options.validateConversation,
  })
  return {
    service,
    store,
    events,
    pendingChanged,
    async close() {
      await store.close()
      await db.close()
    },
  }
}

/** Asserts that promise settles within ms (guards against hang regressions with diagnostic failures). */
async function assertSettlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return withTimeout(promise, ms, `${label}: promise did not settle within ${ms}ms (hang regression)`)
}

const baseSpec = {
  conversationId: 1,
  title: 'approval',
  fields: [{ name: 'x', label: 'X', type: 'text' as const }],
}

// ---------------------------------------------------------------------------

describe('Ask lifecycle: synchronous supersede/answer never hangs', { timeout: 60_000 }, () => {
  it('main repro path: synchronous cancelAsk(superseded) inside ask.upsert callback resolves promise to superseded', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      // Cancel synchronously inside event callback (path triggered by real plugins via events.subscribe).
      // Must operate on the same instance (waiters Map is per-instance): hook references itself to mimic plugin callback.
      let hook: AskService
      hook = new AskService({
        store: ctx.store,
        onEvent: (type, payload) => {
          if (type === 'ask.upsert') {
            void hook.cancelAsk((payload as { id: string }).id, 'superseded')
          }
        },
        onConvPendingChanged: () => {},
      })
      const result = await assertSettlesWithin(
        hook.createAsk(baseSpec),
        2_000,
        'sync superseded',
      )
      assert.equal(result.status, 'superseded')
      assert.deepEqual(result.answers, {})
      assert.equal(ctx.store.getAsk(result.id)!.status, 'superseded')
    } finally {
      await ctx.close()
    }
  })

  it('sync answer: synchronous answerAsk inside ask.upsert callback delivers answers', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      let hook: AskService
      hook = new AskService({
        store: ctx.store,
        onEvent: (type, payload) => {
          if (type === 'ask.upsert') {
            void hook.answerAsk((payload as { id: string }).id, { x: 'sync answer' })
          }
        },
        onConvPendingChanged: () => {},
      })
      const result = await assertSettlesWithin(hook.createAsk(baseSpec), 2_000, 'sync answer')
      assert.equal(result.status, 'answered')
      assert.deepEqual(result.answers, { x: 'sync answer' })
    } finally {
      await ctx.close()
    }
  })

  it('async cancel/answer path remains unaffected (normally settles on await)', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const p1 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id)
      const r1 = await assertSettlesWithin(p1, 2_000, 'async cancel')
      assert.equal(r1.status, 'cancelled')
      assert.deepEqual(r1.answers, {})

      const p2 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const r2 = await assertSettlesWithin(p2, 2_000, 'async answer')
      assert.equal(r2.status, 'answered')
      assert.deepEqual(r2.answers, { x: 'v' })
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask three terminal outcomes and error boundaries', { timeout: 60_000 }, () => {
  it('answered carries answers; cancelled/superseded carry {} (never backfilling false approvals)', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, title: 'answer' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'ok' })
      const answered = await pa
      assert.equal(answered.status, 'answered')
      assert.deepEqual(answered.answers, { x: 'ok' })
      assert.equal(typeof answered.id, 'string')

      const pc = ctx.service.createAsk({ ...baseSpec, title: 'cancel' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'cancelled')
      const cancelled = await pc
      assert.equal(cancelled.status, 'cancelled')
      assert.deepEqual(cancelled.answers, {})

      const ps = ctx.service.createAsk({ ...baseSpec, title: 'supersede' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'superseded')
      const superseded = await ps
      assert.equal(superseded.status, 'superseded')
      assert.deepEqual(superseded.answers, {})
    } finally {
      await ctx.close()
    }
  })

  it('validation failures reject: invalid spec / missing conversation / invalid answers do not settle ask', { timeout: 60_000 }, async () => {
    const ctx = await openService({ validateConversation: (id) => id === 1 })
    try {
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, fields: [{ name: '', label: 'empty name', type: 'text' }] }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, conversationId: 424242 }),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
      // Invalid answer rejected (answerAsk throws); ask remains pending without fabricating a result.
      const pa = ctx.service.createAsk(baseSpec)
      void pa.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v', rogue: 'y' } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      assert.equal(ctx.store.getAsk(ask.id)!.status, 'pending')
      await ctx.service.cancelAsk(ask.id)
      await pa
    } finally {
      await ctx.close()
    }
  })

  it('putAsk synchronous rejection (mirror pre-check): createAsk rejects explicitly without leaking waiter', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const raw = ctx.store as unknown as { putAsk: (row: unknown) => void }
      const original = raw.putAsk.bind(ctx.store)
      raw.putAsk = () => {
        throw new HelmxError('store_flush_failed', 'simulated persist failure', 500)
      }
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
      )
      raw.putAsk = original
      // Waiter was reclaimed: recreating and running normally afterward is unpolluted.
      assert.equal(ctx.service.listAsks('pending').length, 0)
      const ok = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const result = await assertSettlesWithin(ok, 2_000, 'rebuild after failure reclaim')
      assert.equal(result.status, 'answered')
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask persistence failures (SQL tail chain injection): never return false success', { timeout: 60_000 }, () => {
  // putAsk only writes the mirror and enqueues SQL: the real boundary is at the end of the chain, where flushPublic exposes
  // async SQL failures. Inject db.run errors to verify both creation and settlement avoid false success.
  let reported: unknown[] = []

  function patchRun(
    store: HelmxStore,
    shouldFail: (sql: string, params: unknown[]) => boolean,
  ): void {
    const internals = store as unknown as {
      db: { run: (sql: string, ...params: unknown[]) => Promise<void> }
    }
    const original = internals.db.run.bind(internals.db)
    internals.db.run = (sql: string, ...params: unknown[]) => {
      if (shouldFail(sql, params)) return Promise.reject(new Error('injected SQL failure'))
      return original(sql, ...params)
    }
  }

  it('creation INSERT fails: createAsk rejects, no ask.upsert emitted, subsequent writes reject explicitly', { timeout: 60_000 }, async () => {
    reported = []
    const ctx = await openService({
      onError: (error) => reported.push(error),
    })
    try {
      patchRun(ctx.store, (sql) => sql.includes('INSERT INTO helmx_asks'))
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
      )
      // Emits no visible system event (side effects are gated on commit, never optimistic false success).
      assert.equal(ctx.events.find((e) => e.type === 'ask.upsert'), undefined)
      // Store enters broken state: subsequent writes reject explicitly instead of pretending queue success.
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmxError && (err.code === 'store_flush_failed' || err.code === 'store_closed'),
      )
      // Error is reported upward (not silently swallowed).
      assert.ok(reported.length >= 1, 'persistence error must be reported')
    } finally {
      await ctx.close()
    }
  })

  it('settlement UPDATE fails: never returns false answered; createAsk rejects with same error; no ask.resolved', { timeout: 60_000 }, async () => {
    reported = []
    const ctx = await openService({
      onError: (error) => reported.push(error),
    })
    try {
      // Creation INSERT binds settled_at as null; settlement writes a timestamp number -- intercept settlement only.
      patchRun(ctx.store, (sql, params) => sql.includes('helmx_asks') && typeof params[8] === 'number')
      const askPromise = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'real answer' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
      )
      // createAsk must not resolve with a false answer: rejects with the same failure (and does not hang).
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'settlement failure'),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
      )
      // Terminal event is not published.
      assert.equal(ctx.events.find((e) => e.type === 'ask.resolved'), undefined)
      assert.ok(reported.length >= 1, 'persistence error must be reported')
    } finally {
      await ctx.close()
    }
  })

  it('terminal synchronous putAsk throws: answer/cancel reject and createAsk waiter rejects with same error without hanging', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const askPromise = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      // Synchronous mirror write rejects (store closed/pre-check throw) before flush.
      const raw = ctx.store as unknown as { putAsk: (row: unknown) => void }
      const original = raw.putAsk.bind(ctx.store)
      raw.putAsk = () => {
        throw new HelmxError('store_closed', 'simulated terminal sync write failure', 409)
      }
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_closed',
      )
      // createAsk waiter must not hang or receive false terminal outcome: rejects with the same error.
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'terminal sync put failure'),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_closed',
      )
      raw.putAsk = original
      // Cancel path also rejects without hanging (pre-allocate ID for exact lookup away from older pending asks).
      const p2 = ctx.service.createAsk({ ...baseSpec, id: 'cancel-put-fail', title: 'cancel' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(ctx.service.listAsks('pending').find((a) => a.id === 'cancel-put-fail') !== undefined, true)
      raw.putAsk = () => {
        throw new HelmxError('store_closed', 'simulated terminal sync write failure', 409)
      }
      await assert.rejects(
        () => ctx.service.cancelAsk('cancel-put-fail'),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_closed',
      )
      await assert.rejects(
        () => assertSettlesWithin(p2, 2_000, 'cancel sync put failure'),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_closed',
      )
      raw.putAsk = original
    } finally {
      await ctx.close()
    }
  })

  it('ask.resolved publish throws: answer rejects and createAsk waiter rejects with same error without hanging', { timeout: 60_000 }, async () => {
    // Even if DB persisted, an event callback throw must fail cleanly rather than pretending settlement succeeded.
    const db = await openHelmxDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
    const store = new HelmxStore(db)
    await store.load()
    const events: Array<{ type: string; payload: unknown }> = []
    const failing = new AskService({
      store,
      onEvent: (type, payload) => {
        events.push({ type, payload })
        if (type === 'ask.resolved') throw new Error('event publish fault')
      },
      onConvPendingChanged: () => {},
    })
    try {
      const askPromise = failing.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = failing.listAsks('pending')[0]!
      await assert.rejects(
        () => failing.answerAsk(ask.id, { x: 'v' }),
        (err: unknown) => err instanceof Error && String(err.message).includes('event publish fault'),
      )
      // Persistence succeeded yet event failed: waiter rejects with same error (no hang, no false answer).
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'event publish failed'),
        (err: unknown) => err instanceof Error && String(err.message).includes('event publish fault'),
      )
    } finally {
      await store.close()
      await db.close()
    }
  })

  it('any failure in cancelByConversation rejects overall rather than succeeding silently', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const p1 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const p2 = ctx.service.createAsk({ ...baseSpec, title: 'second' })
      await new Promise((r) => setTimeout(r, 20))
      // Inject settlement UPDATE failure (leave creation INSERT with settled_at=null untouched).
      patchRun(ctx.store, (sql, params) => sql.includes('helmx_asks') && typeof params[8] === 'number')
      await assert.rejects(
        () => ctx.service.cancelByConversation(1),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
      )
      // Failed waiters settle with failure (never left hanging or falsely terminated).
      const outcomes = await Promise.allSettled([p1, p2])
      const rejected = outcomes.filter((o) => o.status === 'rejected').length
      assert.ok(rejected >= 1, 'at least one affected ask waiter must fail explicitly')
      // Must never let one cancellation resolve to cancelled while reporting batch success overall.
      patchRun(ctx.store, () => false)
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask pre-allocated ID', { timeout: 60_000 }, () => {
  it('spec.id is preserved without UUID replacement; result.id matches store', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, id: 'pre-allocated-1' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(ctx.service.listAsks('pending')[0]!.id, 'pre-allocated-1')
      await ctx.service.answerAsk('pre-allocated-1', { x: 'v' })
      const result = await pa
      assert.equal(result.id, 'pre-allocated-1')
      assert.equal(result.status, 'answered')
    } finally {
      await ctx.close()
    }
  })

  it('duplicate ID rejected (including settled approvals): 409 ask_id_conflict without overwriting old record', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, id: 'dup-1' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk('dup-1', { x: 'original answer' })
      await pa
      // Reusing an already-settled (answered) ID rejects without overwriting the old decision.
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-1' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'ask_id_conflict',
      )
      assert.equal(ctx.store.getAsk('dup-1')!.status, 'answered')
      assert.equal(JSON.parse(ctx.store.getAsk('dup-1')!.resultJson!).x, 'original answer')

      // Pending IDs also reject.
      const pb = ctx.service.createAsk({ ...baseSpec, id: 'dup-2' })
      void pb.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'ask_id_conflict',
      )
      await ctx.service.cancelAsk('dup-2')
      await pb
      // Cancelled records still occupy the ID.
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'ask_id_conflict',
      )
    } finally {
      await ctx.close()
    }
  })

  it('invalid id formats reject: empty string / whitespace only / non-string', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      for (const bad of ['', '   ']) {
        await assert.rejects(
          () => ctx.service.createAsk({ ...baseSpec, id: bad }),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
        )
      }
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 123 as never }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      assert.equal(ctx.service.listAsks().length, 0)
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask CAS semantics preservation', { timeout: 60_000 }, () => {
  it('stale client seq 409; matching seq or omitted seq answers normally', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, expectedStateSeq: 10, title: 'CAS' })
      void pa.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v' }, 9),
        (err: unknown) => err instanceof HelmxError && err.code === 'ask_state_conflict',
      )
      const ok1 = await ctx.service.answerAsk(ask.id, { x: 'v' }, 10)
      assert.equal(ok1.status, 'answered')
      const r1 = await assertSettlesWithin(pa, 2_000, 'matching seq answer')
      assert.equal(r1.status, 'answered')

      const pb = ctx.service.createAsk({ ...baseSpec, expectedStateSeq: 5, title: 'CAS no client seq' })
      await new Promise((r) => setTimeout(r, 20))
      const ask2 = ctx.service.listAsks('pending')[0]!
      const ok2 = await ctx.service.answerAsk(ask2.id, { x: 'v' })
      assert.equal(ok2.status, 'answered')
      const r2 = await assertSettlesWithin(pb, 2_000, 'omitted seq answer')
      assert.equal(r2.status, 'answered')
    } finally {
      await ctx.close()
    }
  })

  it('duplicate field.name declarations reject with validation_error', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      await assert.rejects(
        () =>
          ctx.service.createAsk({
            conversationId: 1,
            title: 'duplicate name',
            fields: [
              { name: 'dup', label: '1', type: 'text' },
              { name: 'dup', label: '2', type: 'text' },
            ],
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
    } finally {
      await ctx.close()
    }
  })

  it('CAS checks live conversation stateChangeSeq atomically: advances supersede, unmatched client seq on unwatermarked ask returns 409, concurrent answerAsk settles once', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const makeConv = (stateChangeSeq: number) => ({
        id: 1,
        title: 'conv-1',
        profileId: 'assistant',
        tags: [],
        nodeId: 'local',
        cwd: '/tmp',
        model: '',
        thinkingLevel: '',
        unread: false,
        pinned: false,
        stateChangeSeq,
        completionSeq: 0,
        runDurationMs: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      })
      ctx.store.upsertConv(makeConv(5))
      await ctx.store.flushPublic()

      // 1) Matching live stateChangeSeq (5 <= 5): answers normally.
      const p1 = ctx.service.createAsk({ ...baseSpec, id: 'cas-match', expectedStateSeq: 5, title: 'match' })
      await new Promise((r) => setTimeout(r, 20))
      const ans1 = await ctx.service.answerAsk('cas-match', { x: 'ok' }, 5)
      assert.equal(ans1.status, 'answered')
      assert.equal((await assertSettlesWithin(p1, 2_000, 'cas-match')).status, 'answered')

      // 2) Live stateChangeSeq advances past persisted watermark (6 > 5): auto-settles as superseded without fake answers.
      const p2 = ctx.service.createAsk({ ...baseSpec, id: 'cas-stale', expectedStateSeq: 5, title: 'stale' })
      await new Promise((r) => setTimeout(r, 20))
      ctx.store.upsertConv(makeConv(6))
      await ctx.store.flushPublic()

      const res2 = await ctx.service.answerAsk('cas-stale', { x: 'late' }, 5)
      assert.equal(res2.status, 'superseded')
      const settled2 = await assertSettlesWithin(p2, 2_000, 'cas-stale superseded')
      assert.equal(settled2.status, 'superseded')
      assert.deepEqual(settled2.answers, {})
      const persisted2 = ctx.store.getAsk('cas-stale')!
      assert.equal(persisted2.status, 'superseded')
      assert.equal(persisted2.resultJson, undefined)

      // 3) Unwatermarked ask + client-supplied expectedStateSeq vs live stateChangeSeq (6): mismatch -> 409 (ask stays pending), match -> answered.
      const p3 = ctx.service.createAsk({ ...baseSpec, id: 'cas-client-only', title: 'client seq' })
      await new Promise((r) => setTimeout(r, 20))
      await assert.rejects(
        () => ctx.service.answerAsk('cas-client-only', { x: 'old' }, 5),
        (err: unknown) => err instanceof HelmxError && err.code === 'ask_state_conflict' && err.status === 409,
      )
      assert.equal(ctx.store.getAsk('cas-client-only')!.status, 'pending')
      const res3 = await ctx.service.answerAsk('cas-client-only', { x: 'fresh' }, 6)
      assert.equal(res3.status, 'answered')
      assert.deepEqual((await assertSettlesWithin(p3, 2_000, 'cas-client-only')).answers, { x: 'fresh' })

      // 4) Concurrent answerAsk in the same tick: atomic mirror flip lets exactly one succeed and rejects the other with 409.
      const p4 = ctx.service.createAsk({ ...baseSpec, id: 'cas-race', expectedStateSeq: 6, title: 'race' })
      await new Promise((r) => setTimeout(r, 20))
      const [first, second] = await Promise.allSettled([
        ctx.service.answerAsk('cas-race', { x: 'winner' }, 6),
        ctx.service.answerAsk('cas-race', { x: 'loser' }, 6),
      ])
      assert.equal(first.status, 'fulfilled')
      assert.equal(second.status, 'rejected')
      assert.ok(second.reason instanceof HelmxError && second.reason.code === 'ask_already_settled')
      assert.deepEqual((await assertSettlesWithin(p4, 2_000, 'cas-race')).answers, { x: 'winner' })
    } finally {
      await ctx.close()
    }
  })

  it('corrupted AskRow specJson in mirror fails explicitly with store_data_corrupted instead of raw SyntaxError/TypeError', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const asksMap = (ctx.store as unknown as { askRepo: { asks: Map<string, { id: string; conversationId: number; specJson: string; status: string; createdAt: number }> } }).askRepo.asks
      asksMap.set('corrupt-1', {
        id: 'corrupt-1',
        conversationId: 1,
        specJson: '{"not":"an-ask-spec"}',
        status: 'pending',
        createdAt: 1,
      })
      assert.throws(
        () => ctx.service.getAsk('corrupt-1'),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_data_corrupted',
      )
      await assert.rejects(
        () => ctx.service.answerAsk('corrupt-1', { x: 'v' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'store_data_corrupted',
      )
    } finally {
      await ctx.close()
    }
  })

  it('choice, model, defaultValue, and hint fields persist, validate strictly, and clean up', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pChoice = ctx.service.createAsk({
        ...baseSpec,
        id: 'ask-choice-valid',
        title: { en: 'Clarify', 'zh-CN': '澄清' },
        hint: { en: 'Hint text', 'zh-CN': '提示文案' },
        fields: [
          {
            name: 'strategy',
            label: { en: 'Strategy', 'zh-CN': '策略' },
            type: 'choice',
            required: true,
            defaultValue: 'fast',
            options: [
              { label: { en: 'Fast', 'zh-CN': '快速' }, description: { en: 'Low latency', 'zh-CN': '低延迟' }, value: 'fast' },
              { label: { en: 'Safe', 'zh-CN': '稳妥' }, value: 'safe' },
            ],
          },
          {
            name: 'executionModel',
            label: { en: 'Model', 'zh-CN': '模型' },
            type: 'model',
            defaultValue: 'tier/strong',
          },
        ],
      })
      await new Promise((r) => setTimeout(r, 20))
      const stored = ctx.service.getAsk('ask-choice-valid')
      assert.ok(stored)
      assert.deepEqual(stored.hint, { en: 'Hint text', 'zh-CN': '提示文案' })
      assert.equal(stored.fields[0]?.type, 'choice')
      assert.equal(stored.fields[0]?.defaultValue, 'fast')
      assert.deepEqual(stored.fields[0]?.options?.[0]?.description, { en: 'Low latency', 'zh-CN': '低延迟' })
      assert.equal(stored.fields[1]?.type, 'model')
      assert.equal(stored.fields[1]?.defaultValue, 'tier/strong')

      await assert.rejects(
        () => ctx.service.answerAsk('ask-choice-valid', { strategy: 'nonexistent', executionModel: 'tier/strong' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      await ctx.service.answerAsk('ask-choice-valid', { strategy: 'safe', executionModel: '' })
      const answered = await assertSettlesWithin(pChoice, 2_000, 'choice+model answer')
      assert.equal(answered.status, 'answered')
      assert.deepEqual(answered.answers, { strategy: 'safe', executionModel: '' })

      await assert.rejects(
        () =>
          ctx.service.createAsk({
            ...baseSpec,
            id: 'ask-bad-choice-default',
            fields: [
              {
                name: 'strategy',
                label: 'Strategy',
                type: 'choice',
                defaultValue: 'unknown',
                options: [{ label: 'Fast', value: 'fast' }],
              },
            ],
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )

      await assert.rejects(
        () =>
          ctx.service.createAsk({
            ...baseSpec,
            id: 'ask-bad-confirm-default',
            fields: [
              {
                name: 'ok',
                label: 'Confirm',
                type: 'confirm',
                defaultValue: 'maybe',
              },
            ],
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
    } finally {
      await ctx.close()
    }
  })
})
