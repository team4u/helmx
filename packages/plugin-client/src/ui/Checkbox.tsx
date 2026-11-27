import React from 'react'
import { HelmxIcon } from '../icons.js'
import { useToggleControl } from './toggle-control.js'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  indeterminate?: boolean
  invalid?: boolean
  required?: boolean
  label?: React.ReactNode
  id?: string
  name?: string
  title?: string
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
  'aria-describedby'?: string
}

/**
 * Minimal checkbox component (a common primitive in the restrained Helmx style):
 * - Compact size (15px x 15px), hairline border and slight rounding (3px);
 * - Precise vector icons for checked (check) and indeterminate (minus) states;
 * - Full WAI-ARIA checkbox semantics and keyboard interaction (Space / Enter toggles);
 * - Unified minimal design, no Emoji.
 */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  indeterminate = false,
  invalid,
  required,
  label,
  id,
  name,
  title,
  className = '',
  style,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: CheckboxProps) {
  const control = useToggleControl({
    checked,
    onChange,
    disabled,
    invalid,
    required,
    label,
    id,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
  })

  const wrapClass = ['helmx-checkbox-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helmx-checkbox', checked && 'is-checked', indeterminate && 'is-indeterminate'].filter(Boolean).join(' ')

  return (
    <span className={wrapClass} style={style} title={title}>
      <button
        type="button"
        role="checkbox"
        id={control.controlId}
        name={name}
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={control.ariaLabel}
        aria-invalid={control.ariaInvalid}
        aria-required={control.ariaRequired}
        aria-describedby={control.ariaDescribedBy}
        disabled={disabled}
        className={buttonClass}
        onClick={control.onClick}
        onKeyDown={control.onKeyDown}
        title={title}
      >
        {indeterminate ? (
          <HelmxIcon name="minus" size={10} className="helmx-checkbox-icon" />
        ) : checked ? (
          <HelmxIcon name="check" size={10} className="helmx-checkbox-icon" />
        ) : null}
      </button>
      {control.hasOwnLabel ? (
        <label htmlFor={control.controlId} className="helmx-checkbox-label">
          {label}
        </label>
      ) : null}
    </span>
  )
}
