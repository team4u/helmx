/**
 * Unified pure execution model for builtin:workflow UI surfaces
 * (zero React/DOM dependencies; single source of truth for status, titles,
 * timing, execution tree, phase sections, resumability, and active tray).
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveConversationTiming,
  resolveLocalizedText,
  type HelmxLocale,
} from '@helmx/plugin-client'
import type { AskSpec, ConversationLive, ConversationSummary, ToolViewProps } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import {
  COPY,
  STATUS_COPY,
  fallbackConversationTitle,
  traceResumeFallbackLabel,
  type ExecutionStatusKey,
} from './copy.js'
import {
  asPlainRecord,
  extractCleanPreviewLine,
  firstLineOf,
  formatShortModelName,
  inputString,
  isPlaceholderNodeLabel,
  isPlaceholderRunName,
  isPlaceholderSubagentTitle,
  parseSubagentExecutionInfo,
  readToolPresentationMeta,
  summarizeJsonPreview,
} from './parsers.js'

// ---------------------------------------------------------------------------
// Unified status model (`aborted` preserved honestly — never collapsed to done)
// ---------------------------------------------------------------------------

export type ExecutionStatus = ExecutionStatusKey

export type ExecutionNodeKind = 'workflow' | 'agent' | 'action'

export interface ExecutionAggregate {
  status: ExecutionStatus
  total: number
  done: number
  running: number
  blocked: number
  error: number
  aborted: number
}

export interface ExecutionNode {
  key: string
  kind: ExecutionNodeKind
  conversationId?: number
  run?: WorkflowRunSummary
  runNode?: WorkflowNodeState
  summary?: ConversationSummary
  label?: string
  status: ExecutionStatus
  children: ExecutionNode[]
  aggregated: ExecutionAggregate
  updatedAt: number
}

const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  blocked: 0,
  working: 1,
  error: 2,
  aborted: 3,
  pending: 4,
  done: 5,
}

export function aggregateStatuses(statuses: ReadonlyArray<ExecutionStatus>): ExecutionStatus {
  if (statuses.length === 0) return 'pending'
  let best: ExecutionStatus = statuses[0]!
  for (let i = 1; i < statuses.length; i++) {
    const s = statuses[i]!
    if (STATUS_PRIORITY[s] < STATUS_PRIORITY[best]) best = s
  }
  return best
}

export function statusFromRun(run: Pick<WorkflowRunSummary, 'status'>): ExecutionStatus {
  if (run.status === 'running') return 'working'
  if (run.status === 'completed') return 'done'
  if (run.status === 'aborted') return 'aborted'
  return 'error'
}

export function statusFromRunNode(node: Pick<WorkflowNodeState, 'status'>): ExecutionStatus {
  if (node.status === 'running') return 'working'
  if (node.status === 'done') return 'done'
  if (node.status === 'aborted') return 'aborted'
  if (node.status === 'failed') return 'error'
  return 'pending'
}

export function statusFromConversation(
  summary: Pick<ConversationSummary, 'status' | 'pendingAskCount'> | undefined,
  run?: Pick<WorkflowRunSummary, 'status'>,
  toolStatus?: 'running' | 'done' | 'error' | 'unknown',
): ExecutionStatus {
  if (summary !== undefined) {
    if (summary.status === 'blocked' || summary.pendingAskCount > 0) return 'blocked'
    if (summary.status === 'working') return 'working'
    if (run?.status === 'running') return 'working'
    if (run?.status === 'aborted') return 'aborted'
    if (run?.status === 'failed' || summary.status === 'error') return 'error'
    if (toolStatus === 'running') return 'working'
    if (toolStatus === 'error') return 'error'
    if (summary.status === 'done' || summary.status === 'idle') return 'done'
  }
  if (run !== undefined) return statusFromRun(run)
  if (toolStatus === 'running') return 'working'
  if (toolStatus === 'error') return 'error'
  if (toolStatus === 'done') return 'done'
  return 'pending'
}

/** Single mapping from ExecutionStatus to `<StatusLight status={...} />` token. */
export function executionLightStatus(status: ExecutionStatus): string {
  switch (status) {
    case 'blocked':
      return 'blocked'
    case 'working':
      return 'running'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'failed'
    case 'done':
      return 'completed'
    default:
      return 'pending'
  }
}

export function effectiveRunStatus(
  run: Pick<WorkflowRunSummary, 'status'>,
  subtree: ExecutionAggregate,
): ExecutionStatus {
  if (subtree.blocked > 0) return 'blocked'
  if (run.status === 'running' || subtree.running > 0) return 'working'
  if (run.status === 'aborted') return subtree.error > 0 ? 'error' : 'aborted'
  if (run.status === 'failed' || subtree.error > 0) return 'error'
  if (run.status === 'completed') return 'done'
  return 'pending'
}

// ---------------------------------------------------------------------------
// Single unified title resolver (`{ text, isFallback }` prevents duplicate #id)
// ---------------------------------------------------------------------------

export interface ResolvedTitle {
  text: string
  isFallback: boolean
}

export function resolveRunDisplayName(run: Pick<WorkflowRunSummary, 'id' | 'name' | 'description'>): string {
  const name = run.name.trim()
  if (!isPlaceholderRunName(name, run.id)) return name
  if (run.description !== undefined && run.description.trim() !== '') {
    const line = firstLineOf(run.description, 60)
    if (line !== '') return line
  }
  return run.id
}

export function resolveNodeTitle(
  input: {
    kind: ExecutionNodeKind
    conversationId?: number
    summary?: Pick<ConversationSummary, 'title'>
    run?: Pick<WorkflowRunSummary, 'id' | 'name' | 'description' | 'nodes'>
    runNode?: Pick<WorkflowNodeState, 'id' | 'label' | 'prompt'>
    toolLabel?: string
    toolPrompt?: string
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): ResolvedTitle {
  if (input.kind === 'workflow' && input.run !== undefined) {
    const text = resolveRunDisplayName(input.run)
    return { text, isFallback: text === input.run.id }
  }
  if (input.kind === 'action') {
    const lbl = input.runNode?.label?.trim()
    if (lbl && !isPlaceholderNodeLabel(lbl)) return { text: firstLineOf(lbl, 60), isFallback: false }
    return { text: input.runNode?.label || input.runNode?.id || resolveLocalizedText(COPY.actionLabel, locale), isFallback: true }
  }

  // Agent node (native conversation or external executionId)
  if (input.conversationId !== undefined && input.summary?.title !== undefined) {
    const custom = input.summary.title.trim()
    if (custom !== '' && !isPlaceholderSubagentTitle(custom, input.conversationId)) {
      return { text: firstLineOf(custom, 60), isFallback: false }
    }
  }
  if (input.run !== undefined && !isPlaceholderRunName(input.run.name, input.run.id)) {
    const cleaned = extractCleanPreviewLine(input.run.name, 60)
    if (cleaned !== '') return { text: cleaned, isFallback: false }
  }
  if (!isPlaceholderNodeLabel(input.toolLabel)) {
    const cleaned = extractCleanPreviewLine(input.toolLabel!, 60)
    if (cleaned !== '') return { text: cleaned, isFallback: false }
  }
  if (!isPlaceholderNodeLabel(input.runNode?.label)) {
    const cleaned = extractCleanPreviewLine(input.runNode!.label!, 60)
    if (cleaned !== '') return { text: cleaned, isFallback: false }
  }
  const prompt = input.toolPrompt ?? input.runNode?.prompt ?? input.run?.nodes?.[0]?.prompt
  if (prompt !== undefined && prompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(prompt, 60)
    if (cleaned !== '') return { text: cleaned, isFallback: false }
  }
  if (input.conversationId !== undefined) {
    return { text: fallbackConversationTitle(input.conversationId, locale), isFallback: true }
  }
  return { text: resolveLocalizedText(COPY.subagentLabel, locale), isFallback: true }
}

export function resolveWorkflowToolFallbackLabel(
  input: unknown,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  presentationMeta?: unknown,
): string {
  const label = inputString(input, 'label') ?? inputString(input, 'name')
  if (label !== undefined) return firstLineOf(label, 60)
  const meta = asPlainRecord(presentationMeta)
  const metaLabel = typeof meta?.['label'] === 'string' ? meta['label'].trim() : ''
  const metaRunId = typeof meta?.['runId'] === 'string' ? meta['runId'] : ''
  if (metaLabel !== '' && !isPlaceholderRunName(metaLabel, metaRunId)) return firstLineOf(metaLabel, 60)
  const scriptPath = inputString(input, 'scriptPath')
  if (scriptPath !== undefined) return firstLineOf(scriptPath, 60)
  const resumeId = inputString(input, 'resumeFromRunId')
  if (resumeId !== undefined) return traceResumeFallbackLabel(resumeId, locale)
  const script = inputString(input, 'script')
  if (script !== undefined) {
    const m = /name\s*:\s*["']([^"']+)["']/.exec(script)?.[1]
    if (m) return m
    return firstLineOf(script, 60)
  }
  return 'SubagentWorkflow'
}

// ---------------------------------------------------------------------------
// Single unified timing extractor
// ---------------------------------------------------------------------------

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
    ...(run.status !== 'running' && (run.settledAt ?? run.updatedAt) > 0 ? { settledAt: run.settledAt ?? run.updatedAt } : {}),
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

// ---------------------------------------------------------------------------
// Tool call ↔ Run / Subagent association + WeakMap O(1) latest-call index
// ---------------------------------------------------------------------------

export interface SubagentTimelineCallLike {
  callId: string
  toolName: string
  input?: unknown
  status?: 'running' | 'done' | 'error'
  presentationMeta?: unknown
}

export interface SubagentExecutionMeta {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  executionId?: string
  nodeId?: string
  effectiveCwd?: string
}

function parseResumeConversationId(input: unknown): number | undefined {
  const raw = asPlainRecord(input)?.['resume']
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw)
  return undefined
}

export function resolveSubagentConversationId(
  input: { callId: string | undefined; input: unknown; presentationMeta?: unknown },
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  const fromMeta = parseSubagentExecutionInfo(input.presentationMeta)?.conversationId
  if (fromMeta !== undefined) return fromMeta
  if (input.callId) {
    const hit = conversations.find(
      (c) => c.parentConversationId === parentConversationId && c.parentToolCallId === input.callId,
    )
    if (hit !== undefined) return hit.id
  }
  const resumeId = parseResumeConversationId(input.input)
  if (
    resumeId !== undefined &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

export function resolveSubagentExecutionMeta(
  input: { callId: string | undefined; presentationMeta?: unknown },
  parentConversationId: number,
  runs: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  let run = input.callId
    ? runs.find((r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId)
    : undefined
  const info = parseSubagentExecutionInfo(input.presentationMeta)
  if (run === undefined && info?.runId?.startsWith('wf_')) {
    run = runs.find((r) => r.conversationId === parentConversationId && r.id === info.runId)
  }
  const worktree = run?.nodes?.find((n) => n.worktree !== undefined)?.worktree ?? info?.worktree
  return {
    ...(run !== undefined ? { run } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(info?.executionId !== undefined ? { executionId: info.executionId } : {}),
    ...(info?.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
    ...(info?.effectiveCwd !== undefined ? { effectiveCwd: info.effectiveCwd } : {}),
  }
}

export function resolveWorkflowRunForTool(
  input: { callId: string | undefined; presentationMeta?: unknown },
  parentConversationId: number,
  runs: ReadonlyArray<WorkflowRunSummary>,
): WorkflowRunSummary | undefined {
  if (input.callId) {
    const byCall = runs.find((r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId)
    if (byCall !== undefined) return byCall
  }
  const meta = asPlainRecord(input.presentationMeta)
  const runId = typeof meta?.['runId'] === 'string' ? meta['runId'] : typeof meta?.['id'] === 'string' ? meta['id'] : undefined
  if (runId) return runs.find((r) => r.conversationId === parentConversationId && r.id === runId)
  return undefined
}

export function isBackgroundWorkflowResultHandle(presentationMeta: unknown): boolean {
  return asPlainRecord(presentationMeta)?.['background'] === true
}

export interface SubagentLatestCallIndex {
  readonly latestByTarget: ReadonlyMap<string, string>
  readonly knownCallIds: ReadonlySet<string>
}

const EMPTY_INDEX: SubagentLatestCallIndex = { latestByTarget: new Map(), knownCallIds: new Set() }

const latestCallCache = new WeakMap<
  ReadonlyArray<SubagentTimelineCallLike>,
  WeakMap<
    ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
    Map<number, SubagentLatestCallIndex>
  >
>()

export function buildSubagentLatestCallIndex(
  calls: ReadonlyArray<SubagentTimelineCallLike>,
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): SubagentLatestCallIndex {
  if (calls.length === 0) return EMPTY_INDEX
  let byConvs = latestCallCache.get(calls)
  if (byConvs === undefined) {
    byConvs = new WeakMap()
    latestCallCache.set(calls, byConvs)
  }
  let byParent = byConvs.get(conversations)
  if (byParent === undefined) {
    byParent = new Map()
    byConvs.set(conversations, byParent)
  }
  const hit = byParent.get(parentConversationId)
  if (hit !== undefined) return hit

  const childByCallId = new Map<string, number>()
  const childIds = new Set<number>()
  for (const c of conversations) {
    if (c.parentConversationId !== parentConversationId) continue
    childIds.add(c.id)
    if (c.parentToolCallId) childByCallId.set(c.parentToolCallId, c.id)
  }

  const latestByTarget = new Map<string, string>()
  const knownCallIds = new Set<string>()
  for (const call of calls) {
    if (call.toolName !== 'subagent') continue
    knownCallIds.add(call.callId)
    const info = parseSubagentExecutionInfo(call.presentationMeta)
    let childId = info?.conversationId ?? (call.callId ? childByCallId.get(call.callId) : undefined)
    if (childId === undefined) {
      const resumeId = parseResumeConversationId(call.input)
      if (resumeId !== undefined && childIds.has(resumeId)) childId = resumeId
    }
    if (childId !== undefined) {
      latestByTarget.set(`conv:${childId}`, call.callId)
      continue
    }
    const execId = info?.executionId ?? inputString(call.input, 'resume')
    if (execId) latestByTarget.set(`ext:${execId}`, call.callId)
  }
  const index: SubagentLatestCallIndex = { latestByTarget, knownCallIds }
  byParent.set(parentConversationId, index)
  return index
}

export function isLatestSubagentCallForTarget(
  props: {
    callId: string
    timelineCalls?: ReadonlyArray<SubagentTimelineCallLike>
    conversationId: number
  },
  childConversationId: number | undefined,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
  externalExecutionId?: string,
): boolean {
  if (childConversationId === undefined && externalExecutionId === undefined) return true
  const index = buildSubagentLatestCallIndex(props.timelineCalls ?? [], props.conversationId, conversations)
  if (!index.knownCallIds.has(props.callId)) return true
  const key = childConversationId !== undefined ? `conv:${childConversationId}` : `ext:${externalExecutionId!}`
  const latest = index.latestByTarget.get(key)
  return latest === undefined || latest === props.callId
}

export function extractToolMetaLabel(props: Pick<ToolViewProps, 'input' | 'presentationMeta'>): {
  label?: string
  prompt?: string
} {
  const label = inputString(props.input, 'label')
  const prompt = inputString(props.input, 'prompt') ?? inputString(props.input, 'task')
  return { ...(label !== undefined ? { label } : {}), ...(prompt !== undefined ? { prompt } : {}) }
}

// ---------------------------------------------------------------------------
// Unified execution tree (rooted strictly in `runs`)
// ---------------------------------------------------------------------------

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
        let bestRun = claimedRuns[0]!
        for (let i = 1; i < claimedRuns.length; i++) {
          if (isStrongerOwner(claimedRuns[i]!, bestRun, summary?.parentToolCallId)) bestRun = claimedRuns[i]!
        }
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

// ---------------------------------------------------------------------------
// Phase sections, logs, stats, resumability (trusting backend `run.resumable`)
// ---------------------------------------------------------------------------

export interface WorkflowPhaseSection {
  key: string
  index: number
  title: string
  detail?: string
  status: ExecutionStatus
  nodes: WorkflowNodeState[]
  doneCount: number
  totalCount: number
}

function sectionStatusOf(nodes: WorkflowNodeState[], runStatus: WorkflowRunSummary['status']): ExecutionStatus {
  if (nodes.some((n) => n.status === 'running')) return 'working'
  if (nodes.length === 0 || nodes.every((n) => n.status === 'pending')) return 'pending'
  if (nodes.some((n) => n.status === 'failed')) return 'error'
  if (nodes.some((n) => n.status === 'aborted')) return 'aborted'
  if (nodes.every((n) => n.status === 'done')) return 'done'
  return runStatus === 'running' ? 'working' : 'pending'
}

export function buildWorkflowPhaseSections(
  run: WorkflowRunSummary,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): WorkflowPhaseSection[] {
  const nodes = run.nodes ?? []
  const defaultTitle = resolveLocalizedText(COPY.defaultPhaseTitle, locale)
  const declared: Array<{ title: string; detail?: string }> = []
  const seen = new Set<string>()
  const declare = (title: string | undefined, detail?: string): void => {
    const k = title?.trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    declared.push({ title: k, ...(detail !== undefined ? { detail } : {}) })
  }
  for (const p of run.phases ?? []) declare(p.title, p.detail)
  for (const p of run.progress ?? []) {
    if (p.kind === 'phase') declare(p.title)
  }
  for (const n of nodes) declare(n.phaseTitle)

  if (declared.length === 0) {
    return [
      {
        key: 'default',
        index: 0,
        title: '',
        status: sectionStatusOf(nodes, run.status),
        nodes: [...nodes],
        doneCount: nodes.filter((n) => n.status === 'done').length,
        totalCount: nodes.length,
      },
    ]
  }

  const buckets = new Map<string, WorkflowNodeState[]>()
  const leftovers: WorkflowNodeState[] = []
  for (const n of nodes) {
    const k = n.phaseTitle?.trim()
    if (k && seen.has(k)) {
      const list = buckets.get(k)
      if (list) list.push(n)
      else buckets.set(k, [n])
    } else {
      leftovers.push(n)
    }
  }

  const sections: WorkflowPhaseSection[] = declared.map((p, idx) => {
    const group = buckets.get(p.title) ?? []
    return {
      key: `phase:${idx}:${p.title}`,
      index: idx,
      title: p.title,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
      status: sectionStatusOf(group, run.status),
      nodes: group,
      doneCount: group.filter((n) => n.status === 'done').length,
      totalCount: group.length,
    }
  })
  if (leftovers.length > 0) {
    sections.push({
      key: `phase:${declared.length}:${defaultTitle}`,
      index: declared.length,
      title: defaultTitle,
      status: sectionStatusOf(leftovers, run.status),
      nodes: leftovers,
      doneCount: leftovers.filter((n) => n.status === 'done').length,
      totalCount: leftovers.length,
    })
  }
  return sections
}

export interface WorkflowLogLine {
  key: string
  at: number
  message: string
}

export function extractWorkflowLogs(run: WorkflowRunSummary): WorkflowLogLine[] {
  return (run.progress ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'log' }> => p.kind === 'log')
    .map((p, i) => ({ key: `log:${i}:${p.at}`, at: p.at, message: p.message }))
}

export function formatNodeStats(node: WorkflowNodeState): string[] {
  const parts: string[] = []
  const model = formatShortModelName(node.model)
  if (model) parts.push(model)
  if (node.tokens !== undefined && node.tokens > 0) {
    parts.push(`${node.tokens >= 1000 ? `${(node.tokens / 1000).toFixed(1)}k` : String(node.tokens)} tok`)
  }
  return parts
}

/** Trust backend authoritative `run.resumable` on failed runs; zero client error-code guessing. */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  if (run.kind === 'subagent' || run.resumedByRunId !== undefined) return false
  if (run.status === 'failed') return run.resumable === true
  return run.status === 'aborted'
}

export function canResumeSubagentRun(run: WorkflowRunSummary | undefined): boolean {
  if (run === undefined || run.kind !== 'subagent' || run.resumedByRunId !== undefined) return false
  if (run.status === 'failed') return run.resumable === true
  if (run.status === 'aborted') {
    return (run.nodes ?? []).some((n) => n.conversationId !== undefined || (n.executionId !== undefined && n.executionId !== ''))
  }
  return false
}

export function canReplayWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && run.status === 'completed'
}

export function listResumableFailedRuns(
  runs: ReadonlyArray<WorkflowRunSummary>,
  conversationId: number,
): WorkflowRunSummary[] {
  return runs.filter(
    (r) =>
      r.conversationId === conversationId &&
      r.status === 'failed' &&
      r.resumable === true &&
      r.resumedByRunId === undefined,
  )
}

// ---------------------------------------------------------------------------
// Live one-line activity snippet (shared by ActiveTray & Workbench rows)
// ---------------------------------------------------------------------------

export interface LiveSnippet {
  tag?: string
  text: string
  isError?: boolean
}

function shortenPathForCwd(pathText: string, cwd: string | undefined): string {
  if (!cwd) return pathText
  const normPath = pathText.replace(/\\/g, '/')
  const normCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normCwd !== '' && normPath.startsWith(`${normCwd}/`)) {
    return normPath.slice(normCwd.length + 1)
  }
  return pathText
}

function formatLiveToolCall(
  tool: ConversationLive['tools'][number],
  cwd: string | undefined,
): string {
  const input = asPlainRecord(tool.input)
  const cmd = input !== undefined ? inputString(input, 'command') : undefined
  if (cmd !== undefined) return `${tool.toolName}: ${firstLineOf(cmd, 80)}`
  const rawPath =
    input !== undefined
      ? (inputString(input, 'path') ?? inputString(input, 'file_path') ?? inputString(input, 'Path'))
      : undefined
  if (rawPath !== undefined) return `${tool.toolName}: ${firstLineOf(shortenPathForCwd(rawPath, cwd), 80)}`
  return tool.toolName
}

export function resolveLiveSnippet(
  input: {
    status: ExecutionStatus
    summary?: ConversationSummary
    live?: ConversationLive
    pendingAsk?: AskSpec
    run?: WorkflowRunSummary
    runNode?: WorkflowNodeState
    loadError?: string
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): LiveSnippet | undefined {
  if (input.loadError) {
    return { tag: resolveLocalizedText(COPY.tagError, locale), text: firstLineOf(input.loadError, 100), isError: true }
  }
  if (input.pendingAsk !== undefined) {
    const title = firstLineOf(input.pendingAsk.title || resolveLocalizedText(STATUS_COPY.blocked, locale), 100)
    return { tag: resolveLocalizedText(COPY.tagApproval, locale), text: title }
  }
  if (input.status === 'working' && input.live !== undefined) {
    const runningTools = (input.live.tools ?? []).filter((tool) => tool.status === 'running')
    if (runningTools.length > 0) {
      const first = formatLiveToolCall(runningTools[0]!, input.summary?.cwd)
      const extra = runningTools.length > 1 ? ` +${runningTools.length - 1}` : ''
      return { tag: resolveLocalizedText(COPY.tagTool, locale), text: `${first}${extra}` }
    }
    const liveText = input.live.text ? extractCleanPreviewLine(input.live.text, 100) : ''
    if (liveText !== '') return { tag: resolveLocalizedText(COPY.tagOutput, locale), text: liveText }
    if (input.live.thinking && input.live.thinking.trim() !== '') {
      return { tag: resolveLocalizedText(COPY.tagThinking, locale), text: extractCleanPreviewLine(input.live.thinking, 100) || resolveLocalizedText(COPY.snippetThinking, locale) }
    }
  }
  if (input.status === 'working') {
    const doing = input.summary?.doing?.trim()
    if (doing) return { text: firstLineOf(doing, 100) }
    if (input.runNode?.phaseTitle) return { text: input.runNode.phaseTitle }
    return { text: resolveLocalizedText(COPY.snippetStarting, locale) }
  }
  if (input.status === 'error' || input.status === 'aborted') {
    const err =
      input.runNode?.error?.trim() ||
      input.run?.error?.trim() ||
      (input.runNode?.gate?.ok === false ? input.runNode.gate.output.trim() : '')
    if (err) return { tag: resolveLocalizedText(COPY.tagError, locale), text: firstLineOf(err, 100), isError: true }
    return {
      text: resolveLocalizedText(input.status === 'aborted' ? COPY.snippetAborted : COPY.snippetExecFailed, locale),
      isError: input.status === 'error',
    }
  }
  if (input.status === 'done') {
    const out = input.runNode?.output ?? input.run?.resultPreview ?? input.run?.result
    const preview = summarizeJsonPreview(out, 100)
    if (preview) return { tag: resolveLocalizedText(COPY.tagOutput, locale), text: preview }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Active tray projection
// ---------------------------------------------------------------------------

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

    const progress =
      node.kind === 'workflow' && (node.run?.nodes?.length ?? 0) > 0
        ? {
            done: node.run!.nodes!.filter((n) => n.status === 'done').length,
            total: node.run!.nodes!.length,
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
