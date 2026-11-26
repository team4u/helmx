import type {
  ConversationSummary,
  HostModelsSlice,
  PluginSummary,
  ProfileStarterPrompt,
} from '@helmx/protocol/browser'
import { resolveDefaultChainThinkingLevel } from '@helmx/plugin-client/pure'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
} from '@helmx/protocol/browser'
import { assetsApi } from '../lib/api.js'
import { isPluginSummaryActive } from '../lib/live-state.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'

declare module '@helmx/protocol/browser' {
  interface Profile {
    description?: string
    defaultModel?: string
    isSystem?: boolean
  }
}

export type { Profile } from '@helmx/protocol/browser'
import type { Profile } from '@helmx/protocol/browser'

export type ProfileCategoryTab = 'all' | 'system' | 'custom'

/** Build localized category tabs for ProfileCenter (`all`, `system`, `custom`). */
export function buildProfileCategoryTabs(
  t: WebMessageTranslator,
): Array<{ key: ProfileCategoryTab; label: string }> {
  return [
    { key: 'all', label: t('common.all') },
    { key: 'system', label: t('common.builtIn') },
    { key: 'custom', label: t('profiles.tab.custom') },
  ]
}

/** Whether the profile is a protected built-in or plugin-managed profile. */
export function isSystemProfile(p: Profile): boolean {
  return Boolean(p.isSystem || p.managedByPlugin)
}

/** Resolve the profile's bound default model. */
export function resolveProfileModel(p: Profile): string | undefined {
  return p.defaultModel ?? p.model
}

/**
 * Short display name for a bound model: strips the provider/ path prefix
 * (same normalization as the Composer model picker and model center cards);
 * blank or separator-only values fall back to empty/original, while the full
 * path is preserved in hover titles and the detail drawer.
 */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slashIdx = trimmed.lastIndexOf('/')
  return slashIdx >= 0 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed
}

/** Filter the profile list by search query and category tab. */
export function filterProfiles(
  profiles: Profile[],
  options: { query: string; categoryTab: ProfileCategoryTab },
): Profile[] {
  const { query, categoryTab } = options
  const q = query.trim().toLowerCase()

  return profiles.filter((p) => {
    // 1. Category match
    if (categoryTab === 'system' && !isSystemProfile(p)) {
      return false
    }
    if (categoryTab === 'custom' && isSystemProfile(p)) {
      return false
    }

    // 2. Search match: profile.id, profile.name, profile.description,
    //    profile.tags, profile.defaultModel, profile.system, profile.skills
    if (!q) {
      return true
    }

    if (p.id?.toLowerCase().includes(q)) return true
    if (p.name?.toLowerCase().includes(q)) return true
    if (p.description?.toLowerCase().includes(q)) return true
    if (p.tags?.some((t) => t.toLowerCase().includes(q))) return true
    const model = resolveProfileModel(p)
    if (model?.toLowerCase().includes(q)) return true
    if (p.system?.toLowerCase().includes(q)) return true
    if (p.skills?.some((s) => s.toLowerCase().includes(q))) return true

    return false
  })
}

export interface ProfileCategoryCounts {
  all: number
  system: number
  custom: number
}

/** Count profiles per category tab. */
export function buildProfileCategoryCounts(profiles: Profile[]): ProfileCategoryCounts {
  let systemCount = 0
  let customCount = 0

  for (const p of profiles) {
    if (isSystemProfile(p)) {
      systemCount++
    } else {
      customCount++
    }
  }

  return {
    all: profiles.length,
    system: systemCount,
    custom: customCount,
  }
}

/** Summarize profile counts. */
export function summarizeProfiles(profiles: Profile[]): {
  total: number
  system: number
  custom: number
} {
  const counts = buildProfileCategoryCounts(profiles)
  return {
    total: counts.all,
    system: counts.system,
    custom: counts.custom,
  }
}

/** Validate a new profile ID (letters, digits and hyphens, 1-64 chars). */
export function profileIdValid(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** A starter entry being edited in the form (not saved yet; transient blanks allowed). */
export interface StarterDraft {
  label: string
  prompt: string
}

/** Count Unicode code points (surrogate pairs count as 1; same as the service/HTTP boundary). */
function starterCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Validate one draft starter; returns the first error copy, or null when valid. */
export function validateStarterDraft(draft: StarterDraft, t: WebMessageTranslator): string | null {
  const label = draft.label.trim()
  if (starterCodePoints(label) === 0) return t('profiles.starter.error.titleEmpty')
  if (starterCodePoints(label) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    return t('profiles.starter.error.titleTooLong', { max: PROFILE_STARTER_LABEL_MAX_LENGTH })
  }
  if (draft.prompt.trim() === '') return t('profiles.starter.error.promptWhitespace')
  if (starterCodePoints(draft.prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    return t('profiles.starter.error.promptTooLong', { max: PROFILE_STARTER_PROMPT_MAX_LENGTH })
  }
  return null
}

/** Validate the whole starters draft; null when valid, else (index, error). */
export function validateStarterDrafts(
  drafts: StarterDraft[],
  t: WebMessageTranslator,
): { index: number; error: string } | null {
  for (let i = 0; i < drafts.length; i++) {
    const error = validateStarterDraft(drafts[i]!, t)
    if (error !== null) return { index: i, error }
  }
  return null
}

/** Profile.starters -> form drafts (undefined becomes an empty list: saving empty clears). */
export function startersToDrafts(starters: ProfileStarterPrompt[] | undefined): StarterDraft[] {
  return (starters ?? []).map((s) => ({ label: s.label, prompt: s.prompt }))
}

/** Starters shown on empty conversations: empty array falls back to undefined (host default hint is handled by the UI layer). */
export function visibleStarters(profile: Profile | undefined): ProfileStarterPrompt[] | undefined {
  const starters = profile?.starters
  return starters !== undefined && starters.length > 0 ? starters : undefined
}

/** Whether the starter cap is reached (no further additions). */
export function startersAtLimit(drafts: StarterDraft[]): boolean {
  return drafts.length >= PROFILE_STARTERS_MAX_ITEMS
}

export interface EffectiveProfileModelInfo {
  model?: string
  thinkingLevel?: string
  source: 'bound' | 'global' | 'unset'
}

/** Displayable thinking level: `undefined` for unset and `'off'` (both render without a level suffix). */
function displayableThinkingLevel(level: string): string | undefined {
  return level !== '' && level !== 'off' ? level : undefined
}

/**
 * Resolve the model and thinking level actually in effect for a profile
 * (own binding first, then the global default). The level mirrors the kernel's
 * default chain: a `tier/<id>` binding shows the tier's own preset (it outranks the
 * Profile/global level saved beside it), converged to the target model's supported
 * levels; pass the host model catalog so tiers can be resolved.
 */
export function resolveEffectiveProfileModel(
  profile: Profile,
  defaultModelInfo?: { defaultModel?: string; defaultThinkingLevel?: string } | null,
  catalog?: Pick<HostModelsSlice, 'models' | 'modelTiers' | 'modelThinkingLevels'>,
): EffectiveProfileModelInfo {
  const boundModel = resolveProfileModel(profile)?.trim() ?? ''
  if (boundModel !== '') {
    return {
      model: boundModel,
      thinkingLevel: displayableThinkingLevel(resolveDefaultChainThinkingLevel(catalog, boundModel, profile.thinkingLevel)),
      source: 'bound',
    }
  }
  const globalModel = defaultModelInfo?.defaultModel?.trim() ?? ''
  if (globalModel !== '') {
    return {
      model: globalModel,
      thinkingLevel: displayableThinkingLevel(
        resolveDefaultChainThinkingLevel(catalog, globalModel, defaultModelInfo?.defaultThinkingLevel),
      ),
      source: 'global',
    }
  }
  return { source: 'unset' }
}

/** Format the profile's default compute node and working directory location. */
export function formatProfileLocation(profile: Profile): {
  nodeId: string
  isRemoteNode: boolean
  cwd?: string
} {
  const nodeId = profile.nodeId?.trim() || 'local'
  const cwd = profile.cwd?.trim() || undefined
  return {
    nodeId,
    isRemoteNode: nodeId !== 'local',
    cwd,
  }
}

export interface ProfileActivitySummary {
  conversationCount: number
  workingCount: number
  blockedCount: number
  errorCount: number
  managingPluginDisabled: boolean
  stateKind: 'working' | 'blocked' | 'error' | 'plugin-disabled' | 'active' | 'idle'
  stateLabel: string
}

/** Summarize the profile's conversation activity and managing plugin status. */
export function summarizeProfileActivity(
  profile: Profile,
  conversations: ConversationSummary[] = [],
  plugins: PluginSummary[] = [],
  t: WebMessageTranslator,
): ProfileActivitySummary {
  let conversationCount = 0
  let workingCount = 0
  let blockedCount = 0
  let errorCount = 0

  for (const conv of conversations) {
    if (conv.profileId !== profile.id) continue
    conversationCount++
    if (conv.status === 'working') workingCount++
    else if (conv.status === 'blocked') blockedCount++
    else if (conv.status === 'error') errorCount++
  }

  const managingPlugin = profile.managedByPlugin
    ? plugins.find((plugin) => plugin.id === profile.managedByPlugin)
    : undefined
  const managingPluginDisabled = Boolean(managingPlugin && !isPluginSummaryActive(managingPlugin))

  if (managingPluginDisabled) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'plugin-disabled',
      stateLabel: t('profiles.activity.pluginDisabled'),
    }
  }
  if (workingCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'working',
      stateLabel:
        workingCount > 1
          ? t('profiles.activity.runningCount', { count: workingCount })
          : t('profiles.activity.running'),
    }
  }
  if (blockedCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'blocked',
      stateLabel:
        blockedCount > 1
          ? t('profiles.activity.pendingApprovalCount', { count: blockedCount })
          : t('profiles.activity.pendingApproval'),
    }
  }
  if (errorCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'error',
      stateLabel:
        errorCount > 1 ? t('profiles.activity.errors', { count: errorCount }) : t('profiles.activity.hasErrors'),
    }
  }
  if (conversationCount > 0) {
    return {
      conversationCount,
      workingCount,
      blockedCount,
      errorCount,
      managingPluginDisabled,
      stateKind: 'active',
      stateLabel: t('profiles.activity.conversations', { count: conversationCount }),
    }
  }
  return {
    conversationCount,
    workingCount,
    blockedCount,
    errorCount,
    managingPluginDisabled,
    stateKind: 'idle',
    stateLabel: t('profiles.activity.standingBy'),
  }
}

/** Profile HTTP API facade. */
export const profilesApi = {
  list: () => assetsApi.listProfiles(),
  get: (id: string) => assetsApi.getProfile(id),
  create: (profile: Profile) => assetsApi.createProfile(profile),
  update: (id: string, profile: Omit<Profile, 'id'> & { id?: string }) =>
    assetsApi.updateProfile(id, profile),
  delete: (id: string) => assetsApi.deleteProfile(id),
}

// ---------------------------------------------------------------------------
// Profile form normalization & PUT save payload
// ---------------------------------------------------------------------------

export interface ProfileSaveInput {
  id: string
  name?: string
  model?: string
  thinkingLevel?: string
  nodeId?: string
  cwd?: string
  restrictToCwd?: boolean
  system?: string
  /** `undefined` = all available skills; `[]` = explicitly none; non-empty = allowlist. */
  skills?: string[]
  starters?: StarterDraft[]
  tags?: string[]
  /** Previous full profile snapshot for PUT whole-replacement passthrough (`tags`, `managedByPlugin`). */
  source?: Profile | null
  isNew: boolean
  /** Omit `system` on update unless explicitly edited so concurrent `SYSTEM.md` writes stay intact. */
  includeSystem?: boolean
}

/**
 * Build the HTTP create/update payload matching the PUT full-replacement contract:
 * - only valid protocol fields are written (never leaking UI-only augmented props like `description`);
 * - blank scalar overrides (`name`, `model`, `thinkingLevel`, `nodeId`, `cwd`) are omitted so PUT deletes them;
 * - `skills` preserves the three-state distinction (`undefined` omitted, `[]` kept as empty array, allowlist kept verbatim);
 * - `!isNew` preserves `tags` and `managedByPlugin` from `source`;
 * - `system` is emitted only for new profiles or when explicitly edited (`includeSystem: true`).
 */
export function buildProfileSavePayload(input: ProfileSaveInput): Profile {
  const normalizedId = input.id.trim()
  const payload: Profile = { id: normalizedId }
  const source = !input.isNew ? (input.source ?? undefined) : undefined

  if (input.tags !== undefined) {
    payload.tags = [...input.tags]
  } else if (source?.tags !== undefined) {
    payload.tags = [...source.tags]
  } else if (source !== undefined) {
    payload.tags = []
  }

  if (source?.managedByPlugin !== undefined) payload.managedByPlugin = source.managedByPlugin

  const name = input.name?.trim()
  if (name) payload.name = name

  const model = input.model?.trim()
  if (model) payload.model = model

  const thinkingLevel = input.thinkingLevel?.trim()
  if (thinkingLevel) payload.thinkingLevel = thinkingLevel

  const nodeId = input.nodeId?.trim()
  if (nodeId) payload.nodeId = nodeId

  const cwd = input.cwd?.trim()
  if (cwd) payload.cwd = cwd

  if (input.restrictToCwd !== undefined) payload.restrictToCwd = input.restrictToCwd
  if (input.skills !== undefined) payload.skills = [...input.skills]

  if (input.starters !== undefined) {
    if (input.starters.length > 0) {
      payload.starters = input.starters.map((s) => ({ label: s.label.trim(), prompt: s.prompt }))
    } else if (!input.isNew) {
      // Editing existing profile: empty list explicitly clears starters (restores host default prompts).
      payload.starters = []
    }
  }

  if (input.isNew || input.includeSystem) {
    payload.system = input.system ?? ''
  }

  return payload
}
