/**
 * `builtin:changes` compiled client TSX interactive DOM tests:
 * - Zero Emoji across rendered Inspector screen, Workbench panel, and Slots;
 * - `ChangesInspectorScreen`: default workspace selection, scope switching
 *   (`working` / `unpushed` / `commit` / `since`), on-demand single-file load
 *   (`diff`, `untracked`, `binary`, `too_large`), baseline comparison button,
 *   ask-about-file submission, and worktree switching (`wt`) + review request;
 * - `ChangesWorkbenchPanel`: lazy summary load on mount, file click -> split screen,
 *   and related worktree split inspect button;
 * - `SwarmWorktreeActionsSlot`: compact split-inspect & retained review submission.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import * as React from 'react'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  PluginSummary,
  ScreenProps,
} from '@helmx/protocol/browser'
import type { PluginClientHostPort } from '@helmx/plugin-client'
import {
  PluginClientContext,
  PluginClientHostContext,
  ScreenParamsContext,
  resolveLocalizedText,
  type HelmxLocale,
} from '@helmx/plugin-client'
import {
  importBuiltinClientModule,
  mountSharedPluginNamespaces,
} from './helpers/builtin-clients.js'
import { flushMacrotask } from './helpers/dom-harness.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface ChangesClientComponents {
  ChangesInspectorScreen: (p: Partial<ScreenProps>) => React.ReactElement
  ChangesWorkbenchPanel: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmWorktreeActionsSlot: (p: {
    worktreeId?: string
    path?: string
    branch?: string
    nodeId?: string
    parentConversationId?: number
    mode?: 'member' | 'retained' | 'snapshot'
  }) => React.ReactElement
}

let components: ChangesClientComponents

function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `Main session ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/repo/main',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== undefined, `Expected button containing "${text}", got: ${buttons.map((b) => b.textContent).join(' | ')}`)
  return found
}

interface HarnessLogs {
  actions: Array<{ pluginId: string; actionId: string; input: unknown }>
  submissions: Array<{ conversationId: number; text: string; whenBusy?: string }>
  screens: string[]
  splitScreens: string[]
  notices: Array<{ message: string; tone: string }>
}

function createChangesHarness(options: {
  locale?: HelmxLocale
  conversations?: ConversationSummary[]
  plugins?: PluginSummary[]
  onAction: (pluginId: string, actionId: string, input: Record<string, unknown>) => unknown
}) {
  const logs: HarnessLogs = {
    actions: [],
    submissions: [],
    screens: [],
    splitScreens: [],
    notices: [],
  }
  const conversations = options.conversations ?? [makeConv(1)]
  const plugins: PluginSummary[] = options.plugins ?? [
    {
      id: 'builtin:changes',
      name: { en: 'Changes', 'zh-CN': '改动' },
      version: '0.1.0',
      enabled: true,
      builtin: true,
      locked: false,
      status: 'active',
    } as unknown as PluginSummary,
    {
      id: 'builtin:worktree',
      name: { en: 'Managed Worktrees', 'zh-CN': '受管工作树' },
      version: '0.1.0',
      enabled: true,
      builtin: true,
      locked: false,
      status: 'active',
    } as unknown as PluginSummary,
  ]
  const noopUnsub = () => () => {}
  const emptyAsks: [] = []
  const pluginsSnapshot = { plugins, screens: [] }
  const docState = { hasValue: false, deleted: false, connected: true, value: undefined }

  const port: PluginClientHostPort = {
    getAuthenticated: () => true,
    subscribeAuthenticated: noopUnsub,
    getTheme: () => 'dark',
    getLocale: () => options.locale ?? 'en',
    subscribePrefs: noopUnsub,
    getConversations: () => conversations,
    subscribeConversations: noopUnsub,
    getConversationSummary: (id) => conversations.find((c) => c.id === id),
    subscribeConversationSummary: noopUnsub,
    getConversationDetail: () => undefined,
    subscribeConversationDetail: noopUnsub,
    getConversationLive: () => undefined,
    subscribeConversationLive: noopUnsub,
    getConversationPendingAsks: () => emptyAsks,
    subscribeConversationPendingAsks: noopUnsub,
    getLoadError: () => undefined,
    subscribeLoadError: noopUnsub,
    getPluginsSnapshot: () => pluginsSnapshot,
    subscribePlugins: noopUnsub,
    getPluginDocValue: () => undefined,
    subscribePluginDoc: noopUnsub,
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    subscribeSessionDoc: noopUnsub,
    getSessionDocState: () => docState,
    invokePluginAction: async (pluginId, actionId, input) => {
      const rec = (input ?? {}) as Record<string, unknown>
      logs.actions.push({ pluginId, actionId, input: rec })
      return options.onAction(pluginId, actionId, rec)
    },
    submitConversationInput: async (conversationId, input) => {
      logs.submissions.push({ conversationId, text: input.text, whenBusy: input.whenBusy })
    },
    openTarget: (target, opts) => {
      if (opts?.split === true) logs.splitScreens.push(target)
      else logs.screens.push(target)
    },
    openConversationDrawer: () => {},
    openArtifactPreview: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    notify: (message, tone) => {
      logs.notices.push({ message, tone })
    },
    loadConversationDetail: () => undefined,
    slots: {
      collectItems: () => [],
      renderItem: () => null,
    },
    markdown: {
      view: ({ text }: { text: string }) => e('div', null, text),
      codeBlock: ({ code }: { code: string }) => e('pre', null, code),
    },
  }

  const ctx: PluginClientContextType = {
    pluginId: 'builtin:changes',
    callAction: (actionId, input, callOpts) =>
      port.invokePluginAction(callOpts?.pluginId ?? 'builtin:changes', actionId, input, callOpts?.conversationId),
    fetchRoute: async () => {
      throw new Error('fetchRoute unused')
    },
    submitInput: (text, submitOpts) =>
      port.submitConversationInput(submitOpts?.conversationId ?? 1, {
        text,
        origin: 'human',
        whenBusy: submitOpts?.whenBusy,
      }),
    openScreen: (target) => port.openTarget(target),
    openSplitScreen: (target) => port.openTarget(target, { split: true }),
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message, tone = 'info') => port.notify(message, tone),
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    locale: options.locale ?? 'en',
    translate: (text) => resolveLocalizedText(text, options.locale ?? 'en'),
  }

  const mount = async (element: React.ReactElement, initialParams?: Record<string, string>) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let setExternalParams: ((next: Record<string, string>) => void) | undefined

    function Wrapper() {
      const [params, setParamsState] = useState<Record<string, string>>(() => ({ ...(initialParams ?? {}) }))
      setExternalParams = setParamsState
      const scope = {
        params,
        isSplit: false,
        setParams: (patch: Record<string, string | undefined>) => {
          setParamsState((prev) => {
            const next = { ...prev }
            for (const [k, v] of Object.entries(patch)) {
              if (v === undefined || v === '') delete next[k]
              else next[k] = v
            }
            return next
          })
        },
      }
      return e(
        PluginClientHostContext.Provider,
        { value: port },
        e(
          PluginClientContext.Provider,
          { value: ctx },
          e(ScreenParamsContext.Provider, { value: scope }, element),
        ),
      )
    }

    await act(async () => {
      root.render(e(Wrapper))
    })
    await act(async () => {
      await flushMacrotask(0)
    })

    return {
      container,
      setParams: async (next: Record<string, string>) => {
        await act(async () => {
          setExternalParams?.(next)
        })
        await act(async () => {
          await flushMacrotask(0)
        })
      },
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  return { logs, mount }
}

const SAMPLE_WORKSPACE_WORKING = {
  isGitRepo: true,
  nodeId: 'local',
  cwd: '/repo/main',
  repoRoot: '/repo/main',
  currentBranch: 'main',
  currentHead: 'aaaa111122223333444455556666777788889999',
  upstream: 'origin/main',
  commitsAheadOfUpstream: 1,
  commitsBehindUpstream: 0,
  scope: 'working',
  diffBase: 'HEAD',
  commits: [
    {
      oid: 'aaaa111122223333444455556666777788889999',
      shortOid: 'aaaa111',
      subject: 'feat: unpushed work',
      author: 'Dev',
      committedAt: 1_700_000_000_000,
      unpushed: true,
    },
  ],
  commitsTruncated: false,
  summary: { totalFiles: 3, additions: 4, deletions: 1, untrackedCount: 1, dirtyFileCount: 3 },
  files: [
    { path: 'src/app.ts', status: 'M', additions: 4, deletions: 1, binary: false, untracked: false },
    { path: 'assets/logo.png', status: 'M', additions: 0, deletions: 0, binary: true, untracked: false },
    { path: 'dist/bundle.min.js', status: 'M', additions: 5200, deletions: 0, binary: false, untracked: false },
  ],
  filesTruncated: false,
}

const SAMPLE_WORKTREE_INSPECT = {
  record: {
    id: 'local:/repo/.helmx-worktrees/wt-1',
    nodeId: 'local',
    repoRoot: '/repo/main',
    path: '/repo/.helmx-worktrees/wt-1',
    branch: 'helmx/spawn-wt1',
    baseCommit: 'bbbb111122223333444455556666777788889999',
    dirtySource: false,
    parentConversationId: 1,
    conversationId: 8,
    origin: 'native',
    status: 'active',
    createdAt: 1000,
  },
  exists: true,
  currentBranch: 'helmx/spawn-wt1',
  currentHead: 'cccc111122223333444455556666777788889999',
  commitsAhead: 1,
  unmergedCommits: 1,
  diffBase: 'baseCommit',
  scope: 'all',
  commits: [
    {
      oid: 'cccc111122223333444455556666777788889999',
      shortOid: 'cccc111',
      subject: 'feat: worktree patch',
      author: 'Agent',
      committedAt: 1_700_000_500_000,
    },
  ],
  commitsTruncated: false,
  summary: { totalFiles: 1, additions: 3, deletions: 0, untrackedCount: 0, dirtyFileCount: 0 },
  files: [{ path: 'wt-file.ts', status: 'A', additions: 3, deletions: 0, binary: false, untracked: false }],
  filesTruncated: false,
}

describe('changes-client-interactions', { timeout: 60_000 }, () => {
  before(async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    const [screenMod, wbMod, slotsMod] = await Promise.all([
      importBuiltinClientModule('builtin:changes', 'screen.tsx'),
      importBuiltinClientModule('builtin:changes', 'workbench.tsx'),
      importBuiltinClientModule('builtin:changes', 'slots.tsx'),
    ])
    components = {
      ChangesInspectorScreen: screenMod['ChangesInspectorScreen'] as ChangesClientComponents['ChangesInspectorScreen'],
      ChangesWorkbenchPanel: wbMod['ChangesWorkbenchPanel'] as ChangesClientComponents['ChangesWorkbenchPanel'],
      SwarmWorktreeActionsSlot: slotsMod['SwarmWorktreeActionsSlot'] as ChangesClientComponents['SwarmWorktreeActionsSlot'],
    }
  }, TIMEOUT)

  test('ChangesInspectorScreen loads workspace summary & per-file diff/binary/too_large/untracked, switches scopes and worktrees with zero Emoji', TIMEOUT, async () => {
    const h = createChangesHarness({
      onAction: (pluginId, actionId, input) => {
        if (pluginId === 'builtin:worktree' && actionId === 'list_worktrees') {
          return { worktrees: [SAMPLE_WORKTREE_INSPECT.record] }
        }
        if (pluginId === 'builtin:worktree' && actionId === 'inspect_worktree') {
          return SAMPLE_WORKTREE_INSPECT
        }
        if (pluginId === 'builtin:worktree' && actionId === 'inspect_worktree_file') {
          return {
            kind: 'diff',
            filePath: String(input['filePath']),
            status: 'A',
            additions: 3,
            deletions: 0,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1,1 @@',
                rows: [{ kind: 'add', newLine: 1, text: 'export const wt = 1' }],
              },
            ],
          }
        }
        if (actionId === 'inspect_workspace') {
          if (input['scope'] === 'unpushed') {
            return {
              ...SAMPLE_WORKSPACE_WORKING,
              scope: 'unpushed',
              diffBase: 'upstream',
              files: [{ path: 'unpushed-only.ts', status: 'A', additions: 5, deletions: 0, binary: false, untracked: false }],
            }
          }
          if (input['scope'] === 'since') {
            return {
              ...SAMPLE_WORKSPACE_WORKING,
              scope: 'since',
              diffBase: 'baseCommit',
              baseCommit: input['baseCommit'],
            }
          }
          return SAMPLE_WORKSPACE_WORKING
        }
        if (actionId === 'inspect_workspace_file') {
          const filePath = String(input['filePath'])
          if (filePath === 'assets/logo.png') {
            return { kind: 'binary', filePath, status: 'M', size: 2048 }
          }
          if (filePath === 'dist/bundle.min.js') {
            return { kind: 'too_large', filePath, status: 'M', reason: 'line_budget_exceeded', additions: 5200, deletions: 0 }
          }
          if (filePath === 'unpushed-only.ts') {
            return {
              kind: 'untracked',
              filePath,
              status: 'U',
              additions: 1,
              deletions: 0,
              hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, header: '@@ -0,0 +1,1 @@', rows: [{ kind: 'add', newLine: 1, text: 'unpushed line' }] }],
            }
          }
          return {
            kind: 'diff',
            filePath,
            status: 'M',
            additions: 1,
            deletions: 1,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                header: '@@ -1,1 +1,1 @@',
                rows: [
                  { kind: 'remove', oldLine: 1, text: 'const x = oldVal' },
                  { kind: 'add', newLine: 1, text: 'const x = newVal' },
                ],
              },
            ],
          }
        }
        return {}
      },
    })

    const ui = await h.mount(e(components.ChangesInspectorScreen, {}))
    try {
      const text = ui.container.textContent ?? ''
      assert.equal(EMOJI_RE.test(text), false, 'Inspector UI must stay Emoji-free')
      assert.match(text, /const x = oldVal/)
      assert.match(text, /const x = newVal/)
      assert.match(text, /1 unpushed/)

      // Click binary file
      await act(async () => { buttonByText(ui.container, 'logo.png').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /Binary file/)

      // Click too_large file
      await act(async () => { buttonByText(ui.container, 'bundle.min.js').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /Single-file diff exceeds preview budget/)
      assert.match(ui.container.textContent ?? '', /\+5200/)

      // Ask session about file
      await act(async () => { buttonByText(ui.container, 'Ask session about file').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.equal(h.logs.submissions.length, 1)
      assert.match(h.logs.submissions[0]!.text, /dist\/bundle\.min\.js/)

      // Switch to Compare to current (`since` scope)
      await act(async () => { buttonByText(ui.container, 'Compare to current').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.ok(h.logs.actions.some((a) => a.actionId === 'inspect_workspace' && (a.input as { scope?: string }).scope === 'since'))

      // Switch to unpushed scope
      await act(async () => { buttonByText(ui.container, 'Unpushed').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /unpushed-only\.ts/)
      assert.match(ui.container.textContent ?? '', /Untracked file \(full bounded preview\)/)

      // Switch to managed worktree via params (`wt`)
      await ui.setParams({ wt: SAMPLE_WORKTREE_INSPECT.record.id })
      assert.match(ui.container.textContent ?? '', /export const wt = 1/)
      await act(async () => { buttonByText(ui.container, 'Ask main to review & merge').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.equal(h.logs.submissions.length, 2)
      assert.match(h.logs.submissions[1]!.text, /helmx\/spawn-wt1/)
    } finally {
      ui.unmount()
    }
  })

  test('ChangesWorkbenchPanel & SwarmWorktreeActionsSlot open split inspector and submit retained coordinator review', TIMEOUT, async () => {
    const conv = makeConv(1)
    const h = createChangesHarness({
      conversations: [conv],
      onAction: (pluginId, actionId) => {
        if (pluginId === 'builtin:changes' && actionId === 'inspect_workspace') return SAMPLE_WORKSPACE_WORKING
        if (pluginId === 'builtin:worktree' && actionId === 'list_worktrees') {
          return { worktrees: [SAMPLE_WORKTREE_INSPECT.record] }
        }
        if (pluginId === 'builtin:worktree' && actionId === 'inspect_worktree') {
          return SAMPLE_WORKTREE_INSPECT
        }
        return {}
      },
    })

    const wb = await h.mount(
      e('div', null,
        e(components.ChangesWorkbenchPanel, { conversation: conv }),
        e(components.SwarmWorktreeActionsSlot, {
          worktreeId: SAMPLE_WORKTREE_INSPECT.record.id,
          path: SAMPLE_WORKTREE_INSPECT.record.path,
          branch: SAMPLE_WORKTREE_INSPECT.record.branch,
          nodeId: 'local',
          parentConversationId: 1,
          mode: 'retained',
        }),
      ),
    )
    try {
      const text = wb.container.textContent ?? ''
      assert.equal(EMOJI_RE.test(text), false, 'Workbench & Swarm slot must stay Emoji-free')
      assert.match(text, /Workspace changes/)
      assert.match(text, /helmx\/spawn-wt1/)

      // Click workspace file row -> opens split inspector at file
      await act(async () => { buttonByText(wb.container, 'app.ts').click() })
      assert.equal(h.logs.splitScreens.length, 1)
      assert.match(h.logs.splitScreens[0]!, /conv=1/)
      assert.match(h.logs.splitScreens[0]!, /file=src%2Fapp\.ts/)

      // Click Swarm retained review button -> calls inspect_worktree lazily & submits to coordinator
      const swarmReviewBtn = wb.container.querySelector('button[aria-label="Ask coordinator to review & merge"]') as HTMLButtonElement
      assert.ok(swarmReviewBtn !== null)
      await act(async () => { swarmReviewBtn.click() })
      await act(async () => { await flushMacrotask(0) })
      assert.equal(h.logs.submissions.length, 1)
      assert.match(h.logs.submissions[0]!.text, /helmx\/spawn-wt1/)
    } finally {
      wb.unmount()
    }
  })
})
