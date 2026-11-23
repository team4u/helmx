/**
 * builtin:workflow 统一执行树（ExecutionNode / execution-model.ts）测试：
 * - 统一 3 种节点类型（workflow / agent / action；无 external 平行分支）与诚实 aborted 状态；
 * - 以 `runs` 为唯一根源：人类 fork 分支会话与无 WorkflowRun 的会话绝不混入执行树、工作台或托盘；
 * - 任意深度递归构树、循环防御、重复 run 去重、DSL 认领挂载与 Active-First 排序；
 * - resolveNodeTitle 单一来源（{ text, isFallback } 杜绝重复 #id 拼接）与占位名过滤；
 * - buildActiveTraySummary 一级进度口径、blocked 审批优先目标与 settled 父节点不泄漏旧 doing。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })
const m = await importWorkflowModels()
const clientMod = await importWorkflowClientModule('workbench.tsx', undefined, { realHooks: true })
const WorkflowWorkbenchPanel = clientMod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>

function summary(
  id: number,
  status: ConversationSummary['status'],
  parent?: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return makeConvSummary(id, {
    status,
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
    ...overrides,
  })
}

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_tree',
    name: '执行树工作流',
    conversationId: 1,
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...partial,
  }
}

function subagentRun(
  id: string,
  parentConversationId: number,
  childConversationId: number,
  status: WorkflowRunSummary['status'] = 'completed',
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return run({
    id,
    kind: 'subagent',
    name: 'subagent',
    conversationId: parentConversationId,
    status,
    nodes: [
      node({
        id: `n-${childConversationId}`,
        kind: 'agent',
        status: status === 'running' ? 'running' : status === 'aborted' ? 'aborted' : status === 'failed' ? 'failed' : 'done',
        conversationId: childConversationId,
      }),
    ],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 1. 统一状态模型（诚实 aborted 与 StatusLight 单一映射）
// ---------------------------------------------------------------------------

test('aggregateStatuses 与 executionLightStatus：blocked > working > error > aborted > pending > done', { timeout: 60_000 }, () => {
  assert.equal(m.aggregateStatuses([]), 'pending')
  assert.equal(m.aggregateStatuses(['done', 'done']), 'done')
  assert.equal(m.aggregateStatuses(['pending', 'done']), 'pending')
  assert.equal(m.aggregateStatuses(['done', 'aborted']), 'aborted')
  assert.equal(m.aggregateStatuses(['aborted', 'error']), 'error')
  assert.equal(m.aggregateStatuses(['error', 'working']), 'working')
  assert.equal(m.aggregateStatuses(['working', 'blocked']), 'blocked')

  assert.equal(m.executionLightStatus('blocked'), 'blocked')
  assert.equal(m.executionLightStatus('working'), 'running')
  assert.equal(m.executionLightStatus('aborted'), 'aborted')
  assert.equal(m.executionLightStatus('error'), 'failed')
  assert.equal(m.executionLightStatus('done'), 'completed')
  assert.equal(m.executionLightStatus('pending'), 'pending')
})

test('statusFromRun / statusFromRunNode / statusFromConversation / effectiveRunStatus 诚实保留 aborted', { timeout: 60_000 }, () => {
  assert.equal(m.statusFromRun({ status: 'running' }), 'working')
  assert.equal(m.statusFromRun({ status: 'completed' }), 'done')
  assert.equal(m.statusFromRun({ status: 'aborted' }), 'aborted')
  assert.equal(m.statusFromRun({ status: 'failed' }), 'error')

  assert.equal(m.statusFromRunNode({ status: 'pending' }), 'pending')
  assert.equal(m.statusFromRunNode({ status: 'running' }), 'working')
  assert.equal(m.statusFromRunNode({ status: 'done' }), 'done')
  assert.equal(m.statusFromRunNode({ status: 'aborted' }), 'aborted')
  assert.equal(m.statusFromRunNode({ status: 'failed' }), 'error')

  assert.equal(m.statusFromConversation(summary(11, 'blocked'), undefined), 'blocked')
  assert.equal(m.statusFromConversation(summary(11, 'working', undefined, { pendingAskCount: 1 }), undefined), 'blocked')
  assert.equal(m.statusFromConversation(summary(11, 'idle'), run({ status: 'running' })), 'working')
  assert.equal(m.statusFromConversation(summary(11, 'idle'), run({ status: 'aborted' })), 'aborted')
  assert.equal(m.statusFromConversation(summary(11, 'idle'), run({ status: 'failed' })), 'error')
  assert.equal(m.statusFromConversation(summary(11, 'idle'), run({ status: 'completed' })), 'done')
  assert.equal(m.statusFromConversation(undefined, undefined), 'pending')

  const emptyAgg = { status: 'pending' as const, total: 0, done: 0, running: 0, blocked: 0, error: 0, aborted: 0 }
  assert.equal(m.effectiveRunStatus({ status: 'completed' }, emptyAgg), 'done')
  assert.equal(m.effectiveRunStatus({ status: 'aborted' }, emptyAgg), 'aborted')
  assert.equal(m.effectiveRunStatus({ status: 'completed' }, { ...emptyAgg, running: 1, total: 1, status: 'working' }), 'working')
  assert.equal(m.effectiveRunStatus({ status: 'running' }, { ...emptyAgg, blocked: 1, total: 1, status: 'blocked' }), 'blocked')
  assert.equal(m.effectiveRunStatus({ status: 'aborted' }, { ...emptyAgg, error: 1, total: 1, status: 'error' }), 'error')
})

// ---------------------------------------------------------------------------
// 2. runs 唯一根源：人类 fork 与无 run 会话绝不泄漏
// ---------------------------------------------------------------------------

test('buildExecutionTree 回归：人类 fork 与无 WorkflowRun 会话绝不进入执行树、工作台或托盘', { timeout: 60_000 }, () => {
  const humanFork = summary(50, 'working', 1, { ownedBy: 'human', title: '人类分叉分支', doing: '人类对话' })
  const orphanWorker = summary(60, 'working', 1, { ownedBy: 'helmx', tags: ['worker'], title: '孤儿 Worker' })
  const realSub = summary(11, 'working', 1, { ownedBy: 'helmx', title: '真子代理', doing: '跑测试' })
  const conversations = [summary(1, 'idle', undefined, { ownedBy: 'human' }), humanFork, orphanWorker, realSub]

  assert.deepEqual(m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] }), [])

  const runs = [subagentRun('wf_real_11', 1, 11, 'running')]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(tree.map((n) => n.conversationId), [11])
  assert.equal(tree[0]!.kind, 'agent')

  const tray = m.buildActiveTraySummary({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(tray.items.map((i) => i.conversationId), [11])

  const h = createWorkflowHostHarness({ conversationId: 1, conversations, runsByConversation: { 1: runs } })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: conversations[0] }))
  try {
    assert.ok(ui.container.textContent!.includes('真子代理'))
    assert.equal(ui.container.textContent!.includes('人类分叉分支'), false)
    assert.equal(ui.container.textContent!.includes('孤儿 Worker'), false)
  } finally {
    ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// 3. 多层递归构树、DSL 认领、外部 executionId（统一 kind=agent）、去重与环路保护
// ---------------------------------------------------------------------------

test('buildExecutionTree：任意深度递归 + 自底向上聚合 + Active-First 排序', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'working'),
    summary(11, 'done', 1, { updatedAt: 40 }),
    summary(21, 'working', 11, { updatedAt: 30, doing: 'bash: pnpm test' }),
    summary(31, 'blocked', 21, { updatedAt: 20, title: '确认删除文件' }),
    summary(32, 'done', 21, { updatedAt: 25 }),
  ]
  const runs = [
    subagentRun('wf_11', 1, 11, 'completed'),
    subagentRun('wf_21', 11, 21, 'running'),
    subagentRun('wf_31', 21, 31, 'running'),
    subagentRun('wf_32', 21, 32, 'completed'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.equal(tree.length, 1)
  const child = tree[0]!
  assert.equal(child.kind, 'agent')
  assert.equal(child.conversationId, 11)
  assert.equal(child.status, 'done')
  assert.equal(child.aggregated.status, 'blocked')
  assert.equal(child.aggregated.total, 4)
  assert.equal(child.aggregated.done, 2)
  assert.equal(child.aggregated.running, 1)
  assert.equal(child.aggregated.blocked, 1)
  assert.deepEqual(child.children[0]!.children.map((n) => n.conversationId), [31, 32])
})

test('buildExecutionTree：DSL run 认领会话挂 run 下；外部 subagent 统一为 kind=agent 且不虚构 summary', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1),
    summary(21, 'working', 11, { doing: '正在实现' }),
  ]
  const runs = [
    run({
      id: 'wf_dsl',
      kind: 'workflow',
      status: 'running',
      nodes: [
        node({ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, label: '实现者' }),
        node({ id: 'n2', kind: 'action', status: 'done', label: '落盘' }),
      ],
    }),
    subagentRun('wf_21', 11, 21, 'running'),
    run({
      id: 'wf_ext',
      kind: 'subagent',
      status: 'failed',
      nodes: [node({ id: 'ext', kind: 'agent', status: 'failed', executionId: 'pane-9' })],
    }),
    run({
      id: 'wf_missing_conv',
      kind: 'subagent',
      status: 'running',
      nodes: [node({ id: 'm', kind: 'agent', status: 'running', conversationId: 77 })],
    }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const wfNode = tree.find((n) => n.kind === 'workflow')!
  assert.equal(wfNode.run?.id, 'wf_dsl')
  assert.equal(wfNode.children.length, 2)
  const agentChild = wfNode.children.find((c) => c.conversationId === 11)!
  assert.equal(agentChild.kind, 'agent')
  assert.deepEqual(agentChild.children.map((c) => c.conversationId), [21])
  const actionChild = wfNode.children.find((c) => c.kind === 'action')!
  assert.equal(actionChild.runNode?.id, 'n2')

  const extNode = tree.find((n) => n.run?.id === 'wf_ext')!
  assert.equal(extNode.kind, 'agent', '外部 subagent 统一收口为 agent 类型')
  assert.equal(extNode.conversationId, undefined)
  assert.equal(extNode.runNode?.executionId, 'pane-9')
  assert.equal(extNode.status, 'error')

  const missingConv = tree.find((n) => n.conversationId === 77)!
  assert.equal(missingConv.summary, undefined, '绝不虚构 ConversationSummary')
  assert.equal(missingConv.status, 'working')
})

test('buildExecutionTree：重复 runId 去重与成环防御', { timeout: 60_000 }, () => {
  const conversations = [summary(1, 'idle'), summary(11, 'done', 21), summary(21, 'done', 11)]
  const dup = subagentRun('wf_loop_11', 21, 11, 'completed')
  const runs = [
    run({
      id: 'wf_x',
      kind: 'workflow',
      status: 'completed',
      nodes: [node({ id: 'n1', kind: 'agent', status: 'done', conversationId: 21 })],
    }),
    dup,
    dup,
    subagentRun('wf_loop_21', 11, 21, 'completed'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const conv21 = tree[0]!.children[0]!
  assert.equal(conv21.conversationId, 21)
  assert.deepEqual(conv21.children.map((c) => c.conversationId), [11])
  assert.equal(conv21.children[0]!.children.length, 0, '祖先环截断')
})

// ---------------------------------------------------------------------------
// 4. resolveNodeTitle 单一来源与 buildActiveTraySummary 策略
// ---------------------------------------------------------------------------

test('resolveNodeTitle：自定义标题 > 非占位 run.name > toolLabel/node.label > prompt > 兜底（isFallback 标记防重复 #id）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    m.resolveNodeTitle({ kind: 'agent', conversationId: 11, summary: summary(11, 'done', 1, { title: '修复登录超时' }) }),
    { text: '修复登录超时', isFallback: false },
  )
  // 占位标题被过滤，回退 prompt 并剥离 structured_output_contract
  assert.deepEqual(
    m.resolveNodeTitle({
      kind: 'agent',
      conversationId: 11,
      summary: summary(11, 'done', 1, { title: 'subagent #11' }),
      toolPrompt: '安装依赖\n<structured_output_contract>{"type":"object"}</structured_output_contract>',
    }),
    { text: '安装依赖', isFallback: false },
  )
  // 无任何可读名称时兜底 Subagent #11 且 isFallback=true（调用方据此省略次级 #11）
  assert.deepEqual(
    m.resolveNodeTitle({ kind: 'agent', conversationId: 11, summary: summary(11, 'done', 1, { title: '子会话 11' }) }, 'en'),
    { text: 'Subagent #11', isFallback: true },
  )
  assert.deepEqual(
    m.resolveNodeTitle({ kind: 'agent', conversationId: 11, summary: summary(11, 'done', 1, { title: '子会话 11' }) }, 'zh-CN'),
    { text: '子代理 #11', isFallback: true },
  )
  // 占位 run.name 被忽略
  assert.deepEqual(
    m.resolveNodeTitle({
      kind: 'agent',
      conversationId: 12,
      run: run({ id: 'wf_bg1', name: 'subagent:codex' }),
      runNode: node({ id: 'n1', label: '调研员' }),
    }),
    { text: '调研员', isFallback: false },
  )
})

test('buildActiveTraySummary：一级进度口径、blocked 优先定位审批子孙、settled 父不泄漏旧 doing', { timeout: 60_000 }, () => {
  // 根 → B(11) → C(21) 单链不显示 0/2
  const singleChain = m.buildActiveTraySummary({
    rootConversationId: 1,
    conversations: [summary(1, 'working'), summary(11, 'working', 1), summary(21, 'working', 11)],
    runs: [subagentRun('wf_11', 1, 11, 'running'), subagentRun('wf_21', 11, 21, 'running')],
  })
  assert.equal(singleChain.items[0]!.progress, undefined)

  // 并行 2 直接子显示 1/2，不计孙子
  const parallel = m.buildActiveTraySummary({
    rootConversationId: 1,
    conversations: [
      summary(1, 'working'),
      summary(11, 'working', 1),
      summary(21, 'done', 11),
      summary(22, 'working', 11),
      summary(31, 'working', 22),
    ],
    runs: [
      subagentRun('wf_11', 1, 11, 'running'),
      subagentRun('wf_21', 11, 21, 'completed'),
      subagentRun('wf_22', 11, 22, 'running'),
      subagentRun('wf_31', 22, 31, 'running'),
    ],
  })
  assert.deepEqual(parallel.items[0]!.progress, { done: 1, total: 2 })

  // working 父 + blocked 子：activityConversationId 指向 blocked 子
  const blockedNested = m.buildActiveTraySummary({
    rootConversationId: 1,
    conversations: [
      summary(1, 'working'),
      summary(21, 'working', 1, { doing: 'pnpm build' }),
      summary(31, 'blocked', 21, { pendingAskCount: 1, pendingAskSince: 5_000 }),
    ],
    runs: [subagentRun('wf_21', 1, 21, 'running'), subagentRun('wf_31', 21, 31, 'running')],
  })
  assert.equal(blockedNested.blockedCount, 1)
  assert.equal(blockedNested.items[0]!.isBlocked, true)
  assert.equal(blockedNested.items[0]!.activityConversationId, 31, '审批子孙优先成为活动目标')
  assert.equal(blockedNested.earliestPendingAskSince, 5_000)

  // settled 父 + running 子：不泄漏父旧 doing
  const settledParent = m.buildActiveTraySummary({
    rootConversationId: 1,
    conversations: [
      summary(1, 'idle'),
      summary(11, 'done', 1, { doing: '旧收尾文案' }),
      summary(21, 'working', 11, { doing: 'bash: pnpm build' }),
    ],
    runs: [subagentRun('wf_11', 1, 11, 'completed'), subagentRun('wf_21', 11, 21, 'running')],
  })
  assert.equal(settledParent.items[0]!.doing, undefined, '自身 settled 时不得泄漏旧 doing')
  assert.equal(settledParent.items[0]!.activityConversationId, 21)
})
