/**
 * builtin:workflow 三区零重复与无损信息客户端全链路验收测试：
 * 1. 底部活动托盘（WorkflowActiveTray，基于 @helmx/ui DockTray / DockTrayRow）：
 *    - 无在途任务返回 null（0px，零 1Hz 计时器挂载）；
 *    - 在途展示单行 HUD，展开列任务清单并支持中止、工作台跳转、子会话抽屉导航，收敛后归零；
 *    - 容器行与嵌套子代理行在 blocked 审批态优先展示审批标题（压过 working 命令）；
 *    - 自身 settled 但子孙在途时展示子孙实时命令，绝不拿旧 doing 冒充；
 *    - live 行传 includeDetail:false 不主动拉取详情。
 * 2. 时间线单行收口：
 *    - SubagentToolView：后台派发句柄绝不暴露 ~34ms 派发确认耗时；无导航目标时行不可点、不内嵌调用详情（展开入口由宿主提供）；
 *    - WorkflowWorkbenchPanel：响应 params.runId 聚焦直开高亮，右上角 Library 按钮跳转工作流库；
 *    - 全表面零 Emoji 约束。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationLive } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowSurfaces,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })
const mod = await importWorkflowSurfaces(['index.tsx', 'workbench.tsx'], undefined, { realHooks: true })
const WorkflowActiveTray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
const SubagentToolView = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>

test('WorkflowActiveTray：无在途归零 0px，在途展示 DockTray 并支持展开/中止/导航与收敛消失', { timeout: 60_000 }, async () => {
  const runningSub: WorkflowRunSummary = {
    id: 'wf_tray_sub_11',
    name: 'subagent',
    conversationId: 1,
    status: 'running',
    kind: 'subagent',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_002_000,
    nodes: [{ id: 's0', label: 'subagent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const runningWf: WorkflowRunSummary = {
    id: 'wf_tray_1',
    name: '构建与测试流水线',
    conversationId: 1,
    status: 'running',
    kind: 'workflow',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    nodes: [
      { id: 'build', label: '编译构建', kind: 'action', status: 'done' },
      { id: 'test', label: '运行测试', kind: 'agent', status: 'running', conversationId: 11 },
    ],
  }
  const rootConv = makeConvSummary(1, { ownedBy: 'human' })
  const child11 = makeConvSummary(11, { parentConversationId: 1, status: 'working', title: '执行测试子会话' })
  const humanFork = makeConvSummary(99, { parentConversationId: 1, ownedBy: 'human', status: 'working', title: '人类分叉分支' })

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [rootConv, child11, humanFork],
    runsByConversation: { 1: [runningSub] },
    locale: 'en',
  })

  const ui = h.mountNode(e(WorkflowActiveTray, { conversation: rootConv }))
  try {
    // 1. 有在途 subagent 时渲染 DockTray，人类分叉 #99 绝不混入
    const barToggle = ui.container.querySelector('button[aria-expanded]') as HTMLButtonElement | null
    assert.ok(barToggle !== null, '在途任务应渲染 DockTray 展开开关')
    act(() => barToggle.click())
    assert.equal(ui.container.textContent?.includes('人类分叉分支'), false)

    const childMainBtn = [...ui.container.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').includes('执行测试子会话') && b.getAttribute('aria-expanded') === null,
    ) as HTMLButtonElement | undefined
    assert.ok(childMainBtn !== undefined)
    act(() => childMainBtn.click())
    assert.equal(h.log.drawers.at(-1), 11)

    // 2. 清空 runs -> 即使人类分叉仍在 working，托盘归零为 0px（空 DOM）
    h.setConversations([rootConv, { ...child11, status: 'idle' }, humanFork])
    h.setRuns(1, [])
    assert.equal(ui.container.innerHTML, '', '无在途任务时必须返回 null（0px）')

    // 3. 注入运行中工作流 -> 显示进度 1/2，支持展开、中止、直达工作台
    h.setConversations([rootConv, child11, humanFork])
    h.setRuns(1, [runningWf])
    assert.ok(ui.container.textContent?.includes('1/2'))
    const wfToggle = ui.container.querySelector('button[aria-expanded]') as HTMLButtonElement
    act(() => wfToggle.click())

    const abortBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Abort'))
    assert.ok(abortBtn !== undefined)
    await act(async () => { abortBtn.click() })
    assert.equal(h.log.actions.at(-1)?.actionId, 'abort')
    assert.deepEqual(h.log.actions.at(-1)?.input, { runId: 'wf_tray_1' })

    const tasksBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Tasks'))
    assert.ok(tasksBtn !== undefined)
    act(() => tasksBtn.click())
    assert.equal(h.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks')

    // 4. 全部结算 -> 再次归零
    h.setConversations([rootConv, { ...child11, status: 'idle' }, humanFork])
    h.setRuns(1, [{ ...runningWf, status: 'completed', nodes: runningWf.nodes?.map((n) => ({ ...n, status: 'done' as const })) }])
    assert.equal(ui.container.innerHTML, '')
  } finally {
    ui.unmount()
  }
})

test('WorkflowActiveTray：子树 live bash 命令透传、审批优先于 working 命令、settled 父展示子孙 live 且零 detail 拉取', { timeout: 60_000 }, () => {
  const rootConv = makeConvSummary(1, { ownedBy: 'human' })
  const deployLive: ConversationLive = {
    conversationId: 11,
    text: '',
    tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm --filter @helmx/plugins test' }, status: 'running' }],
    updatedAt: 1_700_000_020_000,
  }
  const deepWf: WorkflowRunSummary = {
    id: 'wf_tray_deep',
    name: '深水流水线',
    conversationId: 1,
    status: 'running',
    kind: 'workflow',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    nodes: [
      { id: 'build', label: '编译', kind: 'action', status: 'done' },
      { id: 'deploy', label: '部署', kind: 'agent', status: 'running', conversationId: 11 },
    ],
  }
  const h1 = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [rootConv, makeConvSummary(11, { parentConversationId: 1, status: 'working', title: '部署子会话' })],
    conversationLives: { 11: deployLive },
    runsByConversation: { 1: [deepWf] },
    locale: 'en',
  })
  const ui1 = h1.mountNode(e(WorkflowActiveTray, { conversation: rootConv }))
  try {
    assert.ok(ui1.container.textContent?.includes('pnpm --filter @helmx/plugins test'), '顶栏透传容器子树实时 bash 命令')
    assert.deepEqual(h1.log.loadDetailCalls, [], '托盘严禁主动拉取详情')
    act(() => { (ui1.container.querySelector('button[aria-expanded]') as HTMLButtonElement).click() })
    const wfRowBtn = [...ui1.container.querySelectorAll('button')].find(
      (b) => (b.textContent ?? '').includes('深水流水线') && b.getAttribute('aria-expanded') === null,
    ) as HTMLButtonElement
    act(() => wfRowBtn.click())
    assert.equal(h1.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks', '容器行点击仍打开工作台而非子孙抽屉')
    assert.deepEqual(h1.log.drawers, [])
  } finally {
    ui1.unmount()
  }

  // working 父子代理 + blocked 子子代理：审批标题优先于父级 working bash 命令
  const hBlocked = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [
      rootConv,
      makeConvSummary(21, { parentConversationId: 1, status: 'working', title: '正在构建', doing: 'pnpm build' }),
      makeConvSummary(31, { parentConversationId: 21, status: 'blocked', title: '确认部署', pendingAskCount: 1 }),
    ],
    conversationLives: {
      21: { conversationId: 21, text: '', tools: [{ callId: 'c21', toolName: 'bash', input: { command: 'pnpm build' }, status: 'running' }], updatedAt: 1 },
    },
    pendingAsks: [{ id: 'ask-nested', conversationId: 31, title: '确认部署到生产环境', fields: [], status: 'pending', createdAt: 1 }],
    runsByConversation: {
      1: [
        { id: 'wf_p', kind: 'subagent', name: '运行子代理', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 2, nodes: [{ id: 'p', kind: 'agent', status: 'running', conversationId: 21 }] },
        { id: 'wf_c', kind: 'subagent', name: '待审批', conversationId: 21, status: 'running', createdAt: 2, updatedAt: 3, nodes: [{ id: 'c', kind: 'agent', status: 'running', conversationId: 31 }] },
      ],
    },
    locale: 'en',
  })
  const uiBlocked = hBlocked.mountNode(e(WorkflowActiveTray, { conversation: rootConv }))
  try {
    assert.ok(uiBlocked.container.textContent?.includes('确认部署到生产环境'), '审批标题必须压过 working 命令')
    assert.equal(uiBlocked.container.textContent?.includes('pnpm build'), false)
  } finally {
    uiBlocked.unmount()
  }

  // 自身 settled 但子孙仍在运行：展示子孙 live 命令，不泄漏自身旧 doing
  const hSettled = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [
      rootConv,
      makeConvSummary(11, { parentConversationId: 1, status: 'done', title: '调度子代理', doing: '旧收尾文案' }),
      makeConvSummary(21, { parentConversationId: 11, status: 'working', title: '实际干活' }),
    ],
    conversationLives: {
      21: { conversationId: 21, text: '', tools: [{ callId: 'c21b', toolName: 'bash', input: { command: 'pnpm --filter web build' }, status: 'running' }], updatedAt: 1 },
    },
    runsByConversation: {
      1: [
        { id: 'wf_s', kind: 'subagent', name: '调度子代理', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2, nodes: [{ id: 's', kind: 'agent', status: 'done', conversationId: 11 }] },
        { id: 'wf_d', kind: 'subagent', name: '子任务', conversationId: 11, status: 'running', createdAt: 3, updatedAt: 4, nodes: [{ id: 'd', kind: 'agent', status: 'running', conversationId: 21 }] },
      ],
    },
    locale: 'en',
  })
  const uiSettled = hSettled.mountNode(e(WorkflowActiveTray, { conversation: rootConv }))
  try {
    assert.ok(uiSettled.container.textContent?.includes('pnpm --filter web build'))
    assert.equal(uiSettled.container.textContent?.includes('旧收尾文案'), false)
  } finally {
    uiSettled.unmount()
  }
})

test('SubagentToolView 后台句柄禁暴露 ~34ms、无导航目标行不可点；WorkflowWorkbenchPanel 聚焦 runId 高亮', { timeout: 60_000 }, () => {
  const rootConv = makeConvSummary(1, { ownedBy: 'human' })
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [rootConv],
    runsByConversation: {
      1: [
        { id: 'wf_first', kind: 'workflow', name: '首个流', conversationId: 1, status: 'completed', createdAt: 10, updatedAt: 20, nodes: [] },
        { id: 'wf_target', kind: 'workflow', name: '目标流', conversationId: 1, status: 'completed', createdAt: 5, updatedAt: 8, nodes: [] },
      ],
    },
    locale: 'en',
  })

  // 1. 后台派发句柄禁暴露 34ms
  const handleUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'call_bg_handle',
      toolName: 'subagent',
      input: { prompt: '后台审计', background: true },
      status: 'done',
      result: '已转入后台',
      presentationMeta: { ok: true, background: true, runId: 'wf_bg_handle', status: 'running' },
      durationMs: 34,
      conversationId: 1,
    }),
  )
  try {
    const text = handleUi.container.textContent ?? ''
    assert.ok(text.includes('Running in background'))
    assert.equal(text.includes('34ms'), false, '绝不可将派发确认耗时 34ms 当成子会话总耗时展示')
    act(() => { (handleUi.container.querySelector('button.wf-trace-toggle') as HTMLElement).click() })
    assert.equal(h.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks')
  } finally {
    handleUi.unmount()
  }

  // 2. 未落库前置错误：无导航目标 → 行主体是同 class 的非交互元素，不在行内伪造 ToolCallDetails
  //    展开块（折叠/展开入口由宿主 .trace-block-head 行首 chevron 提供），错误首行仍在摘要中如实可见
  const errUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'call_err',
      toolName: 'subagent',
      input: { prompt: '非法参数' },
      status: 'error',
      result: 'Invalid nodeId parameter',
      conversationId: 1,
    }),
  )
  try {
    assert.ok(errUi.container.querySelector('button.wf-trace-toggle') === null, '无导航目标时不渲染可点击的行按钮')
    assert.ok(errUi.container.querySelector('button.trace-row') === null, '整行不存在其他可点按钮')
    const rowBody = errUi.container.querySelector<HTMLElement>('.wf-trace-toggle')
    assert.ok(rowBody !== null && rowBody.tagName === 'DIV', '行主体渲染为同 class 的非交互 div')
    assert.equal(rowBody!.getAttribute('aria-expanded'), null, '不声明折叠语义')
    assert.equal(rowBody!.getAttribute('aria-controls'), null, '不指向任何展开面板')
    assert.match(errUi.container.querySelector('.trace-row')?.className ?? '', /\bwf-trace-row-static\b/, '静态行标记不可点光标修饰类')
    act(() => rowBody!.click())
    assert.ok(errUi.container.querySelector('details') === null, '点击不展开任何内嵌调用详情')
    assert.equal(h.log.workbenchTabs.length, 1, '点击静态行不触发工作台跳转（仅前序用例的一次）')
    assert.ok(errUi.container.textContent?.includes('Invalid nodeId parameter'), '错误首行仍在行摘要中如实展示')
  } finally {
    errUi.unmount()
  }

  // 3. WorkflowWorkbenchPanel 响应 params.runId 聚焦高亮 + Library 按钮跳转
  const wbUi = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: rootConv, params: { runId: 'wf_target' } }))
  try {
    const focused = wbUi.container.querySelector('[data-run-id="wf_target"]')
    assert.ok(focused !== null && focused.classList.contains('wf-workbench-focused'))
    const libBtn = [...wbUi.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Library'))!
    act(() => libBtn.click())
    assert.equal(h.log.screens.at(-1), 'screen:builtin:workflow/library')
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(wbUi.container.innerHTML), false, '零 Emoji')
  } finally {
    wbUi.unmount()
  }
})
