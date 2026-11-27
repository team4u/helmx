/**
 * Declarative Core Operation specifications for the `plugins` domain.
 * Drives HTTP (`/api/plugins*`), `core:plugins.*` actions, and static `helmx plugins *` CLI commands.
 */
import { REQUEST_SCHEMAS, REQUEST_SCHEMA_PATTERNS } from '../request-schemas.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_EMPTY_INPUT_SCHEMA,
  CORE_HOST_GOVERNANCE_SCOPE,
  CORE_ID_SCHEMA,
  CORE_OBJECT_OUTPUT_SCHEMA,
  CORE_OK_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  extendCoreObjectSchema,
  type CoreOperationSpec,
} from './types.js'

const DOC_NAME_SCHEMA = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
} as const

const SAFE_POSITIVE_INT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const

const NON_WHITESPACE_STRING_SCHEMA = {
  type: 'string',
  pattern: REQUEST_SCHEMA_PATTERNS.nonWhitespace.source,
} as const

export const PLUGIN_CORE_OPERATIONS = [
  {
    key: 'plugins.list',
    domain: 'plugins',
    id: 'list',
    description: 'List installed built-in and external plugins with status and capabilities',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/plugins',
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'list'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.manifest',
    domain: 'plugins',
    id: 'manifest',
    description: 'Inspect read-only extension contract manifest for one plugin (by id) or all plugins',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      anyOf: [CORE_OBJECT_OUTPUT_SCHEMA, CORE_ARRAY_OUTPUT_SCHEMA],
    },
    http: {
      method: 'GET',
      path: '/api/plugins/:id/manifest',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['plugins', 'manifest'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
      inputSchema: {
        type: 'object',
        properties: { id: CORE_ID_SCHEMA },
        additionalProperties: false,
      },
    },
  },
  {
    key: 'plugins.doc',
    domain: 'plugins',
    id: 'doc',
    description: 'Read a public global or session-scoped plugin document',
    inputSchema: {
      type: 'object',
      properties: {
        pluginId: CORE_ID_SCHEMA,
        name: DOC_NAME_SCHEMA,
        conversationId: SAFE_POSITIVE_INT_SCHEMA,
      },
      required: ['pluginId', 'name'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/plugins/:id/docs/:name',
      pathParams: { id: 'pluginId', name: 'name' },
      pathValidators: { id: 'id' },
      queryParams: ['conversationId'],
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'doc'],
      positional: [
        { field: 'pluginId', required: true, label: 'pluginId' },
        { field: 'name', required: true, label: 'name' },
      ],
      flagAliases: { conversationId: 'conversation' },
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.config_get',
    domain: 'plugins',
    id: 'config_get',
    description: 'Read plugin configuration schema, sources, and masked values (secret fields are never exposed)',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        values: { type: 'object' },
        schema: { type: 'object' },
        sources: { type: 'object' },
      },
      required: ['values', 'schema'],
    },
    http: {
      method: 'GET',
      path: '/api/plugins/:id/config',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
      methodNotAllowed: true,
    },
    cli: {
      command: ['plugins', 'config'],
      positional: [{ field: 'id', required: true, label: 'id' }],
      sharedCommand: true,
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.doctor',
    domain: 'plugins',
    id: 'doctor',
    description: 'Run static dry-run diagnostics on an external plugin directory or registered external plugin ID',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.pluginDoctor),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/doctor',
      bodyMode: 'required',
    },
    cli: {
      command: ['plugins', 'doctor'],
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
      inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.pluginDoctor, {
        target: NON_WHITESPACE_STRING_SCHEMA,
      }),
    },
  },
  {
    key: 'plugins.config_set',
    domain: 'plugins',
    id: 'config_set',
    description: 'Update plugin configuration values (pass null for a key to reset to default)',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.pluginConfigPut, { id: CORE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'PUT',
      path: '/api/plugins/:id/config',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.pluginConfigPut),
      methodNotAllowed: true,
    },
    cli: {
      command: ['plugins', 'config'],
      positional: [{ field: 'id', required: true, label: 'id' }],
      flagAliases: { values: 'input' },
      sharedCommand: true,
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.enable',
    domain: 'plugins',
    id: 'enable',
    description: 'Enable a registered plugin',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/:id/enable',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'enable'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.disable',
    domain: 'plugins',
    id: 'disable',
    description: 'Disable a registered plugin (pass force: true to bypass persistent resource-in-use warnings; live tasks still block)',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.pluginDisable, { id: CORE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/:id/disable',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      queryParams: ['force'],
      bodyMode: 'optional',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.pluginDisable),
    },
    cli: {
      command: ['plugins', 'disable'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.reload',
    domain: 'plugins',
    id: 'reload',
    description: 'Hot-reload an external plugin with doctor preflight',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/:id/reload',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'reload'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.rescan',
    domain: 'plugins',
    id: 'rescan',
    description: 'Incrementally rescan the external plugins directory and register newly discovered plugins as disabled',
    inputSchema: CORE_EMPTY_INPUT_SCHEMA,
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/rescan',
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'rescan'],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'plugins.install',
    domain: 'plugins',
    id: 'install',
    description: 'Install and register an external plugin package from npm, git, or local path',
    inputSchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.pluginInstall),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/install',
      bodyMode: 'required',
    },
    cli: {
      command: ['plugins', 'install'],
      positional: [{ field: 'source', required: true, label: 'source' }],
    },
    action: false,
  },
  {
    key: 'plugins.update',
    domain: 'plugins',
    id: 'update',
    description: 'Update an installed external plugin package and reload when files changed',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.pluginUpdate, { id: CORE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/:id/update',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'optional',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.pluginUpdate),
    },
    cli: {
      command: ['plugins', 'update'],
      positional: [{ field: 'id', required: false, label: 'id' }],
      sharedCommand: true,
    },
    action: false,
  },
  {
    key: 'plugins.remove',
    domain: 'plugins',
    id: 'remove',
    description: 'Remove a managed external plugin package and delete its Hub install directory',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OBJECT_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/plugins/:id/remove',
      pathParams: { id: 'id' },
      pathValidators: { id: 'id' },
      bodyMode: 'none',
    },
    cli: {
      command: ['plugins', 'remove'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: false,
  },
] as const satisfies readonly CoreOperationSpec[]

export type PluginCoreOperation = (typeof PLUGIN_CORE_OPERATIONS)[number]
export type PluginCoreOperationKey = PluginCoreOperation['key']
