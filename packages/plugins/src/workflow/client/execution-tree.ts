/**
 * Unified execution tree builder (rooted strictly in `runs`).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WorkflowRunSummary } from '../../contracts-types.js'
import {
  STATUS_PRIORITY,
  aggregateStatuses,
  statusFromConversation,
  statusFromRun,
  statusFromRunNode,
  type ExecutionAggregate,
  type ExecutionNode,
  type ExecutionStatus,
} from './status-model.js'

function finalizeNode(node: Omit<ExecutionNode, 'aggregated'>): ExecutionNode {
  const selfCounts = !(node.children.length > 0 && node.kind === 'workflow')
  let total = selfCounts ? 1 : 0
  let done = selfCounts && node.status === 'done' ? 1 : 0
  let running = selfCounts && node.status === 'working' ? 1 : 0
  let blocked = selfCounts && node.status === 'blocked' ? 1 : 0
  let error = selfCounts && node.status === 'error' ? 1 : 0
  let aborted = selfCounts && node.status === 'aborted' ? 1 : 0
  const statuses: ExecutionStatus[] = [node.status]
  for (const child of node.children) {
    total += child.aggregated.total
    done += child.aggregated.done
    running += child.aggregated.running
    blocked += child.aggregated.blocked
    error += child.aggregated.error
    aborted += child.aggregated.aborted
    statuses.push(child.aggregated.status)
  }
  return {
    ...node,
    aggregated: { status: aggregateStatuses(statuses), total, done, running, blocked, error, aborted },
  }
}

export function aggregateExecutionNodes(nodes: ReadonlyArray<ExecutionNode>): ExecutionAggregate {
  let total = 0
  let done = 0
  let running = 0
  let blocked = 0
  let error = 0
  let aborted = 0
  const statuses: ExecutionStatus[] = []
  for (const n of nodes) {
    total += n.aggregated.total
    done += n.aggregated.done
    running += n.aggregated.running
    blocked += n.aggregated.blocked
    error += n.aggregated.error
    aborted += n.aggregated.aborted
    statuses.push(n.aggregated.status)
  }
  return { status: aggregateStatuses(statuses), total, done, running, blocked, error, aborted }
}

function isStrongerOwner(candidate: WorkflowRunSummary, current: WorkflowRunSummary, preferredCallId?: string): boolean {
  const cRun = candidate.status === 'running'
  const kRun = current.status === 'running'
  if (cRun !== kRun) return cRun
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  if (preferredCallId) {
    const cMatch = candidate.parentToolCallId === preferredCallId
    const kMatch = current.parentToolCallId === preferredCallId
    if (cMatch !== kMatch) return cMatch
  }
  return candidate.id > current.id
}

export function buildLeafNodesForRun(run: WorkflowRunSummary): ExecutionNode[] {
  return (run.nodes ?? []).map((node) =>
    finalizeNode({
      key: `node:${run.id}:${node.id}`,
      kind: node.kind === 'action' ? 'action' : 'agent',
      ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
      run,
      runNode: node,
      label: node.label,
      status: statusFromRunNode(node),
      updatedAt: run.updatedAt,
      children: [],
    }),
  )
}

export interface BuildExecutionTreeInput {
  rootConversationId: number
  conversations: ReadonlyArray<ConversationSummary>
  runs?: ReadonlyArray<WorkflowRunSummary>
}

export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  if (runs.length === 0) return []

  const convById = new Map<number, ConversationSummary>()
  const convByParentCall = new Map<string, ConversationSummary>()
  for (const c of conversations) {
    convById.set(c.id, c)
    if (c.parentConversationId !== undefined && c.parentToolCallId) {
      convByParentCall.set(`${c.parentConversationId}\0${c.parentToolCallId}`, c)
    }
  }

  const seenRunIds = new Set<string>()
  const runsByParent = new Map<number, WorkflowRunSummary[]>()
  const dslConvOwner = new Map<number, WorkflowRunSummary>()
  const dslClaimedByParent = new Map<number, Set<number>>()
  const subagentClaimsByParent = new Map<number, Map<number, WorkflowRunSummary[]>>()
  const subagentClaimedRunIds = new Set<string>()

  for (const run of runs) {
    if (seenRunIds.has(run.id)) continue
    seenRunIds.add(run.id)
    const bucket = runsByParent.get(run.conversationId)
    if (bucket) bucket.push(run)
    else runsByParent.set(run.conversationId, [run])

    if (run.kind === 'subagent') {
      const nodes = run.nodes ?? []
      const claimedIds = nodes.map((n) => n.conversationId).filter((id): id is number => id !== undefined)
      if (claimedIds.length === 0 && nodes.every((n) => n.executionId === undefined) && run.parentToolCallId) {
        const byCall = convByParentCall.get(`${run.conversationId}\0${run.parentToolCallId}`)
        if (byCall !== undefined) claimedIds.push(byCall.id)
      }
      if (claimedIds.length > 0) {
        subagentClaimedRunIds.add(run.id)
        let byConv = subagentClaimsByParent.get(run.conversationId)
        if (!byConv) {
          byConv = new Map()
          subagentClaimsByParent.set(run.conversationId, byConv)
        }
        for (const id of claimedIds) {
          const list = byConv.get(id)
          if (list) list.push(run)
          else byConv.set(id, [run])
        }
      }
    } else {
      let claimed = dslClaimedByParent.get(run.conversationId)
      if (!claimed) {
        claimed = new Set()
        dslClaimedByParent.set(run.conversationId, claimed)
      }
      for (const node of run.nodes ?? []) {
        if (node.conversationId === undefined) continue
        claimed.add(node.conversationId)
        const prev = dslConvOwner.get(node.conversationId)
        if (prev === undefined || isStrongerOwner(run, prev)) {
          dslConvOwner.set(node.conversationId, run)
        }
      }
    }
  }

  const childrenOf = (conversationId: number, ancestry: ReadonlySet<number>): ExecutionNode[] => {
    const out: ExecutionNode[] = []
    const dslClaimed = dslClaimedByParent.get(conversationId)
    const subClaims = subagentClaimsByParent.get(conversationId)

    // 1) Native subagent conversations claimed by `kind: 'subagent'` runs
    if (subClaims !== undefined) {
      for (const [convId, claimedRuns] of subClaims) {
        if (dslClaimed?.has(convId) === true || ancestry.has(convId)) continue
        const summary = convById.get(convId)
        let bestRun: WorkflowRunSummary | undefined
        for (const candidate of claimedRuns) {
          if (bestRun === undefined || isStrongerOwner(candidate, bestRun, summary?.parentToolCallId)) {
            bestRun = candidate
          }
        }
        if (bestRun === undefined) continue
        const firstNode = bestRun.nodes?.find((n) => n.conversationId === convId) ?? bestRun.nodes?.[0]
        const nextAncestry = new Set(ancestry).add(convId)
        out.push(
          finalizeNode({
            key: `conv:${convId}`,
            kind: 'agent',
            conversationId: convId,
            ...(summary !== undefined ? { summary } : {}),
            run: bestRun,
            ...(firstNode !== undefined ? { runNode: firstNode } : {}),
            ...(firstNode?.label !== undefined ? { label: firstNode.label } : {}),
            status: statusFromConversation(summary, bestRun),
            updatedAt: Math.max(summary?.updatedAt ?? 0, bestRun.updatedAt),
            children: childrenOf(convId, nextAncestry),
          }),
        )
      }
    }

    // 2) Runs started by this conversation (unclaimed subagent runs + DSL workflows)
    for (const run of runsByParent.get(conversationId) ?? []) {
      const runNodes = run.nodes ?? []
      if (run.kind === 'subagent') {
        if (subagentClaimedRunIds.has(run.id)) continue
        const firstNode = runNodes[0]
        out.push(
          finalizeNode({
            key: `run:${run.id}`,
            kind: 'agent',
            run,
            ...(firstNode !== undefined ? { runNode: firstNode } : {}),
            label: run.name,
            status: statusFromRun(run),
            updatedAt: run.updatedAt,
            children: [],
          }),
        )
        continue
      }

      const mountedConvIds = new Set<number>()
      const children = runNodes.map((node) => {
        const convId = node.conversationId
        if (
          convId === undefined ||
          ancestry.has(convId) ||
          dslConvOwner.get(convId) !== run ||
          mountedConvIds.has(convId)
        ) {
          return finalizeNode({
            key: `node:${run.id}:${node.id}`,
            kind: node.kind === 'action' ? 'action' : 'agent',
            ...(convId !== undefined ? { conversationId: convId } : {}),
            run,
            runNode: node,
            label: node.label,
            status: statusFromRunNode(node),
            updatedAt: run.updatedAt,
            children: [],
          })
        }
        mountedConvIds.add(convId)
        const summary = convById.get(convId)
        const nodeToolStatus: 'running' | 'done' | 'error' | 'unknown' =
          node.status === 'running' ? 'running' : node.status === 'failed' ? 'error' : node.status === 'done' ? 'done' : 'unknown'
        const nextAncestry = new Set(ancestry).add(convId)
        return finalizeNode({
          key: `conv:${convId}`,
          kind: 'agent',
          conversationId: convId,
          ...(summary !== undefined ? { summary } : {}),
          run,
          runNode: node,
          label: node.label,
          status:
            node.status === 'aborted'
              ? 'aborted'
              : statusFromConversation(summary, undefined, nodeToolStatus),
          updatedAt: Math.max(summary?.updatedAt ?? 0, run.updatedAt),
          children: childrenOf(convId, nextAncestry),
        })
      })

      out.push(
        finalizeNode({
          key: `run:${run.id}`,
          kind: 'workflow',
          run,
          label: run.name,
          status: statusFromRun(run),
          updatedAt: run.updatedAt,
          children,
        }),
      )
    }

    return out.sort((a, b) => {
      const rank = STATUS_PRIORITY[a.aggregated.status] - STATUS_PRIORITY[b.aggregated.status]
      if (rank !== 0) return rank
      return b.updatedAt - a.updatedAt
    })
  }

  return childrenOf(rootConversationId, new Set([rootConversationId]))
}
