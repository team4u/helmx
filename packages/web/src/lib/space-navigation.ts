/**
 * Pure functions for sidebar space-memory verdicts, default jump-back targets,
 * delete fallbacks and Screen route-param patching (zero React dependencies).
 */
import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import { collectEnabledPluginIds, isProfileVisible } from '../shell/sidebar-model.js'
import { isPluginSummaryActive, type PluginActivityLike } from './live-state.js'
import {
  isPrototypeParamKey,
  resolveTargetString,
  SCREEN_PARAM_KEY_PATTERN,
  spaceForTarget,
  type GroupedUiSpecs,
  type ResolvedTarget,
  type SidebarSpace,
} from './types.js'

/** Live snapshot input for openSpace's space jump-back target verdict. */
export interface SpaceTargetInput {
  conversations: ConversationSummary[]
  profiles: Profile[]
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
  /** Whether static assets finished loading this round (before that, profile existence cannot be falsified; treat as available). */
  assetsLoaded: boolean
  grouped: GroupedUiSpecs
}

/**
 * Whether at least one visible conversation root tree exists — the honest
 * "not a fresh system" verdict for the overview home landing. Exposure boundary
 * mirrors aggregateAttentionTrees: archived roots and roots whose Profile is
 * hidden by a disabled plugin are invisible everywhere (neither sidebar nor
 * overview); a root whose Profile record is missing (orphan) still counts as
 * visible, same as the sidebar's orphan-standing fallback.
 */
export function hasVisibleConversationRoots(input: {
  conversations: ReadonlyArray<ConversationSummary>
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
}): boolean {
  const enabledPluginIds = collectEnabledPluginIds(input.plugins)
  return input.conversations.some(
    (conv) =>
      conv.parentConversationId === undefined &&
      !isConversationArchived(conv) &&
      (() => {
        const profile = input.profiles.find((p) => p.id === conv.profileId)
        return profile === undefined || isProfileVisible(profile, enabledPluginIds)
      })(),
  )
}

/** Whether a space jump-back target is still available: conversations must be
 * in the list; agent standby requires the profile to still exist and its managing
 * plugin (if any) to be active; screens must still be contributed by an active
 * plugin; the system center is a static host target and always available. */
export function isSpaceTargetAvailable(target: ResolvedTarget, input: SpaceTargetInput): boolean {
  switch (target.kind) {
    case 'conversation':
      return input.conversations.some((conv) => conv.id === target.conversationId)
    case 'agent': {
      if (!input.assetsLoaded) return true
      const profile = input.profiles.find((p) => p.id === target.profileId)
      return profile !== undefined && isProfileVisible(profile, collectEnabledPluginIds(input.plugins))
    }
    case 'screen': {
      const plugin = input.plugins.find((p) => p.id === target.pluginId)
      if (plugin !== undefined && !isPluginSummaryActive(plugin)) return false
      return input.grouped.screens.some(
        (item) => item.pluginId === target.pluginId && item.spec.id === target.screenId,
      )
    }
    default:
      return true
  }
}

/** The default target of a space (when the space has no memory yet): settings
 * -> profile center; conversations -> the standby entry of the agent owning the
 * latest root conversation (falling back to the first usable profile when there
 * are none); views -> the first sidebar item resolvable to an active plugin screen.
 * Returns null when no usable target exists — the caller notifies explicitly and
 * never fabricates a nonexistent target. */
export function defaultSpaceTarget(space: SidebarSpace, input: SpaceTargetInput): ResolvedTarget | null {
  if (space === 'settings') return { kind: 'profiles' }
  if (space === 'views') {
    for (const item of input.grouped.sidebarItems) {
      if (!item.spec.target) continue
      const resolved = resolveTargetString(item.spec.target, input.conversations)
      if (resolved?.kind === 'screen') {
        const plugin = input.plugins.find((p) => p.id === resolved.pluginId)
        if (plugin !== undefined && !isPluginSummaryActive(plugin)) continue
        return resolved
      }
    }
    return null
  }
  const enabledPluginIds = collectEnabledPluginIds(input.plugins)
  const agentUsable = (profileId: string): boolean => {
    if (!input.assetsLoaded) return true
    const profile = input.profiles.find((p) => p.id === profileId)
    return profile !== undefined && isProfileVisible(profile, enabledPluginIds)
  }
  const latestRoot = input.conversations
    .filter((conv) => conv.parentConversationId === undefined && !isConversationArchived(conv))
    .reduce<ConversationSummary | null>(
      (best, conv) =>
        best === null || conv.updatedAt > best.updatedAt || (conv.updatedAt === best.updatedAt && conv.id > best.id)
          ? conv
          : best,
      null,
    )
  if (latestRoot !== null && agentUsable(latestRoot.profileId)) {
    return { kind: 'agent', profileId: latestRoot.profileId }
  }
  const visible = input.profiles.filter((profile) => isProfileVisible(profile, enabledPluginIds))
  const preferred = visible[0]
  return preferred === undefined ? null : { kind: 'agent', profileId: preferred.id }
}

export type SpaceSwitchResolution =
  | { kind: 'already-in-space' }
  | { kind: 'navigate'; target: ResolvedTarget; clearStaleMemory: boolean }
  | { kind: 'unavailable'; clearStaleMemory: boolean }

/** Resolve the target decision for an Activity Rail space click: same space no-op;
 * valid memory first; stale memory marked for cleanup with a fallback to the default.
 * The overview stage belongs to the conversations space (same spatial contract as
 * views/settings — switching away and clicking conversations jumps back cleanly). */
export function resolveSpaceSwitch(
  space: SidebarSpace,
  currentPrimary: ResolvedTarget,
  memory: Partial<Record<SidebarSpace, ResolvedTarget>>,
  input: SpaceTargetInput,
): SpaceSwitchResolution {
  if (spaceForTarget(currentPrimary) === space) {
    return { kind: 'already-in-space' }
  }
  let clearStaleMemory = false
  const remembered = memory[space]
  if (remembered !== undefined) {
    if (isSpaceTargetAvailable(remembered, input)) {
      return { kind: 'navigate', target: remembered, clearStaleMemory: false }
    }
    clearStaleMemory = true
  }
  const fallback = defaultSpaceTarget(space, input)
  if (fallback === null) {
    return { kind: 'unavailable', clearStaleMemory }
  }
  return { kind: 'navigate', target: fallback, clearStaleMemory }
}

/**
 * The standby (new-conversation) fallback target of a conversation leaving the
 * current view (deleted, or archived while open): the owning agent's standby
 * page, inheriting the remote node and working directory (the local node is
 * omitted per the URL contract; without a conversation summary, fall back to
 * the profile center).
 */
export function standbyFallbackTarget(
  summary: Pick<ConversationSummary, 'profileId' | 'nodeId' | 'cwd'> | undefined,
): ResolvedTarget {
  if (summary === undefined) return { kind: 'profiles' }
  return {
    kind: 'agent',
    profileId: summary.profileId,
    ...(summary.nodeId !== undefined && summary.nodeId !== '' && summary.nodeId !== 'local'
      ? { nodeId: summary.nodeId }
      : {}),
    ...(summary.cwd !== undefined && summary.cwd !== '' ? { cwd: summary.cwd } : {}),
  }
}

export interface ScreenParamsPatchResult {
  validEntries: Array<[string, string | undefined]>
  invalidKeys: string[]
}

/** Validate and split a Screen route-param patch, filtering illegal keys and prototype-reserved keys. */
export function partitionScreenParamsPatch(
  patch: Record<string, string | undefined>,
): ScreenParamsPatchResult {
  const validEntries: Array<[string, string | undefined]> = []
  const invalidKeys: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (SCREEN_PARAM_KEY_PATTERN.test(key) && !isPrototypeParamKey(key) && (value === undefined || typeof value === 'string')) {
      validEntries.push([key, value])
    } else {
      invalidKeys.push(key)
    }
  }
  return { validEntries, invalidKeys }
}

/** Apply a validated Screen route-param patch to the target (undefined deletes the key; empty strings are ignored). */
export function applyScreenParamsPatch(
  current: ResolvedTarget,
  validEntries: ReadonlyArray<[string, string | undefined]>,
): ResolvedTarget {
  if (current.kind !== 'screen' && current.kind !== 'overview') return current
  const next: Record<string, string> = { ...(current.params ?? {}) }
  for (const [rawKey, rawValue] of validEntries) {
    if (rawValue === undefined) delete next[rawKey]
    else if (rawValue !== '') next[rawKey] = rawValue
  }
  const params = Object.keys(next).length === 0 ? undefined : next
  if (current.kind === 'screen') {
    return params === undefined
      ? { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId }
      : { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId, params }
  }
  return params === undefined ? { kind: 'overview' } : { kind: 'overview', params }
}
