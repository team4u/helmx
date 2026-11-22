/**
 * builtin:workflow 生命周期 Hook 与宿主事件订阅（自 workflow.ts 入口拆出）。
 *
 * 注册面（与入口组装顺序一致）：
 * - agent_spawn 深度守卫（priority 300 = 最外层，先于 worktree 分配拒绝；
 *   worktree 隔离的 around 200 归 builtin:worktree 插件注册）；
 * - before_turn：达到子树上限的受管子代理回合剥离派工工具（防线一）；
 * - turn_settled（outcome=aborted）：级联取消该会话子树内属于它的 run；
 * - 宿主事件：conversation.upsert / conversation.deleted 触发 runs 重投影。
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import { HARD_MAX_SUBAGENT_DEPTH, WORKFLOW_PLUGIN_ID, parseWorkflowSpawnMeta } from '../contracts.js'
import { isAncestorOrSelf } from '../lineage.js'
import type { WorkflowService } from './engine/index.js'
import type { ManagedSubagentRegistry } from './depth.js'
import type { RunsProjection } from './projection.js'
import { depthExceededError } from './depth.js'

interface WorkflowHookDeps {
  registry: ManagedSubagentRegistry
  workflows: WorkflowService
  projection: RunsProjection
}

function extractDeletedConversationId(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const candidate = record['conversationId'] ?? record['id']
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1
    ? candidate
    : undefined
}

export function registerWorkflowHooks(ctx: HelmxPluginContext, deps: WorkflowHookDeps): void {
  const { registry, workflows, projection } = deps

  // ---- agent_spawn 深度守卫（兜底防线；priority 300 = 最外层） ----
  // 先于 builtin:worktree 的隔离 around（200）执行：受管子代理的派生请求在
  // worktree 分配之前显式拒绝；成功派生（onResolved 回传 conversationId）登记进事实表——
  // 任何入口（同步工具 / 后台 run / 引擎节点 / 未来调用方）派生的子会话
  // 都被记账，重启后依旧生效。
  ctx.hook.onAgentSpawn(async (request, next) => {
    // 业务扩展字段经 meta 的本插件命名空间携带：内核只校验 envelope
    //（JSON-safe），业务值在此边界用本插件 schema 校验（非法显式拒绝）。
    const spawnMeta = parseWorkflowSpawnMeta(request.meta)
    const parentFacts = registry.depthFactsOf(request.parentConversationId)
    const childDepth = parentFacts.depth + 1
    if (parentFacts.managed && childDepth > parentFacts.maxSubagentDepth) {
      throw depthExceededError(parentFacts.depth, parentFacts.maxSubagentDepth, request.parentConversationId)
    }
    // 显式扩展请求字段：无效值显式拒绝（不静默丢弃、不擅自锐化）。
    const explicitCeiling = spawnMeta.maxSubagentDepth
    if (
      explicitCeiling !== undefined &&
      (!Number.isInteger(explicitCeiling) || explicitCeiling < 1 || explicitCeiling > HARD_MAX_SUBAGENT_DEPTH)
    ) {
      throw new HelmxError(
        'validation_error',
        `maxSubagentDepth 必须是 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数（收到 ${JSON.stringify(explicitCeiling)}）`,
        400,
        { maxSubagentDepth: explicitCeiling },
      )
    }
    const childCeiling = explicitCeiling ?? parentFacts.maxSubagentDepth
    if (childCeiling < childDepth || (parentFacts.managed && childCeiling > parentFacts.maxSubagentDepth)) {
      throw new HelmxError(
        'validation_error',
        `maxSubagentDepth 必须至少为目标层级 ${childDepth}，受管子代理不能提高继承的上限 ${parentFacts.maxSubagentDepth}`,
        400,
        { depth: parentFacts.depth, maxSubagentDepth: childCeiling, inheritedLimit: parentFacts.maxSubagentDepth },
      )
    }
    const original = request.onResolved
    // continuation 契约：已调 next 的 handler 返回 void（next 的结果即
    // 它的结果）；此处仅包裹 onResolved 记账，不得透传下游产物。
    await next({
      ...request,
      onResolved: (info) => {
        if (info.conversationId !== undefined) {
          registry.registerManagedSubagent(info.conversationId, {
            ...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
            ...(spawnMeta.runId !== undefined ? { runId: spawnMeta.runId } : {}),
            depth: childDepth,
            parentConversationId: request.parentConversationId,
            maxSubagentDepth: childCeiling,
            ceilingExplicit: explicitCeiling !== undefined,
          })
        }
        original?.(info)
      },
    })
  }, { priority: 300 })

  // ---- before_turn：达到子树上限的受管子代理剥离派工工具（防线一），无活跃可插话子代理时剥离 steer 工具 ----
  // 一层子代理默认未达上限（depth=1 < 2），保留 subagent / SubagentWorkflow
  // 可继续派二层；仅叶子（depth ≥ 子树上限）剥离。无活跃且归属当前会话树内的
  // 后台 subagent 运行时，省略 workflow_steer 工具声明，避免空闲回合常驻上下文。
  const hasActiveSteerableSubagent = (callerId: number): boolean => {
    const active = workflows.listActiveRuns()
    if (active.length === 0) return false
    const parentOf = (id: number): number | undefined => {
      try {
        return ctx.host.getConversation(id).parentConversationId
      } catch (error) {
        if (error instanceof HelmxError && error.code === 'not_found') return undefined
        throw error
      }
    }
    for (const run of active) {
      if (run.kind !== 'subagent' || run.status !== 'running') continue
      if (run.conversationId === callerId || isAncestorOrSelf(run.conversationId, callerId, parentOf)) {
        return true
      }
    }
    return false
  }

  const resolveSteerToolName = (): string | undefined =>
    ctx.host
      .listActions()
      .find((action) => action.pluginId === WORKFLOW_PLUGIN_ID && action.id === 'steer')
      ?.toolName

  ctx.hook.onBeforeTurn((turn) => {
    const drop = new Set<string>()
    const facts = registry.depthFactsOf(turn.conversation.id)
    if (facts.managed && facts.depth >= facts.maxSubagentDepth) {
      drop.add('subagent')
      drop.add('SubagentWorkflow')
    }
    if (!hasActiveSteerableSubagent(turn.conversation.id)) {
      const steerToolName = resolveSteerToolName()
      if (steerToolName !== undefined) drop.add(steerToolName)
      for (const tool of turn.tools) {
        if (tool.name === 'builtin:workflow.steer' || /^workflow_steer_[0-9a-f]{8}$/.test(tool.name)) {
          drop.add(tool.name)
        }
      }
    }
    if (drop.size === 0) return
    const tools = turn.tools.filter((t) => !drop.has(t.name))
    if (tools.length === turn.tools.length) return
    return { action: 'transform', value: { ...turn, tools } }
  })

  // ---- turn_settled（outcome=aborted）：级联取消该会话子树内属于它的 run ----
  // 只在 aborted 时级联（completed/failed 不取消合法后台任务）；fire-and-forget：
  // 会话结算链绝不 await 取消完成——run 结算链会经守卫端口中止子会话并等待
  // 其结算，若在此处相互等待会死锁（取消经引擎幂等门与重入共享收敛；子会话
  // 被守卫中止触发的 turn_settled 递归进入时命中同一批 run，不再扩散）。
  ctx.hook.onTurnSettled((payload) => {
    if (payload.outcome !== 'aborted') return
    if (ctx.host.isClosing && workflows.isAutoRecoverOnRestart()) return
    const conversationId = payload.conversation.id
    void workflows
      .cancelRunsUnderConversation(conversationId)
      .then(
        () => projection.sync(),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(
            `builtin:workflow: 会话 ${conversationId} 中止后的后台运行级联取消失败: ${message}\n`,
          )
          projection.sync()
        },
      )
  })

  // ---- 会话事实变化（新增/删除）→ 重投影 runs 分片与角标 ----
  // 分片是会话子树聚合：会话删除会让「后代发起」的 run 失去投影目标，
  // 新会话成为既有 run 的祖先时聚合面改变。conversation.upsert 高频
  //（状态/doing 均广播）：以树形指纹（id + 父链）比对，树未变则跳过
  //（无写放大）；投影本身仍幂等（值比对写入）。父链只在创建时落定
  //（PATCH 不可改），指纹即完整树事实。
  ctx.host.onEvent('conversation.upsert', () => {
    projection.reprojectOnConversationTreeChange()
  })
  ctx.host.onEvent('conversation.deleted', (raw) => {
    if (!projection.isStopping()) {
      const deletedId = extractDeletedConversationId(raw)
      if (deletedId !== undefined) {
        registry.pruneConversation(deletedId)
      }
    }
    projection.reprojectOnConversationDeleted()
  })
}
