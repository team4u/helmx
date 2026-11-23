/**
 * builtin:workflow run 投影与会话分片文档（真增量 O(depth) 重投影）。
 *
 * - `runs`（ctx.sessionDoc，durable: false）：按会话子树分片，单分片上限 MAX_PROJECTED_RUNS_PER_CONVERSATION，
 *   始终保留全部 running，剩余槽位按 createdAt 倒序取最新终态，剥离原始 result 仅保留 hasResult + resultPreview；
 * - `run-badges`（ctx.doc，durable: false）：全局紧凑角标，仅统计本会话直接发起的 run（一级口径）；
 * - `upsertRun(run)` 增量 O(depth) 更新：仅重算 `run.conversationId` 及其祖先链的 runs 分片与单条角标，
 *   零全局排序与全站 JSON 重序列化，值相等跳过不发多余 SSE 事件。
 */
import type { PluginDocHandle, PluginSessionDocHandle } from '@helmx/protocol'
import {
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
  type WorkflowRunSummary,
} from '../contracts.js'

/** 单会话 runs 分片滑窗上限：始终保留全部 running，剩余槽位填充最新终态。 */
export const MAX_PROJECTED_RUNS_PER_CONVERSATION = 100

const RESULT_PREVIEW_MAX_CHARS = 200

export interface RunsProjection {
  sync(): void
  upsertRun(run: WorkflowRunSummary): void
  beginStopping(): void
  isStopping(): boolean
  reprojectOnConversationTreeChange(): void
  reprojectOnConversationDeleted(): void
}

function truncateSingleLine(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function formatResultPreview(result: unknown): string {
  if (typeof result === 'string') {
    const firstLine = result.trim().split(/\r?\n/, 1)[0]!.trim()
    return truncateSingleLine(firstLine, RESULT_PREVIEW_MAX_CHARS)
  }
  const serialized = JSON.stringify(result) ?? String(result)
  return truncateSingleLine(serialized, RESULT_PREVIEW_MAX_CHARS)
}

function slimProjectedRun(run: WorkflowRunSummary): WorkflowRunSummary {
  const { result, ...rest } = run
  const hasResult = result !== undefined || run.hasResult === true
  const preview =
    result !== undefined ? formatResultPreview(result) : run.resultPreview
  return {
    ...rest,
    hasResult,
    ...(hasResult && preview !== undefined ? { resultPreview: preview } : {}),
  }
}

function selectProjectedRuns(convRuns: WorkflowRunSummary[]): WorkflowRunSummary[] {
  if (convRuns.length <= MAX_PROJECTED_RUNS_PER_CONVERSATION) return convRuns
  const running = convRuns.filter((r) => r.status === 'running')
  if (running.length >= MAX_PROJECTED_RUNS_PER_CONVERSATION) {
    return running.slice(0, MAX_PROJECTED_RUNS_PER_CONVERSATION)
  }
  const remaining = MAX_PROJECTED_RUNS_PER_CONVERSATION - running.length
  const terminals = convRuns.filter((r) => r.status !== 'running').slice(0, remaining)
  return [...running, ...terminals].sort((a, b) => b.createdAt - a.createdAt)
}

function computeBadge(directRuns: WorkflowRunSummary[]) {
  if (directRuns.length === 0) return undefined
  let running = 0
  let failed = 0
  for (const r of directRuns) {
    if (r.status === 'running') running++
    else if (r.status === 'failed') failed++
  }
  return {
    count: directRuns.length,
    tone: (running > 0 ? 'accent' : failed > 0 ? 'warn' : 'neutral') as 'accent' | 'warn' | 'neutral',
    footerText: [running > 0 ? `${running} 运行中` : '', failed > 0 ? `${failed} 失败` : '']
      .filter((s) => s !== '')
      .join(' · '),
  }
}

export function createRunsProjection(deps: {
  runsDoc: PluginSessionDocHandle<WorkflowRunSessionDocState>
  badgesDoc: PluginDocHandle<WorkflowRunBadgesDocState>
  listRuns: () => WorkflowRunSummary[]
  listConversations: () => Array<{ id: number; parentConversationId?: number }>
}): RunsProjection {
  const { runsDoc, badgesDoc } = deps

  let stopping = false
  let hydrated = false
  const runsById = new Map<string, WorkflowRunSummary>()
  const directRunsByConv = new Map<number, Set<string>>()

  // 会话树快照（由 sync / conversation 事件维护，增量 upsert 直接查表）。
  const parentByConv = new Map<number, number | undefined>()
  const childrenByConv = new Map<number, Set<number>>()
  let conversationTreeFingerprint = ''

  // 幂等写缓存：每会话 runs JSON、每会话 badge 与整份 badges 对象。
  const writtenRunsByConv = new Map<number, string>()
  const badgesByConv: WorkflowRunBadgesDocState['byConversation'] = {}
  const writtenBadgeJsonByConv = new Map<number, string>()
  let badgesInitialized = false

  function indexRun(run: WorkflowRunSummary): number | undefined {
    const prev = runsById.get(run.id)
    const prevConvId = prev !== undefined && prev.conversationId !== run.conversationId ? prev.conversationId : undefined
    if (prevConvId !== undefined) {
      const oldSet = directRunsByConv.get(prevConvId)
      if (oldSet !== undefined) {
        oldSet.delete(run.id)
        if (oldSet.size === 0) directRunsByConv.delete(prevConvId)
      }
    }
    runsById.set(run.id, run)
    let set = directRunsByConv.get(run.conversationId)
    if (set === undefined) {
      set = new Set<string>()
      directRunsByConv.set(run.conversationId, set)
    }
    set.add(run.id)
    return prevConvId
  }

  function hydrateFromListRuns(): void {
    runsById.clear()
    directRunsByConv.clear()
    for (const run of deps.listRuns()) indexRun(run)
    hydrated = true
  }

  function refreshConversationTree(): void {
    parentByConv.clear()
    childrenByConv.clear()
    const conversations = deps.listConversations()
    for (const c of conversations) {
      parentByConv.set(c.id, c.parentConversationId)
    }
    for (const c of conversations) {
      const parent = c.parentConversationId
      if (parent !== undefined && parent !== c.id && parentByConv.has(parent)) {
        let children = childrenByConv.get(parent)
        if (children === undefined) {
          children = new Set<number>()
          childrenByConv.set(parent, children)
        }
        children.add(c.id)
      }
    }
    conversationTreeFingerprint = JSON.stringify(
      conversations
        .map((c) => [c.id, c.parentConversationId ?? null] as const)
        .sort((a, b) => a[0] - b[0]),
    )
  }

  function ancestorsOf(convId: number): number[] {
    const chain: number[] = []
    const visited = new Set<number>([convId])
    let current = parentByConv.get(convId)
    while (current !== undefined && !visited.has(current) && parentByConv.has(current)) {
      visited.add(current)
      chain.push(current)
      current = parentByConv.get(current)
    }
    return chain
  }

  function collectSubtreeRuns(rootConvId: number): WorkflowRunSummary[] {
    const collected: WorkflowRunSummary[] = []
    const seenConvs = new Set<number>([rootConvId])
    const queue: number[] = [rootConvId]
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head]!
      const direct = directRunsByConv.get(id)
      if (direct !== undefined) {
        for (const runId of direct) {
          const run = runsById.get(runId)
          if (run !== undefined) collected.push(run)
        }
      }
      const children = childrenByConv.get(id)
      if (children !== undefined) {
        for (const childId of children) {
          if (!seenConvs.has(childId)) {
            seenConvs.add(childId)
            queue.push(childId)
          }
        }
      }
    }
    collected.sort((a, b) => b.createdAt - a.createdAt)
    return collected
  }

  function writeRunsShard(convId: number): void {
    const projectedRuns = selectProjectedRuns(collectSubtreeRuns(convId)).map(slimProjectedRun)
    const key = JSON.stringify(projectedRuns)
    if (writtenRunsByConv.get(convId) === key) return
    runsDoc.set(convId, { runs: projectedRuns })
    writtenRunsByConv.set(convId, key)
  }

  function updateBadgeForConversation(convId: number): boolean {
    const key = String(convId)
    if (!parentByConv.has(convId)) {
      if (key in badgesByConv) {
        delete badgesByConv[key]
        writtenBadgeJsonByConv.delete(convId)
        return true
      }
      return false
    }
    const directIds = directRunsByConv.get(convId)
    const directRuns: WorkflowRunSummary[] = []
    if (directIds !== undefined) {
      for (const runId of directIds) {
        const r = runsById.get(runId)
        if (r !== undefined) directRuns.push(r)
      }
    }
    const next = computeBadge(directRuns)
    const nextJson = next === undefined ? '' : JSON.stringify(next)
    if (writtenBadgeJsonByConv.get(convId) === nextJson) return false
    if (next === undefined) {
      delete badgesByConv[key]
      writtenBadgeJsonByConv.delete(convId)
    } else {
      badgesByConv[key] = next
      writtenBadgeJsonByConv.set(convId, nextJson)
    }
    return true
  }

  function flushBadges(dirty: boolean): void {
    if (!dirty && badgesInitialized) return
    badgesInitialized = true
    badgesDoc.set({ byConversation: { ...badgesByConv } })
  }

  function projectAll(): void {
    refreshConversationTree()

    const targetConvs = new Set<number>()
    for (const convId of directRunsByConv.keys()) {
      if (!parentByConv.has(convId)) continue
      targetConvs.add(convId)
      for (const anc of ancestorsOf(convId)) targetConvs.add(anc)
    }
    for (const convId of [...writtenRunsByConv.keys()]) {
      if (!parentByConv.has(convId)) {
        writtenRunsByConv.delete(convId)
      } else {
        targetConvs.add(convId)
      }
    }
    for (const convId of targetConvs) {
      writeRunsShard(convId)
    }

    let badgeDirty = false
    const badgeCandidates = new Set<number>([...directRunsByConv.keys(), ...writtenBadgeJsonByConv.keys()])
    for (const convId of badgeCandidates) {
      if (updateBadgeForConversation(convId)) badgeDirty = true
    }
    flushBadges(badgeDirty)
  }

  function sync(): void {
    if (stopping) return
    hydrateFromListRuns()
    projectAll()
  }

  function upsertRun(run: WorkflowRunSummary): void {
    if (stopping) return
    if (!hydrated) {
      hydrateFromListRuns()
      indexRun(run)
      projectAll()
      return
    }
    const prevConvId = indexRun(run)
    if (!parentByConv.has(run.conversationId)) {
      refreshConversationTree()
    }
    const affectedShards = new Set<number>()
    if (parentByConv.has(run.conversationId)) {
      affectedShards.add(run.conversationId)
      for (const anc of ancestorsOf(run.conversationId)) affectedShards.add(anc)
    }
    if (prevConvId !== undefined && parentByConv.has(prevConvId)) {
      affectedShards.add(prevConvId)
      for (const anc of ancestorsOf(prevConvId)) affectedShards.add(anc)
    }
    for (const convId of affectedShards) {
      writeRunsShard(convId)
    }
    let badgeDirty = updateBadgeForConversation(run.conversationId)
    if (prevConvId !== undefined && updateBadgeForConversation(prevConvId)) badgeDirty = true
    flushBadges(badgeDirty)
  }

  function reprojectOnConversationTreeChange(): void {
    if (stopping) return
    try {
      const fingerprint = JSON.stringify(
        deps
          .listConversations()
          .map((c) => [c.id, c.parentConversationId ?? null] as const)
          .sort((a, b) => a[0] - b[0]),
      )
      if (fingerprint === conversationTreeFingerprint) return
      if (!hydrated) hydrateFromListRuns()
      projectAll()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话树变化后的 runs 投影失败: ${message}\n`)
    }
  }

  function reprojectOnConversationDeleted(): void {
    if (stopping) return
    try {
      if (!hydrated) hydrateFromListRuns()
      projectAll()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话删除后的 runs 投影失败: ${message}\n`)
    }
  }

  return {
    sync,
    upsertRun,
    beginStopping: () => {
      stopping = true
    },
    isStopping: () => stopping,
    reprojectOnConversationTreeChange,
    reprojectOnConversationDeleted,
  }
}
