/**
 * Shared flex layout primitive (SSR safe, Fast Refresh compliant):
 * Maps spacing scale tiers (`none | xs | sm | md | lg | xl`) onto static
 * host CSS classes backed by `--space-1..5` (zero inline style gap hacks).
 */
import * as React from 'react'

export type StackDirection = 'vertical' | 'horizontal'
export type StackGap = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type StackAlign = 'start' | 'center' | 'end' | 'stretch' | 'baseline'
export type StackJustify = 'start' | 'center' | 'end' | 'between'

export interface StackProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Flex axis direction (default `'vertical'`). */
  direction?: StackDirection
  /** Spacing scale step mapped to `--space-*` tokens (default `'sm'` = 8px). */
  gap?: StackGap
  /** Cross-axis alignment. */
  align?: StackAlign
  /** Main-axis distribution. */
  justify?: StackJustify
  /** Allow items to wrap across lines. */
  wrap?: boolean
  /** Render as `inline-flex` instead of block `flex`. */
  inline?: boolean
}

const DIRECTION_CLASS: Record<StackDirection, string> = {
  vertical: 'helmx-stack-vertical',
  horizontal: 'helmx-stack-horizontal',
}

const GAP_CLASS: Record<StackGap, string> = {
  none: 'helmx-stack-gap-none',
  xs: 'helmx-stack-gap-xs',
  sm: 'helmx-stack-gap-sm',
  md: 'helmx-stack-gap-md',
  lg: 'helmx-stack-gap-lg',
  xl: 'helmx-stack-gap-xl',
}

const ALIGN_CLASS: Record<StackAlign, string> = {
  start: 'helmx-stack-align-start',
  center: 'helmx-stack-align-center',
  end: 'helmx-stack-align-end',
  stretch: 'helmx-stack-align-stretch',
  baseline: 'helmx-stack-align-baseline',
}

const JUSTIFY_CLASS: Record<StackJustify, string> = {
  start: 'helmx-stack-justify-start',
  center: 'helmx-stack-justify-center',
  end: 'helmx-stack-justify-end',
  between: 'helmx-stack-justify-between',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const Stack = React.forwardRef<HTMLDivElement, StackProps>(function Stack(
  {
    direction = 'vertical',
    gap = 'sm',
    align,
    justify,
    wrap = false,
    inline = false,
    className,
    children,
    ...rest
  },
  ref,
) {
  const resolvedClass = joinClass(
    'helmx-stack',
    inline ? 'helmx-stack-inline' : undefined,
    DIRECTION_CLASS[direction],
    GAP_CLASS[gap],
    align !== undefined ? ALIGN_CLASS[align] : undefined,
    justify !== undefined ? JUSTIFY_CLASS[justify] : undefined,
    wrap ? 'helmx-stack-wrap' : undefined,
    className,
  )
  return (
    <div ref={ref} className={resolvedClass} {...rest}>
      {children}
    </div>
  )
})
