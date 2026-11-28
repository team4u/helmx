/**
 * Client compiler cache layer:
 * - bounded LRU in-memory mtime/size fast cache + disk `deps.json` sha256 revalidation;
 * - lazy async-chunk reader (`readCachedChunk`) and atomic artifact persistence with stale-hash pruning;
 * - workspace built-in shared cache directory discovery (`resolveProviderCacheDir`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  HelmxError,
  isBuiltinNamespace,
  isJsonObject,
  type PluginClientBundle,
  type PluginClientNpmRoot,
} from '@helmx/protocol';
import { atomicWriteFileSync } from '@helmx/env-io';
import { isInside, realpathOrNull, safeFileName, sha256 } from './client-paths.js';

/**
 * Dependency manifest (`deps.json`) schema version:
 * v3: native esbuild CSS bundling; v4: controlled npm dependencies; v5: minify + pre-gzip;
 * v6: code splitting + async chunk bridge; v7: isolated `__helmx_chunk_share` namespace bridge;
 * v8: controlled npm declaration set recorded in cache credentials;
 * v9: mtime/size stat fast-path on `npmDependencies` outside the 2s filesystem race window;
 * v10: add `@helmx/ui` shared external virtualization (`globalThis.__helmx_shared_ui`).
 * v11: add PopoverHeader, PopoverItem, useListKeyboardNav, MasterDetail, BatchBar to `UI_SHARED_EXPORTS`.
 */
export const DEPS_LIST_VERSION = 11;
const MAX_MEMORY_COMPILED_CACHE = 128;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{16,64}$/i;

/** Disk dependency manifest (`deps.json`) used to revalidate cache entries across restarts. */
export interface DepsListFile {
  version: typeof DEPS_LIST_VERSION;
  module: string;
  /** Canonical `clientRoot` realpath (invalidates stale cache if moved/re-rooted). */
  root: string;
  contentHash: string;
  /** Local dependencies relative to `root` with content sha256 (includes entry). */
  dependencies: Array<{ path: string; sha256: string }>;
  /** Controlled npm dependency files with absolute realpath, content sha256, and stat fingerprint. */
  npmDependencies?: Array<{ root: string; path: string; sha256: string; mtimeMs?: number; size?: number }>;
  /** Declared controlled npm specifiers (prevents reusing stale bundles after removing declarations). */
  npmSpecifiers?: string[];
  /** Entry named exports (including `__helmxClientCss` when CSS was bundled). */
  exports?: string[];
  /** Async/shared chunk filenames emitted alongside the entry. */
  chunks?: string[];
}

export interface CachedDiskHit {
  result: PluginClientBundle;
  list: DepsListFile;
}

interface MemoryCompiledEntry {
  result: PluginClientBundle;
  localMtimes: Map<string, number>;
  npmStats?: Map<string, { mtimeMs: number; size: number }>;
  root: string;
}

const memoryCompiledCache = new Map<string, MemoryCompiledEntry>();

function isAbsentFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isSafeChunkName(chunkName: unknown): chunkName is string {
  return (
    typeof chunkName === 'string' &&
    chunkName.length > 0 &&
    chunkName !== '.' &&
    chunkName !== '..' &&
    !chunkName.includes('/') &&
    !chunkName.includes('\\') &&
    !chunkName.includes('..') &&
    !chunkName.includes('\0')
  );
}

function isValidStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function clearClientCompilerMemoryCache(): void {
  memoryCompiledCache.clear();
}

export function npmRootsKey(roots: ReadonlyArray<PluginClientNpmRoot>): string {
  return roots
    .map((root) => `${root.packageRoot}:${[...root.specifiers].sort().join(',')}`)
    .sort()
    .join(';');
}

export function npmSpecifiersKey(roots: ReadonlyArray<PluginClientNpmRoot>): string[] {
  return roots.flatMap((root) => root.specifiers.map((specifier) => `${root.packageRoot}\0${specifier}`)).sort();
}

/** Checks the in-memory mtime/size snapshot; evicts stale entries and returns `undefined` on miss. */
export function lookupMemoryCache(memKey: string, rootReal: string): PluginClientBundle | undefined {
  const memEntry = memoryCompiledCache.get(memKey);
  if (!memEntry || memEntry.root !== rootReal) return undefined;
  for (const [abs, mtime] of memEntry.localMtimes) {
    try {
      if (statSync(abs).mtimeMs !== mtime) {
        memoryCompiledCache.delete(memKey);
        return undefined;
      }
    } catch (err) {
      memoryCompiledCache.delete(memKey);
      if (isAbsentFsError(err)) return undefined;
      throw err;
    }
  }
  if (memEntry.npmStats) {
    for (const [depPath, st] of memEntry.npmStats) {
      try {
        const cur = statSync(depPath);
        if (cur.mtimeMs !== st.mtimeMs || cur.size !== st.size) {
          memoryCompiledCache.delete(memKey);
          return undefined;
        }
      } catch (err) {
        memoryCompiledCache.delete(memKey);
        if (isAbsentFsError(err)) return undefined;
        throw err;
      }
    }
  }
  // Touch LRU position on hit.
  memoryCompiledCache.delete(memKey);
  memoryCompiledCache.set(memKey, memEntry);
  return memEntry.result;
}

export function recordMemoryCache(
  memKey: string,
  rootReal: string,
  list: DepsListFile,
  result: PluginClientBundle,
): void {
  const localMtimes = new Map<string, number>();
  for (const dep of list.dependencies) {
    const abs = join(rootReal, dep.path);
    try {
      localMtimes.set(abs, statSync(abs).mtimeMs);
    } catch (err) {
      if (isAbsentFsError(err)) return;
      throw err;
    }
  }
  const npmStats = new Map<string, { mtimeMs: number; size: number }>();
  for (const dep of list.npmDependencies ?? []) {
    try {
      const st = statSync(dep.path);
      npmStats.set(dep.path, { mtimeMs: st.mtimeMs, size: st.size });
    } catch (err) {
      if (isAbsentFsError(err)) return;
      throw err;
    }
  }
  if (memoryCompiledCache.has(memKey)) {
    memoryCompiledCache.delete(memKey);
  }
  while (memoryCompiledCache.size >= MAX_MEMORY_COMPILED_CACHE) {
    const oldest = memoryCompiledCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCompiledCache.delete(oldest);
  }
  memoryCompiledCache.set(memKey, {
    result,
    localMtimes,
    ...(npmStats.size > 0 ? { npmStats } : {}),
    root: rootReal,
  });
}

function readOptionalGzip(gzPath: string): Uint8Array | undefined {
  try {
    return readFileSync(gzPath);
  } catch (err) {
    if (isAbsentFsError(err)) return undefined;
    throw err;
  }
}

/** Reads a cached async/shared chunk and its optional `.gz` bytes from `stagingDir`. */
export function readCachedChunk(
  stagingDir: string,
  baseName: string,
  contentHash: string,
  chunkName: string,
): { code: string; gzipped?: Uint8Array } | undefined {
  if (!CONTENT_HASH_PATTERN.test(contentHash) || !isSafeChunkName(chunkName)) return undefined;
  const chunkPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}`);
  if (!isInside(resolve(stagingDir), resolve(chunkPath))) return undefined;
  try {
    const code = readFileSync(chunkPath, 'utf8');
    const gzipped = readOptionalGzip(join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}.gz`));
    return { code, gzipped };
  } catch (err) {
    if (isAbsentFsError(err)) return undefined;
    throw err;
  }
}

function readDepsListOrMiss(depsListPath: string): DepsListFile | undefined {
  let rawText: string;
  try {
    rawText = readFileSync(depsListPath, 'utf8');
  } catch (err) {
    if (isAbsentFsError(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  if (!isJsonObject(parsed)) return undefined;
  return parsed as unknown as DepsListFile;
}

function readTextIfPresent(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isAbsentFsError(err)) return undefined;
    throw err;
  }
}

/**
 * Header/shape validation of a `deps.json` against the current request; any mismatch is an ordinary
 * stale-cache condition (rebuild), never an error: version bumps, moved roots, a changed npm
 * specifier set and malformed optional fields all simply miss.
 */
function isDepsListStale(
  list: DepsListFile,
  moduleRef: string,
  rootReal: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot>,
): boolean {
  return (
    list.version !== DEPS_LIST_VERSION ||
    list.module !== moduleRef ||
    list.root !== rootReal ||
    typeof list.contentHash !== 'string' ||
    !CONTENT_HASH_PATTERN.test(list.contentHash) ||
    !Array.isArray(list.dependencies) ||
    (list.npmSpecifiers !== undefined && !isValidStringArray(list.npmSpecifiers)) ||
    (list.npmDependencies !== undefined && !Array.isArray(list.npmDependencies)) ||
    (list.exports !== undefined && !isValidStringArray(list.exports)) ||
    (list.chunks !== undefined && (!Array.isArray(list.chunks) || !list.chunks.every(isSafeChunkName))) ||
    JSON.stringify(list.npmSpecifiers ?? []) !== JSON.stringify(npmSpecifiersKey(npmRoots))
  );
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (err) {
    if (isAbsentFsError(err)) return undefined;
    throw err;
  }
}

/**
 * Local dependency check: every recorded file must still resolve inside `rootReal` (no symlink escape)
 * and hash to its recorded content sha256.
 */
function localDependenciesMatch(list: DepsListFile, rootReal: string): boolean {
  for (const dep of list.dependencies) {
    if (
      !isJsonObject(dep) ||
      typeof dep.path !== 'string' ||
      dep.path.length === 0 ||
      isAbsolute(dep.path) ||
      typeof dep.sha256 !== 'string' ||
      dep.sha256.length === 0
    ) {
      return false;
    }
    const abs = resolve(rootReal, dep.path);
    if (!isInside(rootReal, abs)) return false;
    const real = realpathOrNull(abs);
    if (real === null || !isInside(rootReal, real)) return false;
    const source = readTextIfPresent(abs);
    if (source === undefined || sha256(source) !== dep.sha256) return false;
  }
  return true;
}

/** mtime/size fast path: valid only with a fully recorded fingerprint on a file older than the 2s filesystem race window. */
function hasStableStatFingerprint(dep: { mtimeMs?: number; size?: number }, st: Stats, now: number): boolean {
  return (
    typeof dep.mtimeMs === 'number' &&
    typeof dep.size === 'number' &&
    st.mtimeMs === dep.mtimeMs &&
    st.size === dep.size &&
    now - st.mtimeMs > 2_000
  );
}

/**
 * npm dependency check: an unchanged mtime/size fingerprint outside the race window skips the content
 * hash; otherwise (fingerprint absent, changed, or too fresh) the content sha256 must still match.
 */
function npmDependenciesMatch(list: DepsListFile): boolean {
  const now = Date.now();
  for (const dep of list.npmDependencies ?? []) {
    if (!isJsonObject(dep) || typeof dep.path !== 'string' || !isAbsolute(dep.path) || typeof dep.sha256 !== 'string' || dep.sha256.length === 0) {
      return false;
    }
    const st = statIfPresent(dep.path);
    if (st === undefined) return false;
    if (hasStableStatFingerprint(dep, st, now)) continue;
    const source = readTextIfPresent(dep.path);
    if (source === undefined || sha256(source) !== dep.sha256) return false;
  }
  return true;
}

/** Every declared async chunk file must exist: a missing chunk is a stale cache, not a late runtime 404. */
function allChunksPresent(
  stagingReal: string,
  stagingDir: string,
  baseName: string,
  contentHash: string,
  chunkNames: ReadonlyArray<string>,
): boolean {
  for (const chunkName of chunkNames) {
    const chunkPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}`);
    if (!isInside(stagingReal, resolve(chunkPath)) || statIfPresent(chunkPath) === undefined) return false;
  }
  return true;
}

/**
 * Lazy per-chunk reader: a main-module cache hit must not pre-read every async chunk, so the first
 * property access loads it; a chunk missing at that late point is a hard error rather than a cache miss.
 */
function lazyCachedChunk(
  stagingDir: string,
  baseName: string,
  contentHash: string,
  moduleRef: string,
  chunkName: string,
): () => { code: string; gzipped?: Uint8Array } {
  let cached: { code: string; gzipped?: Uint8Array } | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const loaded = readCachedChunk(stagingDir, baseName, contentHash, chunkName);
    if (loaded === undefined) {
      throw new HelmxError(
        'client_chunk_not_found',
        `Cached client chunk ${chunkName} (${contentHash}) is missing for ${moduleRef}`,
        404,
        { module: moduleRef, contentHash, chunkName },
      );
    }
    cached = loaded;
    return cached;
  };
}

export function readCachedResult(
  stagingDir: string,
  depsListPath: string,
  rootReal: string,
  moduleRef: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot>,
): CachedDiskHit | undefined {
  const list = readDepsListOrMiss(depsListPath);
  if (list === undefined) return undefined;
  if (isDepsListStale(list, moduleRef, rootReal, npmRoots)) return undefined;
  if (!localDependenciesMatch(list, rootReal)) return undefined;
  if (!npmDependenciesMatch(list)) return undefined;
  const stagingReal = resolve(stagingDir);
  const baseName = safeFileName(moduleRef);
  const codePath = join(stagingDir, `${baseName}.${list.contentHash}.mjs`);
  if (!isInside(stagingReal, resolve(codePath))) return undefined;
  const chunkNames = list.chunks ?? [];
  if (!allChunksPresent(stagingReal, stagingDir, baseName, list.contentHash, chunkNames)) return undefined;
  const code = readTextIfPresent(codePath);
  if (code === undefined) return undefined;
  const gzipped = readOptionalGzip(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`));
  // Lazy getters avoid pre-reading all async chunks on a main-module cache hit.
  const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
  for (const chunkName of chunkNames) {
    Object.defineProperty(chunks, chunkName, {
      enumerable: true,
      get: lazyCachedChunk(stagingDir, baseName, list.contentHash, moduleRef, chunkName),
    });
  }
  return {
    result: { code, contentHash: list.contentHash, gzipped, exports: list.exports ?? [], chunks },
    list,
  };
}

export function collectLocalDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
): string[] {
  if (!metafile) return [];
  const out = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && isInside(rootReal, real)) out.add(real);
  }
  return [...out].sort();
}

export function collectNpmDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot>,
): Array<{ root: string; files: string[] }> {
  if (!metafile || npmRoots.length === 0) return [];
  const files = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && !isInside(rootReal, real)) files.add(real);
  }
  return files.size === 0 ? [] : [{ root: 'authorized-npm-closure', files: [...files].sort() }];
}

export interface BuildDepsListOptions {
  rootReal: string;
  moduleRef: string;
  dependencies: string[];
  npmDeps?: Array<{ root: string; files: string[] }>;
  npmRoots?: ReadonlyArray<PluginClientNpmRoot>;
  entryExports?: string[];
  chunks?: string[];
}

export function buildDepsList(options: BuildDepsListOptions): DepsListFile {
  const {
    rootReal,
    moduleRef,
    dependencies,
    npmDeps = [],
    npmRoots = [],
    entryExports = [],
    chunks,
  } = options;
  const npmSpecifiers = npmSpecifiersKey(npmRoots);
  const hash = createHash('sha256');
  hash.update(`helmx-plugin-client-v${DEPS_LIST_VERSION}\n`);
  hash.update(`module:${moduleRef}\n`);
  for (const specifier of npmSpecifiers) {
    hash.update(`--npm-spec:${specifier}\n`);
  }
  const entries = dependencies.map((abs) => {
    const rel = relative(rootReal, abs);
    const sha = sha256(readFileSync(abs, 'utf8'));
    hash.update(`--file:${rel}\n${sha}\n`);
    return { path: rel, sha256: sha };
  });
  const npmEntries = npmDeps.flatMap(({ root, files }) =>
    files.map((abs) => {
      const st = statSync(abs);
      const sha = sha256(readFileSync(abs, 'utf8'));
      hash.update(`--npm:${root}::${abs}\n${sha}\n`);
      return { root, path: abs, sha256: sha, mtimeMs: st.mtimeMs, size: st.size };
    }),
  );
  const sortedChunks = chunks && chunks.length > 0 ? [...chunks].sort() : undefined;
  if (sortedChunks) {
    for (const c of sortedChunks) hash.update(`--chunk:${c}\n`);
  }
  return {
    version: DEPS_LIST_VERSION,
    module: moduleRef,
    root: rootReal,
    contentHash: hash.digest('hex').slice(0, 24),
    dependencies: entries,
    ...(npmEntries.length > 0 ? { npmDependencies: npmEntries } : {}),
    npmSpecifiers,
    ...(entryExports.length > 0 ? { exports: entryExports } : {}),
    ...(sortedChunks ? { chunks: sortedChunks } : {}),
  };
}

function pruneSupersededBundleFiles(stagingDir: string, baseName: string, currentHash: string): void {
  const filePrefix = `${baseName}.`;
  const currentPrefix = `${baseName}.${currentHash}.`;
  const manifestName = `${baseName}.deps.json`;
  for (const name of readdirSync(stagingDir)) {
    if (!name.startsWith(filePrefix) || name === manifestName || name.startsWith(currentPrefix)) {
      continue;
    }
    try {
      unlinkSync(join(stagingDir, name));
    } catch (err) {
      if (!isAbsentFsError(err)) throw err;
    }
  }
}

/** Atomically persists entry JS, `.gz`, split chunks, and `deps.json`, then populates the memory cache. */
export function persistCompiledBundle(params: {
  stagingDir: string;
  baseName: string;
  depsListPath: string;
  memKey: string;
  rootReal: string;
  list: DepsListFile;
  mainJs: string;
  entryExports: string[];
  chunks: Record<string, { code: string; gzipped?: Uint8Array }>;
}): PluginClientBundle {
  const { stagingDir, baseName, depsListPath, memKey, rootReal, list, mainJs, entryExports, chunks } = params;
  mkdirSync(stagingDir, { recursive: true });
  atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainJs);
  const gzipped = gzipSync(Buffer.from(mainJs, 'utf8'));
  atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gzipped);
  for (const [chunkName, chunkData] of Object.entries(chunks)) {
    atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}`), chunkData.code);
    if (chunkData.gzipped) {
      atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}.gz`), chunkData.gzipped);
    }
  }
  atomicWriteFileSync(depsListPath, `${JSON.stringify(list)}\n`);
  pruneSupersededBundleFiles(stagingDir, baseName, list.contentHash);
  const result: PluginClientBundle = {
    code: mainJs,
    contentHash: list.contentHash,
    gzipped,
    exports: entryExports,
    chunks,
  };
  recordMemoryCache(memKey, rootReal, list, result);
  return result;
}

// ---------------------------------------------------------------------------
// Workspace built-in shared cache directory discovery
// ---------------------------------------------------------------------------

interface WorkspaceBuiltinCacheTarget {
  pluginsSrcRoot: string;
  cacheDir: string;
}

let cachedWorkspaceBuiltinTarget: WorkspaceBuiltinCacheTarget | null | undefined;

function resolveWorkspaceBuiltinCacheTarget(): WorkspaceBuiltinCacheTarget | undefined {
  if (cachedWorkspaceBuiltinTarget !== undefined) {
    return cachedWorkspaceBuiltinTarget ?? undefined;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const pluginsSrc = join(dir, 'packages', 'plugins', 'src');
    if (
      readdirExists(join(dir, 'pnpm-workspace.yaml')) &&
      readdirExists(join(dir, 'packages', 'plugins', 'package.json')) &&
      readdirExists(pluginsSrc) &&
      readdirExists(join(dir, 'node_modules'))
    ) {
      const rootReal = realpathOrNull(dir);
      const pluginsSrcReal = realpathOrNull(pluginsSrc);
      if (rootReal !== null && pluginsSrcReal !== null) {
        cachedWorkspaceBuiltinTarget = {
          pluginsSrcRoot: pluginsSrcReal,
          cacheDir: join(rootReal, 'node_modules', '.cache', 'helmx-plugin-clients'),
        };
        return cachedWorkspaceBuiltinTarget;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedWorkspaceBuiltinTarget = null;
  return undefined;
}

function readdirExists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch (err) {
    if (isAbsentFsError(err)) return false;
    throw err;
  }
}

/**
 * Returns the default shared disk cache directory used for workspace built-in plugins (`builtin:*`)
 * in source-compile mode, or `undefined` outside a monorepo checkout.
 */
export function resolveDefaultBuiltinClientCacheDir(): string | undefined {
  return resolveWorkspaceBuiltinCacheTarget()?.cacheDir;
}

/**
 * Resolves the effective disk cache root for a compile request dispatched via `createPluginBuildProvider`.
 */
export function resolveProviderCacheDir(
  pluginId: string,
  clientRoot: string,
  fallbackCacheDir: string,
  builtinCacheDir?: string | false,
): string {
  if (!isBuiltinNamespace(pluginId) || builtinCacheDir === false) {
    return fallbackCacheDir;
  }
  if (typeof builtinCacheDir === 'string') {
    return builtinCacheDir;
  }
  const target = resolveWorkspaceBuiltinCacheTarget();
  if (target === undefined) {
    return fallbackCacheDir;
  }
  const clientRootReal = realpathOrNull(clientRoot);
  if (clientRootReal !== null && isInside(target.pluginsSrcRoot, clientRootReal)) {
    return target.cacheDir;
  }
  return fallbackCacheDir;
}
