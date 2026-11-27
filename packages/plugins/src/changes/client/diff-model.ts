/**
 * Pure data models, boundary parsers, URL target builders, and bounded word-diff
 * highlighter for `builtin:changes`.
 * Zero React/DOM dependencies (Fast Refresh compliant).
 */
import type {
  GitDiffCommitEntry,
  GitDiffFileEntry,
  GitDiffFileResult,
  GitDiffFileStatus,
  GitDiffHunk,
  GitDiffHunkRow,
  GitDiffSummary,
  WorkspaceDiffScope,
  WorkspaceInspectResult,
  WorktreeDiffScope,
} from '../../contracts-types.js'

const CHANGES_PLUGIN_ID = 'builtin:changes' as const
const CHANGES_SCREEN_ID = 'inspector' as const

export interface ManagedWorktreeSummaryView {
  id: string
  nodeId: string
  repoRoot: string
  path: string
  branch: string
  baseCommit: string
  baseBranch?: string
  parentConversationId: number
  conversationId?: number
  status: 'active' | 'removed'
  createdAt: number
  hold?: { pluginId: string; holdId: string; label: string; acquiredAt: number }
}

export interface WorktreeInspectView {
  record: ManagedWorktreeSummaryView
  exists: boolean
  unavailableReason?: 'removed' | 'directory_missing'
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  commitsAhead?: number
  unmergedCommits?: number
  diffBase: 'baseCommit' | 'HEAD' | 'upstream' | 'commit'
  scope: WorktreeDiffScope
  selectedCommit?: string
  commits: GitDiffCommitEntry[]
  commitsTruncated: boolean
  summary: GitDiffSummary
  files: GitDiffFileEntry[]
  filesTruncated: boolean
}

export type ChangesTargetSelection =
  | { kind: 'worktree'; worktreeId: string }
  | { kind: 'workspace'; conversationId: number }

export interface WordSegment {
  text: string
  changed: boolean
}

export interface DecoratedHunkRow extends GitDiffHunkRow {
  word?: WordSegment[]
}

export interface DecoratedHunk extends Omit<GitDiffHunk, 'rows'> {
  rows: DecoratedHunkRow[]
}

const VALID_FILE_STATUSES = new Set<GitDiffFileStatus>(['M', 'A', 'D', 'R', 'C', 'U'])
const VALID_WORKTREE_SCOPES = new Set<WorktreeDiffScope>(['all', 'committed', 'uncommitted'])
const VALID_WORKSPACE_SCOPES = new Set<WorkspaceDiffScope>(['working', 'unpushed', 'commit', 'since'])
const VALID_DIFF_BASES = new Set(['baseCommit', 'HEAD', 'upstream', 'commit'])

const WORD_DIFF_MAX_LINE_CHARS = 2_048
const WORD_DIFF_MAX_CELLS = 12_000

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asNonEmptyStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asNonNegInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function parseSummary(raw: unknown): GitDiffSummary | undefined {
  const o = asObj(raw)
  if (o === undefined) return undefined
  const totalFiles = asNonNegInt(o['totalFiles'])
  const additions = asNonNegInt(o['additions'])
  const deletions = asNonNegInt(o['deletions'])
  const untrackedCount = asNonNegInt(o['untrackedCount'])
  const dirtyFileCount = asNonNegInt(o['dirtyFileCount'])
  if (
    totalFiles === undefined ||
    additions === undefined ||
    deletions === undefined ||
    untrackedCount === undefined ||
    dirtyFileCount === undefined
  ) {
    return undefined
  }
  return { totalFiles, additions, deletions, untrackedCount, dirtyFileCount }
}

function parseFileEntries(raw: unknown): GitDiffFileEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GitDiffFileEntry[] = []
  for (const item of raw) {
    const o = asObj(item)
    if (o === undefined) return undefined
    const path = typeof o['path'] === 'string' && o['path'] !== '' ? o['path'] : undefined
    const status = typeof o['status'] === 'string' && VALID_FILE_STATUSES.has(o['status'] as GitDiffFileStatus)
      ? (o['status'] as GitDiffFileStatus)
      : undefined
    const additions = asNonNegInt(o['additions'])
    const deletions = asNonNegInt(o['deletions'])
    if (
      path === undefined ||
      status === undefined ||
      additions === undefined ||
      deletions === undefined ||
      typeof o['binary'] !== 'boolean' ||
      typeof o['untracked'] !== 'boolean'
    ) {
      return undefined
    }
    const oldPath = typeof o['oldPath'] === 'string' && o['oldPath'] !== '' ? o['oldPath'] : undefined
    out.push({
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      additions,
      deletions,
      binary: o['binary'],
      untracked: o['untracked'],
    })
  }
  return out
}

function parseCommitEntries(raw: unknown): GitDiffCommitEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GitDiffCommitEntry[] = []
  for (const item of raw) {
    const o = asObj(item)
    if (o === undefined) return undefined
    const oid = asNonEmptyStr(o['oid'])
    const shortOid = asNonEmptyStr(o['shortOid'])
    const committedAt = asNonNegInt(o['committedAt'])
    if (
      oid === undefined ||
      shortOid === undefined ||
      typeof o['subject'] !== 'string' ||
      typeof o['author'] !== 'string' ||
      committedAt === undefined
    ) {
      return undefined
    }
    out.push({
      oid,
      shortOid,
      subject: o['subject'],
      author: o['author'],
      committedAt,
      ...(o['unpushed'] === true ? { unpushed: true } : {}),
    })
  }
  return out
}

export function parseWorktreeRecord(raw: unknown): ManagedWorktreeSummaryView | undefined {
  const rec = asObj(raw)
  if (rec === undefined) return undefined
  const id = asNonEmptyStr(rec['id'])
  const nodeId = asNonEmptyStr(rec['nodeId'])
  const path = asNonEmptyStr(rec['path'])
  const branch = asNonEmptyStr(rec['branch'])
  const status = rec['status'] ?? 'active'
  if (id === undefined || nodeId === undefined || path === undefined || branch === undefined) return undefined
  if (status !== 'active' && status !== 'removed') return undefined
  const baseCommit = typeof rec['baseCommit'] === 'string' ? rec['baseCommit'] : ''
  const repoRoot = typeof rec['repoRoot'] === 'string' ? rec['repoRoot'] : ''
  const parentConversationId = typeof rec['parentConversationId'] === 'number' ? rec['parentConversationId'] : 0
  const conversationId = typeof rec['conversationId'] === 'number' ? rec['conversationId'] : undefined
  const createdAt = typeof rec['createdAt'] === 'number' ? rec['createdAt'] : 0
  const baseBranch = asNonEmptyStr(rec['baseBranch'])
  const holdObj = asObj(rec['hold'])
  const hold =
    holdObj !== undefined &&
    asNonEmptyStr(holdObj['pluginId']) !== undefined &&
    asNonEmptyStr(holdObj['holdId']) !== undefined &&
    asNonEmptyStr(holdObj['label']) !== undefined &&
    typeof holdObj['acquiredAt'] === 'number'
      ? {
          pluginId: holdObj['pluginId'] as string,
          holdId: holdObj['holdId'] as string,
          label: holdObj['label'] as string,
          acquiredAt: holdObj['acquiredAt'],
        }
      : undefined

  return {
    id,
    nodeId,
    repoRoot,
    path,
    branch,
    baseCommit,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    parentConversationId,
    ...(conversationId !== undefined ? { conversationId } : {}),
    status,
    createdAt,
    ...(hold !== undefined ? { hold } : {}),
  }
}

export function parseWorktreeListResult(raw: unknown): ManagedWorktreeSummaryView[] {
  const obj = asObj(raw)
  if (obj === undefined || !Array.isArray(obj['worktrees'])) return []
  const items: ManagedWorktreeSummaryView[] = []
  for (const item of obj['worktrees']) {
    const parsed = parseWorktreeRecord(item)
    if (parsed !== undefined) items.push(parsed)
  }
  return items
}

export function parseWorktreeInspectResult(raw: unknown): WorktreeInspectView | undefined {
  const o = asObj(raw)
  if (o === undefined) return undefined
  const record = parseWorktreeRecord(o['record'])
  if (record === undefined) return undefined
  if (typeof o['exists'] !== 'boolean') return undefined
  if (typeof o['commitsTruncated'] !== 'boolean' || typeof o['filesTruncated'] !== 'boolean') return undefined
  const scope = o['scope']
  if (typeof scope !== 'string' || !VALID_WORKTREE_SCOPES.has(scope as WorktreeDiffScope)) return undefined
  const diffBase = o['diffBase']
  if (typeof diffBase !== 'string' || !VALID_DIFF_BASES.has(diffBase)) return undefined
  const summary = parseSummary(o['summary'])
  const files = parseFileEntries(o['files'])
  const commits = parseCommitEntries(o['commits'])
  if (summary === undefined || files === undefined || commits === undefined) return undefined
  const unavailableReason = asNonEmptyStr(o['unavailableReason'])
  if (unavailableReason !== undefined && unavailableReason !== 'removed' && unavailableReason !== 'directory_missing') {
    return undefined
  }
  const commitsAhead = o['commitsAhead'] !== undefined ? asNonNegInt(o['commitsAhead']) : undefined
  if (o['commitsAhead'] !== undefined && commitsAhead === undefined) return undefined
  const unmergedCommits = o['unmergedCommits'] !== undefined ? asNonNegInt(o['unmergedCommits']) : undefined
  if (o['unmergedCommits'] !== undefined && unmergedCommits === undefined) return undefined

  return {
    record,
    exists: o['exists'],
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    ...(asNonEmptyStr(o['currentBranch']) !== undefined ? { currentBranch: asNonEmptyStr(o['currentBranch']) } : {}),
    ...(asNonEmptyStr(o['currentHead']) !== undefined ? { currentHead: asNonEmptyStr(o['currentHead']) } : {}),
    ...(o['branchChanged'] === true ? { branchChanged: true } : {}),
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    ...(unmergedCommits !== undefined ? { unmergedCommits } : {}),
    diffBase: diffBase as WorktreeInspectView['diffBase'],
    scope: scope as WorktreeDiffScope,
    ...(asNonEmptyStr(o['selectedCommit']) !== undefined ? { selectedCommit: asNonEmptyStr(o['selectedCommit']) } : {}),
    commits,
    commitsTruncated: o['commitsTruncated'],
    summary,
    files,
    filesTruncated: o['filesTruncated'],
  }
}

export function parseWorkspaceInspectResult(raw: unknown): WorkspaceInspectResult | undefined {
  const o = asObj(raw)
  if (o === undefined) return undefined
  if (typeof o['isGitRepo'] !== 'boolean') return undefined
  const nodeId = asNonEmptyStr(o['nodeId'])
  const cwd = typeof o['cwd'] === 'string' ? o['cwd'] : undefined
  if (nodeId === undefined || cwd === undefined) return undefined

  if (!o['isGitRepo']) {
    const reason = o['nonGitReason']
    if (reason !== 'not_a_git_repo' && reason !== 'bare_repository') return undefined
    return { isGitRepo: false, nodeId, cwd, nonGitReason: reason }
  }

  const repoRoot = asNonEmptyStr(o['repoRoot'])
  const currentBranch = asNonEmptyStr(o['currentBranch'])
  const scope = o['scope']
  const diffBase = o['diffBase']
  if (
    repoRoot === undefined ||
    currentBranch === undefined ||
    typeof scope !== 'string' ||
    !VALID_WORKSPACE_SCOPES.has(scope as WorkspaceDiffScope) ||
    typeof diffBase !== 'string' ||
    !VALID_DIFF_BASES.has(diffBase) ||
    typeof o['commitsTruncated'] !== 'boolean' ||
    typeof o['filesTruncated'] !== 'boolean'
  ) {
    return undefined
  }
  const summary = parseSummary(o['summary'])
  const files = parseFileEntries(o['files'])
  const commits = parseCommitEntries(o['commits'])
  if (summary === undefined || files === undefined || commits === undefined) return undefined

  return {
    isGitRepo: true,
    nodeId,
    cwd,
    repoRoot,
    currentBranch,
    ...(asNonEmptyStr(o['currentHead']) !== undefined ? { currentHead: asNonEmptyStr(o['currentHead']) } : {}),
    ...(asNonEmptyStr(o['upstream']) !== undefined ? { upstream: asNonEmptyStr(o['upstream']) } : {}),
    ...(asNonNegInt(o['commitsAheadOfUpstream']) !== undefined
      ? { commitsAheadOfUpstream: asNonNegInt(o['commitsAheadOfUpstream']) }
      : {}),
    ...(asNonNegInt(o['commitsBehindUpstream']) !== undefined
      ? { commitsBehindUpstream: asNonNegInt(o['commitsBehindUpstream']) }
      : {}),
    scope: scope as WorkspaceDiffScope,
    diffBase: diffBase as Extract<WorkspaceInspectResult, { isGitRepo: true }>['diffBase'],
    ...(asNonEmptyStr(o['selectedCommit']) !== undefined ? { selectedCommit: asNonEmptyStr(o['selectedCommit']) } : {}),
    ...(asNonEmptyStr(o['baseCommit']) !== undefined ? { baseCommit: asNonEmptyStr(o['baseCommit']) } : {}),
    commits,
    commitsTruncated: o['commitsTruncated'],
    summary,
    files,
    filesTruncated: o['filesTruncated'],
  }
}

export function parseGitDiffFileResult(raw: unknown): GitDiffFileResult | undefined {
  const o = asObj(raw)
  if (o === undefined) return undefined
  const kind = o['kind']
  const filePath = typeof o['filePath'] === 'string' && o['filePath'] !== '' ? o['filePath'] : undefined
  if (filePath === undefined) return undefined
  const oldPath = typeof o['oldPath'] === 'string' && o['oldPath'] !== '' ? o['oldPath'] : undefined

  if (kind === 'unchanged' || kind === 'absent') {
    return { kind, filePath }
  }
  if (kind === 'special_file') {
    const fileKind = asNonEmptyStr(o['fileKind'])
    if (fileKind === undefined) return undefined
    return { kind: 'special_file', filePath, fileKind }
  }

  const status = typeof o['status'] === 'string' && VALID_FILE_STATUSES.has(o['status'] as GitDiffFileStatus)
    ? (o['status'] as GitDiffFileStatus)
    : undefined
  if (status === undefined) return undefined

  if (kind === 'binary') {
    const size = o['size'] !== undefined ? asNonNegInt(o['size']) : undefined
    return { kind: 'binary', filePath, ...(oldPath !== undefined ? { oldPath } : {}), status, ...(size !== undefined ? { size } : {}) }
  }

  const additions = asNonNegInt(o['additions'])
  const deletions = asNonNegInt(o['deletions'])
  if (additions === undefined || deletions === undefined) return undefined

  if (kind === 'too_large') {
    const reason = o['reason']
    if (reason !== 'line_budget_exceeded' && reason !== 'byte_limit_exceeded') return undefined
    const size = o['size'] !== undefined ? asNonNegInt(o['size']) : undefined
    return {
      kind: 'too_large',
      filePath,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      reason,
      additions,
      deletions,
      ...(size !== undefined ? { size } : {}),
    }
  }

  if (kind === 'diff' || kind === 'untracked') {
    if (!Array.isArray(o['hunks'])) return undefined
    const hunks: GitDiffHunk[] = []
    for (const h of o['hunks']) {
      const ho = asObj(h)
      if (ho === undefined || !Array.isArray(ho['rows'])) return undefined
      const oldStart = asNonNegInt(ho['oldStart'])
      const oldLines = asNonNegInt(ho['oldLines'])
      const newStart = asNonNegInt(ho['newStart'])
      const newLines = asNonNegInt(ho['newLines'])
      if (
        oldStart === undefined ||
        oldLines === undefined ||
        newStart === undefined ||
        newLines === undefined ||
        typeof ho['header'] !== 'string'
      ) {
        return undefined
      }
      const rows: GitDiffHunkRow[] = []
      for (const r of ho['rows']) {
        const ro = asObj(r)
        if (ro === undefined) return undefined
        const rowKind = ro['kind']
        if ((rowKind !== 'add' && rowKind !== 'remove' && rowKind !== 'context') || typeof ro['text'] !== 'string') {
          return undefined
        }
        const oldLine = ro['oldLine'] !== undefined ? asNonNegInt(ro['oldLine']) : undefined
        const newLine = ro['newLine'] !== undefined ? asNonNegInt(ro['newLine']) : undefined
        rows.push({
          kind: rowKind,
          ...(oldLine !== undefined ? { oldLine } : {}),
          ...(newLine !== undefined ? { newLine } : {}),
          text: ro['text'],
        })
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, header: ho['header'], rows })
    }
    return {
      kind,
      filePath,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status,
      additions,
      deletions,
      hunks,
    }
  }
  return undefined
}

/** Build declarative `screen:builtin:changes/inspector?...` target string (omitting empty params). */
export function buildChangesScreenTarget(params: {
  wt?: string
  conv?: number
  scope?: string
  commit?: string
  base?: string
  file?: string
}): string {
  const pairs: Array<[string, string]> = []
  if (params.wt !== undefined && params.wt.trim() !== '') pairs.push(['wt', params.wt.trim()])
  if (params.conv !== undefined && Number.isSafeInteger(params.conv) && params.conv > 0) {
    pairs.push(['conv', String(params.conv)])
  }
  if (params.scope !== undefined && params.scope.trim() !== '') pairs.push(['scope', params.scope.trim()])
  if (params.commit !== undefined && params.commit.trim() !== '') pairs.push(['commit', params.commit.trim()])
  if (params.base !== undefined && params.base.trim() !== '') pairs.push(['base', params.base.trim()])
  if (params.file !== undefined && params.file.trim() !== '') pairs.push(['file', params.file.trim()])
  const base = `screen:${CHANGES_PLUGIN_ID}/${CHANGES_SCREEN_ID}`
  if (pairs.length === 0) return base
  return `${base}?${new URLSearchParams(pairs).toString()}`
}

export function splitFilePath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return { dir: '', name: path }
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) }
}

export function filterFiles(files: readonly GitDiffFileEntry[], query: string): GitDiffFileEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...files]
  return files.filter(
    (f) => f.path.toLowerCase().includes(q) || (f.oldPath !== undefined && f.oldPath.toLowerCase().includes(q)),
  )
}

function tokenizeLine(line: string): string[] {
  return line.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? []
}

function mergeSegments(segments: WordSegment[]): WordSegment[] {
  const merged: WordSegment[] = []
  for (const seg of segments) {
    if (seg.text === '') continue
    const last = merged.at(-1)
    if (last !== undefined && last.changed === seg.changed) {
      last.text += seg.text
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

/**
 * Compute bounded word-level diff segments for an isolated remove+add line pair.
 * Guarantees exact text reconstruction and skips huge/complex lines cleanly.
 */
export function computeWordDiffSegments(
  oldLine: string,
  newLine: string,
): { oldSegments: WordSegment[]; newSegments: WordSegment[] } | undefined {
  if (oldLine.length > WORD_DIFF_MAX_LINE_CHARS || newLine.length > WORD_DIFF_MAX_LINE_CHARS) {
    return undefined
  }
  const a = tokenizeLine(oldLine)
  const b = tokenizeLine(newLine)
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0 || m * n > WORD_DIFF_MAX_CELLS) return undefined

  const dp = new Uint16Array((m + 1) * (n + 1))
  const width = n + 1
  for (let i = m - 1; i >= 0; i -= 1) {
    const rowOffset = i * width
    const nextRowOffset = (i + 1) * width
    const ai = a[i]!
    for (let j = n - 1; j >= 0; j -= 1) {
      if (ai === b[j]!) {
        dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1
      } else {
        const down = dp[nextRowOffset + j]!
        const right = dp[rowOffset + j + 1]!
        dp[rowOffset + j] = down >= right ? down : right
      }
    }
  }

  const oldSegs: WordSegment[] = []
  const newSegs: WordSegment[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i]! === b[j]!) {
      oldSegs.push({ text: a[i]!, changed: false })
      newSegs.push({ text: b[j]!, changed: false })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      oldSegs.push({ text: a[i]!, changed: true })
      i += 1
    } else {
      newSegs.push({ text: b[j]!, changed: true })
      j += 1
    }
  }
  while (i < m) {
    oldSegs.push({ text: a[i]!, changed: true })
    i += 1
  }
  while (j < n) {
    newSegs.push({ text: b[j]!, changed: true })
    j += 1
  }

  return {
    oldSegments: mergeSegments(oldSegs),
    newSegments: mergeSegments(newSegs),
  }
}

export function decorateHunksWithWordDiff(hunks: readonly GitDiffHunk[]): DecoratedHunk[] {
  return hunks.map((hunk) => {
    const rows: DecoratedHunkRow[] = hunk.rows.map((r) => ({ ...r }))
    for (let i = 0; i < rows.length - 1; i += 1) {
      const cur = rows[i]!
      const nxt = rows[i + 1]!
      if (cur.kind !== 'remove' || nxt.kind !== 'add') continue
      if (rows[i - 1]?.kind === 'remove' || rows[i + 2]?.kind === 'add') continue
      const word = computeWordDiffSegments(cur.text, nxt.text)
      if (word !== undefined) {
        cur.word = word.oldSegments
        nxt.word = word.newSegments
      }
    }
    return { ...hunk, rows }
  })
}

export function formatInspectGitCommand(params: {
  filePath: string
  diffBase: 'baseCommit' | 'HEAD' | 'upstream' | 'commit'
  baseCommit?: string
  selectedCommit?: string
}): string {
  const quoted = JSON.stringify(params.filePath)
  if (params.diffBase === 'commit' && params.selectedCommit !== undefined) {
    return `git show ${params.selectedCommit.slice(0, 12)} -- ${quoted}`
  }
  if (params.diffBase === 'upstream') {
    return `git diff @{upstream}..HEAD -- ${quoted}`
  }
  if (params.diffBase === 'baseCommit' && params.baseCommit !== undefined && params.baseCommit !== '') {
    return `git diff ${params.baseCommit.slice(0, 12)} -- ${quoted}`
  }
  return `git diff HEAD -- ${quoted}`
}
