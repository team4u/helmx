/**
 * @helmx/ui Round 4 standard primitives unit + DOM interaction tests:
 * - MasterDetail: layout classes, mobilePane switching, masterWidth CSS var, ARIA landmarks;
 * - ScreenSection: static title/leading/count/rule preservation + controlled & uncontrolled collapsible mode;
 * - BatchBar: selected count attribute/label, localized & custom exit, exitDisabled, actions/children;
 * - PopoverHeader & PopoverItem: structured slots, divider, active/selected/danger states, Popover namespace;
 * - useListKeyboardNav: uncontrolled & controlled mode, ArrowDown/Up wrapping & clamping, Home/End, Enter,
 *   IME composition guard, count shrinking clamp, enabled=false reset, and scrollIntoView ref invocation.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import {
  BatchBar,
  MasterDetail,
  Popover,
  PopoverHeader,
  PopoverItem,
  ScreenSection,
  UiLocaleProvider,
  useListKeyboardNav,
} from '../src/index.js'

const e = React.createElement
const TIMEOUT = { timeout: 60_000 } as const

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ensureHappyDom()
  resetHappyDom()
}, TIMEOUT)

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
    root = null
  }
  container?.remove()
  container = null
  resetHappyDom()
}, TIMEOUT)

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
  return container
}

test('MasterDetail renders landmarks, mobilePane state, and numeric/string masterWidth CSS variable', TIMEOUT, () => {
  const html = renderToString(
    e(MasterDetail, {
      className: 'chg-split-stage',
      masterWidth: 320,
      masterLabel: 'Files',
      detailLabel: 'Inspector',
      mobilePane: 'detail',
      masterClassName: 'master-extra',
      detailClassName: 'detail-extra',
      master: e('div', null, 'left list'),
      detail: e('div', null, 'right diff'),
    }),
  )
  assert.match(html, /class="helmx-master-detail chg-split-stage"/)
  assert.match(html, /data-mobile-pane="detail"/)
  assert.match(html, /--helmx-master-width:\s*320px/)
  assert.match(html, /<aside class="helmx-master-detail-master master-extra" aria-label="Files"><div>left list<\/div><\/aside>/)
  assert.match(html, /<main class="helmx-master-detail-detail detail-extra" aria-label="Inspector"><div>right diff<\/div><\/main>/)

  const strHtml = renderToString(
    e(MasterDetail, {
      masterWidth: '24rem',
      master: 'm',
      detail: 'd',
    }),
  )
  assert.match(strHtml, /data-mobile-pane="master"/)
  assert.match(strHtml, /--helmx-master-width:24rem/)
})

test('ScreenSection supports static rule/leading/count and uncontrolled + controlled collapsible toggling', TIMEOUT, () => {
  const staticHtml = renderToString(
    e(
      ScreenSection,
      {
        title: 'Nodes',
        leading: e('span', { className: 'dot' }),
        count: 4,
        rule: true,
        'data-group-key': 'nodes',
      } as React.ComponentProps<typeof ScreenSection> & { 'data-group-key': string },
      e('p', null, 'Static body'),
    ),
  )
  assert.match(staticHtml, /data-group-key="nodes"/)
  assert.match(staticHtml, /class="screen-section-title"/)
  assert.match(staticHtml, /class="screen-section-count tabular-nums">4</)
  assert.match(staticHtml, /class="screen-section-rule" aria-hidden="true"/)

  function UncontrolledHarness() {
    return e(
      ScreenSection,
      {
        title: 'Quiet',
        count: 2,
        rule: true,
        collapsible: true,
        defaultOpen: true,
        headingId: 'sec-quiet',
      },
      e('div', { className: 'section-body' }, 'Visible body'),
    )
  }

  const host = mount(e(UncontrolledHarness))
  const section = host.querySelector<HTMLElement>('section.screen-section')
  const toggle = host.querySelector<HTMLButtonElement>('button.screen-section-toggle')
  assert.ok(section !== null && toggle !== null)
  assert.equal(section.getAttribute('aria-labelledby'), 'sec-quiet')
  assert.equal(section.getAttribute('data-open'), 'true')
  assert.equal(toggle.id, 'sec-quiet')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.ok(host.querySelector('.section-body') !== null)

  act(() => {
    toggle.click()
  })
  assert.equal(section.getAttribute('data-open'), 'false')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.ok(host.querySelector('.section-body') === null)

  const seenNext: boolean[] = []
  function ControlledHarness({ isOpen }: { isOpen: boolean }) {
    return e(
      ScreenSection,
      {
        title: 'Controlled',
        collapsible: true,
        open: isOpen,
        onOpenChange: (next) => seenNext.push(next),
      },
      e('div', { className: 'controlled-body' }, 'Body'),
    )
  }

  act(() => {
    root?.render(e(ControlledHarness, { isOpen: false }))
  })
  const controlledToggle = host.querySelector<HTMLButtonElement>('button.screen-section-toggle')
  assert.ok(controlledToggle !== null)
  assert.equal(controlledToggle.getAttribute('aria-expanded'), 'false')
  assert.ok(host.querySelector('.controlled-body') === null)

  act(() => {
    controlledToggle.click()
  })
  assert.deepEqual(seenNext, [true])
  // Remains closed until parent updates controlled `open` prop
  assert.ok(host.querySelector('.controlled-body') === null)

  act(() => {
    root?.render(e(ControlledHarness, { isOpen: true }))
  })
  assert.ok(host.querySelector('.controlled-body') !== null)
})

test('BatchBar renders count attribute, localized default close label, exitDisabled, and actions/children', TIMEOUT, () => {
  let exitCalls = 0
  const host = mount(
    e(
      UiLocaleProvider,
      { locale: 'zh-CN' },
      e(BatchBar, {
        selectedCount: 3,
        selectedLabel: '已选 3 项',
        exitDisabled: true,
        onExit: () => {
          exitCalls += 1
        },
        actions: e('button', { type: 'button', className: 'bulk-delete' }, '删除'),
      }),
    ),
  )

  const bar = host.querySelector<HTMLElement>('.batch-bar')
  assert.ok(bar !== null)
  assert.equal(bar.getAttribute('data-selected-count'), '3')
  assert.equal(host.querySelector('.batch-bar-count')?.textContent, '已选 3 项')
  const exitBtn = host.querySelector<HTMLButtonElement>('.batch-bar-header button')
  assert.ok(exitBtn !== null)
  assert.equal(exitBtn.textContent, '关闭')
  assert.equal(exitBtn.disabled, true)

  act(() => {
    exitBtn.click()
  })
  assert.equal(exitCalls, 0)

  act(() => {
    root?.render(
      e(
        BatchBar,
        {
          selectedCount: 2,
          selectedLabel: '2 selected',
          exitLabel: 'Done',
          onExit: () => {
            exitCalls += 1
          },
        },
        e('span', { className: 'fallback-action' }, 'Archive'),
      ),
    )
  })
  const enabledExit = host.querySelector<HTMLButtonElement>('.batch-bar-header button')
  assert.ok(enabledExit !== null)
  assert.equal(enabledExit.textContent, 'Done')
  act(() => {
    enabledExit.click()
  })
  assert.equal(exitCalls, 1)
  assert.equal(host.querySelector('.batch-bar-actions .fallback-action')?.textContent, 'Archive')
})

test('PopoverHeader and PopoverItem render structured slots, divider, and Popover namespace', TIMEOUT, () => {
  assert.ok(Popover.Header === PopoverHeader)
  assert.ok(Popover.Item === PopoverItem)

  const html = renderToString(
    e(
      'div',
      null,
      e(PopoverHeader, {
        title: 'Switch profile',
        subtitle: 'Choose default agent',
        trailing: e('span', { className: 'hint' }, 'Esc'),
        divider: true,
      }),
      e(
        PopoverItem,
        {
          active: true,
          selected: true,
          danger: true,
          icon: 'bot',
          meta: 'claude-sonnet-4',
          trailing: e('span', { className: 'check' }, 'OK'),
        },
        'Architect',
      ),
    ),
  )

  assert.match(html, /class="popover-header popover-header-divider"/)
  assert.match(html, /class="popover-header-main"/)
  assert.match(html, /class="popover-header-title">Switch profile</)
  assert.match(html, /class="popover-header-subtitle">Choose default agent</)
  assert.match(html, /class="popover-header-trailing"><span class="hint">Esc</)
  assert.match(html, /class="popover-item popover-item-active popover-item-danger"/)
  assert.match(html, /data-active="true"/)
  assert.match(html, /data-selected="true"/)
  assert.match(html, /class="popover-item-icon"/)
  assert.match(html, /class="popover-item-body">Architect<span class="popover-item-meta">claude-sonnet-4</)
  assert.match(html, /class="popover-item-trailing"><span class="check">OK</)
})

test('useListKeyboardNav handles wrapping, clamping, Home/End, Enter, IME, shrinking count, disabled reset, and scrollIntoView', TIMEOUT, () => {
  const scrollCalls: Array<ScrollIntoViewOptions | boolean | undefined> = []
  const origScrollIntoView = window.HTMLElement.prototype.scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = function (arg?: ScrollIntoViewOptions | boolean) {
    scrollCalls.push(arg)
  }

  try {
    const selected: number[] = []
    let latestNav!: ReturnType<typeof useListKeyboardNav>

    function UncontrolledNavHarness({
      count,
      loop = true,
      enabled = true,
      initialIndex = -1,
    }: {
      count: number
      loop?: boolean
      enabled?: boolean
      initialIndex?: number
    }) {
      const nav = useListKeyboardNav({
        count,
        loop,
        enabled,
        initialIndex,
        onSelect: (idx) => selected.push(idx),
      })
      latestNav = nav
      return e(
        'div',
        { 'data-active-index': String(nav.activeIndex) },
        e('input', {
          className: 'nav-input',
          onKeyDown: (ev: React.KeyboardEvent<HTMLInputElement>) => nav.onKeyDown(ev),
        }),
        Array.from({ length: count }, (_, idx) =>
          e(
            'button',
            {
              key: idx,
              ref: nav.getItemRef(idx),
              type: 'button',
              className: `nav-item${idx === nav.activeIndex ? ' is-active' : ''}`,
            },
            `Item ${idx}`,
          ),
        ),
      )
    }

    const host = mount(e(UncontrolledNavHarness, { count: 3, loop: true }))
    const input = host.querySelector<HTMLInputElement>('.nav-input')!
    assert.equal(latestNav.activeIndex, -1)

    // IME composition must be ignored (neither native isComposing nor keyCode 229)
    act(() => {
      latestNav.onKeyDown({
        key: 'ArrowDown',
        keyCode: 229,
        isComposing: true,
        preventDefault: () => {
          throw new Error('IME event must not preventDefault')
        },
      })
    })
    assert.equal(latestNav.activeIndex, -1)

    // ArrowDown from -1 -> 0; wraps 2 -> 0 when loop=true
    const fireKey = (key: string) => {
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
    fireKey('ArrowDown')
    assert.equal(latestNav.activeIndex, 0)
    assert.ok(scrollCalls.length >= 1)
    assert.deepEqual(scrollCalls.at(-1), { block: 'nearest' })

    fireKey('End')
    assert.equal(latestNav.activeIndex, 2)
    fireKey('ArrowDown')
    assert.equal(latestNav.activeIndex, 0)
    fireKey('ArrowUp')
    assert.equal(latestNav.activeIndex, 2)
    fireKey('Home')
    assert.equal(latestNav.activeIndex, 0)
    fireKey('Enter')
    assert.deepEqual(selected, [0])

    // Shrinking count clamps activeIndex to count - 1, then -1 when count = 0
    act(() => {
      latestNav.setActiveIndex(2)
    })
    assert.equal(latestNav.activeIndex, 2)
    act(() => {
      root?.render(e(UncontrolledNavHarness, { count: 2, loop: false }))
    })
    assert.equal(latestNav.activeIndex, 1)

    // loop=false clamps at 0 and count - 1
    fireKey('ArrowDown')
    assert.equal(latestNav.activeIndex, 1)
    fireKey('ArrowUp')
    assert.equal(latestNav.activeIndex, 0)
    fireKey('ArrowUp')
    assert.equal(latestNav.activeIndex, 0)

    // enabled=false resets to initialIndex and ignores keydown
    act(() => {
      root?.render(e(UncontrolledNavHarness, { count: 2, enabled: false, initialIndex: -1 }))
    })
    assert.equal(latestNav.activeIndex, -1)
    fireKey('ArrowDown')
    assert.equal(latestNav.activeIndex, -1)

    // Shrinking count to 0 clamps to -1
    act(() => {
      root?.render(e(UncontrolledNavHarness, { count: 0, enabled: true }))
    })
    assert.equal(latestNav.activeIndex, -1)

    // Controlled mode check
    const controlledChanges: number[] = []
    function ControlledNavHarness({ activeIndex }: { activeIndex: number }) {
      const nav = useListKeyboardNav({
        count: 3,
        activeIndex,
        onActiveIndexChange: (next) => controlledChanges.push(next),
      })
      latestNav = nav
      return e('div', null, String(nav.activeIndex))
    }

    act(() => {
      root?.render(e(ControlledNavHarness, { activeIndex: 1 }))
    })
    act(() => {
      latestNav.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
    })
    assert.deepEqual(controlledChanges, [2])
  } finally {
    window.HTMLElement.prototype.scrollIntoView = origScrollIntoView
  }
})
