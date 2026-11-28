/**
 * Shell chrome display copy: App banners, auth gate, toasts, sidebar pieces,
 * archive ops, version watcher, and provider-body hook notices.
 * zh-CN copy is backfilled verbatim from the pre-anglicisation baseline
 * (the parents of b4a611a65); genuinely new strings follow the shared
 * terminology table (conversation/session, agent, profile, skill, plugin,
 * node, model, split, archive, restore, version, reconnect, syncing).
 */
import type { MessageTable } from '../messages.js'

export const shellMessages = {
  // App chrome: loading screen, connection banner, version banner, mobile nav
  'shell.loading.connecting': { en: 'Connecting to Helmx kernel...', 'zh-CN': '正在连接 Helmx 内核...' },
  'shell.connection.cannotConnect': { en: 'Cannot connect to Helmx right now', 'zh-CN': '暂时无法连接 Helmx' },
  'shell.connection.reconnect': { en: 'Reconnect', 'zh-CN': '重新连接' },
  'shell.connection.syncing': { en: 'Syncing conversations…', 'zh-CN': '正在同步会话…' },
  'shell.connection.autoRefresh': {
    en: 'The page refreshes automatically once the connection recovers.',
    'zh-CN': '连接恢复后会自动刷新。',
  },
  'shell.nav.toggleNav': { en: 'Toggle navigation bar', 'zh-CN': '切换导航栏' },
  'shell.nav.closeNav': { en: 'Close navigation bar', 'zh-CN': '关闭导航栏' },
  'shell.split.resizeAria': { en: 'Resize split panes', 'zh-CN': '调整分屏宽度' },
  'shell.split.resizeHint': {
    en: 'Drag to resize split panes (double-click to reset)',
    'zh-CN': '拖拽调整分屏比例（双击重置为 50/50）',
  },
  'shell.version.banner': { en: 'A new Helmx version is available', 'zh-CN': 'Helmx 已发布新版本' },
  'shell.version.bannerWithHint': {
    en: 'A new Helmx version is available — {hint}',
    'zh-CN': 'Helmx 已发布新版本，{hint}',
  },
  'shell.version.refreshNow': { en: 'Refresh now', 'zh-CN': '立即刷新' },
  'shell.version.deferDraft': {
    en: 'Unsubmitted input in progress; auto refresh deferred',
    'zh-CN': '当前有未提交的输入内容，已暂缓自动刷新',
  },
  'shell.version.deferBackgroundDraft': {
    en: 'Another conversation has an unsent draft; auto refresh deferred',
    'zh-CN': '其他会话有未发送的草稿，已暂缓自动刷新',
  },
  'shell.version.deferModal': {
    en: 'A window is open; auto refresh deferred',
    'zh-CN': '当前有打开的窗口，已暂缓自动刷新',
  },
  'shell.version.deferBoth': {
    en: 'Unsubmitted input and an open window; auto refresh deferred',
    'zh-CN': '当前有未提交的输入内容和打开的窗口，已暂缓自动刷新',
  },
  'shell.version.deferBackgroundBoth': {
    en: 'Another conversation has an unsent draft and a window is open; auto refresh deferred',
    'zh-CN': '其他会话有未发送的草稿且当前有打开的窗口，已暂缓自动刷新',
  },

  // Auth gate (first-start setup and unlock)
  'shell.auth.consoleTitle': { en: 'Helmx Console', 'zh-CN': 'Helmx 主控台' },
  'shell.auth.setupDesc': {
    en: 'First start: set the local Helmx master password (at least 8 characters) to protect conversations, model credentials and node connections.',
    'zh-CN': '首次启动：请设置本机 Helmx 主控密码（至少 8 位），用于保护会话、模型凭据与节点连接。',
  },
  'shell.auth.unlockDesc': {
    en: 'Enter the local Helmx master password to unlock the console.',
    'zh-CN': '请输入本机 Helmx 主控密码以解锁工作台。',
  },
  'shell.auth.passwordMin': {
    en: 'Master password needs at least 8 characters',
    'zh-CN': '主控密码至少需要 8 位字符',
  },
  'shell.auth.passwordMismatch': { en: 'The two passwords do not match', 'zh-CN': '两次输入的密码不一致' },
  'shell.auth.failed': { en: 'Authentication failed', 'zh-CN': '认证失败' },
  'shell.auth.setPasswordLabel': { en: 'Set master password', 'zh-CN': '设置主控密码' },
  'shell.auth.passwordLabel': { en: 'Master password', 'zh-CN': '主控密码' },
  'shell.auth.setPasswordPlaceholder': { en: 'At least 8 characters', 'zh-CN': '至少 8 位字符' },
  'shell.auth.passwordPlaceholder': { en: 'Enter master password', 'zh-CN': '输入主控密码' },
  'shell.auth.confirmLabel': { en: 'Confirm master password', 'zh-CN': '确认主控密码' },
  'shell.auth.confirmPlaceholder': { en: 'Re-enter the password', 'zh-CN': '再次输入密码' },
  'shell.auth.verifying': { en: 'Verifying...', 'zh-CN': '正在验证...' },
  'shell.auth.initialize': { en: 'Initialize and enter Helmx', 'zh-CN': '初始化并进入 Helmx' },
  'shell.auth.unlock': { en: 'Unlock console', 'zh-CN': '解锁主控台' },
  'shell.auth.themeSystem': {
    en: 'System theme (currently {current}; click to switch to light mode)',
    'zh-CN': '跟随系统（当前{current}，点击切换为浅色模式）',
  },
  'shell.auth.themeLight': {
    en: 'Light mode (click to switch to dark mode)',
    'zh-CN': '浅色模式（点击切换为暗色模式）',
  },
  'shell.auth.themeDark': {
    en: 'Dark mode (click to switch to system theme)',
    'zh-CN': '暗色模式（点击切换为跟随系统）',
  },
  'shell.theme.currentDark': { en: 'Dark', 'zh-CN': '暗色' },
  'shell.theme.currentLight': { en: 'Light', 'zh-CN': '浅色' },

  // Toast overlay
  'shell.toast.region': { en: 'Notifications', 'zh-CN': '通知' },
  'shell.toast.view': { en: 'View', 'zh-CN': '查看' },
  'shell.toast.dismiss': { en: 'Dismiss', 'zh-CN': '关闭' },

  // Shared sidebar row copy (agent standings + archived group)
  'shell.conversationFallback': { en: 'Conversation #{id}', 'zh-CN': '会话 #{id}' },
  'shell.batch.selected': { en: '{count} selected', 'zh-CN': '已选择 {count} 项' },
  'shell.batch.exit': { en: 'Exit', 'zh-CN': '退出' },
  'shell.batch.clear': { en: 'Clear', 'zh-CN': '清空' },
  'shell.batch.selectAll': { en: 'Select all', 'zh-CN': '全选' },
  // Shared batch-delete copy (agent standings + archived group batch bars)
  'shell.batch.deleting': { en: 'Deleting...', 'zh-CN': '删除中...' },
  'shell.batch.deleteCount': { en: 'Delete ({count})', 'zh-CN': '删除 ({count})' },
  'shell.batch.deleteConfirmTitle': {
    en: 'Delete {count} selected conversations?',
    'zh-CN': '确定删除选中的 {count} 个会话吗？',
  },
  'shell.batch.deleteConfirmDesc': { en: 'This action cannot be undone.', 'zh-CN': '此操作无法撤销。' },
  'shell.batch.deleteConfirmButton': { en: 'Delete conversation', 'zh-CN': '删除会话' },
  'shell.batch.bulkDeleteCompleted': { en: 'Bulk delete completed', 'zh-CN': '批量删除完成' },
  'shell.batch.bulkDeleteCompletedBody': {
    en: 'Deleted {count} conversations',
    'zh-CN': '成功删除 {count} 个会话',
  },
  'shell.batch.bulkDeleteFailed': { en: 'Bulk delete failed', 'zh-CN': '批量删除失败' },
  'shell.batch.bulkDeleteFailedBody': {
    en: 'Failed to delete {count} conversations',
    'zh-CN': '删除失败 {count} 个会话',
  },
  'shell.batch.bulkDeletePartial': { en: 'Bulk delete partially failed', 'zh-CN': '批量删除部分失败' },
  'shell.batch.bulkDeletePartialBody': {
    en: 'Deleted {fulfilled}, failed {rejected}',
    'zh-CN': '成功删除 {fulfilled} 个，失败 {rejected} 个',
  },
  'shell.batch.bulkDeleteError': { en: 'Bulk delete error', 'zh-CN': '批量删除异常' },

  // New topic & bulk management copy (shared by sidebar working set and overview)
  'shell.agents.newTopicUnder': { en: 'Start a new topic under {label}', 'zh-CN': '在 {label} 下开始新话题' },
  'shell.agents.newTopicUnderWithShortcut': {
    en: 'Start a new topic under {label} ({shortcut})',
    'zh-CN': '在 {label} 下开始新话题 ({shortcut})',
  },
  'shell.agents.collapseFilters': { en: 'Collapse filters', 'zh-CN': '收起筛选' },
  'shell.agents.exitBulk': { en: 'Exit bulk management', 'zh-CN': '退出批量管理' },
  'shell.agents.manageBulk': { en: 'Manage conversations in bulk', 'zh-CN': '批量管理会话' },
  'shell.agents.clearFilter': { en: 'Clear filter', 'zh-CN': '清空筛选' },
  'shell.agents.archiving': { en: 'Archiving...', 'zh-CN': '归档中...' },
  'shell.agents.archiveCount': { en: 'Archive ({count})', 'zh-CN': '归档 ({count})' },

  // Archived conversations copy (overview archived tab + bulk restore)
  'shell.archived.groupTitle': { en: 'Archived', 'zh-CN': '已归档' },
  'shell.archived.restoring': { en: 'Restoring...', 'zh-CN': '恢复中...' },
  'shell.archived.restoreCount': { en: 'Restore ({count})', 'zh-CN': '恢复 ({count})' },

  // Sidebar primitives: status dots, node tags, pane tags
  'shell.status.working': { en: 'Running', 'zh-CN': '运行中' },
  'shell.status.blocked': { en: 'Awaiting confirmation', 'zh-CN': '等待确认' },
  'shell.status.done': { en: 'Completed', 'zh-CN': '已完成' },
  'shell.status.idle': { en: 'Idle', 'zh-CN': '空闲' },
  'shell.status.error': { en: 'Error', 'zh-CN': '错误' },
  'shell.status.liveHealthy': { en: 'Live connection healthy', 'zh-CN': '实时连接正常' },
  'shell.status.liveLost': { en: 'Live connection lost, reconnecting', 'zh-CN': '实时连接断开，正在重连' },
  'shell.paneTag.main': { en: 'Main', 'zh-CN': '主' },
  'shell.paneTag.split': { en: 'Split', 'zh-CN': '分' },
  'shell.paneTag.both': { en: 'Main·Split', 'zh-CN': '主·分' },
  'shell.pane.main': { en: 'Open in main view', 'zh-CN': '主屏打开' },
  'shell.pane.split': { en: 'Open in split view', 'zh-CN': '分屏打开' },
  'shell.pane.both': { en: 'Open in both main and split views', 'zh-CN': '主屏与分屏均打开' },
  'shell.node.title': { en: 'Node: {id}', 'zh-CN': '运行节点：{id}' },

  // Conversation background activity summaries and status-light tooltips
  'shell.background.compacting': { en: 'Compacting context', 'zh-CN': '上下文精简中' },
  'shell.background.tooltipRunning': { en: '{base} · background task running', 'zh-CN': '{base} · 后台任务运行中' },
  'shell.background.tooltipWithSummary': {
    en: '{base} · background task: {summary}',
    'zh-CN': '{base} · 后台任务: {summary}',
  },

  // Global cross-agent attention (mobile hamburger status dot & conversations rail status dot)
  'shell.attention.openConversation': { en: 'Open conversation {id}', 'zh-CN': '打开会话 {id}' },
  'shell.attention.descendantsActive': {
    en: '{count} sub-conversations active',
    'zh-CN': '{count} 个子会话运行中',
  },
  'shell.attention.needsCount': { en: '{count} need attention', 'zh-CN': '{count} 项待处理' },
  'shell.attention.runningCount': { en: '{count} running', 'zh-CN': '{count} 项运行中' },
  'shell.attention.unreadCount': { en: '{count} unread completed', 'zh-CN': '{count} 个未读完成' },

  // Conversation overview (read-only host stage, #/overview)
  'shell.overview.title': { en: 'Conversation overview', 'zh-CN': '会话总览' },
  'shell.hubUpdate.ready': {
    en: 'Hub update staged: {current} -> {version}. Switching restarts the Hub.',
    'zh-CN': 'Hub 更新已就绪：{current} -> {version}，切换会重启 Hub。',
  },
  'shell.hubUpdate.apply': { en: 'Switch now', 'zh-CN': '立即切换' },
  'shell.hubUpdate.forceApply': { en: 'Switch anyway', 'zh-CN': '仍要切换' },
  'shell.hubUpdate.busy': { en: 'Hub is busy ({counts}); retry when idle', 'zh-CN': 'Hub 正在忙（{counts}），空闲后再切换' },
  'shell.hubUpdate.switching': { en: 'Switching to {version}; the page reconnects automatically', 'zh-CN': '正在切换到 {version}，页面会自动重连' },
  'shell.hubUpdate.switched': { en: 'Hub is now {version}; reload to load the new web assets', 'zh-CN': 'Hub 已切换到 {version}，刷新页面加载新前端' },
  'shell.hubUpdate.reload': { en: 'Reload', 'zh-CN': '刷新页面' },
  'shell.hubUpdate.switchTimeout': {
    en: 'Switch to {version} did not complete within the budget; check helmx status',
    'zh-CN': '切换到 {version} 未在时限内完成，请用 helmx status 检查',
  },
  'shell.hubChangelog.entry': { en: 'Version & updates', 'zh-CN': '版本与更新' },
  'shell.hubChangelog.title': { en: 'Changelog', 'zh-CN': '版本与更新' },
  'shell.hubChangelog.closeTitle': { en: 'Close changelog', 'zh-CN': '关闭变更日志' },
  'shell.hubChangelog.loading': { en: 'Loading changelog...', 'zh-CN': '正在加载变更日志...' },
  'shell.hubChangelog.absent': {
    en: 'This Hub did not ship a changelog (older payload or custom deployment).',
    'zh-CN': '此 Hub 未随附变更日志（更早的安装包或特殊部署）。',
  },
  'shell.hubChangelog.emptyRange': {
    en: 'No recorded changes in this range.',
    'zh-CN': '该范围内没有已记录的变更。',
  },
  'shell.hubChangelog.range': {
    en: '{from} -> now, {count} versions',
    'zh-CN': '{from} 以来 · {count} 个版本',
  },
  'shell.hubChangelog.rangeOlder': {
    en: 'since {from} (earlier than the earliest entry), {count} versions',
    'zh-CN': '自 {from}（更早版本无记录）· {count} 个版本',
  },
  'shell.hubChangelog.upgraded': {
    en: 'Hub updated from v{from} to v{version}',
    'zh-CN': 'Hub 已从 v{from} 更新到 v{version}',
  },
  'shell.hubChangelog.viewChanges': { en: "What's changed", 'zh-CN': '查看更新内容' },
  'shell.hubChangelog.dismiss': { en: 'Got it', 'zh-CN': '知道了' },
  'shell.overview.stats': { en: '{count} conversation groups', 'zh-CN': '{count} 个会话组' },
  'shell.overview.waitingForYou': { en: 'Waiting for you', 'zh-CN': '等待你处理' },
  'shell.overview.hasError': { en: 'Error', 'zh-CN': '发生错误' },
  'shell.overview.waited': { en: 'Waited {duration}', 'zh-CN': '已等待 {duration}' },
  'shell.overview.totalRun': { en: 'Total {duration}', 'zh-CN': '累计 {duration}' },
  'shell.overview.createdAt': { en: 'Created at {time}', 'zh-CN': '创建于 {time}' },
  'shell.overview.updatedAt': { en: 'Updated at {time}', 'zh-CN': '更新于 {time}' },
  'shell.overview.filterAll': { en: 'All', 'zh-CN': '全部' },
  'shell.overview.filterNeeds': { en: 'Needs attention', 'zh-CN': '需处理' },
  'shell.overview.filterRunning': { en: 'Running', 'zh-CN': '进行中' },
  'shell.overview.filterUnread': { en: 'Unread', 'zh-CN': '未读' },
  'shell.overview.filterArchived': { en: 'Archived', 'zh-CN': '已归档' },
  'shell.overview.profileFilter': { en: 'All agents', 'zh-CN': '全部角色' },
  'shell.overview.profileFilterLabel': { en: 'Filter by agent', 'zh-CN': '按角色筛选' },
  'shell.overview.nodeFilter': { en: 'All nodes', 'zh-CN': '全部节点' },
  'shell.overview.nodeFilterLabel': { en: 'Filter by node', 'zh-CN': '按节点筛选' },
  'shell.overview.sourceFilter': { en: 'All sources', 'zh-CN': '全部来源' },
  'shell.overview.sourceFilterLabel': { en: 'Filter by source', 'zh-CN': '按来源筛选' },
  'shell.overview.sourceHuman': { en: 'Conversations', 'zh-CN': '人类对话' },
  'shell.overview.sourceAutomated': { en: 'Automated', 'zh-CN': '自动化任务' },
  'shell.overview.automatedNeedsAttention': {
    en: '{count} automated task(s) need attention',
    'zh-CN': '有 {count} 个自动化任务需要处理',
  },
  'shell.overview.viewAutomatedAttention': { en: 'View', 'zh-CN': '查看' },
  'shell.overview.localNode': { en: 'Local', 'zh-CN': '本机' },
  'shell.overview.statsFiltered': {
    en: '{count} of {total} conversation groups',
    'zh-CN': '{count} / {total} 个会话组',
  },
  'shell.overview.statsArchived': { en: '{count} archived conversations', 'zh-CN': '{count} 个已归档会话' },
  'shell.overview.statsArchivedFiltered': {
    en: '{count} of {total} archived conversations',
    'zh-CN': '{count} / {total} 个已归档会话',
  },
  'shell.overview.emptySystem': {
    en: 'No conversations yet. Start one with New topic.',
    'zh-CN': '还没有会话，从「新话题」开始。',
  },
  'shell.overview.emptyArchived': {
    en: 'No archived conversations',
    'zh-CN': '暂无已归档会话',
  },
  'shell.overview.emptyFiltered': {
    en: 'No conversations match the current filters',
    'zh-CN': '当前筛选下没有会话',
  },
  'shell.overview.clearFilters': { en: 'Clear filters', 'zh-CN': '清除筛选' },
  'shell.overview.searchLabel': { en: 'Search overview by title or summary', 'zh-CN': '按标题或摘要搜索总览' },
  'shell.overview.searchPlaceholder': { en: 'Search', 'zh-CN': '搜索' },
  'shell.overview.clearSearch': { en: 'Clear search', 'zh-CN': '清除搜索' },
  'shell.overview.loading': { en: 'Loading conversations…', 'zh-CN': '正在加载会话…' },
  'shell.overview.quickNavGroup': { en: 'Quick navigation', 'zh-CN': '快捷导航' },
  'shell.overview.moreDescendants': { en: '+{count} more', 'zh-CN': '还有 {count} 个' },
  'shell.overview.collapseDescendants': { en: 'Show less', 'zh-CN': '收起' },
  'shell.overview.quietDescendantOne': { en: '1 sub-conversation', 'zh-CN': '1 个子会话' },
  'shell.overview.quietDescendants': { en: '{count} sub-conversations', 'zh-CN': '{count} 个子会话' },
  'shell.overview.groupByLabel': { en: 'Group by', 'zh-CN': '分组方式' },
  'shell.overview.groupByStatus': { en: 'By status', 'zh-CN': '按状态' },
  'shell.overview.groupByProfile': { en: 'By agent', 'zh-CN': '按角色' },
  'shell.overview.groupByNode': { en: 'By node', 'zh-CN': '按节点' },
  'shell.overview.sectionNeeds': { en: 'Needs attention', 'zh-CN': '需处理' },
  'shell.overview.sectionRunning': { en: 'Running', 'zh-CN': '进行中' },
  'shell.overview.sectionUnread': { en: 'Unread completed', 'zh-CN': '未读完成' },
  'shell.overview.sectionQuiet': { en: 'Idle', 'zh-CN': '空闲' },
  'shell.overview.batchToggleCard': {
    en: 'Toggle selection for this conversation tree',
    'zh-CN': '切换选择此会话树',
  },
  'shell.overview.railTooltip': {
    en: 'Conversation overview (full view)',
    'zh-CN': '全屏会话总览',
  },
  'shell.overview.drawerPeek': { en: 'Peek in drawer', 'zh-CN': '抽屉速览' },
  'shell.overview.batchProtected': {
    en: 'Managed or protected conversations are excluded from bulk management',
    'zh-CN': '托管或受保护会话不参与批量管理',
  },

  // Sidebar conversation working set & quick switcher
  'shell.sidebar.viewAllConversations': {
    en: 'View all {count} conversations',
    'zh-CN': '查看全部 {count} 个会话',
  },
  'shell.sidebar.viewArchivedConversations': {
    en: 'Archived conversations ({count})',
    'zh-CN': '已归档会话 ({count})',
  },
  'shell.sidebar.viewMatchesInOverview': {
    en: 'Open matches in overview',
    'zh-CN': '在会话总览中查看匹配',
  },
  'shell.sidebar.overviewFilter': {
    en: 'Filter conversations',
    'zh-CN': '筛选会话',
  },
  'shell.sidebar.overviewFilterPlaceholder': {
    en: 'Filter conversations, agents or nodes...',
    'zh-CN': '筛选会话、角色或节点...',
  },
  'shell.sidebar.overviewEmpty': {
    en: 'No conversations yet',
    'zh-CN': '暂无会话',
  },
  'shell.sidebar.overviewSubBadge': {
    en: '{count} sub-conversations',
    'zh-CN': '{count} 个子会话',
  },
  'shell.sidebar.overviewSubBadgeWithActivity': {
    en: '{active} active · {total} sub-conversations',
    'zh-CN': '{active} 个运行中 · 共 {total} 个子会话',
  },
  'shell.sidebar.overviewDirectSubBadge': {
    en: '{count} direct sub-conversations',
    'zh-CN': '{count} 个直属子会话',
  },
  'shell.sidebar.overviewSubtreeError': {
    en: '{count} descendant errors',
    'zh-CN': '{count} 个后代失败',
  },
  'shell.sidebar.overviewSubtreeWaiting': {
    en: '{count} descendants awaiting confirmation',
    'zh-CN': '{count} 个后代等待确认',
  },

  // Batch archive/restore notices (verb interpolated: Archive/Restore, 归档/恢复)
  'shell.archive.verbArchive': { en: 'Archive', 'zh-CN': '归档' },
  'shell.archive.verbRestore': { en: 'Restore', 'zh-CN': '恢复' },
  'shell.archive.completedTitle': { en: 'Bulk {verb} completed', 'zh-CN': '批量{verb}完成' },
  'shell.archive.completedBody': {
    en: '{verb} succeeded for {count} conversations',
    'zh-CN': '成功{verb} {count} 个会话',
  },
  'shell.archive.failedTitle': { en: 'Bulk {verb} failed', 'zh-CN': '批量{verb}失败' },
  'shell.archive.failedBody': {
    en: '{count} conversations failed to {verb}',
    'zh-CN': '{count} 个会话{verb}失败',
  },
  'shell.archive.partialTitle': { en: 'Bulk {verb} partially failed', 'zh-CN': '批量{verb}部分失败' },
  'shell.archive.partialBody': { en: '{fulfilled} succeeded, {rejected} failed', 'zh-CN': '成功 {fulfilled} 个，失败 {rejected} 个' },
  'shell.archive.errorSuffix': { en: ': {error}', 'zh-CN': '：{error}' },

  // Quiet browser notifications (root-tree completion / waiting drafts)
  'shell.quiet.completedTitle': { en: 'Helmx conversation completed', 'zh-CN': 'Helmx 会话已完成' },
  'shell.quiet.endedTitle': { en: 'Helmx conversation finished', 'zh-CN': 'Helmx 会话已结束' },
  'shell.quiet.waitingTitle': { en: 'Helmx is waiting for you', 'zh-CN': 'Helmx 等待你的处理' },
  'shell.quiet.finishedBody': { en: 'Conversation finished', 'zh-CN': '会话已结束' },
  'shell.quiet.finishedWithFailures': {
    en: 'Conversation finished · with failures',
    'zh-CN': '会话已结束 · 有失败',
  },
  'shell.quiet.hasFailures': { en: 'Has failures', 'zh-CN': '有失败' },
  'shell.quiet.totalPending': { en: '{count} pending in total', 'zh-CN': '等 {count} 个待处理' },
  'shell.quiet.pendingIntro': {
    en: 'Pending input/approvals: {list}',
    'zh-CN': '待处理输入/审批：{list}',
  },

  // Provider-body hook notices (English bridge until the Provider wires a locale)
  'shell.esc.confirmTitle': { en: 'Press Esc again to stop the current execution', 'zh-CN': '再按一次 Esc 停止当前执行' },
  'shell.esc.confirmBody': {
    en: 'Press Esc again within 1.5s to abort the current conversation run',
    'zh-CN': '1.5 秒内再次按 Esc 将中止当前会话运行',
  },
  'shell.esc.abortFailedTitle': { en: 'Failed to stop the current execution', 'zh-CN': '停止当前执行失败' },
  'shell.nav.targetNotReady': { en: 'Target not ready', 'zh-CN': '目标未就绪' },
  'shell.nav.invalidTarget': { en: 'Invalid navigation target', 'zh-CN': '导航目标无效' },
  'shell.nav.noOpenableEntry': { en: 'No openable entry yet', 'zh-CN': '暂无可打开的入口' },
  'shell.nav.noViewsBody': {
    en: 'No views available; enable a plugin providing views in the plugin center first',
    'zh-CN': '暂无可用视图，请先在插件中心启用提供视图的插件',
  },
  'shell.nav.noConversationsBody': {
    en: 'No conversations or profiles available yet; retry later',
    'zh-CN': '尚无可用会话或角色，请稍后重试',
  },
  'shell.nav.searchEntryGone': {
    en: 'Search entry no longer in conversation history',
    'zh-CN': '搜索条目已不在会话历史中',
  },
  'shell.unread.markFailed': { en: 'Failed to mark as read', 'zh-CN': '标记已读失败' },

  // Sidebar chrome, spaces, centers, language switcher, theme & quiet notify
  'shell.sidebar.sectionLabel': { en: 'Sidebar section {id}', 'zh-CN': '侧栏分组 {id}' },
  'shell.sidebar.itemLabel': { en: 'Sidebar item {id}', 'zh-CN': '侧栏项 {id}' },
  'shell.sidebar.collapseSection': { en: 'Collapse section', 'zh-CN': '收起分组' },
  'shell.sidebar.expandSection': { en: 'Expand section', 'zh-CN': '展开分组' },
  'shell.sidebar.viewsHeader': { en: 'Views', 'zh-CN': '视图' },
  'shell.sidebar.openInRightSplit': { en: 'Open in right split', 'zh-CN': '在右侧分屏打开' },
  'shell.sidebar.mainNavigation': { en: 'Main navigation', 'zh-CN': '主导航' },
  'shell.sidebar.expandNav': { en: 'Expand navigation bar', 'zh-CN': '展开导航栏' },
  'shell.sidebar.expandNavWithShortcut': {
    en: 'Expand navigation bar ({shortcut})',
    'zh-CN': '展开导航栏 ({shortcut})',
  },
  'shell.sidebar.collapseNav': { en: 'Collapse navigation bar', 'zh-CN': '收起导航栏' },
  'shell.sidebar.collapseNavWithShortcut': {
    en: 'Collapse navigation bar ({shortcut})',
    'zh-CN': '收起导航栏 ({shortcut})',
  },
  'shell.sidebar.spaceHeaderConversations': { en: 'Conversation', 'zh-CN': '会话' },
  'shell.sidebar.spaceHeaderSettings': { en: 'Settings', 'zh-CN': '设置' },
  'shell.sidebar.openCommandPalette': {
    en: 'Open global search and command palette ({shortcut})',
    'zh-CN': '打开全局搜索与命令面板 ({shortcut})',
  },
  'shell.space.conversations': { en: 'Conversations space', 'zh-CN': '对话空间' },
  'shell.space.views': { en: 'Views space', 'zh-CN': '视图空间' },
  'shell.space.settings': { en: 'Settings space', 'zh-CN': '设置空间' },
  'shell.center.profiles': { en: 'Profile', 'zh-CN': '角色' },
  'shell.center.models': { en: 'Models & credentials', 'zh-CN': '模型与凭据' },
  'shell.center.skills': { en: 'Skills', 'zh-CN': '技能' },
  'shell.center.nodes': { en: 'Compute nodes', 'zh-CN': '计算节点' },
  'shell.center.plugins': { en: 'Plugin Center', 'zh-CN': '插件中心' },
  'shell.theme.system': { en: 'System', 'zh-CN': '跟随系统' },
  'shell.theme.light': { en: 'Light mode', 'zh-CN': '浅色模式' },
  'shell.theme.dark': { en: 'Dark mode', 'zh-CN': '暗色模式' },
  'shell.locale.label': { en: 'Interface language', 'zh-CN': '界面语言' },
  'shell.locale.auto': { en: 'Auto', 'zh-CN': '自动' },
  'shell.quietNotify.toggleTooltip': {
    en: 'Background notifications: click to toggle',
    'zh-CN': '后台浏览器通知：点击切换开关',
  },
  'shell.quietNotify.off': {
    en: 'Background notifications: off (alert when a conversation completes or awaits input while the page is in the background)',
    'zh-CN': '后台浏览器通知：已关闭（页面在后台时，会话完成或需要输入将提醒）',
  },
  'shell.quietNotify.denied': {
    en: 'Background notifications: browser permission not granted; allow notifications in browser site settings and re-enable',
    'zh-CN': '后台浏览器通知：浏览器权限未授予，请在浏览器站点设置中允许通知后重新开启',
  },
  'shell.quietNotify.on': {
    en: 'Background notifications: on (alert when a conversation completes or awaits input while the page is in the background; this page must stay open)',
    'zh-CN': '后台浏览器通知：已开启（页面在后台时，会话完成或需要输入将提醒；需保持本页打开）',
  },

  // ScreenHost fallback and view wrapper
  'shell.screen.notFoundTitle': {
    en: 'View {pluginId}/{screenId} not found',
    'zh-CN': '未找到视图 {pluginId}/{screenId}',
  },
  'shell.screen.notFoundBody': {
    en: 'This view does not exist or its plugin is disabled ({pluginId}/{screenId}). Make sure the plugin is enabled in Settings.',
    'zh-CN': '该视图不存在或所属插件已停用（{pluginId}/{screenId}）。请在设置中确认对应插件已启用。',
  },
  'shell.screen.viewLabel': { en: 'View {id}', 'zh-CN': '视图 {id}' },

  // Store-level notices, asset failures & auth connection errors
  'shell.notify.unsupportedTitle': {
    en: 'Notifications unsupported in this browser',
    'zh-CN': '当前浏览器不支持通知',
  },
  'shell.notify.unsupportedBody': {
    en: 'The browser notification API is unavailable, so background notification alerts cannot be enabled.',
    'zh-CN': '浏览器通知 API 不可用，无法开启后台通知提醒。',
  },
  'shell.notify.permissionDeniedTitle': {
    en: 'Browser notification permission not granted',
    'zh-CN': '浏览器通知权限未授予',
  },
  'shell.notify.permissionDeniedBody': {
    en: 'Allow notifications in the browser site settings, then enable background notifications again.',
    'zh-CN': '请在浏览器站点设置中允许通知后重新开启。',
  },
  'shell.assets.profilesLoadFailed': { en: 'Profiles failed to load', 'zh-CN': '角色加载失败' },
  'shell.assets.modelsLoadFailed': { en: 'Models failed to load', 'zh-CN': '模型加载失败' },
  'shell.assets.providersLoadFailed': { en: 'Providers failed to load', 'zh-CN': '网关加载失败' },
  'shell.assets.credentialsLoadFailed': { en: 'Credentials failed to load', 'zh-CN': '凭据加载失败' },
  'shell.assets.skillsLoadFailed': { en: 'Skills failed to load', 'zh-CN': '技能加载失败' },
  'shell.assets.actionsLoadFailed': { en: 'Plugin actions failed to load', 'zh-CN': '插件动作加载失败' },
  'shell.assets.pluginConfigCatalogLoadFailed': {
    en: 'Plugin configuration catalog failed to load',
    'zh-CN': '插件配置目录加载失败',
  },
  'shell.assets.nodesLoadFailed': { en: 'Compute nodes failed to load', 'zh-CN': '计算节点加载失败' },
  'shell.assets.artifactsLoadFailed': { en: 'Conversation artifacts failed to load', 'zh-CN': '会话产物加载失败' },
  'shell.assets.pluginStateLoadFailed': { en: 'Plugin state failed to load', 'zh-CN': '插件状态读取失败' },
  'shell.assets.pluginStateLoadFailedBody': { en: '{pluginId}/{name}: {error}', 'zh-CN': '{pluginId}/{name}：{error}' },
  'shell.history.earlierStepsLoadedTitle': {
    en: 'Loaded earlier steps of current turn',
    'zh-CN': '已加载当前长回合的更早过程步骤',
  },
  'shell.history.earlierStepsLoadedBody': {
    en: 'Earlier tool and process steps for this turn were added above. Click Load earlier again to reach the previous turn.',
    'zh-CN': '已将本回合更早的工具与过程步骤加载到上方；再次点击“加载更早”可继续加载上一回合。',
  },
  'shell.nav.invalidScreenParamTitle': {
    en: 'Ignored invalid Screen parameter key',
    'zh-CN': '已忽略非法 Screen 参数键',
  },
  'shell.nav.invalidScreenParamBody': {
    en: 'Parameter {key} must use a valid key and a string value',
    'zh-CN': '参数 {key} 必须使用合法键和字符串值',
  },
  'shell.auth.kernelConnectFailed': {
    en: 'Cannot connect to the Helmx kernel: {error}',
    'zh-CN': '无法连接 Helmx 内核：{error}',
  },
} satisfies MessageTable
