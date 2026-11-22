/**
 * End-to-end tests for `packages/payload/src/update-handoff.mjs` over the shared `@helmx/env-io`
 * Hub-switch engine:
 * - happy path: stops the running Hub over its verified control channel, commits `current.json`,
 *   spawns the target release, enforces `assertListenUrlMatches`, atomically persists `hub.pid`
 *   (`0600`, Linux `/proc` start-time proof, no leftover temp files), and clears `update-ready.json`
 *   & `update-blocked.json`;
 * - drift regression (`assertListenUrlMatches` parity): a target that prints a mismatched host
 *   listen URL is killed, `current.json` is restored to the previous release BEFORE restarting it,
 *   the previous release resumes with an updated atomic `hub.pid`, and `update-blocked.json`
 *   records the failed target.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteJson,
  controlEndpoint,
  createControlServer,
  HUB_CONTROL_PRODUCT,
  hubControlRecordPath,
  killProcessTree,
  readBlockedRelease,
  readCurrentRelease,
  readHubPidRecord,
  writeBlockedRelease,
  writeCurrentRelease,
  writeLaunchConfig,
} from '@helmx/env-io';
import { readUpdateReady, writeUpdateReady } from '@helmx/env-io/hub-payload';

const HANDOFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/update-handoff.mjs');

function makeTempDir(t: import('node:test').TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('HELMX_')) env[k] = v;
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function cleanupPid(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    killProcessTree(pid);
  } catch {
    // already exited
  }
}

async function writeFakeReleaseEntry(
  root: string,
  version: string,
  options: { bannerUrl?: (port: string) => string } = {},
): Promise<{ releaseDir: string; entryPath: string }> {
  const releaseDir = path.join(root, 'releases', version, 'candidate');
  await fsp.mkdir(releaseDir, { recursive: true });
  const entryPath = path.join(releaseDir, 'start.mjs');
  const script = `#!/usr/bin/env node
const port = process.env.HELMX_PORT || '3202';
const url = ${options.bannerUrl ? `(${JSON.stringify(options.bannerUrl('__PORT__'))}).replace('__PORT__', port)` : '`http://127.0.0.1:${port}`'};
process.stdout.write(\`Helmx Hub: \${url}\\n\`);
const timer = setInterval(() => {}, 60_000);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
`;
  await fsp.writeFile(entryPath, script, { encoding: 'utf8', mode: 0o755 });
  return { releaseDir, entryPath };
}

async function spawnControlFixture(
  t: import('node:test').TestContext,
  dataDir: string,
  port: number,
): Promise<{ child: ChildProcess; endpoint: string; instanceId: string }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000);'], {
    stdio: 'ignore',
  });
  t.after(() => cleanupPid(child.pid));
  assert.ok(child.pid !== undefined);
  const instanceId = 'a'.repeat(32);
  const endpoint = controlEndpoint(dataDir, instanceId, HUB_CONTROL_PRODUCT);
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: child.pid!, state: 'serving', version: '1.0.0' }),
    onStop: async () => {
      try {
        process.kill(child.pid!, 'SIGTERM');
      } catch {
        // already dead
      }
    },
  });
  await server.listening;
  t.after(() => server.close());
  await atomicWriteJson(
    hubControlRecordPath(dataDir),
    {
      instanceId,
      endpoint,
      pid: child.pid,
      version: '1.0.0',
      port,
      startedAt: new Date().toISOString(),
    },
    { mode: 0o600 },
  );
  return { child, endpoint, instanceId };
}

function runHandoff(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HANDOFF_SCRIPT], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('update-handoff: switches cleanly over control channel, verifies listen URL, writes hub.pid atomically, and clears ready/blocked', { timeout: 60_000 }, async (t) => {
  const root = makeTempDir(t, 'helmx-handoff-ok-');
  const dataDir = makeTempDir(t, 'helmx-handoff-ok-data-');
  const port = await freePort();

  const v1 = await writeFakeReleaseEntry(root, '1.0.0');
  const v2 = await writeFakeReleaseEntry(root, '1.1.0');
  await writeCurrentRelease(root, {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: v1.entryPath },
  });
  await writeLaunchConfig(root, { port, host: '127.0.0.1', dataDir });
  await writeBlockedRelease(root, { version: '0.9.0', reason: 'stale block', at: new Date().toISOString() });
  await writeUpdateReady(root, {
    version: '1.1.0',
    entryPath: 'start.mjs',
    releaseDir: v2.releaseDir,
    tag: 'latest',
    stagedAt: new Date().toISOString(),
  });

  const fixture = await spawnControlFixture(t, dataDir, port);

  const result = await runHandoff({
    ...cleanEnv(),
    HELMX_PORT: String(port),
    HELMX_HOST: '127.0.0.1',
    HELMX_HANDOFF_ROOT: root,
    HELMX_HANDOFF_TARGET: '1.1.0',
    HELMX_HANDOFF_ENTRY: v2.entryPath,
    HELMX_HANDOFF_RELEASE_DIR: v2.releaseDir,
    HELMX_HANDOFF_DATA_DIR: dataDir,
    HELMX_HANDOFF_CONTROL_ENDPOINT: fixture.endpoint,
    HELMX_HANDOFF_CONTROL_INSTANCE_ID: fixture.instanceId,
    HELMX_HANDOFF_LAUNCH_ID: 'handoff-launch-ok',
    HELMX_HANDOFF_GRACE_MS: '0',
    HELMX_HANDOFF_TEST_READY_TIMEOUT_MS: '10000',
  });
  assert.equal(result.code, 0, `handoff should succeed; stderr:\n${result.stderr}`);

  const pidRecord = await readHubPidRecord(root);
  assert.ok(pidRecord !== null, 'hub.pid must be written');
  t.after(() => cleanupPid(pidRecord.pid));
  assert.equal(pidRecord.version, '1.1.0');
  assert.equal(pidRecord.entryPath, v2.entryPath);
  assert.equal(pidRecord.port, port);
  assert.equal(pidRecord.host, '127.0.0.1');
  assert.equal(pidRecord.dataDir, dataDir);
  assert.equal(pidRecord.launchId, 'handoff-launch-ok');
  if (process.platform === 'linux') {
    assert.ok(typeof pidRecord.startTime === 'number' && pidRecord.startTime >= 0, 'Linux hub.pid records startTime');
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, 'hub.pid')).mode & 0o777, 0o600, 'hub.pid must be 0600');
  }
  const leftovers = (await fsp.readdir(root)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'atomic write must leave no temp files behind');

  const current = await readCurrentRelease(root);
  assert.equal(current?.version, '1.1.0');
  assert.equal(current?.entries['entryPath'], v2.entryPath);
  assert.equal(await readUpdateReady(root), null, 'update-ready.json cleared on success');
  assert.equal(await readBlockedRelease(root), null, 'update-blocked.json cleared on success');
});

test('update-handoff: rejects mismatched listen URL (assertListenUrlMatches), rolls back current.json, restarts previous, and blocks target', { timeout: 60_000 }, async (t) => {
  const root = makeTempDir(t, 'helmx-handoff-mismatch-');
  const dataDir = makeTempDir(t, 'helmx-handoff-mismatch-data-');
  const port = await freePort();

  const v1 = await writeFakeReleaseEntry(root, '1.0.0');
  // Candidate prints the configured port on a different host -> violates assertListenUrlMatches!
  const v2 = await writeFakeReleaseEntry(root, '1.1.0', {
    bannerUrl: (p) => `http://10.0.0.9:${p}`,
  });
  const previousRecord = {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: v1.entryPath },
  };
  await writeCurrentRelease(root, previousRecord);
  await writeLaunchConfig(root, { port, host: '127.0.0.1', dataDir });
  await writeUpdateReady(root, {
    version: '1.1.0',
    entryPath: 'start.mjs',
    releaseDir: v2.releaseDir,
    tag: 'latest',
    stagedAt: new Date().toISOString(),
  });

  const fixture = await spawnControlFixture(t, dataDir, port);

  const result = await runHandoff({
    ...cleanEnv(),
    HELMX_PORT: String(port),
    HELMX_HOST: '127.0.0.1',
    HELMX_HANDOFF_ROOT: root,
    HELMX_HANDOFF_TARGET: '1.1.0',
    HELMX_HANDOFF_ENTRY: v2.entryPath,
    HELMX_HANDOFF_RELEASE_DIR: v2.releaseDir,
    HELMX_HANDOFF_DATA_DIR: dataDir,
    HELMX_HANDOFF_CONTROL_ENDPOINT: fixture.endpoint,
    HELMX_HANDOFF_CONTROL_INSTANCE_ID: fixture.instanceId,
    HELMX_HANDOFF_LAUNCH_ID: 'handoff-launch-mismatch',
    HELMX_HANDOFF_GRACE_MS: '0',
    HELMX_HANDOFF_TEST_READY_TIMEOUT_MS: '10000',
  });
  assert.equal(result.code, 1, 'mismatched listen URL must fail handoff');
  assert.match(result.stderr, /launch configuration expects http:\/\/127\.0\.0\.1:/);
  assert.match(result.stderr, /rolled back to 1\.0\.0/);

  // current.json restored verbatim to 1.0.0, previous release restarted with atomic hub.pid, target blocked.
  assert.deepEqual(await readCurrentRelease(root), previousRecord);
  const pidRecord = await readHubPidRecord(root);
  assert.ok(pidRecord !== null, 'rolled-back previous release must persist hub.pid');
  t.after(() => cleanupPid(pidRecord.pid));
  assert.equal(pidRecord.version, '1.0.0');
  assert.equal(pidRecord.entryPath, v1.entryPath);
  const blocked = await readBlockedRelease(root);
  assert.equal(blocked?.version, '1.1.0');
  assert.match(blocked?.reason ?? '', /launch configuration expects/);
});
