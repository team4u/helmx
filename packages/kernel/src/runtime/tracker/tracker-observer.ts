/**
 * TrackerObserver: observer lifecycle and snapshot adoption for the ConversationTracker.
 *
 * Sole writer of mirror.detach / live / inbox / observeGeneration / lastEmittedEntry / lastSeenEntryId, and of the
 * core.lastEntryIds watermark. Adoption is the synchronous `Observer.advance` path: it never awaits, only records
 * mirrors and queues side effects (SSE pushes happen in microtasks / throttled timers owned by TrackerLive).
 *
 * Adopt ordering (every step is a synchronous chokepoint; order matters):
 *   write mirror.live → compaction failure notice → contextUsage boundary → entries (assistant text → inputs from
 *   entries/inbox → conversation.entry ascending, exactly once → compaction transitions → lastEntryId watermark)
 *   → settle the ended previous run → advance the new run → throttled live frame → doing summary → idle summary
 *   fallback (only when nothing settled and no run is active) → busy contribution → activity notification.
 *
 * Initial attachment (adoptInitial) emits nothing: it aligns watermarks, registers inbox/run inputs from authoritative
 * SDK mappings, and guards every await with the observe generation so a stopObserving/re-observe across the await
 * discards stale results instead of re-populating a cleaned mirror.
 *
 * stopObserving order (invariant): detach → clear live timer → drop contextUsage cache → wake turn_settled waiters →
 * zero busy contribution → delete mirror + lastEntryIds → sweep settled runs → activity notification.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import { toConversationEntry, type EntryRecordLike } from '../entries.js'
import { rewindIntervalOf, coveredByRewind, type RewindInterval } from '../conversation-rewind.js'
import {
  collectWindowWatermarks,
  detectCompactionTransitions,
  findLatestAssistantEntry,
  latestVisibleEntryIdOf,
  loadRunInputEntriesFromSdk,
} from '../conversation-tracker-helpers.js'
import { getSdkConversation, observeSdkConversation, scanSdkEntries } from '../sdk-ids.js'
import type { ConversationMirror, InboxItemShape, LiveStateShape } from '../conversation-mirror.js'
import type { TrackerActivity } from './tracker-activity.js'
import type { TrackerCompaction } from './tracker-compaction.js'
import type { TrackerCore } from './tracker-core.js'
import type { TrackerInputs } from './tracker-inputs.js'
import type { TrackerLive } from './tracker-live.js'
import type { TrackerSettlement } from './tracker-settlement.js'
import type { TrackerSummary } from './tracker-summary.js'

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

/** Tracker collaborators the observer drives while adopting snapshots and tearing down observations (all owned by the tracker facade). */
export interface TrackerObserverDeps {
  readonly core: TrackerCore
  readonly inputs: TrackerInputs
  readonly live: TrackerLive
  readonly activity: TrackerActivity
  readonly summary: TrackerSummary
  readonly compaction: TrackerCompaction
  readonly settlement: TrackerSettlement
}

export class TrackerObserver {
  private readonly core: TrackerCore
  private readonly inputs: TrackerInputs
  private readonly live: TrackerLive
  private readonly activity: TrackerActivity
  private readonly summary: TrackerSummary
  private readonly compaction: TrackerCompaction
  private readonly settlement: TrackerSettlement

  constructor(deps: TrackerObserverDeps) {
    this.core = deps.core
    this.inputs = deps.inputs
    this.live = deps.live
    this.activity = deps.activity
    this.summary = deps.summary
    this.compaction = deps.compaction
    this.settlement = deps.settlement
  }

  /** Attach a synchronous observer to the conversation; backfills authoritative input metadata for active runs before returning. */
  async observe(id: number): Promise<void> {
    if (this.core.mirrors.get(id)?.detach !== undefined) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        const mirror = this.core.mirrors.get(id)
        if (mirror !== undefined) mirror.detach = undefined
        this.live.clearTimer(id)
      },
    }
    const observation: Observation<ConversationView> = await observeSdkConversation(
      this.core.harness,
      id,
      observer,
      BACKGROUND_CONTEXT,
    )
    const mirror = this.core.mirrorOf(id)
    mirror.detach = () => observation.detach()
    // Initial snapshot: do not replay existing items in the window (first attach only aligns watermarks).
    // Generation guard: if stopObserving runs (or re-observe swaps generation) across await, skip writing back to mirror.
    const generation = Symbol('conversation observation')
    mirror.observeGeneration = generation
    await this.adoptInitial(id, observation.value, generation)
  }

  /** Close tracker: stop observing all conversations and block late in-flight async settlement side effects. */
  close(): void {
    this.core.markClosed()
    for (const id of [...this.core.mirrors.keys()]) {
      this.stopObserving(id)
    }
  }

  stopObserving(id: number): void {
    const mirror = this.core.mirrors.get(id)
    mirror?.detach?.()
    // Cancel pending timer and discard queued snapshots: never emit ghost events after deletion/unobserve.
    this.live.clearTimer(id)
    // Clean up contextUsage mirror together: late async refreshes after unobserve/deletion drop via generation guard;
    // unblock refresh waiters immediately so they inspect missing mirror/cache and exit without hanging.
    this.summary.clearUsage(id)
    // Resolve turn_settled waiters first (preventing hangs), then drop the mirror wholesale so repeated
    // create/delete cycles never leak entries.
    this.settlement.releaseWaiters(mirror)
    if (mirror !== undefined) this.activity.removeMirror(mirror)
    this.core.deleteMirror(id)
    this.settlement.forgetConversation(id)
    this.activity.noteMutation()
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
    const mirror = this.core.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    mirror.live = live ?? {}
    // Honest startup/re-attach cleanup: if no live run is active but a stale `runStartedAt`
    // remained persisted (e.g. crash without resuming), clear it without adding downtime to `runDurationMs`.
    if (!live?.run) {
      const meta = this.core.store.getConv(id)
      if (meta !== undefined && meta.runStartedAt !== undefined) {
        this.core.store.upsertConv({ ...meta, runStartedAt: undefined })
      }
    }
    // Report lingering compaction failures even right after restart/re-attach (once per runtime lifecycle).
    this.compaction.noteFailure(id, live)
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
      this.summary.seedAssistantEntry(id, latestAssistant)
    }
    if (watermarks.usageWatermark >= 0) this.summary.advanceUsageWatermark(id, watermarks.usageWatermark)
    let initialLastEntryId = latestVisibleEntryIdOf(view.entries)
    const mergedInitialLastEntryId = Math.max(this.core.lastEntryIds.get(id) ?? 0, initialLastEntryId)
    this.core.lastEntryIds.set(id, mergedInitialLastEntryId)
    this.core.store.setLastEntryId?.(id, mergedInitialLastEntryId)
    // Register inbox mirror before checking live.run: even after a restart/stopped run with queued inputs remaining,
    // queuedInputs derivation and listLiveViews snapshots preserve queued state honestly without fabricating UI queues.
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.inputs.adoptFromInbox(id, inboxItems)
    this.activity.syncMirror(mirror)
    this.activity.noteMutation()
    // Populate context usage cache on initial attach (initial read path for restart/fork/new conversations),
    // including idle conversations so opening a historical conversation displays its usage pill.
    this.summary.scheduleUsage(id)
    if (initialLastEntryId === 0 && view.before !== undefined) {
      initialLastEntryId = await this.scanLatestVisibleEntryId(id)
      if (this.core.mirrors.get(id)?.observeGeneration !== generation) return
      const merged = Math.max(this.core.lastEntryIds.get(id) ?? 0, initialLastEntryId)
      this.core.lastEntryIds.set(id, merged)
      this.core.store.setLastEntryId?.(id, merged)
    }
    if (!live?.run) return
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    this.settlement.seedRecoveredRun(id, live.run.taskId, first)
    // Admitted inputs for this run: back-read entry via authoritative SDK submissionId -> entry mapping,
    // registering requestId tracking records and submissionId -> requestId indexes so markConsumed hits.
    const loaded = await loadRunInputEntriesFromSdk(this.core.harness, id, live.run.inputs)
    // If stopObserving swapped generation, discard async read results rather than re-populating a cleaned mirror.
    if (this.core.mirrors.get(id)?.observeGeneration !== generation) return
    this.inputs.adoptFromEntries(id, loaded.entries)
    this.inputs.indexRestoredSubmissions(id, loaded.pairs)
    // Queued (not yet admitted) inputs: read directly from inbox entries (mirror registered above; just backfill input metadata).
    this.inputs.adoptFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.inputs.markConsumed(id, submissionId)
    // Active recovered runs already appear in snapshot summaries (listConversations): seed the semantic dedupe key
    // so subsequent adopts only emit on actual status/doing transitions instead of pushing redundant working frames.
    this.summary.primeRunSummaryKey(id)
    // Recovered active runs/queues make the runtime busy from the very first mirror write.
    this.activity.syncMirror(mirror)
    this.activity.noteMutation()
  }

  /** Scan backwards from tail when the initial 50-entry view window contained only hidden entries. */
  private async scanLatestVisibleEntryId(id: number): Promise<number> {
    const conversation = await getSdkConversation(this.core.harness, id, BACKGROUND_CONTEXT)
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

  /** Synchronous snapshot adoption (Observer.advance). */
  private adopt(id: number, view: ConversationView): void {
    const mirror = this.core.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = mirror.live
    mirror.live = live ?? {}

    this.compaction.noteFailure(id, live)
    this.summary.noteUsageBoundary(id, view, prev, live)

    const lastEntryAdvanced = this.adoptSnapshotEntries(id, mirror, view, prev, live)
    const prevRun = prev?.run
    const runContinued = prevRun !== undefined && isContinuedRun(prevRun, live?.run)
    const settledInAdopt = this.settlement.settleEndedRun(id, { mirror, view, prevRun, live, runContinued })

    if (live?.run) {
      this.settlement.advanceLiveRun(id, mirror, live.run, runContinued)
    }

    this.live.emitThrottled(id, live)
    this.summary.emitRunSummary(id)
    if (!settledInAdopt && !live?.run && lastEntryAdvanced && this.core.store.getConv(id) !== undefined) {
      const summary = this.summary.summaryOf(id)
      this.summary.publishSummary(id, summary)
    }
    this.activity.syncMirror(mirror)
    this.activity.noteMutation()
  }

  private adoptSnapshotEntries(
    id: number,
    mirror: ConversationMirror,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): boolean {
    const latestAssistant = findLatestAssistantEntry(view.entries)
    if (latestAssistant !== undefined) {
      this.summary.forwardAssistantEntry(id, latestAssistant)
    }

    this.inputs.adoptFromEntries(id, view.entries, mirror.runFirstEntry)
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.inputs.adoptFromInbox(id, inboxItems)

    this.emitNewEntries(id, view.entries)

    const compaction = detectCompactionTransitions(view.entries, prev, live, mirror.lastSeenEntryId)
    mirror.lastSeenEntryId = compaction.nextSeenEntryId
    if (compaction.finishedCompactionsToReconcile.length > 0) {
      void this.compaction.reconcileFinished(id, mirror.observeGeneration, compaction.finishedCompactionsToReconcile)
    }

    const prevLastEntryId = this.core.lastEntryIds.get(id) ?? this.core.store.getConv(id)?.lastEntryId ?? 0
    const windowLatestVisible = latestVisibleEntryIdOf(view.entries)
    const nextLastEntryId = Math.max(prevLastEntryId, windowLatestVisible)
    const lastEntryAdvanced = nextLastEntryId > prevLastEntryId
    if (lastEntryAdvanced) {
      this.core.lastEntryIds.set(id, nextLastEntryId)
      this.core.store.setLastEntryId?.(id, nextLastEntryId)
    }
    return lastEntryAdvanced
  }

  /** Newly persisted entries: advance watermark by ascending ID, emitting each exactly once. */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.core.events.onEntryCommitted
    if (sink === undefined) return
    const mirror = this.core.mirrors.get(id)
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
}
