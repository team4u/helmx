/**
 * JSON Schema boundary validator (TypeBox JIT `Compile` with pure-JS `Value.Check` fallback,
 * shared across protocol, kernel, and plugins).
 */
import type { TSchema } from 'typebox'
import { Compile } from 'typebox/compile'
import { Check, Errors } from 'typebox/value'
import { HelmxError } from './error.js'
import type { JsonSchema } from './plugin-dto.js'
import { isPlainObject } from './utils.js'

interface ValidationIssue {
  instancePath?: string
  message?: string
}

interface CompiledValidator {
  check(value: unknown): boolean
  errors(value: unknown): ValidationIssue[]
}

const JSON_SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'])
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const
const SUBSCHEMA_KEYS = [
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
  'not', 'if', 'then', 'else', 'contains', 'additionalItems', 'unevaluatedItems',
] as const
const SUBSCHEMA_ARRAY_KEYS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'] as const
const NON_NEGATIVE_KEYS = [
  'minLength', 'maxLength', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'minContains', 'maxContains',
] as const
const BOUND_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const

const compiledCache = new WeakMap<object, CompiledValidator>()

function invalidSchemaError(schema: unknown, reason: string): HelmxError {
  return new HelmxError('invalid_plugin_schema', `JSON Schema compilation failed: ${reason}`, 500, { schema })
}

function assertValidRegex(root: JsonSchema, pattern: unknown, label: string): void {
  if (typeof pattern !== 'string') throw invalidSchemaError(root, `${label} must be a string`)
  try {
    new RegExp(pattern)
  } catch (error) {
    throw invalidSchemaError(root, `${label} invalid regex: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertValidSubschema(
  root: JsonSchema,
  node: unknown,
  path: string,
  visited: Set<object>,
  allowBoolean: boolean,
): void {
  if (typeof node === 'boolean') {
    if (!allowBoolean) throw invalidSchemaError(root, `${path} must be a JSON Schema object`)
    return
  }
  if (!isPlainObject(node)) throw invalidSchemaError(root, `${path} must be a JSON Schema object`)
  if (visited.has(node)) return
  visited.add(node)

  if (node['$async'] !== undefined) {
    throw new HelmxError(
      'invalid_plugin_schema',
      'Declared JSON Schema contains $async: the core synchronous validation boundary does not support async schemas',
      500,
      { schema: root },
    )
  }

  const rawType = node['type']
  if (rawType !== undefined) {
    const validString = typeof rawType === 'string' && JSON_SCHEMA_TYPES.has(rawType)
    const validArray =
      Array.isArray(rawType) &&
      rawType.length > 0 &&
      new Set(rawType).size === rawType.length &&
      rawType.every((item) => typeof item === 'string' && JSON_SCHEMA_TYPES.has(item))
    if (!validString && !validArray) {
      throw invalidSchemaError(root, `${path}.type "${String(rawType)}" is not a valid JSON Schema type`)
    }
  }

  if (node['$ref'] !== undefined && (typeof node['$ref'] !== 'string' || node['$ref'].length === 0)) {
    throw invalidSchemaError(root, `${path}.$ref must be a non-empty string`)
  }
  if (node['required'] !== undefined && (!Array.isArray(node['required']) || !node['required'].every((k) => typeof k === 'string'))) {
    throw invalidSchemaError(root, `${path}.required must be an array of strings`)
  }
  if (node['enum'] !== undefined && (!Array.isArray(node['enum']) || node['enum'].length === 0)) {
    throw invalidSchemaError(root, `${path}.enum must be a non-empty array`)
  }
  if (node['pattern'] !== undefined) assertValidRegex(root, node['pattern'], `${path}.pattern`)
  if (node['uniqueItems'] !== undefined && typeof node['uniqueItems'] !== 'boolean') {
    throw invalidSchemaError(root, `${path}.uniqueItems must be a boolean`)
  }
  if (node['multipleOf'] !== undefined && (typeof node['multipleOf'] !== 'number' || !Number.isFinite(node['multipleOf']) || node['multipleOf'] <= 0)) {
    throw invalidSchemaError(root, `${path}.multipleOf must be a finite positive number`)
  }
  for (const key of BOUND_KEYS) {
    if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) {
      throw invalidSchemaError(root, `${path}.${key} must be a finite number`)
    }
  }
  for (const key of NON_NEGATIVE_KEYS) {
    if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]) || node[key] < 0)) {
      throw invalidSchemaError(root, `${path}.${key} must be a finite non-negative number`)
    }
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const mapVal = node[key]
    if (mapVal === undefined) continue
    if (!isPlainObject(mapVal)) throw invalidSchemaError(root, `${path}.${key} must be an object`)
    for (const [propKey, propSchema] of Object.entries(mapVal)) {
      if (key === 'patternProperties') assertValidRegex(root, propKey, `${path}.patternProperties["${propKey}"]`)
      assertValidSubschema(root, propSchema, `${path}.${key}.${propKey}`, visited, true)
    }
  }
  for (const key of SUBSCHEMA_KEYS) {
    if (node[key] !== undefined) assertValidSubschema(root, node[key], `${path}.${key}`, visited, true)
  }
  if (node['items'] !== undefined) {
    const items = node['items']
    if (Array.isArray(items)) items.forEach((sub, i) => assertValidSubschema(root, sub, `${path}.items[${i}]`, visited, true))
    else assertValidSubschema(root, items, `${path}.items`, visited, true)
  }
  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const arr = node[key]
    if (arr === undefined) continue
    if (!Array.isArray(arr) || arr.length === 0) throw invalidSchemaError(root, `${path}.${key} must be a non-empty array`)
    arr.forEach((sub, i) => assertValidSubschema(root, sub, `${path}.${key}[${i}]`, visited, true))
  }
}

function compile(schema: JsonSchema | TSchema): CompiledValidator {
  if (!isPlainObject(schema)) throw invalidSchemaError(schema, 'root schema must be a plain object')
  const cached = compiledCache.get(schema)
  if (cached) return cached

  assertValidSubschema(schema as JsonSchema, schema, '#', new Set<object>(), false)
  let validator: CompiledValidator
  try {
    const compiled = Compile(schema as never)
    compiled.Check({})
    validator = {
      check: (value) => compiled.Check(value),
      errors: (value) => [...(compiled.Errors(value) as Iterable<ValidationIssue>)],
    }
  } catch {
    // Fall back to interpreted `typebox/value` only if `Compile` declines a valid schema.
    try {
      Check(schema as never, {})
    } catch (error) {
      throw invalidSchemaError(schema, error instanceof Error ? error.message : String(error))
    }
    validator = {
      check: (value) => Check(schema as never, value),
      errors: (value) => [...(Errors(schema as never, value) as Iterable<ValidationIssue>)],
    }
  }
  compiledCache.set(schema, validator)
  return validator
}

/** Pre-validate at registration boundary so invalid or $async schemas fail immediately with invalid_plugin_schema. */
export function assertSchemaCompilable(schema: JsonSchema | TSchema): void {
  compile(schema)
}

export function validateOrThrow(
  schema: JsonSchema | TSchema,
  value: unknown,
  message: string,
  code = 'validation_error',
  status = 400,
  extraDetails?: Record<string, unknown>,
): void {
  const validator = compile(schema)
  let ok: boolean
  try {
    ok = validator.check(value)
  } catch (error) {
    throw invalidSchemaError(schema, error instanceof Error ? error.message : String(error))
  }
  if (!ok) {
    const errors = validator.errors(value)
    throw new HelmxError(code, `${message}: ${formatErrors(errors)}`, status, { ...(extraDetails ?? {}), errors })
  }
}

function formatErrors(errors: readonly ValidationIssue[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) return 'Unknown validation error'
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
    .join('; ')
}
