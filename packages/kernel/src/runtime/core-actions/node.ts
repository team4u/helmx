/** `core:nodes`: node listing, Hub endpoints, remote upgrade, and TCP port-forwarding session management. */
import { HelmxError, NODE_CORE_OPERATIONS } from '@helmx/protocol'
import { ValidationError, requireHttpUrl } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import { requireStrictSemverField, type CoreActionRegistrar } from './shared.js'

export function registerNodeCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  registerCoreActionsFromOperations(pluginHost, NODE_CORE_OPERATIONS, {
    'nodes.list': () => runtime.nodes.listNodes(),

    'nodes.endpoints': () => runtime.nodes.getHubAccess(),

    'nodes.upgrade_check': async (input, context) => {
      const nodeId =
        (typeof input.id === 'string' ? input.id : undefined) ??
        (context.conversationId !== undefined
          ? runtime.conversations.getConversation(context.conversationId).nodeId ?? 'local'
          : undefined)
      if (nodeId === undefined) {
        throw new ValidationError('id is required when no conversation context is present')
      }
      const registryUrl =
        input.registryUrl !== undefined ? requireHttpUrl(input.registryUrl, 'registryUrl') : undefined
      return runtime.nodes.checkNodeUpgrade(nodeId, registryUrl !== undefined ? { registryUrl } : {})
    },

    'nodes.forwards': () => runtime.nodeForward.list(),

    'nodes.forward_inspect': (input) => {
      const id = input.id as string
      const session = runtime.nodeForward.get(id)
      if (session === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${id}`, 404)
      }
      return session
    },

    'nodes.remove': async (input) => {
      await runtime.nodes.removeNode(input.id as string)
      return { ok: true }
    },

    'nodes.upgrade': async (input) => {
      const opts: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
      if (input.targetVersion !== undefined) {
        opts.targetVersion = requireStrictSemverField(input.targetVersion as string)
      }
      if (input.registryUrl !== undefined) {
        opts.registryUrl = requireHttpUrl(input.registryUrl, 'registryUrl')
      }
      if (input.force !== undefined) opts.force = input.force as boolean
      return runtime.nodes.upgradeNode(input.id as string, opts)
    },

    'nodes.forward_stop': async (input) => {
      const id = input.id as string
      if (runtime.nodeForward.get(id) === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${id}`, 404)
      }
      await runtime.nodeForward.stop(id)
      return { ok: true }
    },
  })
}
