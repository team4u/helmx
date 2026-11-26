/**
 * dsl/runtime.ts — Host side of the deterministic workflow runner.
 *
 * - Single-source option validation via `boundary.ts`;
 * - Coordinate identity collapsed to `(scopePath, scopeCallIndex, attempt)`;
 * - Redacts terminal agent failures, action failures, retry prompts, and fatal errors via `redactText`;
 * - Supports `preAttachedAgents` + `runtimeReadyGate` for two-phase safe Hub restart recovery;
 * - Incremental `Map<number, WorkflowNodeState>` node table (O(1) per update, zero O(N²) collapse).
 */
import { Worker } from 'node:worker_threads'
import type { AgentExecutionInfo } from '@helmx/protocol'
import {
  extractWorktreeExecutionMeta,
  type WorkflowNodeState,
  type WorkflowProgressEntry,
} from '../../contracts.js'
import {
  agentRetryPrompt,
  applyGate,
  applySchema,
  assertBoundarySafe,
  compileJsonSchema,
  defaultWorkflowConcurrency,
  derivedLabel,
  executionSnapshotOf,
  normalizeWorkflowArgs,
  readCallScope,
  redactPlainValue,
  scopedResumeKey,
  ScriptCallOptionError,
  unawaitedLaunchMessage,
  type ValidatedActionCall,
  type ValidatedAgentCall,
  validateActionCallOptions,
  validateAgentCallOptions,
  validateScript,
  WORKFLOW_ACTION_CAP,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  WORKFLOW_TIMELINE_CAP,
} from './boundary.js'
import {
  actionJournalKey,
  agentJournalKey,
  journalCoordKey,
  JournalReplay,
  JournalWriteError,
  type AgentJournalKeyInput,
  type StartedAgentEntry,
} from './journal.js'
import type {
  AgentWithMetaResult,
  CompiledSchema,
  JournalAgentExecution,
  JournalScope,
  JournalWriteInput,
  RunWorkflowOptions,
  WorkerActionCallPayload,
  WorkerAgentCallPayload,
  WorkerMessage,
  WorkflowGateResult,
  WorkflowJournalEntry,
  WorkflowRunResult,
  WorkflowScriptRef,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from './types.js'
import { WORKER_SOURCE } from './worker-source.js'

export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, permits)
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.available++
  }

  drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()
      if (next !== undefined) next()
    }
  }
}

interface CompletedChild {
  agentId: string
  label: string
  agentType: string
  workflowRootPath: string
  model?: string
  isolation?: 'worktree'
  resumeRef?: string
  replayed?: true
}

interface ResolvedAgentCallConfig {
  opts: ValidatedAgentCall
  scope: JournalScope
  workflowRootPath: string
  compiledSchema: CompiledSchema | undefined
  index: number
  attemptLimit: number
  agentId: string
  label: string
  agentType: string
  model: string | undefined
  isolation: 'worktree' | undefined
  nodeId: string | undefined
  node: WorkflowNodeState
  keyInput: AgentJournalKeyInput
  resumed: CompletedChild | undefined
}

interface AgentReplayOutcome {
  handled: boolean
  attempt: number
  attemptIndex: number
  attemptPrompt: string
  attemptKey: string
  resumeTarget: CompletedChild | undefined
  reattachEntry: StartedAgentEntry | undefined
  replayedEntry: Extract<WorkflowJournalEntry, { type: 'agent' }> | undefined
}

type ActionJournalPayload =
  | Omit<Extract<JournalWriteInput, { type: 'action' }>, 'scopePath' | 'scopeCallIndex'>
  | Omit<Extract<JournalWriteInput, { type: 'action_started' }>, 'scopePath' | 'scopeCallIndex'>

function parseStructuredOutput(text: string, compiled: CompiledSchema | undefined): unknown {
  if (compiled === undefined) return text
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyExecutionToNode(
  node: WorkflowNodeState,
  info: AgentExecutionInfo | JournalAgentExecution,
): void {
  if (info.nodeId !== undefined) node.nodeId = info.nodeId
  if (info.conversationId !== undefined) node.conversationId = info.conversationId
  if (info.executionId !== undefined) node.executionId = info.executionId
  if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
  if ('meta' in info && info.meta !== undefined) {
    const wt = extractWorktreeExecutionMeta(info)
    if (wt.worktree !== undefined) node.worktree = wt.worktree
  } else if ('worktree' in info && info.worktree !== undefined) {
    node.worktree = info.worktree as WorkflowNodeState['worktree']
  }
}

function recordCompletedLabel(
  completedByLabel: Map<string, CompletedChild>,
  child: CompletedChild,
): void {
  completedByLabel.set(scopedResumeKey(child.workflowRootPath, child.label), child)
}

function buildAgentWithMetaResult(params: {
  ok: boolean
  output: unknown
  attempts: number
  error?: string
  timedOut?: boolean
  execution?: JournalAgentExecution
  gate?: WorkflowGateResult
}): AgentWithMetaResult {
  return {
    ok: params.ok,
    output: params.output,
    attempts: params.attempts,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.timedOut === true ? { timedOut: true } : {}),
    ...(params.execution !== undefined ? { execution: params.execution as AgentWithMetaResult['execution'] } : {}),
    ...(params.gate !== undefined ? { gate: params.gate } : {}),
  }
}

async function waitReadyGate(
  gate: Promise<void> | undefined,
  onEnter: () => void,
  onLeave: () => void,
): Promise<void> {
  if (gate === undefined) return
  onEnter()
  try {
    await gate
  } finally {
    onLeave()
  }
}

interface TimelineBuffer {
  emit: (entry: WorkflowProgressEntry) => void
  snapshot: () => WorkflowProgressEntry[]
}

function createTimelineBuffer(
  timelineCap: number,
  onEvent: RunWorkflowOptions['onEvent'],
): TimelineBuffer {
  const ring: Array<WorkflowProgressEntry | undefined> = []
  let head = 0
  let size = 0

  return {
    emit(entry) {
      if (size < timelineCap) {
        ring.push(entry)
        size++
      } else {
        ring[head] = entry
        head = (head + 1) % timelineCap
      }
      if (entry.kind === 'phase') {
        onEvent?.({ type: 'phase', index: entry.index, title: entry.title, at: entry.at })
      } else {
        onEvent?.({ type: 'log', message: entry.message, at: entry.at })
      }
    },
    snapshot() {
      if (size < timelineCap || head === 0) {
        return ring.slice(0, size) as WorkflowProgressEntry[]
      }
      return [
        ...(ring.slice(head) as WorkflowProgressEntry[]),
        ...(ring.slice(0, head) as WorkflowProgressEntry[]),
      ]
    },
  }
}

interface RuntimeSharedContext {
  options: RunWorkflowOptions
  host: RunWorkflowOptions['host']
  redactText: (text: string) => string
  semaphore: Semaphore
  replay: JournalReplay
  inPlaceResume: boolean
  retryFailedCalls: boolean
  appendJournal: NonNullable<RunWorkflowOptions['journal']>['append']
  agentCap: number
  actionCap: number
  nodesByIndex: Map<number, WorkflowNodeState>
  inflightAgents: Set<string>
  inflightActions: Set<Promise<void>>
  inflightActionWrites: Set<Promise<void>>
  completedByLabel: Map<string, CompletedChild>
  openLaunches: Map<number, string>
  pendingNativeReattaches: Set<string>
  isAborted: () => boolean
  isWorkerStopped: () => boolean
  isSettled: () => boolean
  isSuspended: () => boolean
  nextCallIndex: () => number
  agentCount: () => number
  incrementAgentCount: () => void
  actionCount: () => number
  incrementActionCount: () => void
  incrementReplayedCount: () => void
  emitNode: (index: number, node: WorkflowNodeState) => void
  recordAgentBestEffort: (entry: JournalWriteInput) => Promise<void>
  respond: (callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean) => void
  enterReadyGate: () => void
  leaveReadyGate: () => void
  enterNativeReattachSetup: () => void
  leaveNativeReattachSetup: () => void
  fireReattachHorizon: () => void
}

function resolveAgentCallConfig(
  ctx: RuntimeSharedContext,
  callId: number,
  payload: WorkerAgentCallPayload,
): ResolvedAgentCallConfig | undefined {
  let opts: ValidatedAgentCall
  try {
    opts = validateAgentCallOptions(payload.prompt, payload.opts, payload.goalMode === true)
  } catch (error) {
    if (error instanceof ScriptCallOptionError) {
      ctx.respond(callId, false, undefined, error.message, false)
      return undefined
    }
    ctx.respond(callId, false, undefined, errorMessageOf(error), true)
    return undefined
  }

  if (opts.gate !== undefined && ctx.host.runGate === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
    return undefined
  }
  if (opts.resume !== undefined && ctx.host.resumeAgent === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
    return undefined
  }

  const scope = readCallScope(payload)
  const workflowRootPath =
    typeof payload.workflowRootPath === 'string' && payload.workflowRootPath !== ''
      ? payload.workflowRootPath
      : 'root'

  let resumed: CompletedChild | undefined
  if (opts.resume !== undefined) {
    resumed = ctx.completedByLabel.get(scopedResumeKey(workflowRootPath, opts.resume))
    if (resumed === undefined) {
      const known = [...ctx.completedByLabel.values()]
        .filter((child) => child.workflowRootPath === workflowRootPath)
        .map((child) => child.label)
      ctx.respond(
        callId,
        false,
        undefined,
        `agent() opts.resume: no agent has completed under the label "${opts.resume}" in this run. ${
          known.length === 0 ? 'No agent has completed yet.' : `Known labels: ${known.map((l) => `"${l}"`).join(', ')}.`
        }`,
        true,
      )
      return undefined
    }
  }

  let compiledSchema: CompiledSchema | undefined
  if (opts.schema !== undefined) {
    const comp = compileJsonSchema(opts.schema)
    if (!comp.ok) {
      ctx.respond(callId, false, undefined, comp.message, true)
      return undefined
    }
    compiledSchema = comp.compiled
  }

  if (ctx.agentCount() >= ctx.agentCap) {
    ctx.respond(callId, false, undefined, `Workflow exceeded its cap of ${ctx.agentCap} agents.`, true)
    return undefined
  }

  const index = ctx.nextCallIndex()
  ctx.incrementAgentCount()
  const maxAttempts = opts.maxAttempts ?? 1
  const previousAttempts =
    ctx.retryFailedCalls && maxAttempts > 1 ? ctx.replay.terminalFailureAttempt(scope) : 0
  const attemptLimit = previousAttempts + maxAttempts
  const logicalId =
    scope.scopePath === 'root' ? String(scope.scopeCallIndex) : `${scope.scopePath}:${scope.scopeCallIndex}`
  const agentId = resumed?.agentId ?? `wf-agent-${logicalId}`
  const label = opts.label ?? resumed?.label ?? derivedLabel(opts.prompt)
  const agentType = resumed?.agentType ?? opts.agentType ?? 'assistant'
  const model = resumed !== undefined ? resumed.model : opts.model
  const isolation = resumed !== undefined ? resumed.isolation : opts.isolation
  const nodeId = resumed !== undefined ? undefined : opts.nodeId
  ctx.openLaunches.set(callId, label)

  const node: WorkflowNodeState = {
    id: `agent-${index}`,
    kind: 'agent',
    status: 'pending',
    label,
    agentType,
    prompt: opts.prompt,
    ...(model !== undefined ? { model } : {}),
    ...(compiledSchema !== undefined ? { schema: compiledSchema.schema } : {}),
    ...(payload.ambientPhaseIndex !== undefined ? { phaseIndex: payload.ambientPhaseIndex } : {}),
    ...(payload.ambientPhaseTitle !== undefined ? { phaseTitle: payload.ambientPhaseTitle } : {}),
    ...(opts.gate !== undefined ? { gateCommand: opts.gate } : {}),
  }
  ctx.emitNode(index, node)

  const keyInput: AgentJournalKeyInput = {
    prompt: opts.prompt,
    label: opts.label,
    model: opts.model,
    agentType: opts.agentType,
    effort: opts.effort,
    isolation: opts.isolation,
    gate: opts.gate,
    resume: opts.resume,
    attachments: opts.attachments,
    maxSubagentDepth: opts.maxSubagentDepth,
    cwd: opts.cwd,
    nodeId: opts.nodeId,
    schema: opts.schema,
  }

  return {
    opts,
    scope,
    workflowRootPath,
    compiledSchema,
    index,
    attemptLimit,
    agentId,
    label,
    agentType,
    model,
    isolation,
    nodeId,
    node,
    keyInput,
    resumed,
  }
}

async function replayFailedAttempts(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: (
    entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>,
  ) => Promise<void>,
): Promise<AgentReplayOutcome> {
  const { opts, scope, workflowRootPath, attemptLimit, agentId, label, agentType, model, isolation, node, keyInput } = cfg
  const maxAttempts = opts.maxAttempts ?? 1
  const resumeAgent = ctx.host.resumeAgent

  let attempt = 1
  let attemptIndex = cfg.index
  let attemptPrompt = opts.prompt
  let attemptKey = agentJournalKey(keyInput)
  let resumeTarget: CompletedChild | undefined = cfg.resumed
  let reattachEntry: StartedAgentEntry | undefined
  let replayedEntry: Extract<WorkflowJournalEntry, { type: 'agent' }> | undefined

  const firstStarted =
    ctx.inPlaceResume && ctx.replay.history(scope, 1) === undefined
      ? ctx.replay.startedAgent(scope, 1, attemptKey)
      : undefined
  if (firstStarted !== undefined) {
    reattachEntry = firstStarted
  } else {
    const res = ctx.replay.match(scope, attemptKey, 'agent', {
      attempt: 1,
      allowFailure: maxAttempts > 1,
      resumed: opts.resume !== undefined,
    })
    if (res.conflictError !== undefined) {
      ctx.respond(callId, false, undefined, res.conflictError, true)
      return {
        handled: true,
        attempt,
        attemptIndex,
        attemptPrompt,
        attemptKey,
        resumeTarget,
        reattachEntry,
        replayedEntry,
      }
    }
    if (res.hit && res.entry?.type === 'agent') replayedEntry = res.entry
  }

  while (replayedEntry !== undefined && !replayedEntry.ok) {
    const failed = replayedEntry
    const redactedError = ctx.redactText(failed.error ?? 'Agent failed.')
    if (failed.execution !== undefined) applyExecutionToNode(node, failed.execution)
    if (failed.gate !== undefined) node.gate = failed.gate
    node.attempt = attempt
    node.status = 'failed'
    node.cached = true
    node.error = redactedError
    ctx.incrementReplayedCount()
    if (!ctx.inPlaceResume) {
      const { type: _t, v: _v, seq: _s, scopePath: _sp, scopeCallIndex: _sc, ...rest } = failed
      await recordAttempt({ ...rest, error: redactedError, index: attemptIndex })
    }
    ctx.emitNode(cfg.index, node)

    const persistedHandle =
      failed.execution?.executionId ??
      (failed.execution?.conversationId !== undefined ? String(failed.execution.conversationId) : undefined)
    const canRetry = attempt < attemptLimit && persistedHandle !== undefined && resumeAgent !== undefined
    if (!canRetry) {
      if (ctx.replay.history(scope, attempt + 1) !== undefined) {
        const conflict = ctx.replay.miss(scope)
        if (conflict.conflictError !== undefined) {
          ctx.respond(callId, false, undefined, conflict.conflictError, true)
          return {
            handled: true,
            attempt,
            attemptIndex,
            attemptPrompt,
            attemptKey,
            resumeTarget,
            reattachEntry,
            replayedEntry,
          }
        }
      }
      if (persistedHandle !== undefined) {
        recordCompletedLabel(ctx.completedByLabel, {
          agentId,
          label,
          agentType,
          workflowRootPath,
          resumeRef: persistedHandle,
          ...(model !== undefined ? { model } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
        })
      }
      const metaRes = buildAgentWithMetaResult({
        ok: false,
        output: null,
        attempts: attempt,
        error: redactedError,
        timedOut: failed.timedOut === true,
        execution: failed.execution,
        gate: failed.gate,
      })
      ctx.respond(callId, true, payload.withMeta === true ? metaRes : null)
      return {
        handled: true,
        attempt,
        attemptIndex,
        attemptPrompt,
        attemptKey,
        resumeTarget,
        reattachEntry,
        replayedEntry,
      }
    }

    resumeTarget = {
      agentId,
      label,
      agentType,
      workflowRootPath,
      resumeRef: persistedHandle,
      ...(model !== undefined ? { model } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    }
    attemptPrompt = agentRetryPrompt(opts.prompt, attempt, redactedError)
    attempt++
    attemptIndex = ctx.nextCallIndex()
    attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
    const nextStarted =
      ctx.inPlaceResume && ctx.replay.history(scope, attempt) === undefined
        ? ctx.replay.startedAgent(scope, attempt, attemptKey)
        : undefined
    if (nextStarted !== undefined) {
      reattachEntry = nextStarted
      replayedEntry = undefined
      break
    }
    const next = ctx.replay.match(scope, attemptKey, 'agent', {
      attempt,
      allowFailure: true,
      resumed: true,
    })
    if (next.conflictError !== undefined) {
      ctx.respond(callId, false, undefined, next.conflictError, true)
      return {
        handled: true,
        attempt,
        attemptIndex,
        attemptPrompt,
        attemptKey,
        resumeTarget,
        reattachEntry,
        replayedEntry,
      }
    }
    replayedEntry = next.hit && next.entry?.type === 'agent' ? next.entry : undefined
  }

  return {
    handled: false,
    attempt,
    attemptIndex,
    attemptPrompt,
    attemptKey,
    resumeTarget,
    reattachEntry,
    replayedEntry,
  }
}

async function replayCachedSuccess(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  replayState: AgentReplayOutcome,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: (
    entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>,
  ) => Promise<void>,
): Promise<boolean> {
  let replayedEntry = replayState.replayedEntry
  if (replayedEntry !== undefined && replayedEntry.ok && cfg.compiledSchema !== undefined) {
    const recheck = applySchema({ ok: true, text: replayedEntry.text ?? '' }, cfg.compiledSchema)
    if (!recheck.ok) {
      replayedEntry = undefined
      const conflict = ctx.replay.miss(cfg.scope)
      if (conflict.conflictError !== undefined) {
        ctx.respond(callId, false, undefined, conflict.conflictError, true)
        return true
      }
    }
  }

  if (replayedEntry === undefined || !replayedEntry.ok) return false

  const { node, compiledSchema, agentId, label, agentType, workflowRootPath, model, isolation } = cfg
  if (replayedEntry.execution !== undefined) applyExecutionToNode(node, replayedEntry.execution)
  if (replayedEntry.gate !== undefined) node.gate = replayedEntry.gate
  node.prompt = replayedEntry.prompt ?? replayState.attemptPrompt
  node.attempt = replayedEntry.attempt ?? replayState.attempt
  node.status = 'done'
  node.cached = true
  const at = Date.now()
  node.startedAt = at
  node.settledAt = at
  node.durationMs = 0
  const replayedText = replayedEntry.text ?? ''
  const parsedOutput = parseStructuredOutput(replayedText, compiledSchema)
  if (compiledSchema !== undefined && parsedOutput !== null) node.output = parsedOutput
  ctx.incrementReplayedCount()

  const nativeResumeRef =
    replayedEntry.execution?.conversationId !== undefined && replayedEntry.execution.executionId === undefined
      ? String(replayedEntry.execution.conversationId)
      : undefined
  recordCompletedLabel(ctx.completedByLabel, {
    agentId,
    label,
    agentType,
    workflowRootPath,
    ...(model !== undefined ? { model } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(nativeResumeRef !== undefined ? { resumeRef: nativeResumeRef } : { replayed: true }),
  })
  ctx.emitNode(cfg.index, node)
  if (!ctx.inPlaceResume) {
    await recordAttempt({
      index: replayState.attemptIndex,
      key: replayedEntry.key,
      ok: true,
      text: replayedText,
      ...(replayedEntry.resumed === true ? { resumed: true } : {}),
      ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution } : {}),
      ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
      ...(replayedEntry.attempt !== undefined ? { attempt: replayedEntry.attempt } : {}),
      ...(replayedEntry.prompt !== undefined ? { prompt: replayedEntry.prompt } : {}),
    })
  }
  const metaRes = buildAgentWithMetaResult({
    ok: true,
    output: parsedOutput,
    attempts: replayedEntry.attempt ?? 1,
    execution: replayedEntry.execution,
    gate: replayedEntry.gate,
  })
  ctx.respond(callId, true, payload.withMeta === true ? metaRes : parsedOutput)
  return true
}

async function executeAndSettleAgent(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  initial: AgentReplayOutcome,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: (
    entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>,
  ) => Promise<void>,
): Promise<void> {
  const { opts, scope, compiledSchema, index, attemptLimit, agentId, label, agentType, model, isolation, nodeId, node, keyInput, workflowRootPath } = cfg
  if (cfg.resumed?.replayed === true) {
    ctx.respond(
      callId,
      false,
      undefined,
      `agent() opts.resume: "${opts.resume}" only exists as a replayed (cached) context with no live ` +
        'conversation in this run to continue; a replayed context cannot be resumed. Re-run the workflow without resumeFromRunId.',
      true,
    )
    return
  }
  const runGate = ctx.host.runGate?.bind(ctx.host)
  const resumeAgent = ctx.host.resumeAgent?.bind(ctx.host)

  let attempt = initial.attempt
  let attemptIndex = initial.attemptIndex
  let attemptPrompt = initial.attemptPrompt
  let attemptKey = initial.attemptKey
  let resumeTarget = initial.resumeTarget
  let reattachEntry = initial.reattachEntry

  for (;;) {
    const currentReattach = reattachEntry
    reattachEntry = undefined
    const coordKey = journalCoordKey(scope, attempt)
    const isNativeReattach =
      currentReattach !== undefined &&
      currentReattach.execution.conversationId !== undefined &&
      currentReattach.execution.executionId === undefined

    if (!isNativeReattach) {
      await waitReadyGate(ctx.options.runtimeReadyGate, ctx.enterReadyGate, ctx.leaveReadyGate)
    }
    if (ctx.isAborted() || ctx.isWorkerStopped()) {
      ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
      return
    }

    // In-flight native reattaches bypass Semaphore so startup recovery never deadlocks when active children >= concurrency.
    const acquiredPermit = !isNativeReattach
    if (acquiredPermit) await ctx.semaphore.acquire()
    if (ctx.isAborted() || ctx.isWorkerStopped()) {
      if (acquiredPermit) ctx.semaphore.release()
      ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
      return
    }

    const startedAt = Date.now()
    node.status = 'running'
    node.attempt = attempt
    node.prompt = attemptPrompt
    node.startedAt = startedAt
    delete node.cached
    delete node.error
    if (attempt > 1) delete node.gate
    ctx.emitNode(index, node)

    const spawnRequestId =
      currentReattach !== undefined
        ? currentReattach.requestId
        : ctx.options.runId !== undefined
          ? `helmx:spawn:${ctx.options.runId}:${scope.scopePath}:${scope.scopeCallIndex}:${attempt}`
          : undefined
    let pendingStartedWrite: Promise<void> | undefined
    let nativeReattachResolved = false
    if (isNativeReattach) ctx.enterNativeReattachSetup()
    const markNativeReattachResolved = (): void => {
      if (!isNativeReattach || nativeReattachResolved) return
      nativeReattachResolved = true
      ctx.leaveNativeReattachSetup()
      ctx.pendingNativeReattaches.delete(coordKey)
      if (ctx.pendingNativeReattaches.size === 0) ctx.fireReattachHorizon()
    }

    const onResolved = (info: AgentExecutionInfo): void => {
      applyExecutionToNode(node, info)
      markNativeReattachResolved()
      if (!ctx.inflightAgents.has(agentId)) return
      if (currentReattach === undefined && pendingStartedWrite === undefined && spawnRequestId !== undefined) {
        const snap = executionSnapshotOf(node)
        if (snap !== undefined) {
          pendingStartedWrite = ctx.recordAgentBestEffort({
            type: 'agent_started',
            ...scope,
            index: attemptIndex,
            key: attemptKey,
            attempt,
            requestId: spawnRequestId,
            execution: snap,
          })
        }
      }
      ctx.emitNode(index, node)
    }

    const onGateResult = (gateResult: WorkflowGateResult): void => {
      node.gate = gateResult
      if (!ctx.inflightAgents.has(agentId)) return
      ctx.emitNode(index, node)
    }

    ctx.inflightAgents.add(agentId)
    let result: WorkflowSpawnResult
    try {
      if (resumeTarget !== undefined && resumeAgent !== undefined && currentReattach === undefined) {
        result = await resumeAgent(resumeTarget.agentId, attemptPrompt, {
          ...(resumeTarget.resumeRef !== undefined ? { resumeRef: resumeTarget.resumeRef } : {}),
          ...(spawnRequestId !== undefined ? { requestId: spawnRequestId } : {}),
          ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
          ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
          ...(opts.gateTimeoutMs !== undefined ? { gateTimeoutMs: opts.gateTimeoutMs } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
          ...(opts.maxSubagentDepth !== undefined ? { maxSubagentDepth: opts.maxSubagentDepth } : {}),
          onResolved,
          ...(opts.gate !== undefined ? { onGateResult } : {}),
        })
      } else {
        const reattachConvId = currentReattach?.execution.conversationId
        const spawnReq: WorkflowSpawnRequest = {
          agentId,
          index: attemptIndex,
          prompt: attemptPrompt,
          label,
          agentType,
          ...(model !== undefined ? { model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(opts.maxSubagentDepth !== undefined ? { maxSubagentDepth: opts.maxSubagentDepth } : {}),
          ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
          ...(payload.ambientPhaseIndex !== undefined ? { phaseIndex: payload.ambientPhaseIndex } : {}),
          ...(payload.ambientPhaseTitle !== undefined ? { phaseTitle: payload.ambientPhaseTitle } : {}),
          ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
          ...(opts.gateTimeoutMs !== undefined ? { gateTimeoutMs: opts.gateTimeoutMs } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
          ...(reattachConvId === undefined && nodeId !== undefined ? { nodeId } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(spawnRequestId !== undefined ? { requestId: spawnRequestId } : {}),
          ...(reattachConvId !== undefined
            ? {
                reattach: {
                  conversationId: reattachConvId,
                  ...(currentReattach?.execution.effectiveCwd !== undefined
                    ? { effectiveCwd: currentReattach.execution.effectiveCwd }
                    : {}),
                },
              }
            : {}),
          onResolved,
          ...(opts.gate !== undefined ? { onGateResult } : {}),
        }
        result = await ctx.host.spawnAgent(spawnReq)
      }

      if (result.executionInfo !== undefined) applyExecutionToNode(node, result.executionInfo)
      if (result.gate !== undefined && node.gate === undefined) node.gate = result.gate
      if (result.ok) {
        recordCompletedLabel(ctx.completedByLabel, {
          agentId,
          label,
          agentType,
          workflowRootPath,
          ...(model !== undefined ? { model } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
        })
        if (compiledSchema !== undefined) result = applySchema(result, compiledSchema)
        if (result.ok && opts.gate !== undefined) {
          result = await applyGate(result, opts.gate, agentId, runGate, node.gate, opts.gateTimeoutMs, node.effectiveCwd)
          if (result.gate !== undefined) node.gate = result.gate
        }
      }
      if (node.gate?.timedOut === true) result = { ...result, timedOut: true }
    } catch (error) {
      result = { ok: false, error: ctx.redactText(errorMessageOf(error)) }
    } finally {
      markNativeReattachResolved()
      ctx.inflightAgents.delete(agentId)
      if (acquiredPermit) ctx.semaphore.release()
    }

    if (pendingStartedWrite !== undefined) await pendingStartedWrite
    if (ctx.isWorkerStopped() || ctx.isSuspended()) return

    const finishedAt = Date.now()
    node.settledAt = finishedAt
    node.durationMs = finishedAt - startedAt

    if (result.ok) {
      const text = result.text ?? ''
      const parsedOutput = parseStructuredOutput(text, compiledSchema)
      node.status = 'done'
      if (compiledSchema !== undefined && parsedOutput !== null) node.output = parsedOutput
      ctx.emitNode(index, node)

      const execution = executionSnapshotOf(node)
      await recordAttempt({
        index: attemptIndex,
        key: attemptKey,
        ok: true,
        text,
        ...(resumeTarget !== undefined ? { resumed: true } : {}),
        attempt,
        prompt: attemptPrompt,
        ...(execution !== undefined ? { execution } : {}),
        ...(node.gate !== undefined ? { gate: node.gate } : {}),
      })
      const metaRes = buildAgentWithMetaResult({
        ok: true,
        output: parsedOutput,
        attempts: attempt,
        execution,
        gate: node.gate,
      })
      ctx.respond(callId, true, payload.withMeta === true ? metaRes : parsedOutput)
      return
    }

    const resumeRef = node.executionId ?? (node.conversationId !== undefined ? String(node.conversationId) : undefined)
    const failureHandle: CompletedChild | undefined =
      resumeRef !== undefined
        ? {
            agentId,
            label,
            agentType,
            workflowRootPath,
            resumeRef,
            ...(model !== undefined ? { model } : {}),
            ...(isolation !== undefined ? { isolation } : {}),
          }
        : undefined
    if (failureHandle !== undefined) {
      recordCompletedLabel(ctx.completedByLabel, failureHandle)
    }

    const redactedErr = ctx.redactText(result.error ?? 'Agent failed.')
    const execution = executionSnapshotOf(node)
    if (failureHandle !== undefined && attempt < attemptLimit && resumeAgent !== undefined) {
      await recordAttempt({
        index: attemptIndex,
        key: attemptKey,
        ok: false,
        ...(resumeTarget !== undefined ? { resumed: true } : {}),
        attempt,
        prompt: attemptPrompt,
        error: redactedErr,
        ...(result.timedOut === true ? { timedOut: true } : {}),
        ...(execution !== undefined ? { execution } : {}),
        ...(node.gate !== undefined ? { gate: node.gate } : {}),
      })
      attemptPrompt = agentRetryPrompt(opts.prompt, attempt, redactedErr)
      attempt++
      resumeTarget = failureHandle
      attemptIndex = ctx.nextCallIndex()
      attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
      node.status = 'pending'
      node.attempt = attempt
      ctx.emitNode(index, node)
      continue
    }

    node.status = 'failed'
    node.error = redactedErr
    ctx.emitNode(index, node)
    await recordAttempt({
      index: attemptIndex,
      key: attemptKey,
      ok: false,
      ...(resumeTarget !== undefined ? { resumed: true } : {}),
      attempt,
      prompt: attemptPrompt,
      error: redactedErr,
      ...(result.timedOut === true ? { timedOut: true } : {}),
      ...(execution !== undefined ? { execution } : {}),
      ...(node.gate !== undefined ? { gate: node.gate } : {}),
    })
    const metaRes = buildAgentWithMetaResult({
      ok: false,
      output: null,
      attempts: attempt,
      error: redactedErr,
      timedOut: result.timedOut === true,
      execution,
      gate: node.gate,
    })
    ctx.respond(callId, true, payload.withMeta === true ? metaRes : null)
    return
  }
}

async function executeAndJournalAction(
  ctx: RuntimeSharedContext,
  params: {
    callId: number
    index: number
    scope: JournalScope
    key: string
    opts: ValidatedActionCall
    node: WorkflowNodeState
    recordAction: (entry: ActionJournalPayload) => Promise<void> | void
  },
): Promise<void> {
  const { callId, index, scope: _scope, key, opts, node, recordAction } = params
  await waitReadyGate(ctx.options.runtimeReadyGate, ctx.enterReadyGate, ctx.leaveReadyGate)
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
    return
  }

  await ctx.semaphore.acquire()
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    ctx.semaphore.release()
    ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
    return
  }

  try {
    let prepared: { pluginId: string; actionId: string; idempotent?: boolean } | undefined
    if (ctx.host.prepareAction !== undefined) {
      try {
        prepared = await ctx.host.prepareAction(opts.actionId, opts.input, {
          index,
          ...(ctx.options.signal !== undefined ? { signal: ctx.options.signal } : {}),
        })
      } catch (error) {
        if (ctx.isAborted() || ctx.isWorkerStopped()) {
          ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
          return
        }
        const errMsg = ctx.redactText(errorMessageOf(error))
        try {
          await recordAction({
            type: 'action',
            index,
            key,
            ok: false,
            idempotent: true,
            error: errMsg,
          })
        } catch (jErr) {
          ctx.respond(callId, false, undefined, `workflow_action_uncertain: ${errorMessageOf(jErr)}`, true)
          return
        }
        const at = Date.now()
        node.status = 'failed'
        node.startedAt = at
        node.settledAt = at
        node.durationMs = 0
        node.error = errMsg
        ctx.emitNode(index, node)
        ctx.respond(callId, true, null)
        return
      }
    }

    if (ctx.isAborted() || ctx.isWorkerStopped()) {
      ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
      return
    }

    const effectiveIdempotent = opts.idempotent ?? prepared?.idempotent === true
    const startedAt = Date.now()
    try {
      await recordAction({
        type: 'action_started',
        index,
        key,
        ...(effectiveIdempotent ? { idempotent: true } : {}),
      })
    } catch (error) {
      ctx.respond(callId, false, undefined, `workflow_action_uncertain: ${errorMessageOf(error)}`, true)
      return
    }
    if (ctx.isAborted() || ctx.isWorkerStopped()) return

    node.status = 'running'
    node.startedAt = startedAt
    ctx.emitNode(index, node)

    const runActionAndJournal = async (): Promise<void> => {
      let outcome: { ok: true; result: unknown } | { ok: false; error: string }
      try {
        const invoked = await ctx.host.invokeAction(opts.actionId, opts.input, {
          index,
          ...(ctx.options.signal !== undefined ? { signal: ctx.options.signal } : {}),
        })
        assertBoundarySafe(invoked.result, `action('${opts.actionId}') result`, false)
        outcome = { ok: true, result: invoked.result }
      } catch (error) {
        outcome = { ok: false, error: ctx.redactText(errorMessageOf(error)) }
      } finally {
        ctx.openLaunches.delete(callId)
      }

      // Even if suspend() stopped the worker while this action was executing,
      // if the action already succeeded, persist its terminal row so restart
      // never misclassifies it as dangling `workflow_action_uncertain`.
      if (ctx.isSettled() || (ctx.isSuspended() && !outcome.ok)) return

      const finishedAt = Date.now()
      const writeTerminal = (async () => {
        await recordAction(
          outcome.ok
            ? {
                type: 'action',
                index,
                key,
                ok: true,
                result: redactPlainValue(outcome.result, ctx.redactText),
                ...(effectiveIdempotent ? { idempotent: true } : {}),
              }
            : {
                type: 'action',
                index,
                key,
                ok: false,
                error: outcome.error,
                ...(effectiveIdempotent ? { idempotent: true } : {}),
              },
        )
      })()
      ctx.inflightActionWrites.add(writeTerminal)
      try {
        await writeTerminal
      } catch (error) {
        const msg = errorMessageOf(error)
        ctx.respond(
          callId,
          false,
          undefined,
          outcome.ok
            ? `workflow_action_uncertain: action executed but its outcome could not be journaled (${msg}). The side effect may have happened; do not re-run blindly.`
            : `workflow_action_uncertain: action failed and the failure could not be journaled (${msg}).`,
          true,
        )
        return
      } finally {
        ctx.inflightActionWrites.delete(writeTerminal)
      }

      node.settledAt = finishedAt
      node.durationMs = finishedAt - startedAt
      if (outcome.ok) {
        node.status = 'done'
        node.output = outcome.result
        ctx.emitNode(index, node)
        ctx.respond(callId, true, outcome.result)
      } else {
        node.status = 'failed'
        node.error = outcome.error
        ctx.emitNode(index, node)
        ctx.respond(callId, true, null)
      }
    }

    const actionTask = runActionAndJournal()
    ctx.inflightActions.add(actionTask)
    try {
      await actionTask
    } finally {
      ctx.inflightActions.delete(actionTask)
    }
  } finally {
    ctx.semaphore.release()
  }
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options
  const normalizedArgs = normalizeWorkflowArgs(options.args)
  assertBoundarySafe(normalizedArgs, 'args', true)

  const { meta, body } = validateScript(script)
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP
  const actionCap = options.actionCap ?? WORKFLOW_ACTION_CAP
  const timelineCap = Math.max(1, options.timelineCap ?? WORKFLOW_TIMELINE_CAP)
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP
  const semaphore = new Semaphore(options.concurrency ?? defaultWorkflowConcurrency())
  const redactText = options.redact ?? ((text: string) => text)

  const nodesByIndex = new Map<number, WorkflowNodeState>()
  const timeline = createTimelineBuffer(timelineCap, options.onEvent)
  const inflightAgents = new Set<string>()
  const inflightActions = new Set<Promise<void>>()
  const inflightActionWrites = new Set<Promise<void>>()
  const completedByLabel = new Map<string, CompletedChild>()
  const openLaunches = new Map<number, string>()
  const journalIoErrors: string[] = []

  let callIndex = 0
  let agentCount = 0
  let actionCount = 0
  let replayedCount = 0
  let aborted = false
  let workerStopped = false
  let settled = false

  const journalEntries: readonly WorkflowJournalEntry[] = options.journal?.entries ?? []
  const inPlaceResume = options.journal?.inPlaceResume === true
  const retryFailedCalls = options.journal?.retryFailedCalls === true
  const appendJournal = options.journal?.append
  const replay = new JournalReplay(journalEntries)
  const isSuspended = () => options.isSuspended?.() === true

  const pendingNativeReattaches = new Set<string>(
    inPlaceResume
      ? replay
          .unsettledStartedAgents()
          .filter((e) => e.execution.conversationId !== undefined && e.execution.executionId === undefined)
          .map((e) => journalCoordKey(e, e.attempt ?? 1))
      : [],
  )
  let horizonFired = false
  let activeNativeReattachSetups = 0
  let waitingOnReadyGate = 0
  const fireReattachHorizon = (): void => {
    if (horizonFired) return
    horizonFired = true
    options.onReattachHorizon?.()
  }
  const checkQuiescentHorizon = (): void => {
    if (horizonFired || activeNativeReattachSetups > 0) return
    setImmediate(() => {
      if (!horizonFired && activeNativeReattachSetups === 0 && waitingOnReadyGate > 0 && openLaunches.size === waitingOnReadyGate) {
        fireReattachHorizon()
      }
    })
  }
  if (pendingNativeReattaches.size === 0) fireReattachHorizon()

  const recordAgentBestEffort = async (entry: JournalWriteInput): Promise<void> => {
    if (appendJournal === undefined) return
    try {
      await appendJournal(entry)
    } catch (error) {
      journalIoErrors.push(redactText(`journal ${entry.type} write failed: ${errorMessageOf(error)}`))
    }
  }

  const emitNode = (index: number, node: WorkflowNodeState): void => {
    const snapshot = { ...node }
    nodesByIndex.set(index, snapshot)
    options.onEvent?.({ type: 'node', node: snapshot })
  }

  const orderedNodes = (): WorkflowNodeState[] =>
    [...nodesByIndex.entries()].sort(([a], [b]) => a - b).map(([, n]) => n)

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      argsJson: normalizedArgs === undefined ? undefined : JSON.stringify(normalizedArgs),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  })

  return await new Promise<WorkflowRunResult>((resolve) => {
    const respond = (callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void => {
      openLaunches.delete(callId)
      if (workerStopped) return
      const safeError = error === undefined ? undefined : redactText(error)
      if (fatal) {
        finish({ status: 'failed', error: safeError ?? 'Fatal workflow error.' })
        return
      }
      worker.postMessage({ type: 'response', callId, ok, value, error: safeError, fatal })
    }

    const finish = (
      result: Omit<WorkflowRunResult, 'meta' | 'nodes' | 'timeline' | 'agentCount' | 'replayedCount' | 'journalIoErrors'>,
    ): void => {
      if (workerStopped) return
      workerStopped = true
      fireReattachHorizon()
      options.signal?.removeEventListener('abort', onAbort)
      if (!isSuspended()) {
        for (const agentId of inflightAgents) host.abortAgent(agentId)
      }
      inflightAgents.clear()
      semaphore.drain()

      const finalizedResult =
        result.error !== undefined ? { ...result, error: redactText(result.error) } : result

      const finalize = async (): Promise<void> => {
        // Wait for any already-started actions during suspend() (or already-queued terminal writes)
        // before resolving and closing the journal writer (fixes suspend() dangling action_started).
        if (isSuspended() && inflightActions.size > 0) {
          await Promise.allSettled([...inflightActions])
        }
        if (inflightActionWrites.size > 0) {
          await Promise.allSettled([...inflightActionWrites])
        }
        settled = true
        await worker.terminate().catch(() => {})
        resolve({
          ...finalizedResult,
          meta,
          nodes: orderedNodes(),
          timeline: timeline.snapshot(),
          agentCount,
          replayedCount,
          ...(journalIoErrors.length > 0 ? { journalIoErrors: [...journalIoErrors] } : {}),
        })
      }
      void finalize()
    }

    function onAbort(): void {
      aborted = true
      finish({ status: 'killed', error: isSuspended() ? 'Workflow suspended.' : 'Workflow aborted.' })
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const runtimeCtx: RuntimeSharedContext = {
      options,
      host,
      redactText,
      semaphore,
      replay,
      inPlaceResume,
      retryFailedCalls,
      appendJournal,
      agentCap,
      actionCap,
      nodesByIndex,
      inflightAgents,
      inflightActions,
      inflightActionWrites,
      completedByLabel,
      openLaunches,
      pendingNativeReattaches,
      isAborted: () => aborted,
      isWorkerStopped: () => workerStopped,
      isSettled: () => settled,
      isSuspended,
      nextCallIndex: () => callIndex++,
      agentCount: () => agentCount,
      incrementAgentCount: () => {
        agentCount++
      },
      actionCount: () => actionCount,
      incrementActionCount: () => {
        actionCount++
      },
      incrementReplayedCount: () => {
        replayedCount++
      },
      emitNode,
      recordAgentBestEffort,
      respond,
      enterReadyGate: () => {
        waitingOnReadyGate++
        checkQuiescentHorizon()
      },
      leaveReadyGate: () => {
        waitingOnReadyGate--
      },
      enterNativeReattachSetup: () => {
        activeNativeReattachSetups++
      },
      leaveNativeReattachSetup: () => {
        activeNativeReattachSetups--
      },
      fireReattachHorizon,
    }

    const handleAgentCall = async (callId: number, payload: WorkerAgentCallPayload): Promise<void> => {
      const cfg = resolveAgentCallConfig(runtimeCtx, callId, payload)
      if (cfg === undefined) return
      const recordAttempt = (
        entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>,
      ) => recordAgentBestEffort({ type: 'agent', ...cfg.scope, ...entry })

      const replayOutcome = await replayFailedAttempts(runtimeCtx, cfg, callId, payload, recordAttempt)
      if (replayOutcome.handled) return
      if (await replayCachedSuccess(runtimeCtx, cfg, replayOutcome, callId, payload, recordAttempt)) return
      await executeAndSettleAgent(runtimeCtx, cfg, replayOutcome, callId, payload, recordAttempt)
    }

    const handleActionCall = async (callId: number, payload: WorkerActionCallPayload): Promise<void> => {
      let opts: ValidatedActionCall
      try {
        opts = validateActionCallOptions(payload.actionId, payload.input, payload.opts)
      } catch (error) {
        if (error instanceof ScriptCallOptionError) {
          respond(callId, false, undefined, error.message, false)
          return
        }
        respond(callId, false, undefined, errorMessageOf(error), true)
        return
      }

      const scope = readCallScope(payload)
      if (actionCount >= actionCap) {
        respond(callId, false, undefined, `Workflow exceeded its cap of ${actionCap} actions.`, true)
        return
      }
      const index = callIndex++
      actionCount++
      openLaunches.set(callId, opts.actionId)

      const node: WorkflowNodeState = {
        id: `action-${index}`,
        kind: 'action',
        status: 'pending',
        label: opts.label ?? opts.actionId,
        ...(payload.ambientPhaseIndex !== undefined ? { phaseIndex: payload.ambientPhaseIndex } : {}),
        ...(payload.ambientPhaseTitle !== undefined ? { phaseTitle: payload.ambientPhaseTitle } : {}),
      }
      emitNode(index, node)

      const recordAction = (entry: ActionJournalPayload) => appendJournal?.({ ...entry, ...scope })
      const key = actionJournalKey(opts.actionId, opts.input)
      const replayed = replay.match(scope, key, 'action')
      if (replayed.conflictError !== undefined) {
        respond(callId, false, undefined, replayed.conflictError, true)
        return
      }

      if (replayed.hit && replayed.entry?.type === 'action') {
        replayedCount++
        const at = Date.now()
        node.status = 'done'
        node.cached = true
        node.startedAt = at
        node.settledAt = at
        node.durationMs = 0
        if (replayed.entry.result !== undefined) node.output = replayed.entry.result
        emitNode(index, node)

        const effectiveIdempotent = opts.idempotent ?? replayed.entry.idempotent === true
        if (!inPlaceResume) {
          try {
            await recordAction({
              type: 'action',
              index,
              key,
              ok: true,
              result: redactPlainValue(replayed.entry.result, redactText),
              ...(effectiveIdempotent ? { idempotent: true } : {}),
            })
          } catch (error) {
            const msg = error instanceof JournalWriteError ? error.message : String(error)
            respond(callId, false, undefined, `workflow journal replay bookkeeping failed; aborting to keep the run resumable: ${msg}`, true)
            return
          }
        }
        replay.consumeAction(replayed.entry)
        respond(callId, true, replayed.entry.result ?? null)
        return
      }

      await executeAndJournalAction(runtimeCtx, { callId, index, scope, key, opts, node, recordAction })
    }

    const handleLoadWorkflow = async (callId: number, ref: WorkflowScriptRef): Promise<void> => {
      const loadWorkflow = host.loadWorkflow?.bind(host)
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run nested workflows.', true)
        return
      }
      let source
      try {
        source = await loadWorkflow(ref)
      } catch (error) {
        respond(callId, false, undefined, errorMessageOf(error), false)
        return
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message, false)
        return
      }
      try {
        const child = validateScript(source.script)
        respond(callId, true, { name: child.meta.name, body: child.body })
      } catch (error) {
        respond(callId, false, undefined, errorMessageOf(error), false)
      }
    }

    worker.on('message', (message: WorkerMessage) => {
      if (workerStopped) return
      switch (message.type) {
        case 'progress': {
          const now = Date.now()
          for (const entry of message.entries) {
            if (entry.type === 'workflow_phase') {
              timeline.emit({ at: now, kind: 'phase', index: entry.index, title: entry.title })
            } else {
              timeline.emit({ at: now, kind: 'log', message: entry.message })
            }
          }
          break
        }
        case 'call': {
          const run =
            message.method === 'workflow'
              ? handleLoadWorkflow(message.callId, message.payload)
              : message.method === 'action'
                ? handleActionCall(message.callId, message.payload)
                : handleAgentCall(message.callId, message.payload)
          void run.catch((error: unknown) => {
            finish({ status: 'failed', error: errorMessageOf(error) })
          })
          break
        }
        case 'complete': {
          const unawaited = [...openLaunches.values()]
          if (unawaited.length > 0) {
            finish({ status: 'failed', error: unawaitedLaunchMessage(unawaited) })
            break
          }
          finish({
            status: 'completed',
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          })
          break
        }
        case 'error':
          finish({ status: 'failed', error: message.message })
          break
      }
    })

    worker.on('error', (error) => {
      finish({ status: 'failed', error: errorMessageOf(error) })
    })

    worker.on('exit', () => {
      finish({ status: 'failed', error: 'Workflow worker exited before completing.' })
    })
  })
}
