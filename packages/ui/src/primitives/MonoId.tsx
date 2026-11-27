/**
 * Shared MonoId primitive (SSR safe, Fast Refresh compliant):
 * Monospace identifier pill with single-line ellipsis truncation, full-value
 * hover title, and optional integrated CopyButton (stops click propagation so
 * it composes cleanly inside SelectCard or clickable table rows).
 */
import * as React from 'react'
import { CopyButton } from '../copy-button.js'

export interface MonoIdProps extends React.ComponentPropsWithoutRef<'span'> {
  /** Full raw identifier copied to the clipboard and shown in the hover title. */
  value: string
  /** Optional shortened/formatted text rendered inside `<code>` (defaults to `value`). */
  display?: React.ReactNode
  /** Show an inline copy button (default `true`). */
  copyable?: boolean
  /** Optional visible label passed to `CopyButton`. */
  copyLabel?: string
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const MonoId = React.forwardRef<HTMLSpanElement, MonoIdProps>(function MonoId(
  { value, display, copyable = true, copyLabel, className, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={joinClass('helmx-mono-id', className)} {...rest}>
      <code className="helmx-mono-id-code" title={value}>
        {display ?? value}
      </code>
      {copyable ? (
        <CopyButton
          text={value}
          label={copyLabel}
          className={
            copyLabel !== undefined
              ? 'btn btn-ghost btn-xs helmx-mono-id-copy'
              : 'btn btn-ghost btn-icon-xs helmx-mono-id-copy'
          }
        />
      ) : null}
    </span>
  )
})
