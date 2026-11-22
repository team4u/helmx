/**
 * Node-side regressions for the node self-upgrade policy over the shared update engine in
 * `@helmx/env-io`: own version resolution (`getNodeVersion` / `resolveEffectiveNodeVersion`),
 * unified canonical `current.json` (`CurrentReleaseRecord`), package name wiring
 * (`HELMX_NPM_PACKAGE`), engine hook delegation through `performNodeUpgrade`, verbatim rollback
 * on commit failure, and error-class identity with `@helmx/env-io`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { makeTempDir as tempDir } from '@helmx/test-kit/node';
import { UpgradeRejectedError } from '@helmx/env-io';
import {
  getNodeVersion,
  resolveEffectiveNodeVersion,
  checkNodeUpgrade,
  stageReleaseFromNpm,
  performNodeUpgrade,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  type StagedNodeRelease,
  type PreparedNodeReplacement,
} from '../src/daemon/upgrader.js';

const NODE_PACKAGE_NAME = '@helmx/node';

function makeReplacement(pid: number, opts?: { commitError?: Error; abortError?: Error }) {
  const calls: string[] = [];
  const replacement: PreparedNodeReplacement = {
    pid,
    async commit() {
      calls.push(`commit:${pid}`);
      if (opts?.commitError) throw opts.commitError;
    },
    async abort() {
      calls.push(`abort:${pid}`);
      if (opts?.abortError) throw opts.abortError;
    },
  };
  return { replacement, calls };
}

/** stageExtractor: create a fake package layout inside stagingDir. */
async function fakeExtractor(stagingDir: string, _version: string): Promise<Record<string, string>> {
  const nodePkgDir = path.join(stagingDir, 'node_modules', ...NODE_PACKAGE_NAME.split('/'));
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(nodePkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(nodePkgDir, 'package.json'), JSON.stringify({ name: NODE_PACKAGE_NAME, version: _version }), 'utf8');
  return { entryPath: path.join('node_modules', ...NODE_PACKAGE_NAME.split('/'), 'dist', 'cli.js') };
}

function makeRegistryFetch(latest: string) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    return new Response(JSON.stringify({ version: latest }), { status: 200 });
  };
  return { fetchFn, urls };
}

const offlineFetch: typeof fetch = async () => {
  throw new Error('network must not be touched by this code path');
};

/** Hand-build an npm-origin `.complete` cache (no network, no npm) for revalidation through the Node layout. */
async function makeNpmReleaseCache(dir: string, version: string, nodePkg = NODE_PACKAGE_NAME) {
  const versionRoot = path.join(dir, 'releases', version);
  const candidateDir = path.join(versionRoot, '11111111-2222-3333-4444-555555555555');
  const nodePkgDir = path.join(candidateDir, 'node_modules', ...nodePkg.split('/'));
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(nodePkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(nodePkgDir, 'package.json'), JSON.stringify({ name: nodePkg, version }), 'utf8');
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({
      version,
      candidateDir,
      entries: { entryPath: path.join(nodePkgDir, 'dist', 'cli.js') },
      completedAt: new Date().toISOString(),
      origin: 'npm',
    }),
    'utf8',
  );
  return { candidateDir, nodePkgDir };
}

interface UpgradeLog {
  draining: boolean[];
  execCount: { value: number };
  shutdownPids: number[];
}

function makeHooks(log: UpgradeLog) {
  return {
    setDraining: (v: boolean) => log.draining.push(v),
    getActiveExecCount: () => log.execCount.value,
    onScheduleShutdown: (pid: number) => log.shutdownPids.push(pid),
  };
}

// ---------------------------------------------------------------------------
// 1. Node version resolution
// ---------------------------------------------------------------------------

test('getNodeVersion: reads package.json and honors HELMX_VERSION_OVERRIDE', { timeout: 60_000 }, () => {
  const self = getNodeVersion();
  assert.match(self, /^\d+\.\d+\.\d+/);
  const prev = process.env.HELMX_VERSION_OVERRIDE;
  process.env.HELMX_VERSION_OVERRIDE = '9.9.9-dev';
  try {
    assert.equal(getNodeVersion(), '9.9.9-dev');
  } finally {
    if (prev === undefined) delete process.env.HELMX_VERSION_OVERRIDE;
    else process.env.HELMX_VERSION_OVERRIDE = prev;
  }
});

test('resolveEffectiveNodeVersion: prefers current.json and falls back to own package version', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  assert.equal(await resolveEffectiveNodeVersion(dir), getNodeVersion());
  await writeCurrentRelease(dir, {
    version: '3.2.1',
    updatedAt: new Date().toISOString(),
    entries: { entryPath: '/x/dist/cli.js' },
  });
  assert.equal(await resolveEffectiveNodeVersion(dir), '3.2.1');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. Unified canonical current.json contract (shared with @helmx/env-io)
// ---------------------------------------------------------------------------

test('canonical current.json: ENOENT returns null, atomic 0600 writes round-trip, idempotent delete', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  assert.equal(await readCurrentRelease(dir), null);

  await writeCurrentRelease(dir, {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: '/a/dist/cli.js' },
  });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.entries['entryPath'], '/a/dist/cli.js');
  if (process.platform !== 'win32') assert.equal(rawFs.statSync(path.join(dir, 'current.json')).mode & 0o777, 0o600);

  await deleteCurrentRelease(dir);
  assert.equal(await readCurrentRelease(dir), null);
  await deleteCurrentRelease(dir); // idempotent
  await fs.rm(dir, { recursive: true, force: true });
});

test('canonical current.json: corrupt or incomplete records throw explicitly rather than returning null', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /corrupt/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /updatedAt/);
  await assert.rejects(
    () => writeCurrentRelease(dir, { version: '', updatedAt: 't', entries: { entryPath: 'x' } }),
    /version/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Node wiring over the shared update engine
// ---------------------------------------------------------------------------

test('checkNodeUpgrade: queries the @helmx/node package latest and falls back to getNodeVersion', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.match(urls[0]!, /@helmx%2Fnode\/latest|@helmx\/node\/latest/);

  const dir2 = await tempDir('helmx-node-upgrade-');
  const result2 = await checkNodeUpgrade(dir2, { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(result2.currentVersion, getNodeVersion());
  assert.equal(result2.updateAvailable, false);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dir2, { recursive: true, force: true });
});

test('single package name: HELMX_NPM_PACKAGE drives registry URL and staged layout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  const prevNodePkg = process.env.HELMX_NPM_PACKAGE;
  process.env.HELMX_NPM_PACKAGE = '@custom/node';
  try {
    const { fetchFn, urls } = makeRegistryFetch('2.0.0');
    const check = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
    assert.equal(check.latestVersion, '2.0.0');
    assert.match(urls[0]!, /@custom%2Fnode\/latest|@custom\/node\/latest/);

    await makeNpmReleaseCache(dir, '2.0.0', '@custom/node');
    const staged = await stageReleaseFromNpm(dir, '2.0.0', { fetchFn: offlineFetch });
    assert.ok(staged.entries['entryPath']!.endsWith(path.join('node_modules', '@custom', 'node', 'dist', 'cli.js')), staged.entries['entryPath']);
  } finally {
    if (prevNodePkg === undefined) delete process.env.HELMX_NPM_PACKAGE;
    else process.env.HELMX_NPM_PACKAGE = prevNodePkg;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: success path delegates engine hooks and writes canonical current.json', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(4242);
  const contexts: Array<{ attemptId: string; previousVersion: string; targetVersion: string }> = [];
  const releases: StagedNodeRelease[] = [];

  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.2.3',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async (release, context) => {
      releases.push(release);
      contexts.push(context);
      return replacement;
    },
    ...makeHooks(log),
  });

  assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.2.3', upgraded: true, pid: 4242 });
  assert.deepEqual(calls, ['commit:4242']);
  assert.equal(releases[0]?.version, '1.2.3');
  const stagedEntry = releases[0]?.entries['entryPath'];
  assert.ok(stagedEntry !== undefined && (await fs.access(stagedEntry).then(() => true, () => false)), 'staged entryPath must exist on disk');
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]);
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entries['entryPath'], stagedEntry);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: commit failure restores the previous canonical current.json record verbatim', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  const originalCurrent = {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: '/old/dist/cli.js' },
  };
  await writeCurrentRelease(dir, originalCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(321, { commitError: new Error('activate handshake timeout') });

  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    /rolled back[\s\S]*activate handshake timeout/,
  );
  assert.deepEqual(calls, ['commit:321', 'abort:321'], 'commit failure must abort replacement');
  assert.deepEqual(await readCurrentRelease(dir), originalCurrent, 'current.json must be restored verbatim');
  assert.equal((await readBlockedRelease(dir))?.version, '1.4.0');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  await fs.rm(dir, { recursive: true, force: true });
});

test('adapter rejects with the shared update-engine error classes (instanceof identity)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-node-upgrade-');
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '0.9.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    UpgradeRejectedError,
  );
  await assert.rejects(() => stageReleaseFromNpm(dir, 'not-semver', { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});
