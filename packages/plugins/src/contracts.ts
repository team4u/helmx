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
import { HelmxError, sanitizeAgentNamespacedMeta, validateOrThrow, type AgentExecutionInfo, type AgentGateResult, type AgentNamespacedMeta, type JsonSafeObject, type JsonSafeValue, type JsonSchema } from '@helmx/protocol'
import { isAbsoluteAgentPath } from '@helmx/protocol'

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

/** builtin:workflow/save 动作入参：script / fromRunId 恰好提供一个。 */
export interface WorkflowSaveRequest {
  /** 完整脚本源码（与 fromRunId 二选一）。 */
  script?: string
  /** 把既有运行持久化的脚本源固化为定义（与 script 二选一；不可用于 subagent run）。 */
  fromRunId?: string
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

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted'

type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

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
  /** 结构化错误码（如 validation_error / workflow_action_uncertain / crash_recovery_limit / secret_grant_expired_on_restart 等；取代错误文本子串猜测）。 */
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
  /**
   * 前台同步标记：经同步工具（background:false / 自动化缺省）启动的 run，
   * 父回合工具调用正阻塞等待；此状态下可被 detach 动作转入后台。
   */
  syncForeground?: boolean
  /** detach 转后台时间戳（转后台即视为后台 run，不可再次 detach）。 */
  detachedAt?: number
}

/**
 * 受管子代理默认派生深度上限：主会话直接派生的一层子代理默认可继续派生
 * 二层（1 → 2），达到上限的会话即编排叶子。派生请求（spawn meta 的
 * 'builtin:workflow' 命名空间 maxSubagentDepth）与插件配置可显式授予更深。
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2 as const

/**
 * 派生深度绝对上限：插件配置与 spawn meta maxSubagentDepth 的共同
 * 校验边界（越界显式拒绝，防失控递归派生）。
 */
export const HARD_MAX_SUBAGENT_DEPTH = 5 as const

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
