/**
 * startBackgroundAgent 后台单子代理生命周期测试（tsx --test，确定性 fake host）。
 *
 * 覆盖：
 * - 启动地平线与后台分离：onResolved 后立即返回 running + 真实 execution，
 *   慢任务随后完成，wait 返回结果，onBackgroundAgentSettled 恰一次并落 notifiedAt；
 * - 前置错误同步抛出：spawn 在 onResolved 前失败当场 reject 原始错误，
 *   durable 记录被后台兜底链结算为 failed（不留僵尸 running，不伪造成功）；
 * - 父信号隔离与显式 abort：onResolved 后父 signal abort 不误杀后台子代理；
 *   service.abort(runId) 经守卫端口 abortConversationGuarded 中止子会话且 run
 *   结算 aborted；
 * - gate 失败传播：spawn 因 gate_failed 抛错时 run 终态 failed（绝不提前
 *   completed），通知收到 status: 'failed' 与错误详情；
 * - 插件从不 onResolved 但 settle：execution 留空（绝不伪造），run 正常结算；
 * - 进程重启恢复：遗留 kind: 'subagent' + running 记录 init() 后标
 *   failed (interrupted) 并补发一次 onBackgroundAgentSettled；已终态但
 *   未 notifiedAt 的记录同样补发（outbox），notifiedAt 落库。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import { withWorkflowSpawnMeta, type WorkflowRunSummary } from '../src/contracts.js'
import {
  createMemoryKvStore,
  WorkflowService,
  type RunDetail,
  type RunHeader,
  type WorkflowKvStore,
  type WorkflowServiceHost,
} from '../src/workflow/runs/index.js'

const timeout = { timeout: 60_000 } as const

function readDetail(dataDir: string, runId: string): RunDetail {
  return JSON.parse(
    readFileSync(join(dataDir, 'artifacts', '1', `wf-${runId}.detail.json`), 'utf-8'),
  ) as RunDetail
}

function writeDetail(dataDir: string, detail: RunDetail, conversationId = 1): void {
  const dir = join(dataDir, 'artifacts', String(conversationId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `wf-${detail.id}.detail.json`), JSON.stringify(detail), 'utf8')
}

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

/** 可编程 spawn host：挂起/失败/gate 失败/不回 onResolved 等场景。 */
interface ProgrammableHost extends WorkflowServiceHost {
  settledCalls: SettledCall[]
  abortedConversations: number[]
  spawns: Array<Record<string, unknown>>
  /** 控制单次 spawn 行为（每次 startBackgroundAgent 前重设）。 */
  behavior:
    | { kind: 'hanging'; execution: AgentExecutionInfo; result?: unknown }
    | { kind: 'preResolveFail'; error: Error }
    | { kind: 'gateFail'; execution: AgentExecutionInfo }
    | { kind: 'noOnResolved'; result: unknown }
    | { kind: 'slowSuccess'; execution: AgentExecutionInfo; result: unknown }
  /** 手动放行挂起的 spawn。 */
  release(): void
  /** 挂起 spawn 是否已完成。 */
  settled(): boolean
}

function makeHost(options: { notifyFailTimes?: number } = {}): ProgrammableHost {
  const settledCalls: SettledCall[] = []
  const abortedConversations: number[] = []
  const spawns: Array<Record<string, unknown>> = []
  let releaseSpawn: (() => void) | undefined
  let spawnSettled = false
  let notifyFailures = options.notifyFailTimes ?? 0
  const host: ProgrammableHost = {
    settledCalls,
    abortedConversations,
    spawns,
    behavior: { kind: 'hanging', execution: { conversationId: 42 } },
    release() {
      releaseSpawn?.()
    },
    settled() {
      return spawnSettled
    },
    async spawnAgent(request) {
      spawns.push(request as unknown as Record<string, unknown>)
      const behavior = this.behavior
      if (behavior.kind === 'preResolveFail') throw behavior.error
      if (behavior.kind === 'noOnResolved') return behavior.result
      // 其余场景：先 onResolved，再挂起等待放行或被 signal 取消
      //（与真实 spawn 行为一致：abort → HelmxError('aborted') reject）。
      request.onResolved?.(behavior.execution)
      const wait = new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      const cancelled = new Promise<never>((_, reject) => {
        if (request.signal === undefined) return
        if (request.signal.aborted) {
          reject(new HelmxError('aborted', '子代理执行被取消', 409))
          return
        }
        request.signal.addEventListener(
          'abort',
          () => reject(new HelmxError('aborted', '子代理执行被取消', 409)),
          { once: true },
        )
      })
      let outcome: 'released' | 'cancelled' = 'released'
      try {
        await Promise.race([wait, cancelled])
      } catch (error) {
        spawnSettled = true
        throw error
      }
      spawnSettled = true
      void outcome
      if (behavior.kind === 'gateFail') {
        throw new HelmxError('gate_failed', 'gate 验收失败：exit 1', 422)
      }
      return behavior.result ?? 'done-result'
    },
    async invokeAction() {
      throw new HelmxError('unknown_action', '后台子代理测试不调用动作', 404)
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      if (id >= 900) {
        throw new HelmxError('not_found', `会话 ${id} 不存在`, 404)
      }
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
      abortedConversations.push(id)
    },
    emitEvent() {},
    async onBackgroundAgentSettled(summary, info) {
      if (notifyFailures > 0) {
        notifyFailures--
        throw new Error('simulated notify failure')
      }
      settledCalls.push({ summary, ...info })
    },
  }
  return host
}

describe('startBackgroundAgent', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-bgsub-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('启动地平线：onResolved 后立即返回 running 与完整 execution；慢任务随后完成并恰一次通知', timeout, async () => {
    const host = makeHost()
    host.behavior = {
      kind: 'hanging',
      execution: {
        conversationId: 42,
        effectiveCwd: '/tmp/wt',
        meta: { 'builtin:worktree': { worktree: { path: '/tmp/wt', branch: 'helmx/spawn-1' } } },
      },
      result: 'slow-task-result',
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const started = Date.now()

    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '慢任务',
      agentType: 'researcher',
    })

    // 立即返回（不等慢任务）：running + 真实 execution。
    assert.ok(Date.now() - started < 5_000, 'startBackgroundAgent 不得等待慢任务完成')
    assert.equal(run.status, 'running')
    assert.equal(run.name, '慢任务')
    assert.equal(host.spawns[0]!['title'], '慢任务')
    assert.deepEqual(execution, {
      conversationId: 42,
      effectiveCwd: '/tmp/wt',
      meta: { 'builtin:worktree': { worktree: { path: '/tmp/wt', branch: 'helmx/spawn-1' } } },
    })
    // 节点元数据已就位（getRun 实时视图）。
    const live = service.getRun(run.id)
    assert.equal(live.nodes?.[0]?.conversationId, 42)
    assert.equal(live.nodes?.[0]?.worktree?.branch, 'helmx/spawn-1')

    // 慢任务完成 → wait 返回结果，run 终态 completed。
    host.release()
    const result = await service.wait(run.id)
    assert.equal(result, 'slow-task-result')
    const final = service.getRun(run.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.nodes?.[0]?.status, 'done')

    // 通知恰一次，携带 execution 与 agentType。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.id, run.id)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    assert.equal(host.settledCalls[0]!.parentConversationId, 1)
    assert.equal(host.settledCalls[0]!.agentType, 'researcher')
    assert.equal(host.settledCalls[0]!.execution?.conversationId, 42)

    // notifiedAt 已持久化（重开服务 init 不再补发），且单子代理绝不创建空 .jsonl 幻影账本文件。
    const header = readHeader(state, run.id)
    assert.equal(header.kind, 'subagent')
    assert.ok(typeof header.notifiedAt === 'number')
    assert.equal(existsSync(join(dataDir, 'artifacts', '1', `workflow-${run.id}.jsonl`)), false, '单子代理不得打开/创建空 .jsonl 账本文件')
    await service.close()
    const reopened = new WorkflowService({ dataDir, host, kv: state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1, '已通知的记录不得重复补发')
    await reopened.close()
  })

  it('durable running 记录先于 spawn 副作用登记（启动挂起期崩溃可恢复）', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: '挂起' })
    // 仍挂起中：durable RunHeader 已是 running。
    const header = readHeader(state, run.id)
    assert.equal(header.status, 'running')
    // active 已登记：abort/close 可达。
    assert.ok(service.listRuns().some((r) => r.id === run.id && r.status === 'running'))
    host.release()
    await service.wait(run.id)
    await service.close()
  })

  it('前置错误同步抛出：spawn 在 onResolved 前失败当场 reject，不留僵尸 running', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'preResolveFail', error: new HelmxError('not_a_git_repo', '目标目录不是 Git 仓库', 400) }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })

    await assert.rejects(
      () =>
        service.startBackgroundAgent({
          parentConversationId: 1,
          prompt: '建 worktree',
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'not_a_git_repo')
        return true
      },
    )

    // 前置失败同步等待后台结算完成：记录已达 failed 终态，不留僵尸 running。
    const items = state.list().items
    assert.equal(items.length, 1)
    const runId = items[0]!.key
    const final = service.getRun(runId)
    assert.equal(final.status, 'failed')
    assert.ok(final.error?.includes('not_a_git_repo'), final.error)
    // 失败同样通知父会话（恰一次）。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    await service.close()
  })

  it('父信号隔离与显式 abort：父 signal abort 不误杀；abort(runId) 触发 abortConversation(42) 并结算 aborted', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const parentSignal = new AbortController()
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '后台任务',
      signal: parentSignal.signal,
    })

    // onResolved 已触发：父 signal abort 不得传播到后台。
    parentSignal.abort()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(service.getRun(run.id).status, 'running', '父 signal abort 不得误杀后台子代理')
    assert.deepEqual(host.abortedConversations, [])

    // 显式 abort：先经 host.abortConversation 中止子会话，run 结算 aborted。
    const abortPromise = service.abort(run.id)
    // abort 会先触发 signal → abortConversation(42)，再等 spawn reject('aborted')。
    host.release()
    await abortPromise
    assert.deepEqual(host.abortedConversations, [42])
    const final = service.getRun(run.id)
    assert.equal(final.status, 'aborted')
    // 中止同样通知（恰一次）。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await service.close()
  })

  it('启动期（onResolved 前）父 signal 取消传播：当场 aborted 拒绝且 run 不悬挂', timeout, async () => {
    const host = makeHost()
    // 专用行为：onResolved 延迟（留出启动期取消窗口）；signal abort 即取消。
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    let capturedSignal: AbortSignal | undefined
    let releaseSpawn: (() => void) | undefined
    let capturedResolve: (() => void) | undefined
    const spawnEntered = new Promise<void>((resolve) => {
      capturedResolve = resolve
    })
    ;(host as unknown as { spawnAgent: unknown }).spawnAgent = async (request: {
      onResolved?: (info: AgentExecutionInfo) => void
      signal?: AbortSignal
    }) => {
      capturedSignal = request.signal
      capturedResolve?.()
      const cancelled = new Promise<never>((_, reject) => {
        if (request.signal === undefined) return
        request.signal.addEventListener(
          'abort',
          () => reject(new HelmxError('aborted', '子代理执行被取消', 409)),
          { once: true },
        )
      })
      const delayed = new Promise<void>((resolve) => setTimeout(resolve, 300))
      // 延迟到启动窗口之后再 onResolved；窗口内 abort 则直接取消。
      await Promise.race([delayed, cancelled])
      request.onResolved?.({ conversationId: 42 })
      const hang = new Promise<void>((resolve) => {
        releaseSpawn = resolve
      })
      await Promise.race([hang, cancelled])
      return 'unreachable'
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const parentSignal = new AbortController()
    const promise = service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '启动期取消',
      signal: parentSignal.signal,
    })
    // spawn 已进入、onResolved 尚未触发：此窗口内父 signal 取消必须传播。
    await spawnEntered
    assert.ok(capturedSignal !== undefined && !capturedSignal.aborted)
    parentSignal.abort()
    // 情况 A 语义：调用方当场收到 aborted 拒绝（不悬挂等待地平线）。
    await assert.rejects(
      () => promise,
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'aborted')
        return true
      },
    )
    // 后台兜底链把 durable 记录结算为 aborted 终态（不悬挂、不留僵尸 running）。
    const items = state.list().items
    assert.equal(items.length, 1)
    const final = service.getRun(items[0]!.key)
    assert.equal(final.status, 'aborted')
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await service.close()
  })

  it('gate 失败传播：run 结算 failed（绝不提前 completed），通知收到失败详情', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'gateFail', execution: { executionId: 'herdr:pane-7', nodeId: 'local' } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '带 gate 任务',
      gate: 'pnpm test',
    })
    assert.equal(execution?.executionId, 'herdr:pane-7')
    assert.equal(execution?.nodeId, 'local')
    // 节点 nodeId 透传（清理按目标节点判断）。
    assert.equal(service.getRun(run.id).nodes?.[0]?.nodeId, 'local')

    host.release()
    await service.wait(run.id)
    const final = service.getRun(run.id)
    assert.equal(final.status, 'failed')
    assert.ok(final.error?.includes('gate_failed'), final.error)
    assert.equal(final.nodes?.[0]?.status, 'failed')
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.ok(host.settledCalls[0]!.summary.error?.includes('gate_failed'))
    await service.close()
  })

  it('插件从不 onResolved 但 settle：execution 留空（绝不伪造），run 正常结算', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'noOnResolved', result: 'external-settled' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run, execution } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '外部运行时',
    })
    // 极快路径：spawn 同步返回且未回 onResolved → 返回值不携带伪造 execution。
    assert.equal(execution, undefined)
    // 返回时可能仍在 running，也可能后台链已极快结算（诚实快路径皆可）。
    assert.ok(run.status === 'running' || run.status === 'completed')
    const result = await service.wait(run.id)
    assert.equal(result, 'external-settled')
    assert.equal(service.getRun(run.id).status, 'completed')
    // 通知同样不带 execution。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.execution, undefined)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    await service.close()
  })

  it('父会话不存在：not_found 透传', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    await assert.rejects(
      () =>
        service.startBackgroundAgent({
          parentConversationId: 999,
          prompt: 'x',
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'not_found')
        return true
      },
    )
    await service.close()
  })

  it('service 关闭后拒绝启动（service_closed）', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    await service.close()
    await assert.rejects(
      () => service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'service_closed')
        return true
      },
    )
  })

  it('创建前已取消的 signal：当场拒绝', timeout, async () => {
    const host = makeHost()
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    const signal = new AbortController()
    signal.abort()
    await assert.rejects(
      () => service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x', signal: signal.signal }),
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'aborted')
        return true
      },
    )
    await service.close()
  })

  it('通知失败不推翻终态：notifiedAt 不置位，重启 init 按 outbox 补发', timeout, async () => {
    const host = makeHost({ notifyFailTimes: 1 })
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'ok' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' })
    host.release()
    await service.wait(run.id)
    // 首次通知失败：终态已落库但 notifiedAt 缺失。
    assert.equal(host.settledCalls.length, 0)
    const header = readHeader(state, run.id)
    assert.equal(header.status, 'completed')
    assert.equal(header.notifiedAt, undefined)
    await service.close()

    // 重启 init：补发一次并落 notifiedAt。
    const reopened = new WorkflowService({ dataDir, host, kv: state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'completed')
    const after = readHeader(state, run.id)
    assert.ok(typeof after.notifiedAt === 'number')
    // 再次 init 不重复。
    await reopened.close()
    const again = new WorkflowService({ dataDir, host, kv: state })
    await again.init()
    assert.equal(host.settledCalls.length, 1)
    await again.close()
  })

  it('进程重启恢复：遗留 subagent running 记录标 failed(interrupted) 并补发通知', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    state.set('wf_restartdead0001', {
      id: 'wf_restartdead0001',
      kind: 'subagent',
      name: 'subagent:researcher',
      conversationId: 1,
      status: 'running',
      phase: 'running',
      createdAt: 1,
      updatedAt: 1,
      notifyParentOnSettle: true,
      agentType: 'researcher',
      execution: { conversationId: 42 },
    })
    const service = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    await service.init()
    const summary = service.getRun('wf_restartdead0001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('subagent run interrupted by process restart'), summary.error)
    assert.ok(summary.error?.includes('resume'), '错误信息须提示可 resume 续接')
    // 补发恰一次，携带 agentType + execution。
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    assert.equal(host.settledCalls[0]!.agentType, 'researcher')
    assert.equal(host.settledCalls[0]!.execution?.conversationId, 42)
    const header = readHeader(state, 'wf_restartdead0001')
    assert.ok(typeof header.notifiedAt === 'number')
    await service.close()
  })

  it('常规 workflow 的 interrupted 记录沿用账本恢复文案（不误用 subagent 文案）', timeout, async () => {
    const host = makeHost()
    const state = makeStateStore()
    const journalPath = join(dataDir, 'artifacts', '1', 'workflow-wf_wfdsldead00001.jsonl')
    state.set('wf_wfdsldead00001', {
      id: 'wf_wfdsldead00001',
      kind: 'workflow',
      name: 'old',
      conversationId: 1,
      status: 'running',
      phase: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath,
    })
    const service = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    await service.init()
    const summary = service.getRun('wf_wfdsldead00001')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error?.includes('resumeFromRunId'), summary.error)
    assert.equal(host.settledCalls.length, 0)
    await service.close()
  })

  it('notifyParentOnSettle=false：不通知，但 run 生命周期完整', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'quiet' }
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    const { run } = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'x' },
      { notifyParentOnSettle: false },
    )
    host.release()
    const result = await service.wait(run.id)
    assert.equal(result, 'quiet')
    assert.equal(service.getRun(run.id).status, 'completed')
    assert.equal(host.settledCalls.length, 0)
    await service.close()
  })

  it('外部执行环境未回报 gate（executionId 存在）：gateResultMissing 显式失败', timeout, async () => {
    const host = makeHost()
    // hanging + onResolved 带 executionId，但从不 onGateResult。
    host.behavior = { kind: 'hanging', execution: { executionId: 'herdr:pane-9' }, result: 'maybe-done' }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'gate 任务',
      gate: 'pnpm build',
    })
    host.release()
    await service.wait(run.id)
    const final = service.getRun(run.id)
    assert.equal(final.status, 'failed', '外部执行环境未回报 gate 不得标 completed')
    assert.ok(final.error?.includes('gate_result_missing'), final.error)
    assert.equal(host.settledCalls[0]!.summary.status, 'failed')
    await service.close()
  })

  it('close() 覆盖在途后台子代理：等待真实退出、移除 active、落终态', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 } }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state })
    const { run } = await service.startBackgroundAgent({ parentConversationId: 1, prompt: 'x' })
    assert.equal(service.getRun(run.id).status, 'running')
    const closing = service.close()
    // close 触发 abort → abortConversation(42)；放行挂起的 spawn 让其 reject。
    await new Promise<void>((resolve) => {
      const check = () => {
        if (host.abortedConversations.length > 0) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
    host.release()
    await closing
    const final = service.getRun(run.id)
    assert.equal(final.status, 'aborted')
    assert.deepEqual(host.abortedConversations, [42])
    // active 已移除。
    assert.ok(!service.listRuns().some((r) => r.id === run.id && r.status === 'running'))
    // 关停期间不唤醒父模型；待投递回报持久保留，下一次启动补发。
    assert.equal(host.settledCalls.length, 0)
    const reopened = new WorkflowService({ dataDir, host, kv: state })
    await reopened.init()
    assert.equal(host.settledCalls.length, 1)
    assert.equal(host.settledCalls[0]!.summary.status, 'aborted')
    await reopened.close()
  })

  it('startBackgroundAgent：保留 request.meta（如 maxSubagentDepth 与自定义字段）并合并 runId', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'hanging', execution: { conversationId: 42 }, result: 'ok' }
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    const meta = withWorkflowSpawnMeta({ customNs: { tag: 'keep-me' } }, { maxSubagentDepth: 4 })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'with-meta',
      meta,
    })
    host.release()
    await service.wait(run.id)
    assert.equal(host.spawns.length, 1)
    assert.deepEqual(host.spawns[0]!['meta'], {
      customNs: { tag: 'keep-me' },
      'builtin:workflow': { maxSubagentDepth: 4, runId: run.id },
    })
    await service.close()
  })

  it('isHostClosing=true 关停期间：因 Session 关闭中断则标 aborted + phase=cleanup_pending；若已完成则保留 completed 且延迟到下次重启 outbox 通知', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    let rejectShutdownSpawn!: (error: Error) => void
    const origSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      if (req.prompt === 'close-while-closing') {
        req.onResolved?.({ conversationId: 55 })
        return await new Promise<never>((_resolve, reject) => {
          rejectShutdownSpawn = reject
        })
      }
      return origSpawn(req)
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    const { run } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'close-while-closing',
    })
    host.behavior = { kind: 'hanging', execution: { conversationId: 56 }, result: 'real-finished-result' }
    const { run: completedRun } = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: 'finish-right-before-harness-close',
    })

    hostClosing = true
    rejectShutdownSpawn(new Error('Session is closed'))
    host.release()
    await service.wait(run.id)
    await service.wait(completedRun.id)

    const saved = readHeader(state, run.id)
    assert.equal(saved.status, 'aborted')
    assert.equal(saved.phase, 'cleanup_pending')
    const savedCompleted = readHeader(state, completedRun.id)
    assert.equal(savedCompleted.status, 'completed')
    assert.equal(savedCompleted.phase, 'settled')
    assert.equal(readDetail(dataDir, completedRun.id).result, 'real-finished-result')
    assert.equal(host.abortedConversations.length, 0, 'host closing 期不再调用已关闭的 abortConversationGuarded')
    assert.equal(host.settledCalls.length, 0, 'host closing 期不向父会话发通知')

    hostClosing = false
    const reopened = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    await reopened.prepareRecovery()
    assert.deepEqual(host.abortedConversations, [55])
    await reopened.init()
    await reopened.awaitPreparedChildrenSettled()
    assert.deepEqual(host.abortedConversations, [55, 55])
    assert.equal(readHeader(state, run.id).phase, 'settled', 'init 必须将 cleanup_pending 收敛为 settled')
    assert.equal(host.settledCalls.length, 2, '重启 outbox 应补发两条待汇报记录')
    assert.equal(host.settledCalls.find((c) => c.summary.id === run.id)?.summary.status, 'aborted')
    assert.equal(host.settledCalls.find((c) => c.summary.id === completedRun.id)?.summary.status, 'completed')
    await reopened.close()
  })

  it('isHostClosing=true 同步工作流 + phase 严格枚举校验：关停标 aborted + cleanup_pending，重启收割子会话且不通知父会话，非法 phase 损坏拒绝', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    host.behavior = { kind: 'hanging', execution: { conversationId: 77 } }
    let rejectWorkflowSpawn!: (error: Error) => void
    host.spawnAgent = async (req) => {
      req.onResolved?.({ conversationId: 77 })
      return await new Promise<never>((_resolve, reject) => {
        rejectWorkflowSpawn = reject
      })
    }

    const run = await service.run({
      conversationId: 1,
      script: 'export const meta = { name: "sync-close", description: "test" }\nreturn await agent("child")',
    })
    await new Promise<void>((resolve) => {
      const check = () => {
        if (rejectWorkflowSpawn !== undefined) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
    hostClosing = true
    rejectWorkflowSpawn(new Error('Session is closed'))
    await service.wait(run.id)

    const saved = readHeader(state, run.id)
    assert.equal(saved.status, 'aborted')
    assert.equal(saved.phase, 'cleanup_pending')
    assert.equal(host.abortedConversations.length, 0)
    assert.equal(host.settledCalls.length, 0)

    hostClosing = false
    const reopened = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    await reopened.prepareRecovery()
    assert.deepEqual(host.abortedConversations, [77])
    await reopened.init()
    await reopened.awaitPreparedChildrenSettled()
    assert.deepEqual(host.abortedConversations, [77, 77])
    assert.equal(readHeader(state, run.id).phase, 'settled')
    assert.equal(host.settledCalls.length, 0, '同步工作流绝不能在恢复期向父会话发通知')
    await reopened.close()

    const badId = 'wf_bad_phase_check01'
    const badKv = makeStateStore()
    badKv.set(badId, {
      id: badId,
      kind: 'workflow',
      name: 'bad',
      conversationId: 1,
      status: 'aborted',
      phase: 'bogus_phase' as unknown as RunHeader['phase'],
      createdAt: 1,
      updatedAt: 1,
      journalPath: join(dataDir, `${badId}.jsonl`),
    } as RunHeader)
    const badService = new WorkflowService({ dataDir, host, kv: badKv, autoRecoverOnRestart: false })
    assert.throws(
      () => badService.getRun(badId),
      (err: unknown) => err instanceof HelmxError && err.code === 'workflow_record_corrupt',
    )
    await badService.close()
  })

  it('isHostClosing=true 关停窗口账本完整性：已执行完的 action/agent 正常落账，下一步 prepareAction 在写 action_started 前中止不留悬空行', timeout, async () => {
    let hostClosing = false
    const host = makeHost()
    host.isHostClosing = () => hostClosing
    host.listActions = () => [
      { pluginId: 'test', id: 'step1', description: 's1', inputSchema: {}, outputSchema: {} },
      { pluginId: 'test', id: 'step2', description: 's2', inputSchema: {}, outputSchema: {} },
    ]
    let step2Invoked = false
    host.invokeAction = async (_pluginId, actionId) => {
      if (actionId === 'step1') {
        hostClosing = true
        return { done: 1 }
      }
      step2Invoked = true
      return { done: 2 }
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, kv: state, autoRecoverOnRestart: false })
    const run = await service.run({
      conversationId: 1,
      script:
        'export const meta = { name: "closing-action-journal", description: "test" }\n' +
        'const a = await action("test.step1", { x: 1 })\n' +
        'const b = await action("test.step2", { x: 2 })\n' +
        'return [a, b]',
    })
    await service.wait(run.id)
    assert.equal(step2Invoked, false, '关停态不得启动后续 step2 动作')
    const saved = readHeader(state, run.id)
    assert.equal(saved.status, 'aborted')
    assert.equal(saved.kind, 'workflow')
    const journalLines = readFileSync(saved.journalPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; index: number; ok?: boolean })
    assert.deepEqual(
      journalLines.map((l) => ({ type: l.type, index: l.index, ...(l.ok !== undefined ? { ok: l.ok } : {}) })),
      [
        { type: 'action_started', index: 0 },
        { type: 'action', index: 0, ok: true },
      ],
    )
    await service.close()
  })

  it('名称推导与 title 透传：label 优先、prompt 清洗截断脱敏、空 prompt 回退、resume/reattach 不覆写 title', timeout, async () => {
    const host = makeHost()
    host.behavior = { kind: 'noOnResolved', result: 'ok' }
    const service = new WorkflowService({
      dataDir,
      host,
      kv: makeStateStore(),
      redact: (text) => text.replace(/SECRET_TOKEN/g, '[REDACTED]'),
    })

    // 1. prompt 剥离 structured_output_contract、Markdown 前缀、多空白、脱敏与 60 字符上限
    const longPrompt = [
      '<structured_output_contract>{"type":"object"}</structured_output_contract>',
      '',
      '---',
      '##   - *   Investigate   SECRET_TOKEN   build   failure   across   packages/plugins/workflow   right   now   please',
      'Second line ignored',
    ].join('\n')
    const r1 = await service.startBackgroundAgent({ parentConversationId: 1, prompt: longPrompt })
    await service.wait(r1.run.id)
    assert.equal(r1.run.name.length <= 60, true, `derived name length <= 60: ${r1.run.name}`)
    assert.ok(r1.run.name.startsWith('Investigate [REDACTED] build failure'), r1.run.name)
    assert.equal(r1.run.nodes?.[0]?.label, r1.run.name)
    assert.equal(host.spawns[0]!['title'], r1.run.name)

    // 2. 空 prompt 回退 subagent:${agentType} / subagent
    const r2 = await service.startBackgroundAgent({
      parentConversationId: 1,
      prompt: '<structured_output_contract>{}</structured_output_contract>\n###\n   ',
      agentType: 'reviewer',
    })
    await service.wait(r2.run.id)
    assert.equal(r2.run.name, 'subagent:reviewer')
    assert.equal(host.spawns[1]!['title'], 'subagent:reviewer')

    // 3. 显式 label 优先；resume 与 reattach 不透传 title
    const r3 = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'ignored prompt', resume: '42' },
      { label: '续接子代理' },
    )
    await service.wait(r3.run.id)
    assert.equal(r3.run.name, '续接子代理')
    assert.equal(host.spawns[2]!['title'], undefined, 'resume 不得设置/覆写 title')

    const r4 = await service.startBackgroundAgent(
      { parentConversationId: 1, prompt: 'ignored prompt', reattach: { conversationId: 42 } },
      { label: '重挂子代理' },
    )
    await service.wait(r4.run.id)
    assert.equal(host.spawns[3]!['title'], undefined, 'reattach 不得设置/覆写 title')

    await service.close()
  })

  it('PersistedSubagentSpec.nodeId：持久保存、崩溃重挂前恢复、有句柄重挂与 resumeFromRunId 不携带、损坏拒绝', timeout, async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'wf-bgsub-node-'))
    try {
      const state = makeStateStore()
      const host = makeHost()
      host.behavior = { kind: 'noOnResolved', result: 'remote-ok' }
      const service = new WorkflowService({ dataDir: localDir, host, kv: state })

      // 1) startBackgroundAgent 透传 nodeId 并在 subagentSpec 落盘
      const started = await service.startBackgroundAgent({
        parentConversationId: 1,
        prompt: 'remote task',
        nodeId: 'gpu-1',
        cwd: '/srv/work',
      })
      await service.wait(started.run.id)
      assert.equal(host.spawns[0]!['nodeId'], 'gpu-1')
      assert.equal(host.spawns[0]!['cwd'], '/srv/work')
      const persistedDetail = readDetail(localDir, started.run.id)
      assert.equal(persistedDetail.subagentSpec?.nodeId, 'gpu-1')
      assert.equal(persistedDetail.subagentSpec?.cwd, '/srv/work')
      await service.close()

      // 2) pre-resolve 崩溃恢复（无 execution handle）：reattachBackgroundAgent 必须还原 nodeId + cwd
      const preResolveId = 'wf_pre_node0001'
      const now = Date.now()
      state.set(preResolveId, {
        id: preResolveId,
        name: 'remote-pre',
        conversationId: 1,
        status: 'running',
        phase: 'running',
        kind: 'subagent',
        notifyParentOnSettle: true,
        createdAt: now,
        updatedAt: now,
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-pre', status: 'running', startedAt: now }],
      })
      writeDetail(localDir, {
        id: preResolveId,
        subagentSpec: {
          agentId: `${preResolveId}:subagent-0`,
          requestId: `helmx:spawn:${preResolveId}`,
          prompt: 'retry remote',
          nodeId: 'gpu-2',
          cwd: '/srv/retry',
        },
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-pre', status: 'running', startedAt: now }],
      })

      // 3) post-resolve 崩溃重挂（已有 conversationId 句柄）：发送 reattach，不传 nodeId / cwd
      const postResolveId = 'wf_post_node001'
      state.set(postResolveId, {
        id: postResolveId,
        name: 'remote-post',
        conversationId: 1,
        status: 'running',
        phase: 'running',
        kind: 'subagent',
        notifyParentOnSettle: true,
        createdAt: now,
        updatedAt: now,
        execution: { nodeId: 'gpu-2', conversationId: 88, effectiveCwd: '/srv/retry' },
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-post', status: 'running', startedAt: now, conversationId: 88 }],
      })
      writeDetail(localDir, {
        id: postResolveId,
        subagentMeta: { execution: { nodeId: 'gpu-2', conversationId: 88, effectiveCwd: '/srv/retry' } },
        subagentSpec: {
          agentId: `${postResolveId}:subagent-0`,
          requestId: `helmx:spawn:${postResolveId}`,
          prompt: 'reattach remote',
          nodeId: 'gpu-2',
          cwd: '/srv/retry',
        },
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-post', status: 'running', startedAt: now, conversationId: 88 }],
      })

      // 4) failed 有句柄子代理经 resumeFromRunId 续接：带 resume，绝不带 nodeId（防与 resume 互斥）
      const failedId = 'wf_fail_node001'
      state.set(failedId, {
        id: failedId,
        name: 'remote-failed',
        conversationId: 1,
        status: 'failed',
        phase: 'settled',
        error: 'interrupted',
        resumable: true,
        kind: 'subagent',
        notifyParentOnSettle: true,
        createdAt: now,
        updatedAt: now,
        execution: { nodeId: 'gpu-2', conversationId: 91, effectiveCwd: '/srv/retry' },
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-failed', status: 'failed', startedAt: now, conversationId: 91 }],
      })
      writeDetail(localDir, {
        id: failedId,
        subagentMeta: { execution: { nodeId: 'gpu-2', conversationId: 91, effectiveCwd: '/srv/retry' } },
        subagentSpec: {
          agentId: `${failedId}:subagent-0`,
          requestId: `helmx:spawn:${failedId}`,
          prompt: 'resume remote',
          nodeId: 'gpu-2',
          cwd: '/srv/retry',
        },
        nodes: [{ id: 'subagent-0', kind: 'agent', label: 'remote-failed', status: 'failed', startedAt: now, conversationId: 91 }],
      })

      const recoverHost = makeHost()
      recoverHost.behavior = { kind: 'noOnResolved', result: 'recovered-ok' }
      const recovered = new WorkflowService({ dataDir: localDir, host: recoverHost, kv: state, autoRecoverOnRestart: true })
      await recovered.init()
      await recovered.wait(preResolveId)
      await recovered.wait(postResolveId)

      const preSpawn = recoverHost.spawns.find((s) => s['requestId'] === `helmx:spawn:${preResolveId}`)
      assert.ok(preSpawn, 'pre-resolve 恢复应重新调用 spawnAgent')
      assert.equal(preSpawn['nodeId'], 'gpu-2', 'pre-resolve 恢复必须还原 subagentSpec.nodeId')
      assert.equal(preSpawn['cwd'], '/srv/retry', 'pre-resolve 恢复必须还原 subagentSpec.cwd')
      assert.equal(preSpawn['reattach'], undefined)

      const postSpawn = recoverHost.spawns.find((s) => s['requestId'] === `helmx:spawn:${postResolveId}`)
      assert.ok(postSpawn, 'post-resolve 恢复应调用 reattach spawnAgent')
      assert.deepEqual(postSpawn['reattach'], { conversationId: 88, effectiveCwd: '/srv/retry' })
      assert.equal(postSpawn['nodeId'], undefined, '原生 conversationId 重挂不得携带 nodeId')
      assert.equal(postSpawn['cwd'], undefined, '原生 conversationId 重挂不得携带 cwd')

      // resumeFromRunId 续接 failed 子代理：只传 resume，不传 nodeId
      const resumedRun = await recovered.run({ resumeFromRunId: failedId })
      await recovered.wait(resumedRun.id)
      const resumeSpawn = recoverHost.spawns.find((s) => s['resume'] === '91')
      assert.ok(resumeSpawn, 'resumeFromRunId 应以 conversationId 续接')
      assert.equal(resumeSpawn['nodeId'], undefined, 'resumeFromRunId 续接不得携带 nodeId（与 resume 互斥）')
      await recovered.close()

      // 5) 损坏的 subagentSpec.nodeId 必须触发显式 workflow_record_corrupt
      const badNodeSpecId = 'wf_bad_nodespec1'
      const corruptKv = makeStateStore()
      corruptKv.set(badNodeSpecId, {
        id: badNodeSpecId,
        name: 'bad-node-spec',
        conversationId: 1,
        status: 'failed',
        phase: 'settled',
        kind: 'subagent',
        createdAt: now,
        updatedAt: now,
      })
      writeDetail(localDir, {
        id: badNodeSpecId,
        subagentSpec: {
          agentId: `${badNodeSpecId}:subagent-0`,
          requestId: `helmx:spawn:${badNodeSpecId}`,
          prompt: 'bad',
          nodeId: '_bad/node!',
        },
      })
      const corruptSvc = new WorkflowService({ dataDir: localDir, host: recoverHost, kv: corruptKv })
      assert.throws(
        () => corruptSvc.getRun(badNodeSpecId),
        (err: unknown) => err instanceof HelmxError && err.code === 'workflow_record_corrupt',
      )
      await corruptSvc.close()
    } finally {
      rmSync(localDir, { recursive: true, force: true })
    }
  })
})
