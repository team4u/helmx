/**
 * 会话总览纯函数层（零 React / DOM 依赖，可直接单测）。
 *
 * 复用态势模型的唯一树聚合口径（aggregateAttentionTrees：根树聚合、暴露
 * 边界、代表位、直达目标、后台聚合），在其上扩展「全部」视图需要的安静树，
 * 并提供 全部/需处理/进行中/未读 与 角色/节点 筛选。排序纪律与态势一致：
 * 桶序（需关注 > 运行中 > 未读完成 > 安静）内按 root.createdAt 倒序
 * （同刻 id 倒序），绝不用 updatedAt 防流式跳卡。只读视图：本层不产生任何
 * 副作用与编造事实，摘要复用 composeHonestTreeSummary。
 *
 * 灯位口径（与侧栏会话行通用统一）：卡面灯 = 根会话自身状态 + 树级后台
 * 在途聚合，经同一 resolveStatusLight 单灯裁决——representative 仅用于
 * 诚实摘要与桶位推导，绝不充当卡面灯位（防「侧栏空心蓝、总览无灯」的
 * 代表位/行语义分叉）。
 */

import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../shell/background-activity-model.js'
import {
  aggregateAttentionTrees,
  composeHonestTreeSummary,
  type AttentionBucket,
} from '../shell/attention-model.js'
import { ARCHIVED_TAG } from '../shell/sidebar-model.js'

/** 总览卡片桶：态势三桶 + 安静（无任何信号的树，仅出现在「全部」筛选）。 */
export type OverviewCardBucket = AttentionBucket | 'quiet'

/** 总览桶筛选值。 */
export type OverviewBucketFilter = 'all' | AttentionBucket

/** 总览来源筛选值：全部 / 常规对话 / 托管会话（托管 = 插件 sidebarSection 接管）。 */
export type OverviewSourceFilter = 'all' | 'regular' | 'managed'

/** 总览分组维度：按状态（默认）/ 按角色 / 按节点。 */
export type OverviewGroupBy = 'status' | 'profile' | 'node'

const CARD_BUCKET_ORDER: Record<OverviewCardBucket, number> = {
  needs_attention: 0,
  running: 1,
  unread_done: 2,
  quiet: 3,
}

const ORDERED_BUCKETS: readonly OverviewCardBucket[] = [
  'needs_attention',
  'running',
  'unread_done',
  'quiet',
]

const BUCKET_SECTION_LABEL_KEYS: Record<
  OverviewCardBucket,
  | 'shell.overview.sectionNeeds'
  | 'shell.overview.sectionRunning'
  | 'shell.overview.sectionUnread'
  | 'shell.overview.sectionQuiet'
> = {
  needs_attention: 'shell.overview.sectionNeeds',
  running: 'shell.overview.sectionRunning',
  unread_done: 'shell.overview.sectionUnread',
  quiet: 'shell.overview.sectionQuiet',
}

/** 分组后的总览分节：携带稳定 key（用于折叠态与 React key）、语义标签与同序卡片集。 */
export interface OverviewCardGroup {
  key: string
  kind: 'bucket' | 'profile' | 'node'
  bucket?: OverviewCardBucket
  nodeId?: string
  label: string
  cards: OverviewCard[]
}

/** 总览单卡：一棵根会话树的真实事实（只读展示）。 */
export interface OverviewCard {
  root: ConversationSummary
  bucket: OverviewCardBucket
  hasWaiting: boolean
  hasError: boolean
  /** 树内最高优先级状态代表，用于摘要。 */
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
  activeDescendantCount: number
  /** 点击直达目标（等待人类的最新会话，否则根）。 */
  targetConversationId: number
  profileLabel: string
  /** 诚实摘要（真实 lastError / doing / 后台摘要 / 后代运行计数）。 */
  summaryText: string
  /** 根会话已被插件 sidebarSection filterTag 接管（托管 / 后台 Worker 等）。 */
  managed: boolean
  /** 整棵子树成员 ID（含根；OVERVIEW_CARD_META_SLOT 插槽 props 输入）。 */
  memberIds: number[]
  /** 卡内后代会话芯片全量列表（按关注优先 + createdAt 倒序的确定性排序；
   * 视图层按 OVERVIEW_DESCENDANT_LIMIT 截断展示，展开时同序补齐剩余）。 */
  descendants: OverviewDescendant[]
  /** 按 OVERVIEW_DESCENDANT_LIMIT 截断后未展示的后代数。 */
  hiddenDescendantCount: number
}

/** 卡内后代会话芯片条目。 */
export interface OverviewDescendant {
  conv: ConversationSummary
  backgroundActive: boolean
}

/** 卡内后代芯片默认上限（超出折叠为「还有 N 个」）。 */
export const OVERVIEW_DESCENDANT_LIMIT = 5

/**
 * 构建总览卡片（全部根树，含安静树）：排序为桶序 + root.createdAt 倒序。
 * 后代芯片排序：有信号的（working/blocked/error/后台在途）优先，其后按
 * createdAt 倒序；`descendants` 携带全量确定性排序结果，卡内展示截断由
 * 视图层按 OVERVIEW_DESCENDANT_LIMIT 切片（展开后同序展示剩余后代，
 * 绝不重排），hiddenDescendantCount 如实给出被截断数量。
 * sectionTags（插件 sidebarSection filterTag 集合，与侧栏同源）存在时，
 * 根会话带任一非归档命中标签的树归为 managed（托管会话）。
 */
export function buildOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  /** Locale translator（摘要与后代计数文案）；缺省英文桥接。 */
  t?: WebMessageTranslator
  /** 插件 sidebarSection filterTag 集合（缺省时全部树视为常规会话）。 */
  sectionTags?: ReadonlySet<string>
}): OverviewCard[] {
  const t = input.t ?? englishWebTranslator
  const sectionTags = input.sectionTags
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))
  const cards: OverviewCard[] = []
  for (const aggregate of aggregateAttentionTrees(input)) {
    const descendantsAll = aggregate.members
      .filter((member) => member.id !== aggregate.root.id)
      .map((member) => ({
        member,
        signal:
          member.status === 'working' ||
          member.status === 'blocked' ||
          member.status === 'error' ||
          input.background.get(member.id)?.active === true ||
          member.pendingAskCount > 0,
      }))
      .sort((a, b) => {
        if (a.signal !== b.signal) return a.signal ? -1 : 1
        return b.member.createdAt - a.member.createdAt || b.member.id - a.member.id
      })
    cards.push({
      root: aggregate.root,
      bucket: aggregate.bucket ?? 'quiet',
      hasWaiting: aggregate.hasWaiting,
      hasError: aggregate.hasError,
      representative: aggregate.representative,
      backgroundActive: aggregate.backgroundActive,
      backgroundSummary: aggregate.backgroundSummary,
      activeDescendantCount: aggregate.activeDescendantCount,
      targetConversationId: aggregate.targetConversationId,
      profileLabel: profileNames.get(aggregate.root.profileId) ?? aggregate.root.profileId,
      summaryText: composeHonestTreeSummary({
        representative: aggregate.representative,
        backgroundActive: aggregate.backgroundActive,
        backgroundSummary: aggregate.backgroundSummary,
        activeDescendantCount: aggregate.activeDescendantCount,
        t,
      }),
      managed: sectionTags !== undefined && aggregate.root.tags.some((tag) => tag !== ARCHIVED_TAG && sectionTags.has(tag)),
      memberIds: aggregate.members.map((member) => member.id),
      descendants: descendantsAll.map((entry) => ({
        conv: entry.member,
        backgroundActive: input.background.get(entry.member.id)?.active === true,
      })),
      hiddenDescendantCount: Math.max(0, descendantsAll.length - OVERVIEW_DESCENDANT_LIMIT),
    })
  }
  return cards.sort(
    (a, b) =>
      CARD_BUCKET_ORDER[a.bucket] - CARD_BUCKET_ORDER[b.bucket] ||
      b.root.createdAt - a.root.createdAt ||
      b.root.id - a.root.id,
  )
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

/** 卡片是否命中标题/摘要搜索：根标题、角色标签、诚实摘要、后代标题做
 * 大小写不敏感子串匹配；纯数字或 #id 形态按会话号精确匹配（含后代）。 */
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
    if (card.descendants.some((descendant) => descendant.conv.id === wanted)) return true
    return false
  }
  return card.descendants.some((descendant) => descendant.conv.title.toLowerCase().includes(needle))
}

/**
 * 筛选总览卡片：桶（quiet 仅在 all）、角色、节点、来源、搜索五者 AND 组合；
 * 空串筛选值表示该维度不过滤，source 缺省 'all'、query 缺省空串不过滤。
 * 纯函数，供组件与测试共用。
 */
export function filterOverviewCards(
  cards: ReadonlyArray<OverviewCard>,
  filter: OverviewCardFilter,
): OverviewCard[] {
  return cards.filter((card) => {
    if (filter.bucket !== 'all' && card.bucket !== filter.bucket) return false
    if (filter.profileId !== '' && card.root.profileId !== filter.profileId) return false
    if (filter.nodeId !== '' && overviewNodeKey(card.root) !== filter.nodeId) return false
    if (filter.source === 'regular' && card.managed) return false
    if (filter.source === 'managed' && !card.managed) return false
    if (!overviewCardMatchesQuery(card, filter.query ?? '')) return false
    return true
  })
}

/**
 * 桶筛选计数（在角色/节点/来源/搜索上下文内统计）：分段器徽标展示
 * 「切到该桶后还剩几张卡」，避免全量计数与当前上下文错位造成误解；
 * all = 上下文过滤后的卡总数。
 */
export function overviewBucketCounts(
  cards: ReadonlyArray<OverviewCard>,
  context: { profileId?: string; nodeId?: string; source?: OverviewSourceFilter; query?: string } = {},
): { all: number; needs_attention: number; running: number; unread_done: number } {
  const scoped = filterOverviewCards(cards, {
    bucket: 'all',
    profileId: context.profileId ?? '',
    nodeId: context.nodeId ?? '',
    ...(context.source !== undefined ? { source: context.source } : {}),
    ...(context.query !== undefined ? { query: context.query } : {}),
  })
  const counts = { all: scoped.length, needs_attention: 0, running: 0, unread_done: 0 }
  for (const card of scoped) {
    if (card.bucket !== 'quiet') counts[card.bucket] += 1
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

/**
 * 将已筛选的总览卡片按指定维度分组为纵向分节：
 * - status：按 canonical 桶序（needs_attention > running > unread_done > quiet），空桶直接省略；
 * - profile：按卡片首次出现顺序建组（因卡片已按桶序 + createdAt 倒序排列，含活跃态势的
 *   角色自然置顶，且流式期间不跳组），组内保持原序；
 * - node：同上，按节点（'local' 归一本机）建组并保持组内原序。
 */
export function groupOverviewCards(
  cards: ReadonlyArray<OverviewCard>,
  groupBy: OverviewGroupBy,
  t: WebMessageTranslator = englishWebTranslator,
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

/**
 * 是否展示分组节头：当筛选器已经把当前分组维度收敛为单一值（如按状态分组且
 * 已选中具体单桶，或按角色/节点分组且已选中对应单值）时直接平铺卡片，避免
 * 重复包一层同义单节头。
 */
export function overviewShouldShowSectionHeaders(
  filter: Pick<OverviewFilterState, 'groupBy' | 'bucket' | 'profileId' | 'nodeId'>,
): boolean {
  if (filter.groupBy === 'status' && filter.bucket !== 'all') return false
  if (filter.groupBy === 'profile' && filter.profileId !== '') return false
  if (filter.groupBy === 'node' && filter.nodeId !== '') return false
  return true
}

// ---------------------------------------------------------------------------
// 路由参数（#/overview 的 sp. 与 ssp. 目标参数）：<bucket|profile|node|source|q|group>
// ---------------------------------------------------------------------------

/** 总览筛选与分组的目标参数键（接入唯一 URL Hash 导航模型的 sp.* 命名空间）。 */
export const OVERVIEW_FILTER_PARAM_KEYS = ['bucket', 'profile', 'node', 'source', 'q', 'group'] as const
export type OverviewFilterParamKey = (typeof OVERVIEW_FILTER_PARAM_KEYS)[number]

/** 筛选与分组的规范形态（全部取默认值时不携带任何参数键）。 */
export interface OverviewFilterState {
  bucket: OverviewBucketFilter
  profileId: string
  nodeId: string
  source: OverviewSourceFilter
  query: string
  groupBy: OverviewGroupBy
}

const OVERVIEW_DEFAULT_FILTER: OverviewFilterState = {
  bucket: 'all',
  profileId: '',
  nodeId: '',
  source: 'all',
  query: '',
  groupBy: 'status',
}

const VALID_BUCKET_FILTERS = new Set<string>(['needs_attention', 'running', 'unread_done'])
const VALID_SOURCE_FILTERS = new Set<string>(['regular', 'managed'])
const VALID_GROUP_BY = new Set<string>(['profile', 'node'])

/**
 * 从 overview 目标参数解析筛选与分组状态（深链/刷新/前进后退恢复的唯一入口）：
 * bucket/source/group 枚举值非法或取默认值时回退缺省（与 Hash 模型「非法段
 * 静默回退默认」同哲学）；profile/node/q 为任意非空字符串（空值已被 Hash
 * 模型丢弃），保留原值不私自裁剪。
 */
export function parseOverviewFilterParams(params: Record<string, string> | undefined): OverviewFilterState {
  if (params === undefined) return OVERVIEW_DEFAULT_FILTER
  return {
    bucket: VALID_BUCKET_FILTERS.has(params.bucket ?? '') ? (params.bucket as OverviewBucketFilter) : 'all',
    profileId: params.profile ?? '',
    nodeId: params.node ?? '',
    source: VALID_SOURCE_FILTERS.has(params.source ?? '') ? (params.source as OverviewSourceFilter) : 'all',
    query: params.q ?? '',
    groupBy: VALID_GROUP_BY.has(params.group ?? '') ? (params.group as OverviewGroupBy) : 'status',
  }
}

/**
 * 参数修复补丁：检测非规范参数（未知键、取默认值的冗余枚举、非法枚举值），
 * 返回应删除的键集合（值全为 undefined，经 setScreenParams 以 replace 修
 * 正地址栏）；参数已规范时返回 null 不产生写放大。
 */
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
