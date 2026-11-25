/**
 * Leaf 1Hz timer components isolating `useSharedNowMs` re-renders from parent
 * cards, trace rows, trays, and workbench panels.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import {
  Tooltip,
  formatCompactTimestamp,
  formatDurationMs,
  formatStopwatchMs,
  usePluginLocale,
  useSharedNowMs,
} from '@helmx/plugin-client'
import type { WorkflowRunSummary } from '../../contracts-types.js'
import {
  timingNodeTotalLine,
  timingSettledLine,
  timingStartedLine,
  timingWallLine,
  trayAwaitingElapsed,
} from './copy.js'
import { summarizeWorkflowTiming } from './execution-model.js'

export interface ElapsedClockProps {
  /** Whether the clock ticks at 1Hz via `useSharedNowMs`. */
  active: boolean
  /** Start timestamp (epoch ms) used when `active` is true. */
  startedAt?: number
  /** Frozen settled duration (ms) used when `active` is false. */
  settledMs?: number
  /** Optional prefix formatter (e.g. awaiting approval prefix). */
  awaitingApproval?: boolean
  className?: string
}

export function ElapsedClock(props: ElapsedClockProps): ReactNode {
  const locale = usePluginLocale()
  const nowMs = useSharedNowMs(props.active && props.startedAt !== undefined)
  let ms: number | undefined
  if (props.active) {
    if (props.startedAt !== undefined && nowMs !== undefined && nowMs >= props.startedAt) {
      ms = nowMs - props.startedAt
    }
  } else if (props.settledMs !== undefined && Number.isFinite(props.settledMs) && props.settledMs >= 0) {
    ms = props.settledMs
  }
  if (ms === undefined) return null
  const formatted = props.active ? formatStopwatchMs(ms) : formatDurationMs(ms)
  if (formatted === '') return null
  const text = props.awaitingApproval ? trayAwaitingElapsed(formatted, locale) : formatted
  return <span className={props.className ? `${props.className} tabular-nums` : 'tabular-nums'}>{text}</span>
}

export interface WorkflowTimingClockProps {
  run: WorkflowRunSummary
  className?: string
}

export function WorkflowTimingClock(props: WorkflowTimingClockProps): ReactNode {
  const locale = usePluginLocale()
  const live = props.run.status === 'running'
  const nowMs = useSharedNowMs(live)
  const timing = summarizeWorkflowTiming(props.run, nowMs)
  if (timing.wallElapsedMs === undefined) return null
  const wallText = live ? formatStopwatchMs(timing.wallElapsedMs) : formatDurationMs(timing.wallElapsedMs)
  if (wallText === '') return null
  const nodeTotalText =
    timing.measuredNodeCount > 1 && timing.nodeTotalDurationMs !== undefined
      ? live
        ? formatStopwatchMs(timing.nodeTotalDurationMs)
        : formatDurationMs(timing.nodeTotalDurationMs)
      : undefined

  const tooltip = (
    <div className="wf-timing-tooltip tabular-nums">
      <div>{timingWallLine(wallText, locale)}</div>
      {nodeTotalText ? <div>{timingNodeTotalLine(nodeTotalText, locale)}</div> : null}
      {timing.startedAt !== undefined ? <div>{timingStartedLine(formatCompactTimestamp(timing.startedAt), locale)}</div> : null}
      {timing.settledAt !== undefined ? <div>{timingSettledLine(formatCompactTimestamp(timing.settledAt), locale)}</div> : null}
    </div>
  )
  return (
    <Tooltip content={tooltip}>
      <span className={props.className ? `${props.className} tabular-nums` : 'tabular-nums'}>{wallText}</span>
    </Tooltip>
  )
}
