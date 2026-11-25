import { HelmxError, assertProfileId, type ConversationSummary, type HelmxPluginContext } from '@helmx/protocol'
import type { AcquireWorktreeResult } from '../contracts.js'
import { assertWorkerConversationId, assertWorkerCwd, assertWorkerNodeId, recentEntrySummaries } from '../entry-text.js'
import {
  ARCHIVED_WORKER_TAG, COORDINATOR_TAG, SWARM_PLUGIN_ID, WORKER_TAG,
  assertGroupId, assertMemberName, groupClosedError, setConversationTags, snapshotMemberTiming, swarmError,
  type CollabGroupRecord, type GroupMemberState, type RetainedWorktreeInfo, type SwarmCoordinator, type UncleanedWorktreeInfo, type WorkerAccess, type WorkerIsolation,
} from './contracts.js'
import {
  assertCoordinatorAuthority, createSwarmDispatchGuard, isWorkerBusy, resolveCoordinatorGroup,
  type DispatchWorkerResult, type SwarmDispatchGuard,
} from './actions-group.js'
import {
  WORKTREE_PLUGIN_ID, checkMemberWorktree, cleanupManagedWorktree, releaseWorktreeHold, settleMemberWorktree,
} from './worktree-bridge.js'

export interface DispatchInput {
  prompt: string; groupId?: string; name: string; profileId?: string; access?: WorkerAccess
  isolation?: WorkerIsolation; forkFrom?: string; forkEntryId?: number; model?: string
  effort?: string; title?: string; nodeId?: string; cwd?: string
}

export interface InspectWorkerResult {
  conversationId: number; groupId: string; name: string; worktreeId?: string; title: string
  profileId: string; status: string; doing: string | null; completionSeq: number
  artifacts: Array<{ id: string; name: string; size: number }>
  recentEntries: Array<{ id: string; kind: string; text: string }>
}

function optNonEmptyStr(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new HelmxError('validation_error', `${field} 必须是非空字符串`, 400, {})
  return value.trim()
}

function assertRestrictedNodeMatch(coordConvId: number, coordNodeId: string, resolvedNodeId: string, requestedNodeId?: string): void {
  if (resolvedNodeId === coordNodeId) return
  throw swarmError(
    'path_outside_workspace',
    `path_outside_workspace: resolved spawn target node '${resolvedNodeId}' differs from coordinator conversation node '${coordNodeId}'; this conversation is restricted to its working directory (Profile.restrictToCwd)`,
    403,
    { coordinatorConversationId: coordConvId, resolvedNodeId, coordinatorNodeId: coordNodeId, ...(requestedNodeId ? { requestedNodeId } : {}) },
  )
}

export function createWorkerHandlers(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  dispatchGuard: SwarmDispatchGuard = createSwarmDispatchGuard(),
) {
  const { getConfig, readConversationOrUndefined, reportError, enqueueDispatch, track, groups } = coordinator

  const ensureArchivedTag = async (id: number): Promise<void> => {
    const cur = readConversationOrUndefined(id)
    if (cur?.tags.includes(WORKER_TAG)) await setConversationTags(ctx, cur, ARCHIVED_WORKER_TAG, [WORKER_TAG])
  }

  const assertNotBusy = (groupId: string, m: Pick<GroupMemberState, 'name' | 'conversationId'>, s: ConversationSummary | undefined, msg: string): void => {
    if (s && isWorkerBusy(coordinator, m.conversationId, s.status, groupId, m.name)) {
      throw swarmError('swarm_worker_busy', msg, 409, { workerConversationId: m.conversationId, name: m.name, status: s.status })
    }
  }

  const resolveTargetWorker = (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    callerConvId: number | undefined,
  ): { group: CollabGroupRecord; member: GroupMemberState; workerConversationId: number } => {
    const hasId = input.workerConversationId !== undefined
    const hasName = Boolean(input.name?.trim())
    if (!hasId && !hasName) throw new HelmxError('validation_error', '必须指定 workerConversationId 或成员名 name', 400, {})
    if (hasName) {
      const name = assertMemberName(input.name)
      const group = input.groupId?.trim()
        ? groups.getGroup(assertGroupId(input.groupId))
        : callerConvId !== undefined ? groups.findLatestGroupForConversation(callerConvId) : undefined
      if (!group) throw swarmError('swarm_group_not_found', '未找到目标协作组', 404)
      const member = group.members.find((m) => m.name === name)
      if (!member) throw swarmError('swarm_unknown_target', `协作组 '${group.id}' 中不存在成员 '${name}'`, 404, { groupId: group.id, name })
      if (hasId && assertWorkerConversationId(input.workerConversationId) !== member.conversationId) {
        throw new HelmxError('validation_error', 'workerConversationId 与 name 指向不同会话', 400, {})
      }
      return { group, member, workerConversationId: member.conversationId }
    }
    const workerId = assertWorkerConversationId(input.workerConversationId)
    const targetGroupId = input.groupId?.trim() ? assertGroupId(input.groupId) : undefined
    for (const g of groups.listGroups()) {
      if (targetGroupId && g.id !== targetGroupId) continue
      const m = g.members.find((i) => i.conversationId === workerId)
      if (m) return { group: g, member: m, workerConversationId: workerId }
    }
    throw swarmError('not_found', `会话 #${workerId} 不是 ${SWARM_PLUGIN_ID} 登记的协作组成员`, 404, { workerConversationId: workerId })
  }

  const dispatchWorker = async (
    input: DispatchInput,
    conversationId: number | undefined,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<DispatchWorkerResult> => {
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      throw new HelmxError('validation_error', 'dispatch_worker 需要 prompt（非空文本）', 400, {})
    }
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, true)
    const memberName = assertMemberName(input.name)
    const access: WorkerAccess = input.access ?? 'readwrite'
    if (access !== 'readwrite' && access !== 'readonly') {
      throw new HelmxError('validation_error', `access 非法（期望 readwrite | readonly，收到：${String(access)}）`, 400, {})
    }
    const isolation: WorkerIsolation = input.isolation ?? 'inherit'
    if (isolation !== 'inherit' && isolation !== 'worktree') {
      throw new HelmxError('validation_error', `isolation 非法（期望 inherit | worktree，收到：${String(isolation)}）`, 400, {})
    }
    if (input.forkEntryId !== undefined && input.forkFrom === undefined) {
      throw new HelmxError('validation_error', '指定 forkEntryId 时必须同时指定 forkFrom', 400, {})
    }

    let sourceConvId: number | undefined
    if (input.forkFrom !== undefined) {
      const token = input.forkFrom.trim()
      if (token === 'coordinator') {
        sourceConvId = group.coordinatorConversationId
      } else {
        const peer = group.members.find((m) => m.name === (token.startsWith('@') ? token.slice(1) : token))
        if (!peer) throw swarmError('swarm_unknown_target', `forkFrom 目标成员 '${token}' 不存在`, 404, { groupId: group.id, forkFrom: token })
        sourceConvId = peer.conversationId
      }
    }

    const sourceSummary = sourceConvId !== undefined ? readConversationOrUndefined(sourceConvId) : undefined
    const coordSummary = readConversationOrUndefined(group.coordinatorConversationId)
    let targetProfile = sourceSummary?.profileId ?? coordSummary?.profileId ?? 'assistant'
    if (input.profileId !== undefined) {
      if (typeof input.profileId !== 'string') throw new HelmxError('validation_error', 'profileId 必须是字符串', 400, {})
      assertProfileId(input.profileId)
      targetProfile = input.profileId
    }
    const profileRecord = await ctx.host.profiles.get(targetProfile)
    if (!profileRecord) throw new HelmxError('validation_error', `Profile 不存在：${targetProfile}`, 400, { profileId: targetProfile })

    const requestedNodeId = input.nodeId === undefined ? undefined : assertWorkerNodeId(input.nodeId)
    const requestedCwd = input.cwd === undefined ? undefined : assertWorkerCwd(input.cwd)
    const model = input.model?.trim() || undefined
    const effort = input.effort?.trim() || undefined

    type Admission =
      | { kind: 'cached'; result: DispatchWorkerResult }
      | { kind: 'join'; promise: Promise<DispatchWorkerResult> }
      | { kind: 'run'; groupId: string; groupTitle: string; coordinatorConversationId: number; resolveGate: (r: DispatchWorkerResult) => void; rejectGate: (e: unknown) => void; releaseReservation: () => void }

    const admission = await enqueueDispatch<Admission>(`group:${group.id}`, async () => {
      const fresh = groups.getGroup(group.id)
      if (!fresh || fresh.status !== 'active' || dispatchGuard.isClosing(group.id)) throw groupClosedError(group.id, '已不可用或已结单')
      const existing = fresh.members.find((m) => m.name === memberName)
      if (existing) {
        if (idempotencyKey && existing.dispatchKey === idempotencyKey) {
          const postSeq = existing.briefPostSeq ?? groups.getPosts(fresh.id).find((p) => p.kind === 'brief' && p.to.includes(existing.name))?.seq ?? existing.lastWakeTaskSeq ?? fresh.headSeq
          return { kind: 'cached', result: { workerConversationId: existing.conversationId, groupId: fresh.id, name: existing.name, ...(existing.worktreeId ? { worktreeId: existing.worktreeId } : {}), postSeq } }
        }
        throw swarmError('swarm_member_conflict', `协作组 '${fresh.id}' 中成员名 '${memberName}' 已被占用`, 409, { groupId: fresh.id, name: memberName })
      }
      if (idempotencyKey) {
        const inflight = dispatchGuard.getPendingByKey(fresh.id, idempotencyKey)
        if (inflight) return { kind: 'join', promise: inflight }
      }
      if (dispatchGuard.hasPendingMember(fresh.id, memberName)) {
        throw swarmError('swarm_member_conflict', `协作组 '${fresh.id}' 中成员名 '${memberName}' 正在派工中`, 409, { groupId: fresh.id, name: memberName })
      }
      const maxMembers = getConfig().maxWorkersPerGroup
      if (fresh.members.filter((m) => m.lifecycle === 'active').length + dispatchGuard.pendingCount(fresh.id) >= maxMembers) {
        throw swarmError('swarm_group_member_limit', `协作组 '${fresh.id}' 活跃成员数已达上限 ${maxMembers}`, 409, { groupId: fresh.id, maxWorkersPerGroup: maxMembers })
      }

      let resolveGate!: (r: DispatchWorkerResult) => void
      let rejectGate!: (e: unknown) => void
      const inflightPromise = new Promise<DispatchWorkerResult>((res, rej) => { resolveGate = res; rejectGate = rej })
      inflightPromise.catch(() => undefined)
      return {
        kind: 'run', groupId: fresh.id, groupTitle: fresh.title, coordinatorConversationId: fresh.coordinatorConversationId,
        resolveGate, rejectGate, releaseReservation: dispatchGuard.reserve(fresh.id, memberName, idempotencyKey, inflightPromise),
      }
    })

    if (admission.kind === 'cached') return admission.result
    if (admission.kind === 'join') return admission.promise

    return track(`dispatch-worker:${admission.groupId}:${memberName}`, async () => {
      let createdId: number | undefined
      let acquiredWorktreeId: string | undefined
      try {
        const baseConvId = sourceConvId ?? admission.coordinatorConversationId
        const isPeerFork = sourceConvId !== undefined && sourceConvId !== admission.coordinatorConversationId
        const activeCoord = readConversationOrUndefined(admission.coordinatorConversationId) ?? coordSummary
        const coordProfile = isPeerFork && activeCoord
          ? (activeCoord.profileId === targetProfile ? profileRecord : await ctx.host.profiles.get(activeCoord.profileId))
          : undefined
        const coordRestricted = coordProfile?.restrictToCwd === true
        const coordNodeId = activeCoord?.nodeId ?? 'local'

        if (coordRestricted) {
          const activeSource = readConversationOrUndefined(sourceConvId!) ?? sourceSummary
          const predictedNode = requestedNodeId ?? (activeSource?.profileId === targetProfile ? (activeSource?.nodeId ?? profileRecord.nodeId ?? 'local') : (profileRecord.nodeId ?? activeSource?.nodeId ?? 'local'))
          assertRestrictedNodeMatch(admission.coordinatorConversationId, coordNodeId, predictedNode, requestedNodeId)
        }

        const resolvedTarget = await ctx.host.resolveSpawnTarget({
          parentConversationId: baseConvId, profileId: targetProfile,
          ...(requestedNodeId ? { requestNodeId: requestedNodeId } : {}),
          ...(requestedCwd ? { requestCwd: requestedCwd } : {}),
          ...(sourceConvId !== undefined ? { fork: true } : {}),
        })
        if (coordRestricted) {
          assertRestrictedNodeMatch(admission.coordinatorConversationId, coordNodeId, resolvedTarget.nodeId, requestedNodeId)
          if (requestedCwd) {
            await ctx.host.resolveSpawnTarget({
              parentConversationId: admission.coordinatorConversationId, profileId: targetProfile,
              requestNodeId: resolvedTarget.nodeId, requestCwd: requestedCwd,
            })
          }
        }

        let finalNodeId = resolvedTarget.nodeId
        let finalCwd = resolvedTarget.sourceCwd
        if (finalNodeId !== 'local' && !ctx.host.nodeIpc.isOnline(finalNodeId)) {
          throw swarmError('node_offline', `目标节点 '${finalNodeId}' 离线或未注册，无法派工`, 409, { nodeId: finalNodeId })
        }

        const workerTitle = (input.title?.trim() || `[${admission.groupTitle}] @${memberName}`).slice(0, 80)
        const created = sourceConvId !== undefined
          ? await ctx.host.forkConversation(sourceConvId, {
              ...(input.forkEntryId !== undefined ? { entryId: input.forkEntryId } : {}),
              title: workerTitle, parentConversationId: admission.coordinatorConversationId,
            })
          : await ctx.host.createConversation({
              title: workerTitle, profileId: targetProfile, tags: [WORKER_TAG],
              parentConversationId: admission.coordinatorConversationId, nodeId: finalNodeId, cwd: finalCwd,
              ...(model ? { model } : {}),
            })
        createdId = created.id

        const now = Date.now()
        ctx.host.markConversationOwnership(created.id, 'helmx')
        if (sourceConvId !== undefined || effort) {
          await ctx.host.updateConversation(created.id, {
            profileId: targetProfile, tags: [WORKER_TAG], nodeId: finalNodeId, cwd: finalCwd,
            ...(model ? { model } : {}), ...(effort ? { thinkingLevel: effort } : {}),
          })
        }

        if (isolation === 'worktree') {
          const wt = (await ctx.host.invokeAction(
            WORKTREE_PLUGIN_ID,
            'acquire_worktree',
            {
              conversationId: created.id, parentConversationId: baseConvId, profileId: targetProfile,
              ...(requestedNodeId ? { requestNodeId: requestedNodeId } : {}),
              ...(requestedCwd ? { requestCwd: requestedCwd } : {}),
              ...(sourceConvId !== undefined ? { fork: true } : {}),
              hold: { holdId: `${admission.groupId}:${memberName}`, label: `Swarm group "${admission.groupTitle}" (${admission.groupId}) member @${memberName} (#${created.id})` },
            },
            signal ? { signal } : undefined,
          )) as AcquireWorktreeResult
          acquiredWorktreeId = wt.worktreeId
          finalCwd = wt.path
          finalNodeId = wt.nodeId
          await ctx.host.updateConversation(created.id, { cwd: wt.path, nodeId: wt.nodeId })
        }

        const { post } = await groups.addMemberWithBrief(
          admission.groupId,
          {
            name: memberName, conversationId: created.id, profileId: targetProfile, access, isolation,
            nodeId: finalNodeId, cwd: finalCwd, ...(acquiredWorktreeId ? { worktreeId: acquiredWorktreeId } : {}),
            ...(sourceConvId !== undefined ? { forked: true } : {}),
            lifecycle: 'active', ...(idempotencyKey ? { dispatchKey: idempotencyKey } : {}), createdAt: now,
          },
          input.prompt,
        )

        const result: DispatchWorkerResult = {
          workerConversationId: created.id, groupId: admission.groupId, name: memberName,
          ...(acquiredWorktreeId ? { worktreeId: acquiredWorktreeId } : {}), postSeq: post.seq,
        }
        admission.resolveGate(result)
        return result
      } catch (err) {
        if (createdId !== undefined) {
          reportError(`协作组 ${admission.groupId} 成员 @${memberName} (#${createdId}) 派工失败，执行回滚`, err)
          if (acquiredWorktreeId) {
            await releaseWorktreeHold(ctx, admission.groupId, memberName, acquiredWorktreeId).catch(() => {})
            await cleanupManagedWorktree(ctx, acquiredWorktreeId, { force: true }).catch(() => {})
          }
          const freshConv = readConversationOrUndefined(createdId)
          if (freshConv) await setConversationTags(ctx, freshConv, ARCHIVED_WORKER_TAG, [WORKER_TAG, COORDINATOR_TAG]).catch(() => {})
        }
        admission.rejectGate(err)
        throw err
      } finally {
        admission.releaseReservation()
      }
    })
  }

  const abortWorker = async (
    input: { groupId?: string; name?: string; workerConversationId?: number },
    conversationId: number | undefined,
  ): Promise<{ aborted: boolean; workerConversationId: number; name: string }> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    const summary = readConversationOrUndefined(workerConversationId)
    if (!summary) throw new HelmxError('not_found', `会话 #${workerConversationId} 不存在`, 404, { workerConversationId })
    if (summary.status !== 'working' && summary.status !== 'blocked') return { aborted: false, workerConversationId, name: member.name }
    await ctx.host.abortConversationGuarded(workerConversationId, { expectedOwnership: 'helmx' })
    groups.syncCoordinatorProjection(group.coordinatorConversationId)
    return { aborted: true, workerConversationId, name: member.name }
  }

  const switchWorkerModel = async (
    input: { groupId?: string; name?: string; workerConversationId?: number; model: string; effort?: string; prompt?: string },
    conversationId: number | undefined,
    idempotencyKey?: string,
  ): Promise<{ workerConversationId: number; model: string; effort?: string; name: string; postSeq?: number }> => {
    if (typeof input.model !== 'string' || !input.model.trim()) {
      throw new HelmxError('validation_error', 'model 必须是非空字符串（格式 provider/model 或 tier/<id>）', 400, {})
    }
    const effort = optNonEmptyStr(input.effort, 'effort')
    const prompt = optNonEmptyStr(input.prompt, 'prompt')

    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (group.status !== 'active') throw groupClosedError(group.id, '已结单，无法切换模型')
    if (member.lifecycle !== 'active') {
      throw swarmError('swarm_unknown_target', `成员 @${member.name} 已归档，无法切换模型`, 409, { groupId: group.id, name: member.name })
    }
    const summary = readConversationOrUndefined(workerConversationId)
    if (!summary) throw new HelmxError('not_found', `会话 #${workerConversationId} 不存在`, 404, { workerConversationId })

    const makeRes = (c: ConversationSummary, postSeq?: number) => ({
      workerConversationId: c.id, model: c.model, name: member.name,
      ...(effort !== undefined ? { effort: c.thinkingLevel } : {}),
      ...(postSeq !== undefined ? { postSeq } : {}),
    })

    if (prompt && idempotencyKey) {
      const existing = groups.getPosts(group.id).find((p) => p.idempotencyKey === idempotencyKey)
      if (existing) return makeRes(summary, existing.seq)
    }
    assertNotBusy(group.id, member, summary, `成员 @${member.name} (#${workerConversationId}) 当前仍在运行中（${summary.status}）；请先等待完成或调用 abort_worker 刹停后再切换模型`)

    const updated = await ctx.host.updateConversation(workerConversationId, { model: input.model.trim(), ...(effort ? { thinkingLevel: effort } : {}) })
    if (prompt) {
      const post = await groups.appendPost(group.id, {
        from: 'coordinator', to: [member.name], resolvedTargets: [member.name], wake: true, kind: 'brief', refs: [], body: prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })
      return makeRes(updated, post.seq)
    }
    groups.syncCoordinatorProjection(group.coordinatorConversationId)
    return makeRes(updated)
  }

  const inspectWorker = async (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    conversationId: number | undefined,
  ): Promise<InspectWorkerResult> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    if (
      conversationId !== undefined &&
      group.coordinatorConversationId !== conversationId &&
      !group.members.some((m) => m.conversationId === conversationId && m.lifecycle === 'active')
    ) {
      throw swarmError('conversation_scope_violation', `当前会话 #${conversationId} 无权检视协作组 '${group.id}' 成员`, 403, { conversationId, groupId: group.id })
    }
    const [detail, artifacts] = await Promise.all([
      ctx.host.getConversationDetail(workerConversationId, { limit: 20 }),
      ctx.host.listArtifacts(workerConversationId),
    ])
    return {
      conversationId: detail.id, groupId: group.id, name: member.name,
      ...(member.worktreeId ? { worktreeId: member.worktreeId } : {}),
      title: detail.title, profileId: detail.profileId, status: detail.status, doing: detail.doing ?? null,
      completionSeq: detail.completionSeq,
      artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size })),
      recentEntries: recentEntrySummaries(ctx.host, detail.entries),
    }
  }

  const archiveWorker = async (
    input: {
      workerConversationId?: number
      groupId?: string
      name?: string
      keepWorktree?: boolean
      force?: boolean
      allowUnverifiedUsage?: boolean
    },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ archived: true; workerConversationId: number; uncleanedWorktree?: UncleanedWorktreeInfo }> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (member.lifecycle === 'archived') {
      await ensureArchivedTag(workerConversationId)
      return { archived: true, workerConversationId }
    }
    assertNotBusy(group.id, member, readConversationOrUndefined(workerConversationId), `成员 @${member.name} (#${workerConversationId}) 当前正在运行或结算，拒绝归档（请先 abort_worker 或等待结束）`)

    return enqueueDispatch(`group:${group.id}`, async () => {
      const freshMember = groups.getGroup(group.id)?.members.find((m) => m.name === member.name)
      if (!freshMember || freshMember.lifecycle === 'archived') {
        await ensureArchivedTag(workerConversationId)
        return { archived: true, workerConversationId }
      }
      const freshSummary = readConversationOrUndefined(workerConversationId)
      assertNotBusy(group.id, freshMember, freshSummary, `成员 @${freshMember.name} (#${workerConversationId}) 已进入运行，拒绝归档`)

      let retainedEntry: RetainedWorktreeInfo | undefined
      let uncleanedWorktree: UncleanedWorktreeInfo | undefined
      const wt = await checkMemberWorktree(ctx, freshMember, signal)
      if (wt) {
        if (input.keepWorktree !== true && input.force !== true && wt.inspected.exists && (wt.isDirty || wt.unmergedCommits > 0)) {
          const branch = wt.inspected.currentBranch ?? wt.inspected.record.branch
          throw swarmError(
            'swarm_worktree_unmerged',
            `成员 @${freshMember.name} 的工作树 ${wt.worktreeId} (branch: ${branch}) 存在未提交改动(${wt.inspected.dirtyFileCount})或未合入提交(${wt.unmergedCommits})；请先合入或传 keepWorktree: true / force: true`,
            409,
            { groupId: group.id, memberName: freshMember.name, worktreeId: wt.worktreeId, branch, path: wt.inspected.record.path, dirtyCount: wt.inspected.dirtyFileCount, commitsAhead: wt.unmergedCommits },
          )
        }
        const settled = await settleMemberWorktree(ctx, group.id, wt, {
          keepWorktree: input.keepWorktree === true,
          force: input.force === true,
          allowUnverifiedUsage: input.allowUnverifiedUsage === true,
          signal,
        })
        retainedEntry = settled.retained
        uncleanedWorktree = settled.uncleaned
      }

      await groups.mutateGroup(group.id, (draft) => {
        const target = draft.members.find((m) => m.name === freshMember.name)
        const now = Date.now()
        if (target) {
          const timing = snapshotMemberTiming(readConversationOrUndefined(workerConversationId), now)
          target.lifecycle = 'archived'
          target.archivedAt = now
          if (timing.runDurationMs !== undefined) target.runDurationMs = timing.runDurationMs
          if (timing.turnCount !== undefined) target.turnCount = timing.turnCount
          target.readCursorSeq = Math.max(target.readCursorSeq, target.pendingWakeupSeq)
          delete target.lastWakeTaskSeq
          delete target.silentExitNudgeSeq
          delete target.lastWakeCompletionSeq
          delete target.inflightWakeup
          delete target.inflightNudge
          delete target.wakeupRecovery
          delete target.nudgeRecovery
        }
        if (retainedEntry) {
          draft.retainedWorktrees = [...(draft.retainedWorktrees ?? []).filter((i) => i.worktreeId !== retainedEntry.worktreeId), retainedEntry]
        }
        draft.updatedAt = now
        return { group: draft, result: undefined }
      })

      if (freshSummary) await setConversationTags(ctx, freshSummary, ARCHIVED_WORKER_TAG, [WORKER_TAG])
      await groups.afterMemberArchived(group.id)
      return {
        archived: true,
        workerConversationId,
        ...(uncleanedWorktree !== undefined ? { uncleanedWorktree } : {}),
      }
    })
  }

  return { dispatchWorker, abortWorker, switchWorkerModel, inspectWorker, archiveWorker }
}
