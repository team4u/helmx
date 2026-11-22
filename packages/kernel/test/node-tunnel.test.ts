/**
 * Unit tests for node pass-through tunnels (Hub/protocol side):
 * - registry.openTunnel: offline node 409 / unimplemented nodeTunnelOpen 501 / single-use pending
 *   tunnelId (duplicate accept rejected) / signal abort cleans up pending / target host pass-through
 *   (including host validation);
 * - Pending tunnels are rejected (409 node_offline) immediately on node disconnect/eviction rather than hanging;
 * - acceptTunnel rejects mismatched identity (nodeId / token / unknown tunnelId);
 * - fabric.nodeFetch port: rejects non-http(s) URLs, forwards arbitrary hosts to connection setup;
 *   local node delegates directly to globalThis.fetch; fabric.openTunnel connects directly for local;
 * - attachNodeTunnelGateway: non-JSON / non-hello first frame returns error frame and closes;
 *   valid hello with unknown tunnelId rejects immediately (registry reject path).
 * Real daemon end-to-end byte pass-through is covered in env-fabric.test.ts / node-tunnel-binary.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { useTempDir } from '@helmx/test-kit/node'
import { WebSocket } from 'ws'
import type { WebSocket as WsSocket } from 'ws'
import { HelmxError } from '@helmx/protocol'
import { NodeRegistry } from '../src/env/registry.js'
import { attachNodeTunnelGateway } from '../src/env/ws-tunnel-gateway.js'
import { createEnvFabric, type EnvFabric } from '../src/env/fabric.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

type TunnelOpenFn = (input: { tunnelId: string; host?: string; port: number }) =>
  Promise<{ ok: true; value: null } | { ok: false; error: { code: string; message: string } }>

/** Registers a fake node (constant auth with `<nodeId>:secret`), optionally providing nodeTunnelOpen. */
async function registerFakeNode(registry: NodeRegistry, nodeId: string, nodeTunnelOpen?: TunnelOpenFn): Promise<FakeSocket> {
  const socket = new FakeSocket()
  const rpc: Record<string, unknown> = {
    $close() {},
    ...(nodeTunnelOpen !== undefined ? { nodeTunnelOpen } : {}),
  }
  const outcome = await registry.register(
    socket as unknown as WsSocket,
    { nodeId, token: `${nodeId}:secret`, hostname: 'h', platform: 'linux' },
    () => rpc as never,
  )
  assert.equal(outcome.accepted, true)
  return socket
}

const tunnelOk: TunnelOpenFn = () => Promise.resolve({ ok: true, value: null })

test('openTunnel: offline node 409, unimplemented nodeTunnelOpen 501', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    await assert.rejects(
      registry.openTunnel('ghost', { port: 8080 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
    )
    const socket = await registerFakeNode(registry, 'node-a')
    await assert.rejects(
      registry.openTunnel('node-a', { port: 8080 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_not_supported' && error.status === 501,
    )
    socket.close()
  } finally {
    await registry.close()
  }
})

test('openTunnel + acceptTunnel: single-use consumption and identity validation', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: (id, token) => token === `${id}:secret` })
  try {
    let tunnelId = ''
    let openedHost: string | undefined
    const socket = await registerFakeNode(registry, 'node-b', async (input) => {
      tunnelId = input.tunnelId
      openedHost = input.host
      return { ok: true, value: null }
    })
    const pending = registry.openTunnel('node-b', { port: 9000, host: 'db.internal' })
    await delay(20)
    assert.equal(tunnelId.length > 0, true)
    assert.equal(openedHost, 'db.internal', 'target host passes through verbatim to node (node resolves it)')
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    // Wrong token -> rejected, pending preserved.
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:wrong', tunnelId), false)
    // Mismatched nodeId -> rejected.
    assert.equal(await registry.acceptTunnel('other', 'other:secret', tunnelId), false)
    // Valid consumption -> acceptTunnel true + grantTunnel delivers Duplex, registry moves to active.
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:secret', tunnelId), true)
    const granted = new PassThrough()
    registry.grantTunnel(tunnelId, granted)
    const duplex = await pending
    assert.equal(duplex, granted)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 1 })
    // Second consumption of same tunnelId -> rejected.
    assert.equal(await registry.acceptTunnel("node-b", "node-b:secret", tunnelId), false)
    // Registry entry is removed once duplex closes.
    duplex.destroy()
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('node disconnect cleans up pending tunnels (rejects 409 without hanging)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-c', tunnelOk)
    const pending = registry.openTunnel('node-c', { port: 9100 })
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    socket.close() // triggers eviction: pending must be rejected.
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
  } finally {
    await registry.close()
  }
})

test('openTunnel: signal abort cleans up pending tunnel (499 aborted)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-d', tunnelOk)
    const controller = new AbortController()
    const pending = registry.openTunnel('node-d', { port: 9200 }, controller.signal)
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmxError && error.code === 'aborted' && error.status === 499,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('openTunnel: draining rejection maps to node_draining(503), distinct from aborted(499)/timeout(504)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // Node RPC explicitly returning node_draining (rejecting new work during upgrade drain) maps stably
    // to HelmxError node_draining 503, never collapsed into aborted or connect_failed.
    const socket = await registerFakeNode(registry, 'node-drain', async () => ({
      ok: false,
      error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new tunnels' },
    }))
    await assert.rejects(
      registry.openTunnel('node-drain', { port: 9300 }),
      (error: unknown) =>
        error instanceof HelmxError &&
        error.code === 'node_draining' &&
        error.status === 503 &&
        /draining/.test(error.message),
    )
    socket.close()

    // Contrast: node-side aborted (genuine cancellation) still maps to 499 aborted, unaffected by draining logic.
    const socket2 = await registerFakeNode(registry, 'node-abort', async () => ({
      ok: false,
      error: { code: 'aborted', message: 'tunnel aborted' },
    }))
    await assert.rejects(
      registry.openTunnel('node-abort', { port: 9301 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'aborted' && error.status === 499,
    )
    socket2.close()

    // Contrast: timeout still maps to 504 node_tunnel_timeout.
    const socket3 = await registerFakeNode(registry, 'node-slow', async () => ({
      ok: false,
      error: { code: 'timeout', message: 'tunnel open timed out' },
    }))
    await assert.rejects(
      registry.openTunnel('node-slow', { port: 9302 }),
      (error: unknown) =>
        error instanceof HelmxError && error.code === 'node_tunnel_timeout' && error.status === 504,
    )
    socket3.close()
  } finally {
    await registry.close()
  }
})

test('nodeFetch port: rejects non-http(s), forwards arbitrary hosts; validates openTunnel target; local passes through', { timeout: 60_000 }, async () => {
  let fabric: EnvFabric | undefined
  try {
    fabric = createEnvFabric({ authenticate: () => true })
    const fetchRemote = fabric.nodeFetch('node-e')
    await assert.rejects(
      fetchRemote('ftp://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_connect_failed',
    )
    // Arbitrary (non-loopback) hosts proceed to connection setup: offline node yields 409 (no longer rejects non-loopback).
    await assert.rejects(
      fetchRemote('http://example.com:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('http://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    // Default ports (80/443) proceed to connection setup (adapter supplies default port by scheme).
    await assert.rejects(
      fetchRemote('http://127.0.0.1/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('https://example.com/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    // openTunnel target validation: invalid port or host fails explicitly with 400 validation_error.
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 0 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error' && error.status === 400,
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 70000 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'bad host\n', port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: '', port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'a'.repeat(256), port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    // Local openTunnel: connects directly in-process (echo server round-trips data).
    const echo = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as net.AddressInfo).port
    try {
      const duplex = await fabric.openTunnel('local', { host: '127.0.0.1', port: echoPort })
      const echoed = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        duplex.on('data', (c: Buffer) => chunks.push(c))
        duplex.once('error', reject)
        duplex.write('ping-local')
        const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString()), 5_000)
        duplex.on('data', () => {
          const text = Buffer.concat(chunks).toString()
          if (text.includes('ping-local')) { clearTimeout(timer); resolve(text) }
        })
      })
      assert.ok(echoed.includes('ping-local'), 'local openTunnel round-trips bytes')
      duplex.destroy()
      // Local openTunnel: closed port fails explicitly (never silently fakes success).
      await assert.rejects(
        fabric.openTunnel('local', { port: 1 }),
        (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_connect_failed',
      )
      // Local openTunnel: abort yields explicit 499.
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        fabric.openTunnel('local', { port: echoPort }, controller.signal),
        (error: unknown) => error instanceof HelmxError && error.code === 'aborted',
      )
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
    assert.equal(fabric.nodeFetch('local'), globalThis.fetch)
  } finally {
    await fabric?.dispose()
  }
})

test('tunnel gateway: non-JSON / non-hello first frame returns error frame; unknown tunnelId rejects immediately', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const gateway = attachNodeTunnelGateway(server, { registry })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const url = `ws://127.0.0.1:${address.port}/ws/node-tunnel`

    // Non-JSON and non-hello: error frame + close.
    for (const frame of ['not-json', JSON.stringify({ type: 'other' })]) {
      const ws = new WebSocket(url)
      const frames: string[] = []
      await new Promise<void>((resolve) => {
        ws.on('open', () => { ws.send(frame) })
        ws.on('message', (raw) => { frames.push(raw.toString()) })
        ws.on('close', () => resolve())
      })
      const parsed = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
      assert.equal(parsed.type, 'error')
      assert.equal(parsed.code, 'invalid')
    }

    // Valid hello with unknown tunnelId: auth/match failure -> immediate error frame + close
    // (ok frame must never precede verification; never enters data phase).
    const ws = new WebSocket(url)
    const frames: string[] = []
    await new Promise<void>((resolve) => {
      ws.on('open', () => { ws.send(JSON.stringify({ tunnelId: 'missing', nodeId: 'node-x', token: 'node-x:secret' })) })
      ws.on('message', (raw) => { frames.push(raw.toString()) })
      ws.on('close', () => resolve())
    })
    assert.equal(frames.length, 1)
    const rejected = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
    assert.equal(rejected.type, 'error')
    assert.equal(rejected.code, 'permission_denied')
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await registry.close()
  }
})

test('tunnel gateway: silent connection without hello closes after first-frame timeout (code 4001, no accumulation)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const gateway = attachNodeTunnelGateway(server, { registry, helloTimeoutMs: 150 })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const url = `ws://127.0.0.1:${address.port}/ws/node-tunnel`

    // Connects and sends nothing: must close after first-frame timeout (matching /ws/node 4001 semantics).
    const ws = new WebSocket(url)
    let closeCode = -1
    const closedAt = new Promise<void>((resolve) => {
      ws.on('close', (code: number) => { closeCode = code; resolve() })
    })
    const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()))
    await opened
    const startedAt = Date.now()
    await closedAt
    const elapsed = Date.now() - startedAt
    assert.equal(closeCode, 4001, `silent connection should be closed by timeout (close code ${closeCode})`)
    assert.ok(elapsed >= 140 && elapsed < 5_000, `timeout should fire near threshold (actual ${elapsed}ms)`)
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await registry.close()
  }
})

test('openTunnel socketPath: validates controlled paths, forwards POSIX/Windows socketPath verbatim, and bridges local UDS', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-kernel-socket-tunnel-')
  const sockPath = path.join(dir, 'echo.sock')
  const uds = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => uds.listen(sockPath, resolve))
  const fabric = createEnvFabric({ authenticate: () => true })
  try {
    // Local UDS tunnel works end-to-end.
    const localStream = await fabric.openTunnel('local', { socketPath: sockPath })
    localStream.write('hello-uds\n')
    const echoed = await new Promise<string>((resolve) => {
      let buf = ''
      localStream.on('data', (chunk: Buffer | string) => {
        buf += chunk.toString()
        if (buf.includes('\n')) resolve(buf)
      })
    })
    assert.equal(echoed, 'hello-uds\n')
    localStream.destroy()

    // Controlled socketPath boundary rejects relative, traversal, UNC pipes, raw Windows markers, and mixed targets.
    for (const badTarget of [
      { socketPath: 'relative.sock' },
      { socketPath: '/tmp/../escape.sock' },
      { socketPath: '\\\\server\\pipe\\remote' },
      { socketPath: 'C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock' },
      { socketPath: '/tmp/a.sock', port: 8080 } as never,
    ]) {
      await assert.rejects(
        fabric.openTunnel('local', badTarget),
        (error: unknown) => error instanceof HelmxError && error.code === 'validation_error' && error.status === 400,
        `expected validation_error for ${JSON.stringify(badTarget)}`,
      )
    }

    // Remote controlled Windows Named Pipe passes validation and is forwarded verbatim to nodeTunnelOpen.
    const receivedInputs: Array<Record<string, unknown>> = []
    const remoteSocket = new FakeSocket()
    await fabric.registry.register(
      remoteSocket as unknown as WsSocket,
      { nodeId: 'win-box', token: 'win-box:secret', hostname: 'win', platform: 'win32' },
      () => ({
        $close() {},
        nodeTunnelOpen: async (input: Record<string, unknown>) => {
          receivedInputs.push(input)
          return { ok: true, value: null }
        },
        nodeTunnelAbort: async () => undefined,
      }) as never,
    )
    const pipePath = '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock'
    const pending = fabric.openTunnel('win-box', { socketPath: pipePath })
    await delay(20)
    assert.equal(receivedInputs.length, 1)
    assert.equal(receivedInputs[0]?.socketPath, pipePath)
    assert.equal(receivedInputs[0]?.port, undefined)
    const tunnelId = String(receivedInputs[0]?.tunnelId ?? '')
    assert.equal(await fabric.registry.acceptTunnel('win-box', 'win-box:secret', tunnelId), true)
    const bridge = new PassThrough()
    fabric.registry.grantTunnel(tunnelId, bridge)
    const remoteStream = await pending
    assert.ok(remoteStream === bridge)
    bridge.destroy()
    remoteSocket.close()
  } finally {
    await fabric.dispose()
    await new Promise<void>((resolve) => uds.close(() => resolve()))
  }
})

test('fabric.getNodeHostEnv: returns target node env without Hub-local fallback and enforces honest errors', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({
    authenticate: () => true,
    localHostEnv: {
      homeDir: '/hub-home',
      tempDir: '/hub-tmp',
      getEnv: (k) => (k === 'HERDR_SOCKET_PATH' ? '/hub-only.sock' : undefined),
    },
  })
  try {
    // Local node uses localHostEnv context.
    const localEnv = await fabric.getNodeHostEnv('local', { envKeys: ['HERDR_SOCKET_PATH'] })
    assert.equal(localEnv.platform, process.platform)
    assert.equal(localEnv.homeDir, '/hub-home')
    assert.equal(localEnv.env['HERDR_SOCKET_PATH'], '/hub-only.sock')

    // Sensitive keys rejected at Hub boundary before touching local or remote env.
    await assert.rejects(
      fabric.getNodeHostEnv('local', { envKeys: ['HELMX_TOKEN'] }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error' && error.status === 400,
    )

    // Offline remote node MUST fail with 409 node_offline, never falling back to Hub-local env.
    await assert.rejects(
      fabric.getNodeHostEnv('offline-win', { envKeys: ['HERDR_SOCKET_PATH'] }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
    )

    // Legacy remote daemon lacking nodeHostEnv RPC fails explicitly with 501.
    const legacySocket = await registerFakeNode(fabric.registry, 'legacy-node')
    await assert.rejects(
      fabric.getNodeHostEnv('legacy-node', { envKeys: ['HERDR_SOCKET_PATH'] }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_host_env_not_supported' && error.status === 501,
    )
    legacySocket.close()

    // Remote Windows node returns its own target env (completely distinct from Hub Linux env).
    const winSocket = new FakeSocket()
    await fabric.registry.register(
      winSocket as unknown as WsSocket,
      { nodeId: 'win-remote', token: 'win-remote:secret', hostname: 'win', platform: 'win32' },
      () => ({
        $close() {},
        nodeHostEnv: async () => ({
          ok: true,
          value: {
            platform: 'win32',
            homeDir: 'C:\\Users\\alice',
            tempDir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
            dirs: {
              appData: 'C:\\Users\\alice\\AppData\\Roaming',
              userProfile: 'C:\\Users\\alice',
            },
            env: {},
          },
        }),
      }) as never,
    )
    const remoteEnv = await fabric.getNodeHostEnv('win-remote', { envKeys: ['HERDR_SOCKET_PATH'] })
    assert.equal(remoteEnv.platform, 'win32')
    assert.equal(remoteEnv.dirs.appData, 'C:\\Users\\alice\\AppData\\Roaming')
    assert.equal(remoteEnv.env['HERDR_SOCKET_PATH'], undefined, 'must not inherit Hub HERDR_SOCKET_PATH')
    winSocket.close()

    // Malformed remote snapshot rejected explicitly with 502 node_host_env_failed.
    const badSocket = new FakeSocket()
    await fabric.registry.register(
      badSocket as unknown as WsSocket,
      { nodeId: 'bad-env-node', token: 'bad-env-node:secret', hostname: 'bad', platform: 'linux' },
      () => ({
        $close() {},
        nodeHostEnv: async () => ({
          ok: true,
          value: { platform: 'plan9', homeDir: '', tempDir: '', dirs: {}, env: {} },
        }),
      }) as never,
    )
    await assert.rejects(
      fabric.getNodeHostEnv('bad-env-node'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_host_env_failed' && error.status === 502,
    )
    badSocket.close()
  } finally {
    await fabric.dispose()
  }
})
