/**
 * Conversation context operations: reset / compact / fork.
 *
 * Responsibilities:
 * - Shutdown guards and context preflight checks;
 * - Conversation context reset (with optional handoff);
 * - Manual conversation compaction (with optional custom instructions);
 * - Forking a conversation from a historical entry (inheriting source metadata and aligning model).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type {
  ConversationOwnership,
  ConversationSummary,
  GuardedMutationExpectation,
} from '@helmx/protocol'
import { HelmxError, isPlainObject } from '@helmx/protocol'
import type { SecretStash } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { findActiveOrchestratorTier, type ConversationProfileService } from './conversation-profile.js'
import { requireConv } from './conversation-require.js'
import { assertValidConversationOwnership } from './guards/conversation-guards.js'
import { clampThinkingLevelForModel } from './models.js'
import { asEntryId, getSdkConversation, readSdkEntryPage } from './sdk-ids.js'
import { resolveCleanForkAnchor } from './spawn-fork.js'
import type { HelmxStore } from './store.js'

interface ConversationContextOpsHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly stash: SecretStash
  readonly profileAlignment: ConversationProfileService
  readonly models: () => Models
  readonly assertModelEnabled: (provider: string, modelId: string) => void
  readonly isClosed: () => boolean
  readonly alignConversationModel: (id: number) => Promise<void>
  readonly withOwnership: (summary: ConversationSummary) => ConversationSummary
  /**
   * Guarded-mutation synchronous re-check (ownership human red line + optional CAS watermark),
   * injected by ConversationService; invoked with zero await gap before the irreversible SDK call.
   */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
}

function assertPositiveConversationId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HelmxError(
      'validation_error',
      `conversationId must be a positive safe integer (received ${String(id)})`,
      400,
      { conversationId: id },
    )
  }
}

function assertOptionalStringOption(
  opts: unknown,
  field: 'handoff' | 'instructions',
): string | undefined {
  if (opts === undefined) return undefined
  if (!isPlainObject(opts)) {
    throw new HelmxError('validation_error', `options must be a plain object`, 400)
  }
  const value = opts[field]
  if (value !== undefined && typeof value !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a string`, 400, { field })
  }
  return value
}

export class ConversationContextOps {
  constructor(private readonly host: ConversationContextOpsHost) {}

  /** Kernel shutdown guard (shared across context operations). */
  assertOpen(): void {
    if (this.host.isClosed()) throw new HelmxError('runtime_closed', 'kernel is closing; rejecting new input submission', 503)
  }

  /** Fetch existing conversation metadata and SDK handle (throws 404 if missing). */
  async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmxStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = requireConv(this.host.store, id)
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    return { meta, conversation }
  }

  /**
   * Reset conversation context: call SDK reset(handoff), re-read the latest metadata snapshot to advance
   * `stateChangeSeq` without clobbering concurrent updates or resurrecting deleted rows, and broadcast summary.
   * Guarded callers (plugin automation) pass `guard`: ownership + optional CAS watermark are re-checked
   * synchronously right before the irreversible SDK reset call (zero await gap).
   */
  async resetConversation(
    id: number,
    opts?: { handoff?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<ConversationSummary> {
    this.assertOpen()
    assertPositiveConversationId(id)
    const handoff = assertOptionalStringOption(opts, 'handoff')
    const { conversation } = await this.conversationForContextOp(id)
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    const safeHandoff = handoff !== undefined && handoff !== '' ? this.host.stash.redact(handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    const latestMeta = this.host.store.getConv(id)
    if (latestMeta === undefined || this.host.store.isDeleted(id)) {
      throw new HelmxError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
    }
    this.host.store.upsertConv({ ...latestMeta, stateChangeSeq: latestMeta.stateChangeSeq + 1, updatedAt: Date.now() })
    // Context resets to zero after reset: trigger usage recalculation immediately (deduplicated alongside pi.reset observe backstop).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.withOwnership(this.host.tracker.summaryOf(id))
    this.host.events.publish('conversation.upsert', summary)
    return summary
  }

  /**
   * Manual compaction: call SDK compact(instructions) returning background task ID and updated summary.
   * Guarded callers pass `guard`: re-check runs synchronously right before the irreversible SDK compact enqueue.
   */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertOpen()
    assertPositiveConversationId(id)
    const instructions = assertOptionalStringOption(opts, 'instructions')
    const { conversation } = await this.conversationForContextOp(id)
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
    const safeInstructions =
      instructions !== undefined && instructions !== ''
        ? this.host.stash.redact(instructions)
        : undefined
    const taskId = await conversation.compact(safeInstructions, BACKGROUND_CONTEXT)
    const latestMeta = this.host.store.getConv(id)
    if (latestMeta === undefined || this.host.store.isDeleted(id)) {
      throw new HelmxError('not_found', `conversation not found: ${id}`, 404, { conversationId: id })
    }
    this.host.store.upsertConv({ ...latestMeta, stateChangeSeq: latestMeta.stateChangeSeq + 1, updatedAt: Date.now() })
    // Manual compaction enqueued: trigger usage recalculation immediately (compacting flag and post-compaction tokens
    // continue updating via live/entry observe triggers; idle conversations don't short-circuit on live frames).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.withOwnership(this.host.tracker.summaryOf(id))
    this.host.events.publish('conversation.upsert', summary)
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * Fork a new conversation from a specified entry or latest clean anchor: calls SDK fork(entryId),
   * registers helmx mirror (inheriting profile/tags/cwd/model/overrides/ownership with parent pointing to source),
   * and aligns model. Explicit `opts.ownedBy` overrides inherited source ownership.
   */
  async forkConversation(
    id: number,
    opts?: {
      entryId?: number
      title?: string
      parentConversationId?: number
      ownedBy?: ConversationOwnership
    },
  ): Promise<ConversationSummary> {
    this.assertOpen()
    const explicitOwnedBy =
      opts?.ownedBy !== undefined ? assertValidConversationOwnership(opts.ownedBy) : undefined
    const explicitEntryId = opts?.entryId
    if (explicitEntryId !== undefined && (!Number.isSafeInteger(explicitEntryId) || explicitEntryId <= 0)) {
      throw new HelmxError(
        'validation_error',
        `entryId must be a positive safe integer (received ${String(explicitEntryId)})`,
        400,
        { entryId: explicitEntryId },
      )
    }
    const explicitParentId = opts?.parentConversationId
    if (explicitParentId !== undefined) {
      if (!Number.isSafeInteger(explicitParentId) || explicitParentId <= 0) {
        throw new HelmxError(
          'validation_error',
          `parentConversationId must be a positive safe integer (received ${String(explicitParentId)})`,
          400,
          { parentConversationId: explicitParentId },
        )
      }
      if (this.host.store.getConv(explicitParentId) === undefined || this.host.store.isDeleted(explicitParentId)) {
        throw new HelmxError('not_found', `parent conversation not found: ${explicitParentId}`, 404, {
          parentConversationId: explicitParentId,
        })
      }
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // Forked children always receive parentConversationId and therefore cannot be orchestrator-tier conversations:
    // unwrap an active orchestrator tier via `subagent_inherit` and freeze concrete executorModel + executorThinkingLevel
    // before forking so follow-up profile/tag updates (e.g. Swarm worker dispatch) never fall back to global/profile defaults.
    const inheritedOrchestratorTier =
      sourceMeta.modelTier !== undefined && sourceMeta.modelTier !== ''
        ? sourceMeta.modelTier
        : sourceMeta.modelOverride === undefined && explicitParentId !== undefined
          ? findActiveOrchestratorTier(this.host.store, explicitParentId)
          : undefined
    let forkedModelOverride = sourceMeta.modelOverride
    let forkedThinkingLevelOverride = sourceMeta.thinkingLevelOverride
    if (inheritedOrchestratorTier !== undefined) {
      const resolvedTier = this.host.profileAlignment.resolveRef(inheritedOrchestratorTier, 'subagent_inherit')
      this.host.assertModelEnabled(resolvedTier.provider, resolvedTier.modelId)
      forkedModelOverride = resolvedTier.canonicalRef
      forkedThinkingLevelOverride =
        resolvedTier.tierThinkingLevel !== undefined
          ? clampThinkingLevelForModel(
              this.host.models(),
              { provider: resolvedTier.provider, modelId: resolvedTier.modelId },
              resolvedTier.tierThinkingLevel,
            )
          : undefined
    }
    let entryId: number
    if (explicitEntryId !== undefined) {
      // Verify exact entry existence (min=max=entryId limit 1; missing yields 404).
      const page = await readSdkEntryPage(sourceConv, explicitEntryId, BACKGROUND_CONTEXT)
      if (page.items.length === 0 || Number(page.items[0]!.id) !== explicitEntryId) {
        throw new HelmxError('not_found', `entry ${explicitEntryId} does not exist in conversation ${id}`, 404, {
          conversationId: id,
          entryId: explicitEntryId,
        })
      }
      entryId = explicitEntryId
    } else {
      entryId = await resolveCleanForkAnchor(this.host.harness, id)
    }
    const forked = await sourceConv.fork(
      asEntryId(entryId),
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `conversation ${id}`
    const title =
      opts?.title !== undefined && opts.title.trim() !== ''
        ? this.host.stash.redact(opts.title.trim())
        : `${baseTitle} (fork)`
    const effectiveOwnedBy: ConversationOwnership =
      explicitOwnedBy ?? (sourceMeta.ownedBy === 'helmx' ? 'helmx' : 'human')
    this.host.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: explicitParentId ?? id,
      ownedBy: effectiveOwnedBy,
      nodeId: sourceMeta.nodeId ?? 'local',
      cwd: sourceMeta.cwd,
      model: sourceMeta.model,
      thinkingLevel: sourceMeta.thinkingLevel,
      ...(forkedThinkingLevelOverride !== undefined && forkedThinkingLevelOverride !== ''
        ? { thinkingLevelOverride: forkedThinkingLevelOverride }
        : {}),
      ...(forkedModelOverride !== undefined ? { modelOverride: forkedModelOverride } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      runDurationMs: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.host.alignConversationModel(newId)
    await this.host.tracker.observe(newId)
    const summary = this.host.withOwnership(this.host.tracker.summaryOf(newId))
    this.host.events.publish('conversation.upsert', summary)
    return summary
  }
}
