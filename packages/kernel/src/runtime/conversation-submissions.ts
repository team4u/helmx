/**
 * Conversation submission inspection, completion wait, withdrawal, and abort operations.
 */
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type {
  ConversationInputResult,
  ConversationSubmissionInfo,
  ConversationWithdrawResponse,
  GuardedMutationExpectation,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { SecretStash } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import { requireConv } from './conversation-require.js'
import { assistantTextOfModel, readEntryById, toConversationEntry } from './entries.js'
import {
  abortSdkSubmission,
  asConversationId,
  getSdkConversation,
  getSdkSubmission,
  isSdkInputSubmissionFor,
} from './sdk-ids.js'
import type { HelmxStore } from './store.js'

export interface ConversationSubmissionHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly stash: SecretStash
  readonly isClosed: () => boolean
  readonly isStarted: () => boolean
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
  readonly withMutationGate: <T>(id: number, op: () => Promise<T>) => Promise<T>
  readonly hasAutoResetRuntimeModel?: (id: number) => boolean
  readonly resetRuntimeModelOnRunEnd?: (id: number, opts?: { insideMutationGate?: boolean }) => Promise<void>
}

export class ConversationSubmissionService {
  constructor(private readonly host: ConversationSubmissionHost) {}

  async getConversationSubmission(
    id: number,
    requestId: string,
  ): Promise<ConversationSubmissionInfo | undefined> {
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw new HelmxError('validation_error', 'requestId must be a non-empty string', 400)
    }
    requireConv(this.host.store, id)
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    const record = await this.host.harness.commit(
      (tx) => tx.submissionByRequest(asConversationId(id), requestId),
      BACKGROUND_CONTEXT,
    )
    if (record === undefined) return undefined
    return {
      id: String(record.id),
      requestId: record.requestId ?? requestId,
      status: record.status,
    }
  }

  async waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> {
    if (submissionId.startsWith('handled:')) {
      throw new HelmxError(
        'wait_not_applicable',
        `submission ${submissionId} was handled by an input hook and has no real turn to wait for`,
        409,
        { conversationId: id, submissionId },
      )
    }
    const numericId = Number(submissionId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new HelmxError('validation_error', `invalid submissionId: ${submissionId}`, 400)
    }
    requireConv(this.host.store, id)
    const waitContext = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
    const waitAbortedError = (): HelmxError =>
      new HelmxError('aborted', `waiting for result of submission ${submissionId} in conversation ${id} was cancelled`, 499, {
        conversationId: id,
        submissionId,
      })
    const runWaitOp = async <T>(op: () => Promise<T>): Promise<T> => {
      if (signal?.aborted) throw waitAbortedError()
      try {
        return await awaitWithContext(op(), waitContext)
      } catch (error) {
        if (signal?.aborted) throw waitAbortedError()
        throw error
      }
    }
    const submission = await runWaitOp(() => getSdkSubmission(this.host.harness, numericId, waitContext))
    if (!submission) {
      throw new HelmxError('not_found', `submission not found: ${submissionId}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const status = await runWaitOp(() => submission.status(waitContext))
    if (!isSdkInputSubmissionFor(status, id, numericId)) {
      throw new HelmxError('not_found', `submission ${submissionId} does not belong to conversation ${id}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const settled = await runWaitOp(() => submission.wait(waitContext))
    if (settled.status === 'unanswered') {
      const reason = settled.reason ?? 'unknown'
      const aborted = reason === 'aborted' || reason === 'interrupted' || reason === 'reset'
      throw new HelmxError(
        aborted ? 'turn_aborted' : 'turn_failed',
        `conversation ${id} turn produced no answer (${reason}${settled.detail !== undefined ? `: ${String(settled.detail)}` : ''})`,
        aborted ? 499 : 502,
        {
          conversationId: id,
          submissionId,
          reason,
          detail: settled.detail,
        },
      )
    }
    if (settled.type !== 'input' || settled.status !== 'done' || settled.answer === undefined) {
      throw new HelmxError('turn_failed', `submission ${submissionId} settled in non-terminal state ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    const answerEntryId = settled.answer
    const conversation = await runWaitOp(() => getSdkConversation(this.host.harness, id, waitContext))
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    const raw = await runWaitOp(() => readEntryById(conversation, answerEntryId, waitContext))
    if (raw === undefined) {
      throw new HelmxError('not_found', `answer entry missing: ${settled.answer}`, 502, {
        conversationId: id,
        submissionId,
      })
    }
    const entry = toConversationEntry(raw)
    const text = this.host.stash.redact(assistantTextOfModel(entry.model))
    return { conversationId: id, submissionId, text, entry }
  }

  async withdrawQueuedInputInternal(
    id: number,
    opts: { submissionId: number },
    guard?: GuardedMutationExpectation,
  ): Promise<ConversationWithdrawResponse> {
    if (this.host.isClosed()) throw new HelmxError('runtime_closed', 'kernel is closing; rejecting withdrawal', 503)
    const raw = opts.submissionId
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmxError('validation_error', `submissionId must be a positive safe integer (received ${String(raw)})`, 400, {
        conversationId: id,
        submissionId: raw,
      })
    }
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    requireConv(this.host.store, id)
    const sub = await getSdkSubmission(this.host.harness, raw, BACKGROUND_CONTEXT)
    const rec = sub ? await sub.status(BACKGROUND_CONTEXT) : undefined
    if (rec === undefined || !isSdkInputSubmissionFor(rec, id, raw)) {
      throw new HelmxError('not_found', `submission ${raw} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    const outcome = await abortSdkSubmission(this.host.harness, raw, BACKGROUND_CONTEXT, id)
    if (outcome === 'not_found') {
      throw new HelmxError('not_found', `submission ${raw} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        submissionId: raw,
      })
    }
    if (outcome === 'aborted') {
      this.host.tracker.dropSubmission(id, raw, rec.requestId)
      return { status: 'withdrawn' }
    }
    if (!sub) return { status: outcome }
    const latest = await sub.status(BACKGROUND_CONTEXT)
    return {
      status: outcome,
      ...('entry' in latest && typeof latest.entry === 'number' ? { entryId: latest.entry } : {}),
    }
  }

  async abortConversation(id: number): Promise<void> {
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    const wasBusy = this.host.tracker.hasLiveWork(id)
    await conversation.abort(BACKGROUND_CONTEXT)
    if (this.host.hasAutoResetRuntimeModel?.(id)) {
      await this.host.resetRuntimeModelOnRunEnd?.(id)
    }
    if (wasBusy) this.host.tracker.settleAborted(id)
    else this.host.tracker.clearQueuedTracking(id)
  }

  async abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void> {
    return this.host.withMutationGate(id, async () => {
      if (!this.host.isStarted()) {
        const inspection = await this.host.harness.inspect(BACKGROUND_CONTEXT)
        if (inspection.scheduling === 'paused') {
          let matched = false
          for (const task of inspection.tasks) {
            if (Number(task.record.conversationId) !== id) continue
            matched = true
            this.host.assertMutationGuard(id, guard)
            await this.host.harness.abortTask(task.record.id, BACKGROUND_CONTEXT)
          }
          if (!matched) {
            this.host.assertMutationGuard(id, guard)
          }
          return
        }
      }
      const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
      this.host.assertMutationGuard(id, guard)
      const wasBusy = this.host.tracker.hasLiveWork(id)
      await conversation.abort(BACKGROUND_CONTEXT)
      if (this.host.hasAutoResetRuntimeModel?.(id)) {
        await this.host.resetRuntimeModelOnRunEnd?.(id, { insideMutationGate: true })
      }
      if (wasBusy) this.host.tracker.settleAborted(id)
      else this.host.tracker.clearQueuedTracking(id)
    })
  }
}
