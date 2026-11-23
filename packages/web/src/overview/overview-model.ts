/**
 * 会话总览纯函数层（零 React / DOM 依赖，可直接单测）。
 *
 * 复用态势模型的唯一树聚合口径（aggregateAttentionTrees：根树聚合、暴露
 * 边界、代表位、直达目标、后台聚合），在其上扩展「全部」视图需要的安静树、
 * 「已归档」治理卡片与侧栏工作集切片，并提供 全部/需处理/进行中/未读/已归档
 * 与角色/节点/来源/搜索筛选。排序纪律：
 * - 总览大盘：桶序（需关注 > 运行中 > 未读完成 > 安静）内按 root.createdAt 倒序
 *   （同刻 id 倒序），绝不用 updatedAt 防流式跳卡；已归档同样按 createdAt 倒序；
 * - 侧栏工作集：活跃三桶全量展示（不截断、createdAt 倒序不跳行），安静近期区按
 *   updatedAt 倒序取前 SIDEBAR_RECENT_QUIET_LIMIT 条并对当前主/分屏在场会话保底。
 *
 * 灯位口径（与侧栏会话行通用统一）：卡面灯 = 根会话自身状态 + 树级后台
 * 在途聚合，经同一 resolveStatusLight 单灯裁决——representative 仅用于
 * 诚实摘要与桶位推导，绝不充当卡面灯位。
 */

import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { PluginActivityLike } from '../lib/live-state.js'
import type { ConversationBackgroundIndex } from '../shell/background-activity-model.js'
import { resolveNotificationRootId } from '../shell/quiet-notify-model.js'
import {
  buildAgentStandings,
  collectEnabledPluginIds,
  isProfileVisible,
  type AgentStanding,
  type AgentStandingsInput,
} from '../shell/sidebar-model.js'
import {
  aggregateAttentionTrees,
  composeHonestTreeSummary,
  type AttentionBucket,
} from '../shell/attention-model.js'

/** 总览卡片桶：态势三桶 + 安静 + 已归档（已归档独立在 archived 筛选页，不混入「全部」）。 */
export type OverviewCardBucket = AttentionBucket | 'quiet' | 'archived'

/** 总览桶筛选值。 */
export type OverviewBucketFilter = 'all' | AttentionBucket | 'archived'

/** 总览来源筛选值：人类对话（默认）/ 自动化会话（顶层 ownedBy === 'helmx'）/ 全部。 */
export type OverviewSourceFilter = 'human' | 'automated' | 'all'

/** 总览分组维度：按状态（默认）/ 按角色 / 按节点。 */
export type OverviewGroupBy = 'status' | 'profile' | 'node'

const CARD_BUCKET_ORDER: Record<OverviewCardBucket, number> = {
  needs_attention: 0,
  running: 1,
  unread_done: 2,
  quiet: 3,
  archived: 4,
}

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
  /** 根会话是否为系统自动化会话（顶层 ownedBy === 'helmx'，如定时任务/Webhook 后台运行）。 */
  automated: boolean
  /** 整棵子树成员 ID（含根；OVERVIEW_CARD_META_SLOT 插槽 props 输入）。 */
  memberIds: number[]
  /** 卡内后代会话全量事实（按关注优先 + createdAt 倒序）；展示层可改用直属投影。 */
  descendants: OverviewDescendant[]
  /** 根会话的直属子会话，作为导航视图的稳定主干。 */
  directDescendants: OverviewDescendant[]
  /** 按 OVERVIEW_DESCENDANT_LIMIT 截断后未展示的后代数。 */
  hiddenDescendantCount: number
}

/** 卡内后代会话芯片条目。 */
export interface OverviewDescendant {
  conv: ConversationSummary
  backgroundActive: boolean
  direct?: boolean
  subtreeActiveCount?: number
  subtreeErrorCount?: number
  subtreeWaitingCount?: number
  subtreeDescendantCount?: number
  subtreeConversationIds?: number[]
}

/** 卡内后代芯片默认上限（超出折叠为「还有 N 个」）。 */
export const OVERVIEW_DESCENDANT_LIMIT = 5

/** 侧栏最多自动透出的异常/当前后代行数。 */
export const SIDEBAR_DESCENDANT_AUTO_LIMIT = 3

/** 侧栏工作集「近期」安静根会话默认上限（活跃三桶永不截断，当前在场安静树保底显示）。 */
export const SIDEBAR_RECENT_QUIET_LIMIT = 8

/** 侧栏工作集按角色/节点分组时，每个分组独立保留的近期安静会话默认上限。 */
export const SIDEBAR_PER_GROUP_QUIET_LIMIT = 5

/** 侧栏工作集分组维度 localStorage 持久化键。 */
export const SIDEBAR_GROUP_BY_STORAGE_KEY = 'helmx:sidebar-group-by'

/** 读取持久化的侧栏分组维度（非法值或不可用存储静默回退 'status'）。 */
export function loadSidebarGroupBy(storage?: Pick<Storage, 'getItem'> | null): OverviewGroupBy {
  try {
    const store = storage === undefined
      ? (typeof window !== 'undefined' ? window.localStorage : null)
      : storage
    const raw = store?.getItem(SIDEBAR_GROUP_BY_STORAGE_KEY)
    if (raw === 'profile' || raw === 'node' || raw === 'status') return raw
    return 'status'
  } catch {
    return 'status'
  }
}

/** 持久化侧栏分组维度（私有模式/配额异常静默忽略）。 */
export function saveSidebarGroupBy(
  groupBy: OverviewGroupBy,
  storage?: Pick<Storage, 'setItem'> | null,
): OverviewGroupBy {
  try {
    const store = storage === undefined
      ? (typeof window !== 'undefined' ? window.localStorage : null)
      : storage
    store?.setItem(SIDEBAR_GROUP_BY_STORAGE_KEY, groupBy)
  } catch {
    // Ignore storage quota or private-mode access errors.
  }
  return groupBy
}

/** 判断单条后代会话是否带有活跃或需关注信号（working / blocked / error / 待答 Ask / 后台在途）。 */
export function isOverviewDescendantActive(descendant: OverviewDescendant): boolean {
  const { conv, backgroundActive } = descendant
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    conv.status === 'error' ||
    backgroundActive ||
    conv.pendingAskCount > 0
  )
}

function sortOverviewDescendants(
  members: ReadonlyArray<ConversationSummary>,
  rootId: number,
  background: ConversationBackgroundIndex,
): OverviewDescendant[] {
  const byId = new Map(members.map((member) => [member.id, member] as const))
  const byParent = new Map<number, ConversationSummary[]>()
  for (const member of members) {
    if (member.parentConversationId === undefined) continue
    const siblings = byParent.get(member.parentConversationId)
    if (siblings === undefined) byParent.set(member.parentConversationId, [member])
    else siblings.push(member)
  }

  const makeEntry = (member: ConversationSummary): OverviewDescendant => ({
    conv: member,
    backgroundActive: background.get(member.id)?.active === true,
  })
  const directChildren = byParent.get(rootId) ?? []
  const directIds = new Set(directChildren.map((child) => child.id))
  const directEntries = directChildren.map((member) => {
    const subtree = new Set<number>()
    const queue = [member.id]
    let subtreeActiveCount = 0
    let subtreeErrorCount = 0
    let subtreeWaitingCount = 0
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!
      if (subtree.has(current)) continue
      subtree.add(current)
      const candidate = byId.get(current)
      if (candidate !== undefined) {
        if (candidate.status === 'error') subtreeErrorCount += 1
        if (candidate.status === 'blocked' || candidate.pendingAskCount > 0) subtreeWaitingCount += 1
        if (candidate.status === 'working' || candidate.status === 'blocked' || background.get(candidate.id)?.active === true) {
          subtreeActiveCount += 1
        }
      }
      for (const child of byParent.get(current) ?? []) queue.push(child.id)
    }
    return {
      ...makeEntry(member),
      direct: true,
      subtreeActiveCount,
      subtreeErrorCount,
      subtreeWaitingCount,
      subtreeDescendantCount: Math.max(0, subtree.size - 1),
      subtreeConversationIds: [...subtree],
    }
  })
  const deeperEntries = members
    .filter((member) => member.id !== rootId && !directIds.has(member.id))
    .map(makeEntry)
  const allEntries = [...directEntries, ...deeperEntries]
  allEntries.sort((a, b) => {
    const aSignal = isOverviewDescendantActive(a)
    const bSignal = isOverviewDescendantActive(b)
    if (aSignal !== bSignal) return aSignal ? -1 : 1
    return b.conv.createdAt - a.conv.createdAt || b.conv.id - a.conv.id
  })
  return allEntries
}

/**
 * 构建总览卡片（全部未归档根树，含安静树）：排序为桶序 + root.createdAt 倒序。
 * 后代芯片排序：有信号的（working/blocked/error/后台在途）优先，其后按
 * createdAt 倒序；`descendants` 携带全量确定性排序结果，卡内展示截断由
 * 视图层按 OVERVIEW_DESCENDANT_LIMIT 切片（展开后同序展示剩余后代，
 * 绝不重排），hiddenDescendantCount 如实给出被截断数量。
 */
export function buildOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
  /** 当前正在查看的会话 ID（透传给 aggregateAttentionTrees 做 unread_done 乐观已读）。 */
  viewedConversationIds?: ReadonlySet<number>
  /** Locale translator（摘要与后代计数文案）；缺省英文桥接。 */
  t?: WebMessageTranslator
}): OverviewCard[] {
  const t = input.t ?? englishWebTranslator
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))
  const cards: OverviewCard[] = []
  for (const aggregate of aggregateAttentionTrees(input)) {
    const descendants = sortOverviewDescendants(aggregate.members, aggregate.root.id, input.background)
    const directDescendants = [...descendants.filter((descendant) => descendant.direct === true)].sort((a, b) =>
      ((b.subtreeErrorCount ?? 0) > 0 || (b.subtreeWaitingCount ?? 0) > 0 ? 1 : (b.subtreeActiveCount ?? 0) > 0 ? 0 : -1) -
        ((a.subtreeErrorCount ?? 0) > 0 || (a.subtreeWaitingCount ?? 0) > 0 ? 1 : (a.subtreeActiveCount ?? 0) > 0 ? 0 : -1) ||
      a.conv.createdAt - b.conv.createdAt ||
      a.conv.id - b.conv.id,
    )
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
        root: aggregate.root,
        backgroundActive: aggregate.backgroundActive,
        backgroundSummary: aggregate.backgroundSummary,
        activeDescendantCount: aggregate.activeDescendantCount,
        t,
      }),
      automated: aggregate.root.ownedBy === 'helmx',
      memberIds: aggregate.members.map((member) => member.id),
      descendants,
      directDescendants,
      hiddenDescendantCount: Math.max(0, descendants.length - OVERVIEW_DESCENDANT_LIMIT),
    })
  }
  return cards.sort(
    (a, b) =>
      CARD_BUCKET_ORDER[a.bucket] - CARD_BUCKET_ORDER[b.bucket] ||
      b.root.createdAt - a.root.createdAt ||
      b.root.id - a.root.id,
  )
}

/**
 * 构建「已归档」总览卡片（仅收人类自有已归档根会话树，沿用同源 Profile 可见性边界）：
 * - 有父链 / 非 human 归属 / 所属 Profile 被已停用或失败插件托管的会话绝不进入；
 * - 保留子树成员与后代芯片（默认折叠为「N 个子会话」）；
 * - 按 root.createdAt 倒序（同刻 id 倒序），供 `#/overview?sp.bucket=archived` 治理与批量恢复/删除。
 */
export function buildArchivedOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
}): OverviewCard[] {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as const),
  )
  const enabledPluginIds = collectEnabledPluginIds(input.plugins)
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))

  const trees = new Map<number, ConversationSummary[]>()
  for (const conversation of input.conversations) {
    const rootId = resolveNotificationRootId(byId, conversation.id)
    const members = trees.get(rootId)
    if (members) members.push(conversation)
    else trees.set(rootId, [conversation])
  }

  const cards: OverviewCard[] = []
  for (const [rootId, members] of trees) {
    const root = byId.get(rootId)
    if (root === undefined) continue
    if (!isConversationArchived(root)) continue
    if (root.parentConversationId !== undefined) continue
    if ((root.ownedBy ?? 'human') !== 'human') continue
    const rootProfile = input.profiles.find((profile) => profile.id === root.profileId)
    if (rootProfile !== undefined && !isProfileVisible(rootProfile, enabledPluginIds)) continue

    const descendants = sortOverviewDescendants(members, root.id, input.background)
    const directDescendants = descendants.filter((descendant) => descendant.direct === true)
    cards.push({
      root,
      bucket: 'archived',
      hasWaiting: false,
      hasError: false,
      representative: root,
      backgroundActive: false,
      backgroundSummary: '',
      activeDescendantCount: 0,
      targetConversationId: root.id,
      profileLabel: profileNames.get(root.profileId) ?? root.profileId,
      summaryText: '',
      automated: false,
      memberIds: members.map((member) => member.id),
      descendants,
      directDescendants,
      hiddenDescendantCount: Math.max(0, descendants.length - OVERVIEW_DESCENDANT_LIMIT),
    })
  }
  return cards.sort((a, b) => b.root.createdAt - a.root.createdAt || b.root.id - a.root.id)
}

/**
 * 推导「新话题」候选角色列表（全屏总览与侧栏工作集共用）：
 * 仅保留人类可新建对话的可见角色，最近活跃的未归档根会话所属角色置顶，
 * 其余按站位 order 与 profileId 字典序稳定排列。
 */
export function buildNewTopicCandidates(input: AgentStandingsInput): AgentStanding[] {
  const standings = buildAgentStandings(input)
  const creatable = standings.filter((standing) => standing.canCreateConversation)
  const latestRootProfileId =
    input.conversations
      .filter(
        (c) =>
          c.parentConversationId === undefined &&
          !isConversationArchived(c) &&
          (c.ownedBy ?? 'human') === 'human',
      )
      .reduce<ConversationSummary | null>(
        (best, c) =>
          best === null || c.updatedAt > best.updatedAt || (c.updatedAt === best.updatedAt && c.id > best.id)
            ? c
            : best,
        null,
      )?.profileId ?? null
  return [...creatable].sort((a, b) => {
    if (a.profileId === latestRootProfileId) return -1
    if (b.profileId === latestRootProfileId) return 1
    return a.order - b.order || a.profileId.localeCompare(b.profileId)
  })
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
    return card.descendants.some((descendant) => descendant.conv.id === wanted)
  }
  return card.descendants.some((descendant) => overviewDescendantMatchesQuery(descendant, needle))
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
    if (filter.source === 'human' && card.automated) return false
    if (filter.source === 'automated' && !card.automated) return false
    if (!overviewCardMatchesQuery(card, filter.query ?? '')) return false
    return true
  })
}

/**
 * 桶筛选计数（在角色/节点/来源/搜索上下文内统计）：分段器徽标展示
 * 「切到该桶后还剩几张卡」，避免全量计数与当前上下文错位造成误解；
 * all = 未归档上下文过滤后的卡总数；archived = 已归档在同角色/节点/搜索上下文内的卡数。
 */
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

/**
 * 将已筛选的总览卡片按指定维度分组为纵向分节：
 * - status：按 canonical 桶序（needs_attention > running > unread_done > quiet > archived），空桶直接省略；
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
 * 已选中具体单桶含 archived，或按角色/节点分组且已选中对应单值）时直接平铺卡片，避免
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
  source: 'human',
  query: '',
  groupBy: 'status',
}

const VALID_BUCKET_FILTERS = new Set<string>(['needs_attention', 'running', 'unread_done', 'archived'])
const VALID_SOURCE_FILTERS = new Set<string>(['automated', 'all'])
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
    source: VALID_SOURCE_FILTERS.has(params.source ?? '') ? (params.source as OverviewSourceFilter) : 'human',
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

// ---------------------------------------------------------------------------
// 时间观测纯函数（零定时器编排、零排序扰动、缺起点绝不编造）
// ---------------------------------------------------------------------------

/** 单卡时间观测派生快照。 */
export interface OverviewCardTiming {
  /** `needs_attention` 且有等待人类会话时的已等待耗时（ms；取树内最早 pendingAskSince）。 */
  waitingMs?: number
  /** `running` 桶的当前运行耗时（ms；根在途取根 runStartedAt，否则取活跃后代最早 runStartedAt）。 */
  runningMs?: number
  /** `unread_done` / `quiet` / `archived` 桶的根累计已结算运行耗时（ms；仅 > 0 时存在）。 */
  settledRunMs?: number
}

/** 活跃后代芯片时间观测快照（仅 working / blocked 且具备起点锚时存在）。 */
export interface OverviewDescendantChipTiming {
  kind: 'waiting' | 'running'
  elapsedMs: number
}

function isNonNegativeFiniteTime(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function hasPositivePendingAskCount(conv: Pick<ConversationSummary, 'pendingAskCount'>): boolean {
  return typeof conv.pendingAskCount === 'number' && Number.isFinite(conv.pendingAskCount) && conv.pendingAskCount > 0
}

function waitingAnchorOf(conv: Pick<ConversationSummary, 'status' | 'pendingAskCount' | 'pendingAskSince'>): number | undefined {
  const hasPendingAsk = hasPositivePendingAskCount(conv)
  const isBlocked = conv.status === 'blocked' || hasPendingAsk
  if (!isBlocked) return undefined
  if (conv.pendingAskCount !== undefined && !hasPendingAsk) return undefined
  return isNonNegativeFiniteTime(conv.pendingAskSince) ? conv.pendingAskSince : undefined
}

/** 树内最早 pendingAskSince（仅 `needs_attention` 且 `hasWaiting` 卡片有效；缺省不编造）。 */
export function resolveOverviewCardWaitingSince(card: OverviewCard): number | undefined {
  if (card.bucket !== 'needs_attention' || !card.hasWaiting) return undefined
  let earliest: number | undefined
  const check = (conv: ConversationSummary): void => {
    const anchor = waitingAnchorOf(conv)
    if (anchor === undefined) return
    earliest = earliest === undefined ? anchor : Math.min(earliest, anchor)
  }
  check(card.root)
  for (const descendant of card.descendants) check(descendant.conv)
  return earliest
}

/** `running` 卡片的运行起点锚：根在途取根 `runStartedAt`，否则取活跃后代最早 `runStartedAt`（缺省不编造）。 */
export function resolveOverviewCardRunStartedAt(card: OverviewCard): number | undefined {
  if (card.bucket !== 'running') return undefined
  if (card.root.status === 'working' && isNonNegativeFiniteTime(card.root.runStartedAt)) {
    return card.root.runStartedAt
  }
  let earliest: number | undefined
  for (const descendant of card.descendants) {
    if (descendant.conv.status !== 'working') continue
    if (!isNonNegativeFiniteTime(descendant.conv.runStartedAt)) continue
    earliest = earliest === undefined ? descendant.conv.runStartedAt : Math.min(earliest, descendant.conv.runStartedAt)
  }
  return earliest
}

/** 活跃后代芯片的秒表起点锚：blocked 优先取 pendingAskSince，working 取 runStartedAt，安静芯片无锚。 */
function resolveOverviewDescendantChipAnchor(
  descendant: OverviewDescendant,
): { kind: 'waiting' | 'running'; since: number } | undefined {
  const waitingSince = waitingAnchorOf(descendant.conv)
  if (waitingSince !== undefined) return { kind: 'waiting', since: waitingSince }
  if (descendant.conv.status === 'working' && isNonNegativeFiniteTime(descendant.conv.runStartedAt)) {
    return { kind: 'running', since: descendant.conv.runStartedAt }
  }
  return undefined
}

/** 派生单卡时间观测快照（不读 Date.now，SSR 安全且完全确定）。 */
export function resolveOverviewCardTiming(card: OverviewCard, nowMs?: number): OverviewCardTiming {
  const hasNow = isNonNegativeFiniteTime(nowMs)
  if (card.bucket === 'needs_attention' && card.hasWaiting) {
    const since = resolveOverviewCardWaitingSince(card)
    return since !== undefined && hasNow ? { waitingMs: Math.max(0, nowMs - since) } : {}
  }
  if (card.bucket === 'running') {
    const since = resolveOverviewCardRunStartedAt(card)
    return since !== undefined && hasNow ? { runningMs: Math.max(0, nowMs - since) } : {}
  }
  if (card.bucket === 'unread_done' || card.bucket === 'quiet' || card.bucket === 'archived') {
    const runDurationMs = card.root.runDurationMs
    return typeof runDurationMs === 'number' && Number.isFinite(runDurationMs) && runDurationMs > 0
      ? { settledRunMs: runDurationMs }
      : {}
  }
  return {}
}

/** 派生单枚后代芯片的实时秒表（安静或缺少起点时返回 undefined）。 */
export function resolveOverviewDescendantChipTiming(
  descendant: OverviewDescendant,
  nowMs?: number,
): OverviewDescendantChipTiming | undefined {
  if (!isNonNegativeFiniteTime(nowMs)) return undefined
  const anchor = resolveOverviewDescendantChipAnchor(descendant)
  if (anchor === undefined) return undefined
  return { kind: anchor.kind, elapsedMs: Math.max(0, nowMs - anchor.since) }
}

/** 判断当前可见卡片（含当前展开可见的后代芯片）是否存在至少一个需要秒表的条目；全员安静/完成时返回 false（零定时器）。 */
export function overviewCardsNeedLiveClock(
  cards: ReadonlyArray<OverviewCard>,
  expandedCardIds?: ReadonlySet<number>,
): boolean {
  for (const card of cards) {
    if (resolveOverviewCardWaitingSince(card) !== undefined) return true
    if (resolveOverviewCardRunStartedAt(card) !== undefined) return true
    const expanded = expandedCardIds?.has(card.root.id) === true
    const collapseByDefault = card.bucket === 'quiet' || card.bucket === 'archived'
    const shownDescendants = expanded
      ? card.descendants
      : collapseByDefault
        ? []
        : card.descendants.slice(0, OVERVIEW_DESCENDANT_LIMIT)
    for (const descendant of shownDescendants) {
      if (resolveOverviewDescendantChipAnchor(descendant) !== undefined) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// 侧栏工作集纯函数（活跃全量 + 近期截断/在场保底、后代展示切片、直达裁决与秒表门控）
// ---------------------------------------------------------------------------

/** 侧栏工作集切片结果。 */
export interface SidebarWorkingSet {
  /** 侧栏应展示的根会话树集合（非搜索态：活跃全量 + 近期截断与在场保底；搜索态：全量命中）。 */
  cards: OverviewCard[]
  /** 全量未归档根会话树总数（供底部「查看全部 N 个会话」入口展示）。 */
  totalRootCount: number
  /** 被近期上限省略的安静根会话树数量（搜索态或未超限时为 0）。 */
  omittedQuietCount: number
  /** 当前是否处于搜索态（搜索突破工作集上限）。 */
  searchActive: boolean
}

function cardMatchesActiveConversation(
  card: OverviewCard,
  activeConversationIds: ReadonlySet<number>,
): boolean {
  if (activeConversationIds.has(card.root.id)) return true
  return card.descendants.some((descendant) => activeConversationIds.has(descendant.conv.id))
}

/**
 * 构建侧栏工作集切片：
 * - 搜索激活时直接检索全量未归档根树，不受近期上限限制；
 * - 默认工作集态：
 *   1) 活跃三桶（needs_attention / running / unread_done）全量保留、顺序沿用 createdAt 倒序（流式不跳行）；
 *   2) 安静根树（quiet）按 updatedAt 倒序（同刻 createdAt / id 倒序）取前 recentLimit 条，
 *      确保刚聊完的会话自然置顶；
 *   3) 若主屏或分屏当前正在查看超出前 recentLimit 条的安静根树（或其后代），保底追加到工作集末尾，
 *      防止正在查看的会话在侧栏中失踪。
 */
export function buildSidebarWorkingSet(input: {
  cards: ReadonlyArray<OverviewCard>
  activeConversationIds: ReadonlySet<number>
  query?: string
  recentLimit?: number
}): SidebarWorkingSet {
  const { cards, activeConversationIds, query = '', recentLimit = SIDEBAR_RECENT_QUIET_LIMIT } = input
  // Keep the left sidebar conversation working set strictly dedicated to human root trees;
  // automated top-level sessions (cron/webhook/background jobs) live in Overview's Automated view
  // and their owning plugin manager screens.
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

/** 侧栏工作集分组项（统一覆盖按状态 / 按角色 / 按节点三种维度）。 */
export interface SidebarWorkingSetGroup extends OverviewCardGroup {
  /** 角色分组时的 Profile ID。 */
  profileId?: string
  /** 角色分组时是否允许人类直接在该角色下开新话题（决定组头 + 按钮）。 */
  canCreateConversation?: boolean
  /** 该分组在截断前的完整根会话数。 */
  totalGroupCount: number
}

/** 侧栏工作集按维度分组结果。 */
export interface SidebarGroupedWorkingSet {
  groups: SidebarWorkingSetGroup[]
  /** 全量未归档人类根会话树总数（供底部「查看全部 N 个会话」展示）。 */
  totalRootCount: number
  /** 被近期上限省略的安静根会话树总数。 */
  omittedQuietCount: number
  /** 当前是否处于搜索态（搜索突破近期上限）。 */
  searchActive: boolean
}

/**
 * 构建侧栏工作集分组切片（按状态 / 按角色 / 按节点）：
 * - 按状态：完全复用 buildSidebarWorkingSet（全局近期上限 + 在场保底）再按四桶分节；
 * - 按角色：先按可见角色归组再在各组内独立截取近期安静会话（避免某个高频角色挤掉其他角色），
 *   保留 0 会话的可创建可见角色以还原智能体站位体验；
 * - 按节点：先按运行节点归组（活跃节点优先）再在各组内独立截取近期安静会话；
 * - 搜索激活时三种模式均突破近期上限，仅返回命中会话的分组。
 */
export function buildSidebarGroupedWorkingSet(input: {
  groupBy: OverviewGroupBy
  cards: ReadonlyArray<OverviewCard>
  activeConversationIds: ReadonlySet<number>
  agentStandings?: ReadonlyArray<AgentStanding>
  query?: string
  recentLimit?: number
  perGroupQuietLimit?: number
  t?: WebMessageTranslator
}): SidebarGroupedWorkingSet {
  const {
    groupBy,
    cards,
    activeConversationIds,
    agentStandings,
    query = '',
    recentLimit = SIDEBAR_RECENT_QUIET_LIMIT,
    perGroupQuietLimit = SIDEBAR_PER_GROUP_QUIET_LIMIT,
    t = englishWebTranslator,
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

  // groupBy === 'node'
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
  /** 当前应渲染为缩进子行的后代列表（沿用 card.descendants 的确定性排序）。 */
  visible: OverviewDescendant[]
  /** 仍收拢在折叠开关后的安静后代数。 */
  hiddenCount: number
  /** 是否存在可手动展开/收起的安静后代（全为自动浮现的活跃后代时无需渲染多余开关）。 */
  hasCollapsibleQuiet: boolean
}

/**
 * 解析侧栏工作集中单棵树的子行切片：
 * - 侧栏只渲染直属子会话，孙级事实聚合到直属子行；
 * - 默认只透出当前查看项与最高优先级异常，且有硬上限；
 * - 手动展开后展示全部直属子会话，绝不在窄栏递归铺开深层树。
 */
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
  const visible = expanded ? ranked : autoVisible.slice(0, SIDEBAR_DESCENDANT_AUTO_LIMIT)
  return {
    visible,
    hiddenCount: Math.max(0, ranked.length - visible.length),
    hasCollapsibleQuiet: ranked.length > 0,
  }
}

/**
 * 侧栏工作集主项点击直达目标裁决：
 * - 当树内存在等待审批的子会话且该子会话已作为独立子行展现在下方时，
 *   主项固定打开根会话（父行进父、子行进子，避免进了审批子会话后点不回根会话）；
 * - 否则回落 card.targetConversationId（一键直达待审批现场或根会话）。
 */
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

/**
 * 侧栏工作集实时秒表门控：仅检查当前可见（未折叠分节）卡片及其可见子行，
 * 全员安静/已完成或所在分节被折叠时返回 false（零定时器开销）。
 */
export function sidebarOverviewCardsNeedLiveClock(
  cards: ReadonlyArray<OverviewCard>,
  visibleDescendantsByRoot: ReadonlyMap<number, ReadonlyArray<OverviewDescendant>>,
): boolean {
  for (const card of cards) {
    if (resolveOverviewCardWaitingSince(card) !== undefined) return true
    if (resolveOverviewCardRunStartedAt(card) !== undefined) return true
    const visibleDescendants = visibleDescendantsByRoot.get(card.root.id)
    if (visibleDescendants !== undefined) {
      for (const descendant of visibleDescendants) {
        if (resolveOverviewDescendantChipAnchor(descendant) !== undefined) return true
      }
    }
  }
  return false
}
