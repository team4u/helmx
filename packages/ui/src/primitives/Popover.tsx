import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { HelmxIcon } from '../icons.js'
import { useOverlayChildStyle } from './overlay-stack.js'
import { useUiScopeId } from '../ui-scope-context.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderable(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

export interface PopoverPortalProps extends PopoverPrimitive.PopoverPortalProps {}

/**
 * SSR-tolerant Portal: during server rendering (typeof window === 'undefined')
 * children are rendered directly, avoiding createPortal depending on
 * document.body which would degrade rendering or throw.
 */
export function PopoverPortal({ children, container, forceMount }: PopoverPortalProps) {
  if (typeof window === 'undefined') {
    return <>{children}</>
  }
  return (
    <PopoverPrimitive.Portal container={container} forceMount={forceMount}>
      {children}
    </PopoverPrimitive.Portal>
  )
}

export function PopoverRoot(props: PopoverPrimitive.PopoverProps) {
  return <PopoverPrimitive.Root {...props} />
}

export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  portalled?: boolean
}

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className = '', align = 'center', sideOffset = 6, portalled = false, children, style, ...props }, ref) => {
  const layeredStyle = useOverlayChildStyle(style)
  const pluginScopeId = useUiScopeId()
  const content = (
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      data-plugin-id={pluginScopeId}
      className={`helmx-popover-content ${className}`.trim()}
      style={layeredStyle}
      {...props}
    >
      {children}
    </PopoverPrimitive.Content>
  )

  if (portalled) {
    return <PopoverPortal>{content}</PopoverPortal>
  }

  return content
})
PopoverContent.displayName = 'PopoverContent'

export interface PopoverArrowProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Arrow> {}

export const PopoverArrow = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Arrow>,
  PopoverArrowProps
>(({ className = '', width = 10, height = 5, ...props }, ref) => (
  <PopoverPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helmx-popover-arrow ${className}`.trim()}
    {...props}
  />
))
PopoverArrow.displayName = 'PopoverArrow'

export interface PopoverHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  trailing?: React.ReactNode
  divider?: boolean
}

export const PopoverHeader = React.forwardRef<HTMLDivElement, PopoverHeaderProps>(function PopoverHeader(
  { className, title, subtitle, trailing, divider = false, children, ...rest },
  ref,
) {
  const showMain = hasRenderable(title) || hasRenderable(subtitle)
  return (
    <div
      ref={ref}
      className={joinClass('popover-header', divider ? 'popover-header-divider' : undefined, className)}
      {...rest}
    >
      {showMain ? (
        <>
          <div className="popover-header-main">
            {hasRenderable(title) && <span className="popover-header-title">{title}</span>}
            {hasRenderable(subtitle) && <span className="popover-header-subtitle">{subtitle}</span>}
          </div>
          {children}
        </>
      ) : (
        children
      )}
      {hasRenderable(trailing) && <div className="popover-header-trailing">{trailing}</div>}
    </div>
  )
})
PopoverHeader.displayName = 'PopoverHeader'

export interface PopoverItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  selected?: boolean
  danger?: boolean
  icon?: string | React.ReactNode
  meta?: React.ReactNode
  trailing?: React.ReactNode
}

export const PopoverItem = React.forwardRef<HTMLButtonElement, PopoverItemProps>(function PopoverItem(
  {
    className,
    type = 'button',
    active = false,
    selected = false,
    danger = false,
    icon,
    meta,
    trailing,
    children,
    ...rest
  },
  ref,
) {
  const hasStructuredSlots = hasRenderable(icon) || hasRenderable(meta) || hasRenderable(trailing)
  return (
    <button
      ref={ref}
      type={type}
      className={joinClass(
        'popover-item',
        active ? 'popover-item-active' : undefined,
        danger ? 'popover-item-danger' : undefined,
        className,
      )}
      data-active={active ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      {...rest}
    >
      {hasStructuredSlots ? (
        <>
          {hasRenderable(icon) && (
            <span className="popover-item-icon" aria-hidden="true">
              {typeof icon === 'string' ? <HelmxIcon name={icon} size={13} /> : icon}
            </span>
          )}
          <span className="popover-item-body">
            {children}
            {hasRenderable(meta) && <span className="popover-item-meta">{meta}</span>}
          </span>
          {hasRenderable(trailing) && <span className="popover-item-trailing">{trailing}</span>}
        </>
      ) : (
        children
      )}
    </button>
  )
})
PopoverItem.displayName = 'PopoverItem'

/**
 * Generic Radix Popover wrapper component.
 */
export function Popover(props: PopoverPrimitive.PopoverProps) {
  return <PopoverPrimitive.Root {...props} />
}

Popover.Root = PopoverRoot
Popover.Trigger = PopoverTrigger
Popover.Anchor = PopoverAnchor
Popover.Portal = PopoverPortal
Popover.Content = PopoverContent
Popover.Arrow = PopoverArrow
Popover.Close = PopoverClose
Popover.Header = PopoverHeader
Popover.Item = PopoverItem
