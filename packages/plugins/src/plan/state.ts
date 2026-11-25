/**
 * builtin:plan state persistence, projection sync, per-conversation serialization, and lifecycle tracking.
 */
import {
  HelmxError,
  type ConversationSummary,
  type HelmxPluginContext,
  type PluginDocHandle,
  type PluginInUseItem,
  type PluginKvHandle,
  type PluginSessionDocHandle,
} from '@helmx/protocol'
import {
  isPlanConversationEligible,
  validateAndRedactPlanDraft,
  type PlanBadgeEntry,
  type PlanBadgesDoc,
  type PlanConversationRecord,
  type PlanDraftSummary,
  type PlanMode,
  type PlanSessionView,
} from './contracts.js'

export interface PlanInFlightAsk {
  askId: string
  conversationId: number
  promise: Promise<unknown>
}

export interface PlanStateManager {
  isStopping(): boolean
  setStopping(stopping: boolean): void
  enqueueConversation<T>(conversationId: number, op: () => Promise<T>): Promise<T>
  getRecord(conversationId: number): PlanConversationRecord | undefined
  writeRecord(conversationId: number, record: PlanConversationRecord): void
  deleteRecord(conversationId: number): void
  listAllRecords(): PlanConversationRecord[]
  flushKv(): Promise<void>
  syncProjections(conversationId: number, record: PlanConversationRecord | undefined): void
  hydrateProjections(): void
  cancelAskSafe(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
  trackInFlightAsk(askId: string, conversationId: number, promise: Promise<unknown>): void
  deleteInFlightAsk(askId: string): void
  hasInFlightAsk(conversationId: number): boolean
  liveTaskLabels(): string[]
  inUseItems(): PluginInUseItem[]
  requireEligibleConversation(conversationId: number): ConversationSummary
  getView(conversationId: number): PlanSessionView
  enterPlanningMode(conversationId: number): Promise<PlanSessionView>
  supersedePendingAsk(conversationId: number): Promise<void>
  setMode(conversationId: number, mode: PlanMode): Promise<PlanSessionView>
  toggleMode(conversationId: number): Promise<PlanSessionView>
  updateDraft(
    conversationId: number,
    input: { title: string; markdown: string; expectedVersion?: number },
  ): Promise<PlanSessionView>
  markExpectedHandoffReset(conversationId: number): void
  consumeExpectedHandoffReset(conversationId: number): boolean
  clearExpectedHandoffReset(conversationId: number): void
  resetConversationState(conversationId: number): Promise<void>
  cleanupDeletedConversation(conversationId: number): Promise<void>
  reconcileOrphanedAsks(): Promise<void>
  stopAll(): Promise<void>
}

export function createEmptyPlanSessionView(): PlanSessionView {
  return { mode: 'normal', awaitingApproval: false }
}

export function toPlanSessionView(record: PlanConversationRecord | undefined): PlanSessionView {
  if (record === undefined) return createEmptyPlanSessionView()
  const hasPending = record.mode === 'planning' && record.pendingAskId !== undefined
  const awaitingClarification = hasPending && record.pendingAskKind === 'clarify'
  const awaitingApproval = hasPending && !awaitingClarification
  return {
    mode: record.mode,
    awaitingApproval,
    ...(awaitingClarification ? { awaitingClarification: true } : {}),
    ...(record.draft !== undefined ? { draft: record.draft } : {}),
    ...(record.approved !== undefined ? { approved: record.approved } : {}),
  }
}

export function toPlanBadgeEntry(record: PlanConversationRecord | undefined): PlanBadgeEntry | undefined {
  if (record === undefined) return undefined
  if (record.mode === 'planning') {
    if (record.pendingAskId !== undefined) {
      if (record.pendingAskKind === 'clarify') {
        return {
          count: 1,
          tone: 'warn',
          footerText: { en: 'Awaiting clarification', 'zh-CN': '等待澄清回复' },
        }
      }
      return {
        count: 1,
        tone: 'warn',
        footerText: { en: 'Awaiting plan approval', 'zh-CN': '等待计划审批' },
      }
    }
    return {
      count: 1,
      tone: 'accent',
      footerText:
        record.draft !== undefined
          ? { en: `Plan draft v${record.draft.version}`, 'zh-CN': `计划草稿 v${record.draft.version}` }
          : { en: 'Planning mode', 'zh-CN': '计划模式' },
    }
  }
  if (record.approved !== undefined) {
    return {
      count: 1,
      tone: 'neutral',
      footerText: { en: `Approved v${record.approved.version}`, 'zh-CN': `已批准 v${record.approved.version}` },
    }
  }
  if (record.draft !== undefined) {
    return {
      count: 1,
      tone: 'neutral',
      footerText: { en: `Draft v${record.draft.version}`, 'zh-CN': `草稿 v${record.draft.version}` },
    }
  }
  return undefined
}

export function shouldPersistPlanRecord(record: PlanConversationRecord): boolean {
  return (
    record.mode === 'planning' ||
    record.pendingAskId !== undefined ||
    record.draft !== undefined ||
    record.approved !== undefined
  )
}

function isNotFoundOrSettledError(err: unknown): boolean {
  if (!(err instanceof HelmxError)) return false
  return (
    err.status === 404 ||
    err.status === 409 ||
    err.code === 'not_found' ||
    err.code === 'ask_already_settled'
  )
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

export function createPlanStateManager(deps: {
  ctx: HelmxPluginContext
  kv: PluginKvHandle<PlanConversationRecord>
  planDoc: PluginSessionDocHandle<PlanSessionView>
  badgesDoc: PluginDocHandle<PlanBadgesDoc>
}): PlanStateManager {
  const { ctx, kv, planDoc, badgesDoc } = deps

  let stopping = false
  const convQueues = new Map<number, Promise<unknown>>()
  const inFlightAsks = new Map<string, PlanInFlightAsk>()
  const expectedHandoffResets = new Map<number, number>()
  const writtenBadgeJsonByConv = new Map<string, string>()
  let badgesByConv: Record<string, PlanBadgeEntry> = {}
  let badgesHydrated = false

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

  const kvKey = (conversationId: number): string => String(conversationId)

  const getRecord = (conversationId: number): PlanConversationRecord | undefined =>
    kv.get(kvKey(conversationId))

  const writeRecord = (conversationId: number, record: PlanConversationRecord): void => {
    if (shouldPersistPlanRecord(record)) {
      kv.set(kvKey(conversationId), record)
    } else {
      kv.delete(kvKey(conversationId))
    }
  }

  const deleteRecord = (conversationId: number): void => {
    kv.delete(kvKey(conversationId))
  }

  const listAllRecords = (): PlanConversationRecord[] => {
    const records: PlanConversationRecord[] = []
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

  const flushKv = (): Promise<void> => kv.flush()

  const applyBadgeEntry = (conversationId: number, entry: PlanBadgeEntry | undefined): boolean => {
    const key = kvKey(conversationId)
    const nextJson = entry === undefined ? '' : JSON.stringify(entry)
    if (writtenBadgeJsonByConv.get(key) === nextJson) return false
    if (entry === undefined) {
      delete badgesByConv[key]
      writtenBadgeJsonByConv.delete(key)
    } else {
      badgesByConv[key] = entry
      writtenBadgeJsonByConv.set(key, nextJson)
    }
    return true
  }

  const hydrateProjections = (): void => {
    const records = listAllRecords()
    badgesByConv = {}
    writtenBadgeJsonByConv.clear()
    for (const record of records) {
      applyBadgeEntry(record.conversationId, toPlanBadgeEntry(record))
      ignoreConversationNotFound(() => {
        planDoc.set(record.conversationId, toPlanSessionView(record))
      })
    }
    badgesHydrated = true
    badgesDoc.set({ byConversation: { ...badgesByConv } })
  }

  const syncProjections = (
    conversationId: number,
    record: PlanConversationRecord | undefined,
  ): void => {
    if (!badgesHydrated) {
      badgesByConv = { ...badgesDoc.get().byConversation }
      for (const [k, v] of Object.entries(badgesByConv)) {
        writtenBadgeJsonByConv.set(k, JSON.stringify(v))
      }
      badgesHydrated = true
    }
    if (record === undefined) {
      ignoreConversationNotFound(() => {
        planDoc.delete(conversationId)
      })
    } else {
      ignoreConversationNotFound(() => {
        planDoc.set(conversationId, toPlanSessionView(record))
      })
    }
    if (applyBadgeEntry(conversationId, toPlanBadgeEntry(record))) {
      badgesDoc.set({ byConversation: { ...badgesByConv } })
    }
  }

  const cancelAskSafe = async (
    askId: string,
    reason: 'cancelled' | 'superseded',
  ): Promise<void> => {
    try {
      await ctx.host.cancelAsk(askId, reason)
    } catch (err) {
      if (isNotFoundOrSettledError(err)) return
      throw err
    }
  }

  const requireEligibleConversation = (conversationId: number): ConversationSummary => {
    const conv = ctx.host.getConversation(conversationId)
    if (!isPlanConversationEligible(conv)) {
      throw new HelmxError(
        'plan_unsupported_conversation',
        `Plan mode is only supported on top-level human conversations (conversation ${conv.id} is not eligible)`,
        400,
        { conversationId: conv.id },
      )
    }
    return conv
  }

  const applyModeTransition = async (
    conversationId: number,
    nextMode: PlanMode,
    options?: { supersedePending?: boolean },
  ): Promise<PlanSessionView> => {
    const current = getRecord(conversationId)
    let cancelledPendingAskId: string | undefined
    if (nextMode === 'normal' && current?.pendingAskId !== undefined) {
      cancelledPendingAskId = current.pendingAskId
      await cancelAskSafe(current.pendingAskId, 'cancelled')
    } else if (nextMode === 'planning' && options?.supersedePending === true && current?.pendingAskId !== undefined) {
      cancelledPendingAskId = current.pendingAskId
      await cancelAskSafe(current.pendingAskId, 'superseded')
    }
    const latest = getRecord(conversationId)
    const keepPendingAskId =
      nextMode === 'planning' &&
      latest?.pendingAskId !== undefined &&
      latest.pendingAskId !== cancelledPendingAskId
        ? latest.pendingAskId
        : undefined
    const nextRecord: PlanConversationRecord = {
      conversationId,
      mode: nextMode,
      ...(keepPendingAskId !== undefined
        ? {
            pendingAskId: keepPendingAskId,
            ...(latest?.pendingAskKind !== undefined ? { pendingAskKind: latest.pendingAskKind } : {}),
          }
        : {}),
      ...(latest?.draft !== undefined ? { draft: latest.draft } : {}),
      ...(latest?.approved !== undefined ? { approved: latest.approved } : {}),
    }
    writeRecord(conversationId, nextRecord)
    try {
      await flushKv()
    } catch (err) {
      // Revert synchronous KV mirror on flush failure so memory never diverges from SQLite.
      if (latest !== undefined) kv.set(kvKey(conversationId), latest)
      else kv.delete(kvKey(conversationId))
      throw err
    }
    syncProjections(conversationId, shouldPersistPlanRecord(nextRecord) ? nextRecord : undefined)
    return toPlanSessionView(nextRecord)
  }

  const enterPlanningMode = (conversationId: number): Promise<PlanSessionView> =>
    enqueueConversation(conversationId, () =>
      applyModeTransition(conversationId, 'planning', { supersedePending: true }),
    )

  const supersedePendingAsk = (conversationId: number): Promise<void> =>
    enqueueConversation(conversationId, async () => {
      const current = getRecord(conversationId)
      if (current?.pendingAskId === undefined) return
      const askId = current.pendingAskId
      await cancelAskSafe(askId, 'superseded')
      const latest = getRecord(conversationId)
      if (latest === undefined || latest.pendingAskId !== askId) return
      const { pendingAskId: _removed, pendingAskKind: _removedKind, ...rest } = latest
      writeRecord(conversationId, rest)
      try {
        await flushKv()
      } catch (err) {
        kv.set(kvKey(conversationId), latest)
        throw err
      }
      syncProjections(conversationId, shouldPersistPlanRecord(rest) ? rest : undefined)
    })

  const setMode = (conversationId: number, mode: PlanMode): Promise<PlanSessionView> =>
    enqueueConversation(conversationId, async () => {
      requireEligibleConversation(conversationId)
      return applyModeTransition(conversationId, mode)
    })

  const toggleMode = (conversationId: number): Promise<PlanSessionView> =>
    enqueueConversation(conversationId, async () => {
      requireEligibleConversation(conversationId)
      const currentMode = getRecord(conversationId)?.mode ?? 'normal'
      return applyModeTransition(conversationId, currentMode === 'planning' ? 'normal' : 'planning')
    })

  const updateDraft = (
    conversationId: number,
    input: { title: string; markdown: string; expectedVersion?: number },
  ): Promise<PlanSessionView> =>
    enqueueConversation(conversationId, async () => {
      if (stopping) {
        throw new HelmxError('plugin_stopping', 'builtin:plan is stopping', 409, { conversationId })
      }
      requireEligibleConversation(conversationId)
      const current = getRecord(conversationId)
      const mode = current?.mode ?? 'normal'
      if (current?.draft === undefined && mode !== 'planning') {
        throw new HelmxError(
          'validation_error',
          'Cannot update plan draft when no draft exists and conversation is not in planning mode',
          400,
          { conversationId },
        )
      }
      const currentVersion = current?.draft?.version ?? 0
      if (input.expectedVersion !== undefined) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
          throw new HelmxError('validation_error', 'expectedVersion must be a non-negative integer', 400)
        }
        if (currentVersion !== input.expectedVersion) {
          throw new HelmxError(
            'plan_draft_conflict',
            `Plan draft conflict: expected v${input.expectedVersion}, current is v${currentVersion}`,
            409,
            { expectedVersion: input.expectedVersion, currentVersion },
          )
        }
      }
      const validated = validateAndRedactPlanDraft(input.title, input.markdown, (text) => ctx.host.redact(text))
      if (!validated.ok) {
        throw new HelmxError('validation_error', validated.message, 400, { conversationId })
      }
      const draft: PlanDraftSummary = {
        title: validated.title,
        markdown: validated.markdown,
        version: currentVersion + 1,
        updatedAt: Date.now(),
      }
      const nextRecord: PlanConversationRecord = {
        ...current,
        conversationId,
        mode,
        draft,
      }
      writeRecord(conversationId, nextRecord)
      try {
        await flushKv()
      } catch (err) {
        if (current !== undefined) kv.set(kvKey(conversationId), current)
        else kv.delete(kvKey(conversationId))
        throw err
      }
      syncProjections(conversationId, nextRecord)
      return toPlanSessionView(nextRecord)
    })

  const markExpectedHandoffReset = (conversationId: number): void => {
    expectedHandoffResets.set(conversationId, (expectedHandoffResets.get(conversationId) ?? 0) + 1)
  }

  const consumeExpectedHandoffReset = (conversationId: number): boolean => {
    const count = expectedHandoffResets.get(conversationId) ?? 0
    if (count <= 0) return false
    if (count === 1) expectedHandoffResets.delete(conversationId)
    else expectedHandoffResets.set(conversationId, count - 1)
    return true
  }

  const clearExpectedHandoffReset = (conversationId: number): void => {
    expectedHandoffResets.delete(conversationId)
  }

  const resetConversationState = (conversationId: number): Promise<void> =>
    enqueueConversation(conversationId, async () => {
      if (stopping) return
      const existing = getRecord(conversationId)
      if (existing === undefined) return
      if (existing.pendingAskId !== undefined) {
        await cancelAskSafe(existing.pendingAskId, 'superseded')
      }
      deleteRecord(conversationId)
      await flushKv()
      syncProjections(conversationId, undefined)
    })

  const getView = (conversationId: number): PlanSessionView => {
    const conv = ctx.host.getConversation(conversationId)
    if (!isPlanConversationEligible(conv)) {
      return createEmptyPlanSessionView()
    }
    return toPlanSessionView(getRecord(conversationId))
  }

  const cleanupDeletedConversation = (conversationId: number): Promise<void> =>
    enqueueConversation(conversationId, async () => {
      expectedHandoffResets.delete(conversationId)
      const existing = getRecord(conversationId)
      if (existing?.pendingAskId !== undefined) {
        await cancelAskSafe(existing.pendingAskId, 'cancelled')
      }
      deleteRecord(conversationId)
      await flushKv()
      syncProjections(conversationId, undefined)
    })

  const reconcileOrphanedAsks = async (): Promise<void> => {
    const candidates = listAllRecords().filter(
      (r) => r.pendingAskId !== undefined && !inFlightAsks.has(r.pendingAskId),
    )
    if (candidates.length === 0) return
    let changed = false
    for (const candidate of candidates) {
      await enqueueConversation(candidate.conversationId, async () => {
        const latest = getRecord(candidate.conversationId)
        if (latest === undefined || latest.pendingAskId !== candidate.pendingAskId) return
        await cancelAskSafe(latest.pendingAskId!, 'superseded')
        const { pendingAskId: _removed, pendingAskKind: _removedKind, ...rest } = latest
        writeRecord(candidate.conversationId, rest)
        changed = true
      })
    }
    if (changed) {
      await flushKv()
      hydrateProjections()
    }
  }

  const stopAll = async (): Promise<void> => {
    stopping = true
    expectedHandoffResets.clear()
    const active = [...inFlightAsks.values()]
    for (const task of active) {
      void cancelAskSafe(task.askId, 'cancelled').catch(() => {})
    }
    if (active.length > 0) {
      await Promise.allSettled(active.map((task) => task.promise))
    }
    await flushKv()
  }

  return {
    isStopping: () => stopping,
    setStopping: (value) => {
      stopping = value
    },
    enqueueConversation,
    getRecord,
    writeRecord,
    deleteRecord,
    listAllRecords,
    flushKv,
    syncProjections,
    hydrateProjections,
    cancelAskSafe,
    trackInFlightAsk: (askId, conversationId, promise) => {
      inFlightAsks.set(askId, { askId, conversationId, promise })
    },
    deleteInFlightAsk: (askId) => {
      inFlightAsks.delete(askId)
    },
    hasInFlightAsk: (conversationId) => {
      for (const task of inFlightAsks.values()) {
        if (task.conversationId === conversationId) return true
      }
      return false
    },
    liveTaskLabels: () =>
      Array.from(inFlightAsks.values(), (task) => `plan:ask:${task.conversationId}:${task.askId}`),
    inUseItems: () =>
      listAllRecords()
        .filter((record) => record.mode === 'planning')
        .map((record) => ({
          kind: 'plan_session',
          id: String(record.conversationId),
          label: `Conversation #${record.conversationId} is currently in planning mode`,
        })),
    requireEligibleConversation,
    getView,
    enterPlanningMode,
    supersedePendingAsk,
    setMode,
    toggleMode,
    updateDraft,
    markExpectedHandoffReset,
    consumeExpectedHandoffReset,
    clearExpectedHandoffReset,
    resetConversationState,
    cleanupDeletedConversation,
    reconcileOrphanedAsks,
    stopAll,
  }
}
