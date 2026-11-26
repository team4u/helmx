/**
 * Filesystem hashing primitives shared by the incremental build-fingerprint scripts
 * (packages/plugins/scripts/copy-plugin-clients.mjs and packages/web/scripts/build-web.mjs).
 *
 * Why shared: both scripts hash their build inputs into SHA-256 digests to skip unchanged work, and the
 * digest layout (`file:` / `dir:` / `missing:` labels, sorted POSIX relative paths, missing inputs hashed
 * as markers instead of throwing) must stay byte-identical so a digest computed by one script keeps
 * meaning the same thing in the other. Pure node:fs + node:crypto, no workspace dependencies.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** OS metadata files that are never build inputs or outputs. */
export const IGNORED_FILE_NAMES = new Set(['.DS_Store']);

export function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isRealDirectory(dirPath) {
  try {
    return lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function compareAscii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively collects regular files under `rootDir` as sorted POSIX relative paths; symbolic links are
 * never followed. `ignoredDirNames` prunes matching directories at every depth, `skipTopLevelDirs` only
 * directly under `rootDir`, and `extensions` keeps only files ending with one of the suffixes.
 */
export function collectFilesSorted(rootDir, options = {}) {
  if (!isRealDirectory(rootDir)) return [];
  const ignoredDirNames = options.ignoredDirNames ?? null;
  const skipTopLevelDirs = options.skipTopLevelDirs ?? null;
  const extensionFilter = options.extensions ?? null;
  const results = [];
  const walk = (dir, prefix, depth) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareAscii(a.name, b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ignoredDirNames && ignoredDirNames.has(ent.name)) continue;
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

/** Hashes one file into `hash` under `label`; a missing file is hashed as a marker so a digest still changes. */
export function hashFileInto(hash, label, absPath) {
  if (!isRegularFile(absPath)) {
    hash.update(`missing:${label}\0`);
    return;
  }
  const bytes = readFileSync(absPath);
  hash.update(`file:${label}:${bytes.byteLength}\0`);
  hash.update(bytes);
  hash.update('\0');
}

/** Hashes every file under `rootDir` (via collectFilesSorted, same options) into `hash`. */
export function hashDirectoryInto(hash, label, rootDir, options = {}) {
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
