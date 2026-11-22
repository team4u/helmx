/**
 * Single client barrel entrypoint for builtin:swarm:
 * exports all 5 UI surface components with one deduplicated stylesheet chain.
 */
import './styles-tool-view.css'
import './styles-tray.css'
import './styles-workbench.css'
import './styles-receipts.css'

export { SwarmActiveTray } from './SwarmActiveTray.tsx'
export { SwarmBoardReportPill, SwarmBoardWakeupPill } from './BoardReceipts.tsx'
export { SwarmToolView } from './SwarmToolView.tsx'
export { SwarmWorkbenchPanel } from './SwarmWorkbenchPanel.tsx'
