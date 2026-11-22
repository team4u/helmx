import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { isAssistantTurnBusy } = await import('../src/conversation/timeline-model.js')
type AssistantTurn = import('../src/conversation/timeline-model.js').AssistantTurn
const { makeTestStore: makeMockStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

// ---------------------------------------------------------------------------
// 1. 状态判定纯函数：isAssistantTurnBusy
// ---------------------------------------------------------------------------

test('isAssistantTurnBusy：turn.live 为 true 时判定为响应中', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [{ kind: 'text', key: 'txt:1', text: '正在输出…' }],
    live: true,
  }
  const conv = { id: 1, status: 'idle' }
  assert.equal(isAssistantTurnBusy(turn, conv), true)
})

test('isAssistantTurnBusy：最新回合且父会话为 working 或 blocked 时判定为响应中', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [{ kind: 'text', key: 'txt:1', text: '已有一段输出' }],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: true }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'blocked' }, { isLatestTurn: true }), true)
  // 非最新回合（历史回合）不受父会话当前 working 影响
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: false }), false)
})

test('isAssistantTurnBusy：回合内有 running 工具或激活的分组步骤时判定为响应中', { timeout: 60_000 }, () => {
  const turnWithRunningTool: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:1',
        tool: { key: 't:1', toolName: 'bash', status: 'running', isError: false },
      },
    ],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turnWithRunningTool, { id: 1, status: 'idle' }), true)

  const turnWithActiveStepGroup: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:2',
    entryIds: ['2'],
    segments: [
      {
        kind: 'step-group',
        key: 'g:1',
        stepCount: 1,
        active: true,
        steps: [{ kind: 'thinking', thinking: { key: 'th:1', text: '思考中' } }],
      },
    ],
    live: false,
  }
  assert.equal(isAssistantTurnBusy(turnWithActiveStepGroup, { id: 1, status: 'idle' }), true)
})

test('isAssistantTurnBusy：后台工具已返回但插件报告活动时仍 busy，终态释放后完成', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:wf',
        tool: {
          key: 't:wf',
          toolName: 'background_job',
          callId: 'call_bg_1',
          status: 'done',
          isError: false,
        },
      },
    ],
    live: false,
  }

  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set(['call_bg_1']) }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set() }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }, { activeToolCallIds: new Set(['another-turn']) }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'working' }, { isLatestTurn: true }), true)
})

test('isAssistantTurnBusy：任意插件工具均按本次工具状态判定，不按工具名称特判', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = {
    kind: 'assistant',
    key: 'turn:1',
    entryIds: ['1'],
    segments: [
      {
        kind: 'tool',
        key: 't:sub',
        tool: {
          key: 't:sub',
          toolName: 'subagent',
          callId: 'call_sub_1',
          status: 'done',
          isError: false,
        },
      },
    ],
    live: false,
  }

  assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }), false)
  for (const status of ['running', 'unknown'] as const) {
    const segment = turn.segments[0]!
    assert.ok(segment.kind === 'tool')
    segment.tool.status = status
    assert.equal(isAssistantTurnBusy(turn, { id: 1, status: 'idle' }), true)
  }
})

// ---------------------------------------------------------------------------
// 3. ConversationTimeline SSR 渲染：响应中无悬停操作栏，完成后才出现
// ---------------------------------------------------------------------------

test('step-group 中 done 工具的后台活动也参与汇总；没有 callId 的工具不能误关联', { timeout: 60_000 }, () => {
  const turn: AssistantTurn = { kind: 'assistant', key: 'g', entryIds: ['1'], live: false, segments: [{
    kind: 'step-group', key: 'group', stepCount: 2, active: false, steps: [
      { kind: 'tool', tool: { key: 't', callId: 'call', toolName: 'custom_tool', status: 'done', isError: false } },
      { kind: 'tool', tool: { key: 'no-id', toolName: 'custom_tool', status: 'done', isError: false } },
    ],
  }] }
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set(['call']) }), true)
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set(['no-id']) }), false)
  assert.equal(isAssistantTurnBusy(turn, { id: 1 }, { activeToolCallIds: new Set() }), false)
})

test('ConversationTimeline：agent 回合响应中不显示复制与分叉按钮，完成后才出现', { timeout: 60_000 }, () => {
  const convWorking: ConversationSummary = {
    id: 1,
    title: '工作流演示',
    profileId: 'default',
    tags: [],
    cwd: '/workspace',
    model: '',
    thinkingLevel: '',
    status: 'working',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 100,
    updatedAt: 200,
  }

  const entriesDuringResponse: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '简单演示下工作流编排', origin: 'human' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '正在进行工作流编排…' }],
        },
      ],
    },
  ]

  // 1. 响应中（working + live）：无 msg-hover-bar，不提前渲染「从此处分叉新会话」
  const htmlDuring = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convWorking] }) },
      e(ConversationTimeline, {
        conversation: convWorking,
        detailEntries: entriesDuringResponse,
        live: {
          conversationId: 1,
          text: '正在进行工作流编排…',
          tools: [],
          updatedAt: 210,
        },
        onRequestEdit: () => {},
      }),
    ),
  )

  // 人类输入有自己的操作按钮，但 AI 回复块中绝对不得出现分叉与复制按钮
  assert.doesNotMatch(htmlDuring, /Fork a new conversation from here/)

  // 2. 响应彻底完成（idle，live 消除）：展示「从此处分叉新会话」与复制按钮
  const convIdle: ConversationSummary = { ...convWorking, status: 'idle' }
  const htmlSettled = renderToString(
    e(
      HostStoreProviders,
      { value: makeMockStore({ conversations: [convIdle] }) },
      e(ConversationTimeline, {
        conversation: convIdle,
        detailEntries: entriesDuringResponse,
        onRequestEdit: () => {},
      }),
    ),
  )

  assert.match(htmlSettled, /Fork a new conversation from here/)
})

test('ConversationTimeline：含工具调用的多段回合，复制按钮只复制最后一段助手回复文本', { timeout: 60_000 }, async () => {
  const convIdle: ConversationSummary = {
    id: 1,
    title: '多段回复复制',
    profileId: 'default',
    tags: [],
    cwd: '/workspace',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 100,
    updatedAt: 200,
  }

  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '帮我查一下配置', origin: 'human' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先读取配置文件看一下。' },
            { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'config.json' } },
          ],
        },
      ],
    },
    {
      id: '3',
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'read',
          content: [{ type: 'text', text: '{"port":3202}' }],
        },
      ],
    },
    {
      id: '4',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '端口配置为 3202，运行正常。' }],
        },
      ],
    },
  ]

  let copiedText = ''
  const navWithClipboard = globalThis.navigator as Navigator & {
    clipboard?: { writeText?: (text: string) => Promise<void> }
  }
  const origClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copiedText = text
      },
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [convIdle] }) },
          e(ConversationTimeline, {
            conversation: convIdle,
            detailEntries: entries,
            onRequestEdit: () => {},
          }),
        ),
      )
    })

    const copyBtn = host.querySelector<HTMLButtonElement>('.msg-ai-block .msg-ai-footer .msg-hover-bar button[aria-label="Copy"]')
    assert.ok(copyBtn !== null, '助手回合底部存在复制按钮')
    await act(async () => {
      copyBtn.click()
      await Promise.resolve()
    })
    assert.equal(copiedText, '端口配置为 3202，运行正常。')
    assert.equal(navWithClipboard !== undefined, true)
  } finally {
    act(() => root.unmount())
    host.remove()
    if (origClipboardDesc !== undefined) {
      Object.defineProperty(globalThis.navigator, 'clipboard', origClipboardDesc)
    } else {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard')
    }
  }
})

test('ConversationTimeline：运行中/阻塞回合与首 token 前等待行显示校准秒表，工具行使用共享整秒秒表，缺起点不编造', { timeout: 60_000 }, async () => {
  const { observeServerEpoch, resetServerClock } = await import('../src/lib/server-clock.js')
  const now = Date.now()
  // 模拟服务端比本机慢 5s，校准后 serverNow() ≈ now - 5000
  resetServerClock()
  observeServerEpoch(now - 5_000)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    // 1. 首 token 前等待行（working + 无 live 回合）：带 runStartedAt 显示「生成中 · 12s」
    const waitingConv: ConversationSummary = {
      id: 1,
      title: '首 token 等待',
      profileId: 'default',
      tags: [],
      cwd: '/workspace',
      model: '',
      thinkingLevel: '',
      status: 'working',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      runStartedAt: now - 5_000 - 12_400,
      createdAt: 100,
      updatedAt: 200,
    }
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [waitingConv], locale: 'zh-CN' }) },
          e(ConversationTimeline, {
            conversation: waitingConv,
            detailEntries: [{ id: '1', kind: 'helmx.input', data: { text: '开始', origin: 'human' } }],
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    const waitingEl = host.querySelector<HTMLElement>('.msg-live-waiting')
    assert.ok(waitingEl !== null)
    assert.match(waitingEl.textContent ?? '', /生成中 · 12s/)

    // 2. 运行中回合（turn.live）+ 运行中工具（RunningElapsed 共享整秒秒表，无 .0s 抖动）
    const toolStartedAt = now - 5_000 - 7_800
    const liveEntries: ConversationEntry[] = [
      { id: '1', kind: 'helmx.input', data: { text: '执行命令', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            timestamp: toolStartedAt - 2_000,
            durationMs: 2_000,
            content: [{ type: 'toolCall', id: 'call_run', name: 'bash', arguments: { command: 'sleep 10' } }],
          },
        ],
      },
    ]
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [waitingConv], locale: 'zh-CN' }) },
          e(ConversationTimeline, {
            conversation: waitingConv,
            detailEntries: liveEntries,
            live: {
              conversationId: 1,
              text: '正在处理',
              tools: [{ callId: 'call_run', toolName: 'bash', status: 'running' }],
              updatedAt: now - 5_000,
            },
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    const liveIndicator = host.querySelector<HTMLElement>('.msg-live-indicator')
    assert.ok(liveIndicator !== null)
    assert.match(liveIndicator.textContent ?? '', /生成中 · 12s/)
    const toolRight = host.querySelector<HTMLElement>('.trace-row-right')
    assert.ok(toolRight !== null)
    assert.match(toolRight.textContent ?? '', /\b7s\b/, 'RunningElapsed uses whole-second formatStopwatchMs without .0s')
    assert.doesNotMatch(toolRight.textContent ?? '', /7\.\ds/)

    // 3. blocked 审批等待回合：warn 语义 + 「等待审批 · 15s」
    const blockedConv: ConversationSummary = {
      ...waitingConv,
      status: 'blocked',
      pendingAskCount: 1,
      pendingAskSince: now - 5_000 - 15_400,
    }
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [blockedConv], locale: 'zh-CN' }) },
          e(ConversationTimeline, {
            conversation: blockedConv,
            detailEntries: liveEntries,
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    const blockedIndicator = host.querySelector<HTMLElement>('.msg-live-indicator-warn')
    assert.ok(blockedIndicator !== null, 'blocked turn renders warn live indicator')
    assert.match(blockedIndicator.textContent ?? '', /等待审批 · 15s/)

    // 4. 缺起点时不编造秒表
    const unanchoredConv: ConversationSummary = {
      ...waitingConv,
      runStartedAt: undefined,
    }
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeMockStore({ conversations: [unanchoredConv], locale: 'zh-CN' }) },
          e(ConversationTimeline, {
            conversation: unanchoredConv,
            detailEntries: liveEntries,
            live: { conversationId: 1, text: '无起点', tools: [], updatedAt: now - 5_000 },
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    assert.ok(host.querySelector('.msg-live-elapsed') === null, 'missing runStartedAt must not fabricate 0s')
  } finally {
    resetServerClock()
    act(() => root.unmount())
    host.remove()
  }
})
