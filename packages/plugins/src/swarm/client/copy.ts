/**
 * Display copy for the builtin:swarm client (pure copy table + builders, zero
 * component exports — Fast Refresh compliant, zero Emoji).
 *
 * Every human-visible string of the tool trace rows, the composer activity
 * tray, the workbench orchestration panel, and the timeline receipt pills
 * resolves here against the active host locale. Protocol vocabulary (#seq,
 * wake, raw channel names) stays available as auxiliary
 * facts, never as the primary control surface.
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'
import type { BoardPostKind, BoardViewDoc, MemberLiveState } from './board-model.ts'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

// ---------------------------------------------------------------------------
// Natural label maps (protocol vocabulary -> human verbs)
// ---------------------------------------------------------------------------

export const POST_KIND_LABELS: Readonly<Record<BoardPostKind, LocalizedText>> = {
  brief: L('Assignment', '派工'),
  handoff: L('Handoff', '交接'),
  review: L('Review', '审阅'),
  comment: L('Note', '留言'),
  blocker: L('Blocked', '受阻'),
  done: L('Delivered', '已交付'),
  stall: L('Stalled', '停滞'),
}

export function postKindLabel(kind: BoardPostKind, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(POST_KIND_LABELS[kind], locale)
}

export const MEMBER_LIVE_STATE_LABELS: Readonly<Record<MemberLiveState, LocalizedText>> = {
  idle: L('Idle', '空闲'),
  working: L('Working', '执行中'),
  blocked: L('Blocked', '受阻'),
  done: L('Done', '已完成'),
  error: L('Error', '错误'),
  missing: L('Missing', '会话缺失'),
}

export function memberLiveStateLabel(state: MemberLiveState, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(MEMBER_LIVE_STATE_LABELS[state], locale)
}

export const PANEL_STATUS_LABELS = {
  running: L('In progress', '进行中'),
  attention: L('Needs attention', '需要关注'),
  completed: L('Completed', '已完成'),
} as const

export type PanelStatusKey = keyof typeof PANEL_STATUS_LABELS

export function panelStatusLabel(status: PanelStatusKey, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(PANEL_STATUS_LABELS[status], locale)
}

export const MEMBER_ACCESS_LABELS = {
  readwrite: L('Read-write', '可写'),
  readonly: L('Read-only review', '只读审阅'),
} as const

export function memberAccessLabel(access: 'readwrite' | 'readonly', locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(MEMBER_ACCESS_LABELS[access], locale)
}

// ---------------------------------------------------------------------------
// Tool trace rows (26px timeline)
// ---------------------------------------------------------------------------

export const TRACE_CREATE_GROUP = L('Start swarm group', '创建协同编组')
export const TRACE_UPDATE_GROUP = L('Update swarm group', '更新协同编组')
export const TRACE_MANAGE_CHANNEL = L('Manage channel', '管理频道')
export const TRACE_DISPATCH = L('Dispatch member', '派工成员')
export const TRACE_BOARD_POST = L('Board post', '黑板发布')
export const TRACE_BOARD_READ = L('Read board', '读取协同记录')
export const TRACE_BOARD_STATUS = L('Check status', '查看协同态势')
export const TRACE_ABORT = L('Abort member', '中止成员')
export const TRACE_SWITCH_MODEL = L('Switch member model', '切换成员模型')
export const TRACE_INSPECT = L('Inspect member', '检视成员')
export const TRACE_ARCHIVE = L('Archive member', '归档成员')
export const TRACE_CLOSE_GROUP = L('Close swarm group', '结单协同编组')
export const CHANNEL_OP_LABELS: Readonly<Record<'create' | 'subscribe' | 'unsubscribe' | 'archive', LocalizedText>> = {
  create: L('Create', '创建'),
  subscribe: L('Subscribe', '订阅'),
  unsubscribe: L('Unsubscribe', '退订'),
  archive: L('Archive', '归档'),
}

export function channelOpLabel(op: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (op in CHANNEL_OP_LABELS) {
    return resolveLocalizedText(CHANNEL_OP_LABELS[op as keyof typeof CHANNEL_OP_LABELS], locale)
  }
  return op
}

export const TRACE_UNKNOWN_TOOL = L('Swarm tool', '协同工具')
export const TRACE_EXPAND_DETAILS = L('Show raw details', '查看原始详情')
export const TRACE_COLLAPSE_DETAILS = L('Hide raw details', '收起原始详情')
export function traceOpenMemberLabel(name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function traceOpenWorkbenchLabel(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Open swarm workbench panel', '打开协同工作台面板'), locale)
}

export function traceStatusDone(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Done', '完成'), locale)
}

export function traceStatusRunning(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Running', '执行中'), locale)
}

export function traceStatusError(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Failed', '失败'), locale)
}

export function traceRetainedCount(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`${count} branch${count === 1 ? '' : 'es'} kept for merge`, `保留 ${count} 个分支待合入`),
    locale,
  )
}

export function tracePostCount(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} post${count === 1 ? '' : 's'}`, `${count} 条记录`), locale)
}

export function traceAbortedNoop(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('not running', '未在运行'), locale)
}

// ---------------------------------------------------------------------------
// Composer activity tray (COMPOSER_DOCK_SLOT)
// ---------------------------------------------------------------------------

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

export function trayParallelToolsTag(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} tools running`, `并行 ${count} 个工具`), locale)
}

export function trayCount(blocked: number, working: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (blocked > 0) {
    return working > 0
      ? resolveLocalizedText(L(`${blocked} blocked · ${working} working`, `${blocked} 项受阻 · ${working} 项执行中`), locale)
      : resolveLocalizedText(L(`${blocked} blocked`, `${blocked} 项受阻`), locale)
  }
  return resolveLocalizedText(L(`${working} working`, `${working} 项执行中`), locale)
}

export function trayToggleLabel(
  expanded: boolean,
  countText: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(
    L(`${expanded ? 'Collapse' : 'Expand'} swarm activity — ${countText}`, `${expanded ? '收起' : '展开'}协同任务 — ${countText}`),
    locale,
  )
}

export function trayRowOpenLabel(name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function trayAbortFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Abort failed: ${err}`, `中止失败：${err}`), locale)
}

export function trayFrontline(
  frontline: { from: string; to: string; kind: BoardPostKind | string; digest: string },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const kindText =
    typeof frontline.kind === 'string' && frontline.kind in POST_KIND_LABELS
      ? postKindLabel(frontline.kind as BoardPostKind, locale)
      : frontline.kind
  const arrow = frontline.to !== '' ? ` -> ${frontline.to}` : ''
  return `${frontline.from}${arrow} ${kindText}: ${frontline.digest}`
}

export function trayProgress(done: number, total: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${done}/${total} delivered`, `已交付 ${done}/${total}`), locale)
}

// ---------------------------------------------------------------------------
// Workbench orchestration panel
// ---------------------------------------------------------------------------

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
export const SW_BODY_EXPAND: LocalizedText = { en: 'Expand full text', 'zh-CN': '展开全文' }
export const SW_BODY_COLLAPSE: LocalizedText = { en: 'Collapse', 'zh-CN': '收起长文' }
export const PANEL_MEMBERS_EMPTY = L('No members dispatched yet.', '尚未派工成员。')
export const PANEL_POSTS_EMPTY = L('No board posts yet.', '暂无协同记录。')
export const PANEL_POSTS_CHANNEL_EMPTY = L('No posts in this channel yet.', '该频道暂无协同记录。')
export const PANEL_MEMBER_ARCHIVED = L('Archived', '已归档')
export const PANEL_CLOSE_GROUP = L('Close group', '结单')
export const PANEL_CLOSE_DIALOG_TITLE = L('Close swarm group', '结单协同编组')
export const PANEL_CLOSE_DIALOG_DESC = L(
  'Archive active members and end this collaboration group.',
  '归档活跃成员并结束当前协同编组。',
)
export const PANEL_CLOSE_KEEP_WORKTREE = L(
  'Keep modified worktree branches for merge',
  '保留有改动的工作树分支待合入',
)
export const PANEL_CLOSE_ABORT_RUNNING = L(
  'Abort running members before closing',
  '结单前中止仍在运行的成员',
)
export const PANEL_CLOSE_CONFIRM = L('Confirm close', '确认结单')
export const PANEL_CANCEL = L('Cancel', '取消')
export const PANEL_CHANNEL_ALL = L('All', '全部')
export const PANEL_CHANNEL_FILTER_ARIA = L('Filter board posts by channel', '按频道筛选动态')

export function panelCloseFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Close group failed: ${err}`, `结单失败：${err}`), locale)
}

export function panelRefJumpLabel(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Preview referenced post #${seq}`, `预览引用记录 #${seq}`), locale)
}

export const PEEK_LOCATE = L('Locate in list', '定位到列表')
export const PEEK_CLOSE = L('Close preview', '关闭预览')
export const PEEK_LOAD_FAILED = L('Failed to load referenced post', '引用记录读取失败')
export const JUMP_BACK_DISMISS = L('Clear jump history', '清除回跳记录')

export function peekRegionAria(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Referenced post #${seq}`, `引用记录 #${seq}`), locale)
}

export function peekBackLabel(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Back to #${seq}`, `返回 #${seq}`), locale)
}

export function peekLoadingLabel(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Loading post #${seq}…`, `正在读取记录 #${seq}…`), locale)
}

export function peekNotFoundLabel(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`Post #${seq} was not found in this group.`, `该编组中未找到记录 #${seq}。`),
    locale,
  )
}

export function jumpBackLabel(seq: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Back to #${seq}`, `返回 #${seq}`), locale)
}

/**
 * Derive localized panel headline strictly from structured `BoardViewDoc` fields
 * (zero regex/string reverse-parsing of English templates), while preserving
 * real post excerpts (`refSeq !== undefined`) and user-authored `closeSummary` verbatim.
 */
export function resolvePanelHeadlineText(
  view: BoardViewDoc,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const { group, headline, activeWorkingMembers, members } = view
  if (group.status === 'closed') {
    const retainedCount = group.retainedWorktrees?.length ?? 0
    if (retainedCount > 0 && headline.kind === 'unmerged') {
      return resolveLocalizedText(
        L(
          `Group closed with ${retainedCount} retained worktree branch${retainedCount === 1 ? '' : 'es'} awaiting merge`,
          `编组已结单，保留 ${retainedCount} 个待合入工作树分支`,
        ),
        locale,
      )
    }
    if (group.closeSummary !== undefined && group.closeSummary.trim() !== '') {
      return group.closeSummary
    }
    if (headline.kind === 'closed') {
      return resolveLocalizedText(L('Swarm group closed', '协同编组已结单'), locale)
    }
    return headline.text
  }

  if (headline.refSeq !== undefined) {
    return headline.text
  }

  if (headline.kind === 'blocker' && headline.targetMember !== undefined) {
    return resolveLocalizedText(
      L(
        `Member @${headline.targetMember} stopped in error state`,
        `成员 @${headline.targetMember} 因错误停止`,
      ),
      locale,
    )
  }

  if (headline.kind === 'normal') {
    if (activeWorkingMembers.length > 0) {
      const list = activeWorkingMembers.map((m) => `@${m}`).join(', ')
      return resolveLocalizedText(L(`Active: ${list}`, `执行中：${list}`), locale)
    }
    const activeCount = members.filter((m) => m.lifecycle === 'active').length
    if (activeCount === 0) {
      return resolveLocalizedText(
        L(
          'Group ready — dispatch peer roles to start collaboration',
          '编组已就绪 — 请派工对等成员开始协同',
        ),
        locale,
      )
    }
    return resolveLocalizedText(
      L(
        `${activeCount} active member${activeCount === 1 ? '' : 's'} idle`,
        `${activeCount} 名活跃成员空闲待命`,
      ),
      locale,
    )
  }

  return headline.text
}
export const PANEL_STATUS_LOAD_FAILED = L('Failed to load swarm group status', '协同编组状态读取失败')
export function panelStatusInvalid(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Swarm status payload is structurally invalid', '协同状态返回结构无效'), locale)
}
export const PANEL_ACTIVITY_RECEIVED = L('received', '收到')
export const PANEL_ACTIVITY_AUTHORED = L('latest', '最新')

export function panelRowOpenLabel(name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Open @${name} conversation drawer`, `打开 @${name} 会话抽屉`), locale)
}

export function panelWorktreeSummary(
  snap: { branch?: string; commitsAhead?: number; dirtyCount: number },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const parts: string[] = []
  if (snap.branch !== undefined && snap.branch !== '') parts.push(snap.branch)
  if (snap.commitsAhead !== undefined) {
    parts.push(resolveLocalizedText(L(`+${snap.commitsAhead} commits`, `领先 ${snap.commitsAhead} 提交`), locale))
  }
  parts.push(resolveLocalizedText(L(`${snap.dirtyCount} uncommitted`, `未提交 ${snap.dirtyCount}`), locale))
  return parts.join(' · ')
}

export function panelRetainedSummary(
  item: { memberName: string; branch: string; commitsAhead: number },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(
    L(`@${item.memberName} · ${item.branch} · +${item.commitsAhead} commits`, `@${item.memberName} · ${item.branch} · 领先 ${item.commitsAhead} 提交`),
    locale,
  )
}

export function panelPostTargets(post: { to: string[] }): string {
  return post.to.map((t) => (t.startsWith('#') || t === 'all' ? t : `@${t}`)).join(', ')
}

// ---------------------------------------------------------------------------
// Timeline 1-line receipt pills (swarm:board-report / swarm:board-wakeup)
// ---------------------------------------------------------------------------

export const SW_BOARD_REPORT_PILL = L('Swarm report', '协同汇总')
export const SW_BOARD_WAKEUP_PILL = L('Swarm wakeup', '协同唤醒')
export const SW_PILL_OPEN_WORKBENCH = L('Open swarm workbench', '打开协同工作台')

export function swReceiptCountLabel(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`${count} post${count === 1 ? '' : 's'}`, `${count} 条流转`),
    locale,
  )
}

// ---------------------------------------------------------------------------
// Time observability labels & Tooltip breakdowns (zero Emoji)
// ---------------------------------------------------------------------------

export function timingWaitingLabel(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Awaiting approval ${duration}`, `等待审批 ${duration}`), locale)
}

export function timingWaitingWithTotalLabel(
  waiting: string,
  total: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(
    L(`Awaiting approval ${waiting} · total ${total}`, `等待审批 ${waiting} · 累计 ${total}`),
    locale,
  )
}

export function timingTurnWithTotalLabel(
  turn: string,
  total: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(L(`Turn ${turn} · total ${total}`, `本轮 ${turn} · 累计 ${total}`), locale)
}

export function timingTooltipEndToEnd(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`End-to-end: ${duration}`, `端到端总耗时：${duration}`), locale)
}

export function timingTooltipMembersTotal(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Total member runtime: ${duration}`, `全员累计运行：${duration}`), locale)
}

export function timingTooltipCreatedAt(timestamp: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Created: ${timestamp}`, `创建时间：${timestamp}`), locale)
}

export function timingTooltipClosedAt(timestamp: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Closed: ${timestamp}`, `结单时间：${timestamp}`), locale)
}

export function timingTooltipWaiting(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Awaiting approval: ${duration}`, `等待审批：${duration}`), locale)
}

export function timingTooltipCurrentTurn(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Current turn: ${duration}`, `本轮运行：${duration}`), locale)
}

export function timingTooltipCumulativeRun(duration: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Cumulative runtime: ${duration}`, `累计运行：${duration}`), locale)
}

export function timingTooltipTurns(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Completed turns: ${count}`, `已完成轮次：${count}`), locale)
}

export function timingTooltipJoinedAt(timestamp: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Joined: ${timestamp}`, `加入时间：${timestamp}`), locale)
}
