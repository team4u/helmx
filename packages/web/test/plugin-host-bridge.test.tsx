/**
 * Real host bridge integration tests (`HelmxExternalStore` + `PluginClientHostBridge`
 * + real `@helmx/plugin-client` hooks & UI controls):
 * - Single reference-stable `PluginClientHostPort` handle shared by both
 *   `PluginClientHostContext` and `PluginClientHostHandlesContext`;
 * - High-frequency `conversationLives` token frames re-render ONLY the matching
 *   `useConversation(id)` subscriber, with zero cascade into unrelated SDK hooks,
 *   plugins, `<PluginSlot />`, or SDK UI controls (`CopyButton`, `Select`, `SearchBox`);
 * - End-to-end `useScreenLocation()` wired to URL-hash navigation targets (`screen` /
 *   `split` / `setScreenParams` / `closeSplit`) with semantic deduplication;
 * - Three-state `loaded / auth / error` honesty across `useHostModels`, `usePluginDoc`,
 *   `useConversation`, and `useConversationBackground`;
 * - Centralized `conversationBackground` derived slice shared by host & SDK with
 *   exact reference identity and isolation from unrelated plugin docs & live frames.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  CopyButton,
  PluginClientContext,
  PluginClientHostContext,
  PluginSlot,
  SearchBox,
  Select,
  createPluginClientContext,
  useConversation,
  useConversations,
  useHostModels,
  usePluginConfig,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  usePlugins,
  type PluginClientHostPort,
} from '@helmx/plugin-client'
import type {
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  HostModelsSlice,
  PluginSummary,
  PluginUiContribution,
} from '@helmx/protocol'
import { applyTransientLiveFrame } from '../src/lib/live-state.js'
import { useConversationBackgroundSlice } from '../src/lib/store-context.js'
import type { HelmxExternalStore, HelmxStoreActions } from '../src/lib/helmx-store.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const e = React.createElement
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `Conv ${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp/ws',
    model: 'openai/gpt-4o',
    thinkingLevel: 'off',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 100,
    updatedAt: 100 + id,
    ...overrides,
  }
}

function makeDetail(conv: ConversationSummary): ConversationDetail {
  return { ...conv, entries: [] }
}

function makeAsk(id: string, conversationId: number): AskSpec {
  return {
    id,
    conversationId,
    title: `Ask ${id}`,
    fields: [],
    status: 'pending',
    createdAt: 1,
  }
}

function spyAction<K extends keyof HelmxStoreActions>(
  store: HelmxExternalStore,
  key: K,
  impl: HelmxStoreActions[K],
): void {
  ;(store.actions as unknown as Record<K, HelmxStoreActions[K]>)[key] = impl
}

const cleanups: Array<() => void> = []

function mountTree(tree: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(tree)
  })
  cleanups.push(() => {
    act(() => root.unmount())
    host.remove()
  })
  return { host, root }
}

describe('plugin-host-bridge', () => {
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  test('stable port handle & streaming isolation: conversationLives bursts only re-render the matching useConversation subscriber', { timeout: 60_000 }, () => {
    const conv1 = makeConv(1, { status: 'working' })
    const conv2 = makeConv(2, { status: 'idle' })
    const plugin1: PluginSummary = {
      id: 'p1',
      name: 'Plugin One',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
      publicConfig: { refreshMs: 1000 },
    }
    const store = makeTestStore({
      authenticated: true,
      theme: 'dark',
      locale: 'en',
      assetsLoaded: true,
      models: [{ id: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o', available: true, thinkingLevels: ['off'] }],
      conversations: [conv1, conv2],
      conversationDetails: { 1: makeDetail(conv1), 2: makeDetail(conv2) },
      plugins: [plugin1],
      pluginDocs: { 'p1/state': { count: 1 }, 'p2/other': { count: 2 } },
    })

    const observedPorts: PluginClientHostPort[] = []
    const counts = {
      contextHolder: 0,
      conv1: 0,
      conv2: 0,
      convsList: 0,
      plugins: 0,
      config: 0,
      docP1: 0,
      locale: 0,
      pluginCtx: 0,
      models: 0,
      slot: 0,
      controls: 0,
    }
    let lastConv1Text = ''
    let lastTheme: 'light' | 'dark' | undefined
    let lastLocale: string | undefined

    const Conv1Probe = React.memo(function Conv1Probe(): React.ReactNode {
      counts.conv1 += 1
      lastConv1Text = useConversation(1).live?.text ?? ''
      return null
    })
    const Conv2Probe = React.memo(function Conv2Probe(): React.ReactNode {
      counts.conv2 += 1
      void useConversation(2)
      return null
    })
    const ConvsListProbe = React.memo(function ConvsListProbe(): React.ReactNode {
      counts.convsList += 1
      void useConversations()
      return null
    })
    const PluginsProbe = React.memo(function PluginsProbe(): React.ReactNode {
      counts.plugins += 1
      void usePlugins()
      return null
    })
    const ConfigProbe = React.memo(function ConfigProbe(): React.ReactNode {
      counts.config += 1
      void usePluginConfig()
      return null
    })
    const DocP1Probe = React.memo(function DocP1Probe(): React.ReactNode {
      counts.docP1 += 1
      void usePluginDoc('state')
      return null
    })
    const LocaleProbe = React.memo(function LocaleProbe(): React.ReactNode {
      counts.locale += 1
      lastLocale = usePluginLocale()
      void usePluginTranslator()
      return null
    })
    const PluginCtxProbe = React.memo(function PluginCtxProbe(): React.ReactNode {
      counts.pluginCtx += 1
      lastTheme = usePluginContext().theme
      return null
    })
    const ModelsProbe = React.memo(function ModelsProbe(): React.ReactNode {
      counts.models += 1
      void useHostModels()
      return null
    })
    const SlotProbe = React.memo(function SlotProbe(): React.ReactNode {
      counts.slot += 1
      return e(PluginSlot, { name: 'owner/zone', ownerPluginId: 'owner', conversationId: 1 })
    })
    const ControlsProbe = React.memo(function ControlsProbe(): React.ReactNode {
      counts.controls += 1
      return e(
        'div',
        null,
        e(CopyButton, { text: 'copy me' }),
        e(SearchBox, { value: '', onChange: () => {} }),
        e(Select, { value: 'a', options: [{ value: 'a', label: 'A' }], onChange: () => {} }),
      )
    })

    const ContextHolder = React.memo(function ContextHolder(): React.ReactNode {
      counts.contextHolder += 1
      const port = React.useContext(PluginClientHostContext)
      assert.ok(port !== null)
      observedPorts.push(port)
      const ctx = React.useMemo(() => createPluginClientContext(port, 'p1', 1), [port])
      return e(
        PluginClientContext.Provider,
        { value: ctx },
        e(Conv1Probe),
        e(Conv2Probe),
        e(ConvsListProbe),
        e(PluginsProbe),
        e(ConfigProbe),
        e(DocP1Probe),
        e(LocaleProbe),
        e(PluginCtxProbe),
        e(ModelsProbe),
        e(SlotProbe),
        e(ControlsProbe),
      )
    })

    const { host } = mountTree(e(HostStoreProviders, { value: store }, e(ContextHolder)))
    assert.equal(observedPorts.length, 1)
    assert.equal(host.querySelector('button')?.getAttribute('title'), 'Copy')
    const baseline = { ...counts }

    // 1. Burst 20 streaming token frames on conversation #1.
    for (let i = 1; i <= 20; i += 1) {
      act(() => {
        store.updateLive((prev) =>
          applyTransientLiveFrame(prev, {
            live: { conversationId: 1, text: `token-${i}`, tools: [], updatedAt: 1000 + i } as ConversationLive,
          }),
        )
      })
    }

    assert.equal(lastConv1Text, 'token-20')
    assert.equal(counts.conv1, baseline.conv1 + 20, 'matching useConversation(1) receives all 20 live frames')
    assert.equal(counts.contextHolder, baseline.contextHolder, 'host bridge never churns PluginClientHostContext value')
    assert.equal(counts.conv2, baseline.conv2, 'useConversation(2) is completely isolated from #1 live frames')
    assert.equal(counts.convsList, baseline.convsList, 'useConversations is isolated from live frames')
    assert.equal(counts.plugins, baseline.plugins, 'usePlugins is isolated from live frames')
    assert.equal(counts.config, baseline.config, 'usePluginConfig is isolated from live frames')
    assert.equal(counts.docP1, baseline.docP1, 'usePluginDoc is isolated from live frames')
    assert.equal(counts.locale, baseline.locale, 'usePluginLocale / usePluginTranslator are isolated from live frames')
    assert.equal(counts.pluginCtx, baseline.pluginCtx, 'usePluginContext is isolated from live frames')
    assert.equal(counts.models, baseline.models, 'useHostModels is isolated from live frames')
    assert.equal(counts.slot, baseline.slot, 'PluginSlot is isolated from live frames')
    assert.equal(counts.controls, baseline.controls, 'SDK UI controls (CopyButton/SearchBox/Select) do not re-render on live frames')

    // 2. Unrelated plugin doc update does not wake p1/state subscriber.
    act(() => {
      store.updateLive((prev) => ({
        ...prev,
        pluginDocs: { ...prev.pluginDocs, 'p2/other': { count: 99 } },
      }))
    })
    assert.equal(counts.docP1, baseline.docP1)
    assert.equal(counts.contextHolder, baseline.contextHolder)

    // 3. Pending ask update on conv #2 does not wake conv #1.
    const conv1AfterStream = counts.conv1
    act(() => {
      store.updateLive((prev) => ({ ...prev, pendingAsks: [makeAsk('ask-2', 2)] }))
    })
    assert.equal(counts.conv1, conv1AfterStream, 'conv #2 pending ask does not wake conv #1')
    assert.equal(counts.conv2, baseline.conv2 + 1, 'conv #2 receives its pending ask')

    // 4. Theme change updates usePluginContext().theme without re-rendering locale/doc/controls.
    act(() => store.setTheme('light'))
    assert.equal(lastTheme, 'light')
    assert.equal(counts.pluginCtx, baseline.pluginCtx + 1)
    assert.equal(counts.locale, baseline.locale, 'theme-only toggle does not re-render usePluginLocale')
    assert.equal(counts.controls, baseline.controls, 'theme-only toggle does not re-render locale-only SDK controls')
    assert.equal(counts.docP1, baseline.docP1, 'theme-only toggle does not re-render usePluginDoc')
    assert.equal(counts.contextHolder, baseline.contextHolder, 'theme change keeps port handle identity constant')

    // 5. Locale change updates locale consumers & SDK controls in place without re-rendering unrelated parents or docs.
    act(() => store.setLocale('zh-CN'))
    assert.equal(lastLocale, 'zh-CN')
    assert.equal(counts.locale, baseline.locale + 1)
    assert.equal(host.querySelector('button')?.getAttribute('title'), '复制', 'SDK CopyButton updates localized label in place')
    assert.equal(counts.controls, baseline.controls, 'outer ControlsProbe wrapper does not need to re-render when child SDK controls update locale')
    assert.equal(counts.docP1, baseline.docP1)
  })

  test('three-state loaded/auth/error honesty across real bridge: useHostModels, usePluginDoc, and useConversation', { timeout: 60_000 }, () => {
    const store = makeTestStore({
      authenticated: false,
      assetsLoaded: false,
      models: [],
      conversations: [makeConv(5)],
    })
    const ensuredDocs: Array<[string, string]> = []
    const detailCalls: Array<{ id: number; force?: boolean }> = []
    spyAction(store, 'ensurePluginDoc', async (pluginId, docName) => {
      ensuredDocs.push([pluginId, docName])
      return undefined
    })
    spyAction(store, 'loadConversationDetail', async (id, force) => {
      detailCalls.push({ id, force })
      return undefined
    })

    const observed: { models: HostModelsSlice | undefined; doc: unknown; error: string | undefined } = {
      models: { models: [] },
      doc: 'unset',
      error: undefined,
    }
    const readModels = (): HostModelsSlice | undefined => observed.models
    let reloadConv: (() => void) | undefined

    function Probe(): React.ReactNode {
      observed.models = useHostModels()
      observed.doc = usePluginDoc('catalog')
      const conv = useConversation(5)
      observed.error = conv.loadError
      reloadConv = conv.reload
      return null
    }

    function WithPlugin({ children }: { children: React.ReactNode }): React.ReactNode {
      const port = React.useContext(PluginClientHostContext)
      assert.ok(port !== null)
      const ctx = React.useMemo(() => createPluginClientContext(port, 'p1', 5), [port])
      return e(PluginClientContext.Provider, { value: ctx }, children)
    }

    mountTree(e(HostStoreProviders, { value: store }, e(WithPlugin, null, e(Probe))))

    // 1. Pre-load models slice is strictly undefined (never empty truth).
    assert.ok(readModels() === undefined, 'assetsLoaded=false keeps useHostModels() strictly undefined')

    // 2. Unauthenticated doc read does not call ensurePluginDoc.
    assert.equal(observed.doc, undefined)
    assert.deepEqual(ensuredDocs, [], 'unauthenticated state blocks auto ensurePluginDoc')

    // 3. Initial missing detail triggers auto-load once; recording loadError surfaces verbatim and stops retry loop.
    assert.deepEqual(detailCalls, [{ id: 5, force: undefined }])
    act(() => store.reportLoad('conversation:5', new Error('network down')))
    assert.equal(observed.error, 'network down')
    assert.equal(detailCalls.length, 1, 'loadError prevents automatic retry storm')
    act(() => reloadConv?.())
    assert.deepEqual(detailCalls, [
      { id: 5, force: undefined },
      { id: 5, force: true },
    ])

    // 4. Flipping assetsLoaded=true with empty models yields { models: [] } (strictly distinct from undefined).
    const hydrate = store as unknown as {
      patchAuth: (p: { authenticated: boolean }) => void
      patchCatalog: (p: { assetsLoaded?: boolean; models?: unknown[] }) => void
    }
    act(() => hydrate.patchCatalog({ assetsLoaded: true, models: [] }))
    const loadedEmpty = readModels()
    assert.ok(loadedEmpty !== undefined && loadedEmpty.models.length === 0, 'loaded-empty models is { models: [] }, distinct from undefined')

    // 5. Populating models updates slice; logout resets back to undefined.
    act(() =>
      hydrate.patchCatalog({
        models: [{ id: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o', available: true, thinkingLevels: ['off'] }],
      }),
    )
    assert.equal(readModels()?.models.length, 1)

    // 6. Auth transition triggers ensurePluginDoc once.
    act(() => hydrate.patchAuth({ authenticated: true }))
    assert.deepEqual(ensuredDocs, [['p1', 'catalog']])

    // 7. Logout resets hostModels back to undefined.
    act(() => store.finishLogoutStateReset())
    assert.ok(readModels() === undefined, 'logout returns hostModels to unknown (undefined)')
  })

  test('centralized conversationBackground slice: host honest unknown gate and immune to unrelated churn', { timeout: 60_000 }, () => {
    const panelContribution: PluginUiContribution = {
      pluginId: 'builtin:workflow',
      surface: 'workbench.panel',
      spec: {
        id: 'runs',
        label: 'Runs',
        badge: { doc: 'run-badges', byConversationField: 'byConversation' },
        client: { module: 'index.tsx', export: 'Runs' },
      },
    }
    const store = makeTestStore({
      locale: 'en',
      conversations: [makeConv(1, { status: 'idle' })],
      uiContributions: [panelContribution],
      pluginDocs: {},
    })

    let hostRenders = 0
    let hostSlice: ReturnType<typeof useConversationBackgroundSlice> | undefined

    const HostBgProbe = React.memo(function HostBgProbe(): React.ReactNode {
      hostRenders += 1
      hostSlice = useConversationBackgroundSlice()
      return null
    })

    mountTree(e(HostStoreProviders, { value: store }, e(HostBgProbe)))

    assert.equal(hostRenders, 1)
    assert.equal(hostSlice?.snapshot.unknown, true, 'missing badge doc keeps background honestly unknown')
    assert.equal(hostSlice?.badgeDocs.length, 1)
    assert.equal(hostSlice?.pendingBadgeDocs.has('builtin:workflow/run-badges'), true)

    act(() => {
      store.updateLive((prev) => ({
        ...prev,
        pluginDocs: { ...prev.pluginDocs, 'other:plugin/stats': { x: 1 } },
        conversationLives: { 1: { conversationId: 1, text: 'streaming', tools: [], updatedAt: 5 } },
        conversations: [makeConv(1, { status: 'idle', title: 'Renamed Conv 1' })],
      }))
    })
    assert.equal(hostRenders, 1, 'unrelated docs, live frames, and title changes trigger zero background re-renders')

    act(() => {
      store.updateLive((prev) => ({
        ...prev,
        pluginDocs: {
          ...prev.pluginDocs,
          'builtin:workflow/run-badges': {
            byConversation: { '1': { count: 2, tone: 'accent', footerText: '2 Running' } },
          },
        },
      }))
    })
    assert.equal(hostRenders, 2)
    assert.equal(hostSlice?.snapshot.unknown, false)
    assert.deepEqual(hostSlice?.snapshot.byConversation.get(1), { active: true, summary: '2 Running' })

    const badgeDocsBeforeLocale = hostSlice?.badgeDocs
    const pendingBeforeLocale = hostSlice?.pendingBadgeDocs
    act(() => {
      store.updateLive((prev) => ({
        ...prev,
        conversations: [
          makeConv(1, {
            status: 'idle',
            contextUsage: { tokens: 1000, contextWindow: 10000, compacting: true },
          }),
        ],
      }))
    })
    assert.equal(hostSlice?.snapshot.byConversation.get(1)?.summary, '2 Running · Compacting context')
    act(() => store.setLocale('zh-CN'))
    assert.equal(hostSlice?.snapshot.byConversation.get(1)?.summary, '2 Running · 上下文精简中')
    assert.ok(hostSlice?.badgeDocs === badgeDocsBeforeLocale, 'locale switch keeps badgeDocs reference stable')
    assert.ok(hostSlice?.pendingBadgeDocs === pendingBeforeLocale, 'locale switch keeps pendingBadgeDocs reference stable')
  })
})
