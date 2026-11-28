/**
 * Conversation profile and model inheritance chain alignment module.
 *
 * Responsibilities:
 * - Read and validate Profile configurations;
 * - Resolve effective model chain (conversation override > Profile.model > global default);
 * - Resolve effective thinking level chain (conversation override > per-model default > Profile.thinkingLevel > global fallback);
 * - Serialize per-conversation configuration updates (withConversationChange);
 * - Reconcile SDK conversation model/thinkingLevel against store mirror (alignConversationModel);
 * - Cascade inheritance updates after Profile save (alignProfileConversations).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Harness } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helmx/protocol'
import { HelmxError, MODEL_TIER_PREFIX, assertProfileId } from '@helmx/protocol'
import { type Profile, type ProfileService } from '../services/index.js'
import {
  clampThinkingLevelForModel,
  resolveClampedThinkingLevel,
  resolveModelRefWith,
  type ModelRefResolutionMode,
  type ResolvedModelRef,
} from './models.js'
import type { EventHub } from './events.js'
import { getSdkConversation } from './sdk-ids.js'
import type { HelmxStore } from './store.js'
import { createKeyedMutex } from '../shared/keyed-mutex.js'

interface ConversationProfileHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly events: EventHub
  readonly profilesSvc: ProfileService
  /** Current Models collection (for capability clamping; reads latest collection after hot reload). */
  readonly models: () => Models
  readonly defaultModel: () => string | undefined
  readonly defaultThinkingLevel: () => string | undefined
  /** Per-model thinking defaults lookup (`config.json.modelThinkingLevels`, keyed by full `'provider/modelId'`). */
  readonly modelThinkingLevelOf: (ref: { provider: string; modelId: string }) => string | undefined
  readonly parseModelRefOrThrow: (ref: string) => { provider: string; modelId: string }
  /** Optional model-reference resolver (`ModelRegistry.resolveModelRef`); dereferences `tier/<id>` into concrete model + tier preset thinking level. */
  readonly resolveModelRef?: (ref: string, opts?: { mode?: ModelRefResolutionMode }) => ResolvedModelRef
  readonly summaryWithOwnership: (id: number) => ConversationSummary
  /** Live working-state probe; skips overriding active SDK runtime model on working orchestrator conversations during inheritance refreshes. */
  readonly isConversationWorking?: (id: number) => boolean
  /** Schedule context usage recalculation after model/thinking alignment (window/threshold may change); omitted skips. */
  readonly scheduleContextUsageRefresh?: (id: number) => void
}

/** Walk non-deleted ancestor chain to find an active orchestrator `modelTier`, if any. */
export function findActiveOrchestratorTier(
  store: HelmxStore,
  startConversationId: number | undefined,
): string | undefined {
  if (startConversationId === undefined) return undefined
  const visited = new Set<number>()
  let cur: number | undefined = startConversationId
  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur)
    const meta = store.getConv(cur)
    if (meta === undefined || store.isDeleted(meta.id)) return undefined
    if (meta.modelTier !== undefined && meta.modelTier !== '') {
      return meta.modelTier
    }
    cur = meta.parentConversationId
  }
  return undefined
}

export class ConversationProfileService {
  /** Serialize configuration mutations per conversation so inheritance refreshes and explicit overrides do not clobber each other. */
  private readonly conversationChanges = createKeyedMutex<number>()

  constructor(private readonly host: ConversationProfileHost) {}

  /** Report Profile read failures separately from missing profiles so corrupt files aren't mistaken for unconfigured models. */
  async readProfile(
    profileId: string,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ): Promise<Profile | undefined> {
    if (profileCache !== undefined) {
      const cached = profileCache.get(profileId)
      if (cached !== undefined) return cached
      const loading = this.readProfile(profileId)
      profileCache.set(profileId, loading)
      return loading
    }
    try {
      assertProfileId(profileId)
    } catch (error) {
      throw new HelmxError('validation_error', error instanceof Error ? error.message : String(error), 400)
    }
    try {
      return await this.host.profilesSvc.get(profileId)
    } catch (error) {
      throw new HelmxError(
        'profile_read_failed',
        `failed to read Profile ${profileId}: ${error instanceof Error ? error.message : String(error)}`,
        500,
        { profileId },
      )
    }
  }

  /** Resolve a raw `'provider/model'` or `'tier/<id>'` reference into concrete parts + optional tier preset thinking level. */
  resolveRef(ref: string, mode?: ModelRefResolutionMode): ResolvedModelRef {
    return resolveModelRefWith(
      ref,
      this.host.resolveModelRef,
      this.host.parseModelRefOrThrow,
      mode !== undefined ? { mode } : undefined,
    )
  }

  /** Conversation override > Profile.model > global default, dereferencing any `tier/<id>` into concrete model + tier preset thinking level. */
  async resolveEffectiveModelDetails(
    override: string | undefined,
    profileId: string,
    profileCache?: Map<string, Promise<Profile | undefined>>,
    mode: ModelRefResolutionMode = 'human_conversation',
  ): Promise<ResolvedModelRef | undefined> {
    const profile = await this.readProfile(profileId, profileCache)
    if (profile === undefined) {
      throw new HelmxError('profile_not_found', `Profile referenced by conversation does not exist: ${profileId}`, 404, { profileId })
    }
    const raw = override || profile.model || this.host.defaultModel()
    if (!raw) return undefined
    return this.resolveRef(raw, mode)
  }

  /** Conversation override > Profile.model > global default (concrete `'provider/modelId'`); Profile files are read live on each lookup. */
  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
    mode: ModelRefResolutionMode = 'human_conversation',
  ): Promise<string | undefined> {
    return (await this.resolveEffectiveModelDetails(override, profileId, undefined, mode))?.canonicalRef
  }

  /**
   * Thinking level inheritance: conversation override > resolved tier preset > per-model default for the effective model >
   * Profile.thinkingLevel > global fallback; then clamped to levels supported by the effective model
   * (nearest supported level if unsupported).
   * Unconfigured values (undefined / empty string) are returned unchanged rather than coerced into explicit 'off'.
   */
  async resolveEffectiveThinkingLevel(
    override: string | undefined,
    profileId: string,
    modelRef?: { provider: string; modelId: string },
    tierThinkingLevel?: string,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ): Promise<string | undefined> {
    const profile = await this.readProfile(profileId, profileCache)
    if (!profile) throw new HelmxError('profile_not_found', `Profile referenced by conversation does not exist: ${profileId}`, 404, { profileId })
    const perModel = modelRef !== undefined ? this.host.modelThinkingLevelOf(modelRef) : undefined
    return resolveClampedThinkingLevel({
      candidates: [override, tierThinkingLevel, perModel, profile.thinkingLevel, this.host.defaultThinkingLevel()],
      models: this.host.models(),
      modelRef,
    })
  }

  withConversationChange<T>(id: number, change: () => Promise<T>): Promise<T> {
    return this.conversationChanges.run(id, change)
  }

  /** Inherit model and thinking level separately; always reconcile against SDK to heal restarts and historical fork snapshots. */
  async alignConversationModel(
    id: number,
    emitEvent = false,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ): Promise<void> {
    const batchProfiles = profileCache ?? new Map<string, Promise<Profile | undefined>>()
    await this.withConversationChange(id, async () => {
      const meta = this.host.store.getConv(id)
      if (!meta) return
      const isTopLevelHuman = meta.parentConversationId === undefined && (meta.ownedBy ?? 'human') === 'human'
      const mode: ModelRefResolutionMode = isTopLevelHuman ? 'human_conversation' : 'subagent_inherit'
      const resolved = await this.resolveEffectiveModelDetails(meta.modelOverride, meta.profileId, batchProfiles, mode)
      const nextModelTier =
        resolved?.isOrchestratorTier && resolved.tierId !== undefined
          ? `${MODEL_TIER_PREFIX}/${resolved.tierId}`
          : undefined
      if (resolved?.isOrchestratorTier === true && this.host.isConversationWorking?.(id) === true) {
        if ((meta.modelTier ?? undefined) === nextModelTier) return
        const latest = this.host.store.getConv(id)
        if (!latest) return
        this.host.store.upsertConv({
          ...latest,
          modelTier: nextModelTier,
          updatedAt: Date.now(),
        })
        if (emitEvent) this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
        return
      }
      const effective = resolved?.canonicalRef
      const ref = resolved ? { provider: resolved.provider, modelId: resolved.modelId } : undefined
      // Also persist the clamped result of an explicit override; otherwise SDK/summary converge while the mirror keeps
      // the raw override, causing the next alignment pass to still see "effective != override".
      const clampedOverride = clampThinkingLevelForModel(this.host.models(), ref, meta.thinkingLevelOverride)
      const thinking = await this.resolveEffectiveThinkingLevel(
        clampedOverride,
        meta.profileId,
        ref,
        resolved?.tierThinkingLevel,
        batchProfiles,
      )
      const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
      const agent = await conversation.agent(BACKGROUND_CONTEXT)
      const change: AgentChange = {
        ...(agent.model?.provider !== ref?.provider || agent.model?.modelId !== ref?.modelId
          ? { model: ref ?? null } : {}),
        ...(agent.thinkingLevel !== (thinking ?? 'off')
          ? { thinkingLevel: (thinking as ModelThinkingLevel | undefined) ?? null } : {}),
      }
      const sdkChanged = Object.keys(change).length > 0
      if (sdkChanged) await conversation.configure(change, BACKGROUND_CONTEXT)
      if (
        !sdkChanged &&
        meta.model === (effective ?? '') &&
        (meta.modelTier ?? undefined) === nextModelTier &&
        meta.thinkingLevel === (thinking ?? '') &&
        meta.thinkingLevelOverride === clampedOverride
      ) return
      const latest = this.host.store.getConv(id)
      if (!latest) return
      this.host.store.upsertConv({
        ...latest,
        model: effective ?? '',
        modelTier: nextModelTier,
        thinkingLevel: thinking ?? '',
        thinkingLevelOverride: clampedOverride,
        stateChangeSeq: latest.stateChangeSeq + 1,
        updatedAt: Date.now(),
      })
      // Effective model changes also change context window/thresholds: trigger usage recalculation (deduplicated;
      // covers forks and profile cascade refreshes, while initial observe uses adoptInitial as backstop).
      this.host.scheduleContextUsageRefresh?.(id)
      if (emitEvent) this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
    })
  }

  /**
   * Reset runtime SDK model/thinkingLevel back to planner at `afterRun` boundary for orchestrator-tier
   * conversations so queued `followUp` runs never start mid-execution on the executor model.
   * Preserves `modelOverride`, `modelTier`, and `stateChangeSeq` (CAS watermarks stay intact).
   */
  async alignRuntimeModelOnRunEnd(id: number): Promise<void> {
    const initial = this.host.store.getConv(id)
    if (!initial || this.host.store.isDeleted(id)) return
    if (initial.modelTier === undefined || initial.modelTier === '') return
    await this.withConversationChange(id, async () => {
      const meta = this.host.store.getConv(id)
      if (!meta || this.host.store.isDeleted(id)) return
      if (meta.modelTier === undefined || meta.modelTier === '') return
      const isTopLevelHuman = meta.parentConversationId === undefined && (meta.ownedBy ?? 'human') === 'human'
      if (!isTopLevelHuman) return
      let resolved: ResolvedModelRef | undefined
      try {
        resolved = await this.resolveEffectiveModelDetails(
          meta.modelOverride,
          meta.profileId,
          undefined,
          'human_conversation',
        )
      } catch (err) {
        if (err instanceof HelmxError && (err.code === 'model_tier_not_found' || err.code === 'orchestrator_tier_human_only')) {
          return
        }
        throw err
      }
      if (!resolved?.isOrchestratorTier) return
      const ref = { provider: resolved.provider, modelId: resolved.modelId }
      const clampedOverride = clampThinkingLevelForModel(this.host.models(), ref, meta.thinkingLevelOverride)
      const thinking = await this.resolveEffectiveThinkingLevel(
        clampedOverride,
        meta.profileId,
        ref,
        resolved.tierThinkingLevel,
      )
      const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
      if (!conversation) return
      const agent = await conversation.agent(BACKGROUND_CONTEXT)
      const change: AgentChange = {
        ...(agent.model?.provider !== ref.provider || agent.model?.modelId !== ref.modelId
          ? { model: ref }
          : {}),
        ...(agent.thinkingLevel !== (thinking ?? 'off')
          ? { thinkingLevel: (thinking as ModelThinkingLevel | undefined) ?? null }
          : {}),
      }
      const sdkChanged = Object.keys(change).length > 0
      if (sdkChanged) await conversation.configure(change, BACKGROUND_CONTEXT)
      if (!sdkChanged && meta.model === resolved.canonicalRef && meta.thinkingLevel === (thinking ?? '')) return
      const latest = this.host.store.getConv(id)
      if (!latest || this.host.store.isDeleted(id)) return
      this.host.store.upsertConv({
        ...latest,
        model: resolved.canonicalRef,
        thinkingLevel: thinking ?? '',
        updatedAt: Date.now(),
      })
      this.host.scheduleContextUsageRefresh?.(id)
      this.host.events.publish('conversation.upsert', this.host.summaryWithOwnership(id))
    })
  }

  /** Re-align every conversation using a per-batch Profile read cache (reads each distinct Profile file at most once). */
  async alignAllConversations(): Promise<void> {
    const batchProfiles = new Map<string, Promise<Profile | undefined>>()
    for (const meta of this.host.store.listConvs()) {
      try {
        await this.alignConversationModel(meta.id, true, batchProfiles)
      } catch (err) {
        // If an inherited Profile/global `tier/<id>` became unmounted (e.g. tiers plugin disabled
        // or removed with --force), skip aligning that conversation instead of aborting alignment
        // for unaffected conversations; active submissions still fail loudly with 404 model_tier_not_found.
        if (err instanceof HelmxError && err.code === 'model_tier_not_found') continue
        throw err
      }
    }
  }

  /** Immediate inheritance cascade after saving a Profile (explicit overrides stay protected by each resolution chain). */
  async alignProfileConversations(profileId: string): Promise<void> {
    const batchProfiles = new Map<string, Promise<Profile | undefined>>()
    for (const meta of this.host.store.listConvs()) {
      if (meta.profileId !== profileId) continue
      try {
        await this.alignConversationModel(meta.id, true, batchProfiles)
      } catch (err) {
        // Match `alignAllConversations`: skip conversations whose inherited `tier/<id>` is currently
        // unmounted so unrelated Profile metadata edits are not blocked; active submissions still fail with 404.
        if (err instanceof HelmxError && err.code === 'model_tier_not_found') continue
        throw err
      }
    }
  }
}
