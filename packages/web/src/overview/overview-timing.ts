/**
 * Pure overview card and descendant-chip stopwatch timing derivation helpers.
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { OverviewCard, OverviewDescendant } from './overview-types.js'

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
export function resolveOverviewDescendantChipAnchor(
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

export const DEFAULT_OVERVIEW_SEARCH_DEBOUNCE_MS = 180
let overviewSearchDebounceMs = DEFAULT_OVERVIEW_SEARCH_DEBOUNCE_MS

/** 读取总览搜索框 URL 参数同步防抖时间（生产默认 180ms；测试可缩短）。 */
export function getOverviewSearchDebounceMs(): number {
  return overviewSearchDebounceMs
}

/** 临时覆盖总览搜索框防抖时间（供测试加速）。 */
export function patchOverviewSearchDebounceMs(ms: number): void {
  overviewSearchDebounceMs = ms
}

/** 恢复总览搜索框默认防抖时间（180ms）。 */
export function resetOverviewSearchDebounceMs(): void {
  overviewSearchDebounceMs = DEFAULT_OVERVIEW_SEARCH_DEBOUNCE_MS
}
