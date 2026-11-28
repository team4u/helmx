/**
 * 0ms synchronous Commands source builders:
 * - Current-context commands (composer focus, model picker, process steps, workbench, new topic, close split)
 * - Quick-create commands (`profiles/new`, `models/new`, `nodes/new`)
 * - Plugin `ctx.ui.command` items (supporting `client` preview, declarative `target`, and `actionId`)
 * - Host utility toggles carrying live `statusBadge` values (sidebar, theme, locale, quiet-notify, shortcuts)
 */
import {
  resolveLocalizedText,
  type ConversationSummary,
  type HelmxLocale,
  type PluginSummary,
  type Profile,
} from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { commandHint, type QualifiedCommand } from '../../lib/commands-model.js'
import { resolveBrowserLocale } from '../../lib/theme-preferences.js'
import {
  resolveTargetString,
  type FocusedPanel,
  type GroupedUiSpecs,
  type LocalePreference,
  type ResolvedTarget,
  type ThemePreference,
} from '../../lib/types.js'
import {
  formatModShiftShortcut,
  formatModShortcut,
  resolveNewTopicTarget,
  type HelmxShortcutDetail,
} from '../../shell/shortcuts-model.js'
import type { OmniboxIntent, OmniboxItem } from '../types.js'
import { dedupeStrings, extractLocalizedStrings } from './helpers.js'

export interface BuildContextCommandsInput {
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
}

export function buildContextCommandItems(input: BuildContextCommandsInput): OmniboxItem[] {
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

  const list: OmniboxItem[] = []
  if (activeTarget.kind === 'conversation' || activeTarget.kind === 'agent') {
    list.push({
      id: 'builtin:focus-composer',
      kind: 'command',
      scope: 'commands',
      group: 'context',
      title: t('modals.palette.cmd.focusComposer'),
      shortcut: formatModShortcut('I'),
      icon: 'message-square',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.focusComposer'), 'Focus message input', '聚焦对话框']),
        aliases: ['focus', 'composer', 'input', 'chat', 'message', '聚焦', '输入', '对话框'],
      },
      intent: {
        type: 'run',
        skipCloseAutoFocus: true,
        run: () => {
          const detail: HelmxShortcutDetail = { action: 'focus-composer', panel: activePanel }
          const dispatch = (): void => {
            window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(dispatch)
          else setTimeout(dispatch, 0)
        },
      },
    })
    list.push({
      id: 'builtin:toggle-model-picker',
      kind: 'command',
      scope: 'commands',
      group: 'context',
      title: t('modals.palette.cmd.toggleModelPicker'),
      shortcut: 'Ctrl+L',
      icon: 'sparkles',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.toggleModelPicker'), 'Switch current model', '切换当前模型']),
        aliases: ['model', 'picker', 'switch model', '模型', '切换模型'],
      },
      intent: {
        type: 'run',
        skipCloseAutoFocus: true,
        run: () => {
          const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        },
      },
    })
  }

  if (activeTarget.kind === 'conversation') {
    list.push({
      id: 'builtin:toggle-process-groups',
      kind: 'command',
      scope: 'commands',
      group: 'context',
      title: t('modals.palette.cmd.toggleProcessGroups'),
      shortcut: 'Ctrl+O',
      icon: 'list-tree',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([
          t('modals.palette.cmd.toggleProcessGroups'),
          'Expand / collapse recent process steps',
          '展开 / 收起最近过程步骤',
        ]),
        aliases: ['process', 'thinking', 'tools', 'collapse', 'expand', '过程', '思考', '工具', '收起', '展开'],
      },
      intent: {
        type: 'run',
        run: () => {
          const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel: activePanel }
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        },
      },
    })
  }

  if (activeTarget.kind === 'conversation' || workbenchOpen) {
    const wbTitle = workbenchOpen
      ? t('modals.palette.cmd.closeWorkbench')
      : t('modals.palette.cmd.openWorkbench')
    list.push({
      id: 'builtin:toggle-workbench',
      kind: 'command',
      scope: 'commands',
      group: 'context',
      title: wbTitle,
      shortcut: formatModShortcut('J'),
      icon: 'panel-right',
      statusBadge: {
        label: workbenchOpen ? t('modals.omnibox.status.open') : t('modals.omnibox.status.closed'),
        tone: workbenchOpen ? 'accent' : 'neutral',
      },
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([wbTitle, 'Open workbench drawer', 'Close workbench drawer', '打开右侧工作台', '关闭右侧工作台']),
        aliases: ['workbench', 'drawer', 'artifacts', '工作台', '产物'],
      },
      intent: {
        type: 'run',
        run: () => setWorkbenchOpen(!workbenchOpen),
      },
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
    id: 'builtin:new-conversation',
    kind: 'command',
    scope: 'commands',
    group: 'context',
    title: t('modals.palette.cmd.newConversation'),
    subtitle:
      newTopicTarget.kind === 'agent'
        ? newTopicTarget.profileId
        : t('modals.palette.cmd.selectProfileFirst'),
    shortcut: formatModShiftShortcut('O'),
    icon: 'plus',
    emptyStateVisible: true,
    searchTerms: {
      primary: dedupeStrings([t('modals.palette.cmd.newConversation'), 'New conversation', 'New topic', '新建会话', '新建话题']),
      aliases: ['new', 'conversation', 'topic', 'chat', '新建', '会话', '话题'],
    },
    intent: { type: 'navigate', target: newTopicTarget },
  })

  if (splitTarget) {
    list.push({
      id: 'builtin:close-split',
      kind: 'command',
      scope: 'commands',
      group: 'context',
      title: t('modals.palette.cmd.closeSplit'),
      icon: 'panel-right',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.closeSplit'), 'Close right split view', '关闭右侧分屏']),
        aliases: ['split', 'close', '分屏', '关闭'],
      },
      intent: { type: 'run', run: () => closeSplit() },
    })
  }

  return list
}

export interface BuildUtilityAndPluginCommandsInput {
  scopedPluginCommands: ReadonlyArray<QualifiedCommand>
  conversations: ReadonlyArray<ConversationSummary>
  locale: HelmxLocale
  sidebarCollapsed: boolean
  themePreference: ThemePreference
  localePref: LocalePreference
  quietNotifyEnabled: boolean
  onInvokePluginCommand: (cmd: QualifiedCommand) => void
  openTargetRaw: (target: string) => void
  openShortcuts: () => void
  toggleSidebarCollapsed?: () => void
  toggleTheme: () => void
  setLocalePreference?: (pref: LocalePreference) => void
  setLocale: (locale: HelmxLocale) => void
  setQuietNotify: (on: boolean) => Promise<void>
  t: WebMessageTranslator
}

export function buildUtilityAndPluginCommandItems(
  input: BuildUtilityAndPluginCommandsInput,
): OmniboxItem[] {
  const {
    scopedPluginCommands,
    conversations,
    locale,
    sidebarCollapsed,
    themePreference,
    localePref,
    quietNotifyEnabled,
    onInvokePluginCommand,
    openTargetRaw,
    openShortcuts,
    toggleSidebarCollapsed,
    toggleTheme,
    setLocalePreference,
    setLocale,
    setQuietNotify,
    t,
  } = input

  // 1. Plugin `ctx.ui.command` contributions (client preview | declarative target | actionId)
  const pluginCommandItems: OmniboxItem[] = scopedPluginCommands.map((cmd) => {
    const { spec } = cmd
    const shortcut = typeof spec.shortcut === 'string' ? spec.shortcut.trim() : ''
    const title = resolveLocalizedText(spec.title, locale) || spec.id
    const hint = commandHint(spec, cmd.pluginId, locale)

    let intent: OmniboxIntent
    if (spec.client !== undefined) {
      intent = { type: 'preview', pluginId: cmd.pluginId, spec }
    } else if (typeof spec.target === 'string' && spec.target.trim() !== '') {
      const resolved = resolveTargetString(spec.target, [...conversations])
      intent =
        resolved !== null
          ? { type: 'navigate', target: resolved }
          : { type: 'run', run: () => openTargetRaw(spec.target!) }
    } else {
      intent = { type: 'run', run: () => onInvokePluginCommand(cmd) }
    }

    return {
      id: `plugin:${cmd.pluginId}/${spec.id}`,
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title,
      subtitle: hint,
      ...(shortcut !== '' ? { shortcut } : {}),
      icon: spec.icon ?? 'zap',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([title, ...extractLocalizedStrings(spec.title)]),
        breadcrumb: dedupeStrings([cmd.pluginId]),
        aliases: dedupeStrings([
          ...extractLocalizedStrings(spec.description),
          ...(spec.keywords ?? []),
          spec.id,
          ...(spec.slash !== undefined ? [spec.slash, `/${spec.slash}`] : []),
          ...(spec.target !== undefined ? [spec.target] : []),
          ...(spec.actionId !== undefined ? [spec.actionId] : []),
        ]),
        exactTokens: dedupeStrings([
          ...(spec.slash !== undefined ? [`/${spec.slash}`, spec.slash] : []),
        ]),
      },
      intent,
    }
  })

  // 2. Quick Create actions (`profiles/new`, `models/new`, `nodes/new`, searchable at 0ms)
  const quickCreateItems: OmniboxItem[] = [
    {
      id: 'builtin:create-profile',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: t('modals.omnibox.cmd.createProfile'),
      breadcrumb: [t('shell.center.profiles')],
      icon: 'plus',
      emptyStateVisible: false,
      searchTerms: {
        primary: dedupeStrings([t('modals.omnibox.cmd.createProfile'), 'New profile', 'Create agent profile', '新建角色']),
        breadcrumb: [t('shell.center.profiles'), 'Profiles', '角色'],
        aliases: ['create', 'new', 'add', 'profile', 'agent', 'profiles/new', '新建', '创建', '角色', '智能体'],
      },
      intent: { type: 'navigate', target: { kind: 'profiles', profileId: 'new' } },
    },
    {
      id: 'builtin:create-model-gateway',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: t('modals.omnibox.cmd.createGateway'),
      breadcrumb: [t('shell.center.models')],
      icon: 'plus',
      emptyStateVisible: false,
      searchTerms: {
        primary: dedupeStrings([t('modals.omnibox.cmd.createGateway'), 'Add custom model gateway', '添加自定义模型网关']),
        breadcrumb: [t('shell.center.models'), 'Models', '模型'],
        aliases: ['create', 'new', 'add', 'provider', 'gateway', 'model', 'models/new', '新建', '添加', '网关', '供应商'],
      },
      intent: { type: 'navigate', target: { kind: 'models', providerId: 'new' } },
    },
    {
      id: 'builtin:create-node',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: t('modals.omnibox.cmd.createNode'),
      breadcrumb: [t('shell.center.nodes')],
      icon: 'plus',
      emptyStateVisible: false,
      searchTerms: {
        primary: dedupeStrings([t('modals.omnibox.cmd.createNode'), 'Enroll compute node', '接入计算节点']),
        breadcrumb: [t('shell.center.nodes'), 'Nodes', '节点'],
        aliases: ['create', 'new', 'add', 'enroll', 'node', 'byom', 'nodes/new', '新建', '接入', '节点'],
      },
      intent: { type: 'navigate', target: { kind: 'nodes', nodeId: 'new' } },
    },
  ]

  // 3. Host utility commands with live status badges
  const themeBadgeLabel =
    themePreference === 'system'
      ? t('shell.theme.system')
      : themePreference === 'light'
        ? t('shell.theme.currentLight')
        : t('shell.theme.currentDark')
  const localeBadgeLabel =
    localePref === 'auto' ? t('shell.locale.auto') : localePref === 'en' ? 'English' : '简体中文'

  const utilityItems: OmniboxItem[] = [
    {
      id: 'builtin:open-shortcuts',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: t('modals.palette.cmd.openShortcuts'),
      shortcut: formatModShortcut('/'),
      icon: 'terminal',
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([t('modals.palette.cmd.openShortcuts'), 'Keyboard shortcuts', '查看全部快捷键']),
        aliases: ['shortcuts', 'keyboard', 'help', 'hotkey', 'hotkeys', '快捷键', '键盘', '帮助'],
      },
      intent: {
        type: 'run',
        skipCloseAutoFocus: true,
        run: () => openShortcuts(),
      },
    },
    {
      id: 'builtin:toggle-sidebar',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: sidebarCollapsed
        ? t('modals.palette.cmd.expandSidebar')
        : t('modals.palette.cmd.collapseSidebar'),
      shortcut: formatModShortcut('B'),
      icon: 'columns',
      statusBadge: {
        label: sidebarCollapsed ? t('modals.omnibox.status.collapsed') : t('modals.omnibox.status.expanded'),
        tone: 'neutral',
      },
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([
          sidebarCollapsed ? t('modals.palette.cmd.expandSidebar') : t('modals.palette.cmd.collapseSidebar'),
          'Toggle sidebar',
          'Expand desktop sidebar',
          'Collapse desktop sidebar',
          '展开桌面侧栏',
          '收起桌面侧栏',
        ]),
        aliases: ['sidebar', 'collapse', 'expand', 'navigation', '侧栏', '导航', '收起', '展开'],
      },
      intent: {
        type: 'run',
        run: () => toggleSidebarCollapsed?.(),
      },
    },
    {
      id: 'builtin:toggle-theme',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title:
        themePreference === 'system'
          ? t('modals.palette.cmd.themeToLight')
          : themePreference === 'light'
            ? t('modals.palette.cmd.themeToDark')
            : t('modals.palette.cmd.themeToSystem'),
      icon: themePreference === 'system' ? 'monitor' : themePreference === 'light' ? 'sun' : 'moon',
      statusBadge: {
        label: themeBadgeLabel,
        tone: 'neutral',
      },
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([
          themePreference === 'system'
            ? t('modals.palette.cmd.themeToLight')
            : themePreference === 'light'
              ? t('modals.palette.cmd.themeToDark')
              : t('modals.palette.cmd.themeToSystem'),
          'Switch theme',
          'Dark mode',
          'Light mode',
          '切换主题',
        ]),
        aliases: ['theme', 'light', 'dark', 'system', 'appearance', '主题', '浅色', '暗色', '深色', '系统'],
      },
      intent: {
        type: 'run',
        run: () => toggleTheme(),
      },
    },
    {
      id: 'builtin:cycle-locale',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title:
        localePref === 'auto'
          ? t('modals.palette.cmd.localeToEnglish')
          : localePref === 'en'
            ? t('modals.palette.cmd.localeToZhCn')
            : t('modals.palette.cmd.localeToAuto'),
      icon: 'globe',
      statusBadge: {
        label: localeBadgeLabel,
        tone: 'neutral',
      },
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([
          localePref === 'auto'
            ? t('modals.palette.cmd.localeToEnglish')
            : localePref === 'en'
              ? t('modals.palette.cmd.localeToZhCn')
              : t('modals.palette.cmd.localeToAuto'),
          'Switch language',
          '切换语言',
        ]),
        aliases: ['language', 'locale', 'i18n', 'auto', 'english', 'chinese', '语言', '中文', '英文', '自动'],
      },
      intent: {
        type: 'run',
        run: () => {
          const nextPref: LocalePreference =
            localePref === 'auto' ? 'en' : localePref === 'en' ? 'zh-CN' : 'auto'
          if (setLocalePreference) setLocalePreference(nextPref)
          else setLocale(nextPref === 'auto' ? resolveBrowserLocale() : nextPref)
        },
      },
    },
    {
      id: 'builtin:toggle-quiet-notify',
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: quietNotifyEnabled
        ? t('modals.palette.cmd.quietNotifyDisable')
        : t('modals.palette.cmd.quietNotifyEnable'),
      icon: quietNotifyEnabled ? 'bell' : 'bell-off',
      statusBadge: {
        label: quietNotifyEnabled ? t('modals.omnibox.status.on') : t('modals.omnibox.status.off'),
        tone: quietNotifyEnabled ? 'ok' : 'neutral',
      },
      emptyStateVisible: true,
      searchTerms: {
        primary: dedupeStrings([
          quietNotifyEnabled
            ? t('modals.palette.cmd.quietNotifyDisable')
            : t('modals.palette.cmd.quietNotifyEnable'),
          'Background browser notifications',
          '后台浏览器通知',
        ]),
        aliases: [
          'notify',
          'notification',
          'notifications',
          'background',
          'quiet',
          'alerts',
          'approvals',
          '通知',
          '后台',
          '提醒',
          '审批',
        ],
      },
      intent: {
        type: 'run',
        run: () => {
          void setQuietNotify(!quietNotifyEnabled)
        },
      },
    },
  ]

  return [...pluginCommandItems, ...utilityItems, ...quickCreateItems]
}
