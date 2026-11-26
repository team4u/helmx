/**
 * 后台结算汇报折叠展示测试（builtin:workflow 真实 client 编译产物 + @helmx/plugin-client）：
 * 1. 纯解析 parsers.ts：直读 meta.report（保留 string/JSON/null/false/0/空串、failed/aborted、
 *    execution.conversationId、otherRunningTasks）；缺失/损坏返回 invalid 且保留原文，绝不刮文本；
 * 2. BackgroundReportCard DOM：完成态默认收起，失败/中止/损坏默认展开；复制原文实写剪贴板、
 *    子会话导航不触发折叠、使用 KvGrid / Callout 宿主原语、损坏显式标注且不伪造成功。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { ConversationEntry, TimelineRendererProps } from '@helmx/protocol'
import {
  React,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowParsers,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces({ realHooks: true })

let parsers: Awaited<ReturnType<typeof importWorkflowParsers>>
let BackgroundReportCard: (props: TimelineRendererProps) => React.ReactElement

before(async () => {
  parsers = await importWorkflowParsers()
  const client = await importWorkflowClientModule('index.tsx', undefined, { realHooks: true })
  BackgroundReportCard = client['BackgroundReportCard'] as typeof BackgroundReportCard
}, { timeout: 60_000 })

interface ReportOverrides {
  kind?: 'subagent_report' | 'workflow_report'
  runId?: string
  report?: Record<string, unknown>
  omitReport?: boolean
  meta?: Record<string, unknown>
  text?: string
}

function makeReportEntry(overrides: ReportOverrides = {}, entryId = '51'): ConversationEntry {
  const runId = overrides.runId ?? 'wf_abc123'
  const kind = overrides.kind ?? 'subagent_report'
  const report = {
    runId,
    status: 'completed',
    otherRunningTasks: [],
    ...overrides.report,
  }
  return {
    id: entryId,
    kind: 'helmx.input',
    data: {
      id: `helmx:subagent-report:${runId}`,
      text:
        overrides.text ??
        `后台子代理任务已结算。以下为运行 ${runId} 的结果数据：\n${JSON.stringify(report)}`,
      origin: 'agent',
      createdAt: 100,
      meta: {
        backgroundRunId: runId,
        kind,
        renderer: 'workflow:background-report',
        ...(overrides.omitReport === true ? {} : { report }),
        ...overrides.meta,
      },
    },
  }
}

function clickToggle(host: HTMLElement): void {
  const btn = host.querySelector<HTMLButtonElement>('button.wf-trace-toggle')
  assert.ok(btn !== null, '应存在折叠开关按钮 .wf-trace-toggle')
  act(() => btn.click())
}

async function withCapturedClipboard(run: (captured: string[]) => Promise<void>): Promise<void> {
  const captured: string[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text: string) => { captured.push(text) } } },
    configurable: true,
    writable: true,
  })
  try {
    await run(captured)
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original)
  }
}

// ---------------------------------------------------------------------------
// 1. 纯解析：meta.report 直读、result 语义、终态与损坏输入
// ---------------------------------------------------------------------------

test('parse: string 与 JSON result 均保留（null/false/0/空串不丢），直读 meta.report 不刮文本', { timeout: 60_000 }, () => {
  const cases: Array<{ result: unknown; expect: unknown }> = [
    { result: '纯文本结论', expect: '纯文本结论' },
    { result: { done: true, n: 2 }, expect: { done: true, n: 2 } },
    { result: null, expect: null },
    { result: false, expect: false },
    { result: 0, expect: 0 },
    { result: '', expect: '' },
  ]
  for (const c of cases) {
    const view = parsers.parseBackgroundReportEntry(
      makeReportEntry({ text: '纯人类可读说明，无任何 JSON 尾行', report: { result: c.result, status: 'completed' } }),
    )
    assert.equal(view.invalid, false, `result=${JSON.stringify(c.result)} 应从 meta.report 直接解析成功`)
    if (!view.invalid) {
      assert.equal(view.hasResult, true)
      assert.deepEqual(view.result, c.expect)
      assert.equal(view.rawText, '纯人类可读说明，无任何 JSON 尾行')
    }
  }
  const none = parsers.parseBackgroundReportEntry(makeReportEntry({ report: {} }))
  assert.equal(none.invalid, false)
  if (!none.invalid) assert.equal(none.hasResult, false)
})

test('parse: failed/aborted 终态、error、execution、otherRunningTasks、meta 一致性', { timeout: 60_000 }, () => {
  const failed = parsers.parseBackgroundReportEntry(
    makeReportEntry({
      kind: 'workflow_report',
      report: {
        status: 'failed',
        error: 'gate 校验未通过',
        otherRunningTasks: [{ runId: 'wf_x', name: '并行任务', kind: 'workflow' }],
      },
    }),
  )
  assert.equal(failed.invalid, false)
  if (!failed.invalid) {
    assert.equal(failed.kind, 'workflow_report')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'gate 校验未通过')
    assert.equal(failed.executionConversationId, undefined)
    assert.deepEqual(failed.otherRunningTasks, [{ runId: 'wf_x', name: '并行任务', kind: 'workflow' }])
  }

  const aborted = parsers.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'aborted', error: '被中止' } }))
  assert.equal(aborted.invalid, false)
  if (!aborted.invalid) assert.equal(aborted.status, 'aborted')

  const withExec = parsers.parseBackgroundReportEntry(
    makeReportEntry({ report: { status: 'completed', execution: { conversationId: 7, executionId: 9 } } }),
  )
  assert.equal(withExec.invalid, false)
  if (!withExec.invalid) assert.equal(withExec.executionConversationId, 7)

  assert.equal(parsers.parseBackgroundReportEntry(makeReportEntry({ report: { runId: 'wf_other' } })).invalid, true)
  assert.equal(parsers.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'running' } })).invalid, true)
  assert.equal(
    parsers.parseBackgroundReportEntry(makeReportEntry({ report: { execution: { conversationId: 0 } } })).invalid,
    true,
  )
  assert.equal(
    parsers.parseBackgroundReportEntry(makeReportEntry({ report: { otherRunningTasks: [{ runId: 'wf_x' }] } })).invalid,
    true,
  )
})

test('parse: 缺失或损坏 meta.report / meta.kind 返回 invalid 且保留原文（不回退正文 JSON 刮取）', { timeout: 60_000 }, () => {
  const missingReport = parsers.parseBackgroundReportEntry(makeReportEntry({ omitReport: true }))
  assert.equal(missingReport.invalid, true)
  if (missingReport.invalid) assert.ok(missingReport.rawText.includes('wf_abc123'))

  const nonObjectReport = parsers.parseBackgroundReportEntry(
    makeReportEntry({ meta: { report: 'not-an-object' }, text: '损坏汇报原文' }),
  )
  assert.equal(nonObjectReport.invalid, true)
  if (nonObjectReport.invalid) assert.equal(nonObjectReport.rawText, '损坏汇报原文')

  assert.equal(parsers.parseBackgroundReportEntry(makeReportEntry({ meta: { kind: 'other' } })).invalid, true)
})

test('preview: 完成看结果首行；失败优先错误且截断', { timeout: 60_000 }, () => {
  const done = parsers.parseBackgroundReportEntry(makeReportEntry({ report: { result: 'abcdefgh\nsecond' } }))
  if (!done.invalid) {
    assert.equal(parsers.backgroundReportPreview(done, 120), 'abcdefgh')
    assert.equal(parsers.backgroundReportPreview(done, 5), 'abcd…')
  }
  const failed = parsers.parseBackgroundReportEntry(makeReportEntry({ report: { status: 'failed', error: 'boom' } }))
  if (!failed.invalid) assert.equal(parsers.backgroundReportPreview(failed, 120), 'boom')
})

// ---------------------------------------------------------------------------
// 2. BackgroundReportCard DOM：默认收起 / 展开 / 复制 / 导航 / 损坏
// ---------------------------------------------------------------------------

test('card: 默认收起单行回执，展开挂载 KvGrid 与正文并保持焦点与唯一 ID', { timeout: 60_000 }, async () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const ui = h.mountNode(e(BackgroundReportCard, { entry, conversationId: 1 }))
  try {
    const row = ui.container.querySelector('.trace-row')
    assert.ok(row !== null, '渲染 .trace-row 单行回执')
    assert.equal(row.classList.contains('trace-row-error'), false)
    assert.equal(row.querySelector('.trace-tool-name')?.textContent, 'Subagent Report')
    assert.equal(row.querySelector('.trace-tool-summary')?.textContent, '首行结论')
    assert.equal(row.textContent?.includes('wf_abc123'), false, '收起态不常驻 runId')

    const toggle = ui.container.querySelector<HTMLButtonElement>('button.wf-trace-toggle')
    assert.ok(toggle !== null)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    const bodyId = toggle.getAttribute('aria-controls')!
    assert.ok(document.getElementById(bodyId) !== null, '收起时 aria-controls 指向真实区域')

    const duplicate = h.mountNode(e(BackgroundReportCard, { entry, conversationId: 1 }))
    const dupId = duplicate.container.querySelector('button[aria-controls]')!.getAttribute('aria-controls')
    assert.notEqual(dupId, bodyId, '分屏同时渲染同一汇报时控件 ID 不重复')
    duplicate.unmount()

    assert.ok(ui.container.querySelector('.wf-report-expanded') === null)
    await act(async () => { toggle.focus() })
    clickToggle(ui.container)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    const expanded = ui.container.querySelector('.wf-report-expanded')
    assert.ok(expanded !== null)
    assert.ok(expanded.textContent?.includes('wf_abc123'))
    assert.ok(expanded.textContent?.includes('详细正文第二段'))
    assert.ok(document.activeElement === toggle, '展开保留焦点')

    clickToggle(ui.container)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.ok(ui.container.querySelector('.wf-report-expanded') === null)
  } finally {
    ui.unmount()
  }
})

test('card: 复制原文实写剪贴板且不触发折叠开关', { timeout: 60_000 }, async () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const entry = makeReportEntry({ report: { result: '首行结论\n\n详细正文第二段' } })
  const ui = h.mountNode(e(BackgroundReportCard, { entry, conversationId: 1 }))
  try {
    await withCapturedClipboard(async (captured) => {
      const btn = ui.container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')
      assert.ok(btn !== null)
      await act(async () => { btn.click() })
      assert.equal(captured.length, 1)
      assert.equal(captured[0], (entry.data as { text: string }).text)
    })
    assert.equal(ui.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'false')
  } finally {
    ui.unmount()
  }
})

test('card: JSON result 缩进代码块；失败/中止默认展开；工作流标题与在途快照', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const jsonUi = h.mountNode(e(BackgroundReportCard, { entry: makeReportEntry({ kind: 'workflow_report', report: { result: { done: true } } }), conversationId: 1 }))
  try {
    assert.match(jsonUi.container.textContent ?? '', /Workflow Report/)
    clickToggle(jsonUi.container)
    const code = jsonUi.container.querySelector('.wf-report-expanded pre code')
    assert.ok(code !== null)
    assert.match(code.textContent ?? '', /"done": true/)
  } finally {
    jsonUi.unmount()
  }

  const failUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({ kind: 'workflow_report', report: { status: 'failed', error: '工具执行失败：退出码 1' } }),
      conversationId: 1,
    }),
  )
  try {
    assert.ok(failUi.container.querySelector('.trace-row.trace-row-error') !== null)
    assert.equal(failUi.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'true')
    assert.match(failUi.container.querySelector('.wf-report-expanded')?.textContent ?? '', /工具执行失败：退出码 1/)
    clickToggle(failUi.container)
    assert.equal(failUi.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'false')
  } finally {
    failUi.unmount()
  }

  const snapUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({
        report: { status: 'completed', result: 'ok', otherRunningTasks: [{ runId: 'wf_x', name: '并行任务', kind: 'subagent' }] },
      }),
      conversationId: 1,
    }),
  )
  try {
    clickToggle(snapUi.container)
    const chip = snapUi.container.querySelector('.wf-report-tasks .wf-report-task-item')
    assert.ok(chip !== null)
    assert.match(chip.textContent ?? '', /并行任务/)
    assert.match(chip.textContent ?? '', /wf_x/)
  } finally {
    snapUi.unmount()
  }
})

test('card: execution.conversationId 才给子会话入口（不触发折叠）；支持具名任务', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const plainUi = h.mountNode(e(BackgroundReportCard, { entry: makeReportEntry({ report: { result: 'ok' } }), conversationId: 1 }))
  try {
    assert.ok(plainUi.container.querySelector('button[aria-label*="conversation #"]') === null)
  } finally {
    plainUi.unmount()
  }

  const convUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({ report: { result: 'ok', execution: { conversationId: 7 } } }),
      conversationId: 1,
    }),
  )
  try {
    assert.equal(convUi.container.querySelector('.trace-tool-name')?.textContent, 'Subagent Report #7')
    const nav = convUi.container.querySelector<HTMLButtonElement>('button[aria-label="Open subagent conversation #7"]')
    assert.ok(nav !== null)
    act(() => nav.click())
    assert.deepEqual(h.log.drawers, [7])
    assert.equal(convUi.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'false')
  } finally {
    convUi.unmount()
  }

  const namedUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({ report: { name: '修复登录超时', result: 'ok', execution: { conversationId: 7 } } }),
      conversationId: 1,
    }),
  )
  try {
    assert.equal(namedUi.container.querySelector('.trace-tool-name')?.textContent, 'Subagent Report · 修复登录超时')
    assert.equal(namedUi.container.querySelector('.wf-trace-id')?.textContent, '#7')
    clickToggle(namedUi.container)
    const expanded = namedUi.container.querySelector('.wf-report-expanded')!
    const subBtn = [...expanded.querySelectorAll('button')].find((b) => b.textContent?.includes('修复登录超时 (#7)'))
    assert.ok(subBtn !== undefined)
    act(() => subBtn.click())
    assert.deepEqual(h.log.drawers, [7, 7])
  } finally {
    namedUi.unmount()
  }
})

test('card: 损坏数据显式标注并默认展开保留原文，不伪造完成态', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const ui = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({
        text: '引导语\n{坏 JSON',
        omitReport: true,
        meta: { backgroundRunId: 'wf_bad', kind: 'subagent_report' },
      }),
      conversationId: 1,
    }),
  )
  try {
    assert.ok(ui.container.querySelector('.trace-row.trace-row-error') !== null)
    assert.match(ui.container.textContent ?? '', /Invalid Background Report/)
    assert.equal(ui.container.textContent?.includes('Completed'), false)
    assert.equal(ui.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'true')
    assert.match(ui.container.querySelector('.wf-report-expanded')?.textContent ?? '', /\{坏 JSON/)
    clickToggle(ui.container)
    assert.equal(ui.container.querySelector('button.wf-trace-toggle')?.getAttribute('aria-expanded'), 'false')
  } finally {
    ui.unmount()
  }
})

test('card: 字符串汇报通过 MarkdownView 渲染（含块级 Markdown 语义），subagent_report 优先传 executionConversationId，workflow_report 回退宿主 conversationId', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1, locale: 'en' })
  const subUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({
        kind: 'subagent_report',
        report: {
          status: 'completed',
          result: '# 结论标题\n\n- **关键结论** 与 `inline`，详见 [conversations.ts:137](/wt/conversations.ts:137)',
          execution: { conversationId: 77 },
        },
      }),
      conversationId: 1,
    }),
  )
  try {
    clickToggle(subUi.container)
    const mdEl = subUi.container.querySelector<HTMLElement>('.wf-report-expanded [data-testid="markdown-view"].msg-ai-body')
    assert.ok(mdEl !== null, 'subagent_report 应通过宿主 MarkdownView (.msg-ai-body) 渲染')
    assert.equal(mdEl.getAttribute('data-conversation-id'), '77', 'subagent_report 应传入 execution.conversationId')
    assert.ok(mdEl.classList.contains('wf-result-markdown'))
    assert.equal(mdEl.querySelector('h1')?.textContent, '结论标题')
    assert.equal(mdEl.querySelector('li strong')?.textContent, '关键结论')
    assert.equal(mdEl.querySelector('li code')?.textContent, 'inline')
    assert.ok(subUi.container.querySelector('.wf-report-expanded pre.code-block-pre') === null)
  } finally {
    subUi.unmount()
  }

  const wfUi = h.mountNode(
    e(BackgroundReportCard, {
      entry: makeReportEntry({
        kind: 'workflow_report',
        report: {
          status: 'completed',
          result: '汇总见 [validate.ts:349](/wt/validate.ts:349)',
        },
      }),
      conversationId: 19,
    }),
  )
  try {
    clickToggle(wfUi.container)
    const mdEl = wfUi.container.querySelector<HTMLElement>('.wf-report-expanded [data-testid="markdown-view"].msg-ai-body')
    assert.ok(mdEl !== null, 'workflow_report 应通过 MarkdownView 渲染')
    assert.equal(mdEl.getAttribute('data-conversation-id'), '19', 'workflow_report 无子会话时应回退卡片所属 conversationId')
    assert.ok(mdEl.classList.contains('wf-result-markdown'))
  } finally {
    wfUi.unmount()
  }
})
