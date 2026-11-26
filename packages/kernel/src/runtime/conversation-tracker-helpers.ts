/**
 * Pure snapshot-adoption, compaction-detection, and summary helpers extracted from `conversations.ts`.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { EntryRecord, Harness } from '@earendil-works/pi-durable'
import {
  deriveConversationTitle,
  type ConversationStatus,
  type ConversationSummary,
  type TurnOutcome,
} from '@helmx/protocol'
import { assistantTextOfEntry, type EntryRecordLike } from './entries.js'
import { coveredByRewind, rewindIntervalOf, type RewindInterval } from './conversation-rewind.js'
import type { HelmxInputMeta, LiveStateShape } from './conversation-mirror.js'
import { asConversationId, getSdkConversation, getSdkSubmission, readSdkEntryPage } from './sdk-ids.js'
import type { ConvMeta } from './store.js'

export { deriveConversationTitle as deriveTitle }

export function statusNow(meta: ConvMeta, outcome: TurnOutcome): ConversationStatus {
  if (outcome === 'failed') return 'error'
  if (outcome === 'aborted') return 'idle'
  return meta.unread ? 'done' : 'idle'
}

/** Semantic summary fingerprint: status/doing/pendingAskCount/lastError/timing (other fields do not participate in push dedupe). */
export function summaryKeyOf(summary: ConversationSummary): string {
  return `${summary.status}|${summary.doing ?? ''}|${summary.pendingAskCount}|${summary.lastError ?? ''}|${summary.runStartedAt ?? ''}|${summary.runDurationMs ?? 0}|${summary.pendingAskSince ?? ''}`
}

/** Build human-readable diagnostic summary from live.runFailure ('reason: detail'; omitted for non-error aborted/reset). */
export function lastErrorOf(
  live: LiveStateShape | undefined,
  redact: (text: string) => string,
): string | undefined {
  const failure = live?.runFailure
  if (!failure || failure.reason === 'aborted' || failure.reason === 'reset') return undefined
  const detail =
    typeof failure.detail === 'string' && failure.detail.trim() !== ''
      ? `: ${redact(failure.detail).slice(0, 400)}`
      : ''
  return `${failure.reason}${detail}`
}

/** Compute latest visible entry ID (excluding `pi.system` and entries covered by `helmx.rewind`; `0` when none). */
export function latestVisibleEntryIdOf(entries: ReadonlyArray<EntryRecordLike>): number {
  const cuts: RewindInterval[] = []
  for (const raw of entries) {
    if (raw.kind !== 'helmx.rewind') continue
    const cut = rewindIntervalOf(raw)
    if (cut !== undefined) cuts.push(cut)
  }
  let latest = 0
  for (const raw of entries) {
    const numeric = Number(raw.id)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
    if (raw.kind === 'pi.system') continue
    if (raw.kind !== 'helmx.rewind' && coveredByRewind(numeric, cuts)) continue
    if (numeric > latest) latest = numeric
  }
  return latest
}

/** Find newest non-rewound `pi.assistant` entry with non-empty text in an ascending window. */
export function findLatestAssistantEntry(
  entries: ReadonlyArray<EntryRecord>,
): { entryId: number; text: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry === undefined) continue
    if (entry.kind === 'helmx.rewind' || entry.kind === 'pi.reset') break
    if (entry.kind === 'pi.assistant') {
      const text = assistantTextOfEntry(entry)
      if (text !== '') {
        return { entryId: Number(entry.id), text }
      }
    }
  }
  return undefined
}

/** Scan entry window watermarks for initial attachment without emitting events. */
export function collectWindowWatermarks(
  entries: ReadonlyArray<EntryRecord>,
  initialWatermark: number,
  initialSeenEntryId: number,
): { watermark: number; usageWatermark: number; seenEntryId: number } {
  let watermark = initialWatermark
  let usageWatermark = -1
  let seenEntryId = initialSeenEntryId
  for (const raw of entries) {
    const numeric = Number(raw.id)
    if (!Number.isFinite(numeric)) continue
    if (numeric > watermark) watermark = numeric
    if (numeric > usageWatermark) usageWatermark = numeric
    if (numeric > seenEntryId) seenEntryId = numeric
  }
  return { watermark, usageWatermark, seenEntryId }
}

/** Extract validated `helmx.input` metadata records from an entry slice, optionally filtered by `id >= minEntryId`. */
export function extractHelmxInputMetas(
  entries: ReadonlyArray<EntryRecord>,
  minEntryId?: number,
): Array<HelmxInputMeta & { id: string; text: string }> {
  const metas: Array<HelmxInputMeta & { id: string; text: string }> = []
  for (const entry of entries) {
    if (minEntryId !== undefined) {
      const numeric = Number(entry.id)
      if (!Number.isFinite(numeric) || numeric < minEntryId) continue
    }
    if (entry.kind !== 'helmx.input') continue
    const data = entry.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    const record = data as Record<string, unknown>
    if (typeof record['id'] !== 'string' || typeof record['text'] !== 'string') continue
    metas.push(record as unknown as HelmxInputMeta & { id: string; text: string })
  }
  return metas
}

/** Detect new `pi.compaction` commits and finished compaction tasks that completed without appending an entry. */
export function detectCompactionTransitions(
  entries: ReadonlyArray<EntryRecord>,
  prev: LiveStateShape | undefined,
  live: LiveStateShape | undefined,
  prevSeenEntryId: number,
): {
  nextSeenEntryId: number
  finishedCompactionsToReconcile: ReadonlyArray<{ taskId: number; trigger: string; blocking: boolean }>
} {
  let nextSeenEntryId = prevSeenEntryId
  let hasNewCompactionEntry = false
  for (const raw of entries) {
    const numeric = Number(raw.id)
    if (!Number.isFinite(numeric) || numeric <= prevSeenEntryId) continue
    if (numeric > nextSeenEntryId) nextSeenEntryId = numeric
    if (raw.kind === 'pi.compaction') hasNewCompactionEntry = true
  }
  const prevCompactions = prev?.compactions ?? []
  const nextCompactions = live?.compactions ?? []
  const nextTaskIds = new Set(nextCompactions.map((c) => c.taskId))
  const finishedCompactions = prevCompactions.filter((c) => !nextTaskIds.has(c.taskId))
  const shouldReconcile =
    finishedCompactions.length > 0 &&
    nextCompactions.length === 0 &&
    !hasNewCompactionEntry &&
    live?.run === undefined
  return {
    nextSeenEntryId,
    finishedCompactionsToReconcile: shouldReconcile ? finishedCompactions : [],
  }
}

/** Back-read `helmx.input` entries and `(submissionId, requestId)` bindings for a recovered active run. */
export async function loadRunInputEntriesFromSdk(
  harness: Harness,
  id: number,
  submissionIds: readonly number[],
): Promise<{ entries: EntryRecord[]; pairs: Array<{ submissionId: number; requestId: string }> }> {
  if (submissionIds.length === 0) return { entries: [], pairs: [] }
  const conversation = await getSdkConversation(harness, id, BACKGROUND_CONTEXT)
  if (!conversation) return { entries: [], pairs: [] }
  const out: EntryRecord[] = []
  const pairs: Array<{ submissionId: number; requestId: string }> = []
  for (const submissionId of submissionIds) {
    const submission = await getSdkSubmission(harness, submissionId, BACKGROUND_CONTEXT)
    if (!submission) continue
    const record = await submission.status(BACKGROUND_CONTEXT)
    if (record.conversationId !== asConversationId(id)) continue
    const entryId = 'entry' in record ? record.entry : undefined
    if (entryId !== undefined) {
      const page = await readSdkEntryPage(conversation, entryId, BACKGROUND_CONTEXT)
      const raw = page.items[0]
      if (raw !== undefined) out.push(raw)
    }
    if (record.requestId !== undefined) pairs.push({ submissionId, requestId: record.requestId })
  }
  return { entries: out, pairs }
}
