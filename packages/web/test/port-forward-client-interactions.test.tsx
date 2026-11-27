/**
 * `builtin:port-forward` compiled client TSX interactive DOM tests:
 * - Loading & empty states (single top-right New mapping CTA, zero `.screen-subtitle`,
 *   zero main-stage `.kv-grid`, zero Emoji);
 * - SelectCard grid + StatusLight 5-state synthesis (`working` / `done` / `blocked` / `failed` / `idle`);
 * - Pill tabs with inline counts + SearchBox + Reset filters + URL `params.node` filter pill;
 * - Instant Switch toggle (`start`/`stop`), overflow DropdownMenu bulk actions, ConfirmDialog delete;
 * - DetailDrawer (`create=1` / `edit=<id>`): runtime KvGrid in edit drawer, `nodes === undefined` disabled
 *   Select, unknown bound node preservation, non-loopback `Callout` security warning, valid create submit;
 * - `NodePortForwardsSection` slot filtering & deep-link `openScreen` targets;
 * - `PortForwardSettingsPanel` summary KV & navigation.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  NodeDetailSlotProps,
  NodeInfo,
  PluginClientContext as PluginClientContextType,
  ScreenProps,
} from '@helmx/protocol/browser'
import { PluginClientContext, resolveLocalizedText, type HelmxLocale } from '@helmx/plugin-client'
import {
  importBuiltinClientModule,
  mountSharedPluginNamespaces,
  setBuiltinClientStub,
} from './helpers/builtin-clients.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface Components {
  PortForwardManagerScreen: (p: Partial<ScreenProps> & { inlineDrawer?: boolean }) => React.ReactElement
  NodePortForwardsSection: (p: NodeDetailSlotProps) => React.ReactElement
  PortForwardSettingsPanel: () => React.ReactElement
}

let components: Components

describe('port-forward-client-interactions', () => {
  before(async () => {
    mountSharedPluginNamespaces()
    const [managerMod, slotMod, settingsMod] = await Promise.all([
      importBuiltinClientModule('builtin:port-forward', 'manager.tsx'),
      importBuiltinClientModule('builtin:port-forward', 'node-slot.tsx'),
      importBuiltinClientModule('builtin:port-forward', 'settings.tsx'),
    ])
    components = {
      PortForwardManagerScreen: managerMod['PortForwardManagerScreen'] as Components['PortForwardManagerScreen'],
      NodePortForwardsSection: slotMod['NodePortForwardsSection'] as Components['NodePortForwardsSection'],
      PortForwardSettingsPanel: settingsMod['PortForwardSettingsPanel'] as Components['PortForwardSettingsPanel'],
    }
  }, TIMEOUT)

  interface SpyCtx extends PluginClientContextType {
    screenCalls: string[]
    actionCalls: Array<{ actionId: string; input: unknown }>
    notifications: Array<{ message: string; tone: string }>
  }

  function makeSpyCtx(locale: HelmxLocale = 'en'): SpyCtx {
    const screenCalls: string[] = []
    const actionCalls: Array<{ actionId: string; input: unknown }> = []
    const notifications: Array<{ message: string; tone: string }> = []
    const base: PluginClientContextType = {
      pluginId: 'builtin:port-forward',
      callAction: async (actionId, input) => {
        actionCalls.push({ actionId, input })
        if (actionId === 'create') {
          return { item: { id: 'new-1', name: (input as { name?: string })?.name ?? 'created-rule' } }
        }
        if (actionId === 'pause_runtime') {
          return { stoppedListeners: 3, closedConnections: 2 }
        }
        if (actionId === 'stop_all') {
          return { stopped: 4 }
        }
        return {}
      },
      fetchRoute: async () => {
        throw new Error('fetchRoute not used')
      },
      submitInput: async () => {},
      openScreen: (target) => {
        screenCalls.push(target)
      },
      openSplitScreen: () => {},
      openConversationDrawer: () => {},
      openArtifact: () => {},
      openWorkbench: () => {},
      closeWorkbench: () => {},
      notify: (message, tone = 'info') => {
        notifications.push({ message, tone })
      },
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, { screenCalls, actionCalls, notifications })
  }

  async function mount(
    ctx: PluginClientContextType,
    element: React.ReactElement,
  ): Promise<{ host: HTMLElement; unmount: () => void }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(e(PluginClientContext.Provider, { value: ctx }, element))
    })
    await act(async () => {})
    return {
      host,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter, 'HTMLInputElement.value setter required')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const SAMPLE_NODES: NodeInfo[] = [
    { id: 'local', kind: 'local', online: true, hostname: 'hub-host' },
    { id: 'gpu-1', kind: 'byom', online: true, hostname: 'gpu-box' },
    { id: 'gpu-off', kind: 'byom', online: false, hostname: 'offline-box' },
  ]

  const SAMPLE_RULES = {
    items: [
      {
        id: 'r-working',
        name: 'vllm-api',
        nodeId: 'gpu-1',
        listenHost: '127.0.0.1',
        listenPort: 18000,
        targetHost: '127.0.0.1',
        targetPort: 8000,
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'r-listening',
        name: 'local-redis',
        nodeId: 'local',
        listenHost: '127.0.0.1',
        listenPort: 16379,
        targetHost: '127.0.0.1',
        targetPort: 6379,
        enabled: true,
        createdAt: 1001,
        updatedAt: 1001,
      },
      {
        id: 'r-waiting',
        name: 'offline-db',
        nodeId: 'gpu-off',
        listenHost: '127.0.0.1',
        listenPort: 15432,
        targetHost: '127.0.0.1',
        targetPort: 5432,
        enabled: true,
        createdAt: 1002,
        updatedAt: 1002,
      },
      {
        id: 'r-error',
        name: 'broken-port',
        nodeId: 'local',
        listenHost: '127.0.0.1',
        listenPort: 19000,
        targetHost: '127.0.0.1',
        targetPort: 9000,
        enabled: true,
        createdAt: 1003,
        updatedAt: 1003,
      },
      {
        id: 'r-stopped',
        name: 'paused-metrics',
        nodeId: 'deleted-node',
        listenHost: '127.0.0.1',
        listenPort: 19100,
        targetHost: '127.0.0.1',
        targetPort: 9100,
        enabled: false,
        createdAt: 1004,
        updatedAt: 1004,
      },
    ],
  }

  const SAMPLE_RUNTIME = {
    byId: {
      'r-working': { listenerState: 'listening', activeConnections: 2, totalConnections: 5 },
      'r-listening': { listenerState: 'listening', activeConnections: 0, totalConnections: 1 },
      'r-waiting': { listenerState: 'listening', activeConnections: 0, totalConnections: 0 },
      'r-error': {
        listenerState: 'error',
        activeConnections: 0,
        totalConnections: 0,
        lastError: 'EADDRINUSE: already in use',
      },
      'r-stopped': { listenerState: 'stopped', activeConnections: 0, totalConnections: 0 },
    },
  }

  test('manager screen: loading, single-CTA empty state, no subtitle, no stage kv-grid, and zero Emoji', TIMEOUT, async () => {
    const spy = makeSpyCtx()
    setBuiltinClientStub({ docs: {}, hostNodes: SAMPLE_NODES })
    const loadingMount = await mount(
      spy,
      e(components.PortForwardManagerScreen, {
        pluginId: 'builtin:port-forward',
        screenId: 'main',
        isSplit: false,
        params: {},
        setParams: () => {},
        inlineDrawer: true,
      }),
    )
    try {
      assert.match(loadingMount.host.textContent ?? '', /Loading port-forward rules/i)
      assert.equal(loadingMount.host.querySelector('.screen-subtitle') === null, true)
      assert.equal(EMOJI_RE.test(loadingMount.host.textContent ?? ''), false)
    } finally {
      loadingMount.unmount()
    }

    setBuiltinClientStub({ docs: { rules: { items: [] }, runtime: { byId: {} } }, hostNodes: SAMPLE_NODES })
    const emptyMount = await mount(
      spy,
      e(components.PortForwardManagerScreen, {
        pluginId: 'builtin:port-forward',
        screenId: 'main',
        isSplit: false,
        params: {},
        setParams: () => {},
        inlineDrawer: true,
      }),
    )
    try {
      assert.match(emptyMount.host.textContent ?? '', /No port-forward rules yet/i)
      assert.equal(emptyMount.host.querySelector('.screen-subtitle') === null, true, 'must not render screen subtitle')
      assert.equal(emptyMount.host.querySelectorAll('.kv-grid').length, 0, 'must not render vertical stats kv-grid')
      const newButtons = [...emptyMount.host.querySelectorAll('button')].filter((b) =>
        /New mapping/i.test(b.textContent ?? ''),
      )
      assert.equal(newButtons.length, 1, 'must render only one New mapping button (screen header actions)')
      assert.ok(
        emptyMount.host.querySelector('.screen-header .stack-row button') !== null,
        'New mapping is a screen header action (hosted: host top bar slot), not a toolbar button',
      )
      assert.ok(emptyMount.host.querySelector('.screen-toolbar .btn-primary') === null, 'toolbar carries no primary create button')
      assert.equal(
        emptyMount.host.querySelectorAll('.empty-state button').length,
        0,
        'empty state must not duplicate the New mapping CTA button',
      )
      assert.equal(
        emptyMount.host.querySelector('button[aria-label="More actions"]') === null,
        true,
        'overflow bulk menu is hidden when there are zero rules',
      )
      assert.equal(EMOJI_RE.test(emptyMount.host.textContent ?? ''), false)
    } finally {
      emptyMount.unmount()
    }
  })

  test('manager screen: SelectCard grid, StatusLight tones, pill counts, search & reset, Switch toggle, DropdownMenu bulk actions, and ConfirmDialog delete', TIMEOUT, async () => {
    const spy = makeSpyCtx()
    setBuiltinClientStub({
      docs: { rules: SAMPLE_RULES, runtime: SAMPLE_RUNTIME },
      hostNodes: SAMPLE_NODES,
      config: { allowPublicBind: false },
    })

    const paramPatches: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
    let screenParams: Record<string, string> = {}
    const screenHost = document.createElement('div')
    document.body.appendChild(screenHost)
    const { createRoot: createPFReRoot } = await import('react-dom/client')
    const pfRoot = createPFReRoot(screenHost)
    const renderPF = async () => {
      await act(async () => {
        pfRoot.render(
          e(
            PluginClientContext.Provider,
            { value: spy },
            e(components.PortForwardManagerScreen, {
              pluginId: 'builtin:port-forward',
              screenId: 'main',
              isSplit: false,
              params: screenParams,
              setParams: (patch, options) => {
                paramPatches.push({ patch, options })
                const next = { ...screenParams }
                for (const [k, v] of Object.entries(patch)) {
                  if (v === undefined) delete next[k]
                  else next[k] = v
                }
                screenParams = next
              },
              inlineDrawer: true,
            }),
          ),
        )
      })
    }
    await renderPF()
    const host = screenHost
    const unmount = () => {
      act(() => pfRoot.unmount())
      screenHost.remove()
    }
    try {
      const text = host.textContent ?? ''
      assert.equal(EMOJI_RE.test(text), false, 'UI must contain zero Emoji')
      assert.equal(host.querySelector('.screen-subtitle') === null, true)
      assert.equal(host.querySelectorAll('.kv-grid').length, 0, 'main stage must not render vertical kv-grid')
      assert.match(text, /vllm-api/)
      assert.match(text, /EADDRINUSE: already in use/)
      assert.match(text, /2 active/)

      const cards = host.querySelectorAll('.helmx-select-card')
      assert.equal(cards.length, 5)

      const tones = [...host.querySelectorAll('.helmx-status-light')].map((el) => el.getAttribute('data-tone'))
      assert.deepEqual(tones, ['working', 'done', 'blocked', 'failed', 'idle'])

      // Pill tabs with inline counts
      const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      assert.equal(tabs.length, 4)
      assert.deepEqual(
        tabs.map((tab) => tab.textContent?.replace(/\s+/g, '')),
        ['All5', 'Listening3', 'Stopped1', 'Error1'],
      )

      const errorTab = tabs.find((tab) => tab.textContent?.includes('Error'))
      assert.ok(errorTab !== undefined)
      await act(async () => {
        errorTab.click()
      })
      const filteredCards = host.querySelectorAll('.helmx-select-card')
      assert.equal(filteredCards.length, 1)
      assert.match(filteredCards[0]?.textContent ?? '', /broken-port/)

      // Back to All + SearchBox query + unmatched Reset filters
      const allTab = tabs.find((tab) => tab.textContent?.includes('All'))
      assert.ok(allTab !== undefined)
      await act(async () => {
        allTab.click()
      })
      const searchInput = host.querySelector<HTMLInputElement>('.search-box input')
      assert.ok(searchInput !== null)
      await act(async () => {
        setInputValue(searchInput, 'zzz-no-match')
      })
      assert.equal(host.querySelectorAll('.helmx-select-card').length, 0)
      const resetBtn = [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Reset filters'),
      )
      assert.ok(resetBtn !== undefined)
      await act(async () => {
        resetBtn.click()
      })
      assert.equal(host.querySelectorAll('.helmx-select-card').length, 5)

      await act(async () => {
        setInputValue(searchInput, '18000')
      })
      assert.equal(host.querySelectorAll('.helmx-select-card').length, 1)
      assert.match(host.querySelector('.helmx-select-card')?.textContent ?? '', /vllm-api/)

      // Switch toggle calls stop action without opening drawer
      const switchBtn = host.querySelector<HTMLButtonElement>('.helmx-select-card [role="switch"]')
      assert.ok(switchBtn !== null)
      await act(async () => {
        switchBtn.click()
      })
      assert.deepEqual(spy.actionCalls[0], { actionId: 'stop', input: { id: 'r-working' } })
      assert.equal(paramPatches.length, 0)

      // Overflow DropdownMenu bulk action -> pause_runtime via ConfirmDialog
      const moreTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')
      assert.ok(moreTrigger !== null)
      await act(async () => {
        moreTrigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
      })
      const pauseItem = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
        el.textContent?.includes('Pause & disconnect all'),
      )
      assert.ok(pauseItem !== undefined, 'More actions menu renders Pause & disconnect all')
      await act(async () => {
        pauseItem.click()
      })
      const pauseDialog = host.querySelector('[role="alertdialog"]')
      assert.ok(pauseDialog !== null, 'Bulk action opens ConfirmDialog')
      const pauseConfirmBtn = [...pauseDialog.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Pause & disconnect all'),
      )
      assert.ok(pauseConfirmBtn !== undefined)
      await act(async () => {
        pauseConfirmBtn.click()
      })
      assert.deepEqual(spy.actionCalls[1], { actionId: 'pause_runtime', input: {} })

      // Clicking card primary trigger requests edit drawer via useScreenDrawer ({ push: true } from closed)
      const cardTrigger = host.querySelector<HTMLButtonElement>('.helmx-select-card-trigger')
      assert.ok(cardTrigger !== null)
      await act(async () => {
        cardTrigger.click()
      })
      assert.deepEqual(paramPatches.at(-1), { patch: { edit: 'r-working', create: undefined }, options: { push: true } })
      await renderPF()

      // Closing drawer while open omits push (replace / symmetric back-pop)
      const closeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      assert.ok(closeBtn !== null)
      await act(async () => {
        closeBtn.click()
      })
      assert.deepEqual(paramPatches.at(-1), { patch: { edit: undefined, create: undefined }, options: undefined })
      await renderPF()

      // Opening create drawer from closed passes { push: true }
      const newMappingBtn = [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('New mapping'),
      )
      assert.ok(newMappingBtn !== undefined)
      await act(async () => {
        newMappingBtn.click()
      })
      assert.deepEqual(paramPatches.at(-1), { patch: { edit: undefined, create: '1' }, options: { push: true } })
      await renderPF()
      const cancelBtnFromCreate = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')
      assert.ok(cancelBtnFromCreate !== undefined)
      await act(async () => {
        cancelBtnFromCreate.click()
      })
      await renderPF()

      // Delete flow via ConfirmDialog (Cancel first, then Confirm)
      const deleteBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')
      assert.ok(deleteBtn !== null)
      await act(async () => {
        deleteBtn.click()
      })
      let alertDialog = host.querySelector('[role="alertdialog"]')
      assert.ok(alertDialog !== null, 'Delete opens ConfirmDialog')
      const cancelBtn = [...alertDialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Cancel'))
      assert.ok(cancelBtn !== undefined)
      await act(async () => {
        cancelBtn.click()
      })
      assert.equal(spy.actionCalls.length, 2)

      await act(async () => {
        deleteBtn.click()
      })
      alertDialog = host.querySelector('[role="alertdialog"]')
      assert.ok(alertDialog !== null)
      const confirmBtn = [...alertDialog.querySelectorAll('button')].find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmBtn !== undefined)
      await act(async () => {
        confirmBtn.click()
      })
      assert.deepEqual(spy.actionCalls[2], { actionId: 'delete', input: { id: 'r-working' } })
    } finally {
      unmount()
    }
  })

  test('drawer form: edit runtime KvGrid, nodes undefined disables Select, unknown node preserved, non-loopback warns & blocks when disallowed, valid create submits', TIMEOUT, async () => {
    const spy = makeSpyCtx()

    // 1. nodes === undefined while editing rule bound to 'deleted-node' -> Select must be disabled + runtime KvGrid shown
    setBuiltinClientStub({
      docs: { rules: SAMPLE_RULES, runtime: SAMPLE_RUNTIME },
      hostNodes: undefined,
      config: { allowPublicBind: false },
    })
    const loadingNodesMount = await mount(
      spy,
      e(components.PortForwardManagerScreen, {
        pluginId: 'builtin:port-forward',
        screenId: 'main',
        isSplit: false,
        params: { edit: 'r-error' },
        setParams: () => {},
        inlineDrawer: true,
      }),
    )
    try {
      const drawer = loadingNodesMount.host.querySelector('[role="dialog"]')
      assert.ok(drawer !== null)
      assert.ok(drawer.querySelector('.kv-grid') !== null, 'edit drawer shows compact runtime KvGrid')
      assert.match(drawer.textContent ?? '', /EADDRINUSE: already in use/)
      const selectTrigger = drawer.querySelector<HTMLButtonElement>('.helmx-select-trigger')
      assert.ok(selectTrigger !== null)
      assert.equal(selectTrigger.disabled, true, 'Select must be disabled while nodes === undefined')
    } finally {
      loadingNodesMount.unmount()
    }

    // 2. nodes loaded without 'deleted-node' -> Select preserves 'deleted-node (Unknown)'
    setBuiltinClientStub({
      docs: { rules: SAMPLE_RULES, runtime: SAMPLE_RUNTIME },
      hostNodes: SAMPLE_NODES,
      config: { allowPublicBind: false },
    })
    const unknownNodeMount = await mount(
      spy,
      e(components.PortForwardManagerScreen, {
        pluginId: 'builtin:port-forward',
        screenId: 'main',
        isSplit: false,
        params: { edit: 'r-stopped' },
        setParams: () => {},
        inlineDrawer: true,
      }),
    )
    try {
      const selectTrigger = unknownNodeMount.host.querySelector<HTMLButtonElement>('.helmx-select-trigger')
      assert.ok(selectTrigger !== null)
      assert.equal(selectTrigger.disabled, false)
      assert.match(selectTrigger.textContent ?? '', /deleted-node \(Unknown\)/)
    } finally {
      unknownNodeMount.unmount()
    }

    // 3. Create mode with params.node='gpu-1': non-loopback warning + validation + valid create
    const paramPatches: Array<Record<string, string | undefined>> = []
    const createMount = await mount(
      spy,
      e(components.PortForwardManagerScreen, {
        pluginId: 'builtin:port-forward',
        screenId: 'main',
        isSplit: false,
        params: { node: 'gpu-1', create: '1' },
        setParams: (patch) => paramPatches.push(patch),
        inlineDrawer: true,
      }),
    )
    try {
      const drawer = createMount.host.querySelector('[role="dialog"]')
      assert.ok(drawer !== null)
      assert.equal(drawer.querySelector('.kv-grid') === null, true, 'create drawer has no runtime KvGrid')
      const listenHostInput = drawer.querySelector<HTMLInputElement>('input[placeholder="127.0.0.1"]')
      const listenPortInput = drawer.querySelector<HTMLInputElement>('input[placeholder="8080"]')
      const targetPortInput = drawer.querySelector<HTMLInputElement>('input[placeholder="3000"]')
      assert.ok(listenHostInput !== null && listenPortInput !== null && targetPortInput !== null)

      await act(async () => {
        setInputValue(listenHostInput, '0.0.0.0')
        setInputValue(listenPortInput, '18888')
        setInputValue(targetPortInput, '8888')
      })
      assert.match(drawer.textContent ?? '', /Non-loopback bind exposes target service/i)

      const createBtn = [...drawer.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create')
      assert.ok(createBtn !== undefined)
      await act(async () => {
        createBtn.click()
      })
      assert.equal(spy.actionCalls.length, 0, 'must block non-loopback submit when allowPublicBind=false')
      assert.match(drawer.textContent ?? '', /allowPublicBind = false/)

      // Switch back to loopback and submit cleanly
      await act(async () => {
        setInputValue(listenHostInput, '127.0.0.1')
      })
      await act(async () => {
        createBtn.click()
      })
      assert.equal(spy.actionCalls.length, 1)
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'create',
        input: {
          nodeId: 'gpu-1',
          listenHost: '127.0.0.1',
          listenPort: 18888,
          targetHost: '127.0.0.1',
          targetPort: 8888,
          enabled: true,
        },
      })
      assert.deepEqual(paramPatches.at(-1), { create: undefined, edit: undefined })
    } finally {
      createMount.unmount()
    }
  })

  test('NodePortForwardsSection and PortForwardSettingsPanel: filtering and deep-link navigation', TIMEOUT, async () => {
    const spy = makeSpyCtx()
    setBuiltinClientStub({
      docs: { rules: SAMPLE_RULES, runtime: SAMPLE_RUNTIME },
      hostNodes: SAMPLE_NODES,
      config: { allowPublicBind: true },
    })

    const slotMount = await mount(
      spy,
      e(components.NodePortForwardsSection, {
        nodeId: 'gpu-1',
        isLocal: false,
        isOnline: true,
        isNew: false,
      }),
    )
    try {
      const text = slotMount.host.textContent ?? ''
      assert.match(text, /vllm-api/)
      assert.equal(text.includes('local-redis'), false, 'slot must show only rules for gpu-1')

      const newBtn = [...slotMount.host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('New mapping'),
      )
      const manageBtn = [...slotMount.host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Manage all'),
      )
      assert.ok(newBtn !== undefined && manageBtn !== undefined)
      await act(async () => {
        newBtn.click()
        manageBtn.click()
      })
      assert.deepEqual(spy.screenCalls, [
        'screen:builtin:port-forward/main?node=gpu-1&create=1',
        'screen:builtin:port-forward/main?node=gpu-1',
      ])
    } finally {
      slotMount.unmount()
    }

    const settingsSpy = makeSpyCtx()
    const settingsMount = await mount(settingsSpy, e(components.PortForwardSettingsPanel))
    try {
      const text = settingsMount.host.textContent ?? ''
      assert.match(text, /Allowed/)
      assert.match(text, /5/)
      const openBtn = [...settingsMount.host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Open port forwarding'),
      )
      assert.ok(openBtn !== undefined)
      await act(async () => {
        openBtn.click()
      })
      assert.deepEqual(settingsSpy.screenCalls, ['screen:builtin:port-forward/main'])
    } finally {
      settingsMount.unmount()
    }
  })
})
