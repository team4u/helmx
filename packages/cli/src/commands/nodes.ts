/**
 * Compute node management commands (Hub side): nodes list / endpoints / issue / remove / upgrade / forward*.
 * Driven by `@helmx/protocol` `NODE_CORE_OPERATIONS` via `commandsFromOperations`, plus the
 * streaming `nodes forward` foreground command and composite `nodes upgrade` handler.
 */
import {
  NODE_CORE_OPERATIONS,
  formatHubListenSummary,
  type HubAccessEndpoint,
  type HubAccessInfo,
  type NodeConnectGuide,
  type NodeForwardSession,
  type NodeInfo,
  type NodeIssuedToken,
  type NodeUpgradeCheckResult,
  type NodeUpgradeResult,
} from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import type { Io } from '../options.js'
import { printTableColumns, printText } from '../output.js'
import { runWithSignalAbort, type StreamRunResult } from '../stream.js'
import { commandsFromOperations, schemaFlagsForOperation } from './from-operations.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult, requirePositional } from './shared.js'

const FORWARD_ID_RE = /^fwd-[0-9a-f-]{36}$/

function formatGiB(bytes: number): string {
  const gib = bytes / (1024 ** 3)
  return gib >= 10 ? `${Math.round(gib)}G` : `${gib.toFixed(1)}G`
}

function formatNodeHealth(node: NodeInfo): string {
  if (!node.online) return '-'
  const h = node.health
  if (!h) return 'ok'
  const parts: string[] = []
  if (Array.isArray(h.loadAvg) && Number.isFinite(h.loadAvg[0])) {
    parts.push(`load ${h.loadAvg[0].toFixed(2)}`)
  }
  if (Number.isFinite(h.memTotalBytes) && h.memTotalBytes > 0 && Number.isFinite(h.memFreeBytes)) {
    const used = Math.max(0, h.memTotalBytes - h.memFreeBytes)
    parts.push(`mem ${formatGiB(used)}/${formatGiB(h.memTotalBytes)}`)
  }
  if (
    typeof h.diskTotalBytes === 'number' &&
    h.diskTotalBytes > 0 &&
    typeof h.diskFreeBytes === 'number'
  ) {
    const used = Math.max(0, h.diskTotalBytes - h.diskFreeBytes)
    parts.push(`disk ${formatGiB(used)}/${formatGiB(h.diskTotalBytes)}`)
  }
  return parts.length > 0 ? parts.join(' | ') : 'ok'
}

function printNodesTable(io: Io, nodes: NodeInfo[]): void {
  printTableColumns(io, nodes, [
    { label: 'id', value: (n) => n.id },
    { label: 'kind', value: (n) => n.kind },
    { label: 'online', value: (n) => String(n.online) },
    { label: 'version', value: (n) => n.version ?? '' },
    { label: 'hostname', value: (n) => n.hostname ?? '' },
    { label: 'platform', value: (n) => n.platform ?? '' },
    { label: 'health', value: (n) => formatNodeHealth(n) },
  ])
}

function printEndpointsOutput(io: Io, info: HubAccessInfo): void {
  printText(
    io,
    `Listening on ${formatHubListenSummary(info)}${info.loopbackOnly ? ' (loopback only)' : ''}`,
  )
  printTableColumns(io, info.endpoints, [
    { label: 'url', value: (ep) => ep.url },
    { label: 'kind', value: (ep) => ep.kind },
    { label: 'interface', value: (ep) => ep.interface ?? '' },
    { label: 'host', value: (ep) => ep.host },
  ])
}

function printForwardsTable(io: Io, forwards: NodeForwardSession[]): void {
  printTableColumns(io, forwards, [
    { label: 'forwardId', value: (f) => f.forwardId },
    { label: 'node', value: (f) => f.nodeId },
    { label: 'listen', value: (f) => f.listenHost },
    { label: 'port', value: (f) => String(f.listenPort) },
    { label: 'target', value: (f) => f.targetHost },
    { label: 'port', value: (f) => String(f.targetPort) },
    { label: 'active', value: (f) => String(f.activeConnections) },
  ])
}

function formatEndpointMeta(endpoint: HubAccessEndpoint): string {
  return endpoint.interface ? `${endpoint.kind}, ${endpoint.interface}` : endpoint.kind
}

function isValidConnectGuide(value: unknown): value is NodeConnectGuide {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const g = value as Partial<NodeConnectGuide>
  return (
    typeof g.hubUrl === 'string' &&
    typeof g.loopbackWarning === 'boolean' &&
    typeof g.installCommand === 'string' &&
    typeof g.oneLineCommand === 'string' &&
    typeof g.connectCommand === 'string' &&
    typeof g.startDaemonCommand === 'string' &&
    typeof g.serviceInstallCommand === 'string' &&
    typeof g.doctorCommand === 'string'
  )
}

/** Human output for nodes issue: render server-generated `connectGuide` and alternative reachable endpoints. */
function printIssuedToken(io: Io, issued: NodeIssuedToken): void {
  const guide = issued.connectGuide
  if (!isValidConnectGuide(guide)) {
    throw new CliError('Hub issue response is missing a valid connectGuide', 'invalid_response')
  }
  const primaryKey = guide.hubUrl.replace(/\/+$/, '').toLowerCase()
  const endpoints = issued.hubAccess?.endpoints ?? []
  const otherUrls = endpoints.filter(
    (ep) => ep.kind !== 'loopback' && ep.url.replace(/\/+$/, '').toLowerCase() !== primaryKey,
  )

  const lines = [
    `Access token for node ${issued.nodeId} (shown once; server only stores its digest):`,
    '',
    `  ${issued.token}`,
    '',
    'Install on the managed machine (first time only, requires Node.js >= 24.12):',
    `  ${guide.installCommand}`,
    '',
    'Start and connect on the managed machine:',
    `  ${guide.oneLineCommand}`,
  ]
  if (otherUrls.length > 0) {
    const maxLen = otherUrls.reduce((max, ep) => Math.max(max, ep.url.length), 0)
    lines.push(
      '',
      issued.hubAccess
        ? `Other reachable Hub URLs (listening on ${formatHubListenSummary(issued.hubAccess)}):`
        : 'Other reachable Hub URLs:',
      ...otherUrls.map((ep) => `  ${ep.url.padEnd(maxLen + 2)}(${formatEndpointMeta(ep)})`),
    )
  }
  lines.push(
    '',
    'Optional next steps on the managed machine:',
    `  ${guide.doctorCommand.padEnd(27)}# verify identity permissions and Hub reachability`,
    `  ${guide.serviceInstallCommand}   # auto-start on boot (launchd / systemd --user / schtasks)`,
  )
  if (guide.loopbackWarning) {
    lines.push(
      '',
      `Warning: ${guide.hubUrl} is a loopback address and is unreachable from remote machines.`,
      'Replace --hub with a reachable Hub URL (e.g. start the Hub with HELMX_HOST=0.0.0.0 or front it with a TLS reverse proxy).',
    )
  }
  printText(io, lines.join('\n'))
}

/** Human output for upgrade check: current/latest versions, update availability, and quarantined version. */
function printUpgradeCheck(io: Io, nodeId: string, check: NodeUpgradeCheckResult): void {
  const lines = [
    `Node ${nodeId}: current ${check.currentVersion}, latest ${check.latestVersion}`,
    check.updateAvailable ? 'Update available' : 'Up to date',
  ]
  if (check.blocked !== undefined) {
    lines.push(`Quarantined version ${check.blocked.version} (${check.blocked.reason}, ${check.blocked.at})`)
  }
  printText(io, lines.join('\n'))
}

/**
 * Human output for upgrade result. Honesty rule: ok=false throws CliError (exit 1)
 * in the command handler and never reaches here; when unconfirmed, Hub 502 exits with an error.
 */
function printUpgradeResult(io: Io, nodeId: string, result: NodeUpgradeResult): void {
  if (!result.upgraded) {
    printText(io, `Node ${nodeId} does not need an upgrade (current ${result.previousVersion}, target ${result.targetVersion})`)
    return
  }
  printText(io, [
    `Node ${nodeId} upgraded: ${result.previousVersion} -> ${result.targetVersion}`,
    ...(result.pid !== undefined ? [`New daemon pid ${result.pid}`] : []),
  ].join('\n'))
}

function printForwardDetail(io: Io, forward: NodeForwardSession): void {
  const lines = [
    `Forward ${forward.forwardId}`,
    `Listening ${forward.listenHost}:${forward.listenPort} -> node ${forward.nodeId} ${forward.targetHost}:${forward.targetPort}`,
    `Active connections ${forward.activeConnections} (total ${forward.totalConnections})`,
  ]
  if (forward.lastError !== undefined) lines.push(`Last error ${forward.lastError}`)
  printText(io, lines.join('\n'))
}

/** Minimal guard for upgrade check fields consumed directly by human formatting. */
function requireUpgradeCheckFields(value: unknown): NodeUpgradeCheckResult {
  const v = value as Partial<NodeUpgradeCheckResult> | null | undefined
  if (
    !v || typeof v !== 'object' || Array.isArray(v) ||
    typeof v.currentVersion !== 'string' ||
    typeof v.latestVersion !== 'string' ||
    typeof v.updateAvailable !== 'boolean'
  ) {
    throw new CliError('Hub upgrade check response is missing fields (currentVersion/latestVersion/updateAvailable)', 'invalid_response')
  }
  return v as NodeUpgradeCheckResult
}

function requireValidForwardId(forwardId: unknown): void {
  if (typeof forwardId !== 'string' || !FORWARD_ID_RE.test(forwardId)) {
    throw new CliError('forwardId must be in fwd-<uuid> format', 'invalid_id')
  }
}

const NODE_UPGRADE_SPEC = NODE_CORE_OPERATIONS.find((op) => op.key === 'nodes.upgrade')!

const UPGRADE_SCHEMA_FLAGS = new Map(
  schemaFlagsForOperation(NODE_UPGRADE_SPEC).map((flag) => [flag.name, flag] as const),
)

/** Flag specs for composite `nodes upgrade` command (schema-derived upgrade flags + `--check` / `--current`). */
const UPGRADE_FLAGS: readonly FlagSpec[] = [
  { name: 'check', type: 'boolean', help: 'check for available updates only (mutually exclusive with --version/--force)' },
  {
    ...(UPGRADE_SCHEMA_FLAGS.get('version') ?? { name: 'version', type: 'string' as const }),
    help: 'target version (strict SemVer, optional v prefix; defaults to latest)',
  },
  {
    ...(UPGRADE_SCHEMA_FLAGS.get('registry') ?? { name: 'registry', type: 'string' as const }),
    help: 'npm registry URL (http/https)',
  },
  {
    ...(UPGRADE_SCHEMA_FLAGS.get('force') ?? { name: 'force', type: 'boolean' as const }),
    help: 'force upgrade (ignore canary quarantine; mutually exclusive with --check)',
  },
  { name: 'current', type: 'boolean', help: 'read HELMX_NODE_ID as the target node' },
]

/** Resolve target node: explicit positional nodeId or --current (reads HELMX_NODE_ID); mutually exclusive. */
function resolveNodeTarget(flags: Map<string, unknown>, positionalId: string | undefined, env: NodeJS.ProcessEnv): string {
  const current = flags.get('current') === true
  if (positionalId !== undefined && current) {
    throw new CliError('nodeId and --current are mutually exclusive', 'invalid_flag_value')
  }
  if (positionalId !== undefined) {
    if (positionalId.trim() === '') throw new CliError('nodeId must be a non-empty node ID', 'invalid_id')
    return positionalId
  }
  if (current) {
    const raw = env['HELMX_NODE_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current requires HELMX_NODE_ID to be set', 'current_node_missing')
    }
    return raw.trim()
  }
  throw new CliError('missing node target: provide <nodeId> or --current (reads HELMX_NODE_ID)', 'missing_node_target')
}

/** Parse host:port endpoint for nodes forward: [host:]port; host defaults to 127.0.0.1 (only allowed on target end). */
function parseEndpoint(raw: string, what: string, allowBarePort: boolean): { host?: string; port: number } {
  const trimmed = raw.trim()
  if (trimmed === '') throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080)`, 'invalid_flag_value')
  // IPv6 literal syntax: [::1]:port (with multiple colons, only bracketed syntax is accepted).
  const bracket = trimmed.match(/^\[(.+)\]:(\d+)$/)
  if (bracket) {
    const port = Number(bracket[2])
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
    return { host: bracket[1]!, port }
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) {
    if (!allowBarePort) throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080)`, 'invalid_flag_value')
    if (!/^\d+$/.test(trimmed)) throw new CliError(`${what} must be a port number or host:port`, 'invalid_flag_value')
    const port = Number(trimmed)
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
    return { port }
  }
  const host = trimmed.slice(0, lastColon)
  const portText = trimmed.slice(lastColon + 1)
  if (host === '' || portText === '' || !/^\d+$/.test(portText)) {
    throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080; use [::1]:8080 for IPv6)`, 'invalid_flag_value')
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
  return { host, port }
}

async function runNodesUpgrade(ctx: CommandContext): Promise<void> {
  assertNoExtraPositionals(ctx.positionals, 1)
  const nodeId = resolveNodeTarget(ctx.flags, ctx.positionals[0], ctx.env)
  const check = ctx.flags.get('check') === true
  const version = flagValue<string>(ctx.flags, 'version')
  const registryUrl = flagValue<string>(ctx.flags, 'registry')
  const force = ctx.flags.get('force') === true
  // Mutual exclusion: --check is read-only and cannot be combined with upgrade execution flags.
  if (check && version !== undefined) {
    throw new CliError('--check and --version are mutually exclusive (cannot specify a target version when checking)', 'invalid_flag_value')
  }
  if (check && force) {
    throw new CliError('--check and --force are mutually exclusive (check does not execute an upgrade)', 'invalid_flag_value')
  }
  const hub = await ctx.hub()
  if (check) {
    const query = registryUrl !== undefined ? `?registryUrl=${encodeURIComponent(registryUrl)}` : ''
    const checked = requireUpgradeCheckFields(await hub.get<NodeUpgradeCheckResult>(`/api/nodes/${encodeURIComponent(nodeId)}/upgrade/check${query}`))
    if (ctx.json) printResult(ctx, checked)
    else printUpgradeCheck(ctx.io, nodeId, checked)
    return
  }
  const body: Record<string, unknown> = {}
  if (version !== undefined) {
    if (version.trim() === '') throw new CliError('--version must be a non-empty version (omit to upgrade to latest)', 'invalid_flag_value')
    body['targetVersion'] = version
  }
  if (registryUrl !== undefined) body['registryUrl'] = registryUrl
  if (force) body['force'] = true
  // Upgrade drains in-flight commands and replaces the daemon; disable the default 30s client timeout.
  const upgraded = await hub.request<NodeUpgradeResult>('POST', `/api/nodes/${encodeURIComponent(nodeId)}/upgrade`, {
    ...(Object.keys(body).length > 0 ? { body } : {}),
    timeoutMs: 0,
  })
  if (!upgraded || typeof upgraded !== 'object' || typeof upgraded.ok !== 'boolean') {
    throw new CliError('Hub upgrade response is invalid', 'invalid_response')
  }
  if (!upgraded.ok) {
    // Honesty rule: HTTP 200 with ok:false (explicitly rejected by node) is a failure —
    // exit 1 and never print an incomplete result as exit code 0.
    throw new CliError(
      `node ${nodeId} upgrade did not complete (${upgraded.previousVersion} -> ${upgraded.targetVersion})`,
      'node_upgrade_failed',
    )
  }
  if (ctx.json) printResult(ctx, upgraded)
  else printUpgradeResult(ctx.io, nodeId, upgraded)
}

const NODE_FORWARD_COMMAND: CommandSpec = {
  path: ['nodes', 'forward'],
  description: 'Foreground Hub-host TCP port forwarding to a node (POST /api/nodes/:id/forward; listener binds on the Hub host; press Ctrl-C to close)',
  flags: [
    { name: 'current', type: 'boolean', help: 'read HELMX_NODE_ID as the target node' },
  ],
  positional: '[<nodeId>] <[listenHost:]listenPort> <[targetHost:]targetPort>',
  async run(ctx: CommandContext) {
    // Positional layout: [<nodeId>] <[listenHost:]listenPort> <[targetHost:]targetPort>.
    // Bare listenPort defaults listenHost to 127.0.0.1 on the Hub host.
    const useCurrent = ctx.flags.get('current') === true
    const first = ctx.positionals[0]
    const explicitNodeId = useCurrent
      ? (ctx.positionals.length >= 3 ? first : undefined)
      : (first === undefined || first.includes(':') || /^\d+$/.test(first) ? undefined : first)
    const nodeId = resolveNodeTarget(ctx.flags, explicitNodeId, ctx.env)
    const listenIndex = useCurrent ? 0 : 1
    const listenRaw = requirePositional(ctx.positionals, listenIndex, '[listenHost:]listenPort')
    const targetRaw = requirePositional(ctx.positionals, listenIndex + 1, '[targetHost:]targetPort')
    assertNoExtraPositionals(ctx.positionals, listenIndex + 2)
    const listen = parseEndpoint(listenRaw, '<[listenHost:]listenPort>', true)
    const listenHost = listen.host ?? '127.0.0.1'
    const target = parseEndpoint(targetRaw, '<[targetHost:]targetPort>', true)
    const hub = await ctx.hub()
    // Create the forwarder (listener lives on the Hub host only for the duration of this command; Hub foreground lease auto-stops if the event stream is never attached).
    const forward = await hub.post<NodeForwardSession>(
      `/api/nodes/${encodeURIComponent(nodeId)}/forward`,
      {
        listenHost,
        listenPort: listen.port,
        targetPort: target.port,
        ...(target.host === undefined ? {} : { targetHost: target.host }),
      },
    )
    if (!forward || typeof forward !== 'object' || typeof forward.forwardId !== 'string') {
      throw new CliError('Hub forward create response is missing forwardId', 'invalid_response')
    }
    const forwardId = forward.forwardId

    // Explicit stop: only tolerate already-removed (404 / not_found); rethrow other errors instead of falsely reporting cleanup success.
    const stopForward = async (): Promise<void> => {
      await hub
        .delete(`/api/nodes/forward/${encodeURIComponent(forwardId)}`)
        .catch((error: unknown) => {
          if (error instanceof CliError && error.code === 'not_found') return
          throw error
        })
    }

    let hubStopped = false
    let cleanupError: unknown
    if (!ctx.json) {
      printText(ctx.io, [
        `Forwarding established on Hub host (${hub.baseUrl}): ${forward.listenHost}:${forward.listenPort} -> node ${nodeId} ${target.host ?? '127.0.0.1'}:${target.port}`,
        'Press Ctrl-C to exit and close forwarding.',
      ].join('\n'))
    }
    let outcome: StreamRunResult
    try {
      // NDJSON event stream (acts as foreground lease holder): blocks until disconnected (Hub stopped / network drop / signal).
      outcome = await runWithSignalAbort(
        (stream) =>
          hub.streamNdjson('GET', `/api/nodes/forward/${encodeURIComponent(forwardId)}/events`, {
            signal: stream.signal,
            onLine: (value: unknown) => {
              const event = value as { type?: string; count?: number; message?: string }
              if (event?.type === 'connection') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `Connection established (active ${event.count ?? 0})`)
              } else if (event?.type === 'error') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `Forwarding error: ${event.message ?? 'unknown'}`)
              } else if (event?.type === 'stopped') {
                hubStopped = true
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, 'Hub stopped forwarding')
              }
            },
          }),
        { swallowOnlyOnSignal: true },
      )
    } finally {
      try {
        await stopForward()
      } catch (error) {
        // Never falsely report cleanup success: record error and throw outside the normal return path.
        cleanupError = error
      }
    }
    if (cleanupError !== undefined) {
      throw new CliError(
        `forwarding ended, but cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        'forward_cleanup_failed',
      )
    }
    if (outcome.cancelled || hubStopped) return
    // Event stream ended unexpectedly without a terminal frame (network drop / Hub crash): exit non-zero honestly.
    throw new CliError('forwarding event stream ended (Hub may have stopped forwarding)', 'forward_stream_ended')
  },
}

export function nodesCommands(): CommandSpec[] {
  return commandsFromOperations(NODE_CORE_OPERATIONS, {
    validateInput: {
      'nodes.forward_inspect': (input) => {
        requireValidForwardId(input.id)
      },
      'nodes.forward_stop': (input) => {
        requireValidForwardId(input.id)
      },
    },
    validateResponse: {
      'nodes.list': (value) => {
        if (!Array.isArray(value)) {
          throw new CliError('Hub node list must be an array', 'invalid_response')
        }
      },
      'nodes.endpoints': (value) => {
        const info = value as Partial<HubAccessInfo> | null | undefined
        if (
          !info ||
          typeof info !== 'object' ||
          Array.isArray(info) ||
          typeof info.listenHost !== 'string' ||
          typeof info.listenPort !== 'number' ||
          !Array.isArray(info.endpoints)
        ) {
          throw new CliError('Hub endpoints response is invalid', 'invalid_response')
        }
      },
      'nodes.issue': (value, input) => {
        const issued = value as Partial<NodeIssuedToken> | null | undefined
        const nodeId = input.nodeId
        if (
          !issued ||
          typeof issued !== 'object' ||
          issued.nodeId !== nodeId ||
          typeof issued.token !== 'string' ||
          !issued.token.startsWith(`${String(nodeId)}:`)
        ) {
          throw new CliError('Hub issue response is missing a valid node token', 'invalid_response')
        }
      },
      'nodes.forwards': (value) => {
        if (!Array.isArray(value)) {
          throw new CliError('Hub forward list must be an array', 'invalid_response')
        }
      },
    },
    formatHuman: {
      'nodes.list': (ctx, result) => {
        printNodesTable(ctx.io, result as NodeInfo[])
      },
      'nodes.endpoints': (ctx, result) => {
        printEndpointsOutput(ctx.io, result as HubAccessInfo)
      },
      'nodes.issue': (ctx, result) => {
        printIssuedToken(ctx.io, result as NodeIssuedToken)
      },
      'nodes.forwards': (ctx, result) => {
        printForwardsTable(ctx.io, result as NodeForwardSession[])
      },
      'nodes.forward_inspect': (ctx, result) => {
        printForwardDetail(ctx.io, result as NodeForwardSession)
      },
    },
    customHandlers: {
      'nodes upgrade': {
        description: 'Check or execute a node upgrade (GET/POST /api/nodes/:id/upgrade)',
        flags: UPGRADE_FLAGS,
        positional: '[<nodeId>]',
        run: runNodesUpgrade,
      },
    },
    extraCommands: [NODE_FORWARD_COMMAND],
  })
}
