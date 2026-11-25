/**
 * `ArtifactRepo`: table-scoped mirror and per-conversation index for `helmx_artifacts`.
 */

import type { ArtifactKind } from '@helmx/protocol'
import { HelmxError, isArtifactKind } from '@helmx/protocol'
import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import { addConvIndex, removeConvIndex } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export interface ArtifactRow {
  id: string
  conversationId: number
  kind: ArtifactKind
  name: string
  path: string
  mimeType: string
  size: number
  createdAt: number
}

export class ArtifactRepo {
  private readonly artifacts = new Map<string, ArtifactRow>()
  private readonly artifactsByConv = new Map<number, Set<string>>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{
      id: string
      conversation_id: number
      kind: string
      name: string
      path: string
      mime_type: string
      size: number
      created_at: number
    }>('SELECT id, conversation_id, kind, name, path, mime_type, size, created_at FROM helmx_artifacts')) {
      if (!isArtifactKind(row.kind)) {
        throw new HelmxError(
          'store_data_corrupted',
          `Persisted data corrupted (helmx_artifacts#${row.id}.kind): invalid artifact kind '${String(row.kind)}'`,
          500,
          { id: row.id, kind: row.kind },
        )
      }
      this.artifacts.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind,
        name: row.name,
        path: row.path,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
      })
      addConvIndex(this.artifactsByConv, row.conversation_id, row.id)
    }
  }

  list(conversationId?: number): ArtifactRow[] {
    if (conversationId !== undefined) {
      const ids = this.artifactsByConv.get(conversationId)
      if (ids === undefined || ids.size === 0) return []
      const out: ArtifactRow[] = []
      for (const id of ids) {
        const row = this.artifacts.get(id)
        if (row !== undefined) out.push({ ...row })
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    }
    return [...this.artifacts.values()]
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): ArtifactRow | undefined {
    const row = this.artifacts.get(id)
    return row ? { ...row } : undefined
  }

  put(row: ArtifactRow): void {
    this.queue.assertWritable()
    if (!isArtifactKind(row.kind)) {
      throw new HelmxError('validation_error', `Invalid artifact kind: ${String(row.kind)}`, 400, {
        id: row.id,
        kind: row.kind,
      })
    }
    const prev = this.artifacts.get(row.id)
    if (prev !== undefined && prev.conversationId !== row.conversationId) {
      removeConvIndex(this.artifactsByConv, prev.conversationId, row.id)
    }
    this.artifacts.set(row.id, { ...row })
    addConvIndex(this.artifactsByConv, row.conversationId, row.id)
    this.queue.enqueue(() =>
      this.queue.db.run(
        `INSERT INTO helmx_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, path=excluded.path, mime_type=excluded.mime_type, size=excluded.size`,
        row.id,
        row.conversationId,
        row.kind,
        row.name,
        row.path,
        row.mimeType,
        row.size,
        row.createdAt,
      ),
    )
  }

  deleteByConversation(conversationId: number): string[] {
    this.queue.assertWritable()
    const removed = this.deleteByConversationInMemory(conversationId)
    this.queue.enqueue(() =>
      this.queue.db.run('DELETE FROM helmx_artifacts WHERE conversation_id = ?', conversationId),
    )
    return removed
  }

  deleteByConversationInMemory(conversationId: number): string[] {
    const ids = this.artifactsByConv.get(conversationId)
    const removed: string[] = ids ? [...ids] : []
    if (ids !== undefined) {
      for (const id of ids) this.artifacts.delete(id)
      this.artifactsByConv.delete(conversationId)
    }
    return removed
  }

  deleteByConversationInTx(tx: SqliteExecutor, conversationId: number): Promise<void> {
    return tx.run('DELETE FROM helmx_artifacts WHERE conversation_id = ?', conversationId)
  }
}
