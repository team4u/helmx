/**
 * Shared JSON Schema <-> CLI flag / positional mapping & coercion helpers.
 *
 * Reused across both dynamic plugin actions (`actions.ts`) and static core operations
 * (`commands/from-operations.ts`) so `--kebab-case` naming, aliases, collision handling,
 * type inference, and positional coercion stay identical across both CLI planes.
 */
import type { JsonSchema } from '@helmx/protocol'
import type { FlagSpec } from './args.js'
import { CliError } from './errors.js'

export const RESERVED_FLAG_NAMES = new Set(['json', 'help', 'input', 'current', 'h'])

export interface SchemaFlagsOptions {
  /** Override flag name (without leading `--`) for specific schema property names. */
  readonly aliases?: Readonly<Record<string, string>>
  /** Property names bound to positional args (excluded from standalone CLI flags). */
  readonly omitFields?: ReadonlySet<string>
}

function primitiveFlagType(value: unknown): 'string' | 'number' | 'boolean' | undefined {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'string'
  return undefined
}

/** Coerce a simple JSON Schema property type to a flag type; object/array/untyped schemas use json (or whole --input). */
export function flagTypeOf(schema: unknown): FlagSpec['type'] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown }
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'string') return 'string'
  if (s.type === 'object' || s.type === 'array') return 'json'
  if ('const' in s) return primitiveFlagType(s.const) ?? 'json'
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const first = primitiveFlagType(s.enum[0])
    if (first !== undefined && s.enum.every((v) => primitiveFlagType(v) === first)) return first
    return 'json'
  }
  // Untyped loose schemas (including $ref / combinators / any JSON value) parse as JSON so structured values keep fidelity.
  return 'json'
}

/**
 * Coerce a positional argument string per its schema property type (matching flag coercion):
 * number/integer -> Number; boolean -> strict true/false; object/array/untyped loose schemas -> JSON.parse; string -> verbatim.
 */
export function coercePositionalValue(raw: string, field: string, schema: unknown): unknown {
  const type = flagTypeOf(schema)
  if (type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      throw new CliError(`positional argument <${field}> requires a number (schema type number/integer), got "${raw}"`, 'invalid_flag_value')
    }
    return n
  }
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new CliError(`positional argument <${field}> requires true/false (schema type boolean), got "${raw}"`, 'invalid_flag_value')
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new CliError(
        `positional argument <${field}> requires valid JSON (schema type ${type === 'json' ? 'object/array/untyped' : type}): ${err instanceof Error ? err.message : String(err)}`,
        'invalid_flag_value',
      )
    }
  }
  return raw
}

export function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** Safely read schema.properties: returns undefined when absent or non-object (further validated elsewhere). */
export function schemaPropertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined
  return properties as Record<string, unknown>
}

function resolveFlagName(rawName: string, options?: SchemaFlagsOptions): string {
  return options?.aliases?.[rawName] ?? kebabCase(rawName)
}

/** Convert schema properties + required into a flag spec list; skipped holds property names unsuitable for standalone flags. */
export function flagsFromSchema(
  schema: JsonSchema,
  options?: SchemaFlagsOptions,
): { flags: FlagSpec[]; skipped: string[] } {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { flags: [], skipped: [] }
  const properties = (schema as { properties?: unknown }).properties
  if (properties === undefined) return { flags: [], skipped: [] }
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CliError('invalid action inputSchema.properties: must be an object', 'invalid_action_manifest')
  }
  const required = (schema as { required?: unknown }).required
  const requiredNames = new Set(
    Array.isArray(required) && required.every((r) => typeof r === 'string') ? (required as string[]) : [],
  )
  const rawNames = Object.keys(properties as Record<string, unknown>).filter(
    (name) => !options?.omitFields?.has(name),
  )
  const flagCounts = new Map<string, number>()
  for (const rawName of rawNames) {
    const key = resolveFlagName(rawName, options)
    flagCounts.set(key, (flagCounts.get(key) ?? 0) + 1)
  }
  const flags: FlagSpec[] = []
  const skipped: string[] = []
  for (const rawName of rawNames) {
    const name = resolveFlagName(rawName, options)
    if (RESERVED_FLAG_NAMES.has(name) || (flagCounts.get(name) ?? 0) > 1) {
      skipped.push(rawName)
      continue
    }
    const propSchema = (properties as Record<string, unknown>)[rawName]
    const type = flagTypeOf(propSchema)
    if (type === undefined) {
      skipped.push(rawName)
      continue
    }
    const helpParts: string[] = []
    if (propSchema !== null && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
      const ps = propSchema as { description?: unknown; enum?: unknown }
      if (typeof ps.description === 'string' && ps.description.trim() !== '') {
        helpParts.push(ps.description.trim())
      }
      if (
        Array.isArray(ps.enum) &&
        ps.enum.length > 0 &&
        ps.enum.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      ) {
        helpParts.push(`(${ps.enum.map(String).join('|')})`)
      }
    }
    flags.push({
      name,
      type,
      required: requiredNames.has(rawName),
      ...(helpParts.length > 0 ? { help: helpParts.join(' ') } : {}),
    })
  }
  return { flags, skipped }
}

/**
 * Reverse map from CLI flag names back to original schema property names.
 * Ambiguous duplicate flag names map to `undefined` so callers fail cleanly rather than silently picking one.
 */
export function schemaPropertyNames(
  schema: JsonSchema,
  options?: SchemaFlagsOptions,
): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>()
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return map
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return map
  for (const rawName of Object.keys(properties as Record<string, unknown>)) {
    if (options?.omitFields?.has(rawName)) continue
    const key = resolveFlagName(rawName, options)
    map.set(key, map.has(key) ? undefined : rawName)
  }
  return map
}
