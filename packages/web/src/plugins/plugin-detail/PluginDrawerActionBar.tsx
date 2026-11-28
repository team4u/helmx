import React from 'react'
import { isPluginSummaryActive, type PluginSummary } from '@helmx/protocol/browser'
import { Badge, Button, Card, Stack } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import type { HelmxStoreActions } from '../../lib/helmx-store.js'
import { isPluginFailed } from '../plugin-center-model.js'
import type { PluginScreenRef } from '../plugin-card-model.js'

export interface PluginDrawerActionBarProps {
  plugin: PluginSummary
  toggling: boolean
  actions: HelmxStoreActions | null
  pluginScreens: PluginScreenRef[]
  primaryScreen: PluginScreenRef | null
  onToggle: (plugin: PluginSummary, targetEnabled?: boolean) => void
}

/** 快捷操作与启停栏：当前状态徽章、Screen 主屏/分屏快捷打开与启停主按钮。 */
export function PluginDrawerActionBar({
  plugin,
  toggling,
  actions,
  pluginScreens,
  primaryScreen,
  onToggle,
}: PluginDrawerActionBarProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <Card variant="subtle">
      <Stack direction="horizontal" gap="md" align="center" justify="between" wrap>
        <Stack direction="horizontal" gap="sm" align="center" className="plugin-drawer-status-wrap">
          <span className="text-subtle">{t('plugins.drawer.currentStatus')}</span>
          {isPluginFailed(plugin) ? (
            <Badge tone="err" icon="alert-circle" title={t('plugins.drawer.errorBadgeTitle')}>
              {t('plugins.status.error')}
            </Badge>
          ) : isPluginSummaryActive(plugin) ? (
            <Badge tone="ok" icon="check">
              {t('common.enabled')}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('common.disabled')}</Badge>
          )}
        </Stack>
        <Stack direction="horizontal" gap="xs" align="center" justify="end" wrap className="plugin-drawer-screen-actions">
          {primaryScreen !== null && actions !== null && (
            <>
              <Button
                size="sm"
                icon="play"
                title={
                  pluginScreens.length > 1
                    ? t('plugins.drawer.openMainViewMultiTitle', {
                        screenId: primaryScreen.screenId,
                        count: pluginScreens.length,
                      })
                    : t('plugins.drawer.openMainViewTitle')
                }
                onClick={() =>
                  actions.openTarget({
                    kind: 'screen',
                    pluginId: primaryScreen.pluginId,
                    screenId: primaryScreen.screenId,
                  })
                }
              >
                {t('plugins.openView')}
              </Button>
              <Button
                size="sm"
                icon="columns"
                className="split-toggle-btn plugin-drawer-split-btn"
                title={t('plugins.drawer.openSplitTitle')}
                onClick={() =>
                  actions.openTarget(
                    {
                      kind: 'screen',
                      pluginId: primaryScreen.pluginId,
                      screenId: primaryScreen.screenId,
                    },
                    { split: true },
                  )
                }
              >
                {t('plugins.drawer.openSplit')}
              </Button>
            </>
          )}
          <Button
            variant={plugin.enabled ? 'secondary' : 'primary'}
            size="sm"
            icon={plugin.enabled ? 'square' : 'play'}
            disabled={toggling}
            onClick={() => onToggle(plugin, plugin.enabled ? false : true)}
          >
            {plugin.enabled
              ? t('plugins.drawer.disablePlugin')
              : t('plugins.drawer.enablePlugin')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  )
}
