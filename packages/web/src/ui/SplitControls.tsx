import * as React from 'react'
import { Button, HelmxIcon, IconButton, Tooltip } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface CloseSplitButtonProps {
  onCloseSplit?: () => void
  label?: string
}

/**
 * Shared close button for split panes:
 * - Radix Tooltip (content = localized "close this split view", side = bottom);
 * - carries the split-close-btn and pane-action-label classes so split panes
 *   and narrow screens respond automatically.
 */
export function CloseSplitButton({
  onCloseSplit,
  label,
}: CloseSplitButtonProps): React.JSX.Element {
  const { t } = useWebLocale()
  const effectiveLabel = label ?? t('ui.split.closeView')
  return (
    <Tooltip content={t('ui.split.closeThisView')} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        className="split-close-btn"
        icon={<HelmxIcon name="x" size={13} />}
        aria-label={effectiveLabel}
        onClick={onCloseSplit}
      >
        <span className="pane-action-label">{effectiveLabel}</span>
      </Button>
    </Tooltip>
  )
}

export interface SplitToggleButtonProps {
  isSplitActive: boolean
  onToggleSplit: () => void
}

/**
 * Split open/close toggle button:
 * - Radix Tooltip (content switches between the localized close/side-by-side
 *   copy, side = bottom);
 * - carries the split-toggle-btn and split-active state classes; narrow
 *   screens keep only the active state.
 */
export function SplitToggleButton({
  isSplitActive,
  onToggleSplit,
}: SplitToggleButtonProps): React.JSX.Element {
  const { t } = useWebLocale()
  const actionLabel = isSplitActive ? t('ui.split.closeView') : t('ui.split.sideBySide')
  const tooltipLabel = isSplitActive ? t('ui.split.closeThisView') : t('ui.split.toggleTitle')
  return (
    <Tooltip content={tooltipLabel} side="bottom">
      <IconButton
        variant={isSplitActive ? 'primary' : 'default'}
        size="sm"
        className={`split-toggle-btn${isSplitActive ? ' split-active' : ''}`}
        icon={<HelmxIcon name="columns" size={12} />}
        aria-label={actionLabel}
        onClick={onToggleSplit}
      />
    </Tooltip>
  )
}
