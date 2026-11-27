/**
 * builtin:swarm 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖（收敛后形态：无独立 BoardScreen，编排心智模型对齐 builtin:workflow）：
 * 1. UI 扩展注册不变量（registerSwarmUi：toolView 覆盖全部 swarm_* 工具且 replaceRow、
 *    COMPOSER_DOCK_SLOT 活动托盘仅主控作用域、workbench.panel 'groups' 仅参与者作用域、
 *    swarm:board-report / swarm:board-wakeup 折叠回执轨迹卡、@ composerCompleter、
 *    零 screen / 零顶栏 action / 零 sidebarItem、双语 LocalizedText、零 Emoji）；
 * 2. SwarmToolView 26px 工具轨迹行：dispatch 完成态点击打开成员会话抽屉、黑板发布行点击
 *    打开协同工作台面板、有目标行右侧 external-link 提示跳转、无法定目标的行不可点
 *    （折叠入口由宿主行首 chevron 提供）、错误态如实展示首行、zh-CN 自然语言；
 * 3. SwarmActiveTray：无活跃事项返回 null；working/blocked 成员渲染 32px HUD（人数、进度、
 *    自然语言动态、时长），展开行点击打开 ConversationDrawer，中止按钮恒为主控动作，
 *    worker 会话即便被直接挂载也返回 null（防御路径，零订阅零渲染）；
 * 4. SwarmWorkbenchPanel：实时 board-view 渲染编排卡（目标、自然状态、成员行点击开抽屉、
 *    最近动态自然 kind 标签、worktree 分支事实），无实时投影时显式 board_status 一次性回退
 *    （失败可重试、不白屏不伪造运行中），完整记录展开按需 board_read；
 * 5. 时间线回执轨迹卡（SwarmBoardReportCard / SwarmBoardWakeupCard）原地折叠展开、MarkdownView 渲染、
 *    截断/空闲补报/阻断默认展开、工作台跳转与偏离默认 wake 轻标签；
 * 6. UI 注册模型、组件交互与实际渲染状态。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import {
  COMPOSER_DOCK_SLOT,
  parseNonEmptyLocalizedText,
  type AskSpec,
  type CallActionOptions,
  type ConversationSummary,
  type HelmxPluginContext,
  type LocalizedText,
  type PluginClientContext as PluginClientContextType,
  type TimelineRendererProps,
  type ToolViewProps,
} from '@helmx/protocol'
import type { CodeBlockViewProps, MarkdownViewProps, PluginClientHostPort, PluginSessionDocKey } from '@helmx/plugin-client'
import {
  boardProgressOf,
  isMemberDelivered,
  parseBoardPost,
  parseBoardReadPosts,
  parseBoardView,
  postDigestLine,
} from '../../plugins/src/swarm/client/board-model.js'
import {
  resolveGroupTimingView,
  resolvePanelMemberTimingView,
  resolvePostTimeDisplay,
  resolveTrayMemberTimingView,
} from '../../plugins/src/swarm/client/model-timing.js'
import { SWARM_WORKBENCH_PANEL_ID } from '../../plugins/src/swarm/client/models.js'
import { registerSwarmUi } from '../../plugins/src/swarm/ui.js'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const { MarkdownText, PluginClientContext, PluginClientHostContext, resolveLocalizedText } = await import('@helmx/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface SwarmClientComponents {
  SwarmToolView: (p: ToolViewProps) => React.ReactElement
  SwarmActiveTray: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmWorkbenchPanel: (p: { conversation?: ConversationSummary; params?: Readonly<Record<string, unknown>> }) => React.ReactElement
  SwarmBoardReportCard: (p: TimelineRendererProps) => React.ReactElement
  SwarmBoardWakeupCard: (p: TimelineRendererProps) => React.ReactElement
}

let rawModule: Record<string, unknown>
let components: SwarmClientComponents
describe("swarm-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    const barrelMod = await importBuiltinClientModule('builtin:swarm', 'index.tsx')
    rawModule = barrelMod
    components = {
      SwarmToolView: barrelMod['SwarmToolView'] as SwarmClientComponents['SwarmToolView'],
      SwarmActiveTray: barrelMod['SwarmActiveTray'] as SwarmClientComponents['SwarmActiveTray'],
      SwarmWorkbenchPanel: barrelMod['SwarmWorkbenchPanel'] as SwarmClientComponents['SwarmWorkbenchPanel'],
      SwarmBoardReportCard: barrelMod['SwarmBoardReportCard'] as SwarmClientComponents['SwarmBoardReportCard'],
      SwarmBoardWakeupCard: barrelMod['SwarmBoardWakeupCard'] as SwarmClientComponents['SwarmBoardWakeupCard'],
    }
  }, { timeout: 60_000 })

  interface ActionCallRecord {
    actionId: string
    input: unknown
    options?: CallActionOptions
  }

  interface SpyCtx extends PluginClientContextType {
    drawerCalls: number[]
    workbenchCalls: Array<string | undefined>
    workbenchParamCalls: Array<Record<string, unknown> | undefined>
    actionCalls: ActionCallRecord[]
    notifyCalls: Array<{ message: string; tone?: string }>
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
      fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
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

  function convSummary(
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

  const DEFAULT_CONVERSATIONS: ConversationSummary[] = [
    convSummary(50, '主控协同任务', { tags: ['swarm-coordinator'] }),
    convSummary(51, 'author 工作区', { tags: ['swarm-worker'], status: 'working', doing: 'writing auth module' }),
    convSummary(52, 'verifier 审阅', { tags: ['swarm-worker'] }),
  ]

  const EMPTY_SESSION_DOC_STATE = Object.freeze({
    hasValue: false,
    deleted: false,
    connected: false,
  })

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

  const noopEnsurePluginDoc = async (): Promise<unknown> => undefined
  const noopLoadConversationDetail = async (): Promise<void> => {}

  async function mount(
    ctx: PluginClientContextType,
    element: React.ReactElement,
    conversations: ConversationSummary[] = DEFAULT_CONVERSATIONS,
    options?: { serverNowMs?: number },
  ): Promise<{ host: HTMLElement; unmount: () => void; subscribedSessionKeys: PluginSessionDocKey[] }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
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
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: hostPort },
          e(PluginClientContext.Provider, { value: ctx }, element),
        ),
      )
    })
    await act(async () => {})
    return {
      host,
      subscribedSessionKeys,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
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

  before(() => {
    resetDefaultStubs()
  }, { timeout: 60_000 })

  function coordinatorIndexFixture(): Record<string, unknown> {
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

  function boardViewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

  function toolViewProps(overrides: Partial<ToolViewProps> = {}): ToolViewProps {
    return {
      callId: 'call-1',
      toolName: 'swarm_board_post',
      status: 'done',
      conversationId: 50,
      ...overrides,
    }
  }

  // ---------------------------------------------------------------------------
  // 1. UI registrations & Fast Refresh contract
  // ---------------------------------------------------------------------------

  test('UI 注册契约：toolView/slot/workbenchPanel/回执/补全源，零 screen 与顶栏 action，双语文案非空且客户端导出仅含组件', { timeout: 60_000 }, () => {
    const recorded: Array<{ method: string; spec: Record<string, unknown> }> = []
    const uiProxy = new Proxy(
      {},
      {
        get(_target, prop: string) {
          return (spec: Record<string, unknown>) => {
            recorded.push({ method: prop, spec })
          }
        },
      },
    )
    registerSwarmUi({ ui: uiProxy } as unknown as HelmxPluginContext)

    const toolViews = recorded.filter((r) => r.method === 'toolView')
    assert.equal(toolViews.length, 1, '仅注册一个统一 toolView')
    const toolViewSpec = toolViews[0]!.spec
    assert.equal(toolViewSpec['replaceRow'], true, '必须整行替换默认工具轨迹行')
    assert.deepEqual(
      [...(toolViewSpec['toolNames'] as string[])].sort(),
      [
        'swarm_abort_worker',
        'swarm_archive_worker',
        'swarm_board_post',
        'swarm_board_read',
        'swarm_board_status',
        'swarm_close_group',
        'swarm_create_group',
        'swarm_dispatch_worker',
        'swarm_inspect_worker',
        'swarm_switch_worker_model',
        'swarm_update_group',
      ],
      '覆盖当前全部 swarm_* 模型工具',
    )

    const slots = recorded.filter((r) => r.method === 'slot')
    assert.deepEqual(
      slots.map((s) => ({ target: s.spec['target'], scope: s.spec['scope'] })),
      [{ target: COMPOSER_DOCK_SLOT, scope: { tags: ['swarm-coordinator'] } }],
      'COMPOSER_DOCK_SLOT 活动托盘仅对主控会话挂载',
    )

    const panels = recorded.filter((r) => r.method === 'workbenchPanel').map((r) => r.spec)
    assert.equal(panels.length, 1, '仅注册一个会话作用域工作台面板')
    assert.equal(panels[0]!['id'], 'groups')
    assert.deepEqual(
      panels[0]!['scope'],
      { tags: ['swarm-coordinator', 'swarm-coordinator-archived', 'swarm-worker', 'swarm-worker-archived'] },
      '普通会话不出现该 Tab；结单历史主控与已归档成员仍可访问历史编组',
    )
    assert.deepEqual(panels[0]!['badge'], { doc: 'board-badges', byConversationField: 'byConversation' })
    assert.equal(SWARM_WORKBENCH_PANEL_ID, 'groups', '客户端短面板 ID 与注册 id 锁定一致')

    assert.equal(recorded.filter((r) => r.method === 'screen').length, 0, '删除独立全屏 Board 控制台')
    assert.equal(recorded.filter((r) => r.method === 'action').length, 0, '删除顶栏独立 board action 入口')
    assert.equal(recorded.filter((r) => r.method === 'sidebarItem').length, 0, '不注册侧边栏入口')
    assert.equal(recorded.filter((r) => r.method === 'command').length, 0, '不注册 ui.command')

    const renderers = recorded
      .filter((r) => r.method === 'timelineRenderer')
      .map((r) => (r.spec['matchMeta'] as { renderer: string }).renderer)
    assert.deepEqual(renderers, ['swarm:board-report', 'swarm:board-wakeup'], '后端仍写入的回执行保留极简渲染器')

    const completers = recorded.filter((r) => r.method === 'composerCompleter').map((r) => ({
      id: r.spec['id'],
      trigger: r.spec['trigger'],
      source: r.spec['source'],
    }))
    assert.deepEqual(completers, [
      { id: 'swarm-board-members', trigger: '@', source: { kind: 'action', actionId: 'complete_board_members' } },
    ])

    for (const { method, spec } of recorded) {
      for (const field of ['label', 'title', 'description'] as const) {
        if (spec[field] !== undefined) {
          const parsed = parseNonEmptyLocalizedText(spec[field] as LocalizedText)
          assert.notEqual(parsed, undefined, `${method}#${String(spec['id'])}.${field} 必须是非空双语 LocalizedText`)
          const map = spec[field] as Record<string, string>
          assert.ok((map['en'] ?? '').trim().length > 0)
          assert.ok((map['zh-CN'] ?? '').trim().length > 0)
          assert.equal(EMOJI_RE.test(map['en'] ?? ''), false)
          assert.equal(EMOJI_RE.test(map['zh-CN'] ?? ''), false)
        }
      }
    }

    // Fast Refresh：编译产物模块除 __helmxClientCss 外全部为大写开头的组件函数
    for (const [exportName, value] of Object.entries(rawModule)) {
      if (exportName === '__helmxClientCss') continue
      assert.match(exportName, /^[A-Z]/, `client 入口导出必须为 PascalCase 组件：${exportName}`)
      assert.equal(typeof value, 'function', `导出 ${exportName} 必须为组件函数`)
    }
  })

  // ---------------------------------------------------------------------------
  // 2. SwarmToolView trace rows
  // ---------------------------------------------------------------------------

  test('SwarmToolView：dispatch 完成态点击打开成员会话抽屉，黑板发布行打开工作台面板，有目标行右侧 external-link，无目标行不可点', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 50 })

    // dispatch_worker done：读取 presentationMeta 中的 workerConversationId，点击打开子会话抽屉
    const dispatchMount = await mount(
      spy,
      e(components.SwarmToolView, toolViewProps({
        toolName: 'swarm_dispatch_worker',
        input: { name: 'author', prompt: 'Implement token refresh in isolated worktree and post handoff when done' },
        result: 'Dispatched @author (#51) in group grp-live, brief=#1.',
        presentationMeta: { workerConversationId: 51, groupId: 'grp-live', memberName: 'author', seq: 1 },
        durationMs: 4200,
      })),
    )
    try {
      const text = dispatchMount.host.textContent ?? ''
      assert.match(text, /Dispatch member/, '自然语言工具名')
      assert.match(text, /@author/, '成员名摘要')
      assert.match(text, /#1/, 'presentationMeta.seq 徽标')
      assert.match(text, /Implement token refresh/, '派工任务摘要')
      assert.equal(dispatchMount.host.querySelector('button.sw-trace-row-btn') !== null, true)
      const dispatchLink = dispatchMount.host.querySelector('.trace-row-right .trace-row-link')
      assert.ok(dispatchLink?.classList.contains('lucide-external-link') === true, '成员目标行右侧为 external-link 跳转提示')
      assert.ok(dispatchMount.host.querySelector('.trace-row-right .trace-row-chevron') === null, '右侧不再出现 chevron')
      await act(async () => {
        dispatchMount.host.querySelector<HTMLButtonElement>('button.sw-trace-row-btn')!.click()
      })
      assert.deepEqual(spy.drawerCalls, [51], '点击打开成员会话抽屉')
      assert.equal(spy.workbenchCalls.length, 0, '成员行不打开工作台')
    } finally {
      dispatchMount.unmount()
    }

    // props.result JSON string is NEVER parsed when presentationMeta is absent
    const jsonOnlyMount = await mount(
      spy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-json-only',
        toolName: 'swarm_dispatch_worker',
        input: { name: 'author', prompt: 'Implement auth' },
        result: JSON.stringify({ workerConversationId: 99, groupId: 'grp-json', name: 'author', postSeq: 8 }),
      })),
    )
    try {
      assert.doesNotMatch(jsonOnlyMount.host.textContent ?? '', /#8/, '无 presentationMeta 时不解析 result 中的 postSeq')
      const staticRow = jsonOnlyMount.host.querySelector<HTMLElement>('.trace-row.sw-trace-row')
      assert.ok(staticRow !== null, '无目标行仍渲染 26px .trace-row')
      assert.equal(staticRow!.tagName, 'DIV', '无目标行是非交互元素，不是 button')
      assert.equal(staticRow!.getAttribute('role'), null, '无目标行不声明 role=button')
      assert.equal(staticRow!.getAttribute('aria-expanded'), null, '无目标行不声明 aria-expanded')
      assert.equal(staticRow!.getAttribute('aria-controls'), null, '无目标行不声明 aria-controls')
      assert.ok(staticRow!.querySelector('.trace-row-link') === null, '无目标行右侧无跳转提示')
      assert.ok(jsonOnlyMount.host.querySelector('.trace-row-chevron') === null, '插件行自身不渲染折叠 chevron（由宿主行首提供）')
      assert.ok(jsonOnlyMount.host.querySelector('details.tool-call-details') === null, '不再内嵌 ToolCallDetails 展开块')
      await act(async () => {
        staticRow!.click()
      })
      assert.deepEqual(spy.drawerCalls, [51], '点击不可点行绝不解析 result.workerConversationId #99 并打开抽屉')
      assert.ok(jsonOnlyMount.host.querySelector('details.tool-call-details') === null, '点击后也不伪造展开体')
    } finally {
      jsonOnlyMount.unmount()
    }

    // 0-count / boolean / retainedCount presentationMeta 格式化边界
    for (const [props, expected] of [
      [
        toolViewProps({
          callId: 'call-read0',
          toolName: 'swarm_board_read',
          presentationMeta: { groupId: 'grp-live', seq: 0, postCount: 0 },
        }),
        /0 posts/,
      ],
      [
        toolViewProps({
          callId: 'call-abort-noop',
          toolName: 'swarm_abort_worker',
          presentationMeta: { workerConversationId: 51, memberName: 'author', aborted: false },
        }),
        /not running/,
      ],
      [
        toolViewProps({
          callId: 'call-close-retained',
          toolName: 'swarm_close_group',
          presentationMeta: { groupId: 'grp-live', retainedCount: 2 },
        }),
        /2 branches kept for merge/,
      ],
    ] as const) {
      const m = await mount(spy, e(components.SwarmToolView, props))
      try {
        assert.match(m.host.textContent ?? '', expected)
      } finally {
        m.unmount()
      }
    }

    // swarm_board_post done：编组级动作点击打开协同工作台面板
    const postMount = await mount(
      spy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-2',
        toolName: 'swarm_board_post',
        input: { to: ['verifier'], kind: 'handoff', body: 'Token refresh implemented, ready for review.' },
        result: 'Posted #2 [handoff] -> verifier (wake=true).',
        presentationMeta: { groupId: 'grp-live', postKind: 'handoff', seq: 2 },
      })),
    )
    try {
      const text = postMount.host.textContent ?? ''
      assert.match(text, /Handoff/, 'kind 映射为自然语言动词')
      assert.match(text, /-> @verifier/, '目标自然化')
      assert.match(text, /ready for review/, '正文摘要')
      assert.match(text, /#2/, '#seq 仅作辅助信息')
      assert.ok(postMount.host.querySelector('.trace-row-right .trace-row-link.lucide-external-link') !== null, '编组目标行右侧同样为 external-link')
      await act(async () => {
        postMount.host.querySelector<HTMLButtonElement>('button.sw-trace-row-btn')!.click()
      })
      assert.deepEqual(spy.workbenchCalls, ['groups'], '编组级行打开协同工作台面板（短本地 panelId）')
      assert.deepEqual(spy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 2 }], '携带聚焦参数 groupId/postSeq')
    } finally {
      postMount.unmount()
    }

    // 运行中的 abort_worker（无法确定目标）：行不可点、不伪造目标，也不内嵌调用详情
    const runningMount = await mount(
      spy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-3',
        toolName: 'swarm_abort_worker',
        input: { groupId: 'grp-live', name: 'someone-new' },
        status: 'running',
        startedAt: 1000,
      })),
    )
    try {
      const staticRow = runningMount.host.querySelector<HTMLElement>('.trace-row.sw-trace-row')
      assert.ok(staticRow !== null && staticRow!.tagName === 'DIV', '未知目标行渲染为非交互 div')
      assert.equal(staticRow!.getAttribute('aria-expanded'), null, '不声明折叠语义')
      assert.match(runningMount.host.textContent ?? '', /Abort member/, '标题与摘要照常展示')
      assert.ok(runningMount.host.querySelector('button.trace-row') === null, '整行不存在可点按钮')
      await act(async () => {
        staticRow!.click()
      })
      assert.ok(runningMount.host.querySelector('details.tool-call-details') === null, '点击不展开任何内嵌详情（入口由宿主行首 chevron 提供）')
      assert.deepEqual(spy.drawerCalls, [51], '未新增抽屉调用（未伪造目标）')
      assert.equal(spy.workbenchCalls.length, 1, '未新增工作台调用')
    } finally {
      runningMount.unmount()
    }

    assert.deepEqual(
      spy.actionCalls.map((c) => c.actionId),
      [],
      '纯展示行不触发任何动作',
    )
  })

  test('SwarmToolView：错误态如实展示错误首行与状态灯，zh-CN 显示自然中文摘要', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 50 })
    const errMount = await mount(
      spy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-e1',
        toolName: 'swarm_close_group',
        input: { groupId: 'grp-live' },
        status: 'error',
        result: 'swarm_worktree_unmerged: author worktree has 3 unmerged commits\nresolve or keepWorktree',
      })),
    )
    try {
      const text = errMount.host.textContent ?? ''
      assert.match(text, /Close swarm group/)
      assert.match(text, /swarm_worktree_unmerged: author worktree has 3 unmerged commits/, '错误首行原样呈现')
      assert.equal(errMount.host.querySelector('.trace-row-error') !== null, true, '错误行样式')
      assert.equal(errMount.host.querySelectorAll('.helmx-status-light').length, 1, '主状态灯唯一')
    } finally {
      errMount.unmount()
    }

    const zhSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const zhMount = await mount(
      zhSpy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-e2',
        toolName: 'swarm_board_post',
        input: { to: ['coordinator'], kind: 'blocker', body: '集成环境不可用，等待基础设施恢复。' },
      })),
      DEFAULT_CONVERSATIONS,
    )
    try {
      const text = zhMount.host.textContent ?? ''
      assert.match(text, /黑板发布/, 'zh-CN 工具名')
      assert.match(text, /受阻/, 'kind 自然语言动词')
    } finally {
      zhMount.unmount()
    }
  })

  // ---------------------------------------------------------------------------
  // 3. SwarmActiveTray
  // ---------------------------------------------------------------------------

  test('SwarmActiveTray：无活跃事项返回 null；working/blocked 成员渲染 HUD 与可展开行，主控视角对两者均可中止', { timeout: 60_000 }, async () => {
    // 无 board-view 投影：不渲染任何内容（0px 占位）
    setStubState({ docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } } })
    const idleSpy = makeSpyCtx({ conversationId: 50 })
    const idleMount = await mount(idleSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(idleMount.host.textContent ?? '', '', '无实时投影时返回 null')
    } finally {
      idleMount.unmount()
    }

    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
    })

    // 主控视角：HUD + 展开行 + working 成员可中止
    const coordSpy = makeSpyCtx({ conversationId: 50 })
    const coordMount = await mount(
      coordSpy,
      e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = coordMount.host.textContent ?? ''
      assert.match(text, /1 working/, 'working 计数')
      assert.match(text, /1\/2 delivered/, '进度')
      assert.match(text, /handoff/i, '自然语言动态')
      const toggle = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggle.click()
      })
      const row = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-main')!
      assert.match(coordMount.host.textContent ?? '', /@verifier/, '展开显示在途成员')
      assert.match(coordMount.host.textContent ?? '', /#52/, '会话编号辅助信息')
      await act(async () => {
        row.click()
      })
      assert.deepEqual(coordSpy.drawerCalls, [52], '成员行打开 ConversationDrawer')
      const abortBtn = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
      assert.ok(abortBtn !== null, '主控视角对运行中成员提供真实中止动作')
      assert.equal(abortBtn.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        coordSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
        '中止走 abort_worker 动作',
      )
    } finally {
      coordMount.unmount()
    }

    // Worker 视角：即便编组在飞且 board-view 有实时投影，worker 会话直接挂载也返回 null
    //（防御路径：组件自身强制主控身份，内层订阅组件不挂载，零渲染）
    const workerSpy = makeSpyCtx({ conversationId: 51 })
    const workerMount = await mount(
      workerSpy,
      e(components.SwarmActiveTray, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.equal(workerMount.host.textContent ?? '', '', 'Worker 会话直接挂载返回 null（0px 占位）')
      assert.ok(workerMount.host.querySelector('.sw-tray') === null, 'Worker 会话不渲染组级 HUD')
      assert.ok(workerMount.host.querySelector('.sw-tray-workbench') === null, 'Worker 会话不渲染托盘工作台入口')
      assert.deepEqual(workerMount.subscribedSessionKeys, [], 'Worker 会话直接挂载不建立任何 board-view sessionDoc 订阅')
    } finally {
      workerMount.unmount()
    }

    // 回归：blocked 成员对主控同样可中止（后端 abortWorker 支持 working 与 blocked）
    const blockedFixture = boardViewFixture()
    ;(blockedFixture.members as Array<{ liveState: string }>)[1]!.liveState = 'blocked'
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': blockedFixture },
    })
    const blockedSpy = makeSpyCtx({ conversationId: 50 })
    const blockedMount = await mount(
      blockedSpy,
      e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const blockedText = blockedMount.host.textContent ?? ''
      assert.match(blockedText, /1 blocked/, 'blocked 计数')
      const toggle = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      await act(async () => {
        toggle.click()
      })
      const abortBtn = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
      assert.ok(abortBtn !== null, '主控视角对 blocked 成员同样提供中止动作')
      assert.equal(abortBtn.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        blockedSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
        'blocked 成员中止同样走 abort_worker',
      )
    } finally {
      blockedMount.unmount()
    }

    // 全员静默（无 working/blocked）：托盘消失
    const quietFixture = boardViewFixture()
    for (const m of (quietFixture.members as Array<{ liveState: string }>).slice(1)) m.liveState = 'idle'
    ;(quietFixture.members as Array<{ liveState: string }>)[0]!.liveState = 'idle'
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': quietFixture },
    })
    const quietSpy = makeSpyCtx({ conversationId: 50 })
    const quietMount = await mount(quietSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(quietMount.host.textContent ?? '', '', '无在途成员时返回 null')
    } finally {
      quietMount.unmount()
    }

    // 组已结单：即使投影残留也不显示
    const closedFixture = boardViewFixture()
    ;(closedFixture.group as { status: string }).status = 'closed'
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': closedFixture },
    })
    const closedSpy = makeSpyCtx({ conversationId: 50 })
    const closedMount = await mount(closedSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(closedMount.host.textContent ?? '', '', '结单组不渲染托盘')
    } finally {
      closedMount.unmount()
    }

    resetDefaultStubs()
  })

  test('SwarmActiveTray：12 名并发成员展开后全量渲染、耗时右置且第 12 名成员可跳转与中止', { timeout: 60_000 }, async () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 95_000
    const members = Array.from({ length: 12 }, (_, idx) => {
      const n = String(idx + 1).padStart(2, '0')
      const isBlocked = idx === 0
      return {
        name: `worker-${n}`,
        conversationId: 101 + idx,
        profileId: 'coder',
        access: 'readwrite',
        isolation: 'worktree',
        nodeId: 'local',
        cwd: `/repo-wt/worker-${n}`,
        worktreeId: `local:/repo-wt/worker-${n}`,
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        createdAt: T0 + idx * 1_000,
        liveState: isBlocked ? 'blocked' : 'working',
        runStartedAt: NOW - (idx + 5) * 1_000,
        ...(isBlocked ? { pendingAskSince: NOW - 15_000 } : {}),
        turnCount: 0,
      }
    })
    const conversations = [
      convSummary(50, '主控', { tags: ['swarm-coordinator'] }),
      ...members.map((m, idx) =>
        convSummary(m.conversationId, m.name, {
          tags: ['swarm-worker'],
          status: idx === 0 ? 'blocked' : 'working',
          doing: `handling slice ${idx + 1}`,
          runStartedAt: m.runStartedAt,
          ...(idx === 0 ? { pendingAskCount: 1, pendingAskSince: NOW - 15_000 } : {}),
        }),
      ),
    ]
    const twelveBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '12 并发协同组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 12,
        headSeq: 1,
        createdAt: T0,
        updatedAt: NOW,
      },
      members,
      posts: [],
      activeWorkingMembers: members.map((m) => m.name),
    })

    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': twelveBoard },
    })

    const traySpy = makeSpyCtx({ conversationId: 50 })
    const trayMount = await mount(
      traySpy,
      e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      conversations,
      { serverNowMs: NOW },
    )
    try {
      const toggle = trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      await act(async () => {
        toggle.click()
      })

      const rows = [...trayMount.host.querySelectorAll<HTMLElement>('.sw-tray-row')]
      assert.equal(rows.length, 12, '展开后应渲染全部 12 名并发成员')

      for (const row of rows) {
        const main = row.querySelector<HTMLElement>('.sw-tray-row-main')
        const liveEl = main?.querySelector<HTMLElement>('.sw-tray-row-live') ?? null
        const elapsedEl = main?.querySelector<HTMLElement>('.sw-tray-row-elapsed') ?? null
        const abortBtn = row.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
        assert.ok(main !== null, '每行均渲染 .sw-tray-row-main')
        assert.ok(liveEl !== null, '每行均渲染 .sw-tray-row-live')
        assert.ok(elapsedEl !== null, '每行均渲染 .sw-tray-row-elapsed')
        assert.ok(abortBtn !== null, '每行均渲染轻量中止图标按钮')
        const children = [...main.children]
        const liveIdx = children.findIndex((el) => el.classList.contains('sw-tray-row-live'))
        const elapsedIdx = children.findIndex((el) => el.classList.contains('sw-tray-row-elapsed'))
        assert.ok(liveIdx >= 0 && elapsedIdx > liveIdx, '耗时元素必须位于实时动态之后')
      }

      const twelfthRow = rows[11]!
      assert.match(twelfthRow.textContent ?? '', /@worker-12/, '第 12 行为 worker-12')
      await act(async () => {
        twelfthRow.querySelector<HTMLButtonElement>('.sw-tray-row-main')!.click()
      })
      assert.deepEqual(traySpy.drawerCalls, [112], '点击第 12 行应打开对应子会话抽屉')

      const twelfthAbort = twelfthRow.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')!
      assert.equal(twelfthAbort.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        twelfthAbort.click()
      })
      assert.deepEqual(
        traySpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'worker-12' } }],
        '点击第 12 行中止图标应触发 worker-12 的 abort_worker',
      )
    } finally {
      trayMount.unmount()
      resetDefaultStubs()
    }
  })

  // ---------------------------------------------------------------------------
  // 4. SwarmWorkbenchPanel
  // ---------------------------------------------------------------------------

  test('SwarmWorkbenchPanel：实时 board-view 编排卡（成员行开抽屉、自然 kind、worktree 事实），Worker 会话同视图', { timeout: 60_000 }, async () => {
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
    })
    const spy = makeSpyCtx({ conversationId: 50 })
    const mountPanel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = mountPanel.host.textContent ?? ''
      assert.match(text, /协同审改组/, '编组标题')
      assert.match(text, /零回归完成鉴权改造/, '协同目标')
      assert.match(text, /In progress/, '自然状态标签')
      assert.match(text, /Handoff/, '动态 kind 自然语言')
      assert.match(text, /helmx\/author/, 'worktree 分支事实')
      assert.match(text, /#2/, '#seq 辅助信息')
      assert.equal(mountPanel.host.querySelector('.sw-panel-fallback-note') !== null, false, '实时模式不标注快照来源')

      const memberRow = mountPanel.host.querySelector<HTMLButtonElement>('.sw-panel-member-row')!
      await act(async () => {
        memberRow.click()
      })
      assert.deepEqual(spy.drawerCalls, [52], '排序后首个成员（verifier 排前）点击打开抽屉')
      assert.deepEqual(spy.actionCalls, [], '纯实时投影不触发动作调用')
    } finally {
      mountPanel.unmount()
    }

    // Worker 会话展示同一事实视图（board-view 以主控会话键控）
    const workerSpy = makeSpyCtx({ conversationId: 51 })
    const workerPanel = await mount(
      workerSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.match(workerPanel.host.textContent ?? '', /协同审改组/, 'Worker 看到所属编组同一视图')
    } finally {
      workerPanel.unmount()
    }

    // 结单历史主控（swarm-coordinator-archived）经 board_status 回退仍能看到已完成编排卡
    const closedIndex2 = coordinatorIndexFixture()
    ;((closedIndex2.groups as Array<{ status: string }>)[0]!).status = 'closed'
    const closedBoard2 = boardViewFixture()
    ;(closedBoard2.group as { status: string }).status = 'closed'
    setStubState({ docs: { index: closedIndex2, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
    const archivedSpy = makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        if (actionId === 'board_status') return closedBoard2
        return {}
      },
    })
    const archivedPanel = await mount(
      archivedSpy,
      e(components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] }),
      }),
    )
    try {
      const text = archivedPanel.host.textContent ?? ''
      assert.match(text, /Completed/, '历史主控看到已完成编排卡')
      assert.match(text, /协同审改组/)
    } finally {
      archivedPanel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：看板帖子正文按 Markdown 渲染，长帖折叠预览切片同样渲染且展开显示全文', { timeout: 60_000 }, async () => {
    const board = boardViewFixture()
    const posts = board.posts as Array<{ body: string }>
    // seq1 短帖：粗体 + 行内代码（不折叠，全文 Markdown）
    posts[0]!.body = 'Implement **token refresh** in `src/auth.ts`.'
    // seq2 长帖（>8 行触发折叠）：首行即 Markdown，尾部放折叠态不可见标记
    posts[1]!.body = [
      'Token refresh **implemented**, see `src/auth.ts`:',
      '',
      '- 刷新令牌轮转',
      '- 过期容错与重试',
      '- 审计日志补齐',
      '- 并发场景回归',
      'TAIL_MARKER_UNCOLLAPSED_ONLY',
      '- 文档同步',
      '- 变更摘要归档',
      'END_OF_LONG_POST',
    ].join('\n')
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })
    const spy = makeSpyCtx({ conversationId: 50 })
    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const bodyHosts = [...panel.host.querySelectorAll<HTMLElement>('.sw-panel-post-text')]
      assert.ok(bodyHosts.length === 2, '两个帖子的正文容器')

      // 短帖全文渲染为 Markdown 元素，不再出现字面 ** 反引号语法
      const shortBody = bodyHosts[0]!
      assert.ok(shortBody.querySelector('strong') !== null, '粗体渲染为 strong 元素')
      assert.ok(shortBody.querySelector('code') !== null, '行内代码渲染为 code 元素')
      assert.ok((shortBody.textContent ?? '').includes('**') === false, '正文无字面 ** 语法残留')

      // 长帖折叠态：预览切片同样按 Markdown 渲染，尾部内容与折叠标记不出现在正文
      const longBody = bodyHosts[1]!
      assert.ok(longBody.querySelector('strong') !== null, '折叠预览切片同样按 Markdown 渲染')
      assert.ok(longBody.querySelector('code') !== null, '折叠预览切片渲染行内代码')
      assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === false, '折叠态不显示尾部内容')
      assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === false, '折叠态不显示末行')

      // 展开后显示完整正文（含尾部标记），收展按钮语义保持
      const toggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-post-toggle')
      assert.ok(toggle !== null, '长帖存在收展按钮')
      assert.ok(toggle.getAttribute('aria-expanded') === 'false', '初始折叠')
      await act(async () => {
        toggle.click()
      })
      assert.ok(toggle.getAttribute('aria-expanded') === 'true', '点击后展开')
      assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === true, '展开后显示尾部内容')
      assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === true, '展开后显示末行')
    } finally {
      panel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：无实时投影时显式 board_status 回退（含错误重试与完整记录 board_read），空态只读引导', { timeout: 60_000 }, async () => {
    // closed 历史组（index 仍登记）：无 board-view 投影，走一次性 board_status
    const closedIndex = coordinatorIndexFixture()
    ;((closedIndex.groups as Array<{ status: string }>)[0]!).status = 'closed'
    const closedBoard = boardViewFixture()
    ;((closedBoard.group as { status: string })).status = 'closed'
    ;(closedBoard.group as { retainedWorktrees?: unknown[] }).retainedWorktrees = [
      { memberName: 'author', nodeId: 'local', worktreeId: 'wt-author-1', branch: 'helmx/author', path: '/repo-wt/author', commitsAhead: 2 },
    ]
    setStubState({ docs: { index: closedIndex, 'board-badges': { byConversation: {} } } })

    const actionLog: string[] = []
    const spy = makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        actionLog.push(actionId)
        if (actionId === 'board_status') return closedBoard
        if (actionId === 'board_read') {
          return { groupId: 'grp-live', headSeq: 3, posts: (closedBoard as { posts: unknown[] }).posts }
        }
        return {}
      },
    })
    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = panel.host.textContent ?? ''
      assert.match(text, /Completed/, '结单自然状态')
      assert.match(text, /snapshot/i, '标注一次性快照来源')
      assert.match(text, /helmx\/author/, '保留待合入分支清单')
      assert.deepEqual(
        spy.actionCalls.map((c) => c.actionId).concat(actionLog),
        ['board_status'],
        '回退仅调用一次 board_status',
      )

      const historyToggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!
      await act(async () => {
        historyToggle.click()
      })
      assert.deepEqual(
        actionLog,
        ['board_status', 'board_read'],
        '展开完整记录按需 board_read',
      )
    } finally {
      panel.unmount()
    }

    // board_status 失败：显式错误 + Retry，不白屏不伪造运行中
    const failSpy = makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        if (actionId === 'board_status') throw new Error('group store offline')
        return {}
      },
    })
    const failPanel = await mount(
      failSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = failPanel.host.textContent ?? ''
      assert.match(text, /Failed to load swarm group status/)
      assert.match(text, /group store offline/, '错误原文如实')
      assert.equal(failPanel.host.textContent?.includes('In progress'), false, '不伪造运行中')
      const retryBtn = failPanel.host.querySelector<HTMLButtonElement>('.sw-panel .btn')
      assert.ok(retryBtn !== null, '提供重试')
    } finally {
      failPanel.unmount()
    }

    // 普通会话（无 link）：只读空态引导
    const emptySpy = makeSpyCtx({ conversationId: 99 })
    const emptyPanel = await mount(
      emptySpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(99, '普通会话') }),
    )
    try {
      const text = emptyPanel.host.textContent ?? ''
      assert.match(text, /No swarm group in this conversation/)
      assert.match(text, /\/skill:swarm/)
    } finally {
      emptyPanel.unmount()
    }
    resetDefaultStubs()
  })

  // ---------------------------------------------------------------------------
  // 5. Timeline receipt trace cards & non-default wake badges
  // ---------------------------------------------------------------------------

  test('SwarmBoardReportCard：26px 单行轨迹与左侧 chevron 原地折叠展开、MarkdownView 渲染、活跃成员页脚与右侧跳转工作台', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 50 })
    const reportMount = await mount(
      spy,
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-10',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_010_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 5,
              toSeq: 5,
              postCount: 1,
              activeWorkingMembers: ['slow'],
              posts: [
                {
                  seq: 5,
                  from: 'fast',
                  to: ['coordinator'],
                  kind: 'done',
                  wake: true,
                  refs: [2],
                  body: '**Fast slice** ready with `auth.ts` patch.',
                  worktreeSnapshot: {
                    worktreeId: 'wt-fast',
                    branch: 'helmx/fast',
                    commitsAhead: 1,
                    dirtyCount: 0,
                    changedFilesPreview: ['src/auth.ts'],
                  },
                  createdAt: 1_700_000_009_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = reportMount.host.textContent ?? ''
      assert.match(headerText, /Board message/, '使用标准看板消息标题')
      assert.doesNotMatch(headerText, /Swarm report|协同汇总/, '淘汰旧协同汇总文案')
      assert.match(headerText, /Delivered/, '展示触发帖 kind 徽章')
      assert.match(headerText, /@fast/, '展示发帖人')
      assert.match(headerText, /Fast slice/, '展示首行摘要')
      assert.match(headerText, /#5/, '展示序号徽章')
      assert.doesNotMatch(headerText, /Still working/, '折叠态不展示活跃成员页脚')
      assert.ok(reportMount.host.querySelector('.sw-receipt-pill') === null, '已淘汰旧 .sw-receipt-pill')
      assert.ok(reportMount.host.querySelector('.trace-entry-error') === null, 'done 卡片不挂错误态')

      const toggleBtn = reportMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.ok(toggleBtn !== null, '左侧存在折叠按钮')
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false', '默认折叠')
      const firstSvg = toggleBtn.firstElementChild
      assert.ok(firstSvg !== null && firstSvg.classList.contains('trace-row-chevron') && firstSvg.classList.contains('lucide-chevron-right'), '行首左侧首位为 chevron-right')

      const bodyId = toggleBtn.getAttribute('aria-controls')!
      assert.ok(bodyId.length > 0)
      const bodyWrap = reportMount.host.querySelector<HTMLElement>(`#${CSS.escape(bodyId)}`)!
      assert.ok(bodyWrap.hasAttribute('hidden'), '折叠态 body 容器带 hidden')
      assert.ok(reportMount.host.querySelector('.sw-receipt-expanded') === null, '折叠态不挂载展开内容')

      // Click left toggle to expand in place
      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true', '点击左侧按钮原地展开')
      assert.ok(toggleBtn.firstElementChild?.classList.contains('lucide-chevron-down') === true, '展开后切换为 chevron-down')
      assert.equal(bodyWrap.hasAttribute('hidden'), false, '展开后移除 hidden')

      const expanded = reportMount.host.querySelector<HTMLElement>('.sw-receipt-expanded')!
      assert.ok(expanded !== null)
      const mdBody = expanded.querySelector<HTMLElement>('.sw-receipt-post-md')!
      assert.ok(mdBody !== null, '展开态经宿主 MarkdownView 渲染正文')
      assert.ok(mdBody.querySelector('strong')?.textContent === 'Fast slice', 'Markdown 加粗真实渲染')
      assert.ok(mdBody.querySelector('code')?.textContent === 'auth.ts', 'Markdown 行内代码真实渲染')
      assert.match(expanded.querySelector('.sw-panel-post-worktree')?.textContent ?? '', /helmx\/fast/, '展示 worktree 快照')
      assert.match(expanded.querySelector('.sw-receipt-post-refs')?.textContent ?? '', /#2/, '展示 refs')
      assert.match(expanded.querySelector('.sw-receipt-active-footer')?.textContent ?? '', /Still working: @slow/, '展开态底部展示仍在执行成员')
      assert.doesNotMatch(expanded.textContent ?? '', /No wake|Woke/, '默认 wake=true 的 done 不渲染多余 wake 标签')

      // Click right external-link button to open workbench
      const openBtn = reportMount.host.querySelector<HTMLButtonElement>('.sw-receipt-open-btn')!
      assert.ok(openBtn !== null && openBtn.querySelector('.lucide-external-link') !== null, '右侧存在 external-link 工作台按钮')
      await act(async () => {
        openBtn.click()
      })
      assert.deepEqual(spy.workbenchCalls, ['groups'], '点击右侧按钮打开协同工作台面板')
      assert.deepEqual(spy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 5 }], '携带 groupId 与 postSeq 参数')
    } finally {
      reportMount.unmount()
    }

    // zh-CN locale: 看板消息 + 仍在执行：@slow
    const zhSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const zhMount = await mount(
      zhSpy,
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-10-zh',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_010_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 5,
              toSeq: 5,
              postCount: 1,
              activeWorkingMembers: ['slow'],
              posts: [
                {
                  seq: 5,
                  from: 'fast',
                  to: ['coordinator'],
                  kind: 'review',
                  wake: true,
                  refs: [],
                  body: '请主控确认接口签名。',
                  createdAt: 1_700_000_009_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const text = zhMount.host.textContent ?? ''
      assert.match(text, /看板消息/, 'zh-CN 标题为看板消息')
      assert.doesNotMatch(text, /协同汇总/, 'zh-CN 淘汰旧协同汇总')
      assert.match(text, /审阅/, 'zh-CN review 徽章')
      await act(async () => {
        zhMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      assert.match(zhMount.host.querySelector('.sw-receipt-active-footer')?.textContent ?? '', /仍在执行：@slow/)
    } finally {
      zhMount.unmount()
    }
  })

  test('SwarmBoardReportCard：blocker/stall 默认展开与错误样式、多条合并截断、idleCatchup 与空回执回退', { timeout: 60_000 }, async () => {
    // 1) blocker defaults open with .trace-entry-error / .trace-row-error, and lead selection picks blocker over trailing comment
    const blockerMount = await mount(
      makeSpyCtx({ conversationId: 50, locale: 'zh-CN' }),
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-blk',
          kind: 'helmx.input',
          data: {
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 4,
              toSeq: 5,
              postCount: 2,
              activeWorkingMembers: [],
              posts: [
                {
                  seq: 4,
                  from: 'author',
                  to: ['coordinator'],
                  kind: 'blocker',
                  wake: true,
                  refs: [],
                  body: 'Integration DB unreachable.',
                  createdAt: 1000,
                },
                {
                  seq: 5,
                  from: 'verifier',
                  to: ['coordinator'],
                  kind: 'comment',
                  wake: false,
                  refs: [],
                  body: 'Standing by.',
                  createdAt: 1100,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      assert.ok(blockerMount.host.querySelector('.trace-entry-error') !== null, 'blocker 挂 .trace-entry-error')
      assert.ok(blockerMount.host.querySelector('.trace-row-error') !== null, 'blocker 挂 .trace-row-error')
      const toggle = blockerMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'blocker 默认展开')
      assert.match(toggle.textContent ?? '', /受阻/, '主帖优先挑选 blocker')
      assert.match(toggle.textContent ?? '', /@author/, '主帖发帖人不被后续 comment 覆盖')
      assert.match(blockerMount.host.textContent ?? '', /2 条/, '多条消息显示紧凑计数')
      assert.match(blockerMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? '', /Integration DB unreachable\./)
    } finally {
      blockerMount.unmount()
    }

    // 2) stall defaults open WITHOUT .trace-row-error
    const stallMount = await mount(
      makeSpyCtx({ conversationId: 50 }),
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-stall',
          kind: 'helmx.input',
          data: {
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 6,
              toSeq: 6,
              postCount: 1,
              posts: [
                {
                  seq: 6,
                  from: 'system',
                  to: ['coordinator'],
                  kind: 'stall',
                  wake: true,
                  refs: [5],
                  body: 'All workers idle without wake.',
                  createdAt: 1200,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      assert.equal(stallMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')?.getAttribute('aria-expanded'), 'true', 'stall 默认展开')
      assert.ok(stallMount.host.querySelector('.trace-row-error') === null, 'stall 不挂错误红态')
    } finally {
      stallMount.unmount()
    }

    // 3) truncatedPostsCount + bodyTruncated + idleCatchup
    const truncSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const truncMount = await mount(
      truncSpy,
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-trunc',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_020_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 1,
              toSeq: 22,
              postCount: 22,
              truncatedPostsCount: 2,
              idleCatchup: true,
              posts: [
                {
                  seq: 22,
                  from: 'slow',
                  to: ['coordinator'],
                  kind: 'done',
                  wake: false,
                  refs: [],
                  body: 'Long truncated content…',
                  bodyTruncated: true,
                  createdAt: 1_700_000_019_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = truncMount.host.textContent ?? ''
      assert.match(headerText, /全员空闲/, 'idleCatchup 使用全员空闲标题')
      assert.match(headerText, /#1\.\.#22/, '区间范围展示')
      assert.match(headerText, /22 条/, '展示总条数')
      await act(async () => {
        truncMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      const expText = truncMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? ''
      assert.match(expText, /已省略更早的 2 条消息，可打开工作台查看完整记录/)
      assert.match(expText, /正文已截断，可打开工作台查看全文/)
      assert.match(expText, /未唤醒/, 'done(wake=false) 显示未唤醒徽章')
    } finally {
      truncMount.unmount()
    }

    // 4) empty posts fallback
    const emptyMount = await mount(
      makeSpyCtx({ conversationId: 50 }),
      e(components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-empty',
          kind: 'helmx.input',
          data: { meta: { renderer: 'swarm:board-report', groupId: 'grp-live', fromSeq: 8, toSeq: 8, postCount: 1 } },
        },
      }),
    )
    try {
      await act(async () => {
        emptyMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      assert.match(emptyMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? '', /No board post details recorded\./)
    } finally {
      emptyMount.unmount()
    }
  })

  test('SwarmBoardWakeupCard：成员唤醒折叠轨迹卡原地展开交接正文并支持跳转工作台', { timeout: 60_000 }, async () => {
    const wakeupSpy = makeSpyCtx({ conversationId: 52 })
    const wakeupMount = await mount(
      wakeupSpy,
      e(components.SwarmBoardWakeupCard, {
        conversationId: 52,
        entry: {
          id: 'e-w1',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_030_000,
            meta: {
              renderer: 'swarm:board-wakeup',
              groupId: 'grp-live',
              workerName: 'verifier',
              fromSeq: 2,
              toSeq: 3,
              postCount: 2,
              posts: [
                {
                  seq: 2,
                  from: 'author',
                  to: ['verifier'],
                  kind: 'handoff',
                  wake: true,
                  refs: [1],
                  body: 'Ready for verification on **auth refresh**.',
                  worktreeSnapshot: {
                    worktreeId: 'wt-author',
                    branch: 'helmx/author',
                    commitsAhead: 2,
                    dirtyCount: 0,
                    changedFilesPreview: ['src/auth.ts'],
                  },
                  createdAt: 1_700_000_028_000,
                },
                {
                  seq: 3,
                  from: 'author',
                  to: ['verifier'],
                  kind: 'comment',
                  wake: true,
                  refs: [2],
                  body: 'Please also check edge timeout.',
                  createdAt: 1_700_000_029_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = wakeupMount.host.textContent ?? ''
      assert.match(headerText, /Swarm wakeup/)
      assert.match(headerText, /@author -> @verifier/, '头部展示路由方向')
      assert.match(headerText, /#2\.\.#3/)
      assert.match(headerText, /2 posts/)
      assert.ok(wakeupMount.host.querySelector('.sw-receipt-pill') === null)
      const toggle = wakeupMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggle.click()
      })
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      const expanded = wakeupMount.host.querySelector<HTMLElement>('.sw-receipt-expanded')!
      assert.ok(expanded !== null)
      const postEls = expanded.querySelectorAll('.sw-receipt-post')
      assert.equal(postEls.length, 2, '展开态逐条渲染合并消息')
      assert.match(postEls[0]!.querySelector('.sw-receipt-post-md')?.textContent ?? '', /Ready for verification on auth refresh\./)
      assert.doesNotMatch(postEls[0]!.querySelector('.sw-receipt-post-head')?.textContent ?? '', /Woke|No wake/, '默认 handoff(wake=true) 不显多余标签')
      assert.match(postEls[0]!.querySelector('.sw-panel-post-worktree')?.textContent ?? '', /helmx\/author/)
      assert.match(postEls[1]!.querySelector('.sw-receipt-post-head')?.textContent ?? '', /Woke/, 'comment(wake=true) 显示 Woke 偏离徽章')

      await act(async () => {
        wakeupMount.host.querySelector<HTMLButtonElement>('.sw-receipt-open-btn')!.click()
      })
      assert.deepEqual(wakeupSpy.workbenchCalls, ['groups'])
      assert.deepEqual(wakeupSpy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 3 }])
    } finally {
      wakeupMount.unmount()
    }
  })

  test('SwarmWorkbenchPanel & SwarmPostPeekPopover：帖子头对偏离默认 wake 展示轻标签，默认 wake 不显示多余标签', { timeout: 60_000 }, async () => {
    const wakeBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证 wake 偏离标识',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 4,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_004_000,
      },
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'author',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: false,
          kind: 'done',
          refs: [],
          body: 'Passive done post.',
          createdAt: 1_700_000_001_000,
        },
        {
          seq: 2,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'comment',
          refs: [1],
          body: 'Urgent comment citing #1.',
          createdAt: 1_700_000_002_000,
        },
        {
          seq: 3,
          groupId: 'grp-live',
          from: 'author',
          to: ['verifier'],
          resolvedTargets: ['verifier'],
          wake: true,
          kind: 'handoff',
          refs: [],
          body: 'Default wake handoff.',
          createdAt: 1_700_000_003_000,
        },
        {
          seq: 4,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: false,
          kind: 'comment',
          refs: [],
          body: 'Default silent comment.',
          createdAt: 1_700_000_004_000,
        },
      ],
    })
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': wakeBoard },
    })

    const spy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const head1 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"] .sw-panel-post-head')!
      const head2 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-head')!
      const head3 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="3"] .sw-panel-post-head')!
      const head4 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="4"] .sw-panel-post-head')!
      assert.match(head1.textContent ?? '', /未唤醒/, 'done(wake=false) 显示未唤醒')
      assert.match(head2.textContent ?? '', /已唤醒/, 'comment(wake=true) 显示已唤醒')
      assert.doesNotMatch(head3.textContent ?? '', /未唤醒|已唤醒/, '默认 handoff(wake=true) 不显多余标签')
      assert.doesNotMatch(head4.textContent ?? '', /未唤醒|已唤醒/, '默认 comment(wake=false) 不显多余标签')

      // Peek popover on #1 also renders 未唤醒 badge
      const ref1 = panel.host.querySelector<HTMLButtonElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-ref')!
      await act(async () => {
        ref1.click()
      })
      const peekHead = panel.host.querySelector<HTMLElement>('.sw-peek-popover .sw-peek-head')!
      assert.match(peekHead.textContent ?? '', /未唤醒/, '速览浮卡帖子头同样展示偏离默认的未唤醒轻标签')
    } finally {
      panel.unmount()
    }
    resetDefaultStubs()
  })

  // ---------------------------------------------------------------------------
  // 6. Pure model spot checks & static hard rules
  // ---------------------------------------------------------------------------

  test('纯模型抽查：严格边界解析、正交交付进度、SwarmToolView/ActiveTray/Panel 回退补齐', { timeout: 60_000 }, async () => {
    const validView = parseBoardView(boardViewFixture())
    assert.ok(validView !== undefined)
    assert.equal(postDigestLine('line one\nline two', 10), 'line one')
    assert.equal(postDigestLine('   \n second  line ', 40), 'second line', '空白折叠取首行')
    assert.equal(parseBoardView({ group: null }), undefined, '非法结构显式拒绝')
    assert.equal(parseBoardView(undefined), undefined)

    // Strict parsing rejects bad enums/missing required fields rather than fabricating defaults
    const badStatus = boardViewFixture()
    ;(badStatus.group as { status: string }).status = 'weird'
    assert.equal(parseBoardView(badStatus), undefined)

    const badKindPost = (boardViewFixture().posts as Array<Record<string, unknown>>)[0]!
    assert.equal(parseBoardPost({ ...badKindPost, kind: 'invented' }), undefined)
    assert.equal(parseBoardPost({ ...badKindPost, from: '' }), undefined)
    assert.equal(parseBoardReadPosts({ posts: [{ ...badKindPost, kind: 'bad' }] }), undefined)

    // Orthogonal completion progress: active + idle + caught-up cursor + lastOutboundEdge done/handoff
    const baseMember = validView!.members[0]!
    assert.equal(
      isMemberDelivered({
        ...baseMember,
        liveState: 'idle',
        lastOutboundEdge: { seq: 2, to: ['verifier'], kind: 'handoff' },
      }),
      true,
    )
    assert.equal(
      isMemberDelivered({
        ...baseMember,
        liveState: 'idle',
        lastOutboundEdge: undefined,
      }),
      false,
    )
    assert.deepEqual(
      boardProgressOf([
        { ...baseMember, liveState: 'idle', lastOutboundEdge: { seq: 2, to: ['coordinator'], kind: 'done' } },
        { ...validView!.members[1]!, liveState: 'working' },
      ]),
      { done: 1, total: 2 },
    )

    // SwarmToolView scopes @member lookup to current group, renders .trace-row, reads presentationMeta
    setStubState({
      docs: {
        index: {
          workers: [
            { conversationId: 901, coordinatorConversationId: 900, profileId: 'coder', groupId: 'grp-other', name: 'author', createdAt: 1 },
            { conversationId: 51, coordinatorConversationId: 50, profileId: 'coder', groupId: 'grp-live', name: 'author', createdAt: 2 },
          ],
          groups: [],
        },
        'board-badges': { byConversation: {} },
      },
    })
    const tvSpy = makeSpyCtx({ conversationId: 50 })
    const tvMount = await mount(
      tvSpy,
      e(components.SwarmToolView, toolViewProps({
        toolName: 'swarm_inspect_worker',
        input: { groupId: 'grp-live', name: 'author' },
        result: 'Member @author (#51)',
        presentationMeta: { groupId: 'grp-live', workerConversationId: 51, memberName: 'author' },
      })),
    )
    try {
      const btn = tvMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
      assert.ok(btn.classList.contains('trace-row'), '必须挂载宿主 .trace-row 基础类')
      await act(async () => {
        btn.click()
      })
      assert.deepEqual(tvSpy.drawerCalls, [51], '按当前组过滤同短名成员，绝不跳到并发他组 #901')
    } finally {
      tvMount.unmount()
    }

    // Without workerConversationId in presentationMeta, @member lookup stays scoped to targetGroupId
    const scopedLookupSpy = makeSpyCtx({ conversationId: 50 })
    const scopedLookupMount = await mount(
      scopedLookupSpy,
      e(components.SwarmToolView, toolViewProps({
        toolName: 'swarm_inspect_worker',
        input: { groupId: 'grp-live', name: 'author' },
        status: 'running',
        presentationMeta: { groupId: 'grp-live', memberName: 'author' },
      })),
    )
    try {
      const btn = scopedLookupMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
      await act(async () => {
        btn.click()
      })
      assert.deepEqual(scopedLookupSpy.drawerCalls, [51], '省略 workerConversationId 时按当前组查找 #51，不误命中他组 #901')
    } finally {
      scopedLookupMount.unmount()
    }

    // SwarmActiveTray consumes live.tools / pendingAsks from useConversation(includeDetail: false)
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
      conversationLives: {
        52: {
          conversationId: 52,
          text: '',
          tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm test:unit' }, status: 'running' }],
          updatedAt: Date.now(),
        },
      },
    })
    const liveTraySpy = makeSpyCtx({ conversationId: 50 })
    const liveTray = await mount(
      liveTraySpy,
      e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      assert.match(liveTray.host.textContent ?? '', /pnpm test:unit/)
      await act(async () => {
        liveTray.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!.click()
      })
      assert.match(liveTray.host.querySelector('.sw-tray-row-live')?.textContent ?? '', /bash: pnpm test:unit/)
    } finally {
      liveTray.unmount()
    }

    // Archived worker evicted from index falls back via board_status({}) + board_read({ groupId })
    const evictedBoard = boardViewFixture()
    ;(evictedBoard.group as { id: string; status: string }).id = 'grp-evicted'
    ;(evictedBoard.group as { status: string }).status = 'closed'
    setStubState({ docs: { index: { workers: [], groups: [] }, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
    const calls: Array<{ actionId: string; input: unknown }> = []
    const archWorkerSpy = makeSpyCtx({
      conversationId: 52,
      callAction: async (actionId: string, input: unknown) => {
        calls.push({ actionId, input })
        if (actionId === 'board_status') return evictedBoard
        if (actionId === 'board_read') return { groupId: 'grp-evicted', headSeq: 3, posts: evictedBoard.posts }
        return {}
      },
    })
    const archWorkerPanel = await mount(
      archWorkerSpy,
      e(components.SwarmWorkbenchPanel, {
        conversation: convSummary(52, 'verifier archived', { tags: ['swarm-worker-archived'] }),
      }),
    )
    try {
      assert.match(archWorkerPanel.host.textContent ?? '', /Completed/)
      assert.match(archWorkerPanel.host.textContent ?? '', /helmx\/author/)
      assert.deepEqual(calls, [{ actionId: 'board_status', input: {} }])
      await act(async () => {
        archWorkerPanel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!.click()
      })
      assert.deepEqual(calls[1], { actionId: 'board_read', input: { groupId: 'grp-evicted', limit: 200 } })
    } finally {
      archWorkerPanel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel & SwarmToolView：中文态势本地化、成员短模型徽章、可点击 #seq 引用与主控兜底操作（中止/结单弹窗）', { timeout: 60_000 }, async () => {
    // 1) SwarmToolView renders swarm_switch_worker_model with #seq
    const tvSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const swMount = await mount(
      tvSpy,
      e(components.SwarmToolView, toolViewProps({
        callId: 'call-sw-1',
        toolName: 'swarm_switch_worker_model',
        input: { name: 'author', model: 'openai/gpt-5', prompt: 'Resume now' },
        result: 'Switched @author (#51) model to openai/gpt-5 and woke with brief #9.',
        presentationMeta: { workerConversationId: 51, memberName: 'author', model: 'openai/gpt-5', seq: 9 },
      })),
    )
    try {
      const text = swMount.host.textContent ?? ''
      assert.match(text, /切换成员模型/)
      assert.match(text, /@author/)
      assert.match(text, /#9/)
    } finally {
      swMount.unmount()
    }

    // 2) SwarmWorkbenchPanel: zh-CN localized headline, short model badge, clickable #seq refs, and coordinator Abort/Close controls
    const singleBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '零回归完成鉴权改造',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 2,
        createdAt: Date.now() - 60_000,
        updatedAt: 2000,
      },
      headline: {
        text: 'Active: @verifier',
        tone: 'info',
        kind: 'normal',
        targetMember: 'verifier',
      },
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
          body: 'Review note referencing #1 on main board.',
          createdAt: 1500,
        },
      ],
    })
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': singleBoard },
    })

    const coordSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const coordPanel = await mount(
      coordSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = coordPanel.host.textContent ?? ''
      assert.match(text, /执行中：@verifier/, 'zh-CN 本地化合成态势标题')
      assert.match(text, /gpt-5/, '展示成员短模型名')
      assert.match(text, /claude-sonnet-4-5/, '展示审阅成员短模型名')
      assert.ok(coordPanel.host.querySelector('.sw-panel-channels') === null, '单黑板不渲染频道筛选栏')

      // Clicking #1 ref chip opens inline peek popover
      const refBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-post-ref')!
      assert.ok(refBtn !== null, '渲染可点击 #seq 引用芯片')
      assert.equal(refBtn.textContent, '#1')
      await act(async () => {
        refBtn.click()
      })
      const peek = coordPanel.host.querySelector<HTMLElement>('.sw-peek-popover')
      assert.ok(peek !== null, '点击引用芯片应原地弹出速览浮卡')
      assert.match(peek.textContent ?? '', /#1/, '浮卡标题展示目标序号')

      // Clicking "Locate in list" highlights #1 and shows jump-back bar to #2
      const locateBtn = peek.querySelector<HTMLButtonElement>('.sw-peek-locate-btn')!
      assert.ok(locateBtn !== null, '浮卡提供定位到列表入口')
      await act(async () => {
        locateBtn.click()
      })
      assert.ok(coordPanel.host.querySelector('.sw-peek-popover') === null, '定位后收起浮卡')
      const highlighted = coordPanel.host.querySelector<HTMLElement>('.sw-panel-post-highlighted')
      assert.ok(highlighted !== null, '定位后高亮目标帖子')
      assert.equal(highlighted.getAttribute('data-post-seq'), '1')
      const jumpBackBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-jump-back-btn')
      assert.ok(jumpBackBtn !== null, '列表跳转后挂出返回原留言胶囊')
      assert.match(jumpBackBtn.textContent ?? '', /返回 #2/)

      // Clicking jump-back returns highlight to #2 and clears the jump-back bar
      await act(async () => {
        jumpBackBtn.click()
      })
      assert.equal(
        coordPanel.host.querySelector<HTMLElement>('.sw-panel-post-highlighted')?.getAttribute('data-post-seq'),
        '2',
        '点击回跳胶囊返回原留言 #2',
      )
      assert.ok(coordPanel.host.querySelector('.sw-panel-jump-back') === null, '退空后自动隐藏回跳条')

      // Coordinator Abort button on working member
      const abortBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-member-abort')
      assert.ok(abortBtn !== null, '主控面板为在途成员提供中止按钮')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        coordSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
      )

      // Coordinator Close Group dialog calls close_group with keepWorktree & abortRunning defaults
      const closeBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-close-btn')
      assert.ok(closeBtn !== null, '主控面板提供结单按钮')
      await act(async () => {
        closeBtn.click()
      })
      const confirmBtn = document.body.querySelector<HTMLButtonElement>('.sw-close-dialog-confirm')
      assert.ok(confirmBtn !== null, '结单确认对话框渲染')
      await act(async () => {
        confirmBtn.click()
      })
      const closeCall = coordSpy.actionCalls.find((c) => c.actionId === 'close_group')
      assert.ok(closeCall !== undefined, '确认结单调用 close_group 动作')
      assert.deepEqual(closeCall.input, { groupId: 'grp-live', keepWorktree: true, abortRunning: true })
    } finally {
      coordPanel.unmount()
    }

    // Worker viewer must NOT see Abort or Close Group buttons
    const workerSpy = makeSpyCtx({ conversationId: 51, locale: 'zh-CN' })
    const workerPanel = await mount(
      workerSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.ok(workerPanel.host.querySelector('.sw-panel-member-abort') === null, 'Worker 视角不渲染中止按钮')
      assert.ok(workerPanel.host.querySelector('.sw-panel-close-btn') === null, 'Worker 视角不渲染结单按钮')
    } finally {
      workerPanel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：正文内联 #seq 速览、浮卡内多层引用前进/后退、早期截断帖按需 board_read 与缺帖如实提示', { timeout: 60_000 }, async () => {
    const { linkifyPostRefs } = await import('../../plugins/src/swarm/client/model-post-nav.js')
    // linkifyPostRefs：保留代码块、行内代码与既有链接，仅转正文引用并跳过自身 seq
    assert.equal(
      linkifyPostRefs(
        '见 #12 与（#5），忽略 `#9` 与 [已链接 #8](https://example.com) 与自身 #20。\n```\n#7 in fence\n```',
        20,
      ),
      '见 [#12](#swarm-post-12) 与（[#5](#swarm-post-5)），忽略 `#9` 与 [已链接 #8](https://example.com) 与自身 #20。\n```\n#7 in fence\n```',
    )

    // 活跃板 headSeq=20，但尾部投影仅含 #12 与 #20；早期长帖 #2 需按需 board_read 拉回，#999 不存在。
    const longEarlyBody = Array.from({ length: 12 }, (_, i) => `Early constraint line ${i + 1}`).join('\n')
    const truncatedBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '零回归完成鉴权改造',
        status: 'active',
        coordinatorConversationId: 50,
        activeWorkerCount: 2,
        headSeq: 20,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_020_000,
      },
      posts: [
        {
          seq: 12,
          groupId: 'grp-live',
          from: 'author',
          to: ['verifier'],
          resolvedTargets: ['verifier'],
          wake: true,
          kind: 'handoff',
          body: 'Implemented per #2 and bogus #999.',
          refs: [2, 999],
          createdAt: 1_700_000_012_000,
        },
        {
          seq: 20,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'review',
          body: 'Checked #12 thoroughly; inline `#77` stays code.',
          refs: [12],
          createdAt: 1_700_000_020_000,
        },
      ],
    })
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': truncatedBoard },
    })

    let boardReadAttempts = 0
    const boardReadInputs: unknown[] = []
    let failNextRead = true
    const spy = makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input) => {
        if (actionId === 'board_read') {
          boardReadAttempts += 1
          boardReadInputs.push(input)
          if (failNextRead) {
            failNextRead = false
            throw new Error('temporary read failure')
          }
          return {
            posts: [
              {
                seq: 2,
                groupId: 'grp-live',
                from: 'coordinator',
                to: ['all'],
                resolvedTargets: ['author', 'verifier'],
                wake: true,
                kind: 'brief',
                body: longEarlyBody,
                refs: [],
                createdAt: 1_700_000_002_000,
              },
            ],
          }
        }
        return {}
      },
    })

    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      // 1) 正文内联链接可点开 #12 浮卡；行内代码 `#77` 不被转为链接
      const inlineLink = panel.host.querySelector<HTMLAnchorElement>('.sw-panel-post[data-post-seq="20"] a[href="#swarm-post-12"]')
      assert.ok(inlineLink !== null, '正文 #12 应渲染为可点击内联引用链接')
      assert.ok(panel.host.querySelector('a[href="#swarm-post-77"]') === null, '行内代码中的 #77 不得转为链接')
      await act(async () => { inlineLink.click() })

      let peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')
      assert.ok(peek !== null, '点击正文内联 #12 应打开速览浮卡')
      assert.match(peek.textContent ?? '', /Implemented per #2/)
      assert.equal(boardReadAttempts, 0, '已缓存的 #12 不应触发额外 board_read')

      // 2) 在 #12 浮卡内继续点未缓存的早期帖 #2 -> 按 seqs:[2] 精确补拉，首次失败如实报错并可重试
      const nestedRef2 = peek.querySelector<HTMLAnchorElement>('a[href="#swarm-post-2"]')
      assert.ok(nestedRef2 !== null, '浮卡内引用同样可点击')
      await act(async () => { nestedRef2.click() })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.equal(boardReadAttempts, 1, '早期未缓存帖 #2 必须触发按需 board_read')
      assert.deepEqual(boardReadInputs[0], { groupId: 'grp-live', seqs: [2] }, '浮卡缺失引用必须按 seqs 精确补拉')
      assert.match(peek.textContent ?? '', /temporary read failure/, '读取失败如实呈现原文')
      const retryBtn = [...peek.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.textContent ?? '').includes('重试'),
      )
      assert.ok(retryBtn !== null, '失败浮卡提供重试按钮')
      await act(async () => { retryBtn!.click() })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

      // 重试成功后：浮卡默认展示完整全文（不二次折叠），且顶部带返回 #12 按钮
      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.equal(boardReadAttempts, 2)
      assert.match(peek.textContent ?? '', /Early constraint line 12/, '浮卡内长帖默认展示完整全文')
      assert.ok(peek.querySelector('.sw-panel-post-toggle') === null, '浮卡内不再二次折叠正文')

      // 3) 点浮卡返回按钮退回 #12，再点不存在的 #999 -> 如实提示未找到
      const backBtn = peek.querySelector<HTMLButtonElement>('.sw-peek-back-btn')
      assert.ok(backBtn !== null, '多层浮卡显示返回 #12 按钮')
      assert.match(backBtn.textContent ?? '', /#12/)
      await act(async () => { backBtn.click() })
      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.match(peek.textContent ?? '', /Implemented per #2/, '浮卡退回 #12')

      const ref999 = peek.querySelector<HTMLAnchorElement>('a[href="#swarm-post-999"]')
      assert.ok(ref999 !== null)
      await act(async () => { ref999.click() })
      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.match(peek.textContent ?? '', /未找到记录 #999/, '不存在的序号如实提示未找到')
    } finally {
      panel.unmount()
    }

    // 4) 空成员编组文案与 >200 条历史分页向前加载 + 早期 #seq 定位不截断
    const emptyMembersBoard = boardViewFixture({
      group: {
        id: 'grp-empty',
        title: '新建待派工编组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 0,
        headSeq: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      headline: { text: 'Group ready — dispatch peer roles to start collaboration', tone: 'info', kind: 'normal' },
      members: [],
      posts: [],
      activeWorkingMembers: [],
    })
    setStubState({
      docs: {
        index: {
          workers: [],
          groups: [emptyMembersBoard.group],
        },
        'board-badges': { byConversation: {} },
      },
      sessionDocs: { 'builtin:swarm/board-view/50': emptyMembersBoard },
    })
    const emptyPanel = await mount(
      makeSpyCtx({ conversationId: 50, locale: 'zh-CN' }),
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const emptyText = emptyPanel.host.textContent ?? ''
      assert.match(emptyText, /尚未派工成员。/, '空成员区必须显示成员空文案而非帖子空文案')
      assert.match(emptyText, /编组已就绪/, '无正则结构字段推导就绪标题')
    } finally {
      emptyPanel.unmount()
    }

    const makeStubPost = (seq: number, body = `Post #${seq}`) => ({
      seq,
      groupId: 'grp-long',
      from: 'author',
      to: ['verifier'],
      resolvedTargets: ['verifier'],
      wake: true,
      kind: 'handoff',
      refs: seq === 250 ? [12] : [],
      body,
      createdAt: 1_700_000_000_000 + seq * 1000,
    })
    const longBoard = boardViewFixture({
      group: {
        id: 'grp-long',
        title: '长协同组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 250,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_250_000,
      },
      posts: Array.from({ length: 10 }, (_, i) => makeStubPost(241 + i, i === 9 ? 'Final check citing #12.' : `Recent #${241 + i}`)),
    })
    setStubState({
      docs: { index: { workers: [], groups: [longBoard.group] }, 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': longBoard },
    })
    const longReadCalls: unknown[] = []
    const longSpy = makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input) => {
        if (actionId !== 'board_read') return {}
        longReadCalls.push(input)
        const inp = input as { seqs?: number[]; sinceSeq?: number; limit?: number }
        if (Array.isArray(inp.seqs)) {
          return { posts: inp.seqs.map((s) => makeStubPost(s, `Early exact post #${s}`)) }
        }
        if (typeof inp.sinceSeq === 'number') {
          const count = inp.limit ?? 50
          return { posts: Array.from({ length: count }, (_, i) => makeStubPost(inp.sinceSeq! + 1 + i)) }
        }
        return { posts: Array.from({ length: 200 }, (_, i) => makeStubPost(51 + i)) }
      },
    })
    const longPanel = await mount(
      longSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      // #seq badge must not dump raw body into native title tooltip
      const seqEl = longPanel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="250"] .sw-panel-post-seq')
      assert.equal(seqEl?.getAttribute('title'), null, '#seq 徽章不得把整段正文塞入原生 title')

      // Click #12 -> exact seqs:[12] fetch -> Locate in list -> #12 stays visible past 200 recent posts!
      const ref12 = longPanel.host.querySelector<HTMLAnchorElement>('.sw-panel-post[data-post-seq="250"] a[href="#swarm-post-12"]')!
      await act(async () => { ref12.click() })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      assert.deepEqual(longReadCalls[0], { groupId: 'grp-long', seqs: [12] })
      const locateBtn = longPanel.host.querySelector<HTMLButtonElement>('.sw-peek-locate-btn')!
      assert.ok(locateBtn !== null)
      await act(async () => { locateBtn.click() })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      assert.ok(
        longPanel.host.querySelector('.sw-panel-post-highlighted[data-post-seq="12"]') !== null,
        '定位早期帖 #12 时即使已加载最新 200 条也不得被 slice(0, 200) 截掉',
      )

      // "Load earlier records" button appears and fetches #1..#50 via sinceSeq=0, limit=50
      const loadEarlierBtn = longPanel.host.querySelector<HTMLButtonElement>('.sw-panel-load-earlier')
      assert.ok(loadEarlierBtn !== null, '超过 200 条记录时展示加载更早记录按钮')
      await act(async () => { loadEarlierBtn.click() })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      assert.deepEqual(longReadCalls.at(-1), { groupId: 'grp-long', sinceSeq: 0, limit: 50 })
      assert.ok(longPanel.host.querySelector('.sw-panel-load-earlier') === null, '加载至 #1 后隐藏更早记录按钮')
      assert.ok(longPanel.host.querySelector('.sw-panel-post[data-post-seq="1"]') !== null, '早期 #1 成功合入列表')
    } finally {
      longPanel.unmount()
    }
    resetDefaultStubs()
  })

  // ---------------------------------------------------------------------------
  // 7. Time observability: group elapsed (active/closed), tray rows, panel rows, board post offsets
  // ---------------------------------------------------------------------------

  test('时间观测纯模型与边界解析：宽松解析成员耗时、结单冻结总耗时、首轮去重/多轮累计/阻塞等待与黑板时间偏移', { timeout: 60_000 }, () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 185_000 // +3m05s

    // 1) Lenient boundary parsing: valid timing fields preserved; malformed ones omitted without discarding the board
    const rawWithMixedTiming = boardViewFixture({
      group: {
        id: 'grp-time',
        title: '耗时观测组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 2,
        createdAt: T0,
        updatedAt: T0 + 60_000,
      },
      members: [
        {
          ...(boardViewFixture().members as Array<Record<string, unknown>>)[0]!,
          liveState: 'done',
          runDurationMs: 42_500,
          turnCount: 3,
          runStartedAt: -10, // invalid -> omitted leniently
          pendingAskSince: 'bad', // invalid -> omitted leniently
        },
        {
          ...(boardViewFixture().members as Array<Record<string, unknown>>)[1]!,
          liveState: 'working',
          runDurationMs: 45_000,
          runStartedAt: NOW - 12_000,
          turnCount: 1.5, // non-int -> omitted leniently
        },
      ],
    })
    const parsed = parseBoardView(rawWithMixedTiming)
    assert.ok(parsed !== undefined, '非法可选耗时字段不得导致整张看板被拒')
    assert.equal(parsed!.members[0]!.runDurationMs, 42_500)
    assert.equal(parsed!.members[0]!.turnCount, 3)
    assert.equal(parsed!.members[0]!.runStartedAt, undefined)
    assert.equal(parsed!.members[0]!.pendingAskSince, undefined)
    assert.equal(parsed!.members[1]!.runDurationMs, 45_000)
    assert.equal(parsed!.members[1]!.runStartedAt, NOW - 12_000)
    assert.equal(parsed!.members[1]!.turnCount, undefined)

    // 2) Active group timing view & Tooltip breakdown
    const activeGroupTiming = resolveGroupTimingView(parsed!, [], NOW, 'zh-CN')
    assert.ok(activeGroupTiming !== undefined)
    assert.equal(activeGroupTiming!.label, '3m05s')
    assert.match(activeGroupTiming!.tooltip, /端到端总耗时：3m05s/)
    assert.match(activeGroupTiming!.tooltip, /全员累计运行：1m39s/)
    assert.match(activeGroupTiming!.tooltip, /创建时间：/)
    assert.doesNotMatch(activeGroupTiming!.tooltip, /结单时间：/)

    // 3) Closed group timing view freezes total elapsed (never disappears!) and includes closedAt
    const closedBoard = parseBoardView(
      boardViewFixture({
        group: {
          id: 'grp-closed',
          title: '已结单组',
          coordinatorConversationId: 50,
          status: 'closed',
          activeWorkerCount: 0,
          headSeq: 2,
          createdAt: T0,
          updatedAt: T0 + 125_000,
          closedAt: T0 + 125_000,
        },
        members: [
          {
            ...(boardViewFixture().members as Array<Record<string, unknown>>)[0]!,
            lifecycle: 'archived',
            archivedAt: T0 + 120_000,
            liveState: 'missing',
            runDurationMs: 42_500,
            turnCount: 2,
          },
          {
            ...(boardViewFixture().members as Array<Record<string, unknown>>)[1]!,
            lifecycle: 'archived',
            archivedAt: T0 + 125_000,
            liveState: 'missing',
            runDurationMs: 25_000,
            turnCount: 1,
          },
        ],
        activeWorkingMembers: [],
      }),
    )!
    const closedGroupTiming = resolveGroupTimingView(closedBoard, [], undefined, 'zh-CN')
    assert.ok(closedGroupTiming !== undefined, '结单组必须继续冻结展示总耗时，不再消失')
    assert.equal(closedGroupTiming!.label, '2m5s')
    assert.match(closedGroupTiming!.tooltip, /端到端总耗时：2m5s/)
    assert.match(closedGroupTiming!.tooltip, /全员累计运行：1m8s/)
    assert.match(closedGroupTiming!.tooltip, /创建时间：/)
    assert.match(closedGroupTiming!.tooltip, /结单时间：/)

    // 4) Panel member row timing rules: first-turn dedup, multi-turn, blocked+total, settled>0, idle=0 omitted
    const firstTurn = resolvePanelMemberTimingView(
      { liveState: 'working', lifecycle: 'active', runDurationMs: 0, runStartedAt: NOW - 12_000, turnCount: 0, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(firstTurn?.label, '12s', '首轮 working 去重仅显示本轮秒表')
    assert.equal(firstTurn?.tone, 'live')

    const multiTurn = resolvePanelMemberTimingView(
      { liveState: 'working', lifecycle: 'active', runDurationMs: 45_000, runStartedAt: NOW - 12_000, turnCount: 2, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(multiTurn?.label, '本轮 12s · 累计 57s')
    assert.match(multiTurn?.tooltip ?? '', /累计运行：57s/)
    assert.match(multiTurn?.tooltip ?? '', /本轮运行：12s/)
    assert.match(multiTurn?.tooltip ?? '', /已完成轮次：2/)
    assert.match(multiTurn?.tooltip ?? '', /加入时间：/)

    const blockedWithTotal = resolvePanelMemberTimingView(
      {
        liveState: 'blocked',
        lifecycle: 'active',
        runDurationMs: 60_000,
        runStartedAt: NOW - 30_000,
        pendingAskSince: NOW - 25_000,
        turnCount: 1,
        createdAt: T0,
      },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(blockedWithTotal?.label, '等待审批 25s · 累计 1m30s')
    assert.equal(blockedWithTotal?.tone, 'warn')

    const blockedNoPriorRun = resolvePanelMemberTimingView(
      { liveState: 'blocked', lifecycle: 'active', runDurationMs: 0, pendingAskSince: NOW - 18_000, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(blockedNoPriorRun?.label, '等待审批 18s')
    assert.equal(blockedNoPriorRun?.tone, 'warn')

    const settledDone = resolvePanelMemberTimingView(
      { liveState: 'done', lifecycle: 'active', runDurationMs: 42_500, turnCount: 2, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(settledDone?.label, '42.5s')
    assert.equal(settledDone?.tone, 'settled')

    const idleZero = resolvePanelMemberTimingView(
      { liveState: 'idle', lifecycle: 'active', runDurationMs: 0, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(idleZero, undefined, '空闲且累计为 0 时诚实省略')

    // 5) Tray worker row timing rules
    const trayBlocked = resolveTrayMemberTimingView(
      { liveState: 'blocked', runDurationMs: 30_000, runStartedAt: NOW - 25_000, pendingAskSince: NOW - 20_000, turnCount: 1 },
      NOW,
      'zh-CN',
    )
    assert.equal(trayBlocked?.label, '等待审批 20s')
    assert.equal(trayBlocked?.isWarn, true)
    assert.match(trayBlocked?.tooltip ?? '', /本轮运行：25s/)
    assert.match(trayBlocked?.tooltip ?? '', /累计运行：55s/)
    assert.match(trayBlocked?.tooltip ?? '', /已完成轮次：1/)

    const trayWorking = resolveTrayMemberTimingView(
      { liveState: 'working', runDurationMs: 0, runStartedAt: NOW - 9_000, turnCount: 0 },
      NOW,
      'en',
    )
    assert.equal(trayWorking?.label, '9s')
    assert.equal(trayWorking?.isWarn, false)

    // 6) Board post relative offset & negative/invalid fallback
    const postOffset = resolvePostTimeDisplay(T0 + 15_000, T0)
    assert.equal(postOffset?.label, '+00:15')
    assert.match(postOffset?.fullTimestamp ?? '', /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    const postHourOffset = resolvePostTimeDisplay(T0 + 3_735_000, T0)
    assert.equal(postHourOffset?.label, '+1:02:15')

    const postNegativeFallback = resolvePostTimeDisplay(T0 - 5_000, T0)
    assert.equal(postNegativeFallback?.label, postNegativeFallback?.fullTimestamp, '负偏移回退紧凑时刻')
  })

  test('SwarmActiveTray & SwarmWorkbenchPanel 时间观测 DOM 渲染：共享时钟、阻塞 warn、首轮去重、多轮累计、黑板偏移与结单冻结', { timeout: 60_000 }, async () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 185_000 // +3m05s

    const timedBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '耗时协同组',
        objective: '验证实时与结单耗时渲染',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 4,
        headSeq: 3,
        createdAt: T0,
        updatedAt: T0 + 120_000,
      },
      members: [
        {
          name: 'blocker-w',
          conversationId: 61,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 1_000,
          liveState: 'blocked',
          runDurationMs: 60_000,
          runStartedAt: NOW - 30_000,
          pendingAskSince: NOW - 25_000,
          turnCount: 1,
        },
        {
          name: 'first-turn',
          conversationId: 62,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 2_000,
          liveState: 'working',
          runDurationMs: 0,
          runStartedAt: NOW - 12_000,
          turnCount: 0,
        },
        {
          name: 'multi-turn',
          conversationId: 63,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 3_000,
          liveState: 'working',
          runDurationMs: 45_000,
          runStartedAt: NOW - 12_000,
          turnCount: 2,
        },
        {
          name: 'done-w',
          conversationId: 64,
          profileId: 'reviewer',
          access: 'readonly',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 2,
          pendingWakeupSeq: 1,
          lastPostSeq: 2,
          createdAt: T0 + 4_000,
          liveState: 'done',
          runDurationMs: 42_500,
          turnCount: 2,
        },
        {
          name: 'idle-zero',
          conversationId: 65,
          profileId: 'reviewer',
          access: 'readonly',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 5_000,
          liveState: 'idle',
          runDurationMs: 0,
          turnCount: 0,
        },
      ],
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'coordinator',
          to: ['blocker-w'],
          resolvedTargets: ['blocker-w'],
          wake: true,
          kind: 'brief',
          refs: [],
          body: 'Initial task',
          createdAt: T0 + 15_000,
        },
        {
          seq: 2,
          groupId: 'grp-live',
          from: 'done-w',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'done',
          refs: [1],
          body: 'Completed check',
          createdAt: T0 + 3_735_000,
        },
      ],
      activeWorkingMembers: ['blocker-w', 'first-turn', 'multi-turn'],
    })

    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': timedBoard },
    })

    // 1) SwarmActiveTray: shared clock drives HUD stopwatch + blocked/working row elapsed
    const traySpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const trayMount = await mount(
      traySpy,
      e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      DEFAULT_CONVERSATIONS,
      { serverNowMs: NOW },
    )
    try {
      const hudElapsed = trayMount.host.querySelector<HTMLElement>('.sw-tray-bar-toggle .sw-tray-elapsed')
      assert.equal(hudElapsed?.textContent, '3m05s', '托盘顶部显示整秒秒表')
      const toggleBtn = trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      assert.match(toggleBtn.getAttribute('title') ?? '', /端到端总耗时：3m05s/, '托盘切换提示附组耗时拆解')

      await act(async () => {
        toggleBtn.click()
      })
      const rowTimings = [...trayMount.host.querySelectorAll<HTMLElement>('.sw-tray-row-elapsed')]
      assert.equal(rowTimings.length, 3, '三个在途成员均渲染实时耗时')
      assert.equal(rowTimings[0]!.textContent, '等待审批 25s')
      assert.equal(rowTimings[0]!.classList.contains('sw-tray-row-elapsed-warn'), true, 'blocked 行使用 warn 色')
      assert.equal(rowTimings[1]!.textContent, '12s')
      assert.equal(rowTimings[1]!.classList.contains('sw-tray-row-elapsed-warn'), false)
      assert.equal(rowTimings[2]!.textContent, '12s')

      // Clicking expanded row with timing badge still opens ConversationDrawer
      await act(async () => {
        trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-main')!.click()
      })
      assert.deepEqual(traySpy.drawerCalls, [61])
    } finally {
      trayMount.unmount()
    }

    // 2) SwarmWorkbenchPanel: active group elapsed, member timing modes, post offsets, zero progress bars
    const panelSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const panelMount = await mount(
      panelSpy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      DEFAULT_CONVERSATIONS,
      { serverNowMs: NOW },
    )
    try {
      const groupElapsed = panelMount.host.querySelector<HTMLElement>('.sw-panel-elapsed')
      assert.equal(groupElapsed?.textContent, '3m05s')

      const memberItems = [...panelMount.host.querySelectorAll<HTMLElement>('.sw-panel-member-item')]
      const elapsedByName = new Map<string, HTMLElement | null>()
      for (const item of memberItems) {
        const name = item.querySelector('.sw-panel-member-name')?.textContent ?? ''
        elapsedByName.set(name, item.querySelector<HTMLElement>('.sw-panel-member-elapsed'))
      }
      assert.equal(elapsedByName.get('@blocker-w')?.textContent, '等待审批 25s · 累计 1m30s')
      assert.equal(elapsedByName.get('@blocker-w')?.classList.contains('sw-panel-member-elapsed-warn'), true)
      assert.equal(elapsedByName.get('@first-turn')?.textContent, '12s', '首轮去重不重复显示本轮与累计')
      assert.equal(elapsedByName.get('@multi-turn')?.textContent, '本轮 12s · 累计 57s')
      assert.equal(elapsedByName.get('@done-w')?.textContent, '42.5s')
      assert.equal(elapsedByName.get('@idle-zero'), null, '空闲且累计为 0 的成员诚实省略耗时')

      // No progress bars or proportion bars rendered anywhere
      assert.equal(panelMount.host.querySelectorAll('progress, [role="progressbar"]').length, 0)

      // Post relative offsets next to #seq, and #seq stays title-less
      const post1 = panelMount.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"]')!
      const post2 = panelMount.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"]')!
      const time1 = post1.querySelector<HTMLElement>('.sw-panel-post-time')
      const time2 = post2.querySelector<HTMLElement>('.sw-panel-post-time')
      assert.equal(time1?.textContent, '+00:15')
      assert.match(time1?.getAttribute('aria-label') ?? '', /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      assert.equal(time2?.textContent, '+1:02:15')
      assert.equal(post1.querySelector('.sw-panel-post-seq')?.getAttribute('title'), null)
    } finally {
      panelMount.unmount()
    }

    // 3) Closed group: group elapsed freezes (does NOT disappear) and archived members show solidified runtime even offline
    const closedBoard = boardViewFixture({
      group: {
        id: 'grp-closed',
        title: '已结单耗时组',
        coordinatorConversationId: 50,
        status: 'closed',
        activeWorkerCount: 0,
        headSeq: 1,
        createdAt: T0,
        updatedAt: T0 + 125_000,
        closedAt: T0 + 125_000,
      },
      members: [
        {
          name: 'author',
          conversationId: 901,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'archived',
          archivedAt: T0 + 120_000,
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 1_000,
          liveState: 'missing',
          runDurationMs: 65_000,
          turnCount: 3,
        },
      ],
      posts: [
        {
          seq: 1,
          groupId: 'grp-closed',
          from: 'author',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'done',
          refs: [],
          body: 'Archived result',
          createdAt: T0 + 120_000,
        },
      ],
      activeWorkingMembers: [],
    })
    setStubState({
      docs: { index: { workers: [], groups: [closedBoard.group] }, 'board-badges': { byConversation: {} } },
      sessionDocs: {},
    })
    const closedSpy = makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId: string) => (actionId === 'board_status' ? closedBoard : {}),
    })
    const closedPanel = await mount(
      closedSpy,
      e(components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] }),
      }),
      [convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] })],
    )
    try {
      const frozenGroupElapsed = closedPanel.host.querySelector<HTMLElement>('.sw-panel-elapsed')
      assert.equal(frozenGroupElapsed?.textContent, '2m5s', '结单后组总耗时冻结展示，不再消失')
      const archivedMemberElapsed = closedPanel.host.querySelector<HTMLElement>('.sw-panel-member-elapsed')
      assert.equal(archivedMemberElapsed?.textContent, '1m5s', '会话缺失的已归档成员仍展示固化运行耗时')
      assert.equal(closedPanel.host.querySelector('.sw-panel-post-time')?.textContent, '+02:00')
    } finally {
      closedPanel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：接收 openWorkbench params.postSeq 时自动高亮对应黑板帖并在超出折叠尾窗时展开历史', { timeout: 60_000 }, async () => {
    const eightPosts = Array.from({ length: 8 }, (_, idx) => ({
      seq: idx + 1,
      groupId: 'grp-live',
      from: idx === 0 ? 'coordinator' : 'author',
      to: ['verifier'],
      resolvedTargets: ['verifier'],
      wake: true,
      kind: idx === 0 ? 'brief' : 'comment',
      refs: [],
      body: `Post body #${idx + 1}`,
      createdAt: 1000 + idx * 1000,
    }))
    const longBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证 postSeq 深链定位',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 8,
        createdAt: 1000,
        updatedAt: 9000,
      },
      posts: eightPosts,
    })
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': longBoard },
    })

    const spy = makeSpyCtx({ conversationId: 50 })
    const mounted = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }),
        params: { groupId: 'grp-live', postSeq: 2 },
      }),
    )
    try {
      const targetPost = mounted.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"]')
      assert.ok(targetPost !== null, '超出最近 6 条折叠窗口的 #2 自动展开历史后可见')
      assert.ok(targetPost.classList.contains('sw-panel-post-highlighted'), '目标帖 #2 获得高亮类')
      const otherPost = mounted.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="8"]')
      assert.ok(otherPost !== null && !otherPost.classList.contains('sw-panel-post-highlighted'), '非目标帖不高亮')
    } finally {
      mounted.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：close_group 返回 uncleanedWorktrees 时关闭弹窗并触发 warning 通知', { timeout: 60_000 }, async () => {
    const board = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证非 Linux 结单提示',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 1,
        headSeq: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
      activeWorkingMembers: [],
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
          body: 'Work in worktree.',
          createdAt: 1000,
        },
      ],
    })
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })

    const spy = makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input, options) => {
        spy.actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        if (actionId === 'close_group') {
          return {
            closed: true,
            groupId: 'grp-live',
            retainedWorktrees: [],
            uncleanedWorktrees: [
              {
                memberName: 'author',
                nodeId: 'local',
                worktreeId: 'local:D:\\wt\\a',
                branch: 'helmx/spawn-1',
                path: 'D:\\wt\\a',
                reason: 'usage_unverifiable',
              },
            ],
          }
        }
        return {}
      },
    })
    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const closeBtn = panel.host.querySelector<HTMLButtonElement>('.sw-panel-close-btn')
      assert.ok(closeBtn !== null)
      await act(async () => {
        closeBtn.click()
      })
      const confirmBtn = document.body.querySelector<HTMLButtonElement>('.sw-close-dialog-confirm')
      assert.ok(confirmBtn !== null)
      await act(async () => {
        confirmBtn.click()
      })
      assert.ok(document.body.querySelector('.sw-close-dialog-confirm') === null, '结单成功后弹窗关闭')
      assert.equal(spy.notifyCalls.length, 1)
      assert.equal(spy.notifyCalls[0]!.tone, 'warning')
      assert.match(spy.notifyCalls[0]!.message, /--allow-unverified-usage/)
    } finally {
      panel.unmount()
    }
    resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel 与 SwarmPostPeekPopover 向 MarkdownView 传入发帖者 conversationId（worker 传成员会话、coordinator 传主控会话）并保留 #seq 预览', { timeout: 60_000 }, async () => {
    const board = boardViewFixture()
    const posts = board.posts as Array<Record<string, unknown>>
    posts[0]!['body'] = 'Coordinator brief referencing #2 and [file](/repo/README.md).'
    posts[1]!['body'] = 'Worker finding at [conversations.ts:137](/repo-wt/author/conversations.ts:137), see #1.'
    setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })
    const spy = makeSpyCtx({ conversationId: 50 })
    const panel = await mount(
      spy,
      e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const seq1Body = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"] .sw-panel-post-text')
      const seq2Body = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-text')
      assert.ok(seq1Body !== null && seq2Body !== null)
      assert.equal(seq1Body.getAttribute('data-md-conv-id'), '50', 'coordinator 帖传主控会话 ID')
      assert.equal(seq2Body.getAttribute('data-md-conv-id'), '51', 'worker 帖传作者成员会话 ID')

      // 点击 #2 帖子中的 #1 内联引用 -> 浮卡内的 MarkdownView 传被预览帖(#1 coordinator) 的 conversationId=50
      const ref1 = seq2Body.querySelector<HTMLAnchorElement>('a[href="#swarm-post-1"]')
      assert.ok(ref1 !== null)
      await act(async () => {
        ref1.click()
      })
      const peekBody = panel.host.querySelector<HTMLElement>('.sw-peek-popover .sw-panel-post-text')
      assert.ok(peekBody !== null, '点击 #1 展开 peek 浮卡')
      assert.equal(peekBody.getAttribute('data-md-conv-id'), '50', 'peek 浮卡按被预览帖发帖者传 conversationId')
    } finally {
      panel.unmount()
    }
    resetDefaultStubs()
  })
})
