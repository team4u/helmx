/**
 * 受管 worktree 只读检视与 resume 续接校验：
 * - `inspectWorktree`：登记元数据 + 目标节点两段式轻量结构化 git 探测（`status -z` / `--numstat -z` /
 *   `--name-status -z` / 有界 `git log` + 未合入提交数，绝不跑全量 `git diff`）；
 * - `inspectWorktreeFile`：单文件按需 diff / 未跟踪文件有界安全预览；
 * - `verifyWorktreeForResume`：续接前经节点真实 fs + git 探测校验工作树仍在（探测失败与目录缺失显式区分）；
 * - `ownerMismatchError`：归属校验拒绝错误构造（`force` 不可越过）。
 */
import { HelmxError } from '@helmx/protocol'
import type {
  GitDiffFileResult,
  WorktreeDiffScope,
  WorktreeInspectResult,
} from '../contracts.js'
import {
  probeGitFileDiff,
  probeGitSummary,
  type GitDiffNodePorts,
} from '../git-diff/git-diff-probe.js'
import { validateGitCommitSha } from '../git-diff/git-diff-parser.js'
import {
  countUnmergedCommits,
  dirExistsOnNode,
  gitExec,
  resolveMergeReferenceHead,
  resolveRepoAuthority,
  type WorktreeNodePorts,
} from './worktree-git.js'
import type { ManagedWorktreeRecord, WorktreeStore } from './worktree-store.js'

export type { WorktreeInspectResult }

export interface WorktreeInspectInput {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
  scope?: WorktreeDiffScope
  commit?: string
  signal?: AbortSignal
}

export interface WorktreeInspectFileInput extends WorktreeInspectInput {
  filePath: string
  oldPath?: string
  contextLines?: number
}

const VALID_WORKTREE_SCOPES = new Set<WorktreeDiffScope>(['all', 'committed', 'uncommitted'])

function normalizeWorktreeScope(raw: unknown): WorktreeDiffScope {
  if (raw === undefined) return 'all'
  if (typeof raw !== 'string' || !VALID_WORKTREE_SCOPES.has(raw as WorktreeDiffScope)) {
    throw new HelmxError(
      'validation_error',
      `scope must be one of all | committed | uncommitted (received ${String(raw)})`,
      400,
    )
  }
  return raw as WorktreeDiffScope
}

function toGitDiffPorts(ports: WorktreeNodePorts, redact: (text: string) => string): GitDiffNodePorts {
  return {
    exec: (nodeId, cwd, args, options) => ports.exec(nodeId, cwd, args, options),
    executionEnv: (nodeId, cwd) => {
      if (ports.executionEnv === undefined) {
        throw new HelmxError('unsupported', 'executionEnv port is required to read untracked worktree files', 501)
      }
      return ports.executionEnv(nodeId, cwd)
    },
    redact,
  }
}

function rethrowAsWorktreeCheckError(record: ManagedWorktreeRecord, err: unknown): never {
  if (err instanceof HelmxError && err.code === 'changes_probe_failed') {
    throw new HelmxError(
      'worktree_check_failed',
      err.message,
      err.status,
      { worktreeId: record.id, ...(err.details ?? {}) },
    )
  }
  throw err
}

export async function inspectWorktree(
  ports: WorktreeNodePorts,
  store: WorktreeStore,
  redact: (text: string) => string,
  input: WorktreeInspectInput,
  signal?: AbortSignal,
): Promise<WorktreeInspectResult> {
  const scope = normalizeWorktreeScope(input.scope)
  const commit = input.commit !== undefined ? validateGitCommitSha(input.commit, 'commit') : undefined
  const record = store.resolveRecord(input, 'inspect')
  const fallbackDiffBase: WorktreeInspectResult['diffBase'] =
    commit !== undefined ? 'commit' : record.baseCommit !== '' && scope !== 'uncommitted' ? 'baseCommit' : 'HEAD'

  const emptySummary = {
    totalFiles: 0,
    additions: 0,
    deletions: 0,
    untrackedCount: 0,
    dirtyFileCount: 0,
  }

  if (record.status === 'removed') {
    return {
      record,
      exists: false,
      unavailableReason: 'removed',
      diffBase: fallbackDiffBase,
      scope,
      ...(commit !== undefined ? { selectedCommit: commit } : {}),
      commits: [],
      commitsTruncated: false,
      summary: emptySummary,
      files: [],
      filesTruncated: false,
    }
  }
  if (!(await dirExistsOnNode(ports, record.nodeId, record.path))) {
    return {
      record,
      exists: false,
      unavailableReason: 'directory_missing',
      diffBase: fallbackDiffBase,
      scope,
      ...(commit !== undefined ? { selectedCommit: commit } : {}),
      commits: [],
      commitsTruncated: false,
      summary: emptySummary,
      files: [],
      filesTruncated: false,
    }
  }

  const repoProbeDir = record.repoRoot !== '' ? record.repoRoot : record.path
  const diffPorts = toGitDiffPorts(ports, redact)

  const [summaryRes, repoRef] = await Promise.all([
    probeGitSummary(diffPorts, {
      mode: 'worktree',
      nodeId: record.nodeId,
      repoRoot: record.path,
      scope,
      baseCommit: record.baseCommit,
      ...(commit !== undefined ? { commit } : {}),
      signal,
    }).catch((err) => rethrowAsWorktreeCheckError(record, err)),
    (async () => {
      const authority = await resolveRepoAuthority(ports, record.nodeId, repoProbeDir, signal)
      const referenceHead = await resolveMergeReferenceHead(ports, {
        nodeId: record.nodeId,
        repoRoot: authority.mainPath,
        mainHead: authority.entries[0]!.head,
        mergedInto: undefined,
        baseBranch: record.baseBranch,
        signal,
      })
      return { authority, referenceHead }
    })(),
  ])

  const targetRef =
    summaryRes.currentBranch !== '' && summaryRes.currentBranch !== 'HEAD'
      ? summaryRes.currentBranch
      : summaryRes.currentHead
  const unmergedCommits =
    targetRef !== undefined && targetRef !== ''
      ? await countUnmergedCommits(
          ports,
          record.nodeId,
          repoRef.authority.mainPath,
          repoRef.referenceHead,
          targetRef,
          signal,
        )
      : undefined

  return {
    record,
    exists: true,
    currentBranch: summaryRes.currentBranch,
    ...(summaryRes.currentHead !== undefined ? { currentHead: summaryRes.currentHead } : {}),
    ...(summaryRes.currentBranch !== record.branch ? { branchChanged: true } : {}),
    ...(summaryRes.commitsAhead !== undefined ? { commitsAhead: summaryRes.commitsAhead } : {}),
    ...(unmergedCommits !== undefined ? { unmergedCommits } : {}),
    diffBase: summaryRes.diffBase,
    scope,
    ...(summaryRes.selectedCommit !== undefined ? { selectedCommit: summaryRes.selectedCommit } : {}),
    commits: summaryRes.commits,
    commitsTruncated: summaryRes.commitsTruncated,
    summary: summaryRes.summary,
    files: summaryRes.files,
    filesTruncated: summaryRes.filesTruncated,
  }
}

export async function inspectWorktreeFile(
  ports: WorktreeNodePorts,
  store: WorktreeStore,
  redact: (text: string) => string,
  input: WorktreeInspectFileInput,
  signal?: AbortSignal,
): Promise<GitDiffFileResult> {
  const scope = normalizeWorktreeScope(input.scope)
  const commit = input.commit !== undefined ? validateGitCommitSha(input.commit, 'commit') : undefined
  const record = store.resolveRecord(input, 'inspect')
  if (record.status === 'removed') {
    throw new HelmxError(
      'worktree_missing',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）已被清理，无法检视文件差异`,
      409,
      { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
    )
  }
  if (!(await dirExistsOnNode(ports, record.nodeId, record.path))) {
    throw new HelmxError(
      'worktree_missing',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）目录不存在，无法检视文件差异`,
      409,
      { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
    )
  }

  const diffPorts = toGitDiffPorts(ports, redact)
  return probeGitFileDiff(diffPorts, {
    mode: 'worktree',
    nodeId: record.nodeId,
    repoRoot: record.path,
    filePath: input.filePath,
    ...(input.oldPath !== undefined ? { oldPath: input.oldPath } : {}),
    scope,
    baseCommit: record.baseCommit,
    ...(commit !== undefined ? { commit } : {}),
    ...(input.contextLines !== undefined ? { contextLines: input.contextLines } : {}),
    signal,
  }).catch((err) => rethrowAsWorktreeCheckError(record, err))
}

export async function verifyWorktreeForResume(
  ports: WorktreeNodePorts,
  record: ManagedWorktreeRecord,
  explicitCwd?: string,
  signal?: AbortSignal,
): Promise<ManagedWorktreeRecord> {
  if (explicitCwd !== undefined && explicitCwd !== record.path) {
    throw new HelmxError(
      'resume_cwd_conflict',
      `子会话已绑定隔离 worktree '${record.path}'，不支持在 resume 时改写 cwd 为 '${explicitCwd}'`,
      409,
      { existingCwd: record.path, requestedCwd: explicitCwd },
    )
  }
  if (record.status === 'removed') {
    throw new HelmxError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`,
      409,
      { path: record.path, branch: record.branch },
    )
  }
  if (!(await dirExistsOnNode(ports, record.nodeId, record.path))) {
    throw new HelmxError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }
  const probe = await gitExec(
    ports,
    record.nodeId,
    record.path,
    ['-C', record.path, 'rev-parse', '--is-inside-work-tree'],
    signal,
  )
  if (!probe.ok) {
    throw new HelmxError(
      'worktree_check_failed',
      `无法确认 worktree '${record.path}'（节点 ${record.nodeId}）仍是 Git 工作树（不当作缺失，续接中止）：\n${probe.output.trim()}`,
      502,
      { path: record.path, branch: record.branch, nodeId: record.nodeId, output: probe.output.slice(0, 2000) },
    )
  }
  if (probe.output.trim() !== 'true') {
    throw new HelmxError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）已不是 Git 工作树（可能已被替换）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }
  return record
}

export function ownerMismatchError(
  record: ManagedWorktreeRecord,
  reason: string,
  detail: string,
  extra?: Record<string, unknown>,
): HelmxError {
  return new HelmxError(
    'worktree_owner_mismatch',
    `受管 worktree '${record.path}'（节点 ${record.nodeId}）${detail}（reason: ${reason}）：登记路径上的工作树已不归属本记录，拒绝清理（force 也不可越过归属校验）`,
    409,
    { path: record.path, branch: record.branch, nodeId: record.nodeId, reason, ...extra },
  )
}
