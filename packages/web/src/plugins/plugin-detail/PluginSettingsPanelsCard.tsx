import React from 'react'
import type { SettingsPanelSpec } from '@helmx/protocol/browser'
import { resolveLocalizedText, type HelmxLocale } from '@helmx/protocol/browser'
import { Card, HelmxIcon, Stack } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { QualifiedUiSpec } from '../../lib/types.js'
import { PluginUiView } from '../../ui/PluginUiView.js'

export interface PluginSettingsPanelsCardProps {
  pluginId: string
  panels: Array<QualifiedUiSpec<SettingsPanelSpec>>
  locale: HelmxLocale
  t: WebMessageTranslator
}

/** 扩展设置面板：经 PluginUiView 挂载插件贡献的 settingsPanels（多面板时逐个标注标题）。 */
export function PluginSettingsPanelsCard({ pluginId, panels, locale, t }: PluginSettingsPanelsCardProps): React.JSX.Element {
  // 仅在 panels 非空时由父级渲染（单面板标题取首个面板 label）。
  const [firstPanel] = panels
  return (
    <Card
      variant="subtle"
      title={
        <Stack direction="horizontal" gap="xs" align="center" inline>
          <HelmxIcon name="layout" size={13} />
          <span>
            {panels.length > 1
              ? t('plugins.drawer.settingsPanelsCount', { count: panels.length })
              : resolveLocalizedText(firstPanel!.spec.label, locale) ||
                t('plugins.drawer.settingsPanels')}
          </span>
        </Stack>
      }
    >
      {panels.map((panel) => (
        <div
          key={`${panel.pluginId}/${panel.spec.id}`}
          className="plugin-settings-panels"
        >
          {panels.length > 1 && (
            <div className="plugin-settings-panel-title">
              {resolveLocalizedText(panel.spec.label, locale) || panel.spec.id}
            </div>
          )}
          <PluginUiView
            pluginId={pluginId}
            spec={panel.spec}
            label={t('plugins.drawer.settingsPanelLabel', { id: panel.spec.id })}
          />
        </div>
      ))}
    </Card>
  )
}
