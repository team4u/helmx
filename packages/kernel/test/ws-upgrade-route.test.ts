/**
 * Unit tests for the shared WS `upgrade` route (`attachWsUpgradeRoute`) used by `/ws/node` and `/ws/node-tunnel`:
 * - Demux by pathname: a route only claims its own path; other paths fall through untouched to sibling listeners.
 * - Matching upgrades delegate to the gateway's own `WebSocketServer.handleUpgrade` and hand the parsed URL
 *   (with query string) to the gateway connection handler.
 * - Malformed request URLs and upgrades arriving after the gateway began closing destroy the socket instead of
 *   hanging or registering into a dying gateway.
 * - The returned detach function removes the listener (gateway `close()`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import { attachWsUpgradeRoute } from '../src/env/ws-upgrade-route.js'

class FakeSocket extends EventEmitter {
  destroyed = false
  destroy(): this {
    this.destroyed = true
    return this
  }
}

const fakeWs = { readyState: 1 } as unknown as WebSocket

/** Minimal fake of the gateway-owned `WebSocketServer`: records `handleUpgrade` calls and completes the handshake. */
function fakeWss(): { wss: WebSocketServer; handled: number } {
  const state = { handled: 0 }
  const wss = {
    handleUpgrade(_request: IncomingMessage, _socket: Duplex, _head: Buffer, cb: (ws: WebSocket) => void) {
      state.handled += 1
      cb(fakeWs)
    },
  } as unknown as WebSocketServer
  return { wss, get handled() { return state.handled } }
}

function emitUpgrade(server: http.Server, requestUrl: string): FakeSocket {
  const socket = new FakeSocket()
  const request = { url: requestUrl } as unknown as IncomingMessage
  server.emit('upgrade', request, socket as unknown as Duplex, Buffer.alloc(0))
  return socket
}

test('upgrade route: claims only its own path and passes the parsed URL to the gateway', { timeout: 60_000 }, () => {
  const server = new http.Server()
  const connections: Array<{ ws: WebSocket; url: URL }> = []
  const gateway = fakeWss()
  const detach = attachWsUpgradeRoute(server, {
    wss: gateway.wss,
    path: '/ws/node',
    isClosing: () => false,
    onConnection: (ws, url) => connections.push({ ws, url }),
  })
  try {
    const siblingSeen: string[] = []
    server.on('upgrade', (request: IncomingMessage) => {
      siblingSeen.push(request.url ?? '')
    })

    const socket = emitUpgrade(server, '/ws/node?nodeId=n1')
    assert.ok(socket.destroyed === false, 'matching upgrade must not be destroyed')
    assert.equal(gateway.handled, 1, 'matching upgrade is delegated to the gateway WebSocketServer')
    assert.equal(connections.length, 1)
    assert.equal(connections[0]!.url.pathname, '/ws/node')
    assert.equal(connections[0]!.url.searchParams.get('nodeId'), 'n1', 'query string survives routing')
    assert.deepEqual(siblingSeen, ['/ws/node?nodeId=n1'], 'sibling listeners still observe the event stream')

    const other = emitUpgrade(server, '/ws/node-tunnel')
    assert.ok(other.destroyed === false, 'unrelated path falls through untouched')
    assert.equal(gateway.handled, 1, 'unrelated path is never delegated to this gateway')
    assert.equal(connections.length, 1)
    assert.deepEqual(siblingSeen, ['/ws/node?nodeId=n1', '/ws/node-tunnel'])
  } finally {
    detach()
  }
})

test('upgrade route: malformed request URL destroys the socket without touching the gateway', { timeout: 60_000 }, () => {
  const server = new http.Server()
  const gateway = fakeWss()
  const detach = attachWsUpgradeRoute(server, {
    wss: gateway.wss,
    path: '/ws/node',
    isClosing: () => false,
    onConnection: () => {},
  })
  try {
    const socket = emitUpgrade(server, '//%')
    assert.ok(socket.destroyed === true, 'malformed URL must destroy the socket instead of hanging')
    assert.equal(gateway.handled, 0)
  } finally {
    detach()
  }
})

test('upgrade route: upgrades after the gateway began closing are destroyed, not accepted', { timeout: 60_000 }, () => {
  const server = new http.Server()
  let closing = false
  const gateway = fakeWss()
  const detach = attachWsUpgradeRoute(server, {
    wss: gateway.wss,
    path: '/ws/node-tunnel',
    isClosing: () => closing,
    onConnection: () => {},
  })
  try {
    closing = true
    const socket = emitUpgrade(server, '/ws/node-tunnel')
    assert.ok(socket.destroyed === true, 'closing gateway destroys late upgrades')
    assert.equal(gateway.handled, 0, 'closing gateway never handles the upgrade')
    // Unrelated paths still fall through while closing (sibling gateways own their own lifecycle).
    const other = emitUpgrade(server, '/ws/other')
    assert.ok(other.destroyed === false)
  } finally {
    detach()
  }
})

test('upgrade route: detach removes the listener so a closed gateway stops claiming upgrades', { timeout: 60_000 }, () => {
  const server = new http.Server()
  const gateway = fakeWss()
  const detach = attachWsUpgradeRoute(server, {
    wss: gateway.wss,
    path: '/ws/node',
    isClosing: () => false,
    onConnection: () => {},
  })
  assert.equal(server.listenerCount('upgrade'), 1)
  detach()
  assert.equal(server.listenerCount('upgrade'), 0)
  emitUpgrade(server, '/ws/node')
  assert.equal(gateway.handled, 0, 'detached route no longer delegates')
})
