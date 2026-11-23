/**
 * Shared composer-dock in-flight activity tray primitives (`DockTray` and
 * `DockTrayRow`) over the host `.dock-tray*` CSS vocabulary.
 *
 * Structure contract (a11y-legal, constant 32px collapsed / row height):
 * - Header bar is a flex row whose primary region is a real `<button>`
 *   (`aria-expanded` / `aria-controls`); trailing `barAction` (e.g. Workbench)
 *   is a sibling button — no interactive element ever nests inside another.
 * - Each expanded row renders its body as either a real `<button>` (when
 *   `onOpen` is supplied) or a static `<div>`, with trailing `actions` as a
 *   sibling group.
 * - Optional `classPrefix` appends plugin-specific hook classes alongside the
 *   host `.dock-tray*` visual classes so existing selectors/tests stay intact
 *   without duplicating 200 lines of tray CSS per plugin.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'
import { StatusLight } from './StatusLight.js'

function withPrefix(base: string, prefix: string | undefined, suffix: string): string {
  return prefix !== undefined && prefix !== '' ? `${base} ${prefix}${suffix}` : base
}

export interface DockTrayProps {
  /** Whether any item in the tray is blocked / needs attention (accentuates border). */
  warn?: boolean
  /** Accessible label for the tray region. */
  regionLabel: string
  /** Controlled expanded state of the concurrent task list. */
  expanded: boolean
  /** Toggle callback for the header bar button. */
  onToggle: () => void
  /** Accessible label for the header bar toggle button. */
  toggleLabel: string
  /** Tooltip title for the header bar toggle button. */
  toggleTitle?: string
  /** Status light state for the header bar (`'running' | 'blocked'`, etc.). */
  status: string
  /** Screen-reader label for the header bar status light. */
  statusLabel: string
  /** Optional compact progress badge (e.g. `1/3`). */
  badge?: ReactNode
  /** Optional count label (shown when expanded or multi-item). */
  count?: ReactNode
  /** Optional inline frontline text/element shown when collapsed. */
  frontline?: ReactNode
  /** Optional elapsed duration text. */
  elapsed?: string
  /** Optional sibling trailing button (e.g. open Workbench). */
  barAction?: ReactNode
  /** Optional plugin-specific CSS hook prefix emitted alongside `.dock-tray*`. */
  classPrefix?: string
  /** Expanded list rows (`DockTrayRow`). */
  children?: ReactNode
}

export function DockTray({
  warn = false,
  regionLabel,
  expanded,
  onToggle,
  toggleLabel,
  toggleTitle,
  status,
  statusLabel,
  badge,
  count,
  frontline,
  elapsed,
  barAction,
  classPrefix,
  children,
}: DockTrayProps): ReactNode {
  const listId = useId()
  const rootClass = [
    withPrefix('dock-tray', classPrefix, ''),
    warn ? withPrefix('dock-tray-warn', classPrefix, '-warn') : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} role="region" aria-label={regionLabel}>
      <div className={withPrefix('dock-tray-bar', classPrefix, '-bar')}>
        <button
          type="button"
          className={withPrefix('dock-tray-bar-toggle', classPrefix, '-bar-toggle')}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={toggleLabel}
          title={toggleTitle}
          onClick={onToggle}
        >
          <StatusLight status={status} label={statusLabel} />
          {badge}
          {count !== undefined && count !== null && count !== false ? (
            <span
              className={withPrefix('dock-tray-count', classPrefix, '-count')}
              title={typeof count === 'string' ? count : undefined}
            >
              {count}
            </span>
          ) : null}
          {expanded ? null : frontline}
          <span className={withPrefix('dock-tray-spacer', classPrefix, '-spacer')} />
          {elapsed !== undefined ? (
            <span className={`${withPrefix('dock-tray-elapsed', classPrefix, '-elapsed')} tabular-nums`}>
              {elapsed}
            </span>
          ) : null}
          <HelmxIcon
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={11}
            className={withPrefix('dock-tray-chevron', classPrefix, '-chevron')}
          />
        </button>
        {barAction}
      </div>
      {expanded ? (
        <div id={listId} className={withPrefix('dock-tray-list', classPrefix, '-list')}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

export interface DockTrayRowProps {
  /** Status light state for this row. */
  status: string
  /** Screen-reader label for this row's status light. */
  statusLabel: string
  /** Primary row title. */
  title: string
  /** Optional monospace `#id` label. */
  idText?: string
  /** Optional compact progress badge. */
  badge?: ReactNode
  /** Optional elapsed duration text. */
  elapsed?: string
  /** Optional live activity inline snippet (fills remaining row width). */
  live?: ReactNode
  /** Optional row click handler; when provided the main body is a real `<button>`. */
  onOpen?: () => void
  /** Accessible label for the clickable row main button. */
  openAriaLabel?: string
  /** Optional trailing sibling action buttons (e.g. Detach / Abort). */
  actions?: ReactNode
  /** Optional plugin-specific CSS hook prefix emitted alongside `.dock-tray*`. */
  classPrefix?: string
}

export function DockTrayRow({
  status,
  statusLabel,
  title,
  idText,
  badge,
  elapsed,
  live,
  onOpen,
  openAriaLabel,
  actions,
  classPrefix,
}: DockTrayRowProps): ReactNode {
  const activatable = onOpen !== undefined
  const mainClass = [
    withPrefix('dock-tray-row-main', classPrefix, '-row-main'),
    activatable ? withPrefix('dock-tray-row-clickable', classPrefix, '-row-clickable') : '',
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      <StatusLight status={status} label={statusLabel} />
      <span className={withPrefix('dock-tray-row-title', classPrefix, '-row-title')} title={title}>
        {title}
      </span>
      {idText !== undefined ? (
        <span className={`${withPrefix('dock-tray-row-id', classPrefix, '-row-id')} tabular-nums`}>
          {idText}
        </span>
      ) : null}
      {badge}
      {elapsed !== undefined ? (
        <span className={`${withPrefix('dock-tray-elapsed', classPrefix, '-elapsed')} tabular-nums`}>
          {elapsed}
        </span>
      ) : null}
      {live}
    </>
  )

  return (
    <div className={withPrefix('dock-tray-row', classPrefix, '-row')}>
      {activatable ? (
        <button type="button" className={mainClass} aria-label={openAriaLabel} onClick={onOpen}>
          {content}
        </button>
      ) : (
        <div className={mainClass}>{content}</div>
      )}
      {actions !== undefined && actions !== null && actions !== false ? (
        <div className={withPrefix('dock-tray-row-actions', classPrefix, '-row-actions')}>{actions}</div>
      ) : null}
    </div>
  )
}
