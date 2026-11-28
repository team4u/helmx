/**
 * 会话总览（#/overview 一级看板与治理大盘）渲染、筛选、分组、导航与计时展示测试（纯模型单测见 overview-model.test.ts）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import { OVERVIEW_DESCENDANT_LIMIT } from '../src/overview/overview-model.js'
import { parseLocationHash } from '../src/lib/url-hash-model.js'
import { flushMacrotask } from './helpers/dom-harness.js'
import {
  cardById,
  conv,
  disposeOverviewTestEnv,
  mountOverview,
  overviewScenarioStore,
  overviewSettle,
  overviewStore,
} from './helpers/overview-harness.js'
import { HelmxExternalStoreContext } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')
const { ConversationOverview } = await import('../src/overview/ConversationOverview.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { OVERVIEW_CARD_META_SLOT } = await import('@helmx/protocol/browser')
const { Sidebar } = await import('../src/shell/Sidebar.js')

afterEach(() => {
  disposeOverviewTestEnv()
}, { timeout: 60_000 })

test('ConversationOverview card light matches the sidebar row verdict: idle root with background in-flight renders the hollow ring', { timeout: 60_000 }, async () => {
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
    assert.ok(cards[0]!.querySelector('.overview-card-head .status-dot') === null, 'the idle root keeps the card head light off (row-consistent)')
    assert.ok(cards[0]!.querySelector('.overview-chip .status-dot-blocked') !== null, 'the blocked descendant chip carries its own light')
    assert.ok(cards[0]!.textContent?.includes('待审批子任务'), 'the waiting descendant renders as a chip')
    const attentionReason = cards[0]!.querySelector('.overview-card-attention')
    assert.equal(attentionReason?.textContent, 'Waiting for you')
    assert.equal(cards[0]!.querySelector('.overview-card-open')?.getAttribute('aria-describedby'), attentionReason?.id)
    assert.ok(cards[1]!.querySelector('.overview-card-head .status-dot-working') !== null, 'the working root lights the card head exactly like a sidebar row')
    assert.ok(cards[1]!.textContent?.includes('正在检索文档'), 'the running card states the real doing text')
    assert.ok(container.textContent?.includes('3 conversation groups'), 'the stats line counts visible cards')

    await act(async () => {
      ;(cards[0] as HTMLElement).click()
    })
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'conversation', conversationId: 11 },
      'clicking the card navigates the main view straight to the waiting descendant',
    )
    assert.ok(store.getNavSlice().activeModal === null, 'card clicks never open the conversation drawer')

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
      await flushMacrotask(0)
    })

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
    assert.deepEqual(
      store.getNavSlice().primaryTarget,
      { kind: 'overview', params: { bucket: 'running' } },
      'the bucket filter persists into the overview route params',
    )
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
    plugins: [{ id: 'demo-desk', name: 'Apps', version: '0.0.0', enabled: true, hooks: [], actions: [], tools: [], clientHashes: { 'overview-meta.tsx': 'seeded' } }],
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

    await act(async () => {
      pill.click()
    })
    assert.equal(store.getNavSlice().activeModal, null, 'clicking the pill does not trigger the card drawer')

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

    const convSpaceBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Conversations space"]')
    assert.ok(convSpaceBtn?.classList.contains('rail-btn-active'), 'conversations rail button stays active on #/overview')
    assert.ok(convSpaceBtn?.querySelector('.rail-space-dot') === null, 'expanded conversations rail omits duplicate dot')

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

    await act(async () => {
      store.actions.openSpace('conversations')
    })
    assert.deepEqual(
      store.getPrimaryTarget(),
      { kind: 'overview', params: { bucket: 'archived' } },
      'returning to conversations restores remembered #/overview target',
    )
    assert.ok(container.querySelector('.rail-space-dot') === null)

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

test('ConversationOverview data-ready gate: loading state before the first snapshot, honest empty only when truly synced', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
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

    const empty = overviewStore({
      conversations: [],
      primaryTarget: { kind: 'overview' },
    })
    await act(async () => {
      root!.render(e(HostStoreProviders, { value: empty }, e(ConversationOverview)))
    })
    assert.ok(container.textContent?.includes('No conversations yet'), 'a genuinely empty synced workspace shows the honest empty-system state')
    assert.ok(!container.textContent?.includes('Loading conversations'), 'loading never sticks once data is ready')

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

    assert.ok(open.querySelector('.nav-status-slot, .status-dot') === null, 'leading button contains no status light')
    assert.equal(open.children.length, 2)
    assert.equal(open.children[0]?.classList.contains('overview-card-id'), true, '#id sits on the left side of the title')
    assert.equal(open.children[0]?.textContent, '#2')
    assert.equal(open.children[1]?.classList.contains('overview-card-title'), true)
    assert.equal(open.children[1]?.textContent, '在跑的调研')

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
    const sections = [...mount.container.querySelectorAll<HTMLElement>('.overview-section')]
    assert.deepEqual(
      sections.map((el) => el.getAttribute('data-group-key')),
      ['bucket:needs_attention', 'bucket:running', 'bucket:quiet'],
      'empty buckets render zero section headers',
    )
    assert.ok(sections[0]!.textContent?.includes('Needs attention'))
    assert.ok(sections[1]!.textContent?.includes('Running'))
    assert.ok(sections[2]!.textContent?.includes('Idle'))

    const runningTab = [...mount.container.querySelectorAll('.segmented-control-btn')].find((btn) =>
      btn.textContent?.includes('Running'),
    ) as HTMLElement
    await act(async () => {
      runningTab.click()
    })
    assert.equal(mount.container.querySelectorAll('.overview-section').length, 0, 'single-bucket status view flattens out redundant section header')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1)

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

    await act(async () => {
      runningTab.click()
    })
    assert.deepEqual(
      [...mount.container.querySelectorAll<HTMLElement>('.overview-section')].map((el) => el.getAttribute('data-group-key')),
      ['profile:coder'],
      'filtering bucket while grouped by agent preserves agent grouping headers',
    )

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
