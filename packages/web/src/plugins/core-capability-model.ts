/**
 * Pure-function model for the Plugin Center's Core Capabilities tab:
 * - Aggregates kernel-owned `core:*` ActionManifest entries (`useCatalogActions`)
 *   and `core:*` managed SkillSummary entries (`useSkills`) by owner namespace;
 * - Provides multi-dimensional search, category filtering, summary metrics and
 *   read-only contract formatting helpers;
 * - Strictly zero React/DOM dependencies (Fast Refresh compliant).
 */
import type { ActionManifest, SkillSummary } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageKey, type WebMessageTranslator } from '../i18n/catalog.js'

export type CoreCapabilityFilter = 'all' | 'actions' | 'skills'

export interface CoreCapabilityOwner {
  /** Kernel owner namespace, e.g. `core:conversations`, `core:host`, `core:plugins`. */
  id: string
  /** Domain suffix after `core:`, e.g. `conversations`, `host`, `plugins`. */
  domain: string
  /** Localized display name. */
  name: string
  /** Localized summary description. */
  description: string
  /** Linear icon name for HelmxIcon. */
  icon: string
  /** Kernel actions owned by this namespace, sorted by action id. */
  actions: ActionManifest[]
  /** Managed skills owned by this namespace, sorted by skill id. */
  skills: SkillSummary[]
}

export interface CoreCapabilityFilterState {
  query?: string
  filter?: CoreCapabilityFilter
}

export interface CoreCapabilitySummaryStats {
  total: number
  withActions: number
  withSkills: number
  totalActions: number
  totalSkills: number
}

interface CoreOwnerMeta {
  icon: string
  order: number
  nameKey: WebMessageKey
  descKey: WebMessageKey
}

const CORE_OWNER_META: Record<string, CoreOwnerMeta> = {
  conversations: {
    icon: 'message-square',
    order: 10,
    nameKey: 'plugins.core.owner.conversations.name',
    descKey: 'plugins.core.owner.conversations.desc',
  },
  profiles: {
    icon: 'user',
    order: 20,
    nameKey: 'plugins.core.owner.profiles.name',
    descKey: 'plugins.core.owner.profiles.desc',
  },
  models: {
    icon: 'cpu',
    order: 30,
    nameKey: 'plugins.core.owner.models.name',
    descKey: 'plugins.core.owner.models.desc',
  },
  nodes: {
    icon: 'server',
    order: 40,
    nameKey: 'plugins.core.owner.nodes.name',
    descKey: 'plugins.core.owner.nodes.desc',
  },
  plugins: {
    icon: 'puzzle',
    order: 50,
    nameKey: 'plugins.core.owner.plugins.name',
    descKey: 'plugins.core.owner.plugins.desc',
  },
  asks: {
    icon: 'help-circle',
    order: 60,
    nameKey: 'plugins.core.owner.asks.name',
    descKey: 'plugins.core.owner.asks.desc',
  },
  skills: {
    icon: 'sparkles',
    order: 70,
    nameKey: 'plugins.core.owner.skills.name',
    descKey: 'plugins.core.owner.skills.desc',
  },
  host: {
    icon: 'terminal',
    order: 80,
    nameKey: 'plugins.core.owner.host.name',
    descKey: 'plugins.core.owner.host.desc',
  },
}

/** Whether an owner/plugin identifier belongs to the kernel-reserved `core:*` namespace. */
export function isCoreNamespace(id: string | undefined): id is string {
  return typeof id === 'string' && id.startsWith('core:') && id.length > 'core:'.length
}

function formatFallbackOwnerName(domain: string): string {
  if (domain === '') return 'core'
  return domain.charAt(0).toUpperCase() + domain.slice(1)
}

function resolveOwnerDisplay(
  ownerId: string,
  actionCount: number,
  skillCount: number,
  t: WebMessageTranslator,
): { domain: string; name: string; description: string; icon: string; order: number } {
  const domain = ownerId.slice('core:'.length)
  const meta = Object.hasOwn(CORE_OWNER_META, domain) ? CORE_OWNER_META[domain] : undefined
  if (meta !== undefined) {
    return {
      domain,
      name: t(meta.nameKey),
      description: t(meta.descKey),
      icon: meta.icon,
      order: meta.order,
    }
  }
  const parts: string[] = []
  if (actionCount > 0) parts.push(t('plugins.desc.actionsPart', { count: actionCount }))
  if (skillCount > 0) parts.push(t('plugins.core.skillsTitle', { count: skillCount }))
  const description =
    parts.length > 0
      ? t('plugins.core.owner.fallbackDesc', { parts: parts.join(t('plugins.desc.listSeparator')) })
      : t('plugins.core.owner.fallbackEmptyDesc')
  return {
    domain,
    name: formatFallbackOwnerName(domain),
    description,
    icon: 'shield',
    order: 1000,
  }
}

/**
 * Group `core:*` actions and `core:*` managed skills by owner namespace.
 * Discovery-source skills (`agents` / `node`) are excluded so only Hub kernel-managed
 * skills appear under core owners.
 */
export function buildCoreCapabilityOwners(
  actions: ReadonlyArray<ActionManifest>,
  skills: ReadonlyArray<SkillSummary>,
  t: WebMessageTranslator = englishWebTranslator,
): CoreCapabilityOwner[] {
  const bucketMap = new Map<string, { actions: ActionManifest[]; skills: SkillSummary[] }>()

  const ensureBucket = (ownerId: string) => {
    let bucket = bucketMap.get(ownerId)
    if (bucket === undefined) {
      bucket = { actions: [], skills: [] }
      bucketMap.set(ownerId, bucket)
    }
    return bucket
  }

  for (const action of actions) {
    if (!isCoreNamespace(action.pluginId)) continue
    ensureBucket(action.pluginId).actions.push(action)
  }

  for (const skill of skills) {
    if (skill.source === 'agents' || skill.source === 'node') continue
    if (!isCoreNamespace(skill.managedByPlugin)) continue
    ensureBucket(skill.managedByPlugin).skills.push(skill)
  }

  const owners: Array<{ order: number; owner: CoreCapabilityOwner }> = []
  for (const [ownerId, bucket] of bucketMap) {
    const sortedActions = [...bucket.actions].sort((a, b) => a.id.localeCompare(b.id))
    const sortedSkills = [...bucket.skills].sort((a, b) => a.id.localeCompare(b.id))
    const display = resolveOwnerDisplay(ownerId, sortedActions.length, sortedSkills.length, t)
    owners.push({
      order: display.order,
      owner: {
        id: ownerId,
        domain: display.domain,
        name: display.name,
        description: display.description,
        icon: display.icon,
        actions: sortedActions,
        skills: sortedSkills,
      },
    })
  }

  owners.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.owner.id.localeCompare(b.owner.id)
  })

  return owners.map((entry) => entry.owner)
}

/** Filter core capability owners by pill filter and search query (pure). */
export function filterCoreCapabilities(
  owners: ReadonlyArray<CoreCapabilityOwner>,
  state: CoreCapabilityFilterState,
): CoreCapabilityOwner[] {
  const query = state.query?.trim().toLowerCase() ?? ''
  const filter = state.filter ?? 'all'

  return owners.filter((owner) => {
    if (filter === 'actions' && owner.actions.length === 0) return false
    if (filter === 'skills' && owner.skills.length === 0) return false

    if (query) {
      const matchOwner =
        owner.id.toLowerCase().includes(query) ||
        owner.domain.toLowerCase().includes(query) ||
        owner.name.toLowerCase().includes(query) ||
        owner.description.toLowerCase().includes(query)
      const matchActions = owner.actions.some((action) => {
        const fullId = `${owner.id}.${action.id}`.toLowerCase()
        const cliCmd = action.cli?.command?.join(' ').toLowerCase() ?? ''
        return (
          action.id.toLowerCase().includes(query) ||
          fullId.includes(query) ||
          (action.description ?? '').toLowerCase().includes(query) ||
          cliCmd.includes(query)
        )
      })
      const matchSkills = owner.skills.some(
        (skill) =>
          skill.id.toLowerCase().includes(query) ||
          (skill.name ?? '').toLowerCase().includes(query) ||
          (skill.description ?? '').toLowerCase().includes(query),
      )
      if (!matchOwner && !matchActions && !matchSkills) return false
    }

    return true
  })
}

/** Summarize core capability metrics for toolbar pills. */
export function summarizeCoreCapabilities(
  owners: ReadonlyArray<CoreCapabilityOwner>,
): CoreCapabilitySummaryStats {
  let withActions = 0
  let withSkills = 0
  let totalActions = 0
  let totalSkills = 0

  for (const owner of owners) {
    if (owner.actions.length > 0) withActions++
    if (owner.skills.length > 0) withSkills++
    totalActions += owner.actions.length
    totalSkills += owner.skills.length
  }

  return {
    total: owners.length,
    withActions,
    withSkills,
    totalActions,
    totalSkills,
  }
}

/** Localized pill label for CoreCapabilities filters. */
export function coreCapabilityFilterLabel(
  filter: CoreCapabilityFilter,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  switch (filter) {
    case 'all':
      return t('common.all')
    case 'actions':
      return t('plugins.core.tabActions')
    case 'skills':
      return t('plugins.core.tabSkills')
  }
}

/** Format a core action's CLI command path (or null when undeclared). */
export function formatCoreCliCommand(action: Pick<ActionManifest, 'cli'>): string | null {
  const parts = action.cli?.command
  if (!Array.isArray(parts) || parts.length === 0) return null
  return `helmx ${parts.join(' ')}`
}

/** Format JSON schema safely for read-only inspection. */
export function formatCoreSchemaJson(schema: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(schema ?? {}, null, 2)
  } catch {
    return '{}'
  }
}
