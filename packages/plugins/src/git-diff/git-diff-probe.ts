/**
 * Shared read-only Git probe engine for `builtin:worktree` and `builtin:changes`.
 *
 * Design invariants:
 * - Never executes unbounded full-repo `git diff` (immune to 1 MiB shell output cap).
 * - Summary probes use `-z` metadata (`status --porcelain=v2`, `--numstat`, `--name-status`, `git log`).
 * - Single-file probes pre-check `--numstat`, enforce line/byte budgets, read untracked files via
 *   TOCTOU-safe `readFileBounded`, and return explicit `too_large` / `binary` / `special_file`
 *   outcomes instead of failing the entire view.
 * - All user-provided paths and commits are strictly validated and passed after `--`.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { HelmxError, pathRulesForShape, targetPathShape } from '@helmx/protocol'
import { readFileBounded } from '../bounded-file-reader.js'
import {
  mergeDiffFileEntries,
  parseGitLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2Z,
  parseUnifiedDiffHunks,
  validateGitCommitSha,
  validateRelativeGitPath,
} from './git-diff-parser.js'
import type {
  GitDiffCommitEntry,
  GitDiffFileEntry,
  GitDiffFileResult,
  GitDiffFileStatus,
  GitDiffHunk,
  GitDiffSummary,
  WorkspaceDiffScope,
  WorktreeDiffScope,
} from './git-diff-types.js'

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const MAX_SUMMARY_FILES = 500
export const MAX_WORKTREE_COMMITS = 50
export const MAX_WORKSPACE_COMMITS = 30
export const MAX_FILE_DIFF_LINES = 4_000
export const MAX_FILE_DIFF_BYTES = 256 * 1024
const DEFAULT_CONTEXT_LINES = 3
const MAX_CONTEXT_LINES = 20
const GIT_PROBE_TIMEOUT_MS = 120_000
const DIAG_LIMIT = 2_000

export interface GitDiffExecResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
}

export interface GitDiffNodePorts {
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<GitDiffExecResult>
  executionEnv: (nodeId: string, cwd: string) => ExecutionEnv
  redact: (text: string) => string
}

export type ProbeRepoRootResult =
  | { isGitRepo: true; repoRoot: string }
  | { isGitRepo: false; nonGitReason: 'not_a_git_repo' | 'bare_repository' }

export interface ProbeSummaryResult {
  currentBranch: string
  currentHead?: string
  upstream?: string
  commitsAheadOfUpstream?: number
  commitsBehindUpstream?: number
  commitsAhead?: number
  diffBase: 'baseCommit' | 'HEAD' | 'upstream' | 'commit'
  selectedCommit?: string
  baseCommit?: string
  commits: GitDiffCommitEntry[]
  commitsTruncated: boolean
  summary: GitDiffSummary
  files: GitDiffFileEntry[]
  filesTruncated: boolean
}

function isOutputLimitError(output: string): boolean {
  return output.includes('output_limit_exceeded')
}

function normalizeContextLines(contextLines?: number): number {
  if (contextLines === undefined) return DEFAULT_CONTEXT_LINES
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > MAX_CONTEXT_LINES) {
    throw new HelmxError(
      'validation_error',
      `contextLines must be an integer in [0, ${MAX_CONTEXT_LINES}]`,
      400,
      { contextLines },
    )
  }
  return contextLines
}

function probeError(
  ports: Pick<GitDiffNodePorts, 'redact'>,
  nodeId: string,
  repoRoot: string,
  gitSubcommand: string,
  output: string,
): HelmxError {
  const diag = ports.redact(output.trim()).slice(0, DIAG_LIMIT)
  return new HelmxError(
    'changes_probe_failed',
    `节点 ${nodeId} 执行 git ${gitSubcommand} 失败（工作区 '${ports.redact(repoRoot)}'）：\n${diag}`,
    502,
    { nodeId, path: ports.redact(repoRoot), output: diag },
  )
}

async function runGit(
  ports: GitDiffNodePorts,
  nodeId: string,
  repoRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitDiffExecResult> {
  return ports.exec(nodeId, repoRoot, ['git', '-C', repoRoot, ...args], {
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  })
}

async function runGitOrThrow(
  ports: GitDiffNodePorts,
  nodeId: string,
  repoRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const res = await runGit(ports, nodeId, repoRoot, args, signal)
  if (!res.ok || res.exitCode !== 0 || res.timedOut) {
    const out = res.timedOut && !res.output.includes('timeout') ? `${res.output}\n[git timeout]` : res.output
    throw probeError(ports, nodeId, repoRoot, args[0] ?? 'command', out)
  }
  return res.output
}

function joinRepoPath(repoRoot: string, relPosixPath: string): string {
  const shape = targetPathShape(repoRoot)
  return pathRulesForShape(shape).join(repoRoot, ...relPosixPath.split('/'))
}

function redactFileEntry(entry: GitDiffFileEntry, redact: (s: string) => string): GitDiffFileEntry {
  return {
    ...entry,
    path: redact(entry.path),
    ...(entry.oldPath !== undefined ? { oldPath: redact(entry.oldPath) } : {}),
  }
}

function redactCommitEntry(entry: GitDiffCommitEntry, redact: (s: string) => string): GitDiffCommitEntry {
  return {
    ...entry,
    subject: redact(entry.subject),
    author: redact(entry.author),
  }
}

function redactHunk(hunk: GitDiffHunk, redact: (s: string) => string): GitDiffHunk {
  return {
    ...hunk,
    header: redact(hunk.header),
    rows: hunk.rows.map((row) => ({
      ...row,
      text: redact(row.text),
    })),
  }
}

/** Probe whether `(nodeId, cwd)` is inside a non-bare Git worktree; fails closed on offline/unexpected errors. */
export async function probeRepoRoot(
  ports: GitDiffNodePorts,
  nodeId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProbeRepoRootResult> {
  const rev = await runGit(
    ports,
    nodeId,
    cwd,
    ['rev-parse', '--path-format=absolute', '--is-bare-repository', '--show-toplevel'],
    signal,
  )
  if (!rev.ok || rev.exitCode !== 0 || rev.timedOut) {
    const lower = rev.output.toLowerCase()
    if (lower.includes('not a git repository')) {
      return { isGitRepo: false, nonGitReason: 'not_a_git_repo' }
    }
    const firstLine = rev.output.replace(/\r\n/g, '\n').split('\n')[0]?.trim()
    let isBare = firstLine === 'true'
    if (!isBare) {
      const bare = await runGit(ports, nodeId, cwd, ['rev-parse', '--is-bare-repository'], signal)
      isBare = bare.ok && bare.exitCode === 0 && bare.output.trim() === 'true'
    }
    if (isBare) {
      return { isGitRepo: false, nonGitReason: 'bare_repository' }
    }
    throw probeError(ports, nodeId, cwd, 'rev-parse', rev.output)
  }
  const lines = rev.output.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const [bareFlag = '', toplevel = ''] = lines
  if (bareFlag.trim() === 'true') {
    return { isGitRepo: false, nonGitReason: 'bare_repository' }
  }
  if (lines.length < 2 || toplevel.trim() === '') {
    throw probeError(ports, nodeId, cwd, 'rev-parse', rev.output)
  }
  return { isGitRepo: true, repoRoot: toplevel.trim() }
}

interface ResolvedDiffTarget {
  diffArgs: string[]
  includeUntracked: boolean
  diffBase: 'baseCommit' | 'HEAD' | 'upstream' | 'commit'
  selectedCommit?: string
  baseCommit?: string
  emptyResult: boolean
}

function resolveWorktreeDiffTarget(params: {
  scope: WorktreeDiffScope
  headOid: string
  baseCommit?: string
  commit?: string
}): ResolvedDiffTarget {
  const safeBase = params.baseCommit !== undefined && params.baseCommit !== ''
    ? validateGitCommitSha(params.baseCommit, 'baseCommit')
    : undefined

  if (params.commit !== undefined) {
    const safeCommit = validateGitCommitSha(params.commit, 'commit')
    return {
      diffArgs: ['show', '--format=', '--root', '-m', '--first-parent', '--no-ext-diff', '--no-textconv', '--find-renames', safeCommit],
      includeUntracked: false,
      diffBase: 'commit',
      selectedCommit: safeCommit,
      ...(safeBase !== undefined ? { baseCommit: safeBase } : {}),
      emptyResult: false,
    }
  }

  if (params.scope === 'committed') {
    if (safeBase === undefined || params.headOid === '') {
      return {
        diffArgs: [],
        includeUntracked: false,
        diffBase: 'baseCommit',
        ...(safeBase !== undefined ? { baseCommit: safeBase } : {}),
        emptyResult: true,
      }
    }
    return {
      diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', `${safeBase}..${params.headOid}`],
      includeUntracked: false,
      diffBase: 'baseCommit',
      baseCommit: safeBase,
      emptyResult: false,
    }
  }

  if (params.scope === 'uncommitted') {
    const ref = params.headOid !== '' ? 'HEAD' : EMPTY_TREE_SHA
    return {
      diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', ref],
      includeUntracked: true,
      diffBase: safeBase !== undefined ? 'baseCommit' : 'HEAD',
      ...(safeBase !== undefined ? { baseCommit: safeBase } : {}),
      emptyResult: false,
    }
  }

  // scope === 'all'
  const ref = safeBase ?? (params.headOid !== '' ? 'HEAD' : EMPTY_TREE_SHA)
  return {
    diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', ref],
    includeUntracked: true,
    diffBase: safeBase !== undefined ? 'baseCommit' : 'HEAD',
    ...(safeBase !== undefined ? { baseCommit: safeBase } : {}),
    emptyResult: false,
  }
}

function resolveWorkspaceDiffTarget(params: {
  scope: WorkspaceDiffScope
  headOid: string
  upstream?: string
  ahead?: number
  commit?: string
  baseCommit?: string
}): ResolvedDiffTarget {
  if (params.scope === 'unpushed') {
    if (params.upstream === undefined || (params.ahead ?? 0) <= 0 || params.headOid === '') {
      return {
        diffArgs: [],
        includeUntracked: false,
        diffBase: 'upstream',
        emptyResult: true,
      }
    }
    return {
      diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '@{upstream}..HEAD'],
      includeUntracked: false,
      diffBase: 'upstream',
      emptyResult: false,
    }
  }

  if (params.scope === 'commit') {
    const targetCommit = params.commit !== undefined
      ? validateGitCommitSha(params.commit, 'commit')
      : params.headOid !== ''
        ? validateGitCommitSha(params.headOid, 'HEAD')
        : undefined
    if (targetCommit === undefined) {
      return {
        diffArgs: [],
        includeUntracked: false,
        diffBase: 'commit',
        emptyResult: true,
      }
    }
    return {
      diffArgs: ['show', '--format=', '--root', '-m', '--first-parent', '--no-ext-diff', '--no-textconv', '--find-renames', targetCommit],
      includeUntracked: false,
      diffBase: 'commit',
      selectedCommit: targetCommit,
      emptyResult: false,
    }
  }

  if (params.scope === 'since') {
    const safeBase = validateGitCommitSha(params.baseCommit, 'baseCommit')
    return {
      diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', safeBase],
      includeUntracked: true,
      diffBase: 'baseCommit',
      baseCommit: safeBase,
      emptyResult: false,
    }
  }

  // scope === 'working'
  const ref = params.headOid !== '' ? 'HEAD' : EMPTY_TREE_SHA
  return {
    diffArgs: ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', ref],
    includeUntracked: true,
    diffBase: 'HEAD',
    emptyResult: false,
  }
}

export type ProbeSummaryOptions =
  | {
      mode: 'worktree'
      nodeId: string
      repoRoot: string
      scope: WorktreeDiffScope
      baseCommit?: string
      commit?: string
      signal?: AbortSignal
    }
  | {
      mode: 'workspace'
      nodeId: string
      repoRoot: string
      scope: WorkspaceDiffScope
      commit?: string
      baseCommit?: string
      signal?: AbortSignal
    }

/**
 * Lightweight structured summary probe (status + `--numstat -z` + `--name-status -z` + bounded `git log`).
 * Never runs unbounded full `git diff`.
 */
export async function probeGitSummary(ports: GitDiffNodePorts, options: ProbeSummaryOptions): Promise<ProbeSummaryResult> {
  const { nodeId, repoRoot, signal } = options
  const statusOut = await runGitOrThrow(
    ports,
    nodeId,
    repoRoot,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    signal,
  )
  const status = parsePorcelainV2Z(statusOut)
  if (status.oid !== '' && !/^[0-9a-f]{7,64}$/i.test(status.oid)) {
    throw probeError(ports, nodeId, repoRoot, 'status', `invalid branch.oid ${status.oid}`)
  }

  const target =
    options.mode === 'worktree'
      ? resolveWorktreeDiffTarget({
          scope: options.scope,
          headOid: status.oid,
          baseCommit: options.baseCommit,
          commit: options.commit,
        })
      : resolveWorkspaceDiffTarget({
          scope: options.scope,
          headOid: status.oid,
          upstream: status.upstream,
          ahead: status.ahead,
          commit: options.commit,
          baseCommit: options.baseCommit,
        })

  const maxCommits = options.mode === 'worktree' ? MAX_WORKTREE_COMMITS : MAX_WORKSPACE_COMMITS
  const logRange =
    options.mode === 'worktree'
      ? options.baseCommit !== undefined && options.baseCommit !== '' && status.oid !== ''
        ? `${validateGitCommitSha(options.baseCommit, 'baseCommit')}..${status.oid}`
        : undefined
      : status.oid !== ''
        ? 'HEAD'
        : undefined

  const [numstatOut, nameStatusOut, logOut, unpushedOut, aheadOut] = await Promise.all([
    target.emptyResult
      ? Promise.resolve('')
      : runGitOrThrow(ports, nodeId, repoRoot, [...target.diffArgs, '--numstat', '-z'], signal),
    target.emptyResult
      ? Promise.resolve('')
      : runGitOrThrow(ports, nodeId, repoRoot, [...target.diffArgs, '--name-status', '-z'], signal),
    logRange !== undefined
      ? runGitOrThrow(
          ports,
          nodeId,
          repoRoot,
          ['log', '--no-show-signature', '-z', `--max-count=${maxCommits + 1}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct', logRange],
          signal,
        )
      : Promise.resolve(''),
    options.mode === 'workspace' && status.upstream !== undefined && (status.ahead ?? 0) > 0 && status.oid !== ''
      ? runGitOrThrow(ports, nodeId, repoRoot, ['rev-list', '--max-count=200', '@{upstream}..HEAD'], signal)
      : Promise.resolve(''),
    options.mode === 'worktree' && options.baseCommit !== undefined && options.baseCommit !== '' && status.oid !== ''
      ? runGitOrThrow(
          ports,
          nodeId,
          repoRoot,
          ['rev-list', '--count', `${validateGitCommitSha(options.baseCommit, 'baseCommit')}..${status.oid}`],
          signal,
        )
      : Promise.resolve(undefined),
  ])

  const unpushedOids = unpushedOut !== '' ? new Set(unpushedOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) : undefined
  const parsedLog = parseGitLogZ(logOut, maxCommits, unpushedOids)
  const merged = mergeDiffFileEntries(
    parseNumstatZ(numstatOut),
    parseNameStatusZ(nameStatusOut),
    target.includeUntracked ? status.untrackedPaths : [],
    status.dirtyFileCount,
    MAX_SUMMARY_FILES,
  )

  const commitsAhead =
    aheadOut !== undefined ? Number.parseInt(aheadOut.trim(), 10) : undefined
  if (aheadOut !== undefined && (commitsAhead === undefined || !Number.isFinite(commitsAhead))) {
    throw probeError(ports, nodeId, repoRoot, 'rev-list', aheadOut)
  }

  return {
    currentBranch: ports.redact(status.branch),
    ...(status.oid !== '' ? { currentHead: ports.redact(status.oid) } : {}),
    ...(status.upstream !== undefined ? { upstream: ports.redact(status.upstream) } : {}),
    ...(status.ahead !== undefined ? { commitsAheadOfUpstream: status.ahead } : {}),
    ...(status.behind !== undefined ? { commitsBehindUpstream: status.behind } : {}),
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    diffBase: target.diffBase,
    ...(target.selectedCommit !== undefined ? { selectedCommit: target.selectedCommit } : {}),
    ...(target.baseCommit !== undefined ? { baseCommit: target.baseCommit } : {}),
    commits: parsedLog.commits.map((c) => redactCommitEntry(c, ports.redact)),
    commitsTruncated: parsedLog.commitsTruncated,
    summary: merged.summary,
    files: merged.files.map((f) => redactFileEntry(f, ports.redact)),
    filesTruncated: merged.filesTruncated,
  }
}

export type ProbeFileOptions = (
  | {
      mode: 'worktree'
      scope: WorktreeDiffScope
      baseCommit?: string
      commit?: string
    }
  | {
      mode: 'workspace'
      scope: WorkspaceDiffScope
      commit?: string
      baseCommit?: string
    }
) & {
  nodeId: string
  repoRoot: string
  filePath: string
  oldPath?: string
  contextLines?: number
  signal?: AbortSignal
}

async function probeUntrackedFile(
  ports: GitDiffNodePorts,
  nodeId: string,
  repoRoot: string,
  filePath: string,
): Promise<GitDiffFileResult> {
  const env = ports.executionEnv(nodeId, repoRoot)
  const rootCanonical = await env.canonicalPath(repoRoot, BACKGROUND_CONTEXT)
  if (!rootCanonical.ok) {
    throw probeError(ports, nodeId, repoRoot, 'canonicalPath', `${rootCanonical.error.code}: ${rootCanonical.error.message}`)
  }
  const absPath = joinRepoPath(repoRoot, filePath)
  const read = await readFileBounded(env, absPath, {
    maxBytes: MAX_FILE_DIFF_BYTES,
    withinDir: rootCanonical.value,
    rejectBinary: true,
  })
  if (read.kind === 'absent') {
    return { kind: 'absent', filePath: ports.redact(filePath) }
  }
  if (read.kind === 'refused') {
    const f = read.failure
    if (f.stage === 'outside_dir') {
      return { kind: 'special_file', filePath: ports.redact(filePath), fileKind: 'symlink_outside_repo' }
    }
    if (f.stage === 'not_regular_file') {
      return { kind: 'special_file', filePath: ports.redact(filePath), fileKind: f.fileKind }
    }
    if (f.stage === 'binary_file') {
      return { kind: 'binary', filePath: ports.redact(filePath), status: 'U', size: f.size }
    }
    if (f.stage === 'size_exceeded') {
      return {
        kind: 'too_large',
        filePath: ports.redact(filePath),
        status: 'U',
        reason: 'byte_limit_exceeded',
        additions: 0,
        deletions: 0,
        size: f.size,
      }
    }
    if (f.stage === 'read_exceeded') {
      return {
        kind: 'too_large',
        filePath: ports.redact(filePath),
        status: 'U',
        reason: 'byte_limit_exceeded',
        additions: 0,
        deletions: 0,
        size: f.bytesRead,
      }
    }
    throw probeError(
      ports,
      nodeId,
      repoRoot,
      'read_untracked',
      'message' in f ? f.message : `bounded read failed (${f.stage})`,
    )
  }

  const redactedText = ports.redact(read.text)
  const lines = redactedText === '' ? [] : redactedText.split(/\r?\n/)
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (lines.length > MAX_FILE_DIFF_LINES) {
    return {
      kind: 'too_large',
      filePath: ports.redact(filePath),
      status: 'U',
      reason: 'line_budget_exceeded',
      additions: lines.length,
      deletions: 0,
    }
  }
  const hunks: GitDiffHunk[] = [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: lines.length > 0 ? 1 : 0,
      newLines: lines.length,
      header: lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@` : '@@ -0,0 +0,0 @@',
      rows: lines.map((line, index) => ({
        kind: 'add' as const,
        newLine: index + 1,
        text: line,
      })),
    },
  ]
  return {
    kind: 'untracked',
    filePath: ports.redact(filePath),
    status: 'U',
    additions: lines.length,
    deletions: 0,
    hunks,
  }
}

/**
 * Single-file on-demand diff or untracked preview probe with strict path validation and size/line budgets.
 */
export async function probeGitFileDiff(ports: GitDiffNodePorts, options: ProbeFileOptions): Promise<GitDiffFileResult> {
  const filePath = validateRelativeGitPath(options.filePath, 'filePath')
  const oldPath = options.oldPath !== undefined ? validateRelativeGitPath(options.oldPath, 'oldPath') : undefined
  const contextLines = normalizeContextLines(options.contextLines)
  const { nodeId, repoRoot, signal } = options

  const statusOut = await runGitOrThrow(
    ports,
    nodeId,
    repoRoot,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z', '--', filePath],
    signal,
  )
  const status = parsePorcelainV2Z(statusOut)
  const target =
    options.mode === 'worktree'
      ? resolveWorktreeDiffTarget({
          scope: options.scope,
          headOid: status.oid,
          baseCommit: options.baseCommit,
          commit: options.commit,
        })
      : resolveWorkspaceDiffTarget({
          scope: options.scope,
          headOid: status.oid,
          upstream: status.upstream,
          ahead: status.ahead,
          commit: options.commit,
          baseCommit: options.baseCommit,
        })

  if (target.includeUntracked && status.untrackedPaths.includes(filePath)) {
    return probeUntrackedFile(ports, nodeId, repoRoot, filePath)
  }
  if (target.emptyResult) {
    return { kind: 'unchanged', filePath: ports.redact(filePath) }
  }

  const pathspecs = oldPath !== undefined && oldPath !== filePath ? ['--', oldPath, filePath] : ['--', filePath]
  const [numstatOut, nameStatusOut] = await Promise.all([
    runGitOrThrow(ports, nodeId, repoRoot, [...target.diffArgs, '--numstat', '-z', ...pathspecs], signal),
    runGitOrThrow(ports, nodeId, repoRoot, [...target.diffArgs, '--name-status', '-z', ...pathspecs], signal),
  ])

  const numstats = parseNumstatZ(numstatOut)
  const nameStatuses = parseNameStatusZ(nameStatusOut)
  const matchedStat = numstats.find((e) => e.path === filePath) ?? numstats[0]
  const matchedNameStatus = nameStatuses.find((e) => e.path === filePath) ?? nameStatuses[0]

  if (matchedStat === undefined && matchedNameStatus === undefined) {
    return { kind: 'unchanged', filePath: ports.redact(filePath) }
  }

  const resolvedStatus: GitDiffFileStatus =
    matchedNameStatus?.status ?? (matchedStat?.oldPath !== undefined ? 'R' : 'M')
  const resolvedOldPath = matchedNameStatus?.oldPath ?? matchedStat?.oldPath ?? oldPath
  const additions = matchedStat?.additions ?? 0
  const deletions = matchedStat?.deletions ?? 0
  const redactedFile = ports.redact(filePath)
  const redactedOld = resolvedOldPath !== undefined ? ports.redact(resolvedOldPath) : undefined

  if (matchedStat?.binary === true) {
    return {
      kind: 'binary',
      filePath: redactedFile,
      ...(redactedOld !== undefined ? { oldPath: redactedOld } : {}),
      status: resolvedStatus,
    }
  }
  if (additions + deletions > MAX_FILE_DIFF_LINES) {
    return {
      kind: 'too_large',
      filePath: redactedFile,
      ...(redactedOld !== undefined ? { oldPath: redactedOld } : {}),
      status: resolvedStatus,
      reason: 'line_budget_exceeded',
      additions,
      deletions,
    }
  }

  const patchArgs = [...target.diffArgs, `-U${contextLines}`, ...pathspecs]
  const patchRes = await runGit(ports, nodeId, repoRoot, patchArgs, signal)
  if (!patchRes.ok || patchRes.exitCode !== 0 || patchRes.timedOut) {
    if (isOutputLimitError(patchRes.output)) {
      return {
        kind: 'too_large',
        filePath: redactedFile,
        ...(redactedOld !== undefined ? { oldPath: redactedOld } : {}),
        status: resolvedStatus,
        reason: 'byte_limit_exceeded',
        additions,
        deletions,
      }
    }
    const out =
      patchRes.timedOut && !patchRes.output.includes('timeout') ? `${patchRes.output}\n[git timeout]` : patchRes.output
    throw probeError(ports, nodeId, repoRoot, patchArgs[0] ?? 'diff', out)
  }

  if (Buffer.byteLength(patchRes.output, 'utf8') > MAX_FILE_DIFF_BYTES) {
    return {
      kind: 'too_large',
      filePath: redactedFile,
      ...(redactedOld !== undefined ? { oldPath: redactedOld } : {}),
      status: resolvedStatus,
      reason: 'byte_limit_exceeded',
      additions,
      deletions,
      size: Buffer.byteLength(patchRes.output, 'utf8'),
    }
  }

  const hunks = parseUnifiedDiffHunks(patchRes.output).map((h) => redactHunk(h, ports.redact))
  return {
    kind: 'diff',
    filePath: redactedFile,
    ...(redactedOld !== undefined ? { oldPath: redactedOld } : {}),
    status: resolvedStatus,
    additions,
    deletions,
    hunks,
  }
}
