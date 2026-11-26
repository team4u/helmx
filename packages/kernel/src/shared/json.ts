import { HelmxError } from '@helmx/protocol'

export interface StripUndefinedOptions {
  /**
   * Behavior when encountering a cycle on the active traversal path:
   * - `'keep'` (default): returns the object verbatim so downstream `redactJsonValue` reports path details;
   * - `'throw'`: throws `HelmxError('invalid_json_value', ...)` immediately.
   */
  readonly onCycle?: 'keep' | 'throw'
  /** Error message used when `onCycle` is `'throw'`. */
  readonly cycleErrorMessage?: string
  /**
   * Plain-object filter:
   * - `'object-or-null'` (default): recurses arrays, `Object.prototype` objects, and `null`-prototype objects;
   * - `'object-proto-only'`: recurses arrays and `Object.prototype` objects only;
   * - `'all-objects'`: recurses arrays and all non-null objects.
   */
  readonly objectFilter?: 'object-or-null' | 'object-proto-only' | 'all-objects'
  /** Existing traversal set to reuse across recursive/external callers. */
  readonly seen?: WeakSet<object>
}

function shouldRecurseObject(value: object, filter: NonNullable<StripUndefinedOptions['objectFilter']>): boolean {
  if (filter === 'all-objects') return true
  const proto = Object.getPrototypeOf(value)
  if (filter === 'object-proto-only') return proto === Object.prototype
  return proto === Object.prototype || proto === null
}

/**
 * Recursively omit own object keys whose value is `undefined`, matching JSON serialization semantics
 * without silently converting non-JSON values (`Date`, `Map`, non-finite numbers, sparse arrays, etc.).
 */
export function stripUndefinedProperties<T>(value: T, options?: StripUndefinedOptions): T {
  const seen = options?.seen ?? new WeakSet<object>()
  const onCycle = options?.onCycle ?? 'keep'
  const cycleMessage = options?.cycleErrorMessage ?? 'Value contains a circular reference'
  const filter = options?.objectFilter ?? 'object-or-null'

  const walk = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        if (onCycle === 'throw') throw new HelmxError('invalid_json_value', cycleMessage, 500)
        return current
      }
      seen.add(current)
      try {
        return current.map((item) => walk(item))
      } finally {
        seen.delete(current)
      }
    }
    if (!shouldRecurseObject(current, filter)) return current
    if (seen.has(current)) {
      if (onCycle === 'throw') throw new HelmxError('invalid_json_value', cycleMessage, 500)
      return current
    }
    seen.add(current)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(current)) {
        if (v !== undefined) out[k] = walk(v)
      }
      return out
    } finally {
      seen.delete(current)
    }
  }

  return walk(value) as T
}
