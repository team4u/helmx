/**
 * runs/subagent-driver.ts — Background single-subagent driver, resumeByRunId,
 * in-place reattach, and settlement (using discriminated modes and options objects).
 */
import {
  HelmxError,
  agentGateResultMissingError,
  redactJsonValue,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type JsonSchema,
} from '@helmx/protocol'
import {
  extractWorktreeExecutionMeta,
  parseWorkflowSpawnMeta,
  withWorkflowSpawnMeta,
  type WorkflowNodeState,
  type WorkflowRunRequest,
  type WorkflowRunSummary,
} from '../../contracts.js'
import {
  assertResumeConversationMatch,
  writeRedactedStderr,
  type RunCoordinatorCore,
} from './active-runs.js'
import { classifyRunFailureCode, inspectRunResumability } from './resumability.js'
import { childIdsOfHeader, errorMessage, formatResultPreview, newRunId } from './run-repository.js'
import { abortChildConversation, deriveSubagentNameFromPrompt } from './spawn-bridge.js'
import type { ActiveRun, PersistedSubagentSpec, RunDetail, SubagentRunHeader } from './types.js'

const SUBAGENT_RESUME_PROMPT = '前次执行中断或未通过验收，请检查当前工作区状态并继续完成原任务。'

export type SubagentSpawnMode =
  | { isReattach: false; originalRequest: AgentSpawnRequest }
  | { isReattach: true }

export interface SettleSubagentOptions {
  run: ActiveRun
  node: WorkflowNodeState
  outcome: { ok: true; raw: unknown } | { ok: false; error: unknown }
  executionInfo: AgentExecutionInfo | undefined
  gateResult: AgentGateResult | undefined
  agentId: string
  gateCommand: string | undefined
}

export class SubagentRunDriver {
  constructor(
    private readonly core: RunCoordinatorCore,
    private readonly runtimeReadyGate: Promise<void>,
  ) {}

  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
      replayedFrom?: string
    },
  ): Promise<{ run: WorkflowRunSummary; execution?: AgentExecutionInfo }> {
    const { host, repo, cancellation, redact } = this.core.deps
    this.core.assertNotClosed()
    host.getConversation(request.parentConversationId)
    if (request.signal?.aborted) throw new HelmxError('aborted', 'spawn 请求在创建前已取消', 409)
    cancellation.assertNotCancelling(request.parentConversationId)

    const runId = newRunId()
    const createdAt = Date.now()
    const parentToolCallId =
      options?.parentToolCallId || request.parentToolCallId || undefined
    const explicitLabel = options?.label?.trim() ?? ''
    const resolvedName =
      explicitLabel !== ''
        ? redact(explicitLabel)
        : deriveSubagentNameFromPrompt(request.prompt, redact)
    const name = resolvedName || (request.agentType ? `subagent:${request.agentType}` : 'subagent')
    const agentId = request.agentId ?? `${runId}:subagent-0`
    const deterministicRequestId = request.requestId ?? `helmx:spawn:${runId}`
    const spawnMeta = parseWorkflowSpawnMeta(request.meta)

    const spec: PersistedSubagentSpec = {
      agentId,
      requestId: deterministicRequestId,
      prompt: redact(request.prompt),
      ...(explicitLabel !== '' ? { label: redact(explicitLabel) } : {}),
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
      ...(request.cwd !== undefined ? { cwd: redact(request.cwd) } : {}),
      ...(request.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
      ...(request.gate !== undefined ? { gate: redact(request.gate) } : {}),
      ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
      ...(request.schema !== undefined ? { schema: redactJsonValue(request.schema, redact) as JsonSchema } : {}),
      ...(spawnMeta.maxSubagentDepth !== undefined ? { maxSubagentDepth: spawnMeta.maxSubagentDepth } : {}),
      ...(request.model !== undefined ? { model: redact(request.model) } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.fork !== undefined ? { fork: request.fork } : {}),
      ...(request.attachments !== undefined ? { attachments: request.attachments.map((a) => redact(a)) } : {}),
      ...(request.resume !== undefined ? { resume: request.resume } : {}),
    }

    const node: WorkflowNodeState = {
      id: 'subagent-0',
      kind: 'agent',
      label: name,
      status: 'running',
      startedAt: createdAt,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(request.gate !== undefined ? { gateCommand: redact(request.gate) } : {}),
    }

    const header: SubagentRunHeader = {
      id: runId,
      kind: 'subagent',
      name,
      conversationId: request.parentConversationId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      status: 'running',
      phase: 'running',
      createdAt,
      updatedAt: createdAt,
      notifyParentOnSettle: options?.notifyParentOnSettle ?? true,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(options?.replayedFrom !== undefined ? { replayedFrom: options.replayedFrom } : {}),
      nodes: [node],
    }
    const detail: RunDetail = {
      id: runId,
      subagentSpec: spec,
      nodes: [node],
    }

    const run = this.core.createActiveRun(header, detail)
    run.nodesByIndex.set(0, node)
    this.core.active.set(runId, run)
    try {
      await repo.saveDetail(request.parentConversationId, detail)
      repo.saveHeader(header)
      await repo.flush()
    } catch (error) {
      this.core.active.delete(runId)
      this.core.resolveActiveDone(run)
      throw error
    }
    this.core.emitEventSafe('workflow.updated', { run: this.core.liveSummaryOf(run) })

    const { horizonGate, preResolveError, getExecution } = this.driveSubagentRun(run, node, spec, {
      isReattach: false,
      originalRequest: request,
    })

    await horizonGate
    const earlyFailure = preResolveError()
    if (earlyFailure !== undefined) {
      // Wait for active run settlement to complete before throwing to caller (prevents active-map leak & write race).
      await run.done
      throw earlyFailure
    }

    const resolvedExec = getExecution()
    return {
      run: this.core.liveSummaryOf(run),
      ...(resolvedExec !== undefined ? { execution: resolvedExec } : {}),
    }
  }

  async resumeSubagentByRunId(
    replayHeader: SubagentRunHeader,
    replayDetail: RunDetail,
    request: WorkflowRunRequest,
    opts: {
      parentToolCallId?: string
      explicitLabel?: string
      notifyParentOnSettle?: boolean
      hasSources: boolean
    },
  ): Promise<WorkflowRunSummary> {
    if (opts.hasSources) {
      throw new HelmxError('validation_error', '对单子代理执行 resumeFromRunId 时不允许同时提供 name/script/scriptPath', 400)
    }
    const verdict = inspectRunResumability(replayHeader, replayDetail, this.core.resumabilityContext(), {
      mode: 'explicit_resume',
    })
    if (!verdict.resumable) {
      throw new HelmxError(verdict.code, verdict.reason, 400, { runId: replayHeader.id, status: replayHeader.status })
    }
    if (verdict.kind !== 'subagent' || verdict.resumeRef === undefined) {
      throw new HelmxError('validation_error', `后台子代理 ${replayHeader.id} 缺少可续接执行句柄或持久化规格`, 400)
    }
    assertResumeConversationMatch(replayHeader, request.conversationId)

    try {
      this.core.deps.host.getConversation(replayHeader.conversationId)
    } catch {
      throw new HelmxError('not_found', `会话 ${replayHeader.conversationId} 不存在`, 404)
    }

    const { spec, resumeRef } = verdict
    this.core.resumingLocks.add(replayHeader.id)
    try {
      const spawnReq: AgentSpawnRequest = {
        parentConversationId: replayHeader.conversationId,
        prompt: SUBAGENT_RESUME_PROMPT,
        resume: resumeRef,
        ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
        ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
        ...(spec.gate !== undefined ? { gate: spec.gate } : {}),
        ...(spec.gateTimeoutMs !== undefined ? { gateTimeoutMs: spec.gateTimeoutMs } : {}),
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        ...(spec.maxSubagentDepth !== undefined
          ? { meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: spec.maxSubagentDepth }) }
          : {}),
      }
      const started = await this.startBackgroundAgent(spawnReq, {
        ...(opts.parentToolCallId !== undefined ? { parentToolCallId: opts.parentToolCallId } : {}),
        ...(opts.explicitLabel !== undefined ? { label: opts.explicitLabel } : replayHeader.name !== '' ? { label: replayHeader.name } : {}),
        notifyParentOnSettle: opts.notifyParentOnSettle ?? true,
        replayedFrom: replayHeader.id,
      })
      return started.run
    } finally {
      this.core.resumingLocks.delete(replayHeader.id)
    }
  }

  reattachSubagentRun(header: SubagentRunHeader, detail: RunDetail): Promise<void> | undefined {
    const spec = detail.subagentSpec
    if (spec === undefined) {
      throw new HelmxError('missing_subagent_spec', `后台子代理 ${header.id} 缺少 subagentSpec，无法恢复`, 500)
    }
    const existingNode = detail.nodes?.[0] ?? header.nodes?.[0]
    const node: WorkflowNodeState = existingNode
      ? { ...existingNode, status: 'running' }
      : {
          id: 'subagent-0',
          kind: 'agent',
          label: header.name,
          status: 'running',
          startedAt: header.createdAt,
          ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
          ...(spec.gate !== undefined ? { gateCommand: spec.gate } : {}),
        }
    const run = this.core.createActiveRun(header, detail)
    run.nodesByIndex.set(0, node)
    for (const id of childIdsOfHeader(header)) run.childConversations.add(id)
    this.core.active.set(header.id, run)

    const { horizonGate } = this.driveSubagentRun(run, node, spec, { isReattach: true })
    // Only block start() for native conversationId reattach (so structuredOutputSessions bind before harness.resume()).
    return header.execution?.conversationId !== undefined ? horizonGate : undefined
  }

  private driveSubagentRun(
    run: ActiveRun,
    node: WorkflowNodeState,
    spec: PersistedSubagentSpec,
    mode: SubagentSpawnMode,
  ): {
    horizonGate: Promise<void>
    preResolveError: () => unknown
    getExecution: () => AgentExecutionInfo | undefined
  } {
    const { host, repo, redact } = this.core.deps
    const header = run.header as SubagentRunHeader
    let executionInfo: AgentExecutionInfo | undefined = header.execution
    let gateResult: AgentGateResult | undefined
    let onResolvedFired = false
    let earlyFailure: unknown
    let settledOnce = false

    let resolveHorizon: () => void = () => {}
    const horizonGate = new Promise<void>((r) => {
      resolveHorizon = r
    })

    const settleOnce = (outcome: { ok: true; raw: unknown } | { ok: false; error: unknown }): Promise<void> => {
      if (settledOnce) return Promise.resolve()
      settledOnce = true
      return this.settleSubagent({
        run,
        node,
        outcome,
        executionInfo,
        gateResult,
        agentId: spec.agentId,
        gateCommand: spec.gate,
      })
    }

    const originalRequest = mode.isReattach ? undefined : mode.originalRequest
    const parentSignal = originalRequest?.signal
    const onParentAbort = (): void => {
      if (settledOnce || this.core.isRunSuspending(run)) return
      if (!onResolvedFired) run.abort.abort()
    }
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    const detachParentSignal = () => parentSignal?.removeEventListener('abort', onParentAbort)

    run.abort.signal.addEventListener(
      'abort',
      () => {
        // Why: 已进入结算的 run 没有可中止的子会话也无需再 settle；`finishSettlement` 仍会把该信号当清理触发，
        // 而结算落盘尾部可能晚于 PluginHost dispose 执行，此时再读配置会抛 `plugin_host_disposed`。
        if (settledOnce) return
        if (!this.core.isRunSuspending(run)) {
          for (const childId of [...run.childConversations]) {
            abortChildConversation(host, run, childId)
          }
        }
        // Defer one microtask so an already-resolved spawnAgent completion wins cleanly over a concurrent suspend/abort.
        queueMicrotask(() => {
          void settleOnce({ ok: false, error: new HelmxError('aborted', '后台子代理执行已取消', 409) })
        })
      },
      { once: true },
    )

    const onResolved = (raw: unknown): void => {
      const info = sanitizeAgentExecutionInfo(raw, { agentId: spec.agentId })
      executionInfo = info
      if (info.nodeId !== undefined) node.nodeId = info.nodeId
      if (info.conversationId !== undefined) {
        node.conversationId = info.conversationId
        run.childConversations.add(info.conversationId)
        if (run.abort.signal.aborted && !this.core.isRunSuspending(run)) {
          abortChildConversation(host, run, info.conversationId)
        }
      }
      if (info.executionId !== undefined) node.executionId = info.executionId
      if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
      const wt = extractWorktreeExecutionMeta(info)
      if (wt.worktree !== undefined) node.worktree = wt.worktree
      const redactedExec = redactJsonValue(info, redact) as AgentExecutionInfo
      header.execution = redactedExec
      header.childConversationIds = [...run.childConversations]
      header.nodes = [node]
      header.updatedAt = Date.now()
      run.detail.nodes = [node]
      run.detail.subagentMeta = {
        ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
        execution: redactedExec,
      }
      repo.saveHeader(header)
      void repo
        .saveDetail(run.conversationId, run.detail)
        .then(() => repo.flush())
        .catch((e) => writeRedactedStderr(redact, `workflow ${run.runId}: flush onResolved failed`, e))
      this.core.emitEventSafe('workflow.updated', { run: this.core.liveSummaryOf(run) })
      onResolvedFired = true
      detachParentSignal()
      resolveHorizon()
      originalRequest?.onResolved?.(info)
    }

    const onGateResult = (raw: unknown): void => {
      const gate = sanitizeAgentGateResult(raw, { agentId: spec.agentId })
      gateResult = gate
      node.gate = {
        ok: gate.ok,
        output: redact(gate.output),
        ...(gate.exitCode !== undefined ? { exitCode: gate.exitCode } : {}),
        ...(gate.timedOut !== undefined ? { timedOut: gate.timedOut } : {}),
      }
      originalRequest?.onGateResult?.(gate)
    }

    const convId = mode.isReattach ? header.execution?.conversationId : undefined
    const proto: AgentSpawnRequest = mode.isReattach
      ? {
          parentConversationId: header.conversationId,
          prompt: spec.prompt,
          agentId: spec.agentId,
          requestId: spec.requestId,
          ...(header.parentToolCallId !== undefined ? { parentToolCallId: header.parentToolCallId } : {}),
          ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
          ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
          ...(spec.gate !== undefined ? { gate: spec.gate } : {}),
          ...(spec.gateTimeoutMs !== undefined ? { gateTimeoutMs: spec.gateTimeoutMs } : {}),
          ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
          ...(convId !== undefined
            ? {
                reattach: {
                  conversationId: convId,
                  ...(header.execution?.effectiveCwd !== undefined ? { effectiveCwd: header.execution.effectiveCwd } : {}),
                },
              }
            : {
                ...(spec.nodeId !== undefined ? { nodeId: spec.nodeId } : {}),
                ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
                ...(spec.model !== undefined ? { model: spec.model } : {}),
                ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
                ...(spec.fork !== undefined ? { fork: spec.fork } : {}),
                ...(spec.attachments !== undefined ? { attachments: spec.attachments } : {}),
                ...(spec.resume !== undefined ? { resume: spec.resume } : {}),
              }),
          meta: withWorkflowSpawnMeta(undefined, {
            runId: run.runId,
            ...(spec.maxSubagentDepth !== undefined ? { maxSubagentDepth: spec.maxSubagentDepth } : {}),
          }),
          onResolved,
          ...(spec.gate !== undefined ? { onGateResult } : {}),
          signal: run.abort.signal,
        }
      : {
          ...mode.originalRequest,
          ...(mode.originalRequest.title === undefined &&
          mode.originalRequest.resume === undefined &&
          mode.originalRequest.reattach === undefined
            ? { title: header.name }
            : {}),
          ...(header.parentToolCallId !== undefined ? { parentToolCallId: header.parentToolCallId } : {}),
          agentId: spec.agentId,
          requestId: spec.requestId,
          meta: withWorkflowSpawnMeta(mode.originalRequest.meta, { runId: run.runId }),
          onResolved,
          ...(spec.gate !== undefined ? { onGateResult } : {}),
          signal: run.abort.signal,
        }

    if (this.core.closed || this.core.isHostClosing() || parentSignal?.aborted) run.abort.abort()

    void (async () => {
      try {
        if (mode.isReattach && convId === undefined) await this.runtimeReadyGate
        if (run.abort.signal.aborted) throw new HelmxError('aborted', '后台子代理已取消', 409)
        const raw = await host.spawnAgent(proto)
        detachParentSignal()
        resolveHorizon()
        await settleOnce({ ok: true, raw })
      } catch (error) {
        detachParentSignal()
        if (!onResolvedFired) earlyFailure = error
        resolveHorizon()
        await settleOnce({ ok: false, error })
      }
    })()

    return {
      horizonGate,
      preResolveError: () => earlyFailure,
      getExecution: () => executionInfo,
    }
  }

  private async settleSubagent(options: SettleSubagentOptions): Promise<void> {
    const { run, node, outcome, executionInfo, gateResult, agentId, gateCommand } = options
    const { redact } = this.core.deps
    let effective = outcome
    if (effective.ok && run.abort.signal.aborted) {
      effective = { ok: false, error: new HelmxError('aborted', '后台子代理执行已取消', 409) }
    }
    if (effective.ok && gateResult !== undefined && !gateResult.ok) {
      effective = { ok: false, error: new HelmxError('gate_failed', gateResult.output, 502) }
    }
    if (effective.ok && gateCommand !== undefined && gateResult === undefined && executionInfo?.executionId !== undefined) {
      effective = {
        ok: false,
        error: agentGateResultMissingError({ agentId, executionId: executionInfo.executionId, command: gateCommand }),
      }
    }

    await this.core.executeSettlement(run, {
      applyOutcome: (hostClosing) => {
        const header = run.header as SubagentRunHeader
        const now = Date.now()
        const startedAt = node.startedAt ?? header.createdAt
        const completed = effective.ok && !run.abort.signal.aborted && !run.suspended
        const suspending = !completed && this.core.isRunSuspending(run)
        const aborted =
          !effective.ok &&
          (hostClosing ||
            run.abort.signal.aborted ||
            (effective.error instanceof HelmxError && effective.error.code === 'aborted'))

        if (suspending) {
          header.status = 'running'
          header.phase = 'suspended'
          node.status = 'running'
        } else if (effective.ok && completed) {
          const redactedVal = redactJsonValue(effective.raw, redact)
          node.status = 'done'
          node.settledAt = now
          node.durationMs = now - startedAt
          node.output = redactedVal
          header.status = 'completed'
          header.phase = 'settled'
          header.hasResult = true
          header.resultPreview = formatResultPreview(redactedVal)
          run.detail.result = redactedVal
          delete header.error
          delete header.errorCode
          delete header.resumable
        } else {
          // Honest status: aborted subagent node is 'aborted' (never mislabeled 'skipped').
          node.status = aborted ? 'aborted' : 'failed'
          node.settledAt = now
          node.durationMs = now - startedAt
          const message = effective.ok
            ? '宿主正在关停，后台子代理执行已中止'
            : effective.error instanceof HelmxError
              ? `[${effective.error.code}] ${effective.error.message}`
              : errorMessage(effective.error)
          const redactedMsg = redact(message)
          node.error = redactedMsg
          header.status = aborted ? 'aborted' : 'failed'
          header.phase = 'settled'
          header.error = redactedMsg
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(effective.ok ? undefined : effective.error, message, 'subagent_failed')
            header.resumable = inspectRunResumability(header, run.detail, this.core.resumabilityContext(), {
              mode: 'failed',
            }).resumable
          } else {
            delete header.errorCode
            delete header.resumable
          }
        }
        header.nodes = [node]
        run.detail.nodes = [node]
        return { suspending }
      },
      getNotifyInfo: () => {
        const header = run.header as SubagentRunHeader
        return {
          parentConversationId: run.conversationId,
          ...(header.agentType !== undefined ? { agentType: header.agentType } : {}),
          ...(executionInfo !== undefined ? { execution: redactJsonValue(executionInfo, redact) as AgentExecutionInfo } : {}),
        }
      },
    })
  }
}
