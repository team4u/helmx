/**
 * worktree 隔离编排与 spawn 流程共享契约类型（独立叶模块，断开双向类型依赖）。
 */
import type { AgentExecutionInfo, NodePathUsage } from '@helmx/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { WorktreeKvHandles } from './worktree-store.js'

export interface AcquireWorktreeInput {
  conversationId: number
  parentConversationId: number
  profileId?: string
  requestNodeId?: string
  requestCwd?: string
  fork?: boolean
  hold: {
    pluginId: string
    holdId: string
    label: string
  }
}

export interface AcquireWorktreeResult {
  worktreeId: string
  path: string
  branch: string
  baseCommit: string
  nodeId: string
}

export interface WorktreeIsolationDeps {
  host: {
    resolveSpawnTarget(input: {
      parentConversationId: number
      profileId?: string
      requestNodeId?: string
      requestCwd?: string
      fork?: boolean
    }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
    execEnv(
      req: { command: string | string[]; nodeId?: string; cwd?: string; timeoutMs?: number },
      opts?: { signal?: AbortSignal },
    ): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }>
    executionEnv(nodeId: string, cwd: string): ExecutionEnv
    inspectNodePathUsage(input: { nodeId: string; path: string; signal?: AbortSignal }): Promise<NodePathUsage>
    listActiveSpawnExecutions(): AgentExecutionInfo[]
    redact(text: string): string
    getConversation(id: number): { cwd: string; nodeId?: string; status: string; profileId?: string }
    readonly isClosing?: boolean
  }
  kv: WorktreeKvHandles
}
