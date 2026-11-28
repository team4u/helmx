/**
 * Modal-support model copy (node picker option labels, node enrollment ID
 * validation, node upgrade gating hints, node usage label; provider auth and
 * profile editor skills models carry no display copy). Owner: the
 * profiles-skills partition.
 *
 * These models are consumed by modules owned by other partitions; their pure
 * functions take an optional `t` and default to the English bridge translator
 * so unmigrated call sites keep rendering English exactly as before.
 */
import type { MessageTable } from '../messages.js'

export const modalsMessages = {
  // Node enrollment ID validation (form display copy).
  'modals.nodeId.empty': { en: 'Enter a node ID', 'zh-CN': '请输入节点 ID' },
  'modals.nodeId.localReserved': {
    en: 'local is the built-in local node; no access token needed',
    'zh-CN': 'local 是内建本机节点，无需签发接入令牌',
  },
  'modals.nodeId.invalidChars': {
    en: 'Node ID must start with a letter or digit and contain only letters, digits and . _ - (max 128 characters)',
    'zh-CN': '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符',
  },

  // Node option labels for conversation/profile node pickers.
  'modals.nodeOption.local': { en: '{id} (local)', 'zh-CN': '{id} (本机)' },
  'modals.nodeOption.offline': { en: '{id} (offline)', 'zh-CN': '{id} (离线)' },

  // Node upgrade confirm gating hints.
  'modals.nodeUpgrade.offline': { en: 'Node is offline; cannot upgrade', 'zh-CN': '节点已离线，无法升级' },
  'modals.nodeUpgrade.invalidTarget': {
    en: 'Target version is not valid SemVer (e.g. 0.2.0)',
    'zh-CN': '目标版本不是合法 SemVer（示例 0.2.0）',
  },
  'modals.nodeUpgrade.checkFirst': {
    en: 'Check for updates first, or enter an explicit target version',
    'zh-CN': '请先检查更新，或填写明确的目标版本',
  },
  'modals.nodeUpgrade.upToDate': {
    en: 'Already up to date; tick force reinstall/retry or enter a target version',
    'zh-CN': '当前已是最新版本；可勾选强制重装/重试，或填写目标版本',
  },

  // Node resource usage summary label.
  'modals.nodeUsage.label': { en: '{used} / {total} ({percent}%)', 'zh-CN': '{used} / {total}（{percent}%）' },

  // Command palette & global Omnibox (OmniboxModal)
  'modals.palette.dialogTitle': {
    en: 'Command palette and global search',
    'zh-CN': '命令面板与全局搜索',
  },
  'modals.palette.searchAria': {
    en: 'Search pages, settings, commands, conversations, or messages',
    'zh-CN': '搜索页面、设置、命令、会话或消息正文',
  },
  'modals.palette.searchPlaceholder': {
    en: 'Search everywhere — pages, settings, > commands, # conversations...',
    'zh-CN': '全局搜索页面、设置、> 命令、# 会话或消息正文...',
  },
  'modals.palette.searching': { en: 'Searching', 'zh-CN': '搜索中' },
  'modals.palette.searchingHint': { en: 'Searching remote resources and messages…', 'zh-CN': '正在搜索远端资源与消息记录…' },
  'modals.palette.searchUnavailable': {
    en: 'Full-text message search is temporarily unavailable',
    'zh-CN': '全文消息搜索暂时不可用',
  },
  'modals.palette.resultsAria': { en: 'Command and search results', 'zh-CN': '命令与搜索结果' },
  'modals.palette.clearSearch': { en: 'Clear search query', 'zh-CN': '清空搜索内容' },
  'modals.palette.escToClose': { en: 'Esc to close', 'zh-CN': 'Esc 关闭' },
  'modals.palette.closePreview': { en: 'Close command content preview', 'zh-CN': '关闭命令内容预览' },
  'modals.palette.previewLabel': { en: 'Command {id} content', 'zh-CN': '命令 {id} 内容' },
  'modals.palette.runAction': { en: 'Run', 'zh-CN': '执行' },
  'modals.palette.navRowTitle': {
    en: 'Enter to open · {modEnter} to open in split',
    'zh-CN': 'Enter 打开 · {modEnter} 在右侧分屏打开',
  },
  'modals.palette.group.context': { en: 'Current context', 'zh-CN': '当前上下文' },
  'modals.palette.group.recent': { en: 'Recent conversations', 'zh-CN': '最近会话' },
  'modals.palette.group.navigation': { en: 'Navigate', 'zh-CN': '快速跳转' },
  'modals.palette.group.commands': { en: 'Commands', 'zh-CN': '快捷命令' },
  'modals.palette.noResults': { en: 'No matching results', 'zh-CN': '未找到匹配结果' },
  'modals.palette.emptyHint': {
    en: 'Type keywords to search, or pick a command below',
    'zh-CN': '输入关键词进行搜索，或选择下方快捷命令',
  },
  'modals.palette.cmdExecuted': { en: 'Command executed', 'zh-CN': '命令已执行' },
  'modals.palette.cmdFailed': { en: 'Command execution failed', 'zh-CN': '命令执行失败' },
  'modals.palette.convSnippet': { en: 'Conversation #{id} / {profileId}', 'zh-CN': '会话 #{id} / {profileId}' },
  'modals.palette.recentSnippet': {
    en: 'Recent conversation #{id} / {profileId}',
    'zh-CN': '最近会话 #{id} / {profileId}',
  },
  'modals.palette.cmd.toggleModelPicker': { en: 'Switch current model', 'zh-CN': '切换当前模型' },
  'modals.palette.cmd.focusComposer': { en: 'Focus message input', 'zh-CN': '聚焦对话框' },
  'modals.palette.cmd.toggleProcessGroups': {
    en: 'Expand / collapse recent process steps',
    'zh-CN': '展开 / 收起最近过程步骤',
  },
  'modals.palette.cmd.closeWorkbench': { en: 'Close workbench drawer', 'zh-CN': '关闭右侧工作台' },
  'modals.palette.cmd.openWorkbench': { en: 'Open workbench drawer', 'zh-CN': '打开右侧工作台' },
  'modals.palette.cmd.newConversation': { en: 'New conversation', 'zh-CN': '新建会话' },
  'modals.palette.cmd.selectProfileFirst': { en: 'Select a profile first', 'zh-CN': '请先选择角色' },
  'modals.palette.cmd.closeSplit': { en: 'Close right split view', 'zh-CN': '关闭右侧分屏' },
  'modals.palette.cmd.expandSidebar': { en: 'Expand desktop sidebar', 'zh-CN': '展开桌面侧栏' },
  'modals.palette.cmd.collapseSidebar': { en: 'Collapse desktop sidebar', 'zh-CN': '收起桌面侧栏' },
  'modals.palette.cmd.openOverview': { en: 'Open conversation overview', 'zh-CN': '打开会话总览' },
  'modals.palette.cmd.openAgent': { en: 'Open agent: {name}', 'zh-CN': '打开智能体：{name}' },
  'modals.palette.cmd.openProfiles': { en: 'Open agent profile center', 'zh-CN': '打开智能体角色中心' },
  'modals.palette.cmd.openModels': {
    en: 'Open models and credentials center',
    'zh-CN': '打开模型与凭证中心',
  },
  'modals.palette.cmd.openSkills': { en: 'Open skills center', 'zh-CN': '打开技能中心' },
  'modals.palette.cmd.openNodes': { en: 'Open compute nodes center', 'zh-CN': '打开计算节点中心' },
  'modals.palette.cmd.openPlugins': { en: 'Open plugins center', 'zh-CN': '打开插件中心' },
  'modals.palette.cmd.themeToLight': { en: 'Switch to light mode', 'zh-CN': '切换为浅色模式' },
  'modals.palette.cmd.themeToDark': { en: 'Switch to dark mode', 'zh-CN': '切换为暗色模式' },
  'modals.palette.cmd.themeToSystem': { en: 'Switch to system theme', 'zh-CN': '切换为跟随系统主题' },
  'modals.palette.cmd.localeToEnglish': { en: 'Switch language to English', 'zh-CN': '切换语言为 English' },
  'modals.palette.cmd.localeToZhCn': { en: 'Switch language to 简体中文', 'zh-CN': '切换语言为简体中文' },
  'modals.palette.cmd.localeToAuto': {
    en: 'Switch language to Auto (browser)',
    'zh-CN': '切换语言为自动（跟随浏览器）',
  },
  'modals.palette.cmd.quietNotifyDisable': {
    en: 'Disable background browser notifications',
    'zh-CN': '关闭后台浏览器通知',
  },
  'modals.palette.cmd.quietNotifyEnable': {
    en: 'Enable background browser notifications (alert when a conversation completes or awaits input while the page is in the background)',
    'zh-CN': '开启后台浏览器通知（页面在后台时，会话完成或需要输入将提醒）',
  },
  'modals.palette.cmd.openShortcuts': { en: 'Keyboard shortcuts', 'zh-CN': '查看全部快捷键' },
  'modals.palette.footerSelect': { en: 'select', 'zh-CN': '选择' },
  'modals.palette.footerOpen': { en: 'open', 'zh-CN': '打开' },
  'modals.palette.footerSplit': { en: 'open in split', 'zh-CN': '分屏打开' },
  'modals.palette.footerClose': { en: 'close', 'zh-CN': '关闭' },
  'modals.palette.footerShortcuts': { en: 'Shortcuts', 'zh-CN': '快捷键' },

  // Global Omnibox extensions (scopes, sections, entity actions, statuses, degraded notices)
  'modals.omnibox.scope.aria': { en: 'Search scopes', 'zh-CN': '搜索分类' },
  'modals.omnibox.scope.all': { en: 'All', 'zh-CN': '全部' },
  'modals.omnibox.scope.pages': { en: 'Pages & Settings', 'zh-CN': '页面与设置' },
  'modals.omnibox.scope.commands': { en: 'Commands', 'zh-CN': '命令' },
  'modals.omnibox.scope.conversations': { en: 'Conversations', 'zh-CN': '会话' },
  'modals.omnibox.group.topHit': { en: 'Top hit', 'zh-CN': '最佳匹配' },
  'modals.omnibox.group.context': { en: 'Current context', 'zh-CN': '当前上下文' },
  'modals.omnibox.group.recent': { en: 'Recent', 'zh-CN': '最近访问' },
  'modals.omnibox.group.quick': { en: 'Quick navigation & commands', 'zh-CN': '快速导航与命令' },
  'modals.omnibox.group.pages': { en: 'Pages & settings', 'zh-CN': '页面与设置' },
  'modals.omnibox.group.commands': { en: 'Commands', 'zh-CN': '命令' },
  'modals.omnibox.group.conversations': { en: 'Conversations', 'zh-CN': '会话' },
  'modals.omnibox.group.resources': { en: 'Plugin resources', 'zh-CN': '插件资源' },
  'modals.omnibox.group.messages': { en: 'Messages', 'zh-CN': '消息正文' },
  'modals.omnibox.viewAll': { en: 'View all {count} · Tab', 'zh-CN': '查看全部 {count} 项 · Tab' },
  'modals.omnibox.matchedModel': { en: 'Model: {model}', 'zh-CN': '匹配模型：{model}' },
  'modals.omnibox.failedPlugins': {
    en: 'Some plugin search providers are unavailable: {plugins}',
    'zh-CN': '部分插件搜索暂时不可用：{plugins}',
  },
  'modals.omnibox.searchFailed': {
    en: 'Remote search is temporarily unavailable; showing local results',
    'zh-CN': '远端搜索暂时不可用，当前仅展示本地结果',
  },
  'modals.omnibox.footerSwitchScope': { en: 'switch scope', 'zh-CN': '切换分类' },
  'modals.omnibox.footerSecondary': { en: 'secondary', 'zh-CN': '次操作' },
  'modals.omnibox.navRowTitleWithSecondary': {
    en: 'Enter to open · {modEnter} split · Alt+Enter {secondary}',
    'zh-CN': 'Enter 打开 · {modEnter} 分屏 · Alt+Enter {secondary}',
  },
  'modals.omnibox.page.overviewArchived': { en: 'Archived conversations', 'zh-CN': '已归档会话' },
  'modals.omnibox.page.overviewAttention': { en: 'Conversations needing attention', 'zh-CN': '需处理的会话' },
  'modals.omnibox.page.modelsDefaults': { en: 'Global model defaults', 'zh-CN': '全局默认模型' },
  'modals.omnibox.page.pluginsCore': { en: 'Core capabilities', 'zh-CN': '内核能力' },
  'modals.omnibox.action.configureProfile': { en: 'Configure', 'zh-CN': '配置角色' },
  'modals.omnibox.action.openAgent': { en: 'Start chat', 'zh-CN': '发起对话' },
  'modals.omnibox.action.pluginSettings': { en: 'Plugin settings', 'zh-CN': '插件设置' },
  'modals.omnibox.action.openView': { en: 'Open view', 'zh-CN': '打开视图' },
  'modals.omnibox.subtitle.profileSettings': { en: 'Profile settings · {id}', 'zh-CN': '角色配置 · {id}' },
  'modals.omnibox.subtitle.pluginSettings': { en: 'Plugin settings · {id}', 'zh-CN': '插件配置 · {id}' },
  'modals.omnibox.subtitle.modelsDefaults': {
    en: 'Default model, compaction and thinking level',
    'zh-CN': '默认模型、压缩模型与思考档位',
  },
  'modals.omnibox.subtitle.pluginsCore': {
    en: 'Built-in kernel actions and CLI capabilities',
    'zh-CN': '内核内置动作与 CLI 能力',
  },
  'modals.omnibox.status.online': { en: 'Online', 'zh-CN': '在线' },
  'modals.omnibox.status.offline': { en: 'Offline', 'zh-CN': '离线' },
  'modals.omnibox.status.enabled': { en: 'Enabled', 'zh-CN': '已启用' },
  'modals.omnibox.status.disabled': { en: 'Disabled', 'zh-CN': '已停用' },
  'modals.omnibox.status.error': { en: 'Error', 'zh-CN': '异常' },
  'modals.omnibox.status.open': { en: 'Open', 'zh-CN': '已打开' },
  'modals.omnibox.status.closed': { en: 'Closed', 'zh-CN': '已关闭' },
  'modals.omnibox.status.collapsed': { en: 'Collapsed', 'zh-CN': '已收起' },
  'modals.omnibox.status.expanded': { en: 'Expanded', 'zh-CN': '已展开' },
  'modals.omnibox.status.on': { en: 'On', 'zh-CN': '已开启' },
  'modals.omnibox.status.off': { en: 'Off', 'zh-CN': '已关闭' },
  'modals.omnibox.crumb.pluginSettings': { en: 'Plugin settings', 'zh-CN': '插件设置' },
  'modals.omnibox.crumb.pluginConfig': { en: 'Plugin config', 'zh-CN': '插件配置' },
  'modals.omnibox.crumb.workbench': { en: 'Workbench', 'zh-CN': '工作台' },
  'modals.omnibox.cmd.openWorkbenchTab': { en: 'Workbench: {label}', 'zh-CN': '工作台：{label}' },
  'modals.omnibox.cmd.createProfile': { en: 'Create agent profile', 'zh-CN': '新建智能体角色' },
  'modals.omnibox.cmd.createGateway': { en: 'Add custom model gateway', 'zh-CN': '添加自定义模型网关' },
  'modals.omnibox.cmd.createNode': { en: 'Enroll compute node', 'zh-CN': '接入计算节点' },

  // Keyboard shortcuts modal (ShortcutsModal + buildShortcutCatalog)
  'modals.shortcuts.title': { en: 'Keyboard shortcuts', 'zh-CN': '键盘快捷键' },
  'modals.shortcuts.closeTitle': { en: 'Close keyboard shortcuts (Esc)', 'zh-CN': '关闭快捷键说明 (Esc)' },
  'modals.shortcuts.loading': { en: 'Loading keyboard shortcuts…', 'zh-CN': '正在加载快捷键说明…' },
  'modals.shortcuts.section.navigation': { en: 'Navigation', 'zh-CN': '全局导航' },
  'modals.shortcuts.section.conversation': { en: 'Conversation', 'zh-CN': '会话操作' },
  'modals.shortcuts.section.composer': { en: 'Composer', 'zh-CN': '输入框' },
  'modals.shortcuts.item.commandPalette': { en: 'Command palette & search', 'zh-CN': '命令面板与全局搜索' },
  'modals.shortcuts.item.newTopic': { en: 'New topic', 'zh-CN': '新建话题' },
  'modals.shortcuts.item.newTopicDesc': {
    en: 'Start a new topic; press again on the new topic page to switch profile',
    'zh-CN': '新建话题；在待命页再按一次可切换角色',
  },
  'modals.shortcuts.item.toggleSidebar': { en: 'Toggle sidebar', 'zh-CN': '展开 / 收起侧栏' },
  'modals.shortcuts.item.openShortcuts': { en: 'Keyboard shortcuts', 'zh-CN': '快捷键总览' },
  'modals.shortcuts.item.focusComposer': { en: 'Focus message input', 'zh-CN': '聚焦对话框' },
  'modals.shortcuts.item.toggleWorkbench': { en: 'Toggle workbench', 'zh-CN': '展开 / 收起工作台' },
  'modals.shortcuts.item.switchModel': { en: 'Switch model', 'zh-CN': '切换当前模型' },
  'modals.shortcuts.item.togglePlusMenu': { en: 'Toggle attachments & actions menu', 'zh-CN': '展开 / 收起附件与操作菜单' },
  'modals.shortcuts.item.toggleProcessSteps': { en: 'Toggle process steps', 'zh-CN': '展开 / 收起过程步骤' },
  'modals.shortcuts.item.abortTurn': { en: 'Abort running turn', 'zh-CN': '中止当前执行' },
  'modals.shortcuts.item.sendOrSteer': { en: 'Send / steer', 'zh-CN': '发送 / 运行中插话引导' },
  'modals.shortcuts.item.queueSend': { en: 'Queue send (follow-up)', 'zh-CN': '排队发送（回合结束后）' },
  'modals.shortcuts.item.newline': { en: 'Newline', 'zh-CN': '换行' },
  'modals.shortcuts.item.recallOrEdit': { en: 'Recall queued / edit previous', 'zh-CN': '撤回排队 / 编辑上一条' },
  'modals.shortcuts.item.slashCommands': { en: 'Commands & skills', 'zh-CN': '命令与技能菜单' },
  'modals.shortcuts.item.mentions': { en: 'Mentions', 'zh-CN': '引用与补全' },
  'modals.shortcuts.item.dismissOrCancel': { en: 'Close popover / cancel edit', 'zh-CN': '关闭浮层 / 取消编辑' },
} satisfies MessageTable
