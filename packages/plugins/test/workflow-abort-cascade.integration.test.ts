/**
 * 工作流级联取消端到端集成验收（真实 KernelRuntime + faux provider）。
 *
 * 覆盖（全部真实链路，绝不 mock WorkflowService / spawnAgent）：
 * - 父会话 abort（turn aborted）→ builtin:workflow turn_settled 钩子级联取消
 *   该会话子树内属于它的后台 run；受管（helmx-owned）子会话经内核
 *   abortConversationGuarded 原子复核被中止；
 * - human 红线（真实内核）：ownership 翻转 human 的后代在「后台 run 取消」
 *   与「同步 spawn 信号桥」两条真实路径上均不被中止；
 * - 取消后不复活：级联边界内的下级父会话不再被 submitInput 汇报唤醒
 *   （无新 helmx.input 回合）；边界外拥有者照常收到单次结算汇报；
 * - 深层投影：多级子树的 run 聚合进祖先分片（原始归属保留）、角标聚合。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helmx/protocol'
import type { KernelRuntime } from '@helmx/kernel'
import type { WorkflowRunSummary } from '../src/contracts.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { makeFauxProvider, openMinimalRuntime, type FauxProviderHandle } from './helpers/plugin-test-env.js'

interface TurnSettledRecord {
  conversationId: number
  outcome: string
}

interface Env {
  kernel: KernelRuntime
  faux: FauxProviderHandle
  settled: TurnSettledRecord[]
  /** 父会话响应队列（router 动态 shift）。 */
  parentQueue: AssistantMessage[]
  onEmpty: 'hang' | 'end'
  /** 挂起中的模型调用句柄（close 前释放，避免 faux 流悬挂阻塞关停）。 */
  hangs: Array<() => void>
  close(): Promise<void>
}

async function makeSharedEnv(): Promise<Env> {
  const faux = makeFauxProvider()
  const { kernel, close } = await openMinimalRuntime(
    [createWorkflowPlugin()],
    { prefix: 'helmx-wf-cascade-e2e-', model: 'faux/faux-1', providers: [faux.provider] },
  )
  const settled: TurnSettledRecord[] = []
  // turn.settled 发布在内核事件总线（非宿主内部事件）：经 events.subscribe 观察。
  kernel.events.subscribe((frame) => {
    const event = frame.event as { type?: string; payload?: { conversation?: { id: number }; outcome?: string } }
    if (event.type === 'turn.settled' && event.payload?.conversation !== undefined) {
      settled.push({ conversationId: event.payload.conversation.id, outcome: event.payload.outcome ?? '' })
    }
  })
  const parentQueue: AssistantMessage[] = []
  const hangs: Array<() => void> = []
  const env: Env = {
    kernel,
    faux,
    settled,
    parentQueue,
    onEmpty: 'hang',
    hangs,
    async close() {
      // 先释放全部挂起的模型调用（否则 faux 流的未决 promise 会阻塞关停）。
      for (const release of hangs.splice(0)) release()
      await new Promise((r) => setTimeout(r, 20))
      await close()
    },
  }
  return env
}

function resetCase(env: Env, onEmpty: 'hang' | 'end'): void {
  for (const release of env.hangs.splice(0)) release()
  env.parentQueue.length = 0
  env.settled.length = 0
  env.onEmpty = onEmpty
  const router = (
    context: { messages: Array<{ role: string; content: unknown }> },
    options?: { signal?: AbortSignal },
  ) => {
    const users = context.messages.filter((m) => m.role === 'user')
    const last = users[users.length - 1]
    const text = JSON.stringify(last?.content ?? '')
    const hang = (): Promise<AssistantMessage> =>
      new Promise<AssistantMessage>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('faux hang aborted by signal'))
        if (options?.signal?.aborted) {
          onAbort()
          return
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })
        env.hangs.push(() => {
          options?.signal?.removeEventListener('abort', onAbort)
          resolve(fauxAssistantMessage('hang-released'))
        })
      })
    if (text.includes('HANG-CHILD')) {
      return hang()
    }
    const next = env.parentQueue.shift()
    if (next !== undefined) return next
    if (env.onEmpty === 'end') return fauxAssistantMessage('end')
    return hang()
  }
  env.faux.setResponses(Array.from({ length: 200 }, () => router))
}

let sharedEnv!: Env

before(async () => {
  sharedEnv = await makeSharedEnv()
})

after(async () => {
  await sharedEnv?.close()
}, { timeout: 60_000 })

/** 轮询直到异步谓词为真（确定性等待，不 sleep 固定时长）。 */
async function until(predicate: () => Promise<boolean> | boolean, what: string, maxMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function listRuns(env: Env): Promise<WorkflowRunSummary[]> {
  return ((await env.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: WorkflowRunSummary[] }).runs
}

/** 读 runs 会话分片（公共 sessionDoc）。 */
function readShard(env: Env, conversationId: number): WorkflowRunSummary[] {
  const doc = env.kernel.plugins.getPublicSessionDoc('builtin:workflow', 'runs', conversationId)
  return ((doc.value as { runs?: WorkflowRunSummary[] }).runs ?? [])
}

/** 读全局角标文档（紧凑导航元数据）。 */
function readBadges(env: Env): Record<string, { count: number }> {
  const doc = env.kernel.plugins.getPublicDoc('builtin:workflow', 'run-badges')
  return ((doc.value as { byConversation?: Record<string, { count: number }> }).byConversation ?? {})
}

async function inputEntries(env: Env, conversationId: number): Promise<Array<{ kind: string; text?: string }>> {
  const detail = await env.kernel.conversations.getConversationDetail(conversationId, { limit: 200 })
  return detail.entries.map((e) => ({ kind: e.kind, ...(e.data !== undefined ? { text: String((e.data as { text?: string }).text ?? '') } : {}) }))
}

function childConversations(conversations: ConversationSummary[], parent: number): ConversationSummary[] {
  return conversations.filter((c) => c.parentConversationId === parent)
}

test('父会话 abort 级联：子树后台 run 取消、受管子会话被中止、取消后不复活、投影聚合', { timeout: 60_000 }, async () => {
  const env = sharedEnv
  resetCase(env, 'hang')
  const rootId = (await env.kernel.conversations.createConversation({ title: 'cascade-root-1' })).id
  env.parentQueue.push(
    fauxAssistantMessage(
      [fauxToolCall('subagent', { prompt: 'HANG-CHILD 后台任务', background: true }, { id: 'call-bg-cascade' })],
      { stopReason: 'toolUse' },
    ),
  )
  await env.kernel.conversations.submitInput(rootId, '派一个后台子代理')

  let bgRun: WorkflowRunSummary | undefined
  let child: ConversationSummary | undefined
  await until(async () => {
    bgRun = (await listRuns(env)).find((r) => r.kind === 'subagent' && r.conversationId === rootId)
    child = childConversations(env.kernel.conversations.listConversations(), rootId)[0]
    return bgRun !== undefined && child !== undefined
  }, '后台 run 与子会话出现')
  const childId = child!.id
  const runId = bgRun!.id

  // 父回合仍在途（下一轮模型调用挂起）：中止父会话 → turn aborted → 级联。
  await env.kernel.conversations.abortConversation(rootId)
  await until(async () => {
    const run = (await listRuns(env)).find((r) => r.id === runId)
    return run !== undefined && run.status === 'aborted'
  }, '后台 run 级联取消至 aborted')
  await until(
    () => env.settled.some((s) => s.conversationId === childId && s.outcome === 'aborted'),
    '受管（helmx-owned）子会话经守卫中止后回合 aborted',
  )
  await env.kernel.conversations.waitForIdle(rootId).catch(() => {})

  // 不复活：无 agent report 重新唤醒父会话（无新 helmx.input、水位稳定）。
  const inputsBefore = (await inputEntries(env, rootId)).filter((e) => e.kind === 'helmx.input').length
  const seqBefore = env.kernel.conversations.getConversation(rootId).completionSeq
  await new Promise((r) => setTimeout(r, 80))
  const inputsAfter = (await inputEntries(env, rootId)).filter((e) => e.kind === 'helmx.input').length
  assert.equal(inputsAfter, inputsBefore, '取消边界内的结算汇报不得重新投递输入（防复活）')
  assert.equal(inputsBefore, 1, '父会话只有最初一条输入（后台 run 的 aborted 汇报被跳过）')
  assert.equal(env.kernel.conversations.getConversation(rootId).completionSeq, seqBefore, '取消后无新回合')
  assert.equal(
    env.settled.some((s) => s.conversationId === rootId && s.outcome === 'aborted'),
    true,
    '父会话回合 aborted（级联由 turn_settled 触发）',
  )

  // 投影：aborted run 仍在根会话分片（结果可查）。
  assert.equal(readShard(env, rootId).some((r) => r.id === runId && r.status === 'aborted'), true, '根分片含 aborted run（供 UI 查询）')
  assert.equal(readBadges(env)[String(rootId)]?.count, 1, '角标聚合根会话子树 run')
})

test('human 红线（后台路径）：归属翻转 human 的子会话在 run 取消后不被中止', { timeout: 60_000 }, async () => {
  const env = sharedEnv
  resetCase(env, 'end')
  const rootId = (await env.kernel.conversations.createConversation({ title: 'cascade-root-2' })).id
  env.parentQueue.push(
    fauxAssistantMessage(
      [fauxToolCall('subagent', { prompt: 'HANG-CHILD 受保护任务', background: true }, { id: 'call-bg-human' })],
      { stopReason: 'toolUse' },
    ),
  )
  await env.kernel.conversations.submitInput(rootId, '派一个后台子代理')
  await env.kernel.conversations.waitForIdle(rootId)

  let runId: string | undefined
  let childId: number | undefined
  await until(async () => {
    const run = (await listRuns(env)).find((r) => r.kind === 'subagent' && r.conversationId === rootId)
    const child = childConversations(env.kernel.conversations.listConversations(), rootId)[0]
    runId = run?.id
    childId = child?.id
    return runId !== undefined && childId !== undefined
  }, '后台 run 与子会话出现')

  // 人类接管子会话：后续一切自动化取消不得触碰（内核红线）。
  env.kernel.ownership.markOwnership(childId!, 'human')
  const result = (await env.kernel.plugins.invokeAction('builtin:workflow', 'abort', { runId: runId! })) as { run: WorkflowRunSummary }
  assert.equal(result.run.status, 'aborted', 'run 确定结算 aborted（不等待被保护子会话）')

  await new Promise((r) => setTimeout(r, 80))
  const childNow = env.kernel.conversations.getConversation(childId!)
  assert.equal(childNow.status, 'working', `human 子会话仍在运行（实际 ${childNow.status}；守卫端口与信号桥两条路径都必须拒绝）`)
  assert.equal(
    env.settled.some((s) => s.conversationId === childId!),
    false,
    'human 子会话没有任何回合被自动化中止',
  )
  // 收尾：人类路径显式中止挂起的子会话，避免 close 等待。
  await env.kernel.conversations.abortConversation(childId!)
  await env.kernel.conversations.waitForIdle(childId!).catch(() => {})
})

test('human 红线（同步信号桥）：父会话 abort 不杀 human 子会话，helmx 子会话照常中止', { timeout: 60_000 }, async () => {
  const env = sharedEnv
  resetCase(env, 'hang')
  const rootId = (await env.kernel.conversations.createConversation({ title: 'cascade-root-3' })).id
  // 第一轮：同步 subagent（工具阻塞等子会话）；子会话转 human 后中止父会话。
  env.parentQueue.push(
    fauxAssistantMessage(
      [fauxToolCall('subagent', { prompt: 'HANG-CHILD 同步任务一', background: false }, { id: 'call-sync-human' })],
      { stopReason: 'toolUse' },
    ),
  )
  await env.kernel.conversations.submitInput(rootId, '第一轮同步任务')
  let childA: number | undefined
  await until(() => {
    childA = childConversations(env.kernel.conversations.listConversations(), rootId)[0]?.id
    return childA !== undefined
  }, '同步子会话 A 出现')
  env.kernel.ownership.markOwnership(childA!, 'human')
  await env.kernel.conversations.abortConversation(rootId)
  await env.kernel.conversations.waitForIdle(rootId).catch(() => {})
  await until(
    () => env.settled.some((s) => s.conversationId === rootId && s.outcome === 'aborted'),
    '父会话回合 aborted',
  )
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(env.kernel.conversations.getConversation(childA!).status, 'working', 'human 子会话不被信号桥中止（真实内核守卫）')

  // 第二轮（对照）：helmx-owned 同步子会话 → 父 abort 后子会话被守卫中止。
  env.parentQueue.push(
    fauxAssistantMessage(
      [fauxToolCall('subagent', { prompt: 'HANG-CHILD 同步任务二', background: false }, { id: 'call-sync-helmx' })],
      { stopReason: 'toolUse' },
    ),
  )
  await env.kernel.conversations.submitInput(rootId, '第二轮同步任务')
  let childB: number | undefined
  await until(() => {
    childB = childConversations(env.kernel.conversations.listConversations(), rootId).map((c) => c.id).find((id) => id !== childA)
    return childB !== undefined
  }, '同步子会话 B 出现')
  await env.kernel.conversations.abortConversation(rootId)
  await until(
    () => env.settled.some((s) => s.conversationId === childB! && s.outcome === 'aborted'),
    'helmx-owned 子会话经守卫中止',
  )
  assert.equal(env.kernel.conversations.getConversation(childB!).status !== 'working', true, 'helmx 子会话已停止')

  // 收尾挂起的 human 子会话。
  await env.kernel.conversations.abortConversation(childA!)
  await env.kernel.conversations.waitForIdle(childA!).catch(() => {})
})

test('多级后台：中段会话 abort 级联取消其子树 run，深层 runs/badges 投影，下级父会话不复活', { timeout: 60_000 }, async () => {
  const env = sharedEnv
  resetCase(env, 'end')
  const rootId = (await env.kernel.conversations.createConversation({ title: 'cascade-root-4' })).id
  // 一级：rootId 派后台子代理（子会话 D 的模型调用挂起，保持后台 run 在途）。
  env.parentQueue.push(
    fauxAssistantMessage(
      [fauxToolCall('subagent', { prompt: 'HANG-CHILD 一级后台', background: true, maxSubagentDepth: 2 }, { id: 'call-bg-l1' })],
      { stopReason: 'toolUse' },
    ),
  )
  await env.kernel.conversations.submitInput(rootId, '派一级后台')
  let level1Run: WorkflowRunSummary | undefined
  let childD: number | undefined
  await until(async () => {
    level1Run = (await listRuns(env)).find((r) => r.kind === 'subagent' && r.conversationId === rootId)
    childD = childConversations(env.kernel.conversations.listConversations(), rootId)[0]?.id
    return level1Run !== undefined && childD !== undefined
  }, '一级后台 run 与子会话 D 出现')
  await env.kernel.conversations.waitForIdle(rootId)

  // 二级：在 D 下启动真实工作流 run（其 agent 子会话挂起，保持 running）。
  const script = 'export const meta = { name: "level2", description: "t" }\nconst a = await agent("HANG-CHILD 二级代理", { label: "a" }); return a'
  const level2 = (await env.kernel.plugins.invokeAction('builtin:workflow', 'run', { conversationId: childD!, script })) as { run: WorkflowRunSummary }
  let childD2: number | undefined
  await until(async () => {
    childD2 = childConversations(env.kernel.conversations.listConversations(), childD!).map((c) => c.id)[0]
    return childD2 !== undefined && (await listRuns(env)).some((r) => r.id === level2.run.id && r.status === 'running')
  }, '二级 run 与孙会话 D2 出现')

  // 深层投影（取消前）：根分片聚合两级 run（原始归属保留）；角标一级口径
  //（根只计自己发起的一级 run，二级 run 归 D 的角标）。
  const shardRootBefore = readShard(env, rootId)
  assert.equal(shardRootBefore.some((r) => r.id === level1Run!.id), true, '根分片含一级 run')
  const projectedL2 = shardRootBefore.find((r) => r.id === level2.run.id)
  assert.ok(projectedL2, '根分片聚合二级 run（深层投影）')
  assert.equal(projectedL2!.conversationId, childD!, '二级 run 保留原始归属（D，不改写为根）')
  const badgesBefore = readBadges(env)
  assert.equal(badgesBefore[String(rootId)]?.count, 1, '根角标一级口径：只计自己直接发起的 run')
  assert.equal(badgesBefore[String(childD!)]?.count, 1, 'D 角标只计自己发起的 run')

  // 中止 D（其回合在途挂起）→ turn aborted → 级联取消 D 子树内的二级 run；
  // 一级 run（发起者是 rootId，不在 D 子树内）不被该边界取消。
  const inputsDBefore = (await inputEntries(env, childD!)).filter((e) => e.kind === 'helmx.input').length
  await env.kernel.conversations.abortConversation(childD!)
  await until(async () => {
    const run = (await listRuns(env)).find((r) => r.id === level2.run.id)
    return run !== undefined && run.status === 'aborted'
  }, '二级 run 级联取消至 aborted')
  await until(
    () => env.settled.some((s) => s.conversationId === childD2! && s.outcome === 'aborted'),
    '孙会话 D2（helmx-owned）经守卫中止',
  )

  // 下级父会话不复活：D 不因二级 run 的取消被重新投递汇报输入。
  await new Promise((r) => setTimeout(r, 80))
  const inputsDAfter = (await inputEntries(env, childD!)).filter((e) => e.kind === 'helmx.input').length
  assert.equal(inputsDAfter, inputsDBefore, '取消边界内的下级父会话无新汇报输入（防复活）')

  // 投影（取消后）：两级 run 终态仍在根分片；D 分片含自己的 run。
  assert.equal(readShard(env, rootId).find((r) => r.id === level2.run.id)?.status, 'aborted', '根分片仍聚合二级 run 终态')
  assert.equal(readShard(env, childD!).some((r) => r.id === level2.run.id), true, 'D 分片含自己发起的 run')
})
