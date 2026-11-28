import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

export type MasterDetailMobilePane = 'master' | 'detail'

export interface MasterDetailProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Left master pane content (navigation list, file tree, filter rail). */
  master: ReactNode
  /** Right detail pane content (viewer, editor, inspector). */
  detail: ReactNode
  /** Active pane shown on narrow viewports (max-width: 680px container). */
  mobilePane?: MasterDetailMobilePane
  /** Master column width override (number emits px; string passes directly). */
  masterWidth?: number | string
  /** Accessible label for the master `<aside>` landmark. */
  masterLabel?: string
  /** Accessible label for the detail `<main>` landmark. */
  detailLabel?: string
  masterClassName?: string
  detailClassName?: string
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * Full-bleed two-column master-detail shell (UI HIG Archetype 5).
 * Collapses into single-pane switching via `mobilePane` under narrow containers.
 */
export function MasterDetail({
  master,
  detail,
  mobilePane = 'master',
  masterWidth,
  masterLabel,
  detailLabel,
  className,
  masterClassName,
  detailClassName,
  style,
  ...rest
}: MasterDetailProps): ReactNode {
  const resolvedWidth = typeof masterWidth === 'number' ? `${masterWidth}px` : masterWidth
  const mergedStyle = resolvedWidth !== undefined
    ? ({ ...style, '--helmx-master-width': resolvedWidth } as CSSProperties)
    : style

  return (
    <div
      className={joinClass('helmx-master-detail', className)}
      data-mobile-pane={mobilePane}
      style={mergedStyle}
      {...rest}
    >
      <aside
        className={joinClass('helmx-master-detail-master', masterClassName)}
        aria-label={masterLabel}
      >
        {master}
      </aside>
      <main
        className={joinClass('helmx-master-detail-detail', detailClassName)}
        aria-label={detailLabel}
      >
        {detail}
      </main>
    </div>
  )
}
