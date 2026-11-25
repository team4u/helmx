/**
 * Tests for the shared self-update engine (env-io `update/` subtree, re-exported from
 * the `@helmx/env-io` root — the import below exercises exactly that public surface):
 * semver wrappers, atomic state records, registry allowlist + latest check,
 * immutable staging (extractor + npm paths, .complete cache revalidation, layout
 * descriptor validation), the update transaction (drain gate, commit ordering,
 * rollback + cooldown, unconfirmed-commit never-rollback, cross-process lock),
 * and the npm runner's process-group kill on timeout.
 *
 * Uses injected stageExtractor / layout fixtures and mocked fetch; the only real
 * subprocess is the runNpm group-kill regression (POSIX only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { sleep as delay } from '@helmx/test-kit';
import { makeTempDir as tempDir } from '@helmx/test-kit/node';
import {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
  compareSemver,
  normalizeTargetVersion,
  filterRpcRegistryUrl,
  checkForUpdate,
  performUpdate,
  stageRelease,
  runNpm,
  resolveNpmCommand,
  runControlledProcess,
  fetchLatestVersion,
  downloadVerifiedTarball,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  withUpdateLock,
  isBlockedVersionActive,
  resolveBlockedCooldownMs,
  assertDistTag,
  assertListenUrlMatches,
  commitAndSwitchHubRelease,
  type CurrentReleaseRecord,
  type ReleaseLayout,
  type StagedRelease,
  type PreparedReplacement,
  type UpdateSpec,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures: a Node-shaped dual-package layout (demonstrates the generic descriptor)
// ---------------------------------------------------------------------------

const NODE_PACKAGE = '@helmx/node';
const CLI_PACKAGE = '@helmx/cli';

/** Node's dual-package layout: daemon entry + CLI bin dir, expressed through the generic descriptor. */
const NODE_LAYOUT: ReleaseLayout = {
  packages: [
    { name: NODE_PACKAGE, requiredFiles: ['dist/cli.js'] },
    { name: CLI_PACKAGE, requiredFiles: ['dist/index.js'], requiredBins: ['helmx'] },
  ],
  resolveEntries: () => ({
    entryPath: path.join('node_modules', '@helmx', 'node', 'dist', 'cli.js'),
    cliBinDir: 'node_modules/.bin',
  }),
};

const NODE_SPEC: UpdateSpec = { packageName: NODE_PACKAGE, layout: NODE_LAYOUT };

/** stageExtractor fixture: create a fake dual-package layout inside stagingDir. */
async function fakeExtractor(stagingDir: string, _version: string): Promise<Record<string, string>> {
  await fs.mkdir(path.join(stagingDir, 'node_modules', '@helmx', 'node', 'dist'), { recursive: true });
  await fs.mkdir(path.join(stagingDir, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(stagingDir, 'node_modules', '@helmx', 'node', 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(
    path.join(stagingDir, 'node_modules', '@helmx', 'node', 'package.json'),
    JSON.stringify({ name: NODE_PACKAGE, version: _version }),
    'utf8',
  );
  return { entryPath: path.join('node_modules', '@helmx', 'node', 'dist', 'cli.js'), cliBinDir: 'node_modules/.bin' };
}

function makeReplacement(pid: number, opts?: { commitError?: Error; abortError?: Error }) {
  const calls: string[] = [];
  const replacement: PreparedReplacement = {
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

interface NpmCacheFixtureOptions {
  cliVersion?: string;
  omitCliEntry?: boolean;
  /** `null` omits the bin declaration entirely; a value overrides it. */
  cliBin?: Record<string, string> | string | null;
  markerEntries?: Record<string, string>;
}

/** Build an npm-origin `.complete` cache by hand (no network, no npm) for revalidation tests. */
async function makeNpmReleaseCache(dir: string, version: string, opts?: NpmCacheFixtureOptions) {
  const versionRoot = path.join(dir, 'releases', version);
  const candidateDir = path.join(versionRoot, '11111111-2222-3333-4444-555555555555');
  const nodePkgDir = path.join(candidateDir, 'node_modules', '@helmx', 'node');
  const cliPkgDir = path.join(candidateDir, 'node_modules', '@helmx', 'cli');
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(cliPkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(candidateDir, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(nodePkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(nodePkgDir, 'package.json'), JSON.stringify({ name: NODE_PACKAGE, version }), 'utf8');
  if (!opts?.omitCliEntry) {
    await fs.writeFile(path.join(cliPkgDir, 'dist', 'index.js'), '#!/usr/bin/env node\n', 'utf8');
  }
  await fs.writeFile(
    path.join(cliPkgDir, 'package.json'),
    JSON.stringify({
      name: CLI_PACKAGE,
      version: opts?.cliVersion ?? version,
      ...(opts?.cliBin === null ? {} : { bin: opts?.cliBin ?? { helmx: './dist/index.js' } }),
    }),
    'utf8',
  );
  const entries = opts?.markerEntries ?? {
    entryPath: path.join(nodePkgDir, 'dist', 'cli.js'),
    cliBinDir: path.join(candidateDir, 'node_modules', '.bin'),
  };
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({ version, candidateDir, entries, completedAt: new Date().toISOString(), origin: 'npm' }),
    'utf8',
  );
  return { versionRoot, candidateDir, nodePkgDir, cliPkgDir };
}

// ---------------------------------------------------------------------------
// 1. Version parsing
// ---------------------------------------------------------------------------

test('compareSemver: core numbers, pre-release precedence, and invalid inputs', { timeout: 60_000 }, () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1); // stable > pre-release
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1); // fewer pre-release fields < more
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1); // numeric < alphanumeric
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1); // numeric comparison
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  // build metadata is valid but ignored in precedence (SemVer §10)
  assert.equal(compareSemver('1.0.0+build.123', '1.0.0+build.456'), 0);
  assert.equal(compareSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-beta.1+exp.sha.5114f85', '1.0.0-beta.1'), 0);
  assert.equal(compareSemver('1.0.1+a', '1.0.0+b'), 1); // core version takes precedence over build metadata
  assert.equal(compareSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1); // pre-release takes precedence over build metadata
  for (const bad of ['v1.0.0', '1.0', '1.0.0.0', '01.0.0', 'not-a-version', '', '1.0.0-', '1.0.0+', '1.0.0+a_b', '1.0.0+a..b']) {
    assert.throws(() => compareSemver(bad, '1.0.0'), UpgradeRejectedError, `should reject ${bad}`);
  }
  assert.throws(() => compareSemver('1.0.0', 'not-a-version'), UpgradeRejectedError);
});

test('normalizeTargetVersion: trims whitespace, strips single v prefix, and validates strictly', { timeout: 60_000 }, () => {
  assert.equal(normalizeTargetVersion(' 1.2.3 '), '1.2.3');
  assert.equal(normalizeTargetVersion('v2.0.1'), '2.0.1');
  assert.equal(normalizeTargetVersion('V3.0.0'), '3.0.0');
  assert.equal(normalizeTargetVersion(' v1.2.3-rc.1 '), '1.2.3-rc.1');
  assert.equal(normalizeTargetVersion('1.2.3-beta.1+meta'), '1.2.3-beta.1+meta');
  assert.equal(normalizeTargetVersion('v1.2.3+build.7'), '1.2.3+build.7');
  assert.equal(normalizeTargetVersion(' v1.2.3+build.7 '), '1.2.3+build.7');
  assert.throws(() => normalizeTargetVersion('vv1.0.0'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion(''), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('~1.2.3'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2.3+bad_build'), UpgradeRejectedError);
});

// ---------------------------------------------------------------------------
// 2. State records: current.json / update-blocked.json
// ---------------------------------------------------------------------------

test('record read/write: ENOENT returns null, atomic 0600 writes, idempotent delete/clear', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);

  await writeCurrentRelease(dir, {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: '/a/dist/cli.js', cliBinDir: '/a/node_modules/.bin' },
  });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.entries['entryPath'], '/a/dist/cli.js');
  assert.equal(current?.entries['cliBinDir'], '/a/node_modules/.bin');
  if (process.platform !== 'win32') {
    assert.equal(rawFs.statSync(path.join(dir, 'current.json')).mode & 0o777, 0o600);
  }

  await writeBlockedRelease(dir, { version: '2.0.0', reason: 'canary failed', at: '2026-01-02T00:00:00.000Z' });
  assert.equal((await readBlockedRelease(dir))?.reason, 'canary failed');
  if (process.platform !== 'win32') {
    assert.equal(rawFs.statSync(path.join(dir, 'update-blocked.json')).mode & 0o777, 0o600);
  }

  await deleteCurrentRelease(dir);
  await clearBlockedRelease(dir);
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);
  await deleteCurrentRelease(dir); // idempotent
  await fs.rm(dir, { recursive: true, force: true });
});

test('record corruption: non-JSON, missing fields, and bad entries throw explicitly rather than returning null', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /corrupt/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /updatedAt/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0', updatedAt: 't', entries: {} }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /at least one entry/);
  await fs.writeFile(
    path.join(dir, 'current.json'),
    JSON.stringify({ version: '1.0.0', updatedAt: 't', entries: { entryPath: 42 } }),
    'utf8',
  );
  await assert.rejects(() => readCurrentRelease(dir), /entries\.entryPath/);
  await fs.writeFile(path.join(dir, 'update-blocked.json'), '[]', 'utf8');
  await assert.rejects(() => readBlockedRelease(dir), /corrupt/);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. filterRpcRegistryUrl allowlist
// ---------------------------------------------------------------------------

test('filterRpcRegistryUrl: allows only official npm and HELMX_NPM_REGISTRY, rejecting other origins', { timeout: 60_000 }, () => {
  assert.equal(filterRpcRegistryUrl(undefined), undefined);
  assert.equal(filterRpcRegistryUrl(''), undefined);
  assert.equal(filterRpcRegistryUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org');
  assert.throws(() => filterRpcRegistryUrl('https://evil.example.com'), UpgradeRejectedError);
  const prev = process.env.HELMX_NPM_REGISTRY;
  process.env.HELMX_NPM_REGISTRY = 'https://mirror.internal.example/npm/';
  try {
    assert.equal(filterRpcRegistryUrl('https://mirror.internal.example/npm'), 'https://mirror.internal.example/npm');
    assert.throws(() => filterRpcRegistryUrl('https://registry.npmjs.org.evil.io'), UpgradeRejectedError);
  } finally {
    if (prev === undefined) delete process.env.HELMX_NPM_REGISTRY;
    else process.env.HELMX_NPM_REGISTRY = prev;
  }
});

// ---------------------------------------------------------------------------
// 4. checkForUpdate
// ---------------------------------------------------------------------------

test('checkForUpdate: queries the spec package latest, compares semver, and passes through blocked record', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'boom', at: new Date().toISOString() });
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkForUpdate(dir, NODE_SPEC, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked?.version, '1.5.0');
  assert.match(urls[0]!, /@helmx%2Fnode\/latest|@helmx\/node\/latest/);

  // current.json takes precedence when currentVersion is omitted
  await writeCurrentRelease(dir, { version: '1.1.0', updatedAt: new Date().toISOString(), entries: { entryPath: '/a' } });
  const fromState = await checkForUpdate(dir, NODE_SPEC, { fetchFn: makeRegistryFetch('1.2.0').fetchFn });
  assert.equal(fromState.currentVersion, '1.1.0');

  // getFallbackVersion is consulted only when state and explicit input are both absent
  const dir2 = await tempDir('helmx-update-');
  const withFallback = await checkForUpdate(dir2, { ...NODE_SPEC, getFallbackVersion: () => '0.0.1' }, { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(withFallback.currentVersion, '0.0.1');
  assert.equal(withFallback.updateAvailable, false);

  // Nothing resolvable -> explicit rejection instead of a fabricated version
  await assert.rejects(() => checkForUpdate(dir2, NODE_SPEC, { fetchFn: makeRegistryFetch('1.0.0').fetchFn }), /no current version resolvable/);

  // Invalid version returned by the registry must fail explicitly
  const bad = makeRegistryFetch('not-semver');
  await assert.rejects(() => checkForUpdate(dir, NODE_SPEC, { currentVersion: '1.0.0', fetchFn: bad.fetchFn }), /invalid SemVer/);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dir2, { recursive: true, force: true });
});

test('checkForUpdate: HTTP errors and timeouts throw explicitly', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const fail: typeof fetch = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(() => checkForUpdate(dir, NODE_SPEC, { currentVersion: '1.0.0', fetchFn: fail }), /404/);
  const timeout_: typeof fetch = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => checkForUpdate(dir, NODE_SPEC, { currentVersion: '1.0.0', registryUrl: 'http://127.0.0.1:1', fetchFn: timeout_ }),
    /failed to query latest version.*request timed out/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4b. dist-tag channels and verified tarball download
// ---------------------------------------------------------------------------

/** Mock registry serving one package: dist-tag documents, exact manifests, and tarballs derived from a single body. */
function makeVerifiedRegistryFetch(opts: { version: string; body?: string; tamperTarball?: boolean }) {
  const body = opts.body ?? 'tarball-content';
  const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    if (url.includes('/-/')) {
      return new Response(opts.tamperTarball ? `${body}-tampered` : body, { status: 200 });
    }
    const segments = url.replace(/^https?:\/\/[^/]+\//, '').split('/');
    const pkgName = segments.slice(0, -1).join('/').replace('%2F', '/');
    const last = segments[segments.length - 1]!;
    if (/^\d+\.\d+\.\d+/.test(last)) {
      // Exact-version manifest document
      return new Response(JSON.stringify({ name: pkgName, version: last, dist: { integrity, tarball: `https://r/${pkgName}/-/${pkgName}-${last}.tgz` } }), { status: 200 });
    }
    // Dist-tag document
    return new Response(JSON.stringify({ version: opts.version }), { status: 200 });
  };
  return { fetchFn, urls };
}

test('fetchLatestVersion: default tag queries /latest; tag parameter queries the requested dist-tag and rejects illegal tags', { timeout: 60_000 }, async () => {
  const registry = 'https://registry.example.com';
  const latest = makeVerifiedRegistryFetch({ version: '1.0.0' });
  assert.equal(await fetchLatestVersion(registry, NODE_PACKAGE, latest.fetchFn), '1.0.0');
  assert.match(latest.urls[0]!, /@helmx\/node\/latest$/);

  const beta = makeVerifiedRegistryFetch({ version: '2.0.0-beta.1' });
  assert.equal(await fetchLatestVersion(registry, NODE_PACKAGE, beta.fetchFn, 'beta'), '2.0.0-beta.1');
  assert.match(beta.urls[0]!, /@helmx\/node\/beta$/);

  for (const bad of ['', '..', '../x', 'foo/bar', 'a b', '^1.0.0', '.hidden', '_internal', '1.2.3']) {
    await assert.rejects(() => fetchLatestVersion(registry, NODE_PACKAGE, latest.fetchFn, bad), UpgradeRejectedError);
  }
  // Version-shaped tags are rejected with an explicit pointer to the exact-version channel
  await assert.rejects(() => fetchLatestVersion(registry, NODE_PACKAGE, latest.fetchFn, '1.2.3'), /not a dist-tag/);
});

test('checkForUpdate/performUpdate: tag option threads through to the dist-tag URL', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const beta = makeVerifiedRegistryFetch({ version: '2.0.0-beta.1' });
  const check = await checkForUpdate(dir, { ...NODE_SPEC, getFallbackVersion: () => '1.0.0' }, { fetchFn: beta.fetchFn, tag: 'beta' });
  assert.equal(check.latestVersion, '2.0.0-beta.1');
  assert.equal(check.updateAvailable, true);
  assert.match(beta.urls[0]!, /@helmx\/node\/beta$/);

  // performUpdate resolves its default target from the same dist-tag channel
  const { replacement } = makeReplacement(81);
  const result = await performUpdate(dir, NODE_SPEC, {
    currentVersion: '1.0.0',
    fetchFn: beta.fetchFn,
    tag: 'beta',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => replacement,
  });
  assert.equal(result.targetVersion, '2.0.0-beta.1');
  assert.equal((await readCurrentRelease(dir))?.version, '2.0.0-beta.1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('downloadVerifiedTarball: fetches manifest, downloads, and verifies SHA-512 integrity', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const dest = path.join(dir, 'pkg-1.0.0.tgz');
  const good = makeVerifiedRegistryFetch({ version: '1.0.0' });
  await downloadVerifiedTarball('https://registry.example.com', NODE_PACKAGE, '1.0.0', dest, good.fetchFn);
  assert.equal(await fs.readFile(dest, 'utf8'), 'tarball-content');

  // Tampered tarball content fails the integrity comparison with the original diagnostics
  const tampered = makeVerifiedRegistryFetch({ version: '1.0.0', tamperTarball: true });
  await assert.rejects(
    () => downloadVerifiedTarball('https://registry.example.com', NODE_PACKAGE, '1.0.0', dest, tampered.fetchFn),
    /integrity check failed/,
  );

  // Download-level HTTP failures surface the tarball URL
  const httpFail = makeVerifiedRegistryFetch({ version: '1.0.0' });
  const failing: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/-/')) return new Response('gone', { status: 404, statusText: 'Not Found' });
    return httpFail.fetchFn(input);
  };
  await assert.rejects(
    () => downloadVerifiedTarball('https://registry.example.com', NODE_PACKAGE, '1.0.0', dest, failing),
    /failed to download .* tarball .*404/,
  );

  // Manifest validation failures propagate unchanged
  const wrongName: typeof fetch = async () =>
    new Response(JSON.stringify({ name: '@evil/node', version: '1.0.0', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } }), { status: 200 });
  await assert.rejects(
    () => downloadVerifiedTarball('https://registry.example.com', NODE_PACKAGE, '1.0.0', dest, wrongName),
    /package name mismatch/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. stageRelease: extractor channel, layout validation, .complete cache
// ---------------------------------------------------------------------------

test('stageRelease: stageExtractor builds immutable candidate dir and writes .complete; subsequent call reuses cache', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const staged = await stageRelease(dir, '1.2.3', undefined, { stageExtractor: fakeExtractor });
  assert.equal(staged.version, '1.2.3');
  assert.ok(staged.releaseDir.startsWith(path.join(dir, 'releases', '1.2.3') + path.sep));
  assert.ok(await fs.access(staged.entries['entryPath']!).then(() => true, () => false));
  assert.ok(staged.entries['cliBinDir']!.endsWith('node_modules/.bin'));
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '1.2.3', '.complete'), 'utf8'));
  assert.equal(marker.entries.entryPath, staged.entries['entryPath']);
  assert.equal(marker.origin, 'extractor');

  const staged2 = await stageRelease(dir, '1.2.3', undefined, { stageExtractor: fakeExtractor });
  assert.equal(staged2.releaseDir, staged.releaseDir); // reuses cached candidate without creating a new one
  await assert.rejects(() => stageRelease(dir, 'bad-version', undefined, { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: rejects escaping or absolute stageExtractor paths without leaving staging dirs behind', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await assert.rejects(
    () =>
      stageRelease(dir, '1.0.0', undefined, {
        stageExtractor: async () => ({ entryPath: path.join('..', '..', 'escape.js'), cliBinDir: 'node_modules/.bin' }),
      }),
    /escapes/,
  );
  await assert.rejects(
    () =>
      stageRelease(dir, '1.0.0', undefined, {
        stageExtractor: async () => ({ entryPath: '/etc/passwd', cliBinDir: 'node_modules/.bin' }),
      }),
    /expected relative/,
  );
  const entries = await fs.readdir(path.join(dir, 'releases', '1.0.0'));
  assert.ok(entries.every((e) => e === '.complete' || !e.startsWith('.staging')), 'must not leave .staging directories behind on failure');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: layout resolveEntries is held to the same relative-inside-root contract', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  // A valid npm-origin cache plus a layout whose resolveEntries escapes the release dir:
  // revalidation resolves entries through the layout and must reject the escape.
  await makeNpmReleaseCache(dir, '4.3.0');
  const escapingLayout: ReleaseLayout = {
    packages: NODE_LAYOUT.packages,
    resolveEntries: () => ({ entryPath: path.join('..', 'outside.js'), cliBinDir: 'node_modules/.bin' }),
  };
  await assert.rejects(
    () => stageRelease(dir, '4.3.0', escapingLayout, { fetchFn: offlineFetch }),
    /escapes staging directory/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: rejects calls with neither a layout nor a stageExtractor', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await assert.rejects(() => stageRelease(dir, '1.0.0', undefined, {}), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease (npm path): rejects metadata name mismatch, tampered integrity, missing integrity, and version mismatch', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');

  // a) Metadata package name mismatch
  const wrongMeta: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const meta = { name: '@evil/node', version: '1.0.0', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } };
    return new Response(JSON.stringify(meta), { status: 200 });
  };
  await assert.rejects(() => stageRelease(dir, '1.0.0', NODE_LAYOUT, { fetchFn: wrongMeta }), /package name mismatch/);

  // b) Tarball sha512 mismatch (tampered content)
  const { createHash } = await import('node:crypto');
  const body = Buffer.from('malicious payload');
  const goodIntegrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const tampered: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/-/')) return new Response('tampered-content', { status: 200 });
    const meta = {
      name: url.includes('%2Fcli') ? CLI_PACKAGE : NODE_PACKAGE,
      version: '1.0.0',
      dist: { integrity: goodIntegrity, tarball: `${url.split('/').slice(0, -2).join('/')}/pkg/-/pkg-1.0.0.tgz` },
    };
    return new Response(JSON.stringify(meta), { status: 200 });
  };
  await assert.rejects(() => stageRelease(dir, '1.0.0', NODE_LAYOUT, { fetchFn: tampered }), /integrity check failed/);

  // c) Missing dist.integrity
  const noIntegrity: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const name = url.includes('%2Fcli') ? CLI_PACKAGE : NODE_PACKAGE;
    return new Response(JSON.stringify({ name, version: '1.0.0', dist: { tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageRelease(dir, '1.0.0', NODE_LAYOUT, { fetchFn: noIntegrity }), /integrity/);

  // d) Metadata version mismatch
  const versionMismatch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const name = url.includes('%2Fcli') ? CLI_PACKAGE : NODE_PACKAGE;
    return new Response(JSON.stringify({ name, version: '1.0.1', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageRelease(dir, '1.0.0', NODE_LAYOUT, { fetchFn: versionMismatch }), /version mismatch/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: force bypasses cache and creates a new candidate while preserving the previous one', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const first = await stageRelease(dir, '2.0.0', undefined, { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const countingExtractor: typeof fakeExtractor = async (stagingDir, version) => {
    extractorRuns += 1;
    return fakeExtractor(stagingDir, version);
  };
  // Without force: reuses cache without reinstalling
  const cached = await stageRelease(dir, '2.0.0', undefined, { stageExtractor: countingExtractor });
  assert.equal(cached.releaseDir, first.releaseDir);
  assert.equal(extractorRuns, 0);
  // With force: installs into a new candidate dir without deleting the old one
  const forced = await stageRelease(dir, '2.0.0', undefined, { stageExtractor: countingExtractor, force: true });
  assert.equal(extractorRuns, 1);
  assert.notEqual(forced.releaseDir, first.releaseDir);
  assert.ok(forced.releaseDir.startsWith(path.join(dir, 'releases', '2.0.0') + path.sep));
  assert.ok(await fs.access(first.entries['entryPath']!).then(() => true, () => false), 'previous candidate must remain intact');
  // .complete now points to the new candidate; subsequent non-forced call reuses it
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '2.0.0', '.complete'), 'utf8'));
  assert.equal(marker.candidateDir, forced.releaseDir);
  const again = await stageRelease(dir, '2.0.0', undefined, { stageExtractor: countingExtractor });
  assert.equal(again.releaseDir, forced.releaseDir);
  assert.equal(extractorRuns, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: rejects .complete paths escaping version or candidate dir without deleting old candidate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const staged = await stageRelease(dir, '3.0.0', undefined, { stageExtractor: fakeExtractor });
  const completePath = path.join(dir, 'releases', '3.0.0', '.complete');
  const outside = JSON.parse(await fs.readFile(completePath, 'utf8'));
  // a) entry points outside the version directory
  await fs.writeFile(completePath, JSON.stringify({ ...outside, entries: { ...outside.entries, entryPath: '/etc/passwd' } }), 'utf8');
  await assert.rejects(() => stageRelease(dir, '3.0.0', undefined, { stageExtractor: fakeExtractor }), /entryPath lies outside immutable release dir/);
  // b) candidateDir points outside the version directory
  await fs.writeFile(completePath, JSON.stringify({ ...outside, candidateDir: path.join(dir, 'elsewhere') }), 'utf8');
  await assert.rejects(() => stageRelease(dir, '3.0.0', undefined, { stageExtractor: fakeExtractor }), /candidateDir lies outside immutable release dir/);
  // c) entry is inside the version directory but outside candidateDir
  await fs.writeFile(
    completePath,
    JSON.stringify({ ...outside, entries: { ...outside.entries, entryPath: path.join(dir, 'releases', '3.0.0', 'other', 'cli.js') } }),
    'utf8',
  );
  await assert.rejects(() => stageRelease(dir, '3.0.0', undefined, { stageExtractor: fakeExtractor }), /entryPath lies outside immutable release dir/);
  // d) Missing entry file (stale cache) -> reject explicitly without rebuilding or deleting candidate
  await fs.writeFile(completePath, JSON.stringify(outside), 'utf8');
  await fs.rm(staged.entries['entryPath']!);
  await assert.rejects(() => stageRelease(dir, '3.0.0', undefined, { stageExtractor: fakeExtractor }), /missing entry file/);
  assert.ok(await fs.access(path.dirname(staged.entries['entryPath']!)).then(() => true, () => false));
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: npm-origin cache reuse revalidates installed packages without touching the network', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const fixture = await makeNpmReleaseCache(dir, '4.0.0');
  const staged = await stageRelease(dir, '4.0.0', NODE_LAYOUT, { fetchFn: offlineFetch });
  assert.equal(staged.releaseDir, fixture.candidateDir);
  assert.equal(staged.entries['entryPath'], path.join(fixture.nodePkgDir, 'dist', 'cli.js'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: npm cache revalidation checks installed package.json versions of every layout package', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  // @helmx/cli package.json carries a mismatched version -> reuse rejected
  await makeNpmReleaseCache(dir, '4.0.0', { cliVersion: '3.9.9' });
  await assert.rejects(
    () => stageRelease(dir, '4.0.0', NODE_LAYOUT, { stageExtractor: fakeExtractor }),
    /installed package name\/version mismatch.*@helmx\/cli/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease: npm cache revalidation enforces requiredFiles and requiredBins from the layout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  // a) required file missing (@helmx/cli dist/index.js)
  await makeNpmReleaseCache(dir, '4.1.0', { omitCliEntry: true });
  await assert.rejects(() => stageRelease(dir, '4.1.0', NODE_LAYOUT, { fetchFn: offlineFetch }), /required file dist\/index\.js/);
  await fs.rm(dir, { recursive: true, force: true });

  // b) bin declaration missing entirely
  const dir2 = await tempDir('helmx-update-');
  await makeNpmReleaseCache(dir2, '4.1.0', { cliBin: null });
  await assert.rejects(() => stageRelease(dir2, '4.1.0', NODE_LAYOUT, { fetchFn: offlineFetch }), /missing bin declaration for "helmx"/);
  await fs.rm(dir2, { recursive: true, force: true });

  // c) bin declared but target file missing
  const dir3 = await tempDir('helmx-update-');
  await makeNpmReleaseCache(dir3, '4.1.0', { cliBin: { helmx: './dist/missing.js' } });
  await assert.rejects(() => stageRelease(dir3, '4.1.0', NODE_LAYOUT, { fetchFn: offlineFetch }), /bin target file missing/);
  await fs.rm(dir3, { recursive: true, force: true });
});

test('stageRelease: npm cache reuse rejects marker entries that disagree with layout resolution', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const candidateDir = path.join(dir, 'releases', '4.2.0', '11111111-2222-3333-4444-555555555555');
  // Record an entry pointing at a different (existing) file inside the candidate dir:
  // disk checks pass, but the fresh layout resolution disagrees with the marker.
  const decoyEntry = path.join(candidateDir, 'node_modules', '@helmx', 'other', 'dist', 'cli.js');
  await makeNpmReleaseCache(dir, '4.2.0', {
    markerEntries: { entryPath: decoyEntry, cliBinDir: path.join(candidateDir, 'node_modules', '.bin') },
  });
  await fs.mkdir(path.dirname(decoyEntry), { recursive: true });
  await fs.writeFile(decoyEntry, '#!/usr/bin/env node\n', 'utf8');
  await assert.rejects(() => stageRelease(dir, '4.2.0', NODE_LAYOUT, { fetchFn: offlineFetch }), /disagrees with layout resolution/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageRelease (npm path): downloads verified tarballs, runs npm install, resolves relative entries, and reuses .complete cache', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const pkgSrcRoot = await tempDir('helmx-pkg-src-');
  try {
    const targetVersion = '3.4.5';
    const tarballs = new Map<string, { bytes: Buffer; integrity: string }>();

    const packTarball = async (pkgName: string, files: Record<string, string>) => {
      const safeDir = path.join(pkgSrcRoot, pkgName.replace('/', '+'));
      const pkgDir = path.join(safeDir, 'package');
      for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(pkgDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }
      const tgzPath = path.join(safeDir, 'pkg.tgz');
      await tar.create({ gzip: true, file: tgzPath, cwd: safeDir }, ['package']);
      const bytes = await fs.readFile(tgzPath);
      const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      tarballs.set(pkgName, { bytes, integrity });
    };

    await packTarball(NODE_PACKAGE, {
      'package.json': JSON.stringify({ name: NODE_PACKAGE, version: targetVersion }, null, 2),
      'dist/cli.js': '#!/usr/bin/env node\nconsole.log("node");\n',
    });
    await packTarball(CLI_PACKAGE, {
      'package.json': JSON.stringify({ name: CLI_PACKAGE, version: targetVersion, bin: { helmx: './dist/index.js' } }, null, 2),
      'dist/index.js': '#!/usr/bin/env node\nconsole.log("cli");\n',
    });

    const registryUrl = 'https://registry.example.test';
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      for (const pkgName of [NODE_PACKAGE, CLI_PACKAGE]) {
        if (url === `${registryUrl}/${pkgName}/${targetVersion}`) {
          const entry = tarballs.get(pkgName)!;
          return new Response(
            JSON.stringify({
              name: pkgName,
              version: targetVersion,
              dist: {
                integrity: entry.integrity,
                tarball: `${registryUrl}/${pkgName}/-/${pkgName.split('/').pop()}-${targetVersion}.tgz`,
              },
            }),
            { status: 200 },
          );
        }
        if (url === `${registryUrl}/${pkgName}/-/${pkgName.split('/').pop()}-${targetVersion}.tgz`) {
          return new Response(new Uint8Array(tarballs.get(pkgName)!.bytes), { status: 200 });
        }
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    };

    const staged = await stageRelease(dir, targetVersion, NODE_LAYOUT, {
      registryUrl,
      fetchFn,
      npmInstallArgs: ['--offline'],
    });

    assert.equal(staged.version, targetVersion);
    assert.ok(staged.releaseDir.startsWith(path.join(dir, 'releases', targetVersion) + path.sep));
    const expectedEntry = path.join(staged.releaseDir, 'node_modules', '@helmx', 'node', 'dist', 'cli.js');
    const expectedBinDir = path.join(staged.releaseDir, 'node_modules', '.bin');
    assert.equal(staged.entries['entryPath'], expectedEntry);
    assert.equal(staged.entries['cliBinDir'], expectedBinDir);
    assert.ok(await fs.access(expectedEntry).then(() => true, () => false), 'staged entryPath must exist on disk');

    const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', targetVersion, '.complete'), 'utf8'));
    assert.equal(marker.origin, 'npm');
    assert.equal(marker.entries.entryPath, expectedEntry);

    // Subsequent call reuses the verified .complete cache without touching network or npm.
    const cached = await stageRelease(dir, targetVersion, NODE_LAYOUT, { fetchFn: offlineFetch });
    assert.equal(cached.releaseDir, staged.releaseDir);
    assert.deepEqual(cached.entries, staged.entries);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(pkgSrcRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. performUpdate: transaction semantics
// ---------------------------------------------------------------------------

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

test('performUpdate: rejects explicitly when prepareReplacement is omitted (never fabricates a PID)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await assert.rejects(() => performUpdate(dir, NODE_SPEC, {}), /prepareReplacement/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: success path runs prepare -> commit -> onScheduleShutdown(pid), updates current, clears blocked', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeBlockedRelease(dir, { version: '2.0.0', reason: 'old failed', at: new Date().toISOString() });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(4242);
  const contexts: Array<{ attemptId: string; previousVersion: string; targetVersion: string }> = [];
  const releases: StagedRelease[] = [];

  const result = await performUpdate(dir, NODE_SPEC, {
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
  assert.deepEqual(calls, ['commit:4242']); // commit exactly once; never abort on success path
  assert.equal(releases[0]?.version, '1.2.3');
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]); // keep draining after success (previous process is exiting)
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entries['entryPath'], releases[0]?.entries['entryPath']);
  assert.equal(current?.entries['cliBinDir'], releases[0]?.entries['cliBinDir']);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: normalizes targetVersion (v prefix/whitespace) for directory names and results', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const { replacement } = makeReplacement(100);
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: ' v2.0.1 ',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => replacement,
  });
  assert.equal(result.targetVersion, '2.0.1');
  assert.ok(result.upgraded);
  assert.equal((await readCurrentRelease(dir))?.version, '2.0.1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: no-op on same version unless force is set (no staging or draining)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  let staged = 0;
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.0.0',
    currentVersion: '1.0.0',
    stageExtractor: async (s, v) => {
      staged += 1;
      return fakeExtractor(s, v);
    },
    prepareReplacement: async () => makeReplacement(1).replacement,
    ...makeHooks(log),
  });
  assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.0.0', upgraded: false });
  assert.equal(staged, 0);
  assert.equal(log.draining.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: rejects downgrades unless force=true', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '0.9.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    UpgradeRejectedError,
  );
  // force=true permits downgrade
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '0.9.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(7).replacement,
  });
  assert.equal(result.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: rejects failed version during cooldown unless force=true or cooldown expired', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'canary crashed', at: new Date().toISOString() });
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /cooldown/,
  );
  // Retry permitted with force=true
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(8).replacement,
  });
  assert.equal(result.upgraded, true);

  // Once cooldown expires (record older than 31 minutes), retry succeeds without force
  const dir2 = await tempDir('helmx-update-');
  await writeBlockedRelease(dir2, {
    version: '1.5.0',
    reason: 'old failure',
    at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  const result2 = await performUpdate(dir2, NODE_SPEC, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(9).replacement,
  });
  assert.equal(result2.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dir2, { recursive: true, force: true });
});

test('performUpdate: drain gate allows upgrade once in-flight exec count drops to zero before timeout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const log: UpgradeLog = { draining: [], execCount: { value: 2 }, shutdownPids: [] };
  setTimeout(() => {
    log.execCount.value = 0;
  }, 100).unref();
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.1.0',
    currentVersion: '1.0.0',
    drainTimeoutMs: 10_000,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(55).replacement,
    ...makeHooks(log),
  });
  assert.equal(result.upgraded, true);
  assert.equal(log.draining[0], true);
  assert.equal(log.shutdownPids.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: drain timeout aborts upgrade, releases drain gate, and leaves state untouched', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeCurrentRelease(dir, {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    entries: { entryPath: '/old/dist/cli.js' },
  });
  const log: UpgradeLog = { draining: [], execCount: { value: 3 }, shutdownPids: [] };
  let prepared = 0;
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.1.0',
        drainTimeoutMs: 150,
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          prepared += 1;
          return makeReplacement(1).replacement;
        },
        ...makeHooks(log),
      }),
    /timed out draining/,
  );
  assert.equal(prepared, 0, 'drain failure must not enter prepare');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released');
  assert.deepEqual(log.shutdownPids, []);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: commit failure aborts replacement, restores current, writes blocked, and releases drain gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const originalCurrent = {
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: '/old/dist/cli.js', cliBinDir: '/old/node_modules/.bin' },
  };
  await writeCurrentRelease(dir, originalCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(321, { commitError: new Error('activate handshake timeout') });

  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    /rolled back[\s\S]*activate handshake timeout/,
  );
  assert.deepEqual(calls, ['commit:321', 'abort:321'], 'commit failure must abort replacement');
  assert.deepEqual(await readCurrentRelease(dir), originalCurrent, 'current.json must be restored');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '1.4.0');
  assert.match(blocked?.reason ?? '', /activate handshake timeout/);
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  assert.deepEqual(log.shutdownPids, []);

  // Immediate retry of blocked version is rejected by cooldown
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /cooldown/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: when prepareReplacement throws, current remains unchanged, blocked is written, and drain gate is released', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeCurrentRelease(dir, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath: '/old/dist/cli.js' } });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '2.0.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          throw new Error('replacement daemon register failed');
        },
        ...makeHooks(log),
      }),
    /replacement daemon register failed/,
  );
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '2.0.0');
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: defaults target version to latest when omitted', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const { fetchFn } = makeRegistryFetch('1.9.0');
  const result = await performUpdate(dir, NODE_SPEC, {
    currentVersion: '1.0.0',
    fetchFn,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(77).replacement,
  });
  assert.equal(result.targetVersion, '1.9.0');
  assert.equal(result.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: enforces cross-process upgrade lock exclusion', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let enteredPrepare = 0;
  const first = performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.2.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => {
      enteredPrepare += 1;
      await gate; // hold lock until released externally
      return makeReplacement(11).replacement;
    },
  });
  const deadline = Date.now() + 5_000;
  while (enteredPrepare === 0 && Date.now() < deadline) await delay(20);
  assert.equal(enteredPrepare, 1, 'first upgrade should have entered lock-protected prepare phase');
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.3.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /upgrade already in progress/,
  );
  unblock?.();
  const firstResult = await first;
  assert.equal(firstResult.upgraded, true);
  // Lock released; second upgrade can proceed
  const second = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.3.0',
    currentVersion: '1.2.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(12).replacement,
  });
  assert.equal(second.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: failure in clearBlockedRelease before commit aborts without calling commit and releases drain gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await writeCurrentRelease(dir, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath: '/old/dist/cli.js' } });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(888);

  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // Real filesystem fault: make update-blocked.json a directory so rm(force) fails with EISDIR
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          return replacement;
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /commit failed/);
      assert.match(msg, /update-blocked\.json/, 'error should report the failing path');
      return true;
    },
  );
  assert.deepEqual(calls, ['abort:888'], 'pre-commit failure must abort without calling commit');
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0', 'current.json must be restored');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  assert.deepEqual(log.shutdownPids, [], 'must not schedule shutdown');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: no fallible fs operations after commit succeed so blocked cleanup never causes false failures', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(889);
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.6.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => replacement,
    ...makeHooks(log),
  });
  assert.equal(result.upgraded, true);
  assert.equal(result.pid, 889);
  assert.deepEqual(calls, ['commit:889']);
  assert.deepEqual(log.shutdownPids, [889]);
  assert.equal(await readBlockedRelease(dir), null, 'blocked record should be cleared before commit');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: corrupt current.json throws explicitly and never triggers draining or fakes success', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{corrupted', 'utf8');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.6.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
        ...makeHooks(log),
      }),
    /current\.json is corrupt/,
  );
  assert.equal(log.draining.length, 0, 'snapshot read precedes draining; must not enter draining state');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: always releases drain gate in finally even if getActiveExecCount throws', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
        ...makeHooks(log),
        getActiveExecCount: () => {
          throw new Error('counter crash');
        },
      }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /counter crash/);
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released even when callback throws');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: surfaces both prepare failure and blocked-write failure together', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // Make update-blocked.json a directory so writeBlockedRelease fails with a real EISDIR fault
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          throw new Error('replacement daemon register failed');
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /replacement daemon register failed/);
      assert.match(msg, /write blocked record failed/, 'writeBlockedRelease failure must not be swallowed');
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: propagates force to staging so same-version update reinstalls', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const first = await stageRelease(dir, '1.0.0', undefined, { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const result = await performUpdate(dir, NODE_SPEC, {
    targetVersion: '1.0.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: async (stagingDir, version) => {
      extractorRuns += 1;
      return fakeExtractor(stagingDir, version);
    },
    prepareReplacement: async () => makeReplacement(66).replacement,
  });
  assert.equal(result.upgraded, true, 'forced same-version update should reinstall and upgrade');
  assert.equal(extractorRuns, 1, 'force must bypass .complete cache');
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.notEqual(current?.entries['entryPath'], first.entries['entryPath'], 'current.json should point to new candidate entry');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: UpgradeCommitUnconfirmedError skips abort/rollback/blocked and leaves current and drain gate active', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const oldCurrent = { version: '1.0.0', updatedAt: '2026-01-01T00:00:00.000Z', entries: { entryPath: '/old/dist/cli.js' } };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const unconfirmed = new UpgradeCommitUnconfirmedError('activate ACK timeout (candidate may already be committed upstream)');
  const { replacement, calls } = makeReplacement(990, { commitError: unconfirmed });

  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '2.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const err = error as Error & { cause?: unknown };
      const msg = err.message;
      assert.match(msg, /replacement was activated, but confirmation was unconfirmed/);
      assert.doesNotMatch(msg, /rollback to 1\.0\.0|rolled back/);
      assert.equal(err.cause, unconfirmed, 'original unconfirmed error should be preserved as cause');
      return true;
    },
  );
  assert.deepEqual(calls, ['commit:990'], 'must not invoke abort');
  // New current.json keeps pointing to target version without rollback
  assert.equal((await readCurrentRelease(dir))?.version, '2.5.0');
  // Must not record failure in update-blocked.json
  assert.equal(await readBlockedRelease(dir), null);
  // Drain gate stays active while the previous process exits and the candidate may take over
  assert.deepEqual(log.draining, [true]);
  assert.deepEqual(log.shutdownPids, [990]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performUpdate: ordinary commit error still performs full rollback (contrast with unconfirmed branch)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-');
  const oldCurrent = { version: '1.0.0', updatedAt: '2026-01-01T00:00:00.000Z', entries: { entryPath: '/old/dist/cli.js' } };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(991, { commitError: new Error('activate handshake timeout') });

  await assert.rejects(
    () =>
      performUpdate(dir, NODE_SPEC, {
        targetVersion: '2.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    /commit failed and rolled back to 1\.0\.0/,
  );
  assert.deepEqual(calls, ['commit:991', 'abort:991']);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  assert.equal((await readBlockedRelease(dir))?.version, '2.5.0');
  assert.deepEqual(log.draining, [true, false]);
  assert.deepEqual(log.shutdownPids, []);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6b. withUpdateLock stale-PID recovery & shared cooldown / dist-tag / hub-switch
// ---------------------------------------------------------------------------

test('withUpdateLock: recovers confirmed-dead stale PID locks, rejects live locks, and preserves corrupt locks', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helmx-update-lock-');
  const lockPath = path.join(dir, 'upgrade.lock');
  try {
    // 1. Stale lock left behind by a SIGKILLed process (dead PID): auto-recovered instead of deadlocking forever.
    await fs.writeFile(lockPath, '999999999 dead-owner-uuid\n', 'utf8');
    let ran = false;
    await withUpdateLock(
      dir,
      async () => {
        ran = true;
      },
      { isAlive: (pid) => pid === process.pid },
    );
    assert.equal(ran, true, 'dead-PID stale upgrade.lock must be recovered');
    assert.equal(rawFs.existsSync(lockPath), false, 'lock must be removed after normal release');

    // 2. Live PID holding the lock: rejected with UpgradeRejectedError and preserved untouched.
    const liveContent = `${process.pid} live-owner-uuid\n`;
    await fs.writeFile(lockPath, liveContent, 'utf8');
    await assert.rejects(
      () => withUpdateLock(dir, async () => undefined),
      (error: unknown) => error instanceof UpgradeRejectedError && /upgrade already in progress/.test(error.message),
    );
    assert.equal(await fs.readFile(lockPath, 'utf8'), liveContent, 'live lock file must stay untouched');
    await fs.rm(lockPath, { force: true });

    // 3. Empty/corrupt lock file: rejected fail-closed with UpgradeRejectedError and preserved untouched.
    await fs.writeFile(lockPath, '', 'utf8');
    await assert.rejects(
      () => withUpdateLock(dir, async () => undefined),
      (error: unknown) => error instanceof UpgradeRejectedError && /upgrade already in progress/.test(error.message),
    );
    assert.equal(rawFs.existsSync(lockPath), true, 'corrupt/empty lock must not be silently deleted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('isBlockedVersionActive, resolveBlockedCooldownMs, and assertDistTag enforce shared policy boundaries', { timeout: 60_000 }, () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const blocked = { version: '1.2.0', at: '2026-11-20T11:50:00Z' };
  assert.equal(isBlockedVersionActive(blocked, '1.2.0', now), true);
  assert.equal(isBlockedVersionActive(blocked, '1.3.0', now), false);
  assert.equal(isBlockedVersionActive({ ...blocked, at: '2026-11-20T11:30:00Z' }, '1.2.0', now), false);
  assert.equal(isBlockedVersionActive({ ...blocked, at: 'not-a-date' }, '1.2.0', now), true);
  assert.equal(isBlockedVersionActive(null, '1.2.0', now), false);

  assert.equal(resolveBlockedCooldownMs({}), 30 * 60_000);
  assert.equal(resolveBlockedCooldownMs({ HELMX_UPGRADE_BLOCK_COOLDOWN_MS: '5000' }), 5000);
  assert.throws(() => resolveBlockedCooldownMs({ HELMX_UPGRADE_BLOCK_COOLDOWN_MS: '0' }), /invalid HELMX_UPGRADE_BLOCK_COOLDOWN_MS/);
  assert.throws(() => resolveBlockedCooldownMs({ HELMX_UPGRADE_BLOCK_COOLDOWN_MS: '-1' }), /invalid HELMX_UPGRADE_BLOCK_COOLDOWN_MS/);

  assert.equal(assertDistTag('latest'), 'latest');
  assert.equal(assertDistTag('beta-1.0'), 'beta-1.0');
  assert.throws(() => assertDistTag('1.2.3'), UpgradeRejectedError);
  assert.throws(() => assertDistTag('../evil'), UpgradeRejectedError);
});

test('assertListenUrlMatches and commitAndSwitchHubRelease enforce URL parity and rollback-before-restart order', { timeout: 60_000 }, async () => {
  assertListenUrlMatches('http://127.0.0.1:3202', { host: '127.0.0.1', port: 3202 });
  assertListenUrlMatches('http://127.0.0.1:3202', { host: '0.0.0.0', port: 3202 });
  assertListenUrlMatches('http://127.0.0.1:3202', { host: '::', port: 3202 });
  assertListenUrlMatches('http://[::1]:3202', { host: '::1', port: 3202 });
  assert.throws(() => assertListenUrlMatches('http://10.0.0.9:3202', { host: '127.0.0.1', port: 3202 }), /launch configuration expects/);
  assert.throws(() => assertListenUrlMatches('http://127.0.0.1:9999', { host: '127.0.0.1', port: 3202 }), /launch configuration expects/);
  assert.throws(() => assertListenUrlMatches('ftp://127.0.0.1:3202', { host: '127.0.0.1', port: 3202 }), /not http\(s\)/);
  assert.throws(() => assertListenUrlMatches('not-a-url', { host: '127.0.0.1', port: 3202 }), /not parseable/);

  const dir = await tempDir('helmx-hub-switch-');
  try {
    const previous: CurrentReleaseRecord = {
      version: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: { entryPath: '/releases/1.0.0/start.mjs' },
    };
    await writeCurrentRelease(dir, previous);
    const seenVersionsAtStart: string[] = [];

    await assert.rejects(
      () =>
        commitAndSwitchHubRelease({
          root: dir,
          targetVersion: '1.1.0',
          targetEntryPath: '/releases/1.1.0/start.mjs',
          previousRecord: previous,
          shouldStart: true,
          restartPreviousOnRollback: true,
          startRelease: async ({ version }) => {
            const onDisk = await readCurrentRelease(dir);
            seenVersionsAtStart.push(`${version}@disk:${onDisk?.version ?? 'none'}`);
            if (version === '1.1.0') throw new Error('listen URL mismatch');
            return { pid: 9001 };
          },
          formatRestored: (started, prev) => `rolled back to ${prev.version} (pid ${started.pid})`,
        }),
      /rolled back to 1\.0\.0 \(pid 9001\)/,
    );
    // Target ran with 1.1.0 committed; rollback restored 1.0.0 BEFORE restarting previous release.
    assert.deepEqual(seenVersionsAtStart, ['1.1.0@disk:1.1.0', '1.0.0@disk:1.0.0']);
    assert.deepEqual(await readCurrentRelease(dir), previous);
    assert.equal((await readBlockedRelease(dir))?.version, '1.1.0');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. runNpm timeout process-group kill: npm lifecycle descendants must not remain orphaned
// ---------------------------------------------------------------------------

test('runNpm timeout kills entire process group so descendant processes cannot keep writing to staging', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') return; // POSIX process group semantics; win32 relies on taskkill /T
  const dir = await tempDir('npm-group-kill-');
  const heartbeat = path.join(dir, 'beat.txt');
  const grandPidFile = path.join(dir, 'grand.pid');
  const runnerScript = path.join(dir, 'runner.cjs');
  await fs.writeFile(
    runnerScript,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', " +
        JSON.stringify(
          "const fs=require('node:fs');" +
            "setInterval(()=>fs.appendFile(process.argv[1],'.',()=>{}),50);" +
            "setInterval(()=>{},1000);",
        ) +
        ", process.argv[2]], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[3], String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'npm-group-hold',
      private: true,
      scripts: { hold: `node ${runnerScript} ${JSON.stringify(heartbeat)} ${JSON.stringify(grandPidFile)}` },
    }),
    'utf8',
  );
  const cleanup = async (): Promise<void> => {
    const raw = await fs.readFile(grandPidFile, 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  t.after(async () => {
    await cleanup();
  });

  const npmPromise = runNpm(['run', 'hold'], dir, 3_000);
  const deadline = Date.now() + 2_500;
  for (;;) {
    const exists = await fs.readFile(grandPidFile, 'utf8').then(
      () => true,
      () => false,
    );
    if (exists) break;
    if (Date.now() > deadline) throw new Error('npm run did not spawn descendant process before deadline (fixture failed)');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await assert.rejects(() => npmPromise, /timed out/);

  const rawPid = await fs.readFile(grandPidFile, 'utf8');
  const grandPid = Number(rawPid.trim());
  assert.ok(Number.isInteger(grandPid) && grandPid > 0, `invalid descendant pid: ${rawPid}`);
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let alive = isAlive(grandPid);
  for (let i = 0; i < 20 && alive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = isAlive(grandPid);
  }
  assert.equal(alive, false, 'descendant process must be killed with its process group on timeout without leaving orphans');
});

test('resolveNpmCommand: POSIX uses npm directly; win32 locates npm-cli.js beside execPath without shell fallback', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveNpmCommand({ platform: 'linux' }), { command: 'npm', args: [] });
  assert.deepEqual(resolveNpmCommand({ platform: 'darwin' }), { command: 'npm', args: [] });

  const siblingHit = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(
    resolveNpmCommand({
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      existsSync: (p) => p === siblingHit,
    }),
    { command: 'C:\\Program Files\\nodejs\\node.exe', args: [siblingHit] },
  );

  const parentHit = 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(
    resolveNpmCommand({
      platform: 'win32',
      execPath: 'C:\\tools\\bin\\node.exe',
      existsSync: (p) => p === parentHit,
    }),
    { command: 'C:\\tools\\bin\\node.exe', args: [parentHit] },
  );

  assert.throws(
    () =>
      resolveNpmCommand({
        platform: 'win32',
        execPath: 'C:\\missing\\node.exe',
        existsSync: () => false,
      }),
    /npm-cli\.js/,
  );
});

test('runControlledProcess: enforces per-stream tail-retaining output cap and kills full process tree on timeout', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('controlled-proc-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // 1. Per-stream output cap retains exact trailing diagnostic bytes without unbounded buffering.
  const noisy = await runControlledProcess(
    process.execPath,
    [
      '-e',
      "process.stdout.write('A'.repeat(2000) + 'TAIL_OUT'); process.stderr.write('B'.repeat(2000) + 'TAIL_ERR');",
    ],
    { cwd: dir, timeoutMs: 10_000, maxOutputChars: 32 },
  );
  assert.equal(noisy.code, 0);
  assert.equal(noisy.timedOut, false);
  assert.equal(noisy.stdoutTruncated, true);
  assert.equal(noisy.stderrTruncated, true);
  assert.equal(noisy.stdout.length, 32);
  assert.equal(noisy.stderr.length, 32);
  assert.ok(noisy.stdout.endsWith('TAIL_OUT'), `stdout must preserve trailing marker: ${noisy.stdout}`);
  assert.ok(noisy.stderr.endsWith('TAIL_ERR'), `stderr must preserve trailing marker: ${noisy.stderr}`);

  // 2. Timeout terminates child + grandchild holding stdio open without hanging or leaking orphans.
  if (process.platform !== 'win32') {
    const grandPidFile = path.join(dir, 'grand.pid');
    const runner = path.join(dir, 'spawn-grand.cjs');
    await fs.writeFile(
      runner,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
        "fs.writeFileSync(process.argv[2], String(g.pid));",
        "process.stdout.write('BEFORE_TIMEOUT\\n');",
        "setInterval(() => {}, 1000);",
      ].join('\n'),
      'utf8',
    );
    t.after(async () => {
      const pid = Number((await fs.readFile(grandPidFile, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already dead
        }
      }
    }, { timeout: 60_000 });

    const pending = runControlledProcess(process.execPath, [runner, grandPidFile], {
      cwd: dir,
      timeoutMs: 3_000,
    });
    const waitDeadline = Date.now() + 2_500;
    let rawPid = '';
    while (Date.now() < waitDeadline) {
      rawPid = await fs.readFile(grandPidFile, 'utf8').catch(() => '');
      if (rawPid.trim().length > 0) break;
      await delay(20);
    }
    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.code, -1);
    assert.ok(result.stdout.includes('BEFORE_TIMEOUT'));

    if (rawPid.trim().length === 0) {
      rawPid = await fs.readFile(grandPidFile, 'utf8').catch(() => '');
    }
    const grandPid = Number(rawPid.trim());
    assert.ok(Number.isInteger(grandPid) && grandPid > 0, `descendant pid file must be written before timeout (got ${JSON.stringify(rawPid)})`);
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      try {
        process.kill(grandPid, 0);
        await delay(50);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'grandchild holding inherited stdio must be killed on timeout');
  }
});
