/**
 * Kernel-side consumption semantics for node upgrade draining (`node_draining`):
 * - fabric.openTunnel (TCP & socketPath): rejecting new tunnels during draining throws HelmxError
 *   `node_draining` (503), distinct from `node_tunnel_failed` (502) / `node_offline` (409);
 * - fabric.getNodeHostEnv: read-only host env discovery succeeds while draining;
 * - remote-env exec: when the node returns `node_draining` from envExec, the error code passes
 *   through untouched (never collapsed into aborted/unknown), fails immediately without waiting for
 *   reconnect (the node is online; draining != offline); genuine cancellations remain `aborted`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { HelmxError, type NodeEnvRpcFunctions } from '@helmx/protocol'
import type { WebSocket as WsSocket } from 'ws'
import { createEnvFabric } from '../src/env/fabric.js'
import { NodeRegistry } from '../src/env/registry.js'
import { RemoteExecutionEnv, type NodeRpcResolver } from '../src/env/remote-env.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

/** Registers a fake node (constant auth) with arbitrary injected env RPC handlers. */
async function registerFakeNode(registry: NodeRegistry, nodeId: string, rpc: Record<string, unknown>): Promise<FakeSocket> {
  const socket = new FakeSocket()
  const outcome = await registry.register(
    socket as unknown as WsSocket,
    { nodeId, token: `${nodeId}:secret`, hostname: 'h', platform: 'linux' },
    () => ({ $close() {}, ...rpc }) as never,
  )
  assert.equal(outcome.accepted, true)
  return socket
}

test('fabric.openTunnel (socketPath): draining rejection throws HelmxError node_draining (503)', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(fabric.registry, 'drain-node', {
      nodeTunnelOpen: async () => ({
        ok: false,
        error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new tunnels' },
      }),
      nodeTunnelAbort: async () => undefined,
    })
    await assert.rejects(
      fabric.openTunnel('drain-node', { socketPath: '/tmp/herdr.sock' }),
      (error: unknown) =>
        error instanceof HelmxError && error.code === 'node_draining' && error.status === 503 && /draining/.test(error.message),
    )
    socket.close()
  } finally {
    await fabric.dispose()
  }
})

test('fabric.getNodeHostEnv: read-only discovery passes through target node env snapshot while draining', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(fabric.registry, 'drain-env-node', {
      nodeHostEnv: async () => ({
        ok: true,
        value: {
          platform: 'win32',
          homeDir: 'C:\\Users\\dev',
          tempDir: 'C:\\Users\\dev\\AppData\\Local\\Temp',
          dirs: { appData: 'C:\\Users\\dev\\AppData\\Roaming', userProfile: 'C:\\Users\\dev' },
          env: { HERDR_SOCKET_PATH: '\\\\.\\pipe\\herdr-dev' },
        },
      }),
    })
    const snapshot = await fabric.getNodeHostEnv('drain-env-node', { envKeys: ['HERDR_SOCKET_PATH'] })
    assert.equal(snapshot.platform, 'win32')
    assert.equal(snapshot.dirs.appData, 'C:\\Users\\dev\\AppData\\Roaming')
    assert.equal(snapshot.env['HERDR_SOCKET_PATH'], '\\\\.\\pipe\\herdr-dev')
    socket.close()
  } finally {
    await fabric.dispose()
  }
})

test('remote-env exec: node_draining passes through intact (not aborted/unknown) without waiting for reconnect', { timeout: 60_000 }, async () => {
  let waitCalled = 0
  const drainingRpc = {
    envExec: async () => ({
      ok: false,
      error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new commands' },
    }),
    envAbortExec: async () => undefined,
  } as unknown as NodeEnvRpcFunctions
  const resolver: NodeRpcResolver = {
    getNodeEnvRpc: () => drainingRpc,
    // The node is online while draining: must never branch to waitForNodeOnline (doing so is a semantic bug).
    waitForNodeOnline: () => {
      waitCalled += 1
      return Promise.resolve(drainingRpc)
    },
  }
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'draining-node', cwd: '/w' })

  const startedAt = Date.now()
  const result = await env.exec('echo hi', undefined, BACKGROUND_CONTEXT)
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  // Error code passes through unchanged so callers distinguish upgrade draining from aborted/unknown
  // rather than collapsing them together.
  assert.equal(!result.ok && result.error.code, 'node_draining')
  assert.match(!result.ok ? result.error.message : '', /draining/)
  // Fails immediately within bounded time without entering reconnect wait.
  assert.ok(elapsed < 2_000, `must return within bounded time (actual ${elapsed}ms)`)
  assert.equal(waitCalled, 0, 'draining rejection while node is online must not trigger waitForNodeOnline')
})

test('remote-env exec: genuine cancellation still reports aborted (no regression from draining changes)', { timeout: 60_000 }, async () => {
  const rpc = {
    // Simulates user cancellation: node aborts the command and returns aborted over RPC.
    envExec: async () => ({ ok: false, error: { code: 'aborted', message: 'Command aborted' } }),
    envAbortExec: async () => undefined,
  } as unknown as NodeEnvRpcFunctions
  const resolver: NodeRpcResolver = { getNodeEnvRpc: () => rpc }
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'cancel-node', cwd: '/w' })
  const controller = new AbortController()
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
  const result = await env.exec('sleep 5', undefined, context)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'aborted', 'genuine cancellation must remain aborted')
})
