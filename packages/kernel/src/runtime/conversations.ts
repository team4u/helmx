/**
 * ConversationTracker: pi-durable conversation view layer for Helmx.
 *
 * Core mechanism: observeConversation synchronous observer (never awaits inside advance, only records),
 * synchronously updating in-memory mirrors on snapshot pushes and queuing side effects (SSE pushes emit in microtasks).
 *
 * State layout (see conversation-mirror.ts / context-usage-refresh.ts):
 * - All per-conversation runtime state aggregates into a single ConversationMirror (mirrors), reclaimed cleanly as a whole
 *   on stopObserving; cross-conversation indexes (settledRuns deduplication set) and compaction failure flags that must
 *   survive stopObserving (notifiedCompactionFailures) stay at tracker top-level;
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
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationStatus,
  ConversationSummary,
  HubActivityCounts,
  TurnOutcome,
  TurnSettledPayload,
} from '@helmx/protocol'
import {
  HelmxError,
  isHubActivityBusy,
  sameConversationLiveContent,
  sameQueuedInputs,
} from '@helmx/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { EntryRecord, Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConvMeta, HelmxStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'
import { rewindIntervalOf, coveredByRewind, type RewindInterval } from './conversation-rewind.js'
import { emitDiagnostic, type KernelDiagnosticInput, type KernelDiagnosticSink } from './diagnostics.js'
import { compactionFailureNoticeOf } from './context-usage.js'
import { ContextUsageRefresh, type ContextUsageHost } from './context-usage-refresh.js'
import {
  collectWindowWatermarks,
  deriveTitle,
  detectCompactionTransitions,
  extractHelmxInputMetas,
  findLatestAssistantEntry,
  lastErrorOf,
  latestVisibleEntryIdOf,
  loadRunInputEntriesFromSdk,
  statusNow,
  summaryKeyOf,
} from './conversation-tracker-helpers.js'
import { getSdkConversation, getSdkTask, observeSdkConversation, scanSdkEntries } from './sdk-ids.js'
import {
  type ConversationMirror,
  createConversationMirror,
  type HelmxInputMeta,
  type InboxItemShape,
  inputFromMeta,
  type LiveStateShape,
  mergeInputMeta,
} from './conversation-mirror.js'

export { deriveTitle }

export type { LiveStateShape }

interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): Promise<void> | void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
  /** New timeline entry persisted to store (new items only, once per ID; omits historical entries from initial observe). */
  onEntryCommitted?(conversationId: number, entry: ConversationEntry): void
  /** Live conversation delta (accumulated streaming text snapshot + tool cards; throttled pushes, flushed at settlement). */
  onLiveChanged?(live: ConversationLive): void
  /** Asynchronous failures such as compaction failure reported once explicitly via EventHub notification channel. */
  onNotification?(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string; conversationId: number }): void
}

/** Live throttling window (ms): 75ms inside 50-100ms range balances SSE frame rate against commit load. */
const LIVE_THROTTLE_MS = 75

/** Max settled runs retained per conversation (prevents unbounded growth in 24/7 operation; runIds are monotonic so oldest are evicted). */
const SETTLED_RUNS_PER_CONVERSATION = 64

/** Run shape used by logical-run identity comparison (subset of LiveStateShape.run). */
export interface RunIdentityShape {
  taskId: number
  inputs: number[]
  first?: number
}

/**
 * Whether `next` is the SAME logical run as `prev` after a pi-durable handOver.
 *
 * pi-durable 1.5.x hands run control from one generation task to the next after every tool round and on onYield
 * continuations: `pi.live.run.taskId` changes while the run continues — `first` (the run's first entry) is kept and
 * the previous inputs are carried over (possibly grown by steers admitted at the boundary). A genuinely new run gets
 * a fresh `first` (boundary-placed entry, strictly newer) and disjoint inputs. When `first` was never recorded on
 * either side, fall back to inputs carry-over; ambiguity resolves to "new run" (settle) which matches the
 * run-disappearance semantics.
 */
export function isContinuedRun(prev: RunIdentityShape, next: RunIdentityShape | undefined): boolean {
  if (next === undefined) return false
  if (next.taskId === prev.taskId) return true
  if (prev.first !== undefined && next.first !== undefined) return next.first === prev.first
  return prev.inputs.length > 0 && prev.inputs.every((id) => next.inputs.includes(id))
}

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmxStore
  private readonly events: TrackerEvents
  /** conversation -> per-conversation aggregate mirror (created on observe or first write; deleted wholesale on stopObserving). */
  private readonly mirrors = new Map<number, ConversationMirror>()
  /** Already-settled runs (prevents done+failure+abort double reporting). Keyed globally with conversation prefix (`${id}:${taskId}`)
   * outside mirror so it persists cleanly and is swept by prefix on stopObserving. */
  private readonly settledRuns = new Set<string>()
  /** Idle→busy transition listeners (activity heartbeat; see `onActivityBusyEntered`). */
  private readonly activityBusyListeners = new Set<() => void>()
  /** Last computed aggregate busy predicate (drives idle→busy transition detection). */
  private activityBusyAggregate = false
  /** Incremental O(1) running activity totals across `this.mirrors`. */
  private busyActiveTotal = 0
  private busyCompactionsTotal = 0
  private busyQueuedTotal = 0
  private busySettlingTotal = 0
  /** conversation -> taskId of last notified compaction failure (prevents duplicate notifications across snapshots;
   * intentionally survives stopObserving so re-observing within the same runtime never re-notifies the same failure). */
  private readonly notifiedCompactionFailures = new Map<number, number>()
  /** contextUsage cache/refresh chain (in-flight refreshes can outlive stopObserving, state stays outside mirror). */
  private readonly usage: ContextUsageRefresh
  /** conversation -> latest visible timeline entry ID (`0` when none; excludes `pi.system` and rewound intervals). */
  private readonly lastEntryIds = new Map<number, number>()
  /** Tracker shutdown guard (blocks late async reconciliation side effects after close() or host isClosed becomes true). */
  private closed = false

  constructor(options: {
    harness: Harness
    store: HelmxStore
    events: TrackerEvents
    /** Error summary redactor (shared source with runtime SecretStash); defaults to identity (test environments only). */
    redactError?: (text: string) => string
    /** Current conversation ownership reader (injected by Runtime via ownership.getOwnership); defaults to human.
     * Used solely for unread policy on turn settlement so background derived sub-conversations never mark fake human unreads. */
    ownershipOf?: (id: number) => 'helmx' | 'human'
    /** Current Models catalog reader (for contextUsage window lookup); if omitted, contextWindow stays unset without fabricating. */
    models?: () => Models
    /** Host closing predicate (double protection alongside tracker.close()). */
    isClosed?: () => boolean
    /** Diagnostic channel sink (defaults to defaultDiagnosticSink). */
    onDiagnostic?: KernelDiagnosticSink
  }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
    this.redactError = options.redactError ?? ((text) => text)
    this.ownershipOf = options.ownershipOf
    this.modelsOf = options.models
    this.isClosedFn = options.isClosed
    this.diagnosticSink = options.onDiagnostic
    const host: ContextUsageHost = {
      harness: this.harness,
      store: this.store,
      onSummaryChanged: (summary) => this.events.onSummaryChanged(summary),
      modelsOf: () => this.modelsOf?.(),
      generationOf: (id) => this.mirrors.get(id)?.observeGeneration,
      liveOf: (id) => this.mirrors.get(id)?.live,
      summaryOf: (id) => this.summaryOf(id),
      isClosing: () => this.isClosing,
      emitDiagnostic: (input) => this.reportDiagnostic(input),
    }
    this.usage = new ContextUsageRefresh(host)
  }

  /** Error summary redactor (Runtime injects stashService.redact so provider errors cannot echo registered secrets). */
  private readonly redactError: (text: string) => string

  /** Diagnostic channel sink (injectable after Runtime construction; defaults to defaultDiagnosticSink). */
  private diagnosticSink: KernelDiagnosticSink | undefined

  /** Attach or replace the diagnostic sink (wired during KernelRuntime construction). */
  setDiagnosticSink(sink: KernelDiagnosticSink | undefined): void {
    this.diagnosticSink = sink
  }

  private reportDiagnostic(input: KernelDiagnosticInput): void {
    emitDiagnostic(this.diagnosticSink, this.redactError, input)
  }

  /** Live conversation ownership reader (defaults to human); consumed solely by unread policy on turn settlement. */
  private readonly ownershipOf: ((id: number) => 'helmx' | 'human') | undefined

  /** Live Models catalog reader (if omitted, window stays unset). */
  private readonly modelsOf: (() => Models) | undefined

  /** Host closing state reader (defaults to false; double guard alongside tracker.closed). */
  private readonly isClosedFn: (() => boolean) | undefined

  private get isClosing(): boolean {
    return this.closed || (this.isClosedFn?.() ?? false)
  }

  /** Get (creating if needed) the mirror for a conversation: single entry point for all write paths. */
  private mirrorOf(id: number): ConversationMirror {
    let mirror = this.mirrors.get(id)
    if (mirror === undefined) {
      mirror = createConversationMirror()
      this.mirrors.set(id, mirror)
    }
    return mirror
  }

  /** Attach a synchronous observer to the conversation; backfills authoritative input metadata for active runs before returning. */
  async observe(id: number): Promise<void> {
    if (this.mirrors.get(id)?.detach !== undefined) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        const mirror = this.mirrors.get(id)
        if (mirror !== undefined) mirror.detach = undefined
        this.clearLiveTimer(id)
      },
    }
    const observation: Observation<ConversationView> = await observeSdkConversation(
      this.harness,
      id,
      observer,
      BACKGROUND_CONTEXT,
    )
    const mirror = this.mirrorOf(id)
    mirror.detach = () => observation.detach()
    // Initial snapshot: do not replay existing items in the window (first attach only aligns watermarks).
    // Generation guard: if stopObserving runs (or re-observe swaps generation) across await, skip writing back to mirror.
    const generation = Symbol('conversation observation')
    mirror.observeGeneration = generation
    await this.adoptInitial(id, observation.value, generation)
  }

  /** Initial attachment: registers watermarks and internal mirrors without emitting entry/live events.
   *
   * When recovering an active run (restart/re-attach), the run's helmx.input entry may have slid out of the
   * observe window on long runs, causing synchronous reconstruction to lose input metadata. We backfill via
   * SDK authoritative mappings: live.run.inputs gives the exact submissionIds admitted to this run, which we look
   * up via harness.submission() for entry IDs and fetch precisely (minEntryId=maxEntryId) to restore origin/meta/attachments;
   * queued items come from pi.inbox. Never rely on widening the observe window or heuristic sorting instead. */
  private async adoptInitial(
    id: number,
    view: ConversationView,
    generation: symbol,
  ): Promise<void> {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    mirror.live = live ?? {}
    // Honest startup/re-attach cleanup: if no live run is active but a stale `runStartedAt`
    // remained persisted (e.g. crash without resuming), clear it without adding downtime to `runDurationMs`.
    if (!live?.run) {
      const meta = this.store.getConv(id)
      if (meta !== undefined && meta.runStartedAt !== undefined) {
        this.store.upsertConv({ ...meta, runStartedAt: undefined })
      }
    }
    // Report lingering compaction failures even right after restart/re-attach (once per runtime lifecycle).
    this.noteCompactionFailure(id, live)
    const watermarks = collectWindowWatermarks(
      view.entries,
      mirror.lastEmittedEntry,
      mirror.lastSeenEntryId,
    )
    mirror.lastEmittedEntry = watermarks.watermark
    mirror.lastSeenEntryId = watermarks.seenEntryId
    // Seed latest persisted assistant watermark (and in-memory lastAssistant cache) so subsequent streaming
    // adopt ticks do not re-trigger FTS5 trigram indexing for historical assistant entries already persisted before observe.
    const latestAssistant = findLatestAssistantEntry(view.entries)
    if (latestAssistant !== undefined) {
      if (Number.isFinite(latestAssistant.entryId)) {
        mirror.lastIndexedAssistantEntryId = latestAssistant.entryId
        mirror.lastAssistant ??= latestAssistant
      }
    }
    if (watermarks.usageWatermark >= 0) this.usage.advanceWatermarkTo(id, watermarks.usageWatermark)
    let initialLastEntryId = latestVisibleEntryIdOf(view.entries)
    const mergedInitialLastEntryId = Math.max(this.lastEntryIds.get(id) ?? 0, initialLastEntryId)
    this.lastEntryIds.set(id, mergedInitialLastEntryId)
    this.store.setLastEntryId?.(id, mergedInitialLastEntryId)
    // Register inbox mirror before checking live.run: even after a restart/stopped run with queued inputs remaining,
    // queuedInputs derivation and listLiveViews snapshots preserve queued state honestly without fabricating UI queues.
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)
    this.syncMirrorBusyContribution(mirror)
    this.noteActivityMutation()
    // Populate context usage cache on initial attach (initial read path for restart/fork/new conversations),
    // including idle conversations so opening a historical conversation displays its usage pill.
    this.usage.schedule(id)
    if (initialLastEntryId === 0 && view.before !== undefined) {
      initialLastEntryId = await this.scanLatestVisibleEntryId(id)
      if (this.mirrors.get(id)?.observeGeneration !== generation) return
      const merged = Math.max(this.lastEntryIds.get(id) ?? 0, initialLastEntryId)
      this.lastEntryIds.set(id, merged)
      this.store.setLastEntryId?.(id, merged)
    }
    if (!live?.run) return
    mirror.runTaskId = live.run.taskId
    mirror.consumedInputs = new Set<string>()
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    if (first !== undefined) mirror.runFirstEntry = first
    // Admitted inputs for this run: back-read entry via authoritative SDK submissionId -> entry mapping,
    // registering requestId tracking records and submissionId -> requestId indexes so markConsumed hits.
    const loaded = await loadRunInputEntriesFromSdk(this.harness, id, live.run.inputs)
    // If stopObserving swapped generation, discard async read results rather than re-populating a cleaned mirror.
    if (this.mirrors.get(id)?.observeGeneration !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.indexRestoredSubmissions(id, loaded.pairs)
    // Queued (not yet admitted) inputs: read directly from inbox entries (mirror registered above; just backfill input metadata).
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
    // Active recovered runs already appear in snapshot summaries (listConversations): seed the semantic dedupe key
    // so subsequent adopts only emit on actual status/doing transitions instead of pushing redundant working frames.
    if (this.store.getConv(id)) mirror.lastSummaryKey = summaryKeyOf(this.summaryOf(id))
    // Recovered active runs/queues make the runtime busy from the very first mirror write.
    this.syncMirrorBusyContribution(mirror)
    this.noteActivityMutation()
  }

  /** Register restored authoritative (submissionId, requestId) pairs in the correlation index. */
  private indexRestoredSubmissions(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const index = this.mirrorOf(id).submissionIndex
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
  }

  /** Rebuild queued inbox items (backfills origin/meta/attachments and registers indexes for un-admitted inputs). */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmxInputMeta | undefined
      if (item.entry?.kind !== 'helmx.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // Inbox item id is SDK submissionId: register correlation index so markConsumed matches once dequeued.
      this.mirrorOf(id).submissionIndex.set(item.id, data.id)
      this.upsertTrackedInput(id, data.id, data)
    }
  }

  /** Close tracker: stop observing all conversations and block late in-flight async settlement side effects. */
  close(): void {
    this.closed = true
    for (const id of [...this.mirrors.keys()]) {
      this.stopObserving(id)
    }
  }

  stopObserving(id: number): void {
    const mirror = this.mirrors.get(id)
    mirror?.detach?.()
    // Cancel pending timer and discard queued snapshots: never emit ghost events after deletion/unobserve.
    this.clearLiveTimer(id)
    // Clean up contextUsage mirror together: late async refreshes after unobserve/deletion drop via generation guard;
    // unblock refresh waiters immediately so they inspect missing mirror/cache and exit without hanging.
    this.usage.clearConversation(id)
    // Purge all in-memory mirrors for this conversation: resolve turn_settled waiters first (preventing hangs),
    // then clear mirror and global settledRuns prefix keys so repeated create/delete cycles never leak entries.
    const settledWaiters = mirror?.settledWaiters ?? []
    for (const resolve of settledWaiters) resolve()
    if (mirror !== undefined) {
      this.busyActiveTotal -= mirror.busyActive
      this.busyCompactionsTotal -= mirror.busyCompactions
      this.busyQueuedTotal -= mirror.busyQueued
      this.busySettlingTotal -= mirror.busySettling
      mirror.busyActive = 0
      mirror.busyCompactions = 0
      mirror.busyQueued = 0
      mirror.busySettling = 0
    }
    this.mirrors.delete(id)
    this.lastEntryIds.delete(id)
    for (const runKey of this.settledRuns) {
      if (runKey.startsWith(`${id}:`)) this.settledRuns.delete(runKey)
    }
    this.noteActivityMutation()
  }

  /** Permanent conversation deletion cleanup: detaches observer and clears compaction failure dedupe state. */
  deleteConversation(id: number): void {
    this.stopObserving(id)
    this.notifiedCompactionFailures.delete(id)
  }

  /** Scan backwards from tail when the initial 50-entry view window contained only hidden entries. */
  private async scanLatestVisibleEntryId(id: number): Promise<number> {
    const conversation = await getSdkConversation(this.harness, id, BACKGROUND_CONTEXT)
    if (!conversation || typeof conversation.entries !== 'function') return 0
    const cuts: RewindInterval[] = []
    let cursor: unknown = undefined
    for (;;) {
      const page = await scanSdkEntries(conversation, 'descending', 100, cursor, BACKGROUND_CONTEXT)
      for (const raw of page.items) {
        if (raw.kind === 'helmx.rewind') {
          const cut = rewindIntervalOf(raw)
          if (cut !== undefined) cuts.push(cut)
        }
        const numeric = Number(raw.id)
        if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
        if (raw.kind === 'pi.system') continue
        if (raw.kind !== 'helmx.rewind' && coveredByRewind(numeric, cuts)) continue
        return numeric
      }
      if (page.next === undefined) return 0
      cursor = page.next
    }
  }

  /** Clear live throttling timer (idempotent). */
  private clearLiveTimer(id: number): void {
    const mirror = this.mirrors.get(id)
    const timer = mirror?.liveTimer
    if (timer !== undefined && mirror !== undefined) {
      clearTimeout(timer)
      mirror.liveTimer = undefined
    }
  }

  /** Register input metadata before submission (using durable input.id = requestId as tracking key;
   * bindSubmission registers the submissionId correlation index once submit returns). */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.mirrorOf(conversationId).trackedInputs
    // The same requestId may already have a record from entry/inbox observation (e.g., rewind tx commits
    // before registration finishes): fill only missing fields (richer in-memory metadata wins) without duplicating.
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
  }

  /** Register submissionId -> requestId correlation after submit returns (SDK run.inputs etc. identify inputs
   * by submissionId; maps back to tracking identity, and dropInput removes on HelmxError). */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.mirrorOf(conversationId).submissionIndex.set(submissionId, requestId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.mirrors.get(conversationId)?.trackedInputs.delete(requestId)
  }

  /** Clean up correlation entry and requestId tracking record when a queued submission is withdrawn. */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const resolved = requestId ?? mirror.submissionIndex.get(submissionId)
    mirror.submissionIndex.delete(submissionId)
    if (resolved !== undefined) mirror.trackedInputs.delete(resolved)
  }

  /** Snapshot of inputs belonging to the current active run (used by before_turn payload): exact run.inputs
   * sequence (including steered additions) plus any registered submissions still in flight without a submissionId yet,
   * deduplicated by input.id. */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const run = mirror?.live?.run
    if (!run || !mirror) return []
    const map = mirror.trackedInputs
    const index = mirror.submissionIndex
    const out: ConversationInput[] = []
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    // run.inputs gives the exact sequence of submissionIds admitted to this run (including already-consumed ones),
    // mapped back to tracking identity via submissionIndex.
    for (const submissionId of run.inputs) {
      const requestId = index.get(submissionId)
      if (requestId !== undefined) collect(map.get(requestId))
    }
    // Registered records without a bound submissionId yet: in-flight submits (e.g., queued followUp before placement).
    const bound = new Set(index.values())
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
    }
    return out
  }

  /** Wait for all in-flight turn_settled callbacks for this conversation to finish (used by waitForIdle; scoped per conversation). */
  async waitTurnSettled(conversationId: number): Promise<void> {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined && mirror.settledInflight > 0) {
      await new Promise<void>((resolve) => {
        mirror.settledWaiters.push(resolve)
      })
    }
    const settledError = this.mirrors.get(conversationId)?.settledError
    if (settledError !== undefined) throw settledError
  }

  private settledInflightCount(conversationId: number): number {
    return this.mirrors.get(conversationId)?.settledInflight ?? 0
  }

  private beginSettled(conversationId: number): void {
    const mirror = this.mirrorOf(conversationId)
    if (mirror.settledInflight === 0) mirror.settledError = undefined
    mirror.settledInflight += 1
    this.syncMirrorBusyContribution(mirror)
    this.noteActivityMutation()
  }

  private endSettled(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.settledInflight === 0) return
    mirror.settledInflight -= 1
    this.syncMirrorBusyContribution(mirror)
    this.noteActivityMutation()
    if (mirror.settledInflight > 0) return
    const waiters = mirror.settledWaiters
    mirror.settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Whether the conversation currently has live work running (checked before abort settlement so idle stays idle). */
  hasLiveWork(conversationId: number): boolean {
    return this.mirrors.get(conversationId)?.live?.run !== undefined
  }

  /**
   * Whether resuming the scheduler would execute or admit work in this conversation: an active run
   * (re-driven) or queued inbox submissions (admitted on resume). Used by the startup node-join grace
   * to decide whether a conversation's bound node is needed before recovery (read-only fact, no state).
   */
  hasRunnableWork(conversationId: number): boolean {
    const mirror = this.mirrors.get(conversationId)
    return mirror !== undefined && (mirror.live?.run !== undefined || (mirror.inbox?.length ?? 0) > 0)
  }

  /** Whether the conversation has an active context compaction task (separate from hasLiveWork so compaction never fabricates turn_settled). */
  isCompacting(conversationId: number): boolean {
    return (this.mirrors.get(conversationId)?.live?.compactions?.length ?? 0) > 0
  }

  /** Whether the conversation currently has any Hub-tracked active work (run, queued inbox, compaction, or turn_settled in flight). */
  isConversationBusy(conversationId: number): boolean {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return false
    return (
      mirror.busyActive > 0 ||
      mirror.busyCompactions > 0 ||
      mirror.busyQueued > 0 ||
      mirror.busySettling > 0
    )
  }

  /**
   * Aggregate activity counts over live mirrors for the runtime's activity snapshot (the Hub's
   * process-private heartbeat file backing the launcher's update busy-gate):
   * - `activeConversations`: conversations with an active run (`live.run` — generating, tool
   *   rounds, and approval-blocked runs whose tool call is still in flight; `summaryOf` labels
   *   those `blocked`, the run itself stays live);
   * - `activeCompactions`: in-flight context-compaction tasks;
   * - `queuedConversations`: conversations with queued (not yet admitted) inbox input;
   * - `settlingConversations`: conversations whose `turn_settled` callbacks are still running.
   * Every conversation gets a mirror (startup recovery observes all), so mirror iteration is the
   * complete live view — idle conversations simply contribute zero. A pending approval whose run
   * already ended is durable state (AskDoc + CAS watermarks survive restart) and does not count.
   */
  private syncMirrorBusyContribution(mirror: ConversationMirror): void {
    const nextActive: 0 | 1 = mirror.live?.run !== undefined ? 1 : 0
    const nextCompactions = mirror.live?.compactions?.length ?? 0
    const nextQueued: 0 | 1 = (mirror.inbox?.length ?? 0) > 0 ? 1 : 0
    const nextSettling: 0 | 1 = mirror.settledInflight > 0 ? 1 : 0
    this.busyActiveTotal += nextActive - mirror.busyActive
    this.busyCompactionsTotal += nextCompactions - mirror.busyCompactions
    this.busyQueuedTotal += nextQueued - mirror.busyQueued
    this.busySettlingTotal += nextSettling - mirror.busySettling
    mirror.busyActive = nextActive
    mirror.busyCompactions = nextCompactions
    mirror.busyQueued = nextQueued
    mirror.busySettling = nextSettling
  }

  activitySnapshot(): HubActivityCounts {
    return {
      activeConversations: this.busyActiveTotal,
      activeCompactions: this.busyCompactionsTotal,
      queuedConversations: this.busyQueuedTotal,
      settlingConversations: this.busySettlingTotal,
    }
  }

  /**
   * Register a synchronous idle→busy transition listener (the activity heartbeat rewrites its
   * file immediately so no reader can act on a stale idle record). Returns an unsubscribe
   * function. Listeners run inside the tracker's synchronous mutation paths — they must not
   * throw (failures are contained and reported as diagnostics).
   */
  onActivityBusyEntered(listener: () => void): () => void {
    this.activityBusyListeners.add(listener)
    return () => {
      this.activityBusyListeners.delete(listener)
    }
  }

  /**
   * Recompute the aggregate busy predicate after a mirror mutation and notify listeners on an
   * idle→busy flip. Called only from synchronous mutation chokepoints (snapshot adoption,
   * settle begin/end, explicit abort settlement); busy→idle flips need no immediate write — a
   * slightly stale busy record only delays an update by the reader's freshness bound (the safe
   * direction), which the heartbeat's periodic refresh closes anyway.
   */
  private noteActivityMutation(): void {
    const busy = isHubActivityBusy(this.activitySnapshot())
    if (busy === this.activityBusyAggregate) return
    this.activityBusyAggregate = busy
    if (!busy) return
    for (const listener of this.activityBusyListeners) {
      try {
        listener()
      } catch (error) {
        this.reportDiagnostic({
          level: 'warn',
          source: 'tracker.activity',
          message: 'activity busy-transition listener failed (heartbeat may lag until its next periodic write)',
          error,
        })
      }
    }
  }

  /** Live views for SSE snapshot: only conversations with an active run, streaming generation, or non-empty queue.
   *
   * Derived synchronously from live/inbox mirrors (independent of throttled push cache) so reconnect initial frames
   * restore queued pills and streaming text without resurrecting idle conversations that have nothing to show. */
  listLiveViews(): ConversationLive[] {
    const out: ConversationLive[] = []
    for (const [id, mirror] of this.mirrors) {
      const live = mirror.live
      const inboxItems = mirror.inbox
      const hasRun = live?.run !== undefined
      const hasStream =
        live?.generation !== undefined || (live?.tools?.length ?? 0) > 0 || (live?.nestedTools?.length ?? 0) > 0
      if (!hasRun && !hasStream && (inboxItems?.length ?? 0) === 0) continue
      const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
      // On idle conversations, keep only when queued inputs exist (queue-only); never emit empty idle live views.
      if (!hasRun && !hasStream && (snapshot.queuedInputs?.length ?? 0) === 0) continue
      out.push(snapshot)
    }
    return out
  }

  /** Abort settlement (called by runtime.abortConversation; guards against double reporting with the observe path). */
  settleAborted(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    const taskId = mirror?.runTaskId
    if (taskId !== undefined && mirror?.lastSettledRun === taskId) {
      // Observe path already settled this run (aborted/failed/completed): do not duplicate.
      this.resetRunState(conversationId)
      return
    }
    if (taskId !== undefined) {
      this.noteSettledRun(conversationId, `${conversationId}:${taskId}`)
    }
    const all = this.takeCurrentRunInputs(conversationId)
    this.resetRunState(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
    // Explicit abort settles outside the snapshot path: recompute the busy aggregate here too
    // (busy→idle needs no sync write, but a replacement run in the same tick must not be missed).
    this.noteActivityMutation()
  }

  /** Clear leftover queued tracking records after an explicit abort while idle (conversation.abort() already withdrew
   * pi.inbox without triggering settleAborted; clears only when no live.run exists, never interfering with new concurrent runs). */
  clearQueuedTracking(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.live?.run !== undefined) return
    for (const [submissionId, requestId] of [...mirror.submissionIndex]) {
      mirror.submissionIndex.delete(submissionId)
      mirror.trackedInputs.delete(requestId)
    }
  }

  /** Collect all inputs of the current run (for abort settlement): admitted inputs (run.inputs via index) + consumed set +
   * registered submissions without a submissionId yet, deduplicated by input.id; never iterates historical runs'
   * tracking records (settled inputs never re-appear, keeping origins accurate and avoiding pollution). */
  private takeCurrentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const out: ConversationInput[] = []
    if (mirror === undefined) return out
    const run = mirror.live?.run
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    if (run !== undefined) {
      for (const submissionId of run.inputs) {
        const requestId = mirror.submissionIndex.get(submissionId)
        if (requestId !== undefined) collect(mirror.trackedInputs.get(requestId))
      }
    }
    for (const requestId of mirror.consumedInputs ?? []) {
      collect(mirror.trackedInputs.get(requestId))
    }
    const bound = new Set(mirror.submissionIndex.values())
    for (const [requestId, input] of mirror.trackedInputs) {
      if (!bound.has(requestId)) collect(input)
    }
    mirror.trackedInputs = new Map()
    mirror.submissionIndex = new Map()
    return out
  }

  private resetRunState(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.consumedInputs = undefined
    // runTaskId keep: explicit abort path must it compare lastSettledRun guard against heavy;
    // new run at startup (live.run.taskId change) self however override.
  }

  /** Register a settled runKey while enforcing the per-conversation retention cap (evicts oldest to bound growth).
   *
   * runIds (taskIds) increase monotonically across the store: evicted keys can never recur, and settledRuns.delete(runKey)
   * on new runs only ever touches recent keys within the window, preserving exact semantics. */
  private noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.mirrorOf(conversationId).settledRunOrder
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
  }

  /** Remove a specific runKey from the retention order list (used when clearing settledRuns on new run start). */
  private dropSettledRunFromOrder(conversationId: number, runKey: string): void {
    const order = this.mirrors.get(conversationId)?.settledRunOrder
    if (order === undefined) return
    const index = order.indexOf(runKey)
    if (index >= 0) order.splice(index, 1)
  }

  private adopt(id: number, view: ConversationView): void {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = mirror.live
    mirror.live = live ?? {}

    this.noteCompactionFailure(id, live)
    this.usage.noteBoundary(id, view, prev, live)

    const lastEntryAdvanced = this.adoptSnapshotEntries(id, mirror, view, prev, live)
    const prevRun = prev?.run
    const runContinued = prevRun !== undefined && isContinuedRun(prevRun, live?.run)
    const settledInAdopt = this.settleEndedRunInAdopt(id, mirror, view, prevRun, live, runContinued)

    if (live?.run) {
      this.advanceLiveRunInAdopt(id, mirror, live.run, runContinued)
    }

    this.emitLiveThrottled(id, live)
    this.emitRunSummary(id)
    if (!settledInAdopt && !live?.run && lastEntryAdvanced && this.store.getConv(id) !== undefined) {
      const summary = this.summaryOf(id)
      this.mirrorOf(id).lastSummaryKey = summaryKeyOf(summary)
      this.events.onSummaryChanged(summary)
    }
    this.syncMirrorBusyContribution(mirror)
    this.noteActivityMutation()
  }

  private adoptSnapshotEntries(
    id: number,
    mirror: ConversationMirror,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): boolean {
    const latestAssistant = findLatestAssistantEntry(view.entries)
    if (latestAssistant !== undefined && mirror.lastIndexedAssistantEntryId !== latestAssistant.entryId) {
      if (Number.isFinite(latestAssistant.entryId)) mirror.lastIndexedAssistantEntryId = latestAssistant.entryId
      this.events.onAssistantText(id, latestAssistant.entryId, latestAssistant.text)
    }

    this.adoptInputsFromEntries(id, view.entries, mirror.runFirstEntry)
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)

    this.emitNewEntries(id, view.entries)

    const compaction = detectCompactionTransitions(view.entries, prev, live, mirror.lastSeenEntryId)
    mirror.lastSeenEntryId = compaction.nextSeenEntryId
    if (compaction.finishedCompactionsToReconcile.length > 0) {
      void this.reconcileFinishedCompaction(id, mirror.observeGeneration, compaction.finishedCompactionsToReconcile)
    }

    const prevLastEntryId = this.lastEntryIds.get(id) ?? this.store.getConv(id)?.lastEntryId ?? 0
    const windowLatestVisible = latestVisibleEntryIdOf(view.entries)
    const nextLastEntryId = Math.max(prevLastEntryId, windowLatestVisible)
    const lastEntryAdvanced = nextLastEntryId > prevLastEntryId
    if (lastEntryAdvanced) {
      this.lastEntryIds.set(id, nextLastEntryId)
      this.store.setLastEntryId?.(id, nextLastEntryId)
    }
    return lastEntryAdvanced
  }

  private settleEndedRunInAdopt(
    id: number,
    mirror: ConversationMirror,
    view: ConversationView,
    prevRun: LiveStateShape['run'] | undefined,
    live: LiveStateShape | undefined,
    runContinued: boolean,
  ): boolean {
    if (prevRun === undefined || (live?.run && live.run.taskId === prevRun.taskId) || runContinued) {
      return false
    }
    const runKey = `${id}:${prevRun.taskId}`
    if (!this.settledRuns.has(runKey)) {
      this.noteSettledRun(id, runKey)
      mirror.lastSettledRun = prevRun.taskId
      const failure = live?.runFailure
      if (failure && failure.taskId === prevRun.taskId) {
        for (const submissionId of failure.inputs) this.markConsumed(id, submissionId)
        const consumed = this.takeConsumed(id)
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
        const consumed = this.takeConsumed(id)
        this.emitSettled(id, 'completed', consumed, undefined)
      }
    }
    this.resetRunState(id)
    const tail = view.entries.length
      ? Number(view.entries[view.entries.length - 1]?.id)
      : undefined
    if (tail !== undefined && Number.isFinite(tail)) {
      if (mirror.runFirstEntry === undefined || tail > mirror.runFirstEntry) mirror.runFirstEntry = tail
    }
    return true
  }

  private advanceLiveRunInAdopt(
    id: number,
    mirror: ConversationMirror,
    run: NonNullable<LiveStateShape['run']>,
    runContinued: boolean,
  ): void {
    if (!runContinued) {
      const meta = this.store.getConv(id)
      if (meta !== undefined && meta.runStartedAt === undefined) {
        this.store.upsertConv({ ...meta, runStartedAt: Date.now() })
      }
    }
    const runKey = `${id}:${run.taskId}`
    if (mirror.runTaskId !== run.taskId) {
      mirror.runTaskId = run.taskId
      if (!runContinued) {
        mirror.consumedInputs = new Set<string>()
      }
      this.settledRuns.delete(runKey)
      this.dropSettledRunFromOrder(id, runKey)
      const first = run.first !== undefined ? Number(run.first) : undefined
      if (first !== undefined) {
        if (mirror.runFirstEntry === undefined || first > mirror.runFirstEntry) mirror.runFirstEntry = first
      }
    }
    for (const submissionId of run.inputs) {
      this.markConsumed(id, submissionId)
    }
  }

  /** Newly persisted entries: advance watermark by ascending ID, emitting each exactly once. */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.events.onEntryCommitted
    if (sink === undefined) return
    const mirror = this.mirrors.get(id)
    let watermark = mirror?.lastEmittedEntry ?? 0
    let advanced = false
    for (const raw of entries) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= watermark) continue
      // Throw explicitly on conversion failures (non-JSON payload): SDK terminates observation with listener_error
      // rather than silently dropping or fabricating fallbacks (honesty invariant).
      sink(id, toConversationEntry(raw))
      watermark = numeric
      advanced = true
    }
    if (advanced && mirror !== undefined) mirror.lastEmittedEntry = watermark
  }

  /** Throttled live view emitter: retains only the latest snapshot per window and deduplicates identical content.
   *
   * Changes to queuedInputs (enqueue/dequeue) bypass the 75ms throttle and flush immediately so steer/followUp pills
   * appear at the timeline tail as soon as observed (subject only to observer commit timing). */
  private emitLiveThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.events.onLiveChanged === undefined) return
    const mirror = this.mirrors.get(id)
    const inboxItems = mirror?.inbox
    const queuedEmpty =
      !live?.run &&
      !live?.generation &&
      (live?.tools?.length ?? 0) === 0 &&
      (live?.nestedTools?.length ?? 0) === 0 &&
      (inboxItems?.length ?? 0) === 0
    if (queuedEmpty) {
      // Do not emit idle views (terminal flushes are handled by emitSettled); however, if inputs were previously
      // queued and the authoritative inbox is now empty, emit a cleanup frame so client pills do not linger.
      if ((mirror?.lastEmittedLive?.queuedInputs?.length ?? 0) === 0) {
        this.clearLiveTimer(id)
        if (mirror !== undefined) {
          mirror.pendingLive = undefined
          mirror.liveDirty = false
        }
        return
      }
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendLiveNow(id, cleanup)
      return
    }
    // Defer `deriveConversationLive` per-token allocations while `liveTimer` is already armed and the inbox queue
    // has not changed; `flushPendingLive` derives once from the latest mirror when the 75ms timer fires.
    if (mirror !== undefined && mirror.liveTimer !== undefined) {
      const prevInbox = mirror.lastEmittedInbox
      const inboxUnchanged =
        prevInbox === inboxItems ||
        ((prevInbox?.length ?? 0) === 0 && (inboxItems?.length ?? 0) === 0)
      if (inboxUnchanged) {
        mirror.pendingLive = undefined
        mirror.liveDirty = true
        return
      }
    }
    const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
    const prevEmitted = mirror?.lastEmittedLive
    // Align previous-queue check: uninitialized counts as empty (so first empty queue never falsely bypasses throttle);
    // only actual queue changes bypass the 75ms throttle.
    const queuedChanged = !sameQueuedInputs(prevEmitted?.queuedInputs, snapshot.queuedInputs)
    if (!queuedChanged && prevEmitted !== undefined && sameConversationLiveContent(prevEmitted, snapshot)) return
    if (queuedChanged) {
      // Immediate priority for queue enqueue/dequeue: cancel timer and flush synchronously without waiting 75ms.
      this.clearLiveTimer(id)
      this.sendLiveNow(id, snapshot)
      return
    }
    const m = this.mirrorOf(id)
    m.pendingLive = snapshot
    m.liveDirty = false
    if (m.liveTimer !== undefined) return
    const timer = setTimeout(() => {
      m.liveTimer = undefined
      this.flushPendingLive(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    m.liveTimer = timer
  }

  /** Synchronously send one live frame (shared by terminal flushes / queue cleanup) and record the emitted snapshot. */
  private sendLiveNow(id: number, snapshot: ConversationLive): void {
    this.clearLiveTimer(id)
    const mirror = this.mirrorOf(id)
    mirror.pendingLive = undefined
    mirror.liveDirty = false
    mirror.lastEmittedLive = snapshot
    mirror.lastEmittedInbox = mirror.inbox
    this.events.onLiveChanged?.(snapshot)
  }

  /** Flush pending snapshot inside throttle window (runs on timer expiry or immediate queue change). */
  private flushPendingLive(id: number): void {
    const mirror = this.mirrors.get(id)
    if (mirror === undefined) return
    const snapshot =
      mirror.pendingLive ??
      (mirror.liveDirty
        ? deriveConversationLive(id, mirror.live, Date.now(), mirror.inbox)
        : undefined)
    mirror.pendingLive = undefined
    mirror.liveDirty = false
    if (snapshot === undefined) return
    if (mirror.lastEmittedLive !== undefined && sameConversationLiveContent(mirror.lastEmittedLive, snapshot)) return
    mirror.lastEmittedLive = snapshot
    mirror.lastEmittedInbox = mirror.inbox
    this.events.onLiveChanged?.(snapshot)
  }

  /** Force terminal flush: emits a synchronous frame from current live mirror (canceling timer and dropping stale pending). */
  private flushLiveFinal(conversationId: number): void {
    this.clearLiveTimer(conversationId)
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) {
      mirror.pendingLive = undefined
      mirror.liveDirty = false
    }
    if (this.events.onLiveChanged === undefined) return
    const snapshot = deriveConversationLive(
      conversationId,
      mirror?.live,
      Date.now(),
      mirror?.inbox,
    )
    const prevEmitted = mirror?.lastEmittedLive
    if (
      prevEmitted !== undefined &&
      sameConversationLiveContent(prevEmitted, snapshot) &&
      sameQueuedInputs(prevEmitted.queuedInputs, snapshot.queuedInputs)
    ) {
      return
    }
    const m = this.mirrorOf(conversationId)
    m.lastEmittedLive = snapshot
    m.lastEmittedInbox = m.inbox
    this.events.onLiveChanged(snapshot)
  }

  /** Register inputs from helmx.input entry data (idempotent merge into unique record keyed by input.id = requestId).
   *
   * On happy paths register/bind already holds the authoritative record, so entry observation only fills missing metadata
   * fields (origin/meta/attachments) without creating duplicates. */
  private adoptInputsFromEntries(id: number, entries: ReadonlyArray<EntryRecord>, minEntryId?: number): void {
    for (const meta of extractHelmxInputMetas(entries, minEntryId)) {
      this.upsertTrackedInput(id, meta.id, meta)
    }
  }

  /** Register or merge metadata for a single helmx.input (idempotent by input.id; caller checked meta.id/text are strings). */
  private upsertTrackedInput(id: number, requestId: string, meta: HelmxInputMeta): void {
    const map = this.mirrorOf(id).trackedInputs
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    map.set(requestId, existing === undefined ? rebuilt : mergeInputMeta(existing, rebuilt))
  }

  /** Mark submissionId as consumed by the active run: maps back to requestId via correlation index and registers once
   * (emitting onInputCommitted once). Silently skips if index is missing (bind/backfill pending) to catch on next scan. */
  private markConsumed(conversationId: number, submissionId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const requestId = mirror.submissionIndex.get(submissionId)
    const input = requestId === undefined ? undefined : mirror.trackedInputs.get(requestId)
    if (!input) return
    const consumedSet = mirror.consumedInputs ?? new Set<string>()
    if (consumedSet.has(input.id)) return
    consumedSet.add(input.id)
    mirror.consumedInputs = consumedSet
    this.events.onInputCommitted(conversationId, input)
  }

  /** Collect inputs consumed by this run on settlement and purge them: once per requestId, clearing both tracking and index
   * entries so history never resurrects. */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const consumedSet = mirror?.consumedInputs
    const out: ConversationInput[] = []
    if (mirror !== undefined && consumedSet !== undefined) {
      for (const requestId of consumedSet) {
        const input = mirror.trackedInputs.get(requestId)
        if (input !== undefined) out.push(input)
      }
      // Purge tracking and correlation index entries for settled inputs together.
      for (const [submissionId, requestId] of mirror.submissionIndex) {
        if (consumedSet.has(requestId)) mirror.submissionIndex.delete(submissionId)
      }
      for (const requestId of consumedSet) mirror.trackedInputs.delete(requestId)
    }
    if (mirror !== undefined) mirror.consumedInputs = undefined
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const generation = this.mirrors.get(conversationId)?.observeGeneration
    this.beginSettled(conversationId)
    let completion: Promise<void> | void
    try {
      // Terminal flush of live view: precedes turn_settled (empty tools/text signals stream completion).
      this.flushLiveFinal(conversationId)
      // Advance durable watermark first, then construct settlement snapshot so plugins and read APIs observe identical state.
      // Increment completionSeq + set unread (cleared only by explicit human PATCH).
      // Background derived sub-conversations (non-human ownership with parent chain, e.g. managed subagents / Swarm
      // workers) never fabricate human unread flags on completion; human forks (parent chain + human ownership) and top-level
      // direct conversations preserve unread semantics. Failures/aborts never set unread (existing contract).
      const settledAt = Date.now()
      const meta = this.store.getConv(conversationId)
      if (meta) {
        const unread = outcome === 'completed' && !this.isBackgroundDerived(conversationId, meta)
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
        this.store.upsertConv(updated)
        const settledStatus = unread ? 'done' : statusNow(updated, outcome)
        // Failed terminal diagnostic summary shares single source with summaryOf: emitSettled bypasses tracker derivation,
        // so it must include lastError here (otherwise the first conversation.upsert drops the error reason);
        // likewise attach cached contextUsage synchronously (post-settlement async refresh updates later if changed).
        const settledRaw = summaryOf({
          meta: updated,
          status: settledStatus,
          pendingAskCount: 0,
          lastError: settledStatus === 'error' ? lastErrorOf(this.mirrors.get(conversationId)?.live, this.redactError) : undefined,
          lastEntryId: this.lastEntryIds.get(conversationId) ?? updated.lastEntryId ?? 0,
        })
        const cachedUsage = this.usage.peek(conversationId)
        const settledSummary = cachedUsage === undefined ? settledRaw : { ...settledRaw, contextUsage: cachedUsage }
        // Record terminal summary fingerprint so subsequent idle snapshots do not re-emit identical terminal frames.
        this.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(settledSummary)
        this.events.onSummaryChanged(settledSummary)
        // Context changed after turn settlement: schedule async usage refresh (emits upsert only on change; never bumps seq).
        this.usage.schedule(conversationId, { publishWhenReady: cachedUsage === undefined })
      }
      const payload: TurnSettledPayload = {
        conversation: this.summaryOf(conversationId, outcome),
        inputs,
        outcome,
        error,
        settledAt,
      }
      completion = this.events.onTurnSettled(payload, inputs)
    } catch (error) {
      this.endSettled(conversationId)
      throw error
    }
    if (completion === undefined) {
      this.endSettled(conversationId)
    } else {
      void completion.then(
        () => {
          if (this.mirrors.get(conversationId)?.observeGeneration === generation) this.endSettled(conversationId)
        },
        (error: unknown) => {
          const mirror = this.mirrors.get(conversationId)
          if (mirror === undefined || mirror.observeGeneration !== generation) return
          mirror.settledError = error
          this.endSettled(conversationId)
        },
      )
    }
  }

  /** Determine whether a conversation is background-derived: has a parent chain and non-human ownership (managed subagent / Worker, etc.).
   * If ownership callback is absent or fails (including deleted), default to human—better to over-emit than suppress human unreads. */
  private isBackgroundDerived(conversationId: number, meta: ConvMeta): boolean {
    if (meta.parentConversationId === undefined) return false
    if (this.ownershipOf === undefined) return false
    try {
      return this.ownershipOf(conversationId) !== 'human'
    } catch {
      return false
    }
  }

  /** Derive the five-state status from store meta + live mirror (blocked takes priority over working on derivation). */
  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.store.getConv(conversationId)
    if (!meta) throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404)
    const mirror = this.mirrors.get(conversationId)
    const live = mirror?.live
    const pendingAsks =
      typeof pendingAskOverride === 'number'
        ? pendingAskOverride
        : (mirror?.pendingAskCount ?? 0)
    let status: ConversationStatus
    if (pendingAskOverride === 'aborted') {
      status = 'idle'
    } else if (pendingAsks > 0) {
      // Pending approval overrides run status, surfacing the human decision point directly.
      status = 'blocked'
    } else if (live?.run) {
      status = 'working'
    } else if (live?.runFailure && live.runFailure.reason !== 'aborted') {
      status = 'error'
    } else {
      status = meta.unread ? 'done' : 'idle'
    }
    const doing = live?.run
      ? live.tools && live.tools.length > 0
        ? `${live.tools[live.tools.length - 1]?.name}: ${live.tools[live.tools.length - 1]?.status ?? 'running'}`
        : 'thinking...'
      : undefined
    // Error diagnostic summary travels only with error status (live.runFailure clears when a new run starts, vanishing automatically).
    const lastError = status === 'error' ? lastErrorOf(live, this.redactError) : undefined
    const lastEntryId = this.lastEntryIds.get(conversationId) ?? meta.lastEntryId ?? 0
    const pendingAskSince =
      pendingAsks > 0 ? this.store.earliestPendingAskCreatedAt?.(conversationId) : undefined
    const summary = summaryOf({ meta, status, pendingAskCount: pendingAsks, doing, lastError, lastEntryId, pendingAskSince })
    const usage = this.usage.cachedOrSchedule(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
  }

  /** Schedule an async context usage refresh (delegates to refresh chain module; public port for service/ops consumers). */
  scheduleContextUsageRefresh(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    this.usage.schedule(conversationId, options)
  }

  /** Invalidate context usage cache on models.changed.
   *
   * Catalog refreshes/rebuilds can resolve or change a model's context window (or remove providers): previously
   * observed/cached conversations must recompute rather than remaining stuck with stale windows on idle threads.
   * Schedules the existing refresh chain (in-flight invalidation, generation guard, fingerprint dedupe) without new
   * async machinery or LLM calls; usage-only updates never advance stateChangeSeq (existing discipline in applyContextUsage).
   *
   * - non-empty providers: refresh only conversations whose effective model belongs to those providers;
   * - empty providers: entire catalog may have rotated, so refresh all;
   * - only touches observed or already-cached conversations rather than scanning the entire history store on startup;
   *   unobserved conversations compute using the updated catalog upon first visit.
   */
  onModelsChanged(providers: readonly string[]): void {
    const wanted = providers.length > 0 ? new Set(providers) : undefined
    const targets = new Set([...this.usage.cachedConversationIds(), ...this.observedConversationIds()])
    for (const id of targets) {
      const meta = this.store.getConv(id)
      if (!meta || meta.model === '') continue
      const slash = meta.model.indexOf('/')
      const provider = slash > 0 ? meta.model.slice(0, slash) : meta.model
      if (wanted !== undefined && !wanted.has(provider)) continue
      this.usage.schedule(id)
    }
  }

  /** List currently observed conversation IDs (in-memory mirrors with active observeGeneration). */
  private observedConversationIds(): number[] {
    const out: number[] = []
    for (const [id, mirror] of this.mirrors) {
      if (mirror.observeGeneration !== undefined) out.push(id)
    }
    return out
  }

  /** Ensure a conversation's contextUsage cache is populated and its refresh chain settled (first detail read, etc.). */
  async ensureContextUsage(conversationId: number): Promise<void> {
    await this.usage.ensure(conversationId)
  }

  /** Never swallow compaction failures silently: emit one redacted error notification per new compactionFailure
   * (deduplicated by taskId so duplicate snapshots do not re-notify; SDK clears compactionFailure only on the next
   * successful compaction, and later failures get new taskIds so they report cleanly). */
  private noteCompactionFailure(id: number, live: LiveStateShape | undefined): void {
    const failure = live?.compactionFailure
    if (failure === undefined) return
    if (this.notifiedCompactionFailures.get(id) === failure.taskId) return
    this.notifiedCompactionFailures.set(id, failure.taskId)
    this.events.onNotification?.({
      level: 'error',
      title: 'Context compaction failed',
      body: compactionFailureNoticeOf(failure, this.redactError),
      conversationId: id,
    })
  }

  /**
   * Async reconciliation when compaction ends without a pi.compaction entry (runs outside synchronous adopt):
   * - inspect each finished task's authoritative terminal state; only treat as clean skip when status='terminal'
   *   and outcome.status='completed' with no written entry and no compactionFailure (selectCut === undefined or beforeCompact declined);
   * - ignore aborted / failed tasks (never misreport when compaction wasn't needed, and never flush queued inputs on uncompacted context);
   * - after confirming clean skip: emit info notification if triggered manually; if inbox still holds steer/followUp
   *   inputs while idle with no active compaction, auto-start the next turn via continue.
   */
  private async reconcileFinishedCompaction(
    id: number,
    generation: symbol | undefined,
    finished: ReadonlyArray<{ taskId: number; trigger: string; blocking: boolean }>,
  ): Promise<void> {
    try {
      if (this.isClosing || !this.store.getConv(id)) return
      const initialMirror = this.mirrors.get(id)
      if (initialMirror === undefined || initialMirror.observeGeneration !== generation) return

      let hasCleanEmpty = false
      let hasManualEmpty = false
      for (const task of finished) {
        const record = await getSdkTask(this.harness, task.taskId, BACKGROUND_CONTEXT)
        if (this.isClosing || !this.store.getConv(id)) return
        const currentMirror = this.mirrors.get(id)
        if (currentMirror === undefined || currentMirror.observeGeneration !== generation) return
        if (record === undefined) continue
        if (record.state.status !== 'terminal' || record.state.outcome.status !== 'completed') continue
        if (currentMirror.live?.compactionFailure?.taskId === task.taskId) continue
        const result = record.state.outcome.result as { entryId?: unknown; submissionId?: unknown } | undefined
        if (result?.entryId !== undefined || result?.submissionId !== undefined) continue
        hasCleanEmpty = true
        if (task.trigger === 'manual') hasManualEmpty = true
      }
      if (!hasCleanEmpty) return

      const mirror = this.mirrors.get(id)
      if (mirror === undefined || mirror.observeGeneration !== generation) return

      if (hasManualEmpty) {
        this.events.onNotification?.({
          level: 'info',
          title: 'Current context does not need compaction',
          body: 'History messages are within the retention window; no new summary was generated.',
          conversationId: id,
        })
      }

      const hasQueuedInputs = (mirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!hasQueuedInputs || mirror.live?.run !== undefined || (mirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      const conv = await getSdkConversation(this.harness, id, BACKGROUND_CONTEXT)
      if (this.isClosing || !this.store.getConv(id)) return
      const latestMirror = this.mirrors.get(id)
      if (latestMirror === undefined || latestMirror.observeGeneration !== generation) return
      const stillQueued = (latestMirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!stillQueued || latestMirror.live?.run !== undefined || (latestMirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      try {
        await conv?.submit({ type: 'continue' }, BACKGROUND_CONTEXT)
      } catch (error) {
        const name = (error as { name?: string })?.name
        const code = (error as { code?: string })?.code
        if (name === 'ConversationBusy' || code === 'not_found') return
        throw error
      }
    } catch (error) {
      if (this.isClosing) return
      this.reportDiagnostic({
        level: 'error',
        source: 'tracker.compaction',
        message: 'compaction end reconciliation failed',
        error,
        conversationId: id,
      })
    }
  }

  setPendingAskCount(conversationId: number, count: number): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.pendingAskCount
    const meta = this.store.getConv(conversationId)
    if (prev === count) {
      // Even when the pending ask count stays unchanged (e.g. concurrent settle + create within the same flush window),
      // earliest pendingAskSince may have advanced; re-check semantic summaryKeyOf before skipping.
      if (count === 0 || !meta || mirror.lastSummaryKey === summaryKeyOf(this.summaryOf(conversationId, count))) {
        return
      }
    }
    mirror.pendingAskCount = count
    // Advance durable seq: pendingAsk change is a state change (relied upon by CAS watermarks).
    if (meta) {
      const updated: ConvMeta = {
        ...meta,
        stateChangeSeq: meta.stateChangeSeq + 1,
        updatedAt: Date.now(),
      }
      this.store.upsertConv(updated)
    }
    const summary = this.summaryOf(conversationId, count)
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.events.onSummaryChanged(summary)
  }

  /** Emit live summary during an active run: fires once on run start and on semantic `doing` transitions.
   *
   * - only emits when an active run exists in this snapshot (yielding only working/blocked);
   *   emitSettled owns terminal state exclusively so adopt never double-settles or resurrects settled turns;
   * - deduplicates on (status, doing, pendingAskCount) semantic fingerprint so pure streaming token updates
   *   (which leave `doing` unchanged) never emit redundant per-token summary updates;
   * - stateChangeSeq advances monotonically with real state transitions (per protocol contract, same mechanism as
   *   setPendingAskCount); live throttle window (75ms) is unaffected.
   */
  private emitRunSummary(id: number): void {
    const mirror = this.mirrors.get(id)
    if (!mirror?.live?.run) return
    const meta = this.store.getConv(id)
    if (!meta) return
    const candidate = this.summaryOf(id)
    if (mirror.lastSummaryKey === summaryKeyOf(candidate)) return
    // While blocked on a pending AskDoc, sibling tool `doing` transitions still emit refreshed summaries,
    // without advancing `stateChangeSeq` past the pending AskDoc's CAS ceiling.
    if (candidate.status !== 'blocked') {
      this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
    const summary = candidate.status !== 'blocked' ? this.summaryOf(id) : candidate
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.events.onSummaryChanged(summary)
  }

  /** Record latest observed assistant text (data source for getLastAssistantText). */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.lastAssistant
    if (prev !== undefined && prev.entryId === entryId) return
    mirror.lastAssistant = { entryId, text }
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.mirrors.get(conversationId)?.lastAssistant?.text
  }

  /** Invalidate lastAssistant cache entries inside a rewound interval (after in-place overwrite & resend).
   *
   * Clears only if the cached entry falls within [from, through] so a failed resend does not expose the overwritten
   * answer via getLastAssistantText while earlier turns outside the interval stay valid. */
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const cached = mirror.lastAssistant
    if (cached !== undefined && cached.entryId >= from && cached.entryId <= through) {
      mirror.lastAssistant = undefined
    }
    const indexedId = mirror.lastIndexedAssistantEntryId
    if (indexedId !== undefined && indexedId >= from && indexedId <= through) {
      mirror.lastIndexedAssistantEntryId = undefined
    }
  }
}
