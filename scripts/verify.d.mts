import type { BuildPlan } from './build.js'
import type { ManagedCommand } from './lib/spawn-checked.js'

export interface ParsedVerifyArgs {
  force: boolean
  skipTests: boolean
  quiet: boolean
}

export interface PlanVerifyStagesOptions {
  repoRoot?: string
  execPath?: string
  tscBin?: string
  oxlintBin?: string
  force?: boolean
  skipTests?: boolean
  quiet?: boolean
}

export interface VerifyPlan {
  force: boolean
  skipTests: boolean
  quiet: boolean
  buildPlan: BuildPlan
  lintCommand: ManagedCommand
  hygieneCommand: ManagedCommand
  testsCommand: ManagedCommand | null
}

export interface RunVerifyOptions extends PlanVerifyStagesOptions {
  env?: NodeJS.ProcessEnv
}

export declare class VerifyArgError extends Error {}
export declare function verifyUsageText(): string
export declare function parseVerifyArgs(argv?: string[], env?: NodeJS.ProcessEnv): ParsedVerifyArgs
export declare function planVerifyStages(options?: PlanVerifyStagesOptions): VerifyPlan
export declare function runVerify(options?: RunVerifyOptions): Promise<number>
