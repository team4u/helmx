import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type {
  AskSpec,
  CallActionOptions,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  TimelineRendererProps,
  ToolViewProps,
} from '@helmx/protocol'
import type { CodeBlockViewProps, MarkdownViewProps, PluginClientHostPort, PluginSessionDocKey } from '@helmx/plugin-client'
import { resetHappyDom } from './dom-harness.js'

const e = React.createElement

export interface SwarmClientComponents {
  SwarmToolView: (p: ToolViewProps) => React.ReactElement
  SwarmActiveTray: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmWorkbenchPanel: (p: { conversation?: ConversationSummary; params?: Readonly<Record<string, unknown>> }) => React.ReactElement
  SwarmBoardReportCard: (p: TimelineRendererProps) => React.ReactElement
  SwarmBoardWakeupCard: (p: TimelineRendererProps) => React.ReactElement
}

export interface ActionCallRecord {
  actionId: string
  input: unknown
  options?: CallActionOptions
}

export interface SpyCtx extends PluginClientContextType {
  drawerCalls: number[]
  workbenchCalls: Array<string | undefined>
  workbenchParamCalls: Array<Record<string, unknown> | undefined>
  actionCalls: ActionCallRecord[]
  notifyCalls: Array<{ message: string; tone?: string }>
}

export function convSummary(
  id: number,
  title: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: 'openai/gpt-5',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

export const DEFAULT_SWARM_CONVERSATIONS: ConversationSummary[] = [
  convSummary(50, '主控协同任务', { tags: ['swarm-coordinator'] }),
  convSummary(51, 'author 工作区', { tags: ['swarm-worker'], status: 'working', doing: 'writing auth module' }),
  convSummary(52, 'verifier 审阅', { tags: ['swarm-worker'] }),
]

export function coordinatorIndexFixture(): Record<string, unknown> {
  return {
    workers: [
      {
        conversationId: 51,
        coordinatorConversationId: 50,
        profileId: 'coder',
        groupId: 'grp-live',
        name: 'author',
        createdAt: 1000,
      },
      {
        conversationId: 52,
        coordinatorConversationId: 50,
        profileId: 'reviewer',
        groupId: 'grp-live',
        name: 'verifier',
        createdAt: 1000,
      },
    ],
    groups: [
      {
        id: 'grp-live',
        title: '协同审改组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 3,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
  }
}

export function boardViewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group: {
      id: 'grp-live',
      title: '协同审改组',
      objective: '零回归完成鉴权改造',
      coordinatorConversationId: 50,
      status: 'active',
      activeWorkerCount: 2,
      headSeq: 3,
      createdAt: Date.now() - 3 * 60_000,
      updatedAt: 2000,
    },
    headline: {
      text: 'author handoff #2 awaiting verifier',
      tone: 'info',
      kind: 'normal',
    },
    members: [
      {
        name: 'author',
        conversationId: 51,
        profileId: 'coder',
        access: 'readwrite',
        isolation: 'worktree',
        nodeId: 'local',
        cwd: '/repo-wt/author',
        worktreeId: 'wt-author-1',
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        lastPostSeq: 2,
        createdAt: 1000,
        liveState: 'done',
        model: 'openai/gpt-5',
      },
      {
        name: 'verifier',
        conversationId: 52,
        profileId: 'reviewer',
        access: 'readonly',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: '/repo',
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 2,
        createdAt: 1000,
        liveState: 'working',
        model: 'anthropic/claude-sonnet-4-5',
      },
    ],
    posts: [
      {
        seq: 1,
        groupId: 'grp-live',
        from: 'coordinator',
        to: ['author'],
        resolvedTargets: ['author'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Implement token refresh in isolated worktree.',
        createdAt: 1100,
      },
      {
        seq: 2,
        groupId: 'grp-live',
        from: 'author',
        to: ['verifier'],
        resolvedTargets: ['verifier'],
        wake: true,
        kind: 'handoff',
        refs: [1],
        body: 'Token refresh implemented, ready for review.',
        worktreeSnapshot: {
          worktreeId: 'wt-author-1',
          branch: 'helmx/author',
          commitsAhead: 2,
          dirtyCount: 1,
          changedFilesPreview: ['src/auth.ts'],
        },
        createdAt: 1500,
      },
    ],
    activeWorkingMembers: ['verifier'],
    ...overrides,
  }
}

export function toolViewProps(overrides: Partial<ToolViewProps> = {}): ToolViewProps {
  return {
    callId: 'call-1',
    toolName: 'swarm_board_post',
    status: 'done',
    conversationId: 50,
    ...overrides,
  }
}

const EMPTY_SESSION_DOC_STATE = Object.freeze({
  hasValue: false,
  deleted: false,
  connected: false,
})

const noopEnsurePluginDoc = async (): Promise<unknown> => undefined
const noopLoadConversationDetail = async (): Promise<void> => {}

export interface SwarmDomHarness {
  rawModule: Record<string, unknown>
  components: SwarmClientComponents
  makeSpyCtx(overrides?: Partial<SpyCtx> & Partial<PluginClientContextType>): SpyCtx
  setStubState(options: {
    docs?: Record<string, unknown>
    sessionDocs?: Record<string, unknown>
    conversationLives?: Record<number, unknown>
    pendingAsks?: unknown[]
    loadErrors?: Record<string, string>
  }): void
  resetDefaultStubs(): void
  mount(
    ctx: PluginClientContextType,
    element: React.ReactElement,
    conversations?: ConversationSummary[],
    options?: { serverNowMs?: number },
  ): Promise<{ host: HTMLElement; unmount: () => void; subscribedSessionKeys: PluginSessionDocKey[] }>
  dispose(): void
}

export async function createSwarmDomHarness(): Promise<SwarmDomHarness> {
  const [
    { createRoot },
    { resolveLocalizedText },
    { MarkdownText, PluginClientContext, PluginClientHostContext },
    { importBuiltinClientModule, mountSharedPluginNamespaces },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@helmx/ui'),
    import('@helmx/plugin-client'),
    import('./builtin-clients.js'),
  ])

  mountSharedPluginNamespaces({ realHooks: true })
  const rawModule = await importBuiltinClientModule('builtin:swarm', 'index.tsx')
  const components: SwarmClientComponents = {
    SwarmToolView: rawModule['SwarmToolView'] as SwarmClientComponents['SwarmToolView'],
    SwarmActiveTray: rawModule['SwarmActiveTray'] as SwarmClientComponents['SwarmActiveTray'],
    SwarmWorkbenchPanel: rawModule['SwarmWorkbenchPanel'] as SwarmClientComponents['SwarmWorkbenchPanel'],
    SwarmBoardReportCard: rawModule['SwarmBoardReportCard'] as SwarmClientComponents['SwarmBoardReportCard'],
    SwarmBoardWakeupCard: rawModule['SwarmBoardWakeupCard'] as SwarmClientComponents['SwarmBoardWakeupCard'],
  }

  let stubDocs: Record<string, unknown> = {}
  let stubSessionStates: Record<string, { value: unknown; hasValue: boolean; deleted: boolean; connected: boolean }> = {}
  let stubConversationLives: Record<number, unknown> = {}
  let stubPendingAsks: unknown[] = []
  let stubLoadErrors: Record<string, string> = {}

  function setStubState(options: {
    docs?: Record<string, unknown>
    sessionDocs?: Record<string, unknown>
    conversationLives?: Record<number, unknown>
    pendingAsks?: unknown[]
    loadErrors?: Record<string, string>
  }): void {
    if (options.docs !== undefined) stubDocs = options.docs
    if (options.sessionDocs !== undefined) {
      const next: typeof stubSessionStates = {}
      for (const [k, v] of Object.entries(options.sessionDocs)) {
        if (v !== undefined) {
          next[k] = { value: v, hasValue: true, deleted: false, connected: true }
        }
      }
      stubSessionStates = next
    }
    if (options.conversationLives !== undefined) stubConversationLives = options.conversationLives
    if (options.pendingAsks !== undefined) stubPendingAsks = options.pendingAsks
    if (options.loadErrors !== undefined) stubLoadErrors = options.loadErrors
  }

  function resetDefaultStubs(): void {
    setStubState({
      docs: {
        index: { workers: [], groups: [] },
        'board-badges': { byConversation: {} },
      },
      sessionDocs: {},
      conversationLives: {},
      pendingAsks: [],
      loadErrors: {},
    })
  }

  resetDefaultStubs()

  let sharedHost: HTMLDivElement | undefined
  let sharedRoot: Root | undefined
  let mountSeq = 0

  function ensureSharedRoot(): { host: HTMLDivElement; root: Root } {
    if (sharedHost === undefined || !sharedHost.isConnected || sharedRoot === undefined) {
      sharedHost = document.createElement('div')
      document.body.appendChild(sharedHost)
      sharedRoot = createRoot(sharedHost)
    }
    return { host: sharedHost, root: sharedRoot }
  }

  function makeSpyCtx(overrides: Partial<SpyCtx> & Partial<PluginClientContextType> = {}): SpyCtx {
    const drawerCalls: number[] = []
    const workbenchCalls: Array<string | undefined> = []
    const workbenchParamCalls: Array<Record<string, unknown> | undefined> = []
    const actionCalls: ActionCallRecord[] = []
    const notifyCalls: Array<{ message: string; tone?: string }> = []
    const locale = overrides.locale ?? 'en'
    const base: PluginClientContextType = {
      pluginId: 'builtin:swarm',
      callAction: async (actionId, input, options) => {
        actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        return {}
      },
      fetchRoute: async () => {
        throw new Error('fetchRoute not implemented in test stub')
      },
      submitInput: async () => {},
      openScreen: () => {},
      openSplitScreen: () => {},
      openConversationDrawer: (id) => {
        drawerCalls.push(id)
      },
      openArtifact: () => {},
      openWorkbench: (panelId, params) => {
        workbenchCalls.push(panelId)
        workbenchParamCalls.push(params)
      },
      closeWorkbench: () => {},
      notify: (message, tone) => {
        notifyCalls.push({ message, tone })
      },
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      conversationId: 1,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, {
      drawerCalls,
      workbenchCalls,
      workbenchParamCalls,
      actionCalls,
      notifyCalls,
      ...overrides,
    })
  }

  async function mount(
    ctx: PluginClientContextType,
    element: React.ReactElement,
    conversations: ConversationSummary[] = DEFAULT_SWARM_CONVERSATIONS,
    options?: { serverNowMs?: number },
  ): Promise<{ host: HTMLElement; unmount: () => void; subscribedSessionKeys: PluginSessionDocKey[] }> {
    const { host, root } = ensureSharedRoot()
    const pluginDocs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(stubDocs)) {
      if (v !== undefined) {
        pluginDocs[`builtin:swarm/${k}`] = v
      }
    }
    const subscribedSessionKeys: PluginSessionDocKey[] = []
    const subscribeSessionDoc = (key: PluginSessionDocKey): (() => void) => {
      subscribedSessionKeys.push(key)
      return () => {}
    }
    const getSessionDocState = (key: PluginSessionDocKey) =>
      stubSessionStates[`${key.pluginId}/${key.docName}/${key.conversationId}`] ?? EMPTY_SESSION_DOC_STATE
    const noopUnsub = () => {}
    const emptyAsks: AskSpec[] = []
    const pluginsSnapshot = { plugins: [], screens: [] }
    const emptySlotItems: ReadonlyArray<never> = []
    const pendingAsksByConv = new Map<number, AskSpec[]>()
    for (const ask of stubPendingAsks as AskSpec[]) {
      const list = pendingAsksByConv.get(ask.conversationId)
      if (list === undefined) pendingAsksByConv.set(ask.conversationId, [ask])
      else list.push(ask)
    }
    const hostPort = {
      getAuthenticated: () => false,
      subscribeAuthenticated: () => noopUnsub,
      getTheme: () => 'dark',
      subscribePrefs: () => noopUnsub,
      getConversations: () => conversations,
      subscribeConversations: () => noopUnsub,
      getConversationSummary: (id: number) => conversations.find((c) => c.id === id),
      subscribeConversationSummary: () => noopUnsub,
      getConversationDetail: () => undefined,
      subscribeConversationDetail: () => noopUnsub,
      getConversationLive: (id: number) => stubConversationLives[id],
      subscribeConversationLive: () => noopUnsub,
      getConversationPendingAsks: (id: number) => pendingAsksByConv.get(id) ?? emptyAsks,
      subscribeConversationPendingAsks: () => noopUnsub,
      getLoadError: (key: string) => stubLoadErrors[key],
      subscribeLoadError: () => noopUnsub,
      getPluginsSnapshot: () => pluginsSnapshot,
      subscribePlugins: () => noopUnsub,
      slots: {
        collectItems: () => emptySlotItems,
        renderItem: () => null,
      },
      getPluginDocValue: (docKey: string) => (Object.hasOwn(pluginDocs, docKey) ? pluginDocs[docKey] : undefined),
      subscribePluginDoc: () => noopUnsub,
      ensurePluginDoc: noopEnsurePluginDoc,
      subscribeSessionDoc,
      getSessionDocState,
      loadConversationDetail: noopLoadConversationDetail,
      markdown: {
        view: ({ text, className, onLinkClick, conversationId }: MarkdownViewProps) =>
          e(
            'div',
            {
              className: className ? `msg-ai-body ${className}` : 'msg-ai-body',
              ...(conversationId !== undefined ? { 'data-md-conv-id': String(conversationId) } : {}),
            },
            e(MarkdownText, { text, onLinkClick }),
          ),
        codeBlock: ({ code }: CodeBlockViewProps) => e('pre', null, code),
      },
      ...(options?.serverNowMs !== undefined ? { getServerNow: () => options.serverNowMs! } : {}),
    } as unknown as PluginClientHostPort

    const renderKey = ++mountSeq
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: hostPort },
          e(
            PluginClientContext.Provider,
            { value: ctx },
            e(React.Fragment, { key: renderKey }, element),
          ),
        ),
      )
    })
    await act(async () => {})
    return {
      host,
      subscribedSessionKeys,
      unmount: () => {
        if (sharedRoot !== undefined) {
          act(() => sharedRoot?.render(null))
        }
      },
    }
  }

  function dispose(): void {
    if (sharedRoot !== undefined) {
      act(() => sharedRoot?.unmount())
      sharedRoot = undefined
    }
    sharedHost?.remove()
    sharedHost = undefined
    resetDefaultStubs()
    resetHappyDom()
  }

  return {
    rawModule,
    components,
    makeSpyCtx,
    setStubState,
    resetDefaultStubs,
    mount,
    dispose,
  }
}
