/**
 * Bilingual UI copy for `builtin:changes` (no Emoji; Fast Refresh friendly).
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
  type LocalizedText,
} from '@helmx/plugin-client'
import type { GitDiffFileStatus } from '../../contracts-types.js'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

export const CHG_COPY = {
  screenTitle: L('Changes', '改动'),
  targetPlaceholder: L('Select workspace or worktree', '选择会话工作区或受管工作树'),
  noTargetTitle: L('No workspace or worktree selected', '暂无可检视的工作区或工作树'),
  noTargetHint: L(
    'Open a conversation with a working directory or spawn an isolated worktree to inspect Git changes.',
    '请先打开带工作目录的会话，或派生一个隔离工作树后再检视 Git 改动。',
  ),
  loadingSummary: L('Loading change summary…', '正在加载改动概览…'),
  loadingFile: L('Loading file diff…', '正在加载单文件差异…'),
  retry: L('Retry', '重试'),
  refresh: L('Refresh', '刷新'),
  openChanges: L('Open changes', '打开改动'),
  viewChanges: L('View changes', '查看改动'),
  searchFiles: L('Filter changed files…', '筛选变更文件…'),
  noFiles: L('No changes in this scope', '当前范围内无改动'),
  noMatchingFiles: L('No files match your filter', '没有匹配筛选条件的文件'),
  selectFileHint: L('Select a file to inspect its diff', '从左侧选择一个文件查看差异'),
  filesTruncatedNote: L('File list capped at 500 items; total stats still cover all files.', '文件列表已截断展示前 500 项；统计数字仍覆盖全部文件。'),
  allCommittedFilter: L('All committed', '全部已提交'),
  commitSelectLabel: L('Inspect commit', '选择提交'),
  scopeAll: L('All', '全部'),
  scopeCommitted: L('Committed', '已提交'),
  scopeUncommitted: L('Uncommitted', '未提交'),
  scopeWorking: L('Uncommitted', '未提交'),
  scopeUnpushed: L('Unpushed', '未推送'),
  scopeCommit: L('Commits', '提交'),
  scopeSince: L('Since', '基线起'),
  notGitTitle: L('Not a Git repository', '当前目录不是 Git 仓库'),
  notGitBody: L(
    'Git diff inspection is unavailable because this working directory is not inside a Git repository.',
    '该工作目录不在 Git 仓库内，无法执行 Git 差异检视。',
  ),
  bareRepoBody: L(
    'This directory is a bare Git repository with no checked-out working tree.',
    '当前目录是裸仓库（bare），没有可检视的工作树。',
  ),
  wtRemovedTitle: L('Worktree registration removed', '工作树登记已清理'),
  wtRemovedBody: L(
    'This managed worktree has been cleaned up. Only registration metadata remains.',
    '该受管工作树已被清理，仅保留历史登记元数据。',
  ),
  wtMissingTitle: L('Worktree directory missing', '工作树目录不存在'),
  wtMissingBody: L(
    'Confirmed missing on the target node. Ask an agent to clean up the stale registration if needed.',
    '目标节点实测目录已不存在，可交由智能体清理残留登记。',
  ),
  branchMismatch: L('Switched branch', '分支已改签'),
  untrackedBadge: L('Untracked file (full bounded preview)', '未跟踪新文件（有界完整预览）'),
  binaryFileTitle: L('Binary file', '二进制文件'),
  binaryFileDesc: L(
    'Binary diff preview is omitted. Verify directly on the target node if needed.',
    '二进制文件不展示文本差异；如有需要请在目标节点直接核对。',
  ),
  tooLargeTitle: L('Single-file diff exceeds preview budget', '单文件差异超出预览上限'),
  tooLargeLineReason: L(
    'Too many changed lines to render inline without hurting browser responsiveness.',
    '单文件增删行数过多，已跳过在线全文渲染以保证页面响应流畅。',
  ),
  tooLargeByteReason: L(
    'The patch output exceeded the single-file byte cap (e.g. minified bundles or lockfiles).',
    '单文件补丁体积超出传输与预览上限（常见于 lockfile 或压缩产物）。',
  ),
  specialFileTitle: L('Unsupported special file', '不支持预览的特殊文件'),
  absentFileTitle: L('File no longer exists', '文件已不存在'),
  unchangedFileTitle: L('No diff in the current scope', '当前范围内该文件无差异'),
  copyPath: L('Copy path', '复制路径'),
  copyCommand: L('Copy git command', '复制复核命令'),
  backToFiles: L('Files', '文件'),
  backToFilesTitle: L('Back to files', '返回文件列表'),
  prevFile: L('Previous file', '上一个文件'),
  nextFile: L('Next file', '下一个文件'),
  wrapLines: L('Wrap lines', '自动换行'),
  unwrapLines: L('Horizontal scroll', '横向滚动'),
  workbenchWorkspaceTitle: L('Workspace changes', '当前工作区改动'),
  workbenchWorktreesTitle: L('Managed worktrees', '关联受管工作树'),
  workbenchNoChanges: L('Working tree is clean', '工作区干净，暂无未提交改动'),
  workbenchViewCommits: L('Inspect recent commits', '查看最近提交'),
  workbenchTruncatedHint: L('Showing top files; open Changes view for full list.', '仅展示部分条目；打开检视台查看完整清单。'),
  heldBadge: L('Held', '已加锁'),
} as const

export function statusLabelText(status: GitDiffFileStatus, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  switch (status) {
    case 'A':
      return resolveLocalizedText(L('Added', '新增'), locale)
    case 'D':
      return resolveLocalizedText(L('Deleted', '删除'), locale)
    case 'R':
      return resolveLocalizedText(L('Renamed', '重命名'), locale)
    case 'C':
      return resolveLocalizedText(L('Copied', '复制'), locale)
    case 'U':
      return resolveLocalizedText(L('Untracked', '未跟踪'), locale)
    case 'M':
      return resolveLocalizedText(L('Modified', '修改'), locale)
  }
}

export function chgSummaryText(
  totalFiles: number,
  additions: number,
  deletions: number,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(
    L(
      `${totalFiles} file${totalFiles === 1 ? '' : 's'} · +${additions} −${deletions}`,
      `${totalFiles} 个文件 · +${additions} −${deletions}`,
    ),
    locale,
  )
}

export function chgUntrackedBadge(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} untracked`, `${count} 个未跟踪`), locale)
}

export function chgCommitsAheadBadge(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} commit${count === 1 ? '' : 's'} ahead`, `领先 ${count} 个提交`), locale)
}

export function chgUnmergedBadge(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} unmerged`, `${count} 个未合入`), locale)
}

export function chgUnpushedBadge(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`${count} unpushed`, `${count} 个未推送`), locale)
}

export function chgExpandRemaining(count: number, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Show ${count} more lines`, `展开剩余 ${count} 行`), locale)
}

export function chgCollapseDiff(locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L('Collapse lines', '收起长差异'), locale)
}

export function chgSpecialFileDetail(fileKind: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  if (fileKind === 'symlink_outside_repo') {
    return resolveLocalizedText(
      L('Symlink points outside the repository root; reading is blocked.', '软链接指向仓库根目录之外，拒绝读取。'),
      locale,
    )
  }
  return resolveLocalizedText(
    L(`Entry is not a regular file (${fileKind}).`, `该条目不是普通文件（${fileKind}）。`),
    locale,
  )
}

export function chgBytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function chgSlotBrief(
  branch: string,
  nodeId: string | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (nodeId && nodeId !== 'local') {
    return resolveLocalizedText(L(`${branch} on ${nodeId}`, `${branch} · 节点 ${nodeId}`), locale)
  }
  return branch
}

export function chgInspectTitle(targetLabel: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`View changes: ${targetLabel}`, `查看改动：${targetLabel}`), locale)
}
