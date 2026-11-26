/**
 * ConversationPane 拆分出的 conversation-pane/ 子 hook 测试（直接挂载 hook 宿主）：
 * - useConversationPaneOutline：关闭时不构建大纲节点；打开后按时间线构建、徽标计数为人类提问轮数；
 *   跳转请求携带递增 tick；close 收起浮层并清空滚动 / 锚点状态；无更早历史时 loadEarlier 为空操作；
 * - useConversationPaneActions：saveTitle 空 / 同名不发请求，改名成功推送 info 通知，失败推送 error 通知；
 *   resetContext 与 deleteConversation 走对应 API（删除导航由 conversation.deleted 事件负责，这里只看通知）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')

import { conversationsApi } from '../src/lib/api.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import type { ToastNotice } from '../src/lib/types.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import {
  useConversationPaneActions,
  type ConversationPaneActions,
} from '../src/conversation/conversation-pane/use-conversation-pane-actions.js'
import {
  useConversationPaneOutline,
  type ConversationPaneOutline,
} from '../src/conversation/conversation-pane/use-conversation-pane-outline.js'
import { HelmxExternalStoreContext } from './helpers/store.js'

const conv = (id: number, title = '会话'): ConversationSummary => ({
  id, title, profileId: 'coder', tags: [], cwd: '/w', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})

const human = (id: string, text: string): ConversationEntry => ({ id, kind: 'helmx.input', createdAt: 1, data: { text, origin: 'human' } }) as ConversationEntry
const assistantText = (id: string, text: string): ConversationEntry => ({
  id, kind: 'pi.assistant', createdAt: 2,
  model: [{ role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text }] }],
}) as unknown as ConversationEntry

interface Harness {
  store: HelmxExternalStore
  outline: () => ConversationPaneOutline
  actions: () => ConversationPaneActions
  notices: () => ToastNotice[]
  unmount: () => void
}

function mountHarness(conversation: ConversationSummary): Harness {
  const store = makeTestStore({ conversations: [conversation] })
  const items = buildTimelineItems([human('1', '第一问'), assistantText('2', '# 标题\n回答'), human('3', '第二问'), assistantText('4', '回答二')])
  let outline: ConversationPaneOutline | null = null
  let actions: ConversationPaneActions | null = null
  const Probe = (): React.ReactNode => {
    outline = useConversationPaneOutline(conversation.id, items, false, conversation.status)
    actions = useConversationPaneActions(conversation.id, conversation)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(React.createElement(HelmxExternalStoreContext.Provider, { value: store }, React.createElement(Probe)))
  })
  return {
    store,
    outline: () => outline!,
    actions: () => actions!,
    notices: () => store.getNotices(),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function stubApi(opts?: { patchError?: Error; removeError?: Error }): {
  patches: Array<{ id: number; body: Record<string, unknown> }>
  removes: number[]
  resets: number[]
  restore: () => void
} {
  const original = { patch: conversationsApi.patch, remove: conversationsApi.remove, reset: conversationsApi.reset }
  const patches: Array<{ id: number; body: Record<string, unknown> }> = []
  const removes: number[] = []
  const resets: number[] = []
  conversationsApi.patch = (async (id: number, body: Record<string, unknown>) => {
    patches.push({ id, body })
    if (opts?.patchError !== undefined) throw opts.patchError
    return { ...conv(id), ...(body as Partial<ConversationSummary>) }
  }) as unknown as typeof conversationsApi.patch
  conversationsApi.remove = (async (id: number) => {
    removes.push(id)
    if (opts?.removeError !== undefined) throw opts.removeError
  }) as unknown as typeof conversationsApi.remove
  conversationsApi.reset = (async (id: number) => {
    resets.push(id)
    return conv(id)
  }) as typeof conversationsApi.reset
  return { patches, removes, resets, restore: () => {
    conversationsApi.patch = original.patch
    conversationsApi.remove = original.remove
    conversationsApi.reset = original.reset
  } }
}

afterEach(() => {
  resetHappyDom()
})

test('useConversationPaneOutline：关闭时不建节点、打开后构建并计数人类轮数；跳转 tick 递增；close 清空滚动与锚点；无更早历史时 loadEarlier 空操作', { timeout: 60_000 }, () => {
  const h = mountHarness(conv(1))
  try {
    const o = h.outline()
    assert.equal(o.open, false)
    assert.equal(o.nodes.length, 0, '关闭时不构建大纲节点')
    assert.equal(o.badgeCount, 2, '徽标计数为人类提问轮数')
    act(() => o.onOpenChange(true))
    assert.ok(h.outline().nodes.length > 0, '打开后构建大纲节点')
    assert.equal(h.outline().activeNodeKey, undefined, '无阅读锚点时无当前项')
    act(() => h.outline().onSelectTarget({ entryId: '3' }))
    const first = h.outline().scrollRequest
    assert.ok(first !== null && first.entryId === '3' && first.tick === 1)
    act(() => h.outline().onSelectTarget({ entryId: '3' }))
    assert.equal(h.outline().scrollRequest!.tick, 2, '重复跳转同一目标也产生新 tick')
    act(() => h.outline().onActiveAnchorChange({ entryId: '3' }))
    assert.notEqual(h.outline().activeNodeKey, undefined, '阅读锚点映射为单个当前节点')
    act(() => h.outline().loadEarlierHistory())
    assert.equal(h.outline().loadingEarlierHistory, false, '无更早历史时不触发加载')
    act(() => h.outline().close())
    assert.equal(h.outline().open, false)
    assert.equal(h.outline().scrollRequest, null)
    assert.equal(h.outline().activeNodeKey, undefined)
  } finally {
    h.unmount()
  }
})

test('useConversationPaneActions：saveTitle 空 / 同名不发请求，改名成功与失败分别推送 info / error 通知', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const h = mountHarness(conv(1, '旧标题'))
  try {
    await act(async () => { await h.actions().saveTitle('  ') })
    await act(async () => { await h.actions().saveTitle('旧标题') })
    assert.equal(api.patches.length, 0, '空标题与同名标题不发请求')
    await act(async () => { await h.actions().saveTitle('  新标题  ') })
    assert.deepEqual(api.patches, [{ id: 1, body: { title: '新标题' } }])
    assert.equal(h.notices().at(-1)!.level, 'info')
    assert.equal(h.actions().actionPending, null, '动作结束后清除 pending')
    api.restore()
    const failing = stubApi({ patchError: new Error('offline') })
    try {
      await act(async () => { await h.actions().saveTitle('再改') })
      assert.equal(h.notices().at(-1)!.level, 'error', '失败推送 error 通知')
      assert.match(String(h.notices().at(-1)!.body), /offline/)
    } finally {
      failing.restore()
    }
  } finally {
    api.restore()
    h.unmount()
  }
})

test('useConversationPaneActions：resetContext 与 deleteConversation 走对应 API；删除失败推送 error 通知', { timeout: 60_000 }, async () => {
  const api = stubApi({ removeError: new Error('denied') })
  const h = mountHarness(conv(1))
  try {
    await act(async () => { await h.actions().resetContext() })
    assert.deepEqual(api.resets, [1])
    assert.equal(h.notices().at(-1)!.level, 'info')
    await act(async () => { await h.actions().deleteConversation() })
    assert.deepEqual(api.removes, [1])
    assert.equal(h.notices().at(-1)!.level, 'error', '删除失败如实推送 error 通知')
    assert.match(String(h.notices().at(-1)!.body), /denied/)
  } finally {
    api.restore()
    h.unmount()
  }
})
