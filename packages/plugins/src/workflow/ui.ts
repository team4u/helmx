/**
 * builtin:workflow UI 扩展点注册（自 workflow.ts 入口拆出；client.tsx 轨道）。
 *
 * 组件经 usePluginSessionDoc 自行订阅 runs 分片；后台结算汇报经
 * meta.renderer 精确匹配折叠卡；工作流库是跨会话可复用资产的独立视图
 * 空间（定义管理不属会话 workbench）。
 */
import { COMPOSER_DOCK_SLOT, type HelmxPluginContext } from '@helmx/protocol'
import { WORKFLOW_PLUGIN_ID, WORKFLOW_RUN_BADGES_DOC } from '../contracts.js'
import { BACKGROUND_REPORT_RENDERER } from './background.js'

export function registerWorkflowUi(ctx: HelmxPluginContext): void {
  ctx.ui.timelineRenderer({
    id: 'background-report',
    kinds: ['helmx.input'],
    matchMeta: { renderer: BACKGROUND_REPORT_RENDERER },
    client: { module: 'index.tsx', export: 'BackgroundReportCard' },
  })
  ctx.ui.toolView({
    id: 'subagent-card',
    toolNames: ['subagent'],
    replaceRow: true,
    client: { module: 'index.tsx', export: 'SubagentToolView' },
  })
  ctx.ui.toolView({
    id: 'workflow-card',
    toolNames: ['SubagentWorkflow'],
    replaceRow: true,
    client: { module: 'index.tsx', export: 'WorkflowToolView' },
  })
  ctx.ui.slot({
    id: 'active-tray',
    target: COMPOSER_DOCK_SLOT,
    client: { module: 'index.tsx', export: 'WorkflowActiveTray' },
  })
  ctx.ui.workbenchPanel({
    id: 'tasks',
    label: { en: 'Workflows & Subagents', 'zh-CN': '工作流与子代理' },
    icon: 'git-branch',
    order: 10,
    badge: { doc: WORKFLOW_RUN_BADGES_DOC, byConversationField: 'byConversation' },
    client: { module: 'workbench.tsx', export: 'WorkflowWorkbenchPanel' },
  })
  // 工作流库：跨会话可复用资产的独立视图空间（定义管理不属会话 workbench）。
  ctx.ui.sidebarItem({
    id: 'workflow-library',
    label: { en: 'Workflow Library', 'zh-CN': '工作流库' },
    icon: 'workflow',
    target: `screen:${WORKFLOW_PLUGIN_ID}/library`,
    order: 16,
  })
  ctx.ui.screen({
    id: 'library',
    label: { en: 'Workflow Library', 'zh-CN': '工作流库' },
    description: {
      en: 'Browse saved multi-agent workflow definitions, inspect scripts, and launch runs.',
      'zh-CN': '浏览已保存的多智能体工作流定义、检视脚本源码并发起运行。',
    },
    keywords: ['workflow', 'workflows', 'library', 'template', 'subagent', 'orchestration', '工作流', '工作流库', '模板'],
    icon: 'workflow',
    client: { module: 'library.tsx', export: 'WorkflowLibraryScreen' },
  })
}
