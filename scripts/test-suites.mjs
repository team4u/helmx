#!/usr/bin/env node
/**
 * Test tier entry point: unit / integration / all suites, invoked by package.json scripts.
 *
 * Why it exists: `pnpm test` runs everything in one go, while local iteration needs a
 * faster pure-unit tier; tests in kernel / node heavily spawn real subprocesses, open
 * SQLite, create Git worktrees, and run WebSocket plus the @helmx/node daemon — not pure
 * units. To avoid misclassification, this script only does a [conservative package-level
 * split]:
 *
 *   unit        = protocol + env-io + test-kit + cli + web + ui + plugin-client (env-io is in-process
 *                 pure scan orchestrator injection tests; web covers happy-dom/React interaction
 *                 and SDK self-tests — none start real services);
 *   integration = plugin-build + kernel + plugins + hub + node + payload plus two path entries —
 *                 'cli/test/launcher' (Hub launcher process lifecycle) and 'env-io/test/update'
 *                 (the shared update engine: real subprocesses, staging directories,
 *                 cross-process locks) — tier overrides for process-level suites living inside
 *                 unit-tier packages;
 *   all         = unit ∪ integration = every test file, equivalent to the old `pnpm test`.
 *
 * SUITES entries are either a package name (that package's top-level test/ files) or a
 * packages/-relative path such as 'cli/test/launcher' — a tier override for a test
 * subdirectory living inside an otherwise unit-tier package (process-level suites like the
 * Hub launcher lifecycle). A package entry never descends into subdirectories, so a
 * subdirectory's files enter exactly one suite via its path entry.
 *
 * Implementation: Node fs enumerates *.test.ts(x) under <root>/packages/<pkg>/test/ (or the
 * entry subdirectory itself). Cached AST classification (`scripts/lib/test-sharding.mjs`)
 * partitions files into 4 logical pools (`pure`, `dom-shared`, `node-shared`, `isolated`),
 * balanced by auto-recorded millisecond timings (`scripts/lib/test-timings.mjs`):
 * - `pure` and `node-shared` share one unified Node IPC worker queue (identical env, zero
 *   DOM preload) sorted heaviest-first so pure files naturally fill tails with zero idle cores;
 * - `dom-shared` runs in persistent happy-dom IPC workers (uncapped up to `sharedBudget`);
 * - when isolated shards finish or a shared queue drains and releases permits, extra workers
 *   are dynamically spawned for any remaining shared queue with meaningful unbooked work;
 * - `isolated` files run as 1-file shards sorted heaviest-first, spawned directly via
 *   `node --require tsx/preflight --import tsx --test --test-isolation=none` (each shard is
 *   already a dedicated OS process, avoiding `run-tests.mjs` + per-shard watchdog + `tsx/cli`
 *   + nested `--test-isolation=process` overhead) under one shared parent-death watchdog and
 *   unified suite timeout/process-group cleanup.
 *
 * Invariants (defensive assertions; any failure exits 2 rather than silently running the
 * wrong set):
 *   - all's file count must equal unit + integration file counts (no overlap, no gap);
 *   - the unit ∪ integration relative-path set must exactly match the actual *.test.ts(x)
 *     file set across every package's test directory, subdirectories included (so new
 *     packages, files, or nested test directories cannot be silently missed here).
 *
 * Note: do not raise the total timeout via the HELMX_TEST_SUITE_TIMEOUT_MS env var —
 * packages/kernel/test/env-registry-races.test.ts asserts every host HELMX_* variable is
 * stripped, and injecting it would make that test fail spuriously.
 *
 * Usage: node scripts/test-suites.mjs <unit|integration|all> [extra args passed through to the node test runner]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  balanceShardsLpt,
  DEFAULT_PURITY_CACHE_REL,
  planFourPoolSchedule,
  shouldDisableSharding,
} from './lib/test-sharding.mjs';
import {
  createTestWeightFn,
  DEFAULT_TIMINGS_CACHE_REL,
  loadTestTimings,
  mergeTestTimings,
  normalizeTimingKey,
  pruneStaleTestTimings,
  saveTestTimings,
} from './lib/test-timings.mjs';
import {
  explicitTestConcurrency,
  resolveTestConcurrency,
  withDefaultTestConcurrency,
} from './lib/test-concurrency.mjs';
import { pruneTsxCacheIfBloated } from './lib/tsx-cache-hygiene.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// Suite -> package names or packages/-relative paths. Split principles live in the header comment;
// tier changes must be mirrored in AGENTS.md's test tiering conventions and PACKAGE_TIERS in
// scripts/lib/workspace-meta.mjs.
const SUITES = {
  unit: ['protocol', 'env-io', 'test-kit', 'cli', 'web', 'ui', 'plugin-client'],
  integration: ['plugin-build', 'kernel', 'plugins', 'hub', 'node', 'payload', 'cli/test/launcher', 'env-io/test/update'],
};
const ALL_PACKAGES = [...SUITES.unit, ...SUITES.integration];

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const LAST_RESORT_MS = 15_000;
const GROUP_POLL_MS = 100;
const ISO_COLD_START_MS = 1_500;
const DYNAMIC_SPAWN_MIN_WEIGHT_MS = 2_000;

const testFilesCache = new Map();

// A package entry ('cli') reads that package's top-level test/ files; a path entry
// ('cli/test/launcher', packages/-relative) reads the subdirectory it names. Both return
// repo-root-relative file paths.
function testFilesOf(entry) {
  const cached = testFilesCache.get(entry);
  if (cached !== undefined) return cached;
  const relDir = entry.includes('/') ? entry : path.join(entry, 'test');
  const dir = path.join(packagesDir, relDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[test-suites] cannot read ${dir}: ${err.message} (package missing or not installed?)`);
    process.exit(2);
  }
  const result = entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => path.join('packages', relDir, e.name))
    .sort();
  testFilesCache.set(entry, result);
  return result;
}

function suiteTimeoutMs() {
  const raw = process.env.HELMX_TEST_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SUITE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    console.error(`[test-suites] invalid HELMX_TEST_SUITE_TIMEOUT_MS (positive integer ms required): ${raw}`);
    process.exit(2);
  }
  return n;
}

function pnpmFallbackNodePath() {
  const fallback = path.join(repoRoot, 'node_modules', '.pnpm', 'node_modules');
  return existsSync(fallback) ? fallback : '';
}

const rawArgv = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
const suiteName = rawArgv[0];
let files;
let extraArgs;
let label;

if (suiteName === '--files') {
  const explicitFiles = [];
  let i = 1;
  for (; i < rawArgv.length; i += 1) {
    const arg = rawArgv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (arg.startsWith('-')) break;
    explicitFiles.push(arg);
  }
  extraArgs = rawArgv.slice(i);
  if (explicitFiles.length === 0) {
    console.error('[test-suites] --files requires at least one test file path');
    process.exit(2);
  }
  const seen = new Set();
  files = [];
  for (const rawFile of explicitFiles) {
    const abs = path.resolve(repoRoot, rawFile);
    const rel = path.relative(repoRoot, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      console.error(`[test-suites] --files path must live inside repository: ${rawFile}`);
      process.exit(2);
    }
    if (!existsSync(abs)) {
      console.error(`[test-suites] --files target does not exist: ${rel}`);
      process.exit(2);
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      files.push(rel);
    }
  }
  label = `files(${files.length})`;
  console.error(`[test-suites] suite ${label}: ${files.length} file(s)`);
} else {
  if (!SUITES[suiteName] && suiteName !== 'all') {
    console.error(`[test-suites] usage: node scripts/test-suites.mjs <unit|integration|all|--files <path...>> [extra args...]`);
    process.exit(2);
  }
  const rawExtraArgs = rawArgv.slice(1);
  extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs;

  if (suiteName === 'all') {
    files = ALL_PACKAGES.flatMap(testFilesOf);
  } else {
    files = SUITES[suiteName].flatMap(testFilesOf);
  }

  if (files.length === 0) {
    console.error(`[test-suites] suite ${suiteName} enumerated 0 test files; refusing to run (directory layout change suspected)`);
    process.exit(2);
  }

  // Invariant 1: all = unit + integration (no overlap, no gap).
  if (suiteName === 'all') {
    const unitCount = SUITES.unit.reduce((n, p) => n + testFilesOf(p).length, 0);
    const integrationCount = SUITES.integration.reduce((n, p) => n + testFilesOf(p).length, 0);
    const uniqueCount = new Set(files).size;
    if (files.length !== unitCount + integrationCount || uniqueCount !== files.length) {
      console.error(
        `[test-suites] all(${files.length}) != unit(${unitCount}) + integration(${integrationCount}) or duplicate files exist; the split invariant is broken`,
      );
      process.exit(2);
    }
  }

  // Invariant 2: the unit ∪ integration relative-path set == the actual file set across all
  // repo test directories. Scan every package under packages/ with a test subdirectory (not
  // just the known ones), subdirectories included, to catch future additions.
  {
    const managed = new Set(ALL_PACKAGES.flatMap(testFilesOf));
    const actual = new Set();
    const walkTestDir = (dir, prefix) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // not a directory (e.g. packages/<pkg>/test missing)
      }
      for (const f of entries) {
        if (f.isFile() && TEST_SUFFIXES.some((s) => f.name.endsWith(s))) {
          actual.add(path.join(prefix, f.name));
        } else if (f.isDirectory()) {
          walkTestDir(path.join(dir, f.name), path.join(prefix, f.name));
        }
      }
    };
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      walkTestDir(path.join(packagesDir, entry.name, 'test'), path.join('packages', entry.name, 'test'));
    }
    const missing = [...actual].filter((f) => !managed.has(f));
    if (missing.length > 0) {
      console.error(`[test-suites] found test files not covered by any suite (update the SUITES tiers; path entries like 'pkg/test/subdir' cover subdirectories): ${missing.join(', ')}`);
      process.exit(2);
    }
  }

  label = suiteName === 'all' ? 'all(unit+integration)' : suiteName;
  const breakdown = ALL_PACKAGES.map((p) => `${p}=${testFilesOf(p).length}`).join(' ');
  console.error(`[test-suites] suite ${label}: ${files.length} file(s) (${breakdown})`);
}

let workerBudget;
try {
  workerBudget = resolveTestConcurrency(process.env.TEST_CONCURRENCY, os.availableParallelism());
} catch (error) {
  console.error(`[test-suites] ${error.message}`);
  process.exit(2);
}

let workerBudgetOverride;
try {
  workerBudgetOverride = explicitTestConcurrency(extraArgs);
} catch (error) {
  console.error(`[test-suites] ${error.message}`);
  process.exit(2);
}
if (workerBudgetOverride !== undefined) workerBudget = workerBudgetOverride;

// `shard-worker.mjs` drives `node:test`'s programmatic `run()` API rather than `tsx --test` CLI
// parsing, so any non-empty pass-through CLI arguments fall back to a single native `run-tests.mjs`
// invocation — ensuring flags like `--test-rerun-failures`, `--test-global-setup`, or invalid
// flags are never silently dropped on shared-pool files.
const shardingDisabled = extraArgs.length > 0 || shouldDisableSharding(extraArgs) || workerBudgetOverride !== undefined;

const timeoutMs = suiteTimeoutMs();
const timingsCachePath = path.join(repoRoot, DEFAULT_TIMINGS_CACHE_REL);
const purityCachePath = path.join(repoRoot, DEFAULT_PURITY_CACHE_REL);
const timingsStore = loadTestTimings(timingsCachePath);
const { weightFn, recordedCount } = createTestWeightFn({ repoRoot, timings: timingsStore });

const byWeightDesc = (a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b);
const sortedAllFiles = [...files].sort(byWeightDesc);

const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
let cachedTs = null;
const getTs = () => {
  if (!cachedTs) cachedTs = requireFromRoot('typescript');
  return cachedTs;
};

const tsxPreflightPath = requireFromRoot.resolve('tsx/preflight');
const tsxLoaderUrl = pathToFileURL(requireFromRoot.resolve('tsx')).href;
const tsxDirectArgs = ['--require', tsxPreflightPath, '--import', tsxLoaderUrl];
const shardWorkerPath = path.join(repoRoot, 'scripts', 'lib', 'shard-worker.mjs');
const safeTestAssertUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'safe-test-assert.mjs')).href;
const domShardPreloadUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'dom-shard-preload.mjs')).href;
const timingReporterUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'timing-reporter.mjs')).href;
const runTestsPath = path.join(repoRoot, 'scripts', 'run-tests.mjs');

function buildWorkerEnv({ enableDomPreload }) {
  const env = { ...process.env };
  const fallback = pnpmFallbackNodePath();
  if (fallback) {
    env.NODE_PATH = process.env.NODE_PATH
      ? fallback + path.delimiter + process.env.NODE_PATH
      : fallback;
  }
  if (env.TSX_TSCONFIG_PATH === undefined) {
    env.TSX_TSCONFIG_PATH = path.join(repoRoot, 'tsconfig.dev.json');
  }
  if (env.NODE_COMPILE_CACHE === undefined) {
    env.NODE_COMPILE_CACHE = path.join(repoRoot, 'node_modules', '.cache', 'v8-compile-cache');
  }
  const existing = env.NODE_OPTIONS?.trim() ?? '';
  const parts = existing ? [existing] : [];
  if (!/(?:^|\s)--max-old-space-size(?:=|\s|$)/.test(existing)) {
    parts.push('--max-old-space-size=1536');
  }
  const safeImportFlag = `--import=${safeTestAssertUrl}`;
  if (!existing.includes(safeImportFlag)) {
    parts.push(safeImportFlag);
  }
  if (enableDomPreload) {
    const domImportFlag = `--import=${domShardPreloadUrl}`;
    if (!existing.includes(domImportFlag)) {
      parts.push(domImportFlag);
    }
  }
  env.NODE_OPTIONS = parts.join(' ');
  return env;
}

const nodeWorkerEnv = buildWorkerEnv({ enableDomPreload: false });
const domWorkerEnv = buildWorkerEnv({ enableDomPreload: true });

const runTempDir = path.join(
  repoRoot,
  'node_modules',
  '.cache',
  'helmx-test-runs',
  `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

const tsxPrune = pruneTsxCacheIfBloated();
if (tsxPrune.pruned > 0) {
  console.error(`[test-suites] pruned ${tsxPrune.pruned} stale tsx cache entries (${tsxPrune.cacheDir})`);
}

/**
 * @typedef {{
 *   kind: 'shard-worker' | 'isolated-direct' | 'run-tests-fallback',
 *   label: string,
 *   args: string[],
 *   permits: number,
 *   timingOutputPath: string | null,
 *   enableDomPreload?: boolean,
 *   ipcPool?: 'node-shared' | 'dom-shared',
 * }} ExecPlan
 */

/** @type {ExecPlan[]} */
const plans = [];
/** @type {Record<string, { files: string[], cursor: number, activeWorkers: number, bootingWorkers: number, spawnedCount: number }>} */
const ipcQueues = {};
let ipcDynamicScale = false;
let nextIpcWorkerSeq = 0;

/**
 * Create an IPC-backed shard-worker plan (used both for initial workers and dynamic scale-up).
 * @param {'node-shared' | 'dom-shared'} pool
 * @param {string} workerLabel
 * @returns {ExecPlan}
 */
function createIpcWorkerPlan(pool, workerLabel) {
  const seq = nextIpcWorkerSeq;
  nextIpcWorkerSeq += 1;
  const timingOutputPath = path.join(runTempDir, `timings-ipc-${seq}.json`);
  const manifestPath = path.join(runTempDir, `manifest-ipc-${seq}.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      pool,
      repoRoot,
      ipcQueue: true,
      timingOutputPath,
      testTimeoutMs: 20_000,
    }),
    'utf8',
  );
  return {
    kind: 'shard-worker',
    label: workerLabel,
    args: [...tsxDirectArgs, shardWorkerPath, manifestPath],
    permits: 1,
    timingOutputPath,
    enableDomPreload: pool === 'dom-shared',
    ipcPool: pool,
  };
}

/**
 * Build 1-file direct isolated plans sorted heaviest-first (zero 4-file tail grouping).
 * Most isolated files run with `--test-isolation=none` because each shard is already its own
 * dedicated OS process; files requiring native child-process isolation (explicit
 * `@test-isolation: process` pragma or self-signaling `process.kill(process.pid, ...)`) keep
 * `--test-isolation=process` so self-signals never cancel Node's outer `--test` runner.
 */
function makeIsolatedShardPlans(isoFiles, outDir, processIsolatedSet) {
  return isoFiles.map((rel, idx) => {
    const timingOutputPath = path.join(outDir, `timings-iso-${idx}.json`);
    const isolationMode = processIsolatedSet.has(rel) ? 'process' : 'none';
    return {
      kind: /** @type {const} */ ('isolated-direct'),
      label: `isolated-${idx + 1}/${isoFiles.length}`,
      args: [
        ...tsxDirectArgs,
        '--test',
        `--test-isolation=${isolationMode}`,
        '--test-timeout=20000',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        `--test-reporter=${timingReporterUrl}`,
        `--test-reporter-destination=${timingOutputPath}`,
        rel,
      ],
      permits: 1,
      timingOutputPath,
      enableDomPreload: false,
    };
  });
}

if (!shardingDisabled) {
  const classifyStartMs = performance.now();
  const schedule = planFourPoolSchedule({
    getTs,
    repoRoot,
    files,
    workerBudget,
    weightFn,
    cachePath: purityCachePath,
    useCache: true,
  });
  const classifyMs = Math.round(performance.now() - classifyStartMs);
  const timingHits = recordedCount(files);

  mkdirSync(runTempDir, { recursive: true });

  // Unify `pure` and `node-shared` into one shared Node IPC queue (identical worker env, zero DOM preload).
  const unifiedNodeFiles = [...schedule.pools['node-shared'], ...schedule.pools.pure].sort(byWeightDesc);
  const domFiles = [...schedule.pools['dom-shared']];
  const isoFiles = [...schedule.pools.isolated];

  const activeSharedPools = /** @type {Array<'node-shared' | 'dom-shared'>} */ ([]);
  if (unifiedNodeFiles.length > 0) activeSharedPools.push('node-shared');
  if (domFiles.length > 0) activeSharedPools.push('dom-shared');

  const processIsolatedSet = new Set(schedule.processIsolatedFiles ?? []);
  const isoPlans = makeIsolatedShardPlans(isoFiles, runTempDir, processIsolatedSet);
  const minRequiredForIpc = activeSharedPools.length + (isoPlans.length > 0 ? 1 : 0);

  let scheduledPoolSummary = '';

  if (activeSharedPools.length > 0 && workerBudget >= minRequiredForIpc) {
    ipcDynamicScale = true;
    const poolWeights = {
      'node-shared': unifiedNodeFiles.reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
      'dom-shared': domFiles.reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
      isolated: isoFiles.reduce((s, f) => s + Math.max(1, weightFn(f)) + ISO_COLD_START_MS, 0),
    };
    const activeAllPools = /** @type {Array<'node-shared' | 'dom-shared' | 'isolated'>} */ ([
      ...activeSharedPools,
      ...(isoPlans.length > 0 ? [/** @type {const} */ ('isolated')] : []),
    ]);
    const caps = {
      'node-shared': unifiedNodeFiles.length,
      'dom-shared': domFiles.length,
      isolated: isoPlans.length,
    };
    // Minimax makespan allocation: start every active pool at 1 worker and greedily assign
    // each remaining permit to the pool with the largest current average load (weight / workers).
    // This prevents small-share rounding starvation (e.g. giving `node-shared` only 1 worker
    // in `unit` while `dom-shared` has 10) and eliminates artificial per-pool caps.
    /** @type {Record<'node-shared' | 'dom-shared' | 'isolated', number>} */
    const alloc = { 'node-shared': 0, 'dom-shared': 0, isolated: 0 };
    let used = 0;
    for (const pool of activeAllPools) {
      alloc[pool] = 1;
      used += 1;
    }
    while (used < workerBudget) {
      let bestPool = null;
      let bestLoad = -1;
      for (const pool of activeAllPools) {
        if (alloc[pool] >= caps[pool]) continue;
        const avgLoad = poolWeights[pool] / alloc[pool];
        if (avgLoad > bestLoad) {
          bestLoad = avgLoad;
          bestPool = pool;
        }
      }
      if (!bestPool) break;
      alloc[bestPool] += 1;
      used += 1;
    }

    const isolatedReserve = alloc.isolated;
    const workerCounts = {
      'node-shared': alloc['node-shared'],
      'dom-shared': alloc['dom-shared'],
    };
    const refillOrder = [...activeSharedPools].sort((a, b) => poolWeights[b] - poolWeights[a]);

    const frontIsoCount = Math.min(isolatedReserve, isoPlans.length);
    for (let i = 0; i < frontIsoCount; i += 1) {
      plans.push(isoPlans[i]);
    }

    if (unifiedNodeFiles.length > 0) {
      ipcQueues['node-shared'] = {
        files: unifiedNodeFiles,
        cursor: 0,
        activeWorkers: 0,
        bootingWorkers: 0,
        spawnedCount: 0,
      };
    }
    if (domFiles.length > 0) {
      ipcQueues['dom-shared'] = {
        files: domFiles,
        cursor: 0,
        activeWorkers: 0,
        bootingWorkers: 0,
        spawnedCount: 0,
      };
    }

    for (const pool of refillOrder) {
      const count = workerCounts[pool];
      if (count <= 0) continue;
      for (let i = 0; i < count; i += 1) {
        ipcQueues[pool].spawnedCount += 1;
        plans.push(createIpcWorkerPlan(pool, `${pool}-w${i + 1}/${count}`));
      }
    }

    for (let i = frontIsoCount; i < isoPlans.length; i += 1) {
      plans.push(isoPlans[i]);
    }

    scheduledPoolSummary =
      `node-shared=${unifiedNodeFiles.length}(pure=${schedule.pools.pure.length}+node=${schedule.pools['node-shared'].length},w=${workerCounts['node-shared']}) ` +
      `dom-shared=${domFiles.length}(w=${workerCounts['dom-shared']}) ` +
      `isolated=${isoFiles.length}(${isoPlans.length},front=${frontIsoCount})`;
  } else {
    // Low-budget or isolated-only path: static shard-worker plans + 1-file direct isolated shards.
    /** @type {Array<{ weight: number, plan: ExecPlan }>} */
    const weighted = [];
    let staticIdx = 0;
    const addStaticPool = (pool, poolFiles) => {
      if (poolFiles.length === 0) return;
      const shardCount = Math.min(poolFiles.length, workerBudget);
      const buckets = balanceShardsLpt(poolFiles, shardCount, weightFn);
      buckets.forEach((bucket, idx) => {
        const timingOutputPath = path.join(runTempDir, `timings-static-${staticIdx}.json`);
        const manifestPath = path.join(runTempDir, `manifest-static-${staticIdx}.json`);
        staticIdx += 1;
        writeFileSync(
          manifestPath,
          JSON.stringify({
            pool,
            repoRoot,
            files: bucket.files,
            timingOutputPath,
            testTimeoutMs: 20_000,
          }),
          'utf8',
        );
        weighted.push({
          weight: bucket.weight,
          plan: {
            kind: 'shard-worker',
            label: `${pool}-${idx + 1}/${buckets.length}`,
            args: [...tsxDirectArgs, shardWorkerPath, manifestPath],
            permits: 1,
            timingOutputPath,
            enableDomPreload: pool === 'dom-shared',
          },
        });
      });
    };
    addStaticPool('node-shared', unifiedNodeFiles);
    addStaticPool('dom-shared', domFiles);
    for (let i = 0; i < isoPlans.length; i += 1) {
      weighted.push({
        weight: Math.max(1, weightFn(isoFiles[i])) + ISO_COLD_START_MS,
        plan: isoPlans[i],
      });
    }
    weighted.sort((a, b) => b.weight - a.weight || a.plan.label.localeCompare(b.plan.label));
    for (const entry of weighted) plans.push(entry.plan);

    scheduledPoolSummary =
      `node-shared=${unifiedNodeFiles.length}(pure=${schedule.pools.pure.length}+node=${schedule.pools['node-shared'].length}) ` +
      `dom-shared=${domFiles.length} ` +
      `isolated=${isoFiles.length}(${isoPlans.length})`;
  }

  console.error(
    `[test-suites] schedule (${classifyMs}ms, astCache=${schedule.cacheStats.hits}/${files.length}, timings=${timingHits}/${files.length}, budget=${workerBudget}): ` +
      `${scheduledPoolSummary} -> ${plans.length} shards total, at most ${workerBudget} concurrent`,
  );
} else {
  plans.push({
    kind: 'run-tests-fallback',
    label: 'single',
    args: [runTestsPath, '--skip-cache-hygiene', ...withDefaultTestConcurrency(extraArgs, workerBudget).concat(sortedAllFiles)],
    permits: workerBudget,
    timingOutputPath: null,
  });
}

// ---------------------------------------------------------------------------
// Unified single parent-death watchdog, timeout, signal forwarding & group drainage
// ---------------------------------------------------------------------------

const suiteStartMs = Date.now();
/** @type {Set<{ child: import('node:child_process').ChildProcess, isDirect: boolean, detached: boolean }>} */
const activeChildren = new Set();
/** @type {Set<number>} */
const drainingPgids = new Set();
let forcedExitCode = null;
let suiteTimer = null;
let graceTimer = null;
let lastResortTimer = null;
let groupWatchTimer = null;
let drainResolve = null;

// Single POSIX parent-death watchdog for the entire suite (replaces 50+ per-shard watchdogs).
// Tracks live detached child PGIDs via `+pid\n` / `-pid\n` / `ok\n` on stdin so if test-suites.mjs
// itself is SIGKILLed, every active shard process group is still terminated cleanly.
let watchdog = null;
if (!shardingDisabled && process.platform !== 'win32') {
  const watchdogEnv = { ...process.env };
  delete watchdogEnv.NODE_OPTIONS;
  const watchdogScript = `
    const pids = new Set();
    let ok = false;
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === 'ok') {
          ok = true;
          process.exit(0);
        } else if (line.startsWith('+')) {
          const p = Number(line.slice(1));
          if (Number.isInteger(p) && p > 0) pids.add(p);
        } else if (line.startsWith('-')) {
          const p = Number(line.slice(1));
          pids.delete(p);
        }
      }
    });
    process.stdin.on('end', () => {
      if (ok || pids.size === 0) process.exit(0);
      for (const pid of pids) {
        try { process.kill(-pid, 'SIGTERM'); } catch {}
      }
      setTimeout(() => {
        for (const pid of pids) {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        }
        process.exit(0);
      }, 1000);
    });
  `;
  watchdog = spawn(process.execPath, ['-e', watchdogScript], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: watchdogEnv,
    detached: true,
  });
  watchdog.on('error', () => {});
  watchdog.stdin?.on('error', () => {});
  watchdog.unref();
}

function watchdogWrite(line) {
  if (!watchdog?.stdin || watchdog.stdin.destroyed) return;
  try {
    watchdog.stdin.write(`${line}\n`);
  } catch {
    // Ignore closed pipes
  }
}

function disarmWatchdog() {
  if (!watchdog?.stdin || watchdog.stdin.destroyed) return;
  try {
    watchdog.stdin.end('ok\n');
  } catch {
    // Ignore closed pipes
  }
}

function groupAlive(pid) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function anyDrainingGroupAlive() {
  for (const pid of drainingPgids) {
    if (groupAlive(pid)) return true;
  }
  return false;
}

function clearSuiteTimers() {
  for (const t of [suiteTimer, graceTimer, lastResortTimer]) {
    if (t) clearTimeout(t);
  }
  if (groupWatchTimer) clearInterval(groupWatchTimer);
  suiteTimer = graceTimer = lastResortTimer = groupWatchTimer = null;
}

function cleanupRunTempDir() {
  if (existsSync(runTempDir)) {
    try {
      rmSync(runTempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of per-run manifest/timing scratch dir
    }
  }
}

function checkDrainComplete() {
  if (forcedExitCode === null) return;
  if (activeChildren.size > 0) return;
  if (process.platform !== 'win32' && anyDrainingGroupAlive()) return;
  clearSuiteTimers();
  if (drainResolve) {
    const fn = drainResolve;
    drainResolve = null;
    fn();
  }
}

function terminateAll(reason, exitCode, signal = 'SIGTERM') {
  if (forcedExitCode !== null) return;
  forcedExitCode = exitCode;
  if (suiteTimer) {
    clearTimeout(suiteTimer);
    suiteTimer = null;
  }
  console.error(`[test-suites] ${reason}; terminating ${activeChildren.size} active test shard(s)`);

  for (const entry of activeChildren) {
    const { child, isDirect } = entry;
    if (child.pid == null) continue;
    if (!isDirect) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // Ignore already exited child
        }
      }
      continue;
    }
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      tk.on('error', (err) => console.error('[test-suites] taskkill failed to start:', err.message));
    } else {
      drainingPgids.add(child.pid);
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Process group already gone
      }
    }
  }

  if (process.platform !== 'win32' && drainingPgids.size > 0) {
    graceTimer = setTimeout(() => {
      for (const pid of drainingPgids) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Process group drained
        }
      }
    }, KILL_GRACE_MS);
    graceTimer.unref?.();
    groupWatchTimer = setInterval(checkDrainComplete, GROUP_POLL_MS);
  }

  lastResortTimer = setTimeout(() => {
    console.error('[test-suites] shards did not drain after termination; forcing exit.');
    cleanupRunTempDir();
    disarmWatchdog();
    process.exit(forcedExitCode);
  }, LAST_RESORT_MS);
  lastResortTimer.unref?.();

  checkDrainComplete();
}

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => terminateAll(`received ${signal}`, SIGNAL_EXIT_CODES[signal] ?? 1, signal));
}

if (!shardingDisabled) {
  suiteTimer = setTimeout(() => {
    terminateAll(
      `suite total timeout (${timeoutMs}ms; tunable via HELMX_TEST_SUITE_TIMEOUT_MS); look for the last "[shard-worker] file i/N <path>" line above`,
      124,
      'SIGTERM',
    );
  }, timeoutMs);
  suiteTimer.unref?.();
}

/**
 * Schedule queued test plans under the concurrency permit cap, keeping active test
 * processes <= maxPermits at any moment and dynamically scaling shared IPC workers
 * onto freed permits when another pool finishes early.
 * @param {ExecPlan[]} initialPlans
 * @param {number} maxPermits
 * @returns {Promise<{ allPlans: ExecPlan[], exitCodes: number[] }>}
 */
function runPlanPool(initialPlans, maxPermits) {
  if (initialPlans.length === 0) return Promise.resolve({ allPlans: [], exitCodes: [] });
  const cap = Math.max(1, maxPermits);
  const allPlans = [...initialPlans];
  const results = new Array(initialPlans.length).fill(0);
  const pending = initialPlans.map((plan, index) => ({
    plan,
    index,
    cost: Math.max(1, Math.min(cap, plan.permits)),
  }));
  let available = cap;
  let running = 0;

  return new Promise((resolve) => {
    let resolved = false;
    const finishPool = () => {
      if (resolved) return;
      resolved = true;
      resolve({ allPlans, exitCodes: results });
    };

    const pickDynamicSharedPool = () => {
      let bestPool = null;
      let bestScore = 0;
      for (const poolName of /** @type {const} */ (['dom-shared', 'node-shared'])) {
        const q = ipcQueues[poolName];
        if (!q) continue;
        const remaining = q.files.length - q.cursor;
        const unbookedStart = q.cursor + q.bootingWorkers;
        const unbookedFiles = q.files.length - unbookedStart;
        if (remaining <= 0 || unbookedFiles < 1) continue;
        if (q.activeWorkers >= q.files.length) continue;
        let unbookedWeight = 0;
        for (let k = unbookedStart; k < q.files.length; k += 1) {
          unbookedWeight += Math.max(1, weightFn(q.files[k]));
        }
        if (unbookedWeight < DYNAMIC_SPAWN_MIN_WEIGHT_MS) continue;
        const score = unbookedWeight / Math.max(1, q.activeWorkers);
        if (score > bestScore) {
          bestScore = score;
          bestPool = poolName;
        }
      }
      return bestPool;
    };

    const spawnOne = (item) =>
      new Promise((done) => {
        const { plan } = item;
        const useIpc = Boolean(plan.ipcPool);
        const isDirect = plan.kind !== 'run-tests-fallback';
        const detached = isDirect && process.platform !== 'win32';
        const env =
          !isDirect
            ? process.env
            : plan.enableDomPreload
              ? domWorkerEnv
              : nodeWorkerEnv;

        const q = useIpc ? ipcQueues[plan.ipcPool] : null;
        let seenFirstNext = false;
        if (q) {
          q.activeWorkers += 1;
          q.bootingWorkers += 1;
        }

        const child = spawn(process.execPath, plan.args, {
          stdio: useIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
          env,
          cwd: repoRoot,
          detached,
        });
        const entry = { child, isDirect, detached };
        activeChildren.add(entry);
        const childPid = child.pid;
        if (detached && childPid != null) {
          watchdogWrite(`+${childPid}`);
        }

        if (useIpc && q) {
          child.on('message', (msg) => {
            if (!msg || msg.type !== 'next' || !child.connected) return;
            if (!seenFirstNext) {
              seenFirstNext = true;
              q.bootingWorkers = Math.max(0, q.bootingWorkers - 1);
            }
            if (forcedExitCode === null && q.cursor < q.files.length) {
              const file = q.files[q.cursor];
              q.cursor += 1;
              child.send({ type: 'run', file, index: q.cursor, total: q.files.length });
            } else {
              child.send({ type: 'done' });
            }
          });
        }

        let settled = false;
        const settle = (code) => {
          if (settled) return;
          settled = true;
          activeChildren.delete(entry);
          if (q) {
            if (!seenFirstNext) {
              seenFirstNext = true;
              q.bootingWorkers = Math.max(0, q.bootingWorkers - 1);
            }
            q.activeWorkers = Math.max(0, q.activeWorkers - 1);
          }
          if (detached && childPid != null && forcedExitCode === null) {
            watchdogWrite(`-${childPid}`);
          }
          done(code);
        };

        child.on('error', (err) => {
          console.error(`[test-suites] failed to start ${plan.label}: ${err.message}`);
          settle(1);
        });
        child.on('exit', (code, signal) => {
          if (code !== null) settle(code);
          else settle(SIGNAL_EXIT_CODES[signal] ?? 1);
        });
      });

    const launchItem = (item) => {
      available -= item.cost;
      running += 1;
      void spawnOne(item).then((code) => {
        results[item.index] = code;
        available += item.cost;
        running -= 1;
        pump();
      });
    };

    const pump = () => {
      if (forcedExitCode === null) {
        for (let i = 0; i < pending.length; ) {
          if (pending[i].cost <= available) {
            const [item] = pending.splice(i, 1);
            launchItem(item);
          } else {
            i += 1;
          }
        }
        // Once all initial/isolated shards are in flight, redeploy freed permits onto any
        // remaining shared IPC queue that still has meaningful unbooked queued work.
        while (ipcDynamicScale && pending.length === 0 && available > 0) {
          const poolName = pickDynamicSharedPool();
          if (!poolName) break;
          const q = ipcQueues[poolName];
          q.spawnedCount += 1;
          const dynPlan = createIpcWorkerPlan(poolName, `${poolName}-dyn${q.spawnedCount}`);
          const index = allPlans.length;
          allPlans.push(dynPlan);
          results.push(0);
          launchItem({ plan: dynPlan, index, cost: 1 });
        }
      }
      if (running === 0 && (forcedExitCode !== null || pending.length === 0)) {
        if (forcedExitCode !== null && process.platform !== 'win32' && anyDrainingGroupAlive()) {
          drainResolve = finishPool;
          checkDrainComplete();
        } else {
          finishPool();
        }
      }
    };

    pump();
  });
}

let exitCodes = [];
let executedPlans = plans;
try {
  const outcome = await runPlanPool(plans, workerBudget);
  executedPlans = outcome.allPlans;
  exitCodes = outcome.exitCodes;

  if (forcedExitCode === null && !shardingDisabled) {
    /** @type {Record<string, number>} */
    const observed = {};
    for (let i = 0; i < executedPlans.length; i += 1) {
      if (exitCodes[i] !== 0) continue;
      const outPath = executedPlans[i].timingOutputPath;
      if (!outPath || !existsSync(outPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
        const fileMap = parsed?.files;
        if (fileMap && typeof fileMap === 'object') {
          for (const [rawPath, dur] of Object.entries(fileMap)) {
            if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) {
              observed[normalizeTimingKey(repoRoot, rawPath)] = dur;
            }
          }
        }
      } catch {
        // Ignore malformed per-shard timing output
      }
    }
    if (Object.keys(observed).length > 0) {
      const updated = pruneStaleTestTimings(mergeTestTimings(timingsStore, observed), repoRoot);
      saveTestTimings(timingsCachePath, updated);
    }
  }
} finally {
  clearSuiteTimers();
  disarmWatchdog();
  cleanupRunTempDir();
}

const elapsed = ((Date.now() - suiteStartMs) / 1000).toFixed(1);
let finalCode = 0;
if (forcedExitCode !== null) {
  finalCode = forcedExitCode;
} else {
  const firstFailure = exitCodes.find((c) => c !== 0);
  if (firstFailure !== undefined) finalCode = firstFailure;
}
console.error(`[test-suites] suite ${label} finished in ${elapsed}s, exit code ${finalCode}`);
process.exitCode = finalCode;
