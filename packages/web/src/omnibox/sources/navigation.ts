/**
 * 0ms synchronous Pages & Settings catalog builder:
 * - Five System Centers + sub-tabs (`models:defaults`, `plugins:core`, `overview` buckets)
 * - Profiles (single-entity dedup: primary = Agent Standby, secondary = Profile Settings, swaps in Pages / config intent)
 * - Plugin Screens & Plugins (single-entity dedup: screen-bearing plugins unify Screen + Plugin Settings)
 * - Model Providers (with child model reverse search hints)
 * - Visible Skills, Compute Nodes (with online/offline badge), and `core:*` kernel actions
 */
import {
  resolveLocalizedText,
  type ActionManifest,
  type CredentialSummary,
  type HelmxLocale,
  type ModelProviderSummary,
  type NodeInfo,
  type PluginSummary,
  type Profile,
  type ProviderConfig,
  type SkillSummary,
} from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { ModelDescriptor } from '../../lib/api.js'
import type { GroupedUiSpecs } from '../../lib/types.js'
import { buildDefaultProviders, buildMergedProviders } from '../../models/model-center-model.js'
import { buildCoreCapabilityOwners, formatCoreCliCommand } from '../../plugins/core-capability-model.js'
import { isHumanSelectableProfile, isSkillVisible } from '../../shell/conversation-status-model.js'
import type { OmniboxItem } from '../types.js'
import { dedupeStrings, extractLocalizedStrings, resolveOptionalLocalizedText } from './helpers.js'

export interface BuildNavigationItemsInput {
  profiles: ReadonlyArray<Profile>
  enabledPluginIds: ReadonlySet<string>
  screens: GroupedUiSpecs['screens']
  plugins: ReadonlyArray<PluginSummary>
  providers: ReadonlyArray<ProviderConfig>
  credentials: ReadonlyArray<CredentialSummary>
  models: ReadonlyArray<ModelDescriptor>
  skills: ReadonlyArray<SkillSummary>
  nodes: ReadonlyArray<NodeInfo>
  actions: ReadonlyArray<ActionManifest>
  locale: HelmxLocale
  t: WebMessageTranslator
}

function buildSyntheticCatalogFromModels(
  models: ReadonlyArray<ModelDescriptor>,
): ModelProviderSummary[] {
  const seen = new Map<string, number>()
  for (const m of models) {
    const key = m.provider.trim()
    if (key === '') continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return [...seen.entries()].map(([id, modelCount]) => ({
    id,
    name: id,
    modelCount,
    authMethods: [],
  }))
}

export function buildNavigationItems(input: BuildNavigationItemsInput): OmniboxItem[] {
  const {
    profiles,
    enabledPluginIds,
    screens,
    plugins,
    providers,
    credentials,
    models,
    skills,
    nodes,
    actions,
    locale,
    t,
  } = input

  const items: OmniboxItem[] = []
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin] as const))

  // 1. Conversation Overview + sub-views
  const overviewTitle = t('modals.palette.cmd.openOverview')
  const overviewCrumb = t('shell.overview.title')
  items.push({
    id: 'builtin:open-overview',
    kind: 'page',
    scope: 'pages',
    group: 'pages',
    title: overviewTitle,
    icon: 'activity',
    emptyStateVisible: true,
    recentEligible: true,
    searchTerms: {
      primary: dedupeStrings([overviewTitle, 'Conversation overview', '会话总览']),
      aliases: ['overview', 'dashboard', 'lobby', 'status', '总览', '大堂', '态势', '全部会话'],
      exactTokens: ['overview'],
    },
    intent: { type: 'navigate', target: { kind: 'overview' } },
  })

  items.push({
    id: 'builtin:overview-archived',
    kind: 'page',
    scope: 'pages',
    group: 'pages',
    title: t('modals.omnibox.page.overviewArchived'),
    breadcrumb: [overviewCrumb],
    icon: 'archive',
    emptyStateVisible: false,
    recentEligible: true,
    searchTerms: {
      primary: dedupeStrings([
        t('modals.omnibox.page.overviewArchived'),
        'Archived conversations',
        '已归档会话',
      ]),
      breadcrumb: [overviewCrumb, 'Conversation overview', '会话总览'],
      aliases: ['overview', 'archived', 'archive', 'bucket=archived', 'overview?bucket=archived', '归档', '已归档', '历史会话'],
      exactTokens: ['overview?bucket=archived'],
    },
    intent: { type: 'navigate', target: { kind: 'overview', params: { bucket: 'archived' } } },
  })

  items.push({
    id: 'builtin:overview-attention',
    kind: 'page',
    scope: 'pages',
    group: 'pages',
    title: t('modals.omnibox.page.overviewAttention'),
    breadcrumb: [overviewCrumb],
    icon: 'alert-circle',
    emptyStateVisible: false,
    recentEligible: true,
    searchTerms: {
      primary: dedupeStrings([
        t('modals.omnibox.page.overviewAttention'),
        'Conversations needing attention',
        '需处理的会话',
      ]),
      breadcrumb: [overviewCrumb, 'Conversation overview', '会话总览'],
      aliases: ['overview', 'attention', 'needs_attention', 'blocked', 'error', 'approval', 'ask', '需处理', '待处理', '待审批', '告警'],
      exactTokens: ['overview?bucket=needs_attention'],
    },
    intent: { type: 'navigate', target: { kind: 'overview', params: { bucket: 'needs_attention' } } },
  })

  // 2. Profiles (single-entity dedup: primary = Agent Standby, secondary = Configure Profile)
  const configureProfileLabel = t('modals.omnibox.action.configureProfile')
  const openAgentActionLabel = t('modals.omnibox.action.openAgent')
  const profilesCrumb = t('shell.center.profiles')

  for (const profile of profiles) {
    if (!isHumanSelectableProfile(profile, enabledPluginIds)) continue
    const displayName = profile.name?.trim() || profile.id
    const openAgentTitle = t('modals.palette.cmd.openAgent', { name: displayName })
    items.push({
      id: `profile:${profile.id}`,
      kind: 'page',
      scope: 'pages',
      group: 'pages',
      title: openAgentTitle,
      ...(displayName !== profile.id ? { subtitle: profile.id } : {}),
      icon: 'bot',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([openAgentTitle, displayName, profile.id]),
        breadcrumb: dedupeStrings([profilesCrumb, 'Profiles', 'Agents', '智能体', '角色']),
        aliases: dedupeStrings([
          'agent',
          'profile',
          'standby',
          'new',
          '智能体',
          '角色',
          '待命',
          'setting',
          'settings',
          'config',
          'configuration',
          '配置',
          '设置',
          profile.model,
          ...(profile.tags ?? []),
        ]),
        exactTokens: dedupeStrings([profile.id, displayName]),
      },
      intent: { type: 'navigate', target: { kind: 'agent', profileId: profile.id } },
      secondaryAction: {
        label: configureProfileLabel,
        icon: 'sliders',
        intent: { type: 'navigate', target: { kind: 'profiles', profileId: profile.id } },
      },
      settingIntentSwap: {
        swapInPagesScope: true,
        title: displayName,
        subtitle: t('modals.omnibox.subtitle.profileSettings', { id: profile.id }),
        intent: { type: 'navigate', target: { kind: 'profiles', profileId: profile.id } },
        secondaryAction: {
          label: openAgentActionLabel,
          icon: 'message-square',
          intent: { type: 'navigate', target: { kind: 'agent', profileId: profile.id } },
        },
      },
    })
  }

  // 3. Plugin Screens (single-entity dedup with Plugin Settings)
  const screensByPlugin = new Map<string, number>()
  for (const screen of screens) {
    screensByPlugin.set(screen.pluginId, (screensByPlugin.get(screen.pluginId) ?? 0) + 1)
  }
  const pluginSettingsLabel = t('modals.omnibox.action.pluginSettings')
  const openViewLabel = t('modals.omnibox.action.openView')
  const pluginsCrumb = t('shell.center.plugins')

  for (const screen of screens) {
    const { spec } = screen
    const plugin = pluginById.get(screen.pluginId)
    const pluginName =
      plugin !== undefined ? resolveLocalizedText(plugin.name, locale) || screen.pluginId : screen.pluginId
    const label = resolveLocalizedText(spec.label, locale) || `${screen.pluginId}/${spec.id}`
    const description =
      resolveOptionalLocalizedText(spec.description, locale) ??
      resolveOptionalLocalizedText(plugin?.description, locale)
    const isSingleScreenPlugin = screensByPlugin.get(screen.pluginId) === 1

    const primaryTerms = dedupeStrings([
      label,
      ...extractLocalizedStrings(spec.label),
      ...(isSingleScreenPlugin && plugin !== undefined ? extractLocalizedStrings(plugin.name) : []),
    ])
    const aliasTerms = dedupeStrings([
      screen.pluginId,
      screen.spec.id,
      `${screen.pluginId}/${screen.spec.id}`,
      ...extractLocalizedStrings(spec.description),
      ...(spec.keywords ?? []),
      ...(plugin !== undefined ? extractLocalizedStrings(plugin.description) : []),
      'view',
      'screen',
      'plugin',
      'setting',
      'settings',
      'config',
      'configuration',
      '视图',
      '插件',
      '设置',
      '配置',
    ])

    items.push({
      id: `view:${screen.pluginId}/${screen.spec.id}`,
      kind: 'page',
      scope: 'pages',
      group: 'pages',
      title: label,
      breadcrumb: [pluginName],
      ...(description !== undefined ? { subtitle: description } : {}),
      icon: spec.icon ?? 'panel-right',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: primaryTerms,
        breadcrumb: dedupeStrings([
          pluginName,
          ...(plugin !== undefined ? extractLocalizedStrings(plugin.name) : []),
          'Views',
          '视图',
        ]),
        aliases: aliasTerms,
        exactTokens: dedupeStrings([
          spec.id,
          `${screen.pluginId}/${spec.id}`,
          ...(isSingleScreenPlugin ? [screen.pluginId] : []),
        ]),
      },
      intent: { type: 'navigate', target: { kind: 'screen', pluginId: screen.pluginId, screenId: screen.spec.id } },
      secondaryAction: {
        label: pluginSettingsLabel,
        icon: 'settings',
        intent: { type: 'navigate', target: { kind: 'plugins', pluginId: screen.pluginId } },
      },
      settingIntentSwap: {
        swapInPagesScope: false,
        subtitle: t('modals.omnibox.subtitle.pluginSettings', { id: screen.pluginId }),
        intent: { type: 'navigate', target: { kind: 'plugins', pluginId: screen.pluginId } },
        secondaryAction: {
          label: openViewLabel,
          icon: spec.icon ?? 'panel-right',
          intent: { type: 'navigate', target: { kind: 'screen', pluginId: screen.pluginId, screenId: screen.spec.id } },
        },
      },
    })
  }

  // 4. Five System Centers + sub-tabs (`models:defaults`, `plugins:core`)
  const modelsCrumb = t('shell.center.models')
  const skillsCrumb = t('shell.center.skills')
  const nodesCrumb = t('shell.center.nodes')

  items.push(
    {
      id: 'builtin:open-profile-editor',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.palette.cmd.openProfiles'),
      icon: 'bot',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openProfiles'), 'Profile Center', 'Agents', '智能体角色中心', '角色中心']),
        aliases: ['profile', 'profiles', 'agent', 'agents', '角色', '智能体', '设置'],
        exactTokens: ['profiles'],
      },
      intent: { type: 'navigate', target: { kind: 'profiles' } },
    },
    {
      id: 'builtin:open-provider-auth',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.palette.cmd.openModels'),
      icon: 'key',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openModels'), 'Models & Credentials', '模型与凭证中心', '模型与凭据']),
        aliases: ['model', 'models', 'provider', 'providers', 'key', 'api key', 'credentials', 'gateway', '模型', '凭证', '凭据', '供应商', '网关'],
        exactTokens: ['models'],
      },
      intent: { type: 'navigate', target: { kind: 'models' } },
    },
    {
      id: 'builtin:open-models-defaults',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.omnibox.page.modelsDefaults'),
      breadcrumb: [modelsCrumb],
      subtitle: t('modals.omnibox.subtitle.modelsDefaults'),
      icon: 'sliders',
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([
          t('modals.omnibox.page.modelsDefaults'),
          'Models Defaults',
          'Global Model Defaults',
          'models/defaults',
          '全局默认模型',
        ]),
        breadcrumb: dedupeStrings([modelsCrumb, 'Models', '模型']),
        aliases: [
          'models:defaults',
          'models/defaults',
          'default model',
          'compaction',
          'thinking level',
          '默认模型',
          '压缩模型',
          '思考档位',
          '全局默认',
        ],
        exactTokens: ['models:defaults', 'models/defaults'],
      },
      intent: { type: 'navigate', target: { kind: 'models', tab: 'defaults' }, focusAnchor: 'models:defaults' },
    },
    {
      id: 'builtin:open-skill-viewer',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.palette.cmd.openSkills'),
      icon: 'sparkles',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openSkills'), 'Skills Center', '技能中心']),
        aliases: ['skill', 'skills', '技能'],
        exactTokens: ['skills'],
      },
      intent: { type: 'navigate', target: { kind: 'skills' } },
    },
    {
      id: 'builtin:open-nodes',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.palette.cmd.openNodes'),
      icon: 'network',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openNodes'), 'Compute Nodes Center', '计算节点中心']),
        aliases: ['node', 'nodes', 'byom', 'helmx-node', '节点', '计算节点'],
        exactTokens: ['nodes'],
      },
      intent: { type: 'navigate', target: { kind: 'nodes' } },
    },
    {
      id: 'builtin:open-plugin-center',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.palette.cmd.openPlugins'),
      icon: 'boxes',
      emptyStateVisible: true,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openPlugins'), 'Plugin Center', '插件中心']),
        aliases: ['plugin', 'plugins', 'settings', 'extensions', '插件', '设置', '扩展'],
        exactTokens: ['plugins'],
      },
      intent: { type: 'navigate', target: { kind: 'plugins' } },
    },
    {
      id: 'builtin:open-plugins-core',
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: t('modals.omnibox.page.pluginsCore'),
      breadcrumb: [pluginsCrumb],
      subtitle: t('modals.omnibox.subtitle.pluginsCore'),
      icon: 'shield',
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([
          t('modals.omnibox.page.pluginsCore'),
          'Core Capabilities',
          'plugins/core',
          '内核能力',
        ]),
        breadcrumb: dedupeStrings([pluginsCrumb, 'Plugins', '插件中心']),
        aliases: ['plugins:core', 'plugins/core', 'core', 'kernel', 'capabilities', 'actions', '内核', '核心能力'],
        exactTokens: ['plugins:core', 'plugins/core'],
      },
      intent: { type: 'navigate', target: { kind: 'plugins', tab: 'core' } },
    },
  )

  // 5. Model Providers (with child models indexed for reverse search!)
  const syntheticCatalog = buildSyntheticCatalogFromModels(models)
  const mergedProviders = buildMergedProviders(
    buildDefaultProviders(t),
    [...credentials],
    [...providers],
    [...models],
    syntheticCatalog,
    t,
  )
  for (const provider of mergedProviders) {
    const providerModels = (provider.models ?? []).map((m) => ({ id: m.id, name: m.name }))
    const modelAliases: string[] = []
    for (const m of provider.models ?? []) {
      modelAliases.push(m.id, `${provider.id}/${m.id}`, m.name, ...(m.tags ?? []))
    }
    items.push({
      id: `provider:${provider.id}`,
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: provider.name || provider.id,
      breadcrumb: [modelsCrumb],
      subtitle: provider.description || provider.baseUrl || provider.id,
      icon: 'cpu',
      statusBadge: provider.configured
        ? { label: t('models.configured'), tone: 'ok' }
        : undefined,
      emptyStateVisible: false,
      recentEligible: true,
      providerModels,
      searchTerms: {
        primary: dedupeStrings([provider.name, provider.id]),
        breadcrumb: dedupeStrings([modelsCrumb, 'Models', 'Provider', '模型', '供应商']),
        aliases: dedupeStrings([
          provider.description,
          provider.baseUrl,
          provider.protocol,
          provider.pluginId,
          ...modelAliases,
          'provider',
          'model',
          'api key',
          '模型',
          '供应商',
          '网关',
        ]),
        exactTokens: dedupeStrings([provider.id]),
      },
      intent: { type: 'navigate', target: { kind: 'models', providerId: provider.id } },
    })
  }

  // 6. Visible Skills
  for (const skill of skills) {
    if (!isSkillVisible(skill, enabledPluginIds)) continue
    const skillTitle = skill.name?.trim() || skill.id
    items.push({
      id: `skill:${skill.id}`,
      kind: 'page',
      scope: 'pages',
      group: 'pages',
      title: skillTitle,
      breadcrumb: [skillsCrumb],
      ...(skill.description ? { subtitle: skill.description } : {}),
      icon: 'sparkles',
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([skillTitle, skill.id]),
        breadcrumb: dedupeStrings([skillsCrumb, 'Skills', '技能']),
        aliases: dedupeStrings([
          skill.description,
          skill.managedByPlugin,
          skill.source,
          `skill:${skill.id}`,
          `/skill:${skill.id}`,
          'skill',
          '技能',
        ]),
        exactTokens: dedupeStrings([skill.id, `skill:${skill.id}`]),
      },
      intent: { type: 'navigate', target: { kind: 'skills', skillId: skill.id } },
    })
  }

  // 7. Compute Nodes (with online / offline statusBadge)
  for (const node of nodes) {
    const nodeSubtitle = dedupeStrings([node.hostname, node.platform, node.kind]).join(' · ')
    items.push({
      id: `node:${node.id}`,
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: node.id,
      breadcrumb: [nodesCrumb],
      ...(nodeSubtitle !== '' ? { subtitle: nodeSubtitle } : {}),
      icon: node.kind === 'local' ? 'laptop' : 'server',
      statusBadge: {
        label: node.online ? t('modals.omnibox.status.online') : t('modals.omnibox.status.offline'),
        tone: node.online ? 'ok' : 'neutral',
      },
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([node.id, node.hostname]),
        breadcrumb: dedupeStrings([nodesCrumb, 'Nodes', 'Compute Nodes', '节点', '计算节点']),
        aliases: dedupeStrings([
          node.platform,
          node.kind,
          node.online ? 'online 在线' : 'offline 离线',
          'node',
          '节点',
        ]),
        exactTokens: dedupeStrings([node.id]),
      },
      intent: { type: 'navigate', target: { kind: 'nodes', nodeId: node.id } },
    })
  }

  // 8. Non-screen Plugins (and disabled plugins whose screens are absent — zero empty-state noise!)
  for (const plugin of plugins) {
    if (screensByPlugin.has(plugin.id)) continue
    const pluginName = resolveLocalizedText(plugin.name, locale) || plugin.id
    const pluginDesc = resolveOptionalLocalizedText(plugin.description, locale)
    const isFailed = plugin.error !== undefined || plugin.status === 'failed'
    items.push({
      id: `plugin-detail:${plugin.id}`,
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: pluginName,
      breadcrumb: [pluginsCrumb],
      subtitle: pluginDesc ?? plugin.id,
      icon: plugin.icon ?? 'puzzle',
      statusBadge: isFailed
        ? { label: t('modals.omnibox.status.error'), tone: 'warn' }
        : {
            label: plugin.enabled ? t('modals.omnibox.status.enabled') : t('modals.omnibox.status.disabled'),
            tone: plugin.enabled ? 'ok' : 'neutral',
          },
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([pluginName, ...extractLocalizedStrings(plugin.name), plugin.id]),
        breadcrumb: dedupeStrings([pluginsCrumb, 'Plugins', 'Settings', '插件', '设置']),
        aliases: dedupeStrings([
          ...extractLocalizedStrings(plugin.description),
          ...(plugin.tools ?? []),
          ...(plugin.actions ?? []),
          plugin.enabled ? 'enabled 启用' : 'disabled 停用',
          'plugin',
          '插件',
        ]),
        exactTokens: dedupeStrings([plugin.id]),
      },
      intent: { type: 'navigate', target: { kind: 'plugins', pluginId: plugin.id } },
    })
  }

  // 9. `core:*` Kernel Actions (`#/settings/plugins/core/<owner>/<action>`)
  const coreOwners = buildCoreCapabilityOwners(actions, skills, t)
  const coreCrumb = t('modals.omnibox.page.pluginsCore')
  for (const owner of coreOwners) {
    for (const action of owner.actions) {
      const cliCmd = formatCoreCliCommand(action)
      const fullId = `${owner.id}.${action.id}`
      items.push({
        id: `core-action:${owner.id}/${action.id}`,
        kind: 'setting',
        scope: 'pages',
        group: 'pages',
        title: `${owner.id}/${action.id}`,
        breadcrumb: [coreCrumb, owner.name],
        subtitle: action.description || cliCmd || owner.description,
        icon: owner.icon,
        emptyStateVisible: false,
        recentEligible: true,
        searchTerms: {
          primary: dedupeStrings([`${owner.id}/${action.id}`, fullId, action.id]),
          breadcrumb: dedupeStrings([coreCrumb, owner.name, owner.id, owner.domain]),
          aliases: dedupeStrings([
            action.description,
            cliCmd,
            'core',
            'kernel',
            'action',
            'cli',
            '内核',
            '能力',
          ]),
          exactTokens: dedupeStrings([fullId, `${owner.id}/${action.id}`]),
        },
        intent: {
          type: 'navigate',
          target: { kind: 'plugins', tab: 'core', coreOwner: owner.id, coreAction: action.id },
        },
      })
    }
  }

  return items
}
