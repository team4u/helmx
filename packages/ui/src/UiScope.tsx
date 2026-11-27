/**
 * Layout-transparent CSS scope anchor for scoped UI subtrees (e.g. plugin views).
 *
 * Establishes `UiScopeContext` for portalled primitives (`Dialog`, `AlertDialog`,
 * `Popover`, `DropdownMenu`, `Tooltip`, `Select`, `Screen`) and renders
 * `<div data-plugin-id="..." style={{ display: 'contents' }}>` so flex, grid,
 * and inline parent-child layouts keep direct-child semantics while every
 * descendant matches `:where([data-plugin-id="<id>"])` selectors. When rendered
 * outside a scope without an explicit non-empty `scopeId`, passes children
 * through unwrapped.
 *
 * Component & type exports only (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import { UiScopeContext, useUiScopeId } from './ui-scope-context.js'

export interface UiScopeProps {
  /** Explicit scope identifier; defaults to any enclosing `UiScopeContext` value. */
  scopeId?: string
  children?: ReactNode
}

export function UiScope({ scopeId, children }: UiScopeProps): ReactNode {
  const resolved = useUiScopeId(scopeId)
  if (resolved === undefined) {
    return <>{children}</>
  }
  return (
    <UiScopeContext.Provider value={resolved}>
      <div data-plugin-id={resolved} style={{ display: 'contents' }}>
        {children}
      </div>
    </UiScopeContext.Provider>
  )
}
