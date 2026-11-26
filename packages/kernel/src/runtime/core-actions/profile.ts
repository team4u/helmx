/** `core:profiles`: Profile CRUD with model-enabled and in-use hooks backed by the runtime. */
import { REQUEST_SCHEMAS } from '@helmx/protocol'
import { parseProfileBody } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  EMPTY_INPUT_SCHEMA,
  ID_STRING,
  OBJECT_OUTPUT_SCHEMA,
  OK_OUTPUT_SCHEMA,
  extendRequestSchema,
  toJsonSchema,
  type CoreActionRegistrar,
} from './shared.js'

export function registerProfileCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:profiles'

  const profileHooks = {
    assertModelEnabled: (providerId: string, modelId: string) =>
      runtime.models.assertModelEnabled(providerId, modelId),
    alignProfileConversations: (profileId: string) =>
      runtime.conversations.alignProfileConversations(profileId),
    isProfileInUse: (profileId: string) =>
      runtime.conversations.listConversations().some((c) => c.profileId === profileId),
  }

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List all configured Profiles (summary metadata without SYSTEM.md body)',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['profiles', 'list'] },
    inputSchema: EMPTY_INPUT_SCHEMA,
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: async () => runtime.profiles.list(),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'get',
    description: 'Get a Profile by ID including its full SYSTEM.md text',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['profiles', 'get'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => runtime.profiles.getEnriched(input.id),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'create',
    description: 'Create a new Profile (rejects managedByPlugin spoofing and disabled models)',
    exposeToPrompt: false,
    cli: { command: ['profiles', 'create'] },
    inputSchema: toJsonSchema(REQUEST_SCHEMAS.profileCreate),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown>) =>
      runtime.profiles.createProfile(parseProfileBody(input, { requireId: true }), profileHooks),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'update',
    description:
      'Partially update an existing Profile (merges provided fields onto current config; managedByPlugin is immutable)',
    exposeToPrompt: false,
    cli: { command: ['profiles', 'update'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.profileUpdate, { id: ID_STRING }, ['id']),
    outputSchema: OBJECT_OUTPUT_SCHEMA,
    handler: async (input: Record<string, unknown> & { id: string }) =>
      runtime.profiles.patchProfile(
        input.id,
        input,
        parseProfileBody(input, { requireId: false }),
        profileHooks,
      ),
  })

  pluginHost.registerCoreAction(owner, {
    id: 'delete',
    description: 'Delete an unused, non-managed Profile by ID',
    exposeToPrompt: false,
    cli: { command: ['profiles', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await runtime.profiles.deleteProfile(input.id, profileHooks)
      return { ok: true }
    },
  })
}
