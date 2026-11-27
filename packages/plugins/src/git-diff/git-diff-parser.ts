/**
 * Pure git-diff validation and `-z` / unified-diff parsers (zero Node/env side effects).
 */
import { HelmxError } from '@helmx/protocol'
import type {
  GitDiffCommitEntry,
  GitDiffFileEntry,
  GitDiffFileStatus,
  GitDiffHunk,
  GitDiffHunkRow,
  GitDiffSummary,
} from './git-diff-types.js'

export interface ParsedPorcelainV2 {
  oid: string
  branch: string
  upstream?: string
  ahead?: number
  behind?: number
  dirtyFileCount: number
  untrackedPaths: string[]
}

export interface NumstatEntry {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

export interface NameStatusEntry {
  path: string
  oldPath?: string
  status: GitDiffFileStatus
}

const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Validate a repo-relative POSIX path from client/action input; rejects absolute paths, backslashes, traversal, and control chars. */
export function validateRelativeGitPath(rawPath: unknown, fieldName = 'filePath'): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new HelmxError('validation_error', `${fieldName} must be a non-empty relative path`, 400, { fieldName })
  }
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new HelmxError('validation_error', `${fieldName} must not contain control characters`, 400, { fieldName })
  }
  if (rawPath.startsWith('/') || rawPath.includes('\\')) {
    throw new HelmxError('validation_error', `${fieldName} must be a relative POSIX path without leading "/" or "\\"`, 400, {
      fieldName,
      value: rawPath,
    })
  }
  const segments = rawPath.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new HelmxError('validation_error', `${fieldName} must not contain empty, ".", or ".." path segments`, 400, {
      fieldName,
      value: rawPath,
    })
  }
  return rawPath
}

/** Validate a commit SHA (7..64 hex chars) to prevent flag injection or arbitrary ref resolution. */
export function validateGitCommitSha(rawSha: unknown, fieldName = 'commit'): string {
  if (typeof rawSha !== 'string' || !COMMIT_SHA_RE.test(rawSha.trim())) {
    throw new HelmxError('validation_error', `${fieldName} must be a 7-64 character hexadecimal commit SHA`, 400, {
      fieldName,
    })
  }
  return rawSha.trim()
}

/** Parse `git status --porcelain=v2 --branch --untracked-files=all -z`. */
export function parsePorcelainV2Z(output: string): ParsedPorcelainV2 {
  const tokens = output.split('\0')
  let oid = ''
  let branch = 'HEAD'
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  let dirtyFileCount = 0
  const untrackedPaths: string[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '') continue
    if (token.startsWith('# ')) {
      if (token.startsWith('# branch.oid ')) {
        const val = token.slice('# branch.oid '.length).trim()
        if (val !== '' && val !== '(initial)') oid = val
      } else if (token.startsWith('# branch.head ')) {
        const val = token.slice('# branch.head '.length).trim()
        branch = val === '' || val === '(detached)' ? 'HEAD' : val
      } else if (token.startsWith('# branch.upstream ')) {
        const val = token.slice('# branch.upstream '.length).trim()
        if (val !== '') upstream = val
      } else if (token.startsWith('# branch.ab ')) {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(token.slice('# branch.ab '.length).trim())
        if (match !== null) {
          ahead = Number.parseInt(match[1]!, 10)
          behind = Number.parseInt(match[2]!, 10)
        }
      }
      continue
    }
    if (token.startsWith('? ')) {
      dirtyFileCount += 1
      const path = token.slice(2)
      if (path !== '') untrackedPaths.push(path)
      continue
    }
    if (token.startsWith('1 ') || token.startsWith('u ')) {
      dirtyFileCount += 1
      continue
    }
    if (token.startsWith('2 ')) {
      dirtyFileCount += 1
      // In `-z` mode, rename/copy entries emit `<origPath>` as the immediately following NUL token.
      i += 1
      continue
    }
  }

  return {
    oid,
    branch,
    ...(upstream !== undefined ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    dirtyFileCount,
    untrackedPaths,
  }
}

/** Parse `git diff --numstat -z --find-renames`. */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const tokens = output.split('\0')
  const entries: NumstatEntry[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '') continue
    const firstTab = token.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue

    const addStr = token.slice(0, firstTab)
    const delStr = token.slice(firstTab + 1, secondTab)
    const pathPart = token.slice(secondTab + 1)
    const binary = addStr === '-' || delStr === '-'
    const additions = binary ? 0 : Math.max(0, Number.parseInt(addStr, 10) || 0)
    const deletions = binary ? 0 : Math.max(0, Number.parseInt(delStr, 10) || 0)

    if (pathPart === '') {
      // Rename/copy in `-z` format: `<add>\t<del>\t\0<origPath>\0<newPath>\0`
      const origPath = tokens[i + 1] ?? ''
      const newPath = tokens[i + 2] ?? ''
      i += 2
      if (newPath !== '') {
        entries.push({
          path: newPath,
          ...(origPath !== '' ? { oldPath: origPath } : {}),
          additions,
          deletions,
          binary,
        })
      }
      continue
    }

    entries.push({ path: pathPart, additions, deletions, binary })
  }

  return entries
}

function normalizeGitStatusChar(rawStatus: string): GitDiffFileStatus {
  const code = rawStatus.charAt(0).toUpperCase()
  if (code === 'A' || code === 'D' || code === 'R' || code === 'C' || code === 'M') return code
  // `T` (typechange) / `U` (unmerged) / `X` map cleanly to `M` so `'U'` stays dedicated to untracked files.
  return 'M'
}

/** Parse `git diff --name-status -z --find-renames`. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0')
  const entries: NameStatusEntry[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const rawStatus = tokens[i]!
    if (rawStatus === '') continue
    const code = rawStatus.charAt(0).toUpperCase()
    if (code === 'R' || code === 'C') {
      const origPath = tokens[i + 1] ?? ''
      const newPath = tokens[i + 2] ?? ''
      i += 2
      if (newPath !== '') {
        entries.push({
          path: newPath,
          ...(origPath !== '' ? { oldPath: origPath } : {}),
          status: code,
        })
      }
      continue
    }
    const path = tokens[i + 1] ?? ''
    i += 1
    if (path !== '') {
      entries.push({ path, status: normalizeGitStatusChar(rawStatus) })
    }
  }

  return entries
}

/** Merge numstat, name-status, and untracked paths into a sorted bounded file list plus accurate full-set summary. */
export function mergeDiffFileEntries(
  numstats: readonly NumstatEntry[],
  nameStatuses: readonly NameStatusEntry[],
  untrackedPaths: readonly string[],
  dirtyFileCount: number,
  maxFiles = 500,
): {
  files: GitDiffFileEntry[]
  filesTruncated: boolean
  summary: GitDiffSummary
} {
  const byPath = new Map<string, GitDiffFileEntry>()

  for (const ns of nameStatuses) {
    byPath.set(ns.path, {
      path: ns.path,
      ...(ns.oldPath !== undefined ? { oldPath: ns.oldPath } : {}),
      status: ns.status,
      additions: 0,
      deletions: 0,
      binary: false,
      untracked: false,
    })
  }

  for (const st of numstats) {
    const existing = byPath.get(st.path)
    if (existing !== undefined) {
      existing.additions = st.additions
      existing.deletions = st.deletions
      existing.binary = st.binary
      if (existing.oldPath === undefined && st.oldPath !== undefined) {
        existing.oldPath = st.oldPath
      }
    } else {
      byPath.set(st.path, {
        path: st.path,
        ...(st.oldPath !== undefined ? { oldPath: st.oldPath } : {}),
        status: st.oldPath !== undefined ? 'R' : 'M',
        additions: st.additions,
        deletions: st.deletions,
        binary: st.binary,
        untracked: false,
      })
    }
  }

  let untrackedCount = 0
  for (const uPath of untrackedPaths) {
    untrackedCount += 1
    if (!byPath.has(uPath)) {
      byPath.set(uPath, {
        path: uPath,
        status: 'U',
        additions: 0,
        deletions: 0,
        binary: false,
        untracked: true,
      })
    }
  }

  const allFiles = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  let additions = 0
  let deletions = 0
  for (const entry of allFiles) {
    additions += entry.additions
    deletions += entry.deletions
  }

  const filesTruncated = allFiles.length > maxFiles
  const files = filesTruncated ? allFiles.slice(0, maxFiles) : allFiles

  return {
    files,
    filesTruncated,
    summary: {
      totalFiles: allFiles.length,
      additions,
      deletions,
      untrackedCount,
      dirtyFileCount,
    },
  }
}

/** Parse `git log -z --format=%H%x1f%h%x1f%s%x1f%an%x1f%ct`. */
export function parseGitLogZ(
  output: string,
  maxCommits: number,
  unpushedOids?: ReadonlySet<string>,
): { commits: GitDiffCommitEntry[]; commitsTruncated: boolean } {
  const records = output.split('\0').filter((r) => r !== '')
  const commits: GitDiffCommitEntry[] = []

  for (const rec of records) {
    const parts = rec.split('\x1f')
    if (parts.length < 5) continue
    const oid = parts[0]!.trim()
    const shortOid = parts[1]!.trim()
    const subject = parts[2] ?? ''
    const author = parts[3] ?? ''
    const epochSec = Number.parseInt(parts[4] ?? '0', 10)
    if (oid === '') continue
    if (commits.length < maxCommits) {
      commits.push({
        oid,
        shortOid: shortOid || oid.slice(0, 7),
        subject,
        author,
        committedAt: Number.isFinite(epochSec) && epochSec > 0 ? epochSec * 1000 : 0,
        ...(unpushedOids?.has(oid) ? { unpushed: true } : {}),
      })
    }
  }

  return {
    commits,
    commitsTruncated: records.length > maxCommits,
  }
}

/** Parse a single-file unified diff patch into structured hunks with real old/new line numbers. */
export function parseUnifiedDiffHunks(patch: string): GitDiffHunk[] {
  const normalized = patch.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const hunks: GitDiffHunk[] = []
  let current: GitDiffHunk | undefined
  let oldLine = 0
  let newLine = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const hunkMatch = HUNK_HEADER_RE.exec(line)
    if (hunkMatch !== null) {
      const oldStart = Number.parseInt(hunkMatch[1]!, 10)
      const oldLines = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1
      const newStart = Number.parseInt(hunkMatch[3]!, 10)
      const newLines = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1
      oldLine = oldStart
      newLine = newStart
      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line,
        rows: [],
      }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    // Ignore trailing split empty string after final newline.
    if (i === lines.length - 1 && line === '') continue
    if (line.startsWith('\\ ')) continue
    if (line.startsWith('+')) {
      const row: GitDiffHunkRow = { kind: 'add', newLine, text: line.slice(1) }
      current.rows.push(row)
      newLine += 1
    } else if (line.startsWith('-')) {
      const row: GitDiffHunkRow = { kind: 'remove', oldLine, text: line.slice(1) }
      current.rows.push(row)
      oldLine += 1
    } else if (line.startsWith(' ')) {
      const row: GitDiffHunkRow = { kind: 'context', oldLine, newLine, text: line.slice(1) }
      current.rows.push(row)
      oldLine += 1
      newLine += 1
    }
  }

  return hunks
}
