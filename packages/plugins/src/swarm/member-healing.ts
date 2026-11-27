/**
 * builtin:swarm member self-healing, turn settlement nudging, and startup recovery reconciliation.
 */
import type { HelmxPluginContext } from '@helmx/protocol'
import { errorMessageOf, isConversationNotFoundError } from '../shared-helpers.js'
import {
  MAX_UNANSWERED_RECOVERY_RETRIES,
  hasPendingDeliverableWakeup,
  isIdleCatchupExhausted,
  isLifecycleTeardownError,
  withRetryAttemptSuffix,
  type AppendPostDraft,
  type BoardPost,
  type CollabGroupRecord,
  type GroupMemberState,
  type MemberLiveState,
  type MemberTurnSettledInput,
  type SwarmCoordinator,
} from './contracts.js'
import { evaluateGroupQuiescence, evaluateSilentExit, type MemberRuntimeSnapshot } from './board-stall.js'
import {
  classifyInflightIntent,
  classifyMemberDetailOutcome,
  collectMemberLastReplySummary,
  type InflightIntentStatus,
} from './recovery.js'
import { isIgnorableWorktreeError, releaseWorktreeHold } from './worktree-bridge.js'
import type { WakeDispatcher } from './wake-dispatcher.js'

export interface MemberHealingStorePort {
  getGroup(groupId: string): CollabGroupRecord | undefined
  getPosts(groupId: string): readonly BoardPost[] | undefined
  updateGroupMeta(groupId: string, fn: (draft: CollabGroupRecord) => void): Promise<void>
  updateMember(groupId: string, memberName: string, fn: (member: GroupMemberState) => void): Promise<void>
  appendPost(groupId: string, draft: AppendPostDraft): Promise<BoardPost>
  releaseManagedWorker(conversationId: number): void
}

export interface MemberHealingPorts {
  readonly ctx: HelmxPluginContext
  readonly getCoordinator: () => SwarmCoordinator
  readonly isAlive: () => boolean
  readonly store: MemberHealingStorePort
  readonly logDiagnostic: (message: string) => void
  readonly dispatcher: WakeDispatcher
}

type UnansweredRecoveryTransition =
  | { exhausted: false; nextAttempt: number; state: { toSeq: number; nextAttempt: number } }
  | { exhausted: true; nextAttempt: number; state: { toSeq: number; nextAttempt: number; exhausted: true } }

function resolveIntentAttempt(intent: { requestId: string; attempt?: number }): number {
  if (intent.attempt !== undefined) return intent.attempt
  const match = /:r(\d+)$/.exec(intent.requestId)
  return match ? Number(match[1]) : 0
}

/** Shared retry/exhaustion transition used across wakeup, silent-exit nudge, and coordinator report recovery. */
function resolveUnansweredRecoveryTransition(
  intent: { requestId: string; attempt?: number },
  toSeq: number,
): UnansweredRecoveryTransition {
  const prevAttempt = resolveIntentAttempt(intent)
  if (prevAttempt < MAX_UNANSWERED_RECOVERY_RETRIES) {
    const nextAttempt = prevAttempt + 1
    return { exhausted: false, nextAttempt, state: { toSeq, nextAttempt } }
  }
  return { exhausted: true, nextAttempt: prevAttempt, state: { toSeq, nextAttempt: prevAttempt, exhausted: true } }
}

function applyWakeCompletionSeq(
  target: GroupMemberState,
  status: InflightIntentStatus,
  baseCompletionSeq: number,
  liveCompletionSeq: number | undefined,
): void {
  if (status === 'active') {
    target.lastWakeCompletionSeq = Math.max(baseCompletionSeq, liveCompletionSeq ?? baseCompletionSeq)
  } else if (
    (status === 'settled' || status === 'uncommitted' || status === 'unanswered') &&
    target.lastWakeCompletionSeq === baseCompletionSeq
  ) {
    delete target.lastWakeCompletionSeq
  }
}

function clearMemberTaskFields(target: GroupMemberState, includeWakeup = false): void {
  delete target.lastWakeTaskSeq
  delete target.silentExitNudgeSeq
  delete target.lastWakeCompletionSeq
  delete target.inflightNudge
  delete target.nudgeRecovery
  if (includeWakeup) {
    delete target.inflightWakeup
    delete target.wakeupRecovery
  }
}

function applyRecoveredWakeup(
  target: GroupMemberState,
  status: InflightIntentStatus,
  liveCompletionSeq: number | undefined,
  groupId: string,
  logDiagnostic: (message: string) => void,
): { fromSeq: number; toSeq: number } | undefined {
  const inf = target.inflightWakeup
  if (!inf) return undefined
  if (status === 'active' || status === 'settled') {
    target.readCursorSeq = Math.max(target.readCursorSeq, inf.toSeq)
    delete target.wakeupRecovery
  }
  applyWakeCompletionSeq(target, status, inf.baseCompletionSeq, liveCompletionSeq)

  let exhausted: { fromSeq: number; toSeq: number } | undefined
  if (status === 'unanswered') {
    const transition = resolveUnansweredRecoveryTransition(inf, inf.toSeq)
    target.wakeupRecovery = transition.state
    if (transition.exhausted) {
      exhausted = { fromSeq: inf.fromSeq, toSeq: inf.toSeq }
    } else {
      logDiagnostic(
        `协作组 '${groupId}' 成员 @${target.name} 唤醒投递 (#${inf.fromSeq}..#${inf.toSeq}) 为 unanswered，保留未读游标并排入恢复重试 #${transition.nextAttempt}`,
      )
    }
  }
  delete target.inflightWakeup
  return exhausted
}

function applyRecoveredNudge(
  target: GroupMemberState,
  status: InflightIntentStatus,
  liveCompletionSeq: number | undefined,
  groupId: string,
  logDiagnostic: (message: string) => void,
): { taskSeq: number } | undefined {
  const inf = target.inflightNudge
  if (!inf) return undefined
  if (status === 'active' || status === 'settled') {
    delete target.nudgeRecovery
  }
  applyWakeCompletionSeq(target, status, inf.baseCompletionSeq, liveCompletionSeq)
  if (status === 'uncommitted' && target.silentExitNudgeSeq === inf.taskSeq) {
    delete target.silentExitNudgeSeq
  }

  let exhausted: { taskSeq: number } | undefined
  if (status === 'unanswered') {
    const transition = resolveUnansweredRecoveryTransition(inf, inf.taskSeq)
    if (transition.exhausted) {
      clearMemberTaskFields(target)
      exhausted = { taskSeq: inf.taskSeq }
    } else {
      if (target.silentExitNudgeSeq === inf.taskSeq) delete target.silentExitNudgeSeq
      target.nudgeRecovery = transition.state
      logDiagnostic(
        `协作组 '${groupId}' 成员 @${target.name} 哑巴退场续催 (#${inf.taskSeq}) 为 unanswered，排入恢复重试 #${transition.nextAttempt}`,
      )
    }
  }
  delete target.inflightNudge
  return exhausted
}

export function createMemberHealing(ports: MemberHealingPorts) {
  const { dispatcher, store } = ports

  const postSystemBlocker = (
    groupId: string,
    body: string,
    refSeq?: number,
    opts?: { deferDelivery?: boolean },
  ): Promise<BoardPost> =>
    store.appendPost(groupId, {
      from: 'system',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'blocker',
      refs: refSeq !== undefined ? [refSeq] : [],
      body,
      ...(opts?.deferDelivery ? { deferDelivery: true } : {}),
    })

  const flushCoordinatorIfReady = async (groupId: string, settlingConvId?: number): Promise<void> => {
    const latest = store.getGroup(groupId)
    if (latest?.status === 'active' && !latest.coordinatorDetached && dispatcher.canFlushCoordinator(latest, settlingConvId)) {
      await dispatcher.flushCoordinatorReport(groupId, settlingConvId)
    }
  }

  const checkAndEmitQuiescenceStall = async (groupId: string, settlingConvId?: number): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const group = store.getGroup(groupId)
    if (!group || group.status !== 'active' || group.coordinatorDetached) return

    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    const prevCoordCompletion = dispatcher.getLastCoordReportCompletionSeq(groupId)
    const coordInFlight = prevCoordCompletion !== undefined && coordSummary !== undefined && coordSummary.completionSeq <= prevCoordCompletion
    const coordinatorState: { exists: boolean; liveState: MemberLiveState } = coordSummary
      ? { exists: true, liveState: coordInFlight ? 'working' : coordSummary.status }
      : { exists: false, liveState: 'missing' }

    const memberSnapshots: MemberRuntimeSnapshot[] = group.members
      .filter((m) => m.lifecycle === 'active')
      .map((m) => {
        const s = coord.readConversationOrUndefined(m.conversationId)
        return {
          name: m.name,
          liveState: s?.status ?? 'missing',
          completionSeq: s?.completionSeq ?? 0,
          isSettling: m.conversationId !== settlingConvId && coord.settlingWorkers.has(m.conversationId),
          ...(m.lastWakeCompletionSeq !== undefined ? { lastWakeCompletionSeq: m.lastWakeCompletionSeq } : {}),
        }
      })

    const verdict = evaluateGroupQuiescence({
      group,
      posts: store.getPosts(groupId) ?? [],
      hasInflightDeliveries: dispatcher.hasInflightDeliveriesForGroup(groupId),
      coordinatorState,
      memberSnapshots,
    })
    if (!verdict.shouldEmitStall) return

    await store.appendPost(groupId, {
      from: 'system',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'stall',
      refs: verdict.diagnosis.refSeq !== undefined ? [verdict.diagnosis.refSeq] : [],
      body: verdict.diagnosis.body,
      lastStallWatermarkAfterPost: verdict.nextWatermarkAfterPost,
    })
    await dispatcher.flushCoordinatorReport(groupId)
  }

  const reconcileDeletedWorker = async (
    groupId: string,
    conversationId: number,
    opts?: { deferDelivery?: boolean },
  ): Promise<void> => {
    store.releaseManagedWorker(conversationId)
    const current = store.getGroup(groupId)
    const targetMember =
      current?.status === 'active'
        ? current.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
        : undefined
    if (!targetMember) return

    if (targetMember.worktreeId) {
      try {
        await releaseWorktreeHold(ports.ctx, groupId, targetMember.name, targetMember.worktreeId)
      } catch (err) {
        if (!isIgnorableWorktreeError(err)) {
          ports.getCoordinator().reportError(`释放已删除成员 @${targetMember.name} 的工作树持有锁失败`, err)
        }
      }
    }

    let archivedName: string | undefined
    let prevTaskSeq: number | undefined
    await store.updateGroupMeta(groupId, (draft) => {
      if (draft.status !== 'active') return
      const target = draft.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active')
      if (!target) return
      archivedName = target.name
      prevTaskSeq = target.lastWakeTaskSeq
      target.lifecycle = 'archived'
      target.archivedAt = Date.now()
      clearMemberTaskFields(target, true)
      draft.updatedAt = Date.now()
    })
    if (archivedName) {
      await postSystemBlocker(
        groupId,
        `Member @${archivedName} (#${conversationId}) conversation was deleted while active; worktree hold released and member archived.`,
        prevTaskSeq,
        opts,
      )
    }
  }

  const reconcileMemberRecoveryState = async (groupId: string, m: GroupMemberState): Promise<void> => {
    const coord = ports.getCoordinator()
    const summary = coord.readConversationOrUndefined(m.conversationId)
    const wakeStatus = m.inflightWakeup ? await classifyInflightIntent(ports.ctx.host, m.conversationId, summary, m.inflightWakeup) : undefined
    const nudgeStatus = m.inflightNudge ? await classifyInflightIntent(ports.ctx.host, m.conversationId, summary, m.inflightNudge) : undefined
    const clearStale =
      !wakeStatus &&
      !nudgeStatus &&
      summary !== undefined &&
      summary.status !== 'working' &&
      summary.status !== 'blocked' &&
      m.pendingWakeupSeq <= m.readCursorSeq &&
      m.lastWakeCompletionSeq !== undefined &&
      summary.completionSeq <= m.lastWakeCompletionSeq &&
      (m.lastWakeTaskSeq === undefined || (m.lastPostSeq ?? 0) >= m.lastWakeTaskSeq)
    if (!wakeStatus && !nudgeStatus && !clearStale) return

    let wakeupExhausted: { fromSeq: number; toSeq: number } | undefined
    let nudgeExhausted: { taskSeq: number } | undefined

    await store.updateMember(groupId, m.name, (t) => {
      if (wakeStatus) {
        wakeupExhausted = applyRecoveredWakeup(t, wakeStatus, summary?.completionSeq, groupId, ports.logDiagnostic)
      }
      if (nudgeStatus) {
        nudgeExhausted = applyRecoveredNudge(t, nudgeStatus, summary?.completionSeq, groupId, ports.logDiagnostic)
      }
      if (clearStale) delete t.lastWakeCompletionSeq
    })

    if (wakeupExhausted) {
      const msg = `Member @${m.name} wakeup (#${wakeupExhausted.fromSeq}..#${wakeupExhausted.toSeq}) remained unanswered after recovery retry; automatic redelivery paused for coordinator intervention.`
      await postSystemBlocker(groupId, msg, wakeupExhausted.toSeq, { deferDelivery: true })
      coord.reportError(`协作组 ${groupId} 成员 @${m.name} 唤醒恢复重试耗尽`, msg)
    }
    if (nudgeExhausted) {
      const msg = `Member @${m.name} silent-exit nudge for task #${nudgeExhausted.taskSeq} remained unanswered after recovery retry; coordinator intervention required.`
      await postSystemBlocker(groupId, msg, nudgeExhausted.taskSeq, { deferDelivery: true })
      coord.reportError(`协作组 ${groupId} 成员 @${m.name} 哑巴退场续催恢复重试耗尽`, msg)
    }
  }

  const handleFailedOrAbortedMemberTurn = async (input: MemberTurnSettledInput, prevTaskSeq: number | undefined): Promise<void> => {
    const coord = ports.getCoordinator()
    await store.updateMember(input.groupId, input.memberName, (t) => clearMemberTaskFields(t))
    if (input.outcome === 'failed') {
      const summary = coord.readConversationOrUndefined(input.conversationId)
      const safeErr = ports.ctx.host.redact(input.error ?? summary?.lastError ?? 'unknown turn failure')
      await postSystemBlocker(
        input.groupId,
        `Member @${input.memberName} (#${input.conversationId}, model: ${summary?.model ?? 'unknown'}) turn failed: ${safeErr}`,
        prevTaskSeq,
      )
    }
    const refreshed = store.getGroup(input.groupId)?.members.find((m) => m.name === input.memberName && m.lifecycle === 'active')
    if (refreshed && hasPendingDeliverableWakeup(refreshed)) {
      await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
      return
    }
    await flushCoordinatorIfReady(input.groupId, input.conversationId)
  }

  const handleSilentExitNudge = async (
    input: MemberTurnSettledInput,
    member: GroupMemberState,
    taskSeq: number,
    prompt: string,
  ): Promise<void> => {
    const coord = ports.getCoordinator()
    const baseCompletionSeq = coord.readConversationOrUndefined(input.conversationId)?.completionSeq ?? input.completionSeq
    const attempt =
      member.nudgeRecovery !== undefined &&
      !member.nudgeRecovery.exhausted &&
      member.nudgeRecovery.toSeq === taskSeq
        ? member.nudgeRecovery.nextAttempt
        : 0
    const requestId = withRetryAttemptSuffix(`swarm-nudge:${input.groupId}:${input.memberName}:${taskSeq}`, attempt)
    await store.updateMember(input.groupId, input.memberName, (t) => {
      t.silentExitNudgeSeq = taskSeq
      t.inflightNudge = { requestId, taskSeq, baseCompletionSeq, ...(attempt > 0 ? { attempt } : {}) }
    })
    try {
      await ports.ctx.host.submitInputGuarded(
        input.conversationId,
        prompt,
        { origin: 'agent', whenBusy: 'followUp', requestId },
        { expectedOwnership: 'helmx' },
      )
      await store.updateMember(input.groupId, input.memberName, (t) => {
        if (t.inflightNudge?.requestId === requestId) delete t.inflightNudge
        delete t.nudgeRecovery
        t.lastWakeCompletionSeq = baseCompletionSeq
      })
    } catch (err) {
      const teardown = isLifecycleTeardownError(err)
      await store.updateMember(input.groupId, input.memberName, (t) => {
        if (!teardown && attempt > 0) {
          clearMemberTaskFields(t)
        } else {
          if (t.inflightNudge?.requestId === requestId) delete t.inflightNudge
          if (t.silentExitNudgeSeq === taskSeq) delete t.silentExitNudgeSeq
          if (t.lastWakeCompletionSeq === baseCompletionSeq) delete t.lastWakeCompletionSeq
        }
      }).catch(() => {})
      if (!teardown) {
        coord.reportError(`协作组 ${input.groupId} 成员 @${input.memberName} 哑巴退场续催失败`, err)
        if (attempt > 0) {
          const safeErr = ports.ctx.host.redact(errorMessageOf(err))
          await postSystemBlocker(
            input.groupId,
            `Member @${input.memberName} silent-exit nudge recovery retry failed for task #${taskSeq}: ${safeErr}`,
            taskSeq,
          )
          await flushCoordinatorIfReady(input.groupId, input.conversationId)
        }
      }
    }
  }

  /**
   * 结算归并"仍挂在 inflightWakeup、但提交已达终态 done"的唤醒，并等这次投递收尾（与启动恢复共用 classifyInflightIntent + applyRecoveredWakeup）。
   * Why: 唤醒投递的游标推进（dispatcher 在 submitInputGuarded 返回后才落盘）可能晚于该回合的 turn_settled；
   * 不先归并就会把刚结算的这一轮误判为"仍有待投递"，续催只在已推进的游标上空转并吞掉静默退场；
   * 不等投递收尾，0-Token 静默检查会把仍在途的这次投递当作活跃交付而漏报 [stall]。
   * 其余状态（active / unanswered / uncommitted / missing_conv）不触碰，保持既有恢复路径的行为。
   */
  const settleCompletedInflightWakeup = async (
    input: MemberTurnSettledInput,
    member: GroupMemberState,
  ): Promise<GroupMemberState> => {
    const inf = member.inflightWakeup
    if (!inf) return member
    const summary = ports.getCoordinator().readConversationOrUndefined(input.conversationId)
    const status = await classifyInflightIntent(ports.ctx.host, input.conversationId, summary, inf)
    if (status !== 'settled') return member
    await store.updateMember(input.groupId, input.memberName, (t) => {
      // 期间若已被 dispatcher 的游标推进清除、或已被更新的唤醒替换，则不归并。
      if (t.inflightWakeup?.requestId !== inf.requestId) return
      applyRecoveredWakeup(t, status, summary?.completionSeq, input.groupId, ports.logDiagnostic)
    })
    if (dispatcher.hasInflightWakeup(input.groupId, input.memberName)) {
      await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName)
    }
    return store.getGroup(input.groupId)?.members.find((m) => m.name === input.memberName && m.lifecycle === 'active') ?? member
  }

  const onMemberTurnSettled = async (input: MemberTurnSettledInput): Promise<void> => {
    if (!ports.isAlive()) return
    const group = store.getGroup(input.groupId)
    const member =
      group?.status === 'active' ? group.members.find((m) => m.name === input.memberName && m.lifecycle === 'active') : undefined
    if (!group || !member) return

    if (input.outcome === 'failed' || input.outcome === 'aborted') {
      await handleFailedOrAbortedMemberTurn(input, member.lastWakeTaskSeq)
      return
    }
    const settledMember = await settleCompletedInflightWakeup(input, member)
    if (hasPendingDeliverableWakeup(settledMember)) {
      await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
      return
    }

    const silentAction = evaluateSilentExit(group, settledMember, input.lastReplySummary)
    if (silentAction.kind === 'nudge') {
      await handleSilentExitNudge(input, settledMember, silentAction.taskSeq, silentAction.prompt)
      return
    }
    if (silentAction.kind === 'fallback_blocker') {
      await store.updateMember(input.groupId, input.memberName, (t) => clearMemberTaskFields(t))
      await postSystemBlocker(input.groupId, silentAction.body, silentAction.taskSeq)
      await flushCoordinatorIfReady(input.groupId, input.conversationId)
      return
    }

    await flushCoordinatorIfReady(input.groupId, input.conversationId)
    await checkAndEmitQuiescenceStall(input.groupId, input.conversationId)
  }

  const reconcileInflightReportState = async (group: CollabGroupRecord): Promise<void> => {
    const inf = group.inflightReport
    if (!inf) return
    if (group.coordinatorDetached) {
      await store.updateGroupMeta(group.id, (d) => {
        delete d.inflightReport
        delete d.reportRecovery
      })
      return
    }
    const coord = ports.getCoordinator()
    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    const reportStatus = await classifyInflightIntent(ports.ctx.host, group.coordinatorConversationId, coordSummary, inf)
    let reportExhausted = false
    await store.updateGroupMeta(group.id, (d) => {
      if (d.inflightReport?.requestId !== inf.requestId) return
      if (reportStatus === 'missing_conv') {
        d.coordinatorDetached = true
        d.updatedAt = Date.now()
        delete d.reportRecovery
      } else if (reportStatus === 'active' || reportStatus === 'settled') {
        if (!inf.requestId.startsWith('swarm-report-idle:')) {
          d.coordinatorNotifiedSeq = Math.max(d.coordinatorNotifiedSeq, inf.toSeq)
        }
        if (inf.hadActiveWorkers) d.lastReportHadActiveWorkers = true
        else delete d.lastReportHadActiveWorkers
        delete d.reportRecovery
      } else if (reportStatus === 'unanswered') {
        const transition = resolveUnansweredRecoveryTransition(inf, inf.toSeq)
        d.reportRecovery = transition.state
        if (transition.exhausted) {
          reportExhausted = true
        } else {
          ports.logDiagnostic(
            `协作组 '${group.id}' 主控汇总 (#${inf.fromSeq}..#${inf.toSeq}) 为 unanswered，保留未通知游标并排入恢复重试 #${transition.nextAttempt}`,
          )
        }
      }
      delete d.inflightReport
    })
    if (reportStatus === 'active') {
      dispatcher.noteCoordReportInflight(
        group.id,
        Math.max(inf.baseCompletionSeq, coordSummary?.completionSeq ?? inf.baseCompletionSeq),
      )
    } else if (reportExhausted) {
      coord.reportError(
        `协作组 ${group.id} 主控汇总恢复投递失败`,
        `主控汇总 (#${inf.fromSeq}..#${inf.toSeq}) 在恢复重试后仍为 unanswered，已暂停自动重投（board seq 未标为已通知），请手动检查协作看板`,
      )
    }
  }

  const resumePendingRecoveredMember = async (groupId: string, member: GroupMemberState): Promise<void> => {
    if (member.pendingWakeupSeq > member.readCursorSeq) {
      if (hasPendingDeliverableWakeup(member)) void dispatcher.deliverWorkerWakeup(groupId, member.name)
      return
    }
    if (member.lastWakeTaskSeq === undefined || (member.lastPostSeq ?? 0) >= member.lastWakeTaskSeq) return
    const summary = ports.getCoordinator().readConversationOrUndefined(member.conversationId)
    if (!summary || summary.status === 'working' || summary.status === 'blocked') return

    if (
      member.nudgeRecovery !== undefined &&
      !member.nudgeRecovery.exhausted &&
      member.nudgeRecovery.toSeq === member.lastWakeTaskSeq
    ) {
      const lastReplySummary = await collectMemberLastReplySummary(ports.ctx.host, member.conversationId)
      await onMemberTurnSettled({
        groupId,
        memberName: member.name,
        conversationId: member.conversationId,
        completionSeq: summary.completionSeq,
        outcome: 'completed',
        lastReplySummary,
      })
      return
    }

    let entries = [] as Awaited<ReturnType<typeof ports.ctx.host.getConversationDetail>>['entries']
    if (summary.status !== 'error') {
      try {
        entries = (await ports.ctx.host.getConversationDetail(member.conversationId, { limit: 30 })).entries
      } catch (err) {
        if (isConversationNotFoundError(err)) return
        throw err
      }
    }
    const classified = classifyMemberDetailOutcome(entries, summary, groupId, member)
    if (classified.kind === 'pending_queue') return

    const lastReplySummary =
      classified.kind === 'aborted' ? '' : await collectMemberLastReplySummary(ports.ctx.host, member.conversationId)
    await onMemberTurnSettled({
      groupId,
      memberName: member.name,
      conversationId: member.conversationId,
      completionSeq: summary.completionSeq,
      outcome: classified.kind,
      ...(classified.kind === 'failed' && classified.error !== undefined ? { error: classified.error } : {}),
      lastReplySummary,
    })
  }

  const prepareGroupRecovery = async (groupId: string): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const initialGroup = store.getGroup(groupId)
    if (!initialGroup || initialGroup.status !== 'active') return

    await reconcileInflightReportState(initialGroup)

    const latest = store.getGroup(groupId)
    if (!latest || latest.status !== 'active') return
    for (const m of [...latest.members]) {
      if (m.lifecycle !== 'active') continue
      if (!ports.isAlive()) return
      if (!coord.readConversationOrUndefined(m.conversationId)) {
        await reconcileDeletedWorker(groupId, m.conversationId, { deferDelivery: true })
      }
    }
  }

  const reconcileSingleRecoveredGroup = async (groupId: string): Promise<void> => {
    if (!ports.isAlive()) return
    const initialGroup = store.getGroup(groupId)
    if (!initialGroup || initialGroup.status !== 'active') return

    for (const m of initialGroup.members) {
      if (m.lifecycle !== 'active') continue
      if (!ports.isAlive()) return
      await reconcileMemberRecoveryState(groupId, m)
    }

    const freshGroup = store.getGroup(groupId)
    if (!freshGroup || freshGroup.status !== 'active') return

    for (const member of freshGroup.members) {
      if (member.lifecycle !== 'active') continue
      if (!ports.isAlive()) return
      await resumePendingRecoveredMember(freshGroup.id, member)
    }

    const latest = store.getGroup(groupId)
    if (!latest || latest.status !== 'active' || latest.coordinatorDetached) return
    if (dispatcher.canFlushCoordinator(latest)) {
      void dispatcher.scheduleCoordinatorReport(latest.id, 0)
    } else if (
      latest.coordinatorPendingSeq <= latest.coordinatorNotifiedSeq &&
      !isIdleCatchupExhausted(latest) &&
      !dispatcher.hasInflightDeliveriesForGroup(latest.id)
    ) {
      await checkAndEmitQuiescenceStall(latest.id)
    }
  }

  return {
    checkAndEmitQuiescenceStall,
    reconcileDeletedWorker,
    prepareGroupRecovery,
    reconcileSingleRecoveredGroup,
    onMemberTurnSettled,
  }
}
