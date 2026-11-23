/**
 * 侧栏空间切换、工作集快速切换与双语交互测试（happy-dom + 真实 React 事件）：
 * - Activity Rail 对话/视图/设置三空间切换与总览空间归属；
 * - 顶置「会话总览」行（带同源态势计数徽标与分屏微标）与常驻「新话题」行（单/多角色、移动端防误关）；
 * - 工作集：活跃全量 + 近期截断（SIDEBAR_RECENT_QUIET_LIMIT）+ 在场保底 + 底部「查看全部」；
 * - 侧栏搜索：突破近期上限、搜索防藏匿自动展开分节与命中后代、Esc 两段清空/收起、带 ?sp.q 跳转总览；
 * - 行命中范围、非模态行菜单、后代展开移动端防误关、分屏焦点同步与 Rail 语言切换。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import type { ConversationSummary, PluginUiContribution } from '@helmx/protocol'
import type { LocalePreference } from '../src/lib/types.js'
import { SIDEBAR_GROUP_BY_STORAGE_KEY, SIDEBAR_RECENT_QUIET_LIMIT } from '../src/overview/overview-model.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore, HelmxStoreActions } from '../src/lib/helmx-store.js'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
      conv({ id: 1, title: '个人助理', updatedAt: 10_000 }),
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

function setInputValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function LiveSidebar({ onClose }: { onClose?: () => void }): React.ReactElement {
  return onClose ? e(Sidebar as React.ComponentType<{ onClose?: () => void }>, { onClose }) : e(Sidebar)
}

function render(store: HelmxExternalStore, element: React.ReactElement): void {
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

test('Sidebar 空间切换：对话空间渲染顶置总览与工作集，视图/设置空间各自独立渲染且记住总览目标', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(LiveSidebar))
  await act(async () => {})

  const body = document.body
  assert.ok(body.querySelector('.activity-rail'), '应渲染 Activity Rail')
  assert.ok(body.querySelector('.sidebar-overview-entry'), '对话空间置顶渲染会话总览入口')
  assert.ok(body.querySelector('.sidebar-overview-group'), '对话空间渲染工作集')
  assert.ok(!body.textContent!.includes('Herdr 终端'), '默认不渲染视图空间项')

  // 点顶置总览行进入 #/overview，对话空间 Rail 按钮保持激活高亮
  await act(async () => {
    body.querySelector<HTMLButtonElement>('.sidebar-overview-entry .nav-item-main')!.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'overview' })
  const convSpaceBtn = body.querySelector<HTMLButtonElement>('button[aria-label="Conversations space"]')!
  assert.ok(convSpaceBtn.classList.contains('rail-btn-active'), '主屏停总览时对话空间图标保持高亮')

  // 切换到视图空间
  const viewsBtn = body.querySelector('button[aria-label="Views space"]') as HTMLButtonElement
  await act(async () => {
    viewsBtn.click()
  })
  assert.ok(body.textContent!.includes('Herdr 终端'), '视图空间渲染 screen 贡献')
  assert.ok(body.querySelector('.sidebar-overview-group') === null, '视图空间不渲染工作集')

  // 再切回对话空间：直接回到刚才停留的 #/overview
  await act(async () => {
    convSpaceBtn.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'overview' }, '从视图切回对话空间恢复总览记忆')
})

test('Sidebar 设置空间：点击设置空间按钮切换列表，点击插件中心调用 openTarget', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  const settingsBtn = document.body.querySelector('button[aria-label="Settings space"]') as HTMLButtonElement
  await act(async () => {
    settingsBtn.click()
  })
  assert.ok(document.body.querySelector('.settings-nav'), '设置空间渲染系统中心列表')

  const items = [...document.body.querySelectorAll('.settings-nav-item .nav-item-main')] as HTMLButtonElement[]
  const pluginsItem = items.find((el) => el.textContent!.includes('Plugin Center'))
  assert.ok(pluginsItem, '插件中心设置项存在')
  await act(async () => {
    pluginsItem!.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'plugins' })
  assert.equal(store.getSplitTarget(), null)
})

test('Sidebar 工作集截断、在场保底、近期排序与全量搜索透传至总览', { timeout: 60_000 }, async () => {
  const quietConvs = Array.from({ length: SIDEBAR_RECENT_QUIET_LIMIT + 3 }, (_, idx) => {
    const id = idx + 100
    return conv({
      id,
      title: `历史会话 ${id}`,
      profileId: idx === 0 ? 'coder' : 'assistant',
      createdAt: id * 1000,
      updatedAt: id * 1000,
    })
  })
  // 让最老的 #100 被主屏打开（应保底出现在工作集内）
  const store = makeTestStore({
    locale: 'zh-CN',
    conversations: [
      conv({ id: 1, title: '正在跑的任务', status: 'working', doing: '跑测试', createdAt: 500, updatedAt: 500 }),
      ...quietConvs,
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 100 },
  })
  let closeCount = 0
  render(store, e(LiveSidebar, { onClose: () => { closeCount += 1 } }))
  await act(async () => {})

  // 默认工作集：1 条进行中 + 8 条最新近期 + 1 条在场保底(#100) = 10 条（省略 2 条安静会话）
  assert.equal(document.body.querySelectorAll('.sidebar-overview-item').length, 10)
  assert.ok(document.body.textContent!.includes('历史会话 100'), '主屏正在查看的超限安静会话保底显示')
  assert.ok(!document.body.textContent!.includes('历史会话 101'), '超出近期上限且未打开的旧会话被省略')

  // 底部「查看全部 12 个会话」直达 #/overview
  const viewAllBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-view-all-btn')
  assert.ok(viewAllBtn !== null && viewAllBtn.textContent!.includes('查看全部 12 个会话'))

  // 开启搜索：突破 8 条上限命中被省略的 #101，且底部切换为「在会话总览中查看匹配」携带 sp.q
  const filterBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="筛选会话"]')!
  await act(async () => {
    filterBtn.click()
  })
  const input = document.body.querySelector<HTMLInputElement>('.sidebar-search-input')!
  assert.ok(document.activeElement === input, '展开筛选栏自动聚焦输入框')

  await act(async () => {
    setInputValue(input, '历史会话 101')
  })
  assert.ok(document.body.textContent!.includes('历史会话 101'), '搜索突破近期上限命中全部未归档会话')

  const openMatchesBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-view-all-btn')!
  assert.ok(openMatchesBtn.textContent!.includes('在会话总览中查看匹配'))
  await act(async () => {
    openMatchesBtn.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'overview', params: { q: '历史会话 101' } })
  assert.equal(closeCount, 1)

  // Esc 两段式清空/收起
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.equal(input.value, '', '首次按 Esc 先清空关键词')
  assert.ok(document.body.querySelector('.sidebar-search-input') !== null)
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.ok(document.body.querySelector('.sidebar-search-input') === null, '空输入再按 Esc 收起筛选框')
})

test('Sidebar 顶置新话题入口：单角色直进待命；多角色下拉不误关移动端抽屉，选角后进待命并关闭', { timeout: 60_000 }, async () => {
  // 1) 单角色：直点进待命页并调用 onClose
  const singleStore = makeTestStore({
    locale: 'zh-CN',
    conversations: [],
    profiles: [{ id: 'assistant', name: '个人助理' }],
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
  })
  let closeCount = 0
  render(singleStore, e(LiveSidebar, { onClose: () => { closeCount += 1 } }))
  await act(async () => {})

  assert.ok(document.body.querySelector('.sidebar-overview-empty') !== null, '0 会话渲染温和空态')
  const singleBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-new-topic-btn')!
  assert.ok(singleBtn.classList.contains('is-active'), '停在待命页时新话题入口高亮')
  await act(async () => {
    singleBtn.click()
  })
  assert.deepEqual(singleStore.getPrimaryTarget(), { kind: 'agent', profileId: 'assistant' })
  assert.equal(closeCount, 1)

  // 2) 多角色：打开下拉不冒泡到外层 .nav-item 关闭抽屉，选具体角色才导航并关闭
  const multiStore = makeStore()
  let multiClose = 0
  let navBubble = 0
  render(
    multiStore,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) navBubble += 1
        },
      },
      e(LiveSidebar, { onClose: () => { multiClose += 1 } }),
    ),
  )
  await act(async () => {})

  const trigger = document.body.querySelector<HTMLButtonElement>('.sidebar-new-topic-btn')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    trigger.click()
  })
  assert.equal(navBubble, 0, '多角色新话题按钮不挂 .nav-item，打开菜单不误关移动端抽屉')
  assert.equal(multiClose, 0)

  const coderItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('编码专员'))!
  assert.ok(coderItem !== undefined, '下拉菜单展示可用角色')
  await act(async () => {
    coderItem.click()
  })
  assert.deepEqual(multiStore.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
  assert.equal(multiClose, 1)
})

test('Sidebar 工作集态势分节、分屏焦点、后代展开、搜索防藏匿与移动端防误关', { timeout: 60_000 }, async () => {
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
  render(
    store,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) shellBubbleCount += 1
        },
      },
      e(LiveSidebar, { onClose: () => { closeCount += 1 } }),
    ),
  )
  await act(async () => {})

  // 四态分节顺序：需处理 -> 进行中 -> 未读完成 -> 近期（非搜索态安静区标题为「近期」）
  const sectionTitles = [...document.body.querySelectorAll('.sidebar-overview-section-title')].map((el) => el.textContent)
  assert.deepEqual(sectionTitles, ['需处理', '进行中', '未读完成', '近期'])
  assert.ok(!document.body.textContent!.includes('累计'), '窄栏工作集不展示静态累计耗时')

  // 主屏当前会话高亮 + 焦点的「主」微标
  const runningItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
    el.textContent?.includes('远程重构中'),
  )!
  assert.ok(runningItem.className.includes('nav-item-active'))
  assert.ok(runningItem.className.includes('nav-item-focused'))
  assert.equal(runningItem.querySelector('.nav-pane-tag')?.textContent, '主')
  assert.ok(runningItem.textContent!.includes('编码专员'))
  assert.ok(runningItem.textContent!.includes('@gpu-1'))
  assert.ok(runningItem.textContent!.includes('执行类型检查'))

  // 待审批子会话 #11 自动浮现在父项 #10 下方
  const waitingRootItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
    el.textContent?.includes('审批主任务'),
  )!
  assert.ok(waitingRootItem.className.includes('sidebar-overview-item-branch'))
  const descendantRows = [...document.body.querySelectorAll('.sidebar-overview-descendant')]
  assert.equal(descendantRows.length, 1)
  assert.ok(descendantRows[0]!.textContent!.includes('待审批子代理'))
  assert.ok(descendantRows[0]!.className.includes('nav-item-split'))
  assert.equal(descendantRows[0]!.querySelector('.nav-pane-tag')?.textContent, '分')

  // 切焦点到分屏：子会话 #11 转为 active+focused，#20 转为 splitSecondary
  await act(async () => {
    store.setFocusedPanel('split')
  })
  assert.ok(document.body.querySelector('.sidebar-overview-descendant')!.className.includes('nav-item-active'))
  assert.ok(runningItem.className.includes('nav-item-split'))

  // 点击父项 #10：因审批子会话已可见，父项打开根会话 #10
  await act(async () => {
    waitingRootItem.querySelector<HTMLButtonElement>('.sidebar-overview-open')!.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 10 })
  assert.equal(closeCount, 1)
  assert.equal(shellBubbleCount, 1)

  // 点击安静树的紧凑子会话展开开关：展开 #41，不触发导航也不冒泡关移动端抽屉
  const quietItem = [...document.body.querySelectorAll('.sidebar-overview-item')].find((el) =>
    el.textContent?.includes('历史安静话题'),
  )!
  const descToggleBtn = quietItem.querySelector<HTMLButtonElement>('button.sidebar-overview-desc-toggle')!
  await act(async () => {
    descToggleBtn.click()
  })
  assert.equal(closeCount, 1)
  assert.equal(shellBubbleCount, 1)
  assert.ok(document.body.textContent!.includes('安静历史子会话'))

  // 点击展开出的子会话 #41：直达该子会话并关闭抽屉
  const quietSubBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-overview-descendant .nav-item-main')].find((el) =>
    el.textContent?.includes('安静历史子会话'),
  )!
  await act(async () => {
    quietSubBtn.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 41 })
  assert.equal(closeCount, 2)

  // 折叠「近期」分节，再搜索「历史安静」：搜索防藏匿自动临时展开；清空后恢复折叠态
  const quietSectionToggle = [...document.body.querySelectorAll<HTMLButtonElement>('.sidebar-overview-section-toggle')].find((el) =>
    el.textContent?.includes('近期'),
  )!
  await act(async () => {
    quietSectionToggle.click()
  })
  assert.equal(quietSectionToggle.getAttribute('aria-expanded'), 'false')
  assert.ok(!document.body.textContent!.includes('历史安静话题'))

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
})

test('Sidebar 会话行全行命中与非模态菜单：点击行外缘/meta 一次直达切换，打开行菜单时点击其他会话一次切换', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant', updatedAt: 3000 }),
      conv({ id: 2, title: '周末计划', profileId: 'assistant', nodeId: 'remote-a', updatedAt: 2000 }),
      conv({ id: 3, title: '代码评审', profileId: 'assistant', updatedAt: 1000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
  render(store, e(LiveSidebar))
  await act(async () => {})

  const rows = [...document.body.querySelectorAll<HTMLElement>('.sidebar-overview-item')]
  const weekendRow = rows.find((r) => r.textContent?.includes('周末计划'))!
  const weekendNodeTag = weekendRow.querySelector<HTMLElement>('.sidebar-overview-meta-node')!
  const reviewRow = rows.find((r) => r.textContent?.includes('代码评审'))!

  await act(async () => {
    weekendNodeTag.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 2 }, '点击节点标记直接切换会话')

  await act(async () => {
    reviewRow.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 3 }, '点击会话行外缘直接切换会话')

  // 打开行操作菜单不切换会话，且非模态
  const menuBtn = rows[0]!.querySelector<HTMLButtonElement>('.nav-item-row-actions button')!
  await act(async () => {
    menuBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  })
  assert.equal(document.querySelectorAll('[role="menuitem"]').length > 0, true)
  assert.notEqual(document.body.style.pointerEvents, 'none')
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 3 })

  // 菜单打开状态下点击其他会话一次完成关闭与切换
  await act(async () => {
    weekendRow.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    weekendRow.click()
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 2 })
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0)
})

test('Sidebar Rail 底部语言按钮紧邻主题按钮：三态菜单（auto/en/zh-CN），切换经真实 setLocalePreference 且展示随 locale', { timeout: 60_000 }, async () => {
  const prefCalls: Array<Parameters<HelmxStoreActions['setLocalePreference']>[0]> = []
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理' }),
      conv({ id: 40, title: '重构方案', profileId: 'coder' }),
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

  const railFooter = document.body.querySelector('.activity-rail-footer')
  assert.ok(railFooter, 'Rail 底部区域应存在')
  const trigger = railFooter.querySelector('button.sidebar-locale-toggle') as HTMLButtonElement | null
  const themeBtn = railFooter.querySelector('button.sidebar-theme-toggle') as HTMLButtonElement | null
  assert.ok(trigger && themeBtn)
  assert.equal(trigger.getAttribute('aria-label'), 'Interface language')
  assert.equal(trigger.getAttribute('title'), null)

  await act(async () => {
    trigger.focus()
  })
  assert.equal(document.body.querySelector('.helmx-tooltip-content')?.textContent, 'Interface language (Auto)')
  await act(async () => {
    trigger.blur()
  })

  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
  const zhOption = items.find((el) => el.dataset.localeOption === 'zh-CN')
  assert.ok(zhOption)
  await act(async () => {
    zhOption!.click()
  })
  assert.deepEqual(prefCalls, ['zh-CN'])

  await act(async () => {
    store.setLocalePreference('zh-CN')
  })
  const triggerAfter = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.equal(triggerAfter?.getAttribute('aria-label'), '界面语言')
  assert.ok(document.body.textContent?.includes('会话总览'))

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
  assert.ok(dialog)
  const langRowAuto = [...dialog.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('切换语言为 English'),
  )
  assert.ok(langRowAuto)
  await act(async () => { langRowAuto!.click() })
  assert.deepEqual(prefCalls, ['en'])

  render(
    makeTestStore({
      locale: 'zh-CN',
      primaryTarget: { kind: 'screen', pluginId: 'ext:missing', screenId: 'overview' },
    }),
    e(ScreenHost, { pluginId: 'ext:missing', screenId: 'overview' }),
  )
  await act(async () => {})
  assert.ok(document.body.textContent?.includes('未找到视图 ext:missing/overview'))
})

test('Sidebar 工作集分组切换（按状态 / 按角色 / 按节点）：还原智能体空站位与独立近期上限、持久化及移动端防误关', { timeout: 60_000 }, async () => {
  window.localStorage.removeItem(SIDEBAR_GROUP_BY_STORAGE_KEY)
  try {
    // coder 有 7 条安静会话（高于单组上限 5），assistant 有 1 条较老安静会话，researcher 为 0 会话可见角色
    const coderQuiet = Array.from({ length: 7 }, (_, idx) =>
      conv({
        id: 200 + idx,
        title: `编码历史 ${idx + 1}`,
        profileId: 'coder',
        nodeId: idx === 0 ? 'gpu-1' : undefined,
        createdAt: 50_000 + idx * 1000,
        updatedAt: 50_000 + idx * 1000,
      }),
    )
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [
        conv({ id: 10, title: '助理早期话题', profileId: 'assistant', createdAt: 1000, updatedAt: 1000 }),
        ...coderQuiet,
      ],
      profiles: [
        { id: 'assistant', name: '个人助理' },
        { id: 'coder', name: '编码专员' },
        { id: 'researcher', name: '调研专员' },
      ],
      primaryTarget: { kind: 'conversation', conversationId: 206 },
    })

    let closeCount = 0
    let navBubble = 0
    render(
      store,
      e(
        'div',
        {
          onClick: (event: React.MouseEvent<HTMLDivElement>) => {
            if ((event.target as HTMLElement).closest('.nav-item')) navBubble += 1
          },
        },
        e(LiveSidebar, { onClose: () => { closeCount += 1 } }),
      ),
    )
    await act(async () => {})

    // 默认按状态：分组按钮打开菜单不冒泡到 .nav-item（防误关移动端抽屉）
    const groupTrigger = document.body.querySelector<HTMLButtonElement>('.sidebar-group-by-btn')!
    assert.ok(groupTrigger !== null)
    await act(async () => {
      groupTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
      groupTrigger.click()
    })
    assert.equal(navBubble, 0, '打开分组菜单不触发 .nav-item 关闭抽屉')

    const byProfileOption = document.querySelector<HTMLElement>('[data-group-by-option="profile"]')!
    assert.ok(byProfileOption !== null)
    await act(async () => {
      byProfileOption.click()
    })
    assert.equal(window.localStorage.getItem(SIDEBAR_GROUP_BY_STORAGE_KEY), 'profile')

    // 按角色分组：保留全部三个可见角色，包含 0 会话的「调研专员」；且高频 coder 不会挤掉 assistant
    const profileSections = [...document.body.querySelectorAll<HTMLElement>('.sidebar-overview-section-profile')]
    assert.equal(profileSections.length, 3)
    assert.ok(document.body.textContent!.includes('助理早期话题'), '按角色独立截断，高频角色不会挤掉其他角色')
    assert.ok(document.body.textContent!.includes('调研专员'), '0 会话可见角色仍保留站位')
    // coder 组内隐藏重复角色元信息，且底部查看全部透传 group=profile
    const coderSection = profileSections.find((s) => s.dataset.groupKey === 'profile:coder')!
    assert.equal(coderSection.querySelectorAll('.sidebar-overview-meta-profile').length, 0, '按角色分组时行内省略重复角色名')
    assert.equal(coderSection.querySelectorAll('.sidebar-overview-item').length, 5, '每角色组内独立保留 5 条近期会话')

    // 点 0 会话角色行直进待命页并关闭抽屉
    const emptyAgentBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-overview-section-empty-agent')!
    await act(async () => {
      emptyAgentBtn.click()
    })
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'researcher' })
    assert.equal(closeCount, 1)

    // 点非空角色组头 + 按钮直接在该角色下开新话题（不折叠分组）
    const coderNewTopicBtn = coderSection.querySelector<HTMLButtonElement>('.sidebar-section-new-topic-btn')!
    await act(async () => {
      coderNewTopicBtn.click()
    })
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
    assert.equal(closeCount, 2)

    // 底部「查看全部」透传当前分组维度到 #/overview
    const viewAllBtn = document.body.querySelector<HTMLButtonElement>('.sidebar-view-all-btn')!
    await act(async () => {
      viewAllBtn.click()
    })
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'overview', params: { group: 'profile' } })

    // 切换到按节点分组
    await act(async () => {
      groupTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
      groupTrigger.click()
    })
    const byNodeOption = document.querySelector<HTMLElement>('[data-group-by-option="node"]')!
    await act(async () => {
      byNodeOption.click()
    })
    assert.equal(window.localStorage.getItem(SIDEBAR_GROUP_BY_STORAGE_KEY), 'node')
    const nodeKeys = [...document.body.querySelectorAll<HTMLElement>('.sidebar-overview-section-node')].map(
      (s) => s.dataset.groupKey,
    )
    assert.ok(nodeKeys.includes('node:gpu-1') && nodeKeys.includes('node:local'))
    const gpuSection = document.body.querySelector<HTMLElement>('[data-group-key="node:gpu-1"]')!
    assert.equal(gpuSection.querySelectorAll('.sidebar-overview-meta-node').length, 0, '按节点分组时行内省略重复节点标签')
  } finally {
    if (root) {
      await act(async () => {
        root!.unmount()
      })
      root = null
    }
    window.localStorage.removeItem(SIDEBAR_GROUP_BY_STORAGE_KEY)
  }
})
