/**
 * Shared accessible clickable-surface guard for SelectCard and ListRow.
 *
 * Kept in a standalone .ts module so .tsx component files only export React
 * components and TS types (Fast Refresh contract).
 */
import type * as React from 'react'

export const INTERACTIVE_DESCENDANT_SELECTOR =
  'button, a, input, select, textarea, label, summary, [contenteditable="true"], [contenteditable=""], [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="tab"], [role="slider"], [role="menuitem"], [role="link"]'

export function hasSelectionInside(container: HTMLElement): boolean {
  if (typeof window === 'undefined') return false
  const selection = window.getSelection?.()
  if (selection === null || selection === undefined || selection.isCollapsed === true) return false
  if (selection.toString().length === 0) return false
  const { anchorNode, focusNode } = selection
  if (anchorNode !== null && container.contains(anchorNode)) return true
  if (focusNode !== null && container.contains(focusNode)) return true
  if (typeof selection.rangeCount === 'number' && selection.rangeCount > 0) {
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i)
      if (container.contains(range.commonAncestorContainer)) return true
    }
  }
  return false
}

/**
 * Returns true when a pointer click on a card/row container surface should
 * invoke `onSelect` (ignoring prevented events, text selections, and clicks
 * targeting any nested interactive control).
 */
export function shouldTriggerSurfaceClick(event: React.MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return false
  if (hasSelectionInside(event.currentTarget)) return false
  const target = event.target
  if (target instanceof Element) {
    const interactive = target.closest(INTERACTIVE_DESCENDANT_SELECTOR)
    if (interactive !== null && event.currentTarget.contains(interactive)) {
      return false
    }
  }
  return true
}
