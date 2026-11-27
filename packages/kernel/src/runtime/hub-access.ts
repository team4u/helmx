/**
 * Hub reachable endpoint discovery (`HubAccessInfo`):
 *
 * Derives the honest list of candidate Hub HTTP URLs from the real HTTP server socket binding
 * (`HubListenInfo`) plus `os.networkInterfaces()` and `os.hostname()`:
 * - Wildcard listeners (`0.0.0.0` / `::`): enumerate non-internal NICs (IPv4-only for `0.0.0.0`,
 *   IPv4 + IPv6 for `::`), classify LAN / VPN / Public / Virtual bridges, append OS hostname, and
 *   keep loopback last;
 * - Specific non-loopback IP listener: expose only that bound IP (matched to its NIC) + OS hostname;
 * - Specific non-loopback hostname listener: expose that hostname + resolved socket IP (if any) + OS hostname;
 * - Loopback-only listener (`127.0.0.1` / `::1` / `localhost`): expose only the loopback URL and
 *   mark `loopbackOnly: true` without fabricating unreachable LAN/hostname entries.
 */
import { lookup as dnsLookup, lookupService as dnsLookupService } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { hostname as getOsHostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { HubAccessEndpoint, HubAccessInfo, HubEndpointKind } from '@helmx/protocol'

export interface HubListenInfo {
  host: string
  resolvedAddress?: string
  port: number
}

const KIND_RANK: Readonly<Record<HubEndpointKind, number>> = {
  lan: 0,
  vpn: 1,
  public: 2,
  hostname: 3,
  ipv6: 4,
  virtual: 5,
  loopback: 6,
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function stripIpv6Zone(host: string): string {
  const pct = host.indexOf('%')
  return pct === -1 ? host : host.slice(0, pct)
}

/** Format a bare host for HTTP URL usage (wraps unbracketed IPv6 literals in `[...]`). */
export function formatUrlHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed
}

/** Format a bare host and TCP port as an HTTP URL. */
export function formatHttpUrl(host: string, port: number): string {
  return `http://${formatUrlHost(host)}:${port}`
}

/** Extract listen host and port from a Hub URL string when socket metadata is absent. */
export function parseListenInfoFromUrl(hubUrl: string): HubListenInfo | undefined {
  let parsed: URL
  try {
    parsed = new URL(hubUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = stripBrackets(parsed.hostname)
  if (host === '') return undefined
  const port =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

function isWildcardHost(host: string): boolean {
  const bare = stripIpv6Zone(stripBrackets(host.trim())).toLowerCase()
  return bare === '' || bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0'
}

function isLoopbackHost(host: string): boolean {
  const bare = stripIpv6Zone(stripBrackets(host.trim())).toLowerCase()
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    bare.startsWith('127.') ||
    bare.startsWith('::ffff:127.')
  )
}

function isVirtualInterfaceName(name: string): boolean {
  return (
    /^(docker|br-|veth|virbr|cni|flannel|cali|kube-ipvs|podman|lxcbr|vmnet|vboxnet|bridge|awdl|llw|anpi|ap\d|vmenet)/i.test(name) ||
    /(vEthernet|WSL|Hyper-V|VMware|VirtualBox|Loopback)/i.test(name)
  )
}

function isVpnInterfaceName(name: string): boolean {
  return (
    /^(tailscale|wg|utun|tun|tap|zt|nebula|nordlynx|mullvad)/i.test(name) ||
    /(Tailscale|WireGuard|ZeroTier)/i.test(name)
  )
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1))
  if (octets.some((o) => o < 0 || o > 255)) return null
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
}

function classifyIpv4(ip: string, ifaceName?: string): HubEndpointKind | null {
  const octets = parseIpv4Octets(ip)
  if (octets === null) return null
  const [o1, o2] = octets
  if (o1 === 127) return 'loopback'
  if (o1 === 169 && o2 === 254) return null
  // Classify container/virtual interfaces before RFC 1918 so docker0 (172.17.0.1) is marked virtual, not lan.
  if (ifaceName !== undefined && isVirtualInterfaceName(ifaceName)) return 'virtual'
  if ((o1 === 100 && o2 >= 64 && o2 <= 127) || (ifaceName !== undefined && isVpnInterfaceName(ifaceName))) {
    return 'vpn'
  }
  if (o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)) {
    return 'lan'
  }
  return 'public'
}

function classifyIpv6(rawIp: string, ifaceName?: string): HubEndpointKind | null {
  const ip = stripIpv6Zone(stripBrackets(rawIp)).toLowerCase()
  if (ip === '' || isWildcardHost(ip)) return null
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return 'loopback'
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mappedV4 !== null) {
    return classifyIpv4(mappedV4[1]!, ifaceName)
  }
  // Skip link-local (fe80::/10) and multicast (ff00::/8) addresses that are unusable across hosts.
  if (/^fe[89ab][0-9a-f]?:/i.test(ip) || ip.startsWith('ff')) return null
  if (ifaceName !== undefined && isVirtualInterfaceName(ifaceName)) return 'virtual'
  if (ifaceName !== undefined && isVpnInterfaceName(ifaceName)) return 'vpn'
  return 'ipv6'
}

function normalizeHostname(name: string): string {
  return name.trim().replace(/\.+$/, '')
}

function isLoopbackStubHostname(lower: string): boolean {
  return (
    lower === 'localhost' ||
    lower === 'localhost.localdomain' ||
    lower === 'ip6-localhost' ||
    lower === 'ip6-loopback' ||
    lower.endsWith('.localdomain')
  )
}

function isUsableHostname(name: string): boolean {
  const trimmed = normalizeHostname(name)
  return (
    trimmed !== '' &&
    !isLoopbackStubHostname(trimmed.toLowerCase()) &&
    !/\s/.test(trimmed) &&
    isIP(trimmed) === 0
  )
}

/** Whether a candidate hostname is a non-loopback FQDN (contains at least one domain separator). */
export function isUsableFqdn(name: string): boolean {
  const trimmed = normalizeHostname(name)
  return isUsableHostname(trimmed) && trimmed.includes('.')
}

/**
 * Parse `/etc/hosts` for a canonical FQDN alias paired with `shortHost`, ignoring comments and
 * loopback stubs (`localhost.localdomain`, `*.localdomain`). Prefers aliases starting with
 * `<shortHost>.`, falling back to the first valid FQDN alias on a matching line.
 */
export function parseHostsFileForFqdn(content: string, shortHost: string): string | undefined {
  const targetLower = normalizeHostname(shortHost).toLowerCase()
  if (targetLower === '') return undefined
  const targetPrefix = `${targetLower}.`
  let fallback: string | undefined
  for (const rawLine of content.split(/\r?\n/)) {
    const clean = rawLine.replace(/#.*$/, '').trim()
    if (clean === '') continue
    const tokens = clean.split(/\s+/)
    if (tokens.length < 2) continue
    const aliases = tokens.slice(1)
    if (!aliases.some((alias) => normalizeHostname(alias).toLowerCase() === targetLower)) {
      continue
    }
    for (const rawAlias of aliases) {
      const alias = normalizeHostname(rawAlias)
      if (!isUsableFqdn(alias)) continue
      if (alias.toLowerCase().startsWith(targetPrefix)) return alias
      if (fallback === undefined) fallback = alias
    }
  }
  return fallback
}

export interface ResolveHostFqdnDeps {
  osHostname?: () => string
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>
  lookupService?: (address: string, port: number) => Promise<{ hostname: string; service: string }>
  readHostsFile?: () => Promise<string>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  timeoutMs?: number
}

/**
 * Discover the host's canonical FQDN when `os.hostname()` only reports a short label:
 * `/etc/hosts` -> bounded DNS canonical/reverse lookup -> Windows `USERDNSDOMAIN`.
 * Never fabricates domains from interface state; returns `undefined` if unavailable.
 */
export async function resolveHostFqdn(deps: ResolveHostFqdnDeps = {}): Promise<string | undefined> {
  const shortHost = normalizeHostname((deps.osHostname ?? getOsHostname)())
  if (!isUsableHostname(shortHost)) return undefined
  if (shortHost.includes('.')) {
    return isUsableFqdn(shortHost) ? shortHost : undefined
  }

  const platform = deps.platform ?? process.platform
  if (platform !== 'win32' || deps.readHostsFile !== undefined) {
    const readHosts = deps.readHostsFile ?? (() => readFile('/etc/hosts', 'utf8'))
    const content = await readHosts().catch(() => undefined)
    if (content !== undefined) {
      const fromHosts = parseHostsFileForFqdn(content, shortHost)
      if (fromHosts !== undefined) return fromHosts
    }
  }

  const timeoutMs = deps.timeoutMs ?? 1_500
  const lookup = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true }))
  const lookupService = deps.lookupService ?? dnsLookupService
  const resolveViaDns = async (): Promise<string | undefined> => {
    const entries = await lookup(shortHost).catch(() => [])
    const shortPrefix = `${shortHost.toLowerCase()}.`
    let fallback: string | undefined
    for (const entry of entries) {
      const rev = await lookupService(entry.address, 0).catch(() => undefined)
      const candidate = rev?.hostname !== undefined ? normalizeHostname(rev.hostname) : ''
      if (!isUsableFqdn(candidate)) continue
      if (candidate.toLowerCase().startsWith(shortPrefix)) return candidate
      if (fallback === undefined) fallback = candidate
    }
    return fallback
  }

  let timer: NodeJS.Timeout | undefined
  const dnsFqdn = await (
    timeoutMs > 0
      ? Promise.race([
          resolveViaDns(),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs)
            timer.unref?.()
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer)
        })
      : resolveViaDns()
  ).catch(() => undefined)
  if (dnsFqdn !== undefined) return dnsFqdn

  if (platform === 'win32') {
    const rawDomain = (deps.env ?? process.env)['USERDNSDOMAIN']?.trim().replace(/^\.+|\.+$/g, '') ?? ''
    if (rawDomain !== '') {
      const combined = normalizeHostname(`${shortHost}.${rawDomain.toLowerCase()}`)
      if (isUsableFqdn(combined)) return combined
    }
  }

  return undefined
}

function familyOf(entry: NetworkInterfaceInfo): 'IPv4' | 'IPv6' | null {
  const raw = String(entry.family)
  if (raw === 'IPv4' || raw === '4') return 'IPv4'
  if (raw === 'IPv6' || raw === '6') return 'IPv6'
  return null
}

function findInterfaceForAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  ip: string,
): string | undefined {
  const target = stripIpv6Zone(stripBrackets(ip)).toLowerCase()
  for (const [ifaceName, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (stripIpv6Zone(stripBrackets(entry.address)).toLowerCase() === target) {
        return ifaceName
      }
    }
  }
  return undefined
}

function lanSubRank(host: string): number {
  if (host.startsWith('192.168.') || host.startsWith('10.')) return 0
  if (host.startsWith('172.')) return 1
  return 2
}

function sortEndpoints(endpoints: HubAccessEndpoint[]): HubAccessEndpoint[] {
  return [...endpoints].sort((a, b) => {
    const rankDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (rankDiff !== 0) return rankDiff
    if (a.kind === 'hostname') return 0
    if (a.kind === 'lan') {
      const subDiff = lanSubRank(a.host) - lanSubRank(b.host)
      if (subDiff !== 0) return subDiff
    }
    const ifaceDiff = (a.interface ?? '').localeCompare(b.interface ?? '')
    if (ifaceDiff !== 0) return ifaceDiff
    return a.host.localeCompare(b.host)
  })
}

function upsertEndpoint(map: Map<string, HubAccessEndpoint>, candidate: HubAccessEndpoint): void {
  const key = candidate.url.toLowerCase()
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, candidate)
    return
  }
  const existingRank = KIND_RANK[existing.kind]
  const incomingRank = KIND_RANK[candidate.kind]
  if (incomingRank < existingRank) {
    map.set(key, {
      ...candidate,
      ...(candidate.interface === undefined && existing.interface !== undefined
        ? { interface: existing.interface }
        : {}),
    })
  } else if (existing.interface === undefined && candidate.interface !== undefined) {
    map.set(key, { ...existing, interface: candidate.interface })
  }
}

export interface BuildHubAccessOptions {
  listen?: HubListenInfo
  hubUrl?: string
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
  osHostname?: string
  hostFqdn?: string
}

/**
 * Compute sorted, deduplicated reachable Hub endpoints from socket binding + host network state.
 */
export function buildHubAccessInfo(options: BuildHubAccessOptions): HubAccessInfo | undefined {
  const listen = options.listen ?? (options.hubUrl !== undefined ? parseListenInfoFromUrl(options.hubUrl) : undefined)
  if (listen === undefined || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) {
    return undefined
  }

  const rawHost = stripBrackets(listen.host.trim())
  const listenHost = rawHost === '' ? '0.0.0.0' : rawHost
  const port = listen.port
  const interfaces = options.interfaces ?? networkInterfaces()
  const rawOsHostname = normalizeHostname(options.osHostname ?? getOsHostname())
  const rawFqdn = normalizeHostname(options.hostFqdn ?? '')
  const hostName = isUsableFqdn(rawFqdn) ? rawFqdn : rawOsHostname
  const map = new Map<string, HubAccessEndpoint>()

  const pushAddress = (host: string, kind: HubEndpointKind, ifaceName?: string): void => {
    upsertEndpoint(map, {
      url: formatHttpUrl(host, port),
      host,
      kind,
      ...(ifaceName !== undefined ? { interface: ifaceName } : {}),
    })
  }

  if (isWildcardHost(listenHost)) {
    const ipv4Only = listenHost === '0.0.0.0'
    for (const [ifaceName, entries] of Object.entries(interfaces)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (entry.internal) continue
        const fam = familyOf(entry)
        if (fam === 'IPv4') {
          const kind = classifyIpv4(entry.address, ifaceName)
          if (kind !== null) pushAddress(entry.address, kind, ifaceName)
        } else if (fam === 'IPv6' && !ipv4Only) {
          const bareIp = stripIpv6Zone(entry.address)
          const kind = classifyIpv6(bareIp, ifaceName)
          if (kind !== null) pushAddress(bareIp, kind, ifaceName)
        }
      }
    }
    if (isUsableHostname(hostName)) {
      pushAddress(hostName, 'hostname')
    }
    const hasIpv4 = [...map.values()].some((ep) => isIP(ep.host) === 4)
    const loopbackFallback = ipv4Only || hasIpv4 ? '127.0.0.1' : '::1'
    pushAddress(loopbackFallback, 'loopback')
    return {
      listenHost,
      listenPort: port,
      wildcard: true,
      loopbackOnly: false,
      endpoints: sortEndpoints([...map.values()]),
    }
  }

  if (isLoopbackHost(listenHost)) {
    const cleanHost = stripIpv6Zone(listenHost)
    pushAddress(cleanHost, 'loopback')
    return {
      listenHost: cleanHost,
      listenPort: port,
      wildcard: false,
      loopbackOnly: true,
      endpoints: sortEndpoints([...map.values()]),
    }
  }

  const cleanListenHost = stripIpv6Zone(listenHost)
  const ipFamily = isIP(cleanListenHost)
  if (ipFamily !== 0) {
    const ifaceName = findInterfaceForAddress(interfaces, cleanListenHost)
    const kind =
      ipFamily === 4
        ? (classifyIpv4(cleanListenHost, ifaceName) ?? 'lan')
        : (classifyIpv6(cleanListenHost, ifaceName) ?? 'ipv6')
    pushAddress(cleanListenHost, kind, ifaceName)
    if (isUsableHostname(hostName) && hostName.toLowerCase() !== cleanListenHost.toLowerCase()) {
      pushAddress(hostName, 'hostname')
    }
    return {
      listenHost: cleanListenHost,
      listenPort: port,
      wildcard: false,
      loopbackOnly: false,
      endpoints: sortEndpoints([...map.values()]),
    }
  }

  // Specific non-loopback hostname binding (e.g. HELMX_HOST=dev-box.local)
  pushAddress(listenHost, 'hostname')
  const resolvedRaw = listen.resolvedAddress !== undefined ? stripIpv6Zone(stripBrackets(listen.resolvedAddress.trim())) : ''
  if (
    resolvedRaw !== '' &&
    !isWildcardHost(resolvedRaw) &&
    !isLoopbackHost(resolvedRaw) &&
    resolvedRaw.toLowerCase() !== listenHost.toLowerCase()
  ) {
    const resolvedFamily = isIP(resolvedRaw)
    if (resolvedFamily !== 0) {
      const ifaceName = findInterfaceForAddress(interfaces, resolvedRaw)
      const kind =
        resolvedFamily === 4
          ? (classifyIpv4(resolvedRaw, ifaceName) ?? 'lan')
          : (classifyIpv6(resolvedRaw, ifaceName) ?? 'ipv6')
      pushAddress(resolvedRaw, kind, ifaceName)
    }
  }
  if (isUsableHostname(hostName) && hostName.toLowerCase() !== listenHost.toLowerCase()) {
    pushAddress(hostName, 'hostname')
  }
  return {
    listenHost,
    listenPort: port,
    wildcard: false,
    loopbackOnly: false,
    endpoints: sortEndpoints([...map.values()]),
  }
}
