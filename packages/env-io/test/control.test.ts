import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { useTempDir } from '@helmx/test-kit/node'
import {
  controlEndpoint,
  controlRequest,
  createControlServer,
  CONTROL_TIMEOUT_MS,
  renderServiceSpec,
} from '../src/index.js'

test('controlEndpoint namespaces products and hashes dataDir+instanceId deterministically', { timeout: 60_000 }, () => {
  const hub = controlEndpoint('/data', 'abc', 'helmx-hub')
  const node = controlEndpoint('/data', 'abc', 'helmx-node')
  // The endpoint form follows the HOST platform: Windows named pipe vs Unix domain socket.
  const hubPattern = process.platform === 'win32'
    ? /^\\\\\.\\pipe\\helmx-hub-[0-9a-f]{16}$/
    : /^\/tmp\/helmx-hub-[0-9a-f]{16}\.sock$/
  const nodePattern = process.platform === 'win32'
    ? /^\\\\\.\\pipe\\helmx-node-[0-9a-f]{16}$/
    : /^\/tmp\/helmx-node-[0-9a-f]{16}\.sock$/
  assert.match(hub, hubPattern)
  assert.match(node, nodePattern)
  assert.notEqual(hub, node)
  assert.equal(hub, controlEndpoint('/data', 'abc', 'helmx-hub'), 'endpoint derivation is deterministic')
  assert.notEqual(hub, controlEndpoint('/other', 'abc', 'helmx-hub'))
  if (process.platform === 'win32') {
    assert.match(controlEndpoint('C:\\data', 'abc', 'helmx-hub'), /^\\\\\.\\pipe\\helmx-hub-[0-9a-f]{16}$/)
  }
})

test('control roundtrip: status answers with product-owned state, mismatched instanceId is rejected', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-envio-control-')
  // Route the endpoint into the temp dir so the test never touches the shared /tmp namespace on
  // platforms where the socket path is fixed; on Linux /tmp is fine but keep the pattern uniform.
  const dataDir = join(dir, 'data')
  const instanceId = 'a'.repeat(32)
  const endpoint = controlEndpoint(dataDir, instanceId, 'helmx-test')
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: process.pid, state: 'serving', version: '1.2.3' }),
    onStop: async () => {},
  })
  await server.listening
  t.after(() => server.close())

  const status = await controlRequest(endpoint, { type: 'status', instanceId }, CONTROL_TIMEOUT_MS, {
    pid: process.pid,
    instanceId,
  })
  assert.ok(status !== null && status.ok === true)
  assert.equal(status.state, 'serving')
  assert.equal(status.version, '1.2.3')
  assert.equal(status.pid, process.pid)

  const wrongInstance = await controlRequest(endpoint, { type: 'status', instanceId: 'b'.repeat(32) })
  assert.ok(wrongInstance !== null && wrongInstance.ok === false)
  assert.equal(wrongInstance.error, 'instance_mismatch')

  const wrongPid = await controlRequest(endpoint, { type: 'status', instanceId }, CONTROL_TIMEOUT_MS, { pid: 999999 })
  assert.equal(wrongPid, null, 'identity mismatch must surface as null (unverifiable), never a guessed success')

  const unknown = await controlRequest(endpoint, { type: 'upgrade' as const, instanceId })
  assert.ok(unknown !== null && unknown.ok === false)
  assert.equal(unknown.error, 'upgrade_not_supported')
})

test('control stop runs the handler, replies, and closes the server', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-envio-control-stop-')
  const dataDir = join(dir, 'data')
  const instanceId = 'c'.repeat(32)
  const endpoint = controlEndpoint(dataDir, instanceId, 'helmx-test')
  let stopped = 0
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: process.pid, state: 'serving' }),
    onStop: async () => {
      stopped += 1
    },
  })
  await server.listening
  t.after(() => server.close())

  const reply = await controlRequest(endpoint, { type: 'stop', instanceId }, 15_000, { pid: process.pid, instanceId })
  assert.ok(reply !== null && reply.ok === true)
  assert.equal(reply.state, 'stopping')
  assert.equal(stopped, 1)
  const after = await controlRequest(endpoint, { type: 'status', instanceId }, 500)
  assert.equal(after, null, 'server is closed after stop')
})

test('controlRequest settles immediately on server disconnect and preserves split multi-byte UTF-8 payloads', { timeout: 60_000 }, async (t) => {
  const net = await import('node:net')
  const dir = useTempDir(t, 'helmx-envio-control-utf8-')
  const disconnectEndpoint = controlEndpoint(join(dir, 'drop'), 'd'.repeat(32), 'helmx-drop')
  const dropServer = net.createServer((socket) => {
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    dropServer.once('error', reject)
    dropServer.listen(disconnectEndpoint, () => resolve())
  })
  t.after(async () => {
    await new Promise<void>((resolve) => dropServer.close(() => resolve()))
  })

  const startMs = Date.now()
  const dropped = await controlRequest(disconnectEndpoint, { type: 'status', instanceId: 'd'.repeat(32) }, 30_000)
  const elapsedMs = Date.now() - startMs
  assert.equal(dropped, null, 'abrupt server disconnect must settle as null')
  assert.ok(elapsedMs < 3_000, `expected immediate disconnect settlement, took ${elapsedMs}ms`)

  const utf8Instance = 'e'.repeat(32)
  const utf8Endpoint = controlEndpoint(join(dir, 'utf8'), utf8Instance, 'helmx-utf8')
  const richText = '状态正常-🚀-日本語-한국어'
  let receivedInput: unknown
  const server = createControlServer({
    endpoint: utf8Endpoint,
    instanceId: utf8Instance,
    onStatus: () => ({ pid: process.pid, state: richText }),
    onStop: async () => {},
    onUpgrade: async (input) => {
      receivedInput = input
      return { echoed: richText }
    },
  })
  await server.listening
  t.after(() => server.close())

  // Split multi-byte UTF-8 frame mid-codepoint on client -> server write and verify server StringDecoder
  const rawPayload = Buffer.from(
    `${JSON.stringify({ type: 'upgrade', instanceId: utf8Instance, input: { note: richText } })}\n`,
    'utf8',
  )
  const serverReply = await new Promise<string>((resolve, reject) => {
    const client = net.connect(utf8Endpoint)
    client.setEncoding('utf8')
    let acc = ''
    client.on('connect', () => {
      // Split across every 2 bytes so 3-byte and 4-byte UTF-8 codepoints straddle chunk boundaries
      let pos = 0
      const step = () => {
        if (pos >= rawPayload.length) return
        const end = Math.min(pos + 2, rawPayload.length)
        client.write(rawPayload.subarray(pos, end))
        pos = end
        if (pos < rawPayload.length) setTimeout(step, 2)
      }
      step()
    })
    client.on('data', (chunk: string) => {
      acc += chunk
      if (acc.includes('\n')) {
        client.destroy()
        resolve(acc.trim())
      }
    })
    client.on('error', reject)
  })
  assert.deepEqual(receivedInput, { note: richText })
  const parsedServerReply = JSON.parse(serverReply) as { ok: boolean; state: string; result: { echoed: string } }
  assert.equal(parsedServerReply.ok, true)
  assert.equal(parsedServerReply.state, richText)
  assert.equal(parsedServerReply.result.echoed, richText)

  // Split multi-byte UTF-8 response mid-codepoint on server -> client write and verify controlRequest StringDecoder
  const splitSrvEndpoint = controlEndpoint(join(dir, 'split-srv'), utf8Instance, 'helmx-split')
  const splitReplyBytes = Buffer.from(
    `${JSON.stringify({ ok: true, pid: process.pid, instanceId: utf8Instance, state: richText })}\n`,
    'utf8',
  )
  const splitServer = net.createServer((socket) => {
    socket.once('data', () => {
      let pos = 0
      const step = () => {
        const end = Math.min(pos + 2, splitReplyBytes.length)
        socket.write(splitReplyBytes.subarray(pos, end))
        pos = end
        if (pos < splitReplyBytes.length) setTimeout(step, 2)
        else socket.end()
      }
      step()
    })
  })
  await new Promise<void>((resolve, reject) => {
    splitServer.once('error', reject)
    splitServer.listen(splitSrvEndpoint, () => resolve())
  })
  t.after(async () => {
    await new Promise<void>((resolve) => splitServer.close(() => resolve()))
  })

  const clientRes = await controlRequest(splitSrvEndpoint, { type: 'status', instanceId: utf8Instance }, 5_000, {
    pid: process.pid,
    instanceId: utf8Instance,
  })
  assert.ok(clientRes !== null && clientRes.ok === true)
  assert.equal(clientRes.state, richText)
})

test('os-service renderer is profile-driven (hub and node units differ only through the profile)', { timeout: 60_000 }, () => {
  const hub = renderServiceSpec({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliEntryPath: '/opt/cli.js',
    dataDir: '/data',
    profile: {
      darwinLabel: 'ai.helmx.hub',
      linuxUnit: 'helmx-hub.service',
      winTask: 'HelmxHub',
      description: 'Helmx Hub',
      cliArgs: ['start', '--data-dir', '/data'],
      logPath: '/data/hub.log',
    },
    serviceHome: '/tmp/home',
  })
  assert.equal(hub.targetPath, '/tmp/home/.config/systemd/user/helmx-hub.service')
  assert.ok(hub.content.includes('Description=Helmx Hub'))
  assert.ok(hub.content.includes('Restart=always'))
  assert.ok(hub.content.includes('/opt/cli.js start --data-dir /data'))
  assert.deepEqual(hub.installCmd, ['systemctl', '--user', 'enable', '--now', 'helmx-hub.service'])

  const darwin = renderServiceSpec({
    platform: 'darwin',
    nodePath: '/usr/local/bin/node',
    cliEntryPath: '/opt/cli.js',
    dataDir: '/data',
    profile: {
      darwinLabel: 'top.helmx.hub',
      linuxUnit: 'helmx-hub.service',
      winTask: 'HelmxHub',
      description: 'Helmx Hub',
      cliArgs: ['start'],
      logPath: '/data/hub.log',
    },
    serviceHome: '/tmp/home',
  })
  assert.equal(darwin.targetPath, '/tmp/home/Library/LaunchAgents/top.helmx.hub.plist')
  assert.ok(darwin.content.includes('<string>top.helmx.hub</string>'))
  assert.ok(darwin.content.includes('<string>/data/hub.log</string>'))
})
