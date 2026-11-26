/**
 * runs/recovery.ts — Two-phase safe StartupRecovery (prepare -> init [start] -> reconcile)
 * and persisted settlement outbox flushing.
 */
import { HelmxError } from '@helmx/protocol'
import type { WorkflowNodeState } from '../../contracts.js'
import type { JournalReadResult } from '../dsl/index.js'
import { writeRedactedStderr, type RunCoordinatorCore } from './active-runs.js'
import type { DslRunDriver } from './dsl-driver.js'
import { inspectRunResumability } from './resumability.js'
import { childIdsOfHeader, errorMessage } from './run-repository.js'
import type { SubagentRunDriver } from './subagent-driver.js'
import type { DslWorkflowRunHeader, RunDetail, RunHeader, SubagentRunHeader } from './types.js'

type RecoveryPlanItem =
  | { kind: 'cleanup_only'; header: RunHeader; childIds: number[] }
  | { kind: 'fail_and_abort'; header: RunHeader; detail: RunDetail; code: string; reason: string; childIds: number[] }
  | { kind: 'reattach_subagent'; header: SubagentRunHeader; detail: RunDetail }
  | {
      kind: 'reattach_workflow'
      header: DslWorkflowRunHeader
      detail: RunDetail
      script: string
      journal: JournalReadResult
    }

export class StartupRecoveryCoordinator {
  private recoveryPrepared = false
  private recovered = false
  private initPromise?: Promise<void>
  private plannedItems: RecoveryPlanItem[] = []
  private readonly preparedChildIds = new Set<number>()
  private readonly pendingSettlementChildIds = new Set<number>()
  private pendingOutboxNotifies: Array<() => Promise<void>> = []

  constructor(
    private readonly core: RunCoordinatorCore,
    private readonly dslDriver: DslRunDriver,
    private readonly subagentDriver: SubagentRunDriver,
    private readonly options: { deferReconcile: boolean; releaseRuntimeReady: () => void },
  ) {}

  /** Phase 1 (global prepare barrier, before harness.resume): compute plan once and lay durable abort markers. */
  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    const { host, repo } = this.core.deps
    const autoRecover = this.core.isAutoRecoverOnRestart()
    const headers = repo.listHeaders()
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
      const detail = repo.loadDetail(header)
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

      const verdict = inspectRunResumability(header, detail, this.core.resumabilityContext(), {
        mode: 'startup_in_place',
      })
      if (!verdict.resumable) {
        for (const id of childIds) abortChildIds.add(id)
        plan.push({ kind: 'fail_and_abort', header, detail, code: verdict.code, reason: verdict.reason, childIds })
        continue
      }

      try {
        host.getConversation(header.conversationId)
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
      } else if (verdict.kind === 'workflow' && verdict.script !== undefined) {
        plan.push({
          kind: 'reattach_workflow',
          header,
          detail,
          script: verdict.script,
          journal: verdict.journal,
        })
      } else {
        for (const id of childIds) abortChildIds.add(id)
        plan.push({
          kind: 'fail_and_abort',
          header,
          detail,
          code: 'missing_script_source',
          reason: 'run interrupted by process restart（未持久化脚本源，无法原位续跑）',
          childIds,
        })
      }
    }

    for (const id of abortChildIds) {
      try {
        await host.abortConversationGuarded(id)
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
      const { repo, redact } = this.core.deps
      try {
        await this.prepareRecovery()
        const reattachHorizons: Promise<void>[] = []
        let changed = false

        // Queue outbox notifications for already-settled runs that never finished notifying.
        for (const header of repo.listHeaders()) {
          if (header.phase === 'settled' && header.notifyParentOnSettle === true && header.notifiedAt === undefined) {
            this.queueOutboxNotify(header, repo.loadDetail(header))
          }
        }

        for (const item of this.plannedItems) {
          if (item.kind === 'cleanup_only') {
            for (const id of item.childIds) this.pendingSettlementChildIds.add(id)
            item.header.phase = 'settled'
            item.header.updatedAt = Date.now()
            repo.saveHeader(item.header)
            if (item.header.notifyParentOnSettle === true && item.header.notifiedAt === undefined) {
              this.queueOutboxNotify(item.header, repo.loadDetail(item.header))
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
            item.header.error = redact(item.reason)
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
              this.core.resumabilityContext(),
              { mode: 'failed' },
            ).resumable
            await repo.saveDetail(item.header.conversationId, item.detail)
            repo.saveHeader(item.header)
            changed = true
            if (item.header.notifyParentOnSettle === true && item.header.notifiedAt === undefined) {
              this.queueOutboxNotify(item.header, item.detail)
            }
            this.core.emitEventSafe('workflow.updated', { run: repo.summaryOfHeader(item.header) })
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
          repo.saveHeader(item.header)
          changed = true

          if (item.kind === 'reattach_subagent') {
            const horizon = this.subagentDriver.reattachSubagentRun(item.header, item.detail)
            if (horizon !== undefined) reattachHorizons.push(horizon)
            continue
          }

          const horizon = this.dslDriver.reattachWorkflowRun(item.header, item.detail, item.script, item.journal)
          reattachHorizons.push(horizon)
        }

        if (changed) await repo.flush()
        this.plannedItems = []
        if (reattachHorizons.length > 0) await Promise.allSettled(reattachHorizons)
        this.recovered = true

        if (!this.options.deferReconcile) {
          this.options.releaseRuntimeReady()
          await this.awaitPreparedChildrenSettled()
          await this.flushOutboxNotifies()
        }
      } catch (error) {
        this.recoveryPrepared = false
        this.plannedItems = []
        this.pendingOutboxNotifies = []
        repo.invalidate()
        throw error
      } finally {
        if (!this.recovered) this.initPromise = undefined
      }
    })()
    return this.initPromise
  }

  /** Phase 3 (service.reconcile, after harness.resume): release live DSL gate, settle aborted children, flush outbox. */
  async reconcile(): Promise<void> {
    this.options.releaseRuntimeReady()
    await this.awaitPreparedChildrenSettled()
    await this.flushOutboxNotifies()
  }

  async awaitPreparedChildrenSettled(): Promise<void> {
    const { host, redact } = this.core.deps
    const ids = new Set<number>([...this.preparedChildIds, ...this.pendingSettlementChildIds])
    if (ids.size === 0) return
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          await host.abortConversationGuarded(id)
          this.preparedChildIds.delete(id)
          this.pendingSettlementChildIds.delete(id)
        } catch (error) {
          if (error instanceof HelmxError && (error.code === 'not_found' || error.code === 'ownership_conflict')) {
            this.preparedChildIds.delete(id)
            this.pendingSettlementChildIds.delete(id)
            return
          }
          writeRedactedStderr(redact, `workflow reconcile: guarded abort conversation ${id} failed`, error)
        }
      }),
    )
  }

  private queueOutboxNotify(header: RunHeader, detail: RunDetail): void {
    const { host, repo } = this.core.deps
    this.pendingOutboxNotifies.push(async () => {
      if (host.onBackgroundAgentSettled === undefined) return
      const summary = repo.fullSummaryOf(header, detail)
      const info =
        header.kind === 'subagent'
          ? {
              parentConversationId: header.conversationId,
              ...(header.agentType !== undefined ? { agentType: header.agentType } : {}),
              ...(header.execution !== undefined ? { execution: header.execution } : {}),
            }
          : { parentConversationId: header.conversationId }
      await host.onBackgroundAgentSettled(summary, info)
      header.notifiedAt = Date.now()
      repo.saveHeader(header)
    })
  }

  private async flushOutboxNotifies(): Promise<void> {
    const { repo, redact } = this.core.deps
    const notifies = this.pendingOutboxNotifies
    this.pendingOutboxNotifies = []
    if (notifies.length === 0) return
    for (const fn of notifies) {
      try {
        await fn()
      } catch (error) {
        writeRedactedStderr(redact, 'workflow outbox notify failed', error)
      }
    }
    try {
      await repo.flush()
    } catch (error) {
      writeRedactedStderr(redact, 'workflow outbox flush failed', error)
    }
  }
}
