/**
 * Pure timing derivations for builtin:swarm client surfaces (zero React/DOM
 * dependencies, Fast Refresh compliant).
 *
 * Consumes `BoardMemberView` timing fields with active fallback to host
 * `ConversationSummary` snapshots and delegates honest elapsed arithmetic to
 * `@helmx/plugin-client`'s `resolveConversationTiming`.
 */
import type { ConversationStatus, ConversationSummary } from '@helmx/protocol'
import {
  DEFAULT_HELMX_LOCALE,
  formatCompactTimestamp,
  formatDurationMs,
  formatOffsetMs,
  formatStopwatchMs,
  resolveConversationTiming,
  type ConversationTimingSnapshot,
  type HelmxLocale,
} from '@helmx/plugin-client'
import type { BoardMemberView, BoardViewDoc, CollabGroupStatus } from './board-model.ts'
import {
  timingTooltipClosedAt,
  timingTooltipCreatedAt,
  timingTooltipCumulativeRun,
  timingTooltipCurrentTurn,
  timingTooltipEndToEnd,
  timingTooltipJoinedAt,
  timingTooltipMembersTotal,
  timingTooltipTurns,
  timingTooltipWaiting,
  timingTurnWithTotalLabel,
  timingWaitingLabel,
  timingWaitingWithTotalLabel,
} from './copy.ts'

export interface MemberTimingFields {
  runDurationMs?: number
  runStartedAt?: number
  pendingAskSince?: number
  pendingAskCount?: number
  turnCount?: number
}

export interface MemberTimingInput extends MemberTimingFields {
  liveState: BoardMemberView['liveState']
  lifecycle?: BoardMemberView['lifecycle']
  createdAt?: number
}

export interface GroupTimingView {
  /** Compact wall-clock elapsed display (`formatStopwatchMs` when active, frozen `formatDurationMs` when closed). */
  label: string
  /** Multi-line Tooltip breakdown (end-to-end, summed member runtime, createdAt, optional closedAt). */
  tooltip: string
  /** Summed cumulative member run duration in ms when at least one member recorded runtime. */
  membersTotalRunMs?: number
}

export interface TrayMemberTimingView {
  label: string
  tooltip: string
  isWarn: boolean
}

export interface PanelMemberTimingView {
  label: string
  tooltip: string
  tone: 'warn' | 'live' | 'settled'
}

export interface PostTimeDisplay {
  /** Relative offset from group start (`+MM:SS` / `+H:MM:SS`), or compact timestamp fallback when invalid/<0. */
  label: string
  /** Full compact timestamp (`MM-DD HH:mm:ss`) for tooltip. */
  fullTimestamp: string
}

/** Merge `BoardMemberView` timing fields with optional live `ConversationSummary` fallback. */
export function extractMemberTimingFields(
  member: BoardMemberView,
  summary: ConversationSummary | undefined,
  groupStatus: CollabGroupStatus,
): MemberTimingFields {
  const isSettled = groupStatus === 'closed' || member.lifecycle === 'archived'
  const runDurationMs = member.runDurationMs ?? summary?.runDurationMs
  if (isSettled) {
    const turnCount =
      member.turnCount ?? (summary !== undefined && summary.completionSeq > 0 ? summary.completionSeq : undefined)
    return {
      ...(runDurationMs !== undefined ? { runDurationMs } : {}),
      ...(turnCount !== undefined ? { turnCount } : {}),
    }
  }
  const runStartedAt = member.runStartedAt ?? summary?.runStartedAt
  const pendingAskSince = member.pendingAskSince ?? summary?.pendingAskSince
  const pendingAskCount =
    summary !== undefined && summary.pendingAskCount > 0 ? summary.pendingAskCount : undefined
  const turnCount = member.turnCount ?? (summary !== undefined ? summary.completionSeq : undefined)
  return {
    ...(runDurationMs !== undefined ? { runDurationMs } : {}),
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    ...(pendingAskSince !== undefined ? { pendingAskSince } : {}),
    ...(pendingAskCount !== undefined ? { pendingAskCount } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  }
}

/** Resolve an honest `ConversationTimingSnapshot` for a swarm member. */
export function resolveMemberTimingSnapshot(
  member: MemberTimingInput,
  options: { isSettled: boolean; nowMs?: number },
): ConversationTimingSnapshot {
  const { isSettled, nowMs } = options
  const status: ConversationStatus = isSettled
    ? member.liveState === 'done' || member.liveState === 'error'
      ? member.liveState
      : 'idle'
    : member.liveState === 'missing'
      ? 'idle'
      : member.liveState
  return resolveConversationTiming(
    {
      status,
      ...(member.runDurationMs !== undefined ? { runDurationMs: member.runDurationMs } : {}),
      ...(!isSettled && member.runStartedAt !== undefined ? { runStartedAt: member.runStartedAt } : {}),
      ...(!isSettled && member.pendingAskSince !== undefined ? { pendingAskSince: member.pendingAskSince } : {}),
      ...(!isSettled && member.pendingAskCount !== undefined && member.pendingAskCount > 0
        ? { pendingAskCount: member.pendingAskCount }
        : {}),
    },
    isSettled ? undefined : nowMs,
  )
}

/**
 * Derive the collaboration group's total elapsed display and Tooltip breakdown:
 * - active group: live whole-second stopwatch `formatStopwatchMs(max(0, nowMs - createdAt))`;
 * - closed group: frozen `formatDurationMs((closedAt ?? updatedAt) - createdAt)` (never vanishes after close).
 */
export function resolveGroupTimingView(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
  nowMs: number | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): GroupTimingView | undefined {
  const { group } = view
  if (!Number.isFinite(group.createdAt) || group.createdAt <= 0) return undefined

  let label = ''
  let closedTimestamp: number | undefined
  if (group.status === 'closed') {
    const endAt =
      group.closedAt !== undefined && Number.isFinite(group.closedAt) && group.closedAt > 0
        ? group.closedAt
        : group.updatedAt
    if (!Number.isFinite(endAt) || endAt < group.createdAt) return undefined
    label = formatDurationMs(endAt - group.createdAt)
    closedTimestamp = endAt
  } else {
    if (nowMs === undefined || !Number.isFinite(nowMs)) return undefined
    label = formatStopwatchMs(Math.max(0, nowMs - group.createdAt))
  }
  if (label === '') return undefined

  const summaryById = new Map<number, ConversationSummary>()
  for (const conv of conversations) summaryById.set(conv.id, conv)

  let membersTotalRunMs = 0
  let hasMemberRun = false
  let hasRunningMember = false
  for (const member of view.members) {
    const isSettled = group.status === 'closed' || member.lifecycle === 'archived'
    const fields = extractMemberTimingFields(member, summaryById.get(member.conversationId), group.status)
    const timing = resolveMemberTimingSnapshot(
      { ...fields, liveState: member.liveState, lifecycle: member.lifecycle, createdAt: member.createdAt },
      { isSettled, nowMs },
    )
    if (timing.totalRunMs !== undefined) {
      membersTotalRunMs += timing.totalRunMs
      hasMemberRun = true
    }
    if (timing.isRunning && timing.currentRunMs !== undefined) {
      hasRunningMember = true
    }
  }

  const tooltipLines: string[] = [timingTooltipEndToEnd(label, locale)]
  if (hasMemberRun) {
    const membersTotalText = hasRunningMember
      ? formatStopwatchMs(membersTotalRunMs)
      : formatDurationMs(membersTotalRunMs)
    if (membersTotalText !== '') {
      tooltipLines.push(timingTooltipMembersTotal(membersTotalText, locale))
    }
  }
  tooltipLines.push(timingTooltipCreatedAt(formatCompactTimestamp(group.createdAt), locale))
  if (group.status === 'closed' && closedTimestamp !== undefined && closedTimestamp > 0) {
    tooltipLines.push(timingTooltipClosedAt(formatCompactTimestamp(closedTimestamp), locale))
  }

  return {
    label,
    tooltip: tooltipLines.join('\n'),
    ...(hasMemberRun ? { membersTotalRunMs } : {}),
  }
}

/** Derive compact in-flight worker timing display & Tooltip breakdown for `SwarmTrayRow`. */
export function resolveTrayMemberTimingView(
  item: MemberTimingInput,
  nowMs: number | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): TrayMemberTimingView | undefined {
  const timing = resolveMemberTimingSnapshot(item, { isSettled: false, nowMs })
  let label: string | undefined
  let isWarn = false

  if (timing.isBlocked && timing.waitingMs !== undefined) {
    const waitText = formatStopwatchMs(timing.waitingMs)
    if (waitText !== '') {
      label = timingWaitingLabel(waitText, locale)
      isWarn = true
    }
  } else if (timing.isRunning && timing.currentRunMs !== undefined) {
    const runText = formatStopwatchMs(timing.currentRunMs)
    if (runText !== '') {
      label = runText
    }
  }

  if (label === undefined) return undefined

  const tooltipLines: string[] = []
  if (timing.waitingMs !== undefined) {
    tooltipLines.push(timingTooltipWaiting(formatStopwatchMs(timing.waitingMs), locale))
  }
  if (timing.currentRunMs !== undefined) {
    tooltipLines.push(timingTooltipCurrentTurn(formatStopwatchMs(timing.currentRunMs), locale))
  }
  if (timing.totalRunMs !== undefined) {
    const totalText = timing.isRunning
      ? formatStopwatchMs(timing.totalRunMs)
      : formatDurationMs(timing.totalRunMs)
    if (totalText !== '') {
      tooltipLines.push(timingTooltipCumulativeRun(totalText, locale))
    }
  }
  if (item.turnCount !== undefined) {
    tooltipLines.push(timingTooltipTurns(item.turnCount, locale))
  }

  return {
    label,
    tooltip: tooltipLines.join('\n'),
    isWarn,
  }
}

/**
 * Derive workbench panel member timing display & Tooltip breakdown:
 * - blocked: `等待审批 <waiting>` (+ `· 累计 <total>` when totalRunMs > 0);
 * - working: first turn (`settledRunMs === 0`) deduplicates to `<current>`; multi-turn shows `本轮 <current> · 累计 <total>`;
 * - idle / done / error / archived: frozen `formatDurationMs(settledRunMs)` only when `settledRunMs > 0` (omits 0).
 */
export function resolvePanelMemberTimingView(
  row: MemberTimingInput,
  groupStatus: CollabGroupStatus,
  nowMs: number | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): PanelMemberTimingView | undefined {
  const isSettled = groupStatus === 'closed' || row.lifecycle === 'archived'
  const timing = resolveMemberTimingSnapshot(row, { isSettled, nowMs })

  let label: string | undefined
  let tone: PanelMemberTimingView['tone'] = 'settled'

  if (!isSettled && timing.isBlocked) {
    if (timing.waitingMs !== undefined) {
      const waitText = formatStopwatchMs(timing.waitingMs)
      if (waitText !== '') {
        label =
          timing.totalRunMs !== undefined && timing.totalRunMs > 0
            ? timingWaitingWithTotalLabel(waitText, formatStopwatchMs(timing.totalRunMs), locale)
            : timingWaitingLabel(waitText, locale)
        tone = 'warn'
      }
    } else if (timing.currentRunMs !== undefined) {
      const curText = formatStopwatchMs(timing.currentRunMs)
      if (curText !== '') {
        label =
          timing.settledRunMs > 0
            ? timingTurnWithTotalLabel(
                curText,
                formatStopwatchMs(timing.totalRunMs ?? timing.settledRunMs + timing.currentRunMs),
                locale,
              )
            : curText
        tone = 'live'
      }
    } else if (timing.settledRunMs > 0) {
      label = formatDurationMs(timing.settledRunMs)
      tone = 'settled'
    }
  } else if (!isSettled && timing.isRunning) {
    if (timing.currentRunMs !== undefined) {
      const curText = formatStopwatchMs(timing.currentRunMs)
      if (curText !== '') {
        label =
          timing.settledRunMs > 0
            ? timingTurnWithTotalLabel(
                curText,
                formatStopwatchMs(timing.totalRunMs ?? timing.settledRunMs + timing.currentRunMs),
                locale,
              )
            : curText
        tone = 'live'
      }
    } else if (timing.settledRunMs > 0) {
      label = formatDurationMs(timing.settledRunMs)
      tone = 'settled'
    }
  } else if (timing.settledRunMs > 0) {
    label = formatDurationMs(timing.settledRunMs)
    tone = 'settled'
  }

  if (label === undefined || label === '') return undefined

  const tooltipLines: string[] = []
  if (timing.waitingMs !== undefined) {
    tooltipLines.push(timingTooltipWaiting(formatStopwatchMs(timing.waitingMs), locale))
  }
  if (timing.totalRunMs !== undefined) {
    const totalText = timing.isRunning
      ? formatStopwatchMs(timing.totalRunMs)
      : formatDurationMs(timing.totalRunMs)
    if (totalText !== '') {
      tooltipLines.push(timingTooltipCumulativeRun(totalText, locale))
    }
  }
  if (timing.currentRunMs !== undefined) {
    tooltipLines.push(timingTooltipCurrentTurn(formatStopwatchMs(timing.currentRunMs), locale))
  }
  if (row.turnCount !== undefined) {
    tooltipLines.push(timingTooltipTurns(row.turnCount, locale))
  }
  if (row.createdAt !== undefined && Number.isFinite(row.createdAt) && row.createdAt > 0) {
    tooltipLines.push(timingTooltipJoinedAt(formatCompactTimestamp(row.createdAt), locale))
  }

  return {
    label,
    tooltip: tooltipLines.join('\n'),
    tone,
  }
}

/** Resolve board post header relative offset (`+MM:SS` / `+H:MM:SS`) with compact timestamp fallback. */
export function resolvePostTimeDisplay(
  postCreatedAt: number,
  groupCreatedAt: number,
): PostTimeDisplay | undefined {
  if (!Number.isFinite(postCreatedAt) || postCreatedAt <= 0) return undefined
  const fullTimestamp = formatCompactTimestamp(postCreatedAt)
  const delta =
    Number.isFinite(groupCreatedAt) && groupCreatedAt > 0
      ? postCreatedAt - groupCreatedAt
      : -1
  const offset = delta >= 0 ? formatOffsetMs(delta) : ''
  return {
    label: offset !== '' ? offset : fullTimestamp,
    fullTimestamp,
  }
}
