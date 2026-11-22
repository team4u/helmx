/**
 * Dedicated tool-view surface entrypoint for builtin:swarm (`SwarmToolView`).
 */
import './styles-tool-view.css'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helmx/protocol'
import { SwarmToolView as SwarmToolViewImpl } from './SwarmToolView.tsx'

export function SwarmToolView(props: ToolViewProps): ReactNode {
  return <SwarmToolViewImpl {...props} />
}
