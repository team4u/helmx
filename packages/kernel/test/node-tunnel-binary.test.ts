/**
 * Arbitrary TCP tunnel (openTunnel) integration tests across Hub + real node daemon:
 * Not limited to HTTP -- arbitrary host targets, binary/large payloads, connection shutdown, cancellation,
 * and nodeFetch HTTP/HTTPS adaptation (via local TLS fixture).
 *
 * Real pipeline: fabric.openTunnel -> registry.openTunnel -> daemon
 * nodeTunnelOpen(host) -> TCP -> /ws/node-tunnel binary byte stream.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { withTimeout } from '@helmx/test-kit'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  attachNodeWsGateway,
  attachNodeTunnelGateway,
  createEnvFabric,
  type EnvFabric,
} from '../src/env/index.js'
import { createNodeDaemon } from '@helmx/node'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-tunnel-bin-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

const execFileAsync = promisify(execFile)

/** Minimal EnvFabric Hub (HTTP server + both gateways + real daemon). */
async function startHub(
  authenticate: (nodeId: string, token: string) => boolean,
  nodeId: string,
  envServer?: Parameters<typeof createNodeDaemon>[0]['envServer'],
) {
  const fabric = createEnvFabric({ authenticate, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  const tunnelGateway = attachNodeTunnelGateway(server, { registry: fabric.registry })
  const nodeData = mkdtempSync(join(rootDir, `node-${nodeId}-`))
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${address.port}`,
    identity: { nodeId, token: `${nodeId}:secret` },
    dataDir: nodeData,
    ...(envServer !== undefined ? { envServer } : {}),
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
  const ready = await daemon.waitUntilRegistered(10_000)
  return {
    fabric,
    ready,
    disconnectDaemon: () => daemon.close(),
    close: async () => {
      await daemon.close()
      await tunnelGateway.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
      rmSync(nodeData, { recursive: true, force: true })
    },
  }
}

/** Binary-safe echo server (echoes arbitrary bytes verbatim; ignores socket errors to avoid crashing tests). */
async function startBinaryEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('arbitrary TCP: host pass-through + large binary payload round-trips byte-for-byte', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'bin-node' && token === 'bin-node:secret', 'bin-node')
  try {
    assert.equal(hub.ready, true)
    // Explicit host=localhost: target host is resolved and connected on the node side.
    const duplex = await hub.fabric.openTunnel('bin-node', { host: 'localhost', port: echo.port })
    const payload = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251 // non-UTF-8-friendly bytes
    const chunks: Buffer[] = []
    let received = 0
    duplex.on('data', (c: Buffer) => {
      chunks.push(c)
      received += c.length
    })
    duplex.write(payload)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15_000)
      duplex.on('data', () => {
        if (received >= payload.length) { clearTimeout(timer); resolve() }
      })
      duplex.once('error', reject)
    })
    assert.equal(received, payload.length, '4 MiB binary payload length matches')
    const echoed = Buffer.concat(chunks)
    assert.ok(echoed.equals(payload), 'binary contents match byte-for-byte')
    duplex.destroy()
    duplex.on('error', () => undefined)
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('arbitrary TCP: request-response-shutdown flushes completely without truncating trailing data', { timeout: 60_000 }, async () => {
  // Server waits for 'req', writes a large response, then closes. Hub keeps the write side open and
  // closes only after reading the full response -- verifying shutdown flushes completely without tail loss.
  // (Note: WS tunnels lack TCP half-close -- duplex.end closes the whole stream, so FIN half-close is not
  // tested here; node-side pipe end-flush semantics are covered by @helmx/node's node-tunnel.test.ts.)
  const response = Buffer.alloc(2 * 1024 * 1024, 0x52)
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('req')) socket.end(response)
    })
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const hub = await startHub((id, token) => id === 'halfclose-node' && token === 'halfclose-node:secret', 'halfclose-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('halfclose-node', { port })
    duplex.on('error', () => undefined) // shutdown errors converge on close
    const chunks: Buffer[] = []
    const got = new Promise<Buffer>((resolve) => {
      duplex.on('data', (c: Buffer) => chunks.push(c))
      duplex.on('end', () => resolve(Buffer.concat(chunks)))
      duplex.on('close', () => resolve(Buffer.concat(chunks)))
    })
    duplex.write('req') // keep write side open initially: close only after full response arrives
    const echoed = await withTimeout(got, 15_000, 'tunnel response did not finish')
    assert.equal(echoed.length, response.length, 'full response flushed back without trailing byte loss')
    assert.ok(echoed.equals(response), 'response contents match')
    duplex.destroy()
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('arbitrary TCP: abort during connection setup fails explicitly and cleans up', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'abort-node' && token === 'abort-node:secret', 'abort-node')
  try {
    assert.equal(hub.ready, true)
    // Immediate abort: explicit 499 aborted.
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: echo.port }, controller.signal),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'aborted',
    )
    // Target validation: invalid port or host fails explicitly with validation_error.
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: 0 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { host: 'bad host', port: 80 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    assert.deepEqual(hub.fabric.registry.debugTunnelCounts(), { pending: 0, active: 0 }, 'no leaked registry entries')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('arbitrary TCP: duplex destroys when daemon disconnects so consumers observe teardown', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'disc-node' && token === 'disc-node:secret', 'disc-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('disc-node', { port: echo.port })
    // Teardown emits a node_offline error on destroy: attach error listener to avoid unhandled errors.
    duplex.on('error', () => undefined)
    const closed = new Promise<void>((resolve) => duplex.once('close', resolve))
    // Disconnecting daemon triggers eviction and destroys active duplexes immediately instead of hanging.
    await hub.disconnectDaemon()
    await withTimeout(closed, 10_000, 'tunnel did not close after the daemon disconnected')
    assert.equal(duplex.destroyed, true, 'duplex is destroyed after daemon disconnects')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('nodeFetch HTTPS: local TLS fixture completes real TLS request over tunnel (two-phase child trust injection)', { timeout: 120_000 }, async () => {
  const fixture = new URL('./fixtures/tunnel-https-fixture.mts', import.meta.url).pathname
  const runFixture = (args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject)
      child.on('close', () => resolve({ stdout, stderr }))
    })
  // Phase 1: generate test CA and server certificate.
  const caPhase = await runFixture(['ca'], {})
  const paths = JSON.parse(caPhase.stdout.trim().split('\n').pop() ?? '{}') as {
    caCert?: string; key?: string; cert?: string; error?: string
  }
  assert.ok(paths.caCert !== undefined && paths.key !== undefined && paths.cert !== undefined, `CA generation failed: ${paths.error ?? caPhase.stderr}`)
  // Phase 2: inject NODE_EXTRA_CA_CERTS at child startup (Node reads it only on startup);
  // client verifies certificates via default trust store + test CA, never skipping TLS verification.
  const reqPhase = await runFixture(['request'], {
    NODE_EXTRA_CA_CERTS: paths.caCert,
    HELMX_TUNNEL_TLS_KEY: paths.key,
    HELMX_TUNNEL_TLS_CERT: paths.cert,
  })
  let result: { ok?: boolean; status?: number; body?: string; error?: string }
  try {
    result = JSON.parse(reqPhase.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    result = { ok: false, error: reqPhase.stderr || reqPhase.stdout || 'fixture produced no output' }
  }
  assert.equal(result.ok, true, `HTTPS tunnel fixture failed: ${result.error ?? ''} status=${result.status ?? ''} body=${result.body ?? ''}`)
  assert.equal(result.status, 200)
  assert.equal(result.body, 'https-echo:GET:/v1/x?k=v')
  // Clean up certificate directory.
  rmSync(join(paths.caCert!, '..'), { recursive: true, force: true })
})

test('nodeFetch HTTP: arbitrary non-loopback hostname + null body for HEAD/204', { timeout: 60_000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
    if (req.url === '/nocontent') { res.writeHead(204); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`http-echo:${req.method}:${req.url}`)
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const port = (server.address() as net.AddressInfo).port
  const hub = await startHub((id, token) => id === 'host-node' && token === 'host-node:secret', 'host-node')
  try {
    assert.equal(hub.ready, true)
    const fetchRemote = hub.fabric.nodeFetch('host-node')
    // Use localhost hostname (non-bare-IP) to verify host pass-through and node-side DNS resolution.
    const response = await fetchRemote(`http://localhost:${port}/v1/y`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'http-echo:GET:/v1/y')
    const head = await fetchRemote(`http://localhost:${port}/v1/y`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, null, 'HEAD body must be null')
    const noContent = await fetchRemote(`http://localhost:${port}/nocontent`)
    assert.equal(noContent.status, 204)
    assert.equal(noContent.body, null, '204 body must be null')
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('socketPath UDS tunnel + nodeHostEnv discovery across live Hub <-> node daemon', { timeout: 60_000 }, async () => {
  const sockDir = mkdtempSync(join(rootDir, 'uds-live-'))
  const sockPath = join(sockDir, 'herdr.sock')
  const sockets = new Set<net.Socket>()
  const uds = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        const req = JSON.parse(line) as { id: string; method: string }
        if (req.method === 'events.subscribe') {
          socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
          socket.write(`${JSON.stringify({ event: 'pane_updated', data: { pane_id: 'w1:p9' } })}\n`)
        } else {
          socket.end(`${JSON.stringify({ id: req.id, result: { ok: true, method: req.method } })}\n`)
        }
      }
    })
  })
  await new Promise<void>((resolve) => uds.listen(sockPath, resolve))

  const prevHubSocket = process.env.HERDR_SOCKET_PATH
  process.env.HERDR_SOCKET_PATH = '/hub-only/must-not-be-used.sock'
  const hub = await startHub(
    (id, token) => id === 'uds-node' && token === 'uds-node:secret',
    'uds-node',
    {
      hostEnvContext: {
        platform: 'linux',
        homeDir: '/home/remote',
        tempDir: '/tmp',
        getEnv: (name) => (name === 'HERDR_SOCKET_PATH' ? sockPath : undefined),
      },
    },
  )
  try {
    assert.equal(hub.ready, true)
    // 1. Hub discovers remote target env over live /ws/node (unaffected by Hub's own HERDR_SOCKET_PATH).
    const hostEnv = await hub.fabric.getNodeHostEnv('uds-node', { envKeys: ['HERDR_SOCKET_PATH'] })
    assert.equal(hostEnv.platform, 'linux')
    assert.equal(hostEnv.env['HERDR_SOCKET_PATH'], sockPath)

    // 2. One-shot NDJSON RPC over live /ws/node-tunnel socketPath stream.
    const rpcStream = await hub.fabric.openTunnel('uds-node', { socketPath: hostEnv.env['HERDR_SOCKET_PATH']! })
    rpcStream.write(`${JSON.stringify({ id: '1', method: 'ping', params: {} })}\n`)
    const rpcLine = await withTimeout(
      new Promise<string>((resolve, reject) => {
        let out = ''
        rpcStream.on('data', (c: Buffer) => {
          out += c.toString('utf8')
          const idx = out.indexOf('\n')
          if (idx >= 0) resolve(out.slice(0, idx))
        })
        rpcStream.once('error', reject)
      }),
      5_000,
      'rpc response over live UDS tunnel',
    )
    rpcStream.destroy()
    assert.deepEqual(JSON.parse(rpcLine), { id: '1', result: { ok: true, method: 'ping' } })

    // 3. Streaming events over live /ws/node-tunnel socketPath stream (ACK + event frames pass verbatim).
    const subStream = await hub.fabric.openTunnel('uds-node', { socketPath: hostEnv.env['HERDR_SOCKET_PATH']! })
    subStream.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: {} })}\n`)
    const subLines = await withTimeout(
      new Promise<string[]>((resolve, reject) => {
        let out = ''
        const lines: string[] = []
        subStream.on('data', (c: Buffer) => {
          out += c.toString('utf8')
          let idx = out.indexOf('\n')
          while (idx >= 0) {
            lines.push(out.slice(0, idx))
            out = out.slice(idx + 1)
            idx = out.indexOf('\n')
            if (lines.length >= 2) resolve(lines)
          }
        })
        subStream.once('error', reject)
      }),
      5_000,
      'subscription frames over live UDS tunnel',
    )
    subStream.destroy()
    assert.deepEqual(JSON.parse(subLines[0]!), { id: 'sub', result: { type: 'subscription_started' } })
    assert.deepEqual(JSON.parse(subLines[1]!), { event: 'pane_updated', data: { pane_id: 'w1:p9' } })
  } finally {
    if (prevHubSocket === undefined) delete process.env.HERDR_SOCKET_PATH
    else process.env.HERDR_SOCKET_PATH = prevHubSocket
    await hub.close()
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => uds.close(() => resolve()))
    rmSync(sockDir, { recursive: true, force: true })
  }
})
