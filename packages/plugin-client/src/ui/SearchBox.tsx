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
 * - semantic `variant="default" | "toolbar"` picks the host `.search-box` /
 *   `.search-box-toolbar` & `.search-box-clear` vocabulary without hand-wiring
 *   custom container/button classes;
 * - no portal, no window access — renderToString works directly.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import { useContext, type AriaAttributes, type AriaRole, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import { ScreenToolbarContext } from './screen-toolbar-context.js'

export type SearchBoxVariant = 'default' | 'toolbar'
export type SearchBoxSize = 'sm' | 'md'

const VARIANT_CONTAINER_CLASS: Record<SearchBoxVariant, string> = {
  default: 'search-box',
  toolbar: 'search-box search-box-toolbar',
}

const DEFAULT_CLEAR_BUTTON_CLASS = 'btn btn-ghost btn-sm search-box-clear'

function mergeClassTokens(base: string, extra?: string): string {
  if (extra === undefined || extra.trim() === '') return base
  const seen = new Set(base.split(/\s+/).filter(Boolean))
  const appended = extra
    .split(/\s+/)
    .filter((token) => token !== '' && !seen.has(token))
  return appended.length > 0 ? `${base} ${appended.join(' ')}` : base
}

export interface SearchBoxProps {
  /** Current query value (fully controlled). */
  value: string
  /** Emits the next input value (already unwrapped from the DOM event). */
  onChange: (nextValue: string) => void
  /** Visual density/width variant ('default' compact .search-box, 'toolbar' primary-stage toolbar spec). */
  variant?: SearchBoxVariant
  /** Control height tier (default `'md'`: 32px; `'sm'`: 28px for compact toolbars and narrow panels). */
  size?: SearchBoxSize
  placeholder?: string
  /** Accessible name of the input (mirrors the visible placeholder intent). */
  ariaLabel?: string
  /** title + aria-label of the single clear button (defaults to the shared UI locale). */
  clearLabel?: string
  /** Container class: extends `variant="toolbar"`, or overrides the default `.search-box` container. */
  className?: string
  /** Extra classes for the inner input (e.g. sidebar-search-input). */
  inputClassName?: string
  /** Clear button classes (defaults to `btn btn-ghost btn-sm search-box-clear`). */
  clearButtonClassName?: string
  /** Leading icon node (defaults to the search glyph). */
  icon?: ReactNode
  /** Clear button glyph (defaults to the x icon). */
  clearIcon?: ReactNode
  /** Ref forwarded to the inner input (focus restore after clearing etc.). */
  inputRef?: Ref<HTMLInputElement>
  /** Keyboard handler invoked before built-in toolbar Escape clear/blur behavior. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  disabled?: boolean
  /** Container inline styles (layout integration such as flex sizing). */
  style?: CSSProperties
  /** Whether to render the single clear button (default true; command-palette style surfaces may clear differently). */
  clearable?: boolean
  /** Invoked right after a clear action (e.g. restore input focus); state stays with onChange. */
  onCleared?: () => void
  /**
   * Opt in/out of built-in `Escape` clear-then-blur keyboard behavior.
   * Defaults to `variant === 'toolbar'` or when rendered inside a `ScreenToolbar`.
   */
  clearOnEscape?: boolean
  /** Optional combobox / listbox role and ARIA attributes forwarded to the inner text input. */
  inputRole?: AriaRole
  ariaAutocomplete?: AriaAttributes['aria-autocomplete']
  ariaControls?: string
  ariaExpanded?: boolean
  ariaActiveDescendant?: string
}

/** Unified search input shell over the host container-class vocabulary; state stays with the caller. */
export function SearchBox(props: SearchBoxProps): ReactNode {
  const t = usePluginTranslator()
  const inScreenToolbar = useContext(ScreenToolbarContext)
  const {
    value,
    onChange,
    variant = 'default',
    size = 'md',
    placeholder,
    ariaLabel,
    clearLabel = t(uiCopy.clear),
    className,
    inputClassName,
    clearButtonClassName,
    icon,
    clearIcon = <HelmxIcon name="x" size={12} />,
    inputRef,
    onKeyDown,
    disabled = false,
    style,
    clearable = true,
    onCleared,
    clearOnEscape,
    inputRole,
    ariaAutocomplete,
    ariaControls,
    ariaExpanded,
    ariaActiveDescendant,
  } = props
  const escapeClearEnabled = clearOnEscape ?? (variant === 'toolbar' || inScreenToolbar)
  const resolvedIcon = icon !== undefined ? icon : <HelmxIcon name="search" size={size === 'sm' ? 13 : 14} />

  const baseContainerClass =
    variant === 'toolbar'
      ? mergeClassTokens(VARIANT_CONTAINER_CLASS.toolbar, className)
      : (className ?? VARIANT_CONTAINER_CLASS[variant])
  const containerClass =
    size === 'sm' ? mergeClassTokens(baseContainerClass, 'search-box-sm') : baseContainerClass
  const clearClass = clearButtonClassName ?? DEFAULT_CLEAR_BUTTON_CLASS

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event)
    if (!escapeClearEnabled || disabled || event.defaultPrevented) return
    if (event.nativeEvent?.isComposing === true || event.keyCode === 229) return
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (value !== '') {
        onChange('')
        onCleared?.()
      } else {
        event.currentTarget.blur()
      }
    }
  }

  return (
    <div className={containerClass} style={style}>
      {resolvedIcon}
      <input
        ref={inputRef}
        // Shared search-box spec: never type="search" (native clear X would
        // double the custom clear button and stack a second focus ring).
        type="text"
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        role={inputRole}
        aria-label={ariaLabel}
        aria-autocomplete={ariaAutocomplete}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-activedescendant={ariaActiveDescendant}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        onKeyDown={handleKeyDown}
      />
      {clearable && value !== '' && (
        <button
          type="button"
          className={clearClass}
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
