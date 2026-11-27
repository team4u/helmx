/**
 * Unified keyboard shortcut keycap primitive (SSR safe, Fast Refresh compliant):
 * Thin typed wrapper over `<kbd className="helmx-kbd ...">` (20px default /
 * 18px `sm` monospace keycap badge).
 */
import * as React from 'react'

export type KbdSize = 'sm' | 'md'

export interface KbdProps extends React.ComponentPropsWithoutRef<'kbd'> {
  /** Keycap height tier: `'md'` (default, 20px) or `'sm'` (18px for compact inline hints). */
  size?: KbdSize
  /** Hide automatically on narrow viewports (`<= 680px`) and coarse touch devices. */
  desktopOnly?: boolean
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { size = 'md', desktopOnly = false, className, ...rest },
  ref,
) {
  return (
    <kbd
      ref={ref}
      className={joinClass(
        'helmx-kbd',
        size === 'sm' ? 'helmx-kbd-sm' : undefined,
        desktopOnly ? 'helmx-kbd-desktop-only' : undefined,
        className,
      )}
      {...rest}
    />
  )
})
