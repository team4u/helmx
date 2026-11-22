/**
 * Shared test harness for `builtin:workflow` client tests inside `@helmx/plugins/test`:
 * - Registers happy-dom and bridges React / ReactDOM / Lucide / @helmx/plugin-client
 *   onto `CLIENT_SHARED_GLOBALS` so real esbuild-compiled client modules share the host
 *   React & SDK instances without importing `@helmx/web`;
 * - Supports both stub mode (`mountSharedPluginNamespaces()` + `setWorkflowClientStub`)
 *   and real SDK hook mode (`mountSharedPluginNamespaces({ realHooks: true })` +
 *   `createWorkflowHostHarness`), forwarding `useConversation(id, { includeDetail })`
 *   options in both modes.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as ReactTypes from 'react'
import type * as SDKTypes from '@helmx/plugin-client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type {
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
} from '@helmx/protocol'
import type { WorkflowRunSummary } from '../../src/contracts.js'

if (typeof window === 'undefined' || typeof document === 'undefined') {
  try {
    GlobalRegistrator.register()
  } catch {
    // Already registered in this test process.
  }
}

// Import React / ReactDOM / Radix-backed @helmx/plugin-client only AFTER
// GlobalRegistrator registers window & document so Radix Popover's layout/DOM hooks see a real browser environment.
const { CLIENT_SHARED_GLOBALS, compilePluginClientModule } = await import('@helmx/plugin-build')
const SDK = await import('@helmx/plugin-client')

const req = createRequire(new URL('../../../plugin-client/package.json', import.meta.url))
export const React = req('react') as typeof ReactTypes
export const ReactDOM = req('react-dom') as unknown
export const ReactDOMClient = req('react-dom/client') as {
  createRoot: (container: Element) => { render(node: ReactTypes.ReactNode): void; unmount(): void }
}
export const ReactDOMServer = req('react-dom/server') as {
  renderToString: (element: ReactTypes.ReactElement) => string
}
export const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
export const LucideReact = req('lucide-react') as Record<string, unknown>

export const { act } = React
export const { createRoot } = ReactDOMClient
export const { renderToString } = ReactDOMServer
export { SDK }

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKFLOW_CLIENT_ROOT = resolve(HERE, '../../src/workflow/client')
export const WORKFLOW_CLIENT_CACHE_DIR = resolve(HERE, '../../../../node_modules/.cache/helmx-test-workflow-clients')
export const WORKTREE_CLIENT_ROOT = resolve(HERE, '../../src/worktree/client')
export const WORKTREE_CLIENT_CACHE_DIR = resolve(HERE, '../../../../node_modules/.cache/helmx-test-worktree-clients')
mkdirSync(WORKFLOW_CLIENT_CACHE_DIR, { recursive: true })
mkdirSync(WORKTREE_CLIENT_CACHE_DIR, { recursive: true })

export interface WorktreeSlotComponents {
  WorktreeInspectSlot?: ReactTypes.ComponentType<Record<string, unknown>>
  WorktreeCleanupSlot?: ReactTypes.ComponentType<Record<string, unknown>>
}

export interface WorkflowClientStubOptions {
  docValue?: unknown
  conversations?: unknown[]
  conversation?: (id: number | undefined, options?: { includeDetail?: boolean }) => Record<string, unknown>
  worktreeSlots?: WorktreeSlotComponents | false
}

let stub: WorkflowClientStubOptions = {}
let currentHookMode: 'stub' | 'real' = 'stub'
let mountGen = 0

function syncSharedPluginGlobals(realHooks: boolean): void {
  currentHookMode = realHooks ? 'real' : 'stub'
  const g = globalThis as Record<string, unknown>
  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react-dom']!] = ReactDOM
  g[CLIENT_SHARED_GLOBALS['react-dom/client']!] = ReactDOMClient
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] =
    realHooks ? SDK : stubPluginClientNamespace
}

export function setWorkflowClientStub(options: WorkflowClientStubOptions = {}): void {
  stub = options
  syncSharedPluginGlobals(false)
}

const NOOP_RETRY = (): void => {}

const stubPluginClientNamespace = {
  ...SDK,
  usePluginDoc: () => stub.docValue,
  usePluginDocState: () => ({ data: stub.docValue, status: 'ready' as const, retry: NOOP_RETRY }),
  usePluginSessionDoc: () => stub.docValue,
  usePluginSessionDocState: () => ({ data: stub.docValue, status: 'ready' as const, retry: NOOP_RETRY }),
  useConversations: () => stub.conversations ?? [],
  useConversation: (id: number | undefined, options?: { includeDetail?: boolean }) =>
    stub.conversation?.(id, options) ?? {
      summary: undefined,
      detail: undefined,
      live: undefined,
      pendingAsks: [],
      loadError: undefined,
      reload: () => {},
    },
  PluginSlot: (props: SDKTypes.PluginSlotProps) => {
    const slots = stub.worktreeSlots
    if (slots === undefined || slots === false) {
      return props.fallback !== undefined ? React.createElement(React.Fragment, null, props.fallback) : null
    }
    const shortName = props.name.includes('/') ? props.name.slice(props.name.indexOf('/') + 1) : props.name
    const Component =
      shortName === 'worktree-inspect'
        ? slots.WorktreeInspectSlot
        : shortName === 'worktree-cleanup'
          ? slots.WorktreeCleanupSlot
          : undefined
    if (Component === undefined) {
      return props.fallback !== undefined ? React.createElement(React.Fragment, null, props.fallback) : null
    }
    const Container = props.inline === true ? 'span' : 'div'
    const normalizedClassName =
      props.className !== undefined && props.className.trim().length > 0 ? props.className : undefined
    return React.createElement(
      Container,
      {
        className: normalizedClassName,
        style: normalizedClassName === undefined ? { display: 'contents' as const } : undefined,
        'data-helmx-slot': props.name.includes('/') ? props.name : `builtin:workflow/${props.name}`,
      },
      React.createElement(Component, props.slotProps ?? {}),
    )
  },
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  mountGen += 1
  syncSharedPluginGlobals(options.realHooks === true)
}

export const WORKFLOW_SURFACE_MODULES = ['index.tsx'] as const

export async function importWorkflowClientModule(
  moduleRef = 'index.tsx',
  cacheDir = WORKFLOW_CLIENT_CACHE_DIR,
  options?: { realHooks?: boolean; scope?: string },
): Promise<Record<string, unknown>> {
  const mode: 'real' | 'stub' =
    options?.realHooks !== undefined ? (options.realHooks ? 'real' : 'stub') : currentHookMode
  syncSharedPluginGlobals(mode === 'real')
  const { code } = await compilePluginClientModule('builtin:workflow', WORKFLOW_CLIENT_ROOT, moduleRef, cacheDir)
  const fragment = options?.scope ? `${mode}-${mountGen}-${options.scope}` : `${mode}-${mountGen}`
  // Keep #stub and #real (and per-file mountGen / scoped) module instances distinct in Node's ESM cache because
  // compiled bundles destructure @helmx/plugin-client hooks at module load time.
  return (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}#${fragment}`)) as Record<
    string,
    unknown
  >
}

/** Compiles and loads the requested per-surface workflow entry modules independently, merging their component exports. */
export async function importWorkflowSurfaces(
  modules: ReadonlyArray<(typeof WORKFLOW_SURFACE_MODULES)[number]> = WORKFLOW_SURFACE_MODULES,
  cacheDir = WORKFLOW_CLIENT_CACHE_DIR,
  options?: { realHooks?: boolean; scope?: string },
): Promise<Record<string, unknown>> {
  const loaded = await Promise.all(
    modules.map((m) => importWorkflowClientModule(m, cacheDir, options)),
  )
  return Object.assign({}, ...loaded) as Record<string, unknown>
}

export async function importWorkflowModels(
  cacheDir = WORKFLOW_CLIENT_CACHE_DIR,
): Promise<typeof import('../../src/workflow/client/models.ts')> {
  return (await importWorkflowClientModule('models.ts', cacheDir)) as unknown as typeof import('../../src/workflow/client/models.ts')
}

export async function importWorktreeClientModule(
  moduleRef = 'slots.tsx',
  cacheDir = WORKTREE_CLIENT_CACHE_DIR,
  options?: { realHooks?: boolean; scope?: string },
): Promise<Record<string, unknown>> {
  const mode: 'real' | 'stub' =
    options?.realHooks !== undefined ? (options.realHooks ? 'real' : 'stub') : currentHookMode
  syncSharedPluginGlobals(mode === 'real')
  const { code } = await compilePluginClientModule('builtin:worktree', WORKTREE_CLIENT_ROOT, moduleRef, cacheDir)
  const fragment = options?.scope ? `${mode}-${mountGen}-${options.scope}` : `${mode}-${mountGen}`
  return (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}#${fragment}`)) as Record<
    string,
    unknown
  >
}

export async function importWorktreeModels(
  cacheDir = WORKTREE_CLIENT_CACHE_DIR,
): Promise<typeof import('../../src/worktree/client/model-worktree.ts')> {
  return (await importWorktreeClientModule('model-worktree.ts', cacheDir)) as unknown as typeof import('../../src/worktree/client/model-worktree.ts')
}

export function makeConvSummary(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `子会话 ${id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export interface WorkflowHostLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown }>
  drawers: number[]
  workbenchTabs: string[]
  workbenchOpens: boolean[]
  workbenchParams: Array<Record<string, unknown> | undefined>
  screens: string[]
  notices: Array<{ message: string; tone: string }>
  loadDetailCalls: number[]
  activeToolCallIds: Set<string>
}

export function createWorkflowHostHarness(init: {
  conversationId: number
  conversations?: ConversationSummary[]
  conversationDetails?: Record<number, ConversationDetail>
  conversationLives?: Record<number, ConversationLive>
  pendingAsks?: AskSpec[]
  loadErrors?: Record<string, string>
  runsByConversation?: Record<number, WorkflowRunSummary[]>
  pluginDocs?: Record<string, unknown>
  timelineToolCalls?: SDKTypes.TimelineToolCallsInput
  locale?: SDKTypes.HelmxLocale
  worktreeSlots?: WorktreeSlotComponents
  onAction?: (pluginId: string, actionId: string, input: unknown) => Promise<unknown> | unknown
}) {
  const activeToolCallIds = new Set<string>()
  const timelineToolCallsStore = SDK.createTimelineToolCallsStore(init.timelineToolCalls)
  const log: WorkflowHostLog = {
    actions: [],
    drawers: [],
    workbenchTabs: [],
    workbenchOpens: [],
    workbenchParams: [],
    screens: [],
    notices: [],
    loadDetailCalls: [],
    activeToolCallIds,
  }
  let currentConversations = init.conversations ?? [makeConvSummary(init.conversationId, { ownedBy: 'human' })]
  const emptyRuns: WorkflowRunSummary[] = []
  const sessionRuns = new Map<number, WorkflowRunSummary[]>()
  for (const [k, v] of Object.entries(init.runsByConversation ?? {})) {
    sessionRuns.set(Number(k), v)
  }
  const sessionStates = new Map<string, { hasValue: boolean; deleted: boolean; connected: boolean; value: unknown }>()
  const listeners = new Set<() => void>()
  const hostListeners = new Set<() => void>()

  const getState = (key: { pluginId: string; docName: string; conversationId: number }) => {
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    let cur = sessionStates.get(cacheKey)
    if (key.docName === 'runs') {
      const runs = sessionRuns.get(key.conversationId) ?? emptyRuns
      if (cur === undefined || (cur.value as { runs: WorkflowRunSummary[] }).runs !== runs) {
        cur = { hasValue: true, deleted: false, connected: true, value: { runs } }
        sessionStates.set(cacheKey, cur)
      }
      return cur
    }
    if (cur === undefined) {
      cur = { hasValue: true, deleted: false, connected: true, value: undefined }
      sessionStates.set(cacheKey, cur)
    }
    return cur
  }

  const noopUnsub = () => {}
  const emptyAsks: AskSpec[] = []
  const details = init.conversationDetails ?? {}
  const lives = init.conversationLives ?? {}
  const loadErrors = init.loadErrors ?? {}
  const pluginDocs = init.pluginDocs ?? {}
  const pluginsSnapshot = { plugins: [], screens: [] }
  const pendingAsksByConv = new Map<number, AskSpec[]>()
  for (const ask of init.pendingAsks ?? []) {
    const list = pendingAsksByConv.get(ask.conversationId)
    if (list === undefined) pendingAsksByConv.set(ask.conversationId, [ask])
    else list.push(ask)
  }
  const subscribeHost = (listener: () => void): (() => void) => {
    hostListeners.add(listener)
    return () => {
      hostListeners.delete(listener)
    }
  }

  const basePort: SDKTypes.PluginClientHostPort = {
    getAuthenticated: () => true,
    subscribeAuthenticated: () => noopUnsub,
    getTheme: () => 'dark',
    ...(init.locale !== undefined ? { getLocale: () => init.locale! } : {}),
    subscribePrefs: () => noopUnsub,
    getConversations: () => currentConversations,
    subscribeConversations: subscribeHost,
    getConversationSummary: (id) => currentConversations.find((c) => c.id === id),
    subscribeConversationSummary: (_id, listener) => subscribeHost(listener),
    getConversationDetail: (id) => details[id],
    subscribeConversationDetail: () => noopUnsub,
    getConversationLive: (id) => lives[id],
    subscribeConversationLive: () => noopUnsub,
    getConversationPendingAsks: (id) => pendingAsksByConv.get(id) ?? emptyAsks,
    subscribeConversationPendingAsks: () => noopUnsub,
    getLoadError: (key) => loadErrors[key],
    subscribeLoadError: () => noopUnsub,
    getPluginsSnapshot: () => pluginsSnapshot,
    subscribePlugins: () => noopUnsub,
    getPluginDocValue: (docKey) => (Object.hasOwn(pluginDocs, docKey) ? pluginDocs[docKey] : undefined),
    subscribePluginDoc: () => noopUnsub,
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async (_p, _d, convId) => ({ runs: sessionRuns.get(convId) ?? emptyRuns }),
    subscribeSessionDoc: (_key, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSessionDocState: getState,
    invokePluginAction: async (pluginId, actionId, input) => {
      log.actions.push({ pluginId, actionId, input })
      if (init.onAction !== undefined) {
        return await init.onAction(pluginId, actionId, input)
      }
      return { ok: true }
    },
    submitConversationInput: async () => undefined,
    openTarget: (target) => {
      log.screens.push(target)
    },
    openConversationDrawer: (id) => {
      log.drawers.push(id)
    },
    openArtifactPreview: () => undefined,
    openWorkbench: (options) => {
      log.workbenchOpens.push(true)
      if (options?.tab !== undefined) log.workbenchTabs.push(options.tab)
      log.workbenchParams.push(options?.params)
    },
    setWorkbenchOpen: (open) => {
      log.workbenchOpens.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbenchTabs.push(tab)
    },
    notify: (message, tone) => {
      log.notices.push({ message, tone })
    },
    loadConversationDetail: (convId) => {
      log.loadDetailCalls.push(convId)
    },
    slots: {
      collectItems: (qualified) => {
        const ws = init.worktreeSlots
        if (ws === undefined) return []
        if (qualified === 'builtin:workflow/worktree-inspect' && ws.WorktreeInspectSlot !== undefined) {
          return [{ pluginId: 'builtin:worktree', contributionId: 'worktree-inspect', spec: { id: 'worktree-inspect', target: qualified, client: { module: 'slots.tsx', export: 'WorktreeInspectSlot' } } }]
        }
        if (qualified === 'builtin:workflow/worktree-cleanup' && ws.WorktreeCleanupSlot !== undefined) {
          return [{ pluginId: 'builtin:worktree', contributionId: 'worktree-cleanup', spec: { id: 'worktree-cleanup', target: qualified, client: { module: 'slots.tsx', export: 'WorktreeCleanupSlot' } } }]
        }
        return []
      },
      renderItem: (item, options) => {
        const ws = init.worktreeSlots
        const Component =
          item.contributionId === 'worktree-inspect'
            ? ws?.WorktreeInspectSlot
            : item.contributionId === 'worktree-cleanup'
              ? ws?.WorktreeCleanupSlot
              : undefined
        if (Component === undefined) return null
        const worktreeCtx = SDK.createPluginClientContext(basePort, 'builtin:worktree', options.conversationId ?? init.conversationId)
        return React.createElement(
          SDK.PluginClientContext.Provider,
          { value: worktreeCtx },
          React.createElement(Component, options.slotProps ?? {}),
        )
      },
    },
    markdown: {
      view: ({ text }) => React.createElement('div', { 'data-testid': 'markdown-view' }, text),
      codeBlock: ({ code }) => React.createElement('pre', null, code),
    },
  }

  const ctx = SDK.createPluginClientContext(basePort, 'builtin:workflow', init.conversationId)
  const toolActivityRegistry: SDKTypes.ToolActivityRegistry = {
    activeToolCallIds,
    registerActivity: (callId) => {
      activeToolCallIds.add(callId)
      return () => {
        activeToolCallIds.delete(callId)
      }
    },
  }

  function HarnessProvider({ children }: { children?: ReactTypes.ReactNode }) {
    return React.createElement(
      SDK.PluginClientHostContext.Provider,
      { value: basePort },
      React.createElement(
        SDK.PluginClientContext.Provider,
        { value: ctx },
        React.createElement(
          SDK.ToolActivityContext.Provider,
          { value: toolActivityRegistry },
          React.createElement(SDK.TimelineToolCallsContext.Provider, { value: timelineToolCallsStore }, children),
        ),
      ),
    )
  }

  const wrap = (node: ReactTypes.ReactNode): ReactTypes.ReactElement =>
    React.createElement(HarnessProvider, null, node)

  const mountNode = (node: ReactTypes.ReactNode) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(wrap(node))
    })
    return {
      container,
      rerender: (next: ReactTypes.ReactNode) => {
        act(() => {
          root.render(wrap(next))
        })
      },
      unmount: () => {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  const renderSsr = (node: ReactTypes.ReactNode): string => renderToString(wrap(node))

  const setRuns = (conversationId: number, runs: WorkflowRunSummary[]) => {
    sessionRuns.set(conversationId, runs)
    act(() => {
      for (const listener of [...listeners]) listener()
    })
  }

  const setConversations = (conversations: ConversationSummary[]) => {
    currentConversations = conversations
    act(() => {
      for (const listener of [...hostListeners]) listener()
    })
  }

  const setTimelineToolCalls = (next: SDKTypes.TimelineToolCallsInput) => {
    act(() => {
      timelineToolCallsStore.update(next)
    })
  }

  return {
    log,
    port: basePort,
    ctx,
    timelineToolCallsStore,
    mountNode,
    renderSsr,
    setRuns,
    setConversations,
    setTimelineToolCalls,
  }
}
