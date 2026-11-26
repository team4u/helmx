/**
 * Context bridge for opening and controlling the single ConversationTimeline
 * right-side process inspector drawer from nested step groups, thinking rows,
 * and tool rows without prop drilling or multiple mounted drawers.
 */
import { createContext, useContext } from 'react'
import type { ProcessInspectMode, ProcessInspectTarget } from './process-inspector-model.js'

export interface ProcessInspectorController {
  activeTarget: ProcessInspectTarget | null
  openStepGroup: (
    turnKey: string,
    segmentKey: string,
    opts?: { stepKey?: string; stepIndex?: number; followLive?: boolean },
  ) => void
  openStandaloneTool: (turnKey: string, toolKey: string, mode: ProcessInspectMode) => void
  close: () => void
}

export const ProcessInspectorContext = createContext<ProcessInspectorController | null>(null)

export function useProcessInspector(): ProcessInspectorController | null {
  return useContext(ProcessInspectorContext)
}
