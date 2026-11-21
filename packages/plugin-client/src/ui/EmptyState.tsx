/**
 * Unified empty-state primitive (host + plugin shared).
 *
 * Reuses the host common .empty-state vocabulary (centered column, subtle
 * color, optional icon / title / hint / compact density) — no new CSS theme.
 * Content stays caller JSX: this is pure presentation, no data access, SSR
 * safe (no portal, no window access).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface EmptyStateProps {
  /** Primary line (entity-level "no data yet" copy). */
  title?: ReactNode
  /** Secondary explanation line (inherits the muted empty-state styling). */
  hint?: ReactNode
  /** Optional leading icon block (.empty-state-icon). */
  icon?: ReactNode
  /** Compact density for tray / panel-sized surfaces (.empty-state-compact). */
  compact?: boolean
  className?: string
  /** Extra content below title/hint (fallback body for plain one-liners). */
  children?: ReactNode
}

/** Centered empty / placeholder block over the host .empty-state common classes. */
export function EmptyState(props: EmptyStateProps): ReactNode {
  const { title, hint, icon, compact = false, className, children } = props
  return (
    <div className={joinClass('empty-state', compact ? 'empty-state-compact' : undefined, className)}>
      {icon !== undefined && <div className="empty-state-icon">{icon}</div>}
      {title !== undefined && <p className="empty-state-title">{title}</p>}
      {hint !== undefined && <p className="empty-state-hint">{hint}</p>}
      {children}
    </div>
  )
}
