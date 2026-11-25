/**
 * `TombstoneRepo`: table-scoped mirror and transactional insert helper for `helmx_tombstones`.
 */

import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import type { SqliteMirrorQueue } from './write-queue.js'

export class TombstoneRepo {
  /** Logical deletion tombstones: prevents re-importing SDK-retained history after restarts. */
  private readonly tombstones = new Set<number>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{ id: number }>('SELECT id FROM helmx_tombstones')) {
      this.tombstones.add(row.id)
    }
  }

  isDeleted(id: number): boolean {
    return this.tombstones.has(id)
  }

  markDeletedInMemory(id: number): void {
    this.tombstones.add(id)
  }

  insertInTx(tx: SqliteExecutor, id: number, deletedAt: number): Promise<void> {
    return tx.run('INSERT OR IGNORE INTO helmx_tombstones (id, deleted_at) VALUES (?, ?)', id, deletedAt)
  }
}
