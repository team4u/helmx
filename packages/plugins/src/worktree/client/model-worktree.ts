/**
 * Pure logic and bilingual copy for the builtin:worktree client slots:
 * - lenient/strict boundary parsing of `inspect_worktree` action results;
 * - worktree action selector builder (registered ID first, path + nodeId fallback);
 * - read-only review request text builder for submitting to the parent conversation.
 * Zero React/DOM dependencies; Fast Refresh friendly.
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

export interface WorktreeInspectView {
  worktreeId: string
  nodeId: string
  path: string
  branch: string
  baseCommit: string
  status: string
  origin: string
  exists: boolean
  unavailableReason?: string
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  dirtyFiles: string[]
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  commitsAhead?: number
  unmergedCommits?: number
  diffStat?: string
  diffPreview?: string
  diffTruncated: boolean
  diffBase: string
}

function inspectString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function inspectCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function firstLineOf(text: string, maxChars: number): string {
  const line = (text.split(/\r?\n/, 1)[0] ?? '').trim()
  if (line.length <= maxChars) return line
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Strictly parse the `inspect_worktree` action result. Structurally invalid
 * shapes return `undefined` instead of fabricating an empty or cleaned view.
 */
export function parseWorktreeInspectResult(raw: unknown): WorktreeInspectView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result = raw as Record<string, unknown>
  const record = result['record']
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const rec = record as Record<string, unknown>
  const worktreeId = inspectString(rec, 'id')
  const path = inspectString(rec, 'path')
  const branch = inspectString(rec, 'branch')
  const nodeId = inspectString(rec, 'nodeId')
  if (worktreeId === undefined || path === undefined || branch === undefined || nodeId === undefined) return undefined
  const baseCommit = rec['baseCommit']
  if (baseCommit !== undefined && typeof baseCommit !== 'string') return undefined
  const status = rec['status'] ?? 'active'
  if (status !== 'active' && status !== 'removed') return undefined
  const origin = rec['origin'] ?? 'native'
  if (origin !== 'native') return undefined
  if (typeof result['exists'] !== 'boolean') return undefined
  const dirtyFilesRaw = result['dirtyFiles']
  if (!Array.isArray(dirtyFilesRaw) || dirtyFilesRaw.some((l) => typeof l !== 'string')) return undefined
  const dirtyFiles = dirtyFilesRaw as string[]
  if (!inspectCount(result['dirtyFileCount'])) return undefined
  const dirtyFileCount: number = result['dirtyFileCount']
  if (typeof result['dirtyFilesTruncated'] !== 'boolean') return undefined
  const dirtyFilesTruncated: boolean = result['dirtyFilesTruncated']
  if (typeof result['diffTruncated'] !== 'boolean') return undefined
  const diffBase = result['diffBase']
  if (diffBase !== 'baseCommit' && diffBase !== 'HEAD') return undefined
  if (dirtyFilesTruncated ? dirtyFileCount <= dirtyFiles.length : dirtyFileCount !== dirtyFiles.length) return undefined
  const unavailableReason = inspectString(result, 'unavailableReason')
  if (unavailableReason !== undefined && unavailableReason !== 'removed' && unavailableReason !== 'directory_missing') {
    return undefined
  }
  const currentBranch = inspectString(result, 'currentBranch')
  const currentHead = inspectString(result, 'currentHead')
  if (result['branchChanged'] !== undefined && typeof result['branchChanged'] !== 'boolean') return undefined
  const commitsAhead = result['commitsAhead']
  if (commitsAhead !== undefined && !inspectCount(commitsAhead)) return undefined
  const unmergedCommits = result['unmergedCommits']
  if (unmergedCommits !== undefined && !inspectCount(unmergedCommits)) return undefined
  const diffStat = inspectString(result, 'diffStat')
  const diffPreview = inspectString(result, 'diffPreview')
  return {
    worktreeId,
    nodeId,
    path,
    branch,
    baseCommit: baseCommit ?? '',
    status,
    origin,
    exists: result['exists'],
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    ...(currentBranch !== undefined ? { currentBranch } : {}),
    ...(currentHead !== undefined ? { currentHead } : {}),
    ...(result['branchChanged'] === true ? { branchChanged: true } : {}),
    dirtyFiles,
    dirtyFileCount,
    dirtyFilesTruncated,
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    ...(unmergedCommits !== undefined ? { unmergedCommits } : {}),
    ...(diffStat !== undefined ? { diffStat } : {}),
    ...(diffPreview !== undefined ? { diffPreview } : {}),
    diffTruncated: result['diffTruncated'],
    diffBase,
  }
}

/**
 * Build the selector for `inspect_worktree` / `cleanup_worktree`: registered
 * worktree ID wins; otherwise fall back to `{ path, nodeId }` disambiguation.
 */
export function buildWorktreeSelector(
  worktree: { id?: string; path: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  return { path: worktree.path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
}

/** Build the read-only review-and-merge request text submitted to the parent conversation. */
export function buildWorktreeReviewRequest(
  input: {
    path: string
    branch: string
    nodeId?: string
    baseCommit?: string
    taskLabel?: string
    inspect?: WorktreeInspectView
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const nodeSuffix =
    input.nodeId !== undefined && input.nodeId !== ''
      ? t(L(` (node ${input.nodeId})`, `（节点 ${input.nodeId}）`))
      : ''
  const baseSuffix =
    input.baseCommit !== undefined && input.baseCommit !== ''
      ? t(L(` (based on commit ${input.baseCommit.slice(0, 12)})`, `（基于提交 ${input.baseCommit.slice(0, 12)}）`))
      : ''
  const lines: string[] = [
    t(
      L(
        'Please review and merge the changes of the following managed worktree (data comes from a read-only inspection; verify the actual content with git on the target node):',
        '请审阅并合入以下受管工作树的改动（数据来自只读检视，实际内容请在目标节点以 git 复核）：',
      ),
    ),
    t(L(`- Worktree: ${input.path}${nodeSuffix}`, `- 工作树：${input.path}${nodeSuffix}`)),
    t(L(`- Branch: ${input.branch}${baseSuffix}`, `- 分支：${input.branch}${baseSuffix}`)),
  ]
  if (input.taskLabel !== undefined && input.taskLabel.trim() !== '') {
    const task = firstLineOf(input.taskLabel, 80)
    lines.push(t(L(`- Task: ${task}`, `- 任务：${task}`)))
  }
  const inspect = input.inspect
  if (inspect !== undefined) {
    if (!inspect.exists) {
      const reason = t(inspect.unavailableReason === 'removed' ? L('registration cleaned up', '登记已清理') : L('directory missing', '不存在'))
      lines.push(t(L(`- Inspection: ${reason}; nothing to inspect`, `- 检视：目录${reason}，无可检视改动`)))
    } else {
      lines.push(
        t(
          L(
            `- Uncommitted changes: ${inspect.dirtyFileCount} file${inspect.dirtyFileCount > 1 ? 's' : ''}`,
            `- 未提交修改：${inspect.dirtyFileCount} 个文件`,
          ),
        ),
      )
      if (inspect.commitsAhead !== undefined) {
        lines.push(t(L(`- Commits ahead of base: ${inspect.commitsAhead}`, `- 领先基线提交：${inspect.commitsAhead} 个`)))
      }
      if (inspect.branchChanged === true && inspect.currentBranch !== undefined) {
        lines.push(
          t(
            L(
              `- Note: the worktree is currently on branch ${inspect.currentBranch}, which differs from the registered branch — it may have been switched; verify ownership first`,
              `- 注意：工作树当前分支 ${inspect.currentBranch} 与登记分支不一致，可能已被改签，请先核实归属`,
            ),
          ),
        )
      }
    }
  }
  lines.push(
    t(
      L(
        'Review read-only first (git diff / status) and merge into the main worktree after confirming; state explicitly if the worktree should be discarded or cleaned up — never force-clean silently.',
        '请先只读复核（git diff / status），确认后合入主工作树；需要丢弃或清理工作树时请明确说明，不要静默 force 清理。',
      ),
    ),
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Localized copy for WorktreeInspectSlot & WorktreeCleanupSlot
// ---------------------------------------------------------------------------

export const WT_SPIN = 'spin-slow'

export const WT_COPY = {
  inspectInvalid: L(
    'Inspection result has an invalid shape (unexpected action payload; refusing to fabricate a view)',
    '检视结果结构不合法（动作返回非预期形状，拒绝伪造展示）',
  ),
  submitted: L('Review request submitted to the main conversation', '已向主会话提交工作树审阅请求'),
  unavailableRemoved: L('Registration cleaned up (the worktree has been removed)', '登记已清理（工作树已被移除）'),
  unavailableMissing: L(
    'Directory no longer exists (confirmed by a real probe on the node; the registration is kept)',
    '目录已不存在（节点真实探测证实；登记仍保留）',
  ),
  collapseTitle: L('Collapse the worktree change overview', '收起工作树改动概览'),
  expandTitle: L(
    'Expand the read-only worktree change overview (real git inspection on the target node)',
    '展开工作树只读改动概览（目标节点真实 git 检视）',
  ),
  overview: L('Change overview', '改动概览'),
  reinspectTitle: L('Re-inspect (read-only)', '重新检视（只读）'),
  refresh: L('Refresh', '刷新'),
  inspecting: L('Read-only inspection on the target node…', '目标节点只读检视中…'),
  retry: L('Retry', '重试'),
  kvBranch: L('Branch', '分支'),
  branchMismatch: L('Differs from registration', '与登记不一致'),
  kvBase: L('Base', '基线'),
  noBase: L('No registered base (uncommitted changes inspected against HEAD)', '无登记基线（按 HEAD 检视未提交改动）'),
  kvDirty: L('Uncommitted changes', '未提交修改'),
  kvAhead: L('Commits ahead of base', '领先基线提交'),
  kvHead: L('Current HEAD', '当前 HEAD'),
  noDirty: L('No uncommitted changes in the worktree', '工作区无未提交修改'),
  diffNote: L('The diff covers tracked files only; untracked files are in the status list.', 'Diff 仅包含已跟踪文件；未跟踪文件见状态列表。'),
  diffPreviewSection: L('Diff preview (read-only, capped)', 'Diff 预览（只读，有上限）'),
  diffTruncated: L('Truncated', '已截断'),
  noDiff: L('No tracked-file diff', '无已跟踪文件 diff'),
  reviewButton: L('Ask the main conversation to review and merge', '让主会话审阅并合入'),
  reviewTitle: L(
    'Submit a review-and-merge request to the main conversation (actual inspection and merging are done there)',
    '向主会话提交审阅与合入请求（实际检视与合入由主会话执行）',
  ),
  copyReview: L('Copy review request', '复制审阅请求文本'),
  cleanupLabel: L('Clean up worktree', '清理工作树'),
  cleanupTitle: L(
    'Clean up the isolated worktree (registered ID first for precise targeting, avoiding same-path ambiguity across nodes)',
    '清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）',
  ),
  cleanupAria: L('Clean up isolated worktree', '清理隔离工作树'),
} as const

export function wtSubmitFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Failed to submit the review request: ${err}`, `提交审阅请求失败：${err}`), locale)
}

export function wtInspectFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Read-only inspection failed: ${err}`, `只读检视失败：${err}`), locale)
}

export function wtUnavailableCta(reason: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`${reason}; git inspection is unavailable. Showing registration metadata only.`, `${reason}，无法执行 git 检视；仅展示登记元数据。`),
    locale,
  )
}

export function wtBranchMismatchTitle(branch: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`Registered branch ${branch}; the worktree may have been switched`, `登记分支 ${branch}；工作树可能已被改签`),
    locale,
  )
}

export function wtBaseValue(baseCommit: string, diffBase: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  const short = baseCommit.slice(0, 12)
  return resolveLocalizedText(
    L(
      `${short} (${diffBase === 'HEAD' ? 'no base, against HEAD' : 'registered base'})`,
      `${short}（${diffBase === 'HEAD' ? '无基线，按 HEAD' : '登记基线'}）`,
    ),
    locale,
  )
}

export function wtDirtyCount(count: number, truncated: boolean, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  const suffix = truncated
    ? resolveLocalizedText(L(' (list truncated; showing the first items)', '（列表已截断，仅显示前若干项）'), locale)
    : ''
  return resolveLocalizedText(L(`${count} file${count > 1 ? 's' : ''}${suffix}`, `${count} 个文件${suffix}`), locale)
}

export function wtAheadCount(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count}`, `${count} 个`), locale)
}

export function wtDiffStatSection(diffBase: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(`Diff stats (vs ${diffBase === 'HEAD' ? 'HEAD' : 'base'})`, `Diff 统计（相对${diffBase === 'HEAD' ? ' HEAD' : '基线'}）`),
    locale,
  )
}

export function wtCleanupDone(branch: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Cleaned up isolated worktree ${branch}`, `已清理隔离工作树 ${branch}`), locale)
}

export function wtCleanupFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Failed to clean up worktree: ${err}`, `清理工作树失败：${err}`), locale)
}
