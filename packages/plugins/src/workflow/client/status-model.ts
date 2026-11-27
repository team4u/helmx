/**
 * Unified workflow status and title resolution model (`aborted` preserved honestly — never collapsed to done).
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/ui'
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
import {
  COPY,
  fallbackConversationTitle,
  traceResumeFallbackLabel,
  type ExecutionStatusKey,
} from './copy.js'
import {
  asPlainRecord,
  extractCleanPreviewLine,
  firstLineOf,
  inputString,
  isPlaceholderNodeLabel,
  isPlaceholderRunName,
  isPlaceholderSubagentTitle,
} from './parsers.js'

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

export const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  blocked: 0,
  working: 1,
  error: 2,
  aborted: 3,
  pending: 4,
  done: 5,
}

export function aggregateStatuses(statuses: ReadonlyArray<ExecutionStatus>): ExecutionStatus {
  const first = statuses[0]
  if (first === undefined) return 'pending'
  let best: ExecutionStatus = first
  for (let i = 1; i < statuses.length; i++) {
    const s = statuses[i]
    if (s !== undefined && STATUS_PRIORITY[s] < STATUS_PRIORITY[best]) best = s
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
    return {
      text: input.runNode?.label || input.runNode?.id || resolveLocalizedText(COPY.actionLabel, locale),
      isFallback: true,
    }
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
  if (input.toolLabel !== undefined && !isPlaceholderNodeLabel(input.toolLabel)) {
    const cleaned = extractCleanPreviewLine(input.toolLabel, 60)
    if (cleaned !== '') return { text: cleaned, isFallback: false }
  }
  const runNodeLabel = input.runNode?.label
  if (runNodeLabel !== undefined && !isPlaceholderNodeLabel(runNodeLabel)) {
    const cleaned = extractCleanPreviewLine(runNodeLabel, 60)
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
