/**
 * Timeline 26px `.trace-row` renderer (`toolView` with `replaceRow: true`) for
 * `exit_plan_mode` and `hand_back_to_planner`.
 * Strictly consumes `props.presentationMeta` (never `JSON.parse(props.result)`).
 * Exports only React components (Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helmx/protocol/browser'
import {
  Badge,
  HelmxIcon,
  StatusLight,
  formatDurationMs,
  type StatusLightTone,
} from '@helmx/ui'
import { formatModelShortName, usePluginLocale, usePluginTranslator, useToolActivity } from '@helmx/plugin-client'
import { DUO_COPY, formatDuoTransitionSummary } from './copy.ts'
import { DUO_EXIT_PLAN_MODE_TOOL, extractFirstLine, parseDuoTransitionMeta } from './models.ts'
import './styles.css'

export function DuoTransitionToolRow(props: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parseDuoTransitionMeta(props.presentationMeta)
  const isError = props.status === 'error' || props.isError === true
  const errorLine = isError ? extractFirstLine(props.result) : undefined
  const isExitPlan = (meta?.tool ?? props.toolName) === DUO_EXIT_PLAN_MODE_TOOL
  const toolTitle = isExitPlan ? t(DUO_COPY.toolExitPlanTitle) : t(DUO_COPY.toolHandBackTitle)

  let summary = ''
  if (meta !== undefined && !isError) {
    const toShort = formatModelShortName(meta.toModel) || meta.toModel
    summary = formatDuoTransitionSummary(meta.tool, toShort, meta.reason, locale)
  } else if (isError) {
    summary = errorLine ?? t(DUO_COPY.toolStatusError)
  } else if (isRunning && props.input && typeof props.input === 'object') {
    const rawReason = (props.input as Record<string, unknown>)['reason']
    if (typeof rawReason === 'string' && rawReason.trim() !== '') {
      summary = rawReason.trim()
    }
  }

  let lightTone: StatusLightTone
  let lightLabel: string
  if (isRunning) {
    lightTone = 'working'
    lightLabel = t(DUO_COPY.toolStatusRunning)
  } else if (isError) {
    lightTone = 'failed'
    lightLabel = t(DUO_COPY.toolStatusError)
  } else {
    lightTone = 'done'
    lightLabel = t(isExitPlan ? DUO_COPY.toolPhaseExec : DUO_COPY.toolPhasePlan)
  }

  const durationText =
    !isRunning && props.durationMs !== undefined ? formatDurationMs(props.durationMs) : ''

  return (
    <div className="trace-entry">
      <div
        className={`trace-row duo-trace-row${isError ? ' trace-row-error' : ''}`}
        data-duo-tool={meta?.tool ?? props.toolName}
        data-duo-to-phase={meta?.toPhase}
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={isRunning ? 'loader' : 'workflow'}
            size={12}
            className={isRunning ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name duo-trace-name" title={toolTitle}>
            {toolTitle}
          </span>
          {summary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' duo-trace-error' : ''}`}
              title={meta !== undefined ? `${meta.fromModel} -> ${meta.toModel}` : summary}
            >
              {summary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right duo-trace-right">
          {!isRunning && !isError && meta !== undefined ? (
            <Badge
              tone={meta.toPhase === 'execution' ? 'accent' : 'neutral'}
              className="duo-trace-badge"
            >
              {t(meta.toPhase === 'execution' ? DUO_COPY.toolPhaseExec : DUO_COPY.toolPhasePlan)}
            </Badge>
          ) : null}
          <StatusLight tone={lightTone} label={lightLabel} />
          {durationText !== '' ? (
            <span className="trace-duration tabular-nums">{durationText}</span>
          ) : null}
        </span>
      </div>
    </div>
  )
}
