/**
 * Decoupled UI CSS scope identity context shared across layout primitives and
 * Radix portal surfaces (`Dialog`, `AlertDialog`, `Popover`, `Select`,
 * `DropdownMenu`, `Tooltip`, `Screen`, `UiScope`).
 *
 * Completely independent of plugin runtime contexts: when rendered inside a
 * `<UiScope scopeId="...">` (e.g. established by `@helmx/plugin-client`'s
 * `<PluginScope>`), portalled surfaces mount into `document.body` outside any
 * inline wrapper and stamp `data-plugin-id={scopeId}` so scoped CSS rules stay
 * synchronized across normal DOM and portals. Outside any scope, returns
 * `undefined` and omits the attribute cleanly.
 *
 * Pure `.ts` context/hook module (Fast Refresh friendly).
 */
import { createContext, useContext } from 'react'

/** Active UI CSS scope identifier (e.g. a plugin ID), or `undefined` outside any scope. */
export const UiScopeContext = createContext<string | undefined>(undefined)

/** Returns the active scope ID when explicit or inside `<UiScope>`, else `undefined`. */
export function useUiScopeId(explicitId?: string): string | undefined {
  const contextId = useContext(UiScopeContext)
  const resolved = explicitId ?? contextId
  return resolved !== undefined && resolved.length > 0 ? resolved : undefined
}
