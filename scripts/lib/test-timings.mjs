/**
 * Auto-recorded per-file test duration cache and unified-ms LPT weight calculator.
 *
 * Why it exists: hand-maintained slow-test prefix lists inevitably drift as tests grow or get
 * split (e.g. `swarm.integration.test.ts` or `overview.test.ts` landing late and stranding 15
 * idle cores at the tail). Recording real per-file durations into
 * `node_modules/.cache/helmx-test-timings.json` after each run gives LPT bin-packing accurate
 * millisecond weights automatically while keeping cold runs well-balanced on the same ms scale.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_TIMINGS_SCHEMA_VERSION = 1;
export const DEFAULT_TIMINGS_CACHE_REL = path.join('node_modules', '.cache', 'helmx-test-timings.json');

// Fallback heuristics (expressed in estimated milliseconds so cold/new files mix seamlessly
// on the exact same unit scale as auto-recorded durations).
export const ULTRA_SLOW_TEST_PREFIXES = [
  'swarm',
  'overview',
  'payload',
  'node-path-usage-rpc',
  'workflow.test',
  'workflow-goal',
  'workflow-metadata',
  'core.integration',
  'worktree-runtime',
  'runtime.test.ts',
  'plugins-contract.test.ts',
  'background-restart',
  'native-worktree',
  'node-upgrade',
  'agent-standby',
  'check-changed',
  'quiet-notifier',
  'use-version-watcher',
  'cli.test.ts',
  'build-runner',
  'conversation-outline',
  'skill-center',
];

export const SLOW_TEST_PREFIXES = [
  'cli-nodes-env',
  'cli-credentials',
  'cli-dynamic-actions',
  'cli-plugin-dx',
  'node-cli-review',
  'node-rpc-review',
  'node-forward-http',
  'node-daemon.test.ts',
  'ownership-events.test.ts',
  'plugin-client.test.ts',
  'plugin-client-runtime',
  'icons.test.ts',
  'sidebar-spaces',
  'composer-thinking-badge',
  'conversation-archive-menu',
  'helmx-store',
  'tool-activity',
  'ask-dock',
  'select.test.ts',
  'thinking-',
  'workflow',
  'updater',
  'supervisor',
  'env-app',
  'app-workflow',
  'external-plugin',
  'subagent-depth',
  'tracker-cleanup',
  'secret-lifecycle',
  'sse-',
  'unread-visibility',
  'timeline-outline-calibration',
  'markdown-codeblock-plugins',
  'node-tunnel',
  'tools.test.ts',
  'worktree-process-usage',
  'restart-graceful-recovery',
  'plugin-dx-loop',
  'token-speed.integration',
  'profile-collaboration',
  'memory-dream',
  'test-kit.test.ts',
];

function matchesPrefix(base, list) {
  return list.some((p) => base.startsWith(p) || base === p);
}

/** Normalize a file path to forward-slash repo-root-relative form. */
export function normalizeTimingKey(repoRoot, filePath) {
  const rel = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  return rel.split(path.sep).join('/');
}

/** Create an empty timing store. */
export function emptyTestTimingsStore() {
  return { schemaVersion: TEST_TIMINGS_SCHEMA_VERSION, files: {} };
}

/**
 * Load persisted per-file timing store from disk; returns an empty store when missing or corrupt.
 * @param {string} cachePath
 * @returns {{ schemaVersion: number, files: Record<string, { durationMs: number, runs: number, updatedAt: number }> }}
 */
export function loadTestTimings(cachePath) {
  if (!existsSync(cachePath)) return emptyTestTimingsStore();
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== TEST_TIMINGS_SCHEMA_VERSION) {
      return emptyTestTimingsStore();
    }
    const rawFiles = parsed.files;
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
      return emptyTestTimingsStore();
    }
    /** @type {Record<string, { durationMs: number, runs: number, updatedAt: number }>} */
    const files = {};
    for (const [key, entry] of Object.entries(rawFiles)) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.durationMs === 'number' &&
        Number.isFinite(entry.durationMs) &&
        entry.durationMs > 0
      ) {
        files[key] = {
          durationMs: Math.max(1, Math.round(entry.durationMs)),
          runs: typeof entry.runs === 'number' && Number.isInteger(entry.runs) && entry.runs > 0 ? entry.runs : 1,
          updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        };
      }
    }
    return { schemaVersion: TEST_TIMINGS_SCHEMA_VERSION, files };
  } catch {
    return emptyTestTimingsStore();
  }
}

/**
 * Merge newly observed per-file durations (ms) into a timing store using an exponential moving average.
 * @param {{ schemaVersion: number, files: Record<string, { durationMs: number, runs: number, updatedAt: number }> }} store
 * @param {Record<string, number> | Map<string, number>} observed
 * @param {{ alpha?: number, now?: number }} [options]
 */
export function mergeTestTimings(store, observed, options = {}) {
  const alpha = options.alpha ?? 0.65;
  const now = options.now ?? Date.now();
  const nextFiles = { ...store.files };
  const entries = observed instanceof Map ? [...observed.entries()] : Object.entries(observed);

  for (const [key, rawMs] of entries) {
    if (typeof rawMs !== 'number' || !Number.isFinite(rawMs) || rawMs <= 0) continue;
    const sample = Math.max(1, Math.round(rawMs));
    const prev = nextFiles[key];
    if (prev && typeof prev.durationMs === 'number' && prev.durationMs > 0) {
      const smoothed = Math.max(1, Math.round(prev.durationMs * (1 - alpha) + sample * alpha));
      nextFiles[key] = {
        durationMs: smoothed,
        runs: prev.runs + 1,
        updatedAt: now,
      };
    } else {
      nextFiles[key] = {
        durationMs: sample,
        runs: 1,
        updatedAt: now,
      };
    }
  }

  return {
    schemaVersion: TEST_TIMINGS_SCHEMA_VERSION,
    files: nextFiles,
  };
}

/**
 * Atomically persist the timing store to disk. Best-effort: never throws on IO errors.
 * @param {string} cachePath
 * @param {{ schemaVersion: number, files: Record<string, { durationMs: number, runs: number, updatedAt: number }> }} store
 * @returns {boolean}
 */
export function saveTestTimings(cachePath, store) {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), 'utf8');
    renameSync(tmp, cachePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Estimate a cold-start millisecond weight for an unrecorded test file using filename tier + byte size.
 * @param {string} repoRoot
 * @param {string} relPath
 * @returns {number}
 */
export function estimateFallbackDurationMs(repoRoot, relPath) {
  const base = path.basename(relPath);
  let size = 0;
  try {
    size = statSync(path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath)).size;
  } catch {
    size = 0;
  }
  if (matchesPrefix(base, ULTRA_SLOW_TEST_PREFIXES)) {
    return Math.round(15_000 + size / 4);
  }
  if (matchesPrefix(base, SLOW_TEST_PREFIXES)) {
    return Math.round(3_500 + size / 8);
  }
  return Math.max(50, Math.round(size / 20));
}

/**
 * Build a unified-ms LPT weight function backed by recorded timings with cold-start fallback.
 * @param {{ repoRoot: string, timings: { schemaVersion: number, files: Record<string, { durationMs: number, runs: number, updatedAt: number }> } }} input
 * @returns {{ weightFn: (relPath: string) => number, recordedCount: (files: string[]) => number }}
 */
export function createTestWeightFn({ repoRoot, timings }) {
  const memo = new Map();
  const weightFn = (relPath) => {
    const key = normalizeTimingKey(repoRoot, relPath);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const recorded = timings?.files?.[key]?.durationMs;
    const weight =
      typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0
        ? recorded
        : estimateFallbackDurationMs(repoRoot, relPath);
    memo.set(key, weight);
    return weight;
  };
  const recordedCount = (files) =>
    files.reduce((n, relPath) => {
      const key = normalizeTimingKey(repoRoot, relPath);
      return n + (timings?.files?.[key]?.durationMs ? 1 : 0);
    }, 0);
  return { weightFn, recordedCount };
}
