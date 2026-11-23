/**
 * Read-only operator diagnostics (`helmx doctor`): inspects data directory & CLI token hygiene,
 * local Hub install snapshot, Hub reachability/auth status, configured models/defaults, and
 * registered compute nodes — zero disk mutations, zero secrets printed.
 */
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import process from 'node:process'
import type { AuthStatus, ModelCatalog, NodeInfo } from '@helmx/protocol'
import { credentialsPath, loadCliCredential } from '../credentials.js'
import { CliError } from '../errors.js'
import { HubClient, resolveEndpoint } from '../hub-client.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printResult } from './shared.js'

export type DoctorCheckStatus = 'ok' | 'warn' | 'error' | 'info'

export interface DoctorCheck {
  id: 'data_dir' | 'local_hub' | 'hub' | 'models' | 'nodes'
  status: DoctorCheckStatus
  message: string
  hint?: string
  details?: Record<string, unknown>
}

export interface DoctorReport {
  ok: boolean
  hubUrl: string
  dataDir: string
  checks: DoctorCheck[]
}

async function checkDataDir(ctx: CommandContext): Promise<{
  check: DoctorCheck
  credential: { hubUrl?: string; token?: string }
}> {
  const tokenFile = credentialsPath(ctx.dataDir)
  let dirExists = false
  try {
    dirExists = (await fsp.stat(ctx.dataDir)).isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        check: {
          id: 'data_dir',
          status: 'error',
          message: `data directory is unreadable (${ctx.dataDir}): ${err instanceof Error ? err.message : String(err)}`,
          hint: 'Check HELMX_DATA_DIR path and directory permissions.',
        },
        credential: {},
      }
    }
  }
  if (!dirExists) {
    return {
      check: {
        id: 'data_dir',
        status: 'info',
        message: `data directory does not exist yet (${ctx.dataDir}); will be created on first Hub start or login`,
        details: { dataDir: ctx.dataDir, exists: false },
      },
      credential: {},
    }
  }

  let credential: { hubUrl?: string; token?: string } = {}
  try {
    credential = await loadCliCredential(ctx.dataDir)
  } catch (err) {
    return {
      check: {
        id: 'data_dir',
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: `Inspect or remove ${tokenFile}, then run "helmx login".`,
        details: { dataDir: ctx.dataDir, tokenFile },
      },
      credential: {},
    }
  }

  if (existsSync(tokenFile) && process.platform !== 'win32') {
    try {
      const mode = (await fsp.stat(tokenFile)).mode & 0o777
      if (mode !== 0o600) {
        return {
          check: {
            id: 'data_dir',
            status: 'warn',
            message: `CLI token file permissions are ${mode.toString(8).padStart(3, '0')}, expected 0600 (${tokenFile})`,
            hint: `Tighten permissions with: chmod 600 ${tokenFile}`,
            details: { dataDir: ctx.dataDir, tokenFile, mode: mode.toString(8).padStart(3, '0') },
          },
          credential,
        }
      }
    } catch {
      // Stat error handled below or non-fatal.
    }
  }

  const tokenSource = ctx.env['HELMX_TOKEN']
    ? 'HELMX_TOKEN env'
    : credential.token
      ? 'cli-token (0600)'
      : 'none'
  return {
    check: {
      id: 'data_dir',
      status: 'ok',
      message: `data directory accessible (${ctx.dataDir}; token source: ${tokenSource})`,
      details: { dataDir: ctx.dataDir, exists: true, tokenSource },
    },
    credential,
  }
}

async function checkLocalHub(ctx: CommandContext): Promise<DoctorCheck> {
  const { readLocalHubSnapshot, resolveInstallRoot } = await import('../launcher/index.js')
  const installRoot = resolveInstallRoot(ctx.env)
  if (!existsSync(installRoot)) {
    return {
      id: 'local_hub',
      status: 'info',
      message: `no local Hub install root at ${installRoot} (expected for remote Hub or dev-mode setups)`,
      details: { installRoot, installed: false },
    }
  }
  try {
    const snapshot = await readLocalHubSnapshot({
      io: { env: ctx.env, out: () => {}, err: () => {} },
      root: installRoot,
      ...(ctx.io.fetchImpl !== undefined ? { fetchFn: ctx.io.fetchImpl } : {}),
    })
    if (snapshot.current === null) {
      return {
        id: 'local_hub',
        status: 'info',
        message: `install root exists (${installRoot}) but no Hub release is committed`,
        hint: 'Run "helmx start" to install and start the local Hub.',
        details: { installRoot, installed: false },
      }
    }
    if (snapshot.running !== null && snapshot.running.alive) {
      if (!snapshot.running.healthy) {
        return {
          id: 'local_hub',
          status: 'warn',
          message: `local Hub pid ${snapshot.running.pid} (${snapshot.running.version}) is alive on port ${snapshot.running.port}, but health probe failed`,
          hint: `Inspect ${snapshot.logFile} or run "helmx restart".`,
          details: { installRoot, version: snapshot.running.version, pid: snapshot.running.pid, port: snapshot.running.port, healthy: false, logFile: snapshot.logFile },
        }
      }
      const blockedNote = snapshot.blocked !== null ? `; update to ${snapshot.blocked.version} blocked` : ''
      return {
        id: 'local_hub',
        status: snapshot.blocked !== null ? 'warn' : 'ok',
        message: `local Hub running (pid ${snapshot.running.pid}, version ${snapshot.running.version}, port ${snapshot.running.port}${blockedNote})`,
        ...(snapshot.blocked !== null ? { hint: `Blocked update reason: ${snapshot.blocked.reason}` } : {}),
        details: { installRoot, version: snapshot.running.version, pid: snapshot.running.pid, port: snapshot.running.port, healthy: true, logFile: snapshot.logFile },
      }
    }
    return {
      id: 'local_hub',
      status: 'warn',
      message: snapshot.running !== null
        ? `local Hub (${snapshot.current.version}) has a stale pid record (${snapshot.pidFile})`
        : `local Hub (${snapshot.current.version}) is installed but not running`,
      hint: `Run "helmx start" (or "helmx start -d"), or inspect ${snapshot.logFile}.`,
      details: { installRoot, version: snapshot.current.version, running: false, logFile: snapshot.logFile },
    }
  } catch (err) {
    return {
      id: 'local_hub',
      status: 'error',
      message: `local Hub metadata unreadable (${installRoot}): ${err instanceof Error ? err.message : String(err)}`,
      hint: `Inspect launcher records under ${installRoot}.`,
      details: { installRoot },
    }
  }
}

async function checkModels(hub: HubClient): Promise<DoctorCheck> {
  try {
    const [catalog, defaults] = await Promise.all([
      hub.get<ModelCatalog>('/api/models'),
      hub.get<{ defaultModel?: string }>('/api/models/default'),
    ])
    const models = Array.isArray(catalog?.models) ? catalog.models : []
    const available = models.filter((m) => m.available !== false && m.disabled !== true)
    const defaultModel = typeof defaults?.defaultModel === 'string' ? defaults.defaultModel.trim() : ''
    if (available.length === 0) {
      return {
        id: 'models',
        status: 'warn',
        message: 'no available models configured on the Hub',
        hint: 'Check providers with "helmx models providers" and configure an API key with "helmx credentials set <id>".',
        details: { total: models.length, available: 0, defaultModel: defaultModel || null },
      }
    }
    if (defaultModel === '') {
      return {
        id: 'models',
        status: 'warn',
        message: `${available.length} model(s) available, but no global default model is set`,
        hint: 'Set one with: helmx models default --set <provider/model>',
        details: { total: models.length, available: available.length, defaultModel: null },
      }
    }
    return {
      id: 'models',
      status: 'ok',
      message: `${available.length} model(s) available; default: ${defaultModel}`,
      details: { total: models.length, available: available.length, defaultModel },
    }
  } catch (err) {
    return {
      id: 'models',
      status: 'error',
      message: `failed to query models: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkNodes(hub: HubClient): Promise<DoctorCheck> {
  try {
    const nodes = await hub.get<NodeInfo[]>('/api/nodes')
    if (!Array.isArray(nodes)) {
      return { id: 'nodes', status: 'error', message: 'Hub returned an invalid node list' }
    }
    const online = nodes.filter((n) => n.online)
    const offline = nodes.filter((n) => !n.online)
    if (offline.length > 0) {
      return {
        id: 'nodes',
        status: 'warn',
        message: `${online.length}/${nodes.length} node(s) online (offline: ${offline.map((n) => n.id).join(', ')})`,
        hint: 'Inspect offline machines with "helmx-node status" or "helmx-node doctor".',
        details: { total: nodes.length, online: online.length, offlineIds: offline.map((n) => n.id) },
      }
    }
    return {
      id: 'nodes',
      status: 'ok',
      message: `${online.length}/${nodes.length} node(s) online`,
      details: { total: nodes.length, online: online.length },
    }
  } catch (err) {
    return {
      id: 'nodes',
      status: 'error',
      message: `failed to query nodes: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function doctorCommands(): CommandSpec[] {
  return [
    {
      path: ['doctor'],
      description: 'Run read-only diagnostics on local data dir, Hub reachability/auth, models, and nodes',
      async run(ctx: CommandContext) {
        const checks: DoctorCheck[] = []

        const dataResult = await checkDataDir(ctx)
        checks.push(dataResult.check)

        const endpoint = resolveEndpoint(ctx.env, dataResult.credential)
        const hub = new HubClient(endpoint, ctx.io)

        checks.push(await checkLocalHub(ctx))

        let authenticated = false
        try {
          const auth = await hub.request<AuthStatus>('GET', '/api/auth/status', { auth: 'optional' })
          if (!auth.configured) {
            checks.push({
              id: 'hub',
              status: 'warn',
              message: `Hub reachable (${hub.baseUrl}), but admin password is not configured yet`,
              hint: 'Run "helmx setup" to initialize the admin password and log in.',
              details: { hubUrl: hub.baseUrl, configured: false, authenticated: false },
            })
          } else if (!auth.authenticated) {
            checks.push({
              id: 'hub',
              status: 'warn',
              message: `Hub reachable (${hub.baseUrl}) and configured, but CLI is not logged in`,
              hint: 'Run "helmx login" or set HELMX_TOKEN.',
              details: { hubUrl: hub.baseUrl, configured: true, authenticated: false },
            })
          } else {
            authenticated = true
            checks.push({
              id: 'hub',
              status: 'ok',
              message: `Hub reachable and authenticated (${hub.baseUrl})`,
              details: { hubUrl: hub.baseUrl, configured: true, authenticated: true },
            })
          }
        } catch (err) {
          const isUnreachable = err instanceof CliError && err.code === 'hub_unreachable'
          checks.push({
            id: 'hub',
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
            hint: isUnreachable
              ? 'Start the local Hub with "helmx start" or verify HELMX_HUB_URL.'
              : 'Verify Hub health and endpoint configuration.',
            details: { hubUrl: hub.baseUrl, code: err instanceof CliError ? err.code : 'internal_error' },
          })
        }

        if (authenticated) {
          const [modelsCheck, nodesCheck] = await Promise.all([checkModels(hub), checkNodes(hub)])
          checks.push(modelsCheck, nodesCheck)
        } else {
          checks.push({
            id: 'models',
            status: 'info',
            message: 'skipped (Hub must be reachable and authenticated)',
          })
          checks.push({
            id: 'nodes',
            status: 'info',
            message: 'skipped (Hub must be reachable and authenticated)',
          })
        }

        const report: DoctorReport = {
          ok: !checks.some((c) => c.status === 'error'),
          hubUrl: hub.baseUrl,
          dataDir: ctx.dataDir,
          checks,
        }
        if (ctx.json) {
          printResult(ctx, report)
          return report.ok ? 0 : 1
        }
        const label: Record<DoctorCheckStatus, string> = {
          ok: 'OK  ',
          warn: 'WARN',
          error: 'FAIL',
          info: 'INFO',
        }
        ctx.io.out(`helmx doctor (hub=${report.hubUrl}, dataDir=${report.dataDir})\n`)
        for (const check of report.checks) {
          ctx.io.out(`  [${label[check.status]}] ${check.id}: ${check.message}\n`)
          if (check.hint !== undefined) ctx.io.out(`         hint: ${check.hint}\n`)
        }
        const hasWarnings = report.checks.some((c) => c.status === 'warn')
        ctx.io.out(
          !report.ok
            ? 'doctor result: errors found; address the FAIL items above and retry\n'
            : hasWarnings
              ? 'doctor result: passed with warnings\n'
              : 'doctor result: all checks passed\n',
        )
        return report.ok ? 0 : 1
      },
    },
  ]
}
