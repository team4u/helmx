/**
 * Daemon upgrade RPC wiring tests (core `upgrader.ts` engine is covered by `node-upgrade.test.ts`):
 * - Env server draining gate: synchronous acceptance at guard entry (tracks accepted-not-yet-spawned count),
 *   rejects new commands, and inherits `pendingActivation`;
 * - Strict RPC argument boundaries: rejects non-objects / unknown fields / invalid types / untrusted
 *   registries while preserving error codes;
 * - Without `prepareUpgradeReplacement`: `checkUpgrade` still works while `upgrade` returns explicit `not_supported`;
 * - `register` reports actual running version and `upgradeAttemptId`;
 * - Upgrade success: draining -> commit -> `onUpgradeReplaced` -> reconnect paused;
 * - Same-version no-op: restores flags/gate/reconnect; rollback on failure: restores and resumes commands;
 * - Unconfirmed commit (`cause` chain): holds draining awaiting host exit without rolling back;
 * - Concurrent busy rejection / retryable after invalid inputs / rejects after `close()`;
 * - `confirmUpgrade`: candidate identity reconciliation (`attemptId`/`version`/`pid`), idempotency,
 *   immediate commit via heartbeat, and continued commit retries after reconnect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { deferred, sleep as delay, withTimeout } from '@helmx/test-kit';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helmx/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeHeartbeatInput,
  NodeInstallMode,
  NodeRegisterInput,
  NodeRegisterResult,
} from '@helmx/protocol';
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js';
import { createNodeDaemon } from '../src/daemon/index.js';
import {
  UpgradeCommitUnconfirmedError,
  getNodeVersion,
  readCurrentRelease,
  readBlockedRelease,
  type PreparedNodeReplacement,
  type StagedNodeRelease,
} from '../src/daemon/upgrader.js';

/** Poll until an observable condition holds (instead of fixed sleeps), failing explicitly on timeout. */
const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, intervalMs: 10, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// 1. Env server draining gate and active exec counting (guard entry)
// ---------------------------------------------------------------------------

test('setDraining(true) rejects new envExec synchronously, false restores it, and in-flight execs finish normally', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-drain-');
  const ready = deferred<void>();
  const server = createNodeEnvRpcServer({
    defaultCwd: dir,
    onExecOutput: (event) => {
      if (event.execId === 'e-slow' && event.text.includes('READY')) ready.resolve();
    },
  });
  try {
    const releaseFlag = path.join(dir, 'release.flag');
    const slow = server.envExec({
      execId: 'e-slow',
      command: `node -e "const fs=require('fs'); console.log('READY'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFlag)})){clearInterval(t);process.exit(0)}},10)"`,
      timeout: 30,
    });
    await withTimeout(ready.promise, 5_000, 'in-flight exec did not start');
    assert.equal(server.getActiveExecCount(), 1, 'accepted incomplete exec counts toward getActiveExecCount');

    server.setDraining(true);
    const rejected = await server.envExec({ execId: 'e-new', command: 'echo hi', timeout: 10 });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, 'node_draining');

    await fs.writeFile(releaseFlag, 'go');
    const done = await slow;
    assert.equal(done.ok, true);
    assert.equal(server.getActiveExecCount(), 0);

    server.setDraining(false);
    const ok = await server.envExec({ execId: 'e-again', command: 'echo hi', timeout: 10 });
    assert.equal(ok.ok, true);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('guard entry registers synchronously before spawn and subsequent setDraining does not cancel accepted calls', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-count-');
  const server = createNodeEnvRpcServer({ defaultCwd: dir });
  try {
    const jobs = [1, 2, 3].map((i) => server.envExec({ execId: `e-${i}`, command: 'sleep 0.05', timeout: 30 }));
    // No delay needed: guard entry registers synchronously so all 3 count immediately before spawn
    assert.equal(server.getActiveExecCount(), 3);
    // Already-accepted calls complete normally despite subsequent setDraining
    server.setDraining(true);
    const results = await Promise.all(jobs);
    assert.equal(results.every((r) => r.ok), true, 'accepted commands must not be impacted by subsequent draining');
    assert.equal(server.getActiveExecCount(), 0);
  } finally {
    await server.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Hub fixture (version / upgradeAttemptId / heartbeat commit assertions)
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  port: number;
  registrations: NodeRegisterInput[];
  /** Captured heartbeat inputs (including `upgradeCommit`). */
  heartbeatInputs: NodeHeartbeatInput[];
  nodeRpc(): BirpcReturn<NodeEnvRpcFunctions, object> | undefined;
  close(): Promise<void>;
}

async function startHubFixture(options: { expectedToken: string; heartbeatMs?: number; port?: number }): Promise<HubFixture> {
  const registrations: NodeRegisterInput[] = [];
  const heartbeatInputs: NodeHeartbeatInput[] = [];
  let nodeRpc: BirpcReturn<NodeEnvRpcFunctions, NodeHubLocal> | undefined;
  let pendingSocket: WebSocket | undefined;

  interface NodeHubLocal {
    register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
    heartbeat(nodeId: string, input?: NodeHeartbeatInput): boolean;
    onEnvExecOutput(event: EnvExecOutputEvent): void;
  }
  const local: NodeHubLocal = {
    async register(input) {
      registrations.push(input);
      if (input.token !== options.expectedToken) return { ok: false, heartbeatMs: 0, reason: 'invalid token' };
      return { ok: true, heartbeatMs: options.heartbeatMs ?? 15_000 };
    },
    heartbeat(nodeId, input) {
      void nodeId;
      if (input !== undefined) heartbeatInputs.push(input);
      return true;
    },
    onEnvExecOutput() {
      // Streaming output is not consumed in this test.
    },
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const dispatchers: Array<(data: unknown) => void> = [];
      nodeRpc = createBirpc<NodeEnvRpcFunctions, NodeHubLocal>(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          dispatchers.push(callback as (data: unknown) => void);
        },
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30_000,
      });
      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== 'object') return;
        for (const dispatch of dispatchers) {
          try {
            dispatch(parsed);
          } catch {
            // ignore single layer failed
          }
        }
      });
      wss.emit('connection', ws, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const port = typeof address === 'object' && 'port' in address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registrations,
    heartbeatInputs,
    nodeRpc: () => nodeRpc,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

/** Managed host test double calling real `createNodeDaemon` with `prepareUpgradeReplacement`. */
interface HostStub {
  daemon: Awaited<ReturnType<typeof createNodeDaemon>>;
  prepareCalls: { release: StagedNodeRelease; context: { attemptId: string; previousVersion: string; targetVersion: string } }[];
  commitCalls: number;
  abortCalls: number;
  replacedPids: number[];
  /** Behavior switch: commit optionally awaits `commitHold` (for busy tests) before throwing `commitError`. */
  behavior: { commitError?: Error; commitHold?: Promise<void> };
}

async function startManagedDaemon(options: {
  hubUrl: string;
  dataDir: string;
  nodeId?: string;
  upgradeAttemptId?: string;
  pendingActivation?: boolean;
  withPrepare: boolean;
  installMode?: NodeInstallMode;
}): Promise<HostStub> {
  const stub: HostStub = {
    daemon: undefined as never,
    prepareCalls: [],
    commitCalls: 0,
    abortCalls: 0,
    replacedPids: [],
    behavior: {},
  };
  stub.daemon = await createNodeDaemon({
    hubUrl: options.hubUrl,
    identity: { nodeId: options.nodeId ?? 'up-a', token: 'up-a:secret-a' },
    dataDir: options.dataDir,
    // Existing upgrade RPC wiring tests exercise release-mode behavior; source-mode exemption is tested explicitly below.
    installMode: options.installMode ?? 'release',
    reconnectBaseDelayMs: 30,
    reconnectMaxDelayMs: 120,
    ...(options.withPrepare
      ? {
          prepareUpgradeReplacement: async (release, context) => {
            stub.prepareCalls.push({ release, context });
            const replacement: PreparedNodeReplacement = {
              pid: 424242,
              async commit() {
                stub.commitCalls += 1;
                if (stub.behavior.commitHold) await stub.behavior.commitHold;
                if (stub.behavior.commitError) throw stub.behavior.commitError;
              },
              async abort() {
                stub.abortCalls += 1;
              },
            };
            return replacement;
          },
        }
      : {}),
    onUpgradeReplaced: (pid) => {
      stub.replacedPids.push(pid);
    },
    ...(options.upgradeAttemptId !== undefined ? { upgradeAttemptId: options.upgradeAttemptId } : {}),
    ...(options.pendingActivation !== undefined ? { pendingActivation: options.pendingActivation } : {}),
  });
  return stub;
}

/** Stage a valid release directory layout (`.complete` at version root for cache validation). */
async function seedStagedRelease(dataDir: string, version: string): Promise<void> {
  const versionRoot = path.join(dataDir, 'releases', version);
  const candidate = path.join(versionRoot, 'seeded');
  const nodePkgDir = path.join(candidate, 'node_modules', '@helmx', 'node');
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(candidate, 'node_modules', '.bin'), { recursive: true });
  const entryPath = path.join(nodePkgDir, 'dist', 'cli.js');
  await fs.writeFile(entryPath, '#!/usr/bin/env node\n');
  await fs.writeFile(
    path.join(nodePkgDir, 'package.json'),
    JSON.stringify({ name: '@helmx/node', version }),
  );
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({
      version,
      candidateDir: candidate,
      entries: {
        entryPath,
        cliBinDir: path.join(candidate, 'node_modules', '.bin'),
      },
      completedAt: new Date().toISOString(),
      origin: 'extractor',
    }),
  );
}

/** Poll until `envExec` is rejected by draining (upgrade engine enters draining asynchronously). */
async function waitUntilDraining(rpc: BirpcReturn<NodeEnvRpcFunctions, object>, tag: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastCode = '';
  for (let i = 0; Date.now() < deadline; i += 1) {
    const r = await rpc.envExec({ execId: `probe-${tag}-${i}`, command: 'echo hi', timeout: 10 });
    if (!r.ok && r.error.code === 'node_draining') return;
    lastCode = r.ok ? 'ok' : r.error.code;
    await delay(15);
  }
  assert.fail(`draining gate did not activate (last state ${lastCode})`);
}

// ---------------------------------------------------------------------------
// 3. Without prepareUpgradeReplacement: checkUpgrade works / upgrade -> not_supported
// ---------------------------------------------------------------------------

test('without replacement host: checkUpgrade still queries real registry while upgrade returns not_supported', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-noprep-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    // Update check does not need replacement host (uses real public npm package via HELMX_NPM_PACKAGE)
    process.env.HELMX_NPM_PACKAGE = 'eslint';
    const check = await stub.daemon.checkUpgrade();
    assert.ok(check.currentVersion.length > 0);
    assert.ok(check.latestVersion.length > 0);
    // Upgrade rejects explicitly with typed error code instead of fabricating success
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: '1.0.0', force: true }),
      (error: Error & { code?: string }) => error.code === 'not_supported',
    );
    assert.equal(stub.daemon.isUpgrading(), false);
    // RPC path returns RpcResult error envelope
    const rpc = hub.nodeRpc();
    assert.ok(rpc?.nodeUpgrade !== undefined, 'outer RPC should expose nodeUpgrade');
    const rpcUp = await rpc!.nodeUpgrade!({ targetVersion: '1.0.0' });
    assert.equal(rpcUp.ok, false);
    assert.equal(!rpcUp.ok && rpcUp.error.code, 'not_supported');
    // RPC checkUpgrade still works
    const rpcCheck = await rpc!.nodeCheckUpgrade!({});
    assert.equal(rpcCheck.ok, true, `RPC checkUpgrade should succeed: ${!rpcCheck.ok && rpcCheck.error.message}`);
  } finally {
    delete process.env.HELMX_NPM_PACKAGE;
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. register reports actual running version and upgradeAttemptId
// ---------------------------------------------------------------------------

test('register reports getNodeVersion() and options.upgradeAttemptId', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-regver-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({
    hubUrl: hub.url,
    dataDir: dir,
    withPrepare: false,
    upgradeAttemptId: 'att-reg-1',
  });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    const reg = hub.registrations[0];
    assert.ok(reg !== undefined);
    assert.equal(reg?.version, getNodeVersion(), 'register should report actual running package version');
    assert.equal(reg?.installMode, 'release');
    assert.equal(reg?.upgradeAttemptId, 'att-reg-1');
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('source mode daemon: registers installMode=source with source package.json version and rejects upgrade RPC without writing current.json', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-src-rpc-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  // Pre-seed a historical current.json from an older npm release to ensure source mode ignores it completely.
  const staleCurrent = {
    version: '8.8.8',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: '/nonexistent/staged/dist/cli.js' },
  };
  await fs.writeFile(path.join(dir, 'current.json'), `${JSON.stringify(staleCurrent)}\n`, 'utf8');
  let prepareCalled = false;
  // Omit installMode to exercise default runtime detection under tsx source checkout.
  const daemon = await createNodeDaemon({
    hubUrl: hub.url,
    identity: { nodeId: 'up-a', token: 'up-a:secret-a' },
    dataDir: dir,
    reconnectBaseDelayMs: 60,
    reconnectMaxDelayMs: 250,
    prepareUpgradeReplacement: async () => {
      prepareCalled = true;
      return { pid: 999999, commit: async () => undefined, abort: async () => undefined };
    },
  });
  try {
    assert.equal(await daemon.waitUntilRegistered(10_000), true);
    const reg = hub.registrations[0];
    assert.ok(reg !== undefined);
    assert.equal(reg.installMode, 'source', 'source checkout daemon must report installMode=source');
    assert.equal(reg.version, getNodeVersion(), 'source daemon must report own package.json version, not stale current.json');

    // Local upgrade() rejects with source_mode even when prepareUpgradeReplacement is wired.
    await assert.rejects(
      () => daemon.upgrade({ targetVersion: '9.9.9', force: true }),
      (error: Error & { code?: string }) =>
        error.code === 'source_mode' && /source_mode/.test(error.message) && /restart/.test(error.message),
    );

    // Hub-invoked nodeUpgrade RPC rejects with code=source_mode and leaves node undrained and responsive.
    const rpc = hub.nodeRpc();
    assert.ok(rpc?.nodeUpgrade !== undefined);
    const rpcRes = await rpc!.nodeUpgrade!({ targetVersion: '9.9.9', force: true });
    assert.equal(rpcRes.ok, false);
    assert.equal(!rpcRes.ok && rpcRes.error.code, 'source_mode');
    assert.match(!rpcRes.ok ? rpcRes.error.message : '', /source_mode/);
    assert.equal(prepareCalled, false, 'source mode must never invoke prepareUpgradeReplacement');
    assert.equal(daemon.isUpgrading(), false, 'source mode rejection must not enter upgrading state');

    // Historical current.json must remain untouched (never overwritten by npm release staging).
    assert.deepEqual(await readCurrentRelease(dir), staleCurrent);

    // Normal envExec continues working (not drained).
    const execRes = await rpc!.envExec({ execId: 'src-still-live', command: 'echo ok', timeout: 10 });
    assert.equal(execRes.ok, true);
  } finally {
    await daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. RPC input boundaries and registry allowlist
// ---------------------------------------------------------------------------

test('RPC input validation rejects non-objects, unknown fields, and bad types as invalid; remote only allows trusted registries', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-rpcbound-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  try {
    assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
    const rpc = hub.nodeRpc()!;
    const call = (fn: unknown, input: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
      (fn as (i: unknown) => Promise<{ ok: boolean; error?: { code: string; message: string } }>)(input);

    const badArray = await call(rpc.nodeCheckUpgrade, ['not', 'object']);
    assert.equal(badArray.ok, false);
    assert.equal(badArray.error?.code, 'invalid');
    const badField = await call(rpc.nodeCheckUpgrade, { registryUrl: 'https://registry.npmjs.org', extra: 1 });
    assert.equal(badField.ok, false);
    assert.equal(badField.error?.code, 'invalid');

    // Untrusted remote registry source rejected by allowlist (filterRpcRegistryUrl)
    const evil = await call(rpc.nodeUpgrade, { registryUrl: 'https://evil.example.com' });
    assert.equal(evil.ok, false);
    assert.equal(evil.error?.code, 'invalid');
    assert.match(evil.error?.message ?? '', /untrusted npm registry rejected/);

    const badForce = await call(rpc.nodeUpgrade, { force: 'yes' });
    assert.equal(badForce.ok, false);
    assert.equal(badForce.error?.code, 'invalid');

    // Trusted local CLI call (trustedRegistry=true) reaches engine validation (invalid SemVer rejected)
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }, true),
      (error: Error & { code?: string }) => error.code === 'invalid' && /invalid SemVer/.test(error.message),
    );
  } finally {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Upgrade success: draining -> commit -> onUpgradeReplaced -> reconnect paused
// ---------------------------------------------------------------------------

test('upgrade success path: draining gate activates, commits once, invokes host callback, and pauses reconnect', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-upok-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  await seedStagedRelease(dir, '9.9.9');
  const rpc = hub.nodeRpc()!;

  const upgrading = rpc.nodeUpgrade!({ targetVersion: '9.9.9', attemptId: 'att-ok-1' });
  await waitUntilDraining(rpc, 'ok');

  const result = await upgrading;
  assert.equal(result.ok, true, `upgrade should succeed: ${!result.ok && result.error.message}`);
  assert.equal(result.ok && result.value.upgraded, true);
  assert.equal(result.ok && result.value.pid, 424242);
  assert.equal(result.ok && result.value.targetVersion, '9.9.9');

  assert.equal(stub.prepareCalls.length, 1);
  assert.equal(stub.commitCalls, 1);
  assert.equal(stub.abortCalls, 0);
  assert.equal(stub.prepareCalls[0]?.context.attemptId, 'att-ok-1');

  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '9.9.9');

  assert.deepEqual(stub.replacedPids, [424242]);
  assert.equal(stub.daemon.isUpgrading(), true, 'committed and awaiting exit, isUpgrading remains true');

  // Upgrade committed: after disconnect old daemon must not reconnect (awaiting host exit)
  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  await delay(180);
  assert.equal(hub2.registrations.length, 0, 'old daemon must not reconnect after upgrade commit');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 7. Same-version no-op: restores flags/gate/reconnect
// ---------------------------------------------------------------------------

test('upgrade same-version no-op (upgraded:false) restores flags/gate and stays reconnectable', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-upnoop-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // Target == current running version without force: engine immediately returns upgraded:false (no staging/network)
  const result = await stub.daemon.upgrade({ targetVersion: getNodeVersion() });
  assert.equal(result.upgraded, false);
  assert.equal(result.ok, true);
  assert.equal(stub.daemon.isUpgrading(), false, 'must not stay busy after no-op');
  assert.equal(stub.prepareCalls.length, 0);
  assert.equal(stub.replacedPids.length, 0);

  // Gate restored: commands execute and reconnect continues working
  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'noop-1', command: 'echo still-alive', timeout: 10 });
  assert.equal(exec.ok, true, `commands should run after no-op: ${!exec.ok && exec.error.message}`);

  await hub.close();
  const hub2 = await startHubFixture({ expectedToken: 'up-a:secret-a', port: hub.port });
  await waitFor(
    () => hub2.registrations.length === 1 && stub.daemon.isConnected(),
    15_000,
    'should remain reconnectable after no-op',
  );
  assert.equal(hub2.registrations.length, 1, 'should remain reconnectable after no-op');
  await hub2.close();
});

// ---------------------------------------------------------------------------
// 8. Upgrade failure: gate and reconnect recovery
// ---------------------------------------------------------------------------

test('upgrade failure rolls back, clears gate, restores reconnect, and accepts commands afterward', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-upfail-');
  let hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  const port = hub.port;

  await seedStagedRelease(dir, '8.8.8');
  stub.behavior.commitError = new Error('candidate register failed at hub');

  await hub.close();
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '8.8.8', attemptId: 'att-fail-1' }),
    (error: Error & { code?: string }) => /rolled back/.test(error.message),
  );

  assert.equal(stub.abortCalls, 1, 'failure path aborts candidate');
  assert.equal(stub.daemon.isUpgrading(), false);
  assert.equal((await readCurrentRelease(dir))?.version, undefined, 'no prior current: deleted after failure');
  assert.equal((await readBlockedRelease(dir))?.version, '8.8.8');

  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', port });
  await waitFor(
    () => hub.registrations.length === 1 && stub.daemon.isConnected(),
    15_000,
    'should resume reconnecting after failure',
  );
  assert.equal(hub.registrations.length, 1, 'should resume reconnecting after failure');

  const rpc = hub.nodeRpc()!;
  const exec = await rpc.envExec({ execId: 'after-fail', command: 'echo recovered', timeout: 10 });
  assert.equal(exec.ok, true, `new commands should execute after rollback: ${!exec.ok && exec.error.message}`);
  await hub.close();
});

// ---------------------------------------------------------------------------
// 9. Unconfirmed commit: stays draining without rollback while host yields
// ---------------------------------------------------------------------------

test('UpgradeCommitUnconfirmedError (via cause chain): no rollback, stays draining, host yields', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-upunconf-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  await seedStagedRelease(dir, '7.7.7');
  // Engine wraps UpgradeCommitUnconfirmedError in an Error preserving cause; daemon must detect
  // unconfirmed commit across the cause chain instead of treating it as a normal failure.
  stub.behavior.commitError = new UpgradeCommitUnconfirmedError('hub ack timeout');

  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '7.7.7', attemptId: 'att-unc-1' }),
    (error: Error) => /confirmation was unconfirmed/.test(error.message),
  );

  assert.equal((await readCurrentRelease(dir))?.version, '7.7.7', 'must not roll back: current points to new version');
  assert.equal(stub.abortCalls, 0);
  assert.deepEqual(stub.replacedPids, [424242]);
  assert.equal(stub.daemon.isUpgrading(), true, 'unconfirmed commit keeps yielding while awaiting host exit');
});

// ---------------------------------------------------------------------------
// 10. Concurrent busy / retryable after invalid input / rejects after close
// ---------------------------------------------------------------------------

test('concurrent upgrade rejects as busy without sharing result; retryable after invalid input; rejects after close', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-busy-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a' });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: true });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  await seedStagedRelease(dir, '9.9.9');
  await seedStagedRelease(dir, '8.8.8');

  // In-flight upgrade (8.8.8): commit waits on commitHold before throwing and rolling back.
  let releaseHold: (() => void) | undefined;
  stub.behavior.commitHold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let firstSettled = false;
  const first = stub.daemon.upgrade({ targetVersion: '8.8.8', attemptId: 'att-busy-1' }).then(
    (value) => {
      firstSettled = true;
      return value;
    },
    (error: Error) => {
      firstSettled = true;
      throw error;
    },
  );
  await waitUntilDraining(hub.nodeRpc()!, 'busy');

  // Concurrent different target: rejected immediately without sharing in-flight upgrade result
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid' && /already in progress/.test(error.message),
  );
  assert.equal(firstSettled, false, 'first upgrade still in-flight');

  // Unblock failure: retry works after rollback (invalid inputs never leave stale busy state)
  stub.behavior.commitError = new Error('candidate register failed at hub');
  releaseHold!();
  await assert.rejects(() => first, (error: Error) => /rolled back/.test(error.message));
  assert.equal(stub.daemon.isUpgrading(), false);

  // Repeated invalid inputs still fail fast without leaving daemon stuck busy
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => stub.daemon.upgrade({ targetVersion: 'not-a-version' }),
      (error: Error & { code?: string }) => error.code === 'invalid',
    );
  }

  // Rejects new upgrades after close
  await stub.daemon.close();
  await assert.rejects(
    () => stub.daemon.upgrade({ targetVersion: '9.9.9' }),
    (error: Error & { code?: string }) => error.code === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// 11. pendingActivation candidate: draining on creation, confirmUpgrade identity check & release
// ---------------------------------------------------------------------------

test('pendingActivation candidate rejects new commands until confirmUpgrade reconciles identity and reports commit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-pending-');
  const hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 60 });
  const stub = await startManagedDaemon({
    hubUrl: hub.url,
    dataDir: dir,
    withPrepare: false,
    pendingActivation: true,
    upgradeAttemptId: 'att-pend-1',
  });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);
  const rpc = hub.nodeRpc()!;

  const rejected = await rpc.envExec({ execId: 'pend-1', command: 'echo hi', timeout: 10 });
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.error.code, 'node_draining');

  // Identity reconciliation: mismatch in attemptId / version / pid rejects and keeps gate closed
  const pid = process.pid;
  const version = getNodeVersion();
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'wrong-att', version, previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version: '0.0.0', previousVersion: '6.6.5', pid }));
  await assert.rejects(() =>
    stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid: 12345 }));
  const stillDrained = await rpc.envExec({ execId: 'pend-2', command: 'echo hi', timeout: 10 });
  assert.equal(stillDrained.ok, false, 'failed reconciliation must not lift gate');

  // Matching commit resolves, sends immediate heartbeat with upgradeCommit, and lifts gate
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });
  await waitFor(() => hub.heartbeatInputs.some((input) => input.upgradeCommit !== undefined), 10_000, 'heartbeat carrying upgradeCommit');
  const commits = hub.heartbeatInputs.filter((input) => input.upgradeCommit !== undefined);
  assert.ok(commits.length >= 1, 'confirmUpgrade should carry upgradeCommit in immediate/subsequent heartbeats');
  assert.equal(commits[0]?.upgradeCommit?.attemptId, 'att-pend-1');
  assert.equal(commits[0]?.upgradeCommit?.pid, pid);

  const ok = await rpc.envExec({ execId: 'pend-3', command: 'echo hi', timeout: 10 });
  assert.equal(ok.ok, true, `confirmUpgrade should resume accepting commands: ${!ok.ok && ok.error.message}`);

  // Repeated identical commit is idempotent
  await stub.daemon.confirmUpgrade({ attemptId: 'att-pend-1', version, previousVersion: '6.6.5', pid });

  // Invalid parameters throw directly
  await assert.rejects(() => stub.daemon.confirmUpgrade({ attemptId: '', version: '1', previousVersion: '0', pid: -1 }));
});

// ---------------------------------------------------------------------------
// 12. Commit survives disconnect/reconnect in memory and continues retrying
// ---------------------------------------------------------------------------

test('commit survives disconnect in memory and retries in heartbeats on new connection', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-commitretry-');
  let hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 60 });
  const stub = await startManagedDaemon({ hubUrl: hub.url, dataDir: dir, withPrepare: false });
  t.after(async () => {
    await stub.daemon.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  assert.equal(await stub.daemon.waitUntilRegistered(10_000), true);

  // Non-candidate daemon confirmUpgrade skips identity check (ordinary heartbeat reporting path)
  await stub.daemon.confirmUpgrade({ attemptId: 'att-retry-1', version: '5.5.5', previousVersion: '5.5.4', pid: 777 });
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    'first heartbeat carrying commit',
  );
  assert.ok(hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'));

  await hub.close();
  hub = await startHubFixture({ expectedToken: 'up-a:secret-a', heartbeatMs: 60, port: hub.port });
  await waitFor(
    () => hub.registrations.length === 1 && stub.daemon.isConnected(),
    15_000,
    'should reconnect successfully',
  );
  assert.equal(hub.registrations.length, 1, 'should reconnect successfully');
  await waitFor(
    () => hub.heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-retry-1'),
    10_000,
    'heartbeat continues carrying commit after reconnect',
  );
  const retried = hub.heartbeatInputs.filter((input) => input.upgradeCommit?.attemptId === 'att-retry-1');
  assert.ok(retried.length >= 1, 'heartbeat after reconnect should keep carrying commit');
  await hub.close();
});

test('pushHeartbeatSoon coordinates with in-flight heartbeat without overlapping and marks commitAcked once acked', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-node-hbcoord-');
  const heartbeatInputs: NodeHeartbeatInput[] = [];
  let inFlightCount = 0;
  let maxConcurrentHeartbeats = 0;
  let releaseFirstHeartbeat: (() => void) | undefined;
  let markFirstHeartbeatEntered!: () => void;
  const firstHeartbeatEntered = new Promise<void>((resolve) => {
    markFirstHeartbeatEntered = resolve;
  });
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  let pendingSocket: WebSocket | undefined;
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const dispatchers: Array<(data: unknown) => void> = [];
      createBirpc<NodeEnvRpcFunctions, {
        register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
        heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>;
        onEnvExecOutput(event: EnvExecOutputEvent): void;
      }>(
        {
          async register() {
            return { ok: true, heartbeatMs: 40 };
          },
          async heartbeat(_nodeId, input) {
            inFlightCount += 1;
            maxConcurrentHeartbeats = Math.max(maxConcurrentHeartbeats, inFlightCount);
            try {
              if (input !== undefined) heartbeatInputs.push(input);
              if (heartbeatInputs.length === 1) {
                markFirstHeartbeatEntered();
                await new Promise<void>((done) => { releaseFirstHeartbeat = done; });
              }
              return true;
            } finally {
              inFlightCount -= 1;
            }
          },
          onEnvExecOutput() {},
        },
        {
          post: (data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); },
          on: (cb) => { dispatchers.push(cb as (data: unknown) => void); },
          serialize: (data) => data,
          deserialize: (data) => data as never,
          timeout: 30_000,
        },
      );
      ws.on('message', (raw) => {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as unknown;
        for (const d of dispatchers) d(parsed);
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    identity: { nodeId: 'hb-coord', token: 'hb-coord:sec' },
    dataDir: dir,
    installMode: 'release',
  });
  t.after(async () => {
    releaseFirstHeartbeat?.();
    await daemon.close().catch(() => undefined);
    pendingSocket?.close();
    wss.close(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });

  assert.equal(await daemon.waitUntilRegistered(10_000), true);
  await firstHeartbeatEntered;
  // Trigger pushHeartbeatSoon while periodic heartbeat #1 (without commit) is still in flight.
  await daemon.confirmUpgrade({ attemptId: 'att-coord-1', version: '2.0.0', previousVersion: '1.0.0', pid: process.pid });
  assert.equal(maxConcurrentHeartbeats, 1, 'pushHeartbeatSoon must queue behind in-flight heartbeat rather than overlapping');
  releaseFirstHeartbeat?.();
  await waitFor(
    () => heartbeatInputs.some((input) => input.upgradeCommit?.attemptId === 'att-coord-1'),
    10_000,
    'queued commit heartbeat sent after in-flight finishes',
  );
  await waitFor(() => heartbeatInputs.length >= 3, 10_000, 'subsequent periodic heartbeat');
  assert.equal(maxConcurrentHeartbeats, 1, 'heartbeats must never overlap');
  const commitCount = heartbeatInputs.filter((i) => i.upgradeCommit !== undefined).length;
  assert.equal(commitCount, 1, 'once commit is acknowledged, subsequent periodic heartbeats stop resending upgradeCommit');
});
