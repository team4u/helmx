/**
 * 受管 worktree 分配器与清理状态机共享契约类型（独立叶模块，断开双向类型依赖）。
 */
import type { ExecutionEnv, FileError, Result } from '@earendil-works/pi-durable/env'
import type { NodePathUsage } from '@helmx/protocol'
import type { WorktreeExecOptions, WorktreeExecResult } from './worktree-git.js'
import type { WorktreeKvHandles, WorktreeStore } from './worktree-store.js'

export interface WorktreeAllocatorDeps {
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options?: WorktreeExecOptions,
  ) => Promise<WorktreeExecResult>
  nodeExists: (nodeId: string, path: string) => Promise<Result<boolean, FileError>>
  nodeCanonicalPath: (nodeId: string, path: string) => Promise<Result<string, FileError>>
  executionEnv?: (nodeId: string, cwd: string) => ExecutionEnv
  /** 持久 KV 句柄（仅在未传 `store` 时用于构造默认 `WorktreeStore`）。 */
  kv?: WorktreeKvHandles
  /** 可选注入统一存储实例（WorktreeIsolation 共享同一存储，免循环引用）。 */
  store?: WorktreeStore
  redact?: (text: string) => string
  isConversationWorking?: (conversationId: number) => boolean
  isPathInUse?: (nodeId: string, path: string) => boolean
  inspectPathUsage: (
    nodeId: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<NodePathUsage>
}

export interface AllocateInput {
  nodeId: string
  sourceCwd: string
  parentConversationId: number
  labelHint?: string
  signal?: AbortSignal
  beforeCreate?: (pending: {
    nodeId: string
    repoRoot: string
    path: string
    branch: string
    baseCommit: string
    dirtySource: boolean
  }) => Promise<void>
}

export interface CleanupInput {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
  mergedInto?: string
  deleteBranch?: boolean
  force?: boolean
  /** 仅在目标节点不支持进程占用扫描（path_usage_not_supported）时显式承担风险放行；不会跳过 Linux 扫描或任何其他检查。 */
  allowUnverifiedUsage?: boolean
  /** 仅内部动作上下文注入的调用方插件 ID（由宿主盖章提供，不暴露在公开 Schema）。 */
  callerPluginId?: string
  signal?: AbortSignal
}

export interface CleanupResult {
  removed: boolean
  worktreeId: string
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
  /** 常规移除路径上的进程占用校验结果（幂等跳过与目录缺失恢复路径缺省）。 */
  processUsage?: 'verified' | 'unverified'
  /** 仅当 processUsage === 'unverified' 时的简短脱敏审计说明。 */
  processUsageNote?: string
  /** 登记清除原因（仅目录缺失下 force 恢复路径设置）。 */
  removedReason?: 'directory_missing_forced'
  /** `git worktree prune` 执行结果（仅目录缺失 force 恢复路径；ran=false 表示记录无 repoRoot 锚点未执行）。 */
  prune?: { ran: boolean; ok: boolean; output?: string }
}
