export interface ManagedCommand {
  cmd: string
  args: string[]
  label: string
}

export interface KillTimings {
  pollMs?: number
  cleanupGraceMs?: number
  lastResortMs?: number
}

export interface RunManagedCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timings?: KillTimings
  capture?: boolean
  signal?: AbortSignal
  handleSignals?: boolean
}

export interface ManagedCommandResult {
  code: number
  stdout: string
  stderr: string
  output: string
}

export declare const DEFAULT_KILL_TIMINGS: Required<KillTimings>
export declare function resolvePackageManagerInvoke(env?: NodeJS.ProcessEnv): { cmd: string; args: string[] }
export declare function runManagedCommandDetailed(
  command: ManagedCommand,
  opts?: RunManagedCommandOptions,
): Promise<ManagedCommandResult>
export declare function runManagedCommand(
  command: ManagedCommand,
  opts?: RunManagedCommandOptions,
): Promise<number>
export declare function runSequentially(
  commands: ManagedCommand[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timings?: KillTimings },
): Promise<number>
