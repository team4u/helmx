/**
 * Shared Hairline Roster List primitives (`List` & `ListRow`, SSR safe, Fast Refresh compliant):
 * - Promotes the Quiet Surface hairline-bordered roster list into `@helmx/plugin-client`:
 *   1px rounded elevated container + 1px hairline dividers + `@container (max-width: 680px)`
 *   single-column responsive collapse (safe in split panes, narrow panels, and mobile);
 * - Accessible sibling-slot click pattern: clickable rows render a `<button aria-pressed>`
 *   primary trigger alongside sibling `trailing` (always visible: badges, timestamps, Switch)
 *   and `actions` (hover/focus-revealed on pointer devices, visibly accessible on touch) slots
 *   whose click/keydown events stop propagation — never nesting buttons inside `role="button"`;
 * - Non-interactive rows (when `onSelect` is omitted or `interactive={false}`) render a static
 *   non-button row body with full slot alignment.
 */
import * as React from 'react'
import { shouldTriggerSurfaceClick } from './interactive-surface.js'

export type ListDensity = 'default' | 'compact'
export type ListRowTone = 'default' | 'warn' | 'danger'

export interface ListProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Row vertical density (default `'default'`: >=44px rows; `'compact'`: >=36px rows for narrow panels). */
  density?: ListDensity
  /** Accessible label for the list container (forwarded to `aria-label` when explicit `aria-label` is omitted). */
  label?: string
}

export interface ListRowProps
  extends Omit<React.ComponentPropsWithoutRef<'div'>, 'title' | 'onSelect' | 'onClick'> {
  /** Optional leading indicator (StatusLight, HelmxIcon, Checkbox). */
  leading?: React.ReactNode
  /** Primary row title (bold identifier or label). */
  title?: React.ReactNode
  /** Secondary structured/monospace metadata (model chain, port mapping, cron schedule, badges). */
  meta?: React.ReactNode
  /** Concise single-line ellipsized description or summary. */
  description?: React.ReactNode
  /**
   * Always-visible right-aligned trailing slot (badges, timestamps, Switch, primary row controls).
   * Rendered as a sibling outside the main trigger button; click/keydown stop propagation.
   */
  trailing?: React.ReactNode
  /**
   * Secondary right-aligned row actions (e.g. delete/edit IconButton): fades in on row hover
   * or `:focus-within` under `@media (hover: hover)` and remains visibly accessible on touch devices.
   * Rendered as a sibling outside the main trigger button; click/keydown stop propagation.
   */
  actions?: React.ReactNode
  /** Selected state (accent highlight + `aria-pressed` on the primary trigger button). */
  selected?: boolean
  /** Semantic emphasis tone (`'default' | 'warn' | 'danger'`). */
  tone?: ListRowTone
  /** Disables row selection interaction. */
  disabled?: boolean
  /**
   * Whether the row is selectable. Defaults to `onSelect !== undefined`.
   * Pass `false` to render a static non-button row even if an unused callback is present.
   */
  interactive?: boolean
  /** Selection callback invoked by clicking the row surface or activating the primary trigger button. */
  onSelect?: () => void
  /** Optional accessible label override for the primary trigger button. */
  'aria-label'?: string
  /** Optional supplementary block rendered below the main row line (e.g. chip strips or metadata rows). */
  children?: React.ReactNode
}

const LIST_ROW_TONE_CLASS: Record<ListRowTone, string | undefined> = {
  default: undefined,
  warn: 'helmx-list-row-warn',
  danger: 'helmx-list-row-danger',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasNode(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== ''
}

export const List = React.forwardRef<HTMLDivElement, ListProps>(function List(
  {
    density = 'default',
    label,
    'aria-label': ariaLabel,
    role = 'list',
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel ?? label}
      className={joinClass(
        'helmx-list',
        density === 'compact' ? 'helmx-list-compact' : undefined,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
})

export const ListRow = React.forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  {
    leading,
    title,
    meta,
    description,
    trailing,
    actions,
    selected = false,
    tone = 'default',
    disabled = false,
    interactive,
    onSelect,
    'aria-label': ariaLabel,
    role = 'listitem',
    className,
    children,
    ...rest
  },
  ref,
) {
  const isInteractive = (interactive ?? onSelect !== undefined) && onSelect !== undefined
  const hasLeading = hasNode(leading)
  const hasTitle = hasNode(title)
  const hasMeta = hasNode(meta)
  const hasDescription = hasNode(description)
  const hasTrailing = hasNode(trailing)
  const hasActions = hasNode(actions)
  const hasChildren = hasNode(children)

  const colClass =
    hasMeta && hasDescription
      ? 'helmx-list-row-cols-3'
      : hasMeta || hasDescription
        ? 'helmx-list-row-cols-2'
        : 'helmx-list-row-cols-1'

  const handleSurfaceClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!isInteractive || disabled) return
    if (!shouldTriggerSurfaceClick(event)) return
    onSelect()
  }

  const mainContent = (
    <>
      {(hasLeading || hasTitle) ? (
        <span className="helmx-list-row-primary">
          {hasLeading ? <span className="helmx-list-row-leading">{leading}</span> : null}
          {hasTitle ? <span className="helmx-list-row-title">{title}</span> : null}
        </span>
      ) : null}
      {hasMeta ? <span className="helmx-list-row-meta">{meta}</span> : null}
      {hasDescription ? (
        <span className="helmx-list-row-desc" title={typeof description === 'string' ? description : undefined}>
          {description}
        </span>
      ) : null}
    </>
  )

  return (
    <div
      ref={ref}
      role={role}
      className={joinClass(
        'helmx-list-row',
        isInteractive ? 'helmx-list-row-interactive' : undefined,
        selected ? 'is-selected' : undefined,
        disabled ? 'is-disabled' : undefined,
        LIST_ROW_TONE_CLASS[tone],
        className,
      )}
      onClick={isInteractive ? handleSurfaceClick : undefined}
      {...rest}
    >
      <div className="helmx-list-row-line">
        {isInteractive ? (
          <button
            type="button"
            className={joinClass('helmx-list-row-trigger', colClass)}
            disabled={disabled}
            aria-pressed={selected}
            aria-label={ariaLabel}
            onClick={(event) => {
              event.stopPropagation()
              if (!disabled) onSelect()
            }}
          >
            {mainContent}
          </button>
        ) : (
          <div className={joinClass('helmx-list-row-static', colClass)}>
            {mainContent}
          </div>
        )}
        {hasTrailing ? (
          <div
            className="helmx-list-row-trailing"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {trailing}
          </div>
        ) : null}
        {hasActions ? (
          <div
            className="helmx-list-row-actions"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {hasChildren ? <div className="helmx-list-row-extra">{children}</div> : null}
    </div>
  )
})
