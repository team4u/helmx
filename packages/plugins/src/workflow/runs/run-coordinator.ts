/**
 * runs/run-coordinator.ts — Unified WorkflowService facade delegating to cohesive collaborators:
 * `RunCoordinatorCore`, `StartupRecoveryCoordinator`, `DslRunDriver`, and `SubagentRunDriver`.
 */
import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import {
  HelmxError,
  redactJsonValue,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type ConversationSummary,
} from '@helmx/protocol'
import {
  type SavedWorkflowDetail,
  type SavedWorkflowSummary,
  type WorkflowDeleteResult,
  type WorkflowRunRequest,
  type WorkflowRunSummary,
  type WorkflowSaveRequest,
  type WorkflowSaveResult,
} from '../../contracts.js'
import {
  defaultWorkflowConcurrency,
  JournalWriter,
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  WORKFLOW_ACTION_CAP,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  WORKFLOW_TIMELINE_CAP,
  type WorkflowJournalEntry,
} from '../dsl/index.js'
import {
  assertResumeConversationMatch,
  RunCoordinatorCore,
  type RunRuntimeCaps,
} from './active-runs.js'
import { CancellationTracker } from './cancellation.js'
import { DslRunDriver } from './dsl-driver.js'
import { WorkflowLibrary } from './library-store.js'
import { StartupRecoveryCoordinator } from './recovery.js'
import { inspectRunResumability } from './resumability.js'
import {
  createMemoryKvStore,
  newRunId,
  RunRepository,
  type AnyWorkflowKvStore,
} from './run-repository.js'
import { SubagentRunDriver } from './subagent-driver.js'
import type {
  ActiveRun,
  DslWorkflowRunHeader,
  PersistedSubagentSpec,
  RunDetail,
  RunHeader,
  WorkflowServiceHost,
} from './types.js'

export interface WorkflowServiceOptions {
  dataDir: string
  kv?: AnyWorkflowKvStore
  host: WorkflowServiceHost
  concurrency?: number
  agentCap?: number
  actionCap?: number
  timelineCap?: number
  itemCap?: number
  nestedCap?: number
  redact?: (text: string) => string
  autoRecoverOnRestart?: boolean | (() => boolean)
  /** When true (plugin lifecycle), defers live DSL steps & outbox until `reconcile()` after `harness.resume()`. */
  deferReconcile?: boolean
  /** Fires when a newly saved `replayedFrom` run takes over a prior run, carrying the updated prior summary. */
  onTakeoverUpdated?: (priorSummary: WorkflowRunSummary) => void
}

function validatePositiveCap(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new HelmxError('validation_error', `WorkflowService ${name} 必须为正整数，实得 ${value}`, 400)
  }
  return value
}

export class WorkflowService {
  private readonly host: WorkflowServiceHost
  private readonly redact: (text: string) => string
  private readonly repo: RunRepository
  private readonly library: WorkflowLibrary
  private readonly cancellation: CancellationTracker
  private readonly core: RunCoordinatorCore
  private readonly dslDriver: DslRunDriver
  private readonly subagentDriver: SubagentRunDriver
  private readonly recovery: StartupRecoveryCoordinator

  constructor(options: WorkflowServiceOptions) {
    this.host = options.host
    this.redact = options.redact ?? ((text: string) => text)
    const deferReconcile = options.deferReconcile === true

    const caps: RunRuntimeCaps = {
      concurrency: validatePositiveCap('concurrency', options.concurrency ?? defaultWorkflowConcurrency()),
      agentCap: validatePositiveCap('agentCap', options.agentCap ?? WORKFLOW_AGENT_CAP),
      actionCap: validatePositiveCap('actionCap', options.actionCap ?? WORKFLOW_ACTION_CAP),
      timelineCap: validatePositiveCap('timelineCap', options.timelineCap ?? WORKFLOW_TIMELINE_CAP),
      itemCap: validatePositiveCap('itemCap', options.itemCap ?? WORKFLOW_ITEM_CAP),
      nestedCap: validatePositiveCap('nestedCap', options.nestedCap ?? WORKFLOW_NESTED_CAP),
    }

    let releaseRuntimeReady: () => void = () => {}
    const runtimeReadyGate = deferReconcile
      ? new Promise<void>((resolve) => {
          releaseRuntimeReady = resolve
        })
      : Promise.resolve()

    const active = new Map<string, ActiveRun>()
    this.repo = new RunRepository({
      dataDir: options.dataDir,
      kv: options.kv ?? createMemoryKvStore<RunHeader>(),
      redact: this.redact,
      onTakeoverUpdated: options.onTakeoverUpdated,
    })
    this.library = new WorkflowLibrary(options.dataDir)
    this.cancellation = new CancellationTracker({
      active,
      parentConversationOf: (id) => this.host.getConversation(id).parentConversationId,
    })

    this.core = new RunCoordinatorCore({
      host: this.host,
      repo: this.repo,
      library: this.library,
      cancellation: this.cancellation,
      redact: this.redact,
      caps,
      autoRecoverOption: options.autoRecoverOnRestart,
      releaseRuntimeReady,
    })
    // Share the exact same `active` Map between CancellationTracker and RunCoordinatorCore.
    Object.assign(this.core, { active })
    this.dslDriver = new DslRunDriver(this.core, runtimeReadyGate)
    this.subagentDriver = new SubagentRunDriver(this.core, runtimeReadyGate)
    this.recovery = new StartupRecoveryCoordinator(this.core, this.dslDriver, this.subagentDriver, {
      deferReconcile,
      releaseRuntimeReady,
    })
  }

  isAutoRecoverOnRestart(): boolean {
    return this.core.isAutoRecoverOnRestart()
  }

  isHostClosing(): boolean {
    return this.core.isHostClosing()
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
    return [...this.core.active.values()]
      .map((r) => this.core.liveSummaryOf(r))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Zero-IO lookup of running background subagent specs for a parent conversation (used for concurrent duplicate checks). */
  listActiveSubagentRuns(
    parentConversationId: number,
  ): Array<{ runId: string; parentToolCallId?: string; spec: PersistedSubagentSpec }> {
    const out: Array<{ runId: string; parentToolCallId?: string; spec: PersistedSubagentSpec }> = []
    for (const active of this.core.active.values()) {
      if (active.conversationId !== parentConversationId) continue
      if (active.header.kind !== 'subagent' || active.header.status !== 'running') continue
      if (active.detail.subagentSpec === undefined) continue
      out.push({
        runId: active.runId,
        ...(active.header.parentToolCallId !== undefined ? { parentToolCallId: active.header.parentToolCallId } : {}),
        spec: active.detail.subagentSpec,
      })
    }
    return out
  }

  /** Zero-IO memory scan of all run headers (active runs overlaid with live node state). */
  listRuns(): WorkflowRunSummary[] {
    const headers = this.repo.listHeaders()
    const out: WorkflowRunSummary[] = []
    const seen = new Set<string>()
    for (const active of this.core.active.values()) {
      seen.add(active.runId)
      out.push(this.core.liveSummaryOf(active))
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
    const active = this.core.active.get(runId)
    if (active !== undefined) return this.core.liveSummaryOf(active)
    const header = this.repo.getHeader(runId)
    return this.repo.fullSummaryOf(header)
  }

  findRunByParentToolCall(conversationId: number, parentToolCallId: string): RunHeader | undefined {
    if (parentToolCallId === '') return undefined
    for (const active of this.core.active.values()) {
      if (active.conversationId === conversationId && active.header.parentToolCallId === parentToolCallId) {
        return active.header
      }
    }
    return this.repo.findByParentToolCall(conversationId, parentToolCallId)
  }

  loadRunHeaderAndDetail(runId: string): { header: RunHeader; detail: RunDetail } {
    const active = this.core.active.get(runId)
    if (active !== undefined) return { header: active.header, detail: active.detail }
    const header = this.repo.getHeader(runId)
    return { header, detail: this.repo.loadDetail(header) }
  }

  inspectResumability(runId: string): { resumable: true } | { resumable: false; reason: string } {
    const { header, detail } = this.loadRunHeaderAndDetail(runId)
    const verdict = inspectRunResumability(header, detail, this.core.resumabilityContext())
    return verdict.resumable ? { resumable: true } : { resumable: false, reason: verdict.reason }
  }

  async wait(runId: string): Promise<unknown> {
    const run = this.core.active.get(runId) ?? this.core.settling.get(runId)
    if (run !== undefined) {
      await run.done
      if (run.settleError !== undefined) throw run.settleError
    }
    return this.getRun(runId).result
  }

  // -------------------------------------------------------------------------
  // Cancellation, lifecycle, recovery & shutdown
  // -------------------------------------------------------------------------

  isConversationCancelling(conversationId: number): boolean {
    return this.cancellation.isCancelling(conversationId)
  }

  /** Abort one run and its descendant subtree; NEVER marks the parent conversation as cancelling. */
  async abort(runId: string): Promise<void> {
    const activeRun = this.core.active.get(runId)
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
    if (this.core.isHostClosing() && this.core.isAutoRecoverOnRestart()) return
    await this.cancellation.cancelBoundary(`conv:${conversationId}`, [conversationId], (run, isWithin) =>
      isWithin(run.conversationId, conversationId),
    )
  }

  /** Cascade-purge terminal runs owned by a deleted conversation (preserving live conversations' runs). */
  async purgeDeletedConversation(conversationId: number): Promise<string[]> {
    if (this.core.closed) return []
    let purgedIds: string[] = []
    const task = (async () => {
      await this.cancelRunsUnderConversation(conversationId)
      const directSettling = [...this.core.settling.values()]
        .filter((r) => r.conversationId === conversationId)
        .map((r) => r.done)
      if (directSettling.length > 0) await Promise.allSettled(directSettling)
      if (this.core.closed) return
      const excludeIds = new Set<string>([...this.core.active.keys(), ...this.core.settling.keys()])
      purgedIds = await this.repo.purgeConversationTerminalRuns(conversationId, excludeIds)
    })()
    this.core.pendingPurges.add(task)
    try {
      await task
      return purgedIds
    } finally {
      this.core.pendingPurges.delete(task)
    }
  }

  async suspend(): Promise<void> {
    await this.core.drainActiveRuns('suspend')
  }

  async close(): Promise<void> {
    await this.core.drainActiveRuns('close')
  }

  prepareRecovery(): Promise<void> {
    return this.recovery.prepareRecovery()
  }

  init(): Promise<void> {
    return this.recovery.init()
  }

  reconcile(): Promise<void> {
    return this.recovery.reconcile()
  }

  awaitPreparedChildrenSettled(): Promise<void> {
    return this.recovery.awaitPreparedChildrenSettled()
  }

  // -------------------------------------------------------------------------
  // Launching DSL workflows & background subagents
  // -------------------------------------------------------------------------

  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean },
  ): Promise<WorkflowRunSummary> {
    this.core.assertNotClosed()
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
      assertResumeConversationMatch(replayHeader, request.conversationId)

      if (this.core.active.has(replayHeader.id) || this.core.settling.has(replayHeader.id)) {
        throw new HelmxError('conflict', `工作流 ${replayHeader.id} 仍在运行中`, 409, { runId: replayHeader.id })
      }
      const existingTakeover = this.repo.getTakenOverBy(replayHeader.id)
      if (existingTakeover !== undefined || this.core.resumingLocks.has(replayHeader.id)) {
        throw new HelmxError(
          'conflict',
          `运行 ${replayHeader.id} 已被 ${existingTakeover ?? '并发请求'} 接管续跑`,
          409,
          { runId: replayHeader.id, ...(existingTakeover !== undefined ? { resumedByRunId: existingTakeover } : {}) },
        )
      }

      if (replayHeader.kind === 'subagent') {
        return this.subagentDriver.resumeSubagentByRunId(replayHeader, replayDetail, request, {
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

    let parent: ConversationSummary
    try {
      parent = this.host.getConversation(conversationId)
    } catch {
      throw new HelmxError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, { conversationId })
    }

    let script = ''
    let scriptPath: string | undefined
    let savedName: string | undefined
    let replayEntries: readonly WorkflowJournalEntry[] = []
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
      const verdict = inspectRunResumability(replayHeader, replayDetail, this.core.resumabilityContext(), {
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
      if (verdict.kind === 'workflow') {
        if (sources.length === 0 && verdict.script !== undefined) {
          script = verdict.script
          scriptPath = verdict.scriptPath
          savedName = verdict.savedName
        }
        replayEntries = verdict.journal.entries
        if (verdict.journal.ioErrors > 0) {
          resumeJournalIoErrors = [`journal ${replayHeader.id} has ${verdict.journal.ioErrors} corrupt/unreadable line(s)`]
        }
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
      ...(meta?.phases !== undefined
        ? { phases: redactJsonValue(meta.phases, this.redact) as DslWorkflowRunHeader['phases'] }
        : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
      ...(replayHeader !== undefined ? { replayedFrom: replayHeader.id } : {}),
    }
    const detail: RunDetail = {
      id: runId,
      ...(scriptPath === undefined ? { script } : {}),
      ...(args !== undefined ? { args: redactJsonValue(args, this.redact) } : {}),
    }

    if (replayHeader !== undefined) this.core.resumingLocks.add(replayHeader.id)
    try {
      this.core.assertNotClosed()
      this.cancellation.assertNotCancelling(conversationId)
      const writer = new JournalWriter(journalPath)
      const run = this.core.createActiveRun(header, detail, writer)
      this.core.active.set(runId, run)
      try {
        await this.repo.saveDetail(conversationId, detail)
        this.repo.saveHeader(header)
        await this.repo.flush()
      } catch (error) {
        await writer.close().catch(() => {})
        this.core.active.delete(runId)
        this.core.resolveActiveDone(run)
        throw error
      }
      this.core.emitEventSafe('workflow.updated', { run: this.core.liveSummaryOf(run) })
      this.dslDriver.driveWorkflowRun(run, parent, writer, {
        script,
        args,
        replayEntries,
        inPlaceResume: false,
        retryFailedCalls: replayHeader?.status === 'failed',
        resumeJournalIoErrors,
      })
      return this.core.liveSummaryOf(run)
    } finally {
      if (replayHeader !== undefined) this.core.resumingLocks.delete(replayHeader.id)
    }
  }

  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
      replayedFrom?: string
    },
  ): Promise<{ run: WorkflowRunSummary; execution?: AgentExecutionInfo }> {
    this.core.assertNotClosed()
    await this.init()
    return this.subagentDriver.startBackgroundAgent(request, options)
  }
}
