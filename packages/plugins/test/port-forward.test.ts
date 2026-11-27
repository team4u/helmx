/**
 * `builtin:port-forward` unit & real-TCP forwarding integration tests:
 * - Input validation (port range 1..65535, reserved Hub ports, host syntax,
 *   allowPublicBind security policy, wildcard 0.0.0.0 / :: conflict matrix);
 * - Real TCP round-trip forwarding via `ctx.host.openTunnel`, connection counters,
 *   and secret redaction on error paths;
 * - Durable `rules` doc flush-before-listen vs transient `runtime` doc (`durable: false`);
 * - Listen error (`EADDRINUSE`) explicit 409 + clean rollback on `create` and `update`;
 * - Orthogonal state when target remote node is offline (Hub keeps port bound, incoming
 *   socket gets closed and `lastError` records `node_offline`);
 * - Lifecycle & governance: `inUse()` blocks `disable` (`409 plugin_in_use`, `--force` closes
 *   listeners), active `openTunnel` blocks `disable` (`409 plugin_has_live_tasks`), `pause_runtime`
 *   evicts listeners & tunnels while keeping persisted `enabled: true` for `reconcile()` recovery,
 *   and `stop()` clears pending timers cleanly without unhandled rejections.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { HelmxError } from '@helmx/protocol'
import { PluginHost } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  PORT_FORWARD_PLUGIN_ID,
  PORT_FORWARD_RULES_DOC,
  PORT_FORWARD_RUNTIME_DOC,
  createPortForwardPlugin,
} from '../src/port-forward.js'
import {
  assertListenHostAllowed,
  assertNoListenConflict,
  listenEndpointsConflict,
  normalizeHost,
  normalizePort,
} from '../src/port-forward/validation.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  assertNoUnhandledRejection,
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>()
    const srv = net.createServer((sock) => {
      sockets.add(sock)
      sock.once('close', () => sockets.delete(sock))
      sock.pipe(sock)
    })
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy()
            srv.close(() => res())
          }),
      })
    })
  })
}

function tcpRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    client.once('error', reject)
    client.once('connect', () => {
      client.write(payload)
    })
    client.on('data', (chunk) => {
      chunks.push(chunk)
      const joined = Buffer.concat(chunks).toString('utf8')
      if (joined.length >= payload.length) {
        client.end()
        resolve(joined)
      }
    })
  })
}

function openTcpHold(port: number): Promise<{ close: () => Promise<void>; waitClosed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1')
    const closed = deferred<void>()
    client.once('error', (err) => {
      closed.resolve()
      reject(err)
    })
    client.once('close', () => closed.resolve())
    client.once('connect', () => {
      resolve({
        waitClosed: closed.promise,
        close: () =>
          new Promise<void>((res) => {
            if (client.destroyed) {
              res()
              return
            }
            client.once('close', () => res())
            client.destroy()
          }),
      })
    })
  })
}

async function openPortForwardHost(opts: {
  initialConfig?: Record<string, unknown>
  onlineNodes?: Set<string>
  onOpenTunnel?: (nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) => Promise<net.Socket | PassThrough>
} = {}) {
  const dataDir = await makeTempDir('helmx-pf-test-')
  const docs = new MemoryDocStore()
  const config = new MemoryConfigStore(opts.initialConfig)
  const onlineNodes = opts.onlineNodes ?? new Set(['local'])
  const baseFixture = createPluginHostBackendFixture()

  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    config,
    host: {
      ...baseFixture,
      emitEvent: () => {},
      onEvent: () => () => {},
      redact: (text: string) => text.replace(/secret_token_123/g, '[REDACTED]'),
      nodeIpc: {
        isOnline: (nodeId: string) => onlineNodes.has(nodeId),
      },
      openTunnel: async (nodeId, target, signal) => {
        if (opts.onOpenTunnel !== undefined) {
          return await opts.onOpenTunnel(nodeId, target, signal)
        }
        if (!onlineNodes.has(nodeId)) {
          throw new HelmxError('node_offline', `node ${nodeId} is offline`, 409, { nodeId })
        }
        if (signal?.aborted) {
          throw new HelmxError('aborted', 'tunnel aborted', 499)
        }
        return await new Promise<net.Socket>((resolve, reject) => {
          const sock = net.connect(target.port, target.host ?? '127.0.0.1')
          const onAbort = () => {
            sock.destroy()
            reject(new HelmxError('aborted', 'tunnel aborted', 499))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          sock.once('error', (err) => {
            signal?.removeEventListener('abort', onAbort)
            reject(new HelmxError('node_tunnel_connect_failed', err.message, 502))
          })
          sock.once('connect', () => {
            signal?.removeEventListener('abort', onAbort)
            resolve(sock)
          })
        })
      },
    },
  })

  return {
    host,
    docs,
    config,
    onlineNodes,
    async start() {
      await host.register(createPortForwardPlugin(), { enabled: true })
      await host.start()
      await host.reconcile()
    },
    async close() {
      await host.dispose().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

test('validation: port bounds, reserved Hub ports, host syntax, allowPublicBind policy, and wildcard conflicts', TIMEOUT, () => {
  assert.equal(normalizePort(8080, 'listenPort'), 8080)
  assert.throws(() => normalizePort(0, 'listenPort'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => normalizePort(65536, 'listenPort'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => normalizePort(3202, 'listenPort'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => normalizePort(3201, 'listenPort'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  // Reserved Hub ports are allowed as targetPort (e.g. forwarding a remote node's port 3000)
  assert.equal(normalizePort(3000, 'targetPort'), 3000)

  assert.equal(normalizeHost(' [::1] ', 'listenHost'), '::1')
  assert.equal(normalizeHost(undefined, 'listenHost'), '127.0.0.1')
  assert.throws(() => normalizeHost('127.0.0.1:8080', 'listenHost'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => normalizeHost('*', 'listenHost'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')

  assertListenHostAllowed('127.0.0.1', false)
  assertListenHostAllowed('::1', false)
  assertListenHostAllowed('localhost', false)
  assert.throws(() => assertListenHostAllowed('0.0.0.0', false), (e: unknown) => e instanceof HelmxError && e.code === 'public_bind_disabled' && e.status === 403)
  assertListenHostAllowed('0.0.0.0', true)
  assertListenHostAllowed('::', true)

  assert.equal(listenEndpointsConflict({ listenHost: '0.0.0.0', listenPort: 9000 }, { listenHost: '127.0.0.1', listenPort: 9000 }), true)
  assert.equal(listenEndpointsConflict({ listenHost: '::', listenPort: 9000 }, { listenHost: '127.0.0.1', listenPort: 9000 }), true)
  assert.equal(listenEndpointsConflict({ listenHost: 'localhost', listenPort: 9000 }, { listenHost: '127.0.0.1', listenPort: 9000 }), true)
  assert.equal(listenEndpointsConflict({ listenHost: '127.0.0.1', listenPort: 9000 }, { listenHost: '::1', listenPort: 9000 }), false)
  assert.equal(listenEndpointsConflict({ listenHost: '127.0.0.1', listenPort: 9000 }, { listenHost: '127.0.0.1', listenPort: 9001 }), false)

  assert.throws(
    () =>
      assertNoListenConflict(
        { listenHost: '0.0.0.0', listenPort: 9100 },
        [
          {
            id: 'r1',
            name: 'existing',
            nodeId: 'local',
            listenHost: '127.0.0.1',
            listenPort: 9100,
            targetHost: '127.0.0.1',
            targetPort: 9200,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ),
    (e: unknown) => e instanceof HelmxError && e.code === 'port_forward_conflict' && e.status === 409,
  )
})

test('forwarding: real TCP round-trip, durable rules vs non-durable runtime doc, and connection counts', TIMEOUT, async () => {
  const echo = await startEchoServer()
  const listenPort = await reserveFreePort()
  const env = await openPortForwardHost()
  try {
    await env.start()

    const created = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
      name: 'echo-svc',
      nodeId: 'local',
      listenPort,
      targetPort: echo.port,
    })) as { item: { id: string; listenerState: string; enabled: boolean } }

    assert.equal(created.item.enabled, true)
    assert.equal(created.item.listenerState, 'listening')

    // Durable rules doc was flushed; transient runtime doc must NEVER be written to durable MemoryDocStore.
    assert.ok(env.docs.flushCount >= 1, 'rules doc must be flushed on create')
    assert.equal(env.docs.has(`${PORT_FORWARD_PLUGIN_ID}:${PORT_FORWARD_RULES_DOC}`), true)
    assert.equal(env.docs.has(`${PORT_FORWARD_PLUGIN_ID}:${PORT_FORWARD_RUNTIME_DOC}`), false)

    // Public snapshot exposes both rules and live runtime docs.
    const runtimeSnap = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
      byId: Record<string, { listenerState: string; activeConnections: number; totalConnections: number }>
    }
    assert.equal(runtimeSnap.byId[created.item.id]?.listenerState, 'listening')

    // Round-trip TCP traffic across the Hub listener -> openTunnel -> echo server.
    const reply = await tcpRoundTrip(listenPort, 'hello-helmx-tunnel')
    assert.equal(reply, 'hello-helmx-tunnel')

    await waitFor(
      () => {
        const snap = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
          byId: Record<string, { activeConnections: number; totalConnections: number }>
        }
        return snap.byId[created.item.id]?.activeConnections === 0 &&
          (snap.byId[created.item.id]?.totalConnections ?? 0) >= 1
      },
      { timeoutMs: 5_000, message: 'activeConnections returns to 0 after disconnect' },
    )

    const listed = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'list', {})) as {
      items: Array<{ id: string; totalConnections: number; nodeOnline?: boolean }>
      allowPublicBind: boolean
    }
    assert.equal(listed.allowPublicBind, false)
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0]?.nodeOnline, true)
    assert.ok((listed.items[0]?.totalConnections ?? 0) >= 1)
  } finally {
    await env.close()
    await echo.close()
  }
})

test('error handling: EADDRINUSE rolls back create/update cleanly and offline remote node stays bound while redacting errors', TIMEOUT, async () => {
  const occupied = await startEchoServer()
  const freePort = await reserveFreePort()
  const env = await openPortForwardHost({
    onlineNodes: new Set(['local']),
    onOpenTunnel: async (nodeId) => {
      throw new HelmxError('node_offline', `node ${nodeId} offline with secret_token_123`, 409)
    },
  })
  try {
    await env.start()

    // 1. Creating a rule bound to an OS-occupied port fails explicitly and rolls back persisted rules & runtime entry.
    await assertRejectsCode(
      () =>
        env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
          name: 'occupied-port',
          nodeId: 'local',
          listenPort: occupied.port,
          targetPort: 9999,
        }),
      'port_forward_listen_failed',
      409,
    )
    const afterFailedCreate = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'list', {})) as {
      items: unknown[]
    }
    assert.equal(afterFailedCreate.items.length, 0, 'failed create must not leave broken rule persisted')
    const rtAfterFail = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
      byId: Record<string, unknown>
    }
    assert.deepEqual(rtAfterFail.byId, {}, 'failed create must not leave orphan runtime entry')

    // 2. Create a rule targeting an offline remote node: Hub still binds freePort so port cannot be hijacked.
    const remoteRule = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
      name: 'remote-db',
      nodeId: 'gpu-offline',
      listenPort: freePort,
      targetPort: 5432,
    })) as { item: { id: string; listenerState: string; nodeOnline?: boolean } }
    assert.equal(remoteRule.item.listenerState, 'listening')
    assert.equal(remoteRule.item.nodeOnline, false)

    // Incoming client connects to Hub port, dial fails with node_offline, secret is redacted, socket closes cleanly.
    await new Promise<void>((resolve) => {
      const c = net.connect(freePort, '127.0.0.1')
      c.once('close', () => resolve())
      c.once('error', () => resolve())
    })

    await waitFor(
      () => {
        const snap = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
          byId: Record<string, { lastError?: string }>
        }
        return snap.byId[remoteRule.item.id]?.lastError !== undefined
      },
      { timeoutMs: 5_000, message: 'lastError recorded on offline node dial failure' },
    )
    const snap = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
      byId: Record<string, { lastError?: string }>
    }
    assert.ok(snap.byId[remoteRule.item.id]?.lastError?.includes('[REDACTED]'))
    assert.equal(snap.byId[remoteRule.item.id]?.lastError?.includes('secret_token_123'), false)

    // 3. Updating remoteRule to occupied port fails and restores the previous listener on freePort without mutating rules.
    await assertRejectsCode(
      () =>
        env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'update', {
          id: remoteRule.item.id,
          listenPort: occupied.port,
        }),
      'port_forward_listen_failed',
      409,
    )
    const afterFailedUpdate = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'list', {})) as {
      items: Array<{ id: string; listenPort: number; listenerState: string }>
    }
    assert.equal(afterFailedUpdate.items[0]?.listenPort, freePort)
    assert.equal(afterFailedUpdate.items[0]?.listenerState, 'listening')
  } finally {
    await env.close()
    await occupied.close()
  }
})

test('governance & lifecycle: inUse/liveTasks guards, pause_runtime preserves enabled for reload/reconcile, and stop cleans up without rejections', TIMEOUT, async () => {
  await assertNoUnhandledRejection(async () => {
    const echo = await startEchoServer()
    const listenPort = await reserveFreePort()
    const env = await openPortForwardHost()
    try {
      await env.start()

      const created = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
        name: 'persistent-rule',
        nodeId: 'local',
        listenPort,
        targetPort: echo.port,
      })) as { item: { id: string } }

      // 1. Idle listener triggers 409 plugin_in_use on disable without force.
      await assertRejectsCode(() => env.host.disable(PORT_FORWARD_PLUGIN_ID), 'plugin_in_use', 409)

      // 2. Open an active TCP connection -> openTunnel liveTasks blocks even disable({ force: true }) with 409 plugin_has_live_tasks.
      const held = await openTcpHold(listenPort)
      await waitFor(
        () => {
          const snap = env.host.getPublicDoc(PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_RUNTIME_DOC).value as {
            byId: Record<string, { activeConnections: number }>
          }
          return (snap.byId[created.item.id]?.activeConnections ?? 0) === 1
        },
        { timeoutMs: 5_000, message: 'held connection increments activeConnections to 1' },
      )

      await assertRejectsCode(
        () => env.host.disable(PORT_FORWARD_PLUGIN_ID, { force: true }),
        'plugin_has_live_tasks',
        409,
      )

      // 3. pause_runtime closes active tunnels and listeners while keeping persisted enabled=true!
      const paused = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'pause_runtime', {})) as {
        stoppedListeners: number
        closedConnections: number
      }
      assert.equal(paused.stoppedListeners, 1)
      assert.equal(paused.closedConnections, 1)
      await held.waitClosed

      const rulesBeforeDisable = env.docs.peek<{ items: Array<{ enabled: boolean }> }>(
        `${PORT_FORWARD_PLUGIN_ID}:${PORT_FORWARD_RULES_DOC}`,
      )
      assert.equal(rulesBeforeDisable?.items[0]?.enabled, true, 'pause_runtime preserves persisted enabled=true')

      // Now disable succeeds cleanly with zero liveTasks and zero inUse items!
      await env.host.disable(PORT_FORWARD_PLUGIN_ID)
      assert.equal(env.host.get(PORT_FORWARD_PLUGIN_ID)?.enabled, false)

      // Re-enable + reconcile automatically restores the listening port because enabled=true was preserved!
      await env.host.enable(PORT_FORWARD_PLUGIN_ID)
      await env.host.reconcile()

      const replyAfterReconcile = await tcpRoundTrip(listenPort, 'resumed-after-reconcile')
      assert.equal(replyAfterReconcile, 'resumed-after-reconcile')

      // 4. Explicit stop_all disables all rules persistently.
      const stoppedAll = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'stop_all', {})) as { stopped: number }
      assert.equal(stoppedAll.stopped, 1)
      await env.host.disable(PORT_FORWARD_PLUGIN_ID)
    } finally {
      await env.close()
      await echo.close()
    }
  })
})

test('config policy: allowPublicBind enforces 403 default deny and permits non-loopback once enabled in config', TIMEOUT, async () => {
  const freePort = await reserveFreePort()
  const echo = await startEchoServer()
  const env = await openPortForwardHost()
  try {
    await env.start()

    await assertRejectsCode(
      () =>
        env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
          nodeId: 'local',
          listenHost: '0.0.0.0',
          listenPort: freePort,
          targetPort: echo.port,
        }),
      'public_bind_disabled',
      403,
    )

    await env.host.setConfig(PORT_FORWARD_PLUGIN_ID, { allowPublicBind: true })
    const created = (await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
      nodeId: 'local',
      listenHost: '0.0.0.0',
      listenPort: freePort,
      targetPort: echo.port,
    })) as { item: { id: string; listenHost: string; listenerState: string } }
    assert.equal(created.item.listenHost, '0.0.0.0')
    assert.equal(created.item.listenerState, 'listening')

    await env.host.invokeAction(PORT_FORWARD_PLUGIN_ID, 'delete', { id: created.item.id })
  } finally {
    await env.close()
    await echo.close()
  }
})
