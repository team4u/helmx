/**
 * Shared `upgrade` routing for the node WS gateways (`/ws/node` and `/ws/node-tunnel`).
 *
 * Both gateways listen on one HTTP server's `upgrade` event and demux by pathname: a route only claims
 * requests for its own `path` and leaves every other path untouched so the sibling gateway (or any other
 * upgrade consumer) can claim it. Malformed request URLs destroy the socket instead of leaving it hanging.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'

export interface WsUpgradeRouteOptions {
  /** Gateway-owned server; `handleUpgrade` is delegated back to it so its per-gateway `maxPayload` stays authoritative. */
  readonly wss: WebSocketServer
  readonly path: string
  /** True once the gateway began closing: late upgrades are destroyed instead of being accepted into a dying gateway. */
  readonly isClosing: () => boolean
  readonly onConnection: (ws: WebSocket, url: URL) => void
}

/** Attach the `upgrade` listener and return its detach function (called from the gateway's `close()`). */
export function attachWsUpgradeRoute(server: HttpServer, options: WsUpgradeRouteOptions): () => void {
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== options.path) return
    if (options.isClosing()) { socket.destroy(); return }
    options.wss.handleUpgrade(request, socket, head, (ws) => options.onConnection(ws, url))
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.removeListener('upgrade', onUpgrade)
  }
}
