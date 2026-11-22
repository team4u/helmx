/**
 * P3 Plugin-to-Plugin 子插槽测试：
 * - plugin-slot-model 纯函数：target 匹配、scope 过滤、priority 降序 order 升序稳定排序；
 * - <PluginSlot /> 真实渲染（client 轨）：短名自动拼全限定名、single 取首项、
 *   fallback、子项 ctx.pluginId 是贡献者；
 * - 环保护：同一贡献项在渲染链再次出现时显式环告警且不死循环。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginUiContribution } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
type Root = import('react-dom/client').Root
const { PluginClientContext, createPluginClientContext, usePluginContext, PluginSlot } = await import('@helmx/plugin-client')
const { groupUiContributions, matchesUiScope } = await import('../src/lib/types.js')
type HelmxStoreValue = import('../src/lib/types.js').HelmxStoreValue
const { collectSlotItems, isValidSlotTarget } = await import('../src/ui/plugin-slot-model.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { makeTestStore } = await import('./helpers/store.js')
type HelmxExternalStore = import('../src/lib/helmx-store.js').HelmxExternalStore
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { createPluginClientHostPort } = await import('../src/lib/plugin-client-host.js')

const e = React.createElement

const slotContribution = (pluginId: string, id: string, target: string, extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId,
  surface: 'plugin.slot',
  spec: { id, target, client: { module: 'x.tsx', export: 'X' }, ...extra },
})

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('isValidSlotTarget：恰一个 / 且两段标识符合法', { timeout: 60_000 }, () => {
  assert.equal(isValidSlotTarget('builtin:herdr/overview-header'), true)
  assert.equal(isValidSlotTarget('a/b/c'), false, '两个 / 非法')
  assert.equal(isValidSlotTarget('/b'), false)
  assert.equal(isValidSlotTarget('a/'), false)
  assert.equal(isValidSlotTarget('ow ner/panel'), false, 'owner 含空格非法')
  assert.equal(isValidSlotTarget('owner/panel x'), false, 'slotName 含空格非法')
  assert.equal(isValidSlotTarget(''), false)
})

test('collectSlotItems：target 全等 + scope 过滤 + priority 降序 order 升序稳定', { timeout: 60_000 }, () => {
  const items = [
    { pluginId: 'p1', spec: { id: 'a', target: 'owner/zone', client: { module: 'a.tsx', export: 'A' } } },               // priority 0, order 100
    { pluginId: 'p2', spec: { id: 'b', target: 'owner/zone', client: { module: 'b.tsx', export: 'B' }, priority: 10 } }, // 高优先
    { pluginId: 'p3', spec: { id: 'c', target: 'owner/zone', client: { module: 'c.tsx', export: 'C' }, priority: 10, order: 5 } }, // 高优先 + 小 order
    { pluginId: 'p4', spec: { id: 'd', target: 'other/zone', client: { module: 'd.tsx', export: 'D' }, priority: 99 } }, // 不同插槽
    { pluginId: 'p5', spec: { id: 'e', target: 'owner/zone', client: { module: 'e.tsx', export: 'E' }, scope: { tags: ['worker'] } } }, // scope 不命中
  ]
  const all = (scope?: unknown) => scope === undefined
  const ranked = collectSlotItems(items as never, 'owner/zone', all)
  assert.deepEqual(ranked.map((r) => r.spec.id), ['c', 'b', 'a'], 'priority 降序 -> order 升序 -> 贡献顺序')
  assert.deepEqual(collectSlotItems(items as never, 'bad/target/name', all), [], '非法 target 直接返回空列表')
  // 同分稳定：全部无 priority/order 时保持原序
  const same = collectSlotItems([
    { pluginId: 'x', spec: { id: 'x1', target: 'o/z', client: { module: 'x.tsx', export: 'X' } } },
    { pluginId: 'y', spec: { id: 'y1', target: 'o/z', client: { module: 'y.tsx', export: 'Y' } } },
  ] as never, 'o/z', all)
  assert.deepEqual(same.map((s) => s.spec.id), ['x1', 'y1'])
})

// ---------------------------------------------------------------------------
// 渲染（client 轨 + JSON 轨）
// ---------------------------------------------------------------------------

function slotContributionUi(contributions: PluginUiContribution[]): HelmxExternalStore {
  return makeTestStore({
    uiContributions: contributions,
  })
}

function renderToString(host: HTMLElement, element: React.ReactElement): Root {
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(element)
  })
  // client 轨组件经异步模块解析：再推进一次微任务批次确保挂载完成
  act(() => { root!.render(element) })
  return root!
}

test('PluginSlot：短名拼全限定、贡献项渲染、子项 ctx.pluginId 是贡献者', { timeout: 60_000 }, () => {
  // 贡献者插件 p2 提供一个 client 组件读取 usePluginContext 暴露 pluginId
  const contribModule = {
    ZoneBadge: (props: Record<string, unknown>) => {
      const ctx = usePluginContext()
      return e('div', { 'data-zone': String(props['zone']) }, `contributor:${ctx.pluginId}`)
    },
  }
  seedPluginClientModule('p2', 'zone.tsx', contribModule)
  const store = slotContributionUi([slotContribution('p2', 'badge', 'owner/zone', { client: { module: 'zone.tsx', export: 'ZoneBadge' } })])
  const ownerCtx = createPluginClientContext(createPluginClientHostPort(store), 'owner', undefined)
  const host = document.createElement('div')
  const root = renderToString(host, e(
    HostStoreProviders, { value: store },
    e(PluginClientContext.Provider, { value: ownerCtx },
      e(PluginSlot, { name: 'zone', slotProps: { zone: 'east' } })),
  ))
  const node = host.querySelector('[data-zone="east"]')
  assert.ok(node !== null, '贡献项渲染在插槽内')
  assert.equal(node!.textContent, 'contributor:p2', '子项上下文 pluginId 是贡献者 p2 而非 owner')
  act(() => { root.unmount() })
})

test('PluginSlot：single 取首项、无命中回退 fallback', { timeout: 60_000 }, () => {
  seedPluginClientModule('p1', 'a.tsx', { ItemA: () => e('div', null, 'A') })
  seedPluginClientModule('p2', 'b.tsx', { ItemB: () => e('div', null, 'B') })
  const store = slotContributionUi([
    slotContribution('p1', 'a', 'owner/zone', { client: { module: 'a.tsx', export: 'ItemA' } }),
    slotContribution('p2', 'b', 'owner/zone', { client: { module: 'b.tsx', export: 'ItemB' }, priority: 5 }),
  ])
  const ownerCtx = createPluginClientContext(createPluginClientHostPort(store), 'owner', undefined)
  const host = document.createElement('div')
  const root = renderToString(host, e(
    HostStoreProviders, { value: store },
    e(PluginClientContext.Provider, { value: ownerCtx },
      e(PluginSlot, { name: 'zone', mode: 'single' })),
  ))
  assert.equal(host.textContent, 'B', 'single 模式仅渲染 priority 最高的首项')
  act(() => { root.unmount() })

  const host2 = document.createElement('div')
  const root2 = renderToString(host2, e(
    HostStoreProviders, { value: store },
    e(PluginClientContext.Provider, { value: ownerCtx },
      e(PluginSlot, { name: 'empty-slot', fallback: e('div', null, 'nope') })),
  ))
  assert.equal(host2.textContent, 'nope', '无命中渲染 fallback')
  act(() => { root2.unmount() })
})

test('PluginSlot：环检测显式告警且不死循环', { timeout: 60_000 }, () => {
  // 构造 owner 的插件组件渲染 <PluginSlot name="loop">，p2 的贡献项再渲染
  // 指向 owner/loop 的 <PluginSlot name="loop">（同名自嵌套等价环）。
  // 用 client 组件自嵌套最简模型：贡献项组件渲染 PluginSlot 同名插槽。
  const cycleModule = {
    CycleItem: () => {
      usePluginContext()
      // 贡献者 p2 渲染链上再次渲染指向 owner/loop 的插槽（显式全限定名构成真实环）
      return e(PluginSlot, { name: 'owner/loop' })
    },
  }
  seedPluginClientModule('p2', 'cycle.tsx', cycleModule)
  const store = slotContributionUi([slotContribution('p2', 'cycle', 'owner/loop', { client: { module: 'cycle.tsx', export: 'CycleItem' } })])
  const ownerCtx = createPluginClientContext(createPluginClientHostPort(store), 'owner', undefined)
  const host = document.createElement('div')
  const root = renderToString(host, e(
    HostStoreProviders, { value: store },
    e(PluginClientContext.Provider, { value: ownerCtx },
      e(PluginSlot, { name: 'loop' })),
  ))
  assert.ok(host.textContent !== undefined)
  // Terminates within a bounded depth: the rendered output contains the cycle
  // warning text (p2/cycle appears twice along the chain).
  assert.match(host.textContent ?? '', /Plugin slot cycle detected/, 'explicit cycle warning instead of a stack overflow')
  act(() => { root.unmount() })
})

test('matchesUiScope：按模型供应商、profileId 与 tags 组合过滤（原 ui-scope.test.ts 合并）', { timeout: 60_000 }, () => {
  const scopeConversation: ConversationSummary = {
    id: 1, title: 'Scope fixture', profileId: 'assistant', tags: ['work'],
    cwd: '/tmp', model: 'example/group/nested-model', thinkingLevel: '', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
  const scope = { modelProviders: ['example'], profileIds: ['assistant'], tags: ['work'] }
  assert.equal(matchesUiScope(scopeConversation, scope), true)
  assert.equal(matchesUiScope({ ...scopeConversation, model: 'another/model' }, scope), false)
  assert.equal(matchesUiScope({ ...scopeConversation, profileId: 'another' }, scope), false)
  assert.equal(matchesUiScope({ ...scopeConversation, model: '' }, scope), false)
  assert.equal(matchesUiScope(scopeConversation, { modelProviders: [] }), false)
  assert.equal(matchesUiScope(undefined, scope), false)
  assert.equal(matchesUiScope(undefined, undefined), true)
})

test('PluginSlot：DOM 锚点、无 className 零布局盒、inline 与错误隔离降级语义', { timeout: 60_000 }, () => {
  seedPluginClientModule('p-ok', 'ok.tsx', { OkItem: () => e('span', { 'data-ok': '1' }, 'ok-item') })
  seedPluginClientModule('p-boom', 'boom.tsx', {
    BoomItem: () => {
      throw new Error('slot child crashed')
    },
  })

  const store = makeTestStore({
    uiContributions: [
      slotContribution('p-boom', 'boom', 'owner/resilient', {
        priority: 10,
        client: { module: 'boom.tsx', export: 'BoomItem' },
      }),
      {
        pluginId: 'p-missing',
        surface: 'plugin.slot',
        spec: { id: 'missing', target: 'owner/resilient', priority: 5 },
      },
      slotContribution('p-ok', 'ok', 'owner/resilient', {
        client: { module: 'ok.tsx', export: 'OkItem' },
      }),
    ],
  })

  const ownerCtx = createPluginClientContext(createPluginClientHostPort(store), 'owner', undefined)
  const host = document.createElement('div')
  const prevConsoleError = console.error
  let root: Root | undefined
  try {
    console.error = () => {}
    root = renderToString(
      host,
      e(
        HostStoreProviders,
        { value: store },
        e(
          PluginClientContext.Provider,
          { value: ownerCtx },
          e('div', null,
            e(PluginSlot, { name: 'resilient' }),
            e(PluginSlot, { name: 'resilient', className: 'slot-box' }),
            e(PluginSlot, { name: 'resilient', inline: true }),
          ),
        ),
      ),
    )
    const anchors = [...host.querySelectorAll<HTMLElement>('[data-helmx-slot="owner/resilient"]')]
    assert.equal(anchors.length, 3)
    assert.equal(anchors[0]!.tagName, 'DIV')
    assert.equal(anchors[0]!.style.display, 'contents', 'omitting className suppresses extra layout box')
    assert.ok(anchors[1]!.classList.contains('slot-box'))
    assert.equal(anchors[1]!.style.display, '', 'explicit className retains CSS layout box control')
    assert.equal(anchors[2]!.tagName, 'SPAN', 'inline renders a span wrapper')
    assert.equal(anchors[2]!.style.display, 'contents')

    // Isolated explicit errors: ViewBoundary catches BoomItem, MissingTrackError warns on p-missing, OkItem still renders
    assert.match(anchors[0]!.textContent ?? '', /slot child crashed/)
    assert.match(anchors[0]!.textContent ?? '', /declares no client component reference/)
    assert.ok(anchors[0]!.querySelector('[data-ok="1"]') !== null, 'healthy siblings keep rendering')
  } finally {
    console.error = prevConsoleError
    if (root) act(() => { root!.unmount() })
  }
})

test('createPluginClientHostPort：slots.collectItems 在 conversations 缺席时回退 conversationDetails 解析 scope', { timeout: 60_000 }, () => {
  const conv: ConversationSummary = {
    id: 77,
    title: 'Detail-only conv',
    profileId: 'assistant',
    tags: ['special'],
    cwd: '/tmp',
    model: 'example/m1',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const store = makeTestStore({
    conversations: [],
    conversationDetails: {
      77: { ...conv, entries: [] },
    },
    uiContributions: [
      slotContribution('p1', 'scoped', 'owner/detail-scope', {
        scope: { tags: ['special'] },
      }),
    ],
  })
  const port = createPluginClientHostPort(store)
  const matched = port.slots.collectItems('owner/detail-scope', 77)
  assert.equal(matched.length, 1)
  assert.equal(matched[0]!.contributionId, 'scoped')
  assert.equal(port.slots.collectItems('owner/detail-scope', 999).length, 0)
})
