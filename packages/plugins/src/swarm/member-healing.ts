/**
 * builtin:swarm member self-healing, WAL disk recovery, and startup reconciliation.
 */
import { readFile } from 'node:fs/promises'
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import {
  assertCollabGroupRecord,
  assertGroupId,
  groupNotFoundError,
  isEnoent,
  isLifecycleTeardownError,
  swarmError,
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
  inspectBoardWalLines,
} from './recovery.js'
import { isIgnorableWorktreeError, releaseWorktreeHold } from './worktree-bridge.js'
import type { WakeDispatcher } from './wake-dispatcher.js'

export interface MemberHealingPorts {
  readonly ctx: HelmxPluginContext
  readonly getCoordinator: () => SwarmCoordinator
  readonly isAlive: () => boolean
  readonly getGroup: (groupId: string) => CollabGroupRecord | undefined
  readonly getPosts: (groupId: string) => readonly BoardPost[] | undefined
  readonly setPostsCache: (groupId: string, posts: BoardPost[]) => void
  readonly updateGroupMeta: (groupId: string, fn: (draft: CollabGroupRecord) => void) => Promise<void>
  readonly updateMember: (groupId: string, memberName: string, fn: (member: GroupMemberState) => void) => Promise<void>
  readonly appendPost: (groupId: string, draft: AppendPostDraft) => Promise<BoardPost>
  readonly persistMeta: (record: CollabGroupRecord) => Promise<CollabGroupRecord>
  readonly runGroupLocked: <T>(groupId: string, fn: () => Promise<T>) => Promise<T>
  readonly metaPath: (groupId: string) => string
  readonly boardPath: (groupId: string) => string
  readonly logDiagnostic: (message: string) => void
  readonly releaseManagedWorker: (conversationId: number) => void
  readonly dispatcher: WakeDispatcher
}

function clearMemberTaskFields(target: GroupMemberState, includeWakeup = false): void {
  delete target.lastWakeTaskSeq
  delete target.silentExitNudgeSeq
  delete target.lastWakeCompletionSeq
  delete target.inflightNudge
  if (includeWakeup) delete target.inflightWakeup
}

export function createMemberHealing(ports: MemberHealingPorts) {
  const { dispatcher } = ports

  const postSystemBlocker = (groupId: string, body: string, refSeq?: number): Promise<BoardPost> =>
    ports.appendPost(groupId, {
      from: 'system',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'blocker',
      refs: refSeq !== undefined ? [refSeq] : [],
      body,
    })

  const checkAndEmitQuiescenceStall = async (groupId: string, settlingConvId?: number): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const group = ports.getGroup(groupId)
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
      posts: ports.getPosts(groupId) ?? [],
      hasInflightDeliveries: dispatcher.hasInflightDeliveriesForGroup(groupId),
      coordinatorState,
      memberSnapshots,
    })
    if (!verdict.shouldEmitStall) return

    await ports.appendPost(groupId, {
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

  const readAndHealBoardPostsLocked = async (groupId: string, expectedHeadSeq: number): Promise<BoardPost[]> => {
    let rawBoard = ''
    try {
      rawBoard = await readFile(ports.boardPath(groupId), 'utf8')
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
    const wal = inspectBoardWalLines(rawBoard, groupId, expectedHeadSeq)
    if (wal.trimmed) {
      ports.logDiagnostic(`协作组 '${groupId}' 检测到未提交的 board.jsonl 尾行（${wal.trimReason}），已按 meta.headSeq=${expectedHeadSeq} 回滚截断`)
      await ports.ctx.host.atomicWriteFile(
        ports.boardPath(groupId),
        wal.posts.length > 0 ? `${wal.posts.map((p) => JSON.stringify(p)).join('\n')}\n` : '',
      )
    }
    return wal.posts
  }

  const loadGroupFromDisk = (groupId: string): Promise<{ record: CollabGroupRecord; posts: BoardPost[] | undefined }> =>
    ports.runGroupLocked(groupId, async () => {
      let rawMetaText: string
      try {
        rawMetaText = await readFile(ports.metaPath(groupId), 'utf8')
      } catch (err) {
        throw swarmError('swarm_doc_corrupt', `协作组 '${groupId}' 缺少或无法读取 meta.json：${err instanceof Error ? err.message : String(err)}`, 500, { groupId })
      }
      let parsedMeta: unknown
      try {
        parsedMeta = JSON.parse(rawMetaText)
      } catch (err) {
        throw swarmError('swarm_doc_corrupt', `协作组 '${groupId}' meta.json JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, 500, { groupId })
      }
      let record = assertCollabGroupRecord(parsedMeta)
      if (record.id !== groupId) {
        throw swarmError('swarm_doc_corrupt', `协作组目录 '${groupId}' 与 meta.json.id '${record.id}' 不一致`, 500, { groupId })
      }

      let posts: BoardPost[] | undefined
      if (record.status === 'active') {
        posts = await readAndHealBoardPostsLocked(groupId, record.headSeq)
        if (!record.coordinatorDetached && !ports.getCoordinator().readConversationOrUndefined(record.coordinatorConversationId)) {
          record = await ports.persistMeta({ ...record, coordinatorDetached: true, updatedAt: Date.now() })
        }
      }
      return { record, posts }
    })

  const ensurePostsLoaded = async (groupId: string): Promise<readonly BoardPost[]> => {
    const validId = assertGroupId(groupId)
    const cached = ports.getPosts(validId)
    if (cached !== undefined) return cached
    return ports.runGroupLocked(validId, async () => {
      const again = ports.getPosts(validId)
      if (again !== undefined) return again
      const current = ports.getGroup(validId)
      if (!current) throw groupNotFoundError(validId)
      const parsed = await readAndHealBoardPostsLocked(validId, current.headSeq)
      if (current.status === 'active') ports.setPostsCache(validId, parsed)
      return parsed
    })
  }

  const reconcileDeletedWorker = async (groupId: string, conversationId: number): Promise<void> => {
    ports.releaseManagedWorker(conversationId)
    const current = ports.getGroup(groupId)
    const targetMember = current?.status === 'active' ? current.members.find((m) => m.conversationId === conversationId && m.lifecycle === 'active') : undefined
    if (!targetMember) return

    if (targetMember.worktreeId) {
      try {
        await releaseWorktreeHold(ports.ctx, groupId, targetMember.name, targetMember.worktreeId)
      } catch (err) {
        if (!isIgnorableWorktreeError(err)) ports.getCoordinator().reportError(`释放已删除成员 @${targetMember.name} 的工作树持有锁失败`, err)
      }
    }

    let archivedName: string | undefined
    let prevTaskSeq: number | undefined
    await ports.updateGroupMeta(groupId, (draft) => {
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
      )
    }
  }

  const reconcileMemberRecoveryState = async (groupId: string, m: GroupMemberState): Promise<void> => {
    const summary = ports.getCoordinator().readConversationOrUndefined(m.conversationId)
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

    await ports.updateMember(groupId, m.name, (t) => {
      if (wakeStatus && t.inflightWakeup) {
        const inf = t.inflightWakeup
        if (wakeStatus === 'active' || wakeStatus === 'settled') t.readCursorSeq = Math.max(t.readCursorSeq, inf.toSeq)
        if (wakeStatus === 'active') t.lastWakeCompletionSeq = Math.max(inf.baseCompletionSeq, summary?.completionSeq ?? inf.baseCompletionSeq)
        else if ((wakeStatus === 'settled' || wakeStatus === 'uncommitted') && t.lastWakeCompletionSeq === inf.baseCompletionSeq) delete t.lastWakeCompletionSeq
        delete t.inflightWakeup
      }
      if (nudgeStatus && t.inflightNudge) {
        const inf = t.inflightNudge
        if (nudgeStatus === 'active') t.lastWakeCompletionSeq = Math.max(inf.baseCompletionSeq, summary?.completionSeq ?? inf.baseCompletionSeq)
        else if ((nudgeStatus === 'settled' || nudgeStatus === 'uncommitted') && t.lastWakeCompletionSeq === inf.baseCompletionSeq) delete t.lastWakeCompletionSeq
        if (nudgeStatus === 'uncommitted' && t.silentExitNudgeSeq === inf.taskSeq) delete t.silentExitNudgeSeq
        delete t.inflightNudge
      }
      if (clearStale) delete t.lastWakeCompletionSeq
    })
  }

  const onMemberTurnSettled = async (input: MemberTurnSettledInput): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const group = ports.getGroup(input.groupId)
    const member = group?.status === 'active' ? group.members.find((m) => m.name === input.memberName && m.lifecycle === 'active') : undefined
    if (!group || !member) return

    const flushIfReady = async (): Promise<void> => {
      const latest = ports.getGroup(input.groupId)
      if (latest?.status === 'active' && !latest.coordinatorDetached && dispatcher.canFlushCoordinator(latest, input.conversationId)) {
        await dispatcher.flushCoordinatorReport(input.groupId, input.conversationId)
      }
    }

    if (input.outcome === 'failed' || input.outcome === 'aborted') {
      const prevTaskSeq = member.lastWakeTaskSeq
      await ports.updateMember(input.groupId, input.memberName, (t) => clearMemberTaskFields(t))
      if (input.outcome === 'failed') {
        const summary = coord.readConversationOrUndefined(input.conversationId)
        const safeErr = ports.ctx.host.redact(input.error ?? summary?.lastError ?? 'unknown turn failure')
        await postSystemBlocker(
          input.groupId,
          `Member @${input.memberName} (#${input.conversationId}, model: ${summary?.model ?? 'unknown'}) turn failed: ${safeErr}`,
          prevTaskSeq,
        )
      }
      const refreshed = ports.getGroup(input.groupId)?.members.find((m) => m.name === input.memberName && m.lifecycle === 'active')
      if (refreshed && refreshed.pendingWakeupSeq > refreshed.readCursorSeq) {
        await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
        return
      }
      await flushIfReady()
      return
    }

    if (member.pendingWakeupSeq > member.readCursorSeq) {
      await dispatcher.deliverWorkerWakeup(input.groupId, input.memberName, { fromTurnSettled: true })
      return
    }

    const silentAction = evaluateSilentExit(group, member, input.lastReplySummary)
    if (silentAction.kind === 'nudge') {
      const baseCompletionSeq = coord.readConversationOrUndefined(input.conversationId)?.completionSeq ?? input.completionSeq
      const requestId = `swarm-nudge:${input.groupId}:${input.memberName}:${silentAction.taskSeq}`
      await ports.updateMember(input.groupId, input.memberName, (t) => {
        t.silentExitNudgeSeq = silentAction.taskSeq
        t.inflightNudge = { requestId, taskSeq: silentAction.taskSeq, baseCompletionSeq }
      })
      try {
        await ports.ctx.host.submitInputGuarded(
          input.conversationId,
          silentAction.prompt,
          { origin: 'agent', whenBusy: 'followUp', requestId },
          { expectedOwnership: 'helmx' },
        )
        await ports.updateMember(input.groupId, input.memberName, (t) => {
          if (t.inflightNudge?.requestId === requestId) delete t.inflightNudge
          t.lastWakeCompletionSeq = baseCompletionSeq
        })
      } catch (err) {
        await ports.updateMember(input.groupId, input.memberName, (t) => {
          if (t.inflightNudge?.requestId === requestId) delete t.inflightNudge
          if (t.silentExitNudgeSeq === silentAction.taskSeq) delete t.silentExitNudgeSeq
          if (t.lastWakeCompletionSeq === baseCompletionSeq) delete t.lastWakeCompletionSeq
        }).catch(() => {})
        if (!isLifecycleTeardownError(err)) coord.reportError(`协作组 ${input.groupId} 成员 @${input.memberName} 哑巴退场续催失败`, err)
      }
      return
    }

    if (silentAction.kind === 'fallback_blocker') {
      await ports.updateMember(input.groupId, input.memberName, (t) => clearMemberTaskFields(t))
      await postSystemBlocker(input.groupId, silentAction.body, silentAction.taskSeq)
      await flushIfReady()
      return
    }

    await flushIfReady()
    await checkAndEmitQuiescenceStall(input.groupId, input.conversationId)
  }

  const reconcileSingleRecoveredGroup = async (groupId: string): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const initialGroup = ports.getGroup(groupId)
    if (!initialGroup || initialGroup.status !== 'active') return

    if (initialGroup.inflightReport) {
      const inf = initialGroup.inflightReport
      if (initialGroup.coordinatorDetached) {
        await ports.updateGroupMeta(groupId, (d) => { delete d.inflightReport })
      } else {
        const coordSummary = coord.readConversationOrUndefined(initialGroup.coordinatorConversationId)
        const reportStatus = await classifyInflightIntent(ports.ctx.host, initialGroup.coordinatorConversationId, coordSummary, inf)
        await ports.updateGroupMeta(groupId, (d) => {
          if (d.inflightReport?.requestId !== inf.requestId) return
          if (reportStatus === 'active' || reportStatus === 'settled') {
            if (!inf.requestId.startsWith('swarm-report-idle:')) {
              d.coordinatorNotifiedSeq = Math.max(d.coordinatorNotifiedSeq, inf.toSeq)
            }
            if (inf.hadActiveWorkers) d.lastReportHadActiveWorkers = true
            else delete d.lastReportHadActiveWorkers
          }
          delete d.inflightReport
        })
        if (reportStatus === 'active') {
          dispatcher.noteCoordReportInflight(groupId, Math.max(inf.baseCompletionSeq, coordSummary?.completionSeq ?? inf.baseCompletionSeq))
        }
      }
    }

    for (const m of initialGroup.members) {
      if (m.lifecycle !== 'active') continue
      if (!ports.isAlive()) return
      await reconcileMemberRecoveryState(groupId, m)
    }

    const freshGroup = ports.getGroup(groupId)
    if (!freshGroup || freshGroup.status !== 'active') return

    for (const member of freshGroup.members) {
      if (member.lifecycle !== 'active') continue
      if (!ports.isAlive()) return
      if (member.pendingWakeupSeq > member.readCursorSeq) {
        void dispatcher.deliverWorkerWakeup(freshGroup.id, member.name)
        continue
      }
      if (member.lastWakeTaskSeq === undefined || (member.lastPostSeq ?? 0) >= member.lastWakeTaskSeq) continue
      const summary = coord.readConversationOrUndefined(member.conversationId)
      if (!summary || summary.status === 'working' || summary.status === 'blocked') continue

      let entries = [] as Awaited<ReturnType<typeof ports.ctx.host.getConversationDetail>>['entries']
      if (summary.status !== 'error') {
        try {
          entries = (await ports.ctx.host.getConversationDetail(member.conversationId, { limit: 30 })).entries
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') continue
          throw err
        }
      }
      const classified = classifyMemberDetailOutcome(entries, summary, freshGroup.id, member)
      if (classified.kind === 'pending_queue') continue

      const lastReplySummary = classified.kind === 'aborted' ? '' : await collectMemberLastReplySummary(ports.ctx.host, member.conversationId)
      await onMemberTurnSettled({
        groupId: freshGroup.id,
        memberName: member.name,
        conversationId: member.conversationId,
        completionSeq: summary.completionSeq,
        outcome: classified.kind,
        ...(classified.kind === 'failed' && classified.error !== undefined ? { error: classified.error } : {}),
        lastReplySummary,
      })
    }

    const latest = ports.getGroup(groupId)
    if (!latest || latest.status !== 'active' || latest.coordinatorDetached) return
    if (dispatcher.canFlushCoordinator(latest)) void dispatcher.scheduleCoordinatorReport(latest.id, 0)
    else if (latest.coordinatorPendingSeq <= latest.coordinatorNotifiedSeq && !dispatcher.hasInflightDeliveriesForGroup(latest.id)) {
      await checkAndEmitQuiescenceStall(latest.id)
    }
  }

  return {
    checkAndEmitQuiescenceStall,
    readAndHealBoardPostsLocked,
    loadGroupFromDisk,
    ensurePostsLoaded,
    reconcileDeletedWorker,
    reconcileSingleRecoveredGroup,
    onMemberTurnSettled,
  }
}
