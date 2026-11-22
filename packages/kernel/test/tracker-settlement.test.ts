/**
 * Regression tests for exact turn_settled tracking versus pi-durable run handOver.
 *
 * Bug background (locked down by this suite):
 * - The tracker treated ANY pi.live.run.taskId change as a run end. But pi-durable hands run control to a NEW
 *   generation task after every tool round (finishToolRound postTools boundary) and on onYield continuations:
 *   taskId changes while the run continues (`first` kept, inputs carried over). A turn with tool rounds therefore
 *   emitted one spurious turn_settled(completed) per round — mid-turn settlement consumers (swarm silent-exit
 *   detection, coordinator report flush, superagent watchdogs, workflow settlement) all misfired, and completionSeq
 *   was inflated per round.
 *
 * Current contract:
 * 1. A multi-round tool turn settles exactly once, at the true run end, with outcome completed;
 * 2. Back-to-back turns (new run after an answered run) each settle once — same-run handOver suppression must not
 *    swallow genuine new runs;
 * 3. isContinuedRun discriminates handOver (same first / inputs carry-over) from a replacement run (fresh first,
 *    disjoint inputs); ambiguity resolves to "new run".
 *
 * Driven by a real Harness (faux provider + real SQLite + real observer pipeline), same wiring as live-generation tests.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import { ConversationTracker, isContinuedRun, type TrackerEvents } from '../src/runtime/conversations.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

let root = ''

before(async () => {
  root = await makeTempDir('helmx-tracker-settlement-')
})

after(async () => {
  await cleanupDir(root)
})

function convMeta(id: number): ConvMeta {
  return {
    id,
    title: `conversation ${id}`,
    profileId: 'assistant',
    nodeId: 'local',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    runDurationMs: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

interface SettlementRecord {
  outcome: string
  error: string | undefined
  inputIds: string[]
  settledAt: number
  conversation: ConversationSummary
}

async function openTracker(): Promise<{
  tracker: ConversationTracker
  store: HelmxStore
  harness: Harness
  settled: SettlementRecord[]
  summaries: ConversationSummary[]
  faux: ReturnType<typeof makeFauxModels>['faux']
  conversationId: number
  dir: string
  close: () => Promise<void>
}> {
  const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const database = await openHelmxDatabase(dir)
  const store = new HelmxStore(database)
  await store.load()
  const { models, faux } = makeFauxModels()
  const harness = await Harness.open(
    database.storage,
    { models: () => models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  )
  harness.resume()
  const settled: SettlementRecord[] = []
  const summaries: ConversationSummary[] = []
  const events: TrackerEvents = {
    onSummaryChanged: (summary) => {
      summaries.push(summary)
    },
    onInputCommitted: () => {},
    onAssistantText: () => {},
    onTurnSettled: (payload, inputs) => {
      settled.push({
        outcome: payload.outcome,
        error: payload.error,
        inputIds: inputs.map((i) => i.id),
        settledAt: payload.settledAt,
        conversation: payload.conversation,
      })
    },
    onLiveChanged: () => {},
  }
  const tracker = new ConversationTracker({ harness, store, events })
  const conv = await harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    BACKGROUND_CONTEXT,
  )
  const conversationId = conv.id as number
  store.upsertConv(convMeta(conversationId))
  await tracker.observe(conversationId)
  return {
    tracker,
    store,
    harness,
    settled,
    summaries,
    faux,
    conversationId,
    dir,
    close: async () => {
      for (const { id } of store.listConvs()) {
        await tracker.ensureContextUsage(id)
        tracker.stopObserving(id)
      }
      await harness.close(BACKGROUND_CONTEXT)
      const err = await store.close()
      await database.close()
      if (err !== undefined) throw new HelmxError('store_flush_failed', String(err), 500)
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Pure function: logical-run identity across handOver
// ---------------------------------------------------------------------------

describe('isContinuedRun: logical-run identity (generic facts, zero policy)', { timeout: 60_000 }, () => {
  it('same taskId is the same run', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1] }, { taskId: 7, inputs: [1] }))
  })

  it('handOver: taskId changed, first kept, inputs carried (equal or grown) is the same run', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [1], first: 10 }))
    assert.ok(
      isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [1, 2], first: 10 }),
      'steers admitted at the postTools boundary grow the carried inputs',
    )
  })

  it('replacement run: fresh first is a new run even when taskId changed in one collapsed snapshot', { timeout: 60_000 }, () => {
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [2], first: 12 }))
    assert.ok(
      !isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [2] }),
      'a new run whose first was not recorded falls through to disjoint inputs',
    )
  })

  it('run disappearance is never a continuation', { timeout: 60_000 }, () => {
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, undefined))
  })

  it('first unrecorded on both sides falls back to inputs carry-over', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1, 2] }, { taskId: 9, inputs: [1, 2, 3] }))
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1] }, { taskId: 9, inputs: [2] }))
    assert.ok(
      !isContinuedRun({ taskId: 7, inputs: [] }, { taskId: 9, inputs: [1] }),
      'no identity evidence resolves to a new run (settle), never a silent continuation',
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Runtime: exact settlement emission with real handOver rounds
// ---------------------------------------------------------------------------

describe('ConversationTracker settlement vs run handOver (real harness)', { timeout: 60_000 }, () => {
  it('a multi-round tool turn settles exactly once at the true run end', { timeout: 60_000 }, async () => {
    const { tracker, harness, settled, faux, close, conversationId } = await openTracker()
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined, 'conversation handle must resolve')
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo two' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('final answer'),
      ])
      tracker.registerInput(conversationId, { id: 'req-1', text: 'run then answer', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'run then answer' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-1', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length > 0)

      // Pre-fix this fired once per tool round (spurious mid-turn completions).
      assert.equal(settled.length, 1, `expected exactly one settlement, got ${JSON.stringify(settled)}`)
      assert.equal(settled[0]!.outcome, 'completed')
      assert.equal(settled[0]!.error, undefined)
      // The single input stays tracked across both tool-round handOvers and settles with the run.
      assert.deepEqual(settled[0]!.inputIds, ['req-1'])
    } finally {
      await close()
    }
  })

  it('back-to-back turns each settle once (suppression must not swallow new runs)', { timeout: 60_000 }, async () => {
    const { tracker, harness, settled, faux, close, conversationId } = await openTracker()
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined, 'conversation handle must resolve')
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('first answer'),
        fauxAssistantMessage('second answer'),
      ])
      tracker.registerInput(conversationId, { id: 'req-1', text: 'first turn', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'first turn' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-1', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      tracker.registerInput(conversationId, { id: 'req-2', text: 'second turn', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'second turn' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-2', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 2)

      assert.equal(settled.length, 2, `expected two settlements, got ${JSON.stringify(settled)}`)
      assert.ok(settled.every((s) => s.outcome === 'completed'))
      assert.deepEqual(settled[0]!.inputIds, ['req-1'])
      assert.deepEqual(settled[1]!.inputIds, ['req-2'])
    } finally {
      await close()
    }
  })

  it('multi-round tool handOver preserves runStartedAt without resetting, and back-to-back turns exclude idle time', { timeout: 60_000 }, async () => {
    const { tracker, store, harness, settled, summaries, faux, close, conversationId } = await openTracker()
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined)
      faux.setResponses([
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one' })], { stopReason: 'toolUse' })
        },
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo two' })], { stopReason: 'toolUse' })
        },
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return fauxAssistantMessage('final answer')
        },
      ])
      tracker.registerInput(conversationId, { id: 'timing-1', text: 'multi-round', origin: 'human', createdAt: Date.now() })
      await conv.submit({ type: 'input', content: 'multi-round' }, BACKGROUND_CONTEXT).then((submission) =>
        tracker.bindSubmission(conversationId, 'timing-1', submission.id as number),
      )
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1)

      const workingRound1 = summaries.filter((s) => s.status === 'working')
      assert.ok(workingRound1.length >= 2, `expected multiple working summaries across tool rounds, got ${workingRound1.length}`)
      const uniqueStarts1 = new Set(workingRound1.map((s) => s.runStartedAt))
      assert.equal(uniqueStarts1.size, 1, `runStartedAt must stay constant across tool handOvers: ${JSON.stringify([...uniqueStarts1])}`)
      const start1 = workingRound1[0]!.runStartedAt!
      assert.ok(typeof start1 === 'number' && start1 > 0)

      const s1 = settled[0]!
      const expectedDuration1 = s1.settledAt - start1
      assert.ok(expectedDuration1 >= 40, `multi-round turn elapsed should cover all rounds, got ${expectedDuration1}`)
      assert.equal(s1.conversation.runStartedAt, undefined, 'settled summary must clear runStartedAt')
      assert.equal(s1.conversation.runDurationMs, expectedDuration1, 'runDurationMs must equal exact settledAt - runStartedAt')
      assert.equal(store.getConv(conversationId)?.runStartedAt, undefined)
      assert.equal(store.getConv(conversationId)?.runDurationMs, expectedDuration1)

      // Idle gap between turns must NOT be counted into runDurationMs.
      const beforeTurn2Index = summaries.length
      await new Promise((r) => setTimeout(r, 80))

      faux.setResponses([
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return fauxAssistantMessage('second turn answer')
        },
      ])
      tracker.registerInput(conversationId, { id: 'timing-2', text: 'second turn', origin: 'human', createdAt: Date.now() })
      await conv.submit({ type: 'input', content: 'second turn' }, BACKGROUND_CONTEXT).then((submission) =>
        tracker.bindSubmission(conversationId, 'timing-2', submission.id as number),
      )
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 2)

      const workingRound2 = summaries.slice(beforeTurn2Index).filter((s) => s.status === 'working')
      assert.ok(workingRound2.length >= 1)
      const start2 = workingRound2[0]!.runStartedAt!
      assert.ok(start2 >= s1.settledAt + 50, `turn 2 runStartedAt (${start2}) must start after idle gap from turn 1 (${s1.settledAt})`)
      const s2 = settled[1]!
      const expectedDuration2 = expectedDuration1 + (s2.settledAt - start2)
      assert.equal(s2.conversation.runStartedAt, undefined)
      assert.equal(s2.conversation.runDurationMs, expectedDuration2, 'inter-turn idle gap must be excluded from cumulative runDurationMs')
    } finally {
      await close()
    }
  })

  it('explicit abort settles once and accumulates runDurationMs without double-counting', { timeout: 60_000 }, async () => {
    const { tracker, store, harness, settled, summaries, faux, close, conversationId } = await openTracker()
    let releaseGate = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined)
      faux.setResponses([
        async (_ctx, opts) => {
          opts?.signal?.addEventListener('abort', () => releaseGate(), { once: true })
          if (!opts?.signal?.aborted) await gate
          return fauxAssistantMessage('unreachable')
        },
      ])
      tracker.registerInput(conversationId, { id: 'abort-1', text: 'hang then abort', origin: 'human', createdAt: Date.now() })
      await conv.submit({ type: 'input', content: 'hang then abort' }, BACKGROUND_CONTEXT).then((submission) =>
        tracker.bindSubmission(conversationId, 'abort-1', submission.id as number),
      )
      await waitFor(() => summaries.some((s) => s.status === 'working' && s.runStartedAt !== undefined))
      const startAt = summaries.find((s) => s.status === 'working')!.runStartedAt!
      await new Promise((r) => setTimeout(r, 25))

      const wasBusy = tracker.hasLiveWork(conversationId)
      assert.equal(wasBusy, true)
      await conv.abort(BACKGROUND_CONTEXT)
      tracker.settleAborted(conversationId)
      releaseGate()
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1)
      // Give any trailing observer snapshot time to arrive and verify no second settlement or double-add occurs.
      await new Promise((r) => setTimeout(r, 50))

      assert.equal(settled.length, 1, `explicit abort must settle exactly once, got ${settled.length}`)
      const rec = settled[0]!
      assert.equal(rec.outcome, 'aborted')
      assert.equal(rec.conversation.runStartedAt, undefined)
      assert.equal(rec.conversation.runDurationMs, rec.settledAt - startAt, 'abort must accumulate runDurationMs once (no double count)')
      assert.equal(store.getConv(conversationId)?.runStartedAt, undefined)
      assert.equal(store.getConv(conversationId)?.runDurationMs, rec.settledAt - startAt)
    } finally {
      releaseGate()
      await close()
    }
  })

  it('startup observe with no live run clears stale runStartedAt without inflating runDurationMs', { timeout: 60_000 }, async () => {
    const dir = join(root, `stale-start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    let convId = 0
    // Phase 1: create idle conversation, then stamp a stale runStartedAt (10 minutes ago) to simulate crash without resume.
    {
      const database = await openHelmxDatabase(dir)
      const store = new HelmxStore(database)
      await store.load()
      const { models } = makeFauxModels()
      const harness = await Harness.open(
        database.storage,
        { models: () => models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      )
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      convId = conv.id as number
      store.upsertConv({
        ...convMeta(convId),
        runDurationMs: 4_200,
        runStartedAt: Date.now() - 600_000,
      })
      await store.flushPublic()
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }

    // Phase 2: reopen and observe — adoptInitial must clear runStartedAt and leave runDurationMs untouched.
    {
      const database = await openHelmxDatabase(dir)
      const store = new HelmxStore(database)
      await store.load()
      assert.equal(store.getConv(convId)?.runDurationMs, 4_200)
      assert.ok(store.getConv(convId)?.runStartedAt !== undefined, 'precondition: stale runStartedAt loaded from SQLite')
      const { models } = makeFauxModels()
      const harness = await Harness.open(
        database.storage,
        { models: () => models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      )
      const tracker = new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: () => {},
        },
      })
      try {
        await tracker.observe(convId)
        assert.equal(store.getConv(convId)?.runStartedAt, undefined, 'stale runStartedAt must be cleared when no live run exists')
        assert.equal(store.getConv(convId)?.runDurationMs, 4_200, 'downtime must never be added into runDurationMs')
        const summary = tracker.summaryOf(convId)
        assert.equal(summary.runStartedAt, undefined)
        assert.equal(summary.runDurationMs, 4_200)
        await store.flushPublic()
      } finally {
        tracker.stopObserving(convId)
        await harness.close(BACKGROUND_CONTEXT)
        await store.close()
        await database.close()
      }
    }

    // Phase 3: verify cleanup persisted in SQLite.
    {
      const database = await openHelmxDatabase(dir)
      const store = new HelmxStore(database)
      await store.load()
      try {
        assert.equal(store.getConv(convId)?.runStartedAt, undefined)
        assert.equal(store.getConv(convId)?.runDurationMs, 4_200)
      } finally {
        await store.close()
        await database.close()
      }
    }
  })
})
