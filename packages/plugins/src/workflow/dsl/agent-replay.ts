/**
 * dsl/agent-replay.ts — Journal prefix replay for `agent()` calls. Failed attempts are re-registered
 * along the `attempt` chain (fresh retry budget is granted only when the original run failed on this
 * call); a cached success then short-circuits live execution. Both paths keep the terminal rows of the
 * new run in sync with the replayed history unless resuming in place.
 */
import type { WorkflowJournalEntry } from './types.js'
import { agentJournalKey, type StartedAgentEntry } from './journal.js'
import { agentRetryPrompt, applySchema } from './boundary.js'
import type { ResolvedAgentCallConfig } from './agent-call-config.js'
import {
  applyExecutionToNode,
  buildAgentWithMetaResult,
  parseStructuredOutput,
  recordCompletedLabel,
} from './agent-node-state.js'
import type { CompletedChild, RecordAgentAttempt, RuntimeSharedContext } from './runtime-shared.js'
import type { WorkerAgentCallPayload } from './types.js'

export interface AgentReplayOutcome {
  handled: boolean
  attempt: number
  attemptIndex: number
  attemptPrompt: string
  attemptKey: string
  resumeTarget: CompletedChild | undefined
  reattachEntry: StartedAgentEntry | undefined
  replayedEntry: Extract<WorkflowJournalEntry, { type: 'agent' }> | undefined
}

export async function replayFailedAttempts(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: RecordAgentAttempt,
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

export async function replayCachedSuccess(
  ctx: RuntimeSharedContext,
  cfg: ResolvedAgentCallConfig,
  replayState: AgentReplayOutcome,
  callId: number,
  payload: WorkerAgentCallPayload,
  recordAttempt: RecordAgentAttempt,
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
