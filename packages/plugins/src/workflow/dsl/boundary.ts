/**
 * dsl/boundary.ts — Single-source boundary validation, canonical JSON serialization,
 * value redaction, script precheck, JSON Schema compilation, and Gate evaluation.
 */
import { availableParallelism } from 'node:os'
import { Script } from 'node:vm'
import {
  assertSchemaCompilable,
  isValidNodeId,
  NODE_ID_PATTERN,
  validateOrThrow,
  type JsonSchema,
} from '@helmx/protocol'
import { HARD_MAX_SUBAGENT_DEPTH } from '../../contracts.js'
import { extractMeta } from './meta.js'
import type {
  CompiledSchema,
  JournalAgentExecution,
  JournalScope,
  WorkflowGateResult,
  WorkflowHost,
  WorkflowMeta,
  WorkflowSpawnResult,
} from './types.js'

export const MAX_SCRIPT_LENGTH = 524_288
export const WORKFLOW_AGENT_CAP = 1000
export const WORKFLOW_ACTION_CAP = 4096
export const WORKFLOW_TIMELINE_CAP = 1000
export const WORKFLOW_ITEM_CAP = 4096
export const WORKFLOW_NESTED_CAP = 256
export const MAX_AGENT_ATTEMPTS = 10
const MAX_SCHEMA_BYTES = 64 * 1024
const PREVIEW_LENGTH = 200

/** Shared effort levels across subagent tool, DSL agent(), and kernel THINKING_LEVELS. */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS)

const AGENT_OPTION_KEYS: ReadonlySet<string> = new Set([
  'label',
  'phase',
  'model',
  'agentType',
  'isolation',
  'gate',
  'resume',
  'effort',
  'schema',
  'attachments',
  'maxSubagentDepth',
  'nodeId',
  'cwd',
  'timeoutMs',
  'gateTimeoutMs',
  'maxAttempts',
])

const ACTION_OPTION_KEYS: ReadonlySet<string> = new Set(['idempotent', 'label', 'phase'])
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export class WorkflowRuntimeError extends Error {}

/** Non-fatal option error returned to the script so try/catch & parallel/pipeline can handle it. */
export class ScriptCallOptionError extends Error {}

export function defaultWorkflowConcurrency(cpuCount = availableParallelism()): number {
  return Math.max(2, Math.min(32, cpuCount * 2))
}

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(`Cannot pass ${what} across the workflow VM boundary (at ${path}).`)
}

function walkBoundary(value: unknown, path: string, seen: Set<object>, allowRootUndefined: boolean): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw boundaryError('a non-finite number', path)
    return
  }
  if (kind === 'undefined') {
    if (allowRootUndefined) return
    throw boundaryError('undefined', path)
  }
  if (kind === 'bigint') throw boundaryError('a BigInt', path)
  if (kind === 'symbol') throw boundaryError('a symbol', path)
  if (kind === 'function') throw boundaryError('a function', path)
  if (kind !== 'object') throw boundaryError(`a ${kind}`, path)

  const object = value as object
  if (seen.has(object)) throw boundaryError('a circular structure', path)
  seen.add(object)

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError('an object with symbol keys', path)
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError('a sparse array', `${path}[${i}]`)
      walkBoundary(object[i], `${path}[${i}]`, seen, false)
    }
    seen.delete(object)
    return
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError('a non-plain object', path)
  }
  for (const [key, entry] of Object.entries(object)) {
    walkBoundary(entry, `${path}.${key}`, seen, false)
  }
  seen.delete(object)
}

export function assertBoundarySafe(value: unknown, path: string, allowRootUndefined = path === 'args'): void {
  walkBoundary(value, path, new Set(), allowRootUndefined)
}

/** Deterministic key-sorted JSON serialization for journal fingerprint stability. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJsonStringify(item))).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = obj[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
  }
  return `{${parts.join(',')}}`
}

/** Value-level redaction covering plain objects including `Object.create(null)` (fixes null-proto leak). */
export function redactPlainValue(value: unknown, redactText: (text: string) => string): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactPlainValue(item, redactText))
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) out[key] = redactPlainValue(entry, redactText)
      return out
    }
  }
  return value
}

export function normalizeWorkflowArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw
  let current = raw
  for (let i = 0; i < 2 && typeof current === 'string'; i++) {
    const trimmed = current.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      try {
        current = JSON.parse(trimmed)
      } catch {
        break
      }
    } else {
      break
    }
  }
  return current
}

export function preview(text: string): string {
  return text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`
}

export function derivedLabel(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim()
  return line.length <= 60 ? line || 'agent' : `${line.slice(0, 59)}…`
}

export function scopedResumeKey(workflowRootPath: string, label: string): string {
  return `${workflowRootPath}:${label}`
}

export function agentRetryPrompt(originalPrompt: string, failedAttempt: number, reason: string): string {
  return `${originalPrompt}\n\n[attempt ${failedAttempt} failed]\n${reason}\nFix the problem above and complete the original task.`
}

export function hasValidScopeIdentity(value: unknown): value is JournalScope {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['scopePath'] === 'string' &&
    entry['scopePath'].length <= 4096 &&
    /^root(?:\/(?:0|[1-9][0-9]*))*$/.test(entry['scopePath']) &&
    Number.isSafeInteger(entry['scopeCallIndex']) &&
    (entry['scopeCallIndex'] as number) >= 0
  )
}

export function readCallScope(payload: unknown): JournalScope {
  if (!hasValidScopeIdentity(payload)) throw new WorkflowRuntimeError('Workflow call scope identity is invalid.')
  return { scopePath: payload.scopePath, scopeCallIndex: payload.scopeCallIndex }
}

export function isValidAttachments(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.trim() !== '')
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string }

export function compileJsonSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { ok: false, message: 'agent() opts.schema must be a JSON Schema object.' }
  }
  const root = schema as Record<string, unknown>
  if (root['type'] !== 'object') {
    return {
      ok: false,
      message:
        'agent() opts.schema must have `type: "object"` at its root — it becomes the structured-output contract, ' +
        'and a non-object root is not something a model can be asked to fill.',
    }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(root)
  } catch {
    return { ok: false, message: 'agent() opts.schema must be JSON-serializable.' }
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `agent() opts.schema is too large (${serialized.length} bytes; the limit is ${MAX_SCHEMA_BYTES}).`,
    }
  }
  try {
    assertSchemaCompilable(root as JsonSchema)
  } catch (error) {
    return {
      ok: false,
      message: `agent() opts.schema is not a schema this runtime can validate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  return {
    ok: true,
    compiled: {
      schema: root,
      check(value: unknown): true | string {
        try {
          validateOrThrow(root as JsonSchema, value, 'schema mismatch')
          return true
        } catch (error) {
          return error instanceof Error ? error.message.replace(/^schema mismatch:\s*/, '') : String(error)
        }
      },
    },
  }
}

export function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.text ?? '')
  } catch {
    return {
      ...result,
      ok: false,
      error: 'The agent did not return structured output: its answer was not JSON.',
    }
  }
  const verdict = compiled.check(parsed)
  if (verdict === true) return result
  return {
    ...result,
    ok: false,
    error: `The agent's answer did not match the requested schema: ${verdict}`,
  }
}

export async function applyGate(
  result: WorkflowSpawnResult,
  command: string,
  agentId: string,
  runGate: NonNullable<WorkflowHost['runGate']> | undefined,
  reported?: WorkflowGateResult,
  gateTimeoutMs?: number,
  effectiveCwd?: string,
): Promise<WorkflowSpawnResult> {
  const outcome =
    reported ??
    result.gate ??
    (await runGate!(command, {
      agentId,
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
    }))
  const kept = { ...result, gate: outcome, ...(outcome.timedOut === true ? { timedOut: true } : {}) }
  if (outcome.ok) return kept
  const { text: _discarded, ...rest } = kept
  const output = outcome.output.trim()
  if (output !== '') return { ...rest, ok: false, error: output }
  const detail =
    outcome.timedOut === true
      ? `Gate command timed out: ${command}`
      : outcome.exitCode !== undefined && outcome.exitCode !== null
        ? `Gate command failed with exit code ${outcome.exitCode}: ${command}`
        : `Gate command failed: ${command}`
  return { ...rest, ok: false, error: detail }
}

export interface ValidatedAgentCall {
  prompt: string
  label?: string
  phase?: string
  model?: string
  agentType?: string
  isolation?: 'worktree'
  gate?: string
  resume?: string
  effort?: string
  schema?: Record<string, unknown>
  attachments?: string[]
  maxSubagentDepth?: number
  nodeId?: string
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  maxAttempts?: number
}

function requireOptionText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScriptCallOptionError(`${what} requires a non-empty string.`)
  }
  return value
}

function optionalOptionText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireOptionText(value, what)
}

/** Single-source option validation for `agent()`, `agent.withMeta()`, and `goal()`. */
export function validateAgentCallOptions(
  rawPrompt: unknown,
  rawOpts: unknown,
  goalMode = false,
): ValidatedAgentCall {
  let promptSource: unknown = rawPrompt
  let optsObj: Record<string, unknown>
  if (goalMode) {
    if (rawOpts === undefined || rawOpts === null || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
      throw new ScriptCallOptionError('goal(spec) expects an options object.')
    }
    const spec = rawOpts as Record<string, unknown>
    for (const key of Object.keys(spec)) {
      if (key === 'objective' || AGENT_OPTION_KEYS.has(key)) continue
      throw new ScriptCallOptionError(
        `goal() spec.${key} is not a recognised option. Supported: objective, ${[...AGENT_OPTION_KEYS].join(', ')}.`,
      )
    }
    promptSource = requireOptionText(spec['objective'], 'goal() spec.objective')
    optsObj = {}
    for (const [k, v] of Object.entries(spec)) {
      if (k !== 'objective' && v !== undefined) optsObj[k] = v
    }
    if (optsObj['maxAttempts'] === undefined) optsObj['maxAttempts'] = 3
  } else {
    promptSource = requireOptionText(rawPrompt, 'agent(prompt)')
    if (rawOpts === undefined || rawOpts === null) {
      optsObj = {}
    } else if (typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
      throw new ScriptCallOptionError('agent(prompt, opts) expects opts to be an object.')
    } else {
      optsObj = rawOpts as Record<string, unknown>
    }
    for (const key of Object.keys(optsObj)) {
      if (!AGENT_OPTION_KEYS.has(key)) {
        throw new ScriptCallOptionError(
          `agent() opts.${key} is not a recognised option. Supported: ${[...AGENT_OPTION_KEYS].join(', ')}.`,
        )
      }
    }
  }

  const label = optionalOptionText(optsObj['label'], 'agent() opts.label')
  const phase = optionalOptionText(optsObj['phase'], 'agent() opts.phase')
  const model = optionalOptionText(optsObj['model'], 'agent() opts.model')
  const agentType = optionalOptionText(optsObj['agentType'], 'agent() opts.agentType')
  const isolationRaw = optionalOptionText(optsObj['isolation'], 'agent() opts.isolation')
  if (isolationRaw !== undefined && isolationRaw !== 'worktree') {
    throw new ScriptCallOptionError('agent() opts.isolation must be "worktree".')
  }
  const isolation = isolationRaw as 'worktree' | undefined
  const gate = optionalOptionText(optsObj['gate'], 'agent() opts.gate')
  const resume = optionalOptionText(optsObj['resume'], 'agent() opts.resume')
  const effort = optionalOptionText(optsObj['effort'], 'agent() opts.effort')
  if (effort !== undefined && !EFFORT_SET.has(effort)) {
    throw new ScriptCallOptionError(`agent() opts.effort must be one of: ${EFFORT_LEVELS.join(', ')}.`)
  }

  let schema: Record<string, unknown> | undefined
  if (optsObj['schema'] !== undefined) {
    if (typeof optsObj['schema'] !== 'object' || optsObj['schema'] === null || Array.isArray(optsObj['schema'])) {
      throw new ScriptCallOptionError('agent() opts.schema must be a JSON Schema object.')
    }
    assertBoundarySafe(optsObj['schema'], 'agent() opts.schema')
    schema = optsObj['schema'] as Record<string, unknown>
  }

  let attachments: string[] | undefined
  if (optsObj['attachments'] !== undefined) {
    if (!isValidAttachments(optsObj['attachments'])) {
      throw new ScriptCallOptionError('agent() opts.attachments must be an array of non-empty string artifact IDs.')
    }
    attachments = optsObj['attachments']
  }

  const maxSubagentDepth = optsObj['maxSubagentDepth']
  if (
    maxSubagentDepth !== undefined &&
    (typeof maxSubagentDepth !== 'number' ||
      !Number.isInteger(maxSubagentDepth) ||
      maxSubagentDepth < 1 ||
      maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH)
  ) {
    throw new ScriptCallOptionError(`agent() opts.maxSubagentDepth must be an integer between 1 and ${HARD_MAX_SUBAGENT_DEPTH}.`)
  }

  const nodeId = optionalOptionText(optsObj['nodeId'], 'agent() opts.nodeId')
  if (nodeId !== undefined && !isValidNodeId(nodeId)) {
    throw new ScriptCallOptionError(`agent() opts.nodeId must match ${NODE_ID_PATTERN}.`)
  }
  const cwd = optionalOptionText(optsObj['cwd'], 'agent() opts.cwd')

  const timeoutMs = optsObj['timeoutMs']
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000)
  ) {
    throw new ScriptCallOptionError('agent() opts.timeoutMs must be an integer between 1000 and 3600000 (milliseconds).')
  }
  const gateTimeoutMs = optsObj['gateTimeoutMs']
  if (
    gateTimeoutMs !== undefined &&
    (typeof gateTimeoutMs !== 'number' || !Number.isInteger(gateTimeoutMs) || gateTimeoutMs < 1_000 || gateTimeoutMs > 600_000)
  ) {
    throw new ScriptCallOptionError('agent() opts.gateTimeoutMs must be an integer between 1000 and 600000 (milliseconds).')
  }
  if (gateTimeoutMs !== undefined && gate === undefined) {
    throw new ScriptCallOptionError('agent() opts.gateTimeoutMs requires opts.gate: it bounds how long the gate command may run.')
  }
  const maxAttempts = optsObj['maxAttempts']
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_AGENT_ATTEMPTS)
  ) {
    throw new ScriptCallOptionError(`agent() opts.maxAttempts must be an integer between 1 and ${MAX_AGENT_ATTEMPTS}.`)
  }

  if (resume !== undefined) {
    const conflicts: Array<[string, unknown, string]> = [
      ['agentType', agentType, 'a resumed agent keeps the agent type it was started with.'],
      ['model', model, 'a resumed agent keeps the model it was started with.'],
      ['isolation', isolation, 'a resumed agent keeps the working tree it was started in.'],
      ['nodeId', nodeId, 'a resumed agent keeps the compute node it was started on.'],
      ['cwd', cwd, 'a resumed agent keeps the working directory it was started in.'],
      ['effort', effort, 'a resumed agent keeps the reasoning effort it was started with.'],
    ]
    for (const [field, val, reason] of conflicts) {
      if (val !== undefined) {
        throw new ScriptCallOptionError(`agent() opts.resume and opts.${field} are mutually exclusive: ${reason}`)
      }
    }
  }

  return {
    prompt: promptSource as string,
    ...(label !== undefined ? { label } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(gate !== undefined ? { gate } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  }
}

export interface ValidatedActionCall {
  actionId: string
  input: Record<string, unknown>
  idempotent?: boolean
  label?: string
  phase?: string
}

export function validateActionCallOptions(
  rawActionId: unknown,
  rawInput: unknown,
  rawOpts: unknown,
): ValidatedActionCall {
  const actionId = requireOptionText(rawActionId, 'action(actionId, input, opts)')
  const input = rawInput === undefined ? {} : rawInput
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScriptCallOptionError('action(actionId, input, opts) expects input to be a JSON object.')
  }
  assertBoundarySafe(input, `action('${actionId}') input`)

  let idempotent: boolean | undefined
  let label: string | undefined
  let phase: string | undefined
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== 'object' || rawOpts === null || Array.isArray(rawOpts)) {
      throw new ScriptCallOptionError('action(actionId, input, opts) expects opts to be an object.')
    }
    const opts = rawOpts as Record<string, unknown>
    for (const k of Object.keys(opts)) {
      if (!ACTION_OPTION_KEYS.has(k)) {
        throw new ScriptCallOptionError(`action() unknown option '${k}'. Allowed: ${[...ACTION_OPTION_KEYS].join(', ')}.`)
      }
    }
    if (opts['idempotent'] !== undefined) {
      if (typeof opts['idempotent'] !== 'boolean') {
        throw new ScriptCallOptionError('action() opts.idempotent must be a boolean.')
      }
      idempotent = opts['idempotent']
    }
    if (opts['label'] !== undefined) label = requireOptionText(opts['label'], 'action() opts.label')
    if (opts['phase'] !== undefined) phase = requireOptionText(opts['phase'], 'action() opts.phase')
  }

  return {
    actionId,
    input: input as Record<string, unknown>,
    ...(idempotent !== undefined ? { idempotent } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(phase !== undefined ? { phase } : {}),
  }
}

export function executionSnapshotOf(node: {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: unknown
}): JournalAgentExecution | undefined {
  if (
    node.nodeId === undefined &&
    node.conversationId === undefined &&
    node.executionId === undefined &&
    node.effectiveCwd === undefined &&
    node.worktree === undefined
  ) {
    return undefined
  }
  return {
    ...(node.nodeId !== undefined ? { nodeId: node.nodeId } : {}),
    ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
    ...(node.executionId !== undefined ? { executionId: node.executionId } : {}),
    ...(node.effectiveCwd !== undefined ? { effectiveCwd: node.effectiveCwd } : {}),
    ...(node.worktree !== undefined ? { worktree: node.worktree as Record<string, unknown> } : {}),
  }
}

export function unawaitedLaunchMessage(labels: readonly string[]): string {
  return `workflow script completed with unawaited launch(es): ${labels.map((l) => `'${l}'`).join(', ')}. Await or return each launch.`
}

export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new WorkflowRuntimeError(`Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`)
  }
  if (CONTROL_CHARACTERS.test(script)) {
    throw new WorkflowRuntimeError('Workflow script contains control characters. Only tab, carriage return and newline are allowed.')
  }
  return extractMeta(script)
}

export function precheckScriptSyntax(script: string): { meta: WorkflowMeta; body: string } {
  const { meta, body } = validateScript(script)
  try {
    new Script(`(async () => {\n${body}\n})()`, {
      filename: 'workflow-syntax-precheck.js',
      lineOffset: -1,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkflowRuntimeError(`Workflow script has a syntax error: ${detail}`)
  }
  return { meta, body }
}
