/**
 * ConversationTracker: pi-durable conversation view layer for Helmx.
 *
 * This file is the facade (public surface + composition root). The mechanism lives in single-purpose collaborator
 * modules under `tracker/`, each owning an explicit slice of state and wired here in dependency order
 * (facade → observer → settlement → {inputs, live, activity, summary, compaction} → core; no module imports the facade):
 * - tracker-core.ts: shared deps + registries (mirrors, lastEntryIds, diagnostics) and the mirror-field ownership table;
 * - tracker-observer.ts: observer lifecycle, adopt / adoptInitial, entry watermarks, stopObserving;
 * - tracker-settlement.ts: logical-run registry, turn_settled emission, explicit abort settlement;
 * - tracker-inputs.ts: input identity (requestId) and submissionId correlation, consumed tracking;
 * - tracker-live.ts: throttled live frames and live view snapshots;
 * - tracker-activity.ts: busy accounting and idle→busy notification;
 * - tracker-summary.ts: five-state summaries, doing summaries, pending asks, assistant text cache, contextUsage;
 * - tracker-compaction.ts: compaction failure notices and end-of-compaction reconciliation.
 *
 * Core mechanism: observeConversation synchronous observer (never awaits inside advance, only records),
 * synchronously updating in-memory mirrors on snapshot pushes and queuing side effects (SSE pushes emit in microtasks).
 *
 * State layout (see conversation-mirror.ts / context-usage-refresh.ts):
 * - All per-conversation runtime state aggregates into a single ConversationMirror (mirrors), reclaimed cleanly as a whole
 *   on stopObserving; cross-conversation indexes (settledRuns deduplication set) and compaction failure flags that must
 *   survive stopObserving (notifiedCompactionFailures) stay outside the mirror;
 * - contextUsage caching and refresh chaining are isolated in ContextUsageRefresh (in-flight refreshes can outlive stopObserving).
 *
 * Exact turn_settled tracking:
 * - Inputs use durable input.id (i.e., SDK requestId) as the unique tracking identity: registerInput registers before submit,
 *   and bindSubmission backfills the submissionId -> requestId correlation index;
 * - Observe paths (helmx.input entries / pi.inbox reconstruction) idempotently merge into the single record by requestId;
 *   entry reconstruction only counts the active run window (>= run.first) and current inbox so settled historical helmx.input
 *   never resurrects; on restart recovery of active runs, live.run.inputs authoritative manifest + submission queries backfill
 *   metadata and indexes;
 * - Runs are identified by LOGICAL identity, not by pi.live.run.taskId: pi-durable hands run control to a new generation
 *   task after every tool round and on onYield continuations (handOver), so taskId changes while the run continues (first
 *   entry kept, inputs carried over). Same-run handOver accumulates consumed inputs across rounds; only a true run end or
 *   replacement (run disappears, or a snapshot carries a different logical run) settles;
 * - Run disappearance (complete/fail) settles exactly once (settledRuns prevents duplicate reports; failures use the
 *   exact runFailure.inputs manifest);
 * - Explicit abort via runtime.abortConversation settles immediately (observe path does not double-report);
 * - Explicit abort after observing failure only patches aborted without re-emitting failure;
 * - While a run is active, live summaries emit on start / semantic doing changes (emitRunSummary, deduplicated at
 *   semantic granularity rather than per token; emitSettled remains solely responsible for terminal state).
 */

import type {
  ConversationInput,
  ConversationLive,
  ConversationSummary,
  HubActivityCounts,
  TurnOutcome,
} from '@helmx/protocol'
import type { KernelDiagnosticSink } from './diagnostics.js'
import { TrackerCore, type TrackerCoreOptions, type TrackerEvents, type TurnSettledListener } from './tracker/tracker-core.js'
import { TrackerInputs } from './tracker/tracker-inputs.js'
import { TrackerLive } from './tracker/tracker-live.js'
import { TrackerActivity } from './tracker/tracker-activity.js'
import { TrackerSummary } from './tracker/tracker-summary.js'
import { TrackerCompaction } from './tracker/tracker-compaction.js'
import { TrackerSettlement } from './tracker/tracker-settlement.js'
import { TrackerObserver } from './tracker/tracker-observer.js'

export { deriveTitle } from './conversation-tracker-helpers.js'
export { isContinuedRun, type RunIdentityShape } from './tracker/tracker-observer.js'
export type { TrackerEvents, TurnSettledListener }
export type { LiveStateShape } from './conversation-mirror.js'

export class ConversationTracker {
  /** @internal Shared registries (mirrors, lastEntryIds) and diagnostic sink; see tracker/tracker-core.ts. */
  readonly core: TrackerCore
  /** @internal Input identity / submission correlation. */
  readonly inputs: TrackerInputs
  /** @internal Throttled live frames. */
  readonly live: TrackerLive
  /** @internal Busy accounting and idle→busy notification. */
  readonly activity: TrackerActivity
  /** @internal Summary derivation and contextUsage chain. */
  readonly summary: TrackerSummary
  /** @internal Compaction failure notices / reconciliation. */
  readonly compaction: TrackerCompaction
  /** @internal Run registry and turn settlement. */
  readonly settlement: TrackerSettlement
  /** @internal Observer lifecycle and snapshot adoption (attaches/detaches the SDK observer; not the SDK Observer itself). */
  readonly observer: TrackerObserver

  constructor(options: TrackerCoreOptions) {
    this.core = new TrackerCore(options)
    this.inputs = new TrackerInputs(this.core)
    this.live = new TrackerLive(this.core)
    this.activity = new TrackerActivity(this.core)
    this.summary = new TrackerSummary(this.core)
    this.compaction = new TrackerCompaction(this.core)
    this.settlement = new TrackerSettlement(this.core, this.activity, this.inputs, this.live, this.summary)
    this.observer = new TrackerObserver({
      core: this.core,
      inputs: this.inputs,
      live: this.live,
      activity: this.activity,
      summary: this.summary,
      compaction: this.compaction,
      settlement: this.settlement,
    })
  }

  /** Attach or replace the diagnostic sink (wired during KernelRuntime construction). */
  setDiagnosticSink(sink: KernelDiagnosticSink | undefined): void {
    this.core.setDiagnosticSink(sink)
  }

  /** Attach a synchronous observer to the conversation; backfills authoritative input metadata for active runs before returning. */
  observe(id: number): Promise<void> {
    return this.observer.observe(id)
  }

  /** Close tracker: stop observing all conversations and block late in-flight async settlement side effects. */
  close(): void {
    this.observer.close()
  }

  stopObserving(id: number): void {
    this.observer.stopObserving(id)
  }

  /** Permanent conversation deletion cleanup: detaches observer and clears compaction failure dedupe state. */
  deleteConversation(id: number): void {
    this.observer.stopObserving(id)
    this.compaction.forgetConversation(id)
  }

  /** Register input metadata before submission (using durable input.id = requestId as tracking key;
   * bindSubmission registers the submissionId correlation index once submit returns). */
  registerInput(conversationId: number, input: ConversationInput): void {
    this.inputs.registerInput(conversationId, input)
  }

  /** Register submissionId -> requestId correlation after submit returns (SDK run.inputs etc. identify inputs
   * by submissionId; maps back to tracking identity, and dropInput removes on HelmxError). */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.inputs.bindSubmission(conversationId, requestId, submissionId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.inputs.dropInput(conversationId, requestId)
  }

  /** Clean up correlation entry and requestId tracking record when a queued submission is withdrawn. */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    this.inputs.dropSubmission(conversationId, submissionId, requestId)
  }

  /** Snapshot of inputs belonging to the current active run (used by before_turn payload). */
  currentRunInputs(conversationId: number): ConversationInput[] {
    return this.inputs.currentRunInputs(conversationId)
  }

  /** Wait for all in-flight turn_settled callbacks for this conversation to finish (used by waitForIdle; scoped per conversation). */
  waitTurnSettled(conversationId: number): Promise<void> {
    return this.settlement.waitTurnSettled(conversationId)
  }

  /** Whether the conversation currently has live work running (checked before abort settlement so idle stays idle). */
  hasLiveWork(conversationId: number): boolean {
    return this.settlement.hasLiveWork(conversationId)
  }

  /** Whether resuming the scheduler would execute or admit work in this conversation (run or queued inbox). */
  hasRunnableWork(conversationId: number): boolean {
    return this.settlement.hasRunnableWork(conversationId)
  }

  /** Whether the conversation has an active context compaction task (never fabricates turn_settled). */
  isCompacting(conversationId: number): boolean {
    return this.settlement.isCompacting(conversationId)
  }

  /** Whether the conversation currently has any Hub-tracked active work (run, queued inbox, compaction, or turn_settled in flight). */
  isConversationBusy(conversationId: number): boolean {
    return this.activity.isConversationBusy(conversationId)
  }

  activitySnapshot(): HubActivityCounts {
    return this.activity.snapshot()
  }

  /** Register a synchronous idle→busy transition listener (activity heartbeat); returns an unsubscribe function. */
  onActivityBusyEntered(listener: () => void): () => void {
    return this.activity.onBusyEntered(listener)
  }

  /** Live views for SSE snapshot: only conversations with an active run, streaming generation, or non-empty queue. */
  listLiveViews(): ConversationLive[] {
    return this.live.listViews()
  }

  /** Abort settlement (called by runtime.abortConversation; guards against double reporting with the observe path). */
  settleAborted(conversationId: number): void {
    this.settlement.settleAborted(conversationId)
  }

  /** Clear leftover queued tracking records after an explicit abort while idle. */
  clearQueuedTracking(conversationId: number): void {
    this.inputs.clearQueuedTracking(conversationId)
  }

  /** Derive the five-state status from store meta + live mirror (blocked takes priority over working on derivation). */
  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    return this.summary.summaryOf(conversationId, pendingAskOverride)
  }

  /** Schedule an async context usage refresh (public port for service/ops consumers). */
  scheduleContextUsageRefresh(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    this.summary.scheduleUsage(conversationId, options)
  }

  /** Invalidate context usage cache on models.changed (refreshes observed/cached conversations of the rotated providers). */
  onModelsChanged(providers: readonly string[]): void {
    this.summary.onModelsChanged(providers)
  }

  /** Ensure a conversation's contextUsage cache is populated and its refresh chain settled (first detail read, etc.). */
  ensureContextUsage(conversationId: number): Promise<void> {
    return this.summary.ensureUsage(conversationId)
  }

  setPendingAskCount(conversationId: number, count: number): void {
    this.summary.setPendingAskCount(conversationId, count)
  }

  /** Record latest observed assistant text (data source for getLastAssistantText). */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    this.summary.recordAssistantText(conversationId, entryId, text)
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.summary.getLastAssistantText(conversationId)
  }

  /** Invalidate lastAssistant cache entries inside a rewound interval (after in-place overwrite & resend). */
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    this.summary.invalidateLastAssistantWithin(conversationId, from, through)
  }
}
