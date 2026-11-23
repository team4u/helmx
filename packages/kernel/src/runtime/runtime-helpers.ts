/**
 * Shared file-level runtime helpers (stateless pure functions).
 *
 * Extracted from `runtime.ts`: tool result contracts, `before_turn` section/message manipulation,
 * rewind interval parsing, 404 conversation checks, and other cross-module reusable helpers.
 */
import { join } from 'node:path'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import type { Conversation, EntryId, EntryRecord, ToolExecutionResult } from '@earendil-works/pi-durable'
import type { JsonSchema, PluginToolTextBlock } from '@helmx/protocol'
import type { Models } from '@earendil-works/pi-ai'
import {
  HelmxError,
  assertBoundedPresentationMeta,
  assertProfileId,
  isPlainObject,
  safeResultText,
  validateOrThrow,
} from '@helmx/protocol'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { HelmxStore } from './store.js'
import { requireModelRef } from './models.js'

// ---------------------------------------------------------------------------
// Conversation existence 404 (shared across 15+ call sites)
// ---------------------------------------------------------------------------

/** `store.getConv` + 404 check (centralized helper replacing 15+ inline checks). */
export function requireConv(store: HelmxStore, id: number): NonNullable<ReturnType<HelmxStore['getConv']>> {
  const meta = store.getConv(id)
  if (!meta) throw new HelmxError('not_found', `Conversation not found: ${id}`, 404)
  return meta
}

// ---------------------------------------------------------------------------
// Tool result contract helpers (plugin/action/hook output -> SDK ToolExecutionResult)
// ---------------------------------------------------------------------------

export interface ToolResultSchemaOptions {
  structuredOutputSchema?: JsonSchema
  presentationMetaSchema?: JsonSchema
  toolName?: string
  callId?: string
}

export interface ActionToolResultOptions extends ToolResultSchemaOptions {
  projectPresentationMeta?: (input: unknown, output: unknown) => Record<string, unknown> | undefined
  formatOutput?: (input: unknown, output: unknown) => string | PluginToolTextBlock[]
}

export interface GuardToolResultOptions extends ToolResultSchemaOptions {
  /**
   * When true (HookBridge.afterTool), returning `details` or `structuredOutput` without the corresponding
   * declared schema fails explicitly with `invalid_tool_result`.
   */
  enforceSchemas?: boolean
}

const FORBIDDEN_ENVELOPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ALLOWED_TOOL_RESULT_KEYS = new Set([
  'output',
  'structuredOutput',
  'isError',
  'details',
  'diagnostics',
  'usage',
  'control',
])
const TEXT_CONTENT_KEYS = new Set(['type', 'text', 'textSignature'])
const IMAGE_CONTENT_KEYS = new Set(['type', 'data', 'mimeType'])
const DIAGNOSTIC_KEYS = new Set(['severity', 'message', 'code'])
const DIAGNOSTIC_SEVERITIES = new Set(['info', 'warn', 'error'])
const USAGE_REQUIRED_NUMBER_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const
const USAGE_OPTIONAL_NUMBER_KEYS = ['cacheWrite1h', 'reasoning'] as const
const USAGE_KEYS = new Set<string>([...USAGE_REQUIRED_NUMBER_KEYS, ...USAGE_OPTIONAL_NUMBER_KEYS, 'cost'])
const USAGE_COST_REQUIRED_NUMBER_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const
const USAGE_COST_KEYS = new Set<string>([...USAGE_COST_REQUIRED_NUMBER_KEYS, 'totalFromProvider'])
const CONTROL_KEYS = new Set(['addTools', 'terminate', 'handoff'])

function formatToolWhere(options?: { toolName?: string; callId?: string }): string {
  return options?.toolName !== undefined
    ? `tool ${options.toolName}${options?.callId !== undefined ? `(callId=${options.callId})` : ''}`
    : 'plugin tool'
}

/**
 * Strictly validate, redact, and deep-clone a raw JS value as faithful JSON without calling `JSON.stringify`:
 * rejects `undefined`, symbols, functions, `bigint`, non-finite numbers, cycles, sparse arrays, non-plain arrays
 * or objects (including custom prototypes / class instances with `toJSON`), extra own properties on arrays,
 * symbol own keys, non-enumerable or accessor own properties, `toJSON` disguises, and forbidden prototype keys
 * (`__proto__`, `constructor`, `prototype`, before and after redaction).
 */
function assertStrictToolResultJson(
  value: unknown,
  redact: (text: string) => string,
  where: string,
  rootPath: string,
): unknown {
  const visiting = new WeakSet<object>()

  function visit(current: unknown, path: string): unknown {
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return redact(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new HelmxError('invalid_tool_result', `${where} ${path} contains a non-finite number`, 500, { path })
      }
      return current
    }
    if (typeof current !== 'object') {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} ${path} contains a non-JSON value (${typeof current})`,
        500,
        { path },
      )
    }
    if (visiting.has(current)) {
      throw new HelmxError('invalid_tool_result', `${where} ${path} contains a circular reference`, 500, { path })
    }
    visiting.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new HelmxError('invalid_tool_result', `${where} ${path} contains a non-plain array`, 500, { path })
        }
        for (const rawKey of Reflect.ownKeys(current)) {
          if (rawKey === 'length') continue
          if (typeof rawKey !== 'string') {
            throw new HelmxError(
              'invalid_tool_result',
              `${where} ${path} contains a symbol key (${redact(String(rawKey))}) on array`,
              500,
              { path },
            )
          }
          if (FORBIDDEN_ENVELOPE_KEYS.has(rawKey)) {
            throw new HelmxError(
              'invalid_tool_result',
              `${where} ${path} contains forbidden prototype key "${rawKey}"`,
              500,
              { path, key: rawKey },
            )
          }
          const idx = Number(rawKey)
          if (!Number.isInteger(idx) || idx < 0 || idx >= current.length || String(idx) !== rawKey) {
            const safeKey = redact(rawKey)
            throw new HelmxError(
              'invalid_tool_result',
              `${where} ${path} contains an extra own property "${safeKey}" on array`,
              500,
              { path, key: safeKey },
            )
          }
        }
        const out: unknown[] = []
        for (let i = 0; i < current.length; i += 1) {
          const desc = Object.getOwnPropertyDescriptor(current, i)
          if (desc === undefined) {
            throw new HelmxError(
              'invalid_tool_result',
              `${where} ${path}[${i}] contains a sparse array hole`,
              500,
              { path: `${path}[${i}]` },
            )
          }
          if (!desc.enumerable || desc.get !== undefined || desc.set !== undefined) {
            throw new HelmxError(
              'invalid_tool_result',
              `${where} ${path}[${i}] contains a non-enumerable or accessor array element`,
              500,
              { path: `${path}[${i}]` },
            )
          }
          out.push(visit(desc.value, `${path}[${i}]`))
        }
        return out
      }
      if (!isPlainObject(current)) {
        throw new HelmxError('invalid_tool_result', `${where} ${path} contains a non-plain object`, 500, { path })
      }
      const out: Record<string, unknown> = {}
      const seenKeys = new Set<string>()
      for (const rawKey of Reflect.ownKeys(current)) {
        if (typeof rawKey !== 'string') {
          throw new HelmxError(
            'invalid_tool_result',
            `${where} ${path} contains a symbol key (${redact(String(rawKey))})`,
            500,
            { path },
          )
        }
        const desc = Object.getOwnPropertyDescriptor(current, rawKey)
        if (desc === undefined || !desc.enumerable) {
          const safeKey = redact(rawKey)
          throw new HelmxError(
            'invalid_tool_result',
            `${where} ${path} contains a non-enumerable property "${safeKey}"`,
            500,
            { path, key: safeKey },
          )
        }
        if (desc.get !== undefined || desc.set !== undefined) {
          const safeKey = redact(rawKey)
          throw new HelmxError(
            'invalid_tool_result',
            `${where} ${path} contains an accessor property "${safeKey}"`,
            500,
            { path, key: safeKey },
          )
        }
        if (FORBIDDEN_ENVELOPE_KEYS.has(rawKey)) {
          throw new HelmxError(
            'invalid_tool_result',
            `${where} ${path} contains forbidden prototype key "${rawKey}"`,
            500,
            { path, key: rawKey },
          )
        }
        const key = redact(rawKey)
        if (FORBIDDEN_ENVELOPE_KEYS.has(key)) {
          throw new HelmxError(
            'invalid_tool_result',
            `${where} ${path} contains forbidden prototype key "${key}"`,
            500,
            { path, key },
          )
        }
        if (seenKeys.has(key)) {
          throw new HelmxError(
            'redacted_key_conflict',
            `${where} ${path} redacted fields collide at ${path}.${key}`,
            500,
            { path, key },
          )
        }
        seenKeys.add(key)
        out[key] = visit(desc.value, `${path}.${key}`)
      }
      return out
    } finally {
      visiting.delete(current)
    }
  }

  return visit(value, rootPath)
}

function assertOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new HelmxError('invalid_tool_result', `${where} ${path} contains unsupported field "${key}"`, 500, {
        path,
        key,
      })
    }
  }
}

function validateOutputField(
  raw: unknown,
  redact: (text: string) => string,
  where: string,
): NonNullable<ToolExecutionResult['output']> {
  const safe = assertStrictToolResultJson(raw, redact, where, 'output')
  if (!Array.isArray(safe)) {
    throw new HelmxError('invalid_tool_result', `${where} output must be an array of content blocks`, 500)
  }
  for (let i = 0; i < safe.length; i += 1) {
    const block = safe[i]
    const blockPath = `output[${i}]`
    if (!isPlainObject(block)) {
      throw new HelmxError('invalid_tool_result', `${where} ${blockPath} must be a plain content block object`, 500)
    }
    if (block['type'] === 'text') {
      assertOnlyAllowedKeys(block, TEXT_CONTENT_KEYS, where, blockPath)
      if (typeof block['text'] !== 'string') {
        throw new HelmxError('invalid_tool_result', `${where} ${blockPath}.text must be a string`, 500)
      }
      if ('textSignature' in block && typeof block['textSignature'] !== 'string') {
        throw new HelmxError('invalid_tool_result', `${where} ${blockPath}.textSignature must be a string`, 500)
      }
    } else if (block['type'] === 'image') {
      assertOnlyAllowedKeys(block, IMAGE_CONTENT_KEYS, where, blockPath)
      if (typeof block['data'] !== 'string' || typeof block['mimeType'] !== 'string') {
        throw new HelmxError('invalid_tool_result', `${where} ${blockPath} image block requires string data and mimeType`, 500)
      }
    } else {
      throw new HelmxError('invalid_tool_result', `${where} ${blockPath} only accepts text or image content blocks`, 500)
    }
  }
  return safe as NonNullable<ToolExecutionResult['output']>
}

function validateDiagnosticsField(
  raw: unknown,
  redact: (text: string) => string,
  where: string,
): NonNullable<ToolExecutionResult['diagnostics']> {
  const safe = assertStrictToolResultJson(raw, redact, where, 'diagnostics')
  if (!Array.isArray(safe)) {
    throw new HelmxError('invalid_tool_result', `${where} diagnostics must be an array of ToolDiagnostic entries`, 500)
  }
  for (let i = 0; i < safe.length; i += 1) {
    const entry = safe[i]
    const entryPath = `diagnostics[${i}]`
    if (!isPlainObject(entry)) {
      throw new HelmxError('invalid_tool_result', `${where} ${entryPath} must be a plain object`, 500)
    }
    assertOnlyAllowedKeys(entry, DIAGNOSTIC_KEYS, where, entryPath)
    if (typeof entry['severity'] !== 'string' || !DIAGNOSTIC_SEVERITIES.has(entry['severity'])) {
      throw new HelmxError('invalid_tool_result', `${where} ${entryPath}.severity must be info, warn, or error`, 500)
    }
    if (typeof entry['message'] !== 'string') {
      throw new HelmxError('invalid_tool_result', `${where} ${entryPath}.message must be a string`, 500)
    }
    if ('code' in entry && typeof entry['code'] !== 'string') {
      throw new HelmxError('invalid_tool_result', `${where} ${entryPath}.code must be a string`, 500)
    }
  }
  return safe as NonNullable<ToolExecutionResult['diagnostics']>
}

function validateUsageField(
  raw: unknown,
  redact: (text: string) => string,
  where: string,
): NonNullable<ToolExecutionResult['usage']> {
  const safe = assertStrictToolResultJson(raw, redact, where, 'usage')
  if (!isPlainObject(safe)) {
    throw new HelmxError('invalid_tool_result', `${where} usage must be a plain object`, 500)
  }
  assertOnlyAllowedKeys(safe, USAGE_KEYS, where, 'usage')
  for (const key of USAGE_REQUIRED_NUMBER_KEYS) {
    if (typeof safe[key] !== 'number') {
      throw new HelmxError('invalid_tool_result', `${where} usage.${key} must be a finite number`, 500)
    }
  }
  for (const key of USAGE_OPTIONAL_NUMBER_KEYS) {
    if (key in safe && typeof safe[key] !== 'number') {
      throw new HelmxError('invalid_tool_result', `${where} usage.${key} must be a finite number`, 500)
    }
  }
  const cost = safe['cost']
  if (!isPlainObject(cost)) {
    throw new HelmxError('invalid_tool_result', `${where} usage.cost must be a plain object`, 500)
  }
  assertOnlyAllowedKeys(cost, USAGE_COST_KEYS, where, 'usage.cost')
  for (const key of USAGE_COST_REQUIRED_NUMBER_KEYS) {
    if (typeof cost[key] !== 'number') {
      throw new HelmxError('invalid_tool_result', `${where} usage.cost.${key} must be a finite number`, 500)
    }
  }
  if ('totalFromProvider' in cost && typeof cost['totalFromProvider'] !== 'boolean') {
    throw new HelmxError('invalid_tool_result', `${where} usage.cost.totalFromProvider must be a boolean`, 500)
  }
  return safe as unknown as NonNullable<ToolExecutionResult['usage']>
}

function validateControlField(
  raw: unknown,
  redact: (text: string) => string,
  where: string,
): NonNullable<ToolExecutionResult['control']> {
  const safe = assertStrictToolResultJson(raw, redact, where, 'control')
  if (!isPlainObject(safe)) {
    throw new HelmxError('invalid_tool_result', `${where} control must be a plain object`, 500)
  }
  assertOnlyAllowedKeys(safe, CONTROL_KEYS, where, 'control')
  if ('addTools' in safe) {
    if (!Array.isArray(safe['addTools']) || safe['addTools'].some((item) => typeof item !== 'string')) {
      throw new HelmxError('invalid_tool_result', `${where} control.addTools must be an array of strings`, 500)
    }
  }
  if ('terminate' in safe && typeof safe['terminate'] !== 'boolean') {
    throw new HelmxError('invalid_tool_result', `${where} control.terminate must be a boolean`, 500)
  }
  if ('handoff' in safe && typeof safe['handoff'] !== 'string') {
    throw new HelmxError('invalid_tool_result', `${where} control.handoff must be a string`, 500)
  }
  return safe as NonNullable<ToolExecutionResult['control']>
}

function validateAndRedactStructuredOutput(
  raw: unknown,
  redact: (text: string) => string,
  options: {
    structuredOutputSchema?: JsonSchema
    requireSchema: boolean
    where: string
  },
): unknown {
  if (options.structuredOutputSchema === undefined) {
    if (options.requireSchema) {
      throw new HelmxError(
        'invalid_tool_result',
        `${options.where} returned structuredOutput without declaring structuredOutputSchema (forbidden by SDK contract; declare a schema or return plain text in output)`,
        500,
      )
    }
    return assertStrictToolResultJson(raw, redact, options.where, 'structuredOutput')
  }
  const redacted = assertStrictToolResultJson(raw, redact, options.where, 'structuredOutput')
  validateOrThrow(
    options.structuredOutputSchema,
    redacted,
    `${options.where} structuredOutput does not conform to structuredOutputSchema`,
    'invalid_tool_result',
    500,
  )
  return redacted
}

function validateAndRedactPresentationMeta(
  raw: unknown,
  redact: (text: string) => string,
  options: {
    presentationMetaSchema?: JsonSchema
    requireSchema: boolean
    where: string
  },
): Record<string, unknown> {
  if (options.presentationMetaSchema === undefined && options.requireSchema) {
    throw new HelmxError(
      'invalid_tool_result',
      `${options.where} returned presentationMeta without declaring presentationMetaSchema`,
      500,
    )
  }
  return assertBoundedPresentationMeta(raw, {
    label: options.where,
    redact,
    ...(options.presentationMetaSchema !== undefined ? { schema: options.presentationMetaSchema } : {}),
    code: 'invalid_tool_result',
    status: 500,
  })
}

function normalizeTextBlocks(
  rawOutput: unknown,
  where: string,
  redact?: (text: string) => string,
): Array<PluginToolTextBlock> {
  if (typeof rawOutput === 'string') {
    return [{ type: 'text', text: redact ? redact(rawOutput) : rawOutput }]
  }
  if (Array.isArray(rawOutput)) {
    return rawOutput.map((block) => {
      if (
        block === null ||
        typeof block !== 'object' ||
        (block as { type?: unknown }).type !== 'text' ||
        typeof (block as { text?: unknown }).text !== 'string'
      ) {
        throw new HelmxError(
          'invalid_tool_result',
          `${where} result envelope output array only accepts { type: 'text', text } blocks`,
          500,
        )
      }
      const text = (block as { text: string }).text
      return { type: 'text' as const, text: redact ? redact(text) : text }
    })
  }
  if (rawOutput === undefined) return []
  throw new HelmxError(
    'invalid_tool_result',
    `${where} result envelope output must be a string or an array of { type: 'text', text }`,
    500,
  )
}

/**
 * Envelope predicate for structured plugin tool results: must contain at least one of `output`,
 * `structuredOutput`, `presentationMeta`, or `isError`, and every present envelope field must have a valid type;
 * malformed envelope fields (or legacy `details` inside an envelope) fail explicitly rather than falling back silently.
 */
function envelopeProblem(raw: Record<string, unknown>): { isEnvelope: boolean; problem?: string } {
  const hasOutput = raw['output'] !== undefined
  const hasStructured = raw['structuredOutput'] !== undefined
  const hasPresentationMeta = raw['presentationMeta'] !== undefined
  const hasError = raw['isError'] !== undefined
  if (!hasOutput && !hasStructured && !hasPresentationMeta && !hasError) return { isEnvelope: false }
  if (hasOutput && typeof raw['output'] !== 'string' && !Array.isArray(raw['output'])) {
    return { isEnvelope: true, problem: "output must be a string or an array of { type: 'text', text }" }
  }
  if (hasError && typeof raw['isError'] !== 'boolean') {
    return { isEnvelope: true, problem: 'isError must be a boolean' }
  }
  if (hasPresentationMeta && !isPlainObject(raw['presentationMeta'])) {
    return { isEnvelope: true, problem: 'presentationMeta must be a plain JSON object' }
  }
  if (raw['details'] !== undefined) {
    return {
      isEnvelope: true,
      problem: 'details is not supported in plugin tool result envelopes; use presentationMeta with presentationMetaSchema',
    }
  }
  return { isEnvelope: true }
}

/**
 * Normalize raw plugin `ctx.tool` return value -> SDK `ToolExecutionResult`:
 * - Explicitly separates the three outbound channels: `output` (model text), `structuredOutput` (programmatic
 *   result validated synchronously against `structuredOutputSchema`; never auto-mirrored into `details`), and
 *   `presentationMeta` (redacted, bounded, schema-validated plain object written to `details` for UI replay);
 * - Returning `structuredOutput` without `structuredOutputSchema`, or `presentationMeta` without
 *   `presentationMetaSchema`, or violating schema/bounds fails explicitly (`invalid_tool_result`, never truncates);
 * - Non-envelope plain values serialize via `safeResultText` into a single text block.
 */
export function pluginToolResult(
  raw: unknown,
  redact: (text: string) => string,
  options?: ToolResultSchemaOptions,
): {
  output: Array<PluginToolTextBlock>
  structuredOutput?: unknown
  details?: Record<string, unknown>
  isError?: boolean
} {
  const where = formatToolWhere(options)
  if (isPlainObject(raw)) {
    const env = raw as {
      output?: unknown
      structuredOutput?: unknown
      presentationMeta?: unknown
      isError?: unknown
    }
    const verdict = envelopeProblem(raw)
    if (verdict.isEnvelope) {
      if (verdict.problem !== undefined) {
        throw new HelmxError(
          'invalid_tool_result',
          `${where} result envelope has invalid field type: ${verdict.problem}`,
          500,
        )
      }
      const output = normalizeTextBlocks(env.output, where, redact)
      const result: {
        output: Array<PluginToolTextBlock>
        structuredOutput?: unknown
        details?: Record<string, unknown>
        isError?: boolean
      } = { output }

      if (env.structuredOutput !== undefined) {
        result.structuredOutput = validateAndRedactStructuredOutput(env.structuredOutput, redact, {
          structuredOutputSchema: options?.structuredOutputSchema,
          requireSchema: true,
          where,
        })
      }
      if (env.presentationMeta !== undefined) {
        result.details = validateAndRedactPresentationMeta(env.presentationMeta, redact, {
          presentationMetaSchema: options?.presentationMetaSchema,
          requireSchema: true,
          where,
        })
      }
      if (env.isError === true) result.isError = true
      return result
    }
  }
  // Not an envelope: serialize as plain text (without structuredOutput or details).
  return { output: [{ type: 'text', text: safeResultText(raw, redact) }] }
}

/**
 * Normalize raw business return value of an `exposeAsTool: true` derived action -> SDK `ToolExecutionResult`.
 *
 * Bypasses `envelopeProblem` so business objects carrying `output` / `structuredOutput` / `presentationMeta` /
 * `details` / `isError` keys are never misidentified as tool envelopes. Redacts JSON values before serializing
 * model text, validates `structuredOutput` against the action's `outputSchema` (never mirroring into `details`),
 * and writes `details` only from `projectPresentationMeta` after redaction + boundedness + schema validation.
 */
export function actionToolResult(
  raw: unknown,
  input: unknown,
  redact: (text: string) => string,
  options?: ActionToolResultOptions,
): {
  output: Array<PluginToolTextBlock>
  structuredOutput?: unknown
  details?: Record<string, unknown>
} {
  const where = formatToolWhere(options)
  let output: Array<PluginToolTextBlock>
  if (options?.formatOutput !== undefined) {
    const formatted = options.formatOutput(input, raw)
    if (formatted === undefined) {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} formatOutput must return a string or an array of { type: 'text', text }`,
        500,
      )
    }
    output = normalizeTextBlocks(formatted, where, redact)
  } else {
    output = [{ type: 'text', text: safeResultText(raw, redact) }]
  }
  const result: {
    output: Array<PluginToolTextBlock>
    structuredOutput?: unknown
    details?: Record<string, unknown>
  } = { output }

  if (options?.structuredOutputSchema !== undefined) {
    result.structuredOutput = validateAndRedactStructuredOutput(raw, redact, {
      structuredOutputSchema: options.structuredOutputSchema,
      requireSchema: true,
      where,
    })
  }
  if (options?.projectPresentationMeta !== undefined) {
    const rawMeta = options.projectPresentationMeta(input, raw)
    if (rawMeta !== undefined) {
      result.details = validateAndRedactPresentationMeta(rawMeta, redact, {
        presentationMetaSchema: options.presentationMetaSchema,
        requireSchema: true,
        where,
      })
    }
  }
  return result
}

/**
 * Single outbound guard before tool result persistence (`HookBridge.afterTool` and `prepareToolResultWith`).
 *
 * Strictly validates and redacts EVERY field of the SDK `ToolExecutionResult` envelope (`output`, `isError`,
 * `diagnostics`, `usage`, `control`, `structuredOutput`, `details`) directly from the raw JS object WITHOUT any
 * `JSON.stringify` / `JSON.parse` pre-normalization: `undefined`, symbols, functions, `bigint`, non-finite
 * numbers, cycles, sparse arrays, non-plain objects, non-enumerable/accessor properties, `toJSON` disguises,
 * forbidden prototype keys, and unsupported fields all fail explicitly with `invalid_tool_result` (never
 * silently stripped or coerced). Enforces bounded `presentationMeta` (64 KiB / depth 12 / 2000 nodes) on every
 * result, and enforces declared `presentationMetaSchema` / `structuredOutputSchema` when `enforceSchemas: true`.
 */
export function guardToolExecutionResult(
  result: ToolExecutionResult,
  redact: (text: string) => string,
  options?: GuardToolResultOptions,
): ToolExecutionResult {
  const where = formatToolWhere(options)
  const requireSchema = options?.enforceSchemas === true

  if (!isPlainObject(result)) {
    throw new HelmxError('invalid_tool_result', `${where} result must be a plain JSON object`, 500)
  }

  let safeOutput: ToolExecutionResult['output']
  let safeIsError: boolean | undefined
  let safeDiagnostics: ToolExecutionResult['diagnostics']
  let safeUsage: ToolExecutionResult['usage']
  let safeControl: ToolExecutionResult['control']
  let safeDetails: Record<string, unknown> | undefined
  let safeStructured: unknown
  let hasStructured = false

  for (const rawKey of Reflect.ownKeys(result)) {
    if (typeof rawKey !== 'string') {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} result contains a symbol key (${redact(String(rawKey))})`,
        500,
      )
    }
    const desc = Object.getOwnPropertyDescriptor(result, rawKey)
    if (desc === undefined || !desc.enumerable) {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} result contains a non-enumerable property "${redact(rawKey)}"`,
        500,
      )
    }
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} result contains an accessor property "${redact(rawKey)}"`,
        500,
      )
    }
    if (FORBIDDEN_ENVELOPE_KEYS.has(rawKey)) {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} result contains forbidden prototype key "${rawKey}"`,
        500,
      )
    }
    if (!ALLOWED_TOOL_RESULT_KEYS.has(rawKey)) {
      throw new HelmxError(
        'invalid_tool_result',
        `${where} result contains unsupported field "${redact(rawKey)}"`,
        500,
      )
    }

    const rawValue = desc.value
    switch (rawKey) {
      case 'details':
        // `pi-durable` `finalResult` always spreads `details: result.details === undefined ? reported.details : result.details`,
        // producing own key `details: undefined` when no presentationMeta was emitted.
        if (rawValue !== undefined) {
          safeDetails = validateAndRedactPresentationMeta(rawValue, redact, {
            presentationMetaSchema: options?.presentationMetaSchema,
            requireSchema,
            where,
          })
        }
        break
      case 'structuredOutput':
        safeStructured = validateAndRedactStructuredOutput(rawValue, redact, {
          structuredOutputSchema: options?.structuredOutputSchema,
          requireSchema,
          where,
        })
        hasStructured = true
        break
      case 'output':
        safeOutput = validateOutputField(rawValue, redact, where)
        break
      case 'isError':
        if (typeof rawValue !== 'boolean') {
          throw new HelmxError('invalid_tool_result', `${where} isError must be a boolean`, 500)
        }
        safeIsError = rawValue
        break
      case 'diagnostics':
        safeDiagnostics = validateDiagnosticsField(rawValue, redact, where)
        break
      case 'usage':
        safeUsage = validateUsageField(rawValue, redact, where)
        break
      case 'control':
        safeControl = validateControlField(rawValue, redact, where)
        break
    }
  }

  return {
    ...(safeOutput !== undefined ? { output: safeOutput } : {}),
    ...(safeIsError !== undefined ? { isError: safeIsError } : {}),
    ...(safeDiagnostics !== undefined ? { diagnostics: safeDiagnostics } : {}),
    ...(safeUsage !== undefined ? { usage: safeUsage } : {}),
    ...(safeControl !== undefined ? { control: safeControl } : {}),
    ...(hasStructured ? { structuredOutput: safeStructured as JsonValue } : {}),
    ...(safeDetails !== undefined ? { details: safeDetails as JsonValue } : {}),
  }
}

// ---------------------------------------------------------------------------
// `before_turn` sections / tools manipulation (rewrites SDK leading system message)
// ---------------------------------------------------------------------------

/** Extract currently effective system sections from model messages (combining leading declaration and subsequent patches). */
export function systemSectionsOf(messages: ReadonlyArray<{ role?: string; sections?: unknown }>): Array<{ id: string; text: string }> {
  const sections = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    if (message.sections === null || typeof message.sections !== 'object') continue
    for (const [key, value] of Object.entries(message.sections as Record<string, unknown>)) {
      if (value === null) sections.delete(key)
      else if (typeof value === 'string') sections.set(key, value)
    }
  }
  return [...sections.entries()].map(([id, text]) => ({ id, text }))
}

/**
 * Project prompt metadata for final scoped active tools in `before_turn`:
 * - `prompt.tools.<name>`: full paragraph per tool (`promptSnippet`);
 * - `prompt.tools.guidelines`: shared section aggregating all `promptGuidelines`;
 * - Overwrites stale same-named sections cleanly (disabled/stripped tools leave no phantom prompts); empty metadata
 *   produces empty projection (clears all stale managed sections); returns original reference when unchanged.
 */
export function projectToolPromptSections(
  sections: ReadonlyArray<{ id: string; text: string }>,
  tools: ReadonlyArray<{ name: string; promptSnippet?: string; promptGuidelines?: string[] }>,
): Array<{ id: string; text: string }> {
  const snippets = tools.filter((t) => t.promptSnippet !== undefined)
  const guidelines = tools.filter((t) => t.promptGuidelines !== undefined)
  const desired = new Map<string, string>()
  for (const tool of snippets) {
    desired.set(`prompt.tools.${tool.name}`, tool.promptSnippet!)
  }
  if (guidelines.length > 0) {
    const lines = guidelines.flatMap((tool) => tool.promptGuidelines!.map((item) => `- ${tool.name}: ${item}`))
    desired.set('prompt.tools.guidelines', `Available tool guidelines:\n${lines.join('\n')}`)
  }
  const isManaged = (id: string) =>
    id === 'prompt.tools.guidelines' || id.startsWith('prompt.tools.')
  let changed = false
  const out: Array<{ id: string; text: string }> = []
  for (const section of sections) {
    if (isManaged(section.id)) {
      const next = desired.get(section.id)
      if (next !== undefined) {
        out.push({ id: section.id, text: next })
        desired.delete(section.id)
        if (next !== section.text) changed = true
      } else {
        changed = true // remove phantom section
      }
      continue
    }
    out.push(section)
  }
  for (const [id, text] of desired) {
    out.push({ id, text })
    changed = true
  }
  return changed ? out : (sections as Array<{ id: string; text: string }>)
}

/**
 * Boundary validation for full `before_turn` `messages` replacement (prevents system header corruption and history fabrication):
 * - Must be a non-empty array whose first element is a `system` message (SDK replay relies on leading system message);
 * - Base content of leading system message must match original (`sections`/`toolsRemoved`/`toolsAdded` declarations
 *   may change, but base prompt rules and body must not be overwritten);
 * - History starting at the first non-system message must stay intact in original order (appending after is allowed;
 *   truncating/rewriting/fabricating history is forbidden — use rewrite/reset channels for truncation).
 * Violations fail explicitly with `invalid_hook_result` rather than silently accepting broken rewrites.
 */
export function assertSafeMessageSurgery(
  original: ReadonlyArray<Record<string, unknown>>,
  replacement: unknown,
): Array<Record<string, unknown>> {
  const fail = (detail: string): HelmxError =>
    new HelmxError('invalid_hook_result', `before_turn messages rewrite out of bounds: ${detail}`, 500)
  if (!Array.isArray(replacement) || replacement.length === 0) {
    throw fail('must be a non-empty message array')
  }
  const lead = replacement[0]!
  if (lead['role'] !== 'system') {
    throw fail('first message must remain system (SDK replay mechanism relies on a leading system message)')
  }
  if (original.length === 0 || original[0]!['role'] !== 'system') {
    throw fail('original request is missing a leading system message (unexpected kernel state; rewrite rejected)')
  }
  if (contentTextOf(original[0]!) !== contentTextOf(lead)) {
    throw fail('leading system message base content was overwritten (base formatting and body are immutable; update sections/tools via declarations)')
  }
  // Preserve history: the subsequence starting at the first non-system message must appear verbatim in replacement (prefix aligned).
  let firstNonSystem = 0
  while (firstNonSystem < original.length && original[firstNonSystem]!['role'] === 'system') firstNonSystem += 1
  const historyLen = original.length - firstNonSystem
  const preservedHistory = replacement.slice(firstNonSystem, firstNonSystem + historyLen)
  if (historyLen > 0) {
    for (let i = 0; i < historyLen; i += 1) {
      if (preservedHistory[i] !== original[firstNonSystem + i]!) {
        throw fail('historical messages may only be appended after; truncating, rewriting, or fabricating history is not allowed (use rewrite/reset channels for truncation)')
      }
    }
  }
  return replacement as Array<Record<string, unknown>>
}

/** Base text content of a system message (string or concatenated text blocks, matching SDK replay extraction). */
function contentTextOf(message: Record<string, unknown>): string {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function sectionsEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.text !== b[i]!.text) return false
  }
  return true
}

/**
 * Replace leading system message `sections` wholesale with `desired` (preserving base content).
 * Subsequent system message section patches are folded into `desired`, stripping old patches so replay cannot override.
 */
export function withSections(
  messages: ReadonlyArray<Record<string, unknown>>,
  desired: Array<{ id: string; text: string }>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [...messages]
  const out: Array<Record<string, unknown>> = [...messages]
  const lead = out[0]!
  if (lead['role'] !== 'system') return out
  const previous = lead['sections']
  const previousKeys =
    previous !== null && typeof previous === 'object'
      ? Object.keys(previous as Record<string, unknown>)
      : []
  // New declarations; old keys absent from the new set are removed with `null` (replay semantics).
  const next: Record<string, string | null> = {}
  for (const [i, section] of desired.entries()) {
    void i
    next[section.id] = section.text
  }
  for (const key of previousKeys) {
    if (!(key in next)) next[key] = null
  }
  out[0] = { ...lead, sections: next }
  for (let i = 1; i < out.length; i += 1) {
    const message = out[i]!
    if (message['role'] !== 'system' || message['sections'] === undefined) continue
    const { sections: _sections, ...rest } = message
    out[i] = rest
  }
  return out
}

/**
 * Rewrite tool declarations: attach `toolsRemoved`/`toolsAdded` declarations to the leading system message.
 * Parsed on the model side by pi-ai replay (`getCurrentTools`), taking effect immediately on the next round.
 */
export function withToolDeclarations(
  messages: ReadonlyArray<Record<string, unknown>>,
  declared: Set<string>,
  tools: ReturnType<typeof getCurrentTools>,
): Array<Record<string, unknown>> {
  const available = new Map(tools.map((tool) => [tool.name, tool]))
  const added: Array<Record<string, unknown>> = []
  for (const name of declared) {
    const tool = available.get(name)
    if (!tool) throw new HelmxError('unknown_tool', `before_turn selected unregistered tool: ${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // Full redeclaration: remove stale declarations then add new set (equivalent replay, avoids order drift).
  const next: Record<string, unknown> = { ...lead }
  const sections = lead['sections']
  next['sections'] =
    sections !== null && typeof sections === 'object'
      ? { ...(sections as Record<string, unknown>) }
      : {}
  next['toolsRemoved'] = currentToolNames(messages).filter((name) => declared.has(name) === false).map((name) => ({ name }))
  next['toolsAdded'] = added
  return [{ ...next }, ...messages.slice(1)]
}

/** List current tool names from replay messages. */
function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message['role'] !== 'system') continue
    for (const tool of message['toolsAdded'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof tool?.name === 'string') names.add(tool.name)
    }
    for (const ref of message['toolsRemoved'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof ref?.name === 'string') names.delete(ref.name)
    }
  }
  return [...names]
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

export function normalizeBusyError(error: unknown): unknown {
  const name = (error as { name?: string })?.name
  if (name === 'ConversationBusy') {
    return new HelmxError('conversation_busy', 'Conversation is busy and whenBusy=reject was specified', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmxError('conversation_idle', 'Conversation is idle and conflicts with whenIdle=reject', 409)
  }
  return error
}

export function entryModelText(entry: { model?: ReadonlyArray<{ content?: unknown }> }): string {
  const content = entry.model?.[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** Concatenate assistant text blocks from an `entry.model` array (shared by `waitForInput`, tracker, detail FTS, and native spawn). */
export function assistantTextOfModel(model: ReadonlyArray<unknown> | undefined): string {
  if (!Array.isArray(model)) return ''
  const out: string[] = []
  for (const message of model) {
    if (message === null || typeof message !== 'object') continue
    const blocks = (message as { content?: unknown }).content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        out.push((block as { text: string }).text)
      }
    }
  }
  return out.join('\n')
}

/** Extract assistant text from a single entry (returns `''` for non-`pi.assistant` entries). */
export function assistantTextOfEntry(
  entry: { kind: string; model?: ReadonlyArray<unknown> } | undefined,
): string {
  if (entry === undefined || entry.kind !== 'pi.assistant') return ''
  return assistantTextOfModel(entry.model)
}

/** Read a single persisted entry by exact ID (shared by `ConversationService.waitForInput` and `readSubmissionAssistantText`). */
export async function readEntryById(
  conversation: Pick<Conversation, 'entries'>,
  entryId: EntryId,
  context: Context = BACKGROUND_CONTEXT,
): Promise<EntryRecord | undefined> {
  if (typeof conversation.entries !== 'function') return undefined
  const page = await conversation.entries(
    { minEntryId: entryId, maxEntryId: entryId, order: 'ascending' },
    1,
    undefined,
    context,
  )
  const item = page.items[0]
  return item !== undefined && item.id === entryId ? item : undefined
}

// ---------------------------------------------------------------------------
// Rewind intervals (in-place edit & overwrite contract)
// ---------------------------------------------------------------------------

/** Overwrite range declared by a `helmx.rewind` truncation marker (closed interval `[from, through]`).
 *
 * `throughEntryId` is a strict boundary: max old entry ID within the overwritten span, so newer
 * input entries always have strictly larger IDs and are never mistakenly removed across intervals. */
export interface RewindInterval {
  from: number
  through: number
  marker: number
}

/** Parse a single rewind interval; returns `undefined` if not a rewind marker or missing `fromEntryId`. */
export function rewindIntervalOf(entry: { id: number | string; kind: string; data?: unknown }): RewindInterval | undefined {
  if (entry.kind !== 'helmx.rewind') return undefined
  const data = entry.data as { fromEntryId?: unknown; throughEntryId?: unknown } | undefined
  const from = Number(data?.fromEntryId)
  if (!Number.isSafeInteger(from) || from <= 0) return undefined
  const marker = Number(entry.id)
  const through = Number(data?.throughEntryId)
  if (!Number.isSafeInteger(marker) || !Number.isSafeInteger(through) || through < from || through >= marker) {
    throw new HelmxError('invalid_rewind_entry', `History overwrite marker ${entry.id} has an invalid interval`, 500)
  }
  return { from, through, marker }
}

/** Check whether an entry is covered by any rewind interval (shared by detail display / FTS rebuild / lastAssistant cleanup). */
export function coveredByRewind(entryId: number, intervals: ReadonlyArray<RewindInterval>): boolean {
  return intervals.some((cut) => entryId >= cut.from && entryId <= cut.through)
}

/** Edit target restriction: only human input entries may be overwritten (agent/trigger injections and control entries are rejected). */
export function assertEditableHumanInput(
  entry: { kind: string; data?: unknown },
  conversationId: number,
  entryId: number,
): void {
  if (entry.kind === 'pi.user') return
  if (entry.kind !== 'helmx.input') {
    throw new HelmxError(
      'entry_not_editable',
      `Only human input entries can be edited (entry ${entryId} has kind=${entry.kind})`,
      400,
      { conversationId, entryId, kind: entry.kind },
    )
  }
  const origin = (entry.data as { origin?: unknown } | undefined)?.origin
  if (origin !== 'human') {
    throw new HelmxError(
      'entry_not_editable',
      `Entry ${entryId} has origin '${String(origin)}'; only human inputs can be edited in place`,
      409,
      { conversationId, entryId, origin: String(origin) },
    )
  }
}

export type { ToolExecutionResult }

/** Startup corruption check for `models-store.json` (open phase; matches `ModelRegistry` logic). */
export async function assertModelsStoreHealthyAtBoot(models: Models): Promise<void> {
  const result = await models.refresh({ allowNetwork: false })
  for (const [, err] of result.errors) {
    if (err instanceof HelmxError && err.code === 'models_store_corrupted') {
      throw new HelmxError(
        'models_store_corrupted',
        `models-store.json is corrupted (discovered while reading): ${err.message}`,
        500,
      )
    }
  }
}

/** Underlying text-completion helper. */
export async function completeConversationTextHelper(
  deps: {
    store: HelmxStore
    conversations: { resolveEffectiveModel(modelOverride?: string, profileId?: string): Promise<string | undefined> }
    modelsRegistry: {
      models: Models
      isModelDisabled(providerId: string, modelId: string): boolean
      resolveModelRef?(ref: string): { provider: string; modelId: string; canonicalRef: string; tierThinkingLevel?: string }
    }
    stash: { redact(text: string): string }
  },
  input: {
    conversationId: number
    model?: string
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  },
): Promise<string> {
  input.signal?.throwIfAborted()
  const meta = deps.store.getConv(input.conversationId)
  if (meta === undefined) {
    throw new HelmxError('not_found', `Conversation not found: ${input.conversationId}`, 404, { conversationId: input.conversationId })
  }
  const explicitModel = input.model?.trim()
  const effective =
    explicitModel !== undefined && explicitModel !== ''
      ? explicitModel
      : await deps.conversations.resolveEffectiveModel(meta.modelOverride, meta.profileId)
  if (effective === undefined || effective === '') {
    throw new HelmxError('model_not_configured', `Conversation ${input.conversationId} has no effective model resolved; cannot run text completion`, 409, { conversationId: input.conversationId })
  }
  const ref = deps.modelsRegistry.resolveModelRef !== undefined
    ? deps.modelsRegistry.resolveModelRef(effective)
    : requireModelRef(effective)
  const model = deps.modelsRegistry.models.getModel(ref.provider, ref.modelId)
  if (model === undefined) {
    throw new HelmxError('model_not_found', `Effective model '${effective}' is not in the current model set (may have been removed on hot reload)`, 409, { model: effective })
  }
  if (deps.modelsRegistry.isModelDisabled(ref.provider, ref.modelId)) {
    throw new HelmxError('model_disabled', `Model ${ref.provider}/${ref.modelId} is disabled; cannot run text completion`, 409, { model: effective })
  }
  input.signal?.throwIfAborted()
  const message = await deps.modelsRegistry.models.completeSimple(
    model,
    {
      systemPrompt: deps.stash.redact(input.systemPrompt),
      messages: [
        {
          role: 'user',
          content: deps.stash.redact(input.text),
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: input.signal,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    },
  )
  input.signal?.throwIfAborted()
  if (message.stopReason !== 'stop') {
    throw new HelmxError(
      'model_completion_unavailable',
      `Text completion did not finish cleanly (stopReason=${message.stopReason}${message.errorMessage !== undefined ? `: ${deps.stash.redact(String(message.errorMessage)).slice(0, 200)}` : ''}); refusing to return partial text`,
      502,
      { stopReason: message.stopReason },
    )
  }
  const text = (message.content as Array<{ type?: string; text?: string }>)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  return deps.stash.redact(text)
}

/**
 * Helper to resolve the physical directory of a Profile.
 */
export function profileDirectoryHelper(dataDir: string, id: string): string {
  assertProfileId(id)
  return join(dataDir, 'profiles', id)
}

