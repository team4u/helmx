/**
 * Declarative Core Operation specifications for the `nodes` domain.
 * Drives HTTP (`/api/nodes*`), `core:nodes.*` actions, and static `helmx nodes *` CLI commands.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_FORWARD_ID_SCHEMA,
  CORE_HOST_GOVERNANCE_SCOPE,
  CORE_NODE_ID_SCHEMA,
  CORE_OBJECT_OUTPUT_SCHEMA,
  CORE_OK_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  extendCoreObjectSchema,
  type CoreOperationSpec,
} from './types.js'

export const NODE_CORE_OPERATIONS = [
  {
    key: 'nodes.list',
    domain: 'nodes',
    id: 'list',
    description: 'List registered compute nodes, online status, platform, and health metrics',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/nodes',
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'list'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.endpoints',
    domain: 'nodes',
    id: 'endpoints',
    description: 'List Hub listener summary and reachable node enrollment endpoints',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/nodes/endpoints',
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'endpoints'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.issue',
    domain: 'nodes',
    id: 'issue',
    description: 'Issue a one-time node access token and enrollment command guide',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.nodeIssue),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/nodes/issue',
      status: 201,
      bodyMode: 'required',
      responseHeaders: { 'cache-control': 'no-store' },
      redactResponse: false,
    },
    cli: {
      command: ['nodes', 'issue'],
      positional: [{ field: 'nodeId', required: true, label: 'nodeId' }],
      flagAliases: { hubUrl: 'hub' },
    },
    // SECURITY: plaintext join tokens must NEVER be exposed as `core:*` actions reachable by models/plugins.
    action: false,
  },
  {
    key: 'nodes.remove',
    domain: 'nodes',
    id: 'remove',
    description: 'Remove a registered remote BYOM node and disconnect it immediately',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_NODE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'DELETE',
      path: '/api/nodes/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'nodeId' },
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'remove'],
      positional: [{ field: 'id', required: true, label: 'nodeId' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.upgrade_check',
    domain: 'nodes',
    id: 'upgrade_check',
    description: 'Check available @helmx/node updates for a remote node (defaults to current conversation node when omitted)',
    inputSchema: {
      type: 'object',
      properties: {
        id: CORE_NODE_ID_SCHEMA,
        registryUrl: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/nodes/:id/upgrade/check',
      pathParams: { id: 'id' },
      pathValidators: { id: 'nodeId' },
      queryParams: ['registryUrl'],
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'upgrade'],
      flagAliases: { registryUrl: 'registry' },
      sharedCommand: true,
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.upgrade',
    domain: 'nodes',
    id: 'upgrade',
    description: 'Execute a self-upgrade on a registered online remote node',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.nodeUpgrade, { id: CORE_NODE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/nodes/:id/upgrade',
      pathParams: { id: 'id' },
      pathValidators: { id: 'nodeId' },
      bodyMode: 'optional',
    },
    cli: {
      command: ['nodes', 'upgrade'],
      flagAliases: { targetVersion: 'version', registryUrl: 'registry' },
      timeoutMs: 0,
      sharedCommand: true,
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.forwards',
    domain: 'nodes',
    id: 'forwards',
    description: 'List active TCP port-forwarding sessions',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/nodes/forward',
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'forwards'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.forward_inspect',
    domain: 'nodes',
    id: 'forward_inspect',
    description: 'Inspect a single active TCP port-forwarding session by forwardId',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_FORWARD_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/nodes/forward/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'forwardId' },
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'forward-inspect'],
      positional: [{ field: 'id', required: true, label: 'forwardId' }],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'nodes.forward_stop',
    domain: 'nodes',
    id: 'forward_stop',
    description: 'Stop an active TCP port-forwarding session (closes Hub listener and node tunnels)',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_FORWARD_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'DELETE',
      path: '/api/nodes/forward/:id',
      pathParams: { id: 'id' },
      pathValidators: { id: 'forwardId' },
      bodyMode: 'none',
    },
    cli: {
      command: ['nodes', 'forward-stop'],
      positional: [{ field: 'id', required: true, label: 'forwardId' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
] as const satisfies readonly CoreOperationSpec[]

export type NodeCoreOperation = (typeof NODE_CORE_OPERATIONS)[number]
export type NodeCoreOperationKey = NodeCoreOperation['key']
