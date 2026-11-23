/**
 * dsl/journal.ts — Serialized WAL JournalWriter, conservative readJournal, stable canonical
 * key fingerprints, and scoped prefix JournalReplay (unified from journal + journal-entry + replay).
 *
 * Key guarantees & bugfixes:
 * - Guaranteed `"type"` first key on every serialized JSONL row so AGENT_LINE_PREFIX genuinely
 *   matches real truncated agent rows (fixes legacy key-order bug);
 * - Promise-serialized write/close queue eliminates parallel JSONL interleaving and FD leaks;
 * - Fixed `poisoned` guard rejects ALL subsequent appends (agent & action);
 * - 1-byte stat+read tail newline check replaces full-file readFileSync on in-place resume;
 * - Canonical key-sorted JSON hashing makes action inputs and schemas key-order invariant.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, open, type FileHandle } from 'node:fs/promises'
import { canonicalJsonStringify, hasValidScopeIdentity, redactPlainValue } from './boundary.js'
import type {
  JournalAgentExecution,
  JournalScope,
  JournalWriteInput,
  WorkflowGateResult,
  WorkflowJournalEntry,
} from './types.js'

export interface AgentJournalKeyInput {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  effort?: string
  isolation?: string
  gate?: string
  resume?: string
  schema?: unknown
  attachments?: string[]
  maxSubagentDepth?: number
  cwd?: string
  nodeId?: string
}

/** Stable v5 canonical-object fingerprint: key-order invariant, distinguishing omitted vs empty attachments. */
export function agentJournalKey(input: AgentJournalKeyInput): string {
  const payload: Record<string, unknown> = {
    v: 5,
    prompt: input.prompt,
  }
  if (input.label !== undefined) payload['label'] = input.label
  if (input.model !== undefined) payload['model'] = input.model
  if (input.agentType !== undefined) payload['agentType'] = input.agentType
  if (input.effort !== undefined) payload['effort'] = input.effort
  if (input.isolation !== undefined) payload['isolation'] = input.isolation
  if (input.gate !== undefined) payload['gate'] = input.gate
  if (input.resume !== undefined) payload['resume'] = input.resume
  if (input.attachments !== undefined) payload['attachments'] = input.attachments
  if (input.schema !== undefined) payload['schema'] = input.schema
  if (input.maxSubagentDepth !== undefined) payload['maxSubagentDepth'] = input.maxSubagentDepth
  if (input.cwd !== undefined) payload['cwd'] = input.cwd
  if (input.nodeId !== undefined) payload['nodeId'] = input.nodeId
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex').slice(0, 32)
}

export function actionJournalKey(actionId: string, input: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(['action', actionId, input ?? {}]))
    .digest('hex')
    .slice(0, 32)
}

export function journalCoordKey(scope: JournalScope, attempt = 1): string {
  return JSON.stringify([scope.scopePath, scope.scopeCallIndex, attempt])
}

// ---------------------------------------------------------------------------
// Row shape validators
// ---------------------------------------------------------------------------

function isAgentExecutionShape(value: unknown): value is JournalAgentExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'nodeId' && key !== 'conversationId' && key !== 'executionId' && key !== 'effectiveCwd' && key !== 'worktree') {
      return false
    }
  }
  if (e['nodeId'] !== undefined && typeof e['nodeId'] !== 'string') return false
  if (e['conversationId'] !== undefined && (!Number.isInteger(e['conversationId']) || (e['conversationId'] as number) < 1)) return false
  if (e['executionId'] !== undefined && typeof e['executionId'] !== 'string') return false
  if (e['effectiveCwd'] !== undefined && typeof e['effectiveCwd'] !== 'string') return false
  if (e['worktree'] !== undefined && (typeof e['worktree'] !== 'object' || e['worktree'] === null || Array.isArray(e['worktree']))) {
    return false
  }
  return true
}

function isAgentGateShape(value: unknown): value is WorkflowGateResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'ok' && key !== 'output' && key !== 'exitCode' && key !== 'timedOut') return false
  }
  if (typeof e['ok'] !== 'boolean' || typeof e['output'] !== 'string') return false
  if (e['exitCode'] !== undefined && e['exitCode'] !== null && !Number.isInteger(e['exitCode'])) return false
  if (e['timedOut'] !== undefined && typeof e['timedOut'] !== 'boolean') return false
  return true
}

function hasCommonHeader(e: Record<string, unknown>): boolean {
  return (
    e['v'] === 1 &&
    Number.isSafeInteger(e['seq']) &&
    (e['seq'] as number) >= 0 &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string'
  )
}

function isValidJournalEntry(value: unknown): value is WorkflowJournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  if (!hasCommonHeader(e)) return false
  switch (e['type']) {
    case 'agent':
      return (
        typeof e['ok'] === 'boolean' &&
        (e['text'] === undefined || typeof e['text'] === 'string') &&
        (e['resumed'] === undefined || e['resumed'] === true) &&
        (e['attempt'] === undefined || (Number.isInteger(e['attempt']) && (e['attempt'] as number) >= 1)) &&
        (e['prompt'] === undefined || typeof e['prompt'] === 'string') &&
        (e['error'] === undefined || typeof e['error'] === 'string') &&
        (e['timedOut'] === undefined || typeof e['timedOut'] === 'boolean') &&
        (e['execution'] === undefined || isAgentExecutionShape(e['execution'])) &&
        (e['gate'] === undefined || isAgentGateShape(e['gate']))
      )
    case 'agent_started':
      return (
        typeof e['requestId'] === 'string' &&
        e['requestId'] !== '' &&
        (e['attempt'] === undefined || (Number.isInteger(e['attempt']) && (e['attempt'] as number) >= 1)) &&
        isAgentExecutionShape(e['execution'])
      )
    case 'action_started':
      return e['idempotent'] === undefined || e['idempotent'] === true
    case 'action':
      return typeof e['ok'] === 'boolean' && (e['idempotent'] === undefined || e['idempotent'] === true)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Conservative journal reader
// ---------------------------------------------------------------------------

export interface JournalReadResult {
  entries: WorkflowJournalEntry[]
  actionUncertain: boolean
  ioErrors: number
  failedActions: number
  readFailed?: { code: string; message: string }
}

const AGENT_LINE_PREFIX = /^\s*\{\s*"type"\s*:\s*"agent(?:_started)?"/

function classifyLine(line: string): { kind: 'entry'; entry: WorkflowJournalEntry } | { kind: 'agentCorrupt' | 'uncertain' } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return AGENT_LINE_PREFIX.test(line) ? { kind: 'agentCorrupt' } : { kind: 'uncertain' }
  }
  if (isValidJournalEntry(parsed)) return { kind: 'entry', entry: parsed }
  if (typeof parsed === 'object' && parsed !== null) {
    const type = (parsed as { type?: unknown }).type
    if (type === 'agent' || type === 'agent_started') return { kind: 'agentCorrupt' }
  }
  return { kind: 'uncertain' }
}

export function readJournal(path: string): JournalReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return { entries: [], actionUncertain: false, ioErrors: 0, failedActions: 0 }
    return {
      entries: [],
      actionUncertain: true,
      ioErrors: 0,
      failedActions: 0,
      readFailed: { code: err.code ?? 'EIO', message: err.message },
    }
  }

  const entries: WorkflowJournalEntry[] = []
  let ioErrors = 0
  let corruptUncertain = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const verdict = classifyLine(line)
    if (verdict.kind === 'entry') {
      entries.push(verdict.entry)
      continue
    }
    ioErrors++
    if (verdict.kind === 'uncertain') corruptUncertain = true
  }

  const startedByKey = new Map<string, Extract<WorkflowJournalEntry, { type: 'action_started' }>>()
  for (const entry of entries) {
    if (entry.type === 'action_started') {
      startedByKey.set(JSON.stringify([entry.scopePath, entry.scopeCallIndex, entry.index, entry.key]), entry)
    }
  }
  for (const entry of entries) {
    if (entry.type === 'action') {
      startedByKey.delete(JSON.stringify([entry.scopePath, entry.scopeCallIndex, entry.index, entry.key]))
    }
  }
  let dangling = false
  for (const started of startedByKey.values()) {
    if (started.idempotent !== true) {
      dangling = true
      break
    }
  }

  const failedActions = entries.filter((e) => e.type === 'action' && !e.ok && e.idempotent !== true).length

  const bySeq = new Map<number, string>()
  for (const entry of entries) {
    const serialized = JSON.stringify(entry)
    const previous = bySeq.get(entry.seq)
    if (previous !== undefined && previous !== serialized) {
      corruptUncertain = true
      ioErrors++
    }
    bySeq.set(entry.seq, serialized)
  }

  entries.sort((a, b) => a.seq - b.seq)
  const deduped: WorkflowJournalEntry[] = []
  let lastSeq = -1
  for (const entry of entries) {
    if (entry.seq === lastSeq) continue
    lastSeq = entry.seq
    deduped.push(entry)
  }

  return {
    entries: deduped,
    actionUncertain: dangling || corruptUncertain || failedActions > 0,
    ioErrors,
    failedActions,
  }
}

export function journalExists(path: string): boolean {
  return existsSync(path)
}

/** Value-level redaction before persisting journal entries (action rows already redacted by caller). */
export function redactJournalEntry(
  entry: JournalWriteInput,
  redact: (text: string) => string,
): JournalWriteInput {
  if (entry.type === 'agent_started') {
    return {
      ...entry,
      execution: redactPlainValue(entry.execution, redact) as JournalAgentExecution,
    }
  }
  if (entry.type !== 'agent') return entry
  return {
    ...entry,
    ...(entry.text !== undefined ? { text: redact(entry.text) } : {}),
    ...(entry.prompt !== undefined ? { prompt: redact(entry.prompt) } : {}),
    ...(entry.execution !== undefined ? { execution: redactPlainValue(entry.execution, redact) as JournalAgentExecution } : {}),
    ...(entry.error !== undefined ? { error: redact(entry.error) } : {}),
    ...(entry.gate !== undefined ? { gate: { ...entry.gate, output: redact(entry.gate.output) } } : {}),
  }
}

// ---------------------------------------------------------------------------
// Serialized WAL JournalWriter
// ---------------------------------------------------------------------------

export class JournalWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalWriteError'
  }
}

export class JournalWriter {
  private seq = 0
  private handle?: FileHandle
  private poisoned = false
  private closed = false
  private needsTailNewlineCheck: boolean
  private writeChain: Promise<void> = Promise.resolve()
  agentIoErrors = 0

  constructor(
    private readonly path: string,
    private readonly fsyncActions = true,
    initialSeq = 0,
  ) {
    if (Number.isInteger(initialSeq) && initialSeq > 0) this.seq = initialSeq
    this.needsTailNewlineCheck = this.seq > 0
  }

  private async ensureHandle(): Promise<FileHandle | undefined> {
    if (this.closed) return undefined
    if (this.handle !== undefined) return this.handle
    try {
      const fh = await open(this.path, 'a+')
      if (this.needsTailNewlineCheck) {
        this.needsTailNewlineCheck = false
        try {
          const st = await fh.stat()
          if (st.size > 0) {
            const tail = Buffer.alloc(1)
            await fh.read(tail, 0, 1, st.size - 1)
            if (tail[0] !== 0x0a) await appendFile(fh, '\n', 'utf-8')
          }
        } catch {
          // Best-effort tail newline repair; proceed with append.
        }
      }
      this.handle = fh
      return fh
    } catch {
      return undefined
    }
  }

  /** Serialized append: guarantees `"type"` first key, enforces poisoned guard for all rows, prevents interleaving. */
  append(entry: JournalWriteInput): Promise<number> {
    const task = this.writeChain.then(async (): Promise<number> => {
      if (this.poisoned) {
        throw new JournalWriteError(`workflow journal is poisoned (${this.path}); refusing further writes`)
      }
      const isActionLine = entry.type === 'action_started' || entry.type === 'action'
      const handle = await this.ensureHandle()
      if (handle === undefined) {
        if (isActionLine) {
          this.poisoned = true
          throw new JournalWriteError(`workflow journal unavailable: cannot open ${this.path}`)
        }
        this.agentIoErrors++
        return this.seq
      }
      const seq = entry.seq ?? this.seq++
      // Explicitly place `type`, `v`, `seq` first so AGENT_LINE_PREFIX reliably classifies truncated lines.
      const { type, seq: _ignoredSeq, ...rest } = entry
      const full = { type, v: 1 as const, seq, ...rest } as WorkflowJournalEntry
      try {
        await appendFile(handle, `${JSON.stringify(full)}\n`, 'utf-8')
        if (isActionLine && this.fsyncActions) await handle.sync()
      } catch (error) {
        if (isActionLine) {
          this.poisoned = true
          throw new JournalWriteError(
            `workflow journal write failed (${type}): ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        this.agentIoErrors++
      }
      return seq
    })
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }

  get isPoisoned(): boolean {
    return this.poisoned
  }

  close(): Promise<void> {
    const task = this.writeChain.then(async () => {
      this.closed = true
      const fh = this.handle
      this.handle = undefined
      if (fh !== undefined) {
        try {
          await fh.close()
        } catch {
          // Safe to ignore close errors after writes settled.
        }
      }
    })
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }
}

// ---------------------------------------------------------------------------
// Scoped Prefix Replay
// ---------------------------------------------------------------------------

type SettledEntry = Exclude<WorkflowJournalEntry, { type: 'action_started' | 'agent_started' }>
export type StartedAgentEntry = Extract<WorkflowJournalEntry, { type: 'agent_started' }>

export interface ReplayResult {
  hit: boolean
  entry?: SettledEntry
  conflictError?: string
}

export class JournalReplay {
  private readonly entries: readonly WorkflowJournalEntry[]
  private readonly settled = new Map<string, SettledEntry>()
  private readonly startedAgents = new Map<string, StartedAgentEntry>()
  private readonly scopes = new Set<string>()
  private readonly broken = new Set<string>()
  private readonly consumedActions = new Set<WorkflowJournalEntry>()

  constructor(entries: readonly WorkflowJournalEntry[]) {
    this.entries = [...entries]
    for (const entry of this.entries) {
      if (!hasValidScopeIdentity(entry)) {
        throw new Error('workflow_action_uncertain: invalid journal scope identity')
      }
      this.scopes.add(entry.scopePath)
      if (entry.type === 'action_started') continue
      if (entry.type === 'agent_started') {
        this.startedAgents.set(journalCoordKey(entry, entry.attempt ?? 1), entry)
        continue
      }
      const key = journalCoordKey(entry, entry.type === 'agent' ? (entry.attempt ?? 1) : 1)
      if (this.settled.has(key)) {
        throw new Error(`workflow_action_uncertain: duplicate journal coordinate ${key}`)
      }
      this.settled.set(key, entry)
    }
  }

  history(scope: JournalScope, attempt = 1): SettledEntry | undefined {
    return this.settled.get(journalCoordKey(scope, attempt))
  }

  startedAgent(scope: JournalScope, attempt = 1, key?: string): StartedAgentEntry | undefined {
    if (this.isBroken(scope.scopePath)) return undefined
    const coord = journalCoordKey(scope, attempt)
    if (this.settled.has(coord)) return undefined
    const started = this.startedAgents.get(coord)
    if (started === undefined) return undefined
    if (key !== undefined && started.key !== key) return undefined
    return started
  }

  unsettledStartedAgents(): StartedAgentEntry[] {
    const out: StartedAgentEntry[] = []
    for (const [coord, entry] of this.startedAgents) {
      if (!this.settled.has(coord)) out.push(entry)
    }
    return out
  }

  terminalFailureAttempt(scope: JournalScope): number {
    let last: Extract<SettledEntry, { type: 'agent' }> | undefined
    for (const entry of this.entries) {
      if (entry.scopePath !== scope.scopePath) continue
      if (entry.scopeCallIndex > scope.scopeCallIndex) return 0
      if (entry.scopeCallIndex !== scope.scopeCallIndex || entry.type !== 'agent') continue
      if (last === undefined || (entry.attempt ?? 1) > (last.attempt ?? 1)) last = entry
    }
    return last !== undefined && !last.ok ? (last.attempt ?? 1) : 0
  }

  private isBroken(path: string): boolean {
    for (const parent of this.broken) {
      if (path === parent || path.startsWith(`${parent}/`)) return true
    }
    return false
  }

  match(
    scope: JournalScope,
    key: string,
    kind: 'agent' | 'action',
    options: { attempt?: number; allowFailure?: boolean; resumed?: boolean } = {},
  ): ReplayResult {
    if (this.isBroken(scope.scopePath)) return this.miss(scope)
    const entry = this.history(scope, options.attempt)
    if (
      entry === undefined ||
      entry.type !== kind ||
      entry.key !== key ||
      (!entry.ok && !(entry.type === 'agent' && options.allowFailure === true)) ||
      (entry.type === 'agent' && options.resumed !== undefined && (entry.resumed === true) !== options.resumed)
    ) {
      return this.miss(scope)
    }
    return { hit: true, entry }
  }

  consumeAction(entry: WorkflowJournalEntry): void {
    this.consumedActions.add(entry)
    for (const intent of this.entries) {
      if (
        intent.type === 'action_started' &&
        intent.scopePath === entry.scopePath &&
        intent.scopeCallIndex === entry.scopeCallIndex &&
        intent.index === entry.index &&
        intent.key === entry.key
      ) {
        this.consumedActions.add(intent)
      }
    }
  }

  miss(scope: JournalScope): ReplayResult {
    this.broken.add(scope.scopePath)
    const childPrefix = `${scope.scopePath}/`
    const uncertain = this.entries.some((entry) => {
      if ((entry.type !== 'action' && entry.type !== 'action_started') || entry.idempotent === true || this.consumedActions.has(entry)) {
        return false
      }
      if (!this.scopes.has(scope.scopePath)) return true
      if (entry.scopePath === scope.scopePath) return entry.scopeCallIndex >= scope.scopeCallIndex
      return entry.scopePath.startsWith(childPrefix) || scope.scopePath.startsWith(`${entry.scopePath}/`)
    })
    return uncertain
      ? {
          hit: false,
          conflictError:
            `workflow_action_uncertain: journal replay broke prefix at ${scope.scopePath}:${scope.scopeCallIndex}, ` +
            'but the remaining journal suffix contains non-idempotent action(s). Automatic live rerun would risk repeating external side effects.',
        }
      : { hit: false }
  }
}
