/**
 * One-turn model borrow (`/model`), in-session model relay (`switch_model`),
 * deterministic target resolution, and per-conversation borrow lifecycle state machine.
 */
import {
  HelmxError,
  MODEL_THINKING_LEVELS,
  MODEL_TIER_PREFIX,
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
  parseModelSlashInput,
  parseTiersBorrowInputMeta,
  type SwitchModelPresentationMeta,
  type TierBorrowRecord,
  type TierBorrowSessionView,
  type TierBorrowSource,
  type TierThinkingLevel,
  type TiersStateDoc,
} from './contracts.js'

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

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
 * 1. Explicit `tier/<id>` -> lookup tier, verify underlying concrete model exists & is not disabled;
 * 2. Bare `<tierId>` matching a configured tier -> same tier verification;
 * 3. Exact `provider/modelId` match in catalog (supports slashed model IDs) -> reject if disabled;
 * 4. Bare `<modelId>` (no `/`) -> single usable match wins, >1 -> 409 ambiguous_model_ref,
 *    disabled-only -> 409 model_disabled, else 404 model_not_found;
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

function getConversationOrUndefined(
  read: (id: number) => ConversationSummary,
  id: number,
): ConversationSummary | undefined {
  try {
    return read(id)
  } catch (err) {
    if (err instanceof HelmxError && (err.status === 404 || err.code === 'not_found')) {
      return undefined
    }
    throw err
  }
}

function ignoreConversationNotFound(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (err instanceof HelmxError && (err.status === 404 || err.code === 'not_found')) {
      return
    }
    throw err
  }
}

export function createTierBorrowManager(deps: {
  ctx: HelmxPluginContext
  kv: PluginKvHandle<TierBorrowRecord>
  borrowDoc: PluginSessionDocHandle<TierBorrowSessionView | null>
  readTiersState: () => TiersStateDoc
}): TierBorrowManager {
  const { ctx, kv, borrowDoc, readTiersState } = deps

  let stopping = false
  const convQueues = new Map<number, Promise<unknown>>()

  const kvKey = (conversationId: number): string => String(conversationId)

  const enqueueConversation = <T>(conversationId: number, op: () => Promise<T>): Promise<T> => {
    const prev = convQueues.get(conversationId) ?? Promise.resolve()
    const run = prev.then(op, op)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    convQueues.set(conversationId, settled)
    void settled.then(() => {
      if (convQueues.get(conversationId) === settled) {
        convQueues.delete(conversationId)
      }
    })
    return run
  }

  const listAllRecords = (): TierBorrowRecord[] => {
    const records: TierBorrowRecord[] = []
    let cursor: string | undefined
    for (;;) {
      const page = kv.list(cursor !== undefined ? { cursor } : undefined)
      for (const item of page.items) {
        records.push(item.value)
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    return records
  }

  const syncSessionDoc = (conversationId: number, record: TierBorrowRecord | undefined): void => {
    if (record === undefined) {
      ignoreConversationNotFound(() => {
        borrowDoc.delete(conversationId)
      })
    } else {
      ignoreConversationNotFound(() => {
        borrowDoc.set(conversationId, toTierBorrowSessionView(record))
      })
    }
  }

  const saveRecord = async (
    conversationId: number,
    record: TierBorrowRecord | undefined,
  ): Promise<void> => {
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
  }

  const requireEligibleConversation = (conversationId: number): ConversationSummary => {
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

  const restoreIfIdleUnlocked = async (conversationId: number): Promise<void> => {
    if (stopping) return
    const record = kv.get(kvKey(conversationId))
    if (record === undefined || record.phase !== 'active') return

    const conv = getConversationOrUndefined((id) => ctx.host.getConversation(id), conversationId)
    if (conv === undefined) {
      await saveRecord(conversationId, undefined)
      return
    }
    // Invariant 1: never restore while a followUp/working turn or pending AskDoc is still active.
    if (isConversationBusy(conv)) {
      syncSessionDoc(conversationId, record)
      return
    }
    if (!record.restoreAfterTurn) {
      await saveRecord(conversationId, undefined)
      return
    }

    // Invariant 2 (CAS model snapshot guard): if the user or another flow (e.g. plan_propose handoff)
    // changed or cleared the conversation model override while borrowing, clear only the borrow record.
    if (conv.modelOverride !== record.appliedModelOverride) {
      await saveRecord(conversationId, undefined)
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
      if (err instanceof HelmxError && (err.status === 404 || err.code === 'not_found')) {
        await saveRecord(conversationId, undefined)
        return
      }
      // Clear record on unrecoverable baseline errors (e.g., original model was disabled/removed during turn)
      // and surface an honest warning rather than wedging the conversation in a permanently active borrow.
      await saveRecord(conversationId, undefined)
      await ctx.host.emitEvent('notification', {
        level: 'warning',
        title: `Could not restore previous model for conversation #${conversationId}`,
        body: ctx.host.redact(errorMessageOf(err)),
        conversationId,
      })
      return
    }
    await saveRecord(conversationId, undefined)
  }

  const armBorrowUnlocked = async (
    conversationId: number,
    targetRef: string,
    opts: { effort?: string; source: TierBorrowSource },
  ): Promise<TierBorrowSessionView> => {
    if (stopping) {
      throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
    }
    let conv = requireEligibleConversation(conversationId)
    if (isConversationBusy(conv)) {
      throw new HelmxError(
        'conversation_busy',
        `Conversation #${conversationId} is busy; cannot arm a one-turn model while a turn is active`,
        409,
        { conversationId },
      )
    }
    const existing = kv.get(kvKey(conversationId))
    if (existing?.phase === 'active') {
      await restoreIfIdleUnlocked(conversationId)
      conv = requireEligibleConversation(conversationId)
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
    await saveRecord(conversationId, record)
    return toTierBorrowSessionView(record)
  }

  const activateBorrowUnlocked = async (
    conversationId: number,
    targetRef: string,
    opts: {
      effort?: string
      source: TierBorrowSource
      restoreAfterTurn?: boolean
      allowWhileBusy?: boolean
    },
  ): Promise<{
    fromModel: string
    updated: ConversationSummary
    resolved: ResolvedBorrowTarget
    changed: boolean
    restoreAfterTurn: boolean
    view: TierBorrowSessionView | null
  }> => {
    if (stopping) {
      throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
    }
    const conv = requireEligibleConversation(conversationId)
    if (opts.allowWhileBusy !== true && isConversationBusy(conv)) {
      throw new HelmxError(
        'conversation_busy',
        `Conversation #${conversationId} is busy; cannot switch model for this input`,
        409,
        { conversationId },
      )
    }
    const catalog = await ctx.host.listModels()
    const resolved = resolveBorrowTarget(targetRef, catalog, readTiersState(), opts.effort)

    // Re-read authoritative conversation & KV right before mutating.
    const latestConv = requireEligibleConversation(conversationId)
    const existing = kv.get(kvKey(conversationId))
    const fromModel = latestConv.model || latestConv.modelOverride || ''
    const fromThinking = latestConv.thinkingLevel

    // Invariant 3: preserve original baseline across chained same-turn switches.
    const keepExistingBaseline = existing !== undefined && existing.phase === 'active'
    const previousModelOverride = keepExistingBaseline
      ? existing.previousModelOverride
      : latestConv.modelOverride
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
        await saveRecord(conversationId, undefined)
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
    await saveRecord(conversationId, record)
    return {
      fromModel,
      updated,
      resolved,
      changed,
      restoreAfterTurn: true,
      view: toTierBorrowSessionView(record),
    }
  }

  return {
    setStopping(value: boolean): void {
      stopping = value
    },

    hydrate(): void {
      for (const record of listAllRecords()) {
        syncSessionDoc(record.conversationId, record)
      }
    },

    async reconcile(): Promise<void> {
      const records = listAllRecords()
      for (const record of records) {
        await enqueueConversation(record.conversationId, async () => {
          if (stopping) return
          const latest = kv.get(kvKey(record.conversationId))
          if (latest === undefined) return
          const conv = getConversationOrUndefined(
            (id) => ctx.host.getConversation(id),
            record.conversationId,
          )
          if (conv === undefined) {
            await saveRecord(record.conversationId, undefined)
            return
          }
          if (latest.phase === 'active') {
            await restoreIfIdleUnlocked(record.conversationId)
          } else {
            syncSessionDoc(record.conversationId, latest)
          }
        })
      }
    },

    inUseItems(): PluginInUseItem[] {
      return listAllRecords()
        .filter((record) => record.phase === 'active')
        .map((record) => ({
          kind: 'model_borrow',
          id: String(record.conversationId),
          label: `Conversation #${record.conversationId} is actively borrowing ${record.targetLabel}`,
        }))
    },

    async stop(): Promise<void> {
      stopping = true
      const pending = [...convQueues.values()]
      if (pending.length > 0) {
        await Promise.allSettled(pending)
      }
      convQueues.clear()
      await kv.flush()
    },

    getBorrow(conversationId: number): TierBorrowSessionView | null {
      const conv = ctx.host.getConversation(conversationId)
      if (!isTiersBorrowEligible(conv)) return null
      const record = kv.get(kvKey(conversationId))
      return record !== undefined ? toTierBorrowSessionView(record) : null
    },

    setBorrow(
      conversationId: number,
      input: { model: string; effort?: string; source?: TierBorrowSource },
    ): Promise<TierBorrowSessionView> {
      return enqueueConversation(conversationId, () =>
        armBorrowUnlocked(conversationId, input.model, {
          effort: input.effort,
          source: input.source ?? 'ui',
        }),
      )
    },

    clearBorrow(conversationId: number): Promise<ClearBorrowResult> {
      return enqueueConversation(conversationId, async () => {
        if (stopping) {
          throw new HelmxError('plugin_stopping', 'builtin:tiers is stopping', 409, { conversationId })
        }
        ctx.host.getConversation(conversationId)
        const existing = kv.get(kvKey(conversationId))
        if (existing === undefined) {
          return { cleared: false }
        }
        await saveRecord(conversationId, undefined)
        return { cleared: true, previousPhase: existing.phase }
      })
    },

    async handleInput(payload: HookPayloadMap['input']): Promise<HookResult<HookPayloadMap['input']>> {
      if (stopping) return { action: 'continue' }
      if (payload.input.origin !== 'human') return { action: 'continue' }

      const parsedSlash = parseModelSlashInput(payload.input.text)
      const parsedMeta = parseTiersBorrowInputMeta(payload.input.meta)
      const existingFast = kv.get(kvKey(payload.conversationId))
      if (!parsedSlash.matched && !parsedMeta.present && existingFast === undefined) {
        return { action: 'continue' }
      }

      const convFast = getConversationOrUndefined(
        (id) => ctx.host.getConversation(id),
        payload.conversationId,
      )
      if (convFast === undefined || !isTiersBorrowEligible(convFast)) {
        return { action: 'continue' }
      }

      return enqueueConversation(convFast.id, async (): Promise<HookResult<HookPayloadMap['input']>> => {
        if (stopping) return { action: 'continue' }
        let conv = getConversationOrUndefined((id) => ctx.host.getConversation(id), convFast.id)
        if (conv === undefined || !isTiersBorrowEligible(conv)) {
          return { action: 'continue' }
        }

        // Self-heal lingering idle active borrow before processing the next human input.
        const currentRecord = kv.get(kvKey(conv.id))
        if (currentRecord?.phase === 'active' && !isConversationBusy(conv)) {
          await restoreIfIdleUnlocked(conv.id)
          conv = getConversationOrUndefined((id) => ctx.host.getConversation(id), conv.id)
          if (conv === undefined) return { action: 'continue' }
        }

        if (parsedSlash.matched) {
          if (parsedSlash.kind === 'bare') {
            return {
              action: 'block',
              reason:
                'Usage: /model <tier-or-provider/model> [message]. Specify a tier (e.g. tier/architect) or model (e.g. provider/modelId).',
            }
          }
          if (isConversationBusy(conv)) {
            return {
              action: 'block',
              reason:
                'Cannot borrow a model via /model while the conversation is busy. Wait for the current turn to settle first.',
            }
          }
          const hasAttachments = (payload.input.attachments?.length ?? 0) > 0
          if (parsedSlash.remainder === '' && !hasAttachments) {
            try {
              await armBorrowUnlocked(conv.id, parsedSlash.targetRef, { source: 'slash' })
              return { action: 'handled' }
            } catch (err) {
              return { action: 'block', reason: ctx.host.redact(errorMessageOf(err)) }
            }
          }
          try {
            await activateBorrowUnlocked(conv.id, parsedSlash.targetRef, {
              source: 'slash',
              restoreAfterTurn: true,
            })
            return {
              action: 'transform',
              value: {
                ...payload,
                input: {
                  ...payload.input,
                  text: parsedSlash.remainder,
                },
              },
            }
          } catch (err) {
            return { action: 'block', reason: ctx.host.redact(errorMessageOf(err)) }
          }
        }

        if (parsedMeta.present) {
          if (!parsedMeta.valid) {
            return { action: 'block', reason: parsedMeta.reason }
          }
          if (isConversationBusy(conv)) {
            return { action: 'continue' }
          }
          try {
            await activateBorrowUnlocked(conv.id, parsedMeta.borrowModel, {
              effort: parsedMeta.effort,
              source: 'meta',
              restoreAfterTurn: true,
            })
            return { action: 'continue' }
          } catch (err) {
            return { action: 'block', reason: ctx.host.redact(errorMessageOf(err)) }
          }
        }

        const armed = kv.get(kvKey(conv.id))
        if (armed !== undefined && armed.phase === 'armed') {
          if (isConversationBusy(conv)) {
            return { action: 'continue' }
          }
          try {
            await activateBorrowUnlocked(conv.id, armed.targetModel, {
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
      return enqueueConversation(conversationId, () => restoreIfIdleUnlocked(conversationId))
    },

    handleConversationDeleted(conversationId: number): Promise<void> {
      return enqueueConversation(conversationId, async () => {
        if (kv.get(kvKey(conversationId)) === undefined) {
          syncSessionDoc(conversationId, undefined)
          return
        }
        await saveRecord(conversationId, undefined)
      })
    },

    handleConversationReset(conversationId: number): Promise<void> {
      return enqueueConversation(conversationId, async () => {
        if (stopping) return
        const existing = kv.get(kvKey(conversationId))
        if (existing === undefined) return
        if (existing.phase === 'armed') {
          await saveRecord(conversationId, undefined)
          return
        }
        const conv = getConversationOrUndefined((id) => ctx.host.getConversation(id), conversationId)
        if (conv === undefined || !isConversationBusy(conv)) {
          await saveRecord(conversationId, undefined)
        }
      })
    },

    executeSwitchModelTool(
      input: SwitchModelToolInput,
      context: PluginToolContext,
    ): Promise<PluginToolResultEnvelope> {
      const conversationId = context.conversationId
      return enqueueConversation(conversationId, async (): Promise<PluginToolResultEnvelope> => {
        if (stopping) {
          return { output: 'builtin:tiers is stopping; cannot switch model.', isError: true }
        }
        try {
          const outcome = await activateBorrowUnlocked(conversationId, input.model, {
            effort: input.effort,
            source: 'tool',
            restoreAfterTurn: input.restoreAfterTurn,
            allowWhileBusy: true,
          })
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
            ...(outcome.resolved.targetTierId !== undefined
              ? { tierId: outcome.resolved.targetTierId }
              : {}),
            ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
            restoreAfterTurn: outcome.restoreAfterTurn,
            changed: outcome.changed,
          }
          const effortClause = effectiveEffort !== undefined ? ` [effort: ${effectiveEffort}]` : ''
          const output = outcome.restoreAfterTurn
            ? `Switched conversation model to ${outcome.resolved.targetLabel} (${presentationMeta.toModel})${effortClause}. Your next reasoning step runs on this model, and the original model will be restored automatically when this turn finishes — continue directly with your response without calling switch_model again to restore.`
            : `Permanently switched conversation model to ${outcome.resolved.targetLabel} (${presentationMeta.toModel})${effortClause}. Subsequent turns will remain on this model.`
          return { output, presentationMeta }
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
