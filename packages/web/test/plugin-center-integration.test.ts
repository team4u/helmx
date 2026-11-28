/**
 * 全屏插件中心端到端集成测试 (PluginCenter Integration Test)
 *
 * 覆盖：
 * 1. 结构与主视图渲染：顶部搜索框（HelmxIcon search）、分类药丸标签栏及 buildCategoryCounts 统计徽章、卡片网格；
 * 2. 多维分类过滤与搜索联动：关键字搜索实时过滤、分类药丸过滤、组合过滤、空状态重置；
 * 3. 卡片点击与详情抽屉联动：点击卡片调用 store.openTarget 展开 PluginDetailDrawer，关闭抽屉回退；
 * 4. 全局导航收敛：CommandPaletteModal 点击「打开插件中心」调用 openTarget({ kind: 'plugins' })；
 * 5. 中英文界面内容渲染断言。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureHappyDom, flushMacrotask, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

import type { PluginSummary } from '@helmx/protocol'
import { formatLocationHash, parseLocationHash } from '../src/lib/url-hash-model.js'
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { OmniboxModal } = await import('../src/omnibox/OmniboxModal.js')

const e = React.createElement
const typeIntoInput = typeIntoControl

function makePlugin(partial: Partial<PluginSummary> & { id: string }): PluginSummary {
  return {
    name: partial.name ?? partial.id,
    version: partial.version ?? '1.0.0',
    locked: partial.locked ?? false,
    enabled: partial.enabled ?? true,
    hooks: partial.hooks ?? [],
    actions: partial.actions ?? [],
    tools: partial.tools ?? [],
    ...partial,
  }
}

const mockPlugins: PluginSummary[] = [
  makePlugin({
    id: 'builtin:mentions',
    name: '角色点名',
    locked: false,
    enabled: true,
    tools: [],
    actions: ['list_mentionable'],
  }),
  makePlugin({
    id: 'builtin:workflow',
    name: '工作流引擎',
    locked: false,
    enabled: true,
    tools: ['subagent', 'cleanup_worktree'],
    actions: ['run', 'inspect'],
  }),
  makePlugin({
    id: 'builtin:herdr',
    name: 'Herdr 控制台',
    locked: false,
    enabled: false,
    tools: [],
    actions: ['bridge_status', 'resume'],
  }),
  makePlugin({
    id: 'builtin:triggers',
    name: '触发器连接器',
    locked: false,
    enabled: true,
    tools: [],
    actions: ['webhook_deliver'],
  }),
  makePlugin({
    id: 'tools:calculator',
    name: '计算器工具',
    locked: false,
    enabled: true,
    tools: ['calculate'],
    actions: [],
  }),
]

// 包含一个 failed 故障态插件的变体数据集
const mockPluginsWithFailure: PluginSummary[] = [
  ...mockPlugins,
  makePlugin({
    id: 'external:broken',
    name: '损坏插件',
    enabled: false,
    status: 'failed',
    error: { code: 'plugin_load_failed', message: '入口文件缺失', stage: 'scan' },
  }),
]

// ---------------------------------------------------------------------------
// 1. PluginCenter SSR 与主体结构渲染
// ---------------------------------------------------------------------------

/** 记录真实 openTarget 调用序列（委托真实导航动作）。 */
function spyOpenTarget(store: import('../src/lib/helmx-store.js').HelmxExternalStore, opened: unknown[]): void {
  ;(store.actions as unknown as { openTarget: (target: unknown) => void }).openTarget = (target) => {
    opened.push(target)
    store.navActions.applyPrimaryTarget(
      typeof target === 'string' ? { kind: 'plugins' } : target as import('../src/lib/types.js').ResolvedTarget,
    )
  }
}

test('PluginCenter SSR：渲染搜索框、统计徽章与卡片网格', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(PluginCenter)),
  )

  // 1. 主容器与统一单层工具栏（含分段切换、primary 安装按钮、TabCount，无双顶栏）
  assert.match(html, /class="[^"]*screen-pane[^"]*"/)
  assert.match(html, /class="[^"]*screen-toolbar-bar[^"]*"/)
  assert.match(html, /class="[^"]*segmented-control[^"]*"/)
  assert.match(html, /class="[^"]*btn-primary[^"]*"[^>]*aria-label="Install plugin"/)
  assert.match(html, /helmx-tab-count/)
  assert.doesNotMatch(html, /model-center-tabs/)

  // 2. 搜索框与搜索图标
  assert.match(html, /class="[^"]*search-box-toolbar[^"]*search-box-sm[^"]*"/)
  assert.match(html, /placeholder="[^"]*Search/)

  // 3. 统计指标显示（无故障态时不展示异常计数）
  assert.doesNotMatch(html, /个异常/)

  // 5. 响应式自适应网格与所有卡片
  assert.match(html, /class="[^"]*helmx-card-grid[^"]*"/)
  assert.match(html, /data-plugin-id="builtin:mentions"/)
  assert.match(html, /data-plugin-id="builtin:workflow"/)
  assert.match(html, /data-plugin-id="builtin:herdr"/)
  assert.match(html, /data-plugin-id="builtin:triggers"/)
  assert.match(html, /data-plugin-id="tools:calculator"/)
})

test('PluginCenter SSR：存在 failed 故障态插件时顶栏统计追加异常计数且卡片标记 is-failed', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    plugins: mockPluginsWithFailure,
    primaryTarget: { kind: 'plugins' },
  })

  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(PluginCenter)),
  )

  // 1. 顶栏统计追加异常计数（failed 插件 enabled: false，不计入已启用）

  // 2. 故障卡片标记 is-failed 并渲染异常状态灯（failed 实心红点 + 可见 Error 文案）
  assert.match(html, /data-plugin-id="external:broken"/)
  assert.match(html, /is-failed/)
  assert.match(html, /helmx-status-light-failed[\s\S]*?status-dot-error[\s\S]*?Error/)
})

// ---------------------------------------------------------------------------
// 3. DOM 交互测试：分类过滤、搜索过滤、卡片点击打开抽屉与关闭抽屉
// ---------------------------------------------------------------------------

test('PluginCenter DOM 交互：搜索过滤实时联动', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const openedTarget: unknown[] = []
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })
  spyOpenTarget(store, openedTarget)

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
  })

  // 初始状态包含 5 个卡片
  let cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 5)

  // 搜索框输入 "workflow"
  const searchInput = host.querySelector<HTMLInputElement>('.search-box-toolbar input')
  assert.ok(searchInput, '应存在搜索输入框')

  await act(async () => {
    typeIntoInput(searchInput, 'workflow')
  })

  cards = host.querySelectorAll('.plugin-card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.getAttribute('data-plugin-id'), 'builtin:workflow')

  // 点击卡片，触发 store.openTarget({ kind: 'plugins', pluginId: 'builtin:workflow' })
  await act(async () => {
    cards[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(openedTarget.at(-1), { kind: 'plugins', pluginId: 'builtin:workflow' })

  root.unmount()
  host.remove()
})

test('PluginCenter DOM 交互：渲染「全部 / 应用视图 / 已启用 / 已停用」筛选药丸并支持切换过滤', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const store = makeTestStore({
    plugins: mockPlugins,
    uiContributions: [
      {
        pluginId: 'builtin:triggers',
        surface: 'screen',
        spec: { id: 'main', label: 'Triggers', client: { module: 'index.tsx', export: 'Triggers' } },
      },
      {
        pluginId: 'tools:calculator',
        surface: 'screen',
        spec: { id: 'calc', label: 'Calculator', client: { module: 'index.tsx', export: 'Calc' } },
      },
    ] as import('../src/lib/types.js').HelmxStoreValue['uiContributions'],
    primaryTarget: { kind: 'plugins' },
  })

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    const enabledCount = mockPlugins.filter((p) => p.enabled).length
    const disabledCount = mockPlugins.filter((p) => !p.enabled).length
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.tabs-pills [role="tab"]'))
    assert.equal(tabs.length, 4, '应渲染 全部 / 应用视图 / 已启用 / 已停用 四个筛选药丸')

    const viewsTab = tabs.find((t) => t.textContent?.includes('With views'))
    assert.ok(viewsTab, '应渲染 With views 筛选药丸')
    assert.match(viewsTab.textContent ?? '', /2/)
    await act(async () => {
      viewsTab.click()
    })
    const viewCardIds = Array.from(host.querySelectorAll('.plugin-card')).map((el) => el.getAttribute('data-plugin-id'))
    assert.deepEqual(viewCardIds, ['builtin:triggers', 'tools:calculator'])

    const disabledTab = tabs.find((t) => t.textContent?.includes('Disabled'))
    assert.ok(disabledTab)
    assert.match(disabledTab.textContent ?? '', new RegExp(String(disabledCount)))

    await act(async () => {
      disabledTab.click()
    })
    assert.equal(host.querySelectorAll('.plugin-card').length, disabledCount)

    const enabledTab = tabs.find((t) => t.textContent?.includes('Enabled'))!
    await act(async () => {
      enabledTab.click()
    })
    assert.equal(host.querySelectorAll('.plugin-card').length, enabledCount)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 4. DOM 交互测试：抽屉展开与关闭联动
// ---------------------------------------------------------------------------

test('PluginCenter DOM 交互：抽屉根据 primaryTarget.pluginId 展开，关闭时调用 openTarget({ kind: "plugins" })', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const closedTarget: unknown[] = []
  const store = makeTestStore({
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins', pluginId: 'builtin:workflow' },
  })
  spyOpenTarget(store, closedTarget)

  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
  })

  // 验证抽屉处于展开态
  const drawer = host.querySelector('.primary-drawer-content')
  assert.ok(drawer, 'PluginDetailDrawer 应展开')

  // 验证抽屉显示选中的插件名称
  const title = drawer.querySelector('.primary-drawer-title')
  assert.match(title?.textContent ?? '', /工作流引擎/)

  // 点击抽屉关闭按钮
  const closeBtn = drawer.querySelector('button[aria-label="Close"]')
  assert.ok(closeBtn, '应存在抽屉关闭按钮')

  await act(async () => {
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(closedTarget.at(-1), { kind: 'plugins' }, '关闭抽屉应导航回基础插件中心')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 5. 全局导航收敛（CommandPaletteModal）
// ---------------------------------------------------------------------------

test('全局入口收敛：CommandPaletteModal 点击「打开插件中心」导航至 plugins 并关闭面板', { timeout: 60_000 }, async () => {
  const opened: unknown[] = []
  let closed = false
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const store = makeTestStore({
    activeModal: { kind: 'command-palette' },
  })
  spyOpenTarget(store, opened)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(OmniboxModal, { onClose: () => { closed = true } })))
      await flushMacrotask(0)
    })
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-idx].nav-item')).find((el) =>
      el.textContent?.includes('Open plugins center'),
    )
    assert.ok(row, '命令面板应提供「打开插件中心」入口')
    await act(async () => {
      row.click()
    })
    assert.equal(closed, true)
    assert.deepEqual(opened, [{ kind: 'plugins' }])
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('PluginCenter SSR：zh-CN locale 渲染中文标题、筛选标签与空状态文案', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const store = makeTestStore({
    locale: 'zh-CN',
    plugins: mockPlugins,
    primaryTarget: { kind: 'plugins' },
  })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(PluginCenter)))
  assert.match(html, /扩展插件中心/)
  assert.match(html, /安装插件/)
  assert.match(html, /搜索插件名称、ID、Tool 或 Action…/)
  assert.match(html, /全部/)
  assert.match(html, /应用视图/)
  assert.match(html, /已启用/)
  assert.match(html, /已停用/)
  assert.doesNotMatch(html, /Plugin Center/)

  const emptyStore = makeTestStore({
    locale: 'zh-CN',
    plugins: [],
    primaryTarget: { kind: 'plugins' },
  })
  const emptyHtml = renderToString(e(HostStoreProviders, { value: emptyStore }, e(PluginCenter)))
  assert.match(emptyHtml, /未找到匹配的插件/)
  assert.match(emptyHtml, /请尝试调整搜索关键字或切换启用状态筛选。/)
})

// ---------------------------------------------------------------------------
// 6. Core 内核能力页签、卡片、只读详情抽屉与双向导航
// ---------------------------------------------------------------------------

const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

const mockCoreActions: import('@helmx/protocol').ActionManifest[] = [
  {
    pluginId: 'core:conversations',
    id: 'search',
    description: 'Full-text FTS5 search across conversations',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['search'] },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    outputSchema: { type: 'array' },
  },
  {
    pluginId: 'core:plugins',
    id: 'list',
    description: 'List registered plugins and statuses',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['plugins', 'list'] },
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'array' },
  },
  {
    pluginId: 'builtin:workflow',
    id: 'run',
    description: 'Non-core plugin action must not leak into core tab',
    inputSchema: {},
    outputSchema: {},
  },
]

const mockCoreSkills: import('@helmx/protocol').SkillSummary[] = [
  {
    id: 'helmx-cli',
    name: 'Helmx CLI Manual',
    description: 'Host CLI guidance',
    references: ['references/cli.md'],
    managedByPlugin: 'core:host',
  },
  {
    id: 'app-builder',
    name: 'App Builder',
    description: 'Build full-stack Helmx micro-app plugins',
    references: ['references/fullstack-template.md'],
    managedByPlugin: 'core:plugins',
  },
  {
    id: 'workflow-guide',
    name: 'Workflow Guide',
    description: 'Builtin workflow plugin skill',
    references: [],
    managedByPlugin: 'builtin:workflow',
  },
]

test('PluginCenter Core 页签：消费 useCatalogActions/useSkills 分组聚合 core:* 能力与受管技能并支持筛选搜索', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const opened: unknown[] = []
  const store = makeTestStore({
    plugins: mockPlugins,
    actions: mockCoreActions,
    skills: mockCoreSkills,
    primaryTarget: { kind: 'plugins', tab: 'core' },
  })
  spyOpenTarget(store, opened)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    // 应渲染 core:conversations, core:plugins, core:host 三张内核卡片，不包含 builtin:workflow
    const cards = Array.from(host.querySelectorAll('.core-capability-card'))
    assert.deepEqual(
      cards.map((el) => el.getAttribute('data-core-owner')),
      ['core:conversations', 'core:plugins', 'core:host'],
    )
    assert.doesNotMatch(host.innerHTML, emojiRegex)

    // 筛选药丸：All(3) / Actions(2) / Managed skills(2)
    const pills = Array.from(host.querySelectorAll<HTMLButtonElement>('.tabs-pills [role="tab"]'))
    assert.equal(pills.length, 3)

    const skillsPill = pills.find((p) => p.textContent?.includes('Managed skills'))!
    await act(async () => {
      skillsPill.click()
    })
    assert.deepEqual(
      Array.from(host.querySelectorAll('.core-capability-card')).map((el) => el.getAttribute('data-core-owner')),
      ['core:plugins', 'core:host'],
    )

    const actionsPill = pills.find((p) => p.textContent?.includes('Actions'))!
    await act(async () => {
      actionsPill.click()
    })
    assert.deepEqual(
      Array.from(host.querySelectorAll('.core-capability-card')).map((el) => el.getAttribute('data-core-owner')),
      ['core:conversations', 'core:plugins'],
    )

    // 切回 All 并按受管技能关键字检索 helmx-cli -> 仅命中 core:host
    const allPill = pills.find((p) => p.textContent?.includes('All'))!
    await act(async () => {
      allPill.click()
    })
    const searchInput = host.querySelector<HTMLInputElement>('.search-box-toolbar input')!
    await act(async () => {
      typeIntoInput(searchInput, 'helmx-cli')
    })
    const filtered = Array.from(host.querySelectorAll('.core-capability-card'))
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0]?.getAttribute('data-core-owner'), 'core:host')

    // 点击卡片触发 openTarget({ kind: 'plugins', tab: 'core', coreOwner: 'core:host' })
    await act(async () => {
      filtered[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(opened.at(-1), { kind: 'plugins', tab: 'core', coreOwner: 'core:host' })
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('PluginCenter Core 只读抽屉：Action 详情双向选中、受管技能跳转到技能中心、zh-CN 零 Emoji', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const opened: unknown[] = []
  const store = makeTestStore({
    locale: 'zh-CN',
    plugins: mockPlugins,
    actions: mockCoreActions,
    skills: mockCoreSkills,
    primaryTarget: { kind: 'plugins', tab: 'core', coreOwner: 'core:plugins', coreAction: 'list' },
  })
  spyOpenTarget(store, opened)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    const drawer = host.querySelector('.primary-drawer-content')
    assert.ok(drawer, 'CoreCapabilityDetailDrawer 应展开')
    assert.match(drawer.textContent ?? '', /内核/)
    assert.match(drawer.textContent ?? '', /只读/)
    assert.match(drawer.textContent ?? '', /core:plugins\.list/)
    assert.match(drawer.textContent ?? '', /helmx plugins list/)
    assert.ok(drawer.querySelector('[data-core-action-detail="list"]'), '应高亮并展开指定的 action 契约详情')
    assert.ok(drawer.querySelector('[data-core-managed-skill="app-builder"]'), '应展示受管技能 app-builder')
    assert.doesNotMatch(drawer.innerHTML, emojiRegex)

    // 点击受管技能「在技能中心查看」-> openTarget({ kind: 'skills', skillId: 'app-builder' })
    const openSkillBtn = drawer.querySelector<HTMLButtonElement>('[data-core-open-skill="app-builder"]')
    assert.ok(openSkillBtn)
    await act(async () => {
      openSkillBtn.click()
    })
    assert.deepEqual(opened.at(-1), { kind: 'skills', skillId: 'app-builder' })
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('PluginDetailDrawer：展示插件受管技能并支持一键跳转到技能中心', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const opened: unknown[] = []
  const store = makeTestStore({
    plugins: mockPlugins,
    skills: mockCoreSkills,
    primaryTarget: { kind: 'plugins', pluginId: 'builtin:workflow' },
  })
  spyOpenTarget(store, opened)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    const skillBtn = host.querySelector<HTMLButtonElement>('[data-plugin-managed-skill="workflow-guide"]')
    assert.ok(skillBtn, 'PluginDetailDrawer 应展示属于 builtin:workflow 的受管技能')
    await act(async () => {
      skillBtn.click()
    })
    assert.deepEqual(opened.at(-1), { kind: 'skills', skillId: 'workflow-guide' })
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('PluginCenter: 顶栏页签切换（Plugins <-> Core）、动作点击选中/收起与缺失动作诊断', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const opened: unknown[] = []
  const store = makeTestStore({
    plugins: mockPlugins,
    actions: mockCoreActions,
    skills: mockCoreSkills,
    primaryTarget: { kind: 'plugins' },
  })
  spyOpenTarget(store, opened)

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(PluginCenter, { inlineDrawer: true })))
    })

    // 点击工具栏分段切换器 Core 页签 -> openTarget({ kind: 'plugins', tab: 'core' })
    const coreTabTrigger = Array.from(host.querySelectorAll<HTMLButtonElement>('.segmented-control [role="tab"]')).find(
      (btn) => btn.textContent?.includes('Core'),
    )
    assert.ok(coreTabTrigger, '应渲染 Core 顶栏页签')
    await act(async () => {
      coreTabTrigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      coreTabTrigger.click()
    })
    // Radix Tabs activates via pointerdown/click; ensure store updated when clicked
    await act(async () => {
      store.navActions.applyPrimaryTarget({ kind: 'plugins', tab: 'core', coreOwner: 'core:conversations' })
    })

    // 在 CoreCapabilityDetailDrawer 中点击 search 动作 -> 选中；再次点击 -> 收起
    const actionBtn = host.querySelector<HTMLButtonElement>('[data-core-action-item="search"] button')
    assert.ok(actionBtn)
    await act(async () => {
      actionBtn.click()
    })
    assert.deepEqual(opened.at(-1), {
      kind: 'plugins',
      tab: 'core',
      coreOwner: 'core:conversations',
      coreAction: 'search',
    })

    await act(async () => {
      actionBtn.click()
    })
    assert.deepEqual(opened.at(-1), {
      kind: 'plugins',
      tab: 'core',
      coreOwner: 'core:conversations',
    })

    // 传入不存在的 coreAction -> 显式展示警告诊断
    await act(async () => {
      store.navActions.applyPrimaryTarget({
        kind: 'plugins',
        tab: 'core',
        coreOwner: 'core:conversations',
        coreAction: 'nonexistent',
      })
    })
    assert.match(host.textContent ?? '', /core:conversations\.nonexistent/)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('PluginCenter(isSplit=true) -> SkillCenter 双向分屏导航：Core 与普通插件抽屉跳转受管技能仅替换 splitTarget 且 Hash 往返一致', { timeout: 60_000 }, async () => {
  const { PluginCenter } = await import('../src/plugins/PluginCenter.js')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const primary = { kind: 'conversation' as const, conversationId: 42 }
  const calls: Array<{ target: unknown; opts: unknown }> = []
  const store = makeTestStore({
    plugins: mockPlugins,
    actions: mockCoreActions,
    skills: mockCoreSkills,
    primaryTarget: primary,
    splitTarget: { kind: 'plugins', tab: 'core', coreOwner: 'core:plugins' },
  })
  const realOpenTarget = store.actions.openTarget
  ;(store.actions as unknown as { openTarget: typeof realOpenTarget }).openTarget = (target, opts) => {
    calls.push({ target, opts })
    realOpenTarget(target, opts)
  }

  try {
    await act(async () => {
      root.render(
        e(HostStoreProviders, { value: store }, e(PluginCenter, { isSplit: true, inlineDrawer: true })),
      )
    })

    // 1. 分屏 CoreCapabilityDetailDrawer -> 点击受管技能「在技能中心查看」仅替换 splitTarget，主屏保持不变
    const coreSkillBtn = host.querySelector<HTMLButtonElement>('[data-core-open-skill="app-builder"]')
    assert.ok(coreSkillBtn, '分屏 CoreCapabilityDetailDrawer 应渲染受管技能跳转按钮')
    await act(async () => {
      coreSkillBtn.click()
    })

    assert.deepEqual(calls.at(-1), {
      target: { kind: 'skills', skillId: 'app-builder' },
      opts: { split: true },
    })
    const afterCoreJump = store.getLocationTargetsSlice()
    assert.deepEqual(afterCoreJump.primaryTarget, primary, '分屏从 Core 抽屉跳转技能不得覆盖主屏')
    assert.deepEqual(afterCoreJump.splitTarget, { kind: 'skills', skillId: 'app-builder' })

    const coreJumpHash = formatLocationHash({
      primaryTarget: afterCoreJump.primaryTarget,
      splitTarget: afterCoreJump.splitTarget,
      drawerStack: [],
      activeModal: null,
    })
    const parsedCoreJump = parseLocationHash(coreJumpHash)
    assert.deepEqual(parsedCoreJump.primaryTarget, primary)
    assert.deepEqual(parsedCoreJump.splitTarget, { kind: 'skills', skillId: 'app-builder' })

    // 2. 分屏切换到普通插件抽屉 PluginDetailDrawer -> 点击受管技能同样仅替换 splitTarget
    await act(async () => {
      realOpenTarget({ kind: 'plugins', pluginId: 'builtin:workflow' }, { split: true })
    })

    const pluginSkillBtn = host.querySelector<HTMLButtonElement>('[data-plugin-managed-skill="workflow-guide"]')
    assert.ok(pluginSkillBtn, '分屏 PluginDetailDrawer 应渲染受管技能跳转按钮')
    await act(async () => {
      pluginSkillBtn.click()
    })

    assert.deepEqual(calls.at(-1), {
      target: { kind: 'skills', skillId: 'workflow-guide' },
      opts: { split: true },
    })
    const afterPluginJump = store.getLocationTargetsSlice()
    assert.deepEqual(afterPluginJump.primaryTarget, primary, '分屏从插件抽屉跳转技能不得覆盖主屏')
    assert.deepEqual(afterPluginJump.splitTarget, { kind: 'skills', skillId: 'workflow-guide' })

    const pluginJumpHash = formatLocationHash({
      primaryTarget: afterPluginJump.primaryTarget,
      splitTarget: afterPluginJump.splitTarget,
      drawerStack: [],
      activeModal: null,
    })
    const parsedPluginJump = parseLocationHash(pluginJumpHash)
    assert.deepEqual(parsedPluginJump.primaryTarget, primary)
    assert.deepEqual(parsedPluginJump.splitTarget, { kind: 'skills', skillId: 'workflow-guide' })

    // 3. 对照：非分屏 PluginCenter 跳转技能不携带 split 选项，更新 primaryTarget 且不污染 splitTarget
    const primaryStore = makeTestStore({
      plugins: mockPlugins,
      actions: mockCoreActions,
      skills: mockCoreSkills,
      primaryTarget: { kind: 'plugins', tab: 'core', coreOwner: 'core:plugins' },
      splitTarget: null,
    })
    const primaryCalls: Array<{ target: unknown; opts: unknown }> = []
    const realPrimaryOpen = primaryStore.actions.openTarget
    ;(primaryStore.actions as unknown as { openTarget: typeof realPrimaryOpen }).openTarget = (target, opts) => {
      primaryCalls.push({ target, opts })
      realPrimaryOpen(target, opts)
    }

    await act(async () => {
      root.render(
        e(HostStoreProviders, { value: primaryStore }, e(PluginCenter, { inlineDrawer: true })),
      )
    })
    const primarySkillBtn = host.querySelector<HTMLButtonElement>('[data-core-open-skill="app-builder"]')
    assert.ok(primarySkillBtn)
    await act(async () => {
      primarySkillBtn.click()
    })
    assert.deepEqual(primaryCalls.at(-1), {
      target: { kind: 'skills', skillId: 'app-builder' },
      opts: undefined,
    })
    assert.deepEqual(primaryStore.getLocationTargetsSlice().primaryTarget, {
      kind: 'skills',
      skillId: 'app-builder',
    })
    assert.equal(primaryStore.getLocationTargetsSlice().splitTarget, null)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
