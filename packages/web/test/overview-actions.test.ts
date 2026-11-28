/**
 * 会话总览（#/overview）批量操作、卡片菜单动作、新话题下拉、搜索防抖与分节折叠交互测试。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import { patchOverviewSearchDebounceMs, resetOverviewSearchDebounceMs } from '../src/overview/overview-timing.js'
import { flushMacrotask, waitForCondition } from './helpers/dom-harness.js'
import {
  batchScenarioStore,
  cardById,
  conv,
  disposeOverviewTestEnv,
  installConversationMutationStub,
  mountOverview,
  overviewScenarioStore,
  overviewSettle,
  overviewStore,
} from './helpers/overview-harness.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')
const { ConversationOverview } = await import('../src/overview/ConversationOverview.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

afterEach(() => {
  disposeOverviewTestEnv()
}, { timeout: 60_000 })

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
    const scrollContainer = mount.container.querySelector('.screen-host-body[data-screen-host="true"]')
    const screenContainer = scrollContainer?.querySelector('.screen-container') ?? null
    const batchWrap = screenContainer?.querySelector(':scope > .overview-batch-bar-wrap') ?? null
    const stage = screenContainer?.querySelector(':scope > .overview-sections, :scope > .overview-grid') ?? null
    assert.ok(scrollContainer !== null && screenContainer !== null && batchWrap !== null && stage !== null, 'batch bar and card stage share the unified Screen scroll container')
    assert.ok(mount.container.querySelector('.overview-scroll') === null, 'retired double-scroll .overview-scroll wrapper is gone')
    assert.ok(batchBar.parentElement === batchWrap, 'batch bar sits inside .overview-batch-bar-wrap for aligned outer gutters')

    const cards = [...mount.container.querySelectorAll<HTMLElement>('.overview-card')]
    assert.equal(cards.length, 3)
    for (const card of cards) {
      assert.ok(card.querySelector('.overview-card-batch-check') !== null, 'every card carries a batch checkbox')
    }
    assert.equal(cardById(mount.container, 1)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, false)
    assert.equal(cardById(mount.container, 4)?.querySelector<HTMLInputElement>('[role="checkbox"], input[type="checkbox"]')?.disabled, false, 'the idle helmx root is bulk-selectable (bulk delete only)')

    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected'), 'clicking the card selects it')
    assert.equal(store.getNavSlice().activeModal, null, 'batch clicks never open the conversation drawer')
    await act(async () => {
      cardById(mount.container, 1)?.click()
    })
    assert.ok(cardById(mount.container, 1)?.classList.contains('is-selected') === false, 'clicking again deselects')

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

test('ConversationOverview search box narrows by title/summary and rides the q route param with a clear button', { timeout: 60_000 }, async () => {
  patchOverviewSearchDebounceMs(5)
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    assert.ok(mount.container.querySelector('.primary-center-topbar') === null, 'uses unified <Screen topbar> instead of retired .primary-center-topbar')
    assert.ok(mount.container.querySelector('.pane-topbar .pane-actions .overview-newtopic-btn.btn-primary.btn-sm') !== null, 'New topic button is primary sm in topbar actions')
    assert.ok(mount.container.querySelector('.screen-toolbar-bar .screen-toolbar.overview-toolbar .helmx-tabs-segmented.helmx-tabs-sm') !== null, 'bucket filter uses sm SegmentedControl inside unified ScreenToolbar')
    assert.ok(mount.container.querySelector('.screen-toolbar-bar .overview-filter-select.helmx-select-sm') !== null, 'filter selects use sm tier')
    const searchBox = mount.container.querySelector('.screen-toolbar-bar .screen-toolbar-actions .search-box-toolbar.search-box-sm.overview-search-box')
    assert.ok(searchBox !== null, 'search box uses toolbar sm variant on the right side of ScreenToolbar')
    const input = searchBox.querySelector<HTMLInputElement>('input')
    assert.ok(input !== null, 'the toolbar renders the search input')
    assert.equal(input.getAttribute('aria-label'), 'Search overview by title or summary')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3)
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
    const clear = mount.container.querySelector<HTMLButtonElement>('.overview-search-box .search-box-clear')
    assert.ok(clear !== null, 'a non-empty query renders the clear button')
    await act(async () => {
      clear.click()
    })
    assert.deepEqual(store.getNavSlice().primaryTarget, { kind: 'overview' }, 'clearing deletes the q param')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3, 'the grid restores')
  } finally {
    await mount.unmount()
    resetOverviewSearchDebounceMs()
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

test('ConversationOverview protected card keeps the view-only menu actions (peek + right split); settled automated card allows deletion', { timeout: 60_000 }, async () => {
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

test('ConversationOverview section collapse hides cards, excludes them from batch selection, and auto-expands during search', { timeout: 60_000 }, async () => {
  const store = overviewScenarioStore()
  const mount = await mountOverview(store)
  try {
    const quietSection = mount.container.querySelector<HTMLElement>('[data-group-key="bucket:quiet"]')
    const quietToggle = quietSection?.querySelector<HTMLButtonElement>('.screen-section-toggle')
    assert.ok(quietToggle !== null && quietToggle !== undefined)
    assert.equal(quietToggle.getAttribute('aria-expanded'), 'true')
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 3)

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

    const input = mount.container.querySelector<HTMLInputElement>('.overview-search-box input')
    assert.ok(input !== null)
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      valueSetter?.call(input, '安静')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 1, 'search expands the matching section so the quiet card is never hidden')
    assert.equal(
      mount.container.querySelector<HTMLButtonElement>('[data-group-key="bucket:quiet"] .screen-section-toggle')?.getAttribute('aria-expanded'),
      'true',
    )

    const clearBtn = mount.container.querySelector<HTMLButtonElement>('.overview-search-box .search-box-clear')
    await act(async () => {
      clearBtn?.click()
    })
    assert.equal(
      mount.container.querySelector<HTMLButtonElement>('[data-group-key="bucket:quiet"] .screen-section-toggle')?.getAttribute('aria-expanded'),
      'false',
      'clearing search restores the previous section collapse preference',
    )
    assert.equal(mount.container.querySelectorAll('.overview-card').length, 2)
  } finally {
    await mount.unmount()
  }
})

test('ConversationOverview archived tab & unified card menu: archived tab appears conditionally, no standalone peek button, and menu peek opens drawer', { timeout: 60_000 }, async () => {
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
