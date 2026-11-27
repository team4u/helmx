/** `core:plugins`: read-only plugin inspection plus host-governance mutations on the live `PluginHost`. */
import { PLUGIN_CORE_OPERATIONS } from '@helmx/protocol'
import { parseDocNameParam } from '../../http/validate.js'
import type { PluginHost } from '../../plugins/plugin-host.js'
import { readSanitizedPluginConfig, resolvePluginDoctorTarget } from '../guards/index.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerPluginCoreActions(
  runtime: CoreActionsRuntimeHost,
  registrar: CoreActionRegistrar,
  pluginHost: PluginHost,
): void {
  registerCoreActionsFromOperations(registrar, PLUGIN_CORE_OPERATIONS, {
    'plugins.list': () => pluginHost.list(),

    'plugins.manifest': (input) =>
      input.id !== undefined ? pluginHost.getManifest(input.id as string) : pluginHost.listManifests(),

    'plugins.doc': (input) => {
      const name = parseDocNameParam(input.name as string)
      if (input.conversationId !== undefined) {
        return pluginHost.getPublicSessionDoc(
          input.pluginId as string,
          name,
          input.conversationId as number,
        )
      }
      return pluginHost.getPublicDoc(input.pluginId as string, name)
    },

    'plugins.config_get': (input) =>
      readSanitizedPluginConfig(pluginHost, input.id as string, (text) => runtime.stash.redact(text)),

    'plugins.doctor': async (input) =>
      pluginHost.doctorExternalPlugin(
        resolvePluginDoctorTarget(
          input as { target?: string; path?: string; id?: string },
          { allowTarget: true },
        ),
      ),

    'plugins.config_set': async (input) => {
      await pluginHost.setConfig(input.id as string, { ...(input.values as Record<string, unknown>) })
      return { ok: true }
    },

    'plugins.enable': async (input) => {
      await pluginHost.enable(input.id as string)
      return pluginHost.list()
    },

    'plugins.disable': async (input) => {
      await pluginHost.disable(input.id as string, input.force === true ? { force: true } : undefined)
      return pluginHost.list()
    },

    'plugins.reload': async (input) => pluginHost.reloadExternalPlugin(input.id as string),

    'plugins.rescan': async () => pluginHost.rescanExternalPlugins(),
  })
}
