/**
 * host-adapter.ts — Unified thin adapter between `HelmxHostApi`, `WorkflowServiceHost`, and
 * the DSL engine's `WorkflowHost` (collapsed from engine-host + host-adapter + host-action-adapter).
 */

import {
  HelmxError,
  agentGateResultMissingError as gateResultMissingError,
  isAbsoluteTargetPath,
  isValidNodeId,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  sanitizeAgentGateResult as sanitizeGateResult,
  type ActionManifest,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
  type EnvExecRequest,
  type EnvExecResponse,
  type HelmxHostApi,
} from '@helmx/protocol'
import { withWorkflowSpawnMeta, type WorkflowRunSummary } from '../../contracts.js'
import type { RunsProjection } from '../projection.js'
import type { ActiveRun } from './active-run.js'
import { errorMessage } from './run-store.js'
import type { WorkflowHost, WorkflowSpawnRequest, WorkflowSpawnResult } from './runtime.js'

export const BUILTIN_ENV_EXEC_PLUGIN = 'env'
export const BUILTIN_ENV_EXEC_ACTION = 'exec'

export interface ValidatedEnvExecInput {
  command: string | string[]
  nodeId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  allowFailure?: boolean
}

/** Test-injectable host seam for WorkflowService. */
export interface WorkflowServiceHost {
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /** Guarded child-conversation abort (human red line enforced atomically in kernel). */
  abortConversationGuarded(id: number): Promise<void>
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number; signal?: AbortSignal },
  ): Promise<unknown>
  prepareAction?(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number },
  ): { idempotent?: boolean }
  execEnv?(req: Omit<EnvExecRequest, 'stream'>, signal?: AbortSignal): Promise<EnvExecResponse>
  listActions(): ActionManifest[]
  getConversation(id: number): ConversationSummary
  emitEvent(type: string, payload: unknown): void
  onRunSettled?(summary: WorkflowRunSummary): Promise<void> | void
  onBackgroundAgentSettled?(
    summary: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ): Promise<void> | void
  runGate?(
    command: string,
    options: { cwd?: string; conversationId?: number; signal?: AbortSignal; gateTimeoutMs?: number },
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }>
  isHostClosing?(): boolean
}

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

/** Adapt `ctx.host` (trusted HelmxHostApi ports) into `WorkflowServiceHost`. */
export function createWorkflowEngineHost(deps: {
  host: EngineHostPorts
  projection: RunsProjection
  deliverBackgroundReport: (
    run: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ) => Promise<void>
}): WorkflowServiceHost {
  const { host, projection } = deps
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
        process.stderr.write(`builtin:workflow: emitEvent ${type} 投影/广播失败（run 状态以 records 持久层为准）: ${message}\n`)
        Promise.resolve(
          host.emitEvent('notification', {
            type: 'notification',
            level: 'warning',
            title: '工作流事件投影未同步',
            body: `同步 runs 投影或广播 ${type} 事件失败（运行终态以任务面板重查为准）：${message}`,
          }),
        ).catch(() => {})
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

export interface EngineHostDeps {
  host: WorkflowServiceHost
  redact: (text: string) => string
  isClosed(): boolean
  isCancelling(conversationId: number): boolean
  persistChildConversationFact(run: ActiveRun, conversationId: number): void
  loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string }
  waitExternalRuntimeReady?(): Promise<void>
  isSuspending?(run: ActiveRun): boolean
}

// ---------------------------------------------------------------------------
// Action resolution & built-in env.exec
// ---------------------------------------------------------------------------

export function resolveActionId(
  host: WorkflowServiceHost,
  qualified: string,
): { pluginId: string; actionId: string; builtin?: 'env.exec' } {
  if (qualified === `${BUILTIN_ENV_EXEC_PLUGIN}.${BUILTIN_ENV_EXEC_ACTION}`) {
    return { pluginId: BUILTIN_ENV_EXEC_PLUGIN, actionId: BUILTIN_ENV_EXEC_ACTION, builtin: 'env.exec' }
  }
  const manifests = host.listActions()
  if (qualified === BUILTIN_ENV_EXEC_ACTION) {
    const sameShort = manifests.filter((m) => m.id === BUILTIN_ENV_EXEC_ACTION && (m.visibility ?? 'public') === 'public')
    if (sameShort.length === 0) {
      return { pluginId: BUILTIN_ENV_EXEC_PLUGIN, actionId: BUILTIN_ENV_EXEC_ACTION, builtin: 'env.exec' }
    }
    throw new HelmxError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个动作（含内建 env.exec），请用全限定 id：env.exec, ${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  for (const manifest of manifests) {
    if (`${manifest.pluginId}.${manifest.id}` === qualified) {
      if (manifest.visibility === 'ui' || manifest.visibility === 'internal') {
        throw new HelmxError(
          'action_visibility_forbidden',
          `动作 "${qualified}" 可见性为 '${manifest.visibility}'，禁止在工作流脚本中调用`,
          403,
          { pluginId: manifest.pluginId, actionId: manifest.id, visibility: manifest.visibility },
        )
      }
      return { pluginId: manifest.pluginId, actionId: manifest.id }
    }
  }
  const sameShort = manifests.filter((m) => m.id === qualified)
  const publicShort = sameShort.filter((m) => (m.visibility ?? 'public') === 'public')
  if (publicShort.length === 1) return { pluginId: publicShort[0]!.pluginId, actionId: publicShort[0]!.id }
  if (publicShort.length > 1) {
    throw new HelmxError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个插件，请用全限定 id：${publicShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  if (sameShort.length > 0) {
    const blocked = sameShort[0]!
    throw new HelmxError(
      'action_visibility_forbidden',
      `动作 "${blocked.pluginId}.${blocked.id}" 可见性为 '${blocked.visibility}'，禁止在工作流脚本中调用`,
      403,
      { pluginId: blocked.pluginId, actionId: blocked.id, visibility: blocked.visibility },
    )
  }
  throw new HelmxError('unknown_action', `未注册的动作：${qualified}`, 404, { qualified })
}

const ENV_EXEC_KEYS = new Set(['command', 'nodeId', 'cwd', 'env', 'timeoutMs', 'allowFailure'])

export function validateEnvExecInput(host: WorkflowServiceHost, input: unknown): ValidatedEnvExecInput {
  if (host.execEnv === undefined) {
    throw new HelmxError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HelmxError('validation_error', 'env.exec 入参必须是 JSON 对象', 400)
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!ENV_EXEC_KEYS.has(key)) throw new HelmxError('validation_error', `env.exec 发现未知选项 "${key}"`, 400)
  }

  let command: string | string[]
  if (typeof raw.command === 'string') {
    if (raw.command.trim().length === 0) throw new HelmxError('validation_error', 'env.exec command 不能为空字符串', 400)
    command = raw.command
  } else if (Array.isArray(raw.command)) {
    if (raw.command.length === 0 || !raw.command.every((i) => typeof i === 'string') || raw.command[0]!.trim().length === 0) {
      throw new HelmxError('validation_error', 'env.exec command 数组必须非空且首项为非空字符串', 400)
    }
    command = raw.command as string[]
  } else {
    throw new HelmxError('validation_error', 'env.exec command 必须是非空字符串或非空字符串数组', 400)
  }

  if (raw.nodeId !== undefined && !isValidNodeId(raw.nodeId)) {
    throw new HelmxError('validation_error', 'env.exec nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）', 400)
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd.trim().length === 0 || !isAbsoluteTargetPath(raw.cwd))) {
    throw new HelmxError('validation_error', 'env.exec cwd 必须为跨平台绝对路径（POSIX/Windows/UNC）', 400)
  }
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      throw new HelmxError('validation_error', 'env.exec env 必须是键值对象', 400)
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') throw new HelmxError('validation_error', `env.exec env.${k} 必须为字符串`, 400)
    }
  }
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 600_000)) {
    throw new HelmxError('validation_error', 'env.exec timeoutMs 必须是 1 到 600000 之间的整数', 400)
  }
  if (raw.allowFailure !== undefined && typeof raw.allowFailure !== 'boolean') {
    throw new HelmxError('validation_error', 'env.exec allowFailure 必须为 boolean', 400)
  }

  return {
    command,
    nodeId: raw.nodeId as string | undefined,
    cwd: raw.cwd as string | undefined,
    env: raw.env as Record<string, string> | undefined,
    timeoutMs: raw.timeoutMs as number | undefined,
    allowFailure: raw.allowFailure as boolean | undefined,
  }
}

async function enginePrepareAction(
  deps: EngineHostDeps,
  run: ActiveRun,
  actionId: string,
  input: unknown,
): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }> {
  if (deps.host.isHostClosing?.() === true) {
    run.abort.abort()
    throw new HelmxError('aborted', '宿主正在关停，中止动作调用', 409)
  }
  const resolved = resolveActionId(deps.host, actionId)
  if (resolved.builtin === 'env.exec') {
    validateEnvExecInput(deps.host, input)
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: false }
  }
  if (deps.host.prepareAction !== undefined) {
    const prep = deps.host.prepareAction(resolved.pluginId, resolved.actionId, input, { conversationId: run.conversationId })
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: prep?.idempotent }
  }
  const manifest = deps.host.listActions().find((m) => m.pluginId === resolved.pluginId && m.id === resolved.actionId)
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: manifest?.idempotent }
}

async function engineInvokeAction(
  deps: EngineHostDeps,
  run: ActiveRun,
  actionId: string,
  input: unknown,
  context: { index: number; signal?: AbortSignal },
): Promise<{ pluginId: string; actionId: string; result: unknown }> {
  const resolved = resolveActionId(deps.host, actionId)
  if (resolved.builtin === 'env.exec') {
    const parsed = validateEnvExecInput(deps.host, input)
    const execPromise = deps.host.execEnv?.(
      {
        command: parsed.command,
        ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
        ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
        ...(parsed.env !== undefined ? { env: parsed.env } : {}),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        conversationId: run.conversationId,
      },
      context.signal,
    )
    if (execPromise === undefined) {
      throw new HelmxError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
    }
    run.pendingExecs.add(execPromise)
    let res: EnvExecResponse
    try {
      res = await execPromise
    } finally {
      run.pendingExecs.delete(execPromise)
    }
    const redactedOutput = deps.redact(res.output)
    const succeeded = res.ok && res.exitCode === 0 && !res.timedOut
    if (!succeeded && parsed.allowFailure !== true) {
      const tail = redactedOutput.length > 2000 ? redactedOutput.slice(-2000) : redactedOutput
      throw new HelmxError(
        'env_exec_failed',
        `命令执行失败${res.timedOut ? '（超时）' : ''}（exitCode=${String(res.exitCode)}）${tail ? ': ' + tail : ''}`,
        502,
        { exitCode: res.exitCode, timedOut: res.timedOut },
      )
    }
    return {
      pluginId: 'env',
      actionId: 'exec',
      result: { ok: succeeded, exitCode: res.exitCode, output: redactedOutput, timedOut: res.timedOut },
    }
  }
  const result = await deps.host.invokeAction(resolved.pluginId, resolved.actionId, input, {
    conversationId: run.conversationId,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  })
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, result }
}

// ---------------------------------------------------------------------------
// Engine WorkflowHost construction & spawn/abort
// ---------------------------------------------------------------------------

export function createEngineHost(deps: EngineHostDeps, run: ActiveRun, parent: ConversationSummary): WorkflowHost {
  const conversationByAgent = new Map<string, number>()

  return {
    spawnAgent: (request) => invokeAgentSpawn(deps, run, parent, conversationByAgent, request, false),
    resumeAgent: (agentId, prompt, options) =>
      invokeAgentSpawn(
        deps,
        run,
        parent,
        conversationByAgent,
        {
          agentId,
          index: -1,
          prompt,
          label: agentId,
          agentType: '',
          ...(options?.schema !== undefined ? { schema: options.schema } : {}),
          ...(options?.gate !== undefined ? { gate: options.gate } : {}),
          ...(options?.attachments !== undefined ? { attachments: options.attachments } : {}),
          ...(options?.maxSubagentDepth !== undefined ? { maxSubagentDepth: options.maxSubagentDepth } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options?.gateTimeoutMs !== undefined ? { gateTimeoutMs: options.gateTimeoutMs } : {}),
          ...(options?.resumeRef !== undefined ? { resumeRef: options.resumeRef } : {}),
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
    prepareAction: (actionId, input) => enginePrepareAction(deps, run, actionId, input),
    invokeAction: (actionId, input, context) => engineInvokeAction(deps, run, actionId, input, context),
    loadWorkflow: (ref) => deps.loadWorkflowRef(ref),
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

export async function invokeAgentSpawn(
  deps: EngineHostDeps,
  run: ActiveRun,
  _parent: ConversationSummary,
  conversationByAgent: Map<string, number>,
  request: WorkflowSpawnRequest,
  isResume: boolean,
): Promise<WorkflowSpawnResult> {
  if (deps.host.isHostClosing?.() === true) {
    run.abort.abort()
    return { ok: false, error: deps.isSuspending?.(run) === true ? 'Workflow suspended.' : 'Workflow aborted.' }
  }
  if (deps.isClosed() || run.abort.signal.aborted) return { ok: false, error: 'Workflow aborted.' }
  if (deps.isCancelling(run.conversationId)) {
    return { ok: false, error: '[aborted] 发起会话所在任务树正在取消，拒绝派生子代理' }
  }

  const nativeAgentId = `${run.runId}:${request.agentId}`
  const isReattach = request.reattach !== undefined
  const resumeRef = !isReattach && isResume
    ? String(request.resumeRef ?? conversationByAgent.get(request.agentId) ?? nativeAgentId)
    : undefined

  let executionInfo: AgentExecutionInfo | undefined
  let gateResult: AgentGateResult | undefined

  const timeoutMs = readAgentTimeoutMs(request)
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
  const timeoutSignal = timeoutController?.signal
  const disarmTimeout = (): void => {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
    timeoutController = undefined
  }
  const awaitTimeoutAborts = async (): Promise<void> => {
    if (timeoutAborts.size > 0) await Promise.allSettled([...timeoutAborts])
  }
  const timeoutMessage = (cause?: unknown): string =>
    `[agent_timeout] 子代理 ${request.label} 回合超过 ${timeoutMs}ms 上限；已请求取消，` +
    '实际执行状态与续接条件以 execution 和执行方诊断为准' +
    (cause === undefined ? '' : `\n${deps.redact(errorMessage(cause))}`)

  const freshTitle =
    !isResume && !isReattach && typeof request.label === 'string'
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
      const info = sanitizeExecutionInfo(raw, { agentId: nativeAgentId })
      executionInfo = info
      if (info.conversationId !== undefined) {
        conversationByAgent.set(request.agentId, info.conversationId)
        run.childConversations.add(info.conversationId)
        if (run.abort.signal.aborted && deps.isSuspending?.(run) !== true) {
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
            gateResult = sanitizeGateResult(raw, { agentId: nativeAgentId })
            request.onGateResult?.(gateResult)
          },
        }
      : {}),
    signal: timeoutSignal === undefined ? run.abort.signal : AbortSignal.any([run.abort.signal, timeoutSignal]),
  }

  try {
    const raw = await deps.host.spawnAgent(proto)
    if (timedOut) {
      await awaitTimeoutAborts()
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
      throw gateResultMissingError({ agentId: nativeAgentId, executionId: executionInfo.executionId, command: request.gate })
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
      await awaitTimeoutAborts()
      return { ok: false, error: timeoutMessage(error), timedOut: true, ...retained }
    }
    if (error instanceof HelmxError) return { ok: false, error: `[${error.code}] ${error.message}`, ...retained }
    return { ok: false, error: errorMessage(error), ...retained }
  } finally {
    disarmTimeout()
  }
}

export function readAgentTimeoutMs(request: WorkflowSpawnRequest): number | undefined {
  const raw: unknown = request.timeoutMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1_000 || raw > 3_600_000) {
    throw new HelmxError(
      'validation_error',
      `agent timeoutMs 必须是 1_000..3_600_000 的整数毫秒值（收到 ${JSON.stringify(raw)}）`,
      400,
      { timeoutMs: raw },
    )
  }
  return raw
}
