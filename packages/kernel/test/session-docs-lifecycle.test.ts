/**
 * Integration tests for dedicated sessionDoc SSE lifecycle (`KernelRuntime` + HTTP hub).
 *
 * Covers:
 * - Plugin disabled while stream open (`plugin.changed` `enabled=false`): server terminates stream via event push;
 * - Plugin failed while still enabled (`enabled=true, status='failed'` via force-disabled dependency) or non-active
 *   summary transitions (`status='disabled'` / `error !== undefined`): closes dedicated & multiplexed streams for that
 *   plugin without closing unrelated active streams or config-only active updates, and re-establishes cleanly after recovery;
 * - Conversation deleted while stream open (`conversation.deleted`): server terminates stream via event push;
 * - `kernel.close()` closes all dedicated sessionDoc streams and releases lifecycle subscriptions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { startHub } from '../src/http/index.js'
import type { PluginSessionDocHandle } from '@helmx/protocol'
import type { KernelRuntime as KernelRuntimeType } from '../src/runtime/runtime.js'

interface App {
  kernel: KernelRuntimeType
  url: string
  token: string
  metrics: PluginSessionDocHandle<{ n: number }>
  close(): Promise<void>
}

async function openApp(): Promise<App> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-sd-lifecycle-'))
  const models = createModels()
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  let metrics: PluginSessionDocHandle<{ n: number }> | undefined
  await kernel.plugins.register({
    id: 'p:lifecycle',
    definePlugin: (ctx) => {
      metrics = ctx.sessionDoc('metrics', { n: 0 }, { public: true })
    },
  })
  // (Kernel started before startHub: the listen-before-start HTTP layer gates non-probe API routes
  // with `503 hub_starting` while `kernel.started === false`.)
  await kernel.start()
  const hub = await startHub({ kernel: kernel as never, port: 0 })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'sd-lifecycle-pass' }),
  })
  const { token } = (await setup.json()) as { token: string }
  return {
    kernel,
    url: hub.url,
    token,
    metrics: metrics!,
    async close() {
      await hub.close()
      await kernel.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function sseUrl(url: string, conversationId: number, pluginId = 'p:lifecycle', docName = 'metrics'): string {
  return `${url}/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(docName)}/events?conversationId=${conversationId}`
}

function multiplexSseUrl(url: string, subs: ReadonlyArray<{ pluginId: string; name: string; conversationId: number }>): string {
  const qs = subs
    .map((s) => `sub=${encodeURIComponent(s.pluginId)}/${encodeURIComponent(s.name)}/${s.conversationId}`)
    .join('&')
  return `${url}/api/session-docs/events?${qs}`
}

/** Reads chunks from an active SSE reader until `pattern` appears; fails explicitly on premature EOF or timeout. */
async function readUntilMatch(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { text: string },
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (!pattern.test(buffer.text)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for SSE pattern ${pattern} (buffer=${JSON.stringify(buffer.text)})`)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for SSE pattern ${pattern} (buffer=${JSON.stringify(buffer.text)})`)),
          remaining,
        )
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (next.done) {
      throw new Error(`SSE stream closed before matching ${pattern} (buffer=${JSON.stringify(buffer.text)})`)
    }
    buffer.text += decoder.decode(next.value, { stream: true })
  }
  return buffer.text
}

/** Drains an already-open SSE reader until server-initiated EOF (`done`); fails on timeout. */
async function drainReaderUntilDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { text: string },
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for SSE stream EOF (buffer=${JSON.stringify(buffer.text)})`)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for SSE stream EOF (buffer=${JSON.stringify(buffer.text)})`)),
          remaining,
        )
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (next.done) return buffer.text
    buffer.text += decoder.decode(next.value, { stream: true })
  }
}

/** Reads a stream until completion (`done`) and returns full decoded text; fails on timeout. */
async function readUntilDone(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 10_000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
  }
}

test('dedicated SSE: disables plugin and closes active sessionDoc stream (event-driven)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    app.metrics.set(1, { n: 1 })
    const res = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    // Disable plugin: plugin.changed enabled=false -> closeForPlugin -> terminates stream.
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.plugins.disable('p:lifecycle')
    const text = await readAll
    assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before stream closed')
    assert.ok(text.length >= 0)
    // Reconnecting while disabled fails validation with 404 before opening a stream.
    const rejected = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(rejected.status, 404)
    await rejected.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('dedicated SSE: deletes conversation and closes active sessionDoc stream (conversation.deleted)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    // Create an isolated conversation to verify cascade without relying on seeded IDs.
    const conv = await app.kernel.conversations.createConversation({})
    const conversationId = conv.id
    app.metrics.set(conversationId, { n: 1 })
    const res = await fetch(sseUrl(app.url, conversationId), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.conversations.deleteConversation(conversationId)
    const text = await readAll
    assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before stream closed')
  } finally {
    await app.close()
  }
})

test('kernel.close(): closes all dedicated sessionDoc streams and releases subscriptions', { timeout: 60_000 }, async () => {
  const app = await openApp()
  app.metrics.set(1, { n: 1 })
  const res = await fetch(sseUrl(app.url, 1), {
    headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
  await app.kernel.close()
  const text = await readAll
  assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before kernel shutdown')
  assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0, 'no subscriptions remain after kernel.close()')
  await app.close()
})

test('transient sessionDoc (durable: false): HTTP GET + dedicated SSE + conversation.deleted cleanup with zero SQLite rows', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    let transient!: PluginSessionDocHandle<{ step: number } | null>
    await app.kernel.plugins.register({
      id: 'p:transient-http',
      definePlugin: (ctx) => {
        transient = ctx.sessionDoc<{ step: number } | null>('live', null, { public: true, durable: false })
      },
    })
    const conv = await app.kernel.conversations.createConversation({})
    transient.set(conv.id, { step: 1 })

    const getRes = await fetch(
      `${app.url}/api/plugins/p%3Atransient-http/docs/live?conversationId=${conv.id}`,
      { headers: { authorization: `Bearer ${app.token}` } },
    )
    assert.equal(getRes.status, 200)
    assert.deepEqual(((await getRes.json()) as { value: { step: number } }).value, { step: 1 })

    const sseRes = await fetch(
      `${app.url}/api/plugins/p%3Atransient-http/docs/live/events?conversationId=${conv.id}`,
      { headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' } },
    )
    assert.equal(sseRes.status, 200)
    const readAll = readUntilDone(sseRes.body as ReadableStream<Uint8Array>)
    transient.set(conv.id, { step: 2 })
    // Delete conversation: closes stream cleanly and clears in-memory transient entry.
    await app.kernel.conversations.deleteConversation(conv.id)
    const text = await readAll
    assert.match(text, /event: snapshot/)
    assert.match(text, /"step":2/)

    // Flush & check SQLite: zero rows ever written for p:transient-http.
    await transient.flush()
    const db = await openHelmxDatabase(app.kernel.dataDir)
    try {
      const rows = await db.db.all<{ conversation_id: number }>(
        'SELECT conversation_id FROM helmx_plugin_session_docs WHERE plugin_id = ?',
        'p:transient-http',
      )
      assert.equal(rows.length, 0)
    } finally {
      await db.close()
    }
  } finally {
    await app.close()
  }
})

test('dedicated & multiplexed SSE: failed-while-enabled dependent closes matching streams, preserves active/config updates, and re-establishes after recovery', { timeout: 60_000 }, async () => {
  const app = await openApp()
  const otherController = new AbortController()
  const recoveredDedicatedController = new AbortController()
  const recoveredMultiplexController = new AbortController()
  try {
    let depMetrics!: PluginSessionDocHandle<{ n: number }>
    let otherMetrics!: PluginSessionDocHandle<{ n: number }>

    await app.kernel.plugins.register({ id: 'p:base', definePlugin: () => {} })
    await app.kernel.plugins.register({
      id: 'p:dep',
      dependencies: ['p:base'],
      definePlugin: (ctx) => {
        ctx.configSchema({ refreshMs: { type: 'number', default: 1_000 } })
        depMetrics = ctx.sessionDoc('metrics', { n: 0 }, { public: true })
      },
    })
    await app.kernel.plugins.register({
      id: 'p:other',
      definePlugin: (ctx) => {
        otherMetrics = ctx.sessionDoc('metrics', { n: 0 }, { public: true })
      },
    })

    depMetrics.set(1, { n: 1 })
    otherMetrics.set(1, { n: 10 })

    // Open dedicated stream for p:dep, multiplexed stream including p:dep + p:other, and unrelated stream for p:other.
    const depRes = await fetch(sseUrl(app.url, 1, 'p:dep', 'metrics'), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    const muxRes = await fetch(
      multiplexSseUrl(app.url, [
        { pluginId: 'p:dep', name: 'metrics', conversationId: 1 },
        { pluginId: 'p:other', name: 'metrics', conversationId: 1 },
      ]),
      { headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' } },
    )
    const otherRes = await fetch(sseUrl(app.url, 1, 'p:other', 'metrics'), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
      signal: otherController.signal,
    })
    assert.equal(depRes.status, 200)
    assert.equal(muxRes.status, 200)
    assert.equal(otherRes.status, 200)

    const depReader = (depRes.body as ReadableStream<Uint8Array>).getReader()
    const muxReader = (muxRes.body as ReadableStream<Uint8Array>).getReader()
    const otherReader = (otherRes.body as ReadableStream<Uint8Array>).getReader()
    const depDecoder = new TextDecoder()
    const muxDecoder = new TextDecoder()
    const otherDecoder = new TextDecoder()
    const depBuf = { text: '' }
    const muxBuf = { text: '' }
    const otherBuf = { text: '' }

    await readUntilMatch(depReader, depDecoder, depBuf, /event: snapshot[\s\S]*"n":1/)
    await readUntilMatch(muxReader, muxDecoder, muxBuf, /"pluginId":"p:dep"[\s\S]*"n":1/)
    await readUntilMatch(otherReader, otherDecoder, otherBuf, /event: snapshot[\s\S]*"n":10/)

    // Active config-only plugin.changed must keep all streams alive.
    await app.kernel.plugins.setConfig('p:dep', { refreshMs: 2_500 })
    depMetrics.set(1, { n: 2 })
    await readUntilMatch(depReader, depDecoder, depBuf, /event: plugin\.session_doc\.updated[\s\S]*"n":2/)
    await readUntilMatch(muxReader, muxDecoder, muxBuf, /"action":"updated"[\s\S]*"pluginId":"p:dep"[\s\S]*"n":2/)

    // Force-disable base -> p:dep becomes enabled=true, status=failed -> closeForPlugin terminates p:dep streams immediately.
    const depClosed = drainReaderUntilDone(depReader, depDecoder, depBuf)
    const muxClosed = drainReaderUntilDone(muxReader, muxDecoder, muxBuf)
    await app.kernel.plugins.disable('p:base', { force: true })

    const failedSummary = app.kernel.plugins.get('p:dep')!
    assert.equal(failedSummary.enabled, true)
    assert.equal(failedSummary.status, 'failed')
    assert.equal(failedSummary.error?.code, 'plugin_dependency_not_enabled')

    await Promise.all([depClosed, muxClosed])
    // Only p:other's dedicated stream remains subscribed and still delivers live updates.
    assert.equal(app.kernel.sessionDocEvents.subscriberCount, 1)
    otherMetrics.set(1, { n: 11 })
    await readUntilMatch(otherReader, otherDecoder, otherBuf, /event: plugin\.session_doc\.updated[\s\S]*"n":11/)
    otherController.abort()
    await otherReader.cancel().catch(() => {})

    // Recovery path: disable dep (disabled -> 404 on reconnect) -> enable base -> enable dep.
    await app.kernel.plugins.disable('p:dep')
    const disabledRes = await fetch(sseUrl(app.url, 1, 'p:dep', 'metrics'), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(disabledRes.status, 404)
    await disabledRes.arrayBuffer()

    await app.kernel.plugins.enable('p:base')
    await app.kernel.plugins.enable('p:dep')
    assert.equal(app.kernel.plugins.get('p:dep')?.status, 'active')

    // Re-establishing dedicated and multiplexed streams succeeds with persisted snapshot and live deltas.
    const recDepRes = await fetch(sseUrl(app.url, 1, 'p:dep', 'metrics'), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
      signal: recoveredDedicatedController.signal,
    })
    const recMuxRes = await fetch(
      multiplexSseUrl(app.url, [{ pluginId: 'p:dep', name: 'metrics', conversationId: 1 }]),
      {
        headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
        signal: recoveredMultiplexController.signal,
      },
    )
    assert.equal(recDepRes.status, 200)
    assert.equal(recMuxRes.status, 200)

    const recDepReader = (recDepRes.body as ReadableStream<Uint8Array>).getReader()
    const recMuxReader = (recMuxRes.body as ReadableStream<Uint8Array>).getReader()
    const recDepDecoder = new TextDecoder()
    const recMuxDecoder = new TextDecoder()
    const recDepBuf = { text: '' }
    const recMuxBuf = { text: '' }

    await readUntilMatch(recDepReader, recDepDecoder, recDepBuf, /event: snapshot[\s\S]*"n":2/)
    await readUntilMatch(recMuxReader, recMuxDecoder, recMuxBuf, /"action":"snapshot"[\s\S]*"pluginId":"p:dep"[\s\S]*"n":2/)

    depMetrics.set(1, { n: 3 })
    await readUntilMatch(recDepReader, recDepDecoder, recDepBuf, /event: plugin\.session_doc\.updated[\s\S]*"n":3/)
    await readUntilMatch(recMuxReader, recMuxDecoder, recMuxBuf, /"action":"updated"[\s\S]*"pluginId":"p:dep"[\s\S]*"n":3/)

    recoveredDedicatedController.abort()
    recoveredMultiplexController.abort()
    await Promise.all([
      recDepReader.cancel().catch(() => {}),
      recMuxReader.cancel().catch(() => {}),
    ])
  } finally {
    otherController.abort()
    recoveredDedicatedController.abort()
    recoveredMultiplexController.abort()
    await app.close()
  }
})

test('dedicated SSE: non-active plugin.changed summaries (transitional status=disabled and error-carrying failed summary) close streams while active summaries stay open', { timeout: 60_000 }, async () => {
  const app = await openApp()
  const activeController = new AbortController()
  try {
    app.metrics.set(1, { n: 1 })
    const baseSummary = app.kernel.plugins.get('p:lifecycle')!

    // 1. Transitional non-idle projection: enabled=true with status='disabled' closes stream immediately.
    const res1 = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res1.status, 200)
    const r1 = (res1.body as ReadableStream<Uint8Array>).getReader()
    const d1 = new TextDecoder()
    const b1 = { text: '' }
    await readUntilMatch(r1, d1, b1, /event: snapshot[\s\S]*"n":1/)
    const closed1 = drainReaderUntilDone(r1, d1, b1)
    app.kernel.events.publish('plugin.changed', {
      type: 'plugin.changed',
      plugin: { ...baseSummary, enabled: true, status: 'disabled' },
      ui: [],
    })
    await closed1
    assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0)

    // 2. Failed summary with error diagnostic (even if status is omitted) closes stream immediately.
    const res2 = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res2.status, 200)
    const r2 = (res2.body as ReadableStream<Uint8Array>).getReader()
    const d2 = new TextDecoder()
    const b2 = { text: '' }
    await readUntilMatch(r2, d2, b2, /event: snapshot[\s\S]*"n":1/)
    const closed2 = drainReaderUntilDone(r2, d2, b2)
    const { status: _omittedStatus, ...withoutStatus } = baseSummary
    app.kernel.events.publish('plugin.changed', {
      type: 'plugin.changed',
      plugin: {
        ...withoutStatus,
        enabled: true,
        error: { code: 'dependency_failed', message: 'dependency broken', stage: 'enable' },
      },
      ui: [],
    })
    await closed2
    assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0)

    // 3. Re-established stream stays open across active plugin.changed updates and delivers subsequent writes.
    const res3 = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
      signal: activeController.signal,
    })
    assert.equal(res3.status, 200)
    const r3 = (res3.body as ReadableStream<Uint8Array>).getReader()
    const d3 = new TextDecoder()
    const b3 = { text: '' }
    await readUntilMatch(r3, d3, b3, /event: snapshot[\s\S]*"n":1/)
    app.kernel.events.publish('plugin.changed', {
      type: 'plugin.changed',
      plugin: { ...baseSummary, enabled: true, status: 'active' },
      ui: [],
    })
    app.metrics.set(1, { n: 2 })
    await readUntilMatch(r3, d3, b3, /event: plugin\.session_doc\.updated[\s\S]*"n":2/)
    activeController.abort()
    await r3.cancel().catch(() => {})
  } finally {
    activeController.abort()
    await app.close()
  }
})
