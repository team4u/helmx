export declare const TSX_CACHE_FILE_RE: RegExp
export declare const DEFAULT_MAX_TSX_CACHE_ENTRIES: number

export declare function resolveTsxCacheDir(tmpDir?: string): string

export declare function pruneTsxCacheIfBloated(options?: {
  cacheDir?: string
  maxEntries?: number
}): {
  cacheDir: string
  total: number
  pruned: number
}
