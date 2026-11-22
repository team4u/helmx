/**
 * 时间线渲染裁决与插件设置面板渲染测试：
 * 1. timeline.renderer / tool.view 的 priority 降序稳定裁决；
 * 2. PluginDetailDrawer 同插件多 settings.panel 全量按 order 渲染；
 * 3. ConversationRowActionsMenu 归属权门禁与中文文案本地化。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  ConversationSummary,
  PluginSummary,
  PluginUiContribution,
  SettingsPanelSpec,
} from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { groupUiContributions } = await import('../src/lib/types.js')
const {
  findToolView,
  humanItemEntryKind,
  matchTimelineRenderer,
  sortByPriorityDescStable,
} = await import('../src/conversation/timeline-model.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { pluginsApi } = await import('../src/lib/api.js')
const { ConversationRowActionsMenu } = await import('../src/ui/ConversationRowActionsMenu.js')
const { PluginDetailDrawer } = await import('../src/plugins/PluginDetailDrawer.js')

const e = React.createElement

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const humanConv = conv({ id: 10 })
const helmxConv = conv({ id: 21, ownedBy: 'helmx' })

function entry(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, ...extra } as Parameters<typeof matchTimelineRenderer>[0]
}

// ---------------------------------------------------------------------------
// 1. priority 降序稳定裁决
// ---------------------------------------------------------------------------

test('sortByPriorityDescStable：priority 降序，同优先级保持贡献顺序', { timeout: 60_000 }, () => {
  const items = [
    { pluginId: 'a', spec: { id: 'a1', priority: 0 } },
    { pluginId: 'b', spec: { id: 'b1', priority: 10 } },
    { pluginId: 'c', spec: { id: 'c1' } },
    { pluginId: 'd', spec: { id: 'd1', priority: 10 } },
    { pluginId: 'e', spec: { id: 'e1', priority: -5 } },
  ]
  const sorted = sortByPriorityDescStable(items)
  assert.deepEqual(sorted.map((i) => i.pluginId), ['b', 'd', 'a', 'c', 'e'])
  assert.deepEqual(items.map((i) => i.pluginId), ['a', 'b', 'c', 'd', 'e'])
})

test('findToolView：priority 高者胜，同优先级先注册先命中', { timeout: 60_000 }, () => {
  const views = [
    { pluginId: 'plugin-a', spec: { id: 'va', toolNames: ['bash'], priority: 0 } },
    { pluginId: 'plugin-b', spec: { id: 'vb', toolNames: ['bash'], priority: 10 } },
  ]
  assert.equal(findToolView('bash', views)?.pluginId, 'plugin-b')
  const withoutB = views.filter((v) => v.pluginId !== 'plugin-b')
  assert.equal(findToolView('bash', withoutB)?.pluginId, 'plugin-a')
  const samePriority = [
    { pluginId: 'first', spec: { id: 'f', toolNames: ['bash'] } },
    { pluginId: 'second', spec: { id: 's', toolNames: ['bash'], priority: 0 } },
  ]
  assert.equal(findToolView('bash', samePriority)?.pluginId, 'first')
  assert.equal(findToolView('read', views), undefined)
})

test('findToolView：replaceRow 语义随命中 spec 透传，匹配层不做干预', { timeout: 60_000 }, () => {
  const views = [
    { pluginId: 'inline', spec: { id: 'v1', toolNames: ['bash'], priority: 0, replaceRow: true } },
    { pluginId: 'wrap', spec: { id: 'v2', toolNames: ['bash'], priority: -1 } },
  ]
  const hit = findToolView('bash', views)
  assert.equal(hit?.pluginId, 'inline')
  assert.equal(hit?.spec.replaceRow, true)
})

test('matchTimelineRenderer：priority 降序 + kinds/matchMeta 组合裁决', { timeout: 60_000 }, () => {
  const renderers = [
    { pluginId: 'low', spec: { id: 'r0', matchMeta: { renderer: 'x' }, priority: 0 } },
    { pluginId: 'high', spec: { id: 'r1', matchMeta: { renderer: 'x' }, priority: 5 } },
  ]
  assert.equal(
    matchTimelineRenderer(entry('1', 'helmx.input', { data: { meta: { renderer: 'x' } } }), renderers)?.pluginId,
    'high',
  )
  const narrowed = [
    { pluginId: 'low', spec: { id: 'r0', matchMeta: { renderer: 'x' }, priority: 0 } },
    { pluginId: 'high', spec: { id: 'r1', kinds: ['pi.user'], matchMeta: { renderer: 'x' }, priority: 5 } },
  ]
  assert.equal(
    matchTimelineRenderer(entry('2', 'helmx.input', { data: { meta: { renderer: 'x' } } }), narrowed)?.pluginId,
    'low',
  )
  assert.equal(matchTimelineRenderer(entry('3', 'helmx.input', { data: { text: '普通' } }), renderers), undefined)
})

test('humanItemEntryKind：helmx.input 归一化优先，兜底 pi.user', { timeout: 60_000 }, () => {
  assert.equal(humanItemEntryKind({ kind: 'human', key: 'k', entryId: '1', text: 't', origin: 'human', fallback: false }), 'helmx.input')
  assert.equal(humanItemEntryKind({ kind: 'human', key: 'k', entryId: '1', text: 't', origin: 'human', fallback: true }), 'pi.user')
})

// ---------------------------------------------------------------------------
// 2. PluginDetailDrawer：同插件多 settings.panel 全量按 order 渲染
// ---------------------------------------------------------------------------

test('groupedUi.settingsPanels 排序与 PluginDetailDrawer 多面板全量渲染', { timeout: 60_000 }, async () => {
  const contributions: PluginUiContribution[] = [
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p2', label: '第二面板', order: 20 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p1', label: '第一面板', order: 10 } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-c', surface: 'settings.panel', spec: { id: 'p0', label: '缺省顺序' } satisfies SettingsPanelSpec },
    { pluginId: 'plugin-d', surface: 'settings.panel', spec: { id: 'other', label: '其他插件' } satisfies SettingsPanelSpec },
  ]
  const grouped = groupUiContributions(contributions)
  const pluginCPanels = grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-c')
  assert.deepEqual(pluginCPanels.map((p) => p.spec.id), ['p1', 'p2', 'p0'])
  assert.equal(grouped.settingsPanels.filter((p) => p.pluginId === 'plugin-d').length, 1)

  const originalGetConfig = pluginsApi.getConfig
  pluginsApi.getConfig = async () => ({ values: {}, schema: {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const plugin: PluginSummary = {
    id: 'plugin-c',
    name: '多面板测试插件',
    version: '1.0.0',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
  }
  const store = makeTestStore({ uiContributions: contributions })
  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(PluginDetailDrawer, {
            plugin,
            open: true,
            inline: true,
            onClose: () => {},
            onToggleEnabled: async () => {},
            toggling: false,
          }),
        ),
      )
    })
    const text = host.textContent ?? ''
    const idx1 = text.indexOf('第一面板')
    const idx2 = text.indexOf('第二面板')
    const idx0 = text.indexOf('缺省顺序')
    assert.ok(idx1 >= 0 && idx2 > idx1 && idx0 > idx2, '同插件多个 settings.panel 应按 order 升序全部渲染')
    assert.ok(!text.includes('其他插件'), '不渲染其他插件的 settings.panel')
  } finally {
    act(() => root.unmount())
    host.remove()
    pluginsApi.getConfig = originalGetConfig
  }
})

// ---------------------------------------------------------------------------
// 3. ConversationRowActionsMenu：人类自有根会话渲染、helmx 托管零残留与本地化
// ---------------------------------------------------------------------------

test('ConversationRowActionsMenu：仅在人类自有根会话时渲染菜单入口', { timeout: 60_000 }, () => {
  const humanStore = makeTestStore({ conversations: [humanConv] })
  const humanHtml = renderToString(
    e(HostStoreProviders, { value: humanStore }, e(ConversationRowActionsMenu, { conversation: humanConv })),
  )
  assert.match(humanHtml, /Conversation actions/)

  const helmxStore = makeTestStore({ conversations: [helmxConv] })
  const emptyHtml = renderToString(
    e(HostStoreProviders, { value: helmxStore }, e(ConversationRowActionsMenu, { conversation: helmxConv })),
  )
  assert.equal(emptyHtml, '', '无可渲染动作时零渲染、零视觉残留')
})

test('ConversationRowActionsMenu localizes copy in zh-CN', { timeout: 60_000 }, () => {
  const storeZh = makeTestStore({
    locale: 'zh-CN',
    conversations: [humanConv],
  })
  const rowHtmlZh = renderToString(
    e(HostStoreProviders, { value: storeZh }, e(ConversationRowActionsMenu, { conversation: humanConv })),
  )
  assert.match(rowHtmlZh, /会话操作/)
})
