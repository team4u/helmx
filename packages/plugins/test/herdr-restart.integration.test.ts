/**
 * builtin:herdr 跨 Hub 重启保活与重挂对账集成测试（T4 覆盖）。
 *
 * 覆盖（真实 KernelRuntime + 真实 state.sqlite + 真实 UDS serveTransport）：
 * - ManagedDoc.panes[i].outputFileName 持久化、steer 重定向落盘、结算清空与
 *   herdr_managed_invalid 严格文件名校验；
 * - 宿主关停保活断连（isClosing === true）：不断开窗格（零 tab.close），保留
 *   running 窗格与仍归 workflow 管辖的 keepalive 窗格；
 * - 启动对账 reconcile()：不误杀携带持久化 outputFileName 的 running 窗格
 *   （无论当前 idle/done/working/blocked/已退出待判定）；
 * - 场景 ①：重启窗口内 .helmx/<outputFileName> 已写完，reattach 优先直接校验、
 *   跑 gate（回传 onGateResult）、标记 keepalive 并返回产物（不重开 tab/prompt）；
 * - 场景 ②：重启后窗格仍在 working/blocked（含 CAS AskDoc 冲突 :r1 恢复与
 *   reattach 后 steer 重定向文件）及 idle 缺文件单次自愈闭环；
 * - 场景 ③：重启后窗格已消失且无文件（或文件无效）诚实报错 herdr_pane_lost /
 *   herdr_output_contract_violation 并附 40 行脱敏快照、标记 failed；
 * - 冲突/缺失边界（reattach 与 resume/fork 互斥、herdr_reattach_missing）与
 *   启动顺序（先于 herdr.start() 的前置插件 service.start() 发起重挂）；
 * - isClosing === false 停用/关闭路径仍正常关闭非 failed/settled 窗格。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  HelmxError,
  type AgentExecutionInfo,
  type AgentGateResult,
  type PluginDefinition,
} from '@helmx/protocol'
import { KernelRuntime } from '../../kernel/src/runtime/index.js'
import { startHub } from '../../kernel/src/http/index.js'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import type { WorkflowRunSummary } from '../src/contracts.js'
import { createHerdrPlugin } from '../src/herdr.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { EMPTY_MANAGED_DOC, PaneRegistry, type ManagedDoc } from '../src/herdr/panes.js'
import type { HerdrTarget } from '../src/herdr/contracts.js'
import {
  BaseFakeHerdrTransport,
  HERDR_FAST_TEST_TIMINGS,
  agentInfoOf,
  serveTransport,
  type HerdrPaneStatus,
} from './helpers/herdr-unit-fixture.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  makeConversationSummary,
  makeFauxProvider,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'

class RestartFakeTransport extends BaseFakeHerdrTransport {
  promptStatus: HerdrPaneStatus | Array<HerdrPaneStatus> = 'working'
  snapshotText: string | undefined
  allowReadAfterLost = false
  lastLostReadText = 'secret-line SECRET-TOKEN-VALUE tail'
  closed = false

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.record(target, method, params)
    const errorFactory = this.errors.get(method)
    if (errorFactory) throw errorFactory()
    switch (method) {
      case 'tab.create':
        return this.createTabPane(params, true)
      case 'worktree.create':
        return this.createWorktreePane(params, true)
      case 'tab.close': {
        const tabId = params['tab_id'] as string
        const tab = this.tabs.get(tabId)
        if (!tab) throw new HelmxError('tab_not_found', `no tab ${tabId}`, 404)
        tab.closed = true
        return { type: 'ok' }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.agentStatus = 'idle'
        pane.seq += 1
        return { type: 'agent_started', agent: agentInfoOf(pane), argv: [] }
      }
      case 'agent.get': {
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        const until = ((params['until'] as string[]) ?? []).map((s) => s as HerdrPaneStatus)
        for (let i = 0; i < 2_000; i += 1) {
          if (this.closed || !this.panes.has(pane.paneId)) {
            throw new HelmxError('agent_not_found', `pane ${pane.paneId} closed`, 404)
          }
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          await delay(10)
        }
        throw new HelmxError('timeout', 'timed out waiting for agent status', 408)
      }
      case 'agent.prompt': {
        const ref = params['target']
        const byId = typeof ref === 'string' ? this.panes.get(ref) : undefined
        const pane = byId ?? [...this.panes.values()].find((p) => p.name === ref)
        if (!pane) throw new HelmxError('agent_not_found', `no pane ${String(ref)}`, 404)
        const text = params['text'] as string
        const script = this.promptStatus
        pane.agentStatus = Array.isArray(script) ? (script.shift() ?? 'idle') : script
        pane.seq += 1
        if (this.onPrompt) this.onPrompt(pane, text)
        this.emit({ type: 'pane.updated', paneId: pane.paneId })
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.read': {
        const id = String(params['target'])
        const pane = this.panes.get(id)
        if (!pane) {
          if (this.allowReadAfterLost) {
            return { type: 'pane_read', read: { pane_id: id, text: this.lastLostReadText } }
          }
          throw new HelmxError('agent_not_found', `no pane ${id}`, 404)
        }
        const text = this.snapshotText ?? `tail of ${pane.paneId}: SECRET-TOKEN-VALUE`
        return { type: 'pane_read', read: { pane_id: pane.paneId, text } }
      }
      case 'ping':
        return this.handlePing()
      case 'agent.send_keys': {
        const pane = this.paneOf(params['target'])
        this.assertSendKeysCas(pane, params)
        this.sendKeysLog.push({ paneId: pane.paneId, keys: params['keys'] as string[] })
        return { type: 'ok' }
      }
      case 'pane.report_metadata':
        this.metadataReports.push(params)
        return { type: 'ok' }
      case 'session.snapshot':
        return this.buildSessionSnapshot()
      default:
        throw new HelmxError('method_not_found', `fake transport 不支持 ${method}`, 400)
    }
  }
}

function fileNameOf(promptText: string): string {
  const m = /\.helmx\/(wf-out-[A-Za-z0-9_.-]+\.(json|md))/.exec(promptText)
  if (!m) throw new Error(`prompt 中未找到交接文件名: ${promptText}`)
  return m[1]!
}

type DeferFn = (fn: () => unknown | Promise<unknown>) => void

function useCleanupStack(t: { after: (fn: () => void | Promise<void>) => void }): DeferFn {
  const stack: Array<() => unknown | Promise<unknown>> = []
  t.after(async () => {
    while (stack.length > 0) {
      const fn = stack.pop()!
      await fn()
    }
  })
  return (fn) => {
    stack.push(fn)
  }
}

async function openKernelWithHerdr(
  defer: DeferFn,
  dataDir: string,
  cwd: string,
  socketPath: string,
  options: { configureFirst?: boolean; prePlugins?: PluginDefinition[]; autoStart?: boolean } = {},
): Promise<KernelRuntime> {
  const faux = makeFauxProvider()
  const kernel = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd,
    model: 'faux/faux-1',
    providers: [faux.provider],
    autoResume: false,
  })
  let closePromise: Promise<void> | undefined
  const rawClose = kernel.close.bind(kernel)
  const safeClose = (): Promise<void> => {
    closePromise ??= rawClose()
    return closePromise
  }
  kernel.close = safeClose
  defer(safeClose)
  for (const plugin of options.prePlugins ?? []) {
    await kernel.plugins.register(plugin)
  }
  await kernel.plugins.register(createHerdrPlugin(HERDR_FAST_TEST_TIMINGS), { enabled: false })
  if (options.configureFirst) {
    await kernel.plugins.setConfig('builtin:herdr', { socketPath, startupTimeoutMs: 30_000 })
    await kernel.plugins.enable('builtin:herdr')
  }
  if (options.autoStart !== false) {
    await kernel.start()
  }
  return kernel
}

// ---------------------------------------------------------------------------
// 1. ManagedDoc.panes[i].outputFileName 持久校验与非法边界
// ---------------------------------------------------------------------------

test('PaneRegistry：持久化 outputFileName，恢复严格校验非法文件名抛 herdr_managed_invalid', { timeout: 60_000 }, () => {
  let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [] }
  const mirror = { get: () => doc, set: (next: ManagedDoc) => { doc = next } }
  const reg1 = new PaneRegistry(mirror)
  reg1.add({
    target: { socketPath: '/tmp/herdr.sock' },
    paneId: 'w1:p1',
    tabId: 'w1:t1',
    effectiveCwd: '/tmp/work',
    agentName: 'helmx-wf-1',
    routing: { kind: 'pi' },
    parentConversationId: 1,
    outcome: 'running',
    outputFileName: 'wf-out-abc123.json',
    createdAt: 100,
  })
  assert.equal(doc.panes[0]?.outputFileName, 'wf-out-abc123.json', 'flush 同步写出 outputFileName')

  const reg2 = new PaneRegistry(mirror, doc)
  assert.equal(reg2.get(undefined, 'w1:p1')?.outputFileName, 'wf-out-abc123.json', '重启恢复保留 outputFileName')

  reg2.update(undefined, 'w1:p1', { outcome: 'keepalive', outputFileName: undefined })
  assert.equal(doc.panes[0]?.outputFileName, undefined, '结算置空 outputFileName')

  for (const bad of ['../escape.json', 'evil.txt', 'wf-out-.md', '', 'wf-out-a/b.json']) {
    assert.throws(
      () =>
        new PaneRegistry(mirror, {
          version: 1,
          panes: [
            {
              target: {},
              paneId: 'w1:p1',
              tabId: 'w1:t1',
              effectiveCwd: '/tmp/work',
              agentName: 'helmx-wf-1',
              routing: { kind: 'pi' },
              parentConversationId: 1,
              outcome: 'running',
              outputFileName: bad,
              createdAt: 100,
            },
          ],
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'herdr_managed_invalid',
      `非法交接文件名 ${JSON.stringify(bad)} 必须显式抛 herdr_managed_invalid`,
    )
  }
})

// ---------------------------------------------------------------------------
// 2. T4 场景 ①：优雅关停保活不关窗，重启窗口内文件已写完，reattach 直接过 gate 结算
// ---------------------------------------------------------------------------

test('T4 场景 ①：runtime.close() 保活 running 窗格；重启窗口文件写完后 reattach 直接过 gate 并置 keepalive', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-s1-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-s1-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-s1-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let capturedPromptFile = ''
  let capturedPaneId = ''
  let capturedTabId = ''
  transport.onPrompt = (pane, text) => {
    capturedPromptFile = fileNameOf(text)
    capturedPaneId = pane.paneId
    capturedTabId = pane.tabId
  }

  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' }, value: { type: 'number' } },
    required: ['ok', 'value'],
    additionalProperties: false,
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstSpawn = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '生成结果',
      cwd: workDir,
      schema,
      gate: 'echo gate-pass',
      meta: { 'builtin:workflow': { runId: 'wf_t4_s1' } },
    })
    .catch((err: unknown) => err)

  await waitFor(() => capturedPromptFile !== '')
  // 优雅关停 Hub（ctx.host.isClosing === true）：不得关窗！
  await kernel.close()
  await firstSpawn

  assert.equal(transport.tabs.get(capturedTabId)?.closed, false, 'isClosing=true 关停不得关闭 running 窗格')
  assert.equal(
    transport.calls.filter((c) => c.method === 'tab.close').length,
    0,
    '关停期间不得发任何 tab.close',
  )

  // 重启窗口期内：外部 CLI 完成写交接文件并退出为 done。
  const outputPath = join(workDir, '.helmx', capturedPromptFile)
  mkdirSync(join(workDir, '.helmx'), { recursive: true })
  writeFileSync(outputPath, JSON.stringify({ ok: true, value: 42 }), 'utf8')
  transport.advancePane(capturedPaneId, 'done')

  // 排空关闭前旧 Hub 已写入 UDS 缓冲区但被 abort 的在途请求（如 onPaneEvent 触发的 agent.get），
  // 避免在重启阶段后才被 serveTransport 读取并计入 callsBeforeRestart 之后。
  await server.drain()

  const callsBeforeRestart = transport.calls.length
  const tabsBeforeRestart = transport.calls.filter((c) => c.method === 'tab.create').length
  const startsBeforeRestart = transport.calls.filter((c) => c.method === 'agent.start').length
  const promptsBeforeRestart = transport.calls.filter((c) => c.method === 'agent.prompt').length

  // 重启 KernelRuntime：reconcile() 必须保留该等待 reattach 的 running 窗格。
  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)
  assert.equal(transport.tabs.get(capturedTabId)?.closed, false, 'reconcile 不得误杀已完成待重挂的 running 窗格')

  let resolvedInfo: AgentExecutionInfo | undefined
  let gateOutcome: AgentGateResult | undefined
  const reattachResult = await kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'herdr:pi',
    prompt: '生成结果',
    cwd: workDir,
    schema,
    gate: 'echo gate-pass',
    meta: { 'builtin:workflow': { runId: 'wf_t4_s1' } },
    reattach: { executionId: capturedPaneId, effectiveCwd: workDir },
    onResolved: (info) => {
      resolvedInfo = info
    },
    onGateResult: (res) => {
      gateOutcome = res
    },
  })

  assert.deepEqual(reattachResult, { ok: true, value: 42 })
  assert.equal(resolvedInfo?.executionId, capturedPaneId)
  assert.equal(resolvedInfo?.nodeId, 'local')
  assert.equal(resolvedInfo?.effectiveCwd, workDir)
  assert.equal(gateOutcome?.ok, true, '必须执行 gate 并回调 onGateResult')
  assert.match(gateOutcome?.output ?? '', /gate-pass/)
  assert.equal(existsSync(outputPath), false, '交接文件消费后清理')

  // 不新建窗、不重跑 agent.start、不重发 prompt（也不查多余 agent.get）。
  assert.equal(transport.calls.filter((c) => c.method === 'tab.create').length, tabsBeforeRestart)
  assert.equal(transport.calls.filter((c) => c.method === 'agent.start').length, startsBeforeRestart)
  assert.equal(transport.calls.filter((c) => c.method === 'agent.prompt').length, promptsBeforeRestart)
  assert.ok(
    transport.calls.slice(callsBeforeRestart).every((c) => c.method !== 'agent.get'),
    '交接文件已有效时优先结算，不冗余调用 agent.get',
  )

  const list = (await kernel.plugins.invokeAction('builtin:herdr', 'list', {})) as {
    panes: Array<{ paneId: string; outcome: string }>
  }
  assert.equal(list.panes.find((p) => p.paneId === capturedPaneId)?.outcome, 'keepalive')
})

// ---------------------------------------------------------------------------
// 3. T4 场景 ②：working / blocked(CAS + ask_id_conflict) / steer 重定向 / idle 自愈
// ---------------------------------------------------------------------------

test('T4 场景 ②a：重启后窗格仍 working（含 steer 重定向交接文件），重挂监听与后续 steer 正常完成', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-s2a-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-s2a-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-s2a-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let tabId = ''
  let originalFile = ''
  transport.onPrompt = (pane, text) => {
    if (paneId === '') {
      paneId = pane.paneId
      tabId = pane.tabId
      originalFile = fileNameOf(text)
    }
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstSpawn = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '持续执行任务',
      cwd: workDir,
      meta: { 'builtin:workflow': { runId: 'wf_t4_s2a' } },
    })
    .catch((err: unknown) => err)

  await waitFor(() => paneId !== '')
  await kernel.close()
  await firstSpawn
  assert.equal(transport.tabs.get(tabId)?.closed, false)

  // 重启时窗格仍在 working。
  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)

  const reportsBefore = transport.metadataReports.length
  let resolved: AgentExecutionInfo | undefined
  const reattachPromise = kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'herdr:pi',
    prompt: '持续执行任务',
    cwd: workDir,
    meta: { 'builtin:workflow': { runId: 'wf_t4_s2a' } },
    reattach: { executionId: paneId },
    onResolved: (info) => {
      resolved = info
    },
  })

  await waitFor(() => resolved !== undefined && transport.metadataReports.length > reportsBefore)
  assert.equal(resolved!.executionId, paneId)

  // 重挂恢复 task 阶段后支持继续 steer 重定向交接文件名。
  let steeredFile = ''
  transport.onPrompt = (_pane, text) => {
    steeredFile = fileNameOf(text)
  }
  const steerRes = (await kernel.plugins.invokeAction('builtin:herdr', 'steer', {
    executionId: paneId,
    nodeId: 'local',
    workflowRunId: 'wf_t4_s2a',
    parentConversationId: 1,
    text: '补充要求',
  })) as { steered: boolean }
  assert.equal(steerRes.steered, true)
  assert.ok(steeredFile !== '' && steeredFile !== originalFile)

  // 把旧文件与新文件都写入不同内容，验证只采信最新重定向文件。
  mkdirSync(join(workDir, '.helmx'), { recursive: true })
  writeFileSync(join(workDir, '.helmx', originalFile), 'stale-content', 'utf8')
  writeFileSync(join(workDir, '.helmx', steeredFile), 'reattached-steered-ok', 'utf8')
  transport.advancePane(paneId, 'done')

  const result = await reattachPromise
  assert.equal(result, 'reattached-steered-ok')

  // 验证 isClosing=true 下归属 workflow 的 keepalive 窗格在关停时不误关，直到 workflow.settled 才关闭。
  await kernel.close()
  assert.equal(transport.tabs.get(tabId)?.closed, false, 'workflow keepalive 窗格关停时不误关')
})

test('T4 场景 ②a-续：launch_pending 状态重挂等待就绪后完成，且支持省略 agentType 按 executionId 接管', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-lp-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-lp-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-lp-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let tabId = ''
  let handoffFile = ''
  transport.onPrompt = (pane, text) => {
    paneId = pane.paneId
    tabId = pane.tabId
    handoffFile = fileNameOf(text)
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstSpawn = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: 'launch pending test',
      cwd: workDir,
      meta: { 'builtin:workflow': { runId: 'wf_lp' } },
    })
    .catch((err: unknown) => err)
  await waitFor(() => paneId !== '')
  await kernel.close()
  await firstSpawn

  // 模拟重启时窗格仍在 launch_pending（agentStatus=unknown + launchPending=true）。
  const pane = transport.panes.get(paneId)!
  pane.agentStatus = 'unknown'
  pane.launchPending = true
  pane.seq += 1

  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)

  // 省略 agentType，直接按 executionId 重挂。
  let resolved: AgentExecutionInfo | undefined
  const reattachPromise = kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'launch pending test',
    cwd: workDir,
    meta: { 'builtin:workflow': { runId: 'wf_lp' } },
    reattach: { executionId: paneId },
    onResolved: (info) => {
      resolved = info
    },
  })

  await waitFor(() => resolved !== undefined)
  // 推进 launchPending -> working -> 写交接文件 -> done
  transport.advancePane(paneId, 'working')
  mkdirSync(join(workDir, '.helmx'), { recursive: true })
  writeFileSync(join(workDir, '.helmx', handoffFile), 'launch-pending-ok', 'utf8')
  transport.advancePane(paneId, 'done')

  assert.equal(await reattachPromise, 'launch-pending-ok')

  // workflow.settled 事件到达后正常关闭保活窗格，随后可正常停用插件（isClosing=false）。
  await kernel.emitHostEvent('workflow.settled', { id: 'wf_lp' }, { broadcast: false })
  assert.equal(transport.tabs.get(tabId)?.closed, true, 'workflow.settled 后关闭保活窗格')
  await kernel.plugins.disable('builtin:herdr')
})

test('T4 场景 ②b：重启前 blocked 的窗格重挂后重建 AskDoc（解决 ask_id_conflict）并走 CAS 审批完成', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-s2b-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-s2b-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-s2b-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  transport.promptStatus = 'blocked'
  transport.snapshotText = 'Allow bash?\n1. Yes\n2. No'
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let handoffFile = ''
  transport.onPrompt = (pane, text) => {
    paneId = pane.paneId
    handoffFile = fileNameOf(text)
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const pendingAsks: Array<{ id: string }> = []
  kernel.events.subscribe((frame) => {
    if (frame.event.type === 'ask.upsert' && 'ask' in frame.event && frame.event.ask.status === 'pending') {
      pendingAsks.push({ id: frame.event.ask.id })
    }
  })

  const firstSpawn = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '需要审批的任务',
      cwd: workDir,
    })
    .catch((err: unknown) => err)

  await waitFor(() => pendingAsks.length === 1)
  const preRestartAskId = pendingAsks[0]!.id
  await kernel.close()
  await firstSpawn

  // 重启后窗格仍停留在同一 seq 的 blocked 状态；重挂重建 AskDoc 并推进 :r1。
  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)
  const reattachedAsks: Array<{ id: string }> = []
  kernel.events.subscribe((frame) => {
    if (frame.event.type === 'ask.upsert' && 'ask' in frame.event && frame.event.ask.status === 'pending') {
      reattachedAsks.push({ id: frame.event.ask.id })
    }
  })

  let reattachEarlyErr: unknown
  const reattachPromise = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '需要审批的任务',
      cwd: workDir,
      reattach: { executionId: paneId },
    })
    .catch((err: unknown) => {
      reattachEarlyErr = err
      throw err
    })

  await waitFor(() => reattachedAsks.length === 1 || reattachEarlyErr !== undefined)
  if (reattachEarlyErr !== undefined) throw reattachEarlyErr
  const retryAskId = reattachedAsks[0]!.id
  assert.equal(retryAskId, `${preRestartAskId}:r1`, '同 seq 冲突 AskDoc 自动推进 :r1 重建')

  await kernel.answerAsk(retryAskId, { decision: 'allow-y' })
  await waitFor(() => transport.sendKeysLog.length === 1)
  assert.deepEqual(transport.sendKeysLog[0]!.keys, ['y'])

  mkdirSync(join(workDir, '.helmx'), { recursive: true })
  writeFileSync(join(workDir, '.helmx', handoffFile), 'blocked-recovered-ok', 'utf8')
  transport.advancePane(paneId, 'done')

  assert.equal(await reattachPromise, 'blocked-recovered-ok')
})

test('T4 场景 ②c：重启后窗格已 idle 但缺交接文件 -> 走单次原地追问自愈；仍无文件则诚实违约', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-s2c-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-s2c-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-s2c-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let handoffFile = ''
  transport.onPrompt = (pane, text) => {
    paneId = pane.paneId
    handoffFile = fileNameOf(text)
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstSpawn = kernel
    .spawnAgent({ parentConversationId: 1, agentType: 'herdr:pi', prompt: '写报告', cwd: workDir })
    .catch((err: unknown) => err)
  await waitFor(() => paneId !== '')
  await kernel.close()
  await firstSpawn

  // 重启期间窗格变为 idle 且未写交接文件。
  transport.advancePane(paneId, 'idle')
  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)

  // 自愈追问时模拟 CLI 补写交接文件成功。
  let healCount = 0
  transport.promptStatus = 'done'
  transport.onPrompt = (pane, text) => {
    healCount += 1
    mkdirSync(join(pane.cwd, '.helmx'), { recursive: true })
    writeFileSync(join(pane.cwd, '.helmx', fileNameOf(text)), 'healed-after-restart', 'utf8')
  }

  const output = await kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'herdr:pi',
    prompt: '写报告',
    cwd: workDir,
    reattach: { executionId: paneId },
  })
  assert.equal(healCount, 1, '仅发起一次原地追问自愈')
  assert.equal(output, 'healed-after-restart')
  assert.equal(existsSync(join(workDir, '.helmx', handoffFile)), false)

  // 若自愈追问后仍无交接文件：显式报 herdr_output_contract_violation 并附 40 行脱敏快照、标 failed。
  const dataDir2 = useTempDir(t, 'helmx-herdr-t4-s2c-fail-data-')
  const workDir2 = useTempDir(t, 'helmx-herdr-t4-s2c-fail-work-')
  let paneId2 = ''
  transport.onPrompt = (pane) => {
    paneId2 = pane.paneId
  }
  transport.promptStatus = 'working'
  let kernel2 = await openKernelWithHerdr(defer, dataDir2, workDir2, socketPath, { configureFirst: true })
  const firstSpawn2 = kernel2
    .spawnAgent({ parentConversationId: 1, agentType: 'herdr:pi', prompt: '写报告失败', cwd: workDir2 })
    .catch((err: unknown) => err)
  await waitFor(() => paneId2 !== '')
  await kernel2.close()
  await firstSpawn2

  transport.advancePane(paneId2, 'idle')
  transport.promptStatus = 'done'
  transport.onPrompt = undefined // 自愈后仍不写文件
  kernel2 = await openKernelWithHerdr(defer, dataDir2, workDir2, socketPath)
  kernel2.stash.put(1, 'S', 'SECRET-TOKEN-VALUE')

  await assert.rejects(
    kernel2.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '写报告失败',
      cwd: workDir2,
      reattach: { executionId: paneId2 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'herdr_output_contract_violation')
      assert.ok(/\[REDACTED(?::stash:[0-9a-f-]{36})?\]/.test(err.message))
      assert.ok(!err.message.includes('SECRET-TOKEN-VALUE'))
      return true
    },
  )
  const list2 = (await kernel2.plugins.invokeAction('builtin:herdr', 'list', {})) as {
    panes: Array<{ paneId: string; outcome: string }>
  }
  assert.equal(list2.panes.find((p) => p.paneId === paneId2)?.outcome, 'failed')
})

// ---------------------------------------------------------------------------
// 4. T4 场景 ③：重启后窗格已消失且无文件 -> herdr_pane_lost / herdr_output_contract_violation
// ---------------------------------------------------------------------------

test('T4 场景 ③：重启后窗格已消失且无文件诚实抛 herdr_pane_lost 附脱敏快照并标 failed；有坏文件抛违约', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-s3-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-s3-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-s3-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  transport.allowReadAfterLost = true
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let handoffFile = ''
  transport.onPrompt = (pane, text) => {
    paneId = pane.paneId
    handoffFile = fileNameOf(text)
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  // 注册机密确保快照诊断经过统一脱敏。
  kernel.stash.put(1, 'MY_SECRET', 'SECRET-TOKEN-VALUE')
  const firstSpawn = kernel
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '执行任务',
      cwd: workDir,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    })
    .catch((err: unknown) => err)

  await waitFor(() => paneId !== '')
  await kernel.close()
  await firstSpawn

  // 窗格在重启窗口内从 Herdr 守护进程消失，且无交接文件。
  transport.panes.delete(paneId)

  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath)
  kernel.stash.put(1, 'MY_SECRET', 'SECRET-TOKEN-VALUE')

  await assert.rejects(
    kernel.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '执行任务',
      cwd: workDir,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      reattach: { executionId: paneId },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'herdr_pane_lost')
      assert.ok(/\[REDACTED(?::stash:[0-9a-f-]{36})?\]/.test(err.message), '诊断快照必须脱敏')
      assert.ok(!err.message.includes('SECRET-TOKEN-VALUE'), '不得泄露机密明文')
      return true
    },
  )

  const list = (await kernel.plugins.invokeAction('builtin:herdr', 'list', {})) as {
    panes: Array<{ paneId: string; outcome: string }>
  }
  assert.equal(list.panes.find((p) => p.paneId === paneId)?.outcome, 'failed', '丢失窗格标 failed')

  // 补充：若重启窗口存在损坏 JSON 文件且窗格已消失，显式报 herdr_output_contract_violation。
  const dataDir2 = useTempDir(t, 'helmx-herdr-t4-s3b-data-')
  const workDir2 = useTempDir(t, 'helmx-herdr-t4-s3b-work-')
  let paneId2 = ''
  let handoffFile2 = ''
  transport.onPrompt = (pane, text) => {
    paneId2 = pane.paneId
    handoffFile2 = fileNameOf(text)
  }
  let kernel2 = await openKernelWithHerdr(defer, dataDir2, workDir2, socketPath, { configureFirst: true })
  const firstSpawn2 = kernel2
    .spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '执行任务2',
      cwd: workDir2,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    })
    .catch((err: unknown) => err)
  await waitFor(() => paneId2 !== '')
  await kernel2.close()
  await firstSpawn2

  mkdirSync(join(workDir2, '.helmx'), { recursive: true })
  writeFileSync(join(workDir2, '.helmx', handoffFile2), '{broken json', 'utf8')
  transport.panes.delete(paneId2)
  assert.ok(handoffFile !== '' && handoffFile2 !== '')

  kernel2 = await openKernelWithHerdr(defer, dataDir2, workDir2, socketPath)
  await assert.rejects(
    kernel2.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '执行任务2',
      cwd: workDir2,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      reattach: { executionId: paneId2 },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'herdr_output_contract_violation',
  )
})

// ---------------------------------------------------------------------------
// 5. 启动顺序（先于 herdr.start() 的前置插件 service.start() 重挂）与边界/isClosing=false
// ---------------------------------------------------------------------------

test('前置插件 service.start() 早于 herdr.start() 发起 reattach 也能成功接管（prepare 屏障就位）', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-order-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-order-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-order-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  let paneId = ''
  let handoffFile = ''
  transport.onPrompt = (pane, text) => {
    paneId = pane.paneId
    handoffFile = fileNameOf(text)
  }

  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstSpawn = kernel
    .spawnAgent({ parentConversationId: 1, agentType: 'herdr:pi', prompt: '顺序验证', cwd: workDir })
    .catch((err: unknown) => err)
  await waitFor(() => paneId !== '')
  await kernel.close()
  await firstSpawn

  mkdirSync(join(workDir, '.helmx'), { recursive: true })
  writeFileSync(join(workDir, '.helmx', handoffFile), 'early-start-reattach-ok', 'utf8')
  transport.advancePane(paneId, 'done')

  let earlyReattachResult: unknown
  const preWorkflowStub: PluginDefinition = {
    id: 'test:early-reattach',
    name: 'early-reattach',
    definePlugin(ctx) {
      ctx.service({
        id: 'early-start',
        async start() {
          earlyReattachResult = await ctx.host.spawnAgent({
            parentConversationId: 1,
            agentType: 'herdr:pi',
            prompt: '顺序验证',
            cwd: workDir,
            reattach: { executionId: paneId },
          })
        },
        stop() {},
      })
    },
  }

  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { prePlugins: [preWorkflowStub] })
  assert.equal(earlyReattachResult, 'early-start-reattach-ok', 'herdr.prepare() 就位使前置插件 start() 可立即 reattach')
})

test('reattach 冲突/缺失边界与 isClosing === false 停用仍正常关闭非 failed 窗格', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-t4-edge-data-')
  const workDir = useTempDir(t, 'helmx-herdr-t4-edge-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-t4-edge-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  // A) isClosing === false 场景：PluginHost.dispose()（isClosing=false）仍正常关闭 running 窗格。
  const docs = new MemoryDocStore()
  let paneTabId = ''
  transport.onPrompt = (pane) => {
    paneTabId = pane.tabId
  }
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    config: new MemoryConfigStore({ socketPath }),
    host: {
      ...hostBackendStub(),
      isClosing: (): boolean => false,
      listConversations: () => [makeConversationSummary({ id: 1, cwd: workDir })],
      getConversation: (id) => makeConversationSummary({ id, cwd: workDir }),
      createAsk: async () => ({ id: 'x', status: 'cancelled', answers: {} }),
      runGate: async () => ({ ok: true, output: 'ok' }),
      redact: (s) => s,
      completeText: async () => '',
      buildSpawnEnv: (_c, cwd) => ({ HELMX_CWD: cwd }),
    } satisfies PluginHostBackend,
  })
  let hostDisposed = false
  defer(async () => {
    if (!hostDisposed) {
      hostDisposed = true
      await host.dispose()
    }
  })
  await host.register(createHerdrPlugin(HERDR_FAST_TEST_TIMINGS), { enabled: true })
  await host.start()
  let pendingHookErr: unknown
  const pendingHook = host
    .runHook('agent_spawn', { parentConversationId: 1, agentType: 'herdr:pi', prompt: 'stop test', cwd: workDir })
    .catch((err: unknown) => {
      pendingHookErr = err
      return err
    })
  await waitFor(() => paneTabId !== '' || pendingHookErr !== undefined)
  if (pendingHookErr !== undefined) throw pendingHookErr
  hostDisposed = true
  await host.dispose()
  await pendingHook
  assert.equal(transport.tabs.get(paneTabId)?.closed, true, 'isClosing=false 时停止服务仍必须关闭 running 窗格')

  // B) reattach 边界与冲突拒绝校验。
  const dataDir2 = useTempDir(t, 'helmx-herdr-t4-val-data-')
  const kernel = await openKernelWithHerdr(defer, dataDir2, workDir, socketPath, { configureFirst: true })

  await assert.rejects(
    kernel.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: 'x',
      resume: 'p1',
      reattach: { executionId: 'p1' },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
    'reattach 与 resume 互斥显式报错',
  )

  await assert.rejects(
    kernel.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: 'x',
      fork: true,
      reattach: { executionId: 'p1' },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
    'reattach 与 fork 互斥显式报错',
  )

  await assert.rejects(
    kernel.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: 'x',
      reattach: { executionId: 'nonexistent-pane' },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'herdr_reattach_missing',
    '缺失受管窗格记录显式抛 herdr_reattach_missing',
  )

  // 缺失 outputFileName 的受管记录（如已结算/keepalive 窗格）同样显式抛 herdr_reattach_missing。
  transport.promptStatus = 'done'
  let finishedPaneId = ''
  transport.onPrompt = (pane, text) => {
    finishedPaneId = pane.paneId
    mkdirSync(join(pane.cwd, '.helmx'), { recursive: true })
    writeFileSync(join(pane.cwd, '.helmx', fileNameOf(text)), 'done-output', 'utf8')
  }
  await kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'herdr:pi',
    prompt: '完成并置 keepalive',
    cwd: workDir,
  })
  await assert.rejects(
    kernel.spawnAgent({
      parentConversationId: 1,
      agentType: 'herdr:pi',
      prompt: '完成并置 keepalive',
      cwd: workDir,
      reattach: { executionId: finishedPaneId },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'herdr_reattach_missing',
    'keepalive（已清 outputFileName）窗格重挂显式抛 herdr_reattach_missing',
  )
})

test('PaneRegistry.prune：结算记录有界回收，running/keepalive 绝不回收', { timeout: 60_000 }, () => {
  let doc: ManagedDoc = EMPTY_MANAGED_DOC
  const registry = new PaneRegistry({ get: () => doc, set: (next) => { doc = next } })
  const paneOf = (paneId: string, outcome: 'settled' | 'failed' | 'running' | 'keepalive', at: number) => ({
    target: { socketPath: '/tmp/herdr-prune.sock' },
    paneId,
    tabId: `t-${paneId}`,
    effectiveCwd: '/tmp',
    agentName: 'helmx-wf-x',
    routing: { kind: 'pi' },
    parentConversationId: 1,
    outcome,
    createdAt: at,
    settledAt: outcome === 'running' || outcome === 'keepalive' ? undefined : at,
  })
  registry.add(paneOf('p-run', 'running', 1))
  registry.add(paneOf('p-keep', 'keepalive', 2))
  for (let i = 0; i < 4; i += 1) registry.add(paneOf(`p-s-${i}`, 'settled', 10 + i))
  registry.add(paneOf('p-f-0', 'failed', 5))
  const removed = registry.prune({ maxSettled: 2, maxFailed: 0 })
  assert.equal(removed, 3)
  assert.ok(registry.get(undefined, 'p-run') !== undefined, 'running 绝不回收')
  assert.ok(registry.get(undefined, 'p-keep') !== undefined, 'keepalive 绝不回收')
  assert.equal(registry.get(undefined, 'p-s-0'), undefined)
  assert.equal(registry.get(undefined, 'p-s-1'), undefined)
  assert.ok(registry.get(undefined, 'p-s-2') !== undefined, '保留最近 settled')
  assert.ok(registry.get(undefined, 'p-s-3') !== undefined)
  assert.equal(doc.panes.length, 4, '持久镜像同步收敛')
})

test('Herdr 启动对账：builtin:workflow 处于 enabled=true, status=failed 时不视为 active（不保活孤儿 keepalive，也不调 inspect）', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-herdr-wf-failed-data-')
  const workDir = useTempDir(t, 'helmx-herdr-wf-failed-work-')
  const sockDir = useTempDir(t, 'helmx-herdr-wf-failed-sock-')
  const socketPath = join(sockDir, 'herdr.sock')
  const transport = new RestartFakeTransport()
  const server = await serveTransport(transport, socketPath)
  defer(async () => {
    transport.closed = true
    await server.close()
  })

  // 1. 首次启动：完成一次挂有 workflowRunId 的 herdr spawn，进入 keepalive 状态并优雅关停（保留窗格与持久化记录）
  transport.promptStatus = 'done'
  transport.onPrompt = (pane, text) => {
    mkdirSync(join(pane.cwd, '.helmx'), { recursive: true })
    writeFileSync(join(pane.cwd, '.helmx', fileNameOf(text)), 'done-for-keepalive', 'utf8')
  }
  let kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, { configureFirst: true })
  const firstOut = await kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'herdr:pi',
    prompt: '产生 workflow keepalive 窗格',
    cwd: workDir,
    meta: { 'builtin:workflow': { runId: 'wf_failed_plugin_run' } },
  })
  assert.equal(firstOut, 'done-for-keepalive')
  await kernel.close()
  assert.equal(transport.calls.filter((c) => c.method === 'tab.close').length, 0, '优雅关停不关闭 keepalive 窗格')

  // 2. 重启并注册依赖 dep:base 的 builtin:workflow，在 start() 前强停 dep:base 使其真实落入 enabled=true, status='failed'
  let inspectCalls = 0
  const depBase: PluginDefinition = {
    id: 'dep:base',
    name: 'Dep Base',
    definePlugin() {},
  }
  const fakeWorkflow: PluginDefinition = {
    id: 'builtin:workflow',
    name: 'Fake Workflow',
    dependencies: ['dep:base'],
    definePlugin(ctx) {
      ctx.action({
        id: 'inspect',
        description: 'stub inspect',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'] },
        handler: async () => {
          inspectCalls += 1
          return { run: { status: 'running' } }
        },
      })
    },
  }

  kernel = await openKernelWithHerdr(defer, dataDir, workDir, socketPath, {
    prePlugins: [depBase, fakeWorkflow],
    autoStart: false,
  })
  await kernel.plugins.disable('dep:base', { force: true })
  const wfSummary = kernel.plugins.list().find((p) => p.id === 'builtin:workflow')
  assert.equal(wfSummary?.enabled, true)
  assert.equal(wfSummary?.status, 'failed')

  await kernel.start()
  // reconcile() 应将 failed workflow 视为不活跃 -> 立即回收该空闲 keepalive 孤儿窗格；reconcileWorkflowOrphansAfterStartup 亦不得调 inspect
  await waitFor(() => transport.calls.filter((c) => c.method === 'tab.close').length === 1)
  assert.equal(inspectCalls, 0, 'builtin:workflow 处于 failed 状态时不得调用其 inspect 动作')
})

test('Workflow + Herdr 远端动态 nodeId 与跨重启外部 executionId reattach：subagent 与 DSL agent 均路由远端节点并在重启后携带 nodeId 命中远端窗格', { timeout: 60_000 }, async (t) => {
  const defer = useCleanupStack(t)
  const dataDir = useTempDir(t, 'helmx-wf-herdr-remote-data-')
  const localWorkDir = useTempDir(t, 'helmx-wf-herdr-local-work-')
  const remoteWorkDir = useTempDir(t, 'helmx-wf-herdr-remote-work-')
  const nodeDataDir = useTempDir(t, 'helmx-wf-herdr-node-data-')
  const sockDir = useTempDir(t, 'helmx-wf-herdr-sock-')
  const localSocketPath = join(sockDir, 'local-herdr.sock')
  const remoteSocketPath = join(sockDir, 'remote-herdr.sock')

  const localTransport = new RestartFakeTransport()
  const remoteTransport = new RestartFakeTransport()
  const localServer = await serveTransport(localTransport, localSocketPath)
  const remoteServer = await serveTransport(remoteTransport, remoteSocketPath)
  defer(async () => {
    localTransport.closed = true
    remoteTransport.closed = true
    await localServer.close()
    await remoteServer.close()
  })

  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let daemon: NodeDaemon | undefined
  const closeRemoteStack = async () => {
    const d = daemon
    const h = hub
    daemon = undefined
    hub = undefined
    await d?.close()
    await h?.close()
  }
  defer(closeRemoteStack)

  const openRemoteStack = async (opts: { configureFirst?: boolean; nodeToken?: string }) => {
    const kernel = await openKernelWithHerdr(defer, dataDir, localWorkDir, localSocketPath, {
      configureFirst: opts.configureFirst,
      prePlugins: [createWorkflowPlugin()],
      autoStart: false,
    })
    const token = opts.nodeToken ?? (await kernel.issueNodeToken('remote-herdr-node')).token
    hub = await startHub({ kernel: kernel as never, port: 0 })
    daemon = await createNodeDaemon({
      hubUrl: hub.url,
      identity: { nodeId: 'remote-herdr-node', token },
      dataDir: nodeDataDir,
      envServer: {
        hostEnvContext: {
          getEnv: (name) => (name === 'HERDR_SOCKET_PATH' ? remoteSocketPath : undefined),
        },
      },
      reconnectBaseDelayMs: 50,
      log: () => undefined,
    })
    assert.equal(await daemon.waitUntilRegistered(5_000), true)
    assert.equal(kernel.envFabric.isOnline('remote-herdr-node'), true)
    await kernel.start()
    return { kernel, token }
  }

  // ---- Phase 1: DSL agent({ agentType: 'herdr:pi', nodeId: 'remote-herdr-node', cwd: remoteWorkDir }) completes on remote node ----
  remoteTransport.promptStatus = 'done'
  remoteTransport.onPrompt = (pane, text) => {
    mkdirSync(join(pane.cwd, '.helmx'), { recursive: true })
    writeFileSync(join(pane.cwd, '.helmx', fileNameOf(text)), 'dsl-remote-direct-ok', 'utf8')
  }

  const phase1 = await openRemoteStack({ configureFirst: true })
  const { token: nodeToken } = phase1
  let kernel = phase1.kernel

  const directScript =
    'export const meta = { name: "wf-herdr-remote-direct", description: "remote direct" }\n' +
    `return await agent("direct remote herdr task", { agentType: "herdr:pi", nodeId: "remote-herdr-node", cwd: ${JSON.stringify(remoteWorkDir)} })`
  const { run: directRun } = (await kernel.plugins.invokeAction('builtin:workflow', 'run', {
    conversationId: 1,
    script: directScript,
    wait: true,
  })) as { run: WorkflowRunSummary }
  assert.equal(directRun.status, 'completed', directRun.error ?? JSON.stringify(directRun.nodes))
  assert.equal(directRun.result, 'dsl-remote-direct-ok', JSON.stringify(directRun.nodes))
  assert.equal(localTransport.calls.filter((c) => c.method === 'tab.create').length, 0, 'local Herdr must not receive remote nodeId spawns')
  assert.equal(remoteTransport.calls.filter((c) => c.method === 'tab.create').length, 1)
  assert.equal(remoteTransport.calls.findLast((c) => c.method === 'tab.create')?.params['cwd'], remoteWorkDir)

  // ---- Phase 2: In-flight background subagent AND DSL agent on remote-herdr-node -> close() -> restart external executionId reattach ----
  const captured = new Map<string, { paneId: string; tabId: string; handoffFile: string }>()
  remoteTransport.promptStatus = 'working'
  remoteTransport.onPrompt = (pane, text) => {
    const tag = text.includes('BG_REMOTE_REATTACH') ? 'bg' : text.includes('DSL_REMOTE_REATTACH') ? 'dsl' : 'other'
    captured.set(tag, { paneId: pane.paneId, tabId: pane.tabId, handoffFile: fileNameOf(text) })
  }

  // 2a) Background subagent tool with dynamic remote nodeId
  const bgToolOut = (await kernel.plugins.executeTool(
    'subagent',
    {
      prompt: 'BG_REMOTE_REATTACH',
      agentType: 'herdr:pi',
      nodeId: 'remote-herdr-node',
      cwd: remoteWorkDir,
      background: true,
    },
    { conversationId: 1, callId: 'call-wf-herdr-remote-bg' },
  )) as {
    structuredOutput: {
      ok: boolean
      background: boolean
      runId: string
      execution?: { executionId?: string; nodeId?: string; effectiveCwd?: string }
    }
  }
  assert.equal(bgToolOut.structuredOutput.ok, true)
  assert.equal(bgToolOut.structuredOutput.background, true)
  const bgRunId = bgToolOut.structuredOutput.runId
  assert.equal(bgToolOut.structuredOutput.execution?.nodeId, 'remote-herdr-node')
  assert.equal(bgToolOut.structuredOutput.execution?.effectiveCwd, remoteWorkDir)

  // 2b) Workflow DSL agent with dynamic remote nodeId (async start, suspends while pane is working)
  const dslReattachScript =
    'export const meta = { name: "wf-herdr-remote-reattach", description: "remote dsl reattach" }\n' +
    `return await agent("DSL_REMOTE_REATTACH", { agentType: "herdr:pi", nodeId: "remote-herdr-node", cwd: ${JSON.stringify(remoteWorkDir)} })`
  const { run: dslRunBefore } = (await kernel.plugins.invokeAction('builtin:workflow', 'run', {
    conversationId: 1,
    script: dslReattachScript,
  })) as { run: WorkflowRunSummary }
  const dslRunId = dslRunBefore.id

  await waitFor(() => captured.has('bg') && captured.has('dsl'), { timeoutMs: 10_000 })
  const bgInfo = captured.get('bg')!
  const dslInfo = captured.get('dsl')!
  assert.equal(bgToolOut.structuredOutput.execution?.executionId, bgInfo.paneId)
  // Wait for DSL workflow journal agent_started to capture executionId before shutdown
  await waitFor(async () => {
    const inspected = (await kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: dslRunId })) as {
      run: WorkflowRunSummary
    }
    return inspected.run.nodes?.some((n) => n.executionId === dslInfo.paneId) === true
  }, { timeoutMs: 10_000 })

  // Graceful Hub shutdown: remote panes stay alive (zero tab.close), workflow suspends both runs cleanly
  await kernel.close()
  await closeRemoteStack()
  assert.equal(remoteTransport.tabs.get(bgInfo.tabId)?.closed, false, 'shutdown must keep remote bg Herdr pane alive')
  assert.equal(remoteTransport.tabs.get(dslInfo.tabId)?.closed, false, 'shutdown must keep remote DSL Herdr pane alive')

  // During restart window: both remote CLI panes write their handoff outputs and settle to done
  mkdirSync(join(remoteWorkDir, '.helmx'), { recursive: true })
  writeFileSync(join(remoteWorkDir, '.helmx', bgInfo.handoffFile), 'bg-remote-herdr-reattached-ok', 'utf8')
  writeFileSync(join(remoteWorkDir, '.helmx', dslInfo.handoffFile), 'dsl-remote-herdr-reattached-ok', 'utf8')
  remoteTransport.advancePane(bgInfo.paneId, 'done')
  remoteTransport.advancePane(dslInfo.paneId, 'done')
  await remoteServer.drain()

  const remoteCreatesBeforeRestart = remoteTransport.calls.filter((c) => c.method === 'tab.create').length

  // Restart Hub with remote-herdr-node online: workflow auto-recovers BOTH runs via external executionId reattach + nodeId
  const phase2 = await openRemoteStack({ nodeToken })
  kernel = phase2.kernel

  await waitFor(async () => {
    const bgInspected = (await kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: bgRunId })) as {
      run: WorkflowRunSummary
    }
    const dslInspected = (await kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: dslRunId })) as {
      run: WorkflowRunSummary
    }
    return bgInspected.run.status !== 'running' && dslInspected.run.status !== 'running'
  }, { timeoutMs: 20_000 })

  const bgFinal = ((await kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: bgRunId })) as {
    run: WorkflowRunSummary
  }).run
  const dslFinal = ((await kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: dslRunId })) as {
    run: WorkflowRunSummary
  }).run

  assert.equal(bgFinal.status, 'completed', `background subagent remote reattach failed: ${bgFinal.error ?? ''}`)
  assert.equal(bgFinal.result, 'bg-remote-herdr-reattached-ok')
  assert.equal(dslFinal.status, 'completed', `DSL agent remote reattach failed: ${dslFinal.error ?? ''}`)
  assert.equal(
    dslFinal.result,
    'dsl-remote-herdr-reattached-ok',
    `dslFinal=${JSON.stringify(dslFinal)}`,
  )

  // Zero duplicate pane spawns on either local or remote Herdr
  assert.equal(localTransport.calls.filter((c) => c.method === 'tab.create').length, 0)
  assert.equal(
    remoteTransport.calls.filter((c) => c.method === 'tab.create').length,
    remoteCreatesBeforeRestart,
    'external reattach must reuse existing remote panes without spawning new tabs',
  )
  // Wait for parent #1 background report turn to settle before closing kernel
  await waitFor(() => kernel.getConversation(1).status !== 'working', { timeoutMs: 10_000 })
})
