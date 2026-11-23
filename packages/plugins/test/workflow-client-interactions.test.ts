/**
 * builtin:workflow 插件 client 交互测试（真实编译产物 + 共享宿主 SDK + DOM 事件）：
 * - SubagentToolView / WorkflowToolView 点击导航抽屉或工作台、未落库错误可展开 ToolCallDetails；
 * - WorkflowWorkbenchPanel 顶栏状态（loading / error / empty）与「恢复失败 (N)」批量续跑（防连点 + skipped + 非法返回报错）；
 * - ExecutionNodeRow 主体 button 打开抽屉、同级动作区 Abort / Resume / worktree-cleanup 无嵌套交互不冒泡；
 * - 单卡 Resume 防连点、传 { resumeFromRunId, conversationId } 且 resumedByRunId 接管后隐藏。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorktreeClientModule,
  makeConvSummary,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
  type WorktreeSlotComponents,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const mod = await importWorkflowClientModule('index.tsx', undefined, { realHooks: true })
const SubagentToolView = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowToolView = mod['WorkflowToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
const worktreeSlots = (await importWorktreeClientModule('slots.tsx', undefined, { realHooks: true, scope: 'interactions-wt' })) as WorktreeSlotComponents

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== undefined, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found
}

test('时间线行与工作台节点主按钮点击触发 openConversationDrawer，动作按钮为同级 sibling 不冒泡', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child11 = makeConvSummary(11, { parentConversationId: 1, parentToolCallId: 'call-bg', status: 'working', doing: '正在跑测试' })
  const bgRun: WorkflowRunSummary = {
    id: 'wf_bg',
    name: '后台任务',
    conversationId: 1,
    kind: 'subagent',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'call-bg',
    nodes: [{ id: 'n', kind: 'agent', status: 'running', conversationId: 11, worktree: { path: '/wt/x', branch: 'helmx/x' } }],
  }
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child11],
    runsByConversation: { 1: [bgRun] },
    worktreeSlots,
    locale: 'en',
  })

  // 1. SubagentToolView 点击打开抽屉
  const toolUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'call-bg',
      toolName: 'subagent',
      input: { prompt: '去修构建' },
      status: 'running',
      conversationId: 1,
    }),
  )
  try {
    const row = toolUi.container.querySelector('button.wf-trace-toggle') as HTMLButtonElement | null
    assert.ok(row !== null)
    act(() => row.click())
    assert.deepEqual(h.log.drawers, [11])
    assert.deepEqual(h.log.screens, [])
  } finally {
    toolUi.unmount()
  }

  // 2. WorkflowWorkbenchPanel 内 ExecutionNodeRow：主按钮打开抽屉、同级 Abort 与 worktree-cleanup 不触发抽屉
  h.log.drawers.length = 0
  const wbUi = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    const mainBtn = wbUi.container.querySelector('button.wf-node-clickable') as HTMLButtonElement | null
    assert.ok(mainBtn !== null)
    assert.equal(mainBtn.querySelectorAll('button').length, 0, '主导航按钮内严禁嵌套交互元素')
    act(() => mainBtn.click())
    assert.deepEqual(h.log.drawers, [11])

    h.log.drawers.length = 0
    const abortBtn = wbUi.container.querySelector('.wf-node-actions .btn-danger') as HTMLButtonElement | null
    assert.ok(abortBtn !== null)
    await act(async () => { abortBtn.click() })
    const cleanupBtn = wbUi.container.querySelector('[aria-label="Clean up isolated worktree"]') as HTMLButtonElement | null
    assert.ok(cleanupBtn !== null, 'worktree-cleanup 插槽应在动作区立即可用')
    await act(async () => { cleanupBtn.click() })
    assert.deepEqual(
      h.log.actions.map((a) => [a.pluginId, a.actionId, a.input]),
      [
        ['builtin:workflow', 'abort', { runId: 'wf_bg' }],
        ['builtin:worktree', 'cleanup_worktree', { path: '/wt/x' }],
      ],
    )
    assert.deepEqual(h.log.drawers, [], '动作按钮点击绝不触发打开抽屉')
  } finally {
    wbUi.unmount()
  }
})

test('WorkflowToolView 点击定位工作台 runId；外部子代理点击定位工作台不虚构原生子会话', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const wfRun: WorkflowRunSummary = {
    id: 'wf_nodes',
    name: '节点工作流',
    conversationId: 1,
    kind: 'workflow',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'wf_call',
    nodes: [{ id: 'n1', kind: 'action', status: 'done', label: '落盘报告', output: 'ok' }],
  }
  const extRun: WorkflowRunSummary = {
    id: 'wf_ext',
    name: '外部任务',
    conversationId: 1,
    kind: 'subagent',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'ext_call',
    nodes: [{ id: 'e1', kind: 'agent', status: 'done', executionId: 'pane-42' }],
  }
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [wfRun, extRun] },
    locale: 'en',
  })

  const wfUi = h.mountNode(e(WorkflowToolView, { callId: 'wf_call', toolName: 'SubagentWorkflow', input: { script: 'x' }, status: 'done', conversationId: 1 }))
  try {
    act(() => { (wfUi.container.querySelector('button.wf-trace-toggle') as HTMLElement).click() })
    assert.equal(h.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks')
    assert.deepEqual(h.log.workbenchParams.at(-1), { runId: 'wf_nodes' })
  } finally {
    wfUi.unmount()
  }

  const extUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'ext_call',
      toolName: 'subagent',
      input: { prompt: '外部任务' },
      status: 'done',
      presentationMeta: { ok: true, execution: { executionId: 'pane-42' } },
      conversationId: 1,
    }),
  )
  try {
    act(() => { (extUi.container.querySelector('button.wf-trace-toggle') as HTMLElement).click() })
    assert.deepEqual(h.log.drawers, [])
    assert.deepEqual(h.log.workbenchParams.at(-1), { runId: 'wf_ext' })
  } finally {
    extUi.unmount()
  }
})

test('单卡后台子代理 Resume：派发 run({ resumeFromRunId, conversationId })、防连点、resumedByRunId 接管后隐藏', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child11 = makeConvSummary(11, { parentConversationId: 1, status: 'error' })
  const failedSub: WorkflowRunSummary = {
    id: 'wf_sub_fail',
    name: '子代理任务',
    conversationId: 1,
    kind: 'subagent',
    status: 'failed',
    resumable: true,
    error: '上游网关超时',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 's0', kind: 'agent', status: 'failed', conversationId: 11 }],
  }
  let resolveRun: ((val: unknown) => void) | undefined
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child11],
    runsByConversation: { 1: [failedSub] },
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'run') {
        return new Promise((resolve) => { resolveRun = resolve })
      }
      return undefined
    },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    const resumeBtn = [...ui.container.querySelectorAll('.wf-node-actions button')].find((b) => (b.textContent ?? '').includes('Resume')) as HTMLButtonElement | undefined
    assert.ok(resumeBtn !== undefined)
    await act(async () => {
      resumeBtn.click()
      resumeBtn.click()
    })
    assert.deepEqual(
      h.log.actions.map((a) => [a.actionId, a.input]),
      [['run', { resumeFromRunId: 'wf_sub_fail', conversationId: 1 }]],
    )
    assert.equal(resumeBtn.disabled, true)
    assert.ok(resumeBtn.querySelector('svg.spin-slow') !== null)
    assert.deepEqual(h.log.drawers, [])

    await act(async () => { resolveRun?.({ run: { id: 'wf_sub_resumed' } }) })
    assert.equal(resumeBtn.disabled, false)
    assert.ok(h.log.notices.some((n) => n.message.includes('Resume initiated')))

    h.setRuns(1, [{ ...failedSub, resumedByRunId: 'wf_sub_resumed' }])
    assert.equal(
      [...ui.container.querySelectorAll('.wf-node-actions button')].some((b) => (b.textContent ?? '').includes('Resume')),
      false,
      'resumedByRunId 已接管后隐藏恢复按钮',
    )
  } finally {
    ui.unmount()
  }
})

test('工作台顶栏「Resume failed (N)」显隐、防连点、skipped 提示与非法响应体报错', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const runs: WorkflowRunSummary[] = [
    { id: 'wf_f1', name: '流 1', conversationId: 1, kind: 'workflow', status: 'failed', resumable: true, createdAt: 1, updatedAt: 2, nodes: [{ id: 'a', kind: 'agent', status: 'failed' }] },
    { id: 'wf_f2', name: '子 2', conversationId: 1, kind: 'subagent', status: 'failed', resumable: true, createdAt: 3, updatedAt: 4, nodes: [{ id: 's', kind: 'agent', status: 'failed', conversationId: 11 }] },
    { id: 'wf_no', name: '不可恢复', conversationId: 1, kind: 'workflow', status: 'failed', resumable: false, createdAt: 5, updatedAt: 6, nodes: [] },
    { id: 'wf_other', name: '子会话失败', conversationId: 11, kind: 'workflow', status: 'failed', resumable: true, createdAt: 7, updatedAt: 8, nodes: [] },
  ]
  let resolveBatch: ((v: unknown) => void) | undefined
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, makeConvSummary(11, { parentConversationId: 1, status: 'error' })],
    runsByConversation: { 1: runs },
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'resume_failed') {
        return new Promise((resolve) => { resolveBatch = resolve })
      }
      return undefined
    },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    const batchBtn = buttonByText(ui.container, 'Resume failed (2)')
    await act(async () => {
      batchBtn.click()
      batchBtn.click()
    })
    assert.deepEqual(
      h.log.actions.map((a) => [a.actionId, a.input]),
      [['resume_failed', { conversationId: 1 }]],
    )
    assert.equal(batchBtn.disabled, true)

    await act(async () => {
      resolveBatch?.({
        resumed: [{ id: 'wf_r1' }, { id: 'wf_r2' }],
        skipped: [{ runId: 'wf_no', reason: 'workflow_action_uncertain' }],
      })
    })
    assert.ok(h.log.notices.some((n) => n.message.includes('Resumed 2') && n.message.includes('skipped 1')))

    // 非法返回结构触发 error 通知
    await act(async () => { batchBtn.click() })
    await act(async () => { resolveBatch?.({ unexpected: true }) })
    assert.equal(h.log.notices.at(-1)?.tone, 'error')

    // 全部接管后按钮隐藏
    h.setRuns(1, runs.map((r) => ({ ...r, resumedByRunId: 'wf_done' })))
    assert.equal(
      [...ui.container.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Resume failed')),
      false,
    )
  } finally {
    ui.unmount()
  }
})

test('WorkflowWorkbenchPanel 呈现 runsStatus loading 与 error 状态（不伪装成无任务空态）', { timeout: 60_000 }, async () => {
  const stubMod = await importWorkflowClientModule('index.tsx', undefined, { realHooks: false, scope: 'status-states' })
  const StubPanel = stubMod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const parent = makeConvSummary(1)

  setWorkflowClientStub({ docValue: undefined, docStatus: 'loading', conversations: [parent] })
  const hLoad = createWorkflowHostHarness({ conversationId: 1, conversations: [parent], locale: 'en' })
  const uiLoad = hLoad.mountNode(e(StubPanel, { conversation: parent }))
  try {
    assert.match(uiLoad.container.textContent!, /Loading/)
  } finally {
    uiLoad.unmount()
  }

  setWorkflowClientStub({ docValue: undefined, docStatus: 'error', conversations: [parent] })
  const hErr = createWorkflowHostHarness({ conversationId: 1, conversations: [parent], locale: 'en' })
  const uiErr = hErr.mountNode(e(StubPanel, { conversation: parent }))
  try {
    assert.match(uiErr.container.textContent!, /Failed to sync task state/)
    assert.ok(buttonByText(uiErr.container, 'Retry') !== undefined)
  } finally {
    uiErr.unmount()
  }
})
