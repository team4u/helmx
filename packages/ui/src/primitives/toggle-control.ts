/**
 * Shared behavior for the button-based boolean controls (`Checkbox`, `Switch`): resolves the
 * control ID against `<Field>` context, merges ARIA state, and provides the click and
 * Space / Enter toggling handlers with the `disabled` guard.
 *
 * Kept in a standalone .ts module so .tsx component files only export React components and
 * TS types (Fast Refresh contract).
 */
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { mergeAriaDescribedBy, useFieldContext } from './field-context.js'

/** Prop subset that `Checkbox` and `Switch` share verbatim. */
export interface ToggleControlOptions {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  invalid?: boolean
  required?: boolean
  label?: ReactNode
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export interface ToggleControl {
  /** True when the control renders its own `<label htmlFor>` next to the button. */
  hasOwnLabel: boolean
  controlId: string
  ariaLabel: string | undefined
  ariaInvalid: true | undefined
  ariaRequired: boolean | undefined
  ariaDescribedBy: string | undefined
  onClick: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

export function useToggleControl(options: ToggleControlOptions): ToggleControl {
  const { checked, onChange, disabled = false, invalid, required, label, id } = options
  const generatedId = useId()
  const field = useFieldContext()
  const hasOwnLabel = label !== undefined && label !== null && label !== ''
  // When the control renders its own <label htmlFor>, keep a self-contained ID so
  // an enclosing <Field> label does not collide with the inner label.
  const controlId = id ?? (hasOwnLabel ? generatedId : (field?.controlId ?? generatedId))

  const toggle = (): void => {
    if (!disabled) onChange(!checked)
  }

  return {
    hasOwnLabel,
    controlId,
    ariaLabel: options['aria-label'] ?? (typeof label === 'string' ? label : undefined),
    ariaInvalid: (invalid ?? field?.invalid ?? false) ? true : undefined,
    ariaRequired: required ?? (field?.required === true ? true : undefined),
    ariaDescribedBy: mergeAriaDescribedBy(options['aria-describedby'], field?.describedBy),
    onClick: toggle,
    onKeyDown: (event) => {
      if (disabled) return
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        onChange(!checked)
      }
    },
  }
}
