import React from 'react'
import { resolveLocalizedText, type HelmxLocale, type PluginSummary } from '@helmx/protocol/browser'
import { ConfirmDialog } from '@helmx/ui'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { PluginPackageOp } from './use-plugin-drawer-actions.js'

export interface PluginRemoveConfirmDialogProps {
  plugin: PluginSummary | null
  open: boolean
  packageOp: PluginPackageOp
  inline: boolean
  locale: HelmxLocale
  t: WebMessageTranslator
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

/** 受管插件卸载二次确认（卸载进行中锁定关闭与重复提交）。 */
export function PluginRemoveConfirmDialog({
  plugin,
  open,
  packageOp,
  inline,
  locale,
  t,
  onOpenChange,
  onConfirm,
  onCancel,
}: PluginRemoveConfirmDialogProps): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      inline={inline}
      contentClassName="plugin-remove-confirm"
      onOpenChange={onOpenChange}
      title={t('plugins.package.uninstallPlugin')}
      description={t('plugins.package.confirmUninstallBody', {
        name: (plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') || plugin?.id || '',
        id: plugin?.id ?? '',
      })}
      confirmText={packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.confirmUninstall')}
      cancelText={t('common.cancel')}
      danger
      pending={packageOp === 'removing'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
