/**
 * ConversationDetailService async decoupling test (faux host, deterministic):
 * - slow/suspended background contextUsage refresh never blocks `getConversationDetail`
 *   (timeline entries and current summary return immediately);
 * - background usage refresh failures never fail detail reads or leak unhandledRejection;
 * - already-cached contextUsage is included directly in the returned detail;
 * - missing conversation still rejects immediately with 404 without triggering refresh.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import {
  ConversationDetailService,
  MAX_PAGE_TURNS,
  TURN_HARD_ENTRY_CAP,
  TURN_SOFT_ENTRY_BUDGET,
} from '../src/runtime/conversation-detail.js'
import { deferred } from './helpers.js'

interface HostState {
  summary: ConversationSummary
  entries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>
  refreshGate?: ReturnType<typeof deferred<void>>
  refreshError?: Error
  scheduleCalls: number
  ensureCalls: number
}

function summaryOf(id: number, withUsage: boolean): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conversation ${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    lastEntryId: 2,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(withUsage ? { contextUsage: { tokens: 1234 } as never } : {}),
  }
}

function makeService(
  state: HostState,
  opts: { useScheduleHost?: boolean; missingConversation?: boolean } = {},
): ConversationDetailService {
  const fauxConversation = {
    entries: async (_opts: unknown, limit: number, _cursor: unknown) => ({
      items: state.entries.slice(0, limit) as never,
    }),
  }
  return new ConversationDetailService({
    harness: {
      conversation: async () => (opts.missingConversation ? undefined : fauxConversation),
    } as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => state.summary,
    collectRewindIntervals: async () => [],
    ...(opts.useScheduleHost
      ? {
          scheduleContextUsage: () => {
            state.scheduleCalls += 1
          },
        }
      : {
          ensureContextUsage: async () => {
            state.ensureCalls += 1
            if (state.refreshGate !== undefined) {
              await state.refreshGate.promise
            }
            if (state.refreshError !== undefined) {
              throw state.refreshError
            }
            state.summary = summaryOf(state.summary.id, true)
          },
        }),
  })
}

test('async decoupling: suspended background contextUsage never blocks getConversationDetail', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [
      { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer proposal' }] }] },
      { id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'question' } },
    ],
    refreshGate: gate,
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state)

  // Detail returns immediately even while ensureContextUsage stays suspended on `gate`.
  const detail = await service.getConversationDetail(5, { limit: 10 })
  assert.equal(state.ensureCalls, 1, 'background contextUsage refresh should be triggered')
  assert.equal(detail.contextUsage, undefined, 'uncached usage is omitted on immediate return')
  assert.equal(detail.entries.length, 2)
  assert.equal(detail.entries[0]!.kind, 'helmx.input')
  assert.equal(detail.entries[1]!.kind, 'pi.assistant')

  // Once background calculation finishes, cached summary carries contextUsage for subsequent reads / upsert.
  gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  const next = await service.getConversationDetail(5, { limit: 10 })
  assert.deepEqual(next.contextUsage, { tokens: 1234 })
})

test('scheduleContextUsage host port is called fire-and-forget when provided', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(7, true),
    entries: [{ id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'q' } }],
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state, { useScheduleHost: true })
  const detail = await service.getConversationDetail(7, { limit: 10 })
  assert.equal(state.scheduleCalls, 1)
  assert.equal(state.ensureCalls, 0)
  assert.deepEqual(detail.contextUsage, { tokens: 1234 })
})

test('background ensureContextUsage failure does not reject getConversationDetail or leak unhandledRejection', { timeout: 60_000 }, async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const state: HostState = {
      summary: summaryOf(5, false),
      entries: [],
      refreshError: new HelmxError('runtime_closed', 'kernel is closing', 503),
      scheduleCalls: 0,
      ensureCalls: 0,
    }
    const service = makeService(state)
    const detail = await service.getConversationDetail(5, { limit: 10 })
    assert.equal(detail.id, 5)
    assert.equal(state.ensureCalls, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(unhandled.length, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('detail read failure: rejects overall (404 conversation missing) without triggering usage refresh', { timeout: 60_000 }, async () => {
  const state: HostState = {
    summary: summaryOf(5, false),
    entries: [],
    scheduleCalls: 0,
    ensureCalls: 0,
  }
  const service = makeService(state, { missingConversation: true })
  await assert.rejects(
    service.getConversationDetail(5, { limit: 10 }),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  assert.equal(state.ensureCalls, 0)
})

test('Page 1 collects helmx.rewind inline without pre-scan; rewind cache serves Page 2 & getConversationEntry and invalidates on stateChangeSeq/lastEntryId', { timeout: 60_000 }, async () => {
  // Descending entries: 6 (new answer), 5 (rewind [2, 4]), 4..2 (rewound), 1 (original question)
  const allDesc: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }> = [
    { id: 6, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'v2' }] }] },
    { id: 5, kind: 'helmx.rewind', data: { fromEntryId: 2, throughEntryId: 4 } },
    { id: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'stale-4' }] }] },
    { id: 3, kind: 'helmx.input', data: { id: 'i3', text: 'stale-3' } },
    { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'stale-2' }] }] },
    { id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'keep-1' } },
  ]
  let summary = { ...summaryOf(9, true), stateChangeSeq: 3, lastEntryId: 6 }
  let collectRewindCalls = 0

  const fauxConversation = {
    entries: async (
      opts: { order?: string; minEntryId?: number; maxEntryId?: number },
      limit: number,
      cursor?: { offset?: number },
    ) => {
      if (opts.minEntryId !== undefined && opts.maxEntryId !== undefined) {
        const hit = allDesc.find((e) => e.id === opts.minEntryId)
        return { items: hit ? [hit] : [] }
      }
      const start = cursor?.offset ?? 0
      const slice = allDesc.slice(start, start + limit)
      const nextOffset = start + slice.length
      return {
        items: slice,
        ...(nextOffset < allDesc.length ? { next: { offset: nextOffset } } : {}),
      }
    },
  }

  const service = new ConversationDetailService({
    harness: { conversation: async () => fauxConversation } as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => summary,
    collectRewindIntervals: async () => {
      collectRewindCalls += 1
      return [{ from: 2, through: 4, marker: 5 }]
    },
  })

  // 1. Page 1 with limit=2: collects rewind [2, 4] inline, returns visible [5, 6] + nextCursor; ZERO collectRewindIntervals calls
  const page1 = await service.getConversationDetail(9, { limit: 2 })
  assert.equal(collectRewindCalls, 0, 'Page 1 must skip full ascending collectRewindIntervals pre-scan')
  assert.deepEqual(page1.entries.map((e) => e.id), ['5', '6'])
  assert.ok(page1.nextCursor !== undefined)

  // 2. Page 2 uses cursor: misses cache (Page 1 had nextCursor), calls collectRewindIntervals once, caches result
  const page2 = await service.getConversationDetail(9, { limit: 2, cursor: page1.nextCursor })
  assert.equal(collectRewindCalls, 1)
  assert.deepEqual(page2.entries.map((e) => e.id), ['1'])
  assert.equal(page2.nextCursor, undefined)

  // 3. getConversationEntry hits the warm rewind cache (still 1 call): hidden entry 3 returns 404, visible entry 6 succeeds
  await assert.rejects(
    service.getConversationEntry(9, 3),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  const entry6 = await service.getConversationEntry(9, 6)
  assert.equal(entry6.id, '6')
  assert.equal(collectRewindCalls, 1, 'getConversationEntry must reuse cached rewind intervals when (stateChangeSeq, lastEntryId) unchanged')

  // 4. Advancing lastEntryId invalidates cache; full Page 1 (nextCursor === undefined) re-seeds cache without calling collectRewindIntervals
  summary = { ...summary, lastEntryId: 7 }
  const fullPage = await service.getConversationDetail(9, { limit: 10 })
  assert.deepEqual(fullPage.entries.map((e) => e.id), ['1', '5', '6'])
  assert.equal(fullPage.nextCursor, undefined)
  assert.equal(collectRewindCalls, 1, 'full Page 1 scan must not call collectRewindIntervals')

  // Subsequent getConversationEntry reuses cache seeded by full Page 1
  await assert.rejects(
    service.getConversationEntry(9, 4),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  assert.equal(collectRewindCalls, 1, 'full Page 1 scan seeds rewindCache for subsequent getConversationEntry')

  // Advancing stateChangeSeq invalidates cache for direct getConversationEntry
  summary = { ...summary, stateChangeSeq: 4 }
  await assert.rejects(
    service.getConversationEntry(9, 2),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
  )
  assert.equal(collectRewindCalls, 2, 'stateChangeSeq change must invalidate rewindCache')
})

function makeTurnService(
  allAsc: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>,
  opts: {
    id?: number
    collectRewindIntervals?: () => Promise<Array<{ from: number; through: number; marker: number }>>
  } = {},
): {
  service: ConversationDetailService
  scanLog: Array<{ limit: number; after?: number }>
} {
  const id = opts.id ?? 15
  const allDesc = [...allAsc].sort((a, b) => b.id - a.id)
  const scanLog: Array<{ limit: number; after?: number }> = []
  const lastEntryId = allDesc[0]?.id ?? 0
  const summary: ConversationSummary = { ...summaryOf(id, true), lastEntryId }

  const fauxConversation = {
    entries: async (
      query: { order?: string; minEntryId?: number; maxEntryId?: number },
      limit: number,
      cursor?: { after?: number; order?: string },
    ) => {
      if (query.minEntryId !== undefined && query.maxEntryId !== undefined) {
        const hit = allDesc.find((e) => e.id === query.minEntryId)
        return { items: hit ? [hit] : [] }
      }
      scanLog.push({ limit, ...(cursor?.after !== undefined ? { after: cursor.after } : {}) })
      const filtered = cursor?.after !== undefined
        ? allDesc.filter((e) => e.id < cursor.after!)
        : allDesc
      const slice = filtered.slice(0, limit)
      const last = slice.at(-1)
      const hasMore = slice.length < filtered.length
      return {
        items: slice,
        ...(hasMore && last !== undefined ? { next: { after: last.id, order: 'descending' } } : {}),
      }
    },
  }

  const service = new ConversationDetailService({
    harness: { conversation: async () => fauxConversation } as never,
    store: {} as never,
    stash: {} as never,
    getConversation: () => summary,
    collectRewindIntervals:
      opts.collectRewindIntervals ??
      (async () => {
        const cuts: Array<{ from: number; through: number; marker: number }> = []
        for (const e of allAsc) {
          if (e.kind === 'helmx.rewind') {
            const d = e.data as { fromEntryId: number; throughEntryId: number }
            cuts.push({ from: d.fromEntryId, through: d.throughEntryId, marker: e.id })
          }
        }
        return cuts
      }),
  })
  return { service, scanLog }
}

test('pageVisibleTurns: validation rejects out-of-range turns and limit+turns conflict', { timeout: 60_000 }, async () => {
  const { service } = makeTurnService([{ id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'hi' } }])
  await assert.rejects(
    service.getConversationDetail(15, { limit: 10, turns: 1 }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
  for (const badTurns of [0, -1, 1.5, MAX_PAGE_TURNS + 1]) {
    await assert.rejects(
      service.getConversationDetail(15, { turns: badTurns }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )
  }
})

test('pageVisibleTurns: coalesces helmx.input + pi.system + pi.user, handles dividers and trailing compaction', { timeout: 60_000 }, async () => {
  const entries = [
    // Turn 1
    { id: 1, kind: 'helmx.input', data: { id: 'i1', text: 'q1' } },
    { id: 2, kind: 'pi.user', model: [{ role: 'user', content: 'q1' }] },
    { id: 3, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }] },
    // Turn 2 opens with pi.reset and coalesces helmx.input + pi.system + pi.user
    { id: 4, kind: 'pi.reset', model: [{ role: 'user', content: 'handoff' }] },
    { id: 5, kind: 'helmx.input', data: { id: 'i2', text: 'q2' } },
    { id: 6, kind: 'pi.system', model: [{ role: 'system', content: '' }] },
    { id: 7, kind: 'pi.user', model: [{ role: 'user', content: 'q2' }] },
    { id: 8, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] }] },
    { id: 9, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    { id: 10, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'a2' }] }] },
    // Trailing compaction divider after Turn 2
    { id: 11, kind: 'pi.compaction', model: [{ role: 'user', content: 'summary' }] },
  ]
  const { service } = makeTurnService(entries)

  // turns=1 includes trailing compaction (11) + full Turn 2 (4,5,7,8,9,10) with pi.system (6) hidden
  const page1 = await service.getConversationDetail(15, { turns: 1 })
  assert.deepEqual(page1.entries.map((e) => e.id), ['4', '5', '7', '8', '9', '10', '11'])
  assert.ok(page1.nextCursor !== undefined)

  // turns=1 with Page 1 cursor delivers Turn 1 (1,2,3) and ends cleanly
  const page2 = await service.getConversationDetail(15, { turns: 1, cursor: page1.nextCursor })
  assert.deepEqual(page2.entries.map((e) => e.id), ['1', '2', '3'])
  assert.equal(page2.nextCursor, undefined)
})

test('pageVisibleTurns: preserves helmx.rewind markers across turn boundary without breaking inTurnHead', { timeout: 60_000 }, async () => {
  const entries = [
    { id: 1, kind: 'helmx.input', data: { id: 'i1', text: 't1' } },
    { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 't1-ans' }] }] },
    // Rewound span [3, 5] followed by marker 6 right before Turn 2
    { id: 3, kind: 'helmx.input', data: { id: 'i-old', text: 'old' } },
    { id: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'old-ans' }] }] },
    { id: 5, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'old-ans-2' }] }] },
    { id: 6, kind: 'helmx.rewind', data: { fromEntryId: 3, throughEntryId: 5 } },
    { id: 7, kind: 'helmx.input', data: { id: 'i2', text: 't2' } },
    { id: 8, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 't2-ans' }] }] },
  ]
  const { service } = makeTurnService(entries)

  const page1 = await service.getConversationDetail(15, { turns: 1 })
  assert.deepEqual(page1.entries.map((e) => e.id), ['6', '7', '8'])
  assert.ok(page1.nextCursor !== undefined)

  const page2 = await service.getConversationDetail(15, { turns: 1, cursor: page1.nextCursor })
  assert.deepEqual(page2.entries.map((e) => e.id), ['1', '2'])
  assert.equal(page2.nextCursor, undefined)
})

test('pageVisibleTurns: TURN_SOFT_ENTRY_BUDGET stops cleanly after >=1 complete turn without splitting turns', { timeout: 60_000 }, async () => {
  const entries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }> = []
  let seq = 1
  // Turn 1: 30 entries
  entries.push({ id: seq++, kind: 'helmx.input', data: { id: 't1', text: 'turn1' } })
  for (let i = 0; i < 29; i += 1) {
    entries.push({ id: seq++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `t1-${i}` }] }] })
  }
  // Turn 2: 90 entries
  const turn2Start = seq
  entries.push({ id: seq++, kind: 'helmx.input', data: { id: 't2', text: 'turn2' } })
  for (let i = 0; i < 89; i += 1) {
    entries.push({ id: seq++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `t2-${i}` }] }] })
  }
  // Turn 3 (latest): 130 entries (< 200), so Turn 3 + Turn 2 = 220 >= TURN_SOFT_ENTRY_BUDGET (200)
  entries.push({ id: seq++, kind: 'helmx.input', data: { id: 't3', text: 'turn3' } })
  for (let i = 0; i < 129; i += 1) {
    entries.push({ id: seq++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `t3-${i}` }] }] })
  }

  const { service } = makeTurnService(entries)
  const page1 = await service.getConversationDetail(15, { turns: 10 })
  assert.equal(page1.entries.length, 220)
  assert.ok(page1.entries.length >= TURN_SOFT_ENTRY_BUDGET)
  assert.equal(page1.entries[0]!.id, String(turn2Start))
  assert.ok(page1.nextCursor !== undefined)

  const page2 = await service.getConversationDetail(15, { turns: 10, cursor: page1.nextCursor })
  assert.equal(page2.entries.length, 30)
  assert.equal(page2.entries[0]!.id, '1')
  assert.equal(page2.nextCursor, undefined)
})

test('pageVisibleTurns: TURN_HARD_ENTRY_CAP performs bounded 1-displayable-entry lookahead across pi.system/helmx.rewind/rewound spans', { timeout: 60_000 }, async () => {
  // Case A: mega-turn with 500 visible body entries + 25 hidden/rewind entries at the very beginning -> nextCursor must be undefined
  const noOlderEntries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }> = []
  let idA = 1
  for (let i = 0; i < 12; i += 1) {
    noOlderEntries.push({ id: idA++, kind: 'pi.system', model: [{ role: 'system', content: '' }] })
  }
  const rewindFrom = idA
  for (let i = 0; i < 15; i += 1) {
    noOlderEntries.push({ id: idA++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `rewound-${i}` }] }] })
  }
  const rewindThrough = idA - 1
  noOlderEntries.push({ id: idA++, kind: 'helmx.rewind', data: { fromEntryId: rewindFrom, throughEntryId: rewindThrough } })
  // 499 more assistant entries -> total collected = 1 (rewind marker) + 499 = 500 (TURN_HARD_ENTRY_CAP)
  for (let i = 0; i < TURN_HARD_ENTRY_CAP - 1; i += 1) {
    noOlderEntries.push({ id: idA++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `body-${i}` }] }] })
  }
  const svcA = makeTurnService(noOlderEntries)
  const resA = await svcA.service.getConversationDetail(15, { turns: 1 })
  assert.equal(resA.entries.length, TURN_HARD_ENTRY_CAP)
  assert.equal(resA.nextCursor, undefined, 'lookahead across >20 non-displayable entries must return undefined nextCursor')
  assert.ok(svcA.scanLog.some((call) => call.limit === 20), 'lookahead should scan subsequent batches of 20')

  // Case B: 1 older displayable entry sits behind pi.system + helmx.rewind + rewound span right after TURN_HARD_ENTRY_CAP
  const withOlderEntries: Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }> = [
    { id: 1, kind: 'helmx.input', data: { id: 'root', text: 'mega prompt' } },
  ]
  let idB = 2
  for (let i = 0; i < 10; i += 1) {
    withOlderEntries.push({ id: idB++, kind: 'pi.system', model: [{ role: 'system', content: '' }] })
  }
  const rwFrom = idB
  for (let i = 0; i < 15; i += 1) {
    withOlderEntries.push({ id: idB++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `rw-${i}` }] }] })
  }
  const rwThrough = idB - 1
  const rwMarkerId = idB++
  withOlderEntries.push({ id: rwMarkerId, kind: 'helmx.rewind', data: { fromEntryId: rwFrom, throughEntryId: rwThrough } })
  for (let i = 0; i < TURN_HARD_ENTRY_CAP; i += 1) {
    withOlderEntries.push({ id: idB++, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: `step-${i}` }] }] })
  }
  const svcB = makeTurnService(withOlderEntries)
  const page1B = await svcB.service.getConversationDetail(15, { turns: 1 })
  assert.equal(page1B.entries.length, TURN_HARD_ENTRY_CAP)
  assert.ok(page1B.nextCursor !== undefined, 'lookahead must surface nextCursor past hidden/rewind span')

  const page2B = await svcB.service.getConversationDetail(15, { turns: 1, cursor: page1B.nextCursor })
  assert.deepEqual(
    page2B.entries.map((e) => e.id),
    ['1', String(rwMarkerId)],
    'next page must preserve helmx.rewind marker alongside older displayable entry while hiding rewound/system entries',
  )
  assert.equal(page2B.nextCursor, undefined)
})
