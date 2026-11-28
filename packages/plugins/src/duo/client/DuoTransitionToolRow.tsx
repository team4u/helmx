/**
 * Timeline 26px `.trace-row` renderer (`toolView` with `replaceRow: true`) for
 * `exit_plan_mode` and `hand_back_to_planner`.
 * Strictly consumes `props.presentationMeta` (never `JSON.parse(props.result)`).
 * Exports only React components and TS types (Fast Refresh compliant).
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
import {
  formatModelShortName,
  usePluginLocale,
  usePluginTranslator,
  useToolActivity,
} from '@helmx/plugin-client'
import { DUO_COPY as C, duoTransitionSummary } from './copy.ts'
import {
  DUO_EXIT_PLAN_MODE_TOOL,
  extractFallbackTransitionInfo,
  extractFirstErrorLine,
  parseDuoTransitionPresentationMeta,
} from './models.ts'
import './styles.css'

export function DuoTransitionToolRow(props: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parseDuoTransitionPresentationMeta(props.presentationMeta)
  const isError = props.status === 'error' || props.isError === true
  const errorLine = isError
    ? extractFirstErrorLine(typeof props.result === 'string' ? props.result : undefined)
    : undefined
  const isExitPlan = (meta?.tool ?? props.toolName) === DUO_EXIT_PLAN_MODE_TOOL

  const toolTitle = t(isExitPlan ? C.toolExitPlanTitle : C.toolHandBackTitle)

  let summary = ''
  if (meta !== undefined && !isError) {
    const toShort = formatModelShortName(meta.toModel)
    summary = duoTransitionSummary(meta.tool, toShort, meta.reason, locale)
  } else {
    const fallback = extractFallbackTransitionInfo(props.input)
    summary = isError
      ? [fallback, errorLine ?? t(C.toolStatusError)].filter(Boolean).join(' · ')
      : fallback ?? ''
  }

  let lightTone: StatusLightTone
  let lightLabel: string
  if (isRunning) {
    lightTone = 'working'
    lightLabel = t(C.toolStatusRunning)
  } else if (isError) {
    lightTone = 'failed'
    lightLabel = t(C.toolStatusError)
  } else {
    lightTone = 'done'
    lightLabel = t(C.toolStatusDone)
  }

  const durationText =
    !isRunning && props.durationMs !== undefined ? formatDurationMs(props.durationMs) : ''

  return (
    <div className="trace-entry">
      <div
        className={`trace-row duo-trace-row${isError ? ' trace-row-error' : ''}`}
        data-duo-transition={meta?.tool ?? props.toolName}
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={isRunning ? 'loader' : isExitPlan ? 'arrow-right' : 'arrow-left'}
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
              {t(meta.toPhase === 'execution' ? C.toolPhaseExec : C.toolPhasePlan)}
            </Badge>
          ) : null}
          {durationText !== '' ? <span className="trace-tool-duration">{durationText}</span> : null}
          <StatusLight tone={lightTone} label={lightLabel} />
        </span>
      </div>
    </div>
  )
}
