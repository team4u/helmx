/**
 * 会话总览与侧栏工作集纯模型测试（零 happy-dom / React 依赖，归入 pure 池）：
 * - buildOverviewCards（含安静树、桶序 + createdAt 倒序、后代芯片信号优先与截断计数、
 *   暴露边界继承态势口径、诚实摘要复用、memberIds）；
 * - filterOverviewCards / overviewBucketCounts / parseOverviewFilterParams / overviewFilterParamsRepair；
 * - groupOverviewCards / overviewShouldShowSectionHeaders；
 * - URL：#/overview 解析/序列化往返、sp./ssp. 命名空间、hashHasPrimaryTarget、对话空间归属；
 * - 时间观测纯函数（resolveOverviewCardTiming / resolveOverviewDescendantChipTiming）；
 * - 侧栏精简总览后代切片、工作集截断、分组工作集与新话题候选排序。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helmx/protocol'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import type { ConversationBackgroundIndex } from '../src/shell/conversation-status-model.js'
import {
  buildArchivedOverviewCards,
  buildOverviewCards,
  buildSidebarGroupedWorkingSet,
  buildSidebarWorkingSet,
  filterOverviewCards,
  groupOverviewCards,
  isOverviewDescendantActive,
  loadSidebarGroupBy,
  overviewBucketCounts,
  overviewDescendantMatchesQuery,
  overviewFilterParamsRepair,
  overviewNodeKey,
  overviewNodeOptions,
  overviewProfileOptions,
  overviewShouldShowSectionHeaders,
  parseOverviewFilterParams,
  resolveOverviewCardTiming,
  resolveOverviewDescendantChipTiming,
  resolveSidebarOverviewDescendants,
  resolveSidebarOverviewPrimaryTarget,
  saveSidebarGroupBy,
  OVERVIEW_DESCENDANT_LIMIT,
  SIDEBAR_DESCENDANT_AUTO_LIMIT,
  SIDEBAR_GROUP_BY_STORAGE_KEY,
  SIDEBAR_PER_GROUP_QUIET_LIMIT,
  SIDEBAR_RECENT_QUIET_LIMIT,
  type OverviewCard,
} from '../src/overview/overview-model.js'
import { buildAgentStandings, buildNewTopicCandidates } from '../src/shell/sidebar-model.js'
import { formatLocationHash, hashHasPrimaryTarget, parseLocationHash, shouldPushLocationHistory } from '../src/lib/url-hash-model.js'
import { spaceForTarget } from '../src/lib/types.js'

const enT = createWebTranslator('en')

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

function buildCards(
  conversations: ConversationSummary[],
  background: ConversationBackgroundIndex = new Map(),
  overrides: { profiles?: Array<{ id: string; name?: string; managedByPlugin?: string }>; plugins?: Array<{ id: string; enabled: boolean }> } = {},
) {
  return buildOverviewCards({
    conversations,
    background,
    profiles: overrides.profiles ?? [],
    plugins: overrides.plugins ?? [],
    t: enT,
  })
}

// ---------------------------------------------------------------------------
// 纯函数：卡片构建与排序
// ---------------------------------------------------------------------------

test('buildOverviewCards: attention trees lead, quiet trees follow; bucket order then createdAt descending', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked' }),
    conv({ id: 2, status: 'working' }),
    conv({ id: 3, status: 'done', unread: true }),
    conv({ id: 4, status: 'idle' }),
    conv({ id: 5, status: 'done', unread: false }),
  ])
  assert.deepEqual(
    cards.map((card) => [card.root.id, card.bucket]),
    [
      [1, 'needs_attention'],
      [2, 'running'],
      [3, 'unread_done'],
      [5, 'quiet'],
      [4, 'quiet'],
    ],
    'quiet trees only appear in the overview (never in the attention flat group), still createdAt-descending inside their bucket',
  )
})

test('buildOverviewCards: descendants list is signal-first and deterministic; hidden count stays honest against the view cap', { timeout: 60_000 }, () => {
  const members = [
    conv({ id: 1, createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, status: 'idle', createdAt: 9100 }),
    conv({ id: 12, parentConversationId: 1, status: 'blocked', createdAt: 9200 }),
    conv({ id: 13, parentConversationId: 1, status: 'working', createdAt: 9300 }),
    conv({ id: 14, parentConversationId: 1, status: 'idle', createdAt: 9400 }),
    conv({ id: 15, parentConversationId: 1, status: 'idle', createdAt: 9500 }),
    conv({ id: 16, parentConversationId: 1, status: 'idle', createdAt: 9600 }),
    conv({ id: 17, parentConversationId: 1, status: 'idle', createdAt: 9700 }),
  ]
  const cards = buildCards(members)
  assert.equal(cards.length, 1)
  const card = cards[0]!
  // 契约修订：descendants 携带全量确定性排序列表（信号优先 + createdAt 倒序），
  // 展示截断由视图按 OVERVIEW_DESCENDANT_LIMIT 切片，展开补齐剩余时不重排。
  assert.equal(card.descendants.length, members.length - 1)
  assert.equal(card.descendants[0]!.conv.id, 13, 'signal descendants (blocked/working) lead; within signals createdAt descending')
  assert.equal(card.descendants[1]!.conv.id, 12)
  assert.deepEqual(
    card.descendants.slice(0, OVERVIEW_DESCENDANT_LIMIT).map((d) => d.conv.id),
    [13, 12, 17, 16, 15],
    'the collapsed view slice matches the previous capped contract exactly',
  )
  assert.equal(card.hiddenDescendantCount, members.length - 1 - OVERVIEW_DESCENDANT_LIMIT)
  assert.equal(card.targetConversationId, 12, 'the direct target is the newest waiting descendant')
  assert.equal(card.summaryText, '2 sub-conversations active', 'honest summary falls back to the active descendant count')
})

test('buildOverviewCards inherits the attention exposure boundaries', { timeout: 60_000 }, () => {
  const archived = buildCards([conv({ id: 1, tags: [ARCHIVED_TAG], status: 'working' })])
  assert.equal(archived.length, 0, 'archived root trees never enter the overview')
  const hidden = buildCards([conv({ id: 2, status: 'working' })], new Map(), {
    profiles: [{ id: 'assistant', managedByPlugin: 'builtin:off' }],
    plugins: [{ id: 'builtin:off', enabled: false }],
  })
  assert.equal(hidden.length, 0, 'trees of profiles hidden behind disabled plugins stay out')
  const named = buildCards(
    [conv({ id: 3, status: 'working', profileId: 'coder' })],
    new Map(),
    { profiles: [{ id: 'coder', name: '编码专员' }] },
  )
  assert.equal(named[0]!.profileLabel, '编码专员')
})

// ---------------------------------------------------------------------------
// 纯函数：筛选
// ---------------------------------------------------------------------------

test('filterOverviewCards: bucket/profile/node AND combos; quiet only in all; local node normalization', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'blocked', profileId: 'assistant' }),
    conv({ id: 2, status: 'working', profileId: 'coder', nodeId: 'remote-1' }),
    conv({ id: 3, status: 'idle', profileId: 'coder' }),
  ])
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1, 2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'needs_attention', profileId: '', nodeId: '' }).map((c) => c.root.id),
    [1],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'all', profileId: 'coder', nodeId: '' }).map((c) => c.root.id),
    [2, 3],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'remote-1' }).map((c) => c.root.id),
    [2],
  )
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: 'coder', nodeId: 'local' }).map((c) => c.root.id),
    [],
    'nodeId local aggregates unset node ids; remote trees do not match',
  )
  assert.equal(overviewNodeKey({ nodeId: undefined }), 'local')
  assert.equal(overviewNodeKey({ nodeId: 'remote-1' }), 'remote-1')
  assert.deepEqual(overviewProfileOptions(cards).map((option) => option.id), ['assistant', 'coder'])
  assert.deepEqual(overviewNodeOptions(cards).sort(), ['local', 'remote-1'])
})

test('buildOverviewCards: memberIds carry the whole tree (root + descendants)', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, status: 'working' }),
    conv({ id: 11, parentConversationId: 1, status: 'idle' }),
    conv({ id: 3, tags: [ARCHIVED_TAG], status: 'idle' }),
    conv({ id: 4, status: 'idle' }),
  ])
  const byId = new Map(cards.map((card) => [card.root.id, card]))
  assert.deepEqual(byId.get(1)!.memberIds, [1, 11], 'memberIds carry the whole tree (root included) for the meta slot props')
  assert.deepEqual(byId.get(4)!.memberIds, [4], 'a single-member tree lists just the root')
  assert.equal(byId.has(3), false, 'archived roots never enter the overview')
  assert.equal(byId.get(1)!.automated, false)
})

test('filterOverviewCards: query matches root title, profile label, honest summary and descendant titles; ANDs with the other dimensions', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, title: '出错的重构', profileId: 'assistant', status: 'error', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
    conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
    conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
  ])
  const base = { bucket: 'all' as const, profileId: '', nodeId: '' }
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '重构' }).map((c) => c.root.id), [1], 'root title substring matches (case-insensitive)')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: 'REFACTOR' }).map((c) => c.root.id), [], 'matching is case-insensitive but never fabricates absent text')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '检索' }).map((c) => c.root.id), [2], 'the honest doing summary is searchable')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '待审批' }).map((c) => c.root.id), [1], 'descendant titles keep their tree findable')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '  ' }).map((c) => c.root.id), [1, 2, 3], 'a blank query filters nothing')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '#11' }).map((c) => c.root.id), [1], 'an exact #id form matches the descendant id')
  assert.deepEqual(filterOverviewCards(cards, { ...base, query: '2' }).map((c) => c.root.id), [2], 'a bare numeric needle matches the root id exactly, not substrings of other ids')
  assert.deepEqual(
    filterOverviewCards(cards, { bucket: 'running', profileId: '', nodeId: '', query: '调研' }).map((c) => c.root.id),
    [2],
    'query ANDs with bucket/profile/node/source',
  )
})

test('overviewBucketCounts: bucket badges count inside the profile/node/source/query context, never misleading global totals', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 1, title: '出错的重构', status: 'blocked', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 2, title: '在跑的调研', status: 'working', profileId: 'coder', createdAt: 8000, updatedAt: 8000 }),
    conv({ id: 3, title: '安静会话', status: 'idle', profileId: 'coder', createdAt: 7000, updatedAt: 7000 }),
  ])
  assert.deepEqual(
    overviewBucketCounts(cards),
    { all: 3, needs_attention: 1, running: 1, unread_done: 0, archived: 0 },
    'no context: every bucket badge reflects the full card set',
  )
  assert.deepEqual(
    overviewBucketCounts(cards, { profileId: 'coder' }),
    { all: 2, needs_attention: 0, running: 1, unread_done: 0, archived: 0 },
    'inside the coder context the needs-attention badge honestly reads zero (the assistant tree is out of context)',
  )
  assert.deepEqual(
    overviewBucketCounts(cards, { query: '安静' }),
    { all: 1, needs_attention: 0, running: 0, unread_done: 0, archived: 0 },
    'query context scopes the badges as well',
  )
  const archivedCards = buildArchivedOverviewCards({
    conversations: [
      conv({ id: 9, title: '已归档调研', profileId: 'coder', tags: [ARCHIVED_TAG], createdAt: 5000 }),
      conv({ id: 10, title: '已归档助理', profileId: 'assistant', tags: [ARCHIVED_TAG], createdAt: 4000 }),
    ],
    background: new Map(),
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    plugins: [],
  })
  assert.deepEqual(
    overviewBucketCounts(cards, { profileId: 'coder' }, archivedCards),
    { all: 2, needs_attention: 0, running: 1, unread_done: 0, archived: 1 },
    'archived count respects the active profile/node/query context without inflating all',
  )
})

test('parseOverviewFilterParams / overviewFilterParamsRepair: deep-link params parse to the canonical filter; invalid values fall back and get repaired', { timeout: 60_000 }, () => {
  assert.deepEqual(parseOverviewFilterParams(undefined), {
    bucket: 'all',
    profileId: '',
    nodeId: '',
    source: 'human',
    query: '',
    groupBy: 'status',
  }, 'no params: pure defaults (human conversations by default)')
  assert.deepEqual(parseOverviewFilterParams({ bucket: 'running', profile: 'coder', node: 'local', source: 'automated', q: '调研', group: 'profile' }), {
    bucket: 'running',
    profileId: 'coder',
    nodeId: 'local',
    source: 'automated',
    query: '调研',
    groupBy: 'profile',
  }, 'every known key parses verbatim')
  assert.equal(parseOverviewFilterParams({ source: 'all' }).source, 'all', 'source=all parses verbatim')
  assert.equal(parseOverviewFilterParams({ bucket: 'archived' }).bucket, 'archived', 'archived is a canonical bucket filter')
  assert.equal(overviewFilterParamsRepair({ bucket: 'archived' }), null, 'archived bucket requires no repair')
  assert.equal(parseOverviewFilterParams({ bucket: 'bogus' }).bucket, 'all', 'an invalid bucket value falls back to all (hash-model invalid-segment philosophy)')
  assert.equal(parseOverviewFilterParams({ bucket: 'all' }).bucket, 'all', 'the redundant all value parses as the default')
  assert.equal(parseOverviewFilterParams({ source: 'weird' }).source, 'human', 'an invalid source value falls back to human')
  assert.equal(parseOverviewFilterParams({ group: 'status' }).groupBy, 'status', 'the redundant status value parses as the default')
  assert.equal(parseOverviewFilterParams({ group: 'weird' }).groupBy, 'status', 'an invalid group value falls back to status')
  assert.equal(parseOverviewFilterParams({ group: 'node' }).groupBy, 'node')
  assert.equal(parseOverviewFilterParams({ profile: 'some-stale-id' }).profileId, 'some-stale-id', 'profile/node/q are opaque ids kept verbatim')

  assert.equal(overviewFilterParamsRepair(undefined), null, 'no params: nothing to repair')
  assert.equal(
    overviewFilterParamsRepair({ bucket: 'running', profile: 'coder', source: 'automated', q: 'x', group: 'node' }),
    null,
    'already-canonical params produce no patch (no write amplification)',
  )
  assert.deepEqual(overviewFilterParamsRepair({ bucket: 'bogus', q: 'x' }), { bucket: undefined }, 'an invalid bucket value is deleted')
  assert.deepEqual(overviewFilterParamsRepair({ bucket: 'all', source: 'human', group: 'status' }), { bucket: undefined, source: undefined, group: undefined }, 'redundant default enums are deleted')
  assert.deepEqual(overviewFilterParamsRepair({ source: 'weird' }), { source: undefined }, 'invalid source value is deleted')
  assert.deepEqual(overviewFilterParamsRepair({ group: 'invalid' }), { group: undefined }, 'invalid group value is deleted')
  assert.deepEqual(overviewFilterParamsRepair({ tab: 'runs' }), { tab: undefined }, 'unknown keys are deleted (the overview owns its sp. namespace)')
})

test('groupOverviewCards / overviewShouldShowSectionHeaders: status, profile and node groupings preserve urgency-first order and flatten redundant single-value headers', { timeout: 60_000 }, () => {
  const cards = buildCards(
    [
      conv({ id: 1, title: '卡住了', profileId: 'assistant', status: 'blocked', createdAt: 9000 }),
      conv({ id: 2, title: '在跑', profileId: 'coder', nodeId: 'remote-1', status: 'working', createdAt: 8000 }),
      conv({ id: 3, title: '未读完', profileId: 'coder', status: 'done', unread: true, createdAt: 7000 }),
      conv({ id: 4, title: '安静', profileId: 'assistant', status: 'idle', createdAt: 6000 }),
    ],
    new Map(),
    {
      profiles: [
        { id: 'assistant', name: '个人助理' },
        { id: 'coder', name: '编码专员' },
      ],
    },
  )

  const byStatus = groupOverviewCards(cards, 'status', enT)
  assert.deepEqual(
    byStatus.map((g) => [g.key, g.label, g.cards.map((c) => c.root.id)]),
    [
      ['bucket:needs_attention', 'Needs attention', [1]],
      ['bucket:running', 'Running', [2]],
      ['bucket:unread_done', 'Unread completed', [3]],
      ['bucket:quiet', 'Idle', [4]],
    ],
  )
  assert.deepEqual(
    groupOverviewCards(cards.filter((c) => c.bucket !== 'unread_done'), 'status', enT).map((g) => g.key),
    ['bucket:needs_attention', 'bucket:running', 'bucket:quiet'],
    'empty buckets are omitted completely',
  )

  // profile grouping orders profiles by first appearance (urgency-first) and keeps per-profile bucket/createdAt order
  const byProfile = groupOverviewCards(cards, 'profile', enT)
  assert.deepEqual(
    byProfile.map((g) => [g.key, g.label, g.cards.map((c) => c.root.id)]),
    [
      ['profile:assistant', '个人助理', [1, 4]],
      ['profile:coder', '编码专员', [2, 3]],
    ],
  )

  // node grouping normalizes missing nodeId to local and keeps urgency-first node order
  const byNode = groupOverviewCards(cards, 'node', enT)
  assert.deepEqual(
    byNode.map((g) => [g.key, g.label, g.cards.map((c) => c.root.id)]),
    [
      ['node:local', 'Local', [1, 3, 4]],
      ['node:remote-1', 'remote-1', [2]],
    ],
  )
  assert.deepEqual(groupOverviewCards([], 'status', enT), [])

  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'status', bucket: 'all', profileId: '', nodeId: '' }), true)
  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'status', bucket: 'running', profileId: '', nodeId: '' }), false, 'single bucket under status grouping flattens')
  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'profile', bucket: 'running', profileId: '', nodeId: '' }), true, 'single bucket under profile grouping still groups by agent')
  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'profile', bucket: 'all', profileId: 'coder', nodeId: '' }), false, 'single profile under profile grouping flattens')
  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'node', bucket: 'all', profileId: '', nodeId: 'local' }), false, 'single node under node grouping flattens')
  assert.equal(overviewShouldShowSectionHeaders({ groupBy: 'status', bucket: 'all', profileId: 'coder', nodeId: '' }), true, 'filtering profile while grouping by status keeps status sections')
})

// ---------------------------------------------------------------------------
// URL：#/overview 解析与序列化
// ---------------------------------------------------------------------------

test('#/overview parses and serializes round-trip; belongs to the conversations space', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/overview')
  assert.deepEqual(parsed.primaryTarget, { kind: 'overview' })
  assert.equal(hashHasPrimaryTarget('#/overview'), true)
  assert.equal(formatLocationHash({ ...parsed, splitTarget: null, drawerStack: [], activeModal: null }), '#/overview')
  assert.equal(spaceForTarget({ kind: 'overview' }), 'conversations', 'the overview is a conversations-space host stage')
  const splitParsed = parseLocationHash('#/overview?split=overview')
  assert.deepEqual(splitParsed.splitTarget, { kind: 'overview' }, 'the overview can ride the split pane (same canonical path via the split param)')
})

test('#/overview filter state rides the sp./ssp. route-param namespaces round-trip; history policy keeps param-only changes replace', { timeout: 60_000 }, () => {
  // 深链解析：主屏 sp.* 归主屏 overview，分屏 ssp.* 归分屏 overview。
  const parsed = parseLocationHash('#/overview?sp.bucket=running&sp.profile=coder&sp.q=%E8%B0%83%E7%A0%94&split=overview&ssp.source=automated')
  assert.deepEqual(parsed.primaryTarget, {
    kind: 'overview',
    params: { bucket: 'running', profile: 'coder', q: '调研' },
  })
  assert.deepEqual(parsed.splitTarget, { kind: 'overview', params: { source: 'automated' } }, 'the split overview carries its own ssp.* filter params')
  // 序列化往返无损（键按字典序稳定输出）。
  const state = { ...parsed, drawerStack: [], activeModal: null }
  const hash = formatLocationHash(state)
  assert.equal(hash, '#/overview?split=overview&sp.bucket=running&sp.profile=coder&sp.q=%E8%B0%83%E7%A0%94&ssp.source=automated')
  assert.deepEqual(parseLocationHash(hash), state, 'round-trip is lossless')
  // 主屏从 overview 切回会话：sp.* 无处可挂自然丢弃（重新进入即未筛选态）。
  const leftOverview = parseLocationHash('#/c/1?sp.bucket=running&split=overview&ssp.source=automated')
  assert.deepEqual(leftOverview.primaryTarget, { kind: 'conversation', conversationId: 1 })
  assert.deepEqual(leftOverview.splitTarget, { kind: 'overview', params: { source: 'automated' } }, 'the split overview keeps its params')
  // 非法 sp.* 键与空值沿用 Hash 模型的丢弃纪律（不产生半损参数）。
  assert.deepEqual(
    parseLocationHash('#/overview?sp.bucket=running&sp.bad%20key=v&sp.profile=').primaryTarget,
    { kind: 'overview', params: { bucket: 'running' } },
  )
  // 历史策略：仅筛选参数变化 replace（不污染后退栈）；坐标级切换 push。
  const base = { splitTarget: null, drawerStack: [], activeModal: null }
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview' } },
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
    ),
    false,
    'a filter-only change replaces the current history entry',
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running', q: 'x' } } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, primaryTarget: { kind: 'overview', params: { bucket: 'running' } } },
      { ...base, primaryTarget: { kind: 'conversation', conversationId: 1 } },
    ),
    true,
    'leaving the overview for a conversation pushes',
  )
})

// ---------------------------------------------------------------------------
// 时间观测纯函数：单卡计时与后代芯片秒表
// ---------------------------------------------------------------------------

test('overview timing pure helpers: earliest pendingAskSince, root/descendant runStartedAt, settled runDurationMs, and zero-timer gate', { timeout: 60_000 }, () => {
  const now = 100_000
  const cards = buildCards([
    // 1. needs_attention：树内两处 blocked，取最早 pendingAskSince (now - 45s)
    conv({ id: 1, status: 'blocked', pendingAskCount: 1, pendingAskSince: now - 20_000, createdAt: 1000 }),
    conv({ id: 11, parentConversationId: 1, status: 'blocked', pendingAskCount: 1, pendingAskSince: now - 45_000, createdAt: 1100 }),
    // 2. running：根 idle，两个活跃后代取最早 runStartedAt (now - 70s)
    conv({ id: 2, status: 'idle', createdAt: 2000 }),
    conv({ id: 21, parentConversationId: 2, status: 'working', runStartedAt: now - 30_000, createdAt: 2100 }),
    conv({ id: 22, parentConversationId: 2, status: 'working', runStartedAt: now - 70_000, createdAt: 2200 }),
    // 3. running：根本身 working，优先取根 runStartedAt
    conv({ id: 3, status: 'working', runStartedAt: now - 15_000, createdAt: 3000 }),
    conv({ id: 31, parentConversationId: 3, status: 'working', runStartedAt: now - 90_000, createdAt: 3100 }),
    // 4. unread_done：仅 root.runDurationMs > 0 时展示累计
    conv({ id: 4, status: 'done', unread: true, runDurationMs: 125_000, createdAt: 4000 }),
    // 5. quiet：runDurationMs = 0 不展示
    conv({ id: 5, status: 'idle', runDurationMs: 0, createdAt: 5000 }),
    // 6. running 但缺 runStartedAt：不编造
    conv({ id: 6, status: 'working', createdAt: 6000 }),
  ])

  const byId = new Map(cards.map((c) => [c.root.id, c]))
  assert.deepEqual(
    cards.map((c) => c.root.id),
    [1, 6, 3, 2, 4, 5],
    'timing fields must never alter canonical bucket + createdAt-desc ordering',
  )
  assert.deepEqual(resolveOverviewCardTiming(byId.get(1)!, now), { waitingMs: 45_000 })
  assert.deepEqual(resolveOverviewCardTiming(byId.get(2)!, now), { runningMs: 70_000 })
  assert.deepEqual(resolveOverviewCardTiming(byId.get(3)!, now), { runningMs: 15_000 })
  assert.deepEqual(resolveOverviewCardTiming(byId.get(4)!, now), { settledRunMs: 125_000 })
  assert.deepEqual(resolveOverviewCardTiming(byId.get(5)!, now), {})
  assert.deepEqual(resolveOverviewCardTiming(byId.get(6)!, now), {})

  const chip21 = byId.get(2)!.descendants.find((d) => d.conv.id === 21)!
  assert.deepEqual(resolveOverviewDescendantChipTiming(chip21, now), { kind: 'running', elapsedMs: 30_000 })
  const chip11 = byId.get(1)!.descendants.find((d) => d.conv.id === 11)!
  assert.deepEqual(resolveOverviewDescendantChipTiming(chip11, now), { kind: 'waiting', elapsedMs: 45_000 })
})

// ---------------------------------------------------------------------------
// 共享纯函数：新话题候选与侧栏精简总览后代切片 / 主项裁决 / 工作集分组
// ---------------------------------------------------------------------------

test('buildNewTopicCandidates: latest active root profile leads, archived roots ignored, hidden plugins excluded', { timeout: 60_000 }, () => {
  const candidates = buildNewTopicCandidates({
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
      { id: 'writer', name: '写作助手' },
      { id: 'hidden', name: '已停用插件角色', managedByPlugin: 'builtin:off' },
    ],
    conversations: [
      conv({ id: 1, profileId: 'assistant', updatedAt: 5000 }),
      conv({ id: 2, profileId: 'coder', updatedAt: 9000 }),
      conv({ id: 3, profileId: 'writer', updatedAt: 12000, tags: [ARCHIVED_TAG] }),
    ],
    plugins: [{ id: 'builtin:off', enabled: false }],
    locale: 'zh-CN',
  })
  assert.deepEqual(
    candidates.map((c) => c.profileId),
    ['coder', 'assistant', 'writer'],
    'latest unarchived root profile leads; archived roots do not steal top slot; disabled plugin profiles stay hidden',
  )
})

test('resolveSidebarOverviewDescendants & resolveSidebarOverviewPrimaryTarget: auto-surfaces active/viewed/matched descendants and avoids root-vs-child jump deadlock', { timeout: 60_000 }, () => {
  const cards = buildCards([
    conv({ id: 10, title: '主任务', status: 'idle', createdAt: 9000 }),
    conv({ id: 11, parentConversationId: 10, title: '审批子代理', status: 'blocked', pendingAskCount: 1, pendingAskSince: 5000, createdAt: 9200 }),
    conv({ id: 12, parentConversationId: 10, title: '历史调研子代理', status: 'idle', createdAt: 9100 }),
    conv({ id: 13, parentConversationId: 10, title: '已完成子代理', status: 'done', createdAt: 9050 }),
  ])
  const card = cards[0]!
  assert.equal(card.targetConversationId, 11)
  assert.equal(isOverviewDescendantActive(card.descendants[0]!), true)
  assert.equal(isOverviewDescendantActive(card.descendants[1]!), false)

  // 1) 未手动展开：活跃/待审批子会话自动浮现，安静子会话折叠计入 hiddenCount
  const defaultSlice = resolveSidebarOverviewDescendants({
    card,
    expanded: false,
    activeConversationIds: new Set(),
  })
  assert.deepEqual(defaultSlice.visible.map((d) => d.conv.id), [11])
  assert.equal(defaultSlice.hiddenCount, 2)
  assert.equal(defaultSlice.hasCollapsibleQuiet, true)
  // 待审批子会话已作为独立子行可见 → 主项打开根会话 #10，子行开 #11，互不死锁
  assert.equal(resolveSidebarOverviewPrimaryTarget(card, defaultSlice.visible), 10)
  // 若无可见子行兜底 → 仍直达 targetConversationId (#11)
  assert.equal(resolveSidebarOverviewPrimaryTarget(card, []), 11)

  // 2) 正在主屏/分屏查看安静子会话 #12 → 当前项保底透出但不置顶（展示序保持稳定），审批项仍作为异常保底透出
  const viewedSlice = resolveSidebarOverviewDescendants({
    card,
    expanded: false,
    activeConversationIds: new Set([12]),
  })
  assert.deepEqual(viewedSlice.visible.map((d) => d.conv.id), [11, 12])
  assert.equal(viewedSlice.hiddenCount, 1)

  // 3) 搜索命中安静子会话标题或 #id → 自动浮现命中项（同样不置顶）
  assert.equal(overviewDescendantMatchesQuery(card.descendants[1]!, '调研'), true)
  assert.equal(overviewDescendantMatchesQuery(card.descendants[1]!, '#12'), true)
  assert.equal(overviewDescendantMatchesQuery(card.descendants[1]!, '不存在'), false)
  const searchSlice = resolveSidebarOverviewDescendants({
    card,
    expanded: false,
    activeConversationIds: new Set(),
    query: '调研',
  })
  assert.deepEqual(searchSlice.visible.map((d) => d.conv.id), [11, 12])

  // 4) 手动展开：展示全部后代，hiddenCount 归零，仍保留 hasCollapsibleQuiet 供收起
  const expandedSlice = resolveSidebarOverviewDescendants({
    card,
    expanded: true,
    activeConversationIds: new Set(),
  })
  assert.deepEqual(expandedSlice.visible.map((d) => d.conv.id), [11, 13, 12])
  assert.equal(expandedSlice.hiddenCount, 0)
  assert.equal(expandedSlice.hasCollapsibleQuiet, true)
})

test('resolveSidebarOverviewDescendants: switching the viewed child never reorders sibling rows while the current branch stays inside the auto cap', { timeout: 60_000 }, () => {
  const visibleIds = (
    card: OverviewCard,
    input: { expanded: boolean; activeConversationIds: ReadonlySet<number> },
  ): number[] => resolveSidebarOverviewDescendants({ card, ...input }).visible.map((d) => d.conv.id)

  // 1) 展开态：4 个安静直属子会话，点击/切换查看任何一个都不得让它跳到同级首位
  const quietCard = buildCards([
    conv({ id: 1, status: 'idle', createdAt: 1000 }),
    conv({ id: 12, parentConversationId: 1, title: 'worker-a', status: 'idle', createdAt: 1200 }),
    conv({ id: 13, parentConversationId: 1, title: 'worker-b', status: 'idle', createdAt: 1300 }),
    conv({ id: 14, parentConversationId: 1, title: 'worker-c', status: 'idle', createdAt: 1400 }),
    conv({ id: 15, parentConversationId: 1, title: 'worker-d', status: 'idle', createdAt: 1500 }),
  ])[0]!
  assert.deepEqual(quietCard.directDescendants.map((d) => d.conv.id), [12, 13, 14, 15])
  for (const viewed of [new Set<number>(), new Set([13]), new Set([15]), new Set([15, 13])]) {
    assert.deepEqual(
      visibleIds(quietCard, { expanded: true, activeConversationIds: viewed }),
      [12, 13, 14, 15],
      `expanded rows keep their order while viewing ${[...viewed].join(',')}`,
    )
  }
  // 折叠态：安静子只在被查看时浮现；主屏 + 分屏同时在场时也按稳定序而非「最新点击置顶」
  assert.deepEqual(visibleIds(quietCard, { expanded: false, activeConversationIds: new Set([15]) }), [15])
  assert.deepEqual(visibleIds(quietCard, { expanded: false, activeConversationIds: new Set([15, 13]) }), [13, 15])

  // 2) 折叠态点击非首位异常行：行序不变；查看安静子时保底浮现但排在异常行之后
  const attentionCard = buildCards([
    conv({ id: 2, status: 'idle', createdAt: 2000 }),
    conv({ id: 21, parentConversationId: 2, title: 'failed-worker', status: 'error', createdAt: 2500 }),
    conv({ id: 22, parentConversationId: 2, title: 'approval-worker', status: 'blocked', pendingAskCount: 1, createdAt: 2400 }),
    conv({ id: 23, parentConversationId: 2, title: 'quiet-worker', status: 'idle', createdAt: 2300 }),
  ])[0]!
  assert.deepEqual(attentionCard.directDescendants.map((d) => d.conv.id), [22, 21, 23])
  assert.deepEqual(visibleIds(attentionCard, { expanded: false, activeConversationIds: new Set() }), [22, 21])
  assert.deepEqual(
    visibleIds(attentionCard, { expanded: false, activeConversationIds: new Set([21]) }),
    [22, 21],
    '点击第二条异常行不得把它顶到首位',
  )
  assert.deepEqual(visibleIds(attentionCard, { expanded: false, activeConversationIds: new Set([23]) }), [22, 21, 23])
  assert.deepEqual(visibleIds(attentionCard, { expanded: true, activeConversationIds: new Set([23]) }), [22, 21, 23])

  // 3) 硬上限保底不退化：已有 SIDEBAR_DESCENDANT_AUTO_LIMIT 条异常行时，正在查看的安静子
  //    仍优先占一个名额（最后一条异常行让位），位置保持在异常行之后
  const cappedCard = buildCards([
    conv({ id: 3, status: 'idle', createdAt: 3000 }),
    conv({ id: 31, parentConversationId: 3, status: 'error', createdAt: 3100 }),
    conv({ id: 32, parentConversationId: 3, status: 'error', createdAt: 3200 }),
    conv({ id: 33, parentConversationId: 3, status: 'error', createdAt: 3300 }),
    conv({ id: 34, parentConversationId: 3, title: 'viewed-quiet', status: 'idle', createdAt: 3400 }),
  ])[0]!
  assert.deepEqual(visibleIds(cappedCard, { expanded: false, activeConversationIds: new Set() }), [31, 32, 33])
  const capped = resolveSidebarOverviewDescendants({
    card: cappedCard,
    expanded: false,
    activeConversationIds: new Set([34]),
  })
  assert.equal(capped.visible.length, SIDEBAR_DESCENDANT_AUTO_LIMIT)
  assert.deepEqual(capped.visible.map((d) => d.conv.id), [31, 32, 34], '当前查看项优先占上限名额但不置顶')
  assert.equal(capped.hiddenCount, 1)
})

test('sidebar descendants stay bounded for wide and nested agent trees while preserving their direct-parent spine', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 100, status: 'idle' })]
  for (let index = 0; index < 18; index++) {
    const childId = 200 + index
    conversations.push(conv({ id: childId, parentConversationId: 100, title: `worker-${index}`, status: 'working' }))
    conversations.push(conv({
      id: 300 + index,
      parentConversationId: childId,
      title: `nested-${index}`,
      status: index < 5 ? 'error' : 'working',
    }))
  }
  const card = buildCards(conversations)[0]!
  assert.equal(card.directDescendants.length, 18)
  assert.equal(card.descendants.length, 36)
  assert.equal(card.directDescendants[0]!.conv.id, 200, 'the direct projection retains the first child before signal ranking')
  assert.equal(card.directDescendants[0]!.subtreeDescendantCount, 1)
  assert.equal(card.directDescendants[0]!.subtreeErrorCount, 1)

  const collapsed = resolveSidebarOverviewDescendants({
    card,
    expanded: false,
    activeConversationIds: new Set(),
  })
  assert.deepEqual(collapsed.visible.map((item) => item.conv.id), [200, 201, 202])
  assert.equal(collapsed.hiddenCount, 15, 'nested errors do not create an unbounded list of rows')

  const viewingGrandchild = resolveSidebarOverviewDescendants({
    card,
    expanded: false,
    activeConversationIds: new Set([317]),
  })
  assert.deepEqual(
    viewingGrandchild.visible.map((item) => item.conv.id),
    [200, 201, 217],
    'viewing a grandchild surfaces its direct parent inside the cap without hoisting it above the error rows',
  )

  const expanded = resolveSidebarOverviewDescendants({
    card,
    expanded: true,
    activeConversationIds: new Set(),
  })
  assert.equal(expanded.visible.length, 18, 'manual expansion still renders direct children only')
})

test('buildSidebarWorkingSet: keeps all active trees, caps quiet by updatedAt desc, preserves viewed quiet root/descendant, and bypasses cap when searching', { timeout: 60_000 }, () => {
  const quietList = Array.from({ length: SIDEBAR_RECENT_QUIET_LIMIT + 4 }, (_, index) => {
    const id = 100 + index
    // Make id=100 have the oldest createdAt but newest updatedAt (should lead Recent)
    const updatedAt = id === 100 ? 999_999 : id * 1000
    return conv({ id, title: `安静对话 ${id}`, status: 'idle', createdAt: id * 1000, updatedAt })
  })
  const cards = buildCards([
    conv({ id: 1, title: '审批中', status: 'blocked', pendingAskCount: 1, createdAt: 100, updatedAt: 100 }),
    conv({ id: 2, title: '运行中', status: 'working', createdAt: 200, updatedAt: 200 }),
    ...quietList,
    // Child under oldest quiet #101 (outside top 8 by updatedAt)
    conv({ id: 901, parentConversationId: 101, title: '深层安静子会话', status: 'idle', createdAt: 101_100, updatedAt: 101_100 }),
  ])

  const defaultWs = buildSidebarWorkingSet({ cards, activeConversationIds: new Set() })
  assert.equal(defaultWs.searchActive, false)
  assert.equal(defaultWs.totalRootCount, SIDEBAR_RECENT_QUIET_LIMIT + 6)
  assert.equal(defaultWs.omittedQuietCount, 4)
  assert.deepEqual(defaultWs.cards.slice(0, 2).map((c) => c.root.id), [1, 2], 'active trees stay first in canonical order')
  assert.equal(defaultWs.cards[2]?.root.id, 100, 'quiet trees sort by updatedAt desc so recently finished chats lead')
  assert.equal(defaultWs.cards.length, 2 + SIDEBAR_RECENT_QUIET_LIMIT)

  // Active descendant #901 preserves its quiet root #101 beyond the cap
  const withViewedChild = buildSidebarWorkingSet({ cards, activeConversationIds: new Set([901]) })
  assert.equal(withViewedChild.cards.some((c) => c.root.id === 101), true, 'quiet root with viewed descendant is preserved')
  assert.equal(withViewedChild.omittedQuietCount, 3)

  // Search bypasses cap and finds omitted quiet tree #102
  const searchWs = buildSidebarWorkingSet({ cards, activeConversationIds: new Set(), query: '安静对话 102' })
  assert.equal(searchWs.searchActive, true)
  assert.equal(searchWs.omittedQuietCount, 0)
  assert.deepEqual(searchWs.cards.map((c) => c.root.id), [102])
})

test('buildSidebarWorkingSet and buildNewTopicCandidates exclude automated helmx roots', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '人类对话', profileId: 'assistant', status: 'idle', createdAt: 1000, updatedAt: 1000 }),
    conv({ id: 2, title: 'Cron · deploy', profileId: 'coder', ownedBy: 'helmx', tags: ['trigger', 'cron:deploy'], status: 'working', createdAt: 5000, updatedAt: 5000 }),
    conv({ id: 3, title: 'Cron · alert', profileId: 'coder', ownedBy: 'helmx', tags: ['trigger', 'cron:alert'], status: 'error', createdAt: 6000, updatedAt: 6000 }),
  ]
  const cards = buildCards(conversations)
  const ws = buildSidebarWorkingSet({ cards, activeConversationIds: new Set([2]) })
  assert.equal(ws.totalRootCount, 1)
  assert.deepEqual(ws.cards.map((c) => c.root.id), [1], 'automated roots never enter sidebar working set even when active or errored')

  const searchWs = buildSidebarWorkingSet({ cards, activeConversationIds: new Set(), query: 'Cron' })
  assert.deepEqual(searchWs.cards, [], 'sidebar search stays scoped to human conversations')

  const candidates = buildNewTopicCandidates({
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    plugins: [],
    conversations,
    locale: 'en',
  })
  assert.deepEqual(
    candidates.map((c) => c.profileId),
    ['assistant', 'coder'],
    'newer automated runs under coder must not pull coder ahead of recently human-used assistant',
  )
})

test('buildSidebarGroupedWorkingSet and sidebar group-by persistence: per-group quiet caps, empty creatable profiles, node grouping, and search bypass', { timeout: 60_000 }, () => {
  const memory = new Map<string, string>()
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, v) },
  }
  assert.equal(loadSidebarGroupBy(storage), 'status')
  assert.equal(saveSidebarGroupBy('profile', storage), 'profile')
  assert.equal(loadSidebarGroupBy(storage), 'profile')
  memory.set(SIDEBAR_GROUP_BY_STORAGE_KEY, 'bogus')
  assert.equal(loadSidebarGroupBy(storage), 'status')

  const coderQuiet = Array.from({ length: SIDEBAR_PER_GROUP_QUIET_LIMIT + 3 }, (_, i) =>
    conv({
      id: 100 + i,
      title: `Coder 历史 ${i}`,
      profileId: 'coder',
      nodeId: i === 0 ? 'remote-gpu' : undefined,
      createdAt: 10_000 + i * 1000,
      updatedAt: 10_000 + i * 1000,
    }),
  )
  const conversations = [
    conv({ id: 1, title: '助理早期会话', profileId: 'assistant', createdAt: 500, updatedAt: 500 }),
    conv({ id: 2, title: '自动任务', profileId: 'coder', ownedBy: 'helmx', status: 'error', createdAt: 99_000, updatedAt: 99_000 }),
    ...coderQuiet,
  ]
  const profiles = [
    { id: 'assistant', name: '个人助理' },
    { id: 'coder', name: '编码专员' },
    { id: 'researcher', name: '调研专员' },
    { id: 'hidden-bot', name: '已停用插件角色', managedByPlugin: 'builtin:off' },
  ]
  const plugins = [{ id: 'builtin:off', enabled: false }]
  const cards = buildCards(conversations, new Map(), { profiles, plugins })
  const agentStandings = [
    ...buildAgentStandings({ profiles, conversations, plugins, locale: 'zh-CN' }),
    {
      profileId: 'non-creatable-empty',
      label: '空不可创建角色',
      order: 150,
      canCreateConversation: false,
      conversations: [],
      primaryConversation: null,
    },
  ]

  // 按角色分组：保留空的可创建角色 researcher、跳过已停用插件角色与空的不可创建角色、每组独立截断且保底当前在场会话 #100
  const byProfile = buildSidebarGroupedWorkingSet({
    groupBy: 'profile',
    cards,
    activeConversationIds: new Set([100]),
    agentStandings,
    t: enT,
  })
  assert.deepEqual(
    byProfile.groups.map((g) => g.profileId),
    ['assistant', 'coder', 'researcher'],
    'keeps all visible creatable agents (including 0-conversation researcher) and omits disabled-plugin and empty non-creatable profiles',
  )
  assert.equal(byProfile.groups[0]!.cards.length, 1, 'high-volume coder never pushes assistant quiet conversation out')
  assert.equal(byProfile.groups[1]!.cards.length, SIDEBAR_PER_GROUP_QUIET_LIMIT + 1, 'per-group cap + viewed quiet #100 preserved')
  assert.equal(byProfile.groups[2]!.cards.length, 0)
  assert.equal(byProfile.groups[2]!.canCreateConversation, true)
  assert.equal(byProfile.omittedQuietCount, 2)

  // 有会话的角色优先于 0 会话空闲角色，同时两组各自保留站位顺序
  const emptyAssistantCards = buildCards(
    coderQuiet.slice(0, 1),
    new Map(),
    { profiles, plugins },
  )
  const emptyAssistantStandings = buildAgentStandings({
    profiles,
    conversations: coderQuiet.slice(0, 1),
    plugins,
    locale: 'zh-CN',
  })
  const populatedFirst = buildSidebarGroupedWorkingSet({
    groupBy: 'profile',
    cards: emptyAssistantCards,
    activeConversationIds: new Set(),
    agentStandings: emptyAssistantStandings,
    t: enT,
  })
  assert.deepEqual(
    populatedFirst.groups.map((g) => g.profileId),
    ['coder', 'assistant', 'researcher'],
    'populated profile groups lead 0-conversation creatable profiles while preserving standing order in each tier',
  )

  // 搜索态：突破单组上限，仅返回命中分组
  const profileSearch = buildSidebarGroupedWorkingSet({
    groupBy: 'profile',
    cards,
    activeConversationIds: new Set(),
    agentStandings,
    query: 'Coder 历史 1',
    t: enT,
  })
  assert.equal(profileSearch.searchActive, true)
  assert.equal(profileSearch.omittedQuietCount, 0)
  assert.deepEqual(profileSearch.groups.map((g) => g.profileId), ['coder'])
  assert.deepEqual(profileSearch.groups[0]!.cards.map((c) => c.root.id), [101])

  // 按节点分组：local 与 remote-gpu 各自独立截取
  const byNode = buildSidebarGroupedWorkingSet({
    groupBy: 'node',
    cards,
    activeConversationIds: new Set(),
    agentStandings,
    t: enT,
  })
  assert.deepEqual(byNode.groups.map((g) => g.nodeId).sort(), ['local', 'remote-gpu'])
  const localGroup = byNode.groups.find((g) => g.nodeId === 'local')!
  assert.equal(localGroup.cards.length, SIDEBAR_PER_GROUP_QUIET_LIMIT)
  assert.equal(byNode.omittedQuietCount, 3)
})
