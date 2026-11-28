/**
 * TrackerSettlement: logical-run registry and turn settlement for the ConversationTracker.
 *
 * Sole writer of mirror.runTaskId / runFirstEntry / settledRunOrder / lastSettledRun / settledInflight / settledError /
 * settledWaiters, and owner of the tracker-level `settledRuns` dedupe set (keyed `${conversationId}:${taskId}`,
 * bounded per conversation by settledRunOrder).
 *
 * Settlement ordering invariants (see emitSettled):
 * - beginSettled precedes everything (busy accounting reflects the in-flight callback before any event leaves);
 * - the terminal live frame (flushFinal) precedes turn_settled so empty tools/text signal stream completion;
 * - durable watermark first: store.upsertConv (completionSeq / stateChangeSeq / unread / runDurationMs) → onSummaryChanged
 *   → onTurnSettled → contextUsage refresh; plugins and read APIs observe identical state;
 * - synchronous throws call endSettled before rethrowing; async completions are guarded by the observe generation
 *   captured before beginSettled so a deleted/re-observed conversation never resurrects counters or errors.
 *
 * Run identity: runs are LOGICAL, not pi.live.run.taskId (handOver changes taskId while the run continues, see
 * isContinuedRun in tracker-observer.ts). Only a true run end or replacement settles; settledRuns guarantees exactly once.
 */

import type { ConversationInput, TurnOutcome, TurnSettledPayload } from '@helmx/protocol'
import type { ConversationView } from '@earendil-works/pi-durable'
import type { ConvMeta } from '../store.js'
import { summaryOf } from '../store.js'
import { lastErrorOf, statusNow } from '../conversation-tracker-helpers.js'
import type { ConversationMirror, LiveStateShape } from '../conversation-mirror.js'
import type { TrackerActivity } from './tracker-activity.js'
import type { TrackerCore } from './tracker-core.js'
import type { TrackerInputs } from './tracker-inputs.js'
import type { TrackerLive } from './tracker-live.js'
import type { TrackerSummary } from './tracker-summary.js'

/** Max settled runs retained per conversation (prevents unbounded growth in 24/7 operation; runIds are monotonic so oldest are evicted). */
const SETTLED_RUNS_PER_CONVERSATION = 64

/** Snapshot context handed over by adoption when deciding whether the previous run ended. */
export interface EndedRunContext {
  readonly mirror: ConversationMirror
  readonly view: ConversationView
  readonly prevRun: LiveStateShape['run'] | undefined
  readonly live: LiveStateShape | undefined
  readonly runContinued: boolean
}

export class TrackerSettlement {
  /** Already-settled runs (prevents done+failure+abort double reporting). Keyed globally with conversation prefix
   * (`${id}:${taskId}`); swept by prefix on stopObserving. */
  readonly settledRuns = new Set<string>()

  constructor(
    private readonly core: TrackerCore,
    private readonly activity: TrackerActivity,
    private readonly inputs: TrackerInputs,
    private readonly live: TrackerLive,
    private readonly summary: TrackerSummary,
  ) {}

  /** Wait for all in-flight turn_settled callbacks for this conversation to finish (used by waitForIdle; scoped per conversation). */
  async waitTurnSettled(conversationId: number): Promise<void> {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror !== undefined && mirror.settledInflight > 0) {
      await new Promise<void>((resolve) => {
        mirror.settledWaiters.push(resolve)
      })
    }
    const settledError = this.core.mirrors.get(conversationId)?.settledError
    if (settledError !== undefined) throw settledError
  }

  /** Whether the conversation currently has live work running (checked before abort settlement so idle stays idle). */
  hasLiveWork(conversationId: number): boolean {
    return this.core.mirrors.get(conversationId)?.live?.run !== undefined
  }

  /**
   * Whether resuming the scheduler would execute or admit work in this conversation: an active run
   * (re-driven) or queued inbox submissions (admitted on resume). Used by the startup node-join grace
   * to decide whether a conversation's bound node is needed before recovery (read-only fact, no state).
   */
  hasRunnableWork(conversationId: number): boolean {
    const mirror = this.core.mirrors.get(conversationId)
    return mirror !== undefined && (mirror.live?.run !== undefined || (mirror.inbox?.length ?? 0) > 0)
  }

  /** Whether the conversation has an active context compaction task (separate from hasLiveWork so compaction never fabricates turn_settled). */
  isCompacting(conversationId: number): boolean {
    return (this.core.mirrors.get(conversationId)?.live?.compactions?.length ?? 0) > 0
  }

  /** Abort settlement (called by runtime.abortConversation; guards against double reporting with the observe path). */
  settleAborted(conversationId: number): void {
    const mirror = this.core.mirrors.get(conversationId)
    const taskId = mirror?.runTaskId
    if (taskId !== undefined && mirror?.lastSettledRun === taskId) {
      // Observe path already settled this run (aborted/failed/completed): do not duplicate.
      this.inputs.resetConsumed(conversationId)
      return
    }
    if (taskId !== undefined) {
      this.noteSettledRun(conversationId, `${conversationId}:${taskId}`)
    }
    const all = this.inputs.takeCurrentRunInputs(conversationId)
    this.inputs.resetConsumed(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
    // Explicit abort settles outside the snapshot path: recompute the busy aggregate here too
    // (busy→idle needs no sync write, but a replacement run in the same tick must not be missed).
    this.activity.noteMutation()
  }

  /** Register a settled runKey while enforcing the per-conversation retention cap (evicts oldest to bound growth).
   *
   * runIds (taskIds) increase monotonically across the store: evicted keys can never recur, and settledRuns.delete(runKey)
   * on new runs only ever touches recent keys within the window, preserving exact semantics. */
  noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.core.mirrorOf(conversationId).settledRunOrder
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
  }

  /**
   * Settle the previous run when a snapshot shows it ended (complete / fail / replaced by a genuinely new run).
   * Returns true when the previous run was settled in this adopt (the caller then suppresses the idle summary fallback).
   */
  settleEndedRun(id: number, ctx: EndedRunContext): boolean {
    const { mirror, view, prevRun, live, runContinued } = ctx
    if (prevRun === undefined || (live?.run && live.run.taskId === prevRun.taskId) || runContinued) {
      return false
    }
    const runKey = `${id}:${prevRun.taskId}`
    if (!this.settledRuns.has(runKey)) {
      this.noteSettledRun(id, runKey)
      mirror.lastSettledRun = prevRun.taskId
      const failure = live?.runFailure
      if (failure && failure.taskId === prevRun.taskId) {
        for (const submissionId of failure.inputs) this.inputs.markConsumed(id, submissionId)
        const consumed = this.inputs.takeConsumed(id)
        if (failure.reason === 'aborted') {
          this.emitSettled(id, 'aborted', consumed, undefined)
        } else {
          this.emitSettled(
            id,
            'failed',
            consumed,
            `${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`,
          )
        }
      } else {
        const consumed = this.inputs.takeConsumed(id)
        this.emitSettled(id, 'completed', consumed, undefined)
      }
    }
    this.inputs.resetConsumed(id)
    const tail = view.entries.length
      ? Number(view.entries[view.entries.length - 1]?.id)
      : undefined
    if (tail !== undefined && Number.isFinite(tail)) {
      if (mirror.runFirstEntry === undefined || tail > mirror.runFirstEntry) mirror.runFirstEntry = tail
    }
    return true
  }

  /** Advance the registry to the run present in the snapshot: a genuinely new run resets consumed tracking and
   * forgets its (monotonic, hence never recurring) settled key; every admitted input is marked consumed. */
  advanceLiveRun(
    id: number,
    mirror: ConversationMirror,
    run: NonNullable<LiveStateShape['run']>,
    runContinued: boolean,
  ): void {
    if (!runContinued) {
      const meta = this.core.store.getConv(id)
      if (meta !== undefined && meta.runStartedAt === undefined) {
        this.core.store.upsertConv({ ...meta, runStartedAt: Date.now() })
      }
    }
    const runKey = `${id}:${run.taskId}`
    if (mirror.runTaskId !== run.taskId) {
      mirror.runTaskId = run.taskId
      if (!runContinued) {
        this.inputs.beginRunConsumption(id)
      }
      this.settledRuns.delete(runKey)
      this.dropSettledRunFromOrder(id, runKey)
      const first = run.first !== undefined ? Number(run.first) : undefined
      if (first !== undefined) {
        if (mirror.runFirstEntry === undefined || first > mirror.runFirstEntry) mirror.runFirstEntry = first
      }
    }
    for (const submissionId of run.inputs) {
      this.inputs.markConsumed(id, submissionId)
    }
  }

  /** Initial attach with an active (recovered) run: seed the run registry and start a fresh consumed set before the
   * run's inputs are backfilled from authoritative SDK mappings. */
  seedRecoveredRun(id: number, taskId: number, first: number | undefined): void {
    const mirror = this.core.mirrorOf(id)
    mirror.runTaskId = taskId
    this.inputs.beginRunConsumption(id)
    if (first !== undefined) mirror.runFirstEntry = first
  }

  /** stopObserving: resolve turn_settled waiters before the mirror is dropped so waitForIdle never hangs
   * (woken waiters re-read a missing mirror and exit). */
  releaseWaiters(mirror: ConversationMirror | undefined): void {
    const settledWaiters = mirror?.settledWaiters ?? []
    for (const resolve of settledWaiters) resolve()
  }

  /** stopObserving: sweep this conversation's keys from the global settled-run dedupe set (repeated create/delete cycles never leak). */
  forgetConversation(conversationId: number): void {
    for (const runKey of this.settledRuns) {
      if (runKey.startsWith(`${conversationId}:`)) this.settledRuns.delete(runKey)
    }
  }

  emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const generation = this.core.mirrors.get(conversationId)?.observeGeneration
    this.beginSettled(conversationId)
    let completion: Promise<void> | void
    try {
      // Terminal flush of live view: precedes turn_settled (empty tools/text signals stream completion).
      this.live.flushFinal(conversationId)
      // Advance durable watermark first, then construct settlement snapshot so plugins and read APIs observe identical state.
      // Increment completionSeq + set unread (cleared only by explicit human PATCH).
      // Background derived sub-conversations (non-human ownership with parent chain, e.g. managed subagents / Swarm
      // workers) never fabricate human unread flags on completion; human forks (parent chain + human ownership) and top-level
      // direct conversations preserve unread semantics. Failures/aborts never set unread (existing contract).
      const settledAt = Date.now()
      const meta = this.core.store.getConv(conversationId)
      if (meta) {
        const unread = outcome === 'completed' && !this.summary.isBackgroundDerived(conversationId, meta)
        const elapsedMs =
          meta.runStartedAt !== undefined && settledAt >= meta.runStartedAt
            ? settledAt - meta.runStartedAt
            : 0
        const updated: ConvMeta = {
          ...meta,
          unread,
          completionSeq: meta.completionSeq + 1,
          stateChangeSeq: meta.stateChangeSeq + 1,
          runDurationMs: meta.runDurationMs + elapsedMs,
          runStartedAt: undefined,
          updatedAt: settledAt,
        }
        this.core.store.upsertConv(updated)
        const settledStatus = unread ? 'done' : statusNow(updated, outcome)
        // Failed terminal diagnostic summary shares single source with summaryOf: emitSettled bypasses tracker derivation,
        // so it must include lastError here (otherwise the first conversation.upsert drops the error reason);
        // likewise attach cached contextUsage synchronously (post-settlement async refresh updates later if changed).
        const settledRaw = summaryOf({
          meta: updated,
          status: settledStatus,
          pendingAskCount: 0,
          lastError: settledStatus === 'error' ? lastErrorOf(this.core.mirrors.get(conversationId)?.live, this.core.redactError) : undefined,
          lastEntryId: this.core.lastEntryIds.get(conversationId) ?? updated.lastEntryId ?? 0,
          effectiveModelRef: this.core.effectiveModelRefOf?.(conversationId),
          runtimeModelOverride: this.core.hasRuntimeModelOverride?.(conversationId),
        })
        const cachedUsage = this.summary.peekUsage(conversationId)
        const settledSummary = cachedUsage === undefined ? settledRaw : { ...settledRaw, contextUsage: cachedUsage }
        // Record terminal summary fingerprint so subsequent idle snapshots do not re-emit identical terminal frames.
        this.summary.publishSummary(conversationId, settledSummary)
        // Context changed after turn settlement: schedule async usage refresh (emits upsert only on change; never bumps seq).
        this.summary.scheduleUsage(conversationId, { publishWhenReady: cachedUsage === undefined })
      }
      const payload: TurnSettledPayload = {
        conversation: this.summary.summaryOf(conversationId, outcome),
        inputs,
        outcome,
        error,
        settledAt,
      }
      completion = this.core.events.onTurnSettled(payload, inputs)
    } catch (error) {
      this.endSettled(conversationId)
      throw error
    }
    if (completion === undefined) {
      this.endSettled(conversationId)
    } else {
      void completion.then(
        () => {
          if (this.core.mirrors.get(conversationId)?.observeGeneration === generation) this.endSettled(conversationId)
        },
        (error: unknown) => {
          const mirror = this.core.mirrors.get(conversationId)
          if (mirror === undefined || mirror.observeGeneration !== generation) return
          mirror.settledError = error
          this.endSettled(conversationId)
        },
      )
    }
  }

  private beginSettled(conversationId: number): void {
    const mirror = this.core.mirrorOf(conversationId)
    if (mirror.settledInflight === 0) mirror.settledError = undefined
    mirror.settledInflight += 1
    this.activity.syncMirror(mirror)
    this.activity.noteMutation()
  }

  private endSettled(conversationId: number): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined || mirror.settledInflight === 0) return
    mirror.settledInflight -= 1
    this.activity.syncMirror(mirror)
    this.activity.noteMutation()
    if (mirror.settledInflight > 0) return
    const waiters = mirror.settledWaiters
    mirror.settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Remove a specific runKey from the retention order list (used when clearing settledRuns on new run start). */
  private dropSettledRunFromOrder(conversationId: number, runKey: string): void {
    const order = this.core.mirrors.get(conversationId)?.settledRunOrder
    if (order === undefined) return
    const index = order.indexOf(runKey)
    if (index >= 0) order.splice(index, 1)
  }
}
