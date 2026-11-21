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
 *   unit        = protocol + env-io + test-kit + cli + web + plugin-client (env-io is in-process
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
 * partitions files into 4 pools (`pure`, `dom-shared`, `node-shared`, `isolated`), balanced
 * by auto-recorded millisecond timings (`scripts/lib/test-timings.mjs`) via LPT into
 * `permits: 1` shards launched concurrently across `workerBudget` (default 16, capped by
 * available CPUs; override via `TEST_CONCURRENCY`) with zero serial pure barrier.
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
  saveTestTimings,
} from './lib/test-timings.mjs';
import {
  explicitTestConcurrency,
  resolveTestConcurrency,
  withDefaultTestConcurrency,
} from './lib/test-concurrency.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// Suite -> package names or packages/-relative paths. Split principles live in the header comment;
// tier changes must be mirrored in AGENTS.md's test tiering conventions and PACKAGE_TIERS in
// scripts/lib/workspace-meta.mjs.
const SUITES = {
  unit: ['protocol', 'env-io', 'test-kit', 'cli', 'web', 'plugin-client'],
  integration: ['plugin-build', 'kernel', 'plugins', 'hub', 'node', 'payload', 'cli/test/launcher', 'env-io/test/update'],
};
const ALL_PACKAGES = [...SUITES.unit, ...SUITES.integration];

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

// A package entry ('cli') reads that package's top-level test/ files; a path entry
// ('cli/test/launcher', packages/-relative) reads the subdirectory it names. Both return
// repo-root-relative file paths.
function testFilesOf(entry) {
  const relDir = entry.includes('/') ? entry : path.join(entry, 'test');
  const dir = path.join(packagesDir, relDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[test-suites] cannot read ${dir}: ${err.message} (package missing or not installed?)`);
    process.exit(2);
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => path.join('packages', relDir, e.name))
    .sort();
}

const suiteName = process.argv[2];
if (!SUITES[suiteName] && suiteName !== 'all') {
  console.error(`[test-suites] usage: node scripts/test-suites.mjs <unit|integration|all> [extra args...]`);
  process.exit(2);
}
const rawExtraArgs = process.argv.slice(3);
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs;

let files;
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

const label = suiteName === 'all' ? 'all(unit+integration)' : suiteName;
const breakdown = ALL_PACKAGES.map((p) => `${p}=${testFilesOf(p).length}`).join(' ');
console.error(`[test-suites] suite ${label}: ${files.length} file(s) (${breakdown})`);

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
const shardingDisabled = shouldDisableSharding(extraArgs) || workerBudgetOverride !== undefined;

const timingsCachePath = path.join(repoRoot, DEFAULT_TIMINGS_CACHE_REL);
const purityCachePath = path.join(repoRoot, DEFAULT_PURITY_CACHE_REL);
const timingsStore = loadTestTimings(timingsCachePath);
const { weightFn, recordedCount } = createTestWeightFn({ repoRoot, timings: timingsStore });

const sortedAllFiles = [...files].sort((a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b));

const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
let cachedTs = null;
const getTs = () => {
  if (!cachedTs) cachedTs = requireFromRoot('typescript');
  return cachedTs;
};

const timingReporterUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'timing-reporter.mjs')).href;
const runTempDir = path.join(
  repoRoot,
  'node_modules',
  '.cache',
  'helmx-test-runs',
  `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

/** @type {Array<{ label: string, args: string[], permits: number, timingOutputPath: string | null }>} */
const plans = [];

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
  console.error(
    `[test-suites] schedule (${classifyMs}ms, astCache=${schedule.cacheStats.hits}/${files.length}, timings=${timingHits}/${files.length}, budget=${workerBudget}): ` +
      `pure=${schedule.pools.pure.length}(${schedule.shardCounts.pure}) ` +
      `dom-shared=${schedule.pools['dom-shared'].length}(${schedule.shardCounts['dom-shared']}) ` +
      `node-shared=${schedule.pools['node-shared'].length}(${schedule.shardCounts['node-shared']}) ` +
      `isolated=${schedule.pools.isolated.length}(${schedule.shardCounts.isolated}) -> ${schedule.plans.length} concurrent shards`,
  );

  mkdirSync(runTempDir, { recursive: true });
  schedule.plans.forEach((plan, index) => {
    const timingOutputPath = path.join(runTempDir, `timings-${index}.json`);
    if (plan.mode === 'shard-worker') {
      const manifestPath = path.join(runTempDir, `manifest-${index}.json`);
      writeFileSync(
        manifestPath,
        JSON.stringify({
          pool: plan.pool,
          repoRoot,
          files: plan.files,
          timingOutputPath,
          testTimeoutMs: 20_000,
        }),
        'utf8',
      );
      const args = [];
      if (plan.pool === 'dom-shared') args.push('--dom-preload');
      args.push('--shard-worker', manifestPath);
      plans.push({
        label: plan.label,
        args,
        permits: plan.permits,
        timingOutputPath,
      });
    } else {
      // Isolated shards use native process isolation with dual reporters so spec stays
      // on stdout while per-file durations land in timingOutputPath.
      const args = [
        '--test-concurrency=1',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        `--test-reporter=${timingReporterUrl}`,
        `--test-reporter-destination=${timingOutputPath}`,
        ...extraArgs,
        ...plan.files,
      ];
      plans.push({
        label: plan.label,
        args,
        permits: plan.permits,
        timingOutputPath,
      });
    }
  });
} else {
  plans.push({
    label: 'single',
    args: withDefaultTestConcurrency(extraArgs, workerBudget).concat(sortedAllFiles),
    permits: workerBudget,
    timingOutputPath: null,
  });
}

// Reuse run-tests.mjs: cross-platform tsx spawn, per-test/total timeouts, and process-tree
// cleanup all live there. All 4 pools run concurrently under the permit cap with zero serial barrier.
const runTestsPath = path.join(repoRoot, 'scripts', 'run-tests.mjs');
const suiteStartMs = Date.now();
/** @type {Set<import('node:child_process').ChildProcess>} */
const activeChildren = new Set();
let receivedSignal = null;

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!receivedSignal) receivedSignal = signal;
    for (const child of activeChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  });
}

/**
 * Schedule queued test plans under the concurrency permit cap, keeping active test
 * processes <= maxPermits at any moment.
 * @param {Array<{ label: string, args: string[], permits: number, timingOutputPath: string | null }>} queue
 * @param {number} maxPermits
 * @returns {Promise<number[]>}
 */
function runPlanPool(queue, maxPermits) {
  if (queue.length === 0) return Promise.resolve([]);
  const cap = Math.max(1, maxPermits);
  const results = new Array(queue.length).fill(0);
  const pending = queue.map((plan, index) => ({
    plan,
    index,
    cost: Math.max(1, Math.min(cap, plan.permits)),
  }));
  let available = cap;
  let running = 0;

  return new Promise((resolve) => {
    const spawnOne = (item) =>
      new Promise((done) => {
        const child = spawn(process.execPath, [runTestsPath, ...item.plan.args], {
          stdio: 'inherit',
          env: process.env,
          cwd: repoRoot,
        });
        activeChildren.add(child);
        child.on('error', (err) => {
          activeChildren.delete(child);
          console.error(`[test-suites] failed to start ${item.plan.label}: ${err.message}`);
          done(1);
        });
        child.on('exit', (code, signal) => {
          activeChildren.delete(child);
          if (code !== null) done(code);
          else done(SIGNAL_EXIT_CODES[signal] ?? 1);
        });
      });

    const pump = () => {
      if (!receivedSignal) {
        for (let i = 0; i < pending.length; ) {
          if (pending[i].cost <= available) {
            const [item] = pending.splice(i, 1);
            available -= item.cost;
            running += 1;
            void spawnOne(item).then((code) => {
              results[item.index] = code;
              available += item.cost;
              running -= 1;
              pump();
            });
          } else {
            i += 1;
          }
        }
      }
      if (running === 0 && (receivedSignal || pending.length === 0)) {
        resolve(results);
      }
    };

    pump();
  });
}

let exitCodes = [];
try {
  exitCodes = await runPlanPool(plans, workerBudget);

  if (!receivedSignal && !shardingDisabled) {
    /** @type {Record<string, number>} */
    const observed = {};
    for (let i = 0; i < plans.length; i += 1) {
      if (exitCodes[i] !== 0) continue;
      const outPath = plans[i].timingOutputPath;
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
      const updated = mergeTestTimings(timingsStore, observed);
      saveTestTimings(timingsCachePath, updated);
    }
  }
} finally {
  if (existsSync(runTempDir)) {
    try {
      rmSync(runTempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of per-run manifest/timing scratch dir
    }
  }
}

const elapsed = ((Date.now() - suiteStartMs) / 1000).toFixed(1);
let finalCode = 0;
if (receivedSignal) {
  finalCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
} else {
  const firstFailure = exitCodes.find((c) => c !== 0);
  if (firstFailure !== undefined) finalCode = firstFailure;
}
console.error(`[test-suites] suite ${label} finished in ${elapsed}s, exit code ${finalCode}`);
process.exitCode = finalCode;
