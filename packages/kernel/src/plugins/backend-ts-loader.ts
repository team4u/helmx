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
import { registerHooks, type ModuleHooks } from 'node:module';
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
 * Module generation counter (for controlled hot reload): root `realpath` -> next generation number.
 * On reload, appending `?helmxgen=<n>` to the entry URL makes Node's ESM cache re-initialize the
 * plugin module graph under a fresh URL; the `resolve` hook propagates this tag across relative
 * imports within the plugin root, while bare specifiers (`@helmx/*`, npm packages, `node:` builtins)
 * resolve normally without the tag and stay shared with the host—isolating generation reloads
 * strictly inside the plugin root.
 */
const rootGenerations = new Map<string, number>();

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
  const root = realpathSync(rootDir);
  const next = (rootGenerations.get(root) ?? 0) + 1;
  rootGenerations.set(root, next);
  return next;
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

/** Register process-wide Node module hooks (idempotent). */
function ensureHooks(): void {
  if (hooks !== undefined) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const parentRoot = parent === undefined ? undefined : rootOfUrl(parent);
      // Guard direct `file:` TS imports targeting a registered plugin root (e.g. a symlink inside a
      // plugin root escaping outside) and absolute TS path imports originating inside a plugin root
      // before Node's default resolver resolves symlinks or crosses into another plugin root.
      const cleanSpecPath = specifier.startsWith('file:')
        ? (() => {
            try {
              return fileURLToPath(specifier);
            } catch {
              return undefined;
            }
          })()
        : parentRoot !== undefined && isAbsolute(specifier.split('?')[0]!.split('#')[0]!)
          ? specifier.split('?')[0]!.split('#')[0]!
          : undefined;
      if (cleanSpecPath !== undefined) {
        const owningRoot = parentRoot ?? (specifier.startsWith('file:') ? rootOfUrl(specifier) : undefined);
        if (owningRoot !== undefined && TS_SOURCE_EXTENSIONS.has(fileExtension(cleanSpecPath))) {
          let real: string | undefined;
          try {
            real = realpathSync(cleanSpecPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
          }
          if (real !== undefined && !isInsideRoot(owningRoot, real)) {
            throw rootEscapeError(specifier, specifier, real);
          }
        }
      }
      if (parent === undefined || parentRoot === undefined) {
        return nextResolve(specifier, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        // Propagate generation tag from parent across internal relative imports so reloads get a fresh
        // isolated module graph, while leaving bare specifiers (@helmx/* / npm / node:) shared.
        const parentGeneration = generationOfUrl(parent);
        const isInsideParentRootUrl = (url: string): boolean => {
          if (!url.startsWith('file:')) return false;
          try {
            return isInsideRoot(parentRoot, fileURLToPath(url));
          } catch {
            return false;
          }
        };
        /** Append generation tag only to URLs inside the owning plugin root so shared modules are not duplicated. */
        const settle = (url: string): { url: string; shortCircuit?: boolean } =>
          parentGeneration === undefined || !isInsideParentRootUrl(url)
            ? { url }
            : { url: withGenerationQuery(url, parentGeneration), shortCircuit: true };
        let resolved: { url: string; shortCircuit?: boolean };
        try {
          resolved = nextResolve(specifier, context);
        } catch (err) {
          // Only probe TS candidates on ERR_MODULE_NOT_FOUND; preserve permission and other errors.
          if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
          let target: string;
          try {
            target = fileURLToPath(new URL(specifier, parent));
          } catch {
            throw err;
          }
          for (const candidate of tsResolutionCandidates(target)) {
            if (!isFile(candidate)) continue;
            // Resolve symlinks to deduplicate URLs and reject targets escaping the owning plugin directory.
            let real: string;
            try {
              real = realpathSync(candidate);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR') continue;
              throw error;
            }
            if (!isInsideRoot(parentRoot, real)) {
              throw rootEscapeError(specifier, candidate, real);
            }
            return settle(pathToFileURL(real).href);
          }
          throw err;
        }
        // Re-check TypeScript resolutions (both `.js -> .ts` via downstream hooks like tsx and explicit `.ts`
        // symlinks) for realpath containment inside the owning plugin root and canonical module identity.
        const resolvedUrl = resolved.url;
        if (
          typeof resolvedUrl === 'string' &&
          resolvedUrl.startsWith('file:') &&
          TS_SOURCE_EXTENSIONS.has(fileExtension(fileURLToPath(resolvedUrl)))
        ) {
          let real: string;
          try {
            real = realpathSync(fileURLToPath(resolvedUrl));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return resolved;
            throw error;
          }
          if (!isInsideRoot(parentRoot, real)) {
            throw rootEscapeError(specifier, resolvedUrl, real);
          }
          return settle(pathToFileURL(real).href);
        }
        // For regular resolutions (e.g. relative .json or valid external targets), re-attach generation if inside root
        // because Node's URL resolution drops the parent query string.
        if (
          parentGeneration !== undefined &&
          typeof resolvedUrl === 'string' &&
          resolvedUrl.startsWith('file:') &&
          generationOfUrl(resolvedUrl) === undefined
        ) {
          return settle(resolvedUrl);
        }
        return resolved;
      }
      // Explicit public `@helmx/*` allowlist: resolve from host to preserve shared singletons,
      // and reject all private host packages (`@helmx/kernel`, `@helmx/env-io`, etc.) without fallback.
      if (specifier.startsWith('@helmx/')) {
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
      let real: string;
      try {
        real = realpathSync(file);
      } catch (err) {
        // Propagate source stat/read failures (permissions / deleted race) directly.
        throw err;
      }
      if (!isInsideRoot(owningRoot, real)) {
        throw rootEscapeError(file, url, real);
      }
      let source: string;
      try {
        source = readFileSync(real, 'utf8');
      } catch (err) {
        // Propagate source read failures (permissions / deleted race) directly.
        throw err;
      }
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
