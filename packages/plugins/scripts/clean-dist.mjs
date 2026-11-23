#!/usr/bin/env node
/**
 * Pre-build cleanup: incrementally prunes stale artifacts in this package's dist that no longer have
 * matching source files, including stale deleted `<plugin>/client`, `<plugin>/dist-client`, and
 * orphaned `<plugin>` directories, while preserving `<plugin>/client/**` assets that still exist.
 * Supports --force / HELMX_CLEAN_DIST=1 for a full wipe.
 */
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanDistCli } from '../../../scripts/lib/prune-dist.mjs';

function isDir(dirPath) {
  try {
    return lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function pruneStalePluginDistDirs(pkgRoot) {
  const srcDir = join(pkgRoot, 'src');
  const distDir = join(pkgRoot, 'dist');
  if (!existsSync(distDir)) return [];
  const removed = [];
  for (const ent of readdirSync(distDir, { withFileTypes: true })) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const distSubDir = join(distDir, ent.name);
    if (ent.isSymbolicLink()) {
      rmSync(distSubDir, { recursive: true, force: true });
      removed.push(ent.name);
      continue;
    }
    const srcSubDir = join(srcDir, ent.name);
    const srcClientDir = join(srcSubDir, 'client');
    if (!isDir(srcClientDir)) {
      for (const leaf of ['client', 'dist-client']) {
        const staleLeaf = join(distSubDir, leaf);
        if (existsSync(staleLeaf)) {
          rmSync(staleLeaf, { recursive: true, force: true });
          removed.push(`${ent.name}/${leaf}`);
        }
      }
    }
    if (!isDir(srcSubDir)) {
      rmSync(distSubDir, { recursive: true, force: true });
      removed.push(ent.name);
      continue;
    }
    try {
      if (readdirSync(distSubDir).length === 0) {
        rmdirSync(distSubDir);
        removed.push(ent.name);
      }
    } catch {
      // Ignore concurrent removal
    }
  }
  return removed;
}

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  pruneStalePluginDistDirs(pkgRoot);
  runCleanDistCli(pkgRoot, process.argv.slice(2), { preserveClients: true });
}
