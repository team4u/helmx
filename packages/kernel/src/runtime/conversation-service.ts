/**
 * Conversation service: CRUD / paginated details / input submission (submitInput) / in-place overwrite & resend
 * (rewrite) / fork / reset / compact / model inheritance alignment / attachment content assembly.
 *
 * Extracted from runtime.ts (splitting the largest responsibility cluster out of an oversized class). This class is the
 * facade and composition root: it wires the dedicated submodules and exposes the public conversation API unchanged.
 * Submodules: history rewrites, context operations, attachment resolution, detail pagination, profile alignment,
 * lifecycle CRUD, submission tracking and the input pipeline (sibling files), plus — under conversation-service/ —
 * the guarded-mutation primitives (single source of the automation red line), the submitInput orchestration and
 * the startup recovery procedure.
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
import { getSdkConversation } from './sdk-ids.js'
import { ConversationSubmit } from './conversation-service/submit.js'
import { recoverConversations } from './conversation-service/recovery.js'
import { assertGuardedMutationTarget, assertGuardShape } from './conversation-service/guarded-mutations.js'
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
  /** Composition options: shared deps are read through `this.o` instead of being duplicated as fields. */
  private readonly o: ConversationServiceOptions
  private readonly store: HelmxStore
  private readonly tracker: ConversationTracker
  private readonly stash: SecretStash

  private readonly attachments: ConversationAttachments
  private readonly rewind: ConversationRewind
  private readonly contextOps: ConversationContextOps
  private readonly detailOps: ConversationDetailService
  private readonly profileAlignment: ConversationProfileService
  private readonly inputPipeline: ConversationInputPipeline
  private readonly lifecycle: ConversationLifecycleService
  private readonly submissionOps: ConversationSubmissionService
  /** submitInput orchestration (validation, idempotency, hooks, guarded commit paths). */
  private readonly submit: ConversationSubmit
  private readonly mutationMutex = createKeyedMutex<number>()
  /** In-memory transient runtime model/thinking overrides (cleared on run end when `resetOnRunEnd`, config patch, reset, delete, or `null`). */
  private readonly runtimeModelOverrides = new Map<number, { resetOnRunEnd: boolean }>()
  /** Derived symbolic tier references (`'tier/<id>'`) for active conversations (never persisted in SQLite). */
  private readonly effectiveModelRefs = new Map<number, string>()

  private readonly withMutationGate = <T>(id: number, op: () => Promise<T>): Promise<T> =>
    this.mutationMutex.run(id, op)

  private assertWritable(): void {
    this.o.assertWritable?.()
  }

  constructor(options: ConversationServiceOptions) {
    const { harness, store, tracker, events, artifactsSvc, stash } = options
    this.o = options
    this.store = store
    this.tracker = tracker
    this.stash = stash

    this.attachments = new ConversationAttachments({
      store,
      artifactsSvc,
      dataDir: options.dataDir,
    })

    this.rewind = new ConversationRewind({
      harness,
      store,
      tracker,
      cancelPendingAsksForRewrite: this.o.cancelPendingAsksForRewrite,
      abortConversation: (id) => this.abortConversation(id),
    })

    this.profileAlignment = new ConversationProfileService({
      harness,
      store,
      events,
      profilesSvc: options.profilesSvc,
      models: this.o.models,
      defaultModel: this.o.defaultModel,
      defaultThinkingLevel: this.o.defaultThinkingLevel,
      modelThinkingLevelOf: this.o.modelThinkingLevelOf,
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      resolveModelRef: this.o.resolveModelRef,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      hasRuntimeModelOverride: (id) => this.runtimeModelOverrides.has(id),
      getEffectiveModelRef: (id) => this.effectiveModelRefs.get(id),
      setEffectiveModelRef: (id, rawRef) => this.setEffectiveModelRef(id, rawRef),
      // Context window and thresholds may change after model/Profile alignment: trigger context usage recalculation.
      scheduleContextUsageRefresh: (id) => this.tracker.scheduleContextUsageRefresh(id),
    })

    this.contextOps = new ConversationContextOps({
      harness,
      store,
      tracker,
      events,
      stash,
      profileAlignment: this.profileAlignment,
      models: this.o.models,
      assertModelEnabled: this.o.assertModelEnabled,
      isClosed: this.o.isClosed,
      alignConversationModel: (id) => this.alignConversationModel(id),
      hasRuntimeModelOverride: (id) => this.runtimeModelOverrides.has(id),
      clearRuntimeModelOverride: (id) => {
        this.runtimeModelOverrides.delete(id)
      },
      withOwnership: (summary) => this.withOwnership(summary),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
    })

    this.detailOps = new ConversationDetailService({
      harness,
      store,
      stash,
      getConversation: (id) => this.getConversation(id),
      collectRewindIntervals: (conv) => this.rewind.collectRewindIntervals(conv),
      ensureContextUsage: (id) => this.tracker.ensureContextUsage(id),
    })

    this.inputPipeline = new ConversationInputPipeline({
      harness,
      store,
      tracker,
      stash,
      runInputHook: this.o.runInputHook,
      resolveAuthorizedAttachments: (convId, ids) => this.attachments.resolveAuthorizedAttachments(convId, ids),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
    })

    this.lifecycle = new ConversationLifecycleService({
      harness,
      store,
      tracker,
      events,
      artifactsSvc,
      profileAlignment: this.profileAlignment,
      defaultCwd: this.o.toolDeps.defaultCwd,
      models: this.o.models,
      resolveModelRef: this.o.resolveModelRef,
      assertModelEnabled: this.o.assertModelEnabled,
      trustedPlatformOf: this.o.trustedPlatformOf,
      evictConversationBase: this.o.evictConversationBase,
      onConversationDeleted: this.o.onConversationDeleted,
      hasRuntimeModelOverride: (id) => this.runtimeModelOverrides.has(id),
      onSetRuntimeModelOverride: (id, resetOnRunEnd) => {
        this.runtimeModelOverrides.set(id, { resetOnRunEnd })
      },
      onClearRuntimeModelOverride: (id) => {
        this.runtimeModelOverrides.delete(id)
      },
      setEffectiveModelRef: (id, rawRef) => this.setEffectiveModelRef(id, rawRef),
      managedConversations: this.o.managedConversations,
      cancelAsksByConversation: this.o.cancelAsksByConversation,
      ownershipOf: this.o.ownershipOf,
      summaryWithOwnership: (id) => this.summaryWithOwnership(id),
      withOwnership: (summary) => this.withOwnership(summary),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
      withMutationGate: (id, op) => this.withMutationGate(id, op),
    })

    this.submissionOps = new ConversationSubmissionService({
      harness,
      store,
      tracker,
      stash,
      isClosed: this.o.isClosed,
      isStarted: this.o.isStarted,
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
      withMutationGate: (id, op) => this.withMutationGate(id, op),
      hasAutoResetRuntimeModel: (id) => this.hasAutoResetRuntimeModel(id),
      resetRuntimeModelOnRunEnd: (id, gateOpts) => this.resetRuntimeModelOnRunEnd(id, gateOpts),
    })

    this.submit = new ConversationSubmit({
      harness,
      store,
      rewind: this.rewind,
      inputPipeline: this.inputPipeline,
      resolveAuthorizedAttachments: (convId, ids) => this.attachments.resolveAuthorizedAttachments(convId, ids),
      buildAttachmentContent: (effectiveText, resolved, options) =>
        this.attachments.buildAttachmentContent(effectiveText, resolved, options),
      resolveEffectiveModelDetails: (override, profileId) =>
        this.profileAlignment.resolveEffectiveModelDetails(override, profileId),
      resolveModelRef: this.o.resolveModelRef,
      parseModelRefOrThrow: this.o.parseModelRefOrThrow,
      models: this.o.models,
      assertModelEnabled: this.o.assertModelEnabled,
      isConversationBusy: (id) => this.tracker.isConversationBusy(id),
      isCompacting: (id) => this.tracker.isCompacting(id),
      setConversationRuntimeModel: (id, target, gateOpts) =>
        gateOpts?.insideMutationGate
          ? this.applyRuntimeModelOverride(id, target)
          : this.setConversationRuntimeModel(id, target),
      supersedePendingAsks: this.o.supersedePendingAsks,
      listPendingAskIds: this.o.listPendingAskIds,
      assertWritable: () => this.assertWritable(),
      assertOpen: () => this.contextOps.assertOpen(),
      assertMutationGuard: (id, guard) => this.assertMutationGuard(id, guard),
      withMutationGate: (id, op) => this.withMutationGate(id, op),
    })
  }

  // ------------------------------------------------------------------
  // Guarded mutations (kernel-enforced automation invariants)
  // ------------------------------------------------------------------

  /** Boundary validation for guard payload (throws 400 synchronously); single source in guarded-mutations.ts. */
  private assertGuardShape(guard: GuardedMutationExpectation): void {
    assertGuardShape(guard)
  }

  /**
   * Synchronous guard re-check (zero awaits; see assertGuardedMutationTarget): ownership (always rejects 'human')
   * and optional CAS watermark. Callers guarantee zero event-loop yields between this check and the irreversible
   * SDK abort/submit call—in single-threaded JS, markOwnership cannot interleave, closing the human-ownership race window.
   */
  assertMutationGuard(id: number, guard: GuardedMutationExpectation): void {
    assertGuardedMutationTarget(this.o, id, guard, { action: 'mutation' })
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
    return this.withOwnership(this.tracker.summaryOf(id))
  }

  withOwnership(summary: ConversationSummary): ConversationSummary {
    const ownedBy = this.o.ownershipOf(summary.id)
    const hasRuntime = this.runtimeModelOverrides.has(summary.id)
    const effectiveModelRef = this.effectiveModelRefs.get(summary.id)
    let next: ConversationSummary = summary
    if (hasRuntime) {
      if (next.runtimeModelOverride !== true) next = { ...next, runtimeModelOverride: true }
    } else if (next.runtimeModelOverride !== undefined) {
      const { runtimeModelOverride: _dropped, ...rest } = next
      next = rest
    }
    if (effectiveModelRef !== undefined) {
      if (next.effectiveModelRef !== effectiveModelRef) next = { ...next, effectiveModelRef }
    } else if (next.effectiveModelRef !== undefined) {
      const { effectiveModelRef: _droppedRef, ...rest } = next
      next = rest
    }
    return { ...next, ownedBy }
  }

  effectiveModelRefOf(id: number): string | undefined {
    return this.effectiveModelRefs.get(id)
  }

  setEffectiveModelRef(id: number, rawRef: string | undefined): void {
    if (rawRef !== undefined && rawRef.startsWith('tier/')) {
      this.effectiveModelRefs.set(id, rawRef)
    } else {
      this.effectiveModelRefs.delete(id)
    }
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

  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    return this.profileAlignment.resolveEffectiveModel(override, profileId)
  }

  hasRuntimeModelOverride(id: number): boolean {
    return this.runtimeModelOverrides.has(id)
  }

  hasAutoResetRuntimeModel(id: number): boolean {
    return this.runtimeModelOverrides.get(id)?.resetOnRunEnd === true
  }

  private async applyRuntimeModelOverride(
    id: number,
    target: { model: string; thinkingLevel?: string; resetOnRunEnd?: boolean } | null,
  ): Promise<ConversationSummary> {
    return this.profileAlignment.withConversationChange(id, () =>
      this.lifecycle.setConversationRuntimeModel(id, target),
    )
  }

  async setConversationRuntimeModel(
    id: number,
    target: { model: string; thinkingLevel?: string; resetOnRunEnd?: boolean } | null,
  ): Promise<ConversationSummary> {
    this.assertWritable()
    return this.withMutationGate(id, () => this.applyRuntimeModelOverride(id, target))
  }

  async resetRuntimeModelOnRunEnd(
    id: number,
    opts?: { insideMutationGate?: boolean },
  ): Promise<void> {
    if (!this.hasAutoResetRuntimeModel(id)) return
    const meta = this.store.getConv(id)
    if (meta === undefined || this.store.isDeleted(id)) {
      this.runtimeModelOverrides.delete(id)
      return
    }
    if (opts?.insideMutationGate) {
      await this.applyRuntimeModelOverride(id, null)
      return
    }
    await this.setConversationRuntimeModel(id, null)
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
    return this.o.artifactsSvc.writeUploaded(conversationId, input, { conversationExists: exists })
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

  async submitInput(
    id: number,
    text: string,
    opts?: SubmitInputOptions,
  ): Promise<{ submissionId: string }> {
    return this.submit.submitInput(id, text, opts)
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
    const conversation = await getSdkConversation(this.o.harness, id, BACKGROUND_CONTEXT)
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
    return recoverConversations(
      {
        storage: this.o.storage,
        store: this.store,
        alignConversationModel: (id, emitEvent, profileCache) => this.alignConversationModel(id, emitEvent, profileCache),
        tracker: this.tracker,
      },
      onMissingMirror,
    )
  }
}
