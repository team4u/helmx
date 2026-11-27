/**
 * Shared FieldContext bridging <Field> metadata (controlId, describedBy,
 * invalid, required) into nested form controls (Input, Textarea, Select,
 * MultiSelect, Switch, Checkbox) without wrapping children in <label>.
 *
 * Kept in a standalone .ts module so .tsx component files only export React
 * components and TS types (Fast Refresh contract).
 */
import { createContext, useContext, type AriaAttributes, type ComponentPropsWithoutRef } from 'react'

export interface FieldContextValue {
  /** Generated or explicit control ID associated with <Field>'s <label htmlFor>. Undefined in htmlFor={false} group mode. */
  controlId: string | undefined
  /** Space-separated hint/error element IDs for aria-describedby wiring. */
  describedBy: string | undefined
  /** True when the enclosing <Field> currently displays a validation error. */
  invalid: boolean
  /** True when the enclosing <Field> is marked required. */
  required: boolean
}

export const FieldContext = createContext<FieldContextValue | null>(null)

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}

/**
 * Merge caller-supplied aria-describedby tokens with FieldContext IDs while
 * preserving order and deduplicating tokens so neither source overwrites the other.
 */
export function mergeAriaDescribedBy(
  callerDescribedBy: string | undefined,
  fieldDescribedBy: string | undefined,
): string | undefined {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const raw of [callerDescribedBy, fieldDescribedBy]) {
    if (raw === undefined || raw === '') continue
    for (const token of raw.trim().split(/\s+/)) {
      if (token === '' || seen.has(token)) continue
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens.length > 0 ? tokens.join(' ') : undefined
}

/** Explicit caller props that take precedence over the values supplied by `<Field>`. */
export interface FieldControlOverrides {
  id: string | undefined
  required: boolean | undefined
  /** Shorthand `invalid` prop of SDK controls; wins over a raw `aria-invalid` when both are given. */
  invalid: boolean | undefined
  'aria-invalid': AriaAttributes['aria-invalid'] | undefined
  'aria-describedby': string | undefined
}

/** Native-control attributes resolved against `<Field>` context, ready to spread onto the element. */
export type FieldControlProps = Pick<
  ComponentPropsWithoutRef<'input'>,
  'id' | 'required' | 'aria-invalid' | 'aria-describedby'
>

function resolveAriaInvalid(
  invalidProp: boolean | undefined,
  ariaInvalidProp: AriaAttributes['aria-invalid'] | undefined,
  fieldInvalid: boolean | undefined,
): AriaAttributes['aria-invalid'] {
  if (invalidProp !== undefined) return invalidProp ? true : undefined
  if (ariaInvalidProp !== undefined) return ariaInvalidProp
  return fieldInvalid === true ? true : undefined
}

/**
 * Resolves `id`, `required`, `aria-invalid`, and `aria-describedby` for a native form control:
 * explicit caller props win, otherwise the enclosing `<Field>` supplies them
 * (`aria-describedby` tokens from both sources are merged).
 */
export function useFieldControlProps(overrides: FieldControlOverrides): FieldControlProps {
  const field = useFieldContext()
  return {
    id: overrides.id ?? field?.controlId,
    required: overrides.required ?? (field?.required === true ? true : undefined),
    'aria-invalid': resolveAriaInvalid(overrides.invalid, overrides['aria-invalid'], field?.invalid),
    'aria-describedby': mergeAriaDescribedBy(overrides['aria-describedby'], field?.describedBy),
  }
}
