/**
 * @helmx/plugin-client standalone package contract tests (no web/kernel
 * implementation dependency):
 * 1. Export symbols are bidirectionally locked against the protocol
 *    PLUGIN_CLIENT_SHARED_EXPORTS list (every listed symbol actually exists at
 *    runtime; plugin-facing symbols are never undefined);
 * 2. Host port Provider contract: usePluginDoc / usePluginSessionDoc /
 *    useConversations / useConversation / usePlugins / usePluginContext all
 *    fetch data through the port injected via PluginClientHostContext; a
 *    missing port throws explicitly (never silently degraded);
 * 3. createPluginClientContext port-forwarding contract: callAction
 *    cross-plugin addressing, submitInput origin=agent payload, and
 *    navigation / notification / doc methods each forwarding to the real port;
 * 4. PluginSlot port contract: short-name qualification, single first item,
 *    fallback, and explicit cycle warning;
 * 5. MarkdownView / CodeBlockView port delegation: renders the host-injected
 *    implementations;
 * 6. ToolCallDetails: shared inline tool-call details primitive renders the
 *    raw input/output via host trace classes and forwards the artifact button
 *    to the host previewer.
 *
 * Note: error-message regexes below pin the exact English messages thrown by
 * host-port.ts / plugin-context.ts so that explicit failure behavior remains
 * covered.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  PLUGIN_CLIENT_SHARED_EXPORTS,
  UI_SHARED_EXPORTS,
  resolveLocalizedText,
  type AskSpec,
  type ConversationDetail,
  type ConversationLive,
  type ConversationSummary,
  type NodeInfo,
  type PluginSummary,
  type Profile,
  type ScreenSpec,
  type UsePluginsResult,
} from '@helmx/protocol'
import { CopyButton } from '@helmx/ui'
import * as SDK from '../src/index.js'
import * as PureSDK from '../src/pure.js'

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. Bidirectional export-list locking
// ---------------------------------------------------------------------------

test('every symbol in PLUGIN_CLIENT_SHARED_EXPORTS actually exists in this package runtime namespace and zero @helmx/ui primitives are re-exported', { timeout: 60_000 }, () => {
  const exportedNames = new Set(Object.keys(SDK))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `@helmx/plugin-client is missing manifest symbol ${name} (PLUGIN_CLIENT_SHARED_EXPORTS drifted from the implementation)`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `symbol ${name} must not be undefined`)
  }
  const uiSet = new Set<string>(UI_SHARED_EXPORTS)
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.equal(uiSet.has(name), false, `PLUGIN_CLIENT_SHARED_EXPORTS must not overlap with UI_SHARED_EXPORTS (${name})`)
  }
  // Zero UI primitive re-exports: UI primitives belong strictly to @helmx/ui.
  for (const forbidden of [
    'Button', 'IconButton', 'Badge', 'Kbd', 'Stack', 'Input', 'Textarea', 'Field',
    'Card', 'SelectCard', 'CardGrid', 'List', 'ListRow', 'MonoId', 'SearchBox',
    'EmptyState', 'LoadingState', 'Screen', 'ScreenSection', 'ScreenToolbar',
    'DataTable', 'KvGrid', 'DetailDrawer', 'DockTray', 'Dialog', 'ModalDialog',
    'Popover', 'Tooltip', 'DropdownMenu', 'AlertDialog', 'ConfirmDialog',
    'Switch', 'Checkbox', 'Select', 'MultiSelect', 'Tabs', 'SegmentedControl',
    'StatusLight', 'Callout', 'ViewBoundary', 'CopyButton', 'copyToClipboard',
    'HelmxIcon', 'ScreenHostContext', 'useScreenHost', 'formatTime', 'formatDurationMs',
  ]) {
    assert.equal(exportedNames.has(forbidden), false, `@helmx/plugin-client must not re-export @helmx/ui symbol ${forbidden}`)
  }
})

test('default-chain model helper is in the SDK export manifest and shared by the component and pure entries', { timeout: 60_000 }, () => {
  assert.ok((PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes('resolveDefaultChainThinkingLevel'))
  assert.equal(typeof SDK.resolveDefaultChainThinkingLevel, 'function')
  assert.ok(SDK.resolveDefaultChainThinkingLevel === PureSDK.resolveDefaultChainThinkingLevel)
})

test('host-facing symbols (port / context / factory / explicit-addressing hooks) are really exported', { timeout: 60_000 }, () => {
  for (const name of [
    'PluginClientHostContext',
    'usePluginClientHost',
    'PluginClientContext',
    'usePluginContext',
    'createPluginClientContext',
    'resolveWorkbenchPanelTabId',
    'usePluginDocValue',
    'usePluginDocValueState',
    'usePluginSessionDocDiagnostics',
    'usePluginSessionDocValue',
    'ToolActivityContext',
    'useToolActivity',
    'TimelineToolCallsContext',
    'createTimelineToolCallsStore',
    'useTimelineToolCalls',
    'ComposerCommandContext',
    'createComposerCommandRegistry',
    'useComposerCommand',
    'ComposerModelPickerModeContext',
    'createComposerModelPickerModeRegistry',
    'useComposerModelPickerMode',
    'ScreenParamsContext',
  ] as const) {
    assert.ok(name in SDK, `host-facing symbol ${name} must be exported`)
    assert.ok((SDK as Record<string, unknown>)[name] !== undefined, `host-facing symbol ${name} must not be undefined`)
  }
})

// ---------------------------------------------------------------------------
// Test port (a behavioral minimal double: records calls and returns deterministic data)
// ---------------------------------------------------------------------------

interface PortLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }>
  inputs: Array<{ conversationId: number; text: string; origin: string; whenBusy?: string }>
  targets: Array<{ target: string; split?: boolean }>
  drawers: number[]
  artifacts: Array<{ artifactId: string; conversationId?: number }>
  workbench: Array<boolean | string>
  notices: Array<{ message: string; tone: string; conversationId?: number }>
  docs: Array<{ pluginId: string; docName: string; conversationId?: number }>
}

interface PortStateInit {
  authenticated?: boolean
  theme?: 'light' | 'dark'
  locale?: SDK.HelmxLocale | null
  translate?: SDK.LocaleTranslator | null
  conversations?: ConversationSummary[]
  conversationDetails?: Record<number, ConversationDetail>
  conversationLives?: Record<number, ConversationLive>
  pendingAsks?: AskSpec[]
  loadErrors?: Record<string, string>
  plugins?: PluginSummary[]
  screens?: Array<{ pluginId: string; spec: ScreenSpec }>
  pluginDocs?: Record<string, unknown>
  overrides?: Partial<SDK.PluginClientHostPort>
}

interface ReactiveTestPort {
  port: SDK.PluginClientHostPort
  setAuthenticated: (next: boolean) => void
  setTheme: (next: 'light' | 'dark') => void
  setLocale: (next: SDK.HelmxLocale) => void
  setConversations: (next: ConversationSummary[]) => void
  setConversationDetail: (id: number, next: ConversationDetail | undefined) => void
  setConversationLive: (id: number, next: ConversationLive | undefined) => void
  setPendingAsks: (next: AskSpec[]) => void
  setLoadError: (key: string, next: string | undefined) => void
  setPlugins: (next: PluginSummary[], nextScreens?: Array<{ pluginId: string; spec: ScreenSpec }>) => void
  setPluginDoc: (docKey: string, next: unknown) => void
}

const EMPTY_TEST_ASKS: AskSpec[] = Object.freeze([]) as unknown as AskSpec[]

function createReactivePort(log: PortLog, init: PortStateInit = {}): ReactiveTestPort {
  let authenticated = init.authenticated ?? true
  let theme: 'light' | 'dark' = init.theme ?? 'dark'
  let locale: SDK.HelmxLocale | undefined = init.locale === null ? undefined : (init.locale ?? 'zh-CN')
  let conversations: ConversationSummary[] =
    init.conversations ?? [{ id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as ConversationSummary]
  const details: Record<number, ConversationDetail | undefined> = { ...(init.conversationDetails ?? {}) }
  const lives: Record<number, ConversationLive | undefined> = { ...(init.conversationLives ?? {}) }
  let pendingAsks: AskSpec[] = init.pendingAsks ?? []
  const pendingAsksByConv = new Map<number, AskSpec[]>()
  const rebuildPendingAsks = () => {
    const grouped = new Map<number, AskSpec[]>()
    for (const ask of pendingAsks) {
      const list = grouped.get(ask.conversationId)
      if (list === undefined) grouped.set(ask.conversationId, [ask])
      else list.push(ask)
    }
    const touched = new Set<number>([...pendingAsksByConv.keys(), ...grouped.keys()])
    pendingAsksByConv.clear()
    for (const [id, list] of grouped) pendingAsksByConv.set(id, list)
    return touched
  }
  rebuildPendingAsks()

  const loadErrors: Record<string, string | undefined> = { ...(init.loadErrors ?? {}) }
  let pluginsSnapshot: UsePluginsResult = {
    plugins: init.plugins ?? [],
    screens: init.screens ?? [],
  }
  const pluginDocs: Record<string, unknown> = {
    ...(init.pluginDocs ?? { 'p1/state': { ok: 1 } }),
  }

  const authListeners = new Set<() => void>()
  const prefsListeners = new Set<() => void>()
  const conversationsListeners = new Set<() => void>()
  const pluginsListeners = new Set<() => void>()
  const summaryListeners = new Map<number, Set<() => void>>()
  const detailListeners = new Map<number, Set<() => void>>()
  const liveListeners = new Map<number, Set<() => void>>()
  const askListeners = new Map<number, Set<() => void>>()
  const errorListeners = new Map<string, Set<() => void>>()
  const docListeners = new Map<string, Set<() => void>>()

  const subSet = (set: Set<() => void>) => (listener: () => void): (() => void) => {
    set.add(listener)
    return () => set.delete(listener)
  }
  const subKey = <K>(map: Map<K, Set<() => void>>, key: K, listener: () => void): (() => void) => {
    let set = map.get(key)
    if (set === undefined) {
      set = new Set()
      map.set(key, set)
    }
    set.add(listener)
    return () => {
      const cur = map.get(key)
      if (!cur) return
      cur.delete(listener)
      if (cur.size === 0) map.delete(key)
    }
  }
  const notifySet = (set: Set<() => void>) => {
    for (const fn of [...set]) fn()
  }
  const notifyKey = <K>(map: Map<K, Set<() => void>>, key: K) => {
    const set = map.get(key)
    if (set !== undefined) notifySet(set)
  }

  const slotRender = (item: SDK.PluginSlotPortItem, options: { slotProps?: Record<string, unknown>; label: string }): React.ReactNode =>
    e('div', { 'data-slot': `${item.pluginId}/${item.contributionId}`, 'data-label': options.label }, JSON.stringify(options.slotProps ?? null))

  const port: SDK.PluginClientHostPort = {
    getAuthenticated: () => authenticated,
    subscribeAuthenticated: subSet(authListeners),
    getTheme: () => theme,
    ...(init.locale === null ? {} : { getLocale: () => locale ?? 'en' }),
    ...(init.translate === null
      ? {}
      : {
          getTranslate: () =>
            init.translate ?? ((text) => resolveLocalizedText(text, locale ?? 'en')),
        }),
    subscribePrefs: subSet(prefsListeners),
    getConversations: () => conversations,
    subscribeConversations: subSet(conversationsListeners),
    getConversationSummary: (id) => conversations.find((c) => c.id === id),
    subscribeConversationSummary: (id, listener) => subKey(summaryListeners, id, listener),
    getConversationDetail: (id) => details[id],
    subscribeConversationDetail: (id, listener) => subKey(detailListeners, id, listener),
    getConversationLive: (id) => lives[id],
    subscribeConversationLive: (id, listener) => subKey(liveListeners, id, listener),
    getConversationPendingAsks: (id) => pendingAsksByConv.get(id) ?? EMPTY_TEST_ASKS,
    subscribeConversationPendingAsks: (id, listener) => subKey(askListeners, id, listener),
    getLoadError: (key) => loadErrors[key],
    subscribeLoadError: (key, listener) => subKey(errorListeners, key, listener),
    getPluginsSnapshot: () => pluginsSnapshot,
    subscribePlugins: subSet(pluginsListeners),
    getPluginDocValue: (docKey) => (Object.hasOwn(pluginDocs, docKey) ? pluginDocs[docKey] : undefined),
    subscribePluginDoc: (docKey, listener) => subKey(docListeners, docKey, listener),
    ensurePluginDoc: (pluginId, docName) => {
      log.docs.push({ pluginId, docName })
      return Promise.resolve({ ok: 1 })
    },
    getPluginSessionDoc: (pluginId, docName, conversationId) => {
      log.docs.push({ pluginId, docName, conversationId })
      return Promise.resolve({ session: true })
    },
    subscribeSessionDoc: () => () => {},
    getSessionDocState: (key) => ({
      hasValue: true,
      deleted: false,
      connected: true,
      value: { key: `${key.pluginId}/${key.docName}/${key.conversationId}` },
    }),
    invokePluginAction: (pluginId, actionId, input, conversationId) => {
      log.actions.push({ pluginId, actionId, input, conversationId })
      return Promise.resolve({ done: true })
    },
    submitConversationInput: (conversationId, input) => {
      log.inputs.push({ conversationId, ...input, origin: input.origin, whenBusy: input.whenBusy })
      return Promise.resolve()
    },
    openTarget: (target, options) => {
      log.targets.push({ target, split: options?.split })
    },
    openConversationDrawer: (conversationId) => {
      log.drawers.push(conversationId)
    },
    openArtifactPreview: (artifactId, conversationId) => {
      log.artifacts.push({ artifactId, conversationId })
    },
    setWorkbenchOpen: (open) => {
      log.workbench.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbench.push(tab)
    },
    notify: (message, tone, conversationId) => {
      log.notices.push({ message, tone, conversationId })
    },
    loadConversationDetail: () => Promise.resolve(undefined),
    slots: {
      collectItems: (qualifiedName) =>
        qualifiedName === 'owner/zone'
          ? [
              {
                pluginId: 'p2',
                contributionId: 'badge',
                spec: { id: 'badge', target: 'owner/zone', client: { module: 'badge.tsx', export: 'Badge' } },
              },
              {
                pluginId: 'p3',
                contributionId: 'extra',
                spec: { id: 'extra', target: 'owner/zone', client: { module: 'extra.tsx', export: 'Extra' } },
              },
            ]
          : [],
      renderItem: slotRender,
    },
    markdown: {
      view: ({ text, workspaceBaseDir, className, onLinkClick }) =>
        e('div', { 'data-md': 'host', 'data-base-dir': workspaceBaseDir ?? '', className },
          onLinkClick
            ? e('a', { href: '#custom-ref', onClick: (ev: React.MouseEvent<HTMLAnchorElement>) => onLinkClick('#custom-ref', ev) }, text)
            : text),
      codeBlock: ({ code, language }) => e('pre', { 'data-code': 'host', 'data-lang': language }, code),
    },
    ...(init.overrides ?? {}),
  }

  return {
    port,
    setAuthenticated: (next) => {
      authenticated = next
      notifySet(authListeners)
    },
    setTheme: (next) => {
      theme = next
      notifySet(prefsListeners)
    },
    setLocale: (next) => {
      locale = next
      notifySet(prefsListeners)
    },
    setConversations: (next) => {
      const prevIds = new Set(conversations.map((c) => c.id))
      conversations = next
      notifySet(conversationsListeners)
      for (const id of new Set([...prevIds, ...next.map((c) => c.id)])) {
        notifyKey(summaryListeners, id)
      }
    },
    setConversationDetail: (id, next) => {
      details[id] = next
      notifyKey(detailListeners, id)
    },
    setConversationLive: (id, next) => {
      lives[id] = next
      notifyKey(liveListeners, id)
    },
    setPendingAsks: (next) => {
      pendingAsks = next
      const touched = rebuildPendingAsks()
      for (const id of touched) notifyKey(askListeners, id)
    },
    setLoadError: (key, next) => {
      loadErrors[key] = next
      notifyKey(errorListeners, key)
    },
    setPlugins: (next, nextScreens) => {
      pluginsSnapshot = { plugins: next, screens: nextScreens ?? pluginsSnapshot.screens }
      notifySet(pluginsListeners)
    },
    setPluginDoc: (docKey, next) => {
      if (next === undefined) delete pluginDocs[docKey]
      else pluginDocs[docKey] = next
      notifyKey(docListeners, docKey)
    },
  }
}

function makePort(log: PortLog, init: PortStateInit = {}): SDK.PluginClientHostPort {
  return createReactivePort(log, init).port
}

function mount(tree: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(tree))
  return { host, root }
}

// ---------------------------------------------------------------------------
// 2. Hooks fetch through the port; missing port throws explicitly
// ---------------------------------------------------------------------------

test('usePluginDoc / useConversations / usePlugins fetch through the port; first access auto-triggers ensurePluginDoc', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  let docValue: unknown = 'unset'
  let conversations: unknown[] | undefined
  let screens: unknown[] | undefined
  function Probe(): React.ReactNode {
    docValue = SDK.usePluginDoc('state', 'p1')
    conversations = SDK.useConversations()
    screens = SDK.usePlugins().screens
    return e('div', null, 'probe')
  }
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.deepEqual(docValue, { ok: 1 }, 'public doc comes from port pluginDocs')
  assert.equal(conversations?.length, 1, 'conversation summaries come from port conversations')
  assert.deepEqual(screens, [], 'screens come from the port')
  act(() => { void root.unmount() })
  void host
})

// ---------------------------------------------------------------------------
// 1b. Screen params scope (host ScreenHost bridge)
// ---------------------------------------------------------------------------

test('useScreenParams: null outside a provided scope; inside it forwards params / isSplit and routes setParams verbatim', { timeout: 60_000 }, () => {
  const writes: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
  const scope: SDK.ScreenParamsScope = {
    params: { view: 'main', tab: 'all' },
    isSplit: true,
    setParams: (patch, options) => {
      writes.push({ patch, options })
    },
  }
  let outside: SDK.ScreenParamsScope | null | undefined
  let inside: SDK.ScreenParamsScope | null | undefined
  function OutsideProbe(): React.ReactNode {
    outside = SDK.useScreenParams()
    return e('div', null, 'outside')
  }
  function InsideProbe(): React.ReactNode {
    inside = SDK.useScreenParams()
    return e('div', null, 'inside')
  }
  const { host, root } = mount(
    e(SDK.ScreenParamsContext.Provider, { value: scope },
      e(InsideProbe)),
  )
  mount(e(OutsideProbe))
  assert.equal(outside, null, 'outside a fullscreen screen the scope is honestly null, never a fabricated no-op')
  assert.equal(inside, scope, 'inside the provided scope the hook returns the host-established scope')
  assert.deepEqual(inside?.params, { view: 'main', tab: 'all' })
  assert.equal(inside?.isSplit, true)
  act(() => {
    inside?.setParams({ view: undefined, tab: 'pinned' }, { push: true })
  })
  assert.deepEqual(writes, [{ patch: { view: undefined, tab: 'pinned' }, options: { push: true } }], 'setParams forwards patch and options verbatim (single write path)')
  act(() => { void root.unmount() })
  void host
})

test('useHostModels: throws explicitly without host context; absent capability reports unknown (undefined, never fabricated)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  function Probe(): React.ReactNode {
    void SDK.useHostModels()
    return null
  }
  assert.throws(
    () => renderToString(e(Probe)),
    /usePluginClientHost must be called inside <PluginClientHostContext\.Provider>/,
    'useHostModels outside host context throws explicitly (never silently degraded)',
  )
  const seen: { slice?: SDK.HostModelsSlice } = {}
  const readSlice = (): SDK.HostModelsSlice | undefined => seen.slice
  function AbsentProbe(): React.ReactNode {
    seen.slice = SDK.useHostModels()
    return null
  }
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: makePort(log) }, e(AbsentProbe)),
  )
  assert.ok(readSlice() === undefined, 'a host that injects no model capability reports unknown (undefined), never an empty catalog')
  act(() => { void root.unmount() })
})

test('useHostModels: catalog revisions re-render exactly once; three-state semantics honest', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const entries: ReadonlyArray<SDK.HostModelEntry> = [
    { id: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o', available: true, thinkingLevels: ['off', 'high'] },
    { id: 'anthropic/claude', provider: 'anthropic', modelId: 'claude', available: false, disabled: true, label: 'Claude', thinkingLevels: ['off'] },
  ]
  const loading: SDK.HostModelsSlice = { models: entries, defaultModel: 'openai/gpt-4o' }
  const loaded: SDK.HostModelsSlice = { models: [...entries], defaultModel: 'openai/gpt-4o', defaultThinkingLevel: 'off' }
  const empty: SDK.HostModelsSlice = { models: [] }
  let current: SDK.HostModelsSlice | undefined
  const listeners = new Set<() => void>()
  const port = makePort(log, {
    overrides: {
      getModels: () => current,
      subscribeModels: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  let renders = 0
  const seen: { slice?: SDK.HostModelsSlice } = {}
  const readSlice = (): SDK.HostModelsSlice | undefined => seen.slice
  const Probe = React.memo(function ModelsProbe(): React.ReactNode {
    renders += 1
    seen.slice = SDK.useHostModels()
    return null
  })
  const { root } = mount(e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe)))
  assert.equal(renders, 1, 'initial mount renders once')
  assert.ok(readSlice() === undefined, 'pre-first-load snapshot is unknown (undefined), never an empty catalog')

  // Same-reference notification: useSyncExternalStore re-checks the snapshot and skips re-rendering.
  current = loading
  assert.ok(port.getModels?.() === loading && port.getModels?.() === loading, 'repeated getModels calls return the same reference for the same underlying state')
  act(() => { for (const listener of [...listeners]) listener() })
  assert.equal(renders, 2, 'a catalog revision with a new reference re-renders exactly once')
  assert.ok(readSlice() === loading, 'the revision forwards the new slice reference verbatim')
  assert.deepEqual(readSlice()?.defaultModel, 'openai/gpt-4o', 'the default chain rides the slice (faithful GET /api/models view)')
  act(() => { for (const listener of [...listeners]) listener() })
  assert.equal(renders, 2, 'a repeated notification without a reference change does not re-render')

  current = loaded
  act(() => { for (const listener of [...listeners]) listener() })
  assert.equal(renders, 3)
  assert.ok(readSlice() === loaded, 'a new revision reference propagates')
  current = empty
  act(() => { for (const listener of [...listeners]) listener() })
  const emptyRead = readSlice()
  assert.ok(emptyRead === empty && emptyRead.models.length === 0, 'a loaded-but-empty catalog is a slice with models: [] — strictly distinct from the unknown state')
  act(() => { void root.unmount() })
})

test('useHostNodes & useHostProfiles: throw without host context, report undefined when absent/unloaded/SSR, and stay isolated from unrelated domain updates', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  assert.throws(
    () => renderToString(e(function OutsideNodes() { void SDK.useHostNodes(); return null })),
    /usePluginClientHost must be called inside <PluginClientHostContext\.Provider>/,
    'useHostNodes outside host context throws explicitly',
  )
  assert.throws(
    () => renderToString(e(function OutsideProfiles() { void SDK.useHostProfiles(); return null })),
    /usePluginClientHost must be called inside <PluginClientHostContext\.Provider>/,
    'useHostProfiles outside host context throws explicitly',
  )

  // Absent capabilities on host port -> strictly undefined (never fabricated empty array)
  let absentNodes: SDK.HostNodesSlice | undefined = []
  let absentProfiles: SDK.HostProfilesSlice | undefined = []
  function AbsentProbe(): React.ReactNode {
    absentNodes = SDK.useHostNodes()
    absentProfiles = SDK.useHostProfiles()
    return null
  }
  const absentMount = mount(e(SDK.PluginClientHostContext.Provider, { value: makePort(log) }, e(AbsentProbe)))
  assert.ok(absentNodes === undefined, 'unwired getNodes reports undefined, never []')
  assert.ok(absentProfiles === undefined, 'unwired getProfiles reports undefined, never []')
  act(() => { void absentMount.root.unmount() })

  // Wired capabilities: three-state lifecycle + SSR honesty + strict render isolation
  const localNode: NodeInfo = { id: 'local', kind: 'local', online: true }
  const gpuNode: NodeInfo = { id: 'gpu-1', kind: 'byom', online: true }
  const assistantProfile: Profile = { id: 'assistant', name: 'Assistant' } as Profile
  const coderProfile: Profile = { id: 'coder', name: 'Coder' } as Profile

  let currentNodes: SDK.HostNodesSlice | undefined
  let currentProfiles: SDK.HostProfilesSlice | undefined
  const nodeListeners = new Set<() => void>()
  const profileListeners = new Set<() => void>()

  const reactive = createReactivePort(log, {
    overrides: {
      getNodes: () => currentNodes,
      subscribeNodes: (listener) => {
        nodeListeners.add(listener)
        return () => nodeListeners.delete(listener)
      },
      getProfiles: () => currentProfiles,
      subscribeProfiles: (listener) => {
        profileListeners.add(listener)
        return () => profileListeners.delete(listener)
      },
    },
  })

  // SSR snapshot stays undefined even when populated (consistent with useHostModels)
  currentNodes = [localNode]
  currentProfiles = [assistantProfile]
  let ssrNodes: SDK.HostNodesSlice | undefined = [localNode]
  let ssrProfiles: SDK.HostProfilesSlice | undefined = [assistantProfile]
  renderToString(
    e(SDK.PluginClientHostContext.Provider, { value: reactive.port }, e(function SsrProbe() {
      ssrNodes = SDK.useHostNodes()
      ssrProfiles = SDK.useHostProfiles()
      return null
    })),
  )
  assert.ok(ssrNodes === undefined, 'useHostNodes SSR snapshot stays honestly undefined')
  assert.ok(ssrProfiles === undefined, 'useHostProfiles SSR snapshot stays honestly undefined')

  // Reset to pre-load undefined for client lifecycle assertions
  currentNodes = undefined
  currentProfiles = undefined
  let nodeRenders = 0
  let profileRenders = 0
  const seen: { nodes?: SDK.HostNodesSlice; profiles?: SDK.HostProfilesSlice } = {}
  const readNodes = (): SDK.HostNodesSlice | undefined => seen.nodes
  const readProfiles = (): SDK.HostProfilesSlice | undefined => seen.profiles

  const NodesProbe = React.memo(function NodesProbe(): React.ReactNode {
    nodeRenders += 1
    seen.nodes = SDK.useHostNodes()
    return null
  })
  const ProfilesProbe = React.memo(function ProfilesProbe(): React.ReactNode {
    profileRenders += 1
    seen.profiles = SDK.useHostProfiles()
    return null
  })

  const mounted = mount(
    e(SDK.PluginClientHostContext.Provider, { value: reactive.port }, e(NodesProbe), e(ProfilesProbe)),
  )
  try {
    assert.equal(nodeRenders, 1)
    assert.equal(profileRenders, 1)
    assert.ok(readNodes() === undefined, 'pre-load nodes slice is undefined')
    assert.ok(readProfiles() === undefined, 'pre-load profiles slice is undefined')

    // Unrelated updates must trigger zero re-renders
    act(() => {
      reactive.setConversationLive(7, { conversationId: 7, text: 'streaming', tools: [], updatedAt: 10 } as ConversationLive)
      reactive.setPluginDoc('p1/state', { ok: 2 })
      reactive.setTheme('light')
      reactive.setLocale('en')
    })
    assert.equal(nodeRenders, 1, 'unrelated host domains must not re-render useHostNodes')
    assert.equal(profileRenders, 1, 'unrelated host domains must not re-render useHostProfiles')

    // Loaded-empty transitions: strictly distinct from undefined
    const emptyNodes: SDK.HostNodesSlice = []
    currentNodes = emptyNodes
    act(() => { for (const fn of [...nodeListeners]) fn() })
    assert.equal(nodeRenders, 2)
    assert.equal(profileRenders, 1, 'nodes revision must not re-render useHostProfiles')
    const nodesAfterEmpty = readNodes()
    assert.ok(nodesAfterEmpty === emptyNodes && nodesAfterEmpty.length === 0)

    const emptyProfiles: SDK.HostProfilesSlice = []
    currentProfiles = emptyProfiles
    act(() => { for (const fn of [...profileListeners]) fn() })
    assert.equal(profileRenders, 2)
    assert.equal(nodeRenders, 2, 'profiles revision must not re-render useHostNodes')
    const profilesAfterEmpty = readProfiles()
    assert.ok(profilesAfterEmpty === emptyProfiles && profilesAfterEmpty.length === 0)

    // Same-reference notification triggers zero re-renders
    act(() => {
      for (const fn of [...nodeListeners]) fn()
      for (const fn of [...profileListeners]) fn()
    })
    assert.equal(nodeRenders, 2)
    assert.equal(profileRenders, 2)

    // Populated updates forward the exact reference
    const twoNodes: SDK.HostNodesSlice = [localNode, gpuNode]
    currentNodes = twoNodes
    act(() => { for (const fn of [...nodeListeners]) fn() })
    assert.equal(nodeRenders, 3)
    assert.ok(readNodes() === twoNodes)

    const twoProfiles: SDK.HostProfilesSlice = [assistantProfile, coderProfile]
    currentProfiles = twoProfiles
    act(() => { for (const fn of [...profileListeners]) fn() })
    assert.equal(profileRenders, 3)
    assert.ok(readProfiles() === twoProfiles)
  } finally {
    act(() => { void mounted.root.unmount() })
  }
})

test('usePluginDoc auto-triggers ensurePluginDoc for a missing key (port forwarding)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  function Probe(): React.ReactNode {
    const value = SDK.usePluginDoc('missing')
    return e('div', null, String(value))
  }
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(Probe))),
  )
  assert.equal(log.docs.length, 1, 'a missing doc triggers exactly one ensurePluginDoc through the port')
  assert.deepEqual(log.docs[0], { pluginId: 'p1', docName: 'missing' })
  act(() => { void root.unmount() })
})

test('usePluginSessionDoc: inherits the ctx conversation; explicit override wins; no conversation returns undefined', { timeout: 60_000 }, () => {
  const seen: string[] = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const states = new Map<string, unknown>()
  port.getSessionDocState = (key) => {
    seen.push(`${key.pluginId}/${key.docName}/${key.conversationId}`)
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    // Snapshot references stay stable (consistent with the real host cache):
    // useSyncExternalStore compares with Object.is
    let snapshot = states.get(cacheKey)
    if (snapshot === undefined) {
      snapshot = { hasValue: true, deleted: false, connected: true, value: 42 }
      states.set(cacheKey, snapshot)
    }
    return snapshot as SDK.PluginSessionDocState
  }
  let inherited: unknown = 'unset'
  let overridden: unknown = 'unset'
  let none: unknown = 'unset'
  // Three probes render under different context Providers (no conditional hook
  // calls within one component)
  function InheritedProbe(): React.ReactNode {
    inherited = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  function OverriddenProbe(): React.ReactNode {
    overridden = SDK.usePluginSessionDoc('runs', { conversationId: 9, pluginId: 'other' })
    return e('div', null, 'probe')
  }
  function NoneProbe(): React.ReactNode {
    none = SDK.usePluginSessionDoc('runs')
    return e('div', null, 'probe')
  }
  mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(InheritedProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(OverriddenProbe)),
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', undefined) },
        e(NoneProbe))),
  )
  assert.equal(inherited, 42, 'subscribed value inheriting ctx.conversationId=7')
  assert.equal(overridden, 42, 'explicit override conversationId=9 / pluginId=other')
  assert.equal(none, undefined, 'no conversation context opens no stream and returns undefined')
  assert.deepEqual([...new Set(seen)], ['p1/runs/7', 'other/runs/9'], 'subscription tuples resolve by inheritance and override (no tuple without conversation context)')
})

test('hooks throw explicitly without a host port (never silently degraded)', { timeout: 60_000 }, () => {
  function Probe(): React.ReactNode {
    SDK.useConversations()
    return e('div', null, 'probe')
  }
  // The pinned message is thrown by host-port.ts, which is outside the SDK
  // anglicization scope — the regex must keep matching it verbatim.
  assert.throws(
    () => renderToString(e(Probe)),
    /usePluginClientHost must be called inside <PluginClientHostContext.Provider>/,
    'useConversations throws explicitly when the port is missing',
  )
})

// ---------------------------------------------------------------------------
// 3. createPluginClientContext port forwarding
// ---------------------------------------------------------------------------

test('createPluginClientContext: actions / input / navigation / notifications / docs each forward to the port', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', 7, { draft: '', attachments: [], sending: false, setDraft() {}, insertText() {}, submit: () => Promise.resolve() })
  assert.equal(ctx.pluginId, 'p1')
  assert.equal(ctx.conversationId, 7)
  assert.equal(ctx.theme, 'dark')
  assert.equal(ctx.locale, 'zh-CN', 'locale is injected by the port')
  assert.equal(ctx.translate('plain'), 'plain', 'translator passes plain strings through')
  assert.equal(ctx.translate({ en: 'Hi', 'zh-CN': '你好' }), '你好', 'translator resolves display text for the current locale')
  assert.equal(ctx.translate({ en: 'Hi' }), 'Hi', 'translator falls back to the default locale when the current locale is missing')
  assert.ok(ctx.composer !== undefined, 'an explicitly provided composer is passed through')

  await ctx.callAction('reload', { x: 1 })
  await ctx.callAction('reload', { x: 2 }, { pluginId: 'p2', conversationId: 9 })
  assert.deepEqual(log.actions, [
    { pluginId: 'p1', actionId: 'reload', input: { x: 1 }, conversationId: 7 },
    { pluginId: 'p2', actionId: 'reload', input: { x: 2 }, conversationId: 9 },
  ], 'callAction defaults to the current plugin and conversation; explicit parameters win')

  await ctx.submitInput('hello', { whenBusy: 'followUp' })
  assert.deepEqual(log.inputs, [{ conversationId: 7, text: 'hello', origin: 'agent', whenBusy: 'followUp' }], 'submitInput goes through the port with origin=agent')

  ctx.openScreen('conversation:1')
  ctx.openSplitScreen('screen:builtin:herdr/overview')
  assert.deepEqual(log.targets, [
    { target: 'conversation:1', split: undefined },
    { target: 'screen:builtin:herdr/overview', split: true },
  ], 'openScreen / openSplitScreen go through port openTarget')

  ctx.openConversationDrawer(3)
  ctx.openArtifact('art-1')
  ctx.openWorkbench('plugin:builtin:memory/main')
  ctx.openWorkbench('tasks')
  ctx.openWorkbench('artifacts')
  ctx.closeWorkbench()
  assert.deepEqual(log.drawers, [3])
  assert.deepEqual(log.artifacts, [{ artifactId: 'art-1', conversationId: 7 }], 'artifact preview inherits the current conversation')
  assert.deepEqual(log.workbench, [
    true, 'plugin:builtin:memory/main',
    true, 'plugin:p1/tasks',
    true, 'artifacts',
    false,
  ])

  ctx.notify('boom', 'error')
  assert.deepEqual(log.notices, [{ message: 'boom', tone: 'error', conversationId: 7 }])

  await ctx.getPluginDoc('state')
  await ctx.getPluginDoc('state', 'p2')
  await ctx.getPluginSessionDoc('runs', { conversationId: 8 })
  assert.deepEqual(log.docs, [
    { pluginId: 'p1', docName: 'state' },
    { pluginId: 'p2', docName: 'state' },
    { pluginId: 'p1', docName: 'runs', conversationId: 8 },
  ], 'doc reads go through the port (cross-plugin and explicit conversation win)')
})

test('createPluginClientContext: submitInput without conversation context rejects explicitly; invalid conversation IDs throw', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const ctx = SDK.createPluginClientContext(port, 'p1', undefined)
  // The host and context implementations reject these cases explicitly.
  await assert.rejects(() => ctx.submitInput('x'), /submitInput has no target conversation/, 'without a conversation, never drop silently')
  assert.throws(() => { void ctx.callAction('a', 1, { conversationId: 0 }) }, /must be a positive integer/, 'invalid conversation ID rejected synchronously')
  await assert.rejects(() => ctx.getPluginSessionDoc('runs'), /getPluginSessionDoc has no target conversation/)
})

test('createPluginClientContext.fetchRoute: strictly validates paths, delegates to port.fetchPluginRoute, returns raw Response, and rejects when unwired', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const routeCalls: Array<{ pluginId: string; path: string; init?: RequestInit }> = []
  const streamBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const port = makePort(log, {
    overrides: {
      fetchPluginRoute: async (pluginId, path, init) => {
        routeCalls.push({ pluginId, path, init })
        return new Response(streamBytes, {
          status: 201,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Route-Echo': path },
        })
      },
    },
  })
  const ctx = SDK.createPluginClientContext(port, 'builtin:demo', 7)

  const init: RequestInit = { method: 'POST', headers: { 'X-Test': '1' } }
  const res = await ctx.fetchRoute('/items/123?limit=20&next=../ok', init)
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('X-Route-Echo'), '/items/123?limit=20&next=../ok')
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), streamBytes, 'raw binary Response passes through untouched')
  assert.equal(routeCalls.length, 1)
  assert.equal(routeCalls[0]!.pluginId, 'builtin:demo')
  assert.equal(routeCalls[0]!.path, '/items/123?limit=20&next=../ok')
  assert.ok(routeCalls[0]!.init === init)

  // Encoded slash inside a single :param segment is valid (matches kernel route-match.ts)
  const encodedRes = await ctx.fetchRoute('/files/dir%2Fsub.bin?download=1')
  assert.equal(encodedRes.status, 201)
  const orgRes = await ctx.fetchRoute('/orgs/acme%2Fcorp/items/it-42')
  assert.equal(orgRes.status, 201)
  assert.equal(routeCalls.length, 3)

  // Every invalid / traversal / non-namespaced path must reject BEFORE hitting the host port
  const invalidPaths = [
    '',
    'items',
    'http://evil.example/items',
    '/',
    '/?a=1',
    '//evil.example/items',
    '/items//sub',
    '/items/',
    '/items\\sub',
    '/items#frag',
    '/items?a=1#frag',
    '/.',
    '/..',
    '/items/../secret',
    '/items/./sub',
    '/items/%2e%2e/secret',
    '/items/%2E/sub',
    '/%2e%2e%2fconfig',
    '/items/%2e%2e%2fsecret',
    '/items/%2e%2fsub',
    '/items/foo%2f..%2fbar',
    '/items/%5c/sub',
    '/items/%zz',
    '/items\nbad',
    '/foo%00bar',
    '/foo%0abar',
    '/foo%7fbar',
  ]
  for (const bad of invalidPaths) {
    await assert.rejects(
      () => ctx.fetchRoute(bad),
      /fetchRoute path/,
      `invalid path ${JSON.stringify(bad)} must be rejected explicitly`,
    )
  }
  assert.equal(routeCalls.length, 3, 'invalid paths must never reach port.fetchPluginRoute')

  // Unwired host port rejects explicitly (never falls back to global fetch)
  const unwiredCtx = SDK.createPluginClientContext(makePort(log), 'builtin:demo', 7)
  await assert.rejects(
    () => unwiredCtx.fetchRoute('/items'),
    /fetchRoute is unavailable: host port does not implement fetchPluginRoute/,
  )
})

test('createPluginClientContext.openWorkbench: resolves short local panelId, preserves host/explicit tabs, and forwards params atomically to port.openWorkbench', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const openCalls: Array<{ tab?: string; conversationId?: number; params?: Record<string, unknown> } | undefined> = []
  const port = makePort(log, {
    overrides: {
      openWorkbench: (options) => {
        openCalls.push(options)
      },
    },
  })
  const ctx = SDK.createPluginClientContext(port, 'builtin:workflow', 42)
  ctx.openWorkbench('tasks', { runId: 'wf_1', nodeId: 'n1' })
  ctx.openWorkbench('files')
  ctx.openWorkbench('artifacts')
  ctx.openWorkbench('plugin:builtin:swarm/groups', { groupId: 'g1' })
  ctx.openWorkbench()

  assert.deepEqual(openCalls, [
    { tab: 'plugin:builtin:workflow/tasks', conversationId: 42, params: { runId: 'wf_1', nodeId: 'n1' } },
    { tab: 'files', conversationId: 42 },
    { tab: 'artifacts', conversationId: 42 },
    { tab: 'plugin:builtin:swarm/groups', conversationId: 42, params: { groupId: 'g1' } },
    { conversationId: 42 },
  ])
  assert.deepEqual(log.workbench, [], 'when port.openWorkbench is provided, legacy two-step open/tab setters are skipped')
})

test('usePluginDocState & usePluginSessionDocState: loading / ready / error transitions and manual retry', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const retriedPublic: Array<{ pluginId: string; docName: string }> = []
  const retriedSession: SDK.PluginSessionDocKey[] = []
  let sessionSnapshot: SDK.PluginSessionDocState = { hasValue: false, deleted: false, connected: false }
  const sessionListeners = new Set<() => void>()

  const reactive = createReactivePort(log, {
    pluginDocs: {},
    overrides: {
      hasPluginDoc: (docKey) => docKey === 'p1/ready' || reactive.port.getPluginDocValue(docKey) !== undefined,
      retryPluginDoc: (pluginId, docName) => {
        retriedPublic.push({ pluginId, docName })
        reactive.setLoadError(`doc:${pluginId}/${docName}`, undefined)
        reactive.setPluginDoc(`${pluginId}/${docName}`, { recovered: true })
        return Promise.resolve({ recovered: true })
      },
      subscribeSessionDoc: (_key, listener) => {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      getSessionDocState: () => sessionSnapshot,
      retrySessionDoc: (key) => {
        retriedSession.push(key)
        sessionSnapshot = { hasValue: true, deleted: false, connected: true, value: { seq: 9 } }
        for (const fn of [...sessionListeners]) fn()
      },
    },
  })

  let docState: SDK.PluginDocState<{ recovered?: boolean }> | undefined
  let docThin: { recovered?: boolean } | undefined
  let sessState: SDK.PluginDocState<{ seq?: number }> | undefined
  let sessThin: { seq?: number } | undefined
  let noConvState: SDK.PluginDocState<unknown> | undefined

  function Probe(): React.ReactNode {
    docState = SDK.usePluginDocState<{ recovered?: boolean }>('items')
    docThin = SDK.usePluginDoc<{ recovered?: boolean }>('items')
    sessState = SDK.usePluginSessionDocState<{ seq?: number }>('runs', 12)
    sessThin = SDK.usePluginSessionDoc<{ seq?: number }>('runs', { conversationId: 12 })
    return e('div', null, `${docState.status}:${sessState.status}`)
  }
  function NoConvProbe(): React.ReactNode {
    noConvState = SDK.usePluginSessionDocState('runs')
    return e('div', null, noConvState.status)
  }

  const host = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(
      e(
        SDK.PluginClientHostContext.Provider,
        { value: reactive.port },
        e(
          SDK.PluginClientContext.Provider,
          { value: SDK.createPluginClientContext(reactive.port, 'p1', 7) },
          e(Probe),
        ),
        e(
          SDK.PluginClientContext.Provider,
          { value: SDK.createPluginClientContext(reactive.port, 'p1', undefined) },
          e(NoConvProbe),
        ),
      ),
    )
  })

  try {
    // 1. Initial loading state before values arrive
    assert.equal(docState?.status, 'loading')
    assert.equal(docState?.data, undefined)
    assert.equal(docThin, undefined)
    assert.equal(sessState?.status, 'loading')
    assert.equal(sessState?.data, undefined)
    assert.equal(sessThin, undefined)
    assert.equal(noConvState?.status, 'ready', 'without conversation context, no stream opens and status is ready')
    assert.equal(noConvState?.data, undefined)

    // 2. Error transitions for both public doc and session doc
    act(() => {
      reactive.setLoadError('doc:p1/items', 'HTTP 503')
      sessionSnapshot = { hasValue: false, deleted: false, connected: false, error: 'stream broken' }
      for (const fn of [...sessionListeners]) fn()
    })
    assert.equal(docState?.status, 'error')
    assert.equal(docState?.error, 'HTTP 503')
    assert.equal(sessState?.status, 'error')
    assert.equal(sessState?.error, 'stream broken')
    assert.equal(sessThin, undefined)

    // 3. Explicit manual retry recovers both to ready
    act(() => {
      docState!.retry()
      sessState!.retry()
    })
    assert.deepEqual(retriedPublic, [{ pluginId: 'p1', docName: 'items' }])
    assert.deepEqual(retriedSession, [{ pluginId: 'p1', docName: 'runs', conversationId: 12 }])
    assert.equal(docState?.status, 'ready')
    assert.deepEqual(docState?.data, { recovered: true })
    assert.deepEqual(docThin, { recovered: true })
    assert.equal(sessState?.status, 'ready')
    assert.deepEqual(sessState?.data, { seq: 9 })
    assert.deepEqual(sessThin, { seq: 9 })
  } finally {
    act(() => root?.unmount())
  }
})

// ---------------------------------------------------------------------------
// 4. PluginSlot port contract
// ---------------------------------------------------------------------------

test('createPluginClientContext: missing port locale falls back to the default locale and derives a translator', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log, { locale: null, translate: null })
  const ctx = SDK.createPluginClientContext(port, 'p1', 7)
  assert.equal(ctx.locale, 'en', 'missing port locale falls back to DEFAULT_HELMX_LOCALE')
  assert.equal(ctx.translate({ en: 'Hi', 'zh-CN': '你好' }), 'Hi', 'derived translator resolves using the fallback locale')
  assert.equal(ctx.translate({ 'zh-CN': '你好' }), '你好', 'derived translator falls back to the only declared locale')
})

test('usePluginLocale / usePluginTranslator: context takes precedence over port, then default', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const seen: Array<{ locale: string; translated: string }> = []

  function CtxProbe(): React.ReactNode {
    const translator = SDK.usePluginTranslator()
    seen.push({ locale: String(SDK.usePluginLocale()), translated: translator({ en: 'Hi', 'zh-CN': '你好' }) })
    return e('div', null, 'probe')
  }
  function PortProbe(): React.ReactNode {
    const translator = SDK.usePluginTranslator()
    seen.push({ locale: String(SDK.usePluginLocale()), translated: translator({ en: 'Hi', 'zh-CN': '你好' }) })
    return e('div', null, 'probe')
  }
  function BareProbe(): React.ReactNode {
    seen.push({ locale: String(SDK.usePluginLocale()), translated: SDK.usePluginTranslator()('plain') })
    return e('div', null, 'probe')
  }

  mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) }, e(CtxProbe)),
      e(PortProbe)),
  )
  mount(e(BareProbe))
  assert.deepEqual(seen, [
    { locale: 'zh-CN', translated: '你好' }, // context wins
    { locale: 'zh-CN', translated: '你好' }, // host port fallback
    { locale: 'en', translated: 'plain' },   // neither provider: default locale
  ])
})

test('ToolCallDetails: bootstraps artifact trigger via @helmx/ui Button size="xs" (SSR)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log, { locale: 'en' })
  const pluginCtx = SDK.createPluginClientContext(port, 'builtin:workflow', 7)

  const withArtifact = renderToString(
    e(
      SDK.PluginClientContext.Provider,
      { value: pluginCtx },
      e(SDK.ToolCallDetails, { input: { cmd: 'ls' }, result: 'ok', artifactRef: 'art_42', defaultOpen: true }),
    ),
  )
  assert.match(
    withArtifact,
    /<button[^>]*type="button"[^>]*class="btn btn-secondary btn-xs"[^>]*>[^<]*<!-- -->\s*#\s*<!-- -->art_42<\/button>/,
    'ToolCallDetails artifact button must render through @helmx/ui Button size="xs"',
  )

  const withoutArtifact = renderToString(
    e(
      SDK.PluginClientContext.Provider,
      { value: pluginCtx },
      e(SDK.ToolCallDetails, { input: { cmd: 'ls' }, result: 'ok', artifactRef: '' }),
    ),
  )
  assert.doesNotMatch(withoutArtifact, /<button/, 'empty artifactRef must not render an artifact button')
})

test('PluginSlot: short names qualify, lists render all matches, singles render the first, fallbacks render when empty, and missing owners warn', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const portEn = makePort(log, { locale: 'en' })
  const portZh = makePort(log, { locale: 'zh-CN' })
  const tree = (name: string, extra: Record<string, unknown> = {}, fallback?: React.ReactNode, port = portEn) =>
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'owner', undefined) },
        e(SDK.PluginSlot, { name, ...extra, ...(fallback !== undefined ? { fallback } : {}) })))

  const all = mount(tree('zone', { slotProps: { z: 1 } }))
  assert.equal(all.host.querySelectorAll('[data-slot]').length, 2, 'list mode renders every matched item')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.getAttribute('data-label'), 'Slot owner/zone/badge', 'the render label carries the fully qualified name')
  assert.equal(all.host.querySelector('[data-slot="p2/badge"]')?.textContent, '{"z":1}', 'slotProps pass through to the host renderer')
  const defaultAnchor = all.host.querySelector<HTMLElement>('[data-helmx-slot="owner/zone"]')
  assert.ok(defaultAnchor !== null, 'default slot renders stable data-helmx-slot anchor')
  assert.equal(defaultAnchor.tagName, 'DIV')
  assert.equal(defaultAnchor.style.display, 'contents', 'unclassed slot avoids adding an extra CSS layout box')
  act(() => { void all.root.unmount() })

  const classed = mount(tree('zone', { className: 'custom-slot' }))
  const classedAnchor = classed.host.querySelector<HTMLElement>('[data-helmx-slot="owner/zone"]')
  assert.ok(classedAnchor !== null && classedAnchor.classList.contains('custom-slot'))
  assert.equal(classedAnchor.style.display, '', 'classed slot preserves caller CSS display rules')
  act(() => { void classed.root.unmount() })

  const inlineSlot = mount(tree('zone', { inline: true }))
  const inlineAnchor = inlineSlot.host.querySelector<HTMLElement>('[data-helmx-slot="owner/zone"]')
  assert.ok(inlineAnchor !== null)
  assert.equal(inlineAnchor.tagName, 'SPAN', 'inline slot renders <span>')
  assert.equal(inlineAnchor.style.display, 'contents')
  act(() => { void inlineSlot.root.unmount() })

  const single = mount(tree('zone', { mode: 'single' }))
  assert.equal(single.host.querySelectorAll('[data-slot]').length, 1, 'single mode renders only the first item')
  act(() => { void single.root.unmount() })

  const empty = mount(tree('nope', {}, e('div', null, 'fallback-here')))
  assert.equal(empty.host.textContent, 'fallback-here', 'no matches render the fallback')
  assert.ok(empty.host.querySelector('[data-helmx-slot]') === null, 'empty slot renders no wrapper anchor')
  act(() => { void empty.root.unmount() })

  const noOwnerEn = mount(
    e(SDK.PluginClientHostContext.Provider, { value: portEn }, e(SDK.PluginSlot, { name: 'zone' })))
  assert.match(noOwnerEn.host.textContent ?? '', /no host plugin context/, 'missing owner warns explicitly in English')
  act(() => { void noOwnerEn.root.unmount() })

  const noOwnerZh = mount(
    e(SDK.PluginClientHostContext.Provider, { value: portZh }, e(SDK.PluginSlot, { name: 'zone' })))
  assert.match(noOwnerZh.host.textContent ?? '', /缺少宿主插件上下文/, 'missing owner warns in zh-CN when locale is zh-CN')
  act(() => { void noOwnerZh.root.unmount() })

  const badTarget = mount(tree('a/b/c', {}, undefined, portZh))
  assert.match(badTarget.host.textContent ?? '', /非法/, 'invalid slot target warns explicitly in active locale')
  act(() => { void badTarget.root.unmount() })
})

test('PluginSlot: reappearing contribution on the render chain warns of a cycle and nesting beyond depth 16 aborts', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const portEn = makePort(log, { locale: 'en' })
  const portZh = makePort(log, { locale: 'zh-CN' })
  // The host render implementation renders the same slot again (equivalent to
  // a real cycle where the contribution component nests a same-named slot)
  const attachCycleSlot = (port: SDK.PluginClientHostPort) => {
    port.slots = {
      collectItems: (qualifiedName) =>
        qualifiedName === 'owner/loop'
          ? [
              {
                pluginId: 'p2',
                contributionId: 'cycle',
                spec: { id: 'cycle', target: 'owner/loop', client: { module: 'cycle.tsx', export: 'Cycle' } },
              },
            ]
          : [],
      renderItem: (item) =>
        e(SDK.PluginClientHostContext.Provider, { value: port },
          e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, item.pluginId, undefined) },
            e(SDK.PluginSlot, { name: 'owner/loop' }))),
    }
  }
  attachCycleSlot(portEn)
  attachCycleSlot(portZh)

  const cycleEn = mount(
    e(SDK.PluginClientHostContext.Provider, { value: portEn },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(portEn, 'owner', undefined) },
        e(SDK.PluginSlot, { name: 'loop' }))))
  assert.match(cycleEn.host.textContent ?? '', /cycle detected/, 'a cycle warns explicitly instead of a stack overflow')
  act(() => { void cycleEn.root.unmount() })

  const cycleZh = mount(
    e(SDK.PluginClientHostContext.Provider, { value: portZh },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(portZh, 'owner', undefined) },
        e(SDK.PluginSlot, { name: 'loop' }))))
  assert.match(cycleZh.host.textContent ?? '', /循环引用/, 'cycle warning localizes to zh-CN')
  act(() => { void cycleZh.root.unmount() })

  // Distinct contribution IDs along a 17-step chain hit MAX_SLOT_DEPTH=16 cleanly
  const deepPort = makePort(log, { locale: 'en' })
  deepPort.slots = {
    collectItems: (qualifiedName) => {
      const m = /^owner\/step-(\d+)$/.exec(qualifiedName)
      if (!m) return []
      const idx = Number(m[1])
      return [
        {
          pluginId: `p-${idx}`,
          contributionId: `c-${idx}`,
          spec: { id: `c-${idx}`, target: qualifiedName, client: { module: 's.tsx', export: 'S' } },
        },
      ]
    },
    renderItem: (item) => {
      const m = /^p-(\d+)$/.exec(item.pluginId)
      const next = Number(m![1]) + 1
      return e(SDK.PluginClientHostContext.Provider, { value: deepPort },
        e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(deepPort, item.pluginId, undefined) },
          e(SDK.PluginSlot, { name: `owner/step-${next}` })))
    },
  }
  const deep = mount(
    e(SDK.PluginClientHostContext.Provider, { value: deepPort },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(deepPort, 'owner', undefined) },
        e(SDK.PluginSlot, { name: 'step-0' }))))
  assert.match(deep.host.textContent ?? '', /exceeded the maximum depth of 16/, 'max depth 16 aborts cleanly')
  act(() => { void deep.root.unmount() })
})

// ---------------------------------------------------------------------------
// 5. MarkdownView / CodeBlockView port delegation
// ---------------------------------------------------------------------------

test('MarkdownView / CodeBlockView render the host-port injected implementations (SSR safe) and forward className/onLinkClick', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const html = renderToString(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e('div', null,
        e(SDK.MarkdownView, { text: '# hi', workspaceBaseDir: 'docs/sub', className: 'custom-md-class' }),
        e(SDK.CodeBlockView, { code: 'let x = 1', language: 'ts' }))))
  assert.match(html, /data-md="host"/, 'MarkdownView delegates to the host view')
  assert.match(html, /data-base-dir="docs\/sub"/, 'MarkdownView forwards workspaceBaseDir to host view')
  assert.match(html, /custom-md-class/, 'MarkdownView forwards className to host view')
  assert.match(html, /# hi/)
  assert.match(html, /data-code="host"/, 'CodeBlockView delegates to the host codeBlock')
  assert.match(html, /data-lang="ts"/)

  const clicked: string[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    act(() => {
      root.render(
        e(SDK.PluginClientHostContext.Provider, { value: port },
          e(SDK.MarkdownView, {
            text: '# ref',
            onLinkClick: (href, ev) => {
              ev.preventDefault()
              clicked.push(href)
            },
          })),
      )
    })
    const anchor = host.querySelector('a')
    assert.ok(anchor !== null, 'host view rendered link')
    act(() => {
      anchor.click()
    })
    assert.deepEqual(clicked, ['#custom-ref'], 'MarkdownView forwards onLinkClick to host view')
  } finally {
    act(() => {
      root.unmount()
    })
    host.remove()
  }
})

test('markdownUrlTransform allows artifact:, file:, and Windows drive paths while filtering unsafe protocols', { timeout: 60_000 }, () => {
  assert.equal(SDK.markdownUrlTransform('artifact:art-1'), 'artifact:art-1')
  assert.equal(SDK.markdownUrlTransform('  file:///repo/README.md#L10  '), 'file:///repo/README.md#L10')
  assert.equal(SDK.markdownUrlTransform('FILE:///C:/repo/a.png'), 'FILE:///C:/repo/a.png')
  assert.equal(SDK.markdownUrlTransform('C:/repo/src/App.tsx#L10'), 'C:/repo/src/App.tsx#L10')
  assert.equal(SDK.markdownUrlTransform('d:\\repo\\a.png'), 'd:\\repo\\a.png')
  assert.equal(SDK.markdownUrlTransform('docs/guide.md#L5'), 'docs/guide.md#L5')
  assert.equal(SDK.markdownUrlTransform('https://example.com/a'), 'https://example.com/a')
  assert.equal(SDK.markdownUrlTransform('javascript:alert(1)'), '')
  assert.equal(SDK.markdownUrlTransform('data:text/html,<script>alert(1)</script>'), '')
  assert.equal(SDK.markdownUrlTransform('vbscript:msgbox(1)'), '')
  assert.equal(SDK.markdownUrlTransform('custom:foo'), '')
})

// ---------------------------------------------------------------------------
// 6. useConversation lazy detail option & useSharedNowMs shared ticker
// ---------------------------------------------------------------------------

test('useConversation: includeDetail defaults to true, skips auto-load when false while preserving cached detail and manual reload', { timeout: 60_000 }, () => {
  const loadCalls: Array<{ id: number; force?: boolean }> = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const cachedDetail = { id: 8, entries: [] } as unknown as ConversationDetail
  const port = makePort(log, {
    conversations: [
      { id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as ConversationSummary,
      { id: 8, title: 'c8', tags: [], profileId: 'p' } as unknown as ConversationSummary,
    ],
    conversationDetails: { 8: cachedDetail },
    conversationLives: { 7: { conversationId: 7, status: 'working' } as unknown as ConversationLive },
    pendingAsks: [{ id: 'ask-7', conversationId: 7 } as unknown as AskSpec],
    overrides: {
      loadConversationDetail: (id, force) => {
        loadCalls.push({ id, force })
        return Promise.resolve(undefined)
      },
    },
  })

  let view7!: SDK.ConversationHookResult
  let view8!: SDK.ConversationHookResult
  function Probe({ includeDetail }: { includeDetail?: boolean }): React.ReactNode {
    view7 = SDK.useConversation(7, includeDetail === undefined ? undefined : { includeDetail })
    view8 = SDK.useConversation(8, { includeDetail: false })
    return e('div', null, 'probe')
  }

  // 1. includeDetail: false skips auto-load, still returns summary/live/pendingAsks and already-cached detail.
  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, { includeDetail: false })),
  )
  try {
    assert.deepEqual(loadCalls, [], 'includeDetail: false must not auto-call loadConversationDetail')
    assert.equal(view7.summary?.id, 7)
    assert.equal(view7.detail, undefined)
    assert.equal(view7.live?.conversationId, 7)
    assert.equal(view7.pendingAsks.length, 1)
    assert.ok(view8.detail === cachedDetail, 'already-cached detail is still returned when includeDetail is false')

    // Manual reload still forces a detail fetch even when includeDetail is false.
    act(() => view7.reload())
    assert.deepEqual(loadCalls, [{ id: 7, force: true }])

    // 2. Flipping includeDetail to default/true triggers auto-load on missing detail.
    act(() => root.render(e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, {}))))
    assert.deepEqual(loadCalls, [
      { id: 7, force: true },
      { id: 7, force: undefined },
    ])
  } finally {
    act(() => root.unmount())
  }
})

test('useConversation: includeLive: false skips live subscription and keeps live undefined', { timeout: 60_000 }, () => {
  const liveSubscriptions: number[] = []
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log, {
    conversations: [{ id: 7, title: 'c7', tags: [], profileId: 'p' } as unknown as ConversationSummary],
    conversationLives: { 7: { conversationId: 7, text: 'streaming...' } as unknown as ConversationLive },
    overrides: {
      subscribeConversationLive: (id) => {
        liveSubscriptions.push(id)
        return () => {}
      },
    },
  })

  let latestView: SDK.ConversationHookResult | undefined
  const readView = (): SDK.ConversationHookResult => {
    assert.ok(latestView !== undefined)
    return latestView
  }
  function Probe({ includeLive }: { includeLive?: boolean }): React.ReactNode {
    latestView = SDK.useConversation(7, { includeDetail: false, includeLive })
    return e('div', null, 'probe')
  }

  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, { includeLive: false })),
  )
  try {
    assert.deepEqual(liveSubscriptions, [], 'includeLive: false must not subscribe to conversationLives')
    assert.equal(readView().summary?.id, 7)
    assert.equal(readView().live, undefined)

    act(() => root.render(e(SDK.PluginClientHostContext.Provider, { value: port }, e(Probe, { includeLive: true }))))
    assert.deepEqual(liveSubscriptions, [7])
    assert.equal(readView().live?.text, 'streaming...')
  } finally {
    act(() => root.unmount())
  }
})

test('useSharedNowMs: SSR returns undefined, 20 concurrent active consumers share one setInterval, and deactivation/unmount clears timer immediately', { timeout: 60_000 }, async () => {
  // 1. SSR deterministic first frame returns undefined even when active=true.
  let ssrValue: number | undefined = 123
  function SsrProbe(): React.ReactNode {
    ssrValue = SDK.useSharedNowMs(true, 25)
    return e('span', null, String(ssrValue))
  }
  const html = renderToString(e(SsrProbe))
  assert.equal(ssrValue, undefined)
  assert.equal(html, '<span>undefined</span>')

  // 2. Client shared ticker: 20 subscribers with same intervalMs create only 1 setInterval.
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  let setIntervalCount = 0
  let clearIntervalCount = 0
  const activeTimers = new Set<unknown>()

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    setIntervalCount += 1
    const handle = origSetInterval(handler, timeout, ...args)
    activeTimers.add(handle)
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (activeTimers.delete(handle)) {
      clearIntervalCount += 1
    }
    origClearInterval(handle)
  }) as typeof clearInterval

  let mounted: ReturnType<typeof mount> | undefined
  try {
    const latest = new Array<number | undefined>(20).fill(undefined)
    let fastValue: number | undefined
    function Card({ idx, active }: { idx: number; active: boolean }): React.ReactNode {
      latest[idx] = SDK.useSharedNowMs(active, 25)
      return e('span', null, String(latest[idx]))
    }
    function FastCard({ active }: { active: boolean }): React.ReactNode {
      fastValue = SDK.useSharedNowMs(active, 40)
      return e('span', null, String(fastValue))
    }
    const buildTree = (active20: boolean, activeFast: boolean) =>
      e('div', null,
        ...Array.from({ length: 20 }, (_, idx) => e(Card, { key: idx, idx, active: active20 })),
        e(FastCard, { active: activeFast }),
      )

    // Inactive mount creates zero timers.
    mounted = mount(buildTree(false, false))
    assert.equal(setIntervalCount, 0)
    assert.equal(activeTimers.size, 0)
    assert.ok(latest.every((v) => v === undefined))

    // Activating all 20 (interval=25ms) + 1 (interval=40ms) creates exactly 2 timers total.
    act(() => mounted!.root.render(buildTree(true, true)))
    assert.equal(setIntervalCount, 2, '20 cards at 25ms share 1 timer + 1 card at 40ms = 2 timers total')
    assert.equal(activeTimers.size, 2)
    assert.ok(latest.every((v) => typeof v === 'number'), 'all active hooks initialize Date.now() immediately')
    assert.equal(typeof fastValue, 'number')
    const initialSample = latest[0]!

    // Wait for shared tick to advance all 20 subscribers together to the exact same timestamp.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70))
    })
    assert.ok(latest[0]! > initialSample, 'shared ticker advances nowMs')
    assert.ok(latest.every((v) => v === latest[0]), 'all 20 subscribers receive identical tick timestamp')

    // Deactivating the 20 cards clears the 25ms timer immediately while keeping the 40ms timer alive.
    act(() => mounted!.root.render(buildTree(false, true)))
    assert.ok(latest.every((v) => v === undefined), 'active -> false immediately resets return value to undefined')
    assert.equal(clearIntervalCount, 1)
    assert.equal(activeTimers.size, 1)

    // Unmounting cleans up the remaining 40ms timer with zero leaks.
    act(() => mounted!.root.unmount())
    mounted = undefined
    assert.equal(clearIntervalCount, 2)
    assert.equal(activeTimers.size, 0)
  } finally {
    const remaining = mounted
    if (remaining) act(() => remaining.root.unmount())
    globalThis.setInterval = origSetInterval
    globalThis.clearInterval = origClearInterval
  }
})

test('useSharedNowMs: consumes optional host port.getServerNow(), preserves this-binding and shared ticks, and falls back safely without Provider or on error', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  let fakeServerNow = 1_700_000_000_000
  let serverNowCalls = 0
  const basePort = makePort(log)
  const portWithClock: SDK.PluginClientHostPort = {
    ...basePort,
    getServerNow() {
      // Verify `this` binding is preserved (points to portWithClock).
      assert.ok(this === portWithClock, 'getServerNow must be invoked with host port as `this`')
      serverNowCalls += 1
      return fakeServerNow
    },
  }

  // 1. SSR inside Provider still returns undefined and never calls getServerNow().
  let ssrVal: number | undefined = 999
  function SsrWithPort(): React.ReactNode {
    ssrVal = SDK.useSharedNowMs(true, 20)
    return e('span', null, String(ssrVal))
  }
  const ssrHtml = renderToString(e(SDK.PluginClientHostContext.Provider, { value: portWithClock }, e(SsrWithPort)))
  assert.equal(ssrVal, undefined)
  assert.equal(ssrHtml, '<span>undefined</span>')
  assert.equal(serverNowCalls, 0)

  // 2. Multiple consumers under the same Provider share one getServerNow() sample per tick.
  const seenA: Array<number | undefined> = []
  const seenB: Array<number | undefined> = []
  function Consumer({ bucket }: { bucket: Array<number | undefined> }): React.ReactNode {
    const now = SDK.useSharedNowMs(true, 20)
    bucket.push(now)
    return e('span', null, String(now))
  }
  const mounted = mount(
    e(
      SDK.PluginClientHostContext.Provider,
      { value: portWithClock },
      e('div', null, e(Consumer, { bucket: seenA }), e(Consumer, { bucket: seenB })),
    ),
  )
  try {
    assert.equal(seenA[seenA.length - 1], 1_700_000_000_000)
    assert.equal(seenB[seenB.length - 1], 1_700_000_000_000)
    const callsAfterMount = serverNowCalls
    fakeServerNow = 1_700_000_005_000
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 45))
    })
    assert.equal(seenA[seenA.length - 1], 1_700_000_005_000)
    assert.equal(seenB[seenB.length - 1], 1_700_000_005_000)
    assert.ok(serverNowCalls > callsAfterMount, 'shared ticker samples getServerNow on interval ticks')
  } finally {
    act(() => mounted.root.unmount())
  }

  // 3. Throwing or non-finite getServerNow silently falls back to Date.now() without crashing.
  for (const broken of [
    () => { throw new Error('clock fault') },
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
  ]) {
    const badPort: SDK.PluginClientHostPort = { ...basePort, getServerNow: broken }
    let observed: number | undefined
    function BadClockProbe(): React.ReactNode {
      observed = SDK.useSharedNowMs(true, 50)
      return e('span', null, String(observed))
    }
    const before = Date.now()
    const m = mount(e(SDK.PluginClientHostContext.Provider, { value: badPort }, e(BadClockProbe)))
    const after = Date.now()
    try {
      assert.ok(typeof observed === 'number' && observed >= before && observed <= after, 'broken getServerNow must fall back to Date.now()')
    } finally {
      act(() => m.root.unmount())
    }
  }
})

// ---------------------------------------------------------------------------
// 7. usePluginConfig contract
// ---------------------------------------------------------------------------

test('usePluginConfig: returns current plugin publicConfig, falls back to stable empty object when absent, and updates reactively', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const initialPlugins: PluginSummary[] = [
    {
      id: 'p1',
      name: 'P1',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
      publicConfig: { slidingWindowMs: 1500, mode: 'auto' },
    },
    {
      id: 'p2',
      name: 'P2',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
    },
  ]
  const reactive = createReactivePort(log, { plugins: initialPlugins })

  const p1Seen: Array<{ slidingWindowMs?: number; mode?: string; apiKey?: string }> = []
  const p2Seen: Array<Record<string, unknown>> = []

  const P1Probe = React.memo(function P1Probe(): React.ReactNode {
    const cfg = SDK.usePluginConfig<{ slidingWindowMs?: number; mode?: string; apiKey?: string }>()
    p1Seen.push(cfg)
    return e('div', null, `${cfg.slidingWindowMs ?? 'none'}:${cfg.apiKey ?? 'no-secret'}`)
  })

  const P2Probe = React.memo(function P2Probe(): React.ReactNode {
    const cfg = SDK.usePluginConfig()
    p2Seen.push(cfg)
    return e('div', null, JSON.stringify(cfg))
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const ctx1 = SDK.createPluginClientContext(reactive.port, 'p1', undefined)
  const ctx2 = SDK.createPluginClientContext(reactive.port, 'p2', undefined)

  try {
    act(() => {
      root.render(
        e(SDK.PluginClientHostContext.Provider, { value: reactive.port },
          e(SDK.PluginClientContext.Provider, { value: ctx1 }, e(P1Probe)),
          e(SDK.PluginClientContext.Provider, { value: ctx2 }, e(P2Probe))),
      )
    })
    assert.deepEqual(p1Seen.at(-1), { slidingWindowMs: 1500, mode: 'auto' })
    assert.equal(p1Seen.at(-1)?.apiKey, undefined)
    assert.deepEqual(p2Seen.at(-1), {})
    const firstEmptyRef = p2Seen.at(-1)
    const p2RendersBefore = p2Seen.length

    act(() => {
      reactive.setPlugins([
        {
          ...initialPlugins[0]!,
          publicConfig: { slidingWindowMs: 2500, mode: 'fast' },
        },
        initialPlugins[1]!,
      ])
    })
    assert.deepEqual(p1Seen.at(-1), { slidingWindowMs: 2500, mode: 'fast' })
    assert.ok(p2Seen.at(-1) === firstEmptyRef, 'absent publicConfig reuses a referentially stable empty object')
    assert.equal(p2Seen.length, p2RendersBefore, 'unchanged plugin config does not re-render unrelated usePluginConfig subscriber')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('usePluginConfig: throws explicitly when called outside <PluginUiView>', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  function OutsideProbe(): React.ReactNode {
    SDK.usePluginConfig()
    return e('div', null, 'probe')
  }
  assert.throws(
    () => renderToString(e(SDK.PluginClientHostContext.Provider, { value: port }, e(OutsideProbe))),
    /usePluginContext/,
    'usePluginConfig throws outside <PluginUiView>',
  )
})

// ---------------------------------------------------------------------------
// 6. ToolCallDetails: shared inline tool-call details primitive
// ---------------------------------------------------------------------------

test('ToolCallDetails: renders raw input/output with host trace classes; the artifact button forwards ctx.openArtifact and labels localize', { timeout: 60_000 }, async () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const reactive = createReactivePort(log, { locale: 'zh-CN' })
  const ctx = SDK.createPluginClientContext(reactive.port, 'p1', 7)
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: reactive.port },
      e(SDK.PluginClientContext.Provider, { value: ctx },
        e(SDK.ToolCallDetails, { input: { resume: 11 }, result: 'done text', artifactRef: 'art_full' }))),
  )
  try {
    const details = host.querySelector('details.tool-call-details') as HTMLDetailsElement | null
    assert.ok(details !== null, 'renders a details.tool-call-details (host public trace vocabulary)')
    assert.equal(details.open, false, 'collapsed by default when defaultOpen is omitted')
    assert.equal(details.querySelector('summary')?.textContent, '调用详情')
    assert.deepEqual(
      [...details.querySelectorAll('.trace-section-label')].map((n) => n.textContent),
      ['输入', '输出'],
    )
    assert.ok(details.querySelector('.trace-expanded-body')?.classList.contains('selectable') === true)
    assert.match(details.textContent!, /"resume": 11/, 'object input is pretty-printed as JSON')
    assert.match(details.textContent!, /done text/, 'string result passes through verbatim')
    const artifact = details.querySelector('button')
    assert.ok(artifact !== null, 'artifactRef renders an open-artifact button')
    assert.match(artifact.textContent!, /打开完整产物 #art_full/)
    await act(async () => {
      artifact!.click()
    })
    assert.deepEqual(log.artifacts, [{ artifactId: 'art_full', conversationId: 7 }], 'the button forwards to the host artifact previewer via the port (bound to the context conversation)')
    act(() => reactive.setLocale('en'))
    assert.equal(host.querySelector('summary')?.textContent, 'Call details')
    assert.deepEqual(
      [...host.querySelectorAll('.trace-section-label')].map((n) => n.textContent),
      ['Input', 'Output'],
    )
  } finally {
    act(() => root.unmount())
  }
})

test('ToolCallDetails: defaultOpen=true renders expanded on first mount without requiring a second click', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(SDK.ToolCallDetails, { input: { prompt: 'hello' }, result: 'world', defaultOpen: true }))),
  )
  try {
    const details = host.querySelector('details.tool-call-details') as HTMLDetailsElement | null
    assert.ok(details !== null)
    assert.equal(details.open, true, 'starts expanded when defaultOpen=true')
  } finally {
    act(() => root.unmount())
  }
})

// ---------------------------------------------------------------------------
// 8. Fine-grained domain & keyed subscription isolation (streaming frames)
// ---------------------------------------------------------------------------

test('streaming conversationLives frames only re-render the matching useConversation subscriber and never unrelated SDK hooks or controls', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const reactive = createReactivePort(log, {
    authenticated: false,
    theme: 'dark',
    locale: 'en',
    conversations: [
      { id: 1, title: 'c1', tags: [], profileId: 'p' } as unknown as ConversationSummary,
      { id: 2, title: 'c2', tags: [], profileId: 'p' } as unknown as ConversationSummary,
    ],
    conversationDetails: {
      1: { id: 1, entries: [] } as unknown as ConversationDetail,
      2: { id: 2, entries: [] } as unknown as ConversationDetail,
    },
    pluginDocs: { 'p1/state': { v: 1 }, 'p2/other': { v: 2 } },
  })
  const ctx = SDK.createPluginClientContext(reactive.port, 'p1', 1)

  const counts = {
    conv1: 0,
    conv2: 0,
    convsList: 0,
    plugins: 0,
    docP1: 0,
    docMissing: 0,
    locale: 0,
    pluginCtx: 0,
    slot: 0,
    copyBtn: 0,
  }
  let observedTheme: 'light' | 'dark' | undefined
  let observedLocale: SDK.HelmxLocale | undefined
  let observedConv1Text: string | undefined

  const Conv1Probe = React.memo(function Conv1Probe(): React.ReactNode {
    counts.conv1 += 1
    observedConv1Text = SDK.useConversation(1).live?.text
    return null
  })
  const Conv2Probe = React.memo(function Conv2Probe(): React.ReactNode {
    counts.conv2 += 1
    void SDK.useConversation(2)
    return null
  })
  const ConvsListProbe = React.memo(function ConvsListProbe(): React.ReactNode {
    counts.convsList += 1
    void SDK.useConversations()
    return null
  })
  const PluginsProbe = React.memo(function PluginsProbe(): React.ReactNode {
    counts.plugins += 1
    void SDK.usePlugins()
    return null
  })
  const DocP1Probe = React.memo(function DocP1Probe(): React.ReactNode {
    counts.docP1 += 1
    void SDK.usePluginDoc('state')
    return null
  })
  const DocMissingProbe = React.memo(function DocMissingProbe(): React.ReactNode {
    counts.docMissing += 1
    void SDK.usePluginDoc('lazy')
    return null
  })
  const LocaleProbe = React.memo(function LocaleProbe(): React.ReactNode {
    counts.locale += 1
    observedLocale = SDK.usePluginLocale()
    return null
  })
  const PluginCtxProbe = React.memo(function PluginCtxProbe(): React.ReactNode {
    counts.pluginCtx += 1
    const c = SDK.usePluginContext()
    observedTheme = c.theme
    return null
  })
  const SlotProbe = React.memo(function SlotProbe(): React.ReactNode {
    counts.slot += 1
    return e(SDK.PluginSlot, { name: 'owner/zone', ownerPluginId: 'owner', conversationId: 1 })
  })
  const CopyBtnProbe = React.memo(function CopyBtnProbe(): React.ReactNode {
    counts.copyBtn += 1
    return e(CopyButton, { text: 'hello' })
  })

  const { root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: reactive.port },
      e(SDK.PluginClientContext.Provider, { value: ctx },
        e(Conv1Probe),
        e(Conv2Probe),
        e(ConvsListProbe),
        e(PluginsProbe),
        e(DocP1Probe),
        e(DocMissingProbe),
        e(LocaleProbe),
        e(PluginCtxProbe),
        e(SlotProbe),
        e(CopyBtnProbe))),
  )
  try {
    // Auth gate: while authenticated=false, missing doc must NOT call ensurePluginDoc.
    assert.deepEqual(log.docs, [], 'unauthenticated state must not fire ensurePluginDoc')
    const baseline = { ...counts }

    // Burst 10 streaming token frames for conversation #1.
    for (let i = 1; i <= 10; i += 1) {
      act(() => {
        reactive.setConversationLive(1, { conversationId: 1, text: `tok-${i}`, tools: [], updatedAt: i } as ConversationLive)
      })
    }
    assert.equal(observedConv1Text, 'tok-10', 'conversation #1 live subscriber receives every streaming delta')
    assert.equal(counts.conv1, baseline.conv1 + 10, 'only conversation #1 subscriber re-rendered per live delta')
    assert.equal(counts.conv2, baseline.conv2, 'conversation #2 subscriber is isolated from #1 live frames')
    assert.equal(counts.convsList, baseline.convsList, 'useConversations is isolated from live frames')
    assert.equal(counts.plugins, baseline.plugins, 'usePlugins is isolated from live frames')
    assert.equal(counts.docP1, baseline.docP1, 'usePluginDoc is isolated from live frames')
    assert.equal(counts.locale, baseline.locale, 'usePluginLocale is isolated from live frames')
    assert.equal(counts.pluginCtx, baseline.pluginCtx, 'usePluginContext is isolated from live frames')
    assert.equal(counts.slot, baseline.slot, 'PluginSlot is isolated from live frames')
    assert.equal(counts.copyBtn, baseline.copyBtn, 'SDK UI controls (CopyButton) are isolated from live frames')

    // Unrelated plugin doc update never wakes p1/state subscriber.
    act(() => reactive.setPluginDoc('p2/other', { v: 99 }))
    assert.equal(counts.docP1, baseline.docP1, 'updating p2/other does not re-render p1/state subscriber')

    // Theme-only change updates usePluginContext().theme without re-rendering usePluginLocale or usePluginDoc.
    act(() => reactive.setTheme('light'))
    assert.equal(observedTheme, 'light', 'usePluginContext tracks theme reactively through subscribePrefs')
    assert.equal(counts.pluginCtx, baseline.pluginCtx + 1)
    assert.equal(counts.locale, baseline.locale, 'theme-only change does not re-render usePluginLocale')
    assert.equal(counts.docP1, baseline.docP1, 'theme-only change does not re-render data-only usePluginDoc')

    // Locale change updates usePluginLocale & usePluginContext without waking doc subscribers.
    act(() => reactive.setLocale('zh-CN'))
    assert.equal(observedLocale, 'zh-CN')
    assert.equal(counts.locale, baseline.locale + 1)
    assert.equal(counts.docP1, baseline.docP1)

    // Flipping authenticated false -> true triggers ensurePluginDoc once for missing doc.
    act(() => reactive.setAuthenticated(true))
    assert.deepEqual(log.docs, [{ pluginId: 'p1', docName: 'lazy' }], 'auth transition triggers ensurePluginDoc for missing doc')
  } finally {
    act(() => root.unmount())
  }
})

test('ToolCallDetails: omitted facts render no section and no artifact button (never fabricates empty blocks)', { timeout: 60_000 }, () => {
  const log: PortLog = { actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [] }
  const port = makePort(log)
  const { host, root } = mount(
    e(SDK.PluginClientHostContext.Provider, { value: port },
      e(SDK.PluginClientContext.Provider, { value: SDK.createPluginClientContext(port, 'p1', 7) },
        e(SDK.ToolCallDetails, { result: { ok: true }, artifactRef: '' }))))
  try {
    const details = host.querySelector('details.tool-call-details')
    assert.ok(details !== null)
    assert.deepEqual([...details.querySelectorAll('.trace-section-label')].map((n) => n.textContent), ['输出'], 'no Input section when input is undefined (makePort locale is zh-CN)')
    assert.match(details.textContent!, /"ok": true/)
    assert.equal(details.querySelectorAll('button').length, 0, 'an empty artifactRef renders no button')
  } finally {
    act(() => root.unmount())
  }
})

// ---------------------------------------------------------------------------
// 7. TimelineToolCallsContext / useTimelineToolCalls: per-toolName sharded store
// ---------------------------------------------------------------------------

test('useTimelineToolCalls: returns a referentially stable frozen empty array outside Provider and on SSR', { timeout: 60_000 }, () => {
  const snapshots: Array<ReadonlyArray<SDK.TimelineToolCallSummary>> = []
  function OutsideProbe({ toolName }: { toolName: string }): React.ReactNode {
    const calls = SDK.useTimelineToolCalls(toolName)
    snapshots.push(calls)
    return e('div', { 'data-count': calls.length }, String(calls.length))
  }

  // SSR outside Provider
  const html = renderToString(e(OutsideProbe, { toolName: 'subagent' }))
  assert.match(html, /data-count="0"/)
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0], [])
  assert.ok(Object.isFrozen(snapshots[0]), 'empty fallback array must be frozen')

  // Client mount + re-render + switching toolName outside Provider
  const { host, root } = mount(e(OutsideProbe, { toolName: 'subagent' }))
  try {
    assert.equal(host.querySelector('[data-count="0"]')?.textContent, '0')
    act(() => root.render(e(OutsideProbe, { toolName: 'bash' })))
    act(() => root.render(e(OutsideProbe, { toolName: '' })))
    assert.ok(snapshots.length >= 4)
    for (const snap of snapshots) {
      assert.ok(snap === snapshots[0], 'all outside-Provider snapshots must share the exact same empty array reference')
    }
  } finally {
    act(() => root.unmount())
  }
})

test('useTimelineToolCalls: shards by toolName so unrelated tool updates trigger zero re-renders and preserve unchanged references', { timeout: 60_000 }, () => {
  const inputSub1 = { prompt: 'audit', resume: 11 }
  const metaSub1 = { runId: 'wf_1', status: 'running' }
  const inputBash1 = { command: 'ls' }
  const metaBash1 = { exitCode: 0 }
  const inputRead1 = { path: 'a.ts' }

  const store = SDK.createTimelineToolCallsStore([
    { callId: 'c1', toolName: 'subagent', index: 0, status: 'running', input: inputSub1, presentationMeta: metaSub1 },
    { callId: 'c2', toolName: 'bash', index: 1, status: 'running', input: inputBash1 },
  ])

  let subagentRenders = 0
  let bashRenders = 0
  const subagentSnapshots: Array<ReadonlyArray<SDK.TimelineToolCallSummary>> = []
  const bashSnapshots: Array<ReadonlyArray<SDK.TimelineToolCallSummary>> = []

  function SubagentProbe(): React.ReactNode {
    subagentRenders += 1
    const calls = SDK.useTimelineToolCalls('subagent')
    subagentSnapshots.push(calls)
    return e('div', { 'data-subagent': calls.map((c) => `${c.callId}:${c.status}`).join(',') })
  }

  function BashProbe(): React.ReactNode {
    bashRenders += 1
    const calls = SDK.useTimelineToolCalls('bash')
    bashSnapshots.push(calls)
    return e('div', { 'data-bash': calls.map((c) => `${c.callId}:${c.status}`).join(',') })
  }

  const { root } = mount(
    e(
      SDK.TimelineToolCallsContext.Provider,
      { value: store },
      e(SubagentProbe),
      e(BashProbe),
    ),
  )

  try {
    assert.equal(subagentRenders, 1)
    assert.equal(bashRenders, 1)
    const initialSubagentRef = subagentSnapshots[0]!
    assert.equal(initialSubagentRef.length, 1)
    assert.equal(initialSubagentRef[0]!.callId, 'c1')
    assert.equal(initialSubagentRef[0]!.index, 0)
    assert.ok(Object.isFrozen(initialSubagentRef))
    assert.ok(Object.isFrozen(initialSubagentRef[0]))

    // Update bash and add read — subagent summary fields/refs are unchanged (fresh wrapper object).
    act(() => {
      const changed = store.update([
        { callId: 'c1', toolName: 'subagent', index: 0, status: 'running', input: inputSub1, presentationMeta: metaSub1 },
        { callId: 'c2', toolName: 'bash', index: 1, status: 'done', input: inputBash1, presentationMeta: metaBash1 },
        { callId: 'c3', toolName: 'read', index: 2, status: 'done', input: inputRead1 },
      ])
      assert.equal(changed, true)
    })

    assert.equal(subagentRenders, 1, 'unrelated toolName updates must NOT re-render subagent subscriber')
    assert.equal(bashRenders, 2, 'bash status/meta change must re-render bash subscriber')
    assert.ok(store.getSnapshot('subagent') === initialSubagentRef, 'unchanged shard preserves array reference')
    assert.equal(bashSnapshots.at(-1)?.[0]?.status, 'done')
    assert.deepEqual(bashSnapshots.at(-1)?.[0]?.presentationMeta, metaBash1)

    // Identical update (rebuilt wrapper objects, same values/refs) notifies no one.
    act(() => {
      const changed = store.update(
        new Map<string, ReadonlyArray<SDK.TimelineToolCallSummary>>([
          ['subagent', [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'running', input: inputSub1, presentationMeta: metaSub1 }]],
          ['bash', [{ callId: 'c2', toolName: 'bash', index: 1, status: 'done', input: inputBash1, presentationMeta: metaBash1 }]],
          ['read', [{ callId: 'c3', toolName: 'read', index: 2, status: 'done', input: inputRead1 }]],
        ]),
      )
      assert.equal(changed, false)
    })
    assert.equal(subagentRenders, 1)
    assert.equal(bashRenders, 2)

    // Append a second subagent call: subagent re-renders and reuses unchanged prefix element identity.
    const metaSub2 = { runId: 'wf_2', status: 'done' }
    act(() => {
      store.update([
        { callId: 'c1', toolName: 'subagent', index: 0, status: 'running', input: inputSub1, presentationMeta: metaSub1 },
        { callId: 'c2', toolName: 'bash', index: 1, status: 'done', input: inputBash1, presentationMeta: metaBash1 },
        { callId: 'c4', toolName: 'subagent', index: 2, status: 'done', presentationMeta: metaSub2 },
      ])
    })
    assert.equal(subagentRenders, 2)
    assert.equal(bashRenders, 2, 'removing read / adding subagent must NOT re-render bash subscriber')
    const nextSubagentRef = subagentSnapshots.at(-1)!
    assert.equal(nextSubagentRef.length, 2)
    assert.ok(nextSubagentRef[0] === initialSubagentRef[0], 'unchanged prefix summary keeps element reference')
    assert.equal(nextSubagentRef[1]!.callId, 'c4')
    assert.equal(nextSubagentRef[1]!.index, 2)

    // Clear all calls: both shards reset to empty and notify once; subsequent empty update notifies no one.
    act(() => {
      assert.equal(store.update([]), true)
    })
    assert.equal(subagentRenders, 3)
    assert.equal(bashRenders, 3)
    assert.deepEqual(subagentSnapshots.at(-1), [])
    assert.deepEqual(bashSnapshots.at(-1), [])
    act(() => {
      assert.equal(store.update(new Map([['subagent', []]])), false)
    })
    assert.equal(subagentRenders, 3)
    assert.equal(bashRenders, 3)
  } finally {
    act(() => root.unmount())
  }
})

test('useTimelineToolCalls: dynamic toolName switching, empty toolName, and SSR inside Provider', { timeout: 60_000 }, () => {
  const store = SDK.createTimelineToolCallsStore([
    { callId: 's1', toolName: 'subagent', index: 0, status: 'done' },
    { callId: 'b1', toolName: 'bash', index: 1, status: 'running' },
  ])

  let latest: ReadonlyArray<SDK.TimelineToolCallSummary> = []
  let renders = 0
  function SwitchProbe({ toolName }: { toolName: string }): React.ReactNode {
    renders += 1
    latest = SDK.useTimelineToolCalls(toolName)
    return e('div', { 'data-ids': latest.map((c) => c.callId).join(',') })
  }

  const ssrHtml = renderToString(
    e(SDK.TimelineToolCallsContext.Provider, { value: store }, e(SwitchProbe, { toolName: 'subagent' })),
  )
  assert.match(ssrHtml, /data-ids="s1"/)

  renders = 0
  const { root } = mount(
    e(SDK.TimelineToolCallsContext.Provider, { value: store }, e(SwitchProbe, { toolName: 'subagent' })),
  )
  try {
    assert.deepEqual(latest.map((c) => c.callId), ['s1'])

    // Switch subscribed toolName to 'bash'
    act(() => {
      root.render(e(SDK.TimelineToolCallsContext.Provider, { value: store }, e(SwitchProbe, { toolName: 'bash' })))
    })
    assert.deepEqual(latest.map((c) => c.callId), ['b1'])
    const rendersBeforeUnrelated = renders

    // Updates to 'subagent' no longer affect this subscriber after switching to 'bash'
    act(() => {
      store.update([
        { callId: 's1', toolName: 'subagent', index: 0, status: 'error' },
        { callId: 'b1', toolName: 'bash', index: 1, status: 'running' },
      ])
    })
    assert.equal(renders, rendersBeforeUnrelated)

    // Empty toolName falls back to stable empty array and ignores store updates
    act(() => {
      root.render(e(SDK.TimelineToolCallsContext.Provider, { value: store }, e(SwitchProbe, { toolName: '' })))
    })
    assert.deepEqual(latest, [])
    const rendersWhenEmpty = renders
    act(() => {
      store.update([])
    })
    assert.equal(renders, rendersWhenEmpty)
  } finally {
    act(() => root.unmount())
  }
})

test('createTimelineToolCallsStore: enforces lightweight summary boundary, prototype safety, and atomic rejection', { timeout: 60_000 }, () => {
  const initialCall: SDK.TimelineToolCallSummary = {
    callId: 'keep-1',
    toolName: 'subagent',
    index: 0,
    status: 'done',
    presentationMeta: { runId: 'wf_keep' },
  }
  const store = SDK.createTimelineToolCallsStore([initialCall])
  let listenerCalls = 0
  const unsub = store.subscribe('subagent', () => {
    listenerCalls += 1
  })
  // Double unsubscribe must be safe and idempotent when called later
  const unsubTemp = store.subscribe('bash', () => {})
  unsubTemp()
  unsubTemp()

  try {
    const invalidCases: Array<{ label: string; input: unknown }> = [
      { label: 'bulky result string', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', result: 'huge output' }] },
      { label: 'bulky resultText', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', resultText: 'huge' }] },
      { label: 'bulky resultTruncation', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', resultTruncation: { truncated: true } }] },
      { label: 'bulky structuredOutput', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', structuredOutput: { ok: true } }] },
      { label: 'empty callId', input: [{ callId: '', toolName: 'subagent', index: 0, status: 'done' }] },
      { label: 'empty toolName', input: [{ callId: 'c1', toolName: '', index: 0, status: 'done' }] },
      { label: 'negative index', input: [{ callId: 'c1', toolName: 'subagent', index: -1, status: 'done' }] },
      { label: 'non-integer index', input: [{ callId: 'c1', toolName: 'subagent', index: 1.5, status: 'done' }] },
      { label: 'invalid status', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'unknown' }] },
      { label: 'array presentationMeta', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', presentationMeta: ['bad'] }] },
      { label: 'null presentationMeta', input: [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done', presentationMeta: null }] },
      { label: 'mismatched map shard key', input: new Map([['bash', [{ callId: 'c1', toolName: 'subagent', index: 0, status: 'done' }]]]) },
    ]

    for (const c of invalidCases) {
      assert.throws(
        () => store.update(c.input as SDK.TimelineToolCallsInput),
        TypeError,
        `${c.label} must be explicitly rejected`,
      )
    }

    // Atomic validation failure must leave existing shards untouched and notify nobody
    assert.equal(listenerCalls, 0)
    assert.equal(store.getSnapshot('subagent').length, 1)
    assert.equal(store.getSnapshot('subagent')[0]!.callId, 'keep-1')

    // Unexpected extra own properties are stripped so stored summaries only expose allowed protocol fields
    store.update([
      {
        callId: 'c-clean',
        toolName: 'subagent',
        index: 0,
        status: 'done',
        extraLeak: 'ignored',
      } as unknown as SDK.TimelineToolCallSummary,
    ])
    const stored = store.getSnapshot('subagent')[0]! as unknown as Record<string, unknown>
    assert.deepEqual(Object.keys(stored).sort(), ['callId', 'index', 'status', 'toolName'])
    assert.equal('extraLeak' in stored, false)
    assert.equal(listenerCalls, 1)

    // Prototype-key tool names do not collide with Object.prototype
    for (const protoTool of ['__proto__', 'constructor', 'toString']) {
      assert.deepEqual(store.getSnapshot(protoTool), [])
      store.update([{ callId: `id-${protoTool}`, toolName: protoTool, index: 0, status: 'done' }])
      assert.equal(store.getSnapshot(protoTool).length, 1)
      assert.equal(store.getSnapshot(protoTool)[0]!.toolName, protoTool)
    }
  } finally {
    unsub()
  }
})

// ---------------------------------------------------------------------------
// 7. ComposerCommandContext / createComposerCommandRegistry / useComposerCommand
// ---------------------------------------------------------------------------

test('createComposerCommandRegistry: version transitions, LIFO stacking, token-safe unregister, and unregistered invoke', { timeout: 60_000 }, () => {
  const registry = SDK.createComposerCommandRegistry()
  let listenerCalls = 0
  const unsub = registry.subscribe(() => {
    listenerCalls += 1
  })
  const unsubNoop = registry.subscribe(() => {})
  unsubNoop()
  unsubNoop()

  try {
    assert.equal(registry.getVersion(), 0)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), false)
    assert.deepEqual(registry.invoke('builtin:plan', 'toggle-plan'), { handled: false })

    // Invalid empty pluginId / commandId returns safe no-op
    const invalidRelease = registry.register('', 'toggle-plan', () => {})
    invalidRelease()
    assert.equal(registry.getVersion(), 0)

    const calls: string[] = []
    // First mount: 0 -> 1 bumps version & notifies once
    const rel1 = registry.register('builtin:plan', 'toggle-plan', () => {
      calls.push('first')
    })
    assert.equal(registry.getVersion(), 1)
    assert.equal(listenerCalls, 1)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), true)

    // Second stacked mount on same key: version stays stable, LIFO invokes newest
    const rel2 = registry.register('builtin:plan', 'toggle-plan', () => {
      calls.push('second')
    })
    assert.equal(registry.getVersion(), 1)
    assert.equal(listenerCalls, 1)
    const firstInvoke = registry.invoke('builtin:plan', 'toggle-plan')
    assert.equal(firstInvoke.handled, true)
    assert.deepEqual(calls, ['second'])

    // Token-scoped unregister: releasing rel2 keeps rel1 active without bumping version; double release is idempotent
    rel2()
    rel2()
    assert.equal(registry.getVersion(), 1)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), true)
    const secondInvoke = registry.invoke('builtin:plan', 'toggle-plan')
    assert.equal(secondInvoke.handled, true)
    assert.deepEqual(calls, ['second', 'first'])

    // Last release (1 -> 0): deletes key, bumps version & notifies once
    rel1()
    assert.equal(registry.getVersion(), 2)
    assert.equal(listenerCalls, 2)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), false)
    assert.deepEqual(registry.invoke('builtin:plan', 'toggle-plan'), { handled: false })
  } finally {
    unsub()
  }
})

test('useComposerCommand: registers under PluginClientContext, keeps fresh closure without version churn, unregisters on unmount or undefined handler', { timeout: 60_000 }, () => {
  const { port } = createReactivePort({
    actions: [], inputs: [], targets: [], drawers: [], artifacts: [], workbench: [], notices: [], docs: [],
  })
  const ctx = SDK.createPluginClientContext(port, 'builtin:plan', 7)
  const registry = SDK.createComposerCommandRegistry()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const observed: string[] = []

  function Probe({ label, enabled = true }: { label: string; enabled?: boolean }) {
    SDK.useComposerCommand('toggle-plan', enabled ? () => { observed.push(label) } : undefined)
    return null
  }

  try {
    // No-op safely outside ComposerCommandContext & PluginClientContext
    act(() => {
      root.render(e(Probe, { label: 'bare' }))
    })
    assert.equal(registry.getVersion(), 0)

    act(() => {
      root.render(
        e(
          SDK.ComposerCommandContext.Provider,
          { value: registry },
          e(SDK.PluginClientContext.Provider, { value: ctx }, e(Probe, { label: 'v1' })),
        ),
      )
    })
    assert.equal(registry.getVersion(), 1)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), true)
    registry.invoke('builtin:plan', 'toggle-plan')
    assert.deepEqual(observed, ['v1'])

    // Re-rendering with a new handler closure updates latest handler WITHOUT bumping version
    act(() => {
      root.render(
        e(
          SDK.ComposerCommandContext.Provider,
          { value: registry },
          e(SDK.PluginClientContext.Provider, { value: ctx }, e(Probe, { label: 'v2' })),
        ),
      )
    })
    assert.equal(registry.getVersion(), 1)
    registry.invoke('builtin:plan', 'toggle-plan')
    assert.deepEqual(observed, ['v1', 'v2'])

    // Passing handler = undefined unregisters cleanly
    act(() => {
      root.render(
        e(
          SDK.ComposerCommandContext.Provider,
          { value: registry },
          e(SDK.PluginClientContext.Provider, { value: ctx }, e(Probe, { label: 'v3', enabled: false })),
        ),
      )
    })
    assert.equal(registry.getVersion(), 2)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), false)

    // Re-enabling registers again and unmounting releases cleanly
    act(() => {
      root.render(
        e(
          SDK.ComposerCommandContext.Provider,
          { value: registry },
          e(SDK.PluginClientContext.Provider, { value: ctx }, e(Probe, { label: 'v4', enabled: true })),
        ),
      )
    })
    assert.equal(registry.getVersion(), 3)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), true)
    act(() => {
      root.unmount()
    })
    assert.equal(registry.getVersion(), 4)
    assert.equal(registry.has('builtin:plan', 'toggle-plan'), false)
  } finally {
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 8. ComposerModelPickerModeContext / createComposerModelPickerModeRegistry / useComposerModelPickerMode
// ---------------------------------------------------------------------------

test('createComposerModelPickerModeRegistry: stable snapshots, LIFO stacking, token-safe unregister, and setOpenMode/openMode', { timeout: 60_000 }, () => {
  const registry = SDK.createComposerModelPickerModeRegistry()
  let listenerCalls = 0
  const unsub = registry.subscribe(() => {
    listenerCalls += 1
  })
  const unsubNoop = registry.subscribe(() => {})
  unsubNoop()
  unsubNoop()

  try {
    const initial = registry.getModes()
    assert.deepEqual(initial, [])
    assert.ok(registry.getModes() === initial, 'getModes() must stay referentially stable when unchanged')
    assert.equal(registry.has('tiers:one-turn'), false)
    assert.equal(registry.openMode('tiers:one-turn'), false)

    // Empty key or blank label is a safe no-op
    const invalidKeyRelease = registry.register('', { label: 'Next turn', onApply: () => {} })
    invalidKeyRelease()
    const blankLabelRelease = registry.register('k', { label: '   ', onApply: () => {} })
    blankLabelRelease()
    assert.equal(listenerCalls, 0)
    assert.ok(registry.getModes() === initial)

    const applied: string[] = []
    const rel1 = registry.register('tiers:one-turn', {
      id: 'tiers:one-turn',
      label: 'Next turn',
      hint: 'Hint 1',
      onApply: ({ modelKey }) => {
        applied.push(`first:${modelKey}`)
      },
    })
    assert.equal(listenerCalls, 1)
    assert.equal(registry.has('tiers:one-turn'), true)
    const snap1 = registry.getModes()
    assert.equal(snap1.length, 1)
    assert.equal(snap1[0]?.key, 'tiers:one-turn')
    assert.equal(snap1[0]?.spec.label, 'Next turn')
    assert.ok(registry.getModes() === snap1)

    // Without setOpenMode handler, openMode returns false
    assert.equal(registry.openMode('tiers:one-turn'), false)

    // setOpenMode registers handler; unregistered modeKey returns false; registered returns true
    const openedModes: string[] = []
    const relHandler1 = registry.setOpenMode((modeKey) => {
      openedModes.push(`h1:${modeKey}`)
    })
    assert.equal(registry.openMode('missing-mode'), false)
    assert.equal(registry.openMode('tiers:one-turn'), true)
    assert.deepEqual(openedModes, ['h1:tiers:one-turn'])

    // Second handler supersedes first; releasing stale relHandler1 must not clear newer handler
    const relHandler2 = registry.setOpenMode((modeKey) => {
      openedModes.push(`h2:${modeKey}`)
    })
    relHandler1()
    assert.equal(registry.openMode('tiers:one-turn'), true)
    assert.deepEqual(openedModes, ['h1:tiers:one-turn', 'h2:tiers:one-turn'])

    // LIFO stacking on same key + token-safe unregister
    const rel2 = registry.register('tiers:one-turn', {
      label: 'Next turn v2',
      onApply: ({ modelKey }) => {
        applied.push(`second:${modelKey}`)
      },
    })
    assert.equal(listenerCalls, 2)
    assert.equal(registry.getModes()[0]?.spec.label, 'Next turn v2')
    void registry.getModes()[0]?.spec.onApply({ modelKey: 'faux/a', thinkingLevel: '' })
    assert.deepEqual(applied, ['second:faux/a'])

    rel2()
    rel2()
    assert.equal(listenerCalls, 3)
    assert.equal(registry.getModes()[0]?.spec.label, 'Next turn')
    void registry.getModes()[0]?.spec.onApply({ modelKey: 'faux/b', thinkingLevel: 'high' })
    assert.deepEqual(applied, ['second:faux/a', 'first:faux/b'])

    // Releasing active handler disables openMode cleanly
    relHandler2()
    relHandler2()
    assert.equal(registry.openMode('tiers:one-turn'), false)

    // Releasing last registration removes mode cleanly
    rel1()
    assert.equal(listenerCalls, 4)
    assert.equal(registry.has('tiers:one-turn'), false)
    assert.deepEqual(registry.getModes(), [])
  } finally {
    unsub()
  }
})

test('useComposerModelPickerMode: keeps onApply in ref without emit churn, updates on metadata/null changes, and wires openMode', { timeout: 60_000 }, () => {
  const registry = SDK.createComposerModelPickerModeRegistry()
  let emitCount = 0
  const unsub = registry.subscribe(() => {
    emitCount += 1
  })
  const opened: string[] = []
  const relOpen = registry.setOpenMode((modeKey) => {
    opened.push(modeKey)
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const selections: Array<{ tag: string; selection: SDK.ComposerModelPickerModeSelection }> = []
  let latestApi: { openMode: () => boolean } | undefined

  function Probe({
    tag,
    enabled = true,
    effectiveModel,
    activeThinkingLevel,
  }: {
    tag: string
    enabled?: boolean
    effectiveModel?: string
    activeThinkingLevel?: string
  }) {
    latestApi = SDK.useComposerModelPickerMode(
      'tiers:one-turn',
      enabled
        ? {
            id: 'tiers:one-turn',
            label: 'Next turn',
            hint: 'One turn only',
            effectiveModel,
            activeThinkingLevel,
            hideResetDefault: true,
            onApply: (selection) => {
              selections.push({ tag, selection })
            },
          }
        : null,
    )
    return null
  }

  try {
    // Outside Provider: safe no-op and openMode() returns false
    act(() => {
      root.render(e(Probe, { tag: 'outside' }))
    })
    assert.equal(emitCount, 0)
    assert.equal(latestApi?.openMode(), false)

    // Mount inside Provider -> registers once
    act(() => {
      root.render(
        e(
          SDK.ComposerModelPickerModeContext.Provider,
          { value: registry },
          e(Probe, { tag: 'v1', effectiveModel: 'faux/fast', activeThinkingLevel: 'low' }),
        ),
      )
    })
    assert.equal(emitCount, 1)
    assert.equal(registry.has('tiers:one-turn'), true)
    assert.equal(latestApi?.openMode(), true)
    assert.deepEqual(opened, ['tiers:one-turn'])

    // Re-render with NEW onApply closure ONLY (same metadata) -> ZERO emit churn, latest closure invoked
    act(() => {
      root.render(
        e(
          SDK.ComposerModelPickerModeContext.Provider,
          { value: registry },
          e(Probe, { tag: 'v2', effectiveModel: 'faux/fast', activeThinkingLevel: 'low' }),
        ),
      )
    })
    assert.equal(emitCount, 1, 'callback identity change must never trigger emit()')
    void registry.getModes()[0]?.spec.onApply({ modelKey: 'faux/flagship', thinkingLevel: 'high' })
    assert.deepEqual(selections, [{ tag: 'v2', selection: { modelKey: 'faux/flagship', thinkingLevel: 'high' } }])

    // Changing metadata updates registry
    act(() => {
      root.render(
        e(
          SDK.ComposerModelPickerModeContext.Provider,
          { value: registry },
          e(Probe, { tag: 'v3', effectiveModel: 'faux/flagship', activeThinkingLevel: 'high' }),
        ),
      )
    })
    assert.ok(emitCount > 1)
    assert.equal(registry.getModes()[0]?.spec.effectiveModel, 'faux/flagship')
    assert.equal(registry.getModes()[0]?.spec.activeThinkingLevel, 'high')

    // Passing spec = null unregisters cleanly and openMode() returns false
    act(() => {
      root.render(
        e(
          SDK.ComposerModelPickerModeContext.Provider,
          { value: registry },
          e(Probe, { tag: 'v4', enabled: false }),
        ),
      )
    })
    assert.equal(registry.has('tiers:one-turn'), false)
    assert.equal(latestApi?.openMode(), false)

    // Re-enable and unmount -> cleans up
    act(() => {
      root.render(
        e(
          SDK.ComposerModelPickerModeContext.Provider,
          { value: registry },
          e(Probe, { tag: 'v5', effectiveModel: 'faux/workhorse' }),
        ),
      )
    })
    assert.equal(registry.has('tiers:one-turn'), true)
    act(() => {
      root.unmount()
    })
    assert.equal(registry.has('tiers:one-turn'), false)
  } finally {
    relOpen()
    unsub()
    host.remove()
  }
})
