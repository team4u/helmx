/**
 * Shared FieldContext bridging <Field> metadata (controlId, describedBy,
 * invalid, required) into nested form controls (Input, Textarea, Select,
 * MultiSelect, Switch, Checkbox) without wrapping children in <label>.
 *
 * Kept in a standalone .ts module so .tsx component files only export React
 * components and TS types (Fast Refresh contract).
 */
import { createContext, useContext } from 'react'

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
