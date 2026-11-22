import {
  isPluginSummaryActive,
  type AskSpec,
  type ConversationDetail,
  type ConversationEntry,
  type ConversationLive,
  type ConversationSummary,
  type HelmxEventFrame,
  type HelmxResumedFrame,
  type HelmxSnapshot,
  type HelmxTransientLiveFrame,
  type NodeInfo,
  type PluginActivityLike,
  type PluginSummary,
  type PluginUiContribution,
} from '@helmx/protocol/browser'

export { isPluginSummaryActive, type PluginActivityLike }

export interface LiveState {
  seq: number
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  pendingEntries: Record<number, ConversationEntry[]>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  resolvedAsksByConv: Record<number, Array<{ ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }>>
  plugins: PluginSummary[]
  uiContributions: PluginUiContribution[]
  pluginDocs: Record<string, unknown>
  nodes: NodeInfo[]
}

export function emptyLiveState(): LiveState {
  return { seq: -1, conversations: [], conversationDetails: {}, pendingEntries: {}, conversationLives: {}, pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [], pluginDocs: {}, nodes: [] }
}

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => Number(b.id === 1) - Number(a.id === 1) || b.updatedAt - a.updatedAt)
}

/** 节点列表排序：local 恒在首项，其余按 id 稳定排列。 */
export function sortNodes(list: NodeInfo[]): NodeInfo[] {
  return [...list].sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function upsert<T extends { id: string | number }>(list: T[], item: T): T[] {
  return [...list.filter((value) => value.id !== item.id), item]
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

export function sameClientHashes(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.hasOwn(b, key) && b[key] === a[key])
}

export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => sameJsonValue(item, b[i]))
  }
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  const keysA = Object.keys(recA).filter((k) => recA[k] !== undefined)
  const keysB = Object.keys(recB).filter((k) => recB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  return keysA.every((k) => Object.hasOwn(recB, k) && recB[k] !== undefined && sameJsonValue(recA[k], recB[k]))
}

function sameNonConfigPluginMetadata(prev: PluginSummary, next: PluginSummary): boolean {
  const { publicConfig: _prevCfg, status: prevStatus, ...prevRest } = prev
  const { publicConfig: _nextCfg, status: nextStatus, ...nextRest } = next
  if ((prevStatus ?? 'active') !== (nextStatus ?? 'active')) return false
  return sameJsonValue(prevRest, nextRest)
}

/**
 * 判定 plugin.changed 是否为纯 publicConfig 配置热更新：
 * 仅当插件前后均 active、clientHashes / 非配置元数据 / UI 贡献均未改变且 publicConfig
 * 确实发生变化时才返回 true（其余启停/失败/移除/hash 变化或无配置差异的变更一律按
 * 完整失效处理，保留重载与迟到结果保护）。
 */
export function isConfigOnlyPluginChange(
  prevPlugin: PluginSummary | undefined,
  prevUi: readonly PluginUiContribution[],
  nextPlugin: PluginSummary,
  nextUi: readonly PluginUiContribution[],
): boolean {
  if (prevPlugin === undefined) return false
  if (!isPluginSummaryActive(prevPlugin) || !isPluginSummaryActive(nextPlugin)) return false
  if (!sameClientHashes(prevPlugin.clientHashes, nextPlugin.clientHashes)) return false
  if (!sameNonConfigPluginMetadata(prevPlugin, nextPlugin)) return false
  if (!sameJsonValue(prevUi, nextUi)) return false
  return !sameJsonValue(prevPlugin.publicConfig, nextPlugin.publicConfig)
}

/** 从 `doc:<pluginId>/<name>` 错误键提取 pluginId；非 doc 错误键返回 undefined。 */
export function extractDocErrorPluginId(key: string): string | undefined {
  if (!key.startsWith('doc:')) return undefined
  const slash = key.lastIndexOf('/')
  return slash > 4 ? key.slice(4, slash) : undefined
}

/** 按 `doc:<pluginId>/` 前缀集合从 loadErrors 清理过期文档错误（无变化时原引用返回）。 */
export function omitPluginDocLoadErrors(
  prev: Record<string, string>,
  pluginIds: ReadonlySet<string>,
): Record<string, string> {
  if (pluginIds.size === 0) return prev
  let changed = false
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(prev)) {
    const pluginId = extractDocErrorPluginId(key)
    if (pluginId !== undefined && pluginIds.has(pluginId)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : prev
}

export interface ReconcilePluginsResult {
  state: LiveState
  /** 非 active（disabled / failed）或已移除的插件 ID：需关闭 sessionDoc 订阅并逐出缓存。 */
  inactivePluginIds: Set<string>
  /** 需清理 `doc:<pluginId>/` 失败抑制、在途请求与 loadErrors 并递增 pluginEpoch 的插件 ID。 */
  invalidatedDocPluginIds: Set<string>
}

/**
 * 按 HTTP 全量插件摘要校准 LiveState：
 * - 按 `sameJsonValue` 保留未变更插件引用；
 * - 立即清理非 active（disabled / enabled=true,status=failed）及已移除插件的 `uiContributions` 与 `pluginDocs`；
 * - 对 active 插件的非纯配置变更（`clientHashes` 或非配置元数据变化）及非 active→active 恢复，
 *   清理其 `pluginDocs` 并记录到 `invalidatedDocPluginIds`；纯 `publicConfig` 变更保留 `uiContributions`、
 *   `pluginDocs` 与 doc 请求/错误状态；
 * - 架构边界：`PluginSummary` 不含 `PluginUiContribution[]`，对仍 active 的插件保留既有 `uiContributions`。
 */
export function reconcilePluginsState(
  state: LiveState,
  nextPlugins: readonly PluginSummary[],
): ReconcilePluginsResult {
  const prevById = new Map(state.plugins.map((p) => [p.id, p]))
  const nextById = new Map<string, PluginSummary>()
  const mergedPlugins = nextPlugins.map((incoming) => {
    const local = prevById.get(incoming.id)
    const resolved = local !== undefined && sameJsonValue(local, incoming) ? local : incoming
    nextById.set(resolved.id, resolved)
    return resolved
  })

  const activeNextIds = new Set<string>()
  const inactivePluginIds = new Set<string>()
  const invalidatedDocPluginIds = new Set<string>()

  for (const plugin of mergedPlugins) {
    if (isPluginSummaryActive(plugin)) {
      activeNextIds.add(plugin.id)
      const prevPlugin = prevById.get(plugin.id)
      const unchangedOrConfigOnly =
        prevPlugin !== undefined &&
        isPluginSummaryActive(prevPlugin) &&
        (prevPlugin === plugin ||
          (sameClientHashes(prevPlugin.clientHashes, plugin.clientHashes) &&
            sameNonConfigPluginMetadata(prevPlugin, plugin)))
      if (!unchangedOrConfigOnly) {
        invalidatedDocPluginIds.add(plugin.id)
      }
    } else {
      inactivePluginIds.add(plugin.id)
      invalidatedDocPluginIds.add(plugin.id)
    }
  }

  for (const prevPlugin of state.plugins) {
    if (!nextById.has(prevPlugin.id)) {
      inactivePluginIds.add(prevPlugin.id)
      invalidatedDocPluginIds.add(prevPlugin.id)
    }
  }

  const keepUi = state.uiContributions.filter((item) => {
    if (activeNextIds.has(item.pluginId)) return true
    inactivePluginIds.add(item.pluginId)
    invalidatedDocPluginIds.add(item.pluginId)
    return false
  })
  const uiChanged = keepUi.length !== state.uiContributions.length

  let docsChanged = false
  const nextDocs: Record<string, unknown> = {}
  for (const [docKey, value] of Object.entries(state.pluginDocs)) {
    const slash = docKey.lastIndexOf('/')
    const pluginId = slash > 0 ? docKey.slice(0, slash) : ''
    if (pluginId === '' || !activeNextIds.has(pluginId)) {
      if (pluginId !== '') {
        inactivePluginIds.add(pluginId)
        invalidatedDocPluginIds.add(pluginId)
      }
      docsChanged = true
      continue
    }
    if (invalidatedDocPluginIds.has(pluginId)) {
      docsChanged = true
      continue
    }
    nextDocs[docKey] = value
  }

  const pluginsChanged =
    mergedPlugins.length !== state.plugins.length ||
    mergedPlugins.some((item, index) => item !== state.plugins[index])

  const nextState =
    pluginsChanged || uiChanged || docsChanged
      ? {
          ...state,
          ...(pluginsChanged ? { plugins: mergedPlugins } : {}),
          ...(uiChanged ? { uiContributions: keepUi } : {}),
          ...(docsChanged ? { pluginDocs: nextDocs } : {}),
        }
      : state

  return { state: nextState, inactivePluginIds, invalidatedDocPluginIds }
}

/** ConversationLive 边界形状校验（与内核 conversation.live 事件同一判定）。 */
function isLiveShape(value: unknown): value is ConversationLive {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['conversationId'] === 'number' && Number.isInteger(v['conversationId']) &&
    typeof v['text'] === 'string' &&
    Array.isArray(v['tools']) &&
    typeof v['updatedAt'] === 'number' && Number.isFinite(v['updatedAt'])
  )
}

/** 保留 queue-only live：清流式正文/工具/思考，仅保留权威 queuedInputs（等真实出队帧清理）。 */
function queueOnlyLive(live: ConversationLive): ConversationLive {
  return { conversationId: live.conversationId, text: '', tools: [], ...(live.queuedInputs !== undefined ? { queuedInputs: live.queuedInputs } : {}), updatedAt: live.updatedAt }
}

/**
 * 应用全量快照并做 SWR 保活：保留仍存在于 snapshot.conversations 中的
 * previous.conversationDetails（合并最新摘要字段），仅清理已删除会话的详情缓存。
 */
export function applySnapshot(previous: LiveState, snapshot: HelmxSnapshot): LiveState {
  if (typeof snapshot.bootId !== 'string' || snapshot.bootId === '' || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.pendingAsks) || !Array.isArray(snapshot.plugins) || !Array.isArray(snapshot.ui)) {
    throw new Error('Invalid kernel live snapshot format')
  }
  if (snapshot.conversationLives !== undefined && !Array.isArray(snapshot.conversationLives)) throw new Error('Invalid kernel live snapshot format')
  if (snapshot.pluginDocs !== undefined && !Array.isArray(snapshot.pluginDocs)) throw new Error('Invalid kernel live snapshot format')
  const conversationLives: Record<number, ConversationLive> = {}
  for (const live of snapshot.conversationLives ?? []) {
    if (!isLiveShape(live)) throw new Error('Invalid kernel live snapshot format')
    conversationLives[live.conversationId] = live
  }
  const conversationDetails: Record<number, ConversationDetail> = {}
  for (const conv of snapshot.conversations) {
    const prevDetail = previous.conversationDetails[conv.id]
    if (prevDetail !== undefined) {
      conversationDetails[conv.id] = {
        ...prevDetail,
        ...conv,
        // 保留 prevDetail 已实际同步的条目水位，避免后台静默刷新失败后误以为详情已追平。
        stateChangeSeq: prevDetail.stateChangeSeq,
        lastEntryId: prevDetail.lastEntryId,
        ...(conv.contextUsage === undefined && prevDetail.contextUsage !== undefined
          ? { contextUsage: prevDetail.contextUsage }
          : {}),
      }
    }
  }
  // 过滤快照中明确处于非 active（disabled / failed）插件的文档与 UI 贡献，防止异常快照残留失效视图。
  const inactivePluginIds = new Set(
    snapshot.plugins.filter((p) => !isPluginSummaryActive(p)).map((p) => p.id),
  )
  // 快照 pluginDocs 直投：免额外拉取，键与 ensurePluginDoc 一致（`${pluginId}/${docName}`）。
  const pluginDocs: Record<string, unknown> = {}
  if (Array.isArray(snapshot.pluginDocs)) {
    for (const doc of snapshot.pluginDocs) {
      if (doc === null || typeof doc !== 'object') throw new Error('Invalid kernel live snapshot format')
      if (typeof doc.pluginId !== 'string' || typeof doc.name !== 'string') throw new Error('Invalid kernel live snapshot format')
      if (!inactivePluginIds.has(doc.pluginId)) {
        pluginDocs[`${doc.pluginId}/${doc.name}`] = doc.value
      }
    }
  }
  const uiContributions = snapshot.ui.filter((item) => !inactivePluginIds.has(item.pluginId))
  return { ...emptyLiveState(), seq: snapshot.seq, conversations: sortConversations(snapshot.conversations), conversationDetails, conversationLives, pendingAsks: snapshot.pendingAsks, plugins: snapshot.plugins, uiContributions, pluginDocs, nodes: Array.isArray(snapshot.nodes) ? sortNodes(snapshot.nodes) : [], resolvedAsksByConv: previous.resolvedAsksByConv }
}

export function entryMatchesReference(entry: ConversationEntry, reference: string): boolean {
  if (entry.id === reference || `entry:${entry.id}` === reference) return true
  if (entry.kind !== 'helmx.input' || !reference.startsWith('input:') || entry.data === null || typeof entry.data !== 'object') return false
  return 'id' in entry.data && entry.data.id === reference.slice('input:'.length)
}

/** SSE 已先订阅，HTTP 详情返回时保留其间收到的 entry 与更新过的摘要。 */
export function mergeConversationDetail(state: LiveState, detail: ConversationDetail, olderPage = false): LiveState {
  const current = state.conversationDetails[detail.id]
  const entries = new Map<string, ConversationEntry>()
  for (const entry of [...detail.entries, ...(current?.entries ?? []), ...(state.pendingEntries[detail.id] ?? [])]) entries.set(entry.id, entry)
  const sorted = [...entries.values()].sort((a, b) => {
    const left = Number(a.id), right = Number(b.id)
    return Number.isSafeInteger(left) && Number.isSafeInteger(right) ? left - right : (a.createdAt ?? 0) - (b.createdAt ?? 0)
  })
  const summary = state.conversations.find((c) => c.id === detail.id)
  // 上下文用量：内核首次填充缓存静默（不发 SSE 帧），列表摘要可能长期缺该
  // 字段；HTTP 详情首读带回时补进列表（ConversationPane 向 Composer 传
  // summary ?? detail，不回填则胶囊永不渲染）。摘要已有则保留 SSE 权威值，
  // 更早生成的 HTTP 详情不得回退已订阅状态（后续 upsert 会自愈追齐）。
  const usage = summary?.contextUsage ?? detail.contextUsage
  const conversations = summary !== undefined && usage !== undefined && summary.contextUsage === undefined
    ? sortConversations(upsert(state.conversations, { ...summary, contextUsage: usage }))
    : state.conversations
  return {
    ...state,
    conversations,
    pendingEntries: omit(state.pendingEntries, String(detail.id)),
    conversationDetails: {
      ...state.conversationDetails,
      [detail.id]: {
        ...detail,
        ...(summary ?? {}),
        stateChangeSeq: olderPage && current ? current.stateChangeSeq : detail.stateChangeSeq,
        lastEntryId: olderPage && current ? current.lastEntryId : detail.lastEntryId,
        ...(usage !== undefined ? { contextUsage: usage } : {}),
        entries: sorted,
        nextCursor: olderPage || !current ? detail.nextCursor : current.nextCursor,
      },
    },
  }
}

/** 条目 upsert：同 id 原位替换（时间线依赖时间正序，回填全文不得把条目挪到队尾），
 * 新 id 追加队尾（与既有 conversation.entry 事件追加语义一致）。 */
function upsertEntryStable(entries: ConversationEntry[], entry: ConversationEntry): ConversationEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index < 0) return [...entries, entry]
  if (entries[index] === entry) return entries
  const next = [...entries]
  next[index] = entry
  return next
}

/**
 * 单条目写入（SSE conversation.entry 事件与截断全文回填共用语义）：
 * 详情已加载则原位并入其 entries；否则落入 pendingEntries 等详情首载合并。
 * 不触碰 nextCursor，分页游标语义不变。
 */
export function applyConversationEntry(state: LiveState, conversationId: number, entry: ConversationEntry): LiveState {
  const detail = state.conversationDetails[conversationId]
  if (detail) {
    const entries = upsertEntryStable(detail.entries, entry)
    if (entries === detail.entries) return state
    return {
      ...state,
      conversationDetails: {
        ...state.conversationDetails,
        [conversationId]: { ...detail, entries },
      },
    }
  }
  const existingPending = state.pendingEntries[conversationId]
  if (existingPending !== undefined) {
    const pending = upsertEntryStable(existingPending, entry)
    if (pending === existingPending) return state
    return { ...state, pendingEntries: { ...state.pendingEntries, [conversationId]: pending } }
  }
  return { ...state, pendingEntries: { ...state.pendingEntries, [conversationId]: [entry] } }
}

/**
 * 应用非顺序瞬态 `conversation.live` 帧：不检查也不推进 `seq`，
 * 仅更新对应会话的实时视图。
 */
export function applyTransientLiveFrame(state: LiveState, frame: HelmxTransientLiveFrame): LiveState {
  if (frame === null || typeof frame !== 'object' || !isLiveShape((frame as { live?: unknown }).live)) {
    throw new Error('Invalid transient conversation.live frame format')
  }
  return {
    ...state,
    conversationLives: { ...state.conversationLives, [frame.live.conversationId]: frame.live },
  }
}

/**
 * 应用 `resumed` 控制帧携带的活跃会话实时视图集合，对账断线期间未进入
 * 持久回放环形缓冲区的瞬态 `conversation.live` 状态。
 */
export function applyResumedFrame(state: LiveState, frame: HelmxResumedFrame): LiveState {
  if (frame === null || typeof frame !== 'object') {
    throw new Error('Invalid kernel live resumed format')
  }
  if (frame.conversationLives === undefined) return state
  if (!Array.isArray(frame.conversationLives)) {
    throw new Error('Invalid kernel live resumed format')
  }
  const conversationLives: Record<number, ConversationLive> = {}
  for (const live of frame.conversationLives) {
    if (!isLiveShape(live)) throw new Error('Invalid kernel live resumed format')
    conversationLives[live.conversationId] = live
  }
  if (frame.conversationLives.length === 0 && Object.keys(state.conversationLives).length === 0) {
    return state
  }
  return { ...state, conversationLives }
}

/** 任何序号缺口都重连取快照，不能继续显示缺帧的“最新状态”。 */
export function applyEventFrame(state: LiveState, frame: HelmxEventFrame): LiveState {
  if (!Number.isSafeInteger(frame.seq) || !frame.event || typeof frame.event.type !== 'string') throw new Error('Invalid live event format')
  if (frame.seq <= state.seq) return state
  if (state.seq < 0 || frame.seq !== state.seq + 1) throw new Error('Live event sequence gap; re-syncing')
  const next = { ...state, seq: frame.seq }
  const event = frame.event
  // 自定义事件有任意字符串 type；用字段存在性进一步缩窄公共联合类型。
  switch (event.type) {
    case 'conversation.upsert':
      if ('conversation' in event) {
        const conv = event.conversation
        next.conversations = sortConversations(upsert(state.conversations, conv))
        if (state.conversationDetails[conv.id]) {
          const existingDetail = state.conversationDetails[conv.id]!
          next.conversationDetails = {
            ...state.conversationDetails,
            [conv.id]: {
              ...existingDetail,
              ...conv,
              stateChangeSeq: existingDetail.stateChangeSeq,
              lastEntryId: existingDetail.lastEntryId,
            },
          }
        }
        if (conv.status !== 'working' && conv.status !== 'blocked') {
          // 终态交接边界：若权威 live 快照仍带 queuedInputs（失败后 afterFailedRun
          // 保留排队等场景），保留 queue-only live 等真实出队帧清理，不在 web
          // 伪造队列；队列为空则原样删除，不让 done 显示旧回复 working。
          const existing = state.conversationLives[conv.id]
          next.conversationLives = existing !== undefined && (existing.queuedInputs?.length ?? 0) > 0
            ? { ...state.conversationLives, [conv.id]: queueOnlyLive(existing) }
            : omit(state.conversationLives, String(conv.id))
        }
      }
      break
    case 'conversation.deleted':
      if ('conversationId' in event) {
        next.conversations = state.conversations.filter((c) => c.id !== event.conversationId)
        next.conversationDetails = omit(state.conversationDetails, String(event.conversationId))
        next.pendingEntries = omit(state.pendingEntries, String(event.conversationId))
        next.conversationLives = omit(state.conversationLives, String(event.conversationId))
        next.pendingAsks = state.pendingAsks.filter((ask) => ask.conversationId !== event.conversationId)
      }
      break
    case 'conversation.entry':
      if ('entry' in event) return applyConversationEntry(next, event.conversationId, event.entry)
      break
    case 'ask.upsert':
      if ('ask' in event) next.pendingAsks = event.ask.status === 'pending' ? upsert(state.pendingAsks, event.ask) : state.pendingAsks.filter((ask) => ask.id !== event.ask.id)
      break
    case 'ask.resolved':
      if ('askId' in event) {
        const ask = state.pendingAsks.find((item) => item.id === event.askId)
        next.pendingAsks = state.pendingAsks.filter((item) => item.id !== event.askId)
        if (ask) next.resolvedAsksByConv = { ...state.resolvedAsksByConv, [ask.conversationId]: [...(state.resolvedAsksByConv[ask.conversationId] ?? []), { ask, status: event.status }] }
      }
      break
    case 'plugin.changed':
      if ('plugin' in event) {
        const prevPlugin = state.plugins.find((p) => p.id === event.plugin.id)
        const prevUi = state.uiContributions.filter((item) => item.pluginId === event.plugin.id)
        const nextUi = Array.isArray(event.ui) ? event.ui : []
        const configOnly = Array.isArray(event.ui) && isConfigOnlyPluginChange(prevPlugin, prevUi, event.plugin, nextUi)
        const active = isPluginSummaryActive(event.plugin)

        next.plugins = upsert(state.plugins, event.plugin)
        if (!active) {
          // 非 active（含 disabled 与 enabled=true,status=failed）：强制移除 uiContributions 并清空 pluginDocs。
          next.uiContributions = state.uiContributions.filter((item) => item.pluginId !== event.plugin.id)
          next.pluginDocs = Object.fromEntries(
            Object.entries(state.pluginDocs).filter(([key]) => !key.startsWith(`${event.plugin.id}/`)),
          )
        } else if (!configOnly) {
          next.uiContributions = [...state.uiContributions.filter((item) => item.pluginId !== event.plugin.id), ...nextUi]
          next.pluginDocs = Object.fromEntries(
            Object.entries(state.pluginDocs).filter(([key]) => !key.startsWith(`${event.plugin.id}/`)),
          )
        }
        // 纯配置更新保持 uiContributions 引用与 pluginDocs 不变，避免 usePluginDoc 闪烁重拉。
      }
      break
    case 'plugin.doc.updated':
      if ('doc' in event && state.plugins.some((p) => p.id === event.doc.pluginId && isPluginSummaryActive(p))) {
        next.pluginDocs = { ...state.pluginDocs, [`${event.doc.pluginId}/${event.doc.name}`]: event.doc.value }
      }
      break
    case 'node.changed':
      if ('node' in event) {
        next.nodes =
          event.removed === true
            ? state.nodes.filter((item) => item.id !== event.node.id)
            : sortNodes(upsert(state.nodes, event.node))
      }
      break
  }
  return next
}

export interface SseMessage { event: string; data: string }

/** ReadableStream 的 chunk 不对应 SSE 帧边界；支持 CRLF、分段、多 data 行与注释。 */
export class SseParser {
  private buffer = ''
  private eventName = 'message'
  private data: string[] = []
  constructor(private readonly onMessage: (message: SseMessage) => void) {}
  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length + this.data.join('').length > 4 * 1024 * 1024) throw new Error('Live events exceeded the client receive limit')
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') {
        if (this.data.length) this.onMessage({ event: this.eventName, data: this.data.join('\n') })
        this.eventName = 'message'
        this.data = []
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const name = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (name === 'event') this.eventName = value
        else if (name === 'data') this.data.push(value)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE 空闲看门狗：卡死连接可靠检测（如 Vite dev 代理保留的挂起流）
// ---------------------------------------------------------------------------

/** SSE 客户端时序参数（集中定义；对象引用共享，测试可临时改写后复原）。 */
export const sseClientTimings = {
  /**
   * 连接建立后持续未收到任何字节（含服务端 `: keepalive` 心跳注释行）即判定
   * 连接卡死，中止当前连接并走既有重连路径；对齐内核 15s keepalive。
   */
  idleTimeoutMs: 30_000,
  /** `online`/`visibilitychange` 唤醒时判定活跃连接疑似半开陈旧的静默阈值（毫秒）。 */
  staleWakeupMs: 20_000,
  /** 重连指数退避基础间隔（毫秒）。 */
  reconnectBaseMs: 1_000,
  /** 重连指数退避上限（毫秒）。 */
  reconnectCapMs: 10_000,
  /** 重连随机抖动上限（毫秒）。 */
  reconnectJitterMs: 250,
}

/** 带空闲 Deadline 的单次读取结果：正常 chunk 或超时（连接卡死）。 */
export type SseIdleRead =
  | { kind: 'chunk'; chunk: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'idle' }

/**
 * 读取一个 SSE chunk 并附带空闲 Deadline：chunk 在超时内到达即返回（每次到达
 * 自然重置下一轮 Deadline，不会误杀活跃连接）；超时返回 { kind: 'idle' }，
 * 由调用方 abort 当前连接解开挂起的 reader.read() 并走统一重连路径。
 * 可选 signal 在已取消或等待期间收到 abort 时立即 reject 并清理定时器与监听，
 * 避免长超时定时器挂住事件循环。
 * 读取 promise 已被 race 接管：超时/取消取胜后迟到/拒绝的读取不会成为未处理 rejection。
 */
export async function readSseChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<SseIdleRead> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const idle = new Promise<SseIdleRead>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'idle' })
      }, idleTimeoutMs)
    })
    const racers: Array<Promise<SseIdleRead>> = [idle]
    if (signal !== undefined) {
      racers.push(
        new Promise<SseIdleRead>((_resolve, reject) => {
          onAbort = () => {
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      )
    }
    racers.unshift(reader.read().then((chunk): SseIdleRead => ({ kind: 'chunk', chunk })))
    return await Promise.race(racers)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
