/**
 * Shared Radix Popover floating shell above `.composer-box` for CommandPopover
 * and CompletionPopover (preserves textarea focus & ignores clicks inside the input).
 */
import type { ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@helmx/plugin-client'

export interface ComposerPopoverShellProps {
  open: boolean
  anchor: HTMLElement
  inputRef?: { current: HTMLElement | null }
  ariaLabel: string
  onClose: () => void
  children: ReactNode
}

export function ComposerPopoverShell({
  open,
  anchor,
  inputRef,
  ariaLabel,
  onClose,
  children,
}: ComposerPopoverShellProps): ReactNode {
  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="composer-popover composer-completion-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const inputEl = inputRef?.current
          const target = event.target
          if (inputEl !== null && inputEl !== undefined && target instanceof Node && inputEl.contains(target)) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        aria-label={ariaLabel}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
