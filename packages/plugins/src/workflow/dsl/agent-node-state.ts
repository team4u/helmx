/**
 * dsl/agent-node-state.ts — Agent node state helpers shared by journal replay and live execution:
 * folding execution info into the node, the completed-label registry used by `agent({ resume })`,
 * `agent.withMeta` result shaping, and structured output parsing.
 */
import type { AgentExecutionInfo } from '@helmx/protocol'
import { extractWorktreeExecutionMeta, type WorkflowNodeState } from '../../contracts.js'
import { scopedResumeKey } from './boundary.js'
import type { AgentWithMetaResult, CompiledSchema, JournalAgentExecution, WorkflowGateResult } from './types.js'
import type { CompletedChild } from './runtime-shared.js'

export function parseStructuredOutput(text: string, compiled: CompiledSchema | undefined): unknown {
  if (compiled === undefined) return text
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function applyExecutionToNode(
  node: WorkflowNodeState,
  info: AgentExecutionInfo | JournalAgentExecution,
): void {
  if (info.nodeId !== undefined) node.nodeId = info.nodeId
  if (info.conversationId !== undefined) node.conversationId = info.conversationId
  if (info.executionId !== undefined) node.executionId = info.executionId
  if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
  if ('meta' in info && info.meta !== undefined) {
    const wt = extractWorktreeExecutionMeta(info)
    if (wt.worktree !== undefined) node.worktree = wt.worktree
  } else if ('worktree' in info && info.worktree !== undefined) {
    node.worktree = info.worktree as WorkflowNodeState['worktree']
  }
}

export function recordCompletedLabel(
  completedByLabel: Map<string, CompletedChild>,
  child: CompletedChild,
): void {
  completedByLabel.set(scopedResumeKey(child.workflowRootPath, child.label), child)
}

export function buildAgentWithMetaResult(params: {
  ok: boolean
  output: unknown
  attempts: number
  error?: string
  timedOut?: boolean
  execution?: JournalAgentExecution
  gate?: WorkflowGateResult
}): AgentWithMetaResult {
  return {
    ok: params.ok,
    output: params.output,
    attempts: params.attempts,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.timedOut === true ? { timedOut: true } : {}),
    ...(params.execution !== undefined ? { execution: params.execution as AgentWithMetaResult['execution'] } : {}),
    ...(params.gate !== undefined ? { gate: params.gate } : {}),
  }
}
