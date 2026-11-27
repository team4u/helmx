/**
 * builtin:workflow 插件工作树插槽集成（builtin:changes 提供的 inspect/trace + builtin:worktree 提供的 cleanup）与重放 Popover 测试：
 * - 纯逻辑（builtin:changes diff-model.ts / builtin:worktree model-worktree.ts）：
 *   parseWorktreeInspectResult / buildChangesScreenTarget / buildWorktreeReviewRequest / buildWorktreeSelector；
 * - 纯逻辑（builtin:workflow parsers.ts）：parseWorkflowArgsInput；
 * - DOM 交互（WorkflowWorkbenchPanel + builtin:changes slots.tsx + builtin:worktree slots.tsx）：
 *   1) 工作流节点卡与独立子代理卡各只渲染一处 worktree-inspect（切换节点详情不卸载）；
 *   2) 点击分屏检视调用 ctx.openSplitScreen 指向 `screen:builtin:changes/inspector?wt=...`；
 *   3) 懒加载审阅提交（含 `inspect_worktree` 成功与失败显式兜底）至父会话，且不触发整卡抽屉；
 *   4) WorktreeCleanupSlot 遇 `worktree_usage_unverifiable` 弹出 ConfirmDialog；
 *   5) completed run（含 saved 与内联）Radix Popover 重放表单：空白沿用原 args、JSON 覆盖、非法 JSON 拦截、双击防重。
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
const chg = await importChangesModels()
const mod = await importWorkflowClientModule('workbench.tsx', undefined, { realHooks: true })
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
const changesSlotsMod = await importChangesClientModule('slots.tsx', undefined, { realHooks: true, scope: 'chg-slots' })
const worktreeSlotsMod = await importWorktreeClientModule('slots.tsx', undefined, { realHooks: true, scope: 'wt-cleanup' })
const worktreeSlots: WorktreeSlotComponents = {
  WorktreeInspectSlot: changesSlotsMod['WorkflowWorktreeInspectSlot'] as React.ComponentType<Record<string, unknown>>,
  WorktreeTraceInspectSlot: changesSlotsMod['WorktreeTraceInspectSlot'] as React.ComponentType<Record<string, unknown>>,
  WorktreeCleanupSlot: worktreeSlotsMod['WorktreeCleanupSlot'] as React.ComponentType<Record<string, unknown>>,
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
// 1. 纯逻辑：builtin:worktree / builtin:changes 边界解析与 args 校验
// ---------------------------------------------------------------------------

test('parseWorktreeInspectResult / buildChangesScreenTarget / buildWorktreeReviewRequest / buildWorktreeSelector', { timeout: 60_000 }, () => {
  const parsed = chg.parseWorktreeInspectResult(INSPECT_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.record.id, 'local:/repo/.helmx-worktrees/app-ab12cd34')
  assert.equal(parsed.summary.dirtyFileCount, 2)
  assert.equal(parsed.commitsAhead, 1)
  assert.equal(chg.parseWorktreeInspectResult(undefined), undefined)
  assert.equal(chg.parseWorktreeInspectResult({ exists: true }), undefined)
  assert.equal(chg.parseWorktreeInspectResult({ ...INSPECT_RAW, summary: { totalFiles: 'bad' } }), undefined)

  assert.deepEqual(wt.buildWorktreeSelector({ id: 'local:/a', path: '/a' }, 'local'), { worktreeId: 'local:/a' })
  assert.deepEqual(wt.buildWorktreeSelector({ path: '/a' }, 'local'), { path: '/a', nodeId: 'local' })

  assert.equal(
    chg.buildChangesScreenTarget({ wt: 'local:/a', conv: undefined, file: '' }),
    'screen:builtin:changes/inspector?wt=local%3A%2Fa',
  )

  const text = chg.buildWorktreeReviewRequest({
    path: '/repo/.helmx-worktrees/app-ab12cd34',
    branch: 'helmx/spawn-ab12cd34',
    nodeId: 'local',
    baseCommit: '5f1e9c0aaa',
    taskLabel: '修复构建',
    inspect: parsed,
  })
  assert.match(text, /Changed files: 3 \(\+12 −2; uncommitted: 2\)/)
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
// 2. DOM 集成：Changes Slots（split inspect + lazy review）与 Replay Popover
// ---------------------------------------------------------------------------

test('工作流节点卡 WorktreeInspectSlot 分屏导航 + 懒加载审阅提交 + 展开详情不重复；completed run Replay Popover 表单', { timeout: 60_000 }, async () => {
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
    // 1. 仅渲染一处 worktree-inspect；未点击前不主动触发 inspect_worktree
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1)
    assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect_worktree').length, 0)

    // 点击「Inspect diff」通过 split screen 打开 Changes Inspector
    await act(async () => { buttonByText(ui.container, 'Inspect diff').click() })
    assert.equal(h.log.splitScreens.length, 1)
    assert.match(h.log.splitScreens[0]!, /^screen:builtin:changes\/inspector\?/)
    assert.match(h.log.splitScreens[0]!, /wt=local%3A%2Frepo%2F\.helmx-worktrees%2Fapp-ab12cd34/)

    // 展开节点详情后，不重复渲染插槽
    const nodeToggle = ui.container.querySelector('button.wf-node-clickable') as HTMLButtonElement
    await act(async () => { nodeToggle.click() })
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1, '展开节点详情不得重复渲染检视条')

    // 点击「Review & merge」懒加载 inspect_worktree 并向父会话 #1 提交审阅请求
    await act(async () => { buttonByText(ui.container, 'Review & merge').click() })
    const inspectCall = h.log.actions.find((a) => a.actionId === 'inspect_worktree')!
    assert.equal(inspectCall.pluginId, 'builtin:worktree')
    assert.deepEqual(inspectCall.input, { worktreeId: 'local:/repo/.helmx-worktrees/app-ab12cd34' })
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0]!.options?.['conversationId'], 1)
    assert.match(submissions[0]!.text, /Changed files: 3 \(\+12 −2; uncommitted: 2\)/)
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

test('独立子代理卡 WorktreeInspectSlot：无登记 ID 用 path+nodeId 消歧；分屏按钮按 nodeId 构造 target；点击不触发整卡抽屉', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const child12 = makeConvSummary(12, { parentConversationId: 1, nodeId: 'remote-1', cwd: '/wt' })
  const bgRun = run({
    id: 'wf_bg2',
    kind: 'subagent',
    name: '远端后台任务',
    status: 'completed',
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', conversationId: 12, worktree: { path: '/shared/wt', branch: 'helmx/wt' } }],
  })
  const submissions: string[] = []
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child12],
    runsByConversation: { 1: [bgRun] },
    worktreeSlots,
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'inspect_worktree') {
        throw new Error('node offline: 探测失败')
      }
      return undefined
    },
  })
  h.port.submitConversationInput = async (_convId, input) => {
    submissions.push(input.text)
  }
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    assert.equal(ui.container.querySelectorAll('.chg-slot-bar').length, 1)
    await act(async () => { buttonByText(ui.container, 'Inspect diff').click() })
    assert.equal(h.log.splitScreens.length, 1)
    assert.match(h.log.splitScreens[0]!, /wt=remote-1%3A%2Fshared%2Fwt/)
    assert.deepEqual(h.log.drawers, [], '分屏检视绝不触发打开抽屉')

    // 当 inspect_worktree 失败时，审阅仍以元数据降级构造请求并提交，且使用 path+nodeId 选择器
    await act(async () => { buttonByText(ui.container, 'Review & merge').click() })
    assert.deepEqual(h.log.actions.find((a) => a.actionId === 'inspect_worktree')?.input, { path: '/shared/wt', nodeId: 'remote-1' })
    assert.equal(submissions.length, 1)
    assert.match(submissions[0]!, /\/shared\/wt \(node remote-1\)/)
    assert.deepEqual(h.log.drawers, [])
  } finally {
    ui.unmount()
  }
})

test('WorktreeCleanupSlot：遇 worktree_usage_unverifiable 时弹出 ConfirmDialog；取消不重试，确认带 allowUnverifiedUsage 重试并通知', { timeout: 60_000 }, async () => {
  const parent = makeConvSummary(1)
  const WorktreeCleanupSlot = worktreeSlots.WorktreeCleanupSlot!
  let allowNextCleanup = false
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent],
    runsByConversation: { 1: [] },
    worktreeSlots,
    locale: 'en',
    onAction: (pluginId, actionId, input) => {
      if (pluginId === 'builtin:worktree' && actionId === 'cleanup_worktree') {
        const rec = input as { allowUnverifiedUsage?: boolean }
        if (!allowNextCleanup && rec.allowUnverifiedUsage !== true) {
          allowNextCleanup = true
          const err = new Error('Node local (win32) does not support process usage scanning') as Error & { code?: string }
          err.code = 'worktree_usage_unverifiable'
          throw err
        }
        return { removed: true, worktreeId: 'local:/repo/.helmx-worktrees/wt-1', path: '/repo/.helmx-worktrees/wt-1', branch: 'helmx/spawn-1', nodeId: 'local', branchDeleted: false, processUsage: 'unverified' }
      }
      return undefined
    },
  })
  const ui = h.mountNode(
    e(WorktreeCleanupSlot, {
      worktree: { id: 'local:/repo/.helmx-worktrees/wt-1', path: '/repo/.helmx-worktrees/wt-1', branch: 'helmx/spawn-1' },
      nodeId: 'local',
    }),
  )
  try {
    await act(async () => { buttonByText(ui.container, 'Clean up worktree').click() })
    assert.equal(h.log.actions.filter((a) => a.actionId === 'cleanup_worktree').length, 1)
    assert.equal(h.log.notices.length, 0, 'worktree_usage_unverifiable should open confirm dialog instead of error toast')

    const dialog = document.body.querySelector('[role="alertdialog"]')
    assert.ok(dialog !== null, 'ConfirmDialog must open on worktree_usage_unverifiable')
    assert.match(dialog.textContent ?? '', /Clean up without process occupancy check\?/)

    // Cancel does not retry
    await act(async () => { buttonByText(dialog, 'Cancel').click() })
    assert.equal(h.log.actions.filter((a) => a.actionId === 'cleanup_worktree').length, 1)
    assert.ok(document.body.querySelector('[role="alertdialog"]') === null)

    // Trigger again and confirm retry
    allowNextCleanup = false
    await act(async () => { buttonByText(ui.container, 'Clean up worktree').click() })
    const dialog2 = document.body.querySelector('[role="alertdialog"]')
    assert.ok(dialog2 !== null)
    await act(async () => { buttonByText(dialog2, 'Clean up anyway').click() })
    const cleanupCalls = h.log.actions.filter((a) => a.actionId === 'cleanup_worktree')
    assert.equal(cleanupCalls.length, 3)
    assert.deepEqual(cleanupCalls[2]!.input, {
      worktreeId: 'local:/repo/.helmx-worktrees/wt-1',
      allowUnverifiedUsage: true,
    })
    assert.ok(h.log.notices.some((n) => n.message.includes('process occupancy unverified')))
  } finally {
    ui.unmount()
  }
})
