/**
 * Regression tests for real-time summary emission during active ConversationTracker runs.
 *
 * Bug background (locked down by this test suite):
 * - Previously, adopt() updated liveViews without emitting onSummaryChanged; only emitSettled and
 *   setPendingAskCount pushed summaries. Before the first token arrived (after a run started, before
 *   any token or tool), the state machine remained on the stale value, leaving an apparent idle gap
 *   with no status indicator right after submission.
 *
 * Current contract (emitRunSummary):
 * 1. Run start (when live.run first appears in a snapshot): emit a working summary (doing='thinking...');
 * 2. Semantic changes to `doing` (tool start/end) emit a new summary; pure streaming token progress
 *    (when `doing` does not change) does not emit -- deduplicated by semantic key
 *    (status|doing|pendingAsk) rather than emitting per token frame;
 * 3. Terminal states (completed/failed/aborted) remain owned by emitSettled (emitted exactly once);
 *    adopt neither recomputes nor regresses terminal states, and preserves ordering when run1 ends
 *    and run2 starts within the same collapsed snapshot;
 * 4. blocked (pendingAsk > 0 overriding working) is never regressed back to working by emitRunSummary;
 * 5. stateChangeSeq advances monotonically with real state transitions (protocol contract); idle
 *    snapshots do not advance it.
 *
 * Driven by a real KernelRuntime (faux provider + real SQLite + real observer pipeline); events are
 * collected via kernel.events subscription (sharing the exact same source as SSE).
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmxEventFrame } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface RecordedUpsert {
  status: ConversationSummary['status']
  doing: string | undefined
  seq: number
  at: number
  usageKey: string
}

let root = ''

before(async () => {
  root = await makeTempDir('helmx-run-summary-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(name: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: join(root, name),
    cwd: join(root, name),
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Subscribes to kernel.events (same source as SSE) and collects summary upsert timeline frames for the target conversation. */
function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: RecordedUpsert[]
  stop: () => void
} {
  const frames: RecordedUpsert[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmxEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id !== conversationId) return
    frames.push({
      status: conversation.status,
      doing: conversation.doing,
      seq: conversation.stateChangeSeq,
      at: frame.seq,
      usageKey: JSON.stringify(conversation.contextUsage ?? null),
    })
  })
  return { frames, stop: unsubscribe }
}

describe('emitRunSummary: real-time summary on run start and doing semantic changes', { concurrency: 4, timeout: 60_000 }, () => {
  it('emits working(doing=thinking...) on run start before first token; terminal completed emitted once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-start')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    try {
      // Hold back the first token instead of using a fixed delay to guess model/observer scheduling order.
      kernel.__faux.setResponses([
        async () => {
          await responseGate
          return fauxAssistantMessage('answer one')
        },
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        const before = kernel.conversations.getConversation(1).stateChangeSeq
        const submitP = kernel.conversations.submitInput(1, 'prompt before first token')
        await waitFor(() => recorded.frames.some((f) => f.status === 'working'))
        assert.equal(kernel.conversations.getConversation(1).status, 'working', 'state machine should already be working after run starts')
        const workingBeforeFirstToken = recorded.frames.filter((f) => f.status === 'working')
        assert.ok(
          workingBeforeFirstToken.length >= 1,
          `should emit at least one working summary before first token, actual: ${JSON.stringify(recorded.frames)}`,
        )
        assert.equal(workingBeforeFirstToken[0]!.doing, 'thinking...')
        releaseResponse()
        await submitP
        await kernel.conversations.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        // completed terminal state emitted exactly once: trailing idle snapshots must not duplicate done
        // frames (context-usage refresh frames share the same seq and are deduplicated, not counted as a new terminal state).
        const doneFrames = recorded.frames.filter((f) => f.status === 'done')
        assert.equal(
          new Set(doneFrames.map((f) => f.seq)).size,
          1,
          `completed terminal state must be emitted once, actual: ${JSON.stringify(recorded.frames)}`,
        )
        // stateChangeSeq advances monotonically without regressing (usage-only frames share the same seq and do not advance it).
        const seqs = recorded.frames.map((f) => f.seq)
        for (let i = 1; i < seqs.length; i += 1) {
          assert.ok(seqs[i]! >= seqs[i - 1]!, `stateChangeSeq must be monotonic and never regress: ${JSON.stringify(seqs)}`)
        }
        assert.ok(seqs[0]! > before, 'run-start summary advances stateChangeSeq')
      } finally {
        recorded.stop()
      }
    } finally {
      releaseResponse()
      await kernel.close()
    }
  })

  it('deduplicates doing transitions: thinking -> tool running -> tool done once each, no extra frames per token', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('doing-dedup')
    try {
      // Long streaming text: faux tokensPerSecond emits multiple tokens while doing remains 'thinking...'.
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('one two three four five six seven eight nine ten one two three four five six seven eight nine ten'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.conversations.submitInput(1, 'trigger tool round')
        await kernel.conversations.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        const workings = recorded.frames.filter((f) => f.status === 'working')
        // Separate state/doing transitions (which advance stateChangeSeq) from mid-run contextUsage-only refreshes
        // (which share the current stateChangeSeq and must carry a genuinely changed usage payload).
        const doingTransitions: RecordedUpsert[] = []
        for (const frame of workings) {
          const prev = doingTransitions[doingTransitions.length - 1]
          if (prev !== undefined && frame.seq === prev.seq) {
            assert.equal(
              frame.doing,
              prev.doing,
              `usage-only frame sharing seq=${frame.seq} must not mutate doing: ${JSON.stringify(workings)}`,
            )
            assert.notEqual(
              frame.usageKey,
              prev.usageKey,
              `same-seq working frame without contextUsage change is a duplicate: ${JSON.stringify(workings)}`,
            )
            // Keep latest usageKey on the group tail so consecutive usage updates also verify uniqueness.
            prev.usageKey = frame.usageKey
            continue
          }
          doingTransitions.push({ ...frame })
        }
        const doings = doingTransitions.map((f) => f.doing ?? '')
        // Identical doing semantics must never be pushed twice in a row (neither on token streaming nor on repeated snapshots).
        for (let i = 1; i < doings.length; i += 1) {
          assert.ok(
            doings[i] !== doings[i - 1],
            `identical doing semantics pushed consecutively: ${JSON.stringify(doingTransitions)}`,
          )
        }
        assert.ok(doings.includes('thinking...'), `run-start doing should include thinking...: ${JSON.stringify(doings)}`)
        assert.ok(
          doings.some((d) => d.startsWith('bash:')),
          `tool round doing should include bash:...: ${JSON.stringify(doings)}`,
        )
        // Streaming tokens must not emit extra frames: thinking... appears once per run start (two runs total).
        // During the second run's 20-word token-by-token stream, doing stays thinking... and must not re-emit.
        const thinkingCount = doings.filter((d) => d === 'thinking...').length
        assert.equal(thinkingCount, 2, `thinking... must appear exactly twice (once per run start): ${JSON.stringify(doingTransitions)}`)
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('successive followUp runs emit working and completed updates and converge cleanly without stale run state', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-switch')
    let releaseToolRound = () => {}
    const toolRoundGate = new Promise<void>((resolve) => { releaseToolRound = resolve })
    try {
      // followUp queuing: while run1 (with a tool round) is in flight, a second input is submitted;
      // SDK consumes run2 immediately after run1 finishes (observer may collapse run1 ending and run2
      // starting into the same snapshot).
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo tool-round' })], { stopReason: 'toolUse' }),
        async () => {
          await toolRoundGate
          return fauxAssistantMessage('run1 answer')
        },
        fauxAssistantMessage('run2 answer'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.conversations.submitInput(1, 'run1 prompt')
        await waitFor(() => recorded.frames.some((f) => (f.doing ?? '').startsWith('bash:')))
        assert.equal(kernel.conversations.getConversation(1).status, 'working')
        const followUpP = kernel.conversations.submitInput(1, 'run2 follow-up prompt', { whenBusy: 'followUp' }).catch(() => {})
        releaseToolRound()
        await followUpP
        await kernel.conversations.waitForIdle(1)
        await waitFor(
          () =>
            kernel.conversations.getConversation(1).status === 'done' &&
            recorded.frames.filter((f) => f.status === 'done').length >= 1,
        )
        // Valid event ordering: done may follow working; another round of working may follow done
        // (for run2 consumed via followUp) -- but final status must converge to done (run2 completes).
        await new Promise((r) => setTimeout(r, 60))
        const last = recorded.frames[recorded.frames.length - 1]!
        assert.equal(
          kernel.conversations.getConversation(1).status,
          'done',
          `both runs should settle at terminal status done, actual ${kernel.conversations.getConversation(1).status}`,
        )
        assert.ok(
          ['done', 'idle'].includes(last.status),
          `final frame should be a terminal state, actual: ${JSON.stringify(last)}`,
        )
        // Guard against regressing to working after terminal state and getting stuck: after the last working
        // frame, a terminal frame must still follow.
        const lastWorking = recorded.frames.map((f) => f.status).lastIndexOf('working')
        assert.ok(
          recorded.frames.slice(lastWorking + 1).some((f) => f.status === 'done' || f.status === 'idle'),
          `a terminal frame must follow the final working frame: ${JSON.stringify(recorded.frames)}`,
        )
      } finally {
        recorded.stop()
      }
    } finally {
      releaseToolRound()
      await kernel.close()
    }
  })

  it('failed / aborted terminal states: emitSettled emits once, adopt does not recompute', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('failed-aborted')
    try {
      // failed: faux reports a model error.
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.conversations.submitInput(1, 'failing prompt').catch(() => {})
        await kernel.conversations.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded.frames.some((f) => f.status === 'error'))
        const errorFrames = recorded.frames.filter((f) => f.status === 'error')
        assert.equal(errorFrames.length, 1, `failed terminal state must be emitted once: ${JSON.stringify(recorded.frames)}`)
        // Idle snapshots no longer emit (no re-emission): any trailing frame after terminal settlement can only be
        // usage-only (same status, same seq, watermark not advanced); state machine must never re-emit or regress.
        const frozenAt = recorded.frames.length
        const frozenLast = recorded.frames[frozenAt - 1]!
        await new Promise((r) => setTimeout(r, 60))
        for (const late of recorded.frames.slice(frozenAt)) {
          assert.equal(late.status, frozenLast.status, `post-terminal frames can only be usage-only: ${JSON.stringify(recorded.frames.slice(frozenAt))}`)
          assert.equal(late.seq, frozenLast.seq, 'usage-only frames must not advance stateChangeSeq')
        }
      } finally {
        recorded.stop()
      }

      // aborted: tool long turn in-flight explicit abort.
      const recorded2 = recordUpserts(kernel, 1)
      try {
        kernel.__faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
            stopReason: 'toolUse',
          }),
        ])
        void kernel.conversations.submitInput(1, 'prompt to be aborted').catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).status === 'working')
        await kernel.conversations.abortConversation(1)
        await kernel.conversations.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded2.frames.some((f) => f.status === 'idle'))
        // Aborted terminal status is idle; a working frame existed (emitted on run start) and settled once to idle.
        assert.ok(
          recorded2.frames.some((f) => f.status === 'working'),
          `a working summary should precede abort: ${JSON.stringify(recorded2.frames)}`,
        )
        const idleAfterAbort = recorded2.frames.filter((f) => f.status === 'idle')
        assert.equal(idleAfterAbort.length, 1, `aborted terminal state must be emitted once: ${JSON.stringify(recorded2.frames)}`)
        const afterAbortSummary = kernel.conversations.getConversation(1)
        assert.equal(afterAbortSummary.runStartedAt, undefined, 'aborted conversation must clear runStartedAt')
        assert.ok(
          typeof afterAbortSummary.runDurationMs === 'number' && afterAbortSummary.runDurationMs >= 0,
          `aborted conversation must carry non-negative runDurationMs, got ${String(afterAbortSummary.runDurationMs)}`,
        )
      } finally {
        recorded2.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('blocked overrides working: pendingAsk summary is not regressed by emitRunSummary', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('blocked-no-regress')
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 3' })], { stopReason: 'toolUse' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        void kernel.conversations.submitInput(1, 'prompt triggering approval').catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).status === 'working')
        // Create pending Ask while tool is in flight: setPendingAskCount emits blocked.
        const askPromise = kernel.asks.createAsk({
          conversationId: 1,
          title: 'test approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void askPromise.catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).status === 'blocked')
        // Tool keeps running: snapshots keep arriving; blocked must not regress back to working.
        await new Promise((r) => setTimeout(r, 200))
        assert.equal(
          kernel.conversations.getConversation(1).status,
          'blocked',
          'subsequent snapshots while pendingAsk is open must not regress status back to working',
        )
        const blockedFrames = recorded.frames.filter((f) => f.status === 'blocked')
        assert.ok(blockedFrames.length >= 1, 'blocked summary was emitted')
        // No frame after blocked may revert to working (even while run remains in flight).
        const afterBlocked = recorded.frames.slice(recorded.frames.findIndex((f) => f.status === 'blocked'))
        assert.ok(
          !afterBlocked.some((f) => f.status === 'working'),
          `must not regress back to working after blocked: ${JSON.stringify(recorded.frames)}`,
        )
        // Clean up: answer Ask and abort in-flight run.
        const pending = kernel.asks.listAsks('pending')
        if (pending.length > 0) await kernel.asks.answerAsk(pending[0]!.id, { confirm: 'true' }).catch(() => {})
        await kernel.conversations.abortConversation(1).catch(() => {})
        await kernel.conversations.waitForIdle(1).catch(() => {})
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('pendingAskSince tracks earliest pending AskDoc, advances when earliest settles, and clears when all settle', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('pending-ask-since')
    try {
      const upserts: ConversationSummary[] = []
      const stop = kernel.events.subscribe((frame: HelmxEventFrame) => {
        if (frame.event.type !== 'conversation.upsert') return
        const conv = (frame.event as { conversation?: ConversationSummary }).conversation
        if (conv?.id === 1) upserts.push(conv)
      })
      try {
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, undefined)

        const ask1P = kernel.asks.createAsk({
          id: 'ask-first',
          conversationId: 1,
          title: 'first approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void ask1P.catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 1)
        const ask1 = kernel.asks.listAsks('pending').find((a) => a.id === 'ask-first')!
        assert.equal(kernel.conversations.getConversation(1).status, 'blocked')
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, ask1.createdAt)

        // Ensure second ask has a strictly later createdAt timestamp.
        await new Promise((r) => setTimeout(r, 15))
        const ask2P = kernel.asks.createAsk({
          id: 'ask-second',
          conversationId: 1,
          title: 'second approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void ask2P.catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 2)
        const ask2 = kernel.asks.listAsks('pending').find((a) => a.id === 'ask-second')!
        assert.ok(ask2.createdAt > ask1.createdAt)
        assert.equal(
          kernel.conversations.getConversation(1).pendingAskSince,
          ask1.createdAt,
          'pendingAskSince must keep earliest pending ask timestamp when newer asks arrive',
        )

        // Settling the earliest ask must advance pendingAskSince to ask2.createdAt and push an upsert.
        await kernel.asks.answerAsk('ask-first', { confirm: 'true' })
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 1)
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, ask2.createdAt)
        assert.ok(
          upserts.some((u) => u.pendingAskCount === 1 && u.pendingAskSince === ask2.createdAt),
          'conversation.upsert must carry updated pendingAskSince when earliest ask settles',
        )

        // Settling the last pending ask clears pendingAskSince.
        await kernel.asks.answerAsk('ask-second', { confirm: 'true' })
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 0)
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, undefined)
        const finalUpsert = upserts[upserts.length - 1]!
        assert.equal(finalUpsert.pendingAskCount, 0)
        assert.equal(finalUpsert.pendingAskSince, undefined)

        // Concurrent settle + create: even when pendingAskCount stays 1 across an interleaved flush window,
        // pendingAskSince must advance to the newly created ask and emit a conversation.upsert.
        const ask3P = kernel.asks.createAsk({
          id: 'ask-swap-old',
          conversationId: 1,
          title: 'old approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void ask3P.catch(() => {})
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 1)
        const askOld = kernel.asks.listAsks('pending').find((a) => a.id === 'ask-swap-old')!
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, askOld.createdAt)
        const upsertsBeforeSwap = upserts.length
        const seqBeforeSwap = kernel.conversations.getConversation(1).stateChangeSeq

        await new Promise((r) => setTimeout(r, 15))
        // Fire answerAsk(old) and createAsk(new) concurrently in the same tick.
        const askNewP = kernel.asks.createAsk({
          id: 'ask-swap-new',
          conversationId: 1,
          title: 'new approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void askNewP.catch(() => {})
        await kernel.asks.answerAsk('ask-swap-old', { confirm: 'true' })
        await waitFor(() => kernel.asks.listAsks('pending').some((a) => a.id === 'ask-swap-new'))
        const askNew = kernel.asks.listAsks('pending').find((a) => a.id === 'ask-swap-new')!
        assert.ok(askNew.createdAt > askOld.createdAt)
        await waitFor(() =>
          upserts.slice(upsertsBeforeSwap).some((u) => u.pendingAskCount === 1 && u.pendingAskSince === askNew.createdAt),
        )
        assert.equal(kernel.conversations.getConversation(1).pendingAskCount, 1)
        assert.equal(kernel.conversations.getConversation(1).pendingAskSince, askNew.createdAt)
        assert.ok(kernel.conversations.getConversation(1).stateChangeSeq > seqBeforeSwap)

        await kernel.asks.answerAsk('ask-swap-new', { confirm: 'true' })
        await waitFor(() => kernel.conversations.getConversation(1).pendingAskCount === 0)
      } finally {
        stop()
      }
    } finally {
      await kernel.close()
    }
  })
})
