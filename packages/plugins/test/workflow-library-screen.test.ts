/**
 * builtin:workflow 工作流库 client 测试（真实 esbuild 编译产物）：
 * - 纯逻辑（parsers.ts）：parseSavedWorkflowList / parseWorkflowDetail /
 *   parseWorkflowArgsInput / filterSavedWorkflows / buildWorkflowEditRequest；
 * - DOM 交互（WorkflowLibraryScreen）：卡片网格（原生 button）+ URL q/wf 参数同步、
 *   DetailDrawer 只读源码（零 textarea）、Select 选择目标会话（空会话禁用运行）、
 *   ConfirmDialog 两步确认删除（delete + reload + 清理 wf 参数）、切换条目重置 args 草稿。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScreenProps } from '@helmx/protocol'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowParsers,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })
const p = await importWorkflowParsers()
const mod = await importWorkflowClientModule('library.tsx', undefined, { realHooks: true })
const WorkflowLibraryScreen = mod['WorkflowLibraryScreen'] as (
  props: ScreenProps & { inlineDrawer?: boolean },
) => React.ReactElement

const LIST_RAW = {
  workflows: [
    {
      name: 'release',
      description: '发布流程：检查并发布',
      whenToUse: '发版时',
      updatedAt: 1_700_000_123_456,
      size: 4096,
      phases: [{ title: '检查' }, { title: '发布', detail: '执行发布' }],
      path: '/data/workflows/release.js',
    },
    { name: 'audit', description: '审计流程', updatedAt: 1_700_000_000_000, size: 1024 },
    { name: 'broken', updatedAt: 1, size: 2, metadataError: 'meta.name is required' },
  ],
}

const GET_RESULT = {
  workflow: {
    name: 'release',
    description: '发布流程：检查并发布',
    updatedAt: 1_700_000_123_456,
    size: 4096,
    script: 'export const meta = { name: "release", description: "发布" }\nreturn 1',
  },
}

// ---------------------------------------------------------------------------
// 纯逻辑：列表/详情/参数/筛选/修改请求
// ---------------------------------------------------------------------------

test('parseSavedWorkflowList：updatedAt/size 必需非负安全整数，缺失或非法条目整体拒绝', { timeout: 60_000 }, () => {
  const parsed = p.parseSavedWorkflowList(LIST_RAW)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0]!.updatedAt, 1_700_000_123_456)
  assert.equal(parsed[0]!.size, 4096)
  assert.equal(parsed[2]!.metadataError, 'meta.name is required')

  const without = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const first = { ...(LIST_RAW.workflows[0] as Record<string, unknown>), ...extra }
    delete first[key]
    return { workflows: [first] }
  }
  assert.equal(p.parseSavedWorkflowList(without('updatedAt')), undefined)
  assert.equal(p.parseSavedWorkflowList(without('size')), undefined)
  assert.equal(p.parseSavedWorkflowList(without('updatedAt', { updatedAt: -1 })), undefined)
  assert.equal(p.parseSavedWorkflowList(without('size', { size: 1.5 })), undefined)
  assert.equal(p.parseSavedWorkflowList({ workflows: [{ name: 'ok', updatedAt: 1, size: 1 }, 42] }), undefined)
})

test('parseWorkflowDetail / filterSavedWorkflows / buildWorkflowEditRequest', { timeout: 60_000 }, () => {
  const detail = p.parseWorkflowDetail(GET_RESULT)
  assert.ok(detail !== undefined)
  assert.equal(detail.name, 'release')
  assert.match(detail.script, /export const meta/)

  const entry = LIST_RAW.workflows[0] as Record<string, unknown>
  assert.equal(p.parseWorkflowDetail({ workflow: entry }), undefined)
  assert.equal(p.parseWorkflowDetail({ workflow: { ...entry, script: '' } }), undefined)
  assert.equal(p.parseWorkflowDetail(undefined), undefined)

  const items = p.parseSavedWorkflowList(LIST_RAW)!
  assert.deepEqual(p.filterSavedWorkflows(items, '发版').map((i) => i.name), ['release'])
  assert.deepEqual(p.filterSavedWorkflows(items, 'audit').map((i) => i.name), ['audit'])

  const en = p.buildWorkflowEditRequest('release', { description: '发布流程' }, 'en')
  assert.match(en, /release/)
  assert.match(en, /`get`/)
  assert.match(en, /`save`/)
  assert.match(en, /Current description: 发布流程/)
  const zh = p.buildWorkflowEditRequest('release', { description: '发布流程' }, 'zh-CN')
  assert.match(zh, /当前描述：发布流程/)
})

// ---------------------------------------------------------------------------
// DOM 交互：WorkflowLibraryScreen（Screen / SearchBox / DetailDrawer / ConfirmDialog）
// ---------------------------------------------------------------------------

function makeScreenProps(initial: Record<string, string> = {}) {
  const params: Record<string, string> = { ...initial }
  const setParamsCalls: Array<Record<string, string | undefined>> = []
  const setParamsRecords: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
  return {
    pluginId: 'builtin:workflow',
    screenId: 'library',
    isSplit: false,
    get params() {
      return { ...params }
    },
    setParams: (patch: Record<string, string | undefined>, options?: { push?: boolean }) => {
      setParamsCalls.push(patch)
      setParamsRecords.push({ patch, options })
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete params[k]
        else params[k] = v
      }
    },
    setParamsCalls,
    setParamsRecords,
  }
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = [...scope.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => (b.textContent ?? '').includes(text))
  assert.ok(found !== undefined, `应存在含「${text}」的按钮（实得：${buttons.map((b) => b.textContent).join(' | ')}）`)
  return found
}

function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  setter?.call(input, value)
  const key = Object.keys(input).find((k) => k.startsWith('__reactProps$'))
  assert.ok(key !== undefined)
  const props = (input as unknown as Record<string, Record<string, unknown>>)[key]!
  ;(props['onChange'] as (ev: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void)({
    target: input,
    currentTarget: input,
  })
}

test('工作流库 Screen：List + ListRow 渲染元数据诊断；点击回写 wf；深链 q 恢复搜索', { timeout: 60_000 }, async () => {
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [],
    locale: 'en',
    onAction: (_plugin, actionId) => (actionId === 'list' ? LIST_RAW : undefined),
  })
  const props = makeScreenProps()
  const ui = h.mountNode(e(WorkflowLibraryScreen, props))
  try {
    await act(async () => {})
    const rows = [...ui.container.querySelectorAll('.helmx-list-row[data-workflow-name]')] as HTMLElement[]
    const triggers = [...ui.container.querySelectorAll('button.helmx-list-row-trigger')] as HTMLButtonElement[]
    assert.equal(rows.length, 3, '所有条目复用 ListRow 容器')
    assert.equal(triggers.length, 3, '每行具备独立原生 button 主触发器')
    assert.ok(ui.container.querySelector('.screen-toolbar-bar .search-box-toolbar.search-box-sm') !== null, '使用统一 28px 工具栏搜索框')
    assert.match(ui.container.textContent!, /Workflow Library/)
    assert.match(ui.container.textContent!, /发布流程/)
    assert.match(ui.container.textContent!, /Metadata error: meta\.name is required/)
    assert.ok(document.body.querySelector('.wf-lib-drawer') === null)

    await act(async () => { triggers[0]!.click() })
    assert.deepEqual(props.setParamsCalls.filter((x) => 'wf' in x), [{ wf: 'release' }])
    assert.deepEqual(
      props.setParamsRecords.filter((r) => 'wf' in r.patch),
      [{ patch: { wf: 'release' }, options: { push: true } }],
      '从列表点选工作流必须传 { push: true }，使移动端后退可关抽屉',
    )

    // 悬空失效 wf 参数（列表已加载但无该条目）：再点真实条目仍应走 push
    const staleProps = makeScreenProps({ wf: 'deleted-wf' })
    ui.rerender(e(WorkflowLibraryScreen, staleProps))
    await act(async () => {})
    const staleTriggers = [...ui.container.querySelectorAll('button.helmx-list-row-trigger')] as HTMLButtonElement[]
    await act(async () => { staleTriggers[0]!.click() })
    assert.deepEqual(
      staleProps.setParamsRecords.at(-1),
      { patch: { wf: 'release' }, options: { push: true } },
    )

    // 深链 q 参数恢复搜索框并过滤列表行
    const qProps = makeScreenProps({ q: 'audit' })
    ui.rerender(e(WorkflowLibraryScreen, qProps))
    await act(async () => {})
    const search = ui.container.querySelector('input[aria-label="Search workflow library"]') as HTMLInputElement | null
    assert.ok(search !== null)
    assert.equal(search.value, 'audit')
    assert.equal(ui.container.querySelectorAll('.helmx-list-row[data-workflow-name]').length, 1)
  } finally {
    ui.unmount()
  }
})

test('详情抽屉：只读源码无编辑输入、空会话禁用运行、切换条目清空 args 草稿、ConfirmDialog 两步确认删除', { timeout: 60_000 }, async () => {
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [],
    locale: 'en',
    onAction: (_plugin, actionId) => {
      if (actionId === 'list') return LIST_RAW
      if (actionId === 'get') return GET_RESULT
      if (actionId === 'delete') return { deleted: true, name: 'release', path: '/data/workflows/release.js' }
      return undefined
    },
  })
  const props = makeScreenProps({ wf: 'release' })
  const ui = h.mountNode(e(WorkflowLibraryScreen, { ...props, inlineDrawer: true }))
  try {
    await act(async () => {})
    await act(async () => {})
    const drawer = ui.container.querySelector('.wf-lib-drawer') as HTMLElement | null
    assert.ok(drawer !== null, 'wf 深链直开详情抽屉')
    assert.deepEqual(h.log.actions.find((c) => c.actionId === 'get')?.input, { name: 'release' })
    assert.match(drawer.textContent!, /export const meta = \{ name: "release"/)
    assert.equal(drawer.querySelectorAll('textarea').length, 0, '抽屉不得提供源码编辑器')

    const runBtn = [...drawer.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Run')
    assert.ok(runBtn !== undefined)
    assert.equal(runBtn.disabled, true, '无可用顶层会话时禁用 Run 按钮')

    // 写入非法 args 草稿，再切换 wf 到 audit，验证草稿重置
    const argsInput = drawer.querySelector('.wf-lib-args') as HTMLInputElement
    assert.ok(argsInput !== null)
    await act(async () => { setControlledValue(argsInput, '{oops}') })
    assert.equal(argsInput.value, '{oops}')

    const auditProps = makeScreenProps({ wf: 'audit' })
    ui.rerender(e(WorkflowLibraryScreen, { ...auditProps, inlineDrawer: true }))
    await act(async () => {})
    const auditArgs = ui.container.querySelector('.wf-lib-drawer .wf-lib-args') as HTMLInputElement
    assert.equal(auditArgs.value, '', '切换工作流后 args 草稿清空不串行')

    // 切回 release 并走 ConfirmDialog 两步删除
    ui.rerender(e(WorkflowLibraryScreen, { ...props, inlineDrawer: true }))
    await act(async () => {})
    const drawer2 = ui.container.querySelector('.wf-lib-drawer')!
    await act(async () => { buttonByText(drawer2, 'Delete').click() })
    assert.equal(h.log.actions.filter((c) => c.actionId === 'delete').length, 0, '第一步仅打开确认框不删除')
    assert.match(ui.container.textContent!, /Delete saved workflow "release"\?/)

    // 点击确认对话框中的确认删除按钮
    const confirmDialog = ui.container.querySelector('[role="alertdialog"], .confirm-dialog, .helmx-dialog') ?? ui.container
    const deleteBtns = [...confirmDialog.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === 'Delete')
    await act(async () => { deleteBtns.at(-1)!.click() })
    await act(async () => {})
    assert.deepEqual(h.log.actions.find((c) => c.actionId === 'delete')?.input, { name: 'release' })
    assert.ok(h.log.notices.some((n) => n.message.includes('Deleted workflow release')))
    assert.ok(h.log.actions.filter((c) => c.actionId === 'list').length >= 2, '删除后重新加载列表')
    assert.ok(props.setParamsCalls.some((p) => p['wf'] === undefined), '删除后清理 wf 深链参数')
    assert.deepEqual(
      props.setParamsRecords.filter((r) => r.patch['wf'] === undefined).at(-1),
      { patch: { wf: undefined }, options: undefined },
      '关闭/删除清理抽屉参数走 replace 而非 push',
    )
  } finally {
    ui.unmount()
  }
})

test('buildWorkflowRunTargetOptions：仅列顶层会话按 updatedAt 降序', { timeout: 60_000 }, () => {
  const opts = p.buildWorkflowRunTargetOptions([
    makeConvSummary(1, { title: '旧会话', updatedAt: 10 }),
    makeConvSummary(2, { title: '子会话', parentConversationId: 1, updatedAt: 99 }),
    makeConvSummary(3, { title: '新会话', updatedAt: 50 }),
  ])
  assert.deepEqual(opts.map((o) => o.value), ['3', '1'])
})
