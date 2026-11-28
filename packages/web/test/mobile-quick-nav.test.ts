/**
 * 移动端免开汉堡一键直达（MobileQuickNav）交互与徽标契约测试。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ResolvedSidebarBadge, SidebarViewItem } from '../src/shell/sidebar-model.js'
import { conv, disposeOverviewTestEnv, overviewStore } from './helpers/overview-harness.js'
import { HelmxExternalStoreContext } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { createRoot } = await import('react-dom/client')
const { MobileQuickNav } = await import('../src/shell/MobileQuickNav.js')

afterEach(() => {
  disposeOverviewTestEnv()
}, { timeout: 60_000 })

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
