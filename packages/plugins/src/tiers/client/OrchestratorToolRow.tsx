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
  formatModelShortName,
  resolveLocalizedText,
  usePluginLocale,
  useToolActivity,
  type StatusLightTone,
} from '@helmx/plugin-client'
import { extractFirstErrorLine } from './borrow-models.ts'
import { TIERS_COPY as C, orchestratorTransitionSummary } from './copy.ts'
import { TIERS_EXIT_PLAN_MODE_TOOL, parseOrchestratorTransitionMeta } from './orchestrator-models.ts'
import './styles.css'

export function OrchestratorToolRow(props: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parseOrchestratorTransitionMeta(props.presentationMeta)
  const isError = props.status === 'error' || props.isError === true
  const errorLine = isError ? extractFirstErrorLine(props.result) : undefined
  const isExitPlan = (meta?.tool ?? props.toolName) === TIERS_EXIT_PLAN_MODE_TOOL
  const toolTitle = isExitPlan ? t(C.toolExitPlanTitle) : t(C.toolHandBackTitle)

  let summary = ''
  if (meta !== undefined && !isError) {
    const toShort = formatModelShortName(meta.toModel) || meta.toModel
    summary = orchestratorTransitionSummary(meta.tool, toShort, meta.reason, locale)
  } else if (isError) {
    summary = errorLine ?? t(C.toolStatusError)
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
    lightLabel = t(C.toolOrchPhaseExec)
    if (!isExitPlan) lightLabel = t(C.toolOrchPhasePlan)
  }

  const durationText =
    !isRunning && props.durationMs !== undefined ? formatDurationMs(props.durationMs) : ''

  return (
    <div className="trace-entry">
      <div
        className={`trace-row tiers-trace-row${isError ? ' trace-row-error' : ''}`}
        data-tiers-orchestrator-tool={meta?.tool ?? props.toolName}
        data-tiers-orchestrator-to-phase={meta?.toPhase}
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={isRunning ? 'loader' : 'workflow'}
            size={12}
            className={isRunning ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name tiers-trace-name" title={toolTitle}>
            {toolTitle}
          </span>
          {summary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' tiers-trace-error' : ''}`}
              title={meta !== undefined ? `${meta.fromModel} -> ${meta.toModel}` : summary}
            >
              {summary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right tiers-trace-right">
          {!isRunning && !isError && meta !== undefined ? (
            <Badge
              tone={meta.toPhase === 'execution' ? 'accent' : 'neutral'}
              className="tiers-trace-badge"
            >
              {t(meta.toPhase === 'execution' ? C.toolOrchPhaseExec : C.toolOrchPhasePlan)}
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
