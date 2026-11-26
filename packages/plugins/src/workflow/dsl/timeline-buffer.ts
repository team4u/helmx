/**
 * dsl/timeline-buffer.ts — Bounded ring buffer of workflow progress entries that also fans each
 * entry out live as a `phase` / `log` runtime event.
 */
import type { WorkflowProgressEntry } from '../../contracts.js'
import type { RunWorkflowOptions } from './types.js'

export interface TimelineBuffer {
  emit: (entry: WorkflowProgressEntry) => void
  snapshot: () => WorkflowProgressEntry[]
}

export function createTimelineBuffer(
  timelineCap: number,
  onEvent: RunWorkflowOptions['onEvent'],
): TimelineBuffer {
  const ring: Array<WorkflowProgressEntry | undefined> = []
  let head = 0
  let size = 0

  return {
    emit(entry) {
      if (size < timelineCap) {
        ring.push(entry)
        size++
      } else {
        ring[head] = entry
        head = (head + 1) % timelineCap
      }
      if (entry.kind === 'phase') {
        onEvent?.({ type: 'phase', index: entry.index, title: entry.title, at: entry.at })
      } else {
        onEvent?.({ type: 'log', message: entry.message, at: entry.at })
      }
    },
    snapshot() {
      if (size < timelineCap || head === 0) {
        return ring.slice(0, size) as WorkflowProgressEntry[]
      }
      return [
        ...(ring.slice(head) as WorkflowProgressEntry[]),
        ...(ring.slice(0, head) as WorkflowProgressEntry[]),
      ]
    },
  }
}
