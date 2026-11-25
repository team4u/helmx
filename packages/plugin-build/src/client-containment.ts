/**
 * Esbuild plugins and containment/resolution policy for `client.tsx` compilation:
 * - `sharedShimPlugin`: virtualizes host-shared dependencies onto `globalThis.__helmx_shared_*`;
 * - `containmentPlugin`: enforces `clientRoot` and controlled-npm realpath containment at resolve & load time;
 * - `cssPolicyPlugin` & `appendCssExport`: enforces safe CSS asset/import rules and exports merged CSS via `__helmxClientCss`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  PLUGIN_CLIENT_CSS_EXPORT,
  isAbsoluteTargetPath,
  type PluginClientNpmRoot,
} from '@helmx/protocol';
import type { OnResolveArgs, Plugin as EsbuildPlugin, PluginBuild } from 'esbuild';
import {
  findPackageDirOf,
  isInside,
  isInsideClientSource,
  isRegularFile,
  realpathOrNull,
} from './client-paths.js';

/**
 * Host-shared browser runtime dependencies: resolved at compile time to virtual shims (never reading
 * plugin `node_modules`) and backed at runtime by `globalThis.__helmx_shared_*`.
 */
export const CLIENT_SHARED_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'lucide-react',
  '@helmx/plugin-client',
] as const;

/** Mapping from shared specifier to host global property name (mounted by host page or test harness). */
export const CLIENT_SHARED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
  react: '__helmx_shared_react',
  'react-dom': '__helmx_shared_react_dom',
  'react-dom/client': '__helmx_shared_react_dom_client',
  'react/jsx-runtime': '__helmx_shared_react_jsx_runtime',
  'lucide-react': '__helmx_shared_lucide_react',
  '@helmx/plugin-client': '__helmx_shared_plugin_client',
});

/** Picks a non-colliding local identifier before exporting the merged CSS via `__helmxClientCss`. */
export function appendCssExport(js: string, css: string): string {
  if (css.length === 0) return js;
  let binding = '__helmxCssText';
  while (js.includes(binding)) binding += '_';
  return `${js}\nconst ${binding} = ${JSON.stringify(css)};\nexport { ${binding} as ${PLUGIN_CLIENT_CSS_EXPORT} };\n`;
}

function exactLiteralFilter(spec: string): RegExp {
  return new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/**
 * Resolves host-shared bare specifiers to virtual `helmx-shared` modules backed by
 * `module.exports = globalThis.__helmx_shared_*`, delegating CJS/ESM interop to esbuild.
 */
export function sharedShimPlugin(): EsbuildPlugin {
  return {
    name: 'helmx-shared-shim',
    setup(b) {
      for (const spec of CLIENT_SHARED_EXTERNALS) {
        b.onResolve({ filter: exactLiteralFilter(spec) }, () => ({
          path: spec,
          namespace: 'helmx-shared',
        }));
      }
      b.onLoad({ filter: /.*/, namespace: 'helmx-shared' }, (args) => {
        const globalName = CLIENT_SHARED_GLOBALS[args.path];
        if (globalName === undefined) {
          return { errors: [{ text: `unknown shared dependency specifier: ${args.path}` }] };
        }
        return {
          contents: `module.exports = (globalThis.${globalName});`,
          loader: 'js',
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Controlled npm dependency resolution & containment
// ---------------------------------------------------------------------------

interface ContainmentBuildCache {
  readonly realpath: Map<string, string | null>;
  readonly packageDirOf: Map<string, string | null>;
  readonly packageJson: Map<string, Record<string, unknown> | null>;
  readonly regularFile: Map<string, boolean>;
  readonly cleanSymlinkFreePkg: Map<string, boolean>;
}

function createContainmentBuildCache(): ContainmentBuildCache {
  return {
    realpath: new Map(),
    packageDirOf: new Map(),
    packageJson: new Map(),
    regularFile: new Map(),
    cleanSymlinkFreePkg: new Map(),
  };
}

function cachedRealpath(cache: ContainmentBuildCache, targetPath: string): string | null {
  if (cache.realpath.has(targetPath)) return cache.realpath.get(targetPath)!;
  const resolved = realpathOrNull(targetPath);
  cache.realpath.set(targetPath, resolved);
  return resolved;
}

function cachedFindPackageDirOf(cache: ContainmentBuildCache, filePath: string): string | null {
  if (cache.packageDirOf.has(filePath)) return cache.packageDirOf.get(filePath)!;
  const pkgDir = findPackageDirOf(filePath);
  cache.packageDirOf.set(filePath, pkgDir);
  return pkgDir;
}

function cachedPackageJson(cache: ContainmentBuildCache, pkgDir: string): Record<string, unknown> | null {
  if (cache.packageJson.has(pkgDir)) return cache.packageJson.get(pkgDir)!;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as unknown;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  cache.packageJson.set(pkgDir, parsed);
  return parsed;
}

function cachedIsRegularFile(cache: ContainmentBuildCache, filePath: string): boolean {
  if (cache.regularFile.has(filePath)) return cache.regularFile.get(filePath)!;
  const ok = isRegularFile(filePath);
  cache.regularFile.set(filePath, ok);
  return ok;
}

function isSymlinkFreePackageDir(pkgReal: string): boolean {
  const stack: string[] = [pkgReal];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) return false;
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        stack.push(join(dir, ent.name));
      }
    }
  }
  return true;
}

function cachedIsSymlinkFreePkg(cache: ContainmentBuildCache, pkgReal: string): boolean {
  const cached = cache.cleanSymlinkFreePkg.get(pkgReal);
  if (cached !== undefined) return cached;
  const clean = isSymlinkFreePackageDir(pkgReal);
  cache.cleanSymlinkFreePkg.set(pkgReal, clean);
  return clean;
}

function isSimplePackageInternalRelative(spec: string): boolean {
  if (!spec.startsWith('./') && !spec.startsWith('.\\')) return false;
  const parts = spec.split(/[\\/]/);
  return !parts.includes('..') && !parts.includes('node_modules');
}

function splitNpmSpecifier(spec: string): { pkg: string; sub: string } {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { pkg: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') };
  }
  return { pkg: parts[0] ?? spec, sub: parts.slice(1).join('/') };
}

function resolveNpmPackageEntry(pkgDir: string, spec: string, cache: ContainmentBuildCache): string | null {
  const pkg = cachedPackageJson(cache, pkgDir);
  if (pkg === null) return null;
  const { sub } = splitNpmSpecifier(spec);
  const exportKey = sub === '' ? '.' : `./${sub}`;
  const candidates: string[] = [];
  const exp = pkg['exports'];
  if (exp !== null && typeof exp === 'object' && !Array.isArray(exp)) {
    const entry = (exp as Record<string, unknown>)[exportKey];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const readCond = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const inner = (value as Record<string, unknown>)['default'];
          return typeof inner === 'string' ? inner : null;
        }
        return null;
      };
      const fromImport = readCond((entry as Record<string, unknown>)['import']);
      const fromDefault = readCond((entry as Record<string, unknown>)['default']);
      if (fromImport !== null) candidates.push(fromImport);
      if (fromDefault !== null) candidates.push(fromDefault);
    } else if (typeof entry === 'string') {
      candidates.push(entry);
    }
  }
  if (sub === '') {
    if (typeof pkg['module'] === 'string') candidates.push(pkg['module']);
    if (typeof pkg['main'] === 'string') candidates.push(pkg['main']);
  } else {
    candidates.push(`./${sub}`);
  }
  for (const rel of candidates) {
    if (typeof rel !== 'string' || rel === '') continue;
    const abs = rel.startsWith('./') ? join(pkgDir, rel.slice(2)) : join(pkgDir, rel);
    const real = cachedRealpath(cache, abs);
    if (real !== null && isInside(pkgDir, real) && existsSync(real)) return real;
  }
  return null;
}

/**
 * Resolves a declared controlled npm specifier from its authorized `packageRoot/node_modules`.
 * Subpath specifiers must be declared explicitly; returns `null` when undeclared or unresolvable.
 */
function resolveNpmSpecifier(
  spec: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot>,
  cache: ContainmentBuildCache,
): { path: string; pkgDir: string } | null {
  for (const root of npmRoots) {
    if (!root.specifiers.includes(spec)) continue;
    const nmReal = cachedRealpath(cache, join(root.packageRoot, 'node_modules'));
    if (nmReal === null) continue;
    const { pkg, sub } = splitNpmSpecifier(spec);
    const pkgCandidate = resolve(nmReal, pkg);
    if (!isInside(nmReal, pkgCandidate)) continue;
    const pkgReal = cachedRealpath(cache, pkgCandidate);
    if (pkgReal === null) continue;
    const entry = resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`, cache);
    if (entry === null) continue;
    return { path: entry, pkgDir: pkgReal };
  }
  return null;
}

function isRelativeSpecifier(spec: string): boolean {
  return (
    spec === '.' ||
    spec === '..' ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('.\\') ||
    spec.startsWith('..\\')
  );
}

function isAbsoluteImport(spec: string): boolean {
  return isAbsolute(spec) || isAbsoluteTargetPath(spec);
}

function isValidOwningPackage(pkgReal: string | null, fileReal: string, cache: ContainmentBuildCache): pkgReal is string {
  return pkgReal !== null && isInsideClientSource(pkgReal, fileReal) && cachedIsRegularFile(cache, join(pkgReal, 'package.json'));
}

/**
 * Validates and resolves the canonical package directory of a transitive npm dependency imported by an
 * already-authorized npm package. Rejects resolutions outside `node_modules`, missing `package.json`,
 * or files escaping their owning package directory via symlinks.
 */
function resolveTransitiveNpmPackageDir(
  specifier: string,
  resolveDir: string,
  resolvedPath: string,
  fileReal: string,
  cache: ContainmentBuildCache,
): string | null {
  // 1. Verify via the lexical `node_modules/<pkg>` slot reachable from `resolveDir`.
  if (!specifier.startsWith('#') && resolveDir !== '') {
    const { pkg } = splitNpmSpecifier(specifier);
    const pkgParts = pkg.split('/').filter(Boolean);
    const validPkg =
      pkgParts.length > 0 &&
      !pkgParts.some((part) => part === '.' || part === '..') &&
      (pkg.startsWith('@') ? pkgParts.length === 2 && pkgParts[0]!.length > 1 : pkgParts.length === 1);
    if (validPkg) {
      let dir = resolve(resolveDir);
      for (;;) {
        const nmDir = join(dir, 'node_modules');
        const pkgCandidate = resolve(nmDir, ...pkgParts);
        if (isInside(nmDir, pkgCandidate)) {
          const pkgReal = cachedRealpath(cache, pkgCandidate);
          if (isValidOwningPackage(pkgReal, fileReal, cache)) return pkgReal;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  // 2. Fallback for `#imports` or `browser`-field remapped bare specifiers resolving inside `node_modules`.
  const normalizedResolved = resolve(resolvedPath);
  const nmMarker = `${sep}node_modules${sep}`;
  if (!normalizedResolved.includes(nmMarker) && !fileReal.includes(nmMarker)) {
    return null;
  }
  if (normalizedResolved.includes(nmMarker)) {
    const lexicalPkgDir = cachedFindPackageDirOf(cache, normalizedResolved);
    const pkgReal = lexicalPkgDir !== null ? cachedRealpath(cache, lexicalPkgDir) : null;
    return isValidOwningPackage(pkgReal, fileReal, cache) ? pkgReal : null;
  }
  const realPkgDir = cachedFindPackageDirOf(cache, fileReal);
  return isValidOwningPackage(realPkgDir, fileReal, cache) ? realPkgDir : null;
}

function resolveInternal(b: PluginBuild, args: OnResolveArgs) {
  return b.resolve(args.path, {
    kind: args.kind,
    importer: args.importer,
    resolveDir: args.resolveDir,
    namespace: args.namespace,
    pluginData: { helmxContainmentInternal: true },
  });
}

/**
 * Enforces `clientRoot` and controlled-npm realpath containment at resolve and load time.
 */
export function containmentPlugin(
  pluginId: string,
  rootReal: string,
  entryReal: string,
  npmRoots: ReadonlyArray<PluginClientNpmRoot> = [],
): EsbuildPlugin {
  const cache = createContainmentBuildCache();
  cache.realpath.set(rootReal, rootReal);
  cache.realpath.set(entryReal, entryReal);
  const authorizedNpmDirs = new Set<string>();
  const authorizeNpmPackageDir = (pkgDir: string): string | null => {
    const real = cachedRealpath(cache, pkgDir);
    if (real === null) return null;
    authorizedNpmDirs.add(real);
    return real;
  };
  const authorizedNpmDirOf = (realPath: string): string | null => {
    let best: string | null = null;
    for (const dir of authorizedNpmDirs) {
      if (isInsideClientSource(dir, realPath) && (best === null || dir.length > best.length)) {
        best = dir;
      }
    }
    return best;
  };
  const isNpmAuthorized = (realPath: string): boolean => authorizedNpmDirOf(realPath) !== null;

  return {
    name: 'helmx-containment',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as { helmxContainmentInternal?: boolean } | undefined)?.helmxContainmentInternal === true) {
          return null;
        }
        const importer = args.importer || 'entry';
        if (args.kind === 'entry-point') {
          const real = cachedRealpath(cache, args.path);
          if (real !== null && real === entryReal && isInsideClientSource(rootReal, real)) {
            return null;
          }
          return {
            errors: [{
              text: `plugin ${pluginId} rejected unauthorized entry point (out of bounds): ${args.path}`,
            }],
          };
        }
        if (args.kind === 'url-token') return null;
        if (args.kind === 'import-rule' && (/^(https?:)?\/\//i.test(args.path) || /^data:/i.test(args.path))) {
          return null;
        }
        if ((CLIENT_SHARED_EXTERNALS as readonly string[]).includes(args.path)) return null;

        if (isAbsoluteImport(args.path)) {
          return {
            errors: [{
              text:
                `plugin ${pluginId} rejected unauthorized absolute import "${args.path}" (imported by ${importer}): ` +
                `out of bounds absolute paths are not permitted; clientRoot only permits relative imports, ` +
                `shared dependencies (${CLIENT_SHARED_EXTERNALS.join(', ')}), and declared npm specifiers`,
            }],
          };
        }

        const importerReal = args.importer !== '' ? cachedRealpath(cache, args.importer) : null;
        const importerNpmDir = importerReal !== null ? authorizedNpmDirOf(importerReal) : null;

        if (isRelativeSpecifier(args.path)) {
          // Equivalent pruning: when an authorized package directory contains zero symlinks
          // (outside nested node_modules) and the import is a simple `./...` path without
          // `..` or `node_modules` segments, esbuild's native resolver cannot escape `importerNpmDir`.
          if (
            importerNpmDir !== null &&
            args.resolveDir !== '' &&
            isSimplePackageInternalRelative(args.path) &&
            cachedIsSymlinkFreePkg(cache, importerNpmDir)
          ) {
            const resolveDirReal = cachedRealpath(cache, args.resolveDir);
            if (resolveDirReal !== null && isInsideClientSource(importerNpmDir, resolveDirReal)) {
              return null;
            }
          }
          const resolved = await resolveInternal(b, args);
          if (resolved.errors.length > 0 || !resolved.path) return null;
          if (resolved.external || (resolved.namespace !== '' && resolved.namespace !== 'file') || !isAbsolute(resolved.path)) {
            return null;
          }
          const real = cachedRealpath(cache, resolved.path);
          if (importerNpmDir !== null) {
            if (real !== null && isInsideClientSource(importerNpmDir, real)) return null;
            return {
              errors: [{
                text: `plugin ${pluginId} rejected out of bounds relative import (escapes authorized npm package via ../ or symlink): ${real ?? resolved.path}`,
              }],
            };
          }
          if (real !== null && isInsideClientSource(rootReal, real)) return null;
          return {
            errors: [{
              text: `plugin ${pluginId} rejected out of bounds relative import (escapes root via ../, symlink, or points to an undeclared npm file): ${real ?? resolved.path}`,
            }],
          };
        }

        if (importerNpmDir !== null) {
          const resolved = await resolveInternal(b, args);
          if (resolved.errors.length > 0 || !resolved.path) {
            const peerNpm = resolveNpmSpecifier(args.path, npmRoots, cache);
            if (peerNpm !== null) {
              authorizeNpmPackageDir(peerNpm.pkgDir);
              return { path: peerNpm.path };
            }
            return null;
          }
          if (resolved.external || (resolved.namespace !== '' && resolved.namespace !== 'file') || !isAbsolute(resolved.path)) {
            return null;
          }
          const real = cachedRealpath(cache, resolved.path);
          if (real === null) {
            return {
              errors: [{
                text: `plugin ${pluginId} rejected out of bounds transitive dependency "${args.path}" (imported by ${importer}): ${resolved.path}`,
              }],
            };
          }
          const transitivePkgDir = resolveTransitiveNpmPackageDir(args.path, args.resolveDir, resolved.path, real, cache);
          if (transitivePkgDir !== null) {
            authorizeNpmPackageDir(transitivePkgDir);
            return null;
          }
          if (isInsideClientSource(importerNpmDir, real) || isNpmAuthorized(real)) return null;
          return {
            errors: [{
              text: `plugin ${pluginId} rejected unauthorized transitive dependency "${args.path}" (imported by ${importer}, resolved to ${real}): resolved outside a valid node_modules package`,
            }],
          };
        }

        const npm = resolveNpmSpecifier(args.path, npmRoots, cache);
        if (npm !== null) {
          authorizeNpmPackageDir(npm.pkgDir);
          return { path: npm.path };
        }
        const declaredRoot = npmRoots.find((r) => r.specifiers.includes(args.path));
        if (declaredRoot !== undefined) {
          return {
            errors: [{
              text:
                `plugin ${pluginId} cannot parse declared frontend dependency "${args.path}" inside ${join(declaredRoot.packageRoot, 'node_modules')} ` +
                '(dependency not installed or package entry missing); install this dependency in the plugin directory and retry (managed installs add it automatically during install/update)',
            }],
          };
        }
        if (args.kind === 'import-rule') {
          const resolved = await resolveInternal(b, args);
          if (resolved.errors.length > 0 || !resolved.path) return null;
          const real = cachedRealpath(cache, resolved.path);
          if (real !== null && isInsideClientSource(rootReal, real)) return null;
          return {
            errors: [{
              text: `plugin ${pluginId} rejected out of bounds stylesheet @import "${args.path}" (imported by ${importer}): ${real ?? resolved.path}`,
            }],
          };
        }
        return {
          errors: [{
            text:
              `plugin ${pluginId} must reject bare dependency "${args.path}" (imported by ${importer}): ` +
              `undeclared controlled npm dependency; clientRoot only permits relative imports, shared dependencies (${CLIENT_SHARED_EXTERNALS.join(', ')}), and declared npm specifiers`,
          }],
        };
      });

      b.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace !== 'file') return null;
        const real = cachedRealpath(cache, args.path);
        if (real === null) return null;
        if (!isInsideClientSource(rootReal, real) && !isNpmAuthorized(real)) {
          return {
            errors: [{
              text: `plugin ${pluginId} rejected out of bounds file (escapes root via ../, symlink escape, or undeclared npm resolution): ${real}`,
            }],
          };
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CSS asset policy
// ---------------------------------------------------------------------------

function isAllowedCssAssetUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  return url.length === 0 || /^data:/i.test(url) || /^https?:\/\//i.test(url) || url.startsWith('//');
}

export function cssPolicyPlugin(pluginId: string): EsbuildPlugin {
  return {
    name: 'helmx-css-policy',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'url-token') {
          if (isAllowedCssAssetUrl(args.path)) return null;
          return {
            errors: [{
              text:
                `plugin ${pluginId} stylesheet ${args.importer} asset reference "${args.path}" was rejected: ` +
                'local relative, root-relative, or fragment URLs resolve against the wrong host page base URL (plugins have no static asset endpoint); ' +
                'use an inline data: URL or an explicit https:// absolute URL instead',
            }],
          };
        }
        if (args.kind === 'import-rule' && /^(https?:)?\/\//i.test(args.path)) {
          return {
            errors: [{
              text:
                `plugin ${pluginId} stylesheet ${args.importer} remote @import "${args.path}" was rejected: ` +
                'remote stylesheets are outside local dependency validation and cache management; copy the stylesheet into clientRoot and import it relatively',
            }],
          };
        }
        return null;
      });
    },
  };
}
