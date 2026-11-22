/**
 * builtin:worktree: the managed Git worktree plugin (default-enabled, zero static dep on workflow).
 *
 * Responsibilities:
 * - WorktreeAllocator / WorktreeStore / durable leases / ManagedWorktreeHold / agentId bindings;
 * - agent_spawn around hook (priority 200) for allocation / resume / reattach;
 * - cleanup_worktree model tool + worktrees CLI family + internal acquire/release actions;
 * - UI slots (`builtin:workflow/worktree-inspect` & `builtin:workflow/worktree-cleanup`) so
 *   disabling this plugin cleanly removes all worktree inspect/cleanup UI from workflow cards;
 * - reconcileAfter: [WORKFLOW_PLUGIN_ID] soft ordering for post-restart native lease cleanup.
 */
import type { PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { WORKFLOW_PLUGIN_ID, WORKTREE_PLUGIN_ID } from './contracts.js'
import { WorktreeIsolation } from './worktree/isolation.js'
import { registerWorktreeActions } from './worktree/actions.js'

export { WORKTREE_PLUGIN_ID }

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
    ...resolvePluginClientAssets(WORKTREE_PLUGIN_ID, 'worktree', 'worktree_plugin_client_missing'),
    definePlugin(ctx) {
      // `ctx.doc` already deep-clones on get/set/update; no extra structuredClone wrapper needed.
      const worktreeDocs = ctx.doc<Record<string, unknown>>('worktree-state', {})
      const worktreeDocStore = {
        get<T>(key: string, initial: T): T {
          const raw = worktreeDocs.get()[key]
          return raw === undefined ? initial : (raw as T)
        },
        set<T>(key: string, value: T): void {
          worktreeDocs.update((current) => ({ ...current, [key]: value }))
        },
        flush: (): Promise<void> => worktreeDocs.flush(),
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
        docStore: worktreeDocStore,
      })

      ctx.hook.onAgentSpawn(async (request, next) => {
        await isolation.aroundSpawn(request, next)
      }, { priority: 200 })

      ctx.hook.onBeforeTurn((turn) => {
        if (isolation.allocator.list().some((record) => record.status === 'active')) return
        if (!turn.tools.some((tool) => tool.name === 'cleanup_worktree')) return
        return {
          action: 'transform',
          value: {
            ...turn,
            tools: turn.tools.filter((tool) => tool.name !== 'cleanup_worktree'),
          },
        }
      })

      ctx.host.onEvent('conversation.deleted', (raw) => {
        const record = raw === null || typeof raw !== 'object' ? undefined : (raw as Record<string, unknown>)
        const candidate = record?.['conversationId'] ?? record?.['id']
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1) {
          isolation.pruneConversation(candidate)
        }
      })

      ctx.service({
        id: 'worktree',
        reconcileAfter: [WORKFLOW_PLUGIN_ID],
        start() {},
        async reconcile() {
          await isolation.reconcileStoppedNativeLeases()
        },
        async stop() {
          await worktreeDocs.flush()
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

      ctx.ui.slot({
        id: 'worktree-inspect',
        target: `${WORKFLOW_PLUGIN_ID}/worktree-inspect`,
        priority: 100,
        client: { module: 'slots.tsx', export: 'WorktreeInspectSlot' },
      })
      ctx.ui.slot({
        id: 'worktree-cleanup',
        target: `${WORKFLOW_PLUGIN_ID}/worktree-cleanup`,
        priority: 100,
        client: { module: 'slots.tsx', export: 'WorktreeCleanupSlot' },
      })
    },
  }
}
