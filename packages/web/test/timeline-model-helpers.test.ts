/**
 * timeline-model 视图纯函数单测（自 ConversationTimeline.tsx 迁入的纯逻辑）：
 * - toolStatusIcon：运行中/失败/完成/其他四态图标名；
 * - buildToolViewProps：tool.view 标准 Props 构造（状态映射、可选字段省略、透传）；
 * - buildActiveEntryIndex：rewind 覆盖过滤后的真实条目索引；
 * - resolveAssistantAnchorEntry：assistant 回合 action 锚点解析（正文载体优先，
 *   纯 toolCall 载体兜底，绝不拿 pi.tool-result 伪造）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversationEntry, ConversationLive } from '@helmx/protocol'
import {
  buildActiveEntryIndex,
  buildLiveTimelineTail,
  buildSettledTimelinePrefix,
  buildTimelineItems,
  buildToolViewProps,
  resolveAssistantAnchorEntry,
  toolStatusIcon,
  type AssistantTurn,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'

const trace = (overrides?: Partial<ToolTrace>): ToolTrace => ({
  key: 'tool:1',
  toolName: 'bash',
  status: 'done',
  isError: false,
  ...overrides,
})

test('toolStatusIcon：运行中 loader、失败 x、完成 check、其他 circle（优先级递减）', { timeout: 60_000 }, () => {
  assert.equal(toolStatusIcon(trace({ status: 'running' })), 'loader')
  // isError 优先于 done：失败的工具即使状态残留 done 也显示 x
  assert.equal(toolStatusIcon(trace({ status: 'done', isError: true })), 'x')
  assert.equal(toolStatusIcon(trace({ status: 'done' })), 'check')
  assert.equal(toolStatusIcon(trace({ status: 'unknown' })), 'circle')
  // error 状态但未标记 isError（防御）：不伪称完成，落 circle
  assert.equal(toolStatusIcon(trace({ status: 'error', isError: false })), 'circle')
})

test('buildToolViewProps：状态三值映射，可选字段缺省时键完全不出现且不透传 siblingCalls/structuredOutput', { timeout: 60_000 }, () => {
  const minimal = buildToolViewProps(trace(), 7)
  assert.deepEqual(minimal, {
    callId: '',
    toolName: 'bash',
    status: 'done',
    isError: false,
    conversationId: 7,
  })
  assert.ok(!('input' in minimal))
  assert.ok(!('result' in minimal))
  assert.ok(!('durationMs' in minimal))
  assert.ok(!('presentationMeta' in minimal))
  assert.ok(!('structuredOutput' in minimal))
  assert.ok(!('siblingCalls' in minimal))
})

test('buildToolViewProps：running/error 映射 running/error，可选字段全量携带（含 presentationMeta）', { timeout: 60_000 }, () => {
  assert.equal(buildToolViewProps(trace({ status: 'running' }), 1).status, 'running')
  assert.equal(buildToolViewProps(trace({ status: 'error', isError: true }), 1).status, 'error')
  assert.equal(buildToolViewProps(trace({ status: 'unknown' }), 1).status, 'done')

  const full = buildToolViewProps(
    trace({
      callId: 'call_1',
      input: { cmd: 'ls' },
      resultText: '预览',
      resultTruncation: { truncated: true, totalChars: 9000, totalLines: 300 },
      presentationMeta: { files: 2 },
      startedAt: 123,
      durationMs: 456,
      artifactRef: 'art_x',
    }),
    9,
  )
  assert.equal(full.callId, 'call_1')
  assert.deepEqual(full.input, { cmd: 'ls' })
  assert.equal(full.result, '预览')
  assert.deepEqual(full.resultTruncation, { truncated: true, totalChars: 9000, totalLines: 300 })
  assert.deepEqual(full.presentationMeta, { files: 2 })
  assert.equal(full.startedAt, 123)
  assert.equal(full.durationMs, 456)
  assert.equal(full.artifactRef, 'art_x')
  assert.equal(full.conversationId, 9)
  assert.ok(!('structuredOutput' in full))
  assert.ok(!('siblingCalls' in full))
})

const entry = (id: string, kind: string, extra?: Partial<ConversationEntry>): ConversationEntry => ({
  id,
  kind,
  ...extra,
})

test('buildActiveEntryIndex：rewind 覆盖区间与 marker 自身都被排除，其余按 id 索引', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helmx.input', { data: { text: 'a', origin: 'human' } }),
    entry('2', 'pi.assistant'),
    entry('3', 'pi.assistant'),
    entry('9', 'helmx.rewind', { data: { fromEntryId: 2, throughEntryId: 3 } }),
  ]
  const index = buildActiveEntryIndex(entries)
  assert.deepEqual([...index.keys()], ['1'])
})

test('buildActiveEntryIndex：无 rewind marker 时原样全量索引（含未知 kind）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [entry('1', 'pi.assistant'), entry('2', 'pi.tool-result')]
  assert.deepEqual([...buildActiveEntryIndex(entries).keys()], ['1', '2'])
})

const assistantEntry = (id: string, text?: string): ConversationEntry =>
  entry(id, 'pi.assistant', {
    ...(text !== undefined
      ? { model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
      : {}),
  })

test('resolveAssistantAnchorEntry：优先最后一个携带正文文本的 pi.assistant', { timeout: 60_000 }, () => {
  const a1 = assistantEntry('1', '第一段回答')
  const a2 = assistantEntry('2') // 纯 toolCall 载体
  const a3 = assistantEntry('3', '收尾回答')
  const index = new Map([['1', a1], ['2', a2], ['3', a3]])
  assert.equal(resolveAssistantAnchorEntry(['1', '2', '3'], index), a3)
})

test('resolveAssistantAnchorEntry：全无正文时退回最后一个 pi.assistant（含纯 toolCall 载体）', { timeout: 60_000 }, () => {
  const a1 = assistantEntry('1')
  const a2 = assistantEntry('2')
  const index = new Map([['1', a1], ['2', a2], ['3', entry('3', 'pi.tool-result')]])
  assert.equal(resolveAssistantAnchorEntry(['1', '2', '3'], index), a2)
})

test('resolveAssistantAnchorEntry：空正文文本块不构成正文载体；仅工具条目时 undefined', { timeout: 60_000 }, () => {
  const emptyText = entry('1', 'pi.assistant', {
    model: [{ role: 'assistant', content: [{ type: 'text', text: '' }] }],
  })
  assert.equal(resolveAssistantAnchorEntry(['1'], new Map([['1', emptyText]])), emptyText)

  const toolResult = entry('3', 'pi.tool-result')
  assert.equal(resolveAssistantAnchorEntry(['3'], new Map([['3', toolResult]])), undefined)
  assert.equal(resolveAssistantAnchorEntry(['404'], new Map()), undefined)
})

test('buildSettledTimelinePrefix + buildLiveTimelineTail：流式增量期间历史项与 ToolTrace 保持严格 === 引用稳定，且尾部工具缝合与排队转正与 buildTimelineItems 严格一致', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    entry('1', 'helmx.input', { data: { id: 'in-1', text: '第一轮问题', origin: 'human', createdAt: 10 } }),
    entry('2', 'pi.assistant', {
      model: [{
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_hist', name: 'edit', arguments: { path: 'a.ts' } },
        ],
      }],
    }),
    entry('3', 'pi.tool-result', {
      model: [{
        role: 'toolResult',
        toolCallId: 'call_hist',
        toolName: 'edit',
        isError: false,
        content: [{ type: 'text', text: 'edited a.ts' }],
      }],
    }),
    entry('4', 'pi.assistant', {
      model: [{ role: 'assistant', content: [{ type: 'text', text: '第一轮完成' }] }],
    }),
    entry('5', 'helmx.input', { data: { id: 'in-2', text: '第二轮正在流式', origin: 'human', createdAt: 20 } }),
    entry('6', 'pi.assistant', {
      model: [{
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_mid', name: 'bash', arguments: { command: 'ls' } },
        ],
      }],
    }),
    entry('7', 'pi.tool-result', {
      model: [{
        role: 'toolResult',
        toolCallId: 'call_mid',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'src\npackage.json' }],
      }],
    }),
  ]

  const prefix = buildSettledTimelinePrefix(entries)
  assert.equal(prefix.items.length, 3, '前置定稿项应包含第一轮 human + assistant 与第二轮 human')
  assert.equal(prefix.tailTurnEntries.length, 2, '仅开放尾轮条目进入 tailTurnEntries')

  const firstTurnTool = (turn: AssistantTurn): ToolTrace | undefined => {
    for (const seg of turn.segments) {
      if (seg.kind === 'tool') return seg.tool
      if (seg.kind === 'step-group') {
        for (const step of seg.steps) {
          if (step.kind === 'tool') return step.tool
        }
      }
    }
    return undefined
  }

  const settledTurn = prefix.items[1] as AssistantTurn
  const settledToolRef = firstTurnTool(settledTurn)
  assert.ok(settledToolRef !== undefined, '历史回合应包含已归档 ToolTrace')

  const live1: ConversationLive = {
    conversationId: 1,
    thinking: '思考步骤 A',
    text: '部分回答 1',
    tools: [{ callId: 'call_live', toolName: 'read', status: 'running', input: { path: 'README.md' } }],
    updatedAt: 100,
    queuedInputs: [
      { id: 'in-2', submissionId: '50', text: '第二轮正在流式', mode: 'steer', origin: 'human', createdAt: 20 },
      { id: 'q-next', submissionId: '51', text: '后续排队追问', mode: 'followUp', origin: 'human', createdAt: 30 },
    ],
  }
  const live2: ConversationLive = {
    ...live1,
    text: '部分回答 1 + 增量 token 2',
    updatedAt: 101,
  }

  const combined1 = [...prefix.items, ...buildLiveTimelineTail(prefix, { live: live1, working: true })]
  const combined2 = [...prefix.items, ...buildLiveTimelineTail(prefix, { live: live2, working: true })]

  assert.ok(combined1[0] === combined2[0], '第一轮 human 项跨流式增量保持 === 引用稳定')
  assert.ok(combined1[1] === combined2[1], '第一轮定稿 assistant 项跨流式增量保持 === 引用稳定')
  assert.ok(combined1[2] === combined2[2], '第二轮已落库 human 项跨流式增量保持 === 引用稳定')
  const turn2After = combined2[1] as AssistantTurn
  const turn2ToolRef = firstTurnTool(turn2After)
  assert.ok(turn2ToolRef === settledToolRef, '历史 ToolTrace 实例跨流式增量保持 === 引用稳定')

  assert.deepEqual(combined1, buildTimelineItems(entries, { live: live1, working: true }))
  assert.deepEqual(combined2, buildTimelineItems(entries, { live: live2, working: true }))
})
