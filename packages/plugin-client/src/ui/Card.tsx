/**
 * Shared Card, SelectCard, and CardGrid primitives (SSR safe, Fast Refresh compliant):
 * - `Card`: pure static structural container (`elevated | subtle`, `default | warn | danger`),
 *   naming its `<section>` via `aria-labelledby` when `title` is present;
 * - `SelectCard`: stage-grid selectable object card matching the host sibling-slot
 *   accessibility pattern (`<article>` pointer hit area + dedicated `<button aria-pressed>`
 *   main trigger with optional `icon` 32x32 box and inline `badges` + optional 2-line clamped
 *   `description` + sibling `actions` / `footer` slots — never nesting buttons inside `role="button"`);
 * - `CardGrid`: responsive auto-fill grid using `minmax(min(100%, ...), 1fr)` so
 *   narrow split panes and mobile viewports never overflow horizontally.
 */
import * as React from 'react'
import { HelmxIcon } from '../icons.js'
import { shouldTriggerSurfaceClick } from './interactive-surface.js'

export type CardVariant = 'elevated' | 'subtle'
export type CardTone = 'default' | 'warn' | 'danger'
export type CardGridMinWidth = 'sm' | 'md' | 'lg'
export type CardGridGap = 'sm' | 'md' | 'lg'

export interface CardProps extends Omit<React.ComponentPropsWithoutRef<'section'>, 'title'> {
  /** Surface elevation (default `'elevated'`; `'subtle'` uses muted surface fill). */
  variant?: CardVariant
  /** Semantic emphasis tone (default `'default'`; use `'danger'` for destructive blocks). */
  tone?: CardTone
  /** Card header title (rendered as `<h3>` and wired to `aria-labelledby`). */
  title?: React.ReactNode
  /** Secondary subtitle rendered directly under `title`. */
  subtitle?: React.ReactNode
  /** Right-aligned header action slot. */
  actions?: React.ReactNode
  /** Bottom bar separated by a hairline border. */
  footer?: React.ReactNode
}

export interface SelectCardProps extends Omit<React.ComponentPropsWithoutRef<'article'>, 'title' | 'onSelect' | 'onClick'> {
  /** Required primary card title (forms the accessible main trigger button). */
  title: React.ReactNode
  /** Optional leading 32x32 rounded icon box: HelmxIcon name string or custom ReactNode. */
  icon?: string | React.ReactNode
  /** Optional inline non-interactive badges/status lights rendered right next to `title`. */
  badges?: React.ReactNode
  /** Optional secondary line rendered inside the trigger below `title`. */
  subtitle?: React.ReactNode
  /** Optional 2-line clamped natural-language description rendered below the header. */
  description?: React.ReactNode
  /** Optional right-aligned header actions (sibling of the main trigger button; never nested inside it). */
  actions?: React.ReactNode
  /** Optional footer slot (pills, timestamps, secondary actions). */
  footer?: React.ReactNode
  /** Selected state (reflected via visual highlight and `aria-pressed` on the trigger button). */
  selected?: boolean
  /** Visual semantic border tone (default `'default'`). */
  tone?: CardTone
  /** Disables selection interaction. */
  disabled?: boolean
  /** Selection callback triggered by clicking the card surface or activating the title button. */
  onSelect: () => void
  /** Optional accessible label override for the primary trigger button. */
  'aria-label'?: string
}

export interface CardGridProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Minimum column width tier (`sm`: 220px / `md`: 280px / `lg`: 340px, clamped to `100%`). */
  minWidth?: CardGridMinWidth
  /** Grid gap tier mapped to `--space-*` tokens (default `'md'`: 12px). */
  gap?: CardGridGap
}

const CARD_VARIANT_CLASS: Record<CardVariant, string> = {
  elevated: 'helmx-card',
  subtle: 'helmx-card helmx-card-subtle',
}

const CARD_TONE_CLASS: Record<CardTone, string | undefined> = {
  default: undefined,
  warn: 'helmx-card-warn',
  danger: 'helmx-card-danger',
}

const SELECT_CARD_TONE_CLASS: Record<CardTone, string | undefined> = {
  default: undefined,
  warn: 'helmx-select-card-warn',
  danger: 'helmx-select-card-danger',
}

const CARD_GRID_MIN_WIDTH_CLASS: Record<CardGridMinWidth, string> = {
  sm: 'helmx-card-grid-sm',
  md: 'helmx-card-grid-md',
  lg: 'helmx-card-grid-lg',
}

const CARD_GRID_GAP_CLASS: Record<CardGridGap, string> = {
  sm: 'helmx-card-grid-gap-sm',
  md: 'helmx-card-grid-gap-md',
  lg: 'helmx-card-grid-gap-lg',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasNode(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== ''
}

function renderCardIcon(icon: string | React.ReactNode): React.ReactNode {
  if (typeof icon === 'string') {
    return <HelmxIcon name={icon} size={16} />
  }
  return icon
}

export const Card = React.forwardRef<HTMLElement, CardProps>(function Card(
  {
    variant = 'elevated',
    tone = 'default',
    title,
    subtitle,
    actions,
    footer,
    className,
    children,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ...rest
  },
  ref,
) {
  const titleId = React.useId()
  const hasTitle = hasNode(title)
  const hasSubtitle = hasNode(subtitle)
  const hasActions = hasNode(actions)
  const hasHeader = hasTitle || hasSubtitle || hasActions
  const hasBody = hasNode(children)
  const hasFooter = hasNode(footer)

  const resolvedAriaLabelledBy =
    ariaLabel === undefined && ariaLabelledBy === undefined && hasTitle ? titleId : ariaLabelledBy

  return (
    <section
      ref={ref}
      className={joinClass(CARD_VARIANT_CLASS[variant], CARD_TONE_CLASS[tone], className)}
      aria-label={ariaLabel}
      aria-labelledby={resolvedAriaLabelledBy}
      {...rest}
    >
      {hasHeader ? (
        <div className="helmx-card-header">
          {(hasTitle || hasSubtitle) ? (
            <div className="helmx-card-heading">
              {hasTitle ? (
                <h3 id={titleId} className="helmx-card-title">
                  {title}
                </h3>
              ) : null}
              {hasSubtitle ? <div className="helmx-card-subtitle">{subtitle}</div> : null}
            </div>
          ) : null}
          {hasActions ? <div className="helmx-card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {hasBody ? <div className="helmx-card-body">{children}</div> : null}
      {hasFooter ? <div className="helmx-card-footer">{footer}</div> : null}
    </section>
  )
})

export const SelectCard = React.forwardRef<HTMLElement, SelectCardProps>(function SelectCard(
  {
    title,
    icon,
    badges,
    subtitle,
    description,
    actions,
    footer,
    selected = false,
    tone = 'default',
    disabled = false,
    onSelect,
    className,
    children,
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const hasIcon = hasNode(icon)
  const hasBadges = hasNode(badges)
  const hasSubtitle = hasNode(subtitle)
  const hasDescription = hasNode(description)
  const hasActions = hasNode(actions)
  const hasBody = hasNode(children)
  const hasFooter = hasNode(footer)

  const handleArticleClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (disabled) return
    if (!shouldTriggerSurfaceClick(e)) return
    onSelect()
  }

  return (
    <article
      ref={ref}
      className={joinClass(
        'helmx-select-card',
        selected ? 'is-selected' : undefined,
        disabled ? 'is-disabled' : undefined,
        SELECT_CARD_TONE_CLASS[tone],
        className,
      )}
      onClick={handleArticleClick}
      {...rest}
    >
      <div className="helmx-select-card-header">
        <button
          type="button"
          className="helmx-select-card-trigger"
          disabled={disabled}
          aria-pressed={selected}
          aria-label={ariaLabel}
          onClick={(e) => {
            e.stopPropagation()
            if (!disabled) onSelect()
          }}
        >
          {hasIcon ? (
            <span className="helmx-select-card-icon" aria-hidden="true">
              {renderCardIcon(icon)}
            </span>
          ) : null}
          <span className="helmx-select-card-heading">
            <span className="helmx-select-card-title-row">
              <span className="helmx-card-title">{title}</span>
              {hasBadges ? <span className="helmx-select-card-badges">{badges}</span> : null}
            </span>
            {hasSubtitle ? <span className="helmx-card-subtitle">{subtitle}</span> : null}
          </span>
        </button>
        {hasActions ? (
          <div
            className="helmx-card-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {hasDescription ? <div className="helmx-select-card-desc">{description}</div> : null}
      {hasBody ? <div className="helmx-card-body">{children}</div> : null}
      {hasFooter ? <div className="helmx-card-footer">{footer}</div> : null}
    </article>
  )
})

export const CardGrid = React.forwardRef<HTMLDivElement, CardGridProps>(function CardGrid(
  { minWidth = 'md', gap = 'md', className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={joinClass(
        'helmx-card-grid',
        CARD_GRID_MIN_WIDTH_CLASS[minWidth],
        CARD_GRID_GAP_CLASS[gap],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
})
