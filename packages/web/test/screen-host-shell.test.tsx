import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary } from '@helmx/protocol'
import type { ToastNotice } from '../src/lib/types.js'
import { ensureHappyDom, flushMacrotask } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { Screen } = await import('@helmx/plugin-client')
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')

const { createRoot } = await import('react-dom/client')
const { ScreenHost } = await import('../src/screens/ScreenHost.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')
const { AuthGate } = await import('../src/shell/AuthGate.js')
const { ToastOverlay } = await import('../src/shell/ToastOverlay.js')
const { Sidebar } = await import('../src/shell/Sidebar.js')

const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined

function mount(element: React.ReactElement): void {
  if (root !== undefined) {
    act(() => root?.unmount())
  }
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    root = createRoot(host!)
    root.render(element)
  })
}

async function settle(): Promise<void> {
  await flushMacrotask(0)
}

function makeConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
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
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...overrides,
  }
}
describe("screen-host-shell", () => {
  before(() => {
    mountSharedPluginNamespaces({ realHooks: true })
  })


  afterEach(() => {
    if (root !== undefined) {
      act(() => root?.unmount())
    }
    root = undefined
    host?.remove()
    host = undefined
    document.body.innerHTML = ''
    globalThis.fetch = originalFetch
    resetPluginClientCache()
  })

  test('ScreenHost 双重头部去重容器、ScreenProps 注入与缺失视图 warn 原语', { timeout: 60_000 }, async () => {
    // 1) 未注册视图渲染统一 .callout.callout-warn
    const emptyStore = makeTestStore({
      primaryTarget: { kind: 'screen', pluginId: 'ext:missing', screenId: 'overview' },
    })
    mount(
      <HostStoreProviders value={emptyStore}>
        <ScreenHost pluginId="ext:missing" screenId="overview" />
      </HostStoreProviders>,
    )
    const warnBox = host?.querySelector('.callout.callout-warn')
    assert.ok(warnBox, '缺失插件视图时应渲染 .callout.callout-warn')
    assert.ok(host?.querySelector('.screen-host-body[data-screen-host="true"]'), '缺失插件视图也位于单一 .screen-host-body 舞台容器内')
    assert.ok(host?.querySelector('.timeline-scroll') === null, 'ScreenHost 不再借穿会话专用 .timeline-scroll')
    assert.ok(host?.querySelector('.timeline-inner') === null, 'ScreenHost 不再借穿会话专用 .timeline-inner')

    // 2) 已注册 client screen 渲染时，内层 Screen 包裹于单层 .screen-host-body[data-screen-host="true"]，
    // ScreenHostContext(hosted=true) 使内层 Screen 结构化省略重复 .screen-title 并保留副标题与动作栏；
    // 主/分屏分别从 primaryTarget / splitTarget 注入标准 ScreenProps 并把 setParams 路由到对应面板；
    // 嵌套子组件（不经 slotProps）经 useScreenParams 读取宿主建立的同一 scope。
    const { useScreenParams } = await import('@helmx/plugin-client')
    const receivedProps: Array<Record<string, unknown>> = []
    const receivedScopes: Array<{ hasScope: boolean; params: unknown; isSplit: boolean | undefined }> = []
    function NestedScopeProbe(): React.JSX.Element {
      const scope = useScreenParams()
      receivedScopes.push({ hasScope: scope !== null, params: scope?.params, isSplit: scope?.isSplit })
      return <div data-nested-scope={scope !== null ? 'yes' : 'no'}>nested</div>
    }
    seedPluginClientModule(
      'ext-demo',
      'index.tsx',
      {
        Board: (props: Record<string, unknown>) => {
          receivedProps.push(props)
          return (
            <Screen title="插件看板" subtitle="副标题说明" actions={<button type="button">刷新</button>}>
              <div>正文内容</div>
              <NestedScopeProbe />
            </Screen>
          )
        },
      },
      'demo-hash-1',
    )
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/plugins/ext-demo/client.mjs')) {
        return new Response('', { status: 200, headers: { 'x-helmx-client-hash': 'demo-hash-1' } })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const paramCalls: Array<{ patch: Record<string, string | undefined>; options?: { split?: boolean; push?: boolean } }> = []
    const activeStore = makeTestStore({
      primaryTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board', params: { view: 'main' } },
      splitTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'board', params: { view: 'right' } },
      uiContributions: [
        {
          pluginId: 'ext-demo',
          surface: 'screen',
          spec: { id: 'board', label: '插件看板', client: { module: 'index.tsx', export: 'Board' } },
        },
      ],
    })
    const realSetScreenParams = activeStore.actions.setScreenParams
    ;(activeStore.actions as unknown as { setScreenParams: (patch: Record<string, string | undefined>, options?: { split?: boolean; push?: boolean }) => void }).setScreenParams = (patch, options) => {
      paramCalls.push({ patch, options })
      realSetScreenParams(patch, options)
    }

    mount(
      <HostStoreProviders value={activeStore}>
        <ScreenHost pluginId="ext-demo" screenId="board" />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const topbar = host?.querySelector('.pane-topbar')
    const stage = host?.querySelector<HTMLElement>('.screen-host-body[data-screen-host="true"]')
    assert.ok(topbar, 'ScreenHost 应保留唯一宿主顶栏 .pane-topbar')
    assert.ok(stage, 'ScreenHost 应渲染单一滚动舞台 .screen-host-body[data-screen-host="true"]')
    assert.ok(host?.querySelector('.timeline-scroll') === null, 'ScreenHost 不再嵌套 .timeline-scroll')
    assert.ok(host?.querySelector('.timeline-inner') === null, 'ScreenHost 不再嵌套 .timeline-inner')
    assert.ok(stage.querySelector('.screen-header') !== null, '存在 subtitle 时保留 .screen-header')
    assert.ok(stage.querySelector('.screen-title') === null, 'hosted 下内层 Screen 结构化省略重复 .screen-title（零 CSS display:none 补丁）')
    assert.ok(stage.querySelector('.screen-subtitle'), '副标题应保留')
    // Screen actions 经 ScreenHostContext.headerActionsSlot portal 进宿主顶栏 .pane-actions 动作槽
    // （位于分屏按钮之前，与五大中心页头动作同一位置），舞台内零重复渲染
    const topbarActions = topbar?.querySelector('.pane-actions')
    assert.ok(topbarActions?.querySelector('.pane-actions-slot .stack-row button'), 'Screen actions 应落入宿主顶栏 .pane-actions 动作槽')
    assert.ok(stage.querySelector('button') === null, '动作按钮不再在舞台 .screen-header 内重复渲染')
    assert.ok(topbarActions?.querySelector('.split-toggle-btn'), '分屏按钮仍位于动作槽之后')
    assert.ok(stage.querySelector('[data-nested-scope="yes"]'), '嵌套子组件经 useScreenParams 读到宿主建立的屏内 scope')
    const primaryScope = receivedScopes[receivedScopes.length - 1]!
    assert.equal(primaryScope.hasScope, true)
    assert.deepEqual(primaryScope.params, { view: 'main' })
    assert.equal(primaryScope.isSplit, false)

    assert.ok(receivedProps.length >= 1)
    const primaryProps = receivedProps[receivedProps.length - 1]!
    assert.equal(primaryProps.pluginId, 'ext-demo')
    assert.equal(primaryProps.screenId, 'board')
    assert.equal(primaryProps.isSplit, false)
    assert.deepEqual(primaryProps.params, { view: 'main' })
    ;(primaryProps.setParams as (patch: Record<string, string | undefined>, options?: { push?: boolean }) => void)(
      { tab: 'overview' },
      { push: true },
    )

    mount(
      <HostStoreProviders value={activeStore}>
        <ScreenHost pluginId="ext-demo" screenId="board" isSplit />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const splitProps = receivedProps[receivedProps.length - 1]!
    assert.equal(splitProps.isSplit, true)
    assert.deepEqual(splitProps.params, { view: 'right' })
    const splitScope = receivedScopes[receivedScopes.length - 1]!
    assert.deepEqual(splitScope.params, { view: 'right' }, '分屏嵌套组件读到 ssp.* 侧的独立 scope')
    assert.equal(splitScope.isSplit, true)
    ;(splitProps.setParams as (patch: Record<string, string | undefined>, options?: { push?: boolean }) => void)(
      { tab: 'logs' },
      { push: false },
    )

    assert.deepEqual(paramCalls, [
      { patch: { tab: 'overview' }, options: { split: false, push: true } },
      { patch: { tab: 'logs' }, options: { split: true, push: false } },
    ])

    // 3) 仅传 title 的 Screen 在 ScreenHost 内完全不渲染空 .screen-header；full-bleed 正常打标且无双滚动容器
    seedPluginClientModule(
      'ext-demo',
      'modes.tsx',
      {
        TitleOnly: () => (
          <Screen title="仅主标题">
            <div data-testid="title-only-body">纯正文</div>
          </Screen>
        ),
        FullBleed: () => (
          <Screen layout="full-bleed" title="全出血画布">
            <div data-testid="canvas-body">宽画布</div>
          </Screen>
        ),
        ActionsOnly: () => (
          <Screen layout="full-bleed" title="仅动作" actions={<button type="button">新建映射</button>}>
            <div data-testid="actions-only-body">正文</div>
          </Screen>
        ),
      },
      'demo-hash-2',
    )
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/plugins/ext-demo/client.mjs')) {
        return new Response('', { status: 200, headers: { 'x-helmx-client-hash': 'demo-hash-2' } })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const modesStore = makeTestStore({
      primaryTarget: { kind: 'screen', pluginId: 'ext-demo', screenId: 'title-only' },
      uiContributions: [
        {
          pluginId: 'ext-demo',
          surface: 'screen',
          spec: { id: 'title-only', label: '仅主标题', client: { module: 'modes.tsx', export: 'TitleOnly' } },
        },
        {
          pluginId: 'ext-demo',
          surface: 'screen',
          spec: { id: 'full-bleed', label: '全出血画布', client: { module: 'modes.tsx', export: 'FullBleed' } },
        },
        {
          pluginId: 'ext-demo',
          surface: 'screen',
          spec: { id: 'actions-only', label: '仅动作', client: { module: 'modes.tsx', export: 'ActionsOnly' } },
        },
      ],
    })

    mount(
      <HostStoreProviders value={modesStore}>
        <ScreenHost pluginId="ext-demo" screenId="title-only" />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const titleOnlyStage = host?.querySelector<HTMLElement>('.screen-host-body[data-screen-host="true"]')
    assert.ok(titleOnlyStage !== null && titleOnlyStage !== undefined)
    assert.ok(titleOnlyStage.querySelector('.screen-header') === null, '仅传 title 时 hosted Screen 不渲染空 .screen-header')
    assert.ok(titleOnlyStage.querySelector('.screen-title') === null, 'hosted Screen 不渲染重复 .screen-title')
    assert.equal(titleOnlyStage.querySelector('.screen-container')?.getAttribute('data-screen-layout'), 'contained')
    assert.equal(titleOnlyStage.querySelector('[data-testid="title-only-body"]')?.textContent, '纯正文')

    mount(
      <HostStoreProviders value={modesStore}>
        <ScreenHost pluginId="ext-demo" screenId="full-bleed" />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const fullBleedStage = host?.querySelector<HTMLElement>('.screen-host-body[data-screen-host="true"]')
    assert.ok(fullBleedStage !== null && fullBleedStage !== undefined)
    assert.ok(host?.querySelector('.timeline-scroll') === null)
    assert.ok(fullBleedStage.querySelector('.screen-header') === null)
    assert.equal(fullBleedStage.querySelector('.screen-container')?.getAttribute('data-screen-layout'), 'full-bleed')
    assert.equal(fullBleedStage.querySelector('[data-testid="canvas-body"]')?.textContent, '宽画布')

    // 4) 仅传 actions（无 subtitle）：动作全部进顶栏槽，舞台内不再残留只有动作的空 .screen-header 行
    mount(
      <HostStoreProviders value={modesStore}>
        <ScreenHost pluginId="ext-demo" screenId="actions-only" />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const actionsOnlyStage = host?.querySelector<HTMLElement>('.screen-host-body[data-screen-host="true"]')
    assert.ok(actionsOnlyStage !== null && actionsOnlyStage !== undefined)
    assert.ok(actionsOnlyStage.querySelector('.screen-header') === null, '仅传 actions 时 hosted Screen 不渲染空 .screen-header 行')
    assert.ok(actionsOnlyStage.querySelector('button') === null, '舞台内零动作按钮')
    assert.equal(host?.querySelector('.pane-topbar .pane-actions-slot .stack-row button')?.textContent, '新建映射')
    assert.ok(host?.querySelector('.pane-topbar .pane-actions-slot')?.nextElementSibling?.classList.contains('split-toggle-btn') === true, '动作槽紧邻分屏按钮之前')
    assert.equal(actionsOnlyStage.querySelector('[data-testid="actions-only-body"]')?.textContent, '正文')
  })

  test('CommandPaletteModal 单键快捷键徽章、聚焦分屏上下文与空查询排序', { timeout: 60_000 }, async () => {
    const dispatched: Array<CustomEvent> = []
    const onShortcut = (ev: Event) => {
      dispatched.push(ev as CustomEvent)
    }
    window.addEventListener('helmx:shortcut', onShortcut)

    try {
      const conversations = [1, 2, 3, 4, 5, 6, 7].map((id) =>
        makeConversation(id, { title: `最近话题 ${id}`, updatedAt: id * 100 }),
      )
      const store = makeTestStore({
        activeModal: { kind: 'command-palette' },
        conversations,
        primaryTarget: { kind: 'conversation', conversationId: 1 },
        splitTarget: { kind: 'conversation', conversationId: 6 },
        focusedPanel: 'split',
      })

      let closed = false
      mount(
        <HostStoreProviders value={store}>
          <CommandPaletteModal onClose={() => { closed = true }} />
        </HostStoreProviders>,
      )
      await settle()

      const modal = document.querySelector<HTMLElement>('.modal[aria-label="Command palette and global search"]')
      assert.ok(modal, '应渲染命令面板对话框')

      // 所有快捷键提示均带 .kbd-hint 且绝不含双键别名分隔符（允许单键本身为 "/" 的 ⌘/ 与 Ctrl+/）
      const hints = [...modal.querySelectorAll<HTMLElement>('.kbd-hint')]
      assert.ok(hints.length >= 4, '应显示单键快捷键 .kbd-hint 徽章')
      for (const hint of hints) {
        const label = hint.textContent?.trim() ?? ''
        assert.ok(label.length > 0)
        const hasAliasSeparator = label.includes('/') && label !== '⌘/' && label !== 'Ctrl+/'
        assert.equal(hasAliasSeparator, false, `快捷键徽章 "${label}" 不应包含多键别名 "/"`)
      }

      // 最近会话在空查询下最多展示 5 条，且排在上下文动作之后、全局导航之前
      const allRows = [...modal.querySelectorAll<HTMLElement>('[data-idx].nav-item')]
      const recentItems = allRows.filter((el) => (el.textContent ?? '').includes('最近话题'))
      assert.equal(recentItems.length, 5, '有足够非当前焦点会话时应展示 5 条最近会话')
      assert.equal(
        recentItems.some((el) => (el.textContent ?? '').includes('最近话题 6')),
        false,
        '当前聚焦分屏会话 #6 不应重复出现在最近会话列表',
      )

      // 点击「切换当前模型」应派发指向 focusedPanel ('split') 的 helmx:shortcut 并关闭面板
      const modelIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('Switch current model'))
      const firstRecentIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('最近话题'))
      const navIdx = allRows.findIndex((el) => (el.textContent ?? '').includes('Open agent profile center'))
      assert.ok(modelIdx >= 0 && firstRecentIdx > modelIdx && navIdx > firstRecentIdx, '空查询排序应为：上下文动作 -> 最近会话 -> 全局导航')

      await act(async () => {
        allRows[modelIdx]!.click()
      })
      assert.equal(closed, true)
      assert.equal(dispatched.length, 1)
      assert.deepEqual(dispatched[0]?.detail, { action: 'toggle-model-picker', panel: 'split' })
    } finally {
      window.removeEventListener('helmx:shortcut', onShortcut)
    }
  })

  test('AuthGate / ToastOverlay / Sidebar 原语与折叠按钮及零 Emoji / 零原生 select', { timeout: 60_000 }, async () => {
    // 1) AuthGate 表单短密码触发 .callout.callout-error
    const authStore = makeTestStore({ authConfigured: false, authenticated: false })
    mount(
      <HostStoreProviders value={authStore}>
        <AuthGate />
      </HostStoreProviders>,
    )
    const form = host?.querySelector('form')
    assert.ok(form)
    assert.ok(host?.querySelector('.helmx-card.auth-gate-card'), 'AuthGate 应使用 Card 原语渲染')
    const authLabels = [...(host?.querySelectorAll('label.helmx-field-label') ?? [])]
    const authInputs = [...(host?.querySelectorAll('input.input') ?? [])]
    assert.equal(authLabels.length, 2, '初始化态应渲染两个 Field 标签')
    assert.equal(authInputs.length, 2, '初始化态应渲染两个 Input 控件')
    assert.equal(authLabels[0]?.getAttribute('for'), authInputs[0]?.getAttribute('id'), '密码 Field 应与 Input 绑定 htmlFor/id')
    assert.equal(authLabels[1]?.getAttribute('for'), authInputs[1]?.getAttribute('id'), '确认密码 Field 应与 Input 绑定 htmlFor/id')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const authErr = host?.querySelector('.callout.callout-error')
    assert.ok(authErr, 'AuthGate 错误提示应使用 .callout.callout-error')
    assert.equal(document.querySelectorAll('select').length, 0)

    // 2) ToastOverlay Quiet Surface 极简卡片、语义级别、倒序堆叠与 4 条栈上限
    const toastStore = makeTestStore({
      notices: [
        { id: 'n-err', type: 'notification', level: 'error', title: '连接失败', createdAt: 1000 },
        { id: 'n-warn', type: 'notification', level: 'warning', title: '操作提示', createdAt: 2000 },
      ],
    })
    mount(
      <HostStoreProviders value={toastStore}>
        <ToastOverlay />
      </HostStoreProviders>,
    )
    const toastRegion = host?.querySelector<HTMLElement>('.toast-overlay[role="region"]')
    assert.ok(toastRegion !== null && toastRegion !== undefined, 'ToastOverlay 应使用 role="region" 容器')
    assert.ok((toastRegion.getAttribute('aria-label') ?? '').trim().length > 0, 'Toast region 应具有非空 aria-label')

    const errToast = host?.querySelector<HTMLElement>('[data-notice-id="n-err"].toast-item[data-level="error"][role="alert"]')
    const warnToast = host?.querySelector<HTMLElement>('[data-notice-id="n-warn"].toast-item[data-level="warning"][role="status"]')
    assert.ok(errToast !== null && errToast !== undefined)
    assert.ok(warnToast !== null && warnToast !== undefined)
    assert.equal(errToast.getAttribute('data-compact'), 'true')
    assert.equal(warnToast.getAttribute('data-compact'), 'true')
    for (const toastEl of [errToast, warnToast]) {
      assert.equal(toastEl.classList.contains('callout'), false)
      assert.equal(toastEl.classList.contains('callout-error'), false)
      assert.equal(toastEl.classList.contains('callout-warn'), false)
    }
    assert.deepEqual(
      [...(host?.querySelectorAll('.toast-item') ?? [])].map((el) => el.getAttribute('data-notice-id')),
      ['n-warn', 'n-err'],
    )

    // 2b) 标准「查看」按钮：显式 target / view 深链解析、忽略仅 conversationId 旧字段、非法 view 不渲染按钮；
    //     有 body 时位于 .toast-content，无 body 时紧凑行布局位于 .toast-trailing；
    //     关闭按钮常驻（右上角定位由样式承担，行为面断言其可点击关单）
    const openedTargets: unknown[] = []
    const dismissedIds: string[] = []
    const viewStore = makeTestStore({
      notices: [
        {
          id: 'n-view',
          type: 'notification',
          level: 'info',
          title: '应用 demo-1 已就绪',
          body: 'x'.repeat(200),
          createdAt: 3000,
          view: 'screen:demo-desk/main?app=demo-1',
        },
        {
          id: 'n-conv',
          type: 'notification',
          level: 'info',
          title: 'explicit target',
          createdAt: 3100,
          target: { kind: 'conversation', conversationId: 42 },
        },
        { id: 'n-legacy', type: 'notification', level: 'info', title: 'legacy only', createdAt: 3150, conversationId: 42 } as unknown as ToastNotice,
        { id: 'n-bad', type: 'notification', level: 'info', title: 'broken target', createdAt: 3200, view: 'not-a-target' },
      ],
    })
    const viewActions = viewStore.actions as unknown as {
      openTarget: (target: unknown) => void
      dismissNotice: (id: string) => void
    }
    viewActions.openTarget = (target) => {
      openedTargets.push(target)
    }
    viewActions.dismissNotice = (id) => {
      dismissedIds.push(id)
    }
    mount(
      <HostStoreProviders value={viewStore}>
        <ToastOverlay />
      </HostStoreProviders>,
    )
    const viewToast = host?.querySelector<HTMLElement>('[data-notice-id="n-view"]')
    const convToast = host?.querySelector<HTMLElement>('[data-notice-id="n-conv"]')
    assert.ok(viewToast !== null && viewToast !== undefined)
    assert.ok(convToast !== null && convToast !== undefined)
    assert.equal(viewToast.getAttribute('data-compact'), null)
    assert.ok(viewToast.querySelector('.toast-content .toast-action-btn') !== null, '有 body 的通知动作按钮应位于 .toast-content 内')
    assert.ok(viewToast.querySelector('.toast-trailing .toast-action-btn') === null)
    assert.equal(convToast.getAttribute('data-compact'), 'true')
    assert.ok(convToast.querySelector('.toast-trailing .toast-action-btn') !== null, '无 body 的紧凑通知动作按钮应位于 .toast-trailing 内')
    assert.ok(convToast.querySelector('.toast-content .toast-action-btn') === null)

    const viewBtn = host?.querySelector<HTMLButtonElement>('[data-notice-id="n-view"] .toast-action-btn')
    assert.ok(viewBtn, 'view 通知应渲染标准查看按钮')
    assert.equal(viewBtn.textContent, 'View')
    await act(async () => {
      viewBtn.click()
    })
    assert.equal(openedTargets.length, 1)
    assert.deepEqual(openedTargets[0], {
      kind: 'screen',
      pluginId: 'demo-desk',
      screenId: 'main',
      params: { app: 'demo-1' },
    })
    assert.equal(dismissedIds[0], 'n-view', '点击查看后应关闭对应气泡')

    const convBtn = host?.querySelector<HTMLButtonElement>('[data-notice-id="n-conv"] .toast-action-btn')
    assert.ok(convBtn, '显式 target 通知应渲染会话查看按钮')
    await act(async () => {
      convBtn.click()
    })
    assert.deepEqual(openedTargets[1], { kind: 'conversation', conversationId: 42 })

    assert.ok(host?.querySelector('[data-notice-id="n-legacy"] .toast-action-btn') === null, '已退役的 legacy conversationId 不再自动路由')
    assert.ok(host?.querySelector('[data-notice-id="n-bad"] .toast-action-btn') === null, '非法 view 不得渲染假按钮')
    const closeBtn = host?.querySelector<HTMLButtonElement>('[data-notice-id="n-bad"] .toast-close-btn')
    assert.ok(closeBtn, '无动作通知仍有关闭按钮')
    await act(async () => {
      closeBtn.click()
    })
    assert.equal(dismissedIds[2], 'n-bad', '关闭按钮应精确关单')

    // 2c) 5 条通知栈上限：最多渲染最新 4 条且倒序排列
    const stackStore = makeTestStore({
      notices: [1, 2, 3, 4, 5].map((n) => ({
        id: `n-${n}`,
        type: 'notification',
        level: 'info' as const,
        title: `通知 ${n}`,
        createdAt: 4000 + n,
      })),
    })
    mount(
      <HostStoreProviders value={stackStore}>
        <ToastOverlay />
      </HostStoreProviders>,
    )
    assert.deepEqual(
      [...(host?.querySelectorAll('.toast-item') ?? [])].map((el) => el.getAttribute('data-notice-id')),
      ['n-5', 'n-4', 'n-3', 'n-2'],
    )

    // 3) Sidebar 折叠 / 展开按钮联动 toggleSidebarCollapsed
    let toggleCount = 0
    const expandedStore = makeTestStore({
      sidebarCollapsed: false,
    })
    ;(expandedStore.actions as unknown as { toggleSidebarCollapsed: () => void }).toggleSidebarCollapsed = () => {
      toggleCount += 1
      expandedStore.actions.setSidebarCollapsed(true)
    }
    mount(
      <HostStoreProviders value={expandedStore}>
        <Sidebar />
      </HostStoreProviders>,
    )
    const collapseBtn = host?.querySelector<HTMLButtonElement>('.desktop-sidebar-collapse-btn')
    assert.ok(collapseBtn, '侧栏展开态应存在桌面折叠按钮')
    await act(async () => {
      collapseBtn.click()
    })
    assert.equal(toggleCount, 1)

    const collapsedStore = makeTestStore({
      sidebarCollapsed: true,
    })
    ;(collapsedStore.actions as unknown as { toggleSidebarCollapsed: () => void }).toggleSidebarCollapsed = () => {
      toggleCount += 1
      collapsedStore.actions.setSidebarCollapsed(false)
    }
    mount(
      <HostStoreProviders value={collapsedStore}>
        <Sidebar />
      </HostStoreProviders>,
    )
    const expandBtn = host?.querySelector<HTMLButtonElement>('.desktop-sidebar-expand-btn')
    assert.ok(expandBtn, '侧栏折叠态在 Rail 顶部应存在桌面展开按钮')
    await act(async () => {
      expandBtn.click()
    })
    assert.equal(toggleCount, 2)
  })
})
