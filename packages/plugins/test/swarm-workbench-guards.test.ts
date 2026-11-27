import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureHappyDom, resetHappyDom } from '../../plugin-client/test/helpers/dom-harness.js'
import { CLIENT_SHARED_GLOBALS, compilePluginClientModule } from '@helmx/plugin-build'
import type { ConversationSummary, PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import type { PluginClientHostPort, PluginSessionDocKey } from '@helmx/plugin-client'
import { SWARM_PLUGIN_ID } from '../src/swarm/contracts.js'
import { makeConversationSummary } from './helpers/plugin-test-env.js'

ensureHappyDom()

const baseConv = (id: number, tags: string[] = []): ConversationSummary =>
  makeConversationSummary({ id, title: `Conv ${id}`, tags })

function makeBoardViewDoc(groupId: string, coordinatorConversationId: number) {
  return {
    group: {
      id: groupId,
      title: `Squad ${coordinatorConversationId}`,
      status: 'active',
      coordinatorConversationId,
      activeWorkerCount: 1,
      headSeq: 1,
      createdAt: 1000,
      updatedAt: 1000,
    },
    headline: {
      kind: 'normal',
      tone: 'info',
      text: 'Working',
    },
    members: [
      {
        name: 'worker',
        conversationId: coordinatorConversationId + 1,
        profileId: 'assistant',
        nodeId: 'local',
        cwd: '/tmp/ws',
        access: 'readwrite',
        isolation: 'inherit',
        lifecycle: 'active',
        liveState: 'working',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        createdAt: 1000,
      },
    ],
    activeWorkingMembers: ['worker'],
    posts: [
      {
        seq: 1,
        groupId,
        from: 'coordinator',
        to: ['worker'],
        resolvedTargets: ['worker'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'do task',
        createdAt: 1000,
      },
    ],
  }
}

test('SwarmWorkbenchPanel: unmount and conversationId change guard stale abort_worker / close_group callbacks', { timeout: 60_000 }, async (t) => {
  ensureHappyDom()
  const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
  const React = req('react') as typeof import('react')
  const ReactJsxRuntime = req('react/jsx-runtime') as unknown
  const ReactDOMClient = req('react-dom/client') as {
    createRoot: (container: Element) => { render(node: import('react').ReactNode): void; unmount(): void }
  }
  const LucideReact = req('lucide-react') as unknown
  const HelmxUi = await import('@helmx/ui')
  const HelmxPluginClient = await import('@helmx/plugin-client')
  const { PluginClientContext, PluginClientHostContext } = HelmxPluginClient

  const g = globalThis as Record<string, unknown>
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['@helmx/ui']!] = HelmxUi
  g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] = HelmxPluginClient
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g['IS_REACT_ACT_ENVIRONMENT'] = true

  const cacheDir = mkdtempSync(join(tmpdir(), 'helmx-swarm-guard-'))
  t.after(() => {
    resetHappyDom()
    rmSync(cacheDir, { recursive: true, force: true })
  }, { timeout: 60_000 })

  const here = dirname(fileURLToPath(import.meta.url))
  const compiled = await compilePluginClientModule(
    SWARM_PLUGIN_ID,
    resolve(here, '../src/swarm/client'),
    'workbench.tsx',
    cacheDir,
  )
  const modPath = join(cacheDir, 'workbench.mjs')
  writeFileSync(modPath, compiled.code, 'utf8')
  const { SwarmWorkbenchPanel } = (await import(pathToFileURL(modPath).href)) as {
    SwarmWorkbenchPanel: React.ComponentType<{ conversation?: ConversationSummary }>
  }

  const indexDoc = {
    workers: [],
    groups: [
      { id: 'grp_50', title: 'Squad 50', coordinatorConversationId: 50, status: 'active', activeWorkerCount: 1, headSeq: 1, createdAt: 1000, updatedAt: 1000 },
      { id: 'grp_60', title: 'Squad 60', coordinatorConversationId: 60, status: 'active', activeWorkerCount: 1, headSeq: 1, createdAt: 1000, updatedAt: 1000 },
    ],
  }
  const cachedSessionStates = new Map<string, { value: unknown; hasValue: true; deleted: false; connected: true }>([
    [`${SWARM_PLUGIN_ID}/board-view/50`, { value: makeBoardViewDoc('grp_50', 50), hasValue: true, deleted: false, connected: true }],
    [`${SWARM_PLUGIN_ID}/board-view/60`, { value: makeBoardViewDoc('grp_60', 60), hasValue: true, deleted: false, connected: true }],
  ])
  const emptySessionState = { hasValue: false as const, deleted: false as const, connected: false as const }
  const convs = [
    baseConv(50, ['swarm-coordinator']),
    baseConv(51, ['swarm-worker']),
    baseConv(60, ['swarm-coordinator']),
    baseConv(61, ['swarm-worker']),
  ]
  const noop = () => () => {}
  const hostPort = {
    getAuthenticated: () => false,
    subscribeAuthenticated: noop,
    getTheme: () => 'dark',
    subscribePrefs: noop,
    getConversations: () => convs,
    subscribeConversations: noop,
    getConversationSummary: (id: number) => convs.find((c) => c.id === id),
    subscribeConversationSummary: noop,
    getConversationDetail: () => undefined,
    subscribeConversationDetail: noop,
    getConversationLive: () => undefined,
    subscribeConversationLive: noop,
    getConversationPendingAsks: () => [],
    subscribeConversationPendingAsks: noop,
    getLoadError: () => undefined,
    subscribeLoadError: noop,
    getPluginDocValue: (k: string) => (k === `${SWARM_PLUGIN_ID}/index` ? indexDoc : undefined),
    subscribePluginDoc: noop,
    ensurePluginDoc: async () => undefined,
    subscribeSessionDoc: noop,
    getSessionDocState: (key: PluginSessionDocKey) => {
      const k = `${key.pluginId}/${key.docName}/${key.conversationId}`
      return cachedSessionStates.get(k) ?? emptySessionState
    },
    loadConversationDetail: async () => undefined,
    markdown: { view: () => null, codeBlock: () => null },
  } as unknown as PluginClientHostPort

  const notifications: Array<{ message: string; tone?: string }> = []
  let rejectPendingAction!: (err: Error) => void
  let callCount = 0
  const ctx: PluginClientContextType = {
    pluginId: SWARM_PLUGIN_ID,
    callAction: async () => {
      callCount += 1
      return new Promise((_, reject) => {
        rejectPendingAction = reject
      })
    },
    fetchRoute: async () => new Response(null, { status: 404 }),
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message, tone) => notifications.push({ message, tone }),
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 50,
    theme: 'dark',
    locale: 'en',
    translate: (text) => (typeof text === 'string' ? text : text.en ?? ''),
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const renderPanel = (conv: ConversationSummary) =>
    React.createElement(
      HelmxUi.UiLocaleProvider,
      { locale: 'en' },
      React.createElement(
        PluginClientHostContext.Provider,
        { value: hostPort },
        React.createElement(PluginClientContext.Provider, { value: { ...ctx, conversationId: conv.id } },
          React.createElement(SwarmWorkbenchPanel, { conversation: conv }),
        ),
      ),
    )

  // 1) Switch conversationId while abort_worker is in flight: late rejection must NOT call notify!
  await React.act(async () => {
    root.render(renderPanel(convs[0]!))
  })
  const abortBtn = host.querySelector('.sw-panel-member-abort') as HTMLButtonElement | null
  assert.ok(abortBtn !== null)
  await React.act(async () => {
    abortBtn.click()
  })
  assert.equal(callCount, 1)

  await React.act(async () => {
    root.render(renderPanel(convs[2]!))
  })
  await React.act(async () => {
    rejectPendingAction(new Error('stale abort error for #50'))
    await Promise.resolve()
  })
  assert.equal(notifications.length, 0, 'conversationId switch must discard stale abort_worker rejection')
  const newCloseBtn = host.querySelector('.sw-panel-close-btn') as HTMLButtonElement | null
  assert.ok(newCloseBtn !== null)
  assert.equal(newCloseBtn.disabled, false, 'switching conversation must clear stale busyAction')

  // 2) Open close dialog on #60, confirm close_group, then unmount before rejection settles: late rejection must NOT notify!
  await React.act(async () => {
    newCloseBtn.click()
  })
  const confirmBtn = document.querySelector('.sw-close-dialog-confirm') as HTMLButtonElement | null
  assert.ok(confirmBtn !== null)
  assert.ok(confirmBtn.closest('.helmx-modal-backdrop .helmx-modal.sw-close-dialog') !== null, 'SwarmCloseGroupDialog must render inside ModalDialog (.helmx-modal-backdrop .helmx-modal)')
  await React.act(async () => {
    confirmBtn.click()
  })
  assert.equal(callCount, 2)

  await React.act(async () => {
    root.unmount()
  })
  await React.act(async () => {
    rejectPendingAction(new Error('unmounted close error'))
    await Promise.resolve()
  })
  assert.equal(notifications.length, 0, 'unmount must guard confirmCloseGroup error notifications and state setters')
  host.remove()
})
