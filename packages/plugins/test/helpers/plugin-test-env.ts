/**
 * `@helmx/plugins` 测试公共环境基座。
 *
 * 集中提供插件测试常用的内存存储（`MemoryDocStore` / `MemoryConfigStore`）、
 * `makeFauxModels()` 假模型工厂，并统一转发 `@helmx/test-kit` 各子入口常用辅助，
 * 消除各测试文件重复定义样板。
 */

import assert from 'node:assert/strict'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from '@earendil-works/pi-ai/providers/faux'
import type { PluginKvHandle, PluginKvListOptions, PluginKvListResult } from '@helmx/protocol'
import type { PluginConfigStore, PluginDocStore, PluginKvRawEntry, PluginKvStore } from '../../../kernel/src/plugins/index.js'
import {
  AGENT_BINDINGS_KV_NAMESPACE,
  LEASES_KV_NAMESPACE,
  WORKTREES_KV_NAMESPACE,
  type ManagedWorktreeRecord,
  type WorktreeAgentBinding,
  type WorktreeKvHandles,
  type WorktreeLeaseRecord,
} from '../../src/worktree/worktree-store.js'

export {
  deferred,
  jsonResponse,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  waitFor,
  type Deferred,
  type WaitForOptions,
} from '@helmx/test-kit'

export {
  assertRejectsCode,
  cleanupDir,
  HOST_MANAGED_HELMX_ENV_NAMES,
  makeTempDir,
  sanitizedHostEnv,
  useTempDir,
  type CleanupRegistrar,
} from '@helmx/test-kit/node'

export {
  createGitTemplate,
  initGitRepo,
  type GitTemplate,
} from '@helmx/test-kit/git'

export type { FauxProviderHandle, RegisterFauxProviderOptions }

/**
 * 内存版 `PluginDocStore`：隔离插件全局文档（`${pluginId}:${name}`），
 * 提供 `store` / `writes` / `flushCount` 与 `clear` / `has` / `peek` / `keys` 检查辅助。
 */
export class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  readonly writes: string[] = []
  flushCount = 0

  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : structuredClone(initial)
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
    this.writes.push(key)
  }

  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) {
        this.store.delete(key)
      }
    }
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  /** 清空已存储文档、写记录与 flush 计数。 */
  clear(): void {
    this.store.clear()
    this.writes.length = 0
    this.flushCount = 0
  }

  /** 判断指定存储键是否存在。 */
  has(key: string): boolean {
    return this.store.has(key)
  }

  /** 读取存储键的克隆快照（不触发初值回落）。 */
  peek<T = unknown>(key: string): T | undefined {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : undefined
  }

  /** 返回当前所有存储键列表。 */
  keys(): string[] {
    return [...this.store.keys()]
  }
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 内存版 `PluginKvStore`：语义对齐 `HelmxStore` (`helmx_plugin_kv`)，
 * 既可直传 `PluginHostOptions.kv`，也可经 `handle(pluginId, namespace)` 导出独立 `PluginKvHandle<T>`。
 */
export class MemoryKvStore implements PluginKvStore {
  private readonly data = new Map<string, Map<string, Map<string, { valueJson: string; updatedAt: number }>>>()
  private readonly onFlush?: () => void | Promise<void>
  private readonly defaultListLimit: number
  flushCount = 0

  constructor(options: { onFlush?: () => void | Promise<void>; defaultListLimit?: number } = {}) {
    this.onFlush = options.onFlush
    this.defaultListLimit = options.defaultListLimit ?? 1000
  }

  get(pluginId: string, namespace: string, key: string): { valueJson: string; updatedAt: number } | undefined {
    const entry = this.data.get(pluginId)?.get(namespace)?.get(key)
    return entry === undefined ? undefined : { valueJson: entry.valueJson, updatedAt: entry.updatedAt }
  }

  put(pluginId: string, namespace: string, key: string, valueJson: string): number {
    let byNs = this.data.get(pluginId)
    if (byNs === undefined) {
      byNs = new Map()
      this.data.set(pluginId, byNs)
    }
    let byKey = byNs.get(namespace)
    if (byKey === undefined) {
      byKey = new Map()
      byNs.set(namespace, byKey)
    }
    const updatedAt = Date.now()
    byKey.set(key, { valueJson, updatedAt })
    return updatedAt
  }

  delete(pluginId: string, namespace: string, key: string): boolean {
    const byNs = this.data.get(pluginId)
    const byKey = byNs?.get(namespace)
    if (byKey === undefined || !byKey.delete(key)) return false
    if (byKey.size === 0) byNs!.delete(namespace)
    if (byNs!.size === 0) this.data.delete(pluginId)
    return true
  }

  list(
    pluginId: string,
    namespace: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): { items: PluginKvRawEntry[]; nextCursor?: string } {
    const byKey = this.data.get(pluginId)?.get(namespace)
    if (byKey === undefined || byKey.size === 0) return { items: [] }
    const prefix = opts?.prefix
    const cursor = opts?.cursor
    const limit = opts?.limit ?? this.defaultListLimit
    const keys: string[] = []
    for (const key of byKey.keys()) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      if (cursor !== undefined && compareCodeUnit(key, cursor) <= 0) continue
      keys.push(key)
    }
    keys.sort(compareCodeUnit)
    const hasMore = keys.length > limit
    const pageKeys = hasMore ? keys.slice(0, limit) : keys
    const items: PluginKvRawEntry[] = pageKeys.map((key) => {
      const entry = byKey.get(key)!
      return { key, valueJson: entry.valueJson, updatedAt: entry.updatedAt }
    })
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.key } : {}),
    }
  }

  clearNamespace(pluginId: string, namespace: string): void {
    const byNs = this.data.get(pluginId)
    if (byNs === undefined) return
    byNs.delete(namespace)
    if (byNs.size === 0) this.data.delete(pluginId)
  }

  deletePlugin(pluginId: string): void {
    this.data.delete(pluginId)
  }

  async flush(): Promise<void> {
    this.flushCount += 1
    if (this.onFlush !== undefined) await this.onFlush()
  }

  /** 清空全部插件命名空间与 flush 计数。 */
  clearAll(): void {
    this.data.clear()
    this.flushCount = 0
  }

  /** `clearAll()` 别名。 */
  clear(): void {
    this.clearAll()
  }

  /** 测试辅助：按反序列化对象读取单条记录。 */
  getParsed<T>(pluginId: string, namespace: string, key: string): T | undefined {
    const raw = this.get(pluginId, namespace, key)
    return raw === undefined ? undefined : (JSON.parse(raw.valueJson) as T)
  }

  /** 测试辅助：写入单条 JSON 序列化记录。 */
  setParsed<T>(pluginId: string, namespace: string, key: string, value: T): void {
    this.put(pluginId, namespace, key, JSON.stringify(value))
  }

  /** 测试辅助：读取命名空间全量反序列化条目（自动跨页遍历）。 */
  listParsed<T>(pluginId: string, namespace: string): Array<{ key: string; value: T; updatedAt: number }> {
    const out: Array<{ key: string; value: T; updatedAt: number }> = []
    let cursor: string | undefined
    for (;;) {
      const page = this.list(pluginId, namespace, cursor !== undefined ? { cursor } : undefined)
      for (const row of page.items) {
        out.push({ key: row.key, value: JSON.parse(row.valueJson) as T, updatedAt: row.updatedAt })
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    return out
  }

  /** 测试辅助：读取命名空间原始 JSON 字符串列表（用于脱敏/落库格式断言）。 */
  rawJsonEntries(pluginId: string, namespace: string): Array<{ key: string; valueJson: string }> {
    const byKey = this.data.get(pluginId)?.get(namespace)
    if (byKey === undefined) return []
    return [...byKey.entries()].map(([key, entry]) => ({ key, valueJson: entry.valueJson }))
  }

  /** 构造绑定到指定 `(pluginId, namespace)` 的 `PluginKvHandle<T>`（供单测直传 `WorktreeStore`）。 */
  handle<T = unknown>(pluginId: string, namespace: string): PluginKvHandle<T> {
    return {
      get: (key: string): T | undefined => this.getParsed<T>(pluginId, namespace, key),
      set: (key: string, value: T): void => {
        this.setParsed(pluginId, namespace, key, value)
      },
      delete: (key: string): boolean => this.delete(pluginId, namespace, key),
      list: (opts?: PluginKvListOptions): PluginKvListResult<T> => {
        const page = this.list(pluginId, namespace, opts)
        return {
          items: page.items.map((row) => ({
            key: row.key,
            value: JSON.parse(row.valueJson) as T,
            updatedAt: row.updatedAt,
          })),
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        }
      },
      clear: (): void => {
        this.clearNamespace(pluginId, namespace)
      },
      flush: (): Promise<void> => this.flush(),
    }
  }
}

/** 创建独立内存 `PluginKvHandle<T>`（适合单测直接实例化 `WorktreeStore` / `WorktreeAllocator`）。 */
export function createMemoryPluginKvHandle<T = unknown>(
  options: { onFlush?: () => void | Promise<void>; defaultListLimit?: number } = {},
): PluginKvHandle<T> {
  return new MemoryKvStore(options).handle<T>('test:plugin', 'default')
}

/** 创建绑定到同一 `MemoryKvStore` 的 `builtin:worktree` 三命名空间句柄组。 */
export function createMemoryWorktreeKv(store: MemoryKvStore = new MemoryKvStore()): WorktreeKvHandles {
  return {
    worktrees: store.handle<ManagedWorktreeRecord>('builtin:worktree', WORKTREES_KV_NAMESPACE),
    leases: store.handle<WorktreeLeaseRecord>('builtin:worktree', LEASES_KV_NAMESPACE),
    agentBindings: store.handle<WorktreeAgentBinding>('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE),
  }
}

/**
 * 内存版 `PluginConfigStore`：支持可选的全局默认配置 `initial`，
 * 并按 `pluginId` 独立持久化 `set()` 写入的配置快照。
 */
export class MemoryConfigStore implements PluginConfigStore {
  readonly store = new Map<string, Record<string, unknown>>()
  private readonly defaults: Record<string, unknown>

  constructor(initial: Record<string, unknown> = {}) {
    this.defaults = structuredClone(initial)
  }

  get(pluginId: string): Record<string, unknown> {
    const saved = this.store.get(pluginId)
    return saved !== undefined ? structuredClone(saved) : structuredClone(this.defaults)
  }

  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, structuredClone(value))
  }

  /** 清空已写入的插件级配置覆盖。 */
  clear(): void {
    this.store.clear()
  }
}

/** 创建官方 `fauxProvider` 句柄（配合 `KernelRuntimeOptions.providers` 注入，不阻断插件 `ctx.provider`）。 */
export function makeFauxProvider(options?: RegisterFauxProviderOptions): FauxProviderHandle {
  return fauxProvider(options)
}

/** 创建挂载 `fauxProvider` 的真实 `Models` 集合与控制句柄。 */
export function makeFauxModels(options?: RegisterFauxProviderOptions): {
  models: ReturnType<typeof createModels>
  faux: FauxProviderHandle
} {
  const models = createModels()
  const faux = fauxProvider(options)
  models.setProvider(faux.provider)
  return { models, faux }
}

/** 断言异步过程不会产生逃逸 `unhandledRejection`（观察面故障须就地诊断）。 */
export async function assertNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], '不得产生 unhandledRejection（观察面故障须就地诊断）')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}
