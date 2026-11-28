/**
 * Plugin center display copy (PluginCenter / PluginCard / PluginDetailDrawer /
 * PluginInstallModal plus plugin-card-model / plugin-center-model /
 * plugin-package-model).
 *
 * zh-CN copy is backfilled from the pre-English baseline (b4a611a65)
 * wherever the string existed; interpolation uses `{param}`.
 */
import type { MessageTable } from '../messages.js'

export const pluginsMessages = {
  // Shared plugin labels
  'plugins.status.error': { en: 'Error', 'zh-CN': '异常' },
  'plugins.openView': { en: 'Open view', 'zh-CN': '打开视图' },
  'plugins.installPlugin': { en: 'Install plugin', 'zh-CN': '安装插件' },

  // Plugin descriptions & error stage labels (plugin-card-model)
  'plugins.desc.toolsPart': { en: '{count} tools', 'zh-CN': '{count} 个工具' },
  'plugins.desc.actionsPart': { en: '{count} actions', 'zh-CN': '{count} 个动作' },
  'plugins.desc.hooksPart': { en: '{count} hooks', 'zh-CN': '{count} 个钩子' },
  'plugins.desc.listSeparator': { en: ', ', 'zh-CN': '、' },
  'plugins.desc.providesCapabilities': {
    en: 'Provides {parts} capabilities.',
    'zh-CN': '提供 {parts}能力支持。',
  },
  'plugins.desc.default': {
    en: 'System extension plugin component.',
    'zh-CN': '系统扩展插件组件。',
  },
  'plugins.errorStage.scan': {
    en: 'Manifest/entry resolution (scan)',
    'zh-CN': '清单/入口解析（scan）',
  },
  'plugins.errorStage.load': {
    en: 'Module loading (load)',
    'zh-CN': '模块加载（load）',
  },
  'plugins.errorStage.define': {
    en: 'Definition registration (define)',
    'zh-CN': '定义注册（define）',
  },
  'plugins.errorStage.enable': {
    en: 'Enable activation (enable)',
    'zh-CN': '启用激活（enable）',
  },
  'plugins.errorStage.unknown': { en: 'Unknown stage', 'zh-CN': '未知阶段' },

  // PluginCard
  'plugins.card.switchLoadBrokenTitle': {
    en: 'Plugin failed to load; click to see error details',
    'zh-CN': '插件加载失败，请点击查看错误详情',
  },
  'plugins.card.switchDisableTitle': { en: 'Click to disable', 'zh-CN': '点击停用' },
  'plugins.card.switchEnableTitle': { en: 'Click to enable', 'zh-CN': '点击启用' },
  'plugins.card.versionTitle': { en: 'Version {version}', 'zh-CN': '版本 {version}' },
  'plugins.card.failedFallbackTitle': {
    en: 'Plugin failed to load or enable',
    'zh-CN': '插件加载或启用失败',
  },
  'plugins.card.toolsTitle': { en: '{count} Agent Tools', 'zh-CN': '{count} 个 Agent Tools' },
  'plugins.card.actionsTitle': {
    en: '{count} CLI/HTTP Actions',
    'zh-CN': '{count} 个 CLI/HTTP Actions',
  },
  'plugins.card.hooksTitle': {
    en: '{count} kernel lifecycle hooks',
    'zh-CN': '{count} 个内核生命周期钩子',
  },
  'plugins.card.openViewTitle': { en: 'Open plugin view', 'zh-CN': '打开插件视图' },
  'plugins.card.openViewAria': { en: 'Open {name} view', 'zh-CN': '打开 {name} 视图' },
  'plugins.card.openSplitTitle': {
    en: 'Open side-by-side in right split',
    'zh-CN': '在右侧分屏并排打开',
  },
  'plugins.card.openSplitAria': {
    en: 'Open {name} in right split',
    'zh-CN': '在右侧分屏打开 {name}',
  },
  'plugins.card.updateTitle': {
    en: 'Update plugin from source',
    'zh-CN': '从安装来源更新插件',
  },
  'plugins.card.updateAria': { en: 'Update {name}', 'zh-CN': '更新 {name}' },
  'plugins.card.switchAria': { en: '{name} switch', 'zh-CN': '{name} 开关' },

  // PluginCenter
  'plugins.center.title': { en: 'Plugin Center', 'zh-CN': '扩展插件中心' },
  'plugins.center.tabViews': { en: 'With views', 'zh-CN': '应用视图' },
  'plugins.center.updateAll': {
    en: 'Update all ({count})',
    'zh-CN': '全部更新（{count}）',
  },
  'plugins.center.updateAllAria': {
    en: 'Update all managed plugins',
    'zh-CN': '更新全部受管插件',
  },
  'plugins.center.updateAllTitle': {
    en: 'Re-fetch and update all managed external plugins sequentially',
    'zh-CN': '依次从安装来源拉取并更新全部受管外部插件',
  },
  'plugins.center.updatingAllProgress': {
    en: 'Updating ({current}/{total})…',
    'zh-CN': '正在更新（{current}/{total}）…',
  },
  'plugins.center.installTitle': {
    en: 'Install external plugins from npm, Git or a local path',
    'zh-CN': '从 npm、Git 或本地路径安装外部插件',
  },
  'plugins.center.searchPlaceholder': {
    en: 'Search plugin name, ID, tool or action…',
    'zh-CN': '搜索插件名称、ID、Tool 或 Action…',
  },
  'plugins.center.searchAria': { en: 'Search plugins', 'zh-CN': '搜索插件' },
  'plugins.center.clearSearch': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'plugins.center.filterAria': { en: 'Filter by plugin status', 'zh-CN': '插件状态筛选' },
  'plugins.center.emptyTitle': { en: 'No matching plugins', 'zh-CN': '未找到匹配的插件' },
  'plugins.center.emptyHint': {
    en: 'Try adjusting the search keywords or switching the status filter.',
    'zh-CN': '请尝试调整搜索关键字或切换启用状态筛选。',
  },
  'plugins.center.resetSearch': { en: 'Reset search', 'zh-CN': '重置搜索条件' },

  // PluginCenter notices
  'plugins.notice.installEnableFailedTitle': {
    en: 'Plugin installed, but enable failed',
    'zh-CN': '插件已安装，但启用失败',
  },
  'plugins.notice.enabledTitle': { en: 'Plugin enabled', 'zh-CN': '插件已启用' },
  'plugins.notice.enabledBody': { en: '{name} enabled successfully', 'zh-CN': '{name} 已成功启用' },
  'plugins.notice.disabledTitle': { en: 'Plugin disabled', 'zh-CN': '插件已停用' },
  'plugins.notice.disabledBody': {
    en: '{name} disabled successfully',
    'zh-CN': '{name} 已成功停用',
  },
  'plugins.notice.enableFailedTitle': {
    en: 'Failed to enable plugin',
    'zh-CN': '启用插件失败',
  },
  'plugins.notice.disableFailedTitle': {
    en: 'Failed to disable plugin',
    'zh-CN': '停用插件失败',
  },
  'plugins.notice.liveTasksError': {
    en: 'Operation failed: plugin has live tasks ({code})',
    'zh-CN': '操作失败：插件存在在途任务（{code}）',
  },

  // Plugin package model & install modal
  'plugins.package.sourceKind.npm': { en: 'npm package', 'zh-CN': 'npm 包' },
  'plugins.package.sourceKind.git': { en: 'Git repository', 'zh-CN': 'Git 仓库' },
  'plugins.package.sourceKind.local': { en: 'Local path', 'zh-CN': '本地路径' },
  'plugins.package.sourceKind.unknown': { en: 'Unrecognized', 'zh-CN': '无法识别' },
  'plugins.package.sourceBadge.local': { en: 'Local', 'zh-CN': '本地' },
  'plugins.package.doctorPassed': {
    en: 'Pre-install doctor passed',
    'zh-CN': '安装前自检通过',
  },
  'plugins.package.doctorFailedItem': {
    en: '{id} ({code}): {message}',
    'zh-CN': '{id}（{code}）：{message}',
  },
  'plugins.package.doctorSeparator': { en: '; ', 'zh-CN': '；' },
  'plugins.package.doctorFailed': {
    en: 'Pre-install doctor failed with {count} failures: {details}',
    'zh-CN': '安装前自检未通过，共 {count} 项失败：{details}',
  },
  'plugins.package.action.install': { en: 'Install', 'zh-CN': '安装' },
  'plugins.package.action.update': { en: 'Update', 'zh-CN': '更新' },
  'plugins.package.action.uninstall': { en: 'Uninstall', 'zh-CN': '卸载' },
  'plugins.package.errorLiveTasks': {
    en: '{action} failed: plugin has live tasks ({code}). Wait for them to finish or abort, then retry.',
    'zh-CN': '{action}失败：插件存在在途任务（{code}）。请等待任务结束或中止后再试。',
  },
  'plugins.package.errorWithMessage': {
    en: '{action} failed: {message}',
    'zh-CN': '{action}失败：{message}',
  },
  'plugins.package.errorGeneric': { en: '{action} failed', 'zh-CN': '{action}失败' },
  'plugins.package.unknownVersion': { en: 'Unknown version', 'zh-CN': '未知版本' },
  'plugins.package.updatedBody': {
    en: 'Updated to {version} (was {previous})',
    'zh-CN': '已更新到 {version}（此前 {previous}）',
  },
  'plugins.package.unchangedBody': {
    en: 'Source unchanged; still at {version}',
    'zh-CN': '源未变化，当前仍为 {version}',
  },
  'plugins.package.updateNoticeTitle': {
    en: 'Plugin package updated',
    'zh-CN': '插件包已更新',
  },
  'plugins.package.updateFailedNoticeTitle': {
    en: 'Plugin package update failed',
    'zh-CN': '插件包更新失败',
  },
  'plugins.package.updateAllDoneTitle': {
    en: 'Plugins updated',
    'zh-CN': '插件批量更新完成',
  },
  'plugins.package.updateAllPartialTitle': {
    en: 'Plugin batch update partially failed',
    'zh-CN': '部分插件更新失败',
  },
  'plugins.package.batchUpdatedCount': {
    en: '{count} updated',
    'zh-CN': '已更新 {count} 个',
  },
  'plugins.package.batchUnchangedCount': {
    en: '{count} unchanged',
    'zh-CN': '{count} 个无变化',
  },
  'plugins.package.batchFailedCount': {
    en: '{count} failed',
    'zh-CN': '{count} 个失败',
  },
  'plugins.package.updateNoticeBody': { en: '{name}: {detail}', 'zh-CN': '{name}：{detail}' },
  'plugins.package.installNoticeTitle': { en: 'Plugin installed', 'zh-CN': '插件已安装' },
  'plugins.package.installNoticeBody': { en: '{id} installed successfully', 'zh-CN': '{id} 已安装' },
  'plugins.package.removeNoticeTitle': {
    en: 'Plugin package uninstalled',
    'zh-CN': '插件包已卸载',
  },
  'plugins.package.removeNoticeBody': {
    en: '{name} removed ({id})',
    'zh-CN': '{name} 已移除（{id}）',
  },
  'plugins.package.sectionTitle': { en: 'Package', 'zh-CN': '包管理' },
  'plugins.package.sourceLabel': { en: 'Source', 'zh-CN': '来源' },
  'plugins.package.changeSource': { en: 'Change source', 'zh-CN': '更换来源' },
  'plugins.package.newSourcePlaceholder': {
    en: 'npm:pkg@^2.0.0 / git:repo@tag / /abs/path',
    'zh-CN': 'npm:pkg@^2.0.0 / git:repo@tag / 本地路径',
  },
  'plugins.package.installedVersionLabel': {
    en: 'Installed version',
    'zh-CN': '已安装版本',
  },
  'plugins.package.installedAtLabel': { en: 'Installed at', 'zh-CN': '安装时间' },
  'plugins.package.updating': { en: 'Updating…', 'zh-CN': '正在更新…' },
  'plugins.package.updatePlugin': { en: 'Update plugin', 'zh-CN': '更新插件' },
  'plugins.package.uninstalling': { en: 'Uninstalling…', 'zh-CN': '正在卸载…' },
  'plugins.package.uninstallPlugin': { en: 'Uninstall plugin', 'zh-CN': '卸载插件' },
  'plugins.package.confirmUninstallAria': {
    en: 'Confirm plugin uninstall',
    'zh-CN': '确认卸载插件',
  },
  'plugins.package.confirmUninstallBody': {
    en: 'Uninstall {name} ({id})? The install directory and registry entry will be deleted; this cannot be undone.',
    'zh-CN': '确定卸载 {name}（{id}）？将删除安装目录与注册记录，该操作不可恢复。',
  },
  'plugins.package.confirmUninstall': { en: 'Confirm uninstall', 'zh-CN': '确认卸载' },

  // PluginInstallModal
  'plugins.install.description': {
    en: 'Install external plugins from an npm package, Git repository or local path; local paths resolve on the Hub host filesystem, not this browser machine',
    'zh-CN': '从 npm 包、Git 仓库或本地路径安装外部插件；本地路径在 Hub 宿主机文件系统上解析，不是当前浏览器所在机器',
  },
  'plugins.install.sourceLabel': { en: 'Install source', 'zh-CN': '安装来源' },
  'plugins.install.enableAfterInstall': {
    en: 'Enable after install',
    'zh-CN': '安装后启用',
  },
  'plugins.install.enableNow': {
    en: 'Enable immediately after install',
    'zh-CN': '安装完成后立即启用',
  },
  'plugins.install.keepDisabled': {
    en: 'Keep disabled after install',
    'zh-CN': '安装后保持停用',
  },
  'plugins.install.securityWarning': {
    en: 'Plugins run inside the Hub process with host privileges and are not sandboxed. Only install plugin packages from trusted sources.',
    'zh-CN': '插件在 Hub 进程内运行，拥有宿主权限，不是沙箱。仅安装可信来源的插件包。',
  },
  'plugins.install.installing': { en: 'Installing…', 'zh-CN': '正在安装…' },
  'plugins.install.submit': { en: 'Install', 'zh-CN': '安装' },

  // PluginDetailDrawer
  'plugins.drawer.ariaSelected': { en: '{name} details', 'zh-CN': '{name} 详情' },
  'plugins.drawer.titleFallback': { en: 'Plugin details', 'zh-CN': '插件详情' },
  'plugins.drawer.dependenciesTitle': {
    en: 'Dependencies: {deps} (must be enabled first)',
    'zh-CN': '依赖插件：{deps}（启用前必须已启用）',
  },
  'plugins.drawer.dependenciesCount': { en: 'Dependencies {count}', 'zh-CN': '依赖 {count}' },
  'plugins.drawer.failedToLoad': { en: 'Failed to load', 'zh-CN': '加载失败' },
  'plugins.drawer.failedNoteDetail': {
    en: '{code}: {message} (stage {stage})',
    'zh-CN': '{code}：{message}（阶段 {stage}）',
  },
  'plugins.drawer.noSelection': { en: 'No plugin selected', 'zh-CN': '未选择插件' },
  'plugins.drawer.currentStatus': { en: 'Current status', 'zh-CN': '当前状态' },
  'plugins.drawer.errorBadgeTitle': {
    en: 'Plugin failed to load or enable; see diagnostics below',
    'zh-CN': '插件加载或启用失败，详见下方诊断信息',
  },
  'plugins.drawer.openMainViewTitle': { en: 'Open main view', 'zh-CN': '打开主视图' },
  'plugins.drawer.openMainViewMultiTitle': {
    en: 'Open main view {screenId} ({count} views in total)',
    'zh-CN': '打开主视图 {screenId}（共 {count} 个视图）',
  },
  'plugins.drawer.openSplitTitle': {
    en: 'Open side-by-side in the right split',
    'zh-CN': '在右侧分屏并排打开',
  },
  'plugins.drawer.openSplit': { en: 'Open in split', 'zh-CN': '右屏打开' },
  'plugins.drawer.disablePlugin': { en: 'Disable plugin', 'zh-CN': '停用插件' },
  'plugins.drawer.enablePlugin': { en: 'Enable plugin', 'zh-CN': '启用插件' },
  'plugins.drawer.disableInUseError': {
    en: 'Disable failed: the plugin holds persistent resources (plugin_in_use).',
    'zh-CN': '停用失败：插件存在关联的持久资源占用（plugin_in_use）。',
  },
  'plugins.drawer.disableLiveTasksError': {
    en: 'Disable failed: plugin has live tasks ({code}). Wait for them to finish or abort them, then retry.',
    'zh-CN': '停用失败：插件存在在途任务（{code}）。请等待任务结束或中止后再试。',
  },
  'plugins.drawer.diagnosticTitle': {
    en: 'Plugin failed to load or enable',
    'zh-CN': '插件加载或启用失败',
  },
  'plugins.drawer.diagnosticMetaPrefix': {
    en: 'Failure stage: {stage} · Error code: ',
    'zh-CN': '故障阶段：{stage} · 错误码：',
  },
  'plugins.drawer.inUseTitle': {
    en: 'Plugin resource confirmation (plugin_in_use)',
    'zh-CN': '插件资源占用确认（plugin_in_use）',
  },
  'plugins.drawer.inUseHint': {
    en: 'The related resources below go offline after disabling; configuration is kept and restored on next enable:',
    'zh-CN': '停用后以下关联资源将暂时失效，配置保留待下次启用恢复：',
  },
  'plugins.drawer.forceDisable': { en: 'Force disable', 'zh-CN': '强制停用' },
  'plugins.drawer.capabilities': { en: 'Capabilities', 'zh-CN': '能力清单' },
  'plugins.drawer.noTools': { en: 'No declared tools', 'zh-CN': '无声明工具' },
  'plugins.drawer.noActions': { en: 'No declared actions', 'zh-CN': '无声明动作' },
  'plugins.drawer.noHooks': { en: 'No hooks', 'zh-CN': '无拦截钩子' },
  'plugins.drawer.configuration': { en: 'Configuration', 'zh-CN': '配置项' },
  'plugins.drawer.loadingConfig': {
    en: 'Loading configuration...',
    'zh-CN': '正在读取配置...',
  },
  'plugins.drawer.configUnavailable': {
    en: 'Configuration load failed or not declared.',
    'zh-CN': '配置读取失败或未声明。',
  },
  'plugins.drawer.settingsPanelsCount': {
    en: 'Extension settings panels ({count})',
    'zh-CN': '扩展设置面板（{count}）',
  },
  'plugins.drawer.settingsPanels': {
    en: 'Extension settings panels',
    'zh-CN': '扩展设置面板',
  },
  'plugins.drawer.settingsPanelLabel': {
    en: 'Settings panel {id}',
    'zh-CN': '设置面板 {id}',
  },

  // PluginConfigForm
  'plugins.config.empty': {
    en: 'This plugin declares no configuration options.',
    'zh-CN': '该插件未声明配置项。',
  },
  'plugins.config.configuredTitle': {
    en: 'Explicitly configured by user',
    'zh-CN': '用户已显式配置',
  },
  'plugins.config.configured': { en: 'Configured', 'zh-CN': '已配置' },
  'plugins.config.defaultTitle': { en: 'Using default value', 'zh-CN': '当前使用默认值' },
  'plugins.config.switchOn': { en: 'On', 'zh-CN': '开启' },
  'plugins.config.switchOff': { en: 'Off', 'zh-CN': '关闭' },
  'plugins.config.secretConfiguredPlaceholder': {
    en: 'Configured (leave empty to keep unchanged)',
    'zh-CN': '已配置（留空保持不变）',
  },
  'plugins.config.secretUnconfiguredPlaceholder': {
    en: 'Not configured',
    'zh-CN': '未配置',
  },
  'plugins.config.clearSecretTitle': { en: 'Clear saved secret', 'zh-CN': '清除已保存密钥' },
  'plugins.config.resetDefaultTitle': { en: 'Reset to default', 'zh-CN': '重置为默认值' },
  'plugins.config.clear': { en: 'Clear', 'zh-CN': '清除' },
  'plugins.config.reset': { en: 'Reset', 'zh-CN': '重置' },
  'plugins.config.modelUnset': { en: 'No model selected', 'zh-CN': '未选择模型' },
  'plugins.config.save': { en: 'Save configuration', 'zh-CN': '保存配置' },
  'plugins.config.savedNoticeTitle': { en: 'Plugin configuration saved', 'zh-CN': '插件配置已保存' },
  'plugins.config.savedNoticeBody': { en: '{name} configuration updated', 'zh-CN': '{name} 配置已更新' },
  'plugins.config.resetNoticeTitle': { en: 'Configuration field reset', 'zh-CN': '配置项已重置' },
  'plugins.config.resetNoticeBody': { en: '{field} restored to default', 'zh-CN': '{field} 已恢复默认值' },
  'plugins.config.clearedNoticeTitle': { en: 'Secret cleared', 'zh-CN': '密钥已清除' },
  'plugins.config.clearedNoticeBody': { en: '{field} cleared', 'zh-CN': '{field} 已清除' },
  'plugins.config.unsetOption': { en: 'Not set', 'zh-CN': '未设置' },
  'plugins.config.nodeOffline': { en: '{node} (offline)', 'zh-CN': '{node}（离线）' },
  'plugins.config.referenceNotFound': { en: '{value} (not found)', 'zh-CN': '{value}（不存在）' },

  // Center top-level tabs and core capabilities tab
  'plugins.center.viewsAria': { en: 'Plugin center views', 'zh-CN': '插件中心视图' },
  'plugins.center.tabPlugins': { en: 'Plugins', 'zh-CN': '扩展插件' },
  'plugins.center.tabCore': { en: 'Core', 'zh-CN': '内核能力' },
  'plugins.center.refreshCoreTitle': {
    en: 'Refresh core capabilities and skills',
    'zh-CN': '刷新内核能力与技能目录',
  },
  'plugins.drawer.managedSkillsTitle': {
    en: 'Managed skills ({count})',
    'zh-CN': '受管技能（{count}）',
  },
  'plugins.drawer.openSkillTitle': {
    en: 'Open {id} in Skills Center',
    'zh-CN': '在技能中心查看 {id}',
  },

  // Core capability cards, filters and read-only detail drawer
  'plugins.core.badge': { en: 'Core', 'zh-CN': '内核' },
  'plugins.core.readOnly': { en: 'Read-only', 'zh-CN': '只读' },
  'plugins.core.alwaysActive': { en: 'Always active', 'zh-CN': '常驻运行' },
  'plugins.core.searchPlaceholder': {
    en: 'Search core domain, owner ID, action or managed skill…',
    'zh-CN': '搜索内核域、Owner ID、Action 或受管技能…',
  },
  'plugins.core.searchAria': { en: 'Search core capabilities', 'zh-CN': '搜索内核能力' },
  'plugins.core.clearSearch': { en: 'Clear core search', 'zh-CN': '清空内核能力搜索' },
  'plugins.core.filterAria': { en: 'Filter core capabilities', 'zh-CN': '筛选内核能力' },
  'plugins.core.tabActions': { en: 'Actions', 'zh-CN': '动作能力' },
  'plugins.core.tabSkills': { en: 'Managed skills', 'zh-CN': '受管技能' },
  'plugins.core.emptyTitle': { en: 'No matching core capabilities', 'zh-CN': '未找到匹配的内核能力' },
  'plugins.core.emptyHint': {
    en: 'Try adjusting the search keywords or switching filters.',
    'zh-CN': '请尝试调整搜索关键字或切换筛选条件。',
  },
  'plugins.core.actionsPill': { en: '{count} Actions', 'zh-CN': '{count} Actions' },
  'plugins.core.skillsPill': { en: '{count} Skills', 'zh-CN': '{count} Skills' },
  'plugins.core.actionsTitle': { en: '{count} core actions', 'zh-CN': '{count} 个内核动作' },
  'plugins.core.skillsTitle': { en: '{count} managed skills', 'zh-CN': '{count} 个受管技能' },
  'plugins.core.owner.conversations.name': { en: 'Conversations', 'zh-CN': '会话管理' },
  'plugins.core.owner.conversations.desc': {
    en: 'Kernel conversation lifecycle, FTS5 search, messaging, compaction and history operations.',
    'zh-CN': '内核会话生命周期、FTS5 全文检索、消息投递、压缩与历史记录能力。',
  },
  'plugins.core.owner.profiles.name': { en: 'Profiles', 'zh-CN': '角色配置' },
  'plugins.core.owner.profiles.desc': {
    en: 'Agent profile definitions, model bindings, starters and alignment.',
    'zh-CN': '智能体角色定义、模型绑定、引导词与配置对齐能力。',
  },
  'plugins.core.owner.models.name': { en: 'Models & Providers', 'zh-CN': '模型与网关' },
  'plugins.core.owner.models.desc': {
    en: 'Model catalog inspection, global defaults and sanitized provider summaries.',
    'zh-CN': '模型目录检索、全局默认配置与脱敏供应商摘要能力。',
  },
  'plugins.core.owner.nodes.name': { en: 'Compute Nodes', 'zh-CN': '计算节点' },
  'plugins.core.owner.nodes.desc': {
    en: 'Compute node registry inspection, status checks and drain controls.',
    'zh-CN': '计算节点注册表查询、状态检查与排空控制能力。',
  },
  'plugins.core.owner.plugins.name': { en: 'Plugins & Apps', 'zh-CN': '插件与微应用' },
  'plugins.core.owner.plugins.desc': {
    en: 'Plugin lifecycle inspection, sanitized config access, doctor checks and app-builder guidance.',
    'zh-CN': '插件生命周期查询、脱敏配置读取、体检与微应用开发指引。',
  },
  'plugins.core.owner.asks.name': { en: 'AskDock', 'zh-CN': '交互审批' },
  'plugins.core.owner.asks.desc': {
    en: 'CAS-guarded approval resolution and pending ask inspection.',
    'zh-CN': '基于 CAS 乐观锁的交互审批响应与待处理请求查询。',
  },
  'plugins.core.owner.skills.name': { en: 'Skills Catalog', 'zh-CN': '技能目录' },
  'plugins.core.owner.skills.desc': {
    en: 'Hub skill catalog listing and skill document inspection.',
    'zh-CN': 'Hub 技能目录列表与技能文档只读检索能力。',
  },
  'plugins.core.owner.host.name': { en: 'Host & CLI', 'zh-CN': '宿主与命令行' },
  'plugins.core.owner.host.desc': {
    en: 'Host-level operational contracts, CLI usage manuals and core host skills.',
    'zh-CN': '宿主级运行契约、命令行操作规范与核心宿主受管技能。',
  },
  'plugins.core.owner.fallbackDesc': {
    en: 'Kernel-owned core capability namespace ({parts}).',
    'zh-CN': '内核原生能力域（{parts}）。',
  },
  'plugins.core.owner.fallbackEmptyDesc': {
    en: 'Kernel-owned core capability namespace.',
    'zh-CN': '内核原生能力域。',
  },
  'plugins.core.drawerTitleFallback': { en: 'Core capability details', 'zh-CN': '内核能力详情' },
  'plugins.core.drawerAriaSelected': {
    en: '{name} core capability details',
    'zh-CN': '{name} 内核能力详情',
  },
  'plugins.core.noSelection': { en: 'No core capability selected', 'zh-CN': '未选择内核能力' },
  'plugins.core.readOnlyHint': {
    en: 'Kernel-owned capability namespace; always active and read-only.',
    'zh-CN': '由内核直接提供，常驻启用且只读，不可停用或卸载。',
  },
  'plugins.core.actionsSection': { en: 'Actions ({count})', 'zh-CN': '动作清单（{count}）' },
  'plugins.core.skillsSection': { en: 'Managed skills ({count})', 'zh-CN': '受管技能（{count}）' },
  'plugins.core.noManagedSkills': {
    en: 'No managed skills under this owner.',
    'zh-CN': '该内核域下暂无受管技能。',
  },
  'plugins.core.openSkill': { en: 'Open in Skills Center', 'zh-CN': '在技能中心查看' },
  'plugins.core.actionNotFound': {
    en: 'Action {action} was not found in this core namespace.',
    'zh-CN': '未在该内核域下找到动作 {action}。',
  },
  'plugins.core.actionDetailTitle': { en: 'Action contract: {id}', 'zh-CN': '动作契约：{id}' },
  'plugins.core.copyActionId': { en: 'Copy', 'zh-CN': '复制' },
  'plugins.core.closeActionDetail': { en: 'Collapse', 'zh-CN': '收起' },
  'plugins.core.idempotent': { en: 'Idempotent', 'zh-CN': '幂等只读' },
  'plugins.core.nonIdempotent': { en: 'Mutating', 'zh-CN': '状态变更' },
  'plugins.core.cliHidden': {
    en: 'CLI contract (not dynamically mounted)',
    'zh-CN': 'CLI 契约（非动态挂载）',
  },
  'plugins.core.field.actionId': { en: 'Action ID', 'zh-CN': '动作 ID' },
  'plugins.core.field.cliCommand': { en: 'CLI command', 'zh-CN': 'CLI 命令' },
  'plugins.core.field.visibility': { en: 'Visibility', 'zh-CN': '可见性' },
  'plugins.core.field.idempotency': { en: 'Idempotency', 'zh-CN': '幂等性' },
  'plugins.core.field.promptExposure': { en: 'Prompt catalog', 'zh-CN': '提示词目录' },
  'plugins.core.field.toolExposure': { en: 'Agent tool', 'zh-CN': 'Agent 工具' },
  'plugins.core.exposed': { en: 'Exposed', 'zh-CN': '已暴露' },
  'plugins.core.onDemandOnly': {
    en: 'On-demand (run_action)',
    'zh-CN': '按需发现（run_action）',
  },
  'plugins.core.notExposed': { en: 'Not exposed', 'zh-CN': '未暴露' },
  'plugins.core.inputSchema': { en: 'Input schema', 'zh-CN': '输入 Schema' },
  'plugins.core.outputSchema': { en: 'Output schema', 'zh-CN': '输出 Schema' },
} satisfies MessageTable
