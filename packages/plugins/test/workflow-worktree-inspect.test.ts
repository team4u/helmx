/**
 * builtin:workflow 插件只读工作树插槽集成（builtin:changes 提供的 inspect/trace）与重放 Popover 测试：
 * - 纯逻辑（builtin:changes diff-model.ts）：parseWorktreeInspectResult / buildChangesScreenTarget；
 * - 纯逻辑（builtin:workflow parsers.ts）：parseWorkflowArgsInput；
 * - DOM 交互（WorkflowWorkbenchPanel + builtin:changes slots.tsx）：
 *   1) 工作流节点卡与独立子代理卡各只渲染一处只读 worktree-inspect（切换节点详情不卸载）；
 *   2) 点击「View changes」通过 ctx.openSplitScreen 打开 `screen:builtin:changes/inspector?wt=...`，且不触发抽屉、无写操作按钮；
 *   3) completed run（含 saved 与内联）Radix Popover 重放表单：空白沿用原 args、JSON 覆盖、非法 JSON 拦截、双击防重。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importChangesClientModule,
  importChangesModels,
  importWorkflowClientModule,
  importWorkflowModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
  type WorktreeSlotComponents,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const m = await importWorkflowModels()
const chg = await importChangesModels()
const mod = await importWorkflowClientModule('workbench.tsx', undefined, { realHooks: true })
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
const changesSlotsMod = await importChangesClientModule('slots.tsx', undefined, { realHooks: true, scope: 'chg-slots' })
const worktreeSlots: WorktreeSlotComponents = {
  WorktreeInspectSlot: changesSlotsMod['WorkflowWorktreeInspectSlot'] as React.ComponentType<Record<string, unknown>>,
  WorktreeTraceInspectSlot: changesSlotsMod['WorktreeTraceInspectSlot'] as React.ComponentType<Record<string, unknown>>,
}

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
  commitsAhead: 1,
  diffBase: 'baseCommit',
  scope: 'all',
  commits: [
    {
      oid: 'aa11'.repeat(10),
      shortOid: 'aa11aa1',
      subject: 'feat: sample change',
      author: 'Agent',
      committedAt: 1_700_000_000_000,
    },
  ],
  commitsTruncated: false,
  summary: {
    totalFiles: 3,
    additions: 12,
    deletions: 2,
    untrackedCount: 2,
    dirtyFileCount: 2,
  },
  files: [
    { path: 'feature.txt', status: 'A', additions: 12, deletions: 2, binary: false, untracked: false },
    { path: 'draft.txt', status: 'U', additions: 0, deletions: 0, binary: false, untracked: true },
    { path: 'note.txt', status: 'U', additions: 0, deletions: 0, binary: false, untracked: true },
  ],
  filesTruncated: false,
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
// 1. 纯逻辑：builtin:changes 边界解析与 args 校验
// ---------------------------------------------------------------------------

test('parseWorktreeInspectResult / buildChangesScreenTarget', { timeout: 60_000 }, () => {
  const parsed = chg.parseWorktreeInspectResult(INSPECT_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.record.id, 'local:/repo/.helmx-worktrees/app-ab12cd34')
  assert.equal(parsed.summary.dirtyFileCount, 2)
  assert.equal(parsed.commitsAhead, 1)
  assert.equal(chg.parseWorktreeInspectResult(undefined), undefined)
  assert.equal(chg.parseWorktreeInspectResult({ exists: true }), undefined)
  assert.equal(chg.parseWorktreeInspectResult({ ...INSPECT_RAW, summary: { totalFiles: 'bad' } }), undefined)

  assert.equal(
    chg.buildChangesScreenTarget({ wt: 'local:/a', conv: undefined, file: '' }),
    'screen:builtin:changes/inspector?wt=local%3A%2Fa',
  )
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
// 2. DOM 集成：Changes 只读插槽（View changes）与 Replay Popover
// ---------------------------------------------------------------------------

test('工作流节点卡 WorktreeInspectSlot 只读分屏打开改动 + 展开详情不重复；completed run Replay Popover 表单', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1, { cwd: '/repo' })
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
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [completedRun] },
    worktreeSlots,
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'run') return { run: { id: 'wf_replayed' } }
      return undefined
    },
  })

  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    // 1. 仅渲染一处只读 worktree-inspect；无审阅合入/清理写操作按钮；未点击不拉动作
    const slotBar = ui.container.querySelector('.chg-slot-bar')
    assert.ok(slotBar !== null)
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1)
    assert.equal(slotBar.querySelectorAll('button').length, 1, '插槽仅保留单一「View changes」只读入口')
    assert.equal(h.log.actions.length, 0)

    // 点击「View changes」通过 split screen 打开 Changes Inspector
    await act(async () => { buttonByText(ui.container, 'View changes').click() })
    assert.equal(h.log.splitScreens.length, 1)
    assert.equal(
      h.log.splitScreens[0],
      'screen:builtin:changes/inspector?wt=local%3A%2Frepo%2F.helmx-worktrees%2Fapp-ab12cd34',
    )

    // 展开节点详情后，不重复渲染插槽
    const nodeToggle = ui.container.querySelector('button.wf-node-clickable') as HTMLButtonElement
    await act(async () => { nodeToggle.click() })
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1, '展开节点详情不得重复渲染检视条')

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

test('独立子代理卡与直接挂载的 WorkflowWorktreeInspectSlot：无 parentConversationId 也可渲染，按 nodeId 构造 target 且不触发抽屉', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child12 = makeConvSummary(12, { parentConversationId: 1, nodeId: 'remote-1', cwd: '/wt' })
  const bgRun = run({
    id: 'wf_bg2',
    kind: 'subagent',
    name: '远端后台任务',
    status: 'completed',
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', conversationId: 12, worktree: { path: '/shared/wt', branch: 'helmx/wt' } }],
  })
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child12],
    runsByConversation: { 1: [bgRun] },
    worktreeSlots,
    locale: 'en',
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1)
    await act(async () => { buttonByText(ui.container, 'View changes').click() })
    assert.equal(h.log.splitScreens.length, 1)
    assert.equal(h.log.splitScreens[0], 'screen:builtin:changes/inspector?wt=remote-1%3A%2Fshared%2Fwt')
    assert.deepEqual(h.log.drawers, [], '分屏检视绝不触发打开抽屉')
  } finally {
    ui.unmount()
  }

  const slotOnly = h.mountNode(
    e(worktreeSlots.WorktreeInspectSlot!, {
      worktree: { path: '/standalone/wt', branch: 'helmx/standalone' },
      nodeId: 'local',
    }),
  )
  try {
    await act(async () => { buttonByText(slotOnly.container, 'View changes').click() })
    assert.equal(h.log.splitScreens.length, 2)
    assert.equal(h.log.splitScreens[1], 'screen:builtin:changes/inspector?wt=local%3A%2Fstandalone%2Fwt')
  } finally {
    slotOnly.unmount()
  }
})
