/**
 * Automatic discovery and dynamic loading of external plugin directories.
 *
 * Module layout: manifest parsing (`plugin.json` / `package.json#helmx` field) lives in
 * `plugin-manifest.ts`; startup full scans and incremental rescans (`loadExternalPlugins` /
 * `rescanExternalPlugins`) live in `scan-visitor.ts`; this module owns entrypoint resolution,
 * module import & definition boundary validation, definition normalization, controlled hot reload
 * (`reload`), and source directory lookup.
 *
 * Physical directory separation (eliminates `ctx.dataDir` blind-probe execution risk):
 * 1. `<dataDir>/plugins/<pluginDataDirName(pluginId)>` is strictly per-plugin runtime data
 *    (`ctx.dataDir`) and is NEVER scanned for executable code;
 * 2. `<dataDir>/installed-plugins/<dir>` is the sole external plugin code root (both managed
 *    package installs and hand-placed dev plugins).
 *
 * Explicit manifest rules (no blind convention probing of `index.js`/`index.ts` or plain `package.json`):
 * - Every external plugin directory MUST contain either `plugin.json` (with a non-empty string
 *   `main`) or `package.json` with an explicit `"helmx"` object declaring `helmx.main`.
 * - Missing manifests fail explicitly with `plugin_manifest_missing` without importing any file;
 *   corrupt manifests, non-objects, missing/invalid `main`, path traversal, symlink escapes, or
 *   missing entry files throw explicit `HelmxError`s (`plugin_manifest_invalid` / `plugin_entry_missing`).
 * - `.ts` / `.tsx` / `.mts` / `.cts` entrypoints are transpiled in-process by `backend-ts-loader`.
 * - IO errors: only ENOENT / ENOTDIR count as missing files; EACCES and other IO errors throw explicitly.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HelmxError,
  PREBUILT_CLIENT_DIR_NAME,
  isBuiltinNamespace,
  isCoreNamespace,
  isReservedPluginNamespace,
  parseNonEmptyLocalizedText,
  type LocalizedText,
  type PluginBuildProvider,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helmx/protocol';
import { registerPluginTsRoot, nextPluginGeneration, type BackendTsTransformFn } from './backend-ts-loader.js';
import { externalPluginsDir } from './plugin-dir-name.js';
import {
  MANIFEST_PLUGIN_ID_PATTERN,
  readHelmxClientDependencies,
  readHelmxClientDist,
  readHelmxClientRoot,
  readHelmxField,
  readManifest,
  readManifestOptional,
} from './plugin-manifest.js';
import { readPrebuiltClientManifest, verifyPrebuiltClientDir } from './ui-registry.js';

/** Minimal host surface required for loading (structurally compatible with PluginHost for isolated tests). */
export interface ExternalPluginHost {
  register(
    definition: PluginDefinition,
    options?: { enabled?: boolean; isolateFailure?: boolean },
  ): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
  /** Optional: register a failed placeholder during scan/load (provided by PluginHost; test stubs without it preserve throw behavior). */
  registerFailed?(spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  }): void;
  /**
   * Optional host build port accessor (provided by PluginHost): obtains the external-plugin TS
   * transpiler from PluginHostOptions.buildProvider. When missing, loading TS sources rejects explicitly
   * (`unsupported_backend_ts_build`); plain JS plugins are unaffected.
   */
  getBuildProvider?(): PluginBuildProvider | undefined;
}

/** Extract the backend TS transpile function from a host-like object (returns undefined when build port is unwired; shared with scan-visitor). */
export function tsTransformOf(
  host: { getBuildProvider?(): PluginBuildProvider | undefined },
): BackendTsTransformFn | undefined {
  return host.getBuildProvider?.()?.transformBackendTs;
}

/** Full host surface required for reload/rescan (adds unregister; structurally compatible with PluginHost). */
export interface ReloadablePluginHost extends ExternalPluginHost {
  unregister(pluginId: string): Promise<void>;
}

// Full/incremental scan implementation lives in scan-visitor.ts; re-exported here to preserve existing public exports
// (used by hub tests and production consumers).
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';

// ---------------------------------------------------------------------------
// Entrypoint resolution (explicit manifest required; zero blind probing)
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin directory's explicit entrypoint file from `plugin.json` (`main`) or
 * `package.json#helmx` (`helmx.main`). Directories without an explicit Helmx manifest reject
 * loudly with `plugin_manifest_missing` (never blindly probing `index.*` or plain `package.json`).
 */
export async function resolvePluginEntry(dirPath: string): Promise<string> {
  const manifestPath = join(dirPath, 'plugin.json');
  let manifestExists = true;
  try {
    statSync(manifestPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new HelmxError(
        'plugin_scan_failed',
        `external plugin directory cannot read: ${manifestPath}(${err instanceof Error ? err.message : String(err)})`,
        500,
        { manifestPath, code },
      );
    }
    manifestExists = false;
  }
  if (!manifestExists) {
    const helmx = readHelmxField(dirPath);
    if (helmx === null) {
      throw new HelmxError(
        'plugin_manifest_missing',
        `External plugin ${dirPath} is missing an explicit manifest (requires plugin.json or package.json#helmx with "main")`,
        400,
        { dirPath },
      );
    }
    const mainSpec = helmx.main;
    if (mainSpec === undefined) {
      throw new HelmxError(
        'plugin_manifest_invalid',
        `External plugin ${dirPath} package.json helmx manifest must declare a non-empty string "main" entrypoint`,
        400,
        { dirPath },
      );
    }
    // Check lexical containment before probing matching TS sources for compiled `.js`/`.mjs`/`.cjs` declarations.
    const dirAbs = resolve(dirPath);
    const dirReal = realpathSync(dirAbs);
    if (isLexicallyOutsidePluginDir(dirAbs, dirReal, mainSpec, resolve(dirAbs, mainSpec))) {
      throw new HelmxError(
        'plugin_manifest_invalid',
        `External plugin ${dirPath} package.json helmx.main escapes plugin directory: ${mainSpec}`,
        400,
        { dirPath, main: mainSpec },
      );
    }
    const tsCandidate = mainSpec.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts');
    if (tsCandidate !== mainSpec) {
      try {
        return resolveManifestEntryFile(dirPath, tsCandidate, 'package.json helmx.main');
      } catch (err) {
        if (!(err instanceof HelmxError) || err.code !== 'plugin_entry_missing') throw err;
      }
    }
    return resolveManifestEntryFile(dirPath, mainSpec, 'package.json helmx.main');
  }
  const manifest = readManifest(manifestPath);
  const main = manifest['main'];
  if (typeof main !== 'string' || main.length === 0) {
    throw new HelmxError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json main must be a non-empty string`,
      400,
      { dirPath, ...(main !== undefined ? { main: String(main) } : {}) },
    );
  }
  return resolveManifestEntryFile(dirPath, main, 'plugin.json main');
}

function resolveManifestEntryFile(dirPath: string, rawMain: string, fieldLabel: string): string {
  const dirAbs = resolve(dirPath);
  const dirReal = realpathSync(dirAbs);
  const entry = resolve(dirAbs, rawMain);
  if (isLexicallyOutsidePluginDir(dirAbs, dirReal, rawMain, entry)) {
    throw new HelmxError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} ${fieldLabel} escapes plugin directory: ${rawMain}`,
      400,
      { dirPath, main: rawMain },
    );
  }
  return assertEntryFile(dirPath, rawMain, entry, dirReal);
}

/** Confirms entrypoint is a regular file inside `dirPath` (symlink escapes fail loudly). */
function assertEntryFile(dirPath: string, main: string, entry: string, dirReal = realpathSync(dirPath)): string {
  let real: string;
  let isFile: boolean;
  try {
    real = realpathSync(entry);
    isFile = statSync(real).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new HelmxError('plugin_entry_missing', `External plugin ${dirPath} entry file is missing: ${main}`, 500, {
        dirPath,
        main,
      });
    }
    throw new HelmxError(
      'plugin_scan_failed',
      `External plugin entry cannot be read: ${entry} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, main, code },
    );
  }
  if (!isFile) {
    throw new HelmxError('plugin_entry_missing', `External plugin ${dirPath} entry is not a regular file: ${main}`, 500, {
      dirPath,
      main,
    });
  }
  if (isOutsideBase(dirReal, real)) {
    throw new HelmxError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json main (resolved symlink) escapes plugin directory: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return real;
}
/** Validates plugin dependencies declared in JS definition (invalid shapes fail explicitly). */
function normalizeCodeDependencies(
  dirPath: string,
  pluginId: string,
  values: unknown,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(value))) {
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} definition ${pluginId}.dependencies must be an array of plugin IDs (letters, digits, :, _, - only)`,
      400,
      { dirPath, pluginId, dependencies: Array.isArray(values) ? values.map((value) => String(value)) : String(values) },
    );
  }
  return [...new Set(values as string[])];

}

// ---------------------------------------------------------------------------
// Module import & definition validation
// ---------------------------------------------------------------------------

/** Dynamically imports plugin entrypoint (with optional generation cache-buster) and extracts `default`/`plugin` export. */
export async function importPluginDefinition(
  dirPath: string,
  entryPath: string,
  options: { generation?: number } = {},
): Promise<PluginDefinition> {
  const entryUrl =
    options.generation === undefined
      ? pathToFileURL(entryPath).href
      : `${pathToFileURL(entryPath).href}?helmxgen=${options.generation}`;
  let mod: { default?: unknown; plugin?: unknown };
  try {
    mod = (await import(entryUrl)) as { default?: unknown; plugin?: unknown };
  } catch (err) {
    if (err instanceof HelmxError) throw err; // Transpilation error already carries file/line diagnostics.
    throw new HelmxError(
      'plugin_load_failed',
      `Failed to load external plugin module: ${entryPath}${options.generation !== undefined ? ` (generation ${options.generation})` : ''} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, entryPath, cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined },
    );
  }
  const candidate = mod.default ?? mod.plugin;
  return assertExternalDefinition(candidate, dirPath);
}

/**
 * Validates an external plugin module's exported definition: requires non-empty `id` (no `builtin:` prefix or `:`),
 * optional localized `name`, and `definePlugin` function.
 */
export function assertExternalDefinition(candidate: unknown, dirPath: string): PluginDefinition {
  const fail = (detail: string): HelmxError =>
    new HelmxError('invalid_plugin_definition', `Invalid external plugin export in ${dirPath}: ${detail}`, 400, { dirPath });
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw fail('did not export a default or plugin definition object');
  }
  const def = candidate as Record<string, unknown>;
  if (typeof def.id !== 'string' || def.id.length === 0) throw fail('missing non-empty string id');
  if (def.name !== undefined && parseNonEmptyLocalizedText(def.name) === undefined) {
    throw fail(`name provide when must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`);
  }
  if (def.icon !== undefined && (typeof def.icon !== 'string' || def.icon.trim().length === 0)) {
    throw fail('icon must be a non-empty string when provided');
  }
  if (isReservedPluginNamespace(def.id)) {
    const reservedPrefix = isCoreNamespace(def.id) ? 'core:' : 'builtin:';
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} id cannot start with '${reservedPrefix}': ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (def.id.includes(':')) {
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} id cannot contain ':' (smoke number; colons are reserved for builtin: and core: namespaces): ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (typeof def.definePlugin !== 'function') {
    throw fail('missing definePlugin function (external plugins must implement PluginDefinition)');
  }
  return def as unknown as PluginDefinition;
}

/**
 * External plugin definition normalization:
 * - Strip `locked` (external plugins cannot mark themselves resident/non-unloadable);
 * - Cross-plugin dependencies: merge & deduplicate code and manifest (`plugin.json` `dependencies` /
 *   `package.json#helmx.dependencies`); invalid manifest values already fail when read;
 * - Frontend controlled npm dependencies: normalize manifest specifiers (`plugin.json` `clientDependencies` /
 *   `package.json#helmx.clientDependencies`) into `npmDependencies` anchored at the plugin directory itself
 *   while stripping code-declared `npmDependencies` so external plugins cannot open arbitrary bare dependencies;
 * - Default missing `clientRoot` to the plugin directory itself; require a string when provided; resolve
 *   relative paths inside the plugin directory (escapes reject explicitly); preserve absolute paths.
 *   Path bounds enforce a convention only and do not constitute a security sandbox.
 */
function isOutsideBase(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Checks lexical containment against `resolve(dirPath)` (and `dirReal` when `rawPath` is absolute) so
 * Windows 8.3 short paths (`RUNNER~1`) or symlinked parent dirs (`/var` -> `/private/var`) do not fail spuriously.
 */
function isLexicallyOutsidePluginDir(
  dirAbs: string,
  dirReal: string | undefined,
  rawPath: string,
  resolvedPath: string,
): boolean {
  if (!isAbsolute(rawPath)) {
    return isOutsideBase(dirAbs, resolvedPath);
  }
  return isOutsideBase(dirAbs, resolvedPath) && (dirReal === undefined || isOutsideBase(dirReal, resolvedPath));
}

function resolveNearestRealpathSync(target: string): { kind: 'ok'; real: string } | { kind: 'dangling-symlink' } {
  let cur = target;
  for (;;) {
    try {
      return { kind: 'ok', real: realpathSync(cur) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      // A dangling symlink fails realpathSync with ENOENT; surface it as a symlink escape rather than skipping to parent.
      try {
        if (lstatSync(cur).isSymbolicLink()) return { kind: 'dangling-symlink' };
      } catch {
        // Missing component: walk up to nearest existing ancestor.
      }
      const parent = dirname(cur);
      if (parent === cur) throw err;
      cur = parent;
    }
  }
}

function assertContainedInPluginDir(
  dirPath: string,
  dirReal: string,
  rawPath: string,
  resolvedPath: string,
  fieldLabel: string,
): void {
  const dirAbs = resolve(dirPath);
  if (isLexicallyOutsidePluginDir(dirAbs, dirReal, rawPath, resolvedPath)) {
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} ${fieldLabel} escapes plugin directory: ${rawPath}`,
      400,
      { dirPath, [fieldLabel]: rawPath },
    );
  }
  try {
    const resolved = resolveNearestRealpathSync(resolvedPath);
    if (resolved.kind === 'dangling-symlink' || isOutsideBase(dirReal, resolved.real)) {
      throw new HelmxError(
        'invalid_plugin_definition',
        `External plugin ${dirPath} ${fieldLabel} symlink escapes plugin directory: ${rawPath}`,
        400,
        { dirPath, [fieldLabel]: rawPath },
      );
    }
  } catch (err) {
    if (err instanceof HelmxError) throw err;
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} ${fieldLabel} cannot be accessed: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { dirPath, [fieldLabel]: rawPath },
    );
  }
}

function resolveExternalPrebuiltClientDir(
  dirPath: string,
  dirReal: string,
  pluginId: string,
  codePrebuiltDir: unknown,
): string | undefined {
  if (codePrebuiltDir !== undefined && codePrebuiltDir !== '') {
    if (typeof codePrebuiltDir !== 'string') {
      throw new HelmxError(
        'invalid_plugin_definition',
        `External plugin ${dirPath} prebuiltClientDir must be a non-empty string`,
        400,
        { dirPath, prebuiltClientDir: String(codePrebuiltDir) },
      );
    }
    const resolvedPrebuilt = resolve(dirPath, codePrebuiltDir);
    assertContainedInPluginDir(dirPath, dirReal, codePrebuiltDir, resolvedPrebuilt, 'prebuiltClientDir');
    const { rootReal } = readPrebuiltClientManifest(resolvedPrebuilt, pluginId);
    return rootReal;
  }
  const helmxClientDist = readHelmxClientDist(dirPath);
  if (helmxClientDist !== undefined) {
    const resolvedDist = resolve(dirPath, helmxClientDist);
    assertContainedInPluginDir(dirPath, dirReal, helmxClientDist, resolvedDist, 'clientDist');
    const { rootReal } = readPrebuiltClientManifest(resolvedDist, pluginId);
    return rootReal;
  }
  const defaultDist = join(dirPath, PREBUILT_CLIENT_DIR_NAME);
  try {
    lstatSync(defaultDist);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new HelmxError(
      'prebuilt_client_invalid',
      `External plugin ${dirPath} ${PREBUILT_CLIENT_DIR_NAME} cannot be accessed: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { dirPath, prebuiltClientDir: defaultDist },
    );
  }
  assertContainedInPluginDir(dirPath, dirReal, PREBUILT_CLIENT_DIR_NAME, defaultDist, PREBUILT_CLIENT_DIR_NAME);
  const { rootReal } = readPrebuiltClientManifest(defaultDist, pluginId);
  return rootReal;
}

/**
 * Checks whether `dirPath` contains a valid manifest-declared or conventional prebuilt frontend
 * bundle (`clientDist` / `dist-client/`). Throws explicitly on invalid/escaping bundles; returns
 * `undefined` only when no prebuilt client directory is declared or present on disk.
 */
export function verifyDeclaredPrebuiltDir(dirPath: string): string | undefined {
  const dirReal = realpathSync(dirPath);
  const prebuiltRoot = resolveExternalPrebuiltClientDir(dirPath, dirReal, dirPath, undefined);
  if (prebuiltRoot === undefined) return undefined;
  return verifyPrebuiltClientDir(prebuiltRoot, dirPath).rootReal;
}

/** Package-internal mapping from normalized external `PluginDefinition` to its canonical source root directory (`realpath`), allowing `PluginHost` to bind `registerPluginTsRoot` to the registered plugin instance lifetime. */
const definitionTsRoots = new WeakMap<PluginDefinition, string>();

export function getDefinitionTsRoot(definition: PluginDefinition): string | undefined {
  return definitionTsRoots.get(definition);
}

export function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
  const normalized = { ...definition };
  delete normalized.locked;
  // Frontend controlled npm dependencies: external plugins honor manifest declarations anchored to dirPath only.
  const clientDeps = readHelmxClientDependencies(dirPath);
  delete normalized.npmDependencies;
  if (clientDeps.length > 0) {
    normalized.npmDependencies = Object.fromEntries(clientDeps.map((spec) => [spec, dirPath]));
  }
  // Cross-plugin dependencies: merge & deduplicate code and manifest (`plugin.json` and `package.json#helmx`);
  // self-dependencies are rejected at the host registration boundary.
  const codeDeps = normalizeCodeDependencies(dirPath, definition.id, definition.dependencies);
  const manifestDeps = [
    ...(readManifestOptional(dirPath)?.dependencies ?? []),
    ...(readHelmxField(dirPath)?.dependencies ?? []),
  ];
  const seenDeps = new Set<string>();
  const mergedDeps: string[] = [];
  for (const dep of [...codeDeps, ...manifestDeps]) {
    if (seenDeps.has(dep)) continue;
    seenDeps.add(dep);
    mergedDeps.push(dep);
  }
  if (mergedDeps.length > 0) {
    normalized.dependencies = mergedDeps;
  } else {
    delete normalized.dependencies;
  }
  const dirReal = realpathSync(dirPath);
  const resolvedPrebuilt = resolveExternalPrebuiltClientDir(
    dirPath,
    dirReal,
    definition.id,
    normalized.prebuiltClientDir,
  );
  if (resolvedPrebuilt !== undefined) {
    normalized.prebuiltClientDir = resolvedPrebuilt;
  } else {
    delete normalized.prebuiltClientDir;
  }
  const clientRoot = normalized.clientRoot;
  if (clientRoot === undefined || clientRoot === '') {
    // When not explicitly declared, read `plugin.json` / `package.json#helmx.clientRoot`;
    // only default to the plugin directory itself if no prebuilt `dist-client` bundle exists.
    const helmxClientRoot = readHelmxClientRoot(dirPath);
    if (helmxClientRoot !== undefined) {
      const resolvedRoot = resolve(dirPath, helmxClientRoot);
      assertContainedInPluginDir(dirPath, dirReal, helmxClientRoot, resolvedRoot, 'clientRoot');
      normalized.clientRoot = resolvedRoot;
      definitionTsRoots.set(normalized, dirReal);
      return normalized;
    }
    if (normalized.prebuiltClientDir === undefined) {
      normalized.clientRoot = dirPath;
    } else {
      delete normalized.clientRoot;
    }
    definitionTsRoots.set(normalized, dirReal);
    return normalized;
  }
  if (typeof clientRoot !== 'string' || clientRoot.length === 0) {
    throw new HelmxError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} clientRoot must be a non-empty string`,
      400,
      { dirPath, clientRoot: String(clientRoot) },
    );
  }
  if (!isAbsolute(clientRoot)) {
    const resolvedRoot = resolve(dirPath, clientRoot);
    assertContainedInPluginDir(dirPath, dirReal, clientRoot, resolvedRoot, 'clientRoot');
    normalized.clientRoot = resolvedRoot;
  }
  definitionTsRoots.set(normalized, dirReal);
  return normalized;
}

// ---------------------------------------------------------------------------
// DX loop: controlled hot reload (reload) and incremental rescan (rescan)
// ---------------------------------------------------------------------------

/**
 * Scan plugin directories and return the absolute path of the source directory whose definition id
 * equals the target `pluginId`. Follows the same resolution chain as startup scan (resolvePluginEntry
 * + import definition to inspect real id), so directory names differing from plugin id still match.
 * Returns undefined when absent (multiple hits indicate conflicting directories and throw explicitly).
 * Note: probing initializes modules (without cache-busting query strings for normal imports, consistent
 * with startup scan); registered plugins hit ESM cache and yield the old proxy definition object, which
 * reload keeps for rollback on switch failure.
 */
export async function findSourceDirByPluginId(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<string | undefined> {
  const found = await findPluginSource(dataDir, pluginId, options);
  return found?.dir;
}

/** Scan hit: source directory path plus imported definition (for registered plugins, hits ESM cache with old proxy def). */
interface PluginSourceLocation {
  dir: string;
  definition: PluginDefinition;
}

async function findPluginSource(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<PluginSourceLocation | undefined> {
  const pluginsDir = externalPluginsDir(dataDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const hits: PluginSourceLocation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    // Corruption in unrelated directories must not break the whole scan; if the target's own directory
    // fails to parse, its source itself is broken and the caller receives missing-source error.
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform: options.transform });
    try {
      const entryPath = await resolvePluginEntry(dirPath);
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (definition.id === pluginId) hits.push({ dir: dirPath, definition });
    } catch {
      // Corrupt directory or unimportable entry: skip and continue scanning (valid targets still resolve).
      continue;
    } finally {
      releaseTsRoot();
    }
  }
  if (hits.length > 1) {
    throw new HelmxError(
      'plugin_reload_ambiguous',
      `multiple plugin directories declare id ${pluginId}: ${hits.map((h) => h.dir).join(', ')}; cannot determine reload source`,
      409,
      { pluginId, dirs: hits.map((h) => h.dir) },
    );
  }
  return hits[0];
}

/**
 * Controlled hot reload for external plugins:
 * 1. Restricted to external plugins (`builtin:*` prefix always rejected with 403);
 * 2. Dry-run preflight via doctor (cache-busting import + temp-host register + client compile): any failure
 *    throws explicitly and leaves the live instance untouched;
 * 3. Atomic swap: unregister old instance (live-task guard rejects with 409 unless ready), then re-register
 *    with a fresh cache-busting import; enabled state is preserved across reload via persisted `pluginEnabled`.
 *
 * Reload imposes no persistent overhead on resident TS transpilation (`registerPluginTsRoot` ref-counting).
 */
export async function reloadExternalPlugin(
  dataDir: string,
  pluginId: string,
  plugins: ReloadablePluginHost,
  options: { doctor?: (dir: string) => Promise<void> } = {},
): Promise<{ pluginId: string; wasEnabled: boolean; generation: number }> {
  if (isBuiltinNamespace(pluginId)) {
    throw new HelmxError(
      'plugin_locked',
      `built-in plugin ${pluginId} cannot be hot-reloaded (restart Hub to apply built-in plugin changes)`,
      403,
      { pluginId },
    );
  }
  const current = (await plugins.list()).find((s) => s.id === pluginId);
  if (!current) {
    throw new HelmxError('unknown_plugin', `unregistered plugin: ${pluginId}`, 404, { pluginId });
  }
  const wasEnabled = current.enabled;
  const source = await findPluginSource(dataDir, pluginId, { transform: tsTransformOf(plugins) });
  if (source === undefined) {
    const codeRoot = externalPluginsDir(dataDir);
    throw new HelmxError(
      'plugin_source_missing',
      `no external plugin source directory with id ${pluginId} found under ${codeRoot}`,
      404,
      { pluginId, pluginsDir: codeRoot },
    );
  }
  const sourceDir = source.dir;
  // Probe import returned the old cached definition object; reuse it to roll back on swap failure.
  const rollbackDefinition = source.definition;
  // Dry-run preflight: keep the old instance untouched on failure.
  await options.doctor?.(sourceDir);

  // Obtain a fresh cache-busting generation for the actual reload import.
  let entryPath: string;
  try {
    entryPath = await resolvePluginEntry(sourceDir);
  } catch (err) {
    throw new HelmxError(
      'plugin_reload_failed',
      `plugin entrypoint became unavailable during reload (source changed between preflight and swap): ${sourceDir} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { pluginId, sourceDir },
    );
  }
  const releaseTsRoot = registerPluginTsRoot(sourceDir, { transform: tsTransformOf(plugins) });
  try {
    const generation = nextPluginGeneration(sourceDir);
    const definition = normalizeDefinition(
      await importPluginDefinition(sourceDir, entryPath, { generation }),
      sourceDir,
    );
    if (definition.id !== pluginId) {
      throw new HelmxError(
        'plugin_reload_failed',
        `plugin id changed during reload (preflight ${pluginId} -> actual ${definition.id}); aborting swap`,
        409,
        { pluginId, actualId: definition.id, sourceDir },
      );
    }
    await plugins.unregister(pluginId);
    try {
      await plugins.register(definition, { enabled: wasEnabled });
    } catch (err) {
      // Swap failed: attempt best-effort rollback to the pre-reload definition without masking the root error.
      let rollbackError: unknown;
      try {
        await plugins.register(normalizeDefinition(rollbackDefinition, sourceDir), {
          enabled: wasEnabled,
        });
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }
      throw new HelmxError(
        'plugin_reload_failed',
        `re-registration failed during reload ${rollbackError === undefined ? '(rolled back to pre-reload instance; previous definition remains active)' : '(rollback also failed; plugin is currently unregistered — fix manually and retry)'}: ${err instanceof Error ? err.message : String(err)}`,
        500,
        {
          pluginId,
          sourceDir,
          generation,
          rolledBack: rollbackError === undefined,
          ...(rollbackError !== undefined
            ? { rollbackError: rollbackError instanceof Error ? { message: rollbackError.message, stack: rollbackError.stack } : String(rollbackError) }
            : {}),
          cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
        },
      );
    }
    const after = (await plugins.list()).find((s) => s.id === pluginId);
    if (!after) {
      throw new HelmxError(
        'plugin_reload_failed',
        `plugin ${pluginId} missing from host list after reload (inconsistent internal state)`,
        500,
        { pluginId },
      );
    }
    return { pluginId, wasEnabled, generation };
  } finally {
    releaseTsRoot();
  }
}
