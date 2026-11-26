/**
 * builtin:json-render 插件 DSL 纯函数测试（evaluator / spec-normalize / spec-action）。
 * 自 packages/web/test 迁入（声明式渲染已整体移出 Web 核心）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { evaluateSpecValue, type EvalScope } from '../src/json-render/client/evaluator.js'
import {
  formatSpecText,
  isFlatSpec,
  normalizeSpec,
  resolveKeyValueItems,
} from '../src/json-render/client/spec-normalize.js'
import { parseSendTarget, resolveSpecAction } from '../src/json-render/client/spec-action.js'
import { jsonRenderTabFallbackTitle } from '../src/json-render/client/copy.js'

// ---------------------------------------------------------------------------
// 双形态归一化
// ---------------------------------------------------------------------------

test('spec-normalize: 形态 A（树状简写）归一化为 NormalizedSpecNode 树', { timeout: 60_000 }, () => {
  // superagent.ts settingsPanel 真实写法
  const spec = {
    component: 'Stack',
    children: [
      { component: 'Text', variant: 'title', text: 'SuperAgent 中枢' },
      {
        component: 'KeyValueList',
        items: [{ key: '/$docs/index/routerConversationId', label: '中枢会话' }],
      },
      { component: 'Text', variant: 'muted', text: '说明文字' },
    ],
  }
  const result = normalizeSpec(spec)
  assert.equal(result.degraded, false)
  assert.ok(result.root)
  assert.equal(result.root!.component, 'Stack')
  assert.equal(result.root!.children.length, 3)
  assert.equal(result.root!.children[0]!.component, 'Text')
  assert.deepEqual(result.root!.children[0]!.props, { variant: 'title', text: 'SuperAgent 中枢' })
  // children 不应泄漏进 props
  assert.equal('children' in result.root!.props, false)
  assert.equal('component' in result.root!.props, false)
})

test('spec-normalize: 形态 B（扁平 @json-render）归一化并保留 props', { timeout: 60_000 }, () => {
  const spec = {
    root: 'r',
    elements: {
      r: { type: 'Card', props: { title: '卡片' }, children: ['t1'] },
      t1: { type: 'Text', props: { text: '内容' } },
    },
  }
  assert.equal(isFlatSpec(spec), true)
  const result = normalizeSpec(spec)
  assert.equal(result.degraded, false)
  assert.equal(result.root!.component, 'Card')
  assert.deepEqual(result.root!.props, { title: '卡片' })
  assert.equal(result.root!.children.length, 1)
  assert.equal(result.root!.children[0]!.component, 'Text')
  assert.equal(result.root!.children[0]!.props['text'], '内容')
})

test('spec-normalize: 非法输入降级并携带原因（不静默）', { timeout: 60_000 }, () => {
  assert.equal(normalizeSpec(null).degraded, true)
  assert.equal(normalizeSpec('text').degraded, true)
  assert.equal(normalizeSpec({}).degraded, true)
  assert.equal(normalizeSpec({ foo: 1 }).degraded, true)
  // 扁平形态根缺失
  const bad = normalizeSpec({ root: 'missing', elements: {} })
  assert.equal(bad.degraded, true)
  assert.ok(bad.reason!.includes('missing'))
})

test('spec-normalize: 循环引用不致死循环', { timeout: 60_000 }, () => {
  const spec = {
    root: 'a',
    elements: {
      a: { type: 'Stack', children: ['b'] },
      b: { type: 'Card', children: ['a'] },
    },
  }
  const result = normalizeSpec(spec)
  // 整体不降级（根合法），循环子节点成为局部降级节点
  assert.equal(result.degraded, false)
  const cycleChild = result.root!.children[0]!.children[0]!
  assert.ok(String(cycleChild.props['reason']).includes('circular'))
  // 显式 zh-CN：降级原因走中文口径（显示文案跟随宿主 locale）
  const zhResult = normalizeSpec(spec, 'zh-CN')
  assert.ok(String(zhResult.root!.children[0]!.children[0]!.props['reason']).includes('循环引用'))
})

// ---------------------------------------------------------------------------
// KeyValueList 两种写法
// ---------------------------------------------------------------------------

const kvScope: EvalScope = {
  $docs: {
    index: {
      routerConversationId: 2,
      watchdogConversationId: 3,
    },
    crons: { jobs: [{ id: 'j1' }, { id: 'j2' }] },
    webhooks: { webhooks: [{ id: 'w1' }] },
  },
}

test('KeyValueList: JSON Pointer key 写法求值作为展示值（superagent 真实写法）', { timeout: 60_000 }, () => {
  const items = [
    { key: '/$docs/index/routerConversationId', label: '中枢会话' },
    { key: '/$docs/index/watchdogConversationId', label: '看门狗会话' },
  ]
  const resolved = resolveKeyValueItems(items, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: '中枢会话', value: '2' },
    { label: '看门狗会话', value: '3' },
  ])
})

test('KeyValueList: .length 求值（triggers settingsPanel 真实写法）', { timeout: 60_000 }, () => {
  const items = [
    { key: '/$docs/crons/jobs/length', label: 'Cron 任务数' },
    { key: '/$docs/webhooks/webhooks/length', label: 'Webhook 端点数' },
  ]
  const resolved = resolveKeyValueItems(items, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: 'Cron 任务数', value: '2' },
    { label: 'Webhook 端点数', value: '1' },
  ])
})

test('KeyValueList: label+value 写法与已求值 value 直通', { timeout: 60_000 }, () => {
  // value 由 evaluateSpecValue 先行求值（整串单表达式保持原始类型）
  const evaluated = evaluateSpecValue<Array<Record<string, unknown>>>(
    [{ label: '名称', value: '{$docs.index.routerConversationId}' }],
    kvScope,
  )
  const resolved = resolveKeyValueItems(evaluated, () => undefined)
  assert.deepEqual(resolved, [{ label: '名称', value: '2' }])
})

// ---------------------------------------------------------------------------
// Table 行动作 $row 求值
// ---------------------------------------------------------------------------

test('Table rowActions: $row 注入后 input 保持数字类型、target 插值为字符串', { timeout: 60_000 }, () => {
  const scope: EvalScope = {
    $docs: {
      index: {
        workers: [
          { conversationId: 12, profileId: 'coder' },
          { conversationId: 15, profileId: 'researcher' },
        ],
      },
    },
  }
  const rows = evaluateSpecValue<unknown[]>('{$docs.index.workers}', scope)
  assert.ok(Array.isArray(rows))

  // 每一行模拟 Table 内部逻辑：row 注入 $row 后对 rowAction 求值
  const row = rows![0]! as Record<string, unknown>
  const rowScope: EvalScope = { ...scope, $row: row }

  const archiveAction = resolveSpecAction(
    { type: 'helmx:action', actionId: 'archive_worker', input: { workerConversationId: '{$row.conversationId}' } },
    rowScope,
  )
  assert.equal(archiveAction.kind, 'action')
  if (archiveAction.kind === 'action') {
    assert.equal(archiveAction.actionId, 'archive_worker')
    assert.equal(typeof archiveAction.input['workerConversationId'], 'number')
    assert.equal(archiveAction.input['workerConversationId'], 12)
  }

  const openAction = resolveSpecAction(
    { type: 'helmx:open', target: 'conversation:{$row.conversationId}' },
    rowScope,
  )
  assert.equal(openAction.kind, 'open')
  if (openAction.kind === 'open') {
    assert.equal(openAction.target, 'conversation:12')
    assert.equal(openAction.split, false)
  }
})

test('Table rowActions: split 打开（superagent timelineRenderer 真实写法）', { timeout: 60_000 }, () => {
  const scope: EvalScope = {
    $data: { entry: { data: { meta: { workerId: 12 } } } },
  }
  const action = resolveSpecAction(
    { type: 'helmx:open', target: 'conversation:{$data.entry.data.meta.workerId}', split: true },
    scope,
  )
  assert.equal(action.kind, 'open')
  if (action.kind === 'open') {
    assert.equal(action.target, 'conversation:12')
    assert.equal(action.split, true)
  }
})

// ---------------------------------------------------------------------------
// Switch $value 布尔注入与三指令边界
// ---------------------------------------------------------------------------

test('Switch: 新布尔值注入 $value 后 action input 保持 boolean', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: { routing: { routerMode: true } }, $value: false }
  const action = resolveSpecAction(
    { type: 'helmx:action', actionId: 'set_router_mode', input: { enabled: '{$value}' } },
    scope,
  )
  assert.equal(action.kind, 'action')
  if (action.kind === 'action') {
    assert.equal(typeof action.input['enabled'], 'boolean')
    assert.equal(action.input['enabled'], false)
  }
})

test('spec-action: helmx:send 目标解析与非法载荷显式拒绝', { timeout: 60_000 }, () => {
  assert.equal(parseSendTarget('conversation:42'), 42)
  assert.equal(parseSendTarget('42'), 42)
  assert.equal(parseSendTarget('conversation:abc'), null)

  const send = resolveSpecAction({ type: 'helmx:send', target: 'conversation:7', text: '开始巡检' }, {})
  assert.equal(send.kind, 'send')
  if (send.kind === 'send') {
    assert.equal(send.conversationId, 7)
    assert.equal(send.text, '开始巡检')
  }

  assert.equal(resolveSpecAction(null, {}).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'unknown' }, {}).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helmx:open', target: '' }, {}).kind, 'invalid')
})

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------

test('formatSpecText: undefined/null/数组/对象的展示格式', { timeout: 60_000 }, () => {
  assert.equal(formatSpecText(undefined), '—')
  assert.equal(formatSpecText(null), 'null')
  assert.equal(formatSpecText(true), 'true')
  assert.equal(formatSpecText(12), '12')
  assert.equal(formatSpecText('文本'), '文本')
  assert.equal(formatSpecText([1, 2]), '[1,2]')
  assert.equal(formatSpecText({ a: 1 }), '{"a":1}')
})

// ---------------------------------------------------------------------------
// 回归 1：Table rowActions 必须保留原始模板至行级 scope 点击时再求值
// ---------------------------------------------------------------------------

test('Table rowActions 回归: 外层 scope 不预求值，行级点击时 $row 注入后正确求值', { timeout: 60_000 }, () => {
  const tableScope: EvalScope = {
    $docs: {
      workers: [
        { conversationId: 12, profileId: 'coder' },
        { conversationId: 15, profileId: 'researcher' },
      ],
    },
  }

  // superagent 派工卡真实写法：rowActions 模板内含 {$row.xxx}
  const rowActionsTemplate = [
    {
      label: '查看',
      action: { type: 'helmx:open', target: 'conversation:{$row.conversationId}' },
    },
    {
      label: '归档',
      action: {
        type: 'helmx:action',
        actionId: 'archive_worker',
        input: { workerConversationId: '{$row.conversationId}' },
      },
    },
  ]

  // 修复后的行为：rowActions 保留原始模板（不 evalIn），外层 scope 求值仅用于 rows
  const rows = evaluateSpecValue<Array<Record<string, unknown>>>('{$docs.workers}', tableScope)
  assert.ok(Array.isArray(rows))

  // 模拟点击第 2 行「查看」：此刻才构造行级 scope 并对原始模板求值
  const rowScope: EvalScope = { ...tableScope, $row: rows[1]! }
  const open = resolveSpecAction(rowActionsTemplate[0]!['action'], rowScope)
  assert.equal(open.kind, 'open')
  if (open.kind === 'open') {
    assert.equal(open.target, 'conversation:15')
  }

  // 模拟点击第 2 行「归档」：input 保持 number 类型
  const archive = resolveSpecAction(rowActionsTemplate[1]!['action'], rowScope)
  assert.equal(archive.kind, 'action')
  if (archive.kind === 'action') {
    assert.equal(archive.input['workerConversationId'], 15)
    assert.equal(typeof archive.input['workerConversationId'], 'number')
  }
})

test('Table rowActions 回归: 若在外层 scope 预求值，target 会变成坏值 conversation:（旧 bug 机制）', { timeout: 60_000 }, () => {
  // 旧 bug 机制复现：外层无 $row 的 scope 下预求值 target 模板，$row 字段被吞成空串
  const premature = evaluateSpecValue<string>('conversation:{$row.conversationId}', { $docs: {} })
  assert.equal(premature, 'conversation:')
  // 修复后 TableImpl 保留原始模板至行级 scope 点击时才求值，
  // 行级求值结果始终携带真实 id（见上一个回归测试），坏值不再可能产生。
  // 此外 helmx:send 对坏 target 显式拒绝（不静默降级）：
  assert.equal(resolveSpecAction({ type: 'helmx:send', target: premature, text: 'x' }, {}).kind, 'invalid')
})

// ---------------------------------------------------------------------------
// 回归 2：KeyValueList 渲染路径（未经 evalIn 预求值的原始 items）
// ---------------------------------------------------------------------------

test('KeyValueList 回归: 原始 pointer key 模板直接传入渲染 helper 也能求值（不再显示破折号）', { timeout: 60_000 }, () => {
  // 修复后的 KeyValueListImpl 不再 evalIn(items)，直接把原始 items 交给本 helper
  // （这正是真实渲染所走的路径）
  const rawItems = [
    { key: '/$docs/index/routerConversationId', label: '中枢会话' },
    { key: '/$docs/index/watchdogConversationId', label: '看门狗会话' },
    { key: '/$docs/crons/jobs/length', label: 'Cron 任务数' },
  ]
  const resolved = resolveKeyValueItems(rawItems, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: '中枢会话', value: '2' },
    { label: '看门狗会话', value: '3' },
    { label: 'Cron 任务数', value: '2' },
  ])
})

test('KeyValueList 回归: 旧 bug 场景——key 被预求值成数字也能正常展示', { timeout: 60_000 }, () => {
  // 旧 bug 机制：若 items 被预求值，pointer key 变成 number，旧 helper 识别不出而显示破折号；
  // 修复后 helper 对已求值的具体值（非绑定表达式字符串）直接作展示值
  const preEvaluated = evaluateSpecValue<Array<Record<string, unknown>>>(
    [{ key: '/$docs/index/routerConversationId', label: '中枢会话' }],
    kvScope,
  )
  // 预求值产物：key 变成了 number 2
  assert.equal(typeof preEvaluated[0]!['key'], 'number')
  const resolved = resolveKeyValueItems(preEvaluated, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [{ label: '中枢会话', value: '2' }])
})

test('KeyValueList 回归: 普通 key、label+value、pointer key 三种写法混用', { timeout: 60_000 }, () => {
  const rawItems = [
    { key: 'plainKey' },
    { label: '名称', value: '直接值' },
    { key: '{$docs.index.routerConversationId}', label: '花括号写法' },
    { key: '/$docs/missing/path', label: '缺失路径' },
  ]
  const resolved = resolveKeyValueItems(rawItems, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: 'plainKey', value: 'plainKey' },
    { label: '名称', value: '直接值' },
    { label: '花括号写法', value: '2' },
    { label: '缺失路径', value: '—' },
  ])
})

// ---------------------------------------------------------------------------
// 回归 3：求值器安全加固
// ---------------------------------------------------------------------------

test('evaluator 回归: 普通文本 JSON 示例不被吃掉（非 $ 开头不识别为绑定）', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: {} }
  // 整串花括号内非 $ 开头：原样保留
  assert.equal(evaluateSpecValue('{"enabled":true}', scope), '{"enabled":true}')
  // 嵌入长文本的 JSON 示例：花括号内容原样保留
  assert.equal(
    evaluateSpecValue('配置示例 {"enabled":true} 与 {"mode":"auto"}，请参考', scope),
    '配置示例 {"enabled":true} 与 {"mode":"auto"}，请参考',
  )
  // 但真正的绑定表达式仍然生效（三种合法语法不变）
  assert.equal(evaluateSpecValue('conversation:{$row.id}', { $row: { id: 7 } }), 'conversation:7')
  assert.equal(evaluateSpecValue('{$docs.index.routerConversationId}', kvScope), 2)
  assert.equal(evaluateSpecValue('/$docs/index/routerConversationId', kvScope), 2)
  assert.deepEqual(evaluateSpecValue('{$docs["recall-graph"]}', { $docs: { 'recall-graph': { n: 1 } } }), { n: 1 })
})

test('evaluator 回归: number/bool 类型保持不变', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $value: false, $row: { n: 12, b: true } }
  assert.equal(evaluateSpecValue('{$value}', scope), false)
  assert.equal(typeof evaluateSpecValue('{$value}', scope), 'boolean')
  assert.equal(evaluateSpecValue('{$row.n}', scope), 12)
  assert.equal(typeof evaluateSpecValue('{$row.n}', scope), 'number')
  assert.equal(evaluateSpecValue('{$row.b}', scope), true)
  assert.equal(typeof evaluateSpecValue('{$row.b}', scope), 'boolean')
})

test('evaluator 回归: 原型链逃逸被阻断（只读 own property）', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: {} }
  // __proto__ / constructor / prototype 都不是普通对象的 own property：一律 undefined
  assert.equal(evaluateSpecValue('{$docs.__proto__}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.constructor}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.constructor.name}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.__proto__.polluted}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.toString}', scope), undefined)
  // 正常 own property 访问不受影响
  assert.equal(evaluateSpecValue('{$docs.index.routerConversationId}', kvScope), 2)
  // own property 上同名键仍可读（只读 own 语义不误伤合法数据）
  const withOwn = evaluateSpecValue('{$docs.constructor}', { $docs: { constructor: 'safe' } })
  assert.equal(withOwn, 'safe')
})

test('copy: Tabs 缺省标题跟随宿主 locale', { timeout: 60_000 }, () => {
  assert.equal(jsonRenderTabFallbackTitle(1, 'en'), 'Tab 1')
  assert.equal(jsonRenderTabFallbackTitle(2, 'zh-CN'), '标签页 2')
})

test('spec-normalize: MAX_SPEC_DEPTH=32 与 MAX_SPEC_NODES=1000 超限时安全降级（防病态深层/巨型 spec 卡死渲染）', { timeout: 60_000 }, async () => {
  const { MAX_SPEC_DEPTH, MAX_SPEC_NODES } = await import('../src/json-render/client/spec-normalize.js')
  assert.equal(MAX_SPEC_DEPTH, 32)
  assert.equal(MAX_SPEC_NODES, 1000)

  // 1) 深度 32 正常通过，深度 > 32 触发 degraded
  let okTree: Record<string, unknown> = { component: 'Text', text: 'leaf' }
  for (let d = 0; d < MAX_SPEC_DEPTH - 1; d += 1) {
    okTree = { component: 'Stack', children: [okTree] }
  }
  assert.equal(normalizeSpec(okTree).degraded, false)

  const tooDeepTree = {
    component: 'Stack',
    children: [{ component: 'Stack', children: [{ component: 'Stack', children: [okTree] }] }],
  }
  const deepRes = normalizeSpec(tooDeepTree)
  assert.equal(deepRes.degraded, true)
  assert.match(deepRes.reason ?? '', /depth/i)

  // 2) 节点总数 > 1000（树状与扁平两种形态）均显式降级
  const wideTree = {
    component: 'Stack',
    children: Array.from({ length: MAX_SPEC_NODES }, (_, i) => ({ component: 'Text', text: `n-${i}` })),
  }
  const wideRes = normalizeSpec(wideTree)
  assert.equal(wideRes.degraded, true)
  assert.match(wideRes.reason ?? '', /node/i)
})

test('spec-normalize: 扁平 elements 查表拦截原型链键（__proto__ / constructor / toString）', { timeout: 60_000 }, () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const res = normalizeSpec({ root: key, elements: {} })
    assert.equal(res.degraded, true, `扁平 root=${key} 不得命中原型链`)
  }
})

test('spec-primitives: 原型链查表拦截、组件切换 Hook 数量稳定，以及 Tabs / ActionBar 延迟求值回归', { timeout: 60_000 }, async (t) => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  if (typeof globalThis.document === 'undefined') {
    GlobalRegistrator.register()
  }
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const { createRequire } = await import('node:module')
  const { CLIENT_SHARED_GLOBALS, compilePluginClientModule } = await import('@helmx/plugin-build')
  const HelmxPluginClient = await import('@helmx/plugin-client')

  const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
  const React = req('react') as typeof import('react')
  const ReactJsxRuntime = req('react/jsx-runtime') as unknown
  const ReactDOMClient = req('react-dom/client') as {
    createRoot: (container: Element) => { render(node: import('react').ReactNode): void; unmount(): void }
  }
  const LucideReact = req('lucide-react') as unknown
  const g = globalThis as Record<string, unknown>
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] = HelmxPluginClient
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g['IS_REACT_ACT_ENVIRONMENT'] = true

  const here = dirname(fileURLToPath(import.meta.url))
  const cacheDir = mkdtempSync(join(tmpdir(), 'helmx-jr-primitives-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const compiled = await compilePluginClientModule(
    'builtin:json-render',
    resolve(here, '../src/json-render/client'),
    'spec-primitives.tsx',
    cacheDir,
  )
  const modPath = join(cacheDir, 'spec-primitives.mjs')
  writeFileSync(modPath, compiled.code, 'utf8')
  const { SpecNodeList } = (await import(pathToFileURL(modPath).href)) as {
    SpecNodeList: React.ComponentType<{ nodes: unknown[]; ctx: Record<string, unknown> }>
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  t.after(() => {
    React.act(() => root.unmount())
    container.remove()
  })

  const makeCtx = (
    scope: EvalScope,
    onAction: (rawAction: unknown, actionScope: EvalScope, pendingKey: string) => void = () => {},
  ): Record<string, unknown> => {
    const ctx: Record<string, unknown> = {
      scope,
      locale: 'en',
      runAction: onAction,
      isPending: () => false,
      isSucceeded: () => false,
      renderChildren: (children: unknown[]) => React.createElement(SpecNodeList, { nodes: children, ctx }),
    }
    return ctx
  }

  // 1) 原型链查表：PRIMITIVES / CALLOUT_TONE_CLASS / STEP_STATUS_META / BUTTON_VARIANT_CLASS / Table row[key]
  //    遇到 constructor / toString / hasOwnProperty 时一律按未知组件或默认值安全降级，绝不崩或输出函数源码
  const protoSpec = normalizeSpec({
    component: 'Stack',
    children: [
      { component: 'constructor' },
      { component: 'toString' },
      { component: 'hasOwnProperty' },
      { component: 'Callout', tone: 'toString', text: 'safe callout' },
      { component: 'Steps', items: [{ title: 'Step A', status: 'toString' }] },
      { component: 'Button', label: 'Proto Btn', variant: 'toString', action: { type: 'helmx:send', text: 'x' } },
      { component: 'Table', columns: [{ key: 'toString', label: 'Col' }], rows: [{ name: 'r1' }] },
    ],
  })
  assert.ok(protoSpec.root !== null)
  React.act(() => {
    root.render(React.createElement(SpecNodeList, { nodes: [protoSpec.root!], ctx: makeCtx({}) }))
  })
  const html = container.innerHTML
  assert.match(html, /Unregistered component: constructor/)
  assert.match(html, /Unregistered component: toString/)
  assert.match(html, /Unregistered component: hasOwnProperty/)
  assert.equal(html.includes('native code'), false, '原型链函数绝不得泄露到 className 或表格单元格')
  assert.match(html, /safe callout/)

  // 2) 组件切换 Hook 数量稳定：同一 SpecNodeList 位置从 Text(0 hooks) -> Button(1 hook) -> TextInput(4 hooks) -> Text(0 hooks)
  for (const spec of [
    { component: 'Text', text: 'step-0' },
    { component: 'Button', label: 'step-1', action: { type: 'helmx:send', text: 'go' } },
    { component: 'TextInput', label: 'step-2', value: 'v', action: { type: 'helmx:action', actionId: 'save', input: { v: '{$value}' } } },
    { component: 'Text', text: 'step-3' },
  ]) {
    const norm = normalizeSpec(spec)
    assert.ok(norm.root !== null)
    React.act(() => {
      root.render(React.createElement(SpecNodeList, { nodes: [norm.root!], ctx: makeCtx({}) }))
    })
  }
  assert.match(container.textContent ?? '', /step-3/)

  // 3) Tabs 不提前求值 children（保留 $row / $value / pointer key），且切 Tab 从 Text(0 hooks) 切到 Table/TextInput(多 hooks) 不崩
  const dispatched: Array<{ rawAction: unknown; scope: EvalScope }> = []
  const tabsSpec = normalizeSpec({
    component: 'Tabs',
    tabs: [
      {
        id: 'overview',
        label: 'Overview',
        children: [{ component: 'Text', text: 'plain overview' }],
      },
      {
        id: 'actions',
        label: 'Actions',
        children: [
          {
            component: 'KeyValueList',
            items: [{ key: '/$docs/status/total', label: 'Total' }],
          },
          {
            component: 'Table',
            columns: [{ key: 'name', label: 'Worker' }],
            rows: [{ name: 'w1', conversationId: 42 }],
            rowActions: [
              {
                label: 'Inspect Row',
                action: {
                  type: 'helmx:send',
                  target: 'conversation:{$row.conversationId}',
                  text: 'ping {$row.name}',
                },
              },
            ],
          },
          {
            component: 'TextInput',
            label: 'Note',
            value: 'hello',
            action: {
              type: 'helmx:action',
              actionId: 'save_note',
              input: { note: '{$value}' },
            },
          },
        ],
      },
    ],
  })
  assert.ok(tabsSpec.root !== null)
  const tabCtx = makeCtx(
    { $docs: { status: { total: 7 } }, $data: {} },
    (rawAction, actionScope) => {
      dispatched.push({ rawAction, scope: actionScope })
    },
  )
  React.act(() => {
    root.render(React.createElement(SpecNodeList, { nodes: [tabsSpec.root!], ctx: tabCtx }))
  })
  assert.match(container.textContent ?? '', /plain overview/)

  // 切换到第 2 个 Tab（child 0 从 Text 变为 KeyValueList + Table + TextInput）
  const triggers = [...container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[]
  assert.equal(triggers.length, 2)
  React.act(() => {
    triggers[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    triggers[1]!.click()
  })
  assert.match(container.textContent ?? '', /Total/, 'KeyValueList 在 Tab 内正常渲染')
  assert.match(container.textContent ?? '', /7/, 'KeyValueList pointer key 未被 Tabs 提前求值破坏')

  // 点击 Table rowAction：验证 $row 模板保留未提前破坏
  const inspectBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Inspect Row'))
  assert.ok(inspectBtn !== undefined, 'Tab 内 Table rowAction 按钮应渲染')
  React.act(() => {
    inspectBtn.click()
  })
  assert.equal(dispatched.length, 1)
  const resolvedRow = resolveSpecAction(dispatched[0]!.rawAction, dispatched[0]!.scope, 999)
  assert.deepEqual(resolvedRow, { kind: 'send', conversationId: 42, text: 'ping w1' })

  // 点击 TextInput Submit：验证 $value 模板保留未提前破坏
  const submitBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Submit'))
  assert.ok(submitBtn !== undefined, 'Tab 内 TextInput 提交按钮应渲染')
  React.act(() => {
    submitBtn.click()
  })
  assert.equal(dispatched.length, 2)
  const resolvedInput = resolveSpecAction(dispatched[1]!.rawAction, dispatched[1]!.scope, 999)
  assert.deepEqual(resolvedInput, { kind: 'action', actionId: 'save_note', input: { note: 'hello' } })

  // 切回第 1 个 Tab（多 hooks -> 0 hooks）不崩
  React.act(() => {
    triggers[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    triggers[0]!.click()
  })
  assert.match(container.textContent ?? '', /plain overview/)

  // 4) ActionBar 不提前求值 action：缺失绑定 target: '{$data.missing}' 经 resolveSpecAction 显式拒绝而非误发默认会话
  dispatched.length = 0
  const barSpec = normalizeSpec({
    component: 'ActionBar',
    actions: [
      {
        label: 'Send Missing Target',
        action: { type: 'helmx:send', target: '{$data.missingId}', text: 'do not misroute' },
      },
    ],
  })
  assert.ok(barSpec.root !== null)
  React.act(() => {
    root.render(React.createElement(SpecNodeList, { nodes: [barSpec.root!], ctx: tabCtx }))
  })
  const sendBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Send Missing Target'))
  assert.ok(sendBtn !== undefined)
  React.act(() => {
    sendBtn.click()
  })
  assert.equal(dispatched.length, 1)
  const resolvedBar = resolveSpecAction(dispatched[0]!.rawAction, dispatched[0]!.scope, 999)
  assert.equal(resolvedBar.kind, 'invalid', 'ActionBar 不得提前求值把缺失 target 变成 undefined 误回退到默认会话 999')

  // 5) P0 UI fix: useRemoteSyncedState re-syncs when subsequent remote SSE updates arrive after local edits,
  //    while preserving local uncommitted edits across unrelated renders when remote is unchanged;
  //    CheckboxGroup memoizes Set so freshly allocated arrays with equal elements preserve user selection.
  const syncedSpec = normalizeSpec({
    component: 'Stack',
    children: [
      { component: 'TextInput', label: 'Note', value: '{$data.note}' },
      { component: 'Select', label: 'Mode', value: '{$data.mode}', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }] },
      { component: 'CheckboxGroup', label: 'Tags', value: '{$data.tags}', options: [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }, { label: 'Z', value: 'z' }] },
    ],
  })
  assert.ok(syncedSpec.root !== null)
  const renderWithData = (data: Record<string, unknown>) => {
    React.act(() => {
      root.render(React.createElement(SpecNodeList, { nodes: [syncedSpec.root!], ctx: makeCtx({ $data: data }) }))
    })
  }

  renderWithData({ note: 'v1', mode: 'a', tags: ['x'] })
  const inputEl = container.querySelector('input[type="text"]') as HTMLInputElement | null
  assert.ok(inputEl !== null)
  assert.equal(inputEl.value, 'v1')
  const xBox = () => container.querySelectorAll('[role="checkbox"]')[0] as HTMLButtonElement
  const yBox = () => container.querySelectorAll('[role="checkbox"]')[1] as HTMLButtonElement
  assert.equal(xBox().getAttribute('aria-checked'), 'true')
  assert.equal(yBox().getAttribute('aria-checked'), 'false')

  // Simulate user local edits to TextInput and CheckboxGroup
  const setNativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  React.act(() => {
    setNativeInputValue.call(inputEl, 'local-draft')
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
  })
  React.act(() => {
    yBox().click()
  })
  assert.equal(inputEl.value, 'local-draft')
  assert.equal(yBox().getAttribute('aria-checked'), 'true')

  // Unrelated re-render with semantically identical remote data (fresh array instance ['x']):
  // uncommitted local edits MUST NOT be overwritten!
  renderWithData({ note: 'v1', mode: 'a', tags: ['x'], unrelatedTick: 2 })
  assert.equal(inputEl.value, 'local-draft', 'unrelated re-render must preserve uncommitted TextInput draft')
  assert.equal(yBox().getAttribute('aria-checked'), 'true', 'freshly allocated identical tags array must preserve local checkbox edit')

  // Subsequent remote SSE push with changed values: MUST re-sync cleanly instead of sticking on dirty=true!
  renderWithData({ note: 'v2-from-sse', mode: 'b', tags: ['z'] })
  assert.equal(inputEl.value, 'v2-from-sse', 'subsequent SSE remote change must re-sync TextInput after local edit')
  assert.equal(xBox().getAttribute('aria-checked'), 'false', 'subsequent SSE remote change must re-sync CheckboxGroup')
  const zBox = container.querySelectorAll('[role="checkbox"]')[2] as HTMLButtonElement
  assert.equal(zBox.getAttribute('aria-checked'), 'true', 'subsequent SSE remote change must check new remote tag z')
})

// ---------------------------------------------------------------------------
// ScreenHost 路由契约：零业务特判，所有 screen 统一 PluginUiView 渲染
// ---------------------------------------------------------------------------