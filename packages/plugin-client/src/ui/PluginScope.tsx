/**
 * Layout-transparent CSS scope anchor for plugin client subtrees.
 *
 * Renders `<div data-plugin-id="..." style={{ display: 'contents' }}>` so flex,
 * grid, and inline parent-child layouts keep direct-child semantics while every
 * descendant matches `:where([data-plugin-id="<id>"])` selectors. When rendered
 * outside a `PluginClientContext` without an explicit `pluginId`, passes
 * children through unwrapped.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import { usePluginScopeId } from './plugin-scope.js'

export interface PluginScopeProps {
  /** Explicit plugin id override; defaults to the enclosing `PluginClientContext.pluginId`. */
  pluginId?: string
  children?: ReactNode
}

export function PluginScope({ pluginId, children }: PluginScopeProps): ReactNode {
  const resolved = usePluginScopeId(pluginId)
  if (resolved === undefined) {
    return <>{children}</>
  }
  return (
    <div data-plugin-id={resolved} style={{ display: 'contents' }}>
      {children}
    </div>
  )
}
