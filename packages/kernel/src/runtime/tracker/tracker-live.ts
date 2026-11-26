/**
 * TrackerLive: throttled live-frame pushes (`onLiveChanged`) and live view snapshots for the ConversationTracker.
 *
 * Sole writer of mirror.pendingLive / liveDirty / liveTimer / lastEmittedLive / lastEmittedInbox.
 *
 * Throttle discipline (75ms window):
 * - Only the latest snapshot per window is retained; identical content is deduplicated structurally;
 * - Queued-input changes (enqueue/dequeue) bypass the throttle and flush synchronously so steer/followUp pills
 *   appear at the timeline tail as soon as observed;
 * - Idle views are never emitted, except a cleanup frame when a previously emitted queue drains;
 * - Terminal flush (flushFinal) is issued by TrackerSettlement before turn_settled; the timer is cleared on
 *   observer end / stopObserving / close so no ghost frame follows deletion.
 */

import type { ConversationLive } from '@helmx/protocol'
import { sameConversationLiveContent, sameQueuedInputs } from '@helmx/protocol'
import { deriveConversationLive } from '../entries.js'
import type { LiveStateShape } from '../conversation-mirror.js'
import type { TrackerCore } from './tracker-core.js'

/** Live throttling window (ms): 75ms inside 50-100ms range balances SSE frame rate against commit load. */
const LIVE_THROTTLE_MS = 75

export class TrackerLive {
  constructor(private readonly core: TrackerCore) {}

  /** Throttled live view emitter: retains only the latest snapshot per window and deduplicates identical content.
   *
   * Changes to queuedInputs (enqueue/dequeue) bypass the 75ms throttle and flush immediately so steer/followUp pills
   * appear at the timeline tail as soon as observed (subject only to observer commit timing). */
  emitThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.core.events.onLiveChanged === undefined) return
    const mirror = this.core.mirrors.get(id)
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
        this.clearTimer(id)
        if (mirror !== undefined) {
          mirror.pendingLive = undefined
          mirror.liveDirty = false
        }
        return
      }
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendNow(id, cleanup)
      return
    }
    // Defer `deriveConversationLive` per-token allocations while `liveTimer` is already armed and the inbox queue
    // has not changed; `flushPending` derives once from the latest mirror when the 75ms timer fires.
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
      this.clearTimer(id)
      this.sendNow(id, snapshot)
      return
    }
    const m = this.core.mirrorOf(id)
    m.pendingLive = snapshot
    m.liveDirty = false
    if (m.liveTimer !== undefined) return
    const timer = setTimeout(() => {
      m.liveTimer = undefined
      this.flushPending(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    m.liveTimer = timer
  }

  /** Force terminal flush: emits a synchronous frame from current live mirror (canceling timer and dropping stale pending). */
  flushFinal(conversationId: number): void {
    this.clearTimer(conversationId)
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror !== undefined) {
      mirror.pendingLive = undefined
      mirror.liveDirty = false
    }
    if (this.core.events.onLiveChanged === undefined) return
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
    const m = this.core.mirrorOf(conversationId)
    m.lastEmittedLive = snapshot
    m.lastEmittedInbox = m.inbox
    this.core.events.onLiveChanged(snapshot)
  }

  /** Clear live throttling timer (idempotent). */
  clearTimer(id: number): void {
    const mirror = this.core.mirrors.get(id)
    const timer = mirror?.liveTimer
    if (timer !== undefined && mirror !== undefined) {
      clearTimeout(timer)
      mirror.liveTimer = undefined
    }
  }

  /** Live views for SSE snapshot: only conversations with an active run, streaming generation, or non-empty queue.
   *
   * Derived synchronously from live/inbox mirrors (independent of throttled push cache) so reconnect initial frames
   * restore queued pills and streaming text without resurrecting idle conversations that have nothing to show. */
  listViews(): ConversationLive[] {
    const out: ConversationLive[] = []
    for (const [id, mirror] of this.core.mirrors) {
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

  /** Synchronously send one live frame (shared by terminal flushes / queue cleanup) and record the emitted snapshot. */
  private sendNow(id: number, snapshot: ConversationLive): void {
    this.clearTimer(id)
    const mirror = this.core.mirrorOf(id)
    mirror.pendingLive = undefined
    mirror.liveDirty = false
    mirror.lastEmittedLive = snapshot
    mirror.lastEmittedInbox = mirror.inbox
    this.core.events.onLiveChanged?.(snapshot)
  }

  /** Flush pending snapshot inside throttle window (runs on timer expiry or immediate queue change). */
  private flushPending(id: number): void {
    const mirror = this.core.mirrors.get(id)
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
    this.core.events.onLiveChanged?.(snapshot)
  }
}
