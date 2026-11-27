/**
 * Profile domain routes: /api/profiles CRUD driven by `PROFILE_CORE_OPERATIONS` via `createCoreOperationRouter`
 * (thin HTTP adapter delegating to single-source domain operations in `services/profile-service.ts`).
 */
import { PROFILE_CORE_OPERATIONS, type Profile } from '@helmx/protocol'
import type { ProfileService } from '../services/index.js'
import {
  createManagedGuardedProfile,
  deleteManagedGuardedProfile,
  getProfileWithSystem,
  replaceManagedGuardedProfile,
  type ProfileMutationHooks,
} from '../services/profile-service.js'
import type { ConversationService } from '../runtime/conversation-service.js'
import type { ModelRegistry } from '../runtime/model-registry.js'
import { createCoreOperationRouter } from './core-operation-router.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import type { RouteContext } from './route-context.js'
import { parseProfileBody } from './validate.js'

export interface ProfileRoutesTarget {
  readonly profiles: Pick<ProfileService, 'list' | 'get' | 'getSystem' | 'save' | 'delete'>
  readonly conversations: Pick<ConversationService, 'listConversations'> &
    Partial<Pick<ConversationService, 'alignProfileConversations'>>
  readonly models?: Partial<Pick<ModelRegistry, 'assertModelEnabled'>>
}

function buildProfileMutationHooks(kernel: ProfileRoutesTarget): ProfileMutationHooks {
  return {
    assertModelEnabled: kernel.models?.assertModelEnabled
      ? (providerId, modelId) => kernel.models!.assertModelEnabled!(providerId, modelId)
      : undefined,
    alignProfileConversations: kernel.conversations.alignProfileConversations
      ? (profileId) => kernel.conversations.alignProfileConversations!(profileId)
      : undefined,
    isProfileInUse: (pid) =>
      kernel.conversations.listConversations().some((c) => c.profileId === pid),
  }
}

function dispatchProfileRoutes(
  kernel: ProfileRoutesTarget,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(PROFILE_CORE_OPERATIONS, {
    'profiles.list': () => kernel.profiles.list(),

    'profiles.get': (input) => getProfileWithSystem(kernel.profiles, input.id as string),

    'profiles.create': {
      validate: (input) => ({ profile: parseProfileBody(input, { requireId: true }) }),
      handle: (input) =>
        createManagedGuardedProfile(
          kernel.profiles,
          input.profile as Profile,
          buildProfileMutationHooks(kernel),
        ),
    },

    'profiles.update': {
      validate: (_input, ctx) => ({
        profileId: ctx.path.profileId as string,
        profile: parseProfileBody(ctx.body, { requireId: false }),
      }),
      handle: (input) =>
        replaceManagedGuardedProfile(
          kernel.profiles,
          input.profileId as string,
          input.profile as Profile,
          buildProfileMutationHooks(kernel),
        ),
    },

    'profiles.delete': async (input) => {
      await deleteManagedGuardedProfile(
        kernel.profiles,
        input.id as string,
        buildProfileMutationHooks(kernel),
      )
      return { ok: true }
    },
  })
}

export async function handleProfilesDomain(
  ctx: RouteContext,
  kernel: ProfileRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchProfileRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
