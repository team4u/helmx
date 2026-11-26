/**
 * Client compiler cache layer:
 * - in-memory mtime/size fast cache + disk `deps.json` sha256 revalidation;
 * - lazy async-chunk reader (`readCachedChunk`) and atomic artifact persistence;
 * - workspace built-in shared cache directory discovery (`resolveProviderCacheDir`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { isBuiltinNamespace, type PluginClientBundle, type PluginClientNpmRoot } from '@helmx/protocol';
import { atomicWriteFileSync } from '@helmx/env-io';
import { isInside, realpathOrNull, safeFileName, sha256 } from './client-paths.js';

/**
 * Dependency manifest (`deps.json`) schema version:
 * v3: native esbuild CSS bundling; v4: controlled npm dependencies; v5: minify + pre-gzip;
 * v6: code splitting + async chunk bridge; v7: isolated `__helmx_chunk_share` namespace bridge;
 * v8: controlled npm declaration set recorded in cache credentials;
 * v9: mtime/size stat fast-path on `npmDependencies` outside the 2s filesystem race window.
 */
export const DEPS_LIST_VERSION = 9;

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
    } catch {
      memoryCompiledCache.delete(memKey);
      return undefined;
    }
  }
  if (memEntry.npmStats) {
    for (const [path, st] of memEntry.npmStats) {
      try {
        const cur = statSync(path);
        if (cur.mtimeMs !== st.mtimeMs || cur.size !== st.size) {
          memoryCompiledCache.delete(memKey);
          return undefined;
        }
      } catch {
        memoryCompiledCache.delete(memKey);
        return undefined;
      }
    }
  }
  return memEntry.result;
}

export function recordMemoryCache(
  memKey: string,
  rootReal: string,
  list: DepsListFile,
  result: PluginClientBundle,
): void {
  try {
    const localMtimes = new Map<string, number>();
    for (const dep of list.dependencies) {
      const abs = join(rootReal, dep.path);
      try {
        localMtimes.set(abs, statSync(abs).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    const npmStats = new Map<string, { mtimeMs: number; size: number }>();
    for (const dep of list.npmDependencies ?? []) {
      try {
        const st = statSync(dep.path);
        npmStats.set(dep.path, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* missing file: omit stat so disk manifest check triggers recompile */
      }
    }
    memoryCompiledCache.set(memKey, {
      result,
      localMtimes,
      ...(npmStats.size > 0 ? { npmStats } : {}),
      root: rootReal,
    });
  } catch {
    /* ignore */
  }
}

function readOptionalGzip(gzPath: string): Uint8Array | undefined {
  if (!existsSync(gzPath)) return undefined;
  try {
    return readFileSync(gzPath);
  } catch {
    return undefined;
  }
}

/** Reads a cached async/shared chunk and its optional `.gz` bytes from `stagingDir`. */
export function readCachedChunk(
  stagingDir: string,
  baseName: string,
  contentHash: string,
  chunkName: string,
): { code: string; gzipped?: Uint8Array } | undefined {
  const chunkPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}`);
  if (!existsSync(chunkPath)) return undefined;
  try {
    const code = readFileSync(chunkPath, 'utf8');
    const gzipped = readOptionalGzip(join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}.gz`));
    return { code, gzipped };
  } catch {
    return undefined;
  }
}

export function readCachedResult(
  stagingDir: string,
  depsListPath: string,
  rootReal: string,
  moduleRef: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot>,
): CachedDiskHit | undefined {
  if (!existsSync(depsListPath)) return undefined;
  let list: DepsListFile;
  try {
    list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
  } catch {
    return undefined;
  }
  if (
    list.version !== DEPS_LIST_VERSION ||
    list.module !== moduleRef ||
    list.root !== rootReal ||
    typeof list.contentHash !== 'string' ||
    !Array.isArray(list.dependencies) ||
    JSON.stringify(list.npmSpecifiers ?? []) !== JSON.stringify(npmSpecifiersKey(npmRoots))
  ) {
    return undefined;
  }
  for (const dep of list.dependencies) {
    let source: string;
    try {
      source = readFileSync(join(rootReal, dep.path), 'utf8');
    } catch {
      return undefined;
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  const now = Date.now();
  for (const dep of list.npmDependencies ?? []) {
    let st;
    try {
      st = statSync(dep.path);
    } catch {
      return undefined;
    }
    if (
      typeof dep.mtimeMs === 'number' &&
      typeof dep.size === 'number' &&
      st.mtimeMs === dep.mtimeMs &&
      st.size === dep.size &&
      now - st.mtimeMs > 2_000
    ) {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(dep.path, 'utf8');
    } catch {
      return undefined;
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  const baseName = safeFileName(moduleRef);
  const codePath = join(stagingDir, `${baseName}.${list.contentHash}.mjs`);
  if (!existsSync(codePath)) return undefined;
  if (Array.isArray(list.chunks) && list.chunks.length > 0) {
    for (const chunkName of list.chunks) {
      if (!existsSync(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}`))) {
        return undefined;
      }
    }
  }
  try {
    const code = readFileSync(codePath, 'utf8');
    const gzipped = readOptionalGzip(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`));
    const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
    if (Array.isArray(list.chunks) && list.chunks.length > 0) {
      // Lazy getters avoid pre-reading all async chunks on a main-module cache hit.
      for (const chunkName of list.chunks) {
        let cached: { code: string; gzipped?: Uint8Array } | undefined | null = null;
        Object.defineProperty(chunks, chunkName, {
          enumerable: true,
          get: () => {
            if (cached === null) cached = readCachedChunk(stagingDir, baseName, list.contentHash, chunkName);
            return cached;
          },
        });
      }
    }
    return {
      result: { code, contentHash: list.contentHash, gzipped, exports: list.exports ?? [], chunks },
      list,
    };
  } catch {
    return undefined;
  }
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

export function buildDepsList(
  rootReal: string,
  moduleRef: string,
  dependencies: string[],
  npmDeps: Array<{ root: string; files: string[] }> = [],
  npmRoots: ReadonlyArray<PluginClientNpmRoot> = [],
  entryExports: string[] = [],
  chunks?: string[],
): DepsListFile {
  const hash = createHash('sha256');
  hash.update(`helmx-plugin-client-v${DEPS_LIST_VERSION}\n`);
  hash.update(`module:${moduleRef}\n`);
  for (const specifier of npmSpecifiersKey(npmRoots)) {
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
    npmSpecifiers: npmSpecifiersKey(npmRoots),
    ...(entryExports.length > 0 ? { exports: entryExports } : {}),
    ...(sortedChunks ? { chunks: sortedChunks } : {}),
  };
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
  let gzipped: Uint8Array | undefined;
  try {
    const gz = gzipSync(Buffer.from(mainJs, 'utf8'));
    atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
    gzipped = gz;
  } catch {
    /* on-demand gzip fallback remains available */
  }
  for (const [chunkName, chunkData] of Object.entries(chunks)) {
    atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}`), chunkData.code);
    if (chunkData.gzipped) {
      atomicWriteFileSync(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}.gz`), chunkData.gzipped);
    }
  }
  atomicWriteFileSync(depsListPath, `${JSON.stringify(list)}\n`);
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
      existsSync(join(dir, 'pnpm-workspace.yaml')) &&
      existsSync(join(dir, 'packages', 'plugins', 'package.json')) &&
      existsSync(pluginsSrc) &&
      existsSync(join(dir, 'node_modules'))
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
