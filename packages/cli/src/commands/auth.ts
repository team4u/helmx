/** Auth commands: setup / login / status. */
import { existsSync } from 'node:fs'
import type { AuthStatus } from '@helmx/protocol'
import { CliError } from '../errors.js'
import type { LocalHubSnapshot } from '../launcher/index.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, authAndSave, printResult, resolvePasswordFlag } from './shared.js'

function formatLocalHubLines(snapshot: LocalHubSnapshot | null): string[] {
  const lines: string[] = []
  if (snapshot !== null && snapshot.current !== null) {
    const running =
      snapshot.running !== null && snapshot.running.alive
        ? `running (pid ${snapshot.running.pid}, ${snapshot.running.version}) on port ${snapshot.running.port}${snapshot.running.healthy ? '' : ' (health probe failed)'}`
        : snapshot.running !== null
          ? 'recorded but not alive (stale pid record)'
          : 'not running'
    lines.push(`local hub:  ${running}`)
    lines.push(`installed:  ${snapshot.current.version} (updated ${snapshot.current.updatedAt})`)
    if (snapshot.blocked !== null) {
      lines.push(`blocked:    ${snapshot.blocked.version} since ${snapshot.blocked.at} (${snapshot.blocked.reason})`)
    }
    lines.push(`log:        ${snapshot.logFile}`)
  } else {
    lines.push('local hub:  not installed (helmx start)')
  }
  return lines
}

export function authCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  const passwordFlag = { name: 'password', type: 'string', help: 'admin password (prompts masked in a TTY or reads a line from stdin when omitted)' } as const

  cmds.push({
    path: ['setup'],
    description: 'Initialize the admin password and log in (POST /api/auth/setup)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      assertNoExtraPositionals(ctx.positionals, 0)
      const password = await resolvePasswordFlag(ctx, ctx.flags)
      await authAndSave(ctx, '/api/auth/setup', password)
    },
  })

  cmds.push({
    path: ['login'],
    description: 'Log in and save credentials (POST /api/auth/login)',
    flags: [passwordFlag],
    async run(ctx: CommandContext) {
      assertNoExtraPositionals(ctx.positionals, 0)
      const password = await resolvePasswordFlag(ctx, ctx.flags)
      await authAndSave(ctx, '/api/auth/login', password)
    },
  })

  cmds.push({
    path: ['status'],
    description: 'View authentication status (GET /api/auth/status) plus the local Hub lifecycle snapshot',
    async run(ctx: CommandContext) {
      const { readLocalHubSnapshot, resolveInstallRoot } = await import('../launcher/index.js')
      const installRoot = resolveInstallRoot(ctx.env)
      const readSnapshot = async (): Promise<LocalHubSnapshot | null> =>
        existsSync(installRoot)
          ? await readLocalHubSnapshot({
              io: { env: ctx.env, out: () => {}, err: () => {} },
              root: installRoot,
              ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}),
            })
          : null

      const hub = await ctx.hub()
      // auth:'optional': sends any saved token (so Hub reports actual authenticated state), while still allowing unauthenticated status checks
      let res: AuthStatus
      try {
        res = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
      } catch (err) {
        if (!(err instanceof CliError) || err.code !== 'hub_unreachable') throw err
        // Local Hub snapshot stays visible even when the Hub is stopped/unreachable.
        const snapshot = await readSnapshot().catch(() => null)
        if (ctx.json) {
          throw new CliError(err.message, err.code, 1, {
            hubUrl: hub.baseUrl,
            ...(snapshot !== null ? { localHub: snapshot } : {}),
          })
        }
        const lines = [
          `hub:        unreachable (${hub.baseUrl})`,
          `detail:     ${err.message}`,
          ...formatLocalHubLines(snapshot),
          'hint:       run "helmx start" to start the local Hub, or check HELMX_HUB_URL',
        ]
        ctx.io.out(`${lines.join('\n')}\n`)
        return 1
      }
      // Local Hub snapshot: only when an install root exists on this machine (machines that only
      // drive a remote Hub keep the original shape); the remote answer and the local process
      // view are honest about being different things.
      const snapshot = await readSnapshot()
      if (ctx.json) {
        printResult(ctx, { ...res, ...(snapshot !== null ? { localHub: snapshot } : {}) })
        return
      }
      printResult(ctx, res)
      ctx.io.out(`${formatLocalHubLines(snapshot).join('\n')}\n`)
    },
  })

  return cmds
}
