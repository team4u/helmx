/**
 * Tool execution result contract helpers: normalize plugin / action / hook results into
 * SDK `ToolExecutionResult` with strict plain-JSON validation, redaction, and schema checks.
 */
import type { JsonValue } from '@earendil-works/chord/json'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import {
  HelmxError,
  assertBoundedPresentationMeta,
  assertJsonSafe,
  isPlainObject,
  safeResultText,
  validateOrThrow,
  type JsonSchema,
  type PluginToolTextBlock,
} from '@helmx/protocol'

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
   * When true (`HookBridge.afterTool`), returning `details` or `structuredOutput` without the corresponding
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

/** Strict plain-JSON validation, redaction, and deep cloning via `@helmx/protocol`'s `assertJsonSafe`. */
function assertStrictToolResultJson(
  value: unknown,
  redact: (text: string) => string,
  where: string,
  rootPath: string,
): unknown {
  return assertJsonSafe(value, {
    label: where,
    path: rootPath,
    redact,
    code: 'invalid_tool_result',
    status: 500,
  })
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

export type { ToolExecutionResult }
