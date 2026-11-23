/**
 * Unified search box primitive (host + plugin shared).
 *
 * The whole site has exactly one search appearance: a container class carries
 * the border / background / focus ring while the inner input stays transparent
 * and frameless (see the shared search-box spec in the host styles). This
 * component encodes that contract once:
 * - always type="text" (never type="search", which would stack a native clear
 *   X on top of the custom clear button);
 * - at most one clear button, rendered only when the value is non-empty;
 * - no portal, no window access — renderToString works directly.
 *
 * The container class is caller-chosen among the host common vocabulary
 * (.search-box compact / .primary-search-box toolbar / .plugin-search-box /
 * screen-local containers), so this file introduces no new CSS theme.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'

export interface SearchBoxProps {
  /** Current query value (fully controlled). */
  value: string
  /** Emits the next input value (already unwrapped from the DOM event). */
  onChange: (nextValue: string) => void
  placeholder?: string
  /** Accessible name of the input (mirrors the visible placeholder intent). */
  ariaLabel?: string
  /** title + aria-label of the single clear button (defaults to the shared UI locale). */
  clearLabel?: string
  /** Container class: pick from the host common vocabulary (defaults to the compact .search-box). */
  className?: string
  /** Extra classes for the inner input (e.g. sidebar-search-input). */
  inputClassName?: string
  /** Clear button classes (defaults to the ghost sm button; center variants add their -clear class). */
  clearButtonClassName?: string
  /** Leading icon node (defaults to the search glyph). */
  icon?: ReactNode
  /** Clear button glyph (defaults to the x icon). */
  clearIcon?: ReactNode
  /** Ref forwarded to the inner input (focus restore after clearing etc.). */
  inputRef?: Ref<HTMLInputElement>
  /** Escape-to-clear wiring and other keyboard behavior stays with the caller. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  disabled?: boolean
  /** Container inline styles (layout integration such as flex sizing). */
  style?: CSSProperties
  /** Whether to render the single clear button (default true; command-palette style surfaces may clear differently). */
  clearable?: boolean
  /** Invoked right after a clear click (e.g. restore input focus); state stays with onChange. */
  onCleared?: () => void
}

/** Unified search input shell over the host container-class vocabulary; state stays with the caller. */
export function SearchBox(props: SearchBoxProps): ReactNode {
  const t = usePluginTranslator()
  const {
    value,
    onChange,
    placeholder,
    ariaLabel,
    clearLabel = t(uiCopy.clear),
    className = 'search-box',
    inputClassName,
    clearButtonClassName = 'btn btn-ghost btn-sm',
    icon = <HelmxIcon name="search" size={14} />,
    clearIcon = <HelmxIcon name="x" size={12} />,
    inputRef,
    onKeyDown,
    disabled = false,
    style,
    clearable = true,
    onCleared,
  } = props
  return (
    <div className={className} style={style}>
      {icon}
      <input
        ref={inputRef}
        // Shared search-box spec: never type="search" (native clear X would
        // double the custom clear button and stack a second focus ring).
        type="text"
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      {clearable && value !== '' && (
        <button
          type="button"
          className={clearButtonClassName}
          title={clearLabel}
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => {
            onChange('')
            onCleared?.()
          }}
        >
          {clearIcon}
        </button>
      )}
    </div>
  )
}
