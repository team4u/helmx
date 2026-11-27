/**
 * Browser-safe pure DTO types shared by builtin:workflow client UI surfaces and
 * `contracts.ts` (imports ONLY `@helmx/protocol/browser`, keeping client typechecks free
 * of server-only SDK/TypeBox declarations).
 */
import type { AgentGateResult } from '@helmx/protocol/browser'
export * from './git-diff/git-diff-types.js'

export const CHANGES_PLUGIN_ID = 'builtin:changes' as const
export const CHANGES_SCREEN_ID = 'inspector' as const
export const CHANGES_PANEL_ID = 'changes' as const

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted'

/** 受管 worktree 描述（execution meta 业务形状）。 */
export type WorktreeExecutionDescriptor = {
  /** worktree 绝对路径。 */
  path: string
  branch: string
  /** Helmx 受管登记 ID；供 cleanup_worktree 精确定位。 */
  id?: string
  repoRoot?: string
  baseCommit?: string
  /** 创建 Worktree 时源目录检出的本地分支名（detached HEAD 时缺省）。 */
  baseBranch?: string
  /** 源目录本身是受管 Worktree 时记录其 worktreeId（多级派生父子关系）。 */
  parentWorktreeId?: string
  dirtySource?: boolean
}

/** DAG 单节点状态（agent / action / gate / script 等统一形状）。 */
export interface WorkflowNodeState {
  id: string
  /** 节点类型：'agent' | 'action' | 'gate' | 'script' 等。 */
  kind: string
  status: WorkflowNodeStatus
  /** 直接复用成功账本结果，未新建执行上下文。HTTP、CLI 与事件使用同一字段。 */
  cached?: boolean
  /** agent 节点的执行 Profile ID。 */
  agentType?: string
  /** 展示名（脚本 label / 派生描述）。 */
  label?: string
  /** 实际执行节点。 */
  nodeId?: string
  /** agent 节点实际执行的会话 ID。 */
  conversationId?: number
  /** 外部运行时执行标识（保留供第三方扩展使用）。 */
  executionId?: string
  /** 实际生效工作目录。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 分配的隔离工作树（见 WorktreeExecutionDescriptor）。 */
  worktree?: WorktreeExecutionDescriptor
  phaseIndex?: number
  phaseTitle?: string
  /** agent 节点的原始提示词（审计/重放展示用）。 */
  prompt?: string
  /** 结构化输出 JSON Schema。 */
  schema?: Record<string, unknown>
  /** 脚本声明的 gate 验收命令原文。 */
  gateCommand?: string
  /** gate 执行结果（已在执行环境内恰好一次执行）。 */
  gate?: AgentGateResult
  /** 节点实际或请求的模型标识。 */
  model?: string
  /** 节点执行尝试次数（重试时 > 1）。 */
  attempt?: number
  tokens?: number
  durationMs?: number
  startedAt?: number
  settledAt?: number
  /** 结构化输出（Schema 校验通过后）。 */
  output?: unknown
  error?: string
}

/**
 * 观察用进度行（inspect / Web 检查器渲染）。
 * agent 与 action 节点的权威状态在 `WorkflowRunSummary.nodes`；
 * 这里只保留 phase 声明与脚本 log 两类时间线事件。
 */
export type WorkflowProgressEntry =
  | { at: number; kind: 'phase'; index: number; title: string }
  | { at: number; kind: 'log'; message: string }

/** builtin:workflow 的 run/runs/inspect 动作与会话投影使用的运行摘要。 */
export interface WorkflowRunSummary {
  id: string
  name: string
  conversationId: number
  /** run 种类：DSL 编排工作流（缺省/'workflow'）或后台单子代理（'subagent'）。 */
  kind?: 'workflow' | 'subagent'
  /** 触发本次 run 的已保存工作流名（按保存定义重跑的稳定入口；内联脚本无此字段）。 */
  savedName?: string
  /** 脚本 meta.description 描述。 */
  description?: string
  /** 脚本 meta.phases 声明的阶段蓝图。 */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /**
   * 触发本次 run 的父会话 SubagentWorkflow 工具调用 ID（内核受信注入，
   * 非用户可写字段；HTTP/CLI 仅输出透传）。前端据此精确关联运行卡。
   */
  parentToolCallId?: string
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  /** 首次进入终态（completed / failed / aborted）的时间戳（epoch ms）；后续 notifiedAt / resumedByRunId 写回不覆盖，用于防耗时漂移。 */
  settledAt?: number
  result?: unknown
  error?: string
  /** 结构化错误码（如 validation_error / workflow_action_uncertain / crash_recovery_limit 等；取代错误文本子串猜测）。 */
  errorCode?: string
  /** 引擎权威判定的可续跑标记（仅 status='failed' 且账本/规格完整可恢复且未被活跃接管时为 true）。 */
  resumable?: boolean
  /** 投影分片瘦身：runs 会话分片剥离大体积原始 result 时保留的单行截断预览与存在标记（完整 result 经 inspect 动作按需读取）。 */
  resultPreview?: string
  hasResult?: boolean
  nodes?: WorkflowNodeState[]
  /** 观察用时间线（phase / log）；跨重启从 summary 旁文件恢复。 */
  progress?: WorkflowProgressEntry[]
  /** 从 journal 前缀重放恢复的 run 携带的源 run ID。 */
  replayedFrom?: string
  /** 已被新续跑 run 接管的源记录标识，供前端隐藏重复恢复入口。 */
  resumedByRunId?: string
  /**
   * 账本记账失败的诊断明细（agent 行写失败；恢复重放的损行计数）。
   * 只读诊断面：只影响下次 resume 的重放优化，不影响本次 run 结果；
   * HTTP/CLI/Web 仅透传展示，不据其做任何重放决策。
   */
  journalIoErrors?: string[]
}
