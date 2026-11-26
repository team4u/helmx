/**
 * Deterministic race tests for kernel guarded mutations (automated human-ownership hard rule).
 *
 * Background: even after watchdog plugins verify ownership, calling plain abortConversation /
 * submitInput still awaits `harness.conversation(...)` internally before taking effect; during that
 * await gap markConversationOwnership could switch to human and cause TOCTOU execution.
 *
 * Verification strategy (deterministic deferred barrier, zero polling):
 * - Attach a barrier precisely at the `harness.conversation` await point, switch ownership to human
 *   inside the await window, and release;
 * - Control group confirms that the same barrier hits the old window under plain abortConversation,
 *   which still aborts after switching (proving the barrier tests the real window);
 * - Guarded APIs (abortConversationGuarded / submitInputGuarded) must reject under the exact same ordering
 *   (409 ownership_conflict) without starting underlying SDK actions;
 * - Also covers success paths, stale stateSeq 409, mismatched ownership 409, missing target 404,
 *   invalid guards 400, and unchanged human behavior on plain APIs (submitInput / abortConversation);
 * - Guarded context maintenance surface for plugin automation (resetConversationGuarded /
 *   compactConversationGuarded): same serial-domain re-check invariants — human flip inside the await
 *   window rejects before the SDK reset fires, rejected calls leave stateChangeSeq untouched, and
 *   success paths advance the watermark by exactly one (handoff / background compaction taskId).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmxError } from '@helmx/protocol'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'
import { KernelRuntime } from '../src/runtime/index.js'

type RuntimeWithFaux = KernelRuntime & { __faux: ReturnType<typeof makeFauxModels>['faux'] }

async function openRuntime(dir: string): Promise<RuntimeWithFaux> {
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(kernel, { __faux: faux })
}

type ConversationFn = (id: never, ctx: unknown) => Promise<unknown>

/**
 * Installs a one-shot deterministic barrier on `harness.conversation` await points: blocks the next
 * (and subsequent) conversation() call at a gate until released, then delegates to the real method.
 * Plain abort/submit used to execute unconditionally after that await -- flipping ownership during the
 * barrier deterministically hits that exact legacy race window.
 */
function barrierConversationHandle(kernel: KernelRuntime): { release: () => void } {
  const harness = (kernel as unknown as { harness: { conversation: ConversationFn } }).harness
  const real = harness.conversation.bind(harness) as ConversationFn
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  harness.conversation = ((id: never, ctx: unknown) =>
    new Promise((resolve, reject) => {
      void gate.then(
        () => {
          void real(id, ctx).then(resolve, reject)
        },
        reject,
      )
    })) as ConversationFn
  return { release }
}

/** Flushes microtasks/I-O ticks so the tested Promise suspends cleanly at harness.conversation. */
async function flushToBarrier(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function isHelmxError(code: string, status: number) {
  return (err: unknown): boolean => err instanceof HelmxError && err.code === code && err.status === status
}

let root: string

test.before(async () => {
  root = await makeTempDir('helmx-guarded-')
})

test.after(async () => {
  await cleanupDir(root)
})

// ---------------------------------------------------------------------------
// 1. Core race: ownership flips inside the await window
// ---------------------------------------------------------------------------

test('guarded abort: flipping ownership to human inside await window -> 409 ownership_conflict, SDK abort untouched', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.ownership.markOwnership(1, 'helmx')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('unneeded second answer'),
    ])
    void kernel.conversations.submitInput(1, 'question whose abort will be rejected by guard').catch(() => {})
    await waitFor(() => kernel.conversations.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.abortConversationGuarded(1, { expectedOwnership: 'helmx' })
    await flushToBarrier()
    // Simulated takeover inside the legacy await window: human takes over.
    kernel.ownership.markOwnership(1, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))

    // SDK abort did not fire: in-flight turn keeps running (abort would have settled to idle immediately).
    assert.equal(kernel.conversations.getConversation(1).status, 'working', 'turn must not abort after guarded rejection')

    // Normal human API still works: human abort under human ownership settles cleanly.
    await kernel.conversations.abortConversation(1)
    await kernel.conversations.waitForIdle(1).catch(() => {})
    assert.equal(kernel.conversations.getConversation(1).status, 'idle')
    assert.equal(kernel.conversations.getConversation(1).completionSeq, 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('control group: same barrier hits legacy window; plain abortConversation still aborts after flip to human (preserves legacy semantics)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-abort-window')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.ownership.markOwnership(1, 'helmx')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('unneeded second answer'),
    ])
    void kernel.conversations.submitInput(1, 'verify barrier lands inside legacy window').catch(() => {})
    await waitFor(() => kernel.conversations.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.abortConversation(1)
    await flushToBarrier()
    kernel.ownership.markOwnership(1, 'human')
    barrier.release()
    // Plain API has no guard: aborts as normal after ownership flip (the exact race guarded API closes).
    await attempt
    await kernel.conversations.waitForIdle(1).catch(() => {})
    assert.equal(kernel.conversations.getConversation(1).status, 'idle')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded submit: flipping to human inside preparation window -> 409, zero commit side effects (no title / no input entry)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.conversations.createConversation({})
    kernel.ownership.markOwnership(conv.id, 'helmx')
    kernel.__faux.setResponses([fauxAssistantMessage('must never appear')])

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.submitInputGuarded(conv.id, 'automated input', { origin: 'agent' }, { expectedOwnership: 'helmx' })
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))

    // Zero commit side effects: title un-derived, no helmx.input entry, conversation stays idle.
    const after = kernel.conversations.getConversation(conv.id)
    assert.equal(after.status, 'idle')
    assert.equal(after.title, '')
    const detail = await kernel.conversations.getConversationDetail(conv.id, { limit: 50 })
    assert.equal(detail.entries.filter((e) => e.kind === 'helmx.input').length, 0, 'must not insert input entry')
    // Faux response untouched (model never invoked).
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 2. Success paths and deterministic rejections
// ---------------------------------------------------------------------------

test('guarded steer whenIdle=reject: idle conversation atomically rejects without starting turn or inserting input entry', { timeout: 60_000 }, async () => {
  const kernel = await openRuntime(join(root, 't-guarded-steer-idle'))
  try {
    const conversation = await kernel.conversations.createConversation({ title: 'idle automated conversation' })
    kernel.ownership.markOwnership(conversation.id, 'helmx')
    kernel.__faux.setResponses([fauxAssistantMessage('must not execute')])
    await assert.rejects(
      kernel.conversations.submitInputGuarded(conversation.id, 'steer only in-flight task', {
        origin: 'agent', whenBusy: 'steer', whenIdle: 'reject',
      }, { expectedOwnership: 'helmx', expectedStateSeq: kernel.conversations.getConversation(conversation.id).stateChangeSeq }),
      isHelmxError('conversation_idle', 409),
    )
    const detail = await kernel.conversations.getConversationDetail(conversation.id)
    assert.equal(detail.entries.filter((entry) => entry.kind === 'helmx.input').length, 0)
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
    assert.equal(kernel.conversations.getConversation(conversation.id).status, 'idle')
  } finally {
    await kernel.close()
  }
})

test('guarded abort success path: helmx conversation in-flight turn aborts when authorized', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-ok')
  const kernel = await openRuntime(dir)
  try {
    kernel.ownership.markOwnership(1, 'helmx')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
    ])
    void kernel.conversations.submitInput(1, 'question to authorize-abort').catch(() => {})
    await waitFor(() => kernel.conversations.getConversation(1).status === 'working')

    await kernel.conversations.abortConversationGuarded(1, { expectedOwnership: 'helmx' })
    await kernel.conversations.waitForIdle(1).catch(() => {})
    const conv = kernel.conversations.getConversation(1)
    assert.equal(conv.status, 'idle')
    assert.equal(conv.completionSeq, 1, 'aborted turn settles once')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit success path: helmx conversation submits agent input and completes turn', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-ok')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({})
    kernel.ownership.markOwnership(conv.id, 'helmx')
    kernel.__faux.setResponses([fauxAssistantMessage('recovery done')])
    const { submissionId } = await kernel.conversations.submitInputGuarded(conv.id, 'recovery prompt', { origin: 'agent', whenBusy: 'steer' }, { expectedOwnership: 'helmx' })
    assert.ok(submissionId)
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(kernel.conversations.getConversation(conv.id).status, 'done')
    const detail = await kernel.conversations.getConversationDetail(conv.id, { limit: 10 })
    const input = detail.entries.find((e) => e.kind === 'helmx.input')
    assert.ok(input, 'helmx.input entry should exist')
    assert.equal(kernel.__faux.getPendingResponseCount(), 0)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded rejection matrix: human ownership / stale seq / missing target / invalid guard', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reject-matrix')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({})
    kernel.ownership.markOwnership(conv.id, 'human')
    await assert.rejects(
      kernel.conversations.abortConversationGuarded(conv.id, {}),
      isHelmxError('ownership_conflict', 409),
      'human ownership hard rule',
    )
    await assert.rejects(
      kernel.conversations.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, {}),
      isHelmxError('ownership_conflict', 409),
      'human ownership hard rule (submit)',
    )

    kernel.ownership.markOwnership(conv.id, 'helmx')
    const seq = kernel.conversations.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.conversations.abortConversationGuarded(conv.id, { expectedStateSeq: seq + 100 }),
      isHelmxError('state_seq_conflict', 409),
      'stale watermark CAS',
    )

    await assert.rejects(
      kernel.conversations.abortConversationGuarded(999_999, {}),
      isHelmxError('not_found', 404),
      'missing explicit target must not fall back to default route',
    )
    await assert.rejects(
      kernel.conversations.submitInputGuarded(999_999, 'x', { origin: 'agent' }, {}),
      isHelmxError('not_found', 404),
    )

    await assert.rejects(
      kernel.conversations.abortConversationGuarded(conv.id, { expectedOwnership: 'human' as never }),
      isHelmxError('validation_error', 400),
      'expectedOwnership forbids human',
    )
    await assert.rejects(
      kernel.conversations.abortConversationGuarded(conv.id, { expectedStateSeq: -1 }),
      isHelmxError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit rejects replaceFromEntryId (automation cannot rewrite history)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-no-rewrite')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({})
    kernel.ownership.markOwnership(conv.id, 'helmx')
    await assert.rejects(
      kernel.conversations.submitInputGuarded(conv.id, 'x', { origin: 'agent', replaceFromEntryId: 1 }, {}),
      isHelmxError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 3. Normal human APIs remain unaffected
// ---------------------------------------------------------------------------

test('normal API semantics unchanged: submitInput / abortConversation operate normally under human ownership', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-api-regression')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({})
    // Unmarked ownership defaults to human.
    kernel.__faux.setResponses([fauxAssistantMessage('human answer')])
    const { submissionId } = await kernel.conversations.submitInput(conv.id, 'human question', { origin: 'human' })
    assert.ok(submissionId)
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(await kernel.conversations.getLastAssistantText(conv.id), 'human answer')
    // Human abort on idle conversation: no-op without fabricating settlement or throwing guard error.
    await kernel.conversations.abortConversation(conv.id)
    assert.equal(kernel.conversations.getConversation(conv.id).completionSeq, 1)
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. Per-conversation serial gate: serialized per conversation, non-blocking across conversations
// ---------------------------------------------------------------------------

test('guarded mutation serial gate: serialized within conversation; early failures never poison subsequent calls', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-gate')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({})
    kernel.ownership.markOwnership(conv.id, 'helmx')
    kernel.__faux.setResponses([fauxAssistantMessage('answer 1'), fauxAssistantMessage('answer 2')])

    // Early guarded submit failure (stale watermark 400/409) must never poison the serial gate.
    await assert.rejects(
      kernel.conversations.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, { expectedStateSeq: 1_000_000 }),
      isHelmxError('state_seq_conflict', 409),
    )
    const first = await kernel.conversations.submitInputGuarded(conv.id, 'a', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'helmx' })
    const second = await kernel.conversations.submitInputGuarded(conv.id, 'second', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'helmx' })
    assert.ok(first.submissionId)
    assert.ok(second.submissionId)
    await kernel.conversations.waitForIdle(conv.id)
    const detail = await kernel.conversations.getConversationDetail(conv.id, { limit: 50 })
    const inputs = detail.entries.filter((e) => e.kind === 'helmx.input')
    assert.equal(inputs.length, 2, 'both guarded inputs should be queued')
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 5. Ownership persistence on helmx_conversations.owned_by column (O(1), no JSON doc)
// ---------------------------------------------------------------------------

test('conversation ownership persists on helmx_conversations.owned_by column across restarts without helmx_docs map', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-owned-by-column')
  let convId = 0
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({ title: 'owned-by-col' })
    convId = conv.id
    assert.equal(kernel.ownership.getOwnership(convId), 'human')
    assert.equal(kernel.conversations.listConversations().find((c) => c.id === convId)?.ownedBy, 'human')

    kernel.ownership.markOwnership(convId, 'helmx')
    assert.equal(kernel.ownership.getOwnership(convId), 'helmx')
    assert.equal(kernel.conversations.getConversation(convId).ownedBy, 'helmx')
    assert.equal(kernel.conversations.listConversations().find((c) => c.id === convId)?.ownedBy, 'helmx')
  } finally {
    await kernel.close().catch(() => {})
  }

  // Verify SQLite column directly and confirm legacy helmx_docs key is never written.
  const db = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT owned_by FROM helmx_conversations WHERE id = ?').get(convId) as
      | { owned_by: string }
      | undefined
    assert.equal(row?.owned_by, 'helmx')
    const legacyDoc = db.prepare("SELECT name FROM helmx_plugin_docs WHERE name = 'conversation-ownership'").get()
    assert.equal(legacyDoc, undefined, 'ownership must live on helmx_conversations.owned_by, not helmx_plugin_docs')
  } finally {
    db.close()
  }

  // Reopen runtime and verify ownedBy survives restart and can be flipped back to human.
  const reopened = await openRuntime(dir)
  try {
    assert.equal(reopened.ownership.getOwnership(convId), 'helmx')
    assert.equal(reopened.conversations.listConversations().find((c) => c.id === convId)?.ownedBy, 'helmx')
    reopened.ownership.markOwnership(convId, 'human')
    assert.equal(reopened.ownership.getOwnership(convId), 'human')
    assert.equal(reopened.conversations.listConversations().find((c) => c.id === convId)?.ownedBy, 'human')
  } finally {
    await reopened.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 6. Guarded context maintenance (resetConversationGuarded / compactConversationGuarded)
//    + stale meta preservation + strict markConversationOwnership boundary validation
// ---------------------------------------------------------------------------

test('guarded reset: flipping ownership to human inside await window -> 409 ownership_conflict, SDK reset untouched', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reset-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.conversations.createConversation({ title: 'reset race' })
    kernel.ownership.markOwnership(conv.id, 'helmx')
    kernel.__faux.setResponses([fauxAssistantMessage('before reset')])
    await kernel.conversations.submitInput(conv.id, 'seed turn', { origin: 'agent' })
    await kernel.conversations.waitForIdle(conv.id)
    const seqBefore = kernel.conversations.getConversation(conv.id).stateChangeSeq

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.resetConversationGuarded(
      conv.id,
      { handoff: 'must not land' },
      { expectedOwnership: 'helmx', expectedStateSeq: seqBefore },
    )
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    barrier.release()

    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))
    assert.equal(kernel.conversations.getConversation(conv.id).stateChangeSeq, seqBefore, 'rejected reset must not advance stateChangeSeq')
    const detail = await kernel.conversations.getConversationDetail(conv.id, { limit: 50 })
    assert.ok(!JSON.stringify(detail.entries).includes('must not land'), 'handoff must never reach SDK reset')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded compact: flipping ownership to human inside await window -> 409 ownership_conflict, compaction never enqueued', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-compact-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.conversations.createConversation({ title: 'compact race' })
    kernel.ownership.markOwnership(conv.id, 'helmx')
    const seqBefore = kernel.conversations.getConversation(conv.id).stateChangeSeq

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.compactConversationGuarded(
      conv.id,
      { instructions: 'keep concise' },
      { expectedOwnership: 'helmx', expectedStateSeq: seqBefore },
    )
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    barrier.release()

    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))
    assert.equal(kernel.conversations.getConversation(conv.id).stateChangeSeq, seqBefore, 'rejected compact must not advance stateChangeSeq')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded reset/compact: rejection matrix, redaction, and success path (+1 seq)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-context-matrix')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({ title: 'ctx matrix' })
    const seq0 = kernel.conversations.getConversation(conv.id).stateChangeSeq

    // Default human ownership: omitted guard and explicit guard both reject with 409 ownership_conflict.
    await assert.rejects(
      kernel.conversations.resetConversationGuarded(conv.id, { handoff: 'blocked' }),
      isHelmxError('ownership_conflict', 409),
    )
    await assert.rejects(
      kernel.conversations.compactConversationGuarded(conv.id, { instructions: 'blocked' }),
      isHelmxError('ownership_conflict', 409),
    )
    assert.equal(kernel.conversations.getConversation(conv.id).stateChangeSeq, seq0)

    // Switch to helmx: test stale seq, missing target, invalid guard, invalid opts.
    kernel.ownership.markOwnership(conv.id, 'helmx')
    await assert.rejects(
      kernel.conversations.resetConversationGuarded(conv.id, undefined, { expectedStateSeq: seq0 + 99 }),
      isHelmxError('state_seq_conflict', 409),
    )
    await assert.rejects(
      kernel.conversations.compactConversationGuarded(conv.id, undefined, { expectedStateSeq: seq0 + 99 }),
      isHelmxError('state_seq_conflict', 409),
    )
    await assert.rejects(
      kernel.conversations.resetConversationGuarded(999_999, undefined, {}),
      isHelmxError('not_found', 404),
    )
    await assert.rejects(
      kernel.conversations.compactConversationGuarded(999_999, undefined, {}),
      isHelmxError('not_found', 404),
    )
    await assert.rejects(
      kernel.conversations.resetConversationGuarded(conv.id, undefined, { expectedOwnership: 'bot' as never }),
      isHelmxError('validation_error', 400),
    )
    await assert.rejects(
      kernel.conversations.compactConversationGuarded(conv.id, undefined, { expectedStateSeq: -1 }),
      isHelmxError('validation_error', 400),
    )
    await assert.rejects(
      kernel.conversations.resetConversationGuarded(conv.id, { handoff: 123 as never }, {}),
      isHelmxError('validation_error', 400),
    )
    await assert.rejects(
      kernel.conversations.compactConversationGuarded(conv.id, { instructions: 456 as never }, {}),
      isHelmxError('validation_error', 400),
    )

    // Secret redaction + success path: stateChangeSeq advances by exactly +1.
    kernel.stash.addRedaction('sk-reset-secret-999')
    const resetSummary = await kernel.conversations.resetConversationGuarded(
      conv.id,
      { handoff: 'resume with sk-reset-secret-999' },
      { expectedOwnership: 'helmx', expectedStateSeq: seq0 },
    )
    assert.equal(resetSummary.stateChangeSeq, seq0 + 1)
    assert.equal(resetSummary.ownedBy, 'helmx')
    const afterResetDetail = await kernel.conversations.getConversationDetail(conv.id, { limit: 50 })
    const serializedReset = JSON.stringify(afterResetDetail.entries)
    assert.ok(!serializedReset.includes('sk-reset-secret-999'), 'reset handoff secret must be redacted')

    const compactRes = await kernel.conversations.compactConversationGuarded(
      conv.id,
      { instructions: 'preserve key decisions' },
      { expectedOwnership: 'helmx', expectedStateSeq: seq0 + 1 },
    )
    assert.ok(Number.isSafeInteger(compactRes.taskId) && compactRes.taskId > 0)
    assert.equal(compactRes.conversation.stateChangeSeq, seq0 + 2)
    assert.equal(compactRes.conversation.ownedBy, 'helmx')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('context ops preserve concurrent metadata updates during async SDK reset (no stale snapshot clobber)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-reset-stale-meta')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({ title: 'original title', tags: ['initial'] })
    const harness = (kernel as unknown as { harness: { conversation: ConversationFn } }).harness
    const realConvFn = harness.conversation.bind(harness) as ConversationFn
    let intercepted = false
    harness.conversation = (async (id: never, ctx: unknown) => {
      const handle = (await realConvFn(id, ctx)) as { reset: (...a: unknown[]) => Promise<unknown> } | undefined
      if (!handle || intercepted) return handle
      intercepted = true
      const realReset = handle.reset.bind(handle)
      handle.reset = async (...args: unknown[]) => {
        // Simulate a concurrent metadata edit arriving while SDK reset is awaiting completion.
        await kernel.conversations.updateConversation(conv.id, { title: 'concurrent title', tags: ['updated'] })
        return realReset(...args)
      }
      return handle
    }) as ConversationFn

    const summary = await kernel.conversations.resetConversation(conv.id, { handoff: 'fresh start' })
    assert.equal(summary.title, 'concurrent title', 'concurrent title update must survive reset')
    assert.deepEqual(summary.tags, ['updated'], 'concurrent tags update must survive reset')
    assert.equal(kernel.conversations.getConversation(conv.id).title, 'concurrent title')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('markConversationOwnership rejects legacy/invalid owner values with 400 validation_error (never silently coerces to human)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-ownership-strict-boundary')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.conversations.createConversation({ title: 'strict owner' })
    kernel.ownership.markOwnership(conv.id, 'helmx')
    assert.equal(kernel.ownership.getOwnership(conv.id), 'helmx')

    assert.throws(
      () => kernel.ownership.markOwnership(conv.id, 'bot' as never),
      isHelmxError('validation_error', 400),
      'removed legacy owner "bot" must throw 400 instead of silently coercing to human',
    )
    assert.throws(
      () => kernel.ownership.markOwnership(conv.id, '' as never),
      isHelmxError('validation_error', 400),
    )
    assert.throws(
      () => kernel.ownership.markOwnership(0, 'helmx'),
      isHelmxError('validation_error', 400),
    )
    assert.equal(kernel.ownership.getOwnership(conv.id), 'helmx', 'failed validation must preserve existing ownership')
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 7. Guarded update / withdraw / delete mid-await races + untitled CAS + ownership inheritance
// ---------------------------------------------------------------------------

test('guarded update: flipping ownership to human inside await window -> 409 ownership_conflict, zero config mutation', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-update-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.conversations.createConversation({ title: 'before update', ownedBy: 'helmx' })
    const seqBefore = conv.stateChangeSeq

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.updateConversationGuarded(
      conv.id,
      { title: 'hijacked title', tags: ['bad'] },
      { expectedOwnership: 'helmx', expectedStateSeq: seqBefore },
    )
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    barrier.release()

    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))
    const after = kernel.conversations.getConversation(conv.id)
    assert.equal(after.title, 'before update', 'title must remain untouched on rejected guarded update')
    assert.deepEqual(after.tags, [], 'tags must remain untouched on rejected guarded update')
    assert.equal(after.stateChangeSeq, seqBefore, 'stateChangeSeq must remain untouched')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded update: rejection matrix and success path (+1 seq, ownedBy preserved)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-update-matrix')
  const kernel = await openRuntime(dir)
  try {
    const humanConv = await kernel.conversations.createConversation({ title: 'human conv', ownedBy: 'human' })
    await assert.rejects(
      kernel.conversations.updateConversationGuarded(humanConv.id, { title: 'blocked' }),
      isHelmxError('ownership_conflict', 409),
    )

    const helmxConv = await kernel.conversations.createConversation({ title: 'helmx conv', ownedBy: 'helmx' })
    const seq0 = helmxConv.stateChangeSeq
    await assert.rejects(
      kernel.conversations.updateConversationGuarded(
        helmxConv.id,
        { title: 'stale' },
        { expectedOwnership: 'helmx', expectedStateSeq: seq0 + 5 },
      ),
      isHelmxError('state_seq_conflict', 409),
    )

    const updated = await kernel.conversations.updateConversationGuarded(
      helmxConv.id,
      { title: 'helmx updated', pinned: true },
      { expectedOwnership: 'helmx', expectedStateSeq: seq0 },
    )
    assert.equal(updated.title, 'helmx updated')
    assert.equal(updated.pinned, true)
    assert.equal(updated.ownedBy, 'helmx')
    assert.equal(updated.stateChangeSeq, seq0 + 1)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded withdraw: flipping ownership to human inside await window -> 409 ownership_conflict, queued input stays intact', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-withdraw-race')
  const kernel = await openRuntime(dir)
  let releaseTurn!: () => void
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  let releaseSubBarrier: (() => void) | undefined
  try {
    const conv = await kernel.conversations.createConversation({ title: 'withdraw race', ownedBy: 'helmx' })
    kernel.__faux.setResponses([
      (async () => {
        await turnGate
        return fauxAssistantMessage('first done')
      }) as never,
      fauxAssistantMessage('queued done'),
    ])
    await kernel.conversations.submitInput(conv.id, 'hold turn')
    await waitFor(() => kernel.conversations.getConversation(conv.id).status === 'working')

    const queued = await kernel.conversations.submitInput(conv.id, 'queued follow up', {
      whenBusy: 'followUp',
    })
    const queuedSubId = Number(queued.submissionId)

    // Install a one-shot barrier on harness.submission to deterministically pause inside withdrawQueuedInputGuarded.
    type SubmissionFn = (id: never, ctx: unknown) => Promise<unknown>
    const harness = (kernel as unknown as { harness: { submission: SubmissionFn } }).harness
    const realSubmission = harness.submission.bind(harness) as SubmissionFn
    const subGate = new Promise<void>((resolve) => {
      releaseSubBarrier = resolve
    })
    let pausedOnce = false
    harness.submission = ((id: never, ctx: unknown) => {
      if (pausedOnce) return realSubmission(id, ctx)
      pausedOnce = true
      return new Promise((resolve, reject) => {
        void subGate.then(() => {
          void realSubmission(id, ctx).then(resolve, reject)
        }, reject)
      })
    }) as SubmissionFn

    const attempt = kernel.conversations.withdrawQueuedInputGuarded(
      conv.id,
      { submissionId: queuedSubId },
      { expectedOwnership: 'helmx' },
    )
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    releaseSubBarrier!()

    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))
    // Because withdrawal was blocked, releasing the turn processes the queued follow-up too.
    releaseTurn()
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(await kernel.conversations.getLastAssistantText(conv.id), 'queued done')

    // Success path: helmx-owned conversation withdraws its own queued followUp cleanly.
    const conv2 = await kernel.conversations.createConversation({ title: 'withdraw ok', ownedBy: 'helmx' })
    let releaseTurn2!: () => void
    const turnGate2 = new Promise<void>((resolve) => {
      releaseTurn2 = resolve
    })
    kernel.__faux.setResponses([
      (async () => {
        await turnGate2
        return fauxAssistantMessage('first2 done')
      }) as never,
      fauxAssistantMessage('should never run'),
    ])
    await kernel.conversations.submitInput(conv2.id, 'hold turn 2')
    await waitFor(() => kernel.conversations.getConversation(conv2.id).status === 'working')
    const queued2 = await kernel.conversations.submitInput(conv2.id, 'cancel me', { whenBusy: 'followUp' })
    const withdrawRes = await kernel.conversations.withdrawQueuedInputGuarded(
      conv2.id,
      { submissionId: Number(queued2.submissionId) },
      { expectedOwnership: 'helmx' },
    )
    assert.equal(withdrawRes.status, 'withdrawn')
    releaseTurn2()
    await kernel.conversations.waitForIdle(conv2.id)
    assert.equal(await kernel.conversations.getLastAssistantText(conv2.id), 'first2 done')
  } finally {
    releaseSubBarrier?.()
    releaseTurn()
    await kernel.close().catch(() => {})
  }
})

test('guarded delete: flipping ownership to human inside deleteOneConversation await window -> 409 ownership_conflict, conversation survives', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-delete-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.conversations.createConversation({ title: 'delete race', ownedBy: 'helmx' })
    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.conversations.deleteConversationGuarded(conv.id, {
      expectedOwnership: 'helmx',
      expectedStateSeq: conv.stateChangeSeq,
    })
    await flushToBarrier()
    kernel.ownership.markOwnership(conv.id, 'human')
    barrier.release()

    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))
    const survivor = kernel.conversations.getConversation(conv.id)
    assert.equal(survivor.id, conv.id)
    assert.equal(survivor.ownedBy, 'human')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded submit with expectedStateSeq on untitled conversation succeeds without self-conflict and derives title only after commit', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-untitled-cas')
  const kernel = await openRuntime(dir)
  try {
    // 1. Rejected whenIdle=reject on untitled conversation must leave title empty and seq unchanged.
    const idleUntitled = await kernel.conversations.createConversation({ ownedBy: 'helmx' })
    assert.equal(idleUntitled.title, '')
    const seqIdle = idleUntitled.stateChangeSeq
    await assert.rejects(
      kernel.conversations.submitInputGuarded(
        idleUntitled.id,
        'should reject when idle',
        { origin: 'agent', whenBusy: 'steer', whenIdle: 'reject' },
        { expectedOwnership: 'helmx', expectedStateSeq: seqIdle },
      ),
      isHelmxError('conversation_idle', 409),
    )
    assert.equal(kernel.conversations.getConversation(idleUntitled.id).title, '')
    assert.equal(kernel.conversations.getConversation(idleUntitled.id).stateChangeSeq, seqIdle)

    // 2. Authorized guarded submit with exact expectedStateSeq on untitled conversation commits cleanly and derives title.
    kernel.__faux.setResponses([fauxAssistantMessage('untitled ok')])
    const { submissionId } = await kernel.conversations.submitInputGuarded(
      idleUntitled.id,
      'first automated task',
      { origin: 'agent' },
      { expectedOwnership: 'helmx', expectedStateSeq: seqIdle },
    )
    assert.ok(Number(submissionId) > 0)
    await kernel.conversations.waitForIdle(idleUntitled.id)
    assert.equal(kernel.conversations.getConversation(idleUntitled.id).title, 'first automated task')
    assert.equal(await kernel.conversations.getLastAssistantText(idleUntitled.id), 'untitled ok')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('createConversation and forkConversation inherit parent/source ownership and honor explicit ownedBy', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-create-fork-ownership')
  const kernel = await openRuntime(dir)
  try {
    const helmxParent = await kernel.conversations.createConversation({
      title: 'helmx root',
      ownedBy: 'helmx',
    })
    assert.equal(helmxParent.ownedBy, 'helmx')

    // Child under helmx parent inherits 'helmx' when ownedBy is omitted; explicit 'human' overrides.
    const inheritedChild = await kernel.conversations.createConversation({
      title: 'inherited child',
      parentConversationId: helmxParent.id,
    })
    assert.equal(inheritedChild.ownedBy, 'helmx')
    assert.equal(kernel.ownership.getOwnership(inheritedChild.id), 'helmx')

    const explicitHumanChild = await kernel.conversations.createConversation({
      title: 'explicit human child',
      parentConversationId: helmxParent.id,
      ownedBy: 'human',
    })
    assert.equal(explicitHumanChild.ownedBy, 'human')
    assert.equal(kernel.ownership.getOwnership(explicitHumanChild.id), 'human')

    // Seed completed turns on helmx and human sources so both can be forked cleanly.
    kernel.__faux.setResponses([
      fauxAssistantMessage('helmx seed answer'),
      fauxAssistantMessage('human seed answer'),
    ])
    await kernel.conversations.submitInput(helmxParent.id, 'helmx seed')
    await kernel.conversations.waitForIdle(helmxParent.id)
    const humanSource = await kernel.conversations.createConversation({ title: 'human root' })
    await kernel.conversations.submitInput(humanSource.id, 'human seed')
    await kernel.conversations.waitForIdle(humanSource.id)

    // Fork inherits source ownership by default and returns ownedBy on the summary.
    const forkOfHelmx = await kernel.conversations.forkConversation(helmxParent.id)
    assert.equal(forkOfHelmx.ownedBy, 'helmx')
    assert.equal(kernel.ownership.getOwnership(forkOfHelmx.id), 'helmx')

    const forkOfHuman = await kernel.conversations.forkConversation(humanSource.id)
    assert.equal(forkOfHuman.ownedBy, 'human')
    assert.equal(kernel.ownership.getOwnership(forkOfHuman.id), 'human')

    // Explicit ownedBy overrides inherited ownership on fork; invalid ownedBy rejects with 400.
    const forkHelmxAsHuman = await kernel.conversations.forkConversation(helmxParent.id, {
      title: 'promoted fork',
      ownedBy: 'human',
    })
    assert.equal(forkHelmxAsHuman.ownedBy, 'human')
    assert.equal(kernel.ownership.getOwnership(forkHelmxAsHuman.id), 'human')

    const forkHumanAsHelmx = await kernel.conversations.forkConversation(humanSource.id, {
      title: 'automated fork',
      ownedBy: 'helmx',
    })
    assert.equal(forkHumanAsHelmx.ownedBy, 'helmx')
    assert.equal(kernel.ownership.getOwnership(forkHumanAsHelmx.id), 'helmx')

    await assert.rejects(
      kernel.conversations.forkConversation(humanSource.id, { ownedBy: 'bot' as never }),
      isHelmxError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})
