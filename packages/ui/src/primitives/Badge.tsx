/**
 * Shared Badge primitive (SSR safe, Fast Refresh compliant):
 * Thin typed wrapper over the host `.badge` / `.badge-*` classes.
 */
import * as React from 'react'
import { HelmxIcon } from '../icons.js'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err'

export interface BadgeProps extends React.ComponentPropsWithoutRef<'span'> {
  /** Semantic tone (default `'neutral'`). */
  tone?: BadgeTone
  /** Optional leading icon: HelmxIcon name string or custom ReactNode. */
  icon?: string | React.ReactNode
  /** Apply monospace typography (`.mono`) for IDs, tokens, or numeric counts. */
  mono?: boolean
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'badge badge-neutral',
  accent: 'badge badge-accent',
  ok: 'badge badge-ok',
  warn: 'badge badge-warn',
  err: 'badge badge-err',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', icon, mono = false, className, children, ...rest },
  ref,
) {
  const leading =
    icon === undefined || icon === null || icon === false
      ? null
      : typeof icon === 'string'
        ? <HelmxIcon name={icon} size={11} />
        : icon
  return (
    <span
      ref={ref}
      className={joinClass(TONE_CLASS[tone], mono ? 'mono' : undefined, className)}
      {...rest}
    >
      {leading}
      {children !== undefined && children !== null && children !== false ? <span>{children}</span> : null}
    </span>
  )
})
