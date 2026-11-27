import React from 'react'
import { ConfirmDialog } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'

export interface ProfileConfirmDialogsProps {
  inline: boolean
  /** 删除确认描述使用的名称（表单名称优先，回落 ID）。 */
  deleteTargetName: string
  showDeleteConfirm: boolean
  onShowDeleteChange: (open: boolean) => void
  isDeleting: boolean
  onConfirmDelete: () => void
  showDiscardConfirm: boolean
  onShowDiscardChange: (open: boolean) => void
  onDiscard: () => void
}

/** 抽屉附属的两枚二次确认：删除角色与丢弃未保存修改。 */
export function ProfileConfirmDialogs({
  inline,
  deleteTargetName,
  showDeleteConfirm,
  onShowDeleteChange,
  isDeleting,
  onConfirmDelete,
  showDiscardConfirm,
  onShowDiscardChange,
  onDiscard,
}: ProfileConfirmDialogsProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <>
      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={onShowDeleteChange}
        title={t('profiles.drawer.delete')}
        description={t('profiles.drawer.deleteConfirm.body', { name: deleteTargetName })}
        confirmText={isDeleting ? t('profiles.drawer.deleting') : t('profiles.drawer.deleteConfirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={onConfirmDelete}
      />

      {/* Dirty form guard dialog */}
      <ConfirmDialog
        open={showDiscardConfirm}
        onOpenChange={onShowDiscardChange}
        title={t('profiles.drawer.discardConfirm.title')}
        description={t('profiles.drawer.discardConfirm.body')}
        confirmText={t('profiles.drawer.discardConfirm.confirm')}
        cancelText={t('profiles.drawer.discardConfirm.cancel')}
        danger
        inline={inline}
        onConfirm={onDiscard}
      />
    </>
  )
}
