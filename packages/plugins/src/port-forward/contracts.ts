/**
 * Shared backend contracts, constants, and JSON Schemas for `builtin:port-forward`.
 *
 * Notice: all JSON Schema `description` fields are kept in plain English (no Chinese)
 * to satisfy `plugin-display-metadata.test.ts` execution-copy invariants.
 */

export const PORT_FORWARD_PLUGIN_ID = 'builtin:port-forward' as const
export const PORT_FORWARD_SCREEN_ID = 'main' as const
export const PORT_FORWARD_RULES_DOC = 'rules' as const
export const PORT_FORWARD_RUNTIME_DOC = 'runtime' as const

export const MAX_PORT_FORWARD_RULES = 200

/**
 * Hub and development ports reserved by Helmx conventions (`AGENTS.md` §1) that
 * port-forward rules must never bind as `listenPort`.
 */
export const RESERVED_HUB_PORTS: ReadonlySet<number> = new Set([
  3000,
  3001,
  3002,
  3101,
  3102,
  3201,
  3202,
])

export interface PortForwardPluginConfig {
  allowPublicBind?: boolean
}

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

export interface PortForwardRulesDoc {
  items: PortForwardRule[]
}

export type PortForwardListenerState = 'stopped' | 'listening' | 'error'

export interface PortForwardRuntimeEntry {
  listenerState: PortForwardListenerState
  activeConnections: number
  totalConnections: number
  lastError?: string
  startedAt?: number
}

export interface PortForwardRuntimeDoc {
  byId: Record<string, PortForwardRuntimeEntry>
}

export interface PortForwardViewItem extends PortForwardRule, PortForwardRuntimeEntry {
  nodeOnline?: boolean
}

export const MAPPING_VIEW_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'name',
    'nodeId',
    'listenHost',
    'listenPort',
    'targetHost',
    'targetPort',
    'enabled',
    'createdAt',
    'updatedAt',
    'listenerState',
    'activeConnections',
    'totalConnections',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Unique rule identifier' },
    name: { type: 'string', description: 'Human-readable rule label' },
    nodeId: { type: 'string', description: 'Target compute node ID (e.g. local or remote nodeId)' },
    listenHost: { type: 'string', description: 'Hub listen IP/host address' },
    listenPort: { type: 'integer', description: 'Hub TCP listen port (1-65535)' },
    targetHost: { type: 'string', description: 'Target host resolved from the destination node perspective' },
    targetPort: { type: 'integer', description: 'Target TCP port on the destination node (1-65535)' },
    enabled: { type: 'boolean', description: 'Persisted desired enabled state' },
    createdAt: { type: 'number', description: 'Creation timestamp in epoch milliseconds' },
    updatedAt: { type: 'number', description: 'Last update timestamp in epoch milliseconds' },
    listenerState: {
      type: 'string',
      enum: ['stopped', 'listening', 'error'],
      description: 'Live Hub listener state',
    },
    activeConnections: { type: 'integer', description: 'Number of currently open forwarded TCP connections' },
    totalConnections: { type: 'integer', description: 'Cumulative accepted TCP connections since listener start' },
    lastError: { type: 'string', description: 'Most recent listen or tunnel error message if any' },
    startedAt: { type: 'number', description: 'Listener start timestamp in epoch milliseconds' },
    nodeOnline: { type: 'boolean', description: 'Current online status of the target node when known' },
  },
} as const

export const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['items', 'allowPublicBind'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: MAPPING_VIEW_SCHEMA,
      description: 'Configured port-forward rules merged with live runtime status',
    },
    allowPublicBind: {
      type: 'boolean',
      description: 'Whether non-loopback listen addresses are permitted by plugin config',
    },
  },
} as const

export const MUTATION_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['item'],
  additionalProperties: false,
  properties: {
    item: MAPPING_VIEW_SCHEMA,
  },
} as const

export const DELETE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['deleted'],
  additionalProperties: false,
  properties: {
    deleted: { type: 'string', description: 'Deleted rule ID' },
  },
} as const

export const STOP_ALL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['stopped'],
  additionalProperties: false,
  properties: {
    stopped: { type: 'integer', description: 'Number of rules transitioned to disabled and stopped' },
  },
} as const

export const PAUSE_RUNTIME_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['stoppedListeners', 'closedConnections'],
  additionalProperties: false,
  properties: {
    stoppedListeners: { type: 'integer', description: 'Number of active Hub listeners closed' },
    closedConnections: { type: 'integer', description: 'Number of active forwarded connections closed' },
  },
} as const
