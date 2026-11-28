/**
 * 后台启动的 workflow run（notifyParentOnSettle）通知与恢复语义测试。
 *
 * 覆盖（WorkflowService 层，确定性 fake host；subagent kind 的对应语义见
 * background-subagent.test.ts，此处同时守护其不回归）：
 * - run(notifyParentOnSettle:true)：结算后 onBackgroundAgentSettled 恰一次
 *   （kind=workflow、无 agentType/execution），notifiedAt 持久化，重开 init
 *   不重复补发；
 * - 同步 run（无 notify）：绝不通知；
 * - 通知失败：不推翻终态，notifiedAt 不置位，重启 init 按 outbox 补发恰一次；
 * - 进程重启恢复（后台 workflow running 记录）：prepareRecovery 收集其 nodes
 *   子会话先落 abort 标记，init 守卫中止这些子会话、标 failed(interrupted)
 *  （保留 resumeFromRunId 提示）并补发通知恰一次；
 * - 真实启动崩溃恢复（非手工 seed）：真实 WorkflowService.run 启动后台 workflow，
 *   挂起宿主在 onResolved 回报 conversationId 后永不返回——崩溃前 running 记录
 *   已即时持久 childConversationIds（nodes 尚未落盘），第二服务读同一 state 做
 *   prepareRecovery/init 按权威 IDs 标记、守卫中止并补发通知恰一次；
 * - 同步 workflow running 记录恢复语义：同样在 prepareRecovery 与 init 阶段
 *   守卫中止遗留原生子会话以防孤儿任务空跑，但依然绝不通知父会话。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  createMemoryKvStore,
  WorkflowService,
  type RunHeader,
  type WorkflowKvStore,
  type WorkflowServiceHost,
} from '../src/workflow/runs/index.js'
import { createBackgroundReporter, type BackgroundReporterDeps } from '../src/workflow/background.js'

const timeout = { timeout: 60_000 } as const

function makeStateStore(): WorkflowKvStore<RunHeader> {
  return createMemoryKvStore<RunHeader>()
}

function readHeader(kv: WorkflowKvStore<RunHeader>, runId: string): RunHeader {
  const hit = kv.get(runId)
  assert.ok(hit !== undefined, `missing RunHeader for ${runId}`)
  return hit
}

interface SettledCall {
  summary: WorkflowRunSummary
  parentConversationId: number
  agentType?: string
  execution?: AgentExecutionInfo
}

interface NotifyHost extends WorkflowServiceHost {
  settledCalls: SettledCall[]
  guardedAborts: number[]
  /** 前 N 次 onBackgroundAgentSettled 抛错（outbox 补发演练）。 */
  notifyFailTimes: number
}

function makeHost(): NotifyHost {
  const host: NotifyHost = {
    settledCalls: [],
    guardedAborts: [],
    notifyFailTimes: 0,
    async spawnAgent() {
      return '后台节点结果'
    },
    async invokeAction() {
      throw new Error('此测试不调用动作')
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      return {
        id,
        title: `conv-${id}`,
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp',
        model: 'x/y',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }
    },
    async abortConversationGuarded(id: number) {
      host.guardedAborts.push(id)
    },
    emitEvent() {},
    async onBackgroundAgentSettled(summary, info) {
      if (host.notifyFailTimes > 0) {
        host.notifyFailTimes--
        throw new Error('simulated notify failure')
      }
      host.settledCalls.push({ summary, ...info })
    },
  }
  return host
}

const AGENT_SCRIPT =
  'export const meta = { name: "bg-notify", description: "t" }\nreturn await agent("后台任务")'

describe('后台 workflow run 通知与恢复', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-bgnotify-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('notifyParentOnSettle：结算后恰一次通知（kind=workflow、无 agentType/execution），notifiedAt 持久，重开不补发', timeout, async () => {
    const host = makeHost()
    const kv = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    assert.equal(started.status, 'running')
    assert.equal(await service.wait(started.id), '后台节点结果')

    assert.equal(host.settledCalls.length, 1, '后台 workflow 结算后应恰通知一次')
    const call = host.settledCalls[0]!
    assert.equal(call.summary.id, started.id)
    assert.equal(call.summary.kind, 'workflow')
    assert.equal(call.summary.status, 'completed')
    assert.equal(call.parentConversationId, 1)
    assert.equal(call.agentType, undefined, 'workflow kind 通知不携带 agentType')
    assert.equal(call.execution, undefined, 'workflow kind 通知不携带 execution')

    const header = readHeader(kv, started.id)
    assert.equal(header.kind, 'workflow')
    assert.equal(header.notifyParentOnSettle, true)
    assert.ok(typeof header.notifiedAt === 'number', 'notifiedAt 必须持久化')

    await service.close()
    const reopened = new WorkflowService({ dataDir, host, kv })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, '已通知的后台 workflow 不得重复补发')
    await reopened.close()
  })

  it('同步 run（无 notify）：不创建通知义务，onBackgroundAgentSettled 绝不触发', timeout, async () => {
    const host = makeHost()
    const kv = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT })
    await service.wait(started.id)
    assert.equal(service.getRun(started.id).status, 'completed')
    assert.equal(host.settledCalls.length, 0, '同步 run 不得触发父会话通知')
    const header = readHeader(kv, started.id)
    assert.equal(header.notifyParentOnSettle, undefined)
    await service.close()
    await new WorkflowService({ dataDir, host, kv }).init()
    assert.equal(host.settledCalls.length, 0)
  })

  it('通知失败不推翻终态：notifiedAt 不置位，重启 init 按 outbox 补发恰一次', timeout, async () => {
    const host = makeHost()
    host.notifyFailTimes = 1
    const kv = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    await service.wait(started.id)
    assert.equal(service.getRun(started.id).status, 'completed', '通知失败不得推翻终态')
    assert.equal(host.settledCalls.length, 0, '首次通知失败：未成功投递')
    const header = readHeader(kv, started.id)
    assert.equal(header.status, 'completed')
    assert.equal(header.notifiedAt, undefined)
    await service.close()

    const reopened = new WorkflowService({ dataDir, host, kv })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, 'init 应按 outbox 补发恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = readHeader(kv, started.id)
    assert.ok(typeof after.notifiedAt === 'number')
    await reopened.close()

    const again = new WorkflowService({ dataDir, host, kv })
    await again.init()
    assert.equal(host.settledCalls.length, 1, '已补发后不得再次投递')
    await again.close()
  })

  it('重启恢复（后台 workflow running）：prepareRecovery 标记子会话、init 守卫中止、failed(interrupted) 保留 resume 提示并补发通知', timeout, async () => {
    const host = makeHost()
    const kv = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_bgdead000001.jsonl')
    kv.set('wf_bgdead000001', {
      id: 'wf_bgdead000001',
      name: 'bg-notify',
      conversationId: 1,
      status: 'running',
      phase: 'running',
      createdAt: 1,
      updatedAt: 1,
      kind: 'workflow',
      notifyParentOnSettle: true,
      journalPath,
      nodes: [
        { id: 'agent-0', kind: 'agent', label: '后台任务', status: 'running', startedAt: 1, conversationId: 77 },
      ],
    })
    const service = new WorkflowService({ dataDir, host, kv, autoRecoverOnRestart: false })
    await service.prepareRecovery()
    assert.deepEqual(
      host.guardedAborts,
      [77],
      'prepareRecovery 必须收集后台 workflow 的 nodes 子会话并逐个守卫中止（paused 相位落持久 abort 标记）',
    )
    await service.init()
    const summary = service.getRun('wf_bgdead000001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resumeFromRunId'), '后台 workflow 中断须保留账本恢复提示')
    assert.deepEqual(host.guardedAborts, [77, 77], 'init 再次守卫中止同批子会话（调度器已恢复，等待真实终态）')
    assert.ok(summary.nodes?.every((n) => n.status === 'failed'), '中断节须如实标 failed')
    assert.equal(host.settledCalls.length, 1, '中断的后台 workflow 须补发通知恰一次')
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    const header = readHeader(kv, 'wf_bgdead000001')
    assert.ok(typeof header.notifiedAt === 'number')
    await service.close()
  })

  it('真实启动崩溃恢复：onResolved 子会话即时持久，第二服务按权威 IDs 标记/守卫中止/补发通知', timeout, async () => {
    const host = makeHost()
    const kv = makeStateStore()
    let resolveSpawned: () => void = () => {}
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve
    })
    host.spawnAgent = async (request) => {
      request.onResolved?.({ conversationId: 42 })
      resolveSpawned()
      await new Promise<never>(() => {})
    }
    const service = new WorkflowService({ dataDir, host, kv })
    const started = await service.run({ conversationId: 1, script: AGENT_SCRIPT }, { notifyParentOnSettle: true })
    assert.equal(started.status, 'running')

    let failLate: (error: Error) => void = () => {}
    const watchdog = new Promise<never>((_, reject) => {
      failLate = reject
    })
    const timer = setTimeout(() => failLate(new Error('等待 host.spawnAgent onResolved 超时')), 5_000)
    timer.unref?.()
    try {
      await Promise.race([spawned, watchdog])
    } finally {
      clearTimeout(timer)
    }

    const crashed = readHeader(kv, started.id)
    assert.equal(crashed.status, 'running')
    assert.deepEqual(crashed.childConversationIds, [42], 'onResolved 子会话必须在 running 记录中即时持久')

    // 模拟重启（autoRecoverOnRestart=false 回退路径）：第二个 WorkflowService 读同一 kv 做恢复。
    const revived = new WorkflowService({ dataDir, host, kv, autoRecoverOnRestart: false })
    await revived.prepareRecovery()
    assert.deepEqual(host.guardedAborts, [42], 'prepareRecovery 必须按持久 IDs 逐个守卫中止（落持久 abort 标记）')
    await revived.init()
    assert.deepEqual(host.guardedAborts, [42, 42], 'init 再次守卫中止同批子会话（调度器已恢复，等待真实终态）')
    const summary = revived.getRun(started.id)
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resumeFromRunId'), '中断须保留账本恢复提示')
    assert.equal(host.settledCalls.length, 1, '中断的后台 run 须补发通知恰一次')
    assert.equal(host.settledCalls[0]!.summary.id, started.id)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    const header = readHeader(kv, started.id)
    assert.ok(typeof header.notifiedAt === 'number')

    await revived.close()
    await service.close()
  })

  it('重启恢复（同步 workflow running）：同样守卫中止遗留子会话以防孤儿，但绝不通知父会话', timeout, async () => {
    const host = makeHost()
    const kv = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_syncdead0001.jsonl')
    kv.set('wf_syncdead0001', {
      id: 'wf_syncdead0001',
      kind: 'workflow',
      name: 'sync',
      conversationId: 1,
      status: 'running',
      phase: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath,
      nodes: [
        { id: 'agent-0', kind: 'agent', label: '同步任务', status: 'running', startedAt: 1, conversationId: 88 },
      ],
    })
    const service = new WorkflowService({ dataDir, host, kv, autoRecoverOnRestart: false })
    await service.prepareRecovery()
    assert.deepEqual(host.guardedAborts, [88], '同步 workflow 必须在 prepareRecovery 收集并标记子会话，防孤儿原生子会话继续运行')
    await service.init()
    const summary = service.getRun('wf_syncdead0001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('resumeFromRunId'))
    assert.deepEqual(host.guardedAborts, [88, 88], 'init 同样守卫中止同步 workflow 子会话')
    assert.ok(summary.nodes?.every((n) => n.status === 'failed'), '中断节点须如实标 failed')
    assert.equal(host.settledCalls.length, 0, '同步 workflow 中断依然绝不通知父会话')
    await service.close()
  })
})

function seedTwoChildren(kv: WorkflowKvStore<RunHeader>, runId: string): void {
  const now = Date.now()
  kv.set(runId, {
    id: runId,
    kind: 'subagent',
    name: 'subagent:worker',
    conversationId: 1,
    status: 'running',
    phase: 'running',
    createdAt: now,
    updatedAt: now,
    notifyParentOnSettle: true,
    agentType: 'worker',
    execution: { nodeId: 'local', conversationId: 31 },
    nodes: [
      { id: 'subagent-0', kind: 'agent', label: 'subagent:worker', status: 'running', startedAt: now, conversationId: 31 },
      { id: 'subagent-1', kind: 'agent', label: 'subagent:worker', status: 'running', startedAt: now, conversationId: 32 },
    ],
  })
}

it('prepareRecovery 屏障：意外错误上抛且 recoveryPrepared 不置位（重试可恢复），绝不带未落标记启动', timeout, async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'wf-barrier-io-'))
  after(() => rmSync(barrierDir, { recursive: true, force: true }))
  const kv = makeStateStore()
  seedTwoChildren(kv, 'wf_barrier_io')
  const host = makeHost()
  const realAbort = host.abortConversationGuarded.bind(host)
  let failFirst = true
  host.abortConversationGuarded = async (id: number) => {
    if (failFirst && id === 31) throw new Error('simulated persistence IO failure')
    return realAbort(id)
  }
  const service = new WorkflowService({ dataDir: barrierDir, kv, host })

  await assert.rejects(() => service.prepareRecovery(), /simulated persistence IO failure/)

  failFirst = false
  host.guardedAborts.length = 0
  await service.prepareRecovery()
  assert.deepEqual(host.guardedAborts, [31, 32], '重试必须完整覆盖全部遗留子会话（不含错误期间未落标记的半程）')
})

it('prepareRecovery 容忍边界：ownership_conflict（human 接管）与 not_found 诊断跳过，其余子会话仍落标记', timeout, async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'wf-barrier-human-'))
  after(() => rmSync(barrierDir, { recursive: true, force: true }))
  const kv = makeStateStore()
  seedTwoChildren(kv, 'wf_barrier_human')
  const host = makeHost()
  const realAbort = host.abortConversationGuarded.bind(host)
  host.abortConversationGuarded = async (id: number) => {
    host.guardedAborts.push(id)
    if (id === 31) throw new HelmxError('ownership_conflict', '会话 31 当前归属 human，拒绝自动化变更（human 红线）', 409, { conversationId: 31 })
    if (id === 32) throw new HelmxError('not_found', '会话不存在：32', 404, { conversationId: 32 })
    return realAbort(id)
  }
  const service = new WorkflowService({ dataDir: barrierDir, kv, host })
  await service.prepareRecovery()
  assert.deepEqual(host.guardedAborts, [31, 32], '两个子会话都尝试过守卫中止（human 由内核拒绝、已删会话 404），屏障不放行前先尝试')
})

// ---------------------------------------------------------------------------
// Background reports interject for every run kind and terminal status.
// ---------------------------------------------------------------------------

it('createBackgroundReporter 契约矩阵：kind × 终态（completed/failed/aborted）投递均 whenBusy=steer，requestId/meta 不变', timeout, async () => {
  interface RecordedSubmit {
    conversationId: number
    text: string
    opts: { origin: string; whenBusy: string; requestId: string; meta: Record<string, unknown> }
  }
  const submits: RecordedSubmit[] = []
  const deps: BackgroundReporterDeps = {
    getConversation: () => ({ id: 1 }),
    emitEvent: () => {},
    submitInput: async (conversationId, text, opts) => {
      submits.push({ conversationId, text, opts })
    },
    isConversationCancelling: () => false,
    listActiveRuns: () => [],
  }
  const reporter = createBackgroundReporter(deps)

  const kinds = ['subagent', 'workflow'] as const
  const statuses = ['completed', 'failed', 'aborted'] as const
  for (const kind of kinds) {
    for (const status of statuses) {
      const runId = `wf_matrix_${kind}_${status}`
      const run: WorkflowRunSummary = {
        id: runId,
        name: 'matrix',
        conversationId: 1,
        kind,
        status,
        createdAt: 1,
        updatedAt: 2,
        ...(status === 'completed' ? { result: { done: true } } : {}),
        ...(status === 'failed' ? { error: 'boom' } : {}),
        ...(status === 'aborted' ? { error: 'aborted by operator' } : {}),
      }
      await reporter.deliver(run, { parentConversationId: 1, ...(kind === 'subagent' ? { agentType: 'worker' } : {}) })
      const call = submits.at(-1)!
      assert.equal(call.opts.meta['backgroundRunId'], runId)
      assert.equal(call.opts.meta['kind'], `${kind}_report`)
      const report = JSON.parse(call.text.slice(call.text.indexOf('\n') + 1)) as { runId: string; name: string; status: string }
      assert.equal(report.runId, runId)
      assert.equal(report.name, 'matrix')
      assert.equal(report.status, status)
      assert.deepEqual(call.opts.meta['report'], report)
    }
  }

  assert.equal(submits.length, kinds.length * statuses.length, '每个 kind × 终态恰投递一次')
  for (const call of submits) {
    assert.equal(call.conversationId, 1)
    assert.equal(call.opts.origin, 'agent')
    assert.equal(call.opts.whenBusy, 'steer', `忙时策略必须 steer：${JSON.stringify(call.opts)}`)
    const kind = call.opts.meta['kind'] as string
    const expectedKindLabel = kind === 'subagent_report' ? 'subagent' : 'workflow'
    assert.equal(call.opts.requestId, `helmx:${expectedKindLabel}-report:${String(call.opts.meta['backgroundRunId'])}`)
    assert.equal(call.opts.meta['renderer'], 'workflow:background-report')
    assert.ok(call.text.includes(`"${String(call.opts.meta['backgroundRunId'])}"`), '汇报正文应携带 run 结果数据')
  }
  assert.equal(submits.filter((s) => s.opts.meta['kind'] === 'subagent_report').length, statuses.length)
  assert.equal(submits.filter((s) => s.opts.meta['kind'] === 'workflow_report').length, statuses.length)
})

it('createBackgroundReporter 忙时策略：parent working 且 runtimeModelOverride=true 时降级 followUp，其余仍 steer', timeout, async () => {
  interface RecordedSubmit {
    conversationId: number
    opts: { origin: 'agent'; whenBusy: 'steer' | 'followUp'; requestId: string; meta: Record<string, unknown> }
  }
  const cases: Array<{
    label: string
    parent: { id: number; status?: string; runtimeModelOverride?: boolean }
    expected: 'steer' | 'followUp'
  }> = [
    { label: 'working + runtimeModelOverride=true', parent: { id: 1, status: 'working', runtimeModelOverride: true }, expected: 'followUp' },
    { label: 'working + runtimeModelOverride=false', parent: { id: 1, status: 'working', runtimeModelOverride: false }, expected: 'steer' },
    { label: 'working + runtimeModelOverride omitted', parent: { id: 1, status: 'working' }, expected: 'steer' },
    { label: 'idle + runtimeModelOverride=true', parent: { id: 1, status: 'idle', runtimeModelOverride: true }, expected: 'steer' },
  ]

  for (const [idx, c] of cases.entries()) {
    const submits: RecordedSubmit[] = []
    const reporter = createBackgroundReporter({
      getConversation: () => c.parent,
      emitEvent: () => {},
      submitInput: async (conversationId, _text, opts) => {
        submits.push({ conversationId, opts })
      },
      isConversationCancelling: () => false,
      listActiveRuns: () => [],
    })
    const run: WorkflowRunSummary = {
      id: `wf_busy_policy_${idx}`,
      name: 'busy-policy',
      conversationId: 1,
      kind: 'subagent',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      result: { ok: true },
    }
    await reporter.deliver(run, { parentConversationId: 1, agentType: 'worker' })
    assert.equal(submits.length, 1, c.label)
    assert.equal(submits[0]!.opts.whenBusy, c.expected, `case ${c.label}`)
  }
})
