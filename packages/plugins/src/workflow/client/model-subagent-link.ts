/**
 * Pure logic for the builtin:workflow client: subagent runtime association —
 * tool call ↔ subagent / background run / worktree / external run resolution
 * via presentationMeta + parentToolCallId + resume (zero JSON.parse fallback,
 * zero regex/footer scraping, zero React/DOM dependencies).
 */
import type { ConversationSummary, ToolViewProps } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { inputString } from './model-format.ts'

/** Execution metadata of the top-level structured presentationMeta of a subagent tool output. */
export interface SubagentExecutionInfo {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: { path: string; branch: string }
  runId?: string
  background?: boolean
  status?: string
}

/** Lightweight timeline tool call summary (aligned with TimelineToolCallSummary / sibling slice). */
export interface SubagentTimelineCallLike {
  callId: string
  toolName: string
  input?: unknown
  status?: 'running' | 'done' | 'error'
  presentationMeta?: unknown
}

/** ToolViewProps aligned with the #10/#11 presentationMeta channel. */
export type ToolViewPresentationProps = ToolViewProps & {
  presentationMeta?: Readonly<Record<string, unknown>>
}

/** Read plain-object presentationMeta from ToolViewProps without touching legacy channels. */
export function readToolPresentationMeta(props: ToolViewProps): Readonly<Record<string, unknown>> | undefined {
  const meta = (props as ToolViewPresentationProps).presentationMeta
  return asPlainRecord(meta)
}

function asPlainRecord(source: unknown): Record<string, unknown> | undefined {
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : undefined
}

/**
 * Extract subagent execution info from `presentationMeta` (zero JSON.parse
 * fallback or footer scraping).
 */
export function parseSubagentExecutionInfo(
  presentationMeta: unknown,
): SubagentExecutionInfo | undefined {
  const envelope = asPlainRecord(presentationMeta)
  if (envelope === undefined) return undefined
  if (envelope['execution'] === undefined && envelope['runId'] === undefined) return undefined
  const info: SubagentExecutionInfo = {}
  const execution = envelope['execution']
  if (execution !== null && typeof execution === 'object' && !Array.isArray(execution)) {
    const exec = execution as Record<string, unknown>
    if (typeof exec['nodeId'] === 'string' && exec['nodeId'] !== '') info.nodeId = exec['nodeId']
    if (
      typeof exec['conversationId'] === 'number' &&
      Number.isSafeInteger(exec['conversationId']) &&
      exec['conversationId'] > 0
    ) {
      info.conversationId = exec['conversationId']
    }
    if (typeof exec['executionId'] === 'string' && exec['executionId'] !== '') info.executionId = exec['executionId']
    if (typeof exec['effectiveCwd'] === 'string' && exec['effectiveCwd'] !== '') info.effectiveCwd = exec['effectiveCwd']
    const wt = exec['worktree']
    if (
      wt !== null &&
      typeof wt === 'object' &&
      !Array.isArray(wt) &&
      typeof (wt as Record<string, unknown>)['path'] === 'string' &&
      (wt as Record<string, unknown>)['path'] !== '' &&
      typeof (wt as Record<string, unknown>)['branch'] === 'string'
    ) {
      info.worktree = {
        path: (wt as Record<string, unknown>)['path'] as string,
        branch: (wt as Record<string, unknown>)['branch'] as string,
      }
    }
  }
  if (typeof envelope['runId'] === 'string' && envelope['runId'] !== '') info.runId = envelope['runId']
  if (typeof envelope['background'] === 'boolean') info.background = envelope['background']
  if (typeof envelope['status'] === 'string' && envelope['status'] !== '') info.status = envelope['status']
  return info.conversationId !== undefined ||
    info.executionId !== undefined ||
    info.worktree !== undefined ||
    info.runId !== undefined
    ? info
    : undefined
}

function parseResumeConversationId(input: unknown): number | undefined {
  const resumeRefRaw =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)['resume']
      : undefined
  return typeof resumeRefRaw === 'number' && Number.isSafeInteger(resumeRefRaw) && resumeRefRaw > 0
    ? resumeRefRaw
    : typeof resumeRefRaw === 'string' && /^\d+$/.test(resumeRefRaw)
      ? Number(resumeRefRaw)
      : undefined
}

/**
 * Resolve the subagent conversation id linked to a subagent tool call:
 * 1) settled: `presentationMeta.execution.conversationId`;
 * 2) in flight: precise association by `callId` against `parentToolCallId`;
 * 3) resume: numeric `resume` ref matching a child of the same parent conversation.
 */
export function resolveSubagentConversationId(
  input: {
    callId: string | undefined
    input: unknown
    presentationMeta?: unknown
  },
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  const fromMeta = parseSubagentExecutionInfo(input.presentationMeta)?.conversationId
  if (fromMeta !== undefined) return fromMeta

  if (input.callId !== undefined && input.callId !== '') {
    for (const c of conversations) {
      if (c.parentConversationId === parentConversationId && c.parentToolCallId === input.callId) {
        return c.id
      }
    }
  }
  const resumeId = parseResumeConversationId(input.input)
  if (
    resumeId !== undefined &&
    Number.isSafeInteger(resumeId) &&
    resumeId > 0 &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

/** Execution metadata of a subagent tool call (background run / worktree / external run identity). */
export interface SubagentExecutionMeta {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  executionId?: string
  nodeId?: string
  effectiveCwd?: string
}

/** Resolve a subagent tool call's execution metadata from `parentToolCallId` + `presentationMeta`. */
export function resolveSubagentExecutionMeta(
  input: { callId: string | undefined; presentationMeta?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  let run: WorkflowRunSummary | undefined
  if (input.callId !== undefined && input.callId !== '') {
    run = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
  }
  const info = parseSubagentExecutionInfo(input.presentationMeta)
  if (run === undefined && info?.runId !== undefined && info.runId.startsWith('wf_')) {
    run = workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === info.runId)
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

/** Lightweight parent tool summary (collapsed header data source). */
export interface SubagentParentToolSummary {
  label?: string
  prompt?: string
  startedAt?: number
  durationMs?: number
  resultText?: string
  presentationMeta?: unknown
  isError?: boolean
}

/** Cached O(1) lookup index mapping each native/external target to its latest subagent callId. */
export interface SubagentLatestCallIndex {
  readonly latestByTarget: ReadonlyMap<string, string>
  readonly knownCallIds: ReadonlySet<string>
}

const EMPTY_LATEST_CALL_INDEX: SubagentLatestCallIndex = {
  latestByTarget: new Map(),
  knownCallIds: new Set(),
}

const latestCallIndexCache = new WeakMap<
  ReadonlyArray<SubagentTimelineCallLike>,
  WeakMap<
    ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
    Map<number, SubagentLatestCallIndex>
  >
>()

/**
 * Build (and WeakMap-cache) a single-pass O(K + M) index mapping each subagent
 * target (`conv:<id>` or `ext:<executionId>`) to the latest chronological `callId`.
 * All K SubagentToolView rows sharing the same `(subagentCalls, conversations, parentConversationId)`
 * compute this once and check `isLatest` in O(1).
 */
export function buildSubagentLatestCallIndex(
  subagentCalls: ReadonlyArray<SubagentTimelineCallLike>,
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): SubagentLatestCallIndex {
  if (subagentCalls.length === 0) return EMPTY_LATEST_CALL_INDEX

  let byConversations = latestCallIndexCache.get(subagentCalls)
  if (byConversations === undefined) {
    byConversations = new WeakMap()
    latestCallIndexCache.set(subagentCalls, byConversations)
  }
  let byParentId = byConversations.get(conversations)
  if (byParentId === undefined) {
    byParentId = new Map()
    byConversations.set(conversations, byParentId)
  }
  const cached = byParentId.get(parentConversationId)
  if (cached !== undefined) return cached

  const childByParentCallId = new Map<string, number>()
  const childIdSet = new Set<number>()
  for (const c of conversations) {
    if (c.parentConversationId !== parentConversationId) continue
    childIdSet.add(c.id)
    if (c.parentToolCallId !== undefined && c.parentToolCallId !== '') {
      childByParentCallId.set(c.parentToolCallId, c.id)
    }
  }

  const latestByTarget = new Map<string, string>()
  const knownCallIds = new Set<string>()
  for (const call of subagentCalls) {
    if (call.toolName !== 'subagent') continue
    knownCallIds.add(call.callId)
    const info = parseSubagentExecutionInfo(call.presentationMeta)
    let childId = info?.conversationId
    if (childId === undefined && call.callId !== '') {
      childId = childByParentCallId.get(call.callId)
    }
    if (childId === undefined) {
      const resumeId = parseResumeConversationId(call.input)
      if (resumeId !== undefined && childIdSet.has(resumeId)) {
        childId = resumeId
      }
    }
    if (childId !== undefined) {
      latestByTarget.set(`conv:${childId}`, call.callId)
      continue
    }
    const execId = info?.executionId ?? inputString(call.input, 'resume')
    if (execId !== undefined && execId !== '') {
      latestByTarget.set(`ext:${execId}`, call.callId)
    }
  }

  const index: SubagentLatestCallIndex = { latestByTarget, knownCallIds }
  byParentId.set(parentConversationId, index)
  return index
}

/**
 * Whether the current callId is the latest subagent call for the same native /
 * external execution target among timelineCalls.
 */
export function isLatestSubagentCallForTarget(
  props: {
    callId: string
    input?: unknown
    presentationMeta?: unknown
    timelineCalls?: ReadonlyArray<SubagentTimelineCallLike>
    conversationId: number
  },
  childConversationId: number | undefined,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
  externalExecutionId?: string,
): boolean {
  if (childConversationId === undefined && externalExecutionId === undefined) return true
  const timelineCalls = props.timelineCalls ?? []
  const index = buildSubagentLatestCallIndex(timelineCalls, props.conversationId, conversations)
  if (!index.knownCallIds.has(props.callId)) return true
  const targetKey =
    childConversationId !== undefined ? `conv:${childConversationId}` : `ext:${externalExecutionId!}`
  const latestCallId = index.latestByTarget.get(targetKey)
  return latestCallId === undefined || latestCallId === props.callId
}

/** Build the lightweight parent tool summary from ToolViewProps. */
export function parentToolSummaryOf(props: ToolViewProps): SubagentParentToolSummary {
  const label = inputString(props.input, 'label')
  const prompt = inputString(props.input, 'prompt')
  const presentationMeta = readToolPresentationMeta(props)
  return {
    ...(label !== undefined ? { label } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(props.startedAt !== undefined ? { startedAt: props.startedAt } : {}),
    ...(props.durationMs !== undefined ? { durationMs: props.durationMs } : {}),
    ...(typeof props.result === 'string' ? { resultText: props.result } : {}),
    ...(presentationMeta !== undefined ? { presentationMeta } : {}),
    ...(props.isError === true ? { isError: true } : {}),
  }
}
