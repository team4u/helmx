/**
 * Unified inline loading-state primitive (host + plugin shared).
 *
 * Reuses the host .loading-state and .spin-slow vocabulary with role="status",
 * eliminating per-plugin DocLoading boilerplate. No portal, no window access —
 * renderToString works directly.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { CSSProperties, ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface LoadingStateProps {
  /** Loading message (defaults to the shared UI locale "Loading…"). */
  label?: ReactNode
  /** Spinner icon size in px (defaults to 12). */
  iconSize?: number
  /** Extra classes appended to .loading-state. */
  className?: string
  style?: CSSProperties
}

export function LoadingState(props: LoadingStateProps): ReactNode {
  const t = usePluginTranslator()
  const {
    label = t(uiCopy.loading),
    iconSize = 12,
    className,
    style,
  } = props
  return (
    <div className={joinClass('loading-state', className)} role="status" style={style}>
      <HelmxIcon name="loader" size={iconSize} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}
