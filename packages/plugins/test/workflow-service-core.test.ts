/**
 * WorkflowService / RunRepository / DSL Journal / SpawnBridge 核心回归测试：
 * - journal key v5（cwd / nodeId / schema / gate 槽）与 agent 行 execution/gate 记录；
 * - JournalWriter 顺序串行化、poisoned 故障熔断、截断 agent 行匹配 AGENT_LINE_PREFIX；
 * - redactPlainValue 递归处理 Object.create(null) 对象；
 * - RunHeader 存 ctx.kv('runs')（无 script/args/result）、RunDetail 懒落盘 wf-<runId>.detail.json；
 * - 单键原子 replayedFrom 派生接管索引（零双写、零幽灵接管）；
 * - 公开 runWorkflow / WorkflowService.run 驱动的 timeoutMs、失败保留 executionInfo/gate、resumeAgent 透传 requestId；
 * - abort(runId) 不污染父会话取消标志，不阻断兄弟后台子代理汇报；
 * - suspend() 写盘已完成的 action 终态行，避免重启误报 workflow_action_uncertain；
 * - settledAt 防漂移、启动窗口时序与停机屏障、emitEvent 故障收口。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { HelmxError } from '@helmx/protocol'
import { deferred } from '@helmx/test-kit'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assertNoUnhandledRejection } from './helpers/plugin-test-env.js'
import {
  JournalWriter,
  agentJournalKey,
  readJournal,
  redactJournalEntry,
  redactPlainValue,
  type JournalWriteInput,
} from '../src/workflow/dsl/index.js'
import {
  createMemoryKvStore,
  WorkflowService,
  type RunDetail,
  type RunHeader,
  type WorkflowKvStore,
  type WorkflowServiceHost,
} from '../src/workflow/runs/index.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// journal：key v5 / execution+gate / 截断 agent 行 / 串行写与 poisoned / redactPlainValue
// ---------------------------------------------------------------------------

test('agentJournalKey v5：cwd 与 nodeId 参与指纹，未提供时键值稳定', timeout, () => {
  const base = { prompt: 'p', label: 'l' }
  const withoutCwd = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base }), withoutCwd, '同输入同键（版本前缀稳定）')
  assert.notEqual(agentJournalKey({ ...base, cwd: '/repo/a' }), withoutCwd, 'cwd 变化即不同调用')
  assert.notEqual(agentJournalKey({ ...base, cwd: '/repo/b' }), agentJournalKey({ ...base, cwd: '/repo/a' }))
  assert.notEqual(agentJournalKey({ ...base, nodeId: 'gpu-1' }), withoutCwd, 'nodeId 变化即不同调用')
  assert.notEqual(agentJournalKey({ ...base, nodeId: 'local' }), withoutCwd, '显式 local 与省略 nodeId 指纹不同')
  assert.notEqual(
    agentJournalKey({ ...base, nodeId: 'gpu-1' }),
    agentJournalKey({ ...base, nodeId: 'gpu-2' }),
    '不同 nodeId 指纹不同',
  )
  assert.notEqual(
    agentJournalKey({ ...base, cwd: '/repo/a', nodeId: 'gpu-1' }),
    agentJournalKey({ ...base, cwd: '/repo/a', nodeId: 'gpu-2' }),
    '同 cwd 不同 nodeId 指纹不同',
  )
})

test('agent 行携带 execution/gate 落盘可回读，不触发 actionUncertain；截断真实 writer agent 行容错', timeout, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helmx-journal-v5-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'workflow-wf_x.jsonl')
  const writer = new JournalWriter(path)
  await writer.append({
    type: 'agent',
    index: 0,
    key: 'k0',
    scopePath: 'root',
    scopeCallIndex: 0,
    ok: false,
    execution: { conversationId: 7, effectiveCwd: '/w', worktree: { path: '/w', branch: 'helmx/spawn-x' } },
    gate: { ok: false, output: 'gate output', exitCode: null, timedOut: true },
  })
  await writer.append({ type: 'agent', index: 1, key: 'k1', scopePath: 'root', scopeCallIndex: 1, ok: true, text: 'ok' })
  await writer.close()
  const journal = readJournal(path)
  assert.equal(journal.actionUncertain, false)
  assert.equal(journal.ioErrors, 0)
  assert.equal(journal.entries.length, 2)
  const first = journal.entries[0] as Extract<(typeof journal.entries)[number], { type: 'agent' }>
  assert.equal(first.execution?.conversationId, 7)
  assert.equal(first.execution?.worktree?.branch, 'helmx/spawn-x')
  assert.equal(first.gate?.timedOut, true)
  assert.equal(first.gate?.exitCode, null)

  // 验证真实 JournalWriter 写出的行首是 {"type":"agent",...，截断尾行不会误触发 actionUncertain
  const rawLines = readFileSync(path, 'utf8').trim().split('\n')
  assert.ok(rawLines[0]!.startsWith('{"type":"agent",'), `writer 行首应以 type 开头: ${rawLines[0]}`)
  const truncPath = join(dir, 'workflow-wf_trunc.jsonl')
  writeFileSync(truncPath, `${rawLines[0]}\n${rawLines[1]!.slice(0, 32)}`, 'utf8')
  const truncRead = readJournal(truncPath)
  assert.equal(truncRead.actionUncertain, false, '截断的真实 writer agent 行不得触发 actionUncertain')
  assert.equal(truncRead.ioErrors, 1)
  assert.equal(truncRead.entries.length, 1)

  // 非法 execution 形状：按 agent 损行计 ioError（不阻断重放），绝不明为 uncertain。
  const corruptPath = join(dir, 'workflow-wf_bad.jsonl')
  writeFileSync(
    corruptPath,
    `${JSON.stringify({ v: 1, seq: 0, type: 'agent', index: 0, key: 'k', scopePath: 'root', scopeCallIndex: 0, ok: true, execution: { conversationId: 'x' } })}\n`,
    'utf8',
  )
  const corrupt = readJournal(corruptPath)
  assert.equal(corrupt.ioErrors, 1, 'execution 形状非法按 agent 损行计数')
  assert.equal(corrupt.actionUncertain, false, 'agent 行损坏不冒充 action 不确定')
})

test('JournalWriter 并发写入保持 seq 严格递增，关键行写入失败触发 poisoned 熔断', timeout, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helmx-journal-serial-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'serial.jsonl')
  const writer = new JournalWriter(path)
  await Promise.all([
    writer.append({ type: 'agent', index: 0, key: 'k0', scopePath: 'root', scopeCallIndex: 0, ok: true, text: 'a' }),
    writer.append({ type: 'agent', index: 1, key: 'k1', scopePath: 'root', scopeCallIndex: 1, ok: true, text: 'b' }),
    writer.append({ type: 'agent', index: 2, key: 'k2', scopePath: 'root', scopeCallIndex: 2, ok: true, text: 'c' }),
  ])
  await writer.close()
  const read = readJournal(path)
  assert.deepEqual(read.entries.map((e) => e.seq), [0, 1, 2])

  // poisoned 熔断：不可写路径上 action_started 失败后，后续任何关键行立即拒绝
  const broken = new JournalWriter('/proc/definitely/not/writable.jsonl')
  await assert.rejects(
    () => broken.append({ type: 'action_started', index: 0, key: 'k0', scopePath: 'root', scopeCallIndex: 0 }),
    /workflow journal/i,
  )
  await assert.rejects(
    () => broken.append({ type: 'action', index: 0, key: 'k0', scopePath: 'root', scopeCallIndex: 0, ok: true }),
    /poisoned|workflow journal/i,
  )
})

test('账本版本/序号损坏和相同 seq 的冲突记录不能掩盖已执行 action', timeout, (t) => {
  const env = makeEnv(t, async () => 'unused')
  const path = join(env.dataDir, 'journal-corrupt.jsonl')
  const agent = { v: 1, seq: 0, type: 'agent', index: 0, key: 'agent', scopePath: 'root', scopeCallIndex: 0, ok: true, text: 'done' }
  const action = { v: 1, seq: 0, type: 'action', index: 1, key: 'effect', scopePath: 'root', scopeCallIndex: 1, ok: true, result: 'sent' }
  for (const row of [
    { ...action, seq: -1 }, { ...action, v: 2 }, { ...action, seq: null },
    { ...action, scopePath: undefined }, { ...action, scopeCallIndex: -1 },
    { ...action, scopePath: 'outside/0' }, { ...action, scopePath: 'root/../1' },
  ]) {
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.equal(readJournal(path).actionUncertain, true)
  }
  writeFileSync(path, `${JSON.stringify(agent)}\n${JSON.stringify(action)}\n`)
  const conflict = readJournal(path)
  assert.equal(conflict.actionUncertain, true, '相同 seq 的冲突行不能通过去重丢掉 action')
  assert.equal(conflict.ioErrors, 1)
  writeFileSync(path, `${JSON.stringify(agent)}\n${JSON.stringify(agent)}\n`)
  const duplicate = readJournal(path)
  assert.equal(duplicate.actionUncertain, false)
  assert.equal(duplicate.entries.length, 1)
  const intent = { ...action, type: 'action_started', scopePath: 'root/0', scopeCallIndex: 0 }
  const otherScopeResult = { ...action, seq: 1, scopePath: 'root/1', scopeCallIndex: 0 }
  writeFileSync(path, `${JSON.stringify(intent)}\n${JSON.stringify(otherScopeResult)}\n`)
  assert.equal(readJournal(path).actionUncertain, true, '其他 scope 的终态不能掩盖悬挂的非幂等意图')
})

test('redactJournalEntry 与 redactPlainValue：逐值脱敏且递归穿透 Object.create(null)', timeout, () => {
  const redact = (text: string): string => text.replaceAll('sec', '***')
  const agentEntry: JournalWriteInput = {
    type: 'agent',
    index: 0,
    key: 'k',
    scopePath: 'root',
    scopeCallIndex: 0,
    ok: false,
    text: 'contains sec-ret',
    execution: { conversationId: 1, effectiveCwd: '/sec-dir', worktree: { path: '/sec-dir/wt', branch: 'b' } },
    gate: { ok: false, output: 'failed with sec' },
  }
  const redacted = redactJournalEntry(agentEntry, redact) as Extract<JournalWriteInput, { type: 'agent' }>
  assert.equal(redacted.text, 'contains ***-ret')
  assert.equal(redacted.execution?.effectiveCwd, '/***-dir')
  assert.equal(redacted.execution?.worktree?.path, '/***-dir/wt')
  assert.equal(redacted.gate?.output, 'failed with ***')
  assert.equal((agentEntry as Extract<JournalWriteInput, { type: 'agent' }>).text, 'contains sec-ret')

  // Object.create(null) 对象也必须递归脱敏
  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, {
    token: 'my-sec-val',
    nested: Object.assign(Object.create(null) as Record<string, unknown>, { k: 'deep-sec' }),
  })
  const scrubbed = redactPlainValue(nullProto, redact) as Record<string, unknown>
  assert.equal(scrubbed['token'], 'my-***-val')
  assert.equal((scrubbed['nested'] as Record<string, unknown>)['k'], 'deep-***')
})

// ---------------------------------------------------------------------------
// service 测试环境
// ---------------------------------------------------------------------------

function makeParentSummary(id: number, cwd: string) {
  return {
    id, title: '测试父会话', profileId: 'assistant', tags: [], cwd,
    model: 'test/model', thinkingLevel: '', status: 'idle' as const, stateChangeSeq: 1, completionSeq: 0,
    unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
  }
}

function makeEnv(
  t: TestContext,
  spawnAgent: WorkflowServiceHost['spawnAgent'],
  hostOverrides?: Partial<WorkflowServiceHost>,
  kvOverride?: WorkflowKvStore<RunHeader>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-service-core-'))
  const kv: WorkflowKvStore<RunHeader> = kvOverride ?? createMemoryKvStore<RunHeader>()
  const guardedAborts: number[] = []
  const host: WorkflowServiceHost = {
    spawnAgent,
    async invokeAction() {
      throw new Error('此测试不调用动作')
    },
    listActions: () => [],
    getConversation: (id: number) => makeParentSummary(id, dataDir),
    async abortConversationGuarded(id: number) {
      guardedAborts.push(id)
    },
    emitEvent: () => {},
    ...hostOverrides,
  }
  const service = new WorkflowService({ dataDir, kv, host })
  // after 钩子不受测试 timeout 覆盖：close() 若因残留 run 永不收敛会静默拖死整个分片，显式给钩子超时让故障可见。
  t.after(
    async () => {
      await service.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
    timeout,
  )
  return { dataDir, kv, service, guardedAborts }
}

const detailPath = (dataDir: string, conversationId: number, runId: string) =>
  join(dataDir, 'artifacts', String(conversationId), `wf-${runId}.detail.json`)

const readDetailFile = (dataDir: string, conversationId: number, runId: string) =>
  JSON.parse(readFileSync(detailPath(dataDir, conversationId, runId), 'utf-8')) as RunDetail

// ---------------------------------------------------------------------------
// KV RunHeader + 懒落盘 RunDetail 存储契约
// ---------------------------------------------------------------------------

test('run 完成后：KV 仅存轻量 RunHeader（无 script/args/result），重量内容落 wf-<runId>.detail.json', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const started = await env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "slim", description: "d" }\nreturn await agent("任务")',
    args: { payload: 'x'.repeat(200) },
  })
  await env.service.wait(started.id)
  const listed = env.kv.list()
  assert.equal(listed.items.length, 1)
  const header = listed.items[0]!.value as unknown as Record<string, unknown>
  assert.equal(header['id'], started.id)
  assert.equal(header['status'], 'completed')
  assert.equal(header['phase'], 'settled')
  assert.equal(header['conversationId'], 1)
  for (const heavy of ['result', 'script', 'args']) {
    assert.equal(header[heavy], undefined, `KV RunHeader 不得携带重量字段 ${heavy}`)
  }
  assert.ok(existsSync(detailPath(env.dataDir, 1, started.id)), 'RunDetail 必须落盘')
  const detail = readDetailFile(env.dataDir, 1, started.id)
  assert.equal(
    detail.script,
    'export const meta = { name: "slim", description: "d" }\nreturn await agent("任务")',
  )
  assert.equal(detail.result, '结果')
  assert.ok(Array.isArray(detail.nodes))
})

test('run 完成后跨重启可从 KV + Detail 读回摘要', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const started = await env.service.run({
    conversationId: 2,
    script: 'export const meta = { name: "revive", description: "d" }\nreturn await agent("任务")',
  })
  await env.service.wait(started.id)
  const host2: WorkflowServiceHost = {
    spawnAgent: async () => 'unused',
    invokeAction: async () => ({}),
    listActions: () => [],
    getConversation: () => makeParentSummary(2, env.dataDir),
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const revived = new WorkflowService({ dataDir: env.dataDir, kv: env.kv, host: host2 })
  try {
    const summary = revived.getRun(started.id)
    assert.equal(summary.status, 'completed')
    assert.equal(summary.result, '结果')
    assert.equal(summary.nodes?.length, 1)
  } finally {
    await revived.close()
  }
})

// ---------------------------------------------------------------------------
// 单键原子 replayedFrom 派生接管索引（零双写）
// ---------------------------------------------------------------------------

test('resumeFromRunId：由新 run 的 replayedFrom 单键原子派生 resumedByRunId，重复 resume 409 且跨重启持久生效', timeout, async (t) => {
  const takeoverNotifications: Array<{ id: string; resumedByRunId?: string; resumable?: boolean }> = []
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-takeover-'))
  const kv = createMemoryKvStore<RunHeader>()
  const host: WorkflowServiceHost = {
    spawnAgent: async () => '结果',
    invokeAction: async () => ({}),
    listActions: () => [],
    getConversation: (id) => makeParentSummary(id, dataDir),
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const service = new WorkflowService({
    dataDir,
    kv,
    host,
    onTakeoverUpdated: (prior) => {
      takeoverNotifications.push({ id: prior.id, resumedByRunId: prior.resumedByRunId, resumable: prior.resumable })
    },
  })
  t.after(async () => {
    await service.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }, { timeout: 60_000 })

  const first = await service.run(
    {
      conversationId: 3,
      script: 'export const meta = { name: "takeover", description: "d" }\nreturn await agent("任务")',
    },
    { notifyParentOnSettle: true },
  )
  await service.wait(first.id)
  const second = await service.run({ resumeFromRunId: first.id })
  await service.wait(second.id)

  // 原 run 在 KV 中保持不可变（零双写），resumedByRunId 完全由 replayedFrom 反向索引派生
  const firstHeader = kv.get(first.id) as unknown as Record<string, unknown>
  assert.equal(firstHeader['resumedByRunId'], undefined, '原 RunHeader 不再双写 resumedByRunId')
  const secondHeader = kv.get(second.id)!
  assert.equal(secondHeader.replayedFrom, first.id)
  assert.equal(secondHeader.notifyParentOnSettle, true)
  assert.equal(service.getRun(first.id).resumedByRunId, second.id, '派生摘要携带 resumedByRunId')
  assert.equal(takeoverNotifications.some((n) => n.id === first.id && n.resumedByRunId === second.id), true)

  // 防重复：同一源 run 二次 resume 显式 409
  await assert.rejects(
    () => service.run({ resumeFromRunId: first.id }),
    (error: unknown) => error instanceof HelmxError && error.code === 'conflict',
  )

  // 重启后派生索引自动重建
  const restarted = new WorkflowService({ dataDir, kv, host })
  try {
    assert.equal(restarted.getRun(first.id).resumedByRunId, second.id)
    await assert.rejects(
      () => restarted.run({ resumeFromRunId: first.id }),
      (error: unknown) => error instanceof HelmxError && error.code === 'conflict',
    )
  } finally {
    await restarted.close()
  }
})

// ---------------------------------------------------------------------------
// 节点 prompt 截断：Header <= 256，Detail <= 1024
// ---------------------------------------------------------------------------

test('节点 prompt 截断：KV Header 截断在 256 字符内，Detail 截断在 1024 字符内', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const longPrompt = 'x'.repeat(3000)
  const started = await env.service.run({
    conversationId: 4,
    script: `export const meta = { name: "trunc", description: "d" }\nreturn await agent(${JSON.stringify(longPrompt)})`,
  })
  await env.service.wait(started.id)
  const detailNode = env.service.getRun(started.id).nodes![0]!
  assert.ok(detailNode.prompt !== undefined)
  assert.ok(detailNode.prompt!.length <= 1024, `detail prompt len=${detailNode.prompt!.length}`)
  assert.ok(detailNode.prompt!.endsWith('…'))

  const headerNode = env.kv.get(started.id)!.nodes![0]!
  assert.ok(headerNode.prompt !== undefined)
  assert.ok(headerNode.prompt!.length <= 256, `header prompt len=${headerNode.prompt!.length}`)
  assert.ok(headerNode.prompt!.endsWith('…'))
})

// ---------------------------------------------------------------------------
// 公开 WorkflowService.run 驱动：失败保留 executionInfo/gate、timeoutMs、resumeAgent requestId
// ---------------------------------------------------------------------------

test('agent 失败分支保留 executionInfo 与 gate 回报（不丢弃 Worktree/会话坐标）', timeout, async (t) => {
  const custom = makeEnv(
    t,
    async (proto: unknown) => {
      const request = proto as {
        onResolved?: (info: unknown) => void
        onGateResult?: (gate: unknown) => void
      }
      request.onResolved?.({ conversationId: 7, effectiveCwd: '/work/dir' })
      request.onGateResult?.({ ok: false, output: '门禁输出', exitCode: 1 })
      throw new HelmxError('gate_failed', '门禁失败', 502)
    },
    { runGate: async () => ({ ok: true, output: '' }) },
  )
  const run = await custom.service.run({
    conversationId: 5,
    script: 'export const meta = { name: "fail-keep", description: "d" }\nreturn await agent.withMeta("p", { label: "worker", gate: "test -n x", maxAttempts: 1 })',
  })
  const out = (await custom.service.wait(run.id)) as {
    ok: boolean
    error?: string
    execution?: { conversationId?: number; effectiveCwd?: string }
    gate?: { ok: boolean; output: string }
  }
  assert.equal(out.ok, false)
  assert.ok(out.error!.includes('[gate_failed]'))
  assert.equal(out.execution?.conversationId, 7, '失败分支必须保留 executionInfo')
  assert.equal(out.execution?.effectiveCwd, '/work/dir')
  assert.equal(out.gate?.ok, false, '失败分支必须保留 gate 回报')
  assert.equal(out.gate?.output, '门禁输出')
})

test('agent timeoutMs：超时守卫中止子会话并返回 [agent_timeout]（保留 executionInfo；signal.reason 为 TimeoutError；timedOut=true）', timeout, async (t) => {
  let observedReason: unknown
  const custom = makeEnv(t, (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
    request.onResolved?.({ conversationId: 9, effectiveCwd: '/hang/dir' })
    request.signal?.addEventListener('abort', () => {
      observedReason = request.signal?.reason
    })
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new HelmxError('aborted', '回合中止', 409)), { once: true })
    })
  })
  const run = await custom.service.run({
    conversationId: 5,
    script: 'export const meta = { name: "timeout-test", description: "d" }\nreturn await agent.withMeta("p", { label: "hang", timeoutMs: 1000, maxAttempts: 1 })',
  })
  const result = (await custom.service.wait(run.id)) as {
    ok: boolean
    error?: string
    timedOut?: boolean
    execution?: { conversationId?: number }
  }
  assert.equal(result.ok, false)
  assert.ok(result.error!.includes('[agent_timeout]'), `错误应含超时锚点：${result.error}`)
  assert.equal(result.timedOut, true)
  assert.equal(result.execution?.conversationId, 9)
  assert.deepEqual(custom.guardedAborts, [9])
  const reason = observedReason as { name?: string } | undefined
  assert.equal(reason?.name, 'TimeoutError')
})

test('agent 超时：返回前等完自己触发的守卫中止（后续 resume 不撞在途 abort）', timeout, async (t) => {
  const abortEntered = deferred()
  const abortGate = deferred()
  let attemptCount = 0
  let abortCompletedBeforeAttempt2 = false
  let abortDone = false
  const custom = makeEnv(
    t,
    (proto: unknown) => {
      attemptCount++
      const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
      if (attemptCount === 1) {
        request.onResolved?.({ conversationId: 12 })
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new HelmxError('aborted', '回合中止', 409)), { once: true })
        })
      }
      abortCompletedBeforeAttempt2 = abortDone
      return Promise.resolve('recovered-on-attempt-2')
    },
    {
      abortConversationGuarded: async (id: number) => {
        custom.guardedAborts.push(id)
        abortEntered.resolve()
        await abortGate.promise
        abortDone = true
      },
    },
  )
  const run = await custom.service.run({
    conversationId: 5,
    script: 'export const meta = { name: "slow-abort", description: "d" }\nreturn await agent("p", { label: "slow", timeoutMs: 1000, maxAttempts: 2 })',
  })
  await abortEntered.promise
  await nextTurn()
  assert.equal(attemptCount, 1, '守卫中止未完成前不得进入第 2 次尝试')
  abortGate.resolve()
  const val = await custom.service.wait(run.id)
  assert.equal(val, 'recovered-on-attempt-2')
  assert.equal(abortCompletedBeforeAttempt2, true)
  assert.deepEqual(custom.guardedAborts, [12])
})

test('外部回合超时保留执行方诊断，不宣称底层进程已停止', timeout, async (t) => {
  const custom = makeEnv(t, (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
    request.onResolved?.({ nodeId: 'local', executionId: 'pane-timeout' })
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new HelmxError(
        'agent_timeout', '底层 CLI 可能仍在执行\n终端最后 40 行（脱敏）：\nworking at task', 408,
      )), { once: true })
    })
  })
  const run = await custom.service.run({
    conversationId: 5,
    script: 'export const meta = { name: "ext-timeout", description: "d" }\nreturn await agent.withMeta("p", { label: "external", timeoutMs: 1000, maxAttempts: 1 })',
  })
  const result = (await custom.service.wait(run.id)) as {
    ok: boolean
    timedOut?: boolean
    error?: string
    execution?: { executionId?: string }
  }
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.execution?.executionId, 'pane-timeout')
  assert.match(result.error ?? '', /底层 CLI 可能仍在执行/)
  assert.match(result.error ?? '', /终端最后 40 行/)
  assert.doesNotMatch(result.error ?? '', /已中止子会话/)
  assert.deepEqual(custom.guardedAborts, [])
})

test('agent timeoutMs 非法值在边界显式拒绝（1_000..3_600_000）且 resumeAgent 透传 requestId', timeout, async (t) => {
  const requestIds: Array<string | undefined> = []
  const custom = makeEnv(t, async (proto: unknown) => {
    const req = proto as { requestId?: string; onResolved?: (info: unknown) => void }
    requestIds.push(req.requestId)
    req.onResolved?.({ conversationId: 33 })
    return 'ok'
  })
  const badRun = await custom.service.run({
    conversationId: 5,
    script: 'export const meta = { name: "bad-timeout", description: "d" }\nreturn await agent("p", { timeoutMs: 100 })',
  })
  await custom.service.wait(badRun.id)
  assert.equal(custom.service.getRun(badRun.id).status, 'failed')

  const resumeRun = await custom.service.run({
    conversationId: 5,
    script:
      'export const meta = { name: "resume-reqid", description: "d" }\n' +
      'await agent("first", { label: "w" })\n' +
      'return await agent("second", { resume: "w" })',
  })
  await custom.service.wait(resumeRun.id)
  assert.equal(requestIds.length, 2)
  assert.ok(typeof requestIds[0] === 'string' && requestIds[0].startsWith('helmx:spawn:'))
  assert.ok(typeof requestIds[1] === 'string' && requestIds[1].startsWith('helmx:spawn:'), 'resumeAgent 也必须透传确定性 requestId')
  assert.notEqual(requestIds[0], requestIds[1])
})

// ---------------------------------------------------------------------------
// Bug 回归：abort(runId) 不阻断兄弟后台运行向父会话汇报
// ---------------------------------------------------------------------------

test('abort(runId) 绝不污染父会话取消态，兄弟后台 run 完成时正常向父会话汇报', timeout, async (t) => {
  const settledIds: string[] = []
  let releaseSibling!: () => void
  const siblingEntered = deferred<void>()
  const victimEntered = deferred<void>()
  const env = makeEnv(
    t,
    (req) => {
      if (req.prompt === 'victim') {
        req.onResolved?.({ conversationId: 201 })
        victimEntered.resolve()
        return new Promise<never>((_res, rej) => {
          req.signal?.addEventListener('abort', () => rej(new HelmxError('aborted', 'cancelled', 409)), { once: true })
        })
      }
      req.onResolved?.({ conversationId: 202 })
      siblingEntered.resolve()
      return new Promise<string>((resolve) => {
        releaseSibling = () => resolve('sibling-done')
      })
    },
    {
      onBackgroundAgentSettled: async (summary) => {
        settledIds.push(summary.id)
      },
    },
  )

  const victim = await env.service.startBackgroundAgent({ parentConversationId: 1, prompt: 'victim' })
  const sibling = await env.service.startBackgroundAgent({ parentConversationId: 1, prompt: 'sibling' })
  await Promise.all([victimEntered.promise, siblingEntered.promise])

  await env.service.abort(victim.run.id)
  assert.equal(env.service.isConversationCancelling(1), false, '中止单条 run 绝不能把父会话标为 cancelling')
  assert.equal(env.service.getRun(victim.run.id).status, 'aborted')

  releaseSibling()
  await env.service.wait(sibling.run.id)
  assert.equal(env.service.getRun(sibling.run.id).status, 'completed')
  assert.ok(settledIds.includes(sibling.run.id), '兄弟后台 run 必须正常触发父会话汇报')
})

// ---------------------------------------------------------------------------
// Bug 回归：suspend() 写盘已完成的 action 终态行，避免重启误报 uncertain
// ---------------------------------------------------------------------------

test('suspend() 期间正在完成的 action 必写终态行，重启后 readJournal.actionUncertain=false', timeout, async (t) => {
  const actionEntered = deferred<void>()
  const releaseAction = deferred<void>()
  const env = makeEnv(
    t,
    async () => 'unused',
    {
      listActions: () => [{ pluginId: 'test', id: 'slow', description: 'slow', inputSchema: {}, outputSchema: {} }],
      invokeAction: async () => {
        actionEntered.resolve()
        await releaseAction.promise
        return { done: true }
      },
    },
  )
  const run = await env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "suspend-action", description: "d" }\nreturn await action("test.slow", { x: 1 })',
  })
  await actionEntered.promise
  const suspending = env.service.suspend()
  // 模拟 action 在 suspend 窗口内正常返回
  releaseAction.resolve()
  await suspending

  const header = env.kv.get(run.id)!
  assert.equal(header.kind, 'workflow')
  const journal = readJournal(header.journalPath)
  assert.equal(journal.actionUncertain, false, '已完成的 action 必须写出终态行，不得留悬挂 action_started')
  assert.equal(journal.entries.filter((e) => e.type === 'action' && e.ok).length, 1)
})

// ---------------------------------------------------------------------------
// 跨重启 resume：手工 seed 失败 attempt 行，resumeRef 直传 conversationId
// ---------------------------------------------------------------------------

function seedPersistedRun(
  dataDir: string,
  kv: WorkflowKvStore<RunHeader>,
  spec: {
    runId: string
    conversationId: number
    status: 'running' | 'completed' | 'failed' | 'aborted'
    phase?: RunHeader['phase']
    createdAt?: number
    updatedAt?: number
    script?: string
    error?: string
    kind?: 'workflow' | 'subagent'
    notifyParentOnSettle?: boolean
    childConversationIds?: number[]
    journal?: string[]
  },
): { journalPath: string; detailFile: string } {
  const dir = join(dataDir, 'artifacts', String(spec.conversationId))
  mkdirSync(dir, { recursive: true })
  const journalPath = join(dir, `workflow-${spec.runId}.jsonl`)
  const detailFile = detailPath(dataDir, spec.conversationId, spec.runId)
  const createdAt = spec.createdAt ?? 1_000
  const updatedAt = spec.updatedAt ?? 2_000
  const phase = spec.phase ?? (spec.status === 'running' ? 'running' : 'settled')
  const header: RunHeader =
    spec.kind === 'subagent'
      ? {
          id: spec.runId,
          kind: 'subagent',
          name: 'seeded',
          conversationId: spec.conversationId,
          status: spec.status,
          phase,
          createdAt,
          updatedAt,
          ...(spec.error !== undefined ? { error: spec.error } : {}),
          ...(spec.notifyParentOnSettle !== undefined ? { notifyParentOnSettle: spec.notifyParentOnSettle } : {}),
          ...(spec.childConversationIds !== undefined ? { childConversationIds: spec.childConversationIds } : {}),
        }
      : {
          id: spec.runId,
          kind: 'workflow',
          name: 'seeded',
          conversationId: spec.conversationId,
          status: spec.status,
          phase,
          createdAt,
          updatedAt,
          journalPath,
          ...(spec.error !== undefined ? { error: spec.error } : {}),
          ...(spec.notifyParentOnSettle !== undefined ? { notifyParentOnSettle: spec.notifyParentOnSettle } : {}),
          ...(spec.childConversationIds !== undefined ? { childConversationIds: spec.childConversationIds } : {}),
        }
  kv.set(spec.runId, header)
  writeFileSync(
    detailFile,
    JSON.stringify({
      id: spec.runId,
      ...(spec.script !== undefined ? { script: spec.script } : {}),
    }),
    'utf8',
  )
  writeFileSync(journalPath, `${(spec.journal ?? []).join('\n')}${(spec.journal ?? []).length > 0 ? '\n' : ''}`, 'utf8')
  return { journalPath, detailFile }
}

test('跨重启 resume：失败 attempt 行的 execution.conversationId 经 resumeRef 直传 AgentSpawnRequest.resume（不拼 runId）', timeout, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-restart-resume-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const convId = 9
  const priorRunId = 'wf_seedfail0001'
  const prompt = '跨重启续接任务'
  const kv = createMemoryKvStore<RunHeader>()
  seedPersistedRun(dataDir, kv, {
    runId: priorRunId,
    conversationId: convId,
    status: 'failed',
    error: '[agent_failed] 尝试失败',
    script: `export const meta = { name: "restart-resume", description: "d" }\nreturn await agent(${JSON.stringify(prompt)}, { maxAttempts: 2 })`,
    journal: [
      JSON.stringify({
        v: 1,
        seq: 0,
        type: 'agent',
        index: 0,
        key: agentJournalKey({ prompt }),
        scopePath: 'root',
        scopeCallIndex: 0,
        ok: false,
        attempt: 1,
        error: '[agent_failed] 尝试失败',
        execution: { conversationId: 77 },
      }),
    ],
  })
  const spawns: Array<{ resume?: string; agentId?: string }> = []
  const host: WorkflowServiceHost = {
    spawnAgent: async (request) => {
      spawns.push({ resume: request.resume, agentId: request.agentId })
      return 'retry-ok'
    },
    invokeAction: async () => {
      throw new Error('本测试不调用动作')
    },
    listActions: () => [],
    getConversation: (id: number) => makeParentSummary(id, dataDir),
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const revived = new WorkflowService({ dataDir, kv, host })
  try {
    const summary = await revived.run({ resumeFromRunId: priorRunId })
    await revived.wait(summary.id)
    assert.equal(revived.getRun(summary.id).status, 'completed')
    assert.equal(spawns.length, 1, '重放后仅一次续接 spawn')
    assert.equal(spawns[0]!.resume, '77', 'resumeRef 直传 conversationId 字符串到 resume')
    assert.ok(spawns[0]!.agentId!.includes(':'), '原生 agentId 仍带 runId 命名空间')
  } finally {
    await revived.close()
  }
})

test('prepare/init 读取损坏 KV header：显式 workflow_record_corrupt 拒绝，且不修改记录或中止子会话', timeout, async (t) => {
  const kv = createMemoryKvStore<RunHeader>()
  const env = makeEnv(t, async () => 'unused', undefined, kv)
  seedPersistedRun(env.dataDir, kv, {
    runId: 'wf_idxcrash001',
    conversationId: 21,
    status: 'running',
    kind: 'subagent',
    notifyParentOnSettle: true,
    childConversationIds: [88],
  })
  kv.set('wf_corrupt_row', { bad: true } as unknown as RunHeader)
  await assert.rejects(
    () => env.service.prepareRecovery(),
    (error: unknown) => error instanceof HelmxError && error.code === 'workflow_record_corrupt',
  )
  await assert.rejects(
    () => env.service.init(),
    (error: unknown) => error instanceof HelmxError && error.code === 'workflow_record_corrupt',
  )
  assert.equal(kv.get('wf_idxcrash001')!.status, 'running', '记录不得被改终态')
  assert.deepEqual(env.guardedAborts, [], '损坏 header 下不得触发任何子会话中止')
})

test('resume 并发防双接管：首个 resume flush 窗口内第二个并发 resume 409', timeout, async (t) => {
  const baseKv = createMemoryKvStore<RunHeader>()
  let releaseFlush: (() => void) | undefined
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  // 门闩落下的确定性信号：替代固定 sleep（慢 runner 上 40ms 可能还没走到这里，409 断言先失败则门闩永不释放、close() 挂死）。
  const flushEntered = deferred<void>()
  let holdNextFlush = false
  const kv: WorkflowKvStore<RunHeader> = {
    ...baseKv,
    flush: async () => {
      if (holdNextFlush) {
        holdNextFlush = false
        flushEntered.resolve()
        await flushGate
      }
      await baseKv.flush()
    },
  }
  const env = makeEnv(t, async () => 'conc-resume-result', undefined, kv)
  seedPersistedRun(env.dataDir, baseKv, {
    runId: 'wf_conc0000001',
    conversationId: 25,
    status: 'failed',
    error: '[agent_failed] 失败',
    script: 'export const meta = { name: "conc", description: "d" }\nreturn 7',
    journal: [],
  })
  holdNextFlush = true
  const first = env.service.run({ resumeFromRunId: 'wf_conc0000001' })
  try {
    await flushEntered.promise
    await assert.rejects(
      () => env.service.run({ resumeFromRunId: 'wf_conc0000001' }),
      (error: unknown) => error instanceof HelmxError && error.code === 'conflict',
      '并发启动窗口内必须 409 拦截双接管',
    )
  } finally {
    releaseFlush!()
  }
  const summary = await first
  await env.service.wait(summary.id)
  assert.equal(env.service.getRun(summary.id).result, 7)
  assert.equal(env.service.getRun('wf_conc0000001').resumedByRunId, summary.id)
})

// ---------------------------------------------------------------------------
// gate.exitCode/timedOut 全链保留
// ---------------------------------------------------------------------------

test('节点 gate.exitCode/timedOut 全链保留（进度折叠与脱敏不丢诊断字段）', timeout, async (t) => {
  const env = makeEnv(
    t,
    async (proto: unknown) => {
      const request = proto as {
        onResolved?: (info: unknown) => void
        onGateResult?: (gate: unknown) => void
      }
      request.onResolved?.({ conversationId: 41 })
      request.onGateResult?.({ ok: false, output: 'gate 失败输出', exitCode: 3, timedOut: true })
      throw new HelmxError('gate_failed', '门禁失败', 502)
    },
    { runGate: async () => ({ ok: true, output: 'host-gate' }) },
  )
  const started = await env.service.run({
    conversationId: 13,
    script:
      'export const meta = { name: "gate-diag", description: "d" }\nreturn await agent("gated task", { gate: "true", maxAttempts: 1 })',
  })
  await env.service.wait(started.id)
  const node = env.service.getRun(started.id).nodes![0]!
  assert.equal(node.gate?.ok, false)
  assert.equal(node.gate?.exitCode, 3)
  assert.equal(node.gate?.timedOut, true)
  const persisted = readDetailFile(env.dataDir, 13, started.id)
  assert.equal(persisted.nodes![0]!.gate!.exitCode, 3)
  assert.equal(persisted.nodes![0]!.gate!.timedOut, true)
})

test('startBackgroundAgent 节点 gate.exitCode/timedOut 保留', timeout, async (t) => {
  const env = makeEnv(t, async (proto: unknown) => {
    const request = proto as {
      onResolved?: (info: unknown) => void
      onGateResult?: (gate: unknown) => void
    }
    request.onResolved?.({ conversationId: 51 })
    request.onGateResult?.({ ok: false, output: 'bg gate 失败', exitCode: 2, timedOut: true })
    return 'bg-done'
  })
  const { run } = await env.service.startBackgroundAgent({
    parentConversationId: 14,
    prompt: '后台任务',
    gate: 'true',
  })
  await env.service.wait(run.id)
  const node = env.service.getRun(run.id).nodes![0]!
  assert.equal(node.gate?.ok, false)
  assert.equal(node.gate?.exitCode, 2)
  assert.equal(node.gate?.timedOut, true)
})

test('startWorkflowRun 命名优先级与 label 边界校验，及 agent title 透传（fresh 传、resume 不传）', timeout, async (t) => {
  const spawns: Array<Record<string, unknown>> = []
  const env = makeEnv(t, async (proto: unknown) => {
    const req = proto as Record<string, unknown> & { onResolved?: (info: unknown) => void }
    spawns.push(req)
    req.onResolved?.({ conversationId: 61 })
    return 'agent-out'
  })

  await assert.rejects(
    () => env.service.run({ conversationId: 1, script: 'export const meta = { name: "m", description: "d" }\nreturn 1', label: '   ' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
  )
  await assert.rejects(
    () => env.service.run({ conversationId: 1, script: 'export const meta = { name: "m", description: "d" }\nreturn 1', label: 123 as unknown as string }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
  )

  const rLabel = await env.service.run({
    conversationId: 1,
    label: '  覆盖标题  ',
    script:
      'export const meta = { name: "meta-name", description: "d" }\n' +
      'const first = await agent("step1", { label: "worker-alpha" })\n' +
      'const second = await agent("step2", { resume: "worker-alpha" })\n' +
      'return { first, second }',
  })
  assert.equal(rLabel.name, '覆盖标题')
  await env.service.wait(rLabel.id)
  assert.equal(spawns.length, 2)
  assert.equal(spawns[0]!['title'], 'worker-alpha')
  assert.equal(spawns[1]!['title'], undefined)

  const scriptFile = join(env.dataDir, 'custom-file-name.js')
  writeFileSync(scriptFile, 'return 99', 'utf8')
  const rScriptPath = await env.service.run({ conversationId: 1, scriptPath: scriptFile })
  assert.equal(rScriptPath.name, 'custom-file-name')
  await env.service.wait(rScriptPath.id)
})

// ---------------------------------------------------------------------------
// 并发注册时序 / 停机屏障 / emitEvent 收口 / settledAt 防漂移
// ---------------------------------------------------------------------------

/**
 * 首次 flush 阻塞的 KV：把 run 卡在「已 active.set + 已 saveHeader、尚未驱动执行」的启动窗口内。
 * `entered` 在门闩真正落下时 resolve——此后 runId 必已捕获、run 必已在 active 表中。
 * 消费方必须 `await entered` 再取 runId（固定 sleep 在慢 runner 上不够，断言先失败会导致门闩永不释放、
 * `service.close()` 在 after 钩子里无限等待且不受测试超时覆盖，整个分片静默挂死），并在 finally 中 release()。
 */
function makeGatedSnapshotKv(): {
  kv: WorkflowKvStore<RunHeader>
  entered: Promise<void>
  capturedRunId(): string
  release(): void
} {
  const inner = createMemoryKvStore<RunHeader>()
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = deferred<void>()
  let firstFlush = true
  let runId = ''
  return {
    entered: entered.promise,
    capturedRunId: () => runId,
    release,
    kv: {
      ...inner,
      set(key, value) {
        if (runId === '') runId = key
        inner.set(key, value)
      },
      async flush() {
        if (firstFlush) {
          firstFlush = false
          entered.resolve()
          await released
        }
        await inner.flush()
      },
    },
  }
}

async function assertPending(promise: Promise<unknown>, ms: number): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])
  assert.equal(outcome, 'pending', '窗口期内不得提前返回')
}

test('run 注册时序：启动窗口内 wait() 不得假返回，放行 running 快照后才拿真实结果', timeout, async (t) => {
  const gated = makeGatedSnapshotKv()
  const env = makeEnv(t, async () => 'ok', undefined, gated.kv)
  try {
    const runPromise = env.service.run({
      conversationId: 1,
      script: 'export const meta = { name: "wait-gate", description: "test" }\nreturn 42',
    })
    await gated.entered
    const runId = gated.capturedRunId()
    assert.ok(runId !== '')

    const waitPromise = env.service.wait(runId)
    await assertPending(waitPromise, 80)

    gated.release()
    const summary = await runPromise
    assert.equal(summary.status, 'running')
    assert.equal(await waitPromise, 42)
    assert.equal(env.service.getRun(runId).status, 'completed')
  } finally {
    gated.release()
  }
})

test('run 注册时序：启动窗口内 abort() 返回时 run 必已终态', timeout, async (t) => {
  const gated = makeGatedSnapshotKv()
  const env = makeEnv(t, async () => 'ok', undefined, gated.kv)
  try {
    const runPromise = env.service.run({
      conversationId: 1,
      script: 'export const meta = { name: "abort-gate", description: "test" }\nreturn 7',
    })
    await gated.entered
    const runId = gated.capturedRunId()
    assert.ok(runId !== '')

    const abortPromise = env.service.abort(runId)
    await assertPending(abortPromise, 80)

    gated.release()
    await runPromise
    await abortPromise
    const final = env.service.getRun(runId)
    assert.equal(final.status, 'aborted')
  } finally {
    gated.release()
  }
})

test('停机屏障：init 完成后、active.set 前复查 closed，close 与 run 启动并发时越障启动显式拒绝', timeout, async (t) => {
  const env = makeEnv(t, async () => 'ok')
  const runPromise = env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "closed-race", description: "test" }\nreturn 1',
  })
  const rejection = assert.rejects(runPromise, (err: unknown) => {
    assert.ok(err instanceof HelmxError)
    assert.equal(err.code, 'service_closed')
    return true
  })
  await env.service.close()
  await rejection
})

test('emitEvent 收口：宿主适配器 async 抛错时 run 生命周期不受影响且不产生 unhandledRejection', timeout, async (t) => {
  const env = makeEnv(t, async () => 'ok', {
    emitEvent: async () => {
      throw new HelmxError('workflow_index_corrupt', '读取工作流 run 索引失败（模拟）', 500)
    },
  })
  await assertNoUnhandledRejection(async () => {
    const summary = await env.service.run({
      conversationId: 1,
      script: 'export const meta = { name: "emit-safe", description: "test" }\nreturn 5',
    })
    assert.equal(await env.service.wait(summary.id), 5)
    assert.equal(env.service.getRun(summary.id).status, 'completed')
  })
})

test('settledAt 防漂移：终态一次性写入，notifiedAt 与接管绝不覆盖 settledAt', timeout, async (t) => {
  const notifyEntered = deferred()
  const notifyRelease = deferred()
  const env = makeEnv(t, async () => '结果', {
    onBackgroundAgentSettled: async () => {
      notifyEntered.resolve()
      await notifyRelease.promise
    },
  })
  const first = await env.service.run(
    {
      conversationId: 30,
      script: 'export const meta = { name: "settled-anchor", description: "d" }\nreturn await agent("任务")',
    },
    { notifyParentOnSettle: true },
  )
  const firstDone = env.service.wait(first.id)
  await notifyEntered.promise
  const beforeNotify = env.kv.get(first.id)!
  const initialSettledAt = beforeNotify.settledAt
  assert.ok(typeof initialSettledAt === 'number' && initialSettledAt >= first.createdAt)

  await new Promise((resolve) => setTimeout(resolve, 15))
  notifyRelease.resolve()
  await firstDone

  const afterNotify = env.kv.get(first.id)!
  assert.ok(typeof afterNotify.notifiedAt === 'number')
  assert.equal(afterNotify.settledAt, initialSettledAt)

  await new Promise((resolve) => setTimeout(resolve, 15))
  const second = await env.service.run({ resumeFromRunId: first.id })
  await env.service.wait(second.id)

  const summary = env.service.getRun(first.id)
  assert.equal(summary.resumedByRunId, second.id)
  assert.equal(summary.settledAt, initialSettledAt)
})

test('settledAt 覆盖恢复标终态与优雅挂起：suspend 保持 phase=suspended 不写 settledAt，非自动恢复标 failed 写 settledAt', timeout, async (t) => {
  const started = deferred()
  const hang = deferred()
  const suspendEnv = makeEnv(t, (proto: unknown) => {
    const req = proto as { signal?: AbortSignal }
    started.resolve()
    return new Promise((_resolve, reject) => {
      req.signal?.addEventListener('abort', () => reject(new HelmxError('aborted', 'suspend', 409)), { once: true })
      void hang.promise
    })
  })
  const running = await suspendEnv.service.run({
    conversationId: 31,
    script: 'export const meta = { name: "suspend-no-settle", description: "d" }\nreturn await agent("挂起")',
  })
  await started.promise
  await suspendEnv.service.suspend()
  const suspendedHeader = suspendEnv.kv.get(running.id)!
  assert.equal(suspendedHeader.status, 'running')
  assert.equal(suspendedHeader.phase, 'suspended')
  assert.equal(suspendedHeader.settledAt, undefined)

  const revived = new WorkflowService({
    dataDir: suspendEnv.dataDir,
    kv: suspendEnv.kv,
    autoRecoverOnRestart: false,
    host: {
      spawnAgent: async () => 'unused',
      invokeAction: async () => ({}),
      listActions: () => [],
      getConversation: (id: number) => makeParentSummary(id, suspendEnv.dataDir),
      abortConversationGuarded: async () => {},
      emitEvent: () => {},
    },
  })
  t.after(async () => {
    await revived.close()
  }, { timeout: 60_000 })
  await revived.init()
  const recoveredSummary = revived.getRun(running.id)
  assert.equal(recoveredSummary.status, 'failed')
  assert.ok(typeof recoveredSummary.settledAt === 'number' && recoveredSummary.settledAt >= running.createdAt)
  assert.equal(suspendEnv.kv.get(running.id)!.settledAt, recoveredSummary.settledAt)
})

test('停机结算排空：active 已移除但 onRunSettled 仍在途时，suspend/close/wait 必须等结算彻底完成才返回', timeout, async (t) => {
  const settledEntered = deferred()
  const settledRelease = deferred()
  let settledDone = false
  const env = makeEnv(t, async () => 'ok', {
    onRunSettled: async () => {
      // 确认 onRunSettled 触发时该 run 已离开 active（不影响 otherRunningTasks 口径）
      assert.equal(env.service.listActiveRuns().length, 0)
      settledEntered.resolve()
      await settledRelease.promise
      settledDone = true
    },
  })

  const started = await env.service.run({
    conversationId: 32,
    script: 'export const meta = { name: "drain-settling", description: "d" }\nreturn 99',
  })
  await settledEntered.promise

  const waitPromise = env.service.wait(started.id)
  const suspendPromise = env.service.suspend()
  await assertPending(waitPromise, 60)
  await assertPending(suspendPromise, 60)

  settledRelease.resolve()
  await Promise.all([waitPromise, suspendPromise])
  assert.equal(settledDone, true)
  assert.equal(await waitPromise, 99)
})

test('onRunSettled 失败先脱敏再写入 process.stderr.write，绝不向 stderr 泄漏原始秘钥', timeout, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helmx-wf-stderr-redact-'))
  const stderrChunks: string[] = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write

  const svc = new WorkflowService({
    dataDir: dir,
    redact: (text) => text.replaceAll('SUPER_SECRET_TOKEN', '[REDACTED]'),
    host: {
      spawnAgent: async () => 'ok',
      invokeAction: async () => ({}),
      listActions: () => [],
      getConversation: (id: number) => makeParentSummary(id, dir),
      abortConversationGuarded: async () => {},
      emitEvent: () => {},
      onRunSettled: async () => {
        throw new Error('sink failed with SUPER_SECRET_TOKEN')
      },
    },
  })
  t.after(async () => {
    process.stderr.write = origWrite
    await svc.close()
    rmSync(dir, { recursive: true, force: true })
  }, { timeout: 60_000 })

  const started = await svc.run({
    conversationId: 77,
    script: 'export const meta = { name: "stderr-redact", description: "d" }\nreturn 1',
  })
  await assert.rejects(() => svc.wait(started.id), /SUPER_SECRET_TOKEN/)

  const stderrCombined = stderrChunks.join('')
  assert.equal(stderrCombined.includes('SUPER_SECRET_TOKEN'), false, 'raw secret must not hit stderr')
  assert.match(stderrCombined, /\[REDACTED\]/)
  const finalSummary = svc.getRun(started.id)
  assert.equal(finalSummary.error?.includes('SUPER_SECRET_TOKEN'), false)
  assert.match(finalSummary.error ?? '', /\[REDACTED\]/)
})
