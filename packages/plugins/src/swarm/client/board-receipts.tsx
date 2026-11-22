/**
 * Dedicated timeline receipt pills surface entrypoint for builtin:swarm
 * (`SwarmBoardReportPill` and `SwarmBoardWakeupPill`).
 */
import './styles-receipts.css'
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helmx/protocol'
import {
  SwarmBoardReportPill as BoardReportPillImpl,
  SwarmBoardWakeupPill as BoardWakeupPillImpl,
} from './BoardReceipts.tsx'

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  return <BoardReportPillImpl {...props} />
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  return <BoardWakeupPillImpl {...props} />
}
