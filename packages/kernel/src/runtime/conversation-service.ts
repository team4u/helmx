/**
 * Conversation service: CRUD / paginated details / input submission (submitInput) / in-place overwrite & resend
 * (rewrite) / fork / reset / compact / model inheritance alignment / attachment content assembly.
 *
 * Extracted from runtime.ts (splitting the largest responsibility cluster out of an oversized class). External behavior
 * matches the original KernelRuntime methods identically; delegates history rewrites, context operations,
 * attachment resolution, detail pagination, profile alignment, lifecycle CRUD, submission tracking, and the
 * input pipeline to dedicated submodules.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, Storage } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type {
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationBulkDeleteResponse,
  ConversationDetail,
  ConversationEntry,
  ConversationInit,
  ConversationInputResult,
  ConversationListFilter,
  ConversationOwnership,
  ConversationPatch,
  ConversationSearchOptions,
  ConversationSubmissionInfo,
  ConversationSummary,
  ConversationWithdrawResponse,
  GuardedMutationExpectation,
  HubActivityCounts,
  SearchHit,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { EnvFabric } from '../env/index.js'
import type { ArtifactService as SvcArtifactService, Profile, ProfileService, SecretStash } from '../services/index.js'
import { createKeyedMutex } from '../shared/keyed-mutex.js'
import { completeConversationTextHelper } from './conversation-text.js'
import { readWorkspaceFile, type ConversationFileContent } from './workspace-files.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { requireConv } from './conversation-require.js'
import type { ResolvedModelRef } from './models.js'
import type { HelmxStore } from './store.js'
import {
  ConversationAttachments,
  type PromptContent,
  type ResolvedAttachmentItem,
} from './conversation-attachments.js'
import { ConversationContextOps } from './conversation-context-ops.js'
import { ConversationDetailService } from './conversation-detail.js'
import { ConversationInputPipeline, type SubmitInputOptions } from './conversation-input.js'
import { ConversationLifecycleService } from './conversation-lifecycle.js'
import { ConversationProfileService } from './conversation-profile.js'
import { ConversationRewind, type RewindInterval } from './conversation-rewind.js'
import { ConversationSubmissionService } from './conversation-submissions.js'
import { normalizeConversationSearchInput } from './guards/conversation-guards.js'
import { asConversationId, getSdkConversation, scanSdkConversations } from './sdk-ids.js'
import type { TrustedNodePlatformSource } from './target-cwd.js'

interface ConversationServiceOptions {
  readonly harness: Harness
  readonly storage: Pick<Storage, 'scanConversations'>
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly profilesSvc: ProfileService
  readonly artifactsSvc: SvcArtifactService
  readonly stash: SecretStash
  readonly dataDir: string
  readonly toolDeps: { defaultCwd: string }
  /** Release stale backend cache when conversation target changes (host injects envFabric.evictConversation). */
  readonly evictConversationBase: (conversationId: number) => void
  /** Permanent conversation deletion hook (host cleans up subagent session aliases, etc.). */
  readonly onConversationDeleted?: (conversationId: number) => void
  /** Plugin conversation management guard (deletion protection; host-injected). */
  readonly managedConversations: Map<number, Set<string>>
  /** Cascade-cancel pending asks (on conversation deletion; host injects asks.cancelByConversation). */
  readonly cancelAsksByConversation: (id: number) => Promise<void>
  /** Supersede pending asks before in-place rewrite+resend (host injects asks.listPendingByConversation + cancelAsk). */
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  /** Pending AskDoc IDs for `whenPendingAsk: 'reject'` atomic checks (host injects asks.listPendingByConversation). */
  readonly listPendingAskIds?: (id: number) => string[]
  /** Supersede pending asks when direct human input arrives (host injects idempotent ask settlement). */
  readonly supersedePendingAsks?: (id: number) => Promise<void>
  /** Ownership annotation (host-injected). */
  readonly markOwnership: (id: number, owner: ConversationOwnership) => void
  /** Current ownership lookup (for summary projection). */
  readonly ownershipOf: (id: number) => ConversationOwnership
  /** Input hook pipeline (host HookBridge.runHookChain). */
  readonly runInputHook: (payload: unknown) => Promise<{ action: string; value?: unknown; reason?: string; result?: unknown } | undefined>
  /** Shutdown guard (isClosed). */
  readonly isClosed: () => boolean
  /**
   * Startup lifecycle fact (read-only projection of KernelRuntime.started): set synchronously right after
   * start() completes harness.resume. abortConversationGuarded uses this as a fast-path gate—only paying for a
   * read-only harness.inspect authoritative phase re-check before startup completes (covers the prepare barrier window
   * for persistent markers; manual submissions during autoResume:false pre-startup follow normal abort per authoritative inspect),
   * never maintaining a second mirror state.
   */
  readonly isStarted: () => boolean
  /** Model resolution chain (default model). */
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** Per-model thinking defaults lookup (`config.json.modelThinkingLevels`, keyed by full `'provider/modelId'`). */
  readonly modelThinkingLevelOf: (ref: { provider: string; modelId: string }) => string | undefined
  /** Current Models collection (used to clamp thinking levels to model capabilities). */
  readonly models: () => Models
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** Optional model-reference resolver (`ModelRegistry.resolveModelRef`); dereferences `tier/<id>` into concrete model + tier preset thinking level. */
  readonly resolveModelRef?: (ref: string) => ResolvedModelRef
  /** Disabled-model preflight check (ModelRegistry.assertModelEnabled; rejects selection and submission of disabled models). */
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  /**
   * Trusted node platform source (reported by EnvFabric.registry; defaults to local-only resolution).
   * Used to normalize create/update cwd against the target node platform (see runtime/target-cwd.ts).
   */
  readonly trustedPlatformOf?: TrustedNodePlatformSource
  /** Writability guard (throws fatal storage error or runtime_closed when kernel cannot accept mutations). */
  readonly assertWritable?: () => void
  /** Cross-node execution/file fabric (required for remote readConversationFile). */
  readonly envFabric?: EnvFabric
  /** Disabled-model check (optional for standalone tests; defaults to false). */
  readonly isModelDisabled?: (providerId: string, modelId: string) => boolean
}

export type { ConversationFileContent, SubmitInputOptions }

export class ConversationService {
  private readonly harness: Harness
  private readonly storage: Pick<Storage, 'scanConversations'>
  private readonly store: HelmxStore
  private readonly tracker: ConversationTracker
  private readonly events: EventHub
  private readonly artifactsSvc: SvcArtifactService
  private readonly stash: SecretStash
  private readonly o: ConversationServiceOptions

  private readonly attachments: ConversationAttachments
  private readonly rewind: ConversationRewind
  private readonly contextOps: ConversationContextOps
  private readonly detailOps: ConversationDetailService
  private readonly profileAlignment: ConversationProfileService
  private readonly inputPipeline: ConversationInputPipeline
  private readonly lifecycle: ConversationLifecycleService
  private readonly submissionOps: ConversationSubmissionService
  private readonly mutationMutex = createKeyedMutex<number>()

  private readonly withMutationGate = <T>(id: number, op: () => Promise<T>): Promise<T> =>
    this.mutationMutex.run(id, op)

  private assertWritable(): void {
    this.o.assertWritable?.()
  }

  constructor(options: ConversationServiceOptions) {
    this.o = options
    this.harness = options.harness
    this.storage = options.storage
    this.store = options.store
    this.tracker = options.tracker
    this.events = options.events
    this.artifactsSvc = options.artifactsSvc
    this.stash = options.stash

    this.attachments = new ConversationAttachments({
      store: this.store,
      artifactsSvc: this.artifactsSvc,
      dataDir: options.dataDir,
    })

    this.rewind = new ConversationRewind({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      cancelPendingAsksForRewrite: this.o.cancelPendingAsksForRewrite,
      abortConversation: (id) => this.abortConversation(id),
    })

    this.contextOps = new ConversationContextOps({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      events: this.events,
      stash: this.stash,
      isClosed: this.o.isClosed,
      alignConversationModel: (id) => this.alignConversationModel(id),
      withOwnership: (summary) => this.withOwnership(summary),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
    })

    this.detailOps = new ConversationDetailService({
      harness: this.harness,
      store: this.store,
      stash: this.stash,
      getConversation: (id) => this.getConversation(id),
      collectRewindIntervals: (conv) => this.rewind.collectRewindIntervals(conv),
      ensureContextUsage: (id) => this.tracker.ensureContextUsage(id),
    })

    this.profileAlignment = new ConversationProfileService({
      harness: this.harness,
      store: this.store,
      events: this.events,
      profilesSvc: options.profilesSvc,
      models: this.o.models,
      defaultModel: this.o.defaultModel,
      defaultThinkingLevel: this.o.defaultThinkingLevel,
      modelThinkingLevelOf: this.o.modelThinkingLevelOf,
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      resolveModelRef: this.o.resolveModelRef,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      // Context window and thresholds may change after model/Profile alignment: trigger context usage recalculation.
      scheduleContextUsageRefresh: (id) => this.tracker.scheduleContextUsageRefresh(id),
    })

    this.inputPipeline = new ConversationInputPipeline({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      stash: this.stash,
      runInputHook: this.o.runInputHook,
      resolveAuthorizedAttachments: (convId, ids) => this.attachments.resolveAuthorizedAttachments(convId, ids),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
    })

    this.lifecycle = new ConversationLifecycleService({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      events: this.events,
      artifactsSvc: this.artifactsSvc,
      profileAlignment: this.profileAlignment,
      defaultCwd: this.o.toolDeps.defaultCwd,
      models: this.o.models,
      resolveModelRef: this.o.resolveModelRef,
      assertModelEnabled: this.o.assertModelEnabled,
      trustedPlatformOf: this.o.trustedPlatformOf,
      evictConversationBase: this.o.evictConversationBase,
      onConversationDeleted: this.o.onConversationDeleted,
      managedConversations: this.o.managedConversations,
      cancelAsksByConversation: this.o.cancelAsksByConversation,
      ownershipOf: this.o.ownershipOf,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      withOwnership: (summary) => this.withOwnership(summary),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
      withMutationGate: (id, op) => this.withMutationGate(id, op),
    })

    this.submissionOps = new ConversationSubmissionService({
      harness: this.harness,
      store: this.store,
      tracker: this.tracker,
      stash: this.stash,
      isClosed: this.o.isClosed,
      isStarted: this.o.isStarted,
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
      withMutationGate: (id, op) => this.withMutationGate(id, op),
    })
  }

  // ------------------------------------------------------------------
  // Guarded mutations (kernel-enforced automation invariants)
  // ------------------------------------------------------------------

  /** Boundary validation for guard payload (throws 400 synchronously): expectedOwnership strictly forbids 'human'. */
  private assertGuardShape(guard: GuardedMutationExpectation): void {
    if (typeof guard !== 'object' || guard === null) {
      throw new HelmxError('validation_error', 'guarded mutation requires a guard object', 400)
    }
    if (guard.expectedOwnership !== undefined && guard.expectedOwnership !== 'helmx') {
      throw new HelmxError(
        'validation_error',
        `expectedOwnership only allows 'helmx' (automation invariant forbids human): got ${String(guard.expectedOwnership)}`,
        400,
        { expectedOwnership: guard.expectedOwnership },
      )
    }
    if (
      guard.expectedStateSeq !== undefined &&
      (!Number.isSafeInteger(guard.expectedStateSeq) || guard.expectedStateSeq < 0)
    ) {
      throw new HelmxError(
        'validation_error',
        `expectedStateSeq must be a non-negative safe integer: got ${String(guard.expectedStateSeq)}`,
        400,
        { expectedStateSeq: guard.expectedStateSeq },
      )
    }
  }

  /**
   * Synchronous guard re-check (zero awaits): verifies conversation existence, ownership (always rejects 'human'),
   * and optional CAS watermark. Callers guarantee zero event-loop yields between this check and the irreversible
   * SDK abort/submit call—in single-threaded JS, markOwnership cannot interleave, closing the human-ownership race window.
   */
  assertMutationGuard(id: number, guard: GuardedMutationExpectation): void {
    const ownedBy = this.o.ownershipOf(id)
    if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
      throw new HelmxError(
        'ownership_conflict',
        `conversation ${id} is currently owned by ${ownedBy}${guard.expectedOwnership !== undefined ? ` (expected ${guard.expectedOwnership})` : ''}; refusing automated mutation (human-ownership invariant)`,
        409,
        {
          conversationId: id,
          currentOwnership: ownedBy,
          ...(guard.expectedOwnership !== undefined ? { expectedOwnership: guard.expectedOwnership } : {}),
        },
      )
    }
    if (guard.expectedStateSeq !== undefined) {
      const meta = this.store.getConv(id)
      if (meta === undefined || this.store.isDeleted(id)) {
        throw new HelmxError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
      }
      if (meta.stateChangeSeq !== guard.expectedStateSeq) {
        throw new HelmxError(
          'state_seq_conflict',
          `conversation ${id} authoritative watermark ${meta.stateChangeSeq} does not match expected ${guard.expectedStateSeq} (stale probe snapshot; must not act on newer turn)`,
          409,
          { conversationId: id, currentSeq: meta.stateChangeSeq, expectedSeq: guard.expectedStateSeq },
        )
      }
    }
  }

  async abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.submissionOps.abortConversationGuarded(id, guard)
  }

  async submitInputGuarded(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
    guard: GuardedMutationExpectation = {},
  ): Promise<{ submissionId: string }> {
    this.assertWritable()
    this.assertGuardShape(guard)
    if (opts?.whenIdle !== undefined && opts.whenIdle !== 'reject') {
      throw new HelmxError('validation_error', 'guarded submission whenIdle only allows reject', 400)
    }
    if (opts?.replaceFromEntryId !== undefined) {
      throw new HelmxError(
        'validation_error',
        'automated guarded submission does not support replaceFromEntryId (automation must not rewrite history)',
        400,
        { conversationId: id, replaceFromEntryId: opts.replaceFromEntryId },
      )
    }
    this.contextOps.assertOpen()
    this.assertMutationGuard(id, guard)
    return this.submitInput(id, text, { ...opts, mutationGuard: guard })
  }

  // ------------------------------------------------------------------
  // Summary, ownership, and queries
  // ------------------------------------------------------------------

  summaryWithOwnership(id: number): ConversationSummary {
    return { ...this.tracker.summaryOf(id), ownedBy: this.o.ownershipOf(id) }
  }

  withOwnership(summary: ConversationSummary): ConversationSummary {
    return { ...summary, ownedBy: this.o.ownershipOf(summary.id) }
  }

  activitySnapshot(): HubActivityCounts {
    return this.tracker.activitySnapshot()
  }

  onActivityBusyEntered(listener: () => void): () => void {
    return this.tracker.onActivityBusyEntered(listener)
  }

  listConversations(filter?: ConversationListFilter): ConversationSummary[] {
    return this.store
      .listConvs()
      .map((meta) => this.summaryWithOwnership(meta.id))
      .filter((s) => (filter?.profileId ? s.profileId === filter.profileId : true))
      .filter((s) => (filter?.tag ? s.tags.includes(filter.tag) : true))
      .filter((s) => (filter?.status ? s.status === filter.status : true))
      .filter((s) => (filter?.ownedBy ? (s.ownedBy ?? 'human') === filter.ownedBy : true))
      .filter((s) =>
        filter?.parentConversationId !== undefined
          ? s.parentConversationId === filter.parentConversationId
          : true,
      )
      .filter((s) => (filter?.topLevelOnly ? s.parentConversationId === undefined : true))
  }

  getConversation(id: number): ConversationSummary {
    requireConv(this.store, id)
    return this.summaryWithOwnership(id)
  }

  // ------------------------------------------------------------------
  // Detail pagination & FTS rebuild (delegated to detailOps)
  // ------------------------------------------------------------------

  async getConversationDetail(
    id: number,
    options?: { limit?: number; turns?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    return this.detailOps.getConversationDetail(id, options)
  }

  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    return this.detailOps.getConversationEntry(id, entryId)
  }

  async getConversationSubmission(
    id: number,
    requestId: string,
  ): Promise<ConversationSubmissionInfo | undefined> {
    this.contextOps.assertOpen()
    return this.submissionOps.getConversationSubmission(id, requestId)
  }

  async collectRewindIntervals(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    return this.rewind.collectRewindIntervals(conversation)
  }

  async rebuildFts(
    listConversationIds: () => Array<{ id: number; title: string }> = () =>
      this.listConversations().map((c) => ({ id: c.id, title: c.title })),
  ): Promise<void> {
    this.assertWritable()
    return this.detailOps.rebuildFts(listConversationIds)
  }

  // ------------------------------------------------------------------
  // Profile / model inheritance chain (delegated to profileAlignment)
  // ------------------------------------------------------------------

  async readProfile(profileId: string): Promise<Profile | undefined> {
    return this.profileAlignment.readProfile(profileId)
  }

  async resolveEffectiveModelDetails(
    override: string | undefined,
    profileId: string,
  ): Promise<ResolvedModelRef | undefined> {
    return this.profileAlignment.resolveEffectiveModelDetails(override, profileId)
  }

  async resolveEffectiveModel(override: string | undefined, profileId: string): Promise<string | undefined> {
    return this.profileAlignment.resolveEffectiveModel(override, profileId)
  }

  async resolveEffectiveThinkingLevel(
    override: string | undefined,
    profileId: string,
    modelRef?: { provider: string; modelId: string },
    tierThinkingLevel?: string,
  ): Promise<string | undefined> {
    return this.profileAlignment.resolveEffectiveThinkingLevel(override, profileId, modelRef, tierThinkingLevel)
  }

  async alignConversationModel(
    id: number,
    emitEvent = false,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ): Promise<void> {
    return this.profileAlignment.alignConversationModel(id, emitEvent, profileCache)
  }

  async alignAllConversations(): Promise<void> {
    return this.profileAlignment.alignAllConversations()
  }

  async alignProfileConversations(profileId: string): Promise<void> {
    this.assertWritable()
    return this.profileAlignment.alignProfileConversations(profileId)
  }

  // ------------------------------------------------------------------
  // CRUD & cascade deletion (delegated to lifecycle)
  // ------------------------------------------------------------------

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    this.assertWritable()
    return this.lifecycle.createConversation(init)
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    this.assertWritable()
    return this.profileAlignment.withConversationChange(id, () =>
      this.lifecycle.updateConversationConfiguration(id, patch),
    )
  }

  async updateConversationGuarded(
    id: number,
    patch: ConversationPatch,
    guard: GuardedMutationExpectation = {},
  ): Promise<ConversationSummary> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, () =>
      this.profileAlignment.withConversationChange(id, () =>
        this.lifecycle.updateConversationConfiguration(id, patch, guard),
      ),
    )
  }

  async deleteConversation(id: number): Promise<void> {
    this.assertWritable()
    return this.lifecycle.deleteConversation(id)
  }

  async deleteConversationGuarded(
    id: number,
    guard: GuardedMutationExpectation = {},
    opts: { allowActive?: boolean } = {},
  ): Promise<void> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.lifecycle.deleteConversationGuarded(id, guard, opts)
  }

  async deleteConversations(ids: readonly number[]): Promise<ConversationBulkDeleteResponse> {
    this.assertWritable()
    return this.lifecycle.deleteConversations(ids)
  }

  // ------------------------------------------------------------------
  // Artifact authorization and attachments (delegated to attachments)
  // ------------------------------------------------------------------

  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    return this.attachments.isArtifactAuthorized(conversationId, artifactConversationId)
  }

  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>> {
    return this.attachments.resolveAuthorizedAttachments(conversationId, attachmentIds)
  }

  async createArtifact(
    conversationId: number,
    input: { name: string; bytes: Uint8Array; mimeType?: string },
  ): Promise<ArtifactMetadata> {
    this.assertWritable()
    this.contextOps.assertOpen()
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new HelmxError(
        'validation_error',
        `invalid conversationId: ${String(conversationId)}`,
        400,
        { conversationId },
      )
    }
    const exists = (id: number): boolean =>
      this.store.getConv(id) !== undefined && !this.store.isDeleted(id)
    if (!exists(conversationId)) {
      throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404, {
        conversationId,
      })
    }
    return this.artifactsSvc.writeUploaded(conversationId, input, { conversationExists: exists })
  }

  async readAuthorizedArtifact(
    conversationId: number,
    artifactId: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Uint8Array }> {
    return this.attachments.readAuthorizedArtifact(conversationId, artifactId)
  }

  buildAttachmentBlock(resolved: ReadonlyArray<ResolvedAttachmentItem>): string {
    return this.attachments.buildAttachmentBlock(resolved)
  }

  async buildAttachmentContent(
    effectiveText: string,
    resolved: ReadonlyArray<ResolvedAttachmentItem>,
    options?: { suffixText?: string },
  ): Promise<PromptContent> {
    return this.attachments.buildAttachmentContent(effectiveText, resolved, options)
  }

  // ------------------------------------------------------------------
  // submitInput / waitForInput / withdraw / abort
  // ------------------------------------------------------------------

  private assertNoPendingAsks(id: number): void {
    const pendingAskIds =
      this.o.listPendingAskIds !== undefined
        ? this.o.listPendingAskIds(id)
        : this.store.listAsksByConversation(id, 'pending').map((ask) => ask.id)
    if (pendingAskIds.length > 0) {
      throw new HelmxError(
        'ask_pending',
        `conversation ${id} has ${pendingAskIds.length} pending AskDoc(s); rejecting submission (whenPendingAsk=reject)`,
        409,
        { conversationId: id, pendingAskIds },
      )
    }
  }

  async submitInput(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
  ): Promise<{ submissionId: string }> {
    this.assertWritable()
    this.contextOps.assertOpen()
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
    const convMeta = requireConv(this.store, id)
    const conversation = await getSdkConversation(this.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)

    if (opts?.requestId !== undefined) {
      if (typeof opts.requestId !== 'string' || opts.requestId.trim() === '') {
        throw new HelmxError('validation_error', 'internal requestId must be a non-empty string', 400)
      }
      const reqId = opts.requestId
      const previous = await this.harness.commit(
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

    const effectiveModelRef = await this.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmxError(
        'model_not_configured',
        `no model configured for conversation ${id} (profile ${convMeta.profileId}) or globally: configure a model on the Profile, HELMX_MODEL, config.json.model, or conversation`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    {
      const effectiveRef = this.o.parseModelRefOrThrow(effectiveModelRef)
      this.o.assertModelEnabled(effectiveRef.provider, effectiveRef.modelId)
    }

    // Fast pre-check before async rewind validation, attachment IO, and input hooks.
    if (opts?.whenPendingAsk === 'reject') {
      this.assertNoPendingAsks(id)
    }

    const replaceFromEntryId = await this.rewind.validateReplaceTarget(conversation, id, opts?.replaceFromEntryId)
    const initialAttachments =
      opts?.attachments !== undefined && opts.attachments.length > 0
        ? await this.resolveAuthorizedAttachments(id, opts.attachments)
        : undefined
    const prepared = await this.inputPipeline.prepareInput(id, text, opts, initialAttachments)
    if (opts?.mutationGuard !== undefined) {
      this.assertMutationGuard(id, opts.mutationGuard)
    }
    if (prepared.kind === 'handled') return { submissionId: prepared.submissionId }
    if (prepared.finalWhenPendingAsk === 'reject') {
      this.assertNoPendingAsks(id)
    }

    this.contextOps.assertOpen()

    const content =
      prepared.resolvedAttachments !== undefined
        ? await this.buildAttachmentContent(prepared.effectiveText, prepared.resolvedAttachments)
        : prepared.effectiveText

    if (replaceFromEntryId !== undefined) {
      const finalInput = { ...prepared.finalInput, whenBusy: 'reject' as const }
      const targetId = replaceFromEntryId
      const assertPendingAsk =
        prepared.finalWhenPendingAsk === 'reject' ? () => this.assertNoPendingAsks(id) : undefined
      return this.rewind.withHistoryEdit(id, async () => {
        assertPendingAsk?.()
        await this.rewind.assertTargetStillCurrent(conversation, id, targetId)
        assertPendingAsk?.()
        if (assertPendingAsk === undefined) {
          // Re-read metadata after prepareInput so mutations performed by onInput hooks (e.g. tags) are preserved.
          this.inputPipeline.applyFirstInputTitle(requireConv(this.store, id), prepared.effectiveText)
        }
        const result = await this.rewind.rewriteConversationFrom(
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
          const latestMeta = this.store.getConv(id)
          if (latestMeta !== undefined && !this.store.isDeleted(id)) {
            this.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
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
      return this.withMutationGate(id, async () => {
        const result = await this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
        const latestMeta = this.store.getConv(id)
        if (latestMeta !== undefined && !this.store.isDeleted(id)) {
          this.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
        }
        return result
      })
    }
    if (assertPendingAsk !== undefined) {
      // Re-check before commit and again synchronously at commit point via assertBeforeCommit;
      // defer title derivation until after commit succeeds so 409 ask_pending leaves zero side effects.
      assertPendingAsk()
      const submitted = await this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
      const latestMeta = this.store.getConv(id)
      if (latestMeta !== undefined && !this.store.isDeleted(id)) {
        this.inputPipeline.applyFirstInputTitle(latestMeta, prepared.effectiveText)
      }
      return submitted
    }
    // Re-read metadata after prepareInput so mutations performed by onInput hooks (e.g. tags) are preserved.
    this.inputPipeline.applyFirstInputTitle(requireConv(this.store, id), prepared.effectiveText)
    const submitted = await this.inputPipeline.submitFreshInput(conversation, id, freshSubmission)
    if (prepared.finalInput.origin === 'human' && prepared.finalWhenBusy !== 'reject') {
      await this.o.supersedePendingAsks?.(id)
    }
    return submitted
  }

  async waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> {
    return this.submissionOps.waitForInput(id, submissionId, signal)
  }

  async withdrawQueuedInput(id: number, opts: { submissionId: number }): Promise<ConversationWithdrawResponse> {
    this.assertWritable()
    return this.submissionOps.withdrawQueuedInputInternal(id, opts)
  }

  async withdrawQueuedInputGuarded(
    id: number,
    opts: { submissionId: number },
    guard: GuardedMutationExpectation = {},
  ): Promise<ConversationWithdrawResponse> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, () => this.submissionOps.withdrawQueuedInputInternal(id, opts, guard))
  }

  async abortConversation(id: number): Promise<void> {
    this.assertWritable()
    return this.submissionOps.abortConversation(id)
  }

  // ------------------------------------------------------------------
  // reset / compact / fork (delegated to contextOps)
  // ------------------------------------------------------------------

  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertWritable()
    return this.contextOps.resetConversation(id, opts)
  }

  async resetConversationGuarded(
    id: number,
    opts?: { handoff?: string },
    guard: GuardedMutationExpectation = {},
  ): Promise<ConversationSummary> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, () => this.contextOps.resetConversation(id, opts, guard))
  }

  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertWritable()
    return this.contextOps.compactConversation(id, opts)
  }

  async compactConversationGuarded(
    id: number,
    opts?: { instructions?: string },
    guard: GuardedMutationExpectation = {},
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertWritable()
    this.assertGuardShape(guard)
    return this.withMutationGate(id, () => this.contextOps.compactConversation(id, opts, guard))
  }

  async forkConversation(
    id: number,
    opts?: {
      entryId?: number
      title?: string
      parentConversationId?: number
      ownedBy?: ConversationOwnership
    },
  ): Promise<ConversationSummary> {
    this.assertWritable()
    return this.contextOps.forkConversation(id, opts)
  }

  // ------------------------------------------------------------------
  // waitForIdle / getLastAssistantText / search / recover
  // ------------------------------------------------------------------

  async waitForIdle(id: number): Promise<void> {
    const conversation = await getSdkConversation(this.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    await this.tracker.waitTurnSettled(id)
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.tracker.getLastAssistantText(id) ?? ''
  }

  async search(query: string, options?: ConversationSearchOptions): Promise<SearchHit[]> {
    const normalized = normalizeConversationSearchInput(query, options)
    return this.store.search(normalized.query, normalized.options)
  }

  async readConversationFile(
    id: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<ConversationFileContent> {
    if (!this.o.envFabric) {
      throw new HelmxError('internal_error', 'EnvFabric is not configured on ConversationService', 500)
    }
    const summary = this.getConversation(id)
    return readWorkspaceFile({
      nodeId: summary.nodeId ?? 'local',
      cwd: summary.cwd,
      rawPath: path,
      envFabric: this.o.envFabric,
      redact: (text) => this.stash.redact(text),
      signal,
    })
  }

  async completeConversationText(input: {
    conversationId: number
    model?: string
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string> {
    return completeConversationTextHelper(
      {
        store: this.store,
        conversations: this,
        models: {
          models: this.o.models(),
          isModelDisabled: this.o.isModelDisabled ?? (() => false),
          resolveModelRef: this.o.resolveModelRef,
        },
        stash: this.stash,
      },
      input,
    )
  }

  async recover(
    onMissingMirror: (id: number, parentConversationId: number | undefined) => Promise<void>,
  ): Promise<{ deferredTierAlignment: boolean }> {
    const batchProfiles = new Map<string, Promise<Profile | undefined>>()
    let deferredTierAlignment = false
    let cursor: unknown = undefined
    for (;;) {
      const page = await scanSdkConversations(this.storage, 500, cursor, BACKGROUND_CONTEXT)
      for (const record of page.items) {
        const id = Number(record.id)
        if (this.store.isDeleted(id)) continue
        if (!this.store.getConv(id)) {
          await onMissingMirror(id, record.parent?.conversationId)
        }
        try {
          await this.alignConversationModel(id, false, batchProfiles)
        } catch (err) {
          if (!(err instanceof HelmxError && err.code === 'model_tier_not_found')) throw err
          deferredTierAlignment = true
        }
        await this.tracker.observe(id)
      }
      if (!page.next) break
      cursor = page.next
    }
    return { deferredTierAlignment }
  }
}
