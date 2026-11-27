/**
 * builtin:steps state persistence, per-conversation serialization, sessionDoc projection,
 * and lifecycle convergence (turn settlement, human input auto-clear, reset, rewind, delete).
 */
import {
  HelmxError,
  isJsonObject,
  type HelmxPluginContext,
  type PluginKvHandle,
  type PluginSessionDocHandle,
} from '@helmx/protocol'
import {
  createKeyedQueue,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  isConversationNotFoundError,
  listAllKvEntries,
} from '../shared-helpers.js'
import {
  STEPS_TOOL_UPDATE,
  buildStepsPresentationMeta,
  createEmptyStepsSessionView,
  isStepsAllCompleted,
  isStepsAllTerminal,
  isStepsConversationEligible,
  normalizeStepItems,
  parseStepsConversationRecord,
  parseStepsToolPresentationMeta,
  toStepsActionView,
  toStepsSessionView,
  type StepItem,
  type StepsConversationRecord,
  type StepsSessionView,
  type StepsSettledOutcome,
  type StepsToolPresentationMeta,
} from './contracts.js'

const REWIND_SCAN_PAGE_LIMIT = 500
const REWIND_SCAN_MAX_PAGES = 5

export interface StepsStateManager {
  isStopping(): boolean
  setStopping(stopping: boolean): void
  hydrate(): void
  stop(): Promise<void>
  updateSteps(
    conversationId: number,
    rawSteps: unknown,
  ): Promise<{ view: StepsSessionView | null; meta: StepsToolPresentationMeta }>
  getView(conversationId: number): StepsSessionView
  clear(conversationId: number): Promise<StepsSessionView>
  dismiss(conversationId: number): Promise<StepsSessionView>
  handleHumanInput(conversationId: number): Promise<void>
  handleTurnSettled(conversationId: number, outcome: StepsSettledOutcome): Promise<void>
  handleReset(conversationId: number): Promise<void>
  handleRewind(conversationId: number): Promise<void>
  handleConversationDeleted(conversationId: number): Promise<void>
}

function parsePositiveIntKey(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined
  const num = Number(raw)
  return Number.isSafeInteger(num) && num >= 1 ? num : undefined
}

function extractStepsMetaFromEntry(entry: { kind: string; model?: unknown[] }): StepsToolPresentationMeta | undefined {
  if (entry.kind !== 'pi.tool-result' || !Array.isArray(entry.model)) return undefined
  for (let i = entry.model.length - 1; i >= 0; i--) {
    const message = entry.model[i]
    if (!isJsonObject(message)) continue
    if (message['role'] !== 'toolResult' && message['role'] !== 'tool') continue
    if (message['toolName'] !== STEPS_TOOL_UPDATE) continue
    if (message['isError'] === true) continue
    const parsed = parseStepsToolPresentationMeta(message['details'])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function createStepsStateManager(deps: {
  ctx: HelmxPluginContext
  kv: PluginKvHandle<StepsConversationRecord>
  stepsDoc: PluginSessionDocHandle<StepsSessionView | null>
  now: () => number
}): StepsStateManager {
  const { ctx, kv, stepsDoc, now } = deps
  const queue = createKeyedQueue<number>()
  const records = new Map<number, StepsConversationRecord>()
  let stopping = false

  const persistRecord = async (
    conversationId: number,
    nextRecord: StepsConversationRecord | undefined,
  ): Promise<void> => {
    const prevRecord = records.get(conversationId)
    const key = String(conversationId)
    if (nextRecord === undefined || nextRecord.steps.length === 0) {
      records.delete(conversationId)
      kv.delete(key)
    } else {
      records.set(conversationId, nextRecord)
      kv.set(key, nextRecord)
    }
    try {
      await kv.flush()
    } catch (err) {
      // Revert synchronous in-memory/KV mirror on flush failure so memory stays aligned with SQLite.
      if (prevRecord !== undefined) {
        records.set(conversationId, prevRecord)
        kv.set(key, prevRecord)
      } else {
        records.delete(conversationId)
        kv.delete(key)
      }
      throw err
    }

    const view = toStepsSessionView(nextRecord)
    ignoreConversationNotFound(() => {
      if (view === null) stepsDoc.delete(conversationId)
      else stepsDoc.set(conversationId, view)
    })
  }

  const assertActive = (conversationId: number): void => {
    if (stopping) {
      throw new HelmxError('plugin_stopping', 'builtin:steps is stopping', 409, { conversationId })
    }
  }

  const requireEligibleConversation = (conversationId: number): void => {
    const conv = ctx.host.getConversation(conversationId)
    if (!isStepsConversationEligible(conv)) {
      throw new HelmxError(
        'steps_unsupported_conversation',
        `Live steps checklist is only supported on top-level human conversations (conversation ${conv.id} is not eligible)`,
        403,
        { conversationId: conv.id },
      )
    }
  }

  const findLatestVisibleStepsBeforeRewind = async (
    conversationId: number,
  ): Promise<StepsToolPresentationMeta | undefined> => {
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < REWIND_SCAN_MAX_PAGES; pageIndex++) {
      const detail = await ctx.host.getConversationDetail(conversationId, {
        limit: REWIND_SCAN_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (let i = detail.entries.length - 1; i >= 0; i--) {
        const entry = detail.entries[i]!
        if (entry.kind === 'pi.reset') {
          return undefined
        }
        const meta = extractStepsMetaFromEntry(entry)
        if (meta !== undefined) {
          return meta
        }
      }
      if (detail.nextCursor === undefined || detail.nextCursor === '') break
      cursor = detail.nextCursor
    }
    return undefined
  }

  return {
    isStopping: () => stopping,
    setStopping: (value) => {
      stopping = value
    },

    hydrate() {
      records.clear()
      for (const entry of listAllKvEntries(kv)) {
        const convId = parsePositiveIntKey(entry.key)
        const parsed = parseStepsConversationRecord(entry.value)
        if (convId === undefined || parsed === undefined) {
          kv.delete(entry.key)
          continue
        }
        const conv = getConversationOrUndefined(ctx.host, convId)
        if (conv === undefined || !isStepsConversationEligible(conv)) {
          kv.delete(entry.key)
          continue
        }
        records.set(convId, parsed)
        const view = toStepsSessionView(parsed)
        ignoreConversationNotFound(() => {
          if (view === null) stepsDoc.delete(convId)
          else stepsDoc.set(convId, view)
        })
      }
    },

    async stop() {
      stopping = true
      await queue.drain()
      records.clear()
    },

    async updateSteps(conversationId, rawSteps) {
      assertActive(conversationId)
      const normalizedSteps: StepItem[] = normalizeStepItems(rawSteps, (text) => ctx.host.redact(text))
      requireEligibleConversation(conversationId)

      return queue.enqueue(conversationId, async () => {
        assertActive(conversationId)
        requireEligibleConversation(conversationId)
        const prev = records.get(conversationId)
        const nextVersion = (prev?.version ?? 0) + 1
        const meta = buildStepsPresentationMeta(normalizedSteps, nextVersion)

        if (normalizedSteps.length === 0) {
          await persistRecord(conversationId, undefined)
          return { view: null, meta }
        }

        const nextRecord: StepsConversationRecord = {
          steps: normalizedSteps,
          version: nextVersion,
          updatedAt: now(),
        }
        await persistRecord(conversationId, nextRecord)
        return { view: toStepsSessionView(nextRecord), meta }
      })
    },

    getView(conversationId) {
      const conv = ctx.host.getConversation(conversationId)
      if (!isStepsConversationEligible(conv)) {
        return createEmptyStepsSessionView()
      }
      return toStepsActionView(records.get(conversationId))
    },

    clear(conversationId) {
      assertActive(conversationId)
      requireEligibleConversation(conversationId)
      return queue.enqueue(conversationId, async () => {
        assertActive(conversationId)
        requireEligibleConversation(conversationId)
        if (records.has(conversationId)) {
          await persistRecord(conversationId, undefined)
        } else {
          ignoreConversationNotFound(() => stepsDoc.delete(conversationId))
        }
        return createEmptyStepsSessionView()
      })
    },

    dismiss(conversationId) {
      assertActive(conversationId)
      requireEligibleConversation(conversationId)
      return queue.enqueue(conversationId, async () => {
        assertActive(conversationId)
        requireEligibleConversation(conversationId)
        const current = records.get(conversationId)
        if (current === undefined) {
          return createEmptyStepsSessionView()
        }
        if (current.dismissedAtVersion === current.version) {
          return toStepsActionView(current)
        }
        const nextRecord: StepsConversationRecord = {
          ...current,
          dismissedAtVersion: current.version,
        }
        await persistRecord(conversationId, nextRecord)
        return toStepsActionView(nextRecord)
      })
    },

    handleHumanInput(conversationId) {
      if (stopping || !records.has(conversationId)) return Promise.resolve()
      return queue.enqueue(conversationId, async () => {
        if (stopping) return
        const current = records.get(conversationId)
        if (current === undefined) return
        if (isStepsAllTerminal(current.steps)) {
          await persistRecord(conversationId, undefined)
          return
        }
        if (current.settledOutcome !== undefined) {
          const { settledOutcome: _cleared, ...rest } = current
          await persistRecord(conversationId, rest)
        }
      })
    },

    handleTurnSettled(conversationId, outcome) {
      if (stopping || !records.has(conversationId)) return Promise.resolve()
      return queue.enqueue(conversationId, async () => {
        if (stopping) return
        const current = records.get(conversationId)
        if (current === undefined) return
        if (isStepsAllCompleted(current.steps)) {
          // Cleanly completed checklists (done/skipped only) close immediately once the turn settles.
          await persistRecord(conversationId, undefined)
          return
        }
        if (isStepsAllTerminal(current.steps)) {
          if (current.settledOutcome !== undefined) {
            const { settledOutcome: _cleared, ...rest } = current
            await persistRecord(conversationId, rest)
          }
          return
        }
        if (current.settledOutcome === outcome) return
        await persistRecord(conversationId, {
          ...current,
          settledOutcome: outcome,
        })
      })
    },

    handleReset(conversationId) {
      if (stopping || !records.has(conversationId)) return Promise.resolve()
      return queue.enqueue(conversationId, async () => {
        if (stopping || !records.has(conversationId)) return
        await persistRecord(conversationId, undefined)
      })
    },

    handleRewind(conversationId) {
      if (stopping) return Promise.resolve()
      const conv = getConversationOrUndefined(ctx.host, conversationId)
      if (conv === undefined || !isStepsConversationEligible(conv)) {
        return Promise.resolve()
      }
      return queue.enqueue(conversationId, async () => {
        if (stopping) return
        let latestMeta: StepsToolPresentationMeta | undefined
        try {
          latestMeta = await findLatestVisibleStepsBeforeRewind(conversationId)
        } catch (err) {
          if (isConversationNotFoundError(err)) {
            if (records.has(conversationId)) await persistRecord(conversationId, undefined)
            return
          }
          throw err
        }
        if (stopping) return

        // Avoid resurrecting an already-completed checklist when rewinding a subsequent turn;
        // only active/incomplete checklists before the rewind cut remain active.
        if (latestMeta === undefined || latestMeta.steps.length === 0 || latestMeta.allTerminal) {
          if (records.has(conversationId)) {
            await persistRecord(conversationId, undefined)
          } else {
            ignoreConversationNotFound(() => stepsDoc.delete(conversationId))
          }
          return
        }

        const current = records.get(conversationId)
        const nextVersion = (current?.version ?? 0) + 1
        const nextRecord: StepsConversationRecord = {
          steps: latestMeta.steps.map((step) => ({ title: step.title, status: step.status })),
          version: nextVersion,
          updatedAt: now(),
        }
        await persistRecord(conversationId, nextRecord)
      })
    },

    handleConversationDeleted(conversationId) {
      if (!records.has(conversationId)) {
        kv.delete(String(conversationId))
        return Promise.resolve()
      }
      return queue.enqueue(conversationId, async () => {
        records.delete(conversationId)
        kv.delete(String(conversationId))
        await kv.flush().catch(() => {})
        ignoreConversationNotFound(() => stepsDoc.delete(conversationId))
      })
    },
  }
}
