/**
 * Timeline 26px `.trace-row` renderer (`toolView` with `replaceRow: true`) for `switch_model`.
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
  resolveLocalizedText,
  usePluginLocale,
  useToolActivity,
  type StatusLightTone,
} from '@helmx/plugin-client'
import {
  extractFallbackSwitchModelTarget,
  extractFirstErrorLine,
  formatBorrowTargetLabel,
  parseSwitchModelPresentationMeta,
} from './borrow-models.ts'
import { TIERS_COPY as C, switchModelSummaryLabel } from './copy.ts'
import './styles.css'

export function SwitchModelToolRow(props: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parseSwitchModelPresentationMeta(props.presentationMeta)
  const isError = props.status === 'error' || props.isError === true
  const errorLine = isError ? extractFirstErrorLine(props.result) : undefined
  const toolTitle = t(C.toolSwitchModelTitle)

  let summary = ''
  if (meta !== undefined && !isError) {
    const targetDisplay = formatBorrowTargetLabel(meta.toLabel, meta.effort)
    summary = switchModelSummaryLabel(targetDisplay, meta.restoreAfterTurn, locale)
  } else {
    const fallbackTarget = extractFallbackSwitchModelTarget(props.input)
    if (isError) {
      summary = [fallbackTarget, errorLine ?? t(C.toolStatusError)].filter(Boolean).join(' · ')
    } else if (isRunning) {
      summary = fallbackTarget ?? ''
    } else {
      summary = fallbackTarget ?? ''
    }
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
        className={`trace-row tiers-trace-row${isError ? ' trace-row-error' : ''}`}
        data-tiers-switch-restore={
          meta !== undefined ? (meta.restoreAfterTurn ? 'true' : 'false') : undefined
        }
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={isRunning ? 'loader' : 'sparkles'}
            size={12}
            className={isRunning ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name tiers-trace-name" title={toolTitle}>
            {toolTitle}
          </span>
          {summary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' tiers-trace-error' : ''}`}
              title={meta !== undefined ? `${summary} (${meta.toModel})` : summary}
            >
              {summary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right tiers-trace-right">
          {!isRunning && !isError && meta !== undefined ? (
            <Badge
              tone={meta.restoreAfterTurn ? 'accent' : 'neutral'}
              className="tiers-trace-badge"
            >
              {t(
                meta.restoreAfterTurn
                  ? C.toolSwitchModelBadgeOneTurn
                  : C.toolSwitchModelBadgePermanent,
              )}
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
