/**
 * Radix UI Tooltip wrapper family (host + plugin shared):
 * - Reuses host overlay CSS classes (.helmx-tooltip-content / .helmx-tooltip-arrow);
 * - Uses shared OverlayLayerContext (useOverlayChildStyle) so tooltips opened
 *   inside dialogs/drawers stay above the modal layer;
 * - Stamps data-plugin-id on TooltipContent when rendered inside a plugin
 *   PluginClientContext so portalled tooltips stay inside the plugin's CSS scope
 *   (omitted on host pages outside plugin trees);
 * - SSR-safe TooltipPortal (renders inline when typeof window === 'undefined' or inline=true).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { useOverlayChildStyle } from './overlay-stack.js'
import { usePluginScopeId } from './plugin-scope.js'

export interface TooltipProviderProps extends TooltipPrimitive.TooltipProviderProps {}

// Tracks whether an ancestor TooltipProvider already wraps this subtree so
// standalone <Tooltip> only injects a fallback Provider when rendered alone.
const TooltipProviderPresenceContext = React.createContext(false)

/** Global or scoped TooltipProvider wrapper. */
export function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 150,
  children,
  ...props
}: TooltipProviderProps) {
  return (
    <TooltipProviderPresenceContext.Provider value={true}>
      <TooltipPrimitive.Provider
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipProviderPresenceContext.Provider>
  )
}

export function TooltipRoot(props: TooltipPrimitive.TooltipProps) {
  return <TooltipPrimitive.Root {...props} />
}

export const TooltipTrigger = TooltipPrimitive.Trigger

export interface TooltipPortalProps extends TooltipPrimitive.TooltipPortalProps {
  /** Explicitly render inline (do not mount into document.body). */
  inline?: boolean
}

/**
 * SSR-tolerant portal: renders children directly during server-side rendering
 * (typeof window === 'undefined') or when inline is true.
 */
export function TooltipPortal({ children, container, inline = false }: TooltipPortalProps) {
  if (inline || typeof window === 'undefined') {
    return <>{children}</>
  }
  return <TooltipPrimitive.Portal container={container}>{children}</TooltipPrimitive.Portal>
}

export interface TooltipContentProps extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {}

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className = '', sideOffset = 5, side = 'top', align = 'center', children, style, ...props }, ref) => {
  const layeredStyle = useOverlayChildStyle(style)
  const pluginScopeId = usePluginScopeId()
  return (
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      align={align}
      data-plugin-id={pluginScopeId}
      className={`helmx-tooltip-content ${className}`.trim()}
      style={layeredStyle}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  )
})
TooltipContent.displayName = 'TooltipContent'

export interface TooltipArrowProps extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Arrow> {}

export const TooltipArrow = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Arrow>,
  TooltipArrowProps
>(({ className = '', width = 8, height = 4, ...props }, ref) => (
  <TooltipPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helmx-tooltip-arrow ${className}`.trim()}
    {...props}
  />
))
TooltipArrow.displayName = 'TooltipArrow'

export interface TooltipProps {
  content: React.ReactNode
  children?: React.ReactElement | null
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  disabled?: boolean
  inline?: boolean
  className?: string
}

/**
 * Minimal hover tooltip:
 * - reuses any ancestor TooltipProvider (preserving global skipDelayDuration
 *   and inherited delayDuration), falling back to a local TooltipProvider when
 *   rendered standalone (SSR/unit-test friendly);
 * - the hover tooltip of an icon-only button mirrors its aria-label.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 5,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  disabled = false,
  inline = false,
  className = '',
}: TooltipProps) {
  const hasOuterProvider = React.useContext(TooltipProviderPresenceContext)
  if (disabled || !content || !children) {
    return children ?? null
  }
  // Suppress native browser title tooltip while Radix Tooltip is active to prevent double tooltips.
  const triggerChild =
    React.isValidElement<{ title?: string }>(children) && children.props.title !== undefined
      ? React.cloneElement(children, { title: undefined })
      : children
  const root = (
    <TooltipPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      delayDuration={delayDuration}
    >
      <TooltipPrimitive.Trigger asChild>
        {triggerChild}
      </TooltipPrimitive.Trigger>
      <TooltipPortal inline={inline}>
        <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
          {content}
          <TooltipArrow />
        </TooltipContent>
      </TooltipPortal>
    </TooltipPrimitive.Root>
  )
  if (hasOuterProvider) {
    return root
  }
  return <TooltipProvider delayDuration={delayDuration}>{root}</TooltipProvider>
}

Tooltip.Provider = TooltipProvider
Tooltip.Root = TooltipRoot
Tooltip.Trigger = TooltipTrigger
Tooltip.Portal = TooltipPortal
Tooltip.Content = TooltipContent
Tooltip.Arrow = TooltipArrow
