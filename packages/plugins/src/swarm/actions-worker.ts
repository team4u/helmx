import { HelmxError, assertProfileId, type HelmxPluginContext } from '@helmx/protocol'
import type { AcquireWorktreeResult } from '../contracts.js'
import {
  assertWorkerConversationId,
  assertWorkerCwd,
  assertWorkerNodeId,
  recentEntrySummaries,
} from '../entry-text.js'
import {
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  assertChannelName,
  assertGroupId,
  assertMemberName,
  unknownChannelError,
  type CollabGroupRecord,
  type GroupMemberState,
  type RetainedWorktreeInfo,
  type SwarmCoordinator,
  type WorkerAccess,
  type WorkerIsolation,
} from './contracts.js'
import {
  assertCoordinatorAuthority,
  createSwarmDispatchGuard,
  isWorkerBusy,
  resolveCoordinatorGroup,
  type DispatchWorkerResult,
  type SwarmDispatchGuard,
} from './actions-group.js'
import {
  WORKTREE_PLUGIN_ID,
  checkMemberWorktree,
  cleanupManagedWorktree,
  releaseWorktreeHold,
} from './worktree-bridge.js'

export interface DispatchInput {
  prompt: string
  groupId?: string
  name: string
  profileId?: string
  access?: WorkerAccess
  isolation?: WorkerIsolation
  forkFrom?: string
  forkEntryId?: number
  model?: string
  effort?: string
  channels?: string[]
  title?: string
  nodeId?: string
  cwd?: string
}

export interface InspectWorkerResult {
  conversationId: number
  groupId: string
  name: string
  worktreeId?: string
  title: string
  profileId: string
  status: string
  doing: string | null
  completionSeq: number
  artifacts: Array<{ id: string; name: string; size: number }>
  recentEntries: Array<{ id: string; kind: string; text: string }>
}

export function createWorkerHandlers(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
  dispatchGuard: SwarmDispatchGuard = createSwarmDispatchGuard(),
) {
  const {
    getConfig,
    readConversationOrUndefined,
    reportError,
    enqueueDispatch,
    track,
    groups,
  } = coordinator

  const resolveTargetWorker = (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    callerConversationId: number | undefined,
  ): { group: CollabGroupRecord; member: GroupMemberState; workerConversationId: number } => {
    const hasId = input.workerConversationId !== undefined
    const hasName = input.name !== undefined && input.name.trim() !== ''
    if (!hasId && !hasName) {
      throw new HelmxError('validation_error', '必须指定 workerConversationId 或成员名 name', 400, {})
    }
    if (hasName) {
      const cleanName = assertMemberName(input.name)
      let group: CollabGroupRecord | undefined
      if (input.groupId !== undefined && input.groupId.trim() !== '') {
        group = groups.getGroup(assertGroupId(input.groupId))
      } else if (callerConversationId !== undefined) {
        group = groups.findLatestGroupForConversation(callerConversationId)
      }
      if (group === undefined) {
        throw new HelmxError('swarm_group_not_found', '未找到目标协作组', 404, { pluginId: SWARM_PLUGIN_ID })
      }
      const member = group.members.find((m) => m.name === cleanName)
      if (member === undefined) {
        throw new HelmxError('swarm_unknown_target', `协作组 '${group.id}' 中不存在成员 '${cleanName}'`, 404, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
          name: cleanName,
        })
      }
      if (hasId && assertWorkerConversationId(input.workerConversationId) !== member.conversationId) {
        throw new HelmxError('validation_error', 'workerConversationId 与 name 指向不同会话', 400, {})
      }
      return { group, member, workerConversationId: member.conversationId }
    }

    const workerId = assertWorkerConversationId(input.workerConversationId)
    for (const g of groups.listGroups()) {
      if (input.groupId !== undefined && input.groupId.trim() !== '' && g.id !== assertGroupId(input.groupId)) continue
      const m = g.members.find((item) => item.conversationId === workerId)
      if (m !== undefined) {
        return { group: g, member: m, workerConversationId: workerId }
      }
    }
    throw new HelmxError('not_found', `会话 #${workerId} 不是 ${SWARM_PLUGIN_ID} 登记的协作组成员`, 404, {
      pluginId: SWARM_PLUGIN_ID,
      workerConversationId: workerId,
    })
  }

  const dispatchWorker = async (
    input: DispatchInput,
    conversationId: number | undefined,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<{ workerConversationId: number; groupId: string; name: string; worktreeId?: string; postSeq: number }> => {
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      throw new HelmxError('validation_error', 'dispatch_worker 需要 prompt（非空文本）', 400, {})
    }
    const group = resolveCoordinatorGroup(groups, input.groupId, conversationId, true)
    const memberName = assertMemberName(input.name)
    const access: WorkerAccess = input.access === undefined ? 'readwrite' : input.access
    if (access !== 'readwrite' && access !== 'readonly') {
      throw new HelmxError('validation_error', `access 非法（期望 readwrite | readonly，收到：${String(access)}）`, 400, {})
    }
    const isolation: WorkerIsolation = input.isolation === undefined ? 'inherit' : input.isolation
    if (isolation !== 'inherit' && isolation !== 'worktree') {
      throw new HelmxError('validation_error', `isolation 非法（期望 inherit | worktree，收到：${String(isolation)}）`, 400, {})
    }
    if (input.forkEntryId !== undefined && input.forkFrom === undefined) {
      throw new HelmxError('validation_error', '指定 forkEntryId 时必须同时指定 forkFrom', 400, {})
    }

    let sourceConversationId: number | undefined
    if (input.forkFrom !== undefined) {
      const fromToken = input.forkFrom.trim()
      if (fromToken === 'coordinator') {
        sourceConversationId = group.coordinatorConversationId
      } else {
        const cleanFrom = fromToken.startsWith('@') ? fromToken.slice(1) : fromToken
        const peer = group.members.find((m) => m.name === cleanFrom)
        if (peer === undefined) {
          throw new HelmxError('swarm_unknown_target', `forkFrom 目标成员 '${fromToken}' 不存在`, 404, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: group.id,
            forkFrom: fromToken,
          })
        }
        sourceConversationId = peer.conversationId
      }
    }

    const sourceSummary = sourceConversationId !== undefined ? readConversationOrUndefined(sourceConversationId) : undefined
    const coordSummary = readConversationOrUndefined(group.coordinatorConversationId)
    const defaultProfile = sourceSummary?.profileId ?? coordSummary?.profileId ?? 'assistant'
    let targetProfile = defaultProfile
    if (input.profileId !== undefined) {
      if (typeof input.profileId !== 'string') {
        throw new HelmxError('validation_error', 'profileId 必须是字符串', 400, {})
      }
      assertProfileId(input.profileId)
      targetProfile = input.profileId
    }
    const profileRecord = await ctx.host.profiles.get(targetProfile)
    if (profileRecord === undefined) {
      throw new HelmxError('validation_error', `Profile 不存在：${targetProfile}`, 400, { profileId: targetProfile })
    }
    if (profileRecord.humanSelectable === false) {
      throw new HelmxError(
        'validation_error',
        `dispatch_worker 禁止使用系统内部 Profile '${targetProfile}'`,
        400,
        { profileId: targetProfile },
      )
    }
    if (profileRecord.runtime !== undefined) {
      throw new HelmxError(
        'unsupported_runtime',
        `dispatch_worker 仅支持内建会话运行时，不支持外部运行时 Profile '${targetProfile}'（runtime=${profileRecord.runtime.kind}:${profileRecord.runtime.agent}）`,
        400,
        { profileId: targetProfile, runtime: profileRecord.runtime },
      )
    }

    const requestedNodeId = input.nodeId === undefined ? undefined : assertWorkerNodeId(input.nodeId)
    const requestedCwd = input.cwd === undefined ? undefined : assertWorkerCwd(input.cwd)
    const model = input.model !== undefined && input.model.trim() !== '' ? input.model.trim() : undefined
    const effort = input.effort !== undefined && input.effort.trim() !== '' ? input.effort.trim() : undefined

    if (input.channels !== undefined && !Array.isArray(input.channels)) {
      throw new HelmxError('validation_error', 'channels 必须是字符串数组', 400, {})
    }
    const subscribedChannels = ['main']
    for (const rawCh of input.channels ?? []) {
      const chName = assertChannelName(rawCh)
      if (chName === 'main') continue
      if (!subscribedChannels.includes(chName)) subscribedChannels.push(chName)
    }

    // Phase 1: short per-group admission critical section (reserve member name & capacity slot).
    type Admission =
      | { kind: 'cached'; result: DispatchWorkerResult }
      | { kind: 'join'; promise: Promise<DispatchWorkerResult> }
      | {
          kind: 'run'
          groupId: string
          groupTitle: string
          coordinatorConversationId: number
          resolveGate: (res: DispatchWorkerResult) => void
          rejectGate: (err: unknown) => void
          releaseReservation: () => void
        }

    const admission = await enqueueDispatch<Admission>(`group:${group.id}`, async () => {
      const freshGroup = groups.getGroup(group.id)
      if (freshGroup === undefined || freshGroup.status !== 'active' || dispatchGuard.isClosing(group.id)) {
        throw new HelmxError('swarm_group_closed', `协作组 '${group.id}' 已不可用或已结单`, 409, {
          pluginId: SWARM_PLUGIN_ID,
          groupId: group.id,
        })
      }
      const existingMember = freshGroup.members.find((m) => m.name === memberName)
      if (existingMember !== undefined) {
        if (idempotencyKey !== undefined && existingMember.dispatchKey === idempotencyKey) {
          const existingPostSeq =
            existingMember.briefPostSeq ??
            groups
              .getPosts(freshGroup.id)
              .find((p) => p.kind === 'brief' && p.to.includes(existingMember.name))?.seq ??
            existingMember.lastWakeTaskSeq ??
            freshGroup.headSeq
          return {
            kind: 'cached',
            result: {
              workerConversationId: existingMember.conversationId,
              groupId: freshGroup.id,
              name: existingMember.name,
              ...(existingMember.worktreeId !== undefined ? { worktreeId: existingMember.worktreeId } : {}),
              postSeq: existingPostSeq,
            },
          }
        }
        throw new HelmxError(
          'swarm_member_conflict',
          `协作组 '${freshGroup.id}' 中成员名 '${memberName}' 已被占用`,
          409,
          { pluginId: SWARM_PLUGIN_ID, groupId: freshGroup.id, name: memberName },
        )
      }
      if (idempotencyKey !== undefined) {
        const inflightSameKey = dispatchGuard.getPendingByKey(freshGroup.id, idempotencyKey)
        if (inflightSameKey !== undefined) {
          return { kind: 'join', promise: inflightSameKey }
        }
      }
      if (dispatchGuard.hasPendingMember(freshGroup.id, memberName)) {
        throw new HelmxError(
          'swarm_member_conflict',
          `协作组 '${freshGroup.id}' 中成员名 '${memberName}' 正在派工中`,
          409,
          { pluginId: SWARM_PLUGIN_ID, groupId: freshGroup.id, name: memberName },
        )
      }
      const activeCount = freshGroup.members.filter((m) => m.lifecycle === 'active').length
      const maxMembers = getConfig().maxWorkersPerGroup
      if (activeCount + dispatchGuard.pendingCount(freshGroup.id) >= maxMembers) {
        throw new HelmxError(
          'swarm_group_member_limit',
          `协作组 '${freshGroup.id}' 活跃成员数已达上限 ${maxMembers}`,
          409,
          { pluginId: SWARM_PLUGIN_ID, groupId: freshGroup.id, maxWorkersPerGroup: maxMembers },
        )
      }
      for (const chName of subscribedChannels) {
        if (chName === 'main') continue
        const ch = freshGroup.channels.find((c) => c.name === chName)
        if (ch === undefined) {
          throw unknownChannelError(freshGroup, chName, { kind: 'dispatch' })
        }
        if (ch.archived === true) {
          throw new HelmxError('swarm_channel_archived', `频道 '${chName}' 已归档，无法订阅`, 409, {
            pluginId: SWARM_PLUGIN_ID,
            groupId: freshGroup.id,
            channel: chName,
          })
        }
      }

      let resolveGate!: (res: DispatchWorkerResult) => void
      let rejectGate!: (err: unknown) => void
      const inflightPromise = new Promise<DispatchWorkerResult>((resolve, reject) => {
        resolveGate = resolve
        rejectGate = reject
      })
      inflightPromise.catch(() => undefined)
      const releaseReservation = dispatchGuard.reserve(
        freshGroup.id,
        memberName,
        idempotencyKey,
        inflightPromise,
      )
      return {
        kind: 'run',
        groupId: freshGroup.id,
        groupTitle: freshGroup.title,
        coordinatorConversationId: freshGroup.coordinatorConversationId,
        resolveGate,
        rejectGate,
        releaseReservation,
      }
    })

    if (admission.kind === 'cached') return admission.result
    if (admission.kind === 'join') return admission.promise

    // Phase 2 & 3: slow conversation / worktree setup runs concurrently outside
    // the group admission lock; addMemberWithBrief serializes metadata commit.
    return track(`dispatch-worker:${admission.groupId}:${memberName}`, async () => {
      let createdId: number | undefined
      let acquiredWorktreeId: string | undefined
      try {
        const resolveBaseConversationId = sourceConversationId ?? admission.coordinatorConversationId
        const isPeerFork =
          sourceConversationId !== undefined && sourceConversationId !== admission.coordinatorConversationId
        const activeCoordSummary =
          readConversationOrUndefined(admission.coordinatorConversationId) ?? coordSummary
        const coordProfileRecord =
          isPeerFork && activeCoordSummary !== undefined
            ? activeCoordSummary.profileId === targetProfile
              ? profileRecord
              : await ctx.host.profiles.get(activeCoordSummary.profileId)
            : undefined
        const coordRestricted = coordProfileRecord?.restrictToCwd === true
        const coordNodeId = activeCoordSummary?.nodeId ?? 'local'
        if (coordRestricted) {
          const activeSourceSummary =
            readConversationOrUndefined(sourceConversationId!) ?? sourceSummary
          const forkSameProfile = activeSourceSummary?.profileId === targetProfile
          const predictedNodeId =
            requestedNodeId ??
            (forkSameProfile
              ? (activeSourceSummary?.nodeId ?? profileRecord.nodeId ?? 'local')
              : (profileRecord.nodeId ?? activeSourceSummary?.nodeId ?? 'local'))
          if (predictedNodeId !== coordNodeId) {
            throw new HelmxError(
              'path_outside_workspace',
              `path_outside_workspace: resolved spawn target node '${predictedNodeId}' differs from coordinator conversation node '${coordNodeId}'; this conversation is restricted to its working directory (Profile.restrictToCwd)`,
              403,
              {
                pluginId: SWARM_PLUGIN_ID,
                coordinatorConversationId: admission.coordinatorConversationId,
                resolvedNodeId: predictedNodeId,
                coordinatorNodeId: coordNodeId,
                ...(requestedNodeId !== undefined ? { requestedNodeId } : {}),
              },
            )
          }
        }
        const resolvedTarget = await ctx.host.resolveSpawnTarget({
          parentConversationId: resolveBaseConversationId,
          profileId: targetProfile,
          ...(requestedNodeId !== undefined ? { requestNodeId: requestedNodeId } : {}),
          ...(requestedCwd !== undefined ? { requestCwd: requestedCwd } : {}),
          ...(sourceConversationId !== undefined ? { fork: true } : {}),
        })
        if (coordRestricted) {
          if (resolvedTarget.nodeId !== coordNodeId) {
            throw new HelmxError(
              'path_outside_workspace',
              `path_outside_workspace: resolved spawn target node '${resolvedTarget.nodeId}' differs from coordinator conversation node '${coordNodeId}'; this conversation is restricted to its working directory (Profile.restrictToCwd)`,
              403,
              {
                pluginId: SWARM_PLUGIN_ID,
                coordinatorConversationId: admission.coordinatorConversationId,
                resolvedNodeId: resolvedTarget.nodeId,
                coordinatorNodeId: coordNodeId,
                ...(requestedNodeId !== undefined ? { requestedNodeId } : {}),
              },
            )
          }
          if (requestedCwd !== undefined) {
            await ctx.host.resolveSpawnTarget({
              parentConversationId: admission.coordinatorConversationId,
              profileId: targetProfile,
              requestNodeId: resolvedTarget.nodeId,
              requestCwd: requestedCwd,
            })
          }
        }
        let finalNodeId = resolvedTarget.nodeId
        let finalCwd = resolvedTarget.sourceCwd
        if (finalNodeId !== 'local' && !ctx.host.nodeIpc.isOnline(finalNodeId)) {
          throw new HelmxError(
            'node_offline',
            `目标节点 '${finalNodeId}' 离线或未注册，无法派工`,
            409,
            { pluginId: SWARM_PLUGIN_ID, nodeId: finalNodeId },
          )
        }
        const workerTitle =
          input.title !== undefined && input.title.trim() !== ''
            ? input.title.trim().slice(0, 80)
            : `[${admission.groupTitle}] @${memberName}`.slice(0, 80)

        const created =
          sourceConversationId !== undefined
            ? await ctx.host.forkConversation(sourceConversationId, {
                ...(input.forkEntryId !== undefined ? { entryId: input.forkEntryId } : {}),
                title: workerTitle,
                // 无论 fork 自同伴或主控，协作组内派工父链始终扁平挂接主控会话
                parentConversationId: admission.coordinatorConversationId,
              })
            : await ctx.host.createConversation({
                title: workerTitle,
                profileId: targetProfile,
                tags: [WORKER_TAG],
                parentConversationId: admission.coordinatorConversationId,
                nodeId: finalNodeId,
                cwd: finalCwd,
                ...(model !== undefined ? { model } : {}),
              })
        createdId = created.id

        const now = Date.now()
        ctx.host.markConversationOwnership(created.id, 'helmx')
        if (sourceConversationId !== undefined || effort !== undefined) {
          await ctx.host.updateConversation(created.id, {
            profileId: targetProfile,
            tags: [WORKER_TAG],
            nodeId: finalNodeId,
            cwd: finalCwd,
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { thinkingLevel: effort } : {}),
          })
        }

        if (isolation === 'worktree') {
          const wt = (await ctx.host.invokeAction(
            WORKTREE_PLUGIN_ID,
            'acquire_worktree',
            {
              conversationId: created.id,
              parentConversationId: resolveBaseConversationId,
              profileId: targetProfile,
              ...(requestedNodeId !== undefined ? { requestNodeId: requestedNodeId } : {}),
              ...(requestedCwd !== undefined ? { requestCwd: requestedCwd } : {}),
              ...(sourceConversationId !== undefined ? { fork: true } : {}),
              hold: {
                holdId: `${admission.groupId}:${memberName}`,
                label: `Swarm group "${admission.groupTitle}" (${admission.groupId}) member @${memberName} (#${created.id})`,
              },
            },
            signal !== undefined ? { signal } : undefined,
          )) as AcquireWorktreeResult
          acquiredWorktreeId = wt.worktreeId
          finalCwd = wt.path
          finalNodeId = wt.nodeId
          await ctx.host.updateConversation(created.id, {
            cwd: wt.path,
            nodeId: wt.nodeId,
          })
        }

        const { post } = await groups.addMemberWithBrief(
          admission.groupId,
          {
            name: memberName,
            conversationId: created.id,
            profileId: targetProfile,
            access,
            isolation,
            nodeId: finalNodeId,
            cwd: finalCwd,
            ...(acquiredWorktreeId !== undefined ? { worktreeId: acquiredWorktreeId } : {}),
            channels: subscribedChannels,
            lifecycle: 'active',
            ...(idempotencyKey !== undefined ? { dispatchKey: idempotencyKey } : {}),
            createdAt: now,
          },
          input.prompt,
        )

        const result: DispatchWorkerResult = {
          workerConversationId: created.id,
          groupId: admission.groupId,
          name: memberName,
          ...(acquiredWorktreeId !== undefined ? { worktreeId: acquiredWorktreeId } : {}),
          postSeq: post.seq,
        }
        admission.resolveGate(result)
        return result
      } catch (err) {
        if (createdId !== undefined) {
          reportError(`协作组 ${admission.groupId} 成员 @${memberName} (#${createdId}) 派工失败，执行回滚`, err)
          if (acquiredWorktreeId !== undefined) {
            await releaseWorktreeHold(ctx, admission.groupId, memberName, acquiredWorktreeId).catch(() => {})
            await cleanupManagedWorktree(ctx, acquiredWorktreeId, true).catch(() => {})
          }
          const freshConv = readConversationOrUndefined(createdId)
          if (freshConv !== undefined) {
            const nextTags = [
              ...freshConv.tags.filter((t) => t !== WORKER_TAG && t !== COORDINATOR_TAG),
              ARCHIVED_WORKER_TAG,
            ]
            await ctx.host.updateConversation(createdId, { tags: nextTags }).catch(() => {})
          }
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
    if (summary === undefined) {
      throw new HelmxError('not_found', `会话 #${workerConversationId} 不存在`, 404, {
        workerConversationId,
      })
    }
    if (summary.status !== 'working' && summary.status !== 'blocked') {
      return { aborted: false, workerConversationId, name: member.name }
    }

    await ctx.host.abortConversationGuarded(workerConversationId, { expectedOwnership: 'helmx' })
    groups.syncProjections()
    return { aborted: true, workerConversationId, name: member.name }
  }

  const switchWorkerModel = async (
    input: {
      groupId?: string
      name?: string
      workerConversationId?: number
      model: string
      effort?: string
      prompt?: string
    },
    conversationId: number | undefined,
    idempotencyKey?: string,
  ): Promise<{ workerConversationId: number; model: string; effort?: string; name: string; postSeq?: number }> => {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      throw new HelmxError('validation_error', 'model 必须是非空字符串（格式 provider/model 或 tier/<id>）', 400, {})
    }
    const effort =
      input.effort !== undefined
        ? typeof input.effort === 'string' && input.effort.trim() !== ''
          ? input.effort.trim()
          : (() => {
              throw new HelmxError('validation_error', 'effort 必须是非空字符串', 400, {})
            })()
        : undefined
    const prompt =
      input.prompt !== undefined
        ? typeof input.prompt === 'string' && input.prompt.trim() !== ''
          ? input.prompt.trim()
          : (() => {
              throw new HelmxError('validation_error', 'prompt 必须是非空文本', 400, {})
            })()
        : undefined

    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (group.status !== 'active') {
      throw new HelmxError('swarm_group_closed', `协作组 '${group.id}' 已结单，无法切换模型`, 409, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
      })
    }
    if (member.lifecycle !== 'active') {
      throw new HelmxError('swarm_unknown_target', `成员 @${member.name} 已归档，无法切换模型`, 409, {
        pluginId: SWARM_PLUGIN_ID,
        groupId: group.id,
        name: member.name,
      })
    }

    const summary = readConversationOrUndefined(workerConversationId)
    if (summary === undefined) {
      throw new HelmxError('not_found', `会话 #${workerConversationId} 不存在`, 404, {
        workerConversationId,
      })
    }

    // Idempotent replay when prompt was already posted by the same tool call.
    if (prompt !== undefined && idempotencyKey !== undefined) {
      const existingPost = groups.getPosts(group.id).find((p) => p.idempotencyKey === idempotencyKey)
      if (existingPost !== undefined) {
        return {
          workerConversationId: summary.id,
          model: summary.model,
          ...(effort !== undefined ? { effort: summary.thinkingLevel } : {}),
          name: member.name,
          postSeq: existingPost.seq,
        }
      }
    }

    if (isWorkerBusy(coordinator, workerConversationId, summary.status, group.id, member.name)) {
      throw new HelmxError(
        'swarm_worker_busy',
        `成员 @${member.name} (#${workerConversationId}) 当前仍在运行中（${summary.status}）；请先等待完成或调用 abort_worker 刹停后再切换模型`,
        409,
        { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: member.name, status: summary.status },
      )
    }

    const updated = await ctx.host.updateConversation(workerConversationId, {
      model: input.model.trim(),
      ...(effort !== undefined ? { thinkingLevel: effort } : {}),
    })

    if (prompt !== undefined) {
      const post = await groups.appendPost(group.id, {
        channel: 'main',
        from: 'coordinator',
        to: [member.name],
        resolvedTargets: [member.name],
        wake: true,
        kind: 'brief',
        refs: [],
        body: prompt,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
      return {
        workerConversationId: updated.id,
        model: updated.model,
        ...(effort !== undefined ? { effort: updated.thinkingLevel } : {}),
        name: member.name,
        postSeq: post.seq,
      }
    }

    groups.syncProjections()
    return {
      workerConversationId: updated.id,
      model: updated.model,
      ...(effort !== undefined ? { effort: updated.thinkingLevel } : {}),
      name: member.name,
    }
  }

  const inspectWorker = async (
    input: { workerConversationId?: number; groupId?: string; name?: string },
    conversationId: number | undefined,
  ): Promise<InspectWorkerResult> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    if (conversationId !== undefined) {
      const isParticipant =
        group.coordinatorConversationId === conversationId ||
        group.members.some((m) => m.conversationId === conversationId && m.lifecycle === 'active')
      if (!isParticipant) {
        throw new HelmxError(
          'conversation_scope_violation',
          `当前会话 #${conversationId} 无权检视协作组 '${group.id}' 成员`,
          403,
          { pluginId: SWARM_PLUGIN_ID, conversationId, groupId: group.id },
        )
      }
    }

    const detail = await ctx.host.getConversationDetail(workerConversationId, { limit: 20 })
    const artifacts = await ctx.host.listArtifacts(workerConversationId)
    const summaries = recentEntrySummaries(ctx.host, detail.entries)
    return {
      conversationId: detail.id,
      groupId: group.id,
      name: member.name,
      ...(member.worktreeId !== undefined ? { worktreeId: member.worktreeId } : {}),
      title: detail.title,
      profileId: detail.profileId,
      status: detail.status,
      doing: detail.doing ?? null,
      completionSeq: detail.completionSeq,
      artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size })),
      recentEntries: summaries,
    }
  }

  const archiveWorker = async (
    input: {
      workerConversationId?: number
      groupId?: string
      name?: string
      keepWorktree?: boolean
      force?: boolean
    },
    conversationId: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ archived: true; workerConversationId: number }> => {
    const { group, member, workerConversationId } = resolveTargetWorker(input, conversationId)
    assertCoordinatorAuthority(conversationId, group)
    if (member.lifecycle === 'archived') {
      const cur = readConversationOrUndefined(workerConversationId)
      if (cur !== undefined && cur.tags.includes(WORKER_TAG)) {
        const nextTags = [...cur.tags.filter((t) => t !== WORKER_TAG), ARCHIVED_WORKER_TAG]
        await ctx.host.updateConversation(workerConversationId, { tags: nextTags })
      }
      return { archived: true, workerConversationId }
    }
    const summary = readConversationOrUndefined(workerConversationId)
    if (summary !== undefined && isWorkerBusy(coordinator, workerConversationId, summary.status, group.id, member.name)) {
      throw new HelmxError(
        'swarm_worker_busy',
        `成员 @${member.name} (#${workerConversationId}) 当前正在运行或结算，拒绝归档（请先 abort_worker 或等待结束）`,
        409,
        { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: member.name, status: summary.status },
      )
    }

    return enqueueDispatch(`group:${group.id}`, async () => {
      const freshGroup = groups.getGroup(group.id)
      const freshMember = freshGroup?.members.find((m) => m.name === member.name)
      if (freshMember === undefined || freshMember.lifecycle === 'archived') {
        const cur = readConversationOrUndefined(workerConversationId)
        if (cur !== undefined && cur.tags.includes(WORKER_TAG)) {
          const nextTags = [
            ...cur.tags.filter((t) => t !== WORKER_TAG && t !== ARCHIVED_WORKER_TAG),
            ARCHIVED_WORKER_TAG,
          ]
          await ctx.host.updateConversation(workerConversationId, { tags: nextTags })
        }
        return { archived: true, workerConversationId }
      }
      const freshSummary = readConversationOrUndefined(workerConversationId)
      if (freshSummary !== undefined && isWorkerBusy(coordinator, workerConversationId, freshSummary.status, group.id, freshMember.name)) {
        throw new HelmxError(
          'swarm_worker_busy',
          `成员 @${freshMember.name} (#${workerConversationId}) 已进入运行，拒绝归档`,
          409,
          { pluginId: SWARM_PLUGIN_ID, workerConversationId, name: freshMember.name, status: freshSummary.status },
        )
      }

      let retainedEntry: RetainedWorktreeInfo | undefined
      const wtCheck = await checkMemberWorktree(ctx, freshMember, signal)
      if (wtCheck !== undefined) {
        if (input.keepWorktree === true) {
          await releaseWorktreeHold(ctx, group.id, freshMember.name, wtCheck.worktreeId, signal)
          if (wtCheck.inspected.exists && (wtCheck.isDirty || wtCheck.unmergedCommits > 0)) {
            retainedEntry = {
              memberName: freshMember.name,
              nodeId: freshMember.nodeId,
              worktreeId: wtCheck.worktreeId,
              branch: wtCheck.inspected.currentBranch ?? wtCheck.inspected.record.branch,
              path: wtCheck.inspected.record.path,
              commitsAhead: wtCheck.unmergedCommits,
            }
          }
        } else {
          if (input.force !== true && wtCheck.inspected.exists && (wtCheck.isDirty || wtCheck.unmergedCommits > 0)) {
            throw new HelmxError(
              'swarm_worktree_unmerged',
              `成员 @${freshMember.name} 的工作树 ${wtCheck.worktreeId} (branch: ${wtCheck.inspected.currentBranch ?? wtCheck.inspected.record.branch}) 存在未提交改动(${wtCheck.inspected.dirtyFileCount})或未合入提交(${wtCheck.unmergedCommits})；请先合入或传 keepWorktree: true / force: true`,
              409,
              {
                pluginId: SWARM_PLUGIN_ID,
                groupId: group.id,
                memberName: freshMember.name,
                worktreeId: wtCheck.worktreeId,
                branch: wtCheck.inspected.currentBranch ?? wtCheck.inspected.record.branch,
                path: wtCheck.inspected.record.path,
                dirtyCount: wtCheck.inspected.dirtyFileCount,
                commitsAhead: wtCheck.unmergedCommits,
              },
            )
          }
          await releaseWorktreeHold(ctx, group.id, freshMember.name, wtCheck.worktreeId, signal)
          if (wtCheck.inspected.exists) {
            await cleanupManagedWorktree(ctx, wtCheck.worktreeId, input.force === true, signal)
          }
        }
      }

      await groups.mutateGroup(group.id, (draft) => {
        const target = draft.members.find((m) => m.name === freshMember.name)
        if (target !== undefined) {
          target.lifecycle = 'archived'
          target.archivedAt = Date.now()
          target.readCursorSeq = Math.max(target.readCursorSeq, target.pendingWakeupSeq)
          delete target.lastWakeTaskSeq
          delete target.silentExitNudgeSeq
          delete target.lastWakeCompletionSeq
          delete target.inflightWakeup
          delete target.inflightNudge
        }
        if (retainedEntry !== undefined) {
          const existing = (draft.retainedWorktrees ?? []).filter((item) => item.worktreeId !== retainedEntry.worktreeId)
          draft.retainedWorktrees = [...existing, retainedEntry]
        }
        draft.updatedAt = Date.now()
        return { group: draft, result: undefined }
      })

      if (freshSummary !== undefined) {
        const nextTags = [
          ...freshSummary.tags.filter((t) => t !== WORKER_TAG && t !== ARCHIVED_WORKER_TAG),
          ARCHIVED_WORKER_TAG,
        ]
        await ctx.host.updateConversation(workerConversationId, { tags: nextTags })
      }

      await groups.afterMemberArchived(group.id)
      return { archived: true, workerConversationId }
    })
  }

  return {
    dispatchWorker,
    abortWorker,
    switchWorkerModel,
    inspectWorker,
    archiveWorker,
  }
}
