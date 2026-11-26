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
  const rootReal = realPathOrThrow(clientRoot, `plugin ${pluginId} clientRoot is missing or inaccessible: ${clientRoot}`);
  if (!statSync(rootReal).isDirectory()) {
    throw new HelmxError('client_root_invalid', `plugin ${pluginId} clientRoot is not a directory: ${clientRoot}`, 400, {
      pluginId,
      clientRoot,
    });
  }

  let targetModules: string[];
  if (options.modules !== undefined) {
    if (options.modules.length === 0) {
      throw new HelmxError('invalid_client_module', `plugin ${pluginId} buildPluginClientBundleDir modules list cannot be empty`, 400, {
        pluginId,
      });
    }
    const seen = new Set<string>();
    targetModules = [];
    for (const m of options.modules) {
      assertModuleRefShape(pluginId, m);
      if (!seen.has(m)) {
        seen.add(m);
        targetModules.push(m);
      }
    }
  } else {
    targetModules = discoverClientModules(rootReal);
    if (targetModules.length === 0) {
      throw new HelmxError(
        'client_root_invalid',
        `plugin ${pluginId} has no .ts/.tsx entry modules in clientRoot: ${clientRoot}`,
        400,
        { pluginId, clientRoot },
      );
    }
  }

  const resolvedEntries = targetModules.map((moduleRef) => {
    assertModuleRefShape(pluginId, moduleRef);
    return {
      moduleRef,
      entryReal: assertEntryInsideRoot(pluginId, rootReal, moduleRef),
    };
  });

  const resolvedOut = resolve(outDir);
  const outParent = dirname(resolvedOut);
  const stagingOut = join(outParent, `.${basename(resolvedOut)}.staging-${process.pid}-${randomUUID().slice(0, 8)}`);
  let stagingCreated = false;

  try {
    const manifestModules: Record<string, PrebuiltClientModuleEntry> = {};
    let totalBytes = 0;

    for (const { moduleRef, entryReal } of resolvedEntries) {
      const built = await compileClientBundle({
        pluginId,
        rootReal,
        entryReal,
        moduleRef,
        stagingDir: stagingOut,
        npmRoots,
      });
      if (!stagingCreated) {
        mkdirSync(stagingOut, { recursive: true });
        stagingCreated = true;
      }

      const baseName = safeFileName(moduleRef);
      const contentHash = built.list.contentHash;
      const entryFile = `${baseName}.${contentHash}.mjs`;
      const entryCodeBytes = Buffer.from(built.mainJs, 'utf8');
      const entryGz = await compressAsset(entryCodeBytes);
      await Promise.all([
        writeBundleFile(join(stagingOut, entryFile), built.mainJs),
        writeBundleFile(join(stagingOut, `${entryFile}.gz`), entryGz),
      ]);
      totalBytes += entryCodeBytes.byteLength + entryGz.byteLength;

      const chunkNames = Object.keys(built.chunks).sort();
      await Promise.all(
        chunkNames.map(async (chunkName) => {
          const chunkData = built.chunks[chunkName]!;
          const chunkFile = prebuiltChunkFileName(entryFile, chunkName, pluginId);
          const chunkCodeBytes = Buffer.from(chunkData.code, 'utf8');
          const chunkGz = chunkData.gzipped ?? (await compressAsset(chunkCodeBytes));
          await Promise.all([
            writeBundleFile(join(stagingOut, chunkFile), chunkData.code),
            writeBundleFile(join(stagingOut, `${chunkFile}.gz`), chunkGz),
          ]);
          totalBytes += chunkCodeBytes.byteLength + chunkGz.byteLength;
        }),
      );

      manifestModules[moduleRef] = {
        entryFile,
        contentHash,
        exports: [...built.entryExports],
        ...(chunkNames.length > 0 ? { chunks: chunkNames } : {}),
      };
    }

    const manifestRaw: PrebuiltClientManifest = {
      version: PREBUILT_CLIENT_MANIFEST_VERSION,
      modules: manifestModules,
    };
    const manifest = assertPrebuiltClientManifest(manifestRaw, stagingOut);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeBundleFile(join(stagingOut, PREBUILT_CLIENT_MANIFEST_FILE), manifestText);
    totalBytes += Buffer.byteLength(manifestText, 'utf8');

    let backupOut: string | undefined;
    let swapSucceeded = false;
    try {
      if (existsSync(resolvedOut)) {
        backupOut = `${stagingOut}.prev`;
        await renameAtomically(resolvedOut, backupOut);
      }
      await renameAtomically(stagingOut, resolvedOut);
      stagingCreated = false;
      swapSucceeded = true;
    } catch (swapErr) {
      let restoreErr: unknown;
      if (backupOut !== undefined && !existsSync(resolvedOut) && existsSync(backupOut)) {
        try {
          await renameAtomically(backupOut, resolvedOut);
        } catch (err) {
          restoreErr = err;
        }
      }
      if (restoreErr !== undefined) {
        const swapMsg = swapErr instanceof Error ? swapErr.message : String(swapErr);
        const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        throw new HelmxError(
          'client_compile_failed',
          `prebuilt client swap failed (${swapMsg}); backup restore failed (${restoreMsg}); previous bundle preserved at ${backupOut}`,
          500,
          { pluginId, outDir: resolvedOut, backupOut },
        );
      }
      throw swapErr;
    } finally {
      if (swapSucceeded && backupOut !== undefined) {
        rmSync(backupOut, { recursive: true, force: true });
      }
    }

    return {
      pluginId,
      clientRoot: rootReal,
      outDir: resolvedOut,
      manifestPath: join(resolvedOut, PREBUILT_CLIENT_MANIFEST_FILE),
      manifest,
      totalBytes,
    };
  } finally {
    if (stagingCreated) {
      rmSync(stagingOut, { recursive: true, force: true });
    }
  }
}
