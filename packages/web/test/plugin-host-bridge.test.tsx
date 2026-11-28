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
import { CopyButton, SearchBox, Select } from '@helmx/ui'
import {
  PluginClientContext,
  PluginClientHostContext,
  PluginSlot,
  createPluginClientContext,
  useConversation,
  useConversations,
  useHostModels,
  useHostNodes,
  useHostProfiles,
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
  HelmxSnapshot,
  HostModelsSlice,
  HostNodesSlice,
  HostProfilesSlice,
  NodeInfo,
  PluginSummary,
  PluginUiContribution,
  Profile,
} from '@helmx/protocol'
import { applyEventFrame, applySnapshot, applyTransientLiveFrame } from '../src/lib/live-state.js'
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
      nodes: 0,
      profiles: 0,
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
    const NodesProbe = React.memo(function NodesProbe(): React.ReactNode {
      counts.nodes += 1
      void useHostNodes()
      return null
    })
    const ProfilesProbe = React.memo(function ProfilesProbe(): React.ReactNode {
      counts.profiles += 1
      void useHostProfiles()
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
        e(NodesProbe),
        e(ProfilesProbe),
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
    assert.equal(counts.nodes, baseline.nodes, 'useHostNodes is isolated from live frames')
    assert.equal(counts.profiles, baseline.profiles, 'useHostProfiles is isolated from live frames')
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
    assert.equal(counts.nodes, baseline.nodes, 'unrelated doc/theme/locale updates do not wake useHostNodes')
    assert.equal(counts.profiles, baseline.profiles, 'unrelated doc/theme/locale updates do not wake useHostProfiles')
  })

  test('three-state loaded honesty & domain isolation across real bridge: useHostNodes and useHostProfiles', { timeout: 60_000 }, async (t) => {
    const localNode: NodeInfo = { id: 'local', kind: 'local', online: true }
    const gpuNode: NodeInfo = { id: 'gpu-1', kind: 'byom', online: true }
    const assistantProfile: Profile = { id: 'assistant', name: 'Assistant' } as Profile
    const reviewerProfile: Profile = { id: 'reviewer', name: 'Reviewer' } as Profile

    const store = makeTestStore({
      authenticated: true,
      assetsLoaded: false,
      profilesLoaded: false,
      nodesLoaded: false,
      nodes: [],
      profiles: [],
      models: [],
    })

    const renders = { nodes: 0, profiles: 0, models: 0 }
    const observed: {
      nodes: HostNodesSlice | undefined
      profiles: HostProfilesSlice | undefined
      models: HostModelsSlice | undefined
    } = {
      nodes: [localNode],
      profiles: [assistantProfile],
      models: { models: [] },
    }
    const readNodes = (): HostNodesSlice | undefined => observed.nodes
    const readProfiles = (): HostProfilesSlice | undefined => observed.profiles
    const readModels = (): HostModelsSlice | undefined => observed.models

    const NodesProbe = React.memo(function NodesProbe(): React.ReactNode {
      renders.nodes += 1
      observed.nodes = useHostNodes()
      return null
    })
    const ProfilesProbe = React.memo(function ProfilesProbe(): React.ReactNode {
      renders.profiles += 1
      observed.profiles = useHostProfiles()
      return null
    })
    const ModelsProbe = React.memo(function ModelsProbe(): React.ReactNode {
      renders.models += 1
      observed.models = useHostModels()
      return null
    })

    mountTree(e(HostStoreProviders, { value: store }, e(NodesProbe), e(ProfilesProbe), e(ModelsProbe)))

    // 1. Pre-load states are strictly undefined (never empty arrays)
    assert.ok(readNodes() === undefined, 'nodesLoaded=false keeps useHostNodes() strictly undefined')
    assert.ok(readProfiles() === undefined, 'profilesLoaded=false keeps useHostProfiles() strictly undefined')
    assert.ok(readModels() === undefined, 'assetsLoaded=false keeps useHostModels() strictly undefined')
    assert.deepEqual(renders, { nodes: 1, profiles: 1, models: 1 })

    // 2. Snapshot omitting `nodes` keeps useHostNodes() strictly undefined
    const snapWithoutNodes: HelmxSnapshot = {
      bootId: 'boot-1',
      seq: 1,
      conversations: [],
      pendingAsks: [],
      plugins: [],
      ui: [],
    }
    act(() => store.updateLive((prev) => applySnapshot(prev, snapWithoutNodes)))
    assert.ok(readNodes() === undefined, 'snapshot omitting nodes keeps useHostNodes() undefined')
    assert.equal(renders.nodes, 1)

    // 3. Snapshot with `nodes: []` transitions to loaded-empty [] without waking profiles/models
    act(() => store.updateLive((prev) => applySnapshot(prev, { ...snapWithoutNodes, seq: 2, nodes: [] })))
    const loadedEmptyNodes = readNodes()
    assert.ok(loadedEmptyNodes !== undefined && loadedEmptyNodes.length === 0, 'loaded-empty nodes is [], distinct from undefined')
    assert.equal(renders.nodes, 2)
    assert.equal(renders.profiles, 1, 'nodes snapshot must not re-render useHostProfiles')
    assert.equal(renders.models, 1, 'nodes snapshot must not re-render useHostModels')

    // 4. Incremental SSE node.changed updates useHostNodes() reactively
    act(() =>
      store.updateLive((prev) =>
        applyEventFrame(prev, { seq: 3, event: { type: 'node.changed', node: localNode } }),
      ),
    )
    assert.deepEqual(readNodes()?.map((n) => n.id), ['local'])
    assert.equal(renders.nodes, 3)
    assert.equal(renders.profiles, 1)

    act(() =>
      store.updateLive((prev) =>
        applyEventFrame(prev, { seq: 4, event: { type: 'node.changed', node: gpuNode } }),
      ),
    )
    assert.deepEqual(readNodes()?.map((n) => n.id), ['local', 'gpu-1'])
    assert.equal(renders.nodes, 4)

    // 5. Profiles loaded empty -> populated -> later assetsLoaded=true must NOT re-render useHostProfiles
    const hydrate = store as unknown as {
      patchCatalog: (p: {
        profilesLoaded?: boolean
        assetsLoaded?: boolean
        profiles?: Profile[]
        models?: unknown[]
      }) => void
    }
    act(() => hydrate.patchCatalog({ profilesLoaded: true, profiles: [] }))
    const loadedEmptyProfiles = readProfiles()
    assert.ok(loadedEmptyProfiles !== undefined && loadedEmptyProfiles.length === 0, 'loaded-empty profiles is [], distinct from undefined')
    assert.equal(renders.profiles, 2)
    assert.equal(renders.nodes, 4, 'profiles load must not re-render useHostNodes')
    assert.equal(renders.models, 1, 'profiles load must not re-render useHostModels')

    const populatedProfiles = [assistantProfile, reviewerProfile]
    act(() => hydrate.patchCatalog({ profiles: populatedProfiles }))
    assert.ok(readProfiles() === populatedProfiles, 'useHostProfiles forwards the exact stable array reference')
    assert.equal(renders.profiles, 3)
    assert.equal(renders.nodes, 4)

    act(() => hydrate.patchCatalog({ assetsLoaded: true, models: [] }))
    assert.equal(renders.models, 2)
    assert.equal(renders.profiles, 3, 'flipping assetsLoaded=true without changing profiles must NOT re-render useHostProfiles')
    assert.equal(renders.nodes, 4, 'flipping assetsLoaded=true must NOT re-render useHostNodes')

    // 6. Logout resets all three slices back to undefined
    act(() => store.finishLogoutStateReset())
    assert.ok(readNodes() === undefined, 'logout returns useHostNodes() to undefined')
    assert.ok(readProfiles() === undefined, 'logout returns useHostProfiles() to undefined')
    assert.ok(readModels() === undefined, 'logout returns useHostModels() to undefined')

    // 7. HTTP refreshNodes() recovers nodesLoaded=true and populates useHostNodes()
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([gpuNode, localNode]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    await act(async () => {
      await store.actions.refreshNodes()
    })
    assert.deepEqual(readNodes()?.map((n) => n.id), ['local', 'gpu-1'], 'refreshNodes marks nodesLoaded=true and sorts local first')
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

  test('PluginClientHostPort.getServerNow injects calibrated serverNow for SDK useSharedNowMs consumers', { timeout: 60_000 }, async () => {
    const { useSharedNowMs } = await import('@helmx/plugin-client')
    const { observeServerEpoch, resetServerClock } = await import('../src/lib/server-clock.js')
    resetServerClock()
    const skewMs = 15_000
    observeServerEpoch(Date.now() - skewMs)

    const store = makeTestStore({ conversations: [makeConv(1, { status: 'working' })] })
    let sampledPortNow: number | undefined
    let sampledHookNow: number | undefined

    function ClockProbe(): React.ReactNode {
      const port = React.useContext(PluginClientHostContext)
      sampledPortNow = port?.getServerNow?.()
      sampledHookNow = useSharedNowMs(true)
      return null
    }

    try {
      mountTree(e(HostStoreProviders, { value: store }, e(ClockProbe)))
      assert.ok(typeof sampledPortNow === 'number' && Number.isFinite(sampledPortNow), 'host port exposes getServerNow')
      assert.ok(typeof sampledHookNow === 'number' && Number.isFinite(sampledHookNow), 'useSharedNowMs samples host getServerNow on mount')
      const offset = Date.now() - sampledHookNow
      assert.ok(Math.abs(offset - skewMs) < 1500, `useSharedNowMs should inherit ~${skewMs}ms calibrated server offset, got ${offset}ms`)
    } finally {
      resetServerClock()
    }
  })

  test('refreshAssets: failed /api/models must not mark models empty-and-loaded; subsequent success recovers cleanly', { timeout: 60_000 }, async (t) => {
    const store = makeTestStore({
      authenticated: true,
      assetsLoaded: false,
      profilesLoaded: false,
      models: [],
    })
    let observedHostModels: HostModelsSlice | undefined = { models: [] }
    const readHostModels = (): HostModelsSlice | undefined => observedHostModels
    function ModelsProbe(): React.ReactNode {
      observedHostModels = useHostModels()
      return null
    }
    mountTree(e(HostStoreProviders, { value: store }, e(ModelsProbe)))
    assert.ok(readHostModels() === undefined, 'pre-load host models slice starts undefined')

    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    let modelResponseMode: 'fail' | 'empty' | 'populated' = 'fail'
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/models') {
        if (modelResponseMode === 'fail') {
          return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'models backend down' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (modelResponseMode === 'empty') {
          return new Response(JSON.stringify({ models: [], thinkingLevels: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({
            models: [{ provider: 'openai', modelId: 'gpt-4o', available: true }],
            thinkingLevels: { 'openai/gpt-4o': ['off', 'high'] },
            defaultModel: 'openai/gpt-4o',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    // 1. Initial refresh where /api/models fails: assetsLoaded finishes, but hostModels MUST stay undefined (NOT { models: [] })
    await act(async () => {
      await store.actions.refreshAssets()
    })
    assert.equal(store.getCatalogSlice().assetsLoaded, true)
    assert.ok(store.getHostModelsSlice() === undefined, 'failed initial /api/models must keep hostModelsSlice undefined')
    assert.ok(readHostModels() === undefined, 'useHostModels() must stay undefined instead of falsely loaded-empty')
    assert.equal(store.getLoadError('assets:models'), 'models backend down')

    // 2. Subsequent refresh where /api/models succeeds with genuinely empty list -> transitions to { models: [] }
    modelResponseMode = 'empty'
    await act(async () => {
      await store.actions.refreshAssets()
    })
    const emptyModels = readHostModels()
    assert.ok(emptyModels !== undefined && emptyModels.models.length === 0, 'genuinely empty 200 /api/models transitions to { models: [] }')
    assert.equal(store.getLoadError('assets:models'), undefined, 'successful /api/models clears assets:models loadError')

    // 3. Populate models, then fail a later refresh -> preserves last known good catalog
    modelResponseMode = 'populated'
    await act(async () => {
      await store.actions.refreshAssets()
    })
    assert.equal(readHostModels()?.models.length, 1)
    assert.equal(readHostModels()?.defaultModel, 'openai/gpt-4o')

    modelResponseMode = 'fail'
    await act(async () => {
      await store.actions.refreshAssets()
    })
    assert.equal(readHostModels()?.models.length, 1, 'subsequent /api/models failure preserves previously loaded models')
    assert.equal(store.getLoadError('assets:models'), 'models backend down')
  })

  test('checkAuth latest-request-wins: stale resolutions, stale rejections, onAuthenticated, logout, and dispose cannot regress auth state', { timeout: 60_000 }, async (t) => {
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })

    interface PendingAuthCall {
      signal: AbortSignal | undefined
      resolve: (res: Response) => void
      reject: (err: unknown) => void
    }
    const pending: PendingAuthCall[] = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), '/api/auth/status')
      return new Promise<Response>((resolve, reject) => {
        pending.push({ signal: init?.signal ?? undefined, resolve, reject })
      })
    }) as typeof fetch

    const store = makeTestStore({ authReady: false, authenticated: false, authConfigured: false, authError: null })

    // 1. Concurrent checkAuth: call #2 finishes first with authenticated=true; stale call #1 later resolves/rejects and is ignored
    const call1 = store.checkAuth()
    const call2 = store.checkAuth()
    assert.equal(pending.length, 2)
    assert.equal(pending[0]!.signal?.aborted, true, 'newer checkAuth aborts superseded request signal')
    assert.equal(pending[1]!.signal?.aborted, false)

    pending[1]!.resolve(
      new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await call2
    assert.equal(store.getAuthSlice().authenticated, true)
    assert.equal(store.getAuthSlice().authReady, true)
    assert.equal(store.getAuthSlice().authError, null)

    // Stale call #1 resolves with authenticated=false even after abort (simulating slow/unabortable transport): must be dropped
    pending[0]!.resolve(
      new Response(JSON.stringify({ configured: true, authenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await call1
    assert.equal(store.getAuthSlice().authenticated, true, 'stale checkAuth resolution must not clobber newer authenticated state')
    assert.equal(store.getAuthSlice().authError, null)

    // 2. Stale checkAuth rejection after newer checkAuth success must not set authError
    const call3 = store.checkAuth()
    const call4 = store.checkAuth()
    pending[3]!.resolve(
      new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await call4
    pending[2]!.reject(new Error('late network error'))
    await call3
    assert.equal(store.getAuthSlice().authenticated, true)
    assert.equal(store.getAuthSlice().authError, null, 'stale checkAuth rejection must not overwrite newer auth state')

    // 3. onAuthenticated during in-flight checkAuth invalidates the in-flight checkAuth
    const call5 = store.checkAuth()
    await store.onAuthenticated('fresh-tok')
    assert.equal(pending[4]!.signal?.aborted, true, 'onAuthenticated aborts in-flight checkAuth')
    pending[4]!.resolve(
      new Response(JSON.stringify({ configured: true, authenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await call5
    assert.equal(store.getAuthSlice().authenticated, true, 'stale checkAuth must not clobber onAuthenticated')

    // 4. Logout during in-flight checkAuth invalidates the in-flight checkAuth
    const call6 = store.checkAuth()
    store.prepareLogoutHistoryReset()
    store.finishLogoutStateReset()
    assert.equal(pending[5]!.signal?.aborted, true, 'logout aborts in-flight checkAuth')
    pending[5]!.resolve(
      new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await call6
    assert.equal(store.getAuthSlice().authenticated, false, 'stale checkAuth must not re-authenticate after logout')

    // 5. dispose() during in-flight checkAuth invalidates the in-flight checkAuth
    const call7 = store.checkAuth()
    store.dispose()
    assert.equal(pending[6]!.signal?.aborted, true, 'dispose aborts in-flight checkAuth')
    pending[6]!.reject(new Error('after dispose'))
    await call7
    assert.equal(store.getAuthSlice().authError, null, 'disposed store ignores late checkAuth error')
  })
})
