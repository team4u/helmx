import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Profile, SkillSummary } from '@helmx/protocol'
import { ensureHappyDom, typeIntoControl, waitForCondition } from './helpers/dom-harness.js'
import {
  buildProfileCategoryCounts,
  buildProfileCategoryTabs,
  dedupeProfileRuntimeSpecs,
  filterProfiles,
  findProfileRuntimeSpec,
  formatProfileLocation,
  formatShortModelName,
  isSystemProfile,
  profileIdValid,
  resolveEffectiveProfileModel,
  resolveProfileModel,
  runtimeCategoryTabKey,
  summarizeProfileActivity,
  summarizeProfiles,
} from '../src/profiles/profile-center-model.js'
import { ProfileCard } from '../src/profiles/ProfileCard.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { ProfileCenter } from '../src/profiles/ProfileCenter.js'
import type { NodeInfo, PluginSummary, PluginUiContribution, ProfileRuntimeUiSpec } from '@helmx/protocol/browser'
import type { ModelDescriptor } from '../src/lib/api.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { groupUiContributions, type QualifiedUiSpec } from '../src/lib/types.js'
import { PROFILE_DETAIL_SECTION_SLOT } from '@helmx/protocol'

ensureHappyDom()

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

// ---------------------------------------------------------------------------
// Mock profiles and asset fixtures
// ---------------------------------------------------------------------------

const mockProfiles: [Profile, Profile, Profile, Profile, Profile] = [
  {
    id: 'superagent',
    name: 'SuperAgent 中枢',
    description: '系统全局总控与中枢协调路由',
    model: 'claude-3-7-sonnet',
    defaultModel: 'claude-3-7-sonnet',
    managedByPlugin: 'builtin:superagent',
    tags: ['superagent', 'router'],
    system: '你作为超级代理中枢执行总控编排',
    skills: ['search', 'bash'],
  },
  {
    id: 'watchdog',
    name: '巡检看门狗',
    description: '系统健康巡检与自愈守卫',
    model: 'gpt-4o',
    defaultModel: 'gpt-4o',
    tags: ['watchdog', 'monitor'],
    isSystem: true,
  },
  {
    id: 'herdr-worker',
    name: 'Herdr 终端专家',
    description: '外部 Herdr 终端进程对接角色',
    model: 'claude-3-5-sonnet',
    defaultModel: 'claude-3-5-sonnet',
    runtime: { kind: 'herdr', agent: 'agy' },
    tags: ['herdr', 'worker'],
    skills: undefined, // follows all available skills
  },
  {
    id: 'code-reviewer',
    name: '代码审查助手',
    description: '严格的代码规范与缺陷审查专家',
    model: 'deepseek-r1',
    defaultModel: 'deepseek-r1',
    tags: ['custom', 'dev'],
    system: '专注进行代码逻辑审查与安全检查',
    skills: ['git-commit'],
  },
  {
    id: 'plugin-bot',
    name: '插件托管机器人',
    description: '由扩展插件动态注册的角色',
    managedByPlugin: 'custom-plugin',
    tags: ['bot'],
  },
]

const mockModels: ModelDescriptor[] = [
  {
    id: 'claude-3-7-sonnet',
    provider: 'anthropic',
    modelId: 'claude-3-7-sonnet-20250219',
    available: true,
    label: 'Claude 3.7 Sonnet',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'deepseek-r1',
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    available: true,
    label: 'DeepSeek R1',
    thinkingLevels: ['off'],
  },
  {
    id: 'unconfigured-provider/unconfigured-model',
    provider: 'unconfigured-provider',
    modelId: 'unconfigured-model',
    available: false,
    label: 'Unconfigured Model',
    thinkingLevels: ['off'],
  },
]

const mockSkills: SkillSummary[] = [
  { id: 'search', name: '全网检索', description: '执行网络搜索', references: [] },
  { id: 'git-commit', name: 'Git 提交助手', description: '生成规范提交信息', references: [] },
  { id: 'bash', name: 'Bash 命令执行', description: '节点环境命令驱动', references: [] },
]

const herdrRuntimeContribution: PluginUiContribution = {
  pluginId: 'builtin:herdr',
  surface: 'profile.runtime',
  spec: {
    id: 'herdr',
    kind: 'herdr',
    label: { en: 'Herdr runtime', 'zh-CN': 'Herdr 终端运行时' },
    icon: 'terminal',
    description: { en: 'Delegate turns to a Herdr terminal pane.', 'zh-CN': '将对话回合委托给 Herdr 终端窗格。' },
    agentSuggestions: ['agy', 'pi', 'codex'],
    order: 100,
  },
}

const dockerRuntimeContribution: PluginUiContribution = {
  pluginId: 'community:docker',
  surface: 'profile.runtime',
  spec: {
    id: 'docker',
    kind: 'docker',
    label: { en: 'Docker sandbox', 'zh-CN': 'Docker 沙箱' },
    icon: 'box',
    agentSuggestions: ['claude', 'opencode'],
    order: 80,
  },
}

const herdrRuntimeSpec: QualifiedUiSpec<ProfileRuntimeUiSpec> = {
  pluginId: 'builtin:herdr',
  spec: herdrRuntimeContribution.spec as ProfileRuntimeUiSpec,
}

const dockerRuntimeSpec: QualifiedUiSpec<ProfileRuntimeUiSpec> = {
  pluginId: 'community:docker',
  spec: dockerRuntimeContribution.spec as ProfileRuntimeUiSpec,
}

// ---------------------------------------------------------------------------
// 1. Pure model unit tests
// ---------------------------------------------------------------------------

test('profile-center-model: isSystemProfile classification rules', { timeout: 60_000 }, () => {
  assert.equal(isSystemProfile(mockProfiles[0]), true, 'superagent counts as a system profile')
  assert.equal(isSystemProfile(mockProfiles[1]), true, 'watchdog / isSystem=true counts as a system profile')
  assert.equal(isSystemProfile(mockProfiles[4]), true, 'managedByPlugin counts as a protected system profile')
  assert.equal(isSystemProfile(mockProfiles[2]), false, 'herdr-worker is a custom / non-system profile')
  assert.equal(isSystemProfile(mockProfiles[3]), false, 'code-reviewer is a custom profile')
})

test('profile-center-model: dynamic ctx.ui.profileRuntime tabs, deduplication, and lookup', { timeout: 60_000 }, () => {
  // Without any plugin runtime contributions, only base tabs exist (no hardcoded herdr)
  const baseTabs = buildProfileCategoryTabs([])
  assert.deepEqual(baseTabs.map((t) => t.key), ['all', 'system', 'custom'])

  // Duplicate kind keeps first occurrence and preserves order
  const dupSpec: QualifiedUiSpec<ProfileRuntimeUiSpec> = {
    pluginId: 'other:herdr',
    spec: { id: 'herdr-2', kind: 'herdr', label: 'Duplicate Herdr' },
  }
  const deduped = dedupeProfileRuntimeSpecs([herdrRuntimeSpec, dupSpec, dockerRuntimeSpec])
  assert.equal(deduped.length, 2)
  assert.equal(deduped[0]!.pluginId, 'builtin:herdr')
  assert.equal(deduped[1]!.spec.kind, 'docker')

  const tabsZh = buildProfileCategoryTabs(deduped, 'zh-CN')
  assert.deepEqual(tabsZh, [
    { key: 'all', label: 'All' },
    { key: 'system', label: 'Built-in' },
    { key: 'custom', label: 'Custom' },
    { key: 'runtime:herdr', label: 'Herdr 终端运行时' },
    { key: 'runtime:docker', label: 'Docker 沙箱' },
  ])

  assert.equal(findProfileRuntimeSpec('herdr', deduped)?.pluginId, 'builtin:herdr')
  assert.equal(findProfileRuntimeSpec('unknown', deduped), undefined)
  assert.equal(findProfileRuntimeSpec(undefined, deduped), undefined)
})

test('profile-center-model: resolveProfileModel prefers defaultModel and falls back to model', { timeout: 60_000 }, () => {
  assert.equal(resolveProfileModel({ id: 'a', defaultModel: 'm1', model: 'm2' }), 'm1')
  assert.equal(resolveProfileModel({ id: 'b', model: 'm2' }), 'm2')
  assert.equal(resolveProfileModel({ id: 'c' }), undefined)
})

test('profile-center-model: formatShortModelName strips multi-segment path prefixes and keeps the last segment', { timeout: 60_000 }, () => {
  assert.equal(
    formatShortModelName('openrouter/accounts/fireworks/models/deepseek-r1-0528'),
    'deepseek-r1-0528',
  )
  assert.equal(formatShortModelName('anthropic/claude-3-7-sonnet'), 'claude-3-7-sonnet')
  assert.equal(formatShortModelName('glm-5'), 'glm-5')
  assert.equal(formatShortModelName('provider/'), 'provider/')
  assert.equal(formatShortModelName('  '), undefined)
  assert.equal(formatShortModelName(undefined), undefined)
})

test('profile-center-model: filterProfiles category tab filtering', { timeout: 60_000 }, () => {
  const all = filterProfiles(mockProfiles, { query: '', categoryTab: 'all' })
  assert.equal(all.length, 5)

  const system = filterProfiles(mockProfiles, { query: '', categoryTab: 'system' })
  assert.equal(system.length, 3)
  assert.deepEqual(system.map((p) => p.id), ['superagent', 'watchdog', 'plugin-bot'])

  const custom = filterProfiles(mockProfiles, { query: '', categoryTab: 'custom' })
  assert.equal(custom.length, 2)
  assert.deepEqual(custom.map((p) => p.id), ['herdr-worker', 'code-reviewer'])

  const runtimeFiltered = filterProfiles(
    [...mockProfiles, { id: 'tag-only-herdr', tags: ['herdr'] }],
    { query: '', categoryTab: runtimeCategoryTabKey('herdr') },
  )
  assert.equal(runtimeFiltered.length, 1, 'runtime:<kind> tab matches Profile.runtime.kind, never a hardcoded tag')
  assert.equal(runtimeFiltered[0]!.id, 'herdr-worker')
})

test('profile-center-model: filterProfiles multi-dimension fuzzy search', { timeout: 60_000 }, () => {
  // 1. Match by ID
  const resId = filterProfiles(mockProfiles, { query: 'reviewer', categoryTab: 'all' })
  assert.equal(resId.length, 1)
  assert.equal(resId[0]!.id, 'code-reviewer')

  // 2. Match by name
  const resName = filterProfiles(mockProfiles, { query: '巡检', categoryTab: 'all' })
  assert.equal(resName.length, 1)
  assert.equal(resName[0]!.id, 'watchdog')

  // 3. Match by description
  const resDesc = filterProfiles(mockProfiles, { query: '总控与中枢', categoryTab: 'all' })
  assert.equal(resDesc.length, 1)
  assert.equal(resDesc[0]!.id, 'superagent')

  // 4. Match by tags
  const resTag = filterProfiles(mockProfiles, { query: 'dev', categoryTab: 'all' })
  assert.equal(resTag.length, 1)
  assert.equal(resTag[0]!.id, 'code-reviewer')

  // 5. Match by model / defaultModel
  const resModel = filterProfiles(mockProfiles, { query: 'deepseek', categoryTab: 'all' })
  assert.equal(resModel.length, 1)
  assert.equal(resModel[0]!.id, 'code-reviewer')

  // 6. Match the full system prompt text
  const resSystem = filterProfiles(mockProfiles, { query: '总控编排', categoryTab: 'all' })
  assert.equal(resSystem.length, 1)
  assert.equal(resSystem[0]!.id, 'superagent')

  // 7. Match by skill names
  const resSkills = filterProfiles(mockProfiles, { query: 'git-commit', categoryTab: 'all' })
  assert.equal(resSkills.length, 1)
  assert.equal(resSkills[0]!.id, 'code-reviewer')

  // 8. Search and category intersection gating
  const resCross = filterProfiles(mockProfiles, { query: '终端专家', categoryTab: 'system' })
  assert.equal(resCross.length, 0, 'searching a custom profile under the system tab must not match')
})

test('profile-center-model: buildProfileCategoryCounts and summarizeProfiles', { timeout: 60_000 }, () => {
  const baseCounts = buildProfileCategoryCounts(mockProfiles)
  assert.deepEqual(baseCounts, {
    all: 5,
    system: 3,
    custom: 2,
  })

  const withRuntimeCounts = buildProfileCategoryCounts(mockProfiles, [herdrRuntimeSpec, dockerRuntimeSpec])
  assert.deepEqual(withRuntimeCounts, {
    all: 5,
    system: 3,
    custom: 2,
    'runtime:herdr': 1,
    'runtime:docker': 0,
  })

  const summary = summarizeProfiles(mockProfiles)
  assert.deepEqual(summary, {
    total: 5,
    system: 3,
    custom: 2,
  })
})

test('profile-center-model: profileIdValid rule validation', { timeout: 60_000 }, () => {
  assert.equal(profileIdValid('code-reviewer'), true)
  assert.equal(profileIdValid('agent-1'), true)
  assert.equal(profileIdValid(''), false)
  assert.equal(profileIdValid('UPPER'), false)
  assert.equal(profileIdValid('with space'), false)
})

// ---------------------------------------------------------------------------
// 2. ProfileCard SSR rendering and zero-emoji assertions
// ---------------------------------------------------------------------------

function renderCardElement(
  props: React.ReactElement,
  uiContributions: PluginUiContribution[] = [],
): React.ReactElement {
  return e(HostStoreProviders, { value: makeTestStore({ uiContributions }) }, props)
}

test('ProfileCard: SSR structure, badges, skill pills and zero emoji', { timeout: 60_000 }, () => {
  // 1. System profile card
  const systemHtml = renderToStaticMarkup(
    renderCardElement(
      e(ProfileCard, {
        profile: mockProfiles[0],
        selected: true,
        onSelect: () => {},
      }),
    ),
  )

  assert.match(systemHtml, /class="[^"]*primary-card[^"]*is-selected[^"]*"/)
  assert.match(systemHtml, /SuperAgent 中枢/)
  assert.match(systemHtml, /superagent/)
  assert.match(systemHtml, /系统全局总控与中枢协调路由/)
  assert.match(systemHtml, /claude-3-7-sonnet/)
  assert.match(systemHtml, /2 skills/)
  assert.match(systemHtml, /系统/) // system lock pill (zh fixture name)
  assert.doesNotMatch(systemHtml, EMOJI_REGEX, 'system profile card output must contain no emoji')

  // 2. Runtime profile without plugin contribution: zero hardcoded runtime pill
  const noPluginHtml = renderToStaticMarkup(
    renderCardElement(
      e(ProfileCard, {
        profile: mockProfiles[2],
        selected: false,
        onSelect: () => {},
      }),
    ),
  )
  assert.match(noPluginHtml, /Herdr 终端专家/)
  assert.match(noPluginHtml, /All available skills/)
  assert.doesNotMatch(noPluginHtml, /Herdr runtime/)
  assert.doesNotMatch(noPluginHtml, /External runtime:/)

  // 3. Runtime profile with ctx.ui.profileRuntime contribution: dynamic label pill appears
  const withPluginHtml = renderToStaticMarkup(
    renderCardElement(
      e(ProfileCard, {
        profile: mockProfiles[2],
        selected: false,
        onSelect: () => {},
      }),
      [herdrRuntimeContribution],
    ),
  )

  assert.match(withPluginHtml, /Herdr 终端专家/)
  assert.match(withPluginHtml, /herdr-worker/)
  assert.match(withPluginHtml, /All available skills/)
  assert.match(withPluginHtml, /Herdr runtime/)
  assert.doesNotMatch(withPluginHtml, /is-selected/)
  assert.doesNotMatch(withPluginHtml, EMOJI_REGEX, 'Runtime card output must contain no emoji')
})

// ---------------------------------------------------------------------------
// 3. ProfileDetailDrawer SSR rendering and form assertions
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: edit-existing mode rendering and zero emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    models: mockModels,
    skills: mockSkills,
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3], // code-reviewer (custom)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.match(html, /代码审查助手/)
  assert.match(html, /code-reviewer/)
  assert.match(html, /严格的代码规范与缺陷审查专家/)
  assert.match(html, /System prompt \(SYSTEM\.md\)/)
  // The memory section is injected by the builtin:memory slot (absent without plugin contributions; the host hardcodes nothing)
  assert.doesNotMatch(html, /长期记忆 \(MEMORY\.md\)/)
  assert.match(html, /Available skills allowlist/)
  assert.match(html, /Save profile/)
  assert.match(html, /Delete profile/, 'custom profiles render the delete button')
  assert.doesNotMatch(html, /unconfigured-provider\/unconfigured-model/, 'unconfigured models must never appear in the profile drawer model options')
  assert.doesNotMatch(html, /Unconfigured Model/, 'unconfigured model names must never appear in the profile drawer model options')
  assert.doesNotMatch(html, EMOJI_REGEX, 'edit drawer output must contain no emoji')
})

test('ProfileDetailDrawer: system profiles are protected from deletion', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[1], // watchdog (system)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /巡检看门狗/)
  assert.match(html, /系统/) // system lock pill (zh fixture name)
  assert.doesNotMatch(html, /Delete profile/, 'built-in system profiles must not show the delete button')
  assert.doesNotMatch(html, EMOJI_REGEX, 'system profile drawer output must contain no emoji')
})

test('ProfileDetailDrawer: create-new mode with editable ID rendering', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: null,
        isNew: true,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /New agent profile/)
  assert.match(html, /Letters, digits and hyphens/)
  assert.doesNotMatch(html, /Delete profile/, 'create-new drawer must not show the delete button')
  assert.doesNotMatch(html, EMOJI_REGEX, 'create-new drawer output must contain no emoji')
})

test('ProfileDetailDrawer: model binding renders the shared SDK ModelPickerControl (no private thinking row)', { timeout: 60_000 }, () => {
  // Explicitly bound to claude-3-7-sonnet (thinkingLevels: off/low/medium/high):
  // the unified shared picker trigger carries the model (and effective level);
  // thinking chips live inside the picker popover, not a separate segmented row.
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, model: 'claude-3-7-sonnet', defaultModel: 'claude-3-7-sonnet' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  const trigger = /<button[^>]*id="profile-form-model"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? ''
  assert.ok(trigger !== '', 'the shared ModelPickerControl trigger button renders (id=profile-form-model)')
  assert.match(trigger, /claude-3-7-sonnet/)
  // The private ThinkingLevelControl segmented row is gone (single shared implementation)
  assert.doesNotMatch(html, /composer-thinking-row/)
  assert.doesNotMatch(html, /segmented-control-btn/)
  assert.doesNotMatch(html, EMOJI_REGEX)

  // Unbound model form: the trigger falls back to the follow-system-default copy
  const unbound = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, model: undefined, defaultModel: undefined },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unbound, /Follow system default/)
  assert.doesNotMatch(unbound, /segmented-control-btn/)
})

test('ProfileDetailDrawer: default node binding renders existing values with an unknown-node fallback', { timeout: 60_000 }, () => {
  const mockNodes: NodeInfo[] = [
    { id: 'local', kind: 'local', online: true },
    { id: 'dev-box', kind: 'byom', online: true },
    { id: 'standby-box', kind: 'byom', online: false },
  ]
  const store = makeTestStore({ models: mockModels, skills: mockSkills, nodes: mockNodes })

  // Existing binding: the form echoes the bound node ID
  const bound = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, nodeId: 'dev-box' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(bound, /Default node/)
  assert.match(bound, /dev-box/)

  // Unknown existing value (node deregistered): an unknown-node fallback entry is added — no value loss, no error
  const unknown = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, nodeId: 'ghost-node' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unknown, /ghost-node \(unknown node\)/)

  // Unbound: the first entry is the empty option meaning unbound (local machine)
  const unboundNode = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3],
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unboundNode, /Unbound \(local node\)/)
  assert.doesNotMatch(unboundNode, /Unknown node/)
  assert.doesNotMatch(bound, EMOJI_REGEX, 'bound-node drawer output must contain no emoji')
  assert.doesNotMatch(unknown, EMOJI_REGEX, 'unknown-node fallback output must contain no emoji')
  assert.doesNotMatch(unboundNode, EMOJI_REGEX, 'unbound-node drawer output must contain no emoji')
})

// ---------------------------------------------------------------------------
// 4. ProfileCenter primary full-screen center SSR rendering tests
// ---------------------------------------------------------------------------

test('ProfileCenter: top bar, search bar, card grid and zero emoji', { timeout: 60_000 }, () => {
  // Without profile.runtime contributions: base tabs only (no hardcoded Herdr tab)
  const baseStore = makeTestStore({
    profiles: mockProfiles,
    models: mockModels,
    skills: mockSkills,
    primaryTarget: { kind: 'profiles' },
  })
  const baseHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: baseStore },
      e(ProfileCenter, {
        isSplit: false,
        inlineDrawer: true,
      }),
    ),
  )
  assert.doesNotMatch(baseHtml, /Herdr runtime/)

  const store = makeTestStore({
    profiles: mockProfiles,
    models: mockModels,
    skills: mockSkills,
    uiContributions: [herdrRuntimeContribution],
    primaryTarget: { kind: 'profiles' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileCenter, {
        isSplit: false,
        inlineDrawer: true,
      }),
    ),
  )

  // 1. Top bar essentials
  assert.match(html, /data-view="profile-center"/)
  assert.match(html, /Agent Profile Center/)
  assert.match(html, /New profile/)

  // 2. Toolbar search and dynamic category tabs
  assert.match(html, /Search profile name, ID, model, tags or skills…/)
  assert.match(html, /All/)
  assert.match(html, /Built-in/)
  assert.match(html, /Custom/)
  assert.match(html, /Herdr runtime/)

  // 3. Card grid flow
  assert.match(html, /SuperAgent 中枢/)
  assert.match(html, /巡检看门狗/)
  assert.match(html, /Herdr 终端专家/)
  assert.match(html, /代码审查助手/)

  assert.doesNotMatch(html, EMOJI_REGEX, 'ProfileCenter output must contain no emoji anywhere')
})

test('ProfileCenter: empty-state rendering', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    profiles: [],
    primaryTarget: { kind: 'profiles' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileCenter, {
        isSplit: true,
        onCloseSplit: () => {},
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /primary-center is-split/)
  assert.match(html, /No matching profiles/)
  assert.match(html, /Try adjusting the search keywords or switching category tabs/)
  assert.doesNotMatch(html, EMOJI_REGEX, 'empty state output must contain no emoji')
})

test('ProfileCenter: zh-CN locale renders the localized center copy', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    profiles: mockProfiles,
    models: mockModels,
    skills: mockSkills,
    primaryTarget: { kind: 'profiles' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileCenter, {
        isSplit: false,
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /智能体角色中心/)
  assert.match(html, /新建角色/)
  assert.match(html, /搜索角色名称、ID、模型、标签或技能…/)
  assert.match(html, /aria-label="角色分类筛选"/)
  assert.match(html, /全部/)
  assert.match(html, /自定义/)
  assert.match(html, /绑定模型：claude-3-7-sonnet/)
  assert.match(html, /技能配置：2 个技能/)
  assert.match(html, /暂无关联会话/)
  assert.match(html, /个技能/)
  assert.match(html, /对话/)
  assert.doesNotMatch(html, /Agent Profile Center/)
  assert.doesNotMatch(html, /New profile/)
  assert.doesNotMatch(html, EMOJI_REGEX, 'zh-CN ProfileCenter output must contain no emoji')
})

test('ProfileCard: locale switches en -> zh-CN -> en immediately via setLocale', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const ReactDOMClient = await import('react-dom/client')

  // 真实 store.setLocale 驱动 prefs 领域订阅：消费方原位切换（与生产同链路）。
  const store = makeTestStore({ locale: 'en' })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  try {
    await act(async () => {
      root.render(
        React.createElement(
          HostStoreProviders,
          { value: store },
          React.createElement(ProfileCard, { profile: mockProfiles[0], onSelect: () => {} }),
        ),
      )
    })
    assert.match(host.textContent ?? '', /2 skills/)
    assert.match(host.textContent ?? '', /System/)

    await act(async () => {
      store.setLocale('zh-CN')
    })
    assert.match(host.textContent ?? '', /2 个技能/)
    assert.match(host.textContent ?? '', /系统/)
    assert.doesNotMatch(host.textContent ?? '', /System/)

    await act(async () => {
      store.setLocale('en')
    })
    assert.match(host.textContent ?? '', /2 skills/)
    assert.match(host.textContent ?? '', /System/)
  } finally {
    localStorage.removeItem('helmx:locale')
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// builtin:memory slot injection (the ProfileDetailDrawer host hardcodes no memory business logic)
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: renders the builtin:memory injected section through PluginSlot', { timeout: 60_000 }, () => {
  function ProfileMemorySectionProbe(props: { profileId: string; isNew: boolean; disabled: boolean }) {
    return React.createElement(
      'section',
      { className: 'section-flat', 'data-probe': 'memory' },
      React.createElement('span', null, `长期记忆 (${props.profileId})`),
      props.isNew ? '请先创建角色' : '启用长期记忆',
    )
  }
  seedPluginClientModule('builtin:memory', 'index.tsx', { ProfileMemorySection: ProfileMemorySectionProbe })

  const store = makeTestStore({
    models: mockModels,
    skills: mockSkills,
    uiContributions: [
      {
        pluginId: 'builtin:memory',
        surface: 'plugin.slot',
        spec: {
          id: 'profile-memory-section',
          target: PROFILE_DETAIL_SECTION_SLOT,
          client: { module: 'index.tsx', export: 'ProfileMemorySection' },
        },
      },
    ],
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3], // code-reviewer (custom)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /data-probe="memory"/, 'the memory plugin slot must render through PluginSlot')
  assert.match(html, /长期记忆 \(code-reviewer\)/, 'the slot receives the profileId prop (zh fixture text)')
  assert.match(html, /启用长期记忆/, 'slot content actually renders (not the fallback)')
})

test('ProfileDetailDrawer: no memory section without plugin contributions (host hardcodes nothing)', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3],
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.doesNotMatch(html, /长期记忆/, 'no memory section may appear without plugin contributions')
})

test('profile-center-model: effective model / global inheritance, node cwd and activity summary', { timeout: 60_000 }, () => {
  const bound = resolveEffectiveProfileModel(
    { ...mockProfiles[3], thinkingLevel: 'high' },
    { defaultModel: 'openai/gpt-4o', defaultThinkingLevel: 'medium' },
  )
  assert.deepEqual(bound, { model: 'deepseek-r1', thinkingLevel: 'high', source: 'bound' })

  const inherited = resolveEffectiveProfileModel(
    { id: 'worker', name: 'Worker' },
    { defaultModel: 'openai/gpt-4o', defaultThinkingLevel: 'low' },
  )
  assert.deepEqual(inherited, { model: 'openai/gpt-4o', thinkingLevel: 'low', source: 'global' })

  const unset = resolveEffectiveProfileModel({ id: 'worker', name: 'Worker' }, null)
  assert.deepEqual(unset, { source: 'unset' })

  assert.deepEqual(formatProfileLocation({ id: 'x', nodeId: 'gpu-1', cwd: '/srv/app' }), {
    nodeId: 'gpu-1',
    isRemoteNode: true,
    cwd: '/srv/app',
  })
  assert.deepEqual(formatProfileLocation({ id: 'x' }), {
    nodeId: 'local',
    isRemoteNode: false,
    cwd: undefined,
  })

  const workingActivity = summarizeProfileActivity(
    { id: 'coder', name: 'Coder' },
    [
      {
        id: 1,
        title: 'Task 1',
        profileId: 'coder',
        tags: [],
        cwd: '/tmp',
        model: 'm',
        thinkingLevel: '',
        status: 'working',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    [],
  )
  assert.equal(workingActivity.conversationCount, 1)
  assert.equal(workingActivity.stateKind, 'working')
  assert.equal(workingActivity.stateLabel, 'Running')

  const disabledActivity = summarizeProfileActivity(
    { id: 'herdr-worker', managedByPlugin: 'builtin:herdr' },
    [],
    [
      {
        id: 'builtin:herdr',
        name: 'Herdr',
        enabled: false,
        locked: false,
        tools: [],
        actions: [],
        hooks: [],
      },
    ],
  )
  assert.equal(disabledActivity.managingPluginDisabled, true)
  assert.equal(disabledActivity.stateKind, 'plugin-disabled')
  assert.equal(disabledActivity.stateLabel, 'Plugin disabled')

  // enabled=true 但 status=failed 同样视为托管插件未活跃
  const failedEnabledActivity = summarizeProfileActivity(
    { id: 'herdr-worker', managedByPlugin: 'builtin:herdr' },
    [],
    [
      {
        id: 'builtin:herdr',
        name: 'Herdr',
        enabled: true,
        status: 'failed',
        error: { code: 'plugin_dependency_not_enabled', message: 'dep off', stage: 'enable' },
        locked: false,
        tools: [],
        actions: [],
        hooks: [],
      },
    ],
  )
  assert.equal(failedEnabledActivity.managingPluginDisabled, true)
  assert.equal(failedEnabledActivity.stateKind, 'plugin-disabled')
})

test('ProfileCard: inherited model, node and cwd, conversation count, bottom-right conversation action with stopPropagation', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const openedTargets: unknown[] = []
  let selectCalls = 0

  const profileWithNode: Profile = {
    id: 'remote-dev',
    name: '远程研发助手',
    description: '在 GPU 节点运行',
    nodeId: 'gpu-node-1',
    cwd: '/data/workspace/helmx',
    skills: ['helmx-cli'],
  }

  const store = makeTestStore({
    conversations: [
      {
        id: 11,
        title: '调试任务',
        profileId: 'remote-dev',
        tags: [],
        cwd: '/data/workspace/helmx',
        model: 'anthropic/claude-3-7-sonnet',
        thinkingLevel: 'high',
        status: 'blocked',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: true,
        pinned: false,
        pendingAskCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ProfileCard, {
            profile: profileWithNode,
            // 按生产接线显式传入全局默认模型（ProfileCenter 经 /api/models/default 获取后下发）
            defaultModelInfo: { defaultModel: 'anthropic/claude-3-7-sonnet', defaultThinkingLevel: 'high' },
            onSelect: () => {
              selectCalls++
            },
          }),
        ),
      )
    })

    const text = host.textContent ?? ''
    const modelLabel = host.querySelector('.primary-card-pills .primary-card-pill-label')
    const modelSuffix = host.querySelector('.primary-card-pills .primary-card-pill-suffix')
    const modelPill = modelLabel?.closest('.primary-card-pill')
    assert.equal(modelLabel?.textContent, 'claude-3-7-sonnet')
    assert.equal(modelSuffix?.textContent, '· high')
    assert.equal(
      modelPill?.getAttribute('title'),
      'Inherits global default model: anthropic/claude-3-7-sonnet (thinking level: high)',
    )
    assert.match(text, /Global default/)
    assert.match(text, /gpu-node-1 · \/data\/workspace\/helmx/)
    assert.match(text, /Pending approval/)
    assert.match(text, /Linked to 1 conversations/)
    assert.equal(host.querySelectorAll('[style]').length, 0, 'ProfileCard must keep zero inline styles')
    assert.doesNotMatch(host.innerHTML, EMOJI_REGEX, 'ProfileCard must contain no emoji')

    const chatBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Conversation'),
    )
    assert.ok(chatBtn, 'ProfileCard must render the bottom-right conversation button')
    await act(async () => {
      chatBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(selectCalls, 0, 'clicking the conversation button must stopPropagation without selecting the card')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'remote-dev' })
  } finally {
    localStorage.removeItem('helmx:locale')
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('ProfileCard: long full-path model shows only the short name plus a level suffix; the full path stays in the title', { timeout: 60_000 }, () => {
  const longPathModel = 'openrouter/accounts/fireworks/models/Qwen3-235B-A22B-Instruct-2507'
  const html = renderToStaticMarkup(
    renderCardElement(
      e(ProfileCard, {
        profile: {
          id: 'architect',
          name: '架构师',
          model: longPathModel,
          thinkingLevel: 'xhigh',
        },
        onSelect: () => {},
      }),
    ),
  )
  assert.match(html, /class="primary-card-pill-label">Qwen3-235B-A22B-Instruct-2507<\/span>/)
  assert.match(html, /class="primary-card-pill-suffix">· xhigh<\/span>/)
  assert.match(html, new RegExp(`title="Bound model: ${longPathModel} \\(thinking level: xhigh\\)"`))
  assert.doesNotMatch(html, />openrouter\/accounts\/fireworks\/models\//)

  // No bound model and no global default: show the follow-global-default pill
  const unsetHtml = renderToStaticMarkup(
    renderCardElement(
      e(ProfileCard, {
        profile: { id: 'plain', name: '普通角色' },
        defaultModelInfo: null,
        onSelect: () => {},
      }),
    ),
  )
  assert.match(unsetHtml, /class="primary-card-pill-label">Follow global default<\/span>/)
})

test('ProfileDetailDrawer: close button uses .btn-icon-sm; source carries no legacy .callout--* classes', { timeout: 60_000 }, () => {
  const files = [
    'src/profiles/profile-center-model.ts',
    'src/profiles/ProfileCard.tsx',
    'src/profiles/ProfileCenter.tsx',
    'src/profiles/ProfileDetailDrawer.tsx',
  ]
  for (const rel of files) {
    const content = readFileSync(join(PKG_ROOT, rel), 'utf-8')
    assert.ok(!content.includes('callout--'), `${rel} must not keep legacy callout--* classes`)
  }
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3], thinkingLevel: 'xhigh' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /btn btn-ghost btn-icon-sm/, 'the close button must use the fixed-size .btn-icon-sm')
  // 思考档位不再有独立提示行：统一进共享 ModelPickerControl（不支持档位由选择器收敛，无 callout）
  assert.doesNotMatch(html, /callout callout-warn/, 'the private thinking-level hint row is gone (unified picker)')
  assert.match(html, /composer-model-button/, 'the shared ModelPickerControl trigger renders')
})

test('ProfileDetailDrawer: restrict-to-cwd switch renders with localized label and hint', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const profile: Profile = {
    id: 'restricted-worker',
    name: '受限工作角色',
    cwd: '/srv/work',
    restrictToCwd: true,
    tags: [],
  }
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, { profile, isNew: false, open: true, inline: true, onClose: () => {} }),
    ),
  )
  assert.match(html, /Restrict to working directory/)
  assert.match(html, /profile-form-restrict-cwd/)
  assert.match(html, /guardrail, not a sandbox/, 'the guardrail-not-sandbox hint keeps the honesty wording')
  assert.doesNotMatch(html, EMOJI_REGEX)
})

// ---------------------------------------------------------------------------
// 5. Dynamic ctx.ui.profileRuntime consumption: ProfileDetailDrawer & plugin disable fallback
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: zero runtime residue when no profile.runtime UI contributions exist and profile has no runtime', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3],
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.doesNotMatch(html, /data-runtime-section/)
  assert.doesNotMatch(html, /data-runtime-unmanaged/)
  assert.doesNotMatch(html, /profile-form-runtime-switch/)
})

test('ProfileDetailDrawer: single vs multiple ctx.ui.profileRuntime specs render expected controls and datalist suggestions', { timeout: 60_000 }, () => {
  // 1 spec: switch + agent/node/workspace/args/env fields, no redundant kind Select
  const singleStore = makeTestStore({
    models: mockModels,
    skills: mockSkills,
    uiContributions: [herdrRuntimeContribution],
  })
  const singleHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: singleStore },
      e(ProfileDetailDrawer, {
        profile: {
          ...mockProfiles[2]!,
          runtime: { kind: 'herdr', agent: 'agy', args: ['--fast'], env: { FOO: 'bar' } },
        },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(singleHtml, /data-runtime-section="true"/)
  assert.match(singleHtml, /Herdr runtime/)
  assert.match(singleHtml, /Delegate turns to a Herdr terminal pane\./)
  assert.doesNotMatch(singleHtml, /profile-form-runtime-kind/)
  assert.match(singleHtml, /profile-form-runtime-agent/)
  assert.match(singleHtml, /<option value="agy"><\/option>/)
  assert.match(singleHtml, /<option value="pi"><\/option>/)
  assert.match(singleHtml, /<option value="codex"><\/option>/)
  assert.match(singleHtml, /profile-form-runtime-args/)
  assert.match(singleHtml, /--fast/)
  assert.match(singleHtml, /profile-form-runtime-env-key-0/)

  // 2 specs: kind selector appears
  const multiStore = makeTestStore({
    models: mockModels,
    skills: mockSkills,
    uiContributions: [herdrRuntimeContribution, dockerRuntimeContribution],
  })
  const multiHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: multiStore },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[2]!,
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(multiHtml, /profile-form-runtime-kind/)
  assert.doesNotMatch(multiHtml, EMOJI_REGEX)
})

test('ProfileDetailDrawer: unmanaged runtime notice preserves or explicitly clears runtime when plugin is disabled', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const putBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  const targetProfile: Profile = {
    id: 'herdr-worker',
    name: 'Herdr 终端专家',
    runtime: { kind: 'herdr', agent: 'agy', args: ['--model', 'sonnet'] },
    tags: ['herdr'],
  }

  let getCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    if (url === '/api/profiles/herdr-worker' && (!init?.method || init.method === 'GET')) {
      getCount += 1
      return new Response(JSON.stringify({ ...targetProfile, system: '' }), { status: 200 })
    }
    if (url === '/api/profiles/herdr-worker' && init?.method === 'PUT') {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>
      putBodies.push(parsed)
      return new Response(JSON.stringify(parsed), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch

  // Disabled plugin: zero profile.runtime contributions
  const store = makeTestStore({ models: mockModels, skills: mockSkills, profiles: [targetProfile] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ProfileDetailDrawer, {
            profile: targetProfile,
            isNew: false,
            open: true,
            inline: true,
            onClose: () => {},
          }),
        ),
      )
    })
    await waitForCondition(() => getCount > 0)
    await act(async () => {})

    // Unmanaged notice appears, runtime switch does not
    const notice = container.querySelector('[data-runtime-unmanaged="herdr"]')
    assert.ok(notice, 'existing runtime with disabled plugin shows unmanaged notice')
    assert.ok(container.querySelector('#profile-form-runtime-switch') === null)

    // Save without clearing -> runtime is preserved intact
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save profile'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(putBodies.length, 1)
    assert.deepEqual(putBodies[0]!.runtime, { kind: 'herdr', agent: 'agy', args: ['--model', 'sonnet'] })

    // Clear unmanaged runtime -> notice disappears and next Save omits runtime
    const clearBtn = Array.from(notice.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Clear'),
    )!
    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.ok(container.querySelector('[data-runtime-unmanaged="herdr"]') === null)

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(putBodies.length, 2)
    assert.equal('runtime' in putBodies[1]!, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ProfileDetailDrawer: interactive runtime editing validates agent and submits normalized runtime fields', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const putBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  const baseProfile: Profile = {
    id: 'editable-worker',
    name: 'Editable Worker',
    tags: ['worker'],
  }

  let getCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    if (url === '/api/profiles/editable-worker' && (!init?.method || init.method === 'GET')) {
      getCount += 1
      return new Response(JSON.stringify({ ...baseProfile, system: '# keep existing' }), { status: 200 })
    }
    if (url === '/api/profiles/editable-worker' && init?.method === 'PUT') {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>
      putBodies.push(parsed)
      return new Response(JSON.stringify(parsed), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch

  const store = makeTestStore({
    models: mockModels,
    skills: mockSkills,
    profiles: [baseProfile],
    uiContributions: [herdrRuntimeContribution],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ProfileDetailDrawer, {
            profile: baseProfile,
            isNew: false,
            open: true,
            inline: true,
            onClose: () => {},
          }),
        ),
      )
    })
    await waitForCondition(() => getCount > 0)
    await act(async () => {})

    // Toggle runtime switch ON
    const runtimeSwitch = container.querySelector('#profile-form-runtime-switch') as HTMLButtonElement
    assert.ok(runtimeSwitch)
    await act(async () => {
      runtimeSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // Saving with empty agent must show validation error and not issue PUT
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save profile'),
    )!
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(putBodies.length, 0)
    assert.match(container.textContent ?? '', /Enter an external runtime agent/)

    // Fill agent, workspace, multi-line args, and env pair
    await act(async () => {
      typeIntoControl(container.querySelector('#profile-form-runtime-agent') as HTMLInputElement, '  pi ')
      typeIntoControl(container.querySelector('#profile-form-runtime-workspace') as HTMLInputElement, ' /srv/herdr ')
      typeIntoControl(
        container.querySelector('#profile-form-runtime-args') as HTMLTextAreaElement,
        '--model\n  glm-4.6 --fast \n\n',
      )
    })
    const addEnvBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Add variable'),
    )!
    await act(async () => {
      addEnvBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      typeIntoControl(container.querySelector('#profile-form-runtime-env-key-0') as HTMLInputElement, ' HELMX_MODE ')
      typeIntoControl(container.querySelector('#profile-form-runtime-env-value-0') as HTMLInputElement, 'strict')
    })

    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(putBodies.length, 1)
    assert.deepEqual(putBodies[0]!.runtime, {
      kind: 'herdr',
      agent: 'pi',
      workspace: '/srv/herdr',
      args: ['--model', 'glm-4.6 --fast'],
      env: { HELMX_MODE: 'strict' },
    })
    // Unedited SYSTEM.md stays omitted so server does not overwrite concurrent writes
    assert.equal('system' in putBodies[0]!, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('ProfileCenter: disabling runtime plugin removes dynamic tab and pill with zero residue and falls back active tab to All', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const enabledHerdrPlugin: PluginSummary = {
    id: 'builtin:herdr',
    name: 'Herdr',
    version: '0.1.0',
    locked: false,
    enabled: true,
    status: 'active',
    hooks: [],
    actions: [],
    tools: [],
  }
  const disabledHerdrPlugin: PluginSummary = {
    ...enabledHerdrPlugin,
    enabled: false,
    status: 'disabled',
  }

  const store = makeTestStore({
    profiles: mockProfiles,
    models: mockModels,
    skills: mockSkills,
    plugins: [enabledHerdrPlugin],
    uiContributions: [herdrRuntimeContribution],
    primaryTarget: { kind: 'profiles' },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        e(HostStoreProviders, { value: store }, e(ProfileCenter, { isSplit: false, inlineDrawer: true })),
      )
    })

    const runtimeTab = Array.from(container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Herdr runtime'),
    )!
    assert.ok(runtimeTab, 'dynamic runtime tab renders when plugin is enabled')
    await act(async () => {
      runtimeTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    // Filtered down to herdr-worker only
    assert.match(container.textContent ?? '', /Herdr 终端专家/)
    assert.doesNotMatch(container.textContent ?? '', /SuperAgent 中枢/)

    // Disable the plugin via real store.syncPlugins lifecycle -> reconciles uiContributions
    await act(async () => {
      store.syncPlugins([disabledHerdrPlugin])
    })

    // Dynamic tab & pill disappear; effectiveTab safely falls back to All showing all cards again
    assert.doesNotMatch(container.textContent ?? '', /Herdr runtime/)
    assert.match(container.textContent ?? '', /SuperAgent 中枢/)
    assert.match(container.textContent ?? '', /Herdr 终端专家/)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
