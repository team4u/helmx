/**
 * closeGroup 收尾序列的行为锁定（纯内存 fake，零 git / 零全局副作用）。
 *
 * - 在途成员：默认 409 swarm_worker_busy，且不产生任何收尾写入；closing 标记在失败出口同样释放；
 * - abortRunning：只对 working / blocked 成员发起受守护中止（expectedOwnership: 'helmx'），随后照常收尾；
 * - 入队后复核到协作组已结单：直接返回已结单结果，不重复收尾；
 * - 正常收尾顺序：落 closed 终态（成员归档、closeSummary 去空白）→ 打归档标签 → 同步主控投影。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HelmxError } from '@helmx/protocol'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  WORKER_TAG,
  type CollabGroupRecord,
  type GroupMemberState,
} from '../src/swarm/contracts.js'
import { createGroupHandlers, createSwarmDispatchGuard, type SwarmDispatchGuard } from '../src/swarm/actions-group.js'

const GROUP_ID = 'grp_close_1'

interface HarnessOptions {
  /** conversationId → status；未列出的工作成员会话视为不存在。 */
  statusById?: Record<number, string>
  inflightWakeupMembers?: string[]
  settlingWorkers?: number[]
  /** 按 getGroup 调用序号（从 1 起）覆盖返回值，默认始终返回 active 协作组。 */
  getGroup?: (active: CollabGroupRecord, call: number) => CollabGroupRecord | undefined
}

interface Harness {
  group: CollabGroupRecord
  dispatchGuard: SwarmDispatchGuard
  handlers: ReturnType<typeof createGroupHandlers>
  /** 宿主 / 协调者副作用轨迹：`abort:<id>:<ownership>`、`tag:<id>:<tags>`、`mutate`、`sync:<id>`。 */
  calls: string[]
}

function makeMember(over: Partial<GroupMemberState>): GroupMemberState {
  return {
    name: 'w1',
    conversationId: 11,
    profileId: 'assistant',
    access: 'readwrite',
    isolation: 'inherit',
    nodeId: 'local',
    cwd: '/repo',
    lifecycle: 'active',
    readCursorSeq: 0,
    pendingWakeupSeq: 0,
    createdAt: 1_000,
    ...over,
  }
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const group: CollabGroupRecord = {
    id: GROUP_ID,
    title: 'Close Group Squad',
    coordinatorConversationId: 1,
    status: 'active',
    members: [makeMember({ name: 'w1' }), makeMember({ name: 'w2', conversationId: 12 }), makeMember({ name: 'w3', conversationId: 13, access: 'readonly' })],
    headSeq: 0,
    coordinatorNotifiedSeq: 0,
    coordinatorPendingSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  const convs = new Map<number, Record<string, unknown>>([[1, { id: 1, tags: [COORDINATOR_TAG], status: 'idle' }]])
  for (const id of [11, 12, 13]) {
    const status = options.statusById?.[id]
    if (status !== undefined) convs.set(id, { id, tags: [WORKER_TAG], status })
  }
  const calls: string[] = []
  let getGroupCalls = 0
  const inflight = new Set(options.inflightWakeupMembers ?? [])
  const fakeCtx = {
    host: {
      updateConversation: async (id: number, patch: Record<string, unknown>) => {
        const next = { ...(convs.get(id) ?? { id }), ...patch }
        convs.set(id, next)
        calls.push(`tag:${id}:${JSON.stringify(patch['tags'])}`)
        return next
      },
      abortConversationGuarded: async (id: number, opts: { expectedOwnership: string }) => {
        calls.push(`abort:${id}:${opts.expectedOwnership}`)
      },
      invokeAction: async (_pluginId: string, actionId: string) => {
        calls.push(`action:${actionId}`)
        return {}
      },
    },
  } as never
  const fakeCoordinator = {
    getConfig: () => ({ maxWorkersPerGroup: 8, boardPreviewLimit: 60, maxPeerHopsWithoutCoordinator: 4 }),
    readConversationOrUndefined: (id: number) => convs.get(id),
    settlingWorkers: new Set(options.settlingWorkers ?? []),
    reportError: () => {},
    enqueueDispatch: async <T>(_key: string, fn: () => Promise<T>) => fn(),
    track: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    groups: {
      getGroup: (id: string) => {
        if (id !== group.id) return undefined
        getGroupCalls += 1
        return options.getGroup ? options.getGroup(group, getGroupCalls) : group
      },
      listGroups: () => [group],
      findActiveGroupByCoordinator: () => undefined,
      findLatestGroupForConversation: () => undefined,
      hasInflightWakeup: (_groupId: string, name: string) => inflight.has(name),
      mutateGroup: async <T>(_id: string, fn: (draft: CollabGroupRecord, posts: never[]) => { group: CollabGroupRecord; result: T }) => {
        calls.push('mutate')
        return fn(group, []).result
      },
      afterMemberArchived: async () => {},
      syncProjections: () => {},
      syncCoordinatorProjection: (coordinatorConversationId: number) => {
        calls.push(`sync:${coordinatorConversationId}`)
      },
    },
  } as never
  const dispatchGuard = createSwarmDispatchGuard()
  return { group, dispatchGuard, handlers: createGroupHandlers(fakeCtx, fakeCoordinator, dispatchGuard), calls }
}

function isBusyError(err: unknown, memberName: string): boolean {
  if (!(err instanceof HelmxError) || err.code !== 'swarm_worker_busy' || err.status !== 409) return false
  const details = err.details as Record<string, unknown>
  return details['groupId'] === GROUP_ID && details['memberName'] === memberName
}

test('closeGroup：在途成员（working / 在途唤醒 / 结算中）默认 409 swarm_worker_busy，不产生任何收尾写入且释放 closing 标记', { timeout: 60_000 }, async () => {
  const working = makeHarness({ statusById: { 11: 'working', 12: 'idle' } })
  await assert.rejects(working.handlers.closeGroup({ groupId: GROUP_ID }, 1), (err: unknown) => isBusyError(err, 'w1'))
  assert.deepEqual(working.calls, [])
  assert.equal(working.group.status, 'active')
  assert.equal(working.dispatchGuard.isClosing(GROUP_ID), false)

  // 会话不存在的成员不视为在途；在途唤醒与结算中即使会话 idle 也算在途，错误指向第一个在途成员。
  const inflight = makeHarness({ statusById: { 12: 'idle' }, inflightWakeupMembers: ['w2'] })
  await assert.rejects(inflight.handlers.closeGroup({ groupId: GROUP_ID }, 1), (err: unknown) => isBusyError(err, 'w2'))
  const settling = makeHarness({ statusById: { 12: 'idle' }, settlingWorkers: [12] })
  await assert.rejects(settling.handlers.closeGroup({ groupId: GROUP_ID }, 1), (err: unknown) => isBusyError(err, 'w2'))
  assert.deepEqual(settling.calls, [])
  assert.equal(settling.dispatchGuard.isClosing(GROUP_ID), false)
})

test('closeGroup：abortRunning 只中止 working / blocked 成员（expectedOwnership: helmx），随后按序落 closed 终态、打归档标签并同步投影', { timeout: 60_000 }, async () => {
  const h = makeHarness({ statusById: { 11: 'working', 12: 'blocked', 13: 'idle' } })
  const closed = await h.handlers.closeGroup({ groupId: GROUP_ID, abortRunning: true, summary: '  收尾说明  ' }, 1)
  assert.deepEqual(closed, { closed: true, groupId: GROUP_ID, retainedWorktrees: [] })
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith('abort:')),
    ['abort:11:helmx', 'abort:12:helmx'],
  )
  assert.equal(h.group.status, 'closed')
  assert.equal(h.group.closeSummary, '收尾说明')
  assert.deepEqual(
    h.group.members.map((m) => m.lifecycle),
    ['archived', 'archived', 'archived'],
  )
  assert.equal(h.dispatchGuard.isClosing(GROUP_ID), false)

  const mutateAt = h.calls.indexOf('mutate')
  const workerTagAt = h.calls.findIndex((c) => c.startsWith('tag:11:'))
  const coordinatorTagAt = h.calls.findIndex((c) => c.startsWith('tag:1:'))
  const syncAt = h.calls.indexOf('sync:1')
  assert.ok(mutateAt >= 0 && mutateAt < workerTagAt && workerTagAt < coordinatorTagAt && coordinatorTagAt < syncAt, h.calls.join(' | '))
  assert.ok(h.calls.includes(`tag:11:${JSON.stringify([ARCHIVED_WORKER_TAG])}`))
  assert.ok(h.calls.includes(`tag:13:${JSON.stringify([ARCHIVED_WORKER_TAG])}`))
  assert.ok(h.calls.includes(`tag:1:${JSON.stringify([ARCHIVED_COORDINATOR_TAG])}`))
})

test('closeGroup：入队后复核到协作组已结单时直接返回已结单结果，不重复收尾', { timeout: 60_000 }, async () => {
  const retained = { memberName: 'w1', nodeId: 'local', worktreeId: 'local:/repo/wt-w1', branch: 'helmx/w1', path: '/repo/wt-w1', commitsAhead: 1 }
  // 第一次 getGroup（入队前解析）仍为 active；第二次（队列内复核）已被并发结单。
  const h = makeHarness({
    getGroup: (active, call) => (call === 1 ? active : { ...active, status: 'closed', closedAt: 2_000, retainedWorktrees: [retained] }),
  })
  const closed = await h.handlers.closeGroup({ groupId: GROUP_ID }, 1)
  assert.deepEqual(closed, { closed: true, groupId: GROUP_ID, retainedWorktrees: [retained] })
  assert.deepEqual(h.calls, [])
  assert.equal(h.dispatchGuard.isClosing(GROUP_ID), false)
})
