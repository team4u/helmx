/**
 * Unified execution tree builder (rooted strictly in `runs`).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
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

/** Leaf for an agent/action node that does not mount a conversation subtree. */
function runNodeLeaf(run: WorkflowRunSummary, node: WorkflowNodeState): ExecutionNode {
  return finalizeNode({
    key: `node:${run.id}:${node.id}`,
    kind: node.kind === 'action' ? 'action' : 'agent',
    ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
    run,
    runNode: node,
    label: node.label,
    status: statusFromRunNode(node),
    updatedAt: run.updatedAt,
    children: [],
  })
}

export function buildLeafNodesForRun(run: WorkflowRunSummary): ExecutionNode[] {
  return (run.nodes ?? []).map((node) => runNodeLeaf(run, node))
}

export interface BuildExecutionTreeInput {
  rootConversationId: number
  conversations: ReadonlyArray<ConversationSummary>
  runs?: ReadonlyArray<WorkflowRunSummary>
}

/**
 * Lookup tables over all runs and conversations: which conversation spawned what, which run owns
 * which conversation, and which subagent runs claimed their children.
 */
interface ExecutionTreeIndex {
  convById: Map<number, ConversationSummary>
  convByParentCall: Map<string, ConversationSummary>
  runsByParent: Map<number, WorkflowRunSummary[]>
  /** Per conversation, the strongest DSL run that mounted it (only that run may grow its subtree). */
  dslConvOwner: Map<number, WorkflowRunSummary>
  dslClaimedByParent: Map<number, Set<number>>
  subagentClaimsByParent: Map<number, Map<number, WorkflowRunSummary[]>>
  subagentClaimedRunIds: Set<string>
}

const parentCallKey = (conversationId: number, toolCallId: string): string => `${conversationId}\0${toolCallId}`

function indexExecutionTree(
  conversations: ReadonlyArray<ConversationSummary>,
  runs: ReadonlyArray<WorkflowRunSummary>,
): ExecutionTreeIndex {
  const index: ExecutionTreeIndex = {
    convById: new Map<number, ConversationSummary>(),
    convByParentCall: new Map<string, ConversationSummary>(),
    runsByParent: new Map<number, WorkflowRunSummary[]>(),
    dslConvOwner: new Map<number, WorkflowRunSummary>(),
    dslClaimedByParent: new Map<number, Set<number>>(),
    subagentClaimsByParent: new Map<number, Map<number, WorkflowRunSummary[]>>(),
    subagentClaimedRunIds: new Set<string>(),
  }
  for (const c of conversations) {
    index.convById.set(c.id, c)
    if (c.parentConversationId !== undefined && c.parentToolCallId) {
      index.convByParentCall.set(parentCallKey(c.parentConversationId, c.parentToolCallId), c)
    }
  }
  const seenRunIds = new Set<string>()
  for (const run of runs) {
    if (seenRunIds.has(run.id)) continue
    seenRunIds.add(run.id)
    const bucket = index.runsByParent.get(run.conversationId)
    if (bucket) bucket.push(run)
    else index.runsByParent.set(run.conversationId, [run])
    if (run.kind === 'subagent') indexSubagentRun(index, run)
    else indexDslRun(index, run)
  }
  return index
}

/** A `kind: 'subagent'` run claims the conversations its nodes spawned (or, failing that, its parent tool call's child). */
function indexSubagentRun(index: ExecutionTreeIndex, run: WorkflowRunSummary): void {
  const nodes = run.nodes ?? []
  const claimedIds = nodes.map((n) => n.conversationId).filter((id): id is number => id !== undefined)
  if (claimedIds.length === 0 && nodes.every((n) => n.executionId === undefined) && run.parentToolCallId) {
    const byCall = index.convByParentCall.get(parentCallKey(run.conversationId, run.parentToolCallId))
    if (byCall !== undefined) claimedIds.push(byCall.id)
  }
  if (claimedIds.length === 0) return

  index.subagentClaimedRunIds.add(run.id)
  let byConv = index.subagentClaimsByParent.get(run.conversationId)
  if (byConv === undefined) {
    byConv = new Map()
    index.subagentClaimsByParent.set(run.conversationId, byConv)
  }
  for (const id of claimedIds) {
    const list = byConv.get(id)
    if (list) list.push(run)
    else byConv.set(id, [run])
  }
}

/** A DSL run claims every conversation its nodes mounted; the strongest run among claimers owns the subtree. */
function indexDslRun(index: ExecutionTreeIndex, run: WorkflowRunSummary): void {
  let claimed = index.dslClaimedByParent.get(run.conversationId)
  if (claimed === undefined) {
    claimed = new Set()
    index.dslClaimedByParent.set(run.conversationId, claimed)
  }
  for (const node of run.nodes ?? []) {
    if (node.conversationId === undefined) continue
    claimed.add(node.conversationId)
    const prev = index.dslConvOwner.get(node.conversationId)
    if (prev === undefined || isStrongerOwner(run, prev)) {
      index.dslConvOwner.set(node.conversationId, run)
    }
  }
}

export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  if (runs.length === 0) return []
  const index = indexExecutionTree(conversations, runs)
  return childrenOf(index, rootConversationId, new Set([rootConversationId]))
}

function sortExecutionNodes(nodes: ExecutionNode[]): ExecutionNode[] {
  return nodes.sort((a, b) => {
    const rank = STATUS_PRIORITY[a.aggregated.status] - STATUS_PRIORITY[b.aggregated.status]
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt
  })
}

/** Children of a conversation: claimed native subagent conversations first, then the runs it started. */
function childrenOf(index: ExecutionTreeIndex, conversationId: number, ancestry: ReadonlySet<number>): ExecutionNode[] {
  const out = claimedSubagentConversationNodes(index, conversationId, ancestry)
  const dslClaimed = index.dslClaimedByParent.get(conversationId)
  for (const run of index.runsByParent.get(conversationId) ?? []) {
    if (run.kind === 'subagent') {
      if (!index.subagentClaimedRunIds.has(run.id)) out.push(unclaimedSubagentRunNode(run))
      continue
    }
    out.push(dslRunNode(index, run, ancestry, dslClaimed))
  }
  return sortExecutionNodes(out)
}

/** Native subagent conversations claimed by `kind: 'subagent'` runs of this conversation (each gets its own subtree). */
function claimedSubagentConversationNodes(
  index: ExecutionTreeIndex,
  conversationId: number,
  ancestry: ReadonlySet<number>,
): ExecutionNode[] {
  const subClaims = index.subagentClaimsByParent.get(conversationId)
  if (subClaims === undefined) return []
  const dslClaimed = index.dslClaimedByParent.get(conversationId)
  const out: ExecutionNode[] = []
  for (const [convId, claimedRuns] of subClaims) {
    if (dslClaimed?.has(convId) === true || ancestry.has(convId)) continue
    const summary = index.convById.get(convId)
    const bestRun = strongestOwner(claimedRuns, summary?.parentToolCallId)
    if (bestRun === undefined) continue
    out.push(claimedSubagentConversationNode(index, { convId, summary, run: bestRun }, ancestry))
  }
  return out
}

function strongestOwner(runs: ReadonlyArray<WorkflowRunSummary>, preferredCallId: string | undefined): WorkflowRunSummary | undefined {
  let bestRun: WorkflowRunSummary | undefined
  for (const candidate of runs) {
    if (bestRun === undefined || isStrongerOwner(candidate, bestRun, preferredCallId)) bestRun = candidate
  }
  return bestRun
}

/** A `kind: 'subagent'` run's claim on one conversation it spawned. */
interface ClaimedConversation {
  convId: number
  summary: ConversationSummary | undefined
  run: WorkflowRunSummary
}

/** The run node that matches the claimed conversation (else its first node) labels the subtree. */
function claimedSubagentConversationNode(
  index: ExecutionTreeIndex,
  claim: ClaimedConversation,
  ancestry: ReadonlySet<number>,
): ExecutionNode {
  const { convId, summary, run } = claim
  const runNode = run.nodes?.find((n) => n.conversationId === convId) ?? run.nodes?.[0]
  return conversationNode(
    index,
    {
      convId,
      summary,
      run,
      ...(runNode !== undefined ? { runNode } : {}),
      ...(runNode?.label !== undefined ? { label: runNode.label } : {}),
      status: statusFromConversation(summary, run),
    },
    ancestry,
  )
}

/** A `kind: 'subagent'` run that claimed no conversation becomes a single leaf under its parent. */
function unclaimedSubagentRunNode(run: WorkflowRunSummary): ExecutionNode {
  const firstNode = run.nodes?.[0]
  return finalizeNode({
    key: `run:${run.id}`,
    kind: 'agent',
    run,
    ...(firstNode !== undefined ? { runNode: firstNode } : {}),
    label: run.name,
    status: statusFromRun(run),
    updatedAt: run.updatedAt,
    children: [],
  })
}

/** A conversation mounted under `run` by `runNode` (when given), rendered with its nested children. */
interface ConversationMount {
  convId: number
  summary: ConversationSummary | undefined
  run: WorkflowRunSummary
  runNode?: WorkflowNodeState
  label?: string
  status: ExecutionStatus
}

function conversationNode(index: ExecutionTreeIndex, mount: ConversationMount, ancestry: ReadonlySet<number>): ExecutionNode {
  const { convId, summary, run, runNode, label, status } = mount
  return finalizeNode({
    key: `conv:${convId}`,
    kind: 'agent',
    conversationId: convId,
    ...(summary !== undefined ? { summary } : {}),
    run,
    ...(runNode !== undefined ? { runNode } : {}),
    ...(label !== undefined ? { label } : {}),
    status,
    updatedAt: Math.max(summary?.updatedAt ?? 0, run.updatedAt),
    children: childrenOf(index, convId, new Set(ancestry).add(convId)),
  })
}

function dslRunNode(
  index: ExecutionTreeIndex,
  run: WorkflowRunSummary,
  ancestry: ReadonlySet<number>,
  dslClaimed: Set<number> | undefined,
): ExecutionNode {
  // Only the first node of this run that mounts a conversation grows its subtree; later nodes stay leaves.
  const mount: DslMountContext = { ancestry, dslClaimed, mountedConvIds: new Set() }
  const children = (run.nodes ?? []).map((node) => dslRunChildNode(index, run, node, mount))
  return finalizeNode({
    key: `run:${run.id}`,
    kind: 'workflow',
    run,
    label: run.name,
    status: statusFromRun(run),
    updatedAt: run.updatedAt,
    children,
  })
}

interface DslMountContext {
  ancestry: ReadonlySet<number>
  dslClaimed: Set<number> | undefined
  mountedConvIds: Set<number>
}

function dslRunChildNode(index: ExecutionTreeIndex, run: WorkflowRunSummary, node: WorkflowNodeState, mount: DslMountContext): ExecutionNode {
  const convId = node.conversationId
  const mountsSubtree =
    convId !== undefined &&
    !mount.ancestry.has(convId) &&
    index.dslConvOwner.get(convId) === run &&
    !mount.mountedConvIds.has(convId)
  if (!mountsSubtree) return runNodeLeaf(run, node)
  mount.mountedConvIds.add(convId)
  const summary = index.convById.get(convId)
  return conversationNode(
    index,
    {
      convId,
      summary,
      run,
      runNode: node,
      label: node.label,
      status: node.status === 'aborted' ? 'aborted' : statusFromConversation(summary, undefined, toolStatusOf(node.status)),
    },
    mount.ancestry,
  )
}

/** Maps a node's run status onto the tool-call status the conversation status model expects. */
function toolStatusOf(status: WorkflowNodeState['status']): 'running' | 'done' | 'error' | 'unknown' {
  if (status === 'running') return 'running'
  if (status === 'failed') return 'error'
  if (status === 'done') return 'done'
  return 'unknown'
}
