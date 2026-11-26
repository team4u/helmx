/**
 * 内置插件间共享编排契约（非 protocol 核心）。
 *
 * 本模块是编排业务形状的唯一权威定义，消费方为 builtin:workflow（引擎 /
 * 隔离层 / steer / 客户端投影）与 builtin:worktree。内核 envelope（@helmx/protocol）只保留通用字段与
 * 命名空间 meta（JSON-safe），不理解以下任何业务结构：
 * - workflow 运行 / 节点 / 进度 / 保存定义与文档形状（迁自 protocol workflow.ts）；
 * - 受管 worktree 清理契约（迁自 protocol worktree.ts）；
 * - AgentSpawnRequest.meta / AgentExecutionInfo.meta 的 'builtin:workflow' 与
 *   'builtin:worktree' 命名空间业务形状（runId / 派生深度上限 / worktree 描述）及其边界校验。
 *
 * 纪律：本模块只做形状定义与边界校验（复用 @helmx/protocol 的 AJV 基础设施），
 * 不携带运行时服务；业务值在消费方边界用这里的 schema 显式验证，非法输入
 * 显式拒绝、诊断不退化。protocol 不再出口这些类型。
 */
import { HelmxError, sanitizeAgentNamespacedMeta, validateOrThrow, type AgentExecutionInfo, type AgentNamespacedMeta, type JsonSafeObject, type JsonSafeValue, type JsonSchema } from '@helmx/protocol'
import { isAbsoluteAgentPath } from '@helmx/protocol'
import type {
  WorkflowNodeState,
  WorkflowNodeStatus,
  WorkflowProgressEntry,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorktreeExecutionDescriptor,
} from './contracts-types.js'

export type {
  WorkflowNodeState,
  WorkflowNodeStatus,
  WorkflowProgressEntry,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorktreeExecutionDescriptor,
}

// ---------------------------------------------------------------------------
// workflow 运行 / 定义 / 投影契约（迁自 @helmx/protocol workflow.ts）
// ---------------------------------------------------------------------------

/** builtin:workflow/list 动作返回的已保存工作流摘要。 */
export interface SavedWorkflowSummary {
  name: string
  path?: string
  /** 定义文件最后修改时间（epoch ms；真实 fs stat，非缓存副本）。 */
  updatedAt: number
  /** 定义文件字节数（真实 fs stat）。 */
  size: number
  /** 元数据校验失败时保留目录条目，并显式返回诊断。 */
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** builtin:workflow/get 动作返回的完整定义（只读源码 + 元数据 + 文件事实）。 */
export interface SavedWorkflowDetail extends SavedWorkflowSummary {
  /** 完整脚本源码：仅供只读展示与 AI 读取；Web 端不提供编辑能力。 */
  script: string
}

/** builtin:workflow/save 动作入参。 */
export interface WorkflowSaveRequest {
  /** 完整脚本源码。 */
  script: string
  /** 保存名称；缺省用 meta.name，与 meta.name 不一致时显式拒绝。 */
  name?: string
  /** 覆盖同名定义（默认拒绝，显式 true 才覆盖）。 */
  overwrite?: boolean
}

/** builtin:workflow/save 动作结果（保存后按真实 fs 重新构建的摘要）。 */
export interface WorkflowSaveResult {
  /** true 新建；false 显式 overwrite 覆盖了既有定义。 */
  created: boolean
  workflow: SavedWorkflowSummary
}

/** builtin:workflow/delete 动作结果（只删除定义文件，历史 run 记录不受影响）。 */
export interface WorkflowDeleteResult {
  deleted: true
  name: string
  path: string
}

/** 工作流引擎运行请求（经 builtin:workflow 动作或内核编排调用）。 */
export interface WorkflowRunRequest {
  /** 已保存工作流的名称。name、script、scriptPath 必须恰好提供一个。 */
  name?: string
  script?: string
  scriptPath?: string
  /** 可选展示名（显式覆盖脚本 meta.name / scriptPath 基名）。 */
  label?: string
  /** 原样传给脚本 args，不限于对象。 */
  args?: unknown
  resumeFromRunId?: string
  /** 目标会话；新 run 必须明确指定，resume 省略时沿用原 run 的会话。 */
  conversationId?: number
}

/**
 * 受管子代理（含 subagent、工作流节点与 Swarm 成员）默认派生深度上限：主会话为第 0 层，
 * 主会话直接派生的第 1 层默认即为编排叶子（不可再派生子代理或工作流）。
 * 派生请求（spawn meta 的 'builtin:workflow' 命名空间 maxSubagentDepth）与
 * `builtin:workflow` 插件配置可显式授予更深（1..HARD_MAX_SUBAGENT_DEPTH）。
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1 as const

/**
 * 派生深度绝对上限：插件配置与 spawn meta maxSubagentDepth 的共同
 * 校验边界（越界显式拒绝，防失控递归派生）。
 */
export const HARD_MAX_SUBAGENT_DEPTH = 5 as const

/**
 * 跨插件会话深度能力契约（由 builtin:swarm 等派生子会话的插件提供，builtin:workflow 统一消费）：
 * 查询指定会话是否为受管派生会话及其当前深度（非受管返回 undefined）。
 */
export const CONVERSATION_DEPTH_CAPABILITY_ID = 'helmx.conversation-depth' as const

export interface ConversationDepthFact {
  /** 会话当前派生深度（主会话为 0，直接派生子成员为 1）。 */
  depth: number
  /** 可选：强制收口为当前深度叶子（如 forkFrom 分叉成员，即使全局上限更高也不继续派发）。 */
  leaf?: boolean
}

export interface ConversationDepthCapability {
  depthOf(conversationId: number): ConversationDepthFact | undefined
}

/** 内置编排插件 ID、托管技能 ID 与公共运行态文档名。 */
export const WORKFLOW_PLUGIN_ID = 'builtin:workflow' as const
export const WORKFLOW_SKILL_ID = 'workflow' as const
export const WORKFLOW_RUNS_DOC = 'runs' as const

/** 全局紧凑角标文档名（仅每会话 count/tone/footerText，不含完整 run 摘要）。 */
export const WORKFLOW_RUN_BADGES_DOC = 'run-badges' as const

interface WorkflowConversationBadgeSummary {
  count: number
  tone?: 'warn' | 'accent' | 'neutral'
  footerText?: string
}

/** `builtin:workflow` 会话级文档 `runs` 的分片快照（当前会话及后代的 run，保留直接归属）。 */
export interface WorkflowRunSessionDocState {
  runs: WorkflowRunSummary[]
}

/** `builtin:workflow` 全局紧凑角标文档 `run-badges` 的结构化快照。 */
export interface WorkflowRunBadgesDocState {
  byConversation: Record<string, WorkflowConversationBadgeSummary>
}

// ---------------------------------------------------------------------------
// spawn / execution meta 的 'builtin:workflow' / 'builtin:worktree' 命名空间业务形状与边界校验
// ---------------------------------------------------------------------------

/**
 * 编排命名空间键：AgentSpawnRequest.meta 中归 builtin:workflow 所有的业务槽（runId / 派生深度上限）。
 */
export const WORKFLOW_META_NAMESPACE = WORKFLOW_PLUGIN_ID

/**
 * 受管工作树命名空间键：AgentExecutionInfo.meta 中归 builtin:worktree 所有的
 * worktree 业务槽（隔离描述）。
 */
export const WORKTREE_PLUGIN_ID = 'builtin:worktree' as const
export const WORKTREE_META_NAMESPACE = WORKTREE_PLUGIN_ID

/** spawn meta 业务形状（meta['builtin:workflow']；派生请求侧）。 */
type WorkflowSpawnMeta = {
  /** 发起本次派生的 run ID（引擎注入）。 */
  runId?: string
  /**
   * 显式授予本次派生子代理子树的派生深度上限（1..HARD_MAX_SUBAGENT_DEPTH）。
   * 缺省继承父会话生效上限；受管子代理不能提高继承的上限（由 depth 守卫
   * 钩子校验，本 schema 只做形状与硬上限校验）。
   */
  maxSubagentDepth?: number
}

/** execution meta 业务形状（meta['builtin:worktree']；onResolved 回传侧，仅隔离工作树描述）。 */
export type WorktreeExecutionMeta = {
  /** isolation: 'worktree' 兑现后的隔离工作树描述。 */
  worktree?: WorktreeExecutionDescriptor
}

const workflowSpawnMetaSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1 },
    maxSubagentDepth: { type: 'integer', minimum: 1, maximum: HARD_MAX_SUBAGENT_DEPTH },
  },
}

/**
 * 读取并校验 spawn meta 的 workflow 命名空间业务值（消费方边界）：
 * 缺失命名空间返回空对象；存在即按 schema 严格校验（未知字段 / 越界深度 /
 * 空 runId 显式拒绝，不静默丢弃）。envelope（JSON-safe）在消费方边界复验：
 * spawnAgent 入口与原生执行行入口的校验不覆盖 around continuation / transform
 * 改写后的中间窗口，本函数是业务消费前的最后防线（坏 envelope 显式拒绝，
 * 绝不把损坏 meta 静默当空）。
 */
export function parseWorkflowSpawnMeta(meta: AgentNamespacedMeta | undefined): WorkflowSpawnMeta {
  if (meta === undefined) return {}
  const sanitized = sanitizeAgentNamespacedMeta(meta, {
    agentId: WORKFLOW_META_NAMESPACE,
    field: "spawn request meta",
  })
  const slot = sanitized[WORKFLOW_META_NAMESPACE]
  if (slot === undefined) return {}
  validateOrThrow(
    workflowSpawnMetaSchema,
    slot,
    `spawn meta['${WORKFLOW_META_NAMESPACE}'] 业务值非法`,
    'validation_error',
    400,
  )
  return slot as unknown as WorkflowSpawnMeta
}

/**
 * 合并写入 spawn meta 的 workflow 命名空间业务值（生产方辅助；返回新对象，
 * 保留其他命名空间与既有业务键）。值为 undefined 的键不写入。
 */
export function withWorkflowSpawnMeta(
  meta: AgentNamespacedMeta | undefined,
  patch: WorkflowSpawnMeta,
): AgentNamespacedMeta {
  const existing = meta?.[WORKFLOW_META_NAMESPACE] ?? {}
  const next: { [key: string]: JsonSafeValue | undefined } = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }
  return { ...(meta ?? {}), [WORKFLOW_META_NAMESPACE]: next }
}

function metaInvalidError(namespace: string, reason: string): HelmxError {
  return new HelmxError(
    'meta_invalid',
    `execution meta['${namespace}'] 业务值非法：${reason}`,
    502,
    { namespace, reason },
  )
}

/** 校验并克隆受管 worktree 描述（绝对路径 / 非空分支 / 可选登记字段）。 */
function sanitizeWorktreeDescriptor(value: unknown): WorktreeExecutionDescriptor {
  const err = (reason: string): HelmxError => metaInvalidError(WORKTREE_META_NAMESPACE, reason)
  const source = value as Partial<WorktreeExecutionDescriptor> | null
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.path !== 'string' ||
    source.path.length === 0 ||
    !isAbsoluteAgentPath(source.path) ||
    typeof source.branch !== 'string' ||
    source.branch.length === 0
  ) {
    throw err('worktree 必须是 { path: 绝对路径, branch: 非空 }')
  }
  const out: WorktreeExecutionDescriptor = { path: source.path, branch: source.branch }
  for (const key of ['id', 'repoRoot', 'baseCommit', 'baseBranch', 'parentWorktreeId'] as const) {
    const field = source[key]
    if (field !== undefined) {
      if (typeof field !== 'string' || field === '' || (key === 'repoRoot' && !isAbsoluteAgentPath(field))) {
        throw err(`worktree.${key} 非法`)
      }
      out[key] = field
    }
  }
  if (source.dirtySource !== undefined) {
    if (typeof source.dirtySource !== 'boolean') throw err('worktree.dirtySource 必须是布尔值')
    out.dirtySource = source.dirtySource
  }
  return out
}

/**
 * 读取并校验 execution meta 的 worktree 命名空间业务值（消费方边界）。
 * 入参为已过内核 envelope 校验的 AgentExecutionInfo；命名空间缺失返回
 * 空对象；存在即严格校验 worktree 描述形状，坏值显式拒绝、绝不静默丢弃。
 */
export function extractWorktreeExecutionMeta(info: AgentExecutionInfo): WorktreeExecutionMeta {
  if (info.meta === undefined) return {}
  // envelope 复验（与 parseWorkflowSpawnMeta 同理）：不信任中间链改写后的
  // 形状，坏 envelope 在业务消费前显式拒绝。
  const sanitized = sanitizeAgentNamespacedMeta(info.meta, {
    agentId: WORKTREE_META_NAMESPACE,
    field: 'onResolved meta',
  })
  const slot = sanitized[WORKTREE_META_NAMESPACE]
  if (slot === undefined) return {}
  if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) {
    throw metaInvalidError(WORKTREE_META_NAMESPACE, '命名空间的值必须是普通对象')
  }
  for (const key of Object.keys(slot)) {
    if (key !== 'worktree') {
      throw metaInvalidError(WORKTREE_META_NAMESPACE, `未知字段 "${key}"`)
    }
  }
  const out: WorktreeExecutionMeta = {}
  const raw = slot as Record<string, unknown>
  if (raw['worktree'] !== undefined) out.worktree = sanitizeWorktreeDescriptor(raw['worktree'])
  return out
}

/**
 * 构造/合并 execution meta 的 worktree 命名空间（生产方辅助；隔离层回填
 * 受管登记 id 时使用）。传入 existing 时合并进既有 meta：其他命名空间
 * 经 envelope sanitizer 防御性克隆/校验后原样保留；worktree 命名空间按
 * 键覆盖合并（未提及的既有键保留），给其他插件链留出的命名空间不因本轮写
 * 入丢失。
 */
export function worktreeExecutionMeta(
  value: WorktreeExecutionMeta,
  existing?: AgentNamespacedMeta,
): AgentNamespacedMeta {
  const merged: Record<string, JsonSafeObject> =
    existing === undefined
      ? {}
      : { ...sanitizeAgentNamespacedMeta(existing, {
          agentId: WORKTREE_META_NAMESPACE,
          field: 'execution meta 合并基底',
        }) }
  const previous = merged[WORKTREE_META_NAMESPACE] ?? {}
  const slot: { [key: string]: JsonSafeValue | undefined } = { ...previous }
  if (value.worktree !== undefined) slot['worktree'] = value.worktree
  merged[WORKTREE_META_NAMESPACE] = slot as JsonSafeObject
  return merged
}
// ---------------------------------------------------------------------------
// 受管 Git Worktree 共享契约（builtin:worktree 真源产出，builtin:swarm 等跨插件消费）
// ---------------------------------------------------------------------------

/** 跨回合持久持有锁（供上层协同插件阻止空闲期 worktree 被误清理）。 */
export interface ManagedWorktreeHold {
  /** 持有锁的插件 ID（如 'builtin:swarm'）。 */
  pluginId: string
  /** 插件内稳定持有标识（如 '<groupId>:<workerName>'）。 */
  holdId: string
  /** 面向拒绝诊断与列表展示的可读说明（写入前经 redact 脱敏）。 */
  label: string
  acquiredAt: number
}

/** 单条受管 worktree 记录。 */
export interface ManagedWorktreeRecord {
  /** 唯一标识（`${nodeId}:${path}`）。 */
  id: string
  nodeId: string
  /** 主工作树路径（权威 `git worktree list` 首条登记）。 */
  repoRoot: string
  path: string
  branch: string
  baseCommit: string
  /** 创建时源目录检出的本地分支名（detached HEAD 时缺省）。 */
  baseBranch?: string
  /** 源目录本身是受管 Worktree 时记录其登记 ID（多级派生父子关系）。 */
  parentWorktreeId?: string
  dirtySource: boolean
  parentConversationId: number
  conversationId?: number
  origin: 'native'
  status: 'active' | 'removed'
  createdAt: number
  removedAt?: number
  /** 登记清除原因（目录缺失下 force 恢复路径：复核确证缺失后清除登记，git 侧经 prune 收敛）。 */
  removedReason?: 'directory_missing_forced'
  /** 分支是否已删除（worktree 已移除但分支删除部分失败时为 false，可重试 cleanup deleteBranch）。 */
  branchDeleted?: boolean
  /** 分支删除失败的最后诊断（已脱敏；重试成功后清除）。 */
  branchDeleteError?: string
  /** 清理时目标节点不支持进程占用扫描，调用方通过 allowUnverifiedUsage 显式承担风险放行时置为 true。 */
  unverifiedUsage?: true
  /** 可选持久持有锁（活跃期间即便是 force: true 清理也显式拒绝）。 */
  hold?: ManagedWorktreeHold
}

/** builtin:worktree inspect_worktree 只读检视结果契约。 */
export interface WorktreeInspectResult {
  record: ManagedWorktreeRecord
  exists: boolean
  unavailableReason?: 'removed' | 'directory_missing'
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  dirtyFiles: string[]
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  commitsAhead?: number
  /** 相对目标合入参考提交（baseBranch 优先，回退主工作树 HEAD）仍未合入的提交数。 */
  unmergedCommits?: number
  diffStat?: string
  diffPreview?: string
  diffTruncated: boolean
  diffBase: 'baseCommit' | 'HEAD'
}

/** builtin:worktree acquire_worktree 动作返回结果契约。 */
export interface AcquireWorktreeResult {
  worktreeId: string
  path: string
  branch: string
  baseCommit: string
  nodeId: string
}
