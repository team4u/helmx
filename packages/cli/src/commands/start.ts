/** Local Hub lifecycle commands: start / stop / restart (mirrors `helmx-node start -d` semantics). */
import path from 'node:path'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, parsePositiveInt, type CommandContext, type CommandSpec } from './shared.js'

export const LAUNCH_FLAGS = [
  { name: 'port', type: 'string', help: 'local Hub listen port' },
  { name: 'host', type: 'string', help: 'local Hub listen address' },
  { name: 'data-dir', type: 'string', help: 'local Hub data directory' },
  { name: 'model', type: 'string', help: 'local Hub default model' },
  { name: 'web-dist-dir', type: 'string', help: 'local Web assets directory, or false to disable static hosting' },
  { name: 'health-timeout', type: 'string', help: 'Hub readiness timeout in milliseconds' },
] as const satisfies readonly FlagSpec[]

export function readNonEmptyFlag(flags: Map<string, unknown>, name: string): string | undefined {
  const value = flagValue<string>(flags, name)
  if (value?.trim() === '') throw new CliError(`--${name} requires a non-empty value`, 'invalid_flag_value')
  return value
}

function readBoundedIntFlag(flags: Map<string, unknown>, name: string, max: number): number | undefined {
  const value = readNonEmptyFlag(flags, name)
  if (value === undefined) return undefined
  const result = parsePositiveInt(value, `--${name}`, 'invalid_flag_value')
  if (result > max) throw new CliError(`--${name} must be at most ${max}`, 'invalid_flag_value')
  return result
}

export function readLaunchOptions(flags: Map<string, unknown>, cwd: string) {
  const dataDir = readNonEmptyFlag(flags, 'data-dir')
  return {
    port: readBoundedIntFlag(flags, 'port', 65_535),
    host: readNonEmptyFlag(flags, 'host'),
    dataDir: dataDir === undefined ? undefined : path.resolve(cwd, dataDir),
    model: readNonEmptyFlag(flags, 'model'),
    webDistDir: readNonEmptyFlag(flags, 'web-dist-dir'),
    healthTimeoutMs: readBoundedIntFlag(flags, 'health-timeout', 2_147_483_647),
  }
}

export async function runLauncherCommand<T>(
  ctx: CommandContext,
  invoke: (
    launcher: typeof import('../launcher/index.js'),
    launcherCtx: { io: CommandContext['io']; root: string; fetchFn?: typeof fetch },
  ) => Promise<T>,
): Promise<T> {
  const launcher = await import('../launcher/index.js')
  const launcherCtx = {
    io: ctx.io,
    root: launcher.resolveInstallRoot(ctx.env),
    ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}),
  }
  try {
    return await invoke(launcher, launcherCtx)
  } catch (error) {
    if (error instanceof launcher.UsageError) throw new CliError(error.message, error.code)
    throw error
  }
}

export const startCommands: CommandSpec[] = [
  {
    path: ['start'],
    description: 'Start the local Helmx Hub (installs the payload first when nothing is committed yet)',
    flags: [
      { name: 'detached', short: 'd', type: 'boolean', help: 'run in the background (-d; default: foreground with Ctrl+C to stop)' },
      { name: 'channel', type: 'string', help: 'npm dist-tag used for the bootstrap install (default latest)' },
      { name: 'registry', type: 'string', help: 'override the npm registry' },
      ...LAUNCH_FLAGS,
    ],
    async run(ctx) {
      assertNoExtraPositionals(ctx.positionals, 0)
      return await runLauncherCommand(ctx, (launcher, launcherCtx) =>
        launcher.cmdStart(launcherCtx, {
          detached: ctx.flags.get('detached') === true,
          tag: readNonEmptyFlag(ctx.flags, 'channel'),
          registry: readNonEmptyFlag(ctx.flags, 'registry'),
          json: ctx.json,
          ...readLaunchOptions(ctx.flags, ctx.cwd),
        }),
      )
    },
  },
  {
    path: ['stop'],
    description: 'Stop the local Hub gracefully (verified control channel first, pid identity proof fallback)',
    flags: [],
    async run(ctx) {
      assertNoExtraPositionals(ctx.positionals, 0)
      return await runLauncherCommand(ctx, (launcher, launcherCtx) =>
        launcher.cmdStop({ io: launcherCtx.io, root: launcherCtx.root }, { json: ctx.json }),
      )
    },
  },
  {
    path: ['restart'],
    description: 'Restart the local Hub (graceful stop, then start detached with the sticky launch configuration)',
    flags: [
      { name: 'channel', type: 'string', help: 'npm dist-tag used for a bootstrap install when none is committed' },
      { name: 'registry', type: 'string', help: 'override the npm registry' },
      ...LAUNCH_FLAGS,
    ],
    async run(ctx) {
      assertNoExtraPositionals(ctx.positionals, 0)
      return await runLauncherCommand(ctx, (launcher, launcherCtx) =>
        launcher.cmdRestart(launcherCtx, {
          tag: readNonEmptyFlag(ctx.flags, 'channel'),
          registry: readNonEmptyFlag(ctx.flags, 'registry'),
          json: ctx.json,
          ...readLaunchOptions(ctx.flags, ctx.cwd),
        }),
      )
    },
  },
]
