/**
 * PluginHost 唯一强类型插件契约：definePlugin(ctx)。
 * 后端 4 个可组合生命周期 Hook（input / before_turn / agent_spawn / turn_settled）
 * + ctx.action 单点 Schema 五端复用 + 前端 10 个全界面扩展点 + 宿主运行时 API。
 * 本文件只定义类型，不含任何运行时；动作合法性（如仅 input 允许 block、
 * before_turn 只允许原地改写）由 host 在运行时校验。
 */

import type { Provider } from '@earendil-works/pi-ai'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { Duplex } from 'node:stream'
import type { AskCreateSpec, AskResult } from './ask.js'
import type {
  ConversationDetail,
  ConversationInit,
  ConversationInput,
  ConversationListFilter,
  ConversationOwnership,
  ConversationPatch,
  ConversationScope,
  ConversationSubmissionInfo,
  ConversationSummary,
  InputOrigin,
  TurnSettledPayload,
  WhenBusy,
} from './conversation.js'
import type { ArtifactMetadata } from './artifact.js'
import type { Profile, SkillSummary, ModelCatalog, ModelProvidersRefreshResult, ModelTierSpec } from './assets.js'
import type {
  EnvExecRequest,
  EnvExecResponse,
  NodeInfo,
  NodePathUsage,
  NodeTunnelTarget,
} from './env-rpc.js'
import type { HostEventEmitPayload, HostEventMap } from './events.js'
import type { PluginUiContribution, PluginUiRegistry } from './ui.js'
import type { AgentNamespacedMeta } from './meta.js'
import type { ExecutionText, LocalizedText } from './locale.js'
import type {
  ActionManifest,
  AgentExecutionInfo,
  AgentGateResult,
  ExternalTriggerEnvelope,
  GuardedMutationExpectation,
  HookName,
  JsonSchema,
  MaybePromise,
  PluginActionCliSpec,
  PluginActionVisibility,
  PluginConfigFieldSchema,
  PluginDocOptions,
  PluginInUseItem,
  PluginPromptFields,
  PluginSummary,
  PluginToolTextBlock,
} from './plugin-dto.js'

export * from './plugin-dto.js'

// ---------------------------------------------------------------------------
// Hook 管道：4 个挂载点（input / before_turn / agent_spawn / turn_settled）
// ---------------------------------------------------------------------------

/** input 钩子载荷。 */
export interface InputHookPayload {
  conversationId: number
  input: ConversationInput
}

/** before_turn 钩子载荷：原地修改 tools / sections / messages。 */
export interface BeforeTurnHookPayload {
  conversation: ConversationSummary
  inputs: ConversationInput[]
  tools: PluginToolSpec[]
  /** 注入系统提示词的命名段落。 */
  sections: Array<{ id: string; text: string }>
  /** 原始消息数组（pi-durable entry 形状，保持透明）。 */
  messages: Array<Record<string, unknown>>
}

/**
 * 子代理派生请求：agent_spawn 钩子载荷。
 * 内核默认走 pi-durable 原生子会话；isolation/worktree 等执行环境要求由插件层经
 * next(request) 改写最终请求兑现（内核零 Git 语义，不按业务分支）。
 */
export interface AgentSpawnRequest {
  parentConversationId: number
  /** 发起本次派生的父会话工具调用 ID（可选，供原生子会话登记实时关联）。 */
  parentToolCallId?: string
  prompt: string
  /**
   * 新建子会话的可选显示标题（经裁剪、脱敏并截断至 120 字符；为空或省略时沿用 `subagent <id>`；
   * `resume` / `reattach` 场景忽略本字段，保留既有标题）。
   */
  title?: string
  /** 编排宿主分配的稳定调用标识，用于续接与取消。 */
  agentId?: string
  /** Profile ID（原生子会话）。 */
  agentType?: string
  model?: string
  effort?: string
  /**
   * 执行环境隔离要求（插件层策略 metadata，如 'worktree'）。
   * 内核不解释该值：由具备对应能力的插件经 agent_spawn continuation 改写
   * 最终请求的 cwd/元数据兑现；无插件兑现而原样到达原生执行行时显式
   * unsupported_runtime（绝不静默忽略）。
   */
  isolation?: string
  /**
   * 执行环境确定后回传；编排宿主据此把 conversationId / worktree 等元数据写回节点状态。
   */
  onResolved?: (info: AgentExecutionInfo) => void
  /** gate 命令由实际执行环境内恰好一次执行后回传结果；宿主引擎可免二次执行。 */
  onGateResult?: (result: AgentGateResult) => void
  /**
   * 命名空间业务扩展（机制面）：键为声明方插件 ID（如 'builtin:workflow'），
   * 值为该插件私有的 JSON-safe 对象（runId / 派生深度上限等业务字段）。内核
   * 只校验 envelope（JSON-safe、有界、无函数/循环），不解释任何命名空间
   * 内容；各命名空间业务值由其所有方插件在边界用自身 schema 验证（非法
   * 显式拒绝）。改写请求的 agent_spawn continuation 应原样透传未消费的
   * 命名空间。
   */
  meta?: AgentNamespacedMeta
  /**
   * 可选目标计算节点 ID（如 `'local'` 或已注册远端节点；与 `resume` 互斥）。
   * 显式传入时优先级最高（显式 `'local'` 可覆盖远端父会话或 Profile 绑定）；
   * 跨节点派生时抑制其他节点的父会话 `cwd` 与节点不匹配的 `Profile.cwd`，
   * 目标为远端节点且无可用 `cwd` 时显式拒绝（400 validation_error）。
   */
  nodeId?: string
  cwd?: string
  /** 结构化输出 JSON Schema（文件交接时强制落盘校验）。 */
  schema?: JsonSchema
  /** Shell 验收门禁命令；唯一命令来源，宿主不得另行叠加。 */
  gate?: string
  /**
   * 单次门禁命令超时毫秒数（可选，缺省由执行方默认 120_000，上限 600_000）。
   * 原生执行行的 runGate 消费：超时终止整个进程组并按门禁失败如实回传
   * （AgentGateResult.exitCode=null、timedOut=true）。
   */
  gateTimeoutMs?: number
  /** 续接既有子代理的标识。 */
  resume?: string
  /**
   * Optional cross-restart idempotent submission key: passed through by the native execution
   * runner to pi-durable `conversation.submit({ requestId })`, returning the existing durable
   * SubmissionHandle on duplicate submission without appending duplicate input messages.
   */
  requestId?: string
  /**
   * Optional cross-restart in-place reattach target (mutually exclusive with `resume` and
   * `fork`): references a native child conversation created before restart so the caller
   * can wait for its in-flight turn to settle and run schema/gate verification.
   */
  reattach?: {
    conversationId: number
    effectiveCwd?: string
  }
  /**
   * 从父会话当前已完成上下文分叉派生原生子会话（可选，缺省 false；与 resume 互斥）。
   */
  fork?: boolean
  /** 随本次子代理派生传递的产物 ID 列表。 */
  attachments?: string[]
  /** 取消信号，由宿主注入。 */
  signal?: AbortSignal
}

/** 每个钩子的完整载荷类型映射。 */
export interface HookPayloadMap {
  input: InputHookPayload
  before_turn: BeforeTurnHookPayload
  agent_spawn: AgentSpawnRequest
  turn_settled: TurnSettledPayload
}

/**
 * Hook 处理器返回值：
 * - continue  放行
 * - transform 原地改写载荷交由后续处理器与内核消费
 * - handled   短路接管，终止默认行为（result 为接管产物）
 * - block     门控拦截（仅 input 允许，由 host 运行时校验）
 */
export type HookResult<TPayload, TResult = unknown> =
  | { action: 'continue' }
  | { action: 'transform'; value: TPayload }
  | { action: 'handled'; result?: TResult }
  | { action: 'block'; reason: string }

/** 同步或异步处理器；返回 void 等价于 continue。
 *
 * agent_spawn 额外提供受控 continuation（第二参数 next）：
 * - 不调用 next 而返回 handled = 完全接管；
 * - await next(finalRequest) = around 包裹：宿主恰好一次执行后续管道与默认
 *   原生执行行（finalRequest 为 transform 后的最终请求）；插件可在 next 前
 *   分配资源、在 next 后按成败收敛（finally 语义）；
 * - next 仅可调用一次：重复调用或与 handled/transform 混用将显式拒绝；
 * - 包裹期间抛错：错误如实上抛（宿主不吞），next 前抛错则后续管道不执行。
 */
export type HookHandler<K extends HookName> = K extends 'agent_spawn'
  ? (
      payload: HookPayloadMap[K],
      next: (request: AgentSpawnRequest) => Promise<unknown>,
    ) => MaybePromise<HookResult<HookPayloadMap[K]> | void> | Promise<unknown>
  : (payload: HookPayloadMap[K]) => MaybePromise<HookResult<HookPayloadMap[K]> | void>

export type InputHookHandler = HookHandler<'input'>
export type BeforeTurnHookHandler = HookHandler<'before_turn'>
export type AgentSpawnHookHandler = HookHandler<'agent_spawn'>
export type TurnSettledHookHandler = HookHandler<'turn_settled'>

export interface HookOptions {
  /** 优先级，默认 0；数值大的先执行。 */
  priority?: number
}

export interface PluginHookRegistry {
  onInput(fn: InputHookHandler, opts?: HookOptions): void
  onBeforeTurn(fn: BeforeTurnHookHandler, opts?: HookOptions): void
  onAgentSpawn(fn: AgentSpawnHookHandler, opts?: HookOptions): void
  onTurnSettled(fn: TurnSettledHookHandler, opts?: HookOptions): void
}

// ---------------------------------------------------------------------------
// ctx.action：单点 Schema，HTTP / CLI / Agent Tool / Workflow / Web 五端复用
// ---------------------------------------------------------------------------

/**
 * 动作调用上下文：人工 HTTP/CLI 可无 conversationId；
 * 模型路径（run_action 元工具 / exposeAsTool 派生工具）与 Workflow 路径携带 conversationId，
 * 供宿主校验 scope（防绕过会话作用域）。
 */
export interface PluginActionContext {
  conversationId?: number
  signal?: AbortSignal
  /**
   * 宿主在 `ctx.host.invokeAction` 跨插件调用通道上盖章注入的调用方插件 ID（不可伪造）：
   * 内核严格忽略调用方自填的 `context.callerPluginId`，仅在受信任插件通道上写入真实调用插件 ID；
   * HTTP / CLI / `run_action` / 派生工具路径上恒为 `undefined`。
   */
  readonly callerPluginId?: string
  /**
   * 经 `exposeAsTool` 派生工具路径调用时宿主透传的 SDK tool callId（用于幂等重放去重）；
   * HTTP / CLI / `run_action` / `ctx.host.invokeAction` 路径上恒为 `undefined`。
   */
  readonly callId?: string
}

/**
 * `ctx.action` 派生直投模型工具的结构化配置（单点声明消除 `ctx.tool` + `ctx.action` 重复注册）。
 */
export interface PluginActionToolSpec<TIn = unknown, TOut = unknown> {
  /** 显式 provider-safe 模型工具名（`/^[A-Za-z0-9_-]{1,64}$/`）；缺省自动生成确定性哈希别名。 */
  name?: string
  /** 可选的模型侧工具描述覆写（缺省复用动作的 `description`）。执行文案，须保持语言稳定。 */
  description?: ExecutionText
  /** 跨重启工具重放安全性（透传至 SDK `defineTool({ replay })`，缺省 `'unsafe'`）。 */
  replay?: 'safe' | 'unsafe'
  /**
   * 可选的模型可读文本格式化纯函数：将 `(input, output)` 转为工具 `output` 文本信道；
   * `handler` 继续返回经 `outputSchema` 校验的裸业务对象（透传至 `structuredOutput` 与 HTTP/CLI/Workflow/Web）。
   */
  formatOutput?(input: TIn, output: TOut): string | PluginToolTextBlock[]
}

export interface PluginActionSpec<TIn, TOut> extends PluginPromptFields {
  /** 动作 ID（plugin 内唯一）；映射为 POST /api/actions/:pluginId/:actionId。 */
  id: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  /**
   * 可信可见性级别（默认 `'public'`）：
   * - `'public'`：HTTP / CLI / Web / `run_action` / Workflow / `ctx.host.invokeAction` 全端可达；
   * - `'ui'`：仅限 Web UI / HTTP 与插件间调用；隐藏出 CLI 与 `<available_actions>`，拒绝 `run_action`（执行与 describe）、Workflow DSL 与 `exposeAsTool`；
   * - `'internal'`：仅限插件间 `ctx.host.invokeAction`（携宿主盖章 `callerPluginId`）；不进 `GET /api/actions`，拒绝 HTTP、`run_action`、Workflow DSL、`exposeAsTool` 与 `composer.completer` 绑定。
   */
  visibility?: PluginActionVisibility
  /** CLI 暴露微调；缺省自动挂载为 `helmx <plugin> <action>`。 */
  cli?: PluginActionCliSpec
  /**
   * `true` 或结构化配置对象直接注入模型工具列表（不再重复进入 `<available_actions>`）；
   * 缺省/`false` 经元工具 `run_action` 按需调用。仅 `visibility: 'public'` 可启用。
   */
  exposeAsTool?: boolean | PluginActionToolSpec<NoInfer<TIn>, NoInfer<TOut>>
  /**
   * 可选的有界展示元数据 Schema（仅在启用 `exposeAsTool` 时合法，否则注册期显式拒绝）。
   * 对应由 `projectPresentationMeta` 投影并写入 `pi.tool-result.model[0].details` 的 UI 重放元数据，绝不进入模型提示词。
   */
  presentationMetaSchema?: JsonSchema
  /**
   * 可选纯投影函数（仅在启用 `exposeAsTool` 且声明 `presentationMetaSchema` 时合法）：
   * 保持动作五端返回裸业务对象契约不变，同时为直投模型工具派生有界 UI 展示元数据。
   */
  projectPresentationMeta?(input: NoInfer<TIn>, output: NoInfer<TOut>): Record<string, unknown> | undefined
  /**
   * 非直暴工具公开动作是否展示于 `<available_actions>` 系统提示词目录（默认 true）。
   * 仅供界面或内部插件消费的动作应声明 `visibility: 'ui' | 'internal'`，而非仅靠 `exposeToPrompt: false`。
   */
  exposeToPrompt?: boolean
  /**
   * 该动作是否为幂等/只读操作（默认 false）：
   * - false：中断或失败时账本标记 workflow_action_uncertain，拒绝自动恢复重跑副作用；
   * - true：成功时前缀缓存复用，中断或失败时允许 resumeFromRunId 从该步起安全重跑。
   */
  idempotent?: boolean
  /** 会话作用域：提供 conversationId 的调用（含 run_action/workflow）必须命中才可执行；人工 HTTP/CLI 不受限制。 */
  scope?: ConversationScope
  handler(input: TIn, context: PluginActionContext): MaybePromise<TOut>
}

/** ctx.tool：模型专用工具。 */
export interface PluginToolContext {
  conversationId: number
  /** 当前工具调用 ID（供子会话/工作流绑定 parentToolCallId）。 */
  callId?: string
  signal?: AbortSignal
  /**
   * 流式进度上报（完整 partial 语义，与 SDK ToolExecutionResult 同构）：
   * - output: string | Array<{ type: 'text'; text: string }> —— 至今累计快照
   *   （非增量；宿主对全量脱敏后按差量经 SDK 原生 api.output 转发进 Web
   *   实时工具卡，跨 chunk 拼接的机密不因分片遥漏脱敏）；
   * - isError: true 时提前标记错误态（最终结果仍以 execute 返回为准）；
   * - 结算后的迟到调用静默丢弃；结算前的真实故障显式抛出（不吞）；
   * - 不支持流式的宿主（HTTP 直接调用等）静默丢弃，绝不伪装完成。
   */
  onUpdate?(partial: { output: string | Array<{ type: 'text'; text: string }>; isError?: boolean }): void
}

export interface PluginToolSpec<TIn = Record<string, unknown>> extends PluginPromptFields {
  name: string
  description: string
  inputSchema: JsonSchema
  /** 可选的结构化输出 Schema（面向程序/嵌套调用方；声明后支持返回 `{ output, structuredOutput, isError }`，不再自动镜像到持久化 `details`）。 */
  structuredOutputSchema?: JsonSchema
  /** 可选的有界展示元数据 Schema（声明后支持返回 `{ output, presentationMeta }`，脱敏与有界+Schema 校验后持久化至 `pi.tool-result.model[0].details`，绝不进入模型上下文）。 */
  presentationMetaSchema?: JsonSchema
  /** 会话作用域：工具可见性与 executeTool 的双重过滤条件。 */
  scope?: ConversationScope
  /**
   * Cross-restart replay safety for tool calls (defaults to `'unsafe'`): declare `'safe'`
   * only when the tool implementation guarantees strict durable idempotency per
   * `(conversationId, callId)`. Forwarded by RuntimeToolRegistry to pi-durable `defineTool`.
   */
  replay?: 'safe' | 'unsafe'
  execute(input: TIn, context: PluginToolContext): MaybePromise<unknown>
}

// ---------------------------------------------------------------------------
// 持久状态、后台服务与原始路由
// ---------------------------------------------------------------------------

/**
 * 插件自有持久文档句柄（state.sqlite）；get/set/update 同步镜像，
 * flush 等待底层排队写真正落盘完成（失败显式 reject——镜像已写不等于持久化完成，
 * 副作用执行前必须 await flush 防止「未落盘就派生副作用」）。
 */
export interface PluginDocHandle<T> {
  get(): T
  set(value: T): void
  update(fn: (current: T) => T): void
  /** 等待本 store 全部排队写冲刷完成（同一持久化链，无按文档粒度队列）。 */
  flush(): Promise<void>
}

/** 按会话隔离的持久文档；读写深拷贝，生命周期与全局文档相同。 */
export interface PluginSessionDocHandle<TState = unknown> {
  get(conversationId: number): TState
  set(conversationId: number, value: TState): void
  update(conversationId: number, fn: (current: TState) => TState): void
  delete(conversationId: number): void
  listConversationIds(): number[]
  flush(): Promise<void>
}

export interface PluginServiceSpec {
  id: string
  /**
   * 预备阶段（全局屏障）：宿主在启动任何服务 start() 之前，先等待全部已启用
   * 服务的 prepare() 完成。用于必须先于调度器唤醒/输入提交的恢复标记
   * （如编排引擎的 prepareRecovery）。热启用同样先 prepare 后 start。
   */
  prepare?(): MaybePromise<void>
  start(): MaybePromise<void>
  /**
   * 停止新回调并等待本服务的在途回调收敛。宿主等待 stop 时允许本插件当前
   * 启用周期的 doc 句柄完成最终写入；stop 返回后句柄失效。此窗口不区分
   * 回调的异步来源，服务必须自行取消或等待残留任务，不能在返回后继续写入。
   */
  stop(): MaybePromise<void>
  /** 返回仍需本服务保活的任务标签；宿主在停用/卸载前同步检查。 */
  liveTasks?(): string[]
  /**
   * Post-startup recovery/reconciliation phase: runs after the global `prepare -> start`
   * barrier and kernel scheduler resume (`harness.resume()`), executed strictly in
   * topological order across active plugins (hard `dependencies` + active soft `reconcileAfter`).
   * On hot-enable after host reconciliation has completed, runs immediately after `start()`.
   */
  reconcile?(): MaybePromise<void>
  /**
   * Optional plugin IDs whose `reconcile()` must finish before this service's `reconcile()`
   * whenever those plugins are active. Soft ordering edge only: unregistered or disabled
   * targets are ignored so optional peer ordering never creates hard enable/disable coupling.
   */
  reconcileAfter?: readonly string[]
  /**
   * 声明本服务当前管辖的持久生效资源（非瞬态运行中任务）。
   * 非空时默认阻止停用（409 plugin_in_use），除非调用方显式指定 force: true。
   * 函数抛错时按「未知即占用」原则拒绝停用，绝不静默当空放行。
   */
  inUse?(): MaybePromise<PluginInUseItem[]>
}

/**
 * 插件间类型化能力共享条目（ctx.provide / ctx.consume）。
 */
export interface ProvidedCapability<T = unknown> {
  readonly pluginId: string
  readonly impl: T
}

/** Well-known `'helmx.dispatch-tools'` capability contract: declares tool names unlocking cross-Profile collaboration catalogs. */
export interface DispatchToolsCapability {
  readonly toolNames: readonly string[]
}

/** Well-known `'helmx.model-tiers'` capability contract: provides a live model-tier table consumed by kernel ModelRegistry. */
export interface ModelTiersCapability {
  getTiers(): Readonly<Record<string, ModelTierSpec>>
  /**
   * Optional subscription invoked whenever the provider's tier table mutates.
   * Returning an unsubscribe callback allows kernel consumers to clean up on disable/dispose.
   */
  onChanged?(listener: () => MaybePromise<void>): (() => void) | void
}

/** Options for `ctx.kv(namespace).list(...)`. */
export interface PluginKvListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

/** Single item returned by `ctx.kv(namespace).list(...)`. */
export interface PluginKvEntry<T = unknown> {
  key: string
  value: T
  updatedAt: number
}

/** Paginated result returned by `ctx.kv(namespace).list(...)`. */
export interface PluginKvListResult<T = unknown> {
  items: Array<PluginKvEntry<T>>
  nextCursor?: string
}

/**
 * Per-plugin keyed KV storage handle backed by `state.sqlite` (`helmx_plugin_kv`).
 * Each entry is redacted via SecretStash before persisting and bounded (256 KiB UTF-8 JSON);
 * avoids whole-namespace serialization.
 */
export interface PluginKvHandle<T = unknown> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): boolean
  list(opts?: PluginKvListOptions): PluginKvListResult<T>
  clear(): void
  flush(): Promise<void>
}

export type PluginRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

/** Matched route parameters passed as the optional 2nd argument to `PluginRouteSpec.handler`. */
export interface PluginRouteContext {
  readonly params: Readonly<Record<string, string>>
}

/** Web Standard 原始路由（Request/Response 为 DOM lib 类型）。 */
export interface PluginRouteSpec {
  method: PluginRouteMethod
  /** 以插件 ID 为前缀挂载的相对路径。 */
  path: string
  /** true 时跳过 Token 鉴权（webhook 回调等）。 */
  public?: boolean
  handler(req: Request, ctx: PluginRouteContext): MaybePromise<Response>
}

/** 插件自举受管技能资产（ctx.host.skills.ensureSkill 入参；形状与内核 BuiltinSkillAsset 同构）。 */
export interface PluginSkillAsset {
  /** 技能 ID（skills/<id>/ 目录名）。 */
  id: string
  /** SKILL.md 全文（含 frontmatter，managedByPlugin 应指向本插件）。 */
  skillMd: string
  /** references 相对路径 -> 内容。 */
  references: Record<string, string>
}

// ---------------------------------------------------------------------------
// 宿主运行时能力
// ---------------------------------------------------------------------------

/** 插件可用的 Profile 数据端口（类型化只读 + 托管写入；服务机制仍在内核）。 */
export interface HelmxHostProfilesPort {
  /** 全部 Profile（不含 system 全文）。 */
  list(): Promise<Profile[]>
  /** 单个 Profile；不存在时返回 undefined。id 非法时抛 HelmxError。 */
  get(id: string): Promise<Profile | undefined>
  /** 读取 Profile 的 SYSTEM.md 全文；缺失抛 FileNotFoundError 语义（HelmxError not_found）。 */
  getSystem(id: string): Promise<string>
  /**
   * 新建或整体保存 Profile（携带 system 时原子同步至 SYSTEM.md）。
   * 供插件自举托管元数据（managedByPlugin）；常规管理仍走 HTTP/CLI。
   */
  save(profile: Profile): Promise<Profile>
  /**
   * Profile 资产目录的真实磁盘绝对路径（仅 id 边界校验 + 坐标返回；目录可能
   * 尚不存在——首次初始化（如 MEMORY.md）由调用方自行创建，宿主不 mkdir）。
   * 供插件管理同目录自有资产文件，不做 ../.. 相对逃逸。
   */
  directory(id: string): Promise<string>
}

/** 插件可用的技能数据端口（读 + 受管自举）。 */
export interface HelmxHostSkillsPort {
  /** 全部技能摘要（含 references 相对路径）。 */
  list(): Promise<SkillSummary[]>
  /** 读取技能内相对路径文件（SKILL.md / references/...）；穿越/绝对路径/软链均拒绝。 */
  readFile(skillId: string, path?: string): Promise<string>
  /**
   * 受管自举技能包：以声明版本为准逐文件覆盖，缺失补齐；登记受管后常规
   * 写入口统一 403。边界非法（id/相对路径）整体拒绝，不产生部分文件。
   * 通用受管资产安装机制，内外插件同权。
   */
  ensureSkill(asset: PluginSkillAsset): Promise<void>
}

/**
 * 插件私有 secrets（绑定 pluginId 命名空间）：持久化于 credentials.json
 * pluginSecrets.<pluginId>（恒 0600），明文绝不进入公共文档、事件或模型上下文。
 */
export interface HelmxHostSecretsPort {
  /** 读取（不存在返回 undefined）。 */
  get(key: string): Promise<string | undefined>
  /** 写入（空值拒绝）；成功后可逃逸的旧值（若有）仍保留脱敏。 */
  set(key: string, value: string): Promise<void>
  /** 幂等删除。 */
  delete(key: string): Promise<void>
  /** 登记全局逐值脱敏（明文出现在任何日志/事件/文档中自动替换 [REDACTED]）；返回解除函数。 */
  addRedaction(value: string): () => void
}

/** 节点只读状态与元信息端口（经内核 EnvFabric 查询在线状态、节点快照、可达 Hub URL 与可信平台）。 */
export interface HelmxHostNodeIpcPort {
  /** 节点是否在线（'local' 恒 true）。 */
  isOnline(nodeId: string): boolean
  /** 节点注册时上报的可达 Hub URL（若有）。 */
  getNodeHubUrl?(nodeId: string): string | undefined
  /** 节点注册时上报的可信平台（如 win32 / linux / darwin）；未上报或离线返回 undefined。 */
  nodePlatform?(nodeId: string): string | undefined
  /** Read-only snapshot of registered compute nodes (including `local` and BYOM nodes; excludes credentials/tokens). */
  listNodes?(): NodeInfo[]
}

/**
 * 节点透传隧道端口（EnvFabric.openTunnel 的插件面）：建立到目标节点
 * TCP `host:port` 的任意 Duplex 双工流。生命周期受插件在途任务跟踪：
 * 建立计入在途任务；返回的 Duplex 关闭（close/error/destroy）即结束任务——
 * 插件停用预检可见活动隧道，停用/宿主 dispose 时统一销毁不泄漏。
 */
export interface HelmxHostOpenTunnelPort {
  /** 建立 TCP 透传隧道（host 缺省 127.0.0.1，由目标节点解析连接）。 */
  (nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex>
}

/** ctx.host：插件可调用的宿主内核能力（插件拿到的实现已绑定其 pluginId，不可伪造他人身份）。 */
export interface HelmxHostApi {
  /** 宿主关闭状态（get）：true 后拒绝新回合/新后台任务，插件据此停投递。 */
  readonly isClosing: boolean
  /** Profile 数据端口（读 + system 读取；写入仍经 HTTP/CLI 管理面）。 */
  readonly profiles: HelmxHostProfilesPort
  /** 技能数据端口（读 + 受管自举 ensureSkill）。 */
  readonly skills: HelmxHostSkillsPort
  /** 插件私有 secrets（pluginId 命名空间；不进文档/事件/模型上下文）。 */
  readonly secrets: HelmxHostSecretsPort
  /** 节点在线状态与元信息查询端口（EnvFabric）。 */
  readonly nodeIpc: HelmxHostNodeIpcPort
  /**
   * 任意 TCP 透传隧道（进程内调用获得原始 Duplex）：local 进程内直连；
   * 远端复用既有节点隧道传输。未接线时调用显式报 501，绝不回退 local。
   * 活动隧道纳入插件在途任务跟踪（停用预检可见；停用/dispose 不泄漏）。
   */
  readonly openTunnel: HelmxHostOpenTunnelPort
  dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  submitInput(
    conversationId: number,
    text: string,
    /** Defaults to steer when omitted; followUp is reserved for explicitly requested queueing. */
    opts?: {
      origin?: InputOrigin
      whenBusy?: WhenBusy
      meta?: Record<string, unknown>
      /** 要挂载的产物 ID 列表（去重后按会话或祖先链授权；404 not_found / 403 artifact_forbidden）。 */
      attachments?: string[]
      /** 跨重启幂等提交标识（重复提交同一 requestId 自动跳过）。 */
      requestId?: string
      /** 从指定历史条目起原地覆盖重发（截断该条及后续上下文后写入新输入）。 */
      replaceFromEntryId?: number
    },
  ): Promise<void>
  /**
   * 自动化 guarded 提交（Watchdog 红线内核执行层）：全部准备工作（input 钩子、
   * 模型解析、附件授权）完成后，在提交点（SDK submit 调用前、最后一个 await
   * 之后）同步复核会话存在性、归属（严禁 human）与可选 CAS 水位；复核失败
   * 抛 404/409 且不产生提交副作用（input 钩子可能已观察过输入文本，与普通
   * 拒绝路径同口径）。不支持 replaceFromEntryId（自动化不重写历史）。guard
   * 缺省时仅强制 human 红线（归属属自动化域）。
   */
  submitInputGuarded(
    conversationId: number,
    text: string,
    opts?: {
      origin?: InputOrigin
      whenBusy?: WhenBusy
      /** 仅向现有运行投递；SDK 在接纳输入时原子拒绝已空闲的会话。 */
      whenIdle?: 'reject'
      meta?: Record<string, unknown>
      /** 要挂载的产物 ID 列表（与 submitInput 同一授权与提交链）。 */
      attachments?: string[]
      /** 跨重启幂等提交标识（重复提交同一 requestId 自动跳过）。 */
      requestId?: string
    },
    guard?: GuardedMutationExpectation,
  ): Promise<void>
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  /**
   * 从源会话指定可见条目或最新干净锚点分叉新会话（与 POST /api/conversations/:id/fork 同源）。
   * 省略 entryId 时自动解析最新已完成干净锚点（无非系统历史抛 409 fork_empty_history）；
   * 源会话或指定条目不存在抛 404 not_found；显式 entryId 非安全正整数抛 400 validation_error。
   */
  forkConversation(
    id: number,
    opts?: { entryId?: number; title?: string; parentConversationId?: number },
  ): Promise<ConversationSummary>
  listConversations(filter?: ConversationListFilter): ConversationSummary[]
  /** 读取单个会话摘要；不存在时抛 HelmxError。 */
  getConversation(id: number): ConversationSummary
  /** 会话详情（时间线条目 + 元数据；limit 1..500，cursor 分页）。 */
  getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail>
  /**
   * 按幂等 requestId 只读查询会话持久提交状态（供插件恢复对账，绝不凭无关回合状态猜测提交是否生效）：
   * - 未找到该 requestId 的提交返回 undefined；会话不存在抛 404 not_found；非法 requestId 抛 400 validation_error；
   * - status 为 'queued' | 'placed' 表示已受理且在途，'done' | 'unanswered' 表示已达终态。
   */
  getConversationSubmission(
    id: number,
    requestId: string,
  ): Promise<ConversationSubmissionInfo | undefined>
  /** 部分更新会话；返回更新后的摘要。 */
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  /** 中止指定会话的在途执行。 */
  abortConversation(id: number): Promise<void>
  /**
   * 自动化 guarded 中止（Watchdog 红线内核执行层）：在会话串行域内、于
   * 第一个不可逆动作（SDK abort 调用）前同步复核会话存在性、归属（严禁
   * human）与可选 CAS 水位；复核失败抛 404 not_found / 409 ownership_conflict
   * / 409 state_seq_conflict 且绝不发起中止。
   */
  abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void>
  /**
   * 原地重置会话上下文（人类交互通道代理入口，与 POST /api/conversations/:id/reset 同源）：
   * 用于外部聊天渠道转发人类显式发起的 `/clear` 等指令（保持会话 `ownedBy: 'human'`）。
   * 后台自动化/巡检维护必须使用 `resetConversationGuarded`，不得调用本端口绕过归属红线。
   */
  resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary>
  /**
   * 自动化 guarded 上下文重置（Watchdog 红线内核执行层）：在会话串行域内、
   * 于第一个不可逆动作（SDK reset 调用）前同步复核会话存在性、归属（严禁
   * human）与可选 CAS 水位；复核失败抛 404 not_found / 409 ownership_conflict
   * / 409 state_seq_conflict 且绝不发起重置。handoff 经内核统一脱敏；成功后
   * 推进 stateChangeSeq、触发上下文用量重算并广播 conversation.upsert。
   * guard 缺省时仅强制 human 红线（与 submitInputGuarded 同口径）。
   */
  resetConversationGuarded(
    id: number,
    opts?: { handoff?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<ConversationSummary>
  /**
   * 手动压缩会话上下文（人类交互通道代理入口，与 POST /api/conversations/:id/compact 同源）：
   * 用于外部聊天渠道转发人类显式发起的 `/compact` 等指令（保持会话 `ownedBy: 'human'`）。
   * 后台自动化/巡检维护必须使用 `compactConversationGuarded`，不得调用本端口绕过归属红线。
   */
  compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }>
  /**
   * 自动化 guarded 手动压缩（Watchdog 红线内核执行层）：入队后台压缩任务前
   * 在会话串行域内同步复核会话存在性、归属（严禁 human）与可选 CAS 水位，
   * 复核失败绝不入队；instructions 经内核统一脱敏。返回后台任务 ID 与更新
   * 后的会话摘要。guard 缺省时仅强制 human 红线（与 submitInputGuarded 同口径）。
   */
  compactConversationGuarded(
    id: number,
    opts?: { instructions?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<{ taskId: number; conversation: ConversationSummary }>
  /** 会话归属权现读（Watchdog 红线判定唯一可信来源；未标记一律 human）。 */
  getConversationOwnership(id: number): ConversationOwnership
  /** 列出会话产物元数据（本会话全部；明文内容不进返回值）。 */
  listArtifacts(conversationId: number): Promise<ArtifactMetadata[]>
  /**
   * 以内存字节写入会话产物（kind 'upload'）：与 HTTP 上传同一条服务链
   * （参数与文件名边界校验、15 MiB 上限、文本 MIME 过 SecretStash 脱敏、
   * 会话写删串行链防孤儿）；目标会话不存在抛 404。返回元数据供
   * submitInput / submitInputGuarded 的 attachments 挂载。
   */
  createArtifact(
    conversationId: number,
    input: { name: string; bytes: Uint8Array; mimeType?: string },
  ): Promise<ArtifactMetadata>
  /**
   * 授权读取单个产物元数据与原始字节（须属于目标会话或其祖先链，上限 32 跳）：
   * 产物不存在抛 404 not_found、越权抛 403 artifact_forbidden、盘上文件缺失抛
   * 404 artifact_file_missing；走元数据形状门禁与三层 realpath 防逃逸，返回
   * 独立拷贝的 Uint8Array（不暴露宿主磁盘路径、不共享 Buffer 池）。
   */
  readArtifact(
    conversationId: number,
    artifactId: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Uint8Array }>
  /**
   * 全局文本脱敏（SecretStash 明文 -> marker）：诊断/日志出站前、以及插件
   * 持久化自身元数据（如含路径/分支的工作树记录）前统一过此脱敏，防已
   * 登记机密落库（唯一脱敏入口，无并行同名方法）。
   */
  redact(text: string): string
  /**
   * 通用无工具单次文本补全（机制，无业务策略）：未传 `model` 时按会话解析生效模型
   * （会话覆盖 > profile.model > 全局），显式传入非空 `model` 时覆盖本次调用模型；
   * 输入输出均过全局脱敏；stopReason 非成功终态显式拒绝，不返回部分文本。
   */
  completeText(input: {
    conversationId: number
    model?: string
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string>
  /**
   * 在目标节点获取无会话作用域执行环境（短生命周期对象，用后即弃，绝不缓存）：
   * local 进程内直建；远端经 RPC；未知节点返回 Remote env（操作时等待重连），
   * 绝不回落 local。返回 SDK ExecutionEnv 类型（type-only 引自
   * @earendil-works/pi-durable/env，protocol 零运行时重依赖）；宿主 wrapper
   * 为受控代理（方法调用过 assertContextUsable + task 跟踪，停用后旧句柄失效）。
   */
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  /**
   * 按 realpath 的文件锁：同一 Hub 进程内同一路径（含不同相对写法）全局互斥，
   * 闭包执行全窗持锁（停用预检可见在途任务；停用/重启用后旧周期闭包内续用
   * 会被 epoch 守卫拒绝）。仅承诺本 Hub 进程内串行（不含跨进程协议）。
   * 通用文件机制，不注入任何插件业务语义。
   */
  withFileLock<T>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>
  /** 原子写文件（临时文件 + rename；通用机制，失败显式拒绝）。 */
  atomicWriteFile(path: string, content: string): Promise<void>
  /**
   * 声明插件对本会话的管理权（如 builtin:swarm 的活跃成员会话）：
   * 受管期间会话删除保护（409 conversation_managed_by_plugin），
   * 返回释放函数；插件停用/回滚时宿主自动释放。
   */
  manageConversation(id: number): () => void
  /** 标记会话归属权；'human' 会话严禁自动按键/中止（Watchdog 红线）。 */
  markConversationOwnership(id: number, owner: ConversationOwnership): void
  /** 派生或续接子代理（经过 agent_spawn Hook 管道 + 原生子会话底座）。 */
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /** 在目标节点/会话工作目录执行验证门禁命令。 */
  runGate(
    command: string,
    options?: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
      gateTimeoutMs?: number
    },
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }>
  /**
   * 经内核 EnvFabric 跨节点执行命令（复用 local / 远端 @helmx/node 通道与脱敏）。
   * 靶点解析优先级：显式 nodeId/cwd > conversationId 绑定 (nodeId, cwd) > 'local'/Hub cwd。
   * 远端节点离线时显式抛 409 node_offline，绝不静默回退本机。
   */
  execEnv(
    req: Omit<EnvExecRequest, 'stream'>,
    opts?: { signal?: AbortSignal },
  ): Promise<EnvExecResponse>
  /**
   * 动作前置校验（与 invokeAction 同源的 prepare/preflight）：校验插件状态、
   * 会话 scope 与 inputSchema（无 handler 副作用），并返回定义端 idempotent。
   * 供编排引擎在落盘 action_started 前判定副作用语义；不能仅以 listActions
   * 清单冒充。
   */
  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): { idempotent: boolean }
  /**
   * 通用 spawn 靶点解析（机制，零业务语义）：按与原生执行行同一权威链
   * 解析源目录与目标节点，并返回父会话 cwd 供插件层在分配资源前解析源目录。
   */
  resolveSpawnTarget(input: {
    parentConversationId: number
    /** Profile ID（非 fork 缺省 'assistant'；fork=true 缺省继承父会话 profileId）；Profile 不存在时抛 not_found。 */
    profileId?: string
    /** 显式请求目标计算节点 ID（优先级最高；显式 `'local'` 可覆盖远端父会话或 Profile 绑定）。 */
    requestNodeId?: string
    /** 显式请求 cwd（优先于 Profile/父会话 cwd）。 */
    requestCwd?: string
    /** 是否按上下文分叉派生规则解析（缺省 false）。 */
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
  /**
   * 当前进程内仍在执行的 spawn 执行事实（通用机制面）：包含每次在途
   * spawnAgent 的 execution 元数据镜像（含插件层回传的 worktree 等扩展字段）。
   * 供插件层判定路径占用（如拒绝清理在途工作树）；已结束的执行不出现。
   */
  listActiveSpawnExecutions(): AgentExecutionInfo[]
  /**
   * 目标节点进程占用快照（删除前诊断面，通用机制、零业务语义）。
   */
  inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<NodePathUsage>
  /** 调用任意已启用插件的动作（输出已经过 JSON 校验与宿主统一脱敏）。 */
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): Promise<unknown>
  /** 列出当前全部已启用插件的动作清单。 */
  listActions(): ActionManifest[]
  /** 当前插件清单（含启停状态；只读快照）。 */
  listPlugins(): PluginSummary[]
  /** 当前全部 UI 贡献清单（仅已启用插件；只读快照）。 */
  listUi(): PluginUiContribution[]
  /**
   * 刷新动态模型目录（与 POST /api/models/refresh 同链路；options 现有形状）。
   * 供 provider 插件触发自身目录刷新；错误以 result.errors 返回（不 reject）。
   */
  refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult>
  /**
   * 读取当前模型目录快照（可用模型、思考档位、全局默认链与已挂载档位）。
   * 与 GET /api/models 同源；宿主未接线时显式抛 501 not_supported。
   */
  listModels(): Promise<ModelCatalog>
  /**
   * 创建 AskDoc 并等待终态：正常三态（answered/cancelled/superseded）均 resolve，
   * 只有验证/I/O/宿主失败才 reject。
   */
  createAsk(spec: AskCreateSpec): Promise<AskResult>
  cancelAsk(askId: string, reason?: 'cancelled' | 'superseded'): Promise<void>
  /**
   * Subscribe to a built-in host event with typed payload delivery (`EventHub` broadcast
   * events, transient `conversation.live`, and `broadcast: false` in-process events).
   * Automatically unsubscribed on plugin disable; listeners may be async and `emitEvent`
   * callers await their completion.
   */
  onEvent<K extends keyof HostEventMap>(
    type: K,
    listener: (payload: HostEventMap[K]) => MaybePromise<void>,
  ): () => void
  /**
   * Subscribe to a custom host/plugin event (`payload` is `unknown`).
   * Automatically unsubscribed on plugin disable; listeners may be async.
   */
  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void
  /**
   * Publish a built-in host event and await internal listeners (accepts either a full
   * event envelope or raw payload omitting `type`). Set `broadcast: false` for in-process
   * dispatch only (never enters global SSE).
   */
  emitEvent<K extends keyof HostEventMap>(
    type: K,
    payload: HostEventEmitPayload<K>,
    options?: { broadcast?: boolean },
  ): MaybePromise<void>
  /** Publish a custom plugin/workflow event and await internal listeners; `broadcast: false` dispatches in-process only. */
  emitEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void>
}

// ---------------------------------------------------------------------------
// 唯一插件定义入口
// ---------------------------------------------------------------------------

export interface HelmxPluginContext<TConfig = Record<string, unknown>> {
  readonly pluginId: string
  /** 插件专属数据目录（~/.helmx/plugins/<id>/）。 */
  readonly dataDir: string
  getConfig(): TConfig

  /** 声明式配置 Schema（secret: true 自动分离至 credentials.json）。 */
  configSchema(schema: Record<string, PluginConfigFieldSchema>): void

  /** 后端 4 个可组合生命周期 Hook（input / before_turn / agent_spawn / turn_settled）。 */
  hook: PluginHookRegistry

  /** 单点 Schema 动作总线（五端复用）。 */
  action<TIn, TOut>(spec: PluginActionSpec<TIn, TOut>): void

  /** 模型专用工具。 */
  tool<TIn>(spec: PluginToolSpec<TIn>): void

  /** Web Standard 原始路由。 */
  route(spec: PluginRouteSpec): void

  /** 持久状态文档；opts.public = true 时进入公共快照与 plugin.doc.updated 事件。 */
  doc<TState>(name: string, initial: TState, opts?: PluginDocOptions): PluginDocHandle<TState>

  /** 按会话隔离的文档，不进入全局首帧或全局 SSE；文档名不得与 doc 重复。 */
  sessionDoc<TState>(name: string, initial: TState, opts?: PluginDocOptions): PluginSessionDocHandle<TState>

  /** 轻量插件专属键值存储（state.sqlite `helmx_plugin_kv`），按条目独立读写、自动脱敏并受单条大小上限约束。 */
  kv<T = unknown>(namespace: string): PluginKvHandle<T>

  /**
   * 向能力注册表提供类型化实现，供其他插件（`ctx.consume`）及内核子系统消费。
   * 返回幂等释放函数；插件停用、停止或回滚时宿主自动释放。
   */
  provide<T>(capabilityId: string, impl: T): () => void

  /**
   * 只读读取当前所有活跃插件在 `capabilityId` 下提供的能力实现。
   */
  consume<T>(capabilityId: string): ReadonlyArray<ProvidedCapability<T>>

  /**
   * Subscribe to changes in the active providers registered under `capabilityId`
   * (invoked when providers are added, released, or change active status on plugin
   * enable/disable/rollback). Automatically released when this plugin is disabled,
   * stopped, or rolled back; returns an idempotent unsubscribe callback.
   */
  onCapabilityChanged(capabilityId: string, listener: () => void): () => void

  /** 后台服务（随插件启停生命周期管理）。 */
  service(spec: PluginServiceSpec): void

  /**
   * 声明插件自带的模型 Provider，随插件启停自动挂载/卸载：
   * - 仅在 definePlugin 执行期间声明；边界校验 id/name/auth/getModels/stream/
   *   streamSimple 最小形状，重复 id 拒绝；
   * - 默认停用探测（register enabled:false）只收集声明不挂载，configSchema 照常可用；
   * - 启用时在服务 start 前依次挂载，停用/卸载时在服务 stop 后逆序卸载；
   * - 宿主未提供 providers 挂载端口时，声明了 provider 的插件在启用阶段显式
   *   失败（501），绝不静默丢弃或假装挂载。
   * Provider 类型来自 @earendil-works/pi-ai（type-only，protocol 零运行时新增依赖）。
   */
  provider(provider: Provider): void

  /** 前端 10 个全界面扩展点。 */
  ui: PluginUiRegistry

  /** 宿主运行时能力。 */
  host: HelmxHostApi
}

export interface PluginDefinition {
  /** Plugin ID, e.g. 'builtin:profile', 'builtin:herdr'. */
  id: string
  /**
   * Plugin display name (display copy, `LocalizedText`): a plain string or a
   * `{ en, 'zh-CN' }` map, resolved by the consuming UI via its active locale
   * (CLI human output resolves with 'en'; --json keeps the raw shape). The
   * registration boundary validates it with parseNonEmptyLocalizedText
   * (supported locale keys, non-blank copy).
   */
  name?: LocalizedText
  /**
   * Short plugin description (display copy, same resolution rules as `name`):
   * shown on plugin-center cards and CLI listings, one sentence on scope.
   */
  description?: LocalizedText
  /**
   * 插件线性矢量图标名称（对应 HelmxIcon name，可选）。
   * 缺省时使用默认图标占位。
   */
  icon?: string
  version?: string
  /** true 表示常驻不可卸载（builtin:profile）。 */
  locked?: boolean
  /**
   * 插件间依赖契约：依赖的其他插件 ID 列表（仅 ID，不做版本解析）。
   * - 注册边界校验形状（非空字符串、插件 id 字符集）并按声明序去重；
   * - 启用（含注册即启用）时逐项校验：依赖必须已注册且已启用（仅注册未启用的
   *   依赖不满足），否则 409 plugin_dependency_missing / plugin_dependency_not_enabled；
   * - 依赖图出现环路（含自依赖）在注册边界显式 409 plugin_dependency_cycle；
   * - 全局服务启动屏障按依赖拓扑序 prepare/start（同层保持注册序），
   *   stop/dispose 按逆拓扑序。
   */
  dependencies?: ReadonlyArray<string>
  /**
   * 客户端源根目录（绝对路径，可选）：声明了 client.tsx 组件引用（UiSpecBase.client）
   * 的插件在源码即时编译轨提供。宿主只允许 ClientComponentRef.module 解析到该目录内的相对
   * .ts/.tsx 源文件，编译产物按源内容（含本地依赖）hash 缓存；未声明时且未提供
   * prebuiltClientDir 时一切 client 引用在注册边界拒绝。由可信插件定义传入，
   * 不属于用户可配置面。
   */
  clientRoot?: string
  /**
   * 预编译客户端产物目录（绝对路径，可选，通常为 `<pluginDir>/dist-client`）：
   * 存在时注册校验与运行时服务直接读取该目录下的 `manifest.json`、预编译入口 `.mjs`
   * 及异步 chunk（含 `.gz`），零运行时 esbuild 编译、零运行时 `npmDependencies` 依赖，
   * 即使未注入 `buildProvider` 亦可正常注册启用与提供前端模块。
   */
  prebuiltClientDir?: string
  /** 插件自带的受控 npm 依赖（说明符 -> 提供包的解析根）：解析根须为内核包根
   * （含锁定版本的 node_modules，内置插件声明）或外部插件自身目录（由清单
   * helmx.clientDependencies / plugin.json clientDependencies 归一映射产生，见
   * external-loader normalizeDefinition——外部插件不得在代码内自指解析根）。
   * 编译器把声明的说明符解析进 bundle 并逐文件 containment 校验，随依赖
   * hash 与缓存复查。 */
  npmDependencies?: Readonly<Record<string, string>>
  definePlugin(ctx: HelmxPluginContext): MaybePromise<void>
}
