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
  hasMultipleNewTopicProfiles,
  hasNonModelPickerDialogOpen,
  hasNonProfilePickerDialogOpen,
  isApplePlatform,
  isConversationAbortable,
  isEditableShortcutTarget,
  isInlineInputEscapeTarget,
  isPeriodShortcutKey,
  isSlashShortcutKey,
  persistSidebarCollapsed,
  resolveFocusedPanel,
  resolveNewTopicTarget,
  resolveShortcutKeyLower,
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

    // IME-safe symbol and letter key matchers
    assert.equal(isSlashShortcutKey({ key: '/' }), true)
    assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash' }), true)
    assert.equal(isSlashShortcutKey({ key: 'Process', code: 'Slash', keyCode: 229 }), true)
    assert.equal(isSlashShortcutKey({ key: '/', isComposing: true }), false)
    assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash', keyCode: 229 }, { blockProcessKeyCode: true }), false)
    assert.equal(isSlashShortcutKey({ key: 'k', code: 'KeyK' }), false)

    assert.equal(isPeriodShortcutKey({ key: '.' }), true)
    assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period' }), true)
    assert.equal(isPeriodShortcutKey({ key: 'Process', code: 'Period', keyCode: 229 }), true)
    assert.equal(isPeriodShortcutKey({ key: '.', isComposing: true }), false)
    assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period', keyCode: 229 }, { blockProcessKeyCode: true }), false)
    assert.equal(isPeriodShortcutKey({ key: 'o', code: 'KeyO' }), false)

    assert.equal(resolveShortcutKeyLower({ key: 'Process', code: 'KeyI', keyCode: 229 }), 'i')
    assert.equal(resolveShortcutKeyLower({ key: 'a', code: 'KeyQ' }), 'a')

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

    // Editable target detection for single-key shortcuts (connected & visible only; ignores hidden/inert/detached)
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
    assert.equal(isEditableShortcutTarget(null), false)
    editableScope.remove()

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

    assert.equal(hasMultipleNewTopicProfiles([{ id: 'assistant', name: 'Assistant' }]), false)
    assert.equal(
      hasMultipleNewTopicProfiles([
        { id: 'assistant', name: 'Assistant' },
        { id: 'coder', name: 'Coder' },
      ]),
      true,
    )
    assert.equal(
      hasMultipleNewTopicProfiles(
        [
          { id: 'assistant', name: 'Assistant' },
          { id: 'managed', name: 'Managed', managedByPlugin: 'plugin:disabled' },
        ],
        [],
      ),
      false,
    )

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
    const closeBtn = modal.querySelector<HTMLButtonElement>('button')
    assert.ok(document.activeElement === modal, 'opening ShortcutsModal focuses dialog container, not close button')
    assert.ok(closeBtn !== null && document.activeElement !== closeBtn, 'ShortcutsModal close button must not be auto-focused')
    const text = modal.textContent ?? ''
    assert.ok(text.includes('Keyboard shortcuts'))
    assert.ok(text.includes('Navigation'))
    assert.ok(text.includes('Conversation'))
    assert.ok(text.includes('Composer'))
    assert.equal(text.includes('Focus message input'), true)
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

  test('App end-to-end: Mod+Shift+O on multi-profile standby toggles profile picker, navigates with arrows/Enter, migrates draft, and replaces history', { timeout: 60_000 }, async () => {
    window.history.replaceState(null, '', '#/a/assistant')
    installFetch({
      profiles: [
        { id: 'assistant', name: 'Assistant' },
        { id: 'coder', name: 'Coder', nodeId: 'remote-1', cwd: '/remote/repo' },
      ],
      conversations: [],
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(100)

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

    // 1) First Mod+Shift+O on standby opens central profile picker
    const evOpen = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, textarea)
    assert.equal(evOpen.defaultPrevented, true)
    await settle(40)
    assert.ok(document.querySelector('.agent-standby-profile-popover') !== null, 'Mod+Shift+O opens profile picker')

    // 2) Second Mod+Shift+O closes picker and restores textarea focus
    const evClose = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, document.activeElement ?? undefined)
    assert.equal(evClose.defaultPrevented, true)
    await settle(40)
    assert.ok(document.querySelector('.agent-standby-profile-popover') === null, 'second Mod+Shift+O closes profile picker')
    assert.ok(document.activeElement === textarea, 'closing profile picker returns focus to textarea')

    // 3) Reopen with Mod+Shift+O, ArrowDown -> coder, Enter -> switches profile, migrates draft, replaces history
    dispatchWindowKey({ ...modInit('O'), shiftKey: true }, textarea)
    await settle(40)
    const popover = document.querySelector<HTMLElement>('.agent-standby-profile-popover')!
    assert.ok(popover !== null)
    await act(async () => {
      (document.activeElement ?? popover).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      (document.activeElement ?? popover).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle(100)

    assert.ok(document.querySelector('.agent-standby-profile-popover') === null)
    assert.equal(window.location.hash, '#/a/coder')
    assert.equal(window.history.length, historyLenBefore, 'switching standby profile replaces history instead of pushing')
    const coderTa = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')!
    assert.ok(coderTa !== null)
    assert.equal(coderTa.value, 'keep draft across picker', 'draft migrates to coder standby')
    assert.ok(document.activeElement === coderTa, 'focus lands in coder standby textarea')
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

  test('App end-to-end: Mod+I focuses active conversation, split, standby, or top drawer without touching hidden Activity; Cmd+K Focus message input works', { timeout: 60_000 }, async () => {
    window.history.replaceState(null, '', '#/c/1?split=c/2')
    installFetch({
      conversations: [
        makeConversation(1, { status: 'idle', title: 'Primary conv', profileId: 'assistant', cwd: '/repo-one' }),
        makeConversation(2, { status: 'idle', title: 'Split conv', profileId: 'assistant', cwd: '/repo-two' }),
        makeConversation(3, { status: 'idle', title: 'Drawer conv', profileId: 'assistant', cwd: '/repo-three' }),
      ],
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(100)

    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')!
    const splitPane = host.querySelector<HTMLElement>('[data-helmx-panel="split"]')!
    const primaryTa = primaryPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const splitTa = splitPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(primaryTa !== null && splitTa !== null)

    // 1) Primary focused, focus blurred to body -> Mod+I focuses primary composer
    primaryTa.blur()
    assert.ok(document.activeElement !== primaryTa)
    const evPrimaryI = dispatchWindowKey(modInit('i'))
    assert.equal(evPrimaryI.defaultPrevented, true)
    assert.ok(document.activeElement === primaryTa, 'Mod+I focuses primary conversation textarea')

    // 2) Focus split pane, blur to body -> Mod+I focuses split composer (not primary)
    await act(async () => {
      splitPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    splitTa.blur()
    const evSplitI = dispatchWindowKey(modInit('i'))
    assert.equal(evSplitI.defaultPrevented, true)
    assert.ok(document.activeElement === splitTa, 'Mod+I focuses split conversation textarea')
    assert.ok(document.activeElement !== primaryTa)

    // 3) Return to primary, close split, open conversation drawer #3 -> Mod+I focuses drawer composer ONLY
    await act(async () => {
      primaryPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    window.history.replaceState(null, '', '#/c/1?drawer=c/3')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)

    const drawerDialog = document.querySelector<HTMLElement>('.drawer-stack-dialog')!
    assert.ok(drawerDialog !== null, 'conversation drawer #3 must open')
    const drawerTa = drawerDialog.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(drawerTa !== null, 'drawer conversation #3 composer textarea must mount')
    drawerDialog.focus()
    assert.ok(document.activeElement !== drawerTa)

    const evDrawerI = dispatchWindowKey(modInit('i'))
    assert.equal(evDrawerI.defaultPrevented, true)
    assert.ok(document.activeElement === drawerTa, 'Mod+I focuses top conversation drawer textarea')
    assert.ok(document.activeElement !== primaryTa)

    // 4) Close drawer, navigate primary from #/c/1 -> #/c/2 (leaving #/c/1 in hidden <Activity>), blur, press Mod+I -> focuses #/c/2, NOT hidden #/c/1
    window.history.replaceState(null, '', '#/c/2')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)
    const conv2Ta = [...primaryPane.querySelectorAll<HTMLTextAreaElement>('textarea.composer-textarea')]
      .find((ta) => ta.closest('.helmx-pane')?.getAttribute('style')?.includes('none') !== true)!
    assert.ok(conv2Ta !== undefined)
    conv2Ta.blur()
    dispatchWindowKey(modInit('i'))
    assert.ok(document.activeElement === conv2Ta, 'Mod+I focuses visible conversation #2 and skips hidden Activity #1')

    // 5) Command palette `Focus message input` focuses composer after closing palette
    dispatchWindowKey(modInit('k'))
    await settle(60)
    const focusCmdRow = [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
      .find((btn) => btn.textContent?.includes('Focus message input'))!
    assert.ok(focusCmdRow !== undefined, 'CommandPalette exposes Focus message input row')
    await act(async () => {
      focusCmdRow.click()
    })
    await settle(60)
    assert.ok(document.activeElement === conv2Ta, 'CommandPalette Focus message input focuses active composer')
  })

  test('App end-to-end: New Topic focuses standby textarea from conversation Mod+Shift+O, Sidebar/Overview dropdowns, and Cmd+K without onCloseAutoFocus steal', { timeout: 60_000 }, async () => {
    window.history.replaceState(null, '', '#/c/1')
    installFetch({
      profiles: [
        { id: 'assistant', name: 'Assistant' },
        { id: 'coder', name: 'Coder' },
      ],
      conversations: [
        makeConversation(1, { status: 'idle', title: 'Primary conv', profileId: 'assistant', cwd: '/repo-one', updatedAt: 500 }),
      ],
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(<App />)
    })
    await settle(100)

    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')!
    const convTa = primaryPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    convTa.focus()
    assert.ok(document.activeElement === convTa)

    // 1) Mod+Shift+O directly from focused conversation textarea -> standby textarea auto-focuses
    const evNewTopic = dispatchWindowKey({ ...modInit('O'), shiftKey: true }, convTa)
    assert.equal(evNewTopic.defaultPrevented, true)
    await settle(100)
    const standbyTa1 = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane textarea.composer-textarea')!
    assert.ok(standbyTa1 !== null, 'standby pane must mount')
    assert.ok(document.activeElement === standbyTa1, 'Mod+Shift+O from conversation textarea must auto-focus standby textarea')

    // 2) Navigate back to Overview, then click Sidebar multi-profile + New topic dropdown -> Coder standby auto-focuses (not stolen back to + button)
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)

    const sidebarNewBtn = host.querySelector<HTMLButtonElement>('button.sidebar-new-topic-btn')!
    assert.ok(sidebarNewBtn !== null)
    await act(async () => {
      sidebarNewBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle(40)
    const sidebarCoderItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Coder'))!
    assert.ok(sidebarCoderItem !== undefined)
    await act(async () => {
      sidebarCoderItem.click()
    })
    await settle(100)
    const standbyCoderTa = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')!
    assert.ok(standbyCoderTa !== null)
    assert.ok(document.activeElement === standbyCoderTa, 'Sidebar dropdown New topic must land focus in standby textarea')

    // 3) Return to Overview, open Overview multi-profile New topic dropdown -> Assistant standby auto-focuses
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)
    const overviewNewBtn = primaryPane.querySelector<HTMLButtonElement>('button.overview-newtopic-btn')!
    assert.ok(overviewNewBtn !== null)
    await act(async () => {
      overviewNewBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle(40)
    const overviewAssistantItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Assistant'))!
    assert.ok(overviewAssistantItem !== undefined)
    await act(async () => {
      overviewAssistantItem.click()
    })
    await settle(100)
    const standbyAssistantTa = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="assistant"] textarea.composer-textarea')!
    assert.ok(standbyAssistantTa !== null)
    assert.ok(document.activeElement === standbyAssistantTa, 'Overview dropdown New topic must land focus in standby textarea')

    // 4) Open Cmd+K from Overview -> select Open agent: Coder with Enter -> Coder standby textarea auto-focuses (not stolen by Dialog onCloseAutoFocus)
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)
    const overviewSearch = primaryPane.querySelector<HTMLInputElement>('.overview-search-box input')!
    overviewSearch.focus()
    dispatchWindowKey(modInit('k'), overviewSearch)
    await settle(60)
    const modal = document.querySelector<HTMLElement>('.palette-modal')!
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
    await settle(100)
    const standbyFromPalette = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane[data-agent="coder"] textarea.composer-textarea')!
    assert.ok(standbyFromPalette !== null)
    assert.ok(document.activeElement === standbyFromPalette, 'Cmd+K Enter to standby must land focus in standby textarea')

    // 5) From conversation #1, Composer + menu -> New topic lands focus in standby textarea
    window.history.replaceState(null, '', '#/c/1')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)
    const plusTrigger = primaryPane.querySelector<HTMLButtonElement>('button.composer-plus-trigger')!
    assert.ok(plusTrigger !== null)
    await act(async () => {
      plusTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle(40)
    const plusNewTopicItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('/new'))!
    assert.ok(plusNewTopicItem !== undefined)
    await act(async () => {
      plusNewTopicItem.click()
    })
    await settle(100)
    const standbyFromPlus = primaryPane.querySelector<HTMLTextAreaElement>('.agent-standby-pane textarea.composer-textarea')!
    assert.ok(standbyFromPlus !== null)
    assert.ok(document.activeElement === standbyFromPlus, 'Composer + menu New topic must land focus in standby textarea')
  })

  test('App end-to-end: Chinese IME keyCode 229 allows non-input / and modified shortcuts while remaining blocked during composition or plain typing inside visible inputs', { timeout: 60_000 }, async () => {
    window.history.replaceState(null, '', '#/c/1')
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
    await settle(100)

    const primaryPane = host.querySelector<HTMLElement>('[data-helmx-panel="primary"]')!
    const convTa = primaryPane.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    convTa.focus()
    assert.ok(document.activeElement === convTa)

    // Switch to Overview via hash while #/c/1 stays in hidden <Activity>; simulate hidden <textarea> retaining activeElement
    window.history.replaceState(null, '', '#/overview')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await settle(100)
    const overviewSearch = primaryPane.querySelector<HTMLInputElement>('.overview-search-box input')!
    assert.ok(overviewSearch !== null)

    // Press Chinese IME / (key: 'Process', code: 'Slash', keyCode: 229, isComposing: false) from non-editable target (and even if hidden Activity textarea is activeElement)
    const evImeSlash = dispatchWindowKey({ key: 'Process', code: 'Slash', keyCode: 229, isComposing: false })
    assert.equal(evImeSlash.defaultPrevented, true, 'IME keyCode 229 Slash outside visible inputs focuses SearchBox')
    assert.ok(document.activeElement === overviewSearch)

    // Inside visible overviewSearch: plain keyCode 229 without modifiers is NOT hijacked; Mod+/ and Ctrl+. with keyCode 229 work; isComposing: true stays blocked
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
      assert.ok(document.querySelector('.shortcuts-modal') === null)

      const evImeModSlash = dispatchWindowKey({ ...modInit('Process'), code: 'Slash', keyCode: 229, isComposing: false }, overviewSearch)
      assert.equal(evImeModSlash.defaultPrevented, true, 'Mod+/ with IME keyCode 229 opens ShortcutsModal')
      await settle(40)
      assert.ok(document.querySelector('.shortcuts-modal') !== null)

      dispatchWindowKey({ ...modInit('Process'), code: 'Slash', keyCode: 229, isComposing: false })
      await settle(40)
      assert.ok(document.querySelector('.shortcuts-modal') === null)

      const beforeDot = seenShortcuts.length
      const evImeCtrlDot = dispatchWindowKey({ key: 'Process', code: 'Period', keyCode: 229, ctrlKey: true, isComposing: false }, overviewSearch)
      assert.equal(evImeCtrlDot.defaultPrevented, true, 'Ctrl+. with IME keyCode 229 dispatches toggle-plan-mode')
      assert.deepEqual(seenShortcuts.slice(beforeDot), [{ action: 'toggle-plan-mode', panel: 'primary' }])
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }
  })
})
