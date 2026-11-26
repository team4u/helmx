import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helmx/protocol'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { renderToString } from 'react-dom/server'
import {
  CONTAINMENT_INTRINSIC_PX,
  OUTLINE_ACTIVE_LINE_PX,
  OUTLINE_BOTTOM_ZONE_PX,
  containmentClassName,
  estimateContainmentBucket,
  resolveActiveAnchorIndex,
  resolveCharsPerLine,
  resolveContainmentClass,
  resolveOutlineReadingBaseline,
  supportsTimelineContainment,
  timelineAnchorId,
} from '../src/conversation/timeline-containment-model.js'
import type { OutlineAnchor } from '../src/conversation/outline-model.js'
import { LazyMount } from '../src/ui/LazyMount.js'
import { MarkdownView } from '../src/conversation/MarkdownView.js'
import {
  buildTimelineItems,
  type AssistantTurn,
  type DividerItem,
  type HumanInputItem,
  type PluginCardItem,
  type ToolTrace,
} from '../src/conversation/timeline-model.js'
import { ConversationTimeline, type OutlineScrollRequest } from '../src/conversation/ConversationTimeline.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const e = React.createElement

let root: Root | undefined
let host: HTMLElement | undefined
describe("timeline-containment", () => {


  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount())
    root = undefined
    host?.remove()
    host = undefined
    document.body.innerHTML = ''
  })

  // ---------------------------------------------------------------------------
  // 1. 纯函数：估高分桶
  // ---------------------------------------------------------------------------

  const div = (id: string): DividerItem => ({ kind: 'divider', key: `divider:${id}`, entryId: id, divider: 'reset' })
  const human = (id: string, text: string): HumanInputItem => ({
    kind: 'human', key: `human:${id}`, entryId: id, text, origin: 'human', fallback: false,
  })
  const tool = (key: string): ToolTrace => ({ key, toolName: 'bash', status: 'done', isError: false })
  const turn = (id: string, text: string, extra: AssistantTurn['segments'] = []): AssistantTurn => ({
    kind: 'assistant',
    key: `turn:${id}`,
    entryIds: [id],
    segments: text === '' ? extra : [{ kind: 'text', key: `text:${id}`, text }, ...extra],
    live: false,
  })

  test('estimateContainmentBucket：按文本规模分桶，divider 最小、插件卡固定中等', { timeout: 60_000 }, () => {
    assert.equal(estimateContainmentBucket(div('9')), 'xs')
    assert.equal(estimateContainmentBucket(human('1', '你好')), 'sm')
    assert.equal(estimateContainmentBucket(human('2', 'x'.repeat(200))), 'sm')
    assert.equal(estimateContainmentBucket(human('3', 'x'.repeat(600))), 'md')
    assert.equal(estimateContainmentBucket(human('4', 'x'.repeat(4000))), 'lg')
    // 附件芯片抬升估高
    assert.equal(estimateContainmentBucket({ ...human('5', '短'), attachments: [{ id: 'a1', name: 'f.png', mimeType: 'image/png', size: 10 }] }), 'sm')
    // assistant：短答 sm、长答 lg；工具行（含折叠组摘要行）计入估高
    assert.equal(estimateContainmentBucket(turn('6', '简短回答')), 'sm')
    assert.equal(estimateContainmentBucket(turn('7', 'x'.repeat(6000))), 'lg')
    assert.equal(
      estimateContainmentBucket(turn('8', '', [{ kind: 'tool', key: 't1', tool: tool('t1') }, { kind: 'step-group', key: 'g', stepCount: 1, steps: [{ kind: 'tool', tool: tool('t2') }] }])),
      'sm',
    )
    // 插件 timeline.renderer 卡片高度不可知：固定中等桶，靠 auto 记忆纠正
    const card: PluginCardItem = {
      kind: 'plugin-card', key: 'card:1', entryId: '1',
      entry: { id: '1', kind: 'custom.card', data: {} },
      renderer: { pluginId: 'builtin:x', spec: {} as PluginCardItem['renderer']['spec'] },
    }
    assert.equal(estimateContainmentBucket(card), 'md')
  })

  test('containmentClassName 与 CONTAINMENT_INTRINSIC_PX 对应 CSS 分桶类', { timeout: 60_000 }, () => {
    for (const bucket of ['xs', 'sm', 'md', 'lg'] as const) {
      assert.equal(containmentClassName(bucket), `tl-cv-${bucket}`)
      assert.ok(CONTAINMENT_INTRINSIC_PX[bucket] > 0)
    }
  })

  // ---------------------------------------------------------------------------
  // 2. 纯函数：隔离判定与解除
  // ---------------------------------------------------------------------------

  const noRelease = new Set<string>()

  test('resolveContainmentClass：live 回合、排队输入、最新 assistant 回合、解除目标不隔离', { timeout: 60_000 }, () => {
    // 浏览器不支持：一律正常渲染（空类名）
    assert.equal(resolveContainmentClass(turn('1', '正文'), { releasedEntryIds: noRelease }, false), '')
    // 历史完成行：获得分桶类
    assert.match(resolveContainmentClass(turn('1', '正文'), { releasedEntryIds: noRelease }, true), /^tl-cv-/)
    // live 流式回合不隔离
    assert.equal(resolveContainmentClass({ ...turn('2', '流式'), live: true }, { releasedEntryIds: noRelease }, true), '')
    // 排队输入（尚未生效，仍会变化）不隔离
    assert.equal(
      resolveContainmentClass({ ...human('3', '排队'), queuedMode: 'followUp' }, { releasedEntryIds: noRelease }, true),
      '',
    )
    // 最新 assistant 回合无论会话 busy 与否一律真实渲染（估高误差集中在尾部，
    // 隔离它会让首次置底落在估算总高上）；更早的已完成回合照常隔离
    assert.equal(
      resolveContainmentClass(turn('4', '最新'), { releasedEntryIds: noRelease, latestAssistantKey: 'turn:4' }, true),
      '',
    )
    assert.match(
      resolveContainmentClass(turn('5', '更早'), { releasedEntryIds: noRelease, latestAssistantKey: 'turn:4' }, true),
      /^tl-cv-/,
    )
    // 高亮 / 大纲定位目标行解除隔离（entryId 与 assistant 锚点两种口径）
    assert.equal(resolveContainmentClass(human('6', '目标'), { releasedEntryIds: new Set(['6']) }, true), '')
    assert.equal(resolveContainmentClass(turn('7', '目标'), { releasedEntryIds: new Set(['7']) }, true), '')
  })

  test('timelineAnchorId：assistant 回合取首个持久化条目，其余取 entryId', { timeout: 60_000 }, () => {
    assert.equal(timelineAnchorId(turn('2', '正文')), '2')
    assert.equal(timelineAnchorId({ ...turn('2', '正文'), entryIds: [] }), 'turn:2')
    assert.equal(timelineAnchorId(human('1', '文本')), '1')
    assert.equal(timelineAnchorId(div('3')), '3')
  })

  // ---------------------------------------------------------------------------
  // 3. 纯函数：IO 激活锚点决策与支持探测
  // ---------------------------------------------------------------------------

  test('resolveActiveAnchorIndex：取最后相交锚点，空集回退首锚点，无锚点返回 -1', { timeout: 60_000 }, () => {
    assert.equal(resolveActiveAnchorIndex(new Set(), 0), -1)
    // 全部在基准线下方（未有任何行相交）：回退首个锚点
    assert.equal(resolveActiveAnchorIndex(new Set(), 4), 0)
    // 最后一个越过基准线的锚点 = 最大相交索引
    assert.equal(resolveActiveAnchorIndex(new Set([0, 2]), 5), 2)
    assert.equal(resolveActiveAnchorIndex(new Set([0, 1, 4]), 5), 4)
    // 越界索引防御性忽略
    assert.equal(resolveActiveAnchorIndex(new Set([9]), 5), 0)
  })

  test('resolveOutlineReadingBaseline：远离底部固定 96px，近底区线性展开到视口下缘，贴底时恰为视口高', { timeout: 60_000 }, () => {
    const viewport = 800
    // 距底 ≥ 近底区（240px）：固定顶部基线
    assert.equal(resolveOutlineReadingBaseline(OUTLINE_BOTTOM_ZONE_PX, viewport), OUTLINE_ACTIVE_LINE_PX)
    assert.equal(resolveOutlineReadingBaseline(5000, viewport), OUTLINE_ACTIVE_LINE_PX)
    // 贴底（含橡皮筋负值）：基线 = 视口高 → 屏幕内最后一行也算越过
    assert.equal(resolveOutlineReadingBaseline(0, viewport), viewport)
    assert.equal(resolveOutlineReadingBaseline(-40, viewport), viewport)
    // 线性插值：距底 120px（半程）时基线位于 96 与 800 的中点
    const mid = resolveOutlineReadingBaseline(OUTLINE_BOTTOM_ZONE_PX / 2, viewport)
    assert.ok(Math.abs(mid - (OUTLINE_ACTIVE_LINE_PX + (viewport - OUTLINE_ACTIVE_LINE_PX) / 2)) < 1e-9)
    // 单调：越靠近底部基线越大，绝不在阈值处跳变
    let prev = resolveOutlineReadingBaseline(OUTLINE_BOTTOM_ZONE_PX, viewport)
    for (let d = OUTLINE_BOTTOM_ZONE_PX - 1; d >= 0; d -= 1) {
      const next = resolveOutlineReadingBaseline(d, viewport)
      assert.ok(next >= prev, `基线随距底减小单调不减（d=${d}: ${next} < ${prev}）`)
      prev = next
    }
    // 非法输入防御：视口高非法回退 96；距底非法视为远离底部
    assert.equal(resolveOutlineReadingBaseline(0, Number.NaN), OUTLINE_ACTIVE_LINE_PX)
    assert.equal(resolveOutlineReadingBaseline(Number.NaN, viewport), OUTLINE_ACTIVE_LINE_PX)
    // 小视口（< 96px）：贴底时基线收敛到视口高，不超过 96
    assert.equal(resolveOutlineReadingBaseline(0, 50), 50)
    assert.ok(resolveOutlineReadingBaseline(OUTLINE_BOTTOM_ZONE_PX / 2, 50) <= OUTLINE_ACTIVE_LINE_PX)
  })

  test('supportsTimelineContainment：happy-dom 环境为 true；CSS 不可用时为 false', { timeout: 60_000 }, () => {
    assert.equal(supportsTimelineContainment(), true)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
    try {
      Object.defineProperty(globalThis, 'CSS', { value: undefined, configurable: true })
      assert.equal(supportsTimelineContainment(), false)
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, 'CSS', descriptor)
    }
  })

  // ---------------------------------------------------------------------------
  // 4. DOM 交互：渲染隔离类应用 / 解除 / 大纲定位
  // ---------------------------------------------------------------------------

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id, title: '长会话', profileId: 'assistant', tags: [], ownedBy: 'human', cwd: '/tmp',
      model: 'faux/model', thinkingLevel: '', status: 'idle', stateChangeSeq: 1, completionSeq: 2,
      unread: false, pinned: false, pendingAskCount: 0, createdAt: 1000, updatedAt: 2000, ...overrides,
    }
  }

  function humanEntry(id: string, text: string): ConversationEntry {
    return { id, kind: 'helmx.input', data: { id: `in-${id}`, text, origin: 'human' }, createdAt: 1000 }
  }

  function assistantEntry(id: string, text: string): ConversationEntry {
    return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] }
  }

  function hasCvClass(el: Element | null | undefined): boolean {
    return el !== null && el !== undefined && /\btl-cv-/.test(el.className)
  }

  interface RenderOptions {
    conversation?: Partial<ConversationSummary>
    entries: ConversationEntry[]
    live?: ConversationLive
    highlightedEntry?: { conversationId: number; entryId: string } | null
    outlineScrollRequest?: OutlineScrollRequest | null
    onActiveOutlineChange?: (anchor: OutlineAnchor | undefined) => void
  }

  async function renderTimeline(opts: RenderOptions): Promise<ReturnType<typeof makeTestStore>> {
    const conv = makeConv(10, opts.conversation)
    const store = makeTestStore({
      conversations: [conv],
      conversationDetails: { 10: { ...conv, entries: opts.entries } },
      ...(opts.highlightedEntry !== undefined ? { highlightedEntry: opts.highlightedEntry } : {}),
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ConversationTimeline, {
            conversation: conv,
            detailEntries: opts.entries,
            onRequestEdit: () => {},
            ...(opts.live !== undefined ? { live: opts.live } : {}),
            ...(opts.outlineScrollRequest !== undefined ? { outlineScrollRequest: opts.outlineScrollRequest } : {}),
            ...(opts.onActiveOutlineChange !== undefined ? { onActiveOutlineChange: opts.onActiveOutlineChange } : {}),
          }),
        ),
      )
    })
    return store
  }

  test('历史完成行按分桶获得渲染隔离类，divider 最小桶；最新 assistant 回合与空闲会话也真实渲染；DOM 全部保留', { timeout: 60_000 }, async () => {
    await renderTimeline({
      entries: [
        humanEntry('1', '短消息'),
        assistantEntry('2', '# 标题\n\n正文'),
        humanEntry('3', 'x'.repeat(600)),
        assistantEntry('4', 'x'.repeat(6000)),
        { id: '5', kind: 'pi.reset', data: {} },
      ],
    })
    const rows = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
    assert.equal(rows.length, 5, '全部条目 DOM 保留（不裁剪历史）')
    assert.match(rows[0]!.className, /\btl-cv-sm\b/, '短人类消息 → sm 桶')
    assert.match(rows[1]!.className, /\btl-cv-sm\b/, '短助手回合 → sm 桶')
    assert.match(rows[2]!.className, /\btl-cv-md\b/, '600 字符人类消息 → md 桶')
    assert.equal(
      /\btl-cv-/.test(rows[3]!.className),
      false,
      'idle 会话的最新 assistant 回合（尾部长回答）不隔离：首次置底依赖真实总高',
    )
    assert.match(rows[4]!.className, /\btl-cv-xs\b/, '分割线 → xs 桶')
  })

  test('live 流式回合与排队输入不隔离，历史人类行照常隔离；搜索高亮目标行解除隔离', { timeout: 60_000 }, async () => {
    const live: ConversationLive = {
      conversationId: 10,
      text: 'Generating的流式正文',
      tools: [],
      updatedAt: 5,
      queuedInputs: [{ id: 'q1', submissionId: 's1', text: '排队消息', mode: 'followUp', origin: 'human', createdAt: 1 }],
    }
    await renderTimeline({
      conversation: { status: 'working' },
      entries: [humanEntry('1', '第一问'), assistantEntry('2', '第一答')],
      live,
    })
    const liveTurn = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
    assert.ok(liveTurn, 'live 回合行存在')
    assert.equal(hasCvClass(liveTurn), false, 'live 流式回合不隔离')
    const queued = host!.querySelector<HTMLElement>('[data-entry-id="queued:s1"]')
    assert.ok(queued, '排队输入行存在')
    assert.equal(hasCvClass(queued), false, '排队输入行不隔离')
    const historical = host!.querySelector<HTMLElement>('[data-entry-id="1"]')
    assert.equal(hasCvClass(historical), true, '历史人类行照常隔离')

    // 搜索高亮（store.highlightedEntry）目标行解除隔离并滚动定位
    const scrolled: HTMLElement[] = []
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
    try {
      await renderTimeline({
        conversation: { status: 'working' },
        entries: [humanEntry('1', '第一问'), assistantEntry('2', '第一答')],
        live,
        highlightedEntry: { conversationId: 10, entryId: '1' },
      })
      const highlighted = host!.querySelector<HTMLElement>('[data-entry-id="1"]')
      assert.equal(hasCvClass(highlighted), false, '高亮目标行解除隔离')
      assert.ok(scrolled.some((el) => el === highlighted), '高亮目标行触发 scrollIntoView')
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
    }
  })

  test('大纲定位：先解除目标行隔离，commit 后按 heading 序数精确滚动到对应标题', { timeout: 60_000 }, async () => {
    // 目标是非最新的历史回合（最新 assistant 回合给终真实渲染，无需解除）
    const entries = [
      humanEntry('1', '问'),
      assistantEntry('2', '# 一级\n正文A\n## 二级目标\n正文B\n### 三级\n正文C'),
      humanEntry('3', '再问'),
      assistantEntry('4', '最新回答'),
    ]
    // 第一阶段：无定位请求，目标历史回合行正常隔离
    await renderTimeline({ entries })
    const wrapperBefore = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
    assert.equal(hasCvClass(wrapperBefore), true, '请求前目标历史回合处于隔离态（最新回合始终真实渲染）')

    // 第二阶段：带 headingIndex 的定位请求 → 解除隔离后滚动到精确 <h2>
    const scrolled: Array<{ el: HTMLElement; wrapperClass: string }> = []
    const activeCalls: Array<OutlineAnchor | undefined> = []
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () {
      const wrapper = this.closest('[data-entry-id]')
      scrolled.push({ el: this, wrapperClass: wrapper?.className ?? '' })
    }
    try {
      await renderTimeline({
        entries,
        outlineScrollRequest: { entryId: '2', headingIndex: 1, tick: 1 },
        onActiveOutlineChange: (anchor) => activeCalls.push(anchor),
      })
      assert.ok(scrolled.length > 0, '大纲定位触发 scrollIntoView')
      const last = scrolled[scrolled.length - 1]!
      assert.equal(last.el.tagName.toLowerCase(), 'h2', 'headingIndex=1 精确滚动到第二个标题（DOM 顺序保真）')
      assert.match(last.el.textContent ?? '', /二级目标/)
      assert.equal(/\btl-cv-/.test(last.wrapperClass), false, '滚动发生时目标行已解除渲染隔离（真实布局测量）')
      const wrapper = host!.querySelector<HTMLElement>('[data-entry-id="2"]')
      assert.match(wrapper?.className ?? '', /entry-highlighted/, '目标回合触发闪烁高亮')
      assert.deepEqual(
        activeCalls[activeCalls.length - 1],
        { entryId: '2', headingIndex: 1 },
        '定位后同步通知当前激活锚点：精确到被点击的标题（而非整个回合）',
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
    }
  })

  // ---------------------------------------------------------------------------
  // 5. DOM 交互：IntersectionObserver 阅读锚点追踪（无整列 rect 扫描）
  // ---------------------------------------------------------------------------

  interface FakeIO {
    callback: (entries: unknown[], observer: unknown) => void
    root: Element | null
    rootMargin: string
    targets: Set<Element>
    disconnected: boolean
    deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void
  }

  class FakeIntersectionObserver {
    static instances: FakeIO[] = []
    private readonly cb: (entries: unknown[], observer: unknown) => void
    readonly root: Element | null
    readonly rootMargin: string
    readonly targets = new Set<Element>()
    disconnected = false
    constructor(callback: (entries: unknown[], observer: unknown) => void, options?: IntersectionObserverInit) {
      this.cb = callback
      this.root = (options?.root ?? null) as Element | null
      this.rootMargin = options?.rootMargin ?? '0px'
      FakeIntersectionObserver.instances.push(this as unknown as FakeIO)
    }
    observe(target: Element): void { this.targets.add(target) }
    unobserve(target: Element): void { this.targets.delete(target) }
    disconnect(): void { this.disconnected = true; this.targets.clear() }
    deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
      this.cb(
        entries.map((entry) => ({ ...entry, intersectionRatio: entry.isIntersecting ? 1 : 0 })),
        this,
      )
    }
  }

  test('IO 路径：仅相交行参与激活计算，scroll 不触发任何 getBoundingClientRect', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    try {
      const activeCalls: Array<OutlineAnchor | undefined> = []
      await renderTimeline({
        entries: [humanEntry('1', '一'), humanEntry('2', '二'), humanEntry('3', '三'), humanEntry('4', '四')],
        onActiveOutlineChange: (anchor) => activeCalls.push(anchor),
      })
      const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]
      assert.ok(io, '渲染后建立阅读锚点观察器')
      assert.ok(io.root?.classList.contains('timeline-scroll'), '以时间线滚动容器为 root')
      assert.match(io.rootMargin, /^0px 0px -\d+px 0px$/, '观察区域下缘收窄到激活基准线')
      assert.equal(io.targets.size, 4, '全部锚点行注册观察')

      const anchors = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
      // 前三行越过基准线 → 激活最后一个越过者（对齐 resolveActiveOutlineEntryId 语义）
      io.deliver([
        { target: anchors[0]!, isIntersecting: true },
        { target: anchors[1]!, isIntersecting: true },
        { target: anchors[2]!, isIntersecting: true },
        { target: anchors[3]!, isIntersecting: false },
      ])
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '3' })
      // 第四行也越过 → 激活推进
      io.deliver([{ target: anchors[3]!, isIntersecting: true }])
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '4' })
      // 上滚：第四行离开 → 激活回退
      io.deliver([{ target: anchors[3]!, isIntersecting: false }])
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '3' })

      // 滚动事件不得触发整列 rect 测量（IO 路径零 getBoundingClientRect）
      const origGBCR = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (): DOMRect {
        throw new Error('IO 路径不应触发 getBoundingClientRect')
      }
      try {
        host!.querySelector('.timeline-scroll')!.dispatchEvent(new Event('scroll'))
      } finally {
        Element.prototype.getBoundingClientRect = origGBCR
      }
    } finally {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  test('IO 路径：锚点集合变化（加载更早历史）时重绑观察器且旧实例断开', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    try {
      const entries = [humanEntry('1', '一'), humanEntry('2', '二')]
      await renderTimeline({ entries })
      assert.equal(FakeIntersectionObserver.instances.length, 1)
      const first = FakeIntersectionObserver.instances[0]!

      // 模拟分页加载更早历史：锚点序列变化 → 重建观察器
      const conv = makeConv(10)
      const store = makeTestStore({
        conversations: [conv],
        conversationDetails: { 10: { ...conv, entries: [humanEntry('0', '更早'), ...entries] } },
      })
      const renderWith = (detailEntries: ConversationEntry[]): Promise<void> =>
        act(async () => {
          root!.render(
            e(
              HostStoreProviders,
              { value: store },
              e(ConversationTimeline, {
                conversation: conv,
                detailEntries,
                onRequestEdit: () => {},
                onActiveOutlineChange: () => {},
              }),
            ),
          )
        })
      await renderWith([humanEntry('0', '更早'), ...entries])
      assert.equal(first.disconnected, true, '旧观察器已断开')
      const second = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]
      assert.notEqual(second, first)
      assert.equal(second!.targets.size, 3, '新观察器注册全部锚点')

      // 流式内容增长（锚点集合不变）不重绑：同锚点序列重渲染
      const before = FakeIntersectionObserver.instances.length
      await renderWith([humanEntry('0', '更早'), ...entries])
      assert.equal(FakeIntersectionObserver.instances.length, before, '锚点签名未变化时不重建观察器')
    } finally {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  test('无 IO 环境退化路径：rAF 节流仅测量基线下方屏幕内的行，语义同 resolveActiveOutlineEntryId', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
    const activeCalls: Array<OutlineAnchor | undefined> = []
    try {
      await renderTimeline({
        entries: [humanEntry('1', '一'), humanEntry('2', '二'), humanEntry('3', '三')],
        onActiveOutlineChange: (anchor) => activeCalls.push(anchor),
      })
      // happy-dom 中所有 rect top=0（均未越过基准线下方）→ 激活最后一个锚点
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '3' })
      // 滚动事件再触发一次测量：结果不变（去重，不重复上报）
      const callsBefore = activeCalls.length
      host!.querySelector('.timeline-scroll')!.dispatchEvent(new Event('scroll'))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
      assert.equal(activeCalls.length, callsBefore)
    } finally {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  // ---------------------------------------------------------------------------
  // 5b. 大纲当前项粒度：回合内标题节 / 近底基线展开 / 跳转锁定
  // ---------------------------------------------------------------------------

  /**
   * 浏览器一致的滚动几何替身：scrollTop 写入截断到 [0, scrollHeight-clientHeight]；标题位置随
   * scrollTop 联动（top = 文档内偏移 - scrollTop），与真实布局几何一致。
   */
  function installScrollGeometry(
    scroller: HTMLElement,
    geometry: { scrollHeight: number; clientHeight: number },
    headingTops: Map<Element, number>,
  ): { setScrollTop(top: number): number; scrollAndFlush(): Promise<void> } {
    let scrollTop = 0
    let clientHeight = geometry.clientHeight
    const maxTop = (): number => Math.max(0, geometry.scrollHeight - clientHeight)
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.max(0, Math.min(v, maxTop()))
      },
    })
    const orig = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const base = headingTops.get(this)
      if (base !== undefined) {
        const top = base - scrollTop
        return { top, bottom: top + 28, left: 0, right: 0, width: 0, height: 28, x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
      if (this === scroller) {
        return { top: 0, bottom: clientHeight, left: 0, right: 0, width: 0, height: clientHeight, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      return orig.call(this)
    }
    return {
      setScrollTop: (top: number): number => {
        scrollTop = Math.max(0, Math.min(top, maxTop()))
        return scrollTop
      },
      scrollAndFlush: async (): Promise<void> => {
        await act(async () => {
          scroller.dispatchEvent(new Event('scroll'))
          await new Promise((resolve) => setTimeout(resolve, 50))
        })
      },
    }
  }

  test('大纲当前项粒度：同一回合内多个标题时激活锚点精确到当前读到的标题节，任一时刻只有一个', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    const orig = Element.prototype.getBoundingClientRect
    try {
      // 一个回合两个标题（远离底部：距底 ≥ 240px，基线固定 96px）
      const entries = [
        humanEntry('1', '问'),
        assistantEntry('2', '# 第一节\n正文一\n## 第二节\n正文二'),
        humanEntry('3', '追问'),
        assistantEntry('4', '后续很长的回答\n'.repeat(400)),
      ]
      const activeCalls: Array<OutlineAnchor | undefined> = []
      await renderTimeline({ entries, onActiveOutlineChange: (anchor) => activeCalls.push(anchor) })
      const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
      const turn = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
      const headings = [...turn.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2')]
      assert.equal(headings.length, 2, '回合内渲染两个标题 DOM')
      // 文档内偏移：h1=600，h2=900；距底 = 12000-500-800 ≫ 240 → 基线固定 96px。
      // scrollTop=500 → h1 top=100（未越过 96 基线），h2 top=400（未越过）
      const headingTops = new Map<Element, number>([[headings[0]!, 600], [headings[1]!, 900]])
      const geo = installScrollGeometry(scroller, { scrollHeight: 12000, clientHeight: 800 }, headingTops)
      geo.setScrollTop(500)
      const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]!
      const wrappers = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]

      // 回合 2 越过基线、回合 3/4 尚未；回合内 h1/h2 均未越过 → 回合级锚点（首个节点）
      io.deliver([
        { target: wrappers[0]!, isIntersecting: true },
        { target: wrappers[1]!, isIntersecting: true },
        { target: wrappers[2]!, isIntersecting: false },
        { target: wrappers[3]!, isIntersecting: false },
      ])
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2' }, '回合内尚无标题越过基线 → 回合级锚点（首个节点）')

      // 下滚 10px：h1 top=90 ≤ 96 越过，h2 top=390 未越过 → 精确到 h1（headingIndex 0）
      geo.setScrollTop(510)
      await geo.scrollAndFlush()
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2', headingIndex: 0 }, '当前项 = 第一个标题节')

      // 继续下滚 300px：h2 top=90 越过 → 精确到 h2（headingIndex 1），且不会同时点亮 h1
      geo.setScrollTop(810)
      await geo.scrollAndFlush()
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2', headingIndex: 1 }, '当前项推进到第二个标题节')

      // 上滚回 h1/h2 都未越过 → 回退回合级锚点
      geo.setScrollTop(0)
      await geo.scrollAndFlush()
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2' }, '标题都退回基线下方后回退为回合对应节点')
    } finally {
      Element.prototype.getBoundingClientRect = orig
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  test('近底阅读基线展开：贴底时末节标题即使越不过 96px 也判定为当前项，远离底部后回退到前一节', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    const orig = Element.prototype.getBoundingClientRect
    try {
      const entries = [
        humanEntry('1', '问'),
        assistantEntry('2', '# 第一节\n正文一\n## 尾节\n正文二'),
      ]
      const activeCalls: Array<OutlineAnchor | undefined> = []
      await renderTimeline({ entries, onActiveOutlineChange: (anchor) => activeCalls.push(anchor) })
      const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
      const turn = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
      const headings = [...turn.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2')]
      // 文档内偏移：h1=1600，h2=2300；scrollHeight=3000，视口 800 → 最大 scrollTop=2200
      // 贴底：h1 top=-600，h2 top=100（> 96，固定基线下永远越不过）
      const headingTops = new Map<Element, number>([[headings[0]!, 1600], [headings[1]!, 2300]])
      const geo = installScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 800 }, headingTops)
      geo.setScrollTop(2200)
      const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]!
      const wrappers = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
      // 固定基线区内：h1 与回合 2 相交、h2 未相交（top=100 > 96）
      io.deliver([
        { target: wrappers[0]!, isIntersecting: true },
        { target: wrappers[1]!, isIntersecting: true },
      ])
      assert.deepEqual(
        activeCalls[activeCalls.length - 1],
        { entryId: '2', headingIndex: 1 },
        '贴底时基线展开到视口下缘：末节标题（top=100）成为当前项，而不是停留在第一节',
      )

      // 远离底部（距底 500 ≥ 240）：基线回到 96px → h2 top=600 未越过 → 当前项回退到第一节
      geo.setScrollTop(1700)
      await geo.scrollAndFlush()
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2', headingIndex: 0 }, '远离底部后固定基线：当前项回退到第一个标题节')
    } finally {
      Element.prototype.getBoundingClientRect = orig
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  test('大纲跳转锁定：被点击的节点在用户滚动接管前不被滚动派生判定覆盖（含贴底情形）', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    const orig = Element.prototype.getBoundingClientRect
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () {}
    try {
      const entries = [
        humanEntry('1', '问'),
        assistantEntry('2', '# 第一节\n正文一\n## 第二节\n正文二'),
        humanEntry('3', '追问'),
        assistantEntry('4', '收尾回答'),
      ]
      const activeCalls: Array<OutlineAnchor | undefined> = []
      await renderTimeline({
        entries,
        // 点击第二个标题（headingIndex=1）
        outlineScrollRequest: { entryId: '2', headingIndex: 1, tick: 1 },
        onActiveOutlineChange: (anchor) => activeCalls.push(anchor),
      })
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2', headingIndex: 1 }, '跳转后立即以被点击的标题为当前项')

      const scroller = host!.querySelector<HTMLElement>('.timeline-scroll')!
      const turn = host!.querySelector<HTMLElement>('[data-entry-id="2"]')!
      const headings = [...turn.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2')]
      // 落定几何（scrollIntoView block:start）：h2 top=0、h1 top=-300；贴底使后续行（3/4）也在屏幕内
      const headingTops = new Map<Element, number>([[headings[0]!, -300], [headings[1]!, 0]])
      const geo = installScrollGeometry(scroller, { scrollHeight: 2000, clientHeight: 800 }, headingTops)
      geo.setScrollTop(1200)
      const io = FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]!
      const wrappers = [...host!.querySelectorAll<HTMLElement>('[data-entry-id]')]
      // 平滑滚动过程中的中间帧：后续回合 3 也越过固定基线、贴底使全部相交 → 派生判定会指向别的节点
      io.deliver([
        { target: wrappers[0]!, isIntersecting: true },
        { target: wrappers[1]!, isIntersecting: true },
        { target: wrappers[2]!, isIntersecting: true },
        { target: wrappers[3]!, isIntersecting: false },
      ])
      await geo.scrollAndFlush()
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '2', headingIndex: 1 }, '滚动动画与落定期间保持被点击的标题，不闪成别的节点')
      assert.equal(activeCalls.length, 1, '锁定期间不发布任何滚动派生的激活项')

      // 用户滚轮接管 → 释放锁定 → 恢复滚动派生（回合 3 越过基线 → 当前项为该提问）
      await act(async () => {
        const wheel = new Event('wheel', { bubbles: true, cancelable: false })
        Object.defineProperty(wheel, 'deltaY', { value: 120 })
        scroller.dispatchEvent(wheel)
      })
      io.deliver([{ target: wrappers[3]!, isIntersecting: false }])
      assert.deepEqual(activeCalls[activeCalls.length - 1], { entryId: '3' }, '用户接管后恢复滚动派生判定')
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
      Element.prototype.getBoundingClientRect = orig
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  // ---------------------------------------------------------------------------
  // 6. 时间线归一化回归：隔离不改变 items 构建契约
  // ---------------------------------------------------------------------------

  test('buildTimelineItems 回归：隔离启用前后 items 锚点序列一致（大纲/搜索不受影响）', { timeout: 60_000 }, () => {
    const entries = [
      humanEntry('1', '第一问'),
      assistantEntry('2', '# A\n\n正文\n\n## B\n\n正文'),
      humanEntry('3', '第二问'),
      assistantEntry('4', '回答'),
    ]
    const items = buildTimelineItems(entries)
    assert.deepEqual(
      items.map((item) => timelineAnchorId(item)),
      ['1', '2', '3', '4'],
    )
  })

  // ---------------------------------------------------------------------------
  // 7. 移动端容器宽度自适应估高分桶
  // ---------------------------------------------------------------------------

  test('resolveCharsPerLine 与窄屏估高：保留无参桌面默认 64，移动端宽度自动收窄避免估高偏矮', { timeout: 60_000 }, () => {
    assert.equal(resolveCharsPerLine(), 64)
    assert.equal(resolveCharsPerLine(undefined), 64)
    assert.equal(resolveCharsPerLine(0), 64)
    assert.equal(resolveCharsPerLine(1200), 64)
    assert.equal(resolveCharsPerLine(375), 23)
    assert.equal(resolveCharsPerLine(320), 20)

    // 200 字符在桌面（64/行）只需 4 行（sm），在 375px 移动端折为 9 行（md）
    const mediumHuman = human('m1', 'x'.repeat(200))
    assert.equal(estimateContainmentBucket(mediumHuman), 'sm')
    assert.equal(estimateContainmentBucket(mediumHuman, { containerWidthPx: 375 }), 'md')

    // 600 字符在桌面为 md，在 375px 移动端折为 27 行（lg）
    const longAssistant = turn('a1', 'x'.repeat(600))
    assert.equal(estimateContainmentBucket(longAssistant), 'md')
    assert.equal(estimateContainmentBucket(longAssistant, { containerWidthPx: 375 }), 'lg')

    // resolveContainmentClass 透传 containerWidthPx / charsPerLine
    assert.equal(
      resolveContainmentClass(longAssistant, { releasedEntryIds: noRelease, containerWidthPx: 375 }, true),
      'tl-cv-lg',
    )
    assert.equal(
      resolveContainmentClass(mediumHuman, { releasedEntryIds: noRelease, charsPerLine: 23 }, true),
      'tl-cv-md',
    )
  })

  // ---------------------------------------------------------------------------
  // 8. LazyMount 近视口懒挂载（代码块 / 内联产物媒体 / 附件图片）
  // ---------------------------------------------------------------------------

  test('LazyMount：无 IO 与 SSR 环境直出 children；有 IO 时近视口挂载且保持不卸载', { timeout: 60_000 }, async () => {
    // 1) SSR renderToString：无 IO，直出 children
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
    try {
      const ssrHtml = renderToString(
        e(LazyMount, {
          fallback: e('span', { className: 'lazy-ph' }, 'waiting'),
          children: e('span', { className: 'lazy-real' }, 'mounted'),
        }),
      )
      assert.ok(ssrHtml.includes('lazy-real'), 'SSR 环境立即直出真实内容')
      assert.ok(!ssrHtml.includes('lazy-ph'))

      // 2) happy-dom 无 IO 环境（IntersectionObserver = undefined）：立即直出
      host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(
          e(LazyMount, {
            fallback: e('div', { className: 'lazy-ph' }),
            children: e('div', { className: 'lazy-real' }, 'ready'),
          }),
        )
      })
      assert.ok(host.querySelector('.lazy-real') !== null, '无 IO 环境直接渲染')
      act(() => root!.unmount())
      root = undefined
      host.remove()
    } finally {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }

    // 3) 真实 IO（FakeIntersectionObserver）：未进入近视口前仅渲染占位，进入后挂载且离开也不卸载
    const prevInstances = [...FakeIntersectionObserver.instances]
    FakeIntersectionObserver.instances = []
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
    try {
      let mountCount = 0
      let unmountCount = 0
      function Probe(): React.ReactNode {
        React.useEffect(() => {
          mountCount += 1
          return () => {
            unmountCount += 1
          }
        }, [])
        return e('div', { className: 'lazy-child' }, 'loaded')
      }

      host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(
          e(LazyMount, {
            minHeight: 100,
            fallback: e('div', { className: 'lazy-fallback' }, 'placeholder'),
            children: e(Probe),
          }),
        )
      })
      assert.ok(host.querySelector('.lazy-fallback') !== null, '进视口前渲染轻量占位')
      assert.ok(host.querySelector('.lazy-child') === null, '进视口前不挂载子组件')
      assert.equal(mountCount, 0)
      assert.equal(FakeIntersectionObserver.instances.length, 1)
      const io = FakeIntersectionObserver.instances[0]!
      assert.equal(io.rootMargin, '400px 0px', '默认提前 400px 近视口预挂载')

      const slotEl = host.querySelector('.lazy-mount')!
      await act(async () => {
        io.deliver([{ target: slotEl, isIntersecting: true }])
      })
      assert.ok(host.querySelector('.lazy-child') !== null, '进入近视口后挂载真实子组件')
      assert.equal(mountCount, 1)
      assert.equal(io.disconnected, true, '一次性挂载后断开观察器')

      // 即使后续滚离也不会卸载
      await act(async () => {
        io.deliver([{ target: slotEl, isIntersecting: false }])
      })
      assert.ok(host.querySelector('.lazy-child') !== null)
      assert.equal(unmountCount, 0, '挂载后保持已挂载状态不反复卸载')
      assert.ok(io.root === null, '未传 scrollRootSelector 时 root 为 null')

      // 4) scrollRootSelector 解析自定义滚动祖先而非硬编码 .timeline-scroll
      act(() => root!.unmount())
      root = undefined
      host.remove()
      FakeIntersectionObserver.instances = []
      host = document.createElement('div')
      host.className = 'custom-scroll-root'
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(
          e(LazyMount, {
            scrollRootSelector: '.custom-scroll-root',
            fallback: e('div', { className: 'lazy-fallback-custom' }, 'placeholder'),
            children: e('div', { className: 'lazy-child-custom' }, 'loaded'),
          }),
        )
      })
      assert.equal(FakeIntersectionObserver.instances.length, 1)
      assert.ok(FakeIntersectionObserver.instances[0]!.root === host, 'scrollRootSelector 应绑定到匹配的滚动根容器')
    } finally {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
      FakeIntersectionObserver.instances = prevInstances
    }
  })

  test('MarkdownView 与 ConversationTimeline：远视口内联媒体、附件图片与代码块延迟 fetch 直到接近视口', { timeout: 60_000 }, async () => {
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    const prevInstances = [...FakeIntersectionObserver.instances]
    FakeIntersectionObserver.instances = []
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver

    const fetchedUrls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input))
      return new Response(new Blob(['img'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch

    try {
      const conv = makeConv(10)
      const entries: ConversationEntry[] = [
        {
          id: '1',
          kind: 'helmx.input',
          data: {
            id: 'in-1',
            text: '看附件图',
            origin: 'human',
            attachments: [{ id: 'att-img-1', name: 'shot.png', mimeType: 'image/png', size: 120 }],
          },
          createdAt: 1000,
        },
        assistantEntry('2', '正文\n\n![内联图](artifact:art-inline-1)\n\n```ts\nconst x = 1\n```'),
      ]
      const store = makeTestStore({
        conversations: [conv],
        conversationDetails: { 10: { ...conv, entries } },
      })

      host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(
          e(
            HostStoreProviders,
            { value: store },
            e(ConversationTimeline, {
              conversation: conv,
              detailEntries: entries,
              onRequestEdit: () => {},
            }),
          ),
        )
      })

      // 进视口前：均停留在占位态，未触发任何 fetchBlob 请求，也未挂载 .code-block-wrap 完整代码块
      assert.equal(fetchedUrls.length, 0, '视口外媒体与附件未触发任何 artifact fetch')
      assert.ok(host.querySelector('.attachment-image-thumb') === null)
      assert.ok(host.querySelector('.lazy-mount') !== null, '代码块处于 LazyMount 占位')
      assert.ok(host.querySelector('.lazy-mount-inline') !== null, '附件与内联媒体处于内联 LazyMount 占位')

      // 逐个触发近视口相交：附件图片和内联媒体才触发 fetchBlob
      for (const io of FakeIntersectionObserver.instances) {
        const entriesToDeliver = [...io.targets].map((target) => ({ target, isIntersecting: true }))
        if (entriesToDeliver.length > 0) {
          await act(async () => {
            io.deliver(entriesToDeliver)
          })
        }
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      assert.ok(fetchedUrls.some((u) => u.includes('att-img-1')), '进入近视口后触发附件图片 fetch')
      assert.ok(fetchedUrls.some((u) => u.includes('art-inline-1')), '进入近视口后触发内联媒体 fetch')
      assert.ok(host.querySelector('.code-block-wrap') !== null, '进入近视口后挂载真实 CodeBlockRenderer')

      // MarkdownView 单独验证无 Wrapper 残留（挂载后释放占位容器）
      const mdHtml = host.querySelector('.msg-ai-body')?.innerHTML ?? ''
      assert.ok(!mdHtml.includes('lazy-mount'), '挂载完成后 LazyMount 直接透传 children')
    } finally {
      globalThis.fetch = origFetch
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
      FakeIntersectionObserver.instances = prevInstances
    }
  })
})
