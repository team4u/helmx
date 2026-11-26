/**
 * Strict plain-JSON boundary validation, string redaction, and deep-cloning without `JSON.stringify`.
 *
 * Browser-safe (`node:*`-free and TypeBox-free; exported from both `@helmx/protocol` and `@helmx/protocol/browser`).
 * Used across persistence, tool execution results, `presentationMeta`, and HTTP metadata validation.
 */
import { HelmxError } from './error.js'
import { isPlainObject } from './utils.js'

export const FORBIDDEN_JSON_KEYS = ['__proto__', 'constructor', 'prototype'] as const
export const FORBIDDEN_JSON_KEY_SET: ReadonlySet<string> = new Set<string>(FORBIDDEN_JSON_KEYS)

export interface PlainJsonGuardOptions {
  /** Primary error factory when a structural invariant fails. */
  makeError: (reason: string, extra?: Record<string, unknown>) => HelmxError
  /** Optional string redactor applied to symbol descriptions and non-safe key diagnostics. */
  redactText?: (text: string) => string
  /** Optional custom reason suffix for missing array index descriptors (`sparse holes`). */
  sparseHoleReason?: string
}

/** Define an own enumerable writable configurable data property without invoking `Object.prototype.__proto__`. */
export function definePlainJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** Reject explicit own prototype-pollution keys (`__proto__`, `constructor`, `prototype`) on objects or arrays. */
export function assertNoForbiddenJsonKeys(target: object, path: string, opts: PlainJsonGuardOptions): void {
  for (const forbidden of FORBIDDEN_JSON_KEYS) {
    if (Object.hasOwn(target, forbidden)) {
      throw opts.makeError(`contains forbidden prototype key "${forbidden}" at ${path}`, { path, key: forbidden })
    }
  }
}

/**
 * Inspect an own key of a plain object without invoking getters: rejects Symbol keys,
 * non-enumerable properties, accessor descriptors, and forbidden prototype keys.
 */
export function readOwnEnumerableDataProperty(
  target: object,
  rawKey: string | symbol,
  path: string,
  opts: PlainJsonGuardOptions,
): { rawKey: string; value: unknown } {
  const redactText = opts.redactText ?? ((text: string) => text)
  if (typeof rawKey !== 'string') {
    throw opts.makeError(`contains a symbol key (${redactText(String(rawKey))}) at ${path}`, { path })
  }
  const desc = Object.getOwnPropertyDescriptor(target, rawKey)
  if (desc === undefined || !desc.enumerable) {
    const safeKey = redactText(rawKey)
    throw opts.makeError(`contains a non-enumerable property "${safeKey}" at ${path}`, { path, key: safeKey })
  }
  if (desc.get !== undefined || desc.set !== undefined) {
    const safeKey = redactText(rawKey)
    throw opts.makeError(`contains an accessor property "${safeKey}" at ${path}`, { path, key: safeKey })
  }
  if (FORBIDDEN_JSON_KEY_SET.has(rawKey)) {
    throw opts.makeError(`contains forbidden prototype key "${rawKey}" at ${path}`, { path, key: rawKey })
  }
  return { rawKey, value: desc.value }
}

/**
 * Validate an array's own structure without invoking accessors: enforces `Array.prototype`,
 * dense own enumerable data descriptors at `0..length-1`, and rejects Symbol keys,
 * forbidden prototype keys, and extra non-index own properties.
 */
export function readPlainArrayElements(
  current: unknown[],
  path: string,
  opts: PlainJsonGuardOptions,
): unknown[] {
  const redactText = opts.redactText ?? ((text: string) => text)
  if (Object.getPrototypeOf(current) !== Array.prototype) {
    throw opts.makeError(`contains a non-plain array at ${path}`, { path })
  }
  assertNoForbiddenJsonKeys(current, path, opts)
  const elements: unknown[] = []
  for (let i = 0; i < current.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(current, i)
    if (desc === undefined) {
      throw opts.makeError(
        opts.sparseHoleReason
          ? `${path}[${i}] ${opts.sparseHoleReason}`
          : `contains a sparse array hole at ${path}[${i}]`,
        { path: `${path}[${i}]` },
      )
    }
    if (!desc.enumerable) {
      throw opts.makeError(`contains a non-enumerable array element at ${path}[${i}]`, { path: `${path}[${i}]` })
    }
    if (desc.get !== undefined || desc.set !== undefined) {
      throw opts.makeError(`contains an accessor array element at ${path}[${i}]`, { path: `${path}[${i}]` })
    }
    elements.push(desc.value)
  }
  for (const rawKey of Reflect.ownKeys(current)) {
    if (rawKey === 'length') continue
    if (typeof rawKey !== 'string') {
      throw opts.makeError(`contains a symbol key (${redactText(String(rawKey))}) on array at ${path}`, { path })
    }
    if (FORBIDDEN_JSON_KEY_SET.has(rawKey)) {
      throw opts.makeError(`contains forbidden prototype key "${rawKey}" at ${path}`, { path, key: rawKey })
    }
    const idx = Number(rawKey)
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.length || String(idx) !== rawKey) {
      const safeKey = redactText(rawKey)
      throw opts.makeError(`contains an extra own property "${safeKey}" on array at ${path}`, { path, key: safeKey })
    }
  }
  return elements
}

export interface AssertJsonSafeOptions {
  /** Root path label included in error diagnostics (defaults to `'value'`). */
  path?: string
  /** Optional subject prefix prepended before `path` in diagnostics (e.g. `'tool foo'` -> `'tool foo presentationMeta ...'`). */
  label?: string
  /** When true, requires the root value itself to be a plain JSON object (rejecting primitives, null, arrays, and class instances). */
  requirePlainObject?: boolean
  /** Optional string redactor applied to keys, string values, and key-name fragments in diagnostics. */
  redact?: (text: string) => string
  /** Optional max container nesting depth (root container = depth 1; primitive leaves do not consume depth). */
  maxDepth?: number
  /** Optional max total visited JSON nodes. */
  maxNodes?: number
  /** Error code thrown on invalid JSON shape or bounds (defaults to `'validation_error'`). */
  code?: string
  /** HTTP status code attached to thrown {@link HelmxError} (defaults to `400`). */
  status?: number
}

/** Strict plain-JSON check with root plain-object requirement. */
export function assertJsonSafe(
  value: unknown,
  options: AssertJsonSafeOptions & { requirePlainObject: true },
): Record<string, unknown>
/** Strict plain-JSON check returning a deep-cloned (and optionally redacted) JSON value. */
export function assertJsonSafe(value: unknown, options?: AssertJsonSafeOptions): unknown
/**
 * Strictly validate, optionally redact, and deep-clone a raw JS value as faithful JSON without calling `JSON.stringify`:
 * - rejects `undefined`, symbols, functions, `bigint`, non-finite numbers (`NaN` / `Infinity`), cycles,
 *   sparse arrays, non-plain arrays/objects (custom prototypes / `Date` / `Map` / class instances with `toJSON`),
 *   extra own properties on arrays, symbol own keys, non-enumerable or accessor own properties (without invoking getters),
 *   and prototype keys (`__proto__`, `constructor`, `prototype`, both before and after redaction);
 * - enforces optional `maxDepth` and `maxNodes` bounds without silent truncation.
 */
export function assertJsonSafe(value: unknown, options?: AssertJsonSafeOptions): unknown {
  const rootPath = options?.path ?? 'value'
  const subject = options?.label !== undefined ? `${options.label} ${rootPath}` : rootPath
  const maxDepth = options?.maxDepth
  const maxNodes = options?.maxNodes
  const code = options?.code ?? 'validation_error'
  const status = options?.status ?? 400
  const redact = options?.redact
  const redactText = (text: string): string => (redact ? redact(text) : text)

  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
    throw new HelmxError('validation_error', `invalid maxDepth bound: ${String(maxDepth)}`, 400)
  }
  if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
    throw new HelmxError('validation_error', `invalid maxNodes bound: ${String(maxNodes)}`, 400)
  }
  if (options?.requirePlainObject === true && !isPlainObject(value)) {
    throw new HelmxError(code, `${subject} must be a plain JSON object`, status)
  }

  const visiting = new WeakSet<object>()
  let nodes = 0

  const guardOpts = (path: string): PlainJsonGuardOptions => ({
    redactText,
    makeError: (reason, extra) => new HelmxError(code, `${subject} ${reason}`, status, extra ?? { path }),
  })

  function visitArray(current: unknown[], path: string, depth: number): unknown[] {
    const elements = readPlainArrayElements(current, path, guardOpts(path))
    return elements.map((el, i) => visit(el, `${path}[${i}]`, depth + 1))
  }

  function visitObject(current: object, path: string, depth: number): Record<string, unknown> {
    if (!isPlainObject(current)) {
      throw new HelmxError(code, `${subject} contains a non-plain object at ${path}`, status, { path })
    }
    const opts = guardOpts(path)
    assertNoForbiddenJsonKeys(current, path, opts)
    const out: Record<string, unknown> = {}
    const seenKeys = new Set<string>()
    for (const rawOwnKey of Reflect.ownKeys(current)) {
      const { rawKey, value: rawValue } = readOwnEnumerableDataProperty(current, rawOwnKey, path, opts)
      const key = redactText(rawKey)
      if (FORBIDDEN_JSON_KEY_SET.has(key)) {
        throw new HelmxError(
          code,
          `${subject} contains forbidden prototype key "${key}" at ${path}`,
          status,
          { path, key },
        )
      }
      if (seenKeys.has(key)) {
        throw new HelmxError(
          'redacted_key_conflict',
          `${subject} redacted fields collide at ${path}.${key}`,
          500,
          { path, key },
        )
      }
      seenKeys.add(key)
      definePlainJsonProperty(out, key, visit(rawValue, `${path}.${key}`, depth + 1))
    }
    return out
  }

  function visit(current: unknown, path: string, depth: number): unknown {
    nodes += 1
    if (maxNodes !== undefined && nodes > maxNodes) {
      throw new HelmxError(
        code,
        `${subject} exceeds max node count (${maxNodes}) at ${path}`,
        status,
        { maxNodes, path },
      )
    }
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return redactText(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new HelmxError(code, `${subject} contains a non-finite number at ${path}`, status, { path })
      }
      return current
    }
    if (typeof current !== 'object') {
      throw new HelmxError(code, `${subject} contains a non-JSON value (${typeof current}) at ${path}`, status, {
        path,
      })
    }
    if (visiting.has(current)) {
      throw new HelmxError(code, `${subject} contains a circular reference at ${path}`, status, { path })
    }
    if (maxDepth !== undefined && depth > maxDepth) {
      throw new HelmxError(
        code,
        `${subject} exceeds max nesting depth (${maxDepth}) at ${path}`,
        status,
        { maxDepth, path },
      )
    }
    visiting.add(current)
    try {
      return Array.isArray(current) ? visitArray(current, path, depth) : visitObject(current, path, depth)
    } finally {
      visiting.delete(current)
    }
  }

  return visit(value, rootPath, 1)
}
