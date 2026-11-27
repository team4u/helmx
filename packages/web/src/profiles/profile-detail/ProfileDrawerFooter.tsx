import React from 'react'
import { Button, Stack } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'

export interface ProfileDrawerFooterProps {
  canDelete: boolean
  isSaving: boolean
  isDeleting: boolean
  saveDisabled: boolean
  onRequestDelete: () => void
  /** 关闭请求：脏表单时由父级改为弹出丢弃确认。 */
  onRequestClose: () => void
  onSave: () => void
}

/** 抽屉底栏：左侧删除（非系统角色）、右侧取消与保存。 */
export function ProfileDrawerFooter({
  canDelete,
  isSaving,
  isDeleting,
  saveDisabled,
  onRequestDelete,
  onRequestClose,
  onSave,
}: ProfileDrawerFooterProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <Stack direction="horizontal" gap="sm" align="center" justify="between" className="flex-1">
      <div>
        {canDelete && (
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            className="text-err"
            disabled={isSaving || isDeleting}
            onClick={onRequestDelete}
          >
            {t('profiles.drawer.delete')}
          </Button>
        )}
      </div>

      <Stack direction="horizontal" gap="sm" align="center">
        <Button
          variant="ghost"
          size="sm"
          disabled={isSaving || isDeleting}
          onClick={onRequestClose}
        >
          {t('common.cancel')}
        </Button>

        <Button
          variant="primary"
          size="sm"
          icon="check"
          pending={isSaving}
          disabled={isDeleting || saveDisabled}
          onClick={onSave}
        >
          {isSaving ? t('profiles.drawer.saving') : t('profiles.drawer.save')}
        </Button>
      </Stack>
    </Stack>
  )
}
