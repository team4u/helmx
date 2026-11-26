/**
 * runs/types.ts — Discriminated union RunHeader (compact KV row), RunDetail (lazy disk file),
 * explicit RunPhase state machine, and ActiveRun runtime handle.
 */
import type {
  ActionManifest,
  AgentExecutionInfo,
  AgentSpawnRequest,
  ConversationSummary,
  EnvExecRequest,
  EnvExecResponse,
  JsonSchema,
} from '@helmx/protocol'
import type {
  WorkflowNodeState,
  WorkflowProgressEntry,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '../../contracts.js'
import type { JournalWriter, WorkflowPhaseMeta } from '../dsl/index.js'

/** Test-injectable host seam for WorkflowService (shared leaf breaking spawn-bridge <-> action-bridge cycle). */
export interface WorkflowServiceHost {
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  abortConversationGuarded(id: number): Promise<void>
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number; signal?: AbortSignal },
  ): Promise<unknown>
  prepareAction?(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number },
  ): { idempotent?: boolean }
  execEnv?(req: Omit<EnvExecRequest, 'stream'>, signal?: AbortSignal): Promise<EnvExecResponse>
  listActions(): ActionManifest[]
  getConversation(id: number): ConversationSummary
  emitEvent(type: string, payload: unknown): void
  onRunSettled?(summary: WorkflowRunSummary): Promise<void> | void
  onBackgroundAgentSettled?(
    summary: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ): Promise<void> | void
  runGate?(
    command: string,
    options: { cwd?: string; conversationId?: number; signal?: AbortSignal; gateTimeoutMs?: number },
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }>
  isHostClosing?(): boolean
}

/** Explicit run lifecycle phase replacing legacy 3-boolean combinations (`suspendedCleanly`/`pendingChildCleanup`/`status`). */
export type RunPhase = 'running' | 'suspended' | 'cleanup_pending' | 'settled'

/** Sanitized single-subagent spawn specification (stored in RunDetail for restart reattach & explicit resume). */
export interface PersistedSubagentSpec {
  agentId: string
  requestId: string
  prompt: string
  label?: string
  agentType?: string
  nodeId?: string
  cwd?: string
  isolation?: 'worktree'
  gate?: string
  gateTimeoutMs?: number
  schema?: JsonSchema
  maxSubagentDepth?: number
  model?: string
  effort?: string
  fork?: boolean
  attachments?: string[]
  resume?: string
}

interface RunHeaderBase {
  id: string
  name: string
  conversationId: number
  parentToolCallId?: string
  status: WorkflowRunStatus
  phase: RunPhase
  createdAt: number
  updatedAt: number
  settledAt?: number
  error?: string
  errorCode?: string
  resumable?: boolean
  hasResult?: boolean
  resultPreview?: string
  replayedFrom?: string
  notifyParentOnSettle?: boolean
  notifiedAt?: number
  crashRecoveries?: number
  childConversationIds?: number[]
  /** Compact slimmed nodes for zero-IO list/projection rendering (bounded prompt/error/gate; no schema/output). */
  nodes?: WorkflowNodeState[]
  /** Compact bounded phase/log timeline for zero-IO Workbench display. */
  progress?: WorkflowProgressEntry[]
  journalIoErrors?: string[]
}

export interface SubagentRunHeader extends RunHeaderBase {
  kind: 'subagent'
  agentType?: string
  execution?: AgentExecutionInfo
}

export interface DslWorkflowRunHeader extends RunHeaderBase {
  kind: 'workflow'
  journalPath: string
  savedName?: string
  description?: string
  phases?: WorkflowPhaseMeta[]
  scriptPath?: string
}

/** Compact persisted header stored per-key in `ctx.kv('runs')` (~1–3 KiB typical). */
export type RunHeader = SubagentRunHeader | DslWorkflowRunHeader

/** Heavy per-run detail stored lazily on disk (`artifacts/<convId>/wf-<runId>.detail.json`). */
export interface RunDetail {
  id: string
  result?: unknown
  script?: string
  args?: unknown
  nodes?: WorkflowNodeState[]
  progress?: WorkflowProgressEntry[]
  subagentSpec?: PersistedSubagentSpec
  subagentMeta?: { agentType?: string; execution?: AgentExecutionInfo }
}

/** In-flight runtime handle held exclusively in `WorkflowService.active`. */
export interface ActiveRun {
  readonly runId: string
  readonly conversationId: number
  readonly abort: AbortController
  header: RunHeader
  detail: RunDetail
  done: Promise<void>
  writer?: JournalWriter
  nodesByIndex: Map<number, WorkflowNodeState>
  timeline: WorkflowProgressEntry[]
  pendingAborts: Set<Promise<void>>
  pendingExecs: Set<Promise<unknown>>
  childConversations: Set<number>
  lastPersistAt: number
  lastEventAt: number
  pendingEventTimer?: ReturnType<typeof setTimeout>
  userAborted?: boolean
  suspended?: boolean
  settleError?: unknown
  /** Latest derived summary snapshot. */
  summary: WorkflowRunSummary
}
