/** Node gateway: one birpc instance per connection, shared by control plane and env RPC. */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type { NodeHeartbeatInput, NodeRegisterInput, NodeRegisterResult } from '@helmx/protocol'
import type { HubConnectionLocal, NodeRegistry, NodeSideFunctions } from './registry.js'

export interface NodeWsGatewayOptions {
  registry: NodeRegistry
  path?: string
  registerTimeoutMs?: number
  maxPayload?: number
  log?: (message: string) => void
}
export interface NodeWsGateway { readonly onlineCount: number; close(): Promise<void> }

/** Max WS frame size after registration (accommodates 64 MiB base64 binary transfer + JSON RPC envelope). */
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 128 * 1024 * 1024
/** Tight pre-registration frame cap to reject oversized unauthenticated payloads immediately. */
const PRE_REGISTER_MAX_BYTES = 64 * 1024

export function attachNodeWsGateway(server: HttpServer, options: NodeWsGatewayOptions): NodeWsGateway {
  const {
    registry,
    path = '/ws/node',
    registerTimeoutMs = 10_000,
    maxPayload = DEFAULT_MAX_WS_PAYLOAD_BYTES,
    // Never swallow single-send/dispatch errors silently (honest discipline): defaults to console.error;
    // only terminates the connection when the socket is already non-OPEN (send failure caused by disconnect).
    log = (message: string) => console.error(`[helmx] node gateway: ${message}`),
  } = options
  const wss = new WebSocketServer({ noServer: true, maxPayload })
  let closing: Promise<void> | undefined
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== path) return
    if (closing) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, url.searchParams.get('nodeId')))
  }
  server.on('upgrade', onUpgrade)

  function handleConnection(ws: WebSocket, routedNodeId: string | null): void {
    let callbacks: HubConnectionLocal | undefined
    let registering = false
    let registered = false
    const registerTimer = setTimeout(() => ws.close(4001, 'register timeout'), registerTimeoutMs)
    registerTimer.unref()
    const local = {
      async register(input: NodeRegisterInput): Promise<NodeRegisterResult> {
        if (registering || registered || !input || (routedNodeId !== null && routedNodeId !== input.nodeId)) {
          ws.close(4003, 'invalid registration')
          return { ok: false, heartbeatMs: 0, reason: 'invalid registration' }
        }
        registering = true
        const outcome = await registry.register(ws, input, (bound) => { callbacks = bound; return rpc })
        registering = false
        if (!outcome.accepted) {
          setTimeout(() => ws.close(4003, 'register rejected'), 10).unref()
          return { ok: false, heartbeatMs: 0, reason: outcome.reason }
        }
        registered = true
        clearTimeout(registerTimer)
        return { ok: true, heartbeatMs: outcome.heartbeatMs ?? registry.heartbeatIntervalMs }
      },
      heartbeat: (nodeId: string, input?: NodeHeartbeatInput) => registry.noteHeartbeat(nodeId, ws, input),
      onEnvExecOutput: (event: Parameters<HubConnectionLocal['onEnvExecOutput']>[0]) => callbacks?.onEnvExecOutput(event),
    }
    const rpc = createBirpc<NodeSideFunctions, typeof local>(local, {
      post: (data) => {
        if (ws.readyState !== ws.OPEN) throw new Error('node connection closed')
        ws.send(JSON.stringify(data))
      },
      on: (dispatch) => {
        ws.on('message', (raw) => {
          if (!registered) {
            const bytes = typeof raw === 'string'
              ? Buffer.byteLength(raw)
              : Array.isArray(raw)
                ? raw.reduce((sum, buf) => sum + buf.length, 0)
                : raw instanceof ArrayBuffer
                  ? raw.byteLength
                  : raw.length
            if (bytes > PRE_REGISTER_MAX_BYTES) {
              ws.close(1009, 'register frame exceeds byte limit')
              return
            }
          }
          let data: unknown
          try { data = JSON.parse(raw.toString()) } catch { ws.close(1007, 'invalid JSON'); return }
          if (!data || typeof data !== 'object' || Array.isArray(data)) { ws.close(1007, 'invalid RPC frame'); return }
          void dispatch(data)
        })
      },
      // Only terminate when socket is already non-OPEN (send failure from disconnect): do not kill a healthy
      // connection on a transient single send error (e.g. temporary backpressure); let subsequent sends or close events handle it.
      onGeneralError: (error, type) => {
        log(`node RPC transport error (${type}): ${error instanceof Error ? error.message : String(error)}`)
        if (ws.readyState !== ws.OPEN) ws.terminate()
        return true
      },
      serialize: (data) => data,
      deserialize: (data) => data as never,
      timeout: 30 * 60 * 1000,
    })
    const cleanup = (): void => { clearTimeout(registerTimer); rpc.$close() }
    ws.once('close', cleanup)
    ws.once('error', () => { cleanup(); ws.terminate() })
  }
  return {
    get onlineCount() { return registry.list().length },
    close() {
      if (!closing) closing = (async () => {
        server.removeListener('upgrade', onUpgrade)
        for (const socket of wss.clients) socket.terminate()
        await registry.close()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
      })()
      return closing
    },
  }
}
