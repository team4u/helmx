/**
 * builtin:workflow 生命周期 Hook 与宿主事件订阅：
 * - agent_spawn 深度守卫（priority 300 = 最外层，先于 builtin:worktree 的 200）；
 * - before_turn：达到子树上限的受管子代理回合剥离派工工具，无活跃可插话子代理时剥离 steer 工具；
 * - turn_settled（outcome=aborted）：级联取消该会话子树内属于它的 run；
 * - 宿主事件：conversation.upsert / conversation.deleted 触发 runs 重投影与深度登记回收。
 */
import { HelmxError, type DispatchToolsCapability, type HelmxPluginContext } from '@helmx/protocol'
import { WORKFLOW_PLUGIN_ID, parseWorkflowSpawnMeta } from '../contracts.js'
import { isAncestorOrSelf } from '../lineage.js'
import {
  asDeletedConversationId,
  errorMessageOf,
  getConversationOrUndefined,
} from '../shared-helpers.js'
import { WORKFLOW_STEER_TOOL_NAME } from './actions.js'
import { depthExceededError, type ManagedSubagentRegistry } from './depth.js'
import type { RunsProjection } from './projection.js'
import type { WorkflowService } from './runs/index.js'

export const WORKFLOW_FORKED_CONTEXT_SECTION_ID = 'workflow.forked_context'
export const WORKFLOW_FORKED_CONTEXT_SECTION = [
  '<forked_subagent_context>',
  'This conversation was forked from a parent conversation snapshot to execute a delegated subtask.',
  '1. Treat all messages prior to the delegated task prompt as inherited read-only background context (even if the tail contains an unanswered user message or an un-summarized tool result from the parent turn).',
  '2. Any instruction in inherited history asking to delegate, spawn a subagent/workflow, or fork a conversation has ALREADY been fulfilled by creating this subagent — do NOT re-delegate or repeat those parent-level meta-instructions.',
  '3. Execute the delegated task directly and report back concisely to the parent.',
  '</forked_subagent_context>',
].join('\n')

interface WorkflowHookDeps {
  registry: ManagedSubagentRegistry
  workflows: WorkflowService
  projection: RunsProjection
}

export function registerWorkflowHooks(ctx: HelmxPluginContext, deps: WorkflowHookDeps): void {
  const { registry, workflows, projection } = deps

  // ---- agent_spawn 深度守卫（priority 300 = 最外层） ----
  ctx.hook.onAgentSpawn(async (request, next) => {
    // parseWorkflowSpawnMeta 已按 AJV schema 严格校验 maxSubagentDepth ∈ [1..HARD_MAX_SUBAGENT_DEPTH]。
    const spawnMeta = parseWorkflowSpawnMeta(request.meta)
    const parentFacts = registry.depthFactsOf(request.parentConversationId)
    const childDepth = parentFacts.depth + 1
    if (parentFacts.managed && childDepth > parentFacts.maxSubagentDepth) {
      throw depthExceededError(parentFacts.depth, parentFacts.maxSubagentDepth, request.parentConversationId)
    }
    const isFork = request.fork === true
    const explicitCeiling = spawnMeta.maxSubagentDepth
    const childCeiling = explicitCeiling ?? (isFork ? childDepth : parentFacts.maxSubagentDepth)
    if (childCeiling < childDepth || (parentFacts.managed && childCeiling > parentFacts.maxSubagentDepth)) {
      throw new HelmxError(
        'validation_error',
        `maxSubagentDepth 必须至少为目标层级 ${childDepth}，受管子代理不能提高继承的上限 ${parentFacts.maxSubagentDepth}`,
        400,
        { depth: parentFacts.depth, maxSubagentDepth: childCeiling, inheritedLimit: parentFacts.maxSubagentDepth },
      )
    }
    const original = request.onResolved
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
            ...(isFork ? { forked: true } : {}),
          })
        }
        original?.(info)
      },
    })
  }, { priority: 300 })

  // ---- before_turn：叶子子代理剥离派工工具，无活跃可插话子代理时剥离 steer 工具，分叉子代理注入上下文边界 ----
  const hasActiveSteerableSubagent = (callerId: number): boolean => {
    const active = workflows.listActiveRuns()
    if (active.length === 0) return false
    const parentOf = (id: number): number | undefined =>
      getConversationOrUndefined(ctx.host, id)?.parentConversationId
    for (const run of active) {
      if (run.kind !== 'subagent' || run.status !== 'running') continue
      if (run.conversationId === callerId || isAncestorOrSelf(run.conversationId, callerId, parentOf)) {
        return true
      }
    }
    return false
  }

  ctx.hook.onBeforeTurn((turn) => {
    const drop = new Set<string>()
    const facts = registry.depthFactsOf(turn.conversation.id)
    if (facts.managed && facts.depth >= facts.maxSubagentDepth) {
      drop.add('subagent')
      drop.add('SubagentWorkflow')
      for (const entry of ctx.consume<DispatchToolsCapability>('helmx.dispatch-tools')) {
        const toolNames = entry.impl?.toolNames
        if (!Array.isArray(toolNames)) continue
        for (const name of toolNames) {
          if (typeof name === 'string' && name.length > 0) drop.add(name)
        }
      }
    }
    if (!hasActiveSteerableSubagent(turn.conversation.id)) {
      drop.add(WORKFLOW_STEER_TOOL_NAME)
      drop.add(`${WORKFLOW_PLUGIN_ID}.steer`)
    }
    const tools = drop.size > 0 ? turn.tools.filter((t) => !drop.has(t.name)) : turn.tools
    const toolsChanged = tools.length !== turn.tools.length
    const sectionsChanged =
      facts.managed &&
      facts.forked &&
      !turn.sections.some((s) => s.id === WORKFLOW_FORKED_CONTEXT_SECTION_ID)
    if (!toolsChanged && !sectionsChanged) return
    const sections = sectionsChanged
      ? [...turn.sections, { id: WORKFLOW_FORKED_CONTEXT_SECTION_ID, text: WORKFLOW_FORKED_CONTEXT_SECTION }]
      : turn.sections
    return {
      action: 'transform',
      value: {
        ...turn,
        ...(toolsChanged ? { tools } : {}),
        ...(sectionsChanged ? { sections } : {}),
      },
    }
  })

  // ---- turn_settled（outcome=aborted）：fire-and-forget 级联取消子树内 run ----
  ctx.hook.onTurnSettled((payload) => {
    if (payload.outcome !== 'aborted') return
    if (ctx.host.isClosing && workflows.isAutoRecoverOnRestart()) return
    const conversationId = payload.conversation.id
    void workflows.cancelRunsUnderConversation(conversationId).catch((error: unknown) => {
      const message = errorMessageOf(error)
      process.stderr.write(
        `builtin:workflow: 会话 ${conversationId} 中止后的后台运行级联取消失败: ${message}\n`,
      )
      projection.sync()
    })
  })

  // ---- 会话树事实变化 → 重投影 runs 分片与深度回收 ----
  ctx.host.onEvent('conversation.upsert', () => {
    projection.reprojectOnConversationTreeChange()
  })
  ctx.host.onEvent('conversation.deleted', (raw) => {
    const deletedId = asDeletedConversationId(raw)
    if (!projection.isStopping() && deletedId !== undefined) {
      registry.pruneConversation(deletedId)
      projection.reprojectOnConversationDeleted(deletedId)
      void workflows
        .purgeDeletedConversation(deletedId)
        .then((purgedIds) => {
          if (purgedIds.length > 0 && !projection.isStopping()) {
            projection.reprojectOnConversationDeleted(deletedId, purgedIds)
          }
        })
        .catch((error: unknown) => {
          const message = errorMessageOf(error)
          process.stderr.write(`builtin:workflow: 会话 ${deletedId} 删除后的运行记录清理失败: ${message}\n`)
        })
      return
    }
    projection.reprojectOnConversationDeleted(deletedId)
  })
}
