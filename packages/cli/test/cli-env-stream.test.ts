import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/index.js'
import { HubClient } from '../src/hub-client.js'
import { CliError } from '../src/errors.js'

async function consume(frames: unknown[], options: { raw?: string; mime?: string } = {}) {
  let out = ''
  let err = ''
  const response = options.raw ?? frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'
  const code = await runCli(['env', 'exec', '--stream', '--json', '--', 'build'], {
    env: { HELMX_HUB_URL: 'http://127.0.0.1:3202', HELMX_TOKEN: 'test-http-client-token' },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    fetch: async () => new Response(response, { headers: { 'content-type': options.mime ?? 'application/x-ndjson' } }),
  })
  return { code, out, error: err ? JSON.parse(err).error : undefined }
}

test('core command help does not access Hub or dynamic plugin manifests', { timeout: 60_000 }, async () => {
  let out = ''
  const code = await runCli(['nodes', 'list', '--help'], {
    env: {}, stdout: (text) => { out += text }, stderr: (text) => assert.fail(text),
    fetch: async () => { assert.fail('static help must not call Hub') },
  })
  assert.equal(code, 0)
  assert.match(out, /nodes list/)
})

test('NDJSON consumes first output chunk immediately without waiting for terminal frame', { timeout: 60_000 }, async () => {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'output', stream: 'stdout', text: 'ready' }) + '\n'))
    },
  })
  let consumed = false
  const code = await runCli(['env', 'exec', '--stream', '--json', '--', 'build'], {
    env: { HELMX_HUB_URL: 'http://127.0.0.1:3202', HELMX_TOKEN: 'stream-test-token' },
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
    stderr: (text) => assert.fail(text),
    stdout: (text) => {
      if (JSON.parse(text).type !== 'output') return
      consumed = true
      streamController.enqueue(encoder.encode(JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false }) + '\n'))
      streamController.close()
    },
  })
  assert.equal(consumed, true)
  assert.equal(code, 0)
})

test('env exec --stream human mode routes stdout and stderr frames to their respective streams', { timeout: 60_000 }, async () => {
  const frames = [
    { type: 'output', stream: 'stdout', text: 'out-1\n' },
    { type: 'output', stream: 'stderr', text: 'err-1\n' },
    { type: 'output', stream: 'stdout', text: 'out-2\n' },
    { type: 'output', stream: 'stderr', text: 'err-2\n' },
    { type: 'exit', ok: true, exitCode: 0, timedOut: false },
  ]
  const body = frames.map((f) => JSON.stringify(f)).join('\n') + '\n'
  let out = ''
  let err = ''
  const code = await runCli(['env', 'exec', '--stream', '--', 'build'], {
    env: { HELMX_HUB_URL: 'http://127.0.0.1:3202', HELMX_TOKEN: 'tok-stream' },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    fetch: async () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }),
  })
  assert.equal(code, 0)
  assert.equal(out, 'out-1\nout-2\n')
  assert.equal(err, 'err-1\nerr-2\n')
})

test('NDJSON premature stream end never treats unknown result as success', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'output', stream: 'stdout', text: 'started' }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'stream_incomplete')
})

test('NDJSON error frame preserves original error code, message, and details', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'error', error: { code: 'node_offline', message: 'node disconnected', details: { nodeId: 'build-box' } } }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'node_offline')
  assert.equal(result.error.message, 'node disconnected')
  assert.deepEqual(result.error.details, { nodeId: 'build-box' })
})

test('NDJSON rejects malformed frames, legacy exit frames, and trailing frames after exit', { timeout: 60_000 }, async () => {
  const cases = [
    [{ type: 'output', text: 'missing stream' }],
    [{ type: 'exit', ok: true, exitCode: '0', timedOut: false }],
    [{ type: 'done', result: { ok: true, exitCode: 0, timedOut: false } }],
    [{ type: 'exit', ok: true, exitCode: 0, timedOut: false }, { type: 'output', stream: 'stdout', text: 'late' }],
  ]
  for (const frames of cases) {
    const result = await consume(frames)
    assert.equal(result.code, 1)
    assert.equal(result.error.code, 'invalid_response')
  }
  const malformed = await consume([], { raw: '{broken}\n' })
  assert.equal(malformed.error.code, 'invalid_response')
  const wrongMime = await consume([], { mime: 'application/json', raw: '{}' })
  assert.equal(wrongMime.error.code, 'invalid_response')
})

test('NDJSON handles UTF-8 trailing frame without newline; JSON output preserves exit type and failure exit code', { timeout: 60_000 }, async () => {
  const success = await consume([], { raw: JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false }) })
  assert.equal(success.code, 0)
  assert.equal(JSON.parse(success.out).type, 'exit')
  const failure = await consume([{ type: 'exit', ok: false, exitCode: 7, timedOut: false }])
  assert.equal(failure.code, 7)
  assert.equal(failure.error.code, 'env_exec_failed')
})

test('HubClient streamNdjson & streamSse: connect timeout, index-cursor multi-frame chunks, CRLF splits, and 4 MiB frame cap', { timeout: 60_000 }, async () => {
  const makeIo = (fetchImpl: typeof fetch) => ({
    env: {},
    out: () => {},
    err: () => {},
    stdin: { isTTY: false, readAll: async () => '' },
    fetchImpl,
  })

  // 1. streamNdjson enforces connect timeout when Hub hangs before responding
  const hangingClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo(((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortErr = new Error('aborted')
          abortErr.name = 'AbortError'
          reject(abortErr)
        })
      })) as typeof fetch),
    60,
  )
  await assert.rejects(
    () => hangingClient.streamNdjson('POST', '/api/env/exec', { onLine: () => {} }),
    (err: unknown) => err instanceof CliError && err.code === 'timeout' && /connection timed out/.test(err.message),
  )

  // 2. streamNdjson parses many frames in one chunk (including CRLF) and rejects > 4 MiB frames
  const encoder = new TextEncoder()
  const manyLines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ idx: i })).join('\r\n') + '\r\n'
  const seenNdjson: number[] = []
  const okClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(encoder.encode(manyLines), {
        headers: { 'content-type': 'application/x-ndjson' },
      })) as typeof fetch),
    5_000,
  )
  await okClient.streamNdjson('POST', '/api/env/exec', {
    onLine: (val) => seenNdjson.push((val as { idx: number }).idx),
  })
  assert.equal(seenNdjson.length, 200)
  assert.equal(seenNdjson[0], 0)
  assert.equal(seenNdjson[199], 199)

  const hugeLine = JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024 + 64) }) + '\n'
  const hugeNdjsonClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(encoder.encode(hugeLine), {
        headers: { 'content-type': 'application/x-ndjson' },
      })) as typeof fetch),
    5_000,
  )
  await assert.rejects(
    () => hugeNdjsonClient.streamNdjson('POST', '/api/env/exec', { onLine: () => {} }),
    (err: unknown) => err instanceof CliError && err.code === 'invalid_response' && /maximum size limit/.test(err.message),
  )

  // 3. streamSse handles split \r\n\r\n across chunk boundaries, multi-frame chunks, and > 4 MiB frame rejection
  const sseChunks = [
    encoder.encode('event: tick\r\ndata: one\r\n\r'),
    encoder.encode('\nevent: tick\ndata: two\n\nevent: tick\r'),
    encoder.encode('\ndata: three\r\n\r\n'),
  ]
  const seenSse: Array<{ event: string; data: string }> = []
  const sseClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of sseChunks) controller.enqueue(c)
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch),
    5_000,
  )
  await sseClient.streamSse('/api/events', { onFrame: (f) => seenSse.push(f) })
  assert.deepEqual(seenSse, [
    { event: 'tick', data: 'one' },
    { event: 'tick', data: 'two' },
    { event: 'tick', data: 'three' },
  ])

  const hugeSseClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(encoder.encode(`data: ${'y'.repeat(4 * 1024 * 1024 + 64)}\n\n`), {
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch),
    5_000,
  )
  await assert.rejects(
    () => hugeSseClient.streamSse('/api/events', { onFrame: () => {} }),
    (err: unknown) => err instanceof CliError && err.code === 'invalid_response' && /maximum size limit/.test(err.message),
  )

  // 4. HubClient.parseEntity throws CliError on response.text() read/abort errors (never silently returning undefined)
  const abortingTextClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () => {
      const resp = new Response('ok', { status: 200, headers: { 'content-type': 'application/json' } })
      Object.defineProperty(resp, 'text', {
        value: async () => {
          const err = new Error('body aborted')
          err.name = 'AbortError'
          throw err
        },
      })
      return resp
    }) as typeof fetch),
    5_000,
  )
  await assert.rejects(
    () => abortingTextClient.get('/api/test'),
    (err: unknown) => err instanceof CliError && err.code === 'aborted',
  )

  // 5. streamSse enforces content-type: text/event-stream (cancelling body) and strict UTF-8 decoding
  let nonSseBodyCancelled = false
  const wrongMimeSseClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () => {
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          nonSseBodyCancelled = true
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch),
    5_000,
  )
  await assert.rejects(
    () => wrongMimeSseClient.streamSse('/api/events', { onFrame: () => {} }),
    (err: unknown) => err instanceof CliError && err.code === 'invalid_response' && /text\/event-stream/.test(err.message),
  )
  assert.equal(nonSseBodyCancelled, true)

  const invalidUtf8SseClient = new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch),
    5_000,
  )
  await assert.rejects(
    () => invalidUtf8SseClient.streamSse('/api/events', { onFrame: () => {} }),
    (err: unknown) => err instanceof CliError && err.code === 'invalid_response' && /UTF-8/.test(err.message),
  )
})
