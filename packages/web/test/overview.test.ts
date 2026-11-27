/**
 * 会话总览（#/overview 一级看板与治理大盘）DOM 交互测试（纯模型单测已拆分至 overview-model.test.ts）：
 * - 卡片网格渲染与筛选切换、卡面/后代芯片直进主屏会话（与会话列表点击一致）、
 *   抽屉速览与右分屏收进卡片 `...` 菜单（托管卡也保留）、顶栏新话题（单候选直进 / 多候选下拉选角）、
 *   侧栏底部总览/已归档入口、Rail 无数字态势圆点、移动端快捷导航与批量管理。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary } from '@helmx/protocol'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import type { ResolvedSidebarBadge, SidebarViewItem } from '../src/shell/sidebar-model.js'
import { OVERVIEW_DESCENDANT_LIMIT } from '../src/overview/overview-model.js'
import { parseLocationHash } from '../src/lib/url-hash-model.js'
import { flushMacrotask, flushMicrotasks, waitForCondition } from './helpers/dom-harness.js'
import { makeTestStore, HelmxExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// 受控输入契约：createRoot 须在 happy-dom 注册之后动态加载（react-dom 在
// import 期绑定事件委托的全局 DOM，先于 register 静态加载会让受控输入的
// onChange 静默失效；与 ask-dock.test.tsx 同约定）。
const { createRoot } = await import('react-dom/client')

const { ConversationOverview } = await import('../src/overview/ConversationOverview.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { OVERVIEW_CARD_META_SLOT } = await import('@helmx/protocol/browser')
const { Sidebar } = await import('../src/shell/Sidebar.js')

const createdStores: HelmxExternalStore[] = []

afterEach(() => {
  while (createdStores.length > 0) {
    createdStores.pop()!.dispose()
  }
}, { timeout: 60_000 })

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

// ---------------------------------------------------------------------------
// 交互：总览渲染、筛选、抽屉直达与 Rail 入口
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function overviewStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  const store = makeTestStore({ profiles: BASE_PROFILES, ...overrides })
  createdStores.push(store)
  return store
}

function overviewScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
}

test('ConversationOverview card light matches the sidebar row verdict: idle root with background in-flight renders the hollow ring', { timeout: 60_000 }, async () => {
  // 通用统一口径回归：根 idle + 树内后台在途（workbench badge doc accent）→
  // 卡面灯位渲染空心蓝环，与侧栏会话行完全一致；在跑的后台子代理（working
  // 后代）不再以代表位身份抢占卡面灯——由芯片自带灯呈现。
  const workflowPanel = {
    pluginId: 'builtin:workflow',
    surface: 'workbench.panel' as const,
    spec: {
      id: 'runs',
      label: { en: 'Runs' },
      badge: { doc: 'run-badges', byConversationField: 'byConversation' },
    },
  }
  const store = overviewStore({
    conversations: [
      conv({ id: 5, title: '后台在跑', profileId: 'coder', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 51, parentConversationId: 5, title: '后台子代理', status: 'working', createdAt: 9100, updatedAt: 9200 }),
    ],
    primaryTarget: { kind: 'overview' },
    uiContributions: [workflowPanel],
    pluginDocs: {
      'builtin:workflow/run-badges': { byConversation: { '5': { count: 1, tone: 'accent', footerText: '1 Running' } } },
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const card = container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null, 'the tree card renders')
    assert.ok(
      card.querySelector('.overview-card-head-meta .overview-card-status-slot .status-dot-background') !== null,
      'idle root + tree background in-flight renders the hollow ring in trailing status slot (row-consistent)',
    )
    assert.ok(
      card.querySelector('.overview-card-open .status-dot') === null,
      'status light stays out of the leading .overview-card-open button',
    )
    assert.ok(
      card.querySelector('.overview-card-head .status-dot-working') === null,
      'the working background descendant no longer steals the card head light',
    )
    assert.ok(
      card.querySelector('.overview-chip .status-dot-working') !== null,
      'the background descendant chip carries its own working light',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview renders the card grid with honest facts and directly opens conversations in the main view', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 3, 'attention trees first, quiet tree last (all filter)')
    assert.ok(cards[0]!.textContent?.includes('出错的重构'), 'the needs-attention tree leads')
    // 灯位口径与侧栏行统一（根锚定）：根 #1 为 idle，卡面灯位零灯（不编造）；
    // blocked 的后代由芯片自带灯呈现，摘要如实说明等待事实。
    assert.ok(cards[0]!.querySelector('.overview-card-head .status-dot') === null, 'the idle root keeps the card head light off (row-consistent)')
    assert.ok(cards[0]!.querySelector('.overview-chip .status-dot-blocked') !== null, 'the blocked descendant chip carries its own light')
    assert.ok(cards[0]!.textContent?.includes('待审批子任务'), 'the waiting descendant renders as a chip')
    const attentionReason = cards[0]!.querySelector('.overview-card-attention')
    assert.equal(attentionReason?.textContent, 'Waiting for you')
    assert.equal(cards[0]!.querySelector('.overview-card-open')?.getAttribute('aria-describedby'), attentionReason?.id)
    assert.ok(cards[1]!.querySelector('.overview-card-head .status-dot-working') !== null, 'the working root lights the card head exactly like a sidebar row')
    assert.ok(cards[1]!.textContent?.includes('正在检索文档'), 'the running card states the real doing text')
    assert.ok(container.textContent?.includes('3 conversation groups'), 'the stats line counts visible cards')

    // 直进语义：点卡片直达 targetConversationId（树内有等待人类的后代时直达
    // 审批现场 #11），不弹抽屉、与会话列表点击完全一致。
    await act(async () => {
      ;(cards[0] as HTMLElement).click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 11 },
      'clicking the card navigates the main view straight to the waiting descendant',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'card clicks never open the conversation drawer')

    // 后代芯片直达该成员会话（同样直进主屏，不弹抽屉）。
    const chip = container.querySelector<HTMLButtonElement>('.overview-chip')
    assert.ok(chip !== null)
    await act(async () => {
      chip.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 11 },
      'the descendant chip navigates straight to the member conversation',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'chip clicks never open the conversation drawer')

    // 卡片 `...` 菜单收进速览/分屏：抽屉速览打开 conversation-drawer 模态。
    const menuTrigger = cards[0]!.querySelector<HTMLButtonElement>('.overview-card-actions button[aria-haspopup="menu"]')
    assert.ok(menuTrigger !== null, 'the card actions menu renders')
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const peekItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Peek in drawer'),
    )
    assert.ok(peekItem !== undefined, 'the menu offers the drawer peek action')
    const splitItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Open in right split'),
    )
    assert.ok(splitItem !== undefined, 'the menu offers the right-split action')
    assert.ok(
      [...document.querySelectorAll('[role="separator"]')].length > 0,
      'the prepend view actions are separated from the host archive action',
    )
    await act(async () => {
      peekItem.click()
    })
    assert.deepEqual(
      store.getDrawerStack(),
      [{ kind: 'conversation', conversationId: 11 }],
      'drawer peek opens the existing conversation drawer at the card target',
    )

    // 冲刷 Radix DropdownMenu 关闭态的 macrotask 清理，再重新展开菜单
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    // 右分屏打开：splitTarget 直达卡片目标，主屏不动。
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const splitItemAgain = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Open in right split'),
    )
    assert.ok(splitItemAgain !== undefined, 'reopening the card menu still offers the right-split action')
    await act(async () => {
      splitItemAgain.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'conversation', conversationId: 11 },
      'the right-split action opens the card target in the split pane',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview clears the unread completion light and bucket count immediately when the conversation becomes viewed', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 8, status: 'done', unread: true }),
      conv({ id: 9, status: 'done', unread: false }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const findCard = (id: number) =>
      [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) => card.textContent?.includes(`#${id}`))
    const unreadTab = () =>
      [...container.querySelectorAll<HTMLElement>('.segmented-control-btn')].find((btn) =>
        btn.textContent?.includes('Unread'),
      )
    assert.ok(findCard(8)?.querySelector('.status-dot-done'), 'unread completed card has a done light')
    assert.ok(findCard(9)?.querySelector('.status-dot-done') === null, 'read completed card has no unread light')
    assert.ok(unreadTab()?.textContent?.includes('1'), 'unread bucket pill starts at 1 before viewing')
    await act(async () => store.actions.openTarget({ kind: 'conversation', conversationId: 8 }, { split: true }))
    assert.ok(findCard(8)?.querySelector('.status-dot-done') === null, 'opening the conversation hides its light immediately before the PATCH response')
    assert.ok(unreadTab()?.textContent?.includes('0'), 'opening the conversation drops the overview unread bucket count to 0 immediately')
  } finally {
    await act(async () => root?.unmount())
    container.remove()
  }
})

test('ConversationOverview bucket filter narrows the grid (segmented control) and rides the URL hash model', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 3)
    const runningTab = [...container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.includes('Running'),
    ) as HTMLElement | undefined
    assert.ok(runningTab !== undefined, 'the segmented bucket filter renders')
    await act(async () => {
      runningTab.click()
    })
    const cards = container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 1)
    assert.ok(cards[0]!.textContent?.includes('在跑的调研'), 'only the running tree stays visible')
    // 筛选变化写入 overview 目标的 sp.* 路由参数（唯一导航模型，replace 语义）。
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { bucket: 'running' } },
      'the bucket filter persists into the overview route params',
    )
    // 切回 all：参数键删除，目标形状回到无 params 的稳定形态。
    const allTab = [...container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.startsWith('All'),
    ) as HTMLElement | undefined
    await act(async () => {
      allTab?.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview' },
      'returning to the all bucket deletes the param key (canonical shape)',
    )
    assert.equal(container.querySelectorAll('.overview-card').length, 3, 'the grid restores')

    // 浏览器后退语义（hashchange/popstate 同链路）：applyExternalLocation
    // 以地址栏为唯一事实源恢复上一组筛选参数。
    await act(async () => {
      runningTab.click()
    })
    await act(async () => {
      store.navActions.applyExternalLocation(parseLocationHash('#/overview'))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 3, 'an external back-to-unfiltered location restores the full grid')
    assert.ok(store.getNavSlice().primaryTarget.kind === 'overview', 'the nav state follows the external location')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview restores filter state from a deep-linked #/overview?sp.* location and repairs invalid params', { timeout: 60_000 }, async () => {
  // 深链/刷新恢复：主屏目标带参数挂载即按参数渲染（不闪全量再收敛）。
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'error', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview', params: { profile: 'coder' } },
  })
  const mount = await mountOverview(store)
  try {
    const cards = mount.container.querySelectorAll('.overview-card')
    assert.equal(cards.length, 2, 'the deep-linked profile filter restores without flashing the unfiltered grid')
    assert.ok(mount.container.textContent?.includes('2 of 3 conversation groups'), 'the stats line states the filtered count over the total')
    // 未知参数键一次自愈删除（replace 修正地址栏，不产生额外历史项）。
    await act(async () => {
      store.navActions.applyExternalLocation(parseLocationHash('#/overview?sp.bucket=bogus&sp.q=%E8%B0%83%E7%A0%94'))
    })
    await overviewSettle()
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { q: '调研' } },
      'the invalid bucket value is repaired away while the valid query survives',
    )
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'the surviving query keeps filtering')
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('在跑的调研'))
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview source filter: hidden when no automated trees exist; default view separates automated runs and banners automated failures', { timeout: 60_000 }, async () => {
  const regularOnly = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: regularOnly }, e(ConversationOverview)))
    })
    assert.ok(container.querySelector('[aria-label="Filter by source"]') === null, 'no automated trees: the source select stays hidden')
    assert.ok(container.querySelector('.overview-automated-banner') === null, 'no automated needs-attention: banner stays hidden')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }

  // With mixed human + automated trees (including a failed automated run):
  const mixed = overviewStore({
    conversations: [
      conv({ id: 10, title: '人类主线对话', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, title: 'Cron · morning', profileId: 'assistant', ownedBy: 'helmx', tags: ['trigger', 'cron:morning'], status: 'done', unread: true, createdAt: 9500, updatedAt: 9500 }),
      conv({ id: 12, title: 'Cron · broken', profileId: 'assistant', ownedBy: 'helmx', tags: ['trigger', 'cron:broken'], status: 'error', lastError: 'network timeout', createdAt: 9600, updatedAt: 9600 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(mixed)
  try {
    assert.ok(mount.container.querySelector('[aria-label="Filter by source"]') !== null, 'automated trees present: source switcher surfaces')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'default human view hides automated cards')
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('人类主线对话'))

    // Automated failure surfaces via a compact callout banner with one-click jump
    const banner = mount.container.querySelector('.overview-automated-banner')
    assert.ok(banner !== null, 'failed automated run renders warning banner in human view')
    const viewBtn = banner.querySelector<HTMLButtonElement>('.overview-automated-banner-btn')
    assert.ok(viewBtn !== null)
    await act(async () => {
      viewBtn.click()
    })
    assert.deepEqual(
      mixed.getNavSlice().primaryTarget,
      { kind: 'overview', params: { source: 'automated', bucket: 'needs_attention' } },
      'clicking View switches to automated needs_attention view',
    )
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1)
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('Cron · broken'))
    assert.ok(mount.container.querySelector('.overview-automated-banner') === null, 'banner hides outside human source view')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview card meta slot: contributions render with tree props; no contribution leaves zero residue', { timeout: 60_000 }, async () => {
  const received: Array<Record<string, unknown>> = []
  seedPluginClientModule('demo-desk', 'overview-meta.tsx', {
    AppOverviewCardMeta: (props: Record<string, unknown>) => {
      received.push(props)
      const root = props['rootConversation'] as { id: number }
      return e(
        'button',
        {
          type: 'button',
          className: 'app-overview-pill-stub',
          onClick: (event: React.SyntheticEvent) => {
            event.stopPropagation()
          },
        },
        `A-1 @${root.id}`,
      )
    },
  })
  const slotContribution = {
    pluginId: 'demo-desk',
    surface: 'plugin.slot' as const,
    spec: {
      id: 'overview-card-meta',
      target: OVERVIEW_CARD_META_SLOT,
      scope: { tags: ['app'] },
      client: { module: 'overview-meta.tsx', export: 'AppOverviewCardMeta' },
    },
  }
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '应用会话', profileId: 'assistant', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '子代理', status: 'idle', createdAt: 9100, updatedAt: 9100 }),
      conv({ id: 2, title: '常规会话', profileId: 'coder', status: 'idle', createdAt: 8000, updatedAt: 8000 }),
    ],
    // clientHashes 对齐 seedPluginClientModule 的 contentHash（'seeded'）：
    // PluginUiView 走内存缓存快路径，零网络请求（about:blank 下相对 URL fetch 必炸）。
    plugins: [{ id: 'demo-desk', name: 'Apps', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [], clientHashes: { 'overview-meta.tsx': 'seeded' } }],
    primaryTarget: { kind: 'overview' },
    uiContributions: [slotContribution],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    // 先验证无贡献路径：scope 不命中的常规树零渲染。
    const regularCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
      card.textContent?.includes('常规会话'),
    )
    assert.ok(regularCard?.querySelector('.overview-card-meta-slot') === null, 'an out-of-scope card mounts no slot residue')

    const appCard = [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
      card.textContent?.includes('应用会话'),
    )
    const slotHost = appCard?.querySelector<HTMLElement>('.overview-card-meta-slot') ?? null
    assert.ok(slotHost !== null, 'the meta slot mounts inside the matching card')
    const pill = slotHost.querySelector<HTMLElement>('.app-overview-pill-stub')
    assert.ok(pill !== null, 'the contribution component renders inside the slot')
    assert.ok(pill.textContent?.includes('A-1 @1'))
    const last = received.at(-1)!
    assert.equal((last['rootConversation'] as { id: number }).id, 1, 'slotProps carry the root conversation summary')
    assert.deepEqual(last['memberIds'], [1, 11], 'slotProps carry the whole-tree member ids')

    // 胶囊自身 stopPropagation：点击不误开卡片会话抽屉（外层不拦截冒泡，由贡献元素自理）。
    await act(async () => {
      pill.click()
    })
    assert.equal(store.getNavSlice().activeModal, null, 'clicking the pill does not trigger the card drawer')

    // 贡献消失（插件停用）：插槽零残留。
    await act(async () => {
      store.updateLive((state) => ({ ...state, uiContributions: [] }))
    })
    assert.ok(appCard?.querySelector('.overview-card-meta-slot') === null, 'a disabled plugin leaves no slot residue')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('Sidebar overview & rail dot contract: no topbar overview button, archived footer entry opens #/overview?sp.bucket=archived, and rail icon shows numberless status dot across spaces or when collapsed', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 50, title: '当前查看', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
      conv({ id: 60, title: '已归档历史', profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 6000, updatedAt: 6000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    assert.ok(container.querySelector('.rail-overview-btn') === null, 'the rail overview button is gone for good')
    assert.ok(container.querySelector('.sidebar-overview-entry') === null, 'the legacy top overview nav row is gone')
    assert.ok(container.querySelector('.sidebar-overview-open-btn') === null, 'topbar overview button is removed')
    assert.ok(container.querySelector('.overview-count-badge') === null, 'numeric count badge is removed')

    const archivedBtn = container.querySelector<HTMLButtonElement>('.sidebar-view-archived-btn')
    assert.ok(archivedBtn !== null, 'archived conversations footer button renders when archived human roots exist')
    assert.ok(archivedBtn.textContent?.includes('Archived conversations (1)'))
    await act(async () => {
      archivedBtn.click()
    })
    assert.deepEqual(
      store.getPrimaryTarget(),
      { kind: 'overview', params: { bucket: 'archived' } },
      'clicking archived footer entry opens #/overview?sp.bucket=archived',
    )

    // 主屏停总览时，对话空间 Rail 图标保持激活高亮（与 views / settings 同构），展开态不重复挂圆点
    const convSpaceBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Conversations space"]')
    assert.ok(convSpaceBtn?.classList.contains('rail-btn-active'), 'conversations rail button stays active on #/overview')
    assert.ok(convSpaceBtn?.querySelector('.rail-space-dot') === null, 'expanded conversations rail omits duplicate dot')

    // 切去设置空间时，对话空间 Rail 图标浮现无数字态势染色圆点，Tooltip/aria-label 保留明细
    await act(async () => {
      store.actions.openSpace('settings')
    })
    assert.equal(store.getPrimaryTarget().kind, 'profiles')
    const convRailInSettings = container.querySelector<HTMLButtonElement>('.rail-space-btn')
    const railDot = convRailInSettings?.querySelector<HTMLElement>('.attention-status-dot.rail-space-dot[data-tone="running"]') ?? null
    assert.ok(
      railDot !== null && railDot.textContent === '' && railDot.getAttribute('aria-hidden') === 'true',
      'conversations rail icon shows numberless status dot when viewing another space',
    )
    assert.ok(
      convRailInSettings?.getAttribute('aria-label')?.includes('1 running') === true,
      'attention summary rides the conversations rail aria-label when dotted',
    )

    // 再点回对话空间：从空间记忆原样恢复 #/overview?sp.bucket=archived，展开态下 Rail 圆点随之收起
    await act(async () => {
      store.actions.openSpace('conversations')
    })
    assert.deepEqual(
      store.getPrimaryTarget(),
      { kind: 'overview', params: { bucket: 'archived' } },
      'returning to conversations restores remembered #/overview target',
    )
    assert.ok(container.querySelector('.rail-space-dot') === null)

    // 桌面侧栏折叠态下停在对话空间：渲染仅折叠可见的无数字 Rail 圆点
    await act(async () => {
      store.actions.setSidebarCollapsed(true)
    })
    const collapsedDot = container.querySelector<HTMLElement>('.attention-status-dot.rail-space-dot.rail-space-dot-collapsed-only[data-tone="running"]')
    assert.ok(
      collapsedDot !== null && collapsedDot.textContent === '' && collapsedDot.getAttribute('aria-hidden') === 'true',
      'collapsed desktop sidebar surfaces the numberless conversations rail dot',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }

  // 无信号且无归档时圆点与归档按钮均不渲染
  const quiet = overviewStore({
    conversations: [conv({ id: 50, title: '安静', profileId: 'coder' })],
    primaryTarget: { kind: 'profiles' },
  })
  const html = renderToString(e(HelmxExternalStoreContext.Provider, { value: quiet }, e(Sidebar)))
  assert.ok(!html.includes('rail-overview-btn'), 'the rail overview button never renders')
  assert.ok(!html.includes('sidebar-overview-open-btn'), 'no header overview button')
  assert.ok(!html.includes('attention-status-dot'), 'no status dot without any signal')
  assert.ok(!html.includes('rail-space-dot'), 'no rail space dot without any signal')
})

// ---------------------------------------------------------------------------
// #58 修订：移动端免开汉堡一键直达（根挂载快捷导航簇）与总览数据就绪门
// ---------------------------------------------------------------------------

const { MobileQuickNav } = await import('../src/shell/MobileQuickNav.js')

function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
  })) as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

test('MobileQuickNav: plugin quickEntry only (overview badge moved to hamburger); hides when absent or already active', { timeout: 60_000 }, async () => {
  const restoreMobile = stubMatchMedia(true)
  const store = overviewStore({
    conversations: [
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 2 },
  })
  const quickEntry = {
    key: 'demo-desk/app-center',
    pluginId: 'demo-desk',
    label: 'App Center',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'demo-desk', screenId: 'app-center' } as const,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: store },
          e(MobileQuickNav, { quickEntry }),
        ),
      )
    })
    const buttons = container.querySelectorAll('.mobile-quick-btn')
    assert.equal(buttons.length, 1, 'only the plugin quickEntry renders; overview entry is merged into hamburger')
    assert.ok(buttons[0]!.getAttribute('aria-label') === 'App Center', 'the quick entry keeps the plugin-provided label')
    assert.ok(container.querySelector('.mobile-quick-overview-btn') === null, 'standalone mobile overview button is gone')

    const quickBtn = buttons[0] as HTMLElement
    await act(async () => {
      quickBtn.click()
    })
    const primary = store.getPrimaryTarget()
    assert.ok(primary.kind === 'screen' && primary.screenId === 'app-center', 'one tap enters the first quickEntry view')

    // 无 quickEntry 时整簇不渲染（零占位残留，顶栏左让位回落到 48px）
    await act(async () => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          { value: overviewStore({ primaryTarget: { kind: 'conversation', conversationId: 50 } }) },
          e(MobileQuickNav, { quickEntry: null }),
        ),
      )
    })
    assert.ok(container.querySelector('.mobile-quick-nav') === null, 'without quickEntry the cluster unmounts completely')

    // 主屏已停在 quickEntry 目标时整簇就地隐藏
    await act(async () => {
      root!.render(
        e(
          HelmxExternalStoreContext.Provider,
          {
            value: overviewStore({
              primaryTarget: { kind: 'screen', pluginId: 'demo-desk', screenId: 'app-center' },
            }),
          },
          e(MobileQuickNav, { quickEntry }),
        ),
      )
    })
    assert.ok(container.querySelector('.mobile-quick-nav') === null, 'on the quick-entry view the cluster hides')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    restoreMobile()
  }
})

test('MobileQuickNav renders nothing on desktop viewports (the collapsed rail carries the same entries)', { timeout: 60_000 }, () => {
  const restoreDesktop = stubMatchMedia(false)
  try {
    const html = renderToString(
      e(
        HelmxExternalStoreContext.Provider,
        { value: overviewStore() },
        e(MobileQuickNav, {
          quickEntry: {
            key: 'demo-desk/app-center',
            pluginId: 'demo-desk',
            label: 'App Center',
            icon: 'check-square',
            order: 5,
            target: { kind: 'screen', pluginId: 'demo-desk', screenId: 'app-center' },
          },
        }),
      ),
    )
    assert.ok(!html.includes('mobile-quick-nav'), 'desktop keeps the root chrome clean')
  } finally {
    restoreDesktop()
  }
})

test('ConversationOverview data-ready gate: loading state before the first snapshot, honest empty only when truly synced', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    // 快照未到（0 会话）且资产/SSE 未就绪：加载态，绝不伪报空。
    const loading = overviewStore({
      conversations: [],
      profilesLoaded: false,
      assetsLoaded: false,
      sseConnected: false,
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: loading }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('Loading conversations'), 'pre-snapshot renders the loading state')
    assert.ok(!container.textContent?.includes('No conversations yet'), 'never misreports unloaded as empty')

    // 资产 + SSE 双就绪且真实无会话：如实空态（区分真实空系统与筛选无命中）。
    const empty = overviewStore({
      conversations: [],
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: empty }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('No conversations yet'), 'a genuinely empty synced workspace shows the honest empty-system state')
    assert.ok(!container.textContent?.includes('Loading conversations'), 'loading never sticks once data is ready')

    // 有会话即卡片（即使 SSE 瞬时断连也保留快照，不闪加载）。
    const stale = overviewScenarioStore()
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: stale }, e(ConversationOverview)))
    })
    assert.ok(container.querySelectorAll('.overview-card').length > 0, 'cards render from the kept snapshot')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 移动端快捷导航簇徽标（sidebar.item badge：计数徽标 / 静默灯点 / 摘要 aria）
// ---------------------------------------------------------------------------

function quickNavItem(badge?: SidebarViewItem['badge']): SidebarViewItem {
  return {
    key: 'demo-desk/app-center',
    pluginId: 'demo-desk',
    label: 'App Center',
    icon: 'check-square',
    order: 5,
    target: { kind: 'screen', pluginId: 'demo-desk', screenId: 'app-center' },
    badge,
  }
}

interface QuickNavMount {
  container: HTMLDivElement
  unmount(): Promise<void>
}

async function mountQuickNav(
  item: SidebarViewItem | null,
  badge: ResolvedSidebarBadge | null,
): Promise<QuickNavMount> {
  const store = overviewStore({ conversations: [conv({ id: 50 })] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(
      e(
        HelmxExternalStoreContext.Provider,
        { value: store },
        e(MobileQuickNav, { quickEntry: item, quickEntryBadge: badge }),
      ),
    )
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

test('MobileQuickNav: numeric badge, quiet dot, summary aria-label and zero noise', { timeout: 60_000 }, async () => {
  const restore = stubMatchMedia(true)
  const mounts: QuickNavMount[] = []
  try {
    // 计数徽标：tone 上色 + 计数 + 摘要进 title/aria
    const numeric = await mountQuickNav(quickNavItem(), { count: 4, tone: 'error', dot: false, summary: '2 awaiting review · 2 blocked' })
    mounts.push(numeric)
    const numericBtn = numeric.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')
    assert.ok(numericBtn !== null, 'the mobile quick entry button renders')
    assert.equal(numericBtn.getAttribute('aria-label'), 'App Center · 2 awaiting review · 2 blocked', 'the badge summary is appended to the accessible label')
    const badgeEl = numeric.container.querySelector<HTMLElement>('.mobile-quick-badge')
    assert.ok(badgeEl !== null, 'the numeric badge renders')
    assert.equal(badgeEl.getAttribute('data-tone'), 'error')
    assert.equal(badgeEl.textContent, '4')
    assert.ok(numeric.container.querySelector('.mobile-quick-dot') === null, 'no dot alongside a count badge')

    // 99+ 上限折叠
    const capped = await mountQuickNav(quickNavItem(), { count: 120, tone: 'warn', dot: false, summary: '' })
    mounts.push(capped)
    assert.equal(capped.container.querySelector('.mobile-quick-badge')?.textContent, '99+')

    // 静默灯点：无数字、tone accent、摘要仍进 aria
    const dotted = await mountQuickNav(quickNavItem(), { count: 0, tone: 'accent', dot: true, summary: '2 running quietly' })
    mounts.push(dotted)
    assert.ok(dotted.container.querySelector('.mobile-quick-dot') !== null, 'the quiet dot renders')
    assert.equal(dotted.container.querySelector('.mobile-quick-dot')?.getAttribute('data-tone'), 'accent')
    assert.ok(dotted.container.querySelector('.mobile-quick-badge') === null, 'no count badge in dot mode')
    assert.equal(dotted.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')?.getAttribute('aria-label'), 'App Center · 2 running quietly')

    // 无信号（null）：零徽标残留，label 原样
    const silent = await mountQuickNav(quickNavItem(), null)
    mounts.push(silent)
    assert.ok(silent.container.querySelector('.mobile-quick-badge') === null && silent.container.querySelector('.mobile-quick-dot') === null, 'zero badge residue when the badge is silent')
    assert.equal(silent.container.querySelector<HTMLButtonElement>('.mobile-quick-btn')?.getAttribute('aria-label'), 'App Center')
  } finally {
    for (const mount of mounts.reverse()) await mount.unmount()
    restore()
  }
})

// ---------------------------------------------------------------------------
// 交互：批量管理（勾选/保护口径/归档/删除）、卡面操作菜单与紧凑元信息行
// ---------------------------------------------------------------------------

/** 总览批量/菜单交互的 fetch 桩：记录会话 PATCH（归档 tag）、单删 DELETE 与 bulk-delete。 */
function installConversationMutationStub(): {
  patches: Array<{ id: number; tags?: string[] }>
  deletes: number[]
  bulkDeletes: number[][]
  restore: () => void
} {
  const original = globalThis.fetch
  const patches: Array<{ id: number; tags?: string[] }> = []
  const deletes: number[] = []
  const bulkDeletes: number[][] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = /^\/api\/conversations\/(\d+)$/.exec(url)
    const method = init?.method ?? 'GET'
    if (match !== null && method === 'PATCH') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { tags?: string[] })
      patches.push({ id: Number(match[1]), tags: body.tags })
      return new Response(JSON.stringify({ id: Number(match[1]), tags: body.tags ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (match !== null && method === 'DELETE') {
      deletes.push(Number(match[1]))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url === '/api/conversations/bulk-delete' && method === 'POST') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { ids?: number[] })
      const ids = body.ids ?? []
      bulkDeletes.push(ids)
      return new Response(JSON.stringify({ deleted: ids, failures: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { patches, deletes, bulkDeletes, restore: () => { globalThis.fetch = original } }
}

async function mountOverview(store: HelmxExternalStore): Promise<{
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

async function overviewSettle(): Promise<void> {
  await flushMicrotasks()
}

/** 批量场景：常规根 x2 + helmx 托管根（在 source=all 混合视图下验证人机批量边界）。 */
function batchScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '常规根 A', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '常规根 B', profileId: 'coder', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 4, title: 'helmx 会话根', ownedBy: 'helmx', createdAt: 6000, updatedAt: 6000 }),
    ],
    primaryTarget: { kind: 'overview', params: { source: 'all' } },
  })
}

function cardById(container: HTMLElement, id: number): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
    card.textContent?.includes(`#${id}`),
  )
}

test('ConversationOverview batch mode: card click toggles selection, helmx roots stay protected, exit clears', { timeout: 60_000 }, async () => {
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    const toggle = mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')
    assert.ok(toggle !== null, 'the toolbar renders the batch toggle')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'no batch bar before entering batch mode')
    await act(async () => {
      toggle.click()
    })
    const batchBar = mount.container.querySelector('.overview-batch-bar')
    assert.ok(batchBar !== null, 'entering batch mode renders the batch bar')
    const scrollContainer = mount.container.querySelector('.overview-scroll')
    const batchWrap = mount.container.querySelector('.overview-scroll > .overview-batch-bar-wrap')
    const stage = mount.container.querySelector('.overview-scroll > .overview-sections, .overview-scroll > .overview-grid')
    assert.ok(scrollContainer !== null && batchWrap !== null && stage !== null, 'batch bar and card stage share the same scroll container')
    assert.ok(batchBar.parentElement === batchWrap, 'batch bar sits inside .overview-batch-bar-wrap for aligned outer gutters')

    const cards = [...mount.container.querySelectorAll<HTMLElement>('.overview-card')]
    assert.equal(cards.length, 3)
    for (const card of cards) {
      assert.ok(card.querySelector('.overview-card-batch-check') !== null, 'every card carries a batch checkbox')
    }
    // 勾选口径：常规根与空闲 helmx 根放开勾选（空闲 helmx 根仅参与批量删除）。
    assert.equal(cardById(mount.container, 1)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, false)
    assert.equal(cardById(mount.container, 4)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, false, 'the idle helmx root is bulk-selectable (bulk delete only)')

    // 批量模式点击卡片 = 勾选（不打开会话抽屉）
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected'), 'clicking the card selects it')
    assert.equal(store.getNavSlice().activeModal, null, 'batch clicks never open the conversation drawer')
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected') === false, 'clicking again deselects')

    // 全选覆盖可勾选卡片（常规根 A/B + 空闲 helmx 根）。
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    assert.ok(selectAll !== null)
    await act(async () => {
      selectAll!.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected'))
    assert.ok(cardById(mount.container, 2)?.classList.contains('is-selected'))
    assert.ok(cardById(mount.container, 4)?.classList.contains('is-selected'))
    assert.ok(mount.container.textContent?.includes('3 selected'), 'the bar states the honest selection count')

    // 退出批量模式：清空勾选、恢复直达语义
    const exit = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Exit')
    assert.ok(exit !== null)
    await act(async () => {
      exit!.click()
    })
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'exit removes the batch bar')
    assert.ok(mount.container.querySelector('.overview-card-batch-check') === null, 'checkboxes disappear with batch mode')
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 1 },
      'normal mode restores the direct main-view navigation',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'normal mode never opens the drawer')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview batch archive PATCHes every selected root and exits batch mode', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    const archiveBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Archive (2)')
    assert.ok(archiveBtn !== null, 'the archive button reflects the selection count')
    await act(async () => {
      archiveBtn!.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id).sort(),
      [1, 2],
      'batch archive PATCHes exactly the selected human roots',
    )
    for (const patch of stub.patches) {
      assert.ok(patch.tags?.includes(ARCHIVED_TAG), `archive PATCH for #${patch.id} appends the host archive tag`)
    }
    assert.ok(store.getNotices().some((notice) => notice.title === 'Bulk Archive completed'), 'the batch outcome lands as a notice')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'a successful batch archive exits batch mode')
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview batch delete requires confirmation and DELETEs each selected root', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    const deleteBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent?.startsWith('Delete'))
    assert.ok(deleteBtn !== null)

    // 先取消：不发起任何删除请求
    await act(async () => {
      deleteBtn!.click()
    })
    await overviewSettle()
    const dialog = document.querySelector('[role="alertdialog"]')
    assert.ok(dialog !== null, 'batch delete opens a confirmation dialog first')
    assert.ok(dialog.textContent?.includes('Delete 3 selected conversations?'), 'the confirm copy carries the count')
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Cancel')
    await act(async () => {
      cancel?.click()
    })
    await overviewSettle()
    assert.deepEqual(stub.deletes, [], 'cancelling the dialog issues no deletes')
    assert.deepEqual(stub.bulkDeletes, [], 'cancelling the dialog issues no bulk delete')

    // 确认：单次 bulk-delete 请求（含空闲 bot 根）+ 通知 + 退出批量模式
    await act(async () => {
      deleteBtn!.click()
    })
    await overviewSettle()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Delete conversation')
    assert.ok(confirm !== null)
    await act(async () => {
      confirm!.click()
    })
    await overviewSettle()
    assert.deepEqual(stub.bulkDeletes, [[1, 2, 4]], 'confirming sends exactly one bulk-delete request with every selected root')
    assert.deepEqual(stub.deletes, [], 'the bulk flow never falls back to per-conversation DELETEs')
    assert.ok(store.getNotices().some((notice) => notice.title === 'Bulk delete completed'), 'the batch delete outcome lands as a notice')
    assert.ok(mount.container.querySelector('.overview-batch-bar') === null, 'a successful batch delete exits batch mode')
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview card actions menu: archive and delete for human roots, view-only for helmx roots', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    const humanCard = cardById(mount.container, 1)
    const helmxCard = cardById(mount.container, 4)
    assert.ok(humanCard?.querySelector('.overview-card-actions button[aria-haspopup="menu"]') !== null, 'the human root card renders the "..." menu trigger')
    // helmx 根：宿主归档/删除不参与，但只读视图动作（抽屉速览/右分屏）照常提供。
    assert.ok(helmxCard?.querySelector('.overview-card-actions button[aria-haspopup="menu"]') !== null, 'the helmx root card still renders the "..." menu (view-only actions)')

    const trigger = humanCard?.querySelector<HTMLButtonElement>('.overview-card-actions button[aria-haspopup="menu"]')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await overviewSettle()
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent ?? '')
    assert.ok(items.some((label) => label.includes('Archive conversation')), 'the card menu offers archive')
    assert.ok(items.some((label) => label.includes('Delete conversation')), 'the card menu offers delete')
    const archiveItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Archive conversation'))
    await act(async () => {
      archiveItem?.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id),
      [1],
      'archiving from the card menu PATCHes that root conversation',
    )
    assert.ok(stub.patches[0]?.tags?.includes(ARCHIVED_TAG))
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

// ---------------------------------------------------------------------------
// 交互：搜索、无结果语义与清除筛选、+N 展开、卡片语义可访问性
// ---------------------------------------------------------------------------

test('ConversationOverview search box narrows by title/summary and rides the q route param with a clear button', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const input = mount.container.querySelector<HTMLInputElement>('.overview-search-box input')
    assert.ok(input !== null, 'the toolbar renders the search input')
    assert.equal(input.getAttribute('aria-label'), 'Search overview by title or summary')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3)
    // React 受控输入需绕过原生 value setter 才能触发 onChange（与 ask-dock 同法）。
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, '调研')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'the query narrows the grid')
    assert.ok(mount.container.querySelector('.overview-card')?.textContent?.includes('在跑的调研'))
    assert.ok(mount.container.textContent?.includes('1 of 3 conversation groups'), 'the stats line states visible over total')
    await waitForCondition(() => {
      const target = store.getNavSlice().primaryTarget
      return target.kind === 'overview' && target.params?.q === '调研'
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { q: '调研' } },
      'the query persists into the q route param after debounce',
    )
    const clear = mount.container.querySelector<HTMLButtonElement>('.overview-search-clear')
    assert.ok(clear !== null, 'a non-empty query renders the clear button')
    await act(async () => {
      clear.click()
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'clearing deletes the q param')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3, 'the grid restores')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview empty semantics: filtered no-match offers clear filters; a truly empty system stays distinct', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      store.actions.setScreenParams({ q: '不存在的词' }, {})
    })
    await overviewSettle()
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 0)
    assert.ok(mount.container.textContent?.includes('No conversations match'), 'the filtered empty state points at the filters')
    assert.ok(!mount.container.textContent?.includes('No conversations yet'), 'never misreports a filter miss as an empty system')
    const clearBtn = mount.container.querySelector<HTMLButtonElement>('.overview-clear-filters')
    assert.ok(clearBtn !== null, 'the clear-filters entry renders')
    assert.equal(clearBtn.textContent, 'Clear filters')
    await act(async () => {
      clearBtn.click()
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'clearing drops every filter param at once')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3, 'all trees return')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview +N more is a real entry: expanding reveals the remaining descendants in the same deterministic order', { timeout: 60_000 }, async () => {
  const conversations = [
    conv({ id: 1, title: '多子代理任务', profileId: 'assistant', status: 'working', createdAt: 9000, updatedAt: 9000 }),
    ...Array.from({ length: 7 }, (_, index) =>
      conv({ id: 11 + index, parentConversationId: 1, title: `子任务 ${index + 1}`, status: 'idle', createdAt: 9100 + index }),
    ),
  ]
  const store = overviewStore({ conversations, primaryTarget: { kind: 'overview' } })
  const mount = await mountOverview(store)
  try {
    const chips = mount.container.querySelectorAll('.overview-chip')
    assert.equal(chips.length, OVERVIEW_DESCENDANT_LIMIT, 'the collapsed card shows exactly the capped slice')
    const collapsedLabels = [...chips].map((chip) => chip.querySelector('.overview-chip-label')?.textContent ?? '')
    const more = mount.container.querySelector<HTMLButtonElement>('.overview-chip-more')
    assert.ok(more !== null, 'the +N affordance renders as a real button')
    assert.equal(more.tagName, 'BUTTON')
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    assert.equal(more.textContent, '+2 more', 'the hidden count stays honest')
    await act(async () => {
      more.click()
    })
    const expandedChips = mount.container.querySelectorAll('.overview-chip')
    assert.equal(expandedChips.length, 7, 'expanding reveals every descendant in-card')
    const expandedLabels = [...expandedChips].map((chip) => chip.querySelector('.overview-chip-label')?.textContent ?? '')
    // 折叠切片是展开列表的前缀（同一确定性排序，展开仅补齐不重排）。
    assert.deepEqual(expandedLabels.slice(0, OVERVIEW_DESCENDANT_LIMIT), collapsedLabels, 'expanding appends in the same deterministic order, never reshuffles')
    const collapse = mount.container.querySelector<HTMLButtonElement>('.overview-chip-more')
    assert.equal(collapse?.getAttribute('aria-expanded'), 'true')
    assert.equal(collapse?.textContent, 'Show less')
    const navTarget = store.getNavSlice().primaryTarget
    assert.ok(navTarget.kind === 'overview' && navTarget.params === undefined, 'expansion is card-local UI state and never enters the URL')
    await act(async () => {
      collapse?.click()
    })
    assert.equal(mount.container.querySelectorAll('.overview-chip').length, OVERVIEW_DESCENDANT_LIMIT, 'collapsing restores the capped slice')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview card semantics: #id sits left of title, status light trails like sidebar rows, keyboard focus works, and batch mode preserves status slot', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const cards = mount.container.querySelectorAll('.overview-card')
    assert.ok(cards.length === 3)
    const workingCard = [...cards].find((el) => el.textContent?.includes('在跑的调研'))
    const idleCard = [...cards].find((el) => el.textContent?.includes('安静会话'))
    assert.ok(workingCard !== undefined, 'the working-root card renders')
    assert.ok(idleCard !== undefined, 'the idle-root card renders')

    const open = workingCard.querySelector<HTMLButtonElement>('.overview-card-open')
    assert.ok(open !== null, 'the title cluster renders as a real semantic button')
    assert.equal(open.tagName, 'BUTTON')
    assert.equal(workingCard.querySelectorAll('button button').length, 0, 'no interactive control is ever nested inside another button')

    // #id 在左侧、标题在其右，且前置按钮内无状态灯。
    assert.ok(open.querySelector('.nav-status-slot, .status-dot') === null, 'leading button contains no status light')
    assert.equal(open.children.length, 2)
    assert.equal(open.children[0]?.classList.contains('overview-card-id'), true, '#id sits on the left side of the title')
    assert.equal(open.children[0]?.textContent, '#2')
    assert.equal(open.children[1]?.classList.contains('overview-card-title'), true)
    assert.equal(open.children[1]?.textContent, '在跑的调研')

    // 状态灯位于标题行右侧 .overview-card-head-meta .overview-card-status-slot，空闲卡省略指示槽。
    const workingMeta = workingCard.querySelector('.overview-card-head-meta')
    const workingSlot = workingMeta?.querySelector('.overview-card-status-slot')
    const workingLight = workingSlot?.querySelector('.status-dot-working[role="status"][aria-label]')
    assert.ok(workingLight !== null && workingLight !== undefined, 'working card renders trailing status light with readable label')
    assert.ok((workingLight.getAttribute('aria-label') ?? '').length > 0)
    assert.equal(workingMeta?.classList.contains('overview-card-head-meta-actions-only'), false)
    assert.ok(workingCard.querySelector('.overview-card-peek-btn') === null, 'standalone peek button is removed in favor of the menu')

    const idleMeta = idleCard.querySelector('.overview-card-head-meta')
    assert.ok(idleMeta !== null, 'normal-mode idle card keeps actions meta wrapper')
    assert.ok(idleMeta.querySelector('.overview-card-status-slot') === null, 'idle card omits trailing status slot')
    assert.equal(idleMeta.classList.contains('overview-card-head-meta-actions-only'), true, 'idle card marks head meta as actions-only')

    assert.equal(open.getAttribute('aria-pressed'), null, 'normal mode never fakes a pressed state')
    // 原生按钮 = 键盘契约本体（Tab 可达、Enter/Space 由浏览器激活）；
    // happy-dom 不合成按键激活，这里断言可聚焦与默认 Tab 序，点击语义另行验证。
    assert.equal(open.disabled, false, 'the semantic entry stays focusable in the default tab order')
    open.focus()
    assert.equal(document.activeElement === open, true, 'the button takes focus')
    await act(async () => {
      open.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 2 },
      'the semantic button navigates exactly like a whole-card click',
    )

    // 批量模式：隐藏 `...` 菜单，运行卡保留右侧状态灯，空闲卡省略整块 head-meta；按钮承载 aria-pressed。
    const toggle = mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')
    await act(async () => {
      toggle?.click()
    })
    const batchWorkingCard = cardById(mount.container, 2)
    const batchIdleCard = cardById(mount.container, 3)
    assert.ok(batchWorkingCard?.querySelector('.overview-card-actions') === null, 'batch mode hides card actions menu')
    assert.ok(
      batchWorkingCard?.querySelector('.overview-card-head-meta .overview-card-status-slot .status-dot-working') !== null,
      'batch mode preserves trailing status slot on active cards',
    )
    assert.ok(batchIdleCard?.querySelector('.overview-card-head-meta') === null, 'batch mode omits empty head meta on idle cards')

    const batchOpen = mount.container.querySelector<HTMLButtonElement>('.overview-card-open')
    assert.equal(batchOpen?.getAttribute('aria-pressed'), 'false', 'batch mode exposes the toggle state')
    await act(async () => {
      batchOpen?.click()
    })
    assert.equal(mount.container.querySelector<HTMLElement>('.overview-card')?.classList.contains('is-selected'), true)
    assert.equal(mount.container.querySelector<HTMLButtonElement>('.overview-card-open')?.getAttribute('aria-pressed'), 'true')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview batch boundary: selection stays within the visible selectable cards as filters change', { timeout: 60_000 }, async () => {
  const stub = installConversationMutationStub()
  const store = batchScenarioStore()
  const mount = await mountOverview(store)
  try {
    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    assert.ok(mount.container.textContent?.includes('3 selected'), 'both human roots plus the idle bot root are selected')

    const deleteBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Delete (3)')
    assert.ok(deleteBtn)
    await act(async () => deleteBtn.click())
    assert.ok(document.querySelector('[role="alertdialog"]'))

    // 收窄筛选：常规根 A 出局（assistant），选择集合立即收敛到可见项。
    await act(async () => {
      store.actions.setScreenParams({ profile: 'coder' }, {})
    })
    await overviewSettle()
    assert.ok(mount.container.textContent?.includes('1 selected'), 'hidden selections drop out immediately')
    assert.ok(document.querySelector('[role="alertdialog"]') === null, 'the old confirmation closes when its scope changes')
    assert.deepEqual(stub.deletes, [])
    assert.equal(cardById(mount.container, 2)?.classList.contains('is-selected'), true, 'the still-visible selection survives')
    const archiveBtn = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent?.startsWith('Archive'))
    assert.ok(archiveBtn?.textContent === 'Archive (1)', 'the action labels reflect the effective selection')
    await act(async () => {
      archiveBtn?.click()
    })
    await overviewSettle()
    assert.deepEqual(
      stub.patches.map((patch) => patch.id),
      [2],
      'batch archive only ever touches the visible selected card (never the hidden one)',
    )
  } finally {
    await mount.unmount()
    stub.restore()
  }
})

test('ConversationOverview compact meta line: profile, remote node and summary share one row', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({
        id: 9,
        title: '远端调研',
        profileId: 'coder',
        nodeId: 'remote-1',
        status: 'working',
        doing: 'researching docs',
        createdAt: 9000,
        updatedAt: 9000,
      }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const card = mount.container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null)
    const sub = card.querySelector<HTMLElement>('.overview-card-sub')
    assert.ok(sub !== null, 'the meta line renders')
    assert.ok(sub.textContent?.includes('编码专员'), 'the agent label rides the meta line')
    assert.ok(sub.textContent?.includes('@remote-1'), 'the remote node folds into the same line (no dedicated row)')
    assert.ok(sub.textContent?.includes('researching docs'), 'the honest summary still shares the line')
    assert.ok(mount.container.querySelector('.overview-card-node') === null, 'the old dedicated node line is gone')
    assert.equal(sub.querySelectorAll('.overview-card-sub > *').length, 5, 'profile + sep + node + sep + summary = five inline parts')
  } finally {
    await mount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 并发主入口：顶栏新话题（单候选直进 / 多候选下拉选角 / 无候选不渲染）
// ---------------------------------------------------------------------------

test('ConversationOverview new topic: the only creatable agent gets a direct standby button', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'coder', name: '编码专员' }],
    conversations: [conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', createdAt: 8000, updatedAt: 8000 })],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const btn = mount.container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    assert.ok(btn !== null, 'a single creatable agent renders the direct new-topic button')
    assert.ok(btn.getAttribute('aria-haspopup') === null, 'a single candidate never opens a dropdown')
    assert.ok(mount.container.textContent?.includes('New topic'), 'the button reuses the shared new-topic copy')
    await act(async () => {
      btn.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'agent', profileId: 'coder' },
      'clicking the button opens the agent standby (first send persists the conversation)',
    )
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview new topic: multiple agents open a dropdown with the latest-active agent first and @node suffixes', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '最近的助手会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '远端编码会话', profileId: 'coder', nodeId: 'lx', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    const trigger = mount.container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    assert.ok(trigger !== null, 'multiple creatable agents render the new-topic dropdown trigger')
    assert.ok(trigger.getAttribute('aria-haspopup') === 'menu', 'the trigger announces its menu')
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) =>
      el.closest('.helmx-dropdown-content') !== null,
    )
    assert.ok(items.length === 2, 'the dropdown lists every creatable agent')
    assert.ok(items[0]!.textContent?.includes('个人助理'), 'the latest-active root conversation owner leads the list')
    assert.ok(items[1]!.textContent?.includes('编码专员') && items[1]!.textContent?.includes('@lx'), 'the remote agent carries its @node suffix')
    await act(async () => {
      items[1]!.click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'agent', profileId: 'coder' },
      'picking an agent opens its standby page',
    )
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview new topic: no creatable agent renders no button', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'disabled-agent', name: '停用插件角色', managedByPlugin: 'ext:off' }],
    plugins: [{ id: 'ext:off', name: 'Off', version: '1.0.0', locked: false, enabled: false, hooks: [], actions: [], tools: [] }],
    conversations: [conv({ id: 4, title: 'helmx 会话根', ownedBy: 'helmx', createdAt: 6000, updatedAt: 6000 })],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    assert.ok(mount.container.querySelector('.overview-newtopic-btn') === null, 'no creatable agent: zero new-topic residue')
  } finally {
    await mount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 并发主入口：受保护卡的 `...` 菜单仍提供只读视图动作；分屏实例直进同侧
// ---------------------------------------------------------------------------

test('ConversationOverview protected card keeps the view-only menu actions (peek + right split); settled automated card allows deletion', { timeout: 60_000 }, async () => {
  // 运行中的 helmx 归属根：宿主归档/删除均不参与——菜单只剩两个只读视图动作
  // （prepend-only 分支：无分隔线、无后续宿主动作）。
  const store = overviewStore({
    conversations: [
      conv({ id: 7, title: '应用会话', profileId: 'assistant', ownedBy: 'helmx', tags: ['app'], status: 'working', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 8, title: '已完成定时运行', profileId: 'assistant', ownedBy: 'helmx', tags: ['trigger', 'cron:daily'], status: 'done', createdAt: 8000, updatedAt: 8000 }),
    ],
    primaryTarget: { kind: 'overview', params: { source: 'automated' } },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
    })
    const cards = [...container.querySelectorAll<HTMLElement>('.overview-card')]
    assert.equal(cards.length, 2)
    const menuTrigger = cards[0]!.querySelector<HTMLButtonElement>('.overview-card-actions button[aria-haspopup="menu"]')
    assert.ok(menuTrigger !== null, 'the active automated card still renders its actions menu (prepend view actions)')
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) =>
      el.closest('.helmx-dropdown-content') !== null,
    )
    assert.ok(items.length === 2, 'the active automated card menu carries exactly the two read-only view actions')
    assert.ok(items[0]!.textContent?.includes('Peek in drawer'), 'drawer peek survives on automated cards')
    assert.ok(items[1]!.textContent?.includes('Open in right split'), 'right split survives on automated cards')
    assert.ok(document.querySelectorAll('[role="separator"]').length === 0, 'nothing follows the prepend actions: no separator, no host archive')
    await act(async () => {
      items[0]!.click()
    })
    assert.deepEqual(
      store.getDrawerStack(),
      [{ kind: 'conversation', conversationId: 7 }],
      'drawer peek works on automated cards',
    )

    // Settled automated card (#8) exposes Delete in its menu. Opening the previous menu attached
    // Radix DismissableLayer's document-level pointer listener; its cleanup runs on a later
    // macrotask after the Portal unmounts. Flush those tasks first (same discipline as the other
    // menu tests' settle()), otherwise the next trigger's pointerdown is consumed as an outside
    // click and the second menu never opens. The modal drawer must also be closed first.
    await act(async () => {
      store.actions.popDrawer()
    })
    await waitForCondition(() => store.getDrawerStack().length === 0)
    await waitForCondition(() => document.querySelectorAll('.helmx-dropdown-content').length === 0)
    await flushMacrotask(0)
    const settledTrigger = cards[1]!.querySelector<HTMLButtonElement>('.overview-card-actions button[aria-haspopup="menu"]')
    assert.ok(settledTrigger !== null)
    await act(async () => {
      settledTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const settledMenuItems = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) =>
        el.closest('.helmx-dropdown-content') !== null,
      )
    await waitForCondition(() => settledMenuItems().some((el) => el.textContent?.includes('Delete')))
    assert.ok(settledMenuItems().some((el) => el.textContent?.includes('Delete')), 'settled automated card exposes Delete')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

test('ConversationOverview split instance navigates conversations into the same split pane', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: [conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 })],
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
    splitTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview, { isSplit: true })))
    })
    const card = container.querySelector<HTMLElement>('.overview-card')
    assert.ok(card !== null, 'the split overview renders its card grid')
    const newTopicBtn = container.querySelector<HTMLButtonElement>('.overview-newtopic-btn')
    await act(async () => {
      card.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'conversation', conversationId: 1 },
      'clicking a card inside the split overview navigates the same split pane',
    )
    assert.ok(store.getNavSlice().primaryTarget.kind === 'agent', 'the main pane stays untouched')
    await act(async () => {
      newTopicBtn?.click()
    })
    assert.deepEqual(
      store.getNavSlice().splitTarget,
      { kind: 'agent', profileId: 'assistant' },
      'the new-topic button also opens standby inside the same split pane',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 交互：分层态势分组舞台（分节、折叠、Group by、安静降噪、搜索防藏匿）
// ---------------------------------------------------------------------------

test('ConversationOverview quiet cards collapse descendants by default into a single summary pill and expand in-card', { timeout: 60_000 }, async () => {
  const conversations = [
    conv({ id: 1, title: '已完成重构', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 }),
    ...Array.from({ length: 7 }, (_, index) =>
      conv({ id: 11 + index, parentConversationId: 1, title: `静默子任务 ${index + 1}`, status: 'idle', createdAt: 9100 + index }),
    ),
    conv({ id: 2, title: '单子会话树', profileId: 'assistant', status: 'idle', createdAt: 8000, updatedAt: 8000 }),
    conv({ id: 21, parentConversationId: 2, title: '唯一子任务', status: 'idle', createdAt: 8100 }),
  ]
  const store = overviewStore({ conversations, primaryTarget: { kind: 'overview' } })
  const mount = await mountOverview(store)
  try {
    const multiCard = cardById(mount.container, 1)!
    const singleCard = cardById(mount.container, 2)!
    assert.equal(multiCard.querySelectorAll('.overview-chip').length, 0, 'quiet card hides finished descendant chips by default')
    const toggle = multiCard.querySelector<HTMLButtonElement>('.overview-chip-more')
    assert.ok(toggle !== null, 'quiet card renders the single descendant summary pill')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(toggle.textContent, '7 sub-conversations')
    assert.equal(
      singleCard.querySelector('.overview-chip-more')?.textContent,
      '1 sub-conversation',
      'singular count avoids plural mismatch',
    )

    await act(async () => {
      toggle.click()
    })
    const expandedChips = multiCard.querySelectorAll('.overview-chip')
    assert.equal(expandedChips.length, 7, 'clicking the quiet summary pill expands every descendant in-card')
    assert.equal(multiCard.querySelector('.overview-chip-more')?.textContent, 'Show less')
    assert.equal(multiCard.querySelector('.overview-chip-more')?.getAttribute('aria-expanded'), 'true')

    await act(async () => {
      multiCard.querySelector<HTMLButtonElement>('.overview-chip-more')?.click()
    })
    assert.equal(multiCard.querySelectorAll('.overview-chip').length, 0, 'clicking Show less collapses back to the summary pill')
    assert.equal(multiCard.querySelector('.overview-chip-more')?.textContent, '7 sub-conversations')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview grouped stage renders non-empty status sections, flattens single-bucket view, and supports Group by via sp.group', { timeout: 60_000 }, async () => {
  const store = overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'blocked', createdAt: 9000 }),
      conv({ id: 2, title: '远端调研', profileId: 'coder', nodeId: 'remote-1', status: 'working', createdAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const mount = await mountOverview(store)
  try {
    // 默认按状态：只渲染非空分节（Unread completed 省略）
    const sections = [...mount.container.querySelectorAll<HTMLElement>('.overview-section')]
    assert.deepEqual(
      sections.map((el) => el.getAttribute('data-group-key')),
      ['bucket:needs_attention', 'bucket:running', 'bucket:quiet'],
      'empty buckets render zero section headers',
    )
    assert.ok(sections[0]!.textContent?.includes('Needs attention'))
    assert.ok(sections[1]!.textContent?.includes('Running'))
    assert.ok(sections[2]!.textContent?.includes('Idle'))

    // 切到单桶 Running：去套娃，不重复渲染「Running」单节头
    const runningTab = [...mount.container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.includes('Running'),
    ) as HTMLElement
    await act(async () => {
      runningTab.click()
    })
    assert.equal(mount.container.querySelectorAll('.overview-section').length, 0, 'single-bucket status view flattens out redundant section header')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1)

    // 切回 All 并切换 Group by -> By agent（经 Select），写入 sp.group=profile，且不污染筛选统计
    const allTab = [...mount.container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.startsWith('All'),
    ) as HTMLElement
    await act(async () => {
      allTab.click()
    })
    const groupSelect = mount.container.querySelector<HTMLElement>('[aria-label="Group by"]')
    assert.ok(groupSelect !== null, 'the toolbar renders the Group by select')
    await act(async () => {
      groupSelect.click()
    })
    const byAgentOption = [...document.body.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes('By agent'),
    ) as HTMLElement | undefined
    assert.ok(byAgentOption !== undefined)
    await act(async () => {
      byAgentOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview', params: { group: 'profile' } })
    assert.ok(mount.container.textContent?.includes('3 conversation groups'), 'grouping alone never shows filtered count stats')
    assert.deepEqual(
      [...mount.container.querySelectorAll<HTMLElement>('.overview-section')].map((el) => el.getAttribute('data-group-key')),
      ['profile:assistant', 'profile:coder'],
      'profile grouping orders agents by urgency-first appearance',
    )

    // 在按角色分组下再切 Running 单桶：保留各角色节头
    await act(async () => {
      runningTab.click()
    })
    assert.deepEqual(
      [...mount.container.querySelectorAll<HTMLElement>('.overview-section')].map((el) => el.getAttribute('data-group-key')),
      ['profile:coder'],
      'filtering bucket while grouped by agent preserves agent grouping headers',
    )

    // 深链切换到 node 分组并校验无效 sp.group 自愈
    await act(async () => {
      store.navActions.applyExternalLocation(parseLocationHash('#/overview?sp.group=node'))
    })
    await overviewSettle()
    assert.deepEqual(
      [...mount.container.querySelectorAll<HTMLElement>('.overview-section')].map((el) => el.getAttribute('data-group-key')),
      ['node:local', 'node:remote-1'],
    )
    await act(async () => {
      store.navActions.applyExternalLocation(parseLocationHash('#/overview?sp.group=bogus'))
    })
    await overviewSettle()
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'invalid group param repairs to canonical clean target')
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview section collapse hides cards, excludes them from batch selection, and auto-expands during search', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const quietSection = mount.container.querySelector<HTMLElement>('[data-group-key="bucket:quiet"]')
    const quietToggle = quietSection?.querySelector<HTMLButtonElement>('.overview-section-toggle')
    assert.ok(quietToggle !== null && quietToggle !== undefined)
    assert.equal(quietToggle.getAttribute('aria-expanded'), 'true')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3)

    // 折叠 Quiet 分节：卡片收起；切入批量模式后全选仅覆盖当前可见的 2 张活跃卡
    await act(async () => {
      quietToggle.click()
    })
    assert.equal(quietToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 2, 'collapsed section hides its cards')

    const batchToggle = mount.container.querySelector<HTMLButtonElement>('.overview-batch-toggle')
    await act(async () => {
      batchToggle?.click()
    })
    const selectAll = [...mount.container.querySelectorAll<HTMLButtonElement>('.overview-batch-bar button')]
      .find((btn) => btn.textContent === 'Select all')
    await act(async () => {
      selectAll?.click()
    })
    assert.ok(mount.container.textContent?.includes('2 selected'), 'select-all only picks visible cards from expanded sections')

    // 展开 Quiet 再折叠：若把已选卡收起，隐藏项立即从有效选择集出局
    await act(async () => {
      quietToggle.click()
    })
    await act(async () => {
      cardById(mount.container, 3)?.click()
    })
    assert.ok(mount.container.textContent?.includes('3 selected'))
    await act(async () => {
      quietToggle.click()
    })
    assert.ok(mount.container.textContent?.includes('2 selected'), 'collapsing a section drops its hidden cards from batch selection')

    // 搜索防藏匿：命中 Quiet 卡片时自动临时展开；清空搜索后恢复先前折叠态
    const input = mount.container.querySelector<HTMLInputElement>('.overview-search-box input')
    assert.ok(input !== null)
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, '安静')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'search expands the matching section so the quiet card is never hidden')
    assert.equal(
      mount.container.querySelector<HTMLButtonElement>('[data-group-key="bucket:quiet"] .overview-section-toggle')?.getAttribute('aria-expanded'),
      'true',
    )

    const clearBtn = mount.container.querySelector<HTMLButtonElement>('.overview-search-clear')
    await act(async () => {
      clearBtn?.click()
    })
    assert.equal(
      mount.container.querySelector<HTMLButtonElement>('[data-group-key="bucket:quiet"] .overview-section-toggle')?.getAttribute('aria-expanded'),
      'false',
      'clearing search restores the previous section collapse preference',
    )
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 2)
  } finally {
    await mount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 时间观测：DOM 秒表与零定时器门控（纯函数单测见 overview-model.test.ts）
// ---------------------------------------------------------------------------

test('ConversationOverview DOM: renders live waiting/running stopwatches, settled totals, active chip stopwatches, and uses 0 timers when quiet / 1 shared timer when active', { timeout: 60_000 }, async () => {
  const { resetServerClock } = await import('../src/lib/server-clock.js')
  resetServerClock()
  const origSetInterval = globalThis.setInterval
  let intervalCount = 0
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervalCount += 1
    return origSetInterval(...args)
  }) as typeof setInterval

  try {
    // 1. 全员安静/已完成：0 定时器开销，有 runDurationMs 的卡片展示「累计」
    const quietStore = overviewStore({
      locale: 'zh-CN',
      conversations: [
        conv({
          id: 4,
          title: '已完成卡片',
          status: 'done',
          unread: true,
          runDurationMs: 125_000,
          createdAt: new Date(2026, 10, 10, 14, 0, 0).getTime(),
          updatedAt: new Date(2026, 10, 10, 14, 5, 0).getTime(),
        }),
        conv({ id: 5, title: '纯安静卡片', status: 'idle', runDurationMs: 0, createdAt: 5000, updatedAt: 5000 }),
        conv({ id: 51, parentConversationId: 5, title: '安静子会话', status: 'idle', createdAt: 5100 }),
      ],
      primaryTarget: { kind: 'overview' },
    })
    const quietMount = await mountOverview(quietStore)
    try {
      assert.equal(intervalCount, 0, 'all-quiet/done overview must allocate 0 interval timers')
      const doneCard = cardById(quietMount.container, 4)
      assert.ok(doneCard !== undefined)
      const doneTime = doneCard.querySelector<HTMLElement>('.overview-card-sub-time')
      assert.ok(doneTime !== null)
      assert.equal(doneTime.textContent, '累计 2m5s')
      assert.match(doneTime.getAttribute('title') ?? '', /创建于 2026-11-10 14:00:00/)
      assert.match(doneTime.getAttribute('title') ?? '', /更新于 2026-11-10 14:05:00/)
      assert.ok(cardById(quietMount.container, 5)?.querySelector('.overview-card-sub-time') === null, '0ms runDurationMs renders no timing')
    } finally {
      await quietMount.unmount()
    }

    // 2. 多张运行/等待卡片与活跃后代芯片同时渲染：只挂载 1 个共享定时器
    const now = Date.now()
    const activeStore = overviewStore({
      locale: 'zh-CN',
      conversations: [
        conv({ id: 1, title: '等审批根', status: 'idle', createdAt: 9000 }),
        conv({
          id: 11,
          parentConversationId: 1,
          title: '待批子代理',
          status: 'blocked',
          pendingAskCount: 1,
          pendingAskSince: now - 18_400,
          createdAt: 9100,
        }),
        conv({
          id: 2,
          title: '运行根',
          status: 'working',
          runStartedAt: now - 65_400,
          createdAt: 8000,
        }),
        conv({
          id: 21,
          parentConversationId: 2,
          title: '在跑子代理',
          status: 'working',
          runStartedAt: now - 12_400,
          createdAt: 8100,
        }),
        conv({
          id: 22,
          parentConversationId: 2,
          title: '已完成子代理',
          status: 'done',
          runDurationMs: 9000,
          createdAt: 8050,
        }),
      ],
      primaryTarget: { kind: 'overview' },
    })
    const activeMount = await mountOverview(activeStore)
    try {
      assert.equal(intervalCount, 1, 'multiple active cards and chips share exactly one setInterval')
      const waitingCard = cardById(activeMount.container, 1)!
      assert.match(waitingCard.querySelector('.overview-card-sub-time-warn')?.textContent ?? '', /已等待 18s/)
      const waitingChip = waitingCard.querySelector('.overview-chip')!
      assert.match(waitingChip.querySelector('.overview-chip-elapsed-warn')?.textContent ?? '', /18s/)

      const runningCard = cardById(activeMount.container, 2)!
      assert.match(runningCard.querySelector('.overview-card-sub-time')?.textContent ?? '', /1m05s/)
      const chips = [...runningCard.querySelectorAll<HTMLElement>('.overview-chip')]
      const workingChip = chips.find((el) => (el.textContent ?? '').includes('在跑子代理'))!
      const quietChip = chips.find((el) => (el.textContent ?? '').includes('已完成子代理'))!
      assert.match(workingChip.querySelector('.overview-chip-elapsed')?.textContent ?? '', /12s/)
      assert.ok(quietChip.querySelector('.overview-chip-elapsed') === null, 'quiet descendant chip must not render stopwatch')
    } finally {
      await activeMount.unmount()
    }
  } finally {
    globalThis.setInterval = origSetInterval
    resetServerClock()
  }
})

test('ConversationOverview archived tab & unified card menu: archived tab appears conditionally, no standalone peek button, and menu peek opens drawer', { timeout: 60_000 }, async () => {
  // 1) No archived conversations: Archived segment does not render
  const noArchivedStore = overviewStore({
    conversations: [
      conv({ id: 1, title: '进行中任务', profileId: 'coder', status: 'working', createdAt: 9000, updatedAt: 9000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HostStoreProviders, { value: noArchivedStore }, e(ConversationOverview)))
    })
    assert.ok(!container.textContent?.includes('Archived'), 'Archived segment stays absent when zero archived conversations exist')

    // Standalone drawer peek button is folded into the unified "..." menu (matching sidebar rows)
    assert.ok(container.querySelector('.overview-card-peek-btn') === null, 'no standalone drawer-peek button renders outside the menu')
    const actionButtons = container.querySelectorAll('.overview-card-actions button')
    assert.equal(actionButtons.length, 1, 'card actions expose only the unified "..." menu button')
    const menuTrigger = container.querySelector<HTMLButtonElement>('.overview-card-actions button[aria-haspopup="menu"]')
    assert.ok(menuTrigger !== null, 'the unified "..." menu trigger renders')
    await act(async () => {
      menuTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    const peekItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Peek in drawer'),
    )
    assert.ok(peekItem !== undefined, 'drawer peek lives inside the unified menu')
    await act(async () => {
      peekItem.click()
    })
    assert.equal(noArchivedStore.getPrimaryTarget().kind, 'overview', 'drawer peek keeps user on overview')
    assert.deepEqual(noArchivedStore.getDrawerStack(), [{ kind: 'conversation', conversationId: 1 }])

    // 2) Add archived conversation via live update -> Archived tab appears and switches cleanly
    await act(async () => {
      noArchivedStore.updateLive((prev) => ({
        ...prev,
        conversations: [
          ...prev.conversations,
          conv({ id: 77, title: '已归档历史项目', profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 5000, updatedAt: 5000 }),
        ],
      }))
    })
    assert.equal(container.querySelectorAll('.overview-card').length, 1, 'All tab excludes archived conversations')
    const archivedTabBtn = [...container.querySelectorAll<HTMLButtonElement>('.segmented-control-btn')].find((b) =>
      b.textContent?.includes('Archived'),
    )
    assert.ok(archivedTabBtn !== undefined, 'Archived tab surfaces when archived conversations exist')
    await act(async () => {
      archivedTabBtn.click()
    })
    assert.deepEqual(noArchivedStore.getPrimaryTarget(), { kind: 'overview', params: { bucket: 'archived' } })
    assert.equal(container.querySelectorAll('.overview-card').length, 1)
    assert.ok(container.querySelector('.overview-card')?.textContent?.includes('已归档历史项目'))
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})
