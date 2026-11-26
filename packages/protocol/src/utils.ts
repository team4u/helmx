/**
 * Cross-package dependency-free micro utilities (single source of truth).
 *
 * Why here: these predicates/escapers were previously duplicated (with drift) across
 * `@helmx/kernel` and `@helmx/plugins`; protocol is the only common upstream of both,
 * and every helper here is a pure function with zero runtime dependencies, which keeps
 * the protocol package's "zero heavy runtime dependencies" rule intact.
 *
 * Drift adjudication (strict version wins at every historical divergence):
 * - `escapeXml` keeps the 4-entity form (`& < > "`): the minimal set that makes text safe
 *   in both XML text and double-quoted attribute positions.
 * - `isValidEnvName` keeps the kernel's 128-char cap; the unbounded herdr copy is tightened.
 * - `assertProfileId` keeps the kernel's strict `[a-z0-9][a-z0-9-]` pattern (1..64, no trim,
 *   rejects whitespace/uppercase/path separators).
 */

import { parseModelTierRef } from './assets.js'
import { HelmxError } from './error.js'

/** Minimal XML escaping for text and double-quoted attribute positions (`& < > "`; `'` needs no escape inside double quotes). */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Loose JSON-object guard: any non-null, non-array `typeof object`.
 * Intended for values that already passed `JSON.parse` (which can only produce plain
 * objects/arrays), where a prototype check would add cost without adding meaning.
 */
export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Strictly plain-object check: `Object.prototype` or `null` prototype only;
 * rejects `Map`, `Date`, and class instances. For live in-memory objects crossing a
 * validation boundary (e.g. plugin-authored specs) where non-plain objects must fail.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isJsonObject(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Valid environment variable name: ASCII letter or underscore first, then alphanumerics/underscores; length 1..128 (cap from the kernel SecretStash boundary). */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
}

/** Valid Profile ID predicate: lowercase alphanumeric + hyphen, must start alphanumeric, length 1..64 (prevents directory injection and path traversal). */
export function isValidProfileId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

/** Assert a Profile ID per {@link isValidProfileId}; throws `400 validation_error`. Existence is the caller's concern. */
export function assertProfileId(id: string): void {
  if (!isValidProfileId(id)) {
    throw new HelmxError('validation_error', `illegal profile id: ${id} (only allows a-z 0-9 and hyphen)`, 400, {
      profileId: id,
    })
  }
}

/**
 * Pure syntax validator for `AgentSpawnRequest.agentType` (and DSL/tool `agentType` options).
 *
 * Accepts the union domain:
 * - empty string `''` (omitted semantics),
 * - native Profile ID (`^[a-z0-9][a-z0-9-]{0,63}$`), or
 * - namespaced external runtime `<namespace>:<kind>` (non-empty on both sides of `:`, no whitespace).
 *
 * Returns a corrective diagnostic message for invalid values (explicitly diagnosing `'tier/<id>'`
 * model tier references and `'@<profileId>'` mention prefixes), or `undefined` when syntactically valid.
 */
export function agentTypeSyntaxError(agentType: string): string | undefined {
  if (agentType === '') return undefined
  if (isValidProfileId(agentType)) return undefined
  const colon = agentType.indexOf(':')
  if (colon > 0 && colon < agentType.length - 1 && !/\s/.test(agentType)) {
    return undefined
  }
  if (parseModelTierRef(agentType) !== undefined) {
    return (
      `invalid agentType '${agentType}': 'tier/<id>' is a model tier, not a Profile ID or external runtime; ` +
      `pass '${agentType}' via the 'model' parameter instead, and omit 'agentType' or pass a Profile ID from <available_profiles>`
    )
  }
  if (agentType.startsWith('@') && isValidProfileId(agentType.slice(1))) {
    const bareId = agentType.slice(1)
    return (
      `invalid agentType '${agentType}': do not include the '@' mention prefix; ` +
      `pass the bare Profile ID '${bareId}' directly`
    )
  }
  return (
    `invalid agentType '${agentType}': expected a lowercase Profile ID (a-z, 0-9, hyphen; e.g. 'assistant') ` +
    `or an external runtime '<namespace>:<kind>' (e.g. 'herdr:agy'); ` +
    `to select a model or model tier, use the 'model' parameter instead`
  )
}

/** Assert `agentType` syntax per {@link agentTypeSyntaxError}; allows `undefined` and `''`, throws `400 validation_error`. */
export function assertAgentTypeSyntax(agentType: unknown): void {
  if (agentType === undefined) return
  if (typeof agentType !== 'string') {
    throw new HelmxError(
      'validation_error',
      `agentType must be a string (received ${agentType === null ? 'null' : typeof agentType})`,
      400,
      { agentType },
    )
  }
  const error = agentTypeSyntaxError(agentType)
  if (error !== undefined) {
    throw new HelmxError('validation_error', error, 400, { agentType })
  }
}
