/**
 * Prebuilt client bundle builder (`buildPluginClientBundleDir`):
 * compiles a plugin's client entrypoint modules into a static, self-contained `dist-client/`
 * directory (entry `.mjs` + `.mjs.gz`, split chunks `.js` + `.js.gz`, and `manifest.json`)
 * sharing the exact `__helmx_shared_*` and `__helmx_import_chunk` ABI of `compilePluginClientModule`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gzipSync } from 'node:zlib';
import {
  HelmxError,
  PREBUILT_CLIENT_MANIFEST_FILE,
  PREBUILT_CLIENT_MANIFEST_VERSION,
  assertModuleRefShape,
  assertPrebuiltClientManifest,
  compareCodeUnit,
  prebuiltChunkFileName,
  type BuildPluginClientBundleDirOptions,
  type BuildPluginClientBundleDirResult,
  type PluginClientNpmRoot,
  type PrebuiltClientManifest,
  type PrebuiltClientModuleEntry,
} from '@helmx/protocol';
import { renameAtomically } from '@helmx/env-io';
import { compileClientBundle } from './client-bundler.js';
import {
  assertEntryInsideRoot,
  realPathOrThrow,
  safeFileName,
} from './client-paths.js';

const gzipAsync = promisify(gzip);
const ASYNC_GZIP_THRESHOLD_BYTES = 32 * 1024;

async function compressAsset(bytes: Buffer): Promise<Uint8Array> {
  return bytes.byteLength >= ASYNC_GZIP_THRESHOLD_BYTES ? await gzipAsync(bytes) : gzipSync(bytes);
}

async function writeBundleFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await fsp.writeFile(filePath, content, { mode: 0o644 });
  if (process.platform !== 'win32') {
    await fsp.chmod(filePath, 0o644);
  }
}

/**
 * Writes `fileName` together with its `.gz` sibling into `dir` and returns the total bytes written.
 * Pre-compressed `gzipped` bytes are reused when the compiler already produced them.
 */
async function writeCodeWithGzip(dir: string, fileName: string, code: string, gzipped?: Uint8Array): Promise<number> {
  const codeBytes = Buffer.from(code, 'utf8');
  const gz = gzipped ?? (await compressAsset(codeBytes));
  await Promise.all([
    writeBundleFile(join(dir, fileName), code),
    writeBundleFile(join(dir, `${fileName}.gz`), gz),
  ]);
  return codeBytes.byteLength + gz.byteLength;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CLIENT_ENTRY_PATTERN = /\.(ts|tsx)$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/i;

/** Scans `clientRoot` recursively for non-declaration `.ts`/`.tsx` entry modules (POSIX relative paths). */
function discoverClientModules(clientRootReal: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, relPrefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodeUnit(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (CLIENT_ENTRY_PATTERN.test(entry.name) && !DECLARATION_FILE_PATTERN.test(entry.name)) {
          found.push(rel);
        }
      }
    }
  };
  visit(clientRootReal, '');
  return found;
}

/** Validates `clientRoot` and returns its real path (`client_root_invalid` when missing or not a directory). */
function resolveClientRootReal(pluginId: string, clientRoot: string): string {
  const rootReal = realPathOrThrow(clientRoot, `plugin ${pluginId} clientRoot is missing or inaccessible: ${clientRoot}`);
  if (!statSync(rootReal).isDirectory()) {
    throw new HelmxError('client_root_invalid', `plugin ${pluginId} clientRoot is not a directory: ${clientRoot}`, 400, {
      pluginId,
      clientRoot,
    });
  }
  return rootReal;
}

/** Validates an explicit `modules` list, rejecting an empty list and deduplicating while preserving caller order. */
function resolveExplicitModules(pluginId: string, modules: ReadonlyArray<string>): string[] {
  if (modules.length === 0) {
    throw new HelmxError(
      'invalid_client_module',
      `plugin ${pluginId} buildPluginClientBundleDir modules list cannot be empty`,
      400,
      { pluginId },
    );
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const moduleRef of modules) {
    assertModuleRefShape(pluginId, moduleRef);
    if (seen.has(moduleRef)) continue;
    seen.add(moduleRef);
    unique.push(moduleRef);
  }
  return unique;
}

/** Picks the entry modules to build: the explicit `modules` list, or every non-declaration `.ts`/`.tsx` under `clientRoot`. */
function resolveTargetModules(
  pluginId: string,
  clientRoot: string,
  rootReal: string,
  modules: ReadonlyArray<string> | undefined,
): string[] {
  if (modules !== undefined) return resolveExplicitModules(pluginId, modules);
  const discovered = discoverClientModules(rootReal);
  if (discovered.length === 0) {
    throw new HelmxError(
      'client_root_invalid',
      `plugin ${pluginId} has no .ts/.tsx entry modules in clientRoot: ${clientRoot}`,
      400,
      { pluginId, clientRoot },
    );
  }
  return discovered;
}

interface ResolvedClientEntry {
  moduleRef: string;
  entryReal: string;
}

interface PrebuiltBuildContext {
  pluginId: string;
  rootReal: string;
  npmRoots: ReadonlyArray<PluginClientNpmRoot>;
  /** Sibling staging directory receiving all artifacts before they are swapped into `outDir`. */
  stagingOut: string;
}

/**
 * Compiles one entry module into the staging directory (entry `.mjs` + `.gz`, split chunks `.js` + `.gz`)
 * and returns its manifest entry together with the bytes written.
 */
async function compileAndWriteModule(
  ctx: PrebuiltBuildContext,
  entry: ResolvedClientEntry,
): Promise<{ manifestEntry: PrebuiltClientModuleEntry; bytes: number }> {
  const built = await compileClientBundle({
    pluginId: ctx.pluginId,
    rootReal: ctx.rootReal,
    entryReal: entry.entryReal,
    moduleRef: entry.moduleRef,
    stagingDir: ctx.stagingOut,
    npmRoots: ctx.npmRoots,
  });
  // Created only after a successful compile so a failing build leaves nothing behind to clean up.
  mkdirSync(ctx.stagingOut, { recursive: true });

  const contentHash = built.list.contentHash;
  const entryFile = `${safeFileName(entry.moduleRef)}.${contentHash}.mjs`;
  let bytes = await writeCodeWithGzip(ctx.stagingOut, entryFile, built.mainJs);

  const chunkNames = Object.keys(built.chunks).sort();
  const chunkBytes = await Promise.all(
    chunkNames.map((chunkName) => {
      const chunk = built.chunks[chunkName]!;
      const chunkFile = prebuiltChunkFileName(entryFile, chunkName, ctx.pluginId);
      return writeCodeWithGzip(ctx.stagingOut, chunkFile, chunk.code, chunk.gzipped);
    }),
  );
  bytes += chunkBytes.reduce((sum, written) => sum + written, 0);

  return {
    manifestEntry: {
      entryFile,
      contentHash,
      exports: [...built.entryExports],
      ...(chunkNames.length > 0 ? { chunks: chunkNames } : {}),
    },
    bytes,
  };
}

/**
 * Moves `backupOut` back to `resolvedOut` after a failed swap. When the restore itself fails, both
 * failures are reported together because the previous bundle then only survives at `backupOut`.
 */
async function restorePreviousBundle(pluginId: string, swapErr: unknown, backupOut: string, resolvedOut: string): Promise<void> {
  try {
    await renameAtomically(backupOut, resolvedOut);
  } catch (restoreErr) {
    throw new HelmxError(
      'client_compile_failed',
      `prebuilt client swap failed (${describeError(swapErr)}); backup restore failed (${describeError(restoreErr)}); previous bundle preserved at ${backupOut}`,
      500,
      { pluginId, outDir: resolvedOut, backupOut },
    );
  }
}

/**
 * Atomically replaces `resolvedOut` with `stagingOut`: the previous bundle is first moved aside to
 * `<stagingOut>.prev` and restored when the swap fails midway, so `outDir` never ends up missing.
 */
async function swapStagingIntoPlace(pluginId: string, stagingOut: string, resolvedOut: string): Promise<void> {
  let backupOut: string | undefined;
  try {
    if (existsSync(resolvedOut)) {
      backupOut = `${stagingOut}.prev`;
      await renameAtomically(resolvedOut, backupOut);
    }
    await renameAtomically(stagingOut, resolvedOut);
  } catch (swapErr) {
    // Restore only when the previous bundle was moved aside and nothing has taken its place yet.
    if (backupOut !== undefined && !existsSync(resolvedOut) && existsSync(backupOut)) {
      await restorePreviousBundle(pluginId, swapErr, backupOut, resolvedOut);
    }
    throw swapErr;
  }
  if (backupOut !== undefined) {
    rmSync(backupOut, { recursive: true, force: true });
  }
}

/**
 * Compiles one or more client entry modules under `clientRoot` into a standalone prebuilt directory
 * containing `manifest.json`, entry `.mjs` + `.gz`, and all split chunks `.js` + `.gz`.
 */
export async function buildPluginClientBundleDir(
  options: BuildPluginClientBundleDirOptions,
): Promise<BuildPluginClientBundleDirResult> {
  const { pluginId, clientRoot, outDir, npmRoots = [] } = options;
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    throw new HelmxError('invalid_plugin_definition', 'buildPluginClientBundleDir requires a non-empty pluginId', 400);
  }
  const rootReal = resolveClientRootReal(pluginId, clientRoot);
  const targetModules = resolveTargetModules(pluginId, clientRoot, rootReal, options.modules);
  const resolvedEntries: ResolvedClientEntry[] = targetModules.map((moduleRef) => ({
    moduleRef,
    entryReal: assertEntryInsideRoot(pluginId, rootReal, moduleRef),
  }));

  const resolvedOut = resolve(outDir);
  // Sibling staging directory (unique per process) keeps partial builds invisible until the atomic swap.
  const stagingOut = join(dirname(resolvedOut), `.${basename(resolvedOut)}.staging-${process.pid}-${randomUUID().slice(0, 8)}`);
  const buildContext: PrebuiltBuildContext = { pluginId, rootReal, npmRoots, stagingOut };

  try {
    const manifestModules: Record<string, PrebuiltClientModuleEntry> = {};
    let totalBytes = 0;
    for (const entry of resolvedEntries) {
      const written = await compileAndWriteModule(buildContext, entry);
      manifestModules[entry.moduleRef] = written.manifestEntry;
      totalBytes += written.bytes;
    }

    const manifest = assertPrebuiltClientManifest(
      { version: PREBUILT_CLIENT_MANIFEST_VERSION, modules: manifestModules } satisfies PrebuiltClientManifest,
      stagingOut,
    );
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeBundleFile(join(stagingOut, PREBUILT_CLIENT_MANIFEST_FILE), manifestText);
    totalBytes += Buffer.byteLength(manifestText, 'utf8');

    await swapStagingIntoPlace(pluginId, stagingOut, resolvedOut);

    return {
      pluginId,
      clientRoot: rootReal,
      outDir: resolvedOut,
      manifestPath: join(resolvedOut, PREBUILT_CLIENT_MANIFEST_FILE),
      manifest,
      totalBytes,
    };
  } finally {
    // No-op once the staging directory was swapped into place or was never created (per-process unique path).
    rmSync(stagingOut, { recursive: true, force: true });
  }
}
