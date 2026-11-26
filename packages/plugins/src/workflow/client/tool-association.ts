/**
 * Tool call ↔ Run / Subagent association + WeakMap O(1) latest-call index.
 */
import type { ConversationSummary, ToolViewProps } from '@helmx/protocol/browser'
import type { WorkflowRunSummary } from '../../contracts-types.js'
import { asPlainRecord, inputString, parseSubagentExecutionInfo } from './parsers.js'

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
  const key = childConversationId !== undefined ? `conv:${childConversationId}` : `ext:${externalExecutionId ?? ''}`
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
