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
  importWorkflowSurfaces,
  importWorktreeClientModule,
  makeConvSummary,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
  type WorktreeSlotComponents,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const mod = await importWorkflowSurfaces(['index.tsx', 'workbench.tsx'], undefined, { realHooks: true })
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
    const resumeBtn = [...ui.container.querySelectorAll('.wf-node-actions button')].find((b) =>
      (b.getAttribute('aria-label') ?? b.textContent ?? '').includes('Resume'),
    ) as HTMLButtonElement | undefined
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
      [...ui.container.querySelectorAll('.wf-node-actions button')].some((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').includes('Resume'),
      ),
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
  const stubMod = await importWorkflowClientModule('workbench.tsx', undefined, { realHooks: false, scope: 'status-states' })
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

test('时间线与工作台防撑爆契约：helmx/spawn-* 收为紧凑图标徽章、无重复展开按钮、次要元信息独立分行为 .wf-node-meta', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const childManaged = makeConvSummary(502, {
    parentConversationId: 1,
    parentToolCallId: 'call-managed',
    profileId: 'code2',
    status: 'working',
    title: '大纲高亮精确到标题节',
  })
  const childCustom = makeConvSummary(503, {
    parentConversationId: 1,
    parentToolCallId: 'call-custom',
    profileId: 'reviewer',
    status: 'idle',
    title: '语义分支任务',
  })
  const managedRun: WorkflowRunSummary = {
    id: 'wf_managed',
    name: '大纲高亮精确到标题节',
    conversationId: 1,
    kind: 'subagent',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'call-managed',
    nodes: [
      {
        id: 'n1',
        kind: 'agent',
        status: 'running',
        conversationId: 502,
        cached: true,
        attempt: 2,
        gateCommand: 'pnpm test',
        gate: { ok: true, exitCode: 0, output: '' },
        model: 'openai/glm-5',
        tokens: 2400,
        worktree: { path: '/repo/.helmx-worktrees/ef72f001', branch: 'helmx/spawn-ef72f001' },
      },
    ],
  }
  const customRun: WorkflowRunSummary = {
    id: 'wf_custom',
    name: '语义分支任务',
    conversationId: 1,
    kind: 'subagent',
    status: 'completed',
    createdAt: 3,
    updatedAt: 4,
    parentToolCallId: 'call-custom',
    nodes: [
      {
        id: 'n2',
        kind: 'agent',
        status: 'done',
        conversationId: 503,
        worktree: { path: '/repo/.helmx-worktrees/oauth', branch: 'feat/oauth-flow' },
      },
    ],
  }
  const wfRun: WorkflowRunSummary = {
    id: 'wf_multi',
    name: '并行验收流',
    conversationId: 1,
    kind: 'workflow',
    status: 'completed',
    createdAt: 5,
    updatedAt: 6,
    parentToolCallId: 'call-wf',
    nodes: [{ id: 's1', kind: 'action', status: 'done', label: 'build' }],
  }

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, childManaged, childCustom],
    runsByConversation: { 1: [managedRun, customRun, wfRun] },
    worktreeSlots,
    locale: 'en',
  })

  // 1. SubagentToolView（托管 helmx/spawn-* 分支）：行内不裸露哈希分支名、tooltip 保留完整信息、右侧无重复展开按钮
  const managedToolUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'call-managed',
      toolName: 'subagent',
      input: { prompt: '大纲高亮精确到标题节' },
      status: 'running',
      conversationId: 1,
    }),
  )
  try {
    const wtBadge = managedToolUi.container.querySelector('.wf-wt-badge')
    assert.ok(wtBadge !== null && wtBadge.classList.contains('wf-wt-badge-compact'), 'helmx/spawn-* 应渲染紧凑图标徽章')
    assert.equal(wtBadge.textContent?.trim(), '', '托管生成分支名不得占据单行正文宽度')
    assert.match(wtBadge.getAttribute('title') ?? '', /helmx\/spawn-ef72f001/, '悬停提示须保留完整分支名')
    assert.match(wtBadge.getAttribute('title') ?? '', /\/repo\/\.helmx-worktrees\/ef72f001/, '悬停提示须保留路径')
    assert.equal(
      managedToolUi.container.querySelectorAll('.wf-trace-right button').length,
      0,
      'replaceRow=true 可导航行右侧不得重复挂载第二枚展开按钮',
    )
  } finally {
    managedToolUi.unmount()
  }

  // 2. SubagentToolView（自定义语义分支）：展示截断受控的 .wf-wt-branch 文本
  const customToolUi = h.mountNode(
    e(SubagentToolView, {
      callId: 'call-custom',
      toolName: 'subagent',
      input: { prompt: '语义分支任务' },
      status: 'done',
      conversationId: 1,
    }),
  )
  try {
    const wtBadge = customToolUi.container.querySelector('.wf-wt-badge')
    assert.ok(wtBadge !== null && !wtBadge.classList.contains('wf-wt-badge-compact'))
    assert.equal(wtBadge.querySelector('.wf-wt-branch')?.textContent, 'feat/oauth-flow')
  } finally {
    customToolUi.unmount()
  }

  // 3. WorkflowToolView 可导航行右侧同样无重复展开按钮
  const wfToolUi = h.mountNode(
    e(WorkflowToolView, {
      callId: 'call-wf',
      toolName: 'SubagentWorkflow',
      input: { script: 'return 1' },
      status: 'done',
      conversationId: 1,
    }),
  )
  try {
    assert.equal(wfToolUi.container.querySelectorAll('.wf-trace-right button').length, 0)
  } finally {
    wfToolUi.unmount()
  }

  // 4. ExecutionNodeRow：紧凑 worktree 徽章 + 紧凑纯图标清理按钮 + 次要元数据落入 .wf-node-meta 不挤占顶行
  const wbUi = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    const managedCard = wbUi.container.querySelector('[data-run-id="wf_managed"]')
    assert.ok(managedCard !== null)
    const header = managedCard.querySelector('.wf-node-header')
    const metaRow = managedCard.querySelector('.wf-node-meta')
    assert.ok(header !== null && metaRow !== null, '有次要元数据时应独立渲染 .wf-node-meta 行')
    assert.equal(header.textContent?.includes('helmx/spawn-ef72f001'), false, '工作台顶行不裸露 helmx/spawn-* 哈希分支')
    assert.equal(header.textContent?.includes('Cached'), false, 'Cached 徽章应下沉至 .wf-node-meta')
    assert.equal(header.textContent?.includes('Gate passed'), false, 'Gate 徽章应下沉至 .wf-node-meta')
    assert.match(metaRow.textContent ?? '', /Cached/)
    assert.match(metaRow.textContent ?? '', /Try #2/)
    assert.match(metaRow.textContent ?? '', /Gate passed/)
    assert.match(metaRow.textContent ?? '', /glm-5/)
    const cleanupBtn = managedCard.querySelector('[aria-label="Clean up isolated worktree"]')
    assert.ok(cleanupBtn !== null)
    assert.equal(cleanupBtn.textContent?.trim(), '', 'compact worktree-cleanup 应渲染纯图标按钮')
  } finally {
    wbUi.unmount()
  }
})
