/**
 * TrackerSummary: five-state summary derivation, live `doing` summaries, pending-Ask bookkeeping, assistant text
 * cache and contextUsage maintenance for the ConversationTracker.
 *
 * Sole writer of mirror.lastSummaryKey / pendingAskCount / lastAssistant / lastIndexedAssistantEntryId.
 * Owns the ContextUsageRefresh chain: its host port needs `summaryOf` (to publish usage-only upserts) while
 * `summaryOf` reads the usage cache, so the refresh chain lives inside this module and the host callbacks bind
 * to this instance — the same cycle-breaking shape the monolithic tracker used.
 *
 * Emission discipline:
 * - emitRunSummary fires only while a run is active, deduplicated on the (status, doing, pendingAsk) fingerprint;
 *   terminal state belongs exclusively to TrackerSettlement.emitSettled;
 * - stateChangeSeq advances with real state transitions (setPendingAskCount, non-blocked doing changes) and is
 *   never advanced by usage-only publishes.
 */

import type {
  ConversationContextUsage,
  ConversationStatus,
  ConversationSummary,
  TurnOutcome,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { ConversationView } from '@earendil-works/pi-durable'
import type { ConvMeta } from '../store.js'
import { summaryOf } from '../store.js'
import type { LiveStateShape } from '../conversation-mirror.js'
import type { ContextUsageHost } from '../context-usage-refresh.js'
import { ContextUsageRefresh } from '../context-usage-refresh.js'
import { lastErrorOf, summaryKeyOf } from '../conversation-tracker-helpers.js'
import type { TrackerCore } from './tracker-core.js'

export class TrackerSummary {
  private readonly usage: ContextUsageRefresh

  constructor(private readonly core: TrackerCore) {
    const host: ContextUsageHost = {
      harness: this.core.harness,
      store: this.core.store,
      onSummaryChanged: (summary) => this.core.events.onSummaryChanged(summary),
      modelsOf: () => this.core.modelsOf?.(),
      generationOf: (id) => this.core.mirrors.get(id)?.observeGeneration,
      liveOf: (id) => this.core.mirrors.get(id)?.live,
      summaryOf: (id) => this.summaryOf(id),
      isClosing: () => this.core.isClosing,
      emitDiagnostic: (input) => this.core.reportDiagnostic(input),
    }
    this.usage = new ContextUsageRefresh(host)
  }

  /** Derive the five-state status from store meta + live mirror (blocked takes priority over working on derivation). */
  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.core.store.getConv(conversationId)
    if (!meta) throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404)
    const mirror = this.core.mirrors.get(conversationId)
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
    const lastError = status === 'error' ? lastErrorOf(live, this.core.redactError) : undefined
    const lastEntryId = this.core.lastEntryIds.get(conversationId) ?? meta.lastEntryId ?? 0
    const pendingAskSince =
      pendingAsks > 0 ? this.core.store.earliestPendingAskCreatedAt?.(conversationId) : undefined
    const summary = summaryOf({
      meta,
      status,
      pendingAskCount: pendingAsks,
      doing,
      lastError,
      lastEntryId,
      pendingAskSince,
      runtimeModelOverride: this.core.hasRuntimeModelOverride?.(conversationId),
    })
    const usage = this.usage.cachedOrSchedule(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
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
  emitRunSummary(id: number): void {
    const mirror = this.core.mirrors.get(id)
    if (!mirror?.live?.run) return
    const meta = this.core.store.getConv(id)
    if (!meta) return
    const candidate = this.summaryOf(id)
    if (mirror.lastSummaryKey === summaryKeyOf(candidate)) return
    // While blocked on a pending AskDoc, sibling tool `doing` transitions still emit refreshed summaries,
    // without advancing `stateChangeSeq` past the pending AskDoc's CAS ceiling.
    if (candidate.status !== 'blocked') {
      this.core.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
    const summary = candidate.status !== 'blocked' ? this.summaryOf(id) : candidate
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.core.events.onSummaryChanged(summary)
  }

  setPendingAskCount(conversationId: number, count: number): void {
    const mirror = this.core.mirrorOf(conversationId)
    const prev = mirror.pendingAskCount
    const meta = this.core.store.getConv(conversationId)
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
      this.core.store.upsertConv(updated)
    }
    const summary = this.summaryOf(conversationId, count)
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.core.events.onSummaryChanged(summary)
  }

  /** Record latest observed assistant text (data source for getLastAssistantText). */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const mirror = this.core.mirrorOf(conversationId)
    const prev = mirror.lastAssistant
    if (prev !== undefined && prev.entryId === entryId) return
    mirror.lastAssistant = { entryId, text }
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.core.mirrors.get(conversationId)?.lastAssistant?.text
  }

  /** Invalidate lastAssistant cache entries inside a rewound interval (after in-place overwrite & resend).
   *
   * Clears only if the cached entry falls within [from, through] so a failed resend does not expose the overwritten
   * answer via getLastAssistantText while earlier turns outside the interval stay valid. */
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    const mirror = this.core.mirrors.get(conversationId)
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

  /** Forward the latest persisted pi.assistant entry from a snapshot: advance the indexed-assistant watermark and
   * emit onAssistantText exactly once per new entry (the in-memory text cache is filled by the host sink → recordAssistantText). */
  forwardAssistantEntry(conversationId: number, latest: { entryId: number; text: string }): void {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined || mirror.lastIndexedAssistantEntryId === latest.entryId) return
    if (Number.isFinite(latest.entryId)) mirror.lastIndexedAssistantEntryId = latest.entryId
    this.core.events.onAssistantText(conversationId, latest.entryId, latest.text)
  }

  /** Initial attach: seed the indexed-assistant watermark and the text cache from the window without emitting, so
   * subsequent streaming adopt ticks do not re-trigger FTS5 trigram indexing for already persisted assistant entries. */
  seedAssistantEntry(conversationId: number, latest: { entryId: number; text: string }): void {
    const mirror = this.core.mirrorOf(conversationId)
    if (!Number.isFinite(latest.entryId)) return
    mirror.lastIndexedAssistantEntryId = latest.entryId
    mirror.lastAssistant ??= latest
  }

  /** Record a summary fingerprint and publish it as conversation.upsert (shared by settlement and the idle adopt fallback). */
  publishSummary(conversationId: number, summary: ConversationSummary): void {
    this.core.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(summary)
    this.core.events.onSummaryChanged(summary)
  }

  /** Initial attach with a recovered active run: seed the dedupe key from the current summary so subsequent adopts only
   * emit on actual status/doing transitions instead of pushing redundant working frames. */
  primeRunSummaryKey(conversationId: number): void {
    if (!this.core.store.getConv(conversationId)) return
    this.core.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(this.summaryOf(conversationId))
  }

  /** Determine whether a conversation is background-derived: has a parent chain and non-human ownership (managed subagent / Worker, etc.).
   * If ownership callback is absent or fails (including deleted), default to human—better to over-emit than suppress human unreads. */
  isBackgroundDerived(conversationId: number, meta: ConvMeta): boolean {
    if (meta.parentConversationId === undefined) return false
    if (this.core.ownershipOf === undefined) return false
    try {
      return this.core.ownershipOf(conversationId) !== 'human'
    } catch {
      return false
    }
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
      const meta = this.core.store.getConv(id)
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
    for (const [id, mirror] of this.core.mirrors) {
      if (mirror.observeGeneration !== undefined) out.push(id)
    }
    return out
  }

  // ------------------------------------------------------------------
  // contextUsage refresh chain port (ContextUsageRefresh is private to this module)
  // ------------------------------------------------------------------

  /** Schedule an async context usage refresh (public port for service/ops consumers). */
  scheduleUsage(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    this.usage.schedule(conversationId, options)
  }

  /** Ensure a conversation's contextUsage cache is populated and its refresh chain settled (first detail read, etc.). */
  async ensureUsage(conversationId: number): Promise<void> {
    await this.usage.ensure(conversationId)
  }

  /** Synchronously read the cached usage without scheduling (settlement attaches it to the terminal summary). */
  peekUsage(conversationId: number): ConversationContextUsage | undefined {
    return this.usage.peek(conversationId)
  }

  /** Seed the usage scan watermark on initial attach so historical steps are not rescanned. */
  advanceUsageWatermark(conversationId: number, value: number): void {
    this.usage.advanceWatermarkTo(conversationId, value)
  }

  /** Notify the chain of a live boundary (compaction / reset / rewind / run start) observed in a snapshot. */
  noteUsageBoundary(
    conversationId: number,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): void {
    this.usage.noteBoundary(conversationId, view, prev, live)
  }

  /** Drop cache/waiters of a conversation on stopObserving (waiters resolve first so none hang). */
  clearUsage(conversationId: number): void {
    this.usage.clearConversation(conversationId)
  }
}
