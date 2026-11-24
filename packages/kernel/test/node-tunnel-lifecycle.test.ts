import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { once } from 'node:events'
import { createEnvFabric } from '../src/env/fabric.js'

test('local tunnel: dispose closes active and in-flight connections and rejects new tunnels once closed', { timeout: 60_000 }, async (t) => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, { timeout: 60_000 })
  const fabric = createEnvFabric({})
  const duplex = await fabric.openTunnel('local', { port })
  const closed = once(duplex, 'close')
  await fabric.dispose()
  await closed
  assert.equal(duplex.destroyed, true)
  await assert.rejects(fabric.openTunnel('local', { port }), { code: 'node_offline' })

  const openingFabric = createEnvFabric({})
  const opening = openingFabric.openTunnel('local', { port })
  const rejected = assert.rejects(opening, { code: 'aborted' })
  await openingFabric.dispose()
  await rejected
})
