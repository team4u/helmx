/**
 * dsl/types.ts — Pure deterministic DSL engine contracts (zero kernel/storage dependencies).
 */
import type { AgentExecutionInfo, AgentGateResult } from '@helmx/protocol'
import type {
  WorkflowNodeState,
  WorkflowProgressEntry,
  WorktreeExecutionDescriptor,
} from '../../contracts.js'

export interface WorkflowPhaseMeta {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}

export interface MetaExtraction {
  meta: WorkflowMeta
  body: string
}

export interface JournalScope {
  scopePath: string
  scopeCallIndex: number
}

export interface JournalAgentExecution {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: Record<string, unknown>
}

export type WorkflowGateResult = AgentGateResult

export interface AgentWithMetaExecution {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: WorktreeExecutionDescriptor
}

export interface AgentWithMetaResult<T = unknown> {
  ok: boolean
  output: T | null
  attempts: number
  error?: string
  timedOut?: boolean
  execution?: AgentWithMetaExecution
  gate?: WorkflowGateResult
}

export type JournalWriteInput = JournalScope & (
  | {
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      resumed?: true
      execution?: JournalAgentExecution
      gate?: WorkflowGateResult
      attempt?: number
      prompt?: string
      error?: string
      timedOut?: boolean
      seq?: number
    }
  | {
      type: 'agent_started'
      index: number
      key: string
      attempt?: number
      requestId: string
      execution: JournalAgentExecution
      seq?: number
    }
  | {
      type: 'action_started'
      index: number
      key: string
      seq?: number
      idempotent?: true
    }
  | {
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      seq?: number
      idempotent?: true
    }
)

export type WorkflowJournalEntry = JournalScope & (
  | {
      type: 'agent'
      v: 1
      seq: number
      index: number
      key: string
      ok: boolean
      text?: string
      resumed?: true
      execution?: JournalAgentExecution
      gate?: WorkflowGateResult
      attempt?: number
      prompt?: string
      error?: string
      timedOut?: boolean
    }
  | {
      type: 'agent_started'
      v: 1
      seq: number
      index: number
      key: string
      attempt?: number
      requestId: string
      execution: JournalAgentExecution
    }
  | {
      type: 'action_started'
      v: 1
      seq: number
      index: number
      key: string
      idempotent?: true
    }
  | {
      type: 'action'
      v: 1
      seq: number
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      idempotent?: true
    }
)

export interface CompiledSchema {
  readonly schema: Record<string, unknown>
  check(value: unknown): true | string
}

export interface WorkflowSpawnRequest {
  agentId: string
  index: number
  prompt: string
  label: string
  agentType: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  phaseIndex?: number
  phaseTitle?: string
  gate?: string
  gateTimeoutMs?: number
  timeoutMs?: number
  schema?: CompiledSchema
  attachments?: string[]
  maxSubagentDepth?: number
  nodeId?: string
  cwd?: string
  requestId?: string
  reattach?: {
    conversationId: number
    effectiveCwd?: string
  }
  resumeRef?: string
  onResolved?: (info: AgentExecutionInfo) => void
  onGateResult?: (gate: WorkflowGateResult) => void
}

export interface WorkflowSpawnResult {
  ok: boolean
  text?: string
  error?: string
  timedOut?: boolean
  executionInfo?: AgentExecutionInfo
  gate?: WorkflowGateResult
}

export interface ResumeAgentOptions {
  resumeRef?: string
  requestId?: string
  schema?: CompiledSchema
  gate?: string
  gateTimeoutMs?: number
  timeoutMs?: number
  attachments?: string[]
  maxSubagentDepth?: number
  onResolved?: (info: AgentExecutionInfo) => void
  onGateResult?: (gate: WorkflowGateResult) => void
}

export interface WorkflowScriptRef {
  name?: string
  scriptPath?: string
}

export type WorkflowScriptSource =
  | { ok: true; script: string; path?: string }
  | { ok: false; message: string }

export interface WorkflowHost {
  spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>
  resumeAgent?(agentId: string, prompt: string, options?: ResumeAgentOptions): Promise<WorkflowSpawnResult>
  abortAgent(agentId: string): void
  runGate?(
    command: string,
    options: { agentId: string; cwd?: string; gateTimeoutMs?: number },
  ): Promise<WorkflowGateResult>
  prepareAction?(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }>
  invokeAction(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; result: unknown }>
  loadWorkflow?(ref: WorkflowScriptRef): Promise<WorkflowScriptSource> | WorkflowScriptSource
}

export type WorkflowRuntimeEvent =
  | { type: 'node'; node: WorkflowNodeState }
  | { type: 'phase'; index: number; title: string; at: number }
  | { type: 'log'; message: string; at: number }

export interface RunWorkflowOptions {
  runId?: string
  script: string
  args?: unknown
  host: WorkflowHost
  signal?: AbortSignal
  isSuspended?: () => boolean
  /** Optional startup gate: when provided, live actions and fresh agents wait until the host is ready (reconcile). */
  runtimeReadyGate?: Promise<void>
  /** Fires once all unsettled native `agent_started` children have triggered `onResolved` (or the worker settles/blocks). */
  onReattachHorizon?: () => void
  concurrency?: number
  agentCap?: number
  actionCap?: number
  timelineCap?: number
  itemCap?: number
  nestedCap?: number
  redact?: (text: string) => string
  onEvent?: (event: WorkflowRuntimeEvent) => void
  journal?: {
    entries?: readonly WorkflowJournalEntry[]
    inPlaceResume?: boolean
    retryFailedCalls?: boolean
    append?: (entry: JournalWriteInput) => Promise<void> | void
  }
}

export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'killed'
  value?: unknown
  error?: string
  meta: WorkflowMeta
  nodes: WorkflowNodeState[]
  timeline: WorkflowProgressEntry[]
  agentCount: number
  replayedCount: number
  journalIoErrors?: string[]
}

export interface WorkerAgentCallPayload {
  workflowRootPath: string
  scopePath: string
  scopeCallIndex: number
  prompt: unknown
  opts: unknown
  withMeta?: boolean
  goalMode?: boolean
  ambientPhaseIndex?: number
  ambientPhaseTitle?: string
  scopePrefix?: string
}

export interface WorkerActionCallPayload {
  scopePath: string
  scopeCallIndex: number
  actionId: unknown
  input: unknown
  opts: unknown
  ambientPhaseIndex?: number
  ambientPhaseTitle?: string
  scopePrefix?: string
}

export type WorkerMessage =
  | { type: 'progress'; entries: Array<{ type: 'workflow_phase'; index: number; title: string } | { type: 'workflow_log'; message: string }> }
  | { type: 'call'; callId: number; method: 'agent'; payload: WorkerAgentCallPayload }
  | { type: 'call'; callId: number; method: 'action'; payload: WorkerActionCallPayload }
  | { type: 'call'; callId: number; method: 'workflow'; payload: WorkflowScriptRef }
  | { type: 'complete'; resultJson?: string }
  | { type: 'error'; message: string; stack?: string }
