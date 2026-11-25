/**
 * `PluginSessionDocRepo`: table-scoped mirror and per-conversation secondary index for `helmx_plugin_session_docs`.
 */

import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import { addConvIndex, parseStoredJson, removeConvIndex } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export class PluginSessionDocRepo {
  /** Per-conversation plugin document mirror: `pluginId\0name\0conversationId -> json`. */
  private readonly pluginSessionDocs = new Map<string, string>()
  private readonly sessionDocsByConv = new Map<number, Set<string>>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{ plugin_id: string; name: string; conversation_id: number; value: string }>(
      'SELECT plugin_id, name, conversation_id, value FROM helmx_plugin_session_docs',
    )) {
      parseStoredJson<unknown>(
        `helmx_plugin_session_docs#${row.plugin_id}:${row.name}#${row.conversation_id}.value`,
        row.value,
      )
      const sessionKey = `${row.plugin_id}\0${row.name}\0${row.conversation_id}`
      this.pluginSessionDocs.set(sessionKey, row.value)
      addConvIndex(this.sessionDocsByConv, row.conversation_id, sessionKey)
    }
  }

  /** Read per-conversation document mirror (returns `undefined` if unwritten; caller falls back to initial value). */
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.pluginSessionDocs.get(`${pluginId}\0${name}\0${conversationId}`)
  }

  /** Write per-conversation document (`valueJson` must be valid JSON; pre-serialized callers may pass `prevalidated: true`). */
  put(
    pluginId: string,
    name: string,
    conversationId: number,
    valueJson: string,
    options?: { prevalidated?: boolean },
  ): void {
    this.queue.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(
        `helmx_plugin_session_docs#${pluginId}:${name}#${conversationId}.value`,
        valueJson,
      )
    }
    const sessionKey = `${pluginId}\0${name}\0${conversationId}`
    this.pluginSessionDocs.set(sessionKey, valueJson)
    addConvIndex(this.sessionDocsByConv, conversationId, sessionKey)
    this.queue.enqueue(() =>
      this.queue.db.run(
        `INSERT INTO helmx_plugin_session_docs (plugin_id, name, conversation_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, name, conversation_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        conversationId,
        valueJson,
        Date.now(),
      ),
    )
  }

  delete(pluginId: string, name: string, conversationId: number): void {
    this.queue.assertWritable()
    const sessionKey = `${pluginId}\0${name}\0${conversationId}`
    this.pluginSessionDocs.delete(sessionKey)
    removeConvIndex(this.sessionDocsByConv, conversationId, sessionKey)
    this.queue.enqueue(() =>
      this.queue.db.run(
        'DELETE FROM helmx_plugin_session_docs WHERE plugin_id = ? AND name = ? AND conversation_id = ?',
        pluginId,
        name,
        conversationId,
      ),
    )
  }

  /** Delete all per-conversation documents belonging to a plugin (unload cleanup; dedicated `plugin_id` column ensures exact match). */
  deleteByPlugin(pluginId: string): void {
    this.queue.assertWritable()
    const prefix = pluginId + '\0'
    for (const key of [...this.pluginSessionDocs.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.pluginSessionDocs.delete(key)
      const convId = Number(key.split('\0')[2])
      if (Number.isSafeInteger(convId)) {
        removeConvIndex(this.sessionDocsByConv, convId, key)
      }
    }
    this.queue.enqueue(() =>
      this.queue.db.run('DELETE FROM helmx_plugin_session_docs WHERE plugin_id = ?', pluginId),
    )
  }

  /** List all conversation IDs (ascending) for which a plugin document has been persisted. */
  listConversations(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of this.pluginSessionDocs.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const convId = Number(key.split('\0')[2])
      if (Number.isSafeInteger(convId) && convId > 0) out.push(convId)
    }
    return out.sort((a, b) => a - b)
  }

  deleteByConversationInMemory(conversationId: number): void {
    const sessionKeys = this.sessionDocsByConv.get(conversationId)
    if (sessionKeys === undefined) return
    for (const key of sessionKeys) this.pluginSessionDocs.delete(key)
    this.sessionDocsByConv.delete(conversationId)
  }

  deleteByConversationInTx(tx: SqliteExecutor, conversationId: number): Promise<void> {
    return tx.run('DELETE FROM helmx_plugin_session_docs WHERE conversation_id = ?', conversationId)
  }
}
