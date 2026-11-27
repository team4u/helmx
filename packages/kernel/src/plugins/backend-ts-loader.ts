/**
 * Backend plugin TypeScript module loader (`external-loader` transpilation foundation).
 *
 * - Transpiles `.ts`/`.tsx`/`.mts`/`.cts` source files inside registered plugin roots (via realpath)
 *   using Node `module.registerHooks` + the host build port's `transformBackendTs`;
 * - Preserves real source URLs so `import.meta.url` points to real files, and ESM cache keeps
 *   explicitly allowlisted public `@helmx/*` contract singletons consistent with the host while
 *   rejecting private host packages (`@helmx/kernel`, `@helmx/env-io`, etc.);
 * - Resolves TS-style relative imports (`.js -> .ts/.tsx`, extensionless -> `.ts/.tsx/index.ts`)
 *   and patches ESM `.json` imports with `type: 'json'`;
 * - Rejects symlink/relative escapes outside registered roots;
 * - Fails explicitly (`501 unsupported_backend_ts_build`) when no transpiler is injected.
 */
import { registerHooks, type ModuleHooks, type ResolveFnOutput, type ResolveHookContext } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HelmxError, type PluginBuildProvider } from '@helmx/protocol';

/** Transpilation function signature (`PluginBuildProvider.transformBackendTs`). */
export type BackendTsTransformFn = PluginBuildProvider['transformBackendTs'];

/**
 * Explicit allowlist of public `@helmx/*` host contract specifiers permitted for backend external plugins.
 * Resolved via host `import.meta.resolve` to preserve shared singletons (e.g. `HelmxError` identity).
 * All other `@helmx/*` specifiers (such as `@helmx/kernel`, `@helmx/env-io`, `@helmx/hub`,
 * `@helmx/plugin-build`, `@helmx/plugins`, `@helmx/node`) are private host packages and rejected.
 */
export const PUBLIC_BACKEND_HELMX_PACKAGES: ReadonlySet<string> = new Set([
  '@helmx/protocol',
  '@helmx/protocol/browser',
]);

/** Supported TypeScript source extensions (`.cts` output is still loaded as ESM for a uniform module model). */
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Registered plugin root directory (`realpath`): reference count and root-specific transpiler injected via the build port. */
interface TsRootEntry {
  count: number;
  transform?: BackendTsTransformFn;
}

const rootRefCounts = new Map<string, TsRootEntry>();

/**
 * Process-wide monotonic module generation counter (for controlled hot reload).
 * Appending `?helmxgen=<n>` to an entry URL makes Node's ESM cache initialize a fresh module
 * graph without ever colliding with previously cached `?helmxgen` URLs after root release,
 * while avoiding an unbounded per-path Map across ephemeral plugin directories.
 */
let generationCounter = 0;

/** Reserved generation query parameter prefix (excluding `=` and value). */
const GENERATION_QUERY_PREFIX = 'helmxgen=';

/**
 * Extracts the `helmxgen` generation number from a URL (or `undefined` when absent).
 * Only appears along propagated relative-import chains inside a plugin root, seeded by reload/doctor.
 */
function generationOfUrl(url: string): number | undefined {
  const queryStart = url.lastIndexOf('?');
  if (queryStart === -1) return undefined;
  const params = url.slice(queryStart + 1).split('&');
  for (const param of params) {
    if (!param.startsWith(GENERATION_QUERY_PREFIX)) continue;
    const value = Number(param.slice(GENERATION_QUERY_PREFIX.length));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Appends a `helmxgen` generation tag to a file URL unless one is already present. */
function withGenerationQuery(url: string, generation: number): string {
  if (generationOfUrl(url) !== undefined) return url;
  return `${url}?${GENERATION_QUERY_PREFIX}${generation}`;
}

/**
 * Reserves and returns the next monotonically increasing generation number for a plugin root.
 * Callers (`doctor` / `reload`) attach `?helmxgen=<n>` to the entry URL so a new module graph
 * initializes independently while previous generation modules remain usable in the ESM cache
 * and bare-specifier dependencies stay shared with the host.
 */
export function nextPluginGeneration(rootDir: string): number {
  realpathSync(rootDir);
  generationCounter += 1;
  return generationCounter;
}

/** Lazily registered Node module hooks instance; deregistered once all roots are released. */
let hooks: ModuleHooks | undefined;

/** Host-side package resolver: captures this module's `import.meta.resolve` pointing at the kernel workspace. */
const hostMetaResolve = import.meta.resolve;

/** Returns true if `target` (lexical or real path) lies within `root` (cross-platform via `relative` + `sep`). */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Returns the most specific registered root containing `url`, or `undefined` if outside all roots. */
function rootOfUrl(url: string): string | undefined {
  if (rootRefCounts.size === 0 || !url.startsWith('file:')) return undefined;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  let best: string | undefined;
  for (const root of rootRefCounts.keys()) {
    if (isInsideRoot(root, path) && (best === undefined || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/**
 * When a relative specifier fails standard ESM resolution (ERR_MODULE_NOT_FOUND),
 * probe TypeScript candidate extensions matching tsc `--module nodenext` conventions.
 */
function tsResolutionCandidates(resolvedPath: string): string[] {
  const ext = fileExtension(resolvedPath);
  if (ext === '.js') {
    const stem = resolvedPath.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (ext === '.mjs') return [`${resolvedPath.slice(0, -4)}.mts`];
  if (ext === '.cjs') return [`${resolvedPath.slice(0, -4)}.cts`];
  return [`${resolvedPath}.ts`, `${resolvedPath}.tsx`, join(resolvedPath, 'index.ts'), join(resolvedPath, 'index.tsx')];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Reject relative specifiers that resolve to TypeScript sources outside registered plugin roots. */
function rootEscapeError(specifier: string, candidate: string, real: string): HelmxError {
  return new HelmxError(
    'plugin_load_failed',
    `external plugin relative dependency ${specifier} resolved to TypeScript source outside plugin directory ${candidate} (real path ${real}), reject transpile; if an external module is truly required, reference its actual extension explicitly`,
    500,
    { specifier, candidate, real },
  );
}

/** Reject imports of host-private `@helmx/*` packages from external plugin roots. */
function privateHelmxPackageError(specifier: string, parent: string): HelmxError {
  const allowed = [...PUBLIC_BACKEND_HELMX_PACKAGES];
  return new HelmxError(
    'plugin_load_failed',
    `external plugin cannot import private host package "${specifier}" (from ${parent}); only public @helmx/* contract packages (${allowed.join(', ')}) are permitted`,
    500,
    { specifier, parent, allowedPackages: allowed },
  );
}

/** `realpathSync` that treats a missing path (`ENOENT` / `ENOTDIR`) as absent and rethrows every other error. */
function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Path of a `file:` URL, or `undefined` when the URL cannot be parsed as a file URL. */
function fileUrlPathOrUndefined(url: string): string | undefined {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

/** Path part (query / fragment stripped) of an absolute specifier, or `undefined` when the specifier is relative. */
function absoluteSpecifierPath(specifier: string): string | undefined {
  const path = specifier.split('?')[0]!.split('#')[0]!;
  return isAbsolute(path) ? path : undefined;
}

/** Whether `url` is a `file:` URL located inside `root` (non-file or unparseable URLs are outside). */
function isFileUrlInsideRoot(root: string, url: string): boolean {
  if (!url.startsWith('file:')) return false;
  const path = fileUrlPathOrUndefined(url);
  return path !== undefined && isInsideRoot(root, path);
}

/** Whether `url` is a `file:` URL pointing at a TypeScript source inside a plugin root. */
function isFileUrlWithTsExtension(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('file:') && TS_SOURCE_EXTENSIONS.has(fileExtension(fileURLToPath(url)));
}

/**
 * Guard direct `file:` TS imports targeting a registered plugin root (e.g. a symlink inside a
 * plugin root escaping outside) and absolute TS path imports originating inside a plugin root
 * before Node's default resolver resolves symlinks or crosses into another plugin root.
 */
function assertDirectSpecifierStaysInRoot(specifier: string, parentRoot: string | undefined): void {
  const cleanSpecPath = specifier.startsWith('file:')
    ? fileUrlPathOrUndefined(specifier)
    : parentRoot !== undefined
      ? absoluteSpecifierPath(specifier)
      : undefined;
  if (cleanSpecPath === undefined) return;
  const owningRoot = parentRoot ?? (specifier.startsWith('file:') ? rootOfUrl(specifier) : undefined);
  if (owningRoot === undefined || !TS_SOURCE_EXTENSIONS.has(fileExtension(cleanSpecPath))) return;
  const real = realpathIfPresent(cleanSpecPath);
  if (real !== undefined && !isInsideRoot(owningRoot, real)) {
    throw rootEscapeError(specifier, specifier, real);
  }
}

/**
 * Settle a resolved URL: the parent's generation tag is appended only to URLs inside the owning
 * plugin root so shared modules are not duplicated (short-circuiting Node's own handling of the tagged URL).
 */
function settleWithGeneration(
  url: string,
  parentRoot: string,
  generation: number | undefined,
): ResolveFnOutput {
  if (generation === undefined || !isFileUrlInsideRoot(parentRoot, url)) return { url };
  return { url: withGenerationQuery(url, generation), shortCircuit: true };
}

/**
 * Probe TypeScript candidates for a relative specifier that failed standard ESM resolution,
 * matching tsc `--module nodenext` conventions. Returns the canonical file URL of the first
 * existing candidate (symlinks resolved), or `undefined` when the specifier or every candidate is missing.
 */
function probeTsCandidate(specifier: string, parent: string, parentRoot: string): string | undefined {
  let target: string;
  try {
    target = fileURLToPath(new URL(specifier, parent));
  } catch {
    return undefined;
  }
  for (const candidate of tsResolutionCandidates(target)) {
    if (!isFile(candidate)) continue;
    // Resolve symlinks to deduplicate URLs and reject targets escaping the owning plugin directory.
    const real = realpathIfPresent(candidate);
    if (real === undefined) continue;
    if (!isInsideRoot(parentRoot, real)) {
      throw rootEscapeError(specifier, candidate, real);
    }
    return pathToFileURL(real).href;
  }
  return undefined;
}

/**
 * Re-check a successful resolution: TypeScript targets (`.js -> .ts` via downstream hooks like tsx and
 * explicit `.ts` symlinks) must realpath inside the owning plugin root and are canonicalized to that
 * real path; regular resolutions (e.g. relative .json or valid external targets) re-attach the parent
 * generation tag when inside the root because Node's URL resolution drops the parent query string.
 */
function settleResolvedSpecifier(
  resolved: ResolveFnOutput,
  specifier: string,
  parentRoot: string,
  generation: number | undefined,
): ResolveFnOutput {
  const resolvedUrl: unknown = resolved.url;
  if (isFileUrlWithTsExtension(resolvedUrl)) {
    const real = realpathIfPresent(fileURLToPath(resolvedUrl));
    if (real === undefined) return resolved;
    if (!isInsideRoot(parentRoot, real)) {
      throw rootEscapeError(specifier, resolvedUrl, real);
    }
    return settleWithGeneration(pathToFileURL(real).href, parentRoot, generation);
  }
  if (
    generation !== undefined &&
    typeof resolvedUrl === 'string' &&
    resolvedUrl.startsWith('file:') &&
    generationOfUrl(resolvedUrl) === undefined
  ) {
    return settleWithGeneration(resolvedUrl, parentRoot, generation);
  }
  return resolved;
}

/**
 * Resolve a relative specifier from inside a plugin root: the parent's generation tag propagates across
 * internal relative imports so reloads get a fresh isolated module graph while bare specifiers
 * (@helmx/* / npm / node:) stay shared; TypeScript candidates are probed only on ERR_MODULE_NOT_FOUND.
 */
function resolveRelativeSpecifier(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput,
  parent: string,
  parentRoot: string,
): ResolveFnOutput {
  const parentGeneration = generationOfUrl(parent);
  let resolved: ResolveFnOutput;
  try {
    resolved = nextResolve(specifier, context);
  } catch (err) {
    // Only probe TS candidates on ERR_MODULE_NOT_FOUND; preserve permission and other errors.
    if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    const probed = probeTsCandidate(specifier, parent, parentRoot);
    if (probed === undefined) throw err;
    return settleWithGeneration(probed, parentRoot, parentGeneration);
  }
  return settleResolvedSpecifier(resolved, specifier, parentRoot, parentGeneration);
}

/**
 * Explicit public `@helmx/*` allowlist: resolve from host to preserve shared singletons,
 * and reject all private host packages (`@helmx/kernel`, `@helmx/env-io`, etc.) without fallback.
 */
function resolveHelmxSpecifier(specifier: string, parent: string): ResolveFnOutput {
  if (!PUBLIC_BACKEND_HELMX_PACKAGES.has(specifier)) {
    throw privateHelmxPackageError(specifier, parent);
  }
  let url: string;
  try {
    url = hostMetaResolve(specifier);
  } catch (err) {
    throw new HelmxError(
      'plugin_load_failed',
      `external plugin failed to resolve public host package "${specifier}" (from ${parent}): ${err instanceof Error ? err.message : String(err)}`,
      500,
      { specifier, parent },
    );
  }
  if (typeof url === 'string' && url.startsWith('file:')) {
    return { url, shortCircuit: true };
  }
  throw new HelmxError(
    'plugin_load_failed',
    `external plugin resolved public host package "${specifier}" to non-file URL: ${String(url)}`,
    500,
    { specifier, parent, url },
  );
}

/** Register process-wide Node module hooks (idempotent). */
function ensureHooks(): void {
  if (hooks !== undefined) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const parentRoot = parent === undefined ? undefined : rootOfUrl(parent);
      assertDirectSpecifierStaysInRoot(specifier, parentRoot);
      if (parent === undefined || parentRoot === undefined) {
        return nextResolve(specifier, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return resolveRelativeSpecifier(specifier, context, nextResolve, parent, parentRoot);
      }
      if (specifier.startsWith('@helmx/')) {
        return resolveHelmxSpecifier(specifier, parent);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const owningRoot = rootOfUrl(url);
      if (owningRoot === undefined) {
        return nextLoad(url, context);
      }
      // Compute extension from the path without query parameters (generation URLs carry `?helmxgen=N`).
      const ext = fileExtension(fileURLToPath(url));
      // Rewrite relative `.json` imports to include `type: 'json'` since esbuild strips ESM import attributes.
      if (ext === '.json') {
        return nextLoad(url, {
          ...context,
          importAttributes: { ...context.importAttributes, type: 'json' },
        });
      }
      if (!TS_SOURCE_EXTENSIONS.has(ext)) {
        return nextLoad(url, context);
      }
      const file = fileURLToPath(url);
      const real = realpathSync(file);
      if (!isInsideRoot(owningRoot, real)) {
        throw rootEscapeError(file, url, real);
      }
      const source = readFileSync(real, 'utf8');
      // Transpiler must be injected by the build port; never silently fall back.
      const transform = rootRefCounts.get(owningRoot)?.transform;
      if (transform === undefined) {
        throw new HelmxError(
          'unsupported_backend_ts_build',
          `Host has not wired plugin build port (PluginHostOptions.buildProvider.transformBackendTs): cannot transpile external plugin TS source ${file}`,
          501,
          { file },
        );
      }
      let code: string;
      try {
        code = transform({
          source,
          file,
          kind: ext === '.tsx' ? 'tsx' : 'ts',
        });
      } catch (err) {
        if (err instanceof HelmxError) throw err;
        throw transpileError(file, err);
      }
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}

/** Wraps an esbuild transpilation failure with file and line/column diagnostics. */
function transpileError(file: string, err: unknown): HelmxError {
  const first = (err as { errors?: Array<{ text?: string; location?: { line: number; column: number } }> }).errors?.[0];
  const location = first?.location;
  const position = location ? `${location.line}:${location.column}` : '';
  const detail = first?.text ?? (err instanceof Error ? err.message : String(err));
  return new HelmxError(
    'plugin_load_failed',
    `External plugin TypeScript transpilation failed: ${file}${position ? `:${position}` : ''} (${detail})`,
    500,
    { file, line: location?.line, column: location?.column, detail },
  );
}

/**
 * Registers a plugin directory root for backend TypeScript transpilation (reference-counted, lazy hooks).
 * Returns a release callback that unregisters the loader hooks when the last root is released.
 */
export function registerPluginTsRoot(
  rootDir: string,
  options: { transform?: BackendTsTransformFn } = {},
): () => void {
  const root = realpathSync(rootDir);
  const entry = rootRefCounts.get(root);
  if (entry === undefined) {
    rootRefCounts.set(root, { count: 1, transform: options.transform });
    ensureHooks();
  } else {
    entry.count += 1;
    if (options.transform !== undefined) entry.transform = options.transform;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = rootRefCounts.get(root);
    if (current === undefined) return;
    if (current.count <= 1) {
      rootRefCounts.delete(root);
      if (rootRefCounts.size === 0 && hooks !== undefined) {
        hooks.deregister();
        hooks = undefined;
      }
    } else {
      current.count -= 1;
    }
  };
}

/** Test/diagnostic helper returning active ref-counted root count and hook installation state. */
export function debugBackendTsLoaderState(): {
  activeRoots: number;
  generationCounter: number;
  hooksInstalled: boolean;
} {
  return {
    activeRoots: rootRefCounts.size,
    generationCounter,
    hooksInstalled: hooks !== undefined,
  };
}
