import React from 'react'
import type { PluginDiagnosticError } from '@helmx/protocol/browser'
import { Button, Callout, Stack } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { pluginErrorStageLabel } from '../plugin-card-model.js'
import type { PluginInUseConfirm } from './use-plugin-drawer-actions.js'

/** 失败诊断框：结构化阶段、错误码与完整消息。 */
export function PluginFailureDiagnosticCallout({ error }: { error: PluginDiagnosticError }): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <Callout tone="err">
      <div className="plugin-diagnostic-body" role="alert">
        <div className="plugin-diagnostic-title">{t('plugins.drawer.diagnosticTitle')}</div>
        <div className="text-subtle">
          {t('plugins.drawer.diagnosticMetaPrefix', {
            stage: pluginErrorStageLabel(error.stage, t),
          })}
          <span className="mono">{error.code}</span>
        </div>
        <div className="selectable plugin-diagnostic-message">{error.message}</div>
      </div>
    </Callout>
  )
}

export interface PluginInUseConfirmCalloutProps {
  confirm: PluginInUseConfirm
  toggling: boolean
  onCancel: () => void
  onForceDisable: () => void
}

/** 409 plugin_in_use 占用确认：列出持久占用清单供用户知情后选择强制停用。 */
export function PluginInUseConfirmCallout({
  confirm,
  toggling,
  onCancel,
  onForceDisable,
}: PluginInUseConfirmCalloutProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <Callout tone="warn">
      <div className="plugin-inuse-body" role="alert">
        <div className="plugin-diagnostic-title">{t('plugins.drawer.inUseTitle')}</div>
        <div className="text-subtle">{t('plugins.drawer.inUseHint')}</div>
        <ul className="plugin-inuse-list">
          {confirm.usages.map((usage) => (
            <li key={`${usage.kind}/${usage.id}`} title={`${usage.kind}/${usage.id}`}>
              {usage.label}
            </li>
          ))}
        </ul>
        <Stack direction="horizontal" gap="sm" align="center" justify="end" className="plugin-inuse-actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="sm" icon="square" disabled={toggling} onClick={onForceDisable}>
            {t('plugins.drawer.forceDisable')}
          </Button>
        </Stack>
      </div>
    </Callout>
  )
}
