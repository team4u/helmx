import React, { useId } from 'react'
import { mergeAriaDescribedBy, useFieldContext } from './field-context.js'

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
  const generatedId = useId()
  const field = useFieldContext()
  const hasOwnLabel = label !== undefined && label !== null && label !== ''
  // When Switch renders its own <label htmlFor>, keep a self-contained ID so
  // an enclosing <Field> label does not collide with the inner label.
  const switchId = id ?? (hasOwnLabel ? generatedId : (field?.controlId ?? generatedId))
  const resolvedInvalid = invalid ?? field?.invalid ?? false
  const resolvedRequired = required ?? (field?.required === true ? true : undefined)
  const resolvedDescribedBy = mergeAriaDescribedBy(ariaDescribedBy, field?.describedBy)

  const handleClick = () => {
    if (!disabled) {
      onChange(!checked)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onChange(!checked)
    }
  }

  const wrapClass = ['helmx-switch-wrap', disabled && 'is-disabled', className].filter(Boolean).join(' ')
  const buttonClass = ['helmx-switch', checked && 'is-checked'].filter(Boolean).join(' ')

  const switchButton = (
    <button
      type="button"
      role="switch"
      id={switchId}
      name={name}
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      aria-invalid={resolvedInvalid ? true : undefined}
      aria-required={resolvedRequired}
      aria-describedby={resolvedDescribedBy}
      disabled={disabled}
      className={buttonClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={title}
    >
      <span className="helmx-switch-thumb" />
    </button>
  )

  return (
    <span className={wrapClass} style={style} title={title}>
      {switchButton}
      {hasOwnLabel ? (
        <label htmlFor={switchId} className="helmx-switch-label">
          {label}
        </label>
      ) : null}
    </span>
  )
}
