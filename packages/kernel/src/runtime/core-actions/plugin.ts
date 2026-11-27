/** `core:plugins`: read-only plugin inspection plus host-governance mutations on the live `PluginHost`. */
import { REQUEST_SCHEMAS } from '@helmx/protocol'
import { parseDocNameParam } from '../../http/validate.js'
import type { PluginHost } from '../../plugins/plugin-host.js'
import { readSanitizedPluginConfig, resolvePluginDoctorTarget } from '../guards/index.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  DOC_NAME_STRING,
  EMPTY_INPUT_SCHEMA,
  HOST_GOVERNANCE_SCOPE,
  ID_STRING,
  NON_WHITESPACE_STRING,
  OBJECT_OUTPUT_SCHEMA,
  OK_OUTPUT_SCHEMA,
  SAFE_POSITIVE_INT,
  extendRequestSchema,
  type CoreActionRegistrar,
} from './shared.js'

export function registerPluginCoreActions(
  runtime: CoreActionsRuntimeHost,
  registrar: CoreActionRegistrar,
  pluginHost: PluginHost,
): void {
  const owner = 'core:plugins'

  registrar.registerCoreAction(owner, {
    id: 'list',
    description: 'List installed built-in and external plugins with status and capabilities',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () => pluginHost.list(),
  })

  registrar.registerCoreAction(owner, {
    id: 'manifest',
    description: 'Inspect read-only extension contract manifest for one plugin (by id) or all plugins',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'manifest'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      additionalProperties: false,
    },
    outputSchema: {
      anyOf: [OBJECT_OUTPUT_SCHEMA, ARRAY_OF_OBJECTS_OUTPUT_SCHEMA],
    },
    handler: (input: { id?: string }) =>
      input.id !== undefined ? pluginHost.getManifest(input.id) : pluginHost.listManifests(),
  })

  registrar.registerCoreAction(owner, {
    id: 'doc',
    description: 'Read a public global or session-scoped plugin document',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'doc'] },
    inputSchema: {
      type: 'object',
      properties: {
        pluginId: ID_STRING,
        name: DOC_NAME_STRING,
        conversationId: SAFE_POSITIVE_INT,
      },
      required: ['pluginId', 'name'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: (input: { pluginId: string; name: string; conversationId?: number }) => {
      const name = parseDocNameParam(input.name)
      if (input.conversationId !== undefined) {
        return pluginHost.getPublicSessionDoc(input.pluginId, name, input.conversationId)
      }
      return pluginHost.getPublicDoc(input.pluginId, name)
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'config_get',
    description: 'Read plugin configuration schema, sources, and masked values (secret fields are never exposed)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'config'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
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
    handler: (input: { id: string }) =>
      readSanitizedPluginConfig(pluginHost, input.id, (text) => runtime.stash.redact(text)),
  })

  registrar.registerCoreAction(owner, {
    id: 'doctor',
    description: 'Run static dry-run diagnostics on an external plugin directory or registered external plugin ID',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'doctor'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginDoctor, {
      target: NON_WHITESPACE_STRING,
    }),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { target?: string; path?: string; id?: string }) =>
      pluginHost.doctorExternalPlugin(resolvePluginDoctorTarget(input, { allowTarget: true })),
  })

  registrar.registerCoreAction(owner, {
    id: 'config_set',
    description: 'Update plugin configuration values (pass null for a key to reset to default)',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'config'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginConfigPut, { id: ID_STRING }, ['id']),
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string; values: Record<string, unknown> }) => {
      await pluginHost.setConfig(input.id, { ...input.values })
      return { ok: true }
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'enable',
    description: 'Enable a registered plugin',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'enable'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await pluginHost.enable(input.id)
      return pluginHost.list()
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'disable',
    description: 'Disable a registered plugin (pass force: true to bypass persistent resource-in-use warnings; live tasks still block)',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'disable'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.pluginDisable, { id: ID_STRING }, ['id']),
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async (input: { id: string; force?: boolean }) => {
      await pluginHost.disable(input.id, input.force === true ? { force: true } : undefined)
      return pluginHost.list()
    },
  })

  registrar.registerCoreAction(owner, {
    id: 'reload',
    description: 'Hot-reload an external plugin with doctor preflight',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'reload'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => pluginHost.reloadExternalPlugin(input.id),
  })

  registrar.registerCoreAction(owner, {
    id: 'rescan',
    description: 'Incrementally rescan the external plugins directory and register newly discovered plugins as disabled',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'rescan'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async () => pluginHost.rescanExternalPlugins(),
  })
}
