/**
 * `FtsRepo`: table-scoped repository for `helmx_conversation_fts` + `helmx_fts_map` derived full-text index.
 *
 * Handles idempotent point indexing/removal via `helmx_fts_map` rowids, serialized atomic `rebuild()`,
 * concurrent write-delta overlay folding, and redacted trigram/short-term search queries.
 */

import type { SearchHit } from '@helmx/protocol'
import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import {
  buildFtsSearchSql,
  buildSearchSnippet,
  parseSearchTerms,
  validateSearchOptions,
  type SearchOptions,
} from '../fts-search.js'
import type { SqliteMirrorQueue } from './write-queue.js'

type FtsRebuildOverlayOp =
  | { op: 'upsert'; conversationId: number; entryId: string; title: string; body: string }
  | { op: 'removeEntries'; conversationId: number; entryIds: readonly string[] }
  | { op: 'deleteConv'; conversationId: number }
  | { op: 'updateTitle'; conversationId: number; title: string }

/** Replays every conversation entry into `index` (redaction happens inside the repo, never in the caller). */
type FtsReplay = (index: (conversationId: number, entryId: string, title: string, body: string) => void) => Promise<void>

/** Replayed, already-redacted FTS row awaiting the atomic swap (tuple read by index while folding overlays). */
type RebuildRow = [conversationId: number, entryId: string, title: string, body: string]
/** Replay batch keyed by `${conversationId}\0${entryId}` so per-conversation overlays can address rows by key prefix. */
type RebuildBatch = Map<string, RebuildRow>

const rebuildRowKey = (conversationId: number, entryId: string): string => `${conversationId}\0${entryId}`

/** Overlay `deleteConv`: drop every replayed row of a conversation so deleted conversations never resurrect in the swap. */
function dropConversationRows(batch: RebuildBatch, conversationId: number): void {
  const prefix = `${conversationId}\0`
  for (const key of [...batch.keys()]) {
    if (key.startsWith(prefix)) batch.delete(key)
  }
}

/** Overlay `updateTitle`: overwrite the title of every replayed row of a conversation. */
function retitleConversationRows(batch: RebuildBatch, conversationId: number, title: string): void {
  const prefix = `${conversationId}\0`
  for (const [key, row] of batch) {
    if (key.startsWith(prefix)) row[2] = title
  }
}

/** Fold one captured live mutation onto the replay batch. */
function foldOverlayOp(batch: RebuildBatch, op: FtsRebuildOverlayOp): void {
  switch (op.op) {
    case 'upsert':
      batch.set(rebuildRowKey(op.conversationId, op.entryId), [op.conversationId, op.entryId, op.title, op.body])
      return
    case 'removeEntries':
      for (const entryId of op.entryIds) batch.delete(rebuildRowKey(op.conversationId, entryId))
      return
    case 'deleteConv':
      return dropConversationRows(batch, op.conversationId)
    case 'updateTitle':
      return retitleConversationRows(batch, op.conversationId, op.title)
  }
}

/** Drop tombstoned conversations and prefer live titles so the swapped index mirrors current state, not stale replay text. */
function reconcileBatchWithLiveState(batch: RebuildBatch, deps: FtsRepoDeps): void {
  for (const [key, row] of [...batch.entries()]) {
    if (deps.isDeleted(row[0])) {
      batch.delete(key)
      continue
    }
    const liveTitle = deps.getLiveTitle(row[0])
    if (liveTitle !== undefined) row[2] = deps.redact(liveTitle)
  }
}

export interface FtsRepoDeps {
  redact(text: string): string
  isDeleted(conversationId: number): boolean
  getLiveTitle(conversationId: number): string | undefined
  markFtsRebuiltInTx(tx: SqliteExecutor): Promise<void>
  onFtsRebuilt(): void
}

export class FtsRepo {
  /** Serializes concurrent `rebuild` invocations so overlays and swaps never interleave. */
  private ftsRebuildChain: Promise<void> = Promise.resolve()
  /** Active write-delta log capturing live FTS/title/delete mutations during async `rebuild` replay. */
  private ftsRebuildOverlay: FtsRebuildOverlayOp[] | null = null

  constructor(
    private readonly queue: SqliteMirrorQueue,
    private readonly deps: FtsRepoDeps,
  ) {}

  recordTitleChangeOverlay(conversationId: number, redactedTitle: string): void {
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({
        op: 'updateTitle',
        conversationId,
        title: redactedTitle,
      })
    }
  }

  recordDeleteConvOverlay(conversationId: number): void {
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({ op: 'deleteConv', conversationId })
    }
  }

  updateTitleInTx(tx: SqliteExecutor, conversationId: number, redactedTitle: string): Promise<void> {
    return tx.run(
      'UPDATE helmx_conversation_fts SET title = ? WHERE rowid IN (SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ?)',
      redactedTitle,
      conversationId,
    )
  }

  async deleteByConversationInTx(tx: SqliteExecutor, conversationId: number): Promise<void> {
    await tx.run(
      'DELETE FROM helmx_conversation_fts WHERE rowid IN (SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ?)',
      conversationId,
    )
    await tx.run('DELETE FROM helmx_fts_map WHERE conversation_id = ?', conversationId)
  }

  /**
   * Index conversation text (input/answer/tool summary); body is redacted before storing.
   * `(conversation_id, entry_id)` idempotent: repeated indexing of the same entry (e.g., observer replay)
   * deletes then inserts inside one transaction so FTS5 (which lacks unique constraints) never gets duplicate rows.
   */
  index(conversationId: number, entryId: string, title: string, body: string): void {
    this.queue.assertWritable()
    const safeTitle = this.deps.redact(title)
    const safeBody = this.deps.redact(body)
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({
        op: 'upsert',
        conversationId,
        entryId,
        title: safeTitle,
        body: safeBody,
      })
    }
    this.queue.enqueue(() =>
      this.queue.db.transaction(async (tx) => {
        const existing = await tx.get<{ fts_rowid: number }>(
          'SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
          conversationId,
          entryId,
        )
        if (existing !== undefined) {
          await tx.run('DELETE FROM helmx_conversation_fts WHERE rowid = ?', existing.fts_rowid)
          await tx.run(
            'DELETE FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
            conversationId,
            entryId,
          )
        }
        await tx.run(
          'INSERT INTO helmx_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
          conversationId,
          entryId,
          safeTitle,
          safeBody,
        )
        const inserted = await tx.get<{ rid: number }>('SELECT last_insert_rowid() AS rid')
        await tx.run(
          'INSERT INTO helmx_fts_map (conversation_id, entry_id, fts_rowid) VALUES (?, ?, ?)',
          conversationId,
          entryId,
          inserted!.rid,
        )
      }),
    )
  }

  /** Full-text search index (rebuildable derived index; never touches `pi_` table semantics). */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    const validated = validateSearchOptions(options)
    // Wait for queued writes to drain completely (throws on errors) so queries observe persisted latest state.
    await this.queue.flushPublic()
    const parsed = parseSearchTerms(query)
    const sqlQuery = buildFtsSearchSql(parsed, validated)
    if (sqlQuery === undefined) return []
    const rows = await this.queue.db.all<{
      conversation_id: number
      entry_id: string
      title: string
      body: string
    }>(sqlQuery.sql, ...sqlQuery.params)
    // Defensive deduplication: at most one entry per `(conversation_id, entry_id)`, skip tombstones,
    // and collapse title-only hits (zero body matches) to at most one conversation-level hit without `entryId`.
    const seen = new Set<string>()
    const bodyMatchedConvs = new Set<number>()
    const titleOnlyConvs = new Set<number>()
    const candidates: Array<{ hit: SearchHit; isBodyMatch: boolean }> = []
    for (const r of rows) {
      if (this.deps.isDeleted(r.conversation_id)) continue
      const key = `${r.conversation_id}\0${r.entry_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const rawTitle = this.deps.getLiveTitle(r.conversation_id) ?? r.title
      const title = this.deps.redact(rawTitle)
      const safeBody = this.deps.redact(r.body)
      const { snippet, highlights } = buildSearchSnippet(safeBody, parsed.terms)
      if (highlights.length > 0) {
        bodyMatchedConvs.add(r.conversation_id)
        candidates.push({
          isBodyMatch: true,
          hit: {
            conversationId: r.conversation_id,
            entryId: r.entry_id,
            ...(title !== '' ? { title } : {}),
            snippet,
            highlights,
          },
        })
      } else {
        if (titleOnlyConvs.has(r.conversation_id) || bodyMatchedConvs.has(r.conversation_id)) continue
        titleOnlyConvs.add(r.conversation_id)
        candidates.push({
          isBodyMatch: false,
          hit: {
            conversationId: r.conversation_id,
            ...(title !== '' ? { title } : {}),
            snippet,
            highlights,
          },
        })
      }
    }
    const out: SearchHit[] = []
    for (const candidate of candidates) {
      if (!candidate.isBodyMatch && bodyMatchedConvs.has(candidate.hit.conversationId)) continue
      out.push(candidate.hit)
      if (out.length >= sqlQuery.limit) break
    }
    return out
  }

  /**
   * Delete specific FTS entries in a conversation (cleans truncated entries' derived index on in-place overwrite).
   * Touches only `helmx_conversation_fts` derived table without affecting `pi_` semantics; no-ops on empty list.
   */
  removeEntries(conversationId: number, entryIds: ReadonlyArray<string>): void {
    if (entryIds.length === 0) return
    this.queue.assertWritable()
    const ids = [...entryIds]
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({ op: 'removeEntries', conversationId, entryIds: ids })
    }
    this.queue.enqueue(() =>
      this.queue.db.transaction(async (tx) => {
        for (const entryId of ids) {
          const existing = await tx.get<{ fts_rowid: number }>(
            'SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
            conversationId,
            entryId,
          )
          if (existing !== undefined) {
            await tx.run('DELETE FROM helmx_conversation_fts WHERE rowid = ?', existing.fts_rowid)
            await tx.run(
              'DELETE FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
              conversationId,
              entryId,
            )
          }
        }
      }),
    )
  }

  /**
   * FTS is a rebuildable derived index: clearing + replaying all conversation text + stamping `fts_schema_version`
   * run inside **the same transaction**, rolling back atomically on failure (preserving the previous index rather
   * than dropping it and faking success). Concurrent rebuilds are serialized and live mutations during async replay
   * are captured in an overlay and folded atomically before swap so no writes are lost and no deleted conversations resurrect.
   */
  async rebuild(replay: FtsReplay): Promise<void> {
    this.queue.assertWritable()
    const run = this.ftsRebuildChain.then(() => this.runRebuild(replay))
    this.ftsRebuildChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  waitForRebuild(): Promise<void> {
    return this.ftsRebuildChain
  }

  private async runRebuild(replay: FtsReplay): Promise<void> {
    this.queue.assertWritable()
    await this.queue.flushPublic()
    const overlay: FtsRebuildOverlayOp[] = []
    this.ftsRebuildOverlay = overlay
    try {
      const batch = await this.replayIntoBatch(replay)
      await this.queue.drainQuiescent()
      this.queue.assertWritable()
      for (const op of overlay) foldOverlayOp(batch, op)
      reconcileBatchWithLiveState(batch, this.deps)
      this.ftsRebuildOverlay = null
      await this.swapIndex(batch)
      this.deps.onFtsRebuilt()
    } finally {
      if (this.ftsRebuildOverlay === overlay) {
        this.ftsRebuildOverlay = null
      }
    }
  }

  /** Replay all conversation text into a fresh redacted batch (the overlay is armed first so live writes are captured). */
  private async replayIntoBatch(replay: FtsReplay): Promise<RebuildBatch> {
    const batch: RebuildBatch = new Map()
    await replay((conversationId, entryId, title, body) => {
      batch.set(rebuildRowKey(conversationId, entryId), [
        conversationId,
        entryId,
        this.deps.redact(title),
        this.deps.redact(body),
      ])
    })
    return batch
  }

  /** Replace the whole derived index with the replay batch and stamp `fts_schema_version` in one transaction. */
  private async swapIndex(batch: RebuildBatch): Promise<void> {
    await this.queue.db.transaction(async (tx) => {
      await tx.exec('DELETE FROM helmx_conversation_fts')
      await tx.exec('DELETE FROM helmx_fts_map')
      let nextRowId = 0
      for (const [conversationId, entryId, title, body] of batch.values()) {
        nextRowId += 1
        await tx.run(
          'INSERT INTO helmx_conversation_fts (rowid, conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?, ?)',
          nextRowId,
          conversationId,
          entryId,
          title,
          body,
        )
        await tx.run(
          'INSERT INTO helmx_fts_map (conversation_id, entry_id, fts_rowid) VALUES (?, ?, ?)',
          conversationId,
          entryId,
          nextRowId,
        )
      }
      await this.deps.markFtsRebuiltInTx(tx)
    })
  }
}
