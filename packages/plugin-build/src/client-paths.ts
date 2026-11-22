/**
 * Path containment, package-root discovery, hashing, and deterministic cache naming
 * primitives for `@helmx/plugin-build`.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HelmxError } from '@helmx/protocol';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function realPathOrThrow(p: string, message: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() && !st.isDirectory()) throw new Error('not a file or directory');
    return realpathSync(p);
  } catch {
    throw new HelmxError('client_root_invalid', message, 400, { path: p });
  }
}

export function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Returns true when `targetReal` lies under a `node_modules` directory nested inside `rootReal`. */
export function isInsideClientNodeModules(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return false;
  return rel.split(sep).includes('node_modules');
}

/** Returns true when `targetReal` is a local source file inside `rootReal` (excluding any nested `node_modules`). */
export function isInsideClientSource(rootReal: string, targetReal: string): boolean {
  return isInside(rootReal, targetReal) && !isInsideClientNodeModules(rootReal, targetReal);
}

export function assertEntryInsideRoot(pluginId: string, rootReal: string, moduleRef: string): string {
  const absPath = join(rootReal, moduleRef);
  let real: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) throw new Error('not a regular file');
    real = realpathSync(absPath);
  } catch {
    throw new HelmxError('client_root_invalid', `plugin ${pluginId} client module is missing: ${moduleRef}`, 400, {
      pluginId,
      module: moduleRef,
    });
  }
  if (!isInside(rootReal, real)) {
    throw new HelmxError(
      'client_module_out_of_root',
      `plugin ${pluginId} client module escapes clientRoot (possible symlink escape): ${moduleRef}`,
      400,
      { pluginId, module: moduleRef },
    );
  }
  return real;
}

/**
 * Finds the owning package root directory containing `package.json` for `fileReal`, or `null`
 * when no valid package root exists. Never returns `fileReal` itself and never walks above a
 * `node_modules` directory into an ancestor workspace's `package.json`.
 */
export function findPackageDirOf(fileReal: string): string | null {
  const normalized = resolve(fileReal);
  const nmMarker = `${sep}node_modules${sep}`;
  const lastNm = normalized.lastIndexOf(nmMarker);
  if (lastNm !== -1) {
    const afterNm = normalized.slice(lastNm + nmMarker.length);
    const parts = afterNm.split(sep).filter(Boolean);
    if (parts.length < 2) return null;
    const first = parts[0]!;
    if (first.startsWith('.')) return null;
    const pkgSegments = first.startsWith('@') ? 2 : 1;
    if (parts.length <= pkgSegments) return null;
    const candidate = join(normalized.slice(0, lastNm + nmMarker.length), ...parts.slice(0, pkgSegments));
    return isRegularFile(join(candidate, 'package.json')) ? candidate : null;
  }
  let dir = dirname(normalized);
  for (;;) {
    if (basename(dir) === 'node_modules') return null;
    if (isRegularFile(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Deterministic filesystem-safe directory name for a plugin ID. */
export function safeDirName(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9_-]/g, '_');
  const suffix = createHash('sha1').update(pluginId).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}

/** Deterministic filesystem-safe file prefix for a moduleRef. */
export function safeFileName(moduleRef: string): string {
  const safe = moduleRef.replace(/[^A-Za-z0-9._-]+/g, '_');
  const suffix = createHash('sha1').update(moduleRef).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}
