/**
 * 宿主内置工具展开体交互测试（happy-dom）：
 * 1. edit：running 待执行片段（无文件行号）→ done 已应用差异（真实行号），
 *    failure 错误 + 请求片段（不判定磁盘副作用），非法/缺失元数据显式
 *    诊断并默认展开原始数据；词级加深；服务端截断提示与折叠展开；大输入
 *    超预算提示并保留原始参数入口；
 * 2. write：源码预览前 12 行 / 共 N 行 / 展开全部 / 复制完整源码；
 * 3. read：spill 不做源码高亮且保留产物入口；普通结果按路径语言高亮；
 * 4. bash：命令复制头、输出默认尾 8 行、已折叠前 N 行与展开全部、退出码；
 * 5. 通用工具：键值展示 + 原始数据展开保留完整 JSON 入参与原始输出；
 * 6. TraceRow：无插件接管可点击展开内置体；tool.view inline 保留原始数据
 *    入口，插件视图不被内置体替换；单行统计 +N −N / N 行；运行中行
 *    右侧仅实时耗时秒表（startedAt 锚点，无锚点留空不编造）；摘要完整渲染
 *    命令首行、不按字符数截断（宽度裁剪交给 CSS 省略）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { ensureHappyDom, waitForCondition } from './helpers/dom-harness.js'
import { resetServerClock } from '../src/lib/server-clock.js'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { makeTestStore } from './helpers/store.js'
import { readHostStyles } from './helpers/host-styles.js'
import type { ConversationEntry, ConversationLive } from '@helmx/protocol'
import type { FoldableStep, ToolTrace } from '../src/conversation/timeline-model.js'

const e = React.createElement

ensureHappyDom()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { useTimelineToolCalls } = await import('@helmx/plugin-client')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { ToolExpandedBody } = await import('../src/conversation/ToolExpandedBody.js')
const { TraceRow, StepGroup } = await import('../src/conversation/TimelineRows.js')

// ---------------------------------------------------------------------------
// 挂载工具
// ---------------------------------------------------------------------------

interface Mount {
  host: HTMLElement
  render: (element: React.ReactElement) => Promise<void>
  unmount: () => void
}

function createMount(): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  return {
    host: container,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root?.render(element)
      })
    },
    unmount: () => {
      act(() => {
        root?.unmount()
        root = null
        container.remove()
      })
    },
  }
}

const store = makeTestStore()
const modalCalls: Array<{ kind: string; artifactId?: string }> = []
;(store.actions as unknown as { setActiveModal: (modal: { kind: string; artifactId?: string }) => void }).setActiveModal = (modal) => {
  modalCalls.push({ kind: modal.kind, artifactId: modal.artifactId })
}

function bodyUi(tool: ToolTrace): React.ReactElement {
  return e(HostStoreProviders, { value: store }, e(ToolExpandedBody, { tool, conversationId: 1 }))
}

function rowUi(tool: ToolTrace, defaultOpen = false): React.ReactElement {
  return e(
    HostStoreProviders,
    { value: store },
    e(TraceRow, { tool, conversationId: 1, defaultOpen }),
  )
}

function stepGroupUi(steps: FoldableStep[], active = false): React.ReactElement {
  return e(
    HostStoreProviders,
    { value: store },
    e(StepGroup, { steps, active, conversationId: 1 }),
  )
}

function trace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { key: 't1', toolName: 'bash', status: 'done', isError: false, ...overrides }
}

function validEditMeta(rows: unknown[] = [], truncated = false): Record<string, unknown> {
  return {
    path: '/abs/x.ts',
    nodeId: 'local',
    replaced: true,
    diff: {
      rows,
      addedLines: rows.filter((r) => (r as { kind?: string }).kind === 'add').length,
      removedLines: rows.filter((r) => (r as { kind?: string }).kind === 'remove').length,
      firstChangedLine: 1,
      truncated,
    },
  }
}

/** 统计 pre 里的可见行数（SyntaxCode 高亮前后 textContent 行数一致）。 */
function preLineCount(host: HTMLElement, selector: string): number {
  const pre = host.querySelector(selector)
  return pre?.textContent?.split('\n').length ?? 0
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

test('edit running：显示Pending change hunks，不带文件行号', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'running',
          input: { path: '/a.ts', oldText: 'const a = 1\nrest', newText: 'const a = 2\nrest' },
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /Pending change hunks/)
    assert.equal(m.host.querySelectorAll('.trace-diff-num').length, 0, '待执行片段不得伪造文件行号')
    assert.ok(m.host.querySelector('.trace-diff-pending'), '使用片段差异形态')
    assert.ok(m.host.textContent?.includes('−'), '存在删除行符号')
    assert.ok(m.host.textContent?.includes('+'), '存在新增行符号')
  } finally {
    m.unmount()
  }
})

test('edit pending → success：完成且元数据合法后切换为内核真实差异（真实行号）', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const input = { path: '/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }
    await m.render(bodyUi(trace({ toolName: 'edit', status: 'running', input })))
    assert.match(m.host.textContent ?? '', /Pending change hunks/)

    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'done',
          input,
          presentationMeta: validEditMeta([
            { kind: 'context', oldLine: 9, newLine: 9, text: 'function f() {' },
            { kind: 'remove', oldLine: 10, text: '  const a = 1' },
            { kind: 'add', newLine: 10, text: '  const a = 2' },
            { kind: 'context', oldLine: 11, newLine: 11, text: '}' },
          ]),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /Applied diff/)
    assert.match(m.host.textContent ?? '', /\/abs\/x\.ts/)
    const nums = [...m.host.querySelectorAll('.trace-diff-num')].map((n) => n.textContent)
    assert.ok(nums.includes('10'), '显示真实文件行号 10')
    assert.ok(m.host.querySelector('.trace-diff-row-remove'))
    assert.ok(m.host.querySelector('.trace-diff-row-add'))
    assert.ok(m.host.querySelector('.trace-diff-row-context'))
    assert.ok(m.host.querySelector('.trace-diff-pending') === null, '不再显示片段形态')
  } finally {
    m.unmount()
  }
})

test('edit failure：错误与请求的变更片段（执行失败不判定文件已变），绝不显示已应用差异', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'error',
          isError: true,
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          resultText: 'edit_failed: oldText 在 /a.ts 中出现 2 次（需唯一匹配）',
          presentationMeta: validEditMeta([{ kind: 'add', newLine: 1, text: '伪造' }]),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /edit_failed: oldText 在 \/a\.ts 中出现 2 次/)
    assert.match(m.host.textContent ?? '', /Requested change hunks \(execution failed; file state undetermined\)/)
    assert.doesNotMatch(m.host.textContent ?? '', /Applied diff/)
    assert.ok(m.host.querySelector('.trace-diff-num') === null, '失败态无文件行号')
    assert.ok(m.host.textContent?.includes('/a.ts'), '失败保留目标路径')
  } finally {
    m.unmount()
  }
})

test('edit 成功但元数据缺失/非法：显式诊断并默认展开原始数据，不伪造差异', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          presentationMeta: { path: '/a.ts', nodeId: 'local', replaced: true },
          resultText: 'edit_ok: /a.ts（节点 local）',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /missing or invalid/)
    assert.ok(m.host.querySelector('.trace-diff') === null, '不渲染任何差异表')
    const rawBtn = m.host.querySelector('.trace-raw .btn-inline') as HTMLElement
    assert.ok(rawBtn)
    assert.equal(rawBtn.getAttribute('aria-expanded'), 'true', '原始数据默认展开')
    assert.match(m.host.textContent ?? '', /"oldText": "x"/)
    assert.match(m.host.textContent ?? '', /edit_ok: \/a\.ts/)
  } finally {
    m.unmount()
  }
})

test('edit unknown：与 running/done/error 区分，不虚构执行状态', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(trace({ toolName: 'edit', status: 'unknown', input: { path: '/a.ts', oldText: 'x', newText: 'y' } })),
    )
    assert.match(m.host.textContent ?? '', /Result unknown/)
    assert.doesNotMatch(m.host.textContent ?? '', /Pending change hunks/)
    assert.doesNotMatch(m.host.textContent ?? '', /Applied diff/)
  } finally {
    m.unmount()
  }
})

test('edit 已应用差异：单删单增行对词级加深', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          presentationMeta: validEditMeta([
            { kind: 'remove', oldLine: 10, text: '  const a = 1' },
            { kind: 'add', newLine: 10, text: '  const a = 2' },
          ]),
        }),
      ),
    )
    assert.ok(m.host.querySelector('.trace-diff-word-remove'), 'remove 行词级加深')
    assert.ok(m.host.querySelector('.trace-diff-word-add'), 'add 行词级加深')
    const wordAdd = m.host.querySelector('.trace-diff-content .trace-diff-word-add')?.textContent
    assert.ok(wordAdd?.includes('2'), '加深的是变化词')
    assert.equal(m.host.querySelector('.trace-diff-row-remove .trace-diff-content')?.textContent, '−  const a = 1')
    assert.equal(m.host.querySelector('.trace-diff-row-add .trace-diff-content')?.textContent, '+  const a = 2')
  } finally {
    m.unmount()
  }
})

test('edit 服务端截断：如实提示不可取回；长差异折叠后可展开全部已传行', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const rows = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? { kind: 'remove' as const, oldLine: i + 1, text: `old ${i}` }
        : { kind: 'add' as const, newLine: i, text: `new ${i}` },
    )
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          presentationMeta: validEditMeta(rows, true),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /cannot be recovered by expanding/, '服务端截断如实提示')
    assert.equal(m.host.querySelectorAll('.trace-diff-row').length, 32, '默认折叠到 32 行')
    const foldBtn = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Expand remaining')) as HTMLButtonElement
    assert.ok(foldBtn)
    await act(async () => {
      foldBtn.click()
    })
    assert.equal(m.host.querySelectorAll('.trace-diff-row').length, 40, '展开后显示全部已传输行')
    const collapse = m.host.querySelector('.trace-diff-more') as HTMLButtonElement
    assert.match(collapse.textContent ?? '', /Collapse/)
    await act(async () => { collapse.click() })
    assert.equal(m.host.querySelectorAll('.trace-diff-row').length, 32, '展开后仍可收起')
  } finally {
    m.unmount()
  }
})

test('edit 大输入超预算：明确提示跳过差异计算，保留原始参数入口', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const huge = 'x'.repeat(70_000)
    await m.render(
      bodyUi(trace({ toolName: 'edit', status: 'running', input: { path: '/big.txt', oldText: huge, newText: 'y' } })),
    )
    assert.match(m.host.textContent ?? '', /Hunk diff not computed/)
    assert.ok(m.host.querySelector('.trace-diff') === null)
    const rawBtn = m.host.querySelector('.trace-raw .btn-inline') as HTMLElement
    assert.ok(rawBtn)
    await act(async () => {
      rawBtn.click()
    })
    assert.match(m.host.textContent ?? '', /"oldText"/, '原始参数完整保留')
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// write / read / bash
// ---------------------------------------------------------------------------

test('write：默认前 12 行 + 共 N 行 + 展开全部 + 复制完整源码', { timeout: 60_000 }, async () => {
  let clipboardText = ''
  const origClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => {
      clipboardText = text
    } },
  })
  const m = createMount()
  try {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    await m.render(
      bodyUi(trace({ toolName: 'write', status: 'running', input: { path: '/s/a.ts', content } })),
    )
    assert.match(m.host.textContent ?? '', /Pending write/)
    assert.equal(preLineCount(m.host, '.trace-code-sec pre'), 12, '默认前 12 行')
    const expand = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Expand all')) as HTMLButtonElement
    assert.ok(expand)
    assert.match(expand.textContent ?? '', /Expand all \(20 lines\)/)
    await act(async () => {
      expand.click()
    })
    assert.equal(preLineCount(m.host, '.trace-code-sec pre'), 20, '展开后完整 20 行')
    const copy = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy source')) as HTMLButtonElement
    assert.ok(copy)
    await act(async () => {
      copy.click()
    })
    assert.equal(clipboardText, content, '复制的是完整源码')
  } finally {
    m.unmount()
    if (origClipboardDesc !== undefined) {
      Object.defineProperty(globalThis.navigator, 'clipboard', origClipboardDesc)
    } else {
      delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard
    }
  }
})

test('write：失败显示执行失败与错误详情（不断言未写入）；成功显示写入内容与字节事实', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'write',
          status: 'error',
          isError: true,
          input: { path: '/s/a.ts', content: 'x' },
          resultText: 'write_failed: node_offline: 节点 n1 离线',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /Write content \(execution failed\)/, '失败不标“未写入”（artifact 登记失败时文件可能已写成功）')
    assert.match(m.host.textContent ?? '', /write_failed/)
    assert.match(m.host.textContent ?? '', /\/s\/a\.ts/, '失败保留目标路径')
  } finally {
    m.unmount()
  }
  const m2 = createMount()
  try {
    await m2.render(
      bodyUi(
        trace({
          toolName: 'write',
          input: { path: '/s/a.ts', content: 'x' },
          presentationMeta: { path: '/s/a.ts', nodeId: 'local', bytesWritten: 1024 },
        }),
      ),
    )
    assert.match(m2.host.textContent ?? '', /Write content/)
    assert.match(m2.host.textContent ?? '', /wrote 1\.0 KiB/)
  } finally {
    m2.unmount()
  }
})

test('read：spill 输出不做源码高亮并保留产物入口；普通结果按路径语言高亮', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const spillText = 'head line\n…[输出超长，已截断…]\n[Artifact] id=abc-1 path=x（调用工具 read_artifact 获取全文）'
    await m.render(
      bodyUi(
        trace({
          toolName: 'read',
          input: { path: 'src/big.log' },
          resultText: spillText,
          presentationMeta: { path: '/abs/src/big.log', nodeId: 'local' },
          artifactRef: 'abc-1',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /with artifact references/)
    assert.ok(m.host.querySelector('.trace-code-sec') === null, 'spill 不走语法高亮形态')
    const artifactBtn = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Open full artifact')) as HTMLButtonElement
    assert.ok(artifactBtn, '保留打开完整产物入口')
    modalCalls.length = 0
    await act(async () => {
      artifactBtn.click()
    })
    assert.equal(modalCalls[0]?.artifactId, 'abc-1')
  } finally {
    m.unmount()
  }
  const m2 = createMount()
  try {
    await m2.render(
      bodyUi(
        trace({
          toolName: 'read',
          input: { path: 'src/x.py' },
          resultText: 'print("hi")\n',
          presentationMeta: { path: '/abs/src/x.py', nodeId: 'local' },
        }),
      ),
    )
    assert.match(m2.host.textContent ?? '', /Read result/)
    assert.ok(m2.host.querySelector('.trace-code-sec pre'), '普通结果走源码预览')
    assert.equal(preLineCount(m2.host, '.trace-code-sec pre'), 1)
  } finally {
    m2.unmount()
  }
})

test('bash：命令可复制；输出默认尾 8 行、标注折叠前 N 行、可展开全部；退出码如实', { timeout: 60_000 }, async () => {
  let clipboardText = ''
  const origClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => {
      clipboardText = text
    } },
  })
  const m = createMount()
  try {
    const output = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join('\n')
    await m.render(
      bodyUi(
        trace({
          toolName: 'bash',
          input: { command: 'pnpm test --filter @helmx/web' },
          resultText: output,
          presentationMeta: { ok: false, exitCode: 2, timedOut: false },
        }),
      ),
    )
    assert.match(m.host.querySelector('.trace-cmd-head code')?.textContent ?? '', /pnpm test --filter @helmx\/web/)
    assert.match(m.host.textContent ?? '', /Exit code 2\(non-zero\)/, '非零退出码如实展示')
    const pres = [...m.host.querySelectorAll('pre')].filter((p) => p.closest('.trace-cmd-head') === null)
    const outPre = pres.find((p) => p.textContent?.includes('out 20'))
    assert.ok(outPre)
    assert.equal(outPre?.textContent?.split('\n').length, 8, '默认输出尾 8 行')
    assert.match(m.host.textContent ?? '', /12 lines collapsed above/)
    assert.ok(m.host.textContent?.includes('out 20') && !m.host.textContent?.includes('out 5'), '仅显示尾部行')
    const expand = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Expand all')) as HTMLButtonElement
    await act(async () => {
      expand.click()
    })
    assert.ok(m.host.textContent?.includes('out 5'), '展开后可见全部输出')
    const copy = m.host.querySelector('.trace-cmd-head button') as HTMLButtonElement
    await act(async () => {
      copy.click()
    })
    assert.equal(clipboardText, 'pnpm test --filter @helmx/web', '复制完整命令')
  } finally {
    m.unmount()
    if (origClipboardDesc !== undefined) {
      Object.defineProperty(globalThis.navigator, 'clipboard', origClipboardDesc)
    } else {
      delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard
    }
  }
})

test('bash：运行中无输出如实提示，不伪造输出', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(bodyUi(trace({ toolName: 'bash', status: 'running', input: { command: 'sleep 1' } })))
    assert.match(m.host.textContent ?? '', /Executing; no output yet/)
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

test('通用工具：键值展示多行入参；原始数据展开保留完整 JSON 与原始输出', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'gate',
          input: { question: '是否继续部署？', options: ['继续', '终止'], context: 'step1\nstep2' },
          resultText: 'approved',
          presentationMeta: { decision: '继续' },
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /是否继续部署？/)
    assert.ok(m.host.querySelector('.trace-kv'), '键值形态渲染')
    const rawBtn = m.host.querySelector('.trace-raw .btn-inline') as HTMLElement
    assert.equal(rawBtn.getAttribute('aria-expanded'), 'false', '原始数据默认收起')
    await act(async () => {
      rawBtn.click()
    })
    const text = m.host.textContent ?? ''
    assert.match(text, /"question": "是否继续部署？"/, '完整 JSON 入参不丢')
    assert.match(text, /"decision": "继续"/, '结构化结果保留')
    assert.match(text, /approved/, '原始输出保留')
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// TraceRow 集成（无插件接管使用内置体；tool.view 接管行为不变）
// ---------------------------------------------------------------------------

test('TraceRow：无插件接管时点击在右侧抽屉打开内置详情体，再点击关闭按钮收起', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(rowUi(trace({ toolName: 'bash', input: { command: 'ls' }, resultText: 'a\nb' })))
    const row = m.host.querySelector('.trace-row') as HTMLElement
    assert.equal(row.getAttribute('role'), 'button')
    assert.equal(row.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(row.getAttribute('aria-expanded'), 'false')
    await act(async () => {
      row.click()
    })
    assert.equal(row.getAttribute('aria-expanded'), 'true')
    const drawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')
    assert.ok(drawer !== null, '右侧检视抽屉打开')
    assert.ok(drawer.querySelector('.trace-tool-body') !== null, '抽屉内展示内置工具详情体')
    assert.match(drawer.textContent ?? '', /Raw data/)

    const closeBtn = drawer.querySelector<HTMLButtonElement>('.process-drawer-close-btn')!
    assert.ok(closeBtn !== null)
    await act(async () => {
      closeBtn.click()
    })
    assert.equal(row.getAttribute('aria-expanded'), 'false')
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null, '关闭抽屉后释放 DOM')
  } finally {
    m.unmount()
  }
})

test('TraceRow：运行中行右侧仅显示实时耗时秒表，无锚点留空不编造', { timeout: 60_000 }, async () => {
  resetServerClock()
  const m = createMount()
  try {
    // 2 分钟锚点：分钟档取整对渲染毫秒级延迟不敏感（120.0s~120.9s 均为 2m0s）
    await m.render(rowUi(trace({ status: 'running', startedAt: Date.now() - 120_000 })))
    const right = m.host.querySelector('.trace-row-right')
    assert.ok(right, '运行中行右侧状态区存在')
    // 左侧转圈已表意运行中：右侧不再重复状态文案，只显示秒表
    assert.match(right!.textContent ?? '', /^\d+m\d+s$/, '仅实时耗时')
    assert.ok(right!.querySelector('.tabular-nums'), '耗时使用等宽数字防抖宽')

    // entry 未到达的短暂窗口：无 startedAt 时不编造起点，右侧留空
    await m.render(rowUi(trace({ status: 'running' })))
    const noAnchor = m.host.querySelector('.trace-row-right')
    assert.equal(noAnchor?.textContent ?? '', '')

    // 工具落定后回退为累计耗时
    await m.render(rowUi(trace({ status: 'done', durationMs: 1500 })))
    const settled = m.host.querySelector('.trace-row-right')
    assert.match(settled?.textContent ?? '', /1\.5s/)
  } finally {
    m.unmount()
  }
})

test('TraceRow：tool.view inline 保留原始数据抽屉入口，不提供宿主专属展开体', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      rowUi(
        trace({
          toolName: 'subagent',
          input: { prompt: '保留插件的原始输入' },
          resultText: '原始派工结果',
          toolView: { pluginId: 'builtin:workflow', spec: { id: 'subagent-view', toolNames: ['subagent'] } },
        }),
      ),
    )
    const row = m.host.querySelector('.trace-row') as HTMLElement
    assert.ok(row)
    assert.equal(row.getAttribute('role'), 'button', '保留原有可点击工具行')
    assert.ok(m.host.querySelector('.trace-toolview'), '插件视图仍在行下方渲染')
    await act(async () => {
      row.click()
    })
    const drawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')
    assert.ok(drawer !== null, '可打开抽屉查看原始数据')
    assert.ok(drawer.querySelector('.trace-tool-body') === null, '插件不被宿主专属展开体接管')
    assert.match(drawer.textContent ?? '', /保留插件的原始输入/)
    assert.match(drawer.textContent ?? '', /原始派工结果/)
  } finally {
    m.unmount()
  }
})

test('TraceRow：单行统计 write 行数与 edit +N −N；无统计不渲染徽标', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(rowUi(trace({ toolName: 'write', input: { path: '/a', content: 'a\nb\nc' } })))
    const stats = m.host.querySelector('.trace-row-stats')
    assert.match(stats?.textContent ?? '', /3 lines/)

    await m.render(
      rowUi(
        trace({
          toolName: 'edit',
          presentationMeta: validEditMeta([
            { kind: 'remove', oldLine: 2, text: 'a' },
            { kind: 'add', newLine: 2, text: 'b' },
            { kind: 'add', newLine: 3, text: 'c' },
          ]),
        }),
      ),
    )
    const editStats = m.host.querySelector('.trace-row-stats')
    assert.match(editStats?.textContent ?? '', /\+2/)
    assert.match(editStats?.textContent ?? '', /−1/)
    assert.match(editStats?.getAttribute('title') ?? '', /Applied diff/)

    await m.render(rowUi(trace({ toolName: 'bash', input: { command: 'ls' } })))
    assert.ok(m.host.querySelector('.trace-row-stats') === null, '无统计不渲染徽标')
  } finally {
    m.unmount()
  }
})

test('原型属性同名工具走通用展示，不误当作内置 React 组件', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    for (const toolName of ['toString', 'constructor', '__proto__']) {
      await m.render(bodyUi(trace({ toolName, input: { query: '真实参数' }, resultText: '真实输出' })))
      assert.match(m.host.textContent ?? '', /真实参数/)
      assert.match(m.host.textContent ?? '', /真实输出/)
    }
  } finally {
    m.unmount()
  }
})

test('TraceRow：摘要完整渲染命令首行且不按字符数截断，宽度裁剪交给 CSS 省略', { timeout: 60_000 }, async () => {
  const style = document.createElement('style')
  style.textContent = readHostStyles()
  document.head.appendChild(style)
  const m = createMount()
  try {
    const longCommand = 'cd /root/code/helm && (ls -l /proc/[0-9]*/cwd 2>/dev/null | rg -c helm) && echo done'
    assert.ok(longCommand.length > 60, 'fixture must exceed the retired 60-char cap')
    await m.render(rowUi(trace({ toolName: 'bash', input: { command: `${longCommand}\n# 说明行不进摘要` } })))
    const left = m.host.querySelector<HTMLElement>('.trace-row-left')
    const name = m.host.querySelector<HTMLElement>('.trace-tool-name')
    const summary = m.host.querySelector<HTMLElement>('.trace-tool-summary')
    assert.ok(left !== null && name !== null && summary !== null)
    assert.equal(summary.textContent, longCommand, '摘要 = 命令首行全文，不手动拼 …')
    assert.equal(name.textContent, 'bash')

    // action/工具名在窄屏长摘要下严禁参与 flex 收缩或触发省略号（避免 bash -> ba...）
    const leftStyle = getComputedStyle(left)
    const nameStyle = getComputedStyle(name)
    const summaryStyle = getComputedStyle(summary)
    assert.equal(nameStyle.flexShrink, '0', '.trace-tool-name 不可收缩')
    assert.equal(nameStyle.whiteSpace, 'nowrap')
    assert.notEqual(nameStyle.textOverflow, 'ellipsis', '.trace-tool-name 不得截断出省略号')
    assert.equal(summaryStyle.flexShrink, '1')
    assert.ok(summaryStyle.minWidth === '0' || summaryStyle.minWidth === '0px')
    assert.equal(summaryStyle.textOverflow, 'ellipsis')
    assert.ok(leftStyle.minWidth === '0' || leftStyle.minWidth === '0px')
    assert.equal(leftStyle.overflow, 'hidden')
  } finally {
    m.unmount()
    style.remove()
  }
})

// ---------------------------------------------------------------------------
// TraceRow 右侧 chevron 指示器与 StepGroup 折叠错误徽标 / 总耗时
// ---------------------------------------------------------------------------

test('TraceRow：外层保持 div.trace-row[role="button"]，右侧显示 chevron 指示器且抽屉开关不污染耗时文本', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      rowUi(trace({ toolName: 'bash', status: 'done', durationMs: 120, input: { command: 'ls' }, resultText: 'ok' })),
    )
    const row = m.host.querySelector('div.trace-row') as HTMLElement
    assert.ok(row !== null, '外层可点击元素必须保持 div.trace-row')
    assert.equal(row.getAttribute('role'), 'button')
    assert.equal(row.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(row.getAttribute('aria-expanded'), 'false')
    const rightEl = row.querySelector('.trace-row-right')
    assert.equal(rightEl?.textContent, '120ms', 'chevron SVG 不污染 .trace-row-right 纯文本')
    const chevron = rightEl?.querySelector('.trace-row-chevron')
    assert.ok(chevron !== null, '渲染 .trace-row-chevron')
    assert.ok(chevron.classList.contains('lucide-chevron-right'), '保持右向 chevron 指示器')

    await act(async () => {
      row.click()
    })
    assert.equal(row.getAttribute('aria-expanded'), 'true')
    assert.equal(rightEl?.textContent, '120ms')
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') !== null)

    // right 为空串（unknown 状态且无耗时）：仍保留 chevron 且不渲染多余空 span 文本
    await m.render(rowUi(trace({ toolName: 'bash', status: 'unknown', isError: false })))
    const unknownRight = m.host.querySelector('.trace-row-right')
    assert.equal(unknownRight?.textContent, '')
    assert.ok(unknownRight?.querySelector('.trace-row-chevron') !== null)
  } finally {
    m.unmount()
  }
})

test('StepGroup：收起且含失败工具时展示失败徽标与总耗时；展开后露出流水列表且点击单步弹二级抽屉', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const steps: FoldableStep[] = [
      { kind: 'thinking', thinking: { key: 'th1', text: '先检查环境' } },
      { kind: 'tool', tool: trace({ key: 't1', toolName: 'read', status: 'done', durationMs: 120, input: { path: '/a' } }) },
      {
        kind: 'tool',
        tool: trace({
          key: 't2',
          toolName: 'bash',
          status: 'error',
          isError: true,
          durationMs: 1380,
          input: { command: 'pnpm test' },
          resultText: 'exit 1',
        }),
      },
    ]
    await m.render(stepGroupUi(steps, false))

    const summaryBtn = m.host.querySelector('button.trace-group-summary') as HTMLButtonElement
    assert.ok(summaryBtn !== null)
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(summaryBtn.classList.contains('trace-group-summary-error'), true, '收起且含失败时加错误修饰类')
    assert.match(summaryBtn.textContent ?? '', /Thinking and execution \(3 steps\)/)

    const errorBadge = summaryBtn.querySelector('.trace-group-badge.trace-group-badge-error')
    assert.equal(errorBadge?.textContent, '1 failed')
    const meta = summaryBtn.querySelector('.trace-group-meta.tabular-nums')
    assert.equal(meta?.textContent, '1.5s')
    assert.equal(summaryBtn.querySelectorAll('.trace-group-meta').length, 1)
    assert.doesNotMatch(summaryBtn.textContent ?? '', /Model|Tools/)

    // 一级点击展开：就地展开单行流水列表并隐藏组级失败徽标（具体失败工具行已在列表内），不弹抽屉
    await act(async () => {
      summaryBtn.click()
    })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'true')
    assert.equal(summaryBtn.classList.contains('trace-group-summary-error'), false)
    assert.ok(summaryBtn.querySelector('.trace-group-badge-error') === null)
    assert.equal(summaryBtn.querySelector('.trace-group-meta')?.textContent, '1.5s')
    assert.ok(m.host.querySelector('.trace-group-steps') !== null)
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    // 点击一级列表中的失败 bash 行：打开二级单栏详情抽屉
    const bashRow = m.host.querySelectorAll<HTMLElement>('.trace-group-steps .trace-row')[1]!
    assert.ok(bashRow !== undefined)
    await act(async () => {
      bashRow.click()
    })
    const drawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')
    assert.ok(drawer !== null, '点击子步骤行打开二级详情抽屉')
    assert.match(drawer.textContent ?? '', /pnpm test/)
    assert.match(drawer.textContent ?? '', /exit 1/)

    // 关闭抽屉，并收起一级列表：恢复未展开态与组级失败徽标
    const closeBtn = drawer.querySelector<HTMLButtonElement>('.process-drawer-close-btn')!
    await act(async () => {
      closeBtn.click()
    })
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)
    await act(async () => {
      summaryBtn.click()
    })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(summaryBtn.querySelector('.trace-group-badge-error')?.textContent, '1 failed')
  } finally {
    m.unmount()
  }
})

test('StepGroup: one total with localized timing details on hover and keyboard focus', { timeout: 60_000 }, async () => {
  const m = createMount()
  const localeStore = makeTestStore({ locale: 'en' })
  const steps: FoldableStep[] = [
    { kind: 'thinking', thinking: { key: 'th1', text: 'Check the workspace', responseDurationMs: 3200 } },
    { kind: 'tool', tool: trace({ key: 't1', durationMs: 5000 }) },
    { kind: 'tool', tool: trace({ key: 't2', durationMs: 5000, status: 'error', isError: true }) },
  ]
  try {
    await m.render(e(HostStoreProviders, { value: localeStore }, e(StepGroup, {
      steps, active: false, conversationId: 1,
    })))
    const summaryBtn = m.host.querySelector<HTMLButtonElement>('button.trace-group-summary')!
    assert.equal(summaryBtn.querySelector('.trace-group-meta')?.textContent, '13.2s')
    assert.equal(summaryBtn.querySelector('.trace-group-badge-error')?.textContent, '1 failed')
    assert.doesNotMatch(summaryBtn.textContent ?? '', /Model|Tools/)
    assert.equal(summaryBtn.querySelectorAll('button').length, 0)
    assert.ok(document.querySelector('[role="tooltip"]') === null)

    await act(async () => {
      summaryBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    await waitForCondition(() => document.querySelector('[role="tooltip"]') !== null)
    const details = document.querySelector('[role="tooltip"]')!
    assert.match(details.textContent ?? '', /Model 3\.2s/)
    assert.match(details.textContent ?? '', /Tools 10\.0s/)
    assert.match(details.textContent ?? '', /cumulative time, not elapsed time; parallel tools count separately/)
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false', 'Hover must not expand the group')
    assert.equal(summaryBtn.getAttribute('aria-describedby'), details.id)

    await act(async () => { localeStore.setLocale('zh-CN') })
    assert.equal(summaryBtn.querySelector('.trace-group-badge-error')?.textContent, '1 失败')
    assert.equal(summaryBtn.querySelector('.trace-group-meta')?.textContent, '13.2s')
    assert.doesNotMatch(summaryBtn.textContent ?? '', /模型|工具|含|项失败/)
    const localizedDetails = document.querySelector('[role="tooltip"]')!
    assert.match(localizedDetails.textContent ?? '', /模型 3\.2s/)
    assert.match(localizedDetails.textContent ?? '', /工具 10\.0s/)
    assert.match(localizedDetails.textContent ?? '', /累计耗时/)

    await act(async () => { summaryBtn.focus() })
    await waitForCondition(() => document.querySelector('[role="tooltip"]') !== null)
    assert.match(document.querySelector('[role="tooltip"]')?.textContent ?? '', /模型 3\.2s/)
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false', 'Keyboard focus must not expand the group')

    await act(async () => { summaryBtn.click() })
    await waitForCondition(() => document.querySelector('[role="tooltip"]') === null)
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'true')
    assert.ok(m.host.querySelector('.trace-group-steps') !== null)
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)
  } finally {
    localStorage.removeItem('helmx:locale')
    m.unmount()
  }
})

test('StepGroup：进行中（active=true）默认就地展开流水且不显示总耗时，单思考步委派 ThinkingRow 不嵌套摘要', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const steps: FoldableStep[] = [
      {
        kind: 'tool',
        tool: trace({ key: 't1', toolName: 'bash', status: 'error', isError: true, durationMs: 400 }),
      },
      {
        kind: 'tool',
        tool: trace({ key: 't2', toolName: 'read', status: 'running', input: { path: '/repo/a.ts' } }),
      },
    ]
    await m.render(stepGroupUi(steps, true))
    const summaryBtn = m.host.querySelector('button.trace-group-summary') as HTMLButtonElement
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'true', '进行中一级流水默认展开，不弹抽屉')
    assert.match(summaryBtn.textContent ?? '', /Thinking and executing \(2 steps\)…/)
    assert.ok(summaryBtn.querySelector('.trace-group-meta') === null, '进行中不显示总耗时')
    assert.ok(summaryBtn.querySelector('.trace-group-badge-error') === null, '展开态不显示失败徽标')
    const stepList = m.host.querySelector('.trace-group-steps')
    assert.ok(stepList !== null)
    assert.match(stepList.textContent ?? '', /bash/)
    assert.match(stepList.textContent ?? '', /read/)

    // 进行中手动收起：露出已有失败徽标，仍不显示总耗时
    await act(async () => {
      summaryBtn.click()
    })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.equal(summaryBtn.querySelector('.trace-group-badge-error')?.textContent, '1 failed')
    assert.ok(summaryBtn.querySelector('.trace-group-meta') === null, 'active=true 时收起仍不显示总耗时')

    // 重新展开并点击运行中行：打开二级抽屉查看运行中 read，落定后一级自动折叠而抽屉保持开启
    await act(async () => {
      summaryBtn.click()
    })
    const liveRow = m.host.querySelectorAll<HTMLElement>('.trace-group-steps .trace-row')[1]!
    await act(async () => {
      liveRow.click()
    })
    const drawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')!
    assert.ok(drawer !== null)
    assert.match(drawer.querySelector('.process-drawer-title')?.textContent ?? '', /read/)

    // Settled groups show one bare cumulative duration and collapse Level 1 cleanly.
    await m.render(
      stepGroupUi(
        [
          steps[0]!,
          { kind: 'tool', tool: trace({ key: 't2', toolName: 'read', status: 'done', durationMs: 100 }) },
        ],
        false,
      ),
    )
    const settledBtn = m.host.querySelector<HTMLButtonElement>('button.trace-group-summary')!
    assert.equal(settledBtn.getAttribute('aria-expanded'), 'false')
    assert.ok(m.host.querySelector('.trace-group-steps') === null, '落定后自动折叠一级流水')
    assert.equal(settledBtn.querySelector('.trace-group-meta')?.textContent, '500ms')
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') !== null, '已开抽屉无缝保持并更新')

    // 单步 thinking 保持早退 ThinkingRow，不出现 "(1 步)" 或组徽标
    await m.render(stepGroupUi([{ kind: 'thinking', thinking: { key: 'only', text: '单步思路' } }], false))
    const singleBtn = m.host.querySelector('button.trace-group-summary') as HTMLButtonElement
    assert.equal(singleBtn.textContent, 'Thinking')
    assert.ok(singleBtn.querySelector('.trace-group-badge') === null)
    assert.ok(singleBtn.querySelector('.trace-group-meta') === null)
  } finally {
    m.unmount()
  }
})

test('TraceRow：tool.view 透传 presentationMeta 且不再透传 siblingCalls/structuredOutput（inline 与 replaceRow 行为不变）', { timeout: 60_000 }, async () => {
  const received: Array<Record<string, unknown>> = []
  seedPluginClientModule('demo:toolview', 'index.tsx', {
    ProbeToolView: (props: Record<string, unknown>) => {
      received.push(props)
      const meta = props.presentationMeta as { workerId?: number } | undefined
      return e('div', { className: 'probe-tool-view' }, `worker:${meta?.workerId ?? 'none'}`)
    },
  }, 'hash-tv-1')

  const tvStore = makeTestStore({
    plugins: [{
      id: 'demo:toolview',
      name: 'Demo ToolView',
      version: '1.0.0',
      enabled: true,
      locked: false,
      status: 'active',
      hooks: [],
      actions: [],
      tools: [],
      clientHashes: { 'index.tsx': 'hash-tv-1' },
    }],
  })
  const m = createMount()
  try {
    const meta = { workerId: 42 }
    // 1) replaceRow=true: 插件接管整行，收到 presentationMeta，不含 siblingCalls/structuredOutput
    await m.render(e(HostStoreProviders, { value: tvStore }, e(TraceRow, {
      tool: trace({
        key: 'tool:c-tv-1',
        callId: 'c-tv-1',
        toolName: 'dispatch_demo',
        resultText: 'ok',
        presentationMeta: meta,
        toolView: {
          pluginId: 'demo:toolview',
          spec: { id: 'demo-tv', toolNames: ['dispatch_demo'], replaceRow: true, client: { module: 'index.tsx', export: 'ProbeToolView' } },
        },
      }),
      conversationId: 7,
      defaultOpen: false,
    })))
    await waitForCondition(() => m.host.querySelector('.probe-tool-view') !== null)
    assert.ok(m.host.querySelector('.trace-row') === null, 'replaceRow=true 不渲染默认 .trace-row')
    assert.equal(m.host.querySelector('.probe-tool-view')?.textContent, 'worker:42')
    const lastReplace = received.at(-1)!
    assert.equal(lastReplace.callId, 'c-tv-1')
    assert.equal(lastReplace.conversationId, 7)
    assert.equal(lastReplace.presentationMeta, meta)
    assert.equal('siblingCalls' in lastReplace, false)
    assert.equal('structuredOutput' in lastReplace, false)

    // 2) inline (replaceRow=false): 保留 .trace-row 与 .trace-toolview，展开原始数据可见 presentationMeta
    received.length = 0
    await m.render(e(HostStoreProviders, { value: tvStore }, e(TraceRow, {
      tool: trace({
        key: 'tool:c-tv-2',
        callId: 'c-tv-2',
        toolName: 'dispatch_demo',
        resultText: 'inline-ok',
        presentationMeta: meta,
        toolView: {
          pluginId: 'demo:toolview',
          spec: { id: 'demo-tv-inline', toolNames: ['dispatch_demo'], client: { module: 'index.tsx', export: 'ProbeToolView' } },
        },
      }),
      conversationId: 7,
      defaultOpen: false,
    })))
    await waitForCondition(() => m.host.querySelector('.trace-toolview .probe-tool-view') !== null)
    assert.ok(m.host.querySelector('.trace-row') !== null, 'inline 模式保留 .trace-row')
    const lastInline = received.at(-1)!
    assert.equal(lastInline.presentationMeta, meta)
    assert.equal('siblingCalls' in lastInline, false)
    assert.equal('structuredOutput' in lastInline, false)
  } finally {
    m.unmount()
    resetPluginClientCache()
  }
})

test('ConversationTimeline 端到端装配：toolResult.details 透传至 ToolViewProps.presentationMeta，并通过 TimelineToolCallsContext 按 toolName 分片供给 useTimelineToolCalls（无关工具更新零通知）', { timeout: 60_000 }, async () => {
  resetPluginClientCache()
  const receivedProps = new Map<string, Record<string, unknown>>()
  const observedShards = new Map<string, ReadonlyArray<{ callId: string; status: string; presentationMeta?: Readonly<Record<string, unknown>> }>>()
  const shardRenders = new Map<string, number>()

  const SubagentShardObserver = React.memo(function SubagentShardObserver({ callId }: { callId: string }) {
    const subagentCalls = useTimelineToolCalls('subagent')
    observedShards.set(callId, subagentCalls)
    shardRenders.set(callId, (shardRenders.get(callId) ?? 0) + 1)
    const isLatest = subagentCalls.length === 0 || subagentCalls.at(-1)?.callId === callId
    return e('span', { className: 'subagent-shard-observer', 'data-call-id': callId, 'data-latest': String(isLatest) }, `slice:${subagentCalls.length}`)
  })

  function SubagentProbe(props: Record<string, unknown>) {
    const callId = String(props['callId'])
    receivedProps.set(callId, props)
    const meta = props['presentationMeta'] as { execution?: { conversationId?: number; executionId?: string } } | undefined
    const target = meta?.execution?.conversationId !== undefined
      ? `conv:${meta.execution.conversationId}`
      : meta?.execution?.executionId !== undefined
        ? `ext:${meta.execution.executionId}`
        : 'none'
    return e(
      'div',
      { className: 'subagent-probe' },
      `${callId}|${target}|`,
      e(SubagentShardObserver, { callId }),
    )
  }
  seedPluginClientModule('demo:workflow-probe', 'index.tsx', { SubagentProbe }, 'h-tl-1')

  const baseConv = {
    id: 1,
    title: '主会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/repo',
    model: 'faux/m1',
    thinkingLevel: '',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  const uiContributions = [
    {
      pluginId: 'demo:workflow-probe',
      surface: 'tool.view' as const,
      spec: {
        id: 'subagent-probe',
        toolNames: ['subagent'],
        replaceRow: true,
        client: { module: 'index.tsx', export: 'SubagentProbe' },
      },
    },
  ]
  const plugins = [
    {
      id: 'demo:workflow-probe',
      name: 'Workflow Probe',
      locked: false,
      enabled: true,
      status: 'active' as const,
      hooks: [],
      actions: [],
      tools: [],
      clientHashes: { 'index.tsx': 'h-tl-1' },
    },
  ]

  const metaNative = { ok: true, execution: { conversationId: 42 } }
  const metaExternal = { ok: true, execution: { executionId: 'pane-99' } }
  const initialEntries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '执行子任务', origin: 'human' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'sub_1', name: 'subagent', arguments: { prompt: '首轮' } },
            { type: 'toolCall', id: 'ext_1', name: 'subagent', arguments: { prompt: '外部首轮', agentType: 'herdr:codex' } },
          ],
        },
      ],
    },
    {
      id: '3',
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolCallId: 'sub_1', toolName: 'subagent', content: [{ type: 'text', text: '首轮完成' }], details: metaNative, isError: false }],
    },
    {
      id: '4',
      kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolCallId: 'ext_1', toolName: 'subagent', content: [{ type: 'text', text: '外部首轮完成' }], details: metaExternal, isError: false }],
    },
  ]

  const noopEdit = () => {}
  const makeTimelineStore = (entries: ConversationEntry[], live?: ConversationLive) =>
    makeTestStore({
      conversations: [baseConv],
      conversationDetails: {
        1: { ...baseConv, entries },
      },
      conversationLives: live !== undefined ? { 1: live } : {},
      plugins,
      uiContributions,
    })

  const m = createMount()
  try {
    await m.render(
      e(
        HostStoreProviders,
        { value: makeTimelineStore(initialEntries) },
        e(ConversationTimeline, { conversation: baseConv, detailEntries: initialEntries, onRequestEdit: noopEdit }),
      ),
    )
    await waitForCondition(() => m.host.querySelectorAll('.subagent-probe').length === 2)

    // 1) m.details flows directly into ToolViewProps.presentationMeta; legacy channels absent.
    const propsSub1 = receivedProps.get('sub_1')!
    const propsExt1 = receivedProps.get('ext_1')!
    assert.deepEqual(propsSub1['presentationMeta'], metaNative)
    assert.deepEqual(propsExt1['presentationMeta'], metaExternal)
    assert.equal('structuredOutput' in propsSub1, false)
    assert.equal('siblingCalls' in propsSub1, false)

    // 2) useTimelineToolCalls('subagent') receives the real chronological shard via TimelineToolCallsContext.Provider.
    const initialShard = observedShards.get('sub_1')!
    assert.deepEqual(initialShard.map((c) => c.callId), ['sub_1', 'ext_1'])
    assert.deepEqual(initialShard[0]?.presentationMeta, metaNative)
    assert.deepEqual(initialShard[1]?.presentationMeta, metaExternal)
    assert.equal(observedShards.get('ext_1'), initialShard, '同分片订阅者共享冻结数组引用')
    const rendersBeforeBash = shardRenders.get('sub_1')!

    // 3) Adding unrelated tool calls (bash) + live streaming text preserves subagent shard reference and triggers zero observer re-renders.
    const entriesWithBash: ConversationEntry[] = [
      ...initialEntries,
      {
        id: '5',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'bash_1', name: 'bash', arguments: { command: 'ls' } }] }],
      },
      {
        id: '6',
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'bash_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], details: { exitCode: 0 }, isError: false }],
      },
    ]
    const liveWithRead: ConversationLive = {
      conversationId: 1,
      updatedAt: 200,
      text: '正在继续处理…',
      tools: [{ callId: 'read_live', toolName: 'read', status: 'running', input: { path: 'a.ts' } }],
    }
    await m.render(
      e(
        HostStoreProviders,
        { value: makeTimelineStore(entriesWithBash, liveWithRead) },
        e(ConversationTimeline, {
          conversation: { ...baseConv, status: 'working' },
          detailEntries: entriesWithBash,
          live: liveWithRead,
          onRequestEdit: noopEdit,
        }),
      ),
    )
    await waitForCondition(() => m.host.textContent?.includes('正在继续处理…') === true)
    assert.equal(observedShards.get('sub_1'), initialShard, '新增无关工具与流式文本后 subagent 分片引用保持不变')
    assert.equal(shardRenders.get('sub_1'), rendersBeforeBash, '无关工具与流式文本更新不得触发 subagent 分片订阅者重渲染')

    // 4) Adding a resume subagent call updates the 'subagent' shard immediately so prior cards see the continuation.
    const entriesWithResume: ConversationEntry[] = [
      ...entriesWithBash,
      {
        id: '7',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'sub_2', name: 'subagent', arguments: { resume: 42, prompt: '续接' } }] }],
      },
    ]
    await m.render(
      e(
        HostStoreProviders,
        { value: makeTimelineStore(entriesWithResume) },
        e(ConversationTimeline, { conversation: baseConv, detailEntries: entriesWithResume, onRequestEdit: noopEdit }),
      ),
    )
    await waitForCondition(() => m.host.querySelectorAll('.subagent-probe').length === 3)
    const updatedShard = observedShards.get('sub_1')!
    assert.notEqual(updatedShard, initialShard)
    assert.deepEqual(updatedShard.map((c) => c.callId), ['sub_1', 'ext_1', 'sub_2'])
    assert.equal(updatedShard[0], initialShard[0], '未变更前缀元素保留引用')
    assert.equal(m.host.querySelector('[data-call-id="sub_1"]')?.getAttribute('data-latest'), 'false')
    assert.equal(m.host.querySelector('[data-call-id="sub_2"]')?.getAttribute('data-latest'), 'true')
  } finally {
    m.unmount()
    resetPluginClientCache()
  }
})

test('TraceRow：replaceRow=true 卡片统一提供宿主输入/输出展开开关，保留插件主点击行为并展示完整入参/输出/截断与原始数据', { timeout: 60_000 }, async () => {
  resetPluginClientCache()
  let cardClicks = 0
  seedPluginClientModule('demo:cards', 'index.tsx', {
    CardRow: (props: Record<string, unknown>) =>
      e(
        'button',
        {
          type: 'button',
          className: 'demo-card-row',
          onClick: () => {
            cardClicks += 1
          },
        },
        `card:${String(props['toolName'])}`,
      ),
  }, 'hash-io-1')

  const makeCardStore = (locale: 'en' | 'zh-CN' = 'en') =>
    makeTestStore({
      locale,
      plugins: [{
        id: 'demo:cards',
        name: 'Demo Cards',
        version: '1.0.0',
        enabled: true,
        locked: false,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'hash-io-1' },
      }],
    })

  const m = createMount()
  try {
    // 1) Swarm / workflow / subagent 形态的 replaceRow=true 卡片：点击卡片本身仍触发插件主操作，点击右侧 I/O 开关展开完整输入与输出
    await m.render(
      e(
        HostStoreProviders,
        { value: makeCardStore('en') },
        e(TraceRow, {
          tool: trace({
            key: 'tool:sw-1',
            callId: 'sw-1',
            toolName: 'swarm_dispatch_worker',
            input: {
              name: 'author',
              prompt: 'Line 1: audit auth\nLine 2: run tests',
            },
            resultText: 'Dispatched @author (#51), brief=#1.',
            resultTruncation: { truncated: true, totalLines: 120 },
            resultEntryId: '99',
            presentationMeta: { workerConversationId: 51, seq: 1 },
            artifactRef: 'art_sw_1',
            toolView: {
              pluginId: 'demo:cards',
              spec: {
                id: 'swarm-card',
                toolNames: ['swarm_dispatch_worker'],
                replaceRow: true,
                client: { module: 'index.tsx', export: 'CardRow' },
              },
            },
          }),
          conversationId: 7,
          defaultOpen: false,
        }),
      ),
    )
    await waitForCondition(() => m.host.querySelector('.demo-card-row') !== null)
    assert.ok(m.host.querySelector('.trace-row') === null, 'replaceRow=true 仍不渲染宿主默认 .trace-row')

    const toggle = m.host.querySelector<HTMLButtonElement>('.trace-io-toggle')
    assert.ok(toggle !== null, 'replaceRow=true 渲染统一输入/输出抽屉开关')
    assert.equal(toggle.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.match(toggle.getAttribute('aria-label') ?? '', /Show input & output for swarm_dispatch_worker/)

    // 点击卡片本身不触发展开，保留插件跳转语义
    await act(async () => {
      m.host.querySelector<HTMLButtonElement>('.demo-card-row')!.click()
    })
    assert.equal(cardClicks, 1)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')

    // 点击 I/O 开关在右侧抽屉打开：可见 KV 多行入参、输出、截断全文提示、产物入口与原始数据
    await act(async () => {
      toggle.click()
    })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(toggle.classList.contains('trace-io-toggle-open'), true)
    const drawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')!
    assert.ok(drawer !== null, '打开 I/O 检视抽屉')
    assert.ok(drawer.querySelector('.trace-kv') !== null, '入参以可读键值形态展示')
    assert.match(drawer.textContent ?? '', /Line 1: audit auth\nLine 2: run tests/, '多行入参按真实换行展示')
    assert.match(drawer.textContent ?? '', /Dispatched @author \(#51\), brief=#1\./, '输出完整可见')
    assert.match(drawer.textContent ?? '', /Expand full text \(120 lines in total\)/, '服务端截断时保留展开全文取回入口')
    assert.match(drawer.textContent ?? '', /Open full artifact #art_sw_1/, 'Spill 产物入口保留')
    const copyOut = [...drawer.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy output')) as HTMLButtonElement | undefined
    assert.ok(copyOut !== undefined && copyOut.disabled === true, '截断态输出复制受门禁保护')

    const rawBtn = drawer.querySelector<HTMLButtonElement>('.trace-raw .btn-inline')
    assert.ok(rawBtn !== null)
    await act(async () => {
      rawBtn.click()
    })
    assert.match(drawer.textContent ?? '', /"workerConversationId": 51/, '原始数据保留结构化 presentationMeta')

    // 点击关闭按钮关闭抽屉
    const closeIoDrawer = drawer.querySelector<HTMLButtonElement>('.process-drawer-close-btn')!
    await act(async () => {
      closeIoDrawer.click()
    })
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    // 2) 插件 replaceRow=true 接管 bash 且运行中无输出时：不越权渲染宿主 BashToolBody，也不呈现空白，且支持 zh-CN 文案
    await m.render(
      e(
        HostStoreProviders,
        { value: makeCardStore('zh-CN') },
        e(TraceRow, {
          tool: trace({
            key: 'tool:bash-override',
            callId: 'b-1',
            toolName: 'bash',
            status: 'running',
            input: { command: 'echo hi' },
            toolView: {
              pluginId: 'demo:cards',
              spec: {
                id: 'bash-card',
                toolNames: ['bash'],
                replaceRow: true,
                client: { module: 'index.tsx', export: 'CardRow' },
              },
            },
          }),
          conversationId: 7,
          defaultOpen: true,
        }),
      ),
    )
    const zhToggle = m.host.querySelector<HTMLButtonElement>('.trace-io-toggle')!
    assert.match(zhToggle.getAttribute('aria-label') ?? '', /查看 bash 的输入与输出|收起 bash 的输入与输出/)
    await act(async () => {
      if (zhToggle.getAttribute('aria-expanded') === 'false') zhToggle.click()
    })
    const zhDrawer = document.querySelector<HTMLElement>('[role="dialog"].process-inspector-drawer')!
    assert.ok(zhDrawer !== null)
    assert.ok(zhDrawer.querySelector('.trace-cmd-head') === null, '不越权渲染宿主专属 BashToolBody')
    assert.ok(zhDrawer.querySelector('.trace-kv') !== null, '使用通用键值入参视图')
    assert.match(zhDrawer.textContent ?? '', /执行中，暂无输出。/, '运行中无输出如实提示，不留空白')
  } finally {
    m.unmount()
    resetPluginClientCache()
  }
})
