/**
 * Timeline 26px `.trace-row` renderer (`toolView` with `replaceRow: true`) for `update_steps`.
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
  resolveLocalizedText,
  usePluginLocale,
  useToolActivity,
  type BadgeTone,
  type StatusLightTone,
} from '@helmx/plugin-client'
import { STEPS_COPY, stepsToolRowSummary } from './copy.ts'
import { extractFirstErrorLine, parseStepsToolPresentationMeta } from './models.ts'

export function StepsToolRow(props: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parseStepsToolPresentationMeta(props.presentationMeta)
  const isError = props.status === 'error' || props.isError === true
  const errorLine = isError ? extractFirstErrorLine(props.result) : undefined
  const toolTitle = t(STEPS_COPY.toolTitle)

  let summary = ''
  if (isError) {
    summary = errorLine ?? t(STEPS_COPY.toolStatusError)
  } else if (meta !== undefined) {
    summary = stepsToolRowSummary(meta, locale)
  } else if (!isRunning) {
    summary = t(STEPS_COPY.toolFallbackUnavailable)
  }

  let lightTone: StatusLightTone
  let lightLabel: string
  if (isRunning) {
    lightTone = 'working'
    lightLabel = t(STEPS_COPY.toolStatusRunning)
  } else if (isError) {
    lightTone = 'failed'
    lightLabel = t(STEPS_COPY.toolStatusError)
  } else if (meta !== undefined && !meta.cleared && meta.failedCount > 0) {
    lightTone = 'failed'
    lightLabel = t(STEPS_COPY.statusFailed)
  } else {
    lightTone = 'done'
    lightLabel = t(STEPS_COPY.toolStatusDone)
  }

  let badgeTone: BadgeTone | undefined
  let badgeText: string | undefined
  if (!isRunning && !isError && meta !== undefined && !meta.cleared) {
    badgeText = `${meta.done}/${meta.total}`
    badgeTone = meta.failedCount > 0 ? 'err' : meta.allTerminal ? 'ok' : 'accent'
  }

  const durationText =
    !isRunning && props.durationMs !== undefined ? formatDurationMs(props.durationMs) : ''

  return (
    <div className="trace-entry">
      <div
        className={`trace-row steps-trace-row${isError ? ' trace-row-error' : ''}`}
        data-steps-tool-version={meta?.version}
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={isRunning ? 'loader' : 'check-square'}
            size={12}
            className={isRunning ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name steps-trace-name" title={toolTitle}>
            {toolTitle}
          </span>
          {summary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' steps-trace-error' : ''}`}
              title={summary}
            >
              {summary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right steps-trace-right">
          {badgeText !== undefined && badgeTone !== undefined ? (
            <Badge tone={badgeTone} mono className="steps-trace-badge tabular-nums">
              {badgeText}
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
