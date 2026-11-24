/**
 * Shared batch management toolbar and destructive-delete confirmation dialog
 * used by ConversationOverview and SidebarConversationList.
 */
import type { ReactNode } from 'react'
import { Button, ConfirmDialog } from '@helmx/plugin-client'
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
          <Button
            variant="ghost"
            size="xs"
            disabled={anyBusy}
            title={exitTitle}
            onClick={onExit}
          >
            {t('shell.batch.exit')}
          </Button>
        </div>
        <div className="batch-bar-actions">
          <Button
            size="sm"
            disabled={selectableCount === 0 || anyBusy}
            onClick={onToggleSelectAll}
          >
            {isAllSelected ? t('shell.batch.clear') : t('shell.batch.selectAll')}
          </Button>
          {extraActions}
          <Button
            variant="danger"
            size="sm"
            className="btn-danger-sm"
            pending={deleting}
            disabled={selectedCount === 0 || busy}
            onClick={onRequestDelete}
          >
            {deleting ? t('shell.batch.deleting') : t('shell.batch.deleteCount', { count: selectedCount })}
          </Button>
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
