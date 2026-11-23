import { HelmxError } from './error.js'
import type { JsonSchema } from './plugin-dto.js'
import { validateOrThrow } from './schema.js'
import {
  TOOL_PRESENTATION_META_MAX_BYTES,
  TOOL_PRESENTATION_META_MAX_DEPTH,
  TOOL_PRESENTATION_META_MAX_NODES,
} from './tool-presentation.js'
import { isPlainObject } from './utils.js'

const FORBIDDEN_META_KEYS = ['__proto__', 'constructor', 'prototype'] as const
const FORBIDDEN_META_KEY_SET = new Set<string>(FORBIDDEN_META_KEYS)
const utf8Encoder = new TextEncoder()

export interface PresentationMetaBoundsOptions {
  /** Human-readable tool / callsite label included in error diagnostics. */
  label?: string
  /** Optional string redactor applied to keys and string values before byte-budget & schema validation. */
  redact?: (text: string) => string
  /** Optional JSON Schema validated against the redacted, bounded object. */
  schema?: JsonSchema
  /** Override max serialized UTF-8 byte length (defaults to {@link TOOL_PRESENTATION_META_MAX_BYTES}). */
  maxBytes?: number
  /** Override max container nesting depth (defaults to {@link TOOL_PRESENTATION_META_MAX_DEPTH}). */
  maxDepth?: number
  /** Override max total visited JSON nodes (defaults to {@link TOOL_PRESENTATION_META_MAX_NODES}). */
  maxNodes?: number
  /** Error code thrown on contract violation (defaults to `'invalid_tool_result'`). */
  code?: string
  /** HTTP status code attached to thrown {@link HelmxError} (defaults to `500`). */
  status?: number
}

/**
 * Validate, optionally redact, and deep-clone tool `presentationMeta` at the persistence boundary.
 *
 * Enforces all structural & resource invariants without silent truncation or field dropping:
 * - top-level value must be a plain JSON object (rejects null, primitives, arrays, class instances);
 * - inspects `Reflect.ownKeys` on every object and array: rejects symbol own keys, non-enumerable own
 *   properties, extra own properties on arrays, non-plain array subclasses, and prototype keys
 *   (`__proto__`, `constructor`, `prototype`, both before and after redaction);
 * - rejects circular references, sparse arrays, `undefined`, non-finite numbers, and non-JSON values;
 * - enforces container depth <= `maxDepth` (root object = depth 1; primitive leaves do not consume depth),
 *   total visited nodes <= `maxNodes`, and serialized UTF-8 JSON byte length <= `maxBytes`;
 * - when `schema` is provided, validates the cloned (and redacted) object synchronously via `validateOrThrow`.
 */
export function assertBoundedPresentationMeta(
  value: unknown,
  options?: PresentationMetaBoundsOptions,
): Record<string, unknown> {
  const label = options?.label ?? 'tool'
  const maxBytes = options?.maxBytes ?? TOOL_PRESENTATION_META_MAX_BYTES
  const maxDepth = options?.maxDepth ?? TOOL_PRESENTATION_META_MAX_DEPTH
  const maxNodes = options?.maxNodes ?? TOOL_PRESENTATION_META_MAX_NODES
  const code = options?.code ?? 'invalid_tool_result'
  const status = options?.status ?? 500
  const redact = options?.redact

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new HelmxError('validation_error', `invalid maxBytes bound: ${String(maxBytes)}`, 400)
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new HelmxError('validation_error', `invalid maxDepth bound: ${String(maxDepth)}`, 400)
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new HelmxError('validation_error', `invalid maxNodes bound: ${String(maxNodes)}`, 400)
  }

  if (!isPlainObject(value)) {
    throw new HelmxError(code, `${label} presentationMeta must be a plain JSON object`, status)
  }

  const visiting = new WeakSet<object>()
  let nodes = 0

  function visit(current: unknown, path: string, depth: number): unknown {
    nodes += 1
    if (nodes > maxNodes) {
      throw new HelmxError(
        code,
        `${label} presentationMeta exceeds max node count (${maxNodes}) at ${path}`,
        status,
        { maxNodes, path },
      )
    }
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return redact ? redact(current) : current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new HelmxError(
          code,
          `${label} presentationMeta contains a non-finite number at ${path}`,
          status,
          { path },
        )
      }
      return current
    }
    if (typeof current !== 'object') {
      throw new HelmxError(
        code,
        `${label} presentationMeta contains a non-JSON value (${typeof current}) at ${path}`,
        status,
        { path },
      )
    }
    if (visiting.has(current)) {
      throw new HelmxError(
        code,
        `${label} presentationMeta contains a circular reference at ${path}`,
        status,
        { path },
      )
    }
    if (depth > maxDepth) {
      throw new HelmxError(
        code,
        `${label} presentationMeta exceeds max nesting depth (${maxDepth}) at ${path}`,
        status,
        { maxDepth, path },
      )
    }
    visiting.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a non-plain array at ${path}`,
            status,
            { path },
          )
        }
        for (const forbidden of FORBIDDEN_META_KEYS) {
          if (Object.hasOwn(current, forbidden)) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains forbidden prototype key "${forbidden}" at ${path}`,
              status,
              { path, key: forbidden },
            )
          }
        }
        const out: unknown[] = []
        for (let i = 0; i < current.length; i += 1) {
          const desc = Object.getOwnPropertyDescriptor(current, i)
          if (desc === undefined) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a sparse array hole at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          if (!desc.enumerable) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a non-enumerable array element at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          if (desc.get !== undefined || desc.set !== undefined) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains an accessor array element at ${path}[${i}]`,
              status,
              { path: `${path}[${i}]` },
            )
          }
          out.push(visit(desc.value, `${path}[${i}]`, depth + 1))
        }
        // Inspect all own keys (`Reflect.ownKeys`) to reject symbols, prototype keys, or extra named properties
        // on arrays that index loops / JSON.stringify would silently drop.
        for (const rawKey of Reflect.ownKeys(current)) {
          if (rawKey === 'length') continue
          if (typeof rawKey !== 'string') {
            const safeSym = redact ? redact(String(rawKey)) : String(rawKey)
            throw new HelmxError(
              code,
              `${label} presentationMeta contains a symbol key (${safeSym}) on array at ${path}`,
              status,
              { path },
            )
          }
          if (FORBIDDEN_META_KEY_SET.has(rawKey)) {
            throw new HelmxError(
              code,
              `${label} presentationMeta contains forbidden prototype key "${rawKey}" at ${path}`,
              status,
              { path, key: rawKey },
            )
          }
          const idx = Number(rawKey)
          if (!Number.isInteger(idx) || idx < 0 || idx >= current.length || String(idx) !== rawKey) {
            const safeKey = redact ? redact(rawKey) : rawKey
            throw new HelmxError(
              code,
              `${label} presentationMeta contains an extra own property "${safeKey}" on array at ${path}`,
              status,
              { path, key: safeKey },
            )
          }
        }
        return out
      }
      if (!isPlainObject(current)) {
        throw new HelmxError(
          code,
          `${label} presentationMeta contains a non-plain object at ${path}`,
          status,
          { path },
        )
      }
      for (const forbidden of FORBIDDEN_META_KEYS) {
        if (Object.hasOwn(current, forbidden)) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains forbidden prototype key "${forbidden}" at ${path}`,
            status,
            { path, key: forbidden },
          )
        }
      }
      const out: Record<string, unknown> = {}
      const seenKeys = new Set<string>()
      for (const rawKey of Reflect.ownKeys(current)) {
        if (typeof rawKey !== 'string') {
          const safeSym = redact ? redact(String(rawKey)) : String(rawKey)
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a symbol key (${safeSym}) at ${path}`,
            status,
            { path },
          )
        }
        const desc = Object.getOwnPropertyDescriptor(current, rawKey)
        if (desc === undefined || !desc.enumerable) {
          const safeKey = redact ? redact(rawKey) : rawKey
          throw new HelmxError(
            code,
            `${label} presentationMeta contains a non-enumerable property "${safeKey}" at ${path}`,
            status,
            { path, key: safeKey },
          )
        }
        if (desc.get !== undefined || desc.set !== undefined) {
          const safeKey = redact ? redact(rawKey) : rawKey
          throw new HelmxError(
            code,
            `${label} presentationMeta contains an accessor property "${safeKey}" at ${path}`,
            status,
            { path, key: safeKey },
          )
        }
        const key = redact ? redact(rawKey) : rawKey
        if (FORBIDDEN_META_KEY_SET.has(key)) {
          throw new HelmxError(
            code,
            `${label} presentationMeta contains forbidden prototype key "${key}" at ${path}`,
            status,
            { path, key },
          )
        }
        if (seenKeys.has(key)) {
          throw new HelmxError(
            'redacted_key_conflict',
            `${label} presentationMeta redacted fields collide at ${path}.${key}`,
            500,
            { path, key },
          )
        }
        seenKeys.add(key)
        out[key] = visit(desc.value, `${path}.${key}`, depth + 1)
      }
      return out
    } finally {
      visiting.delete(current)
    }
  }

  const cloned = visit(value, 'presentationMeta', 1) as Record<string, unknown>
  const bytes = utf8Encoder.encode(JSON.stringify(cloned)).byteLength
  if (bytes > maxBytes) {
    throw new HelmxError(
      code,
      `${label} presentationMeta exceeds max byte size (${bytes} > ${maxBytes} bytes)`,
      status,
      { maxBytes, actualBytes: bytes },
    )
  }

  if (options?.schema !== undefined) {
    validateOrThrow(
      options.schema,
      cloned,
      `${label} presentationMeta does not conform to presentationMetaSchema`,
      code,
      status,
    )
  }

  return cloned
}
