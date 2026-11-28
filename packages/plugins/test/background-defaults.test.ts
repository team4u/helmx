/**
 * subagent / SubagentWorkflow 工具 background 缺省策略端到端测试
 * （真实 createHelmx + faux provider + 真内核 + 真引擎）。
 *
 * 缺省语义（以内核权威归属 getConversationOwnership 判定，不按 profileId/
 * runtime 角色枚举）：
 * - 人类交互会话（未标记归属 = human）缺省 background=true：工具在执行环境
 *   就绪 / durable running 快照落盘后立即返回（runId + running），后台完成后
 *   向父会话幂等 steer 汇报（origin=agent、meta.backgroundRunId、
 *   requestId helmx:<kind>-report:<runId>）；父回合结束不误杀后台任务；
 * - 自动化会话（归属 helmx/bot，如受管子代理、驻留 Worker）缺省同步等待最终
 *   结果；显式 background=true 被显式拒绝（subagent_failed / workflow_failed
 *   + 归属事实），不派生、不建 run，绝不静默改写为同步；
 * - 显式 background:false 在人类交互会话保留同步路径。
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowPlugin } from '../src/workflow.js'
import { openMinimalRuntime } from './helpers/plugin-test-env.js'

type MinimalEnv = Awaited<ReturnType<typeof openMinimalRuntime>>
type Kernel = MinimalEnv['kernel']

/** 工具结果 entry 文本（pi.tool-result 的 model[0].content 文本块拼接）。 */
function toolResultText(detail: { entries: Array<{ kind: string; model?: unknown[] }> }, toolName: string): string {
  const entry = [...detail.entries]
    .reverse()
    .find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === toolName)
  assert.ok(entry, `应存在 ${toolName} 的 pi.tool-result entry`)
  const message = entry.model?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined
  return (message?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function toolNameOf(model: unknown[] | undefined): string | undefined {
  const message = model?.[0] as { toolName?: string } | undefined
  return message?.toolName
}

/** 会话的后台汇报 helmx.input（origin=agent 且带 meta.backgroundRunId）。 */
async function backgroundReports(
  kernel: Kernel,
  conversationId: number,
): Promise<Array<{ id: unknown; origin: unknown; kind: unknown; backgroundRunId?: string; renderer?: unknown; text?: string }>> {
  const detail = await kernel.conversations.getConversationDetail(conversationId, { limit: 500 })
  const out: Array<{ id: unknown; origin: unknown; kind: unknown; backgroundRunId?: string; renderer?: unknown; text?: string }> = []
  for (const entry of detail.entries) {
    if (entry.kind !== 'helmx.input') continue
    const data = entry.data as
      | { id?: unknown; origin?: unknown; text?: unknown; meta?: { backgroundRunId?: unknown; kind?: unknown; renderer?: unknown } }
      | undefined
    if (data?.meta?.backgroundRunId === undefined) continue
    out.push({
      id: data.id,
      origin: data.origin,
      kind: data.meta.kind,
      backgroundRunId: String(data.meta.backgroundRunId),
      renderer: data.meta.renderer,
      ...(typeof data.text === 'string' ? { text: data.text } : {}),
    })
  }
  return out
}

async function runsOf(kernel: Kernel, conversationId: number): Promise<Array<{ id: string; kind?: string; status: string }>> {
  const { runs } = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', {
    conversationId,
  })) as { runs: Array<{ id: string; kind?: string; status: string }> }
  return runs
}

/** 轮询直到异步谓词为真（确定性等待，不 sleep 固定时长）。 */
async function until(predicate: () => Promise<boolean> | boolean, what: string, maxMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > maxMs) throw new Error(`等待超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

let rootDir: string
let sharedEnv: MinimalEnv

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-bg-defaults-'))
  sharedEnv = await openMinimalRuntime([createWorkflowPlugin()], {
    dataDir: join(rootDir, 'shared'),
  })
}, { timeout: 60_000 })

after(async () => {
  await sharedEnv?.close().catch(() => {})
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

describe('subagent 工具 background 缺省（权威 ownership 判定）', { timeout: 60_000 }, () => {
  it('人类交互会话缺省后台：立即返回 runId/running；后台完成后父会话恰收一次 subagent_report 汇报', { timeout: 60_000 }, async () => {
    const conv = await sharedEnv.kernel.conversations.createConversation({ title: 'bg1' })
    const cid = conv.id
    sharedEnv.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: '人类后台任务' })], { stopReason: 'toolUse' }),
      ...Array.from({ length: 5 }, () => fauxAssistantMessage('良性回答')),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '派一个后台子代理')
    await sharedEnv.kernel.conversations.waitForIdle(cid)

    const detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const text = toolResultText(detail, 'subagent')
    const runId = /"runId":"(wf_[0-9a-zA-Z_-]+)"/.exec(text)?.[1]
    assert.ok(runId, `工具输出应含 runId：${text.slice(0, 300)}`)
    assert.ok(text.includes('"background":true'), `缺省后台应回报 background:true：${text.slice(0, 300)}`)
    assert.ok(text.includes('"status":"running"'), `返回时应为 running 快照：${text.slice(0, 300)}`)

    await until(async () => (await runsOf(sharedEnv.kernel, cid)).find((r) => r.id === runId)?.status !== 'running', '后台 run 到达终态')
    const final = (await runsOf(sharedEnv.kernel, cid)).find((r) => r.id === runId)!
    assert.equal(final.kind, 'subagent')
    assert.equal(final.status, 'completed')

    await until(async () => (await backgroundReports(sharedEnv.kernel, cid)).some((r) => r.backgroundRunId === runId), 'subagent_report 汇报到达')
    const reports = (await backgroundReports(sharedEnv.kernel, cid)).filter((r) => r.backgroundRunId === runId)
    assert.equal(reports.length, 1, '后台子代理结算汇报恰一次')
    assert.equal(reports[0]!.id, `helmx:subagent-report:${runId}`)
    assert.equal(reports[0]!.origin, 'agent')
    assert.equal(reports[0]!.kind, 'subagent_report')
    assert.equal(reports[0]!.renderer, 'workflow:background-report')
    const reportJson = JSON.parse(reports[0]!.text!.slice(reports[0]!.text!.indexOf('\n') + 1)) as { name?: string }
    assert.equal(reportJson.name, '人类后台任务')
    const rendererSpec = sharedEnv.kernel.plugins
      .listUi()
      .find((u) => u.pluginId === 'builtin:workflow' && u.surface === 'timeline.renderer')?.spec as
      | { kinds?: string[]; matchMeta?: { renderer?: string }; client?: { module: string; export: string } }
      | undefined
    assert.ok(rendererSpec, 'builtin:workflow 应注册 timeline.renderer')
    assert.deepEqual(rendererSpec!.kinds, ['helmx.input'])
    assert.equal(rendererSpec!.matchMeta?.renderer, 'workflow:background-report')
    assert.equal(rendererSpec!.client?.export, 'BackgroundReportCard')
    await sharedEnv.kernel.conversations.waitForIdle(cid).catch(() => {})
  })

  it('人类交互会话显式 background:false：同步直调 spawnAgent 携带业务结果，不创建 WorkflowRun', { timeout: 60_000 }, async () => {
    const conv = await sharedEnv.kernel.conversations.createConversation({ title: 'bg2' })
    const cid = conv.id
    sharedEnv.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: '同步任务', background: false })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('同步子代理回答'),
      fauxAssistantMessage('主回合完成'),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '派一个同步子代理')
    await sharedEnv.kernel.conversations.waitForIdle(cid)

    const detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const text = toolResultText(detail, 'subagent')
    assert.ok(text.includes('同步子代理回答'), `同步路径应直接携带业务结果：${text.slice(0, 300)}`)
    assert.ok(!text.includes('"background":true'), '同步路径不得回报后台句柄')
    const runs = await runsOf(sharedEnv.kernel, cid)
    assert.equal(runs.length, 0, '同步 subagent 不得创建 WorkflowRun 记录')
    assert.equal((await backgroundReports(sharedEnv.kernel, cid)).length, 0, '同步 subagent 不得投递结算汇报')
    assert.ok(sharedEnv.kernel.conversations.listConversations().some((c) => c.parentConversationId === cid), '同步派生应创建子会话')
  })

  it('helmx-owned 会话缺省同步；显式 background:true 显式拒绝（不派生、不建 run、不静默改写）', { timeout: 60_000 }, async () => {
    const conv = await sharedEnv.kernel.conversations.createConversation({ title: 'bg3' })
    const cid = conv.id
    sharedEnv.kernel.ownership.markOwnership(cid, 'helmx')

    sharedEnv.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: '自动化同步任务' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('自动化子代理回答'),
      fauxAssistantMessage('自动化回合完成'),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '派一个同步子代理')
    await sharedEnv.kernel.conversations.waitForIdle(cid)
    let detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    let text = toolResultText(detail, 'subagent')
    assert.ok(text.includes('自动化子代理回答'), `自动化会话缺省应同步等待：${text.slice(0, 300)}`)
    assert.ok(!text.includes('"background":true'))
    assert.equal((await runsOf(sharedEnv.kernel, cid)).length, 0, '同步 subagent 不创建 WorkflowRun')
    const syncChild = sharedEnv.kernel.conversations.listConversations().find((c) => c.parentConversationId === cid)
    assert.ok(syncChild, '同步派生应创建子会话')

    sharedEnv.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: '被拒的后台任务', background: true })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('被拒后续答'),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '再派一个后台子代理')
    await sharedEnv.kernel.conversations.waitForIdle(cid)
    detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    text = toolResultText(detail, 'subagent')
    assert.ok(
      text.includes('subagent_failed') && text.includes('background') && text.includes('helmx'),
      `拒绝信息应显式指出 background=true 不被允许并携带归属事实：${text.slice(0, 300)}`,
    )
    assert.equal((await runsOf(sharedEnv.kernel, cid)).length, 0, '被拒调用不得新增 run 记录')
    assert.equal(
      sharedEnv.kernel.conversations.listConversations().filter((c) => c.parentConversationId === cid).length,
      1,
      '被拒调用不得再派生子会话（仅剩同步路径那一个）',
    )
    assert.equal((await backgroundReports(sharedEnv.kernel, cid)).length, 0, '被拒调用不产生任何汇报')
  })
})

describe('SubagentWorkflow 工具 background 缺省', { timeout: 60_000 }, () => {
  const AGENT_SCRIPT =
    'export const meta = { name: "bg-default-wf", description: "t" }\nconst a = await agent("工作流子任务"); return { done: a }'

  it('人类交互会话缺省后台：立即返回 background:true + running summary；结算后父会话恰收一次 workflow_report', { timeout: 60_000 }, async () => {
    const conv = await sharedEnv.kernel.conversations.createConversation({ title: 'wfbg1' })
    const cid = conv.id
    sharedEnv.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('SubagentWorkflow', { script: AGENT_SCRIPT })],
        { stopReason: 'toolUse' },
      ),
      ...Array.from({ length: 5 }, () => fauxAssistantMessage('良性回答')),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '跑一个后台工作流')
    await sharedEnv.kernel.conversations.waitForIdle(cid)

    const detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const text = toolResultText(detail, 'SubagentWorkflow')
    const runId = /"id":"(wf_[0-9a-zA-Z_-]+)"/.exec(text)?.[1]
    assert.ok(runId, `工具输出应含运行 id：${text.slice(0, 300)}`)
    assert.ok(text.includes('"background":true'), `缺省后台应回报 background:true：${text.slice(0, 300)}`)
    assert.ok(text.includes('"status":"running"'), `返回时应为 running 快照：${text.slice(0, 300)}`)

    await until(async () => (await runsOf(sharedEnv.kernel, cid)).find((r) => r.id === runId)?.status !== 'running', '后台工作流到达终态')
    const final = (await runsOf(sharedEnv.kernel, cid)).find((r) => r.id === runId)!
    assert.equal(final.kind, 'workflow')
    assert.equal(final.status, 'completed')

    await until(async () => (await backgroundReports(sharedEnv.kernel, cid)).some((r) => r.backgroundRunId === runId), 'workflow_report 汇报到达')
    const reports = (await backgroundReports(sharedEnv.kernel, cid)).filter((r) => r.backgroundRunId === runId)
    assert.equal(reports.length, 1, '后台工作流结算汇报恰一次')
    assert.equal(reports[0]!.id, `helmx:workflow-report:${runId}`)
    assert.equal(reports[0]!.origin, 'agent')
    assert.equal(reports[0]!.kind, 'workflow_report')
    assert.equal(reports[0]!.renderer, 'workflow:background-report')
    const wfReportJson = JSON.parse(reports[0]!.text!.slice(reports[0]!.text!.indexOf('\n') + 1)) as { name?: string }
    assert.equal(wfReportJson.name, 'bg-default-wf')
    await sharedEnv.kernel.conversations.waitForIdle(cid).catch(() => {})
  })

  it('helmx-owned 会话缺省同步：等待终态返回 summary（status completed + result）；显式 background:true 显式拒绝', { timeout: 60_000 }, async () => {
    const conv = await sharedEnv.kernel.conversations.createConversation({ title: 'wfbg2' })
    const cid = conv.id
    sharedEnv.kernel.ownership.markOwnership(cid, 'helmx')
    const fastScript = 'export const meta = { name: "sync-default-wf", description: "t" }\nreturn 7'

    sharedEnv.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('SubagentWorkflow', { script: fastScript })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('自动化工作流回合完成'),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '跑一个同步工作流')
    await sharedEnv.kernel.conversations.waitForIdle(cid)
    let detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    let text = toolResultText(detail, 'SubagentWorkflow')
    assert.ok(text.includes('"status":"completed"'), `自动化会话缺省应同步等待终态：${text.slice(0, 300)}`)
    assert.ok(text.includes('"result":7'), '同步路径应携带终态 result')
    assert.ok(!text.includes('"background":true'), '同步路径不得回报后台句柄')
    assert.equal((await runsOf(sharedEnv.kernel, cid)).length, 1)

    sharedEnv.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('SubagentWorkflow', { script: fastScript, background: true })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('被拒续答'),
    ])
    await sharedEnv.kernel.conversations.submitInput(cid, '再跑一个后台工作流')
    await sharedEnv.kernel.conversations.waitForIdle(cid)
    detail = await sharedEnv.kernel.conversations.getConversationDetail(cid, { limit: 50 })
    text = toolResultText(detail, 'SubagentWorkflow')
    assert.ok(
      text.includes('workflow_failed') && text.includes('background') && text.includes('helmx'),
      `拒绝信息应显式指出 background=true 不被允许并携带归属事实：${text.slice(0, 300)}`,
    )
    assert.equal((await runsOf(sharedEnv.kernel, cid)).length, 1, '被拒调用不得创建新 run（仅剩同步那次）')
    assert.equal((await backgroundReports(sharedEnv.kernel, cid)).length, 0, '被拒调用不产生任何汇报')
  })
})
