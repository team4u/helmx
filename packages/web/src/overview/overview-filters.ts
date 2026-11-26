/**
 * Pure filtering, grouping, bucket counting, and route-param parsing/repair
 * utilities for conversation overview cards.
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import {
  OVERVIEW_FILTER_PARAM_KEYS,
  type OverviewBucketFilter,
  type OverviewCard,
  type OverviewCardBucket,
  type OverviewCardGroup,
  type OverviewDescendant,
  type OverviewFilterState,
  type OverviewGroupBy,
  type OverviewSourceFilter,
} from './overview-types.js'

const ORDERED_BUCKETS: readonly OverviewCardBucket[] = [
  'needs_attention',
  'running',
  'unread_done',
  'quiet',
  'archived',
]

const BUCKET_SECTION_LABEL_KEYS: Record<
  OverviewCardBucket,
  | 'shell.overview.sectionNeeds'
  | 'shell.overview.sectionRunning'
  | 'shell.overview.sectionUnread'
  | 'shell.overview.sectionQuiet'
  | 'shell.archived.groupTitle'
> = {
  needs_attention: 'shell.overview.sectionNeeds',
  running: 'shell.overview.sectionRunning',
  unread_done: 'shell.overview.sectionUnread',
  quiet: 'shell.overview.sectionQuiet',
  archived: 'shell.archived.groupTitle',
}

/** 总览筛选条件（空串表示不过滤）。 */
export interface OverviewCardFilter {
  bucket: OverviewBucketFilter
  profileId: string
  /** 节点筛选值；'local' 聚合未标注 nodeId 的本机会话。 */
  nodeId: string
  /** 来源筛选（缺省 'all' 不过滤；与桶/角色/节点 AND 组合）。 */
  source?: OverviewSourceFilter
  /** 标题/摘要搜索（大小写不敏感子串；缺省或空串不过滤）。 */
  query?: string
}

/** 会话的节点筛选键（缺省本机）。 */
export function overviewNodeKey(conv: Pick<ConversationSummary, 'nodeId'>): string {
  return conv.nodeId === undefined || conv.nodeId === '' ? 'local' : conv.nodeId
}

/** 判断单条后代会话是否直接命中搜索词（标题子串或精确数字/#id）。 */
export function overviewDescendantMatchesQuery(descendant: OverviewDescendant, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return false
  const idNeedle = needle.startsWith('#') ? needle.slice(1) : needle
  if (/^\d+$/.test(idNeedle)) {
    return descendant.conv.id === Number(idNeedle)
  }
  return descendant.conv.title.toLowerCase().includes(needle)
}

function overviewCardMatchesQuery(card: OverviewCard, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (card.root.title.toLowerCase().includes(needle)) return true
  if (card.profileLabel.toLowerCase().includes(needle)) return true
  if (overviewNodeKey(card.root).toLowerCase().includes(needle)) return true
  if (card.summaryText.toLowerCase().includes(needle)) return true
  const idNeedle = needle.startsWith('#') ? needle.slice(1) : needle
  if (/^\d+$/.test(idNeedle)) {
    const wanted = Number(idNeedle)
    if (card.root.id === wanted) return true
    return card.descendants.some((descendant) => descendant.conv.id === wanted)
  }
  return card.descendants.some((descendant) => overviewDescendantMatchesQuery(descendant, needle))
}

/**
 * 筛选总览卡片：桶（quiet 仅在 all）、角色、节点、来源、搜索五者 AND 组合；
 * 空串筛选值表示该维度不过滤，source 缺省 'all'、query 缺省空串不过滤。
 */
export function filterOverviewCards(
  cards: ReadonlyArray<OverviewCard>,
  filter: OverviewCardFilter,
): OverviewCard[] {
  return cards.filter((card) => {
    if (filter.bucket !== 'all' && card.bucket !== filter.bucket) return false
    if (filter.profileId !== '' && card.root.profileId !== filter.profileId) return false
    if (filter.nodeId !== '' && overviewNodeKey(card.root) !== filter.nodeId) return false
    if (filter.source === 'human' && card.automated) return false
    if (filter.source === 'automated' && !card.automated) return false
    if (!overviewCardMatchesQuery(card, filter.query ?? '')) return false
    return true
  })
}

/** 桶筛选计数（在角色/节点/来源/搜索上下文内统计）。 */
export function overviewBucketCounts(
  cards: ReadonlyArray<OverviewCard>,
  context: { profileId?: string; nodeId?: string; source?: OverviewSourceFilter; query?: string } = {},
  archivedCards: ReadonlyArray<OverviewCard> = [],
): { all: number; needs_attention: number; running: number; unread_done: number; archived: number } {
  const scoped = filterOverviewCards(cards, {
    bucket: 'all',
    profileId: context.profileId ?? '',
    nodeId: context.nodeId ?? '',
    ...(context.source !== undefined ? { source: context.source } : {}),
    ...(context.query !== undefined ? { query: context.query } : {}),
  })
  const scopedArchived =
    archivedCards.length === 0
      ? []
      : filterOverviewCards(archivedCards, {
          bucket: 'all',
          profileId: context.profileId ?? '',
          nodeId: context.nodeId ?? '',
          ...(context.query !== undefined ? { query: context.query } : {}),
        })
  const counts = {
    all: scoped.length,
    needs_attention: 0,
    running: 0,
    unread_done: 0,
    archived: scopedArchived.length,
  }
  for (const card of scoped) {
    if (card.bucket === 'needs_attention' || card.bucket === 'running' || card.bucket === 'unread_done') {
      counts[card.bucket] += 1
    }
  }
  return counts
}

/** 从卡片集提取可用角色筛选选项（去重，按卡片出现顺序）。 */
export function overviewProfileOptions(
  cards: ReadonlyArray<OverviewCard>,
): Array<{ id: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ id: string; label: string }> = []
  for (const card of cards) {
    if (seen.has(card.root.profileId)) continue
    seen.add(card.root.profileId)
    options.push({ id: card.root.profileId, label: card.profileLabel })
  }
  return options
}

/** 从卡片集提取可用节点筛选选项（去重，'local' 归一化聚合）。 */
export function overviewNodeOptions(cards: ReadonlyArray<OverviewCard>): string[] {
  const seen = new Set<string>()
  for (const card of cards) seen.add(overviewNodeKey(card.root))
  return [...seen]
}

/** 将已筛选的总览卡片按指定维度分组为纵向分节。 */
export function groupOverviewCards(
  cards: ReadonlyArray<OverviewCard>,
  groupBy: OverviewGroupBy,
  t: WebMessageTranslator,
): OverviewCardGroup[] {
  if (cards.length === 0) return []
  if (groupBy === 'status') {
    const byBucket = new Map<OverviewCardBucket, OverviewCard[]>()
    for (const card of cards) {
      let list = byBucket.get(card.bucket)
      if (list === undefined) {
        list = []
        byBucket.set(card.bucket, list)
      }
      list.push(card)
    }
    const groups: OverviewCardGroup[] = []
    for (const bucket of ORDERED_BUCKETS) {
      const bucketCards = byBucket.get(bucket)
      if (bucketCards === undefined || bucketCards.length === 0) continue
      groups.push({
        key: `bucket:${bucket}`,
        kind: 'bucket',
        bucket,
        label: t(BUCKET_SECTION_LABEL_KEYS[bucket]),
        cards: bucketCards,
      })
    }
    return groups
  }

  if (groupBy === 'profile') {
    const byProfile = new Map<string, OverviewCardGroup>()
    for (const card of cards) {
      const profileId = card.root.profileId
      let group = byProfile.get(profileId)
      if (group === undefined) {
        group = {
          key: `profile:${profileId}`,
          kind: 'profile',
          label: card.profileLabel || profileId,
          cards: [],
        }
        byProfile.set(profileId, group)
      }
      group.cards.push(card)
    }
    return [...byProfile.values()]
  }

  const byNode = new Map<string, OverviewCardGroup>()
  for (const card of cards) {
    const nodeKey = overviewNodeKey(card.root)
    let group = byNode.get(nodeKey)
    if (group === undefined) {
      group = {
        key: `node:${nodeKey}`,
        kind: 'node',
        nodeId: nodeKey,
        label: nodeKey === 'local' ? t('shell.overview.localNode') : nodeKey,
        cards: [],
      }
      byNode.set(nodeKey, group)
    }
    group.cards.push(card)
  }
  return [...byNode.values()]
}

/** 是否展示分组节头：单值筛选下直接平铺卡片，避免重复单节头。 */
export function overviewShouldShowSectionHeaders(
  filter: Pick<OverviewFilterState, 'groupBy' | 'bucket' | 'profileId' | 'nodeId'>,
): boolean {
  if (filter.groupBy === 'status' && filter.bucket !== 'all') return false
  if (filter.groupBy === 'profile' && filter.profileId !== '') return false
  if (filter.groupBy === 'node' && filter.nodeId !== '') return false
  return true
}

const OVERVIEW_DEFAULT_FILTER: OverviewFilterState = {
  bucket: 'all',
  profileId: '',
  nodeId: '',
  source: 'human',
  query: '',
  groupBy: 'status',
}

const VALID_BUCKET_FILTERS = new Set<string>(['needs_attention', 'running', 'unread_done', 'archived'])
const VALID_SOURCE_FILTERS = new Set<string>(['automated', 'all'])
const VALID_GROUP_BY = new Set<string>(['profile', 'node'])

/** 从 overview 目标参数解析筛选与分组状态。 */
export function parseOverviewFilterParams(params: Record<string, string> | undefined): OverviewFilterState {
  if (params === undefined) return OVERVIEW_DEFAULT_FILTER
  return {
    bucket: VALID_BUCKET_FILTERS.has(params.bucket ?? '') ? (params.bucket as OverviewBucketFilter) : 'all',
    profileId: params.profile ?? '',
    nodeId: params.node ?? '',
    source: VALID_SOURCE_FILTERS.has(params.source ?? '') ? (params.source as OverviewSourceFilter) : 'human',
    query: params.q ?? '',
    groupBy: VALID_GROUP_BY.has(params.group ?? '') ? (params.group as OverviewGroupBy) : 'status',
  }
}

/** 参数修复补丁：检测未知键与非法枚举值并返回应删除键。 */
export function overviewFilterParamsRepair(params: Record<string, string> | undefined): Record<string, undefined> | null {
  if (params === undefined) return null
  const deletions: Record<string, undefined> = {}
  let repairNeeded = false
  for (const key of Object.keys(params)) {
    if (!(OVERVIEW_FILTER_PARAM_KEYS as readonly string[]).includes(key)) {
      deletions[key] = undefined
      repairNeeded = true
      continue
    }
    const value = params[key] ?? ''
    if (key === 'bucket' && !VALID_BUCKET_FILTERS.has(value)) {
      deletions.bucket = undefined
      repairNeeded = true
    }
    if (key === 'source' && !VALID_SOURCE_FILTERS.has(value)) {
      deletions.source = undefined
      repairNeeded = true
    }
    if (key === 'group' && !VALID_GROUP_BY.has(value)) {
      deletions.group = undefined
      repairNeeded = true
    }
  }
  return repairNeeded ? deletions : null
}
