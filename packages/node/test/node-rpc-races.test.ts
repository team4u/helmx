import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { deferred } from '@helmx/test-kit'
import { useTempDir } from '@helmx/test-kit/node'
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js'

test('node does not inherit case-variant Helmx_Token from host environment', { timeout: 60_000 }, async () => {
  const previous = process.env.Helmx_Token
  process.env.Helmx_Token = 'mixed-case-host-credential'
  let output = ''
  const rpc = createNodeEnvRpcServer({ defaultCwd: process.cwd(), onExecOutput: (event) => { output += event.text } })
  try {
    const result = await rpc.envExec({ execId: 'mixed-token', command: [process.execPath, '-e', 'process.stdout.write(process.env.Helmx_Token ?? "absent")'] })
    assert.equal(result.ok, true)
    assert.equal(output, 'absent')
  } finally {
    if (previous === undefined) delete process.env.Helmx_Token
    else process.env.Helmx_Token = previous
    await rpc.dispose()
  }
})

test('opening a binary reader concurrently with dispose leaks no handles', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-reader-race-')
  await writeFile(join(dir, 'file.txt'), 'content')
  for (let index = 0; index < 20; index++) {
    const server = createNodeEnvRpcServer({ defaultCwd: dir })
    const pending = server.envOpenBinaryReader({ path: 'file.txt' })
    const firstClose = server.dispose()
    assert.equal(server.dispose(), firstClose, 'dispose should return the same draining promise')
    await firstClose
    await pending
    assert.equal(server.getOpenReaderCount(), 0)
    const late = await server.envOpenBinaryReader({ path: 'file.txt' })
    assert.equal(late.ok, false)
    if (!late.ok) assert.equal(late.error.code, 'aborted')
  }
})

test('TCP tunnel destroys peer cleanly on dispose during WS tunnel handshake', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-tcp-handshake-race-')
  const sockets = new Set<net.Socket>()
  const connected = deferred()
  const tcp = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    connected.resolve()
  })
  const rpc = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: () => new Promise<PassThrough>(() => undefined),
  })
  try {
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve) })
    const port = (tcp.address() as net.AddressInfo).port
    const opening = rpc.nodeTunnelOpen({ tunnelId: 'tcp-race-1', host: '127.0.0.1', port, timeoutMs: 30_000 })
    await connected.promise
    await rpc.dispose()
    const result = await opening
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'aborted')
    assert.equal(rpc.getActiveTunnelCount(), 0)
  } finally {
    await rpc.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
  }
})

test('TCP tunnel abort cancels pending handshake and cleans up active count', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-tcp-abort-race-')
  const sockets = new Set<net.Socket>()
  const connected = deferred()
  const tcp = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    connected.resolve()
  })
  const rpc = createNodeEnvRpcServer({
    defaultCwd: dir,
    openTunnelStream: () => new Promise<PassThrough>(() => undefined),
  })
  try {
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve) })
    const port = (tcp.address() as net.AddressInfo).port
    const opening = rpc.nodeTunnelOpen({ tunnelId: 'tcp-abort-1', host: '127.0.0.1', port, timeoutMs: 30_000 })
    await connected.promise
    assert.equal(rpc.getActiveTunnelCount(), 1)
    await rpc.nodeTunnelAbort('tcp-abort-1')
    const result = await opening
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'aborted')
    assert.equal(rpc.getActiveTunnelCount(), 0)
  } finally {
    await rpc.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => tcp.close(() => resolve()))
  }
})
