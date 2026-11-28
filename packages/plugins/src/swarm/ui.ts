import { COMPOSER_DOCK_SLOT, type HelmxPluginContext } from '@helmx/protocol'
import {
  BOARD_REPORT_RENDERER,
  BOARD_WAKEUP_RENDERER,
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
  SWARM_TOOL_NAMES,
} from './contracts.js'

export const SWARM_WORKBENCH_PANEL_ID = 'groups' as const

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
    title: { en: 'Swarm Board Message', 'zh-CN': '协同看板消息' },
    matchMeta: { renderer: BOARD_REPORT_RENDERER },
    client: { module: 'conversation.tsx', export: 'SwarmBoardReportCard' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-wakeup',
    title: { en: 'Swarm Board Wakeup', 'zh-CN': '协同看板唤醒' },
    matchMeta: { renderer: BOARD_WAKEUP_RENDERER },
    client: { module: 'conversation.tsx', export: 'SwarmBoardWakeupCard' },
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
