/**
 * Shared Button and IconButton primitives (SSR safe, Fast Refresh compliant):
 * - Thin wrappers over the host .btn / .btn-* design-system classes using
 *   static literal class maps (no dynamic prefix concatenation);
 * - React.forwardRef forwards DOM refs and arbitrary event/ARIA/data props so
 *   both components compose cleanly inside Radix `asChild` triggers
 *   (TooltipTrigger, PopoverTrigger, DialogClose);
 * - `pending` automatically disables interaction, marks `aria-busy`, and shows
 *   a subtle spinning loader icon (seamless pairing with `usePluginAction`);
 * - Children are direct flex items of `.btn` (no wrapper element): a label
 *   hidden by responsive CSS (`.pane-action-label { display: none }`) leaves
 *   zero ghost gap, so icon-only collapses stay centered in every container.
 */
import * as React from 'react'
import { HelmxIcon } from '../icons.js'

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger' | 'inline'
export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  /** Visual prominence variant (default `'secondary'` bordered button; `'inline'` renders a compact borderless text micro-action). */
  variant?: ButtonVariant
  /** Control height / density tier (default `'md'`: 32px / `'sm'`: 28px / `'xs'`: 22px; omitted on `'inline'` keeps compact inline typography and 11px icons). */
  size?: ButtonSize
  /** Render pill-shaped corners (`.btn-pill`). */
  pill?: boolean
  /** Optional leading icon: HelmxIcon name string or custom ReactNode. */
  icon?: string | React.ReactNode
  /** Busy state: disables the button, sets `aria-busy`, and replaces the leading icon with a spinner. */
  pending?: boolean
}

type IconButtonAccessibleName =
  | {
      /** Human-readable action name used as `aria-label` (and default `title` when omitted). */
      label: string
      'aria-label'?: string
    }
  | {
      label?: string
      /** Explicit accessible name when `label` is not provided. */
      'aria-label': string
    }

export type IconButtonProps = Omit<React.ComponentPropsWithoutRef<'button'>, 'children' | 'aria-label'> &
  IconButtonAccessibleName & {
    /** Icon to render: HelmxIcon name string or custom ReactNode. */
    icon: string | React.ReactNode
    /** Visual prominence variant (default `'ghost'`). */
    variant?: ButtonVariant
    /** Square button size tier (default `'md'`: 32px / `'sm'`: 28px / `'xs'`: 22px). */
    size?: ButtonSize
    /** Render circular/pill corners (`.btn-pill`). */
    pill?: boolean
    /** Toggle state: when provided, wires `aria-pressed` (unless explicitly overridden) and attaches `.is-active` while `true`. */
    active?: boolean
    /** Busy state: disables the button, sets `aria-busy`, and renders a spinning loader. */
    pending?: boolean
  }

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  secondary: 'btn btn-secondary',
  primary: 'btn btn-primary',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
  inline: 'btn btn-inline',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: '',
  sm: 'btn-sm',
  xs: 'btn-xs',
}

const ICON_BTN_SIZE_CLASS: Record<ButtonSize, string> = {
  md: 'btn-icon',
  sm: 'btn-icon-sm',
  xs: 'btn-icon-xs',
}

const ICON_PX: Record<ButtonSize, number> = {
  md: 14,
  sm: 13,
  xs: 12,
}

const INLINE_ICON_PX = 11

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function renderIconNode(
  icon: string | React.ReactNode | undefined,
  pending: boolean,
  px: number,
): React.ReactNode {
  if (pending) {
    return <HelmxIcon name="loader" size={px} className="spin-slow" />
  }
  if (icon === undefined || icon === null || icon === false) return null
  if (typeof icon === 'string') {
    return <HelmxIcon name={icon} size={px} />
  }
  return icon
}

/** Standard action button wrapping the host `.btn` family with ref forwarding and `pending` state. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size,
    pill = false,
    icon,
    pending = false,
    disabled = false,
    type = 'button',
    'aria-busy': ariaBusy,
    className,
    children,
    ...rest
  },
  ref,
) {
  const resolvedSize: ButtonSize = size ?? 'md'
  const resolvedClass = joinClass(
    VARIANT_CLASS[variant],
    SIZE_CLASS[resolvedSize] || undefined,
    pill ? 'btn-pill' : undefined,
    className,
  )
  const iconPx = variant === 'inline' && size === undefined ? INLINE_ICON_PX : ICON_PX[resolvedSize]
  const leading = renderIconNode(icon, pending, iconPx)
  return (
    <button
      ref={ref}
      type={type}
      className={resolvedClass}
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending ? true : ariaBusy}
    >
      {leading}
      {children}
    </button>
  )
})

function nonBlankString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Square icon-only action button with a required non-blank accessible name (`label` or `aria-label`). */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    variant = 'ghost',
    size = 'md',
    pill = false,
    active,
    pending = false,
    disabled = false,
    type = 'button',
    label,
    title,
    'aria-label': ariaLabel,
    'aria-busy': ariaBusy,
    'aria-pressed': ariaPressed,
    className,
    ...rest
  },
  ref,
) {
  const resolvedAriaLabel = nonBlankString(ariaLabel)
  const resolvedLabel = nonBlankString(label)
  const accessibleName = resolvedAriaLabel ?? resolvedLabel
  if (accessibleName === undefined) {
    throw new Error('IconButton requires a non-empty `label` or `aria-label` accessible name.')
  }
  const resolvedClass = joinClass(
    VARIANT_CLASS[variant],
    ICON_BTN_SIZE_CLASS[size],
    pill ? 'btn-pill' : undefined,
    active === true ? 'is-active' : undefined,
    className,
  )
  return (
    <button
      ref={ref}
      type={type}
      className={resolvedClass}
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending ? true : ariaBusy}
      aria-pressed={ariaPressed ?? active}
      aria-label={accessibleName}
      title={title ?? resolvedLabel}
    >
      {renderIconNode(icon, pending, ICON_PX[size])}
    </button>
  )
})
