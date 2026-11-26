/**
 * subagent / SubagentWorkflow 工具入参完整性与 buildSpawnEnv 回归。
 *
 * 覆盖：
 * - subagent 声明（before_turn tools 载荷：agentType/cwd/isolation/resume/
 *   model/effort 均进 inputSchema）与真实 faux 工具调用全链——各值原样进入
 *   agent_spawn hook，原生 spawn 真子会话执行，工具输出独立回报执行元数据
 *   （conversationId 等续接标识，不混入业务 result）；
 * - resume 续接标识贯通（第二次调用 resume=<conversationId>，钩子载荷与
 *   输出尾行均可见，且续接原会话不新建）；
 * - 不合法 isolation 被 SDK 参数校验显式拒绝（invalid_arguments），钩子
 *   绝不触发——不静默丢字段降级执行；
 * - agent_spawn handled 外部后端：onResolved 回传 executionId/effectiveCwd/
 *   worktree，工具 structuredOutput.execution 与文本尾行独立回报；
 * - SubagentWorkflow：script + args（任意 JSON 对象原样到达真实引擎，绝不
 *   String 化）、scriptPath、resumeFromRunId 断点恢复经真实 WorkflowService；
 * - KernelRuntime.buildSpawnEnv / buildManagedEnv：仅会话 stash + 受管五变量
 *   + 受管 token（覆盖 stash 同名伪造），绝不携带 process.env（PATH/HOME/
 *   自定义 spy 键均不外泄）；无受管 token 时不透传任何 HELMX_TOKEN；秘密与
 *   受管 token 均在 stash 脱敏登记内（日志/模型上下文只见 [REDACTED]）。
 * - runGate/runShell options.env：本机 Gate 与实际 Herdr 任务同环境
 *   （process.env < options.env < 受管变量三级合并；HELMX 固定值与受管
 *   token 不被注入劫持；无受管 token 时剥除一切来源的 HELMX_TOKEN）。
 *
 * 诚实性纪律：模型输出全部来自 faux 脚本；spawn/workflow/HTTP 层为真实执行
 * （真子会话、真 worker 线程、真 journal），绝不 mock 引擎或伪造完成结果。
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { AgentSpawnRequest, HelmxPluginContext, JsonSchema, PluginToolSpec } from '@helmx/protocol'
import { HelmxError, NODE_ID_PATTERN, validateOrThrow } from '@helmx/protocol'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHelmx } from '../../hub/src/app.js'
import { KernelRuntime, SecretStash } from '@helmx/kernel'
import { buildManagedEnv, runShell, type HelmxToolDeps } from '@helmx/kernel/testing'
import { createWorkflowPlugin } from '../src/workflow.js'
import { registerWorkflowTools } from '../src/workflow/tools.js'
import { createWorktreePlugin } from '../src/worktree.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { makeFauxProvider, useTempDir } from './helpers/plugin-test-env.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-subagent-tools-test-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

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

/** 工具结果 entry 结构化输出（pi.tool-result 的 model[0].details）。 */
function toolResultDetails(detail: { entries: Array<{ kind: string; model?: unknown[] }> }, toolName: string): Record<string, unknown> {
  const entry = [...detail.entries]
    .reverse()
    .find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === toolName)
  assert.ok(entry, `应存在 ${toolName} 的 pi.tool-result entry`)
  const message = entry.model?.[0] as { details?: unknown } | undefined
  assert.ok(message?.details && typeof message.details === 'object' && !Array.isArray(message.details), '应携带结构化 details')
  return message.details as Record<string, unknown>
}

function toolNameOf(model: unknown[] | undefined): string | undefined {
  const message = model?.[0] as { toolName?: string } | undefined
  return message?.toolName
}

/** 进程内 KV（隔离 KernelRuntime 上的编排插件用；不跨重启）。 */
function memoryState() {
  return undefined
}

/** agent_spawn 观察插件：记录每次载荷，返回 void（continue）。 */
function spawnObserver(spawns: AgentSpawnRequest[]) {
  return {
    id: 'test:spawn-observer',
    name: 'spawn 观察者',
    definePlugin(ctx: { hook: { onAgentSpawn(fn: (p: AgentSpawnRequest) => void): void } }) {
      ctx.hook.onAgentSpawn((payload) => {
        spawns.push(payload)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 1. subagent 工具：声明 + 完整入参进入 hook + 原生执行元数据回报
// ---------------------------------------------------------------------------

describe('subagent 工具完整入参与执行元数据', { timeout: 60_000 }, () => {
  it('声明含全部新入参；agentType/cwd/model/effort 原样进入 agent_spawn hook；输出独立回报 conversationId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa1')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      // before_turn 捕获工具声明（本回合真实触发）。
      let declared: { name: string; inputSchema: Record<string, unknown> } | undefined
      await kernel.plugins.register({
        id: 'test:declare-observer',
        name: '声明观察者',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((payload) => {
            const tools = (payload as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools
            declared = tools.find((t) => t.name === 'subagent')
          })
        },
      })

      const childCwd = join(dir, 'child-work')
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              prompt: '子任务',
              label: '  调研子任务  ',
              agentType: 'assistant',
              cwd: childCwd,
              model: 'faux/faux-1',
              effort: 'low',
              background: false,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
      ])

      await kernel.conversations.submitInput(1, '派生子代理')
      await kernel.conversations.waitForIdle(1)

      // 声明：全部新字段进入 inputSchema（模型可见）。
      assert.ok(declared, 'before_turn 应捕获 subagent 声明')
      const props = declared!.inputSchema['properties'] as Record<string, unknown>
      for (const field of ['label', 'agentType', 'nodeId', 'cwd', 'isolation', 'resume', 'model', 'effort', 'fork']) {
        assert.ok(props[field], `subagent 声明应含 ${field}`)
      }
      const nodeIdSchema = props['nodeId'] as { type?: string; pattern?: string }
      assert.equal(nodeIdSchema.type, 'string')
      assert.equal(nodeIdSchema.pattern, NODE_ID_PATTERN, 'nodeId 声明应复用协议权威 NODE_ID_PATTERN')
      const isolationSchema = props['isolation'] as { enum?: unknown[] }
      assert.deepEqual(isolationSchema.enum, ['worktree'], 'isolation 声明应仅允许 worktree')
      const modelSchema = props['model'] as { description?: string }
      assert.ok(modelSchema.description?.includes('tier/<id>'), 'model 声明应包含 tier/<id> 指引')
      const agentTypeSchema = props['agentType'] as { description?: string; pattern?: string }
      assert.equal(agentTypeSchema.pattern, undefined, 'agentType 不得加 JSON Schema pattern 以免丢失自愈纠偏提示')
      assert.ok(
        agentTypeSchema.description?.includes('tier/<id>') && agentTypeSchema.description?.includes('Never'),
        'agentType 声明应明确禁止传 tier/<id>',
      )

      // hook 载荷：各值原样到达（未静默丢字段）。
      assert.equal(spawns.length, 1, 'agent_spawn 钩子应恰好触发一次')
      const payload = spawns[0]!
      assert.equal(payload.prompt, '子任务')
      assert.equal(payload.title, '调研子任务')
      assert.equal(payload.agentType, 'assistant')
      assert.equal(payload.cwd, childCwd)
      assert.equal(payload.model, 'faux/faux-1')
      assert.equal(payload.effort, 'low')
      assert.equal(payload.isolation, undefined, '未传 isolation 时不得凭空出现')

      // 原生执行：真子会话派生；文本 JSON 信封回报业务 result 与 execution，details 保留 execution 索引（无 [subagent ...] 尾行）。
      const detail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      const details = toolResultDetails(detail, 'subagent')
      const envelope = JSON.parse(text) as Record<string, unknown>
      const child = kernel.conversations
        .listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, '应派生真子会话')
      assert.equal(child.title, '调研子任务', '子会话应持久保存 label 作为初始标题')
      assert.equal(text.includes('[subagent '), false, `不得追加 [subagent ...] 尾行：${text}`)
      assert.equal(envelope['result'], '子代理的回答', '业务结果原样回传到 structuredOutput/output')
      const envelopeExec = envelope['execution'] as Record<string, unknown>
      assert.equal(envelopeExec['conversationId'], child.id, 'envelope.execution 应含 conversationId')
      assert.equal(envelopeExec['effectiveCwd'], childCwd, `执行元数据应含 effectiveCwd=${childCwd}`)
      const detailExec = details['execution'] as Record<string, unknown>
      assert.equal(detailExec['conversationId'], child.id, 'details.execution 应含 conversationId')
      assert.equal(detailExec['effectiveCwd'], childCwd, `details.execution 应含 effectiveCwd=${childCwd}`)
      assert.equal('result' in details, false, 'pi.tool-result.details 严禁镜像 final.result')
      assert.equal(await kernel.conversations.getLastAssistantText(1), '主回合完成')
    } finally {
      await kernel.close()
    }
  })

  it('resume 续接：以首调返回的 conversationId 续接原会话，不新建；钩子载荷与 structuredOutput.execution 均可见', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa2')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      // 首调：派生子会话（显式同步：人类交互会话缺省已是后台，本组断言同步结果链）。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '第一轮', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('第一轮回答'),
        fauxAssistantMessage('首回合完成'),
      ])
      await kernel.conversations.submitInput(1, '首调')
      await kernel.conversations.waitForIdle(1)
      const child = kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '首调应派生子会话')
      assert.equal(spawns.length, 1)

      // 续接：resume = 首调返回的 conversationId（传 label 也不得覆写子会话 title）。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '第二轮', label: '续接标签', resume: String(child.id), background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('续接回答'),
        fauxAssistantMessage('续接回合完成'),
      ])
      await kernel.conversations.submitInput(1, '续接')
      await kernel.conversations.waitForIdle(1)

      assert.equal(spawns.length, 2, '续接也应经 agent_spawn 钩子')
      assert.equal(spawns[1]!.resume, String(child.id), 'resume 原样进入钩子载荷')
      assert.equal(spawns[1]!.title, undefined, 'resume 不得覆写 title')
      const children = kernel.conversations.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, '续接不得新建子会话')
      assert.equal(children[0]!.title, '第一轮', 'resume 应保留原派生子会话标题')

      const detail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      const details = toolResultDetails(detail, 'subagent')
      const envelope = JSON.parse(text) as Record<string, unknown>
      assert.equal(text.includes('[subagent '), false)
      assert.equal((details['execution'] as Record<string, unknown>)?.['conversationId'], child.id)
      assert.equal('result' in details, false, 'resume 落盘 details 不得镜像 result')
      assert.equal((envelope['execution'] as Record<string, unknown>)?.['conversationId'], child.id)
      assert.equal(envelope['result'], '续接回答')
    } finally {
      await kernel.close()
    }
  })

  it("不合法 isolation（'docker'）被显式拒绝：钩子绝不触发，不静默丢字段降级执行", { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa3')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '坏隔离', isolation: 'docker' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('主回合仍完成'),
      ])
      await kernel.conversations.submitInput(1, '坏 isolation')
      await kernel.conversations.waitForIdle(1)

      assert.equal(spawns.length, 0, '非法 isolation 绝不进入 agent_spawn 钩子')
      assert.equal(
        kernel.conversations.listConversations().filter((c) => c.parentConversationId === 1).length,
        0,
        '不得派生任何子会话',
      )
      const detail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(
        text.includes('isolation') && text.includes('worktree'),
        `拒绝信息应显式指出 isolation 非法：${text.slice(0, 300)}`,
      )
      assert.ok(!text.includes('subagent_failed'), 'SDK 参数校验拒绝（非工具内部失败路径）')

      // 非字符串 label 同样被显式拒绝，绝不进入 agent_spawn 钩子
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '坏标签', label: { bad: true } as unknown as string })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('主回合仍完成2'),
      ])
      await kernel.conversations.submitInput(1, '坏 label')
      await kernel.conversations.waitForIdle(1)
      assert.equal(spawns.length, 0, '非法 label 绝不进入 agent_spawn 钩子')
      const labelDetail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const labelText = toolResultText(labelDetail, 'subagent')
      assert.ok(labelText.includes('label'), `拒绝信息应显式指出 label 非法：${labelText.slice(0, 300)}`)
    } finally {
      await kernel.close()
    }
  })

  it('agent_spawn handled 外部后端：onResolved 回传 executionId/effectiveCwd/worktree，工具独立回报不混入业务 result', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa4')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      await kernel.plugins.register(createWorktreePlugin())
      // 外部后端语义（如 builtin:herdr）：接管执行并经 onResolved 回传元数据（worktree 登记与租约由 builtin:worktree 统一包襄）。
      await kernel.plugins.register({
        id: 'test:external-backend',
        name: '外部后端',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload) => {
            const req = payload as AgentSpawnRequest
            req.onResolved?.({
              nodeId: 'local',
              executionId: 'pane-9',
              effectiveCwd: '/srv/wt/helmx-42',
              meta: { 'builtin:worktree': { worktree: { path: '/srv/wt/helmx-42', branch: 'helmx/wf-run-1' } } },
            })
            return { action: 'handled', result: { external: 'done', detail: 7 } }
          })
        },
      })

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '外部任务', agentType: 'herdr:agy', background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('外部回合完成'),
      ])
      await kernel.conversations.submitInput(1, '外部后端')
      await kernel.conversations.waitForIdle(1)

      const detail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      const details = toolResultDetails(detail, 'subagent')
      const envelope = JSON.parse(text) as Record<string, unknown>
      assert.equal(text.includes('[subagent '), false)
      assert.deepEqual(envelope['result'], { external: 'done', detail: 7 })
      const expectedExec = {
        nodeId: 'local',
        executionId: 'pane-9',
        effectiveCwd: '/srv/wt/helmx-42',
        worktree: { path: '/srv/wt/helmx-42', branch: 'helmx/wf-run-1' },
      }
      assert.deepEqual(envelope['execution'], expectedExec)
      assert.deepEqual(details['execution'], expectedExec)
      assert.equal('result' in details, false, '外部后端落盘 details 不得镜像 result')
      assert.equal(
        kernel.conversations.listConversations().filter((c) => c.parentConversationId === 1).length,
        0,
        'handled 后端接管时不得派生原生子会话',
      )
    } finally {
      await kernel.close()
    }
  })

  it('nodeId 透传到 agent_spawn；非法 nodeId 与 resume + nodeId 在工具入口被显式拒绝且零派生', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa-nodeid')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      // 1) 合法 nodeId='local' 原样进入 agent_spawn 并完成
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '显式本机任务', nodeId: 'local', background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('本机完成'),
        fauxAssistantMessage('主回合1完成'),
      ])
      await kernel.conversations.submitInput(1, '指定 nodeId=local')
      await kernel.conversations.waitForIdle(1)
      assert.equal(spawns.length, 1)
      assert.equal(spawns[0]!.nodeId, 'local', 'nodeId 应原样进入 AgentSpawnRequest')

      // 2) 非法 nodeId 格式在参数校验层即被拒绝，绝不进入 agent_spawn
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '坏节点', nodeId: '_bad/node!', background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('主回合2完成'),
      ])
      await kernel.conversations.submitInput(1, '非法 nodeId')
      await kernel.conversations.waitForIdle(1)
      assert.equal(spawns.length, 1, '非法 nodeId 绝不进入 agent_spawn')
      const badDetail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const badText = toolResultText(badDetail, 'subagent')
      assert.match(badText, /nodeId/)

      // 3) resume + nodeId 互斥在工具入口被显式拒绝，绝不进入 agent_spawn
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '互斥调用', resume: '2', nodeId: 'gpu-1', background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('主回合3完成'),
      ])
      await kernel.conversations.submitInput(1, 'resume + nodeId 互斥')
      await kernel.conversations.waitForIdle(1)
      assert.equal(spawns.length, 1, 'resume + nodeId 绝不进入 agent_spawn')
      const conflictDetail = await kernel.conversations.getConversationDetail(1, { limit: 50 })
      const conflictText = toolResultText(conflictDetail, 'subagent')
      assert.match(conflictText, /nodeId 与 resume 互斥/)
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. SubagentWorkflow 工具：scriptPath / args（不 String 化）/ resumeFromRunId
// ---------------------------------------------------------------------------

describe('SubagentWorkflow 工具入参贯通（真实引擎）', { timeout: 60_000 }, () => {
  /** 引擎动作（与 HTTP/CLI 同链路；wait:true 返回终态 run）。 */
  const wfRun = (app: Awaited<ReturnType<typeof createHelmx>>, request: Record<string, unknown>) =>
    app.kernel.plugins.invokeAction('builtin:workflow', 'run', request) as Promise<{
      run: import('../src/contracts.js').WorkflowRunSummary
    }>
  const wfInspect = (app: Awaited<ReturnType<typeof createHelmx>>, runId: string) =>
    app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{
      run: import('../src/contracts.js').WorkflowRunSummary
    }>

  it('args 为任意 JSON 对象原样到达真实引擎（args.items.map 可用，绝不 String 化）；scriptPath 与 resumeFromRunId 均贯通', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wf1')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      // --- script + args（对象）：脚本内 args.items.map 依赖真实结构 ---
      const doubleScript =
        'export const meta = { name: "tool-args-obj", description: "t" }\n' +
        'return args.items.map((x) => x * 2)'
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { script: doubleScript, label: '  自定义编排  ', args: { items: [1, 2, 3] }, background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('编排回合完成'),
      ])
      await app.kernel.conversations.submitInput(1, '跑编排')
      await app.kernel.conversations.waitForIdle(1)

      const detail = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      const wfDetails = toolResultDetails(detail, 'SubagentWorkflow')
      const runId = extractRunId(text)
      assert.ok(runId, `工具输出应含 runId：${text.slice(0, 300)}`)
      assert.deepEqual(wfDetails, {
        ok: true,
        runId,
        status: 'completed',
        label: '自定义编排',
      }, 'SubagentWorkflow 落盘 details 仅保留轻量 UI 索引，绝不镜像完整 WorkflowRunSummary')
      const parsedSummary = JSON.parse(text) as { status: string; name?: string; result?: unknown }
      assert.equal(parsedSummary.status, 'completed', 'SubagentWorkflow 工具应等待终态返回')
      assert.equal(parsedSummary.name, '自定义编排', 'label 应覆盖 meta.name 作为 run.name')
      assert.deepEqual(parsedSummary.result, [2, 4, 6], '工具输出直接携带终态 result')
      const doneRun = (await wfInspect(app, runId)).run
      assert.equal(doneRun.name, '自定义编排')
      assert.deepEqual(doneRun.result, [2, 4, 6], 'args.items.map 真实计算——args 为对象而非字符串')

      // --- scriptPath：文件路径入口 ---
      const scriptFile = join(dir, 'wf-script-file.js')
      writeFileSync(
        scriptFile,
        'export const meta = { name: "tool-script-path", description: "t" }\nreturn args.base + 30',
      )
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { scriptPath: scriptFile, args: { base: 12 }, background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('scriptPath 回合完成'),
      ])
      await app.kernel.conversations.submitInput(1, '跑 scriptPath')
      await app.kernel.conversations.waitForIdle(1)
      const detail2 = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const runId2 = extractRunId(toolResultText(detail2, 'SubagentWorkflow'))
      assert.ok(runId2, 'scriptPath 调用应返回新 runId')
      assert.equal((await wfInspect(app, runId2)).run.result, 42, 'scriptPath 脚本真实执行')

      // --- resumeFromRunId：断点恢复（账本前缀重放，结果与原 run 一致） ---
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { resumeFromRunId: runId, background: false })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('恢复回合完成'),
      ])
      await app.kernel.conversations.submitInput(1, '断点恢复')
      await app.kernel.conversations.waitForIdle(1)
      const detail3 = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const runId3 = extractRunId(toolResultText(detail3, 'SubagentWorkflow'))
      assert.ok(runId3, 'resume 调用应返回新 runId')
      assert.deepEqual((await wfInspect(app, runId3)).run.result, [2, 4, 6], '重放结果与原 run 一致')
      assert.equal((await wfInspect(app, runId3)).run.replayedFrom, runId, 'resume run 应标记账本重放来源')
    } finally {
      await app.close()
    }
  })

  it('非法组合（script 与 scriptPath 同时提供）经工具显式失败，不伪造运行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wf2')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('SubagentWorkflow', {
              script: 'export const meta = { name: "x", description: "t" }\nreturn 1',
              scriptPath: '/tmp/other.js',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('回合完成'),
      ])
      await app.kernel.conversations.submitInput(1, '非法组合')
      await app.kernel.conversations.waitForIdle(1)
      const detail = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      assert.ok(
        text.includes('workflow_failed') && text.includes('exactly one of'),
        `Expected an explicit failure, not a fabricated run: ${text.slice(0, 300)}`,
      )

      // 空白 label 必须显式拒绝
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('SubagentWorkflow', {
              script: 'export const meta = { name: "x", description: "t" }\nreturn 1',
              label: '   ',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('空白 label 回合完成'),
      ])
      await app.kernel.conversations.submitInput(1, '空白 label')
      await app.kernel.conversations.waitForIdle(1)
      const detailBlank = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const blankText = toolResultText(detailBlank, 'SubagentWorkflow')
      assert.ok(
        blankText.includes('workflow_failed') && blankText.includes('label'),
        `空白 label 应显式失败：${blankText.slice(0, 300)}`,
      )
    } finally {
      await app.close()
    }
  })

  it('模型 tool_call 传 JSON 字符串或双重序列化 args 时，prepareArguments 与工具执行链自动规范化，持久化记录为真实对象', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wf3')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      // 1. 模型传 JSON 字符串形式的 args 对象：'{"topics": ["星辰", "大海"], "n": 42}'
      const probeScript =
        'export const meta = { name: "str-args-probe", description: "p" }\n' +
        'return { type: typeof args, count: args.topics.length, n: args.n, topics: args.topics }'

      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('SubagentWorkflow', {
              script: probeScript,
              args: '{"topics": ["星辰", "大海"], "n": 42}',
              background: false,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('探针完成'),
      ])
      await app.kernel.conversations.submitInput(1, '跑字符串 args 探针')
      await app.kernel.conversations.waitForIdle(1)

      const detail = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      const runId = extractRunId(text)
      assert.ok(runId, `应返回 runId：${text.slice(0, 300)}`)

      const parsedSummary = JSON.parse(text) as {
        status: string
        result?: { type: string; count: number; n: number; topics: string[] }
      }
      assert.equal(parsedSummary.status, 'completed', '工作流应成功执行完成')
      assert.equal(parsedSummary.result?.type, 'object', '脚本内收到的 args 类型必须为 object 而非 string')
      assert.equal(parsedSummary.result?.count, 2, 'args.topics.length 真实计算')
      assert.equal(parsedSummary.result?.n, 42, 'args.n 真实保留')
      assert.deepEqual(parsedSummary.result?.topics, ['星辰', '大海'])

      // 验证持久化层（新契约）：runs KV 存紧凑 RunHeader；完整 RunDetail（含 args）
      // 落插件私有 artifacts/1/wf-<runId>.detail.json，args 必须为真实 dict 而非 string。
      const listed = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: 1 })) as {
        runs: Array<{ id: string }>
      }
      assert.ok(listed.runs.some((item) => item.id === runId), `runs 列表应含该 run（实际 ${JSON.stringify(listed.runs)}）`)
      const persistedDetail = JSON.parse(
        readFileSync(join(dir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1', `wf-${runId}.detail.json`), 'utf-8'),
      ) as { args?: unknown }
      assert.equal(typeof persistedDetail.args, 'object', '持久化 args 必须为真对象而非字符串')
      assert.deepEqual(persistedDetail.args, { topics: ['星辰', '大海'], n: 42 })

      // 2. 双重序列化 args：JSON.stringify('{"items": [10, 20]}')
      const doubleScript =
        'export const meta = { name: "double-str-args", description: "d" }\n' +
        'return args.items.map((x) => x * 2)'
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('SubagentWorkflow', {
              script: doubleScript,
              args: JSON.stringify('{"items": [10, 20]}'),
              background: false,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('双重序列化完成'),
      ])
      await app.kernel.conversations.submitInput(1, '跑双重序列化 args')
      await app.kernel.conversations.waitForIdle(1)

      const detail2 = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
      const text2 = toolResultText(detail2, 'SubagentWorkflow')
      const runId2 = extractRunId(text2)
      assert.ok(runId2, '双重序列化调用应返回 runId')
      const parsedSummary2 = JSON.parse(text2) as { status: string; result?: unknown }
      assert.equal(parsedSummary2.status, 'completed')
      assert.deepEqual(parsedSummary2.result, [20, 40], '双重序列化自动解包，map 正常计算')
      const persistedRecord2 = JSON.parse(
        readFileSync(join(dir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1', `wf-${runId2}.detail.json`), 'utf-8'),
      ) as { args?: unknown }
      assert.equal(typeof persistedRecord2.args, 'object', '持久化 args 必须为真对象')
      assert.deepEqual(persistedRecord2.args, { items: [10, 20] })
    } finally {
      await app.close()
    }
  })
})

function extractRunId(text: string): string | undefined {
  const match = text.match(/"id":"(wf_[0-9a-zA-Z_-]+)"/)
  return match?.[1]
}

// ---------------------------------------------------------------------------
// 2.5 subagent 失败但子会话已创建：错误结果仍持久化 structuredOutput.execution
// ---------------------------------------------------------------------------

test('subagent 失败于子会话创建后：错误结果不附文本 footer，仍持久化 structuredOutput.execution（失败卡可续接子会话）', { timeout: 60_000 }, async () => {
  const dir = join(rootDir, 'sa-err-footer')
  const faux = makeFauxProvider()
  const app = await createHelmx({ buildProvider: createPluginBuildProvider(),
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  try {
    // 子代理回合只回思考无文本：driveTurn 在 onResolved 之后抛
    // subagent_failed（完成但无文本输出）——真实失败时机。
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: '会失败的任务', background: false }, { id: 'call-err-1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxThinking('只有思考没有正文')]),
      fauxAssistantMessage('主回合继续'),
    ])
    await app.kernel.conversations.submitInput(1, '派生会失败的子代理')
    await app.kernel.conversations.waitForIdle(1)

    const detail = await app.kernel.conversations.getConversationDetail(1, { limit: 50 })
    const text = toolResultText(detail, 'subagent')
    const structured = toolResultDetails(detail, 'subagent')
    assert.ok(text.includes('subagent_failed'), `应显式失败：${text.slice(0, 200)}`)
    assert.equal(text.includes('[subagent '), false, '失败文本不附 [subagent ...] 尾行')
    // 失败仍附 structuredOutput.execution：前端直接读取结构化关联子会话。
    const child = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
    assert.ok(child, '子会话应已创建')
    assert.equal(
      (structured['execution'] as Record<string, unknown>)?.['conversationId'],
      child.id,
      `失败输出 structuredOutput.execution 应含 conversationId=${child.id}，实得：${JSON.stringify(structured)}`,
    )
    // 运行期关联也已登记（后续 resume 更新 parentToolCallId 前历史失败卡不失联）。
    assert.equal(child.parentToolCallId, 'call-err-1')
  } finally {
    await app.close()
  }
})

function fauxThinking(text: string): { type: 'thinking'; thinking: string } {
  return { type: 'thinking', thinking: text }
}

// ---------------------------------------------------------------------------
// 3. buildManagedEnv：受管环境构造
// ---------------------------------------------------------------------------

describe('buildManagedEnv 环境构造', { timeout: 60_000 }, () => {
  it('buildManagedEnv：无受管 token provider 时不透传任何 HELMX_TOKEN', { timeout: 60_000 }, () => {
    const stash = new SecretStash()
    const deps: HelmxToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => stash.redact(t),
      artifacts: null as never,
    }
    const env = buildManagedEnv(deps, '/work', 3)
    assert.equal(env['HELMX_TOKEN'], undefined)
    const withProvider = buildManagedEnv({ ...deps, processToken: () => 'managed-tok' }, '/work', 3)
    assert.equal(withProvider['HELMX_TOKEN'], 'managed-tok')
  })
})

// ---------------------------------------------------------------------------
// 4. Gate 执行环境：options.env 注入机制
// ---------------------------------------------------------------------------

describe('runGate/runShell options.env 注入', { timeout: 60_000 }, () => {
  it('真实 Gate 子进程读自定义 env；HELMX 固定值与受管 token 不被注入覆盖；无 provider 时剥除注入的旧 token', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate1')
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      hubUrl: 'http://127.0.0.1:3999',
      model: 'faux/faux-1',
    })
    try {
      const spawnEnv: Record<string, string> = {
        CI_TOOL_HOME: '/opt/ci-tools',
        HELMX_CWD: '/evil-cwd',
        HELMX_HUB_URL: 'http://evil.example',
        HELMX_TOKEN: 'injected-stale-token',
      }
      const gate = await kernel.agentSpawn.runGate(
        'printf "%s|%s|%s|%s" "$CI_TOOL_HOME" "$HELMX_CWD" "$HELMX_HUB_URL" "${HELMX_TOKEN:+set}"',
        { cwd: dir, conversationId: 1, env: spawnEnv },
      )
      assert.equal(gate.ok, true, `gate 应成功：${gate.output}`)
      const [toolHome, helmxCwd, hubUrl, tokenFlag] = gate.output.split('|')
      assert.equal(toolHome, '/opt/ci-tools', '自定义 env 键应真实到达 Gate 子进程')
      assert.equal(helmxCwd, dir, '受管 HELMX_CWD 不得被注入覆盖')
      assert.equal(hubUrl, 'http://127.0.0.1:3999', '受管 HELMX_HUB_URL 不得被注入覆盖')
      assert.equal(tokenFlag, 'set', '受管 token 应覆盖注入的旧 token（非空）')
      assert.ok(!gate.output.includes('injected-stale-token'), '旧 token 值不得泄漏')
    } finally {
      await kernel.close()
    }
  })

  it('无受管 token provider 时 options.env 注入的 HELMX_TOKEN 也被剥除（真实子进程不可见）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate2')
    mkdirSync(dir, { recursive: true })
    const stash = new SecretStash()
    const deps: HelmxToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => stash.redact(t),
      artifacts: null as never,
    }
    const result = await runShell(deps, 'echo "${HELMX_TOKEN:-UNSET} $CUSTOM_KEY"', {
      cwd: dir,
      env: { HELMX_TOKEN: 'stale-injected', CUSTOM_KEY: 'visible' },
    })
    assert.equal(result.ok, true)
    assert.ok(result.output.includes('UNSET'), '无 provider 时注入的 HELMX_TOKEN 必须被剥除')
    assert.ok(result.output.includes('visible'), '其余注入键正常透传')
  })

  it('process.env 同名键被 options.env 覆盖（基底 < 注入 < 受管变量三级合并）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate3')
    const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(),
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
    })
    try {
      process.env['HELMX_GATE_TEST_BASE'] = 'from-host'
      const gate = await kernel.agentSpawn.runGate('printf "%s" "$HELMX_GATE_TEST_BASE"', {
        cwd: dir,
        env: { HELMX_GATE_TEST_BASE: 'from-inject' },
      })
      delete process.env['HELMX_GATE_TEST_BASE']
      assert.equal(gate.ok, true)
      assert.ok(gate.output.includes('from-inject'), `注入应覆盖宿主同名键：${gate.output}`)
    } finally {
      delete process.env['HELMX_GATE_TEST_BASE']
      await kernel.close()
    }
  })
})

test('外部子代理执行元数据的工具正文与持久结果统一脱敏', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-spawn-metadata-')
  const faux = makeFauxProvider()
  const kernel = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, providers: [faux.provider], model: 'faux/faux-1' })
  try {
    const secret = 'private-metadata-folder'
    kernel.stash.addRedaction(secret)
    // subagent 工具由 builtin:workflow 插件提供（引擎 state 走插件私有 records doc）。
    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.plugins.register({
      id: 'test:metadata-boundary',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({
            nodeId: 'local',
            executionId: 'pane-9',
            effectiveCwd: `/srv/${secret}/task`,
            meta: { 'builtin:worktree': { worktree: { path: `/srv/${secret}/task`, branch: `helmx/${secret}/task` } } },
          })
          return { action: 'handled', result: { answer: 42 } }
        })
      },
    })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: '检查元数据', agentType: 'herdr:pi', background: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('完成'),
    ])
    await kernel.conversations.submitInput(1, '执行任务')
    await kernel.conversations.waitForIdle(1)
    const detail = await kernel.conversations.getConversationDetail(1, { limit: 30 })
    const output = JSON.stringify(detail)
    assert.ok(detail.entries.some((entry) => entry.kind === 'pi.tool-result'))
    assert.ok(output.includes('pane-9'), '非机密续接标识仍可读取')
    assert.ok(output.includes('[REDACTED]'), '正文或元数据应包含脱敏标记')
    assert.ok(!output.includes(secret), '执行目录与分支中的机密不得落入工具正文或结构化结果')
  } finally {
    await kernel.close()
  }
})

// ---------------------------------------------------------------------------
// 5. subagent / SubagentWorkflow 工具 presentationMetaSchema 与轻量投影边界
// ---------------------------------------------------------------------------

describe('subagent / SubagentWorkflow 工具 presentationMeta 轻量投影与 Schema 边界', { timeout: 60_000 }, () => {
  type RegisteredTool = PluginToolSpec & { presentationMetaSchema?: JsonSchema }

  function captureWorkflowTools(
    workflowsStub: Record<string, unknown>,
    hostStub: Record<string, unknown> = {},
  ): Map<string, RegisteredTool> {
    const tools = new Map<string, RegisteredTool>()
    const ctx = {
      host: {
        listConversations: () => [],
        redact: (text: string) => text,
        ...hostStub,
      },
      tool(spec: RegisteredTool) {
        tools.set(spec.name, spec)
      },
    } as unknown as HelmxPluginContext
    registerWorkflowTools(ctx, {
      workflows: workflowsStub as never,
      assertCanSpawn: () => {},
      resolveBackground: (_convId, explicit) => ({ ok: true, background: explicit === true }),
      syncRunsDoc: () => {},
    })
    return tools
  }

  it('subagent：声明 presentationMetaSchema，大 result 与内部 worktree 元字段只进 structuredOutput、不污染 presentationMeta', { timeout: 60_000 }, async () => {
    const largeResult = 'x'.repeat(40_000)
    const execution = {
      nodeId: 'local',
      conversationId: 21,
      effectiveCwd: '/wt/sub-21',
      meta: {
        'builtin:worktree': {
          worktree: {
            id: 'local:/wt/sub-21',
            path: '/wt/sub-21',
            branch: 'helmx/sub-21',
            repoRoot: '/repo',
            baseCommit: 'abc1234',
          },
        },
      },
    }
    const runRecord = {
      id: 'wf_sub_1',
      name: 'subagent',
      conversationId: 1,
      kind: 'subagent' as const,
      status: 'running' as const,
      createdAt: 1,
      updatedAt: 2,
      result: largeResult,
    }
    let syncOutcome: { ok: true; value: string } | { ok: false; error: string } = { ok: true, value: largeResult }
    const tools = captureWorkflowTools(
      {
        findRunByParentToolCall: () => undefined,
        startBackgroundAgent: async () => ({ run: runRecord, execution }),
        getRun: () => runRecord,
        loadRunHeaderAndDetail: () => ({ header: { ...runRecord, phase: 'running', execution }, detail: { id: runRecord.id } }),
        isHostClosing: () => false,
        isAutoRecoverOnRestart: () => false,
      },
      {
        spawnAgent: async (req: AgentSpawnRequest) => {
          req.onResolved?.(execution)
          if (!syncOutcome.ok) throw new Error(syncOutcome.error)
          return syncOutcome.value
        },
      },
    )

    const subagentTool = tools.get('subagent')!
    assert.ok(subagentTool.structuredOutputSchema, '应声明 structuredOutputSchema')
    assert.ok(subagentTool.presentationMetaSchema, '应声明 presentationMetaSchema')

    // 1) 同步终态（含 40KB result；直走 ctx.host.spawnAgent，不创建 WorkflowRun）
    const settled = (await subagentTool.execute(
      { prompt: '大载荷子代理', background: false },
      { conversationId: 1, callId: 'call_sa_1' },
    )) as { structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.equal(settled.structuredOutput['result'], largeResult, 'structuredOutput 保留完整 result 给程序调用')
    assert.equal('result' in settled.presentationMeta, false, 'presentationMeta 绝不镜像 final.result')
    validateOrThrow(subagentTool.presentationMetaSchema!, settled.presentationMeta, 'subagent.presentationMeta')
    assert.deepEqual(settled.presentationMeta, {
      ok: true,
      status: 'completed',
      execution: {
        nodeId: 'local',
        conversationId: 21,
        effectiveCwd: '/wt/sub-21',
        worktree: { id: 'local:/wt/sub-21', path: '/wt/sub-21', branch: 'helmx/sub-21' },
      },
    })
    assert.ok(JSON.stringify(settled.presentationMeta).length < 512)

    // 2) 后台句柄
    const bg = (await subagentTool.execute(
      { prompt: '后台子代理', background: true },
      { conversationId: 1, callId: 'call_sa_bg' },
    )) as { structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    validateOrThrow(subagentTool.presentationMetaSchema!, bg.presentationMeta, 'subagent.bg.presentationMeta')
    assert.equal(bg.presentationMeta['background'], true)
    assert.equal(bg.presentationMeta['runId'], 'wf_sub_1')
    assert.equal('result' in bg.presentationMeta, false)

    // 3) 失败终态 + 参数前置校验错误
    syncOutcome = { ok: false, error: largeResult }
    const failed = (await subagentTool.execute(
      { prompt: '失败子代理', background: false },
      { conversationId: 1, callId: 'call_sa_fail' },
    )) as { isError: boolean; structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.equal(failed.isError, true)
    assert.equal(failed.structuredOutput['result'], largeResult)
    assert.equal('result' in failed.presentationMeta, false)
    validateOrThrow(subagentTool.presentationMetaSchema!, failed.presentationMeta, 'subagent.failed.presentationMeta')

    const badArg = (await subagentTool.execute(
      { prompt: '坏参数', isolation: 'docker' },
      { conversationId: 1, callId: 'call_sa_bad' },
    )) as { isError: boolean; presentationMeta: Record<string, unknown> }
    assert.equal(badArg.isError, true)
    assert.deepEqual(badArg.presentationMeta, { ok: false })
    validateOrThrow(subagentTool.presentationMetaSchema!, badArg.presentationMeta, 'subagent.badArg.presentationMeta')

    // 4) 直调 execute 入口（绕过 JSON Schema）：非法 nodeId 与 resume + nodeId 均返回结构化错误
    for (const badNode of ['_bad', 'bad/node', '', 123]) {
      const badNodeRes = (await subagentTool.execute(
        { prompt: '坏节点', nodeId: badNode },
        { conversationId: 1, callId: `call_sa_bad_node_${String(badNode)}` },
      )) as { isError: boolean; structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
      assert.equal(badNodeRes.isError, true)
      assert.equal(badNodeRes.structuredOutput['ok'], false)
      assert.deepEqual(badNodeRes.presentationMeta, { ok: false })
      validateOrThrow(subagentTool.presentationMetaSchema!, badNodeRes.presentationMeta, 'subagent.badNode.presentationMeta')
    }
    const conflictRes = (await subagentTool.execute(
      { prompt: '冲突', resume: '21', nodeId: 'gpu-1' },
      { conversationId: 1, callId: 'call_sa_node_resume' },
    )) as { isError: boolean; structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.equal(conflictRes.isError, true)
    assert.equal(conflictRes.structuredOutput['ok'], false)
    assert.match(String(conflictRes.structuredOutput['result']), /nodeId 与 resume 互斥/)
    assert.deepEqual(conflictRes.presentationMeta, { ok: false })
    validateOrThrow(subagentTool.presentationMetaSchema!, conflictRes.presentationMeta, 'subagent.conflictNode.presentationMeta')
  })

  it('SubagentWorkflow：声明 presentationMetaSchema，完整 WorkflowRunSummary 仅进 structuredOutput，presentationMeta 仅存轻量索引', { timeout: 60_000 }, async () => {
    const hugeRun = {
      id: 'wf_big_1',
      name: '全量验收编排',
      conversationId: 1,
      status: 'completed' as const,
      createdAt: 1,
      updatedAt: 2,
      result: 'y'.repeat(40_000),
      nodes: [{ id: 'n1', kind: 'agent', status: 'done', output: 'z'.repeat(20_000) }],
      progress: [{ at: 1, kind: 'log', message: 'log-entry' }],
    }
    let currentRun = hugeRun
    const tools = captureWorkflowTools({
      findRunByParentToolCall: () => undefined,
      run: async () => currentRun,
      getRun: () => currentRun,
      waitForeground: async () => 'settled',
      isHostClosing: () => false,
      isAutoRecoverOnRestart: () => false,
    })

    const wfTool = tools.get('SubagentWorkflow')!
    assert.ok(wfTool.structuredOutputSchema, '应声明 structuredOutputSchema')
    assert.ok(wfTool.presentationMetaSchema, '应声明 presentationMetaSchema')

    // 1) 同步终态（含 60KB summary）
    const settled = (await wfTool.execute(
      { script: 'return 1', background: false },
      { conversationId: 1, callId: 'call_wf_1' },
    )) as { structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.deepEqual(settled.structuredOutput['summary'], hugeRun, 'structuredOutput 保留完整 WorkflowRunSummary')
    assert.equal('summary' in settled.presentationMeta, false, 'presentationMeta 绝不镜像 WorkflowRunSummary')
    assert.equal('nodes' in settled.presentationMeta, false)
    assert.equal('result' in settled.presentationMeta, false)
    validateOrThrow(wfTool.presentationMetaSchema!, settled.presentationMeta, 'workflow.presentationMeta')
    assert.deepEqual(settled.presentationMeta, {
      ok: true,
      runId: 'wf_big_1',
      status: 'completed',
      label: '全量验收编排',
    })
    assert.ok(JSON.stringify(settled.presentationMeta).length < 256)

    // 2) 后台调度句柄
    currentRun = { ...hugeRun, status: 'running' as never }
    const bg = (await wfTool.execute(
      { script: 'return 1', background: true },
      { conversationId: 1, callId: 'call_wf_bg' },
    )) as { structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.equal(bg.structuredOutput['background'], true)
    assert.deepEqual(bg.structuredOutput['summary'], currentRun)
    validateOrThrow(wfTool.presentationMetaSchema!, bg.presentationMeta, 'workflow.bg.presentationMeta')
    assert.deepEqual(bg.presentationMeta, {
      ok: true,
      background: true,
      runId: 'wf_big_1',
      status: 'running',
      label: '全量验收编排',
    })

    // 3) 异常捕获失败路径
    const errTools = captureWorkflowTools({
      findRunByParentToolCall: () => undefined,
      run: async () => {
        throw new Error('boom')
      },
      isHostClosing: () => false,
      isAutoRecoverOnRestart: () => false,
    })
    const errRes = (await errTools.get('SubagentWorkflow')!.execute(
      { script: 'throw 1', background: false },
      { conversationId: 1, callId: 'call_wf_err' },
    )) as { isError: boolean; structuredOutput: Record<string, unknown>; presentationMeta: Record<string, unknown> }
    assert.equal(errRes.isError, true)
    assert.equal(errRes.structuredOutput['summary'], 'boom')
    assert.deepEqual(errRes.presentationMeta, { ok: false, status: 'failed' })
    validateOrThrow(wfTool.presentationMetaSchema!, errRes.presentationMeta, 'workflow.err.presentationMeta')
  })

  it('人类会话默认后台调用 subagent 传 agentType: tier/reviewer 时同步拦截：返回 isError 纠偏提示、绝不落盘 WorkflowRun、不触发 agent_spawn', { timeout: 60_000 }, async (t) => {
    const dataDir = useTempDir(t, 'helmx-subagent-tier-guard-')
    const faux = makeFauxProvider()
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      await kernel.plugins.register(createWorkflowPlugin())
      await kernel.plugins.register(createWorktreePlugin())
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              prompt: '审查本次改动',
              agentType: 'tier/reviewer',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('收到纠偏提示，已停止错误派工'),
      ])

      await kernel.conversations.submitInput(1, '请派审查子代理')
      await kernel.conversations.waitForIdle(1)

      const detail = await kernel.conversations.getConversationDetail(1, { limit: 30 })
      const toolEntry = [...detail.entries].reverse().find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === 'subagent')
      assert.ok(toolEntry, '应存在 subagent 的 pi.tool-result')
      const toolMsg = toolEntry.model?.[0] as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
      assert.equal(toolMsg.isError, true, '传入 tier/reviewer 到 agentType 必须返回 isError: true')
      const text = toolResultText(detail, 'subagent')
      assert.ok(text.includes('tier/reviewer'), `错误信息应点名 tier/reviewer: ${text}`)
      assert.ok(text.includes('model'), `错误信息应提示使用 model 参数: ${text}`)
      assert.equal(text.toLowerCase().includes('illegal profile id'), false, `不应退化为 illegal profile id: ${text}`)

      const runsResult = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: unknown[] }
      assert.deepEqual(runsResult.runs, [], '默认后台模式被前置校验拦截后绝不得创建/落盘任何 WorkflowRun')
      assert.equal(spawns.length, 0, '前置拦截后不得进入 agent_spawn 钩子链')
      assert.equal(
        kernel.conversations.listConversations().filter((c) => c.parentConversationId === 1).length,
        0,
        '不得创建子会话',
      )

      // 组合 isolation: 'worktree' + agentType: 'tier/coder'：同样在分配 worktree 之前拦截
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              prompt: '隔离开发',
              agentType: 'tier/coder',
              isolation: 'worktree',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('收到 worktree + tier 纠偏提示'),
      ])
      await kernel.conversations.submitInput(1, '派发隔离 coder')
      await kernel.conversations.waitForIdle(1)

      const wtDetail = await kernel.conversations.getConversationDetail(1, { limit: 30 })
      const wtToolEntry = [...wtDetail.entries].reverse().find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === 'subagent')
      assert.ok(wtToolEntry)
      assert.equal((wtToolEntry.model?.[0] as { isError?: boolean }).isError, true)
      const wtText = toolResultText(wtDetail, 'subagent')
      assert.ok(wtText.includes('tier/coder') && wtText.includes('model'), `应含 tier/coder 与 model 提示: ${wtText}`)
      assert.equal(wtText.toLowerCase().includes('illegal profile id'), false)
      const wtRuns = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: unknown[] }
      assert.deepEqual(wtRuns.runs, [], '不得创建 WorkflowRun')
      const wtList = (await kernel.plugins.invokeAction('builtin:worktree', 'list_worktrees', {})) as { worktrees: unknown[] }
      assert.deepEqual(wtList.worktrees, [], '不得分配孤儿 worktree')
      assert.equal(spawns.length, 0, '不得触发 agent_spawn 钩子')
    } finally {
      await kernel.close()
    }
  })
})
