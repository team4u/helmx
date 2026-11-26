/**
 * AgentStandbyPane 拆分出的 agent-standby/ 子 hook 与纯函数测试（直接挂载 hook 宿主）：
 * - buildStandbyAttachmentItems：本地文件「待上传」中性徽标 / 已上传「已上传」ok 徽标，移除即改草稿；
 * - useStandbyDraftActions：addFiles 接纳文件进草稿；applyStarter 仅回填空闲空草稿，非空时告警不覆盖；
 * - useStandbyPluginCommands：runPluginCommand 身份稳定；执行时乐观清理触发词、调插件 action、完成后回到空闲；
 * - useStandbySend.submitDraft：/new 清空草稿并提示；/clear、/compact 提示需要会话；精确命中插件命令走命令路径；
 * - useStandbyProfileNavigation：resetEnvToDefault 迁移草稿并导航默认环境；switchProfile 同角色仅关选择器，
 *   异角色迁移草稿、以 replace 导航并登记显式聚焦请求。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Profile } from '@helmx/protocol'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import { HelmxExternalStoreContext, makeTestStore } from './helpers/store.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')

import { conversationsApi, pluginsApi } from '../src/lib/api.js'
import type { QualifiedCommand } from '../src/lib/commands-model.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import type { ToastNotice } from '../src/lib/types.js'
import {
  getStandbyDraft,
  getStandbyFocusRequest,
  resetStandbyDrafts,
  standbyDraftKey,
  updateStandbyDraft,
} from '../src/conversation/standby-model.js'
import { buildStandbyAttachmentItems } from '../src/conversation/agent-standby/standby-attachment-items.js'
import { useStandbyDraftActions, type StandbyDraftActions } from '../src/conversation/agent-standby/use-standby-draft-actions.js'
import { useStandbyPluginCommands, type StandbyPluginCommands } from '../src/conversation/agent-standby/use-standby-plugin-commands.js'
import { useStandbySend, type StandbySendActions } from '../src/conversation/agent-standby/use-standby-send.js'
import {
  useStandbyProfileNavigation,
  type StandbyProfileNavigation,
} from '../src/conversation/agent-standby/use-standby-profile-navigation.js'
import { createWebTranslator } from '../src/i18n/catalog.js'

const profiles: Profile[] = [
  { id: 'assistant', name: 'Assistant' },
  { id: 'coder', name: 'Coder' },
]

const pingCommand: QualifiedCommand = {
  pluginId: 'builtin:demo',
  spec: { id: 'ping', title: 'Ping', slash: 'ping', actionId: 'ping' },
}

interface Harness {
  store: HelmxExternalStore
  draftActions: () => StandbyDraftActions
  commands: () => StandbyPluginCommands
  send: () => StandbySendActions
  navigation: () => StandbyProfileNavigation
  rerender: () => void
  notices: () => ToastNotice[]
  unmount: () => void
}

function mountHarness(profileId = 'assistant', nodeId?: string): Harness {
  const store = makeTestStore({
    profiles,
    primaryTarget: { kind: 'agent', profileId, ...(nodeId !== undefined ? { nodeId } : {}) },
    splitTarget: null,
    focusedPanel: 'primary',
  })
  const draftKey = standbyDraftKey({ panel: 'primary', profileId, nodeId })
  let draftActions: StandbyDraftActions | null = null
  let commands: StandbyPluginCommands | null = null
  let send: StandbySendActions | null = null
  let navigation: StandbyProfileNavigation | null = null
  const textareaRef = { current: null as HTMLTextAreaElement | null }
  const Probe = (): React.ReactNode => {
    const { invokePluginAction, pushNotice } = { invokePluginAction: store.actions.invokePluginAction, pushNotice: store.actions.pushNotice }
    const t = createWebTranslator('zh-CN')
    const draft = getStandbyDraft(draftKey)
    draftActions = useStandbyDraftActions({ draftKey, textareaRef, pushNotice, t })
    commands = useStandbyPluginCommands({ draftKey, textareaRef, invokePluginAction, pushNotice, locale: 'zh-CN', t })
    send = useStandbySend({
      draftKey,
      profileId,
      inheritedNodeId: nodeId,
      inheritedCwd: undefined,
      commandPendingRef: commands.commandPendingRef,
      executeStandbyPluginCommand: commands.executeStandbyPluginCommand,
      slashPluginCommands: [pingCommand],
      pushNotice,
      t,
    })
    navigation = useStandbyProfileNavigation({ draftKey, draft, panel: 'primary', profileId, pushNotice, t })
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (): void => {
    act(() => {
      root.render(React.createElement(HelmxExternalStoreContext.Provider, { value: store }, React.createElement(Probe)))
    })
  }
  render()
  return {
    store,
    draftActions: () => draftActions!,
    commands: () => commands!,
    send: () => send!,
    navigation: () => navigation!,
    rerender: render,
    notices: () => store.getNotices(),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function stubPluginAction(): { actions: string[]; restore: () => void } {
  const original = pluginsApi.invokeAction
  const actions: string[] = []
  pluginsApi.invokeAction = (async (_pluginId: string, actionId: string) => {
    actions.push(actionId)
    return { ok: true }
  }) as typeof pluginsApi.invokeAction
  return { actions, restore: () => { pluginsApi.invokeAction = original } }
}

afterEach(() => {
  resetStandbyDrafts()
  resetHappyDom()
})

test('buildStandbyAttachmentItems：本地文件待上传中性徽标、已上传 ok 徽标；移除即改草稿', { timeout: 60_000 }, () => {
  const draftKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  updateStandbyDraft(draftKey, {
    localFiles: [{ key: 'lf-1', file: new File(['x'], 'local.txt', { type: 'text/plain' }), name: 'local.txt', size: 1, mimeType: 'text/plain' }],
    uploaded: [{ artifactId: 'art-9', name: 'up.png', size: 2, mimeType: 'image/png' }],
  })
  const items = buildStandbyAttachmentItems(getStandbyDraft(draftKey), draftKey, false, createWebTranslator('zh-CN'))
  assert.equal(items.length, 2)
  assert.equal(items[0]!.icon, 'file')
  const localBadge = items[0]!.badge
  assert.ok(localBadge !== undefined)
  assert.equal(localBadge.tone, 'neutral')
  assert.equal(items[1]!.icon, 'paperclip')
  const uploadedBadge = items[1]!.badge
  assert.ok(uploadedBadge !== undefined)
  assert.equal(uploadedBadge.tone, 'ok')
  items[0]!.onRemove()
  items[1]!.onRemove()
  const after = getStandbyDraft(draftKey)
  assert.equal(after.localFiles.length, 0)
  assert.equal(after.uploaded.length, 0)
  const locked = buildStandbyAttachmentItems(getStandbyDraft(draftKey), draftKey, true, createWebTranslator('zh-CN'))
  assert.equal(locked.length, 0)
})

test('useStandbyDraftActions：addFiles 接纳文件进草稿；applyStarter 仅回填空闲空草稿，非空 / 发送中不覆盖', { timeout: 60_000 }, () => {
  const h = mountHarness()
  try {
    act(() => h.draftActions().addFiles([new File(['abc'], 'note.txt', { type: 'text/plain' })]))
    assert.equal(getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' })).localFiles.length, 1)
    act(() => h.draftActions().applyStarter('引导词'))
    assert.equal(h.notices().at(-1)!.level, 'warning', '带附件的草稿不接纳引导词')
    updateStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' }), { localFiles: [] })
    h.rerender()
    act(() => h.draftActions().applyStarter('引导词'))
    assert.equal(getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' })).text, '引导词')
    act(() => h.draftActions().applyStarter('另一个引导词'))
    assert.equal(getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' })).text, '引导词', '非空草稿保持不变')
  } finally {
    h.unmount()
  }
})

test('useStandbyPluginCommands：runPluginCommand 身份稳定；执行时乐观清理触发词、调插件 action、完成后回到空闲', { timeout: 60_000 }, async () => {
  const stub = stubPluginAction()
  const h = mountHarness()
  const draftKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  try {
    const run = h.commands().runPluginCommand
    h.rerender()
    assert.ok(h.commands().runPluginCommand === run, '斜杠菜单入口跨渲染身份稳定')
    updateStandbyDraft(draftKey, { text: '/ping' })
    act(() => run(pingCommand))
    assert.equal(getStandbyDraft(draftKey).text, '', '触发词被乐观清理')
    await act(async () => {})
    assert.deepEqual(stub.actions, ['ping'])
    assert.equal(h.commands().runningCommand, null, '完成后回到空闲')
    // 发送中：命令被忽略
    updateStandbyDraft(draftKey, { text: '/ping', sending: true })
    act(() => h.commands().executeStandbyPluginCommand(pingCommand, 'clear'))
    assert.equal(getStandbyDraft(draftKey).text, '/ping', '发送中不执行命令')
    assert.deepEqual(stub.actions, ['ping'])
  } finally {
    stub.restore()
    h.unmount()
  }
})

test('useStandbySend.submitDraft：/new 清空草稿并提示；/clear 与 /compact 提示需要会话；精确命中插件命令走命令路径', { timeout: 60_000 }, async () => {
  const stub = stubPluginAction()
  const h = mountHarness()
  const draftKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const originalCreate = conversationsApi.create
  let creates = 0
  conversationsApi.create = (async () => {
    creates += 1
    throw new Error('must not create')
  }) as typeof conversationsApi.create
  try {
    updateStandbyDraft(draftKey, { text: '/new', localFiles: [{ key: 'k', file: new File(['x'], 'a.txt'), name: 'a.txt', size: 1, mimeType: 'text/plain' }] })
    act(() => h.send().submitDraft())
    const after = getStandbyDraft(draftKey)
    assert.equal(after.text, '')
    assert.equal(after.localFiles.length, 0, '/new 清空整个草稿')
    assert.equal(h.notices().at(-1)!.title, '已开始新草稿')
    updateStandbyDraft(draftKey, { text: '/clear' })
    act(() => h.send().submitDraft())
    assert.match(String(h.notices().at(-1)!.title), /\/clear/)
    updateStandbyDraft(draftKey, { text: '/compact' })
    act(() => h.send().submitDraft())
    assert.match(String(h.notices().at(-1)!.title), /\/compact/)
    updateStandbyDraft(draftKey, { text: '/ping' })
    act(() => h.send().submitDraft())
    await act(async () => {})
    assert.deepEqual(stub.actions, ['ping'], '精确命中走命令路径')
    assert.equal(creates, 0, '命令与管理命令都不创建会话')
  } finally {
    conversationsApi.create = originalCreate
    stub.restore()
    h.unmount()
  }
})

test('useStandbyProfileNavigation：resetEnvToDefault 迁移草稿并导航默认环境；switchProfile 同角色仅关选择器，异角色 replace 导航并登记聚焦请求', { timeout: 60_000 }, () => {
  const defaultKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  // 1. 自定义环境草稿：恢复默认时迁移到默认环境键并以 replace 导航
  const custom = mountHarness('assistant', 'remote-1')
  const customKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant', nodeId: 'remote-1' })
  updateStandbyDraft(customKey, { text: '自定义环境草稿', envCustomized: true, envNodeId: 'remote-1' })
  act(() => custom.navigation().resetEnvToDefault())
  assert.equal(getStandbyDraft(defaultKey).text, '自定义环境草稿', '草稿随重置迁移到默认环境')
  assert.deepEqual(custom.store.getSnapshot().primaryTarget, { kind: 'agent', profileId: 'assistant' })
  custom.unmount()

  // 2. 默认环境下的角色切换
  const h = mountHarness('assistant')
  try {
    let closed = 0
    act(() => h.navigation().switchProfile('assistant', () => { closed += 1 }))
    assert.equal(closed, 1, '同角色切换只关闭选择器')

    updateStandbyDraft(defaultKey, { text: '随行草稿' })
    act(() => h.navigation().switchProfile('coder'))
    assert.equal(getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'coder' })).text, '随行草稿', '草稿迁移到目标角色')
    assert.equal(getStandbyDraft(defaultKey).text, '', '源草稿已迁走')
    assert.deepEqual(h.store.getSnapshot().primaryTarget, { kind: 'agent', profileId: 'coder' })
    const focus = getStandbyFocusRequest()
    assert.ok(focus !== null && focus.profileId === 'coder' && focus.explicit, '登记目标角色的显式聚焦请求')
  } finally {
    h.unmount()
  }
})
