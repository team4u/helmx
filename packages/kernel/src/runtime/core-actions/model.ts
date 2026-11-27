/** `core:models`: model catalog, sanitized provider summaries, refresh, defaults, and disabled-model filters. */
import { MODEL_CORE_OPERATIONS } from '@helmx/protocol'
import { redactJsonValue } from '../../redact.js'
import { normalizeModelRefreshInput, type ModelDefaultsPatch } from '../model-registry.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerModelCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  registerCoreActionsFromOperations(pluginHost, MODEL_CORE_OPERATIONS, {
    'models.list': () => runtime.models.listModels(),

    'models.providers': () =>
      redactJsonValue(runtime.models.listModelProviders(), (text) => runtime.stash.redact(text)),

    'models.refresh': (input) =>
      runtime.models.refreshModels(
        normalizeModelRefreshInput(input as { provider?: string; providers?: string[]; force?: boolean }),
      ),

    'models.default_get': () => runtime.models.getDefaults(),

    'models.default': async (input) => {
      const defaults = await runtime.models.updateDefaults(input as ModelDefaultsPatch)
      return { ok: true, ...defaults }
    },

    'models.filter': async (input) => {
      const catalog = await runtime.models.setDisabledModels(
        input.provider as string | undefined,
        input.disabledModels as string[],
      )
      return { ok: true, catalog }
    },
  })
}
