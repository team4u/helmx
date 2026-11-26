/**
 * builtin:workflow 运行卡片、计时模型、恢复策略与懒加载 inspect 测试（真实 esbuild 编译产物）：
 * - 纯逻辑：buildWorkflowPhaseSections / extractWorkflowLogs / formatNodeStats /
 *   canResumeWorkflowRun / canResumeSubagentRun / canReplayWorkflowRun /
 *   listResumableFailedRuns（权威 run.resumable）/ parseResumeFailedResult（严格边界）/
 *   resolveRunElapsedMs / resolveNodeElapsedMs / summarizeWorkflowTiming /
 *   resolveSubagentElapsedMs / resolveLiveSnippet（含 ConversationLive.tools 命令与相对路径）；
 * - SSR & DOM：WorkflowToolView / WorkflowWorkbenchPanel 零 Emoji、无分屏按钮、
 *   同源有效状态不假完成、瘦身 run 折叠零 inspect 请求、展开结果按需 inspect 并缓存与失败重试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitFor } from '@helmx/test-kit'
import type { ConversationSummary } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowModels,
  importWorkflowSurfaces,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })
const m = await importWorkflowModels()
const mod = await importWorkflowSurfaces(['index.tsx', 'workbench.tsx'], undefined, { realHooks: true })
const WorkflowToolView = mod['WorkflowToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_test',
    name: '测试工作流',
    conversationId: 1,
    status: 'running',
    createdAt: 1_000,
    updatedAt: 61_000,
    ...partial,
  }
}

function summary(id: number, status: ConversationSummary['status'], parent?: number): ConversationSummary {
  return makeConvSummary(id, { status, ...(parent !== undefined ? { parentConversationId: parent } : {}) })
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑：Phase 分组 / 日志 / 统计 / 恢复与重放（信任后端 run.resumable）
// ---------------------------------------------------------------------------

test('buildWorkflowPhaseSections：保留全部节点、合并声明阶段、未匹配归默认阶段、诚实 aborted/pending', { timeout: 60_000 }, () => {
  const r = run({
    status: 'running',
    phases: [
      { title: '调研', detail: '收集资料' },
      { title: '实现', detail: '编码' },
      { title: '验收' },
    ],
    nodes: [
      node({ id: 'a', kind: 'agent', status: 'done', conversationId: 11, phaseTitle: '调研' }),
      node({ id: 'b', kind: 'action', status: 'done', label: '落盘', phaseTitle: '调研' }),
      node({ id: 'c', kind: 'agent', status: 'running', executionId: 'pane-9', phaseTitle: '实现' }),
      node({ id: 'd', kind: 'agent', status: 'pending' }),
    ],
  })
  const sections = m.buildWorkflowPhaseSections(r, 'en')
  assert.deepEqual(sections.map((s) => s.title), ['调研', '实现', '验收', 'Other Steps'])
  assert.equal(sections[0]!.status, 'done')
  assert.equal(sections[0]!.doneCount, 2)
  assert.equal(sections[1]!.status, 'working')
  assert.equal(sections[2]!.status, 'pending')
  assert.equal(sections[3]!.nodes.map((n) => n.id).join(','), 'd')

  // 无声明阶段时返回单默认分组（title=''）
  const bare = m.buildWorkflowPhaseSections(run({ status: 'aborted', nodes: [node({ id: 'a', status: 'aborted' })] }))
  assert.equal(bare.length, 1)
  assert.equal(bare[0]!.title, '')
  assert.equal(bare[0]!.status, 'aborted')

  // pending 节点不被 done 掩盖
  const pendingCheck = m.buildWorkflowPhaseSections(
    run({ status: 'completed', nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'pending' })] }),
  )
  assert.equal(pendingCheck[0]!.status, 'pending')
})

test('extractWorkflowLogs / formatNodeStats', { timeout: 60_000 }, () => {
  const logs = m.extractWorkflowLogs(
    run({
      progress: [
        { at: 1, kind: 'phase', index: 0, title: '调研' },
        { at: 2, kind: 'log', message: '开始扫描' },
        { at: 3, kind: 'log', message: '发现 3 个文件' },
      ],
    }),
  )
  assert.deepEqual(logs.map((l) => [l.at, l.message]), [[2, '开始扫描'], [3, '发现 3 个文件']])
  assert.deepEqual(m.formatNodeStats(node({ id: 'a', model: 'openai/glm-5', tokens: 1500 })), ['glm-5', '1.5k tok'])
  assert.deepEqual(m.formatNodeStats(node({ id: 'b', model: 'glm-5', tokens: 500 })), ['glm-5', '500 tok'])
  assert.deepEqual(m.formatNodeStats(node({ id: 'c', tokens: 0 })), [])
})

test('canResumeWorkflowRun / canResumeSubagentRun / canReplayWorkflowRun / listResumableFailedRuns：权威消费 run.resumable', { timeout: 60_000 }, () => {
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: true })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: false })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed' })), false, '缺失 resumable=true 不猜测可恢复')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'aborted' })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: true, resumedByRunId: 'wf_next' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: true, kind: 'subagent' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed' })), false)

  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed', resumable: true })), true)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed', resumable: false })), false)
  assert.equal(
    m.canResumeSubagentRun(run({ kind: 'subagent', status: 'aborted', nodes: [node({ id: 's', conversationId: 11 })] })),
    true,
  )
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'aborted', nodes: [node({ id: 's' })] })), false)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed', resumable: true, resumedByRunId: 'wf_2' })), false)

  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', kind: 'workflow' })), true)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'completed', kind: 'subagent' })), false)
  assert.equal(m.canReplayWorkflowRun(run({ status: 'failed' })), false)

  const list = m.listResumableFailedRuns(
    [
      run({ id: 'wf_1', conversationId: 1, status: 'failed', resumable: true }),
      run({ id: 'wf_2', conversationId: 1, kind: 'subagent', status: 'failed', resumable: true }),
      run({ id: 'wf_no', conversationId: 1, status: 'failed', resumable: false }),
      run({ id: 'wf_taken', conversationId: 1, status: 'failed', resumable: true, resumedByRunId: 'wf_next' }),
      run({ id: 'wf_other', conversationId: 2, status: 'failed', resumable: true }),
      run({ id: 'wf_aborted', conversationId: 1, status: 'aborted' }),
    ],
    1,
  )
  assert.deepEqual(list.map((r) => r.id), ['wf_1', 'wf_2'])
})

test('parseResumeFailedResult：严格校验 resumed[].id 与 skipped[].{runId,reason}', { timeout: 60_000 }, () => {
  assert.deepEqual(
    m.parseResumeFailedResult({
      resumed: [{ id: 'wf_1' }, { id: 'wf_2' }],
      skipped: [{ runId: 'wf_3', reason: 'workflow_action_uncertain' }],
    }),
    { resumedCount: 2, skippedCount: 1 },
  )
  assert.deepEqual(m.parseResumeFailedResult({ resumed: [], skipped: [] }), { resumedCount: 0, skippedCount: 0 })
  assert.equal(m.parseResumeFailedResult(undefined), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [] }), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [{ name: 'no-id' }], skipped: [] }), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [], skipped: [{ runId: 'wf_x' }] }), undefined)
})

// ---------------------------------------------------------------------------
// 2. 纯逻辑：统一计时器与实时摘要（含 ConversationLive.tools）
// ---------------------------------------------------------------------------

test('resolveRunElapsedMs / resolveNodeElapsedMs / summarizeWorkflowTiming / resolveSubagentElapsedMs', { timeout: 60_000 }, () => {
  const t0 = 1_700_000_000_000
  assert.equal(m.resolveRunElapsedMs(run({ status: 'running', createdAt: t0 }), t0 + 4_000), 4_000)
  assert.equal(m.resolveRunElapsedMs(run({ status: 'running', createdAt: t0 })), undefined)
  assert.equal(m.resolveRunElapsedMs(run({ status: 'completed', createdAt: 1_000, settledAt: 31_000, updatedAt: 99_000 }), t0), 30_000)

  assert.equal(m.resolveNodeElapsedMs(node({ id: 'a', status: 'running', startedAt: t0 }), t0 + 5_000), 5_000)
  assert.equal(m.resolveNodeElapsedMs(node({ id: 'b', status: 'done', durationMs: 800 })), 800)

  const timing = m.summarizeWorkflowTiming(
    run({
      status: 'completed',
      createdAt: t0,
      settledAt: t0 + 10_000,
      nodes: [
        node({ id: 'a', durationMs: 3_000 }),
        node({ id: 'b', durationMs: 4_000 }),
      ],
    }),
  )
  assert.equal(timing.wallElapsedMs, 10_000)
  assert.equal(timing.nodeTotalDurationMs, 7_000)
  assert.equal(timing.measuredNodeCount, 2)

  // 后台句柄不暴露父工具 34ms 派发确认耗时
  assert.equal(
    m.resolveSubagentElapsedMs({ status: 'done', durationMs: 34, isBackgroundHandle: true }),
    undefined,
  )
  assert.equal(
    m.resolveSubagentElapsedMs({ status: 'working', startedAt: t0, nowMs: t0 + 5_000 }),
    5_000,
  )
})

test('resolveLiveSnippet：优先级 loadError > pendingAsk > live.tools > live.text > live.thinking > doing > error/done', { timeout: 60_000 }, () => {
  const conv = makeConvSummary(11, { cwd: '/workspace/demo', doing: '兜底 doing' })
  assert.deepEqual(
    m.resolveLiveSnippet(
      {
        status: 'working',
        summary: conv,
        live: {
          conversationId: 11,
          text: '正文',
          thinking: '思考',
          tools: [{ callId: 'c1', toolName: 'read', input: { path: '/workspace/demo/src/app.ts' }, status: 'running' }],
          updatedAt: 1,
        },
      },
      'en',
    ),
    { tag: 'Tool', text: 'read: src/app.ts' },
  )
  assert.deepEqual(
    m.resolveLiveSnippet(
      {
        status: 'working',
        summary: conv,
        live: { conversationId: 11, text: '输出结论', thinking: '旧思考', tools: [], updatedAt: 1 },
      },
      'en',
    ),
    { tag: 'Output', text: '输出结论' },
  )
  assert.deepEqual(
    m.resolveLiveSnippet(
      {
        status: 'blocked',
        pendingAsk: { id: 'a1', conversationId: 11, title: '确认发布', fields: [], status: 'pending', createdAt: 1 },
      },
      'zh-CN',
    ),
    { tag: '审批', text: '确认发布' },
  )
  assert.deepEqual(
    m.resolveLiveSnippet({ status: 'aborted', runNode: node({ id: 'x', status: 'aborted' }) }, 'en'),
    { text: 'Aborted', isError: false },
  )
})

// ---------------------------------------------------------------------------
// 3. SSR & DOM：同源状态、零 Emoji、按需懒加载 inspect 完整结果
// ---------------------------------------------------------------------------

test('DOM：WorkflowToolView 与 WorkflowWorkbenchPanel 同源有效状态不假完成，零 Emoji 无分屏按钮', { timeout: 60_000 }, () => {
  const conv11 = makeConvSummary(11, { status: 'working', parentConversationId: 1, doing: '后台补测试' })
  const wfRun = run({
    id: 'wf_straggler',
    kind: 'workflow',
    name: 'hello-orchestra',
    status: 'completed',
    parentToolCallId: 'call-x',
    phases: [{ title: '调研' }, { title: '实现' }],
    progress: [{ at: 2_000, kind: 'log', message: '开始调研' }],
    nodes: [
      node({
        id: 'a',
        kind: 'agent',
        status: 'done',
        conversationId: 11,
        label: '调研员',
        phaseTitle: '调研',
        cached: true,
        worktree: { path: '/wt/hello', branch: 'helmx/wf-hello' },
        tokens: 1200,
        output: '调研结论：可行',
      }),
      node({ id: 'b', kind: 'action', status: 'done', label: '落盘报告', phaseTitle: '实现', output: 'ok' }),
    ],
    result: { report: 'docs/report.md' },
  })
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [summary(1, 'idle'), conv11],
    runsByConversation: { 1: [wfRun] },
    locale: 'en',
  })

  const toolUi = h.mountNode(e(WorkflowToolView, { callId: 'call-x', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1 }))
  try {
    assert.match(toolUi.container.innerHTML, /helmx-status-light-working/, '子会话仍在执行时时间线行不得假完成')
  } finally {
    toolUi.unmount()
  }

  const wbUi = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: summary(1, 'idle') }))
  try {
    const wbHtml = wbUi.container.innerHTML
    assert.match(wbHtml, /Self: Completed; subtree aggregate: Running/, '自身终态与子树聚合状态如实呈现')
    assert.ok(wbHtml.includes('调研'))
    assert.ok(wbHtml.includes('开始调研'))
    assert.ok(wbHtml.includes('Cached'))
    assert.ok(wbHtml.includes('helmx/wf-hello'))
    assert.ok(wbHtml.includes('Action'))
    assert.ok(wbHtml.includes('docs/report.md'))
    assert.ok(!wbHtml.includes('subagent-split-btn') && !wbHtml.includes('workbench-split-btn'))
    assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(wbHtml), false, 'UI 严禁包含 Emoji')
  } finally {
    wbUi.unmount()
  }
})

test('DOM：瘦身 run 折叠零 inspect 请求；点击 Expand 按需拉取并缓存完整结果，失败显式报错可重试', { timeout: 60_000 }, async () => {
  const slimRun = run({
    id: 'wf_slim',
    kind: 'workflow',
    name: '瘦身工作流',
    status: 'completed',
    hasResult: true,
    resultPreview: '{"summary":"预览"}',
    nodes: [node({ id: 'a', status: 'done', label: '步 1' })],
  })
  let failOnce = true
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [summary(1, 'idle')],
    runsByConversation: { 1: [slimRun] },
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'inspect') {
        if (failOnce) {
          failOnce = false
          throw new Error('inspect 暂时失败')
        }
        return { run: { ...slimRun, result: { summary: '完整结果数据', detail: [1, 2, 3] } } }
      }
      return undefined
    },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: summary(1, 'idle') }))
  try {
    assert.ok(ui.container.textContent!.includes('{"summary":"预览"}'), '折叠态直接展示 resultPreview')
    assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect').length, 0, '挂载卡片不得提前发起 inspect 请求')

    const expandBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Expand'))!
    await act(async () => { expandBtn.click() })
    await waitFor(() => ui.container.textContent!.includes('inspect 暂时失败'))
    assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect').length, 1)

    const retryBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Retry')!
    await act(async () => { retryBtn.click() })
    await waitFor(() => ui.container.textContent!.includes('完整结果数据'))
    assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect').length, 2)

    // 收起再展开命中缓存，不重复请求 inspect
    const collapseBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Collapse'))!
    await act(async () => { collapseBtn.click() })
    const expandAgain = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Expand'))!
    await act(async () => { expandAgain.click() })
    assert.ok(ui.container.textContent!.includes('完整结果数据'))
    assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect').length, 2, '同一版本命中缓存零重复请求')
  } finally {
    ui.unmount()
  }
})

test('DOM：WorkflowRunCard 字符串结果通过 MarkdownView 渲染并携带 run.conversationId', { timeout: 60_000 }, async () => {
  const mdRun = run({
    id: 'wf_md',
    kind: 'workflow',
    name: 'Markdown 结果工作流',
    conversationId: 42,
    status: 'completed',
    hasResult: true,
    result: '结论见 [conversations.ts:137](/root/code/.helmx-worktrees/helm-bbcc88d1/packages/cli/src/commands/conversations.ts:137)',
    nodes: [node({ id: 'a', status: 'done', label: '核查' })],
  })
  const h = createWorkflowHostHarness({
    conversationId: 42,
    conversations: [summary(42, 'idle')],
    runsByConversation: { 42: [mdRun] },
    locale: 'en',
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: summary(42, 'idle') }))
  try {
    const expandBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Expand'))!
    await act(async () => {
      expandBtn.click()
    })
    const mdEl = ui.container.querySelector<HTMLElement>('[data-testid="markdown-view"]')
    assert.ok(mdEl !== null, '字符串结果应通过 MarkdownView 渲染')
    assert.equal(mdEl.getAttribute('data-conversation-id'), '42', 'MarkdownView 应收到 run.conversationId')
    assert.ok(mdEl.classList.contains('wf-result-markdown'), '应合并 wf-result-markdown 类')
    assert.ok(mdEl.classList.contains('msg-ai-body'), '应合并 msg-ai-body 类')
  } finally {
    ui.unmount()
  }
})

test('DOM：ExecutionNodeRow 的 prompt 与字符串 output 走宿主 MarkdownView（优先传节点 conversationId）；gate 与 JSON output 保留 pre', { timeout: 60_000 }, async () => {
  const conv11 = makeConvSummary(11, { parentConversationId: 1, status: 'idle', title: '子代理节点' })
  const richRun = run({
    id: 'wf_node_md',
    kind: 'workflow',
    name: 'Markdown 校验流',
    status: 'completed',
    nodes: [
      node({
        id: 'agent-1',
        kind: 'agent',
        status: 'done',
        conversationId: 11,
        label: '审查员',
        prompt: '### 任务目标\n\n- **检查** `src/app.ts`',
        output: '## 节点输出\n\n- **通过** `ok`',
        gateCommand: 'pnpm test',
        gate: { ok: true, exitCode: 0, output: 'all passed' },
      }),
      node({
        id: 'action-1',
        kind: 'action',
        status: 'done',
        label: '结构化动作',
        output: { passed: 3, failed: 0 },
      }),
    ],
    result: '## 工作流报告\n\n- **全部完成** `report.md`',
  })

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [summary(1, 'idle'), conv11],
    runsByConversation: { 1: [richRun] },
    locale: 'en',
  })

  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: summary(1, 'idle') }))
  try {
    // 1. 展开 WorkflowRunCard 字符串 result -> 走 .wf-result-box [data-testid="markdown-view"].msg-ai-body.wf-result-markdown
    const expandBtn = [...ui.container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Expand'))!
    await act(async () => { expandBtn.click() })
    const resultMd = ui.container.querySelector('.wf-result-box [data-testid="markdown-view"].msg-ai-body.wf-result-markdown')
    assert.ok(resultMd !== null)
    assert.equal(resultMd.getAttribute('data-conversation-id'), '1')
    assert.equal(resultMd.querySelector('h2')?.textContent, '工作流报告')
    assert.equal(resultMd.querySelector('li strong')?.textContent, '全部完成')
    assert.equal(resultMd.querySelector('li code')?.textContent, 'report.md')

    // 2. 展开 ExecutionNodeRow (agent-1)：prompt & 字符串 output 走 .wf-node-md-box MarkdownView；gate 保留 pre
    const agentDetailToggle = ui.container.querySelector<HTMLButtonElement>('.wf-node-actions button[aria-expanded]')
    assert.ok(agentDetailToggle !== null)
    await act(async () => { agentDetailToggle.click() })

    const agentCard = agentDetailToggle.closest('.wf-node-card')!
    const mdBoxes = [...agentCard.querySelectorAll('[data-testid="markdown-view"].msg-ai-body.wf-result-markdown.wf-node-md-box')]
    assert.equal(mdBoxes.length, 2, 'prompt 与字符串 output 均应走 MarkdownView')
    assert.equal(mdBoxes[0]!.getAttribute('data-conversation-id'), '11', '节点 prompt 应优先传入节点 conversationId')
    assert.equal(mdBoxes[1]!.getAttribute('data-conversation-id'), '11', '节点字符串 output 应优先传入节点 conversationId')
    assert.equal(mdBoxes[0]!.querySelector('h3')?.textContent, '任务目标')
    assert.equal(mdBoxes[0]!.querySelector('strong')?.textContent, '检查')
    assert.equal(mdBoxes[1]!.querySelector('h2')?.textContent, '节点输出')
    assert.equal(mdBoxes[1]!.querySelector('strong')?.textContent, '通过')
    assert.equal(mdBoxes[1]!.querySelector('code')?.textContent, 'ok')

    const gatePres = [...agentCard.querySelectorAll('pre.code-block-pre.wf-pre code')].map((el) => el.textContent)
    assert.deepEqual(gatePres, ['pnpm test', 'all passed'])

    // 3. 展开 ExecutionNodeRow (action-1)：对象 output 保留 pre.code-block-pre.wf-pre code
    const actionBtn = [...ui.container.querySelectorAll<HTMLButtonElement>('button.wf-node-clickable')].find((b) =>
      (b.textContent ?? '').includes('结构化动作'),
    )
    assert.ok(actionBtn !== undefined)
    await act(async () => { actionBtn.click() })
    const actionCard = actionBtn.closest('.wf-node-card')!
    assert.equal(actionCard.querySelectorAll('.wf-node-md-box').length, 0)
    assert.match(actionCard.querySelector('pre.code-block-pre.wf-pre code')?.textContent ?? '', /"passed": 3/)
  } finally {
    ui.unmount()
  }
})
