/**
 * `PluginDocRepo`: table-scoped mirror and SQLite persistence for `helmx_plugin_docs`.
 */

import { parseStoredJson } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export class PluginDocRepo {
  private readonly pluginDocs = new Map<string, string>() // pluginId\0name -> json

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{ plugin_id: string; name: string; value: string }>(
      'SELECT plugin_id, name, value FROM helmx_plugin_docs',
    )) {
      parseStoredJson<unknown>(`helmx_plugin_docs#${row.plugin_id}:${row.name}.value`, row.value)
      this.pluginDocs.set(row.plugin_id + '\0' + row.name, row.value)
    }
  }

  get(pluginId: string, name: string): string | undefined {
    return this.pluginDocs.get(pluginId + '\0' + name)
  }

  /** `valueJson` must be valid JSON: callers that just serialized via `JSON.stringify` may pass `prevalidated: true`. */
  put(pluginId: string, name: string, valueJson: string, options?: { prevalidated?: boolean }): void {
    this.queue.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(`helmx_plugin_docs#${pluginId}:${name}.value`, valueJson)
    }
    this.pluginDocs.set(pluginId + '\0' + name, valueJson)
    this.queue.enqueue(() =>
      this.queue.db.run(
        `INSERT INTO helmx_plugin_docs (plugin_id, name, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        valueJson,
        Date.now(),
      ),
    )
  }

  /**
   * Delete all global documents belonging to a plugin (unload cleanup).
   *
   * Global documents live under `__global` with `name = '${pluginId}:${docName}'`. Since `pluginId` itself may
   * contain colons (e.g. `foo:bar`) while `docName` forbids colons (`assertValidId`), plain prefix matching would
   * delete across plugins (`foo` matching `foo:bar:doc`); precise matching requires `${pluginId}:` prefix AND no colon in remainder.
   */
  deleteGlobalPluginDocs(pluginId: string): void {
    this.queue.assertWritable()
    const prefix = `${pluginId}:`
    const rowPrefix = `__global\0${prefix}`
    for (const key of [...this.pluginDocs.keys()]) {
      if (!key.startsWith(rowPrefix)) continue
      if (key.slice(rowPrefix.length).includes(':')) continue
      this.pluginDocs.delete(key)
    }
    this.queue.enqueue(() =>
      this.queue.db.run(
        `DELETE FROM helmx_plugin_docs
         WHERE plugin_id = '__global' AND substr(name, 1, ?) = ? AND instr(substr(name, ?), ':') = 0`,
        prefix.length,
        prefix,
        prefix.length + 1,
      ),
    )
  }
}
