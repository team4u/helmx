/**
 * Single source of truth for `PluginConfigFieldSchema` declaration and value validation
 * (shared across kernel `ctx.configSchema`, `HelmxPluginConfigStore`, and external manifest boundary).
 *
 * Server-side contract helper (exported from `@helmx/protocol`, not `@helmx/protocol/browser`).
 */
import { parseNonEmptyLocalizedText } from './locale.js'
import {
  PLUGIN_CONFIG_FIELD_FORMATS,
  PLUGIN_CONFIG_FIELD_TYPES,
  type PluginConfigFieldSchema,
  type PluginConfigFieldType,
} from './plugin-dto.js'
import { isPlainObject } from './utils.js'

const CONFIG_FIELD_TYPE_SET: ReadonlySet<string> = new Set(PLUGIN_CONFIG_FIELD_TYPES)
const CONFIG_FIELD_FORMAT_SET: ReadonlySet<string> = new Set(PLUGIN_CONFIG_FIELD_FORMATS)

const BASE_CONFIG_FIELD_KEYS = [
  'type',
  'secret',
  'required',
  'label',
  'description',
  'format',
  'minimum',
  'maximum',
  'integer',
  'enum',
  'default',
] as const
const DECLARATION_CONFIG_FIELD_KEY_SET: ReadonlySet<string> = new Set(BASE_CONFIG_FIELD_KEYS)
const MANIFEST_CONFIG_FIELD_KEY_SET: ReadonlySet<string> = new Set([...BASE_CONFIG_FIELD_KEYS, 'key'])

function isConfigFieldType(value: unknown): value is PluginConfigFieldType {
  return typeof value === 'string' && CONFIG_FIELD_TYPE_SET.has(value)
}

export interface ValidatePluginConfigFieldSchemaOptions {
  /** Whether `secret: true` fields are allowed to carry `default` (true at declaration, false on public manifest projection). */
  allowSecretDefault: boolean
  /** Whether `secret` and `required` must be explicit booleans (true on manifest projection, false at declaration). */
  requireBooleanFlags: boolean
}

/**
 * Validates a runtime value (or schema `default`) against a `PluginConfigFieldSchema`.
 * Returns an error reason string when invalid, or `undefined` when valid.
 */
export function validatePluginConfigFieldValue(
  field: Pick<PluginConfigFieldSchema, 'type' | 'secret' | 'enum' | 'minimum' | 'maximum' | 'integer'>,
  value: unknown,
): string | undefined {
  if (field.secret === true) {
    if (typeof value !== 'string') return 'is secret and must be a string'
    return undefined
  }
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return 'must be of type string'
      if (field.enum !== undefined && !field.enum.includes(value)) {
        return `must be one of [${field.enum.join(', ')}]`
      }
      return undefined
    }
    case 'number': {
      if (typeof value !== 'number') return 'must be of type number'
      if (!Number.isFinite(value)) return 'must be a finite number'
      if (field.integer === true && !Number.isInteger(value)) return 'must be an integer'
      if (field.minimum !== undefined && value < field.minimum) return `must be >= ${field.minimum}`
      if (field.maximum !== undefined && value > field.maximum) return `must be <= ${field.maximum}`
      if (field.enum !== undefined && !field.enum.includes(value)) {
        return `must be one of [${field.enum.join(', ')}]`
      }
      return undefined
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return 'must be of type boolean'
      return undefined
    }
    case 'string[]': {
      if (!Array.isArray(value)) return 'must be of type string[]'
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i) || typeof value[i] !== 'string') {
          return 'must be an array of strings'
        }
        const item = value[i] as string
        if (field.enum !== undefined && !field.enum.includes(item)) {
          return `contains value ${JSON.stringify(item)} not in allowed enum [${field.enum.join(', ')}]`
        }
      }
      return undefined
    }
    default:
      return `has unsupported type ${String(field.type)}`
  }
}

/**
 * Validates one `PluginConfigFieldSchema` (or `PluginManifestConfigField`) object shape and
 * cross-field invariants (`type`, `secret`, `required`, `label`, `description`, `format`,
 * `minimum`, `maximum`, `integer`, `enum`, `default`).
 * Returns a concise reason string when invalid, or `undefined` when valid.
 */
export function validatePluginConfigFieldSchema(
  raw: unknown,
  options: ValidatePluginConfigFieldSchemaOptions,
): string | undefined {
  if (!isPlainObject(raw)) return 'must be a plain object'

  const allowedKeys = options.requireBooleanFlags ? MANIFEST_CONFIG_FIELD_KEY_SET : DECLARATION_CONFIG_FIELD_KEY_SET
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return `contains unknown schema property '${key}'`
    }
  }

  const type = raw['type']
  if (!isConfigFieldType(type)) {
    return `type must be one of ${PLUGIN_CONFIG_FIELD_TYPES.join(' | ')}`
  }

  for (const flag of ['secret', 'required'] as const) {
    const val = raw[flag]
    if (options.requireBooleanFlags) {
      if (typeof val !== 'boolean') return `${flag} must be boolean`
    } else if (val !== undefined && typeof val !== 'boolean') {
      return `${flag} must be boolean`
    }
  }

  for (const copyField of ['label', 'description'] as const) {
    const val = raw[copyField]
    if (val !== undefined && parseNonEmptyLocalizedText(val) === undefined) {
      return `${copyField} must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`
    }
  }

  const secret = raw['secret'] === true
  if (secret && type !== 'string') {
    return 'secret field must have type string'
  }
  if (secret && !options.allowSecretDefault && Object.hasOwn(raw, 'default')) {
    return 'secret field must not expose default'
  }

  if (raw['format'] !== undefined) {
    if (secret) return 'secret field must not declare format'
    if (type !== 'string' || typeof raw['format'] !== 'string' || !CONFIG_FIELD_FORMAT_SET.has(raw['format'])) {
      return `format ${JSON.stringify(raw['format'])} is invalid (string fields only; allowed: ${PLUGIN_CONFIG_FIELD_FORMATS.join(', ')})`
    }
  }

  let minimum: number | undefined
  let maximum: number | undefined
  for (const bound of ['minimum', 'maximum'] as const) {
    const val = raw[bound]
    if (val !== undefined) {
      if (type !== 'number' || typeof val !== 'number' || !Number.isFinite(val)) {
        return `${bound} must be a finite number on number fields`
      }
      if (bound === 'minimum') minimum = val
      else maximum = val
    }
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return `minimum (${minimum}) must be <= maximum (${maximum})`
  }

  let integer: boolean | undefined
  if (raw['integer'] !== undefined) {
    if (type !== 'number' || typeof raw['integer'] !== 'boolean') {
      return 'integer must be a boolean on number fields'
    }
    integer = raw['integer']
  }

  let validatedEnum: Array<string | number> | undefined
  if (raw['enum'] !== undefined) {
    if (secret) return 'secret field must not declare enum'
    if (type === 'boolean') return 'enum is not allowed on boolean fields'
    if (raw['format'] !== undefined) return 'enum cannot be combined with format'
    const enumValues = raw['enum']
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      return 'enum must be a non-empty array'
    }
    const seen = new Set<string | number>()
    const items: Array<string | number> = []
    for (let i = 0; i < enumValues.length; i += 1) {
      if (!Object.hasOwn(enumValues, i)) return `enum[${i}] is sparse`
      const entry = enumValues[i]
      if (type === 'string' || type === 'string[]') {
        if (typeof entry !== 'string') return `enum[${i}] must be a string for ${type} fields`
      } else {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
          return `enum[${i}] must be a finite number for number fields`
        }
        if (integer === true && !Number.isInteger(entry)) {
          return `enum[${i}] must be an integer`
        }
        if (minimum !== undefined && entry < minimum) {
          return `enum[${i}] must be >= minimum (${minimum})`
        }
        if (maximum !== undefined && entry > maximum) {
          return `enum[${i}] must be <= maximum (${maximum})`
        }
      }
      if (seen.has(entry)) return `enum contains duplicate value ${JSON.stringify(entry)}`
      seen.add(entry)
      items.push(entry)
    }
    validatedEnum = items
  }

  if (raw['default'] !== undefined) {
    const validatedField: Pick<PluginConfigFieldSchema, 'type' | 'secret' | 'enum' | 'minimum' | 'maximum' | 'integer'> = {
      type,
      ...(secret ? { secret: true } : {}),
      ...(validatedEnum !== undefined ? { enum: validatedEnum } : {}),
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(integer !== undefined ? { integer } : {}),
    }
    const defaultReason = validatePluginConfigFieldValue(validatedField, raw['default'])
    if (defaultReason !== undefined) {
      return `default ${defaultReason}`
    }
  }

  return undefined
}
