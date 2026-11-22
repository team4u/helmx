/**
 * Plugin CSS scope identity helper shared across layout primitives and Radix
 * portal surfaces (`Dialog`, `AlertDialog`, `Popover`, `Select`, `DropdownMenu`,
 * `Tooltip`, `Screen`, `PluginScope`).
 *
 * Reads `PluginClientContext` optionally (never throws outside a plugin tree,
 * so host pages reusing the same SDK primitives remain untouched and omit
 * `data-plugin-id`). Inside a plugin tree, portal surfaces mount into
 * `document.body` outside any inline wrapper — stamping `data-plugin-id` on
 * both the inline scope and portalled surfaces keeps `:where([data-plugin-id="..."])`
 * rules synchronized across normal DOM and portals without unilateral `@layer`
 * cascade inversions.
 */
import { useContext } from 'react'
import { PluginClientContext } from '../plugin-context.js'

/** Returns the active plugin id when rendered inside a `PluginClientContext`, else `undefined`. */
export function usePluginScopeId(explicitPluginId?: string): string | undefined {
  const ctx = useContext(PluginClientContext)
  const resolved = explicitPluginId ?? ctx?.pluginId
  return resolved !== undefined && resolved.length > 0 ? resolved : undefined
}
