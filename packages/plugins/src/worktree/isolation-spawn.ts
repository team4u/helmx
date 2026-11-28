/**
 * `agent_spawn` 隔离生命周期流程：新建 / resume / reattach 共享统一元数据注入与租约收尾。
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
import type { WorktreeIsolationDeps } from './isolation-types.js'

export interface IsolationSpawnContext {
  deps: WorktreeIsolationDeps
  allocator: WorktreeAllocator
  store: WorktreeStore
}

function toExecutionDescriptor(record: ManagedWorktreeRecord): WorktreeExecutionDescriptor {
  return {
    path: record.path,
    branch: record.branch,
    id: record.id,
    ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
    ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
    ...(record.baseBranch !== undefined && record.baseBranch !== '' ? { baseBranch: record.baseBranch } : {}),
    ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
      ? { parentWorktreeId: record.parentWorktreeId }
      : {}),
  }
}

function makeOnResolved(params: {
  ctx: IsolationSpawnContext
  request: AgentSpawnRequest
  record: ManagedWorktreeRecord
  fallbackNodeId: string
  leaseToken: string
  bindConversation?: boolean
  flushOnResolve?: boolean
  onCapture: (info: AgentExecutionInfo) => void
}): (raw: unknown) => void {
  const descriptor = toExecutionDescriptor(params.record)
  return (raw: unknown) => {
    const info = sanitizeExecutionInfo(raw, { agentId: params.request.agentId ?? 'subagent' })
    const enriched: AgentExecutionInfo = {
      ...info,
      nodeId: info.nodeId ?? params.fallbackNodeId,
      meta: worktreeExecutionMeta({ worktree: descriptor }, info.meta),
    }
    if (params.bindConversation && info.conversationId !== undefined) {
      params.ctx.allocator.bindConversation(params.record.path, params.record.nodeId, info.conversationId)
      params.ctx.store.recordAgentBinding(params.request.agentId, info.conversationId, params.request.parentConversationId)
    }
    params.ctx.store.updateLease(params.leaseToken, enriched)
    if (params.flushOnResolve) {
      void params.ctx.store.flush().catch((flushError: unknown) => {
        process.stderr.write(
          `builtin:worktree: worktree ${params.record.id} 绑定落盘失败: ${
            flushError instanceof Error ? flushError.message : String(flushError)
          }\n`,
        )
      })
    }
    params.onCapture(enriched)
    params.request.onResolved?.(enriched)
  }
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

async function clearStaleLeasesBestEffort(ctx: IsolationSpawnContext, worktreeId: string): Promise<void> {
  await ctx.store.clearStaleLeases(worktreeId).catch((error: unknown) => {
    process.stderr.write(
      `builtin:worktree: worktree ${worktreeId} 残留租约清理失败: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  })
}

export async function spawnWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  if (request.nodeId !== undefined && !isValidNodeId(request.nodeId)) {
    throw new HelmxError('validation_error', `nodeId must match ${NODE_ID_PATTERN} (received ${String(request.nodeId)})`, 400, {
      nodeId: request.nodeId,
    })
  }
  const explicitProfileId = request.agentType !== undefined && request.agentType !== '' ? request.agentType : undefined
  const target = await ctx.deps.host.resolveSpawnTarget({
    parentConversationId: request.parentConversationId,
    ...(request.fork === true
      ? { fork: true, ...(explicitProfileId !== undefined ? { profileId: explicitProfileId } : {}) }
      : { profileId: explicitProfileId ?? 'assistant' }),
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
    enteredNext = true
    const result = await next({
      ...request,
      cwd: record.path,
      isolation: undefined,
      onResolved: makeOnResolved({
        ctx,
        request,
        record,
        fallbackNodeId: target.nodeId,
        leaseToken,
        bindConversation: true,
        flushOnResolve: true,
        onCapture: (info) => {
          execution = info
        },
      }),
    })
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

  const leaseToken = await ctx.store.openPendingLease({ nodeId: record.nodeId, path: record.path, worktreeId: record.id })
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    await ctx.allocator.verifyForResume(record, request.cwd, request.signal)
    enteredNext = true
    const result = await next({
      ...request,
      cwd: record.path,
      isolation: undefined,
      onResolved: makeOnResolved({
        ctx,
        request,
        record,
        fallbackNodeId: record.nodeId,
        leaseToken,
        onCapture: (info) => {
          execution = info
        },
      }),
    })
    await ctx.store.settleLease(leaseToken, true, false)
    await clearStaleLeasesBestEffort(ctx, record.id)
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
  await ctx.allocator.verifyForResume(record, undefined, request.signal)
  const convId = request.reattach?.conversationId
  let leaseToken = ''
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    leaseToken = await ctx.store.acquireReattachLease(
      { worktreeId: record.id, nodeId: record.nodeId, path: record.path },
      { ...(convId !== undefined ? { conversationId: convId } : {}) },
      { nodeId: record.nodeId, ...(convId !== undefined ? { conversationId: convId } : {}), effectiveCwd: record.path },
    )
    enteredNext = true
    const result = await next({
      ...request,
      isolation: undefined,
      onResolved: makeOnResolved({
        ctx,
        request,
        record,
        fallbackNodeId: record.nodeId,
        leaseToken,
        flushOnResolve: true,
        onCapture: (info) => {
          execution = info
        },
      }),
    })
    await ctx.store.settleLease(leaseToken, true, false)
    await clearStaleLeasesBestEffort(ctx, record.id)
    return result
  } catch (error) {
    if (leaseToken !== '') {
      if (!enteredNext) {
        await ctx.store.settleLease(leaseToken, false, true).catch(() => {})
      } else if (ctx.deps.host.isClosing !== true) {
        await ctx.store.settleLeaseAfterNextFailure(leaseToken, execution).catch(() => {})
      }
    }
    throw error
  }
}
