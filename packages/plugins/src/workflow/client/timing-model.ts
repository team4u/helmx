/**
 * Single unified timing extractor for workflow runs, nodes, and subagent rows.
 */
import { resolveConversationTiming } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
import type { ExecutionStatus } from './status-model.js'

export interface WorkflowTimingSummary {
  wallElapsedMs?: number
  nodeTotalDurationMs?: number
  measuredNodeCount: number
  startedAt?: number
  settledAt?: number
}

export function resolveRunElapsedMs(run: WorkflowRunSummary, nowMs?: number): number | undefined {
  if (!Number.isFinite(run.createdAt) || run.createdAt <= 0) return undefined
  if (run.status === 'running') {
    return nowMs !== undefined && Number.isFinite(nowMs) && nowMs >= run.createdAt ? nowMs - run.createdAt : undefined
  }
  const endAt = run.settledAt ?? run.updatedAt
  return Number.isFinite(endAt) && endAt >= run.createdAt ? endAt - run.createdAt : undefined
}

export function resolveNodeElapsedMs(node: WorkflowNodeState, nowMs?: number): number | undefined {
  if (node.status === 'running') {
    if (node.startedAt !== undefined && nowMs !== undefined && nowMs >= node.startedAt) {
      return nowMs - node.startedAt
    }
    return undefined
  }
  if (node.durationMs !== undefined && Number.isFinite(node.durationMs) && node.durationMs >= 0) {
    return node.durationMs
  }
  if (node.startedAt !== undefined && node.settledAt !== undefined && node.settledAt >= node.startedAt) {
    return node.settledAt - node.startedAt
  }
  return undefined
}

export function summarizeWorkflowTiming(run: WorkflowRunSummary, nowMs?: number): WorkflowTimingSummary {
  const wallElapsedMs = resolveRunElapsedMs(run, nowMs)
  let nodeTotal = 0
  let measured = 0
  for (const node of run.nodes ?? []) {
    const ms = resolveNodeElapsedMs(node, nowMs)
    if (ms !== undefined) {
      nodeTotal += ms
      measured++
    }
  }
  return {
    ...(wallElapsedMs !== undefined ? { wallElapsedMs } : {}),
    ...(measured > 0 ? { nodeTotalDurationMs: nodeTotal } : {}),
    measuredNodeCount: measured,
    ...(run.createdAt > 0 ? { startedAt: run.createdAt } : {}),
    ...(run.status !== 'running' && (run.settledAt ?? run.updatedAt) > 0
      ? { settledAt: run.settledAt ?? run.updatedAt }
      : {}),
  }
}

export function resolveSubagentElapsedMs(input: {
  backgroundRun?: WorkflowRunSummary
  summary?: ConversationSummary
  startedAt?: number
  durationMs?: number
  nowMs?: number
  status: ExecutionStatus
  isBackgroundHandle?: boolean
}): number | undefined {
  if (input.status === 'working' || input.status === 'blocked') {
    const start = input.backgroundRun?.status === 'running' ? input.backgroundRun.createdAt : input.startedAt
    if (start !== undefined && Number.isFinite(start)) {
      return input.nowMs !== undefined && input.nowMs >= start ? input.nowMs - start : undefined
    }
    if (input.backgroundRun === undefined && input.summary !== undefined) {
      const t = resolveConversationTiming(input.summary, input.nowMs)
      return input.status === 'blocked' || t.isBlocked ? (t.currentRunMs ?? t.waitingMs) : t.currentRunMs
    }
    return undefined
  }
  if (input.backgroundRun !== undefined) {
    const nodeDur = input.backgroundRun.nodes?.[0]?.durationMs
    if (input.backgroundRun.status === 'running') {
      return nodeDur !== undefined && nodeDur >= 0 ? nodeDur : undefined
    }
    return nodeDur ?? resolveRunElapsedMs(input.backgroundRun, input.nowMs)
  }
  if (input.isBackgroundHandle === true) return undefined
  return input.durationMs !== undefined && input.durationMs >= 0 ? input.durationMs : undefined
}
