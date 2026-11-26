/**
 * runs/active-runs.ts — Shared ActiveRun registry, guarded redaction/stderr diagnostics,
 * settlement pipeline (`executeSettlement`), shutdown drain, and shared validation helpers.
 */
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import { type WorkflowNodeState, type WorkflowRunSummary } from '../../contracts.js'
import { isAutoRecoverEnvDisabled } from '../config.js'
import type { JournalWriter } from '../dsl/index.js'
import type { CancellationTracker } from './cancellation.js'
import type { WorkflowLibrary } from './library-store.js'
import type { ResumabilityContext } from './resumability.js'
import { childIdsOfHeader, errorMessage, type RunRepository } from './run-repository.js'
import type { ActiveRun, RunDetail, RunHeader, WorkflowServiceHost } from './types.js'

export interface RunRuntimeCaps {
  concurrency: number
  agentCap: number
  actionCap: number
  timelineCap: number
  itemCap: number
  nestedCap: number
}

export interface RunSettlementSpec {
  applyOutcome(hostClosing: boolean): Promise<{ suspending: boolean }> | { suspending: boolean }
  getNotifyInfo(): { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo }
}

/** Redact arbitrary error/diagnostic text safely without throwing. */
export function safeRedactDiagnostic(
  redact: (text: string) => string,
  message: string,
  fallback = 'internal error',
): string {
  try {
    return redact(message)
  } catch {
    return fallback
  }
}

export function writeRedactedStderr(
  redact: (text: string) => string,
  prefix: string,
  error: unknown,
  fallbackLabel = 'diagnostic error',
): string {
  const raw = errorMessage(error)
  const fallback =
    error instanceof HelmxError && error.code !== ''
      ? `${fallbackLabel} (${error.code})`
      : fallbackLabel
  const safeMsg = safeRedactDiagnostic(redact, raw, fallback)
  process.stderr.write(`${prefix}: ${safeMsg}\n`)
  return safeMsg
}

export function assertResumeConversationMatch(
  replayHeader: RunHeader,
  requestedConversationId: number | undefined,
): void {
  if (requestedConversationId === undefined || requestedConversationId === replayHeader.conversationId) {
    return
  }
  const targetLabel = replayHeader.kind === 'subagent' ? '子代理' : '工作流'
  throw new HelmxError(
    'validation_error',
    `恢复目标不匹配：${targetLabel} ${replayHeader.id} 属于会话 ${replayHeader.conversationId}，不能改在会话 ${requestedConversationId} 下恢复`,
    400,
    {
      runId: replayHeader.id,
      recordedConversationId: replayHeader.conversationId,
      requestedConversationId,
    },
  )
}

export function parseDslNodeIndex(nodeId: string, fallbackIndex: number): number {
  const match = /^(?:agent|action)-(\d+)$/.exec(nodeId)
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1])
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return fallbackIndex
}

export class RunCoordinatorCore {
  readonly active = new Map<string, ActiveRun>()
  readonly settling = new Map<string, ActiveRun>()
  readonly pendingPurges = new Set<Promise<void>>()
  readonly resumingLocks = new Set<string>()
  private readonly doneResolvers = new Map<string, () => void>()
  closed = false

  constructor(
    readonly deps: {
      host: WorkflowServiceHost
      repo: RunRepository
      library: WorkflowLibrary
      cancellation: CancellationTracker
      redact: (text: string) => string
      caps: RunRuntimeCaps
      autoRecoverOption: boolean | (() => boolean) | undefined
      releaseRuntimeReady: () => void
    },
  ) {}

  isAutoRecoverOnRestart(): boolean {
    const opt = this.deps.autoRecoverOption
    if (opt === false) return false
    if (typeof opt === 'function' && !opt()) return false
    return !isAutoRecoverEnvDisabled()
  }

  isHostClosing(): boolean {
    return this.deps.host.isHostClosing?.() === true
  }

  isRunSuspending(run: ActiveRun): boolean {
    return (
      run.suspended === true ||
      (this.isAutoRecoverOnRestart() && this.isHostClosing() && run.userAborted !== true)
    )
  }

  assertNotClosed(): void {
    if (this.closed) throw new HelmxError('service_closed', 'WorkflowService is closed', 409)
  }

  resumabilityContext(): ResumabilityContext {
    return {
      getTakenOverBy: (runId) => this.deps.repo.getTakenOverBy(runId),
      readScriptFile: (scriptPath) => this.deps.library.readScriptFile(scriptPath),
    }
  }

  createActiveRun(header: RunHeader, detail: RunDetail, writer?: JournalWriter): ActiveRun {
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
      summary: this.deps.repo.summaryOfHeader(header),
    }
    this.doneResolvers.set(header.id, resolveDone)
    return run
  }

  resolveActiveDone(run: ActiveRun): void {
    this.settling.delete(run.runId)
    const resolver = this.doneResolvers.get(run.runId)
    this.doneResolvers.delete(run.runId)
    resolver?.()
  }

  orderedNodesOf(run: ActiveRun): WorkflowNodeState[] {
    return [...run.nodesByIndex.entries()].sort(([a], [b]) => a - b).map(([, n]) => n)
  }

  liveSummaryOf(run: ActiveRun): WorkflowRunSummary {
    const base = this.deps.repo.summaryOfHeader(run.header)
    const nodes = run.nodesByIndex.size > 0 ? this.orderedNodesOf(run) : base.nodes
    return {
      ...base,
      ...(run.detail.result !== undefined ? { result: run.detail.result } : {}),
      ...(nodes !== undefined ? { nodes } : {}),
      ...(run.timeline.length > 0 ? { progress: run.timeline.slice(-this.deps.caps.timelineCap) } : {}),
    }
  }

  emitEventSafe(type: string, payload: unknown): void {
    try {
      void Promise.resolve(this.deps.host.emitEvent(type, payload)).catch((error: unknown) => {
        writeRedactedStderr(this.deps.redact, `workflow: emitEvent ${type} failed`, error)
      })
    } catch (error) {
      writeRedactedStderr(this.deps.redact, `workflow: emitEvent ${type} failed`, error)
    }
  }

  async drainActiveRuns(mode: 'suspend' | 'close'): Promise<void> {
    this.closed = true
    this.deps.releaseRuntimeReady()
    while (this.active.size > 0 || this.settling.size > 0) {
      const inFlight = [...this.active.values()]
      for (const run of inFlight) {
        if (mode === 'suspend') run.suspended = true
        else run.userAborted = true
        run.abort.abort()
      }
      const pending = [...inFlight, ...this.settling.values()].map((r) => r.done)
      if (pending.length === 0) break
      await Promise.all(pending)
    }
    if (this.pendingPurges.size > 0) await Promise.allSettled([...this.pendingPurges])
    await this.deps.repo.flush()
  }

  async executeSettlement(run: ActiveRun, spec: RunSettlementSpec): Promise<void> {
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
      run.summary = this.deps.repo.fullSummaryOf(run.header, run.detail)

      try {
        await this.deps.repo.saveDetail(run.conversationId, run.detail)
        this.deps.repo.saveHeader(run.header)
        await this.deps.repo.flush()
      } catch (persistError) {
        writeRedactedStderr(this.deps.redact, `workflow ${run.runId}: terminal persist failed`, persistError)
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
      // Transition active -> settling BEFORE removing from active so `listActiveRuns()` excludes this run
      // during settlement callbacks while `suspend()`/`close()`/`wait()` still drain until `run.done` resolves.
      this.settling.set(run.runId, run)
      this.active.delete(run.runId)
      try {
        if (run.pendingAborts.size > 0) await Promise.allSettled([...run.pendingAborts])

        if (!suspending && this.deps.host.onRunSettled !== undefined) {
          try {
            await this.deps.host.onRunSettled({ ...run.summary })
          } catch (settledError) {
            const rawMsg = `onRunSettled failed: ${errorMessage(settledError)}`
            const fallbackCode = settledError instanceof HelmxError && settledError.code !== '' ? settledError.code : 'unknown'
            const diag = safeRedactDiagnostic(this.deps.redact, rawMsg, `onRunSettled failed (${fallbackCode})`)
            process.stderr.write(`workflow ${run.runId}: ${diag}\n`)
            run.header.error = run.header.error ? `${run.header.error}\n${diag}` : diag
            run.summary = this.deps.repo.fullSummaryOf(run.header, run.detail)
            try {
              this.deps.repo.saveHeader(run.header)
              await this.deps.repo.flush()
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
          this.deps.host.onBackgroundAgentSettled !== undefined
        ) {
          try {
            await this.deps.host.onBackgroundAgentSettled({ ...run.summary }, spec.getNotifyInfo())
            run.header.notifiedAt = Date.now()
            this.deps.repo.saveHeader(run.header)
            await this.deps.repo.flush()
          } catch (notifyError) {
            writeRedactedStderr(
              this.deps.redact,
              `workflow ${run.runId}: onBackgroundAgentSettled failed`,
              notifyError,
            )
          }
        }
        this.emitEventSafe('workflow.updated', { run: { ...run.summary } })
      } finally {
        this.resolveActiveDone(run)
      }
    }
  }
}
