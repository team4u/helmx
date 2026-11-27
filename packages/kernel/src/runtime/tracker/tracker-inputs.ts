/**
 * TrackerInputs: input identity and correlation bookkeeping for the ConversationTracker.
 *
 * Sole writer of mirror.trackedInputs (requestId = input.id -> ConversationInput), mirror.submissionIndex
 * (SDK submissionId -> requestId) and mirror.consumedInputs (requestIds consumed by the active run).
 *
 * Identity rules (unchanged from the monolithic tracker):
 * - Inputs use durable input.id (SDK requestId) as the unique tracking identity; registerInput registers before
 *   submit, bindSubmission backfills the submissionId -> requestId correlation once submit returns;
 * - Observe paths (helmx.input entries / pi.inbox reconstruction / restart recovery) idempotently merge into the
 *   single record by requestId (richer in-memory metadata wins);
 * - markConsumed emits onInputCommitted exactly once per requestId; takeConsumed purges tracking and index
 *   entries together on settlement so history never resurrects.
 */

import type { ConversationInput } from '@helmx/protocol'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { extractHelmxInputMetas } from '../conversation-tracker-helpers.js'
import {
  type HelmxInputMeta,
  type InboxItemShape,
  inputFromMeta,
  mergeInputMeta,
} from '../conversation-mirror.js'
import type { TrackerCore } from './tracker-core.js'

export class TrackerInputs {
  constructor(private readonly core: TrackerCore) {}

  /** Register input metadata before submission (using durable input.id = requestId as tracking key;
   * bindSubmission registers the submissionId correlation index once submit returns). */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.core.mirrorOf(conversationId).trackedInputs
    // The same requestId may already have a record from entry/inbox observation (e.g., rewind tx commits
    // before registration finishes): fill only missing fields (richer in-memory metadata wins) without duplicating.
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
  }

  /** Register submissionId -> requestId correlation after submit returns (SDK run.inputs etc. identify inputs
   * by submissionId; maps back to tracking identity, and dropInput removes on HelmxError). */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.core.mirrorOf(conversationId).submissionIndex.set(submissionId, requestId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.core.mirrors.get(conversationId)?.trackedInputs.delete(requestId)
  }

  /** Clean up correlation entry and requestId tracking record when a queued submission is withdrawn. */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined) return
    const resolved = requestId ?? mirror.submissionIndex.get(submissionId)
    mirror.submissionIndex.delete(submissionId)
    if (resolved !== undefined) mirror.trackedInputs.delete(resolved)
  }

  /** Snapshot of inputs belonging to the current active run (used by before_turn payload): exact run.inputs
   * sequence (including steered additions) plus any registered submissions still in flight without a submissionId yet,
   * deduplicated by input.id. */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.core.mirrors.get(conversationId)
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

  /** Clear leftover queued tracking records after an explicit abort while idle (conversation.abort() already withdrew
   * pi.inbox without triggering settleAborted; clears only when no live.run exists, never interfering with new concurrent runs). */
  clearQueuedTracking(conversationId: number): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined || mirror.live?.run !== undefined) return
    for (const [submissionId, requestId] of [...mirror.submissionIndex]) {
      mirror.submissionIndex.delete(submissionId)
      mirror.trackedInputs.delete(requestId)
    }
  }

  /** Collect all inputs of the current run (for abort settlement): admitted inputs (run.inputs via index) + consumed set +
   * registered submissions without a submissionId yet, deduplicated by input.id; never iterates historical runs'
   * tracking records (settled inputs never re-appear, keeping origins accurate and avoiding pollution). */
  takeCurrentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.core.mirrors.get(conversationId)
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

  /** Register restored authoritative (submissionId, requestId) pairs in the correlation index. */
  indexRestoredSubmissions(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const index = this.core.mirrorOf(id).submissionIndex
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
  }

  /** Rebuild queued inbox items (backfills origin/meta/attachments and registers indexes for un-admitted inputs). */
  adoptFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmxInputMeta | undefined
      if (item.entry?.kind !== 'helmx.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // Inbox item id is SDK submissionId: register correlation index so markConsumed matches once dequeued.
      this.core.mirrorOf(id).submissionIndex.set(item.id, data.id)
      this.upsertFromMeta(id, data.id, data)
    }
  }

  /** Register inputs from helmx.input entry data (idempotent merge into unique record keyed by input.id = requestId).
   *
   * On happy paths register/bind already holds the authoritative record, so entry observation only fills missing metadata
   * fields (origin/meta/attachments) without creating duplicates. */
  adoptFromEntries(id: number, entries: ReadonlyArray<EntryRecord>, minEntryId?: number): void {
    for (const meta of extractHelmxInputMetas(entries, minEntryId)) {
      this.upsertFromMeta(id, meta.id, meta)
    }
  }

  /** Mark submissionId as consumed by the active run: maps back to requestId via correlation index and registers once
   * (emitting onInputCommitted once). Silently skips if index is missing (bind/backfill pending) to catch on next scan. */
  markConsumed(conversationId: number, submissionId: number): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined) return
    const requestId = mirror.submissionIndex.get(submissionId)
    const input = requestId === undefined ? undefined : mirror.trackedInputs.get(requestId)
    if (!input) return
    const consumedSet = mirror.consumedInputs ?? new Set<string>()
    if (consumedSet.has(input.id)) return
    consumedSet.add(input.id)
    mirror.consumedInputs = consumedSet
    this.core.events.onInputCommitted(conversationId, input)
  }

  /** Collect inputs consumed by this run on settlement and purge them: once per requestId, clearing both tracking and index
   * entries so history never resurrects. */
  takeConsumed(conversationId: number): ConversationInput[] {
    const mirror = this.core.mirrors.get(conversationId)
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

  /** Drop the consumed set once a run settles. `runTaskId` is deliberately kept: the explicit abort path compares
   * `lastSettledRun` against it, and a genuinely new run overrides it in TrackerSettlement.advanceLiveRun. */
  resetConsumed(conversationId: number): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.consumedInputs = undefined
  }

  /** Start a fresh consumed set when a genuinely new logical run takes over (same-run handOver keeps accumulating). */
  beginRunConsumption(conversationId: number): void {
    this.core.mirrorOf(conversationId).consumedInputs = new Set<string>()
  }

  /** Register or merge metadata for a single helmx.input (idempotent by input.id; caller checked meta.id/text are strings). */
  private upsertFromMeta(id: number, requestId: string, meta: HelmxInputMeta): void {
    const map = this.core.mirrorOf(id).trackedInputs
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    map.set(requestId, existing === undefined ? rebuilt : mergeInputMeta(existing, rebuilt))
  }
}
