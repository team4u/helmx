/**
 * Upgraded `ctx.route` HTTP routing tests:
 * - `PATCH` & `HEAD` methods (plus `GET`/`POST`/`PUT`/`DELETE`) and invalid method rejection;
 * - `:param` extraction passed via 2nd argument `{ params }` (strict decoding including `%2F`,
 *   static-before-param precedence, and 1-arg handler compatibility);
 * - Registration-time duplicate & structural collision rejection (`400 validation_error`);
 * - Automatic SecretStash redaction of `text/*`, `application/json`, `*+json`, and `text/event-stream`
 *   responses while preserving status/headers and skipping binary streams without buffering.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import { createHubHandler } from '../src/http/hub.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'
import { PLUGIN_ROUTE_JSON_REDACT_MAX_BYTES } from '../src/http/plugin-routes.js'
import { PluginHost } from '../src/plugins/index.js'
import { SecretStash } from '../src/services/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

async function makeRouteHarness(plugins: PluginDefinition[], stash = new SecretStash()) {
  const dataDir = await makeTempDir('helmx-routes-upgrade-')
  const host = new PluginHost({
    dataDir,
    host: {
      ...createPluginHostBackendFixture(),
      emitEvent: () => {},
      redact: (text) => stash.redact(text),
    },
    docs: new MemoryDocStore(),
  })
  for (const def of plugins) {
    await host.register(def, { enabled: true })
  }
  const kernelStub = {
    dataDir,
    auth: {
      verifyToken: async (token: string) => token === 'valid-token',
    },
    plugins: host,
    stash,
  } as unknown as KernelRuntimeLike
  const handle = createHubHandler(kernelStub)
  const req = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has('authorization')) headers.set('authorization', 'Bearer valid-token')
    return handle(new Request(`http://hub.local${path}`, { ...init, headers }))
  }
  return {
    host,
    stash,
    handle,
    req,
    async close() {
      await host.dispose().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

test('ctx.route: supports PATCH & HEAD, extracts decoded :param segments, prefers static over param, and preserves 1-arg handlers', { timeout: 60_000 }, async () => {
  const env = await makeRouteHarness([
    {
      id: 'ext:items',
      definePlugin(ctx) {
        // Register parameterized route BEFORE static route to prove static-first precedence
        ctx.route({
          method: 'GET',
          path: '/items/:id',
          handler(_req, { params }) {
            return Response.json({ kind: 'param', params })
          },
        })
        ctx.route({
          method: 'GET',
          path: '/items/latest',
          handler() {
            return Response.json({ kind: 'static-latest' })
          },
        })
        ctx.route({
          method: 'PATCH',
          path: '/orgs/:orgId/items/:itemId',
          async handler(req, { params }) {
            const body = await req.json()
            return Response.json({ method: req.method, params, body }, { status: 202 })
          },
        })
        ctx.route({
          method: 'HEAD',
          path: '/items/:id',
          public: true,
          handler(_req, { params }) {
            return new Response(null, {
              status: 200,
              headers: { 'x-item-id': params.id ?? '' },
            })
          },
        })
        // Legacy 1-arg handler stays valid
        ctx.route({
          method: 'GET',
          path: '/legacy',
          handler: (req) => new Response(`legacy:${new URL(req.url).pathname}`),
        })
      },
    },
  ])
  try {
    const prefix = `/api/plugins/${encodeURIComponent('ext:items')}/routes`

    // Multi-param PATCH with percent-encoded '/' (%2F) staying inside a single param
    const patchRes = await env.req(`${prefix}/orgs/acme%2Fcorp/items/it-42`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'updated' }),
    })
    assert.equal(patchRes.status, 202)
    assert.deepEqual(await patchRes.json(), {
      method: 'PATCH',
      params: { orgId: 'acme/corp', itemId: 'it-42' },
      body: { title: 'updated' },
    })

    // Public HEAD route works without Bearer token and returns headers with empty body
    const headRes = await env.handle(new Request(`http://hub.local${prefix}/items/item-7`, { method: 'HEAD' }))
    assert.equal(headRes.status, 200)
    assert.equal(headRes.headers.get('x-item-id'), 'item-7')
    assert.equal(await headRes.text(), '')

    // Static /items/latest beats /items/:id despite being registered second
    const staticRes = await env.req(`${prefix}/items/latest`)
    assert.deepEqual(await staticRes.json(), { kind: 'static-latest' })

    const paramRes = await env.req(`${prefix}/items/hello%20world`)
    assert.deepEqual(await paramRes.json(), { kind: 'param', params: { id: 'hello world' } })

    // 1-arg handler still works cleanly
    const legacyRes = await env.req(`${prefix}/legacy`)
    assert.equal(legacyRes.status, 200)
    assert.match(await legacyRes.text(), /^legacy:\/api\/plugins\//)

    // Manifest projection faithfully lists PATCH and HEAD methods
    const manifest = env.host.getManifest('ext:items')
    assert.ok(manifest.routes.some((r) => r.method === 'PATCH' && r.path.endsWith('/orgs/:orgId/items/:itemId')))
    assert.ok(manifest.routes.some((r) => r.method === 'HEAD' && r.path.endsWith('/items/:id') && r.public === true))
  } finally {
    await env.close()
  }
})

test('ctx.route: rejects duplicate/colliding route patterns, duplicate param names, and invalid methods with 400 validation_error', { timeout: 60_000 }, async () => {
  const env = await makeRouteHarness([])
  try {
    // 1. Structural collision: /items/:a vs /items/:b under same method
    await assert.rejects(
      () =>
        env.host.register({
          id: 'p:dup-param',
          definePlugin(ctx) {
            ctx.route({ method: 'GET', path: '/items/:a', handler: () => new Response('a') })
            ctx.route({ method: 'GET', path: '/items/:b', handler: () => new Response('b') })
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // 2. Percent-encoded literal duplicate: /items/foo vs /items/%66oo
    await assert.rejects(
      () =>
        env.host.register({
          id: 'p:dup-encoded',
          definePlugin(ctx) {
            ctx.route({ method: 'POST', path: '/items/foo', handler: () => new Response('1') })
            ctx.route({ method: 'POST', path: '/items/%66oo', handler: () => new Response('2') })
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // 3. Duplicate param name within the same route path
    await assert.rejects(
      () =>
        env.host.register({
          id: 'p:same-param-twice',
          definePlugin(ctx) {
            ctx.route({ method: 'GET', path: '/a/:id/b/:id', handler: () => new Response('x') })
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // 4. Bare ':' or prototype-polluting param names
    for (const badPath of ['/items/:', '/items/:__proto__', '/items/:constructor', '/items/:1bad']) {
      await assert.rejects(
        () =>
          env.host.register({
            id: `p:bad-param-${badPath.length}`,
            definePlugin(ctx) {
              ctx.route({ method: 'GET', path: badPath, handler: () => new Response('x') })
            },
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        `must reject ${badPath}`,
      )
    }

    // 5. Unsupported HTTP method
    await assert.rejects(
      () =>
        env.host.register({
          id: 'p:bad-method',
          definePlugin(ctx) {
            ctx.route({ method: 'TRACE' as never, path: '/x', handler: () => new Response('x') })
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    // 6. Different methods on colliding pattern AND same pattern across distinct plugins ARE allowed
    await env.host.register({
      id: 'p:ok-a',
      definePlugin(ctx) {
        ctx.route({ method: 'GET', path: '/items/:a', handler: () => new Response('get') })
        ctx.route({ method: 'PATCH', path: '/items/:b', handler: () => new Response('patch') })
        ctx.route({ method: 'HEAD', path: '/items/:c', handler: () => new Response(null) })
      },
    })
    await env.host.register({
      id: 'p:ok-b',
      definePlugin(ctx) {
        ctx.route({ method: 'GET', path: '/items/:id', handler: () => new Response('other-plugin') })
      },
    })
    assert.equal(env.host.listRoutes().length, 4)
  } finally {
    await env.close()
  }
})

test('ctx.route: redacts text/*, application/json, +json, and SSE responses while passing binary streams without buffering', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const secretA = 'sk-route-secret-token-12345'
  const secretQuoted = 'secret-"quote"\nnextline'
  stash.addRedaction(secretA)
  stash.addRedaction(secretQuoted)

  let releaseSecondBinaryChunk!: () => void
  const binaryGate = new Promise<void>((resolve) => {
    releaseSecondBinaryChunk = resolve
  })

  const env = await makeRouteHarness(
    [
      {
        id: 'ext:redact',
        definePlugin(ctx) {
          ctx.route({
            method: 'GET',
            path: '/text',
            handler: () =>
              new Response(`plain leak: ${secretA}`, {
                status: 201,
                headers: {
                  'content-type': 'text/plain; charset=utf-8',
                  'x-custom': 'keep-me',
                  'content-length': '999',
                },
              }),
          })
          ctx.route({
            method: 'GET',
            path: '/json',
            handler: () =>
              new Response(JSON.stringify({ token: secretA, quoted: secretQuoted }), {
                status: 200,
                headers: {
                  'content-type': 'application/problem+json; charset=utf-8',
                  'x-problem': 'yes',
                },
              }),
          })
          ctx.route({
            method: 'GET',
            path: '/sse',
            handler: () => {
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  const enc = new TextEncoder()
                  controller.enqueue(enc.encode(`data: prefix ${secretA.slice(0, 10)}`))
                  controller.enqueue(enc.encode(`${secretA.slice(10)} suffix\n\n`))
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
            },
          })
          ctx.route({
            method: 'GET',
            path: '/binary',
            handler: () => {
              const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(new TextEncoder().encode(`BIN:${secretA}:`))
                  await binaryGate
                  controller.enqueue(new TextEncoder().encode('TAIL'))
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'application/octet-stream', 'x-bin': '1' },
              })
            },
          })
        },
      },
    ],
    stash,
  )

  try {
    const prefix = `/api/plugins/${encodeURIComponent('ext:redact')}/routes`

    // 1. text/plain redacted + status/headers preserved + stale content-length removed
    const textRes = await env.req(`${prefix}/text`)
    assert.equal(textRes.status, 201)
    assert.equal(textRes.headers.get('x-custom'), 'keep-me')
    assert.equal(textRes.headers.get('content-length'), null)
    const textBody = await textRes.text()
    assert.ok(!textBody.includes(secretA))
    assert.match(textBody, /\[REDACTED\]/)

    // 2. +json redacted (including secret containing quotes & newlines!)
    const jsonRes = await env.req(`${prefix}/json`)
    assert.equal(jsonRes.status, 200)
    assert.equal(jsonRes.headers.get('x-problem'), 'yes')
    const jsonBody = (await jsonRes.json()) as { token: string; quoted: string }
    assert.ok(!jsonBody.token.includes(secretA))
    assert.ok(!jsonBody.quoted.includes('nextline'))
    assert.match(jsonBody.token, /\[REDACTED\]/)
    assert.match(jsonBody.quoted, /\[REDACTED\]/)

    // 3. SSE text/event-stream redacted across chunk boundaries
    const sseRes = await env.req(`${prefix}/sse`)
    assert.equal(sseRes.status, 200)
    const sseBody = await sseRes.text()
    assert.ok(!sseBody.includes(secretA), 'cross-chunk secret in SSE must be redacted')
    assert.match(sseBody, /\[REDACTED\]/)

    // 4. Binary stream returns immediately WITHOUT buffering (gate is still closed when req resolves!)
    const binRes = await env.req(`${prefix}/binary`)
    assert.equal(binRes.status, 200)
    assert.equal(binRes.headers.get('x-bin'), '1')
    releaseSecondBinaryChunk()
    const binBytes = new Uint8Array(await binRes.arrayBuffer())
    const binText = new TextDecoder().decode(binBytes)
    assert.equal(binText, `BIN:${secretA}:TAIL`, 'binary streams must pass through untouched without buffering')
  } finally {
    releaseSecondBinaryChunk()
    await env.close()
  }
})

test('ctx.route: open SSE stream blocks plugin.disable with 409 plugin_has_live_tasks until close, cancel, abort, or error while buffered responses release immediately', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const secret = 'sk-sse-live-secret-98765'
  stash.addRedaction(secret)

  let sseController: ReadableStreamDefaultController<Uint8Array> | undefined
  let sseCancelled = false

  const env = await makeRouteHarness(
    [
      {
        id: 'ext:sse',
        definePlugin(ctx) {
          ctx.route({
            method: 'GET',
            path: '/events',
            handler: () => {
              sseCancelled = false
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  sseController = controller
                  controller.enqueue(new TextEncoder().encode(`data: open ${secret}\n\n`))
                },
                cancel() {
                  sseCancelled = true
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
            },
          })
          ctx.route({
            method: 'GET',
            path: '/buffered-json',
            handler: () => Response.json({ ok: true }),
          })
          ctx.route({
            method: 'GET',
            path: '/buffered-text',
            handler: () => new Response(`hello ${secret}`, { headers: { 'content-type': 'text/plain' } }),
          })
          ctx.route({
            method: 'GET',
            path: '/empty',
            handler: () => new Response(null, { status: 204 }),
          })
        },
      },
    ],
    stash,
  )

  try {
    const prefix = `/api/plugins/${encodeURIComponent('ext:sse')}/routes`

    // 1. Ordinary buffered responses release liveTasks immediately even if body is never read
    const bufJson = await env.req(`${prefix}/buffered-json`)
    assert.equal(bufJson.status, 200)
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'buffered JSON must not hold liveTasks')

    const bufText = await env.req(`${prefix}/buffered-text`)
    assert.equal(bufText.status, 200)
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'buffered text must not hold liveTasks')
    assert.equal(await bufText.text(), 'hello [REDACTED]')

    const emptyRes = await env.req(`${prefix}/empty`)
    assert.equal(emptyRes.status, 204)
    assert.equal(env.host.activeTaskCount('ext:sse'), 0)

    // 2. Open SSE stream holds liveTasks and blocks plugin.disable with 409 until closed
    const sseRes = await env.req(`${prefix}/events`)
    assert.equal(sseRes.status, 200)
    assert.equal(env.host.activeTaskCount('ext:sse'), 1, 'open SSE stream must hold liveTasks')
    await assert.rejects(
      () => env.host.disable('ext:sse'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    )
    sseController!.enqueue(new TextEncoder().encode('data: done\n\n'))
    sseController!.close()
    const sseText = await sseRes.text()
    assert.ok(!sseText.includes(secret))
    assert.match(sseText, /\[REDACTED\]/)
    assert.match(sseText, /data: done/)
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'closing SSE stream must release liveTasks')

    // 3. Consumer cancel releases liveTasks and cancels upstream stream
    const cancelRes = await env.req(`${prefix}/events`)
    assert.equal(env.host.activeTaskCount('ext:sse'), 1)
    await cancelRes.body!.cancel('client-gone')
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'cancelling SSE body must release liveTasks')
    assert.equal(sseCancelled, true, 'cancelling SSE body must propagate cancel to upstream stream')

    // 4. Request signal abort immediately releases liveTasks and cancels upstream stream
    const abortController = new AbortController()
    const abortRes = await env.req(`${prefix}/events`, { signal: abortController.signal })
    assert.equal(env.host.activeTaskCount('ext:sse'), 1)
    abortController.abort(new Error('disconnect'))
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'aborting request.signal must release liveTasks promptly')
    assert.equal(sseCancelled, true)
    await abortRes.body!.cancel().catch(() => {})

    // 5. Upstream stream error releases liveTasks cleanly
    const errRes = await env.req(`${prefix}/events`)
    assert.equal(env.host.activeTaskCount('ext:sse'), 1)
    sseController!.error(new Error('upstream boom'))
    await assert.rejects(() => errRes.text())
    assert.equal(env.host.activeTaskCount('ext:sse'), 0, 'upstream stream error must release liveTasks')

    // Now disable succeeds cleanly
    await env.host.disable('ext:sse')
    assert.equal(env.host.get('ext:sse')?.enabled, false)
  } finally {
    await env.close()
  }
})

test('ctx.route: text/* and application/x-ndjson stream without full-body buffering; >4 MiB JSON streams cleanly without truncation', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const secret = 'sk-stream-boundary-secret-55555'
  stash.addRedaction(secret)

  let releaseTextGate!: () => void
  const textGate = new Promise<void>((resolve) => {
    releaseTextGate = resolve
  })
  let releaseNdjsonGate!: () => void
  const ndjsonGate = new Promise<void>((resolve) => {
    releaseNdjsonGate = resolve
  })
  let releaseHugeJsonTail!: () => void
  const hugeJsonGate = new Promise<void>((resolve) => {
    releaseHugeJsonTail = resolve
  })

  const chunkPayloadSize = 64 * 1024
  const prefixChunkCount = Math.ceil((PLUGIN_ROUTE_JSON_REDACT_MAX_BYTES + chunkPayloadSize) / chunkPayloadSize)
  const fillerChunk = 'a'.repeat(chunkPayloadSize)

  const env = await makeRouteHarness(
    [
      {
        id: 'ext:streams',
        definePlugin(ctx) {
          ctx.route({
            method: 'GET',
            path: '/text-stream',
            handler: () => {
              const enc = new TextEncoder()
              const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(enc.encode(`chunk1:${secret.slice(0, 12)}`))
                  await textGate
                  controller.enqueue(enc.encode(`${secret.slice(12)}:chunk2`))
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              })
            },
          })
          ctx.route({
            method: 'GET',
            path: '/ndjson-stream',
            handler: () => {
              const enc = new TextEncoder()
              const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(enc.encode(`{"seq":1,"tok":"${secret.slice(0, 14)}`))
                  await ndjsonGate
                  controller.enqueue(enc.encode(`${secret.slice(14)}"}\n{"seq":2,"ok":true}\n`))
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'application/x-ndjson' },
              })
            },
          })
          ctx.route({
            method: 'GET',
            path: '/huge-json',
            handler: () => {
              const enc = new TextEncoder()
              const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(enc.encode(`{"head":"${secret}","pad":"`))
                  for (let i = 0; i < prefixChunkCount; i += 1) {
                    controller.enqueue(enc.encode(fillerChunk))
                  }
                  // Straddle a secret across the streaming transition boundary & gate the tail
                  controller.enqueue(enc.encode(`","mid":"${secret.slice(0, 11)}`))
                  await hugeJsonGate
                  controller.enqueue(enc.encode(`${secret.slice(11)}","tail":"${secret}","end":true}`))
                  controller.close()
                },
              })
              return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'application/json; charset=utf-8' },
              })
            },
          })
        },
      },
    ],
    stash,
  )

  try {
    const prefix = `/api/plugins/${encodeURIComponent('ext:streams')}/routes`

    // 1. text/plain stream returns immediately BEFORE textGate opens (proves zero full-body buffering)
    const textRes = await env.req(`${prefix}/text-stream`)
    assert.equal(textRes.status, 200)
    assert.equal(env.host.activeTaskCount('ext:streams'), 1)
    releaseTextGate()
    const textBody = await textRes.text()
    assert.equal(textBody, 'chunk1:[REDACTED]:chunk2')
    assert.equal(env.host.activeTaskCount('ext:streams'), 0)

    // 2. application/x-ndjson stream returns immediately BEFORE ndjsonGate opens
    const ndjsonRes = await env.req(`${prefix}/ndjson-stream`)
    assert.equal(ndjsonRes.status, 200)
    assert.equal(env.host.activeTaskCount('ext:streams'), 1)
    releaseNdjsonGate()
    const ndjsonBody = await ndjsonRes.text()
    assert.ok(!ndjsonBody.includes(secret))
    const lines = ndjsonBody.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines, [
      { seq: 1, tok: '[REDACTED]' },
      { seq: 2, ok: true },
    ])
    assert.equal(env.host.activeTaskCount('ext:streams'), 0)

    // 3. Oversized (>4 MiB) JSON switches to streaming redaction once cap is crossed (before tail gate opens!)
    const hugeRes = await env.req(`${prefix}/huge-json`)
    assert.equal(hugeRes.status, 200)
    assert.equal(env.host.activeTaskCount('ext:streams'), 1, 'oversized JSON stream must stay tracked until EOF')
    releaseHugeJsonTail()
    const hugeBody = await hugeRes.text()
    assert.ok(!hugeBody.includes(secret), 'all secrets in oversized JSON must be redacted')
    const parsed = JSON.parse(hugeBody) as { head: string; pad: string; mid: string; tail: string; end: boolean }
    assert.equal(parsed.head, '[REDACTED]')
    assert.equal(parsed.pad.length, prefixChunkCount * chunkPayloadSize, 'oversized JSON must not truncate bytes')
    assert.equal(parsed.mid, '[REDACTED]')
    assert.equal(parsed.tail, '[REDACTED]')
    assert.equal(parsed.end, true)
    assert.equal(env.host.activeTaskCount('ext:streams'), 0)
  } finally {
    releaseTextGate()
    releaseNdjsonGate()
    releaseHugeJsonTail()
    await env.close()
  }
})
