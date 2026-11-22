/**
 * builtin:swarm crash-recovery & boot-reconciliation helpers:
 * - WAL tail inspection/rollback against meta.headSeq;
 * - authoritative inflight submission classification (pi_submissions);
 * - settled member timeline outcome classification;
 * - orphan conversation tag & worktree hold cleanup on boot.
 */
import {
  HelmxError, isJsonObject,
  type ConversationEntry, type ConversationSummary, type HelmxHostApi, type HelmxPluginContext,
} from '@helmx/protocol'
import { lastAssistantText, truncate } from '../entry-text.js'
import {
  ARCHIVED_COORDINATOR_TAG, ARCHIVED_WORKER_TAG, COORDINATOR_TAG, SWARM_PLUGIN_ID, WORKER_TAG,
  assertBoardPost, setConversationTags, swarmError,
  type BoardPost, type CollabGroupRecord, type GroupMemberState,
} from './contracts.js'
import { WORKTREE_PLUGIN_ID, cleanupManagedWorktree, releaseWorktreeHoldById } from './worktree-bridge.js'

export interface WalInspectionResult { posts: BoardPost[]; trimmed: boolean; trimReason?: string }

export function inspectBoardWalLines(rawBoard: string, groupId: string, headSeq: number): WalInspectionResult {
  const corrupt = (detail: string, extra?: Record<string, unknown>): HelmxError =>
    swarmError('swarm_doc_corrupt', `协作组 '${groupId}' ${detail}`, 500, { groupId, ...extra })

  if (rawBoard === '') {
    if (headSeq !== 0) throw corrupt(`board.jsonl 为空但 meta.headSeq=${headSeq}`, { postsCount: 0, headSeq })
    return { posts: [], trimmed: false }
  }

  const rawLines = rawBoard.split('\n')
  if (rawBoard.endsWith('\n')) rawLines.pop()
  if (rawLines.length < headSeq) {
    throw corrupt(`board.jsonl 条数(${rawLines.length})少于 meta.headSeq(${headSeq})`, { postsCount: rawLines.length, headSeq })
  }

  const posts: BoardPost[] = []
  for (let i = 0; i < headSeq; i += 1) {
    const line = rawLines[i]!
    if (line.trim() === '') throw corrupt(`board.jsonl 第 ${i + 1} 行为空行`, { line: i + 1 })
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch (err) {
      throw corrupt(`board.jsonl 第 ${i + 1} 行 JSON 非法：${err instanceof Error ? err.message : String(err)}`, { line: i + 1 })
    }
    const post = assertBoardPost(parsed)
    if (post.groupId !== groupId || post.seq !== i + 1) {
      throw corrupt(`board.jsonl 第 ${i + 1} 行序号或 groupId 不连续（收到 seq=${post.seq}）`, { line: i + 1, seq: post.seq })
    }
    posts.push(post)
  }

  const extraCount = rawLines.length - headSeq
  if (extraCount === 0) return { posts, trimmed: false }
  if (extraCount > 1) {
    throw corrupt(`board.jsonl 条数(${rawLines.length})超出 meta.headSeq(${headSeq}) 多行（${extraCount} 行），拒绝静默丢弃`, { postsCount: rawLines.length, headSeq })
  }

  const extraLine = rawLines[headSeq]!
  let extraParsedOk = false
  if (extraLine.trim() !== '') {
    try {
      const extraPost = assertBoardPost(JSON.parse(extraLine))
      extraParsedOk = true
      if (extraPost.groupId !== groupId || extraPost.seq !== headSeq + 1) {
        throw corrupt(`board.jsonl 第 ${headSeq + 1} 行未提交记录序号或 groupId 异常（收到 seq=${extraPost.seq}）`, { line: headSeq + 1, seq: extraPost.seq })
      }
    } catch (err) {
      if (err instanceof HelmxError) throw err
    }
  }

  return {
    posts, trimmed: true,
    trimReason: extraParsedOk ? `uncommitted post seq=${headSeq + 1} before meta.json commit` : `truncated tail line after headSeq=${headSeq}`,
  }
}

export type InflightIntentStatus = 'missing_conv' | 'active' | 'settled' | 'uncommitted'

export async function classifyInflightIntent(
  host: Pick<HelmxHostApi, 'getConversationSubmission'>,
  conversationId: number,
  summary: ConversationSummary | undefined,
  intent: { requestId: string },
): Promise<InflightIntentStatus> {
  if (summary === undefined) return 'missing_conv'
  try {
    const sub = await host.getConversationSubmission(conversationId, intent.requestId)
    if (sub === undefined) return 'uncommitted'
    return sub.status === 'queued' || sub.status === 'placed' ? 'active' : 'settled'
  } catch (err) {
    if (err instanceof HelmxError && err.code === 'not_found') return 'missing_conv'
    throw err
  }
}

export type MemberSettledClassification =
  | { kind: 'pending_queue' }
  | { kind: 'aborted' }
  | { kind: 'completed' }
  | { kind: 'failed'; error?: string }

function matchesMemberWakeOrNudgeInput(
  entry: ConversationEntry,
  groupId: string,
  memberName: string,
  taskSeq: number,
): boolean {
  if (entry.kind !== 'helmx.input' || !isJsonObject(entry.data) || typeof entry.data['id'] !== 'string') return false
  const id = entry.data['id']
  if (id === `swarm-nudge:${groupId}:${memberName}:${taskSeq}`) return true
  const prefix = `swarm-wakeup:${groupId}:${memberName}:`
  if (!id.startsWith(prefix)) return false
  const dash = id.indexOf('-', prefix.length)
  if (dash <= prefix.length) return false
  const toSeq = Number(id.slice(dash + 1))
  return Number.isInteger(toSeq) && toSeq >= taskSeq
}

export function classifyMemberDetailOutcome(
  entries: readonly ConversationEntry[],
  summary: Pick<ConversationSummary, 'status' | 'completionSeq' | 'lastError'>,
  groupId: string,
  member: Pick<GroupMemberState, 'name' | 'lastWakeTaskSeq' | 'lastWakeCompletionSeq'>,
): MemberSettledClassification {
  if (summary.status === 'error') {
    return { kind: 'failed', ...(summary.lastError !== undefined ? { error: summary.lastError } : {}) }
  }
  const taskSeq = member.lastWakeTaskSeq
  if (taskSeq === undefined) return { kind: 'pending_queue' }

  const completionAdvanced =
    member.lastWakeCompletionSeq === undefined || summary.completionSeq > member.lastWakeCompletionSeq

  let lastInputIdx = -1
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind === 'helmx.input') {
      lastInputIdx = i
      break
    }
  }
  if (
    !completionAdvanced &&
    (lastInputIdx === -1 || !matchesMemberWakeOrNudgeInput(entries[lastInputIdx]!, groupId, member.name, taskSeq))
  ) {
    return { kind: 'pending_queue' }
  }

  const tail = lastInputIdx >= 0 ? entries.slice(lastInputIdx + 1) : entries
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const entry = tail[i]!
    if (entry.kind !== 'pi.assistant' || !Array.isArray(entry.model)) continue
    for (let j = entry.model.length - 1; j >= 0; j -= 1) {
      const msg = entry.model[j]
      if (!isJsonObject(msg) || msg['role'] !== 'assistant') continue
      if (msg['stopReason'] === 'aborted') return { kind: 'aborted' }
      if (msg['stopReason'] === 'error') {
        const errText = typeof msg['errorMessage'] === 'string' ? msg['errorMessage'].trim() : ''
        return { kind: 'failed', ...(errText !== '' ? { error: errText } : {}) }
      }
      return { kind: 'completed' }
    }
  }
  return { kind: 'aborted' }
}

export async function collectMemberLastReplySummary(
  host: Pick<HelmxHostApi, 'getConversationDetail' | 'redact'>,
  conversationId: number,
): Promise<string> {
  const detail = await host.getConversationDetail(conversationId, { limit: 10 })
  const lastText = lastAssistantText(detail.entries).trim()
  return lastText === '' ? '' : truncate(host.redact(lastText), 600)
}

export async function reconcileOrphanConversations(
  ctx: HelmxPluginContext,
  groups: Iterable<CollabGroupRecord>,
): Promise<void> {
  const activeCoordinators = new Set<number>()
  const activeWorkers = new Set<number>()
  for (const group of groups) {
    if (group.status !== 'active') continue
    activeCoordinators.add(group.coordinatorConversationId)
    for (const member of group.members) {
      if (member.lifecycle === 'active') activeWorkers.add(member.conversationId)
    }
  }

  for (const conv of ctx.host.listConversations()) {
    const hasCoord = conv.tags.includes(COORDINATOR_TAG)
    const hasArchCoord = conv.tags.includes(ARCHIVED_COORDINATOR_TAG)
    const hasWorker = conv.tags.includes(WORKER_TAG)
    const hasArchWorker = conv.tags.includes(ARCHIVED_WORKER_TAG)

    if (activeCoordinators.has(conv.id)) {
      if (!hasCoord || hasArchCoord) await setConversationTags(ctx, conv, COORDINATOR_TAG, [ARCHIVED_COORDINATOR_TAG])
    } else if (activeWorkers.has(conv.id)) {
      ctx.host.markConversationOwnership(conv.id, 'helmx')
      if (!hasWorker || hasArchWorker || hasCoord) {
        await setConversationTags(ctx, conv, WORKER_TAG, [ARCHIVED_WORKER_TAG, COORDINATOR_TAG])
      }
    } else if (hasWorker || (hasCoord && conv.parentConversationId !== undefined)) {
      ctx.host.markConversationOwnership(conv.id, 'helmx')
      await setConversationTags(ctx, conv, ARCHIVED_WORKER_TAG, [WORKER_TAG, COORDINATOR_TAG])
    } else if (hasCoord && conv.parentConversationId === undefined) {
      await setConversationTags(ctx, conv, ARCHIVED_COORDINATOR_TAG, [COORDINATOR_TAG])
    }
  }
}

export async function reconcileOrphanWorktreeHolds(
  ctx: HelmxPluginContext,
  groups: Iterable<CollabGroupRecord>,
  logDiagnostic: (message: string) => void,
): Promise<boolean> {
  let listed: { worktrees?: Array<{ id: string; status?: string; hold?: { pluginId?: string; holdId?: string } }> }
  try {
    listed = (await ctx.host.invokeAction(WORKTREE_PLUGIN_ID, 'list_worktrees', {})) as typeof listed
  } catch (err) {
    if (!(err instanceof HelmxError && (err.code === 'plugin_disabled' || err.code === 'unknown_action'))) {
      logDiagnostic(`查询受管 worktree 失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  const activeHoldTargets = new Map<string, string>()
  for (const group of groups) {
    if (group.status !== 'active') continue
    for (const m of group.members) {
      if (m.lifecycle === 'active' && m.worktreeId !== undefined) {
        activeHoldTargets.set(`${group.id}:${m.name}`, m.worktreeId)
      }
    }
  }

  for (const wt of listed.worktrees ?? []) {
    if (wt.status !== 'active' || wt.hold?.pluginId !== SWARM_PLUGIN_ID) continue
    const holdId = wt.hold.holdId ?? ''
    if (holdId !== '' && activeHoldTargets.get(holdId) === wt.id) continue
    if (holdId === '') {
      logDiagnostic(`跳过空 holdId 的孤儿 worktree '${wt.id}'`)
      continue
    }
    try {
      await releaseWorktreeHoldById(ctx, holdId, wt.id)
      await cleanupManagedWorktree(ctx, wt.id, true)
      logDiagnostic(`已回收孤儿 worktree '${wt.id}' (holdId=${holdId})`)
    } catch (err) {
      logDiagnostic(
        `回收孤儿 worktree '${wt.id}' 失败（已跳过不阻断启动）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return true
}
