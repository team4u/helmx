import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, PluginSummary, PluginUiContribution, Profile } from '@helmx/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import { flushMicrotasks, waitForCondition } from './helpers/dom-harness.js'
import {
  activeTargetForPanel,
  resolveFocusedPanel,
} from '../src/lib/panel-focus.js'
import {
  ESC_ABORT_WINDOW_MS,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  formatModShiftShortcut,
  formatModShortcut,
  getStoredSidebarCollapsed,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  hasNonPlusMenuOverlayOpen,
  hasNonProfilePickerDialogOpen,
  isEditableShortcutTarget,
  isInlineInputEscapeTarget,
  persistSidebarCollapsed,
  type HelmxShortcutDetail,
} from '../src/shell/shortcuts-model.js'
import { resetStandbyDrafts } from '../src/conversation/standby-model.js'
import type { ActiveModal, HelmxStoreValue, ResolvedTarget } from '../src/lib/types.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
const { App } = await import('../src/App.js')

const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined
let sendEvent: SseFrameSender | undefined
let capturedStore: HelmxStoreValue | undefined
let abortCalls: number[] = []
let artifactRequests: number[] = []

function makeConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `测试会话 ${id}`,
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
    createdAt: id,
    updatedAt: id,
    ...overrides,
  }
}

interface FetchHarnessOptions {
  authenticated?: boolean
  conversations?: ConversationSummary[]
  profiles?: Profile[]
  plugins?: PluginSummary[]
  ui?: PluginUiContribution[]
}

function installFetch(options: FetchHarnessOptions = {}): void {
  const authenticated = options.authenticated ?? true
  const conversations = options.conversations ?? [
    makeConversation(1, { status: 'idle', title: '主屏会话' }),
    makeConversation(2, { status: 'working', title: '分屏会话' }),
  ]
  const profiles = options.profiles ?? [{ id: 'assistant', name: 'Assistant' }]
  const plugins = options.plugins ?? []
  const ui = options.ui ?? []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === '/api/profiles' && method === 'GET') {
      return new Response(JSON.stringify(profiles), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === '/api/models' && method === 'GET') {
      return new Response(
        JSON.stringify({
          models: [
            {
              id: 'faux/model',
              provider: 'faux',
              modelId: 'model',
              available: true,
              thinkingLevels: ['off', 'high'],
            },
          ],
          thinkingLevels: ['off', 'high'],
          defaultModel: 'faux/model',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    if (url === '/api/nodes' && method === 'GET') {
      return new Response(
        JSON.stringify([{ id: 'local', kind: 'local', online: true }]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    if (url === '/api/events') {
      return new Response(
        hangingEventStream(
          (send) => {
            sendEvent = send
            send(
              new TextEncoder().encode(
                `event: snapshot\ndata: ${JSON.stringify({
                  bootId: 'shortcuts-test-boot',
                  seq: 1,
                  conversations,
                  pendingAsks: [],
                  plugins,
                  ui,
                })}\n\n`,
              ),
            )
          },
          {
            signal: init?.signal,
            onTeardown: () => {
              sendEvent = undefined
            },
          },
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const abortMatch = /^\/api\/conversations\/(\d+)\/abort$/.exec(url)
    if (abortMatch && method === 'POST') {
      const id = Number(abortMatch[1])
      abortCalls.push(id)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const artifactsMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactsMatch && method === 'GET') {
      const id = Number(artifactsMatch[1])
      artifactRequests.push(id)
      return new Response(
        JSON.stringify([
          {
            id: `art-${id}`,
            conversationId: id,
            name: id === 2 ? 'split-artifact.md' : 'primary-artifact.md',
            mimeType: 'text/markdown',
            size: 128,
            createdAt: id,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const detailMatch = /^\/api\/conversations\/(\d+)(?:\?|$)/.exec(url)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      const found = conversations.find((c) => c.id === id) ?? makeConversation(id)
      return new Response(JSON.stringify({ ...found, entries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET') {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

function ShortcutHarness(): React.ReactNode {
  const store = useHelmxStore()
  capturedStore = store
  return (
    <div data-testid="shortcut-harness">
      <div
        data-helmx-panel="primary"
        tabIndex={-1}
        onPointerDownCapture={() => store.setFocusedPanel?.('primary')}
        onFocusCapture={() => store.setFocusedPanel?.('primary')}
      >
        <input data-testid="primary-input" type="text" />
      </div>
      {store.splitTarget !== null && (
        <div
          data-helmx-panel="split"
          tabIndex={-1}
          onPointerDownCapture={() => store.setFocusedPanel?.('split')}
          onFocusCapture={() => store.setFocusedPanel?.('split')}
        >
          <input data-testid="split-input" type="text" />
        </div>
      )}
      <div
        data-testid="esc-consumer"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
          }
        }}
      >
        <input data-testid="esc-consumer-input" type="text" />
      </div>
    </div>
  )
}

async function mountProvider(
  hash: string,
  options: FetchHarnessOptions & { escAbortWindowMs?: number } = {},
): Promise<HelmxStoreValue> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(options)
  await act(async () => {
    root = createRoot(host!)
    root.render(
      <HelmxStoreProvider {...(options.escAbortWindowMs !== undefined ? { escAbortWindowMs: options.escAbortWindowMs } : {})}>
        <ShortcutHarness />
      </HelmxStoreProvider>,
    )
  })
  await waitForCondition(
    () =>
      capturedStore !== undefined &&
      capturedStore.authReady &&
      (options.authenticated === false || (capturedStore.sseConnected && capturedStore.profilesLoaded)),
  )
  assert.ok(capturedStore, 'HelmxStoreProvider must supply the store to child components')
  return capturedStore
}

async function mountApp(
  hash: string,
  readyPred: () => boolean,
  options: FetchHarnessOptions = {},
): Promise<void> {
  window.history.replaceState(null, '', hash)
  installFetch(options)
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(<App />)
  })
  await waitForCondition(() => host?.querySelector('.helmx-shell') !== null && readyPred())
}

import { modInit, dispatchWindowKey } from './helpers/shortcuts-harness.js'
describe("helmx-store-shortcuts", () => {


  afterEach(() => {
    if (root !== undefined) {
      act(() => root?.unmount())
    }
    root = undefined
    host?.remove()
    host = undefined
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/')
    globalThis.fetch = originalFetch
    sendEvent = undefined
    capturedStore = undefined
    abortCalls = []
    artifactRequests = []
    resetStandbyDrafts()
    window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  }, { timeout: 60_000 })

  test('shortcuts-model DOM and localStorage helpers: persistence, editable targets, overlay and inline-input guards', { timeout: 60_000 }, () => {
    persistSidebarCollapsed(true)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')
    assert.equal(getStoredSidebarCollapsed(), true)

    persistSidebarCollapsed(false)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '0')
    assert.equal(getStoredSidebarCollapsed(), false)

    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true')
    assert.equal(getStoredSidebarCollapsed(), true)

    assert.equal(hasNonPlusMenuOverlayOpen(), false)
    const plusWrapper = document.createElement('div')
    plusWrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const plusMenu = document.createElement('div')
    plusMenu.setAttribute('role', 'menu')
    plusMenu.className = 'composer-plus-menu'
    plusWrapper.appendChild(plusMenu)
    document.body.appendChild(plusWrapper)
    assert.equal(hasNonPlusMenuOverlayOpen(), false, 'open .composer-plus-menu must allow re-pressing Ctrl+; to close it')

    const otherMenu = document.createElement('div')
    otherMenu.setAttribute('role', 'menu')
    otherMenu.className = 'other-menu'
    document.body.appendChild(otherMenu)
    assert.equal(hasNonPlusMenuOverlayOpen(), true, 'other open [role="menu"] must block Ctrl+;')
    otherMenu.remove()

    const otherListbox = document.createElement('div')
    otherListbox.setAttribute('role', 'listbox')
    document.body.appendChild(otherListbox)
    assert.equal(hasNonPlusMenuOverlayOpen(), true, 'open [role="listbox"] must block Ctrl+;')
    otherListbox.remove()
    plusWrapper.remove()

    const editableScope = document.createElement('div')
    const editableInput = document.createElement('input')
    const editableTextarea = document.createElement('textarea')
    const editableSelect = document.createElement('select')
    const editableDiv = document.createElement('div')
    editableDiv.setAttribute('contenteditable', 'true')
    const editableChild = document.createElement('span')
    editableDiv.appendChild(editableChild)
    const nonEditableDiv = document.createElement('div')
    nonEditableDiv.setAttribute('contenteditable', 'false')
    const plainButton = document.createElement('button')
    const hiddenWrap = document.createElement('div')
    hiddenWrap.style.display = 'none'
    const hiddenTextarea = document.createElement('textarea')
    hiddenWrap.appendChild(hiddenTextarea)
    const inertWrap = document.createElement('div')
    inertWrap.setAttribute('inert', '')
    const inertInput = document.createElement('input')
    inertWrap.appendChild(inertInput)
    const detachedInput = document.createElement('input')
    editableScope.append(
      editableInput,
      editableTextarea,
      editableSelect,
      editableDiv,
      nonEditableDiv,
      plainButton,
      hiddenWrap,
      inertWrap,
    )
    document.body.appendChild(editableScope)
    assert.equal(isEditableShortcutTarget(editableInput), true)
    assert.equal(isEditableShortcutTarget(editableTextarea), true)
    assert.equal(isEditableShortcutTarget(editableSelect), true)
    assert.equal(isEditableShortcutTarget(editableDiv), true)
    assert.equal(isEditableShortcutTarget(editableChild), true)
    assert.equal(isEditableShortcutTarget(nonEditableDiv), false)
    assert.equal(isEditableShortcutTarget(plainButton), false)
    assert.equal(isEditableShortcutTarget(hiddenTextarea), false)
    assert.equal(isEditableShortcutTarget(inertInput), false)
    assert.equal(isEditableShortcutTarget(detachedInput), false)
    editableScope.remove()

    assert.equal(hasBlockingAlertDialog(), false)
    assert.equal(hasDialogOpen(), false)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    assert.equal(hasDialogOpen(), true)
    assert.equal(hasNonModelPickerDialogOpen(), true)
    dialog.remove()

    const modelPopover = document.createElement('div')
    modelPopover.setAttribute('role', 'dialog')
    modelPopover.className = 'helmx-popover-content composer-model-popover'
    document.body.appendChild(modelPopover)
    assert.equal(hasDialogOpen(), true)
    assert.equal(hasNonModelPickerDialogOpen(), false)
    assert.equal(hasNonProfilePickerDialogOpen(), true)
    modelPopover.remove()

    const profilePopover = document.createElement('div')
    profilePopover.setAttribute('role', 'dialog')
    profilePopover.className = 'helmx-popover-content composer-popover agent-standby-profile-popover'
    document.body.appendChild(profilePopover)
    assert.equal(hasDialogOpen(), true)
    assert.equal(hasNonProfilePickerDialogOpen(), false)
    assert.equal(hasNonModelPickerDialogOpen(), true)
    profilePopover.remove()

    const alertDialog = document.createElement('div')
    alertDialog.setAttribute('role', 'alertdialog')
    document.body.appendChild(alertDialog)
    assert.equal(hasBlockingAlertDialog(), true)
    assert.equal(hasDialogOpen(), true)
    alertDialog.remove()

    const topbar = document.createElement('div')
    topbar.className = 'pane-topbar'
    const inlineInput = document.createElement('input')
    topbar.appendChild(inlineInput)
    document.body.appendChild(topbar)
    assert.equal(isInlineInputEscapeTarget(inlineInput), true)
    topbar.remove()

    const bareInput = document.createElement('input')
    assert.equal(isInlineInputEscapeTarget(bareInput), false)
  })

  test('HelmxStoreProvider ignores global shortcuts while unauthenticated', { timeout: 60_000 }, async () => {
    await mountProvider('#/c/1', { authenticated: false })

    const fired: HelmxShortcutDetail[] = []
    const listener = (ev: Event) => {
      fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
    }
    window.addEventListener('helmx:shortcut', listener)

    try {
      dispatchWindowKey(modInit('k'))
      dispatchWindowKey(modInit('/'))
      dispatchWindowKey({ ...modInit('o'), shiftKey: true })
      dispatchWindowKey(modInit('b'))
      dispatchWindowKey(modInit('j'))
      dispatchWindowKey({ key: 'l', ctrlKey: true })
      dispatchWindowKey({ key: 'o', ctrlKey: true })
      dispatchWindowKey({ key: '.', ctrlKey: true })
      dispatchWindowKey({ key: ';', ctrlKey: true })
      dispatchWindowKey({ key: 'Escape' })
      dispatchWindowKey({ key: 'Escape' })
      await flushMicrotasks()

      assert.equal(fired.length, 0)
      act(() => {
        window.dispatchEvent(new CustomEvent('helmx:shortcut', { detail: { action: 'open-shortcuts', panel: 'primary' } }))
      })
      assert.equal(capturedStore?.activeModal, null)
      assert.equal(capturedStore?.sidebarCollapsed, false)
      assert.equal(capturedStore?.workbenchOpen, false)
      assert.equal(abortCalls.length, 0)
    } finally {
      window.removeEventListener('helmx:shortcut', listener)
    }
  })

  test('HelmxStoreProvider split-focus routing and global single-key shortcut dispatch (Ctrl+L/O, Mod+K/B/J)', { timeout: 60_000 }, async () => {
    const store = await mountProvider('#/c/1')
    assert.equal(store.focusedPanel, 'primary')

    // Open the split, test Pointer/Focus entering split, and closing the split auto-resets to primary
    await act(async () => {
      capturedStore?.openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
    })
    await flushMicrotasks()
    assert.deepEqual(capturedStore?.splitTarget, { kind: 'conversation', conversationId: 2 })

    const splitInput = document.querySelector<HTMLElement>('[data-testid="split-input"]')
    const primaryInput = document.querySelector<HTMLElement>('[data-testid="primary-input"]')
    assert.ok(splitInput && primaryInput)

    await act(async () => {
      splitInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    assert.equal(capturedStore?.focusedPanel, 'split')

    const fired: HelmxShortcutDetail[] = []
    const onShortcut = (ev: Event) => {
      fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
    }
    window.addEventListener('helmx:shortcut', onShortcut)

    try {
      const evL1 = dispatchWindowKey({ key: 'l', ctrlKey: true })
      assert.equal(evL1.defaultPrevented, true, 'Ctrl+L must call preventDefault')

      const evO1 = dispatchWindowKey({ key: 'o', ctrlKey: true })
      assert.equal(evO1.defaultPrevented, true, 'Ctrl+O must call preventDefault')

      const evDot1 = dispatchWindowKey({ key: '.', ctrlKey: true })
      assert.equal(evDot1.defaultPrevented, true, 'Ctrl+. must call preventDefault')

      const evSemi1 = dispatchWindowKey({ key: ';', ctrlKey: true })
      assert.equal(evSemi1.defaultPrevented, true, 'Ctrl+; must call preventDefault')

      assert.deepEqual(fired, [
        { action: 'toggle-model-picker', panel: 'split' },
        { action: 'toggle-process-groups', panel: 'split' },
        { action: 'toggle-plan-mode', panel: 'split' },
        { action: 'toggle-plus-menu', panel: 'split' },
      ])

      // Open .composer-plus-menu -> re-pressing Ctrl+; still dispatches toggle-plus-menu (not blocked by its own menu)
      const selfPlusMenu = document.createElement('div')
      selfPlusMenu.setAttribute('role', 'menu')
      selfPlusMenu.className = 'composer-plus-menu'
      document.body.appendChild(selfPlusMenu)
      const countBeforePlusToggle = fired.length
      const evSemiClose = dispatchWindowKey({ key: ';', ctrlKey: true })
      assert.equal(evSemiClose.defaultPrevented, true, 'Ctrl+; must still dispatch when .composer-plus-menu is open')
      assert.deepEqual(fired.slice(countBeforePlusToggle), [{ action: 'toggle-plus-menu', panel: 'split' }])
      selfPlusMenu.remove()

      // Other open [role="listbox"] blocks Ctrl+;
      const otherList = document.createElement('div')
      otherList.setAttribute('role', 'listbox')
      document.body.appendChild(otherList)
      const countBeforeListBlock = fired.length
      const evSemiBlockedByList = dispatchWindowKey({ key: ';', ctrlKey: true })
      assert.equal(evSemiBlockedByList.defaultPrevented, false)
      assert.equal(fired.length, countBeforeListBlock)
      otherList.remove()

      // Switch back to primary, then to split, and verify closing the split auto-resets to primary
      await act(async () => {
        primaryInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      })
      assert.equal(capturedStore?.focusedPanel, 'primary')
      await act(async () => {
        splitInput.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      })
      assert.equal(capturedStore?.focusedPanel, 'split')

      await act(async () => {
        capturedStore?.closeSplit()
      })
      assert.equal(capturedStore?.splitTarget, null)
      assert.equal(capturedStore?.focusedPanel, 'primary')

      const evL2 = dispatchWindowKey({ key: 'l', ctrlKey: true })
      assert.equal(evL2.defaultPrevented, true)
      assert.deepEqual(fired[fired.length - 1], { action: 'toggle-model-picker', panel: 'primary' })

      // With the ModelPicker popover open (carrying role="dialog" + .composer-model-popover):
      // a second Ctrl+L still dispatches toggle-model-picker to close the popover; Ctrl+O stays blocked
      const modelPopover = document.createElement('div')
      modelPopover.setAttribute('role', 'dialog')
      modelPopover.className = 'helmx-popover-content composer-model-popover'
      document.body.appendChild(modelPopover)
      const countBeforePopover = fired.length
      const evLToggleClose = dispatchWindowKey({ key: 'l', ctrlKey: true })
      assert.equal(evLToggleClose.defaultPrevented, true, 'with ModelPicker open, a second Ctrl+L must still dispatch the close event')
      const evOBlockedByPopover = dispatchWindowKey({ key: 'o', ctrlKey: true })
      assert.equal(evOBlockedByPopover.defaultPrevented, false)
      const evDotBlockedByPopover = dispatchWindowKey({ key: '.', ctrlKey: true })
      assert.equal(evDotBlockedByPopover.defaultPrevented, false)
      assert.deepEqual(fired.slice(countBeforePopover), [{ action: 'toggle-model-picker', panel: 'primary' }])
      modelPopover.remove()

      // With a plain modal/drawer [role="dialog"] open: Ctrl+L must be intercepted and never dispatched
      const normalDialog = document.createElement('div')
      normalDialog.setAttribute('role', 'dialog')
      document.body.appendChild(normalDialog)
      const countBeforeNormalDialog = fired.length
      const evLBlocked = dispatchWindowKey({ key: 'l', ctrlKey: true })
      assert.equal(evLBlocked.defaultPrevented, false)
      const evSemiBlockedByDialog = dispatchWindowKey({ key: ';', ctrlKey: true })
      assert.equal(evSemiBlockedByDialog.defaultPrevented, false)
      assert.equal(fired.length, countBeforeNormalDialog)
      normalDialog.remove()
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }

    // Mod+K: toggle the CommandPaletteModal
    dispatchWindowKey(modInit('k'))
    assert.equal(capturedStore?.activeModal?.kind, 'command-palette')
    dispatchWindowKey(modInit('k'))
    assert.equal(capturedStore?.activeModal, null)

    // Mod+J: toggle the WorkbenchDrawer
    assert.equal(capturedStore?.workbenchOpen, false)
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, true)
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, false)

    // Mod+J with a conversation drawer open: the drawer is a full conversation
    // context, so the workbench toggle pushes/pops a workbench frame above it.
    await act(async () => {
      capturedStore?.openConversationDrawer(2)
    })
    await flushMicrotasks()
    assert.deepEqual(capturedStore?.drawerStack, [{ kind: 'conversation', conversationId: 2 }])
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, true, '会话抽屉打开时 Mod+J 仍应开合工作台')
    assert.deepEqual(capturedStore?.drawerStack, [
      { kind: 'conversation', conversationId: 2 },
      { kind: 'workbench', conversationId: 2, tab: 'artifacts' },
    ])
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, false)
    assert.deepEqual(capturedStore?.drawerStack, [{ kind: 'conversation', conversationId: 2 }])
    await act(async () => {
      capturedStore?.closeAllDrawers()
    })
    await flushMicrotasks()

    // Mod+J stays blocked behind a non-drawer modal (command palette)
    await act(async () => {
      capturedStore?.setActiveModal({ kind: 'command-palette' })
    })
    await flushMicrotasks()
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, false, '命令面板打开时 Mod+J 应保持阻断')
    await act(async () => {
      capturedStore?.setActiveModal(null)
    })
    await flushMicrotasks()

    // Mod+B: toggle the desktop sidebar collapse and persist it to localStorage
    assert.equal(capturedStore?.sidebarCollapsed, false)
    dispatchWindowKey(modInit('b'))
    assert.equal(capturedStore?.sidebarCollapsed, true)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')

    // A remount restores the collapsed state from localStorage
    act(() => root?.unmount())
    root = undefined
    host?.remove()
    host = undefined

    const remountedStore = await mountProvider('#/c/1')
    assert.equal(remountedStore.sidebarCollapsed, true)

    dispatchWindowKey(modInit('b'))
    assert.equal(capturedStore?.sidebarCollapsed, false)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '0')
  })

  test('HelmxStoreProvider double-Esc misfire-protection state machine (overlay interception / non-running skip / 1.5s timeout reset / double-tap abort)', { timeout: 60_000 }, async () => {
    const escWindowMs = 30
    await mountProvider('#/c/1', { escAbortWindowMs: escWindowMs })

    // 1) Pressing Esc on an idle conversation (#1) never arms or aborts
    dispatchWindowKey({ key: 'Escape' })
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
    assert.equal(abortCalls.length, 0)

    // Open the split (#2 is working) and focus split
    await act(async () => {
      capturedStore?.openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
    })
    await flushMicrotasks()
    await act(async () => {
      capturedStore?.setFocusedPanel?.('split')
    })

    // 2) If an inner element calls stopPropagation, or the key carries Shift, the armed state is never entered
    dispatchWindowKey({ key: 'Escape', shiftKey: true })
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    const consumerInput = document.querySelector<HTMLElement>('[data-testid="esc-consumer-input"]')
    assert.ok(consumerInput)
    dispatchWindowKey({ key: 'Escape' }, consumerInput)
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    // 3) With a global modal or [role="dialog"] / workbench open, the Esc abort never triggers
    await act(async () => {
      capturedStore?.setActiveModal({ kind: 'command-palette' })
    })
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    await act(async () => {
      capturedStore?.setActiveModal(null)
      capturedStore?.setWorkbenchOpen(true)
    })
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    await act(async () => {
      capturedStore?.setWorkbenchOpen(false)
    })

    const popover = document.createElement('div')
    popover.setAttribute('role', 'dialog')
    document.body.appendChild(popover)
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
    popover.remove()

    // 4) The first Esc enters the 1.5s armed notice without aborting immediately
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
    assert.equal(abortCalls.length, 0)

    // 5) Past the armed window it resets automatically
    await waitForCondition(() => (capturedStore?.pendingEscAbortConversationId ?? null) === null, 1_000, 2)
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
    assert.equal(abortCalls.length, 0)

    // 6) Two Esc presses within 1.5s abort the focusedPanel's conversation #2
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
    dispatchWindowKey({ key: 'Escape' })
    await waitForCondition(() => abortCalls.length === 1)
    assert.deepEqual(abortCalls, [2])
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    // 7) Unmounting while armed cleans up the timer properly (no errors/exceptions)
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  })

  test('App split containers with data-helmx-panel capture focus and coordinate the WorkbenchDrawer and sidebar-collapsed', { timeout: 60_000 }, async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
    await mountApp(
      '#/c/1?split=c/2&drawer=wb/artifacts',
      () =>
        host?.querySelector('[data-helmx-panel="split"]') !== null &&
        document.querySelector('.helmx-workbench') !== null &&
        artifactRequests.includes(1),
    )

    const shell = host!.querySelector<HTMLElement>('.helmx-shell')
    assert.ok(shell, 'App must render .helmx-shell')
    assert.equal(shell.classList.contains('sidebar-collapsed'), true, 'with the collapsed state saved in localStorage, App must attach .sidebar-collapsed')

    // Press Mod+B to expand the sidebar
    dispatchWindowKey(modInit('b'))
    assert.equal(shell.classList.contains('sidebar-collapsed'), false, 'Mod+B must remove .sidebar-collapsed')

    const primaryPane = host!.querySelector<HTMLElement>('[data-helmx-panel="primary"]')
    const splitPane = host!.querySelector<HTMLElement>('[data-helmx-panel="split"]')
    assert.ok(primaryPane, 'the primary pane must carry data-helmx-panel="primary"')
    assert.ok(splitPane, 'the split pane must carry data-helmx-panel="split"')

    // ConversationPane New Topic and Workbench buttons carry platform shortcut tooltips
    const convNewTopicBtn = primaryPane.querySelector<HTMLButtonElement>('button[aria-label="New topic"]')
    assert.ok(
      convNewTopicBtn?.getAttribute('title')?.includes(formatModShiftShortcut('O')),
      'ConversationPane New Topic tooltip must include Mod+Shift+O',
    )
    const workbenchBtn = primaryPane.querySelector<HTMLButtonElement>('button[aria-label^="Workbench"]')
    assert.ok(
      workbenchBtn?.getAttribute('title')?.includes(formatModShortcut('J')),
      'ConversationPane Workbench tooltip must include Mod+J',
    )

    // The WorkbenchDrawer initially points at primary (#1)
    const workbenchInitial = document.querySelector<HTMLElement>('.helmx-workbench')
    assert.ok(workbenchInitial, 'with wb=artifacts the .helmx-workbench must be open')
    assert.equal(artifactRequests.includes(1), true)

    // Pointer/Focus entering the split container -> the WorkbenchDrawer switches to split conversation #2's artifacts
    await act(async () => {
      splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await waitForCondition(
      () =>
        artifactRequests.includes(2) &&
        (document.querySelector('.helmx-workbench')?.textContent ?? '').includes('split-artifact.md'),
    )
    assert.equal(artifactRequests.includes(2), true, 'after focusing split, the WorkbenchDrawer must switch to conversation #2')
    assert.match(document.querySelector('.helmx-workbench')?.textContent ?? '', /split-artifact\.md/)

    // Switch focus back to primary
    await act(async () => {
      primaryPane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await waitForCondition(() => (document.querySelector('.helmx-workbench')?.textContent ?? '').includes('primary-artifact.md'))
    assert.match(document.querySelector('.helmx-workbench')?.textContent ?? '', /primary-artifact\.md/)
  })

  test('Mod+/ toggles ShortcutsModal (including IME Slash fallback and open-shortcuts event), and Mod+Shift+O resolves new topic or focuses standby composer', { timeout: 60_000 }, async () => {
    const profiles: Profile[] = [
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder' },
    ]
    const conversations: ConversationSummary[] = [
      makeConversation(1, { profileId: 'coder', nodeId: 'remote-1', cwd: '/remote/repo', updatedAt: 500 }),
      makeConversation(2, { profileId: 'assistant', nodeId: 'local', cwd: '', updatedAt: 100 }),
    ]
    await mountProvider('#/overview', { conversations, profiles })

    // 1) Mod+/ toggles ShortcutsModal open and closed (including from inside an input and via IME code:'Slash')
    const primaryInput = document.querySelector<HTMLInputElement>('[data-testid="primary-input"]')!
    primaryInput.focus()
    const evOpen = dispatchWindowKey(modInit('/'), primaryInput)
    assert.equal(evOpen.defaultPrevented, true)
    assert.deepEqual(capturedStore?.activeModal, { kind: 'shortcuts' })

    const evCloseIme = dispatchWindowKey({ ...modInit('、'), code: 'Slash' }, primaryInput)
    assert.equal(evCloseIme.defaultPrevented, true)
    assert.equal(capturedStore?.activeModal, null)

    // 2) Switching from command-palette -> Mod+/ lands cleanly on shortcuts
    await act(async () => {
      capturedStore?.setActiveModal({ kind: 'command-palette' })
    })
    dispatchWindowKey(modInit('/'))
    assert.deepEqual(capturedStore?.activeModal, { kind: 'shortcuts' })
    await act(async () => {
      capturedStore?.setActiveModal(null)
    })

    // 3) AlertDialog blocks Mod+/ and open-shortcuts event
    const alertDialog = document.createElement('div')
    alertDialog.setAttribute('role', 'alertdialog')
    document.body.appendChild(alertDialog)
    const evBlocked = dispatchWindowKey(modInit('/'))
    assert.equal(evBlocked.defaultPrevented, false)
    assert.equal(capturedStore?.activeModal, null)
    act(() => {
      window.dispatchEvent(new CustomEvent('helmx:shortcut', { detail: { action: 'open-shortcuts', panel: 'primary' } }))
    })
    assert.equal(capturedStore?.activeModal, null)
    alertDialog.remove()

    // 4) helmx:shortcut { action: 'open-shortcuts' } opens ShortcutsModal cleanly
    act(() => {
      window.dispatchEvent(new CustomEvent('helmx:shortcut', { detail: { action: 'open-shortcuts', panel: 'primary' } }))
    })
    assert.deepEqual(capturedStore?.activeModal, { kind: 'shortcuts' })
    await act(async () => {
      capturedStore?.setActiveModal(null)
    })

    // 5) Mod+Shift+O from Overview navigates to first candidate standby (coder), NOT Profile Center
    const evOverviewNew = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
    assert.equal(evOverviewNew.defaultPrevented, true)
    assert.deepEqual(capturedStore?.primaryTarget, { kind: 'agent', profileId: 'coder' })

    // 6) Mod+Shift+O while already on multi-profile standby dispatches toggle-profile-picker without wiping target
    const fired: HelmxShortcutDetail[] = []
    const onShortcut = (ev: Event) => {
      fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
    }
    window.addEventListener('helmx:shortcut', onShortcut)
    try {
      const evAlreadyStandby = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
      assert.equal(evAlreadyStandby.defaultPrevented, true)
      assert.deepEqual(fired, [{ action: 'toggle-profile-picker', panel: 'primary' }])

      // Open .agent-standby-profile-popover: second Mod+Shift+O still dispatches toggle-profile-picker,
      // while Ctrl+L, Ctrl+O, Ctrl+. remain blocked
      const profilePopover = document.createElement('div')
      profilePopover.setAttribute('role', 'dialog')
      profilePopover.className = 'helmx-popover-content composer-popover agent-standby-profile-popover'
      document.body.appendChild(profilePopover)
      const beforePopover = fired.length
      const evToggleClose = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
      assert.equal(evToggleClose.defaultPrevented, true)
      assert.equal(dispatchWindowKey({ key: 'l', ctrlKey: true }).defaultPrevented, false)
      assert.equal(dispatchWindowKey({ key: 'o', ctrlKey: true }).defaultPrevented, false)
      assert.equal(dispatchWindowKey({ key: '.', ctrlKey: true }).defaultPrevented, false)
      assert.deepEqual(fired.slice(beforePopover), [{ action: 'toggle-profile-picker', panel: 'primary' }])
      profilePopover.remove()

      // Non-profile-picker dialog blocks Mod+Shift+O on standby
      const modelPopoverOnStandby = document.createElement('div')
      modelPopoverOnStandby.setAttribute('role', 'dialog')
      modelPopoverOnStandby.className = 'helmx-popover-content composer-model-popover'
      document.body.appendChild(modelPopoverOnStandby)
      const beforeBlocked = fired.length
      const evBlockedByModel = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
      assert.equal(evBlockedByModel.defaultPrevented, false)
      assert.equal(fired.length, beforeBlocked)
      modelPopoverOnStandby.remove()

      // 7) Mod+Shift+O from human conversation inherits (nodeId, cwd)
      await act(async () => {
        capturedStore?.openTarget({ kind: 'conversation', conversationId: 1 })
      })
      const evConvNew = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
      assert.equal(evConvNew.defaultPrevented, true)
      assert.deepEqual(capturedStore?.primaryTarget, {
        kind: 'agent',
        profileId: 'coder',
        nodeId: 'remote-1',
        cwd: '/remote/repo',
      })

      // 8) IME-safe Ctrl+. (Chinese period '。' with code: 'Period') dispatches toggle-plan-mode
      const beforeDot = fired.length
      const evImeDot = dispatchWindowKey({ key: '。', code: 'Period', ctrlKey: true })
      assert.equal(evImeDot.defaultPrevented, true)
      assert.deepEqual(fired.slice(beforeDot), [{ action: 'toggle-plan-mode', panel: 'primary' }])
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }
  })

  test('App renders ShortcutsModal on Mod+/ with plugin-declared shortcuts and keeps URL hash clean', { timeout: 60_000 }, async () => {
    await mountApp(
      '#/overview',
      () => host?.querySelector('.overview-card') !== null,
      {
        ui: [
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
        ],
      },
    )

    dispatchWindowKey(modInit('/'))
    await waitForCondition(() => {
      const m = document.querySelector<HTMLElement>('.shortcuts-modal')
      return m !== null && document.activeElement === m && (m.textContent ?? '').includes('Toggle Plan mode')
    })

    const modal = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modal !== null, 'Mod+/ must render ShortcutsModal')
    const closeBtn = modal.querySelector<HTMLButtonElement>('button')
    assert.ok(document.activeElement === modal, 'opening ShortcutsModal focuses dialog container, not close button')
    assert.ok(closeBtn !== null && document.activeElement !== closeBtn, 'ShortcutsModal close button must not be auto-focused')
    const text = modal.textContent ?? ''
    assert.ok(text.includes('Keyboard shortcuts'))
    assert.ok(text.includes('Navigation'))
    assert.ok(text.includes('Conversation'))
    assert.ok(text.includes('Composer'))
    assert.ok(text.includes('Ctrl+;'))
    assert.ok(text.includes('Toggle attachments & actions menu'))
    assert.equal(text.includes('Focus message input'), true)
    assert.ok(text.includes('Toggle Plan mode'))
    assert.ok(text.includes('Ctrl+.'))
    assert.equal(window.location.hash.includes('modal='), false, 'ShortcutsModal must remain transient and never enter URL hash')
  })

  test('App end-to-end: AgentStandbyPane All shortcuts opens ShortcutsModal (with/without builtin:plan Ctrl+.) and Mod+Shift+O refocuses without wiping draft', { timeout: 60_000 }, async () => {
    const planCommandUi: PluginUiContribution[] = [
      {
        pluginId: 'builtin:plan',
        surface: 'commandPalette',
        spec: {
          id: 'toggle-plan-mode',
          title: { en: 'Toggle Plan mode', 'zh-CN': '切换计划模式' },
          shortcut: 'Ctrl+.',
          actionId: 'toggle',
          scope: {},
        },
      },
    ]

    await mountApp(
      '#/a/assistant',
      () => host?.querySelector('button.agent-standby-shortcuts-all') !== null && sendEvent !== undefined,
      { ui: planCommandUi },
    )

    const allShortcutsBtn = host!.querySelector<HTMLButtonElement>('button.agent-standby-shortcuts-all')
    assert.ok(allShortcutsBtn !== null, 'AgentStandbyPane must render the All shortcuts button')

    // Click All shortcuts -> opens ShortcutsModal displaying builtin:plan Ctrl+.
    await act(async () => {
      allShortcutsBtn.click()
    })
    await waitForCondition(() => (document.querySelector('.shortcuts-modal')?.textContent ?? '').includes('Toggle Plan mode'))

    const modalWithPlan = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modalWithPlan !== null, 'clicking All shortcuts inside AgentStandbyPane must open ShortcutsModal')
    const modalTextWithPlan = modalWithPlan.textContent ?? ''
    assert.ok(modalTextWithPlan.includes('Toggle Plan mode'))
    assert.ok(modalTextWithPlan.includes('Ctrl+.'))

    // Close ShortcutsModal via Mod+/
    dispatchWindowKey(modInit('/'))
    await waitForCondition(() => document.querySelector('.shortcuts-modal') === null)
    assert.ok(document.querySelector('.shortcuts-modal') === null, 'Mod+/ closes ShortcutsModal')

    // Type an unsent draft in the standby textarea, blur it, then press Mod+Shift+O -> focuses textarea without wiping draft
    const textarea = host!.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
    assert.ok(textarea !== null, 'standby composer textarea must exist')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      const tracker = (textarea as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(textarea, 'keep unsent standby draft')
      tracker?.setValue(prev)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(textarea.value, 'keep unsent standby draft')

    textarea.blur()
    assert.ok(document.activeElement !== textarea, 'textarea is blurred before Mod+Shift+O')

    const evRefocus = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
    assert.equal(evRefocus.defaultPrevented, true)
    assert.ok(document.activeElement === textarea, 'Mod+Shift+O on same standby page must focus composer textarea')
    assert.equal(textarea.value, 'keep unsent standby draft', 'Mod+Shift+O must preserve unsent standby draft')

    // Remount without builtin:plan command -> ShortcutsModal omits Ctrl+.
    act(() => root?.unmount())
    root = undefined
    host!.remove()
    await mountApp(
      '#/a/assistant',
      () => host?.querySelector('button.agent-standby-shortcuts-all') !== null && sendEvent !== undefined,
      { ui: [] },
    )

    const allShortcutsBtnNoPlan = host!.querySelector<HTMLButtonElement>('button.agent-standby-shortcuts-all')
    assert.ok(allShortcutsBtnNoPlan !== null)
    await act(async () => {
      allShortcutsBtnNoPlan.click()
    })
    await waitForCondition(() => document.querySelector('.shortcuts-modal') !== null)

    const modalWithoutPlan = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modalWithoutPlan !== null, 'clicking All shortcuts opens ShortcutsModal when builtin:plan is disabled')
    const modalTextNoPlan = modalWithoutPlan.textContent ?? ''
    assert.ok(modalTextNoPlan.includes('Keyboard shortcuts'))
    assert.equal(modalTextNoPlan.includes('Ctrl+.'), false, 'ShortcutsModal must omit Ctrl+. when builtin:plan is disabled')
    assert.equal(modalTextNoPlan.includes('Toggle Plan mode'), false)
  })
})
