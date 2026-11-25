/**
 * Timeline 26px `.trace-row` renderer (`toolView` with `replaceRow: true`) for
 * `plan_save` and `plan_propose`.
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
  usePluginContext,
  usePluginLocale,
  useToolActivity,
  type BadgeTone,
  type StatusLightTone,
} from '@helmx/plugin-client'
import {
  PLAN_COPY,
  planOutcomeLabel,
  planSaveStatsLabel,
  planVersionLabel,
} from './copy.ts'
import {
  extractFallbackToolTitle,
  extractFirstErrorLine,
  parsePlanToolPresentationMeta,
  resolveProposeOutcomeBadgeTone,
  resolveProposeOutcomeLightTone,
} from './models.ts'
import { PLAN_PANEL_ID, PLAN_TOOL_PROPOSE, PLAN_TOOL_SAVE } from './types.ts'

export function PlanToolRow(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const isRunning = props.status === 'running'
  useToolActivity(props.callId, isRunning)

  const meta = parsePlanToolPresentationMeta(props.presentationMeta)
  const isProposeError = meta?.kind === 'propose' && meta.outcome === 'error'
  const isError = props.status === 'error' || props.isError === true || isProposeError
  const errorLine = isError ? extractFirstErrorLine(props.result) : undefined

  const toolTitle =
    props.toolName === PLAN_TOOL_SAVE
      ? t(PLAN_COPY.toolSaveTitle)
      : props.toolName === PLAN_TOOL_PROPOSE
        ? t(PLAN_COPY.toolProposeTitle)
        : props.toolName

  const iconName = isRunning
    ? 'loader'
    : props.toolName === PLAN_TOOL_SAVE
      ? 'save'
      : 'list-tree'

  let summary = ''
  if (meta !== undefined) {
    if (meta.kind === 'save') {
      const stats = planSaveStatsLabel(meta.lineCount, meta.charCount, locale)
      summary = errorLine ? `${meta.title} · ${errorLine}` : `${meta.title} · ${stats}`
    } else {
      const parts = [meta.title]
      if (meta.outcome === 'approved_handoff' && meta.executionModel) {
        parts.push(meta.executionModel)
      }
      if (errorLine && meta.outcome === 'error') {
        parts.push(errorLine)
      }
      summary = parts.join(' · ')
    }
  } else {
    const inputTitle = extractFallbackToolTitle(props.input)
    if (isError) {
      summary = [inputTitle, errorLine ?? t(PLAN_COPY.toolStatusError)].filter(Boolean).join(' · ')
    } else if (isRunning) {
      summary = inputTitle ?? ''
    } else {
      summary = [inputTitle, t(PLAN_COPY.toolFallbackUnavailable)].filter(Boolean).join(' · ')
    }
  }

  let lightTone: StatusLightTone
  let lightLabel: string
  if (isRunning) {
    lightTone = 'working'
    lightLabel = t(PLAN_COPY.toolStatusRunning)
  } else if (meta?.kind === 'propose') {
    lightTone = resolveProposeOutcomeLightTone(meta.outcome)
    lightLabel = planOutcomeLabel(meta.outcome, locale)
  } else if (isError) {
    lightTone = 'failed'
    lightLabel = t(PLAN_COPY.toolStatusError)
  } else {
    lightTone = 'done'
    lightLabel = meta?.kind === 'save' ? t(PLAN_COPY.toolStatusSaved) : t(PLAN_COPY.toolStatusDone)
  }

  let outcomeBadge: { tone: BadgeTone; text: string } | undefined
  if (!isRunning && meta?.kind === 'propose') {
    outcomeBadge = {
      tone: resolveProposeOutcomeBadgeTone(meta.outcome),
      text: planOutcomeLabel(meta.outcome, locale),
    }
  }

  const versionText = meta !== undefined ? planVersionLabel(meta.version) : undefined
  const durationText =
    !isRunning && props.durationMs !== undefined ? formatDurationMs(props.durationMs) : ''

  const ariaLabel = [toolTitle, summary, versionText, lightLabel, t(PLAN_COPY.toolOpenWorkbench)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row plan-trace-row${isError ? ' trace-row-error' : ''}`}
        aria-label={ariaLabel}
        onClick={() => ctx.openWorkbench(PLAN_PANEL_ID)}
      >
        <span className="trace-row-left">
          <HelmxIcon
            name={iconName}
            size={12}
            className={isRunning ? 'spin-slow' : undefined}
          />
          <span className="trace-tool-name plan-trace-name" title={toolTitle}>
            {toolTitle}
          </span>
          {summary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' plan-trace-error' : ''}`}
              title={summary}
            >
              {summary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right plan-trace-right">
          {versionText !== undefined ? (
            <Badge tone="neutral" mono className="plan-trace-badge">
              {versionText}
            </Badge>
          ) : null}
          {outcomeBadge !== undefined ? (
            <Badge tone={outcomeBadge.tone} className="plan-trace-badge">
              {outcomeBadge.text}
            </Badge>
          ) : null}
          <StatusLight tone={lightTone} label={lightLabel} />
          {durationText !== '' ? (
            <span className="trace-duration tabular-nums">{durationText}</span>
          ) : null}
          <HelmxIcon name="chevron-right" size={11} className="trace-row-chevron" />
        </span>
      </button>
    </div>
  )
}
