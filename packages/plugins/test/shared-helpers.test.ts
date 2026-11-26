import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmxError, type ConversationSummary, type PluginKvHandle } from '@helmx/protocol'
import { makeConversationSummary } from './helpers/plugin-test-env.js'
import {
  asConversationEntryEvent,
  asDeletedConversationId,
  createKeyedQueue,
  errorMessageOf,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  isConversationNotFoundError,
  isTopLevelHumanConversation,
  listAllKvEntries,
  reportPluginError,
  resolveTargetConversationId,
} from '../src/shared-helpers.js'

const sampleConv = (overrides: Partial<ConversationSummary> = {}): ConversationSummary =>
  makeConversationSummary({ id: 1, title: 'test', ...overrides })

test('resolveTargetConversationId resolves explicit/context and rejects conflicts or missing', { timeout: 60_000 }, () => {
  assert.equal(resolveTargetConversationId(5, {}), 5)
  assert.equal(resolveTargetConversationId(undefined, { conversationId: 9 }), 9)
  assert.equal(resolveTargetConversationId(9, { conversationId: 9 }), 9)

  assert.throws(
    () => resolveTargetConversationId(5, { conversationId: 9 }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
  assert.throws(
    () => resolveTargetConversationId(undefined, {}),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
  )
})

test('asDeletedConversationId strictly requires type === "conversation.deleted" and positive int', { timeout: 60_000 }, () => {
  assert.equal(asDeletedConversationId({ type: 'conversation.deleted', conversationId: 42 }), 42)
  assert.equal(asDeletedConversationId({ conversationId: 42 }), undefined)
  assert.equal(asDeletedConversationId({ type: 'conversation.upsert', conversationId: 42 }), undefined)
  assert.equal(asDeletedConversationId({ type: 'conversation.deleted', conversationId: 0 }), undefined)
  assert.equal(asDeletedConversationId({ type: 'conversation.deleted', conversationId: -1 }), undefined)
  assert.equal(asDeletedConversationId({ type: 'conversation.deleted', conversationId: 1.5 }), undefined)
})

test('asConversationEntryEvent strictly validates conversation.entry payload', { timeout: 60_000 }, () => {
  assert.deepEqual(
    asConversationEntryEvent({
      type: 'conversation.entry',
      conversationId: 7,
      entry: { kind: 'pi.assistant' },
    }),
    { conversationId: 7, kind: 'pi.assistant' },
  )
  assert.equal(asConversationEntryEvent({ conversationId: 7, entry: { kind: 'pi.assistant' } }), undefined)
  assert.equal(asConversationEntryEvent({ type: 'conversation.entry', conversationId: 7, entry: { kind: '' } }), undefined)
  assert.equal(asConversationEntryEvent({ type: 'conversation.entry', conversationId: 0, entry: { kind: 'x' } }), undefined)
})

test('getConversationOrUndefined & ignoreConversationNotFound accept both status=404 and code=not_found', { timeout: 60_000 }, async () => {
  const byStatus = new HelmxError('missing', 'missing', 404)
  const byCode = new HelmxError('not_found', 'missing', 500)
  const unexpected = new HelmxError('internal', 'boom', 500)

  assert.equal(getConversationOrUndefined(() => { throw byStatus }, 1), undefined)
  assert.equal(getConversationOrUndefined(() => { throw byCode }, 1), undefined)
  assert.equal(getConversationOrUndefined(() => sampleConv({ id: 3 }), 0), undefined)
  assert.equal(getConversationOrUndefined({ getConversation: (id) => sampleConv({ id }) }, 3)?.id, 3)
  assert.throws(() => getConversationOrUndefined(() => { throw unexpected }, 1), unexpected)

  assert.equal(ignoreConversationNotFound(() => { throw byStatus }), undefined)
  assert.equal(ignoreConversationNotFound(() => { throw byCode }), undefined)
  assert.equal(ignoreConversationNotFound(() => 123), 123)
  assert.throws(() => ignoreConversationNotFound(() => { throw unexpected }), unexpected)

  assert.equal(await ignoreConversationNotFound(Promise.reject(byCode)), undefined)
  assert.equal(await ignoreConversationNotFound(async () => { throw byStatus }), undefined)
  assert.equal(await ignoreConversationNotFound(async () => 'ok'), 'ok')
  await assert.rejects(ignoreConversationNotFound(Promise.reject(unexpected)), unexpected)
  assert.equal(isConversationNotFoundError(byCode), true)
  assert.equal(isConversationNotFoundError(unexpected), false)
})

test('listAllKvEntries terminates safely when backend returns repeated or cycling cursors', { timeout: 60_000 }, () => {
  const kvSameCursor: PluginKvHandle<string> = {
    get: () => undefined,
    set: () => {},
    delete: () => false,
    clear: () => {},
    flush: async () => {},
    list: () => ({
      items: [{ key: 'a', value: 'va', updatedAt: 1 }],
      nextCursor: 'stuck',
    }),
  }
  assert.deepEqual(listAllKvEntries(kvSameCursor), [
    { key: 'a', value: 'va' },
    { key: 'a', value: 'va' },
  ])

  let calls = 0
  const kvCycleCursor: PluginKvHandle<number> = {
    get: () => undefined,
    set: () => {},
    delete: () => false,
    clear: () => {},
    flush: async () => {},
    list: (opts) => {
      calls += 1
      if (opts?.cursor === undefined) return { items: [{ key: '1', value: 1, updatedAt: 1 }], nextCursor: 'c1' }
      if (opts.cursor === 'c1') return { items: [{ key: '2', value: 2, updatedAt: 1 }], nextCursor: 'c2' }
      return { items: [{ key: '3', value: 3, updatedAt: 1 }], nextCursor: 'c1' }
    },
  }
  assert.deepEqual(listAllKvEntries(kvCycleCursor), [
    { key: '1', value: 1 },
    { key: '2', value: 2 },
    { key: '3', value: 3 },
  ])
  assert.equal(calls, 3)
})

test('createKeyedQueue serializes same key FIFO, runs distinct keys concurrently, and drains', { timeout: 60_000 }, async () => {
  const queue = createKeyedQueue<number>()
  const log: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((r) => { releaseFirst = r })

  const p1 = queue.enqueue(1, async () => {
    log.push('1a:start')
    await firstGate
    log.push('1a:end')
    return 'a'
  })
  const p2 = queue.enqueue(1, async () => {
    log.push('1b')
    return 'b'
  })
  const p3 = queue.enqueue(2, async () => {
    log.push('2a')
    return 'c'
  })

  await p3
  assert.deepEqual(log, ['1a:start', '2a'])
  releaseFirst()
  assert.equal(await p1, 'a')
  assert.equal(await p2, 'b')
  assert.deepEqual(log, ['1a:start', '2a', '1a:end', '1b'])

  let drained = false
  void queue.enqueue(3, async () => {
    await new Promise((r) => setTimeout(r, 10))
    drained = true
  })
  await queue.drain()
  assert.equal(drained, true)
})

test('isTopLevelHumanConversation checks undefined parent and human ownership', { timeout: 60_000 }, () => {
  assert.equal(isTopLevelHumanConversation(undefined), false)
  assert.equal(isTopLevelHumanConversation(sampleConv()), true)
  assert.equal(isTopLevelHumanConversation(sampleConv({ ownedBy: 'human' })), true)
  assert.equal(isTopLevelHumanConversation(sampleConv({ ownedBy: 'helmx' })), false)
  assert.equal(isTopLevelHumanConversation(sampleConv({ parentConversationId: 99 })), false)
})

test('reportPluginError redacts title and detail before notification emission and swallows emit errors', { timeout: 60_000 }, () => {
  const emitted: Array<{ type: string; payload: unknown }> = []
  const redact = (s: string) => s.replace(/sk-secret/g, '[REDACTED]')
  const msg = reportPluginError(
    {
      redact,
      emitEvent: (type: string, payload: unknown) => {
        emitted.push({ type, payload })
      },
    },
    {
      logTag: 'test-plugin',
      title: 'job sk-secret failed',
      detail: new Error('token sk-secret leaked'),
      bodyPrefix: '[test]',
      log: false,
    },
  )
  assert.equal(msg, 'token [REDACTED] leaked')
  assert.deepEqual(emitted, [
    {
      type: 'notification',
      payload: {
        type: 'notification',
        level: 'error',
        title: 'job [REDACTED] failed',
        body: '[test] job [REDACTED] failed：token [REDACTED] leaked',
      },
    },
  ])

  assert.equal(errorMessageOf(new Error('err-msg')), 'err-msg')
  assert.equal(errorMessageOf('plain-str'), 'plain-str')
  assert.doesNotThrow(() =>
    reportPluginError(
      {
        redact,
        emitEvent: () => { throw new Error('sse closed sk-secret') },
      },
      { title: 't', detail: 'sk-secret', log: false },
    ),
  )
})
