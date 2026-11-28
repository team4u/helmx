/**
 * 插件 client 模块样式生命周期测试：
 * - 编译产物仅携带样式文本导出（__helmxClientCss），模块求值绝不写 DOM；
 *   样式注入/更新/回收全部由 loader 在有效性与 entry 身份校验后统一完成。
 * - node 测试将 Blob URL 转为独一 data URL（模块真实求值）；确定性 gate（模块顶层
 *   await）暂停 import，验证停用/reset 后迟到完成显式失效且零残留、不碰新 epoch 样式。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import React, { act } from 'react'
import { scopePluginCss } from '@helmx/plugin-client'
import {
  loadPluginClientModule,
  seedPluginClientModule,
  evictPluginClientCache,
  resetPluginClientCache,
  getCachedClientComponent,
  requireClientExport,
  subscribePluginClientCacheInvalidation,
  getPluginClientCacheRevision,
  PluginClientError,
} from '../src/lib/plugin-client.js'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const { Dialog, DialogContent, DialogPortal, DialogTitle } = await import('@helmx/ui')
const { PluginUiView } = await import('../src/ui/PluginUiView.js')
const { CodeBlockRenderer } = await import('../src/conversation/CodeBlockRenderer.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')


const originalFetch = globalThis.fetch
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const CSS_PLUGIN_SELECTOR = 'style[data-helmx-plugin-css-plugin]'
describe("plugin-client-css", () => {


  afterEach(() => {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    resetPluginClientCache()
  })

  /** node 环境无 Blob URL 模块加载：转独一 data URL，保证模块按次真实求值（含重试）。 */
  let moduleSeq = 0
  let nextDataUrl: string | undefined
  let nextCode = ''
  let nextHash = ''
  let objectUrlCalls = 0

  function installDataUrlModuleServing(): void {
    globalThis.fetch = async () => new Response(nextCode, { headers: { 'x-helmx-client-hash': nextHash } })
    URL.createObjectURL = (() => {
      objectUrlCalls++
      const url = nextDataUrl
      if (url === undefined) throw new Error('测试未预置模块 data URL，出现意外的重复 import')
      nextDataUrl = undefined
      return url
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  }

  function serveModule(code: string, hash: string): void {
    nextHash = hash
    nextCode = code
    nextDataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`/*helmx-css-${++moduleSeq}*/\n${code}`)}`
  }

  const cssExport = (css: string): string => `export const __helmxClientCss = ${JSON.stringify(css)}\n`
  const PANEL_EXPORT = 'export function Panel() { return "panel" }\n'
  /** 顶层 await gate：模块求值暂停，直到测试显式放行（模拟 import 在途的确定窗口）；必须是纯 JS（data URL 不经转译）。 */
  const GATED = 'await new Promise((resolve) => { globalThis.__helmxCssGate = resolve })\n'

  const gateSlot = globalThis as unknown as { __helmxCssGate?: () => void }

  async function waitForGate(timeoutMs = 5000): Promise<() => void> {
    const deadline = Date.now() + timeoutMs
    while (gateSlot.__helmxCssGate === undefined) {
      if (Date.now() > deadline) throw new Error('等待模块求值 gate 超时')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const resume = gateSlot.__helmxCssGate
    delete gateSlot.__helmxCssGate
    return resume
  }

  const styleKey = (pluginId: string, moduleRef: string): string => `${pluginId}::${moduleRef}`

  function pluginStyle(pluginId: string, moduleRef: string): HTMLStyleElement | null {
    return document.querySelector(`style[data-helmx-plugin-css="${styleKey(pluginId, moduleRef)}"]`)
  }

  function allPluginStyles(): NodeListOf<HTMLStyleElement> {
    return document.querySelectorAll(CSS_PLUGIN_SELECTOR)
  }

  async function assertInvalidated(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(
      promise,
      (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
      '失效后的在途加载必须以 client_module_invalidated 显式报错收场',
    )
  }

  test('样式装载成功：单入口单 style 节点，属性齐全，模块命名空间原样返回', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
    const loaded = await loadPluginClientModule('p', 'index.tsx')
    assert.equal(loaded.contentHash, 'h1')
    assert.equal(loaded.module.__helmxClientCss, '.a { color: red }')
    assert.equal(typeof loaded.module.Panel, 'function')
    const style = pluginStyle('p', 'index.tsx')
    assert.ok(style instanceof HTMLStyleElement, '模块装载成功后必须注入样式节点')
    assert.equal(style.getAttribute('data-helmx-plugin-css-plugin'), 'p')
    assert.equal(style.getAttribute('data-helmx-plugin-css-hash'), 'h1')
    assert.equal(style.textContent, scopePluginCss('.a { color: red }', 'p'))
    assert.ok(style.isConnected && document.head.contains(style), '样式节点应挂载在 head')
    // resolved 缓存发布不晚于样式装载：同步命中时样式必已在页面上
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), loaded.module.Panel)
  })

  test('同 hash 并发与缓存命中：单次 import 去重、同一节点复用不闪烁不累积', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
    objectUrlCalls = 0
    const [first, second] = await Promise.all([
      loadPluginClientModule('p', 'index.tsx'),
      loadPluginClientModule('p', 'index.tsx'),
    ])
    assert.equal(first.module, second.module, '同 hash 并发必须共享同一模块命名空间')
    assert.equal(objectUrlCalls, 1, '同 hash 并发只允许一次真实 import')
    assert.equal(allPluginStyles().length, 1, '并发去重不得产生重复 style 标签')
    const nodeBefore = pluginStyle('p', 'index.tsx')
    const third = await loadPluginClientModule('p', 'index.tsx')
    assert.equal(objectUrlCalls, 1, '缓存命中不得重新 import')
    assert.equal(third.module, first.module)
    assert.ok(pluginStyle('p', 'index.tsx') === nodeBefore, '缓存命中不得拆除重建样式节点（不闪烁）')
    assert.equal(allPluginStyles().length, 1)
  })

  test('同入口换 hash 原位更新；无样式导出与空字符串均移除旧样式', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`${cssExport('.v1 { color: red }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p', 'index.tsx')
    const v1 = pluginStyle('p', 'index.tsx')
    assert.ok(v1)

    serveModule(`${cssExport('.v2 { color: blue }')}${PANEL_EXPORT}`, 'h2')
    await loadPluginClientModule('p', 'index.tsx')
    assert.equal(allPluginStyles().length, 1, '换 hash 必须原位替换，不得累积标签')
    const v2 = pluginStyle('p', 'index.tsx')
    assert.ok(v2 === v1, '同入口更新复用同一节点')
    assert.ok(v2 !== null)
    assert.equal(v2.textContent, scopePluginCss('.v2 { color: blue }', 'p'))
    assert.equal(v2.getAttribute('data-helmx-plugin-css-hash'), 'h2')

    serveModule(PANEL_EXPORT, 'h3')
    await loadPluginClientModule('p', 'index.tsx')
    assert.ok(pluginStyle('p', 'index.tsx') === null, '新版无样式导出必须移除旧样式')

    serveModule(`${cssExport('.v4 { color: green }')}${PANEL_EXPORT}`, 'h4')
    await loadPluginClientModule('p', 'index.tsx')
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.v4 { color: green }', 'p'))

    serveModule(`${cssExport('')}${PANEL_EXPORT}`, 'h5')
    await loadPluginClientModule('p', 'index.tsx')
    assert.ok(pluginStyle('p', 'index.tsx') === null, '空字符串样式等同无样式，必须移除旧标签')
    assert.equal(allPluginStyles().length, 0)
  })

  test('停用仅回收目标插件样式；重新启用后同 hash 重新装载', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p', 'index.tsx')
    serveModule(`${cssExport('.b { color: blue }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p2', 'index.tsx')
    assert.equal(allPluginStyles().length, 2)

    evictPluginClientCache('p')
    assert.ok(pluginStyle('p', 'index.tsx') === null, '停用必须回收该插件样式')
    assert.ok(pluginStyle('p2', 'index.tsx'), '不得误删其他插件样式')
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined)

    serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p', 'index.tsx')
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.a { color: red }', 'p'), '重新启用后样式恢复')

    resetPluginClientCache()
    assert.equal(allPluginStyles().length, 0, 'reset（登出/快照重建）必须回收全部插件样式')
  })

  test('确定性 gate：import 在途时停用或 reset，放行后显式失效且零样式残留', { timeout: 60_000 }, async () => {
    for (const [label, invalidate] of [
      ['停用', () => evictPluginClientCache('p')],
      ['reset', () => resetPluginClientCache()],
    ] as const) {
      installDataUrlModuleServing()
      serveModule(`${GATED}${cssExport('.late { color: red }')}${PANEL_EXPORT}`, 'h1')
      const pending = loadPluginClientModule('p', 'index.tsx')
      const resume = await waitForGate()
      invalidate()
      resume()
      await assertInvalidated(pending)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(allPluginStyles().length, 0, `${label}后迟到的模块完成不得补挂样式`)
      assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined, `${label}后不得填回缓存`)
    }
  })

  test('旧 epoch 在途 import 完成不得改写或重建新 epoch 已装载的样式', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    // 场景一：新 epoch 换新 hash 已装样式，旧 epoch 同入口迟到完成
    serveModule(`${GATED}${cssExport('.old { color: red }')}${PANEL_EXPORT}`, 'h1')
    const stale = loadPluginClientModule('p', 'index.tsx')
    const resumeStale = await waitForGate()
    evictPluginClientCache('p')
    serveModule(`${cssExport('.new { color: blue }')}${PANEL_EXPORT}`, 'h2')
    await loadPluginClientModule('p', 'index.tsx')
    const fresh = pluginStyle('p', 'index.tsx')
    assert.equal(fresh?.textContent, scopePluginCss('.new { color: blue }', 'p'))

    resumeStale()
    await assertInvalidated(stale)
    assert.ok(pluginStyle('p', 'index.tsx') === fresh, '旧 epoch 完成不得拆除新 epoch 的样式节点')
    assert.equal(fresh?.textContent, scopePluginCss('.new { color: blue }', 'p'), '旧 epoch 完成不得改写新 epoch 的样式文本')
    assert.equal(fresh?.getAttribute('data-helmx-plugin-css-hash'), 'h2')
    assert.equal(allPluginStyles().length, 1)

    // 场景二：停用已回收样式后，同 hash 旧 import 迟到完成不得重新创建样式
    serveModule(`${GATED}${cssExport('.gone { color: red }')}${PANEL_EXPORT}`, 'h1')
    const stale2 = loadPluginClientModule('p', 'index.tsx')
    const resumeStale2 = await waitForGate()
    evictPluginClientCache('p')
    assert.equal(allPluginStyles().length, 0)
    resumeStale2()
    await assertInvalidated(stale2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(allPluginStyles().length, 0, '失效旧 import 不得按同 hash 重新创建已回收的样式')
  })

  test('import 抛错不装样式；同 hash 修复后可重试并装载', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`throw new Error('模块求值失败')\n${cssExport('.never { color: red }')}`, 'same')
    await assert.rejects(
      loadPluginClientModule('p', 'index.tsx'),
      (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_import_failed' && err.message.includes('模块求值失败'),
    )
    assert.equal(allPluginStyles().length, 0, 'import 失败不得装载样式')

    serveModule(`${cssExport('.fixed { color: green }')}${PANEL_EXPORT}`, 'same')
    const retried = await loadPluginClientModule('p', 'index.tsx')
    assert.equal(retried.module.__helmxClientCss, '.fixed { color: green }')
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.fixed { color: green }', 'p'), '同 hash 重试成功后正常装载')
  })

  test('保留导出非字符串属非法契约：显式报错、不装样式、缓存可重试', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    serveModule(`export const __helmxClientCss = 42\n${PANEL_EXPORT}`, 'h1')
    await assert.rejects(
      loadPluginClientModule('p', 'index.tsx'),
      (err: unknown) =>
        err instanceof PluginClientError && err.code === 'client_module_css_invalid' && err.message.includes('number'),
      '保留导出类型非法必须显式 PluginClientError，不得静默忽略',
    )
    assert.equal(allPluginStyles().length, 0)
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), undefined, '非法 metadata 不得发布缓存')

    serveModule(`${cssExport('.ok { color: red }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p', 'index.tsx')
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.ok { color: red }', 'p'))
  })

  test('requireClientExport 的可用导出清单隐藏保留 CSS 字段', { timeout: 60_000 }, () => {
    const module = { Panel() {}, __helmxClientCss: '.a { color: red }' }
    assert.equal(requireClientExport('p', 'index.tsx', 'Panel', module), module.Panel)
    assert.throws(
      () => requireClientExport('p', 'index.tsx', 'Missing', module),
      (err: unknown) => err instanceof PluginClientError && err.message.includes('Panel') && !err.message.includes('__helmxClientCss'),
    )
  })

  test('seedPluginClientModule 遵循同一样式契约：装载、按新种子更新、非法类型显式报错', { timeout: 60_000 }, () => {
    const panel = () => null
    seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmxClientCss: '.seed1 { color: red }' })
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.seed1 { color: red }', 'p'))
    assert.equal(pluginStyle('p', 'index.tsx')?.getAttribute('data-helmx-plugin-css-hash'), 'seeded')
    const node = pluginStyle('p', 'index.tsx')
    seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmxClientCss: '.reseeded { color: green }' })
    assert.ok(pluginStyle('p', 'index.tsx') === node, '默认 seeded hash 相同也应按新命名空间原位更新')
    assert.equal(node?.textContent, scopePluginCss('.reseeded { color: green }', 'p'))

    // 无样式导出的新种子移除旧样式
    seedPluginClientModule('p', 'index.tsx', { Panel: panel }, 'seed2')
    assert.ok(pluginStyle('p', 'index.tsx') === null)

    seedPluginClientModule('p', 'index.tsx', { Panel: panel, __helmxClientCss: '.seed3 { color: blue }' }, 'seed3')
    assert.equal(pluginStyle('p', 'index.tsx')?.textContent, scopePluginCss('.seed3 { color: blue }', 'p'))

    assert.throws(
      () => seedPluginClientModule('p', 'other.tsx', { Panel: panel, __helmxClientCss: [] }),
      (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_css_invalid' && err.message.includes('object'),
    )
    assert.equal(getCachedClientComponent('p', 'other.tsx', 'Panel'), undefined, '非法 seed 不得写入缓存')
  })

  test('缓存失效通知：仅 evict/reset 触发，正常 load/seed 不通知；revision 稳定且只随失效变化', { timeout: 60_000 }, async () => {
    installDataUrlModuleServing()
    const notified: string[] = []
    const unsubscribe = subscribePluginClientCacheInvalidation(() => notified.push('tick'))
    const revisionBefore = getPluginClientCacheRevision('p')
    assert.equal(getPluginClientCacheRevision('p'), revisionBefore, '无失效时 revision 必须稳定（同值快照）')

    serveModule(`${cssExport('.a { color: red }')}${PANEL_EXPORT}`, 'h1')
    await loadPluginClientModule('p', 'index.tsx')
    seedPluginClientModule('q', 'index.tsx', { Panel: () => null })
    assert.deepEqual(notified, [], '正常 load/seed 不得触发失效通知（避免循环）')
    assert.equal(getPluginClientCacheRevision('p'), revisionBefore)

    evictPluginClientCache('p')
    assert.equal(notified.length, 1, '停用后必须通知')
    assert.notEqual(getPluginClientCacheRevision('p'), revisionBefore, '目标插件 revision 必须变化')
    const qRevisionBefore = getPluginClientCacheRevision('q')
    assert.equal(getPluginClientCacheRevision('q'), qRevisionBefore, '未停用插件的 revision 不变')

    resetPluginClientCache()
    assert.equal(notified.length, 2, 'reset 后必须通知')
    assert.notEqual(getPluginClientCacheRevision('q'), qRevisionBefore, 'reset 推进全局 cacheEpoch')

    unsubscribe()
    evictPluginClientCache('p')
    assert.equal(notified.length, 2, '退订后不得再收到通知')
  })

  test('生产宿主样式作用域隔离：PluginUiView 与 CodeBlockRenderer 挂 <PluginScope>，SDK Portal 自动带 data-plugin-id 且跨插件/宿主零串扰', { timeout: 60_000 }, async () => {
    const AlphaPanel = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement('div', { className: 'shared-card', 'data-testid': 'alpha-card' }, 'Alpha'),
        React.createElement(
          Dialog,
          { open: true },
          React.createElement(
            DialogPortal,
            null,
            React.createElement(
              DialogContent,
              { className: 'shared-modal', 'aria-describedby': undefined },
              React.createElement(DialogTitle, null, 'Alpha Modal'),
              React.createElement('span', { className: 'shared-card', 'data-testid': 'alpha-portal-card' }, 'Modal'),
            ),
          ),
        ),
      )
    const BetaPanel = () =>
      React.createElement('div', { className: 'shared-card', 'data-testid': 'beta-card' }, 'Beta')
    const CodePanel = ({ code }: { code: string }) =>
      React.createElement('div', { className: 'shared-card', 'data-testid': 'code-card' }, code)

    seedPluginClientModule('p:alpha', 'index.tsx', {
      AlphaPanel,
      __helmxClientCss: '.shared-card { color: rgb(255, 0, 0); } .shared-modal { color: rgb(10, 20, 30); }',
    }, 'h-alpha')
    seedPluginClientModule('p:beta', 'index.tsx', {
      BetaPanel,
      __helmxClientCss: '.shared-card { color: rgb(0, 0, 255); }',
    }, 'h-beta')
    seedPluginClientModule('p:code', 'code.tsx', {
      CodePanel,
      __helmxClientCss: '.shared-card { color: rgb(0, 128, 0); }',
    }, 'h-code')

    const store = makeTestStore({
      plugins: [
        { id: 'p:alpha', name: 'Alpha', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'h-alpha' } },
        { id: 'p:beta', name: 'Beta', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'index.tsx': 'h-beta' } },
        { id: 'p:code', name: 'Code', locked: false, enabled: true, status: 'active', hooks: [], actions: [], tools: [], clientHashes: { 'code.tsx': 'h-code' } },
      ],
      uiContributions: [
        {
          pluginId: 'p:code',
          surface: 'markdown.codeBlock',
          spec: { id: 'p-code-block', languages: ['xlang'], client: { module: 'code.tsx', export: 'CodePanel' } },
        },
      ],
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          React.createElement(
            HostStoreProviders,
            { value: store },
            React.createElement('div', { className: 'shared-card', 'data-testid': 'host-card' }, 'Host'),
            React.createElement(PluginUiView, {
              pluginId: 'p:alpha',
              spec: { client: { module: 'index.tsx', export: 'AlphaPanel' } },
            }),
            React.createElement(PluginUiView, {
              pluginId: 'p:beta',
              spec: { client: { module: 'index.tsx', export: 'BetaPanel' } },
            }),
            React.createElement(CodeBlockRenderer, { language: 'xlang', code: 'hello' }),
          ),
        )
      })

      const hostCard = container.querySelector('[data-testid="host-card"]') as HTMLElement | null
      const alphaCard = container.querySelector('[data-testid="alpha-card"]') as HTMLElement | null
      const betaCard = container.querySelector('[data-testid="beta-card"]') as HTMLElement | null
      const codeCard = container.querySelector('[data-testid="code-card"]') as HTMLElement | null
      const alphaModal = document.body.querySelector('.shared-modal') as HTMLElement | null
      const alphaPortalCard = document.body.querySelector('[data-testid="alpha-portal-card"]') as HTMLElement | null

      assert.ok(hostCard && alphaCard && betaCard && codeCard && alphaModal && alphaPortalCard)

      // 1. PluginUiView 和 CodeBlockRenderer 均用 layout-transparent <PluginScope> 标记 data-plugin-id
      const alphaScope = alphaCard.parentElement as HTMLElement | null
      const betaScope = betaCard.parentElement as HTMLElement | null
      const codeScope = codeCard.parentElement as HTMLElement | null
      assert.equal(alphaScope?.getAttribute('data-plugin-id'), 'p:alpha')
      assert.equal(alphaScope?.style.display, 'contents')
      assert.equal(betaScope?.getAttribute('data-plugin-id'), 'p:beta')
      assert.equal(codeScope?.getAttribute('data-plugin-id'), 'p:code')
      assert.ok(hostCard.closest('[data-plugin-id]') === null, '宿主普通元素不得带 data-plugin-id')

      // 2. SDK Portal (DialogContent) 自动打标 data-plugin-id，避免重复包壳
      assert.equal(alphaModal.getAttribute('data-plugin-id'), 'p:alpha')

      // 2.5 生产注入的样式标签已用 @layer plugin-ui 包裹
      for (const styleEl of allPluginStyles()) {
        assert.match(styleEl.textContent ?? '', /^@layer plugin-ui \{[\s\S]*\}$/, '插件样式节点必须包裹在 @layer plugin-ui 中')
        // happy-dom CSSOM 暂不解析 @layer 块：仅在测试内剥除最外层 @layer 壳以驱动真实 getComputedStyle 选择器隔离断言
        styleEl.textContent = (styleEl.textContent ?? '').replace(/^@layer plugin-ui \{\n?([\s\S]*)\n?\}$/, '$1')
      }

      // 3. 真实样式计算：各插件同名 .shared-card 互不串扰、不污染宿主且在 Portal 中生效
      assert.equal(getComputedStyle(alphaCard).color, 'rgb(255, 0, 0)')
      assert.equal(getComputedStyle(alphaModal).color, 'rgb(10, 20, 30)')
      assert.equal(getComputedStyle(alphaPortalCard).color, 'rgb(255, 0, 0)')
      assert.equal(getComputedStyle(betaCard).color, 'rgb(0, 0, 255)')
      assert.equal(getComputedStyle(codeCard).color, 'rgb(0, 128, 0)')
      assert.notEqual(getComputedStyle(hostCard).color, 'rgb(255, 0, 0)')
      assert.notEqual(getComputedStyle(hostCard).color, 'rgb(0, 0, 255)')
      assert.notEqual(getComputedStyle(hostCard).color, 'rgb(0, 128, 0)')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
