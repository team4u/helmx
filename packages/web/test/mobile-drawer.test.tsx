/**
 * 移动端侧栏滑动手势（防误触状态机 + DOM 冲突守卫 + Hook 集成）测试：
 * - 非边缘右滑打开、抽屉左滑关闭；左右 28px 边缘让位系统返回手势；
 * - 首段 12px 方向锁死（先竖滑后斜拉绝不误弹）；
 * - 220ms 起步时限、600ms 总时长上限与松手非空选区检查（拦截长按选字后右拖）；
 * - Radix Dialog / AlertDialog / Menu / Listbox / 非 Tooltip Popover 浮层拦截（不拦截 Tooltip）；
 * - 代码块/表格/输入框/tablist/data-swipe-ignore/touch-action:none/横向溢出容器无条件豁免；
 * - 多指触控与 touchcancel 取消。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import {
  beginDrawerSwipe,
  endDrawerSwipe,
  hasActiveTextSelection,
  hasBlockingOverlay,
  isSwipeExcludedTarget,
  moveDrawerSwipe,
  SWIPE_EDGE_GUARD_PX,
} from '../src/shell/mobile-drawer-gesture.js'
import { resetStandbyDrafts } from '../src/conversation/standby-model.js'
import { hangingEventStream } from './helpers/sse-stream.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React
const { createRoot } = await import('react-dom/client')
const { useMobileDrawerSwipe } = await import('../src/shell/use-mobile-drawer-swipe.js')
const { App } = await import('../src/App.js')

const e = React.createElement

test('drawer swipe state machine: opens on right swipe, closes on left swipe, and respects both screen edges', { timeout: 60_000 }, () => {
  // 左右 28px 系统边缘一律拒绝
  assert.equal(beginDrawerSwipe({ x: SWIPE_EDGE_GUARD_PX - 1, y: 300, timeMs: 0, viewportWidth: 390, sidebarOpen: false }), null)
  assert.equal(beginDrawerSwipe({ x: 390 - SWIPE_EDGE_GUARD_PX + 1, y: 300, timeMs: 0, viewportWidth: 390, sidebarOpen: true }), null)

  // 正文区右滑打开
  let s = beginDrawerSwipe({ x: 80, y: 300, timeMs: 100, viewportWidth: 390, sidebarOpen: false })!
  assert.ok(s !== null && s.direction === 'open' && s.phase === 'pending')
  s = moveDrawerSwipe(s, { x: 96, y: 302, timeMs: 140 })
  assert.equal(s.phase, 'locked')
  s = moveDrawerSwipe(s, { x: 150, y: 306, timeMs: 210 })
  assert.equal(s.phase, 'locked')
  assert.equal(endDrawerSwipe(s, { x: 150, y: 306, timeMs: 220, hasNonCollapsedSelection: false }), 'open')

  // 抽屉左滑关闭
  let c = beginDrawerSwipe({ x: 240, y: 260, timeMs: 500, viewportWidth: 390, sidebarOpen: true })!
  assert.ok(c !== null && c.direction === 'close')
  c = moveDrawerSwipe(c, { x: 220, y: 262, timeMs: 530 })
  assert.equal(c.phase, 'locked')
  assert.equal(endDrawerSwipe(c, { x: 180, y: 264, timeMs: 620, hasNonCollapsedSelection: false }), 'close')

  // 位移不足不触发
  assert.equal(endDrawerSwipe(c, { x: 205, y: 264, timeMs: 620, hasNonCollapsedSelection: false }), null)
})

test('drawer swipe state machine: 12px initial direction lock, long-press 220ms rejection, duration cap, and text selection guard', { timeout: 60_000 }, () => {
  // 首段先竖滑 14px，随后向右拖 120px 仍保持永久 canceled
  let verticalFirst = beginDrawerSwipe({ x: 80, y: 300, timeMs: 0, viewportWidth: 390, sidebarOpen: false })!
  verticalFirst = moveDrawerSwipe(verticalFirst, { x: 85, y: 314, timeMs: 40 })
  assert.equal(verticalFirst.phase, 'canceled')
  verticalFirst = moveDrawerSwipe(verticalFirst, { x: 200, y: 314, timeMs: 120 })
  assert.equal(verticalFirst.phase, 'canceled')
  assert.equal(endDrawerSwipe(verticalFirst, { x: 200, y: 314, timeMs: 140, hasNonCollapsedSelection: false }), null)

  // 长按选词（按住 260ms 后才开始右拖）：超 220ms 起步时限直接取消
  let longPressDrag = beginDrawerSwipe({ x: 80, y: 300, timeMs: 0, viewportWidth: 390, sidebarOpen: false })!
  longPressDrag = moveDrawerSwipe(longPressDrag, { x: 100, y: 300, timeMs: 260 })
  assert.equal(longPressDrag.phase, 'canceled')
  assert.equal(endDrawerSwipe(longPressDrag, { x: 180, y: 300, timeMs: 360, hasNonCollapsedSelection: false }), null)

  // 松手存在非空文本选区时绝不触发
  let selected = beginDrawerSwipe({ x: 80, y: 300, timeMs: 0, viewportWidth: 390, sidebarOpen: false })!
  selected = moveDrawerSwipe(selected, { x: 100, y: 300, timeMs: 50 })
  assert.equal(selected.phase, 'locked')
  assert.equal(endDrawerSwipe(selected, { x: 170, y: 300, timeMs: 160, hasNonCollapsedSelection: true }), null)

  // 总时长超过 600ms 取消
  assert.equal(endDrawerSwipe(selected, { x: 170, y: 300, timeMs: 650, hasNonCollapsedSelection: false }), null)
})

test('DOM guards: Radix overlays block swipe (tooltips do not) and horizontal/interactive containers are unconditionally excluded', { timeout: 60_000 }, () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  try {
    assert.equal(hasBlockingOverlay(document), false)

    // Tooltip popper 不阻塞
    const tooltipPopper = document.createElement('div')
    tooltipPopper.setAttribute('data-radix-popper-content-wrapper', '')
    tooltipPopper.innerHTML = '<span role="tooltip">Tip</span>'
    host.appendChild(tooltipPopper)
    assert.equal(hasBlockingOverlay(document), false, 'hover tooltip must not block swipe')
    tooltipPopper.remove()

    // Non-tooltip Popover / Dialog / Menu / Listbox 均阻塞
    for (const html of [
      '<div role="dialog">Drawer</div>',
      '<div role="alertdialog">Confirm</div>',
      '<div role="menu">Menu</div>',
      '<div role="listbox">Select</div>',
      '<div data-radix-popper-content-wrapper=""><div>Popover</div></div>',
    ]) {
      host.innerHTML = html
      assert.equal(hasBlockingOverlay(document), true, `overlay must block swipe: ${html}`)
    }
    host.innerHTML = ''

    // 普通段落允许触发
    const shell = document.createElement('div')
    const para = document.createElement('p')
    para.textContent = 'hello'
    shell.appendChild(para)
    host.appendChild(shell)
    assert.equal(isSwipeExcludedTarget(para.firstChild, shell, () => ({ overflowX: 'visible', touchAction: 'auto' })), false)

    // 代码块 / 表格 / 输入框 / tablist / data-swipe-ignore / composer-pills / mermaid-body 均豁免
    for (const tag of ['pre', 'table', 'input', 'textarea', 'select', 'canvas']) {
      const el = document.createElement(tag)
      const child = document.createElement('span')
      el.appendChild(child)
      shell.appendChild(el)
      assert.equal(
        isSwipeExcludedTarget(child, shell, () => ({ overflowX: 'visible', touchAction: 'auto' })),
        true,
        `${tag} must exclude swipe`,
      )
    }

    const customCanvas = document.createElement('div')
    shell.appendChild(customCanvas)
    assert.equal(
      isSwipeExcludedTarget(customCanvas, shell, () => ({ overflowX: 'visible', touchAction: 'none' })),
      true,
      'touch-action:none excludes swipe',
    )

    // 横向溢出滚动容器即使 scrollLeft === 0 也无条件豁免
    const wideScroll = document.createElement('div')
    Object.defineProperty(wideScroll, 'scrollWidth', { value: 600, configurable: true })
    Object.defineProperty(wideScroll, 'clientWidth', { value: 320, configurable: true })
    wideScroll.scrollLeft = 0
    shell.appendChild(wideScroll)
    assert.equal(
      isSwipeExcludedTarget(wideScroll, shell, (el) =>
        el === wideScroll ? { overflowX: 'auto', touchAction: 'auto' } : { overflowX: 'visible', touchAction: 'auto' },
      ),
      true,
      'horizontally overflowing container excludes swipe even at scrollLeft=0',
    )

    // 显式逃生舱 data-swipe-ignore
    const ignored = document.createElement('div')
    ignored.setAttribute('data-swipe-ignore', '')
    shell.appendChild(ignored)
    assert.equal(
      isSwipeExcludedTarget(ignored, shell, () => ({ overflowX: 'visible', touchAction: 'auto' })),
      true,
    )

    // 选区辅助校验
    assert.equal(
      hasActiveTextSelection({ getSelection: () => ({ isCollapsed: false, toString: () => 'selected' }) as Selection }),
      true,
    )
    assert.equal(
      hasActiveTextSelection({ getSelection: () => ({ isCollapsed: true, toString: () => '' }) as Selection }),
      false,
    )
  } finally {
    host.remove()
  }
})

function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: Array<{ clientX: number; clientY: number }>,
  timeStamp: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>
  event.touches = type === 'touchend' || type === 'touchcancel' ? [] : points
  event.changedTouches = points
  Object.defineProperty(event, 'timeStamp', { value: timeStamp, configurable: true })
  target.dispatchEvent(event as unknown as Event)
}

test('useMobileDrawerSwipe hook: opens/closes on valid swipes and cancels on multi-touch, code blocks, or open dialogs', { timeout: 60_000 }, async () => {
  const originalWidth = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  let opens = 0
  let closes = 0

  function Harness({ sidebarOpen }: { sidebarOpen: boolean }) {
    const ref = React.useRef<HTMLDivElement | null>(null)
    useMobileDrawerSwipe({
      containerRef: ref,
      enabled: true,
      sidebarOpen,
      onOpen: () => { opens += 1 },
      onClose: () => { closes += 1 },
    })
    return e(
      'div',
      { ref, className: 'test-shell' },
      e('p', { className: 'plain-text' }, 'body'),
      e('pre', { className: 'code-block' }, 'const x = 1'),
    )
  }

  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(Harness, { sidebarOpen: false }))
    })
    const plain = container.querySelector('.plain-text')!
    const code = container.querySelector('.code-block')!

    // 正常正文区右滑打开
    dispatchTouch(plain, 'touchstart', [{ clientX: 80, clientY: 300 }], 100)
    dispatchTouch(plain, 'touchmove', [{ clientX: 100, clientY: 301 }], 130)
    dispatchTouch(plain, 'touchend', [{ clientX: 160, clientY: 302 }], 210)
    assert.equal(opens, 1)

    // 代码块内右滑放行不打开
    dispatchTouch(code, 'touchstart', [{ clientX: 80, clientY: 300 }], 300)
    dispatchTouch(code, 'touchmove', [{ clientX: 100, clientY: 300 }], 330)
    dispatchTouch(code, 'touchend', [{ clientX: 160, clientY: 300 }], 410)
    assert.equal(opens, 1)

    // 双指触控中途取消
    dispatchTouch(plain, 'touchstart', [{ clientX: 80, clientY: 300 }], 500)
    dispatchTouch(plain, 'touchmove', [{ clientX: 100, clientY: 300 }, { clientX: 150, clientY: 320 }], 530)
    dispatchTouch(plain, 'touchend', [{ clientX: 170, clientY: 300 }], 600)
    assert.equal(opens, 1)

    // 存在 Radix dialog 时拦截
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    try {
      dispatchTouch(plain, 'touchstart', [{ clientX: 80, clientY: 300 }], 700)
      dispatchTouch(plain, 'touchmove', [{ clientX: 100, clientY: 300 }], 730)
      dispatchTouch(plain, 'touchend', [{ clientX: 160, clientY: 300 }], 800)
      assert.equal(opens, 1)
    } finally {
      dialog.remove()
    }

    // 侧栏打开态下左滑关闭
    await act(async () => {
      root!.render(e(Harness, { sidebarOpen: true }))
    })
    dispatchTouch(plain, 'touchstart', [{ clientX: 220, clientY: 300 }], 900)
    dispatchTouch(plain, 'touchmove', [{ clientX: 200, clientY: 301 }], 930)
    dispatchTouch(plain, 'touchend', [{ clientX: 150, clientY: 302 }], 1010)
    assert.equal(closes, 1)
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
  }
})

test('App mobile shell: hamburger button carries the numberless attention status dot (no standalone overview button) and swipe opens/closes the drawer', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const originalMatchMedia = window.matchMedia
  const originalWidth = window.innerWidth
  const originalHash = window.location.hash
  const encoder = new TextEncoder()
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false },
  })) as typeof window.matchMedia
  window.history.replaceState(null, '', '#/a/assistant')

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') return jsonResponse({ configured: true, authenticated: true })
    if (path === '/api/events') {
      return new Response(
        hangingEventStream((send) => {
          send(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify({
                bootId: 'test-boot',
                seq: 1,
                conversations: [
                  {
                    id: 7,
                    title: '正在跑的任务',
                    profileId: 'assistant',
                    tags: [],
                    cwd: '/tmp',
                    model: 'test/model',
                    thinkingLevel: '',
                    status: 'working',
                    stateChangeSeq: 1,
                    completionSeq: 1,
                    unread: false,
                    pinned: false,
                    pendingAskCount: 0,
                    createdAt: 1000,
                    updatedAt: 1000,
                  },
                ],
                pendingAsks: [],
                plugins: [],
                ui: [],
              })}\n\n`,
            ),
          )
        }, { signal: init?.signal }),
        { status: 200 },
      )
    }
    if (path === '/api/profiles') return jsonResponse([{ id: 'assistant', name: 'Assistant' }])
    return jsonResponse([])
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(App))
    })
    const deadline = Date.now() + 3000
    while (container.querySelector('.mobile-nav-dot') === null && Date.now() < deadline) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15))
      })
    }

    const shell = container.querySelector<HTMLElement>('.helmx-shell')!
    assert.ok(shell !== null, 'App mounts the shell')
    assert.ok(!shell.classList.contains('mq-overview-on'), 'legacy overview topbar reservation class is removed')
    assert.ok(container.querySelector('.mobile-quick-overview-btn') === null, 'standalone overview quick button is removed')
    assert.ok(container.querySelector('.overview-count-badge') === null, 'numeric count badge is removed')

    const toggleBtn = container.querySelector<HTMLButtonElement>('.mobile-nav-toggle')!
    const dot = toggleBtn.querySelector<HTMLElement>('.attention-status-dot.mobile-nav-dot[data-tone="running"]')
    assert.ok(dot !== null && dot.textContent === '' && dot.getAttribute('aria-hidden') === 'true', 'hamburger carries the numberless attention status dot')
    assert.ok(toggleBtn.getAttribute('aria-label')?.includes('1') === true, 'hamburger aria-label includes attention summary')

    // 非边缘右滑打开侧栏抽屉
    const stage = container.querySelector<HTMLElement>('.helmx-main-stage')!
    await act(async () => {
      dispatchTouch(stage, 'touchstart', [{ clientX: 80, clientY: 320 }], 100)
      dispatchTouch(stage, 'touchmove', [{ clientX: 100, clientY: 321 }], 130)
      dispatchTouch(stage, 'touchend', [{ clientX: 165, clientY: 322 }], 210)
    })
    assert.ok(shell.classList.contains('sidebar-open'), 'right swipe opens the mobile sidebar drawer')
    const sidebar = container.querySelector<HTMLElement>('.helmx-sidebar')!
    const closeBtn = sidebar.querySelector<HTMLButtonElement>('.mobile-sidebar-close')!
    assert.ok(sidebar !== null && closeBtn !== null)
    assert.ok(document.activeElement === sidebar, 'right swipe focuses the sidebar dialog container')
    assert.ok(document.activeElement !== closeBtn, 'right swipe does not focus the close button')
    assert.ok(document.body.querySelector('.helmx-tooltip-content') === null, 'right swipe does not open a tooltip')

    // 抽屉打开时左滑关闭
    await act(async () => {
      dispatchTouch(shell, 'touchstart', [{ clientX: 220, clientY: 320 }], 400)
      dispatchTouch(shell, 'touchmove', [{ clientX: 198, clientY: 321 }], 430)
      dispatchTouch(shell, 'touchend', [{ clientX: 145, clientY: 322 }], 510)
    })
    assert.ok(!shell.classList.contains('sidebar-open'), 'left swipe closes the mobile sidebar drawer')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    globalThis.fetch = originalFetch
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    window.history.replaceState(null, '', originalHash || '#')
  }
})

test('mobile sidebar drawer: closed inert/visibility reachability, modal focus entry, Tab trap, Escape dismiss, and focus restoration', { timeout: 60_000 }, async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const originalFetch = globalThis.fetch
  const originalMatchMedia = window.matchMedia
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight
  const originalHash = window.location.hash
  const happyDomWindow = window as unknown as { happyDOM?: { setViewport?: (v: { width: number; height: number }) => void } }
  const encoder = new TextEncoder()
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  happyDomWindow.happyDOM?.setViewport?.({ width: 390, height: 800 })
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false },
  })) as typeof window.matchMedia
  window.history.replaceState(null, '', '#/a/assistant')

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') return jsonResponse({ configured: true, authenticated: true })
    if (path === '/api/events') {
      return new Response(
        hangingEventStream((send) => {
          send(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify({
                bootId: 'test-boot',
                seq: 1,
                conversations: [],
                pendingAsks: [],
                plugins: [],
                ui: [],
              })}\n\n`,
            ),
          )
        }, { signal: init?.signal }),
        { status: 200 },
      )
    }
    if (path === '/api/profiles') return jsonResponse([{ id: 'assistant', name: 'Assistant' }])
    return jsonResponse([])
  }) as typeof fetch

  // Verify responsive.css hides closed mobile sidebar from visibility/hit-testing and exposes it when open.
  // Unwrap the top-level `@layer host-components { ... }` wrapper because happy-dom's CSS parser skips `@layer`.
  const responsiveCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/responsive.css'),
    'utf8',
  ).replace(/@layer\s+host-components\s*\{([\s\S]*)\}\s*$/, '$1')
  const styleEl = document.createElement('style')
  styleEl.textContent = responsiveCss
  document.head.appendChild(styleEl)

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(App))
    })
    const deadline = Date.now() + 3000
    while (container.querySelector('.helmx-shell') === null && Date.now() < deadline) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15))
      })
    }

    const shell = container.querySelector<HTMLElement>('.helmx-shell')!
    const toggleBtn = container.querySelector<HTMLButtonElement>('.mobile-nav-toggle')!
    const sidebar = container.querySelector<HTMLElement>('.helmx-sidebar')!
    const main = container.querySelector<HTMLElement>('main.helmx-main-stage')!

    // 1. Closed mobile drawer: inert + aria-hidden + CSS visibility:hidden & pointer-events:none
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(toggleBtn.getAttribute('aria-controls'), sidebar.id)
    assert.equal(sidebar.getAttribute('aria-hidden'), 'true', 'closed mobile sidebar must be aria-hidden')
    assert.ok(sidebar.hasAttribute('inert'), 'closed mobile sidebar must be inert')
    assert.equal(sidebar.getAttribute('role'), null)
    assert.equal(main.hasAttribute('inert'), false, 'main stage is interactive while mobile sidebar is closed')
    assert.equal(getComputedStyle(sidebar).visibility, 'hidden', 'closed mobile sidebar must not be visually focusable')
    assert.equal(getComputedStyle(sidebar).pointerEvents, 'none')

    // 2. Open mobile drawer via toggle click -> focus moves inside sidebar, main becomes inert, dialog semantics active
    toggleBtn.focus()
    await act(async () => {
      toggleBtn.click()
    })
    assert.ok(shell.classList.contains('sidebar-open'))
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true')
    assert.equal(sidebar.getAttribute('role'), 'dialog')
    assert.equal(sidebar.getAttribute('aria-modal'), 'true')
    assert.equal(sidebar.getAttribute('aria-hidden'), null)
    assert.equal(sidebar.hasAttribute('inert'), false)
    assert.ok(main.hasAttribute('inert'), 'background main stage must be inert while mobile drawer is open')
    assert.equal(main.getAttribute('aria-hidden'), 'true')
    assert.equal(getComputedStyle(sidebar).visibility, 'visible')
    assert.equal(getComputedStyle(sidebar).pointerEvents, 'auto')
    assert.equal(hasBlockingOverlay(document), false, 'open mobile sidebar dialog itself must not block left-swipe-to-close')
    const closeBtn = sidebar.querySelector<HTMLButtonElement>('.mobile-sidebar-close')!
    assert.ok(closeBtn !== null)
    assert.ok(document.activeElement === sidebar, 'opening mobile drawer moves focus to the sidebar dialog container')
    assert.ok(document.activeElement !== closeBtn, 'opening mobile drawer does not pre-focus the close button')
    assert.ok(document.body.querySelector('.helmx-tooltip-content') === null, 'opening mobile drawer does not trigger a tooltip')
    assert.equal(closeBtn.getAttribute('title'), closeBtn.getAttribute('aria-label'))
    await act(async () => {
      closeBtn.focus()
    })
    assert.ok(document.body.querySelector('.helmx-tooltip-content') === null, 'focusing mobile close button does not open a Radix tooltip')
    await act(async () => {
      sidebar.focus()
    })

    // 3. Tab trap cycles focus inside the open mobile drawer
    const focusables = Array.from(sidebar.querySelectorAll<HTMLElement>('button:not([disabled])')).filter((el) => {
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden'
    })
    assert.ok(focusables.length >= 2)
    const firstFocusable = focusables[0]!
    const lastFocusable = focusables[focusables.length - 1]!

    const tabFromSidebarForward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(tabFromSidebarForward)
    })
    assert.equal(tabFromSidebarForward.defaultPrevented, true, 'Tab from drawer container moves focus to first control')
    assert.ok(document.activeElement === firstFocusable)

    await act(async () => {
      sidebar.focus()
    })
    const tabFromSidebarBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(tabFromSidebarBackward)
    })
    assert.equal(tabFromSidebarBackward.defaultPrevented, true, 'Shift+Tab from drawer container wraps to last control')
    assert.ok(document.activeElement === lastFocusable)

    await act(async () => {
      lastFocusable.focus()
    })
    const tabForward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(tabForward)
    })
    assert.equal(tabForward.defaultPrevented, true, 'Tab at last drawer control wraps to first')
    assert.ok(document.activeElement === firstFocusable)

    await act(async () => {
      firstFocusable.focus()
    })
    const tabBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(tabBackward)
    })
    assert.equal(tabBackward.defaultPrevented, true, 'Shift+Tab at first drawer control wraps to last')
    assert.ok(document.activeElement === lastFocusable)

    // 4. Escape closes the drawer, restores main interactivity, and returns focus to toggleBtn
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(esc)
    })
    assert.equal(esc.defaultPrevented, true)
    assert.ok(!shell.classList.contains('sidebar-open'))
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
    assert.ok(sidebar.hasAttribute('inert'))
    assert.equal(sidebar.getAttribute('aria-hidden'), 'true')
    assert.equal(main.hasAttribute('inert'), false)
    assert.equal(main.getAttribute('aria-hidden'), null)
    assert.ok(document.activeElement === toggleBtn, 'Escape dismissal restores focus to mobile nav toggle button')

    // 5. Reopen and close via .mobile-sidebar-close button -> also restores focus to toggleBtn
    await act(async () => {
      toggleBtn.click()
    })
    assert.ok(document.activeElement === sidebar)
    assert.ok(document.body.querySelector('.helmx-tooltip-content') === null)
    await act(async () => {
      closeBtn.click()
    })
    assert.ok(!shell.classList.contains('sidebar-open'))
    assert.ok(document.activeElement === toggleBtn, 'close button dismissal restores focus to mobile nav toggle button')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    styleEl.remove()
    globalThis.fetch = originalFetch
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    happyDomWindow.happyDOM?.setViewport?.({ width: originalWidth, height: originalHeight })
    window.history.replaceState(null, '', originalHash || '#')
  }
})

test('mobile coarse viewport (390x800): passive standby skips focus while all New Topic entries focus standby textarea cleanly', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const originalMatchMedia = window.matchMedia
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight
  const originalHash = window.location.hash
  const happyDomWindow = window as unknown as { happyDOM?: { setViewport?: (v: { width: number; height: number }) => void } }
  const encoder = new TextEncoder()
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const settle = async (ms = 40): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms))
    })
  }

  happyDomWindow.happyDOM?.setViewport?.({ width: 390, height: 800 })
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') || query === '(hover: none) and (pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false },
  })) as typeof window.matchMedia
  window.history.replaceState(null, '', '#/a/assistant')
  resetStandbyDrafts()

  const conv1 = {
    id: 1,
    title: 'Mobile Conv',
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 500,
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') return jsonResponse({ configured: true, authenticated: true })
    if (path === '/api/events') {
      return new Response(
        hangingEventStream((send) => {
          send(
            encoder.encode(
              `event: snapshot\ndata: ${JSON.stringify({
                bootId: 'test-mobile-focus',
                seq: 1,
                conversations: [conv1],
                pendingAsks: [],
                plugins: [],
                ui: [],
              })}\n\n`,
            ),
          )
        }, { signal: init?.signal }),
        { status: 200 },
      )
    }
    if (path === '/api/profiles') {
      return jsonResponse([
        { id: 'assistant', name: 'Assistant' },
        { id: 'coder', name: 'Coder' },
      ])
    }
    if (path === '/api/models') {
      return jsonResponse({
        models: [{ id: 'faux/model', provider: 'faux', modelId: 'model', available: true, thinkingLevels: ['off', 'high'] }],
        thinkingLevels: ['off', 'high'],
        defaultModel: 'faux/model',
      })
    }
    if (path === '/api/nodes') return jsonResponse([{ id: 'local', kind: 'local', online: true }])
    if (/^\/api\/conversations\/1(?:\?|$)/.test(path)) return jsonResponse({ ...conv1, entries: [], nextCursor: null })
    if (/^\/api\/conversations\/1\/artifacts(?:\?|$)/.test(path)) return jsonResponse([])
    return jsonResponse([])
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(App))
    })
    const deadline = Date.now() + 3000
    while (container.querySelector('.agent-standby-pane textarea.composer-textarea') === null && Date.now() < deadline) {
      await settle(15)
    }
    await settle(60)

    const shell = container.querySelector<HTMLElement>('.helmx-shell')!
    const toggleBtn = container.querySelector<HTMLButtonElement>('.mobile-nav-toggle')!
    const main = container.querySelector<HTMLElement>('main.helmx-main-stage')!
    const initialTa = container.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="assistant"] textarea.composer-textarea')!
    assert.ok(initialTa !== null)
    assert.ok(document.activeElement !== initialTa, 'passive cold load on mobile does not auto-focus standby textarea')

    // 1. Mobile sidebar drawer -> multi-profile New Topic (Coder) closes drawer and focuses standby textarea (not toggleBtn)
    await act(async () => {
      toggleBtn.click()
    })
    assert.ok(shell.classList.contains('sidebar-open'))
    const sidebarNewBtn = container.querySelector<HTMLButtonElement>('button.sidebar-new-topic-btn')!
    await act(async () => {
      sidebarNewBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle(30)
    const sidebarCoderItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Coder'))!
    assert.ok(sidebarCoderItem !== undefined)
    await act(async () => {
      sidebarCoderItem.click()
    })
    await settle(60)
    assert.ok(!shell.classList.contains('sidebar-open'), 'selecting New Topic closes mobile sidebar drawer')
    assert.equal(main.hasAttribute('inert'), false, 'main stage drops inert synchronously when drawer closes')
    const coderTa = container.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')!
    assert.ok(coderTa !== null)
    assert.ok(document.activeElement === coderTa, 'Sidebar drawer multi-profile New Topic focuses standby textarea on mobile')
    assert.ok(document.activeElement !== toggleBtn, 'drawer close must not steal focus back to hamburger button')

    // 2. Re-open mobile drawer while already on #/a/coder -> re-select Coder -> still closes drawer and re-focuses textarea
    coderTa.blur()
    await act(async () => {
      toggleBtn.click()
    })
    assert.ok(shell.classList.contains('sidebar-open'))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.sidebar-new-topic-btn')!.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }),
      )
    })
    await settle(30)
    const reselectCoderItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Coder'))!
    await act(async () => {
      reselectCoderItem.click()
    })
    await settle(60)
    assert.ok(!shell.classList.contains('sidebar-open'))
    assert.ok(
      document.activeElement === container.querySelector('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea'),
      're-selecting same agent from mobile drawer still focuses standby textarea',
    )

    // 3. Overview New Topic dropdown on mobile -> Assistant standby focuses
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(80)
    const overviewNewBtn = container.querySelector<HTMLButtonElement>('button.overview-newtopic-btn')!
    assert.ok(overviewNewBtn !== null)
    await act(async () => {
      overviewNewBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle(30)
    const overviewAssistantItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Assistant'))!
    await act(async () => {
      overviewAssistantItem.click()
    })
    await settle(60)
    assert.ok(
      document.activeElement === container.querySelector('.agent-standby-pane[data-agent="assistant"] textarea.composer-textarea'),
      'Overview New Topic dropdown focuses standby textarea on mobile',
    )

    // 4. Conversation topbar New Topic button -> standby focuses on mobile
    window.history.replaceState(null, '', '#/c/1')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(80)
    const convNewBtn = container.querySelector<HTMLButtonElement>('.conversation-topbar button[aria-label="New topic"], .conversation-topbar button[aria-label="新话题"]')!
    assert.ok(convNewBtn !== null)
    await act(async () => {
      convNewBtn.click()
    })
    await settle(60)
    assert.ok(
      document.activeElement === container.querySelector('.agent-standby-pane[data-agent="assistant"] textarea.composer-textarea'),
      'Conversation topbar New Topic focuses standby textarea on mobile',
    )

    // 5. Command Palette on mobile -> selecting Open agent: Coder with Enter focuses standby textarea
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    await settle(60)
    const modal = document.querySelector<HTMLElement>('.palette-modal')!
    assert.ok(modal !== null, 'Command Palette opens on mobile')
    const allOpts = [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
    const coderOptIdx = allOpts.findIndex((o) => o.textContent?.includes('Open agent: Coder'))
    assert.ok(coderOptIdx >= 0)
    for (let i = 0; i < coderOptIdx; i++) {
      await act(async () => {
        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
    }
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle(60)
    assert.ok(
      document.activeElement === container.querySelector('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea'),
      'Command Palette Open agent focuses standby textarea on mobile',
    )

    // 6. Escape dismissal of mobile drawer still restores focus to hamburger button
    await act(async () => {
      toggleBtn.click()
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(!shell.classList.contains('sidebar-open'))
    assert.ok(document.activeElement === toggleBtn, 'Escape still restores focus to hamburger toggle')
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
    resetStandbyDrafts()
    globalThis.fetch = originalFetch
    window.matchMedia = originalMatchMedia
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    happyDomWindow.happyDOM?.setViewport?.({ width: originalWidth, height: originalHeight })
    window.history.replaceState(null, '', originalHash || '#')
  }
})
