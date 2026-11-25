/**
 * `PluginKvRepo`: table-scoped mirror, prefix/cursor pagination, and SQLite persistence for `helmx_plugin_kv`.
 */

import { compareCodeUnit } from '@helmx/protocol'
import { parseStoredJson } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export class PluginKvRepo {
  /** Per-plugin keyed KV mirror: `pluginId -> namespace -> key -> { valueJson, updatedAt }`. */
  private readonly pluginKv = new Map<string, Map<string, Map<string, { valueJson: string; updatedAt: number }>>>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{
      plugin_id: string
      namespace: string
      key: string
      value_json: string
      updated_at: number
    }>('SELECT plugin_id, namespace, key, value_json, updated_at FROM helmx_plugin_kv')) {
      parseStoredJson<unknown>(
        `helmx_plugin_kv#${row.plugin_id}:${row.namespace}/${row.key}.value_json`,
        row.value_json,
      )
      this.setMirror(row.plugin_id, row.namespace, row.key, row.value_json, row.updated_at)
    }
  }

  get(pluginId: string, namespace: string, key: string): { valueJson: string; updatedAt: number } | undefined {
    const entry = this.pluginKv.get(pluginId)?.get(namespace)?.get(key)
    return entry ? { valueJson: entry.valueJson, updatedAt: entry.updatedAt } : undefined
  }

  put(
    pluginId: string,
    namespace: string,
    key: string,
    valueJson: string,
    options?: { prevalidated?: boolean; updatedAt?: number },
  ): number {
    this.queue.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(`helmx_plugin_kv#${pluginId}:${namespace}/${key}.value_json`, valueJson)
    }
    const updatedAt = options?.updatedAt ?? Date.now()
    this.setMirror(pluginId, namespace, key, valueJson, updatedAt)
    this.queue.enqueue(() =>
      this.queue.db.run(
        `INSERT INTO helmx_plugin_kv (plugin_id, namespace, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        pluginId,
        namespace,
        key,
        valueJson,
        updatedAt,
      ),
    )
    return updatedAt
  }

  deleteKey(pluginId: string, namespace: string, key: string): boolean {
    this.queue.assertWritable()
    const byNs = this.pluginKv.get(pluginId)
    const byKey = byNs?.get(namespace)
    if (!byKey || !byKey.delete(key)) return false
    if (byKey.size === 0) byNs!.delete(namespace)
    if (byNs!.size === 0) this.pluginKv.delete(pluginId)
    this.queue.enqueue(() =>
      this.queue.db.run(
        'DELETE FROM helmx_plugin_kv WHERE plugin_id = ? AND namespace = ? AND key = ?',
        pluginId,
        namespace,
        key,
      ),
    )
    return true
  }

  list(
    pluginId: string,
    namespace: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): { items: Array<{ key: string; valueJson: string; updatedAt: number }>; nextCursor?: string } {
    const byKey = this.pluginKv.get(pluginId)?.get(namespace)
    if (!byKey || byKey.size === 0) return { items: [] }
    const prefix = opts?.prefix
    const cursor = opts?.cursor
    const limit = opts?.limit
    const keys: string[] = []
    for (const key of byKey.keys()) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      if (cursor !== undefined && compareCodeUnit(key, cursor) <= 0) continue
      keys.push(key)
    }
    keys.sort(compareCodeUnit)
    const hasMore = limit !== undefined && keys.length > limit
    const pageKeys = hasMore ? keys.slice(0, limit) : keys
    const items = pageKeys.map((key) => {
      const entry = byKey.get(key)!
      return { key, valueJson: entry.valueJson, updatedAt: entry.updatedAt }
    })
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.key } : {}),
    }
  }

  clearNamespace(pluginId: string, namespace: string): void {
    this.queue.assertWritable()
    const byNs = this.pluginKv.get(pluginId)
    if (byNs) {
      byNs.delete(namespace)
      if (byNs.size === 0) this.pluginKv.delete(pluginId)
    }
    this.queue.enqueue(() =>
      this.queue.db.run(
        'DELETE FROM helmx_plugin_kv WHERE plugin_id = ? AND namespace = ?',
        pluginId,
        namespace,
      ),
    )
  }

  deletePlugin(pluginId: string): void {
    this.queue.assertWritable()
    this.pluginKv.delete(pluginId)
    this.queue.enqueue(() =>
      this.queue.db.run('DELETE FROM helmx_plugin_kv WHERE plugin_id = ?', pluginId),
    )
  }

  private setMirror(
    pluginId: string,
    namespace: string,
    key: string,
    valueJson: string,
    updatedAt: number,
  ): void {
    let byNs = this.pluginKv.get(pluginId)
    if (!byNs) {
      byNs = new Map()
      this.pluginKv.set(pluginId, byNs)
    }
    let byKey = byNs.get(namespace)
    if (!byKey) {
      byKey = new Map()
      byNs.set(namespace, byKey)
    }
    byKey.set(key, { valueJson, updatedAt })
  }
}
