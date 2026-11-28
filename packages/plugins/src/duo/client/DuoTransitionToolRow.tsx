import type { ReactNode } from 'react'
import { Badge, HelmxIcon } from '@helmx/ui'
import { usePluginLocale, usePluginTranslator } from '@helmx/plugin-client'
import type { ToolViewProps } from '@helmx/protocol/browser'
import { DUO_COPY, formatDuoTransitionSummary } from './copy.ts'
import { DUO_EXIT_PLAN_MODE_TOOL, extractFirstLine, parseDuoTransitionMeta } from './models.ts'
import './styles.css'

export function DuoTransitionToolRow({
  toolName,
  status,
  input,
  result,
  isError,
  presentationMeta,
}: ToolViewProps): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const meta = parseDuoTransitionMeta(presentationMeta)

  const iconName =
    status === 'error' || isError
      ? 'alert-circle'
      : status === 'running'
        ? 'loader-2'
        : toolName === DUO_EXIT_PLAN_MODE_TOOL
          ? 'play'
          : 'rotate-ccw'

  const heading =
    toolName === DUO_EXIT_PLAN_MODE_TOOL ? t(DUO_COPY.toolToExecution) : t(DUO_COPY.toolToPlanning)

  let summaryText = heading
  if (meta) {
    summaryText = formatDuoTransitionSummary(meta.tool, meta.fromModel, meta.toModel, locale)
  } else if (status === 'error' || isError) {
    summaryText = extractFirstLine(result) ?? heading
  } else if (status === 'running') {
    const reasonPreview =
      input && typeof input === 'object' && typeof (input as Record<string, unknown>)['reason'] === 'string'
        ? String((input as Record<string, unknown>)['reason']).trim()
        : ''
    summaryText = reasonPreview ? `${heading} · ${reasonPreview}` : heading
  }

  return (
    <div className="duo-transition-row" data-status={status}>
      <HelmxIcon name={iconName} size={13} />
      <span className="duo-transition-summary">{summaryText}</span>
      {meta?.reason && <Badge tone="neutral">{meta.reason}</Badge>}
    </div>
  )
}
