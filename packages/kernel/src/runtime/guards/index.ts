/**
 * Kernel domain guards barrel: shared single-source security & validation primitives
 * consumed by HTTP routes, kernel services, and `core:*` actions.
 */
export {
  assertNotSelfConversationMutation,
  assertValidConversationOwnership,
  normalizeConversationListFilter,
  normalizeConversationSearchInput,
  resolveConversationMutationAccess,
  resolveCreateConversationOwnership,
  resolveForkConversationOwnership,
  type ConversationGuardDeps,
  type ConversationListQueryInput,
  type ConversationMutationAccess,
} from './conversation-guards.js'
export {
  looksLikePluginPathTarget,
  readSanitizedPluginConfig,
  redactPluginConfigValues,
  resolvePluginDoctorTarget,
  type PluginConfigReadHost,
  type PluginDoctorTargetInput,
  type SanitizedPluginConfigSnapshot,
} from './plugin-guards.js'
