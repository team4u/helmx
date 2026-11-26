/**
 * Skill center pure-function model and category filtering.
 *
 * Provides skill category derivation, multi-dimension search (name / ID /
 * description / reference files), source distinction and metric summaries.
 * Follows the web Fast Refresh rule: pure functions, constants and data
 * models live here, never mixed into components.
 */
import type { SkillSummary } from '@helmx/protocol/browser'
import { assetsApi } from '../lib/api.js'
import type { ResolvedTarget } from '../lib/types.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { isNodeSourceSkill } from './skill-scope-model.js'

export type SkillCategoryTab = 'all' | 'core' | 'builtin' | 'plugins' | 'agents' | 'node' | 'workspace'

export interface SkillFilterOptions {
  query: string
  categoryTab: SkillCategoryTab
}

export interface SkillSummaryStats {
  total: number
  core: number
  builtin: number
  plugins: number
  agents: number
  node: number
  workspace: number
}

/**
 * Whether the skill is a kernel-owned core skill:
 * - managedByPlugin starts with 'core:' (and not from a discovery source root)
 */
export function isSkillCore(skill: SkillSummary): boolean {
  return !isNodeSourceSkill(skill) && !isSkillAgents(skill) && Boolean(skill.managedByPlugin?.startsWith('core:'))
}

/**
 * Whether the skill is managed by a built-in plugin:
 * - managedByPlugin starts with 'builtin:' (and not from a discovery source root)
 */
export function isSkillBuiltin(skill: SkillSummary): boolean {
  return !isNodeSourceSkill(skill) && !isSkillAgents(skill) && Boolean(skill.managedByPlugin?.startsWith('builtin:'))
}

/**
 * Whether the skill is managed by a third-party / external plugin:
 * - managedByPlugin set and not starting with 'builtin:' or 'core:'
 */
export function isSkillPlugin(skill: SkillSummary): boolean {
  return (
    !isNodeSourceSkill(skill) &&
    !isSkillAgents(skill) &&
    Boolean(
      skill.managedByPlugin &&
        !skill.managedByPlugin.startsWith('builtin:') &&
        !skill.managedByPlugin.startsWith('core:'),
    )
  )
}

/**
 * Whether the skill comes from the machine-level shared root
 * (~/.agents/skills, the pi ecosystem skill library):
 * - source === 'agents'
 */
export function isSkillAgents(skill: SkillSummary): boolean {
  return skill.source === 'agents'
}

/**
 * Whether the skill is private to the local workspace:
 * - no managedByPlugin and not from a discovery source root (shared / node)
 */
export function isSkillWorkspace(skill: SkillSummary): boolean {
  return !skill.managedByPlugin && !isSkillAgents(skill) && !isNodeSourceSkill(skill)
}

/** Whether the skill matches the given category pill tab. */
export function isSkillInTab(skill: SkillSummary, tab: SkillCategoryTab): boolean {
  if (tab === 'all') return true
  if (tab === 'core') return isSkillCore(skill)
  if (tab === 'builtin') return isSkillBuiltin(skill)
  if (tab === 'workspace') return isSkillWorkspace(skill)
  if (tab === 'plugins') return isSkillPlugin(skill)
  if (tab === 'agents') return isSkillAgents(skill)
  if (tab === 'node') return isNodeSourceSkill(skill)
  return false
}

/**
 * Filter the skill list by multiple conditions (pure; returns a new array,
 * never mutates the input).
 *
 * Search match scopes:
 * - skill.id
 * - skill.name
 * - skill.description
 * - each skill.references path
 */
export function filterSkills(
  skills: SkillSummary[],
  options: { query: string; categoryTab: SkillCategoryTab },
): SkillSummary[] {
  if (!Array.isArray(skills)) return []
  const query = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return skills.filter((skill) => {
    // 1. Category tab filter
    if (tab !== 'all' && !isSkillInTab(skill, tab)) {
      return false
    }

    // 2. Keyword search
    if (query) {
      const matchId = (skill.id ?? '').toLowerCase().includes(query)
      const matchName = (skill.name ?? '').toLowerCase().includes(query)
      const matchDesc = (skill.description ?? '').toLowerCase().includes(query)
      const matchRefs = Array.isArray(skill.references) && skill.references.some((ref) => (ref ?? '').toLowerCase().includes(query))
      if (!matchId && !matchName && !matchDesc && !matchRefs) {
        return false
      }
    }

    return true
  })
}

/** Count skills per category tab. */
export function buildSkillCategoryCounts(skills: SkillSummary[]): Record<SkillCategoryTab, number> {
  const list = Array.isArray(skills) ? skills : []
  let core = 0
  let builtin = 0
  let workspace = 0
  let plugins = 0
  let agents = 0
  let node = 0

  for (const s of list) {
    if (isNodeSourceSkill(s)) {
      node++
    } else if (isSkillAgents(s)) {
      agents++
    } else if (isSkillCore(s)) {
      core++
    } else if (isSkillBuiltin(s)) {
      builtin++
    } else if (isSkillPlugin(s)) {
      plugins++
    } else {
      workspace++
    }
  }

  return {
    all: list.length,
    core,
    builtin,
    workspace,
    plugins,
    agents,
    node,
  }
}

/** Summarize skill metrics. */
export function summarizeSkills(skills: SkillSummary[]): SkillSummaryStats {
  const counts = buildSkillCategoryCounts(skills)
  return {
    total: counts.all,
    core: counts.core,
    builtin: counts.builtin,
    plugins: counts.plugins,
    agents: counts.agents,
    node: counts.node,
    workspace: counts.workspace,
  }
}

/**
 * Resolve the skill's source badge label and variant (node / agents checked
 * first: discovery-source skills never carry managedByPlugin, but they are
 * semantically their own categories, not folded into the plugin dimension).
 */
export function getSkillSourceBadge(
  skill: SkillSummary,
  t?: WebMessageTranslator,
): {
  label: string
  variant: 'core' | 'builtin' | 'workspace' | 'plugin' | 'agents' | 'node'
} {
  const tt = t ?? englishWebTranslator
  if (isNodeSourceSkill(skill)) {
    return { label: tt('skills.category.node'), variant: 'node' }
  }
  if (isSkillAgents(skill)) {
    return { label: tt('skills.category.shared'), variant: 'agents' }
  }
  if (isSkillCore(skill)) {
    return { label: tt('skills.category.core'), variant: 'core' }
  }
  if (isSkillBuiltin(skill)) {
    return { label: tt('common.builtIn'), variant: 'builtin' }
  }
  if (isSkillPlugin(skill)) {
    return { label: skill.managedByPlugin ?? tt('skills.category.plugins'), variant: 'plugin' }
  }
  return { label: tt('skills.category.workspace'), variant: 'workspace' }
}

/** Localized category tab label ('all'/'builtin' reuse the common table). */
export function skillCategoryTabLabel(tab: SkillCategoryTab, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  switch (tab) {
    case 'all':
      return tt('common.all')
    case 'core':
      return tt('skills.category.core')
    case 'builtin':
      return tt('common.builtIn')
    case 'plugins':
      return tt('skills.category.plugins')
    case 'agents':
      return tt('skills.category.shared')
    case 'node':
      return tt('skills.category.node')
    case 'workspace':
      return tt('skills.category.workspace')
  }
}

/**
 * Resolve the Plugin Center navigation target for a managed skill's owner
 * (`core:*` -> Core capabilities drawer; plugin ID -> Plugin detail drawer).
 */
export function resolveSkillOwnerTarget(
  managedByPlugin: string | undefined,
): Extract<ResolvedTarget, { kind: 'plugins' }> | null {
  if (managedByPlugin === undefined) return null
  const owner = managedByPlugin.trim()
  if (owner === '') return null
  if (owner.startsWith('core:')) {
    return { kind: 'plugins', tab: 'core', coreOwner: owner }
  }
  return { kind: 'plugins', pluginId: owner }
}

/** Skill HTTP API facade consumed by the skill center and drawer. */
export const skillsApi = {
  read: (id: string, path?: string) => assetsApi.readSkill(id, path),
  list: () => assetsApi.listSkills(),
}
