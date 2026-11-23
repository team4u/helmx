/**
 * dsl/runtime.ts — Host side of the deterministic workflow runner.
 *
 * Replaces 7 legacy files (~2,000L: runtime, runtime-agent-handler, runtime-agent-replay,
 * runtime-action-handler, runtime-control, runtime-recorder, progress) with one cohesive,
 * bug-free linear state machine:
 * - Single-source option validation via `boundary.ts`;
 * - Coordinate identity collapsed to `(scopePath, scopeCallIndex, attempt)` (no scopeId/invocationIndex);
 * - Fixes `resumeAgent` missing `requestId`, `agent.withMeta({ schema })` unparsed JSON output,
 *   `suspend()` dropping completed `action()` terminal journal rows, and Semaphore startup deadlock;
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
  validateActionCallOptions,
  validateAgentCallOptions,
  validateScript,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
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
    while (this.waiters.length > 0) this.waiters.shift()!()
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

function parseStructuredOutput(text: string, compiled: CompiledSchema | undefined): unknown {
  if (compiled === undefined) return text
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options
  const normalizedArgs = normalizeWorkflowArgs(options.args)
  assertBoundarySafe(normalizedArgs, 'args', true)

  const { meta, body } = validateScript(script)
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP
  const semaphore = new Semaphore(options.concurrency ?? defaultWorkflowConcurrency())
  const redactText = options.redact ?? ((text: string) => text)

  const nodesByIndex = new Map<number, WorkflowNodeState>()
  const timeline: WorkflowProgressEntry[] = []
  const inflightAgents = new Set<string>()
  const inflightActions = new Set<Promise<void>>()
  const inflightActionWrites = new Set<Promise<void>>()
  const completedByLabel = new Map<string, CompletedChild>()
  const openLaunches = new Map<number, string>()
  const journalIoErrors: string[] = []

  let callIndex = 0
  let agentCount = 0
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

  // Startup native reattach horizon: resolves once every unsettled native `agent_started` entry
  // has registered its structuredOutputSessions via `onResolved` (or worker settles / blocks at gate).
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
      const message = error instanceof Error ? error.message : String(error)
      journalIoErrors.push(redactText(`journal ${entry.type} write failed: ${message}`))
    }
  }

  const emitNode = (index: number, node: WorkflowNodeState): void => {
    const snapshot = { ...node }
    nodesByIndex.set(index, snapshot)
    options.onEvent?.({ type: 'node', node: snapshot })
  }

  const emitTimeline = (entry: WorkflowProgressEntry): void => {
    timeline.push(entry)
    if (entry.kind === 'phase') {
      options.onEvent?.({ type: 'phase', index: entry.index, title: entry.title, at: entry.at })
    } else {
      options.onEvent?.({ type: 'log', message: entry.message, at: entry.at })
    }
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
      if (fatal) {
        finish({ status: 'failed', error: error ?? 'Fatal workflow error.' })
        return
      }
      worker.postMessage({ type: 'response', callId, ok, value, error, fatal })
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
          ...result,
          meta,
          nodes: orderedNodes(),
          timeline: [...timeline],
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

    const applyExecutionToNode = (node: WorkflowNodeState, info: AgentExecutionInfo | JournalAgentExecution): void => {
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

    const handleAgentCall = async (callId: number, payload: WorkerAgentCallPayload): Promise<void> => {
      let opts
      try {
        opts = validateAgentCallOptions(payload.prompt, payload.opts, payload.goalMode === true)
      } catch (error) {
        if (error instanceof ScriptCallOptionError) {
          respond(callId, false, undefined, error.message, false)
          return
        }
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error), true)
        return
      }

      const runGate = host.runGate?.bind(host)
      const resumeAgent = host.resumeAgent?.bind(host)
      if (opts.gate !== undefined && runGate === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
        return
      }
      if (opts.resume !== undefined && resumeAgent === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
        return
      }

      const scope = readCallScope(payload)
      const workflowRootPath =
        typeof payload.workflowRootPath === 'string' && payload.workflowRootPath !== ''
          ? payload.workflowRootPath
          : 'root'

      let resumed: CompletedChild | undefined
      if (opts.resume !== undefined) {
        resumed = completedByLabel.get(scopedResumeKey(workflowRootPath, opts.resume))
        if (resumed === undefined) {
          const known = [...completedByLabel.values()]
            .filter((child) => child.workflowRootPath === workflowRootPath)
            .map((child) => child.label)
          respond(
            callId,
            false,
            undefined,
            `agent() opts.resume: no agent has completed under the label "${opts.resume}" in this run. ${
              known.length === 0 ? 'No agent has completed yet.' : `Known labels: ${known.map((l) => `"${l}"`).join(', ')}.`
            }`,
            true,
          )
          return
        }
      }

      let compiledSchema: CompiledSchema | undefined
      if (opts.schema !== undefined) {
        const comp = compileJsonSchema(opts.schema)
        if (!comp.ok) {
          respond(callId, false, undefined, comp.message, true)
          return
        }
        compiledSchema = comp.compiled
      }

      if (agentCount >= agentCap) {
        respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true)
        return
      }

      const index = callIndex++
      agentCount++
      const maxAttempts = opts.maxAttempts ?? 1
      const previousAttempts = retryFailedCalls && maxAttempts > 1 ? replay.terminalFailureAttempt(scope) : 0
      const attemptLimit = previousAttempts + maxAttempts
      const logicalId = scope.scopePath === 'root' ? String(scope.scopeCallIndex) : `${scope.scopePath}:${scope.scopeCallIndex}`
      const agentId = resumed?.agentId ?? `wf-agent-${logicalId}`
      const label = opts.label ?? resumed?.label ?? derivedLabel(opts.prompt)
      const agentType = resumed?.agentType ?? opts.agentType ?? 'assistant'
      const model = resumed !== undefined ? resumed.model : opts.model
      const isolation = resumed !== undefined ? resumed.isolation : opts.isolation
      const nodeId = resumed !== undefined ? undefined : opts.nodeId
      openLaunches.set(callId, label)

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
      emitNode(index, node)

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

      const recordAttempt = (entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>) =>
        recordAgentBestEffort({ type: 'agent', ...scope, ...entry })

      // ---- Prefix replay & failed-attempt chain ----
      let attempt = 1
      let attemptIndex = index
      let attemptPrompt = opts.prompt
      let attemptKey = agentJournalKey(keyInput)
      let resumeTarget: CompletedChild | undefined = resumed
      let reattachEntry: StartedAgentEntry | undefined

      const firstStarted =
        inPlaceResume && replay.history(scope, 1) === undefined
          ? replay.startedAgent(scope, 1, attemptKey)
          : undefined
      let replayedEntry: Extract<WorkflowJournalEntry, { type: 'agent' }> | undefined
      if (firstStarted !== undefined) {
        reattachEntry = firstStarted
      } else {
        const res = replay.match(scope, attemptKey, 'agent', {
          attempt: 1,
          allowFailure: maxAttempts > 1,
          resumed: opts.resume !== undefined,
        })
        if (res.conflictError !== undefined) {
          respond(callId, false, undefined, res.conflictError, true)
          return
        }
        if (res.hit && res.entry?.type === 'agent') replayedEntry = res.entry
      }

      while (replayedEntry !== undefined && !replayedEntry.ok) {
        const failed = replayedEntry
        if (failed.execution !== undefined) applyExecutionToNode(node, failed.execution)
        if (failed.gate !== undefined) node.gate = failed.gate
        node.attempt = attempt
        node.status = 'failed'
        node.cached = true
        node.error = failed.error ?? 'Agent failed.'
        replayedCount++
        if (!inPlaceResume) {
          const { type: _t, v: _v, seq: _s, scopePath: _sp, scopeCallIndex: _sc, ...rest } = failed
          await recordAttempt({ ...rest, index: attemptIndex })
        }
        emitNode(index, node)

        const persistedHandle =
          failed.execution?.executionId ??
          (failed.execution?.conversationId !== undefined ? String(failed.execution.conversationId) : undefined)
        const canRetry = attempt < attemptLimit && persistedHandle !== undefined && resumeAgent !== undefined
        if (!canRetry) {
          if (replay.history(scope, attempt + 1) !== undefined) {
            const conflict = replay.miss(scope)
            if (conflict.conflictError !== undefined) {
              respond(callId, false, undefined, conflict.conflictError, true)
              return
            }
          }
          if (persistedHandle !== undefined) {
            completedByLabel.set(scopedResumeKey(workflowRootPath, label), {
              agentId,
              label,
              agentType,
              workflowRootPath,
              resumeRef: persistedHandle,
              ...(model !== undefined ? { model } : {}),
              ...(isolation !== undefined ? { isolation } : {}),
            })
          }
          const metaRes: AgentWithMetaResult = {
            ok: false,
            output: null,
            attempts: attempt,
            error: failed.error ?? 'Agent failed.',
            ...(failed.timedOut === true ? { timedOut: true } : {}),
            ...(failed.execution !== undefined ? { execution: failed.execution as AgentWithMetaResult['execution'] } : {}),
            ...(failed.gate !== undefined ? { gate: failed.gate } : {}),
          }
          respond(callId, true, payload.withMeta === true ? metaRes : null)
          return
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
        attemptPrompt = agentRetryPrompt(opts.prompt, attempt, failed.error ?? 'Agent failed.')
        attempt++
        attemptIndex = callIndex++
        attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
        const nextStarted =
          inPlaceResume && replay.history(scope, attempt) === undefined
            ? replay.startedAgent(scope, attempt, attemptKey)
            : undefined
        if (nextStarted !== undefined) {
          reattachEntry = nextStarted
          replayedEntry = undefined
          break
        }
        const next = replay.match(scope, attemptKey, 'agent', {
          attempt,
          allowFailure: true,
          resumed: true,
        })
        if (next.conflictError !== undefined) {
          respond(callId, false, undefined, next.conflictError, true)
          return
        }
        replayedEntry = next.hit && next.entry?.type === 'agent' ? next.entry : undefined
      }

      if (replayedEntry !== undefined && replayedEntry.ok && compiledSchema !== undefined) {
        const recheck = applySchema({ ok: true, text: replayedEntry.text ?? '' }, compiledSchema)
        if (!recheck.ok) {
          replayedEntry = undefined
          const conflict = replay.miss(scope)
          if (conflict.conflictError !== undefined) {
            respond(callId, false, undefined, conflict.conflictError, true)
            return
          }
        }
      }

      if (replayedEntry !== undefined && replayedEntry.ok) {
        if (replayedEntry.execution !== undefined) applyExecutionToNode(node, replayedEntry.execution)
        if (replayedEntry.gate !== undefined) node.gate = replayedEntry.gate
        node.prompt = replayedEntry.prompt ?? attemptPrompt
        node.attempt = replayedEntry.attempt ?? attempt
        node.status = 'done'
        node.cached = true
        const at = Date.now()
        node.startedAt = at
        node.settledAt = at
        node.durationMs = 0
        const replayedText = replayedEntry.text ?? ''
        const parsedOutput = parseStructuredOutput(replayedText, compiledSchema)
        if (compiledSchema !== undefined && parsedOutput !== null) node.output = parsedOutput
        replayedCount++

        const nativeResumeRef =
          replayedEntry.execution?.conversationId !== undefined && replayedEntry.execution.executionId === undefined
            ? String(replayedEntry.execution.conversationId)
            : undefined
        completedByLabel.set(scopedResumeKey(workflowRootPath, label), {
          agentId,
          label,
          agentType,
          workflowRootPath,
          ...(model !== undefined ? { model } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
          ...(nativeResumeRef !== undefined ? { resumeRef: nativeResumeRef } : { replayed: true }),
        })
        emitNode(index, node)
        if (!inPlaceResume) {
          await recordAttempt({
            index: attemptIndex,
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
        const metaRes: AgentWithMetaResult = {
          ok: true,
          output: parsedOutput,
          attempts: replayedEntry.attempt ?? 1,
          ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution as AgentWithMetaResult['execution'] } : {}),
          ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
        }
        respond(callId, true, payload.withMeta === true ? metaRes : parsedOutput)
        return
      }

      if (resumed?.replayed === true) {
        respond(
          callId,
          false,
          undefined,
          `agent() opts.resume: "${opts.resume}" only exists as a replayed (cached) context with no live ` +
            'conversation in this run to continue; a replayed context cannot be resumed. Re-run the workflow without resumeFromRunId.',
          true,
        )
        return
      }

      // ---- Live attempt loop ----
      for (;;) {
        const currentReattach = reattachEntry
        reattachEntry = undefined
        const coordKey = journalCoordKey(scope, attempt)
        const isNativeReattach =
          currentReattach !== undefined &&
          currentReattach.execution.conversationId !== undefined &&
          currentReattach.execution.executionId === undefined

        // Wait for runtimeReadyGate before starting fresh live work or external reattach;
        // native `agent_started` reattaches run immediately in start() to bind structuredOutputSessions before harness.resume().
        if (!isNativeReattach && options.runtimeReadyGate !== undefined) {
          waitingOnReadyGate++
          checkQuiescentHorizon()
          try {
            await options.runtimeReadyGate
          } finally {
            waitingOnReadyGate--
          }
        }
        if (aborted || workerStopped) {
          respond(callId, false, undefined, 'Workflow aborted.', true)
          return
        }

        // In-flight native reattaches bypass Semaphore so startup recovery never deadlocks when active children >= concurrency.
        const acquiredPermit = !isNativeReattach
        if (acquiredPermit) await semaphore.acquire()
        if (aborted || workerStopped) {
          if (acquiredPermit) semaphore.release()
          respond(callId, false, undefined, 'Workflow aborted.', true)
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
        emitNode(index, node)

        const spawnRequestId =
          currentReattach !== undefined
            ? currentReattach.requestId
            : options.runId !== undefined
              ? `helmx:spawn:${options.runId}:${scope.scopePath}:${scope.scopeCallIndex}:${attempt}`
              : undefined
        let pendingStartedWrite: Promise<void> | undefined
        let nativeReattachResolved = false
        if (isNativeReattach) activeNativeReattachSetups++
        const markNativeReattachResolved = (): void => {
          if (!isNativeReattach || nativeReattachResolved) return
          nativeReattachResolved = true
          activeNativeReattachSetups--
          pendingNativeReattaches.delete(coordKey)
          if (pendingNativeReattaches.size === 0) fireReattachHorizon()
        }

        const onResolved = (info: AgentExecutionInfo): void => {
          applyExecutionToNode(node, info)
          markNativeReattachResolved()
          if (!inflightAgents.has(agentId)) return
          if (currentReattach === undefined && pendingStartedWrite === undefined && spawnRequestId !== undefined) {
            const snap = executionSnapshotOf(node)
            if (snap !== undefined) {
              pendingStartedWrite = recordAgentBestEffort({
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
          emitNode(index, node)
        }

        const onGateResult = (gateResult: WorkflowGateResult): void => {
          node.gate = gateResult
          if (!inflightAgents.has(agentId)) return
          emitNode(index, node)
        }

        inflightAgents.add(agentId)
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
            result = await host.spawnAgent(spawnReq)
          }

          if (result.executionInfo !== undefined) applyExecutionToNode(node, result.executionInfo)
          if (result.gate !== undefined && node.gate === undefined) node.gate = result.gate
          if (result.ok) {
            completedByLabel.set(scopedResumeKey(workflowRootPath, label), {
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
          result = { ok: false, error: error instanceof Error ? error.message : String(error) }
        } finally {
          markNativeReattachResolved()
          inflightAgents.delete(agentId)
          if (acquiredPermit) semaphore.release()
        }

        if (pendingStartedWrite !== undefined) await pendingStartedWrite
        if (workerStopped || isSuspended()) return

        const finishedAt = Date.now()
        node.settledAt = finishedAt
        node.durationMs = finishedAt - startedAt

        if (result.ok) {
          const text = result.text ?? ''
          const parsedOutput = parseStructuredOutput(text, compiledSchema)
          node.status = 'done'
          if (compiledSchema !== undefined && parsedOutput !== null) node.output = parsedOutput
          emitNode(index, node)

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
          const metaRes: AgentWithMetaResult = {
            ok: true,
            output: parsedOutput,
            attempts: attempt,
            ...(execution !== undefined ? { execution: execution as AgentWithMetaResult['execution'] } : {}),
            ...(node.gate !== undefined ? { gate: node.gate } : {}),
          }
          respond(callId, true, payload.withMeta === true ? metaRes : parsedOutput)
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
          completedByLabel.set(scopedResumeKey(workflowRootPath, label), failureHandle)
        }

        const errText = result.error ?? 'Agent failed.'
        const execution = executionSnapshotOf(node)
        if (failureHandle !== undefined && attempt < attemptLimit && resumeAgent !== undefined) {
          const redactedErr = redactText(errText)
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
          attemptIndex = callIndex++
          attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
          node.status = 'pending'
          node.attempt = attempt
          emitNode(index, node)
          continue
        }

        node.status = 'failed'
        node.error = errText
        emitNode(index, node)
        await recordAttempt({
          index: attemptIndex,
          key: attemptKey,
          ok: false,
          ...(resumeTarget !== undefined ? { resumed: true } : {}),
          attempt,
          prompt: attemptPrompt,
          error: errText,
          ...(result.timedOut === true ? { timedOut: true } : {}),
          ...(execution !== undefined ? { execution } : {}),
          ...(node.gate !== undefined ? { gate: node.gate } : {}),
        })
        const metaRes: AgentWithMetaResult = {
          ok: false,
          output: null,
          attempts: attempt,
          error: errText,
          ...(result.timedOut === true ? { timedOut: true } : {}),
          ...(execution !== undefined ? { execution: execution as AgentWithMetaResult['execution'] } : {}),
          ...(node.gate !== undefined ? { gate: node.gate } : {}),
        }
        respond(callId, true, payload.withMeta === true ? metaRes : null)
        return
      }
    }

    const handleActionCall = async (callId: number, payload: WorkerActionCallPayload): Promise<void> => {
      let opts
      try {
        opts = validateActionCallOptions(payload.actionId, payload.input, payload.opts)
      } catch (error) {
        if (error instanceof ScriptCallOptionError) {
          respond(callId, false, undefined, error.message, false)
          return
        }
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error), true)
        return
      }

      const scope = readCallScope(payload)
      const index = callIndex++
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

      type ActionJournalPayload =
        | Omit<Extract<JournalWriteInput, { type: 'action' }>, 'scopePath' | 'scopeCallIndex'>
        | Omit<Extract<JournalWriteInput, { type: 'action_started' }>, 'scopePath' | 'scopeCallIndex'>
      const recordAction = (entry: ActionJournalPayload) =>
        appendJournal?.({ ...entry, ...scope })

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

      if (options.runtimeReadyGate !== undefined) {
        waitingOnReadyGate++
        checkQuiescentHorizon()
        try {
          await options.runtimeReadyGate
        } finally {
          waitingOnReadyGate--
        }
      }
      if (aborted || workerStopped) {
        respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }

      await semaphore.acquire()
      if (aborted || workerStopped) {
        semaphore.release()
        respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }

      try {
        let prepared: { pluginId: string; actionId: string; idempotent?: boolean } | undefined
        if (host.prepareAction !== undefined) {
          try {
            prepared = await host.prepareAction(opts.actionId, opts.input, {
              index,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            })
          } catch (error) {
            if (aborted || workerStopped) {
              respond(callId, false, undefined, 'Workflow aborted.', true)
              return
            }
            const errMsg = error instanceof Error ? error.message : String(error)
            try {
              await recordAction({
                type: 'action',
                index,
                key,
                ok: false,
                idempotent: true,
                error: redactText(errMsg),
              })
            } catch (jErr) {
              respond(callId, false, undefined, `workflow_action_uncertain: ${jErr instanceof Error ? jErr.message : String(jErr)}`, true)
              return
            }
            const at = Date.now()
            node.status = 'failed'
            node.startedAt = at
            node.settledAt = at
            node.durationMs = 0
            node.error = errMsg
            emitNode(index, node)
            respond(callId, true, null)
            return
          }
        }

        if (aborted || workerStopped) {
          respond(callId, false, undefined, 'Workflow aborted.', true)
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
          respond(callId, false, undefined, `workflow_action_uncertain: ${error instanceof Error ? error.message : String(error)}`, true)
          return
        }
        if (aborted || workerStopped) return

        node.status = 'running'
        node.startedAt = startedAt
        emitNode(index, node)

        const runActionAndJournal = async (): Promise<void> => {
          let outcome: { ok: true; result: unknown } | { ok: false; error: string }
          try {
            const invoked = await host.invokeAction(opts.actionId, opts.input, {
              index,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            })
            assertBoundarySafe(invoked.result, `action('${opts.actionId}') result`, false)
            outcome = { ok: true, result: invoked.result }
          } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
          } finally {
            openLaunches.delete(callId)
          }

          // Even if suspend() stopped the worker while this action was executing,
          // if the action already succeeded, persist its terminal row so restart
          // never misclassifies it as dangling `workflow_action_uncertain`.
          if (settled || (isSuspended() && !outcome.ok)) return

          const finishedAt = Date.now()
          const writeTerminal = (async () => {
            await recordAction(
              outcome.ok
                ? {
                    type: 'action',
                    index,
                    key,
                    ok: true,
                    result: redactPlainValue(outcome.result, redactText),
                    ...(effectiveIdempotent ? { idempotent: true } : {}),
                  }
                : {
                    type: 'action',
                    index,
                    key,
                    ok: false,
                    error: redactText(outcome.error),
                    ...(effectiveIdempotent ? { idempotent: true } : {}),
                  },
            )
          })()
          inflightActionWrites.add(writeTerminal)
          try {
            await writeTerminal
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            respond(
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
            inflightActionWrites.delete(writeTerminal)
          }

          node.settledAt = finishedAt
          node.durationMs = finishedAt - startedAt
          if (outcome.ok) {
            node.status = 'done'
            node.output = outcome.result
            emitNode(index, node)
            respond(callId, true, outcome.result)
          } else {
            node.status = 'failed'
            node.error = outcome.error
            emitNode(index, node)
            respond(callId, true, null)
          }
        }
        const actionTask = runActionAndJournal()
        inflightActions.add(actionTask)
        try {
          await actionTask
        } finally {
          inflightActions.delete(actionTask)
        }
      } finally {
        semaphore.release()
      }
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
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error), false)
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
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error), false)
      }
    }

    worker.on('message', (message: WorkerMessage) => {
      if (workerStopped) return
      switch (message.type) {
        case 'progress': {
          const now = Date.now()
          for (const entry of message.entries) {
            if (entry.type === 'workflow_phase') {
              emitTimeline({ at: now, kind: 'phase', index: entry.index, title: entry.title })
            } else {
              emitTimeline({ at: now, kind: 'log', message: entry.message })
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
            finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
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
      finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })

    worker.on('exit', () => {
      finish({ status: 'failed', error: 'Workflow worker exited before completing.' })
    })
  })
}
