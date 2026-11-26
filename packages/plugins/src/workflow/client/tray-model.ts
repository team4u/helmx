/**
 * Active tray projection & worktree badge display helpers.
 */
import { DEFAULT_HELMX_LOCALE, type HelmxLocale } from '@helmx/plugin-client'
import { buildExecutionTree, type BuildExecutionTreeInput } from './execution-tree.js'
import {
  resolveNodeTitle,
  type ExecutionNode,
  type ExecutionNodeKind,
  type ExecutionStatus,
} from './status-model.js'

export interface ActiveTrayItem {
  key: string
  kind: ExecutionNodeKind
  title: string
  isFallbackTitle: boolean
  status: ExecutionStatus
  isWorking: boolean
  isBlocked: boolean
  conversationId?: number
  activityConversationId?: number
  runId?: string
  progress?: { done: number; total: number }
  doing?: string
  startedAt?: number
  pendingAskSince?: number
  canAbort: boolean
}

export interface ActiveTraySummary {
  items: ActiveTrayItem[]
  activeCount: number
  runningCount: number
  blockedCount: number
  earliestStartedAt?: number
  earliestPendingAskSince?: number
}

function isActiveNode(node: ExecutionNode): boolean {
  return (
    node.status === 'working' ||
    node.status === 'blocked' ||
    node.aggregated.running > 0 ||
    node.aggregated.blocked > 0 ||
    node.run?.status === 'running'
  )
}

function earliestPendingAskOf(node: ExecutionNode): number | undefined {
  let min: number | undefined
  const walk = (n: ExecutionNode): void => {
    const blocked = n.status === 'blocked' || n.summary?.status === 'blocked' || (n.summary?.pendingAskCount ?? 0) > 0
    const ts = blocked ? n.summary?.pendingAskSince : undefined
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && (min === undefined || ts < min)) min = ts
    for (const c of n.children) walk(c)
  }
  walk(node)
  return min
}

function deepestBlockedConvId(node: ExecutionNode): number | undefined {
  for (const child of node.children) {
    const deeper = deepestBlockedConvId(child)
    if (deeper !== undefined) return deeper
    if (child.status === 'blocked' && child.conversationId !== undefined) return child.conversationId
  }
  if (node.status === 'blocked' && node.conversationId !== undefined) return node.conversationId
  return undefined
}

function deepestActiveConvId(node: ExecutionNode): number | undefined {
  for (const child of node.children) {
    const deeper = deepestActiveConvId(child)
    if (deeper !== undefined) return deeper
    if (isActiveNode(child) && child.conversationId !== undefined) return child.conversationId
  }
  return undefined
}

/** Whether a branch string matches auto-generated managed spawn naming when metadata is absent. */
export function isManagedSpawnBranch(branch: string): boolean {
  return branch.startsWith('helmx/spawn-')
}

/** Prefer managed descriptor metadata (`id` / `baseCommit`) before falling back to generated branch names. */
export function isManagedWorktree(worktree: {
  id?: string
  baseCommit?: string
  branch: string
}): boolean {
  if (worktree.id !== undefined && worktree.id !== '') return true
  if (worktree.baseCommit !== undefined && worktree.baseCommit !== '') return true
  return isManagedSpawnBranch(worktree.branch)
}

export function buildActiveTraySummary(
  input: BuildExecutionTreeInput,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): ActiveTraySummary {
  const tree = buildExecutionTree(input)
  const activeNodes = tree.filter(isActiveNode)
  if (activeNodes.length === 0) {
    return { items: [], activeCount: 0, runningCount: 0, blockedCount: 0 }
  }

  let runningCount = 0
  let blockedCount = 0
  let earliestStartedAt: number | undefined
  let earliestPendingAskSince: number | undefined

  const items: ActiveTrayItem[] = activeNodes.map((node) => {
    const isBlocked = node.status === 'blocked' || node.aggregated.blocked > 0
    const isWorking = node.status === 'working' || node.aggregated.running > 0 || node.run?.status === 'running'
    if (isBlocked) blockedCount++
    if (isWorking) runningCount++

    const startedAt = node.run?.createdAt ?? node.runNode?.startedAt ?? node.summary?.runStartedAt
    if (startedAt !== undefined && startedAt > 0 && (earliestStartedAt === undefined || startedAt < earliestStartedAt)) {
      earliestStartedAt = startedAt
    }
    const pendingAskSince = isBlocked ? earliestPendingAskOf(node) : undefined
    if (pendingAskSince !== undefined && (earliestPendingAskSince === undefined || pendingAskSince < earliestPendingAskSince)) {
      earliestPendingAskSince = pendingAskSince
    }

    const resolvedTitle = resolveNodeTitle(
      {
        kind: node.kind,
        conversationId: node.conversationId,
        summary: node.summary,
        run: node.run,
        runNode: node.runNode,
      },
      locale,
    )

    const runNodes = node.kind === 'workflow' ? node.run?.nodes : undefined
    const progress =
      runNodes !== undefined && runNodes.length > 0
        ? {
            done: runNodes.filter((n) => n.status === 'done').length,
            total: runNodes.length,
          }
        : node.children.length > 1
          ? {
              done: node.children.filter((c) => c.status === 'done' || c.status === 'error' || c.status === 'aborted').length,
              total: node.children.length,
            }
          : undefined

    const selfActive = node.status === 'working' || node.status === 'blocked'
    const activityConversationId = isBlocked
      ? deepestBlockedConvId(node) ?? deepestActiveConvId(node) ?? node.conversationId
      : node.conversationId !== undefined && selfActive
        ? node.conversationId
        : deepestActiveConvId(node) ?? node.conversationId

    const doing = selfActive ? node.summary?.doing?.trim() || undefined : undefined

    return {
      key: node.key,
      kind: node.kind,
      title: resolvedTitle.text,
      isFallbackTitle: resolvedTitle.isFallback,
      status: isBlocked ? 'blocked' : isWorking ? 'working' : node.aggregated.status,
      isWorking,
      isBlocked,
      ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
      ...(activityConversationId !== undefined ? { activityConversationId } : {}),
      ...(node.run !== undefined ? { runId: node.run.id } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(doing !== undefined ? { doing } : {}),
      ...(startedAt !== undefined && startedAt > 0 ? { startedAt } : {}),
      ...(pendingAskSince !== undefined ? { pendingAskSince } : {}),
      canAbort: node.run?.status === 'running',
    }
  })

  return {
    items,
    activeCount: items.length,
    runningCount,
    blockedCount,
    ...(earliestStartedAt !== undefined ? { earliestStartedAt } : {}),
    ...(earliestPendingAskSince !== undefined ? { earliestPendingAskSince } : {}),
  }
}
