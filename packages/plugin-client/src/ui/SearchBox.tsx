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
import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import {
  HELMX_SHORTCUT_EVENT,
  isShortcutPanelMatch,
  type HelmxShortcutEventDetail,
} from './model-picker-model.js'

export type SearchBoxVariant = 'default' | 'toolbar'

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

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref !== null && ref !== undefined) {
    ;(ref as { current: T | null }).current = value
  }
}

function isSearchInputFocusable(input: HTMLInputElement | null): boolean {
  if (input === null || !input.isConnected || input.disabled) return false
  const win = input.ownerDocument?.defaultView
  let cur: Element | null = input
  while (cur !== null) {
    if ((cur as HTMLElement).hidden === true) return false
    if (cur.hasAttribute('inert') || cur.getAttribute('aria-hidden') === 'true') return false
    const inlineStyle = (cur as HTMLElement).style
    if (inlineStyle?.display === 'none' || inlineStyle?.visibility === 'hidden') return false
    if (win !== null && win !== undefined && typeof win.getComputedStyle === 'function') {
      try {
        const computed = win.getComputedStyle(cur)
        if (computed.display === 'none' || computed.visibility === 'hidden') return false
      } catch {
        /* ignore detached or cross-realm elements */
      }
    }
    cur = cur.parentElement
  }
  return true
}

export interface SearchBoxProps {
  /** Current query value (fully controlled). */
  value: string
  /** Emits the next input value (already unwrapped from the DOM event). */
  onChange: (nextValue: string) => void
  /** Visual density/width variant ('default' compact .search-box, 'toolbar' primary-stage toolbar spec). */
  variant?: SearchBoxVariant
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
   * Opt in/out of host `/` focus (`helmx:shortcut` `focus-search`) and built-in
   * `Escape` clear-then-blur keyboard behavior. Defaults to `variant === 'toolbar'`.
   */
  enableSlashFocus?: boolean
}

/** Unified search input shell over the host container-class vocabulary; state stays with the caller. */
export function SearchBox(props: SearchBoxProps): ReactNode {
  const t = usePluginTranslator()
  const {
    value,
    onChange,
    variant = 'default',
    placeholder,
    ariaLabel,
    clearLabel = t(uiCopy.clear),
    className,
    inputClassName,
    clearButtonClassName,
    icon = <HelmxIcon name="search" size={14} />,
    clearIcon = <HelmxIcon name="x" size={12} />,
    inputRef,
    onKeyDown,
    disabled = false,
    style,
    clearable = true,
    onCleared,
    enableSlashFocus,
  } = props
  const slashFocusEnabled = enableSlashFocus ?? variant === 'toolbar'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const internalInputRef = useRef<HTMLInputElement | null>(null)
  const mergedInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      internalInputRef.current = node
      assignRef(inputRef, node)
    },
    [inputRef],
  )

  useEffect(() => {
    if (!slashFocusEnabled || disabled || typeof window === 'undefined') return
    const onShortcut = (event: Event): void => {
      if (event.defaultPrevented) return
      const detail = (event as CustomEvent<Partial<HelmxShortcutEventDetail> | undefined>).detail
      if (detail === undefined || detail === null || detail.action !== 'focus-search') return
      if (!isShortcutPanelMatch(containerRef.current, detail.panel)) return
      const input = internalInputRef.current
      if (!isSearchInputFocusable(input)) return
      event.preventDefault()
      input!.focus()
      input!.select?.()
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
  }, [slashFocusEnabled, disabled])

  const containerClass =
    variant === 'toolbar'
      ? mergeClassTokens(VARIANT_CONTAINER_CLASS.toolbar, className)
      : (className ?? VARIANT_CONTAINER_CLASS[variant])
  const clearClass = clearButtonClassName ?? DEFAULT_CLEAR_BUTTON_CLASS

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event)
    if (!slashFocusEnabled || disabled || event.defaultPrevented) return
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
    <div ref={containerRef} className={containerClass} style={style}>
      {icon}
      <input
        ref={mergedInputRef}
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
