/**
 * Unified status light shared by the host Web app and plugin client.tsx cards
 * (exported by @helmx/plugin-client): a visually dot-only indicator for the
 * card's main status slot — no visible status words (they squeeze mobile
 * layouts and duplicate neighboring text).
 *
 * Callers can pass either:
 * - `tone` (strongly typed `StatusLightTone` — recommended for plugin-owned
 *   domain states, paired with a required accessible `label` or `aria-label`);
 * - `status` (raw status word normalized via `normalizeStatusLightTone`).
 *
 * Accessibility (never color alone): `label` or `aria-label` becomes the
 * accessible name via role="img" + aria-label plus a screen-reader-only span
 * when `label` is provided (a static image-like indicator, not a chatty live
 * region); hover titles are never the only channel. Tones reuse the host
 * `.status-dot` / `.status-spinner` vocabulary and differ in shape beyond
 * color (spinning loader / hollow ring / aborted diamond).
 */
import { isValidElement, useId, type ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'
import {
  normalizeStatusLightTone,
  statusLightDotClass,
  type StatusLightTone,
} from './status-light-model.js'

interface StatusLightBaseProps {
  /** Extra classes on the wrapper (layout tweaks only, never tone overrides). */
  className?: string
}

export type StatusLightProps = StatusLightBaseProps &
  (
    | {
        /** Raw status word (running/completed/aborted/skipped/offline/...); normalized internally. */
        status: string
        tone?: never
        /** Accessible name for screen readers (localized status word); never rendered visibly. */
        label?: ReactNode
        'aria-label'?: string
      }
    | {
        /** Explicit semantic tone; skips raw status alias guessing. */
        tone: StatusLightTone
        status?: never
        /** Plain-text accessible name for screen readers (localized status word); never rendered visibly. */
        label: string
        'aria-label'?: string
      }
    | {
        /** Explicit semantic tone with an explicit aria-label accessible name. */
        tone: StatusLightTone
        status?: never
        label?: ReactNode
        'aria-label': string
      }
  )

function nonBlankText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function labelToText(label: ReactNode): string | undefined {
  if (typeof label === 'string') return nonBlankText(label)
  if (typeof label === 'number') return String(label)
  return undefined
}

function hasNonBlankNodeText(node: ReactNode): boolean {
  if (typeof node === 'string') return node.trim().length > 0
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some((item) => hasNonBlankNodeText(item))
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return hasNonBlankNodeText(node.props.children)
  }
  return false
}

export function StatusLight(props: StatusLightProps): ReactNode {
  const srLabelId = useId()
  const tone: StatusLightTone =
    props.tone !== undefined ? props.tone : normalizeStatusLightTone(props.status)
  const classes = ['helmx-status-light', `helmx-status-light-${tone}`]
  if (props.className !== undefined && props.className !== '') classes.push(props.className)
  const textLabel = labelToText(props.label)
  const hasRichLabel =
    textLabel === undefined &&
    typeof props.label !== 'string' &&
    typeof props.label !== 'number' &&
    hasNonBlankNodeText(props.label)
  const hasLabel = textLabel !== undefined || hasRichLabel
  const explicitAria = nonBlankText(props['aria-label'])
  // role="img" has presentational children in WAI-ARIA, so accessible naming
  // must use explicit `aria-label` or `aria-labelledby`:
  // 1. Explicit non-blank `aria-label` wins;
  // 2. Plain string/number `label` becomes `aria-label`;
  // 3. Non-blank rich ReactNode `label` wires `aria-labelledby` to the sr-only span;
  // 4. Otherwise fall back to non-blank raw `status` or semantic `tone`.
  const ariaLabel =
    explicitAria ??
    textLabel ??
    (hasRichLabel ? undefined : nonBlankText(props.status) ?? tone)
  const ariaLabelledBy = ariaLabel === undefined && hasRichLabel ? srLabelId : undefined
  return (
    <span
      className={classes.join(' ')}
      data-tone={tone}
      role="img"
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
      {...(ariaLabelledBy !== undefined ? { 'aria-labelledby': ariaLabelledBy } : {})}
    >
      {tone === 'working' ? (
        <span className="status-spinner status-spinner-working" aria-hidden="true">
          <HelmxIcon name="loader" size={12} className="spin-slow" />
        </span>
      ) : (
        <span className={statusLightDotClass(tone)} aria-hidden="true" />
      )}
      {hasLabel ? (
        <span id={ariaLabelledBy} className="helmx-sr-only">
          {props.label}
        </span>
      ) : null}
    </span>
  )
}
