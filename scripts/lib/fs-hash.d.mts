import type { Hash } from 'node:crypto'

export interface CollectFilesOptions {
  /** Directory names pruned at every depth. */
  ignoredDirNames?: ReadonlySet<string> | null
  /** Directory names pruned only directly under the root directory. */
  skipTopLevelDirs?: ReadonlySet<string> | null
  /** When set, keep only files ending with one of these suffixes. */
  extensions?: readonly string[] | null
}

export declare const IGNORED_FILE_NAMES: ReadonlySet<string>

export declare function isRegularFile(filePath: string): boolean
export declare function isRealDirectory(dirPath: string): boolean
export declare function compareAscii(a: string, b: string): number
export declare function collectFilesSorted(rootDir: string, options?: CollectFilesOptions): string[]
export declare function hashFileInto(hash: Hash, label: string, absPath: string): void
export declare function hashDirectoryInto(
  hash: Hash,
  label: string,
  rootDir: string,
  options?: CollectFilesOptions,
): void
