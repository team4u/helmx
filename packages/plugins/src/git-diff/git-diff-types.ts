/**
 * Browser-safe DTO types shared across git-diff probes, `builtin:worktree`,
 * `builtin:changes`, and plugin client UIs. Zero Node/SDK imports.
 */

export type GitDiffFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U'

export type WorktreeDiffScope = 'all' | 'committed' | 'uncommitted'

export type WorkspaceDiffScope = 'working' | 'unpushed' | 'commit' | 'since'

export interface GitDiffFileEntry {
  path: string
  oldPath?: string
  status: GitDiffFileStatus
  additions: number
  deletions: number
  binary: boolean
  untracked: boolean
}

export interface GitDiffCommitEntry {
  oid: string
  shortOid: string
  subject: string
  author: string
  committedAt: number
  unpushed?: boolean
}

export interface GitDiffSummary {
  totalFiles: number
  additions: number
  deletions: number
  untrackedCount: number
  dirtyFileCount: number
}

export interface GitDiffHunkRow {
  kind: 'add' | 'remove' | 'context'
  oldLine?: number
  newLine?: number
  text: string
}

export interface GitDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
  rows: GitDiffHunkRow[]
}

export type GitDiffFileResult =
  | {
      kind: 'diff' | 'untracked'
      filePath: string
      oldPath?: string
      status: GitDiffFileStatus
      additions: number
      deletions: number
      hunks: GitDiffHunk[]
    }
  | {
      kind: 'binary'
      filePath: string
      oldPath?: string
      status: GitDiffFileStatus
      size?: number
    }
  | {
      kind: 'too_large'
      filePath: string
      oldPath?: string
      status: GitDiffFileStatus
      reason: 'line_budget_exceeded' | 'byte_limit_exceeded'
      additions: number
      deletions: number
      size?: number
    }
  | {
      kind: 'special_file'
      filePath: string
      fileKind: string
    }
  | {
      kind: 'unchanged' | 'absent'
      filePath: string
    }

export type WorkspaceInspectResult =
  | {
      isGitRepo: false
      nodeId: string
      cwd: string
      nonGitReason: 'not_a_git_repo' | 'bare_repository'
    }
  | {
      isGitRepo: true
      nodeId: string
      cwd: string
      repoRoot: string
      currentBranch: string
      currentHead?: string
      upstream?: string
      commitsAheadOfUpstream?: number
      commitsBehindUpstream?: number
      scope: WorkspaceDiffScope
      diffBase: 'HEAD' | 'upstream' | 'commit' | 'baseCommit'
      selectedCommit?: string
      baseCommit?: string
      commits: GitDiffCommitEntry[]
      commitsTruncated: boolean
      summary: GitDiffSummary
      files: GitDiffFileEntry[]
      filesTruncated: boolean
    }
