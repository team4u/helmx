import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol'
import { createWebTranslator } from '../src/i18n/catalog.js'
import {
  buildConversationOutline,
  buildMarkdownOutline,
  countOutlineTurns,
  extractMarkdownHeadings,
  filterOutlineNodes,
  resolveActiveOutlineEntryId,
  stripInlineMarkdown,
  summarizeOutlineText,
} from '../src/conversation/outline-model.js'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import { resetServerClock } from '../src/lib/server-clock.js'
import { flushMacrotask } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'

const enT = createWebTranslator('en')

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationOutlinePopover } = await import('../src/conversation/ConversationOutlinePopover.js')
const e = React.createElement

let root: Root | undefined
let host: HTMLElement | undefined
describe("conversation-outline", () => {


  afterEach(() => {
    if (root !== undefined) act(() => root?.unmount())
    root = undefined
    host?.remove()
    host = undefined
    document.body.innerHTML = ''
    resetServerClock()
  })

  // ---------------------------------------------------------------------------
  // 1. outline-model 纯函数测试
  // ---------------------------------------------------------------------------

  test('stripInlineMarkdown 与 summarizeOutlineText：清理行内格式、取首个非空行并回退附件计数', { timeout: 60_000 }, () => {
    assert.equal(stripInlineMarkdown('**加粗** 与 `code` 及 [链接](https://example.com)'), '加粗 与 code 及 链接')
    assert.equal(summarizeOutlineText('\n\n# 第一行标题\n第二行正文', 0, enT), '第一行标题')
    assert.equal(summarizeOutlineText('- 列表首项\n第二行', 0, enT), '列表首项')
    assert.equal(summarizeOutlineText('   ', 2, enT), '[attachment ×2]')
    assert.equal(summarizeOutlineText('', 0, enT), '(empty message)')
  })

  test('buildMarkdownOutline：为 Markdown H1~H3 生成稳定定位节点', { timeout: 60_000 }, () => {
    assert.deepEqual(buildMarkdownOutline('# 总览\n\n## 安装\n\n### 验证\n#### 细节'), [
      { kind: 'heading', key: 'outline:markdown:0', entryId: 'markdown-preview', headingIndex: 0, level: 1, text: '总览' },
      { kind: 'heading', key: 'outline:markdown:1', entryId: 'markdown-preview', headingIndex: 1, level: 2, text: '安装' },
      { kind: 'heading', key: 'outline:markdown:2', entryId: 'markdown-preview', headingIndex: 2, level: 3, text: '验证' },
    ])
  })

  test('extractMarkdownHeadings：提取 H1~H3 并严格跳过代码块围栏内的 # 注释', { timeout: 60_000 }, () => {
    const md = [
      '# 架构总览',
      '一些介绍文字',
      '```bash',
      '# 这是 bash 注释，绝不能当成标题',
      'echo "hello"',
      '```',
      '## 核心模块 `kernel`',
      '~~~python',
      '## python comment',
      '~~~',
      '### 1. 状态机设计 ###',
      '> ### 引用中的章节',
      '#### H4 粒度过细不提取',
    ].join('\n')

    const headings = extractMarkdownHeadings(md)
    assert.deepEqual(headings, [
      { level: 1, text: '架构总览' },
      { level: 2, text: '核心模块 kernel' },
      { level: 3, text: '1. 状态机设计' },
      { level: 3, text: '引用中的章节' },
    ])
  })

  test('buildConversationOutline 与 filterOutlineNodes：构建完整树、支持关键词过滤与父提问保留', { timeout: 60_000 }, () => {
    const entries: ConversationEntry[] = [
      { id: '1', kind: 'helmx.input', data: { id: 'in-1', text: '帮我分析数据库慢查询\n附上日志', origin: 'human' }, createdAt: 1000 },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '# 慢查询根因\n\n## 索引缺失分析\n正文内容' }],
          },
        ],
      },
      { id: '3', kind: 'pi.reset', data: { handoff: '已重置' } },
      { id: '4', kind: 'helmx.input', data: { id: 'in-2', text: '接下来优化 Redis 缓存策略', origin: 'human' }, createdAt: 2000 },
      {
        id: '5',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '## 缓存过期与淘汰策略' }],
          },
        ],
      },
    ]

    const items = buildTimelineItems(entries)
    const nodes = buildConversationOutline(items, undefined, enT)

    assert.equal(countOutlineTurns(nodes), 2)
    assert.deepEqual(
      nodes.map((n) => (n.kind === 'human' ? `Q#${n.turnIndex}:${n.label}` : n.kind === 'heading' ? `H${n.level}:${n.text}` : n.kind === 'divider' ? `D:${n.divider}` : `${n.kind}:${n.label}`)),
      [
        'Q#1:帮我分析数据库慢查询',
        'H1:慢查询根因',
        'H2:索引缺失分析',
        'D:reset',
        'Q#2:接下来优化 Redis 缓存策略',
        'H2:缓存过期与淘汰策略',
      ],
    )

    // 仅看提问模式：过滤掉所有助手子节点（正文/标题/卡片）与非人工输入，保留 human 与 divider
    const questionsOnly = filterOutlineNodes(nodes, { mode: 'questions' })
    assert.deepEqual(
      questionsOnly.map((n) => n.kind),
      ['human', 'divider', 'human'],
    )

    // 对话模式：保留人工提问、助手正文、Markdown 标题与分割线
    const dialogueOnly = filterOutlineNodes(nodes, { mode: 'dialogue' })
    assert.deepEqual(
      dialogueOnly.map((n) => n.kind),
      ['human', 'heading', 'heading', 'divider', 'human', 'heading'],
    )

    // 搜索子标题 "索引缺失"：自动保留所属父提问 Q#1
    const byHeading = filterOutlineNodes(nodes, { query: '索引缺失' })
    assert.deepEqual(
      byHeading.map((n) => (n.kind === 'human' ? `Q#${n.turnIndex}` : n.kind === 'heading' ? n.text : n.kind)),
      ['Q#1', '索引缺失分析'],
    )

    // 搜索全文（第二行 "附上日志" 虽然不在首行 label 中，但仍在 fullText 中可搜到）
    const byFullText = filterOutlineNodes(nodes, { query: '附上日志' })
    assert.equal(byFullText.length, 1)
    assert.equal(byFullText[0]?.kind, 'human')
    assert.equal(byFullText[0]?.entryId, '1')

    // 按轮次号 "#2" 精确匹配第 2 轮提问
    const byTurnTag = filterOutlineNodes(nodes, { query: '#2' })
    assert.equal(byTurnTag.length, 1)
    assert.equal(byTurnTag[0]?.entryId, '4')
  })

  test('buildConversationOutline：pending=true 的精简分割线标注为「正在精简上下文…」，已落库精简仍为「上下文已精简」', { timeout: 60_000 }, () => {
    const entries: ConversationEntry[] = [
      { id: '1', kind: 'helmx.input', data: { id: 'in-1', text: '旧问题', origin: 'human' }, createdAt: 1000 },
      { id: '2', kind: 'pi.compaction', model: [{ role: 'user', content: '摘要' }] },
    ]
    const items = buildTimelineItems(entries, { compacting: true })
    const nodes = buildConversationOutline(items, undefined, enT)
    const dividers = nodes.filter((n) => n.kind === 'divider')
    assert.equal(dividers.length, 2)
    assert.equal(dividers[0]!.label, 'Context compacted')
    assert.equal(dividers[1]!.label, 'Compacting context…')
    assert.equal(dividers[1]!.entryId, 'compacting:live')
  })

  test('resolveActiveOutlineEntryId：按滚动基准线推导当前激活条目', { timeout: 60_000 }, () => {
    assert.equal(resolveActiveOutlineEntryId([]), undefined)
    // 全部在基准线下方（刚在顶部）时取首项
    assert.equal(
      resolveActiveOutlineEntryId([
        { entryId: '1', top: 120 },
        { entryId: '2', top: 400 },
      ], 96),
      '1',
    )
    // 取最后一个已越过基准线（top <= 96）的锚点
    assert.equal(
      resolveActiveOutlineEntryId([
        { entryId: '1', top: -320 },
        { entryId: '2', top: 40 },
        { entryId: '4', top: 260 },
      ], 96),
      '2',
    )
  })

  // ---------------------------------------------------------------------------
  // 2. ConversationPane 大纲浮层 DOM 交互与滚动定位测试
  // ---------------------------------------------------------------------------

  function makeConv(id: number): ConversationSummary {
    return {
      id,
      title: '长对话压测',
      profileId: 'assistant',
      tags: [],
      ownedBy: 'human',
      cwd: '/tmp',
      model: 'faux/model',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 2,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1000,
      updatedAt: 2000,
    }
  }

  test('ConversationPane 顶栏渲染大纲按钮，打开浮层后支持搜索过滤与点击滚动定位目标消息/章节', { timeout: 60_000 }, async () => {
    const conv = makeConv(10)
    const entries: ConversationEntry[] = [
      { id: '101', kind: 'helmx.input', data: { id: 'q1', text: '第一个问题：如何配置节点隧道？', origin: 'human' }, createdAt: 1000 },
      {
        id: '102',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '# 隧道配置指南\n正文一\n## 端口转发命令\n正文二' }],
          },
        ],
      },
      { id: '103', kind: 'helmx.input', data: { id: 'q2', text: '第二个问题：如何排查插件加载失败？', origin: 'human' }, createdAt: 2000 },
      {
        id: '104',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '排查步骤如下。' }],
          },
        ],
      },
    ]

    const store = makeTestStore({
      conversations: [conv],
      conversationDetails: {
        10: { ...conv, entries },
      },
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 10 })))
    })

    // 1. 顶栏出现「大纲」触发按钮且角标显示 2 轮提问
    const triggerBtn = document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')
    assert.ok(triggerBtn, '会话非空时顶栏应渲染大纲按钮')
    assert.match(triggerBtn.textContent ?? '', /Outline/)
    assert.match(triggerBtn.textContent ?? '', /2/)

    // 2. 点击展开大纲 Popover
    await act(async () => {
      triggerBtn.click()
    })
    const popover = document.querySelector<HTMLElement>('.conversation-outline-popover')
    assert.ok(popover, '点击后应展开会话大纲浮层')

    const options = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
    assert.equal(options.length, 5, '应渲染 2 条提问 + 2 条 Markdown 标题 + 1 条助手正文摘要（无标题回合）')

    // 3. 点击第 2 个标题（H2 端口转发命令，对应 entryId=102, headingIndex=1）触发精准滚动
    const scrolledElements: HTMLElement[] = []
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () {
      scrolledElements.push(this)
    }

    try {
      const h2Option = options.find((btn) => (btn.textContent ?? '').includes('端口转发命令'))
      assert.ok(h2Option, '大纲列表应包含「端口转发命令」H2 标题项')
      await act(async () => {
        h2Option.click()
      })

      // 点击后浮层关闭，且目标 H2 元素被 scrollIntoView，所属回合包装容器获得 entry-highlighted 高亮类
      assert.ok(scrolledElements.length > 0, '点击大纲项应触发 scrollIntoView')
      const lastScrolled = scrolledElements[scrolledElements.length - 1]!
      assert.equal(lastScrolled.tagName.toLowerCase(), 'h2', '点击子标题应精确滚动到对应 <h2> DOM 节点')
      assert.match(lastScrolled.textContent ?? '', /端口转发命令/)

      const turnWrapper = host.querySelector<HTMLElement>('[data-entry-id="102"]')
      assert.ok(turnWrapper?.className.includes('entry-highlighted'), '目标回合容器应触发 entry-highlighted 高亮动效')
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
    }
  })

  test('ConversationPane 大纲业务卡节点：tool.view 卡经 cardId 二级锚精确定位卡片 DOM，plugin-card 按 entryId 定位', { timeout: 60_000 }, async () => {
    // 机制信号替身：宿主注册表命中 subagent 工具与背景汇报 renderer（零插件特判）；
    // 预置插件 client 模块缓存并以同 hash fetch 探测命中缓存（不落网络）。
    seedPluginClientModule('builtin:workflow', 'index.tsx', {
      SubagentToolView: () => e('div', { className: 'stub-subagent-card' }, 'subagent stub'),
      BackgroundReportCard: () => e('div', { className: 'stub-report-card' }, 'report stub'),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { headers: { 'x-helmx-client-hash': 'seeded' } })
    const conv = makeConv(11)
    const entries: ConversationEntry[] = [
      { id: '201', kind: 'helmx.input', data: { id: 'q1', text: '派子代理调研Outline现状', origin: 'human' }, createdAt: 1000 },
      {
        id: '202',
        kind: 'pi.assistant',
        model: [
          { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { prompt: '调研Outline现状' } }] },
        ],
      },
      {
        id: '203',
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent', content: [{ type: 'text', text: '完成' }] }],
      },
      {
        id: '204',
        kind: 'helmx.input',
        data: {
          id: 'in-204',
          text: '后台子代理任务已结算。以下为运行 abc123 的结果数据。',
          origin: 'agent',
          whenBusy: 'followUp',
          meta: { renderer: 'workflow:background-report', backgroundRunId: 'abc123', kind: 'subagent_report' },
        },
        createdAt: 3000,
      },
    ]

    const store = makeTestStore({
      conversations: [conv],
      conversationDetails: { 11: { ...conv, entries } },
      uiContributions: [
        { pluginId: 'builtin:workflow', surface: 'tool.view', spec: { id: 'subagent-card', toolNames: ['subagent'], replaceRow: true, client: { module: 'index.tsx', export: 'SubagentToolView' } } },
        {
          pluginId: 'builtin:workflow',
          surface: 'timeline.renderer',
          spec: { id: 'background-report', kinds: ['helmx.input'], matchMeta: { renderer: 'workflow:background-report' }, client: { module: 'index.tsx', export: 'BackgroundReportCard' } },
        },
      ],
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 11 })))
    })

    // 时间线：顶层 tool.view 业务卡携带 data-outline-card-id 二级锚
    const cardTrace = host.querySelector<HTMLElement>('[data-outline-card-id="tool:call-1"]')
    assert.ok(cardTrace, '顶层 tool.view 卡片 DOM 应携带 data-outline-card-id 二级锚')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')!.click()
    })
    // 大纲默认以「对话」模式打开：过滤业务卡与 agent/trigger 输入，仅保留人工提问
    const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-mode .segmented-control-btn')]
    assert.deepEqual(
      modeButtons.map((btn) => btn.textContent?.trim()),
      ['Conversation', 'Questions only', 'All'],
    )
    assert.equal(modeButtons[0]?.getAttribute('aria-pressed'), 'true', '默认激活「对话」模式')
    const dialogueOptions = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
    assert.deepEqual(
      dialogueOptions.map((btn) => btn.className.match(/conversation-outline-(human|assistant|heading|card|divider)/)?.[1]),
      ['human'],
      '「对话」模式默认过滤业务卡，仅保留人工提问',
    )

    // 切换到「全部」模式以查看并跳转业务卡节点
    const allModeBtn = modeButtons.find((btn) => btn.textContent?.trim() === 'All')
    assert.ok(allModeBtn, '应提供「全部」切换按钮')
    await act(async () => {
      allModeBtn.click()
    })
    const options = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
    assert.deepEqual(
      options.map((btn) => btn.className.match(/conversation-outline-(human|assistant|heading|card|divider)/)?.[1]),
      ['human', 'card', 'card'],
      '「全部」模式应包含提问 + subagent 业务卡 + 背景汇报卡（无空 assistant 节点）',
    )

    const scrolledElements: HTMLElement[] = []
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () {
      scrolledElements.push(this)
    }
    try {
      // 1. 点击 subagent 业务卡：经 cardId 二级锚精确滚动到卡片 trace 元素，回合容器高亮
      const subagentOption = options.find((btn) => (btn.textContent ?? '').includes('subagent：调研Outline现状'))
      assert.ok(subagentOption, '大纲应包含 subagent 业务卡节点（toolName + 入参摘要）')
      await act(async () => {
        subagentOption.click()
      })
      const lastScrolled = scrolledElements[scrolledElements.length - 1]!
      assert.equal(lastScrolled.getAttribute('data-outline-card-id'), 'tool:call-1', '应精确滚动到二级锚标记的卡片 DOM')
      assert.ok(
        host.querySelector<HTMLElement>('[data-entry-id="202"]')?.className.includes('entry-highlighted'),
        '所属回合容器应触发 entry-highlighted 高亮',
      )

      // 2. 点击背景汇报 plugin-card：按自身 entryId 定位包装容器
      await act(async () => {
        document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')!.click()
      })
      const reportOption = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
        .find((btn) => (btn.textContent ?? '').includes('后台子代理任务已结算'))
      assert.ok(reportOption, '大纲应包含背景汇报 plugin-card 节点')
      await act(async () => {
        reportOption.click()
      })
      const reportScrolled = scrolledElements[scrolledElements.length - 1]!
      assert.equal(reportScrolled.getAttribute('data-entry-id'), '204', 'plugin-card 应按自身 entryId 定位包装容器')
      assert.ok(reportScrolled.querySelector('.stub-report-card') !== null, '定位目标内应包含插件卡片')
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
      globalThis.fetch = origFetch
    }
  })

  test('ConversationOutlinePopover 三态切换：默认「对话」过滤非人工/卡片，切「仅提问」与「全部」精准生效；showModeToggle=false 保持全量展示', { timeout: 60_000 }, async () => {
    const items = buildTimelineItems(
      [
        { id: '1', kind: 'helmx.input', data: { id: 'q1', text: '人类第一问', origin: 'human' }, createdAt: 1000 },
        {
          id: '2',
          kind: 'pi.assistant',
          model: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: '# 一级结论\n内容详情' },
                { type: 'toolCall', id: 'c1', name: 'subagent', arguments: { prompt: '执行巡检' } },
              ],
            },
          ],
        },
        {
          id: '2r',
          kind: 'pi.tool-result',
          model: [{ role: 'toolResult', toolCallId: 'c1', toolName: 'subagent', content: [{ type: 'text', text: '完成' }] }],
        },
        { id: '3', kind: 'helmx.input', data: { id: 'q2', text: '后台代理触发输入', origin: 'agent' }, createdAt: 2000 },
        { id: '4', kind: 'pi.compaction', model: [{ role: 'user', content: '摘要' }] },
      ],
      {
        toolViews: [
          { pluginId: 'builtin:workflow', spec: { id: 'subagent-card', toolNames: ['subagent'], replaceRow: true } },
        ],
      },
    )
    const nodes = buildConversationOutline(items, undefined, enT)

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const store = makeTestStore()
    await act(async () => {
      root!.render(
        e(
          (await import('./helpers/store.js')).HelmxExternalStoreContext.Provider,
          { value: store },
          e(ConversationOutlinePopover, {
            nodes,
            showModeToggle: true,
            portalled: false,
            forceMount: true,
            onSelectTarget: () => {},
          }),
        ),
      )
    })

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('.conversation-outline-trigger')!.click()
    })
    const toggleBtns = [...host.querySelectorAll<HTMLButtonElement>('.conversation-outline-mode .segmented-control-btn')]
    assert.deepEqual(toggleBtns.map((b) => b.textContent?.trim()), ['Conversation', 'Questions only', 'All'])
    assert.equal(toggleBtns[0]?.getAttribute('aria-pressed'), 'true')

    // 1. 默认「对话」：保留 人类第一问 + 一级结论 + divider（过滤 card 与 origin=agent 输入）
    const labels = (): string[] =>
      [...host!.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')].map((el) => el.textContent ?? '')
    assert.equal(labels().length, 3)
    assert.match(labels()[0]!, /人类第一问/)
    assert.match(labels()[1]!, /一级结论/)
    assert.match(labels()[2]!, /Context compacted/)

    // 2. 切换「仅提问」：仅保留 人类第一问 + divider
    await act(async () => {
      toggleBtns[1]!.click()
    })
    assert.equal(toggleBtns[1]?.getAttribute('aria-pressed'), 'true')
    assert.equal(labels().length, 2)
    assert.match(labels()[0]!, /人类第一问/)
    assert.match(labels()[1]!, /Context compacted/)

    // 3. 切换「全部」：保留 人类第一问 + 一级结论 + subagent card + agent 输入 + divider
    await act(async () => {
      toggleBtns[2]!.click()
    })
    assert.equal(toggleBtns[2]?.getAttribute('aria-pressed'), 'true')
    assert.equal(labels().length, 5)
    assert.ok(labels().some((t) => t.includes('subagent：执行巡检')))
    assert.ok(labels().some((t) => t.includes('后台代理触发输入')))

    // 4. showModeToggle=false（如文档大纲）：不渲染模式切换栏，始终全量展示（含全部标题与卡片）
    await act(async () => {
      root!.render(
        e(
          (await import('./helpers/store.js')).HelmxExternalStoreContext.Provider,
          { value: store },
          e(ConversationOutlinePopover, {
            nodes,
            showModeToggle: false,
            portalled: false,
            forceMount: true,
            onSelectTarget: () => {},
          }),
        ),
      )
    })
    assert.ok(host.querySelector('.conversation-outline-mode') === null)
    assert.equal(labels().length, 5)
  })

  test('ConversationPane 大纲当前项粒度：同一回合多个标题仅「当前读到的标题节」一个 is-current，滚动推进时随之移动且父提问不铺底色', { timeout: 60_000 }, async () => {
    // 机制替身：IO 交出「越过基线区」的包装行；滚动几何与标题位置随 scrollTop 联动（远离底部 → 固定 96px 基线）
    class FakeIO {
      static instances: FakeIO[] = []
      readonly targets = new Set<Element>()
      disconnected = false
      constructor(private readonly cb: (entries: unknown[]) => void) {
        FakeIO.instances.push(this)
      }
      observe(target: Element): void { this.targets.add(target) }
      unobserve(): void {}
      disconnect(): void { this.disconnected = true }
      deliver(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
        this.cb(entries.map((entry) => ({ ...entry, intersectionRatio: entry.isIntersecting ? 1 : 0 })))
      }
    }
    const conv = makeConv(12)
    const entries: ConversationEntry[] = [
      { id: '101', kind: 'helmx.input', data: { id: 'q1', text: '介绍内核架构', origin: 'human' }, createdAt: 1000 },
      {
        id: '102',
        kind: 'pi.assistant',
        model: [
          { role: 'assistant', content: [{ type: 'text', text: '# 微内核\n正文一\n## 插件宿主\n正文二\n## 编排引擎\n正文三' }] },
        ],
      },
      { id: '103', kind: 'helmx.input', data: { id: 'q2', text: '继续深入', origin: 'human' }, createdAt: 2000 },
      {
        id: '104',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'text', text: '后续回答\n'.repeat(600) }] }],
      },
    ]
    const store = makeTestStore({ conversations: [conv], conversationDetails: { 12: { ...conv, entries } } })
    const savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver
    const origGBCR = Element.prototype.getBoundingClientRect
    let scrollTop = 0
    const headingDocTops = new Map<Element, number>()
    try {
      host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 12 })))
      })
      const scroller = host.querySelector<HTMLElement>('.timeline-scroll')!
      const turn = host.querySelector<HTMLElement>('[data-entry-id="102"]')!
      const headings = [...turn.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2')]
      assert.equal(headings.length, 3, '回合内渲染三个标题 DOM')
      // 文档内偏移：h1=600，h2=900，h3=1300；scrollHeight=12000/视口 800 → 距底远大于 240，基线固定 96px
      headingDocTops.set(headings[0]!, 600)
      headingDocTops.set(headings[1]!, 900)
      headingDocTops.set(headings[2]!, 1300)
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 12000 })
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 800 })
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = Math.max(0, Math.min(v, 11200))
        },
      })
      Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
        const base = headingDocTops.get(this)
        if (base !== undefined) {
          const top = base - scrollTop
          return { top, bottom: top + 28, left: 0, right: 0, width: 0, height: 28, x: 0, y: top, toJSON: () => ({}) } as DOMRect
        }
        if (this === scroller) {
          return { top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
        }
        return origGBCR.call(this)
      }
      scrollTop = 810 // h1 top=-210、h2 top=90（越过）、h3 top=490（未越过）
      const io = FakeIO.instances[FakeIO.instances.length - 1]!
      const wrappers = [...host.querySelectorAll<HTMLElement>('[data-entry-id]')]
      io.deliver([
        { target: wrappers[0]!, isIntersecting: true },
        { target: wrappers[1]!, isIntersecting: true },
        { target: wrappers[2]!, isIntersecting: false },
        { target: wrappers[3]!, isIntersecting: false },
      ])
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

      // 打开浮层：当前项有且只有一个，且是第二个标题「插件宿主」；第一/第三个标题与父提问均不高亮
      await act(async () => {
        host!.querySelector<HTMLButtonElement>('.conversation-outline-trigger')!.click()
      })
      const currentItems = (): HTMLElement[] =>
        [...document.querySelectorAll<HTMLElement>('.conversation-outline-item.is-current')]
      assert.equal(currentItems().length, 1, '任何时刻至多一个 is-current（根因回归：同回合三标题不再一起高亮）')
      assert.match(currentItems()[0]!.className, /conversation-outline-heading-h2/)
      assert.match(currentItems()[0]!.textContent ?? '', /插件宿主/)

      // 下滚使第三个标题越过基线 → 当前项推进到「编排引擎」，仍只有一个
      scrollTop = 1210 // h3 top=90
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      assert.equal(currentItems().length, 1)
      assert.match(currentItems()[0]!.textContent ?? '', /编排引擎/)

      // 回到回合开头（无标题越过）→ 回退为该回合首个节点（首个标题），父提问行依旧不铺底色
      scrollTop = 0
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      assert.equal(currentItems().length, 1)
      assert.match(currentItems()[0]!.textContent ?? '', /微内核/)
      assert.equal(document.querySelectorAll('.conversation-outline-human.is-current').length, 0, '助手回合激活时父提问行不高亮')
    } finally {
      Element.prototype.getBoundingClientRect = origGBCR
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO
    }
  })

  test('ConversationPane 顶栏浮层展示创建时间/累计运行/已结算轮次/实时计时，大纲顶栏与助手行展示单轮与累计耗时', { timeout: 60_000 }, async () => {
    resetServerClock()
    const createdAt = new Date(2026, 10, 10, 14, 0, 0).getTime()
    const now = Date.now()
    const conv: ConversationSummary = {
      ...makeConv(20),
      status: 'working',
      runDurationMs: 65_000,
      runStartedAt: now - 10_100,
      completionSeq: 2,
      createdAt,
      updatedAt: now,
    }
    const entries: ConversationEntry[] = [
      { id: '1', kind: 'helmx.input', data: { id: 'q1', text: '第一轮问题', origin: 'human' }, createdAt },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            timestamp: createdAt + 1000,
            durationMs: 4200,
            content: [{ type: 'text', text: '第一轮纯正文回答。' }],
          },
        ],
      },
      { id: '3', kind: 'helmx.input', data: { id: 'q2', text: '第二轮问题', origin: 'human' }, createdAt: createdAt + 10_000 },
    ]
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 20: { ...conv, entries } },
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 20 })))
    })

    // 1. 打开顶栏标题信息浮层，校验时间观测字段
    const titleBtn = host.querySelector<HTMLButtonElement>('.pane-title-btn')
    assert.ok(titleBtn !== null)
    await act(async () => {
      titleBtn.click()
    })
    const metaGrid = document.querySelector<HTMLElement>('.pane-title-popover-meta')
    assert.ok(metaGrid !== null, 'title metadata popover opens')
    const metaText = metaGrid.textContent ?? ''
    assert.match(metaText, /创建时间/)
    assert.match(metaText, /2026-11-10 14:00:00/)
    const totalMatch = /累计运行\s*1m(\d{2})s/.exec(metaText)
    assert.ok(totalMatch !== null, `expected live cumulative duration in title metadata, got: ${metaText}`)
    const currentMatch = /当前运行\s*(\d{2})s/.exec(metaText)
    assert.ok(currentMatch !== null, `expected live current-turn duration in title metadata, got: ${metaText}`)
    const currentSec = Number(currentMatch[1])
    const totalSec = 60 + Number(totalMatch[1])
    assert.ok(currentSec >= 10 && currentSec < 30, `current run seconds out of expected live range: ${currentSec}`)
    assert.equal(totalSec, 65 + currentSec, 'cumulative duration equals settled 65s plus live current run')
    assert.match(metaText, /已结算轮次/)
    assert.match(metaText, /2/)

    // 关闭标题浮层并立即打开大纲浮层，冲刷宏任务确认标题浮层延迟 FocusScope 复位不会抢回焦点并误关大纲
    await act(async () => {
      titleBtn.click()
    })
    const outlineBtn = host.querySelector<HTMLButtonElement>('.conversation-outline-trigger')
    assert.ok(outlineBtn !== null)
    await act(async () => {
      outlineBtn.click()
    })
    await flushMacrotask()
    const summaryEl = document.querySelector<HTMLElement>('.conversation-outline-summary')
    assert.ok(summaryEl !== null, 'outline header renders cumulative summary when totalRunMs > 0')
    const outlineSummaryText = summaryEl.textContent ?? ''
    const outlineTotalMatch = /共 2 轮 · 累计 1m(\d{2})s/.exec(outlineSummaryText)
    assert.ok(outlineTotalMatch !== null, `expected cumulative summary in outline header, got: ${outlineSummaryText}`)
    const outlineTotalSec = 60 + Number(outlineTotalMatch[1])
    assert.ok(
      outlineTotalSec >= totalSec && outlineTotalSec < 95,
      `outline cumulative seconds (${outlineTotalSec}) should track live total (>= ${totalSec}, < 95)`,
    )

    const assistantDuration = document.querySelector<HTMLElement>('.conversation-outline-assistant .conversation-outline-duration')
    assert.ok(assistantDuration !== null, 'settled assistant outline row renders turn duration')
    assert.equal(assistantDuration.textContent, '4.2s')
  })

  test('ConversationPane 大纲仅索引 .msg-ai-block 直接子代 .msg-ai-body 标题，忽略嵌套卡片内的标题', { timeout: 60_000 }, async () => {
    seedPluginClientModule('builtin:workflow', 'index.tsx', {
      SubagentToolView: () =>
        e(
          'div',
          { className: 'stub-nested-md-card' },
          e('div', { className: 'msg-ai-body' }, e('h1', null, '嵌套卡片H1'), e('h2', null, '嵌套卡片H2')),
        ),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { headers: { 'x-helmx-client-hash': 'seeded' } })

    const conv = makeConv(21)
    const entries: ConversationEntry[] = [
      { id: '301', kind: 'helmx.input', data: { id: 'q1', text: '带嵌套卡片的回合', origin: 'human' }, createdAt: 1000 },
      {
        id: '302',
        kind: 'pi.assistant',
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'call-nested', name: 'subagent', arguments: { prompt: 'nested' } },
              { type: 'text', text: '# 回合主标题\n正文一\n## 回合子标题\n正文二' },
            ],
          },
        ],
      },
      {
        id: '303',
        kind: 'pi.tool-result',
        model: [{ role: 'toolResult', toolCallId: 'call-nested', toolName: 'subagent', content: [{ type: 'text', text: 'done' }] }],
      },
    ]

    const store = makeTestStore({
      conversations: [conv],
      conversationDetails: { 21: { ...conv, entries } },
      uiContributions: [
        {
          pluginId: 'builtin:workflow',
          surface: 'tool.view',
          spec: { id: 'subagent-card', toolNames: ['subagent'], replaceRow: true, client: { module: 'index.tsx', export: 'SubagentToolView' } },
        },
      ],
    })

    const scrolledElements: HTMLElement[] = []
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function () {
      scrolledElements.push(this)
    }

    try {
      host = document.createElement('div')
      document.body.appendChild(host)
      await act(async () => {
        root = createRoot(host!)
        root.render(e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 21 })))
      })

      assert.ok(host.querySelector('.stub-nested-md-card h1') !== null, '嵌套卡片内确实存在标题 DOM')

      await act(async () => {
        host!.querySelector<HTMLButtonElement>('.conversation-outline-trigger')!.click()
      })
      const options = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
      const h2Option = options.find((btn) => (btn.textContent ?? '').includes('回合子标题'))
      assert.ok(h2Option, '大纲列表应包含「回合子标题」')

      await act(async () => {
        h2Option.click()
      })
      const lastScrolled = scrolledElements[scrolledElements.length - 1]
      assert.ok(lastScrolled !== undefined, '点击大纲子标题应触发滚动')
      assert.equal(lastScrolled.textContent, '回合子标题', '必须定位到回合自身 H2，绝不能被嵌套卡片的 H1/H2 偏移错位')
    } finally {
      HTMLElement.prototype.scrollIntoView = origScrollIntoView
      globalThis.fetch = origFetch
    }
  })
})
