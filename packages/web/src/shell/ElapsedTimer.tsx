/**
 * Leaf 1Hz stopwatch component (`useSharedNowMs`) shared by ConversationOverview
 * and SidebarConversationList so live timers isolate re-renders to individual text spans.
 */
import type { ReactNode } from 'react'
import { useSharedNowMs } from '@helmx/plugin-client'
import { formatStopwatchMs } from '../lib/format.js'

export interface ElapsedTimerProps {
  since?: number
  prefixLabel?: string
  formatText?: (formattedDuration: string) => string
  className: string
  separatorClassName?: string
  leadingSeparator?: boolean
  trailingSeparator?: boolean
}

export function ElapsedTimer({
  since,
  prefixLabel,
  formatText,
  className,
  separatorClassName = 'overview-card-sub-sep',
  leadingSeparator = false,
  trailingSeparator = false,
}: ElapsedTimerProps): ReactNode {
  const nowMs = useSharedNowMs(since !== undefined)
  if (since === undefined || nowMs === undefined) {
    if (prefixLabel !== undefined) {
      return (
        <span className={className} title={prefixLabel}>
          {prefixLabel}
        </span>
      )
    }
    return leadingSeparator && trailingSeparator ? (
      <span className={separatorClassName} aria-hidden="true">
        ·
      </span>
    ) : null
  }
  const formatted = formatStopwatchMs(Math.max(0, nowMs - since))
  const text = prefixLabel !== undefined
    ? `${prefixLabel} ${formatted}`
    : formatText !== undefined
      ? formatText(formatted)
      : formatted
  return (
    <>
      {leadingSeparator && (
        <span className={separatorClassName} aria-hidden="true">
          ·
        </span>
      )}
      <span className={className} title={prefixLabel !== undefined ? text : undefined}>
        {text}
      </span>
      {trailingSeparator && (
        <span className={separatorClassName} aria-hidden="true">
          ·
        </span>
      )}
    </>
  )
}
