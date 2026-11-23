#!/usr/bin/env node
/**
 * Build asset completion & incremental frontend precompilation:
 * 1. Syncs each src/<name>/client directory to dist/<name>/client;
 * 2. Precompiles every built-in UI plugin's declared client modules into dist/<name>/dist-client/
 *    (manifest.json + hashed entry/chunks + pre-gzipped .gz files) via @helmx/plugin-build so
 *    runtime hosts and @helmx/payload require zero esbuild or mermaid runtime dependencies.
 *
 * Incremental fingerprint cache:
 * - Computes a deterministic SHA-256 fingerprint per built-in plugin covering src/<name>/client/**,
 *   dist/<name>.js (+ dist/<name>/**.js excluding client/dist-client), packages/plugins/package.json,
 *   packages/plugin-build/dist/**, packages/protocol/dist/**, pnpm-lock.yaml, declared refs, and
 *   this script.
 * - Verifies dist/<name>/dist-client/manifest.json (via assertPrebuiltClientManifest) and every
 *   entry/chunk/.gz file listed in it exists on disk with matching byte size.
 * - Unchanged plugins skip wiping & esbuild compilation completely; editing one plugin rebuilds
 *   ONLY that plugin. On cache miss, dist/<name>/dist-client is wiped BEFORE re-invoking the
 *   plugin factory so plugins like builtin:mermaid attach build-time npmDependencies.
 * - Passing --force or setting HELMX_CLEAN_DIST=1 bypasses the cache and rebuilds all plugins.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PREBUILT_CLIENT_DIR_NAME,
  PREBUILT_CLIENT_MANIFEST_FILE,
  assertPrebuiltClientManifest,
  clientNpmRootsOf,
  prebuiltChunkFileName,
} from '@helmx/protocol';

const SCHEMA_VERSION = 2;
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);

const defaultPkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepoRoot = resolve(defaultPkgRoot, '../..');

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isRealDirectory(dirPath) {
  try {
    return lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively collects regular files under `rootDir` as sorted POSIX relative paths. */
function collectFilesSorted(rootDir, options = {}) {
  if (!isRealDirectory(rootDir)) return [];
  const skipTopLevelDirs = options.skipTopLevelDirs ?? null;
  const extensionFilter = options.extensions ?? null;
  const results = [];
  const walk = (dir, prefix, depth) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (depth === 0 && skipTopLevelDirs && skipTopLevelDirs.has(ent.name)) continue;
        walk(join(dir, ent.name), prefix === '' ? ent.name : `${prefix}/${ent.name}`, depth + 1);
      } else if (ent.isFile()) {
        if (IGNORED_FILE_NAMES.has(ent.name)) continue;
        if (extensionFilter && !extensionFilter.some((ext) => ent.name.endsWith(ext))) continue;
        results.push(prefix === '' ? ent.name : `${prefix}/${ent.name}`);
      }
    }
  };
  walk(rootDir, '', 0);
  return results.sort(compareAscii);
}

function hashFileInto(hash, label, absPath) {
  if (!isRegularFile(absPath)) {
    hash.update(`missing:${label}\0`);
    return;
  }
  const bytes = readFileSync(absPath);
  hash.update(`file:${label}:${bytes.byteLength}\0`);
  hash.update(bytes);
  hash.update('\0');
}

function hashDirectoryInto(hash, label, rootDir, options = {}) {
  if (!isRealDirectory(rootDir)) {
    hash.update(`missing-dir:${label}\0`);
    return;
  }
  const files = collectFilesSorted(rootDir, options);
  hash.update(`dir:${label}:${files.length}\0`);
  for (const rel of files) {
    hashFileInto(hash, `${label}/${rel}`, join(rootDir, rel));
  }
}

/**
 * Mirrors `srcDir` into `destDir` incrementally: copies only new or byte-changed files and removes
 * stale files/directories that no longer exist in `srcDir`.
 */
function syncClientDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const srcEntries = new Map(
    readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => !IGNORED_FILE_NAMES.has(e.name))
      .map((e) => [e.name, e]),
  );

  for (const existing of readdirSync(destDir, { withFileTypes: true })) {
    const match = srcEntries.get(existing.name);
    const destPath = join(destDir, existing.name);
    if (!match || match.isDirectory() !== existing.isDirectory() || existing.isSymbolicLink()) {
      rmSync(destPath, { recursive: true, force: true });
    }
  }

  for (const [name, ent] of [...srcEntries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);
    if (ent.isDirectory()) {
      syncClientDir(srcPath, destPath);
    } else if (ent.isFile()) {
      if (isRegularFile(destPath)) {
        const srcBytes = readFileSync(srcPath);
        const destBytes = readFileSync(destPath);
        if (srcBytes.equals(destBytes)) continue;
      }
      copyFileSync(srcPath, destPath);
    }
  }
}

function makeNoopProxy() {
  const fn = () => {};
  const proxy = new Proxy(fn, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

function captureClientRefs(def, pkgRoot) {
  const refs = [];
  let configState = {};
  const docStub = { get: () => ({}), set: () => {}, update: () => {}, flush: async () => {}, onChange: () => () => {} };
  const kvStub = { get: () => undefined, set: () => {}, delete: () => false, list: () => ({ items: [] }), clear: () => {}, flush: async () => {} };
  const uiProxy = new Proxy(
    {},
    {
      get(_t, _surface) {
        return (spec) => {
          if (spec && typeof spec === 'object' && spec.client && typeof spec.client === 'object') {
            refs.push({
              module: String(spec.client.module ?? ''),
              export: String(spec.client.export ?? ''),
            });
          }
        };
      },
    },
  );
  const noop = makeNoopProxy();
  const baseCtx = {
    pluginId: def.id,
    dataDir: pkgRoot,
    ui: uiProxy,
    doc: () => docStub,
    sessionDoc: () => docStub,
    kv: () => kvStub,
    configSchema: (schema) => {
      const next = {};
      if (schema && typeof schema === 'object') {
        for (const [key, field] of Object.entries(schema)) {
          if (field && typeof field === 'object' && 'default' in field) {
            next[key] = field.default;
          }
        }
      }
      configState = next;
    },
    getConfig: () => configState,
    onConfigChanged: () => () => {},
    host: noop,
  };
  const ctx = new Proxy(baseCtx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
  });
  def.definePlugin(ctx);
  return refs;
}

/**
 * Computes a shared SHA-256 digest of workspace-wide inputs that affect every built-in plugin
 * client bundle (hashed once per run and mixed into each plugin's fingerprint).
 */
export function computeSharedInputsHash(options = {}) {
  const pkgRoot = resolve(options.pkgRoot ?? defaultPkgRoot);
  const repoRoot = resolve(options.repoRoot ?? resolve(pkgRoot, '../..'));
  const distPlugins = join(pkgRoot, 'dist');
  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url);

  const hash = createHash('sha256');
  hash.update(`plugin-clients-shared-schema:${SCHEMA_VERSION}\0`);
  hashFileInto(hash, 'plugins/package.json', join(pkgRoot, 'package.json'));
  hashFileInto(hash, 'plugins/dist/index.js', join(distPlugins, 'index.js'));
  hashFileInto(hash, 'plugins/dist/asset-paths.js', join(distPlugins, 'asset-paths.js'));
  hashFileInto(hash, 'plugins/dist/contracts.js', join(distPlugins, 'contracts.js'));
  hashFileInto(hash, 'plugins/scripts/copy-plugin-clients.mjs', scriptPath);
  hashDirectoryInto(hash, 'plugin-build/dist', join(repoRoot, 'packages/plugin-build/dist'));
  hashDirectoryInto(hash, 'protocol/dist', join(repoRoot, 'packages/protocol/dist'));
  hashFileInto(hash, 'pnpm-lock.yaml', join(repoRoot, 'pnpm-lock.yaml'));
  return hash.digest('hex');
}

/**
 * Computes a deterministic SHA-256 fingerprint for a single built-in plugin's prebuilt client.
 */
export function computePluginClientFingerprint({
  pkgRoot = defaultPkgRoot,
  pluginDirName,
  pluginId,
  refs,
  sharedInputsHash,
}) {
  const resolvedPkgRoot = resolve(pkgRoot);
  const srcPlugins = join(resolvedPkgRoot, 'src');
  const distPlugins = join(resolvedPkgRoot, 'dist');

  const hash = createHash('sha256');
  hash.update(`plugin-client-schema:${SCHEMA_VERSION}\0`);
  hash.update(`plugin:${pluginId}:${pluginDirName}\0`);
  hash.update(`shared:${sharedInputsHash}\0`);

  const sortedRefs = [...refs]
    .map((r) => `${r.module}\u001f${r.export}`)
    .sort();
  hash.update(`refs:${sortedRefs.length}\0${sortedRefs.join('\0')}\0`);

  hashDirectoryInto(hash, `src/${pluginDirName}/client`, join(srcPlugins, pluginDirName, 'client'));
  hashFileInto(hash, `dist/${pluginDirName}.js`, join(distPlugins, `${pluginDirName}.js`));
  hashDirectoryInto(hash, `dist/${pluginDirName}`, join(distPlugins, pluginDirName), {
    skipTopLevelDirs: new Set(['client', PREBUILT_CLIENT_DIR_NAME]),
    extensions: ['.js', '.mjs', '.cjs'],
  });

  return hash.digest('hex');
}

/** Enumerates every file required on disk by a validated `PrebuiltClientManifest` (relative POSIX paths). */
function requiredFilesForManifest(manifest, pluginId) {
  const required = [PREBUILT_CLIENT_MANIFEST_FILE];
  for (const moduleRef of Object.keys(manifest.modules).sort()) {
    const entry = manifest.modules[moduleRef];
    required.push(entry.entryFile, `${entry.entryFile}.gz`);
    for (const chunkName of [...(entry.chunks ?? [])].sort()) {
      const chunkFile = prebuiltChunkFileName(entry.entryFile, chunkName, pluginId);
      required.push(chunkFile, `${chunkFile}.gz`);
    }
  }
  return required;
}

/**
 * Validates that `outDir` contains a valid `manifest.json` matching `refs` AND that every single
 * entry, chunk, and `.gz` file referenced by the manifest exists on disk (and matches cached sizes
 * when provided).
 */
export function verifyPrebuiltClientDir(outDir, pluginId, refs, expectedFileSizes = null) {
  const manifestPath = join(outDir, PREBUILT_CLIENT_MANIFEST_FILE);
  if (!isRegularFile(manifestPath)) {
    return { ok: false, reason: 'missing manifest.json' };
  }

  let manifest;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest = assertPrebuiltClientManifest(raw, outDir);
  } catch (err) {
    return { ok: false, reason: `invalid manifest.json: ${err instanceof Error ? err.message : String(err)}` };
  }

  const expectedModules = [...new Set(refs.map((r) => r.module))].sort();
  const actualModules = Object.keys(manifest.modules).sort();
  if (
    expectedModules.length !== actualModules.length ||
    expectedModules.some((m, idx) => actualModules[idx] !== m)
  ) {
    return { ok: false, reason: 'manifest modules do not match declared client modules' };
  }

  for (const ref of refs) {
    const entry = manifest.modules[ref.module];
    if (!entry || !entry.exports.includes(ref.export)) {
      return { ok: false, reason: `manifest missing export ${ref.export} in ${ref.module}` };
    }
  }

  const requiredFiles = requiredFilesForManifest(manifest, pluginId).sort(compareAscii);
  const actualFiles = collectFilesSorted(outDir);
  if (
    actualFiles.length !== requiredFiles.length ||
    actualFiles.some((f, idx) => requiredFiles[idx] !== f)
  ) {
    return { ok: false, reason: 'prebuilt dist-client directory files do not match manifest.json' };
  }
  const fileSizes = {};
  let totalBytes = 0;
  for (const rel of requiredFiles) {
    const abs = join(outDir, rel);
    if (!isRegularFile(abs)) {
      return { ok: false, reason: `missing prebuilt artifact: ${rel}` };
    }
    const size = statSync(abs).size;
    if (expectedFileSizes && expectedFileSizes[rel] !== size) {
      return { ok: false, reason: `artifact byte size changed: ${rel}` };
    }
    fileSizes[rel] = size;
    totalBytes += size;
  }

  return { ok: true, manifest, fileSizes, totalBytes };
}

function readCacheFile(cacheFile) {
  if (!isRegularFile(cacheFile)) return { schemaVersion: SCHEMA_VERSION, plugins: {} };
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION) {
      return { schemaVersion: SCHEMA_VERSION, plugins: {} };
    }
    if (!parsed.plugins || typeof parsed.plugins !== 'object' || Array.isArray(parsed.plugins)) {
      return { schemaVersion: SCHEMA_VERSION, plugins: {} };
    }
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, plugins: {} };
  }
}

function writeCacheFileAtomic(cacheFile, data) {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmpFile, cacheFile);
}

/**
 * Copies plugin client sources and incrementally precompiles each built-in UI plugin's
 * `dist-client/` directory.
 */
export async function copyAndPrebuildPluginClients(options = {}) {
  const pkgRoot = resolve(options.pkgRoot ?? defaultPkgRoot);
  const repoRoot = resolve(options.repoRoot ?? resolve(pkgRoot, '../..'));
  const srcPlugins = join(pkgRoot, 'src');
  const distPlugins = join(pkgRoot, 'dist');
  const env = options.env ?? process.env;
  const argv = options.argv ?? [];
  const force =
    options.force === true || argv.includes('--force') || argv.includes('-f') || env.HELMX_CLEAN_DIST === '1';
  const quiet = options.quiet === true;
  const cacheFile = resolve(
    options.cacheFile ??
      join(repoRoot, 'node_modules', '.cache', 'helmx-build', 'plugin-clients-fingerprint.json'),
  );
  let buildBundle = options.buildBundle ?? null;

  if (!existsSync(distPlugins)) {
    throw new Error(`[plugins] ${distPlugins} is missing; run the tsc build first`);
  }

  // Step 1: Mirror each src/<name>/client dir into dist/<name>/client without wiping valid
  // dist-client/ bundles (wiping happens selectively on cache miss or force).
  const clientPluginDirs = [];
  let copied = 0;
  for (const entry of readdirSync(srcPlugins, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const clientSrc = join(srcPlugins, entry.name, 'client');
    if (!existsSync(clientSrc)) continue;
    syncClientDir(clientSrc, join(distPlugins, entry.name, 'client'));
    clientPluginDirs.push(entry.name);
    copied += 1;
  }

  if (force) {
    rmSync(cacheFile, { force: true });
  }

  const priorCache = force ? { schemaVersion: SCHEMA_VERSION, plugins: {} } : readCacheFile(cacheFile);
  const sharedInputsHash = computeSharedInputsHash({ pkgRoot, repoRoot });

  // Fast path: when all plugins in src/*/client have valid matching fingerprints and verified
  // dist-client outputs (including dist/index.js and every dist/<name>.js unchanged), skip
  // loading dist/index.js and @helmx/plugin-build (esbuild) altogether.
  if (
    !force &&
    options.pluginsModule === undefined &&
    Array.isArray(priorCache.clientPluginDirs) &&
    priorCache.clientPluginDirs.length === clientPluginDirs.length &&
    priorCache.clientPluginDirs.every((dirName, idx) => dirName === clientPluginDirs[idx]) &&
    clientPluginDirs.length > 0
  ) {
    let allFastHit = true;
    let fastModules = 0;
    let fastBytes = 0;
    for (const dirName of clientPluginDirs) {
      const entry = priorCache.plugins?.[dirName];
      if (!entry || typeof entry.pluginId !== 'string' || !Array.isArray(entry.refs)) {
        allFastHit = false;
        break;
      }
      const fp = computePluginClientFingerprint({
        pkgRoot,
        pluginDirName: dirName,
        pluginId: entry.pluginId,
        refs: entry.refs,
        sharedInputsHash,
      });
      if (fp !== entry.fingerprint) {
        allFastHit = false;
        break;
      }
      const outDir = join(distPlugins, dirName, PREBUILT_CLIENT_DIR_NAME);
      const check = verifyPrebuiltClientDir(outDir, entry.pluginId, entry.refs, entry.fileSizes ?? null);
      if (!check.ok) {
        allFastHit = false;
        break;
      }
      fastModules += new Set(entry.refs.map((r) => r.module)).size;
      fastBytes += check.totalBytes;
    }
    if (allFastHit) {
      if (!quiet) {
        console.log(
          `[plugins] copied ${copied} client dirs and prebuilt ${clientPluginDirs.length} dist-client bundles (0 rebuilt, ${clientPluginDirs.length} cached; ${fastModules} modules, ${(fastBytes / 1024).toFixed(1)} KiB)`,
        );
      }
      return {
        copied,
        totalPlugins: clientPluginDirs.length,
        rebuilt: [],
        cached: [...clientPluginDirs],
        totalModules: fastModules,
        totalBytes: fastBytes,
      };
    }
  }

  const nextPluginsCache = {};

  // Step 2: Load compiled plugin factories from dist/index.js and precompile only changed/invalid plugins.
  const entryUrl = pathToFileURL(join(distPlugins, 'index.js')).href;
  const importUrl = options.importCacheBust ? `${entryUrl}?t=${encodeURIComponent(String(options.importCacheBust))}` : entryUrl;
  const pluginsMod = options.pluginsModule ?? (await import(importUrl));

  const prebuiltDirs = new Set();
  const rebuilt = [];
  const cached = [];
  let totalModules = 0;
  let totalBytes = 0;

  for (const [exportName, factory] of Object.entries(pluginsMod).sort(([a], [b]) => compareAscii(a, b))) {
    if (!exportName.startsWith('create') || !exportName.endsWith('Plugin') || typeof factory !== 'function') continue;

    const initialDef = factory();
    const initialRefs = captureClientRefs(initialDef, pkgRoot);
    if (initialRefs.length === 0) continue;
    if (!initialDef.clientRoot) {
      throw new Error(`[plugins] built-in plugin ${initialDef.id} (${exportName}) declared client refs without clientRoot`);
    }

    const pluginDirName = basename(dirname(initialDef.clientRoot));
    const outDir = join(distPlugins, pluginDirName, PREBUILT_CLIENT_DIR_NAME);
    const fingerprint = computePluginClientFingerprint({
      pkgRoot,
      pluginDirName,
      pluginId: initialDef.id,
      refs: initialRefs,
      sharedInputsHash,
    });

    const cachedEntry = priorCache.plugins?.[pluginDirName];
    if (!force && cachedEntry && cachedEntry.fingerprint === fingerprint) {
      const check = verifyPrebuiltClientDir(
        outDir,
        initialDef.id,
        initialRefs,
        cachedEntry.fileSizes ?? null,
      );
      if (check.ok) {
        prebuiltDirs.add(pluginDirName);
        cached.push(pluginDirName);
        const modules = [...new Set(initialRefs.map((r) => r.module))];
        totalModules += modules.length;
        totalBytes += check.totalBytes;
        nextPluginsCache[pluginDirName] = {
          pluginId: initialDef.id,
          refs: initialRefs,
          fingerprint,
          fileSizes: check.fileSizes,
        };
        continue;
      }
    }

    // Cache miss or forced rebuild: wipe stale dist-client/ BEFORE re-invoking the plugin factory
    // so plugins like builtin:mermaid inspect source mode and attach build-time npmDependencies.
    rmSync(outDir, { recursive: true, force: true });
    const buildDef = factory();
    const buildRefs = captureClientRefs(buildDef, pkgRoot);
    if (!buildDef.clientRoot) {
      throw new Error(`[plugins] built-in plugin ${buildDef.id} (${exportName}) declared client refs without clientRoot`);
    }
    const modules = [...new Set(buildRefs.map((r) => r.module))];
    if (!buildBundle) {
      ({ buildPluginClientBundleDir: buildBundle } = await import('@helmx/plugin-build'));
    }
    const built = await buildBundle({
      pluginId: buildDef.id,
      clientRoot: buildDef.clientRoot,
      outDir,
      modules,
      npmRoots: clientNpmRootsOf(buildDef.npmDependencies),
    });

    for (const ref of buildRefs) {
      const entry = built.manifest.modules[ref.module];
      if (!entry) {
        throw new Error(`[plugins] prebuilt manifest missing ${ref.module} for ${buildDef.id}`);
      }
      if (!entry.exports.includes(ref.export)) {
        throw new Error(
          `[plugins] prebuilt module ${ref.module} for ${buildDef.id} is missing export "${ref.export}" (exports: ${entry.exports.join(', ')})`,
        );
      }
    }

    const postCheck = verifyPrebuiltClientDir(outDir, buildDef.id, buildRefs);
    if (!postCheck.ok) {
      throw new Error(`[plugins] prebuilt dist-client verification failed for ${buildDef.id}: ${postCheck.reason}`);
    }

    const finalFingerprint = computePluginClientFingerprint({
      pkgRoot,
      pluginDirName,
      pluginId: buildDef.id,
      refs: buildRefs,
      sharedInputsHash,
    });
    nextPluginsCache[pluginDirName] = {
      pluginId: buildDef.id,
      refs: buildRefs,
      fingerprint: finalFingerprint,
      fileSizes: postCheck.fileSizes,
    };

    prebuiltDirs.add(pluginDirName);
    rebuilt.push(pluginDirName);
    totalModules += modules.length;
    totalBytes += built.totalBytes;
  }

  const missingPrebuilt = clientPluginDirs.filter(
    (dirName) => !prebuiltDirs.has(dirName) || !existsSync(join(distPlugins, dirName, PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)),
  );
  if (missingPrebuilt.length > 0) {
    throw new Error(`[plugins] built-in UI plugin directories missing prebuilt dist-client: ${missingPrebuilt.join(', ')}`);
  }

  writeCacheFileAtomic(cacheFile, {
    schemaVersion: SCHEMA_VERSION,
    clientPluginDirs,
    plugins: nextPluginsCache,
  });

  if (!quiet) {
    console.log(
      `[plugins] copied ${copied} client dirs and prebuilt ${prebuiltDirs.size} dist-client bundles (${rebuilt.length} rebuilt, ${cached.length} cached; ${totalModules} modules, ${(totalBytes / 1024).toFixed(1)} KiB)`,
    );
  }

  return {
    copied,
    totalPlugins: prebuiltDirs.size,
    rebuilt,
    cached,
    totalModules,
    totalBytes,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    await copyAndPrebuildPluginClients({ argv: process.argv.slice(2) });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
