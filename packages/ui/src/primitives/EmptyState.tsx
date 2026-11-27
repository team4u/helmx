/**
 * Unified empty-state primitive (host primary centers + plugins + workbench shared).
 *
 * Reuses the host common .empty-state vocabulary (centered column, muted
 * hierarchy, optional icon / title / hint / action slot, compact and prominent
 * stage densities) — no new CSS theme. Pure presentation, no data access, SSR
 * safe (no portal, no window access).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderable(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

export interface EmptyStateProps {
  /** Primary line (entity-level "no data yet" copy). */
  title?: ReactNode
  /** Secondary explanation line (.empty-state-hint). */
  hint?: ReactNode
  /** De-emphasize the hint line further with .text-subtle. */
  hintSubtle?: boolean
  /** Optional leading icon: HelmxIcon name string or custom ReactNode (.empty-state-icon). */
  icon?: string | ReactNode
  /** Icon pixel size when `icon` is a HelmxIcon name string (defaults to 28 when `prominent`, 16 when `compact`, else 20). */
  iconSize?: number
  /** Optional action cluster below the hint (e.g. a reset or create Button; wrapped in .empty-state-action). */
  action?: ReactNode
  /** Compact density for tray / panel-sized surfaces (.empty-state-compact). */
  compact?: boolean
  /** Stage-level prominent density with circular 48px icon badge and 60px vertical rhythm (.empty-state-prominent). */
  prominent?: boolean
  className?: string
  /** Extra content below title/hint/action (fallback body for plain one-liners). */
  children?: ReactNode
}

/** Centered empty / placeholder block over the host .empty-state common classes. */
export function EmptyState(props: EmptyStateProps): ReactNode {
  const {
    title,
    hint,
    hintSubtle = false,
    icon,
    iconSize,
    action,
    compact = false,
    prominent = false,
    className,
    children,
  } = props
  const densityClass = compact
    ? 'empty-state-compact'
    : prominent
      ? 'empty-state-prominent'
      : undefined
  const resolvedIconSize = iconSize ?? (prominent ? 28 : compact ? 16 : 20)
  const renderedIcon =
    typeof icon === 'string'
      ? icon !== ''
        ? <HelmxIcon name={icon} size={resolvedIconSize} />
        : null
      : hasRenderable(icon)
        ? icon
        : null

  return (
    <div className={joinClass('empty-state', densityClass, className)}>
      {renderedIcon !== null && <div className="empty-state-icon">{renderedIcon}</div>}
      {hasRenderable(title) && <p className="empty-state-title">{title}</p>}
      {hasRenderable(hint) && (
        <p className={joinClass('empty-state-hint', hintSubtle ? 'text-subtle' : undefined)}>{hint}</p>
      )}
      {hasRenderable(action) && <div className="empty-state-action">{action}</div>}
      {children}
    </div>
  )
}
