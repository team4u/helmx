/**
 * 受管 Worktree 统一持久层（登记记录 + durable 租约 + agentId 绑定 + 占用判定）。
 *
 * 持久存储基于插件专属键值存储 `ctx.kv`（`state.sqlite` `helmx_plugin_kv`）：
 * - `worktrees`：单条 `ManagedWorktreeRecord`，按 `worktreeKvKey(record.id)` 独立读写；
 * - `leases`：单条 `WorktreeLeaseRecord`，按随机 UUID `token` 独立读写；
 * - `agent-bindings`：单条 `WorktreeAgentBinding`，按 `worktreeKvKey(agentId)` 独立读写。
 * 每条变更仅触及目标单键，避免整表克隆序列化与 2 MiB 文档上限。
 */

import {
  HelmxError,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type PluginKvEntry,
  type PluginKvHandle,
} from '@helmx/protocol'
import { createHash, randomUUID } from 'node:crypto'
import { extractWorktreeExecutionMeta, type ManagedWorktreeHold, type ManagedWorktreeRecord } from '../contracts.js'

export type { ManagedWorktreeHold, ManagedWorktreeRecord }

export const WORKTREES_KV_NAMESPACE = 'worktrees'
export const LEASES_KV_NAMESPACE = 'leases'
export const AGENT_BINDINGS_KV_NAMESPACE = 'agent-bindings'

const ALLOWED_HOLD_KEYS = new Set(['pluginId', 'holdId', 'label', 'acquiredAt'])
const KV_MAX_KEY_LENGTH = 256
const HASH_KEY_PREFIX = 'sha256:'

export interface WorktreeLeaseRecord {
  phase: 'pending' | 'running'
  info: AgentExecutionInfo
  worktreeId: string
  nodeId?: string
  path?: string
  neverStarted?: boolean
  createdAt: number
}

export interface WorktreeAgentBinding {
  childId: number
  parentConversationId: number
}

export interface WorktreeKvHandles {
  worktrees: PluginKvHandle<ManagedWorktreeRecord>
  leases: PluginKvHandle<WorktreeLeaseRecord>
  agentBindings: PluginKvHandle<WorktreeAgentBinding>
}

export interface WorktreeRecordSelector {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
}

type WorktreeResolveMode = 'inspect' | 'cleanup'

export interface WorktreeStoreDeps {
  kv: WorktreeKvHandles
  redact: (text: string) => string
  host?: {
    getConversation(id: number): { status: string }
    listActiveSpawnExecutions(): AgentExecutionInfo[]
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * 将任意业务键（如 `${nodeId}:${path}` 或 `agentId`）映射为合法 `ctx.kv` 键：
 * - 常规可打印短键（1..256 字符、无控制字符、不与哈希前缀碰撞）原样存储，便于诊断排查；
 * - 超长路径、含控制字符或以 `sha256:` 开头的键单射编码为 `sha256:<64 hex>`，避免触发 `400 invalid_kv_key`。
 */
export function worktreeKvKey(rawKey: string): string {
  if (
    rawKey.length > 0 &&
    rawKey.length <= KV_MAX_KEY_LENGTH &&
    !hasControlChar(rawKey) &&
    !rawKey.startsWith(HASH_KEY_PREFIX)
  ) {
    return rawKey
  }
  return `${HASH_KEY_PREFIX}${createHash('sha256').update(rawKey, 'utf8').digest('hex')}`
}

/** 分页遍历整个 KV 命名空间，突破单页 1000 条上限。 */
function listAllKv<T>(kv: PluginKvHandle<T>): Array<PluginKvEntry<T>> {
  const all: Array<PluginKvEntry<T>> = []
  let cursor: string | undefined
  for (;;) {
    const page = kv.list(cursor !== undefined ? { cursor } : undefined)
    all.push(...page.items)
    if (page.nextCursor === undefined || page.nextCursor === cursor || page.items.length === 0) break
    cursor = page.nextCursor
  }
  return all
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function latestBy<T>(items: readonly T[], ts: (item: T) => number): T {
  return items.reduce((a, b) => (ts(b) >= ts(a) ? b : a))
}

function assertNonBlankArg(value: unknown, field: string): asserts value is string {
  if (!isNonBlank(value)) throw new HelmxError('validation_error', `${field} 必须为非空字符串`, 400)
}

function assertPersistedHoldValid(raw: unknown, recordId: unknown): asserts raw is ManagedWorktreeHold {
  const corrupt = (reason: string): never => {
    throw new HelmxError(
      'worktree_doc_corrupted',
      `受管 worktree 存储 '${WORKTREES_KV_NAMESPACE}' 损坏（记录 ${String(recordId)} ${reason}）`,
      500,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) corrupt('的 hold 非对象')
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_HOLD_KEYS.has(key)) corrupt(`的 hold 含未知字段 '${key}'`)
  }
  if (
    !isNonBlank(obj['pluginId']) ||
    !isNonBlank(obj['holdId']) ||
    !isNonBlank(obj['label']) ||
    typeof obj['acquiredAt'] !== 'number' ||
    !Number.isFinite(obj['acquiredAt']) ||
    obj['acquiredAt'] < 0
  ) {
    corrupt('的 hold 字段非法')
  }
}

function assertPersistedRecordValid(raw: unknown, key: string): asserts raw is ManagedWorktreeRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError(
      'worktree_doc_corrupted',
      `受管 worktree 存储 '${WORKTREES_KV_NAMESPACE}' 损坏（键 '${key}' 的 record 非对象）`,
      500,
    )
  }
  const obj = raw as Record<string, unknown>
  if (obj['hold'] !== undefined) {
    assertPersistedHoldValid(obj['hold'], obj['id'] ?? key)
  }
}

export function validateWorktreeSelector(input: WorktreeRecordSelector, mode: WorktreeResolveMode): void {
  if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
    throw new HelmxError('validation_error', `${mode} 需提供 worktreeId、conversationId 或 path 之一`, 400)
  }
  if (input.worktreeId !== undefined && (input.conversationId !== undefined || input.path !== undefined)) {
    throw new HelmxError('validation_error', 'worktreeId 与 conversationId/path 互斥（worktreeId 单独使用）', 400)
  }
  if (input.nodeId !== undefined && input.path === undefined) {
    throw new HelmxError('validation_error', 'nodeId 仅可与 path 搭配使用（跨节点同名路径消歧）', 400)
  }
  if (input.conversationId !== undefined && input.path !== undefined) {
    throw new HelmxError('validation_error', 'conversationId 与 path 择一提供', 400)
  }
}

export class WorktreeStore {
  private readonly kv: WorktreeKvHandles
  private readonly redact: (text: string) => string
  private readonly host: WorktreeStoreDeps['host']
  private hydrated = false
  private readonly recordsById = new Map<string, ManagedWorktreeRecord>()
  private activeCount = 0

  constructor(deps: WorktreeStoreDeps) {
    this.kv = deps.kv
    this.redact = deps.redact
    this.host = deps.host
  }

  invalidateCache(): void {
    this.hydrated = false
    this.recordsById.clear()
    this.activeCount = 0
  }

  private ensureHydrated(): void {
    if (this.hydrated) return
    const nextMap = new Map<string, ManagedWorktreeRecord>()
    let nextActive = 0
    for (const entry of listAllKv(this.kv.worktrees)) {
      assertPersistedRecordValid(entry.value, entry.key)
      nextMap.set(entry.key, entry.value)
      if (entry.value.status === 'active') nextActive += 1
    }
    this.recordsById.clear()
    for (const [k, v] of nextMap) {
      this.recordsById.set(k, v)
    }
    this.activeCount = nextActive
    this.hydrated = true
  }

  private putCachedRecord(kvKey: string, next: ManagedWorktreeRecord): void {
    const prev = this.recordsById.get(kvKey)
    if (prev?.status === 'active') this.activeCount -= 1
    if (next.status === 'active') this.activeCount += 1
    this.recordsById.set(kvKey, next)
  }

  private deleteCachedRecord(kvKey: string): boolean {
    const prev = this.recordsById.get(kvKey)
    if (prev === undefined) return false
    if (prev.status === 'active') this.activeCount -= 1
    this.recordsById.delete(kvKey)
    return true
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.kv.worktrees.flush(),
      this.kv.leases.flush(),
      this.kv.agentBindings.flush(),
    ])
  }

  hasActiveRecords(): boolean {
    this.ensureHydrated()
    return this.activeCount > 0
  }

  records(): ManagedWorktreeRecord[] {
    this.ensureHydrated()
    return [...this.recordsById.values()]
  }

  append(record: ManagedWorktreeRecord): void {
    this.ensureHydrated()
    const kvKey = worktreeKvKey(record.id)
    this.kv.worktrees.set(kvKey, record)
    this.putCachedRecord(kvKey, record)
  }

  findById(id: string): ManagedWorktreeRecord | undefined {
    this.ensureHydrated()
    return this.recordsById.get(worktreeKvKey(id))
  }

  updateRecord(id: string, mutate: (record: ManagedWorktreeRecord) => ManagedWorktreeRecord): void {
    this.ensureHydrated()
    const kvKey = worktreeKvKey(id)
    const existing = this.recordsById.get(kvKey)
    if (existing === undefined) {
      throw new HelmxError('not_found', `受管 worktree 记录 ${id} 不存在（存储状态不一致）`, 404, { id })
    }
    const next = mutate(existing)
    assertPersistedRecordValid(next, kvKey)
    this.kv.worktrees.set(kvKey, next)
    this.putCachedRecord(kvKey, next)
  }

  assertMetadataSecretFree(
    fields: Record<string, string>,
    identity: Record<string, string | number | undefined>,
  ): void {
    const offenders: string[] = []
    for (const [name, value] of Object.entries(fields)) {
      if (value === '') continue
      const redacted = this.redact(value)
      if (redacted !== value) offenders.push(`${name}=${redacted}`)
    }
    if (offenders.length === 0) return
    const identityEntries = Object.entries(identity).filter(([, v]) => v !== undefined && v !== '')
    const identityText = identityEntries.map(([k, v]) => `${k}: ${String(v)}`).join('，')
    throw new HelmxError(
      'worktree_metadata_secret',
      `受管 worktree 元数据疑似包含已登记机密，拒绝登记与原始落库（脱敏值：${offenders.join('；')}）${identityText !== '' ? `【定位：${identityText}】` : ''}；请调整路径/分支命名或先轮换机密`,
      400,
      { ...Object.fromEntries(identityEntries), redactedFields: offenders },
    )
  }

  prepareHold(
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ): ManagedWorktreeHold {
    if (hold === null || typeof hold !== 'object' || Array.isArray(hold)) {
      throw new HelmxError('validation_error', 'hold 必须为对象', 400)
    }
    const raw = hold as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_HOLD_KEYS.has(key)) throw new HelmxError('validation_error', `hold 含未知字段 '${key}'`, 400, { key })
    }
    assertNonBlankArg(raw['pluginId'], 'hold.pluginId')
    assertNonBlankArg(raw['holdId'], 'hold.holdId')
    assertNonBlankArg(raw['label'], 'hold.label')
    const acquiredAt = raw['acquiredAt'] ?? Date.now()
    if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt) || acquiredAt < 0) {
      throw new HelmxError('validation_error', 'hold.acquiredAt 必须为非负有限数值', 400)
    }
    const safeLabel = this.redact(raw['label'].trim())
    if (!isNonBlank(safeLabel)) throw new HelmxError('validation_error', 'hold.label 脱敏后为空，拒绝登记', 400)
    this.assertMetadataSecretFree({ holdPluginId: raw['pluginId'], holdId: raw['holdId'], holdLabel: safeLabel }, identity)
    return { pluginId: raw['pluginId'], holdId: raw['holdId'], label: safeLabel, acquiredAt }
  }

  setHold(
    id: string,
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ): ManagedWorktreeRecord {
    assertNonBlankArg(id, 'worktreeId')
    const normalized = this.prepareHold(hold, { worktreeId: id, ...identity })
    let updated: ManagedWorktreeRecord | undefined
    this.updateRecord(id, (record) => {
      if (record.status === 'removed') {
        throw new HelmxError('worktree_missing', `受管 worktree '${record.path}' 已被清理，无法挂载持久持有锁`, 409, {
          worktreeId: id,
          path: record.path,
        })
      }
      updated = { ...record, hold: normalized }
      return updated
    })
    return updated!
  }

  releaseHold(id: string, pluginId: string, holdId: string): boolean {
    assertNonBlankArg(id, 'worktreeId')
    assertNonBlankArg(pluginId, 'pluginId')
    assertNonBlankArg(holdId, 'holdId')
    this.ensureHydrated()
    const kvKey = worktreeKvKey(id)
    const record = this.recordsById.get(kvKey)
    if (record === undefined) return false
    if (record.hold === undefined) return false
    if (record.hold.pluginId !== pluginId || record.hold.holdId !== holdId) {
      throw new HelmxError(
        'worktree_hold_mismatch',
        `受管 worktree '${record.path}' 当前持有锁归属不匹配（持有方 ${record.hold.pluginId}:${record.hold.holdId}，请求释放方 ${pluginId}:${holdId}）`,
        409,
        {
          worktreeId: record.id,
          path: record.path,
          expectedPluginId: pluginId,
          expectedHoldId: holdId,
          actualPluginId: record.hold.pluginId,
          actualHoldId: record.hold.holdId,
          label: this.redact(record.hold.label),
        },
      )
    }
    const { hold: _cleared, ...clean } = record
    this.kv.worktrees.set(kvKey, clean)
    this.putCachedRecord(kvKey, clean)
    return true
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    const records = this.records().filter((r) => r.conversationId === conversationId)
    if (records.length === 0) return undefined
    const active = records.filter((r) => r.status === 'active')
    return latestBy(active.length > 0 ? active : records, (r) => r.createdAt)
  }

  list(): ManagedWorktreeRecord[] {
    return this.records().sort((a, b) => b.createdAt - a.createdAt)
  }

  findActive(query: WorktreeRecordSelector): ManagedWorktreeRecord | undefined {
    if (query.worktreeId !== undefined) {
      const record = this.findById(query.worktreeId)
      return record?.status === 'active' ? record : undefined
    }
    const active = this.records().filter((r) => r.status === 'active')
    if (query.conversationId !== undefined) {
      const byConv = active.filter((r) => r.conversationId === query.conversationId)
      return byConv.length === 0 ? undefined : latestBy(byConv, (r) => r.createdAt)
    }
    if (query.path !== undefined) {
      const byPath = active.filter((r) => r.path === query.path && (query.nodeId === undefined || r.nodeId === query.nodeId))
      const nodeIds = new Set(byPath.map((r) => r.nodeId))
      if (nodeIds.size > 1) {
        throw new HelmxError('validation_error', `路径 ${query.path} 在多个节点存在 active 登记（${[...nodeIds].join(', ')}），查询需指定 nodeId 消歧`, 400, {
          path: query.path,
          nodeIds: [...nodeIds],
        })
      }
      return byPath.length === 0 ? undefined : latestBy(byPath, (r) => r.createdAt)
    }
    return undefined
  }

  resolveRecord(input: WorktreeRecordSelector, mode: WorktreeResolveMode): ManagedWorktreeRecord {
    validateWorktreeSelector(input, mode)
    const scopeHint =
      mode === 'inspect' ? 'inspect 仅检视 helmx 登记的隔离 worktree' : 'cleanup 仅清理 helmx 登记的隔离 worktree，绝不触碰未登记目录'

    if (input.worktreeId !== undefined) {
      const record = this.findById(input.worktreeId)
      if (record === undefined) throw new HelmxError('not_found', `未找到受管 worktree 记录 ${input.worktreeId}`, 404, { worktreeId: input.worktreeId })
      return record
    }
    if (input.conversationId !== undefined) {
      const record = this.getForConversation(input.conversationId)
      if (record === undefined) {
        throw new HelmxError('not_found', `未找到会话 ${input.conversationId} 绑定的受管 worktree 记录；${scopeHint}`, 404, {
          conversationId: input.conversationId,
        })
      }
      return record
    }
    const matches = this.records().filter((r) => r.path === input.path && (input.nodeId === undefined || r.nodeId === input.nodeId))
    if (matches.length === 0) {
      const suffix = mode === 'inspect' ? `${scopeHint}，不支持任意目录` : scopeHint
      throw new HelmxError('not_found', `未找到路径 ${input.path}${input.nodeId !== undefined ? `（节点 ${input.nodeId}）` : ''} 的受管 worktree 记录；${suffix}`, 404, {
        path: input.path,
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      })
    }
    const pool = mode === 'inspect' ? matches : matches.filter((r) => r.status === 'active')
    const nodeIds = new Set(pool.map((r) => r.nodeId))
    if (nodeIds.size > 1) {
      const label = mode === 'inspect' ? '登记' : 'active 登记'
      const action = mode === 'inspect' ? '检视' : '清理'
      throw new HelmxError('validation_error', `路径 ${input.path} 在多个节点存在 ${label}（${[...nodeIds].join(', ')}），${action}需指定 nodeId 消歧（或改用 worktreeId 精确指定）`, 400, {
        path: input.path,
        nodeIds: [...nodeIds],
      })
    }
    if (pool.length > 0) return latestBy(pool, (r) => r.createdAt)
    return latestBy(matches, (r) => r.removedAt ?? r.createdAt)
  }

  containsPath(path: string, candidate: string): boolean {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    const normalize = (value: string) => {
      const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
      return windows ? normalized.toLowerCase() : normalized
    }
    const base = normalize(path)
    const probe = normalize(candidate)
    return probe === base || probe.startsWith(`${base}/`)
  }

  isConversationWorking(id: number): boolean {
    if (this.host === undefined) return false
    const status = this.host.getConversation(id).status
    return status === 'working' || status === 'blocked'
  }

  leasePathOf(lease: WorktreeLeaseRecord, nodeId: string): string | undefined {
    if (lease.nodeId !== undefined && lease.path !== undefined) return lease.nodeId === nodeId ? lease.path : undefined
    const record = this.findById(lease.worktreeId)
    if (record !== undefined) return record.nodeId === nodeId ? record.path : undefined
    if (lease.info.nodeId === nodeId) {
      return lease.info.effectiveCwd ?? extractWorktreeExecutionMeta(lease.info).worktree?.path
    }
    return undefined
  }

  isPathInUse(
    nodeId: string,
    path: string,
    options?: { ignoreRecordHold?: { recordId: string; pluginId: string } },
  ): boolean {
    for (const info of this.host?.listActiveSpawnExecutions() ?? []) {
      if (info.nodeId !== nodeId) continue
      if (info.effectiveCwd !== undefined && this.containsPath(path, info.effectiveCwd)) return true
      const wt = extractWorktreeExecutionMeta(info).worktree
      if (wt !== undefined && this.containsPath(path, wt.path)) return true
    }
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath !== undefined && this.containsPath(path, leasePath)) return true
    }
    const ignore = options?.ignoreRecordHold
    return this.records().some(
      (r) =>
        r.status === 'active' &&
        r.hold !== undefined &&
        !(ignore !== undefined && r.id === ignore.recordId && r.hold.pluginId === ignore.pluginId) &&
        r.nodeId === nodeId &&
        (this.containsPath(path, r.path) || this.containsPath(r.path, path)),
    )
  }

  assertNoUnknownExecution(nodeId: string, path: string): void {
    const active = new Set(
      (this.host?.listActiveSpawnExecutions() ?? []).map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`),
    )
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath === undefined || !this.containsPath(path, leasePath)) continue
      const key = `${lease.info.executionId ?? ''}\u0000${lease.info.conversationId ?? ''}`
      if (!active.has(key)) {
        throw new HelmxError(
          'worktree_execution_unknown',
          '工作树存在重启中断或未确认停止的执行，不能清理；请先检视并续接收尾，或确认停止后在目标节点手动清理 Git 工作树',
          409,
          { nodeId, path, executionId: lease.info.executionId, conversationId: lease.info.conversationId, phase: lease.phase },
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // Durable leases & agentId bindings
  // ------------------------------------------------------------------

  listLeases(): Map<string, WorktreeLeaseRecord> {
    return new Map(listAllKv(this.kv.leases).map((entry) => [entry.key, entry.value]))
  }

  async openPendingLease(target: { nodeId: string; path: string; worktreeId?: string }): Promise<string> {
    const token = randomUUID()
    this.kv.leases.set(token, {
      phase: 'pending',
      nodeId: target.nodeId,
      path: target.path,
      info: { nodeId: target.nodeId },
      worktreeId: target.worktreeId ?? `${target.nodeId}:${target.path}`,
      createdAt: Date.now(),
    })
    await this.kv.leases.flush()
    return token
  }

  updateLease(token: string, info: AgentExecutionInfo): void {
    const lease = this.kv.leases.get(token)
    if (lease === undefined) return
    this.kv.leases.set(token, { ...lease, phase: 'running', info })
  }

  async acquireReattachLease(
    target: { worktreeId: string; nodeId: string; path: string },
    match: { conversationId?: number },
    info: AgentExecutionInfo,
  ): Promise<string> {
    if (match.conversationId !== undefined) {
      for (const [token, lease] of this.listLeases()) {
        if (lease.worktreeId === target.worktreeId && lease.info.conversationId === match.conversationId) {
          this.kv.leases.set(token, {
            ...lease,
            phase: 'running',
            nodeId: target.nodeId,
            path: target.path,
            info: { ...lease.info, ...info },
          })
          await this.kv.leases.flush()
          return token
        }
      }
    }
    const token = randomUUID()
    this.kv.leases.set(token, {
      phase: 'running',
      nodeId: target.nodeId,
      path: target.path,
      info,
      worktreeId: target.worktreeId,
      createdAt: Date.now(),
    })
    await this.kv.leases.flush()
    return token
  }

  async settleLease(token: string, succeeded: boolean, neverStarted: boolean): Promise<void> {
    if (!succeeded && !neverStarted) return
    if (!this.kv.leases.delete(token)) return
    await this.kv.leases.flush()
  }

  async settleLeaseAfterNextFailure(token: string, execution: AgentExecutionInfo | undefined): Promise<void> {
    if (execution?.conversationId === undefined || execution.executionId !== undefined) return
    try {
      if (!this.isConversationWorking(execution.conversationId)) await this.settleLease(token, true, false)
    } catch {
      return
    }
  }

  async clearStaleLeases(worktreeId: string): Promise<void> {
    let changed = false
    for (const entry of listAllKv(this.kv.leases)) {
      if (entry.value.worktreeId === worktreeId) {
        if (this.kv.leases.delete(entry.key)) changed = true
      }
    }
    if (!changed) return
    await this.kv.leases.flush()
  }

  private isLeaseActiveInHost(lease: WorktreeLeaseRecord, activeInfos: readonly AgentExecutionInfo[], activeKeys: ReadonlySet<string>): boolean {
    if (lease.info.executionId !== undefined || lease.info.conversationId !== undefined) {
      if (activeKeys.has(`${lease.info.executionId ?? ''}\u0000${lease.info.conversationId ?? ''}`)) return true
    }
    for (const info of activeInfos) {
      if (info.nodeId === undefined) continue
      const leasePath = this.leasePathOf(lease, info.nodeId)
      if (leasePath === undefined) continue
      if (info.effectiveCwd !== undefined && this.containsPath(leasePath, info.effectiveCwd)) return true
      const wt = extractWorktreeExecutionMeta(info).worktree
      if (wt !== undefined && this.containsPath(leasePath, wt.path)) return true
    }
    return false
  }

  async reconcileStoppedNativeLeases(): Promise<number> {
    const entries = listAllKv(this.kv.leases)
    if (entries.length === 0) return 0
    const activeInfos = this.host?.listActiveSpawnExecutions() ?? []
    const activeKeys = new Set(activeInfos.map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`))
    let removed = 0
    for (const { key: token, value: lease } of entries) {
      if (this.isLeaseActiveInHost(lease, activeInfos, activeKeys) || lease.info.executionId !== undefined) continue
      if (lease.phase === 'pending') {
        if (this.kv.leases.delete(token)) removed += 1
        continue
      }
      if (lease.phase === 'running' && lease.info.conversationId !== undefined) {
        let stopped = false
        try {
          stopped = !this.isConversationWorking(lease.info.conversationId)
        } catch (error) {
          if (error instanceof HelmxError && error.code === 'not_found') stopped = true
          else {
            process.stderr.write(
              `builtin:worktree reconcileStoppedNativeLeases: skip lease ${lease.worktreeId} (conv ${lease.info.conversationId} lookup failed): ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
        if (stopped && this.kv.leases.delete(token)) {
          removed += 1
        }
      }
    }
    if (removed === 0) return 0
    await this.kv.leases.flush()
    return removed
  }

  resolveResumeChildId(request: AgentSpawnRequest): number | undefined {
    if (request.resume === undefined) return undefined
    if (/^\d+$/.test(request.resume)) return Number(request.resume)
    return this.kv.agentBindings.get(worktreeKvKey(request.resume))?.childId
  }

  recordAgentBinding(agentId: string | undefined, childId: number | undefined, parentConversationId: number): void {
    if (agentId === undefined || agentId === '' || childId === undefined) return
    const kvKey = worktreeKvKey(agentId)
    const existing = this.kv.agentBindings.get(kvKey)
    if (existing !== undefined && existing.childId === childId && existing.parentConversationId === parentConversationId) return
    this.kv.agentBindings.set(kvKey, { childId, parentConversationId })
  }

  pruneConversation(conversationId: number): void {
    for (const entry of listAllKv(this.kv.agentBindings)) {
      if (entry.value.childId === conversationId || entry.value.parentConversationId === conversationId) {
        this.kv.agentBindings.delete(entry.key)
      }
    }

    this.ensureHydrated()
    if (this.recordsById.size === 0) return
    const leasedIds = new Set(Array.from(this.listLeases().values(), (l) => l.worktreeId))
    for (const [kvKey, r] of [...this.recordsById.entries()]) {
      if (
        r.status === 'removed' &&
        r.hold === undefined &&
        !leasedIds.has(r.id) &&
        (r.conversationId === conversationId || r.parentConversationId === conversationId)
      ) {
        this.kv.worktrees.delete(kvKey)
        this.deleteCachedRecord(kvKey)
      }
    }
  }
}
