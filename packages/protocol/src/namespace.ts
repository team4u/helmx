/**
 * Reserved namespace predicates and prefix helpers shared across kernel, CLI, Web, plugins, and build tooling.
 *
 * Helmx reserves two colon-prefixed namespaces:
 * - `core:<domain>`: kernel-owned capabilities and managed skills (always active; never listed as plugins);
 * - `builtin:<name>`: built-in plugins shipped with Helmx (managed via PluginHost, never package-managed).
 * External plugins must never use either reserved namespace.
 */

export const CORE_NAMESPACE_PREFIX = 'core:' as const
export const BUILTIN_NAMESPACE_PREFIX = 'builtin:' as const

/** Strict pattern for kernel-owned `core:<domain>` identifiers (no dots or extra colons). */
export const CORE_OWNER_ID_PATTERN = /^core:[A-Za-z0-9_-]+$/

/** Whether an identifier lies in the reserved kernel `core:*` namespace. */
export function isCoreNamespace(id: string): boolean {
  return id.startsWith(CORE_NAMESPACE_PREFIX)
}

/** Whether an identifier is a valid kernel `core:<domain>` owner ID (`/^core:[A-Za-z0-9_-]+$/`). */
export function isValidCoreOwnerId(id: string): boolean {
  return CORE_OWNER_ID_PATTERN.test(id)
}

/** Whether an identifier lies in the built-in `builtin:*` plugin namespace. */
export function isBuiltinNamespace(id: string): boolean {
  return id.startsWith(BUILTIN_NAMESPACE_PREFIX)
}

/** Whether an identifier uses a host-reserved namespace (`core:*` or `builtin:*`), forbidden for external plugins. */
export function isReservedPluginNamespace(id: string): boolean {
  return isCoreNamespace(id) || isBuiltinNamespace(id)
}

/** Strip the `builtin:` prefix for default CLI/tool naming; leaves all other IDs unchanged. */
export function stripBuiltinNamespace(id: string): string {
  return isBuiltinNamespace(id) ? id.slice(BUILTIN_NAMESPACE_PREFIX.length) : id
}
