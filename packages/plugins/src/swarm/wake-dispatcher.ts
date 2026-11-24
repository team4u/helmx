/**
 * builtin:swarm worker wakeup delivery & micro-batched coordinator report dispatcher.
 */
import type { HelmxPluginContext } from '@helmx/protocol'
import {
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  hasPendingDeliverableWakeup,
  isIdleCatchupExhausted,
  isLifecycleTeardownError,
  isPendingReportExhausted,
  withRetryAttemptSuffix,
  type BoardPost,
  type CollabGroupRecord,
  type GroupMemberState,
  type MemberLiveSnapshot,
  type SwarmCoordinator,
} from './contracts.js'
import {
  findIdleCatchupAnchorPost,
  formatCoordinatorReportEnvelope,
  formatWorkerWakeupEnvelope,
  selectPostsForCoordinatorReport,
  selectPostsForMemberWakeup,
  shouldFlushCoordinatorReport,
  synthesizeBoardView,
} from './board-router.js'

export interface WakeDispatcherPorts {
  readonly ctx: HelmxPluginContext
  readonly getCoordinator: () => SwarmCoordinator
  readonly isAlive: () => boolean
  readonly getGroup: (groupId: string) => CollabGroupRecord | undefined
  readonly getPosts: (groupId: string) => readonly BoardPost[]
  readonly updateGroupMeta: (groupId: string, fn: (draft: CollabGroupRecord) => void) => Promise<void>
  readonly updateMember: (groupId: string, memberName: string, fn: (member: GroupMemberState) => void) => Promise<void>
  readonly reportLockPath: (groupId: string) => string
  readonly wakeupLockPath: (groupId: string, memberName: string) => string
  readonly resolveMemberLive: (conversationId: number) => MemberLiveSnapshot
  readonly getBusyActiveMemberNames: (group: CollabGroupRecord, excludeConvId?: number) => Set<string>
  readonly onWakeupRecoveryFailed?: (groupId: string, memberName: string, fromSeq: number, toSeq: number, err: unknown) => Promise<void>
}

export type WakeDispatcher = ReturnType<typeof createWakeDispatcher>

export function createWakeDispatcher(ports: WakeDispatcherPorts) {
  const inflightWakeups = new Map<string, { promise: Promise<void>; requestRetry: (fromTurnSettled?: boolean) => void }>()
  const scheduledReports = new Map<string, { promise: Promise<void>; trigger: (delayMs: number, excludeConvId?: number) => void; cancel: () => void }>()
  const lastCoordReportCompletionSeq = new Map<string, number>()

  const hasInflightWakeupsForGroup = (groupId: string): boolean => {
    const prefix = `${groupId}:`
    for (const key of inflightWakeups.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  const shouldSendCoordinatorIdleCatchup = (group: CollabGroupRecord, excludeConvId?: number): boolean =>
    group.lastReportHadActiveWorkers === true &&
    !isIdleCatchupExhausted(group) &&
    ports.getBusyActiveMemberNames(group, excludeConvId).size === 0 &&
    !hasInflightWakeupsForGroup(group.id) &&
    findIdleCatchupAnchorPost(group, ports.getPosts(group.id)) !== undefined

  const canFlushCoordinator = (group: CollabGroupRecord, excludeConvId?: number): boolean =>
    (!isPendingReportExhausted(group) &&
      shouldFlushCoordinatorReport({
        group,
        posts: ports.getPosts(group.id),
        busyMemberNames: ports.getBusyActiveMemberNames(group, excludeConvId),
      })) ||
    shouldSendCoordinatorIdleCatchup(group, excludeConvId)

  const executeSingleMemberWakeup = async (groupId: string, memberName: string, fromTurnSettled: boolean): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const group = ports.getGroup(groupId)
    const member = group?.status === 'active' ? group.members.find((m) => m.name === memberName && m.lifecycle === 'active') : undefined
    if (!group || !member || !hasPendingDeliverableWakeup(member)) return

    const summary = coord.readConversationOrUndefined(member.conversationId)
    if (
      !summary ||
      summary.status === 'working' ||
      summary.status === 'blocked' ||
      (!fromTurnSettled && coord.settlingWorkers.has(member.conversationId)) ||
      (member.lastWakeCompletionSeq !== undefined && summary.completionSeq <= member.lastWakeCompletionSeq)
    ) {
      return
    }

    const fromSeq = member.readCursorSeq + 1
    const toSeq = member.pendingWakeupSeq
    const selected = selectPostsForMemberWakeup(member, ports.getPosts(groupId), fromSeq, toSeq)
    if (selected.length === 0) {
      await ports.updateMember(groupId, memberName, (t) => {
        t.readCursorSeq = Math.max(t.readCursorSeq, toSeq)
        delete t.wakeupRecovery
      })
      return
    }

    const envelope = formatWorkerWakeupEnvelope({ group, member, posts: selected, fromSeq, toSeq })
    const attempt =
      member.wakeupRecovery !== undefined && !member.wakeupRecovery.exhausted && toSeq <= member.wakeupRecovery.toSeq
        ? member.wakeupRecovery.nextAttempt
        : 0
    const requestId = withRetryAttemptSuffix(`swarm-wakeup:${groupId}:${memberName}:${fromSeq}-${toSeq}`, attempt)
    const baseCompletionSeq = summary.completionSeq

    await ports.updateMember(groupId, memberName, (t) => {
      t.inflightWakeup = { requestId, fromSeq, toSeq, baseCompletionSeq, ...(attempt > 0 ? { attempt } : {}) }
    })

    try {
      await ports.ctx.host.submitInputGuarded(
        member.conversationId,
        envelope,
        {
          origin: 'agent',
          whenBusy: 'followUp',
          requestId,
          meta: { renderer: BOARD_WAKEUP_RENDERER, groupId, workerName: memberName, fromSeq, toSeq, postCount: selected.length },
        },
        { expectedOwnership: 'helmx' },
      )
      await ports.updateMember(groupId, memberName, (t) => {
        t.readCursorSeq = Math.max(t.readCursorSeq, toSeq)
        t.lastWakeCompletionSeq = baseCompletionSeq
        delete t.inflightWakeup
        delete t.wakeupRecovery
      })
    } catch (err) {
      const teardown = isLifecycleTeardownError(err)
      await ports.updateMember(groupId, memberName, (t) => {
        if (t.inflightWakeup?.requestId === requestId) delete t.inflightWakeup
        if (t.lastWakeCompletionSeq === baseCompletionSeq) delete t.lastWakeCompletionSeq
        if (!teardown && attempt > 0) t.wakeupRecovery = { toSeq, nextAttempt: attempt, exhausted: true }
      }).catch(() => {})
      if (!teardown) {
        coord.reportError(`协作组 ${groupId} 成员 @${memberName} 唤醒投递失败`, err)
        if (attempt > 0) {
          await ports.onWakeupRecoveryFailed?.(groupId, memberName, fromSeq, toSeq, err).catch(() => {})
        }
      }
    }
  }

  const deliverWorkerWakeup = (groupId: string, memberName: string, opts?: { fromTurnSettled?: boolean }): Promise<void> => {
    if (!ports.isAlive()) return Promise.resolve()
    const coord = ports.getCoordinator()
    const lockKey = `${groupId}:${memberName}`
    const existing = inflightWakeups.get(lockKey)
    if (existing) {
      existing.requestRetry(opts?.fromTurnSettled)
      return existing.promise
    }

    let retryRequested = false
    let retryFromSettled = opts?.fromTurnSettled === true
    let entryRef!: { promise: Promise<void>; requestRetry: (fromTurnSettled?: boolean) => void }
    const promise = coord
      .track(`board-wakeup:${lockKey}`, () =>
        ports.ctx.host.withFileLock(ports.wakeupLockPath(groupId, memberName), async () => {
          let curFromSettled = retryFromSettled
          for (;;) {
            retryRequested = false
            retryFromSettled = false
            await executeSingleMemberWakeup(groupId, memberName, curFromSettled)
            if (!retryRequested || !ports.isAlive()) break
            curFromSettled = retryFromSettled
          }
        }),
      )
      .catch((err) => { if (!isLifecycleTeardownError(err)) coord.reportError(`协作组 ${groupId} 唤醒任务异常`, err) })
      .finally(() => { if (inflightWakeups.get(lockKey) === entryRef) inflightWakeups.delete(lockKey) })

    entryRef = {
      promise,
      requestRetry(fromSettled) {
        retryRequested = true
        if (fromSettled) retryFromSettled = true
      },
    }
    inflightWakeups.set(lockKey, entryRef)
    return promise
  }

  const executeCoordinatorReportFlush = async (groupId: string, excludeConvId?: number): Promise<void> => {
    if (!ports.isAlive()) return
    const coord = ports.getCoordinator()
    const group = ports.getGroup(groupId)
    if (!group || group.status !== 'active' || group.coordinatorDetached) return

    const allPosts = ports.getPosts(groupId)
    const hasPending = group.coordinatorPendingSeq > group.coordinatorNotifiedSeq
    const canFlushPending =
      hasPending &&
      !isPendingReportExhausted(group) &&
      shouldFlushCoordinatorReport({ group, posts: allPosts, busyMemberNames: ports.getBusyActiveMemberNames(group, excludeConvId) })
    const isIdleCatchup = !hasPending && shouldSendCoordinatorIdleCatchup(group, excludeConvId)
    if (!canFlushPending && !isIdleCatchup) return

    const coordSummary = coord.readConversationOrUndefined(group.coordinatorConversationId)
    if (!coordSummary) {
      await ports.updateGroupMeta(groupId, (d) => { d.coordinatorDetached = true; d.updatedAt = Date.now() })
      return
    }
    const prevCompletion = lastCoordReportCompletionSeq.get(groupId)
    if (coordSummary.status === 'working' || coordSummary.status === 'blocked' || (prevCompletion !== undefined && coordSummary.completionSeq <= prevCompletion)) {
      return
    }

    let fromSeq: number
    let toSeq: number
    let selected: BoardPost[]
    let baseRequestId: string
    if (canFlushPending) {
      fromSeq = group.coordinatorNotifiedSeq + 1
      toSeq = group.coordinatorPendingSeq
      selected = selectPostsForCoordinatorReport(allPosts, fromSeq, toSeq)
      if (selected.length === 0) {
        await ports.updateGroupMeta(groupId, (d) => {
          d.coordinatorNotifiedSeq = Math.max(d.coordinatorNotifiedSeq, toSeq)
          delete d.reportRecovery
        })
        return
      }
      baseRequestId = `swarm-report:${groupId}:${fromSeq}-${toSeq}`
    } else {
      const anchor = findIdleCatchupAnchorPost(group, allPosts)
      if (!anchor) return
      fromSeq = anchor.seq
      toSeq = group.headSeq
      selected = selectPostsForCoordinatorReport(allPosts, fromSeq, toSeq)
      if (selected.length === 0) selected = [anchor]
      baseRequestId = `swarm-report-idle:${groupId}:${group.headSeq}:${coordSummary.completionSeq}`
    }

    const attempt =
      group.reportRecovery !== undefined && !group.reportRecovery.exhausted && toSeq <= group.reportRecovery.toSeq
        ? group.reportRecovery.nextAttempt
        : 0
    const requestId = withRetryAttemptSuffix(baseRequestId, attempt)

    const { view, localizedHeadline } = synthesizeBoardView({
      group,
      posts: allPosts,
      previewLimit: coord.getConfig().boardPreviewLimit,
      resolveMemberLive: ports.resolveMemberLive,
    })
    const envelope = formatCoordinatorReportEnvelope({ group, posts: selected, fromSeq, toSeq, activeWorkingMembers: view.activeWorkingMembers })
    const baseCompletionSeq = coordSummary.completionSeq
    const hadActiveWorkers = view.activeWorkingMembers.length > 0

    await ports.updateGroupMeta(groupId, (d) => {
      d.inflightReport = { requestId, fromSeq, toSeq, baseCompletionSeq, hadActiveWorkers, ...(attempt > 0 ? { attempt } : {}) }
    })
    lastCoordReportCompletionSeq.set(groupId, baseCompletionSeq)

    try {
      await ports.ctx.host.submitInput(group.coordinatorConversationId, envelope, {
        origin: 'agent',
        whenBusy: 'followUp',
        requestId,
        meta: { renderer: BOARD_REPORT_RENDERER, groupId, fromSeq, toSeq, postCount: selected.length, headline: localizedHeadline },
      })
      await ports.updateGroupMeta(groupId, (d) => {
        if (canFlushPending) d.coordinatorNotifiedSeq = Math.max(d.coordinatorNotifiedSeq, toSeq)
        if (hadActiveWorkers) d.lastReportHadActiveWorkers = true
        else delete d.lastReportHadActiveWorkers
        delete d.inflightReport
        delete d.reportRecovery
      })
    } catch (err) {
      const teardown = isLifecycleTeardownError(err)
      if (lastCoordReportCompletionSeq.get(groupId) === baseCompletionSeq) lastCoordReportCompletionSeq.delete(groupId)
      await ports.updateGroupMeta(groupId, (d) => {
        if (d.inflightReport?.requestId === requestId) delete d.inflightReport
        if (!teardown && attempt > 0) d.reportRecovery = { toSeq, nextAttempt: attempt, exhausted: true }
      }).catch(() => {})
      if (!teardown) coord.reportError(`协作组 ${groupId} 主控汇总投递失败`, err)
    }
  }

  const scheduleCoordinatorReport = (groupId: string, delayMs: number, excludeConvId?: number): Promise<void> => {
    if (!ports.isAlive()) return Promise.resolve()
    const coord = ports.getCoordinator()
    const existing = scheduledReports.get(groupId)
    if (existing) {
      existing.trigger(delayMs, excludeConvId)
      return existing.promise
    }

    let state: 'waiting' | 'flushing' | 'cancelled' = delayMs > 0 ? 'waiting' : 'flushing'
    let timer: NodeJS.Timeout | undefined
    let resolveWait: ((mode: 'flush' | 'cancel') => void) | undefined
    let activeExclude = excludeConvId
    let pendingDelay: number | undefined
    let pendingExclude: number | undefined

    const readState = (): 'waiting' | 'flushing' | 'cancelled' => state
    const isStopped = (): boolean => readState() === 'cancelled' || !ports.isAlive()
    const wakeWaiter = (mode: 'flush' | 'cancel'): void => {
      if (timer) { clearTimeout(timer); timer = undefined }
      resolveWait?.(mode)
      resolveWait = undefined
    }
    const waitDelay = (ms: number): Promise<'flush' | 'cancel'> =>
      ms <= 0 || readState() !== 'waiting' || !ports.isAlive()
        ? Promise.resolve(isStopped() ? 'cancel' : 'flush')
        : new Promise<'flush' | 'cancel'>((resolve) => {
            resolveWait = resolve
            timer = setTimeout(() => { timer = undefined; wakeWaiter('flush') }, ms)
            timer.unref?.()
          })

    let entryRef!: { promise: Promise<void>; trigger: (d: number, e?: number) => void; cancel: () => void }
    const promise = coord
      .track(`board-report:${groupId}`, () =>
        ports.ctx.host.withFileLock(ports.reportLockPath(groupId), async () => {
          let nextDelay: number | undefined = delayMs
          while (nextDelay !== undefined) {
            if (isStopped()) return
            if (nextDelay > 0 && readState() === 'waiting' && ((await waitDelay(nextDelay)) === 'cancel' || isStopped())) return
            state = 'flushing'
            pendingDelay = undefined
            pendingExclude = undefined
            await executeCoordinatorReportFlush(groupId, activeExclude)
            if (isStopped() || pendingDelay === undefined) return
            const reqDelay = pendingDelay
            const reqExclude = pendingExclude
            pendingDelay = undefined
            pendingExclude = undefined
            const current = ports.getGroup(groupId)
            if (!current || !canFlushCoordinator(current, reqExclude)) return
            activeExclude = reqExclude
            state = reqDelay > 0 ? 'waiting' : 'flushing'
            nextDelay = reqDelay
          }
        }),
      )
      .catch((err) => { if (!isLifecycleTeardownError(err)) coord.reportError(`协作组 ${groupId} 汇总任务异常`, err) })
      .finally(() => {
        if (timer) { clearTimeout(timer); timer = undefined }
        if (scheduledReports.get(groupId) === entryRef) scheduledReports.delete(groupId)
      })

    entryRef = {
      promise,
      trigger(reqDelay, nextExclude) {
        if (readState() === 'cancelled') return
        if (readState() === 'waiting') {
          if (nextExclude !== undefined) activeExclude = nextExclude
          if (reqDelay <= 0) { state = 'flushing'; wakeWaiter('flush') }
          return
        }
        pendingDelay = pendingDelay === undefined ? reqDelay : Math.min(pendingDelay, reqDelay)
        if (nextExclude !== undefined) pendingExclude = nextExclude
      },
      cancel() {
        state = 'cancelled'
        pendingDelay = undefined
        pendingExclude = undefined
        wakeWaiter('cancel')
      },
    }
    scheduledReports.set(groupId, entryRef)
    return promise
  }

  return {
    deliverWorkerWakeup,
    scheduleCoordinatorReport,
    flushCoordinatorReport: (groupId: string, excludeConvId?: number) => scheduleCoordinatorReport(groupId, 0, excludeConvId),
    shouldSendCoordinatorIdleCatchup,
    canFlushCoordinator,
    hasInflightWakeup: (groupId: string, memberName: string) => inflightWakeups.has(`${groupId}:${memberName}`),
    hasInflightDeliveriesForGroup: (groupId: string) => scheduledReports.has(groupId) || hasInflightWakeupsForGroup(groupId),
    liveTaskLabels: () => [
      ...[...scheduledReports.keys()].map((id) => `board-report-schedule:${id}`),
      ...[...inflightWakeups.keys()].map((key) => `board-wakeup:${key}`),
    ],
    getLastCoordReportCompletionSeq: (groupId: string) => lastCoordReportCompletionSeq.get(groupId),
    noteCoordReportInflight: (groupId: string, seq: number) => void lastCoordReportCompletionSeq.set(groupId, seq),
    forgetCoordReportCompletion: (groupId: string) => void lastCoordReportCompletionSeq.delete(groupId),
    forgetGroupReportState: (groupId: string) => void lastCoordReportCompletionSeq.delete(groupId),
    resetWatermarks: () => lastCoordReportCompletionSeq.clear(),
    async drain() {
      const reports = [...scheduledReports.values()]
      for (const e of reports) e.cancel()
      await Promise.allSettled([...reports.map((e) => e.promise), ...[...inflightWakeups.values()].map((e) => e.promise)])
      scheduledReports.clear()
      inflightWakeups.clear()
      lastCoordReportCompletionSeq.clear()
    },
  }
}
