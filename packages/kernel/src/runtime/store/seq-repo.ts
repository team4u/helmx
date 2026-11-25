/**
 * `SeqRepo`: table-scoped mirror and coalesced watermark persistence for `helmx_seq`
 * (`events` watermark and `fts_schema_version` derived-index marker).
 */

import { HelmxError } from '@helmx/protocol'
import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import { FTS_SCHEMA_VERSION, FTS_SCHEMA_VERSION_KEY } from '../sqlite.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export class SeqRepo {
  private eventSeq = 0
  /** Coalesced target value for in-queue `helmx_seq` flushes (updated in place before the queued task starts). */
  private pendingEventSeq: number | undefined = undefined
  private seqFlushQueued = false
  private ftsSchemaVersion = 0

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    const seqRow = await this.queue.db.get<{ value: number }>(
      "SELECT value FROM helmx_seq WHERE key = 'events'",
    )
    this.eventSeq = seqRow?.value ?? 0
    const ftsVerRow = await this.queue.db.get<{ value: number }>(
      'SELECT value FROM helmx_seq WHERE key = ?',
      FTS_SCHEMA_VERSION_KEY,
    )
    this.ftsSchemaVersion = ftsVerRow?.value ?? 0
  }

  /** True when the derived FTS5 table was newly migrated/recreated or a prior rebuild did not finish committing. */
  get needsFtsRebuild(): boolean {
    return this.ftsSchemaVersion !== FTS_SCHEMA_VERSION
  }

  get eventSeqNow(): number {
    return this.eventSeq
  }

  /**
   * Persist event sequence: accepts non-negative safe integers only and never regresses monotonically.
   * Coalesces bursts in-queue on the FIFO tail chain (updating `pendingEventSeq` in place if the queued task
   * has not started executing yet, with zero timers and 100% strict `flushPublic()` FIFO semantics).
   */
  setEventSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HelmxError('invalid_event_seq', `Event sequence must be a non-negative safe integer, received: ${seq}`, 500, {
        seq,
      })
    }
    this.queue.assertWritable()
    if (seq < this.eventSeq) return // Reject regression: keep the higher watermark
    this.eventSeq = seq
    this.pendingEventSeq = seq
    if (this.seqFlushQueued) return
    this.seqFlushQueued = true
    this.queue.enqueue(async () => {
      this.seqFlushQueued = false
      const target = this.pendingEventSeq
      this.pendingEventSeq = undefined
      if (target === undefined) return
      await this.queue.db.run(
        "INSERT INTO helmx_seq (key, value) VALUES ('events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        target,
      )
    })
  }

  markFtsRebuiltInTx(tx: SqliteExecutor): Promise<void> {
    return tx.run(
      'INSERT INTO helmx_seq (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      FTS_SCHEMA_VERSION_KEY,
      FTS_SCHEMA_VERSION,
    )
  }

  markFtsSchemaCurrent(): void {
    this.ftsSchemaVersion = FTS_SCHEMA_VERSION
  }
}
