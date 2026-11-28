/**
 * 排队消息胶囊（steer / followUp）、发送响应等待态与正式消息转正 SSR 契约测试（pure 池）。
 *
 * （helmx:send 求值测试已迁 packages/plugins/test/json-render-send-target.test.ts）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationStatus, ConversationSummary } from '@helmx/protocol'
import { sendingPendingVisible } from '../src/conversation/composer-model.js'
import { buildTimelineItems, type HumanInputItem } from '../src/conversation/timeline-model.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

function renderTimeline(
  status: ConversationStatus,
  options: {
    sending?: boolean
    entries?: ConversationEntry[]
    live?: ConversationLive
  } = {},
): string {
  const entries = options.entries ?? []
  const conversation: ConversationSummary = {
    id: 1,
    title: '测试会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: 'off',
    status,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: status === 'blocked' ? 1 : 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const store = makeTestStore({
    conversations: [conversation],
    conversationDetails: { 1: { ...conversation, entries } },
  })
  return renderToString(
    React.createElement(
      HostStoreProviders,
      { value: store },
      React.createElement(ConversationTimeline, {
        conversation,
        detailEntries: entries,
        ...(options.sending !== undefined ? { sendingPending: sendingPendingVisible(options.sending, status) } : {}),
        ...(options.live !== undefined ? { live: options.live } : {}),
        onRequestEdit: () => {},
      }),
    ),
  )
}

function waitingCount(html: string): number {
  return (html.match(/aria-label="Generating"/g) ?? []).length
}

// ---------------------------------------------------------------------------
// 1. 排队转正与去重（原 queued-transition.test.ts）
// ---------------------------------------------------------------------------

const transitionQueued: NonNullable<ConversationLive['queuedInputs']>[number] = {
  id: 'queued-1',
  submissionId: '10',
  text: '补充说明',
  mode: 'followUp',
  origin: 'human',
  createdAt: 1,
}
const transitionEntry: ConversationEntry = { id: '11', kind: 'helmx.input', data: { ...transitionQueued } }

test('实时回复后跟排队胶囊时只显示一次响应等待，不给队列制造第二个模型回合', { timeout: 60_000 }, () => {
  const html = renderTimeline('working', {
    live: { conversationId: 1, text: '当前回复', tools: [], queuedInputs: [transitionQueued], updatedAt: 1 },
  })
  assert.equal(waitingCount(html), 1)
  assert.doesNotMatch(html, /正在等待响应…/)
  assert.match(html, /Withdraw queue and edit/)
})

test('只有排队项尚无正文时仍显示一次执行等待', { timeout: 60_000 }, () => {
  const html = renderTimeline('working', {
    live: { conversationId: 1, text: '', tools: [], queuedInputs: [transitionQueued], updatedAt: 1 },
  })
  assert.equal(waitingCount(html), 1)
  assert.doesNotMatch(html, /正在等待响应…/)
})

test('输入被插件时间线接管后，同身份队列快照不重复显示', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([transitionEntry], {
    live: { conversationId: 1, text: '', tools: [], queuedInputs: [transitionQueued], updatedAt: 1 },
    timelineRenderers: [{ pluginId: 'test:render', spec: { id: 'input-card', kinds: ['helmx.input'], client: { module: 'index.tsx', export: 'InputCard' } } }],
  })
  assert.equal(items.filter((item) => item.kind === 'plugin-card').length, 1)
  assert.equal(items.filter((item) => item.kind === 'human').length, 0)
})

test('失败回合保留队列快照时不复活历史助手执行态', { timeout: 60_000 }, () => {
  const history: ConversationEntry[] = [{
    id: '9', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '此前回答' }] }],
  }]
  const items = buildTimelineItems(history, {
    working: false,
    live: { conversationId: 1, text: '', tools: [], queuedInputs: [transitionQueued], updatedAt: 1 },
  })
  const turn = items.find((item) => item.kind === 'assistant')
  assert.equal(turn?.live, false)
  assert.equal(items.filter((item) => item.kind === 'human').length, 1)
})

test('队列转为正式输入时稳定 key 相同，且保留两条文字相同但身份不同的输入', { timeout: 60_000 }, () => {
  const live: ConversationLive = { conversationId: 1, text: '', tools: [], queuedInputs: [transitionQueued], updatedAt: 1 }
  const before = buildTimelineItems([], { live })
  const during = buildTimelineItems([transitionEntry], { live })
  const after = buildTimelineItems([transitionEntry])
  assert.equal(before[0]?.key, during[0]?.key)
  assert.equal(during[0]?.key, after[0]?.key)
  assert.equal(during.length, 1)
  const sameText = buildTimelineItems([transitionEntry], {
    live: { ...live, queuedInputs: [{ ...transitionQueued, id: 'another-input', submissionId: '12' }] },
  })
  assert.equal(sameText.filter((item) => item.kind === 'human').length, 2)
})

// ---------------------------------------------------------------------------
// 2. 发送响应等待反馈（原 sending-feedback.test.ts）
// ---------------------------------------------------------------------------

test('shows one wait indicator while the first input request is in flight and hides the empty-conversation intro', { timeout: 60_000 }, () => {
  const html = renderTimeline('idle', { sending: true })
  assert.equal(waitingCount(html), 1)
  assert.match(html, /role="status"/)
  assert.match(html, /msg-live-waiting/)
  assert.match(html, /msg-live-dots/)
  assert.doesNotMatch(html, /spin-slow/)
  assert.match(html, /msg-live-label[^>]*>Generating</)
  assert.doesNotMatch(html, /正在等待响应…/)
  assert.doesNotMatch(html, /向助理描述目标/)
  assert.doesNotMatch(html, /timeline-center-slot/)
  assert.doesNotMatch(html, /msg-human-pill/)
})

test('keeps only the running feedback once the server takes over; no response wait during approvals', { timeout: 60_000 }, () => {
  assert.equal(waitingCount(renderTimeline('working', { sending: true })), 1)
  assert.equal(waitingCount(renderTimeline('working', { sending: false })), 1)
  assert.equal(waitingCount(renderTimeline('blocked', { sending: true })), 0)
})

test('no wait hint lingers after a failed send or a finished turn', { timeout: 60_000 }, () => {
  for (const status of ['idle', 'done', 'error'] as const) {
    assert.equal(waitingCount(renderTimeline(status, { sending: false })), 0, status)
  }
})

test('wait hint persists between a tool end and the next response, gone once the turn ends', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call-1',
      toolName: 'bash', content: [{ type: 'text', text: '/tmp' }], isError: false }] },
  ]
  assert.equal(waitingCount(renderTimeline('working', { sending: false, entries })), 1)
  assert.equal(waitingCount(renderTimeline('done', { sending: false, entries })), 0)
})

test('streamed body shows the full received text; running feedback is not duplicated', { timeout: 60_000 }, () => {
  const html = renderTimeline('working', {
    sending: true,
    live: { conversationId: 1, text: '已收到的完整流式正文', tools: [], updatedAt: 1 },
  })
  assert.match(html, /已收到的完整流式正文/)
  assert.equal(waitingCount(html), 1)
  assert.match(html, /msg-live-indicator/)
  assert.match(html, /msg-live-dots/)
  assert.doesNotMatch(html, /spin-slow/)
  assert.doesNotMatch(html, /msg-live-waiting/)
})

// ---------------------------------------------------------------------------
// 3. 排队胶囊样式与外部来源（原 queued-pill.test.ts）
// ---------------------------------------------------------------------------

test('buildTimelineItems: live.queuedInputs 渲染为尾部胶囊（queuedMode 透传）', { timeout: 60_000 }, () => {
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 99,
    queuedInputs: [
      { id: 'fu-1', submissionId: '31', text: '排队的消息', mode: 'followUp', origin: 'human', createdAt: 2 },
      { id: 'st-1', submissionId: '32', text: '插话的消息', mode: 'steer', origin: 'trigger', createdAt: 3 },
    ],
  }
  const items = buildTimelineItems([], { live })
  const queued = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(queued.length, 2)
  assert.equal(queued[0]!.queuedMode, 'followUp')
  assert.equal(queued[0]!.key, 'human:id:fu-1')
  assert.equal(queued[0]!.entryId, 'queued:31')
  assert.equal(queued[0]!.inputId, 'fu-1')
  assert.equal(queued[0]!.fallback, false)
  assert.equal(queued[1]!.queuedMode, 'steer')
  assert.equal(queued[1]!.origin, 'trigger')
})

test('buildTimelineItems: 排队项落入正式 entries 后按 input.id 去重（原地转正不重复）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    {
      id: '41',
      kind: 'helmx.input',
      data: { id: 'q-1', text: '已转正的排队消息', origin: 'human', createdAt: 2 },
    },
  ]
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 99,
    queuedInputs: [
      { id: 'q-1', submissionId: '40', text: '已转正的排队消息', mode: 'steer', origin: 'human', createdAt: 2 },
    ],
  }
  const items = buildTimelineItems(entries, { live })
  const humans = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(humans.length, 1, '同 input.id 不重复渲染')
  assert.equal(humans[0]!.key, 'human:id:q-1', '正式 entry 与 queued 共用同一 key（原地转正零闪烁）')
  assert.equal(humans[0]!.queuedMode, undefined, '已落入正式 entries 后不再标记 queuedMode')
  assert.equal(humans[0]!.entryId, '41')
})

test('buildTimelineItems: 无 data.id 的历史 helmx.input 仍用 entry.id 作 key', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '7', kind: 'helmx.input', data: { text: '旧输入', origin: 'human' } },
  ]
  const items = buildTimelineItems(entries, {})
  const humans = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(humans.length, 1)
  assert.equal(humans[0]!.key, 'human:7')
  assert.equal(humans[0]!.inputId, undefined)
})

test('ConversationTimeline: steer 与 followUp 胶囊文案、状态标记与统一待处理样式类', { timeout: 60_000 }, () => {
  const live: ConversationLive = {
    conversationId: 1,
    text: '流式中',
    tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }],
    updatedAt: 5,
    queuedInputs: [
      { id: 'st-1', submissionId: '10', text: '先看这个报错', mode: 'steer', origin: 'human', createdAt: 1 },
      { id: 'fu-1', submissionId: '11', text: '顺便再跑一次测试', mode: 'followUp', origin: 'human', createdAt: 2 },
    ],
  }
  const html = renderTimeline('working', { live })
  assert.match(html, /Steer · injected at the next step boundary/)
  assert.match(html, /Queued · sent after the current turn ends/)
  assert.match(html, /msg-human-pill-queued/)
  assert.match(html, /先看这个报错/)
  assert.match(html, /顺便再跑一次测试/)
  assert.doesNotMatch(html, /Fork a new conversation from this message/)
})

test('ConversationTimeline: 正式消息无 queued 样式，分叉按钮保留', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '9', kind: 'helmx.input', data: { id: 'k-1', text: '正式消息', origin: 'human', createdAt: 1 } },
  ]
  const html = renderTimeline('idle', { entries })
  assert.doesNotMatch(html, /msg-human-pill-queued/)
  assert.doesNotMatch(html, /msg-human-row-external/)
  assert.match(html, /正式消息/)
  assert.match(html, /Fork a new conversation from this message/)
})

test('ConversationTimeline: 外部来源（agent / trigger）行附加 msg-human-row-external 且保留胶囊与脚部类', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '10', kind: 'helmx.input', data: { id: 't-1', text: '定时任务触发', origin: 'trigger', createdAt: 1 } },
    { id: '11', kind: 'helmx.input', data: { id: 'a-1', text: '智能体汇报内容', origin: 'agent', createdAt: 2 } },
  ]
  const html = renderTimeline('idle', { entries })
  assert.equal((html.match(/msg-human-row-external/g) ?? []).length, 2)
  assert.match(html, /From trigger/)
  assert.match(html, /From agent report/)
  assert.match(html, /msg-human-pill/)
  assert.match(html, /msg-human-footer/)
  assert.match(html, /msg-origin-tag/)
})
