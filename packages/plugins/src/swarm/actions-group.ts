import { HelmxError, type ConversationSummary, type HelmxPluginContext } from '@helmx/protocol'
import {
  ARCHIVED_COORDINATOR_TAG, ARCHIVED_WORKER_TAG, COORDINATOR_TAG, WORKER_TAG,
  assertGroupId, groupClosedError, groupNotFoundError, isPosIntId, setConversationTags, snapshotMemberTiming, swarmError,
  type BoardViewDoc, type CollabGroupRecord, type RetainedWorktreeInfo, type SwarmCoordinator,
} from './contracts.js'
import {
  checkMemberWorktree, inspectManagedWorktree, isIgnorableWorktreeError, settleMemberWorktree, toRetainedWorktreeInfo,
  type CheckedMemberWorktree,
} from './worktree-bridge.js'

export interface DispatchWorkerResult {
  workerConversationId: number; groupId: string; name: string; worktreeId?: string; postSeq: number
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
      groups.syncProjections()
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

export function createGroupHandlers(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  dispatchGuard: SwarmDispatchGuard = createSwarmDispatchGuard(),
) {
  const { readConversationOrUndefined, enqueueDispatch, groups } = coordinator

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
    input: { groupId?: string; keepWorktree?: boolean; abortRunning?: boolean; force?: boolean; summary?: string },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ closed: true; groupId: string; retainedWorktrees: RetainedWorktreeInfo[] }> => {
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, false)
    if (group.status === 'closed') return { closed: true, groupId: group.id, retainedWorktrees: group.retainedWorktrees ?? [] }

    return enqueueDispatch(`group:${group.id}`, async () => {
      dispatchGuard.beginClosing(group.id)
      try {
        await dispatchGuard.awaitInflight(group.id)
        const freshGroup = groups.getGroup(group.id)
        if (!freshGroup) throw groupNotFoundError(group.id)
        if (freshGroup.status === 'closed') return { closed: true, groupId: freshGroup.id, retainedWorktrees: freshGroup.retainedWorktrees ?? [] }

        const activeMembers = freshGroup.members.filter((m) => m.lifecycle === 'active')
        for (const m of activeMembers) {
          const s = readConversationOrUndefined(m.conversationId)
          if (!s || !isWorkerBusy(coordinator, m.conversationId, s.status, freshGroup.id, m.name)) continue
          if (input.abortRunning === true) {
            if (s.status === 'working' || s.status === 'blocked') await ctx.host.abortConversationGuarded(m.conversationId, { expectedOwnership: 'helmx' })
            continue
          }
          throw swarmError('swarm_worker_busy', `协作组 '${freshGroup.id}' 成员 @${m.name} (#${m.conversationId}) 仍在运行中；请等待完工或传 abortRunning: true`, 409, {
            groupId: freshGroup.id, memberName: m.name, workerConversationId: m.conversationId,
          })
        }

        const worktreeChecks: CheckedMemberWorktree[] = []
        for (const m of activeMembers) {
          const checked = await checkMemberWorktree(ctx, m, signal)
          if (checked) worktreeChecks.push(checked)
        }

        const keepWorktree = input.keepWorktree === true
        if (!keepWorktree && input.force !== true) {
          const unmerged = worktreeChecks.filter((i) => i.inspected.exists && (i.isDirty || i.unmergedCommits > 0))
          if (unmerged.length > 0) {
            const branches = unmerged.map((i) => `@${i.member.name}:${i.inspected.currentBranch ?? i.inspected.record.branch}`).join(', ')
            throw swarmError(
              'swarm_worktree_unmerged',
              `协作组 '${freshGroup.id}' 含未合入或脏工作树分支（${branches}）；请传 keepWorktree: true 解锁主控合入收尾后再清理，或显式传 force: true 放弃未合入内容直接收尾`,
              409,
              {
                groupId: freshGroup.id,
                unmergedWorktrees: unmerged.map((i) => ({ ...toRetainedWorktreeInfo(i.member.name, i.member.nodeId, i.worktreeId, i.inspected, i.unmergedCommits), dirtyCount: i.inspected.dirtyFileCount })),
              },
            )
          }
        }

        const retainedById = new Map<string, RetainedWorktreeInfo>()
        for (const prev of freshGroup.retainedWorktrees ?? []) {
          try {
            const inspected = await inspectManagedWorktree(ctx, prev.worktreeId, signal)
            const unmergedCommits = inspected.exists ? (inspected.unmergedCommits ?? inspected.commitsAhead ?? 0) : 0
            if (inspected.exists && (inspected.dirtyFileCount > 0 || unmergedCommits > 0)) {
              retainedById.set(prev.worktreeId, toRetainedWorktreeInfo(prev.memberName, prev.nodeId, prev.worktreeId, inspected, unmergedCommits))
            }
          } catch (err) {
            if (!isIgnorableWorktreeError(err)) throw err
          }
        }
        for (const item of worktreeChecks) {
          const retained = await settleMemberWorktree(ctx, freshGroup.id, item, { keepWorktree, force: input.force === true, cleanupCleanWhenKeeping: true, signal })
          if (retained) retainedById.set(retained.worktreeId, retained)
        }
        const retainedWorktrees = [...retainedById.values()]

        const now = Date.now()
        await groups.mutateGroup(freshGroup.id, (draft) => {
          draft.status = 'closed'
          draft.closedAt = now
          draft.updatedAt = now
          draft.retainedWorktrees = retainedWorktrees
          delete draft.lastReportHadActiveWorkers
          delete draft.inflightReport
          delete draft.peerHopsSinceCoordinator
          if (input.summary?.trim()) draft.closeSummary = input.summary.trim()
          for (const m of draft.members) {
            if (m.lifecycle !== 'active') continue
            const timing = snapshotMemberTiming(readConversationOrUndefined(m.conversationId), now)
            m.lifecycle = 'archived'
            m.archivedAt = now
            if (timing.runDurationMs !== undefined) m.runDurationMs = timing.runDurationMs
            if (timing.turnCount !== undefined) m.turnCount = timing.turnCount
          }
          return { group: draft, result: undefined }
        })

        for (const m of activeMembers) {
          const s = readConversationOrUndefined(m.conversationId)
          if (s) await setConversationTags(ctx, s, ARCHIVED_WORKER_TAG, [WORKER_TAG])
        }
        const coordConv = readConversationOrUndefined(freshGroup.coordinatorConversationId)
        if (coordConv?.tags.includes(COORDINATOR_TAG)) await setConversationTags(ctx, coordConv, ARCHIVED_COORDINATOR_TAG, [COORDINATOR_TAG])

        groups.syncProjections()
        return { closed: true, groupId: freshGroup.id, retainedWorktrees }
      } finally {
        dispatchGuard.endClosing(group.id)
      }
    })
  }

  return { createGroup, updateGroup, closeGroup }
}
