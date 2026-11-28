/**
 * 历史消息编辑态（编辑并重发）第二版边界测试。
 *
 * 覆盖：
 * 1. 编辑目标附件整体替换（目标无附件则清空旧草稿，绝不保留上一个目标的残留）。
 * 2. 编辑目标 / 草稿版本 / 发送失败恢复判定的纯函数语义。
 * 3. SSR 渲染行为：human 消息渲染编辑铅笔，agent/trigger 消息不渲染铅笔但保留复制。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry } from '@helmx/protocol'
import {
  attachmentsOfEditTarget,
  draftVersionOf,
  isHistoricalEdit,
  sameDraftVersion,
  shouldRestoreEditOnFailure,
  type PendingAttachment,
} from '../src/conversation/composer-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

// 与 queued-pill SSR 测试一致：为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

function renderTimelineHtml(entries: ConversationEntry[]): string {
  const conversation = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status: 'idle' as const, stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => undefined
  const store = makeTestStore({
conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, uiContributions: [],
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark', locale: 'en', quietNotifyEnabled: false,
    profiles: [], profilesLoaded: true, assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: []
  })
  return renderToString(React.createElement(HostStoreProviders, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries, onRequestEdit: noop,
    }),
  ))
}

const att = (id: string, name: string, size = 100): PendingAttachment => ({
  artifactId: id,
  name,
  size,
  mimeType: 'image/png',
})

test('attachmentsOfEditTarget：每次选择编辑目标整体替换附件，目标无附件时清空旧草稿', { timeout: 60_000 }, () => {
  // 目标带附件：转换为待发送草稿（保留 id/name/size/mimeType）。
  const withAtt = attachmentsOfEditTarget({
    text: '带图的问题',
    entryId: 7,
    attachments: [{ id: 'a1', name: '截图.png', mimeType: 'image/png', size: 2048 }],
  })
  assert.deepEqual(withAtt, [att('a1', '截图.png', 2048)])

  // 目标无附件（排队撤回回填 / ↑ 历史编辑空附件）：返回空数组替换旧草稿，不保留残留。
  assert.deepEqual(attachmentsOfEditTarget({ text: '撤回的排队消息' }), [])
  assert.deepEqual(attachmentsOfEditTarget({ text: '无附件历史', entryId: 9 }), [])
  // attachments 为空数组同样整体替换为空。
  assert.deepEqual(attachmentsOfEditTarget({ text: 'x', attachments: [] }), [])
})

test('isHistoricalEdit：仅 entryId 锚点存在时构成原地编辑', { timeout: 60_000 }, () => {
  assert.equal(isHistoricalEdit({ text: 'x', entryId: 5 }), true)
  assert.equal(isHistoricalEdit({ text: 'x' }), false)
  assert.equal(isHistoricalEdit({ text: 'x', attachments: [] }), false)
})

test('draftVersionOf / sameDraftVersion：文本、编辑目标、附件任一变化即视为草稿已修改', { timeout: 60_000 }, () => {
  const base = draftVersionOf('文本', 5, [att('a1', '图')])
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [att('a1', '图')])), true)
  // 文本变化
  assert.equal(sameDraftVersion(base, draftVersionOf('新文本', 5, [att('a1', '图')])), false)
  // 编辑目标变化（含切换到无目标）
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', null, [att('a1', '图')])), false)
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 6, [att('a1', '图')])), false)
  // 附件增删（顺序也参与比较）
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [att('a1', '图'), att('a2', '图2')])), false)
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [])), false)
  assert.equal(
    sameDraftVersion(
      draftVersionOf('t', null, [att('a1', 'x'), att('a2', 'y')]),
      draftVersionOf('t', null, [att('a2', 'y'), att('a1', 'x')]),
    ),
    false,
  )
})

test('shouldRestoreEditOnFailure：仅当 Composer 仍处于乐观清空后的期望状态才恢复', { timeout: 60_000 }, () => {
  // 期望状态 = 乐观清空后的（'', null, 原附件未变）
  const expected = draftVersionOf('', null, [att('a1', '图')])
  // 用户未动任何东西：恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, [att('a1', '图')]), expected), true)
  // 用户已输入新文本：不恢复（旧 target 不得误挂新输入）
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('新输入', null, [att('a1', '图')]), expected), false)
  // 用户已选择其他编辑目标：不恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', 9, [att('a1', '图')]), expected), false)
  // 用户改动了附件：不恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, []), expected), false)
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, [att('a1', '图'), att('a2', 'y')]), expected), false)
})

test('SSR 行为：human 消息渲染编辑铅笔，agent/trigger 消息不渲染铅笔但保留复制', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '人类提问', origin: 'human' } },
    { id: '2', kind: 'helmx.input', data: { text: 'Worker 已完成', origin: 'agent' } },
    { id: '3', kind: 'helmx.input', data: { text: 'cron 触发', origin: 'trigger' } },
  ]
  const html = renderTimelineHtml(entries)
  assert.match(html, /人类提问/)
  assert.match(html, /From agent report/)
  assert.match(html, /From trigger/)
  // The edit entry point (title=Edit and resend) appears exactly once: only the human message.
  assert.equal([...html.matchAll(/title="Edit and resend"/g)].length, 1)
  // All three messages keep their copy button.
  assert.equal([...html.matchAll(/title="Copy"/g)].length >= 3, true)
})
