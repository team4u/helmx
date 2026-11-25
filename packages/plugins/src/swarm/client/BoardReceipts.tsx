/**
 * Compact 1-line timeline receipt pills for swarm:board-report & swarm:board-wakeup (Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helmx/protocol/browser'
import { Badge, resolveLocalizedText, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { parseBoardReportMeta, parseBoardWakeupMeta } from './board-model.ts'
import { SWARM_WORKBENCH_PANEL_ID } from './models.ts'
import { SW_BOARD_REPORT_PILL, SW_BOARD_WAKEUP_PILL, SW_PILL_OPEN_WORKBENCH, swReceiptCountLabel } from './copy.ts'

function seqRangeLabel(fromSeq: number | undefined, toSeq: number | undefined): string | undefined {
  if (fromSeq !== undefined && toSeq !== undefined && fromSeq !== toSeq) return `#${fromSeq}..#${toSeq}`
  const focus = toSeq ?? fromSeq
  return focus !== undefined ? `#${focus}` : undefined
}

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = parseBoardReportMeta(props)
  const seqLabel = seqRangeLabel(meta.fromSeq, meta.toSeq)
  const focusSeq = meta.toSeq ?? meta.fromSeq
  const headlineText = meta.headline !== undefined ? resolveLocalizedText(meta.headline, locale) : ''
  return (
    <button
      type="button"
      className="sw-receipt-pill"
      aria-label={resolveLocalizedText(SW_PILL_OPEN_WORKBENCH, locale)}
      onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_ID, focusSeq !== undefined ? { postSeq: focusSeq } : undefined)}
    >
      <Badge tone="accent" icon="network">
        {resolveLocalizedText(SW_BOARD_REPORT_PILL, locale)}
      </Badge>
      {seqLabel !== undefined ? <span className="sw-receipt-seq mono tabular-nums">{seqLabel}</span> : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
      {headlineText !== '' ? <span className="sw-receipt-headline" title={headlineText}>{headlineText}</span> : null}
    </button>
  )
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = parseBoardWakeupMeta(props)
  const seqLabel = seqRangeLabel(meta.fromSeq, meta.toSeq)
  const focusSeq = meta.toSeq ?? meta.fromSeq
  return (
    <button
      type="button"
      className="sw-receipt-pill"
      aria-label={resolveLocalizedText(SW_PILL_OPEN_WORKBENCH, locale)}
      onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_ID, focusSeq !== undefined ? { postSeq: focusSeq } : undefined)}
    >
      <Badge tone="neutral" icon="bell">
        {resolveLocalizedText(SW_BOARD_WAKEUP_PILL, locale)}
      </Badge>
      {meta.workerName ? (
        <Badge tone="neutral" mono title={`@${meta.workerName}`}>
          @{meta.workerName}
        </Badge>
      ) : null}
      {seqLabel !== undefined ? <span className="sw-receipt-seq mono tabular-nums">{seqLabel}</span> : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
    </button>
  )
}
