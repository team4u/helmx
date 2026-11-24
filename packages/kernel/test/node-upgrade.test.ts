/**
 * End-to-end tests for node upgrades (Hub-side orchestrator + registry waiters):
 * Real NodeRegistry + /ws/node gateway + configurable in-process node fixture (controlling
 * nodeUpgrade / nodeCheckUpgrade behavior and register/heartbeat timing), wrapped with the full
 * Hub HTTP layer (KernelRuntime + startHub) covering GET /api/nodes/:id/upgrade/check and
 * POST /api/nodes/:id/upgrade.
 *
 * Core correctness invariants (verified via real behavior, never source-regex smoke checks):
 * 1. When an in-flight nodeUpgrade RPC disconnects because the candidate supersedes the old socket,
 *    the upgrade outcome may only be confirmed by a matching commit heartbeat from the candidate --
 *    never falsely succeed merely because a new connection appeared or an error was caught;
 * 2. Registration alone (without commit) never succeeds; mismatched attemptId / mismatched version /
 *    spoofed connection commit is rejected; a matching commit (attemptId + version +
 *    previousVersion + positive integer pid) succeeds;
 * 3. A valid commit without an active waiter (local CLI upgrade path) still ACKs true;
 * 4. Error mapping: local 400 / unknown 404 / offline 409 / unsupported 501 / structured failure 400/502 /
 *    unconfirmed timeout 502;
 * 5. HTTP body boundary validation: rejects unknown fields / non-http(s) registryUrl / non-boolean force /
 *    user-supplied attemptId;
 * 6. Auto-upgrade follows Hub version by default for confirmed `installMode === 'release'` nodes
 *    (never npm latest, never auto-downgrade), honors disable switch (`HELMX_AUTO_UPGRADE_NODES=0`
 *    / `autoUpgradeNodes: false`), skips source/link nodes (`source_skipped`), fails closed for
 *    legacy nodes missing `installMode` (`unknown_mode`, never calling `upgradeNode`), gates on Hub
 *    startup/recovery completion and node busyness without interrupting active turns, retries
 *    recoverable failures with backoff/reconnect recovery, and deduplicates concurrent triggers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp as mkdtempAsync } from 'node:fs/promises'
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
import type { HubConnectionLocal } from '../src/env/registry.js'
import { NodeRegistry, HelmxUpgradeBusyError, HelmxUpgradeTimeoutError } from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/runtime.js'
import {
  NodeAutoUpgradeCoordinator,
  resolveAutoUpgradeNodesEnabled,
  type NodeAutoUpgradeRetryPolicy,
} from '../src/runtime/node-auto-upgrade.js'
import { hubVersion, normalizeExplicitVersion, compareStrictSemVer } from '../src/runtime/semver.js'
import { startHub } from '../src/http/index.js'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'

const waitFor = (cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(cond, { timeoutMs, intervalMs: 25, message: `wait timed out: ${what}` })

/** Async mkdtemp alias (creates per-case directories). */
const mkdtemp = (prefix: string): Promise<string> => mkdtempAsync(prefix)

void mkdtemp

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-node-upgrade-'))
})

// ---------------------------------------------------------------------------
// version semantics unit
// ---------------------------------------------------------------------------

test('normalizeExplicitVersion: trims and strips single v prefix; rejects invalid inputs explicitly', { timeout: 60_000 }, () => {
  assert.equal(normalizeExplicitVersion('1.2.3'), '1.2.3')
  assert.equal(normalizeExplicitVersion(' v1.2.3 '), '1.2.3')
  assert.equal(normalizeExplicitVersion('V2.0.0-rc.1+build.5'), '2.0.0-rc.1+build.5')
  assert.throws(() => normalizeExplicitVersion('1.2'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('vv1.2.3'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('latest'), /SemVer/)
  assert.throws(() => normalizeExplicitVersion('1.2.3.4'), /SemVer/)
})

test('compareStrictSemVer: sorts major/minor/patch/prerelease versions', { timeout: 60_000 }, () => {
  assert.equal(compareStrictSemVer('1.2.3', '1.2.3'), 0)
  assert.equal(compareStrictSemVer('0.9.9', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.10.0', '1.9.0'), 1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha.1', '1.0.0-alpha.2'), -1)
  assert.equal(compareStrictSemVer('1.0.0-2', '1.0.0-10'), -1)
  assert.equal(compareStrictSemVer('1.0.0-alpha', '1.0.0-beta'), -1)
})

test('hubVersion: read kernel package.json(strictly SemVer)', { timeout: 60_000 }, () => {
  const v = hubVersion()
  assert.match(v, /^\d+\.\d+\.\d+/, `hub version must be strictly SemVer:${v}`)
})

// ---------------------------------------------------------------------------
// Pure registry layer: beginUpgrade / commit accounting
// ---------------------------------------------------------------------------

/** Minimal EventEmitter socket stub (same style as node-health.test.ts). */
class EventEmitterShim {
  readonly #listeners = new Map<string, Set<() => void>>()
  on(event: string, listener: () => void): void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
  }
  once(event: string, listener: () => void): void {
    const wrapped = (): void => {
      this.#listeners.get(event)?.delete(wrapped)
      listener()
    }
    this.on(event, wrapped)
  }
  emit(event: string): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener()
  }
}

class RegistrySocket extends EventEmitterShim {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
}

type WsLike = import('ws').WebSocket

async function registerRaw(
  registry: NodeRegistry,
  nodeId: string,
  extra: { version?: string; installMode?: NodeInstallMode; upgradeAttemptId?: string } = {},
): Promise<{ socket: RegistrySocket; outcome: { accepted: boolean; reason?: string } }> {
  const socket = new RegistrySocket()
  const outcome = await registry.register(
    socket as unknown as WsLike,
    {
      nodeId,
      token: `${nodeId}:secret`,
      hostname: 'upgrade-probe',
      platform: 'test',
      ...(extra.version !== undefined ? { version: extra.version } : {}),
      ...(extra.installMode !== undefined ? { installMode: extra.installMode } : {}),
      ...(extra.upgradeAttemptId !== undefined ? { upgradeAttemptId: extra.upgradeAttemptId } : {}),
    },
    () => ({ $close() {} }) as never,
  )
  return { socket, outcome }
}

test('registry.register: rejects invalid version, installMode, or empty upgradeAttemptId explicitly; stores valid installMode', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const badVersion = await registerRaw(registry, 'n1', { version: '' })
    assert.equal(badVersion.outcome.accepted, false)
    assert.equal(badVersion.outcome.reason, 'invalid version')
    const badAttempt = await registerRaw(registry, 'n2', { upgradeAttemptId: '' })
    assert.equal(badAttempt.outcome.accepted, false)
    assert.equal(badAttempt.outcome.reason, 'invalid upgradeAttemptId')
    const badMode = await registerRaw(registry, 'n3', { installMode: 'dev' as unknown as NodeInstallMode })
    assert.equal(badMode.outcome.accepted, false)
    assert.equal(badMode.outcome.reason, 'invalid installMode')

    const src = await registerRaw(registry, 'n-src', { version: '0.2.0', installMode: 'source' })
    assert.equal(src.outcome.accepted, true)
    assert.equal(registry.get('n-src')?.installMode, 'source')

    const legacy = await registerRaw(registry, 'n-legacy', { version: '0.2.0' })
    assert.equal(legacy.outcome.accepted, true)
    assert.equal(registry.get('n-legacy')?.installMode, undefined)
  } finally {
    await registry.close()
  }
})

test('registry: registration alone (without commit) never resolves waiter; matching commit succeeds', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    let settled = false
    void handle.result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // Candidate registration (evicts old socket): must not resolve the upgrade waiter.
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    assert.equal(candidate.outcome.accepted, true)
    await delay(150)
    assert.equal(settled, false, 'candidate registration alone (without commit) must not resolve the upgrade waiter')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // Candidate heartbeat commits (exact match) -> succeeds.
    const ack = registry.noteHeartbeat('n1', candidate.socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 4242 },
    })
    assert.equal(ack, true)
    const result = await handle.result
    assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true, pid: 4242 })
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
    socket.close()
  } finally {
    await registry.close()
  }
})

test('registry: reject wrong attemptId / wrong version / mismatched previousVersion / invalid pid (never false positive)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    let failed = false
    void handle.result.then(
      () => undefined,
      () => {
        failed = true
      },
    )

    const conn = registry.get('n1')
    assert.notEqual(conn, undefined)
    // Wrong attemptId.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'other', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    // Mismatched version (connection registered as 1.1.0, commit claims 9.9.9).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    // Mismatched previousVersion compared to waiter (prevent cross-contamination from other attempts).
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    // Non-positive integer pid.
    registry.noteHeartbeat('n1', conn!.socket, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: -3 },
    })
    await delay(100)
    assert.equal(failed, false, 'all invalid commits must not resolve the waiter')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    // Forged commit from another node connection (not current connection) must be rejected directly.
    const { socket: stranger } = await registerRaw(registry, 'n2', { version: '1.1.0', upgradeAttemptId: 'a1' })
    const ackStranger = registry.noteHeartbeat('n1', stranger as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(ackStranger, false, 'heartbeat from non-current connection must be rejected directly')
    assert.equal(registry.hasUpgradeWaiter('n1'), true)

    handle.cancel()
    await assert.rejects(handle.result)
    socket.close()
    stranger.close()
  } finally {
    await registry.close()
  }
})

test('registry: heartbeat with commit ACKs actual acceptance result; plain heartbeat always ACKs true', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // No waiter: valid commit (local CLI path) ACKs true.
    const { socket: solo } = await registerRaw(registry, 'n-cli', { version: '2.0.0', upgradeAttemptId: 'cli-1' })
    const ackCli = registry.noteHeartbeat('n-cli', solo as unknown as WsLike, {
      upgradeCommit: { attemptId: 'cli-1', version: '2.0.0', previousVersion: '1.9.0', pid: 11 },
    })
    assert.equal(ackCli, true, 'valid commit without waiter (local CLI upgrade) should ACK true')

    // With waiter: mismatched commit ACKs false (node must not mistake rejection for Hub confirmation).
    const { socket } = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    const badAttempt = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'wrong', version: '1.1.0', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badAttempt, false, 'wrong attemptId commit must Nack (ACK false)')
    const badVersion = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '9.9.9', previousVersion: '1.0.0', pid: 1 },
    })
    assert.equal(badVersion, false, 'wrong version commit must ACK false')
    const badPrevious = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '0.0.1', pid: 1 },
    })
    assert.equal(badPrevious, false, 'wrong previousVersion commit must ACK false')
    const malformed = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1' } as never,
    })
    assert.equal(malformed, false, 'malformed commit with missing fields must ACK false')
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'rejected commits must not affect waiter')

    // Plain heartbeat (without commit) always returns true.
    const plain = registry.noteHeartbeat('n1', socket as unknown as WsLike, {})
    assert.equal(plain, true)

    // Matching commit ACKs true and resolves waiter.
    const matched = registry.noteHeartbeat('n1', socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 22 },
    })
    assert.equal(matched, true)
    assert.equal(registry.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry.close()
  }
})

test('registry: reject concurrent beginUpgrade on same node; original socket disconnect does not clear waiter', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    registry.beginUpgrade('n1', { attemptId: 'a1', targetVersion: '1.1.0', previousVersion: '1.0.0', timeoutMs: 5_000 })
    assert.throws(
      () => registry.beginUpgrade('n1', { attemptId: 'a2', targetVersion: '1.2.0', previousVersion: '1.0.0', timeoutMs: 1_000 }),
      HelmxUpgradeBusyError,
    )
    // Old socket disconnects (expected during upgrade): waiter stays alive waiting for candidate commit.
    socket.close()
    await delay(100)
    assert.equal(registry.hasUpgradeWaiter('n1'), true, 'original socket disconnect must not resolve upgrade waiter')
  } finally {
    await registry.close()
  }
})

test('registry: original RPC disconnect followed by candidate commit still succeeds; timeout fails explicitly', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const { socket } = await registerRaw(registry, 'n1', { version: '1.0.0' })
    const handle = registry.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 5_000,
    })
    socket.close() // Simulate old RPC transport closing
    const candidate = await registerRaw(registry, 'n1', { version: '1.1.0', upgradeAttemptId: 'a1' })
    registry.noteHeartbeat('n1', candidate.socket as unknown as WsLike, {
      upgradeCommit: { attemptId: 'a1', version: '1.1.0', previousVersion: '1.0.0', pid: 7 },
    })
    const result = await handle.result
    assert.equal(result.ok, true)
    assert.equal(result.upgraded, true)
    assert.equal(result.pid, 7)
  } finally {
    await registry.close()
  }

  // Timeout path.
  const registry2 = new NodeRegistry({ authenticate: () => true })
  try {
    await registerRaw(registry2, 'n1', { version: '1.0.0' })
    const handle = registry2.beginUpgrade('n1', {
      attemptId: 'a1',
      targetVersion: '1.1.0',
      previousVersion: '1.0.0',
      timeoutMs: 200,
    })
    await assert.rejects(handle.result, HelmxUpgradeTimeoutError)
    assert.equal(registry2.hasUpgradeWaiter('n1'), false)
  } finally {
    await registry2.close()
  }
})

// ---------------------------------------------------------------------------
// Full Hub (KernelRuntime + startHub) + programmable node fixture
// ---------------------------------------------------------------------------

/**
 * Programmable WS node fixture: connects via real /ws/node and handles register / heartbeat /
 * nodeCheckUpgrade / nodeUpgrade (behavior scripted per test case). Typical upgrade scenario:
 * after nodeUpgrade returns, disconnects the old connection, then reconnects with candidate
 * identity (new version + attemptId) and either commits via heartbeat per plan or skips commit.
 */
interface FixturePlan {
  /** Synthesized return value for nodeUpgrade RPC. */
  rpcResult: RpcResult<NodeUpgradeResult>
  /** Never return from RPC (simulates legacy node hanging; overall operation must still have a deadline). */
  hang?: boolean
  /** After RPC returns, disconnect old connection and reconnect with candidate identity (version=plan.candidateVersion). */
  reconnect?: { candidateVersion: string; previousVersion?: string; installMode?: NodeInstallMode }
  /** Commit after candidate registration (false = do not commit; defaults to exact matching commit). */
  commit?: false | { attemptId: string; version: string; previousVersion: string; pid: number }
  /** Delay in ms between candidate registration and commit (simulates transport disconnect landing first, commit arriving later). */
  commitDelayMs?: number
  /**
   * RPC reply never arrives: after reconnect completes (candidate evicts old socket),
   * nodeUpgrade returns a never-resolving Promise to simulate in-flight RPC being closed.
   * Covers real chain: registry #evict -> old rpc $close -> birpc rejects in-flight
   * call -> ws-gateway onGeneralError swallows rejection -> Hub resolves undefined.
   */
  deferReplyUntilReplaced?: boolean
  /** Optional custom handler invoked per nodeUpgrade call (for multi-attempt failure->success or deferred-reply tests). */
  onUpgrade?: (input: NodeUpgradeRpcInput, callIndex: number) => Promise<RpcResult<NodeUpgradeResult>> | RpcResult<NodeUpgradeResult>
}

interface FixtureNode {
  nodeId: string
  registeredVersion: string | undefined
  lastAttemptId: string | undefined
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
    registerOverride(extra: { version?: string; upgradeAttemptId?: string }): Promise<NodeRegisterResult>
    sendHeartbeat(input?: NodeHeartbeatInput): Promise<boolean>
    upgradeCalls: NodeUpgradeRpcInput[]
    checkCalls: number
  }
> {
  const upgradeCalls: NodeUpgradeRpcInput[] = []
  let checkCalls = 0
  const candidateClosers: Array<() => void> = []
  const state = {
    plan: options.initialPlan as FixturePlan | undefined,
    registeredVersion: undefined as string | undefined,
    lastAttemptId: undefined as string | undefined,
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
    register: async (input: NodeRegisterInput) => {
      state.registeredVersion = input.version
      if (input.upgradeAttemptId !== undefined) state.lastAttemptId = input.upgradeAttemptId
      return { ok: true, heartbeatMs: 60_000 }
    },
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
      if (plan.hang === true) {
        // Never returns (nor reconnects): verifies Hub overall timeout still has an upper bound.
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      if (plan.reconnect !== undefined) {
        // Simulates real upgrade: reply RPC first (old connection stays open), then disconnect asynchronously and reconnect as candidate.
        const reconnectVersion = plan.reconnect.candidateVersion
        const attemptId = input.attemptId ?? ''
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* already closed */
          }
          void connectCandidate(wsUrl, nodeId, nodeToken, reconnectVersion, attemptId, state, plan, candidateClosers)
        }, 30).unref()
      }
      if (plan.deferReplyUntilReplaced === true) {
        // In-flight RPC evicted: after candidate registers, old socket birpc closes via $close, so this side's
        // birpc reply fails to send on the disconnected socket — never resolve, exercising the real Hub
        // chain (evict -> $close -> onGeneralError swallows rejection).
        return new Promise<RpcResult<NodeUpgradeResult>>(() => undefined)
      }
      return plan.rpcResult
    },
    // Remaining env RPCs are never triggered in this test.
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

  // Initial registration (current version + optional installMode).
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
    get registeredVersion() {
      return state.registeredVersion
    },
    get lastAttemptId() {
      return state.lastAttemptId
    },
    upgradeCalls,
    get checkCalls() {
      return checkCalls
    },
    setPlan(plan) {
      state.plan = plan
    },
    async registerOverride(extra) {
      return rpc.register({
        nodeId,
        token: nodeToken,
        hostname: 'upgrade-fixture',
        platform: process.platform,
        ...(extra.version !== undefined ? { version: extra.version } : {}),
        ...(extra.upgradeAttemptId !== undefined ? { upgradeAttemptId: extra.upgradeAttemptId } : {}),
      })
    },
    sendHeartbeat: (input) => rpc.heartbeat(nodeId, input),
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

/** Candidate connection: new socket registers new version + attemptId and commits per plan. */
async function connectCandidate(
  wsUrl: string,
  nodeId: string,
  nodeToken: string,
  version: string,
  attemptId: string,
  state: { registeredVersion: string | undefined; lastAttemptId: string | undefined },
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
      register: async (input: NodeRegisterInput) => {
        state.registeredVersion = input.version
        if (input.upgradeAttemptId !== undefined) state.lastAttemptId = input.upgradeAttemptId
        return { ok: true, heartbeatMs: 60_000 }
      },
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
  // Candidate commit: defaults to a full match; false skips committing (tests registration without commit);
  // commitDelayMs delays sending commit (simulating transport disconnect arriving first, commit later).
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
              previousVersion: plan.reconnect?.previousVersion ?? previousVersionFor(nodeId, attemptId),
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

/** Tracks previousVersion in the upgrade scenario (commit's previousVersion must match the waiter). */
const previousVersionByAttempt = new Map<string, string>()
function previousVersionFor(nodeId: string, attemptId: string): string {
  return previousVersionByAttempt.get(`${nodeId}:${attemptId}`) ?? '1.0.0'
}

/** Starts a full Hub instance (with /ws/node gateway and authentication). */
async function openHubApp(
  dir: string,
  options: {
    autoResume?: boolean
    autoUpgradeNodes?: boolean
    nodeAutoUpgradePolicy?: NodeAutoUpgradeRetryPolicy
    nodeUpgradeTimeoutMs?: number
    faux?: ReturnType<typeof fauxProvider>
  } = {},
): Promise<{
  kernel: KernelRuntime
  hub: Awaited<ReturnType<typeof startHub>>
  token: string
  faux: ReturnType<typeof fauxProvider>
  close(): Promise<void>
}> {
  const models = createModels()
  const faux = options.faux ?? fauxProvider()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
    nodeUpgradeTimeoutMs: options.nodeUpgradeTimeoutMs ?? 600,
    ...(options.autoResume !== undefined ? { autoResume: options.autoResume } : {}),
    ...(options.autoUpgradeNodes !== undefined ? { autoUpgradeNodes: options.autoUpgradeNodes } : {}),
    ...(options.nodeAutoUpgradePolicy !== undefined ? { nodeAutoUpgradePolicy: options.nodeAutoUpgradePolicy } : {}),
  })
  const hub = await startHub({
    kernel: kernel as never,
    port: 0,
  })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'node-upgrade-test-pass' }),
  })
  const { token } = (await setup.json()) as { token: string }
  return {
    kernel,
    hub,
    token,
    faux,
    close: async () => {
      await hub.close()
      await kernel.close()
    },
  }
}

/** Issues a node credential and connects the fixture node. */
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
// HTTP / RPC integration: upgrade orchestration (success, false-success guard, error mapping)
// ---------------------------------------------------------------------------

test('upgrade: candidate registration alone (without commit) never succeeds -- explicit unconfirmed error', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'no-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-no-commit', '1.0.0')
    previousVersionByAttempt.set(`up-no-commit:${node.upgradeCalls.length}`, '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commit: false, // candidate registers but never commits
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-no-commit/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 502, 'registration without commit must fail explicitly (never false-succeed)')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: matching commit (after old RPC disconnects) succeeds and confirms result', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'commit-ok-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-ok', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      // default commit: attemptId/version taken from candidate's actual registration, previousVersion is 1.0.0.
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-ok/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: ' v1.1.0 ' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'v prefix normalized to canonical version')
    assert.equal(body.previousVersion, '1.0.0')
    assert.equal(typeof body.pid, 'number')
    // RPC arguments carry normalized targetVersion and server-generated attemptId.
    assert.equal(node.upgradeCalls.length, 1)
    assert.equal(node.upgradeCalls[0]!.targetVersion, '1.1.0')
    assert.match(node.upgradeCalls[0]!.attemptId ?? '', /^[0-9a-f]{32}$/)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: structured node rejection maps to 400/501/502 without false success', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'reject-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-reject', '1.0.0')
    const failures = [
      { code: 'invalid', status: 400 },
      { code: 'not_supported', status: 501 },
      { code: 'unknown', status: 502 },
    ] as const
    for (const failure of failures) {
      node.setPlan({ rpcResult: { ok: false, error: { code: failure.code, message: 'target version unavailable' } } })
      const res = await fetch(`${app.hub.url}/api/nodes/up-reject/upgrade`, {
        method: 'POST',
        headers: authHeaders(app.token),
        body: JSON.stringify({ targetVersion: '1.1.0' }),
      })
      assert.equal(res.status, failure.status, failure.code)
    }
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: explicit no-op (ok: true, upgraded: false) returns normally without waiting for commit', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'noop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-noop', '1.1.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.1.0', targetVersion: '1.1.0', upgraded: false } },
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-noop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.upgraded, false)
    node.setPlan({
      rpcResult: { ok: true, value: { ok: false, previousVersion: '1.1.0', targetVersion: '1.1.0', upgraded: false } },
    })
    const failed = await fetch(`${app.hub.url}/api/nodes/up-noop/upgrade`, {
      method: 'POST', headers: authHeaders(app.token), body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(failed.status, 502, 'ok: false cannot masquerade as a no-op success')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade error mapping: local 400 / unknown 404 / offline 409 / unsupported 501', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'errors-'))
  const app = await openHubApp(dir)
  try {
    // local node.
    const local = await fetch(`${app.hub.url}/api/nodes/local/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(local.status, 400)
    // unknown node (not provisioned).
    const unknown = await fetch(`${app.hub.url}/api/nodes/ghost/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(unknown.status, 404)
    // provisioned but offline.
    const issue = await fetch(`${app.hub.url}/api/nodes/issue`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ nodeId: 'up-offline' }),
    })
    assert.equal(issue.status, 201)
    const offline = await fetch(`${app.hub.url}/api/nodes/up-offline/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: '{}',
    })
    assert.equal(offline.status, 409)
    const offlineBody = (await offline.json()) as { error: { code: string } }
    assert.equal(offlineBody.error.code, 'node_offline')
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade check: passes through node result (including blocked); validates body/query boundaries', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'check-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-check', '1.0.0')
    const res = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check`, {
      headers: authHeaders(app.token),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeCheckResult
    assert.equal(body.currentVersion, '1.0.0')
    assert.equal(body.latestVersion, '9.9.9')
    assert.equal(body.updateAvailable, true)
    node.close()

    // Invalid registryUrl (non-http(s)).
    const badUrl = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade/check?registryUrl=ftp://x`, {
      headers: authHeaders(app.token),
    })
    assert.equal(badUrl.status, 400)

    // Unknown fields in POST body are rejected.
    const unknownField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ attemptId: 'user-controlled' }),
    })
    assert.equal(unknownField.status, 400, 'attemptId cannot be controlled by the user')
    const badForce = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ force: 'yes' }),
    })
    assert.equal(badForce.status, 400)
    const badRegistry = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ registryUrl: 'javascript:alert(1)' }),
    })
    assert.equal(badRegistry.status, 400)
    const badVersion = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: 'latest' }),
    })
    assert.equal(badVersion.status, 400)
    for (const field of ['targetVersion', 'registryUrl']) {
      const nullField = await fetch(`${app.hub.url}/api/nodes/up-check/upgrade`, {
        method: 'POST', headers: authHeaders(app.token), body: JSON.stringify({ [field]: null }),
      })
      assert.equal(nullField.status, 400, `${field}: null must reject rather than silently falling back to default`)
    }
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: node disconnects mid-RPC -- never falsely succeeds (unconfirmed 502)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'rpc-drop-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-drop', '1.0.0')
    node.setPlan({
      // RPC succeeded, but the node disappears without reconnecting or committing.
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
    })
    // Disconnect immediately after RPC returns (produces no candidate).
    const resPromise = fetch(`${app.hub.url}/api/nodes/up-drop/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    await delay(50)
    node.close()
    const res = await resPromise
    assert.equal(res.status, 502, 'upgrade must not succeed without a candidate commit')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
  } finally {
    await app.close().catch(() => undefined)
  }
})

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

test('manual POST /api/nodes/:id/upgrade rejects source-mode nodes with 501 node_upgrade_source_mode (both preflight and RPC)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'manual-src-'))
  const app = await openHubApp(dir, { autoUpgradeNodes: false })
  try {
    // 1. Registered with installMode=source -> Hub rejects immediately without invoking nodeUpgrade RPC.
    const srcNode = await provisionNode(app.hub.url, app.token, 'src-manual', '0.0.1', { installMode: 'source' })
    const res1 = await fetch(`${app.hub.url}/api/nodes/src-manual/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: hubVersion() }),
    })
    assert.equal(res1.status, 501)
    const body1 = (await res1.json()) as { error: { code: string; message: string } }
    assert.equal(body1.error.code, 'node_upgrade_source_mode')
    assert.match(body1.error.message, /source_mode/)
    assert.equal(srcNode.upgradeCalls.length, 0, 'Hub preflight must not invoke nodeUpgrade on source-mode node')
    srcNode.close()

    // 2. Legacy/unannounced node replying with RPC code=source_mode -> Hub still maps cleanly to 501 node_upgrade_source_mode.
    const rpcSrcNode = await provisionNode(app.hub.url, app.token, 'src-rpc-only', '1.0.0', {
      initialPlan: {
        rpcResult: {
          ok: false,
          error: { code: 'source_mode', message: 'not_supported (source_mode): update source and restart manually' },
        },
      },
    })
    const res2 = await fetch(`${app.hub.url}/api/nodes/src-rpc-only/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res2.status, 501)
    const body2 = (await res2.json()) as { error: { code: string } }
    assert.equal(body2.error.code, 'node_upgrade_source_mode')
    assert.equal(rpcSrcNode.upgradeCalls.length, 1)
    rpcSrcNode.close()
  } finally {
    await app.close().catch(() => undefined)
  }
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

test('auto-upgrade startup gate: defers older node during two-phase boot until kernel.start() finishes recovery', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'auto-startup-gate-'))
  // Two-phase boot matching hub/main.ts: open listener before kernel.start().
  const app = await openHubApp(dir, { autoResume: false })
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

    // Complete Hub startup + recovery -> pending node wakes up and upgrades to Hub version.
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
          // Second attempt succeeds with real candidate takeover.
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
              { registeredVersion: '0.0.1', lastAttemptId: input.attemptId },
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

    // 4. Concurrency deduplication: while an upgrade is in flight, repeated notifyHubReady() never triggers a second call.
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
    app.kernel.nodes.notifyHubReady()
    app.kernel.nodes.notifyHubReady()
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
      app.kernel.nodes.notifyHubReady()
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

test('NodeAutoUpgradeCoordinator: fails closed for undefined or unknown runtime installMode and transitions cleanly to source or release', { timeout: 60_000 }, async () => {
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
})

test('upgrade: waits for commit after candidate registers 50ms later even when transport disconnects first', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'late-commit-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-late', '1.0.0')
    // Upgrade flow: RPC replies -> old socket disconnects (rpcError must reach Hub first) ->
    // candidate reconnects and registers -> commits 50ms later. Hub must keep waiting for commit
    // rather than terminally failing on disconnect (regression: racing resolved rpcPromise).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      commitDelayMs: 50,
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-late/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200, 'disconnect first, commit later: must ultimately succeed')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: in-flight RPC closed by candidate takeover (reply swallowed as undefined) -- waits for real commit and succeeds', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'inflight-close-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-inflight', '1.0.0')
    // Real-world restart timing: reconnect runs concurrently (old socket closes + candidate registers)
    // before the old connection's nodeUpgrade reply ever resolves -- birpc rejects in-flight call on
    // $close and ws-gateway.onGeneralError swallows it into resolve(undefined).
    // Previously: race took { kind: 'rpc', value: undefined } -> invalid shape 502 premature failure;
    // Now: detects transport interruption and continues waiting for candidate commit (commitDelayMs 50ms).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
      deferReplyUntilReplaced: true,
      commitDelayMs: 50,
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-inflight/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200, 'must wait for commit after in-flight RPC closes on takeover instead of failing prematurely with 502')
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.ok, true)
    assert.equal(body.upgraded, true)
    assert.equal(body.targetVersion, '1.1.0', 'target comes from real commit heartbeat')
    assert.equal(body.previousVersion, '1.0.0', 'previous comes from real commit heartbeat')
    assert.equal(typeof body.pid, 'number')
    assert.ok(Number.isInteger(body.pid) && body.pid! > 0, 'pid must be the positive integer from the real commit')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: RPC never returns and no candidate arrives -- fails within short bounded timeout (no 30min hang)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'hang-'))
  const app = await openHubApp(dir) // nodeUpgradeTimeoutMs = 600
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-hang', '1.0.0')
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      hang: true, // never replies and never reconnects
    })
    const startedAt = Date.now()
    const res = await fetch(`${app.hub.url}/api/nodes/up-hang/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    const elapsed = Date.now() - startedAt
    assert.equal(res.status, 502, 'dead RPC must fail explicitly')
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'node_upgrade_unconfirmed')
    assert.ok(elapsed < 30_000, `upgrade waiter must be bounded (actual ${elapsed}ms, never hang birpc 30min)`)
    // Waiter cleaned up: node can start a new upgrade (never permanently busy).
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-hang'), false)
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: waiter cleans up after invalid RpcResult/payload -- same node can upgrade again (no permanent busy lock)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'busy-'))
  const app = await openHubApp(dir)
  try {
    const node = await provisionNode(app.hub.url, app.token, 'up-busy', '1.0.0')
    // First attempt: malformed payload (missing targetVersion field).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', upgraded: true } as unknown as NodeUpgradeResult },
    })
    const first = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(first.status, 502, 'malformed result payload must fail explicitly')
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false, 'waiter must be cleaned up after failure')
    // Second attempt: structured rejection also allows re-entry.
    node.setPlan({ rpcResult: { ok: false, error: { code: 'not_supported', message: 'injected rejection' } } })
    const second = await fetch(`${app.hub.url}/api/nodes/up-busy/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.2.0' }),
    })
    assert.equal(second.status, 501)
    assert.equal(app.kernel['envFabric'].registry.hasUpgradeWaiter('up-busy'), false)
    assert.equal(node.upgradeCalls.length, 2, 'both calls should reach the node without being blocked as busy')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('upgrade: uses real currentVersion from check as previousVersion when node omits reported version (never unknown)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'prev-'))
  const app = await openHubApp(dir)
  try {
    // When registration omits version, Hub must populate currentVersion=1.0.0 via check.
    const node = await provisionNode(app.hub.url, app.token, 'up-prev', '1.0.0')
    // Verify directly: upgrade success path derives previousVersion from conn.version (1.0.0).
    node.setPlan({
      rpcResult: { ok: true, value: { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } },
      reconnect: { candidateVersion: '1.1.0' },
    })
    const res = await fetch(`${app.hub.url}/api/nodes/up-prev/upgrade`, {
      method: 'POST',
      headers: authHeaders(app.token),
      body: JSON.stringify({ targetVersion: '1.1.0' }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as NodeUpgradeResult
    assert.equal(body.previousVersion, '1.0.0', 'previousVersion must be the real version, never unknown')
    node.close()
  } finally {
    await app.close().catch(() => undefined)
  }
})

test('teardown: clean up temporary directory', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
