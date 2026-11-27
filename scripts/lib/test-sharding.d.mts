import type * as ts from 'typescript'

export type TestPool = 'pure' | 'dom-shared' | 'node-shared' | 'isolated'

export interface PurityAnalysis {
  pure: boolean
  pool: TestPool
  reasons: string[]
  strictIsolatedReasons?: string[]
  domReasons?: string[]
  nodeBackendReasons?: string[]
  nodeFsReasons?: string[]
  nodeGlobalReasons?: string[]
}

export interface PurityCacheEntry {
  mtimeMs: number
  size: number
  helpers: Array<{ path: string; mtimeMs: number; size: number }>
  result: { pool: TestPool; pure: boolean; reasons: string[] }
}

export interface PurityCacheStore {
  schemaVersion: number
  entries: Record<string, PurityCacheEntry>
}

export interface ShardPlan {
  label: string
  pool: TestPool
  mode: 'shard-worker' | 'isolated'
  files: string[]
  permits: number
  estimatedWeight: number
}

export declare const TEST_POOL_CACHE_SCHEMA_VERSION: number
export declare const DEFAULT_PURITY_CACHE_REL: string

export declare function resolveRelativeTestHelper(fromFile: string, specifier: string): string | null
export declare function analyzeTestSourcePurity(
  tsModule: typeof ts,
  filePath: string,
  source: string,
  resolveHelper?: (fromFile: string, specifier: string) => { path: string; source: string } | null,
  visited?: Set<string>,
): PurityAnalysis
export declare function analyzeTestFilePurity(tsModule: typeof ts, absFilePath: string): PurityAnalysis
export declare function classifyTestFilePool(
  tsOrNull: typeof ts | null,
  absFilePath: string,
  options?: {
    repoRoot?: string
    cache?: PurityCacheStore
    getTs?: () => typeof ts
  },
): { pure: boolean; pool: TestPool; reasons: string[]; cacheHit: boolean }
export declare function emptyPurityCache(): PurityCacheStore
export declare function loadPurityCache(cachePath: string): PurityCacheStore
export declare function savePurityCache(cachePath: string, cache: PurityCacheStore): boolean
export declare function shouldDisableSharding(extraArgs: string[]): boolean
export declare function requiresNativeProcessIsolation(reasons: string[]): boolean
export declare function balanceShardsLpt(
  files: string[],
  shardCount: number,
  weightFn: (relPath: string) => number,
): Array<{ files: string[]; weight: number }>
export declare function partitionFilesForSharding(input: {
  ts: typeof ts
  repoRoot: string
  files: string[]
  cpus: number
  filesPerShard?: number
  weightFn: (relPath: string) => number
}): {
  pureFiles: string[]
  isolatedFiles: string[]
  shards: string[][]
}
export declare function planFourPoolSchedule(input: {
  ts?: typeof ts | null
  getTs?: () => typeof ts
  repoRoot: string
  files: string[]
  workerBudget: number
  weightFn: (relPath: string) => number
  cachePath?: string
  useCache?: boolean
}): {
  pools: Record<TestPool, string[]>
  processIsolatedFiles: string[]
  shardCounts: Record<TestPool, number>
  plans: ShardPlan[]
  cacheStats: { hits: number; misses: number }
}
