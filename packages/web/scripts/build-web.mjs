#!/usr/bin/env node
/**
 * Deterministic incremental build wrapper for @helmx/web (`vite build`).
 *
 * Why: `packages/web` is built as part of `pnpm build` and `pnpm test:all` / `test:integration`.
 * Vite always re-bundles from scratch (~4.5s) even when zero inputs changed. This wrapper hashes
 * every real build input (web src/public/index.html/vite.config/package.json/tsconfig.json,
 * workspace browser inputs protocol/src, ui/src & plugin-client/src, pnpm-lock.yaml, VITE_* build env,
 * and this script) and verifies dist/index.html + every referenced asset + every previously
 * emitted dist file exists with matching byte size. Any input change, missing output, `--force`,
 * or `HELMX_CLEAN_DIST=1` runs a full `vite build`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectFilesSorted,
  hashDirectoryInto,
  hashFileInto,
  isRealDirectory,
  isRegularFile,
} from '../../../scripts/lib/fs-hash.mjs';

const SCHEMA_VERSION = 1;
/** Dependency, VCS and nested dist directories are never web build inputs or outputs (pruned at every depth). */
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist']);
const TREE_OPTIONS = { ignoredDirNames: IGNORED_DIR_NAMES };

const defaultPkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepoRoot = resolve(defaultPkgRoot, '../..');

/**
 * Computes a deterministic SHA-256 fingerprint across every input that can affect `vite build`
 * for `@helmx/web`.
 */
export function computeWebBuildFingerprint(options = {}) {
  const pkgRoot = resolve(options.pkgRoot ?? defaultPkgRoot);
  const repoRoot = resolve(options.repoRoot ?? resolve(pkgRoot, '../..'));
  const env = options.env ?? process.env;
  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url);

  const hash = createHash('sha256');
  hash.update(`web-build-schema:${SCHEMA_VERSION}\0`);

  hashDirectoryInto(hash, 'web/src', join(pkgRoot, 'src'), TREE_OPTIONS);
  hashDirectoryInto(hash, 'web/public', join(pkgRoot, 'public'), TREE_OPTIONS);
  hashFileInto(hash, 'web/index.html', join(pkgRoot, 'index.html'));
  hashFileInto(hash, 'web/vite.config.ts', join(pkgRoot, 'vite.config.ts'));
  hashFileInto(hash, 'web/package.json', join(pkgRoot, 'package.json'));
  hashFileInto(hash, 'web/tsconfig.json', join(pkgRoot, 'tsconfig.json'));
  hashFileInto(hash, 'web/scripts/build-web.mjs', scriptPath);

  hashDirectoryInto(hash, 'protocol/src', join(repoRoot, 'packages/protocol/src'), TREE_OPTIONS);
  hashFileInto(hash, 'protocol/package.json', join(repoRoot, 'packages/protocol/package.json'));
  hashDirectoryInto(hash, 'ui/src', join(repoRoot, 'packages/ui/src'), TREE_OPTIONS);
  hashFileInto(hash, 'ui/package.json', join(repoRoot, 'packages/ui/package.json'));
  hashDirectoryInto(hash, 'plugin-client/src', join(repoRoot, 'packages/plugin-client/src'), TREE_OPTIONS);
  hashFileInto(hash, 'plugin-client/package.json', join(repoRoot, 'packages/plugin-client/package.json'));
  hashFileInto(hash, 'pnpm-lock.yaml', join(repoRoot, 'pnpm-lock.yaml'));

  // Vite inlines import.meta.env.VITE_* into production builds; VITE_HOST only affects dev server.
  const viteEnvEntries = Object.entries(env)
    .filter(([key, val]) => key.startsWith('VITE_') && key !== 'VITE_HOST' && typeof val === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  hash.update(`vite-env:${viteEnvEntries.length}\0`);
  for (const [key, val] of viteEnvEntries) {
    hash.update(`${key}=${val}\0`);
  }

  return hash.digest('hex');
}

/**
 * Extracts local asset paths referenced via `src="..."` or `href="..."` in built `dist/index.html`.
 * Returns normalized dist-relative POSIX paths (or marks invalid traversal paths as invalid).
 */
export function extractIndexAssetPaths(indexHtml) {
  const assets = new Set();
  const attrPattern = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let match;
  while ((match = attrPattern.exec(indexHtml)) !== null) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (!raw) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
    const stripped = raw.split(/[?#]/, 1)[0] ?? '';
    if (!stripped) continue;
    const normalized = stripped.replace(/^\/+/, '');
    if (!normalized) continue;
    assets.add(normalized);
  }
  return [...assets].sort();
}

function isSafeRelativeAsset(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (relPath.startsWith('/') || relPath.includes('\\')) return false;
  const parts = relPath.split('/');
  return parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/** Collects every regular file inside `distDir` as sorted `{ path, size }` entries. */
function snapshotDistOutputs(distDir) {
  const files = collectFilesSorted(distDir, TREE_OPTIONS);
  return files.map((rel) => ({
    path: rel,
    size: statSync(join(distDir, rel)).size,
  }));
}

/**
 * Verifies `dist/index.html`, every local asset referenced by `dist/index.html`, every file in
 * `public/`, and every recorded output entry exist on disk with matching byte size.
 */
export function verifyWebDistOutputs(distDir, options = {}) {
  const indexPath = join(distDir, 'index.html');
  if (!isRegularFile(indexPath)) {
    return { ok: false, reason: 'missing dist/index.html' };
  }

  const indexHtml = readFileSync(indexPath, 'utf8');
  const referencedAssets = extractIndexAssetPaths(indexHtml);
  for (const rel of referencedAssets) {
    if (!isSafeRelativeAsset(rel)) {
      return { ok: false, reason: `unsafe asset path in dist/index.html: ${rel}` };
    }
    if (!isRegularFile(join(distDir, rel))) {
      return { ok: false, reason: `missing asset referenced by dist/index.html: ${rel}` };
    }
  }

  if (options.publicDir && isRealDirectory(options.publicDir)) {
    for (const rel of collectFilesSorted(options.publicDir, TREE_OPTIONS)) {
      if (!isRegularFile(join(distDir, rel))) {
        return { ok: false, reason: `missing public asset in dist: ${rel}` };
      }
    }
  }

  if (Array.isArray(options.expectedOutputs)) {
    if (options.expectedOutputs.length === 0) {
      return { ok: false, reason: 'empty cached output manifest' };
    }
    for (const item of options.expectedOutputs) {
      if (!item || typeof item.path !== 'string' || typeof item.size !== 'number' || !isSafeRelativeAsset(item.path)) {
        return { ok: false, reason: 'invalid cached output manifest entry' };
      }
      const abs = join(distDir, item.path);
      if (!isRegularFile(abs)) {
        return { ok: false, reason: `missing output file: ${item.path}` };
      }
      if (statSync(abs).size !== item.size) {
        return { ok: false, reason: `size mismatch for output file: ${item.path}` };
      }
    }
  }

  return { ok: true, referencedAssets };
}

function readCacheRecord(cacheFile) {
  if (!isRegularFile(cacheFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0) return null;
    if (!Array.isArray(parsed.outputs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCacheRecordAtomic(cacheFile, record) {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmpFile, cacheFile);
}

/**
 * Runs `@helmx/web` build with deterministic fingerprint skipping.
 */
export async function runWebBuild(options = {}) {
  const pkgRoot = resolve(options.pkgRoot ?? defaultPkgRoot);
  const repoRoot = resolve(options.repoRoot ?? resolve(pkgRoot, '../..'));
  const distDir = resolve(options.distDir ?? join(pkgRoot, 'dist'));
  const publicDir = join(pkgRoot, 'public');
  const cacheFile = resolve(
    options.cacheFile ?? join(repoRoot, 'node_modules', '.cache', 'helmx-build', 'web-build-fingerprint.json'),
  );
  const env = options.env ?? process.env;
  const argv = options.argv ?? [];
  const force = options.force === true || argv.includes('--force') || argv.includes('-f') || env.HELMX_CLEAN_DIST === '1';
  const quiet = options.quiet === true;

  const fingerprint = computeWebBuildFingerprint({ pkgRoot, repoRoot, env });

  if (!force) {
    const cached = readCacheRecord(cacheFile);
    if (cached && cached.fingerprint === fingerprint) {
      const check = verifyWebDistOutputs(distDir, {
        publicDir,
        expectedOutputs: cached.outputs,
      });
      if (check.ok) {
        if (!quiet) {
          console.log(
            `[web] build up-to-date (${fingerprint.slice(0, 12)}, ${cached.outputs.length} files verified), skipping vite build`,
          );
        }
        return {
          status: 'cached',
          fingerprint,
          outputCount: cached.outputs.length,
        };
      }
    }
  } else {
    rmSync(cacheFile, { force: true });
    rmSync(distDir, { recursive: true, force: true });
  }

  const runVite =
    options.runVite ??
    (async () => {
      const { build } = await import('vite');
      await build({
        root: pkgRoot,
        configFile: join(pkgRoot, 'vite.config.ts'),
      });
    });

  try {
    await runVite();
  } catch (err) {
    rmSync(cacheFile, { force: true });
    throw err;
  }

  const postCheck = verifyWebDistOutputs(distDir, { publicDir });
  if (!postCheck.ok) {
    rmSync(cacheFile, { force: true });
    throw new Error(`[web] vite build produced incomplete dist output: ${postCheck.reason}`);
  }

  const outputs = snapshotDistOutputs(distDir);
  writeCacheRecordAtomic(cacheFile, {
    schemaVersion: SCHEMA_VERSION,
    fingerprint,
    outputs,
  });

  if (!quiet) {
    console.log(
      `[web] built dist (${fingerprint.slice(0, 12)}, ${outputs.length} files${force ? ', forced' : ''})`,
    );
  }

  return {
    status: 'built',
    fingerprint,
    outputCount: outputs.length,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    await runWebBuild({ argv: process.argv.slice(2) });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
