/**
 * Phase sections, timeline logs, node stat chips, and resumability helpers.
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/ui'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
import { COPY } from './copy.js'
import { formatShortModelName } from './parsers.js'
import type { ExecutionStatus } from './status-model.js'

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
  if (nodes.every((n) => n.status === 'pending')) return 'pending'
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
