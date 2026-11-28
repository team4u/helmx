import type { HTMLAttributes, ReactNode } from 'react'
import { useUiTranslator } from '../ui-locale-context.js'
import { uiCopy } from '../ui-copy.js'
import { Button } from './Button.js'

export interface BatchBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of currently selected items (surfaced via `data-selected-count`). */
  selectedCount: number
  /** Selection summary label rendered on the left of the header row. */
  selectedLabel: ReactNode
  /** Exit action label (defaults to localized `uiCopy.close`). */
  exitLabel?: ReactNode
  /** Optional title/tooltip for the exit button. */
  exitTitle?: string
  /** Disables the exit button while a batch operation is in flight. */
  exitDisabled?: boolean
  /** Callback fired when clicking the exit button (omit to hide the exit button). */
  onExit?: () => void
  /** Action buttons displayed in the secondary action row. */
  actions?: ReactNode
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderable(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

/**
 * Neutral two-row batch selection toolbar (UI HIG batch governance shell).
 */
export function BatchBar({
  className,
  selectedCount,
  selectedLabel,
  exitLabel,
  exitTitle,
  exitDisabled = false,
  onExit,
  actions,
  children,
  ...rest
}: BatchBarProps): ReactNode {
  const t = useUiTranslator()
  const resolvedActions = hasRenderable(actions) ? actions : children

  return (
    <div
      className={joinClass('batch-bar', className)}
      data-selected-count={selectedCount}
      {...rest}
    >
      <div className="batch-bar-header">
        <span className="batch-bar-count tabular-nums">{selectedLabel}</span>
        {onExit && (
          <Button
            variant="ghost"
            size="xs"
            disabled={exitDisabled}
            title={exitTitle}
            onClick={onExit}
          >
            {exitLabel ?? t(uiCopy.close)}
          </Button>
        )}
      </div>
      {hasRenderable(resolvedActions) && (
        <div className="batch-bar-actions">{resolvedActions}</div>
      )}
    </div>
  )
}
