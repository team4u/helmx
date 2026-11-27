import type { ManagedCommand } from './lib/spawn-checked.js'

export type BuildMode = 'full' | 'skip-payload' | 'for-typecheck' | 'unit-deps'

export interface ParsedBuildArgs {
  mode: BuildMode
  force: boolean
  quiet: boolean
}

export interface PlanBuildStagesOptions {
  repoRoot?: string
  execPath?: string
  tscBin?: string
  mode?: BuildMode
  force?: boolean
  quiet?: boolean
}

export interface BuildPlan {
  mode: BuildMode
  force: boolean
  cleanPackages: string[]
  tscCommand: ManagedCommand
  webCommand: ManagedCommand | null
  postTscCommands: ManagedCommand[]
  payloadCommand: ManagedCommand | null
}

export interface RunBuildOptions extends PlanBuildStagesOptions {
  env?: NodeJS.ProcessEnv
}

export declare class BuildArgError extends Error {}
export declare function buildUsageText(): string
export declare function parseBuildArgs(argv?: string[], env?: NodeJS.ProcessEnv): ParsedBuildArgs
export declare function planBuildStages(options?: PlanBuildStagesOptions): BuildPlan
export declare function prepareBuildDist(
  repoRoot: string,
  plan: Pick<BuildPlan, 'cleanPackages' | 'force'>,
  env?: NodeJS.ProcessEnv,
): void
export declare function runBuild(options?: RunBuildOptions): Promise<number>
