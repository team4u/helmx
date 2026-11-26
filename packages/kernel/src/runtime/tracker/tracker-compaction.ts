/**
 * TrackerCompaction: context-compaction failure notifications and end-of-compaction reconciliation for the
 * ConversationTracker.
 *
 * Owns `notifiedCompactionFailures` (conversation -> last notified failure taskId). It deliberately lives outside
 * the mirror so it survives stopObserving: re-observing within the same runtime must never re-report the same failure.
 * `forgetConversation` clears it only on permanent deletion.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { compactionFailureNoticeOf } from '../context-usage.js'
import type { LiveStateShape } from '../conversation-mirror.js'
import { getSdkConversation, getSdkTask } from '../sdk-ids.js'
import type { TrackerCore } from './tracker-core.js'

export class TrackerCompaction {
  /** conversation -> taskId of last notified compaction failure (prevents duplicate notifications across snapshots). */
  private readonly notifiedCompactionFailures = new Map<number, number>()

  constructor(private readonly core: TrackerCore) {}

  /** Never swallow compaction failures silently: emit one redacted error notification per new compactionFailure
   * (deduplicated by taskId so duplicate snapshots do not re-notify; SDK clears compactionFailure only on the next
   * successful compaction, and later failures get new taskIds so they report cleanly). */
  noteFailure(id: number, live: LiveStateShape | undefined): void {
    const failure = live?.compactionFailure
    if (failure === undefined) return
    if (this.notifiedCompactionFailures.get(id) === failure.taskId) return
    this.notifiedCompactionFailures.set(id, failure.taskId)
    this.core.events.onNotification?.({
      level: 'error',
      title: 'Context compaction failed',
      body: compactionFailureNoticeOf(failure, this.core.redactError),
      conversationId: id,
    })
  }

  /** Permanent conversation deletion: stop re-deduping its compaction failures (the conversation is gone). */
  forgetConversation(id: number): void {
    this.notifiedCompactionFailures.delete(id)
  }

  /**
   * Async reconciliation when compaction ends without a pi.compaction entry (runs outside synchronous adopt):
   * - inspect each finished task's authoritative terminal state; only treat as clean skip when status='terminal'
   *   and outcome.status='completed' with no written entry and no compactionFailure (selectCut === undefined or beforeCompact declined);
   * - ignore aborted / failed tasks (never misreport when compaction wasn't needed, and never flush queued inputs on uncompacted context);
   * - after confirming clean skip: emit info notification if triggered manually; if inbox still holds steer/followUp
   *   inputs while idle with no active compaction, auto-start the next turn via continue.
   */
  async reconcileFinished(
    id: number,
    generation: symbol | undefined,
    finished: ReadonlyArray<{ taskId: number; trigger: string; blocking: boolean }>,
  ): Promise<void> {
    try {
      if (this.core.isClosing || !this.core.store.getConv(id)) return
      const initialMirror = this.core.mirrors.get(id)
      if (initialMirror === undefined || initialMirror.observeGeneration !== generation) return

      let hasCleanEmpty = false
      let hasManualEmpty = false
      for (const task of finished) {
        const record = await getSdkTask(this.core.harness, task.taskId, BACKGROUND_CONTEXT)
        if (this.core.isClosing || !this.core.store.getConv(id)) return
        const currentMirror = this.core.mirrors.get(id)
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

      const mirror = this.core.mirrors.get(id)
      if (mirror === undefined || mirror.observeGeneration !== generation) return

      if (hasManualEmpty) {
        this.core.events.onNotification?.({
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
      const conv = await getSdkConversation(this.core.harness, id, BACKGROUND_CONTEXT)
      if (this.core.isClosing || !this.core.store.getConv(id)) return
      const latestMirror = this.core.mirrors.get(id)
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
      if (this.core.isClosing) return
      this.core.reportDiagnostic({
        level: 'error',
        source: 'tracker.compaction',
        message: 'compaction end reconciliation failed',
        error,
        conversationId: id,
      })
    }
  }
}
