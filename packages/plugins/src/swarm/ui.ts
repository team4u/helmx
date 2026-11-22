import { COMPOSER_DOCK_SLOT, type HelmxPluginContext } from '@helmx/protocol'
import {
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
} from './contracts.js'

export const SWARM_WORKBENCH_PANEL_ID = 'groups' as const

/** Model-facing swarm tool names (single source for the toolView trace registration). */
const SWARM_TOOL_NAMES = [
  'swarm_create_group',
  'swarm_update_group',
  'swarm_manage_channel',
  'swarm_dispatch_worker',
  'swarm_board_post',
  'swarm_board_read',
  'swarm_board_status',
  'swarm_abort_worker',
  'swarm_switch_worker_model',
  'swarm_inspect_worker',
  'swarm_archive_worker',
  'swarm_close_group',
] as const

/**
 * Registration-time UI contributions for `builtin:swarm` (conversation-scoped
 * orchestration surfaces; display metadata only, data flows through the public
 * `index` / `board-badges` docs and the per-coordinator `board-view` session
 * doc).
 *
 * Same mental model as builtin:workflow: the timeline owns 26px tool trace
 * rows, the composer dock owns the in-flight tray, and the right workbench
 * owns the orchestration panel. No standalone board screen or header entry
 * fights the host for the primary stage.
 */
export function registerSwarmUi(ctx: HelmxPluginContext): void {
  ctx.ui.toolView({
    id: 'swarm-tool-trace',
    toolNames: [...SWARM_TOOL_NAMES],
    replaceRow: true,
    client: { module: 'tool-view.tsx', export: 'SwarmToolView' },
  })
  // 活动托盘仅主控会话挂载：composer dock 槽语义是「本会话派出的在飞事项」，
  // worker 视角的组上下文由会话状态灯与按需打开的工作台面板提供。
  ctx.ui.slot({
    id: 'swarm-active-tray',
    target: COMPOSER_DOCK_SLOT,
    scope: COORDINATOR_SCOPE,
    client: { module: 'active-tray.tsx', export: 'SwarmActiveTray' },
  })
  // 结单历史 tag 仅放行工作台编排面板查看历史编组；@/# 补全仍限活跃参与者。
  ctx.ui.workbenchPanel({
    id: SWARM_WORKBENCH_PANEL_ID,
    label: { en: 'Swarm Groups', 'zh-CN': 'Swarm 协同编组' },
    icon: 'network',
    order: 12,
    scope: HISTORY_PARTICIPANT_SCOPE,
    badge: { doc: 'board-badges', byConversationField: 'byConversation' },
    client: { module: 'workbench.tsx', export: 'SwarmWorkbenchPanel' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-report',
    title: { en: 'Swarm Board Report', 'zh-CN': '协同看板汇总' },
    matchMeta: { renderer: BOARD_REPORT_RENDERER },
    client: { module: 'board-receipts.tsx', export: 'SwarmBoardReportPill' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-wakeup',
    title: { en: 'Swarm Board Wakeup', 'zh-CN': '协同看板唤醒' },
    matchMeta: { renderer: BOARD_WAKEUP_RENDERER },
    client: { module: 'board-receipts.tsx', export: 'SwarmBoardWakeupPill' },
  })
  ctx.ui.composerCompleter({
    id: 'swarm-board-members',
    label: { en: 'Swarm Members', 'zh-CN': '协同组成员' },
    trigger: '@',
    priority: 120,
    scope: PARTICIPANT_SCOPE,
    source: { kind: 'action', actionId: 'complete_board_members' },
  })
  ctx.ui.composerCompleter({
    id: 'swarm-board-channels',
    label: { en: 'Swarm Channels', 'zh-CN': '协同组频道' },
    trigger: '#',
    priority: 120,
    scope: PARTICIPANT_SCOPE,
    source: { kind: 'action', actionId: 'complete_board_channels' },
  })
}
