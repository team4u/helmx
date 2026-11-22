/**
 * Shared batch management toolbar and destructive-delete confirmation dialog
 * used by ConversationOverview, SidebarAgentStandings, and SidebarArchivedConversations.
 */
import type { ReactNode } from 'react'
import { ConfirmDialog } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface BatchActionBarProps {
  className?: string
  selectedCount: number
  selectableCount: number
  isAllSelected: boolean
  deleting: boolean
  /** Disables exit / select-all / delete while another batch op (e.g. archive/restore) runs. */
  busy?: boolean
  exitTitle?: string
  onExit: () => void
  onToggleSelectAll: () => void
  extraActions?: ReactNode
  confirmOpen: boolean
  onConfirmOpenChange: (open: boolean) => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
}

export function BatchActionBar({
  className,
  selectedCount,
  selectableCount,
  isAllSelected,
  deleting,
  busy = false,
  exitTitle,
  onExit,
  onToggleSelectAll,
  extraActions,
  confirmOpen,
  onConfirmOpenChange,
  onRequestDelete,
  onConfirmDelete,
}: BatchActionBarProps): ReactNode {
  const { t } = useWebLocale()
  const anyBusy = deleting || busy
  return (
    <>
      <div className={className ? `batch-bar ${className}` : 'batch-bar'}>
        <div className="batch-bar-header">
          <span className="batch-bar-count tabular-nums">
            {t('shell.batch.selected', { count: selectedCount })}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={anyBusy}
            title={exitTitle}
            onClick={onExit}
          >
            {t('shell.batch.exit')}
          </button>
        </div>
        <div className="batch-bar-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={selectableCount === 0 || anyBusy}
            onClick={onToggleSelectAll}
          >
            {isAllSelected ? t('shell.batch.clear') : t('shell.batch.selectAll')}
          </button>
          {extraActions}
          <button
            type="button"
            className="btn btn-sm btn-danger-sm"
            disabled={selectedCount === 0 || anyBusy}
            onClick={onRequestDelete}
          >
            {deleting ? t('shell.batch.deleting') : t('shell.batch.deleteCount', { count: selectedCount })}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={onConfirmOpenChange}
        title={t('shell.batch.deleteConfirmTitle', { count: selectedCount })}
        description={t('shell.batch.deleteConfirmDesc')}
        confirmText={t('shell.batch.deleteConfirmButton')}
        danger
        onConfirm={onConfirmDelete}
        onCancel={() => onConfirmOpenChange(false)}
      />
    </>
  )
}
