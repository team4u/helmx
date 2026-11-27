/** `core:profiles`: Profile CRUD with model-enabled and in-use hooks backed by the runtime. */
import { PROFILE_CORE_OPERATIONS } from '@helmx/protocol'
import { parseProfileBody } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerProfileCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const profileHooks = {
    assertModelEnabled: (providerId: string, modelId: string) =>
      runtime.models.assertModelEnabled(providerId, modelId),
    alignProfileConversations: (profileId: string) =>
      runtime.conversations.alignProfileConversations(profileId),
    isProfileInUse: (profileId: string) =>
      runtime.conversations.listConversations().some((c) => c.profileId === profileId),
  }

  registerCoreActionsFromOperations(pluginHost, PROFILE_CORE_OPERATIONS, {
    'profiles.list': () => runtime.profiles.list(),

    'profiles.get': (input) => runtime.profiles.getEnriched(input.id as string),

    'profiles.create': (input) =>
      runtime.profiles.createProfile(parseProfileBody(input, { requireId: true }), profileHooks),

    // Diverges from HTTP PUT full replacement: `core:profiles.update` performs partial field merge via `patchProfile`.
    'profiles.update': (input) =>
      runtime.profiles.patchProfile(
        input.id as string,
        input,
        parseProfileBody(input, { requireId: false }),
        profileHooks,
      ),

    'profiles.delete': async (input) => {
      await runtime.profiles.deleteProfile(input.id as string, profileHooks)
      return { ok: true }
    },
  })
}
