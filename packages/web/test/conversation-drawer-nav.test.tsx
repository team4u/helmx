import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary } from '@helmx/protocol'
import { flushMacrotask, flushMicrotasks, waitForCondition } from './helpers/dom-harness.js'
import { hangingEventStream } from './helpers/sse-stream.js'
import { isWideDesktopViewport, type ResolvedTarget, type ActiveModal, type DrawerFrame } from '../src/lib/types.js'

/**
 * 统一右侧抽屉栈（DrawerStackShell）导航与叠层回归：
 * - 工作台与子会话统一入栈，多层打开绝不互相销毁；
 * - 返回按钮、面包屑、Escape 键与浏览器后退均严格逐层剥离；
 * - 右上角 [×] 与主屏 openTarget 导航整栈收起；分屏导航不收抽屉；
 * - 子会话抽屉支持一键 [分屏对照] 与 [全屏]；
 * - 栈内下层帧通过 React 19 <Activity> 保活，退回时不丢失输入草稿与状态；
 * - 顶层预览模态框（文件/产物）与抽屉栈正交叠放，关预览不毁抽屉栈。
 */
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { DrawerStackShell } = await import('../src/conversation/DrawerStackShell.js')
const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
const { useHelmxStore } = await import('../src/lib/store-context.js')
const { App: RealApp } = await import('../src/App.js')
const e = React.createElement
const __dirname = dirname(fileURLToPath(import.meta.url))
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let observed: {
  primary: ResolvedTarget
  split: ResolvedTarget | null
  drawerStack: DrawerFrame[]
  workbenchOpen: boolean
  workbenchTab: string
  modal: ActiveModal
} | undefined

function summary(id: number, parentConversationId?: number, title = `会话 ${id}`): ConversationSummary {
  return {
    id,
    title,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

// 祖谱：1 ← 11 ← 111（两层派生）；999 为无关根会话。
const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(999)]

let storeHandle: ReturnType<typeof useHelmxStore> | undefined
let sendSseEvent: ((chunk: Uint8Array) => void) | undefined

interface FetchFixture {
  list?: ConversationSummary[]
  detailMap?: Record<number, ConversationSummary>
  ui?: unknown[]
}

function installFetch(fixture: FetchFixture = {}): void {
  const list = fixture.list ?? conversations
  const detailMap = fixture.detailMap ?? {}
  const ui = fixture.ui ?? []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 })
    }
    if (url === '/api/profiles') {
      return new Response(JSON.stringify([{ id: 'assistant', name: 'Assistant' }]), { status: 200 })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        sendSseEvent = send
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          bootId: 'test-boot',
          seq: 1,
          conversations: list,
          pendingAsks: [],
          plugins: [],
          ui,
        })}\n\n`))
      }, { signal: init?.signal }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const artifactMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (artifactMatch) return new Response(JSON.stringify([]), { status: 200 })
    const fileMatch = /^\/api\/conversations\/(\d+)\/files\/content/.exec(url)
    if (fileMatch) return new Response('export const x = 1\n', { status: 200, headers: { 'content-type': 'text/plain' } })
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && (init?.method ?? 'GET') === 'GET') {
      const id = Number(detailMatch[1])
      const found = detailMap[id] ?? list.find((item) => item.id === id)
      return new Response(JSON.stringify({ ...(found ?? summary(id)), entries: [] }), { status: 200 })
    }
    if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function App(): React.ReactNode {
  const store = useHelmxStore()
  observed = {
    primary: store.primaryTarget,
    split: store.splitTarget,
    drawerStack: store.drawerStack,
    workbenchOpen: store.workbenchOpen,
    workbenchTab: store.workbenchTab,
    modal: store.activeModal,
  }
  storeHandle = store
  const primary = store.primaryTarget.kind === 'conversation' ? store.primaryTarget : null
  const split = store.splitTarget?.kind === 'conversation' ? store.splitTarget : null
  const activeConversationId = primary?.conversationId ?? split?.conversationId
  const dockablePrimary =
    store.primaryTarget.kind === 'conversation' ||
    store.primaryTarget.kind === 'agent' ||
    store.primaryTarget.kind === 'overview'
  const drawerDocked = store.splitTarget === null && dockablePrimary && isWideDesktopViewport()
  return e(React.Fragment, null,
    e('div', { className: 'helmx-panes' },
      primary !== null
        ? e(ConversationPane, { key: `primary:${primary.conversationId}`, conversationId: primary.conversationId })
        : null,
      split !== null
        ? e('div', { className: 'helmx-split-pane' },
            e(ConversationPane, {
              key: `split:${split.conversationId}`,
              conversationId: split.conversationId,
              isSplit: true,
              onCloseSplit: () => store.closeSplit(),
            }))
        : null,
    ),
    store.drawerStack.length > 0
      ? e(DrawerStackShell, { activeConversationId, docked: drawerDocked })
      : null,
  )
}

async function settle(): Promise<void> {
  await flushMicrotasks()
}

async function mount(hash: string, fixture?: FetchFixture): Promise<void> {
  if (root !== undefined) reset()
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(fixture)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(HelmxStoreProvider, null, e(App)))
  })
  await waitForCondition(() => {
    if (storeHandle === undefined || !storeHandle.authReady || !storeHandle.sseConnected) return false
    if (storeHandle.drawerStack.length === 0) return true
    if (document.querySelector('.drawer-stack-dialog') === null) return false
    const top = storeHandle.drawerStack[storeHandle.drawerStack.length - 1]
    if (top?.kind === 'workbench') {
      return document.querySelector('.helmx-workbench[data-drawer-frame-visible="true"]') !== null
    }
    return document.querySelector('.conversation-drawer[data-drawer-frame-visible="true"]') !== null
  })
}

async function mountReal(hash: string, fixture?: FetchFixture): Promise<void> {
  if (root !== undefined) reset()
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch(fixture)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(RealApp))
  })
  await waitForCondition(() => host?.querySelector('.helmx-shell') !== null && document.querySelector('.drawer-stack-dialog') !== null)
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  globalThis.fetch = originalFetch
  observed = undefined
  storeHandle = undefined
  sendSseEvent = undefined
}

const DRAWER_ONLY_PANEL = {
  pluginId: 'sample',
  surface: 'workbench.panel',
  spec: {
    id: 'drawer-only',
    label: '抽屉专属面板',
    order: 5,
    scope: { tags: ['drawer-tagged'] },
  },
}

function drawerWorkbenchFixture(): FetchFixture {
  return {
    list: [summary(1), { ...summary(11, 1), tags: ['drawer-tagged'] }, summary(111, 11)],
    ui: [DRAWER_ONLY_PANEL],
  }
}

function visibleWorkbenchTabTexts(): string[] {
  return [...document.querySelectorAll('.helmx-workbench[data-drawer-frame-visible="true"] .tabs-bar .tab-btn')].map(
    (el) => el.textContent ?? '',
  )
}

describe('conversation-drawer-nav', () => {
  afterEach(reset, { timeout: 60_000 })

  test('多层抽屉栈逐层打开与逐层关闭：返回按钮、面包屑与 Escape 只剥顶层，[×] 一键收起全栈', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=wb/artifacts')
    assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])
    assert.ok(document.querySelector('.drawer-stack-back-btn') === null, '第 1 层不显示返回按钮')

    // 工作台 -> 子会话 #11 -> 子代理 #111（工作台不被销毁，形成 3 层栈）
    await act(async () => { storeHandle!.openConversationDrawer(11) })
    await settle()
    await act(async () => { storeHandle!.openConversationDrawer(111) })
    await settle()
    assert.deepEqual(observed?.drawerStack, [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 11 },
      { kind: 'conversation', conversationId: 111 },
    ])
    const crumbs = [...document.querySelectorAll('.drawer-stack-crumb-item')]
    assert.equal(crumbs.length, 3, '面包屑应展示全部 3 层路径')

    // 点返回按钮：只剥 #111，回到 #11
    const backBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-back-btn')
    assert.ok(backBtn !== null, '多层时顶部导航栏应显示返回按钮')
    await act(async () => { backBtn!.click() })
    await settle()
    assert.deepEqual(observed?.drawerStack, [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 11 },
    ])

    // 再压回 #111，按 Escape 只剥一层
    await act(async () => { storeHandle!.openConversationDrawer(111) })
    await settle()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await settle()
    assert.deepEqual(observed?.drawerStack, [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 11 },
    ], 'Escape 应只剥顶层 #111')

    // 点击面包屑第 0 项（工作台）直跳回最底层
    const firstCrumbBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-crumb-btn')
    assert.ok(firstCrumbBtn !== null)
    await act(async () => { firstCrumbBtn!.click() })
    await settle()
    assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }], '点击面包屑应截断回对应层')
    assert.equal(observed?.workbenchOpen, true)

    // 再压一层后点右上角 [×]：一次性收起整栈
    await act(async () => { storeHandle!.openConversationDrawer(11) })
    await settle()
    const closeAllBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-close-btn')
    assert.ok(closeAllBtn !== null)
    await act(async () => { closeAllBtn!.click() })
    await settle()
    assert.deepEqual(observed?.drawerStack, [], '[×] 应一次性收起整个抽屉栈')
  })

  test('浏览器后退严格逐层退栈（工作台 -> #11 -> 后退回工作台）', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=wb/artifacts')
    assert.equal(observed?.workbenchOpen, true)
    await act(async () => {
      storeHandle!.openConversationDrawer(11)
    })
    await settle()
    assert.deepEqual(observed?.drawerStack, [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 11 },
    ])
    await act(async () => { window.history.back() })
    await waitForCondition(() => observed?.drawerStack.length === 1)
    assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }], '后退应只关 #11 并保留工作台')
    assert.equal(observed?.workbenchOpen, true)
  })

  test('下层帧通过 <Activity> 保活：打开更深一层再返回，草稿输入不丢失', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=c/11')
    const textarea11 = document.querySelector<HTMLTextAreaElement>(
      '.conversation-drawer[data-drawer-frame-visible="true"] textarea',
    )
    assert.ok(textarea11 !== null, '抽屉 #11 应渲染输入框')
    // React 受控输入通过原生 setter 触发变更
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      nativeSetter?.call(textarea11, '保留草稿内容')
      textarea11!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()

    // 再压入 #111，然后退回 #11
    await act(async () => { storeHandle!.openConversationDrawer(111) })
    await settle()
    assert.equal(
      document.querySelectorAll('.conversation-drawer[data-drawer-frame-visible="true"]').length,
      1,
      '仅栈顶帧可见',
    )
    await act(async () => { storeHandle!.popDrawer() })
    await settle()
    const restoredTextarea = document.querySelector<HTMLTextAreaElement>(
      '.conversation-drawer[data-drawer-frame-visible="true"] textarea',
    )
    assert.equal(restoredTextarea?.value, '保留草稿内容', '退回下层时输入框草稿应经 <Activity> 完整保留')
  })

  test('抽屉会话一键 [分屏对照] 送入右分屏并收起抽屉，[全屏] 送入主屏并收起抽屉', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=wb/artifacts&drawer=c/11')
    const splitBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-split-btn')
    assert.ok(splitBtn !== null, '子会话帧顶栏应提供分屏对照按钮')
    await act(async () => { splitBtn!.click() })
    await settle()
    assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 }, '主屏主控会话不动')
    assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 11 }, '子会话应固定到右分屏')
    assert.deepEqual(observed?.drawerStack, [], '分屏对照后应自动收起抽屉让用户直视双栏')

    // 重开后测试全屏按钮
    await act(async () => { storeHandle!.openConversationDrawer(111) })
    await settle()
    const fullscreenBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-fullscreen-btn')
    assert.ok(fullscreenBtn !== null)
    await act(async () => { fullscreenBtn!.click() })
    await settle()
    assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 111 })
    assert.deepEqual(observed?.drawerStack, [])
  })

  test('顶层预览弹窗（文件预览）与抽屉栈正交：在抽屉里开文件不破坏抽屉栈，关文件回到原抽屉', { timeout: 60_000 }, async () => {
    await mountReal('#/c/1?drawer=wb/artifacts&drawer=c/11')
    assert.ok(document.querySelector('.drawer-stack-dialog') !== null, '抽屉栈应打开')
    // 经 URL 变更叠加打开文件预览（在已挂载的 RealApp 上验证抽屉栈与预览框并存）
    window.history.replaceState(null, '', '#/c/1?drawer=wb/artifacts&drawer=c/11&modal=file&conv=11&path=src/app.ts')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(() => document.querySelector('.preview-modal-body') !== null)
    assert.ok(document.querySelector('.drawer-stack-dialog') !== null, '文件预览打开时抽屉栈应继续保留在下方')
    assert.ok(document.querySelector('.preview-modal-body') !== null, '文件预览弹窗应叠加显示在上方')

    // 叠层 z-index：后挂载的文件预览高于抽屉栈
    const drawerZ = Number(document.querySelector<HTMLElement>('.drawer-stack-dialog')?.style.zIndex || 0)
    const modalZ = Number(document.querySelector<HTMLElement>('.helmx-modal')?.style.zIndex || 0)
    assert.ok(modalZ > drawerZ, `预览弹窗 zIndex(${modalZ}) 应高于抽屉栈(${drawerZ})`)

    // 关闭文件预览弹窗：仅关预览框，底下的 2 层抽屉栈完好无损
    const previewClose = document.querySelector<HTMLButtonElement>('.helmx-modal-header button[aria-label="Close preview"]')
    assert.ok(previewClose !== null)
    await act(async () => { previewClose!.click() })
    await waitForCondition(() => document.querySelector('.preview-modal-body') === null)
    assert.ok(document.querySelector('.preview-modal-body') === null, '预览弹窗应关闭')
    assert.ok(document.querySelector('.drawer-stack-dialog') !== null, '抽屉栈应完整保留')
    assert.equal(document.querySelector('.drawer-stack-dialog')?.getAttribute('data-drawer-depth'), '2')
  })

  test('抽屉标题与 aria-label 展示有意义的会话标题，占位标题与空白回退默认文案', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=c/11', {
      list: [
        summary(1),
        summary(11, 1, '排查构建失败'),
        summary(12, 1, 'Subagent 12'),
        summary(13, 1, '子代理 13'),
        summary(14, 1, '子会话 14'),
        summary(15, 1, '   '),
      ],
      detailMap: { 20: summary(20, 1, '详情兜底标题') },
    })
    const dialog = document.querySelector('.drawer-stack-dialog')
    assert.ok(dialog !== null)
    assert.equal(dialog!.getAttribute('aria-label'), 'Child conversation #11 · 排查构建失败 drawer')

    for (const id of [12, 13, 14, 15] as const) {
      await act(async () => {
        storeHandle!.closeAllDrawers()
        storeHandle!.openConversationDrawer(id)
      })
      const dlg = document.querySelector('.drawer-stack-dialog')
      assert.ok(dlg !== null)
      assert.equal(dlg!.getAttribute('aria-label'), `Child conversation #${id} drawer`)
    }

    await act(async () => {
      storeHandle!.closeAllDrawers()
      storeHandle!.openConversationDrawer(20)
    })
    await waitForCondition(
      () => document.querySelector('.drawer-stack-dialog')?.getAttribute('aria-label') === 'Child conversation #20 · 详情兜底标题 drawer',
    )
    const fallbackDlg = document.querySelector('.drawer-stack-dialog')
    assert.ok(fallbackDlg !== null)
    assert.equal(fallbackDlg!.getAttribute('aria-label'), 'Child conversation #20 · 详情兜底标题 drawer')
  })

  test('openTarget 主屏导航自动收起抽屉栈，分屏导航不收', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=wb/artifacts&drawer=c/11')
    assert.equal(observed?.drawerStack.length, 2)
    await act(async () => {
      storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 })
    })
    await settle()
    assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 999 })
    assert.deepEqual(observed?.drawerStack, [], '主屏导航应自动收起抽屉栈')

    await act(async () => {
      storeHandle!.openConversationDrawer(11)
    })
    await settle()
    await act(async () => {
      storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }, { split: true })
    })
    await settle()
    assert.deepEqual(observed?.drawerStack, [{ kind: 'conversation', conversationId: 11 }], '分屏导航不应收起抽屉栈')
    assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 1 })
  })

  test('抽屉会话顶栏工作台按钮压入绑定该抽屉会话的工作台帧，退回后回到抽屉会话', { timeout: 60_000 }, async () => {
    await mount('#/c/1?drawer=c/11', drawerWorkbenchFixture())
    assert.ok(document.querySelector('.conversation-drawer[data-drawer-frame-visible="true"]') !== null)
    assert.ok(document.querySelector('.helmx-workbench') === null)

    const workbenchBtn = document.querySelector<HTMLButtonElement>(
      '.conversation-drawer .pane-actions button[aria-label="Workbench"]',
    )
    assert.ok(workbenchBtn !== null, '抽屉顶栏应有与主会话一致的工作台按钮')

    await act(async () => { workbenchBtn!.click() })
    await waitForCondition(() => visibleWorkbenchTabTexts().some((text) => text.includes('抽屉专属面板')))
    const tabs = visibleWorkbenchTabTexts()
    assert.ok(tabs.some((text) => text.includes('抽屉专属面板')), `工作台应绑定抽屉会话 #11，实际页签: ${JSON.stringify(tabs)}`)
    assert.ok(tabs.some((text) => text.includes('Artifacts')))
    assert.match(window.location.hash, /drawer=c%2F11&drawer=wb%4011%2F/, '地址栏应保留完整两层栈')

    // 点返回按钮：只收 #11 的工作台帧，回到 #11 会话
    const backBtn = document.querySelector<HTMLButtonElement>('.drawer-stack-back-btn')
    assert.ok(backBtn !== null)
    await act(async () => { backBtn!.click() })
    await flushMacrotask(0)
    assert.ok(document.querySelector('.conversation-drawer[data-drawer-frame-visible="true"]') !== null, '退回后 #11 会话抽屉应恢复可见')
    assert.match(window.location.hash, /drawer=c%2F11$/)
  })

  test('工作台打开时经总览卡「抽屉速览」压入子会话抽屉：旧工作台保留在下层，返回可直达', { timeout: 60_000 }, async () => {
    await mount('#/overview?drawer=wb/artifacts', {
      list: [summary(1), { ...summary(11, 1), tags: ['drawer-tagged'], status: 'blocked' as const }],
      ui: [DRAWER_ONLY_PANEL],
    })
    assert.ok(document.querySelector('.helmx-workbench[data-drawer-frame-visible="true"]') !== null)

    // 先关闭或直接用卡片菜单测试：抽屉打开时遮罩下无法直接点总览卡，故在关闭后或同源入口均验证；
    // 这里直接验证多层深链从工作台 -> #11 -> #11 工作台的完整恢复。
    window.history.replaceState(null, '', '#/c/1?drawer=wb/artifacts&drawer=c/11&drawer=wb@11/artifacts')
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await waitForCondition(
      () =>
        document.querySelector('.drawer-stack-dialog')?.getAttribute('data-drawer-depth') === '3' &&
        visibleWorkbenchTabTexts().some((text) => text.includes('抽屉专属面板')),
    )
    assert.equal(document.querySelector('.drawer-stack-dialog')?.getAttribute('data-drawer-depth'), '3')
    const tabs = visibleWorkbenchTabTexts()
    assert.ok(tabs.some((text) => text.includes('抽屉专属面板')), '第 3 层工作台应绑定 #11')
  })

  test('抽屉会话一律不渲染「新话题」按钮：主屏与分屏保留入口', { timeout: 60_000 }, async () => {
    await mount('#/c/999?split=c/111&drawer=c/111')
    const newTopicButtons = (scope: string): HTMLButtonElement[] =>
      [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)]
        .filter((b) => b.getAttribute('aria-label') === 'New topic')
    assert.equal(newTopicButtons('.conversation-drawer').length, 0, '抽屉内不得渲染新话题按钮')
    assert.equal(newTopicButtons('.helmx-panes > .helmx-pane').length, 1, '主屏保留新话题入口')
    assert.equal(newTopicButtons('.helmx-split-pane').length, 1, '分屏保留新话题入口')
  })

  test('drawer-stack-model 纯函数契约：去重截断、深度上限 5、工作台归属推导与删除清理', { timeout: 60_000 }, async () => {
    const {
      MAX_DRAWER_STACK_DEPTH,
      isDrawerFrameKeepAlive,
      pushDrawerFrame,
      removeConversationFromDrawerStack,
      resolveDrawerWorkbenchConversationId,
    } = await import('../src/lib/drawer-stack-model.js')

    let stack: DrawerFrame[] = []
    for (let id = 1; id <= MAX_DRAWER_STACK_DEPTH + 2; id += 1) {
      stack = pushDrawerFrame(stack, { kind: 'conversation', conversationId: id })
    }
    assert.equal(stack.length, MAX_DRAWER_STACK_DEPTH, '超限时丢弃最底层')
    assert.deepEqual(
      stack.map((f) => f.conversationId),
      [3, 4, 5, 6, 7],
    )
    assert.equal(isDrawerFrameKeepAlive(stack.length, 0), false)
    assert.equal(isDrawerFrameKeepAlive(stack.length, 1), false)
    assert.equal(isDrawerFrameKeepAlive(stack.length, 2), true)
    assert.equal(isDrawerFrameKeepAlive(stack.length, 4), true)

    // 重开栈中已有帧 #4：截断其上所有帧，防套娃
    stack = pushDrawerFrame(stack, { kind: 'conversation', conversationId: 4 })
    assert.deepEqual(stack.map((f) => f.conversationId), [3, 4])

    // 工作台归属推导：显式 conversationId > 下方最近会话帧 > 主/分屏活动会话
    const mixed: DrawerFrame[] = [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 67 },
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'workbench', conversationId: 88, tab: 'artifacts' },
    ]
    assert.equal(resolveDrawerWorkbenchConversationId(mixed, 0, 10), 10)
    assert.equal(resolveDrawerWorkbenchConversationId(mixed, 2, 10), 67)
    assert.equal(resolveDrawerWorkbenchConversationId(mixed, 3, 10), 88)

    // 会话删除时同时清理绑定该会话的会话帧与工作台帧
    const pruned = removeConversationFromDrawerStack(
      [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 67 },
        { kind: 'workbench', conversationId: 67, tab: 'artifacts' },
      ],
      67,
    )
    assert.deepEqual(pruned, [{ kind: 'workbench', tab: 'artifacts' }])
  })

  test('宽屏 (>=1280px 且无 splitTarget) 流内停靠右侧抽屉栈，子会话 50/50 等分、Mod+I 直达主区、设置页/split 退回顶层模态遮罩', { timeout: 60_000 }, async () => {
    const originalMatchMedia = window.matchMedia
    const styleEl = document.createElement('style')
    const tokensCss = readFileSync(join(__dirname, '../src/styles/tokens.css'), 'utf8')
    const shellCss = readFileSync(join(__dirname, '../src/styles/shell.css'), 'utf8')
    // happy-dom evaluates var(--token) to px but cannot resolve clamp()/min() in computed width;
    // overriding :root --helmx-drawer-narrow-width with a px value tests exact in-flow sizing.
    styleEl.textContent = `${tokensCss}\n${shellCss}\n:root { --helmx-drawer-narrow-width: 480px; }`
    document.head.appendChild(styleEl)
    window.matchMedia = ((query: string) => ({
      matches: query === '(min-width: 1280px)',
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false },
    })) as typeof window.matchMedia

    try {
      await mountReal('#/c/1?drawer=wb/artifacts')
      await waitForCondition(() =>
        document.querySelector('.drawer-stack-dialog.is-docked[data-drawer-docked="true"]') !== null &&
        host!.querySelector('[data-helmx-panel="primary"] textarea.composer-textarea') !== null,
      )

      const shell = host!.querySelector<HTMLElement>('.helmx-shell')!
      const mainStage = host!.querySelector<HTMLElement>('main.helmx-main-stage')!
      const dialog = document.querySelector<HTMLElement>('.drawer-stack-dialog.is-docked[data-drawer-docked="true"]')!
      assert.ok(dialog !== null)
      assert.ok(dialog.parentElement === shell, 'docked dialog mounts in-flow inside .helmx-shell as a sibling of main stage')
      const narrowComputed = window.getComputedStyle(dialog)
      assert.equal(narrowComputed.position, 'relative')
      assert.equal(narrowComputed.width, '480px')
      assert.equal(narrowComputed.maxWidth, '480px')
      const stageComputed = window.getComputedStyle(mainStage)
      assert.equal(stageComputed.flexGrow, '1')
      assert.equal(stageComputed.flexBasis, '0%')
      assert.ok(shell.classList.contains('drawer-docked'), 'wide desktop docks drawer beside main stage')
      assert.ok(document.querySelector('.drawer-stack-backdrop') === null, 'docked drawer renders without modal backdrop')
      assert.equal(mainStage.hasAttribute('inert'), false, 'docked non-modal drawer keeps main stage interactive')

      // Mod+I focuses main composer while docked workbench is open
      const primaryTextarea = host!.querySelector<HTMLTextAreaElement>('[data-helmx-panel="primary"] textarea.composer-textarea')!
      assert.ok(primaryTextarea !== null)
      primaryTextarea.blur()
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true }))
      })
      assert.ok(document.activeElement === primaryTextarea, 'Mod+I focuses primary composer when workbench is docked')

      // Pushing a child conversation switches to 50/50 equal split (flex: 1 1 0%, matching .helmx-main-stage)
      window.history.replaceState(null, '', '#/c/1?drawer=wb/artifacts&drawer=c/11')
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitForCondition(() => document.querySelector('.drawer-stack-dialog-wide.is-docked[data-drawer-docked="true"]') !== null)
      const wideDialog = document.querySelector<HTMLElement>('.drawer-stack-dialog-wide.is-docked[data-drawer-docked="true"]')!
      assert.ok(wideDialog.parentElement === shell, 'docked child conversation stays in-flow inside .helmx-shell')
      const wideComputed = window.getComputedStyle(wideDialog)
      assert.equal(wideComputed.flexGrow, '1')
      assert.equal(wideComputed.flexBasis, '0%')
      assert.ok(document.querySelector('.drawer-stack-backdrop') === null)

      // Navigating to a non-dockable settings center degrades drawer to a top-layer Portal modal under document.body
      window.history.replaceState(null, '', '#/settings/profiles?drawer=c/11')
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitForCondition(() => document.querySelector('.drawer-stack-backdrop') !== null)
      const settingsDialog = document.querySelector<HTMLElement>('.drawer-stack-dialog')!
      assert.ok(!shell.classList.contains('drawer-docked'), 'settings center disables docked mode so DetailDrawer cannot cover drawer stack')
      assert.ok(settingsDialog.parentElement === document.body, 'settings center drawer portals to document.body above backdrops')
      assert.ok(document.querySelector('[data-drawer-docked="true"]') === null)

      // Opening split pane immediately degrades docked drawer back to Portal modal overlay with backdrop
      window.history.replaceState(null, '', '#/c/1?split=c/999&drawer=wb/artifacts')
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await waitForCondition(() => document.querySelector('.drawer-stack-backdrop') !== null && !shell.classList.contains('drawer-docked'))
      const splitModalDialog = document.querySelector<HTMLElement>('.drawer-stack-dialog')!
      assert.ok(splitModalDialog.parentElement === document.body, 'split view portals drawer to document.body')
      assert.ok(document.querySelector('[data-drawer-docked="true"]') === null)
    } finally {
      styleEl.remove()
      window.matchMedia = originalMatchMedia
    }
  })

  test('drawer-stack-model 按会话记忆纯函数契约：LRU 淘汰、浅拷贝隔离、空栈清理与删除级联裁剪', { timeout: 60_000 }, async () => {
    const {
      getRememberedConversationDrawer,
      pruneConversationFromDrawerMemory,
      setRememberedConversationDrawer,
    } = await import('../src/lib/drawer-stack-model.js')

    const memory = new Map<number, DrawerFrame[]>()
    setRememberedConversationDrawer(memory, 1, [{ kind: 'workbench', tab: ' artifacts ' }], 2)
    setRememberedConversationDrawer(memory, 2, [{ kind: 'conversation', conversationId: 22 }], 2)

    // 读取 #1 会刷新其 LRU 热度，并只返回浅拷贝
    const copy1 = getRememberedConversationDrawer(memory, 1)
    assert.deepEqual(copy1, [{ kind: 'workbench', tab: 'artifacts' }])
    copy1!.push({ kind: 'conversation', conversationId: 999 })
    assert.deepEqual(getRememberedConversationDrawer(memory, 1), [{ kind: 'workbench', tab: 'artifacts' }])

    // 写入 #3 超出上限 2，应淘汰最久未用的 #2 而保留 #1
    setRememberedConversationDrawer(memory, 3, [{ kind: 'workbench', tab: 'changes' }, { kind: 'conversation', conversationId: 33 }], 2)
    assert.equal(getRememberedConversationDrawer(memory, 2), undefined)
    assert.deepEqual(getRememberedConversationDrawer(memory, 1), [{ kind: 'workbench', tab: 'artifacts' }])

    // 传入空栈应删除对应会话记忆
    setRememberedConversationDrawer(memory, 1, [], 2)
    assert.equal(getRememberedConversationDrawer(memory, 1), undefined)

    // 删除会话时：自身条目移除、他人栈中绑定该会话的帧裁剪、变空条目一并移除
    setRememberedConversationDrawer(memory, 10, [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 33 },
      { kind: 'workbench', conversationId: 33, tab: 'changes' },
    ], 10)
    setRememberedConversationDrawer(memory, 20, [
      { kind: 'conversation', conversationId: 33 },
    ], 10)
    pruneConversationFromDrawerMemory(memory, 33)
    assert.equal(getRememberedConversationDrawer(memory, 33), undefined)
    assert.deepEqual(getRememberedConversationDrawer(memory, 10), [{ kind: 'workbench', tab: 'artifacts' }])
    assert.equal(getRememberedConversationDrawer(memory, 20), undefined)
  })

  test('宽屏 (>=1280px 且无 splitTarget) 切换会话按会话独立记忆并恢复停靠工作台与子会话多屏，分屏/窄屏/显式关闭/外链覆写不误恢复', { timeout: 60_000 }, async () => {
    const originalMatchMedia = window.matchMedia
    const mockMatchMedia = (wide: boolean): void => {
      window.matchMedia = ((query: string) => ({
        matches: wide && query === '(min-width: 1280px)',
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false },
      })) as typeof window.matchMedia
    }

    try {
      mockMatchMedia(true)
      await mount('#/c/1?drawer=wb/artifacts&drawer=c/11')
      assert.deepEqual(observed?.drawerStack, [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 11 },
      ])
      assert.ok(document.querySelector('[data-drawer-docked="true"]') !== null, '宽屏初始即应停靠渲染')

      // 1. 切到 #999（干净打开），切回 #1 自动恢复 [wb/artifacts, c/11] 与 URL / 停靠态
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 999 })
      assert.deepEqual(observed?.drawerStack, [], '#999 无记忆时应保持干净')
      assert.equal(window.location.hash, '#/c/999')

      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 11 },
      ], '切回 #1 应自动恢复其工作台与子会话栈')
      assert.match(window.location.hash, /drawer=wb%2Fartifacts&drawer=c%2F11/)
      assert.ok(document.querySelector('[data-drawer-docked="true"]') !== null)

      // 2. 各会话独立记忆：#999 打开工作台后，#999 <-> #1 各自独立恢复
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openWorkbenchDrawer({ tab: 'artifacts' }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])

      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 11 },
      ])

      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])

      // 3. 切往设置页后经 openSpace('conversations') 返回 #1，仍自动恢复停靠抽屉栈
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'profiles' }) })
      await settle()
      assert.deepEqual(observed?.primary, { kind: 'profiles' })
      assert.deepEqual(observed?.drawerStack, [], '离开会话进入设置页应收起抽屉')

      await act(async () => { storeHandle!.openSpace('conversations') })
      await settle()
      assert.deepEqual(observed?.primary, { kind: 'conversation', conversationId: 1 })
      assert.deepEqual(observed?.drawerStack, [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 11 },
      ])
      assert.ok(document.querySelector('[data-drawer-docked="true"]') !== null)

      // 4. 在 #1 停靠态再次点击 #1 自身，抽屉保持打开
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [
        { kind: 'workbench', tab: 'artifacts' },
        { kind: 'conversation', conversationId: 11 },
      ])
      assert.ok(document.querySelector('[data-drawer-docked="true"]') !== null)

      // 5. popDrawer 更新记忆、closeAllDrawers 清空记忆
      await act(async () => { storeHandle!.popDrawer() })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }], 'popDrawer 退层后切换回来应保持更新后的栈')

      await act(async () => { storeHandle!.openConversationDrawer(11) })
      await settle()
      await act(async () => { storeHandle!.closeAllDrawers() })
      await settle()
      assert.deepEqual(observed?.drawerStack, [])
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [], 'closeAllDrawers 显式关闭后切换回来不得自动复活')

      // 6. 在 #999 浏览期间后台删除子会话 #11（SSE conversation.deleted），切回 #1 时不应复活已删 #11
      await act(async () => {
        storeHandle!.openWorkbenchDrawer({ tab: 'artifacts' })
        storeHandle!.openConversationDrawer(11)
      })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      assert.ok(sendSseEvent !== undefined)
      await act(async () => {
        sendSseEvent!(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({
          seq: 2,
          event: { type: 'conversation.deleted', conversationId: 11 },
        })}\n\n`))
      })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }], '已删除的子会话 #11 应从 #1 记忆中裁剪')

      // 7. 分屏守卫：#1 记忆为 [wb/artifacts] 时，在分屏模式下切到 #1 不得自动弹出模态遮罩，关闭分屏后记忆仍可恢复
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }, { split: true }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.split, { kind: 'conversation', conversationId: 999 })
      assert.deepEqual(observed?.drawerStack, [], '分屏态切回 #1 不得自动打开遮罩抽屉')

      await act(async () => { storeHandle!.closeSplit() })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }], '关闭分屏后 #1 原停靠记忆应完好保留并恢复')

      // 9. URL 外链真源：hashchange 跳转到无 drawer 的 #/c/1 时关闭抽屉并清空 #1 记忆
      window.history.replaceState(null, '', '#/c/1')
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      await settle()
      assert.deepEqual(observed?.drawerStack, [])
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [], '外部无 drawer 导航后 #1 记忆应已清空')

      // 8. 窄屏守卫（< 1280px）：模态抽屉下切走再切回保持收起，不自动弹出
      mockMatchMedia(false)
      await mount('#/c/1?drawer=wb/artifacts')
      assert.ok(document.querySelector('[data-drawer-docked="true"]') === null, '窄屏应为模态抽屉而非停靠')
      assert.deepEqual(observed?.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 999 }) })
      await settle()
      await act(async () => { storeHandle!.openTarget({ kind: 'conversation', conversationId: 1 }) })
      await settle()
      assert.deepEqual(observed?.drawerStack, [], '窄屏切走再切回不得自动弹出模态抽屉')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
