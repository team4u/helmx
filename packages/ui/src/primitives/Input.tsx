/**
 * Shared Input and Textarea primitives (SSR safe, Fast Refresh compliant):
 * - Thin wrappers over the host `.input` / `.input-sm` / `.helmx-input-wrap` / `.textarea` classes;
 * - Optional inline `prefix` / `suffix` affixes wrap the input in `.helmx-input-wrap` with a
 *   unified `:focus-within` border/ring while forwarding `ref` and `FieldContext` props to the
 *   inner `<input>`;
 * - Automatically connect to an enclosing `<Field>` via `useFieldControlProps`
 *   (`id`, `aria-describedby`, `aria-invalid`, `required`) while honoring
 *   explicit caller props and merging `aria-describedby` tokens;
 * - React.forwardRef preserves full native DOM ref access.
 */
import * as React from 'react'
import { useFieldControlProps } from './field-context.js'

export type InputSize = 'sm' | 'md'

export interface InputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'size' | 'prefix'> {
  /** Visual height density (default `'md'`: 32px; `'sm'`: 28px). */
  size?: InputSize
  /** Marks the control invalid (`aria-invalid="true"`) with error border styling. */
  invalid?: boolean
  /** Apply monospace font (`.mono`) for identifiers, endpoints, cron expressions, or numbers. */
  mono?: boolean
  /** Optional native HTML `size` attribute (character width hint). */
  htmlSize?: number
  /** Optional leading inline affix rendered inside the input frame (e.g. `"tier/"`, icon). */
  prefix?: React.ReactNode
  /** Optional trailing inline affix rendered inside the input frame (e.g. `"s"`, `"ms"`, `"%"`). */
  suffix?: React.ReactNode
  /** Extra class name applied to the inner `<input>` element (useful when `prefix`/`suffix` is set). */
  inputClassName?: string
}

export interface TextareaProps extends React.ComponentPropsWithoutRef<'textarea'> {
  /** Marks the control invalid (`aria-invalid="true"`) with error border styling. */
  invalid?: boolean
  /** Apply monospace font (`.mono`) for scripts, JSON, or templates. */
  mono?: boolean
}

const INPUT_SIZE_CLASS: Record<InputSize, string> = {
  md: 'input',
  sm: 'input input-sm',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasAffix(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== ''
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    invalid,
    mono = false,
    htmlSize,
    prefix,
    suffix,
    inputClassName,
    id,
    required,
    disabled,
    style,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    className,
    ...rest
  },
  ref,
) {
  const fieldProps = useFieldControlProps({
    id,
    required,
    invalid,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
  })
  const hasPrefix = hasAffix(prefix)
  const hasSuffix = hasAffix(suffix)

  if (hasPrefix || hasSuffix) {
    const isInvalid = fieldProps['aria-invalid'] === true || fieldProps['aria-invalid'] === 'true'
    const wrapClass = joinClass(
      'helmx-input-wrap',
      size === 'sm' ? 'helmx-input-wrap-sm' : undefined,
      mono ? 'mono' : undefined,
      isInvalid ? 'is-invalid' : undefined,
      disabled ? 'is-disabled' : undefined,
      className,
    )
    const innerClass = joinClass('helmx-input-inner', mono ? 'mono' : undefined, inputClassName)
    return (
      <div className={wrapClass} style={style}>
        {hasPrefix ? <span className="helmx-input-prefix">{prefix}</span> : null}
        <input
          ref={ref}
          {...fieldProps}
          disabled={disabled}
          size={htmlSize}
          className={innerClass}
          {...rest}
        />
        {hasSuffix ? <span className="helmx-input-suffix">{suffix}</span> : null}
      </div>
    )
  }

  const resolvedClass = joinClass(INPUT_SIZE_CLASS[size], mono ? 'mono' : undefined, inputClassName, className)
  return (
    <input
      ref={ref}
      {...fieldProps}
      disabled={disabled}
      size={htmlSize}
      style={style}
      className={resolvedClass}
      {...rest}
    />
  )
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    invalid,
    mono = false,
    id,
    required,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    className,
    ...rest
  },
  ref,
) {
  const fieldProps = useFieldControlProps({
    id,
    required,
    invalid,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
  })
  const resolvedClass = joinClass('textarea', mono ? 'mono' : undefined, className)
  return (
    <textarea
      ref={ref}
      {...fieldProps}
      className={resolvedClass}
      {...rest}
    />
  )
})
