/**
 * Shared split-pane open/close toggle hook for main-stage views
 * (System Centers, ScreenHost, AgentStandbyPane, ConversationOverview).
 */
import { useCallback } from 'react'
import { useSplitTarget, useStoreActions } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'

export interface UsePaneSplitToggleOptions {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Target to open in the right split pane when split is currently closed. */
  getSplitTarget: () => ResolvedTarget
}

export interface UsePaneSplitToggleResult {
  isSplitActive: boolean
  toggleSplit: () => void
}

export function usePaneSplitToggle({
  isSplit = false,
  onCloseSplit,
  getSplitTarget,
}: UsePaneSplitToggleOptions): UsePaneSplitToggleResult {
  const splitTarget = useSplitTarget()
  const { openTarget, closeSplit } = useStoreActions()

  const toggleSplit = useCallback(() => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget(getSplitTarget(), { split: true })
  }, [isSplit, onCloseSplit, splitTarget, closeSplit, openTarget, getSplitTarget])

  return {
    isSplitActive: splitTarget !== null,
    toggleSplit,
  }
}
