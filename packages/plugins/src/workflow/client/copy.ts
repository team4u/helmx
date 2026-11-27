/**
 * Localized copy dictionary for builtin:workflow UI surfaces (en / zh-CN).
 * Zero Emoji; concise engineering language.
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
  type LocalizedText,
} from '@helmx/ui'

const zh = (locale: HelmxLocale): boolean => locale === 'zh-CN'

export const SPIN_CLASS = 'spin-slow'

// ---------------------------------------------------------------------------
// Status & badge labels
// ---------------------------------------------------------------------------

export type ExecutionStatusKey = 'blocked' | 'working' | 'aborted' | 'error' | 'done' | 'pending'

export const STATUS_COPY: Record<ExecutionStatusKey, LocalizedText> = {
  blocked: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  working: { en: 'Running', 'zh-CN': '运行中' },
  aborted: { en: 'Aborted', 'zh-CN': '已中止' },
  error: { en: 'Failed', 'zh-CN': '失败' },
  done: { en: 'Completed', 'zh-CN': '已完成' },
  pending: { en: 'Queued', 'zh-CN': '排队中' },
}

export function statusLabel(status: ExecutionStatusKey, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(STATUS_COPY[status], locale)
}

export function runStatusLabel(
  status: 'running' | 'completed' | 'failed' | 'aborted',
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (status === 'running') return statusLabel('working', locale)
  if (status === 'completed') return statusLabel('done', locale)
  if (status === 'aborted') return statusLabel('aborted', locale)
  return statusLabel('error', locale)
}

export const COPY = {
  // Common actions
  abort: { en: 'Abort', 'zh-CN': '中止' },
  resume: { en: 'Resume', 'zh-CN': '续跑' },
  replay: { en: 'Replay', 'zh-CN': '重放' },
  refresh: { en: 'Refresh', 'zh-CN': '刷新' },
  retry: { en: 'Retry', 'zh-CN': '重试' },
  close: { en: 'Close', 'zh-CN': '关闭' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  delete: { en: 'Delete', 'zh-CN': '删除' },
  deleting: { en: 'Deleting…', 'zh-CN': '删除中…' },
  run: { en: 'Run', 'zh-CN': '运行' },
  loading: { en: 'Loading…', 'zh-CN': '加载中…' },

  // Trace rows
  subagentLabel: { en: 'Subagent', 'zh-CN': '子代理' },
  workflowLabel: { en: 'Workflow', 'zh-CN': '工作流' },
  actionLabel: { en: 'Action', 'zh-CN': '动作' },
  backgroundRunning: { en: 'Running in background', 'zh-CN': '后台运行中' },
  backgroundDispatched: { en: 'Dispatched in background', 'zh-CN': '已转后台执行' },
  resumedBelow: { en: 'Resumed below', 'zh-CN': '已在下方续接' },
  expandDetails: { en: 'Expand call details', 'zh-CN': '展开调用详情' },
  collapseDetails: { en: 'Collapse call details', 'zh-CN': '收起调用详情' },

  // Live snippet tags
  tagTool: { en: 'Tool', 'zh-CN': '工具' },
  tagThinking: { en: 'Thinking', 'zh-CN': '思考' },
  tagOutput: { en: 'Output', 'zh-CN': '输出' },
  tagError: { en: 'Error', 'zh-CN': '错误' },
  tagApproval: { en: 'Approval', 'zh-CN': '审批' },
  snippetThinking: { en: 'Thinking…', 'zh-CN': '思考中…' },
  snippetStarting: { en: 'Starting…', 'zh-CN': '启动中…' },
  snippetGateFailed: { en: 'Gate failed', 'zh-CN': '门禁未通过' },
  snippetExecFailed: { en: 'Execution failed', 'zh-CN': '执行失败' },
  snippetAborted: { en: 'Aborted', 'zh-CN': '已中止' },
  snippetLoadFailed: { en: 'Failed to load details', 'zh-CN': '详情加载失败' },

  // Background report
  reportSubagentTitle: { en: 'Subagent Report', 'zh-CN': '子代理汇报' },
  reportWorkflowTitle: { en: 'Workflow Report', 'zh-CN': '工作流汇报' },
  reportInvalidTitle: { en: 'Invalid Background Report', 'zh-CN': '无效后台汇报' },
  reportInvalidBadge: { en: 'Corrupted', 'zh-CN': '数据损坏' },
  reportInvalidPreview: { en: 'Unrecognized report payload', 'zh-CN': '无法解析汇报载荷' },
  reportInvalidCallout: {
    en: 'The background report metadata is incomplete or corrupted. Raw message content is shown below.',
    'zh-CN': '后台汇报元数据缺失或损坏，以下保留原始消息内容。',
  },
  reportKvName: { en: 'Task', 'zh-CN': '任务' },
  reportKvRunId: { en: 'Run ID', 'zh-CN': '运行 ID' },
  reportKvDeliveredAt: { en: 'Delivered', 'zh-CN': '送达时间' },
  reportKvKind: { en: 'Type', 'zh-CN': '类型' },
  reportKvSubagent: { en: 'Subagent', 'zh-CN': '子代理' },
  reportResultSection: { en: 'Result', 'zh-CN': '返回结果' },
  reportNoResult: { en: 'No result payload.', 'zh-CN': '无返回内容。' },
  reportOtherTasks: { en: 'Other running tasks', 'zh-CN': '其余运行中任务' },

  // Workbench & Run card
  workbenchTitle: { en: 'Workflows & Subagents', 'zh-CN': '工作流与子代理' },
  workbenchLibrary: { en: 'Library', 'zh-CN': '工作流库' },
  workbenchNoConversation: { en: 'Select a conversation to view tasks.', 'zh-CN': '请选择一个会话以查看任务。' },
  workbenchNoRuns: { en: 'No workflows or subagents in this conversation yet.', 'zh-CN': '当前会话暂无工作流或子代理任务。' },
  workbenchLoadError: { en: 'Failed to sync task state.', 'zh-CN': '任务状态同步失败。' },
  workbenchResumeTitle: { en: 'Resume all resumable failed runs in this conversation', 'zh-CN': '恢复当前会话下所有可续跑的失败任务' },
  workbenchResumeNone: { en: 'No failed runs to resume.', 'zh-CN': '没有需要恢复的失败任务。' },
  defaultPhaseTitle: { en: 'Other Steps', 'zh-CN': '其他步骤' },
  runNoNodes: { en: 'No steps recorded yet.', 'zh-CN': '暂无执行步骤。' },
  runResultSection: { en: 'Result', 'zh-CN': '执行结果' },
  runExpandResult: { en: 'Expand', 'zh-CN': '展开' },
  runCollapseResult: { en: 'Collapse', 'zh-CN': '收起' },
  runLogsSection: { en: 'Logs', 'zh-CN': '日志' },
  runCachedBadge: { en: 'Cached', 'zh-CN': '缓存命中' },
  runSavedBadge: { en: 'Saved', 'zh-CN': '已保存' },
  runGatePassed: { en: 'Gate passed', 'zh-CN': '门禁通过' },
  runGateFailed: { en: 'Gate failed', 'zh-CN': '门禁失败' },
  runKvRunId: { en: 'Run ID', 'zh-CN': '运行 ID' },
  runKvStatus: { en: 'Status', 'zh-CN': '状态' },
  runKvCreatedAt: { en: 'Created', 'zh-CN': '创建时间' },
  runKvSettledAt: { en: 'Settled', 'zh-CN': '结束时间' },
  runKvSavedDef: { en: 'Definition', 'zh-CN': '定义名' },
  runKvSourceRun: { en: 'Replayed from', 'zh-CN': '重放来源' },
  runKvResumedBy: { en: 'Resumed by', 'zh-CN': '已被续跑' },
  nodeKvBackend: { en: 'Agent', 'zh-CN': '代理类型' },
  nodeKvNode: { en: 'Node', 'zh-CN': '节点' },
  nodeKvExecution: { en: 'Execution', 'zh-CN': '执行句柄' },
  nodeKvCwd: { en: 'CWD', 'zh-CN': '工作目录' },
  nodeKvWorktree: { en: 'Worktree', 'zh-CN': '工作树' },
  nodeKvModel: { en: 'Model', 'zh-CN': '模型' },
  nodeKvDuration: { en: 'Duration', 'zh-CN': '耗时' },
  nodeKvTokens: { en: 'Tokens', 'zh-CN': 'Token' },
  nodeSectionPrompt: { en: 'Prompt', 'zh-CN': '指令' },
  nodeSectionOutput: { en: 'Output', 'zh-CN': '输出' },
  nodeSectionError: { en: 'Error', 'zh-CN': '错误' },
  nodeSectionGate: { en: 'Gate', 'zh-CN': '门禁' },
  replayHint: { en: 'Leave blank to reuse original arguments, or enter JSON to override.', 'zh-CN': '留空沿用原参数，或输入 JSON 覆盖参数。' },
  replayArgsPlaceholder: { en: 'Optional JSON args, e.g. {"target":"api"}', 'zh-CN': '可选 JSON 参数，例如 {"target":"api"}' },
  replaySubmit: { en: 'Start replay', 'zh-CN': '开始重放' },

  // Active tray
  trayRegionAria: { en: 'Active workflows and subagents', 'zh-CN': '运行中的工作流与子代理' },
  trayWorkbench: { en: 'Tasks', 'zh-CN': '任务面板' },
  trayExpand: { en: 'Expand active tasks', 'zh-CN': '展开运行中任务' },
  trayCollapse: { en: 'Collapse active tasks', 'zh-CN': '收起运行中任务' },

  // Library screen
  libTitle: { en: 'Workflow Library', 'zh-CN': '工作流库' },
  libSearchPlaceholder: { en: 'Search workflows by name or description…', 'zh-CN': '按名称或描述检索工作流…' },
  libSearchAria: { en: 'Search workflow library', 'zh-CN': '检索工作流库' },
  libEmptyTitle: { en: 'No saved workflows', 'zh-CN': '暂无已保存工作流' },
  libEmptyHint: {
    en: 'Ask the assistant to save reusable workflows via the workflow save action.',
    'zh-CN': '可让助手保存可复用的工作流脚本，保存后将在此展示。',
  },
  libNoDescription: { en: 'No description', 'zh-CN': '暂无描述' },
  libMetadataBadge: { en: 'Metadata issue', 'zh-CN': '元数据异常' },
  libKvDescription: { en: 'Description', 'zh-CN': '描述' },
  libKvWhenToUse: { en: 'When to use', 'zh-CN': '适用场景' },
  libKvPhases: { en: 'Phases', 'zh-CN': '阶段' },
  libPhasesUndeclared: { en: 'Not declared', 'zh-CN': '未声明' },
  libSourceSection: { en: 'Script Source (Read-only)', 'zh-CN': '脚本源码（只读）' },
  libCopySource: { en: 'Copy source', 'zh-CN': '复制源码' },
  libRunSection: { en: 'Run in Conversation', 'zh-CN': '在指定会话中运行' },
  libRunSelectPlaceholder: { en: 'Select a target conversation…', 'zh-CN': '选择目标会话…' },
  libRunSelectAria: { en: 'Target conversation', 'zh-CN': '目标会话' },
  libArgsPlaceholder: { en: 'Optional JSON args', 'zh-CN': '可选 JSON 参数' },
  libNoConversations: { en: 'No top-level conversations available.', 'zh-CN': '当前没有可用的顶层会话。' },
  libEditSection: { en: 'Edit via Assistant', 'zh-CN': '交由助手修改' },
  libEditHint: {
    en: 'Copy this request into a conversation to let the assistant update the workflow definition.',
    'zh-CN': '复制以下提示发给助手，即可修改并重新校验工作流定义。',
  },
  libCopyEdit: { en: 'Copy request', 'zh-CN': '复制修改提示' },
  libDeleteTitle: { en: 'Delete workflow', 'zh-CN': '删除工作流' },
  libDeleteConfirmBtn: { en: 'Delete', 'zh-CN': '确认删除' },
} as const

// ---------------------------------------------------------------------------
// Parameterized copy helpers
// ---------------------------------------------------------------------------

export function fallbackConversationTitle(id: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `子代理 #${id}` : `Subagent #${id}`
}

export function traceOpenChildLabel(id: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `打开子会话 #${id}` : `Open subagent conversation #${id}`
}

export function traceOpenWorkbenchRunLabel(runId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `在任务面板查看 ${runId}` : `Inspect ${runId} in Tasks`
}

export function reportToggleLabel(title: string, open: boolean, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (zh(locale)) return open ? `收起 ${title}` : `展开 ${title}`
  return open ? `Collapse ${title}` : `Expand ${title}`
}

export function traceResumeFallbackLabel(runId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `续跑 ${runId}` : `Resume ${runId}`
}

export function attemptBadge(attempt: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `第 ${attempt} 次` : `Try #${attempt}`
}

export function worktreeBadgeTitle(
  branch: string,
  path: string | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const detail = path ? `${branch} (${path})` : branch
  return zh(locale) ? `隔离工作树：${detail}` : `Isolated worktree: ${detail}`
}

export function workbenchResumeFailedButton(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `恢复失败 (${count})` : `Resume failed (${count})`
}

export function workbenchResumeStarted(resumed: number, skipped: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (zh(locale)) return skipped > 0 ? `已拉起 ${resumed} 个失败任务，跳过 ${skipped} 个` : `已拉起 ${resumed} 个失败任务`
  return skipped > 0 ? `Resumed ${resumed} failed run(s), skipped ${skipped}` : `Resumed ${resumed} failed run(s)`
}

export function workbenchResumeAllSkipped(skipped: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `无可恢复任务（已跳过 ${skipped} 个）` : `No resumable runs (skipped ${skipped})`
}

export function workbenchResumeInvalidResult(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? '批量恢复返回结果格式无效' : 'Invalid resume_failed response payload'
}

export function trayCountLabel(blocked: number, running: number, total: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (zh(locale)) {
    if (blocked > 0 && running > 0) return `${blocked} 待审批 · ${running} 运行中`
    if (blocked > 0) return `${blocked} 个任务待审批`
    return `${total} 个任务运行中`
  }
  if (blocked > 0 && running > 0) return `${blocked} awaiting approval · ${running} running`
  if (blocked > 0) return `${blocked} awaiting approval`
  return `${total} running`
}

export function trayAwaitingElapsed(elapsed: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `等待 ${elapsed}` : `waiting ${elapsed}`
}

export function replayMetaText(runId: string, conversationId: number, savedName: string | undefined, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  const base = savedName !== undefined ? `${savedName} (${runId})` : runId
  return zh(locale) ? `从 ${base} 重放到会话 #${conversationId}` : `Replay ${base} in conversation #${conversationId}`
}

export function replayAcceptedNotice(newRunId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `已启动重放任务 ${newRunId}` : `Replay started (${newRunId})`
}

export function resumeInitiatedNotice(newRunId: string | undefined, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (newRunId) return zh(locale) ? `已发起续跑任务 ${newRunId}` : `Resume initiated (${newRunId})`
  return zh(locale) ? '已发起续跑任务' : 'Resume initiated'
}

export function selfVsSubtreeAriaLabel(
  selfStatus: ExecutionStatusKey,
  effectiveStatus: ExecutionStatusKey,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const selfText = statusLabel(selfStatus, locale)
  const subText = statusLabel(effectiveStatus, locale)
  return zh(locale)
    ? `自身：${selfText}；子树聚合：${subText}`
    : `Self: ${selfText}; subtree aggregate: ${subText}`
}

export function timingWallLine(text: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `总墙钟耗时：${text}` : `Wall time: ${text}`
}

export function timingNodeTotalLine(text: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `节点累计耗时：${text}` : `Cumulative node time: ${text}`
}

export function timingStartedLine(text: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `开始时间：${text}` : `Started: ${text}`
}

export function timingSettledLine(text: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `结束时间：${text}` : `Settled: ${text}`
}

export function libSubtitle(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `共 ${count} 个已保存工作流` : `${count} saved workflow${count === 1 ? '' : 's'}`
}

export function libNoMatch(query: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `未找到匹配 “${query}” 的工作流` : `No workflows matching "${query}"`
}

export function libPhasesSummary(count: number, titles: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `${count} 阶段：${titles}` : `${count} phases: ${titles}`
}

export function libMetadataErrorText(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `元数据错误：${err}` : `Metadata error: ${err}`
}

export function libArgsInvalidJson(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `参数 JSON 格式无效：${err}` : `Invalid JSON arguments: ${err}`
}

export function libPickConversationFirst(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? '请先选择一个目标会话' : 'Select a target conversation first'
}

export function libRunStarted(name: string, convId: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `已在会话 #${convId} 启动工作流 ${name}` : `Started workflow ${name} in conversation #${convId}`
}

export function libDeletedNotice(name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `已删除工作流 ${name}` : `Deleted workflow ${name}`
}

export function libDeleteConfirmDesc(name: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale)
    ? `确定删除已保存的工作流 “${name}” 吗？该操作不可撤销。`
    : `Delete saved workflow "${name}"? This action cannot be undone.`
}

export function libDetailInvalid(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? '工作流详情返回格式无效' : 'Invalid workflow detail payload'
}

export function libListInvalid(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? '工作流列表返回格式无效' : 'Invalid workflow list payload'
}

export function actionFailedNotice(label: string, message: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return zh(locale) ? `${label}失败：${message}` : `${label} failed: ${message}`
}

export function buildWorkflowEditRequestLines(
  name: string,
  description: string | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string[] {
  if (zh(locale)) {
    return [
      `请查看并更新已保存的工作流 "${name}"：`,
      ...(description !== undefined ? [`当前描述：${description}`] : []),
      '1. 先调用 builtin:workflow 的 get 动作读取当前源码；',
      '2. 根据我的需求修改并确保 export const meta 为纯字面量；',
      '3. 调用 builtin:workflow 的 save 动作写回。',
    ]
  }
  return [
    `Inspect and update the saved workflow "${name}":`,
    ...(description !== undefined ? [`Current description: ${description}`] : []),
    '1. Read the current source using builtin:workflow action `get`;',
    '2. Apply my requested edits while keeping `export const meta` a pure literal;',
    '3. Save the updated script with builtin:workflow action `save`.',
  ]
}
