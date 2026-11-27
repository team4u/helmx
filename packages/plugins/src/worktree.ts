/**
 * builtin:worktree: the managed Git worktree backend plugin (default-enabled, zero static dep on workflow).
 *
 * Responsibilities:
 * - WorktreeAllocator / WorktreeStore / durable leases / ManagedWorktreeHold / agentId bindings
 *   persisted per-entry via `ctx.kv` (`worktrees`, `leases`, `agent-bindings`);
 * - agent_spawn around hook (priority 200) for allocation / resume / reattach;
 * - cleanup_worktree model tool + worktrees CLI family + internal acquire/release actions;
 * - reconcileAfter: [WORKFLOW_PLUGIN_ID] soft ordering for post-restart native lease cleanup.
 * Read-only change inspection UI is provided by `builtin:changes`; worktree mutations stay agent/CLI only.
 */
import type { PluginDefinition } from '@helmx/protocol'
import { loadManagedSkillAsset } from './asset-paths.js'
import { WORKFLOW_PLUGIN_ID, WORKTREE_PLUGIN_ID } from './contracts.js'
import { asDeletedConversationId } from './shared-helpers.js'
import { WorktreeIsolation } from './worktree/isolation.js'
import { registerWorktreeActions } from './worktree/actions.js'
import { resolveWorktreeContextSection, WORKTREE_CONTEXT_SECTION_ID } from './worktree/worktree-context.js'
import {
  AGENT_BINDINGS_KV_NAMESPACE,
  LEASES_KV_NAMESPACE,
  WORKTREES_KV_NAMESPACE,
  type ManagedWorktreeRecord,
  type WorktreeAgentBinding,
  type WorktreeLeaseRecord,
} from './worktree/worktree-store.js'

export const WORKTREE_SKILL_ID = 'worktree' as const
export { WORKTREE_PLUGIN_ID }

function readWorktreeSkillAsset() {
  return loadManagedSkillAsset({
    pluginId: WORKTREE_PLUGIN_ID,
    skillId: WORKTREE_SKILL_ID,
    relativeDir: 'worktree/skill',
    missingErrorCode: 'worktree_skill_missing',
  })
}

export function createWorktreePlugin(): PluginDefinition {
  return {
    id: WORKTREE_PLUGIN_ID,
    name: { en: 'Managed Worktrees', 'zh-CN': '受管工作树' },
    description: {
      en: 'Managed Git worktrees for isolated agent workspaces: allocation, durable leases and holds, read-only inspection, the cleanup_worktree tool and the worktrees CLI.',
      'zh-CN': '受管 Git 工作树：隔离工作区分配、持久租约与持有锁、只读检视、cleanup_worktree 工具与 worktrees CLI。',
    },
    icon: 'git-branch',
    version: '0.1.0',
    definePlugin(ctx) {
      const worktreeKv = {
        worktrees: ctx.kv<ManagedWorktreeRecord>(WORKTREES_KV_NAMESPACE),
        leases: ctx.kv<WorktreeLeaseRecord>(LEASES_KV_NAMESPACE),
        agentBindings: ctx.kv<WorktreeAgentBinding>(AGENT_BINDINGS_KV_NAMESPACE),
      }

      const isolation = new WorktreeIsolation({
        host: {
          resolveSpawnTarget: (input) => ctx.host.resolveSpawnTarget(input),
          execEnv: (req, opts) => ctx.host.execEnv(req, opts),
          executionEnv: (nodeId, cwd) => ctx.host.executionEnv(nodeId, cwd),
          inspectNodePathUsage: (input) => ctx.host.inspectNodePathUsage(input),
          listActiveSpawnExecutions: () => ctx.host.listActiveSpawnExecutions(),
          redact: (text) => ctx.host.redact(text),
          getConversation: (id) => {
            const conv = ctx.host.getConversation(id)
            return { cwd: conv.cwd, nodeId: conv.nodeId, status: conv.status, profileId: conv.profileId }
          },
          get isClosing() {
            return ctx.host.isClosing
          },
        },
        kv: worktreeKv,
      })

      ctx.hook.onAgentSpawn(async (request, next) => {
        await isolation.aroundSpawn(request, next)
      }, { priority: 200 })

      ctx.hook.onBeforeTurn((turn) => {
        // acquire_worktree 会话没有 agent_spawn 尾注；按当前 hold 更新唯一命名段落，释放 hold 后撤销旧信息。
        const contextSection = resolveWorktreeContextSection(isolation.allocator.getForConversation(turn.conversation.id))
        const sections = turn.sections.filter((section) => section.id !== WORKTREE_CONTEXT_SECTION_ID)
        if (contextSection !== undefined) sections.push(contextSection)
        const sectionsChanged = sections.length !== turn.sections.length || sections.some((section, i) => {
          const previous = turn.sections[i]
          return previous?.id !== section.id || previous.text !== section.text
        })
        const stripCleanupTool = !isolation.allocator.hasActiveRecords() && turn.tools.some((tool) => tool.name === 'cleanup_worktree')
        if (!sectionsChanged && !stripCleanupTool) return
        return {
          action: 'transform',
          value: {
            ...turn,
            ...(stripCleanupTool ? { tools: turn.tools.filter((tool) => tool.name !== 'cleanup_worktree') } : {}),
            ...(sectionsChanged ? { sections } : {}),
          },
        }
      })

      ctx.host.onEvent('conversation.deleted', (event) => {
        const candidate = asDeletedConversationId(event)
        if (candidate !== undefined) {
          isolation.pruneConversation(candidate)
        }
      })

      ctx.service({
        id: 'worktree',
        reconcileAfter: [WORKFLOW_PLUGIN_ID],
        async start() {
          await ctx.host.skills.ensureSkill(readWorktreeSkillAsset())
        },
        async reconcile() {
          await isolation.reconcileStoppedNativeLeases()
        },
        async stop() {
          await isolation.flush()
        },
        inUse() {
          return isolation.allocator
            .list()
            .filter((r) => r.status === 'active' && r.hold !== undefined)
            .map((r) => ({
              kind: 'worktree_hold',
              id: r.id,
              label: `worktree "${ctx.host.redact(r.path)}" held by ${r.hold!.pluginId} (${ctx.host.redact(r.hold!.label)})`,
            }))
        },
      })

      registerWorktreeActions(ctx, { isolation })
    },
  }
}
