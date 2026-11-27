/**
 * `builtin:changes` compiled client TSX interactive DOM tests:
 * - Zero Emoji across rendered Inspector screen, Workbench panel, and Slots;
 * - Pure read-only guarantee: zero session submissions, cleanup slots, or merge controls;
 * - `ChangesInspectorScreen`: `<Screen actions>` Refresh, `< 8` vs `>= 8` SearchBox threshold,
 *   scope switching (`working` / `unpushed` / `commit`) + compact Commit `Select`,
 *   worktree (`wt`) `committed` Commit `Select`, on-demand `diff`/`untracked`/`binary`/`too_large`,
 *   URL `sp.file` list/diff state transitions (`push` on file click, `replace` on prev/next step,
 *   clear on `← Files`, single-file direct diff without `.chg-is-narrow-diff`),
 *   `DiffViewer` wrap toggle (`wrap-text`) and single sticky gutter span (`.chg-diff-num-single`);
 * - `ChangesWorkbenchPanel` & `SwarmWorktreeActionsSlot`: unified read-only single entry opening split preview.
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
import { resolveLocalizedText, type HelmxLocale } from '@helmx/ui'
import { PluginClientContext, PluginClientHostContext, ScreenParamsContext } from '@helmx/plugin-client'
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
  paramUpdates: Array<{ patch: Record<string, string | undefined>; push?: boolean }>
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
    paramUpdates: [],
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
        setParams: (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => {
          logs.paramUpdates.push({ patch, ...(opts?.push !== undefined ? { push: opts.push } : {}) })
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
    {
      oid: '9999111122223333444455556666777788880000',
      shortOid: '9999111',
      subject: 'chore: earlier commit',
      author: 'Dev',
      committedAt: 1_699_999_000_000,
      unpushed: false,
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

  test('ChangesInspectorScreen：纯只读检视、URL sp.file 窄屏导航、Commit 下拉框、换行切换与 <8 搜索框阈值', TIMEOUT, async () => {
    let summaryRefreshCount = 0
    const h = createChangesHarness({
      onAction: (pluginId, actionId, input) => {
        if (pluginId === 'builtin:worktree' && actionId === 'list_worktrees') {
          return { worktrees: [SAMPLE_WORKTREE_INSPECT.record] }
        }
        if (pluginId === 'builtin:worktree' && actionId === 'inspect_worktree') {
          return {
            ...SAMPLE_WORKTREE_INSPECT,
            scope: input['scope'] ?? 'all',
            ...(input['commit'] !== undefined ? { selectedCommit: input['commit'] } : {}),
          }
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
          summaryRefreshCount += 1
          if (input['scope'] === 'unpushed') {
            return {
              ...SAMPLE_WORKSPACE_WORKING,
              scope: 'unpushed',
              diffBase: 'upstream',
              files: [{ path: 'unpushed-only.ts', status: 'A', additions: 5, deletions: 0, binary: false, untracked: false }],
            }
          }
          if (input['scope'] === 'commit') {
            return {
              ...SAMPLE_WORKSPACE_WORKING,
              scope: 'commit',
              diffBase: 'commit',
              selectedCommit: String(input['commit'] ?? SAMPLE_WORKSPACE_WORKING.commits[0]!.oid),
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

      // No write / cleanup / prompt buttons rendered
      for (const forbidden of ['Ask session about file', 'Compare to current', 'Ask main to review', 'Clean up']) {
        assert.equal(text.includes(forbidden), false, `Must omit write action UI: ${forbidden}`)
      }

      // `<Screen actions>` provides Refresh button and `<Screen toolbar>` mounts unified ScreenToolbar
      const refreshBtn = ui.container.querySelector('.screen-header button[aria-label="Refresh"]') as HTMLButtonElement | null
      assert.ok(refreshBtn !== null, 'Refresh action must mount inside Screen header actions')
      assert.ok(ui.container.querySelector('.screen-toolbar-bar .chg-toolbar') !== null, 'Toolbar must mount via unified <Screen toolbar>')
      const beforeRefreshCount = summaryRefreshCount
      await act(async () => { refreshBtn.click() })
      await act(async () => { await flushMacrotask(0) })
      assert.ok(summaryRefreshCount > beforeRefreshCount)

      // 3 files (< 8) -> SearchBox hidden & no 220px commits box & no Commit Select in working scope
      assert.ok(ui.container.querySelector('.chg-sidebar-search') === null)
      assert.ok(ui.container.querySelector('.chg-commits-section') === null)
      assert.ok(ui.container.querySelector('button[aria-label="Inspect commit"]') === null)

      // Multi-file initial state without sp.file -> chg-mode-list, no chg-is-narrow-diff, no mobile back button
      const screenEl = ui.container.querySelector('.chg-screen')
      const stageEl = ui.container.querySelector('.chg-split-stage')
      assert.ok(screenEl !== null && stageEl !== null)
      assert.equal(screenEl.classList.contains('chg-is-narrow-diff'), false)
      assert.equal(stageEl.classList.contains('chg-mode-list'), true)
      assert.ok(ui.container.querySelector('.chg-mobile-back') === null)

      // DiffViewer renders single sticky line number column alongside dual gutters & default horizontal scroll
      assert.ok(ui.container.querySelectorAll('.chg-diff-num-single').length > 0)
      const surfaceBefore = ui.container.querySelector('.chg-diff-surface')
      assert.ok(surfaceBefore !== null)
      assert.equal(surfaceBefore.classList.contains('is-wrap'), false)
      const wrapBtn = ui.container.querySelector('button[aria-label="Wrap lines"]') as HTMLButtonElement | null
      assert.ok(wrapBtn !== null)
      assert.equal(wrapBtn.getAttribute('aria-pressed'), 'false')
      await act(async () => { wrapBtn.click() })
      const wrapBtnActive = ui.container.querySelector('button[aria-label="Horizontal scroll"]') as HTMLButtonElement | null
      assert.ok(wrapBtnActive !== null)
      assert.equal(wrapBtnActive.getAttribute('aria-pressed'), 'true')
      assert.equal(ui.container.querySelector('.chg-diff-surface')?.classList.contains('is-wrap'), true)

      // Click binary file -> pushes `file` to URL -> switches to chg-mode-diff + chg-is-narrow-diff + shows ← Files & 2/3 pager
      await act(async () => { buttonByText(ui.container, 'logo.png').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /Binary file/)
      assert.equal(screenEl.classList.contains('chg-is-narrow-diff'), true)
      assert.equal(stageEl.classList.contains('chg-mode-diff'), true)
      assert.equal(ui.container.querySelector('.chg-file-pager-count')?.textContent, '2/3')
      assert.ok(ui.container.querySelector('.chg-mobile-back') !== null)
      const filePushUpdate = h.logs.paramUpdates.find((u) => u.patch['file'] === 'assets/logo.png')
      assert.equal(filePushUpdate?.push, true, 'Opening a file from list pushes history so swipe-back returns to list')

      // Next file (`>`) uses replace (push !== true) and advances to too_large file
      const nextBtn = ui.container.querySelector('button[aria-label="Next file"]') as HTMLButtonElement | null
      assert.ok(nextBtn !== null)
      await act(async () => { nextBtn.click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /Single-file diff exceeds preview budget/)
      assert.match(ui.container.textContent ?? '', /\+5200/)
      assert.equal(ui.container.querySelector('.chg-file-pager-count')?.textContent, '3/3')
      const stepUpdate = h.logs.paramUpdates.at(-1)
      assert.equal(stepUpdate?.patch['file'], 'dist/bundle.min.js')
      assert.notEqual(stepUpdate?.push, true, 'Stepping next/prev file replaces URL instead of pushing history')

      // Clicking `← Files` clears sp.file and restores chg-mode-list
      const backBtn = ui.container.querySelector('.chg-mobile-back') as HTMLButtonElement
      await act(async () => { backBtn.click() })
      await act(async () => { await flushMacrotask(0) })
      assert.equal(stageEl.classList.contains('chg-mode-list'), true)
      assert.equal(screenEl.classList.contains('chg-is-narrow-diff'), false)

      // Switch to `Commits` scope -> compact Commit `Select` renders in toolbar
      await act(async () => { buttonByText(ui.container, 'Commits').click() })
      await act(async () => { await flushMacrotask(0) })
      const commitSelectTrigger = ui.container.querySelector('button[aria-label="Inspect commit"]') as HTMLButtonElement | null
      assert.ok(commitSelectTrigger !== null, 'Commit Select must appear in commit scope')
      assert.match(commitSelectTrigger.textContent ?? '', /aaaa111/)

      // Switch to `Unpushed` scope -> single-file repo skips list on narrow containers without hiding topbar
      await act(async () => { buttonByText(ui.container, 'Unpushed').click() })
      await act(async () => { await flushMacrotask(0) })
      assert.match(ui.container.textContent ?? '', /unpushed-only\.ts/)
      assert.match(ui.container.textContent ?? '', /Untracked file \(full bounded preview\)/)
      assert.equal(stageEl.classList.contains('chg-mode-diff'), true)
      assert.equal(screenEl.classList.contains('chg-is-narrow-diff'), false, 'Single-file mode keeps topbar visible')
      assert.ok(ui.container.querySelector('.chg-mobile-back') === null)

      // Switch to managed worktree (`wt`) + `Committed` scope -> Commit Select shows `All committed`
      await ui.setParams({ wt: SAMPLE_WORKTREE_INSPECT.record.id, scope: 'committed' })
      assert.match(ui.container.textContent ?? '', /export const wt = 1/)
      const wtCommitSelect = ui.container.querySelector('button[aria-label="Inspect commit"]')
      assert.ok(wtCommitSelect !== null)
      assert.match(wtCommitSelect.textContent ?? '', /All committed/)
      assert.equal(h.logs.submissions.length, 0, 'Read-only screen must never submit prompts')
    } finally {
      ui.unmount()
    }
  })

  test('ChangesInspectorScreen：文件数 >= 8 时展示搜索框并实时筛选', TIMEOUT, async () => {
    const eightFiles = Array.from({ length: 8 }, (_, idx) => ({
      path: `src/file-${idx + 1}.ts`,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      untracked: false,
    }))
    const h = createChangesHarness({
      onAction: (_pluginId, actionId) => {
        if (actionId === 'inspect_workspace') {
          return {
            ...SAMPLE_WORKSPACE_WORKING,
            summary: { totalFiles: 8, additions: 8, deletions: 0, untrackedCount: 0, dirtyFileCount: 8 },
            files: eightFiles,
          }
        }
        return { kind: 'unchanged', filePath: 'src/file-1.ts' }
      },
    })
    const ui = await h.mount(e(components.ChangesInspectorScreen, {}))
    try {
      const searchInput = ui.container.querySelector('.chg-sidebar-search input[aria-label="Filter changed files…"]') as HTMLInputElement | null
      assert.ok(searchInput !== null, 'SearchBox should appear once changed files >= 8')
      assert.equal(ui.container.querySelectorAll('.chg-file-row').length, 8)
    } finally {
      ui.unmount()
    }
  })

  test('ChangesWorkbenchPanel & SwarmWorktreeActionsSlot：纯只读单一打开入口与文件跳转，无清理或审阅提交按钮', TIMEOUT, async () => {
    const conv = makeConv(1)
    const h = createChangesHarness({
      conversations: [conv],
      onAction: (pluginId, actionId) => {
        if (pluginId === 'builtin:changes' && actionId === 'inspect_workspace') return SAMPLE_WORKSPACE_WORKING
        if (pluginId === 'builtin:worktree' && actionId === 'list_worktrees') {
          return { worktrees: [SAMPLE_WORKTREE_INSPECT.record] }
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
      assert.equal(text.includes('Full view'), false, 'Workbench removes dual Split/Full buttons')
      assert.ok(wb.container.querySelector('button[aria-label="Ask coordinator to review & merge"]') === null)

      // Click unified `Open changes` button
      await act(async () => { buttonByText(wb.container, 'Open changes').click() })
      assert.equal(h.logs.splitScreens.length, 1)
      assert.equal(h.logs.splitScreens[0], 'screen:builtin:changes/inspector?conv=1')

      // Click workspace file row -> opens inspector at file
      await act(async () => { buttonByText(wb.container, 'app.ts').click() })
      assert.equal(h.logs.splitScreens.length, 2)
      assert.match(h.logs.splitScreens[1]!, /conv=1/)
      assert.match(h.logs.splitScreens[1]!, /file=src%2Fapp\.ts/)

      // Click worktree `View changes` row button inside SDK compact List -> omits parent param
      assert.ok(wb.container.querySelector('.helmx-list-compact .helmx-list-row') !== null, 'Worktrees render inside SDK compact List')
      await act(async () => { buttonByText(wb.container, 'View changes').click() })
      assert.equal(h.logs.splitScreens.length, 3)
      assert.equal(h.logs.splitScreens[2], 'screen:builtin:changes/inspector?wt=local%3A%2Frepo%2F.helmx-worktrees%2Fwt-1')

      // Click Swarm read-only diff icon button -> opens inspector & never submits prompts
      const swarmInspectBtn = wb.container.querySelector('button[aria-label="View changes: helmx/spawn-wt1"]') as HTMLButtonElement | null
      assert.ok(swarmInspectBtn !== null)
      await act(async () => { swarmInspectBtn.click() })
      assert.equal(h.logs.splitScreens.length, 4)
      assert.equal(h.logs.splitScreens[3], 'screen:builtin:changes/inspector?wt=local%3A%2Frepo%2F.helmx-worktrees%2Fwt-1')
      assert.equal(h.logs.submissions.length, 0)
    } finally {
      wb.unmount()
    }
  })
})
