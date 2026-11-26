/**
 * dsl/agent-execute.ts — Live execution and settlement of one `agent()` call: ready-gate + semaphore
 * admission (native reattaches bypass both), spawn / resume, schema and gate evaluation, the bounded
 * retry loop, and best-effort terminal journaling before the worker is answered.
 */
import type { AgentExecutionInfo } from '@helmx/protocol'
import { agentRetryPrompt, applyGate, applySchema, executionSnapshotOf } from './boundary.js'
import { agentJournalKey, journalCoordKey, type StartedAgentEntry } from './journal.js'
import {
  applyExecutionToNode,
  buildAgentWithMetaResult,
  completedChildOf,
  parseStructuredOutput,
  recordCompletedLabel,
} from './agent-node-state.js'
import type { ResolvedAgentCallConfig } from './agent-call-config.js'
import type { AgentReplayOutcome } from './agent-replay.js'
import {
  errorMessageOf,
  respondWorkflowAborted,
  waitReadyGate,
  type CompletedChild,
  type RecordAgentAttempt,
  type RuntimeSharedContext,
} from './runtime-shared.js'
import type {
  ResumeAgentOptions,
  WorkflowGateResult,
  WorkflowHost,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
  WorkerAgentCallPayload,
} from './types.js'

/** Mutable cursor of the retry loop: which attempt is live and how that attempt is journaled. */
interface AgentAttemptState {
  attempt: number
  /** Global call index of this attempt (the `index` of its journal rows). */
  index: number
  prompt: string
  key: string
  resumeTarget: CompletedChild | undefined
  /** Unsettled `agent_started` row of an in-place resume to reattach instead of spawning. */
  reattachEntry: StartedAgentEntry | undefined
}

interface AgentLaunchContext {
  callId: number
  payload: WorkerAgentCallPayload
  recordAttempt: RecordAgentAttempt
  currentReattach: StartedAgentEntry | undefined
  isNativeReattach: boolean
  /** Whether this attempt holds a Semaphore permit (released in the attempt's `finally`). */
  acquiredPermit: boolean
  /** Stable id so a Hub restart can reattach this exact attempt in place. */
  spawnRequestId: string | undefined
  runGate: WorkflowHost['runGate']
  resumeAgent: WorkflowHost['resumeAgent']
}

interface AgentLaunch {
  result: WorkflowSpawnResult
  /** Best-effort `agent_started` write kicked off from `onResolved`; awaited before terminal bookkeeping. */
  pendingStartedWrite: Promise<void> | undefined
}

interface AgentCallbacks {
  onResolved: (info: AgentExecutionInfo) => void
  onGateResult: (gateResult: WorkflowGateResult) => void
}

export async function executeAndSettleAgent(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  initial: AgentReplayOutcome,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: RecordAgentAttempt,
): Promise<void> {
  const { opts, node } = cfg
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
  const launchBase = {
    runGate: ctx.host.runGate?.bind(ctx.host),
    resumeAgent: ctx.host.resumeAgent?.bind(ctx.host),
  }
  const state: AgentAttemptState = {
    attempt: initial.attempt,
    index: initial.attemptIndex,
    prompt: initial.attemptPrompt,
    key: initial.attemptKey,
    resumeTarget: initial.resumeTarget,
    reattachEntry: initial.reattachEntry,
  }

  for (;;) {
    const currentReattach = state.reattachEntry
    state.reattachEntry = undefined
    const isNativeReattach = isNativeReattachOf(currentReattach)
    const acquiredPermit = await acquireAgentPermit(ctx, isNativeReattach)
    if (acquiredPermit === undefined) {
      respondWorkflowAborted(ctx, callId)
      return
    }

    const startedAt = markAttemptRunning(ctx, cfg, state)
    const launchContext: AgentLaunchContext = {
      callId,
      payload,
      recordAttempt,
      currentReattach,
      isNativeReattach,
      acquiredPermit,
      spawnRequestId: spawnRequestIdOf(ctx, cfg, state, currentReattach),
      ...launchBase,
    }
    const launch = await launchAgentAttempt(ctx, cfg, state, launchContext)
    if (launch.pendingStartedWrite !== undefined) await launch.pendingStartedWrite
    if (ctx.isWorkerStopped() || ctx.isSuspended()) return

    const finishedAt = Date.now()
    node.settledAt = finishedAt
    node.durationMs = finishedAt - startedAt

    if (launch.result.ok) {
      await settleAgentSuccess(ctx, cfg, state, launchContext, launch.result)
      return
    }
    const retry = await settleAgentFailure(ctx, cfg, state, launchContext, launch.result)
    if (!retry) return
  }
}

/** Native reattach = an unsettled `agent_started` row holding a persisted conversation but no external execution. */
function isNativeReattachOf(entry: StartedAgentEntry | undefined): boolean {
  return entry !== undefined && entry.execution.conversationId !== undefined && entry.execution.executionId === undefined
}

/**
 * Ready-gate + Semaphore admission. Native reattaches bypass both so startup recovery never deadlocks
 * when active children >= concurrency. Returns whether a permit is held, or `undefined` when the run
 * was aborted/stopped meanwhile (a held permit is released first).
 */
async function acquireAgentPermit(ctx: RuntimeSharedContext, isNativeReattach: boolean): Promise<boolean | undefined> {
  if (!isNativeReattach) await waitReadyGate(ctx.options.runtimeReadyGate, ctx.enterReadyGate, ctx.leaveReadyGate)
  if (ctx.isAborted() || ctx.isWorkerStopped()) return undefined
  const acquiredPermit = !isNativeReattach
  if (acquiredPermit) await ctx.semaphore.acquire()
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    if (acquiredPermit) ctx.semaphore.release()
    return undefined
  }
  return acquiredPermit
}

function spawnRequestIdOf(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  currentReattach: StartedAgentEntry | undefined,
): string | undefined {
  if (currentReattach !== undefined) return currentReattach.requestId
  if (ctx.options.runId === undefined) return undefined
  return `helmx:spawn:${ctx.options.runId}:${cfg.scope.scopePath}:${cfg.scope.scopeCallIndex}:${state.attempt}`
}

/** Flips the node to `running` for the current attempt; a retry drops the previous attempt's gate. */
function markAttemptRunning(ctx: RuntimeSharedContext, cfg: ResolvedAgentCallConfig, state: AgentAttemptState): number {
  const { node } = cfg
  const startedAt = Date.now()
  node.status = 'running'
  node.attempt = state.attempt
  node.prompt = state.prompt
  node.startedAt = startedAt
  delete node.cached
  delete node.error
  if (state.attempt > 1) delete node.gate
  ctx.emitNode(cfg.index, node)
  return startedAt
}

/**
 * Runs one attempt to completion (resume or spawn, then schema + gate enforcement) while holding the
 * permit; the attempt's own exceptions become a failed result so the caller always settles it.
 */
async function launchAgentAttempt(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  launch: AgentLaunchContext,
): Promise<AgentLaunch> {
  const { node, agentId, scope } = cfg
  const { currentReattach, isNativeReattach, acquiredPermit } = launch
  let pendingStartedWrite: Promise<void> | undefined
  let nativeReattachResolved = false
  const coordKey = journalCoordKey(scope, state.attempt)
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
    if (currentReattach === undefined && pendingStartedWrite === undefined && launch.spawnRequestId !== undefined) {
      const snap = executionSnapshotOf(node)
      if (snap !== undefined) {
        pendingStartedWrite = ctx.recordAgentBestEffort({
          type: 'agent_started',
          ...scope,
          index: state.index,
          key: state.key,
          attempt: state.attempt,
          requestId: launch.spawnRequestId,
          execution: snap,
        })
      }
    }
    ctx.emitNode(cfg.index, node)
  }

  const onGateResult = (gateResult: WorkflowGateResult): void => {
    node.gate = gateResult
    if (!ctx.inflightAgents.has(agentId)) return
    ctx.emitNode(cfg.index, node)
  }

  ctx.inflightAgents.add(agentId)
  try {
    let result = await spawnOrResumeAgent(ctx, cfg, state, launch, { onResolved, onGateResult })
    if (result.executionInfo !== undefined) applyExecutionToNode(node, result.executionInfo)
    if (result.gate !== undefined && node.gate === undefined) node.gate = result.gate
    result = await enforceSchemaAndGate(ctx, cfg, result, launch.runGate)
    if (node.gate?.timedOut === true) result = { ...result, timedOut: true }
    return { result, pendingStartedWrite }
  } catch (error) {
    return { result: { ok: false, error: ctx.redactText(errorMessageOf(error)) }, pendingStartedWrite }
  } finally {
    markNativeReattachResolved()
    ctx.inflightAgents.delete(agentId)
    if (acquiredPermit) ctx.semaphore.release()
  }
}

async function spawnOrResumeAgent(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  launch: AgentLaunchContext,
  callbacks: AgentCallbacks,
): Promise<WorkflowSpawnResult> {
  if (state.resumeTarget !== undefined && launch.resumeAgent !== undefined && launch.currentReattach === undefined) {
    return launch.resumeAgent(
      state.resumeTarget.agentId,
      state.prompt,
      resumeAgentOptionsOf(cfg, state.resumeTarget, launch.spawnRequestId, callbacks),
    )
  }
  return ctx.host.spawnAgent(spawnRequestOf(cfg, state, launch, callbacks))
}

function resumeAgentOptionsOf(
  cfg: ResolvedAgentCallConfig,
  resumeTarget: CompletedChild,
  spawnRequestId: string | undefined,
  callbacks: AgentCallbacks,
): ResumeAgentOptions {
  const { opts, compiledSchema } = cfg
  return {
    ...(resumeTarget.resumeRef !== undefined ? { resumeRef: resumeTarget.resumeRef } : {}),
    ...(spawnRequestId !== undefined ? { requestId: spawnRequestId } : {}),
    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
    ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
    ...(opts.gateTimeoutMs !== undefined ? { gateTimeoutMs: opts.gateTimeoutMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
    ...(opts.maxSubagentDepth !== undefined ? { maxSubagentDepth: opts.maxSubagentDepth } : {}),
    onResolved: callbacks.onResolved,
    ...(opts.gate !== undefined ? { onGateResult: callbacks.onGateResult } : {}),
  }
}

/** Fresh spawn request; an in-place reattach targets the persisted conversation (and its effective cwd). */
function spawnRequestOf(
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  launch: AgentLaunchContext,
  callbacks: AgentCallbacks,
): WorkflowSpawnRequest {
  const { opts, agentId, label, agentType, model, isolation, nodeId, compiledSchema } = cfg
  const { payload, currentReattach } = launch
  const reattachConvId = currentReattach?.execution.conversationId
  return {
    agentId,
    index: state.index,
    prompt: state.prompt,
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
    ...(launch.spawnRequestId !== undefined ? { requestId: launch.spawnRequestId } : {}),
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
    onResolved: callbacks.onResolved,
    ...(opts.gate !== undefined ? { onGateResult: callbacks.onGateResult } : {}),
  }
}

/** On success: register the resume label, then enforce the schema and the gate (only if none was reported). */
async function enforceSchemaAndGate(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  result: WorkflowSpawnResult,
  runGate: WorkflowHost['runGate'],
): Promise<WorkflowSpawnResult> {
  if (!result.ok) return result
  recordCompletedLabel(ctx.completedByLabel, completedChildOf(cfg))
  if (cfg.compiledSchema !== undefined) result = applySchema(result, cfg.compiledSchema)
  if (result.ok && cfg.opts.gate !== undefined) {
    result = await applyGate({
      result,
      command: cfg.opts.gate,
      agentId: cfg.agentId,
      runGate,
      reported: cfg.node.gate,
      gateTimeoutMs: cfg.opts.gateTimeoutMs,
      effectiveCwd: cfg.node.effectiveCwd,
    })
    if (result.gate !== undefined) cfg.node.gate = result.gate
  }
  return result
}

async function settleAgentSuccess(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  launch: AgentLaunchContext,
  result: WorkflowSpawnResult,
): Promise<void> {
  const { compiledSchema, index, node } = cfg
  const { callId, payload } = launch
  const text = result.text ?? ''
  const parsedOutput = parseStructuredOutput(text, compiledSchema)
  node.status = 'done'
  if (compiledSchema !== undefined && parsedOutput !== null) node.output = parsedOutput
  ctx.emitNode(index, node)

  const execution = executionSnapshotOf(node)
  await launch.recordAttempt({
    index: state.index,
    key: state.key,
    ok: true,
    text,
    ...(state.resumeTarget !== undefined ? { resumed: true } : {}),
    attempt: state.attempt,
    prompt: state.prompt,
    ...(execution !== undefined ? { execution } : {}),
    ...(node.gate !== undefined ? { gate: node.gate } : {}),
  })
  const metaRes = buildAgentWithMetaResult({ ok: true, output: parsedOutput, attempts: state.attempt, execution, gate: node.gate })
  ctx.respond(callId, true, payload.withMeta === true ? metaRes : parsedOutput)
}

/**
 * Journals the failed attempt, then either advances the cursor to a retry (returns `true`) or settles
 * the call as failed. Retries need a persisted handle, remaining budget, and a host that can resume.
 */
async function settleAgentFailure(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  state: AgentAttemptState,
  launch: AgentLaunchContext,
  result: WorkflowSpawnResult,
): Promise<boolean> {
  const { opts, node, keyInput, agentId, index, attemptLimit } = cfg
  const { callId, payload, recordAttempt, resumeAgent } = launch
  const resumeRef = node.executionId ?? (node.conversationId !== undefined ? String(node.conversationId) : undefined)
  const failureHandle = resumeRef !== undefined ? completedChildOf(cfg, { resumeRef }) : undefined
  if (failureHandle !== undefined) recordCompletedLabel(ctx.completedByLabel, failureHandle)

  const redactedErr = ctx.redactText(result.error ?? 'Agent failed.')
  const execution = executionSnapshotOf(node)
  const failedAttempt = {
    index: state.index,
    key: state.key,
    ok: false as const,
    ...(state.resumeTarget !== undefined ? { resumed: true as const } : {}),
    attempt: state.attempt,
    prompt: state.prompt,
    error: redactedErr,
    ...(result.timedOut === true ? { timedOut: true } : {}),
    ...(execution !== undefined ? { execution } : {}),
    ...(node.gate !== undefined ? { gate: node.gate } : {}),
  }

  if (failureHandle !== undefined && state.attempt < attemptLimit && resumeAgent !== undefined) {
    await recordAttempt(failedAttempt)
    state.prompt = agentRetryPrompt(opts.prompt, state.attempt, redactedErr)
    state.attempt++
    state.resumeTarget = failureHandle
    state.index = ctx.nextCallIndex()
    state.key = agentJournalKey({ ...keyInput, prompt: state.prompt, resume: agentId })
    node.status = 'pending'
    node.attempt = state.attempt
    ctx.emitNode(index, node)
    return true
  }

  node.status = 'failed'
  node.error = redactedErr
  ctx.emitNode(index, node)
  await recordAttempt(failedAttempt)
  const metaRes = buildAgentWithMetaResult({
    ok: false,
    output: null,
    attempts: state.attempt,
    error: redactedErr,
    timedOut: result.timedOut === true,
    execution,
    gate: node.gate,
  })
  ctx.respond(callId, true, payload.withMeta === true ? metaRes : null)
  return false
}
