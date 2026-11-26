/**
 * Filesystem containment, filtered copying, staging fetch, runtime dependency install, and
 * deterministic directory-digest primitives for external plugin packages.
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  compareCodeUnit,
  HelmxError,
  isJsonObject,
  isReservedPluginNamespace,
  type PackageManagerHost,
  type PluginPackageSource,
} from '@helmx/protocol';
import { commandError, tailLines, type RunResult } from './package-runner.js';

const COPY_IGNORE = new Set(['node_modules', '.git', '.staging']);
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function safeDirName(pluginId: string): string {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || isReservedPluginNamespace(pluginId)) {
    throw new HelmxError('invalid_plugin_definition', `plugin id is not allowed as a managed install directory name: ${pluginId}`, 400, { pluginId });
  }
  return pluginId;
}

export function assertInsideDataDir(dataDir: string, target: string): void {
  const rel = relative(resolve(dataDir), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmxError('validation_error', `install target escapes managed plugins directory: ${target}`, 400, { target });
  }
}

/** Copy directory contents excluding symlinks, dot-prefixed entries, node_modules, and VCS metadata. */
export async function copyTreeFiltered(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || COPY_IGNORE.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeFiltered(from, to);
    } else if (entry.isFile()) {
      await cp(from, to, { force: true });
    }
    // Skip special files such as symlinks and FIFOs.
  }
}

/** Resolves a local path to its canonical real path (following symlinks; falls back to lexical resolve when absent). */
export async function canonicalLocalPath(target: string): Promise<string> {
  const resolved = resolve(target);
  try {
    return await realpath(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw err;
  }
}

/** Stat `target`, returning `undefined` only on `ENOENT` and rethrowing real I/O errors. */
export async function statIfExists(target: string, followSymlinks = true): Promise<Stats | undefined> {
  try {
    return followSymlinks ? await stat(target) : await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Probe whether a directory or file exists (rethrows non-ENOENT IO errors cleanly). */
export async function pathExists(target: string): Promise<boolean> {
  return (await statIfExists(target)) !== undefined;
}

export async function isDirectoryPath(target: string): Promise<boolean> {
  return (await statIfExists(target))?.isDirectory() === true;
}

const DIGEST_SKIP_FILES = new Set(['node_modules/.package-lock.json']);
const DIGEST_SKIP_DIRS = new Set(['.staging', 'node_modules/.cache']);

/** Deterministic SHA-256 digest of a directory tree, skipping non-deterministic npm metadata. */
export async function computeDirectoryDigest(rootDir: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => compareCodeUnit(a.name, b.name));
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (DIGEST_SKIP_DIRS.has(rel)) continue;
        hash.update(`D:${rel}\0`);
        await visit(join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (DIGEST_SKIP_FILES.has(rel)) continue;
        const content = await readFile(join(absDir, entry.name));
        hash.update(`F:${rel}\0${content.byteLength}\0`);
        hash.update(content);
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        if (DIGEST_SKIP_FILES.has(rel) || DIGEST_SKIP_DIRS.has(rel)) continue;
        const linkTarget = await readlink(join(absDir, entry.name));
        hash.update(`L:${rel}\0${linkTarget}\0`);
      } else {
        hash.update(`O:${rel}\0`);
      }
    }
  };
  await visit(rootDir, '');
  return hash.digest('hex');
}

export function samePackageSource(a: PluginPackageSource, b: PluginPackageSource): boolean {
  if (a.kind !== b.kind || a.raw !== b.raw) return false;
  if (a.kind === 'npm' && b.kind === 'npm') return a.spec === b.spec;
  if (a.kind === 'git' && b.kind === 'git') {
    return a.repo === b.repo && a.ref === b.ref && a.subdirectory === b.subdirectory;
  }
  if (a.kind === 'local' && b.kind === 'local') return a.path === b.path;
  return false;
}

/** Read plugin.json id or package.json name/helmx.id (used only as directory-name hint). */
export async function readDeclaredPluginId(dir: string): Promise<string | undefined> {
  const pluginJson = join(dir, 'plugin.json');
  try {
    const manifest = JSON.parse(await readFile(pluginJson, 'utf8')) as Record<string, unknown>;
    if (typeof manifest['id'] === 'string' && manifest['id'].length > 0) return manifest['id'];
    if (typeof manifest['main'] === 'string') return undefined; // main exists without id: defer to doctor
  } catch { /* missing/corrupt plugin.json: doctor reports structured error */ }
  const pkgJson = join(dir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as Record<string, unknown>;
    const helmx = pkg['helmx'];
    if (typeof helmx === 'object' && helmx !== null && typeof (helmx as Record<string, unknown>)['id'] === 'string') {
      return (helmx as Record<string, unknown>)['id'] as string;
    }
    if (typeof pkg['name'] === 'string' && PLUGIN_ID_PATTERN.test(pkg['name'])) return pkg['name'];
  } catch { /* ignore */ }
  return undefined;
}

export type PackageStage = 'install' | 'update';
export type StageRunner = (cmd: string, args: string[], opts?: { cwd?: string; stage?: PackageStage }) => Promise<RunResult>;

/** Fetch external plugin payload into staging based on `source.kind` (filtering symlinks/FIFOs/dot-dirs). */
export async function fetchIntoStaging(
  source: PluginPackageSource,
  staging: string,
  pluginsDir: string,
  run: StageRunner,
  stage: PackageStage,
): Promise<string> {
  if (source.kind === 'npm') {
    const packDir = join(staging, 'pack');
    await mkdir(packDir, { recursive: true });
    const packArgs = [
      'pack',
      '--pack-destination', packDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--foreground-scripts',
      '--',
      source.spec,
    ];
    const pack = await run('npm', packArgs, { stage });
    if (pack.code !== 0) {
      throw commandError(stage, 'npm', packArgs, pack);
    }
    const files = await readdir(packDir);
    const tarball = files.find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) {
      throw new HelmxError(
        `plugin_package_${stage}_failed`,
        `npm pack did not produce a tarball (spec: ${source.spec})`,
        500,
        { spec: source.spec, stdoutTail: tailLines(pack.stdout) },
      );
    }
    const rawExtract = join(staging, 'extract');
    await mkdir(rawExtract, { recursive: true });
    await run('tar', ['-xzf', join(packDir, tarball), '-C', rawExtract], { stage });
    // npm tarballs wrap contents inside a package/ directory; run through copyTreeFiltered to strip symlinks/FIFOs/hidden entries.
    const inner = join(rawExtract, 'package');
    const innerStat = await statIfExists(inner, false);
    const srcDir = innerStat?.isDirectory() === true ? inner : rawExtract;
    const payload = join(staging, 'payload');
    await copyTreeFiltered(srcDir, payload);
    return payload;
  }

  if (source.kind === 'git') {
    const repoDir = join(staging, 'repo');
    const args = ['clone', '--depth', '1', ...(source.ref !== undefined ? ['--branch', source.ref] : []), '--', source.repo, repoDir];
    await run('git', args, { stage });
    let root = repoDir;
    if (source.subdirectory !== undefined) {
      root = join(repoDir, source.subdirectory);
      const st = await statIfExists(root);
      if (st?.isDirectory() !== true) {
        throw new HelmxError(
          `plugin_package_${stage}_failed`,
          `git repository subdirectory is missing: ${source.subdirectory}`,
          404,
          { repo: source.repo, subdirectory: source.subdirectory },
        );
      }
    }
    const payload = join(staging, 'payload');
    await copyTreeFiltered(root, payload);
    return payload;
  }

  const st = await statIfExists(source.path);
  if (st?.isDirectory() !== true) {
    throw new HelmxError(
      `plugin_package_${stage}_failed`,
      `local plugin path is missing or not a directory on the Hub host (local sources resolve on the Hub, not the caller's machine): ${source.path}`,
      404,
      { path: source.path, raw: source.raw },
    );
  }
  const rel = relative(resolve(pluginsDir), resolve(source.path));
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (inside) {
    throw new HelmxError(
      'validation_error',
      `local plugin directory lies inside the managed plugins tree (${pluginsDir}); self-installation is disallowed: ${source.path}`,
      400,
      { path: source.path },
    );
  }
  const payload = join(staging, 'payload');
  await copyTreeFiltered(source.path, payload);
  return payload;
}

/**
 * Install runtime dependencies inside staging (`--omit=dev`, lifecycle scripts always disabled).
 */
export async function installRuntimeDeps(
  dir: string,
  host: PackageManagerHost,
  run: StageRunner,
  stage: PackageStage,
): Promise<void> {
  const pkgJson = join(dir, 'package.json');
  const hasPkg = (await statIfExists(pkgJson)) !== undefined;
  const declaredClientSpecs = host.readClientDependencies(dir);
  const prebuiltDir = host.verifyPrebuiltDir(dir);
  const clientSpecs = prebuiltDir !== undefined ? [] : declaredClientSpecs;
  const ranges = new Map<string, string>();
  let hasBackendRuntimeDeps = false;
  if (hasPkg) {
    let parsedPkg: unknown;
    try {
      parsedPkg = JSON.parse(await readFile(pkgJson, 'utf8'));
    } catch (err) {
      throw new HelmxError(
        `plugin_package_${stage}_failed`,
        `invalid package.json in plugin staging directory (${dir}): ${err instanceof Error ? err.message : String(err)}`,
        422,
        { dir },
      );
    }
    if (!isJsonObject(parsedPkg)) {
      throw new HelmxError(
        `plugin_package_${stage}_failed`,
        `invalid package.json in plugin staging directory (${dir}): expected JSON object`,
        422,
        { dir },
      );
    }
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const declared = parsedPkg[group];
      if (isJsonObject(declared) && Object.keys(declared).length > 0) {
        hasBackendRuntimeDeps = true;
      }
    }
    if (clientSpecs.length > 0) {
      for (const group of ['dependencies', 'devDependencies'] as const) {
        const declared = parsedPkg[group];
        if (!isJsonObject(declared)) continue;
        for (const [name, range] of Object.entries(declared)) {
          if (typeof range === 'string' && range.length > 0) ranges.set(name, range);
        }
      }
    }
  }
  if ((!hasPkg || !hasBackendRuntimeDeps) && clientSpecs.length === 0) return;
  if (clientSpecs.length === 0) {
    const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--foreground-scripts', '--no-package-lock-only'];
    await run('npm', args, { cwd: dir, stage });
    return;
  }
  const installSpecs = clientSpecs.map((spec) => {
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);
    const range = ranges.get(pkgName);
    return range !== undefined ? `${pkgName}@${range}` : pkgName;
  });
  const args = [
    'install', '--omit=dev', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
    '--foreground-scripts', ...installSpecs,
  ];
  await run('npm', args, { cwd: dir, stage });
}
