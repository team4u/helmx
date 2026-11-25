/**
 * End-to-end & unit tests for Hub-side automatic node version-follow (`NodeAutoUpgradeCoordinator`):
 * - `resolveAutoUpgradeNodesEnabled` env flag resolution (`HELMX_AUTO_UPGRADE_NODES`)
 * - Hub-pinned target version (`hubVersion()`, never npm latest, never auto-downgrade)
 * - `source_skipped` exemption for `installMode === 'source'` nodes
 * - Fail-closed `unknown_mode` gate for legacy/unannounced nodes missing `installMode`
 * - Two-phase boot startup gate (`createHelmx({ autoStart: false }) -> startHub -> kernel.start()`)
 *   verifying `onHubReady()` fires right after `kernel.start()` completes
 * - Node busy gate (active bound conversation turn) + bounded retry poll
 * - Recoverable failure exponential backoff, immediate reconnect recovery, terminal `not_supported`,
 *   concurrency deduplication, and clean `dispose()` on `app.close()`.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { waitFor as kitWaitFor } from '@helmx/test-kit/node'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type {
  HelmxEvent,
  NodeEnvRpcFunctions,
  NodeHeartbeatInput,
  NodeInfo,
  NodeInstallMode,
  NodeRegisterInput,
  NodeRegisterResult,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
  RpcResult,
} from '@helmx/protocol'
import { hubVersion, startHub } from '@helmx/kernel'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createHelmx } from '../src/app.js'
import {
  NodeAutoUpgradeCoordinator,
  resolveAutoUpgradeNodesEnabled,
  type NodeAutoUpgradeRetryPolicy,
} from '../src/node-auto-upgrade.js'

const waitFor = (cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(cond, { timeoutMs, intervalMs: 25, message: `wait timed out: ${what}` })

let rootDir: string

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'helmx-node-auto-upgrade-'))
}, { timeout: 60_000 })

after(async () => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

interface FixturePlan {
  rpcResult: RpcResult<NodeUpgradeResult>
  reconnect?: { candidateVersion: string; previousVersion?: string; installMode?: NodeInstallMode }
  commit?: false | { attemptId: string; version: string; previousVersion: string; pid: number }
  commitDelayMs?: number
  onUpgrade?: (input: NodeUpgradeRpcInput, callIndex: number) => Promise<RpcResult<NodeUpgradeResult>> | RpcResult<NodeUpgradeResult>
}

interface FixtureNode {
  nodeId: string
  close(): void
}

async function connectFixtureNode(
  wsUrl: string,
  nodeId: string,
  nodeToken: string,
  version: string,
  options: { installMode?: NodeInstallMode; initialPlan?: FixturePlan } = {},
): Promise<
  FixtureNode & {
    setPlan(plan: FixturePlan): void
    upgradeCalls: NodeUpgradeRpcInput[]
    checkCalls: number
  }
> {
  const upgradeCalls: NodeUpgradeRpcInput[] = []
  let checkCalls = 0
  const candidateClosers: Array<() => void> = []
  const state = {
    plan: options.initialPlan as FixturePlan | undefined,
  }
  const ws = new WebSocket(`${wsUrl}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  const nodeSide: NodeEnvRpcFunctions & {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>
    heartbeat(id: string, input?: NodeHeartbeatInput): Promise<boolean>
  } = {
    register: async () => ({ ok: true, heartbeatMs: 60_000 }),
    heartbeat: async () => true,
    nodeCheckUpgrade: async () => {
      checkCalls += 1
      return { ok: true, value: { currentVersion: version, latestVersion: '9.9.9', updateAvailable: true } } as RpcResult<NodeUpgradeCheckResult>
    },
    nodeUpgrade: async (input: NodeUpgradeRpcInput) => {
      const callIndex = upgradeCalls.length
      upgradeCalls.push(input)
      const plan = state.plan
      if (plan === undefined) {
        return { ok: false, error: { code: 'unknown', message: 'fixture did not configure an upgrade plan' } }
      }
      if (plan.onUpgrade !== undefined) {
        return await plan.onUpgrade(input, callIndex)
      }
      if (plan.reconnect !== undefined) {
        const reconnectVersion = plan.reconnect.candidateVersion
        const attemptId = input.attemptId ?? ''
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* already closed */
          }
          void connectCandidate(wsUrl, nodeId, nodeToken, reconnectVersion, attemptId, plan, candidateClosers)
        }, 30).unref()
      }
      return plan.rpcResult
    },
  } as unknown as NodeEnvRpcFunctions & {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>
    heartbeat(id: string, input?: NodeHeartbeatInput): Promise<boolean>
  }

  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    } & NodeEnvRpcFunctions,
    typeof nodeSide
  >(nodeSide, {
    post: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
    },
    on: (cb) => {
      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
        try {
          cb(JSON.parse(text) as never)
        } catch {
          /* ignore non-JSON frames */
        }
      })
    },
    serialize: (d) => d,
    deserialize: (d) => d as never,
    timeout: 10_000,
  })

  const registered = await rpc.register({
    nodeId,
    token: nodeToken,
    hostname: 'upgrade-fixture',
    platform: process.platform,
    version,
    ...(options.installMode !== undefined ? { installMode: options.installMode } : {}),
  })
  if (!registered.ok) throw new Error(`fixture register failed:${registered.reason ?? 'unknown'}`)

  return {
    nodeId,
    upgradeCalls,
    get checkCalls() {
      return checkCalls
    },
    setPlan(plan) {
      state.plan = plan
    },
    close() {
      for (const closeCandidate of candidateClosers.splice(0)) closeCandidate()
      try {
        rpc.$close()
      } catch {
        /* already closed */
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}

async function connectCandidate(
  wsUrl: string,
  nodeId: string,
  nodeToken: string,
  version: string,
  attemptId: string,
  plan: FixturePlan,
  candidateClosers: Array<() => void> = [],
): Promise<void> {
  const ws = new WebSocket(`${wsUrl}/ws/node?nodeId=${encodeURIComponent(nodeId)}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  }).catch(() => undefined)
  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    },
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>
    }
  >(
    {
      register: async () => ({ ok: true, heartbeatMs: 60_000 }),
      heartbeat: async () => true,
    },
    {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
      },
      on: (cb) => {
        ws.on('message', (raw) => {
          const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
          try {
            cb(JSON.parse(text) as never)
          } catch {
            /* ignore */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  candidateClosers.push(() => {
    try {
      rpc.$close()
    } catch {
      /* already closed */
    }
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  })
  const outcome = await rpc
    .register({
      nodeId,
      token: nodeToken,
      hostname: 'upgrade-fixture',
      platform: process.platform,
      version,
      ...(plan.reconnect?.installMode !== undefined ? { installMode: plan.reconnect.installMode } : {}),
      upgradeAttemptId: attemptId,
    })
    .catch(() => undefined)
  if (outcome === undefined || !outcome.ok) return
  const commit = plan.commit
  if (commit === false) return
  const sendCommit = async (): Promise<void> => {
    const payload: NodeHeartbeatInput = {
      upgradeCommit:
        commit !== undefined
          ? commit
          : {
              attemptId,
              version,
              previousVersion: plan.reconnect?.previousVersion ?? '1.0.0',
              pid: 4321,
            },
    }
    await rpc.heartbeat(nodeId, payload).catch(() => undefined)
  }
  if ((plan.commitDelayMs ?? 0) > 0) {
    setTimeout(() => {
      void sendCommit()
    }, plan.commitDelayMs).unref()
    return
  }
  await sendCommit()
}

async function openHubApp(
  dir: string,
  options: {
    autoStart?: boolean
    autoUpgradeNodes?: boolean
    nodeAutoUpgradePolicy?: NodeAutoUpgradeRetryPolicy
    nodeUpgradeTimeoutMs?: number
    faux?: ReturnType<typeof fauxProvider>
  } = {},
): Promise<{
  kernel: Awaited<ReturnType<typeof createHelmx>>['kernel']
  autoUpgrade: NodeAutoUpgradeCoordinator
  hub: Awaited<ReturnType<typeof startHub>>
  token: string
  faux: ReturnType<typeof fauxProvider>
  close(): Promise<void>
}> {
  const faux = options.faux ?? fauxProvider()
  const helmxApp = await createHelmx({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    providers: [faux.provider],
    externalSkillRoots: [],
    nodeUpgradeTimeoutMs: options.nodeUpgradeTimeoutMs ?? 600,
    ...(options.autoStart !== undefined ? { autoStart: options.autoStart } : {}),
    ...(options.autoUpgradeNodes !== undefined ? { autoUpgradeNodes: options.autoUpgradeNodes } : {}),
    ...(options.nodeAutoUpgradePolicy !== undefined ? { nodeAutoUpgradePolicy: options.nodeAutoUpgradePolicy } : {}),
  })
  if (helmxApp.kernel.plugins.get('builtin:title')?.enabled) {
    await helmxApp.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
  }
  const hub = await startHub({
    kernel: helmxApp.kernel as never,
    port: 0,
  })
  let token = helmxApp.kernel.processToken ?? ''
  if (helmxApp.kernel.started) {
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'node-upgrade-test-pass' }),
    })
    assert.equal(setup.status, 200)
    ;({ token } = (await setup.json()) as { token: string })
  }
  return {
    kernel: helmxApp.kernel,
    autoUpgrade: helmxApp.autoUpgrade,
    hub,
    token,
    faux,
    close: async () => {
      await hub.close()
      await helmxApp.close()
    },
  }
}

async function provisionNode(
  hubUrl: string,
  token: string,
  nodeId: string,
  version: string,
  options: { installMode?: NodeInstallMode; initialPlan?: FixturePlan } = {},
): Promise<Awaited<ReturnType<typeof connectFixtureNode>> & { nodeToken: string }> {
  const issue = await fetch(`${hubUrl}/api/nodes/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ nodeId }),
  })
  assert.equal(issue.status, 201, 'issuing node token failed')
  const { token: nodeToken } = (await issue.json()) as { token: string }
  const wsUrl = hubUrl.replace(/^http/, 'ws')
  const connected = await connectFixtureNode(wsUrl, nodeId, nodeToken, version, options)
  return Object.assign(connected, { nodeToken })
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

// ---------------------------------------------------------------------------
// Auto-upgrade (Hub-pinned version follow, source exemption, startup/busy gates, retry, dedupe)
// ---------------------------------------------------------------------------

test('resolveAutoUpgradeNodesEnabled: enabled by default; 0/false/off/no disable explicitly', { timeout: 60_000 }, () => {
  assert.equal(resolveAutoUpgradeNodesEnabled({}), true)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: '' }), true)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: '1' }), true)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: 'true' }), true)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: '0' }), false)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: 'false' }), false)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: 'OFF' }), false)
  assert.equal(resolveAutoUpgradeNodesEnabled({ HELMX_AUTO_UPGRADE_NODES: 'no' }), false)
})

test('auto-upgrade enabled by default: pins Hub version (never npm latest) and converges NodeInfo; disable switch stops it', { timeout: 60_000 }, async () => {
  const dirOn = await mkdtemp(join(rootDir, 'auto-default-on-'))
  const appOn = await openHubApp(dirOn)
  try {
    const events: HelmxEvent[] = []
    const off = appOn.kernel.events.subscribe((frame) => events.push(frame.event))
    try {
      // Node fixture reports registry latest=9.9.9 in nodeCheckUpgrade, but Hub auto-follow must pin hubVersion().
      const node = await provisionNode(appOn.hub.url, appOn.token, 'auto-default-node', '0.0.1', {
        installMode: 'release',
        initialPlan: {
          rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
          reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
        },
      })
      await waitFor(() => node.upgradeCalls.length === 1, 10_000, 'default auto-upgrade call')
      assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion(), 'auto-upgrade target must be pinned to Hub version, never npm latest')
      assert.equal(node.checkCalls, 0, 'auto-upgrade must not query registry latest')

      // Wait until candidate commit completes and autoUpgrade clears on NodeInfo.
      await waitFor(
        () => {
          const info = appOn.kernel.nodes.listNodesSync().find((n) => n.id === 'auto-default-node')
          return info?.online === true && info.version === hubVersion() && info.autoUpgrade === undefined
        },
        10_000,
        'node converges to Hub version and clears autoUpgrade state',
      )
      assert.ok(
        events.some(
          (e) =>
            e.type === 'node.changed' &&
            'node' in e &&
            e.node.id === 'auto-default-node' &&
            e.node.autoUpgrade?.status === 'upgrading',
        ),
        'node.changed should expose upgrading phase',
      )

      // Equal or newer node must never trigger upgrade or auto-downgrade.
      const equalNode = await provisionNode(appOn.hub.url, appOn.token, 'auto-eq-node', hubVersion(), { installMode: 'release' })
      const newerNode = await provisionNode(appOn.hub.url, appOn.token, 'auto-newer-node', '9.9.9', { installMode: 'release' })
      await delay(250)
      assert.equal(equalNode.upgradeCalls.length, 0, 'equal version must not auto-upgrade')
      assert.equal(newerNode.upgradeCalls.length, 0, 'newer node must not auto-downgrade')
      node.close()
      equalNode.close()
      newerNode.close()
    } finally {
      off()
    }
  } finally {
    await appOn.close().catch(() => undefined)
  }

  // Explicit env disable switch (`HELMX_AUTO_UPGRADE_NODES=0`) suppresses auto-upgrade.
  const dirOff = await mkdtemp(join(rootDir, 'auto-env-off-'))
  process.env['HELMX_AUTO_UPGRADE_NODES'] = '0'
  let appOff: Awaited<ReturnType<typeof openHubApp>> | undefined
  try {
    appOff = await openHubApp(dirOff)
    const node = await provisionNode(appOff.hub.url, appOff.token, 'auto-off-node', '0.0.1', { installMode: 'release' })
    await delay(300)
    assert.equal(node.upgradeCalls.length, 0, 'HELMX_AUTO_UPGRADE_NODES=0 must disable auto-upgrade')
    node.close()
  } finally {
    delete process.env['HELMX_AUTO_UPGRADE_NODES']
    await appOff?.close().catch(() => undefined)
  }

  // Explicit option disable switch (`autoUpgradeNodes: false`) suppresses auto-upgrade.
  const dirOptOff = await mkdtemp(join(rootDir, 'auto-opt-off-'))
  const appOptOff = await openHubApp(dirOptOff, { autoUpgradeNodes: false })
  try {
    const node = await provisionNode(appOptOff.hub.url, appOptOff.token, 'auto-opt-off-node', '0.0.1', { installMode: 'release' })
    await delay(250)
    assert.equal(node.upgradeCalls.length, 0, 'autoUpgradeNodes: false must disable auto-upgrade')
    node.close()
  } finally {
    await appOptOff.close().catch(() => undefined)
  }
})

test('auto-upgrade skips source/link nodes unconditionally and exposes source_skipped on NodeInfo, node.changed, and notification', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-src-skip-'))
  const app = await openHubApp(dir)
  try {
    const events: HelmxEvent[] = []
    const off = app.kernel.events.subscribe((frame) => events.push(frame.event))
    try {
      const node = await provisionNode(app.hub.url, app.token, 'src-dev-node', '0.0.1', { installMode: 'source' })
      await delay(250)
      assert.equal(node.upgradeCalls.length, 0, 'source/link node must never receive auto nodeUpgrade RPC')

      const listRes = await fetch(`${app.hub.url}/api/nodes`, { headers: authHeaders(app.token) })
      assert.equal(listRes.status, 200)
      const nodes = (await listRes.json()) as NodeInfo[]
      const entry = nodes.find((n) => n.id === 'src-dev-node')
      assert.equal(entry?.installMode, 'source')
      assert.equal(entry?.autoUpgrade?.status, 'source_skipped')
      assert.equal(entry?.autoUpgrade?.targetVersion, hubVersion())
      assert.match(entry?.autoUpgrade?.reason ?? '', /source_mode/)

      assert.ok(
        events.some(
          (e) =>
            e.type === 'node.changed' &&
            'node' in e &&
            e.node.id === 'src-dev-node' &&
            e.node.autoUpgrade?.status === 'source_skipped',
        ),
        'node.changed must expose source_skipped',
      )
      assert.ok(
        events.some((e) => e.type === 'notification' && 'level' in e && e.level === 'info' && /src-dev-node/.test(e.title)),
        'notification must surface source-mode skip',
      )
      node.close()
    } finally {
      off()
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('auto-upgrade startup gate: defers older node during two-phase boot (autoStart: false -> startHub -> kernel.start()) until kernel.start() finishes recovery', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-startup-gate-'))
  // Two-phase boot matching hub/main.ts: open listener before kernel.start().
  const app = await openHubApp(dir, { autoStart: false })
  try {
    assert.equal(app.kernel.started, false)
    const issued = await app.kernel.issueNodeToken('boot-node')
    const node = await connectFixtureNode(app.hub.url.replace(/^http/, 'ws'), 'boot-node', issued.token, '0.0.1', {
      installMode: 'release',
      initialPlan: {
        rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
        reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
      },
    })
    await delay(250)
    assert.equal(node.upgradeCalls.length, 0, 'must not trigger auto-upgrade before Hub startup/recovery completes')
    const pendingInfo = app.kernel.nodes.listNodesSync().find((n) => n.id === 'boot-node')
    assert.equal(pendingInfo?.autoUpgrade?.status, 'pending')
    assert.match(pendingInfo?.autoUpgrade?.reason ?? '', /startup|recovery/i)

    // Complete Hub startup + recovery -> pending node wakes up via kernel.onStarted() and upgrades to Hub version.
    await app.kernel.start()
    await waitFor(() => node.upgradeCalls.length === 1, 10_000, 'auto-upgrade wakes after kernel.start()')
    assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion())
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'boot-node')?.version === hubVersion(),
      10_000,
      'boot-node converges to Hub version',
    )
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('auto-upgrade busy gate: defers while bound conversation has an active turn and upgrades after turn settles via bounded retry', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-busy-gate-'))
  let enteredTurn!: () => void
  const turnStarted = new Promise<void>((resolve) => {
    enteredTurn = resolve
  })
  let releaseTurn!: (msg: ReturnType<typeof fauxAssistantMessage>) => void
  const heldResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    releaseTurn = resolve
  })
  const faux = fauxProvider()
  faux.setResponses([
    async () => {
      enteredTurn()
      return heldResponse
    },
  ])
  const app = await openHubApp(dir, {
    faux,
    nodeAutoUpgradePolicy: { busyPollMs: 60, retryBaseMs: 80, retryMaxMs: 200 },
  })
  try {
    // Issue token and bind a conversation to busy-node, then start an active turn before connecting the older node.
    const issued = await app.kernel.issueNodeToken('busy-node')
    const conv = await app.kernel.createConversation({
      title: 'Remote work',
      nodeId: 'busy-node',
      cwd: dir,
    })
    await app.kernel.submitInput(conv.id, 'hold active turn on busy-node')
    await turnStarted
    assert.ok(app.kernel.describeNodeBusy('busy-node'), 'bound active turn must mark node busy')

    const node = await connectFixtureNode(app.hub.url.replace(/^http/, 'ws'), 'busy-node', issued.token, '0.0.1', {
      installMode: 'release',
      initialPlan: {
        rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
        reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
      },
    })

    // Across several busyPollMs intervals while the turn is active, node stays pending and never upgrades.
    await delay(260)
    assert.equal(node.upgradeCalls.length, 0, 'busy node with active conversation turn must not be interrupted')
    const duringBusy = app.kernel.nodes.listNodesSync().find((n) => n.id === 'busy-node')
    assert.equal(duringBusy?.autoUpgrade?.status, 'pending')
    assert.match(duringBusy?.autoUpgrade?.reason ?? '', /active conversation/)
    assert.equal(typeof duringBusy?.autoUpgrade?.nextRetryAt, 'number')

    // Finish the turn cleanly -> bounded poll detects idle and completes the upgrade.
    releaseTurn(fauxAssistantMessage('completed cleanly'))
    await waitFor(() => app.kernel.describeNodeBusy('busy-node') === undefined, 10_000, 'busy-node becomes idle')
    await waitFor(() => node.upgradeCalls.length === 1, 10_000, 'deferred auto-upgrade runs once idle')
    assert.equal(node.upgradeCalls[0]!.targetVersion, hubVersion())
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'busy-node')?.version === hubVersion(),
      10_000,
      'busy-node converges after idle upgrade',
    )
    node.close()
  } finally {
    releaseTurn(fauxAssistantMessage('cleanup'))
    await app.close().catch(() => undefined)
  }
})

test('auto-upgrade retry and terminal skips: recovers after backoff and reconnect, skips terminal not_supported, and deduplicates concurrent triggers', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-retry-'))
  const app = await openHubApp(dir, {
    nodeUpgradeTimeoutMs: 1_500,
    nodeAutoUpgradePolicy: { busyPollMs: 50, retryBaseMs: 250, retryMaxMs: 600 },
  })
  try {
    // 1. Recoverable failure -> failed state with backoff -> retries after retryBaseMs and succeeds.
    const wsUrl = app.hub.url.replace(/^http/, 'ws')
    let attemptSeen = 0
    const retryNode = await provisionNode(app.hub.url, app.token, 'retry-backoff-node', '0.0.1', {
      installMode: 'release',
      initialPlan: {
        rpcResult: { ok: false, error: { code: 'unknown', message: 'npm 404 not propagated yet' } },
        onUpgrade: async (input) => {
          attemptSeen += 1
          if (attemptSeen === 1) {
            return { ok: false, error: { code: 'unknown', message: 'npm 404 not propagated yet' } }
          }
          const candidatePlan: FixturePlan = {
            rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
            reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
          }
          setTimeout(() => {
            void connectCandidate(
              wsUrl,
              'retry-backoff-node',
              retryNode.nodeToken,
              hubVersion(),
              input.attemptId ?? '',
              candidatePlan,
            )
          }, 25).unref()
          return candidatePlan.rpcResult
        },
      },
    })
    await waitFor(() => retryNode.upgradeCalls.length === 1, 10_000, 'first attempt fires')
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'retry-backoff-node')?.autoUpgrade?.status === 'failed',
      10_000,
      'failed status exposed after transient error',
    )
    const failedInfo = app.kernel.nodes.listNodesSync().find((n) => n.id === 'retry-backoff-node')
    assert.equal(failedInfo?.autoUpgrade?.attempts, 1)
    assert.equal(typeof failedInfo?.autoUpgrade?.nextRetryAt, 'number')
    // Must not hammer immediately during backoff window.
    await delay(100)
    assert.equal(retryNode.upgradeCalls.length, 1, 'must respect backoff window before retrying')
    // Backoff expires -> attempt 2 runs and converges.
    await waitFor(() => retryNode.upgradeCalls.length === 2, 10_000, 'backoff timer triggers retry attempt 2')
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'retry-backoff-node')?.version === hubVersion(),
      10_000,
      'node converges on retry attempt 2',
    )
    retryNode.close()

    // 2. Recoverable failure followed by disconnect + reconnect recovers immediately on reconnect (even with long timer backoff).
    const dirReconn = await mkdtemp(join(rootDir, 'auto-reconn-'))
    const appReconn = await openHubApp(dirReconn, {
      nodeAutoUpgradePolicy: { busyPollMs: 50, retryBaseMs: 60_000, retryMaxMs: 120_000 },
    })
    try {
      const reconnWs = appReconn.hub.url.replace(/^http/, 'ws')
      const firstConn = await provisionNode(appReconn.hub.url, appReconn.token, 'reconn-node', '0.0.1', {
        installMode: 'release',
        initialPlan: { rpcResult: { ok: false, error: { code: 'unknown', message: 'transient network error' } } },
      })
      await waitFor(
        () => appReconn.kernel.nodes.listNodesSync().find((n) => n.id === 'reconn-node')?.autoUpgrade?.status === 'failed',
        10_000,
        'reconn-node records failed status',
      )
      firstConn.close()
      await waitFor(
        () => appReconn.kernel.nodes.listNodesSync().find((n) => n.id === 'reconn-node')?.online === false,
        10_000,
        'reconn-node goes offline',
      )
      const secondConn = await connectFixtureNode(reconnWs, 'reconn-node', firstConn.nodeToken, '0.0.1', {
        installMode: 'release',
        initialPlan: {
          rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
          reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
        },
      })
      await waitFor(() => secondConn.upgradeCalls.length === 1, 10_000, 'reconnect triggers recovery retry')
      await waitFor(
        () => appReconn.kernel.nodes.listNodesSync().find((n) => n.id === 'reconn-node')?.version === hubVersion(),
        10_000,
        'reconn-node converges after reconnect retry',
      )
      secondConn.close()
    } finally {
      await appReconn.close().catch(() => undefined)
    }

    // 3. Terminal not_supported: skipped terminally (no timer retry, no retry on reconnect for same targetVersion).
    const unsup1 = await provisionNode(app.hub.url, app.token, 'unsup-node', '0.0.1', {
      installMode: 'release',
      initialPlan: { rpcResult: { ok: false, error: { code: 'not_supported', message: 'unmanaged foreground daemon' } } },
    })
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'unsup-node')?.autoUpgrade?.status === 'not_supported',
      10_000,
      'unsup-node reaches terminal not_supported',
    )
    await delay(350)
    assert.equal(unsup1.upgradeCalls.length, 1, 'not_supported must not retry on timer')
    unsup1.close()
    await waitFor(() => app.kernel.nodes.listNodesSync().find((n) => n.id === 'unsup-node')?.online === false, 10_000, 'unsup offline')
    const unsup2 = await connectFixtureNode(wsUrl, 'unsup-node', unsup1.nodeToken, '0.0.1', {
      installMode: 'release',
      initialPlan: { rpcResult: { ok: false, error: { code: 'not_supported', message: 'unmanaged foreground daemon' } } },
    })
    await delay(350)
    assert.equal(unsup2.upgradeCalls.length, 0, 'not_supported must remain terminally skipped across reconnects for same targetVersion')
    unsup2.close()

    // 4. Concurrency deduplication: while an upgrade is in flight, repeated onHubReady() never triggers a second call.
    let releaseInflight!: (res: RpcResult<NodeUpgradeResult>) => void
    const inflightReply = new Promise<RpcResult<NodeUpgradeResult>>((resolve) => {
      releaseInflight = resolve
    })
    const dedupeNode = await provisionNode(app.hub.url, app.token, 'dedupe-inflight-node', '0.0.1', {
      installMode: 'release',
      initialPlan: {
        rpcResult: { ok: false, error: { code: 'unknown', message: 'unused' } },
        onUpgrade: () => inflightReply,
      },
    })
    await waitFor(() => dedupeNode.upgradeCalls.length === 1, 10_000, 'in-flight upgrade starts')
    app.autoUpgrade.onHubReady()
    app.autoUpgrade.onHubReady()
    await delay(120)
    assert.equal(dedupeNode.upgradeCalls.length, 1, 'concurrent triggers while upgrading must be deduplicated')
    releaseInflight({ ok: false, error: { code: 'not_supported', message: 'stop test' } })
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'dedupe-inflight-node')?.autoUpgrade?.status === 'not_supported',
      10_000,
      'in-flight dedupe attempt settles cleanly',
    )
    dedupeNode.close()

    // 5. Defense-in-depth: node announcing installMode=release that rejects RPC with source_mode -> terminal source_skipped, never retried.
    const rpcSrcAuto = await provisionNode(app.hub.url, app.token, 'rpc-src-auto', '0.0.1', {
      installMode: 'release',
      initialPlan: {
        rpcResult: {
          ok: false,
          error: { code: 'source_mode', message: 'not_supported (source_mode): update source and restart manually' },
        },
      },
    })
    await waitFor(
      () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'rpc-src-auto')?.autoUpgrade?.status === 'source_skipped',
      10_000,
      'rpc source_mode rejection transitions to terminal source_skipped',
    )
    await delay(350)
    assert.equal(rpcSrcAuto.upgradeCalls.length, 1, 'terminal source_skipped must not retry on backoff timer')
    rpcSrcAuto.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('auto-upgrade fails closed for legacy nodes missing installMode (unknown_mode): never auto-upgrades, sets no retry timer, emits no failure alert, allows manual upgrade and release recovery', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-unknown-mode-'))
  const app = await openHubApp(dir, {
    nodeUpgradeTimeoutMs: 1_500,
    nodeAutoUpgradePolicy: { busyPollMs: 40, retryBaseMs: 60, retryMaxMs: 120 },
  })
  try {
    const wsUrl = app.hub.url.replace(/^http/, 'ws')
    const events: HelmxEvent[] = []
    const off = app.kernel.events.subscribe((frame) => events.push(frame.event))
    try {
      // 1. Legacy daemon (like an older source checkout) registers with older version and omits installMode.
      const legacy1 = await provisionNode(app.hub.url, app.token, 'legacy-code2', '0.0.1', {
        initialPlan: {
          rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
          reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
        },
      })
      await waitFor(
        () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-code2')?.autoUpgrade?.status === 'unknown_mode',
        10_000,
        'legacy node enters unknown_mode',
      )

      // Trigger Hub ready re-evaluation and wait across multiple busy/retry intervals -> still zero auto-upgrade calls.
      app.autoUpgrade.onHubReady()
      await delay(250)
      assert.equal(legacy1.upgradeCalls.length, 0, 'legacy node without installMode must never trigger auto-upgrade')

      const listRes = await fetch(`${app.hub.url}/api/nodes`, { headers: authHeaders(app.token) })
      assert.equal(listRes.status, 200)
      const nodes = (await listRes.json()) as NodeInfo[]
      const entry = nodes.find((n) => n.id === 'legacy-code2')
      assert.equal(entry?.installMode, undefined)
      assert.equal(entry?.autoUpgrade?.status, 'unknown_mode')
      assert.equal(entry?.autoUpgrade?.targetVersion, hubVersion())
      assert.equal(entry?.autoUpgrade?.attempts, 0)
      assert.equal(entry?.autoUpgrade?.nextRetryAt, undefined, 'unknown_mode must not arm any retry timer')
      assert.match(entry?.autoUpgrade?.reason ?? '', /unknown_mode/)
      assert.match(entry?.autoUpgrade?.reason ?? '', /installMode/)
      assert.match(entry?.autoUpgrade?.reason ?? '', /manually/)

      assert.ok(
        events.some(
          (e) =>
            e.type === 'node.changed' &&
            'node' in e &&
            e.node.id === 'legacy-code2' &&
            e.node.installMode === undefined &&
            e.node.autoUpgrade?.status === 'unknown_mode',
        ),
        'SSE node.changed must expose unknown_mode cleanly for legacy nodes',
      )

      // Disconnect and reconnect still omitting installMode -> still never calls upgradeNode and never re-notifies.
      legacy1.close()
      await waitFor(
        () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-code2')?.online === false,
        10_000,
        'legacy-code2 goes offline',
      )
      const legacy2 = await connectFixtureNode(wsUrl, 'legacy-code2', legacy1.nodeToken, '0.0.1', {
        initialPlan: {
          rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
          reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
        },
      })
      await delay(200)
      assert.equal(legacy2.upgradeCalls.length, 0, 'reconnecting legacy node without installMode must remain fail-closed')

      // Never emit misleading warning/error failure notifications; at most one info notice across reconnects.
      const legacyNotifications = events.filter(
        (e): e is Extract<HelmxEvent, { type: 'notification' }> =>
          e.type === 'notification' && 'title' in e && /legacy-code2/.test(e.title),
      )
      assert.equal(
        legacyNotifications.filter((n) => n.level !== 'info' || /failed/i.test(n.title)).length,
        0,
        'unknown_mode must never emit misleading warning/error failure alerts',
      )
      assert.equal(legacyNotifications.length, 1, 'unknown_mode info notice must be deduplicated across reconnects')

      // 2. Manual POST /api/nodes/:id/upgrade still allows operators to explicitly upgrade a legacy node;
      //    once the upgraded candidate commits at Hub version with installMode=release, unknown_mode clears.
      const manualRes = await fetch(`${app.hub.url}/api/nodes/legacy-code2/upgrade`, {
        method: 'POST',
        headers: authHeaders(app.token),
        body: JSON.stringify({ targetVersion: hubVersion() }),
      })
      assert.equal(manualRes.status, 200, 'manual POST upgrade on legacy node must keep existing semantics')
      const manualBody = (await manualRes.json()) as NodeUpgradeResult
      assert.equal(manualBody.ok, true)
      assert.equal(manualBody.upgraded, true)
      assert.equal(manualBody.targetVersion, hubVersion())
      assert.equal(legacy2.upgradeCalls.length, 1)
      await waitFor(
        () => {
          const info = app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-code2')
          return info?.online === true && info.version === hubVersion() && info.installMode === 'release' && info.autoUpgrade === undefined
        },
        10_000,
        'manual upgrade of legacy node converges and clears unknown_mode',
      )
      legacy2.close()

      // 3. Recovery without manual upgrade: a legacy node (unknown_mode) that restarts into an older release daemon
      //    reporting installMode=release clears unknown_mode and auto-upgrades cleanly.
      const recoveryLegacy = await provisionNode(app.hub.url, app.token, 'legacy-to-release', '0.0.1')
      await waitFor(
        () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-to-release')?.autoUpgrade?.status === 'unknown_mode',
        10_000,
        'legacy-to-release initially enters unknown_mode',
      )
      assert.equal(recoveryLegacy.upgradeCalls.length, 0)
      recoveryLegacy.close()
      await waitFor(
        () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-to-release')?.online === false,
        10_000,
        'legacy-to-release offline before release reconnect',
      )
      const releaseConn = await connectFixtureNode(wsUrl, 'legacy-to-release', recoveryLegacy.nodeToken, '0.0.1', {
        installMode: 'release',
        initialPlan: {
          rpcResult: { ok: true, value: { ok: true, previousVersion: '0.0.1', targetVersion: hubVersion(), upgraded: true } },
          reconnect: { candidateVersion: hubVersion(), previousVersion: '0.0.1', installMode: 'release' },
        },
      })
      await waitFor(() => releaseConn.upgradeCalls.length === 1, 10_000, 'explicit release reconnect clears unknown_mode and auto-upgrades')
      await waitFor(
        () => {
          const info = app.kernel.nodes.listNodesSync().find((n) => n.id === 'legacy-to-release')
          return info?.online === true && info.version === hubVersion() && info.autoUpgrade === undefined
        },
        10_000,
        'legacy-to-release converges after release reconnect',
      )
      releaseConn.close()
    } finally {
      off()
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('NodeAutoUpgradeCoordinator: fails closed for undefined or unknown runtime installMode, transitions cleanly to source or release, and disposes cleanly', { timeout: 60_000 }, async () => {
  let onlineNode: { version?: string; installMode?: NodeInstallMode } | undefined = { version: '0.1.0' }
  let upgradeCalls = 0
  const notifications: Array<{ level: 'info' | 'warning' | 'error'; title: string; body?: string }> = []
  const changedCount = { count: 0 }

  const coord = new NodeAutoUpgradeCoordinator({
    isEnabled: () => true,
    isHubReady: () => true,
    getTargetVersion: () => '0.2.0',
    getOnlineNode: (id) => (id === 'n1' ? onlineNode : undefined),
    listOnlineNodeIds: () => (onlineNode !== undefined ? ['n1'] : []),
    hasNode: (id) => id === 'n1',
    hasUpgradeInFlight: () => false,
    describeNodeBusy: () => undefined,
    runUpgrade: async () => {
      upgradeCalls += 1
      return { ok: true, previousVersion: '0.1.0', targetVersion: '0.2.0', upgraded: true }
    },
    publishNodeChanged: () => {
      changedCount.count += 1
    },
    publishNotification: (payload) => {
      notifications.push(payload)
    },
    log: () => {},
    policy: { busyPollMs: 20, retryBaseMs: 20, retryMaxMs: 40, now: () => 1_700_000_000_000 },
  })
  try {
    // 1. Missing installMode -> unknown_mode, no upgrade, no timer, no warning/error.
    coord.onNodeOnline('n1')
    assert.equal(upgradeCalls, 0)
    assert.equal(coord.statusOf('n1')?.status, 'unknown_mode')
    assert.equal(coord.statusOf('n1')?.nextRetryAt, undefined)
    assert.equal(coord.statusOf('n1')?.attempts, 0)
    assert.match(coord.statusOf('n1')?.reason ?? '', /did not report installMode/)

    // 2. Defensive unknown runtime value -> stays fail-closed in unknown_mode, never upgrades.
    onlineNode = { version: '0.1.0', installMode: 'custom_unknown' as unknown as NodeInstallMode }
    coord.onNodeOnline('n1')
    await delay(80)
    assert.equal(upgradeCalls, 0, 'unknown runtime installMode must never trigger runUpgrade or arm timers')
    assert.equal(coord.statusOf('n1')?.status, 'unknown_mode')
    assert.equal(coord.statusOf('n1')?.nextRetryAt, undefined)
    assert.match(coord.statusOf('n1')?.reason ?? '', /custom_unknown/)

    // 3. Reconnecting as source -> transitions cleanly to source_skipped without calling runUpgrade.
    onlineNode = { version: '0.1.0', installMode: 'source' }
    coord.onNodeOnline('n1')
    assert.equal(upgradeCalls, 0)
    assert.equal(coord.statusOf('n1')?.status, 'source_skipped')
    assert.equal(coord.statusOf('n1')?.nextRetryAt, undefined)
    assert.equal(
      notifications.filter((n) => n.level !== 'info').length,
      0,
      'neither unknown_mode nor source_skipped may emit warning/error notifications',
    )

    // 4. Reconnecting as explicit release -> clears skip and executes upgrade.
    onlineNode = { version: '0.1.0', installMode: 'release' }
    coord.onNodeOnline('n1')
    await waitFor(() => upgradeCalls === 1, 5_000, 'explicit release triggers runUpgrade')
    await waitFor(() => coord.statusOf('n1') === undefined, 5_000, 'status clears on upgrade completion')
  } finally {
    coord.dispose()
  }
  assert.equal(coord.statusOf('n1'), undefined)
  coord.onNodeOnline('n1')
  assert.equal(upgradeCalls, 1, 'disposed coordinator ignores late callbacks')
})

test('createHelmx app.close() disposes coordinator and clears kernel autoUpgradeStatusProvider', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-dispose-'))
  const app = await openHubApp(dir, { autoStart: false })
  const issued = await app.kernel.issueNodeToken('dispose-node')
  const node = await connectFixtureNode(app.hub.url.replace(/^http/, 'ws'), 'dispose-node', issued.token, '0.0.1', {
    installMode: 'release',
  })
  await waitFor(
    () => app.kernel.nodes.listNodesSync().find((n) => n.id === 'dispose-node')?.autoUpgrade?.status === 'pending',
    5_000,
    'pending autoUpgrade state attached before close',
  )
  node.close()
  await app.close()
  assert.equal(app.autoUpgrade.statusOf('dispose-node'), undefined, 'close() must dispose coordinator entries and timers')
})
