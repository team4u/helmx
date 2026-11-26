import { redactJsonValue } from '@helmx/protocol'

export interface SubagentSignatureInput {
  prompt: string
  label?: string
  agentType?: string
  nodeId?: string
  cwd?: string
  isolation?: string
  fork?: boolean
  resume?: string
  model?: string
  effort?: string
  gate?: string
  maxSubagentDepth?: number
  schema?: Record<string, unknown>
  attachments?: readonly string[]
}

/**
 * Deterministic canonical JSON serialization: sorts plain-object keys recursively and
 * omits undefined properties while preserving array ordering.
 */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJsonString(item))).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries: string[] = []
  for (const key of keys) {
    const prop = record[key]
    if (prop === undefined) continue
    entries.push(`${JSON.stringify(key)}:${canonicalJsonString(prop)}`)
  }
  return `{${entries.join(',')}}`
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

function nonEmptyRedacted(value: string | undefined, redact: (text: string) => string): string | undefined {
  if (value === undefined || value === '') return undefined
  return redact(value)
}

/**
 * Canonical task-semantic signature of a `subagent` call (shared by incoming tool calls
 * and persisted `PersistedSubagentSpec` records; intentionally excludes `callId`, `requestId`,
 * `agentId`, and `background`).
 */
export function subagentCallSignature(
  input: SubagentSignatureInput,
  redact: (text: string) => string,
): string {
  const trimmedLabel = input.label !== undefined ? input.label.trim() : ''
  const label = trimmedLabel !== '' ? redact(trimmedLabel) : undefined
  const attachments =
    input.attachments !== undefined && input.attachments.length > 0
      ? input.attachments.map((item) => redact(item))
      : undefined
  return canonicalJsonString({
    prompt: redact(input.prompt),
    ...(label !== undefined ? { label } : {}),
    ...(nonEmptyString(input.agentType) !== undefined ? { agentType: input.agentType } : {}),
    ...(nonEmptyString(input.nodeId) !== undefined ? { nodeId: input.nodeId } : {}),
    ...(nonEmptyRedacted(input.cwd, redact) !== undefined ? { cwd: nonEmptyRedacted(input.cwd, redact) } : {}),
    ...(input.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
    ...(input.fork === true ? { fork: true } : {}),
    ...(nonEmptyString(input.resume) !== undefined ? { resume: input.resume } : {}),
    ...(nonEmptyRedacted(input.model, redact) !== undefined ? { model: nonEmptyRedacted(input.model, redact) } : {}),
    ...(nonEmptyString(input.effort) !== undefined ? { effort: input.effort } : {}),
    ...(nonEmptyRedacted(input.gate, redact) !== undefined ? { gate: nonEmptyRedacted(input.gate, redact) } : {}),
    ...(input.maxSubagentDepth !== undefined ? { maxSubagentDepth: input.maxSubagentDepth } : {}),
    ...(input.schema !== undefined ? { schema: redactJsonValue(input.schema, redact) } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  })
}

interface InflightSubagentClaim {
  readonly token: symbol
  readonly callId?: string
}

/**
 * Synchronous in-flight claim registry preventing zero-gap parallel duplicate `subagent`
 * launches within the same parent conversation before async `startBackgroundAgent` / `spawnAgent`
 * settles or enters `WorkflowService.active`.
 */
export class InflightSubagentRegistry {
  private readonly entries = new Map<string, InflightSubagentClaim>()

  findConflict(key: string, callId: string | undefined): { callId?: string } | undefined {
    const existing = this.entries.get(key)
    if (existing === undefined) return undefined
    if (callId !== undefined && existing.callId === callId) return undefined
    return existing.callId !== undefined ? { callId: existing.callId } : {}
  }

  claim(key: string, callId: string | undefined): () => void {
    const token = Symbol('subagent-claim')
    this.entries.set(key, { token, ...(callId !== undefined ? { callId } : {}) })
    return () => {
      if (this.entries.get(key)?.token === token) {
        this.entries.delete(key)
      }
    }
  }
}
