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
  InputOrigin,
  WhenBusy,
  WhenPendingAsk,
} from '@helmx/protocol'
import { HelmxError, isPlainObject } from '@helmx/protocol'
import { randomUUID } from 'node:crypto'
import { redactJsonValue } from '../redact.js'
import type { SecretStash } from '../services/index.js'
import { deriveTitle, type ConversationTracker } from './conversations.js'
import { asConversationId, getSdkSubmission } from './sdk-ids.js'
import type { PromptContent } from './conversation-attachments.js'
import type { ConvMeta, HelmxStore } from './store.js'

/** Optional parameters for input submission (shared shape across HTTP/CLI/internal). */
export interface SubmitInputOptions {
  origin?: InputOrigin
  whenBusy?: WhenBusy
  whenPendingAsk?: WhenPendingAsk
  /** @internal Guarded submissions may ask the SDK to atomically reject idle conversations; never exposed on HTTP/CLI. */
  whenIdle?: 'reject'
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  /** One-turn runtime model override (`'provider/modelId'` or `'tier/<id>'`); auto-resets to baseline when this run ends. */
  model?: string
  /** One-turn runtime thinking level override; auto-resets to baseline when this run ends. */
  thinkingLevel?: string
  /** Internal durable idempotency key for completion callbacks; never exposed on HTTP input. */
  requestId?: string
  /**
   * @internal Kernel guarded mutation channel (injected by submitInputGuarded; never exposed on host API
   * or HTTP/CLI): synchronously re-checks ownership and watermark at commit point (right before SDK submit after the last await),
   * failing 409/404 with zero submission side effects.
   */
  mutationGuard?: GuardedMutationExpectation
}

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
      ...(input.whenPendingAsk !== undefined ? { whenPendingAsk: input.whenPendingAsk } : {}),
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
    const submission = await getSdkSubmission(harness, queueResult.submissionId, BACKGROUND_CONTEXT)
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
      finalWhenPendingAsk?: WhenPendingAsk
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
        ...(opts?.whenPendingAsk !== undefined ? { whenPendingAsk: opts.whenPendingAsk } : {}),
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
    let finalWhenPendingAsk: WhenPendingAsk | undefined = opts?.whenPendingAsk
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as Partial<typeof payload> | null | undefined
      if (!isPlainObject(value) || !isPlainObject(value.input)) {
        throw new HelmxError(
          'invalid_hook_result',
          'input hook transform value must be an object with { conversationId, input }',
          500,
        )
      }
      if (value.conversationId !== id) {
        throw new HelmxError(
          'input_identity_changed',
          `input hook must not change conversationId (${id} -> ${String(value.conversationId)})`,
          400,
        )
      }
      finalInput = value.input as ConversationInput
      if (finalInput.attachments !== undefined) {
        assertValidInputAttachments(finalInput.attachments)
      }
      finalWhenBusy = finalInput.whenBusy ?? finalWhenBusy
      finalWhenPendingAsk = finalInput.whenPendingAsk ?? finalWhenPendingAsk
      if (
        finalWhenPendingAsk !== undefined &&
        finalWhenPendingAsk !== 'supersede' &&
        finalWhenPendingAsk !== 'reject'
      ) {
        throw new HelmxError(
          'invalid_hook_result',
          'input hook transform field whenPendingAsk must be supersede|reject',
          500,
        )
      }
    }
    finalWhenBusy = finalWhenBusy ?? 'steer'
    const cleanInput = { ...finalInput }
    if (finalWhenPendingAsk === undefined) {
      delete cleanInput.whenPendingAsk
    }
    finalInput = {
      ...cleanInput,
      whenBusy: finalWhenBusy,
      ...(finalWhenPendingAsk !== undefined ? { whenPendingAsk: finalWhenPendingAsk } : {}),
    }
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
    return {
      kind: 'final',
      finalInput,
      finalWhenBusy,
      ...(finalWhenPendingAsk !== undefined ? { finalWhenPendingAsk } : {}),
      effectiveText,
      resolvedAttachments,
    }
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
      /** Additional synchronous commit-point assertion (e.g. whenPendingAsk=reject). */
      assertBeforeCommit?: () => void
    },
  ): Promise<{ submissionId: string }> {
    const { finalInput, finalWhenBusy, effectiveText, resolvedAttachments, content, mutationGuard, assertBeforeCommit } = prepared
    const input: ConversationInput = {
      ...finalInput,
      text: effectiveText,
      whenBusy: finalWhenBusy,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }
    const assertGuard =
      mutationGuard !== undefined || assertBeforeCommit !== undefined
        ? () => {
            if (mutationGuard !== undefined) {
              this.host.assertMutationGuard(id, mutationGuard)
            }
            assertBeforeCommit?.()
          }
        : undefined
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
      assertMutationGuard: assertGuard,
    })
    return { submissionId }
  }
}

/** Defense-in-depth boundary check for hook-transformed `input.attachments` before mapping/re-authorizing IDs. */
function assertValidInputAttachments(attachments: unknown): asserts attachments is ConversationAttachmentRef[] {
  if (!Array.isArray(attachments)) {
    throw new HelmxError(
      'invalid_hook_result',
      'input hook transform field attachments must be an array of ConversationAttachmentRef objects',
      500,
    )
  }
  for (const item of attachments) {
    if (
      !isPlainObject(item) ||
      typeof item.id !== 'string' ||
      item.id.trim().length === 0 ||
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      typeof item.mimeType !== 'string' ||
      item.mimeType.length === 0 ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    ) {
      throw new HelmxError(
        'invalid_hook_result',
        'input hook transform field attachments contains an invalid ConversationAttachmentRef entry',
        500,
      )
    }
  }
}

export function normalizeBusyError(error: unknown): unknown {
  const name = (error as { name?: string })?.name
  if (name === 'ConversationBusy') {
    return new HelmxError('conversation_busy', 'Conversation is busy and whenBusy=reject was specified', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmxError('conversation_idle', 'Conversation is idle and conflicts with whenIdle=reject', 409)
  }
  return error
}
