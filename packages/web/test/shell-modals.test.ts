import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ConversationSummary,
  Profile,
  SidebarItemSpec,
  SkillSummary,
} from '@helmx/protocol'
import { resolveTargetString } from '../src/lib/types.js'
import {
  ARCHIVED_TAG,
  archiveConversationTags,
  isConversationArchived,
  restoreConversationTags,
} from '../src/conversation/archive-model.js'
import {
  type AgentStanding,
  activeConversationIdsOf,
  buildAgentStandings,
  collectEnabledPluginIds,
  conversationStatusBadgeClass,
  conversationStatusDotClass,
  conversationStatusLabel,
  conversationStatusTooltip,
  extractSidebarViews,
  filterConversationsByTag,
  filterDeletableConversations,
  fuzzyMatchConversations,
  getConversationPresence,
  isConversationArchivable,
  isConversationBulkDeletable,
  isConversationBulkSelectable,
  isConversationDeletable,
  isHumanSelectableProfile,
  isProfileVisible,
  isSkillVisible,
  partitionSidebarUi,
  resolveSidebarTargetPresence,
} from '../src/shell/sidebar-model.js'
import { buildArchivedOverviewCards } from '../src/overview/overview-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore as makeHostTestStore, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'


const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { Sidebar } = await import('../src/shell/Sidebar.js')

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const conversations: ConversationSummary[] = [
  conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
  conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent', ownedBy: 'helmx' }),
  conv({ id: 3, title: '巡检看门狗', profileId: 'watchdog', ownedBy: 'helmx' }),
  conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
  conv({ id: 11, title: '代码审查随手记', profileId: 'assistant' }),
  conv({ id: 20, title: 'Worker: 重构内核', profileId: 'coder', parentConversationId: 2, tags: ['worker'], ownedBy: 'helmx', status: 'working' }),
  conv({ id: 21, title: 'Worker: 修复测试', profileId: 'coder', parentConversationId: 2, tags: ['worker'], ownedBy: 'helmx', status: 'blocked' }),
  conv({ id: 30, title: 'Worker: 旧任务', profileId: 'coder', parentConversationId: 2, tags: ['worker', 'worker-archived'], ownedBy: 'helmx' }),
  conv({ id: 40, title: '重构方案讨论', profileId: 'coder' }),
]

const sidebarItems: Array<{ pluginId: string; spec: SidebarItemSpec }> = [
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'hub', label: 'SuperAgent 中枢', icon: 'network', target: 'conversation:profile:superagent', order: 10 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'watchdog', label: '巡检看门狗', icon: 'shield', target: 'conversation:profile:watchdog', order: 11 },
  },
  {
    pluginId: 'builtin:profile',
    spec: { id: 'root', label: '个人助理', icon: 'sparkles', target: 'conversation:1', order: 0 },
  },
  {
    pluginId: 'builtin:superagent',
    spec: { id: 'recall', label: '记忆与订阅图谱', icon: 'git-fork', target: 'screen:builtin:superagent/recall-graph', order: 12 },
  },
  {
    pluginId: 'builtin:triggers',
    spec: { id: 'triggers', label: '触发器', icon: 'zap', target: 'screen:builtin:triggers/overview', order: 40 },
  },
]

const profiles: Profile[] = [
  { id: 'assistant', name: '个人助理' },
  { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent' },
  { id: 'watchdog', name: '巡检看门狗', managedByPlugin: 'builtin:superagent' },
  { id: 'coder', name: '编码专员' },
]

const plugins = [
  { id: 'builtin:profile', enabled: true },
  { id: 'builtin:superagent', enabled: true },
  { id: 'builtin:triggers', enabled: true },
]

function standingsInput(overrides?: Partial<Parameters<typeof buildAgentStandings>[0]>) {
  return {
    profiles,
    conversations,
    plugins,
    sidebarItems,
    // 中文功能夹具均为纯字符串 LocalizedText：'en' 解析原样透传，断言不受 locale 影响。
    locale: 'en' as const,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Agent 站位：每个 Agent 一个固定站位 + 下挂各自历史对话
// ---------------------------------------------------------------------------

test('buildAgentStandings 生成独立的一级 Agent 站位（个人助理 / 中枢 / 看门狗 / 专家）', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.deepEqual(
    standings.map((s) => s.profileId),
    ['assistant', 'superagent', 'watchdog', 'coder'],
  )
  const assistant = standings[0]!
  assert.equal(assistant.label, '个人助理')
  assert.equal(assistant.order, 0)
  assert.equal(assistant.canCreateConversation, true)
  const hub = standings[1]!
  assert.equal(hub.label, 'SuperAgent 中枢')
  assert.equal(hub.canCreateConversation, true)
  const watchdog = standings[2]!
  assert.equal(watchdog.label, '巡检看门狗')
  assert.equal(watchdog.canCreateConversation, true)
  const coder = standings[3]!
  assert.equal(coder.label, '编码专员')
  assert.equal(coder.canCreateConversation, true)
})

test('buildAgentStandings：人类在 assistant 下新建的对话归集到其站位，#1 置顶其余倒序', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  const assistant = standings.find((s) => s.profileId === 'assistant')!
  assert.deepEqual(assistant.conversations.map((c) => c.id), [1, 11, 10])
  assert.equal(assistant.primaryConversation?.id, 1)
})

test('buildAgentStandings：中枢/看门狗常驻会话（ownedBy=helmx）挂在各自单例站位下', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.deepEqual(
    standings.find((s) => s.profileId === 'superagent')!.conversations.map((c) => c.id),
    [2],
  )
  assert.deepEqual(
    standings.find((s) => s.profileId === 'watchdog')!.conversations.map((c) => c.id),
    [3],
  )
})

test('buildAgentStandings：ownedBy=helmx 后台会话不混入普通 Agent 站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  const coder = standings.find((s) => s.profileId === 'coder')!
  // #20/#21/#30 为 ownedBy='helmx'：不混入 coder 人类对话列表；仅人类自由会话 #40 挂载。
  assert.deepEqual(coder.conversations.map((c) => c.id), [40])
})

test('buildAgentStandings：screen: 类型 sidebar.item 不混入 Agent 站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(standingsInput())
  assert.equal(standings.some((s) => s.label === '记忆与订阅图谱'), false)
  assert.equal(standings.some((s) => s.label === '触发器'), false)
})

test('buildAgentStandings：插件停用后其 managedByPlugin 站位与 ownedBy=helmx 会话自动隐藏', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      plugins: [
        { id: 'builtin:profile', enabled: true },
        { id: 'builtin:triggers', enabled: true },
      ],
      sidebarItems: [sidebarItems[2]!],
    }),
  )
  // superagent 停用：中枢/看门狗 Profile 不可见 -> 站位消失，其 ownedBy=helmx 常驻会话也不泄露；assistant/coder 保留。
  assert.deepEqual(
    standings.map((s) => s.profileId),
    ['assistant', 'coder'],
  )
  assert.equal(standings.some((s) => s.conversations.some((c) => c.id === 2 || c.id === 3)), false)
  assert.equal(standings.some((s) => s.conversations.some((c) => c.tags.includes('worker'))), false)
})

test('buildAgentStandings：Profile 已删的人类历史对话生成孤儿兜底站位，绝不丢失', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      conversations: [
        conv({ id: 1, profileId: 'assistant' }),
        conv({ id: 70, title: '旧专家话题', profileId: 'deleted-expert' }),
      ],
      sidebarItems: [sidebarItems[2]!],
    }),
  )
  const orphan = standings.find((s) => s.profileId === 'deleted-expert')!
  assert.equal(orphan.label, 'deleted-expert')
  assert.equal(orphan.order, 200)
  assert.equal(orphan.canCreateConversation, false)
  assert.deepEqual(orphan.conversations.map((c) => c.id), [70])
  assert.equal(orphan.primaryConversation?.id, 70)
})

test('buildAgentStandings：资产未加载时按真实会话的 profileId 展示，不编造默认 Profile', { timeout: 60_000 }, () => {
  const input = { profiles: [], plugins: [], sidebarItems: [], locale: 'en' as const }
  const standings = buildAgentStandings({
    ...input,
    conversations: [conv({ id: 80, profileId: 'loading-profile' })],
  })
  assert.equal(standings.length, 1)
  assert.equal(standings[0]!.profileId, 'loading-profile')
  assert.equal(standings[0]!.label, 'loading-profile')
  assert.equal(standings[0]!.canCreateConversation, false)
  assert.equal(standings[0]!.primaryConversation?.id, 80)
  assert.deepEqual(buildAgentStandings({ ...input, conversations: [] }), [])
})

test('buildAgentStandings：assistant 站位排序由 sidebar.item pinMeta 驱动（order:0）', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [],
    conversations: [conv({ id: 1, title: '个人助理', profileId: 'assistant' })],
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:profile', spec: { id: 'root', label: '个人助理', icon: 'sparkles', target: 'conversation:1', order: 0 } },
    ],
  })
  assert.equal(standings[0]!.label, '个人助理')
  assert.equal(standings[0]!.order, 0)
  // 站位行不渲染图标：声明式 icon 仅对 screen 视图项生效，智能体行不再消费。
  assert.equal('icon' in standings[0]!, false)
})

test('buildAgentStandings：子代理派生会话（有父链）不挂 Agent 站位', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings(
    standingsInput({
      conversations: [
        conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent', ownedBy: 'helmx' }),
        conv({ id: 21, profileId: 'superagent', parentConversationId: 2, tags: ['worker'], ownedBy: 'helmx' }),
        conv({ id: 22, profileId: 'assistant', parentConversationId: 1 }),
      ],
      sidebarItems: [sidebarItems[0]!, sidebarItems[2]!],
    }),
  )
  const hub = standings.find((s) => s.profileId === 'superagent')!
  assert.deepEqual(hub.conversations.map((c) => c.id), [2])
  const assistant = standings.find((s) => s.profileId === 'assistant')!
  assert.equal(assistant.conversations.some((c) => c.id === 22), false)
})

test('人工归档 tags 幂等保留其他标签，恢复只移除 archived', { timeout: 60_000 }, () => {
  const tags = ['important', 'worker-note']
  assert.equal(ARCHIVED_TAG, 'helmx:archived')
  assert.deepEqual(archiveConversationTags(tags), [...tags, ARCHIVED_TAG])
  assert.deepEqual(archiveConversationTags([...tags, ARCHIVED_TAG]), [...tags, ARCHIVED_TAG])
  assert.deepEqual(restoreConversationTags([...tags, ARCHIVED_TAG, ARCHIVED_TAG]), tags)
  assert.equal(isConversationArchived(conv({ id: 1, tags: [ARCHIVED_TAG] })), true)
  assert.equal(isConversationArchivable(conv({ id: 1 })), true)
  assert.equal(isConversationArchivable(conv({ id: 2, parentConversationId: 1 })), false)
  assert.equal(isConversationArchivable(conv({ id: 3, ownedBy: 'helmx' })), false)
})

test('批量管理勾选口径：人类根会话全放开，空闲自动化根会话仅放开删除', { timeout: 60_000 }, () => {
  // 人类根会话：归档与删除都放开（含 working 态——单行删除同款语义）
  assert.equal(isConversationArchivable(conv({ id: 1, status: 'working' })), true)
  assert.equal(isConversationBulkDeletable(conv({ id: 1, status: 'working' })), true)
  // 空闲自动化历史会话（如已结束的 swarm worker）：仅放开批量删除
  assert.equal(isConversationArchivable(conv({ id: 2, ownedBy: 'helmx', status: 'idle' })), false)
  assert.equal(isConversationBulkDeletable(conv({ id: 2, ownedBy: 'helmx', status: 'idle' })), true)
  assert.equal(isConversationBulkDeletable(conv({ id: 3, ownedBy: 'helmx', status: 'done' })), true)
  // 在途自动化会话绝不放开（working/blocked）
  assert.equal(isConversationBulkDeletable(conv({ id: 4, ownedBy: 'helmx', status: 'working' })), false)
  assert.equal(isConversationBulkDeletable(conv({ id: 5, ownedBy: 'helmx', status: 'blocked' })), false)
  // 子会话：两个口径都不放开
  assert.equal(isConversationBulkDeletable(conv({ id: 6, parentConversationId: 1, status: 'idle' })), false)
  // 勾选口径 = 归档 ∪ 批量删除
  assert.equal(isConversationBulkSelectable(conv({ id: 8, ownedBy: 'helmx', status: 'idle' })), true)
  assert.equal(isConversationBulkSelectable(conv({ id: 9, parentConversationId: 1 })), false)
})

test('buildArchivedOverviewCards 只展示人类已归档根会话并按创建时间稳定排序', { timeout: 60_000 }, () => {
  const archived = [
    conv({ id: 1, profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 100 }),
    conv({ id: 2, profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 300 }),
    conv({ id: 3, profileId: 'assistant', tags: [ARCHIVED_TAG], parentConversationId: 1 }),
    conv({ id: 4, profileId: 'assistant', tags: [ARCHIVED_TAG], ownedBy: 'helmx' }),
    conv({ id: 6, profileId: 'assistant' }),
  ]
  const cards = buildArchivedOverviewCards({
    conversations: archived,
    background: new Map(),
    profiles: [{ id: 'assistant', name: '个人助理' }],
    plugins: [],
  })
  assert.deepEqual(cards.map((item) => item.root.id), [2, 1])
  assert.equal(cards[0]?.profileLabel, '个人助理')
  assert.equal(cards[1]?.descendants.length, 1, '已归档根会话保留其子会话供展开查看')
  assert.equal(buildAgentStandings({
    locale: 'en',
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: archived,
    plugins: [],
  })[0]?.conversations.some((item) => item.id === 1), false)
})

test('buildAgentStandings：按 createdAt 倒序（updatedAt 推进不重排）；被 sidebar.item 指向的会话置顶', { timeout: 60_000 }, () => {
  const sameTime: ConversationSummary[] = [
    conv({ id: 1, profileId: 'assistant' }),
    conv({ id: 10, profileId: 'assistant', createdAt: 5000, updatedAt: 5000 }),
    // #11 模拟 AI 正在输出：updatedAt 远大于创建时间，但位置仍由 createdAt 决定
    conv({ id: 11, profileId: 'assistant', createdAt: 5000, updatedAt: 99999 }),
  ]
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [{ id: 'assistant', name: '个人助理' }],
    conversations: sameTime,
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [
      { pluginId: 'builtin:profile', spec: { id: 'pin-10', label: '置顶话题', target: 'conversation:10' } },
    ],
  })
  // #10 被 sidebar.item 指向置顶 -> 其余（含 #1）按 createdAt 倒序、同刻按 id 倒序（无根会话特判）
  assert.deepEqual(standings[0]!.conversations.map((c) => c.id), [10, 11, 1])
})

// ---------------------------------------------------------------------------
// 视图分流：extractSidebarViews
// ---------------------------------------------------------------------------

test('extractSidebarViews 提取 screen: 导航项并按 order 排序，不混入 Agent 站位', { timeout: 60_000 }, () => {
  const views = extractSidebarViews(sidebarItems, conversations, 'en')
  assert.deepEqual(
    views.map((v) => v.key),
    ['builtin:superagent/recall', 'builtin:triggers/triggers'],
  )
  const recall = views[0]!
  assert.equal(recall.label, '记忆与订阅图谱')
  assert.equal(recall.icon, 'git-fork')
  assert.equal(recall.order, 12)
  assert.deepEqual(recall.target, { kind: 'screen', pluginId: 'builtin:superagent', screenId: 'recall-graph' })
  const triggers = views[1]!
  assert.deepEqual(triggers.target, { kind: 'screen', pluginId: 'builtin:triggers', screenId: 'overview' })
})

test('extractSidebarViews：无 icon 的视图项兜底 panel-right 图标', { timeout: 60_000 }, () => {
  const views = extractSidebarViews(
    [{ pluginId: 'p', spec: { id: 'x', label: 'X', target: 'screen:p/home' } }],
    [],
    'en',
  )
  assert.equal(views[0]!.icon, 'panel-right')
})

test('LocalizedText 侧栏显示名：站位 pin label 与视图 label 均按 locale 解析', { timeout: 60_000 }, () => {
  const items = [
    // 会话指向型 sidebar.item：pin label 覆盖站位默认展示名（LocalizedText 地图）
    {
      pluginId: 'builtin:profile',
      spec: { id: 'root', label: { en: 'Assistant', 'zh-CN': '个人助理' }, target: 'conversation:1', order: 0 },
    },
    // screen: 视图项 label（LocalizedText 地图）
    {
      pluginId: 'builtin:superagent',
      spec: { id: 'recall', label: { en: 'Recall graph', 'zh-CN': '召回图谱' }, target: 'screen:builtin:superagent/recall-graph' },
    },
    // 纯字符串 label 任意 locale 原样
    { pluginId: 'builtin:triggers', spec: { id: 'triggers', label: '触发器', target: 'screen:builtin:triggers/overview' } },
  ]
  const conversations = [conv({ id: 1, title: '根会话', profileId: 'assistant' })]
  const zhStandings = buildAgentStandings({
    ...standingsInput({ conversations, sidebarItems: items }),
    locale: 'zh-CN',
  })
  assert.equal(zhStandings.find((s) => s.profileId === 'assistant')?.label, '个人助理')
  const enStandings = buildAgentStandings({
    ...standingsInput({ conversations, sidebarItems: items }),
    locale: 'en',
  })
  assert.equal(enStandings.find((s) => s.profileId === 'assistant')?.label, 'Assistant')

  const zhViews = extractSidebarViews(items, conversations, 'zh-CN')
  assert.equal(zhViews.find((v) => v.key === 'builtin:superagent/recall')?.label, '召回图谱')
  assert.equal(zhViews.find((v) => v.key === 'builtin:triggers/triggers')?.label, '触发器')
  const enViews = extractSidebarViews(items, conversations, 'en')
  assert.equal(enViews.find((v) => v.key === 'builtin:superagent/recall')?.label, 'Recall graph')
})

test('partitionSidebarUi 提取 profile / 会话置顶去重规则', { timeout: 60_000 }, () => {
  const partition = partitionSidebarUi(sidebarItems)
  assert.deepEqual([...partition.pinnedProfileIds].sort(), ['superagent', 'watchdog'])
  assert.deepEqual([...partition.pinnedConversationIds], [1])
})

test('partitionSidebarUi 跳过 conversation:tag: 前缀目标', { timeout: 60_000 }, () => {
  const partition = partitionSidebarUi([
    { pluginId: 'p', spec: { id: 'x', label: 'X', target: 'conversation:tag:worker' } },
  ])
  assert.equal(partition.pinnedConversationIds.size, 0)
  assert.equal(partition.pinnedProfileIds.size, 0)
})

test('filterConversationsByTag 按 filterTag 过滤分组会话', { timeout: 60_000 }, () => {
  const workers = filterConversationsByTag(conversations, 'worker')
  assert.deepEqual(workers.map((c) => c.id), [20, 21, 30])
  const archived = filterConversationsByTag(conversations, 'worker-archived')
  assert.deepEqual(archived.map((c) => c.id), [30])
})

test('filterConversationsByTag 仅按 filterTag 过滤（不匹配的标签不扩容）', { timeout: 60_000 }, () => {
  const runs = [
    conv({ id: 1, tags: ['worker'], createdAt: 100 }),
    conv({ id: 2, tags: ['worker'], createdAt: 300 }),
    conv({ id: 3, tags: ['worker-done'], createdAt: 500 }),
    conv({ id: 4, tags: [] }),
  ]
  assert.deepEqual(filterConversationsByTag(runs, 'worker').map((c) => c.id), [1, 2])
})

test('fuzzyMatchConversations 按标题、profileId 与纯数字 id 过滤', { timeout: 60_000 }, () => {
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '周末').map((c) => c.id),
    [10],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, 'coder').map((c) => c.id),
    [20, 21, 30, 40],
  )
  assert.deepEqual(
    fuzzyMatchConversations(conversations, '20').map((c) => c.id),
    [20],
  )
  assert.deepEqual(fuzzyMatchConversations(conversations, ''), [])
})

test('conversationStatusLabel / BadgeClass 覆盖五态', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusLabel('working'), 'Running')
  assert.equal(conversationStatusLabel('blocked'), 'Awaiting confirmation')
  assert.equal(conversationStatusLabel('done'), 'Completed')
  assert.equal(conversationStatusLabel('idle'), 'Idle')
  assert.equal(conversationStatusLabel('error'), 'Error')
  assert.equal(conversationStatusBadgeClass('working'), 'badge badge-accent')
  assert.equal(conversationStatusBadgeClass('blocked'), 'badge badge-warn')
  assert.equal(conversationStatusBadgeClass('done'), 'badge badge-ok')
  assert.equal(conversationStatusBadgeClass('error'), 'badge badge-err')
  assert.equal(conversationStatusBadgeClass('idle'), 'badge badge-neutral')
})

test('conversationStatusDotClass 仅对非 idle 状态返回圆点类名', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusDotClass('idle'), null)
  assert.equal(conversationStatusDotClass('working'), 'status-dot status-dot-working')
  assert.equal(conversationStatusDotClass('blocked'), 'status-dot status-dot-blocked')
  assert.equal(conversationStatusDotClass('done'), 'status-dot status-dot-done')
  assert.equal(conversationStatusDotClass('error'), 'status-dot status-dot-error')
})

test('conversationStatusTooltip 生成准确悬停提示', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusTooltip('idle'), 'Idle')
  assert.equal(conversationStatusTooltip('blocked'), 'Awaiting confirmation')
  assert.equal(conversationStatusTooltip('done'), 'Completed')
  assert.equal(conversationStatusTooltip('error'), 'Error')
  assert.equal(conversationStatusTooltip('working'), 'Running')
  assert.equal(conversationStatusTooltip('working', '正在分析代码'), 'Running: 正在分析代码')
})

test('resolveTargetString conversation:profile: 优先无父链常驻会话，不做标签硬编码', { timeout: 60_000 }, () => {
  const convs: ConversationSummary[] = [
    conv({ id: 2, title: 'SuperAgent 中枢', profileId: 'superagent' }),
    // 同 profile 的派生 Worker（有 parentConversationId），不应被常驻指向命中
    conv({ id: 20, title: 'Worker: 重构内核', profileId: 'superagent', tags: ['whatever'], parentConversationId: 2 }),
  ]
  assert.deepEqual(resolveTargetString('conversation:profile:superagent', convs), {
    kind: 'conversation',
    conversationId: 2,
  })

  // 只有派生会话时兜底取第一个（不返回 null）
  const onlyDerived = [convs[1]!]
  assert.deepEqual(resolveTargetString('conversation:profile:superagent', onlyDerived), {
    kind: 'conversation',
    conversationId: 20,
  })

  // 标签名不参与判定：无 worker 标签但有父链的会话同样不算常驻
  const noTagDerived = conv({ id: 21, profileId: 'superagent', parentConversationId: 2 })
  const residentLater = conv({ id: 22, profileId: 'superagent' })
  assert.deepEqual(
    resolveTargetString('conversation:profile:superagent', [noTagDerived, residentLater]),
    { kind: 'conversation', conversationId: 22 },
  )
})



// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

test('isProfileVisible：仅依据 managedByPlugin 字段过滤（不按 id 猜归属），任意插件 id 同样生效', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:profile'])
  const plain: Profile = { id: 'coder', name: '编码' }
  // 无字段的同名 Profile 不猜隐藏（用户自建同 id 资产）
  const hubNoMeta: Profile = { id: 'superagent', name: 'SuperAgent 中枢' }
  const managed = new Set<string>(['builtin:profile', 'builtin:superagent'])
  const hubManaged: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent' }
  // 任意第三方插件的托管资产同样按字段过滤（验证不依赖特定插件 id）
  const thirdParty: Profile = { id: 'custom-x', managedByPlugin: 'community:reporter' }
  const herdrManaged: Profile = { id: 'herdr-tool', managedByPlugin: 'builtin:herdr' }
  assert.equal(isProfileVisible(plain, disabled), true)
  assert.equal(isProfileVisible(hubNoMeta, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isProfileVisible(hubManaged, disabled), false)
  assert.equal(isProfileVisible(thirdParty, disabled), false)
  assert.equal(isProfileVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'builtin:herdr', 'community:reporter'])
  assert.equal(isProfileVisible(hubManaged, enabled), true)
  assert.equal(isProfileVisible(thirdParty, enabled), true)
  assert.equal(isProfileVisible(herdrManaged, enabled), true)
})

test('isHumanSelectableProfile：与 isProfileVisible 一致，启用插件的托管与普通 Profile 均可选', { timeout: 60_000 }, () => {
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'community:reporter'])
  const assistant: Profile = { id: 'assistant', name: '个人助理' }
  const hub: Profile = { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: 'builtin:superagent' }
  const pluginExpert: Profile = { id: 'reporter', name: '周报专员', managedByPlugin: 'community:reporter' }
  const userHubNamed: Profile = { id: 'superagent', name: '我的自定义角色' }
  const disabled = new Set<string>(['builtin:profile'])
  assert.equal(isHumanSelectableProfile(assistant, enabled), true)
  assert.equal(isHumanSelectableProfile(hub, enabled), true)
  assert.equal(isHumanSelectableProfile(pluginExpert, enabled), true)
  assert.equal(isHumanSelectableProfile(userHubNamed, enabled), true)
  assert.equal(isHumanSelectableProfile(hub, disabled), false, '停用插件的托管 Profile 不可选')
})

test('isSkillVisible：仅依据 managedByPlugin 字段过滤（任意插件 id），不按 skill id 猜', { timeout: 60_000 }, () => {
  const disabled = new Set<string>(['builtin:profile'])
  const plain: SkillSummary = { id: 'weekly-report', name: '周报', references: [] }
  // 无字段同名 skill 不猜隐藏（用户自建）
  const legacy: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [] }
  const managed = new Set<string>(['builtin:profile', 'builtin:superagent'])
  const managedPlaybooks: SkillSummary = { id: 'watchdog-playbooks', name: '巡检手册', references: [], managedByPlugin: 'builtin:superagent' }
  const herdrManaged: SkillSummary = { id: 'herdr-flow', name: 'Herdr 流程', references: [], managedByPlugin: 'builtin:herdr' }
  assert.equal(isSkillVisible(plain, disabled), true)
  assert.equal(isSkillVisible(legacy, disabled), true, '无 managedByPlugin 字段不得按 id 猜测隐藏')
  assert.equal(isSkillVisible(managedPlaybooks, disabled), false)
  assert.equal(isSkillVisible(herdrManaged, disabled), false)
  const enabled = new Set<string>(['builtin:profile', 'builtin:superagent', 'builtin:herdr'])
  assert.equal(isSkillVisible(managedPlaybooks, enabled), true)
  assert.equal(isSkillVisible(herdrManaged, enabled), true)
})

test('collectEnabledPluginIds 仅收集处于活跃运行态的插件（排除 disabled 与 enabled=true 但 status=failed/带 error）', { timeout: 60_000 }, () => {
  const ids = collectEnabledPluginIds([
    { id: 'builtin:profile', enabled: true },
    { id: 'builtin:herdr', enabled: false },
    { id: 'builtin:superagent', enabled: true, status: 'active' },
    {
      id: 'ext:dep-failed',
      enabled: true,
      status: 'failed',
      error: { code: 'plugin_dependency_not_enabled', message: 'dep off', stage: 'enable' },
    },
    {
      id: 'ext:error-only',
      enabled: true,
      error: { code: 'plugin_enable_failed', message: 'boom', stage: 'enable' },
    },
  ])
  assert.deepEqual([...ids].sort(), ['builtin:profile', 'builtin:superagent'])
  assert.equal(isProfileVisible({ id: 'p-fail', name: 'Fail', managedByPlugin: 'ext:dep-failed' }, ids), false)
  assert.equal(isSkillVisible({ id: 's-fail', name: 'FailSkill', references: [], managedByPlugin: 'ext:dep-failed' }, ids), false)
  assert.equal(isProfileVisible({ id: 'p-ok', name: 'Ok', managedByPlugin: 'builtin:superagent' }, ids), true)
})

// ---------------------------------------------------------------------------
// 会话可删除性判断：isConversationDeletable & filterDeletableConversations
// ---------------------------------------------------------------------------

test('isConversationDeletable 正确判定会话是否允许人类删除', { timeout: 60_000 }, () => {
  // 初始会话（#1）无 id 级豁免：与普通人类会话同样可删
  assert.equal(isConversationDeletable({ id: 1 }), true)
  assert.equal(isConversationDeletable({ id: 1, ownedBy: 'human' }), true)

  // 机器/自动化会话：运行中/阻塞中/未知状态禁删，终态（idle/done/error）允许删除
  assert.equal(isConversationDeletable({ id: 3, ownedBy: 'helmx' }), false)
  assert.equal(isConversationDeletable({ id: 4, ownedBy: 'helmx', status: 'working' }), false)
  assert.equal(isConversationDeletable({ id: 5, ownedBy: 'helmx', status: 'blocked' }), false)
  assert.equal(isConversationDeletable({ id: 6, ownedBy: 'helmx', status: 'idle' }), true)
  assert.equal(isConversationDeletable({ id: 7, ownedBy: 'helmx', status: 'done' }), true)
  assert.equal(isConversationDeletable({ id: 8, ownedBy: 'helmx', status: 'error' }), true)

  // 普通人类会话（无 ownedBy 或 ownedBy === 'human'）允许删除
  assert.equal(isConversationDeletable({ id: 10 }), true)
  assert.equal(isConversationDeletable({ id: 11, ownedBy: 'human' }), true)
})

test('filterDeletableConversations 过滤出可删除会话', { timeout: 60_000 }, () => {
  const sample = [
    conv({ id: 1, title: '初始会话' }), // 无 id 级豁免 -> true
    conv({ id: 2, title: '运行中自动化', ownedBy: 'helmx', status: 'working' }), // working helmx -> false
    conv({ id: 3, title: '待审批自动化', ownedBy: 'helmx', status: 'blocked' }), // blocked helmx -> false
    conv({ id: 4, title: '已结束自动化', ownedBy: 'helmx', status: 'done' }), // settled helmx -> true
    conv({ id: 10, title: '人类会话1' }), // true
    conv({ id: 11, title: '人类会话2', ownedBy: 'human' }), // true
  ]

  const deletable = filterDeletableConversations(sample)
  assert.deepEqual(
    deletable.map((c) => c.id),
    [1, 4, 10, 11],
  )
})

// ---------------------------------------------------------------------------
// 侧栏分屏在场/焦点推导纯函数
// ---------------------------------------------------------------------------

test('resolveSidebarTargetPresence / getConversationPresence 覆盖单屏、分屏双开、焦点切换与同目标双开', { timeout: 60_000 }, () => {
  // 1) 单屏模式（splitTarget === null）
  const singleStore = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: null,
    focusedPanel: 'primary' as const,
  }
  assert.deepEqual(getConversationPresence(singleStore, 1), {
    inPrimary: true,
    inSplit: false,
    active: true,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })
  assert.deepEqual(getConversationPresence(singleStore, 10), {
    inPrimary: false,
    inSplit: false,
    active: false,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })

  // 2) 分屏双开不同会话（focusedPanel 缺省兜底 primary -> 再切换至 split）
  const splitPrimaryFocus = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'conversation' as const, conversationId: 10 },
    focusedPanel: 'primary' as const,
  }
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 1), {
    inPrimary: true,
    inSplit: false,
    active: true,
    splitSecondary: false,
    focused: true,
    paneTag: 'Main',
  })
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 10), {
    inPrimary: false,
    inSplit: true,
    active: false,
    splitSecondary: true,
    focused: false,
    paneTag: 'Split',
  })
  assert.deepEqual(getConversationPresence(splitPrimaryFocus, 99), {
    inPrimary: false,
    inSplit: false,
    active: false,
    splitSecondary: false,
    focused: false,
    paneTag: null,
  })

  const splitSecondaryFocus = {
    ...splitPrimaryFocus,
    focusedPanel: 'split' as const,
  }
  assert.deepEqual(getConversationPresence(splitSecondaryFocus, 1), {
    inPrimary: true,
    inSplit: false,
    active: false,
    splitSecondary: true,
    focused: false,
    paneTag: 'Main',
  })
  assert.deepEqual(getConversationPresence(splitSecondaryFocus, 10), {
    inPrimary: false,
    inSplit: true,
    active: true,
    splitSecondary: false,
    focused: true,
    paneTag: 'Split',
  })

  // 3) 同目标双开：主屏与分屏均为同一会话 -> paneTag 为 'Main·Split'，两焦点下均 active+focused
  for (const focusedPanel of ['primary', 'split'] as const) {
    const sameConvStore = {
      primaryTarget: { kind: 'conversation' as const, conversationId: 10 },
      splitTarget: { kind: 'conversation' as const, conversationId: 10 },
      focusedPanel,
    }
    assert.deepEqual(getConversationPresence(sameConvStore, 10), {
      inPrimary: true,
      inSplit: true,
      active: true,
      splitSecondary: false,
      focused: true,
      paneTag: 'Main·Split',
    })
  }

  // 4) 混合分屏：主屏会话 + 分屏待命页，自定义 matches 验证 resolveSidebarTargetPresence
  const mixedSplitStore = {
    primaryTarget: { kind: 'conversation' as const, conversationId: 1 },
    splitTarget: { kind: 'agent' as const, profileId: 'coder' },
    focusedPanel: 'split' as const,
  }
  assert.deepEqual(
    resolveSidebarTargetPresence(mixedSplitStore, (t) => t.kind === 'agent'),
    {
      inPrimary: false,
      inSplit: true,
      active: true,
      splitSecondary: false,
      focused: true,
      paneTag: 'Split',
    },
  )
  assert.deepEqual(
    resolveSidebarTargetPresence(mixedSplitStore, (t) => t.kind === 'conversation' && t.conversationId === 1),
    {
      inPrimary: true,
      inSplit: false,
      active: false,
      splitSecondary: true,
      focused: false,
      paneTag: 'Main',
    },
  )
})

test('activeConversationIdsOf 收集主分屏活跃会话 ID', { timeout: 60_000 }, () => {
  assert.deepEqual(
    Array.from(activeConversationIdsOf({ primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null })),
    [1],
  )
  assert.equal(
    activeConversationIdsOf({ primaryTarget: { kind: 'models' }, splitTarget: null }).size,
    0,
  )
  assert.deepEqual(
    Array.from(
      activeConversationIdsOf({
        primaryTarget: { kind: 'conversation', conversationId: 1 },
        splitTarget: { kind: 'conversation', conversationId: 40 },
      }),
    ),
    [1, 40],
  )
  assert.deepEqual(
    Array.from(
      activeConversationIdsOf({
        primaryTarget: { kind: 'conversation', conversationId: 40 },
        splitTarget: { kind: 'agent', profileId: 'assistant' },
      }),
    ),
    [40],
  )
})

// ---------------------------------------------------------------------------
// 侧边栏批量管理与批量删除逻辑
// ---------------------------------------------------------------------------

/** 批量管理用宿主 store（真实 external store；沿用本文件历史默认数据）。 */
function makeTestStore(partial: TestStoreOverrides = {}): HelmxExternalStore {
  return makeHostTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 10, title: '用户会话1', profileId: 'assistant' }),
      conv({ id: 11, title: '用户会话2', profileId: 'assistant' }),
    ],
    plugins: [{ id: 'builtin:profile', name: '个人助理', locked: true, enabled: true, hooks: [], actions: [], tools: [] }],
    profiles: [{ id: 'assistant', name: '个人助理' }],
    models: [
      {
        id: 'zhipu/glm-4.6',
        provider: 'zhipu',
        modelId: 'glm-4.6',
        available: true,
        thinkingLevels: ['off', 'low', 'high'],
      },
    ],
    ...partial,
  })
}

test('批量选择状态计算：全选、反选与单选切换', { timeout: 60_000 }, () => {
  const standings = buildAgentStandings({
    locale: 'en',
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '代码助手' },
    ],
    conversations: [
      conv({ id: 1, title: '根会话', profileId: 'assistant' }),
      conv({ id: 10, title: '会话 10', profileId: 'assistant' }),
      conv({ id: 11, title: '会话 11', profileId: 'assistant' }),
      conv({ id: 21, title: '系统中枢', profileId: 'coder', ownedBy: 'helmx', status: 'working' }),
      conv({ id: 22, title: '会话 22', profileId: 'coder' }),
    ],
    plugins: [{ id: 'builtin:profile', enabled: true }],
    sidebarItems: [],
  })

  // 提取所有智能体站位下的可删除会话
  const allConvs = standings.flatMap((a) => a.conversations)
  const allDeletableIds = filterDeletableConversations(allConvs).map((c) => c.id)

  // 应该包含 1, 10, 11, 22（初始会话无豁免；排除 helmx 拥有的会话）
  assert.deepEqual(allDeletableIds.sort((a, b) => a - b), [1, 10, 11, 22])

  let selectedIds = new Set<number>()
  const isAllSelected = (ids: Set<number>) =>
    allDeletableIds.length > 0 && allDeletableIds.every((id) => ids.has(id))

  // 初始为空
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 0)

  // 单选 10
  selectedIds = new Set(selectedIds).add(10)
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 1)

  // 全选
  selectedIds = new Set(allDeletableIds)
  assert.equal(isAllSelected(selectedIds), true)
  assert.equal(selectedIds.size, 4)

  // 清空
  selectedIds = new Set()
  assert.equal(isAllSelected(selectedIds), false)
  assert.equal(selectedIds.size, 0)
})

test('批量删除导航契约：Sidebar 不做二次导航，回退统一由 Provider 删除管道负责', { timeout: 60_000 }, () => {
  // 批量删除状态机统一抽至 use-batch-conversation-delete.ts，验证共享 hook 与 Sidebar 均不做二次导航。
  const batchHookSource = readFileSync(
    new URL('../src/shell/use-batch-conversation-delete.ts', import.meta.url),
    'utf8',
  )
  const batchStart = batchHookSource.indexOf('const executeBatchDelete')
  const batchEnd = batchHookSource.indexOf('return {', batchStart)
  assert.ok(batchStart > 0 && batchEnd > batchStart, 'executeBatchDelete 存在')
  const batchBody = batchHookSource.slice(batchStart, batchEnd)
  // 删除导航唯一 truth：成功 SSE conversation.deleted 事件 → Provider 按当前目标条件回退；
  // 批量删除钩子与 Sidebar 不再基于旧快照/selectedIds 二次跳转（旧实现会连失败项一起跳走）。
  assert.doesNotMatch(batchBody, /openTarget/, '批量删除不得在删除钩子内导航')
  assert.doesNotMatch(batchBody, /closeSplit/, '批量删除不得在删除钩子内关分屏')
  assert.match(batchBody, /bulkDeleteConversations/, '批量删除仍发起真实删除请求（单次 bulk-delete 端点）')
  const overviewSource = readFileSync(
    new URL('../src/overview/ConversationOverview.tsx', import.meta.url),
    'utf8',
  )
  assert.match(overviewSource, /useBatchConversationDelete/, '总览大盘复用共享批量删除钩子')
  const sidebarListSource = readFileSync(
    new URL('../src/shell/SidebarConversationList.tsx', import.meta.url),
    'utf8',
  )
  assert.match(sidebarListSource, /useBatchConversationDelete/, '侧栏工作集复用共享批量删除钩子')
})

test('删除回退仿真：主屏/分屏/抽屉命中被删会话时回该智能体待命态', { timeout: 60_000 }, () => {
  // 与 Provider conversation.deleted 管道同一决策函数形状：仅命中当前目标才回退，
  // 待命目标继承被删会话的 profileId/nodeId/cwd（远端坐标不回落本机）。
  function simulateFallback(
    deleted: { id: number; profileId: string; nodeId?: string; cwd?: string },
    primaryTarget: { kind: string; conversationId?: number },
    splitTarget: { kind: string; conversationId?: number } | null,
    drawerConversationId: number | null,
  ) {
    const primaryHit = primaryTarget.kind === 'conversation' && primaryTarget.conversationId === deleted.id
    const splitHit = splitTarget?.kind === 'conversation' && splitTarget.conversationId === deleted.id
    const drawerHit = drawerConversationId === deleted.id
    const fallback = {
      kind: 'agent',
      profileId: deleted.profileId,
      ...(deleted.nodeId !== undefined && deleted.nodeId !== '' && deleted.nodeId !== 'local' ? { nodeId: deleted.nodeId } : {}),
      ...(deleted.cwd !== undefined && deleted.cwd !== '' ? { cwd: deleted.cwd } : {}),
    }
    return {
      primary: primaryHit ? fallback : primaryTarget,
      splitClosed: splitHit,
      drawerClosed: drawerHit,
    }
  }

  // 场景 1：主屏会话 10（远端）被删：回待命态并继承节点与目录
  const r1 = simulateFallback(
    { id: 10, profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' },
    { kind: 'conversation', conversationId: 10 },
    null,
    null,
  )
  assert.deepEqual(r1.primary, { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })

  // 场景 2：分屏会话 11 被删：只关分屏，主屏不动
  const r2 = simulateFallback(
    { id: 11, profileId: 'assistant' },
    { kind: 'conversation', conversationId: 1 },
    { kind: 'conversation', conversationId: 11 },
    null,
  )
  assert.deepEqual(r2.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(r2.splitClosed, true)

  // 场景 3：被删的不是当前目标：不重定向
  const r3 = simulateFallback(
    { id: 10, profileId: 'assistant' },
    { kind: 'conversation', conversationId: 1 },
    { kind: 'conversation', conversationId: 99 },
    null,
  )
  assert.deepEqual(r3.primary, { kind: 'conversation', conversationId: 1 })
  assert.equal(r3.splitClosed, false)
  assert.equal(r3.drawerClosed, false)
})

test('SSR 渲染回归：Sidebar 渲染顶栏总览/分组栏新话题/工作集与极简无 Emoji 验证', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // 顶栏总览与分组栏新话题/批量管理入口，工作集过滤按钮；默认不展开批量操作栏，双模式分段器已移除
  assert.ok(html.includes('sidebar-overview-open-btn'), '应渲染顶栏会话总览按钮')
  assert.ok(!html.includes('sidebar-conv-primary-nav'), '旧顶置一级导航区已收敛')
  assert.ok(html.includes('sidebar-new-topic-btn'), '应渲染新话题入口')
  assert.ok(html.includes('aria-label="Filter conversations"'), '应渲染工作集过滤按钮')
  assert.ok(html.includes('aria-label="Manage conversations in bulk"'), '侧栏工作集分组栏应渲染批量管理开关')
  assert.ok(!html.includes('sidebar-batch-bar'), '未开启批量模式时不渲染侧栏批量操作栏')
  assert.ok(!html.includes('sidebar-conv-mode-switch'), '双模式分段器已移除')

  // 极简无 Emoji 铁律验证
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u
  assert.ok(!EMOJI_RE.test(html), 'Sidebar 渲染输出全程不得包含任何 Emoji')
  assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊字符')
})

test('Sidebar 状态圆点渲染验证：工作集各态圆点与提示', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
      conv({ id: 2, title: '任务 A', profileId: 'assistant', status: 'working', doing: '正在思考方案', updatedAt: 6000 }),
      conv({ id: 10, title: '空闲 E', profileId: 'assistant', status: 'idle', updatedAt: 2000 }),
      conv({ id: 20, title: '代码重构', profileId: 'coder', status: 'working', doing: '重构中' }),
      conv({ id: 21, title: '审批 B', profileId: 'reviewer', status: 'blocked' }),
      conv({ id: 22, title: '异常 C', profileId: 'auditor', status: 'error' }),
      conv({ id: 23, title: '完成 D', profileId: 'reporter', status: 'done', unread: true }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
      { id: 'reviewer', name: '审阅专员' },
      { id: 'auditor', name: '审计专员' },
      { id: 'reporter', name: '报告专员' },
    ],
  })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // 1) idle 不产生任何圆点（conversationStatusDotClass 对 idle 返回 null）
  assert.ok(!html.includes('status-dot-idle'), 'idle 会话不得渲染状态圆点')

  // 2) working 圆点带 doing 提示与无障碍属性
  assert.ok(html.includes('class="status-dot status-dot-working"'), '应渲染 working 圆点')
  assert.ok(html.includes('title="Running: 正在思考方案"'), 'working 圆点应带 doing 提示')
  assert.ok(html.includes('aria-label="Running: 正在思考方案"'), '圆点应带 aria-label')
  assert.ok(html.includes('role="status"'), '圆点应带 role=status')

  // 3) blocked / error / unread done 圆点
  assert.ok(html.includes('class="status-dot status-dot-blocked"'), '应渲染 blocked 圆点')
  assert.ok(html.includes('title="Awaiting confirmation"'), 'blocked 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-error"'), '应渲染 error 圆点')
  assert.ok(html.includes('title="Error"'), 'error 圆点提示')
  assert.ok(html.includes('class="status-dot status-dot-done"'), '应渲染 unread done 圆点')
  assert.ok(html.includes('title="Completed"'), 'done 圆点提示')
  assert.ok(html.includes('title="Running: 重构中"'), '工作集行圆点带 tooltip')
})

// ---------------------------------------------------------------------------
// 双层导航：Activity Rail + Context Sidebar
// ---------------------------------------------------------------------------

test('Sidebar 双层导航：Activity Rail 空间切换与系统中心直达（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  // Rail 结构：三空间切换 + 主题按钮均带 aria-label；系统中心入口收敛到设置空间列表
  assert.ok(html.includes('activity-rail'), '应渲染 Activity Rail 容器')
  assert.ok(html.includes('aria-label="Conversations space"'), '对话空间按钮')
  assert.ok(html.includes('aria-label="Views space"'), '视图空间按钮')
  assert.ok(html.includes('aria-label="Settings space"'), '设置空间按钮')
  assert.ok(!html.includes('activity-rail-centers'), 'Rail 不再直接渲染系统中心图标')
  assert.ok(html.includes('aria-label="System"'), '主题按钮')

  // 默认对话空间：渲染工作集分组；视图/设置空间内容不渲染
  assert.ok(html.includes('sidebar-overview-group'), '对话空间渲染工作集分组')
  assert.ok(!html.includes('>视图</div>'), '默认不渲染视图空间分组')
  assert.ok(!html.includes('settings-nav'), '默认不渲染设置空间分组')

  // 默认收起筛选栏：渲染筛选切换按钮与全局搜索按钮，无多余常驻搜索输入
  assert.ok(html.includes('aria-label="Filter conversations"'), '渲染工作集筛选开关按钮')
  assert.ok(!html.includes('sidebar-search-input'), '默认收起筛选栏，不常驻渲染搜索输入框')
  assert.ok(
    html.includes('aria-label="Open global search and command palette (Ctrl+K)"') ||
      html.includes('aria-label="Open global search and command palette (⌘K)"'),
    '全局搜索与命令面板按钮保留并携带平台快捷键',
  )

  // 底栏已移除：系统中心入口收敛到设置空间；changelog 入口住在 Activity Rail 底部（主题钮下方）
  assert.ok(!html.includes('sidebar-footer'), '底栏容器已移除')
  assert.ok(html.includes('sidebar-changelog-toggle'), 'Rail 底部存在 changelog 入口')
})

test('Sidebar 设置空间：系统中心纵向列表与激活高亮（SSR）', { timeout: 60_000 }, () => {
  const store = makeTestStore({ primaryTarget: { kind: 'models' } })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  assert.ok(html.includes('settings-nav'), '设置空间渲染系统中心列表')
  for (const label of ['Profile', 'Models &amp; credentials', 'Skills', 'Compute nodes', 'Plugin Center']) {
    assert.ok(html.includes(`>${label}</span>`), `设置列表项 ${label}`)
  }
  const idx = html.indexOf('>Models &amp; credentials</span>')
  assert.ok(idx > 0 && html.lastIndexOf('nav-item-active', idx) > 0, '模型与凭据为激活项')
  assert.ok(!html.includes('sidebar-overview-group'), '设置空间不渲染工作集分组')
})

test('Sidebar 会话态 vs 待命态高亮（SSR）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '个人助理', profileId: 'assistant' }),
    conv({ id: 10, title: '周末计划', profileId: 'assistant' }),
    conv({ id: 11, title: '代码审查', profileId: 'assistant' }),
  ]
  const profiles = [{ id: 'assistant', name: '个人助理' }]

  // 1) 进会话态：当前会话行唯一点亮，新话题按钮不亮
  const convStore = makeTestStore({ conversations, profiles })
  const convHtml = renderToString(e(HostStoreProviders, { value: convStore }, e(Sidebar)))
  assert.ok(convHtml.includes('sidebar-overview-item sidebar-overview-item-quiet nav-item-active'), '当前会话行唯一点亮')
  assert.ok(!convHtml.includes('sidebar-new-topic-btn is-active'), '会话态新话题行不点亮')

  // 2) 待命态 #/a/assistant：新话题入口点亮，工作集内任何会话行均不点亮
  const standbyStore = makeTestStore({
    conversations,
    profiles,
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
  })
  const standbyHtml = renderToString(e(HostStoreProviders, { value: standbyStore }, e(Sidebar)))
  assert.ok(standbyHtml.includes('sidebar-new-topic-btn is-active'), '待命态新话题入口点亮')
  assert.ok(!standbyHtml.includes('sidebar-overview-item-quiet nav-item-active'), '待命态任何会话行均不点亮')
})

test('Sidebar 分屏混开 SSR 回归：主屏会话 + 分屏待命且聚焦分屏时高亮与主/分微标准确呈现', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '主屏会话', profileId: 'assistant' }),
      conv({ id: 40, title: '编码历史', profileId: 'coder' }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'agent', profileId: 'coder' },
    focusedPanel: 'split',
  })
  const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))

  assert.ok(html.includes('sidebar-overview-item-quiet nav-item-split'), '主屏非聚焦会话行呈分屏在场态')
  assert.ok(html.includes('<span class="nav-pane-tag" title="Open in main view">Main</span>'), '主屏会话行带「主」微标')
  assert.ok(html.includes('sidebar-new-topic-btn is-active nav-item-focused'), '分屏聚焦的待命新话题入口点亮并带焦点态')
  const newTopicBtnStart = html.indexOf('sidebar-new-topic-btn is-active nav-item-focused')
  const newTopicBtnHtml = html.slice(newTopicBtnStart, html.indexOf('>', newTopicBtnStart))
  assert.ok(newTopicBtnHtml.includes('aria-current="page"'), '分屏聚焦的待命新话题按钮带 aria-current="page"')
})

test('ToastOverlay：悬停或聚焦暂停自动关闭计时器，移开后恢复自动关闭', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const { HelmxExternalStore } = await import('../src/lib/helmx-store.js')
  const { parseLocationHash } = await import('../src/lib/url-hash-model.js')
  const { ToastOverlay } = await import('../src/shell/ToastOverlay.js')
  const { waitFor } = await import('@helmx/test-kit')

  const store = new HelmxExternalStore(parseLocationHash('#/c/1'), { infoNoticeDurationMs: 90 })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(ToastOverlay)))
    })
    await act(async () => {
      store.pushNotice({ type: 'notification', level: 'info', title: 'Build finished', body: 'All green' })
    })
    const toastEl = container.querySelector<HTMLElement>('.toast-item')
    assert.ok(toastEl !== null, 'toast renders immediately')

    // Mouse enter pauses auto-dismiss past the original 90ms window
    await act(async () => {
      toastEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 140))
    assert.equal(store.getNotices().length, 1, 'hovering keeps toast alive past its auto-dismiss duration')

    // Mouse leave resumes the timer and dismisses the toast
    await act(async () => {
      toastEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    await waitFor(() => store.getNotices().length === 0, { timeoutMs: 2000, intervalMs: 15 })
    assert.ok(container.querySelector('.toast-item') === null, 'toast disappears after hover ends')
  } finally {
    store.dispose()
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('SplitResizeHandle & split-ratio-model：拖拽、双击重置、键盘步进与持久化夹逼', { timeout: 60_000 }, async () => {
  const { act, useRef, useState } = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const {
    clampSplitRatio,
    DEFAULT_SPLIT_RATIO,
    loadSplitRatio,
    MAX_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
    saveSplitRatio,
    SPLIT_RATIO_STORAGE_KEY,
    stepSplitRatio,
  } = await import('../src/shell/split-ratio-model.js')
  const { SplitResizeHandle } = await import('../src/ui/SplitResizeHandle.js')

  // Pure model bounds and storage persistence
  assert.equal(clampSplitRatio(Number.NaN), DEFAULT_SPLIT_RATIO)
  assert.equal(clampSplitRatio(0.1), MIN_SPLIT_RATIO)
  assert.equal(clampSplitRatio(0.95), MAX_SPLIT_RATIO)
  assert.equal(stepSplitRatio(0.5, 0.05), 0.55)
  assert.equal(stepSplitRatio(MIN_SPLIT_RATIO, -0.1), MIN_SPLIT_RATIO)

  const mem = new Map<string, string>()
  const fakeStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
  }
  assert.equal(loadSplitRatio(fakeStorage), DEFAULT_SPLIT_RATIO)
  assert.equal(saveSplitRatio(0.62, fakeStorage), 0.62)
  assert.equal(mem.get(SPLIT_RATIO_STORAGE_KEY), '0.62')
  assert.equal(loadSplitRatio(fakeStorage), 0.62)

  // Interactive DOM harness
  const committed: number[] = []
  let draggingState = false
  function Harness() {
    const ref = useRef<HTMLDivElement | null>(null)
    const [ratio, setRatio] = useState(DEFAULT_SPLIT_RATIO)
    return e(
      'div',
      { ref, className: 'helmx-panes has-split', style: { width: '1000px' } },
      e(SplitResizeHandle, {
        ratio,
        containerRef: ref,
        onChange: setRatio,
        onCommit: (next: number) => {
          setRatio(next)
          committed.push(next)
        },
        onDraggingChange: (d: boolean) => {
          draggingState = d
        },
      }),
    )
  }

  const store = makeTestStore({ locale: 'en' })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(Harness)))
    })
    const panes = container.querySelector<HTMLDivElement>('.helmx-panes')
    const handle = container.querySelector<HTMLDivElement>('.helmx-split-resizer')
    assert.ok(panes !== null && handle !== null)
    panes.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    assert.equal(handle.getAttribute('role'), 'separator')
    assert.equal(handle.getAttribute('aria-orientation'), 'vertical')
    assert.equal(handle.getAttribute('aria-valuenow'), '50')

    // Pointer drag to 650px (0.65)
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 500 }))
    })
    assert.equal(draggingState, true)
    assert.equal(handle.getAttribute('data-dragging'), 'true')
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 650 }))
    })
    assert.equal(handle.getAttribute('aria-valuenow'), '65')
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 650 }))
    })
    assert.equal(draggingState, false)
    assert.equal(committed[committed.length - 1], 0.65)

    // Keyboard stepping & reset
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    assert.equal(handle.getAttribute('aria-valuenow'), '60')
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    })
    assert.equal(handle.getAttribute('aria-valuenow'), '28')
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    assert.equal(handle.getAttribute('aria-valuenow'), '72')

    // Double-click resets to 50%
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    assert.equal(handle.getAttribute('aria-valuenow'), '50')
    assert.equal(committed[committed.length - 1], DEFAULT_SPLIT_RATIO)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})



