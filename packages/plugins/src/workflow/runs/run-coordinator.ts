/**
 * runs/run-coordinator.ts — Unified WorkflowService facade, RunCoordinator lifecycle & settlement,
 * SubagentDriver + DslDriver, and two-phase safe StartupRecovery.
 *
 * Replaces legacy service.ts + service-run.ts + service-recovery.ts + service-context.ts +
 * background-agent-runner.ts + run-settle.ts + run-progress.ts + run-summary.ts + active-run.ts
 * (~3,000L across 9 files) with one clear, race-free coordinator (~600L).
 */
import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import {
  HelmxError,
  agentGateResultMissingError,
  redactJsonValue,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
  type JsonSchema,
} from '@helmx/protocol'
import {
  extractWorktreeExecutionMeta,
  parseWorkflowSpawnMeta,
  withWorkflowSpawnMeta,
  type SavedWorkflowDetail,
  type SavedWorkflowSummary,
  type WorkflowDeleteResult,
  type WorkflowNodeState,
  type WorkflowRunRequest,
  type WorkflowRunSummary,
  type WorkflowSaveRequest,
  type WorkflowSaveResult,
} from '../../contracts.js'
import { isAutoRecoverEnvDisabled } from '../config.js'
import {
  defaultWorkflowConcurrency,
  JournalWriter,
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  redactJournalEntry,
  runWorkflow,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  type JournalReadResult,
  type WorkflowRunResult,
  type WorkflowRuntimeEvent,
} from '../dsl/index.js'
import { CancellationTracker } from './cancellation.js'
import { WorkflowLibrary } from './library-store.js'
import {
  classifyRunFailureCode,
  inspectRunResumability,
  type ResumabilityContext,
} from './resumability.js'
import {
  childIdsOfHeader,
  createMemoryKvStore,
  errorMessage,
  formatResultPreview,
  newRunId,
  RunRepository,
  type AnyWorkflowKvStore,
} from './run-repository.js'
import {
  abortChildConversation,
  buildEngineHost,
  deriveSubagentNameFromPrompt,
  type WorkflowServiceHost,
} from './spawn-bridge.js'
import type {
  ActiveRun,
  DslWorkflowRunHeader,
  PersistedSubagentSpec,
  RunDetail,
  RunHeader,
  SubagentRunHeader,
} from './types.js'

const SUBAGENT_RESUME_PROMPT = '前次执行中断或未通过验收，请检查当前工作区状态并继续完成原任务。'
const PROGRESS_PERSIST_INTERVAL_MS = 1_000
const NODE_EVENT_INTERVAL_MS = 250

export interface WorkflowServiceOptions {
  dataDir: string
  kv?: AnyWorkflowKvStore
  host: WorkflowServiceHost
  concurrency?: number
  agentCap?: number
  itemCap?: number
  nestedCap?: number
  redact?: (text: string) => string
  autoRecoverOnRestart?: boolean | (() => boolean)
  /** When true (plugin lifecycle), defers live DSL steps & outbox until `reconcile()` after `harness.resume()`. */
  deferReconcile?: boolean
  /** Fires when a newly saved `replayedFrom` run takes over a prior run, carrying the updated prior summary. */
  onTakeoverUpdated?: (priorSummary: WorkflowRunSummary) => void
}

type RecoveryPlanItem =
  | { kind: 'cleanup_only'; header: RunHeader; childIds: number[] }
  | { kind: 'fail_and_abort'; header: RunHeader; detail: RunDetail; code: string; reason: string; childIds: number[] }
  | {
      kind: 'reattach_subagent'
      header: SubagentRunHeader
      detail: RunDetail
    }
  | {
      kind: 'reattach_workflow'
      header: DslWorkflowRunHeader
      detail: RunDetail
      script: string
      journal: JournalReadResult
    }

export class WorkflowService {
  private readonly host: WorkflowServiceHost
  private readonly redact: (text: string) => string
  private readonly caps: { concurrency: number; agentCap: number; itemCap: number; nestedCap: number }
  private readonly repo: RunRepository
  private readonly library: WorkflowLibrary
  private readonly cancellation: CancellationTracker
  private readonly active = new Map<string, ActiveRun>()
  private readonly resumingLocks = new Set<string>()
  private readonly autoRecoverOption: boolean | (() => boolean) | undefined
  private readonly deferReconcile: boolean

  private closed = false
  private recoveryPrepared = false
  private recovered = false
  private initPromise?: Promise<void>
  private plannedItems: RecoveryPlanItem[] = []
  private readonly preparedChildIds = new Set<number>()
  private readonly pendingSettlementChildIds = new Set<number>()
  private pendingOutboxNotifies: Array<() => Promise<void>> = []
  private readonly runtimeReadyGate: Promise<void>
  private releaseRuntimeReady: () => void = () => {}

  constructor(options: WorkflowServiceOptions) {
    this.host = options.host
    this.redact = options.redact ?? ((text: string) => text)
    this.autoRecoverOption = options.autoRecoverOnRestart
    this.deferReconcile = options.deferReconcile === true
    const validatePositiveInt = (name: string, value: number): number => {
      if (!Number.isInteger(value) || value < 1) {
        throw new HelmxError('validation_error', `WorkflowService ${name} 必须为正整数，实得 ${value}`, 400)
      }
      return value
    }
    this.caps = {
      concurrency: validatePositiveInt('concurrency', options.concurrency ?? defaultWorkflowConcurrency()),
      agentCap: validatePositiveInt('agentCap', options.agentCap ?? WORKFLOW_AGENT_CAP),
      itemCap: validatePositiveInt('itemCap', options.itemCap ?? WORKFLOW_ITEM_CAP),
      nestedCap: validatePositiveInt('nestedCap', options.nestedCap ?? WORKFLOW_NESTED_CAP),
    }
    this.runtimeReadyGate = this.deferReconcile
      ? new Promise<void>((resolve) => {
          this.releaseRuntimeReady = resolve
        })
      : Promise.resolve()

    this.repo = new RunRepository({
      dataDir: options.dataDir,
      kv: options.kv ?? createMemoryKvStore<RunHeader>(),
      redact: this.redact,
      onTakeoverUpdated: options.onTakeoverUpdated,
    })
    this.library = new WorkflowLibrary(options.dataDir)
    this.cancellation = new CancellationTracker({
      active: this.active,
      parentConversationOf: (id) => this.host.getConversation(id).parentConversationId,
    })
  }

  isAutoRecoverOnRestart(): boolean {
    if (this.autoRecoverOption === false) return false
    if (typeof this.autoRecoverOption === 'function' && !this.autoRecoverOption()) return false
    return !isAutoRecoverEnvDisabled()
  }

  isHostClosing(): boolean {
    return this.host.isHostClosing?.() === true
  }

  private isRunSuspending(run: ActiveRun): boolean {
    return (
      run.suspended === true ||
      (this.isAutoRecoverOnRestart() && this.isHostClosing() && run.userAborted !== true)
    )
  }

  private assertNotClosed(): void {
    if (this.closed) throw new HelmxError('service_closed', 'WorkflowService is closed', 409)
  }

  private resumabilityContext(): ResumabilityContext {
    return {
      getTakenOverBy: (runId) => this.repo.getTakenOverBy(runId),
      readScriptFile: (scriptPath) => this.library.readScriptFile(scriptPath),
    }
  }

  // -------------------------------------------------------------------------
  // Library facade
  // -------------------------------------------------------------------------

  list(): SavedWorkflowSummary[] {
    return this.library.list()
  }

  get(name: string): SavedWorkflowDetail {
    return this.library.get(name)
  }

  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    return this.library.save(request)
  }

  delete(name: string): WorkflowDeleteResult {
    return this.library.delete(name)
  }

  // -------------------------------------------------------------------------
  // Query facade (zero-IO listRuns, lazy-detail getRun)
  // -------------------------------------------------------------------------

  listActiveRuns(): WorkflowRunSummary[] {
    return [...this.active.values()]
      .map((r) => this.liveSummaryOf(r))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Zero-IO memory scan of all run headers (active runs overlaid with live node state). */
  listRuns(): WorkflowRunSummary[] {
    const headers = this.repo.listHeaders()
    const out: WorkflowRunSummary[] = []
    const seen = new Set<string>()
    for (const active of this.active.values()) {
      seen.add(active.runId)
      out.push(this.liveSummaryOf(active))
    }
    for (const header of headers) {
      if (seen.has(header.id)) continue
      seen.add(header.id)
      out.push(this.repo.summaryOfHeader(header))
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  /** Full inspect summary: active memory first, otherwise RunHeader + lazy RunDetail. */
  getRun(runId: string): WorkflowRunSummary {
    const active = this.active.get(runId)
    if (active !== undefined) return this.liveSummaryOf(active)
    const header = this.repo.getHeader(runId)
    return this.repo.fullSummaryOf(header)
  }

  findRunByParentToolCall(conversationId: number, parentToolCallId: string): RunHeader | undefined {
    if (parentToolCallId === '') return undefined
    for (const active of this.active.values()) {
      if (active.conversationId === conversationId && active.header.parentToolCallId === parentToolCallId) {
        return active.header
      }
    }
    return this.repo.findByParentToolCall(conversationId, parentToolCallId)
  }

  loadRunHeaderAndDetail(runId: string): { header: RunHeader; detail: RunDetail } {
    const active = this.active.get(runId)
    if (active !== undefined) return { header: active.header, detail: active.detail }
    const header = this.repo.getHeader(runId)
    return { header, detail: this.repo.loadDetail(header) }
  }

  inspectResumability(runId: string): { resumable: true } | { resumable: false; reason: string } {
    const { header, detail } = this.loadRunHeaderAndDetail(runId)
    const verdict = inspectRunResumability(header, detail, this.resumabilityContext())
    return verdict.resumable ? { resumable: true } : { resumable: false, reason: verdict.reason }
  }

  async wait(runId: string): Promise<unknown> {
    const active = this.active.get(runId)
    if (active !== undefined) {
      await active.done
      if (active.settleError !== undefined) throw active.settleError
    }
    return this.getRun(runId).result
  }

  // -------------------------------------------------------------------------
  // Cancellation & shutdown
  // -------------------------------------------------------------------------

  isConversationCancelling(conversationId: number): boolean {
    return this.cancellation.isCancelling(conversationId)
  }

  /** Abort one run and its descendant subtree; NEVER marks the parent conversation as cancelling. */
  async abort(runId: string): Promise<void> {
    const activeRun = this.active.get(runId)
    if (activeRun === undefined) {
      this.repo.getHeader(runId) // 404 if absent; idempotent no-op for historical terminal runs.
      return
    }
    await this.cancellation.cancelBoundary(`run:${runId}`, [...activeRun.childConversations], (run, isWithin, seeds) => {
      if (run === activeRun) return true
      for (const seed of seeds) {
        if (isWithin(run.conversationId, seed)) return true
      }
      return false
    })
    if (activeRun.settleError !== undefined) throw activeRun.settleError
  }

  async cancelRunsUnderConversation(conversationId: number): Promise<void> {
    if (this.isHostClosing() && this.isAutoRecoverOnRestart()) return
    await this.cancellation.cancelBoundary(`conv:${conversationId}`, [conversationId], (run, isWithin) =>
      isWithin(run.conversationId, conversationId),
    )
  }

  async suspend(): Promise<void> {
    this.closed = true
    this.releaseRuntimeReady()
    const inFlight = [...this.active.values()]
    for (const run of inFlight) {
      run.suspended = true
      run.abort.abort()
    }
    await Promise.all(inFlight.map((r) => r.done))
    await this.repo.flush()
  }

  async close(): Promise<void> {
    this.closed = true
    this.releaseRuntimeReady()
    const inFlight = [...this.active.values()]
    for (const run of inFlight) {
      run.userAborted = true
      run.abort.abort()
    }
    await Promise.all(inFlight.map((r) => r.done))
    await this.repo.flush()
  }

  // -------------------------------------------------------------------------
  // Two-phase safe StartupRecovery (prepare -> init [start] -> reconcile)
  // -------------------------------------------------------------------------

  /** Phase 1 (global prepare barrier, before harness.resume): compute plan once and lay durable abort markers. */
  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    const autoRecover = this.isAutoRecoverOnRestart()
    const headers = this.repo.listHeaders()
    const plan: RecoveryPlanItem[] = []
    const abortChildIds = new Set<number>()

    for (const header of headers) {
      if (header.phase === 'settled') continue
      if (header.phase === 'cleanup_pending') {
        const childIds = childIdsOfHeader(header)
        for (const id of childIds) abortChildIds.add(id)
        plan.push({ kind: 'cleanup_only', header, childIds })
        continue
      }
      // header.phase === 'running' | 'suspended'
      const detail = this.repo.loadDetail(header)
      const childIds = childIdsOfHeader(header)
      if (!autoRecover) {
        const reason =
          header.kind === 'subagent'
            ? 'subagent run interrupted by process restart（可凭 conversationId 通过 resume 续接）'
            : `run interrupted by process restart（账本完好，可经 resumeFromRunId 恢复）：${header.error ?? ''}`.trim()
        for (const id of childIds) abortChildIds.add(id)
        plan.push({ kind: 'fail_and_abort', header, detail, code: 'interrupted', reason, childIds })
        continue
      }

      const verdict = inspectRunResumability(header, detail, this.resumabilityContext(), { mode: 'startup_in_place' })
      if (!verdict.resumable) {
        for (const id of childIds) abortChildIds.add(id)
        plan.push({ kind: 'fail_and_abort', header, detail, code: verdict.code, reason: verdict.reason, childIds })
        continue
      }

      try {
        this.host.getConversation(header.conversationId)
      } catch (error) {
        const kindLabel = header.kind === 'subagent' ? 'subagent' : '工作流'
        const code = error instanceof HelmxError && error.code !== '' ? error.code : 'parent_conversation_unavailable'
        for (const id of childIds) abortChildIds.add(id)
        plan.push({
          kind: 'fail_and_abort',
          header,
          detail,
          code,
          reason: `${kindLabel} 所属父会话 ${header.conversationId} 不可用，无法恢复：${errorMessage(error)}`,
          childIds,
        })
        continue
      }

      if (header.kind === 'subagent') {
        plan.push({ kind: 'reattach_subagent', header, detail })
      } else {
        plan.push({
          kind: 'reattach_workflow',
          header,
          detail,
          script: verdict.script!,
          journal: verdict.journal!,
        })
      }
    }

    for (const id of abortChildIds) {
      try {
        await this.host.abortConversationGuarded(id)
      } catch (error) {
        if (error instanceof HelmxError && (error.code === 'not_found' || error.code === 'ownership_conflict')) {
          process.stderr.write(`workflow prepareRecovery: skip conversation ${id} (${error.code})\n`)
          continue
        }
        throw error
      }
    }
    for (const id of abortChildIds) this.preparedChildIds.add(id)
    this.plannedItems = plan
    this.recoveryPrepared = true
  }

  /** Phase 2 (service.start, before harness.resume): fail unrecoverable items, register ActiveRuns & pre-reattach native children. */
  async init(): Promise<void> {
    if (this.recovered) return
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = (async () => {
      try {
        await this.prepareRecovery()
        const reattachHorizons: Promise<void>[] = []
        let changed = false

        // Queue outbox notifications for already-settled runs that never finished notifying.
        for (const header of this.repo.listHeaders()) {
          if (header.phase === 'settled' && header.notifyParentOnSettle === true && header.notifiedAt === undefined) {
            this.queueOutboxNotify(header, this.repo.loadDetail(header))
          }
        }

        for (const item of this.plannedItems) {
          if (item.kind === 'cleanup_only') {
            for (const id of item.childIds) this.pendingSettlementChildIds.add(id)
            item.header.phase = 'settled'
            item.header.updatedAt = Date.now()
            this.repo.saveHeader(item.header)
            if (item.header.notifyParentOnSettle === true && item.header.notifiedAt === undefined) {
              this.queueOutboxNotify(item.header, this.repo.loadDetail(item.header))
            }
            changed = true
            continue
          }

          if (item.kind === 'fail_and_abort') {
            for (const id of item.childIds) this.pendingSettlementChildIds.add(id)
            const now = Date.now()
            item.header.status = 'failed'
            item.header.phase = 'settled'
            item.header.updatedAt = now
            if (item.header.settledAt === undefined) item.header.settledAt = now
            item.header.errorCode = item.code
            item.header.error = this.redact(item.reason)
            if (item.code === 'crash_recovery_limit') {
              item.header.crashRecoveries = (item.header.crashRecoveries ?? 0) + 1
            }
            const updateNodes = (nodes: WorkflowNodeState[] | undefined) =>
              nodes?.map((n) =>
                n.status === 'running' || n.status === 'pending'
                  ? { ...n, status: 'failed' as const, settledAt: now, error: item.header.error }
                  : n,
              )
            item.header.nodes = updateNodes(item.header.nodes)
            item.detail.nodes = updateNodes(item.detail.nodes)
            item.header.resumable = inspectRunResumability(
              item.header,
              item.detail,
              this.resumabilityContext(),
              { mode: 'failed' },
            ).resumable
            this.repo.saveDetail(item.header.conversationId, item.detail)
            this.repo.saveHeader(item.header)
            changed = true
            if (item.header.notifyParentOnSettle === true && item.header.notifiedAt === undefined) {
              this.queueOutboxNotify(item.header, item.detail)
            }
            this.emitEventSafe('workflow.updated', { run: this.repo.summaryOfHeader(item.header) })
            continue
          }

          // Reattachable run: clear suspended or increment crash counter once, then mount ActiveRun synchronously.
          if (item.header.phase === 'suspended') {
            item.header.phase = 'running'
          } else {
            item.header.crashRecoveries = (item.header.crashRecoveries ?? 0) + 1
            item.header.phase = 'running'
          }
          item.header.updatedAt = Date.now()
          this.repo.saveHeader(item.header)
          changed = true

          if (item.kind === 'reattach_subagent') {
            const horizon = this.reattachSubagentRun(item.header, item.detail)
            if (horizon !== undefined) reattachHorizons.push(horizon)
            continue
          }

          const horizon = this.reattachWorkflowRun(item.header, item.detail, item.script, item.journal)
          if (horizon !== undefined) reattachHorizons.push(horizon)
        }

        if (changed) await this.repo.flush()
        this.plannedItems = []
        if (reattachHorizons.length > 0) await Promise.allSettled(reattachHorizons)
        this.recovered = true

        if (!this.deferReconcile) {
          this.releaseRuntimeReady()
          await this.awaitPreparedChildrenSettled()
          await this.flushOutboxNotifies()
        }
      } catch (error) {
        this.recoveryPrepared = false
        this.plannedItems = []
        this.pendingOutboxNotifies = []
        this.repo.invalidate()
        throw error
      } finally {
        if (!this.recovered) this.initPromise = undefined
      }
    })()
    return this.initPromise
  }

  /** Phase 3 (service.reconcile, after harness.resume): release live DSL gate, settle aborted children, flush outbox. */
  async reconcile(): Promise<void> {
    this.releaseRuntimeReady()
    await this.awaitPreparedChildrenSettled()
    await this.flushOutboxNotifies()
  }

  async awaitPreparedChildrenSettled(): Promise<void> {
    const ids = new Set<number>([...this.preparedChildIds, ...this.pendingSettlementChildIds])
    if (ids.size === 0) return
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          await this.host.abortConversationGuarded(id)
          this.preparedChildIds.delete(id)
          this.pendingSettlementChildIds.delete(id)
        } catch (error) {
          if (error instanceof HelmxError && (error.code === 'not_found' || error.code === 'ownership_conflict')) {
            this.preparedChildIds.delete(id)
            this.pendingSettlementChildIds.delete(id)
            return
          }
          process.stderr.write(`workflow reconcile: guarded abort conversation ${id} failed: ${errorMessage(error)}\n`)
        }
      }),
    )
  }

  private queueOutboxNotify(header: RunHeader, detail: RunDetail): void {
    this.pendingOutboxNotifies.push(async () => {
      if (this.host.onBackgroundAgentSettled === undefined) return
      const summary = this.repo.fullSummaryOf(header, detail)
      const info =
        header.kind === 'subagent'
          ? {
              parentConversationId: header.conversationId,
              ...(header.agentType !== undefined ? { agentType: header.agentType } : {}),
              ...(header.execution !== undefined ? { execution: header.execution } : {}),
            }
          : { parentConversationId: header.conversationId }
      await this.host.onBackgroundAgentSettled(summary, info)
      header.notifiedAt = Date.now()
      this.repo.saveHeader(header)
    })
  }

  private async flushOutboxNotifies(): Promise<void> {
    const notifies = this.pendingOutboxNotifies
    this.pendingOutboxNotifies = []
    if (notifies.length === 0) return
    for (const fn of notifies) {
      try {
        await fn()
      } catch (error) {
        process.stderr.write(`workflow outbox notify failed: ${errorMessage(error)}\n`)
      }
    }
    try {
      await this.repo.flush()
    } catch (error) {
      process.stderr.write(`workflow outbox flush failed: ${errorMessage(error)}\n`)
    }
  }

  // -------------------------------------------------------------------------
  // Launching DSL workflows & resuming failed runs
  // -------------------------------------------------------------------------

  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean },
  ): Promise<WorkflowRunSummary> {
    this.assertNotClosed()
    await this.init()

    const parentToolCallId =
      typeof context?.parentToolCallId === 'string' && context.parentToolCallId !== ''
        ? context.parentToolCallId
        : undefined
    if (request.label !== undefined && (typeof request.label !== 'string' || request.label.trim() === '')) {
      throw new HelmxError('validation_error', 'label 必须为非空字符串', 400, { label: request.label })
    }
    const explicitLabel = request.label !== undefined ? this.redact(request.label.trim()) : undefined

    const sources = [request.name, request.script, request.scriptPath].filter((v) => v !== undefined)
    if (sources.length > 1) {
      throw new HelmxError(
        'validation_error',
        'exactly one of name, script, scriptPath must be provided (or omit all to reuse the old script with resumeFromRunId)',
        400,
        { provided: sources.length },
      )
    }

    let replayHeader: RunHeader | undefined
    let replayDetail: RunDetail | undefined
    if (request.resumeFromRunId !== undefined) {
      const loaded = this.loadRunHeaderAndDetail(request.resumeFromRunId)
      replayHeader = loaded.header
      replayDetail = loaded.detail
      if (request.conversationId !== undefined && request.conversationId !== replayHeader.conversationId) {
        const targetLabel = replayHeader.kind === 'subagent' ? '子代理' : '工作流'
        throw new HelmxError(
          'validation_error',
          `恢复目标不匹配：${targetLabel} ${replayHeader.id} 属于会话 ${replayHeader.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
          400,
          { runId: replayHeader.id, recordedConversationId: replayHeader.conversationId, requestedConversationId: request.conversationId },
        )
      }
      if (this.active.has(replayHeader.id)) {
        throw new HelmxError('conflict', `工作流 ${replayHeader.id} 仍在运行中`, 409, { runId: replayHeader.id })
      }
      const existingTakeover = this.repo.getTakenOverBy(replayHeader.id)
      if (existingTakeover !== undefined || this.resumingLocks.has(replayHeader.id)) {
        throw new HelmxError(
          'conflict',
          `运行 ${replayHeader.id} 已被 ${existingTakeover ?? '并发请求'} 接管续跑`,
          409,
          { runId: replayHeader.id, ...(existingTakeover !== undefined ? { resumedByRunId: existingTakeover } : {}) },
        )
      }

      if (replayHeader.kind === 'subagent') {
        return this.resumeSubagentByRunId(replayHeader, replayDetail, request, {
          parentToolCallId,
          explicitLabel,
          notifyParentOnSettle: context?.notifyParentOnSettle,
          hasSources: sources.length > 0,
        })
      }
    }

    const conversationId = request.conversationId ?? replayHeader?.conversationId
    if (conversationId === undefined) {
      throw new HelmxError('validation_error', '缺少工作流目标会话：提供 conversationId，或从 CLI 使用 --current', 400)
    }
    if (replayHeader !== undefined && request.conversationId !== undefined && request.conversationId !== replayHeader.conversationId) {
      throw new HelmxError(
        'validation_error',
        `恢复目标不匹配：工作流 ${replayHeader.id} 属于会话 ${replayHeader.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
        400,
        { runId: replayHeader.id, recordedConversationId: replayHeader.conversationId, requestedConversationId: request.conversationId },
      )
    }

    let parent: ConversationSummary
    try {
      parent = this.host.getConversation(conversationId)
    } catch {
      throw new HelmxError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, { conversationId })
    }

    let script = ''
    let scriptPath: string | undefined
    let savedName: string | undefined
    let replayEntries: readonly import('../dsl/index.js').WorkflowJournalEntry[] = []
    let resumeJournalIoErrors: string[] | undefined

    if (request.script !== undefined) {
      script = request.script
    } else if (request.name !== undefined) {
      savedName = request.name
      scriptPath = this.library.resolveSavedName(request.name)
      script = this.library.readScriptFile(scriptPath)
    } else if (request.scriptPath !== undefined) {
      scriptPath = this.library.resolveExplicitPath(request.scriptPath)
      script = this.library.readScriptFile(scriptPath)
    } else if (replayHeader === undefined) {
      throw new HelmxError('validation_error', '必须提供 name、script 或 scriptPath 之一', 400)
    }

    if (replayHeader !== undefined && replayDetail !== undefined) {
      const verdict = inspectRunResumability(replayHeader, replayDetail, this.resumabilityContext(), {
        mode: 'explicit_resume',
        hasExplicitScriptOverride: sources.length > 0,
      })
      if (!verdict.resumable) {
        const status = verdict.code === 'validation_error' ? 400 : 409
        throw new HelmxError(verdict.code, verdict.reason, status, {
          priorRunId: replayHeader.id,
          ...(verdict.journal?.readFailed ?? {}),
        })
      }
      if (sources.length === 0) {
        script = verdict.script!
        scriptPath = verdict.scriptPath
        savedName = verdict.savedName
      }
      const journal = verdict.journal!
      replayEntries = journal.entries
      if (journal.ioErrors > 0) {
        resumeJournalIoErrors = [`journal ${replayHeader.id} has ${journal.ioErrors} corrupt/unreadable line(s)`]
      }
    }

    if (script.length > MAX_SCRIPT_LENGTH) {
      throw new HelmxError('validation_error', `工作流脚本 ${script.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`, 400)
    }

    const args =
      request.args !== undefined
        ? normalizeWorkflowArgs(request.args)
        : replayDetail?.args !== undefined
          ? replayDetail.args
          : undefined

    const runId = newRunId()
    const createdAt = Date.now()
    mkdirSync(this.repo.artifactsDir(conversationId), { recursive: true })
    const journalPath = this.repo.journalPathFor(conversationId, runId)
    const meta = this.library.peekMeta(script)
    const scriptBase = scriptPath !== undefined ? basename(scriptPath, '.js') : undefined
    const notifyParentOnSettle =
      context?.notifyParentOnSettle === true ||
      (context?.notifyParentOnSettle === undefined && replayHeader?.notifyParentOnSettle === true)

    const header: DslWorkflowRunHeader = {
      id: runId,
      kind: 'workflow',
      name: explicitLabel ?? meta?.name ?? replayHeader?.name ?? (scriptBase || runId),
      conversationId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      status: 'running',
      phase: 'running',
      createdAt,
      updatedAt: createdAt,
      journalPath,
      ...(notifyParentOnSettle ? { notifyParentOnSettle: true } : {}),
      ...(meta?.description !== undefined ? { description: this.redact(meta.description) } : {}),
      ...(meta?.phases !== undefined ? { phases: redactJsonValue(meta.phases, this.redact) as DslWorkflowRunHeader['phases'] } : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
      ...(replayHeader !== undefined ? { replayedFrom: replayHeader.id } : {}),
    }
    const detail: RunDetail = {
      id: runId,
      ...(scriptPath === undefined ? { script } : {}),
      ...(args !== undefined ? { args: redactJsonValue(args, this.redact) } : {}),
    }

    if (replayHeader !== undefined) this.resumingLocks.add(replayHeader.id)
    try {
      this.assertNotClosed()
      this.cancellation.assertNotCancelling(conversationId)
      const writer = new JournalWriter(journalPath)
      const run = this.createActiveRun(header, detail, writer)
      this.active.set(runId, run)
      try {
        this.repo.saveDetail(conversationId, detail)
        this.repo.saveHeader(header)
        await this.repo.flush()
      } catch (error) {
        await writer.close().catch(() => {})
        this.active.delete(runId)
        this.resolveActiveDone(run)
        throw error
      }
      this.emitEventSafe('workflow.updated', { run: this.liveSummaryOf(run) })
      this.driveWorkflowRun(run, parent, {
        script,
        args,
        replayEntries,
        inPlaceResume: false,
        retryFailedCalls: replayHeader?.status === 'failed',
        resumeJournalIoErrors,
      })
      return this.liveSummaryOf(run)
    } finally {
      if (replayHeader !== undefined) this.resumingLocks.delete(replayHeader.id)
    }
  }

  private async resumeSubagentByRunId(
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
    const verdict = inspectRunResumability(replayHeader, replayDetail, this.resumabilityContext(), { mode: 'explicit_resume' })
    if (!verdict.resumable) {
      throw new HelmxError(verdict.code, verdict.reason, 400, { runId: replayHeader.id, status: replayHeader.status })
    }
    if (request.conversationId !== undefined && request.conversationId !== replayHeader.conversationId) {
      throw new HelmxError(
        'validation_error',
        `恢复目标不匹配：子代理 ${replayHeader.id} 属于会话 ${replayHeader.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
        400,
      )
    }
    try {
      this.host.getConversation(replayHeader.conversationId)
    } catch {
      throw new HelmxError('not_found', `会话 ${replayHeader.conversationId} 不存在`, 404)
    }

    const spec = replayDetail.subagentSpec!
    this.resumingLocks.add(replayHeader.id)
    try {
      const spawnReq: AgentSpawnRequest = {
        parentConversationId: replayHeader.conversationId,
        prompt: SUBAGENT_RESUME_PROMPT,
        resume: verdict.resumeRef!,
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
      this.resumingLocks.delete(replayHeader.id)
    }
  }

  // -------------------------------------------------------------------------
  // Background single-subagent driver (unified with RunCoordinator settlement)
  // -------------------------------------------------------------------------

  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
      replayedFrom?: string
    },
  ): Promise<{ run: WorkflowRunSummary; execution?: AgentExecutionInfo }> {
    this.assertNotClosed()
    await this.init()
    this.assertNotClosed()
    this.host.getConversation(request.parentConversationId)
    if (request.signal?.aborted) throw new HelmxError('aborted', 'spawn 请求在创建前已取消', 409)
    this.cancellation.assertNotCancelling(request.parentConversationId)

    const runId = newRunId()
    const createdAt = Date.now()
    const parentToolCallId =
      options?.parentToolCallId || request.parentToolCallId || undefined
    const explicitLabel = options?.label?.trim() ?? ''
    const resolvedName =
      explicitLabel !== ''
        ? this.redact(explicitLabel)
        : deriveSubagentNameFromPrompt(request.prompt, this.redact)
    const name = resolvedName || (request.agentType ? `subagent:${request.agentType}` : 'subagent')
    const agentId = request.agentId ?? `${runId}:subagent-0`
    const deterministicRequestId = request.requestId ?? `helmx:spawn:${runId}`
    const spawnMeta = parseWorkflowSpawnMeta(request.meta)

    const spec: PersistedSubagentSpec = {
      agentId,
      requestId: deterministicRequestId,
      prompt: this.redact(request.prompt),
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(request.nodeId !== undefined ? { nodeId: request.nodeId } : {}),
      ...(request.cwd !== undefined ? { cwd: this.redact(request.cwd) } : {}),
      ...(request.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
      ...(request.gate !== undefined ? { gate: this.redact(request.gate) } : {}),
      ...(request.gateTimeoutMs !== undefined ? { gateTimeoutMs: request.gateTimeoutMs } : {}),
      ...(request.schema !== undefined ? { schema: redactJsonValue(request.schema, this.redact) as JsonSchema } : {}),
      ...(spawnMeta.maxSubagentDepth !== undefined ? { maxSubagentDepth: spawnMeta.maxSubagentDepth } : {}),
      ...(request.model !== undefined ? { model: this.redact(request.model) } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.fork !== undefined ? { fork: request.fork } : {}),
      ...(request.attachments !== undefined ? { attachments: request.attachments.map((a) => this.redact(a)) } : {}),
      ...(request.resume !== undefined ? { resume: request.resume } : {}),
    }

    const node: WorkflowNodeState = {
      id: 'subagent-0',
      kind: 'agent',
      label: name,
      status: 'running',
      startedAt: createdAt,
      ...(request.agentType ? { agentType: request.agentType } : {}),
      ...(request.gate !== undefined ? { gateCommand: this.redact(request.gate) } : {}),
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

    const run = this.createActiveRun(header, detail)
    run.nodesByIndex.set(0, node)
    this.active.set(runId, run)
    try {
      this.repo.saveDetail(request.parentConversationId, detail)
      this.repo.saveHeader(header)
      await this.repo.flush()
    } catch (error) {
      this.active.delete(runId)
      this.resolveActiveDone(run)
      throw error
    }
    this.emitEventSafe('workflow.updated', { run: this.liveSummaryOf(run) })

    const { horizonGate, preResolveError, getExecution } = this.driveSubagentRun(run, node, spec, {
      originalRequest: request,
      isReattach: false,
    })

    await horizonGate
    const earlyFailure = preResolveError()
    if (earlyFailure !== undefined) {
      // CRITICAL FIX: wait for active run settlement to complete before throwing to caller (prevents active-map leak & write race).
      await run.done
      throw earlyFailure
    }

    const resolvedExec = getExecution()
    return {
      run: this.liveSummaryOf(run),
      ...(resolvedExec !== undefined ? { execution: resolvedExec } : {}),
    }
  }

  private driveSubagentRun(
    run: ActiveRun,
    node: WorkflowNodeState,
    spec: PersistedSubagentSpec,
    opts: { originalRequest?: AgentSpawnRequest; isReattach: boolean },
  ): {
    horizonGate: Promise<void>
    preResolveError: () => unknown
    getExecution: () => AgentExecutionInfo | undefined
  } {
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
      return this.settleSubagent(run, node, outcome, executionInfo, gateResult, spec.agentId, spec.gate)
    }

    const parentSignal = opts.originalRequest?.signal
    const onParentAbort = (): void => {
      if (settledOnce || this.isRunSuspending(run)) return
      if (!onResolvedFired) run.abort.abort()
    }
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    const detachParentSignal = () => parentSignal?.removeEventListener('abort', onParentAbort)

    run.abort.signal.addEventListener(
      'abort',
      () => {
        if (!this.isRunSuspending(run)) {
          for (const childId of [...run.childConversations]) {
            abortChildConversation(this.host, run, childId)
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
        if (run.abort.signal.aborted && !this.isRunSuspending(run)) {
          abortChildConversation(this.host, run, info.conversationId)
        }
      }
      if (info.executionId !== undefined) node.executionId = info.executionId
      if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
      const wt = extractWorktreeExecutionMeta(info)
      if (wt.worktree !== undefined) node.worktree = wt.worktree
      const redactedExec = redactJsonValue(info, this.redact) as AgentExecutionInfo
      header.execution = redactedExec
      header.childConversationIds = [...run.childConversations]
      header.nodes = [node]
      header.updatedAt = Date.now()
      run.detail.nodes = [node]
      run.detail.subagentMeta = {
        ...(spec.agentType !== undefined ? { agentType: spec.agentType } : {}),
        execution: redactedExec,
      }
      this.repo.saveDetail(run.conversationId, run.detail)
      this.repo.saveHeader(header)
      void this.repo.flush().catch((e) => process.stderr.write(`workflow ${run.runId}: flush onResolved failed: ${errorMessage(e)}\n`))
      this.emitEventSafe('workflow.updated', { run: this.liveSummaryOf(run) })
      onResolvedFired = true
      detachParentSignal()
      resolveHorizon()
      opts.originalRequest?.onResolved?.(info)
    }

    const onGateResult = (raw: unknown): void => {
      const gate = sanitizeAgentGateResult(raw, { agentId: spec.agentId })
      gateResult = gate
      node.gate = {
        ok: gate.ok,
        output: this.redact(gate.output),
        ...(gate.exitCode !== undefined ? { exitCode: gate.exitCode } : {}),
        ...(gate.timedOut !== undefined ? { timedOut: gate.timedOut } : {}),
      }
      opts.originalRequest?.onGateResult?.(gate)
    }

    const convId = opts.isReattach ? header.execution?.conversationId : undefined
    const proto: AgentSpawnRequest = opts.isReattach
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
          ...opts.originalRequest!,
          ...(opts.originalRequest!.title === undefined && opts.originalRequest!.resume === undefined && opts.originalRequest!.reattach === undefined
            ? { title: header.name }
            : {}),
          ...(header.parentToolCallId !== undefined ? { parentToolCallId: header.parentToolCallId } : {}),
          agentId: spec.agentId,
          requestId: spec.requestId,
          meta: withWorkflowSpawnMeta(opts.originalRequest!.meta, { runId: run.runId }),
          onResolved,
          ...(spec.gate !== undefined ? { onGateResult } : {}),
          signal: run.abort.signal,
        }

    if (this.closed || this.isHostClosing() || parentSignal?.aborted) run.abort.abort()

    void (async () => {
      try {
        if (opts.isReattach && convId === undefined) await this.runtimeReadyGate
        if (run.abort.signal.aborted) throw new HelmxError('aborted', '后台子代理已取消', 409)
        const raw = await this.host.spawnAgent(proto)
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

  private reattachSubagentRun(header: SubagentRunHeader, detail: RunDetail): Promise<void> | undefined {
    const spec = detail.subagentSpec!
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
    const run = this.createActiveRun(header, detail)
    run.nodesByIndex.set(0, node)
    for (const id of childIdsOfHeader(header)) run.childConversations.add(id)
    this.active.set(header.id, run)

    const { horizonGate } = this.driveSubagentRun(run, node, spec, { isReattach: true })
    // Only block start() for native conversationId reattach (so structuredOutputSessions bind before harness.resume()).
    return header.execution?.conversationId !== undefined ? horizonGate : undefined
  }

  // -------------------------------------------------------------------------
  // DSL driver & two-phase native pre-reattach
  // -------------------------------------------------------------------------

  private reattachWorkflowRun(
    header: DslWorkflowRunHeader,
    detail: RunDetail,
    script: string,
    journal: JournalReadResult,
  ): Promise<void> {
    const parent = this.host.getConversation(header.conversationId)
    const initialSeq = journal.entries.reduce((max, item) => Math.max(max, item.seq + 1), 0)
    const writer = new JournalWriter(header.journalPath, true, initialSeq)
    const run = this.createActiveRun(header, detail, writer)
    if (detail.progress) run.timeline = [...detail.progress]
    for (const id of childIdsOfHeader(header)) run.childConversations.add(id)
    this.active.set(header.id, run)

    let resolveHorizon: () => void = () => {}
    const horizonGate = new Promise<void>((r) => {
      resolveHorizon = r
    })
    const resumeJournalIoErrors =
      journal.ioErrors > 0 ? [`journal ${header.id} has ${journal.ioErrors} corrupt/unreadable line(s)`] : undefined

    this.driveWorkflowRun(run, parent, {
      script,
      args: detail.args,
      replayEntries: journal.entries,
      inPlaceResume: true,
      retryFailedCalls: false,
      resumeJournalIoErrors,
      runtimeReadyGate: this.runtimeReadyGate,
      onReattachHorizon: resolveHorizon,
    })

    return horizonGate
  }

  private driveWorkflowRun(
    run: ActiveRun,
    parent: ConversationSummary,
    opts: {
      script: string
      args?: unknown
      replayEntries: readonly import('../dsl/index.js').WorkflowJournalEntry[]
      inPlaceResume: boolean
      retryFailedCalls: boolean
      resumeJournalIoErrors?: string[]
      runtimeReadyGate?: Promise<void>
      onReattachHorizon?: () => void
    },
  ): void {
    const engineHost = buildEngineHost(
      {
        host: this.host,
        redact: this.redact,
        isClosed: () => this.closed,
        isCancelling: (id) => this.cancellation.isCancelling(id),
        isSuspending: (r) => this.isRunSuspending(r),
        persistChildConversationFact: (r, childId) => {
          r.header.childConversationIds = [...r.childConversations]
          try {
            this.repo.saveHeader(r.header)
            void this.repo.flush().catch((e) => process.stderr.write(`workflow ${r.runId}: child ${childId} flush failed: ${errorMessage(e)}\n`))
          } catch (e) {
            process.stderr.write(`workflow ${r.runId}: child ${childId} persist failed: ${errorMessage(e)}\n`)
          }
        },
        loadWorkflowRef: (ref) => {
          try {
            if (ref.name !== undefined) {
              const p = this.library.resolveSavedName(ref.name)
              return { ok: true, script: this.library.readScriptFile(p), path: p }
            }
            if (ref.scriptPath !== undefined) {
              const p = this.library.resolveExplicitPath(ref.scriptPath)
              return { ok: true, script: this.library.readScriptFile(p), path: p }
            }
            return { ok: false, message: 'workflow() reference requires name or scriptPath' }
          } catch (error) {
            return { ok: false, message: errorMessage(error) }
          }
        },
      },
      run,
      parent,
    )

    const onEvent = (event: WorkflowRuntimeEvent): void => {
      if (this.closed) return
      let immediate = false
      if (event.type === 'node') {
        const idx = Number(event.node.id.split('-').pop())
        run.nodesByIndex.set(Number.isFinite(idx) ? idx : run.nodesByIndex.size, event.node)
        immediate = event.node.status === 'done' || event.node.status === 'failed' || event.node.status === 'aborted'
      } else if (event.type === 'phase') {
        run.timeline.push({ at: event.at, kind: 'phase', index: event.index, title: event.title })
        immediate = true
      } else {
        run.timeline.push({ at: event.at, kind: 'log', message: event.message })
        immediate = true
      }

      const now = Date.now()
      if (now - run.lastPersistAt >= PROGRESS_PERSIST_INTERVAL_MS || immediate) {
        run.lastPersistAt = now
        run.header.nodes = this.orderedNodesOf(run)
        if (run.timeline.length > 0) run.header.progress = [...run.timeline]
        run.header.updatedAt = now
        try {
          this.repo.saveHeader(run.header)
        } catch (error) {
          process.stderr.write(`workflow ${run.runId}: progress header save failed: ${errorMessage(error)}\n`)
        }
      }

      const publish = (): void => {
        run.lastEventAt = Date.now()
        this.emitEventSafe('workflow.updated', { run: this.liveSummaryOf(run) })
      }
      if (immediate || now - run.lastEventAt >= NODE_EVENT_INTERVAL_MS) {
        if (run.pendingEventTimer !== undefined) {
          clearTimeout(run.pendingEventTimer)
          run.pendingEventTimer = undefined
        }
        publish()
      } else if (run.pendingEventTimer === undefined) {
        run.pendingEventTimer = setTimeout(() => {
          run.pendingEventTimer = undefined
          if (!this.closed && this.active.has(run.runId)) publish()
        }, NODE_EVENT_INTERVAL_MS - (now - run.lastEventAt))
        run.pendingEventTimer.unref?.()
      }
    }

    void (async () => {
      let result: WorkflowRunResult | undefined
      let failure: unknown
      try {
        result = await runWorkflow({
          runId: run.runId,
          script: opts.script,
          ...(opts.args !== undefined ? { args: opts.args } : {}),
          host: engineHost,
          signal: run.abort.signal,
          isSuspended: () => this.isRunSuspending(run),
          ...(opts.runtimeReadyGate !== undefined ? { runtimeReadyGate: opts.runtimeReadyGate } : {}),
          ...(opts.onReattachHorizon !== undefined ? { onReattachHorizon: opts.onReattachHorizon } : {}),
          ...this.caps,
          redact: this.redact,
          onEvent,
          journal: {
            ...(opts.replayEntries.length > 0 ? { entries: opts.replayEntries } : {}),
            inPlaceResume: opts.inPlaceResume,
            retryFailedCalls: opts.retryFailedCalls,
            append: async (entry) => {
              await run.writer!.append(redactJournalEntry(entry, this.redact))
            },
          },
        })
      } catch (error) {
        failure = error
      }
      await this.settleWorkflow(run, opts.resumeJournalIoErrors, result, failure)
    })()
  }

  // -------------------------------------------------------------------------
  // Unified settlement pipeline
  // -------------------------------------------------------------------------

  private async settleWorkflow(
    run: ActiveRun,
    resumeJournalIoErrors: string[] | undefined,
    result: WorkflowRunResult | undefined,
    failure?: unknown,
  ): Promise<void> {
    await this.executeSettlement(run, {
      applyOutcome: async (hostClosing) => {
        const header = run.header as DslWorkflowRunHeader
        const suspending = this.isRunSuspending(run) && result?.status !== 'completed'
        if (suspending) {
          header.status = 'running'
          header.phase = 'suspended'
        } else if (result !== undefined) {
          header.status =
            result.status === 'killed'
              ? 'aborted'
              : hostClosing && result.status !== 'completed'
                ? 'aborted'
                : result.status
          header.phase = 'settled'
          if (result.error !== undefined) header.error = this.redact(result.error)
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(failure, result.error, 'workflow_failed')
          } else {
            delete header.errorCode
          }
          if (result.value !== undefined) {
            const redactedVal = redactJsonValue(result.value, this.redact)
            run.detail.result = redactedVal
            header.hasResult = true
            header.resultPreview = formatResultPreview(redactedVal)
          }
        } else {
          header.status = hostClosing ? 'aborted' : 'failed'
          header.phase = 'settled'
          const message = failure !== undefined ? errorMessage(failure) : 'unknown workflow failure'
          header.error = this.redact(message)
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(failure, message, 'workflow_failed')
          } else {
            delete header.errorCode
          }
        }

        const journalIoErrors = [
          ...(result?.journalIoErrors ?? []),
          ...(resumeJournalIoErrors ?? []),
          ...(run.writer !== undefined && run.writer.agentIoErrors > 0
            ? [`${run.writer.agentIoErrors} journal agent-line append(s) failed`]
            : []),
        ]
        if (journalIoErrors.length > 0) {
          header.journalIoErrors = journalIoErrors.map((m) => this.redact(m))
        }

        const finalNodes = result !== undefined && result.nodes.length > 0 ? result.nodes : this.orderedNodesOf(run)
        if (!suspending || finalNodes.length > 0) {
          header.nodes = finalNodes
          run.detail.nodes = finalNodes
        }
        const finalTimeline = result !== undefined && result.timeline.length > 0 ? result.timeline : run.timeline
        if (!suspending || finalTimeline.length > 0) {
          header.progress = finalTimeline
          run.detail.progress = finalTimeline
        }

        if (!suspending && header.status === 'failed') {
          header.resumable = inspectRunResumability(header, run.detail, this.resumabilityContext(), {
            mode: 'failed',
          }).resumable
        }
        return { suspending }
      },
      getNotifyInfo: () => ({ parentConversationId: run.conversationId }),
    })
  }

  private async settleSubagent(
    run: ActiveRun,
    node: WorkflowNodeState,
    outcome: { ok: true; raw: unknown } | { ok: false; error: unknown },
    executionInfo: AgentExecutionInfo | undefined,
    gateResult: AgentGateResult | undefined,
    agentId: string,
    gateCommand: string | undefined,
  ): Promise<void> {
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

    await this.executeSettlement(run, {
      applyOutcome: (hostClosing) => {
        const header = run.header as SubagentRunHeader
        const now = Date.now()
        const startedAt = node.startedAt ?? header.createdAt
        const completed = effective.ok && !run.abort.signal.aborted && !run.suspended
        const suspending = !completed && this.isRunSuspending(run)
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
          const redactedVal = redactJsonValue(effective.raw, this.redact)
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
          const redactedMsg = this.redact(message)
          node.error = redactedMsg
          header.status = aborted ? 'aborted' : 'failed'
          header.phase = 'settled'
          header.error = redactedMsg
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(effective.ok ? undefined : effective.error, message, 'subagent_failed')
            header.resumable = inspectRunResumability(header, run.detail, this.resumabilityContext(), {
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
          ...(executionInfo !== undefined ? { execution: redactJsonValue(executionInfo, this.redact) as AgentExecutionInfo } : {}),
        }
      },
    })
  }

  private async executeSettlement(
    run: ActiveRun,
    spec: {
      applyOutcome(hostClosing: boolean): Promise<{ suspending: boolean }> | { suspending: boolean }
      getNotifyInfo(): { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo }
    },
  ): Promise<void> {
    let suspending = false
    const recordError = (e: unknown): void => {
      if (run.settleError === undefined) run.settleError = e
    }
    try {
      if (run.pendingEventTimer !== undefined) {
        clearTimeout(run.pendingEventTimer)
        run.pendingEventTimer = undefined
      }
      const hostClosing = this.isHostClosing()
      const applied = await spec.applyOutcome(hostClosing)
      suspending = applied.suspending

      if (run.childConversations.size > 0) {
        run.header.childConversationIds = [...run.childConversations]
      }
      if (!suspending && hostClosing && run.header.status !== 'completed' && childIdsOfHeader(run.header).length > 0) {
        run.header.phase = 'cleanup_pending'
      }
      const now = Date.now()
      run.header.updatedAt = now
      if (!suspending && run.header.status !== 'running' && run.header.settledAt === undefined) {
        run.header.settledAt = now
      }
      run.summary = this.repo.fullSummaryOf(run.header, run.detail)

      try {
        this.repo.saveDetail(run.conversationId, run.detail)
        this.repo.saveHeader(run.header)
        await this.repo.flush()
      } catch (persistError) {
        process.stderr.write(`workflow ${run.runId}: terminal persist failed: ${errorMessage(persistError)}\n`)
        recordError(persistError)
      }
    } catch (error) {
      recordError(error)
    } finally {
      if (run.writer !== undefined) {
        await run.writer.close().catch(() => {})
      }
      run.abort.abort()
      if (run.pendingExecs.size > 0) await Promise.allSettled([...run.pendingExecs])
      this.active.delete(run.runId)
      if (run.pendingAborts.size > 0) await Promise.allSettled([...run.pendingAborts])

      if (!suspending && this.host.onRunSettled !== undefined) {
        try {
          await this.host.onRunSettled({ ...run.summary })
        } catch (settledError) {
          const msg = `onRunSettled failed: ${errorMessage(settledError)}`
          process.stderr.write(`workflow ${run.runId}: ${msg}\n`)
          const diag = this.redact(msg)
          run.header.error = run.header.error ? `${run.header.error}\n${diag}` : diag
          run.summary = this.repo.fullSummaryOf(run.header, run.detail)
          try {
            this.repo.saveHeader(run.header)
            await this.repo.flush()
          } catch {
            // Best-effort diagnostic persistence; original settledError takes precedence.
          }
          recordError(settledError)
        }
      }
      if (
        !suspending &&
        !this.closed &&
        !this.isHostClosing() &&
        run.header.notifyParentOnSettle === true &&
        run.header.notifiedAt === undefined &&
        this.host.onBackgroundAgentSettled !== undefined
      ) {
        try {
          await this.host.onBackgroundAgentSettled({ ...run.summary }, spec.getNotifyInfo())
          run.header.notifiedAt = Date.now()
          this.repo.saveHeader(run.header)
          await this.repo.flush()
        } catch (notifyError) {
          process.stderr.write(`workflow ${run.runId}: onBackgroundAgentSettled failed: ${errorMessage(notifyError)}\n`)
        }
      }
      this.emitEventSafe('workflow.updated', { run: { ...run.summary } })
      this.resolveActiveDone(run)
    }
  }

  // -------------------------------------------------------------------------
  // ActiveRun helpers
  // -------------------------------------------------------------------------

  private readonly doneResolvers = new WeakMap<ActiveRun, () => void>()

  private createActiveRun(header: RunHeader, detail: RunDetail, writer?: JournalWriter): ActiveRun {
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    const now = Date.now()
    const run: ActiveRun = {
      runId: header.id,
      conversationId: header.conversationId,
      abort: new AbortController(),
      header,
      detail,
      done,
      ...(writer !== undefined ? { writer } : {}),
      nodesByIndex: new Map(),
      timeline: [],
      pendingAborts: new Set(),
      pendingExecs: new Set(),
      childConversations: new Set(),
      lastPersistAt: now,
      lastEventAt: now,
      summary: this.repo.summaryOfHeader(header),
    }
    this.doneResolvers.set(run, resolveDone)
    return run
  }

  private resolveActiveDone(run: ActiveRun): void {
    this.doneResolvers.get(run)?.()
  }

  private orderedNodesOf(run: ActiveRun): WorkflowNodeState[] {
    return [...run.nodesByIndex.entries()].sort(([a], [b]) => a - b).map(([, n]) => n)
  }

  private liveSummaryOf(run: ActiveRun): WorkflowRunSummary {
    const base = this.repo.summaryOfHeader(run.header)
    const nodes = run.nodesByIndex.size > 0 ? this.orderedNodesOf(run) : base.nodes
    return {
      ...base,
      ...(run.detail.result !== undefined ? { result: run.detail.result } : {}),
      ...(nodes !== undefined ? { nodes } : {}),
      ...(run.timeline.length > 0 ? { progress: [...run.timeline] } : {}),
    }
  }

  private emitEventSafe(type: string, payload: unknown): void {
    try {
      void Promise.resolve(this.host.emitEvent(type, payload)).catch((error: unknown) => {
        process.stderr.write(`workflow: emitEvent ${type} failed: ${errorMessage(error)}\n`)
      })
    } catch (error) {
      process.stderr.write(`workflow: emitEvent ${type} failed: ${errorMessage(error)}\n`)
    }
  }
}
