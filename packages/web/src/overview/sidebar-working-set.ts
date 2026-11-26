/**
 * Sidebar conversation working-set slicing, descendant branch projection,
 * primary-click target arbitration, and group-by preference persistence.
 */
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { readStorageItem, writeStorageItem, type StorageReader, type StorageWriter } from '../lib/storage.js'
import type { AgentStanding } from '../shell/sidebar-model.js'
import {
  filterOverviewCards,
  groupOverviewCards,
  overviewDescendantMatchesQuery,
} from './overview-filters.js'
import {
  SIDEBAR_DESCENDANT_AUTO_LIMIT,
  SIDEBAR_GROUP_BY_STORAGE_KEY,
  SIDEBAR_PER_GROUP_QUIET_LIMIT,
  SIDEBAR_RECENT_QUIET_LIMIT,
  type OverviewCard,
  type OverviewCardGroup,
  type OverviewDescendant,
  type OverviewGroupBy,
} from './overview-types.js'

/** 读取持久化的侧栏分组维度（非法值或不可用存储静默回退 'status'）。 */
export function loadSidebarGroupBy(storage?: StorageReader | null): OverviewGroupBy {
  const raw = readStorageItem(SIDEBAR_GROUP_BY_STORAGE_KEY, storage)
  if (raw === 'profile' || raw === 'node' || raw === 'status') return raw
  return 'status'
}

/** 持久化侧栏分组维度（私有模式/配额异常静默忽略）。 */
export function saveSidebarGroupBy(
  groupBy: OverviewGroupBy,
  storage?: StorageWriter | null,
): OverviewGroupBy {
  writeStorageItem(SIDEBAR_GROUP_BY_STORAGE_KEY, groupBy, storage)
  return groupBy
}

/** 侧栏工作集切片结果。 */
export interface SidebarWorkingSet {
  cards: OverviewCard[]
  totalRootCount: number
  omittedQuietCount: number
  searchActive: boolean
}

function cardMatchesActiveConversation(
  card: OverviewCard,
  activeConversationIds: ReadonlySet<number>,
): boolean {
  if (activeConversationIds.has(card.root.id)) return true
  return card.descendants.some((descendant) => activeConversationIds.has(descendant.conv.id))
}

function sliceSidebarGroupQuietCards(
  activeCards: ReadonlyArray<OverviewCard>,
  quietCards: ReadonlyArray<OverviewCard>,
  activeConversationIds: ReadonlySet<number>,
  quietLimit: number,
): { cards: OverviewCard[]; omittedQuietCount: number } {
  const sortedQuiet = [...quietCards].sort(
    (a, b) =>
      b.root.updatedAt - a.root.updatedAt ||
      b.root.createdAt - a.root.createdAt ||
      b.root.id - a.root.id,
  )

  const cap = Math.max(0, quietLimit)
  const keptQuiet: OverviewCard[] = []
  for (let i = 0; i < sortedQuiet.length; i += 1) {
    const card = sortedQuiet[i]!
    if (i < cap || cardMatchesActiveConversation(card, activeConversationIds)) {
      keptQuiet.push(card)
    }
  }

  return {
    cards: [...activeCards, ...keptQuiet],
    omittedQuietCount: sortedQuiet.length - keptQuiet.length,
  }
}

function sliceSingleBucketGroup(
  groupCards: ReadonlyArray<OverviewCard>,
  activeConversationIds: ReadonlySet<number>,
  quietLimit: number,
): { cards: OverviewCard[]; omittedQuietCount: number } {
  const activeCards: OverviewCard[] = []
  const quietCards: OverviewCard[] = []
  for (const card of groupCards) {
    if (card.bucket === 'quiet') quietCards.push(card)
    else activeCards.push(card)
  }
  return sliceSidebarGroupQuietCards(activeCards, quietCards, activeConversationIds, quietLimit)
}

/** 构建侧栏工作集切片。 */
export function buildSidebarWorkingSet(input: {
  cards: ReadonlyArray<OverviewCard>
  activeConversationIds: ReadonlySet<number>
  query?: string
  recentLimit?: number
}): SidebarWorkingSet {
  const { cards, activeConversationIds, query = '', recentLimit = SIDEBAR_RECENT_QUIET_LIMIT } = input
  const humanCards = cards.filter((card) => !card.automated)
  const totalRootCount = humanCards.length
  const trimmedQuery = query.trim()
  if (trimmedQuery !== '') {
    const matched = filterOverviewCards(humanCards, {
      bucket: 'all',
      profileId: '',
      nodeId: '',
      source: 'all',
      query: trimmedQuery,
    })
    return {
      cards: matched,
      totalRootCount,
      omittedQuietCount: 0,
      searchActive: true,
    }
  }

  const activeCards: OverviewCard[] = []
  const quietCards: OverviewCard[] = []
  for (const card of humanCards) {
    if (card.bucket === 'quiet') quietCards.push(card)
    else activeCards.push(card)
  }

  const sliced = sliceSidebarGroupQuietCards(activeCards, quietCards, activeConversationIds, recentLimit)

  return {
    cards: sliced.cards,
    totalRootCount,
    omittedQuietCount: sliced.omittedQuietCount,
    searchActive: false,
  }
}

/** 侧栏工作集分组项（统一覆盖按状态 / 按角色 / 按节点三种维度）。 */
export interface SidebarWorkingSetGroup extends OverviewCardGroup {
  profileId?: string
  canCreateConversation?: boolean
  totalGroupCount: number
}

/** 侧栏工作集按维度分组结果。 */
export interface SidebarGroupedWorkingSet {
  groups: SidebarWorkingSetGroup[]
  totalRootCount: number
  omittedQuietCount: number
  searchActive: boolean
}

/** 构建侧栏工作集分组切片（按状态 / 按角色 / 按节点）。 */
export function buildSidebarGroupedWorkingSet(input: {
  groupBy: OverviewGroupBy
  cards: ReadonlyArray<OverviewCard>
  activeConversationIds: ReadonlySet<number>
  agentStandings?: ReadonlyArray<AgentStanding>
  query?: string
  recentLimit?: number
  perGroupQuietLimit?: number
  t: WebMessageTranslator
}): SidebarGroupedWorkingSet {
  const {
    groupBy,
    cards,
    activeConversationIds,
    agentStandings,
    query = '',
    recentLimit = SIDEBAR_RECENT_QUIET_LIMIT,
    perGroupQuietLimit = SIDEBAR_PER_GROUP_QUIET_LIMIT,
    t,
  } = input

  if (groupBy === 'status') {
    const ws = buildSidebarWorkingSet({ cards, activeConversationIds, query, recentLimit })
    const groups: SidebarWorkingSetGroup[] = groupOverviewCards(ws.cards, 'status', t).map((group) => ({
      ...group,
      totalGroupCount: group.cards.length,
    }))
    return {
      groups,
      totalRootCount: ws.totalRootCount,
      omittedQuietCount: ws.omittedQuietCount,
      searchActive: ws.searchActive,
    }
  }

  const humanCards = cards.filter((card) => !card.automated)
  const totalRootCount = humanCards.length
  const trimmedQuery = query.trim()

  if (groupBy === 'profile') {
    const standingByProfile = new Map<string, AgentStanding>(
      (agentStandings ?? []).map((standing) => [standing.profileId, standing] as const),
    )

    if (trimmedQuery !== '') {
      const matched = filterOverviewCards(humanCards, {
        bucket: 'all',
        profileId: '',
        nodeId: '',
        source: 'all',
        query: trimmedQuery,
      })
      const groups: SidebarWorkingSetGroup[] = groupOverviewCards(matched, 'profile', t).map((group) => {
        const profileId = group.cards[0]!.root.profileId
        const standing = standingByProfile.get(profileId)
        return {
          ...group,
          profileId,
          label: standing?.label || group.label,
          canCreateConversation: standing?.canCreateConversation === true,
          totalGroupCount: group.cards.length,
        }
      })
      return { groups, totalRootCount, omittedQuietCount: 0, searchActive: true }
    }

    const byProfile = new Map<string, OverviewCard[]>()
    for (const card of humanCards) {
      const pid = card.root.profileId
      let list = byProfile.get(pid)
      if (list === undefined) {
        list = []
        byProfile.set(pid, list)
      }
      list.push(card)
    }

    const groups: SidebarWorkingSetGroup[] = []
    const seen = new Set<string>()
    let omittedQuietCount = 0

    for (const standing of agentStandings ?? []) {
      const rawCards = byProfile.get(standing.profileId) ?? []
      if (rawCards.length === 0 && !standing.canCreateConversation) continue
      const sliced = sliceSingleBucketGroup(rawCards, activeConversationIds, perGroupQuietLimit)
      omittedQuietCount += sliced.omittedQuietCount
      groups.push({
        key: `profile:${standing.profileId}`,
        kind: 'profile',
        profileId: standing.profileId,
        label: standing.label,
        canCreateConversation: standing.canCreateConversation,
        cards: sliced.cards,
        totalGroupCount: rawCards.length,
      })
      seen.add(standing.profileId)
    }

    for (const [profileId, rawCards] of byProfile) {
      if (seen.has(profileId)) continue
      const sliced = sliceSingleBucketGroup(rawCards, activeConversationIds, perGroupQuietLimit)
      omittedQuietCount += sliced.omittedQuietCount
      groups.push({
        key: `profile:${profileId}`,
        kind: 'profile',
        profileId,
        label: rawCards[0]!.profileLabel || profileId,
        canCreateConversation: false,
        cards: sliced.cards,
        totalGroupCount: rawCards.length,
      })
    }

    const populatedGroups: SidebarWorkingSetGroup[] = []
    const emptyGroups: SidebarWorkingSetGroup[] = []
    for (const group of groups) {
      if (group.cards.length > 0) populatedGroups.push(group)
      else emptyGroups.push(group)
    }

    return {
      groups: [...populatedGroups, ...emptyGroups],
      totalRootCount,
      omittedQuietCount,
      searchActive: false,
    }
  }

  if (trimmedQuery !== '') {
    const matched = filterOverviewCards(humanCards, {
      bucket: 'all',
      profileId: '',
      nodeId: '',
      source: 'all',
      query: trimmedQuery,
    })
    const groups: SidebarWorkingSetGroup[] = groupOverviewCards(matched, 'node', t).map((group) => ({
      ...group,
      totalGroupCount: group.cards.length,
    }))
    return { groups, totalRootCount, omittedQuietCount: 0, searchActive: true }
  }

  let omittedQuietCount = 0
  const groups: SidebarWorkingSetGroup[] = groupOverviewCards(humanCards, 'node', t).map((group) => {
    const sliced = sliceSingleBucketGroup(group.cards, activeConversationIds, perGroupQuietLimit)
    omittedQuietCount += sliced.omittedQuietCount
    return {
      ...group,
      cards: sliced.cards,
      totalGroupCount: group.cards.length,
    }
  })

  return { groups, totalRootCount, omittedQuietCount, searchActive: false }
}

/** 侧栏总览单棵树的后代展示切片。 */
export interface SidebarOverviewDescendantsSlice {
  visible: OverviewDescendant[]
  hiddenCount: number
  hasCollapsibleQuiet: boolean
}

/** 解析侧栏工作集中单棵树的子行切片。 */
export function resolveSidebarOverviewDescendants(input: {
  card: OverviewCard
  expanded: boolean
  activeConversationIds: ReadonlySet<number>
  query?: string
}): SidebarOverviewDescendantsSlice {
  const { card, expanded, activeConversationIds, query = '' } = input
  const descendants = card.directDescendants
  if (descendants.length === 0) {
    return { visible: [], hiddenCount: 0, hasCollapsibleQuiet: false }
  }
  const trimmedQuery = query.trim()
  const branchByConversationId = new Map<number, number>()
  for (const descendant of descendants) {
    for (const id of descendant.subtreeConversationIds ?? [descendant.conv.id]) {
      branchByConversationId.set(id, descendant.conv.id)
    }
  }
  const currentBranchIds = new Set<number>()
  for (const id of activeConversationIds) {
    const branchId = branchByConversationId.get(id)
    if (branchId !== undefined) currentBranchIds.add(branchId)
  }
  const matchedBranchIds = new Set<number>()
  if (trimmedQuery !== '') {
    for (const candidate of card.descendants) {
      if (!overviewDescendantMatchesQuery(candidate, trimmedQuery)) continue
      const branchId = branchByConversationId.get(candidate.conv.id)
      if (branchId !== undefined) matchedBranchIds.add(branchId)
    }
  }
  const isAttention = (descendant: OverviewDescendant): boolean =>
    (descendant.subtreeErrorCount ?? 0) > 0 || (descendant.subtreeWaitingCount ?? 0) > 0
  const ranked = [...descendants].sort((a, b) => {
    const aCurrent = currentBranchIds.has(a.conv.id)
    const bCurrent = currentBranchIds.has(b.conv.id)
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    const aMatched = matchedBranchIds.has(a.conv.id)
    const bMatched = matchedBranchIds.has(b.conv.id)
    if (aMatched !== bMatched) return aMatched ? -1 : 1
    const aAttention = isAttention(a)
    const bAttention = isAttention(b)
    if (aAttention !== bAttention) return aAttention ? -1 : 1
    return a.conv.createdAt - b.conv.createdAt || a.conv.id - b.conv.id
  })
  const autoVisible = ranked.filter(
    (descendant) =>
      currentBranchIds.has(descendant.conv.id) ||
      matchedBranchIds.has(descendant.conv.id) ||
      isAttention(descendant),
  )
  const selected = expanded ? ranked : autoVisible.slice(0, SIDEBAR_DESCENDANT_AUTO_LIMIT)
  const selectedIds = new Set(selected.map((descendant) => descendant.conv.id))
  const visible = descendants.filter((descendant) => selectedIds.has(descendant.conv.id))
  return {
    visible,
    hiddenCount: Math.max(0, ranked.length - visible.length),
    hasCollapsibleQuiet: ranked.length > 0,
  }
}

/** 侧栏工作集主项点击直达目标裁决。 */
export function resolveSidebarOverviewPrimaryTarget(
  card: OverviewCard,
  visibleDescendants: ReadonlyArray<OverviewDescendant>,
): number {
  if (
    card.targetConversationId !== card.root.id &&
    visibleDescendants.some((descendant) => descendant.conv.id === card.targetConversationId)
  ) {
    return card.root.id
  }
  return card.targetConversationId
}
