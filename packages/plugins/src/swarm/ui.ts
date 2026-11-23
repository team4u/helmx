import { COMPOSER_DOCK_SLOT, type HelmxPluginContext } from '@helmx/protocol'
import {
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
} from './contracts.js'

export const SWARM_WORKBENCH_PANEL_ID = 'groups' as const

const SWARM_TOOL_NAMES = [
  'swarm_create_group',
  'swarm_update_group',
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

export function registerSwarmUi(ctx: HelmxPluginContext): void {
  ctx.ui.toolView({
    id: 'swarm-tool-trace',
    toolNames: [...SWARM_TOOL_NAMES],
    replaceRow: true,
    client: { module: 'conversation.tsx', export: 'SwarmToolView' },
  })
  ctx.ui.slot({
    id: 'swarm-active-tray',
    target: COMPOSER_DOCK_SLOT,
    scope: COORDINATOR_SCOPE,
    client: { module: 'conversation.tsx', export: 'SwarmActiveTray' },
  })
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
    client: { module: 'conversation.tsx', export: 'SwarmBoardReportPill' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-wakeup',
    title: { en: 'Swarm Board Wakeup', 'zh-CN': '协同看板唤醒' },
    matchMeta: { renderer: BOARD_WAKEUP_RENDERER },
    client: { module: 'conversation.tsx', export: 'SwarmBoardWakeupPill' },
  })
  ctx.ui.composerCompleter({
    id: 'swarm-board-members',
    label: { en: 'Swarm Members', 'zh-CN': '协同组成员' },
    trigger: '@',
    priority: 120,
    scope: PARTICIPANT_SCOPE,
    source: { kind: 'action', actionId: 'complete_board_members' },
  })
}
