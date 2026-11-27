export interface TestTimingEntry {
  durationMs: number
  runs: number
  updatedAt: number
}

export interface TestTimingsStore {
  schemaVersion: number
  files: Record<string, TestTimingEntry>
}

export declare const TEST_TIMINGS_SCHEMA_VERSION: number
export declare const DEFAULT_TIMINGS_CACHE_REL: string
export declare const ULTRA_SLOW_TEST_PREFIXES: string[]
export declare const SLOW_TEST_PREFIXES: string[]

export declare function normalizeTimingKey(repoRoot: string, filePath: string): string
export declare function emptyTestTimingsStore(): TestTimingsStore
export declare function loadTestTimings(cachePath: string): TestTimingsStore
export declare function mergeTestTimings(
  store: TestTimingsStore,
  observed: Record<string, number> | Map<string, number>,
  options?: { alpha?: number; now?: number },
): TestTimingsStore
export declare function pruneStaleTestTimings(store: TestTimingsStore, repoRoot: string): TestTimingsStore
export declare function saveTestTimings(cachePath: string, store: TestTimingsStore): boolean
export declare function estimateFallbackDurationMs(repoRoot: string, relPath: string): number
export declare function createTestWeightFn(input: {
  repoRoot: string
  timings: TestTimingsStore
}): {
  weightFn: (relPath: string) => number
  recordedCount: (files: string[]) => number
}
