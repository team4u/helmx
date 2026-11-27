/**
 * dsl/runtime.ts — Host-side entry of the deterministic workflow runner (`runWorkflow`): worker
 * lifecycle, abort/suspend settlement, the shared runtime context, and dispatch of worker calls to
 * the agent / action modules. Re-exports `Semaphore` for callers of the engine.
 *
 * The call pipeline lives in sibling modules: `agent-call-config.ts` (validation + identity),
 * `agent-replay.ts` (journal prefix replay), `agent-execute.ts` (live agent execution),
 * `action-execute.ts` (action execution + journaling); shared contract in `runtime-shared.ts`.
 */
import { Worker } from 'node:worker_threads'
import {
  assertBoundarySafe,
  normalizeWorkflowArgs,
  readCallScope,
  redactPlainValue,
  ScriptCallOptionError,
  unawaitedLaunchMessage,
  validateActionCallOptions,
  validateScript,
  WORKFLOW_ACTION_CAP,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  WORKFLOW_TIMELINE_CAP,
  defaultWorkflowConcurrency,
  type ValidatedActionCall,
} from './boundary.js'
import { JournalReplay, JournalWriteError, actionJournalKey, journalCoordKey } from './journal.js'
import { Semaphore } from './semaphore.js'
import { createTimelineBuffer } from './timeline-buffer.js'
import { executeAndJournalAction } from './action-execute.js'
import { executeAndSettleAgent } from './agent-execute.js'
import { resolveAgentCallConfig } from './agent-call-config.js'
import { replayCachedSuccess, replayFailedAttempts } from './agent-replay.js'
import {
  errorMessageOf,
  type ActionJournalPayload,
  type CompletedChild,
  type RecordAgentAttempt,
  type RuntimeSharedContext,
} from './runtime-shared.js'
import type { WorkflowNodeState } from '../../contracts.js'
import type {
  JournalWriteInput,
  RunWorkflowOptions,
  WorkerActionCallPayload,
  WorkerAgentCallPayload,
  WorkerMessage,
  WorkflowJournalEntry,
  WorkflowRunResult,
  WorkflowScriptRef,
} from './types.js'
import { WORKER_SOURCE } from './worker-source.js'

export { Semaphore }

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
      const recordAttempt: RecordAgentAttempt = (entry) => recordAgentBestEffort({ type: 'agent', ...cfg.scope, ...entry })

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
