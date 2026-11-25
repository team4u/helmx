/**
 * Pure timing derivations for builtin:swarm client surfaces (delegates elapsed math to @helmx/plugin-client).
 */
import type { ConversationStatus, ConversationSummary } from '@helmx/protocol/browser'
import {
  DEFAULT_HELMX_LOCALE, formatCompactTimestamp, formatDurationMs, formatOffsetMs, formatStopwatchMs,
  resolveConversationTiming, type ConversationTimingSnapshot, type HelmxLocale,
} from '@helmx/plugin-client'
import type { BoardMemberView, BoardViewDoc, CollabGroupStatus } from './board-model.ts'
import * as C from './copy.ts'

export interface MemberTimingFields {
  runDurationMs?: number; runStartedAt?: number; pendingAskSince?: number; pendingAskCount?: number; turnCount?: number
}
export interface MemberTimingInput extends MemberTimingFields {
  liveState: BoardMemberView['liveState']; lifecycle?: BoardMemberView['lifecycle']; createdAt?: number
}
export interface GroupTimingView { label: string; tooltip: string; membersTotalRunMs?: number }
export interface TrayMemberTimingView { label: string; tooltip: string; isWarn: boolean }
export interface PanelMemberTimingView { label: string; tooltip: string; tone: 'warn' | 'live' | 'settled' }
export interface PostTimeDisplay { label: string; fullTimestamp: string }

export function extractMemberTimingFields(
  member: BoardMemberView,
  summary: ConversationSummary | undefined,
  groupStatus: CollabGroupStatus,
): MemberTimingFields {
  const isSettled = groupStatus === 'closed' || member.lifecycle === 'archived'
  const runDurationMs = member.runDurationMs ?? summary?.runDurationMs
  if (isSettled) {
    const turnCount = member.turnCount ?? (summary && summary.completionSeq > 0 ? summary.completionSeq : undefined)
    return { ...(runDurationMs !== undefined ? { runDurationMs } : {}), ...(turnCount !== undefined ? { turnCount } : {}) }
  }
  const runStartedAt = member.runStartedAt ?? summary?.runStartedAt
  const pendingAskSince = member.pendingAskSince ?? summary?.pendingAskSince
  const pendingAskCount = summary && summary.pendingAskCount > 0 ? summary.pendingAskCount : undefined
  const turnCount = member.turnCount ?? summary?.completionSeq
  return {
    ...(runDurationMs !== undefined ? { runDurationMs } : {}),
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    ...(pendingAskSince !== undefined ? { pendingAskSince } : {}),
    ...(pendingAskCount !== undefined ? { pendingAskCount } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  }
}

export function resolveMemberTimingSnapshot(
  member: MemberTimingInput,
  options: { isSettled: boolean; nowMs?: number },
): ConversationTimingSnapshot {
  const { isSettled, nowMs } = options
  const status: ConversationStatus = isSettled
    ? (member.liveState === 'done' || member.liveState === 'error' ? member.liveState : 'idle')
    : (member.liveState === 'missing' ? 'idle' : member.liveState)
  return resolveConversationTiming(
    {
      status,
      ...(member.runDurationMs !== undefined ? { runDurationMs: member.runDurationMs } : {}),
      ...(!isSettled && member.runStartedAt !== undefined ? { runStartedAt: member.runStartedAt } : {}),
      ...(!isSettled && member.pendingAskSince !== undefined ? { pendingAskSince: member.pendingAskSince } : {}),
      ...(!isSettled && member.pendingAskCount && member.pendingAskCount > 0 ? { pendingAskCount: member.pendingAskCount } : {}),
    },
    isSettled ? undefined : nowMs,
  )
}

function buildMemberTooltip(
  timing: ConversationTimingSnapshot,
  input: Pick<MemberTimingInput, 'turnCount' | 'createdAt'>,
  order: 'tray' | 'panel',
  locale: HelmxLocale,
): string {
  const lines: string[] = []
  if (timing.waitingMs !== undefined) lines.push(C.timingTooltipWaiting(formatStopwatchMs(timing.waitingMs), locale))
  const totalText = timing.totalRunMs !== undefined ? (timing.isRunning ? formatStopwatchMs(timing.totalRunMs) : formatDurationMs(timing.totalRunMs)) : ''
  const curLine = timing.currentRunMs !== undefined ? C.timingTooltipCurrentTurn(formatStopwatchMs(timing.currentRunMs), locale) : undefined
  const totLine = totalText ? C.timingTooltipCumulativeRun(totalText, locale) : undefined
  if (order === 'tray') {
    if (curLine) lines.push(curLine)
    if (totLine) lines.push(totLine)
  } else {
    if (totLine) lines.push(totLine)
    if (curLine) lines.push(curLine)
  }
  if (input.turnCount !== undefined) lines.push(C.timingTooltipTurns(input.turnCount, locale))
  if (order === 'panel' && input.createdAt !== undefined && Number.isFinite(input.createdAt) && input.createdAt > 0) {
    lines.push(C.timingTooltipJoinedAt(formatCompactTimestamp(input.createdAt), locale))
  }
  return lines.join('\n')
}

export function resolveGroupTimingView(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
  nowMs: number | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): GroupTimingView | undefined {
  const { group } = view
  if (!Number.isFinite(group.createdAt) || group.createdAt <= 0) return undefined

  let label = ''
  let closedTs: number | undefined
  if (group.status === 'closed') {
    const endAt = group.closedAt && Number.isFinite(group.closedAt) && group.closedAt > 0 ? group.closedAt : group.updatedAt
    if (!Number.isFinite(endAt) || endAt < group.createdAt) return undefined
    label = formatDurationMs(endAt - group.createdAt)
    closedTs = endAt
  } else {
    if (nowMs === undefined || !Number.isFinite(nowMs)) return undefined
    label = formatStopwatchMs(Math.max(0, nowMs - group.createdAt))
  }
  if (!label) return undefined

  const byId = new Map(conversations.map((c) => [c.id, c]))
  let membersTotalRunMs = 0
  let hasMemberRun = false
  let hasRunning = false
  for (const m of view.members) {
    const isSettled = group.status === 'closed' || m.lifecycle === 'archived'
    const timing = resolveMemberTimingSnapshot(
      { ...extractMemberTimingFields(m, byId.get(m.conversationId), group.status), liveState: m.liveState, lifecycle: m.lifecycle, createdAt: m.createdAt },
      { isSettled, nowMs },
    )
    if (timing.totalRunMs !== undefined) { membersTotalRunMs += timing.totalRunMs; hasMemberRun = true }
    if (timing.isRunning && timing.currentRunMs !== undefined) hasRunning = true
  }

  const lines = [C.timingTooltipEndToEnd(label, locale)]
  if (hasMemberRun) {
    const totalText = hasRunning ? formatStopwatchMs(membersTotalRunMs) : formatDurationMs(membersTotalRunMs)
    if (totalText) lines.push(C.timingTooltipMembersTotal(totalText, locale))
  }
  lines.push(C.timingTooltipCreatedAt(formatCompactTimestamp(group.createdAt), locale))
  if (group.status === 'closed' && closedTs && closedTs > 0) lines.push(C.timingTooltipClosedAt(formatCompactTimestamp(closedTs), locale))
  return { label, tooltip: lines.join('\n'), ...(hasMemberRun ? { membersTotalRunMs } : {}) }
}

export function resolveTrayMemberTimingView(
  item: MemberTimingInput,
  nowMs: number | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): TrayMemberTimingView | undefined {
  const timing = resolveMemberTimingSnapshot(item, { isSettled: false, nowMs })
  let label: string | undefined
  let isWarn = false
  if (timing.isBlocked && timing.waitingMs !== undefined) {
    const w = formatStopwatchMs(timing.waitingMs)
    if (w) { label = C.timingWaitingLabel(w, locale); isWarn = true }
  } else if (timing.isRunning && timing.currentRunMs !== undefined) {
    label = formatStopwatchMs(timing.currentRunMs) || undefined
  }
  return label ? { label, tooltip: buildMemberTooltip(timing, item, 'tray', locale), isWarn } : undefined
}

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

  if (!isSettled && timing.isBlocked && timing.waitingMs !== undefined) {
    const w = formatStopwatchMs(timing.waitingMs)
    if (w) {
      label = timing.totalRunMs && timing.totalRunMs > 0 ? C.timingWaitingWithTotalLabel(w, formatStopwatchMs(timing.totalRunMs), locale) : C.timingWaitingLabel(w, locale)
      tone = 'warn'
    }
  } else if (!isSettled && (timing.isBlocked || timing.isRunning) && timing.currentRunMs !== undefined) {
    const cur = formatStopwatchMs(timing.currentRunMs)
    if (cur) {
      label = timing.settledRunMs > 0 ? C.timingTurnWithTotalLabel(cur, formatStopwatchMs(timing.totalRunMs ?? timing.settledRunMs + timing.currentRunMs), locale) : cur
      tone = 'live'
    }
  } else if (timing.settledRunMs > 0) {
    label = formatDurationMs(timing.settledRunMs)
  }

  return label ? { label, tooltip: buildMemberTooltip(timing, row, 'panel', locale), tone } : undefined
}

export function resolvePostTimeDisplay(postCreatedAt: number, groupCreatedAt: number): PostTimeDisplay | undefined {
  if (!Number.isFinite(postCreatedAt) || postCreatedAt <= 0) return undefined
  const fullTimestamp = formatCompactTimestamp(postCreatedAt)
  const delta = Number.isFinite(groupCreatedAt) && groupCreatedAt > 0 ? postCreatedAt - groupCreatedAt : -1
  return { label: (delta >= 0 ? formatOffsetMs(delta) : '') || fullTimestamp, fullTimestamp }
}
