/**
 * Sidebar "conversation background in-flight" model and rendering tests
 * (single-light semantics):
 * - pure-layer contracts of summarizeConversationBackgroundActivity /
 *   collectBackgroundBadgeDocs / resolveStandingStatusIndicator /
 *   resolveStatusLight / backgroundAwareStatusTooltip (only tone=accent counts
 *   as in flight; neutral history counts and warn failure summaries never
 *   misreport; global badges do not participate; scope filtering; plugin
 *   contribution/doc absence zeroes out; non-primary conversations' background
 *   activity surfaces onto the level-one standing row; error > blocked >
 *   working > done > idle priority);
 * - single-light priority: working/blocked/error keep the main status light
 *   exclusive (no background hollow ring, no summary appended to the tooltip);
 *   idle/done with background in flight render only the hollow ring (the done
 *   green dot yields); with no background work the five states stay as-is;
 * - Sidebar SSR rendering: conversation rows / collapsed standing rows /
 *   sidebar.section group rows each carry exactly one light; the expanded
 *   standing row does not duplicate it and each child row keeps its own light;
 * - mount path: badge docs are loaded on demand via the Sidebar effect calling
 *   ensurePluginDoc (the pure functions have zero side effects).
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary, HelmxLocale, PluginUiContribution, WorkbenchPanelSpec } from '@helmx/protocol'
import { groupUiContributions } from '../src/lib/types.js'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import { conversationStatusDotClass, conversationStatusTooltip } from '../src/shell/sidebar-model.js'
import {
  backgroundAwareStatusTooltip,
  collectBackgroundBadgeDocs,
  resolveStandingStatusIndicator,
  resolveStatusLight,
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from '../src/shell/background-activity-model.js'
import { makeTestStore, HelmxExternalStoreContext, type TestStoreOverrides } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

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

const WORKFLOW_PANEL_SPEC: WorkbenchPanelSpec = {
  id: 'tasks',
  label: '工作流与子代理',
  badge: { doc: 'run-badges', byConversationField: 'byConversation' },
}

function panelContribution(
  overrides: { pluginId?: string; spec?: Partial<WorkbenchPanelSpec> } = {},
): PluginUiContribution {
  return {
    pluginId: overrides.pluginId ?? 'builtin:workflow',
    surface: 'workbench.panel',
    spec: { ...WORKFLOW_PANEL_SPEC, ...overrides.spec },
  }
}

function badgesDoc(
  entries: Record<string, { count: number; tone?: string; footerText?: string | { en: string; 'zh-CN': string } }>,
): Record<string, unknown> {
  return { byConversation: entries }
}

function summarize(input: {
  contributions?: PluginUiContribution[]
  conversations: ConversationSummary[]
  pluginDocs?: Record<string, unknown>
  locale?: 'en' | 'zh-CN'
}) {
  return summarizeConversationBackgroundActivity({
    panels: groupUiContributions(input.contributions ?? [panelContribution()]).workbenchPanels,
    conversations: input.conversations,
    pluginDocs: input.pluginDocs ?? {},
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  })
}

// ---------------------------------------------------------------------------
// Pure layer: in-flight verdict contracts
// ---------------------------------------------------------------------------

test('per-conversation badges with tone=accent count as in flight and merge footerText; missing footerText still in flight', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, status: 'idle' }), conv({ id: 2, status: 'done' })]
  const index = summarize({
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 Running' },
        '2': { count: 1, tone: 'accent' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 Running' })
  assert.deepEqual(index.get(2), { active: true, summary: '' })

  // Bilingual LocalizedText footerText resolves per active UI locale
  const bilingualDocs = {
    'builtin:workflow/run-badges': badgesDoc({
      '1': { count: 2, tone: 'accent', footerText: { en: '2 working', 'zh-CN': '2 项执行中' } },
    }),
  }
  assert.deepEqual(summarize({ conversations, pluginDocs: bilingualDocs, locale: 'en' }).get(1), {
    active: true,
    summary: '2 working',
  })
  assert.deepEqual(summarize({ conversations, pluginDocs: bilingualDocs, locale: 'zh-CN' }).get(1), {
    active: true,
    summary: '2 项执行中',
  })
})

test('neutral history counts and warn failure summaries never misreport as in flight', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 }), conv({ id: 2 }), conv({ id: 3 })]
  const index = summarize({
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 7, tone: 'neutral', footerText: '7 条历史' },
        '2': { count: 3, tone: 'warn', footerText: '1 失败' },
      }),
    },
  })
  assert.equal(index.size, 0, 'neutral/warn entries must not light any conversation as in flight')
})

test('tone=accent with count=0 is still in flight by tone alone (count includes history and never participates)', { timeout: 60_000 }, () => {
  const index = summarize({
    conversations: [conv({ id: 1 })],
    pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 0, tone: 'accent' } }) },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '' })
})

test('global badges (no byConversationField) drive no per-conversation in-flight state and load no docs', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const contributions = [
    panelContribution({ spec: { badge: { doc: 'global-count', countField: 'total', toneField: 'tone' } } }),
  ]
  const index = summarize({
    contributions,
    conversations,
    pluginDocs: { 'builtin:workflow/global-count': { total: 5, tone: 'accent' } },
  })
  assert.equal(index.size, 0, 'a global accent badge cannot be attributed to a conversation and must light no row')
  const docs = collectBackgroundBadgeDocs(groupUiContributions(contributions).workbenchPanels, conversations)
  assert.deepEqual(docs, [])
})

test('missing plugin contribution (disabled) or unloaded doc zeroes the summary', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  assert.equal(summarize({ contributions: [], conversations }).size, 0)
  assert.equal(summarize({ conversations, pluginDocs: {} }).size, 0)
  // doc loaded but missing this conversation's entry: equally no in-flight state
  assert.equal(
    summarize({ conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '9': { count: 1, tone: 'accent' } }) } }).size,
    0,
  )
})

test('conversations missing the scope join no summary and their panels collect no doc references', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, profileId: 'assistant' })]
  const contributions = [
    panelContribution({ spec: { scope: { profileIds: ['superagent'] } } }),
  ]
  const panels = groupUiContributions(contributions).workbenchPanels
  assert.equal(summarize({ contributions, conversations, pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent' } }) } }).size, 0)
  assert.deepEqual(collectBackgroundBadgeDocs(panels, conversations), [])
  // with the scope hit (no scope = unrestricted), collect the deduplicated doc references
  assert.deepEqual(collectBackgroundBadgeDocs(groupUiContributions([panelContribution()]).workbenchPanels, conversations), [
    { pluginId: 'builtin:workflow', doc: 'run-badges' },
  ])
})

test('multi-panel aggregation: footerText joined after dedup, in-flight unioned', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  const index = summarize({
    contributions: [panelContribution(), panelContribution({ pluginId: 'builtin:other', spec: { id: 'jobs' } })],
    conversations,
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
      'builtin:other/run-badges': badgesDoc({
        '1': { count: 3, tone: 'accent', footerText: '2 Running' },
      }),
    },
  })
  assert.deepEqual(index.get(1), { active: true, summary: '2 Running' })
})

test('contextUsage.compacting=true marks background in flight and merges the compaction summary (dedup-joined with panel badges)', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
    conv({ id: 2, status: 'done', contextUsage: { tokens: null, compacting: true } }),
    conv({ id: 3, status: 'idle', contextUsage: { tokens: 800, compacting: false } }),
    conv({ id: 4, status: 'done' }),
  ]
  const index = summarize({
    contributions: [],
    conversations,
  })
  assert.deepEqual(index.get(1), { active: true, summary: 'Compacting context' })
  assert.deepEqual(index.get(2), { active: true, summary: 'Compacting context' })
  assert.equal(index.get(3), undefined, 'compacting=false must not mark in flight')
  assert.equal(index.get(4), undefined, 'a missing compacting field must not mark in flight')

  const combined = summarize({
    conversations: [
      conv({ id: 1, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
      conv({ id: 2, status: 'idle', contextUsage: { tokens: 1200, compacting: true } }),
    ],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '1': { count: 2, tone: 'accent', footerText: '2 Running' },
        '2': { count: 1, tone: 'accent', footerText: 'Compacting context' },
      }),
    },
  })
  assert.deepEqual(combined.get(1), { active: true, summary: '2 Running · Compacting context' })
  assert.deepEqual(combined.get(2), { active: true, summary: 'Compacting context' })
})

// ---------------------------------------------------------------------------
// Pure layer: representative status aggregation, single-light priority and tooltip composition
// ---------------------------------------------------------------------------

test('standing aggregation priority error > blocked > working > done > idle; ties keep the list head (pinned-first order)', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'working', updatedAt: 9000 }),
    conv({ id: 2, status: 'blocked' }),
    conv({ id: 3, status: 'error' }),
    conv({ id: 4, status: 'done' }),
  ]
  const indicator = resolveStandingStatusIndicator(conversations, new Map())
  assert.equal(indicator?.representative.id, 3)

  const workingBeatsDone = [conv({ id: 1, status: 'done', updatedAt: 9000 }), conv({ id: 2, status: 'working' })]
  assert.equal(resolveStandingStatusIndicator(workingBeatsDone, new Map())?.representative.id, 2)

  const tie = [conv({ id: 1, status: 'working', updatedAt: 9000 }), conv({ id: 2, status: 'working' })]
  assert.equal(resolveStandingStatusIndicator(tie, new Map())?.representative.id, 1)

  // a later unread finished (done) conversation outranks idle so the collapsed state surfaces the green dot; with background in flight the single-light semantics still yield to the hollow ring
  const idleWithDone = [conv({ id: 1, updatedAt: 9000 }), conv({ id: 2, status: 'done' })]
  const doneIndicator = resolveStandingStatusIndicator(idleWithDone, new Map())
  assert.equal(doneIndicator?.representative.id, 2)
  assert.equal(doneIndicator?.representative.status, 'done')

  // an all-idle list keeps its head (compatible with the old "watch primary" behavior)
  const pureIdle = [conv({ id: 1, status: 'idle', updatedAt: 9000 }), conv({ id: 2, status: 'idle' })]
  assert.equal(resolveStandingStatusIndicator(pureIdle, new Map())?.representative.id, 1)

  assert.equal(resolveStandingStatusIndicator([], new Map()), null)
})

test('background in flight from a non-primary conversation still surfaces; summaries dedupe across conversations', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, status: 'idle', updatedAt: 9000 }),
    conv({ id: 2, status: 'idle' }),
    conv({ id: 3, status: 'idle' }),
  ]
  const background: ConversationBackgroundIndex = new Map([
    [2, { active: true, summary: '1 Running' }],
    [3, { active: true, summary: '1 Running' }],
  ])
  const indicator = resolveStandingStatusIndicator(conversations, background)
  assert.equal(indicator?.representative.id, 1, 'the representative stays the primary')
  assert.equal(indicator?.backgroundActive, true, 'background in flight from a non-primary conversation must surface')
  assert.equal(indicator?.backgroundSummary, '1 Running', 'identical footerText dedupes across conversations')
})

test('resolveStatusLight single-light priority: main status is exclusive; idle/done yield to the background hollow ring', { timeout: 60_000 }, () => {
  // working/blocked/error: the main status light is exclusive; background work never joins the light slot
  for (const status of ['working', 'blocked', 'error'] as const) {
    assert.deepEqual(
      resolveStatusLight(status, true),
      { dotClass: conversationStatusDotClass(status), background: false },
      `${status} status light must be exclusive with no background hollow ring`,
    )
  }
  // idle/done with background in flight: hollow ring only (idle's no-light and done's green dot yield)
  assert.deepEqual(resolveStatusLight('idle', true), { dotClass: 'status-dot status-dot-background', background: true })
  assert.deepEqual(resolveStatusLight('done', true), { dotClass: 'status-dot status-dot-background', background: true })
  // no background work: the five states stay as-is
  assert.deepEqual(resolveStatusLight('working', false), { dotClass: 'status-dot status-dot-working', background: false })
  assert.deepEqual(resolveStatusLight('done', false), { dotClass: 'status-dot status-dot-done', background: false })
  assert.deepEqual(resolveStatusLight('idle', false), { dotClass: null, background: false })
})

test('tooltip composition: an exclusive status light states only the main turn; the hollow-ring slot appends base status + background summary', { timeout: 60_000 }, () => {
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: false }),
    conversationStatusTooltip('idle'),
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'idle', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Idle · background task: 2 Running',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'done', backgroundActive: true, backgroundSummary: '' }),
    'Completed · background task running',
  )
  // working/blocked/error: even with background in flight, the tooltip shows only the main status/doing/lastError
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'working', doing: '正在思考方案', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Running: 正在思考方案',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'blocked', backgroundActive: true, backgroundSummary: '2 Running' }),
    'Awaiting confirmation',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: true }),
    'Error: model_error: x',
  )
  assert.equal(
    backgroundAwareStatusTooltip({ status: 'error', lastError: 'model_error: x', backgroundActive: false }),
    'Error: model_error: x',
  )
})

// ---------------------------------------------------------------------------
// Sidebar rendering: single light slots on conversation rows and collapsed standings
// ---------------------------------------------------------------------------

const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

function sidebarStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  return makeTestStore({
    profiles: BASE_PROFILES,
    ...overrides,
  })
}

function renderSidebar(store: HelmxExternalStore): string {
  return renderToString(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
}


/** Strip the ActivityRail SSE status light wrapper so sidebar assertions only observe conversation lights. */
function sidebarConversationHtml(html: string): string {
  const idx = html.indexOf('class="sidebar-context"')
  return idx === -1 ? html : html.slice(idx)
}

/** Count conversation status lights (excluding the ActivityRail SSE StatusLight). */
function countStatusLights(html: string): number {
  return (
    sidebarConversationHtml(html).match(
      /class="status-dot(?: status-dot-(?:working|blocked|done|error|background))?"/g,
    ) ?? []
  ).length
}

test('working/blocked/error conversations + background in flight: only the main status light renders, no background class', { timeout: 60_000 }, () => {
  for (const [status, dotClass] of [
    ['working', 'status-dot-working'],
    ['blocked', 'status-dot-blocked'],
    ['error', 'status-dot-error'],
  ] as const) {
    const store = sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '主会话',
          profileId: 'assistant',
          status,
          doing: status === 'working' ? '正在思考方案' : undefined,
          lastError: status === 'error' ? 'model_error: boom' : undefined,
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      uiContributions: [panelContribution()],
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 3, tone: 'accent', footerText: '3 Running' } }),
      },
    })
    const html = renderSidebar(store)
    assert.ok(html.includes(`class="status-dot ${dotClass}"`), `${status} keeps the main status light`)
    assert.ok(!html.includes('status-dot-background'), `${status} status light is exclusive with no background hollow ring`)
    assert.ok(!html.includes('background task'), `${status} tooltip appends no background summary`)
    assert.equal(countStatusLights(html), 1, `${status} collapsed standing row carries exactly one light`)
  }
})

test('idle conversation + background in flight: only the background hollow ring renders; the tooltip states idle + background summary', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), 'the background in-flight hollow ring must render')
  assert.ok(html.includes('title="Idle · background task: 2 Running"'), 'the tooltip states both the base status and the background summary')
  assert.ok(
    !html.includes('status-dot-working'),
    'idle + background in flight must not masquerade as the conversation itself working',
  )
  assert.equal(countStatusLights(html), 1, 'the collapsed standing row carries exactly one light')
})

test('done conversation + background in flight: the green dot yields and only the background hollow ring renders', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-background"'), 'the background in-flight hollow ring is the sole light')
  assert.ok(!sidebarConversationHtml(html).includes('class="status-dot status-dot-done"'), 'the done green dot must yield, never side by side with the hollow ring')
  assert.ok(html.includes('title="Completed · background task: 1 Running"'), 'the tooltip states completed + background summary')
  assert.equal(countStatusLights(html), 1, 'the collapsed standing row carries exactly one light')
})

test('no background work: unread done keeps its green dot; read done and idle render no light', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', unread: true, createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '闲置话题', profileId: 'assistant' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '1': { count: 5, tone: 'neutral', footerText: '5 条历史' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-done"'), 'unread done keeps its green dot with nothing in flight')
  assert.ok(!html.includes('status-dot-background'), 'neutral history counts must not light the hollow ring')
  assert.equal(countStatusLights(html), 1, 'one light for the unread done conversation, none for idle')
})

test('working set rows: each root row carries its own single status light (done / background hollow ring / error)', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'done', unread: true, createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant' }),
      conv({ id: 3, title: '失败话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom' }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '2': { count: 1, tone: 'accent', footerText: '1 Running' } }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('title="Idle · background task: 1 Running"'), 'the idle row with background work shows the hollow ring')
  assert.ok(html.includes('class="status-dot status-dot-error"'), 'the error row shows its own status light')
  assert.ok(html.includes('class="status-dot status-dot-done"'), 'the unread done row keeps its green dot')
  assert.equal(countStatusLights(html), 3, 'exactly one light per active/unread root row')
  assert.equal((html.match(/status-dot-background/g) ?? []).length, 1)
})

test('working set root trees: error, blocked and background in-flight each render single-light semantics on their own tree row', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '出错话题', profileId: 'assistant', status: 'error', lastError: 'model_error: boom', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '后台话题', profileId: 'assistant', status: 'idle', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '阻塞话题', profileId: 'assistant', status: 'blocked', createdAt: 7000, updatedAt: 7000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({
        '2': { count: 4, tone: 'accent', footerText: '4 Running' },
        '3': { count: 2, tone: 'accent', footerText: '2 Running' },
      }),
    },
  })
  const html = renderSidebar(store)
  assert.ok(html.includes('class="status-dot status-dot-error"'))
  assert.ok(html.includes('title="Error: model_error: boom"'))
  assert.ok(html.includes('class="status-dot status-dot-blocked"'))
  assert.ok(html.includes('class="status-dot status-dot-background"'))
  assert.ok(html.includes('title="Idle · background task: 4 Running"'))
  // Blocked conversation #3 keeps its exclusive blocked dot (background ring does not render on #3)
  assert.equal((html.match(/status-dot-background/g) ?? []).length, 1)
  assert.equal(countStatusLights(html), 3)
})

test('plugin disabled (contributions gone) or only neutral history counts left: no in-flight indicator at all', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
    conv({ id: 50, title: '别处', profileId: 'coder' }),
  ]
  const common = { conversations, primaryTarget: { kind: 'conversation' as const, conversationId: 50 } }
  const disabled = renderSidebar(sidebarStore({ ...common, uiContributions: [], pluginDocs: {} }))
  assert.ok(!disabled.includes('status-dot-background'), 'with the contribution gone (disabled), the indicator disappears immediately')
  const neutral = renderSidebar(
    sidebarStore({
      ...common,
      uiContributions: [panelContribution()],
      pluginDocs: { 'builtin:workflow/run-badges': badgesDoc({ '1': { count: 9, tone: 'neutral', footerText: '9 条历史' } }) },
    }),
  )
  assert.ok(!neutral.includes('status-dot-background'), 'neutral history counts must not misreport as in flight')
})

// ---------------------------------------------------------------------------
// Trailing status slot (sidebar-status-slot): right-aligned indicator sharing the row-actions centerline
// ---------------------------------------------------------------------------

/** Assert that the row's status light sits inside .nav-item-meta .sidebar-status-slot AFTER .nav-item-label (never inside .nav-item-main). */
function indicatorAfterLabel(row: Element, expectedSelector: string): boolean {
  const main = row.querySelector('.nav-item-main')
  const meta = row.querySelector('.nav-item-meta')
  const label = row.querySelector('.nav-item-label')
  const slot = meta?.querySelector('.sidebar-status-slot')
  if (!main || !meta || !label || !slot) return false
  if (main.querySelector('.sidebar-status-slot, .nav-status-slot, .status-dot') !== null) return false
  return slot.querySelector(expectedSelector) !== null
}

test('trailing status slot: root rows and expanded descendants render status lights in .nav-item-meta .sidebar-status-slot, omit on idle, and preserve in batch mode', { timeout: 60_000 }, async () => {
  const store = sidebarStore({
    conversations: [
      conv({ id: 1, title: '当前在跑', profileId: 'assistant', status: 'working', doing: '正在思考方案', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 10, title: '在跑子会话', profileId: 'assistant', parentConversationId: 1, status: 'working', doing: '执行子任务', createdAt: 9100, updatedAt: 9100 }),
      conv({ id: 2, title: 'Completed', profileId: 'assistant', status: 'done', unread: true, createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '纯空闲', profileId: 'assistant', createdAt: 7000, updatedAt: 7000 }),
      conv({ id: 4, title: '后台在跑', profileId: 'assistant', createdAt: 6000, updatedAt: 6000 }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    uiContributions: [panelContribution()],
    pluginDocs: {
      'builtin:workflow/run-badges': badgesDoc({ '4': { count: 2, tone: 'accent', footerText: '2 Running' } }),
    },
  })

  const html = renderSidebar(store)
  const workingRow = findNavRow(html, '当前在跑')
  const doneRow = findNavRow(html, 'Completed')
  const idleRow = findNavRow(html, '纯空闲')
  const bgRow = findNavRow(html, '后台在跑')

  assert.ok(indicatorAfterLabel(workingRow, '.status-dot-working'), 'working dot sits in trailing .sidebar-status-slot')
  assert.ok(indicatorAfterLabel(doneRow, '.status-dot-done'), 'unread done dot sits in trailing .sidebar-status-slot')
  assert.ok(indicatorAfterLabel(bgRow, '.status-dot-background'), 'background hollow ring sits in trailing .sidebar-status-slot')
  assert.ok(idleRow.querySelector('.sidebar-status-slot') === null, 'idle row omits .sidebar-status-slot')
  assert.ok(idleRow.querySelector('.nav-item-main .nav-status-slot') === null, 'idle row omits leading .nav-status-slot')
  assert.equal(
    idleRow.querySelector('.sidebar-overview-head-meta')?.classList.contains('sidebar-overview-head-meta-actions-only'),
    true,
    'idle row marks head meta as actions-only so desktop hover wrapper collapses via display:contents',
  )
  assert.equal((sidebarConversationHtml(html).match(/class="sidebar-status-slot"/g) ?? []).length, 3, 'only non-idle rows emit .sidebar-status-slot')

  // Interactive check: expand descendant row & toggle batch mode
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    const descToggle = container.querySelector<HTMLButtonElement>('.sidebar-overview-desc-toggle')
    assert.ok(descToggle !== null, 'descendant toggle renders for root #1')
    await act(async () => {
      descToggle.click()
    })
    const descRow = container.querySelector('.sidebar-overview-descendant')
    assert.ok(descRow !== null, 'expanded descendant row renders')
    assert.ok(indicatorAfterLabel(descRow, '.status-dot-working'), 'descendant working dot sits in trailing .sidebar-status-slot')

    const batchToggle = container.querySelector<HTMLButtonElement>('.sidebar-batch-toggle')
    assert.ok(batchToggle !== null, 'batch mode toggle renders')
    await act(async () => {
      batchToggle.click()
    })
    const batchWorkingRow = [...container.querySelectorAll('.sidebar-overview-item')].find((el) =>
      el.textContent?.includes('当前在跑'),
    )
    assert.ok(batchWorkingRow !== undefined)
    assert.ok(batchWorkingRow.querySelector('.nav-item-row-actions') === null, 'batch mode hides row actions menu')
    assert.ok(
      batchWorkingRow.querySelector('.sidebar-overview-head-meta .sidebar-status-slot .status-dot-working') !== null,
      'batch mode preserves the trailing status slot',
    )
  } finally {
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})


// ---------------------------------------------------------------------------
// Mount path: badge docs load on demand via the Sidebar effect (pure functions have zero side effects)
// ---------------------------------------------------------------------------

test('after Sidebar mounts, ensurePluginDoc loads the badge docs of hit panels on demand', { timeout: 60_000 }, async () => {
  // 真实 ensurePluginDoc 经 pluginsApi.getPublicDoc 拉取；以拦截到的请求 URL 断言按需加载目标。
  const docUrls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    docUrls.push(url)
    return new Response(JSON.stringify({ key: 'stub', value: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const store = sidebarStore({
    plugins: [{ id: 'builtin:workflow', name: 'Workflow', version: '0.0.0', enabled: true, locked: false, hooks: [], actions: [], tools: [] }],
    conversations: [
      conv({ id: 1, title: '主会话', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 50, title: '别处', profileId: 'coder' }),
    ],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    uiContributions: [panelContribution()],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
    })
    assert.deepEqual(docUrls, ['/api/plugins/builtin%3Aworkflow/docs/run-badges'])
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root?.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// Sidebar rendering and DOM updates: the contextUsage.compacting background hollow ring and single-light semantics
// ---------------------------------------------------------------------------

test('Sidebar render: idle/done conversations with compacting=true render the background hollow ring, working keeps the main light exclusive, workflow badges dedupe-join', { timeout: 60_000 }, () => {
  // idle + compacting=true -> hollow ring + compaction summary
  const idleHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '精简中会话',
          profileId: 'assistant',
          status: 'idle',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(idleHtml.includes('class="status-dot status-dot-background"'), 'idle + compacting must render the background hollow ring')
  assert.ok(idleHtml.includes('title="Idle · background task: Compacting context"'), 'the tooltip must include the compaction summary')
  assert.equal(countStatusLights(idleHtml), 1)

  // done + compacting=true -> green dot yields to the hollow ring
  const doneHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '已完成但精简中',
          profileId: 'assistant',
          status: 'done',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(doneHtml.includes('class="status-dot status-dot-background"'), 'done + compacting must render the background hollow ring')
  assert.ok(!sidebarConversationHtml(doneHtml).includes('class="status-dot status-dot-done"'), 'the done green dot must yield')
  assert.ok(doneHtml.includes('title="Completed · background task: Compacting context"'))
  assert.equal(countStatusLights(doneHtml), 1)

  // working + compacting=true -> the solid working light stays exclusive (single-light invariant)
  const workingHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '运行中且精简',
          profileId: 'assistant',
          status: 'working',
          doing: '生成回答',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
    }),
  )
  assert.ok(workingHtml.includes('class="status-dot status-dot-working"'), 'the working main status light must be exclusive')
  assert.ok(!workingHtml.includes('status-dot-background'), 'no background hollow ring while working')
  assert.ok(!workingHtml.includes('Compacting context'), 'no background summary appended to the tooltip while working')
  assert.equal(countStatusLights(workingHtml), 1)

  // idle + compacting=true + workflow accent badge -> combined summary "2 Running · Compacting context"
  const combinedHtml = renderSidebar(
    sidebarStore({
      conversations: [
        conv({
          id: 1,
          title: '双后台任务',
          profileId: 'assistant',
          status: 'idle',
          contextUsage: { tokens: 2000, compacting: true },
          createdAt: 9000,
          updatedAt: 9000,
        }),
        conv({ id: 50, title: '别处', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 50 },
      uiContributions: [panelContribution()],
      pluginDocs: {
        'builtin:workflow/run-badges': badgesDoc({ '1': { count: 2, tone: 'accent', footerText: '2 Running' } }),
      },
    }),
  )
  assert.ok(combinedHtml.includes('class="status-dot status-dot-background"'))
  assert.ok(combinedHtml.includes('title="Idle · background task: 2 Running · Compacting context"'))
  assert.equal(countStatusLights(combinedHtml), 1)
})

test('Sidebar DOM update: flipping a conversation compacting false -> true lights the hollow ring immediately (no stale closure)', { timeout: 60_000 }, async () => {
  const convIdle = conv({ id: 1, title: '主会话', profileId: 'assistant', status: 'idle', createdAt: 9000, updatedAt: 9000 })
  const store = sidebarStore({
    conversations: [convIdle, conv({ id: 50, title: '别处', profileId: 'coder' })],
    primaryTarget: { kind: 'conversation', conversationId: 50 },
    pluginDocs: {},
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar)))
  })
  assert.ok(container.querySelector('.status-dot-background') === null, 'no hollow ring initially without compacting')

  // conversations 领域原位推进（与 SSE conversation.updated 同一链路），验证无过期闭包
  await act(async () => {
    store.updateLive((prev) => ({
      ...prev,
      conversations: [
        { ...convIdle, contextUsage: { tokens: 3000, compacting: true } },
        ...prev.conversations.filter((c) => c.id !== 1),
      ],
    }))
  })
  const ring = container.querySelector('.status-dot-background')
  assert.ok(ring !== null, 'after the conversations update with compacting=true, the hollow ring lights immediately')
  assert.equal(ring.getAttribute('title'), 'Idle · background task: Compacting context')

  await act(async () => {
    root?.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// Sidebar dynamic groups, views/settings space navigation and the archived group: split presence, focus ticks and micro-badge SSR regressions
// ---------------------------------------------------------------------------

function findNavRow(html: string, label: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  const match = [...host.querySelectorAll('.nav-item')].find(
    (row) => row.querySelector('.nav-item-label')?.textContent === label,
  )
  assert.ok(match, `sidebar row titled "${label}" not found`)
  return match
}

test('ViewNavGroup and SettingsNavGroup split double-open: main/split highlights, focus ticks and .nav-pane-tag (single screen adds no Settings meta)', { timeout: 60_000 }, () => {
  const viewContributions: PluginUiContribution[] = [
    {
      pluginId: 'builtin:herdr',
      surface: 'sidebar.item',
      spec: { id: 'herdr', label: 'Herdr 终端', icon: 'terminal', target: 'screen:builtin:herdr/overview' },
    },
    {
      pluginId: 'builtin:workflow',
      surface: 'sidebar.item',
      spec: { id: 'runs', label: '工作流总览', icon: 'activity', target: 'screen:builtin:workflow/runs' },
    },
  ]
  const viewSplitHtml = renderSidebar(
    sidebarStore({
      uiContributions: viewContributions,
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs' },
      focusedPanel: 'split',
    }),
  )
  const herdrRow = findNavRow(viewSplitHtml, 'Herdr 终端')
  assert.equal(herdrRow.classList.contains('nav-item-split'), true)
  assert.equal(herdrRow.classList.contains('nav-item-active'), false)
  assert.equal(herdrRow.classList.contains('nav-item-focused'), false)
  assert.equal(herdrRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(herdrRow.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.equal(herdrRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in main view')

  const runsRow = findNavRow(viewSplitHtml, '工作流总览')
  assert.equal(runsRow.classList.contains('nav-item-active'), true)
  assert.equal(runsRow.classList.contains('nav-item-focused'), true)
  assert.equal(runsRow.classList.contains('nav-item-split'), false)
  assert.equal(runsRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(runsRow.querySelector('.nav-pane-tag')?.textContent, 'Split')
  assert.equal(runsRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in split view')

  const viewSameHtml = renderSidebar(
    sidebarStore({
      uiContributions: viewContributions,
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
    }),
  )
  const herdrBothRow = findNavRow(viewSameHtml, 'Herdr 终端')
  assert.equal(herdrBothRow.classList.contains('nav-item-active'), true)
  assert.equal(herdrBothRow.classList.contains('nav-item-focused'), true)
  assert.equal(herdrBothRow.querySelector('.nav-pane-tag')?.textContent, 'Main·Split')
  assert.equal(herdrBothRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in both main and split views')

  const singleSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: null,
    }),
  )
  const singleProfiles = findNavRow(singleSettingsHtml, 'Profile')
  assert.equal(singleProfiles.classList.contains('settings-nav-item'), true)
  assert.equal(singleProfiles.classList.contains('nav-item-active'), true)
  assert.equal(singleProfiles.classList.contains('nav-item-focused'), false)
  assert.ok(singleProfiles.querySelector('.nav-item-meta') === null, 'single-screen SettingsNavGroup renders no .nav-item-meta')

  const splitSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: { kind: 'models' },
      focusedPanel: 'split',
    }),
  )
  const profilesRow = findNavRow(splitSettingsHtml, 'Profile')
  assert.equal(profilesRow.classList.contains('settings-nav-item'), true)
  assert.equal(profilesRow.classList.contains('nav-item-split'), true)
  assert.equal(profilesRow.classList.contains('nav-item-active'), false)
  assert.equal(profilesRow.classList.contains('nav-item-focused'), false)
  assert.equal(profilesRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(profilesRow.querySelector('.nav-item-meta .nav-pane-tag')?.textContent, 'Main')
  assert.equal(profilesRow.querySelector('.nav-item-meta .nav-pane-tag')?.getAttribute('title'), 'Open in main view')

  const modelsRow = findNavRow(splitSettingsHtml, 'Models & credentials')
  assert.equal(modelsRow.classList.contains('settings-nav-item'), true)
  assert.equal(modelsRow.classList.contains('nav-item-active'), true)
  assert.equal(modelsRow.classList.contains('nav-item-focused'), true)
  assert.equal(modelsRow.classList.contains('nav-item-split'), false)
  assert.equal(modelsRow.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(modelsRow.querySelector('.nav-item-meta .nav-pane-tag')?.textContent, 'Split')
  assert.equal(modelsRow.querySelector('.nav-item-meta .nav-pane-tag')?.getAttribute('title'), 'Open in split view')

  const skillsRow = findNavRow(splitSettingsHtml, 'Skills')
  assert.ok(skillsRow.querySelector('.nav-item-meta') === null, 'unhit settings entries render no .nav-item-meta')

  const sameSettingsHtml = renderSidebar(
    sidebarStore({
      primaryTarget: { kind: 'profiles' },
      splitTarget: { kind: 'profiles', profileId: 'coder' },
      focusedPanel: 'primary',
    }),
  )
  const profilesBothRow = findNavRow(sameSettingsHtml, 'Profile')
  assert.equal(profilesBothRow.classList.contains('nav-item-active'), true)
  assert.equal(profilesBothRow.classList.contains('nav-item-focused'), true)
  assert.equal(profilesBothRow.querySelector('.nav-pane-tag')?.textContent, 'Main·Split')
  assert.equal(profilesBothRow.querySelector('.nav-pane-tag')?.getAttribute('title'), 'Open in both main and split views')
})

// ---------------------------------------------------------------------------
// Locale wiring: shell chrome copy follows the active store locale
// ---------------------------------------------------------------------------

test('zh-CN sidebar render: conversations working set shows Chinese chrome copy and archived footer entry (no archived rows in working set)', { timeout: 60_000 }, () => {
  const store = sidebarStore({
    locale: 'zh-CN',
    conversations: [
      conv({ id: 1, title: '活跃会话', profileId: 'assistant' }),
      conv({ id: 77, title: '已归档历史', profileId: 'assistant', tags: [ARCHIVED_TAG] }),
    ],
  })
  const html = renderSidebar(store)
  assert.ok(!html.includes('sidebar-overview-open-btn'), 'header overview button is omitted')
  assert.ok(html.includes('已归档会话 (1)'), 'archived footer entry renders zh-CN copy')
  assert.ok(html.includes('按状态'), 'working set group-by switcher renders zh-CN copy')
  assert.ok(html.includes('筛选会话'), 'filter tooltip/aria-label renders zh-CN')
  assert.ok(!html.includes('已归档历史'), 'archived conversations are governed in #/overview, not duplicated in the sidebar')
  assert.ok(!html.includes('By status'), 'no leftover English group-by copy under zh-CN')
})

test('SidebarConversationList switches copy immediately on setLocale (en -> zh-CN -> en)', { timeout: 60_000 }, async () => {
  const store = sidebarStore({ locale: 'en' })
  function Harness(): React.JSX.Element {
    return e(HelmxExternalStoreContext.Provider, { value: store }, e(Sidebar))
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  try {
    await act(async () => { root.render(e(Harness)) })
    const groupTitle = host.querySelector('.sidebar-overview-group .sidebar-group-by-label')
    assert.ok(groupTitle !== null, 'working set group-by switcher renders')
    assert.equal(groupTitle.textContent, 'By status', 'renders the en catalog copy by default')

    await act(async () => { store.setLocale('zh-CN') })
    assert.equal(store.getPrefsSlice().locale, 'zh-CN')
    const groupTitleZh = host.querySelector('.sidebar-overview-group .sidebar-group-by-label')
    assert.ok(groupTitleZh !== null)
    assert.equal(groupTitleZh.textContent, '按状态', 'locale switch re-renders shell chrome in place')

    await act(async () => { store.setLocale('en') })
    assert.equal(store.getPrefsSlice().locale, 'en')
    assert.equal(host.querySelector('.sidebar-overview-group .sidebar-group-by-label')?.textContent, 'By status', 'switching back to en restores English immediately')
  } finally {
    localStorage.removeItem('helmx:locale')
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('ActivityRail StatusDot renders unified StatusLight with role="img", aria-label, data-tone and tooltip', { timeout: 60_000 }, () => {
  const connectedHtml = renderSidebar(sidebarStore({ sseConnected: true, locale: 'en' }))
  const connectedBrand = connectedHtml.match(/<div class="activity-rail-brand"[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.ok(connectedBrand.includes('class="activity-rail-status-light"'), 'wraps StatusLight with positioning class')
  assert.ok(connectedBrand.includes('role="img"'), 'StatusLight exposes role="img"')
  assert.ok(connectedBrand.includes('data-tone="done"'), 'connected SSE renders tone="done"')
  assert.ok(connectedBrand.includes('aria-label="Live connection healthy"'), 'connected SSE exposes accessible label')
  assert.ok(connectedBrand.includes('title="Live connection healthy"'), 'connected SSE preserves hover tooltip')

  const disconnectedHtml = renderSidebar(sidebarStore({ sseConnected: false, locale: 'en' }))
  const disconnectedBrand = disconnectedHtml.match(/<div class="activity-rail-brand"[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.ok(disconnectedBrand.includes('role="img"'), 'disconnected StatusLight exposes role="img"')
  assert.ok(disconnectedBrand.includes('data-tone="idle"'), 'disconnected SSE renders tone="idle"')
  assert.ok(
    disconnectedBrand.includes('aria-label="Live connection lost, reconnecting"'),
    'disconnected SSE exposes accessible label',
  )
  assert.ok(
    disconnectedBrand.includes('title="Live connection lost, reconnecting"'),
    'disconnected SSE preserves hover tooltip',
  )
})
