/**
 * HelmxStore durability tests: real temporary SQLite + real `NodeSqliteDatabase` adapter.
 * Fault injection via wrapping adapter `run`/`exec` only (fixture injects errors without mocking data).
 * Covers: honest flush failures (never faking success, rejecting new writes after errors, close awaiting in-flight),
 * Ask terminal state restart consistency, FTS dedup / title propagation / search pre-flush, atomic delete without
 * resurrection on restart, sequence monotonicity, JSON corruption errors.
 */

import { HelmxError, type SearchHit } from '@helmx/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FTS_SCHEMA_VERSION, FTS_SCHEMA_VERSION_KEY, openHelmxDatabase, type HelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore, convStatusOf, summaryOf, type ConvMeta } from '../src/runtime/store.js'
import {
  MAX_SEARCH_QUERY_CHARS,
  MAX_SEARCH_TERMS,
  buildSearchSnippet,
} from '../src/runtime/fts-search.js'
import { deferred } from './helpers.js'

async function openStore(): Promise<{ store: HelmxStore; database: HelmxDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'helmx-store-test-'))
  return { dir, ...await openStoreAt(dir) }
}

/** Single-shot fault injection hook attached to an already-open `database.db` (error injection only, no synthetic data). */
function attachFaults(database: HelmxDatabase): { failNext(substr: string, error?: Error): void } {
  const realDb = database.db as unknown as Record<string, unknown> & { __faultHook?: FaultHook }
  if (!realDb.__faultHook) {
    realDb.__faultHook = { substr: '', armed: false, error: new Error('injected SQL failure') }
    for (const prop of ['run', 'exec'] as const) {
      const orig = realDb[prop] as (sql: string, ...params: unknown[]) => Promise<unknown>
      realDb[prop] = (sql: string, ...params: unknown[]) => {
        const h = realDb.__faultHook as FaultHook
        if (h.armed && sql.includes(h.substr)) {
          h.armed = false
          return Promise.reject(h.error)
        }
        return orig.call(realDb, sql, ...params)
      }
    }
    // `transaction` allocates handles independently on `db`: wrap `run`/`exec` inside transaction handles too.
    const origTx = database.db.transaction.bind(database.db)
    realDb['transaction'] = <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      origTx((tx: unknown) => {
        const wrappedTx = new Proxy(tx as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, target)
            if (prop === 'run' || prop === 'exec') {
              return (sql: string, ...params: unknown[]) => {
                const h = realDb.__faultHook as FaultHook
                if (h.armed && sql.includes(h.substr)) {
                  h.armed = false
                  return Promise.reject(h.error)
                }
                return (value as (sql: string, ...params: unknown[]) => Promise<unknown>).apply(
                  target,
                  [sql, ...params],
                )
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return cb(wrappedTx)
      })
  }
  return {
    failNext(substr: string, error?: Error) {
      const h = realDb.__faultHook as FaultHook
      h.substr = substr
      h.armed = true
      if (error) h.error = error
    },
  }
}

interface FaultHook {
  substr: string
  armed: boolean
  error: Error
}

function conv(id: number, overrides: Partial<ConvMeta> = {}): ConvMeta {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: ['a'],
    parentConversationId: undefined,
    nodeId: 'local',
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    runDurationMs: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** Fixed parent tool call ID used for link table tests. */
const parentToolId = 'call-tool-3001'

describe('HelmxStore durability layer (real SQLite)', { timeout: 60_000 }, () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helmx-store-suite-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flushPublic awaits real drain: writes are immediately readable in a reopened store', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'drain-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(7, { title: 'drain-me' }))
    store.putPluginDoc('p', 'k', '{"v":1}')
    await store.flushPublic() // Must not return early: persisted on disk right now
    await database.close()
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(7)?.title, 'drain-me')
    assert.equal(reopened.store.getPluginDoc('p', 'k'), '{"v":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deleteGlobalPluginDocs: exact prefix purge (colon-bearing IDs and kernel keys untouched, no restart resurrection)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-doc-'))
    const { store, database } = await openStoreAt(base)
    // Simulate createGlobalDocumentStore layout: global docs stored under __global with name = `${pluginId}:${doc}`
    store.putPluginDoc('__global', 'foo:records', '{"n":1}')
    store.putPluginDoc('__global', 'foo:cfg', '{"n":2}')
    store.putPluginDoc('__global', 'foo:bar:records', '{"n":3}') // Plugin foo:bar's data must not be harmed by deleting foo
    store.putPluginDoc('__global', 'conversation-ownership', '{}') // Kernel metadata (no colon); belongs to no plugin
    store.putPluginDoc('__global', 'other:records', '{"n":4}')
    await store.flushPublic()

    store.deleteGlobalPluginDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:cfg'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), '{"n":3}', 'colon-bearing plugin ID data must not be cross-deleted')
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}', 'colonless kernel metadata must stay untouched')
    assert.equal(store.getPluginDoc('__global', 'other:records'), '{"n":4}')

    // Deleting colon-bearing ID foo:bar cleans its data while leaving others intact
    store.deleteGlobalPluginDocs('foo:bar')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}')
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:records'), undefined, 'must not reappear after restart')
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(reopened.store.getPluginDoc('__global', 'other:records'), '{"n":4}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deletePluginSessionDocs: deletes all session docs for plugin (others preserved, no resurrection)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-session-'))
    const { store, database } = await openStoreAt(base)
    store.putPluginSessionDoc('foo', 'runs', 1, '{"a":1}')
    store.putPluginSessionDoc('foo', 'runs', 2, '{"a":2}')
    store.putPluginDoc('__global', 'unused', '{}') // keep clean
    store.putPluginSessionDoc('foo', 'notes', 1, '{"b":1}')
    store.putPluginSessionDoc('foobar', 'runs', 1, '{"c":1}') // Prefix-adjacent plugin must not be deleted
    await store.flushPublic()

    store.deletePluginSessionDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 2), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'notes', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}', 'prefix-adjacent plugin must not be deleted')
    assert.deepEqual(store.listPluginSessionDocConversations('foo', 'runs'), [])
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginSessionDoc('foo', 'runs', 1), undefined, 'must not reappear after restart')
    assert.equal(reopened.store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('SQL failure: flushPublic throws explicitly (never fakes success) and subsequent writes reject', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fail-'))
    const { store, database } = await openStoreAt(base)
    const fixture = attachFaults(database)
    fixture.failNext('INSERT INTO helmx_conversations')
    store.upsertConv(conv(8))
    await assert.rejects(() => store.flushPublic(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    // New writes after failure must be rejected (failed state cannot keep faking success).
    assert.throws(() => store.upsertConv(conv(9)), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    assert.throws(() => store.putPluginDoc('p', 'k', '{}'), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      return true
    })
    // close() also surfaces the error (used by runtime to throw HelmxError).
    const closeError = await store.close()
    assert.ok(closeError !== undefined)
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('close awaits in-flight flush completion (tail chain drops no writes)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'close-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(10))
    store.indexFts(10, 'entry:1', 't', 'body text')
    const closing = store.close() // Do not await first: close runs concurrently with in-flight write
    await closing
    await database.close()
    // Reopening after close returns must observe the flushed writes (close didn't exit early).
    const reopened = await openStoreAt(base)
    assert.ok(reopened.store.getConv(10))
    const hits = await reopened.store.search('body')
    assert.equal(hits.length, 1)
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('Ask terminal state restart consistency: settled status/spec/result never revert to pending', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'ask-'))
    const { store, database } = await openStoreAt(base)
    store.putAsk({
      id: 'ask-1',
      conversationId: 3,
      specJson: JSON.stringify({ id: 'ask-1', title: 't', status: 'pending', fields: [] }),
      status: 'pending',
      createdAt: 100,
    })
    await store.flushPublic()
    // Settlement: spec contains terminal status; UPSERT must persist spec back to DB too.
    const settledSpec = JSON.stringify({ id: 'ask-1', title: 't', status: 'answered', fields: [] })
    store.putAsk({
      id: 'ask-1',
      conversationId: 3,
      specJson: settledSpec,
      status: 'answered',
      resultJson: JSON.stringify({ name: 'v' }),
      createdAt: 100,
      settledAt: 200,
    })
    await store.flushPublic()
    await store.close()
    await database.close()
    const reopened = await openStoreAt(base)
    const row = reopened.store.getAsk('ask-1')
    assert.ok(row)
    assert.equal(row.status, 'answered')
    assert.equal(row.specJson, settledSpec) // Spec remains in terminal state after restart, not pending
    assert.equal(row.resultJson, JSON.stringify({ name: 'v' }))
    assert.equal(row.settledAt, 200)
    const pending = reopened.store.listAsks('pending')
    assert.equal(pending.filter((a) => a.id === 'ask-1').length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS: repeated entry indexing dedups to one row; title updates refresh all rows; search pre-flushes', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(5, { title: 'old-title' }))
    // Re-index same entry repeatedly (observer replay scenario).
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:2', 'old-title', 'beta gamma')
    let hits = await store.search('hello') // search internally awaits flushPublic first
    assert.equal(hits.length, 1, 'same entry must have at most one index row')
    assert.equal(hits[0]?.entryId, 'entry:1')
    // Title change updates all FTS rows for that conversation (not just one).
    store.upsertConv(conv(5, { title: 'new-title', updatedAt: 2000 }))
    await store.flushPublic()
    const titleRows = await database.db.all<{ title: string; entry_id: string }>(
      'SELECT title, entry_id FROM helmx_conversation_fts WHERE conversation_id = 5',
    )
    assert.equal(titleRows.length, 2)
    for (const r of titleRows) assert.equal(r.title, 'new-title')
    hits = await store.search('beta')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.entryId, 'entry:2')
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS atomic rebuild: failure rolls back preserving previous index (never fakes success)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'rebuild-'))
    const { store, database } = await openStoreAt(base)
    store.indexFts(6, 'entry:1', 't', 'original content')
    await store.flushPublic()
    const fixture = attachFaults(database)
    fixture.failNext('DELETE FROM helmx_conversation_fts')
    await assert.rejects(
      () =>
        store.rebuildFts(async () => {
          /* replay */
        }),
      /injected/,
    )
    // Rollback preserves previous index (derived index is never dropped on rebuild failure).
    const hits = await store.search('original')
    assert.equal(hits.length, 1)
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('delete conversation: does not resurrect on restart (atomic tombstone + row cleanup), no leftover asks/artifacts', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'del-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(11, { title: 'to-delete' }))
    store.putAsk({
      id: 'ask-del',
      conversationId: 11,
      specJson: JSON.stringify({ id: 'ask-del', status: 'pending', fields: [] }),
      status: 'pending',
      createdAt: 50,
    })
    store.putArtifact({
      id: 'art-del',
      conversationId: 11,
      kind: 'upload',
      name: 'n',
      path: '/tmp/x',
      mimeType: 'text/plain',
      size: 1,
      createdAt: 50,
    })
    store.indexFts(11, 'entry:1', 'to-delete', 'findme deleted conv')
    await store.flushPublic()
    store.deleteConv(11)
    await store.flushPublic()
    assert.equal(store.getConv(11), undefined)
    assert.equal(store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal(store.listArtifacts(11).length, 0)
    assert.ok(store.isDeleted(11))
    await store.close()
    await database.close()
    // Restart: does not resurrect.
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(11), undefined)
    assert.ok(reopened.store.isDeleted(11))
    assert.equal(reopened.store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal((await reopened.store.search('findme')).length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('event sequence monotonicity: rejects negative/non-integer values and never regresses high watermark', { timeout: 60_000 }, async () => {
    const { store, database, dir: d } = await openStore()
    try {
      store.setEventSeq(10)
      store.setEventSeq(9) // Regression: in-memory watermark stays at 10
      assert.equal(store.eventSeqNow, 10)
      assert.throws(() => store.setEventSeq(-1), HelmxError)
      assert.throws(() => store.setEventSeq(1.5), HelmxError)
      await store.flushPublic()
      const row = await database.db.get<{ value: number }>(
        "SELECT value FROM helmx_seq WHERE key = 'events'",
      )
      assert.equal(row?.value, 10)
      await store.close()
      await database.close()
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('returned objects are cloned: external mutations do not corrupt mirror or queued SQL', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'clone-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(12, { tags: ['orig'] }))
    // Clone on read.
    const got = store.getConv(12)
    assert.ok(got)
    got.tags.push('mutated')
    assert.deepEqual(store.getConv(12)?.tags, ['orig'])
    // Snapshot on write: mutating caller object after enqueuing does not alter SQL persistence.
    const mutated = conv(13, { tags: ['before'] })
    store.upsertConv(mutated)
    mutated.tags.push('after-mutation')
    await store.flushPublic()
    const row = await database.db.get<{ tags: string }>(
      'SELECT tags FROM helmx_conversations WHERE id = 13',
    )
    assert.deepEqual(JSON.parse(row!.tags), ['before'])
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('putPluginDoc rejects invalid JSON explicitly; load fails explicitly on corrupted JSON', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'json-'))
    const { store, database } = await openStoreAt(base)
    assert.throws(() => store.putPluginDoc('p', 'bad', '{not-json'), HelmxError)
    await store.flushPublic()
    await store.close()
    await database.close()
    // Inject corrupt data directly and reload: must fail explicitly without silent null/empty fallback.
    const db2 = await openHelmxDatabase(base)
    await db2.db.run("INSERT INTO helmx_plugin_docs (plugin_id, name, value, updated_at) VALUES ('x', 'y', '{broken', 0)")
    await db2.close()
    const db3 = await openHelmxDatabase(base)
    const store3 = new HelmxStore(db3)
    await assert.rejects(() => store3.load(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await db3.close()
    await rm(base, { recursive: true, force: true })
  })

  it('convStatusOf: blocked (pending Ask) takes precedence over working', { timeout: 60_000 }, () => {
    const meta = conv(1)
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 1), 'blocked')
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 0), 'working')
    assert.equal(convStatusOf(meta, { runFailure: { id: 'f' } }, 0), 'error')
    assert.equal(convStatusOf(meta, {}, 0), 'idle')
    assert.equal(convStatusOf({ ...meta, unread: true }, {}, 0), 'done')
  })

  it('database.close is idempotent: repeated close never throws', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'idem-'))
    const { database } = await openStoreAt(base)
    await database.close()
    await database.close() // must not throw
    await rm(base, { recursive: true, force: true })
  })

  it('parentToolCallId column on helmx_conversations: read/write/clear/delete persist cleanly without separate link table', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'link-'))
    const { store, database } = await openStoreAt(base)
    const linkTable = await database.db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'helmx_conversation_tool_links'",
    )
    assert.equal(linkTable, undefined, 'helmx_conversation_tool_links table must not exist')

    // When set: persisted to both mirror and helmx_conversations.parent_tool_call_id
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    await store.flushPublic()
    const row = await database.db.get<{ parent_tool_call_id: string | null }>(
      'SELECT parent_tool_call_id FROM helmx_conversations WHERE id = 20',
    )
    assert.equal(row?.parent_tool_call_id, parentToolId)
    // Cleared value sets column to NULL without leaving stale correlations
    store.upsertConv(conv(20, { parentToolCallId: undefined }))
    await store.flushPublic()
    const cleared = await database.db.get<{ parent_tool_call_id: string | null }>(
      'SELECT parent_tool_call_id FROM helmx_conversations WHERE id = 20',
    )
    assert.equal(cleared?.parent_tool_call_id, null, 'cleared value must reset parent_tool_call_id to NULL')
    // Re-writing and reopening restores column cleanly
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    store.upsertConv(conv(21))
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(20)?.parentToolCallId, parentToolId)
    assert.equal(reopened.store.getConv(21)?.parentToolCallId, undefined)
    // Deleting conversation removes the row cleanly
    reopened.store.deleteConv(20)
    await reopened.store.flushPublic()
    const gone = await reopened.database.db.get(
      'SELECT 1 AS x FROM helmx_conversations WHERE id = 20',
    )
    assert.equal(gone, undefined, 'deleting conversation must remove its row')
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('helmx_artifacts persists and restores kinds; invalid kinds fail at write and load boundaries', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'art-kind-'))
    const { store, database } = await openStoreAt(base)
    store.putArtifact({
      id: 'art-up',
      conversationId: 1,
      kind: 'upload',
      name: 'u.txt',
      path: 'artifacts/1/u.txt',
      mimeType: 'text/plain',
      size: 1,
      createdAt: 10,
    })
    store.putArtifact({
      id: 'art-reg',
      conversationId: 1,
      kind: 'registered',
      name: 'r.txt',
      path: 'artifacts/1/r.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: 20,
    })
    store.putArtifact({
      id: 'art-sp',
      conversationId: 1,
      kind: 'spill',
      name: 's.txt',
      path: 'artifacts/1/s.txt',
      mimeType: 'text/plain',
      size: 3,
      createdAt: 30,
    })
    assert.throws(
      () => store.putArtifact({
        id: 'art-bad',
        conversationId: 1,
        kind: 'bogus' as never,
        name: 'b.txt',
        path: 'artifacts/1/b.txt',
        mimeType: 'text/plain',
        size: 1,
        createdAt: 40,
      }),
      HelmxError,
    )
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.deepEqual(
      reopened.store.listArtifacts(1).map((a) => [a.id, a.kind]),
      [
        ['art-up', 'upload'],
        ['art-reg', 'registered'],
        ['art-sp', 'spill'],
      ],
    )
    await reopened.store.close()
    await reopened.database.close()

    // Corrupt kind in store: load() must fail explicitly with store_data_corrupted
    const dbCorrupt = await openHelmxDatabase(base)
    await dbCorrupt.db.run(
      "INSERT INTO helmx_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at) VALUES ('art-corrupt', 1, 'bad_kind', 'x', 'artifacts/1/x', 'text/plain', 1, 50)",
    )
    await dbCorrupt.close()
    const dbReopen = await openHelmxDatabase(base)
    const storeCorrupt = new HelmxStore(dbReopen)
    await assert.rejects(() => storeCorrupt.load(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await dbReopen.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS Chinese trigram, <3-char short queries, mixed AND, cross-column AND, and injection safety', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-cn-'))
    const { store, database } = await openStoreAt(base)
    try {
      store.upsertConv(conv(1, { title: '数据库架构设计' }))
      store.upsertConv(conv(2, { title: '前端排障记录' }))
      store.upsertConv(conv(3, { title: 'AI 鉴权笔记' }))
      store.upsertConv(conv(4, { title: 'Special Punctuation' }))

      store.indexFts(1, 'entry:1', '数据库架构设计', '我们使用 SQLite WAL 模式与数据库连接池配置来优化查询。')
      store.indexFts(1, 'entry:2', '数据库架构设计', '登录接口在数据库连接异常时会触发重试。')
      store.indexFts(2, 'entry:1', '前端排障记录', '登录页面偶发白屏，排查缓存刷新与路由焦点。')
      store.indexFts(3, 'entry:1', 'AI 鉴权笔记', '确认 API 令牌走 SecretStash，不落库。')
      store.indexFts(
        4,
        'entry:1',
        'Special Punctuation',
        'Check foo_bar 100% "quoted" a*b [REDACTED] and NOT OR title:foo literally.',
      )

      // 3+ char Chinese substring match via trigram MATCH (fails under legacy unicode61).
      const connPoolHits = await store.search('连接池')
      assert.equal(connPoolHits.length, 1)
      assert.equal(connPoolHits[0]?.conversationId, 1)
      assert.equal(connPoolHits[0]?.title, '数据库架构设计')
      assertValidHighlights(connPoolHits[0]!, ['连接池'])

      // 2-char & 1-char Chinese / ASCII short queries via honest instr(lower(...)) scan.
      const loginHits = await store.search('登录')
      assert.equal(loginHits.length, 2)
      for (const hit of loginHits) assertValidHighlights(hit, ['登录'])

      const singleCn = await store.search('白')
      assert.equal(singleCn.length, 1)
      assert.equal(singleCn[0]?.conversationId, 2)
      assertValidHighlights(singleCn[0]!, ['白'])

      const shortEn = await store.search('ai')
      assert.equal(shortEn.length, 1)
      assert.equal(shortEn[0]?.conversationId, 3)
      assert.equal(shortEn[0]?.title, 'AI 鉴权笔记')
      // Match is only in title, not in body -> omit entryId (conversation-level nav) and return explicit [].
      assert.equal(shortEn[0]?.entryId, undefined)
      assert.deepEqual(shortEn[0]?.highlights, [])

      // Mixed query (>=3 char + <3 char): MUST enforce the <3 term (regression: trigram MATCH silently ignores <3 phrases).
      const mixedMatch = await store.search('数据库 登录')
      assert.equal(mixedMatch.length, 1)
      assert.equal(mixedMatch[0]?.conversationId, 1)
      assert.equal(mixedMatch[0]?.entryId, 'entry:2')
      assertValidHighlights(mixedMatch[0]!, ['数据库', '登录'])

      const mixedMiss = await store.search('数据库 绝无')
      assert.equal(mixedMiss.length, 0, 'absent 2-char term in mixed query must not be silently ignored')

      // Multi-word AND semantics: entries matching only one word must be excluded.
      const multiAnd = await store.search('连接池 白屏')
      assert.equal(multiAnd.length, 0)

      // Cross-column AND: first term in title + second term in body.
      const crossCol = await store.search('架构 重试')
      assert.equal(crossCol.length, 1)
      assert.equal(crossCol[0]?.conversationId, 1)
      assert.equal(crossCol[0]?.entryId, 'entry:2')
      assertValidHighlights(crossCol[0]!, ['重试'])

      // Special FTS5 syntax characters, LIKE wildcards, and NUL bytes must never throw or inject.
      for (const q of ['foo_bar', '100%', '"quoted"', 'a*b', '[REDACTED]', 'NOT', 'title:foo']) {
        const hits = await store.search(q)
        assert.equal(hits.length, 1, `literal query ${q} should match entry 4`)
        assert.equal(hits[0]?.conversationId, 4)
        assertValidHighlights(hits[0]!, [q])
      }
      assert.deepEqual(await store.search('   \u0000  '), [])
      const nulSplit = await store.search('foo_bar\u0000100%')
      assert.equal(nulSplit.length, 1)
      assert.equal(nulSplit[0]?.conversationId, 4)

      // 15-term query executes ALL terms honestly without silent truncation (previous cap of 12 would have dropped term 13..15).
      const fifteenTerms = Array.from({ length: 15 }, (_, i) => `tok${String(i).padStart(2, '0')}`)
      store.upsertConv(conv(5, { title: 'Long Multi-Term' }))
      store.indexFts(5, 'entry:1', 'Long Multi-Term', fifteenTerms.join(' '))
      store.indexFts(5, 'entry:2', 'Long Multi-Term', fifteenTerms.slice(0, 14).join(' '))
      const allFifteenHits = await store.search(fifteenTerms.join(' '))
      assert.equal(allFifteenHits.length, 1, '15th term must be enforced honestly (entry missing term 15 excluded)')
      assert.equal(allFifteenHits[0]?.entryId, 'entry:1')

      // Queries exceeding explicit MAX_SEARCH_TERMS or MAX_SEARCH_QUERY_CHARS reject explicitly with 400 validation_error.
      const tooManyTerms = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `t${i}`).join(' ')
      await assert.rejects(
        () => store.search(tooManyTerms),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )
      const tooLongQuery = 'a'.repeat(MAX_SEARCH_QUERY_CHARS + 1)
      await assert.rejects(
        () => store.search(tooLongQuery),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )

      // Long single-token (>256 UTF-16) body match must keep full highlight and locatable entryId (never misclassified as title-only).
      const longToken = `https://example.invalid/${'segment-'.repeat(35)}end`
      assert.ok(longToken.length > 256 && longToken.length <= MAX_SEARCH_QUERY_CHARS)
      store.upsertConv(conv(6, { title: 'URL Trace' }))
      store.indexFts(6, 'entry:url', 'URL Trace', `prefix filler ${'context '.repeat(30)}${longToken} trailing text`)
      const longTokenHits = await store.search(longToken)
      assert.equal(longTokenHits.length, 1)
      assert.equal(longTokenHits[0]?.entryId, 'entry:url', 'long-token body match must retain locatable entryId')
      assertValidHighlights(longTokenHits[0]!, [longToken])
    } finally {
      await store.close()
      await database.close()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('FTS relevance ranking, per-conversation cap, title return, and safe highlight invariants', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-rank-'))
    const { store, database } = await openStoreAt(base)
    try {
      // 1. Title-weighted bm25 relevance (3+ char) and per-conversation cap (default max 2 per conversation).
      store.upsertConv(conv(1, { title: 'Kubernetes Deployment Guide' }))
      store.upsertConv(conv(2, { title: 'Misc Notes' }))
      store.upsertConv(conv(3, { title: 'Cluster Ops' }))

      for (let i = 1; i <= 5; i += 1) {
        store.indexFts(1, `entry:${i}`, 'Kubernetes Deployment Guide', `Kubernetes cluster step ${i} for kubernetes rollout.`)
      }
      store.indexFts(2, 'entry:1', 'Misc Notes', 'Mentioned kubernetes once while reviewing logs.')
      store.indexFts(3, 'entry:1', 'Cluster Ops', 'Upgrading kubernetes control plane nodes.')

      const hits = await store.search('kubernetes')
      // Conv #1 has 5 matches but default cap limits it to 2, allowing conv #2 and #3 to surface.
      assert.equal(hits.filter((h) => h.conversationId === 1).length, 2, 'default per-conversation cap must limit conv #1 to 2 hits')
      assert.equal(hits.length, 4)
      assert.equal(hits[0]?.conversationId, 1, 'title + dense body match must rank first')
      assert.equal(hits[0]?.title, 'Kubernetes Deployment Guide')
      assert.ok(hits.some((h) => h.conversationId === 2))
      assert.ok(hits.some((h) => h.conversationId === 3))
      for (const hit of hits) {
        assert.ok(!hit.snippet.includes('kubernetes...'), 'old broken close-tag ellipsis bug must not recur')
        assertValidHighlights(hit, ['kubernetes'])
      }

      // Custom cap / limit options.
      const singlePerConv = await store.search('kubernetes', { limit: 10, maxPerConversation: 1 })
      assert.equal(singlePerConv.length, 3)
      assert.equal(new Set(singlePerConv.map((h) => h.conversationId)).size, 3)

      // 2. Short-query (<3 char) ranking puts title hits ahead of body-only hits; title-only hits omit entryId and collapse to 1/conv.
      store.upsertConv(conv(10, { title: '日常杂记' }))
      store.upsertConv(conv(11, { title: '配置中心' }))
      store.indexFts(10, 'entry:1', '日常杂记', '今天调整了一下系统配置。')
      store.indexFts(11, 'entry:1', '配置中心', '查看默认参数列表。')
      store.indexFts(11, 'entry:2', '配置中心', '好的收到。')
      store.indexFts(11, 'entry:3', '配置中心', 'ok')
      const shortRanked = await store.search('配置')
      assert.equal(shortRanked.length, 2, 'multiple title-only messages in conv 11 must collapse to one conversation-level hit')
      assert.equal(shortRanked[0]?.conversationId, 11, 'short-query title hit must rank ahead of body-only hit')
      assert.equal(shortRanked[0]?.entryId, undefined, 'title-only hit must omit entryId rather than pointing at an unrelated message')
      assert.deepEqual(shortRanked[0]?.highlights, [], 'title-only hit must return explicit [] highlights')
      assert.equal(shortRanked[1]?.conversationId, 10)
      assert.equal(shortRanked[1]?.entryId, 'entry:1')
      assertValidHighlights(shortRanked[1]!, ['配置'])

      // 2b. Trigram title-only vs body+title within same conversation: body match must win over short "ok" messages,
      // and a pure title-only conversation collapses to 1 hit without entryId.
      store.upsertConv(conv(13, { title: '专属架构专题' }))
      store.indexFts(13, 'entry:1', '专属架构专题', 'ok')
      store.indexFts(13, 'entry:2', '专属架构专题', '收到')
      store.indexFts(13, 'entry:3', '专属架构专题', '好的')
      store.indexFts(
        13,
        'entry:4',
        '专属架构专题',
        `${'无关填充背景说明文字 '.repeat(40)} 这里详细记录了专属架构专题的落地细节。${'补充内容 '.repeat(40)}`,
      )
      store.upsertConv(conv(14, { title: '专属架构专题纯标题' }))
      store.indexFts(14, 'entry:1', '专属架构专题纯标题', '纯闲聊消息一')
      store.indexFts(14, 'entry:2', '专属架构专题纯标题', '纯闲聊消息二')
      const titleVsBody = await store.search('专属架构专题')
      const c13Hits = titleVsBody.filter((h) => h.conversationId === 13)
      assert.equal(c13Hits.length, 1, 'conv 13 should keep only its real body hit and drop redundant title-only rows')
      assert.equal(c13Hits[0]?.entryId, 'entry:4', 'long body hit must beat shorter title-only "ok" rows in same conversation')
      assertValidHighlights(c13Hits[0]!, ['专属架构专题'])
      const c14Hits = titleVsBody.filter((h) => h.conversationId === 14)
      assert.equal(c14Hits.length, 1, 'pure title-only conv 14 must collapse to one hit')
      assert.equal(c14Hits[0]?.entryId, undefined, 'pure title-only trigram hit must omit entryId')
      assert.deepEqual(c14Hits[0]?.highlights, [])

      // 3. XSS / HTML safety: plain text preserved verbatim, zero injected tags, exact UTF-16 highlights.
      store.upsertConv(conv(12, { title: '' }))
      store.indexFts(12, 'entry:1', '', 'Use <script>alert(1)</script> and <mark>数据库</mark> safely.')
      const xssHits = await store.search('数据库')
      assert.equal(xssHits.length, 1)
      assert.equal(xssHits[0]?.title, undefined, 'empty title must be omitted rather than empty string')
      assert.equal(xssHits[0]?.snippet, 'Use <script>alert(1)</script> and <mark>数据库</mark> safely.')
      assertValidHighlights(xssHits[0]!, ['数据库'])

      // 4. Long text windowing: cluster selection, surrogate-pair safety, and synthetic '...' never highlighted.
      const filler = '背景填充文字🚀用于测试窗口裁剪与代理对安全边界。'.repeat(12)
      const longBody = `${filler} 第一次提及数据库在这里。${filler} 核心诊断是数据库连接池与配置冲突导致超时，详见 ... 说明。 ${filler}`
      const built = buildSearchSnippet(longBody, ['数据库', '配置'])
      assert.ok(built.snippet.startsWith('...') && built.snippet.endsWith('...'))
      assert.ok(built.snippet.includes('数据库') && built.snippet.includes('配置'), 'window should center on multi-term cluster')
      assert.equal(hasUnpairedSurrogate(built.snippet), false, 'snippet truncation must never split UTF-16 surrogate pairs')
      assertValidHighlights({ conversationId: 1, snippet: built.snippet, highlights: built.highlights }, ['数据库', '配置'])

      const ellipsisBuilt = buildSearchSnippet(longBody, ['...'])
      assert.ok(ellipsisBuilt.snippet.startsWith('...') && ellipsisBuilt.snippet.endsWith('...'))
      assert.ok(ellipsisBuilt.highlights.length >= 1)
      for (const r of ellipsisBuilt.highlights) {
        assert.ok(r.start >= 3, 'synthetic leading ellipsis must never be highlighted')
        assert.ok(r.end <= ellipsisBuilt.snippet.length - 3, 'synthetic trailing ellipsis must never be highlighted')
      }
    } finally {
      await store.close()
      await database.close()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('FTS missing derived table recreate, crash-safe pending rebuild flag, and steady-state zero-rebuild', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-ddl-'))
    try {
      // Fresh DB starts at latest FTS version with trigram DDL and needsFtsRebuild = false.
      const fresh = await openStoreAt(base)
      assert.equal(fresh.store.needsFtsRebuild, false)
      fresh.store.upsertConv(conv(1, { title: '旧会话' }))
      fresh.store.indexFts(1, 'entry:1', '旧会话', '数据库连接池')
      await fresh.store.close()
      await fresh.database.close()

      // Drop the derived FTS table and clear version marker (simulates missing derived index).
      const raw = new DatabaseSync(join(base, 'state.sqlite'))
      raw.exec('DROP TABLE helmx_conversation_fts')
      raw.exec(`DELETE FROM helmx_seq WHERE key = '${FTS_SCHEMA_VERSION_KEY}'`)
      raw.close()

      // First reopen recreates trigram FTS table and persists pending version 0 -> needsFtsRebuild = true.
      const recreated = await openStoreAt(base)
      assert.equal(recreated.store.needsFtsRebuild, true)
      const ddlRow = await recreated.database.db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'helmx_conversation_fts'",
      )
      assert.match(ddlRow?.sql ?? '', /tokenize\s*=\s*['"]?trigram/i)
      // Simulate process crash BEFORE rebuildFts completes: close without rebuilding.
      await recreated.store.close()
      await recreated.database.close()

      // Next boot MUST still know rebuild is pending even though DDL already exists.
      const crashedRetry = await openStoreAt(base)
      assert.equal(crashedRetry.store.needsFtsRebuild, true, 'pending rebuild must survive crash after table recreate')
      await crashedRetry.store.rebuildFts(async (index) => {
        index(1, 'entry:1', '旧会话', '数据库连接池')
      })
      assert.equal(crashedRetry.store.needsFtsRebuild, false)
      const verRow = await crashedRetry.database.db.get<{ value: number }>(
        'SELECT value FROM helmx_seq WHERE key = ?',
        FTS_SCHEMA_VERSION_KEY,
      )
      assert.equal(verRow?.value, FTS_SCHEMA_VERSION)
      await crashedRetry.store.close()
      await crashedRetry.database.close()

      // Steady-state reopen: needsFtsRebuild is false (no redundant rebuild).
      const steady = await openStoreAt(base)
      assert.equal(steady.store.needsFtsRebuild, false)
      const hits = await steady.store.search('连接池')
      assert.equal(hits.length, 1)
      await steady.store.close()
      await steady.database.close()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('FTS rebuildFts preserves concurrent writes, title updates, deletions, and serializes overlapping calls', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-race-'))
    const { store, database } = await openStoreAt(base)
    try {
      store.upsertConv(conv(20, { title: 't20' }))
      store.upsertConv(conv(21, { title: 'old-21' }))
      store.upsertConv(conv(22, { title: 'to-delete-22' }))
      store.upsertConv(conv(23, { title: 'rewind-23' }))
      await store.flushPublic()

      const replayEntered = deferred()
      const replayRelease = deferred()

      const rebuild1 = store.rebuildFts(async (index) => {
        // Historical snapshot includes conv 21 (old title), conv 22 (about to be deleted), conv 23 (entry about to be removed).
        index(21, 'entry:1', 'old-21', 'alpha history entry')
        index(22, 'entry:1', 'to-delete-22', 'ghostconv should vanish')
        index(23, 'entry:1', 'rewind-23', 'rewoundentry should vanish')
        index(23, 'entry:2', 'rewind-23', 'keptentry survives')
        replayEntered.resolve()
        await replayRelease.promise
      })

      await replayEntered.promise

      // Live mutations arrive while async replay is in flight:
      store.indexFts(20, 'entry:new', 't20', 'concurrent live write 中文增量')
      store.upsertConv(conv(21, { title: 'renamed-during-rebuild', updatedAt: 5000 }))
      store.deleteConv(22)
      store.removeFtsEntries(23, ['entry:1'])

      replayRelease.resolve()
      await rebuild1

      const liveHits = await store.search('中文增量')
      assert.equal(liveHits.length, 1, 'concurrent indexFts during replay must not be lost')
      assert.equal(liveHits[0]?.conversationId, 20)

      const renamedHits = await store.search('alpha')
      assert.equal(renamedHits.length, 1)
      assert.equal(renamedHits[0]?.title, 'renamed-during-rebuild', 'concurrent title update must be reflected')

      assert.equal((await store.search('ghostconv')).length, 0, 'deleted conversation must never be resurrected by rebuild')
      assert.equal((await store.search('rewoundentry')).length, 0, 'removed entry must never be resurrected by rebuild')
      assert.equal((await store.search('keptentry')).length, 1)

      // Overlapping rebuild calls serialize strictly rather than interleaving overlays.
      const order: string[] = []
      const gate1 = deferred()
      const entered1 = deferred()
      const first = store.rebuildFts(async (index) => {
        order.push('r1-start')
        index(20, 'entry:new', 't20', 'firstpass token')
        entered1.resolve()
        await gate1.promise
        order.push('r1-end')
      })
      await entered1.promise
      const second = store.rebuildFts(async (index) => {
        order.push('r2-start')
        index(20, 'entry:new', 't20', 'secondpass token')
        order.push('r2-end')
      })
      gate1.resolve()
      await Promise.all([first, second])
      assert.deepEqual(order, ['r1-start', 'r1-end', 'r2-start', 'r2-end'])
      assert.equal((await store.search('secondpass')).length, 1)
      assert.equal((await store.search('firstpass')).length, 0)
    } finally {
      await store.close()
      await database.close()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('persists runDurationMs and runStartedAt across SQLite reload and derives earliestPendingAskCreatedAt in memory', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'timing-'))
    const { store, database } = await openStoreAt(base)
    try {
      store.upsertConv(conv(30, { runDurationMs: 12_345, runStartedAt: 9_876_543 }))
      store.upsertConv(conv(31, { runDurationMs: 0 }))
      await store.flushPublic()

      // Earliest pending ask derivation: ignores other conversations and settled asks.
      assert.equal(store.earliestPendingAskCreatedAt(30), undefined)
      store.putAsk({
        id: 'ask-other',
        conversationId: 31,
        specJson: JSON.stringify({ id: 'ask-other', title: 'other', status: 'pending', fields: [] }),
        status: 'pending',
        createdAt: 100,
      })
      store.putAsk({
        id: 'ask-settled',
        conversationId: 30,
        specJson: JSON.stringify({ id: 'ask-settled', title: 'done', status: 'answered', fields: [] }),
        status: 'answered',
        createdAt: 150,
        settledAt: 160,
      })
      store.putAsk({
        id: 'ask-late',
        conversationId: 30,
        specJson: JSON.stringify({ id: 'ask-late', title: 'late', status: 'pending', fields: [] }),
        status: 'pending',
        createdAt: 500,
      })
      store.putAsk({
        id: 'ask-early',
        conversationId: 30,
        specJson: JSON.stringify({ id: 'ask-early', title: 'early', status: 'pending', fields: [] }),
        status: 'pending',
        createdAt: 300,
      })
      assert.equal(store.earliestPendingAskCreatedAt(30), 300)

      const blockedSummary = summaryOf(
        store.getConv(30)!,
        'blocked',
        2,
        'thinking...',
        undefined,
        0,
        store.earliestPendingAskCreatedAt(30),
      )
      assert.equal(blockedSummary.runDurationMs, 12_345)
      assert.equal(blockedSummary.runStartedAt, 9_876_543)
      assert.equal(blockedSummary.pendingAskSince, 300)

      // When pendingAskCount === 0, summaryOf must omit pendingAskSince even if passed.
      const unblockedSummary = summaryOf(store.getConv(30)!, 'working', 0, 'thinking...', undefined, 0, 300)
      assert.equal('pendingAskSince' in unblockedSummary, false)

      // Settling earliest ask advances earliestPendingAskCreatedAt to the next pending ask.
      store.putAsk({
        id: 'ask-early',
        conversationId: 30,
        specJson: JSON.stringify({ id: 'ask-early', title: 'early', status: 'answered', fields: [] }),
        status: 'answered',
        createdAt: 300,
        settledAt: 600,
      })
      assert.equal(store.earliestPendingAskCreatedAt(30), 500)

      // Clearing runStartedAt persists SQL NULL and omits runStartedAt from summaryOf.
      await store.flushPublic()
      await store.close()
      await database.close()

      const reopened = await openStoreAt(base)
      try {
        assert.equal(reopened.store.getConv(30)?.runDurationMs, 12_345)
        assert.equal(reopened.store.getConv(30)?.runStartedAt, 9_876_543)
        assert.equal(reopened.store.getConv(31)?.runDurationMs, 0)
        assert.equal(reopened.store.getConv(31)?.runStartedAt, undefined)
        assert.equal(reopened.store.earliestPendingAskCreatedAt(30), 500)

        reopened.store.upsertConv({ ...reopened.store.getConv(30)!, runStartedAt: undefined })
        await reopened.store.flushPublic()
        await reopened.store.close()
        await reopened.database.close()

        const reopened2 = await openStoreAt(base)
        try {
          const meta30 = reopened2.store.getConv(30)!
          assert.equal(meta30.runDurationMs, 12_345)
          assert.equal(meta30.runStartedAt, undefined)
          const idleSummary = summaryOf(meta30, 'idle', 0)
          assert.equal(idleSummary.runDurationMs, 12_345)
          assert.equal('runStartedAt' in idleSummary, false)
        } finally {
          await reopened2.store.close()
          await reopened2.database.close()
        }
      } finally {
        await reopened.database.close()
      }
    } finally {
      await database.close()
      await rm(base, { recursive: true, force: true })
    }
  })
})

function assertValidHighlights(hit: SearchHit, expectedTerms: readonly string[]): void {
  assert.ok(Array.isArray(hit.highlights), 'highlights must always be an array')
  assert.ok(hit.highlights.length >= 1, `expected at least one highlight range in snippet: ${hit.snippet}`)
  const loweredTerms = expectedTerms.map((t) => t.toLowerCase())
  let prevEnd = -1
  for (const r of hit.highlights) {
    assert.ok(Number.isInteger(r.start) && Number.isInteger(r.end), 'highlight bounds must be integers')
    assert.ok(r.start >= 0 && r.start < r.end && r.end <= hit.snippet.length, `range [${r.start}, ${r.end}) out of bounds for length ${hit.snippet.length}`)
    assert.ok(r.start > prevEnd, `ranges must be strictly ascending and non-overlapping: prevEnd=${prevEnd}, start=${r.start}`)
    const slice = hit.snippet.slice(r.start, r.end).toLowerCase()
    assert.ok(
      loweredTerms.some((t) => slice.includes(t)),
      `highlighted slice "${slice}" must correspond to one of [${expectedTerms.join(', ')}]`,
    )
    prevEnd = r.end
  }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

// ---- test fixture helpers ----

async function openStoreAt(dir: string): Promise<{ store: HelmxStore; database: HelmxDatabase }> {
  const database = await openHelmxDatabase(dir)
  const store = new HelmxStore(database)
  await store.load()
  return { store, database }
}
