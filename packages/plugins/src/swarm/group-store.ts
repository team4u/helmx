/**
 * builtin:swarm single-source-of-truth group store & runtime facade.
 * Persistence order: append+datasync board.jsonl BEFORE atomicWriteFile meta.json.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { redactJsonValue, type HelmxPluginContext, type MaybePromise } from '@helmx/protocol'
import {
  ACTIONABLE_WAKE_KINDS,
  COORDINATOR_BATCH_WINDOW_MS,
  COORDINATOR_ESCALATION_KINDS,
  assertBoardPost,
  assertCollabGroupRecord,
  assertGroupId,
  createKeyedQueue,
  groupClosedError,
  groupNotFoundError,
  isEnoent,
  isLifecycleTeardownError,
  swarmError,
  type AppendPostDraft,
  type BoardPost,
  type BoardViewDoc,
  type CollabGroupRecord,
  type CollabGroupRuntime,
  type GroupMemberState,
  type MemberLiveSnapshot,
  type SwarmCoordinator,
} from './contracts.js'
import { shouldFlushCoordinatorReport, synthesizeBoardView } from './board-router.js'
import { reconcileOrphanConversations, reconcileOrphanWorktreeHolds } from './recovery.js'
import { createWakeDispatcher } from './wake-dispatcher.js'
import { createBoardProjections } from './projections.js'
import { createMemberHealing } from './member-healing.js'

const generateGroupId = (): string => `grp_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`

export function createCollabGroupRuntime(
  ctx: HelmxPluginContext,
  getCoordinator: () => SwarmCoordinator,
): CollabGroupRuntime {
  const groupsRootDir = (): string => join(ctx.dataDir, 'groups')
  const groupsById = new Map<string, CollabGroupRecord>()
  const postsByGroup = new Map<string, BoardPost[]>()
  const groupQueue = createKeyedQueue()
  const managedWorkerReleases = new Map<number, () => void>()
  let stopping = false
  let orphanWorktreesReconciled = false

  const isAlive = (): boolean => {
    const coord = getCoordinator()
    return !stopping && coord.isActive() && !coord.isShutdown() && !ctx.host.isClosing
  }
  const logDiagnostic = (msg: string): void => console.error(`[swarm] ${ctx.host.redact(msg)}`)
  const groupDirOf = (id: string): string => join(groupsRootDir(), id)
  const metaPathOf = (id: string): string => join(groupDirOf(id), 'meta.json')
  const boardPathOf = (id: string): string => join(groupDirOf(id), 'board.jsonl')
  const redactObject = <T>(value: T): T => redactJsonValue(value, (text) => ctx.host.redact(text)) as T

  const appendBoardLineDurableLocked = async (groupId: string, post: BoardPost): Promise<void> => {
    await mkdir(groupDirOf(groupId), { recursive: true })
    const handle = await open(boardPathOf(groupId), 'a')
    try {
      await handle.writeFile(`${JSON.stringify(post)}\n`, 'utf8')
      await handle.datasync()
    } finally {
      await handle.close()
    }
  }

  const runGroupLocked = <T>(groupId: string, fn: () => Promise<T>): Promise<T> =>
    groupQueue.enqueue(groupId, () => mkdir(groupDirOf(groupId), { recursive: true }).then(() => ctx.host.withFileLock(metaPathOf(groupId), fn)))

  const resolveMemberLive = (conversationId: number): MemberLiveSnapshot => {
    const s = getCoordinator().readConversationOrUndefined(conversationId)
    if (!s) return { liveState: 'missing' }
    return {
      liveState: s.status,
      model: s.model,
      ...(s.runDurationMs !== undefined ? { runDurationMs: s.runDurationMs } : {}),
      ...(s.runStartedAt !== undefined ? { runStartedAt: s.runStartedAt } : {}),
      ...(s.pendingAskSince !== undefined ? { pendingAskSince: s.pendingAskSince } : {}),
      turnCount: s.completionSeq,
    }
  }

  const getBusyActiveMemberNames = (group: CollabGroupRecord, excludeConvId?: number): Set<string> => {
    const coord = getCoordinator()
    const busy = new Set<string>()
    for (const m of group.members) {
      if (m.lifecycle !== 'active' || m.conversationId === excludeConvId) continue
      if (coord.settlingWorkers.has(m.conversationId)) { busy.add(m.name); continue }
      const s = coord.readConversationOrUndefined(m.conversationId)
      if (s && (s.status === 'working' || s.status === 'blocked' || m.pendingWakeupSeq > m.readCursorSeq)) busy.add(m.name)
    }
    return busy
  }

  const ensureWorkerManaged = (id: number): void => {
    if (stopping || !getCoordinator().isActive() || managedWorkerReleases.has(id)) return
    if (!getCoordinator().readConversationOrUndefined(id)) return
    managedWorkerReleases.set(id, ctx.host.manageConversation(id))
  }

  const releaseManagedWorker = (id: number): void => {
    const release = managedWorkerReleases.get(id)
    if (!release) return
    managedWorkerReleases.delete(id)
    try {
      release()
    } catch (err) {
      if (!isLifecycleTeardownError(err)) getCoordinator().reportError(`释放受管 Worker 会话 #${id} 保护失败`, err)
    }
  }

  const releaseAllManagedWorkers = (): void => {
    for (const id of [...managedWorkerReleases.keys()]) releaseManagedWorker(id)
  }

  const persistMetaLocked = async (record: CollabGroupRecord): Promise<CollabGroupRecord> => {
    const clean = assertCollabGroupRecord(redactObject(structuredClone(record)))
    await mkdir(groupDirOf(clean.id), { recursive: true })
    await ctx.host.atomicWriteFile(metaPathOf(clean.id), `${JSON.stringify(clean, null, 2)}\n`)
    groupsById.set(clean.id, clean)
    if (!stopping && getCoordinator().isActive()) {
      if (clean.status !== 'active') {
        dispatcher.forgetGroupReportState(clean.id)
        for (const m of clean.members) releaseManagedWorker(m.conversationId)
      } else {
        for (const m of clean.members) {
          if (m.lifecycle === 'active') ensureWorkerManaged(m.conversationId)
          else releaseManagedWorker(m.conversationId)
        }
      }
    }
    return clean
  }

  const mutateGroup = async <T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ): Promise<T> => {
    const validId = assertGroupId(groupId)
    const out = await runGroupLocked(validId, async () => {
      const current = groupsById.get(validId)
      if (!current) throw groupNotFoundError(validId)
      const { group: next, result } = await fn(structuredClone(current), postsByGroup.get(validId) ?? [])
      await persistMetaLocked(next)
      return result
    })
    projections.syncIndex()
    projections.syncProjections()
    return out
  }

  const updateGroupMeta = (groupId: string, fn: (draft: CollabGroupRecord) => void): Promise<void> =>
    mutateGroup(groupId, (draft) => { fn(draft); return { group: draft, result: undefined } })

  const updateMember = (groupId: string, memberName: string, fn: (member: GroupMemberState) => void): Promise<void> =>
    updateGroupMeta(groupId, (draft) => {
      const target = draft.members.find((m) => m.name === memberName)
      if (target) fn(target)
    })

  const appendPost = async (groupId: string, draft: AppendPostDraft): Promise<BoardPost> => {
    const validId = assertGroupId(groupId)
    let membersToWake: string[] = []
    let shouldNotifyCoordinator = false
    let breakerTrip: { seq: number; from: string; to: string[]; maxPeerHops: number } | undefined

    const createdPost = await runGroupLocked(validId, async () => {
      const current = groupsById.get(validId)
      if (!current) throw groupNotFoundError(validId)

      if (draft.idempotencyKey !== undefined) {
        const existing = (postsByGroup.get(validId) ?? []).find((p) => p.idempotencyKey === draft.idempotencyKey)
        if (existing) {
          if (existing.wake) {
            for (const target of existing.resolvedTargets) {
              const m = target !== 'coordinator' ? current.members.find((i) => i.name === target && i.lifecycle === 'active') : undefined
              if (m && m.pendingWakeupSeq > m.readCursorSeq) membersToWake.push(m.name)
            }
          }
          if (
            existing.from !== 'coordinator' &&
            ((existing.resolvedTargets.includes('coordinator') && existing.wake) || COORDINATOR_ESCALATION_KINDS.has(existing.kind)) &&
            current.coordinatorPendingSeq > current.coordinatorNotifiedSeq
          ) {
            shouldNotifyCoordinator = true
          }
          return existing
        }
      }

      const next = structuredClone(current)
      const now = Date.now()
      const seq = next.headSeq + 1
      const post = assertBoardPost(
        redactObject<BoardPost>({
          seq, groupId: validId, from: draft.from, to: [...draft.to], resolvedTargets: [...draft.resolvedTargets],
          wake: draft.wake, kind: draft.kind, refs: [...draft.refs], body: draft.body,
          ...(draft.idempotencyKey !== undefined ? { idempotencyKey: draft.idempotencyKey } : {}),
          ...(draft.worktreeSnapshot !== undefined ? { worktreeSnapshot: draft.worktreeSnapshot } : {}),
          createdAt: now,
        }),
      )

      const sender = next.members.find((m) => m.name === post.from && m.lifecycle === 'active')
      if (sender) {
        sender.lastPostSeq = post.seq
        sender.lastOutboundEdge = { seq: post.seq, to: [...post.to], kind: post.kind }
        if (sender.readCursorSeq === current.headSeq) sender.readCursorSeq = post.seq
      }

      const activeNames = new Set(next.members.filter((m) => m.lifecycle === 'active').map((m) => m.name))
      const wakeablePeers =
        post.from !== 'coordinator' && post.from !== 'system' && post.wake && post.kind !== 'blocker'
          ? post.resolvedTargets.filter((t) => t !== 'coordinator' && activeNames.has(t))
          : []

      if (post.from === 'coordinator' || (post.from === 'system' && COORDINATOR_ESCALATION_KINDS.has(post.kind))) {
        delete next.peerHopsSinceCoordinator
      } else if (wakeablePeers.length > 0) {
        const maxPeerHops = getCoordinator().getConfig().maxPeerHopsWithoutCoordinator
        const nextHops = (next.peerHopsSinceCoordinator ?? 0) + 1
        if (nextHops > maxPeerHops) {
          breakerTrip = { seq: post.seq, from: post.from, to: [...post.to], maxPeerHops }
          delete next.peerHopsSinceCoordinator
        } else {
          next.peerHopsSinceCoordinator = nextHops
        }
      }

      membersToWake = []
      if (post.wake && !breakerTrip) {
        for (const target of post.resolvedTargets) {
          if (target === 'coordinator') continue
          const m = next.members.find((i) => i.name === target && i.lifecycle === 'active')
          if (m) {
            m.pendingWakeupSeq = post.seq
            if (ACTIONABLE_WAKE_KINDS.has(post.kind)) m.lastWakeTaskSeq = post.seq
            membersToWake.push(m.name)
          }
        }
      }

      if (
        post.from !== 'coordinator' &&
        ((post.resolvedTargets.includes('coordinator') && post.wake) || COORDINATOR_ESCALATION_KINDS.has(post.kind))
      ) {
        next.coordinatorPendingSeq = post.seq
        shouldNotifyCoordinator = true
      }

      if (draft.lastStallWatermarkAfterPost !== undefined) next.lastStallWatermark = draft.lastStallWatermarkAfterPost
      next.headSeq = post.seq
      next.updatedAt = now

      await appendBoardLineDurableLocked(validId, post)
      await persistMetaLocked(next)
      const list = postsByGroup.get(validId) ?? []
      list.push(post)
      postsByGroup.set(validId, list)
      return post
    })

    projections.syncIndex()
    projections.syncProjections()

    if (breakerTrip) {
      await appendPost(validId, {
        from: 'system', to: ['coordinator'], resolvedTargets: ['coordinator'], wake: true, kind: 'blocker', refs: [breakerTrip.seq],
        body: `Peer handoff circuit breaker tripped after ${breakerTrip.maxPeerHops} consecutive peer-to-peer wakeups without coordinator intervention (latest #${breakerTrip.seq} from @${breakerTrip.from} -> ${breakerTrip.to.join(', ')}). Automated peer wakeups paused for coordinator decision.`,
      })
      return createdPost
    }

    for (const memberName of membersToWake) void dispatcher.deliverWorkerWakeup(validId, memberName)
    if (shouldNotifyCoordinator) {
      const latest = groupsById.get(validId)
      if (latest && shouldFlushCoordinatorReport({ group: latest, posts: postsByGroup.get(validId) ?? [], busyMemberNames: getBusyActiveMemberNames(latest) })) {
        void dispatcher.scheduleCoordinatorReport(validId, COORDINATOR_BATCH_WINDOW_MS)
      }
    }
    return createdPost
  }

  const dispatcher = createWakeDispatcher({
    ctx, getCoordinator, isAlive,
    getGroup: (id) => groupsById.get(id),
    getPosts: (id) => postsByGroup.get(id) ?? [],
    updateGroupMeta, updateMember,
    reportLockPath: (id) => join(groupDirOf(id), 'report.lock'),
    wakeupLockPath: (id, name) => join(groupDirOf(id), `wakeup-${name}.lock`),
    resolveMemberLive, getBusyActiveMemberNames,
  })

  const projections = createBoardProjections({
    getCoordinator, isStopping: () => stopping,
    getAllGroups: () => [...groupsById.values()],
    getPosts: (id) => postsByGroup.get(id),
    resolveMemberLive,
  })

  const healing = createMemberHealing({
    ctx, getCoordinator, isAlive,
    getGroup: (id) => groupsById.get(id),
    getPosts: (id) => postsByGroup.get(id),
    setPostsCache: (id, posts) => void postsByGroup.set(id, posts),
    updateGroupMeta, updateMember, appendPost, persistMeta: persistMetaLocked, runGroupLocked,
    metaPath: metaPathOf, boardPath: boardPathOf, logDiagnostic, releaseManagedWorker, dispatcher,
  })

  const findActiveGroupByCoordinator = (id: number): CollabGroupRecord | undefined => {
    for (const g of groupsById.values()) if (g.status === 'active' && g.coordinatorConversationId === id) return g
    return undefined
  }

  const findGroupByParticipant = (id: number) => {
    for (const g of groupsById.values()) {
      if (g.status !== 'active') continue
      if (g.coordinatorConversationId === id) return { group: g, role: 'coordinator' as const }
      const member = g.members.find((m) => m.conversationId === id && m.lifecycle === 'active')
      if (member) return { group: g, role: 'worker' as const, member }
    }
    return undefined
  }

  const findLatestGroupForConversation = (id: number): CollabGroupRecord | undefined =>
    findGroupByParticipant(id)?.group ??
    [...groupsById.values()]
      .filter((g) => g.coordinatorConversationId === id || g.members.some((m) => m.conversationId === id))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0]

  const flushCoordinatorOrCheckStall = async (group: CollabGroupRecord): Promise<void> => {
    if (!group.coordinatorDetached && dispatcher.canFlushCoordinator(group)) {
      await dispatcher.flushCoordinatorReport(group.id)
      return
    }
    await healing.checkAndEmitQuiescenceStall(group.id)
  }

  return {
    async loadAllFromDisk() {
      stopping = false
      orphanWorktreesReconciled = false
      releaseAllManagedWorkers()
      groupsById.clear()
      postsByGroup.clear()
      groupQueue.clear()
      projections.reset()
      dispatcher.resetWatermarks()

      let dirEntries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        dirEntries = await readdir(groupsRootDir(), { withFileTypes: true })
      } catch (err) {
        if (!isEnoent(err)) throw err
      }
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const groupId = assertGroupId(entry.name)
        const { record, posts } = await healing.loadGroupFromDisk(groupId)
        groupsById.set(groupId, record)
        if (posts !== undefined) postsByGroup.set(groupId, posts)
      }
      for (const g of [...groupsById.values()]) {
        if (g.status !== 'active') continue
        for (const m of [...g.members]) {
          if (m.lifecycle !== 'active') continue
          if (!getCoordinator().readConversationOrUndefined(m.conversationId)) await healing.reconcileDeletedWorker(g.id, m.conversationId)
          else ensureWorkerManaged(m.conversationId)
        }
      }
      projections.syncIndex()
      projections.syncProjections()
    },

    async reconcileOrphansOnBoot() {
      if (stopping) return
      await reconcileOrphanConversations(ctx, groupsById.values())
      orphanWorktreesReconciled = await reconcileOrphanWorktreeHolds(ctx, groupsById.values(), logDiagnostic)
    },

    async reconcileRecoveredGroups() {
      if (!isAlive()) return
      if (!orphanWorktreesReconciled) orphanWorktreesReconciled = await reconcileOrphanWorktreeHolds(ctx, groupsById.values(), logDiagnostic)
      for (const g of [...groupsById.values()]) {
        if (!isAlive()) return
        if (g.status === 'active') await healing.reconcileSingleRecoveredGroup(g.id)
      }
      projections.syncProjections()
    },

    async stopAndClear() {
      stopping = true
      await dispatcher.drain()
      releaseAllManagedWorkers()
      groupQueue.clear()
      groupsById.clear()
      postsByGroup.clear()
      projections.reset()
    },

    liveTaskLabels: () => dispatcher.liveTaskLabels(),
    inUseItems: () =>
      [...groupsById.values()]
        .filter((g) => g.status === 'active')
        .map((g) => ({ kind: 'swarm_group', id: g.id, label: `Active swarm collaboration group "${g.title}" (${g.id})` })),
    listGroups: () => [...groupsById.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    getGroup: (id) => groupsById.get(id),
    findActiveGroupByCoordinator,
    findGroupByParticipant,
    findLatestGroupForConversation,
    getPosts: (id) => postsByGroup.get(id) ?? [],
    ensurePostsLoaded: healing.ensurePostsLoaded,

    buildBoardView(groupId: string): BoardViewDoc {
      const validId = assertGroupId(groupId)
      const group = groupsById.get(validId)
      if (!group) throw groupNotFoundError(validId)
      return synthesizeBoardView({ group, posts: postsByGroup.get(validId) ?? [], previewLimit: getCoordinator().getConfig().boardPreviewLimit, resolveMemberLive }).view
    },

    syncProjections: projections.syncProjections,

    onConversationUpsert(id: number) {
      if (stopping) return
      const affected = new Set<number>()
      for (const g of groupsById.values()) {
        if (g.coordinatorConversationId === id || g.members.some((m) => m.conversationId === id)) affected.add(g.coordinatorConversationId)
      }
      for (const coordId of affected) projections.syncCoordinatorProjection(coordId)
    },

    async onConversationDeleted(id: number) {
      if (stopping) return
      releaseManagedWorker(id)
      for (const g of [...groupsById.values()]) {
        if (g.coordinatorConversationId === id && !g.coordinatorDetached) {
          await updateGroupMeta(g.id, (d) => { d.coordinatorDetached = true; d.updatedAt = Date.now() })
        } else if (g.status === 'active' && g.members.some((m) => m.conversationId === id && m.lifecycle === 'active')) {
          await healing.reconcileDeletedWorker(g.id, id)
        } else if (g.members.some((m) => m.conversationId === id)) {
          projections.syncProjections()
        }
      }
      projections.forgetCoordinator(id)
    },

    async createGroup(input) {
      const existing = findActiveGroupByCoordinator(input.coordinatorConversationId)
      if (existing) {
        if (input.createKey !== undefined && existing.createKey === input.createKey) return existing
        throw swarmError(
          'swarm_group_already_active',
          `会话 #${input.coordinatorConversationId} 已存在活跃协作组 '${existing.id}'（同会话限 1 个活跃组）`,
          409,
          { conversationId: input.coordinatorConversationId, groupId: existing.id },
        )
      }
      const now = Date.now()
      const groupId = generateGroupId()
      const record: CollabGroupRecord = {
        id: groupId, title: input.title.trim(),
        ...(input.objective?.trim() ? { objective: input.objective.trim() } : {}),
        coordinatorConversationId: input.coordinatorConversationId,
        ...(input.createKey !== undefined ? { createKey: input.createKey } : {}),
        status: 'active', members: [], headSeq: 0, coordinatorNotifiedSeq: 0, coordinatorPendingSeq: 0, createdAt: now, updatedAt: now,
      }
      const saved = await runGroupLocked(groupId, () => {
        postsByGroup.set(groupId, [])
        return persistMetaLocked(record)
      })
      projections.syncIndex()
      projections.syncProjections()
      return saved
    },

    updateGroup: (groupId, patch) =>
      mutateGroup(groupId, (draft) => {
        if (draft.status !== 'active') throw groupClosedError(draft.id, '已结单，无法修改')
        if (patch.title !== undefined) {
          const t = patch.title.trim()
          if (!t) throw swarmError('validation_error', 'title 不能为空', 400)
          draft.title = t
        }
        if (patch.objective !== undefined) {
          const obj = patch.objective.trim()
          if (obj) draft.objective = obj
          else delete draft.objective
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: draft }
      }),

    async addMemberWithBrief(groupId, memberInit, briefPrompt) {
      const validId = assertGroupId(groupId)
      const added = await runGroupLocked(validId, async () => {
        const current = groupsById.get(validId)
        if (!current) throw groupNotFoundError(validId)
        if (memberInit.dispatchKey !== undefined) {
          const existingM = current.members.find((m) => m.name === memberInit.name && m.dispatchKey === memberInit.dispatchKey)
          if (existingM) {
            const list = postsByGroup.get(validId) ?? []
            const existingP = (existingM.briefPostSeq !== undefined ? list.find((p) => p.seq === existingM.briefPostSeq) : undefined) ?? list.find((p) => p.kind === 'brief' && p.to.includes(existingM.name))
            if (existingP) return { group: current, member: existingM, post: existingP, replayed: true }
          }
        }
        if (current.status !== 'active') throw groupClosedError(validId, '已结单，无法招募新成员')

        const next = structuredClone(current)
        const now = Date.now()
        const seq = next.headSeq + 1
        const memberState: GroupMemberState = { ...memberInit, briefPostSeq: seq, readCursorSeq: current.headSeq, pendingWakeupSeq: seq, lastWakeTaskSeq: seq }
        next.members.push(memberState)
        const post = assertBoardPost(
          redactObject<BoardPost>({
            seq, groupId: validId, from: 'coordinator', to: [memberState.name], resolvedTargets: [memberState.name],
            wake: true, kind: 'brief', refs: [], body: briefPrompt, createdAt: now,
          }),
        )
        delete next.peerHopsSinceCoordinator
        next.headSeq = seq
        next.updatedAt = now
        await appendBoardLineDurableLocked(validId, post)
        const savedGroup = await persistMetaLocked(next)
        const list = postsByGroup.get(validId) ?? []
        list.push(post)
        postsByGroup.set(validId, list)
        return { group: savedGroup, member: savedGroup.members.find((m) => m.name === memberState.name)!, post, replayed: false }
      })

      projections.syncIndex()
      projections.syncProjections()
      if (!added.replayed || (added.member.pendingWakeupSeq > added.member.readCursorSeq && !added.member.inflightWakeup)) {
        await dispatcher.deliverWorkerWakeup(validId, added.member.name)
      }
      return { group: added.group, member: added.member, post: added.post }
    },

    appendPost,
    mutateGroup,
    onMemberTurnSettled: healing.onMemberTurnSettled,

    async onCoordinatorTurnSettled(id: number) {
      if (!isAlive()) return
      const group = findActiveGroupByCoordinator(id)
      if (!group) return
      dispatcher.forgetCoordReportCompletion(group.id)
      projections.syncProjections()
      await flushCoordinatorOrCheckStall(group)
    },

    hasInflightWakeup: (groupId, memberName) => dispatcher.hasInflightWakeup(groupId, memberName),

    async afterMemberArchived(groupId: string) {
      if (!isAlive()) return
      const group = groupsById.get(groupId)
      if (!group || group.status !== 'active' || group.coordinatorDetached) return
      await flushCoordinatorOrCheckStall(group)
    },
  }
}
