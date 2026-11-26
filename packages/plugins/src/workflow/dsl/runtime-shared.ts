/**
 * dsl/runtime-shared.ts — Context contract and primitives shared by the host-side runtime modules
 * (agent config / replay / execute, action execute): the per-run `RuntimeSharedContext`, journal
 * record shapes, error text extraction, and the two-phase restart ready gate.
 */
import type { WorkflowNodeState } from '../../contracts.js'
import type { JournalReplay } from './journal.js'
import type { Semaphore } from './semaphore.js'
import type { JournalWriteInput, RunWorkflowOptions } from './types.js'

export interface CompletedChild {
  agentId: string
  label: string
  agentType: string
  workflowRootPath: string
  model?: string
  isolation?: 'worktree'
  resumeRef?: string
  replayed?: true
}

/** Records one `agent` terminal row of this run; the scope is supplied by the caller. */
export type RecordAgentAttempt = (
  entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>,
) => Promise<void>

export type ActionJournalPayload =
  | Omit<Extract<JournalWriteInput, { type: 'action' }>, 'scopePath' | 'scopeCallIndex'>
  | Omit<Extract<JournalWriteInput, { type: 'action_started' }>, 'scopePath' | 'scopeCallIndex'>

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Fatal answer for a call whose run was aborted or stopped before the call could proceed. */
export function respondWorkflowAborted(ctx: RuntimeSharedContext, callId: number): void {
  ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
}

export async function waitReadyGate(
  gate: Promise<void> | undefined,
  onEnter: () => void,
  onLeave: () => void,
): Promise<void> {
  if (gate === undefined) return
  onEnter()
  try {
    await gate
  } finally {
    onLeave()
  }
}

export interface RuntimeSharedContext {
  options: RunWorkflowOptions
  host: RunWorkflowOptions['host']
  redactText: (text: string) => string
  semaphore: Semaphore
  replay: JournalReplay
  inPlaceResume: boolean
  retryFailedCalls: boolean
  appendJournal: NonNullable<RunWorkflowOptions['journal']>['append']
  agentCap: number
  actionCap: number
  nodesByIndex: Map<number, WorkflowNodeState>
  inflightAgents: Set<string>
  inflightActions: Set<Promise<void>>
  inflightActionWrites: Set<Promise<void>>
  completedByLabel: Map<string, CompletedChild>
  openLaunches: Map<number, string>
  pendingNativeReattaches: Set<string>
  isAborted: () => boolean
  isWorkerStopped: () => boolean
  isSettled: () => boolean
  isSuspended: () => boolean
  nextCallIndex: () => number
  agentCount: () => number
  incrementAgentCount: () => void
  actionCount: () => number
  incrementActionCount: () => void
  incrementReplayedCount: () => void
  emitNode: (index: number, node: WorkflowNodeState) => void
  recordAgentBestEffort: (entry: JournalWriteInput) => Promise<void>
  respond: (callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean) => void
  enterReadyGate: () => void
  leaveReadyGate: () => void
  enterNativeReattachSetup: () => void
  leaveNativeReattachSetup: () => void
  fireReattachHorizon: () => void
}
