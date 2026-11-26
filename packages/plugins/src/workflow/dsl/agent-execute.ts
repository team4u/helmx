/**
 * dsl/agent-execute.ts — Live execution and settlement of one `agent()` call: ready-gate + semaphore
 * admission (native reattaches bypass both), spawn / resume, schema and gate evaluation, the bounded
 * retry loop, and best-effort terminal journaling before the worker is answered.
 */
import type { AgentExecutionInfo } from '@helmx/protocol'
import { agentRetryPrompt, applyGate, applySchema, executionSnapshotOf } from './boundary.js'
import { agentJournalKey, journalCoordKey } from './journal.js'
import {
  applyExecutionToNode,
  buildAgentWithMetaResult,
  parseStructuredOutput,
  recordCompletedLabel,
} from './agent-node-state.js'
import type { ResolvedAgentCallConfig } from './agent-call-config.js'
import type { AgentReplayOutcome } from './agent-replay.js'
import {
  errorMessageOf,
  waitReadyGate,
  type CompletedChild,
  type RecordAgentAttempt,
  type RuntimeSharedContext,
} from './runtime-shared.js'
import type {
  WorkflowGateResult,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
  WorkerAgentCallPayload,
} from './types.js'

export async function executeAndSettleAgent(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  initial: AgentReplayOutcome,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: RecordAgentAttempt,
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
