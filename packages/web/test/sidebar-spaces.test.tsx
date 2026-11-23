/**
 * 双层导航与话题切换器交互测试（happy-dom + 真实 React 事件）：
 * - Sidebar：对话/视图空间切换、搜索过滤智能体、智能体行导航；
 * - 双层导航与单展开：仅当前目标所属智能体展开话题子列表（无折叠钮，
 *   点击智能体名称进入待命态并随之展开），切换目标自动收起原智能体。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import type { ConversationSummary, PluginUiContribution } from '@helmx/protocol'
import { spaceForTarget, type LocalePreference, type ResolvedTarget, type SidebarSpace } from '../src/lib/types.js'
import {
  getStoredSidebarConvMode,
  persistSidebarConvMode,
  SIDEBAR_CONV_MODE_STORAGE_KEY,
} from '../src/lib/theme-preferences.js'
import type { LiveState } from '../src/lib/live-state.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore, HelmxStoreActions } from '../src/lib/helmx-store.js'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// happy-dom 全局就绪后再加载 react-dom/client 与 SDK Provider 栈（静态导入会捕获注册前的 Node 全局）
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
;(globalThis as Record<string, unknown>).React = React
const { Sidebar } = await import('../src/shell/Sidebar.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')
const { ScreenHost } = await import('../src/screens/ScreenHost.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
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

const HERDR_VIEW = {
  pluginId: 'builtin:herdr',
  surface: 'sidebar.item',
  spec: { id: 'herdr', label: 'Herdr 终端', icon: 'terminal', target: 'screen:builtin:herdr/overview' },
} as const satisfies PluginUiContribution


function makeStore(): HelmxExternalStore {
  return makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理' }),
      conv({ id: 10, title: '周末计划', updatedAt: 9000 }),
      conv({ id: 11, title: '代码审查', updatedAt: 8000 }),
      conv({ id: 40, title: '重构方案', profileId: 'coder', updatedAt: 7000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    uiContributions: [HERDR_VIEW],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
}

let root: ReturnType<typeof createRoot> | null = null
const container = () => document.body.querySelector('#test-root') as HTMLElement

/** React 受控输入赋值：绕过 value tracker 才能触发 onChange。 */
function setInputValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 真实 store 订阅挂具：状态推进经 store 同步 setter（与生产 SSE/导航同一链路）。 */
function LiveSidebar({ onClose }: { onClose?: () => void }): React.ReactElement {
  return onClose ? e(Sidebar as React.ComponentType<{ onClose?: () => void }>, { onClose }) : e(Sidebar)
}

/** 空间代表目标（模拟真实 Provider 的空间回跳：views 取首个可用 screen，settings 缺省角色中心）。
 * 空间高亮由 primaryTarget 经 spaceForTarget 推导，不再有独立的 sidebarSpace 状态。 */
const SPACE_REPRESENTATIVE: Record<SidebarSpace, ResolvedTarget> = {
  conversations: { kind: 'conversation', conversationId: 1 },
  views: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
  settings: { kind: 'profiles' },
}

// 侧栏空间切换直接走真实 store.openSpace（唯一导航机制）：空间高亮由 primaryTarget 推导，
// Rail 点击到空间切换的完整链路与生产 Provider 一致。

function render(store: HelmxExternalStore, element: React.ReactElement): void {
  // 先卸载上一棵树：Popover Portal 挂在 body 上，直接重置 innerHTML 会让卸载阶段找不到节点
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = null
  }
  document.body.innerHTML = '<div id="test-root"></div>'
  root = createRoot(container())
  root.render(e(HostStoreProviders, { value: store }, element))
}



test('Sidebar 空间切换：对话空间默认渲染智能体，视图空间渲染 screen 贡献', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  const body = document.body
  assert.ok(body.querySelector('.activity-rail'), '应渲染 Activity Rail')
  assert.ok(body.textContent!.includes('个人助理'), '对话空间渲染智能体行')
  assert.ok(!body.textContent!.includes('Herdr 终端'), '默认不渲染视图空间项')

  // 切换到视图空间
  const viewsBtn = body.querySelector('button[aria-label="Views space"]') as HTMLButtonElement
  assert.ok(viewsBtn, '视图空间切换按钮存在')
  await act(async () => {
    viewsBtn.click()
  })
  assert.ok(body.textContent!.includes('Herdr 终端'), '视图空间渲染 screen 贡献')
  assert.ok(!body.textContent!.includes('个人助理'), '视图空间不渲染智能体分组')
})

test('Sidebar 设置空间：点击设置空间按钮切换列表，点击插件中心调用 openTarget', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 切到设置空间
  const settingsBtn = document.body.querySelector('button[aria-label="Settings space"]') as HTMLButtonElement
  assert.ok(settingsBtn, '设置空间按钮存在')
  await act(async () => {
    settingsBtn.click()
  })
  assert.ok(document.body.querySelector('.settings-nav'), '设置空间渲染系统中心列表')

  // 点击插件中心列表项（行主体 nav-item-main）
  const items = [...document.body.querySelectorAll('.settings-nav-item .nav-item-main')] as HTMLButtonElement[]
  const pluginsItem = items.find((el) => el.textContent!.includes('Plugin Center'))
  assert.ok(pluginsItem, '插件中心设置项存在')
  await act(async () => {
    pluginsItem!.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'plugins' })
  assert.equal(store.getSplitTarget(), null)
})

test('Sidebar 智能体搜索：默认收起筛选栏，点击开启后支持过滤智能体与话题，清空或 Esc 收起', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 默认收起筛选栏，不渲染输入框
  assert.ok(document.body.querySelector('.sidebar-search-input') === null, '默认不渲染筛选输入框')
  const filterBtn = document.body.querySelector('button[aria-label="Filter agents and topics"]') as HTMLButtonElement
  assert.ok(filterBtn, '筛选切换按钮存在')
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'false')

  // 点击筛选按钮：显示输入框并自动聚焦
  await act(async () => {
    filterBtn.click()
  })
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'true')
  const input = document.body.querySelector('.sidebar-search-input') as HTMLInputElement
  assert.ok(input, '点击筛选按钮后显示输入框')
  assert.ok(document.activeElement === input, '展开筛选栏自动聚焦输入框')

  // 1) 按智能体名称过滤：命中智能体保留，未命中智能体过滤
  await act(async () => {
    setInputValue(input, '编码')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['编码专员'],
    '仅保留命中智能体行',
  )
  assert.ok(document.body.querySelector('.agent-conversations-list')?.textContent?.includes('重构方案'), '搜索时自动展开命中智能体话题')

  // 命中智能体点击行主体进入待命态（名称是稳定入口，首次发送才落库）
  const row = document.body.querySelector('.agent-standing .nav-item-main') as HTMLButtonElement
  await act(async () => {
    row.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })

  // 2) 按会话标题关键词过滤：自动展开所属智能体并仅渲染命中子会话
  await act(async () => {
    setInputValue(input, '周末')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['个人助理'],
  )
  assert.deepEqual(
    [...document.body.querySelectorAll('.nav-item-sub .nav-item-label')].map((el) => el.textContent),
    ['周末计划'],
    '按话题标题过滤仅显示命中的子会话',
  )

  // 3) 按 #id 过滤非当前智能体下会话：自动展开对应智能体并精确定位命中子会话
  await act(async () => {
    setInputValue(input, '#40')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['编码专员'],
  )
  assert.deepEqual(
    [...document.body.querySelectorAll('.nav-item-sub .nav-item-label')].map((el) => el.textContent),
    ['重构方案'],
    '按 #id 过滤自动展开并仅显示命中子会话',
  )

  // 4) 点击清空按钮：清空输入并保持聚焦与恢复全量智能体
  const clearBtn = document.body.querySelector('button.sidebar-search-clear') as HTMLButtonElement
  assert.ok(clearBtn, '有关键词时显示清空按钮')
  await act(async () => {
    clearBtn.click()
  })
  assert.equal(input.value, '', '点击清空按钮清空关键词')
  assert.ok(document.body.querySelector('.sidebar-search-input'), '清空后筛选框保持展开')
  assert.ok(document.activeElement === input, '清空后输入框保持聚焦')
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['个人助理', '编码专员'],
  )

  // 5) 无匹配空态与 Esc 两段式清空/收起
  await act(async () => {
    setInputValue(input, '毫无匹配的关键词')
  })
  assert.equal(document.body.querySelector('.sidebar-search-empty')?.textContent, 'No matching agents or topics')

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.equal(input.value, '', '首次按 Esc 先清空筛选关键词')
  assert.ok(document.body.querySelector('.sidebar-search-input'), '首次按 Esc 仍保留输入框')

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.ok(document.body.querySelector('.sidebar-search-input') === null, '空输入下再按 Esc 收起筛选栏')
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'false')
})

test('Sidebar 手风琴单展开：仅当前会话所属智能体展开话题子列表，切换后自动收起', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 当前会话 #1 属于 assistant：默认仅它展开话题子列表
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅一个智能体展开话题列表')
  assert.ok(lists[0]!.textContent!.includes('周末计划'), '展开的话题列表包含当前智能体的会话')
  assert.ok(lists[0]!.textContent!.includes('个人助理'), '当前话题在列表内')

  // 点击另一个智能体（编码专员）行主体：进入其待命态（不再跳进旧会话）
  const rows = [...document.body.querySelectorAll('.agent-standing-row .nav-item-main')] as HTMLButtonElement[]
  const coderRow = rows.find((r) => r.textContent!.includes('编码专员'))!
  await act(async () => {
    coderRow.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
})

test('Sidebar 智能体行无折叠按钮：展开由当前目标唯一推导，待命亮父行/进会话亮子行', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(LiveSidebar))
  await act(async () => {})

  // 折叠展开按钮已移除：展开只跟随当前目标，点击名称是唯一入口
  assert.equal(document.body.querySelectorAll('.agent-collapse-btn').length, 0, '不渲染折叠展开按钮')
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅当前目标所属智能体展开话题列表')
  assert.ok(lists[0]!.textContent!.includes('周末计划'), '展开的是当前会话所属智能体的话题')

  // 会话态：仅当前子行 nav-item-active，父站位行呈 agent-standing-row-branch 弱态
  const header = [...document.body.querySelectorAll('.agent-standing-row')]
    .find((r) => r.textContent!.includes('个人助理'))!
  assert.ok(header.className.includes('agent-standing-row-branch'), '会话态父站位行仅呈分支弱态')
  assert.ok(!header.className.includes('nav-item-active'), '会话态父站位行不点亮激活底')
  assert.equal(header.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  const sub = document.body.querySelector('.nav-item-sub.nav-item-active')
  assert.ok(sub?.textContent!.includes('个人助理'), '会话态仅当前会话子行点亮（子）')
  assert.equal(sub?.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')

  // 待命态：仅父站位行 nav-item-active，子行均不点亮
  await act(async () => {
    store.applyPrimaryTarget({ kind: 'agent', profileId: 'assistant' })
  })
  const standbyHeader = [...document.body.querySelectorAll('.agent-standing-row')]
    .find((r) => r.textContent!.includes('个人助理'))!
  assert.ok(standbyHeader.className.includes('nav-item-active'), '待命态父站位行唯一点亮')
  assert.ok(!standbyHeader.className.includes('agent-standing-row-branch'), '待命态父行不带分支弱态')
  assert.equal(standbyHeader.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.ok(document.body.querySelector('.nav-item-sub.nav-item-active') === null, '待命态任何子行均不点亮')
})

test('Sidebar 话题列表展开随目标切换：切换后自动收起原智能体，无关更新不扰动', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(LiveSidebar))
  await act(async () => {})

  // 主屏切到另一智能体的会话：其话题列表自动展开，原智能体收起
  await act(async () => {
    store.applyPrimaryTarget({ kind: 'conversation', conversationId: 40 })
  })
  let lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅新目标所属智能体展开')
  assert.ok(lists[0]!.textContent!.includes('重构方案'), '展开的是编码专员的话题')
  assert.ok(!lists[0]!.textContent!.includes('周末计划'), '原智能体话题已收起')

  // 模拟 SSE 常规更新（conversations 引用变化、目标未变）：展开保持稳定
  await act(async () => {
    store.updateLive((prev: LiveState) => ({ ...prev, conversations: prev.conversations.map((c) => ({ ...c })) }))
  })
  lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '展开不随无关 store 更新变化')
  assert.ok(lists[0]!.textContent!.includes('重构方案'))
})

test('Sidebar 智能体平铺：0 会话智能体直接平铺可见，不收进折叠闲置区', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    conversations: [conv({ id: 1, title: '个人助理', profileId: 'assistant' })],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
      { id: 'writer', name: '写作助手' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
  render(store, e(Sidebar))
  await act(async () => {})

  assert.ok(document.body.querySelector('.sidebar-idle-group') === null, '不渲染闲置智能体折叠区')
  const labels = [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent)
  assert.deepEqual(labels, ['个人助理', '编码专员', '写作助手'], '0 会话智能体与活跃智能体稳定平铺在同一列表')
})

test('Sidebar 分屏协同展开与焦点高亮：双不同智能体均展开，主/分屏焦点切换同步高亮与主/分微标', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理' }),
      conv({ id: 10, title: '周末计划', updatedAt: 9000 }),
      conv({ id: 11, title: '代码审查', updatedAt: 8000 }),
      conv({ id: 40, title: '重构方案', profileId: 'coder', updatedAt: 7000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    uiContributions: [HERDR_VIEW],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'conversation', conversationId: 40 },
    focusedPanel: 'primary',
  })
  render(store, e(LiveSidebar))
  await act(async () => {})

  // 双不同智能体（assistant 与 coder）均展开话题列表，且站位父行均为分支弱态
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 2, '分屏打开两个不同智能体会话时双方均展开')
  const standingRows = [...document.body.querySelectorAll('.agent-standing-row')]
  assert.equal(standingRows.filter((r) => r.className.includes('agent-standing-row-branch')).length, 2)
  assert.equal(standingRows.filter((r) => r.className.includes('nav-item-active')).length, 0)

  const findConvRow = (title: string) =>
    [...document.body.querySelectorAll('.nav-item-sub')].find((el) =>
      el.querySelector('.nav-item-label')?.textContent === title,
    )!

  // 1) 主屏聚焦：会话 1 获 .nav-item-active.nav-item-focused + 「主」；会话 40 获 .nav-item-split + 「分」
  const conv1Primary = findConvRow('个人助理')
  const conv40Primary = findConvRow('重构方案')
  assert.ok(conv1Primary.className.includes('nav-item-active'))
  assert.ok(conv1Primary.className.includes('nav-item-focused'))
  assert.equal(conv1Primary.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(conv1Primary.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.ok(conv40Primary.className.includes('nav-item-split'))
  assert.ok(!conv40Primary.className.includes('nav-item-active'))
  assert.ok(!conv40Primary.className.includes('nav-item-focused'))
  assert.equal(conv40Primary.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(conv40Primary.querySelector('.nav-pane-tag')?.textContent, 'Split')

  // 2) 焦点切到分屏：会话 40 切换为 .nav-item-active.nav-item-focused，会话 1 切换为 .nav-item-split；「主」「分」微标位置不变
  await act(async () => {
    store.setFocusedPanel('split')
  })
  const conv1Split = findConvRow('个人助理')
  const conv40Split = findConvRow('重构方案')
  assert.ok(conv1Split.className.includes('nav-item-split'))
  assert.ok(!conv1Split.className.includes('nav-item-active'))
  assert.ok(!conv1Split.className.includes('nav-item-focused'))
  assert.equal(conv1Split.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.ok(conv40Split.className.includes('nav-item-active'))
  assert.ok(conv40Split.className.includes('nav-item-focused'))
  assert.equal(conv40Split.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(conv40Split.querySelector('.nav-pane-tag')?.textContent, 'Split')
})

test('Sidebar Rail 底部语言按钮紧邻主题按钮：三态菜单（auto/en/zh-CN），切换经真实 setLocalePreference 且展示随 locale', { timeout: 60_000 }, async () => {
  const prefCalls: Array<Parameters<HelmxStoreActions['setLocalePreference']>[0]> = []
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理' }),
      conv({ id: 10, title: '周末计划', updatedAt: 9000 }),
      conv({ id: 11, title: '代码审查', updatedAt: 8000 }),
      conv({ id: 40, title: '重构方案', profileId: 'coder', updatedAt: 7000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    uiContributions: [HERDR_VIEW],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    locale: 'en',
    localePreference: 'auto',
  })
  const realSetLocalePreference = store.actions.setLocalePreference
  ;(store.actions as unknown as { setLocalePreference: (pref: LocalePreference) => void }).setLocalePreference = (pref) => {
    prefCalls.push(pref)
    realSetLocalePreference(pref)
  }
  render(store, e(LiveSidebar))
  await act(async () => {})

  // 语言按钮位于 .activity-rail-footer 中紧邻 .sidebar-theme-toggle，不再放在 .sidebar-header
  const railFooter = document.body.querySelector('.activity-rail-footer')
  assert.ok(railFooter, 'Rail 底部区域应存在')
  const trigger = railFooter.querySelector('button.sidebar-locale-toggle') as HTMLButtonElement | null
  const themeBtn = railFooter.querySelector('button.sidebar-theme-toggle') as HTMLButtonElement | null
  assert.ok(trigger, 'Rail 底部应渲染语言切换按钮')
  assert.ok(themeBtn, 'Rail 底部应渲染主题切换按钮')
  assert.ok(document.body.querySelector('.sidebar-header .sidebar-locale-select') === null, '侧栏顶部不再渲染旧的语言 Select')
  assert.equal(trigger.getAttribute('aria-label'), 'Interface language')
  assert.equal(trigger.getAttribute('title'), null, 'Radix Tooltip 触发器不重复挂载原生 title')
  await act(async () => {
    trigger.focus()
  })
  assert.equal(document.body.querySelector('.helmx-tooltip-content')?.textContent, 'Interface language (Auto)')
  await act(async () => {
    trigger.blur()
  })

  // 键盘打开 Radix DropdownMenu，包含 Auto / English / 简体中文 三个选项
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
  assert.ok(items.some((el) => el.textContent?.includes('Auto')), '含 Auto 选项')
  assert.ok(items.some((el) => el.textContent?.includes('English')), '含 English 选项')
  assert.ok(items.some((el) => el.textContent?.includes('简体中文')), '含 简体中文 选项')
  const zhOption = items.find((el) => el.dataset.localeOption === 'zh-CN')
  assert.ok(zhOption, '下拉菜单中应包含 简体中文 项')

  await act(async () => {
    zhOption!.click()
  })
  assert.deepEqual(prefCalls, ['zh-CN'], '切换语言走真实 store.setLocalePreference')

  // 手动 zh-CN 生效后，触发器 Tooltip、aria-label 及侧栏文案随 locale 立即切换
  await act(async () => {
    store.setLocalePreference('zh-CN')
  })
  const triggerAfter = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.ok(triggerAfter)
  assert.equal(triggerAfter.getAttribute('aria-label'), '界面语言')
  await act(async () => {
    triggerAfter.blur()
    triggerAfter.focus()
  })
  assert.equal(document.body.querySelector('.helmx-tooltip-content')?.textContent, '界面语言 (简体中文)')
  assert.ok(document.body.textContent?.includes('会话'), '侧栏空间标题随 locale 切换为中文')

  // 切回 auto（浏览器 zh-CN 环境）：Tooltip 展示「界面语言 (自动)」——auto 经真实 resolveLocale 跟随浏览器
  const navDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages') ?? Object.getOwnPropertyDescriptor(navigator, 'languages')
  Object.defineProperty(navigator, 'languages', { value: ['zh-CN'], configurable: true })
  try {
    await act(async () => {
      store.setLocalePreference('auto')
    })
  } finally {
    if (navDesc !== undefined) Object.defineProperty(navigator, 'languages', navDesc)
    else delete (navigator as unknown as Record<string, unknown>).languages
  }
  const triggerAutoZh = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.ok(triggerAutoZh)
  await act(async () => {
    triggerAutoZh.blur()
    triggerAutoZh.focus()
  })
  assert.equal(document.body.querySelector('.helmx-tooltip-content')?.textContent, '界面语言 (自动)')
  assert.equal(store.getPrefsSlice().localePreference, 'auto')
})

test('CommandPaletteModal 与 ScreenHost 双语本地化及语言循环命令（Auto -> English -> 简体中文）', { timeout: 60_000 }, async () => {
  const prefCalls: string[] = []
  const spyLocalePreference = (store: HelmxExternalStore): void => {
    const real = store.actions.setLocalePreference
    ;(store.actions as unknown as { setLocalePreference: (pref: LocalePreference) => void }).setLocalePreference = (pref) => {
      prefCalls.push(pref)
      real(pref)
    }
  }
  const store = makeTestStore({
    locale: 'zh-CN',
    localePreference: 'auto',
    activeModal: { kind: 'command-palette' },
  })
  spyLocalePreference(store)
  render(store, e(CommandPaletteModal, { onClose: () => {} }))
  await act(async () => {})

  const dialog = document.querySelector('.modal[aria-label="命令面板与全局搜索"]')
  assert.ok(dialog, 'zh-CN 下命令面板标题与搜索框使用中文文案')
  const searchInput = dialog.querySelector('input') as HTMLInputElement
  assert.equal(searchInput.placeholder, '搜索消息正文、跳转会话或执行命令...')
  assert.ok(dialog.textContent?.includes('新建会话'), '命令条目随 locale 本地化')
  assert.ok(dialog.textContent?.includes('打开插件中心'), '导航命令条目随 locale 本地化')

  // 点击语言切换命令：auto -> en
  const langRowAuto = [...dialog.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('切换语言为 English'),
  )
  assert.ok(langRowAuto, 'auto 模式下应提供切换语言为 English 命令')
  await act(async () => { langRowAuto!.click() })
  assert.deepEqual(prefCalls, ['en'])

  // en -> zh-CN
  const storeEn = makeTestStore({
    locale: 'en',
    localePreference: 'en',
    activeModal: { kind: 'command-palette' },
  })
  spyLocalePreference(storeEn)
  render(
    storeEn,
    e(CommandPaletteModal, { onClose: () => {} }),
  )
  await act(async () => {})
  const langRowEn = [...document.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('Switch language to 简体中文'),
  )
  assert.ok(langRowEn, 'en 模式下应提供 Switch language to 简体中文 命令')
  await act(async () => { langRowEn!.click() })
  assert.deepEqual(prefCalls, ['en', 'zh-CN'])

  // zh-CN -> auto
  const storeZh = makeTestStore({
    locale: 'zh-CN',
    localePreference: 'zh-CN',
    activeModal: { kind: 'command-palette' },
  })
  spyLocalePreference(storeZh)
  render(
    storeZh,
    e(CommandPaletteModal, { onClose: () => {} }),
  )
  await act(async () => {})
  const langRowZh = [...document.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('切换语言为自动（跟随浏览器）'),
  )
  assert.ok(langRowZh, 'zh-CN 模式下应提供切换语言为自动命令')
  await act(async () => { langRowZh!.click() })
  assert.deepEqual(prefCalls, ['en', 'zh-CN', 'auto'])

  // ScreenHost 缺失视图在 zh-CN 下使用本地化文案
  render(
    makeTestStore({
      locale: 'zh-CN',
      primaryTarget: { kind: 'screen', pluginId: 'ext:missing', screenId: 'overview' },
    }),
    e(ScreenHost, { pluginId: 'ext:missing', screenId: 'overview' }),
  )
  await act(async () => {})
  assert.ok(document.body.textContent?.includes('未找到视图 ext:missing/overview'))
  assert.ok(document.body.textContent?.includes('该视图不存在或所属插件已停用（ext:missing/overview）'))
})

test('Sidebar 移动端展开未展开智能体时不关闭抽屉，再点已展开行或子会话才关闭', { timeout: 60_000 }, async () => {
  // 真实 store.openTarget 本身推进导航目标（展开/待命/进会话的真实链路）
  const store = makeStore()
  let closeCount = 0
  let shellBubbleCount = 0
  render(
    store,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) {
            shellBubbleCount += 1
          }
        },
      },
      e(LiveSidebar, {
        onClose: () => { closeCount += 1 },
      }),
    ),
  )
  await act(async () => {})

  // 1) 点击处于收起态且有历史会话的「编码专员」：展开其会话列表，但既不调用 onClose 也不冒泡到外层 .nav-item 关闭抽屉
  const coderBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.agent-standing-row .nav-item-main')]
    .find((el) => el.textContent?.includes('编码专员'))!
  await act(async () => {
    coderBtn.click()
  })
  assert.equal(closeCount, 0, '点击收起智能体展开会话列表时保持移动端抽屉打开')
  assert.equal(shellBubbleCount, 0, '不冒泡触发外层 .nav-item 关抽屉逻辑')
  assert.ok(document.body.querySelector('.agent-conversations-list')?.textContent?.includes('重构方案'), '展开后可见其会话列表')

  // 2) 点击已展开智能体下的具体子会话：导航并触发抽屉关闭
  const subBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.nav-item-sub .nav-item-main')]
    .find((el) => el.textContent?.includes('重构方案'))!
  await act(async () => {
    subBtn.click()
  })
  assert.equal(shellBubbleCount, 1, '选择具体会话后冒泡触发外层关闭抽屉')
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 40 })

  // 3) 再次点击已展开的「编码专员」本身（进入待命撰写）：触发 onClose 与关闭抽屉
  const expandedCoderBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.agent-standing-row .nav-item-main')]
    .find((el) => el.textContent?.includes('编码专员'))!
  await act(async () => {
    expandedCoderBtn.click()
  })
  assert.equal(closeCount, 1, '再次点击已展开智能体进入待命时关闭抽屉')
})

test('Sidebar 批量模式 DOM 行为：勾选框仅在会话子项，站位头部行仅切换子列表展开且不关抽屉', { timeout: 60_000 }, async () => {
  const store = makeStore()
  let shellBubbleCount = 0
  render(
    store,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) {
            shellBubbleCount += 1
          }
        },
      },
      e(HostStoreProviders, { value: store }, e(Sidebar)),
    ),
  )
  await act(async () => {})

  const bulkBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Manage conversations in bulk"]')!
  assert.ok(bulkBtn, '批量管理开关按钮存在')
  await act(async () => {
    bulkBtn.click()
  })

  const standingRows = [...document.body.querySelectorAll('.agent-standing-row')]
  assert.equal(standingRows.length, 2, '渲染两个智能体站位行')
  for (const row of standingRows) {
    assert.equal(
      row.querySelectorAll('.sidebar-batch-checkbox, [role="checkbox"], input[type="checkbox"]').length,
      0,
      '智能体站位行不得渲染任何勾选框',
    )
  }

  const subRows = [...document.body.querySelectorAll('.nav-item-sub')]
  assert.equal(subRows.length, 4, '批量模式展开全部智能体的会话子行')
  for (const sub of subRows) {
    assert.ok(sub.querySelector('.sidebar-batch-checkbox'), '每条会话子行都有批量勾选框')
  }

  // 点击第二个智能体站位行（编码专员）：仅折叠其子列表，不导航也不冒泡触发外层关抽屉
  const coderStanding = [...document.body.querySelectorAll('.agent-standing')].find((el) =>
    el.querySelector('.agent-standing-row')?.textContent?.includes('编码专员'),
  )!
  assert.ok(coderStanding.querySelector('.agent-conversations-list'), '点击前编码专员子列表已展开')
  const coderHeaderBtn = coderStanding.querySelector<HTMLButtonElement>('.agent-standing-row .nav-item-main')!
  await act(async () => {
    coderHeaderBtn.click()
  })
  assert.ok(coderStanding.querySelector('.agent-conversations-list') === null, '点击站位头部行折叠其会话子列表')
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 1 }, '批量模式下点击站位头部不触发路由跳转')
  assert.equal(shellBubbleCount, 0, '批量模式下点击站位头部不冒泡关闭抽屉')

  // 再次点击重新展开
  await act(async () => {
    coderHeaderBtn.click()
  })
  assert.ok(coderStanding.querySelector('.agent-conversations-list'), '再次点击站位头部重新展开会话子列表')
})

test('Sidebar 会话行全行命中与非模态菜单：点击行外缘/meta 区域一次直达切换，打开行菜单时点击其他会话一次切换', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 2, title: '周末计划', profileId: 'assistant', nodeId: 'remote-a' }),
      conv({ id: 3, title: '代码评审', profileId: 'assistant' }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
  render(store, e(LiveSidebar))
  await act(async () => {})

  const subRows = [...document.body.querySelectorAll<HTMLElement>('.nav-item-sub')]
  const weekendRow = subRows.find((r) => r.textContent?.includes('周末计划'))!
  const weekendMeta = weekendRow.querySelector<HTMLElement>('.nav-item-meta')!
  const weekendNodeTag = weekendRow.querySelector<HTMLElement>('.nav-item-meta .mono')!
  const weekendRowActionsWrap = weekendRow.querySelector<HTMLElement>('.nav-item-row-actions')!

  // 1) 点击行尾 meta 区域 / 节点标记 / row-actions 渐变包装层，均直接切换会话
  await act(async () => {
    weekendNodeTag.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 2 }, '点击节点标记直接切换会话')

  const reviewRow = subRows.find((r) => r.textContent?.includes('代码评审'))!
  await act(async () => {
    reviewRow.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 3 }, '点击会话行 div 外缘直接切换会话')

  await act(async () => {
    weekendRowActionsWrap.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 2 }, '点击 row-actions 渐变包装层直接切换会话')
  void weekendMeta

  // 2) 点击行尾「更多操作」菜单触发按钮打开菜单，不触发会话切换，且不锁定 body pointer-events
  const firstRowMenuBtn = subRows[0]!.querySelector<HTMLButtonElement>('.nav-item-row-actions button')!
  await act(async () => {
    firstRowMenuBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })
  assert.equal(document.querySelectorAll('[role="menuitem"]').length > 0, true, '行操作菜单已打开')
  assert.notEqual(document.body.style.pointerEvents, 'none', '非模态菜单不得阻塞页面其他区域的首次点击')
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 2 }, '打开行菜单本身不切换会话')

  // 3) 菜单展开状态下直接点击另一个会话行：一次点击同时关闭菜单并切换会话
  await act(async () => {
    reviewRow.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    reviewRow.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 3 }, '菜单打开时点击另一会话应一次切换')
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0, '切换后原菜单已关闭')

  // 4) 智能体站位行计数徽标（meta 内）同样可点击进入待命，而 "+" 按钮仅新建话题
  const assistantRow = [...document.body.querySelectorAll<HTMLElement>('.agent-standing-row')]
    .find((r) => r.textContent?.includes('个人助理'))!
  const countBadge = assistantRow.querySelector<HTMLElement>('.agent-standing-count')!
  await act(async () => {
    countBadge.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'assistant' }, '点击站位计数徽标直达待命')
})

test('Sidebar 独立折叠箭头与批量筛选全选安全：箭头折叠不导航，筛选下全选仅选可见项且过滤收窄自动裁剪', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(LiveSidebar))
  await act(async () => {})

  // 1) Independent chevron on coder expands its sub-list without changing primaryTarget
  const coderStanding = [...document.body.querySelectorAll('.agent-standing')].find((el) =>
    el.querySelector('.agent-standing-row')?.textContent?.includes('编码专员'),
  )!
  assert.ok(coderStanding.querySelector('.agent-conversations-list') === null, '初始 coder 子列表收起')
  const coderToggle = coderStanding.querySelector<HTMLButtonElement>('button.agent-standing-toggle')!
  assert.ok(coderToggle !== null, '有历史会话的智能体行提供独立折叠箭头按钮')
  assert.equal(coderToggle.getAttribute('aria-expanded'), 'false')
  await act(async () => {
    coderToggle.click()
  })
  assert.equal(coderToggle.getAttribute('aria-expanded'), 'true')
  assert.ok(coderStanding.querySelector('.agent-conversations-list') !== null, '点击折叠箭头展开子列表')
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 1 }, '点击折叠箭头不触发导航')

  await act(async () => {
    coderToggle.click()
  })
  assert.equal(coderToggle.getAttribute('aria-expanded'), 'false')
  assert.ok(coderStanding.querySelector('.agent-conversations-list') === null, '再次点击折叠箭头收起子列表')

  // 2) Filtered batch Select all only selects visible conversations (never hidden ones)
  const filterBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Filter agents and topics"]')!
  await act(async () => {
    filterBtn.click()
  })
  const searchInput = document.body.querySelector<HTMLInputElement>('.sidebar-search-input')!
  await act(async () => {
    setInputValue(searchInput, '重构')
  })
  const bulkBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Manage conversations in bulk"]')!
  await act(async () => {
    bulkBtn.click()
  })
  const selectAllBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-batch-bar button')].find((b) =>
    b.textContent?.includes('Select all'),
  )!
  assert.ok(selectAllBtn !== undefined)
  await act(async () => {
    selectAllBtn.click()
  })
  assert.match(
    document.body.querySelector('.batch-bar-count')?.textContent ?? '',
    /1 selected/,
    '筛选态全选仅选中当前可见的 1 条会话（不误选隐藏的 3 条）',
  )

  // Narrowing filter further prunes hidden selections from selectedIds
  await act(async () => {
    setInputValue(searchInput, '周末')
  })
  assert.match(
    document.body.querySelector('.batch-bar-count')?.textContent ?? '',
    /0 selected/,
    '筛选条件变化导致已选会话不可见时自动裁剪 selectedIds',
  )
})

test('Sidebar 对话模式偏好持久化：默认 agents，切 overview 写入 storage，切回 agents 清理键且异常安全降级', { timeout: 60_000 }, () => {
  const backing = new Map<string, string>()
  const fakeStorage: Storage = {
    get length() { return backing.size },
    clear: () => backing.clear(),
    key: (i) => [...backing.keys()][i] ?? null,
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { backing.set(k, v) },
    removeItem: (k) => { backing.delete(k) },
  }

  assert.equal(getStoredSidebarConvMode(fakeStorage), 'agents')
  persistSidebarConvMode('overview', fakeStorage)
  assert.equal(backing.get(SIDEBAR_CONV_MODE_STORAGE_KEY), 'overview')
  assert.equal(getStoredSidebarConvMode(fakeStorage), 'overview')

  persistSidebarConvMode('agents', fakeStorage)
  assert.equal(backing.has(SIDEBAR_CONV_MODE_STORAGE_KEY), false, 'default agents mode clears explicit key')
  assert.equal(getStoredSidebarConvMode(fakeStorage), 'agents')

  backing.set(SIDEBAR_CONV_MODE_STORAGE_KEY, 'invalid-mode')
  assert.equal(getStoredSidebarConvMode(fakeStorage), 'agents')

  const throwingStorage = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.equal(getStoredSidebarConvMode(throwingStorage), 'agents')
  assert.doesNotThrow(() => persistSidebarConvMode('overview', throwingStorage))
})

test('Sidebar 展示模式切换与总览精简列表：分段器切换、四态分节、分屏在场、后代展开、搜索防藏匿与移动端防误关', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    conversations: [
      conv({ id: 10, title: '审批主任务', profileId: 'assistant', status: 'idle', createdAt: 9000 }),
      conv({ id: 11, parentConversationId: 10, title: '待审批子代理', profileId: 'assistant', status: 'blocked', pendingAskCount: 1, pendingAskSince: Date.now() - 12_000, createdAt: 9200 }),
      conv({ id: 12, parentConversationId: 10, title: '已完成调研', profileId: 'assistant', status: 'idle', createdAt: 9100 }),
      conv({ id: 20, title: '远程重构中', profileId: 'coder', nodeId: 'gpu-1', status: 'working', doing: '执行类型检查', runStartedAt: Date.now() - 35_000, createdAt: 8000 }),
      conv({ id: 30, title: '未读汇报', profileId: 'assistant', status: 'done', unread: true, runDurationMs: 95_000, createdAt: 7000 }),
      conv({ id: 40, title: '历史安静话题', profileId: 'coder', status: 'idle', runDurationMs: 120_000, createdAt: 6000 }),
      conv({ id: 41, parentConversationId: 40, title: '安静历史子会话', profileId: 'coder', status: 'idle', createdAt: 6100 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 20 },
    splitTarget: { kind: 'conversation', conversationId: 11 },
    focusedPanel: 'primary',
  })

  let closeCount = 0
  let shellBubbleCount = 0
  try {
    render(
      store,
      e(
        'div',
        {
          onClick: (event: React.MouseEvent<HTMLDivElement>) => {
            if ((event.target as HTMLElement).closest('.nav-item')) {
              shellBubbleCount += 1
            }
          },
        },
        e(LiveSidebar, {
          onClose: () => { closeCount += 1 },
        }),
      ),
    )
    await act(async () => {})

    // 1) 默认处于「智能体」模式，顶部呈现双模式分段器
    const modeSwitch = document.body.querySelector('.sidebar-conv-mode-switch')
    assert.ok(modeSwitch !== null, '应渲染展示模式分段切换器')
    assert.ok(document.body.querySelector('.agent-standing-group') !== null, '默认渲染智能体站位列表')
    assert.ok(document.body.querySelector('.sidebar-overview-group') === null)

    // 2) 点击切到「总览」模式：立即渲染四态分节并写入 localStorage
    const overviewTab = [...modeSwitch.querySelectorAll<HTMLButtonElement>('button')].find((btn) =>
      btn.textContent?.includes('总览'),
    )!
    assert.ok(overviewTab !== undefined)
    await act(async () => {
      overviewTab.click()
    })
    assert.equal(store.getPrefsSlice().sidebarConvMode, 'overview')
    assert.equal(localStorage.getItem(SIDEBAR_CONV_MODE_STORAGE_KEY), 'overview')
    assert.ok(document.body.querySelector('.sidebar-overview-group') !== null, '切换到侧栏精简总览列表')
    assert.ok(document.body.querySelector('.agent-standing-group') === null)

    // 校验四态分节顺序：需处理 -> 进行中 -> 未读完成 -> 近期安静
    const sectionTitles = [...document.body.querySelectorAll('.sidebar-overview-section-title')].map((el) => el.textContent)
    assert.deepEqual(sectionTitles, ['需处理', '进行中', '未读完成', '近期安静'])

    // 校验窄栏信息密度：不渲染已完成/安静会话的静态累计耗时，保留角色/@节点/运行摘要
    assert.ok(!document.body.textContent!.includes('累计'), '窄栏精简总览不展示静态累计耗时')
    const runningItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
      el.textContent?.includes('远程重构中'),
    )!
    assert.ok(runningItem.className.includes('nav-item-active'), '主屏当前会话在侧栏总览中精准高亮')
    assert.equal(runningItem.querySelector('.nav-pane-tag')?.textContent, '主')
    assert.ok(runningItem.textContent!.includes('编码专员'))
    assert.ok(runningItem.textContent!.includes('@gpu-1'))
    assert.ok(runningItem.textContent!.includes('执行类型检查'))

    // 3) 待审批子会话 #11 自动浮现在父项 #10 下方：父项呈分支弱态且可点击回到根 #10，子行呈现分屏微标
    const waitingRootItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
      el.textContent?.includes('审批主任务'),
    )!
    assert.ok(waitingRootItem.className.includes('sidebar-overview-item-branch'), '分屏查看子会话时父项呈弱归属态')
    const descendantRows = [...document.body.querySelectorAll('.sidebar-overview-descendant')]
    assert.equal(descendantRows.length, 1, '默认仅自动浮现活跃/待审批子会话 #11，安静后代收拢')
    assert.ok(descendantRows[0]!.textContent!.includes('待审批子代理'))
    assert.ok(descendantRows[0]!.className.includes('nav-item-split'))
    assert.equal(descendantRows[0]!.querySelector('.nav-pane-tag')?.textContent, '分')

    // 点击父项 #10：因审批子会话已作为子行可见，父项打开根会话 #10，且正常触发导航与关闭移动端抽屉
    await act(async () => {
      waitingRootItem.querySelector<HTMLButtonElement>('.sidebar-overview-open')!.click()
    })
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 10 })
    assert.equal(closeCount, 1)
    assert.equal(shellBubbleCount, 1)

    // 4) 点击安静树的紧凑子会话展开开关：展开安静子会话 #41，且不触发导航、不冒泡关移动端抽屉
    const quietItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
      el.textContent?.includes('历史安静话题'),
    )!
    const descToggleBtn = quietItem.querySelector<HTMLButtonElement>('button.sidebar-overview-desc-toggle')!
    assert.ok(descToggleBtn !== null, '含安静子会话的条目渲染紧凑展开按钮')
    await act(async () => {
      descToggleBtn.click()
    })
    assert.equal(closeCount, 1, '展开子会话不得关闭移动端抽屉')
    assert.equal(shellBubbleCount, 1, '展开子会话不得冒泡到外层 .nav-item')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 10 }, '展开子会话不切换当前会话')
    assert.ok(document.body.textContent!.includes('安静历史子会话'), '展开后渲染安静子会话行')

    // 点击展开出的子会话 #41：直达该子会话并关闭抽屉
    const quietSubBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-overview-descendant .nav-item-main')].find((el) =>
      el.textContent?.includes('安静历史子会话'),
    )!
    await act(async () => {
      quietSubBtn.click()
    })
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 41 })
    assert.equal(closeCount, 2)

    // 5) 折叠「近期安静」分节，再搜索「历史安静话题」：搜索防藏匿自动临时展开；清空后恢复原折叠态
    const quietSectionToggle = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-overview-section-toggle')].find((el) =>
      el.textContent?.includes('近期安静'),
    )!
    await act(async () => {
      quietSectionToggle.click()
    })
    assert.equal(quietSectionToggle.getAttribute('aria-expanded'), 'false')
    assert.ok(!document.body.textContent!.includes('历史安静话题'), '折叠后该分节内条目隐藏')

    const filterBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="筛选会话"]')!
    await act(async () => {
      filterBtn.click()
    })
    const input = document.body.querySelector<HTMLInputElement>('.sidebar-search-input')!
    await act(async () => {
      setInputValue(input, '历史安静')
    })
    assert.ok(document.body.textContent!.includes('历史安静话题'), '搜索激活时临时展开已折叠的命中分节')

    await act(async () => {
      setInputValue(input, '')
    })
    assert.ok(!document.body.textContent!.includes('历史安静话题'), '清空搜索后无损恢复原折叠态')

    // 6) 批量模式：已折叠分节内的条目不计入全选；勾选不关移动端抽屉；切回智能体模式自动清理
    const bulkBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="批量管理会话"]')!
    await act(async () => {
      bulkBtn.click()
    })
    const selectAllBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-batch-bar button')].find((b) =>
      b.textContent?.includes('全选'),
    )!
    await act(async () => {
      selectAllBtn.click()
    })
    assert.match(
      document.body.querySelector('.batch-bar-count')?.textContent ?? '',
      /已选择 3 项/,
      '折叠分节内的第 4 棵树绝不进入批量全选集合',
    )

    // 点击批量模式下的会话主项：只切换勾选，不冒泡关抽屉也不切换当前会话
    const prevBubble = shellBubbleCount
    const prevClose = closeCount
    const runningBtnInBatch = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-overview-open')].find((el) =>
      el.textContent?.includes('远程重构中'),
    )!
    await act(async () => {
      runningBtnInBatch.click()
    })
    assert.equal(shellBubbleCount, prevBubble, '批量勾选不得冒泡关闭移动端抽屉')
    assert.equal(closeCount, prevClose)
    assert.match(document.body.querySelector('.batch-bar-count')?.textContent ?? '', /已选择 2 项/)

    // 切回「智能体」模式：清理 localStorage 键并恢复智能体站位视图
    const agentsTab = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-conv-mode-switch button')].find((btn) =>
      btn.textContent?.includes('智能体'),
    )!
    await act(async () => {
      agentsTab.click()
    })
    assert.equal(store.getPrefsSlice().sidebarConvMode, 'agents')
    assert.equal(localStorage.getItem(SIDEBAR_CONV_MODE_STORAGE_KEY), null)
    assert.ok(document.body.querySelector('.agent-standing-group') !== null)
    assert.ok(document.body.querySelector('.sidebar-batch-bar') === null, '切模式后批量状态自然卸除')
  } finally {
    localStorage.removeItem(SIDEBAR_CONV_MODE_STORAGE_KEY)
  }
})

test('Sidebar 总览模式空态与新话题入口：0 活跃会话展示温和空态与单候选新话题直进待命', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    sidebarConvMode: 'overview',
    conversations: [],
    profiles: [{ id: 'assistant', name: '个人助理' }],
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
  })
  let closeCount = 0
  render(store, e(LiveSidebar, { onClose: () => { closeCount += 1 } }))
  await act(async () => {})

  assert.ok(document.body.querySelector('.sidebar-overview-empty') !== null, '0 活跃会话渲染空态')
  assert.ok(document.body.textContent!.includes('暂无活跃会话'))
  const newTopicBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-overview-empty-action')!
  assert.ok(newTopicBtn !== null, '空态提供快捷新话题按钮')
  await act(async () => {
    newTopicBtn.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'assistant' })
  assert.equal(closeCount, 1)
})
