import { HelmxError, type ConversationSummary, type HelmxPluginContext } from '@helmx/protocol'
import type { WorktreeInspectResult } from '../contracts.js'
import {
  ARCHIVED_COORDINATOR_TAG, ARCHIVED_WORKER_TAG, COORDINATOR_TAG, WORKER_TAG,
  assertGroupId, groupClosedError, groupNotFoundError, isPosIntId, setConversationTags, snapshotMemberTiming, swarmError,
  type BoardViewDoc, type CollabGroupRecord, type CollabGroupStatus, type GroupMemberState, type RetainedWorktreeInfo, type SwarmCoordinator, type UncleanedWorktreeInfo,
} from './contracts.js'
import {
  checkMemberWorktree, inspectManagedWorktree, isIgnorableWorktreeError, settleMemberWorktree, toRetainedWorktreeInfo,
  type CheckedMemberWorktree,
} from './worktree-bridge.js'

export interface DispatchWorkerResult {
  workerConversationId: number; groupId: string; name: string; worktreeId?: string; postSeq: number
}

export interface ListGroupSummary {
  groupId: string
  title: string
  objective?: string
  status: CollabGroupStatus
  coordinatorConversationId: number
  headSeq: number
  memberCount: number
  activeMemberCount: number
  activeWorkingMembers: string[]
  retainedWorktreeCount: number
  createdAt: number
  closedAt?: number
}

export interface SwarmDispatchGuard {
  isClosing(groupId: string): boolean
  beginClosing(groupId: string): void
  endClosing(groupId: string): void
  hasPendingMember(groupId: string, name: string): boolean
  pendingCount(groupId: string): number
  getPendingByKey(groupId: string, key: string): Promise<DispatchWorkerResult> | undefined
  reserve(groupId: string, name: string, key: string | undefined, promise: Promise<DispatchWorkerResult>): () => void
  awaitInflight(groupId: string): Promise<void>
}

export function createSwarmDispatchGuard(): SwarmDispatchGuard {
  const closing = new Set<string>()
  const pending = new Map<string, Map<string, { key?: string; promise: Promise<DispatchWorkerResult> }>>()
  return {
    isClosing: (id) => closing.has(id),
    beginClosing: (id) => void closing.add(id),
    endClosing: (id) => void closing.delete(id),
    hasPendingMember: (id, name) => pending.get(id)?.has(name) === true,
    pendingCount: (id) => pending.get(id)?.size ?? 0,
    getPendingByKey: (id, key) => {
      for (const e of pending.get(id)?.values() ?? []) if (e.key === key) return e.promise
      return undefined
    },
    reserve: (id, name, key, promise) => {
      const map = pending.get(id) ?? new Map()
      pending.set(id, map)
      const entry = { ...(key ? { key } : {}), promise }
      map.set(name, entry)
      let done = false
      return () => {
        if (done) return
        done = true
        const cur = pending.get(id)
        if (cur?.get(name) === entry) {
          cur.delete(name)
          if (cur.size === 0) pending.delete(id)
        }
      }
    },
    awaitInflight: async (id) => {
      for (;;) {
        const map = pending.get(id)
        if (!map || map.size === 0) return
        await Promise.allSettled([...map.values()].map((e) => e.promise))
      }
    },
  }
}

export interface EnsureCoordinatorGroupInput {
  conversationId: number; title: string; objective?: string; reuseExisting?: boolean; createKey?: string
}

export function assertCoordinatorAuthority(conversationId: number | undefined, group: CollabGroupRecord): void {
  if (conversationId !== undefined && conversationId !== group.coordinatorConversationId) {
    throw swarmError(
      'conversation_scope_violation',
      `该操作仅允许协作组 '${group.id}' 的主控会话 #${group.coordinatorConversationId} 执行（当前会话 #${conversationId}）`,
      403,
      { groupId: group.id, coordinatorConversationId: group.coordinatorConversationId, conversationId },
    )
  }
}

export const isWorkerBusy = (
  coordinator: Pick<SwarmCoordinator, 'readConversationOrUndefined' | 'settlingWorkers' | 'groups'>,
  conversationId: number,
  status?: string,
  groupId?: string,
  memberName?: string,
): boolean => {
  const s = status ?? coordinator.readConversationOrUndefined(conversationId)?.status
  return (
    s === 'working' ||
    s === 'blocked' ||
    coordinator.settlingWorkers.has(conversationId) ||
    (groupId !== undefined && memberName !== undefined && coordinator.groups.hasInflightWakeup(groupId, memberName))
  )
}

export function resolveCoordinatorGroup(
  groups: SwarmCoordinator['groups'],
  explicitGroupId: string | undefined,
  conversationId: number | undefined,
  requireActive: boolean,
): CollabGroupRecord {
  if (explicitGroupId?.trim()) {
    const group = groups.getGroup(assertGroupId(explicitGroupId))
    if (!group) throw groupNotFoundError(explicitGroupId)
    assertCoordinatorAuthority(conversationId, group)
    if (requireActive && group.status !== 'active') throw groupClosedError(group.id)
    return group
  }
  if (conversationId !== undefined) {
    const active = groups.findActiveGroupByCoordinator(conversationId)
    if (active) return active
    if (!requireActive) {
      const latest = groups.findLatestGroupForConversation(conversationId)
      if (latest?.coordinatorConversationId === conversationId) return latest
    }
  }
  throw swarmError(
    'swarm_group_not_found',
    '未找到关联的活跃协作组；请显式指定 groupId 或先调用 create_group 建组',
    404,
    conversationId !== undefined ? { conversationId } : undefined,
  )
}

export function checkCoordinatorEligibility(
  conv: ConversationSummary,
  ownership: 'human' | 'helmx' | string,
): { code: 'validation_error' | 'conversation_scope_violation'; message: string; status: 400 | 403; details: Record<string, unknown> } | undefined {
  if (conv.parentConversationId !== undefined) {
    return {
      code: 'validation_error',
      message: `仅允许在顶层会话创建协作组（会话 #${conv.id} 是子会话，父会话 #${conv.parentConversationId}）`,
      status: 400,
      details: { conversationId: conv.id, parentConversationId: conv.parentConversationId },
    }
  }
  if (ownership !== 'human' || conv.tags.includes(WORKER_TAG) || conv.tags.includes(ARCHIVED_WORKER_TAG)) {
    return {
      code: 'conversation_scope_violation',
      message: `禁止在后台会话或 Worker 会话 #${conv.id} 上创建协作组`,
      status: 403,
      details: { conversationId: conv.id },
    }
  }
  return undefined
}

export async function ensureCoordinatorGroup(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  input: EnsureCoordinatorGroupInput,
): Promise<{ groupId: string; group: BoardViewDoc['group'] }> {
  const { readConversationOrUndefined, enqueueDispatch, groups } = coordinator
  const targetId = input.conversationId
  const conv = readConversationOrUndefined(targetId)
  if (!conv) throw new HelmxError('not_found', `目标会话 #${targetId} 不存在`, 404, { conversationId: targetId })
  const err = checkCoordinatorEligibility(conv, ctx.host.getConversationOwnership(targetId))
  if (err) throw new HelmxError(err.code, err.message, err.status, err.details)

  return enqueueDispatch(`coord:${targetId}`, async () => {
    const syncAndReturn = async (groupId: string): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
      const latest = readConversationOrUndefined(targetId)
      if (latest && !latest.tags.includes(COORDINATOR_TAG)) await setConversationTags(ctx, latest, COORDINATOR_TAG, [ARCHIVED_COORDINATOR_TAG])
      groups.syncCoordinatorProjection(targetId)
      return { groupId, group: groups.buildBoardView(groupId).group }
    }
    if (input.reuseExisting || input.createKey !== undefined) {
      const existing = groups.findActiveGroupByCoordinator(targetId)
      if (existing && (input.reuseExisting || existing.createKey === input.createKey)) return syncAndReturn(existing.id)
    }
    const created = await groups.createGroup({
      coordinatorConversationId: targetId,
      title: input.title.trim().slice(0, 120),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.createKey !== undefined ? { createKey: input.createKey } : {}),
    })
    return syncAndReturn(created.id)
  })
}

/** closeGroup 收尾各阶段共享的依赖：宿主 / 协调者句柄与影响收尾的开关（布尔项已按 `=== true` 归一）。 */
interface GroupClosing {
  ctx: HelmxPluginContext
  coordinator: SwarmCoordinator
  signal: AbortSignal | undefined
  abortRunning: boolean
  keepWorktree: boolean
  force: boolean
  allowUnverifiedUsage: boolean
  summary: string | undefined
}

/** 仍在运行的成员：默认拒绝收尾（409 swarm_worker_busy）；abortRunning 时对 working / blocked 成员发起受守护的中止后继续。 */
async function abortOrRejectBusyMembers(
  closing: GroupClosing,
  freshGroup: CollabGroupRecord,
  activeMembers: GroupMemberState[],
): Promise<void> {
  const { ctx, coordinator } = closing
  const { readConversationOrUndefined } = coordinator
  for (const m of activeMembers) {
    const s = readConversationOrUndefined(m.conversationId)
    if (!s || !isWorkerBusy(coordinator, m.conversationId, s.status, freshGroup.id, m.name)) continue
    if (!closing.abortRunning) throw busyMemberError(freshGroup, m)
    if (s.status === 'working' || s.status === 'blocked') await ctx.host.abortConversationGuarded(m.conversationId, { expectedOwnership: 'helmx' })
  }
}

function busyMemberError(freshGroup: CollabGroupRecord, m: GroupMemberState): HelmxError {
  return swarmError(
    'swarm_worker_busy',
    `协作组 '${freshGroup.id}' 成员 @${m.name} (#${m.conversationId}) 仍在运行中；请等待完工或传 abortRunning: true`,
    409,
    { groupId: freshGroup.id, memberName: m.name, workerConversationId: m.conversationId },
  )
}

/** 逐个在册成员做工作树只读检查（无工作树的成员跳过）；结果供未合入守卫与后续清理共用。 */
async function checkMemberWorktrees(closing: GroupClosing, activeMembers: GroupMemberState[]): Promise<CheckedMemberWorktree[]> {
  const checks: CheckedMemberWorktree[] = []
  for (const m of activeMembers) {
    const checked = await checkMemberWorktree(closing.ctx, m, closing.signal)
    if (checked) checks.push(checked)
  }
  return checks
}

/** 未显式 keepWorktree 且未 force 时，任一工作树有脏文件或未合入提交即拒绝收尾（409 swarm_worktree_unmerged）。 */
function assertNoUnmergedWorktrees(closing: GroupClosing, freshGroup: CollabGroupRecord, checks: CheckedMemberWorktree[]): void {
  if (closing.keepWorktree || closing.force) return
  const unmerged = checks.filter((i) => i.inspected.exists && (i.isDirty || i.unmergedCommits > 0))
  if (unmerged.length === 0) return
  const branches = unmerged.map((i) => `@${i.member.name}:${i.inspected.currentBranch ?? i.inspected.record.branch}`).join(', ')
  throw swarmError(
    'swarm_worktree_unmerged',
    `协作组 '${freshGroup.id}' 含未合入或脏工作树分支（${branches}）；请传 keepWorktree: true 解锁主控合入收尾后再清理，或显式传 force: true 放弃未合入内容直接收尾`,
    409,
    {
      groupId: freshGroup.id,
      unmergedWorktrees: unmerged.map((i) => ({
        ...toRetainedWorktreeInfo(i.member.name, i.member.nodeId, i.worktreeId, i.inspected, i.unmergedCommits),
        dirtyCount: i.inspected.summary.dirtyFileCount,
      })),
    },
  )
}

/** 复检此前已保留的工作树（以 worktreeId 去重）：仍脏或仍有未合入提交的继续保留。 */
async function recheckRetainedWorktrees(closing: GroupClosing, freshGroup: CollabGroupRecord): Promise<Map<string, RetainedWorktreeInfo>> {
  const retainedById = new Map<string, RetainedWorktreeInfo>()
  for (const prev of freshGroup.retainedWorktrees ?? []) {
    const stillRetained = await inspectRetainedWorktree(closing, prev)
    if (stillRetained) retainedById.set(prev.worktreeId, stillRetained)
  }
  return retainedById
}

/** 单个已保留工作树的复检：返回仍需保留的信息；已干净 / 已合入，或检查错误可忽略（如工作树已不存在）时返回 undefined。 */
async function inspectRetainedWorktree(closing: GroupClosing, prev: RetainedWorktreeInfo): Promise<RetainedWorktreeInfo | undefined> {
  let inspected: WorktreeInspectResult
  try {
    inspected = await inspectManagedWorktree(closing.ctx, prev.worktreeId, closing.signal)
  } catch (err) {
    if (!isIgnorableWorktreeError(err)) throw err
    return undefined
  }
  const unmergedCommits = inspected.exists ? (inspected.unmergedCommits ?? inspected.commitsAhead ?? 0) : 0
  if (inspected.exists && (inspected.summary.dirtyFileCount > 0 || unmergedCommits > 0)) {
    return toRetainedWorktreeInfo(prev.memberName, prev.nodeId, prev.worktreeId, inspected, unmergedCommits)
  }
  return undefined
}

/** 逐个成员清理工作树（keepWorktree 时改为保留）：保留项汇入 retainedById（可覆盖复检结果），无法清理项单独收集返回。 */
async function settleMemberWorktrees(
  closing: GroupClosing,
  freshGroup: CollabGroupRecord,
  checks: CheckedMemberWorktree[],
  retainedById: Map<string, RetainedWorktreeInfo>,
): Promise<UncleanedWorktreeInfo[]> {
  const uncleanedWorktrees: UncleanedWorktreeInfo[] = []
  for (const item of checks) {
    const settled = await settleMemberWorktree(closing.ctx, freshGroup.id, item, {
      keepWorktree: closing.keepWorktree,
      force: closing.force,
      allowUnverifiedUsage: closing.allowUnverifiedUsage,
      cleanupCleanWhenKeeping: true,
      signal: closing.signal,
    })
    if (settled.retained) retainedById.set(settled.retained.worktreeId, settled.retained)
    if (settled.uncleaned) uncleanedWorktrees.push(settled.uncleaned)
  }
  return uncleanedWorktrees
}

/** 落盘 closed 终态，把 Worker / 主控会话打上归档标签，并同步主控投影。 */
async function finalizeGroupClosure(
  closing: GroupClosing,
  freshGroup: CollabGroupRecord,
  activeMembers: GroupMemberState[],
  retainedWorktrees: RetainedWorktreeInfo[],
): Promise<void> {
  const { ctx, coordinator } = closing
  const { groups, readConversationOrUndefined } = coordinator
  const now = Date.now()
  await groups.mutateGroup(freshGroup.id, (draft) => ({
    group: applyClosedDraft(draft, { summary: closing.summary, retainedWorktrees, now, readConversation: readConversationOrUndefined }),
    result: undefined,
  }))
  for (const m of activeMembers) {
    const s = readConversationOrUndefined(m.conversationId)
    if (s) await setConversationTags(ctx, s, ARCHIVED_WORKER_TAG, [WORKER_TAG])
  }
  const coordConv = readConversationOrUndefined(freshGroup.coordinatorConversationId)
  if (coordConv?.tags.includes(COORDINATOR_TAG)) await setConversationTags(ctx, coordConv, ARCHIVED_COORDINATOR_TAG, [COORDINATOR_TAG])
  groups.syncCoordinatorProjection(freshGroup.coordinatorConversationId)
}

/** mutateGroup 的草稿变更：写入 closed 终态与保留清单、清除在途汇报恢复字段，并归档仍 active 的成员。 */
function applyClosedDraft(
  draft: CollabGroupRecord,
  input: {
    summary: string | undefined
    retainedWorktrees: RetainedWorktreeInfo[]
    now: number
    readConversation: (conversationId: number) => ConversationSummary | undefined
  },
): CollabGroupRecord {
  draft.status = 'closed'
  draft.closedAt = input.now
  draft.updatedAt = input.now
  draft.retainedWorktrees = input.retainedWorktrees
  delete draft.lastReportHadActiveWorkers
  delete draft.inflightReport
  delete draft.reportRecovery
  delete draft.peerHopsSinceCoordinator
  if (input.summary?.trim()) draft.closeSummary = input.summary.trim()
  for (const m of draft.members) archiveMemberDraft(m, input.now, input.readConversation)
  return draft
}

/** 归档仍 active 的成员草稿：固化运行时长与轮次，清掉唤醒 / 催促的恢复字段。 */
function archiveMemberDraft(
  m: GroupMemberState,
  now: number,
  readConversation: (conversationId: number) => ConversationSummary | undefined,
): void {
  if (m.lifecycle !== 'active') return
  const timing = snapshotMemberTiming(readConversation(m.conversationId), now)
  m.lifecycle = 'archived'
  m.archivedAt = now
  if (timing.runDurationMs !== undefined) m.runDurationMs = timing.runDurationMs
  if (timing.turnCount !== undefined) m.turnCount = timing.turnCount
  delete m.wakeupRecovery
  delete m.nudgeRecovery
}

export function createGroupHandlers(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  dispatchGuard: SwarmDispatchGuard = createSwarmDispatchGuard(),
) {
  const { enqueueDispatch, groups } = coordinator

  const createGroup = async (
    input: { title: string; objective?: string; conversationId?: number },
    contextConvId: number | undefined,
    idempotencyKey?: string,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new HelmxError('validation_error', 'create_group 需要非空 title', 400, {})
    if (input.conversationId !== undefined && contextConvId !== undefined && input.conversationId !== contextConvId) {
      throw new HelmxError('validation_error', `conversationId 冲突：输入指定 #${input.conversationId} 与调用上下文 #${contextConvId} 不一致`, 400, { inputConversationId: input.conversationId, contextConversationId: contextConvId })
    }
    const targetConvId = input.conversationId ?? contextConvId
    if (!isPosIntId(targetConvId)) throw new HelmxError('validation_error', 'create_group 需要有效的目标主控会话 conversationId', 400, {})
    return ensureCoordinatorGroup(ctx, coordinator, {
      conversationId: targetConvId, title: input.title, reuseExisting: false,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(idempotencyKey ? { createKey: idempotencyKey } : {}),
    })
  }

  const updateGroup = async (
    input: { groupId?: string; title?: string; objective?: string },
    conversationId: number | undefined,
  ): Promise<{ groupId: string; group: BoardViewDoc['group'] }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, true)
    if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim())) {
      throw new HelmxError('validation_error', 'title 必须是非空字符串', 400, {})
    }
    if (input.objective !== undefined && typeof input.objective !== 'string') {
      throw new HelmxError('validation_error', 'objective 必须是字符串', 400, {})
    }
    await groups.updateGroup(group.id, {
      ...(input.title !== undefined ? { title: input.title.trim().slice(0, 120) } : {}),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
    })
    return { groupId: group.id, group: groups.buildBoardView(group.id).group }
  }

  const closeGroup = async (
    input: { groupId?: string; keepWorktree?: boolean; abortRunning?: boolean; force?: boolean; allowUnverifiedUsage?: boolean; summary?: string },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ closed: true; groupId: string; retainedWorktrees: RetainedWorktreeInfo[]; uncleanedWorktrees?: UncleanedWorktreeInfo[] }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, false)
    if (group.status === 'closed') return { closed: true, groupId: group.id, retainedWorktrees: group.retainedWorktrees ?? [] }

    return enqueueDispatch(`group:${group.id}`, async () => {
      dispatchGuard.beginClosing(group.id)
      try {
        await dispatchGuard.awaitInflight(group.id)
        const freshGroup = groups.getGroup(group.id)
        if (!freshGroup) throw groupNotFoundError(group.id)
        if (freshGroup.status === 'closed') return { closed: true, groupId: freshGroup.id, retainedWorktrees: freshGroup.retainedWorktrees ?? [] }

        const closing: GroupClosing = {
          ctx,
          coordinator,
          signal,
          abortRunning: input.abortRunning === true,
          keepWorktree: input.keepWorktree === true,
          force: input.force === true,
          allowUnverifiedUsage: input.allowUnverifiedUsage === true,
          summary: input.summary,
        }
        const activeMembers = freshGroup.members.filter((m) => m.lifecycle === 'active')
        await abortOrRejectBusyMembers(closing, freshGroup, activeMembers)

        const worktreeChecks = await checkMemberWorktrees(closing, activeMembers)
        assertNoUnmergedWorktrees(closing, freshGroup, worktreeChecks)

        const retainedById = await recheckRetainedWorktrees(closing, freshGroup)
        const uncleanedWorktrees = await settleMemberWorktrees(closing, freshGroup, worktreeChecks, retainedById)
        const retainedWorktrees = [...retainedById.values()]

        await finalizeGroupClosure(closing, freshGroup, activeMembers, retainedWorktrees)
        return {
          closed: true,
          groupId: freshGroup.id,
          retainedWorktrees,
          ...(uncleanedWorktrees.length > 0 ? { uncleanedWorktrees } : {}),
        }
      } finally {
        dispatchGuard.endClosing(group.id)
      }
    })
  }

  const listGroups = (
    input: { status?: CollabGroupStatus; coordinatorConversationId?: number } = {},
  ): { groups: ListGroupSummary[] } => {
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'closed') {
      throw new HelmxError('validation_error', `status 必须是 'active' 或 'closed'（收到：${String(input.status)}）`, 400, {
        status: input.status,
      })
    }
    if (input.coordinatorConversationId !== undefined && !isPosIntId(input.coordinatorConversationId)) {
      throw new HelmxError(
        'validation_error',
        `coordinatorConversationId 必须是正整数（收到：${String(input.coordinatorConversationId)}）`,
        400,
        { coordinatorConversationId: input.coordinatorConversationId },
      )
    }
    const summaries: ListGroupSummary[] = []
    for (const g of groups.listGroups()) {
      if (input.status !== undefined && g.status !== input.status) continue
      if (input.coordinatorConversationId !== undefined && g.coordinatorConversationId !== input.coordinatorConversationId) continue
      const activeMembers = g.status === 'active' ? g.members.filter((m) => m.lifecycle === 'active') : []
      const activeWorkingMembers = activeMembers
        .filter((m) => isWorkerBusy(coordinator, m.conversationId, undefined, g.id, m.name))
        .map((m) => m.name)
      summaries.push({
        groupId: g.id,
        title: g.title,
        ...(g.objective !== undefined ? { objective: g.objective } : {}),
        status: g.status,
        coordinatorConversationId: g.coordinatorConversationId,
        headSeq: g.headSeq,
        memberCount: g.members.length,
        activeMemberCount: activeMembers.length,
        activeWorkingMembers,
        retainedWorktreeCount: g.retainedWorktrees?.length ?? 0,
        createdAt: g.createdAt,
        ...(g.closedAt !== undefined ? { closedAt: g.closedAt } : {}),
      })
    }
    return { groups: summaries }
  }

  return { createGroup, updateGroup, closeGroup, listGroups }
}
