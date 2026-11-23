/**
 * builtin:workflow 深度守卫与受管子代理登记（KV 持久化 + O(1) 内存缓存）。
 *
 * - 使用 `ctx.kv<ManagedSubagentEntry>('depth')` 按会话单键读写，彻底消除整表 doc 写放大；
 * - 启动时分页遍历全量校验持久条目（坏记录在插件定义阶段显式失败，不带病运行）；
 * - `depthFactsOf` 纯 O(1) 内存查询（零 structuredClone 开销），与 before_turn / tool / agent_spawn 三道防线共用。
 */
import { HelmxError, type PluginKvHandle } from '@helmx/protocol'
import { HARD_MAX_SUBAGENT_DEPTH } from '../contracts.js'

/** 受管子代理登记条目（持久事实）。 */
export interface ManagedSubagentEntry {
  agentType?: string
  runId?: string
  createdAt: number
  /** 自身派生深度：非受管会话直接派生 = 1，受管会话再派生 = 父深度 + 1。 */
  depth: number
  /** 派生时的父会话 ID（树位置事实；resume 续接不改变）。 */
  parentConversationId: number
  /** 该子代理子树的派生深度上限（派生时快照；配置后续变更不追溯）。 */
  maxSubagentDepth: number
}

/** 深度超限统一错误（含事实细节，工具/动作入口与 agent_spawn 兜底共用）。 */
export function depthExceededError(depth: number, maxSubagentDepth: number, conversationId: number): HelmxError {
  return new HelmxError(
    'subagent_depth_exceeded',
    `会话 ${conversationId} 是第 ${depth} 层受管子代理（子树派生上限 ${maxSubagentDepth} 层），已达上限，不能再派生子代理或启动嵌套工作流`,
    403,
    { conversationId, depth, maxSubagentDepth, attemptedChildDepth: depth + 1 },
  )
}

/** 受管子代理登记与深度守卫（深度事实的单一读写入口）。 */
export interface ManagedSubagentRegistry {
  depthFactsOf(conversationId: number): { managed: boolean; depth: number; maxSubagentDepth: number }
  registerManagedSubagent(
    conversationId: number,
    meta: {
      agentType?: string
      runId?: string
      depth: number
      parentConversationId: number
      maxSubagentDepth: number
      ceilingExplicit: boolean
    },
  ): void
  assertCanSpawn(conversationId: number): void
  pruneConversation(conversationId: number): void
}

function validateEntry(conversationId: number, entry: ManagedSubagentEntry): ManagedSubagentEntry {
  if (
    !Number.isSafeInteger(conversationId) ||
    conversationId < 1 ||
    entry === null ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    !Number.isInteger(entry.depth) ||
    entry.depth < 1 ||
    !Number.isInteger(entry.maxSubagentDepth) ||
    entry.maxSubagentDepth < entry.depth ||
    entry.maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH ||
    !Number.isSafeInteger(entry.parentConversationId) ||
    entry.parentConversationId < 1 ||
    entry.parentConversationId === conversationId
  ) {
    throw new HelmxError('subagent_record_invalid', `受管子代理 ${conversationId} 的深度登记无效`, 500, { conversationId })
  }
  return entry
}

export function createManagedSubagentRegistry(deps: {
  kv: PluginKvHandle<ManagedSubagentEntry>
  configuredMaxSubagentDepth: () => number
}): ManagedSubagentRegistry {
  const { kv } = deps
  const entries = new Map<number, ManagedSubagentEntry>()

  // 启动即分页全量加载并校验持久登记（坏记录在插件定义阶段显式失败，不带病运行）。
  let cursor: string | undefined
  for (;;) {
    const page = kv.list({ limit: 1000, ...(cursor !== undefined ? { cursor } : {}) })
    for (const item of page.items) {
      const id = Number(item.key)
      entries.set(id, validateEntry(id, item.value))
    }
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
  }

  function depthFactsOf(conversationId: number): { managed: boolean; depth: number; maxSubagentDepth: number } {
    const entry = entries.get(conversationId)
    if (entry === undefined) {
      return { managed: false, depth: 0, maxSubagentDepth: deps.configuredMaxSubagentDepth() }
    }
    return { managed: true, depth: entry.depth, maxSubagentDepth: entry.maxSubagentDepth }
  }

  function registerManagedSubagent(
    conversationId: number,
    meta: {
      agentType?: string
      runId?: string
      depth: number
      parentConversationId: number
      maxSubagentDepth: number
      ceilingExplicit: boolean
    },
  ): void {
    const existing = entries.get(conversationId)
    const next: ManagedSubagentEntry = {
      ...(existing ?? {}),
      ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
      ...(meta.runId !== undefined ? { runId: meta.runId } : {}),
      depth: existing?.depth ?? meta.depth,
      parentConversationId: existing?.parentConversationId ?? meta.parentConversationId,
      maxSubagentDepth: meta.ceilingExplicit
        ? meta.maxSubagentDepth
        : (existing?.maxSubagentDepth ?? meta.maxSubagentDepth),
      createdAt: existing?.createdAt ?? Date.now(),
    }
    validateEntry(conversationId, next)
    entries.set(conversationId, next)
    kv.set(String(conversationId), next)
    void kv.flush().catch((error: unknown) => {
      process.stderr.write(
        `builtin:workflow: 受管子代理会话 ${conversationId} 登记落盘失败：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
  }

  function assertCanSpawn(conversationId: number): void {
    const facts = depthFactsOf(conversationId)
    if (!facts.managed || facts.depth + 1 <= facts.maxSubagentDepth) return
    throw depthExceededError(facts.depth, facts.maxSubagentDepth, conversationId)
  }

  function pruneConversation(conversationId: number): void {
    if (!entries.delete(conversationId)) return
    kv.delete(String(conversationId))
    void kv.flush().catch((error: unknown) => {
      process.stderr.write(
        `builtin:workflow: 受管子代理会话 ${conversationId} 登记清理落盘失败：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
  }

  return { depthFactsOf, registerManagedSubagent, assertCanSpawn, pruneConversation }
}
