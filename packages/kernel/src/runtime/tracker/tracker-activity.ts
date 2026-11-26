/**
 * TrackerActivity: aggregate busy accounting and idle→busy transition notification for the ConversationTracker.
 *
 * Sole writer of mirror.busyActive / busyCompactions / busyQueued / busySettling (O(1) per-mirror contributions
 * cached on the mirror so the aggregate is a running total, never a rescan).
 *
 * Owns the cross-mirror totals, the last computed aggregate busy predicate and the idle→busy listeners.
 */

import type { HubActivityCounts } from '@helmx/protocol'
import { isHubActivityBusy } from '@helmx/protocol'
import type { ConversationMirror } from '../conversation-mirror.js'
import type { TrackerCore } from './tracker-core.js'

export class TrackerActivity {
  /** Idle→busy transition listeners (activity heartbeat; see `onBusyEntered`). */
  private readonly activityBusyListeners = new Set<() => void>()
  /** Last computed aggregate busy predicate (drives idle→busy transition detection). */
  private activityBusyAggregate = false
  /** Incremental O(1) running activity totals across the mirrors. */
  private busyActiveTotal = 0
  private busyCompactionsTotal = 0
  private busyQueuedTotal = 0
  private busySettlingTotal = 0

  constructor(private readonly core: TrackerCore) {}

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
  snapshot(): HubActivityCounts {
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
  onBusyEntered(listener: () => void): () => void {
    this.activityBusyListeners.add(listener)
    return () => {
      this.activityBusyListeners.delete(listener)
    }
  }

  /** Whether the conversation currently has any Hub-tracked active work (run, queued inbox, compaction, or turn_settled in flight). */
  isConversationBusy(conversationId: number): boolean {
    const mirror = this.core.mirrors.get(conversationId)
    if (mirror === undefined) return false
    return (
      mirror.busyActive > 0 ||
      mirror.busyCompactions > 0 ||
      mirror.busyQueued > 0 ||
      mirror.busySettling > 0
    )
  }

  /** Recompute one mirror's cached contribution and fold the delta into the running totals. */
  syncMirror(mirror: ConversationMirror): void {
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

  /** Subtract a mirror's contribution in full before it is discarded (stopObserving), leaving it at zero. */
  removeMirror(mirror: ConversationMirror): void {
    this.busyActiveTotal -= mirror.busyActive
    this.busyCompactionsTotal -= mirror.busyCompactions
    this.busyQueuedTotal -= mirror.busyQueued
    this.busySettlingTotal -= mirror.busySettling
    mirror.busyActive = 0
    mirror.busyCompactions = 0
    mirror.busyQueued = 0
    mirror.busySettling = 0
  }

  /**
   * Recompute the aggregate busy predicate after a mirror mutation and notify listeners on an
   * idle→busy flip. Called only from synchronous mutation chokepoints (snapshot adoption,
   * settle begin/end, explicit abort settlement); busy→idle flips need no immediate write — a
   * slightly stale busy record only delays an update by the reader's freshness bound (the safe
   * direction), which the heartbeat's periodic refresh closes anyway.
   */
  noteMutation(): void {
    const busy = isHubActivityBusy(this.snapshot())
    if (busy === this.activityBusyAggregate) return
    this.activityBusyAggregate = busy
    if (!busy) return
    for (const listener of this.activityBusyListeners) {
      try {
        listener()
      } catch (error) {
        this.core.reportDiagnostic({
          level: 'warn',
          source: 'tracker.activity',
          message: 'activity busy-transition listener failed (heartbeat may lag until its next periodic write)',
          error,
        })
      }
    }
  }
}
