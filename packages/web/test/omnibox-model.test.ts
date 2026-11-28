/**
 * Pure unit tests for the clean-slate Helmx Omnibox engine (zero DOM):
 * - Query prefix parsing (`>` / `#`, `#id` pin, never hijacking `:` or `@`)
 * - Bilingual matching, acronym & fuzzy scoring, accurate UTF-16 highlight spans
 * - Bounded localStorage frecency LRU (max 32, zero sensitive text)
 * - Full 0ms local source builders (5 centers + sub-tabs, providers w/ model reverse search,
 *   single-entity dedup for profiles & screen-bearing plugins, skills, nodes, plugins,
 *   core:* actions, settingsPanels, pluginConfigCatalog, workbenchPanels, commands)
 * - Anti-chaos ranking invariants (empty state curation, grouped Top-K quotas,
 *   Sync-Upper / Async-Lower physical separation, View-All scope jumps)
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  ActionManifest,
  ConversationSummary,
  NodeInfo,
  OmniboxPluginHit,
  PluginConfigCatalogEntry,
  PluginSummary,
  Profile,
  ProviderConfig,
  SkillSummary,
} from '@helmx/protocol/browser'
import { createWebTranslator } from '../src/i18n/catalog.js'
import type { ModelDescriptor } from '../src/lib/api.js'
import type { StorageReader, StorageRemover, StorageWriter } from '../src/lib/storage.js'
import type { GroupedUiSpecs } from '../src/lib/types.js'
import {
  computeFrecencyBonus,
  loadFrecencyEntries,
  MAX_OMNIBOX_FRECENCY_ENTRIES,
  OMNIBOX_FRECENCY_STORAGE_KEY,
  recordFrecencyUse,
} from '../src/omnibox/frecency.js'
import {
  parseOmniboxQuery,
  resolveNextOmniboxScope,
  resolveOmniboxEscapeAction,
  resolveSnippetHighlightSegments,
  resolveTitleHighlightSegments,
} from '../src/omnibox/matcher.js'
import { ALL_SCOPE_QUOTAS, buildOmniboxView } from '../src/omnibox/ranker.js'
import { buildContextCommandItems, buildUtilityAndPluginCommandItems } from '../src/omnibox/sources/commands.js'
import {
  buildAsyncMessageItems,
  buildLocalConversationItems,
  buildRecentConversationItems,
} from '../src/omnibox/sources/conversations.js'
import { buildNavigationItems } from '../src/omnibox/sources/navigation.js'
import { buildAsyncPluginResourceItems } from '../src/omnibox/sources/plugin-resources.js'
import { buildSettingsItems } from '../src/omnibox/sources/settings.js'
import { buildWorkbenchItems } from '../src/omnibox/sources/workbench.js'
import type { OmniboxItem } from '../src/omnibox/types.js'

const tEn = createWebTranslator('en')
const tZh = createWebTranslator('zh-CN')

function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `Topic ${id}`,
    profileId: 'coder',
    tags: [],
    ownedBy: 'human',
    nodeId: 'local',
    cwd: '/work',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...overrides,
  }
}

type MemoryStorage = StorageReader & StorageWriter & StorageRemover & { store: Map<string, string> }

function makeMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  }
}

describe('omnibox-model', () => {
  test('prefix parsing honors > and # ONLY and never hijacks : or @', { timeout: 60_000 }, () => {
    const cmd = parseOmniboxQuery('> theme dark', 'all')
    assert.equal(cmd.prefixMode, '>')
    assert.equal(cmd.effectiveScope, 'commands')
    assert.equal(cmd.searchText, 'theme dark')

    const conv = parseOmniboxQuery('# deploy', 'all')
    assert.equal(conv.prefixMode, '#')
    assert.equal(conv.effectiveScope, 'conversations')
    assert.equal(conv.searchText, 'deploy')
    assert.equal(conv.exactConversationId, null)

    const exactId = parseOmniboxQuery('#42', 'all')
    assert.equal(exactId.prefixMode, '#')
    assert.equal(exactId.effectiveScope, 'conversations')
    assert.equal(exactId.exactConversationId, 42)
    assert.equal(exactId.searchText, '42')

    const colonQuery = parseOmniboxQuery('builtin:workflow', 'all')
    assert.equal(colonQuery.prefixMode, null)
    assert.equal(colonQuery.effectiveScope, 'all')
    assert.equal(colonQuery.searchText, 'builtin:workflow')

    const atQuery = parseOmniboxQuery('@gpu-1', 'all')
    assert.equal(atQuery.prefixMode, null)
    assert.equal(atQuery.effectiveScope, 'all')
    assert.equal(atQuery.searchText, '@gpu-1')
  })

  test('scope cycling and layered Escape action cover all states', { timeout: 60_000 }, () => {
    assert.equal(resolveNextOmniboxScope('all', 1), 'pages')
    assert.equal(resolveNextOmniboxScope('pages', 1), 'commands')
    assert.equal(resolveNextOmniboxScope('commands', 1), 'conversations')
    assert.equal(resolveNextOmniboxScope('conversations', 1), 'all')
    assert.equal(resolveNextOmniboxScope('all', -1), 'conversations')

    assert.equal(
      resolveOmniboxEscapeAction({ isComposing: true, hasPreview: true, query: 'x', scope: 'pages' }),
      'ignore-ime',
    )
    assert.equal(
      resolveOmniboxEscapeAction({ isComposing: false, hasPreview: true, query: 'x', scope: 'pages' }),
      'close-preview',
    )
    assert.equal(
      resolveOmniboxEscapeAction({ isComposing: false, hasPreview: false, query: 'x', scope: 'pages' }),
      'clear-query',
    )
    assert.equal(
      resolveOmniboxEscapeAction({ isComposing: false, hasPreview: false, query: '', scope: 'pages' }),
      'reset-scope',
    )
    assert.equal(
      resolveOmniboxEscapeAction({ isComposing: false, hasPreview: false, query: '', scope: 'all' }),
      'close-modal',
    )
  })

  test('bilingual matching, acronym scoring (pf / md), and honest snippet highlights', { timeout: 60_000 }, () => {
    const plugins: PluginSummary[] = [
      {
        id: 'builtin:port-forward',
        name: { en: 'Port Forward', 'zh-CN': '端口转发' },
        version: '0.1.0',
        enabled: true,
        hooks: [],
        actions: [],
        tools: [],
      },
    ]
    const screens: GroupedUiSpecs['screens'] = [
      {
        pluginId: 'builtin:port-forward',
        spec: {
          id: 'tunnels',
          label: { en: 'Port Forward', 'zh-CN': '端口转发' },
          description: { en: 'Manage TCP tunnels', 'zh-CN': '管理 TCP 端口映射' },
          keywords: ['tunnel', 'tcp'],
        },
      },
    ]

    const pageItems = buildNavigationItems({
      profiles: [],
      enabledPluginIds: new Set(['builtin:port-forward']),
      screens,
      plugins,
      providers: [],
      credentials: [],
      models: [],
      skills: [],
      nodes: [],
      actions: [],
      locale: 'en',
      t: tEn,
    })

    // Acronym `pf` matches Port Forward with exact character highlights on P and F
    const pfView = buildOmniboxView({
      query: 'pf',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    const pfHit = pfView.rows.find((row) => row.id === 'view:builtin:port-forward/tunnels')
    assert.ok(pfHit !== undefined, 'pf acronym must match Port Forward screen')
    const pfSegs = resolveTitleHighlightSegments(pfHit.title, pfHit.titleHighlights, 'pf')
    assert.deepEqual(
      pfSegs.filter((s) => s.highlighted).map((s) => s.text),
      ['P', 'F'],
    )

    // Bilingual query: Chinese query under English UI locale still finds Port Forward
    const zhUnderEn = buildOmniboxView({
      query: '端口转发',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    assert.ok(zhUnderEn.rows.some((row) => row.id === 'view:builtin:port-forward/tunnels'))

    // Acronym `md` matches Models Defaults (`models/defaults`)
    const mdView = buildOmniboxView({
      query: 'md',
      scope: 'pages',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    assert.ok(mdView.rows.some((row) => row.id === 'builtin:open-models-defaults'))

    // Honest backend snippet highlights: empty array [] must NEVER fabricate highlights
    assert.deepEqual(resolveSnippetHighlightSegments('Title match only', [], 'title'), [
      { text: 'Title match only', highlighted: false },
    ])
    assert.deepEqual(resolveSnippetHighlightSegments('Deploy alpha now', [{ start: 7, end: 12 }], 'alpha'), [
      { text: 'Deploy ', highlighted: false },
      { text: 'alpha', highlighted: true },
      { text: ' now', highlighted: false },
    ])
  })

  test('frecency bounded LRU caps at 32 entries, stores only id/count/lastUsedAt, and boosts ranking', { timeout: 60_000 }, () => {
    const storage = makeMemoryStorage()
    let entries = loadFrecencyEntries(storage)
    assert.deepEqual(entries, [])

    const DAY_MS = 24 * 60 * 60 * 1000
    for (let i = 1; i <= 40; i += 1) {
      entries = recordFrecencyUse(entries, `item:${i}`, i * DAY_MS, storage)
    }
    assert.equal(entries.length, MAX_OMNIBOX_FRECENCY_ENTRIES)
    assert.equal(entries[0]?.id, 'item:40')
    assert.equal(entries.some((e) => e.id === 'item:1'), false)

    // Stored JSON contains ONLY { id, count, lastUsedAt } — zero titles or query text
    const raw = JSON.parse(storage.store.get(OMNIBOX_FRECENCY_STORAGE_KEY) ?? '[]') as Array<Record<string, unknown>>
    assert.equal(raw.length, MAX_OMNIBOX_FRECENCY_ENTRIES)
    for (const row of raw) {
      assert.deepEqual(Object.keys(row).sort(), ['count', 'id', 'lastUsedAt'])
    }

    // Reload round-trip and ranking bonus (newer entry decays less than 31-day-older entry)
    const reloaded = loadFrecencyEntries(storage)
    assert.equal(reloaded.length, MAX_OMNIBOX_FRECENCY_ENTRIES)
    assert.ok(
      computeFrecencyBonus(reloaded[0], 40 * DAY_MS) >
        computeFrecencyBonus(reloaded[reloaded.length - 1], 40 * DAY_MS),
    )
  })

  test('full 0ms local sources: sub-tabs, provider model reverse search, single-entity dedup, config catalog, settings panels, workbench, core actions', { timeout: 60_000 }, () => {
    const profiles: Profile[] = [
      { id: 'coder', name: 'Coder', model: 'anthropic/claude-sonnet-4' },
    ]
    const plugins: PluginSummary[] = [
      {
        id: 'builtin:workflow',
        name: { en: 'Workflow', 'zh-CN': '工作流' },
        version: '0.1.0',
        enabled: true,
        hooks: [],
        actions: [],
        tools: [],
      },
      {
        id: 'builtin:memory',
        name: { en: 'Memory', 'zh-CN': '记忆' },
        version: '0.1.0',
        enabled: false,
        hooks: [],
        actions: [],
        tools: [],
      },
    ]
    const screens: GroupedUiSpecs['screens'] = [
      {
        pluginId: 'builtin:workflow',
        spec: {
          id: 'runs',
          label: { en: 'Workflow Runs', 'zh-CN': '工作流运行' },
          description: { en: 'Inspect workflow runs', 'zh-CN': '查看工作流运行状态' },
          keywords: ['pipeline', 'dag'],
        },
      },
    ]
    const settingsPanels: GroupedUiSpecs['settingsPanels'] = [
      {
        pluginId: 'builtin:memory',
        spec: {
          id: 'index-stats',
          label: { en: 'Memory Index Stats', 'zh-CN': '记忆索引统计' },
          description: { en: 'Inspect vector index health', 'zh-CN': '查看记忆向量索引状态' },
          keywords: ['fts', 'embeddings'],
        },
      },
    ]
    const pluginConfigCatalog: PluginConfigCatalogEntry[] = [
      {
        pluginId: 'builtin:memory',
        pluginName: { en: 'Memory', 'zh-CN': '记忆' },
        enabled: false,
        fields: [
          {
            key: 'retentionDays',
            type: 'number',
            secret: false,
            required: false,
            label: { en: 'Retention Days', 'zh-CN': '保留天数' },
            description: { en: 'Days to keep daily memory notes', 'zh-CN': '每日记忆保留天数' },
          },
        ],
      },
    ]
    const providers: ProviderConfig[] = [
      {
        id: 'my-gateway',
        label: 'My Gateway',
        baseUrl: 'https://gw.example.com/v1',
        protocol: 'openai',
        models: ['claude-3-7-sonnet'],
        enabled: true,
      },
    ]
    const models: ModelDescriptor[] = [
      {
        id: 'my-gateway/claude-3-7-sonnet',
        provider: 'my-gateway',
        modelId: 'claude-3-7-sonnet',
        label: 'Claude 3.7 Sonnet',
        available: true,
        thinkingLevels: [],
      },
    ]
    const skills: SkillSummary[] = [
      {
        id: 'deploy-runbook',
        name: 'Deploy Runbook',
        description: 'Production rollout checklist',
        source: 'data',
        references: [],
      },
    ]
    const nodes: NodeInfo[] = [
      { id: 'gpu-1', hostname: 'gpu-box', platform: 'linux', kind: 'byom', online: false },
    ]
    const actions: ActionManifest[] = [
      {
        pluginId: 'core:host',
        id: 'info',
        description: 'Inspect hub status',
        inputSchema: {},
        outputSchema: {},
      },
    ]

    const navItems = buildNavigationItems({
      profiles,
      enabledPluginIds: new Set(['builtin:workflow']),
      screens,
      plugins,
      providers,
      credentials: [],
      models,
      skills,
      nodes,
      actions,
      locale: 'en',
      t: tEn,
    })
    const settingsItems = buildSettingsItems({
      settingsPanels,
      pluginConfigCatalog,
      plugins,
      locale: 'en',
      t: tEn,
    })
    const pageItems = [...navItems, ...settingsItems]

    // 1) Overview archived + models defaults + plugins core present
    assert.ok(pageItems.some((i) => i.id === 'builtin:overview-archived'))
    const defaultsItem = pageItems.find((i) => i.id === 'builtin:open-models-defaults')
    assert.ok(defaultsItem?.intent.type === 'navigate' && defaultsItem.intent.focusAnchor === 'models:defaults')
    assert.ok(pageItems.some((i) => i.id === 'builtin:open-plugins-core'))

    // 2) Single-entity dedup on Profile: All scope primary = agent standby, secondary = profile settings;
    //    Pages scope or setting intent swaps primary to profile settings!
    const coderAll = buildOmniboxView({
      query: 'coder',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    }).rows.find((r) => r.id === 'profile:coder')
    assert.ok(coderAll !== undefined)
    assert.deepEqual(coderAll.intent, { type: 'navigate', target: { kind: 'agent', profileId: 'coder' } })
    assert.deepEqual(coderAll.secondaryAction?.intent, {
      type: 'navigate',
      target: { kind: 'profiles', profileId: 'coder' },
    })

    const coderPages = buildOmniboxView({
      query: 'coder',
      scope: 'pages',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    }).rows.find((r) => r.id === 'profile:coder')
    assert.deepEqual(coderPages?.intent, { type: 'navigate', target: { kind: 'profiles', profileId: 'coder' } })
    assert.deepEqual(coderPages?.secondaryAction?.intent, {
      type: 'navigate',
      target: { kind: 'agent', profileId: 'coder' },
    })

    const coderSettingQuery = buildOmniboxView({
      query: 'coder settings',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    }).rows.find((r) => r.id === 'profile:coder')
    assert.deepEqual(coderSettingQuery?.intent, {
      type: 'navigate',
      target: { kind: 'profiles', profileId: 'coder' },
    })

    // 3) Single-entity dedup on screen-bearing plugin (`builtin:workflow` has NO duplicate plugin-detail row)
    assert.equal(pageItems.some((i) => i.id === 'plugin-detail:builtin:workflow'), false)
    const wfRow = pageItems.find((i) => i.id === 'view:builtin:workflow/runs')
    assert.deepEqual(wfRow?.secondaryAction?.intent, {
      type: 'navigate',
      target: { kind: 'plugins', pluginId: 'builtin:workflow' },
    })

    // 4) Non-screen disabled plugin carries Disabled badge
    const memRow = pageItems.find((i) => i.id === 'plugin-detail:builtin:memory')
    assert.equal(memRow?.statusBadge?.label, 'Disabled')

    // 5) Provider reverse model search enriches subtitle with matched model
    const providerView = buildOmniboxView({
      query: 'claude-3-7',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
      formatMatchedModelSubtitle: (modelName, sub) => `Model: ${modelName}${sub ? ` · ${sub}` : ''}`,
    })
    const gwHit = providerView.rows.find((r) => r.id === 'provider:my-gateway')
    assert.ok(gwHit !== undefined)
    assert.ok(gwHit.subtitle?.includes('Model: Claude 3.7 Sonnet'))

    // 6) Skill, offline Node, core:* action, settingsPanel focusAnchor, pluginConfigCatalog focusAnchor
    assert.ok(pageItems.some((i) => i.id === 'skill:deploy-runbook'))
    const nodeItem = pageItems.find((i) => i.id === 'node:gpu-1')
    assert.equal(nodeItem?.statusBadge?.label, 'Offline')
    assert.ok(pageItems.some((i) => i.id === 'core-action:core:host/info'))

    const panelItem = pageItems.find((i) => i.id === 'settings-panel:builtin:memory/index-stats')
    assert.deepEqual(panelItem?.intent, {
      type: 'navigate',
      target: { kind: 'plugins', pluginId: 'builtin:memory' },
      focusAnchor: 'panel:builtin:memory/index-stats',
    })

    const cfgItem = pageItems.find((i) => i.id === 'plugin-config:builtin:memory/retentionDays')
    assert.deepEqual(cfgItem?.intent, {
      type: 'navigate',
      target: { kind: 'plugins', pluginId: 'builtin:memory' },
      focusAnchor: 'config:builtin:memory/retentionDays',
    })

    // 7) Workbench panels scoped to active conversation + plugin command `target` navigation
    const activeConv = makeConv(7)
    const wbItems = buildWorkbenchItems({
      activeConversation: activeConv,
      workbenchPanels: [
        { pluginId: 'builtin:changes', spec: { id: 'diff', label: { en: 'Changes', 'zh-CN': '变更' } } },
      ],
      plugins,
      locale: 'en',
      t: tEn,
    })
    assert.deepEqual(
      wbItems.map((i) => i.intent),
      [
        { type: 'workbench', tab: 'artifacts', conversationId: 7 },
        { type: 'workbench', tab: 'plugin:builtin:changes/diff', conversationId: 7 },
      ],
    )
    assert.deepEqual(
      buildWorkbenchItems({ activeConversation: undefined, workbenchPanels: [], plugins, locale: 'en', t: tEn }),
      [],
    )

    const cmds = buildUtilityAndPluginCommandItems({
      scopedPluginCommands: [
        {
          pluginId: 'builtin:workflow',
          spec: {
            id: 'open-runs',
            title: { en: 'Jump to Workflow Runs', 'zh-CN': '打开工作流运行' },
            target: 'screen:builtin:workflow/runs?tab=active',
          },
        },
      ],
      conversations: [activeConv],
      locale: 'en',
      sidebarCollapsed: true,
      themePreference: 'dark',
      localePref: 'auto',
      quietNotifyEnabled: true,
      onInvokePluginCommand: () => {},
      openTargetRaw: () => {},
      openShortcuts: () => {},
      toggleTheme: () => {},
      setLocale: () => {},
      setQuietNotify: async () => {},
      t: tEn,
    })
    const targetCmd = cmds.find((c) => c.id === 'plugin:builtin:workflow/open-runs')
    assert.deepEqual(targetCmd?.intent, {
      type: 'navigate',
      target: { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs', params: { tab: 'active' } },
    })
    assert.equal(cmds.find((c) => c.id === 'builtin:toggle-sidebar')?.statusBadge?.label, 'Collapsed')
    assert.equal(cmds.find((c) => c.id === 'builtin:toggle-quiet-notify')?.statusBadge?.label, 'On')
    assert.ok(cmds.some((c) => c.id === 'builtin:create-profile'))
    assert.ok(cmds.some((c) => c.id === 'builtin:create-model-gateway'))
    assert.ok(cmds.some((c) => c.id === 'builtin:create-node'))
  })

  test('anti-chaos ranking: empty state is curated, non-empty All enforces Top-K quotas & Sync-Upper / Async-Lower isolation', { timeout: 60_000 }, () => {
    const manyPages: OmniboxItem[] = Array.from({ length: 12 }, (_, idx) => ({
      id: `skill:deploy-${idx}`,
      kind: 'page',
      scope: 'pages',
      group: 'pages',
      title: `Deploy Skill ${idx}`,
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: { primary: [`Deploy Skill ${idx}`], aliases: ['deploy'] },
      intent: { type: 'navigate', target: { kind: 'skills', skillId: `deploy-${idx}` } },
    }))
    const visiblePage: OmniboxItem = {
      id: 'builtin:open-overview',
      kind: 'page',
      scope: 'pages',
      group: 'pages',
      title: 'Open conversation overview',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: { primary: ['Open conversation overview'] },
      intent: { type: 'navigate', target: { kind: 'overview' } },
    }
    const convs = Array.from({ length: 8 }, (_, idx) => makeConv(idx + 1, { title: `Deploy chat ${idx + 1}` }))
    const recentConvs = buildRecentConversationItems(convs, undefined, new Map(), tEn)
    const localConvs = buildLocalConversationItems(convs, tEn)

    // 1) Empty state NEVER dumps the 12 non-emptyStateVisible skills, but recalls recent visited page via frecency!
    const emptyView = buildOmniboxView({
      query: '',
      scope: 'all',
      contextItems: buildContextCommandItems({
        activeTarget: { kind: 'overview' },
        activePanel: 'primary',
        workbenchOpen: false,
        conversations: convs,
        profiles: [],
        locale: 'en',
        splitTarget: null,
        setWorkbenchOpen: () => {},
        closeSplit: () => {},
        t: tEn,
      }),
      recentConversationItems: recentConvs,
      pageItems: [visiblePage, ...manyPages],
      commandItems: [],
      conversationItems: localConvs,
      asyncPluginItems: [],
      asyncMessageItems: [],
      frecencyEntries: [{ id: 'skill:deploy-3', count: 2, lastUsedAt: 9999 }],
    })
    assert.deepEqual(
      emptyView.sections.map((s) => s.key),
      ['context', 'recent', 'quick'],
    )
    assert.ok(
      emptyView.sections[1]!.items.some((i) => i.id === 'skill:deploy-3'),
      'recent section recalls recently visited setting/skill via frecency',
    )
    assert.equal(
      emptyView.rows.filter((r) => r.id.startsWith('skill:deploy-')).length,
      1,
      'empty state must never dump all hidden skills',
    )

    // 2) Non-empty All scope enforces Top-K quotas + View-All metadata + Sync-Upper / Async-Lower order
    const pluginHits: OmniboxPluginHit[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `builtin:workflow/run-${idx}`,
      pluginId: 'builtin:workflow',
      itemId: `run-${idx}`,
      kind: 'resource',
      title: { en: `Deploy Run ${idx}`, 'zh-CN': `部署运行 ${idx}` },
      target: `screen:builtin:workflow/runs?runId=run-${idx}`,
      score: 90 - idx,
    }))
    // Invalid target must be dropped cleanly
    pluginHits.push({
      id: 'builtin:workflow/bad',
      pluginId: 'builtin:workflow',
      itemId: 'bad',
      title: 'Broken target',
      target: 'javascript:alert(1)',
      score: 100,
    })

    const asyncPluginItems = buildAsyncPluginResourceItems(pluginHits, convs, [], 'en')
    assert.equal(asyncPluginItems.length, 6)

    const asyncMessageItems = buildAsyncMessageItems(
      Array.from({ length: 6 }, (_, idx) => ({
        conversationId: 100 + idx,
        entryId: `e${idx}`,
        title: `Archive ${idx}`,
        snippet: `deploy pipeline log ${idx}`,
      })),
      convs,
      tEn,
    )

    const searchView = buildOmniboxView({
      query: 'deploy',
      scope: 'all',
      contextItems: [],
      recentConversationItems: recentConvs,
      pageItems: [visiblePage, ...manyPages],
      commandItems: [],
      conversationItems: localConvs,
      asyncPluginItems,
      asyncMessageItems,
    })

    assert.deepEqual(
      searchView.sections.map((s) => s.key),
      ['pages', 'conversations', 'resources', 'messages'],
    )
    const pagesSec = searchView.sections.find((s) => s.key === 'pages')!
    const convsSec = searchView.sections.find((s) => s.key === 'conversations')!
    const resSec = searchView.sections.find((s) => s.key === 'resources')!
    const msgSec = searchView.sections.find((s) => s.key === 'messages')!
    assert.equal(pagesSec.items.length, ALL_SCOPE_QUOTAS.pages)
    assert.equal(pagesSec.viewAllScope, 'pages')
    assert.equal(convsSec.items.length, ALL_SCOPE_QUOTAS.conversations)
    assert.equal(convsSec.viewAllScope, 'conversations')
    assert.equal(resSec.items.length, ALL_SCOPE_QUOTAS.resources)
    assert.equal(resSec.zone, 'async')
    assert.equal(msgSec.items.length, ALL_SCOPE_QUOTAS.messages)
    assert.equal(msgSec.zone, 'async')

    // All sync sections strictly precede async sections
    const firstAsyncIdx = searchView.rows.findIndex((r) => r.isAsync === true)
    const lastSyncIdx = searchView.rows.map((r) => r.isAsync !== true).lastIndexOf(true)
    assert.ok(firstAsyncIdx > lastSyncIdx)

    // 3) `#3` exact pin promotes conversation #3 to Top Hit
    const pinView = buildOmniboxView({
      query: '#3',
      scope: 'all',
      contextItems: [],
      recentConversationItems: recentConvs,
      pageItems: [],
      commandItems: [],
      conversationItems: localConvs,
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    assert.equal(pinView.effectiveScope, 'conversations')
    assert.equal(pinView.rows[0]?.id, 'conv:3')

    // Exact title match in `all` scope promotes Top Hit (zh-CN locale check too)
    const exactTitleView = buildOmniboxView({
      query: 'Deploy Skill 2',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems: manyPages,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    assert.equal(exactTitleView.sections[0]?.key, 'top-hit')
    assert.equal(exactTitleView.sections[0]?.items[0]?.id, 'skill:deploy-2')
    assert.equal(tZh('modals.omnibox.scope.all'), '全部')
  })

  test('regressions: empty-state frecency dedup, view:* swap only on setting intent, no false View-all, strict #id FTS filter', { timeout: 60_000 }, () => {
    const plugins: PluginSummary[] = [
      {
        id: 'builtin:workflow',
        name: { en: 'Workflow', 'zh-CN': '工作流' },
        version: '0.1.0',
        enabled: true,
        hooks: [],
        actions: [],
        tools: [],
      },
    ]
    const screens: GroupedUiSpecs['screens'] = [
      {
        pluginId: 'builtin:workflow',
        spec: {
          id: 'library',
          label: { en: 'Workflow Library', 'zh-CN': '工作流库' },
          description: { en: 'Browse saved workflows', 'zh-CN': '浏览已保存工作流' },
          keywords: ['workflow', 'pipeline'],
        },
      },
    ]
    const pageItems = buildNavigationItems({
      profiles: [{ id: 'coder', name: 'Coder' }],
      enabledPluginIds: new Set(['builtin:workflow']),
      screens,
      plugins,
      providers: [],
      credentials: [],
      models: [],
      skills: [],
      nodes: [],
      actions: [],
      locale: 'en',
      t: tEn,
    })

    // 1) Empty-state `all` dedup: frecency pointing to an `emptyStateVisible: true` page (`builtin:open-overview` & `view:builtin:workflow/library`)
    //    must appear ONCE (in `recent`), NEVER duplicated in `quick`, and `scopeCounts.all` matches emitted row count exactly.
    const emptyDedup = buildOmniboxView({
      query: '',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
      frecencyEntries: [
        { id: 'builtin:open-overview', count: 5, lastUsedAt: 20_000 },
        { id: 'view:builtin:workflow/library', count: 3, lastUsedAt: 10_000 },
      ],
    })
    const emptyIds = emptyDedup.rows.map((r) => r.id)
    assert.equal(new Set(emptyIds).size, emptyIds.length, 'empty-state rows must never contain duplicate IDs')
    assert.equal(emptyDedup.scopeCounts.all, emptyDedup.rows.length)
    const recentSec = emptyDedup.sections.find((s) => s.key === 'recent')!
    const quickSec = emptyDedup.sections.find((s) => s.key === 'quick')!
    assert.ok(recentSec.items.some((i) => i.id === 'builtin:open-overview'))
    assert.ok(recentSec.items.some((i) => i.id === 'view:builtin:workflow/library'))
    assert.equal(quickSec.items.some((i) => i.id === 'builtin:open-overview'), false)
    assert.equal(quickSec.items.some((i) => i.id === 'view:builtin:workflow/library'), false)

    // 2) Plugin Screen `view:*` stays primary = screen in `pages` scope (empty & `'workflow'`),
    //    swapping to `#/settings/plugins/<id>` ONLY on explicit setting intent (`'workflow settings'`).
    const emptyPagesView = buildOmniboxView({
      query: '',
      scope: 'pages',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    })
    const wfEmptyPages = emptyPagesView.rows.find((r) => r.id === 'view:builtin:workflow/library')
    assert.deepEqual(wfEmptyPages?.intent, {
      type: 'navigate',
      target: { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'library' },
    })
    const coderEmptyPages = emptyPagesView.rows.find((r) => r.id === 'profile:coder')
    assert.deepEqual(coderEmptyPages?.intent, {
      type: 'navigate',
      target: { kind: 'profiles', profileId: 'coder' },
    })

    const wfPagesQuery = buildOmniboxView({
      query: 'workflow',
      scope: 'pages',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    }).rows.find((r) => r.id === 'view:builtin:workflow/library')
    assert.deepEqual(wfPagesQuery?.intent, {
      type: 'navigate',
      target: { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'library' },
    })

    const wfSettingsIntent = buildOmniboxView({
      query: 'workflow settings',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems: [],
      asyncMessageItems: [],
    }).rows.find((r) => r.id === 'view:builtin:workflow/library')
    assert.deepEqual(wfSettingsIntent?.intent, {
      type: 'navigate',
      target: { kind: 'plugins', pluginId: 'builtin:workflow' },
    })

    // 3) No false "View all N · Tab" when sync section is NOT truncated (even if async plugin items exist in the same scope)
    const asyncPluginItems = buildAsyncPluginResourceItems(
      [
        {
          id: 'builtin:workflow/wf-1',
          pluginId: 'builtin:workflow',
          itemId: 'wf-1',
          kind: 'resource',
          title: 'Workflow Alpha',
          target: 'screen:builtin:workflow/library?wf=wf-1',
          score: 90,
        },
      ],
      [],
      plugins,
      'en',
    )
    const nonTruncatedView = buildOmniboxView({
      query: 'workf',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems,
      commandItems: [],
      conversationItems: [],
      asyncPluginItems,
      asyncMessageItems: [],
    })
    const pagesSec = nonTruncatedView.sections.find((s) => s.key === 'pages')
    assert.ok(pagesSec !== undefined)
    assert.equal(pagesSec.items.length, 1)
    assert.equal(pagesSec.totalCount, 2)
    assert.equal(pagesSec.viewAllScope, undefined, 'non-truncated sync section must not show View all button')

    // 4) Strict `#42` pin excludes unrelated FTS messages mentioning "42" from other conversations
    const convs = [makeConv(42, { title: 'Target thread' }), makeConv(99, { title: 'Other thread' })]
    const pinWithMessages = buildOmniboxView({
      query: '#42',
      scope: 'all',
      contextItems: [],
      recentConversationItems: [],
      pageItems: [],
      commandItems: [],
      conversationItems: buildLocalConversationItems(convs, tEn),
      asyncPluginItems: [],
      asyncMessageItems: buildAsyncMessageItems(
        [
          { conversationId: 99, entryId: 'e-other', title: 'Other thread', snippet: 'mentions 42' },
          { conversationId: 42, entryId: 'e-same', title: 'Target thread', snippet: 'inside 42' },
        ],
        convs,
        tEn,
      ),
    })
    assert.equal(pinWithMessages.rows.some((r) => r.id === 'msg:99:e-other'), false)
    assert.equal(pinWithMessages.rows.some((r) => r.id === 'msg:42:e-same'), true)
  })
})
