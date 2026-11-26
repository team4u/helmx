/**
 * runs/dsl-driver.ts — DSL workflow launch, live progress/journal bridge, in-place reattach, and settlement.
 */
import { redactJsonValue, type ConversationSummary } from '@helmx/protocol'
import type { WorkflowProgressEntry } from '../../contracts.js'
import {
  JournalWriter,
  redactJournalEntry,
  runWorkflow,
  type JournalReadResult,
  type WorkflowJournalEntry,
  type WorkflowRunResult,
  type WorkflowRuntimeEvent,
} from '../dsl/index.js'
import {
  parseDslNodeIndex,
  writeRedactedStderr,
  type RunCoordinatorCore,
} from './active-runs.js'
import { classifyRunFailureCode, inspectRunResumability } from './resumability.js'
import { errorMessage, formatResultPreview } from './run-repository.js'
import { buildEngineHost } from './spawn-bridge.js'
import type { ActiveRun, DslWorkflowRunHeader, RunDetail } from './types.js'

const PROGRESS_PERSIST_INTERVAL_MS = 1_000
const NODE_EVENT_INTERVAL_MS = 250

export class DslRunDriver {
  constructor(
    private readonly core: RunCoordinatorCore,
    private readonly runtimeReadyGate: Promise<void>,
  ) {}

  reattachWorkflowRun(
    header: DslWorkflowRunHeader,
    detail: RunDetail,
    script: string,
    journal: JournalReadResult,
  ): Promise<void> {
    const parent = this.core.deps.host.getConversation(header.conversationId)
    const initialSeq = journal.entries.reduce((max, item) => Math.max(max, item.seq + 1), 0)
    const writer = new JournalWriter(header.journalPath, true, initialSeq)
    const run = this.core.createActiveRun(header, detail, writer)
    if (detail.progress) run.timeline = [...detail.progress]
    for (const id of header.childConversationIds ?? []) run.childConversations.add(id)
    this.core.active.set(header.id, run)

    let resolveHorizon: () => void = () => {}
    const horizonGate = new Promise<void>((r) => {
      resolveHorizon = r
    })
    const resumeJournalIoErrors =
      journal.ioErrors > 0 ? [`journal ${header.id} has ${journal.ioErrors} corrupt/unreadable line(s)`] : undefined

    this.driveWorkflowRun(run, parent, writer, {
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

  driveWorkflowRun(
    run: ActiveRun,
    parent: ConversationSummary,
    writer: JournalWriter,
    opts: {
      script: string
      args?: unknown
      replayEntries: readonly WorkflowJournalEntry[]
      inPlaceResume: boolean
      retryFailedCalls: boolean
      resumeJournalIoErrors?: string[]
      runtimeReadyGate?: Promise<void>
      onReattachHorizon?: () => void
    },
  ): void {
    const { host, repo, library, cancellation, redact, caps } = this.core.deps
    const engineHost = buildEngineHost(
      {
        host,
        redact,
        isClosed: () => this.core.closed,
        isCancelling: (id) => cancellation.isCancelling(id),
        isSuspending: (r) => this.core.isRunSuspending(r),
        persistChildConversationFact: (r, childId) => {
          r.header.childConversationIds = [...r.childConversations]
          try {
            repo.saveHeader(r.header)
            void repo.flush().catch((e) =>
              writeRedactedStderr(redact, `workflow ${r.runId}: child ${childId} flush failed`, e),
            )
          } catch (e) {
            writeRedactedStderr(redact, `workflow ${r.runId}: child ${childId} persist failed`, e)
          }
        },
        loadWorkflowRef: (ref) => {
          try {
            if (ref.name !== undefined) {
              const p = library.resolveSavedName(ref.name)
              return { ok: true, script: library.readScriptFile(p), path: p }
            }
            if (ref.scriptPath !== undefined) {
              const p = library.resolveExplicitPath(ref.scriptPath)
              return { ok: true, script: library.readScriptFile(p), path: p }
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

    const appendRunTimeline = (entry: WorkflowProgressEntry): void => {
      const cap = caps.timelineCap
      if (run.timeline.length >= cap * 2) {
        run.timeline.splice(0, run.timeline.length - cap + 1)
      }
      run.timeline.push(entry)
    }

    const onEvent = (event: WorkflowRuntimeEvent): void => {
      if (this.core.closed) return
      let immediate = false
      if (event.type === 'node') {
        const idx = parseDslNodeIndex(event.node.id, run.nodesByIndex.size)
        run.nodesByIndex.set(idx, event.node)
        immediate =
          event.node.status === 'done' || event.node.status === 'failed' || event.node.status === 'aborted'
      } else if (event.type === 'phase') {
        appendRunTimeline({ at: event.at, kind: 'phase', index: event.index, title: event.title })
        immediate = true
      } else {
        appendRunTimeline({ at: event.at, kind: 'log', message: event.message })
        immediate = false
      }

      const now = Date.now()
      if (now - run.lastPersistAt >= PROGRESS_PERSIST_INTERVAL_MS || immediate) {
        run.lastPersistAt = now
        run.header.nodes = this.core.orderedNodesOf(run)
        if (run.timeline.length > 0) run.header.progress = run.timeline.slice(-caps.timelineCap)
        run.header.updatedAt = now
        try {
          repo.saveHeader(run.header)
        } catch (error) {
          writeRedactedStderr(redact, `workflow ${run.runId}: progress header save failed`, error)
        }
      }

      const publish = (): void => {
        run.lastEventAt = Date.now()
        this.core.emitEventSafe('workflow.updated', { run: this.core.liveSummaryOf(run) })
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
          if (!this.core.closed && this.core.active.has(run.runId)) publish()
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
          isSuspended: () => this.core.isRunSuspending(run),
          ...(opts.runtimeReadyGate !== undefined ? { runtimeReadyGate: opts.runtimeReadyGate } : {}),
          ...(opts.onReattachHorizon !== undefined ? { onReattachHorizon: opts.onReattachHorizon } : {}),
          ...caps,
          redact,
          onEvent,
          journal: {
            ...(opts.replayEntries.length > 0 ? { entries: opts.replayEntries } : {}),
            inPlaceResume: opts.inPlaceResume,
            retryFailedCalls: opts.retryFailedCalls,
            append: async (entry) => {
              await writer.append(redactJournalEntry(entry, redact))
            },
          },
        })
      } catch (error) {
        failure = error
      }
      await this.settleWorkflow(run, writer, opts.resumeJournalIoErrors, result, failure)
    })()
  }

  private async settleWorkflow(
    run: ActiveRun,
    writer: JournalWriter,
    resumeJournalIoErrors: string[] | undefined,
    result: WorkflowRunResult | undefined,
    failure?: unknown,
  ): Promise<void> {
    const { redact } = this.core.deps
    await this.core.executeSettlement(run, {
      applyOutcome: async (hostClosing) => {
        const header = run.header as DslWorkflowRunHeader
        const suspending = this.core.isRunSuspending(run) && result?.status !== 'completed'
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
          if (result.error !== undefined) header.error = redact(result.error)
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(failure, result.error, 'workflow_failed')
          } else {
            delete header.errorCode
          }
          if (result.value !== undefined) {
            const redactedVal = redactJsonValue(result.value, redact)
            run.detail.result = redactedVal
            header.hasResult = true
            header.resultPreview = formatResultPreview(redactedVal)
          }
        } else {
          header.status = hostClosing ? 'aborted' : 'failed'
          header.phase = 'settled'
          const message = failure !== undefined ? errorMessage(failure) : 'unknown workflow failure'
          header.error = redact(message)
          if (header.status === 'failed') {
            header.errorCode = classifyRunFailureCode(failure, message, 'workflow_failed')
          } else {
            delete header.errorCode
          }
        }

        const journalIoErrors = [
          ...(result?.journalIoErrors ?? []),
          ...(resumeJournalIoErrors ?? []),
          ...(writer.agentIoErrors > 0 ? [`${writer.agentIoErrors} journal agent-line append(s) failed`] : []),
        ]
        if (journalIoErrors.length > 0) {
          header.journalIoErrors = journalIoErrors.map((m) => redact(m))
        }

        const finalNodes = result !== undefined && result.nodes.length > 0 ? result.nodes : this.core.orderedNodesOf(run)
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
          header.resumable = inspectRunResumability(header, run.detail, this.core.resumabilityContext(), {
            mode: 'failed',
          }).resumable
        }
        return { suspending }
      },
      getNotifyInfo: () => ({ parentConversationId: run.conversationId }),
    })
  }
}
