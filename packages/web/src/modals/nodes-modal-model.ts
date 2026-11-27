/**
 * Pure-function model for the compute node helpers:
 * node ID validation, controlled-machine enrollment command generation,
 * usage and uptime formatting. All side-effect free for easy unit testing and
 * Fast Refresh isolation.
 */

import type {
  HubAccessInfo,
  HubEndpointKind,
  NodeInfo,
} from '@helmx/protocol/browser'
import type { SelectOption } from '@helmx/plugin-client'
import { formatBytes } from '../lib/format.js'
import type { WebMessageKey, WebMessageTranslator } from '../i18n/catalog.js'

export { formatBytes }

/** Node ID constraint (same source as the kernel issueNodeToken validation: starts alphanumeric, may contain . _ -, max 128). */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type NodeIdValidation = { ok: true; nodeId: string } | { ok: false; error: string }

/** Validate an enrollment node ID input: trim, reserved names and charset rules. */
export function validateNodeIdInput(raw: string, t: WebMessageTranslator): NodeIdValidation {
  const nodeId = raw.trim()
  if (nodeId === '') return { ok: false, error: t('modals.nodeId.empty') }
  if (nodeId === 'local') return { ok: false, error: t('modals.nodeId.localReserved') }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return { ok: false, error: t('modals.nodeId.invalidChars') }
  }
  return { ok: true, nodeId }
}

export interface NodeConnectGuide {
  /** First-time global install on the managed machine (Node.js >= 24.12). */
  installCommand: string
  /** Foreground connection (debug): binds the JOIN token and stays in the foreground; Ctrl+C exits; no daemon installed. */
  connectCommand: string
  /** Start the daemon in the background: reuses the identity already bound on disk, no token needed. */
  startDaemonCommand: string
  /** One-line enrollment: binds the node identity with --token and starts detached in the background (recommended). */
  oneLineCommand: string
  serviceInstallCommand: string
  doctorCommand: string
}

/** Build the controlled-machine enrollment command set (hubOrigin e.g. http://192.168.1.10:3202). */
export function buildNodeConnectGuide(
  hubOrigin: string,
  issued: { nodeId: string; token: string },
): NodeConnectGuide {
  // connect stays in the foreground (only Ctrl/Cmd+C exits), so chaining with
  // && would never run the rest; one-line enrollment uses start -d: its
  // detach path supports binding the identity with --token and then spawning
  // the background daemon, and the child argv carries no token (avoiding
  // token leaks from long-running process command lines).
  return {
    installCommand: 'npm install -g @helmx/node',
    connectCommand: `helmx-node connect ${hubOrigin} --token ${issued.token}`,
    startDaemonCommand: 'helmx-node start -d',
    oneLineCommand: `helmx-node start -d --hub ${hubOrigin} --token ${issued.token}`,
    serviceInstallCommand: 'helmx-node service install',
    doctorCommand: 'helmx-node doctor',
  }
}

export type HubEndpointOptionKind = HubEndpointKind | 'current'

export interface HubEndpointOption {
  url: string
  displayLabel: string
  kind: HubEndpointOptionKind
  interface?: string
  secondary: boolean
}

export interface ResolvedHubEndpoints {
  primary: HubEndpointOption[]
  more: HubEndpointOption[]
  all: HubEndpointOption[]
  defaultUrl: string
  loopbackWarning: boolean
  listenSummary?: string
}

const ENDPOINT_KIND_MESSAGE_KEYS: Readonly<Record<HubEndpointOptionKind, WebMessageKey>> = {
  current: 'nodes.drawer.endpointKind.current',
  lan: 'nodes.drawer.endpointKind.lan',
  vpn: 'nodes.drawer.endpointKind.vpn',
  public: 'nodes.drawer.endpointKind.public',
  hostname: 'nodes.drawer.endpointKind.hostname',
  ipv6: 'nodes.drawer.endpointKind.ipv6',
  virtual: 'nodes.drawer.endpointKind.virtual',
  loopback: 'nodes.drawer.endpointKind.loopback',
}

function normalizeCandidateUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'null') return undefined
  return trimmed.replace(/\/+$/, '')
}

function candidateUrlKey(raw: string): string {
  return raw.replace(/\/+$/, '').toLowerCase()
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

/** Compact display label for endpoint chips (drops plain `http://`, preserves `https://` for TLS visibility). */
export function formatHubEndpointDisplayLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' ? `https://${parsed.host}` : parsed.host
  } catch {
    return rawUrl
  }
}

/** Format listen host + port for header display (brackets IPv6 literals). */
export function formatHubListenSummary(hubAccess: HubAccessInfo): string {
  const host = hubAccess.listenHost.includes(':') && !hubAccess.listenHost.startsWith('[')
    ? `[${hubAccess.listenHost}]`
    : hubAccess.listenHost
  return `${host}:${hubAccess.listenPort}`
}

/** Format localized endpoint classification tag (`kind` or `kind · interface`). */
export function formatHubEndpointTag(option: HubEndpointOption, t: WebMessageTranslator): string {
  const label = t(ENDPOINT_KIND_MESSAGE_KEYS[option.kind])
  return option.interface ? `${label} · ${option.interface}` : label
}

/**
 * Resolve deduplicated, tiered Hub endpoint options for `NodeDetailDrawer`:
 * - Non-loopback `browserOrigin` is placed first as `current` (inheriting interface metadata if matched);
 * - Server-discovered `hubAccess.endpoints` follow in reachability priority order;
 * - Virtual bridges, loopback addresses, and overflow primary items collapse into `more`;
 * - Falls back to `<HUB_URL>` when neither server metadata nor a valid browser origin is present.
 */
export function resolveHubEndpointOptions(input: {
  hubAccess?: HubAccessInfo
  browserOrigin?: string
  preferredUrl?: string
  primaryCap?: number
}): ResolvedHubEndpoints {
  const primaryCap = input.primaryCap ?? 4
  const browserUrl = normalizeCandidateUrl(input.browserOrigin)
  const byKey = new Map<string, HubEndpointOption>()

  const pushOption = (
    url: string,
    kind: HubEndpointOptionKind,
    iface: string | undefined,
    secondary: boolean,
  ): void => {
    const key = candidateUrlKey(url)
    const existing = byKey.get(key)
    if (existing !== undefined) {
      if (existing.interface === undefined && iface !== undefined) {
        existing.interface = iface
      }
      return
    }
    byKey.set(key, {
      url,
      displayLabel: formatHubEndpointDisplayLabel(url),
      kind,
      ...(iface !== undefined ? { interface: iface } : {}),
      secondary,
    })
  }

  if (browserUrl !== undefined && !isLoopbackHubUrl(browserUrl)) {
    pushOption(browserUrl, 'current', undefined, false)
  }

  for (const ep of input.hubAccess?.endpoints ?? []) {
    const clean = normalizeCandidateUrl(ep.url)
    if (clean === undefined) continue
    pushOption(clean, ep.kind, ep.interface, ep.kind === 'virtual' || ep.kind === 'loopback')
  }

  if (browserUrl !== undefined && isLoopbackHubUrl(browserUrl)) {
    pushOption(browserUrl, 'loopback', undefined, true)
  }

  if (byKey.size === 0) {
    pushOption('<HUB_URL>', 'current', undefined, false)
  }

  const primary: HubEndpointOption[] = []
  const more: HubEndpointOption[] = []
  for (const opt of byKey.values()) {
    if (!opt.secondary && primary.length < primaryCap) {
      primary.push(opt)
    } else {
      more.push(opt)
    }
  }
  if (primary.length === 0 && more.length > 0) {
    const promoted = more.shift()!
    primary.push({ ...promoted, secondary: false })
  }

  let defaultUrl = primary[0]!.url
  const pref = normalizeCandidateUrl(input.preferredUrl)
  if (pref !== undefined && !isLoopbackHubUrl(pref)) {
    const prefKey = candidateUrlKey(pref)
    const inPrimary = primary.find((opt) => candidateUrlKey(opt.url) === prefKey)
    if (inPrimary !== undefined) {
      defaultUrl = inPrimary.url
    } else {
      const moreIdx = more.findIndex((opt) => candidateUrlKey(opt.url) === prefKey)
      if (moreIdx !== -1) {
        const [promoted] = more.splice(moreIdx, 1)
        primary.push({ ...promoted!, secondary: false })
        defaultUrl = promoted!.url
      }
    }
  }

  return {
    primary,
    more,
    all: [...primary, ...more],
    defaultUrl,
    loopbackWarning: defaultUrl !== '<HUB_URL>' && isLoopbackHubUrl(defaultUrl),
    ...(input.hubAccess ? { listenSummary: formatHubListenSummary(input.hubAccess) } : {}),
  }
}

/** Uptime formatting (days/hours/minutes; compact locale-neutral units). */
export function formatUptime(uptimeSec: number | undefined): string {
  if (uptimeSec === undefined || !Number.isFinite(uptimeSec) || uptimeSec < 0) return '--'
  const totalMin = Math.floor(uptimeSec / 60)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (parts.length < 2) parts.push(`${minutes}m`)
  return parts.join(' ')
}

export interface NodeUsageInfo {
  usedBytes: number
  totalBytes: number
  percent: number
  label: string
}

/** Node option label for conversation/profile pickers: id + local/offline annotation. */
export function nodeOptionLabel(node: NodeInfo, t: WebMessageTranslator): string {
  if (node.kind === 'local') return t('modals.nodeOption.local', { id: node.id })
  return node.online ? node.id : t('modals.nodeOption.offline', { id: node.id })
}

export interface BuildNodeSelectOptionsInput {
  nodes: ReadonlyArray<NodeInfo>
  selectedNodeId?: string
  t: WebMessageTranslator
  /** Prepend an unbound empty-value option (used by ProfileDetailDrawer). */
  unboundLabel?: string
  /** Ensure a `local` fallback entry exists when `nodes` has not loaded `local` yet. */
  ensureLocal?: boolean
  /** Custom label builder when `selectedNodeId` is absent from `nodes`. */
  unknownNodeLabel?: (nodeId: string) => string
}

/**
 * Deduplicated SelectOption builder shared by ProfileDetailDrawer and
 * Composer/Standby environment bars: guarantees unique option values by node id
 * and optionally prepends an unbound option or appends an unknown-node fallback.
 */
export function buildNodeSelectOptions({
  nodes,
  selectedNodeId,
  t,
  unboundLabel,
  ensureLocal = false,
  unknownNodeLabel,
}: BuildNodeSelectOptionsInput): SelectOption<string>[] {
  const seen = new Set<string>()
  const list: SelectOption<string>[] = []
  if (unboundLabel !== undefined) {
    seen.add('')
    list.push({ value: '', label: unboundLabel, icon: 'monitor' })
  }
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    const isLocal = node.id === 'local' || node.kind === 'local'
    list.push({
      value: node.id,
      label: nodeOptionLabel(node, t),
      icon: isLocal ? 'monitor' : 'network',
      meta: isLocal ? undefined : node.online ? t('common.online') : t('common.offline'),
    })
  }
  if (ensureLocal && !seen.has('local')) {
    seen.add('local')
    list.unshift({
      value: 'local',
      label: t('modals.nodeOption.local', { id: 'local' }),
      icon: 'monitor',
    })
  }
  const current = selectedNodeId?.trim() ?? ''
  if (current !== '' && !seen.has(current)) {
    list.push({
      value: current,
      label: unknownNodeLabel ? unknownNodeLabel(current) : current,
      icon: 'alert-circle',
    })
  }
  return list
}

/** Usage computation (free + total -> used / percent / label); missing data returns null. */
export function formatUsage(
  freeBytes: number | undefined,
  totalBytes: number | undefined,
  t: WebMessageTranslator,
): NodeUsageInfo | null {
  if (
    freeBytes === undefined ||
    totalBytes === undefined ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return null
  }
  const usedBytes = totalBytes - freeBytes
  const percent = Math.round((usedBytes / totalBytes) * 100)
  return {
    usedBytes,
    totalBytes,
    percent,
    label: t('modals.nodeUsage.label', {
      used: formatBytes(usedBytes),
      total: formatBytes(totalBytes),
      percent,
    }),
  }
}
