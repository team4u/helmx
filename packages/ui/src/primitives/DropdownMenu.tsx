/**
 * Radix UI DropdownMenu wrapper family (host + plugin shared):
 * - Reuses host overlay CSS vocabulary (.helmx-dropdown-* / .popover-item* /
 *   .popover-separator) with zero unstyled orphan classes;
 * - Uses shared OverlayLayerContext (useOverlayChildStyle) so menus opened
 *   inside dialogs/drawers layer above their parent surface;
 * - Stamps data-plugin-id on DropdownMenuContent when rendered inside a plugin
 *   PluginClientContext so portalled menus stay inside the plugin's CSS scope;
 * - SSR-safe DropdownMenuPortal (renders inline when typeof window === 'undefined' or inline=true).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { HelmxIcon } from '../icons.js'
import { useOverlayChildStyle } from './overlay-stack.js'
import { useUiScopeId } from '../ui-scope-context.js'

export interface DropdownMenuPortalProps extends DropdownMenuPrimitive.DropdownMenuPortalProps {
  /** Explicitly render inline (do not mount into document.body). */
  inline?: boolean
}

/**
 * SSR-tolerant portal: renders children directly during server-side rendering
 * (typeof window === 'undefined') or when inline is true.
 */
export function DropdownMenuPortal({ children, container, inline = false }: DropdownMenuPortalProps) {
  if (inline || typeof window === 'undefined') {
    return <>{children}</>
  }
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      {children}
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuRoot({ modal = false, ...props }: DropdownMenuPrimitive.DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />
}

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group

export interface DropdownMenuContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  portalled?: boolean
  inline?: boolean
}

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(({ className = '', sideOffset = 4, align = 'end', portalled = false, inline = false, children, style, ...props }, ref) => {
  const layeredStyle = useOverlayChildStyle(style)
  const pluginScopeId = useUiScopeId()
  const content = (
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      data-plugin-id={pluginScopeId}
      className={`helmx-dropdown-content ${className}`.trim()}
      style={layeredStyle}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Content>
  )

  if (portalled) {
    return <DropdownMenuPortal inline={inline}>{content}</DropdownMenuPortal>
  }

  return content
})
DropdownMenuContent.displayName = 'DropdownMenuContent'

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  /** Optional leading icon: HelmxIcon name string or custom ReactNode. */
  icon?: string | React.ReactNode
  /** Optional secondary muted description line rendered beneath the label. */
  description?: React.ReactNode
  /** Optional right-aligned keyboard shortcut hint. */
  shortcut?: React.ReactNode
  /** Optional right-aligned trailing slot (badges, status indicators, etc.). */
  trailing?: React.ReactNode
  /** Optional checked / active state: stamps `data-checked` and renders a trailing check glyph when `true`. */
  checked?: boolean
  /** Destructive action tone. */
  danger?: boolean
}

function hasRenderable(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(({ className = '', icon, description, shortcut, trailing, checked, danger = false, children, ...props }, ref) => {
  const hasStructuredSlots =
    icon !== undefined ||
    description !== undefined ||
    shortcut !== undefined ||
    trailing !== undefined ||
    checked !== undefined
  const hasDesc = hasRenderable(description)
  const hasShortcut = hasRenderable(shortcut)
  const hasTrailing = hasRenderable(trailing)
  const renderedIcon =
    typeof icon === 'string'
      ? icon !== ''
        ? <HelmxIcon name={icon} size={14} />
        : null
      : hasRenderable(icon)
        ? icon
        : null

  const itemClass = [
    'helmx-dropdown-item',
    'popover-item',
    danger ? 'helmx-dropdown-item-danger popover-item-danger' : undefined,
    hasDesc ? 'helmx-dropdown-item-has-desc' : undefined,
    className || undefined,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={itemClass}
      data-checked={checked !== undefined ? (checked ? 'true' : 'false') : undefined}
      {...props}
    >
      {hasStructuredSlots ? (
        <>
          {renderedIcon !== null ? (
            <span className="helmx-dropdown-item-icon" aria-hidden="true">
              {renderedIcon}
            </span>
          ) : null}
          <span className="helmx-dropdown-item-body">
            <span className="helmx-dropdown-item-label">{children}</span>
            {hasDesc ? <span className="helmx-dropdown-item-desc">{description}</span> : null}
          </span>
          {hasTrailing || hasShortcut || checked === true ? (
            <span className="helmx-dropdown-item-trailing">
              {hasTrailing ? trailing : null}
              {hasShortcut ? <span className="helmx-dropdown-item-shortcut">{shortcut}</span> : null}
              {checked === true ? <HelmxIcon name="check" size={13} className="helmx-dropdown-item-check" /> : null}
            </span>
          ) : null}
        </>
      ) : (
        children
      )}
    </DropdownMenuPrimitive.Item>
  )
})
DropdownMenuItem.displayName = 'DropdownMenuItem'

export interface DropdownMenuSeparatorProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> {}

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  DropdownMenuSeparatorProps
>(({ className = '', ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={`helmx-dropdown-separator popover-separator ${className}`.trim()}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

export interface DropdownMenuLabelProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> {}

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  DropdownMenuLabelProps
>(({ className = '', ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={`helmx-dropdown-label ${className}`.trim()}
    {...props}
  />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

export interface DropdownMenuArrowProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Arrow> {}

export const DropdownMenuArrow = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Arrow>,
  DropdownMenuArrowProps
>(({ className = '', width = 10, height = 5, ...props }, ref) => (
  <DropdownMenuPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helmx-dropdown-arrow ${className}`.trim()}
    {...props}
  />
))
DropdownMenuArrow.displayName = 'DropdownMenuArrow'

/** Generic Radix DropdownMenu wrapper component. */
export function DropdownMenu({ modal = false, ...props }: DropdownMenuPrimitive.DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />
}

DropdownMenu.Root = DropdownMenuRoot
DropdownMenu.Trigger = DropdownMenuTrigger
DropdownMenu.Portal = DropdownMenuPortal
DropdownMenu.Content = DropdownMenuContent
DropdownMenu.Item = DropdownMenuItem
DropdownMenu.Separator = DropdownMenuSeparator
DropdownMenu.Label = DropdownMenuLabel
DropdownMenu.Group = DropdownMenuGroup
DropdownMenu.Arrow = DropdownMenuArrow
