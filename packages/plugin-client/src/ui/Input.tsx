/**
 * Shared Input and Textarea primitives (SSR safe, Fast Refresh compliant):
 * - Thin wrappers over the host `.input` / `.input-sm` / `.textarea` classes;
 * - Automatically connect to an enclosing `<Field>` via `FieldContext`
 *   (`id`, `aria-describedby`, `aria-invalid`, `required`) while honoring
 *   explicit caller props and merging `aria-describedby` tokens;
 * - React.forwardRef preserves full native DOM ref access.
 */
import * as React from 'react'
import { mergeAriaDescribedBy, useFieldContext } from './field-context.js'

export type InputSize = 'sm' | 'md'

export interface InputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'size'> {
  /** Visual height density (default `'md'`: 30px; `'sm'`: 26px). */
  size?: InputSize
  /** Marks the control invalid (`aria-invalid="true"`) with error border styling. */
  invalid?: boolean
  /** Apply monospace font (`.mono`) for identifiers, endpoints, cron expressions, or numbers. */
  mono?: boolean
  /** Optional native HTML `size` attribute (character width hint). */
  htmlSize?: number
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

function resolveAriaInvalid(
  invalidProp: boolean | undefined,
  ariaInvalidProp: React.AriaAttributes['aria-invalid'],
  fieldInvalid: boolean | undefined,
): React.AriaAttributes['aria-invalid'] {
  if (invalidProp !== undefined) return invalidProp ? true : undefined
  if (ariaInvalidProp !== undefined) return ariaInvalidProp
  return fieldInvalid === true ? true : undefined
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    invalid,
    mono = false,
    htmlSize,
    id,
    required,
    'aria-invalid': ariaInvalid,
    'aria-describedby': ariaDescribedBy,
    className,
    ...rest
  },
  ref,
) {
  const field = useFieldContext()
  const resolvedId = id ?? field?.controlId
  const resolvedRequired = required ?? (field?.required === true ? true : undefined)
  const resolvedAriaInvalid = resolveAriaInvalid(invalid, ariaInvalid, field?.invalid)
  const resolvedDescribedBy = mergeAriaDescribedBy(ariaDescribedBy, field?.describedBy)
  const resolvedClass = joinClass(INPUT_SIZE_CLASS[size], mono ? 'mono' : undefined, className)
  return (
    <input
      ref={ref}
      id={resolvedId}
      size={htmlSize}
      required={resolvedRequired}
      aria-invalid={resolvedAriaInvalid}
      aria-describedby={resolvedDescribedBy}
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
  const field = useFieldContext()
  const resolvedId = id ?? field?.controlId
  const resolvedRequired = required ?? (field?.required === true ? true : undefined)
  const resolvedAriaInvalid = resolveAriaInvalid(invalid, ariaInvalid, field?.invalid)
  const resolvedDescribedBy = mergeAriaDescribedBy(ariaDescribedBy, field?.describedBy)
  const resolvedClass = joinClass('textarea', mono ? 'mono' : undefined, className)
  return (
    <textarea
      ref={ref}
      id={resolvedId}
      required={resolvedRequired}
      aria-invalid={resolvedAriaInvalid}
      aria-describedby={resolvedDescribedBy}
      className={resolvedClass}
      {...rest}
    />
  )
})
