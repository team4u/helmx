/**
 * ConversationSubmit: the top-level input submission orchestration of ConversationService (submitInput).
 *
 * Pipeline order (every step is a deliberate chokepoint; keep the order when editing):
 *   writability + open guard + whenPendingAsk shape validation → conversation existence → requestId idempotency
 *   (durable submissionByRequest: an already-committed requestId returns its submissionId with zero side effects)
 *   → attachment shape validation → effective model resolution + disabled-model preflight → fast pending-ask
 *   pre-check (whenPendingAsk=reject) → replace-target validation → attachment authorization → input hook
 *   pipeline (prepareInput) → guarded re-check → content assembly → commit path:
 *     - replaceFromEntryId: history-edit mutex, target-still-current + pending-ask assertions around the rewrite;
 *     - mutationGuard: per-conversation mutation gate (serialize with guarded abort/reset/compact/delete);
 *     - whenPendingAsk=reject: re-check before commit and synchronously at the commit point, title derivation
 *       deferred until after commit so a 409 leaves zero side effects;
 *     - plain: title derived before commit, pending asks superseded after a successful human (non-reject) submit.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { GuardedMutationExpectation } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { ConversationAttachments } from '../conversation-attachments.js'
import type { ConversationInputPipeline } from '../conversation-input.js'
import type { SubmitInputOptions } from '../conversation-input.js'
import { requireConv } from '../conversation-require.js'
import type { ConversationRewind } from '../conversation-rewind.js'
import type { HelmxStore } from '../store.js'
import { asConversationId, getSdkConversation } from '../sdk-ids.js'

export interface ConversationSubmitHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly rewind: ConversationRewind
  readonly inputPipeline: ConversationInputPipeline
  readonly resolveAuthorizedAttachments: ConversationAttachments['resolveAuthorizedAttachments']
  readonly buildAttachmentContent: ConversationAttachments['buildAttachmentContent']
  /** Model resolution chain (profile / override → effective model ref). */
  readonly resolveEffectiveModel: (override: string | undefined, profileId: string) => Promise<string | undefined>
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** Disabled-model preflight check (ModelRegistry.assertModelEnabled). */
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  /** Supersede pending asks when direct human input arrives (host injects idempotent ask settlement). */
  readonly supersedePendingAsks: ((id: number) => Promise<void>) | undefined
  /** Pending AskDoc IDs for `whenPendingAsk: 'reject'` atomic checks (falls back to the store when omitted). */
  readonly listPendingAskIds: ((id: number) => string[]) | undefined
  /** Writability guard (throws fatal storage error or runtime_closed when kernel cannot accept mutations). */
  readonly assertWritable: () => void
  /** Context-open guard (rejects submissions against a closed context). */
  readonly assertOpen: () => void
  /** Synchronous ownership / CAS re-check (guarded-mutations.ts). */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
  /** Per-conversation mutation gate shared with guarded abort / reset / compact / delete. */
  readonly withMutationGate: <T>(id: number, op: () => Promise<T>) => Promise<T>
}

export class ConversationSubmit {
  constructor(private readonly host: ConversationSubmitHost) {}

  async submitInput(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
  ): Promise<{ submissionId: string }> {
    const { host } = this
    host.assertWritable()
    host.assertOpen()
    if (
      opts?.whenPendingAsk !== undefined &&
      opts.whenPendingAsk !== 'supersede' &&
      opts.whenPendingAsk !== 'reject'
    ) {
      throw new HelmxError(
        'validation_error',
        `invalid whenPendingAsk: expected 'supersede' | 'reject', got ${String(opts.whenPendingAsk)}`,
        400,
      )
    }
    const convMeta = requireConv(host.store, id)
    const conversation = await getSdkConversation(host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)

    if (opts?.requestId !== undefined) {
      if (typeof opts.requestId !== 'string' || opts.requestId.trim() === '') {
        throw new HelmxError('validation_error', 'internal requestId must be a non-empty string', 400)
      }
      const reqId = opts.requestId
      const previous = await host.harness.commit(
        (tx) => tx.submissionByRequest(asConversationId(id), reqId),
        BACKGROUND_CONTEXT,
      )
      if (previous !== undefined) return { submissionId: String(previous.id) }
    }
    if (opts?.attachments !== undefined) {
      if (
        !Array.isArray(opts.attachments) ||
        opts.attachments.some((a) => typeof a !== 'string' || a.length === 0)
      ) {
        throw new HelmxError(
          'validation_error',
          'attachments must be an array of non-empty artifact ID strings',
          400,
          { conversationId: id },
        )
      }
    }

    const effectiveModelRef = await host.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmxError(
        'model_not_configured',
        `no model configured for conversation ${id} (profile ${convMeta.profileId}) or globally: configure a model on the Profile, HELMX_MODEL, config.json.model, or conversation`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    {
      const effectiveRef = host.parseModelRefOrThrow(effectiveModelRef)
      host.assertModelEnabled(effectiveRef.provider, effectiveRef.modelId)
    }

    // Fast pre-check before async rewind validation, attachment IO, and input hooks.
    if (opts?.whenPendingAsk === 'reject') {
      this.assertNoPendingAsks(id)
    }

    const replaceFromEntryId = await host.rewind.validateReplaceTarget(conversation, id, opts?.replaceFromEntryId)
    const initialAttachments =
      opts?.attachments !== undefined && opts.attachments.length > 0
        ? await host.resolveAuthorizedAttachments(id, opts.attachments)
        : undefined
    const prepared = await host.inputPipeline.prepareInput(id, text, opts, initialAttachments)
    if (opts?.mutationGuard !== undefined) {
      host.assertMutationGuard(id, opts.mutationGuard)
    }
    if (prepared.kind === 'handled') return { submissionId: prepared.submissionId }
    if (prepared.finalWhenPendingAsk === 'reject') {
      this.assertNoPendingAsks(id)
    }

    host.assertOpen()

    const content =
      prepared.resolvedAttachments !== undefined
        ? await host.buildAttachmentContent(prepared.effectiveText, prepared.resolvedAttachments)
        : prepared.effectiveText

    if (replaceFromEntryId !== undefined) {
      const finalInput = { ...prepared.finalInput, whenBusy: 'reject' as const }
      const targetId = replaceFromEntryId
      const assertPendingAsk =
        prepared.finalWhenPendingAsk === 'reject' ? () => this.assertNoPendingAsks(id) : undefined
      return host.rewind.withHistoryEdit(id, async () => {
        assertPendingAsk?.()
        await host.rewind.assertTargetStillCurrent(conversation, id, targetId)
        assertPendingAsk?.()
        if (assertPendingAsk === undefined) {
          // Re-read metadata after prepareInput so mutations performed by onInput hooks (e.g. tags) are preserved.
          host.inputPipeline.applyFirstInputTitle(requireConv(host.store, id), prepared.effectiveText)
        }
        const result = await host.rewind.rewriteConversationFrom(
          id,
          conversation,
          targetId,
          {
            finalInput,
            effectiveText: prepared.effectiveText,
            resolvedAttachments: prepared.resolvedAttachments,
            content,
          },
          assertPendingAsk,
        )
        if (assertPendingAsk !== undefined) {
          const latestMeta = host.store.getConv(id)
          if (latestMeta !== undefined && !host.store.isDeleted(id)) {
            host.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
          }
        }
        return result
      })
    }
    const assertPendingAsk =
      prepared.finalWhenPendingAsk === 'reject' ? () => this.assertNoPendingAsks(id) : undefined
    const freshSubmission = {
      finalInput: prepared.finalInput,
      finalWhenBusy: prepared.finalWhenBusy,
      effectiveText: prepared.effectiveText,
      resolvedAttachments: prepared.resolvedAttachments,
      content,
      requestId: opts?.requestId,
      ...(opts?.whenIdle !== undefined ? { whenIdle: opts.whenIdle } : {}),
      ...(opts?.mutationGuard !== undefined ? { mutationGuard: opts.mutationGuard } : {}),
      ...(assertPendingAsk !== undefined ? { assertBeforeCommit: assertPendingAsk } : {}),
    }
    if (opts?.mutationGuard !== undefined) {
      return host.withMutationGate(id, async () => {
        const result = await host.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
        const latestMeta = host.store.getConv(id)
        if (latestMeta !== undefined && !host.store.isDeleted(id)) {
          host.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
        }
        return result
      })
    }
    if (assertPendingAsk !== undefined) {
      // Re-check before commit and again synchronously at commit point via assertBeforeCommit;
      // defer title derivation until after commit succeeds so 409 ask_pending leaves zero side effects.
      assertPendingAsk()
      const submitted = await host.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
      const latestMeta = host.store.getConv(id)
      if (latestMeta !== undefined && !host.store.isDeleted(id)) {
        host.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
      }
      return submitted
    }
    // Re-read metadata after prepareInput so mutations performed by onInput hooks (e.g. tags) are preserved.
    host.inputPipeline.applyFirstInputTitle(requireConv(host.store, id), prepared.effectiveText)
    const submitted = await host.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
    if (prepared.finalInput.origin === 'human' && prepared.finalWhenBusy !== 'reject') {
      await host.supersedePendingAsks?.(id)
    }
    return submitted
  }

  /** Reject atomically (409 ask_pending) while AskDocs are pending (whenPendingAsk=reject). */
  private assertNoPendingAsks(id: number): void {
    const pendingAskIds =
      this.host.listPendingAskIds !== undefined
        ? this.host.listPendingAskIds(id)
        : this.host.store.listAsksByConversation(id, 'pending').map((ask) => ask.id)
    if (pendingAskIds.length > 0) {
      throw new HelmxError(
        'ask_pending',
        `conversation ${id} has ${pendingAskIds.length} pending AskDoc(s); rejecting submission (whenPendingAsk=reject)`,
        409,
        { conversationId: id, pendingAskIds },
      )
    }
  }
}
