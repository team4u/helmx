/**
 * Pure data models and helper functions for `builtin:port-forward` client UI
 * (no component exports — Fast Refresh friendly; zero runtime `@helmx/protocol` imports).
 */
import type { KeyboardEvent } from 'react'
import type { NodeInfo } from '@helmx/protocol/browser'
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
  type SelectOption,
  type StatusLightTone,
} from '@helmx/plugin-client'

export const PF_PLUGIN_ID = 'builtin:port-forward'
export const PF_SCREEN_ID = 'main'
export const PF_RULES_DOC = 'rules'
export const PF_RUNTIME_DOC = 'runtime'

const RESERVED_HUB_PORTS = new Set([3000, 3001, 3002, 3101, 3102, 3201, 3202])

export type PortForwardListenerState = 'stopped' | 'listening' | 'error'

export interface PortForwardRule {
  id: string
  name: string
  nodeId: string
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface PortForwardRuntimeEntry {
  listenerState: PortForwardListenerState
  activeConnections: number
  totalConnections: number
  lastError?: string
  startedAt?: number
}

export type PortForwardViewStatusKind =
  | 'active_traffic'
  | 'listening'
  | 'waiting_node'
  | 'error'
  | 'stopped'

export interface SynthesizedPortForwardRow extends PortForwardRule, PortForwardRuntimeEntry {
  statusKind: PortForwardViewStatusKind
  displayTone: StatusLightTone
  nodeOnline: boolean | undefined
  nodeKnown: boolean | undefined
  listenAddr: string
  targetAddr: string
}

export type StatusFilter = 'all' | 'active' | 'stopped' | 'error'

export interface PortForwardDraftForm {
  name: string
  nodeId: string
  listenHost: string
  listenPort: string
  targetHost: string
  targetPort: string
  enabled: boolean
}

export type DraftValidationErrorCode =
  | 'node_required'
  | 'listen_host_invalid'
  | 'listen_port_invalid'
  | 'target_host_invalid'
  | 'target_port_invalid'
  | 'public_bind_disabled'

export type ValidatedDraftResult =
  | {
      ok: true
      payload: {
        name?: string
        nodeId: string
        listenHost: string
        listenPort: number
        targetHost: string
        targetPort: number
        enabled: boolean
      }
    }
  | { ok: false; errorCode: DraftValidationErrorCode }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatEndpoint(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`
}

export function parseRulesDoc(raw: unknown): PortForwardRule[] {
  if (!isRecord(raw) || !Array.isArray(raw['items'])) return []
  const out: PortForwardRule[] = []
  for (const item of raw['items']) {
    if (!isRecord(item)) continue
    if (
      typeof item['id'] !== 'string' ||
      typeof item['name'] !== 'string' ||
      typeof item['nodeId'] !== 'string' ||
      typeof item['listenHost'] !== 'string' ||
      typeof item['listenPort'] !== 'number' ||
      typeof item['targetHost'] !== 'string' ||
      typeof item['targetPort'] !== 'number'
    ) {
      continue
    }
    out.push({
      id: item['id'],
      name: item['name'],
      nodeId: item['nodeId'],
      listenHost: item['listenHost'],
      listenPort: item['listenPort'],
      targetHost: item['targetHost'],
      targetPort: item['targetPort'],
      enabled: item['enabled'] === true,
      createdAt: typeof item['createdAt'] === 'number' ? item['createdAt'] : 0,
      updatedAt: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0,
    })
  }
  return out
}

export function parseRuntimeDoc(raw: unknown): Record<string, PortForwardRuntimeEntry> {
  if (!isRecord(raw) || !isRecord(raw['byId'])) return {}
  const out: Record<string, PortForwardRuntimeEntry> = {}
  for (const [id, entry] of Object.entries(raw['byId'])) {
    if (!isRecord(entry)) continue
    const listenerState: PortForwardListenerState =
      entry['listenerState'] === 'listening' || entry['listenerState'] === 'error'
        ? entry['listenerState']
        : 'stopped'
    out[id] = {
      listenerState,
      activeConnections:
        typeof entry['activeConnections'] === 'number' && Number.isFinite(entry['activeConnections'])
          ? entry['activeConnections']
          : 0,
      totalConnections:
        typeof entry['totalConnections'] === 'number' && Number.isFinite(entry['totalConnections'])
          ? entry['totalConnections']
          : 0,
      ...(typeof entry['lastError'] === 'string' && entry['lastError'] !== ''
        ? { lastError: entry['lastError'] }
        : {}),
      ...(typeof entry['startedAt'] === 'number' && Number.isFinite(entry['startedAt'])
        ? { startedAt: entry['startedAt'] }
        : {}),
    }
  }
  return out
}

export function synthesizeMappingRow(
  rule: PortForwardRule,
  runtimeById: Readonly<Record<string, PortForwardRuntimeEntry>>,
  nodes: ReadonlyArray<NodeInfo> | undefined,
): SynthesizedPortForwardRow {
  const rt = runtimeById[rule.id] ?? {
    listenerState: 'stopped' as const,
    activeConnections: 0,
    totalConnections: 0,
  }
  const matchedNode = nodes?.find((n) => n.id === rule.nodeId)
  const nodeKnown = nodes === undefined ? undefined : matchedNode !== undefined
  const nodeOnline =
    nodes === undefined ? undefined : matchedNode !== undefined ? matchedNode.online : false

  let statusKind: PortForwardViewStatusKind
  let displayTone: StatusLightTone
  if (rt.listenerState === 'error') {
    statusKind = 'error'
    displayTone = 'failed'
  } else if (rt.listenerState === 'listening') {
    if (rt.activeConnections > 0) {
      statusKind = 'active_traffic'
      displayTone = 'working'
    } else if (nodeOnline === false) {
      statusKind = 'waiting_node'
      displayTone = 'blocked'
    } else {
      statusKind = 'listening'
      displayTone = 'done'
    }
  } else {
    statusKind = 'stopped'
    displayTone = 'idle'
  }

  return {
    ...rule,
    ...rt,
    statusKind,
    displayTone,
    nodeOnline,
    nodeKnown,
    listenAddr: formatEndpoint(rule.listenHost, rule.listenPort),
    targetAddr: formatEndpoint(rule.targetHost, rule.targetPort),
  }
}

export function filterMappingRows(
  rows: ReadonlyArray<SynthesizedPortForwardRow>,
  filters: {
    query: string
    statusFilter: StatusFilter
    nodeFilter: string
  },
): SynthesizedPortForwardRow[] {
  const q = filters.query.trim().toLowerCase()
  const nodeFilter = filters.nodeFilter.trim()
  return rows.filter((row) => {
    if (nodeFilter !== '' && row.nodeId !== nodeFilter) return false
    if (filters.statusFilter === 'active' && row.listenerState !== 'listening') return false
    if (filters.statusFilter === 'stopped' && row.listenerState !== 'stopped') return false
    if (filters.statusFilter === 'error' && row.listenerState !== 'error') return false
    if (q === '') return true
    return (
      row.name.toLowerCase().includes(q) ||
      row.nodeId.toLowerCase().includes(q) ||
      row.listenAddr.toLowerCase().includes(q) ||
      row.targetAddr.toLowerCase().includes(q) ||
      (row.lastError?.toLowerCase().includes(q) ?? false)
    )
  })
}

export function isLoopbackHostInput(rawHost: string): boolean {
  const trimmed = rawHost.trim().toLowerCase()
  if (trimmed === '') return true
  const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return unwrapped === '127.0.0.1' || unwrapped === '::1' || unwrapped === 'localhost'
}

function normalizeDraftHost(raw: string, fallback: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return fallback
  if (trimmed.length > 255 || /\s|[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed === '*' || trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('@')) {
    return null
  }
  let host = trimmed
  if (host.startsWith('[')) {
    if (!host.endsWith(']') || host.length <= 2) return null
    host = host.slice(1, -1)
    if (host.includes('[') || host.includes(']')) return null
  } else if (host.includes('[') || host.includes(']')) {
    return null
  }
  const colons = (host.match(/:/g) ?? []).length
  if (colons === 1) return null
  if (colons >= 2 && !/^[0-9a-fA-F:.%_-]+$/.test(host)) return null
  if (colons === 0 && !/^[A-Za-z0-9._-]+$/.test(host)) return null
  return host
}

function parseDraftPort(raw: string, checkReserved: boolean): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const num = Number(trimmed)
  if (!Number.isSafeInteger(num) || num < 1 || num > 65535) return null
  if (checkReserved && RESERVED_HUB_PORTS.has(num)) return null
  return num
}

export function validateDraftForm(
  draft: PortForwardDraftForm,
  allowPublicBind: boolean,
): ValidatedDraftResult {
  const nodeId = draft.nodeId.trim()
  if (nodeId === '' || /\s|[\u0000-\u001f\u007f]/.test(nodeId)) {
    return { ok: false, errorCode: 'node_required' }
  }
  const listenHost = normalizeDraftHost(draft.listenHost, '127.0.0.1')
  if (listenHost === null) {
    return { ok: false, errorCode: 'listen_host_invalid' }
  }
  if (!allowPublicBind && !isLoopbackHostInput(listenHost)) {
    return { ok: false, errorCode: 'public_bind_disabled' }
  }
  const listenPort = parseDraftPort(draft.listenPort, true)
  if (listenPort === null) {
    return { ok: false, errorCode: 'listen_port_invalid' }
  }
  const targetHost = normalizeDraftHost(draft.targetHost, '127.0.0.1')
  if (targetHost === null) {
    return { ok: false, errorCode: 'target_host_invalid' }
  }
  const targetPort = parseDraftPort(draft.targetPort, false)
  if (targetPort === null) {
    return { ok: false, errorCode: 'target_port_invalid' }
  }
  const name = draft.name.trim()
  return {
    ok: true,
    payload: {
      ...(name !== '' ? { name } : {}),
      nodeId,
      listenHost,
      listenPort,
      targetHost,
      targetPort,
      enabled: draft.enabled,
    },
  }
}

export function createEmptyDraft(defaultNodeId = 'local'): PortForwardDraftForm {
  return {
    name: '',
    nodeId: defaultNodeId.trim() !== '' ? defaultNodeId.trim() : 'local',
    listenHost: '127.0.0.1',
    listenPort: '',
    targetHost: '127.0.0.1',
    targetPort: '',
    enabled: true,
  }
}

export function ruleToDraft(rule: PortForwardRule): PortForwardDraftForm {
  return {
    name: rule.name,
    nodeId: rule.nodeId,
    listenHost: rule.listenHost,
    listenPort: String(rule.listenPort),
    targetHost: rule.targetHost,
    targetPort: String(rule.targetPort),
    enabled: rule.enabled,
  }
}

export function buildNodeSelectOptions(
  nodes: ReadonlyArray<NodeInfo> | undefined,
  currentNodeId: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): SelectOption<string>[] {
  const onlineText = resolveLocalizedText({ en: 'Online', 'zh-CN': '在线' }, locale)
  const offlineText = resolveLocalizedText({ en: 'Offline', 'zh-CN': '离线' }, locale)
  const unknownText = resolveLocalizedText({ en: 'Unknown', 'zh-CN': '未知' }, locale)
  const trimmedCurrent = currentNodeId.trim()

  if (nodes === undefined) {
    return trimmedCurrent !== '' ? [{ value: trimmedCurrent, label: trimmedCurrent }] : []
  }

  const options: SelectOption<string>[] = nodes.map((node) => {
    const hostSuffix = node.hostname ? ` · ${node.hostname}` : ''
    const stateLabel = node.online ? onlineText : offlineText
    return {
      value: node.id,
      label: `${node.id}${hostSuffix} (${stateLabel})`,
    }
  })

  if (trimmedCurrent !== '' && !nodes.some((n) => n.id === trimmedCurrent)) {
    options.push({
      value: trimmedCurrent,
      label: `${trimmedCurrent} (${unknownText})`,
    })
  }
  return options
}

export function buildScreenTarget(params: {
  node?: string
  edit?: string
  create?: boolean
}): string {
  const search = new URLSearchParams()
  if (params.node !== undefined && params.node.trim() !== '') {
    search.set('node', params.node.trim())
  }
  if (params.edit !== undefined && params.edit.trim() !== '') {
    search.set('edit', params.edit.trim())
  }
  if (params.create === true) {
    search.set('create', '1')
  }
  const qs = search.toString()
  const base = `screen:${PF_PLUGIN_ID}/${PF_SCREEN_ID}`
  return qs === '' ? base : `${base}?${qs}`
}

export function selectableRowProps(
  id: string,
  selectedId: string | undefined,
  onSelect: (id: string) => void,
) {
  return {
    tabIndex: 0,
    className: selectedId === id ? 'pf-row is-selected' : 'pf-row',
    onClick: () => onSelect(id),
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(id)
      }
    },
  }
}
