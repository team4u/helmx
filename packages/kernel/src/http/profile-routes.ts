/**
 * Profile domain routes: /api/profiles CRUD (thin HTTP adapter delegating to single-source
 * domain operations in `services/profile-service.ts`).
 */
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
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import { parseProfileBody, requireIdParam } from './validate.js'
import { methodNotAllowed, type RouteContext } from './route-context.js'

export interface ProfileRoutesTarget {
  readonly profiles: Pick<ProfileService, 'list' | 'get' | 'getSystem' | 'save' | 'delete'>
  readonly conversations: Pick<ConversationService, 'listConversations'> &
    Partial<Pick<ConversationService, 'alignProfileConversations'>>
  readonly models?: Partial<Pick<ModelRegistry, 'assertModelEnabled'>>
}

export async function handleProfilesDomain(
  ctx: RouteContext,
  kernel: ProfileRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const mutationHooks: ProfileMutationHooks = {
    assertModelEnabled: kernel.models?.assertModelEnabled
      ? (providerId, modelId) => kernel.models!.assertModelEnabled!(providerId, modelId)
      : undefined,
    alignProfileConversations: kernel.conversations.alignProfileConversations
      ? (profileId) => kernel.conversations.alignProfileConversations!(profileId)
      : undefined,
    isProfileInUse: (pid) =>
      kernel.conversations.listConversations().some((c) => c.profileId === pid),
  }
  if (second === undefined) {
    if (method === 'GET') return jsonOk(redactor, await kernel.profiles.list())
    if (method === 'POST') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: true })
      const created = await createManagedGuardedProfile(kernel.profiles, profile, mutationHooks)
      return jsonOk(redactor, created, { status: 201 })
    }
    return methodNotAllowed(redactor, method)
  }
  const profileId = requireIdParam(second, 'profileId')
  if (third === undefined) {
    if (method === 'GET') {
      return jsonOk(redactor, await getProfileWithSystem(kernel.profiles, profileId))
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      const profile = parseProfileBody(body, { requireId: false })
      const replaced = await replaceManagedGuardedProfile(kernel.profiles, profileId, profile, mutationHooks)
      return jsonOk(redactor, replaced)
    }
    if (method === 'DELETE') {
      await deleteManagedGuardedProfile(kernel.profiles, profileId, mutationHooks)
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
