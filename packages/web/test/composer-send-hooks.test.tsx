/**
 * useComposerSend 拆分为 composer-send/ 子 hook 后的契约测试（直接挂载 hook 宿主，不经 Composer 组件）：
 * - 草稿：prefill 整体替换文本 / 编辑锚点 / 附件，同 tick 只消费一次；readLiveDraft 读活草稿；cancelEdit 清空；
 * - 发送管道：成功时乐观清空并提交；失败时按冻结版本回滚文本与编辑目标并推送错误通知；
 * - 斜杠命令：精确命中插件命令走命令路径（不提交）；/new 调 onNewThread；/clear 调 reset；
 * - 环境阻断：handleEnvBlocker 跨渲染身份稳定；阻断期间 send 拒绝并通知（strict 抛错）；envConfigurable=false 复位；
 * - sendExplicit：不消费草稿；working 时携带 whenBusy；失败如实 reject；
 * - withdrawQueuedInput：撤回成功且草稿干净时整体替换为排队输入；草稿非空时仅通知。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { ConversationSummary } from '@helmx/protocol'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import { HelmxExternalStoreContext, makeTestStore } from './helpers/store.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')

import { conversationsApi, pluginsApi } from '../src/lib/api.js'
import type { QualifiedCommand } from '../src/lib/commands-model.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import type { ToastNotice } from '../src/lib/types.js'
import type { NextTurnModelOverride } from '../src/conversation/composer-model.js'
import {
  useComposerSend,
  type ComposerPrefill,
  type ComposerSendApi,
} from '../src/conversation/composer-send.js'

const conv = (id: number): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId: 'coder', tags: [], cwd: '/w', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})

const pingCommand: QualifiedCommand = {
  pluginId: 'builtin:demo',
  spec: { id: 'ping', title: 'Ping', slash: 'ping', actionId: 'ping' },
}

interface HostProps {
  conversation: ConversationSummary
  prefill: ComposerPrefill | null
  working?: boolean
  envConfigurable?: boolean
  slashPluginCommands?: ReadonlyArray<QualifiedCommand>
  nextTurnOverride?: NextTurnModelOverride | null
  onConsumeNextTurnOverride?: (consumed: NextTurnModelOverride) => void
  onSendingChange?: (sending: boolean) => void
  onNewThread?: () => void
}

interface Harness {
  store: HelmxExternalStore
  api: () => ComposerSendApi
  textarea: HTMLTextAreaElement
  rerender: (patch: Partial<HostProps>) => void
  notices: () => ToastNotice[]
  /** Simulate the textarea not being mounted: insertTextState falls back to appending. */
  detachTextarea: () => void
  unmount: () => void
}

function mount(props: HostProps): Harness {
  const store = makeTestStore({ conversations: [props.conversation] })
  let current: HostProps = props
  let latest: ComposerSendApi | null = null
  const host = document.createElement('div')
  document.body.appendChild(host)
  const textarea = document.createElement('textarea')
  host.appendChild(textarea)
  const textareaRef = { current: textarea as HTMLTextAreaElement | null }
  const Probe = (): React.ReactNode => {
    latest = useComposerSend({
      conversation: current.conversation,
      prefill: current.prefill,
      textareaRef,
      slashPluginCommands: current.slashPluginCommands ?? [],
      envConfigurable: current.envConfigurable ?? false,
      working: current.working ?? false,
      ...(current.nextTurnOverride !== undefined ? { nextTurnOverride: current.nextTurnOverride } : {}),
      ...(current.onConsumeNextTurnOverride !== undefined
        ? { onConsumeNextTurnOverride: current.onConsumeNextTurnOverride }
        : {}),
      ...(current.onSendingChange !== undefined ? { onSendingChange: current.onSendingChange } : {}),
      ...(current.onNewThread !== undefined ? { onNewThread: current.onNewThread } : {}),
    })
    return null
  }
  const root = createRoot(host)
  const render = (): void => {
    act(() => {
      root.render(React.createElement(HelmxExternalStoreContext.Provider, { value: store }, React.createElement(Probe)))
    })
  }
  render()
  return {
    store,
    api: () => latest!,
    textarea,
    rerender: (patch) => {
      current = { ...current, ...patch }
      render()
    },
    notices: () => store.getNotices(),
    detachTextarea: () => {
      textareaRef.current = null
    },
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

interface SubmitCall { id: number; payload: Record<string, unknown> }

function stubApi(opts?: { submitGate?: Promise<void>; submitError?: Error }): {
  submits: SubmitCall[]
  resets: number[]
  compacts: string[]
  actions: Array<{ pluginId: string; actionId: string }>
  restore: () => void
} {
  const original = {
    submit: conversationsApi.submitInput,
    reset: conversationsApi.reset,
    compact: conversationsApi.compact,
    invoke: pluginsApi.invokeAction,
  }
  const submits: SubmitCall[] = []
  const resets: number[] = []
  const compacts: string[] = []
  const actions: Array<{ pluginId: string; actionId: string }> = []
  conversationsApi.submitInput = (async (id: number, payload: Record<string, unknown>) => {
    submits.push({ id, payload })
    if (opts?.submitGate !== undefined) await opts.submitGate
    if (opts?.submitError !== undefined) throw opts.submitError
    return { submissionId: 's1' }
  }) as unknown as typeof conversationsApi.submitInput
  conversationsApi.reset = (async (id: number) => {
    resets.push(id)
    return conv(id)
  }) as typeof conversationsApi.reset
  conversationsApi.compact = (async (id: number, instructions?: string) => {
    compacts.push(instructions ?? '')
    return { conversationId: id, summaryEntryId: 'e1', removedEntryIds: [] }
  }) as unknown as typeof conversationsApi.compact
  pluginsApi.invokeAction = (async (pluginId: string, actionId: string) => {
    actions.push({ pluginId, actionId })
    return { ok: true }
  }) as typeof pluginsApi.invokeAction
  return {
    submits,
    resets,
    compacts,
    actions,
    restore: () => {
      conversationsApi.submitInput = original.submit
      conversationsApi.reset = original.reset
      conversationsApi.compact = original.compact
      pluginsApi.invokeAction = original.invoke
    },
  }
}

const flush = async (): Promise<void> => {
  await act(async () => {})
}

afterEach(() => {
  resetHappyDom()
})

test('prefill 整体替换文本 / 锚点 / 附件且同 tick 只消费一次；cancelEdit 清空并同步活草稿', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const attachments = [{ id: 'art-1', name: 'a.txt', mimeType: 'text/plain', size: 3 }]
  const h = mount({ conversation: conv(1), prefill: { text: '旧消息', entryId: 7, attachments, tick: 1 } })
  try {
    assert.equal(h.api().text, '旧消息')
    assert.equal(h.api().editingEntryId, 7, '历史编辑锚点来自 prefill.entryId')
    assert.equal(h.api().attachments.length, 1, 'prefill 附件整体替换草稿附件')
    assert.equal(h.api().readLiveDraft(), '旧消息')
    // 同一 prefill 引用重渲染：不再二次注入
    act(() => h.api().cancelEdit())
    h.rerender({})
    assert.equal(h.api().text, '', 'cancelEdit 后同 tick 的 prefill 不会复活')
    assert.equal(h.api().editingEntryId, null)
    assert.equal(h.api().readLiveDraft(), '')
    // 同文本新 tick：再次应用
    h.rerender({ prefill: { text: '旧消息', tick: 2 } })
    assert.equal(h.api().text, '旧消息')
    assert.equal(h.api().editingEntryId, null, '无 entryId 的 prefill 不进入编辑模式')
    // 插入片段：textarea 未挂载时追加到末尾并推进活草稿
    h.detachTextarea()
    act(() => h.api().insertTextState('X'))
    assert.equal(h.api().text, '旧消息X')
    assert.equal(h.api().readLiveDraft(), '旧消息X')
  } finally {
    api.restore()
    h.unmount()
  }
})

test('send 成功：乐观清空草稿、提交 origin=human、在途反馈 true→false；再次 send 空草稿不提交', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const sending: boolean[] = []
  const h = mount({ conversation: conv(1), prefill: null, onSendingChange: (s) => sending.push(s) })
  try {
    act(() => h.api().setDraftState('  你好  '))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.id, 1)
    assert.equal(api.submits[0]!.payload.text, '你好', '提交 trim 后的文本')
    assert.equal(api.submits[0]!.payload.origin, 'human')
    assert.equal(api.submits[0]!.payload.whenBusy, undefined, '非 working 不携带 whenBusy')
    assert.equal(h.api().text, '', '乐观清空')
    assert.deepEqual(sending, [true, false], '在途反馈如实开关')
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 1, '空草稿不提交')
  } finally {
    api.restore()
    h.unmount()
  }
})

test('send 失败：按冻结版本回滚文本与编辑目标，推送 updateFailed 错误通知（目标为该会话）', { timeout: 60_000 }, async () => {
  const api = stubApi({ submitError: new Error('boom') })
  const h = mount({ conversation: conv(1), prefill: { text: '旧消息', entryId: 9, tick: 1 } })
  try {
    await act(async () => { await h.api().send() })
    assert.equal(api.submits[0]!.payload.replaceFromEntryId, 9, '编辑重发携带 replaceFromEntryId')
    assert.equal(h.api().text, '旧消息', '失败回滚文本')
    assert.equal(h.api().editingEntryId, 9, '失败回滚编辑目标')
    const notices = h.notices()
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.level, 'error')
    assert.deepEqual(notices[0]!.target, { kind: 'conversation', conversationId: 1 })
  } finally {
    api.restore()
    h.unmount()
  }
})

test('精确命中插件斜杠命令走命令路径：调用插件 action、不提交、草稿清空；/new 与 /clear 作为会话命令即时执行', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const newThreads: number[] = []
  const h = mount({
    conversation: conv(1),
    prefill: null,
    slashPluginCommands: [pingCommand],
    onNewThread: () => newThreads.push(1),
  })
  try {
    act(() => h.api().setDraftState('/ping'))
    await act(async () => { await h.api().send() })
    assert.deepEqual(api.actions, [{ pluginId: 'builtin:demo', actionId: 'ping' }])
    assert.equal(api.submits.length, 0, '插件命令不提交输入')
    assert.equal(h.api().text, '', '命令触发词被乐观清理')
    assert.equal(h.api().runningCommand, null, '命令完成后回到空闲')

    act(() => h.api().setDraftState('/new'))
    await act(async () => { await h.api().send() })
    assert.deepEqual(newThreads, [1], '/new 进入新话题入口')
    assert.equal(h.api().text, '')

    act(() => h.api().setDraftState('/clear'))
    await act(async () => { await h.api().send() })
    assert.deepEqual(api.resets, [1], '/clear 重置会话上下文')
    assert.equal(api.submits.length, 0)
    assert.equal(h.api().text, '')

    act(() => h.api().setDraftState('/compact 保留结论'))
    await act(async () => { await h.api().send() })
    assert.deepEqual(api.compacts, ['保留结论'], '/compact 携带指令压缩上下文')
    assert.equal(api.submits.length, 0)
  } finally {
    api.restore()
    h.unmount()
  }
})

test('环境阻断：handleEnvBlocker 跨渲染身份稳定；阻断期间 send 拒绝并通知、strict 抛错；envConfigurable 变 false 复位', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const h = mount({ conversation: conv(1), prefill: null, envConfigurable: true })
  try {
    const handle = h.api().handleEnvBlocker
    act(() => handle({ blocked: true, reason: '环境未保存' }))
    assert.equal(h.api().envBlocker.blocked, true)
    h.rerender({})
    assert.ok(h.api().handleEnvBlocker === handle, '阻断上报出口身份稳定')
    act(() => h.api().setDraftState('hello'))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 0, '阻断期间不提交')
    assert.equal(h.notices().at(-1)!.title, 'Save or cancel the starting environment changes first')
    assert.equal(h.api().text, 'hello', '拒绝发送时草稿保留')
    await assert.rejects(() => h.api().send('steer', true), /Save or cancel the starting environment changes first/)
    // 环境栏卸载（envConfigurable=false）：残留阻断被复位
    h.rerender({ envConfigurable: false })
    assert.equal(h.api().envBlocker.blocked, false)
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 1, '复位后恢复正常发送')
  } finally {
    api.restore()
    h.unmount()
  }
})

test('sendExplicit：不消费草稿；working 时默认 steer、可显式 followUp；失败如实 reject 并通知', { timeout: 60_000 }, async () => {
  const opts: { submitError?: Error } = {}
  const api = stubApi(opts)
  const h = mount({ conversation: conv(1), prefill: null, working: true })
  try {
    act(() => h.api().setDraftState('草稿'))
    await act(async () => { await h.api().sendExplicit('  显式文本  ') })
    await act(async () => { await h.api().sendExplicit('跟进', 'followUp') })
    assert.equal(api.submits.length, 2)
    assert.equal(api.submits[0]!.payload.text, '显式文本')
    assert.equal(api.submits[0]!.payload.whenBusy, 'steer', 'working 下缺省 steer')
    assert.equal(api.submits[1]!.payload.whenBusy, 'followUp')
    assert.equal(api.submits[0]!.payload.attachments, undefined, '显式提交不携带草稿附件')
    assert.equal(h.api().text, '草稿', '显式提交不消费草稿')
    opts.submitError = new Error('nope')
    await assert.rejects(() => h.api().sendExplicit('再试'), /nope/, '失败如实 reject')
    assert.equal(h.notices().at(-1)!.level, 'error', '失败推送错误通知')
  } finally {
    api.restore()
    h.unmount()
  }
})

test('withdrawQueuedInput：撤回成功且草稿干净时整体替换为排队输入；草稿非空时仅通知不覆盖', { timeout: 60_000 }, async () => {
  const originalWithdraw = conversationsApi.withdraw
  const h = mount({ conversation: conv(1), prefill: null })
  const queued = { id: 'q1', submissionId: 'sub-1', text: '排队消息', mode: 'steer' as const, origin: 'human' as const, createdAt: 1 }
  try {
    conversationsApi.withdraw = (async () => ({ status: 'withdrawn' })) as typeof conversationsApi.withdraw
    await act(async () => { await h.api().withdrawQueuedInput(queued) })
    assert.equal(h.api().text, '排队消息')
    assert.equal(h.api().readLiveDraft(), '排队消息')
    act(() => h.api().setDraftState('正在输入'))
    await act(async () => { await h.api().withdrawQueuedInput({ ...queued, submissionId: 'sub-2' }) })
    assert.equal(h.api().text, '正在输入', '非空草稿不被覆盖')
    assert.equal(h.notices().at(-1)!.title, 'Queued message withdrawn')
    // 已进入执行：携带 entryId 进入编辑模式
    conversationsApi.withdraw = (async () => ({ status: 'already_placed', entryId: 42 })) as typeof conversationsApi.withdraw
    act(() => h.api().cancelEdit())
    await act(async () => { await h.api().withdrawQueuedInput({ ...queued, submissionId: 'sub-3' }) })
    assert.equal(h.api().text, '排队消息')
    assert.equal(h.api().editingEntryId, 42)
  } finally {
    conversationsApi.withdraw = originalWithdraw
    h.unmount()
  }
})

test('nextTurnOverride：idle 发送透传 model/thinkingLevel 且仅在成功后消费；失败保留，busy/编辑/Ask/helmx 忽略且不消费', { timeout: 60_000 }, async () => {
  const opts: { submitError?: Error } = {}
  const api = stubApi(opts)
  const consumed: NextTurnModelOverride[] = []
  const staged: NextTurnModelOverride = { model: 'anthropic/claude-opus-4-6', thinkingLevel: 'high' }
  const h = mount({
    conversation: conv(1),
    prefill: null,
    nextTurnOverride: staged,
    onConsumeNextTurnOverride: (item) => consumed.push(item),
  })
  try {
    // 1. 失败时不消费 staged
    opts.submitError = new Error('transient failure')
    act(() => h.api().setDraftState('首次失败'))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.payload.model, 'anthropic/claude-opus-4-6')
    assert.equal(api.submits[0]!.payload.thinkingLevel, 'high')
    assert.equal(consumed.length, 0, '提交失败时不得消费单轮覆盖')

    // 2. 重试成功后才触发消费回调
    opts.submitError = undefined
    await act(async () => { await h.api().send() })
    assert.equal(api.submits.length, 2)
    assert.deepEqual(consumed, [staged])

    // 3. working / editing / pendingAskCount > 0 / ownedBy=helmx 时不附加且不消费
    h.rerender({ working: true, nextTurnOverride: staged })
    act(() => h.api().setDraftState('忙时插话'))
    await act(async () => { await h.api().send('steer') })
    assert.equal(api.submits[2]!.payload.model, undefined)
    assert.equal(api.submits[2]!.payload.thinkingLevel, undefined)
    assert.equal(consumed.length, 1)

    h.rerender({ working: false, conversation: { ...conv(1), pendingAskCount: 1 }, nextTurnOverride: staged })
    act(() => h.api().setDraftState('等待审批'))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits[3]!.payload.model, undefined)

    h.rerender({ conversation: { ...conv(1), ownedBy: 'helmx' }, nextTurnOverride: staged })
    act(() => h.api().setDraftState('托管会话'))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits[4]!.payload.model, undefined)

    h.rerender({ conversation: conv(1), nextTurnOverride: staged })
    act(() => h.api().applyHistoryEdit({ text: '编辑消息', entryId: 12 }))
    await act(async () => { await h.api().send() })
    assert.equal(api.submits[5]!.payload.replaceFromEntryId, 12)
    assert.equal(api.submits[5]!.payload.model, undefined)
    assert.equal(consumed.length, 1)
  } finally {
    api.restore()
    h.unmount()
  }
})
