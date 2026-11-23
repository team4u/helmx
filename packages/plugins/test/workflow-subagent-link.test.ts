/**
 * builtin:workflow subagent / SubagentWorkflow 运行期关联与 WeakMap 索引测试：
 * - resolveSubagentConversationId（presentationMeta.execution > callId/parentToolCallId > numeric resume，绝不 JSON.parse(result)）；
 * - resolveWorkflowRunForTool（parentToolCallId + presentationMeta.runId 精确命中，绝不猜测最新）；
 * - resolveSubagentExecutionMeta（run 节点 worktree 优先于 presentationMeta，跨父会话不串卡）；
 * - buildSubagentLatestCallIndex & isLatestSubagentCallForTarget（O(K+M) + WeakMap 缓存）；
 * - isBackgroundWorkflowResultHandle & resolveWorkflowToolFallbackLabel。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  importWorkflowModels,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

mountSharedPluginNamespaces()
const m = await importWorkflowModels()

function convSummary(id: number, parentConversationId?: number, parentToolCallId?: string) {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  }
}

function workflowRun(
  id: string,
  conversationId: number,
  status: 'running' | 'completed' | 'failed' | 'aborted',
  updatedAt = 1,
  parentToolCallId?: string,
): WorkflowRunSummary {
  return {
    id,
    name: `run ${id}`,
    conversationId,
    status,
    createdAt: 1,
    updatedAt,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  }
}

test('resolveSubagentConversationId：presentationMeta.execution > callId > numeric resume；零 JSON.parse 兜底', { timeout: 60_000 }, () => {
  const conversations = [
    convSummary(10, 1),
    convSummary(11, 1, 'call-abc'),
    convSummary(12, 2, 'call-abc'),
  ]
  assert.equal(m.resolveSubagentConversationId({ callId: 'call-abc', input: { prompt: '修构建' } }, 1, conversations), 11)
  assert.equal(
    m.resolveSubagentConversationId(
      { callId: 'call-none', input: {}, presentationMeta: { ok: true, execution: { conversationId: 11, executionId: 'herdr:1' } } },
      1,
      conversations,
    ),
    11,
  )
  assert.equal(m.resolveSubagentConversationId({ callId: 'call-none', input: {} }, 1, conversations), undefined)
  assert.equal(
    m.resolveSubagentConversationId(
      { callId: 'call-none', input: {}, presentationMeta: '{"ok":true,"execution":{"conversationId":11}}' },
      1,
      conversations,
    ),
    undefined,
  )
  assert.equal(
    m.resolveSubagentConversationId(
      { callId: 'call-none', input: {}, presentationMeta: { ok: true, execution: { conversationId: 0 } } },
      1,
      conversations,
    ),
    undefined,
  )
  // 外部 executionId 不虚构子会话
  assert.equal(
    m.resolveSubagentConversationId(
      { callId: 'call-none', input: {}, presentationMeta: { ok: true, runId: 'wf_abc', execution: { executionId: 'pane-9' } } },
      1,
      conversations,
    ),
    undefined,
  )
})

test('resolveSubagentConversationId：resume 数字与字符串 ref 匹配同父会话，跨父或非法拒绝', { timeout: 60_000 }, () => {
  const conversations = [convSummary(21, 1), convSummary(22, 2)]
  assert.equal(m.resolveSubagentConversationId({ callId: 'call-xyz', input: { resume: '21' } }, 1, conversations), 21)
  assert.equal(m.resolveSubagentConversationId({ callId: 'call-xyz', input: { resume: 21 } }, 1, conversations), 21)
  for (const bad of ['22', 'worker-1', 0, -21, 1.5, 99]) {
    assert.equal(m.resolveSubagentConversationId({ callId: 'call-none', input: { resume: bad } }, 1, conversations), undefined)
  }
})

test('buildSubagentLatestCallIndex & isLatestSubagentCallForTarget：WeakMap 缓存与 native/external 续接识别', { timeout: 60_000 }, () => {
  const conversations = [convSummary(42, 1)]
  const timelineCalls = [
    { callId: 'other_tool', toolName: 'bash', input: { command: 'ls' }, status: 'done' as const },
    { callId: 'call_1', toolName: 'subagent', input: { prompt: '首轮' }, status: 'done' as const, presentationMeta: { ok: true, execution: { conversationId: 42 } } },
    { callId: 'call_2', toolName: 'subagent', input: { prompt: '续接', resume: 42 }, status: 'done' as const, presentationMeta: { ok: true, execution: { conversationId: 42 } } },
  ]
  const indexA = m.buildSubagentLatestCallIndex(timelineCalls, 1, conversations)
  const indexB = m.buildSubagentLatestCallIndex(timelineCalls, 1, conversations)
  assert.ok(indexA === indexB, '同引用输入命中 WeakMap 缓存')
  assert.equal(indexA.knownCallIds.has('other_tool'), false)
  assert.equal(indexA.latestByTarget.get('conv:42'), 'call_2')

  assert.equal(m.isLatestSubagentCallForTarget({ callId: 'call_1', timelineCalls, conversationId: 1 }, 42, conversations), false)
  assert.equal(m.isLatestSubagentCallForTarget({ callId: 'call_2', timelineCalls, conversationId: 1 }, 42, conversations), true)
  assert.equal(m.isLatestSubagentCallForTarget({ callId: 'unlisted', timelineCalls, conversationId: 1 }, 42, conversations), true)

  const extCalls = [
    { callId: 'ext_1', toolName: 'subagent', input: { prompt: '外部首轮' }, status: 'done' as const, presentationMeta: { ok: true, execution: { executionId: 'pane-42' } } },
    { callId: 'ext_2', toolName: 'subagent', input: { prompt: '外部续接', resume: 'pane-42' }, status: 'running' as const },
  ]
  assert.equal(m.isLatestSubagentCallForTarget({ callId: 'ext_1', timelineCalls: extCalls, conversationId: 1 }, undefined, [], 'pane-42'), false)
  assert.equal(m.isLatestSubagentCallForTarget({ callId: 'ext_2', timelineCalls: extCalls, conversationId: 1 }, undefined, [], 'pane-42'), true)
})

test('resolveWorkflowRunForTool / resolveSubagentExecutionMeta / isBackgroundWorkflowResultHandle', { timeout: 60_000 }, () => {
  const dualRunning = [
    workflowRun('run-a', 1, 'running', 5, 'call-wf'),
    workflowRun('run-b', 1, 'running', 9, 'call-other'),
  ]
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, dualRunning)?.id, 'run-a')
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 2, dualRunning), undefined)
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-missing', presentationMeta: { ok: true, runId: 'run-a' } }, 1, dualRunning)?.id,
    'run-a',
  )
  assert.equal(m.resolveWorkflowRunForTool({ callId: undefined }, 1, dualRunning), undefined)

  assert.equal(m.isBackgroundWorkflowResultHandle({ ok: true, background: true, runId: 'wf_1' }), true)
  assert.equal(m.isBackgroundWorkflowResultHandle({ ok: true, runId: 'wf_1' }), false)
  assert.equal(m.isBackgroundWorkflowResultHandle('{"background":true}'), false)
  assert.equal(
    m.resolveWorkflowToolFallbackLabel({ resumeFromRunId: 'wf_1' }, 'en', { ok: true, runId: 'wf_2', label: 'Daily Audit' }),
    'Daily Audit',
  )
  assert.equal(
    m.resolveWorkflowToolFallbackLabel({ resumeFromRunId: 'wf_1' }, 'en', { ok: true, runId: 'wf_2', label: 'wf_2' }),
    'Resume wf_1',
  )

  const prefRun = workflowRun('wf_pref', 1, 'running', 3, 'call-p')
  prefRun.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/from-run', branch: 'helmx/from-run' } }]
  const meta = m.resolveSubagentExecutionMeta(
    {
      callId: 'call-p',
      presentationMeta: {
        ok: true,
        runId: 'wf_pref',
        execution: {
          nodeId: 'node-a',
          executionId: 'pane-9',
          effectiveCwd: '/wt dir/sub',
          worktree: { path: '/wt/from-meta', branch: 'helmx/from-meta' },
        },
      },
    },
    1,
    [prefRun],
  )
  assert.equal(meta.run?.id, 'wf_pref')
  assert.deepEqual(meta.worktree, { path: '/wt/from-run', branch: 'helmx/from-run' }, 'run 节点 worktree 优先于 presentationMeta')
  assert.equal(meta.executionId, 'pane-9')
  assert.equal(meta.nodeId, 'node-a')
  assert.equal(meta.effectiveCwd, '/wt dir/sub')
  assert.deepEqual(m.resolveSubagentExecutionMeta({ callId: 'call-p' }, 2, [prefRun]), {})
})
