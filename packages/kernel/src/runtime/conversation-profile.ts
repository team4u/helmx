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
import { HelmxError, assertProfileId } from '@helmx/protocol'
import { type Profile, type ProfileService } from '../services/index.js'
import {
  clampThinkingLevelForModel,
  resolveClampedThinkingLevel,
  resolveModelRefWith,
  type ResolvedModelRef,
} from './models.js'
import type { EventHub } from './events.js'
import type { HelmxStore } from './store.js'

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
  readonly resolveModelRef?: (ref: string) => ResolvedModelRef
  readonly summaryWithOwnership: (id: number) => ConversationSummary
  /** Schedule context usage recalculation after model/thinking alignment (window/threshold may change); omitted skips. */
  readonly scheduleContextUsageRefresh?: (id: number) => void
}

export class ConversationProfileService {
  /** Serialize configuration mutations per conversation so inheritance refreshes and explicit overrides do not clobber each other. */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()

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
  resolveRef(ref: string): ResolvedModelRef {
    return resolveModelRefWith(ref, this.host.resolveModelRef, this.host.parseModelRefOrThrow)
  }

  /** Conversation override > Profile.model > global default, dereferencing any `tier/<id>` into concrete model + tier preset thinking level. */
  async resolveEffectiveModelDetails(
    override: string | undefined,
    profileId: string,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ): Promise<ResolvedModelRef | undefined> {
    const profile = await this.readProfile(profileId, profileCache)
    if (profile === undefined) {
      throw new HelmxError('profile_not_found', `Profile referenced by conversation does not exist: ${profileId}`, 404, { profileId })
    }
    const raw = override || profile.model || this.host.defaultModel()
    if (!raw) return undefined
    return this.resolveRef(raw)
  }

  /** Conversation override > Profile.model > global default (concrete `'provider/modelId'`); Profile files are read live on each lookup. */
  async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    return (await this.resolveEffectiveModelDetails(override, profileId))?.canonicalRef
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

  async withConversationChange<T>(id: number, change: () => Promise<T>): Promise<T> {
    const previous = this.conversationChanges.get(id) ?? Promise.resolve()
    const run = previous.then(change, change)
    this.conversationChanges.set(id, run)
    try {
      return await run
    } finally {
      if (this.conversationChanges.get(id) === run) this.conversationChanges.delete(id)
    }
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
      const resolved = await this.resolveEffectiveModelDetails(meta.modelOverride, meta.profileId, batchProfiles)
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
      const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
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
        meta.thinkingLevel === (thinking ?? '') &&
        meta.thinkingLevelOverride === clampedOverride
      ) return
      const latest = this.host.store.getConv(id)
      if (!latest) return
      this.host.store.upsertConv({
        ...latest,
        model: effective ?? '',
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
