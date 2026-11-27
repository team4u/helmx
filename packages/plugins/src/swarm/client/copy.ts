/**
 * Display copy for the builtin:swarm client (pure copy table + builders, zero Emoji, Fast Refresh compliant).
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'
import type { BoardPostKind, BoardViewDoc, MemberLiveState } from './board-model.ts'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })
const T = (locale: HelmxLocale, en: string, zh: string): string => resolveLocalizedText({ en, 'zh-CN': zh }, locale)

export const POST_KIND_LABELS: Readonly<Record<BoardPostKind, LocalizedText>> = {
  brief: L('Assignment', '派工'),
  handoff: L('Handoff', '交接'),
  review: L('Review', '审阅'),
  comment: L('Note', '留言'),
  blocker: L('Blocked', '受阻'),
  done: L('Delivered', '已交付'),
  stall: L('Stalled', '停滞'),
}
export const postKindLabel = (kind: BoardPostKind, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  resolveLocalizedText(POST_KIND_LABELS[kind], locale)

export const MEMBER_LIVE_STATE_LABELS: Readonly<Record<MemberLiveState, LocalizedText>> = {
  idle: L('Idle', '空闲'),
  working: L('Working', '执行中'),
  blocked: L('Blocked', '受阻'),
  done: L('Done', '已完成'),
  error: L('Error', '错误'),
  missing: L('Missing', '会话缺失'),
}
export const memberLiveStateLabel = (state: MemberLiveState, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  resolveLocalizedText(MEMBER_LIVE_STATE_LABELS[state], locale)

export const PANEL_STATUS_LABELS = {
  running: L('In progress', '进行中'),
  attention: L('Needs attention', '需要关注'),
  completed: L('Completed', '已完成'),
} as const
export type PanelStatusKey = keyof typeof PANEL_STATUS_LABELS
export const panelStatusLabel = (status: PanelStatusKey, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  resolveLocalizedText(PANEL_STATUS_LABELS[status], locale)

export const MEMBER_ACCESS_LABELS = {
  readwrite: L('Read-write', '可写'),
  readonly: L('Read-only review', '只读审阅'),
} as const
export const memberAccessLabel = (access: 'readwrite' | 'readonly', locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  resolveLocalizedText(MEMBER_ACCESS_LABELS[access], locale)

// Tool trace rows
export const TRACE_CREATE_GROUP = L('Start swarm group', '创建协同编组')
export const TRACE_UPDATE_GROUP = L('Update swarm group', '更新协同编组')
export const TRACE_DISPATCH = L('Dispatch member', '派工成员')
export const TRACE_BOARD_POST = L('Board post', '黑板发布')
export const TRACE_BOARD_READ = L('Read board', '读取协同记录')
export const TRACE_BOARD_STATUS = L('Check status', '查看协同态势')
export const TRACE_ABORT = L('Abort member', '中止成员')
export const TRACE_SWITCH_MODEL = L('Switch member model', '切换成员模型')
export const TRACE_INSPECT = L('Inspect member', '检视成员')
export const TRACE_ARCHIVE = L('Archive member', '归档成员')
export const TRACE_CLOSE_GROUP = L('Close swarm group', '结单协同编组')
export const TRACE_UNKNOWN_TOOL = L('Swarm tool', '协同工具')

export const traceOpenMemberLabel = (name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`)
export const traceOpenWorkbenchLabel = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, 'Open swarm workbench panel', '打开协同工作台面板')
export const traceStatusDone = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(locale, 'Done', '完成')
export const traceStatusRunning = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(locale, 'Running', '执行中')
export const traceStatusError = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(locale, 'Failed', '失败')
export const traceRetainedCount = (n: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${n} branch${n === 1 ? '' : 'es'} kept for merge`, `保留 ${n} 个分支待合入`)
export const tracePostCount = (n: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${n} post${n === 1 ? '' : 's'}`, `${n} 条记录`)
export const traceAbortedNoop = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(locale, 'not running', '未在运行')

// Composer activity tray
export const TRAY_REGION_ARIA = L('Swarm collaboration in flight', '协同任务进行中')
export const TRAY_COLLAPSE = L('Collapse', '收起')
export const TRAY_EXPAND = L('Expand', '展开')
export const TRAY_WORKBENCH = L('Workbench', '工作台')
export const ACTION_ABORT = L('Abort', '中止')
export const TRAY_AWAITING_APPROVAL = L('Awaiting approval', '待审批')
export const TRAY_AWAITING_HUMAN = L('Waiting for confirmation', '等待确认')
export const TRAY_OUTPUT_TAG = L('Output', '输出')
export const TRAY_THINKING_TAG = L('Thinking', '思考')
export const TRAY_LOAD_FAILED_TAG = L('Load failed', '加载失败')

export const trayParallelToolsTag = (n: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${n} tools running`, `并行 ${n} 个工具`)
export const trayCount = (blocked: number, working: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  blocked > 0
    ? working > 0
      ? T(locale, `${blocked} blocked · ${working} working`, `${blocked} 项受阻 · ${working} 项执行中`)
      : T(locale, `${blocked} blocked`, `${blocked} 项受阻`)
    : T(locale, `${working} working`, `${working} 项执行中`)
export const trayToggleLabel = (expanded: boolean, countText: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${expanded ? 'Collapse' : 'Expand'} swarm activity — ${countText}`, `${expanded ? '收起' : '展开'}协同任务 — ${countText}`)
export const trayRowOpenLabel = traceOpenMemberLabel
export const trayAbortFailed = (err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Abort failed: ${err}`, `中止失败：${err}`)
export const trayProgress = (done: number, total: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${done}/${total} delivered`, `已交付 ${done}/${total}`)
export function trayFrontline(
  frontline: { from: string; to: string; kind: BoardPostKind | string; digest: string },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const kindText = frontline.kind in POST_KIND_LABELS ? postKindLabel(frontline.kind as BoardPostKind, locale) : frontline.kind
  return `${frontline.from}${frontline.to ? ` -> ${frontline.to}` : ''} ${kindText}: ${frontline.digest}`
}

// Workbench orchestration panel
export const PANEL_EMPTY_TITLE = L('No swarm group in this conversation', '当前会话没有协同编组')
export const PANEL_EMPTY_HINT = L(
  'Send /skill:swarm <task> in a top-level conversation to start one.',
  '在顶层对话发送 /skill:swarm <任务> 即可发起协同。',
)
export const PANEL_OBJECTIVE = L('Objective', '协同目标')
export const PANEL_MEMBERS_TITLE = L('Members', '成员')
export const PANEL_ACTIVITY_TITLE = L('Recent activity', '最近动态')
export const PANEL_RETAINED_TITLE = L('Branches kept for merge', '保留待合入分支')
export const PANEL_LOADING = L('Loading swarm group…', '读取协同编组…')
export const PANEL_FALLBACK_NOTE = L('Loaded via one-time status snapshot', '经一次性状态快照加载')
export const PANEL_RETRY = L('Retry', '重试')
export const PANEL_REFRESH = L('Refresh', '刷新')
export const PANEL_HISTORY_TOGGLE = L('Show full record', '查看完整记录')
export const PANEL_HISTORY_COLLAPSE = L('Show less', '收起记录')
export const PANEL_LOAD_EARLIER = L('Load earlier records', '加载更早记录')
export const PANEL_LOADING_EARLIER = L('Loading earlier…', '正在加载更早记录…')
export const SW_BODY_EXPAND = L('Expand full text', '展开全文')
export const SW_BODY_COLLAPSE = L('Collapse', '收起长文')
export const PANEL_MEMBERS_EMPTY = L('No members dispatched yet.', '尚未派工成员。')
export const PANEL_POSTS_EMPTY = L('No board posts yet.', '暂无协同记录。')
export const PANEL_MEMBER_ARCHIVED = L('Archived', '已归档')
export const PANEL_CLOSE_GROUP = L('Close group', '结单')
export const PANEL_CLOSE_DIALOG_TITLE = L('Close swarm group', '结单协同编组')
export const PANEL_CLOSE_DIALOG_DESC = L('Archive active members and end this collaboration group.', '归档活跃成员并结束当前协同编组。')
export const PANEL_CLOSE_KEEP_WORKTREE = L('Keep modified worktree branches for merge', '保留有改动的工作树分支待合入')
export const PANEL_CLOSE_ABORT_RUNNING = L('Abort running members before closing', '结单前中止仍在运行的成员')
export const PANEL_CLOSE_CONFIRM = L('Confirm close', '确认结单')
export const PANEL_CANCEL = L('Cancel', '取消')
export const PANEL_STATUS_LOAD_FAILED = L('Failed to load swarm group status', '协同编组状态读取失败')
export const PANEL_ACTIVITY_RECEIVED = L('received', '收到')
export const PANEL_ACTIVITY_AUTHORED = L('latest', '最新')
export const PEEK_LOCATE = L('Locate in list', '定位到列表')
export const PEEK_CLOSE = L('Close preview', '关闭预览')
export const PEEK_LOAD_FAILED = L('Failed to load referenced post', '引用记录读取失败')
export const JUMP_BACK_DISMISS = L('Clear jump history', '清除回跳记录')

export const panelCloseFailed = (err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Close group failed: ${err}`, `结单失败：${err}`)
export const panelCloseUncleanedNotice = (count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(
    locale,
    `Swarm group closed (holds released). ${count} clean worktree${count === 1 ? '' : 's'} could not be removed automatically because the node does not support process occupancy scanning; run helmx worktrees cleanup --allow-unverified-usage when confirmed idle.`,
    `编组已结单并释放持有锁。有 ${count} 个干净工作树因目标节点不支持进程占用扫描而未自动删除；确认无占用后可通过 helmx worktrees cleanup --allow-unverified-usage 清理。`,
  )
export const panelRefJumpLabel = (seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Preview referenced post #${seq}`, `预览引用记录 #${seq}`)
export const peekRegionAria = (seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Referenced post #${seq}`, `引用记录 #${seq}`)
export const peekBackLabel = (seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Back to #${seq}`, `返回 #${seq}`)
export const peekLoadingLabel = (seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Loading post #${seq}…`, `正在读取记录 #${seq}…`)
export const peekNotFoundLabel = (seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `Post #${seq} was not found in this group.`, `该编组中未找到记录 #${seq}。`)
export const jumpBackLabel = peekBackLabel
export const panelStatusInvalid = (locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, 'Swarm status payload is structurally invalid', '协同状态返回结构无效')
export const panelRowOpenLabel = traceOpenMemberLabel

export function resolvePanelHeadlineText(view: BoardViewDoc, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  const { group, headline, activeWorkingMembers, members } = view
  if (group.status === 'closed') {
    const n = group.retainedWorktrees?.length ?? 0
    if (n > 0 && headline.kind === 'unmerged') {
      return T(locale, `Group closed with ${n} retained worktree branch${n === 1 ? '' : 'es'} awaiting merge`, `编组已结单，保留 ${n} 个待合入工作树分支`)
    }
    if (group.closeSummary?.trim()) return group.closeSummary
    return headline.kind === 'closed' ? T(locale, 'Swarm group closed', '协同编组已结单') : headline.text
  }
  if (headline.refSeq !== undefined) return headline.text
  if (headline.kind === 'blocker' && headline.targetMember !== undefined) {
    return T(locale, `Member @${headline.targetMember} stopped in error state`, `成员 @${headline.targetMember} 因错误停止`)
  }
  if (headline.kind === 'normal') {
    if (activeWorkingMembers.length > 0) {
      const list = activeWorkingMembers.map((m) => `@${m}`).join(', ')
      return T(locale, `Active: ${list}`, `执行中：${list}`)
    }
    const activeCount = members.filter((m) => m.lifecycle === 'active').length
    return activeCount === 0
      ? T(locale, 'Group ready — dispatch peer roles to start collaboration', '编组已就绪 — 请派工对等成员开始协同')
      : T(locale, `${activeCount} active member${activeCount === 1 ? '' : 's'} idle`, `${activeCount} 名活跃成员空闲待命`)
  }
  return headline.text
}

export function panelWorktreeSummary(
  snap: { branch?: string; commitsAhead?: number; dirtyCount: number; additions?: number; deletions?: number },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const parts: string[] = []
  if (snap.branch) parts.push(snap.branch)
  if (snap.commitsAhead !== undefined) parts.push(T(locale, `+${snap.commitsAhead} commits`, `领先 ${snap.commitsAhead} 提交`))
  parts.push(T(locale, `${snap.dirtyCount} uncommitted`, `未提交 ${snap.dirtyCount}`))
  if (snap.additions !== undefined && snap.deletions !== undefined) {
    parts.push(`+${snap.additions} −${snap.deletions}`)
  }
  return parts.join(' · ')
}

export const panelRetainedSummary = (
  item: { memberName: string; branch: string; commitsAhead: number },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string => T(locale, `@${item.memberName} · ${item.branch} · +${item.commitsAhead} commits`, `@${item.memberName} · ${item.branch} · 领先 ${item.commitsAhead} 提交`)

export const panelPostTargets = (post: { to: string[] }): string =>
  post.to.map((x) => (x === 'all' ? x : `@${x}`)).join(', ')

// Timeline receipt cards
export const SW_BOARD_MESSAGE_TITLE = L('Board message', '看板消息')
export const SW_BOARD_IDLE_TITLE = L('All members idle', '全员空闲')
export const SW_BOARD_WAKEUP_TITLE = L('Swarm wakeup', '协同唤醒')
export const SW_WAKE_OVERRIDE_SILENT = L('No wake', '未唤醒')
export const SW_WAKE_OVERRIDE_WOKE = L('Woke', '已唤醒')
export const SW_RECEIPT_BODY_TRUNCATED = L('Message truncated — open workbench for full text', '正文已截断，可打开工作台查看全文')
export const SW_RECEIPT_EMPTY = L('No board post details recorded.', '未包含消息正文详情。')
export const SW_PILL_OPEN_WORKBENCH = L('Open swarm workbench', '打开协同工作台')
export const swReceiptCountCompact = (n: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${n} posts`, `${n} 条`)
export const swReceiptToggleLabel = (title: string, open: boolean, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(locale, `${open ? 'Collapse' : 'Expand'} ${title}`, `${open ? '收起' : '展开'} ${title}`)
export const swReceiptActiveWorkers = (members: readonly string[], locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string => {
  const list = members.map((m) => `@${m}`).join(', ')
  return T(locale, `Still working: ${list}`, `仍在执行：${list}`)
}
export const swReceiptTruncatedPosts = (count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string =>
  T(
    locale,
    `${count} earlier post${count === 1 ? '' : 's'} omitted — open workbench for full history`,
    `已省略更早的 ${count} 条消息，可打开工作台查看完整记录`,
  )

// Timing labels & tooltip breakdowns
export const timingWaitingLabel = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Awaiting approval ${d}`, `等待审批 ${d}`)
export const timingWaitingWithTotalLabel = (w: string, total: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Awaiting approval ${w} · total ${total}`, `等待审批 ${w} · 累计 ${total}`)
export const timingTurnWithTotalLabel = (turn: string, total: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Turn ${turn} · total ${total}`, `本轮 ${turn} · 累计 ${total}`)
export const timingTooltipEndToEnd = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `End-to-end: ${d}`, `端到端总耗时：${d}`)
export const timingTooltipMembersTotal = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Total member runtime: ${d}`, `全员累计运行：${d}`)
export const timingTooltipCreatedAt = (ts: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Created: ${ts}`, `创建时间：${ts}`)
export const timingTooltipClosedAt = (ts: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Closed: ${ts}`, `结单时间：${ts}`)
export const timingTooltipWaiting = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Awaiting approval: ${d}`, `等待审批：${d}`)
export const timingTooltipCurrentTurn = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Current turn: ${d}`, `本轮运行：${d}`)
export const timingTooltipCumulativeRun = (d: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Cumulative runtime: ${d}`, `累计运行：${d}`)
export const timingTooltipTurns = (n: number, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Completed turns: ${n}`, `已完成轮次：${n}`)
export const timingTooltipJoinedAt = (ts: string, l: HelmxLocale = DEFAULT_HELMX_LOCALE): string => T(l, `Joined: ${ts}`, `加入时间：${ts}`)
