import React from 'react'
import { useToggleControl } from './toggle-control.js'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
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
 * Minimal slide switch component (a common primitive in the restrained Helmx style):
 * - Compact size (28px x 16px), smooth micro-animation movement;
 * - Full WAI-ARIA switch semantics and keyboard accessibility (Space / Enter toggles);
 * - Unified minimal design, no Emoji.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
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
}: SwitchProps) {
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

  const wrapClass = ['helmx-switch-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helmx-switch', checked && 'is-checked'].filter(Boolean).join(' ')

  return (
    <span className={wrapClass} style={style} title={title}>
      <button
        type="button"
        role="switch"
        id={control.controlId}
        name={name}
        aria-checked={checked}
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
        <span className="helmx-switch-thumb" />
      </button>
      {control.hasOwnLabel ? (
        <label htmlFor={control.controlId} className="helmx-switch-label">
          {label}
        </label>
      ) : null}
    </span>
  )
}
