/**
 * builtin:workflow 插件 client 会话文档响应、后台活动注册与 60Hz 零订阅回归测试：
 * - usePluginSessionDoc('runs') 快照与增量推送驱动 SubagentToolView / WorkflowToolView；
 * - SubagentToolView 传 `{ includeDetail: false, includeLive: false }`：
 *   断言 loadDetailCalls 为空且 liveSubscriptions 为空（彻底消除时间线 60Hz token 重渲染）；
 * - useToolActivity (`activeToolCallIds`) 精确按子会话与 run 状态登记 / 释放后台活动；
 * - resume 续接仅最新调用上报活动，卸载旧卡不误删新卡登记；
 * - TimelineToolCallsContext 仅订阅 subagent 分片，无关工具更新零通知/零重渲染。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TimelineToolCallSummary } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement

mountSharedPluginNamespaces({ realHooks: true })
const mod = await importWorkflowClientModule('index.tsx', undefined, { realHooks: true })
const SubagentToolView = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowToolView = mod['WorkflowToolView'] as React.ComponentType<Record<string, unknown>>

test('SubagentToolView：消费 runs 增量、登记/释放后台活动、零 detail 加载且零 live 60Hz 订阅、点击开抽屉', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { parentConversationId: 1, parentToolCallId: 'call-bg' })
  const run: WorkflowRunSummary = {
    id: 'wf_bg',
    kind: 'subagent',
    name: '后台任务',
    conversationId: 1,
    parentToolCallId: 'call-bg',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child],
    runsByConversation: { 1: [run] },
    locale: 'en',
  })
  const view = e(SubagentToolView, {
    callId: 'call-bg',
    toolName: 'subagent',
    input: { prompt: '跑后台测试' },
    result: '已提交',
    presentationMeta: { ok: true, execution: { conversationId: 11 } },
    status: 'done',
    conversationId: 1,
  })
  const ui = h.mountNode(view)
  try {
    assert.match(ui.container.textContent!, /Running in background/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), true)
    assert.deepEqual(h.log.loadDetailCalls, [], '时间线不得拉取子会话全量 detail')
    assert.deepEqual(h.log.liveSubscriptions, [], 'SubagentToolView 必须传 includeLive:false 避免 60Hz 订阅')

    act(() => {
      ;(ui.container.querySelector('button.wf-trace-toggle') as HTMLElement).click()
    })
    assert.deepEqual(h.log.drawers, [11])
    assert.deepEqual(h.log.screens, [])
    assert.deepEqual(h.log.workbenchOpens, [])

    h.setConversations([parent, { ...child, status: 'blocked' }])
    assert.match(ui.container.textContent!, /Awaiting approval/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), true)

    h.setConversations([parent, child])
    h.setRuns(1, [{ ...run, status: 'failed', error: 'Gate 命令退出码 1' }])
    ui.rerender(view)
    assert.ok(ui.container.querySelector('.trace-row.trace-row-error') !== null)
    assert.match(ui.container.textContent!, /Failed/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), false)

    h.setRuns(1, [{ ...run, status: 'aborted' }])
    ui.rerender(view)
    assert.match(ui.container.textContent!, /Aborted/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), false)

    h.setRuns(1, [{ ...run, status: 'completed' }])
    ui.rerender(view)
    assert.ok(ui.container.querySelector('.trace-row.trace-row-error') === null)
    assert.match(ui.container.textContent!, /Completed/)
    assert.equal(h.log.activeToolCallIds.has('call-bg'), false)
  } finally {
    ui.unmount()
  }
})

test('真实子会话 working/blocked 独立报告活动；静态文本不伪造活动', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { parentConversationId: 1, parentToolCallId: 'child-call' })
  for (const status of ['working', 'blocked', 'idle', 'done', 'error'] as const) {
    const h = createWorkflowHostHarness({
      conversationId: 1,
      conversations: [parent, { ...child, status }],
      runsByConversation: { 1: [] },
    })
    const ui = h.mountNode(
      e(SubagentToolView, {
        callId: 'child-call',
        toolName: 'subagent',
        input: { prompt: '子任务' },
        result: '已提交',
        status: 'done',
        conversationId: 1,
      }),
    )
    try {
      assert.equal(h.log.activeToolCallIds.has('child-call'), status === 'working' || status === 'blocked')
    } finally {
      ui.unmount()
    }
  }

  const hStatic = createWorkflowHostHarness({ conversationId: 1, conversations: [parent], runsByConversation: { 1: [] } })
  const uiStatic = hStatic.mountNode(
    e(SubagentToolView, {
      callId: 'unknown',
      toolName: 'subagent',
      input: {},
      result: '{"status":"running"}',
      status: 'done',
      conversationId: 1,
    }),
  )
  try {
    assert.equal(hStatic.log.activeToolCallIds.has('unknown'), false)
  } finally {
    uiStatic.unmount()
  }
})

test('WorkflowToolView 与外部 subagent 按真实 run.running 报告活动，终态与卸载释放', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  for (const toolName of ['SubagentWorkflow', 'subagent'] as const) {
    const callId = `${toolName}-call`
    const Comp = toolName === 'SubagentWorkflow' ? WorkflowToolView : SubagentToolView
    const run: WorkflowRunSummary = {
      id: `run-${toolName}`,
      kind: toolName === 'subagent' ? 'subagent' : 'workflow',
      name: '真实后台运行',
      conversationId: 1,
      parentToolCallId: callId,
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 'external', kind: 'agent', status: 'running', executionId: 'pane-42' }],
    }
    const h = createWorkflowHostHarness({ conversationId: 1, conversations: [parent], runsByConversation: { 1: [run] } })
    const ui = h.mountNode(e(Comp, { callId, toolName, input: {}, result: '已提交', status: 'done', conversationId: 1 }))
    try {
      assert.equal(h.log.activeToolCallIds.has(callId), true)
      for (const status of ['failed', 'aborted', 'completed'] as const) {
        h.setRuns(1, [{ ...run, status }])
        assert.equal(h.log.activeToolCallIds.has(callId), false)
      }
      h.setRuns(1, [{ ...run, status: 'running' }])
      assert.equal(h.log.activeToolCallIds.has(callId), true)
    } finally {
      ui.unmount()
    }
    assert.equal(h.log.activeToolCallIds.has(callId), false)
  }
})

test('resume 仅最新调用报告活动；卸载旧卡不误删新卡登记；外部 executionId 同样去重', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { status: 'working', parentConversationId: 1, parentToolCallId: 'old-call' })
  const oldRun: WorkflowRunSummary = {
    id: 'old-run',
    kind: 'subagent',
    name: '首次运行',
    conversationId: 1,
    parentToolCallId: 'old-call',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'agent', kind: 'agent', status: 'running', conversationId: 11 }],
  }
  const exec11 = { execution: { conversationId: 11 } }
  const oldCall = { callId: 'old-call', toolName: 'subagent', status: 'done' as const, input: {}, result: '已提交', presentationMeta: exec11 }
  const newCall = { callId: 'new-call', toolName: 'subagent', status: 'done' as const, input: { resume: 11, prompt: '继续' }, result: '已提交', presentationMeta: exec11 }
  const oldSummary: TimelineToolCallSummary = { callId: 'old-call', toolName: 'subagent', index: 0, status: 'done', input: oldCall.input, presentationMeta: exec11 }
  const newSummary: TimelineToolCallSummary = { callId: 'new-call', toolName: 'subagent', index: 1, status: 'done', input: newCall.input, presentationMeta: exec11 }

  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child],
    runsByConversation: { 1: [oldRun] },
    timelineToolCalls: [oldSummary],
    locale: 'en',
  })
  const ui = h.mountNode(e(SubagentToolView, { ...oldCall, conversationId: 1 }))
  try {
    assert.deepEqual([...h.log.activeToolCallIds], ['old-call'])
    h.setConversations([parent, { ...child, status: 'working', parentToolCallId: 'new-call' }])
    h.setTimelineToolCalls([oldSummary, newSummary])
    ui.rerender(e(React.Fragment, null, e(SubagentToolView, { ...oldCall, conversationId: 1 }), e(SubagentToolView, { ...newCall, conversationId: 1 })))
    assert.deepEqual([...h.log.activeToolCallIds], ['new-call'])
    const rows = ui.container.querySelectorAll('button.wf-trace-toggle')
    assert.equal(rows.length, 2)
    assert.match(rows[0]!.textContent ?? '', /Resumed below/)
    assert.doesNotMatch(rows[1]!.textContent ?? '', /Resumed below/)

    ui.rerender(e(SubagentToolView, { ...newCall, conversationId: 1 }))
    assert.deepEqual([...h.log.activeToolCallIds], ['new-call'])
    h.setConversations([parent, { ...child, status: 'idle', parentToolCallId: 'new-call' }])
    assert.deepEqual([...h.log.activeToolCallIds], [])
  } finally {
    ui.unmount()
  }
})

test('SubagentToolView 仅订阅 subagent 分片，无关工具更新零通知/零重渲染', { timeout: 60_000 }, () => {
  const parent = makeConvSummary(1)
  const child = makeConvSummary(11, { status: 'working', parentConversationId: 1, parentToolCallId: 'new-call' })
  const meta = { ok: true, execution: { conversationId: 11 } }
  const oldInput = { prompt: '首轮' }
  const newInput = { resume: 11, prompt: '续接' }
  const initialCalls: TimelineToolCallSummary[] = [
    { callId: 'old-call', toolName: 'subagent', index: 0, status: 'done', input: oldInput, presentationMeta: meta },
    { callId: 'new-call', toolName: 'subagent', index: 1, status: 'done', input: newInput, presentationMeta: meta },
  ]
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child],
    runsByConversation: { 1: [] },
    timelineToolCalls: initialCalls,
    locale: 'en',
  })
  let subagentNotifies = 0
  const unsub = h.timelineToolCallsStore.subscribe('subagent', () => { subagentNotifies++ })
  let renderCount = 0
  const Tracked = React.memo(function Tracked(props: Record<string, unknown>) {
    renderCount++
    return e(SubagentToolView, props)
  })
  const ui = h.mountNode(
    e(
      React.Fragment,
      null,
      e(Tracked, { callId: 'old-call', toolName: 'subagent', status: 'done', input: oldInput, presentationMeta: meta, conversationId: 1 }),
      e(Tracked, { callId: 'new-call', toolName: 'subagent', status: 'done', input: newInput, presentationMeta: meta, conversationId: 1 }),
    ),
  )
  try {
    const afterMount = renderCount
    h.setTimelineToolCalls([
      ...initialCalls,
      { callId: 'bash-1', toolName: 'bash', index: 2, status: 'running', input: { command: 'ls' } },
      { callId: 'read-1', toolName: 'read', index: 3, status: 'done', input: { path: 'README.md' } },
    ])
    assert.equal(subagentNotifies, 0)
    assert.equal(renderCount, afterMount)
  } finally {
    unsub()
    ui.unmount()
  }
})
