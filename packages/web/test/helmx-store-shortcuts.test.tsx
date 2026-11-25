import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, PluginSummary, PluginUiContribution, Profile } from '@helmx/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import {
  ESC_ABORT_WINDOW_MS,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  activeTargetForPanel,
  buildShortcutCatalog,
  formatModShiftShortcut,
  formatModShortcut,
  getStoredSidebarCollapsed,
  hasAnyOpenOverlay,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  isApplePlatform,
  isConversationAbortable,
  isEditableShortcutTarget,
  isInlineInputEscapeTarget,
  isPeriodShortcutKey,
  isSlashShortcutKey,
  persistSidebarCollapsed,
  resolveFocusedPanel,
  resolveNewTopicTarget,
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

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
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
  await settle()
  assert.ok(capturedStore, 'HelmxStoreProvider must supply the store to child components')
  return capturedStore
}

function dispatchWindowKey(
  init: KeyboardEventInit & { key: string },
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function modInit(key: string): KeyboardEventInit & { key: string } {
  return isApplePlatform() ? { key, metaKey: true } : { key, ctrlKey: true }
}
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
  })

  test('shortcuts-model pure functions: split focus, status checks and local persistence contracts', { timeout: 60_000 }, () => {
    assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, 'helmx:sidebar-collapsed')
    assert.equal(ESC_ABORT_WINDOW_MS, 1500)

    const primary: ResolvedTarget = { kind: 'conversation', conversationId: 1 }
    const split: ResolvedTarget = { kind: 'conversation', conversationId: 2 }

    assert.equal(resolveFocusedPanel('split', null), 'primary')
    assert.equal(resolveFocusedPanel('split', split), 'split')
    assert.equal(resolveFocusedPanel('primary', split), 'primary')

    assert.deepEqual(activeTargetForPanel(primary, null, 'split'), primary)
    assert.deepEqual(activeTargetForPanel(primary, split, 'split'), split)
    assert.deepEqual(activeTargetForPanel(primary, split, 'primary'), primary)

    assert.equal(isConversationAbortable(undefined), false)
    assert.equal(isConversationAbortable(makeConversation(1, { status: 'idle' })), false)
    assert.equal(isConversationAbortable(makeConversation(2, { status: 'working' })), true)

    persistSidebarCollapsed(true)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '1')
    assert.equal(getStoredSidebarCollapsed(), true)

    persistSidebarCollapsed(false)
    assert.equal(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY), '0')
    assert.equal(getStoredSidebarCollapsed(), false)

    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true')
    assert.equal(getStoredSidebarCollapsed(), true)

    // Platform modifier formatting carries no multi-key alias separators
    assert.equal(formatModShortcut('K').includes('/'), false)
    assert.equal(formatModShortcut('B').endsWith('B'), true)
    assert.equal(formatModShortcut('/').endsWith('/'), true)
    assert.equal(formatModShortcut('Enter').endsWith('Enter'), true)
    assert.equal(formatModShiftShortcut('O'), isApplePlatform() ? '⌘⇧O' : 'Ctrl+Shift+O')

    // IME-safe symbol key matchers
    assert.equal(isSlashShortcutKey({ key: '/' }), true)
    assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash' }), true)
    assert.equal(isSlashShortcutKey({ key: '/', isComposing: true }), false)
    assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash', keyCode: 229 }), false)
    assert.equal(isSlashShortcutKey({ key: 'k', code: 'KeyK' }), false)

    assert.equal(isPeriodShortcutKey({ key: '.' }), true)
    assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period' }), true)
    assert.equal(isPeriodShortcutKey({ key: '.', isComposing: true }), false)
    assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period', keyCode: 229 }), false)
    assert.equal(isPeriodShortcutKey({ key: 'o', code: 'KeyO' }), false)

    // resolveNewTopicTarget: inherits (nodeId, cwd) on human conversation, preserves standby,
    // picks first buildNewTopicCandidates entry on overview/settings/automated conv, falls back to profiles
    const testProfiles: Profile[] = [
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder' },
      { id: 'managed-disabled', name: 'Managed', managedByPlugin: 'ext:off' },
    ]
    const testPlugins: PluginSummary[] = [
      { id: 'ext:off', name: 'Off', version: '1.0.0', enabled: false, locked: false, hooks: [], actions: [], tools: [] },
    ]
    const testConvs: ConversationSummary[] = [
      makeConversation(10, { profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app', updatedAt: 500 }),
      makeConversation(11, { profileId: 'assistant', nodeId: 'local', cwd: '', updatedAt: 200 }),
      makeConversation(12, { profileId: 'coder', ownedBy: 'helmx', nodeId: 'remote-box', cwd: '/srv/auto', updatedAt: 900 }),
      makeConversation(13, { profileId: 'managed-disabled', ownedBy: 'human', cwd: '/srv/disabled', updatedAt: 300 }),
    ]
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'conversation', conversationId: 10 },
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      { kind: 'agent', profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app' },
    )
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'conversation', conversationId: 11 },
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      { kind: 'agent', profileId: 'assistant' },
    )
    const standbyTarget: ResolvedTarget = { kind: 'agent', profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app' }
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: standbyTarget,
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      standbyTarget,
    )
    // Overview & automated/non-selectable conversations pick first human candidate (latest active human root = coder)
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'overview' },
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      { kind: 'agent', profileId: 'coder' },
    )
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'conversation', conversationId: 12 },
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      { kind: 'agent', profileId: 'coder' },
    )
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'conversation', conversationId: 13 },
        conversations: testConvs,
        profiles: testProfiles,
        plugins: testPlugins,
        locale: 'en',
      }),
      { kind: 'agent', profileId: 'coder' },
    )
    assert.deepEqual(
      resolveNewTopicTarget({
        activeTarget: { kind: 'overview' },
        conversations: [],
        profiles: [],
        plugins: [],
        locale: 'en',
      }),
      { kind: 'profiles' },
    )

    // buildShortcutCatalog: 3 grouped sections + generic plugin commands with spec.shortcut (unfiltered by scope)
    const catalogWithPlugin = buildShortcutCatalog({
      pluginCommands: [
        {
          pluginId: 'ext:alpha',
          spec: {
            id: 'toggle-alpha',
            title: { en: 'Toggle Alpha mode', 'zh-CN': '切换 Alpha 模式' },
            shortcut: 'Ctrl+.',
            scope: { tags: ['restricted-tag'] },
          },
        },
        {
          pluginId: 'ext:beta',
          spec: {
            id: 'no-shortcut',
            title: 'No Shortcut Command',
          },
        },
      ],
      locale: 'en',
    })
    assert.deepEqual(catalogWithPlugin.map((s) => s.key), ['navigation', 'conversation', 'composer'])
    const navItemsEn = catalogWithPlugin.find((s) => s.key === 'navigation')?.items ?? []
    assert.equal(navItemsEn.some((item) => item.keys === '/' && item.label === 'Focus page search'), true)
    const catalogZh = buildShortcutCatalog({ pluginCommands: [], locale: 'zh-CN' })
    const navItemsZh = catalogZh.find((s) => s.key === 'navigation')?.items ?? []
    assert.equal(navItemsZh.some((item) => item.keys === '/' && item.label === '聚焦页面搜索'), true)
    const convItems = catalogWithPlugin.find((s) => s.key === 'conversation')?.items ?? []
    assert.equal(convItems.some((item) => item.keys === 'Ctrl+.' && item.label === 'Toggle Alpha mode'), true)
    assert.equal(convItems.some((item) => item.label === 'No Shortcut Command'), false)

    const catalogWithoutPlugin = buildShortcutCatalog({ pluginCommands: [], locale: 'en' })
    const convItemsEmpty = catalogWithoutPlugin.find((s) => s.key === 'conversation')?.items ?? []
    assert.equal(convItemsEmpty.some((item) => item.keys === 'Ctrl+.'), false)

    // Editable target detection for single-key shortcuts
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
    assert.equal(isEditableShortcutTarget(editableInput), true)
    assert.equal(isEditableShortcutTarget(editableTextarea), true)
    assert.equal(isEditableShortcutTarget(editableSelect), true)
    assert.equal(isEditableShortcutTarget(editableDiv), true)
    assert.equal(isEditableShortcutTarget(editableChild), true)
    assert.equal(isEditableShortcutTarget(nonEditableDiv), false)
    assert.equal(isEditableShortcutTarget(plainButton), false)
    assert.equal(isEditableShortcutTarget(null), false)

    // Overlay and inline-input detection
    assert.equal(hasAnyOpenOverlay({ kind: 'command-palette' }, false), true)
    assert.equal(hasAnyOpenOverlay(null, true), true)
    assert.equal(hasAnyOpenOverlay(null, false), false)
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
    modelPopover.remove()

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
      dispatchWindowKey({ key: 'Escape' })
      dispatchWindowKey({ key: 'Escape' })
      await settle(20)

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
    await settle(20)
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

      assert.deepEqual(fired, [
        { action: 'toggle-model-picker', panel: 'split' },
        { action: 'toggle-process-groups', panel: 'split' },
        { action: 'toggle-plan-mode', panel: 'split' },
      ])

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
      assert.deepEqual(fired[3], { action: 'toggle-model-picker', panel: 'primary' })

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
    await settle()
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
    await settle()

    // Mod+J stays blocked behind a non-drawer modal (command palette)
    await act(async () => {
      capturedStore?.setActiveModal({ kind: 'command-palette' })
    })
    await settle()
    dispatchWindowKey(modInit('j'))
    assert.equal(capturedStore?.workbenchOpen, false, '命令面板打开时 Mod+J 应保持阻断')
    await act(async () => {
      capturedStore?.setActiveModal(null)
    })
    await settle()

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
    const escWindowMs = 60
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
    await settle(20)
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
    await settle(escWindowMs + 40)
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)
    assert.equal(abortCalls.length, 0)

    // 6) Two Esc presses within 1.5s abort the focusedPanel's conversation #2
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
    dispatchWindowKey({ key: 'Escape' })
    await settle(20)
    assert.deepEqual(abortCalls, [2])
    assert.equal(capturedStore?.pendingEscAbortConversationId ?? null, null)

    // 7) Unmounting while armed cleans up the timer properly (no errors/exceptions)
    dispatchWindowKey({ key: 'Escape' })
    assert.equal(capturedStore?.pendingEscAbortConversationId, 2)
  })

  test('App split containers with data-helmx-panel capture focus and coordinate the WorkbenchDrawer and sidebar-collapsed', { timeout: 60_000 }, async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
    window.history.replaceState(null, '', '#/c/1?split=c/2&drawer=wb/artifacts')
    installFetch()

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(60)

    const shell = host.querySelector<HTMLElement>('.helmx-shell')
    assert.ok(shell, 'App must render .helmx-shell')
    assert.equal(shell.classList.contains('sidebar-collapsed'), true, 'with the collapsed state saved in localStorage, App must attach .sidebar-collapsed')

    // Press Mod+B to expand the sidebar
    dispatchWindowKey(modInit('b'))
    assert.equal(shell.classList.contains('sidebar-collapsed'), false, 'Mod+B must remove .sidebar-collapsed')

    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')
    const splitPane = host.querySelector<HTMLElement>('[data-helmx-panel="split"]')
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
    await settle(40)
    assert.equal(artifactRequests.includes(2), true, 'after focusing split, the WorkbenchDrawer must switch to conversation #2')
    assert.match(document.querySelector('.helmx-workbench')?.textContent ?? '', /split-artifact\.md/)

    // Switch focus back to primary
    await act(async () => {
      primaryPane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await settle(40)
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

    // 6) Mod+Shift+O while already on that exact standby dispatches focus-composer without wiping target
    const fired: HelmxShortcutDetail[] = []
    const onShortcut = (ev: Event) => {
      fired.push((ev as CustomEvent<HelmxShortcutDetail>).detail)
    }
    window.addEventListener('helmx:shortcut', onShortcut)
    try {
      const evAlreadyStandby = dispatchWindowKey({ ...modInit('O'), shiftKey: true })
      assert.equal(evAlreadyStandby.defaultPrevented, true)
      assert.deepEqual(fired, [{ action: 'focus-composer', panel: 'primary' }])

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
    window.history.replaceState(null, '', '#/overview')
    installFetch({
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
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(60)

    dispatchWindowKey(modInit('/'))
    await settle(60)

    const modal = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modal !== null, 'Mod+/ must render ShortcutsModal')
    const text = modal.textContent ?? ''
    assert.ok(text.includes('Keyboard shortcuts'))
    assert.ok(text.includes('Navigation'))
    assert.ok(text.includes('Conversation'))
    assert.ok(text.includes('Composer'))
    assert.ok(text.includes('Toggle Plan mode'))
    assert.ok(text.includes('Ctrl+.'))
    assert.equal(window.location.hash.includes('modal='), false, 'ShortcutsModal must remain transient and never enter URL hash')
  })

  test('plain / dispatches cancelable focus-search only outside inputs and overlays, preventing default only when claimed', { timeout: 60_000 }, async () => {
    await mountProvider('#/overview')

    const seen: Array<{ detail: HelmxShortcutDetail; cancelable: boolean }> = []
    let claimFocusSearch = false
    const onShortcut = (ev: Event) => {
      const ce = ev as CustomEvent<HelmxShortcutDetail>
      if (ce.detail?.action !== 'focus-search') return
      seen.push({ detail: ce.detail, cancelable: ce.cancelable })
      if (claimFocusSearch) ce.preventDefault()
    }
    window.addEventListener('helmx:shortcut', onShortcut)

    try {
      // 1) Without a claiming SearchBox listener, keydown is NOT defaultPrevented
      const evUnclaimed = dispatchWindowKey({ key: '/', code: 'Slash' })
      assert.equal(seen.length, 1)
      assert.deepEqual(seen[0], { detail: { action: 'focus-search', panel: 'primary' }, cancelable: true })
      assert.equal(evUnclaimed.defaultPrevented, false, 'unclaimed / must not silently swallow the key')

      // 2) With a claiming SearchBox listener, keydown IS defaultPrevented (including IME Slash fallback)
      claimFocusSearch = true
      const evClaimed = dispatchWindowKey({ key: '/', code: 'Slash' })
      assert.equal(evClaimed.defaultPrevented, true)
      const evImeClaimed = dispatchWindowKey({ key: '、', code: 'Slash' })
      assert.equal(evImeClaimed.defaultPrevented, true)
      assert.equal(seen.length, 3)

      // 3) Modifiers (Shift+/, Alt+/) do not trigger focus-search
      const beforeMod: number = seen.length
      dispatchWindowKey({ key: '?', code: 'Slash', shiftKey: true })
      dispatchWindowKey({ key: '/', code: 'Slash', altKey: true })
      assert.equal(seen.length, beforeMod)

      // 4) Editable targets (input, textarea, select, contenteditable) ignore /
      const inputEl = document.querySelector<HTMLInputElement>('[data-testid="primary-input"]')!
      const textareaEl = document.createElement('textarea')
      const selectEl = document.createElement('select')
      const ceEl = document.createElement('div')
      ceEl.setAttribute('contenteditable', 'true')
      document.body.append(textareaEl, selectEl, ceEl)
      for (const editable of [inputEl, textareaEl, selectEl, ceEl]) {
        const beforeEditable: number = seen.length
        const ev = dispatchWindowKey({ key: '/', code: 'Slash' }, editable)
        assert.equal(ev.defaultPrevented, false)
        assert.equal(seen.length, beforeEditable)
      }
      textareaEl.remove()
      selectEl.remove()
      ceEl.remove()

      // 5) Open modal, drawer, DOM dialog, or menu overlay blocks /
      await act(async () => {
        capturedStore?.setActiveModal({ kind: 'command-palette' })
      })
      const beforeBlocked: number = seen.length
      dispatchWindowKey({ key: '/', code: 'Slash' })
      await act(async () => {
        capturedStore?.setActiveModal(null)
        capturedStore?.openConversationDrawer(1)
      })
      dispatchWindowKey({ key: '/', code: 'Slash' })
      await act(async () => {
        capturedStore?.closeAllDrawers()
      })
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.appendChild(dialog)
      dispatchWindowKey({ key: '/', code: 'Slash' })
      dialog.remove()
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      document.body.appendChild(menu)
      dispatchWindowKey({ key: '/', code: 'Slash' })
      menu.remove()
      assert.equal(seen.length, beforeBlocked)
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }
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

    window.history.replaceState(null, '', '#/a/assistant')
    installFetch({ ui: planCommandUi })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(100)

    const allShortcutsBtn = host.querySelector<HTMLButtonElement>('button.agent-standby-shortcuts-all')
    assert.ok(allShortcutsBtn !== null, 'AgentStandbyPane must render the All shortcuts button')

    // Click All shortcuts -> opens ShortcutsModal displaying builtin:plan Ctrl+. and / Focus page search
    await act(async () => {
      allShortcutsBtn.click()
    })
    await settle(80)

    const modalWithPlan = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modalWithPlan !== null, 'clicking All shortcuts inside AgentStandbyPane must open ShortcutsModal')
    const modalTextWithPlan = modalWithPlan.textContent ?? ''
    assert.ok(modalTextWithPlan.includes('Focus page search'))
    assert.ok(modalTextWithPlan.includes('Toggle Plan mode'))
    assert.ok(modalTextWithPlan.includes('Ctrl+.'))

    // Close ShortcutsModal via Mod+/
    dispatchWindowKey(modInit('/'))
    await settle(40)
    assert.ok(document.querySelector('.shortcuts-modal') === null, 'Mod+/ closes ShortcutsModal')

    // Type an unsent draft in the standby textarea, blur it, then press Mod+Shift+O -> focuses textarea without wiping draft
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
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
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    window.history.replaceState(null, '', '#/a/assistant')
    installFetch({ ui: [] })

    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(100)

    const allShortcutsBtnNoPlan = host.querySelector<HTMLButtonElement>('button.agent-standby-shortcuts-all')
    assert.ok(allShortcutsBtnNoPlan !== null)
    await act(async () => {
      allShortcutsBtnNoPlan.click()
    })
    await settle(80)

    const modalWithoutPlan = document.querySelector<HTMLElement>('.shortcuts-modal')
    assert.ok(modalWithoutPlan !== null, 'clicking All shortcuts opens ShortcutsModal when builtin:plan is disabled')
    const modalTextNoPlan = modalWithoutPlan.textContent ?? ''
    assert.ok(modalTextNoPlan.includes('Keyboard shortcuts'))
    assert.equal(modalTextNoPlan.includes('Ctrl+.'), false, 'ShortcutsModal must omit Ctrl+. when builtin:plan is disabled')
    assert.equal(modalTextNoPlan.includes('Toggle Plan mode'), false)
  })

  test('App end-to-end: / focuses page search only in focused split pane (Overview + SystemCenter) and Esc clears then blurs', { timeout: 60_000 }, async () => {
    window.history.replaceState(null, '', '#/overview?split=settings/skills')
    installFetch()

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(120)

    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')
    const splitPane = host.querySelector<HTMLElement>('[data-helmx-panel="split"]')
    assert.ok(primaryPane !== null && splitPane !== null)

    const overviewSearch = primaryPane.querySelector<HTMLInputElement>('.overview-search-box input')
    const skillSearch = splitPane.querySelector<HTMLInputElement>('.search-box-toolbar input')
    assert.ok(overviewSearch !== null, 'Overview search input must mount')
    assert.ok(skillSearch !== null, 'SkillCenter toolbar search input must mount')

    // Primary focused: / focuses Overview search only
    const evPrimarySlash = dispatchWindowKey({ key: '/', code: 'Slash' })
    assert.equal(evPrimarySlash.defaultPrevented, true)
    assert.ok(document.activeElement === overviewSearch, '/ must focus Overview search in primary panel')
    assert.ok(document.activeElement !== skillSearch, 'split SkillCenter search must not steal focus')

    // Type a query into Overview search -> first Esc clears it while keeping focus, second Esc blurs it
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const tracker = (overviewSearch as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(overviewSearch, 'alpha')
      tracker?.setValue(prev)
      overviewSearch.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(overviewSearch.value, 'alpha')

    dispatchWindowKey({ key: 'Escape' }, overviewSearch)
    assert.equal(overviewSearch.value, '', 'first Escape clears Overview search draft')
    assert.ok(document.activeElement === overviewSearch, 'first Escape keeps focus in Overview search')

    dispatchWindowKey({ key: 'Escape' }, overviewSearch)
    assert.ok(document.activeElement !== overviewSearch, 'second Escape on empty Overview search blurs it')

    // Focus split pane (SkillCenter) -> / focuses SkillCenter toolbar search only
    await act(async () => {
      splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    const evSplitSlash = dispatchWindowKey({ key: '/', code: 'Slash' })
    assert.equal(evSplitSlash.defaultPrevented, true)
    assert.ok(document.activeElement === skillSearch, '/ must focus SkillCenter toolbar search when split is focused')
    assert.ok(document.activeElement !== overviewSearch, 'primary Overview search must not steal split focus')
  })
})
