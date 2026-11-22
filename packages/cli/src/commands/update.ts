/** Proactive local Hub update command (`claude update` semantics: check -> stage -> apply). */
import path from 'node:path'
import { isStrictSemver } from '@helmx/protocol'
import type { FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, type CommandSpec } from './shared.js'
import { LAUNCH_FLAGS, readLaunchOptions, readNonEmptyFlag } from './start.js'

const flags = [
  { name: 'check', type: 'boolean', help: 'check the channel without installing or restarting' },
  { name: 'channel', type: 'string', help: 'npm dist-tag to follow, such as latest or beta' },
  { name: 'version', type: 'string', help: 'install an exact Hub version' },
  { name: 'tarball', type: 'string', help: 'install a local Hub archive with --version' },
  { name: 'force', type: 'boolean', help: 'reinstall, allow a downgrade, or update even when the Hub is busy' },
  { name: 'registry', type: 'string', help: 'override the npm registry' },
  ...LAUNCH_FLAGS,
] as const satisfies readonly FlagSpec[]

export const updateCommand: CommandSpec = {
  path: ['update'],
  description: 'Update the local Hub payload now and restart it (installs when nothing is committed)',
  flags,
  async run(ctx) {
    assertNoExtraPositionals(ctx.positionals, 0)
    const version = readNonEmptyFlag(ctx.flags, 'version')
    const tag = readNonEmptyFlag(ctx.flags, 'channel')
    const tarball = readNonEmptyFlag(ctx.flags, 'tarball')
    if (version !== undefined && !isStrictSemver(version)) {
      throw new CliError('--version requires strict SemVer, such as 1.2.3', 'invalid_version')
    }
    if (tarball !== undefined && version === undefined) {
      throw new CliError('--tarball requires --version', 'tarball_requires_version')
    }
    if (tag !== undefined && version !== undefined) {
      throw new CliError('--channel and --version are mutually exclusive', 'conflicting_flags')
    }
    const checkOnly = ctx.flags.get('check') === true
    // Mode-scoped flag validation (mirrors the old mode table): --check is read-only, so target
    // and launch flags are rejected instead of silently ignored.
    const checkAllowed = new Set(['check', 'channel', 'registry', 'json', 'help'])
    if (checkOnly) {
      for (const name of ctx.flags.keys()) {
        if (!checkAllowed.has(name)) {
          throw new CliError(`--${name} is not supported with --check`, 'invalid_option_for_command')
        }
      }
    }

    const { cmdCheck, cmdUpdate, resolveInstallRoot, UsageError } = await import('../launcher/index.js')
    const commandFlags = {
      version,
      tag,
      tarball: tarball === undefined ? undefined : path.resolve(ctx.cwd, tarball),
      registry: readNonEmptyFlag(ctx.flags, 'registry'),
      force: ctx.flags.get('force') === true,
      json: ctx.json,
      ...readLaunchOptions(ctx.flags, ctx.cwd),
    }
    const launcherCtx = { io: ctx.io, root: resolveInstallRoot(ctx.env), ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}) }
    try {
      return await (checkOnly ? cmdCheck(launcherCtx, commandFlags) : cmdUpdate(launcherCtx, commandFlags))
    } catch (error) {
      if (error instanceof UsageError) throw new CliError(error.message, error.code)
      throw error
    }
  },
}
