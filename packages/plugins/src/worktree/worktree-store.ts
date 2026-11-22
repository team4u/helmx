/**
 * 受管 Worktree 统一持久层（登记记录 + durable 租约 + agentId 绑定 + 占用判定）。
 */

import { HelmxError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helmx/protocol'
import { randomUUID } from 'node:crypto'
import { extractWorktreeExecutionMeta, type ManagedWorktreeHold, type ManagedWorktreeRecord } from '../contracts.js'

export type { ManagedWorktreeHold, ManagedWorktreeRecord }

const WORKTREES_DOC_KEY = 'runtime/worktrees'
const LEASES_DOC_KEY = 'worktree-leases'
const AGENT_BINDINGS_DOC_KEY = 'worktree-agent-bindings'
const ALLOWED_HOLD_KEYS = new Set(['pluginId', 'holdId', 'label', 'acquiredAt'])

interface WorktreeDoc {
  version: 1
  records: ManagedWorktreeRecord[]
}

export interface WorktreeLeaseRecord {
  phase: 'pending' | 'running'
  info: AgentExecutionInfo
  worktreeId: string
  nodeId?: string
  path?: string
  neverStarted?: boolean
  createdAt: number
}

interface WorktreeAgentBinding {
  childId: number
  parentConversationId: number
}

export interface WorktreeRecordSelector {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
}

type WorktreeResolveMode = 'inspect' | 'cleanup'

interface WorktreeStoreDeps {
  docStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush?: () => Promise<void>
  }
  redact: (text: string) => string
  host?: {
    getConversation(id: number): { status: string }
    listActiveSpawnExecutions(): AgentExecutionInfo[]
  }
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
    throw new HelmxError('worktree_doc_corrupted', `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（记录 ${String(recordId)} ${reason}）`, 500)
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
  private readonly docStore: WorktreeStoreDeps['docStore']
  private readonly redact: (text: string) => string
  private readonly host: WorktreeStoreDeps['host']

  constructor(deps: WorktreeStoreDeps) {
    this.docStore = deps.docStore
    this.redact = deps.redact
    this.host = deps.host
  }

  private async flush(): Promise<void> {
    if (this.docStore.flush !== undefined) await this.docStore.flush()
  }

  private loadDoc(): WorktreeDoc {
    const doc = this.docStore.get<WorktreeDoc>(WORKTREES_DOC_KEY, { version: 1, records: [] })
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) {
      throw new HelmxError('worktree_doc_corrupted', `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（records 非数组）`, 500)
    }
    for (const record of doc.records) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new HelmxError('worktree_doc_corrupted', `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（record 非对象）`, 500)
      }
      if ((record as { hold?: unknown }).hold !== undefined) {
        assertPersistedHoldValid((record as { hold: unknown }).hold, (record as { id?: unknown }).id)
      }
    }
    return doc
  }

  private saveDoc(doc: WorktreeDoc): void {
    this.docStore.set(WORKTREES_DOC_KEY, doc)
  }

  records(): ManagedWorktreeRecord[] {
    return this.loadDoc().records
  }

  append(record: ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    this.saveDoc({ ...doc, records: [...doc.records, record] })
  }

  findById(id: string): ManagedWorktreeRecord | undefined {
    return this.loadDoc().records.find((r) => r.id === id)
  }

  updateRecord(id: string, mutate: (record: ManagedWorktreeRecord) => ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) {
      throw new HelmxError('not_found', `受管 worktree 记录 ${id} 不存在（文档状态不一致）`, 404, { id })
    }
    const next = [...doc.records]
    next[index] = mutate(next[index]!)
    this.saveDoc({ ...doc, records: next })
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
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) return false
    const record = doc.records[index]!
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
    const next = [...doc.records]
    next[index] = clean
    this.saveDoc({ ...doc, records: next })
    return true
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.conversationId === conversationId)
    if (records.length === 0) return undefined
    const active = records.filter((r) => r.status === 'active')
    return latestBy(active.length > 0 ? active : records, (r) => r.createdAt)
  }

  list(): ManagedWorktreeRecord[] {
    return [...this.loadDoc().records].sort((a, b) => b.createdAt - a.createdAt)
  }

  findActive(query: WorktreeRecordSelector): ManagedWorktreeRecord | undefined {
    const active = this.loadDoc().records.filter((r) => r.status === 'active')
    if (query.worktreeId !== undefined) return active.find((r) => r.id === query.worktreeId)
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
    const records = this.loadDoc().records
    const scopeHint =
      mode === 'inspect' ? 'inspect 仅检视 helmx 登记的隔离 worktree' : 'cleanup 仅清理 helmx 登记的隔离 worktree，绝不触碰未登记目录'

    if (input.worktreeId !== undefined) {
      const record = records.find((r) => r.id === input.worktreeId)
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
    const matches = records.filter((r) => r.path === input.path && (input.nodeId === undefined || r.nodeId === input.nodeId))
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

  isPathInUse(nodeId: string, path: string): boolean {
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
    return this.loadDoc().records.some(
      (r) => r.status === 'active' && r.hold !== undefined && r.nodeId === nodeId && (this.containsPath(path, r.path) || this.containsPath(r.path, path)),
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
    return new Map(Object.entries(this.docStore.get<Record<string, WorktreeLeaseRecord>>(LEASES_DOC_KEY, {})))
  }

  saveLeases(map: Map<string, WorktreeLeaseRecord>): void {
    this.docStore.set(LEASES_DOC_KEY, Object.fromEntries(map))
  }

  async openPendingLease(target: { nodeId: string; path: string; worktreeId?: string }): Promise<string> {
    const token = randomUUID()
    const map = this.listLeases()
    map.set(token, {
      phase: 'pending',
      nodeId: target.nodeId,
      path: target.path,
      info: { nodeId: target.nodeId },
      worktreeId: target.worktreeId ?? `${target.nodeId}:${target.path}`,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    await this.flush()
    return token
  }

  updateLease(token: string, info: AgentExecutionInfo): void {
    const map = this.listLeases()
    const lease = map.get(token)
    if (lease === undefined) return
    map.set(token, { ...lease, phase: 'running', info })
    this.saveLeases(map)
  }

  async acquireReattachLease(
    target: { worktreeId: string; nodeId: string; path: string },
    match: { conversationId?: number },
    info: AgentExecutionInfo,
  ): Promise<string> {
    const map = this.listLeases()
    for (const [token, lease] of map) {
      if (lease.worktreeId === target.worktreeId && match.conversationId !== undefined && lease.info.conversationId === match.conversationId) {
        map.set(token, { ...lease, phase: 'running', nodeId: target.nodeId, path: target.path, info: { ...lease.info, ...info } })
        this.saveLeases(map)
        await this.flush()
        return token
      }
    }
    const token = randomUUID()
    map.set(token, { phase: 'running', nodeId: target.nodeId, path: target.path, info, worktreeId: target.worktreeId, createdAt: Date.now() })
    this.saveLeases(map)
    await this.flush()
    return token
  }

  async settleLease(token: string, succeeded: boolean, neverStarted: boolean): Promise<void> {
    if (!succeeded && !neverStarted) return
    const map = this.listLeases()
    if (!map.delete(token)) return
    this.saveLeases(map)
    await this.flush()
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
    const map = this.listLeases()
    let changed = false
    for (const [token, lease] of map) {
      if (lease.worktreeId === worktreeId) {
        map.delete(token)
        changed = true
      }
    }
    if (!changed) return
    this.saveLeases(map)
    await this.flush()
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
    const map = this.listLeases()
    if (map.size === 0) return 0
    const activeInfos = this.host?.listActiveSpawnExecutions() ?? []
    const activeKeys = new Set(activeInfos.map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`))
    let removed = 0
    for (const [token, lease] of map) {
      if (this.isLeaseActiveInHost(lease, activeInfos, activeKeys) || lease.info.executionId !== undefined) continue
      if (lease.phase === 'pending') {
        map.delete(token)
        removed += 1
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
        if (stopped) {
          map.delete(token)
          removed += 1
        }
      }
    }
    if (removed === 0) return 0
    this.saveLeases(map)
    await this.flush()
    return removed
  }

  resolveResumeChildId(request: AgentSpawnRequest): number | undefined {
    if (request.resume === undefined) return undefined
    if (/^\d+$/.test(request.resume)) return Number(request.resume)
    return this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})[request.resume]?.childId
  }

  recordAgentBinding(agentId: string | undefined, childId: number | undefined, parentConversationId: number): void {
    if (agentId === undefined || agentId === '' || childId === undefined) return
    const bindings = this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})
    const existing = bindings[agentId]
    if (existing !== undefined && existing.childId === childId && existing.parentConversationId === parentConversationId) return
    this.docStore.set(AGENT_BINDINGS_DOC_KEY, { ...bindings, [agentId]: { childId, parentConversationId } })
  }

  pruneConversation(conversationId: number): void {
    const bindings = this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})
    const nextBindings: Record<string, WorktreeAgentBinding> = {}
    let bindingsChanged = false
    for (const [agentId, entry] of Object.entries(bindings)) {
      if (entry.childId === conversationId || entry.parentConversationId === conversationId) bindingsChanged = true
      else nextBindings[agentId] = entry
    }
    if (bindingsChanged) this.docStore.set(AGENT_BINDINGS_DOC_KEY, nextBindings)

    const doc = this.loadDoc()
    if (doc.records.length === 0) return
    const leasedIds = new Set(Array.from(this.listLeases().values(), (l) => l.worktreeId))
    const kept = doc.records.filter(
      (r) =>
        r.status !== 'removed' ||
        r.hold !== undefined ||
        leasedIds.has(r.id) ||
        (r.conversationId !== conversationId && r.parentConversationId !== conversationId),
    )
    if (kept.length !== doc.records.length) this.saveDoc({ ...doc, records: kept })
  }
}
