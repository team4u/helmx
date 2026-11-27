/**
 * Pure input normalization, security boundary checks, and address-conflict
 * detection for `builtin:port-forward`.
 */
import { HelmxError, isJsonObject } from '@helmx/protocol'
import {
  RESERVED_HUB_PORTS,
  type PortForwardRule,
  type PortForwardRulesDoc,
} from './contracts.js'

const RULE_NAME_MAX_LENGTH = 120
const NODE_ID_MAX_LENGTH = 128
const HOST_MAX_LENGTH = 255

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/
const WHITESPACE_RE = /\s/

/** Strip optional matching IPv6 brackets `[::1]` -> `::1`. */
function unwrapBrackets(host: string): string | null {
  if (host.startsWith('[')) {
    if (!host.endsWith(']') || host.length <= 2) return null
    const inner = host.slice(1, -1)
    if (inner.includes('[') || inner.includes(']')) return null
    return inner
  }
  if (host.includes('[') || host.includes(']')) return null
  return host
}

/** Canonical host key for conflict comparison (`localhost` normalized to `127.0.0.1`). */
function canonicalHostKey(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower === 'localhost' ? '127.0.0.1' : lower
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export function isWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '0:0:0:0:0:0:0:0'
}

export function normalizeHost(
  raw: unknown,
  field: 'listenHost' | 'targetHost',
  defaultHost = '127.0.0.1',
): string {
  if (raw === undefined) return defaultHost
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a string`, 400, { field })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return defaultHost
  if (trimmed.length > HOST_MAX_LENGTH || WHITESPACE_RE.test(trimmed) || CONTROL_CHAR_RE.test(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `${field} must be a valid non-empty hostname or IP address without whitespace`,
      400,
      { field },
    )
  }
  if (trimmed === '*' || trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@')) {
    throw new HelmxError(
      'validation_error',
      `${field} must be an IP address or hostname (use 0.0.0.0 or :: instead of * or URL syntax)`,
      400,
      { field },
    )
  }
  const unwrapped = unwrapBrackets(trimmed)
  if (unwrapped === null || unwrapped.length === 0) {
    throw new HelmxError('validation_error', `${field} has invalid IPv6 bracket syntax`, 400, { field })
  }
  // Reject unbracketed host:port (single colon) while permitting IPv6 (>= 2 colons).
  const colonCount = (unwrapped.match(/:/g) ?? []).length
  if (colonCount === 1) {
    throw new HelmxError(
      'validation_error',
      `${field} must contain only host/IP without a :port suffix`,
      400,
      { field },
    )
  }
  if (colonCount >= 2 && !/^[0-9a-fA-F:.%_-]+$/.test(unwrapped)) {
    throw new HelmxError('validation_error', `${field} contains invalid IPv6 characters`, 400, { field })
  }
  if (colonCount === 0 && !/^[A-Za-z0-9._-]+$/.test(unwrapped)) {
    throw new HelmxError('validation_error', `${field} contains invalid hostname characters`, 400, { field })
  }
  return unwrapped
}

export function normalizePort(
  raw: unknown,
  field: 'listenPort' | 'targetPort',
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > 65535) {
    throw new HelmxError(
      'validation_error',
      `${field} must be an integer between 1 and 65535 (port 0 is disallowed)`,
      400,
      { field, value: raw },
    )
  }
  if (field === 'listenPort') {
    const dynamicHubPort = Number(env['HELMX_PORT'])
    const isReservedDynamic =
      Number.isSafeInteger(dynamicHubPort) && dynamicHubPort > 0 && raw === dynamicHubPort
    if (RESERVED_HUB_PORTS.has(raw) || isReservedDynamic) {
      throw new HelmxError(
        'validation_error',
        `listenPort ${raw} is reserved by Helmx Hub/Web and cannot be bound by port-forward`,
        400,
        { field, port: raw, reason: 'reserved_port' },
      )
    }
  }
  return raw
}

export function normalizeRuleName(raw: unknown, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'name must be a string', 400, { field: 'name' })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return fallback
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new HelmxError('validation_error', 'name must not contain control characters', 400, { field: 'name' })
  }
  if (trimmed.length > RULE_NAME_MAX_LENGTH) {
    throw new HelmxError(
      'validation_error',
      `name must be at most ${RULE_NAME_MAX_LENGTH} characters`,
      400,
      { field: 'name', maxLength: RULE_NAME_MAX_LENGTH },
    )
  }
  return trimmed
}

export function normalizeNodeId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'nodeId must be a non-empty string', 400, { field: 'nodeId' })
  }
  const trimmed = raw.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > NODE_ID_MAX_LENGTH ||
    WHITESPACE_RE.test(trimmed) ||
    CONTROL_CHAR_RE.test(trimmed)
  ) {
    throw new HelmxError(
      'validation_error',
      `nodeId must be a valid identifier (1-${NODE_ID_MAX_LENGTH} non-whitespace characters)`,
      400,
      { field: 'nodeId' },
    )
  }
  return trimmed
}

export function defaultRuleName(
  nodeId: string,
  listenPort: number,
  targetHost: string,
  targetPort: number,
): string {
  return `${nodeId} :${listenPort} -> ${targetHost}:${targetPort}`
}

export function assertListenHostAllowed(listenHost: string, allowPublicBind: boolean): void {
  if (!allowPublicBind && !isLoopbackHost(listenHost)) {
    throw new HelmxError(
      'public_bind_disabled',
      `Listening on non-loopback address '${listenHost}' is disabled by security policy; enable allowPublicBind in plugin settings first`,
      403,
      { listenHost },
    )
  }
}

export function listenEndpointsConflict(
  a: { listenHost: string; listenPort: number },
  b: { listenHost: string; listenPort: number },
): boolean {
  if (a.listenPort !== b.listenPort) return false
  if (isWildcardHost(a.listenHost) || isWildcardHost(b.listenHost)) return true
  return canonicalHostKey(a.listenHost) === canonicalHostKey(b.listenHost)
}

export function assertNoListenConflict(
  candidate: { listenHost: string; listenPort: number },
  existingRules: ReadonlyArray<PortForwardRule>,
  ignoreRuleId?: string,
): void {
  for (const rule of existingRules) {
    if (ignoreRuleId !== undefined && rule.id === ignoreRuleId) continue
    if (listenEndpointsConflict(candidate, rule)) {
      throw new HelmxError(
        'port_forward_conflict',
        `Listen endpoint ${candidate.listenHost}:${candidate.listenPort} conflicts with existing rule '${rule.name}' (${rule.listenHost}:${rule.listenPort})`,
        409,
        {
          listenHost: candidate.listenHost,
          listenPort: candidate.listenPort,
          conflictRuleId: rule.id,
          conflictRuleName: rule.name,
        },
      )
    }
  }
}

export function sanitizeRulesDoc(raw: unknown): PortForwardRulesDoc {
  if (!isJsonObject(raw) || !Array.isArray(raw['items'])) {
    return { items: [] }
  }
  const items: PortForwardRule[] = []
  const seen = new Set<string>()
  for (const entry of raw['items']) {
    if (!isJsonObject(entry)) continue
    const id = typeof entry['id'] === 'string' && entry['id'].trim() !== '' ? entry['id'].trim() : undefined
    const nodeId = typeof entry['nodeId'] === 'string' && entry['nodeId'].trim() !== '' ? entry['nodeId'].trim() : undefined
    const listenHost = typeof entry['listenHost'] === 'string' && entry['listenHost'].trim() !== '' ? entry['listenHost'].trim() : undefined
    const targetHost = typeof entry['targetHost'] === 'string' && entry['targetHost'].trim() !== '' ? entry['targetHost'].trim() : undefined
    const listenPort = entry['listenPort']
    const targetPort = entry['targetPort']
    if (
      id === undefined ||
      seen.has(id) ||
      nodeId === undefined ||
      listenHost === undefined ||
      targetHost === undefined ||
      typeof listenPort !== 'number' ||
      !Number.isSafeInteger(listenPort) ||
      listenPort < 1 ||
      listenPort > 65535 ||
      typeof targetPort !== 'number' ||
      !Number.isSafeInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65535
    ) {
      continue
    }
    seen.add(id)
    const createdAt = typeof entry['createdAt'] === 'number' && Number.isFinite(entry['createdAt']) ? entry['createdAt'] : 0
    const updatedAt = typeof entry['updatedAt'] === 'number' && Number.isFinite(entry['updatedAt']) ? entry['updatedAt'] : createdAt
    const name =
      typeof entry['name'] === 'string' && entry['name'].trim() !== ''
        ? entry['name'].trim()
        : defaultRuleName(nodeId, listenPort, targetHost, targetPort)
    items.push({
      id,
      name,
      nodeId,
      listenHost,
      listenPort,
      targetHost,
      targetPort,
      enabled: entry['enabled'] === true,
      createdAt,
      updatedAt,
    })
  }
  return { items }
}
