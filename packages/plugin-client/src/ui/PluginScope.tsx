/**
 * Layout-transparent CSS scope anchor for plugin client subtrees.
 *
 * Bridges `PluginClientContext.pluginId` (or an explicit `pluginId`) into
 * `@helmx/ui`'s decoupled `<UiScope scopeId={resolved}>`, so both inline
 * descendants and Radix portalled surfaces (`Dialog`, `AlertDialog`, `Popover`,
 * `DropdownMenu`, `Tooltip`, `Select`, `Screen`) inherit `data-plugin-id`.
 * When rendered outside a `PluginClientContext` without an explicit `pluginId`,
 * passes children through unwrapped.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import { UiScope } from '@helmx/ui'
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
  return <UiScope scopeId={resolved}>{children}</UiScope>
}
