/**
 * `agent_spawn` 隔离生命周期流程：
 * - `spawnWithWorktree`：新建 + `isolation: 'worktree'`（副作用前落盘占位租约 -> 分配 -> 改写 cwd -> `next` -> 终态收敛）；
 * - `resumeWithWorktree`：续接已绑定隔离树的子会话（占位租约前置防并发清理，禁止切换节点或 cwd）；
 * - `reattachWithWorktree`：跨重启原位恢复原生隔离工作树（复用记录与租约，不重复注入上下文）。
 */
import {
  HelmxError,
  isValidNodeId,
  NODE_ID_PATTERN,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
} from '@helmx/protocol'
import { worktreeExecutionMeta, type WorktreeExecutionDescriptor } from '../contracts.js'
import type { ManagedWorktreeRecord, WorktreeAllocator } from './worktree.js'
import type { WorktreeStore } from './worktree-store.js'
import type { WorktreeIsolationDeps } from './isolation.js'

export interface IsolationSpawnContext {
  deps: WorktreeIsolationDeps
  allocator: WorktreeAllocator
  store: WorktreeStore
}

function worktreeContextPrompt(record: ManagedWorktreeRecord): string {
  const lines = [
    '当前工作目录为独立 Git Worktree：',
    `- worktreeId: ${record.id}`,
    `- path: ${record.path}`,
    `- branch: ${record.branch}`,
    ...(record.baseCommit !== '' ? [`- baseCommit: ${record.baseCommit.slice(0, 12)}`] : []),
    ...(record.baseBranch !== undefined && record.baseBranch !== '' ? [`- baseBranch: ${record.baseBranch}`] : []),
    ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
      ? [`- parentWorktreeId: ${record.parentWorktreeId}`]
      : []),
    record.dirtySource
      ? '- 注意：源工作区存在未提交修改，本隔离工作树基于源 HEAD 创建，不包含源工作区未提交的改动。'
      : '- 源工作区干净。',
    '请在结束回合前运行 git add 与 git commit 提交全部改动，保持工作区干净。',
  ]
  return `\n\n<worktree_context>\n${lines.join('\n')}\n</worktree_context>`
}

function toExecutionDescriptor(record: ManagedWorktreeRecord): WorktreeExecutionDescriptor {
  return {
    path: record.path,
    branch: record.branch,
    id: record.id,
    ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
    ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
    ...(record.baseBranch !== undefined && record.baseBranch !== '' ? { baseBranch: record.baseBranch } : []),
    ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
      ? { parentWorktreeId: record.parentWorktreeId }
      : {}),
  }
}

function withWorktreeExecutionMeta(
  info: AgentExecutionInfo,
  worktree: WorktreeExecutionDescriptor,
): AgentExecutionInfo {
  return { ...info, meta: worktreeExecutionMeta({ worktree }, info.meta) }
}

async function settleFailedNativeSpawn(
  ctx: IsolationSpawnContext,
  leaseToken: string,
  enteredNext: boolean,
  execution: AgentExecutionInfo | undefined,
): Promise<void> {
  if (enteredNext && ctx.deps.host.isClosing === true) return
  await (enteredNext
    ? ctx.store.settleLeaseAfterNextFailure(leaseToken, execution)
    : ctx.store.settleLease(leaseToken, false, true)
  ).catch(() => {})
}

export async function spawnWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  if (request.nodeId !== undefined && !isValidNodeId(request.nodeId)) {
    throw new HelmxError(
      'validation_error',
      `nodeId must match ${NODE_ID_PATTERN} (received ${String(request.nodeId)})`,
      400,
      { nodeId: request.nodeId },
    )
  }
  const explicitProfileId = request.agentType !== undefined && request.agentType !== '' ? request.agentType : undefined
  const target = await ctx.deps.host.resolveSpawnTarget({
    parentConversationId: request.parentConversationId,
    ...(request.fork === true
      ? {
          fork: true,
          ...(explicitProfileId !== undefined ? { profileId: explicitProfileId } : {}),
        }
      : {
          profileId: explicitProfileId ?? 'assistant',
        }),
    ...(request.nodeId !== undefined ? { requestNodeId: request.nodeId } : {}),
    ...(request.cwd !== undefined ? { requestCwd: request.cwd } : {}),
  })

  let leaseToken = ''
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    const record = await ctx.allocator.allocate({
      nodeId: target.nodeId,
      sourceCwd: target.sourceCwd,
      parentConversationId: request.parentConversationId,
      signal: request.signal,
      beforeCreate: async (pending) => {
        leaseToken = await ctx.store.openPendingLease({ nodeId: pending.nodeId, path: pending.path })
      },
    })
    const descriptor = toExecutionDescriptor(record)
    const finalRequest: AgentSpawnRequest = {
      ...request,
      cwd: record.path,
      isolation: undefined,
      prompt: `${request.prompt}${worktreeContextPrompt(record)}`,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        const enriched = withWorktreeExecutionMeta({ ...info, nodeId: info.nodeId ?? target.nodeId }, descriptor)
        if (info.conversationId !== undefined) {
          ctx.allocator.bindConversation(record.path, record.nodeId, info.conversationId)
          ctx.store.recordAgentBinding(request.agentId, info.conversationId, request.parentConversationId)
        }
        ctx.store.updateLease(leaseToken, enriched)
        void ctx.deps.docStore.flush().catch((flushError: unknown) => {
          process.stderr.write(
            `builtin:worktree: worktree ${record.id} 绑定落盘失败: ${
              flushError instanceof Error ? flushError.message : String(flushError)
            }\n`,
          )
        })
        execution = enriched
        request.onResolved?.(enriched)
      },
    }
    enteredNext = true
    const result = await next(finalRequest)
    await ctx.store.settleLease(leaseToken, true, false)
    return result
  } catch (error) {
    await settleFailedNativeSpawn(ctx, leaseToken, enteredNext, execution)
    throw error
  }
}

export async function resumeWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  childId: number,
  record: ManagedWorktreeRecord,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  if (request.nodeId !== undefined) {
    throw new HelmxError(
      'validation_error',
      'nodeId and resume are mutually exclusive: cannot switch compute node when resuming an existing subagent',
      400,
      { nodeId: request.nodeId, resume: request.resume },
    )
  }
  if (record.status === 'removed') {
    throw new HelmxError('worktree_missing', `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`, 409)
  }
  const conv = ctx.deps.host.getConversation(childId)
  if ((conv.nodeId ?? 'local') !== record.nodeId) {
    throw new HelmxError('resume_cwd_conflict', '隔离子会话必须在原节点和工作树上续接，不能切换节点', 409, {
      conversationId: childId,
      nodeId: record.nodeId,
    })
  }
  if (request.cwd !== undefined && request.cwd !== record.path) {
    throw new HelmxError(
      'resume_cwd_conflict',
      `子会话已绑定隔离 worktree '${record.path}'，不支持在 resume 时改写 cwd 为 '${request.cwd}'`,
      409,
      { existingCwd: record.path, requestedCwd: request.cwd },
    )
  }

  const leaseToken = await ctx.store.openPendingLease({
    nodeId: record.nodeId,
    path: record.path,
    worktreeId: record.id,
  })
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    await ctx.allocator.verifyForResume(record, request.cwd, request.signal)
    const descriptor = toExecutionDescriptor(record)
    const finalRequest: AgentSpawnRequest = {
      ...request,
      cwd: record.path,
      isolation: undefined,
      prompt: `${request.prompt}${worktreeContextPrompt(record)}`,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        const enriched = withWorktreeExecutionMeta({ ...info, nodeId: info.nodeId ?? record.nodeId }, descriptor)
        ctx.store.updateLease(leaseToken, enriched)
        execution = enriched
        request.onResolved?.(enriched)
      },
    }
    enteredNext = true
    const result = await next(finalRequest)
    await ctx.store.settleLease(leaseToken, true, false)
    await ctx.store.clearStaleLeases(record.id).catch((error: unknown) => {
      process.stderr.write(
        `builtin:worktree: worktree ${record.id} 残留租约清理失败（后续 cleanup 可能被 worktree_execution_unknown 阻塞，可重试 resume 或人工核对）: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
    return result
  } catch (error) {
    await settleFailedNativeSpawn(ctx, leaseToken, enteredNext, execution)
    throw error
  }
}

export async function reattachWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  record: ManagedWorktreeRecord,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  if (record.status === 'removed') {
    throw new HelmxError('worktree_missing', `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`, 409)
  }
  const convId = request.reattach?.conversationId
  const leaseToken = await ctx.store.acquireReattachLease(
    { worktreeId: record.id, nodeId: record.nodeId, path: record.path },
    { ...(convId !== undefined ? { conversationId: convId } : {}) },
    {
      nodeId: record.nodeId,
      ...(convId !== undefined ? { conversationId: convId } : {}),
      effectiveCwd: record.path,
    },
  )
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    await ctx.allocator.verifyForResume(record, undefined, request.signal)
    const descriptor = toExecutionDescriptor(record)
    const finalRequest: AgentSpawnRequest = {
      ...request,
      isolation: undefined,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        const enriched = withWorktreeExecutionMeta({ ...info, nodeId: info.nodeId ?? record.nodeId }, descriptor)
        ctx.store.updateLease(leaseToken, enriched)
        void ctx.deps.docStore.flush().catch(() => {})
        execution = enriched
        request.onResolved?.(enriched)
      },
    }
    enteredNext = true
    const result = await next(finalRequest)
    await ctx.store.settleLease(leaseToken, true, false)
    await ctx.store.clearStaleLeases(record.id).catch((error: unknown) => {
      process.stderr.write(
        `builtin:worktree: worktree ${record.id} 残留租约清理失败: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
    return result
  } catch (error) {
    if (enteredNext && ctx.deps.host.isClosing !== true) {
      await ctx.store.settleLeaseAfterNextFailure(leaseToken, execution).catch(() => {})
    }
    throw error
  }
}
