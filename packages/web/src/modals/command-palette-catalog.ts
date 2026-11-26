/**
 * Pure catalog builders for CommandPaletteModal (context, recent conversations,
 * navigation targets, plugin commands, and host utilities).
 */
import {
  resolveLocalizedText,
  type CommandSpec,
  type ConversationSummary,
  type HelmxLocale,
  type PluginSummary,
  type Profile,
} from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { commandHint, type QualifiedCommand } from '../lib/commands-model.js'
import { resolveBrowserLocale } from '../lib/theme-preferences.js'
import type {
  FocusedPanel,
  GroupedUiSpecs,
  LocalePreference,
  ResolvedTarget,
  ThemePreference,
} from '../lib/types.js'
import {
  isHumanSelectableProfile,
  type ConversationBackgroundIndex,
} from '../shell/conversation-status-model.js'
import {
  formatModShiftShortcut,
  formatModShortcut,
  resolveNewTopicTarget,
  selectRecentConversationsForPalette,
  type HelmxShortcutDetail,
} from '../shell/shortcuts-model.js'
import type { PaletteCommandRow, PaletteSearchHitRow } from './command-palette-model.js'

export function buildPaletteContextCommands(input: {
  activeTarget: ResolvedTarget
  activePanel: FocusedPanel
  workbenchOpen: boolean
  conversations: ReadonlyArray<ConversationSummary>
  profiles: ReadonlyArray<Profile>
  plugins?: ReadonlyArray<PluginSummary>
  sidebarItems?: GroupedUiSpecs['sidebarItems']
  locale: HelmxLocale
  splitTarget: ResolvedTarget | null
  setWorkbenchOpen: (open: boolean) => void
  closeSplit: () => void
  t: WebMessageTranslator
}): PaletteCommandRow[] {
  const {
    activeTarget,
    activePanel,
    workbenchOpen,
    conversations,
    profiles,
    plugins,
    sidebarItems,
    locale,
    splitTarget,
    setWorkbenchOpen,
    closeSplit,
    t,
  } = input
  const list: PaletteCommandRow[] = []
  if (activeTarget.kind === 'conversation' || activeTarget.kind === 'agent') {
    list.push({
      kind: 'command',
      id: 'builtin:focus-composer',
      group: 'context',
      title: t('modals.palette.cmd.focusComposer'),
      shortcut: formatModShortcut('I'),
      icon: 'message-square',
      keywords: ['focus', 'composer', 'input', 'chat', 'message', '聚焦', '输入', '对话框'],
      skipCloseAutoFocus: true,
      run: () => {
        const detail: HelmxShortcutDetail = { action: 'focus-composer', panel: activePanel }
        const dispatch = (): void => {
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(dispatch)
        else setTimeout(dispatch, 0)
      },
    })
    list.push({
      kind: 'command',
      id: 'builtin:toggle-model-picker',
      group: 'context',
      title: t('modals.palette.cmd.toggleModelPicker'),
      shortcut: 'Ctrl+L',
      icon: 'sparkles',
      keywords: ['model', 'picker', 'Model', 'Switch model', '模型', '切换模型'],
      skipCloseAutoFocus: true,
      run: () => {
        const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel: activePanel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
      },
    })
  }
  if (activeTarget.kind === 'conversation') {
    list.push({
      kind: 'command',
      id: 'builtin:toggle-process-groups',
      group: 'context',
      title: t('modals.palette.cmd.toggleProcessGroups'),
      shortcut: 'Ctrl+O',
      icon: 'list-tree',
      keywords: ['process', 'thinking', 'tools', 'Process', 'Thinking', 'Collapse', '过程', '思考', '工具', '收起'],
      run: () => {
        const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel: activePanel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
      },
    })
  }
  if (activeTarget.kind === 'conversation' || workbenchOpen) {
    list.push({
      kind: 'command',
      id: 'builtin:toggle-workbench',
      group: 'context',
      title: workbenchOpen ? t('modals.palette.cmd.closeWorkbench') : t('modals.palette.cmd.openWorkbench'),
      shortcut: formatModShortcut('J'),
      icon: 'panel-right',
      keywords: ['workbench', 'drawer', 'Workbench', 'Artifacts', '工作台', '产物'],
      run: () => setWorkbenchOpen(!workbenchOpen),
    })
  }
  const newTopicTarget = resolveNewTopicTarget({
    activeTarget,
    conversations,
    profiles,
    ...(plugins !== undefined ? { plugins } : {}),
    ...(sidebarItems !== undefined ? { sidebarItems } : {}),
    locale,
  })
  list.push({
    kind: 'command',
    id: 'builtin:new-conversation',
    group: 'context',
    title: t('modals.palette.cmd.newConversation'),
    hint:
      newTopicTarget.kind === 'agent'
        ? newTopicTarget.profileId
        : t('modals.palette.cmd.selectProfileFirst'),
    shortcut: formatModShiftShortcut('O'),
    icon: 'plus',
    keywords: ['new', 'conversation', 'topic', '新建', '会话', '话题'],
    target: newTopicTarget,
  })
  if (splitTarget) {
    list.push({
      kind: 'command',
      id: 'builtin:close-split',
      group: 'context',
      title: t('modals.palette.cmd.closeSplit'),
      icon: 'panel-right',
      keywords: ['split', 'close', '分屏', '关闭'],
      run: () => closeSplit(),
    })
  }
  return list
}

export function buildPaletteRecentRows(
  conversations: ConversationSummary[],
  activeConversationId: number | undefined,
  background: ConversationBackgroundIndex,
  t: WebMessageTranslator,
): PaletteSearchHitRow[] {
  return selectRecentConversationsForPalette(conversations, activeConversationId, 5, background).map((conv) => ({
    kind: 'search-hit',
    id: `recent-conv:${conv.id}`,
    group: 'recent',
    conv,
    isLocalConversation: true,
    hit: {
      conversationId: conv.id,
      title: conv.title,
      entryId: '',
      snippet: t('modals.palette.recentSnippet', { id: conv.id, profileId: conv.profileId }),
    },
  }))
}

export function buildPaletteNavigationCommands(input: {
  profiles: Profile[]
  enabledPluginIds: ReadonlySet<string>
  screens: GroupedUiSpecs['screens']
  plugins: PluginSummary[] | undefined
  locale: HelmxLocale
  t: WebMessageTranslator
}): PaletteCommandRow[] {
  const { profiles, enabledPluginIds, screens, plugins, locale, t } = input
  const profileRows: PaletteCommandRow[] = profiles
    .filter((profile) => isHumanSelectableProfile(profile, enabledPluginIds))
    .map((profile) => {
      const displayName = profile.name?.trim() || profile.id
      return {
        kind: 'command',
        id: `profile:${profile.id}`,
        group: 'navigation',
        title: t('modals.palette.cmd.openAgent', { name: displayName }),
        ...(displayName !== profile.id ? { hint: profile.id } : {}),
        icon: 'bot',
        keywords: [
          'agent',
          'profile',
          'new',
          'standby',
          '智能体',
          '角色',
          '待命',
          profile.id,
          ...(profile.name ? [profile.name] : []),
          ...(profile.tags ?? []),
        ],
        target: { kind: 'agent', profileId: profile.id },
      }
    })

  const viewRows: PaletteCommandRow[] = screens.map((screen) => {
    const plugin = plugins?.find((p) => p.id === screen.pluginId)
    const pluginName =
      plugin !== undefined ? resolveLocalizedText(plugin.name, locale) || screen.pluginId : screen.pluginId
    const label = resolveLocalizedText(screen.spec.label, locale) || `${screen.pluginId}/${screen.spec.id}`
    return {
      kind: 'command',
      id: `view:${screen.pluginId}/${screen.spec.id}`,
      group: 'navigation',
      title: label,
      hint: pluginName,
      icon: screen.spec.icon ?? 'panel-right',
      keywords: [label, screen.pluginId, screen.spec.id, pluginName, 'view', 'screen', '视图'],
      target: { kind: 'screen', pluginId: screen.pluginId, screenId: screen.spec.id },
    }
  })

  return [
    {
      kind: 'command',
      id: 'builtin:open-overview',
      group: 'navigation',
      title: t('modals.palette.cmd.openOverview'),
      icon: 'activity',
      keywords: ['overview', 'dashboard', 'lobby', 'status', '总览', '会话总览', '大堂', '态势'],
      target: { kind: 'overview' },
    },
    ...profileRows,
    ...viewRows,
    {
      kind: 'command',
      id: 'builtin:open-profile-editor',
      group: 'navigation',
      title: t('modals.palette.cmd.openProfiles'),
      icon: 'bot',
      keywords: ['profile', 'profiles', 'Profile', 'Agents', '角色', '智能体'],
      target: { kind: 'profiles' },
    },
    {
      kind: 'command',
      id: 'builtin:open-provider-auth',
      group: 'navigation',
      title: t('modals.palette.cmd.openModels'),
      icon: 'key',
      keywords: ['model', 'models', 'provider', 'providers', 'key', 'Model', 'Credentials', '模型', '凭证', '供应商'],
      target: { kind: 'models' },
    },
    {
      kind: 'command',
      id: 'builtin:open-skill-viewer',
      group: 'navigation',
      title: t('modals.palette.cmd.openSkills'),
      icon: 'sparkles',
      keywords: ['skill', 'skills', 'Skills', '技能'],
      target: { kind: 'skills' },
    },
    {
      kind: 'command',
      id: 'builtin:open-nodes',
      group: 'navigation',
      title: t('modals.palette.cmd.openNodes'),
      icon: 'network',
      keywords: ['node', 'nodes', 'byom', 'helmx-node', 'Nodes', '节点', '计算节点'],
      target: { kind: 'nodes' },
    },
    {
      kind: 'command',
      id: 'builtin:open-plugin-center',
      group: 'navigation',
      title: t('modals.palette.cmd.openPlugins'),
      icon: 'boxes',
      keywords: ['plugin', 'plugins', 'settings', 'Plugins', 'Settings', 'Plugin Center', '插件', '设置', '插件中心'],
      target: { kind: 'plugins' },
    },
  ]
}

export function buildPaletteUtilityCommands(input: {
  scopedPluginCommands: ReadonlyArray<QualifiedCommand>
  locale: HelmxLocale
  sidebarCollapsed: boolean
  themePreference: ThemePreference
  localePref: LocalePreference
  quietNotifyEnabled: boolean
  onPreviewCommand: (preview: { pluginId: string; spec: CommandSpec }) => void
  onInvokePluginCommand: (cmd: QualifiedCommand) => void
  openShortcuts: () => void
  toggleSidebarCollapsed?: () => void
  toggleTheme: () => void
  setLocalePreference?: (pref: LocalePreference) => void
  setLocale: (locale: HelmxLocale) => void
  setQuietNotify: (on: boolean) => Promise<void>
  t: WebMessageTranslator
}): PaletteCommandRow[] {
  const {
    scopedPluginCommands,
    locale,
    sidebarCollapsed,
    themePreference,
    localePref,
    quietNotifyEnabled,
    onPreviewCommand,
    onInvokePluginCommand,
    openShortcuts,
    toggleSidebarCollapsed,
    toggleTheme,
    setLocalePreference,
    setLocale,
    setQuietNotify,
    t,
  } = input

  const pluginCommands: PaletteCommandRow[] = scopedPluginCommands.map((cmd) => {
    const shortcut = typeof cmd.spec.shortcut === 'string' ? cmd.spec.shortcut.trim() : ''
    return {
      kind: 'command',
      id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
      group: 'commands',
      title: resolveLocalizedText(cmd.spec.title, locale),
      hint: commandHint(cmd.spec, cmd.pluginId, locale),
      ...(shortcut !== '' ? { shortcut } : {}),
      icon: cmd.spec.icon ?? 'zap',
      keywords: [
        ...(cmd.spec.keywords ?? []),
        ...(cmd.spec.slash !== undefined ? [cmd.spec.slash, `/${cmd.spec.slash}`] : []),
      ],
      run: () => {
        if (cmd.spec.client !== undefined) {
          onPreviewCommand({ pluginId: cmd.pluginId, spec: cmd.spec })
          return
        }
        onInvokePluginCommand(cmd)
      },
    }
  })

  return [
    ...pluginCommands,
    {
      kind: 'command',
      id: 'builtin:open-shortcuts',
      group: 'commands',
      title: t('modals.palette.cmd.openShortcuts'),
      shortcut: formatModShortcut('/'),
      icon: 'terminal',
      keywords: ['shortcuts', 'keyboard', 'help', 'hotkey', 'hotkeys', '快捷键', '键盘', '帮助'],
      skipCloseAutoFocus: true,
      run: () => openShortcuts(),
    },
    {
      kind: 'command',
      id: 'builtin:toggle-sidebar',
      group: 'commands',
      title: sidebarCollapsed ? t('modals.palette.cmd.expandSidebar') : t('modals.palette.cmd.collapseSidebar'),
      shortcut: formatModShortcut('B'),
      icon: 'columns',
      keywords: ['sidebar', 'collapse', 'Sidebar', 'Collapse', 'Navigation', '侧栏', '导航', '收起', '展开'],
      run: () => toggleSidebarCollapsed?.(),
    },
    {
      kind: 'command',
      id: 'builtin:toggle-theme',
      group: 'commands',
      title:
        themePreference === 'system'
          ? t('modals.palette.cmd.themeToLight')
          : themePreference === 'light'
            ? t('modals.palette.cmd.themeToDark')
            : t('modals.palette.cmd.themeToSystem'),
      icon: themePreference === 'system' ? 'monitor' : themePreference === 'light' ? 'sun' : 'moon',
      keywords: ['theme', 'light', 'dark', 'system', '主题', '浅色', '暗色', '系统'],
      run: () => toggleTheme(),
    },
    {
      kind: 'command',
      id: 'builtin:cycle-locale',
      group: 'commands',
      title:
        localePref === 'auto'
          ? t('modals.palette.cmd.localeToEnglish')
          : localePref === 'en'
            ? t('modals.palette.cmd.localeToZhCn')
            : t('modals.palette.cmd.localeToAuto'),
      hint: localePref === 'auto' ? t('shell.locale.auto') : localePref === 'en' ? 'English' : '简体中文',
      icon: 'globe',
      keywords: ['language', 'locale', 'i18n', 'auto', 'english', 'chinese', '语言', '中文', '英文', '自动'],
      run: () => {
        const nextPref: LocalePreference =
          localePref === 'auto' ? 'en' : localePref === 'en' ? 'zh-CN' : 'auto'
        if (setLocalePreference) setLocalePreference(nextPref)
        else setLocale(nextPref === 'auto' ? resolveBrowserLocale() : nextPref)
      },
    },
    {
      kind: 'command',
      id: 'builtin:toggle-quiet-notify',
      group: 'commands',
      title: quietNotifyEnabled
        ? t('modals.palette.cmd.quietNotifyDisable')
        : t('modals.palette.cmd.quietNotifyEnable'),
      icon: quietNotifyEnabled ? 'bell' : 'bell-off',
      keywords: [
        'notify',
        'notification',
        'background',
        'quiet',
        'blocked',
        'Notifications',
        'Alerts',
        'Background',
        'Completed',
        'Approvals',
        '通知',
        '后台',
        '提醒',
        '审批',
      ],
      run: () => {
        void setQuietNotify(!quietNotifyEnabled)
      },
    },
  ]
}
