import React from 'react'
import type { HelmxLocale, PluginSummary } from '@helmx/protocol/browser'
import { Badge } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { getPluginDescription } from '../plugin-card-model.js'
import { isPluginFailed } from '../plugin-center-model.js'
import { pluginDrawerVersionLabel } from './plugin-detail-model.js'

/** 抽屉标题右侧徽章：版本、常驻核心与依赖数。 */
export function PluginDrawerTitleBadges({
  plugin,
  t,
}: {
  plugin: PluginSummary | null
  t: WebMessageTranslator
}): React.JSX.Element {
  const versionLabel = pluginDrawerVersionLabel(plugin)
  return (
    <>
      {versionLabel && (
        <Badge tone="neutral" mono title={t('plugins.card.versionTitle', { version: versionLabel })}>
          {versionLabel}
        </Badge>
      )}
      {plugin?.locked && (
        <Badge tone="warn" icon="lock" title={t('plugins.card.lockedTitle')}>
          {t('plugins.resident')}
        </Badge>
      )}
      {plugin?.dependencies && plugin.dependencies.length > 0 && (
        <Badge
          tone="neutral"
          icon="network"
          title={t('plugins.drawer.dependenciesTitle', {
            deps: plugin.dependencies.join(t('plugins.desc.listSeparator')),
          })}
        >
          {t('plugins.drawer.dependenciesCount', { count: plugin.dependencies.length })}
        </Badge>
      )}
    </>
  )
}

/** 标题下方的插件描述与加载失败提示（仅有错误时渲染失败说明）。 */
export function PluginDrawerDescription({
  plugin,
  locale,
  t,
}: {
  plugin: PluginSummary
  locale: HelmxLocale
  t: WebMessageTranslator
}): React.JSX.Element {
  return (
    <>
      <div className="plugin-drawer-desc">{getPluginDescription(plugin, locale, t)}</div>
      {isPluginFailed(plugin) && plugin.error && (
        <div className="plugin-drawer-failed-note" role="note">
          <Badge tone="err">{t('plugins.drawer.failedToLoad')}</Badge>
          <span className="mono selectable">
            {t('plugins.drawer.failedNoteDetail', {
              code: plugin.error.code,
              message: plugin.error.message,
              stage: plugin.error.stage,
            })}
          </span>
        </div>
      )}
    </>
  )
}
