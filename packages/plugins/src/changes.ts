/**
 * `builtin:changes`: read-only Git diff inspector plugin (default-enabled, zero static dep on worktree/workflow/swarm).
 *
 * Responsibilities:
 * - Read-only workspace inspection actions (`inspect_workspace`, `inspect_workspace_file`) resolved via conversation `(nodeId, cwd)`;
 * - Fullscreen / split-screen Changes Inspector (`screen:builtin:changes/inspector`) supporting both ordinary conversation workspaces and managed worktrees;
 * - Conversation right-hand Workbench `Changes` panel (`workbenchPanel` id `'changes'`);
 * - Decoupled UI slots contributed to `builtin:workflow` and `builtin:swarm` (`workflow-worktree-inspect`, `workflow-trace-inspect`, `swarm-worktree-actions`).
 */
import type { PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  CHANGES_PANEL_ID,
  CHANGES_PLUGIN_ID,
  CHANGES_SCREEN_ID,
  SWARM_PLUGIN_ID,
  WORKFLOW_PLUGIN_ID,
} from './contracts.js'
import { registerChangesActions } from './changes/actions.js'

export { CHANGES_PANEL_ID, CHANGES_PLUGIN_ID, CHANGES_SCREEN_ID }

export function createChangesPlugin(): PluginDefinition {
  return {
    id: CHANGES_PLUGIN_ID,
    name: { en: 'Changes', 'zh-CN': '改动' },
    description: {
      en: 'Read-only Git diff inspector for conversation workspaces and managed worktrees: uncommitted changes, unpushed commits, commit history, and on-demand file diffs.',
      'zh-CN': '通用只读 Git 差异检视：支持普通会话工作区（未提交 / 未推送 / 提交历史 / 选定基线）与受管工作树按需单文件彩色 Diff。',
    },
    icon: 'file-diff',
    version: '0.1.0',
    ...resolvePluginClientAssets(CHANGES_PLUGIN_ID, 'changes', 'changes_plugin_client_missing'),
    definePlugin(ctx) {
      registerChangesActions(ctx)

      const label = { en: 'Changes', 'zh-CN': '改动' }
      ctx.ui.sidebarItem({
        id: 'changes-inspector',
        label,
        icon: 'file-diff',
        target: `screen:${CHANGES_PLUGIN_ID}/${CHANGES_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: CHANGES_SCREEN_ID,
        label,
        icon: 'file-diff',
        client: { module: 'screen.tsx', export: 'ChangesInspectorScreen' },
      })
      ctx.ui.workbenchPanel({
        id: CHANGES_PANEL_ID,
        label,
        icon: 'file-diff',
        order: 25,
        client: { module: 'workbench.tsx', export: 'ChangesWorkbenchPanel' },
      })
      ctx.ui.slot({
        id: 'workflow-worktree-inspect',
        target: `${WORKFLOW_PLUGIN_ID}/worktree-inspect`,
        priority: 100,
        client: { module: 'slots.tsx', export: 'WorkflowWorktreeInspectSlot' },
      })
      ctx.ui.slot({
        id: 'workflow-trace-inspect',
        target: `${WORKFLOW_PLUGIN_ID}/worktree-trace-inspect`,
        priority: 100,
        client: { module: 'slots.tsx', export: 'WorktreeTraceInspectSlot' },
      })
      ctx.ui.slot({
        id: 'swarm-worktree-actions',
        target: `${SWARM_PLUGIN_ID}/worktree-actions`,
        priority: 100,
        client: { module: 'slots.tsx', export: 'SwarmWorktreeActionsSlot' },
      })
    },
  }
}
