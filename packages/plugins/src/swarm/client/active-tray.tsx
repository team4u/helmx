/**
 * Dedicated composer-dock active-tray surface entrypoint for builtin:swarm
 * (`SwarmActiveTray`). Decoupled from the heavy workbench panel.
 */
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import { SwarmActiveTray as SwarmActiveTrayImpl } from './SwarmActiveTray.tsx'

export function SwarmActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  return <SwarmActiveTrayImpl {...props} />
}
