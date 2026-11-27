export interface TypecheckTarget {
  label: string
  project: string
}

export interface RunParallelTypecheckOptions {
  repoRoot?: string
  execPath?: string
  tscBin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  handleSignals?: boolean
}

export declare const TYPECHECK_TARGETS: ReadonlyArray<TypecheckTarget>
export declare function runParallelTypecheck(options?: RunParallelTypecheckOptions): Promise<number>
