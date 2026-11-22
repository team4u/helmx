/** OS startup service management for the local Hub (`launchd` / `systemd --user` / `schtasks`). */
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOsService, uninstallOsService, getOsServiceStatus, type OsServiceProfile, type OsServiceStatus } from '@helmx/env-io'
import { flagValue, parseFlags } from '../args.js'
import { CliError } from '../errors.js'
import { assertNoExtraPositionals, requirePositional, type CommandSpec } from './shared.js'

const ACTIONS = ['install', 'uninstall', 'status'] as const
type ServiceAction = (typeof ACTIONS)[number]

/**
 * Resolve the compiled CLI entrypoint (`dist/index.js`, or bundled `index.js`) required by OS
 * service managers (which invoke `node <entry> start` without `tsx`). Rejects unbuilt `.ts` source
 * with `missing_build` (mirrors `@helmx/node` `resolveServiceEntry`).
 */
export function resolveCliServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath)
  // Single-file npm deliverable (`.../index.js`) or already `dist/index.js`.
  if (path.basename(self) === 'index.js') return self
  const candidates = [
    path.resolve(path.dirname(self), '..', 'index.js'),
    path.resolve(path.dirname(self), '..', '..', 'dist', 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate)
    } catch {
      // Try next compiled artifact candidate.
    }
  }
  const expected = candidates[candidates.length - 1]!
  throw new CliError(
    `service entrypoint must be the compiled artifact (${expected}), which was not found while running from source; run pnpm build in the repository first`,
    'missing_build',
  )
}

/** Hub service identity and invocation: `helmx start` in the foreground under the OS supervisor. */
function hubServiceProfile(dataDir: string, explicitDataDir?: string): OsServiceProfile {
  return {
    darwinLabel: 'ai.helmx.hub',
    linuxUnit: 'helmx-hub.service',
    winTask: 'HelmxHub',
    description: 'Helmx Hub',
    cliArgs: ['start', ...(explicitDataDir !== undefined && explicitDataDir !== '' ? ['--data-dir', dataDir] : [])],
    logPath: path.join(dataDir, 'hub-service.log'),
  }
}

async function runServiceAction(action: ServiceAction, ctx: Parameters<NonNullable<CommandSpec['run']>>[0], dataDirFlag: string | undefined): Promise<number> {
  const dataDir = dataDirFlag !== undefined
    ? path.resolve(ctx.cwd, dataDirFlag)
    : (ctx.env.HELMX_DATA_DIR && ctx.env.HELMX_DATA_DIR !== '' ? ctx.env.HELMX_DATA_DIR : path.join(os.homedir(), '.helmx'))
  const entry = resolveCliServiceEntry()
  if (action === 'install') {
    const result = await installOsService(entry, dataDir, hubServiceProfile(dataDir, dataDirFlag))
    if (!result.ok) {
      throw new CliError(result.message, 'service_error', 1, { action, ...result })
    }
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify({ action, ...result }, null, 2)}\n`)
    } else {
      ctx.io.out(`${result.message}\nconfig: ${result.configPath}\n${result.targetPath !== undefined ? `active:  ${result.targetPath}\n` : ''}the service runs "helmx start" (foreground); the OS supervisor restarts it on failure and at login\n`)
    }
    return 0
  }
  if (action === 'uninstall') {
    const result = await uninstallOsService(entry, dataDir, hubServiceProfile(dataDir))
    if (!result.ok) {
      throw new CliError(result.message, 'service_error', 1, { action, ...result })
    }
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify({ action, ...result }, null, 2)}\n`)
    } else {
      ctx.io.out(`${result.message}\n`)
    }
    return 0
  }
  const status: OsServiceStatus = await getOsServiceStatus(entry, dataDir, hubServiceProfile(dataDir))
  if (ctx.json) {
    ctx.io.out(`${JSON.stringify({ action, ...status }, null, 2)}\n`)
    return 0
  }
  const lines = [
    `platform:  ${status.platform}`,
    `installed: ${status.installed === null ? 'unknown (query failed)' : status.installed ? 'yes' : 'no'}`,
    `running:   ${status.running}`,
    `config:    ${status.configPath}`,
  ]
  if (status.detail !== undefined && status.detail !== '') lines.push(status.detail)
  ctx.io.out(`${lines.join('\n')}\n`)
  return 0
}

export const serviceCommands: CommandSpec[] = [
  {
    path: ['service'],
    description: 'Manage the OS startup service for the local Hub (install | uninstall | status)',
    positional: '<install|uninstall|status>',
    flags: [{ name: 'data-dir', type: 'string', help: 'Hub data directory the service runs with (default ~/.helmx or HELMX_DATA_DIR)' }],
    async run(ctx) {
      const parsed = parseFlags([{ name: 'data-dir', type: 'string' }], ctx.args)
      assertNoExtraPositionals(parsed.positionals, 1)
      const action = requirePositional(parsed.positionals, 0, 'service action (install | uninstall | status)')
      if (!ACTIONS.includes(action as ServiceAction)) {
        throw new CliError(`unknown service action "${action}" (expected install, uninstall, or status)`, 'invalid_argument')
      }
      const value = flagValue<string>(parsed.flags, 'data-dir')
      if (value?.trim() === '') throw new CliError('--data-dir requires a non-empty value', 'invalid_flag_value')
      return await runServiceAction(action as ServiceAction, ctx, value)
    },
  },
]
