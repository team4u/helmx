/**
 * Conversation input pipeline: hook scheduling, input redaction, title derivation, and fresh submission execution.
 *
 * Responsibilities:
 * - Run input hooks (supporting block interception, handled takeover, and transform rewriting);
 * - Globally redact submission metadata and body text (SecretStash);
 * - Pin default whenBusy to 'steer';
 * - Re-authorize artifact attachments added/modified by hooks;
 * - Auto-derive conversation title from first input;
 * - Submit new inputs to SDK harness and correlate bindings with tracker.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { copyJson, type JsonRepresentation } from '@earendil-works/chord/json'
import { InboxDoc, LiveDoc, type Harness, type Submission, type UserInput } from '@earendil-works/pi-durable'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationInput,
  GuardedMutationExpectation,
  WhenBusy,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { randomUUID } from 'node:crypto'
import { redactJsonValue } from '../redact.js'
import type { SecretStash } from '../services/index.js'
import { deriveTitle, type ConversationTracker } from './conversations.js'
import { normalizeBusyError } from './runtime-helpers.js'
import { asConversationId } from './sdk-ids.js'
import type { PromptContent } from './conversation-attachments.js'
import type { SubmitInputOptions } from './conversation-service.js'
import type { ConvMeta, HelmxStore } from './store.js'

/** Minimal tracker callbacks needed to register, correlate, and roll back a durable input submission. */
export interface DurableInputTracker {
  registerInput(conversationId: number, input: ConversationInput): void
  bindSubmission(conversationId: number, inputId: string, submissionId: number): void
  dropInput(conversationId: number, inputId: string): void
}

/** Shared hook-free durable input submission parameters (reused by `ConversationInputPipeline` and native `spawn`). */
export interface DurableInputSubmitOptions {
  readonly harness: Harness
  readonly conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>
  readonly conversationId: number
  readonly input: ConversationInput
  readonly whenBusy: WhenBusy
  readonly content: PromptContent
  /** Durable deduplication key (`pi_submissions.request_id`); defaults to `input.id`. */
  readonly requestId?: string
  readonly whenIdle?: 'reject'
  /** Optional tracker correlation port (wired in full `KernelRuntime`; omitted in standalone `runNativeSpawn` unit tests). */
  readonly tracker?: DurableInputTracker
  /** Optional commit-point atomic guard re-check (synchronous, zero awaits). */
  readonly assertMutationGuard?: () => void
}

/** Result of `submitDurableInput`: string submission ID plus live SDK `Submission` handle for awaiting completion. */
export interface DurableInputSubmitResult {
  readonly submissionId: string
  readonly submission: Submission
}

/**
 * Shared hook-free durable input submission primitive (`helmx.input` entry + tracker correlation + atomic
 * compaction mutual exclusion + `requestId` deduplication).
 *
 * Used by both `ConversationInputPipeline.submitFreshInput` (top-level conversations after `input` hooks)
 * and native `spawn` (sub-conversations without routing through top-level `input` hooks).
 */
export async function submitDurableInput(
  options: DurableInputSubmitOptions,
): Promise<DurableInputSubmitResult> {
  const {
    harness,
    conversation,
    conversationId,
    input,
    whenBusy,
    content,
    whenIdle,
    tracker,
    assertMutationGuard,
  } = options
  const requestId = options.requestId ?? input.id
  const entryData = copyJson(
    {
      id: input.id,
      text: input.text,
      origin: input.origin,
      createdAt: input.createdAt,
      whenBusy,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    },
    { omitUndefinedProperties: true },
  )
  tracker?.registerInput(conversationId, input)
  let queueResult:
    | { handled: true; submissionId: number; alreadySettled: boolean }
    | { handled: false }
  try {
    // Atomically check pi.live: SDK admitSubmission inspects live.run but not live.compactions;
    // when idle with an active compaction task, enqueue into pi.inbox (or reject) inside this transaction
    // so the new turn does not race ahead on uncompacted context.
    const convId = asConversationId(conversationId)
    queueResult = await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, convId)
      const inbox = await tx.doc(InboxDoc, convId)
      const existing = await tx.submissionByRequest(convId, requestId)
      if (existing !== undefined) {
        if (existing.type !== 'input') {
          throw new Error(`Request ${requestId} already identifies a submission of type ${existing.type}`)
        }
        return {
          handled: true as const,
          submissionId: existing.id as number,
          alreadySettled: existing.status === 'done' || existing.status === 'unanswered',
        }
      }
      if (live.run === undefined && (live.compactions?.length ?? 0) > 0 && whenIdle !== 'reject') {
        if (whenBusy === 'reject') {
          throw new HelmxError(
            'conversation_busy',
            `conversation ${conversationId} is currently compacting context; rejecting submission (whenBusy=reject)`,
            409,
            { conversationId },
          )
        }
        assertMutationGuard?.()
        const sub = await tx.createSubmission({
          conversationId: convId,
          requestId,
          type: 'input',
          status: 'queued',
        })
        inbox.items.push({
          id: sub.id,
          mode: whenBusy === 'steer' ? 'steer' : 'followUp',
          content: copyJson(content, { omitUndefinedProperties: true }) as JsonRepresentation<UserInput>,
          entry: {
            kind: 'helmx.input',
            data: entryData,
          },
        })
        return { handled: true as const, submissionId: sub.id as number, alreadySettled: false }
      }
      return { handled: false as const }
    }, BACKGROUND_CONTEXT)
  } catch (error) {
    tracker?.dropInput(conversationId, input.id)
    throw normalizeBusyError(error)
  }

  if (queueResult.handled) {
    if (queueResult.alreadySettled) {
      tracker?.dropInput(conversationId, input.id)
    } else {
      tracker?.bindSubmission(conversationId, input.id, queueResult.submissionId)
    }
    const submission = await harness.submission(queueResult.submissionId as never, BACKGROUND_CONTEXT)
    if (submission === undefined) {
      throw new HelmxError(
        'not_found',
        `submission ${queueResult.submissionId} disappeared immediately after admission`,
        500,
        { conversationId, submissionId: queueResult.submissionId },
      )
    }
    return { submissionId: String(queueResult.submissionId), submission }
  }

  try {
    // Final commit-point re-check: zero awaits before the subsequent SDK submit call,
    // catching any ownership shift during preparation without producing a submission.
    assertMutationGuard?.()
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        whenBusy,
        ...(whenIdle !== undefined ? { whenIdle } : {}),
        entry: {
          kind: 'helmx.input',
          data: entryData,
        },
        requestId,
      },
      BACKGROUND_CONTEXT,
    )
    tracker?.bindSubmission(conversationId, input.id, submission.id as number)
    return { submissionId: String(submission.id), submission }
  } catch (error) {
    tracker?.dropInput(conversationId, input.id)
    throw normalizeBusyError(error)
  }
}

interface ConversationInputPipelineHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly stash: SecretStash
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  readonly resolveAuthorizedAttachments: (
    conversationId: number,
    attachmentIds: readonly string[],
  ) => Promise<Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>>
  /** Commit-point re-check for guarded mutations (synchronous, zero awaits; ConversationService.assertMutationGuard). */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
}

type PreparedInputResult =
  | { kind: 'handled'; submissionId: string }
  | {
      kind: 'final'
      finalInput: ConversationInput
      finalWhenBusy: WhenBusy
      effectiveText: string
      resolvedAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined
    }

export class ConversationInputPipeline {
  constructor(private readonly host: ConversationInputPipelineHost) {}

  /**
   * Apply input hooks and finalize input shape:
   * returns either handled (taken over) or finalized { finalInput, finalWhenBusy, effectiveText, resolvedAttachments }.
   */
  async prepareInput(
    id: number,
    text: string,
    opts: SubmitInputOptions | undefined,
    initialAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined,
  ): Promise<PreparedInputResult> {
    const origin = opts?.origin ?? 'human'
    if (opts?.requestId !== undefined && (typeof opts.requestId !== 'string' || opts.requestId.trim() === '')) {
      throw new HelmxError('validation_error', 'internal requestId must be a non-empty string', 400)
    }
    const inputId = opts?.requestId ?? randomUUID()
    const createdAt = Date.now()
    const safeMeta =
      opts?.meta !== undefined
        ? (redactJsonValue(opts.meta, (t) => this.host.stash.redact(t)) as Record<string, unknown>)
        : undefined
    const payload: { conversationId: number; input: ConversationInput } = {
      conversationId: id,
      input: {
        id: inputId,
        text,
        origin,
        whenBusy: opts?.whenBusy,
        createdAt,
        ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
        ...(initialAttachments !== undefined
          ? { attachments: initialAttachments.map((r) => r.ref) }
          : {}),
      },
    }
    const hookOutcome = await this.host.runInputHook(payload)
    if (hookOutcome?.action === 'block') {
      throw new HelmxError('input_blocked', hookOutcome.reason ?? 'input blocked by input hook')
    }
    if (hookOutcome?.action === 'handled') {
      return { kind: 'handled', submissionId: `handled:${randomUUID()}` }
    }
    let finalInput: ConversationInput = payload.input
    let finalWhenBusy: WhenBusy | undefined = opts?.whenBusy
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as typeof payload
      if (value.conversationId !== id) {
        throw new HelmxError(
          'input_identity_changed',
          `input hook must not change conversationId (${id} -> ${String(value.conversationId)})`,
          400,
        )
      }
      finalInput = value.input
      finalWhenBusy = finalInput.whenBusy ?? finalWhenBusy
    }
    finalWhenBusy = finalWhenBusy ?? 'steer'
    finalInput = { ...finalInput, whenBusy: finalWhenBusy }
    const finalIds = finalInput.attachments?.map((a) => a.id) ?? []
    const resolvedAttachments =
      finalIds.length > 0
        ? await this.host.resolveAuthorizedAttachments(id, finalIds)
        : finalIds.length === 0 && initialAttachments !== undefined
          ? undefined
          : initialAttachments

    if (finalInput.meta !== undefined) {
      finalInput = {
        ...finalInput,
        meta: redactJsonValue(finalInput.meta, (t) => this.host.stash.redact(t)) as Record<string, unknown>,
      }
    }
    const effectiveText = this.host.stash.redact(finalInput.text)
    finalInput = {
      ...finalInput,
      text: effectiveText,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }
    return { kind: 'final', finalInput, finalWhenBusy, effectiveText, resolvedAttachments }
  }

  /** Auto-title on first input (derived from redacted text; advances stateChangeSeq synchronously). */
  applyFirstInputTitle(meta: ConvMeta, effectiveText: string): void {
    if (meta.title !== '') return
    const title = deriveTitle(effectiveText)
    this.host.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
  }

  /** Submit fresh input to SDK (non-rewind path; delegates durable commit, compaction mutex, and tracker correlation to `submitDurableInput`). */
  async submitFreshInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    prepared: {
      finalInput: ConversationInput
      finalWhenBusy: WhenBusy
      effectiveText: string
      resolvedAttachments: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> | undefined
      content: PromptContent
      requestId: string | undefined
      whenIdle?: 'reject'
      /** Guarded mutation commit-point atomic re-check payload (omitted for normal submissions). */
      mutationGuard?: GuardedMutationExpectation
    },
  ): Promise<{ submissionId: string }> {
    const { finalInput, finalWhenBusy, effectiveText, resolvedAttachments, content, mutationGuard } = prepared
    const input: ConversationInput = {
      ...finalInput,
      text: effectiveText,
      whenBusy: finalWhenBusy,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }
    const { submissionId } = await submitDurableInput({
      harness: this.host.harness,
      conversation,
      conversationId: id,
      input,
      whenBusy: finalWhenBusy,
      content,
      requestId: prepared.requestId ?? finalInput.id,
      whenIdle: prepared.whenIdle,
      tracker: this.host.tracker,
      assertMutationGuard:
        mutationGuard !== undefined
          ? () => this.host.assertMutationGuard(id, mutationGuard)
          : undefined,
    })
    return { submissionId }
  }
}
