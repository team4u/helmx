/**
 * 受管 worktree 清理状态机：
 * 选择器解析 + 占用/持有锁拦截 + per-repo 串行锁 + 权威归属与 realpath 校验 +
 * 脏工作区/未合入保护 + 进程占用检查 + git worktree remove / branch 删除。
 */
import { HelmxError, type NodePathUsage } from '@helmx/protocol'
import { setTimeout as delay } from 'node:timers/promises'
import {
  canonicalPathOnNode,
  countUnmergedCommits,
  deleteManagedBranch,
  dirExistsOnNode,
  gitExec,
  matchWorktreeEntry,
  normalizePathValue,
  pruneWorktreeRegistrations,
  resolveMergeReferenceHead,
  resolveRepoAuthority,
} from './worktree-git.js'
import { validateWorktreeSelector, type ManagedWorktreeRecord, type WorktreeStore } from './worktree-store.js'
import { ownerMismatchError } from './worktree-inspect.js'
import type { CleanupInput, CleanupResult, WorktreeAllocatorDeps } from './worktree.js'

const MANAGED_BRANCH_PREFIX = 'helmx/spawn-'

function assertWorktreeNotHeld(
  store: WorktreeStore,
  redact: (text: string) => string,
  record: ManagedWorktreeRecord,
): void {
  const held =
    record.status === 'active' && record.hold !== undefined
      ? record
      : store
          .records()
          .find(
            (other) =>
              other.status === 'active' &&
              other.hold !== undefined &&
              other.nodeId === record.nodeId &&
              (store.containsPath(record.path, other.path) || store.containsPath(other.path, record.path)),
          )
  if (held === undefined || held.hold === undefined) return
  const safeLabel = redact(held.hold.label)
  throw new HelmxError(
    'worktree_in_use',
    `worktree '${record.path}'（节点 ${record.nodeId}）正被持久持有锁占用（${safeLabel}），拒绝清理（force 不可绕过）`,
    409,
    {
      worktreeId: record.id,
      path: record.path,
      nodeId: record.nodeId,
      hold: {
        pluginId: held.hold.pluginId,
        holdId: held.hold.holdId,
        label: safeLabel,
        acquiredAt: held.hold.acquiredAt,
      },
    },
  )
}

function assertWorktreeUnoccupied(
  deps: Pick<WorktreeAllocatorDeps, 'isConversationWorking' | 'isPathInUse'>,
  store: WorktreeStore,
  redact: (text: string) => string,
  record: ManagedWorktreeRecord,
): void {
  assertWorktreeNotHeld(store, redact, record)
  const checkWorking = deps.isConversationWorking ?? ((id) => store.isConversationWorking(id))
  const checkPathInUse = deps.isPathInUse ?? ((n, p) => store.isPathInUse(n, p))
  if (record.conversationId !== undefined) {
    let working = false
    try {
      working = checkWorking(record.conversationId)
    } catch (err) {
      if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
    }
    if (working) {
      throw new HelmxError(
        'worktree_in_use',
        `worktree '${record.path}' 关联的子代理仍在运行中，拒绝清理`,
        409,
        { path: record.path, conversationId: record.conversationId },
      )
    }
  }
  if (checkPathInUse(record.nodeId, record.path)) {
    throw new HelmxError(
      'worktree_in_use',
      `worktree '${record.path}'（节点 ${record.nodeId}）仍被引用，拒绝清理`,
      409,
      { path: record.path, nodeId: record.nodeId },
    )
  }
}

async function assertPathUnusedByProcesses(
  deps: Pick<WorktreeAllocatorDeps, 'inspectPathUsage'>,
  redact: (text: string) => string,
  record: ManagedWorktreeRecord,
  signal?: AbortSignal,
): Promise<void> {
  const probe = deps.inspectPathUsage
  if (probe === undefined) {
    throw new HelmxError(
      'worktree_process_check_failed',
      `worktree '${record.path}'（节点 ${record.nodeId}）未装配进程占用探测端口，无法证明无进程占用，清理中止（force 也不可绕过）`,
      502,
      { worktreeId: record.id, path: redact(record.path), nodeId: record.nodeId },
    )
  }
  let usage: NodePathUsage
  try {
    usage = await probe(record.nodeId, record.path, signal)
    for (
      let attempt = 0;
      attempt < 2 && usage.complete !== true && usage.matchedTotal === 0 && usage.processes.length === 0;
      attempt += 1
    ) {
      await delay(25 * (attempt + 1), undefined, { signal })
      usage = await probe(record.nodeId, record.path, signal)
    }
  } catch (error) {
    const cause =
      error instanceof HelmxError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    throw new HelmxError(
      'worktree_process_check_failed',
      `无法完成 worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描（${redact(cause)}），不能证明 0 占用，清理中止（force 也不可绕过）`,
      502,
      { worktreeId: record.id, nodeId: record.nodeId, path: redact(record.path), cause: redact(cause) },
    )
  }
  if (usage.matchedTotal > 0 || usage.processes.length > 0) {
    const shown = usage.processes.map((p) => `${p.pid}${p.name !== undefined ? `(${p.name})` : ''}`)
    throw new HelmxError(
      'worktree_process_in_use',
      `worktree '${record.path}'（节点 ${record.nodeId}）被 ${usage.matchedTotal} 个进程的工作目录或打开文件引用（${shown.join('、')}${usage.matchedTotal > shown.length ? ` 等 ${usage.matchedTotal} 个` : ''}${usage.processesTruncated ? '；清单截断' : ''}）；这是删除前快照，不会自动终止任何进程，请先在目标节点处理后再清理（force 也不可绕过）`,
      409,
      {
        worktreeId: record.id,
        path: redact(record.path),
        nodeId: record.nodeId,
        pids: usage.processes.map((p) => p.pid),
        processes: usage.processes.map((p) => ({
          pid: p.pid,
          ...(p.name !== undefined ? { name: p.name } : {}),
          source: p.source,
          path: redact(p.path),
        })),
        matchedTotal: usage.matchedTotal,
        processesTruncated: usage.processesTruncated,
        complete: usage.complete,
      },
    )
  }
  if (usage.complete !== true) {
    throw new HelmxError(
      'worktree_process_check_failed',
      `worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描不完整（${usage.diagnostics.map((d) => redact(d)).join('；') || '原因未知'}），不能证明 0 占用，清理中止（force 也不可绕过）`,
      502,
      {
        worktreeId: record.id,
        nodeId: record.nodeId,
        path: redact(record.path),
        diagnostics: usage.diagnostics.map((d) => redact(d)),
      },
    )
  }
}

async function deleteBranchAgainstAuthority(
  deps: WorktreeAllocatorDeps,
  record: ManagedWorktreeRecord,
  mainPath: string,
  mainHead: string,
  input: CleanupInput,
): Promise<{ deleted: boolean; failureOutput?: string }> {
  const referenceHead = await resolveMergeReferenceHead(
    deps,
    record.nodeId,
    mainPath,
    mainHead,
    input.mergedInto,
    record.baseBranch,
    input.signal,
  )
  const merged =
    (await countUnmergedCommits(deps, record.nodeId, mainPath, referenceHead, record.branch, input.signal)) === 0
  return deleteManagedBranch(deps, record.nodeId, mainPath, record.branch, input.force === true || merged, input.signal)
}

async function forceClearMissingRegistration(
  deps: WorktreeAllocatorDeps,
  store: WorktreeStore,
  redact: (text: string) => string,
  withRepoLock: <T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>) => Promise<T>,
  record: ManagedWorktreeRecord,
  input: CleanupInput,
): Promise<CleanupResult> {
  if (await dirExistsOnNode(deps, record.nodeId, record.path)) {
    throw new HelmxError(
      'worktree_missing',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）目录在二次复核时重新出现（可能与外部操作竞争）；请重试常规清理（不带 force）`,
      409,
      { worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }

  let branchDeleted = record.branchDeleted === true
  let alreadyRemoved = false
  let prune: CleanupResult['prune'] | undefined
  const authority = await resolveRepoAuthority(deps, record.nodeId, record.repoRoot, input.signal)
  await withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
    const fresh = store.findById(record.id)
    if (fresh === undefined) {
      throw new HelmxError('not_found', `受管 worktree 记录 ${record.id} 不存在（文档状态不一致）`, 404, { id: record.id })
    }
    if (fresh.status === 'removed') {
      alreadyRemoved = true
      branchDeleted = fresh.branchDeleted === true
      return
    }
    const pruned = await pruneWorktreeRegistrations(deps, fresh.nodeId, authority.mainPath, input.signal)
    prune = { ran: true, ok: pruned.ok, ...(pruned.output !== '' ? { output: redact(pruned.output) } : {}) }
    if (input.deleteBranch === true && !branchDeleted) {
      const del = await deleteBranchAgainstAuthority(deps, fresh, authority.mainPath, authority.entries[0]!.head, input)
      branchDeleted = del.deleted
      if (!del.deleted) {
        store.updateRecord(fresh.id, (r) => ({
          ...r,
          branchDeleted: false,
          branchDeleteError: (del.failureOutput ?? '').slice(0, 2000),
        }))
      }
    }
    store.updateRecord(fresh.id, (r) => {
      const removedAt = Date.now()
      const base = { ...r, status: 'removed' as const, removedAt, removedReason: 'directory_missing_forced' as const }
      if (input.deleteBranch !== true) return base
      if (!branchDeleted) return { ...base, branchDeleted: false }
      const { branchDeleteError: _ignored, ...clean } = r
      return { ...clean, status: 'removed' as const, removedAt, removedReason: 'directory_missing_forced' as const, branchDeleted: true }
    })
  })
  return {
    removed: !alreadyRemoved,
    worktreeId: record.id,
    path: record.path,
    branch: record.branch,
    nodeId: record.nodeId,
    branchDeleted,
    ...(alreadyRemoved ? {} : { removedReason: 'directory_missing_forced' as const }),
    ...(prune !== undefined ? { prune } : {}),
  }
}

export async function cleanupWorktree(
  deps: WorktreeAllocatorDeps,
  store: WorktreeStore,
  redact: (text: string) => string,
  withRepoLock: <T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>) => Promise<T>,
  input: CleanupInput,
): Promise<CleanupResult> {
  validateWorktreeSelector(input, 'cleanup')
  if (
    input.mergedInto !== undefined &&
    (typeof input.mergedInto !== 'string' ||
      input.mergedInto === '' ||
      /[\s\u0000-\u001f]/.test(input.mergedInto) ||
      input.mergedInto.includes('..') ||
      input.mergedInto.includes('~') ||
      input.mergedInto.includes('^') ||
      input.mergedInto.includes(':') ||
      input.mergedInto.startsWith('-'))
  ) {
    throw new HelmxError(
      'validation_error',
      'mergedInto 必须是不含空白与范围操作符（.. ~ ^ :）且不以 - 开头的非空分支/提交名',
      400,
      { mergedInto: input.mergedInto },
    )
  }

  const record = store.resolveRecord(input, 'cleanup')
  if (!record.branch.startsWith(MANAGED_BRANCH_PREFIX)) {
    throw new HelmxError(
      'validation_error',
      `受管 worktree '${record.path}' 的分支 '${record.branch}' 不在 helmx 受管前缀（${MANAGED_BRANCH_PREFIX}）内，拒绝清理`,
      400,
      { path: record.path, branch: record.branch },
    )
  }

  if (record.status === 'removed') {
    let branchDeleted = record.branchDeleted === true
    if (input.deleteBranch === true && !branchDeleted) {
      const authority = await resolveRepoAuthority(deps, record.nodeId, record.repoRoot, input.signal)
      await withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
        const del = await deleteBranchAgainstAuthority(deps, record, authority.mainPath, authority.entries[0]!.head, input)
        branchDeleted = del.deleted
        if (del.deleted) {
          store.updateRecord(record.id, (r) => {
            const { branchDeleteError: _ignored, ...clean } = r
            return { ...clean, branchDeleted: true }
          })
          return
        }
        store.updateRecord(record.id, (r) => ({
          ...r,
          branchDeleted: false,
          branchDeleteError: (del.failureOutput ?? '').slice(0, 2000),
        }))
        throw new HelmxError(
          'branch_delete_failed',
          `重试删除分支 ${record.branch} 失败（登记保持 removed，可再次重试）：\n${(del.failureOutput ?? '').trim()}`,
          502,
          { worktreeId: record.id, branch: record.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
        )
      })
    }
    return { removed: false, worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId, branchDeleted }
  }

  assertWorktreeUnoccupied(deps, store, redact, record)

  if (!(await dirExistsOnNode(deps, record.nodeId, record.path))) {
    if (input.force !== true) {
      throw new HelmxError(
        'worktree_missing',
        `受管 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）；登记保留，请人工核对后处理（不自动 prune）；确认无需保留时可显式传 force: true 走登记清除（二次复核缺失后清登记，分支按 mergedInto/merged 规则处置，并在主仓执行 git worktree prune 收敛 git 侧残留）`,
        409,
        { worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    return forceClearMissingRegistration(deps, store, redact, withRepoLock, record, input)
  }

  const authority = await resolveRepoAuthority(deps, record.nodeId, record.repoRoot, input.signal)
  let outcome: { removed: boolean; branchDeleted: boolean } | undefined

  await withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
    const fresh = store.findById(record.id)
    if (fresh === undefined) {
      throw new HelmxError('not_found', `受管 worktree 记录 ${record.id} 不存在（文档状态不一致）`, 404, { id: record.id })
    }
    if (fresh.status === 'removed') {
      outcome = { removed: false, branchDeleted: fresh.branchDeleted === true }
      return
    }
    assertWorktreeUnoccupied(deps, store, redact, fresh)

    const locked = await resolveRepoAuthority(deps, fresh.nodeId, fresh.repoRoot, input.signal)
    const entries = locked.entries
    const mainEntry = entries[0]!
    const match = matchWorktreeEntry(entries, fresh.path)
    if (match === undefined) {
      throw ownerMismatchError(
        fresh,
        'not_in_worktree_list',
        '不在权威 worktree 登记中（目录仍存在：路径上的内容已不受本仓库管理）',
        { registeredEntries: entries.map((e) => redact(e.path)).slice(0, 20) },
      )
    }
    if (match === mainEntry || normalizePathValue(match.path) === normalizePathValue(mainEntry.path)) {
      throw ownerMismatchError(fresh, 'main_worktree', '指向主工作树（主工作树绝不清除）', { mainPath: redact(mainEntry.path) })
    }
    if (match.locked) {
      throw new HelmxError(
        'worktree_locked',
        `worktree '${fresh.path}'（节点 ${fresh.nodeId}）已被 git worktree lock 锁定${match.lockedReason !== undefined ? `（${redact(match.lockedReason)}）` : ''}，拒绝清理（请先解锁）`,
        409,
        { worktreeId: fresh.id, path: fresh.path, nodeId: fresh.nodeId, ...(match.lockedReason !== undefined ? { lockedReason: redact(match.lockedReason) } : {}) },
      )
    }
    if (match.prunable) {
      throw ownerMismatchError(
        fresh,
        'prunable',
        `的 gitdir 链接已断（${match.prunableReason !== undefined ? redact(match.prunableReason) : 'prunable'}：登记路径上的目录可能已被替换）`,
      )
    }
    if (match.branch !== `refs/heads/${fresh.branch}`) {
      throw ownerMismatchError(
        fresh,
        'branch_changed',
        `的权威登记分支为 ${match.branch ?? (match.detached ? 'detached' : '未知')}，与登记分支 ${fresh.branch} 不一致（工作树可能已被用户替换或改签分支）`,
        { authorityBranch: redact(match.branch ?? '') },
      )
    }
    if (match.head === '' || /^0+$/.test(match.head)) {
      throw ownerMismatchError(fresh, 'head_unreadable', '的权威登记 HEAD 缺失（工作树状态不可信）', { authorityHead: match.head })
    }

    const canonicalRecord = await canonicalPathOnNode(deps, fresh.nodeId, fresh.path)
    const canonicalMain = await canonicalPathOnNode(deps, fresh.nodeId, mainEntry.path)
    if (canonicalRecord === canonicalMain) {
      throw ownerMismatchError(fresh, 'main_worktree', `经真实路径解析指向主工作树 ${redact(mainEntry.path)}`, {
        mainPath: redact(mainEntry.path),
      })
    }
    for (const other of entries) {
      if (other === match) continue
      const canonicalOther = await canonicalPathOnNode(deps, fresh.nodeId, other.path)
      if (canonicalRecord === canonicalOther) {
        throw ownerMismatchError(
          fresh,
          'symlink_redirect',
          `经真实路径解析指向其他工作树 ${redact(other.path)}（登记路径可能已被软链替换）`,
          { redirectedTo: redact(other.path) },
        )
      }
    }

    let unmergedCommits = 0
    if (input.force !== true) {
      const status = await gitExec(deps, fresh.nodeId, fresh.path, ['status', '--porcelain', '--untracked-files=all'], input.signal)
      if (!status.ok) {
        throw new HelmxError(
          'worktree_check_failed',
          `无法确认 worktree '${fresh.path}' 的工作区状态（git status 失败；绝不当作干净或目录缺失，清理中止）：\n${status.output.trim()}`,
          502,
          { worktreeId: fresh.id, path: fresh.path, output: status.output.slice(0, 2000) },
        )
      }
      const dirtyFiles = status.output.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const referenceHead = await resolveMergeReferenceHead(
        deps,
        fresh.nodeId,
        locked.mainPath,
        mainEntry.head,
        input.mergedInto,
        fresh.baseBranch,
        input.signal,
      )
      unmergedCommits = await countUnmergedCommits(deps, fresh.nodeId, locked.mainPath, referenceHead, fresh.branch, input.signal)
      if (dirtyFiles.length > 0 || unmergedCommits > 0) {
        throw new HelmxError(
          'worktree_dirty',
          `worktree '${fresh.path}' (branch: ${fresh.branch}) 含未提交修改、未跟踪文件或未合入提交（相对参考提交 ${referenceHead}）；请先检视/合入，或显式传 force: true 强制清理`,
          409,
          { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, dirtyFiles: dirtyFiles.slice(0, 200), unmergedCommits, referenceHead },
        )
      }
    }

    await assertPathUnusedByProcesses(deps, redact, fresh, input.signal)

    const remove = await gitExec(
      deps,
      fresh.nodeId,
      locked.mainPath,
      ['worktree', 'remove', ...(input.force === true ? ['--force'] : []), fresh.path],
      input.signal,
    )
    if (!remove.ok) {
      throw new HelmxError(
        'worktree_remove_failed',
        `移除 worktree '${fresh.path}'（节点 ${fresh.nodeId}）失败：\n${remove.output.trim()}`,
        502,
        { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: remove.output.slice(0, 2000) },
      )
    }

    let branchDeleted = false
    if (input.deleteBranch === true) {
      const del = await deleteManagedBranch(
        deps,
        fresh.nodeId,
        locked.mainPath,
        fresh.branch,
        input.force === true || unmergedCommits === 0,
        input.signal,
      )
      branchDeleted = del.deleted
      if (!del.deleted) {
        store.updateRecord(fresh.id, (r) => ({
          ...r,
          status: 'removed' as const,
          removedAt: Date.now(),
          branchDeleted: false,
          branchDeleteError: (del.failureOutput ?? '').slice(0, 2000),
        }))
        throw new HelmxError(
          'branch_delete_failed',
          `worktree '${fresh.path}' 已移除，但删除分支 ${fresh.branch} 失败（登记已置 removed，可重试 cleanup 传 deleteBranch:true）：\n${(del.failureOutput ?? '').trim()}`,
          502,
          { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
        )
      }
    }
    store.updateRecord(fresh.id, (r) => {
      if (input.deleteBranch !== true) return { ...r, status: 'removed' as const, removedAt: Date.now() }
      const { branchDeleteError: _ignored, ...clean } = r
      return { ...clean, status: 'removed' as const, removedAt: Date.now(), branchDeleted: true }
    })
    outcome = { removed: true, branchDeleted }
  })

  if (outcome === undefined) {
    throw new HelmxError('worktree_check_failed', '清理未产生结果（内部状态不一致）', 500, { worktreeId: record.id })
  }
  return {
    removed: outcome.removed,
    worktreeId: record.id,
    path: record.path,
    branch: record.branch,
    nodeId: record.nodeId,
    branchDeleted: outcome.branchDeleted,
  }
}
