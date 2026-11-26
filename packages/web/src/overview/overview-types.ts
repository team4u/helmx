/**
 * Leaf domain types and constants shared across overview cards, filters,
 * timing helpers, and the sidebar working set.
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { AttentionBucket } from '../shell/attention-model.js'

/** 总览卡片桶：态势三桶 + 安静 + 已归档（已归档独立在 archived 筛选页，不混入「全部」）。 */
export type OverviewCardBucket = AttentionBucket | 'quiet' | 'archived'

/** 总览桶筛选值。 */
export type OverviewBucketFilter = 'all' | AttentionBucket | 'archived'

/** 总览来源筛选值：人类对话（默认）/ 自动化会话（顶层 ownedBy === 'helmx'）/ 全部。 */
export type OverviewSourceFilter = 'human' | 'automated' | 'all'

/** 总览分组维度：按状态（默认）/ 按角色 / 按节点。 */
export type OverviewGroupBy = 'status' | 'profile' | 'node'

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
  summaryText: string
  /** 是否为顶层自动化会话（root.ownedBy === 'helmx'；决定自动化标识、来源筛选与只读动作保护）。 */
  automated: boolean
  /** 整棵根会话树的全部成员 ID（含根与所有子/孙会话）。 */
  memberIds: number[]
  /** 全部非根后代会话（先有信号后安静、再 createdAt 倒序），供芯片渲染与展开。 */
  descendants: OverviewDescendant[]
  /** 直接挂在根会话下的一跳子会话：侧栏工作集按一级子行渲染，并携带其各自子树统计。 */
  directDescendants: OverviewDescendant[]
  /** 超出 OVERVIEW_DESCENDANT_LIMIT 被收起的后代数量。 */
  hiddenDescendantCount: number
}

/** 卡内单条后代会话条目。 */
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
