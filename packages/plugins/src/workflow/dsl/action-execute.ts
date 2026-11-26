/**
 * dsl/action-execute.ts — Action execution under strong journal consistency: `action_started` intent
 * is journaled before the handler runs, the terminal row is journaled before the call resolves, and any
 * journal write failure is fatal (`workflow_action_uncertain`) rather than silently tolerated.
 */
import type { WorkflowNodeState } from '../../contracts.js'
import { assertBoundarySafe, redactPlainValue, type ValidatedActionCall } from './boundary.js'
import { errorMessageOf, waitReadyGate, type ActionJournalPayload, type RuntimeSharedContext } from './runtime-shared.js'
import type { JournalScope } from './types.js'

export async function executeAndJournalAction(
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
