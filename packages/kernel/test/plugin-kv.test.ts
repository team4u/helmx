/**
 * Per-plugin keyed KV storage (`ctx.kv<T>(namespace)` on `state.sqlite` `helmx_plugin_kv`) tests:
 * - CRUD (`get`/`set`/`delete`/`list`/`clear`/`flush`), prefix filtering & cursor pagination;
 * - Cross-plugin & cross-namespace isolation;
 * - Restart persistence across SQLite close/reopen & corruption detection on load;
 * - Automatic SecretStash redaction (including secrets containing quotes/newlines);
 * - Per-entry size limit (256 KiB / injectable override -> `413 plugin_kv_too_large`) without clobbering prior value;
 * - Namespace/key/list-option validation & non-JSON rejection;
 * - Epoch guards (expired after disable/re-enable/dispose; writable during controlled `stopWindow`);
 * - Explicit `501 kv_store_unavailable` when unwired & `doctorPluginDir` dry-run compatibility.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HelmxError, type PluginKvHandle } from '@helmx/protocol'
import { PluginHost, PLUGIN_KV_MAX_VALUE_BYTES, doctorPluginDir } from '../src/plugins/index.js'
import { SecretStash } from '../src/services/index.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore } from '../src/runtime/store.js'
import { createGlobalDocumentStore, createPluginKvStore } from '../src/runtime/runtime-host-backend.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { cleanupDir, makeTempDir } from './helpers.js'

async function openKvEnv(
  dir: string,
  options: { stash?: SecretStash; maxKvValueBytes?: number } = {},
) {
  const database = await openHelmxDatabase(dir)
  const store = new HelmxStore(database)
  await store.load()
  const stash = options.stash ?? new SecretStash()
  const host = new PluginHost({
    dataDir: join(dir, 'plugins-data'),
    host: {
      ...createPluginHostBackendFixture(),
      emitEvent: () => {},
      redact: (text) => stash.redact(text),
    },
    redactText: (text) => stash.redact(text),
    docs: createGlobalDocumentStore(store),
    kv: createPluginKvStore(store),
    maxKvValueBytes: options.maxKvValueBytes,
  })
  return {
    database,
    store,
    stash,
    host,
    async close() {
      await host.dispose().catch(() => {})
      await store.close().catch(() => {})
      await database.close().catch(() => {})
    },
  }
}

test('ctx.kv: CRUD, prefix/cursor pagination, isolation, and restart persistence on state.sqlite', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helmx-kv-crud-')
  try {
    const env1 = await openKvEnv(dir)
    let kvA!: PluginKvHandle<{ label: string; n: number }>
    let kvAOtherNs!: PluginKvHandle<string>
    let kvB!: PluginKvHandle<{ label: string }>

    await env1.host.register({
      id: 'plugin:alpha',
      definePlugin(ctx) {
        kvA = ctx.kv<{ label: string; n: number }>('items')
        kvAOtherNs = ctx.kv<string>('meta')
      },
    })
    await env1.host.register({
      id: 'plugin:beta',
      definePlugin(ctx) {
        kvB = ctx.kv<{ label: string }>('items')
      },
    })

    // Empty reads & deletes
    assert.equal(kvA.get('missing'), undefined)
    assert.equal(kvA.delete('missing'), false)
    assert.deepEqual(kvA.list(), { items: [] })

    // Writes + isolation across plugins and namespaces
    kvA.set('task/003', { label: 'third', n: 3 })
    kvA.set('task/001', { label: 'first', n: 1 })
    kvA.set('task/002', { label: 'second', n: 2 })
    kvA.set('note/001', { label: 'note', n: 10 })
    kvAOtherNs.set('task/001', 'other-ns-value')
    kvB.set('task/001', { label: 'beta-value' })

    // Isolated deep copy on read
    const read1 = kvA.get('task/001')!
    assert.deepEqual(read1, { label: 'first', n: 1 })
    read1.n = 999
    assert.equal(kvA.get('task/001')?.n, 1, 'caller mutation must not corrupt stored entry')

    // Prefix + deterministic sorted pagination
    const page1 = kvA.list({ prefix: 'task/', limit: 2 })
    assert.deepEqual(
      page1.items.map((i) => ({ key: i.key, value: i.value })),
      [
        { key: 'task/001', value: { label: 'first', n: 1 } },
        { key: 'task/002', value: { label: 'second', n: 2 } },
      ],
    )
    assert.equal(page1.nextCursor, 'task/002')
    assert.equal(typeof page1.items[0]!.updatedAt, 'number')

    const page2 = kvA.list({ prefix: 'task/', limit: 2, cursor: page1.nextCursor })
    assert.deepEqual(
      page2.items.map((i) => ({ key: i.key, value: i.value })),
      [{ key: 'task/003', value: { label: 'third', n: 3 } }],
    )
    assert.equal(page2.nextCursor, undefined, 'final page must omit nextCursor')

    // Delete single key
    assert.equal(kvA.delete('task/002'), true)
    assert.equal(kvA.delete('task/002'), false)
    assert.equal(kvA.get('task/002'), undefined)

    // Clear only affects target (plugin, namespace)
    kvAOtherNs.clear()
    assert.equal(kvAOtherNs.get('task/001'), undefined)
    assert.deepEqual(kvA.get('task/001'), { label: 'first', n: 1 })
    assert.deepEqual(kvB.get('task/001'), { label: 'beta-value' })

    await kvA.flush()
    await env1.close()

    // Reopen fresh SQLite database + HelmxStore + PluginHost -> verify full restart persistence
    const env2 = await openKvEnv(dir)
    let kvA2!: PluginKvHandle<{ label: string; n: number }>
    let kvB2!: PluginKvHandle<{ label: string }>
    await env2.host.register({
      id: 'plugin:alpha',
      definePlugin(ctx) {
        kvA2 = ctx.kv<{ label: string; n: number }>('items')
      },
    })
    await env2.host.register({
      id: 'plugin:beta',
      definePlugin(ctx) {
        kvB2 = ctx.kv<{ label: string }>('items')
      },
    })

    assert.deepEqual(
      kvA2.list().items.map((i) => i.key),
      ['note/001', 'task/001', 'task/003'],
    )
    assert.equal(kvA2.get('task/002'), undefined)
    assert.deepEqual(kvB2.get('task/001'), { label: 'beta-value' })

    await env2.close()

    // Corrupted JSON row in helmx_plugin_kv fails explicitly on HelmxStore.load()
    const rawDb = await openHelmxDatabase(dir)
    await rawDb.db.run(
      "INSERT INTO helmx_plugin_kv (plugin_id, namespace, key, value_json, updated_at) VALUES ('p:corrupt', 'ns', 'k', '{broken', 0)",
    )
    const corruptStore = new HelmxStore(rawDb)
    await assert.rejects(
      () => corruptStore.load(),
      (err: unknown) => err instanceof HelmxError && err.code === 'store_data_corrupted',
    )
    await rawDb.close()
  } finally {
    await cleanupDir(dir)
  }
})

test('ctx.kv: auto-redacts registered secrets via SecretStash before SQLite persistence (including quotes/newlines)', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helmx-kv-redact-')
  const stash = new SecretStash()
  const simpleSecret = 'sk-kv-secret-value-987654321'
  const trickySecret = 'tok-"quoted"\nline2-secret'
  stash.addRedaction(simpleSecret)
  stash.addRedaction(trickySecret)
  const env = await openKvEnv(dir, { stash })
  try {
    let kv!: PluginKvHandle<{ token: string; nested: { raw: string } }>
    await env.host.register({
      id: 'plugin:sec',
      definePlugin(ctx) {
        kv = ctx.kv('auth-cache')
      },
    })
    kv.set('entry-1', {
      token: `Bearer ${simpleSecret}`,
      nested: { raw: `before ${trickySecret} after` },
    })
    await kv.flush()

    const readBack = kv.get('entry-1')!
    assert.ok(!readBack.token.includes(simpleSecret), 'read-back must not contain plaintext secret')
    assert.ok(!readBack.nested.raw.includes(trickySecret), 'read-back must redact secret with quotes/newlines')
    assert.match(readBack.token, /\[REDACTED\]/)
    assert.match(readBack.nested.raw, /\[REDACTED\]/)

    // Verify raw SQLite row contains zero plaintext secret bytes
    const row = await env.database.db.get<{ value_json: string }>(
      "SELECT value_json FROM helmx_plugin_kv WHERE plugin_id = 'plugin:sec' AND namespace = 'auth-cache' AND key = 'entry-1'",
    )
    assert.ok(row !== undefined)
    assert.ok(!row.value_json.includes(simpleSecret))
    assert.ok(!row.value_json.includes('line2-secret'))
  } finally {
    await env.close()
    await cleanupDir(dir)
  }
})

test('ctx.kv: enforces 256 KiB per-entry limit (413 plugin_kv_too_large), validates inputs, and protects prior values', { timeout: 60_000 }, async () => {
  assert.equal(PLUGIN_KV_MAX_VALUE_BYTES, 256 * 1024)
  const dir = await makeTempDir('helmx-kv-bounds-')
  const env = await openKvEnv(dir, { maxKvValueBytes: 128 })
  try {
    let kv!: PluginKvHandle<unknown>
    await env.host.register({
      id: 'plugin:bounds',
      definePlugin(ctx) {
        kv = ctx.kv('bounded')
        // Invalid namespace rejected at boundary
        assert.throws(
          () => ctx.kv('bad/ns'),
          (err: unknown) => err instanceof HelmxError && err.code === 'invalid_kv_namespace' && err.status === 400,
        )
        assert.throws(
          () => ctx.kv(''),
          (err: unknown) => err instanceof HelmxError && err.code === 'invalid_kv_namespace' && err.status === 400,
        )
      },
    })

    kv.set('k1', { v: 'ok' })
    assert.throws(
      () => kv.set('k1', { v: 'x'.repeat(200) }),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_kv_too_large' && err.status === 413,
    )
    assert.deepEqual(kv.get('k1'), { v: 'ok' }, 'oversized write must leave previous value intact')

    // Invalid keys & list options & non-JSON values
    for (const badKey of ['', 'has\0nul', 'has\nnewline', 'k'.repeat(257)]) {
      assert.throws(
        () => kv.set(badKey, 1),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_kv_key' && err.status === 400,
      )
    }
    assert.throws(
      () => kv.set('bad-json', { n: Number.NaN }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_json_value',
    )
    assert.throws(
      () => kv.list({ limit: 0 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )
    assert.throws(
      () => kv.list({ limit: 1001 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )
    assert.throws(
      () => kv.list({ extra: 1 } as never),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )
  } finally {
    await env.close()
    await cleanupDir(dir)
  }
})

test('ctx.kv: epoch guards reject post-disable writes, allow stopWindow flush, fail 501 when unwired, and pass doctorPluginDir', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helmx-kv-epoch-')
  const env = await openKvEnv(dir)
  try {
    let staleKv!: PluginKvHandle<string>
    const observedOnDefine: Array<string | undefined> = []
    await env.host.register({
      id: 'plugin:lifecycle',
      definePlugin(ctx) {
        const kv = ctx.kv<string>('state')
        observedOnDefine.push(kv.get('phase'))
        staleKv = kv
        kv.set('phase', 'running')
        ctx.service({
          id: 'svc',
          start() {},
          async stop() {
            // Controlled stopWindow allows final flush before handle invalidation
            kv.set('phase', 'stopped-cleanly')
            await kv.flush()
          },
        })
      },
    })

    await env.host.disable('plugin:lifecycle')
    assert.equal(
      env.store.getPluginKv('plugin:lifecycle', 'state', 'phase')?.valueJson,
      '"stopped-cleanly"',
      'stopWindow flush must persist final KV write before handle expires',
    )
    // Post-disable stale handle rejects every operation with 409 plugin_context_expired
    assert.throws(
      () => staleKv.get('phase'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    assert.throws(
      () => staleKv.set('phase', 'after-disable'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    assert.throws(
      () => staleKv.delete('phase'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    assert.throws(
      () => staleKv.list(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    assert.throws(
      () => staleKv.clear(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    await assert.rejects(
      () => staleKv.flush(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )

    // Re-enable reads back the value flushed during stopWindow
    await env.host.enable('plugin:lifecycle')
    assert.deepEqual(observedOnDefine, [undefined, 'stopped-cleanly'])

    // Unwired PluginHost (no kv option) rejects explicitly with 501 kv_store_unavailable
    const bareHost = new PluginHost({
      dataDir: join(dir, 'bare'),
      host: { ...createPluginHostBackendFixture(), emitEvent: () => {} },
      docs: createGlobalDocumentStore(env.store),
    })
    try {
      await assert.rejects(
        () =>
          bareHost.register({
            id: 'plugin:needs-kv',
            definePlugin(ctx) {
              ctx.kv('ns')
            },
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'kv_store_unavailable' && err.status === 501,
      )
    } finally {
      await bareHost.dispose()
    }

    // doctorPluginDir dry-run passes for an external plugin using ctx.kv + ctx.provide
    const extDir = await makeTempDir('helmx-kv-doctor-')
    try {
      writeFileSync(join(extDir, 'plugin.json'), JSON.stringify({ id: 'ext-kv-demo', version: '0.1.0', main: 'index.mjs' }))
      writeFileSync(
        join(extDir, 'index.mjs'),
        `export default {\n  id: 'ext-kv-demo',\n  name: 'KV Demo',\n  definePlugin(ctx) {\n    const kv = ctx.kv('items')\n    kv.set('k', { ok: true })\n    ctx.provide('demo.ext-cap', { ready: true })\n  },\n}\n`,
      )
      const report = await doctorPluginDir(extDir)
      assert.equal(report.ok, true, JSON.stringify(report.checks))
    } finally {
      await cleanupDir(extDir)
    }
  } finally {
    await env.close()
    await cleanupDir(dir)
  }
})
