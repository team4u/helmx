/**
 * Split-pane panel focus resolution helpers.
 */
import type { FocusedPanel, ResolvedTarget } from './types.js'

export function resolveFocusedPanel(
  focusedPanel: FocusedPanel,
  splitTarget: ResolvedTarget | null,
): FocusedPanel {
  return splitTarget !== null && focusedPanel === 'split' ? 'split' : 'primary'
}

export function activeTargetForPanel(
  primaryTarget: ResolvedTarget,
  splitTarget: ResolvedTarget | null,
  focusedPanel: FocusedPanel,
): ResolvedTarget {
  return resolveFocusedPanel(focusedPanel, splitTarget) === 'split' && splitTarget !== null
    ? splitTarget
    : primaryTarget
}
