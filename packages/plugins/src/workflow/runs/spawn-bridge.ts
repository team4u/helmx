/**
 * runs/spawn-bridge.ts — Unified bridge between HelmxHostApi, WorkflowServiceHost,
 * and DSL WorkflowHost (single spawn assembly, timeoutMs control, guarded abort with
 * state_conflict retry, and shared subagent title derivation).
 */
import {
  HelmxError,
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
  type HelmxHostApi,
} from '@helmx/protocol'
import { withWorkflowSpawnMeta, type WorkflowRunSummary } from '../../contracts.js'
import type { WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from '../dsl/index.js'
import type { RunsProjection } from '../projection.js'
import { invokeEngineAction, prepareEngineAction } from './action-bridge.js'
import { errorMessage } from './run-repository.js'
import type { ActiveRun, WorkflowServiceHost } from './types.js'

export type { WorkflowServiceHost } from './types.js'

type EngineHostPorts = Pick<
  HelmxHostApi,
  | 'spawnAgent'
  | 'invokeAction'
  | 'prepareAction'
  | 'execEnv'
  | 'listActions'
  | 'getConversation'
  | 'getConversationOwnership'
  | 'abortConversationGuarded'
  | 'emitEvent'
  | 'runGate'
  | 'isClosing'
>

/** Shared readable title derivation from a subagent prompt (used by sync tool, background runner, and DSL). */
export function deriveSubagentNameFromPrompt(prompt: string, redact: (text: string) => string): string | undefined {
  const withoutContract = prompt.replace(/<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g, '')
  for (const rawLine of withoutContract.split(/\r?\n/)) {
    const cleaned = rawLine
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .replace(/^(?:#+\s*|[-*]+\s+)+/, '')
      .replace(/^[#\-*]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned === '') continue
    // eslint-disable-next-line no-control-regex
    const redacted = redact(cleaned).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    if (redacted === '') continue
    return redacted.length > 60 ? redacted.slice(0, 60).trimEnd() : redacted
  }
  return undefined
}

/** Adapt `ctx.host` into `WorkflowServiceHost`, with single `state_conflict` retry on guarded aborts. */
export function createWorkflowEngineHost(deps: {
  host: EngineHostPorts
  projection: RunsProjection
  deliverBackgroundReport: (
    run: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ) => Promise<void>
}): WorkflowServiceHost {
  const { host, projection } = deps
  const attemptGuardedAbort = async (id: number): Promise<void> => {
    let guard: { expectedOwnership?: 'helmx'; expectedStateSeq?: number } = {}
    try {
      const ownership = host.getConversationOwnership(id)
      guard =
        ownership === 'human'
          ? {}
          : { expectedOwnership: ownership, expectedStateSeq: host.getConversation(id).stateChangeSeq }
    } catch (error) {
      if (error instanceof HelmxError && error.code === 'not_found') return
      guard = {}
    }
    await host.abortConversationGuarded(id, guard)
  }

  return {
    spawnAgent: (request) => host.spawnAgent(request),
    invokeAction: (pluginId, actionId, input, invokeContext) =>
      host.invokeAction(pluginId, actionId, input, invokeContext),
    prepareAction: (pluginId, actionId, input, prepareContext) =>
      host.prepareAction(pluginId, actionId, input, prepareContext),
    execEnv: (req, signal) => host.execEnv(req, { signal }),
    listActions: () => host.listActions(),
    getConversation: (id) => host.getConversation(id),
    abortConversationGuarded: async (id) => {
      try {
        await attemptGuardedAbort(id)
      } catch (error) {
        // Re-read fresh stateChangeSeq once on CAS conflict so concurrent status ticks never crash recovery.
        if (error instanceof HelmxError && error.code === 'state_conflict') {
          await attemptGuardedAbort(id)
          return
        }
        throw error
      }
    },
    emitEvent: async (type, payload) => {
      try {
        if (type === 'workflow.updated') {
          const run = (payload as { run: WorkflowRunSummary }).run
          projection.upsertRun(run)
          await host.emitEvent(type, { run: { id: run.id, conversationId: run.conversationId, status: run.status } })
          return
        }
        await host.emitEvent(type, payload)
      } catch (error) {
        const message = errorMessage(error)
        process.stderr.write(`builtin:workflow: emitEvent ${type} failed: ${message}\n`)
        if (type !== 'notification') {
          try {
            await host.emitEvent('notification', {
              type: 'notification',
              level: 'warning',
              title: '工作流事件投影未同步',
              body: `事件 ${type} 广播或投影失败：${message}`,
            })
          } catch {
            // Avoid infinite recursion if notification delivery itself fails.
          }
        }
      }
    },
    onRunSettled: async (summary) => {
      projection.upsertRun(summary)
      await host.emitEvent('workflow.settled', summary, { broadcast: false })
    },
    onBackgroundAgentSettled: async (summary, info) => {
      projection.upsertRun(summary)
      if (!projection.isStopping()) await deps.deliverBackgroundReport(summary, info)
    },
    runGate: (command, gateOptions) =>
      host.runGate(command, {
        ...(gateOptions.cwd !== undefined ? { cwd: gateOptions.cwd } : {}),
        ...(gateOptions.conversationId !== undefined ? { conversationId: gateOptions.conversationId } : {}),
        ...(gateOptions.signal !== undefined ? { signal: gateOptions.signal } : {}),
        ...(gateOptions.gateTimeoutMs !== undefined ? { gateTimeoutMs: gateOptions.gateTimeoutMs } : {}),
      }),
    isHostClosing: () => host.isClosing,
  }
}

export function abortChildConversation(
  host: WorkflowServiceHost,
  run: ActiveRun,
  conversationId: number,
): Promise<void> {
  if (host.isHostClosing?.() === true) return Promise.resolve()
  const pending = host
    .abortConversationGuarded(conversationId)
    .catch((error: unknown) => {
      process.stderr.write(`workflow ${run.runId}: guarded abort conversation ${conversationId} rejected: ${errorMessage(error)}\n`)
    })
    .then(() => {
      run.pendingAborts.delete(pending)
    })
  run.pendingAborts.add(pending)
  return pending
}

export interface EngineHostBridgeDeps {
  host: WorkflowServiceHost
  redact: (text: string) => string
  isClosed(): boolean
  isCancelling(conversationId: number): boolean
  isSuspending(run: ActiveRun): boolean
  persistChildConversationFact(run: ActiveRun, conversationId: number): void
  loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string }
}

/** Build the DSL `WorkflowHost` adapter for one active workflow run. */
export function buildEngineHost(
  deps: EngineHostBridgeDeps,
  run: ActiveRun,
  parent: ConversationSummary,
): WorkflowHost {
  const conversationByAgent = new Map<string, number>()

  const invokeSpawn = async (request: WorkflowSpawnRequest, isResume: boolean): Promise<WorkflowSpawnResult> => {
    if (deps.host.isHostClosing?.() === true) {
      run.abort.abort()
      return { ok: false, error: deps.isSuspending(run) ? 'Workflow suspended.' : 'Workflow aborted.' }
    }
    if (deps.isClosed() || run.abort.signal.aborted) return { ok: false, error: 'Workflow aborted.' }
    if (deps.isCancelling(run.conversationId)) {
      return { ok: false, error: '[aborted] 发起会话所在任务树正在取消，拒绝派生子代理' }
    }

    const nativeAgentId = `${run.runId}:${request.agentId}`
    const isReattach = request.reattach !== undefined
    const resumeRef =
      !isReattach && isResume
        ? String(request.resumeRef ?? conversationByAgent.get(request.agentId) ?? nativeAgentId)
        : undefined

    let executionInfo: AgentExecutionInfo | undefined
    let gateResult: AgentGateResult | undefined

    const timeoutMs = request.timeoutMs
    let timeoutController: AbortController | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeoutAborts = new Set<Promise<void>>()
    if (timeoutMs !== undefined) {
      timeoutController = new AbortController()
      const controller = timeoutController
      timeoutTimer = setTimeout(() => {
        timeoutTimer = undefined
        if (run.abort.signal.aborted) return
        timedOut = true
        controller.abort(new DOMException(`子代理回合超过 ${timeoutMs}ms 上限`, 'TimeoutError'))
        const childId = executionInfo?.conversationId ?? conversationByAgent.get(request.agentId)
        if (childId !== undefined) timeoutAborts.add(abortChildConversation(deps.host, run, childId))
      }, timeoutMs)
      timeoutTimer.unref?.()
    }

    const disarmTimeout = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
      timeoutController = undefined
    }
    const timeoutMessage = (cause?: unknown): string =>
      `[agent_timeout] 子代理 ${request.label} 回合超过 ${timeoutMs}ms 上限；已请求取消` +
      (cause === undefined ? '' : `\n${deps.redact(errorMessage(cause))}`)

    const freshTitle =
      !isResume && !isReattach && typeof request.label === 'string'
        // eslint-disable-next-line no-control-regex
        ? request.label.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
        : ''

    const proto: AgentSpawnRequest = {
      parentConversationId: run.conversationId,
      prompt: request.prompt,
      ...(freshTitle !== '' ? { title: freshTitle } : {}),
      agentId: nativeAgentId,
      ...(request.gate !== undefined ? { gate: request.gate } : {}),
      ...(request.agentType !== '' ? { agentType: request.agentType } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
      ...(!isResume && !isReattach && request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
      ...(!isResume && !isReattach && request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
      meta: withWorkflowSpawnMeta(undefined, {
        runId: run.runId,
        ...(request.maxSubagentDepth !== undefined ? { maxSubagentDepth: request.maxSubagentDepth } : {}),
      }),
      ...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
      ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
      ...(request.reattach !== undefined ? { reattach: request.reattach } : {}),
      ...(resumeRef !== undefined ? { resume: resumeRef } : {}),
      onResolved: (raw: unknown) => {
        const info = sanitizeAgentExecutionInfo(raw, { agentId: nativeAgentId })
        executionInfo = info
        if (info.conversationId !== undefined) {
          conversationByAgent.set(request.agentId, info.conversationId)
          run.childConversations.add(info.conversationId)
          if (run.abort.signal.aborted && !deps.isSuspending(run)) {
            abortChildConversation(deps.host, run, info.conversationId)
          } else if (timedOut) {
            timeoutAborts.add(abortChildConversation(deps.host, run, info.conversationId))
          }
          deps.persistChildConversationFact(run, info.conversationId)
        }
        request.onResolved?.(info)
      },
      ...(request.gate !== undefined
        ? {
            onGateResult: (raw: unknown) => {
              gateResult = sanitizeAgentGateResult(raw, { agentId: nativeAgentId })
              request.onGateResult?.(gateResult)
            },
          }
        : {}),
      signal:
        timeoutController === undefined
          ? run.abort.signal
          : AbortSignal.any([run.abort.signal, timeoutController.signal]),
    }

    try {
      const raw = await deps.host.spawnAgent(proto)
      if (timedOut) {
        if (timeoutAborts.size > 0) await Promise.allSettled([...timeoutAborts])
        return {
          ok: false,
          error: timeoutMessage(),
          timedOut: true,
          ...(executionInfo !== undefined ? { executionInfo } : {}),
          ...(gateResult !== undefined ? { gate: gateResult } : {}),
        }
      }
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      if (request.gate !== undefined && gateResult === undefined && executionInfo?.executionId !== undefined) {
        throw agentGateResultMissingError({
          agentId: nativeAgentId,
          executionId: executionInfo.executionId,
          command: request.gate,
        })
      }
      return {
        ok: true,
        text,
        ...(executionInfo !== undefined ? { executionInfo } : {}),
        ...(gateResult !== undefined ? { gate: gateResult } : {}),
      }
    } catch (error) {
      const retained: Pick<WorkflowSpawnResult, 'executionInfo' | 'gate'> = {
        ...(executionInfo !== undefined ? { executionInfo } : {}),
        ...(gateResult !== undefined ? { gate: gateResult } : {}),
      }
      if (deps.host.isHostClosing?.() === true) run.abort.abort()
      if (timedOut) {
        if (timeoutAborts.size > 0) await Promise.allSettled([...timeoutAborts])
        return { ok: false, error: timeoutMessage(error), timedOut: true, ...retained }
      }
      if (error instanceof HelmxError) return { ok: false, error: `[${error.code}] ${error.message}`, ...retained }
      return { ok: false, error: errorMessage(error), ...retained }
    } finally {
      disarmTimeout()
    }
  }

  return {
    spawnAgent: (request) => invokeSpawn(request, false),
    resumeAgent: (agentId, prompt, options) =>
      invokeSpawn(
        {
          agentId,
          index: -1,
          prompt,
          label: agentId,
          agentType: '',
          ...(options?.resumeRef !== undefined ? { resumeRef: options.resumeRef } : {}),
          ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
          ...(options?.schema !== undefined ? { schema: options.schema } : {}),
          ...(options?.gate !== undefined ? { gate: options.gate } : {}),
          ...(options?.gateTimeoutMs !== undefined ? { gateTimeoutMs: options.gateTimeoutMs } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options?.attachments !== undefined ? { attachments: options.attachments } : {}),
          ...(options?.maxSubagentDepth !== undefined ? { maxSubagentDepth: options.maxSubagentDepth } : {}),
          ...(options?.onResolved !== undefined ? { onResolved: options.onResolved } : {}),
          ...(options?.onGateResult !== undefined ? { onGateResult: options.onGateResult } : {}),
        },
        true,
      ),
    abortAgent(agentId: string): void {
      const convId = conversationByAgent.get(agentId)
      if (convId !== undefined) abortChildConversation(deps.host, run, convId)
    },
    ...(deps.host.runGate !== undefined
      ? {
          runGate: (command: string, options: { agentId: string; cwd?: string; gateTimeoutMs?: number }) => {
            const convId = conversationByAgent.get(options.agentId)
            return deps.host.runGate!(command, {
              cwd: options.cwd ?? parent.cwd,
              conversationId: convId ?? parent.id,
              signal: run.abort.signal,
              ...(options.gateTimeoutMs !== undefined ? { gateTimeoutMs: options.gateTimeoutMs } : {}),
            })
          },
        }
      : {}),
    prepareAction: (actionId, input) => prepareEngineAction(deps.host, run, actionId, input),
    invokeAction: (actionId, input, context) => invokeEngineAction(deps.host, deps.redact, run, actionId, input, context),
    loadWorkflow: (ref) => deps.loadWorkflowRef(ref),
  }
}
