/**
 * Conversation detail pagination, cursor codec, and FTS index maintenance.
 *
 * Responsibilities:
 * - Detail timeline retrieval, filtering out entries covered by closed helmx.rewind intervals while preserving marker entries;
 * - Pagination cursor base64url validation and encoding/decoding;
 * - Full FTS index rebuild (filtering rewound entries).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { ConversationDetail, ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { SecretStash } from '../services/index.js'
import { assistantTextOfModel, entryModelText, toConversationEntry } from './entries.js'
import { projectDetailEntry, stripEntrySignatures } from './entry-projection.js'
import { coveredByRewind, rewindIntervalOf, type RewindInterval } from './conversation-rewind.js'
import { pageVisibleEntries, pageVisibleTurns } from './conversation-pagination.js'
import { getSdkConversation, readSdkEntryPage, scanSdkEntries } from './sdk-ids.js'
import type { HelmxStore } from './store.js'

/** Maximum encoded pagination cursor length (base64url; rejects oversized cursors to prevent abuse). */
const DETAIL_CURSOR_MAX_LENGTH = 2048
/** Max per-conversation rewind-interval cache entries (bounded eviction prevents leaks across delete cycles). */
const REWIND_CACHE_MAX_ENTRIES = 256
/** Max turns per turn-aligned detail page (`?turns=1..50`). */
export const MAX_PAGE_TURNS = 50

interface RewindCacheEntry {
  readonly stateChangeSeq: number
  readonly lastEntryId: number
  readonly cuts: RewindInterval[]
}

interface ConversationDetailHost {
  readonly harness: Harness
  readonly store: HelmxStore
  readonly stash: SecretStash
  readonly getConversation: (id: number) => ConversationSummary
  readonly collectRewindIntervals: (
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ) => Promise<RewindInterval[]>
  /** Non-blocking background contextUsage refresh trigger (optional; falls back to fire-and-forget ensureContextUsage). */
  readonly scheduleContextUsage?: (id: number) => void
  /** contextUsage refresh chain trigger (called fire-and-forget without blocking detail return). */
  readonly ensureContextUsage?: (id: number) => Promise<void>
}

export class ConversationDetailService {
  private readonly rewindCache = new Map<number, RewindCacheEntry>()

  constructor(private readonly host: ConversationDetailHost) {}

  private putRewindCache(id: number, stateChangeSeq: number, lastEntryId: number, cuts: RewindInterval[]): void {
    if (lastEntryId <= 0) return
    if (!this.rewindCache.has(id) && this.rewindCache.size >= REWIND_CACHE_MAX_ENTRIES) {
      const oldest = this.rewindCache.keys().next().value
      if (oldest !== undefined) this.rewindCache.delete(oldest)
    }
    this.rewindCache.set(id, { stateChangeSeq, lastEntryId, cuts })
  }

  private async resolveRewindIntervals(
    id: number,
    summary: ConversationSummary,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    const lastEntryId = summary.lastEntryId ?? 0
    if (lastEntryId > 0) {
      const cached = this.rewindCache.get(id)
      if (cached !== undefined && cached.stateChangeSeq === summary.stateChangeSeq && cached.lastEntryId === lastEntryId) {
        return cached.cuts
      }
    }
    const cuts = await this.host.collectRewindIntervals(conversation)
    if (lastEntryId > 0) {
      this.putRewindCache(id, summary.stateChangeSeq, lastEntryId, cuts)
    }
    return cuts
  }

  /**
   * Fetch conversation details (summary + paginated timeline):
   * - Server uniformly filters out historical entries covered by closed helmx.rewind intervals ([fromEntryId, throughEntryId])
   *   while retaining the helmx.rewind marker entries themselves (matching frontend SSE interval deduplication);
   * - Aggregates rewind intervals on each detail read (simple implementation with no extra durable cache/tables),
   *   then paginates backwards via SDK raw cursors while filtering covered entries until `limit` is filled or no more remain;
   * - Cursors are base64url(JSON {conversationId, cursor: SDK next}): bound to the conversation, checked for length and
   *   valid JSON, and `limit` is bounded to 1..500 without silent clamping;
   * - Entries preserve model messages and data, redacted at boundary with the same secret redactor as events;
   * - contextUsage refresh is decoupled asynchronously so slow usage calculations never block timeline delivery;
   *   when uncached usage finishes computing in the background, `conversation.upsert` pushes it to subscribers.
   */
  async getConversationDetail(
    id: number,
    options?: { limit?: number; turns?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const detail = await this.assembleDetail(id, options)
    if (this.host.scheduleContextUsage !== undefined) {
      this.host.scheduleContextUsage(id)
    } else if (this.host.ensureContextUsage !== undefined) {
      try {
        void Promise.resolve(this.host.ensureContextUsage(id)).catch(() => {})
      } catch {
        // background usage refresh errors must not block detail response
      }
    }
    return { ...detail, ...this.host.getConversation(id) }
  }

  /** Assemble detail body (paginated+projected entries + initial summary; updated summary overrides afterwards). */
  private async assembleDetail(
    id: number,
    options?: { limit?: number; turns?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    if (options?.limit !== undefined && options?.turns !== undefined) {
      throw new HelmxError('validation_error', 'limit and turns are mutually exclusive', 400)
    }
    const turns = options?.turns
    if (turns !== undefined && (!Number.isInteger(turns) || turns < 1 || turns > MAX_PAGE_TURNS)) {
      throw new HelmxError(
        'validation_error',
        `turns must be an integer between 1 and ${MAX_PAGE_TURNS} (received ${turns})`,
        400,
        { turns },
      )
    }
    const summary = this.host.getConversation(id)
    const limit = turns === undefined ? (options?.limit ?? 100) : undefined
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new HelmxError('validation_error', `limit must be an integer between 1 and 500 (received ${limit})`, 400, {
        limit,
      })
    }
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    // Descending first-page invariant: every `helmx.rewind` entry is appended strictly after its
    // `throughEntryId`, so descending scans from the tail always encounter every covering marker before
    // any covered older entry. Skip the redundant full ascending pre-scan on Page 1 and collect cuts inline.
    const collectInline = sdkCursor === undefined
    const rewindCuts = collectInline
      ? []
      : await this.resolveRewindIntervals(id, summary, conversation)
    const { collected, nextCursor } =
      turns !== undefined
        ? await pageVisibleTurns(conversation, turns, sdkCursor, rewindCuts, collectInline)
        : await pageVisibleEntries(conversation, limit!, sdkCursor, rewindCuts, collectInline)
    if (collectInline && nextCursor === undefined && (summary.lastEntryId ?? 0) > 0) {
      this.putRewindCache(id, summary.stateChangeSeq, summary.lastEntryId!, [...rewindCuts])
    }

    // HTTP detail boundary projection: filter pi.system + strip signatures + truncate safe plain-text tool results
    // (see entry-projection.ts). SSE / waitForInput never go through this projection.
    const entries: ConversationEntry[] = []
    for (const raw of collected.reverse()) {
      const projected = projectDetailEntry(toConversationEntry(raw as { id: number; kind: string }))
      if (projected !== undefined) entries.push(projected)
    }
    return {
      ...summary,
      entries,
      ...(nextCursor !== undefined ? { nextCursor: this.encodeDetailCursor(id, nextCursor as Readonly<Record<string, unknown>>) } : {}),
    }
  }

  /**
   * Single timeline entry (GET /api/conversations/:id/entries/:entryId):
   * - Exact lookup (min=max=entryId limit 1, never scans pages); validates both conversationId and entryId strictly;
   * - Same rewind visibility as detail pagination: entries covered by helmx.rewind or internal pi.system records
   *   return 404 (helmx.rewind marker entries remain visible, matching pagination);
   * - Untruncated yet redacted: strips opaque signatures without truncating payload text; original DB data untouched.
   */
  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      throw new HelmxError('validation_error', `entryId must be a positive safe integer (received ${String(entryId)})`, 400, {
        conversationId: id,
        entryId,
      })
    }
    const summary = this.host.getConversation(id)
    const conversation = await getSdkConversation(this.host.harness, id, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
    const page = await readSdkEntryPage(conversation, entryId, BACKGROUND_CONTEXT)
    const raw = page.items[0]
    if (raw === undefined || Number(raw.id) !== entryId) {
      throw new HelmxError('not_found', `entry ${entryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId,
      })
    }
    // Identical visibility to detail pagination: rewound entries and pi.system model records remain invisible
    // even when queried directly by ID.
    if (raw.kind === 'pi.system') {
      throw new HelmxError('not_found', `entry ${entryId} is an internal model record (pi.system) and not visible`, 404, {
        conversationId: id,
        entryId,
      })
    }
    const rewindCuts = await this.resolveRewindIntervals(id, summary, conversation)
    if (raw.kind !== 'helmx.rewind' && coveredByRewind(entryId, rewindCuts)) {
      throw new HelmxError('not_found', `entry ${entryId} was hidden by in-place overwrite & resend`, 404, {
        conversationId: id,
        entryId,
      })
    }
    return stripEntrySignatures(toConversationEntry(raw))
  }

  /** Encode pagination cursor: base64url(JSON {conversationId, cursor}). */
  encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** Decode and validate pagination cursor: verifies conversation ownership, max length, and JSON structure. */
  decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmxError('validation_error', 'cursor exceeds maximum length', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmxError('validation_error', 'cursor is not valid base64url JSON', 400)
    }
    const shape = decoded as { conversationId?: unknown; cursor?: unknown }
    if (
      shape === null ||
      typeof shape !== 'object' ||
      Number(shape.conversationId) !== conversationId ||
      typeof shape.cursor !== 'object' ||
      shape.cursor === null
    ) {
      throw new HelmxError(
        'validation_error',
        `cursor does not belong to conversation ${conversationId} or has invalid structure`,
        400,
      )
    }
    return shape.cursor
  }

  /** FTS rebuild (delegated by host rebuildFts; internal records and entries hidden by rewind are never re-indexed). */
  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    await this.host.store.rebuildFts(async (index) => {
      for (const conv of listConversationIds()) {
        const conversation = await getSdkConversation(this.host.harness, conv.id, BACKGROUND_CONTEXT)
        if (!conversation) continue
        // Filter covered entries across all closed helmx.rewind [from, through] intervals after full scan so superseded
        // entries are never re-indexed (shares identical interval rules with collectRewindIntervals and detail projection).
        const rewindCuts: RewindInterval[] = []
        const indexed: Array<{ id: number; entryKey: string; text: string }> = []
        let cursor: unknown = undefined
        for (;;) {
          const page = await scanSdkEntries(conversation, 'ascending', 50, cursor, BACKGROUND_CONTEXT)
          for (const record of page.items) {
            if (record.kind === 'helmx.rewind') {
              const interval = rewindIntervalOf(record)
              if (interval !== undefined) rewindCuts.push(interval)
              continue
            }
            if (
              record.kind === 'pi.system' ||
              record.kind === 'pi.tool-result' ||
              record.kind === 'pi.compaction' ||
              record.kind === 'pi.reset'
            ) {
              continue
            }
            if (record.kind === 'helmx.input') {
              const data =
                record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)
                  ? (record.data as { id?: unknown; text?: unknown })
                  : undefined
              const text =
                typeof data?.text === 'string' && data.text !== ''
                  ? data.text
                  : entryModelText(record)
              const entryKey =
                typeof data?.id === 'string' && data.id !== ''
                  ? `input:${data.id}`
                  : `entry:${record.id}`
              if (text) indexed.push({ id: Number(record.id), entryKey, text })
              continue
            }
            const text =
              record.kind === 'pi.assistant'
                ? assistantTextOfModel(record.model) || entryModelText(record)
                : entryModelText(record)
            if (text) indexed.push({ id: Number(record.id), entryKey: `entry:${record.id}`, text })
          }
          if (!page.next) break
          cursor = page.next
        }
        for (const item of indexed) {
          if (coveredByRewind(item.id, rewindCuts)) continue
          index(conv.id, item.entryKey, conv.title, this.host.stash.redact(item.text))
        }
      }
    })
  }
}
