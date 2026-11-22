/**
 * PluginClientCompiler: top-level facade for the `client.tsx` UI build track (`@helmx/plugin-build`).
 *
 * Coordinates in-process promise deduplication, memory/disk content-hash caching (`client-cache.ts`),
 * cross-process locking via `@helmx/env-io`'s `withCrossProcessFileLock`, and two-pass esbuild
 * bundling (`client-bundler.ts`) with realpath/npm/CSS containment (`client-containment.ts`).
 */
import { join, resolve } from 'node:path';
import {
  assertModuleRefShape,
  type PluginClientBundle,
  type PluginClientNpmRoot,
} from '@helmx/protocol';
import { withCrossProcessFileLock } from '@helmx/env-io';
import { compileClientBundle } from './client-bundler.js';
import {
  lookupMemoryCache,
  npmRootsKey,
  persistCompiledBundle,
  readCachedResult,
  recordMemoryCache,
} from './client-cache.js';
import {
  assertEntryInsideRoot,
  realPathOrThrow,
  safeDirName,
  safeFileName,
} from './client-paths.js';

export { CLIENT_SHARED_EXTERNALS, CLIENT_SHARED_GLOBALS } from './client-containment.js';
export {
  clearClientCompilerMemoryCache,
  readCachedChunk,
  resolveDefaultBuiltinClientCacheDir,
  resolveProviderCacheDir,
} from './client-cache.js';
export {
  findPackageDirOf,
  isInside,
  realPathOrThrow,
  safeDirName,
  safeFileName,
} from './client-paths.js';

/** Compiled bundle type alias (re-exported for tools and tests). */
export type ClientCompileResult = PluginClientBundle;

/** Controlled npm dependency resolution root (`PluginClientNpmRoot` alias). */
export type ClientNpmRoot = PluginClientNpmRoot;

const COMPILE_LOCK_WAIT_MS = 60_000;
const COMPILE_LOCK_POLL_MS = 25;
const COMPILE_LOCK_SETTLE_GRACE_MS = 2_000;

/** In-process deduplication: identical concurrent compile requests share one Promise. */
const inflight = new Map<string, Promise<ClientCompileResult>>();

/**
 * Compiles a plugin client module into browser ESM (concurrency-safe and content-hash cached).
 *
 * @param pluginId Plugin ID (isolates cache directory under `<cacheDir>/plugin-staging/`)
 * @param clientRoot Declared and validated absolute source root directory
 * @param moduleRef Relative entrypoint path inside `clientRoot` (validated by `assertModuleRefShape`)
 * @param cacheDir Host cache root (`plugin-staging/<pluginId>/` stores bundles and `deps.json`)
 */
export async function compilePluginClientModule(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
  options?: { npmRoots?: ReadonlyArray<ClientNpmRoot> },
): Promise<ClientCompileResult> {
  assertModuleRefShape(pluginId, moduleRef);
  const rootReal = realPathOrThrow(clientRoot, `plugin ${pluginId} clientRoot cannot be accessed: ${clientRoot}`);
  const resolvedCacheDir = resolve(cacheDir);
  const npmRoots = options?.npmRoots ?? [];
  const key = `${pluginId}\0${moduleRef}\0${rootReal}\0${npmRootsKey(npmRoots)}\0${resolvedCacheDir}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = compileUncached(pluginId, rootReal, moduleRef, resolvedCacheDir, key, npmRoots).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

async function compileUncached(
  pluginId: string,
  rootReal: string,
  moduleRef: string,
  cacheDir: string,
  memKey: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): Promise<ClientCompileResult> {
  const entryReal = assertEntryInsideRoot(pluginId, rootReal, moduleRef);

  // 1. In-memory fast path (local mtime + controlled-npm mtime/size check).
  const memHit = lookupMemoryCache(memKey, rootReal);
  if (memHit) return memHit;

  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName(pluginId));
  const baseName = safeFileName(moduleRef);
  const depsListPath = join(stagingDir, `${baseName}.deps.json`);
  const tryCacheHit = () => readCachedResult(stagingDir, depsListPath, rootReal, moduleRef, npmRoots);

  // 2. Lock-free disk cache revalidation (manifest + per-dependency sha256 check).
  const diskHit = tryCacheHit();
  if (diskHit) {
    recordMemoryCache(memKey, rootReal, diskHit.list, diskHit.result);
    return diskHit.result;
  }

  // 3. Cross-process exclusive compile lock (shared `@helmx/env-io` atomic link/CAS-release lock).
  const lockPath = join(stagingDir, `.${baseName}.compile.lock`);
  return await withCrossProcessFileLock(
    lockPath,
    async () => {
      const hitAfterLock = tryCacheHit();
      if (hitAfterLock) {
        recordMemoryCache(memKey, rootReal, hitAfterLock.list, hitAfterLock.result);
        return hitAfterLock.result;
      }
      const built = await compileClientBundle({
        pluginId,
        rootReal,
        entryReal,
        moduleRef,
        stagingDir,
        npmRoots,
      });
      return persistCompiledBundle({
        stagingDir,
        baseName,
        depsListPath,
        memKey,
        rootReal,
        list: built.list,
        mainJs: built.mainJs,
        entryExports: built.entryExports,
        chunks: built.chunks,
      });
    },
    {
      waitMs: COMPILE_LOCK_WAIT_MS,
      pollMs: COMPILE_LOCK_POLL_MS,
      settleGraceMs: COMPILE_LOCK_SETTLE_GRACE_MS,
    },
  );
}
