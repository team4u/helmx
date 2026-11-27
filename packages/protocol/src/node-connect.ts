/**
 * Browser-safe Hub endpoint and managed-node enrollment command builders.
 *
 * Single source of truth consumed by Kernel (`NodeManager.issueNodeToken`),
 * CLI (`helmx nodes issue`), and Web (`NodeDetailDrawer` / `nodes-modal-model`).
 */
import type { HubAccessInfo } from './env-rpc.js'

/** Single-source enrollment command guide generated for connecting a remote `@helmx/node`. */
export interface NodeConnectGuide {
  /** Effective Hub URL embedded into the generated enrollment commands (or `<HUB_URL>` placeholder). */
  hubUrl: string
  /** True when `hubUrl` targets a loopback address (`localhost`, `127.*`, `::1`). */
  loopbackWarning: boolean
  /** First-time global install on the managed machine (Node.js >= 24.12). */
  installCommand: string
  /** One-line enrollment: binds the node identity with --token and starts detached in the background (recommended). */
  oneLineCommand: string
  /** Foreground connection (debug): binds the JOIN token and stays in the foreground; Ctrl+C exits; no daemon installed. */
  connectCommand: string
  /** Start the daemon in the background: reuses the identity already bound on disk, no token needed. */
  startDaemonCommand: string
  serviceInstallCommand: string
  doctorCommand: string
}

const PLACEHOLDER_ARG_RE = /^<[A-Z0-9_]+>$/
const UNQUOTED_SHELL_ARG_RE = /^[A-Za-z0-9._:/@-]+$/

function stripTrailingSlashes(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return trimmed.replace(/\/+$/, '')
}

/**
 * Format a CLI argument for copy-pasteable shell commands:
 * keep plain HTTP(S) URLs, tokens, and `<...>` placeholders clean & unquoted;
 * single-quote only when an actual value contains shell-sensitive characters
 * such as `[` `]` (IPv6 literals), whitespace, `&`, `?`, `;`, `$`, or quotes.
 */
function formatShellArg(raw: string): string {
  if (PLACEHOLDER_ARG_RE.test(raw) || UNQUOTED_SHELL_ARG_RE.test(raw)) {
    return raw
  }
  return `'${raw.replace(/'/g, "'\\''")}'`
}

/** Returns true when a URL targets a loopback address (`localhost`, `127.*`, `::1`). */
export function isLoopbackHubUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.')
  } catch {
    return false
  }
}

/** Format listen host + port for display (brackets IPv6 literals). */
export function formatHubListenSummary(hubAccess: HubAccessInfo): string {
  const host = hubAccess.listenHost.includes(':') && !hubAccess.listenHost.startsWith('[')
    ? `[${hubAccess.listenHost}]`
    : hubAccess.listenHost
  return `${host}:${hubAccess.listenPort}`
}

/**
 * Pick the default Hub enrollment URL when no explicit `--hub` override was supplied:
 * first non-loopback `hubAccess.endpoints` URL, else first `hubAccess.endpoints` URL,
 * else normalized `fallbackUrl`, else `<HUB_URL>`.
 */
export function resolveDefaultHubUrl(
  hubAccess: HubAccessInfo | undefined,
  fallbackUrl?: string,
): string {
  const endpoints = (hubAccess?.endpoints ?? [])
    .map((ep) => stripTrailingSlashes(ep.url))
    .filter((url) => url !== '')
  const nonLoopback = endpoints.find((url) => !isLoopbackHubUrl(url))
  if (nonLoopback !== undefined) return nonLoopback
  if (endpoints.length > 0) return endpoints[0]!
  const cleanFallback = fallbackUrl !== undefined ? stripTrailingSlashes(fallbackUrl) : ''
  return cleanFallback !== '' ? cleanFallback : '<HUB_URL>'
}

/** Build the controlled-machine enrollment command set for a target Hub URL and issued token. */
export function buildNodeConnectGuide(
  hubUrl: string,
  issued: { nodeId?: string; token: string },
): NodeConnectGuide {
  const normalizedHub = stripTrailingSlashes(hubUrl) || '<HUB_URL>'
  const hubArg = formatShellArg(normalizedHub)
  const tokenArg = formatShellArg(issued.token)
  // `connect` stays in the foreground (only Ctrl/Cmd+C exits), so chaining with
  // `&&` would never run the rest; one-line enrollment uses `start -d` whose
  // detach path binds the identity with `--token` before spawning the daemon
  // without leaking `--token` on the long-running daemon command line.
  return {
    hubUrl: normalizedHub,
    loopbackWarning: normalizedHub !== '<HUB_URL>' && isLoopbackHubUrl(normalizedHub),
    installCommand: 'npm install -g @helmx/node',
    oneLineCommand: `helmx-node start -d --hub ${hubArg} --token ${tokenArg}`,
    connectCommand: `helmx-node connect ${hubArg} --token ${tokenArg}`,
    startDaemonCommand: 'helmx-node start -d',
    serviceInstallCommand: 'helmx-node service install',
    doctorCommand: 'helmx-node doctor',
  }
}
