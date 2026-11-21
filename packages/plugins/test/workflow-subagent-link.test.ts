/**
 * builtin:workflow subagent / SubagentWorkflow 运行期关联与实时流模型测试：
 * - resolveSubagentConversationId（presentationMeta.execution > callId/parentToolCallId > numeric resume，绝不 JSON.parse(result) 或正则刮取）；
 * - resolveWorkflowRunForTool（parentToolCallId + presentationMeta.runId 精确命中，绝不 JSON.parse(result) 或猜测最新）；
 * - resolveSubagentExecutionMeta（run 节点 worktree 优先于 presentationMeta，跨父会话不串卡）；
 * - buildSubagentLatestCallIndex & isLatestSubagentCallForTarget（O(K+M) 单遍索引 + WeakMap 缓存，读取 presentationMeta.execution）；
 * - isBackgroundWorkflowResultHandle & resolveWorkflowToolFallbackLabel（presentationMeta 通道）；
 * - buildSubagentStreamLines（剥离 structured_output_contract 样板并合并 ConversationLive）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationLive } from '@helmx/protocol'
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

function entry(id: string, kind: string, extra: { data?: unknown; model?: unknown[] } = {}): ConversationEntry {
  return { id, kind, ...(extra.data !== undefined ? { data: extra.data } : {}), ...(extra.model !== undefined ? { model: extra.model } : {}) }
}

function assistantEntry(id: string, blocks: unknown[]): ConversationEntry {
  return entry(id, 'pi.assistant', { model: [{ role: 'assistant', content: blocks }] })
}

function toolResultEntry(
  id: string,
  callId: string,
  toolName: string,
  opts: { isError?: boolean; text?: string; durationMs?: number; details?: unknown } = {},
): ConversationEntry {
  return entry(id, 'pi.tool-result', {
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName,
        content: opts.text !== undefined ? [{ type: 'text', text: opts.text }] : [],
        isError: opts.isError === true,
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        ...(opts.details !== undefined ? { details: opts.details } : {}),
      },
    ],
  })
}

function toolCallBlock(callId: string, name: string, input: Record<string, unknown>): unknown {
  return { type: 'toolCall', id: callId, name, arguments: input }
}

test('resolveSubagentConversationId：presentationMeta.execution 优先，其次 callId/parentToolCallId；绝不 JSON.parse(result) 或正则刮取', { timeout: 60_000 }, () => {
  const conversations = [
    convSummary(10, 1),
    convSummary(11, 1, 'call-abc'),
    convSummary(12, 2, 'call-abc'), // 属其他父会话，不得误命中
  ]
  const running = {
    callId: 'call-abc',
    input: { prompt: '去修构建' },
  }
  assert.equal(m.resolveSubagentConversationId(running, 1, conversations), 11)

  // presentationMeta.execution.conversationId 优先
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: { prompt: '任务' },
        presentationMeta: { ok: true, execution: { conversationId: 11, executionId: 'herdr:1' } },
      },
      1,
      conversations,
    ),
    11,
  )

  // 正文或旧式 [subagent ...] 文本均不做正则刮取（无 callId/presentationMeta/resume 时返回 undefined）
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
      },
      1,
      conversations,
    ),
    undefined,
    '无 presentationMeta/callId/resume 时不得伪造关联',
  )

  // 非法正整数 conversationId 不采纳
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        presentationMeta: { ok: true, execution: { conversationId: 0 } },
      },
      1,
      conversations,
    ),
    undefined,
  )
})

test('resolveSubagentConversationId：不依赖 result JSON.parse 兜底，外部 executionId 不虚构子会话', { timeout: 60_000 }, () => {
  const conversations = [convSummary(668, 1, 'call-json')]
  // 删除 props.result JSON.parse 兜底：无 presentationMeta / callId 时不解析 result 字符串
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        presentationMeta: undefined,
      },
      1,
      conversations,
    ),
    undefined,
  )
  // 若误传 JSON 字符串作 presentationMeta（非普通对象），同样显式忽略不 JSON.parse
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        presentationMeta: '{"ok":true,"execution":{"conversationId":668}}',
      },
      1,
      conversations,
    ),
    undefined,
  )
  // 外部 executionId 后台句柄：无 conversationId 且无 callId 时不虚构子会话
  assert.equal(
    m.resolveSubagentConversationId(
      {
        callId: 'call-none',
        input: {},
        presentationMeta: { ok: true, runId: 'wf_abc123', execution: { executionId: 'pane-9' } },
      },
      1,
      conversations,
    ),
    undefined,
  )
})

test('resolveSubagentConversationId：resume 数字与字符串 ref 匹配同父会话，跨父或非正整数拒绝', { timeout: 60_000 }, () => {
  const conversations = [convSummary(21, 1), convSummary(22, 2)]
  assert.equal(
    m.resolveSubagentConversationId({ callId: 'call-xyz', input: { prompt: '继续', resume: '21' } }, 1, conversations),
    21,
  )
  assert.equal(
    m.resolveSubagentConversationId({ callId: 'call-xyz', input: { prompt: '继续', resume: 21 } }, 1, conversations),
    21,
  )
  // 跨父会话 / 非正整数 / 非数字 ref：拒绝
  for (const bad of ['22', 'worker-1', 0, -21, 1.5, 99]) {
    assert.equal(
      m.resolveSubagentConversationId({ callId: 'call-none', input: { resume: bad } }, 1, conversations),
      undefined,
      `resume=${String(bad)} 不得误命中`,
    )
  }
})

test('isLatestSubagentCallForTarget & buildSubagentLatestCallIndex：通过 timelineCalls[].presentationMeta 精确识别后续 resume 与 WeakMap 缓存', { timeout: 60_000 }, () => {
  const conversations = [convSummary(42, 1)]
  const timelineCalls = [
    {
      callId: 'other_tool',
      toolName: 'bash',
      input: { command: 'ls' },
      status: 'done' as const,
    },
    {
      callId: 'call_1',
      toolName: 'subagent',
      input: { prompt: '首轮' },
      status: 'done' as const,
      presentationMeta: { ok: true, execution: { conversationId: 42 } },
    },
    {
      callId: 'call_2',
      toolName: 'subagent',
      input: { prompt: '续接', resume: 42 },
      status: 'done' as const,
      presentationMeta: { ok: true, execution: { conversationId: 42 } },
    },
  ]
  const indexA = m.buildSubagentLatestCallIndex(timelineCalls, 1, conversations)
  const indexB = m.buildSubagentLatestCallIndex(timelineCalls, 1, conversations)
  assert.ok(indexA === indexB, '同引用输入应命中 WeakMap 缓存返回同一索引实例')
  assert.equal(indexA.knownCallIds.has('other_tool'), false, '非 subagent 工具不得进入索引')
  assert.equal(indexA.latestByTarget.get('conv:42'), 'call_2')

  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'call_1',
        input: timelineCalls[1]!.input,
        presentationMeta: timelineCalls[1]!.presentationMeta,
        timelineCalls,
        conversationId: 1,
      },
      42,
      conversations,
    ),
    false,
    'call_1 已被后续 call_2 续接',
  )
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'call_2',
        input: timelineCalls[2]!.input,
        presentationMeta: timelineCalls[2]!.presentationMeta,
        timelineCalls,
        conversationId: 1,
      },
      42,
      conversations,
    ),
    true,
  )
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'unlisted_call',
        input: {},
        timelineCalls,
        conversationId: 1,
      },
      42,
      conversations,
    ),
    true,
    '未在 timelineCalls 中出现的调用保持 true',
  )

  // 外部 executionId 同样通过 timelineCalls[].presentationMeta.execution.executionId 判定最新调用
  const extCalls = [
    {
      callId: 'ext_1',
      toolName: 'subagent',
      input: { prompt: '外部首轮' },
      status: 'done' as const,
      presentationMeta: { ok: true, execution: { executionId: 'pane-42' } },
    },
    {
      callId: 'ext_2',
      toolName: 'subagent',
      input: { prompt: '外部续接', resume: 'pane-42' },
      status: 'running' as const,
    },
  ]
  assert.equal(
    m.isLatestSubagentCallForTarget(
      {
        callId: 'ext_1',
        input: extCalls[0]!.input,
        presentationMeta: extCalls[0]!.presentationMeta,
        timelineCalls: extCalls,
        conversationId: 1,
      },
      undefined,
      [],
      'pane-42',
    ),
    false,
  )
})

test('resolveWorkflowRunForTool / isBackgroundWorkflowResultHandle / resolveWorkflowToolFallbackLabel：基于 presentationMeta，绝不 JSON.parse(result)', { timeout: 60_000 }, () => {
  const dualRunning = [
    workflowRun('run-a', 1, 'running', 5, 'call-wf'),
    workflowRun('run-b', 1, 'running', 9, 'call-other'),
  ]
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, dualRunning)?.id, 'run-a')
  assert.equal(m.resolveWorkflowRunForTool({ callId: 'call-other' }, 1, dualRunning)?.id, 'run-b')

  // 旧 completed + 新调用未创建 run：不猜旧 run
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, [workflowRun('run-old', 1, 'completed', 1, 'call-past')]),
    undefined,
  )
  // 跨会话拒绝
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, [workflowRun('run-x', 2, 'running', 9, 'call-wf')]),
    undefined,
  )

  // presentationMeta.runId 精确命中
  const history = [
    workflowRun('run-legacy', 1, 'completed', 1),
    workflowRun('run-newer', 1, 'completed', 8),
    workflowRun('run-old', 1, 'completed', 1),
  ]
  assert.equal(
    m.resolveWorkflowRunForTool(
      { callId: 'call-missing', presentationMeta: { ok: true, runId: 'run-legacy', status: 'completed' } },
      1,
      history,
    )?.id,
    'run-legacy',
  )
  // 非对象（如误传 JSON 字符串）不解析
  assert.equal(
    m.resolveWorkflowRunForTool(
      { callId: 'call-missing', presentationMeta: '{"runId":"run-legacy"}' },
      1,
      history,
    ),
    undefined,
  )
  // callId 关联存在：仍命中真实失败 run
  assert.equal(
    m.resolveWorkflowRunForTool({ callId: 'call-wf' }, 1, dualRunning)?.id,
    'run-a',
  )
  // 无 callId + 无 presentationMeta.runId：undefined
  assert.equal(m.resolveWorkflowRunForTool({ callId: undefined }, 1, dualRunning), undefined)

  // isBackgroundWorkflowResultHandle & resolveWorkflowToolFallbackLabel
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
})

test('resolveSubagentExecutionMeta：parentToolCallId 与 presentationMeta 精确提取；run 节点 worktree 优先；零 JSON.parse/footer 刮取', { timeout: 60_000 }, () => {
  const run = workflowRun('wf_link', 1, 'running', 3, 'call-bg')
  run.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/link', branch: 'helmx/bg-link' } }]
  const meta = m.resolveSubagentExecutionMeta({ callId: 'call-bg' }, 1, [run])
  assert.equal(meta.run?.id, 'wf_link')
  assert.deepEqual(meta.worktree, { path: '/wt/link', branch: 'helmx/bg-link' })
  assert.deepEqual(m.resolveSubagentExecutionMeta({ callId: 'call-bg' }, 2, [run]), {})

  // presentationMeta 携带完整 execution + runId（含空格路径）
  const runs = [workflowRun('wf_abc123', 1, 'running'), workflowRun('wf_other', 1, 'completed')]
  const structuredMeta = m.resolveSubagentExecutionMeta(
    {
      callId: 'call-x',
      presentationMeta: {
        ok: true,
        runId: 'wf_abc123',
        execution: {
          nodeId: 'node-a',
          executionId: 'pane-9',
          effectiveCwd: '/wt dir/sub',
          worktree: { path: '/wt dir/sub', branch: 'helmx/bg-main' },
        },
      },
    },
    1,
    runs,
  )
  assert.equal(structuredMeta.run?.id, 'wf_abc123')
  assert.deepEqual(structuredMeta.worktree, { path: '/wt dir/sub', branch: 'helmx/bg-main' })
  assert.equal(structuredMeta.executionId, 'pane-9')
  assert.equal(structuredMeta.nodeId, 'node-a')
  assert.equal(structuredMeta.effectiveCwd, '/wt dir/sub')

  // run 节点 worktree 优先于 presentationMeta
  const prefRun = workflowRun('wf_pref', 1, 'running', 3, 'call-p')
  prefRun.nodes = [{ id: 'n1', kind: 'agent', status: 'running', worktree: { path: '/wt/from-run', branch: 'helmx/from-run' } }]
  const prefMeta = m.resolveSubagentExecutionMeta(
    {
      callId: 'call-p',
      presentationMeta: { ok: true, runId: 'wf_pref', execution: { worktree: { path: '/wt/from-json', branch: 'helmx/from-json' } } },
    },
    1,
    [prefRun],
  )
  assert.deepEqual(prefMeta.worktree, { path: '/wt/from-run', branch: 'helmx/from-run' })

  // 字符串非对象不解析
  assert.deepEqual(
    m.resolveSubagentExecutionMeta(
      {
        callId: 'call-none',
        presentationMeta: '{"ok":true,"runId":"wf_abc123"}',
      },
      1,
      runs,
    ),
    {},
  )
})

test('buildSubagentStreamLines：剥离 structured_output_contract 样板并合并 ConversationLive', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helmx.input', {
      data: {
        text: '帮我修复构建\n\n<structured_output_contract>\n调用 register_structured_output 工具\nSchema: {}\n</structured_output_contract>',
        origin: 'agent',
      },
    }),
    assistantEntry('2', [
      { type: 'thinking', thinking: '先看构建日志' },
      toolCallBlock('c1', 'bash', { command: 'pnpm build' }),
      { type: 'text', text: '构建已修复' },
    ]),
    toolResultEntry('3', 'c1', 'bash', { text: 'exit 0', durationMs: 1500 }),
  ]
  const lines = m.buildSubagentStreamLines(entries, undefined, false)
  assert.equal(lines.length, 4)
  assert.equal(lines[0]!.kind, 'prompt')
  assert.ok(lines[0]!.kind === 'prompt' && !lines[0]!.text.includes('structured_output_contract'))
  assert.ok(lines[0]!.kind === 'prompt' && lines[0]!.text.startsWith('帮我修复构建'))
  assert.equal(lines[1]!.kind, 'thinking')
  assert.equal(lines[2]!.kind, 'tool')
  assert.ok(lines[2]!.kind === 'tool' && lines[2]!.durationMs === 1500 && lines[2]!.resultPreview === 'exit 0')
  assert.equal(lines[3]!.kind, 'text')

  const live: ConversationLive = {
    conversationId: 11,
    text: '正在分析输出…',
    thinking: '流式思考中',
    tools: [{ callId: 'lc1', toolName: 'read', input: { file_path: '/a.ts' }, status: 'running' }],
    updatedAt: 1234,
  }
  const liveLines = m.buildSubagentStreamLines([entry('1', 'helmx.input', { data: { text: '继续任务', origin: 'agent' } })], live, true)
  assert.deepEqual(liveLines.map((l) => l.kind), ['prompt', 'thinking', 'tool', 'text'])
})
