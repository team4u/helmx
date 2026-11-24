/**
 * Shared Field, HelperText, and ErrorText form primitives (SSR safe, Fast Refresh compliant):
 * - `<Field>` ALWAYS renders a non-label `<div>` container and a sibling
 *   `<label htmlFor={controlId}>` — NEVER wraps `children` in `<label>`,
 *   avoiding nested `<label>` violations with Switch/Checkbox and click-through
 *   glitches with inline MultiSelect popovers;
 * - Publishes `FieldContext` so `Input`, `Textarea`, `Select`, `MultiSelect`,
 *   `Switch`, and `Checkbox` receive `controlId`, `aria-describedby`, `invalid`,
 *   and `required` automatically;
 * - Pass `htmlFor={false}` for multi-control groups or controls that render
 *   their own inline label (renders a group heading `<span>` with
 *   `role="group" aria-labelledby`).
 */
import * as React from 'react'
import { FieldContext, type FieldContextValue } from './field-context.js'

export type FieldLayout = 'vertical' | 'horizontal'

export interface HelperTextProps extends React.ComponentPropsWithoutRef<'p'> {}

export interface ErrorTextProps extends React.ComponentPropsWithoutRef<'p'> {
  /** Emit `role="alert"` for dynamic submission-level errors (default `false` so static field errors rely on `aria-describedby`). */
  live?: boolean
}

export interface FieldProps {
  /** Visible field label text. */
  label?: React.ReactNode
  /** Secondary helper/format explanation rendered below the control. */
  hint?: React.ReactNode
  /** Validation error message; marks nested controls invalid and wires `aria-describedby`. */
  error?: React.ReactNode
  /** Visual required indicator and propagated `required` flag for nested controls. */
  required?: boolean
  /** Label/control arrangement (default `'vertical'`; `'horizontal'` collapses to vertical on narrow screens). */
  layout?: FieldLayout
  /** Explicit control ID for `<label htmlFor>`, or `false` to render a `role="group"` heading instead of `<label>`. */
  htmlFor?: string | false
  className?: string
  children?: React.ReactNode
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderableContent(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== ''
}

export const HelperText = React.forwardRef<HTMLParagraphElement, HelperTextProps>(function HelperText(
  { className, children, ...rest },
  ref,
) {
  return (
    <p ref={ref} className={joinClass('helmx-helper-text', className)} {...rest}>
      {children}
    </p>
  )
})

export const ErrorText = React.forwardRef<HTMLParagraphElement, ErrorTextProps>(function ErrorText(
  { live = false, role, className, children, ...rest },
  ref,
) {
  return (
    <p
      ref={ref}
      role={live ? 'alert' : role}
      className={joinClass('helmx-error-text', className)}
      {...rest}
    >
      {children}
    </p>
  )
})

export function Field({
  label,
  hint,
  error,
  required = false,
  layout = 'vertical',
  htmlFor,
  className,
  children,
}: FieldProps): React.ReactNode {
  const generatedId = React.useId()
  const isGroup = htmlFor === false
  const controlId = isGroup ? undefined : (htmlFor ?? generatedId)
  const labelId = `${generatedId}-label`
  const hasLabel = hasRenderableContent(label)
  const hasHint = hasRenderableContent(hint)
  const hasError = hasRenderableContent(error)
  const errorId = hasError ? `${generatedId}-error` : undefined
  const hintId = hasHint ? `${generatedId}-hint` : undefined
  // Error is listed before hint so screen readers announce the failure reason first.
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined

  const contextValue = React.useMemo<FieldContextValue>(
    () => ({
      controlId,
      describedBy,
      invalid: hasError,
      required,
    }),
    [controlId, describedBy, hasError, required],
  )

  return (
    <div
      className={joinClass(
        'helmx-field',
        layout === 'horizontal' ? 'helmx-field-horizontal' : undefined,
        className,
      )}
      role={isGroup && hasLabel ? 'group' : undefined}
      aria-labelledby={isGroup && hasLabel ? labelId : undefined}
    >
      {hasLabel ? (
        <div className="helmx-field-label-row">
          {isGroup ? (
            <span id={labelId} className="helmx-field-label">
              {label}
            </span>
          ) : (
            <label htmlFor={controlId} className="helmx-field-label">
              {label}
            </label>
          )}
          {required ? (
            <span className="helmx-field-required" aria-hidden="true">
              *
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="helmx-field-control">
        <FieldContext.Provider value={contextValue}>{children}</FieldContext.Provider>
        {hasError ? <ErrorText id={errorId}>{error}</ErrorText> : null}
        {hasHint ? <HelperText id={hintId}>{hint}</HelperText> : null}
      </div>
    </div>
  )
}
