/**
 * Conversation CRUD, model/cwd configuration updates, and cascade subtree deletion.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type {
  ConversationBulkDeleteFailure,
  ConversationBulkDeleteResponse,
  ConversationInit,
  ConversationPatch,
  ConversationSummary,
  GuardedMutationExpectation,
} from '@helmx/protocol'
import { HelmxError, MODEL_TIER_PREFIX, isValidNodeId, NODE_ID_PATTERN } from '@helmx/protocol'
import type { ArtifactService as SvcArtifactService, Profile } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import type { ConversationOwnership } from './runtime-ownership.js'
import { requireConv } from './conversation-require.js'
import { assertGuardedMutationTarget } from './conversation-service/guarded-mutations.js'
import { parseModelRefOrThrow } from './model-config-helpers.js'
import {
  THINKING_LEVELS,
  clampThinkingLevelForModel,
  type ModelRefResolutionMode,
  type ResolvedModelRef,
} from './models.js'
import type { ConversationProfileService } from './conversation-profile.js'
import { asSdkThinkingLevel, getSdkConversation } from './sdk-ids.js'
import type { ConvMeta, HelmxStore } from './store.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric, type TrustedNodePlatformSource } from './target-cwd.js'

export interface ConversationLifecycleHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly artifactsSvc: SvcArtifactService
  readonly profileAlignment: ConversationProfileService
  readonly defaultCwd: string
  readonly models: () => Models
  readonly resolveModelRef?: (ref: string, opts?: { mode?: ModelRefResolutionMode }) => ResolvedModelRef
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  readonly trustedPlatformOf?: TrustedNodePlatformSource
  readonly evictConversationBase: (conversationId: number) => void
  readonly onConversationDeleted?: (conversationId: number) => void
  readonly managedConversations: Map<number, Set<string>>
  readonly cancelAsksByConversation: (id: number) => Promise<void>
  readonly ownershipOf: (id: number) => ConversationOwnership
  readonly summaryWithOwnership: (id: number) => ConversationSummary
  readonly withOwnership: (summary: ConversationSummary) => ConversationSummary
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
  readonly withMutationGate: <T>(id: number, op: () => Promise<T>) => Promise<T>
}

export class ConversationLifecycleService {
  constructor(private readonly host: ConversationLifecycleHost) {}

  private async resolveProfileForCreate(init: ConversationInit): Promise<string> {
    const requested = init.profileId ?? 'assistant'
    const found = await this.host.profileAlignment.readProfile(requested)
    if (!found) {
      throw new HelmxError('validation_error', `profile not found: ${requested} (create profiles/${requested} first)`, 400)
    }
    return requested
  }

  private assertResolvedModelEnabled(resolved: ResolvedModelRef): void {
    if (resolved.tierId !== undefined) {
      this.host.assertModelEnabled(MODEL_TIER_PREFIX, resolved.tierId)
      return
    }
    this.host.assertModelEnabled(resolved.provider, resolved.modelId)
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    if (init.ownedBy !== undefined && init.ownedBy !== 'human' && init.ownedBy !== 'helmx') {
      throw new HelmxError(
        'validation_error',
        `invalid conversation ownership: expected 'human' | 'helmx', got ${String(init.ownedBy)}`,
        400,
        { ownedBy: init.ownedBy },
      )
    }
    if (init.tags !== undefined && (!Array.isArray(init.tags) || init.tags.some((t) => typeof t !== 'string'))) {
      throw new HelmxError(
        'validation_error',
        'conversation tags must be a string array',
        400,
      )
    }
    const profileId = await this.resolveProfileForCreate(init)
    const profile = await this.host.profileAlignment.readProfile(profileId)
    const parentMeta =
      init.parentConversationId !== undefined ? this.host.store.getConv(init.parentConversationId) : undefined
    const effectiveOwnedBy: ConversationOwnership =
      init.ownedBy ??
      (parentMeta !== undefined && !this.host.store.isDeleted(parentMeta.id) && parentMeta.ownedBy === 'helmx'
        ? 'helmx'
        : 'human')
    const isTopLevelHuman = init.parentConversationId === undefined && effectiveOwnedBy === 'human'
    const explicitMode: ModelRefResolutionMode = isTopLevelHuman ? 'human_conversation' : 'single_only'
    const inheritMode: ModelRefResolutionMode = isTopLevelHuman ? 'human_conversation' : 'subagent_inherit'
    let frozenModelOverride: string | undefined
    let initTierThinking: string | undefined
    if (init.model !== undefined && init.model !== '') {
      const resolvedInit = this.host.profileAlignment.resolveRef(init.model, explicitMode)
      this.assertResolvedModelEnabled(resolvedInit)
      // Freeze concrete `'provider/modelId'` on single/non-orchestrator conversations so later tier edits or
      // plugin disables never break in-flight conversations or bust prompt caches. Dual-phase orchestrator
      // tiers retain symbolic `'tier/<id>'` on top-level human conversations for runtime planner/executor routing.
      frozenModelOverride =
        resolvedInit.isOrchestratorTier && resolvedInit.tierId !== undefined
          ? `${MODEL_TIER_PREFIX}/${resolvedInit.tierId}`
          : resolvedInit.canonicalRef
      initTierThinking = resolvedInit.isOrchestratorTier ? undefined : resolvedInit.tierThinkingLevel
    }
    const effectiveDetails = await this.host.profileAlignment.resolveEffectiveModelDetails(
      frozenModelOverride,
      profileId,
      undefined,
      inheritMode,
    )
    const modelTier =
      effectiveDetails?.isOrchestratorTier && effectiveDetails.tierId !== undefined
        ? `${MODEL_TIER_PREFIX}/${effectiveDetails.tierId}`
        : undefined
    const effectiveModel = effectiveDetails?.canonicalRef
    const effectiveRef = effectiveDetails
      ? { provider: effectiveDetails.provider, modelId: effectiveDetails.modelId }
      : undefined
    if (init.nodeId !== undefined && !isValidNodeId(init.nodeId)) {
      throw new HelmxError(
        'validation_error',
        `nodeId must match ${NODE_ID_PATTERN} (received ${String(init.nodeId)})`,
        400,
        { nodeId: init.nodeId },
      )
    }
    const nodeId = init.nodeId ?? profile?.nodeId ?? parentMeta?.nodeId ?? 'local'
    const effectiveCwd = this.resolveInitialCwd(init, nodeId, profile, parentMeta)
    const clampedTierThinkingOverride =
      initTierThinking !== undefined
        ? clampThinkingLevelForModel(this.host.models(), effectiveRef, initTierThinking)
        : undefined
    const effectiveThinking = await this.host.profileAlignment.resolveEffectiveThinkingLevel(
      clampedTierThinkingOverride,
      profileId,
      effectiveRef,
      initTierThinking ?? effectiveDetails?.tierThinkingLevel,
    )
    const sdkThinking = asSdkThinkingLevel(effectiveThinking)
    const conv = await this.host.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          cwd: effectiveCwd,
          ...(effectiveRef ? { model: { provider: effectiveRef.provider, modelId: effectiveRef.modelId } } : {}),
          ...(sdkThinking ? { thinkingLevel: sdkThinking } : {}),
        },
      },
      BACKGROUND_CONTEXT,
    )
    const id = Number(conv.id)
    const now = Date.now()
    this.host.store.upsertConv({
      id,
      title: init.title ?? '',
      profileId,
      tags: init.tags ?? [],
      parentConversationId: init.parentConversationId,
      ownedBy: effectiveOwnedBy,
      nodeId,
      cwd: effectiveCwd,
      model: effectiveModel ?? '',
      thinkingLevel: effectiveThinking ?? '',
      ...(frozenModelOverride !== undefined ? { modelOverride: frozenModelOverride } : {}),
      ...(modelTier !== undefined ? { modelTier } : {}),
      ...(clampedTierThinkingOverride !== undefined && clampedTierThinkingOverride !== ''
        ? { thinkingLevelOverride: clampedTierThinkingOverride }
        : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      runDurationMs: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.host.tracker.observe(id)
    const summary = this.host.summaryWithOwnership(id)
    this.host.events.publish('conversation.upsert', summary)
    return summary
  }

  private resolveInitialCwd(
    init: ConversationInit,
    nodeId: string,
    profile: Profile | undefined,
    parentMeta: ConvMeta | undefined,
  ): string {
    const usableProfileCwd =
      profile !== undefined && (profile.nodeId === undefined || profile.nodeId === nodeId)
        ? profile.cwd
        : undefined
    const usableParentCwd =
      parentMeta !== undefined && (parentMeta.nodeId ?? 'local') === nodeId
        ? parentMeta.cwd
        : undefined
    const inheritedCwd = init.cwd ?? usableProfileCwd ?? usableParentCwd
    const platformSource = this.host.trustedPlatformOf ?? trustedPlatformFromEnvFabric(undefined)
    const normalizeCwd = (raw: string): string =>
      normalizeSessionCwd(raw, { nodeId, trustedPlatform: platformSource, entry: 'conversation.create' })
    if (inheritedCwd !== undefined) return normalizeCwd(inheritedCwd)
    if (nodeId === 'local') return normalizeCwd(this.host.defaultCwd)
    throw new HelmxError(
      'validation_error',
      `conversation targets remote node ${nodeId} without a cwd (Profile.cwd / parent conversation cwd / init.cwd are all unset; blind execution in node default directory is rejected)`,
      400,
      { nodeId },
    )
  }

  async updateConversationConfiguration(
    id: number,
    patch: ConversationPatch,
    guard?: GuardedMutationExpectation,
  ): Promise<ConversationSummary> {
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    const meta = requireConv(this.host.store, id)
    if (patch.profileId !== undefined) {
      const found = await this.host.profileAlignment.readProfile(patch.profileId)
      if (!found) {
        throw new HelmxError('validation_error', `profile not found: ${patch.profileId}`, 400)
      }
    }
    const isTopLevelHuman = meta.parentConversationId === undefined && (meta.ownedBy ?? 'human') === 'human'
    const explicitMode: ModelRefResolutionMode = isTopLevelHuman ? 'human_conversation' : 'single_only'
    const inheritMode: ModelRefResolutionMode = isTopLevelHuman ? 'human_conversation' : 'subagent_inherit'
    let nextOverride: string | undefined
    let patchTierThinking: string | undefined
    if (patch.model === undefined) {
      nextOverride = meta.modelOverride
    } else if (patch.model !== '') {
      const resolvedPatch = this.host.profileAlignment.resolveRef(patch.model, explicitMode)
      this.assertResolvedModelEnabled(resolvedPatch)
      nextOverride =
        resolvedPatch.isOrchestratorTier && resolvedPatch.tierId !== undefined
          ? `${MODEL_TIER_PREFIX}/${resolvedPatch.tierId}`
          : resolvedPatch.canonicalRef
      patchTierThinking = resolvedPatch.isOrchestratorTier ? undefined : resolvedPatch.tierThinkingLevel
    }
    const nextProfileId = patch.profileId ?? meta.profileId
    const effectiveDetails = await this.host.profileAlignment.resolveEffectiveModelDetails(
      nextOverride,
      nextProfileId,
      undefined,
      inheritMode,
    )
    const nextModelTier =
      effectiveDetails?.isOrchestratorTier && effectiveDetails.tierId !== undefined
        ? `${MODEL_TIER_PREFIX}/${effectiveDetails.tierId}`
        : undefined
    const effectiveModel = effectiveDetails?.canonicalRef
    const modelSwitched =
      patch.model !== undefined &&
      ((effectiveModel ?? '') !== meta.model || (nextModelTier ?? undefined) !== (meta.modelTier ?? undefined))
    let nextThinkingOverride: string | undefined
    if (patch.thinkingLevel === undefined) {
      if (patchTierThinking !== undefined) {
        nextThinkingOverride = patchTierThinking
      } else {
        nextThinkingOverride = modelSwitched ? undefined : meta.thinkingLevelOverride
      }
    } else {
      const level = patch.thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmxError(
          'validation_error',
          `invalid thinkingLevel '${level}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinkingOverride = level || undefined
    }
    const effectiveRef = effectiveDetails
      ? { provider: effectiveDetails.provider, modelId: effectiveDetails.modelId }
      : undefined
    const clampedOverride = effectiveRef
      ? clampThinkingLevelForModel(this.host.models(), effectiveRef, nextThinkingOverride)
      : nextThinkingOverride
    const nextThinking = await this.host.profileAlignment.resolveEffectiveThinkingLevel(
      clampedOverride,
      nextProfileId,
      effectiveRef,
      patchTierThinking ?? effectiveDetails?.tierThinkingLevel,
    )
    const nextNodeId = patch.nodeId ?? meta.nodeId
    const cwdToNormalize =
      patch.cwd !== undefined ? patch.cwd : patch.nodeId !== undefined ? meta.cwd : undefined
    const effectivePatchCwd =
      cwdToNormalize === undefined
        ? undefined
        : normalizeSessionCwd(cwdToNormalize, {
            nodeId: nextNodeId,
            trustedPlatform: this.host.trustedPlatformOf ?? trustedPlatformFromEnvFabric(undefined),
            entry: 'conversation.update',
          })
    const configureChange: AgentChange = {
      ...(effectivePatchCwd !== undefined ? { cwd: effectivePatchCwd } : {}),
      model: effectiveRef ?? null,
      thinkingLevel: asSdkThinkingLevel(nextThinking) ?? null,
    }
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    await conversation.configure(configureChange, BACKGROUND_CONTEXT)
    const latest = requireConv(this.host.store, id)
    // Pure UI read/bookmark toggles (unread/pinned) must not advance stateChangeSeq while an AskDoc is
    // pending, otherwise Web foreground unread clearing or sidebar pinning falsely triggers AskDoc CAS superseded.
    // Substantive metadata/scope/execution patches (title/tags/profileId/nodeId/cwd/model/thinkingLevel) still advance it.
    const isReadPinOnlyPatch =
      patch.title === undefined &&
      patch.tags === undefined &&
      patch.model === undefined &&
      patch.thinkingLevel === undefined &&
      patch.profileId === undefined &&
      patch.nodeId === undefined &&
      patch.cwd === undefined
    const hasPendingAsks = this.host.store.countAsksByConversation(id, 'pending') > 0
    const nextStateChangeSeq =
      guard === undefined && hasPendingAsks && isReadPinOnlyPatch
        ? latest.stateChangeSeq
        : latest.stateChangeSeq + 1
    const updated: ConvMeta = {
      ...latest,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.profileId !== undefined ? { profileId: patch.profileId } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
      ...(effectivePatchCwd !== undefined ? { cwd: effectivePatchCwd } : {}),
      model: effectiveModel ?? '',
      modelTier: nextModelTier,
      thinkingLevel: nextThinking ?? '',
      thinkingLevelOverride: clampedOverride,
      ...(nextOverride !== undefined ? { modelOverride: nextOverride } : { modelOverride: undefined }),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
      stateChangeSeq: nextStateChangeSeq,
      updatedAt: Date.now(),
    }
    this.host.store.upsertConv(updated)
    if (patch.nodeId !== undefined || patch.cwd !== undefined) {
      this.host.evictConversationBase(id)
    }
    if (patch.model !== undefined || patch.profileId !== undefined || patch.thinkingLevel !== undefined) {
      this.host.tracker.scheduleContextUsageRefresh(id)
    }
    const summary = this.host.withOwnership(this.host.tracker.summaryOf(id))
    this.host.events.publish('conversation.upsert', summary)
    return summary
  }

  /**
   * Switch a conversation's active runtime SDK model/thinkingLevel without modifying `modelOverride`,
   * `modelTier`, `thinkingLevelOverride`, or advancing `stateChangeSeq` (for dual-phase orchestrator execution).
   */
  async setConversationRuntimeModel(
    id: number,
    target: { model: string; thinkingLevel?: string },
  ): Promise<ConversationSummary> {
    if (
      target === null ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      typeof target.model !== 'string' ||
      target.model.trim() === ''
    ) {
      throw new HelmxError(
        'validation_error',
        'runtime model target must be an object with a non-empty concrete model string',
        400,
      )
    }
    if (this.host.store.countAsksByConversation(id, 'pending') > 0) {
      throw new HelmxError(
        'ask_pending',
        `Cannot switch runtime model on conversation ${id} while an ask is pending`,
        409,
        { conversationId: id },
      )
    }
    const meta = requireConv(this.host.store, id)
    const ref = parseModelRefOrThrow(target.model.trim())
    if (ref.provider === MODEL_TIER_PREFIX) {
      throw new HelmxError(
        'validation_error',
        `Runtime model target must be concrete 'provider/modelId', got '${target.model}'`,
        400,
        { model: target.model },
      )
    }
    if (!this.host.models().getModel(ref.provider, ref.modelId)) {
      throw new HelmxError(
        'model_not_found',
        `Runtime model '${ref.provider}/${ref.modelId}' is not available in the model catalog`,
        404,
        { model: target.model },
      )
    }
    this.host.assertModelEnabled(ref.provider, ref.modelId)

    let nextThinking: string | undefined
    if (target.thinkingLevel === undefined) {
      nextThinking = await this.host.profileAlignment.resolveEffectiveThinkingLevel(undefined, meta.profileId, ref)
    } else if (typeof target.thinkingLevel !== 'string') {
      throw new HelmxError('validation_error', 'thinkingLevel must be a string when provided', 400)
    } else {
      const level = target.thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmxError(
          'validation_error',
          `invalid thinkingLevel '${level}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinking = level === '' ? undefined : clampThinkingLevelForModel(this.host.models(), ref, level)
    }

    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    if (this.host.store.countAsksByConversation(id, 'pending') > 0) {
      throw new HelmxError(
        'ask_pending',
        `Cannot switch runtime model on conversation ${id} while an ask is pending`,
        409,
        { conversationId: id },
      )
    }
    await conversation.configure(
      {
        model: { provider: ref.provider, modelId: ref.modelId },
        thinkingLevel: asSdkThinkingLevel(nextThinking) ?? null,
      },
      BACKGROUND_CONTEXT,
    )

    const latest = requireConv(this.host.store, id)
    const canonicalRef = `${ref.provider}/${ref.modelId}`
    this.host.store.upsertConv({
      ...latest,
      model: canonicalRef,
      thinkingLevel: nextThinking ?? '',
      updatedAt: Date.now(),
    })
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.withOwnership(this.host.tracker.summaryOf(id))
    this.host.events.publish('conversation.upsert', summary)
    return summary
  }

  async deleteConversation(id: number): Promise<void> {
    const subtree = this.collectDeletionSubtree(id)
    this.assertSubtreeUnmanaged(subtree, id)
    for (const target of subtree) await this.deleteOneConversation(target)
  }

  async deleteConversationGuarded(
    id: number,
    guard: GuardedMutationExpectation,
    opts: { allowActive?: boolean },
  ): Promise<void> {
    return this.host.withMutationGate(id, async () => {
      this.host.assertMutationGuard(id, guard)
      const subtree = this.collectDeletionSubtree(id)
      this.assertSubtreeUnmanaged(subtree, id)
      const allowActive = opts.allowActive === true
      for (const nodeId of subtree) {
        const ownedBy = this.host.ownershipOf(nodeId)
        if (ownedBy === 'human' || (guard.expectedOwnership !== undefined && ownedBy !== guard.expectedOwnership)) {
          throw new HelmxError(
            'ownership_conflict',
            `conversation ${id} cannot be deleted automatically: ${
              nodeId === id ? 'it' : `derived conversation ${nodeId}`
            } is currently owned by ${ownedBy}; refusing automated mutation (human-ownership invariant)`,
            409,
            {
              conversationId: nodeId,
              currentOwnership: ownedBy,
              ...(nodeId !== id ? { requestedConversationId: id } : {}),
              ...(guard.expectedOwnership !== undefined ? { expectedOwnership: guard.expectedOwnership } : {}),
            },
          )
        }
        if (!allowActive) {
          const summary = this.host.tracker.summaryOf(nodeId)
          if (summary.status === 'working' || summary.status === 'blocked' || summary.pendingAskCount > 0) {
            throw new HelmxError(
              'conversation_active',
              `conversation ${id} cannot be deleted automatically while ${
                nodeId === id ? 'it' : `derived conversation ${nodeId}`
              } is ${summary.status}${summary.pendingAskCount > 0 ? ` (${summary.pendingAskCount} pending asks)` : ''}`,
              409,
              {
                conversationId: nodeId,
                status: summary.status,
                pendingAskCount: summary.pendingAskCount,
                ...(nodeId !== id ? { requestedConversationId: id } : {}),
              },
            )
          }
        }
      }
      for (const target of subtree) {
        // Derived targets re-check ownership only; the CAS watermark applies to the requested conversation alone.
        // Shared primitive (single source of the red line): conversation-service/guarded-mutations.ts.
        const targetGuard: GuardedMutationExpectation = target === id ? guard : { expectedOwnership: guard.expectedOwnership }
        const assertTargetOwned = (): void =>
          assertGuardedMutationTarget(this.host, target, targetGuard, {
            action: 'deletion',
            ...(target !== id ? { requestedConversationId: id } : {}),
          })
        assertTargetOwned()
        await this.deleteOneConversation(target, assertTargetOwned)
      }
    })
  }

  async deleteConversations(ids: readonly number[]): Promise<ConversationBulkDeleteResponse> {
    const requested = [...new Set(ids)]
    const requestedSet = new Set(requested)
    const settled = new Set<number>()
    const deleted: number[] = []
    const failures: ConversationBulkDeleteFailure[] = []
    for (const id of requested) {
      if (settled.has(id)) {
        deleted.push(id)
        continue
      }
      try {
        const subtree = this.collectDeletionSubtree(id)
        this.assertSubtreeUnmanaged(subtree, id)
        for (const target of subtree) {
          await this.deleteOneConversation(target)
          if (requestedSet.has(target)) settled.add(target)
        }
        deleted.push(id)
      } catch (err) {
        failures.push({
          id,
          code: err instanceof HelmxError ? err.code : 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { deleted, failures }
  }

  private collectDeletionSubtree(id: number): number[] {
    const childrenOf = new Map<number, number[]>()
    for (const meta of this.host.store.listConvs()) {
      const parent = meta.parentConversationId
      if (parent === undefined) continue
      const siblings = childrenOf.get(parent)
      if (siblings === undefined) childrenOf.set(parent, [meta.id])
      else siblings.push(meta.id)
    }
    requireConv(this.host.store, id)
    const ordered: number[] = []
    const walk = (current: number): void => {
      for (const child of childrenOf.get(current) ?? []) walk(child)
      ordered.push(current)
    }
    walk(id)
    return ordered
  }

  private assertSubtreeUnmanaged(subtree: readonly number[], requestedId: number): void {
    for (const nodeId of subtree) {
      const owners = [...(this.host.managedConversations.get(nodeId) ?? [])]
      if (owners.length === 0) continue
      throw new HelmxError(
        'conversation_managed_by_plugin',
        `conversation ${requestedId} cannot be deleted: ${
          nodeId === requestedId ? 'it is currently' : `its derived conversation ${nodeId} is`
        } managed by plugin(s) (${owners.join(', ')}); release management before deleting`,
        409,
        { conversationId: nodeId, owners, ...(nodeId !== requestedId ? { requestedConversationId: requestedId } : {}) },
      )
    }
  }

  private async deleteOneConversation(id: number, assertGuarded?: () => void): Promise<void> {
    requireConv(this.host.store, id)
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    assertGuarded?.()
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    assertGuarded?.()
    await this.host.cancelAsksByConversation(id)
    assertGuarded?.()
    await this.host.artifactsSvc.deleteConversation(id)
    assertGuarded?.()
    this.host.tracker.deleteConversation(id)
    this.host.store.deleteConv(id)
    this.host.evictConversationBase(id)
    this.host.onConversationDeleted?.(id)
    this.host.events.publish('conversation.deleted', { conversationId: id })
  }
}
