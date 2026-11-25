/**
 * builtin:worktree 受管 Worktree 动作（cleanup_worktree / list_worktrees / inspect_worktree，
 * 以及内部跨插件动作 acquire_worktree / release_worktree_hold）。
 *
 * - cleanup_worktree 通过 `exposeAsTool` 单点声明直投模型工具（`name: 'cleanup_worktree'`、
 *   `formatOutput` 摘要文本、`presentationMetaSchema` + `projectPresentationMeta` 有界 UI 索引），
 *   五端复用同一 handler，彻底消除 `ctx.tool` + `ctx.action` 重复声明；
 * - acquire_worktree / release_worktree_hold 声明 `visibility: 'internal'`，拒绝 HTTP /
 *   `run_action` / Workflow DSL，仅允许插件经 `ctx.host.invokeAction` 调用，且持久锁归属插件 ID
 *   完全取自宿主盖章注入、不可伪造的 `context.callerPluginId`。
 */
import { HelmxError, NODE_ID_PATTERN, type HelmxPluginContext, type JsonSchema, type PluginActionContext } from '@helmx/protocol'
import type { CleanupResult } from './worktree.js'
import type { WorktreeIsolation } from './isolation.js'

export interface WorktreeActionDeps {
  isolation: WorktreeIsolation
}

/** UI 持久化索引：有界标量/坐标字段，剔除可能冗长的 prune.output 原文。 */
export const cleanupPresentationMetaSchema: JsonSchema = {
  type: 'object',
  properties: {
    removed: { type: 'boolean' },
    worktreeId: { type: 'string', maxLength: 4096 },
    path: { type: 'string', maxLength: 4096 },
    branch: { type: 'string', maxLength: 512 },
    nodeId: { type: 'string', maxLength: 256 },
    branchDeleted: { type: 'boolean' },
    processUsage: { type: 'string', enum: ['verified', 'unverified'] },
    removedReason: { type: 'string', enum: ['directory_missing_forced'] },
    pruneRan: { type: 'boolean' },
    pruneOk: { type: 'boolean' },
  },
  required: ['removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
  additionalProperties: false,
}

function boundIndexText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
}

function formatCleanupSummary(result: CleanupResult): string {
  const pruneNote =
    result.prune === undefined
      ? ''
      : result.prune.ran
        ? result.prune.ok
          ? '；已在主仓执行 git worktree prune 收敛 git 侧残留登记'
          : `；git worktree prune 失败（git 侧残留登记可能仍在，请人工核对）：${result.prune.output ?? ''}`
        : `；${result.prune.output ?? '未执行 git worktree prune'}`
  const unverifiedNote =
    result.processUsage === 'unverified'
      ? `（未校验进程占用：${result.processUsageNote ?? '目标节点不支持进程占用扫描，已显式承担风险清理'}）`
      : ''
  if (result.removed) {
    return result.removedReason === 'directory_missing_forced'
      ? `已按目录缺失恢复路径清除受管 worktree 登记 ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}${pruneNote}）`
      : `已移除受管 worktree ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}）${unverifiedNote}`
  }
  return `受管 worktree ${result.path} 此前已清理（幂等跳过；branch: ${result.branch}${result.branchDeleted ? '，分支已删除' : ''}）`
}

function requireCallerPluginId(context: PluginActionContext, actionId: string): string {
  const caller = context.callerPluginId
  if (typeof caller !== 'string' || caller.trim().length === 0) {
    throw new HelmxError(
      'action_visibility_forbidden',
      `Action builtin:worktree.${actionId} requires an authenticated plugin caller (ctx.host.invokeAction)`,
      403,
      { pluginId: 'builtin:worktree', actionId },
    )
  }
  return caller
}

export function registerWorktreeActions(ctx: HelmxPluginContext, deps: WorktreeActionDeps): void {
  const { isolation } = deps

  ctx.action<Record<string, unknown>, CleanupResult>({
    id: 'cleanup_worktree',
    description: 'Clean up a managed Git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (node:path; exact selector, mutually exclusive with conversationId/path/nodeId)' },
        conversationId: { type: 'number', minimum: 1, description: 'Sub-conversation ID (mutually exclusive with path)' },
        path: { type: 'string', description: 'Worktree absolute path (mutually exclusive with conversationId; same-name paths across nodes need nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path, disambiguating same-name paths across nodes)' },
        deleteBranch: { type: 'boolean', description: 'Also delete the helmx/spawn-* branch (kept by default)' },
        mergedInto: { type: 'string', description: 'Target branch or commit already merged into; defaults to the recorded baseBranch, falling back to the main worktree HEAD' },
        force: { type: 'boolean', description: 'Force cleanup (only bypasses the uncommitted-changes/unmerged-commits protection; never bypasses occupancy/ownership/locked checks)' },
        allowUnverifiedUsage: {
          type: 'boolean',
          description:
            'Explicitly accept the risk of removing the worktree without a process-occupancy check when the target node does not support process usage scanning (e.g. win32/darwin). Only bypasses path_usage_not_supported; never skips scanning on supported nodes and never bypasses process-in-use, scan failures, holds, dirty/unmerged, or ownership checks.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        removed: { type: 'boolean' },
        worktreeId: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        nodeId: { type: 'string' },
        branchDeleted: { type: 'boolean' },
        processUsage: { type: 'string', enum: ['verified', 'unverified'] },
        processUsageNote: { type: 'string' },
        removedReason: {
          type: 'string',
          enum: ['directory_missing_forced'],
          description: 'Set only when the registration was force-cleared after the directory was confirmed missing',
        },
        prune: {
          type: 'object',
          description: 'git worktree prune outcome (directory-missing force path only; ran=false when no repoRoot anchor)',
          properties: {
            ran: { type: 'boolean' },
            ok: { type: 'boolean' },
            output: { type: 'string' },
          },
          required: ['ran', 'ok'],
          additionalProperties: false,
        },
      },
      required: ['removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'cleanup'], description: 'Clean up a managed Git worktree' },
    exposeAsTool: {
      name: 'cleanup_worktree',
      description:
        "Clean up one managed isolated Git worktree (the workspace of a sub-conversation spawned with isolation: 'worktree'). Locate it by worktreeId (node:path), conversationId, or worktree path (may attach nodeId to disambiguate); refused by default when the workspace has uncommitted changes or unmerged commits (inspect/merge first, or pass force: true; force cannot bypass occupancy/ownership/locked checks); optionally pass deleteBranch: true to also delete the helmx/spawn-* branch (branch deletion failures can be retried). Omit allowUnverifiedUsage by default; only pass allowUnverifiedUsage: true after receiving worktree_usage_unverifiable when you have confirmed no sub-session or background process occupies the directory (ask the user or leave it intact if external terminals/IDEs may still be using it). Only worktrees registered by helmx are cleaned; unregistered directories are never touched.",
      formatOutput: (_input, result) => formatCleanupSummary(result),
    },
    presentationMetaSchema: cleanupPresentationMetaSchema,
    projectPresentationMeta: (_input, result) => ({
      removed: result.removed,
      worktreeId: boundIndexText(result.worktreeId, 4096),
      path: boundIndexText(result.path, 4096),
      branch: boundIndexText(result.branch, 512),
      nodeId: boundIndexText(result.nodeId, 256),
      branchDeleted: result.branchDeleted,
      ...(result.processUsage !== undefined ? { processUsage: result.processUsage } : {}),
      ...(result.removedReason !== undefined ? { removedReason: result.removedReason } : {}),
      ...(result.prune !== undefined ? { pruneRan: result.prune.ran, pruneOk: result.prune.ok } : {}),
    }),
    async handler(input, context) {
      // --current / 工具调用缺省语义：未传任何显式选择器时以当前会话为选择器（子会话清理自身 worktree）；
      // 显式传 conversationId（如父会话清理子会话 worktree）或 worktreeId/path 时永不被调用上下文覆盖。
      const hasExplicit =
        input['worktreeId'] !== undefined || input['path'] !== undefined || input['conversationId'] !== undefined
      const selectorConversationId =
        input['conversationId'] !== undefined
          ? Number(input['conversationId'])
          : hasExplicit
            ? undefined
            : context.conversationId
      return isolation.cleanup(
        {
          ...(input['worktreeId'] !== undefined ? { worktreeId: String(input['worktreeId']) } : {}),
          ...(selectorConversationId !== undefined ? { conversationId: selectorConversationId } : {}),
          ...(input['path'] !== undefined ? { path: String(input['path']) } : {}),
          ...(input['nodeId'] !== undefined ? { nodeId: String(input['nodeId']) } : {}),
          ...(input['deleteBranch'] !== undefined ? { deleteBranch: input['deleteBranch'] === true } : {}),
          ...(input['mergedInto'] !== undefined ? { mergedInto: String(input['mergedInto']) } : {}),
          ...(input['force'] !== undefined ? { force: input['force'] === true } : {}),
          ...(input['allowUnverifiedUsage'] !== undefined
            ? { allowUnverifiedUsage: input['allowUnverifiedUsage'] === true }
            : {}),
          ...(context.callerPluginId !== undefined ? { callerPluginId: context.callerPluginId } : {}),
        },
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'list_worktrees',
    description: 'List managed Git worktree registrations (including metadata of cleaned-up records)',
    exposeToPrompt: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { worktrees: { type: 'array', items: { type: 'object' } } },
      required: ['worktrees'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'list'], description: 'List managed Git worktree registrations' },
    async handler() {
      return { worktrees: isolation.allocator.list() }
    },
  })

  ctx.action({
    id: 'inspect_worktree',
    description: 'Read-only inspection of one managed Git worktree: registration metadata plus a real read-only git probe on the target node (status/stats/capped diff preview); only registered records can be inspected',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (node:path; mutually exclusive with conversationId/path)' },
        conversationId: { type: 'number', minimum: 1, description: 'Sub-conversation ID (mutually exclusive with worktreeId/path)' },
        path: { type: 'string', description: 'Worktree absolute path (mutually exclusive with conversationId; same-name paths across nodes need nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path, disambiguating same-name paths across nodes)' },
        diff: { type: 'boolean', description: 'Whether to include a diff preview (included by default; registration metadata and stats are always returned)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        record: { type: 'object' },
        exists: { type: 'boolean' },
        unavailableReason: { type: 'string', enum: ['removed', 'directory_missing'] },
        currentBranch: { type: 'string' },
        currentHead: { type: 'string' },
        branchChanged: { type: 'boolean' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        dirtyFileCount: { type: 'number' },
        dirtyFilesTruncated: { type: 'boolean' },
        commitsAhead: { type: 'number' },
        unmergedCommits: { type: 'number' },
        diffStat: { type: 'string' },
        diffPreview: { type: 'string' },
        diffTruncated: { type: 'boolean' },
        diffBase: { type: 'string', enum: ['baseCommit', 'HEAD'] },
      },
      required: ['record', 'exists', 'dirtyFiles', 'dirtyFileCount', 'dirtyFilesTruncated', 'diffTruncated', 'diffBase'],
      additionalProperties: false,
    },
    cli: {
      command: ['worktrees', 'inspect'],
      description: 'Read-only inspection of a managed Git worktree (registration metadata + status/stats/diff preview)',
      positional: [{ field: 'worktreeId', required: true }],
    },
    async handler(input, context) {
      const a = input as Record<string, unknown>
      return isolation.allocator.inspect(
        {
          ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
          ...(a['conversationId'] !== undefined ? { conversationId: Number(a['conversationId']) } : {}),
          ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
          ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
          ...(a['diff'] !== undefined ? { diff: a['diff'] === true } : {}),
        },
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'acquire_worktree',
    description: 'Allocate a managed Git worktree for a worker conversation and attach a durable plugin hold owned by the calling plugin',
    visibility: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Worker conversation ID to bind to the newly allocated worktree',
        },
        parentConversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Parent or coordinator conversation ID used to resolve the spawn target',
        },
        profileId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Optional worker profile ID for spawn target resolution',
        },
        requestNodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: NODE_ID_PATTERN,
          description: 'Optional explicit target node ID override',
        },
        requestCwd: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Optional explicit source directory override',
        },
        fork: {
          type: 'boolean',
          description: 'Whether the worker conversation was forked from the parent conversation',
        },
        hold: {
          type: 'object',
          properties: {
            holdId: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: 'Stable hold identifier within the owning plugin',
            },
            label: {
              type: 'string',
              minLength: 1,
              pattern: '\\S',
              description: 'Human-readable hold diagnostic label (redacted before persistence)',
            },
          },
          required: ['holdId', 'label'],
          additionalProperties: false,
        },
      },
      required: ['conversationId', 'parentConversationId', 'hold'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        baseCommit: { type: 'string' },
        nodeId: { type: 'string' },
      },
      required: ['worktreeId', 'path', 'branch', 'baseCommit', 'nodeId'],
      additionalProperties: false,
    },
    async handler(input, context) {
      const callerPluginId = requireCallerPluginId(context, 'acquire_worktree')
      const a = input as {
        conversationId: number
        parentConversationId: number
        profileId?: string
        requestNodeId?: string
        requestCwd?: string
        fork?: boolean
        hold: { holdId: string; label: string }
      }
      return isolation.acquireWorktree(
        {
          conversationId: a.conversationId,
          parentConversationId: a.parentConversationId,
          ...(a.profileId !== undefined ? { profileId: a.profileId } : {}),
          ...(a.requestNodeId !== undefined ? { requestNodeId: a.requestNodeId } : {}),
          ...(a.requestCwd !== undefined ? { requestCwd: a.requestCwd } : {}),
          ...(a.fork !== undefined ? { fork: a.fork } : {}),
          hold: {
            pluginId: callerPluginId,
            holdId: a.hold.holdId,
            label: a.hold.label,
          },
        },
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'release_worktree_hold',
    description: 'Release a durable plugin hold owned by the calling plugin on a managed Git worktree',
    visibility: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Managed worktree registration ID (node:path)',
        },
        holdId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Stable hold identifier expected on the active hold',
        },
      },
      required: ['worktreeId', 'holdId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        released: { type: 'boolean' },
      },
      required: ['released'],
      additionalProperties: false,
    },
    async handler(input, context) {
      const callerPluginId = requireCallerPluginId(context, 'release_worktree_hold')
      const a = input as { worktreeId: string; holdId: string }
      return isolation.releaseWorktreeHold({
        worktreeId: a.worktreeId,
        pluginId: callerPluginId,
        holdId: a.holdId,
      })
    },
  })
}
