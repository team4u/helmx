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
import { ConversationDetailService } from '../src/runtime/conversation-detail.js'
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
