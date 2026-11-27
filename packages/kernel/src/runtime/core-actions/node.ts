/** `core:nodes`: node listing, remote upgrade, and TCP port-forwarding session management. */
import { HelmxError, REQUEST_SCHEMAS } from '@helmx/protocol'
import { ValidationError, requireHttpUrl } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  EMPTY_INPUT_SCHEMA,
  FORWARD_ID_STRING,
  HOST_GOVERNANCE_SCOPE,
  NODE_ID_STRING,
  OBJECT_OUTPUT_SCHEMA,
  OK_OUTPUT_SCHEMA,
  extendRequestSchema,
  requireStrictSemverField,
  type CoreActionRegistrar,
} from './shared.js'

export function registerNodeCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:nodes'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List registered compute nodes, online status, platform, and health metrics',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.nodes.listNodes(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'upgrade_check',
    description: 'Check available @helmx/node updates for a remote node (defaults to current conversation node when omitted)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'upgrade'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: NODE_ID_STRING,
        registryUrl: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id?: string; registryUrl?: string }, context) => {
      const nodeId =
        input.id ??
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
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forwards',
    description: 'List active TCP port-forwarding sessions',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'forwards'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: () => runtime.nodeForward.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forward_inspect',
    description: 'Inspect a single active TCP port-forwarding session by forwardId',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'forward-inspect'] },
    inputSchema: {
      type: 'object',
      properties: { id: FORWARD_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: (input: { id: string }) => {
      const session = runtime.nodeForward.get(input.id)
      if (session === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${input.id}`, 404)
      }
      return session
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'remove',
    description: 'Remove a registered remote BYOM node and disconnect it immediately',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'remove'] },
    inputSchema: {
      type: 'object',
      properties: { id: NODE_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await runtime.nodes.removeNode(input.id)
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'upgrade',
    description: 'Execute a self-upgrade on a registered online remote node',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'upgrade'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.nodeUpgrade, { id: NODE_ID_STRING }, ['id']),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string; targetVersion?: string; registryUrl?: string; force?: boolean }) => {
      const opts: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
      if (input.targetVersion !== undefined) {
        opts.targetVersion = requireStrictSemverField(input.targetVersion)
      }
      if (input.registryUrl !== undefined) {
        opts.registryUrl = requireHttpUrl(input.registryUrl, 'registryUrl')
      }
      if (input.force !== undefined) opts.force = input.force
      return runtime.nodes.upgradeNode(input.id, opts)
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'forward_stop',
    description: 'Stop an active TCP port-forwarding session by forwardId',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['nodes', 'forward-stop'] },
    inputSchema: {
      type: 'object',
      properties: { id: FORWARD_ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      if (runtime.nodeForward.get(input.id) === undefined) {
        throw new HelmxError('not_found', `forwarding session not found or already stopped: ${input.id}`, 404)
      }
      await runtime.nodeForward.stop(input.id)
      return { ok: true }
    },
  })
}
