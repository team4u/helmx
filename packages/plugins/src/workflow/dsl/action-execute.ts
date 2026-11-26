/**
 * dsl/action-execute.ts — Action execution under strong journal consistency: `action_started` intent
 * is journaled before the handler runs, the terminal row is journaled before the call resolves, and any
 * journal write failure is fatal (`workflow_action_uncertain`) rather than silently tolerated.
 */
import type { WorkflowNodeState } from '../../contracts.js'
import { assertBoundarySafe, redactPlainValue, type ValidatedActionCall } from './boundary.js'
import {
  errorMessageOf,
  respondWorkflowAborted,
  waitReadyGate,
  type ActionJournalPayload,
  type RuntimeSharedContext,
} from './runtime-shared.js'
import type { JournalScope } from './types.js'

export interface ActionCallParams {
  callId: number
  index: number
  scope: JournalScope
  key: string
  opts: ValidatedActionCall
  node: WorkflowNodeState
  recordAction: (entry: ActionJournalPayload) => Promise<void> | void
}

type ActionOutcome = { ok: true; result: unknown } | { ok: false; error: string }

/** What `action_started` journaled for this call: the idempotency in force and when execution began. */
interface ActionStart {
  effectiveIdempotent: boolean
  startedAt: number
}

export async function executeAndJournalAction(ctx: RuntimeSharedContext, params: ActionCallParams): Promise<void> {
  if (!(await acquireActionPermit(ctx, params.callId))) return
  try {
    const start = await startAction(ctx, params)
    // `startAction` has already answered the worker (abort / pre-flight failure / uncertain journal).
    if (start === undefined) return
    await runActionToTerminal(ctx, params, start)
  } finally {
    ctx.semaphore.release()
  }
}

/** Ready-gate + Semaphore admission; answers the worker with a fatal abort (releasing the permit) when the run stopped. */
async function acquireActionPermit(ctx: RuntimeSharedContext, callId: number): Promise<boolean> {
  await waitReadyGate(ctx.options.runtimeReadyGate, ctx.enterReadyGate, ctx.leaveReadyGate)
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    respondWorkflowAborted(ctx, callId)
    return false
  }
  await ctx.semaphore.acquire()
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    ctx.semaphore.release()
    respondWorkflowAborted(ctx, callId)
    return false
  }
  return true
}

/**
 * Pre-flight (resolve + validate the call on the host) followed by the `action_started` intent row.
 * Both happen before the handler so a pre-flight failure leaves zero side effects and only an
 * idempotent failure row; a failed `action_started` write is fatal.
 */
async function startAction(ctx: RuntimeSharedContext, params: ActionCallParams): Promise<ActionStart | undefined> {
  const { callId, index, key, opts } = params
  let prepared: { pluginId: string; actionId: string; idempotent?: boolean } | undefined
  if (ctx.host.prepareAction !== undefined) {
    try {
      prepared = await ctx.host.prepareAction(opts.actionId, opts.input, hostActionContext(ctx, index))
    } catch (error) {
      await failActionPreflight(ctx, params, error)
      return undefined
    }
  }
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    respondWorkflowAborted(ctx, callId)
    return undefined
  }

  const effectiveIdempotent = opts.idempotent ?? prepared?.idempotent === true
  const startedAt = Date.now()
  try {
    await params.recordAction({
      type: 'action_started',
      index,
      key,
      ...(effectiveIdempotent ? { idempotent: true } : {}),
    })
  } catch (error) {
    ctx.respond(callId, false, undefined, `workflow_action_uncertain: ${errorMessageOf(error)}`, true)
    return undefined
  }
  return { effectiveIdempotent, startedAt }
}

/**
 * Pre-flight failed: the handler never ran, so record an idempotent failure row (keeps the run
 * resumable) and fail the node. Only a failed journal write escalates to `workflow_action_uncertain`.
 */
async function failActionPreflight(ctx: RuntimeSharedContext, params: ActionCallParams, error: unknown): Promise<void> {
  const { callId, index, key, node } = params
  if (ctx.isAborted() || ctx.isWorkerStopped()) {
    respondWorkflowAborted(ctx, callId)
    return
  }
  const errMsg = ctx.redactText(errorMessageOf(error))
  try {
    await params.recordAction({ type: 'action', index, key, ok: false, idempotent: true, error: errMsg })
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
}

async function runActionToTerminal(ctx: RuntimeSharedContext, params: ActionCallParams, start: ActionStart): Promise<void> {
  const { index, node } = params
  if (ctx.isAborted() || ctx.isWorkerStopped()) return
  node.status = 'running'
  node.startedAt = start.startedAt
  ctx.emitNode(index, node)

  // Tracked so suspend()/close() can drain an executing handler and its terminal write before the journal closes.
  const actionTask = invokeAndJournalAction(ctx, params, start)
  ctx.inflightActions.add(actionTask)
  try {
    await actionTask
  } finally {
    ctx.inflightActions.delete(actionTask)
  }
}

async function invokeAndJournalAction(ctx: RuntimeSharedContext, params: ActionCallParams, start: ActionStart): Promise<void> {
  const { callId, index, key, node, recordAction } = params
  const { effectiveIdempotent, startedAt } = start
  const outcome = await invokeActionSafely(ctx, params)
  // Even if suspend() stopped the worker while this action was executing, if the action already succeeded,
  // persist its terminal row so restart never misclassifies it as dangling `workflow_action_uncertain`.
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
  node.status = outcome.ok ? 'done' : 'failed'
  if (outcome.ok) node.output = outcome.result
  else node.error = outcome.error
  ctx.emitNode(index, node)
  ctx.respond(callId, true, outcome.ok ? outcome.result : null)
}

/** Runs the handler (boundary-checked); a thrown handler becomes a failed outcome, never an exception. */
async function invokeActionSafely(ctx: RuntimeSharedContext, params: ActionCallParams): Promise<ActionOutcome> {
  const { callId, index, opts } = params
  try {
    const invoked = await ctx.host.invokeAction(opts.actionId, opts.input, hostActionContext(ctx, index))
    assertBoundarySafe(invoked.result, `action('${opts.actionId}') result`, false)
    return { ok: true, result: invoked.result }
  } catch (error) {
    return { ok: false, error: ctx.redactText(errorMessageOf(error)) }
  } finally {
    ctx.openLaunches.delete(callId)
  }
}

function hostActionContext(ctx: RuntimeSharedContext, index: number): { index: number; signal?: AbortSignal } {
  const signal = ctx.options.signal
  return { index, ...(signal !== undefined ? { signal } : {}) }
}
