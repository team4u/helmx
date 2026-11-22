/**
 * Dedicated right workbench panel surface entrypoint for builtin:swarm
 * (`SwarmWorkbenchPanel`). Loaded lazily only when the workbench panel opens.
 */
import './styles-workbench.css'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol'
import { SwarmWorkbenchPanel as SwarmWorkbenchPanelImpl } from './SwarmWorkbenchPanel.tsx'

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  return <SwarmWorkbenchPanelImpl {...props} />
}
