import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { PluginUiContribution } from '@helmx/protocol'
import { waitForCondition } from './helpers/dom-harness.js'
import {
  createShortcutsAppHarness,
  dispatchWindowKey,
  makeShortcutConversation,
  modInit,
} from './helpers/shortcuts-harness.js'
import type { HelmxShortcutDetail } from '../src/shell/shortcuts-model.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { App } = await import('../src/App.js')

const harness = createShortcutsAppHarness(createRoot, App)

describe('helmx-store-shortcuts-e2e', () => {
  afterEach(() => {
    harness.cleanup()
  }, { timeout: 60_000 })

  test('App end-to-end: Mod+Shift+O on multi-profile standby toggles profile picker, navigates with arrows/Enter, migrates draft, and replaces history', { timeout: 60_000 }, async () => {
    await harness.mountApp(
      '#/a/assistant',
      () =>
        harness.getHost()?.querySelector('[data-helmx-panel="primary"] .agent-standby-pane[data-agent="assistant"] textarea.composer-textarea') !== null &&
        harness.getHost()?.querySelector('button.agent-standby-profile-trigger') !== null,
      {
        profiles: [
          { id: 'assistant', name: 'Assistant' },
          { id: 'coder', name: 'Coder', nodeId: 'remote-1', cwd: '/remote/repo' },
        ],
        conversations: [],
      },
    )

    const host = harness.getHost()!
    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')!
    const textarea = primaryPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(textarea !== null)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      const tracker = (textarea as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(textarea, 'keep draft across picker')
      tracker?.setValue(prev)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(textarea.value, 'keep draft across picker')

    const historyLenBefore = window.history.length

    const evOpen = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, textarea)
    assert.equal(evOpen.defaultPrevented, true)
    await waitForCondition(() => document.querySelector('.agent-standby-profile-popover') !== null)
    assert.ok(document.querySelector('.agent-standby-profile-popover') !== null, 'Mod+Shift+O opens profile picker')

    const evClose = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, document.activeElement ?? undefined)
    assert.equal(evClose.defaultPrevented, true)
    await waitForCondition(() => document.querySelector('.agent-standby-profile-popover') === null && document.activeElement === textarea)
    assert.ok(document.querySelector('.agent-standby-profile-popover') === null, 'second Mod+Shift+O closes profile picker')
    assert.ok(document.activeElement === textarea, 'closing profile picker returns focus to textarea')

    dispatchWindowKey({ ...modInit('O'), shiftKey: true }, textarea)
    await waitForCondition(() => document.querySelector('.agent-standby-profile-popover') !== null)
    const popover = document.querySelector<HTMLElement>('.agent-standby-profile-popover')!
    assert.ok(popover !== null)
    await act(async () => {
      (document.activeElement ?? popover).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      (document.activeElement ?? popover).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => {
      const ta = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')
      return document.querySelector('.agent-standby-profile-popover') === null && window.location.hash === '#/a/coder' && ta !== null && document.activeElement === ta
    })

    assert.ok(document.querySelector('.agent-standby-profile-popover') === null)
    assert.equal(window.location.hash, '#/a/coder')
    assert.equal(window.history.length, historyLenBefore, 'switching standby profile replaces history instead of pushing')
    const coderTa = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')!
    assert.ok(coderTa !== null)
    assert.equal(coderTa.value, 'keep draft across picker', 'draft migrates to coder standby')
    assert.ok(document.activeElement === coderTa, 'focus lands in coder standby textarea')
  })

  test('App end-to-end: Mod+I, New Topic focus, Chinese IME keyCode 229 and Ctrl+; across primary/split/drawer/standby (shared App)', { timeout: 60_000 }, async () => {
    const imeUi: PluginUiContribution[] = [
      {
        pluginId: 'ext:plan-like',
        surface: 'commandPalette',
        spec: {
          id: 'toggle-mode',
          title: { en: 'Toggle Plan mode', 'zh-CN': '切换计划模式' },
          shortcut: 'Ctrl+.',
          actionId: 'toggle',
          scope: {},
        },
      },
    ]
    await harness.mountApp(
      '#/c/1?split=c/2',
      () =>
        harness.getHost()?.querySelector('[data-helmx-panel="primary"] textarea.composer-textarea') !== null &&
        harness.getHost()?.querySelector('[data-helmx-panel="split"] textarea.composer-textarea') !== null,
      {
        profiles: [
          { id: 'assistant', name: 'Assistant' },
          { id: 'coder', name: 'Coder' },
        ],
        conversations: [
          makeShortcutConversation(1, { status: 'idle', title: 'Primary conv', profileId: 'assistant', cwd: '/repo-one', updatedAt: 500 }),
          makeShortcutConversation(2, { status: 'idle', title: 'Split conv', profileId: 'assistant', cwd: '/repo-two' }),
          makeShortcutConversation(3, { status: 'idle', title: 'Drawer conv', profileId: 'assistant', cwd: '/repo-three' }),
        ],
        ui: imeUi,
      },
    )

    const host = harness.getHost()!
    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')!
    const splitPane = host.querySelector<HTMLElement>('[data-helmx-panel="split"]')!
    const primaryTa = primaryPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const splitTa = splitPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const primaryPlusTrigger = primaryPane.querySelector<HTMLButtonElement>('button.composer-plus-trigger')!
    assert.ok(primaryTa !== null && splitTa !== null && primaryPlusTrigger !== null)
    assert.ok(primaryPlusTrigger.title.includes('Ctrl+;'), 'plus trigger title advertises Ctrl+;')

    // ---- 1. Mod+I focus across primary, split, drawer, Activity-hidden, and Cmd+K ----
    primaryTa.blur()
    const evPrimaryI = dispatchWindowKey(modInit('i'))
    assert.equal(evPrimaryI.defaultPrevented, true)
    assert.ok(document.activeElement === primaryTa, 'Mod+I focuses primary conversation textarea')

    await act(async () => {
      splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    splitTa.blur()
    const evSplitI = dispatchWindowKey(modInit('i'))
    assert.equal(evSplitI.defaultPrevented, true)
    assert.ok(document.activeElement === splitTa, 'Mod+I focuses split conversation textarea')
    assert.ok(document.activeElement !== primaryTa)

    // Ctrl+; on split panel (using IME keyCode 229 Semicolon)
    const firstEnabledPlusMenuItem = (menu: HTMLElement): HTMLElement | null =>
      menu.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])')
    const waitPlusMenuOpen = () =>
      waitForCondition(() => {
        const menu = document.querySelector<HTMLElement>('.composer-plus-menu')
        const item = menu ? firstEnabledPlusMenuItem(menu) : null
        return item !== null && document.activeElement === item
      })
    const waitPlusMenuClosed = (expectedFocus: HTMLElement) =>
      waitForCondition(() => document.querySelectorAll('.composer-plus-menu').length === 0 && document.activeElement === expectedFocus)

    splitTa.focus()
    const splitTrigger = splitPane.querySelector<HTMLButtonElement>('button.composer-plus-trigger')!
    const evSplitOpen = dispatchWindowKey({ key: 'Process', code: 'Semicolon', keyCode: 229, ctrlKey: true, isComposing: false }, splitTa)
    assert.equal(evSplitOpen.defaultPrevented, true)
    await waitPlusMenuOpen()
    let menus = [...document.querySelectorAll<HTMLElement>('.composer-plus-menu')]
    assert.equal(menus.length, 1, 'split Ctrl+; opens split + menu')
    assert.ok(document.activeElement === firstEnabledPlusMenuItem(menus[0]!))
    assert.ok(document.activeElement !== splitTrigger)
    dispatchWindowKey({ key: ';', ctrlKey: true }, document.activeElement ?? window)
    await waitPlusMenuClosed(splitTa)
    assert.ok(document.activeElement === splitTa, 'closing split + menu returns focus to split textarea')

    // Return to primary, close split, open drawer #3 -> test Mod+I & Ctrl+; & Workbench blocking
    await act(async () => {
      primaryPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    window.history.replaceState(null, '', '#/c/1?drawer=c/3')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() => document.querySelector('.drawer-stack-dialog textarea.composer-textarea') !== null)
    const drawerDialog = document.querySelector<HTMLElement>('.drawer-stack-dialog')!
    const drawerTa = drawerDialog.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const drawerTrigger = drawerDialog.querySelector<HTMLButtonElement>('button.composer-plus-trigger')!
    drawerDialog.focus()
    const evDrawerI = dispatchWindowKey(modInit('i'))
    assert.equal(evDrawerI.defaultPrevented, true)
    assert.ok(document.activeElement === drawerTa, 'Mod+I focuses top conversation drawer textarea')

    const seenDrawerEvents: HelmxShortcutDetail[] = []
    const onDrawerShortcut = (ev: Event) => {
      const detail = (ev as CustomEvent<HelmxShortcutDetail>).detail
      if (detail?.action === 'toggle-plus-menu') seenDrawerEvents.push(detail)
    }
    window.addEventListener('helmx:shortcut', onDrawerShortcut)
    try {
      drawerTa.focus()
      const evDrawerOpen = dispatchWindowKey({ key: ';', ctrlKey: true }, drawerTa)
      assert.equal(evDrawerOpen.defaultPrevented, true)
      await waitPlusMenuOpen()
      assert.deepEqual(seenDrawerEvents[0], {
        action: 'toggle-plus-menu',
        panel: 'drawer',
        drawerConversationId: 3,
      })
      menus = [...document.querySelectorAll<HTMLElement>('.composer-plus-menu')]
      assert.equal(menus.length, 1, 'drawer Ctrl+; opens exactly one + menu')
      assert.ok(document.activeElement !== drawerTrigger)
      dispatchWindowKey({ key: ';', ctrlKey: true }, document.activeElement ?? window)
      await waitPlusMenuClosed(drawerTa)

      dispatchWindowKey(modInit('j'))
      await waitForCondition(() => document.querySelector('.helmx-workbench') !== null)
      const countBeforeWb = seenDrawerEvents.length
      const evBlockedByWb = dispatchWindowKey({ key: ';', ctrlKey: true })
      assert.equal(evBlockedByWb.defaultPrevented, false)
      assert.equal(seenDrawerEvents.length, countBeforeWb)
      dispatchWindowKey(modInit('j'))
      await waitForCondition(() => document.querySelector('.helmx-workbench') === null)
    } finally {
      window.removeEventListener('helmx:shortcut', onDrawerShortcut)
    }

    // Close drawer, navigate primary to #/c/2 -> Mod+I skips hidden #/c/1, Cmd+K Focus message input works
    window.history.replaceState(null, '', '#/c/2')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() =>
      document.querySelector('.drawer-stack-dialog') === null &&
      [...primaryPane.querySelectorAll<HTMLTextAreaElement>('textarea.composer-textarea')]
        .some((ta) => ta !== primaryTa && ta.closest('.helmx-pane')?.getAttribute('style')?.includes('none') !== true),
    )
    const conv2Ta = [...primaryPane.querySelectorAll<HTMLTextAreaElement>('textarea.composer-textarea')]
      .find((ta) => ta.closest('.helmx-pane')?.getAttribute('style')?.includes('none') !== true)!
    conv2Ta.blur()
    dispatchWindowKey(modInit('i'))
    assert.ok(document.activeElement === conv2Ta, 'Mod+I focuses visible conversation #2 and skips hidden Activity #1')

    // Primary panel Ctrl+; open & close
    const evPrimaryOpen = dispatchWindowKey({ key: ';', ctrlKey: true }, conv2Ta)
    assert.equal(evPrimaryOpen.defaultPrevented, true)
    await waitPlusMenuOpen()
    dispatchWindowKey({ key: ';', ctrlKey: true }, document.activeElement ?? window)
    await waitPlusMenuClosed(conv2Ta)

    dispatchWindowKey(modInit('k'))
    await waitForCondition(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
        .some((btn) => btn.textContent?.includes('Focus message input')),
    )
    const focusCmdRow = [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
      .find((btn) => btn.textContent?.includes('Focus message input'))!
    await act(async () => {
      focusCmdRow.click()
    })
    await waitForCondition(() => document.activeElement === conv2Ta)
    assert.ok(document.activeElement === conv2Ta, 'CommandPalette Focus message input focuses active composer')

    // ---- 2. New Topic focuses standby textarea + Ctrl+; on standby + Overview IME keyCode 229 ----
    const evNewTopic = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, conv2Ta)
    assert.equal(evNewTopic.defaultPrevented, true)
    await waitForCondition(() => {
      const ta = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane textarea.composer-textarea')
      return ta !== null && document.activeElement === ta
    })
    const standbyTa = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane textarea.composer-textarea')!
    const standbyTrigger = primaryPane.querySelector<HTMLButtonElement>('.agent-standby-pane button.composer-plus-trigger')!
    const evStandbyOpen = dispatchWindowKey({ key: ';', ctrlKey: true }, standbyTa)
    assert.equal(evStandbyOpen.defaultPrevented, true)
    await waitPlusMenuOpen()
    assert.equal(document.querySelectorAll('.composer-plus-menu').length, 1, 'standby Ctrl+; ignores hidden Activity')
    assert.ok(document.activeElement !== standbyTrigger)
    dispatchWindowKey({ key: ';', ctrlKey: true }, document.activeElement ?? window)
    await waitPlusMenuClosed(standbyTa)

    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() => primaryPane.querySelector('.overview-search-box input') !== null && host.querySelector('button.sidebar-new-topic-btn') !== null)

    // IME keyCode 229 inside Overview search input
    const overviewSearch = primaryPane.querySelector<HTMLInputElement>('.overview-search-box input')!
    overviewSearch.focus()
    const evPlain229InInput = dispatchWindowKey({ key: 'Process', code: 'Slash', keyCode: 229, isComposing: false }, overviewSearch)
    assert.equal(evPlain229InInput.defaultPrevented, false, 'plain keyCode 229 inside visible input must not be swallowed')
    const seenShortcuts: HelmxShortcutDetail[] = []
    const onShortcut = (ev: Event) => {
      seenShortcuts.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
    }
    window.addEventListener('helmx:shortcut', onShortcut)
    try {
      const evComposingModSlash = dispatchWindowKey({ ...modInit('Process'), code: 'Slash', keyCode: 229, isComposing: true }, overviewSearch)
      assert.equal(evComposingModSlash.defaultPrevented, false, 'isComposing: true blocks Mod+/')
      const evImeModSlash = dispatchWindowKey({ ...modInit('Process'), code: 'Slash', keyCode: 229, isComposing: false }, overviewSearch)
      assert.equal(evImeModSlash.defaultPrevented, true)
      await waitForCondition(() => document.querySelector('.shortcuts-modal') !== null)
      dispatchWindowKey({ ...modInit('Process'), code: 'Slash', keyCode: 229, isComposing: false })
      await waitForCondition(() => document.querySelector('.shortcuts-modal') === null)
      const beforeDot = seenShortcuts.length
      const evImeCtrlDot = dispatchWindowKey({ key: 'Process', code: 'Period', keyCode: 229, ctrlKey: true, isComposing: false }, overviewSearch)
      assert.equal(evImeCtrlDot.defaultPrevented, true)
      assert.deepEqual(seenShortcuts.slice(beforeDot), [{ action: 'toggle-plan-mode', panel: 'primary' }])
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }

    // Sidebar multi-profile dropdown -> Coder standby
    const sidebarNewBtn = host.querySelector<HTMLButtonElement>('button.sidebar-new-topic-btn')!
    await act(async () => {
      sidebarNewBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some((el) => el.textContent?.includes('Coder')))
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Coder'))!.click()
    })
    await waitForCondition(() => {
      const ta = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')
      return ta !== null && document.activeElement === ta
    })

    // Overview multi-profile dropdown -> Assistant standby
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() => primaryPane.querySelector('button.overview-newtopic-btn') !== null)
    await act(async () => {
      primaryPane.querySelector<HTMLButtonElement>('button.overview-newtopic-btn')!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some((el) => el.textContent?.includes('Assistant')))
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Assistant'))!.click()
    })
    await waitForCondition(() => {
      const ta = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="assistant"] textarea.composer-textarea')
      return ta !== null && document.activeElement === ta
    })

    // Cmd+K Open agent: Coder -> standby textarea focused
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() => primaryPane.querySelector('.overview-search-box input') !== null)
    const search2 = primaryPane.querySelector<HTMLInputElement>('.overview-search-box input')!
    search2.focus()
    dispatchWindowKey(modInit('k'), search2)
    await waitForCondition(() =>
      document.querySelector('.palette-modal') !== null &&
      [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
        .some((o) => o.textContent?.includes('Open agent: Coder')),
    )
    const modal = document.querySelector<HTMLElement>('.palette-modal')!
    const allOpts = [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
    const coderOptIdx = allOpts.findIndex((o) => o.textContent?.includes('Open agent: Coder'))
    for (let i = 0; i < coderOptIdx; i++) {
      await act(async () => {
        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
    }
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => {
      const ta = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')
      return ta !== null && document.activeElement === ta
    })
  })
})
