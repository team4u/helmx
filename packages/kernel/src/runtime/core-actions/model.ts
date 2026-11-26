/** `core:models`: model catalog, sanitized provider summaries, refresh, defaults, and disabled-model filters. */
import { REQUEST_SCHEMAS } from '@helmx/protocol'
import { redactJsonValue } from '../../redact.js'
import { normalizeModelRefreshInput } from '../model-registry.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  EMPTY_INPUT_SCHEMA,
  OBJECT_OUTPUT_SCHEMA,
  toJsonSchema,
  type CoreActionRegistrar,
} from './shared.js'

export function registerModelCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:models'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List the available model catalog, thinking levels, and current defaults',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['models', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async () => runtime.models.listModels(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'providers',
    description: 'List sanitized model provider summaries (never exposes plaintext API keys or tokens)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['models', 'providers'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () =>
      redactJsonValue(runtime.models.listModelProviders(), (text) => runtime.stash.redact(text)),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'refresh',
    description: 'Refresh dynamic model catalogs for all or specified providers',
    exposeToPrompt: false,
    cli: { command: ['models', 'refresh'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsRefresh),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { provider?: string; providers?: string[]; force?: boolean }) =>
      runtime.models.refreshModels(normalizeModelRefreshInput(input)),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'default',
    description: 'Set global default model, thinking level, compaction defaults, or per-model thinking defaults',
    exposeToPrompt: false,
    cli: { command: ['models', 'default'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsDefaultPut),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: {
      model?: string
      thinkingLevel?: string
      compactionModel?: string
      compactionThinkingLevel?: string
      modelThinking?: string
      modelThinkingLevel?: string
      modelThinkingLevels?: Record<string, string>
    }) => {
      const defaults = await runtime.models.updateDefaults(input)
      return { ok: true, ...defaults }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'filter',
    description: 'Set disabled models for a provider or clear all disabled model filters',
    exposeToPrompt: false,
    cli: { command: ['models', 'filter'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.modelsFilterPut),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { provider?: string; disabledModels: string[] }) => {
      const catalog = await runtime.models.setDisabledModels(input.provider, input.disabledModels)
      return { ok: true, catalog }
    },
  })
}
