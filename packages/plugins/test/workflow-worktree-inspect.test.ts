/**
 * builtin:workflow 插件工作树插槽集成（worktree-inspect / worktree-cleanup）与重放 Popover 测试：
 * - 纯逻辑（builtin:worktree model-worktree.ts）：parseWorktreeInspectResult / buildWorktreeSelector / buildWorktreeReviewRequest；
 * - 纯逻辑（builtin:workflow parsers.ts）：parseWorkflowArgsInput；
 * - DOM 交互（WorkflowWorkbenchPanel + 真实 builtin:worktree slots.tsx）：
 *   1) 工作流节点卡与独立子代理卡各只渲染一处 worktree-inspect（切换节点详情不卸载检视状态）；
 *   2) 检视精确选择器（worktreeId 优先，缺 ID 用 path+nodeId）与跨插件寻址 builtin:worktree；
 *   3) 检视失败显式报错可重试；审阅请求提交至父会话；
 *   4) completed run（含 saved 与内联）Radix Popover 重放表单：空白沿用原 args、JSON 覆盖、非法 JSON 拦截、双击防重。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowModels,
  importWorktreeClientModule,
  importWorktreeModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
  type WorktreeSlotComponents,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const m = await importWorkflowModels()
const wt = await importWorktreeModels()
const mod = await importWorkflowClientModule('workbench.tsx', undefined, { realHooks: true })
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
const worktreeSlots = (await importWorktreeClientModule('slots.tsx', undefined, { realHooks: true, scope: 'wt-inspect' })) as WorktreeSlotComponents

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_test',
    name: '测试工作流',
    conversationId: 1,
    status: 'completed',
    createdAt: 1_000,
    updatedAt: 61_000,
    ...partial,
  }
}

const INSPECT_RAW = {
  record: {
    id: 'local:/repo/.helmx-worktrees/app-ab12cd34',
    nodeId: 'local',
    path: '/repo/.helmx-worktrees/app-ab12cd34',
    branch: 'helmx/spawn-ab12cd34',
    baseCommit: '5f1e9c0ffffffffffffffffffffffffffffffffff',
    repoRoot: '/repo',
    dirtySource: false,
    parentConversationId: 1,
    conversationId: 7,
    origin: 'native',
    status: 'active',
    createdAt: 123,
  },
  exists: true,
  currentBranch: 'helmx/spawn-ab12cd34',
  currentHead: 'aa11'.repeat(10),
  dirtyFiles: ['?? draft.txt', '?? note.txt'],
  dirtyFileCount: 2,
  dirtyFilesTruncated: false,
  commitsAhead: 1,
  diffStat: ' feature.txt | 1 +',
  diffPreview: '+committed change',
  diffTruncated: false,
  diffBase: 'baseCommit',
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== undefined, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found
}

function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  setter?.call(input, value)
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
  assert.ok(key !== undefined)
  const props = (input as unknown as Record<string, Record<string, unknown>>)[key]!
  ;(props['onChange'] as (ev: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void)({
    target: input,
    currentTarget: input,
  })
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑：builtin:worktree 边界解析与 args 校验
// ---------------------------------------------------------------------------

test('parseWorktreeInspectResult / buildWorktreeSelector / buildWorktreeReviewRequest', { timeout: 60_000 }, () => {
  const parsed = wt.parseWorktreeInspectResult(INSPECT_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.worktreeId, 'local:/repo/.helmx-worktrees/app-ab12cd34')
  assert.equal(parsed.dirtyFileCount, 2)
  assert.equal(parsed.commitsAhead, 1)
  assert.equal(wt.parseWorktreeInspectResult(undefined), undefined)
  assert.equal(wt.parseWorktreeInspectResult({ exists: true }), undefined)
  assert.equal(wt.parseWorktreeInspectResult({ ...INSPECT_RAW, dirtyFileCount: 3 }), undefined)

  assert.deepEqual(wt.buildWorktreeSelector({ id: 'local:/a', path: '/a' }, 'local'), { worktreeId: 'local:/a' })
  assert.deepEqual(wt.buildWorktreeSelector({ path: '/a' }, 'local'), { path: '/a', nodeId: 'local' })

  const text = wt.buildWorktreeReviewRequest({
    path: '/repo/.helmx-worktrees/app-ab12cd34',
    branch: 'helmx/spawn-ab12cd34',
    nodeId: 'local',
    baseCommit: '5f1e9c0aaa',
    taskLabel: '修复构建',
    inspect: parsed,
  })
  assert.match(text, /Uncommitted changes: 2 files/)
  assert.match(text, /Review read-only first/)
})

test('parseWorkflowArgsInput：空串无 args；合法 JSON 透传；非法 JSON 显式报错', { timeout: 60_000 }, () => {
  assert.deepEqual(m.parseWorkflowArgsInput(''), { ok: true })
  assert.deepEqual(m.parseWorkflowArgsInput('   '), { ok: true })
  assert.deepEqual(m.parseWorkflowArgsInput('{"a":1}'), { ok: true, args: { a: 1 } })
  const bad = m.parseWorkflowArgsInput('{a:1}', 'en')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /Invalid JSON arguments/)
  const badZh = m.parseWorkflowArgsInput('{a:1}', 'zh-CN')
  assert.equal(badZh.ok, false)
  if (!badZh.ok) assert.match(badZh.error, /JSON 格式无效/)
})

// ---------------------------------------------------------------------------
// 2. DOM 集成：WorktreeSlots（inspect + cleanup）与 Replay Popover
// ---------------------------------------------------------------------------

test('工作流节点卡 WorktreeSlots 检视 + 审阅提交 + 展开详情不卸载检视；completed run Replay Popover 表单', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1, { cwd: '/tmp/repo' })
  const wtNode = node({
    id: 'c1',
    status: 'done',
    label: '实现者',
    prompt: '实现功能',
    worktree: {
      path: '/repo/.helmx-worktrees/app-ab12cd34',
      branch: 'helmx/spawn-ab12cd34',
      id: 'local:/repo/.helmx-worktrees/app-ab12cd34',
      baseCommit: '5f1e9c0aaa',
    },
  })
  const completedRun = run({
    id: 'wf_done',
    status: 'completed',
    savedName: 'release',
    nodes: [wtNode],
  })
  const submissions: Array<{ text: string; options?: Record<string, unknown> }> = []
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [completedRun] },
    worktreeSlots,
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'inspect_worktree') return INSPECT_RAW
      if (actionId === 'run') return { run: { id: 'wf_replayed' } }
      return undefined
    },
  })
  h.port.submitConversationInput = async (convId, input) => {
    submissions.push({
      text: input.text,
      options: { conversationId: convId, origin: input.origin, whenBusy: input.whenBusy },
    })
  }

  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    // 1. 仅渲染一处 worktree-inspect
    assert.equal(ui.container.querySelectorAll('.worktree-inspect').length, 1)
    await act(async () => { buttonByText(ui.container, 'Change overview').click() })
    const inspectCall = h.log.actions.find((a) => a.actionId === 'inspect_worktree')!
    assert.equal(inspectCall.pluginId, 'builtin:worktree')
    assert.deepEqual(inspectCall.input, { worktreeId: 'local:/repo/.helmx-worktrees/app-ab12cd34' })
    assert.match(ui.container.textContent!, /\+committed change/)

    // 展开节点详情后，检视内容不卸载丢失
    const nodeToggle = ui.container.querySelector('button.wf-node-clickable') as HTMLButtonElement
    await act(async () => { nodeToggle.click() })
    assert.equal(ui.container.querySelectorAll('.worktree-inspect').length, 1, '展开节点详情不得重复渲染检视节')
    assert.match(ui.container.textContent!, /\+committed change/, '展开节点详情必须保留已加载的 diff 预览')

    // 审阅请求提交至父会话 #1
    await act(async () => { buttonByText(ui.container, 'Ask the main conversation to review and merge').click() })
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0]!.options?.['conversationId'], 1)
    assert.match(submissions[0]!.text, /Review read-only first/)

    // 2. Replay Popover：空白 args 提交沿用原会话
    await act(async () => { buttonByText(ui.container, 'Replay').click() })
    const popoverScope = document.body.querySelector('.wf-replay-popover') ?? document.body
    assert.match(popoverScope.textContent!, /Replay release \(wf_done\) in conversation #1/)
    await act(async () => { buttonByText(popoverScope, 'Start replay').click() })
    const runCall = h.log.actions.find((a) => a.actionId === 'run')!
    assert.deepEqual(runCall.input, { resumeFromRunId: 'wf_done', conversationId: 1 })
    assert.ok(h.log.notices.some((n) => n.message.includes('wf_replayed')))
  } finally {
    ui.unmount()
  }
})

test('Replay Popover：显式 JSON args 覆盖、非法 JSON 阻断提交、在途双击防重', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const inlineRun = run({ id: 'wf_inline', status: 'completed', nodes: [] })
  let resolveRun: ((v: unknown) => void) | undefined
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [inlineRun] },
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'run') return new Promise((resolve) => { resolveRun = resolve })
      return undefined
    },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    await act(async () => { buttonByText(ui.container, 'Replay').click() })
    const pop = document.body.querySelector('.wf-replay-popover') ?? document.body
    const argsInput = pop.querySelector('.wf-replay-input') as HTMLInputElement
    assert.ok(argsInput !== null)

    // 非法 JSON 不提交
    await act(async () => { setControlledValue(argsInput, '{oops}') })
    await act(async () => { buttonByText(pop, 'Start replay').click() })
    assert.equal(h.log.actions.filter((a) => a.actionId === 'run').length, 0)
    assert.match(pop.textContent!, /Invalid JSON arguments/)

    // 合法 JSON 双击防重只提交一次
    await act(async () => { setControlledValue(argsInput, '{"target":"prod"}') })
    const submitBtn = buttonByText(pop, 'Start replay')
    await act(async () => {
      submitBtn.click()
      submitBtn.click()
    })
    const calls = h.log.actions.filter((a) => a.actionId === 'run')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.input, { resumeFromRunId: 'wf_inline', conversationId: 1, args: { target: 'prod' } })
    await act(async () => { resolveRun?.({ run: { id: 'wf_new' } }) })
  } finally {
    ui.unmount()
  }
})

test('独立子代理卡 WorktreeSlots：无登记 ID 用 path+nodeId 消歧；检视失败显式报错可重试；点击不触发整卡抽屉', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child12 = makeConvSummary(12, { parentConversationId: 1, nodeId: 'remote-1', cwd: '/wt' })
  const bgRun = run({
    id: 'wf_bg2',
    kind: 'subagent',
    name: '远端后台任务',
    status: 'completed',
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', conversationId: 12, worktree: { path: '/shared/wt', branch: 'helmx/wt' } }],
  })
  let failInspect = true
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child12],
    runsByConversation: { 1: [bgRun] },
    worktreeSlots,
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'inspect_worktree') {
        if (failInspect) {
          failInspect = false
          throw new Error('node offline: 探测失败')
        }
        return INSPECT_RAW
      }
      return undefined
    },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    assert.equal(ui.container.querySelectorAll('.worktree-inspect').length, 1)
    await act(async () => { buttonByText(ui.container, 'Change overview').click() })
    assert.deepEqual(h.log.actions.find((a) => a.actionId === 'inspect_worktree')?.input, { path: '/shared/wt', nodeId: 'remote-1' })
    assert.match(ui.container.textContent!, /node offline/)
    assert.deepEqual(h.log.drawers, [], '展开检视绝不触发打开抽屉')

    await act(async () => { buttonByText(ui.container, 'Retry').click() })
    assert.match(ui.container.textContent!, /\+committed change/)
    assert.deepEqual(h.log.drawers, [])
  } finally {
    ui.unmount()
  }
})
