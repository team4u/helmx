import React, { useMemo } from 'react'
import type { PluginSummary } from '@helmx/protocol/browser'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  HelmxIcon,
  IconButton,
  SelectCard,
  Stack,
  StatusLight,
  Switch,
} from '@helmx/ui'
import { createWebTranslator } from '../i18n/catalog.js'
import { isPluginSummaryActive } from '../lib/live-state.js'
import { useOptionalGroupedUi, useOptionalLocale, useOptionalStoreActions } from '../lib/store-context.js'
import {
  getPluginDescription,
  listPluginScreens,
} from './plugin-card-model.js'
import { isPluginFailed } from './plugin-center-model.js'

export interface PluginCardProps {
  plugin: PluginSummary
  selected: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => Promise<void> | void
  toggling?: boolean
  onUpdate?: () => Promise<void> | void
  updating?: boolean
  updateDisabled?: boolean
}

/**
 * 全屏插件中心单张插件卡片视图组件：
 * - 基于 SelectCard（<article> + <button aria-pressed> + 兄弟 footer/actions 槽位）；
 * - 顶部展示名称、ID（严格靠左对齐）、版本与常驻徽章，零图标杂音；
 * - 中部展示简要功能说明、能力计数徽章（Tools / Actions / Hooks）与故障摘要；
 * - 底部统一为单行 size="xs" 快捷操作按钮与启停开关；
 * - 全程零 Emoji，符合无障碍与键盘导航规范。
 */
export function PluginCard({
  plugin,
  selected,
  onSelect,
  onToggle,
  toggling = false,
  onUpdate,
  updating = false,
  updateDisabled = false,
}: PluginCardProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const groupedUi = useOptionalGroupedUi()
  const actions = useOptionalStoreActions()
  // 展示名 / 描述属 LocalizedText 显示元数据：按 store 的权威 locale 解析；
  // 组件保留无 Provider 的 SSR 渲染容忍（缺省英文桥接）。
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const name = resolveLocalizedText(plugin.name, locale) || plugin.id
  const description = getPluginDescription(plugin, locale, t)
  const isLocked = plugin.locked === true
  const active = isPluginSummaryActive(plugin)
  const failed = isPluginFailed(plugin)
  // 仅活跃运行态且有 Screen 贡献时提供快捷打开（enabled=true 但 status=failed 不显示可用 Screen）。
  const primaryScreen =
    groupedUi !== undefined && active
      ? listPluginScreens(groupedUi, plugin.id)[0] ?? null
      : null
  // 源码/清单加载阶段失败（scan/load）：模块未成功导入，无有效 definition 可重试启用
  const isLoadBroken = plugin.error?.stage === 'scan' || plugin.error?.stage === 'load'
  const isSwitchDisabled = isLocked || toggling || isLoadBroken

  // 启停开关反映持久化期望开关（plugin.enabled）：当 enabled=true 且 status=failed（如依赖被强停）时，
  // 仍允许点击开关停用插件以重置故障态；运行态样式与可用 Screen 则统一按 active 判定。
  const switchTitle = isLocked
    ? t('plugins.card.switchLockedTitle')
    : isLoadBroken
      ? t('plugins.card.switchLoadBrokenTitle')
      : plugin.enabled
        ? t('plugins.card.switchDisableTitle')
        : t('plugins.card.switchEnableTitle')

  const cardClasses = [
    'plugin-card',
    active ? 'is-enabled' : 'is-disabled',
    failed && 'is-failed',
  ]
    .filter(Boolean)
    .join(' ')

  const versionLabel = plugin.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const toolCount = plugin.tools?.length ?? 0
  const actionCount = plugin.actions?.length ?? 0
  const hookCount = plugin.hooks?.length ?? 0
  const hasCapabilityBadges = toolCount > 0 || actionCount > 0 || hookCount > 0
  const errorSummary = failed && plugin.error?.message ? plugin.error.message : null

  return (
    <SelectCard
      className={cardClasses}
      selected={selected}
      tone={failed ? 'danger' : 'default'}
      onSelect={onSelect}
      data-plugin-id={plugin.id}
      title={<span title={name}>{name}</span>}
      badges={
        <>
          {versionLabel && (
            <span className="plugin-card-version" title={t('plugins.card.versionTitle', { version: versionLabel })}>
              {versionLabel}
            </span>
          )}
          {isLocked && (
            <Badge tone="neutral" icon="lock" title={t('plugins.card.lockedTitle')}>
              {t('plugins.resident')}
            </Badge>
          )}
          {failed && (
            <StatusLight
              tone="failed"
              label={t('plugins.status.error')}
            />
          )}
        </>
      }
      subtitle={
        <span className="mono break-word" title={plugin.id}>
          {plugin.id}
        </span>
      }
      description={
        <span
          title={
            failed && plugin.error?.message
              ? `${description}\n${plugin.error.message}`
              : description
          }
        >
          {description}
        </span>
      }
      footer={
        <Stack direction="horizontal" gap="xs" align="center" className="plugin-card-actions">
          {plugin.managed !== undefined && onUpdate !== undefined && (
            <IconButton
              variant="secondary"
              size="xs"
              icon={<HelmxIcon name="refresh-cw" size={10} className={updating ? 'spin' : undefined} />}
              className="plugin-card-update-btn"
              disabled={updating || updateDisabled}
              title={updating ? t('plugins.package.updating') : t('plugins.card.updateTitle')}
              aria-label={t('plugins.card.updateAria', { name })}
              onClick={(e) => {
                e.stopPropagation()
                void onUpdate()
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
              }}
            />
          )}
          {primaryScreen !== null && actions !== null && (
            <>
              <Button
                size="xs"
                icon="play"
                className="plugin-card-open-btn"
                title={t('plugins.card.openViewTitle')}
                aria-label={t('plugins.card.openViewAria', { name })}
                onClick={(e) => {
                  e.stopPropagation()
                  actions.openTarget({
                    kind: 'screen',
                    pluginId: primaryScreen.pluginId,
                    screenId: primaryScreen.screenId,
                  })
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                }}
              >
                {t('plugins.openView')}
              </Button>
              <IconButton
                variant="secondary"
                size="xs"
                icon="columns"
                className="split-toggle-btn plugin-card-split-btn"
                title={t('plugins.card.openSplitTitle')}
                aria-label={t('plugins.card.openSplitAria', { name })}
                onClick={(e) => {
                  e.stopPropagation()
                  actions.openTarget(
                    {
                      kind: 'screen',
                      pluginId: primaryScreen.pluginId,
                      screenId: primaryScreen.screenId,
                    },
                    { split: true },
                  )
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                }}
              />
            </>
          )}
          <div
            className="plugin-card-switch-wrap"
            onClick={(e) => {
              e.stopPropagation()
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
            }}
          >
            <Switch
              checked={plugin.enabled}
              disabled={isSwitchDisabled}
              onChange={(checked) => {
                void onToggle(checked)
              }}
              aria-label={t('plugins.card.switchAria', { name })}
              title={switchTitle}
            />
          </div>
        </Stack>
      }
    >
      {hasCapabilityBadges || errorSummary !== null ? (
        <>
          {hasCapabilityBadges && (
            <Stack direction="horizontal" gap="xs" align="center" wrap>
              {toolCount > 0 && (
                <Badge tone="neutral" mono icon="wrench" title={t('plugins.card.toolsTitle', { count: toolCount })}>
                  {`${toolCount} Tools`}
                </Badge>
              )}
              {actionCount > 0 && (
                <Badge tone="neutral" mono icon="zap" title={t('plugins.card.actionsTitle', { count: actionCount })}>
                  {`${actionCount} Actions`}
                </Badge>
              )}
              {hookCount > 0 && (
                <Badge tone="neutral" mono icon="layers" title={t('plugins.card.hooksTitle', { count: hookCount })}>
                  {`${hookCount} Hooks`}
                </Badge>
              )}
            </Stack>
          )}
          {errorSummary !== null && (
            <div className="plugin-card-error-summary" title={errorSummary}>
              {errorSummary}
            </div>
          )}
        </>
      ) : null}
    </SelectCard>
  )
}
