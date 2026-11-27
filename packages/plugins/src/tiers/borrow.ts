/**
 * One-turn model borrow, in-session model relay (`switch_model`),
 * deterministic target resolution, and per-conversation borrow lifecycle state machine.
 */
import {
  HelmxError,
  MODEL_THINKING_LEVELS,
  MODEL_TIER_PREFIX,
  isOrchestratorTier,
  type ConversationPatch,
  type ConversationSummary,
  type HelmxPluginContext,
  type HookPayloadMap,
  type HookResult,
  type ModelCatalog,
  type ModelThinkingLevel,
  type PluginInUseItem,
  type PluginKvHandle,
  type PluginSessionDocHandle,
  type PluginToolContext,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  isTiersBorrowEligible,
  parseTiersBorrowInputMeta,
  type SwitchModelPresentationMeta,
  type TierBorrowRecord,
  type TierBorrowSessionView,
  type TierBorrowSource,
  type TierThinkingLevel,
  type TiersStateDoc,
} from './contracts.js'
import {
  createKeyedQueue,
  errorMessageOf,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  isConversationNotFoundError,
  listAllKvEntries,
} from '../shared-helpers.js'

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set<string>(MODEL_THINKING_LEVELS)

export interface ResolvedBorrowTarget {
  requestedRef: string
  /** Reference passed to kernel updateConversation (`tier/<id>` or concrete `provider/modelId`). */
  targetModel: string
  /** Concrete `provider/modelId` validated against the live catalog. */
  targetConcreteModel: string
  /** Compact display label (`tier/<id>` or short model name). */
  targetLabel: string
  targetTierId?: string
  effort?: TierThinkingLevel
}

export interface ClearBorrowResult {
  cleared: boolean
  previousPhase?: 'armed' | 'active'
}

export interface SwitchModelToolInput {
  model: string
  effort?: TierThinkingLevel
  restoreAfterTurn?: boolean
}

export interface TierBorrowManager {
  setStopping(stopping: boolean): void
  hydrate(): void
  reconcile(): Promise<void>
  inUseItems(): PluginInUseItem[]
  stop(): Promise<void>
  getBorrow(conversationId: number): TierBorrowSessionView | null
  setBorrow(
    conversationId: number,
    input: { model: string; effort?: string; source?: TierBorrowSource },
  ): Promise<TierBorrowSessionView>
  clearBorrow(conversationId: number): Promise<ClearBorrowResult>
  handleInput(payload: HookPayloadMap['input']): Promise<HookResult<HookPayloadMap['input']>>
  handleTurnSettled(conversationId: number): Promise<void>
  handleConversationDeleted(conversationId: number): Promise<void>
  handleConversationReset(conversationId: number): Promise<void>
  executeSwitchModelTool(
    input: SwitchModelToolInput,
    context: PluginToolContext,
  ): Promise<PluginToolResultEnvelope>
}

function formatShortModelLabel(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.startsWith(`${MODEL_TIER_PREFIX}/`) && trimmed.length > MODEL_TIER_PREFIX.length + 1) {
    return trimmed
  }
  const slashIdx = trimmed.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < trimmed.length - 1) {
    return trimmed.slice(slashIdx + 1)
  }
  return trimmed
}

function validateBorrowEffort(effort: unknown): TierThinkingLevel | undefined {
  if (effort === undefined) return undefined
  if (typeof effort !== 'string') {
    throw new HelmxError(
      'invalid_effort',
      `Invalid effort '${String(effort)}'; valid values: ${MODEL_THINKING_LEVELS.join(' | ')}`,
      400,
      { effort },
    )
  }
  const trimmed = effort.trim()
  if (!VALID_THINKING_LEVELS.has(trimmed)) {
    throw new HelmxError(
      'invalid_effort',
      `Invalid effort '${effort}'; valid values: ${MODEL_THINKING_LEVELS.join(' | ')}`,
      400,
      { effort },
    )
  }
  return trimmed as ModelThinkingLevel
}

function resolveTierById(
  tierId: string,
  requestedRef: string,
  catalog: ModelCatalog,
  tiersState: TiersStateDoc,
  effort: TierThinkingLevel | undefined,
): ResolvedBorrowTarget {
  if (!Object.hasOwn(tiersState.tiers, tierId)) {
    throw new HelmxError(
      'tier_not_found',
      `Model tier '${tierId}' does not exist`,
      404,
      { tierId, ref: requestedRef },
    )
  }
  const spec = tiersState.tiers[tierId]!
  if (isOrchestratorTier(spec)) {
    throw new HelmxError(
      'orchestrator_tier_not_borrowable',
      `Model tier '${tierId}' is a dual-phase orchestrator tier and cannot be used with one-turn borrow or switch_model`,
      400,
      { tierId, ref: requestedRef },
    )
  }
  const concrete = catalog.models.find((m) => `${m.provider}/${m.modelId}` === spec.model)
  if (concrete === undefined) {
    throw new HelmxError(
      'model_not_found',
      `Target model '${spec.model}' for tier '${tierId}' was not found in the model catalog`,
      404,
      { tierId, model: spec.model },
    )
  }
  if (concrete.disabled === true) {
    throw new HelmxError(
      'model_disabled',
      `Target model '${spec.model}' for tier '${tierId}' is disabled`,
      409,
      { tierId, model: spec.model },
    )
  }
  if (concrete.available !== true) {
    throw new HelmxError(
      'model_unavailable',
      `Target model '${spec.model}' for tier '${tierId}' is unavailable (provider credentials not configured)`,
      409,
      { tierId, model: spec.model },
    )
  }
  const targetModel = `${MODEL_TIER_PREFIX}/${tierId}`
  return {
    requestedRef,
    targetModel,
    targetConcreteModel: spec.model,
    targetLabel: targetModel,
    targetTierId: tierId,
    ...(effort !== undefined ? { effort } : {}),
  }
}

/**
 * Deterministic target resolver for both zero-tier and tier-configured environments:
 * 1. Explicit `tier/<id>` -> lookup tier, verify underlying concrete model exists, is not disabled, and is available;
 * 2. Bare `<tierId>` matching a configured tier -> same tier verification;
 * 3. Exact `provider/modelId` match in catalog (supports slashed model IDs) -> reject if disabled or unavailable;
 * 4. Bare `<modelId>` (no `/`) -> single usable match wins, >1 -> 409 ambiguous_model_ref,
 *    disabled match -> 409 model_disabled, unavailable match -> 409 model_unavailable, else 404 model_not_found;
 * 5. Any unmatched ref containing `/` -> 404 model_not_found.
 */
export function resolveBorrowTarget(
  rawRef: string,
  catalog: ModelCatalog,
  tiersState: TiersStateDoc,
  effort?: string,
): ResolvedBorrowTarget {
  if (typeof rawRef !== 'string' || rawRef.trim() === '') {
    throw new HelmxError('validation_error', 'Model reference must be a non-empty string', 400)
  }
  const ref = rawRef.trim()
  const validatedEffort = validateBorrowEffort(effort)

  if (ref.startsWith(`${MODEL_TIER_PREFIX}/`)) {
    const tierId = ref.slice(`${MODEL_TIER_PREFIX}/`.length)
    return resolveTierById(tierId, ref, catalog, tiersState, validatedEffort)
  }

  if (Object.hasOwn(tiersState.tiers, ref)) {
    return resolveTierById(ref, ref, catalog, tiersState, validatedEffort)
  }

  const exact = catalog.models.find((m) => `${m.provider}/${m.modelId}` === ref)
  if (exact !== undefined) {
    if (exact.disabled === true) {
      throw new HelmxError('model_disabled', `Model '${ref}' is disabled`, 409, { model: ref })
    }
    if (exact.available !== true) {
      throw new HelmxError(
        'model_unavailable',
        `Model '${ref}' is unavailable (provider credentials not configured)`,
        409,
        { model: ref },
      )
    }
    return {
      requestedRef: ref,
      targetModel: ref,
      targetConcreteModel: ref,
      targetLabel: formatShortModelLabel(ref),
      ...(validatedEffort !== undefined ? { effort: validatedEffort } : {}),
    }
  }

  if (!ref.includes('/')) {
    const matches = catalog.models.filter((m) => m.modelId === ref)
    const usable = matches.filter((m) => m.available === true && m.disabled !== true)
    if (usable.length === 1) {
      const only = usable[0]!
      const fullId = `${only.provider}/${only.modelId}`
      return {
        requestedRef: ref,
        targetModel: fullId,
        targetConcreteModel: fullId,
        targetLabel: formatShortModelLabel(fullId),
        ...(validatedEffort !== undefined ? { effort: validatedEffort } : {}),
      }
    }
    if (usable.length > 1) {
      const candidates = usable.map((m) => `${m.provider}/${m.modelId}`)
      throw new HelmxError(
        'ambiguous_model_ref',
        `Model reference '${ref}' is ambiguous across providers; specify one of: ${candidates.join(', ')}`,
        409,
        { ref, candidates },
      )
    }
    if (matches.some((m) => m.disabled === true)) {
      throw new HelmxError('model_disabled', `Model '${ref}' is disabled`, 409, { ref })
    }
    if (matches.length > 0) {
      const candidates = matches.map((m) => `${m.provider}/${m.modelId}`)
      throw new HelmxError(
        'model_unavailable',
        `Model '${ref}' is unavailable (provider credentials not configured)`,
        409,
        { ref, candidates },
      )
    }
    throw new HelmxError('model_not_found', `Model '${ref}' was not found in the model catalog`, 404, { ref })
  }

  throw new HelmxError('model_not_found', `Model '${ref}' was not found in the model catalog`, 404, { ref })
}

export function toTierBorrowSessionView(record: TierBorrowRecord): TierBorrowSessionView {
  return {
    phase: record.phase,
    requestedRef: record.requestedRef,
    targetModel: record.targetModel,
    targetConcreteModel: record.targetConcreteModel,
    targetLabel: record.targetLabel,
    ...(record.targetTierId !== undefined ? { targetTierId: record.targetTierId } : {}),
    ...(record.appliedEffort !== undefined ? { effort: record.appliedEffort } : {}),
    restoreAfterTurn: record.restoreAfterTurn,
    ...(record.previousModelOverride !== undefined
      ? { previousModelOverride: record.previousModelOverride }
      : {}),
    updatedAt: record.updatedAt,
  }
}

function isConversationBusy(conv: ConversationSummary): boolean {
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    conv.pendingAskCount > 0 ||
    conv.contextUsage?.compacting === true
  )
}

interface BorrowStore {
  get(conversationId: number): TierBorrowRecord | undefined
  listAllRecords(): TierBorrowRecord[]
  syncSessionDoc(conversationId: number, record: TierBorrowRecord | undefined): void
  saveRecord(conversationId: number, record: TierBorrowRecord | undefined): Promise<void>
}

/** 借用生命周期函数共用的运行时句柄（宿主、持久层、tier 状态读取与停止标志）。 */
interface BorrowRuntime {
  ctx: HelmxPluginContext
  store: BorrowStore
  readTiersState: () => TiersStateDoc
  isStopping: () => boolean
}

interface ActivatedBorrowOutcome {
  fromModel: string
  updated: ConversationSummary
  resolved: ResolvedBorrowTarget
  changed: boolean
  restoreAfterTurn: boolean
  view: TierBorrowSessionView | null
}

function createBorrowStore(
  kv: PluginKvHandle<TierBorrowRecord>,
  borrowDoc: PluginSessionDocHandle<TierBorrowSessionView | null>,
): BorrowStore {
  const kvKey = (conversationId: number): string => String(conversationId)

  const syncSessionDoc = (conversationId: number, record: TierBorrowRecord | undefined): void => {
    ignoreConversationNotFound(() => {
      if (record === undefined) {
        borrowDoc.delete(conversationId)
      } else {
        borrowDoc.set(conversationId, toTierBorrowSessionView(record))
      }
    })
  }

  return {
    get: (conversationId) => kv.get(kvKey(conversationId)),
    listAllRecords: () => listAllKvEntries(kv).map((entry) => entry.value),
    syncSessionDoc,
    async saveRecord(conversationId, record) {
      const key = kvKey(conversationId)
      const prev = kv.get(key)
      if (record === undefined) {
        kv.delete(key)
      } else {
        kv.set(key, record)
      }
      try {
        await kv.flush()
      } catch (err) {
        if (prev !== undefined) kv.set(key, prev)
        else kv.delete(key)
        throw err
      }
      syncSessionDoc(conversationId, record)
    },
  }
}

function requireEligibleConversation(ctx: HelmxPluginContext, conversationId: number): ConversationSummary {
  const conv = ctx.host.getConversation(conversationId)
  if (!isTiersBorrowEligible(conv)) {
    throw new HelmxError(
      'tiers_borrow_unsupported_conversation',
      `One-turn model borrow is only supported on top-level human conversations (conversation ${conv.id} is not eligible)`,
      400,
      { conversationId: conv.id },
    )
  }
  return conv
}

function assertNotBusyForBorrow(conv: ConversationSummary, message: string): void {
  if (isConversationBusy(conv)) {
    throw new HelmxError('conversation_busy', message, 409, { conversationId: conv.id })
  }
}

async function restoreActiveBorrow(rt: BorrowRuntime, conversationId: number): Promise<void> {
  const { ctx, store, isStopping } = rt
  if (isStopping()) return
  const record = store.get(conversationId)
  if (record === undefined || record.phase !== 'active') return

  const conv = getConversationOrUndefined(ctx.host, conversationId)
  if (conv === undefined) {
    await store.saveRecord(conversationId, undefined)
    return
  }
  // Invariant 1: never restore while a followUp/working turn or pending AskDoc is still active.
  if (isConversationBusy(conv)) {
    store.syncSessionDoc(conversationId, record)
    return
  }
  // Invariant 2 (CAS model snapshot guard): clear only the record if restore is disabled or model changed externally.
  if (!record.restoreAfterTurn || conv.modelOverride !== record.appliedModelOverride) {
    await store.saveRecord(conversationId, undefined)
    return
  }

  const patch: ConversationPatch = {
    model: record.previousModelOverride ?? '',
  }
  const thinkingMatches = conv.thinkingLevelOverride === record.appliedThinkingLevelOverride
  if (thinkingMatches && (record.effortChanged || record.previousThinkingLevelOverride !== undefined)) {
    patch.thinkingLevel = record.previousThinkingLevelOverride ?? ''
  }

  try {
    await ctx.host.updateConversation(conversationId, patch)
  } catch (err) {
    if (isConversationNotFoundError(err)) {
      await store.saveRecord(conversationId, undefined)
      return
    }
    // Clear record on unrecoverable baseline errors and surface an honest warning rather than wedging borrow state.
    await store.saveRecord(conversationId, undefined)
    await ctx.host.emitEvent('notification', {
      level: 'warning',
      title: `Could not restore previous model for conversation #${conversationId}`,
      body: ctx.host.redact(errorMessageOf(err)),
      conversationId,
    })
    return
  }
  await store.saveRecord(conversationId, undefined)
}

async function armConversationBorrow(
  rt: BorrowRuntime,
  conversationId: number,
  targetRef: string,
  opts: { effort?: string; source: TierBorrowSource },
): Promise<TierBorrowSessionView> {
  const { ctx, store, readTiersState, isStopping } = rt
  if (isStopping()) {
    throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
  }
  let conv = requireEligibleConversation(ctx, conversationId)
  assertNotBusyForBorrow(
    conv,
    `Conversation #${conversationId} is busy; cannot arm a one-turn model while a turn is active`,
  )
  if (store.get(conversationId)?.phase === 'active') {
    await restoreActiveBorrow(rt, conversationId)
    conv = requireEligibleConversation(ctx, conversationId)
  }
  const catalog = await ctx.host.listModels()
  const resolved = resolveBorrowTarget(targetRef, catalog, readTiersState(), opts.effort)
  const now = Date.now()
  const record: TierBorrowRecord = {
    conversationId: conv.id,
    phase: 'armed',
    requestedRef: resolved.requestedRef,
    targetModel: resolved.targetModel,
    targetConcreteModel: resolved.targetConcreteModel,
    targetLabel: resolved.targetLabel,
    ...(resolved.targetTierId !== undefined ? { targetTierId: resolved.targetTierId } : {}),
    ...(resolved.effort !== undefined ? { appliedEffort: resolved.effort } : {}),
    effortChanged: false,
    restoreAfterTurn: true,
    source: opts.source,
    createdAt: now,
    updatedAt: now,
  }
  await store.saveRecord(conversationId, record)
  return toTierBorrowSessionView(record)
}

async function activateConversationBorrow(
  rt: BorrowRuntime,
  conversationId: number,
  targetRef: string,
  opts: {
    effort?: string
    source: TierBorrowSource
    restoreAfterTurn?: boolean
    allowWhileBusy?: boolean
  },
): Promise<ActivatedBorrowOutcome> {
  const { ctx, store, readTiersState, isStopping } = rt
  if (isStopping()) {
    throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
  }
  const conv = requireEligibleConversation(ctx, conversationId)
  if (opts.source === 'tool' && conv.modelTier !== undefined) {
    throw new HelmxError(
      'orchestrator_tier_active',
      `Conversation #${conv.id} uses orchestrator tier '${conv.modelTier}' and manages model switching automatically`,
      409,
      { conversationId: conv.id, modelTier: conv.modelTier },
    )
  }
  if (opts.allowWhileBusy !== true) {
    assertNotBusyForBorrow(
      conv,
      `Conversation #${conversationId} is busy; cannot switch model for this input`,
    )
  }
  const catalog = await ctx.host.listModels()
  const resolved = resolveBorrowTarget(targetRef, catalog, readTiersState(), opts.effort)

  const latestConv = requireEligibleConversation(ctx, conversationId)
  const existing = store.get(conversationId)
  const fromModel = latestConv.model || latestConv.modelOverride || ''
  const fromThinking = latestConv.thinkingLevel

  // Invariant 3: preserve original baseline across chained same-turn switches.
  const keepExistingBaseline = existing !== undefined && existing.phase === 'active'
  const previousModelOverride = keepExistingBaseline ? existing.previousModelOverride : latestConv.modelOverride
  const previousThinkingLevelOverride = keepExistingBaseline
    ? existing.previousThinkingLevelOverride
    : latestConv.thinkingLevelOverride

  const updated = await ctx.host.updateConversation(conversationId, {
    model: resolved.targetModel,
    ...(resolved.effort !== undefined ? { thinkingLevel: resolved.effort } : {}),
  })

  const changed = updated.model !== fromModel || updated.thinkingLevel !== fromThinking
  const restoreAfterTurn = opts.restoreAfterTurn !== false
  if (!restoreAfterTurn) {
    if (existing !== undefined) {
      await store.saveRecord(conversationId, undefined)
    }
    return { fromModel, updated, resolved, changed, restoreAfterTurn: false, view: null }
  }

  const appliedModelOverride = updated.modelOverride ?? resolved.targetConcreteModel
  const appliedThinkingLevelOverride = updated.thinkingLevelOverride
  const effortChanged = appliedThinkingLevelOverride !== previousThinkingLevelOverride
  const now = Date.now()
  const record: TierBorrowRecord = {
    conversationId,
    phase: 'active',
    requestedRef: resolved.requestedRef,
    targetModel: resolved.targetModel,
    appliedModelOverride,
    targetConcreteModel: resolved.targetConcreteModel,
    targetLabel: resolved.targetLabel,
    ...(resolved.targetTierId !== undefined ? { targetTierId: resolved.targetTierId } : {}),
    ...(resolved.effort !== undefined ? { appliedEffort: resolved.effort } : {}),
    ...(appliedThinkingLevelOverride !== undefined ? { appliedThinkingLevelOverride } : {}),
    ...(previousModelOverride !== undefined ? { previousModelOverride } : {}),
    ...(previousThinkingLevelOverride !== undefined ? { previousThinkingLevelOverride } : {}),
    effortChanged,
    restoreAfterTurn: true,
    source: opts.source,
    createdAt: keepExistingBaseline ? existing.createdAt : now,
    updatedAt: now,
  }
  await store.saveRecord(conversationId, record)
  return {
    fromModel,
    updated,
    resolved,
    changed,
    restoreAfterTurn: true,
    view: toTierBorrowSessionView(record),
  }
}

function formatSwitchModelResult(outcome: ActivatedBorrowOutcome): PluginToolResultEnvelope {
  const effectiveEffort =
    outcome.resolved.effort ??
    (outcome.resolved.targetTierId !== undefined &&
    outcome.updated.thinkingLevelOverride !== undefined &&
    VALID_THINKING_LEVELS.has(outcome.updated.thinkingLevelOverride)
      ? (outcome.updated.thinkingLevelOverride as TierThinkingLevel)
      : undefined)
  const presentationMeta: SwitchModelPresentationMeta = {
    fromModel: outcome.fromModel,
    toModel: outcome.updated.model || outcome.resolved.targetConcreteModel,
    toLabel: outcome.resolved.targetLabel,
    ...(outcome.resolved.targetTierId !== undefined ? { tierId: outcome.resolved.targetTierId } : {}),
    ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
    restoreAfterTurn: outcome.restoreAfterTurn,
    changed: outcome.changed,
  }
  const effortClause = effectiveEffort !== undefined ? ` [effort: ${effectiveEffort}]` : ''
  const output = outcome.restoreAfterTurn
    ? `Switched conversation model to ${outcome.resolved.targetLabel} (${presentationMeta.toModel})${effortClause}. Your next reasoning step runs on this model, and the original model will be restored automatically when this turn finishes — continue directly with your response without calling switch_model again to restore.`
    : `Permanently switched conversation model to ${outcome.resolved.targetLabel} (${presentationMeta.toModel})${effortClause}. Subsequent turns will remain on this model.`
  return { output, presentationMeta }
}

export function createTierBorrowManager(deps: {
  ctx: HelmxPluginContext
  kv: PluginKvHandle<TierBorrowRecord>
  borrowDoc: PluginSessionDocHandle<TierBorrowSessionView | null>
  readTiersState: () => TiersStateDoc
}): TierBorrowManager {
  const { ctx, kv, borrowDoc, readTiersState } = deps

  let stopping = false
  const isStopping = (): boolean => stopping
  const convQueue = createKeyedQueue<number>()
  const store = createBorrowStore(kv, borrowDoc)
  const rt: BorrowRuntime = { ctx, store, readTiersState, isStopping }

  return {
    setStopping(value: boolean): void {
      stopping = value
    },

    hydrate(): void {
      for (const record of store.listAllRecords()) {
        store.syncSessionDoc(record.conversationId, record)
      }
    },

    async reconcile(): Promise<void> {
      for (const record of store.listAllRecords()) {
        await convQueue.enqueue(record.conversationId, async () => {
          if (stopping) return
          const latest = store.get(record.conversationId)
          if (latest === undefined) return
          if (getConversationOrUndefined(ctx.host, record.conversationId) === undefined) {
            await store.saveRecord(record.conversationId, undefined)
            return
          }
          if (latest.phase === 'active') {
            await restoreActiveBorrow(rt, record.conversationId)
          } else {
            store.syncSessionDoc(record.conversationId, latest)
          }
        })
      }
    },

    inUseItems(): PluginInUseItem[] {
      return store
        .listAllRecords()
        .filter((record) => record.phase === 'active')
        .map((record) => ({
          kind: 'model_borrow',
          id: String(record.conversationId),
          label: `Conversation #${record.conversationId} is actively borrowing ${record.targetLabel}`,
        }))
    },

    async stop(): Promise<void> {
      stopping = true
      await convQueue.drain()
      await kv.flush()
    },

    getBorrow(conversationId: number): TierBorrowSessionView | null {
      const conv = ctx.host.getConversation(conversationId)
      if (!isTiersBorrowEligible(conv)) return null
      const record = store.get(conversationId)
      return record !== undefined ? toTierBorrowSessionView(record) : null
    },

    setBorrow(
      conversationId: number,
      input: { model: string; effort?: string; source?: TierBorrowSource },
    ): Promise<TierBorrowSessionView> {
      return convQueue.enqueue(conversationId, () =>
        armConversationBorrow(rt, conversationId, input.model, {
          effort: input.effort,
          source: input.source ?? 'ui',
        }),
      )
    },

    clearBorrow(conversationId: number): Promise<ClearBorrowResult> {
      return convQueue.enqueue(conversationId, async () => {
        if (stopping) {
          throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
        }
        ctx.host.getConversation(conversationId)
        const existing = store.get(conversationId)
        if (existing === undefined) {
          return { cleared: false }
        }
        await store.saveRecord(conversationId, undefined)
        return { cleared: true, previousPhase: existing.phase }
      })
    },

    async handleInput(payload: HookPayloadMap['input']): Promise<HookResult<HookPayloadMap['input']>> {
      if (stopping || payload.input.origin !== 'human') return { action: 'continue' }

      const parsedMeta = parseTiersBorrowInputMeta(payload.input.meta)
      const existingFast = store.get(payload.conversationId)
      if (!parsedMeta.present && existingFast === undefined) {
        return { action: 'continue' }
      }

      const convFast = getConversationOrUndefined(ctx.host, payload.conversationId)
      if (convFast === undefined || !isTiersBorrowEligible(convFast)) {
        return { action: 'continue' }
      }

      return convQueue.enqueue(convFast.id, async (): Promise<HookResult<HookPayloadMap['input']>> => {
        if (stopping) return { action: 'continue' }
        let conv = getConversationOrUndefined(ctx.host, convFast.id)
        if (conv === undefined || !isTiersBorrowEligible(conv)) {
          return { action: 'continue' }
        }

        const currentRecord = store.get(conv.id)
        if (currentRecord?.phase === 'active' && !isConversationBusy(conv)) {
          await restoreActiveBorrow(rt, conv.id)
          conv = getConversationOrUndefined(ctx.host, conv.id)
          if (conv === undefined) return { action: 'continue' }
        }

        if (parsedMeta.present) {
          if (!parsedMeta.valid) return { action: 'block', reason: parsedMeta.reason }
          if (isConversationBusy(conv)) return { action: 'continue' }
          try {
            await activateConversationBorrow(rt, conv.id, parsedMeta.borrowModel, {
              effort: parsedMeta.effort,
              source: 'meta',
              restoreAfterTurn: true,
            })
            return { action: 'continue' }
          } catch (err) {
            return { action: 'block', reason: ctx.host.redact(errorMessageOf(err)) }
          }
        }

        const armed = store.get(conv.id)
        if (armed !== undefined && armed.phase === 'armed') {
          if (isConversationBusy(conv)) return { action: 'continue' }
          try {
            await activateConversationBorrow(rt, conv.id, armed.targetModel, {
              effort: armed.appliedEffort,
              source: armed.source,
              restoreAfterTurn: true,
            })
            return { action: 'continue' }
          } catch (err) {
            return {
              action: 'block',
              reason: `Armed one-turn model '${armed.targetLabel}' is no longer usable: ${ctx.host.redact(errorMessageOf(err))}. Clear it or select another model before sending.`,
            }
          }
        }

        return { action: 'continue' }
      })
    },

    handleTurnSettled(conversationId: number): Promise<void> {
      return convQueue.enqueue(conversationId, () =>
        restoreActiveBorrow(rt, conversationId),
      )
    },

    handleConversationDeleted(conversationId: number): Promise<void> {
      return convQueue.enqueue(conversationId, async () => {
        if (store.get(conversationId) === undefined) {
          store.syncSessionDoc(conversationId, undefined)
          return
        }
        await store.saveRecord(conversationId, undefined)
      })
    },

    handleConversationReset(conversationId: number): Promise<void> {
      return convQueue.enqueue(conversationId, async () => {
        if (stopping) return
        const existing = store.get(conversationId)
        if (existing === undefined) return
        if (existing.phase === 'armed') {
          await store.saveRecord(conversationId, undefined)
          return
        }
        const conv = getConversationOrUndefined(ctx.host, conversationId)
        if (conv === undefined || !isConversationBusy(conv)) {
          await store.saveRecord(conversationId, undefined)
        }
      })
    },

    executeSwitchModelTool(
      input: SwitchModelToolInput,
      context: PluginToolContext,
    ): Promise<PluginToolResultEnvelope> {
      const conversationId = context.conversationId
      return convQueue.enqueue(conversationId, async (): Promise<PluginToolResultEnvelope> => {
        if (stopping) {
          return { output: 'builtin:tiers is stopping; cannot switch model.', isError: true }
        }
        try {
          const outcome = await activateConversationBorrow(rt, conversationId, input.model, {
            effort: input.effort,
            source: 'tool',
            restoreAfterTurn: input.restoreAfterTurn,
            allowWhileBusy: true,
          })
          return formatSwitchModelResult(outcome)
        } catch (err) {
          return {
            output: ctx.host.redact(errorMessageOf(err)),
            isError: true,
          }
        }
      })
    },
  }
}
