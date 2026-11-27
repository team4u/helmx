import React, { useMemo } from 'react'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type PluginSummary, type SkillSummary } from '@helmx/protocol/browser'
import { Callout, Card, DetailDrawer, EmptyState, HelmxIcon, HelperText, LoadingState, MonoId, Stack } from '@helmx/ui'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalGroupedUi, useOptionalLocale, useOptionalStoreActions } from '../lib/store-context.js'
import { PluginConfigForm } from './plugin-detail/PluginConfigForm.js'
import { PluginCapabilitiesCard } from './plugin-detail/PluginCapabilitiesCard.js'
import { PluginFailureDiagnosticCallout, PluginInUseConfirmCallout } from './plugin-detail/PluginDiagnosticCallouts.js'
import { PluginDrawerActionBar } from './plugin-detail/PluginDrawerActionBar.js'
import { PluginDrawerDescription, PluginDrawerTitleBadges } from './plugin-detail/PluginDrawerHeaderMeta.js'
import { PluginPackageSection } from './plugin-detail/PluginPackageSection.js'
import { PluginRemoveConfirmDialog } from './plugin-detail/PluginRemoveConfirmDialog.js'
import { PluginSettingsPanelsCard } from './plugin-detail/PluginSettingsPanelsCard.js'
import {
  pluginDrawerScreens,
  pluginDrawerSettingsPanels,
  pluginDrawerTitle,
} from './plugin-detail/plugin-detail-model.js'
import { usePluginConfigLoader } from './plugin-detail/use-plugin-config-loader.js'
import { usePluginDrawerActions } from './plugin-detail/use-plugin-drawer-actions.js'

export { PluginConfigForm, type PluginConfigFormProps } from './plugin-detail/PluginConfigForm.js'

export interface PluginDetailDrawerProps {
  plugin: PluginSummary | null
  open: boolean
  onClose: () => void
  onToggleEnabled: (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => Promise<void>
  toggling: boolean
  /** 插件包更新/卸载成功后请求父级刷新插件列表。 */
  onPackageChanged?: () => void
  /** 卸载成功后请求父级关闭抽屉（列表已无该插件）。 */
  onRemoved?: () => void
  /** 外部（如插件中心全部更新或卡片快捷更新）正在更新，需同步锁定抽屉包操作。 */
  externalUpdating?: boolean
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
  /** Optional skills catalog for showing managed skills belonging to this plugin. */
  skills?: SkillSummary[]
  /** Optional handler to jump to a managed skill in Skills Center. */
  onOpenSkill?: (skillId: string) => void
}

/**
 * 全屏插件中心右侧深度配置抽屉 (PluginDetailDrawer)：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 顶部元信息：大图标、完整名称、插件唯一 ID、版本与常驻核心状态；
 * - 启停操作区：主启停按钮（带防重复提交与 409 在途任务冲突处理）；
 * - 能力清单透视：折叠/展开 Tools、Actions、Hooks 详细清单；
 * - 动态配置项表单：带并发代数守卫（configGeneration）；
 * - 扩展设置面板：集成 PluginUiView 挂载 settingsPanels；
 * - 各区块组件与操作 / 配置 Hook 见 ./plugin-detail/；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function PluginDetailDrawer({
  plugin,
  open,
  onClose,
  onToggleEnabled,
  toggling,
  onPackageChanged,
  onRemoved,
  externalUpdating = false,
  inline = false,
  skills,
  onOpenSkill,
}: PluginDetailDrawerProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const groupedUi = useOptionalGroupedUi()
  const actions = useOptionalStoreActions()
  // LocalizedText 显示元数据（插件名 / 配置字段 label / 设置面板 label）按
  // store 权威 locale 解析；保留无 Provider 的 SSR 渲染容忍（缺省英文桥接）。
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])

  const configLoader = usePluginConfigLoader(open, plugin?.id)
  const ops = usePluginDrawerActions({
    open,
    plugin,
    toggling,
    externalUpdating,
    actions,
    locale,
    t,
    onToggleEnabled,
    onPackageChanged,
    onRemoved,
  })

  const settingsPanels = pluginDrawerSettingsPanels(groupedUi, plugin)
  const pluginScreens = pluginDrawerScreens(plugin, groupedUi)
  const primaryScreen = pluginScreens[0] ?? null
  const pluginTitle = pluginDrawerTitle(plugin, locale, t)
  const { config, loading: loadingConfig, error: configError } = configLoader

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={onClose}
      title={pluginTitle}
      titleClassName="break-word"
      titleExtra={<PluginDrawerTitleBadges plugin={plugin} t={t} />}
      meta={plugin?.id ? <MonoId value={plugin.id} /> : undefined}
      metaClassName="text-subtle break-word"
      belowTitle={plugin ? <PluginDrawerDescription plugin={plugin} locale={locale} t={t} /> : undefined}
      aria-label={
        plugin
          ? t('plugins.drawer.ariaSelected', {
              name: resolveLocalizedText(plugin.name, locale) || plugin.id,
            })
          : t('plugins.drawer.titleFallback')
      }
      closeLabel={t('common.close')}
      aux={
        <PluginRemoveConfirmDialog
          plugin={plugin}
          open={ops.confirmRemoveOpen && Boolean(plugin?.managed)}
          packageOp={ops.packageOp}
          inline={inline}
          locale={locale}
          t={t}
          onOpenChange={(isOpen) => {
            if (!isOpen && ops.packageOp !== 'removing') ops.setConfirmRemoveOpen(false)
          }}
          onConfirm={() => void ops.handleRemovePackage()}
          onCancel={() => ops.setConfirmRemoveOpen(false)}
        />
      }
    >
      {!plugin ? (
        <EmptyState>{t('plugins.drawer.noSelection')}</EmptyState>
      ) : (
        <>
          <PluginDrawerActionBar
            plugin={plugin}
            toggling={toggling}
            actions={actions}
            pluginScreens={pluginScreens}
            primaryScreen={primaryScreen}
            onToggle={(target, targetEnabled) => void ops.handleToggle(target, targetEnabled)}
          />

          {ops.actionError && (
            <Callout tone="err">
              <span className="callout-text selectable" role="alert">{ops.actionError}</span>
            </Callout>
          )}

          {/* Managed plugin package: source metadata + update/uninstall (hidden for built-in or unmanaged plugins) */}
          {plugin.managed && (
            <PluginPackageSection
              managed={plugin.managed}
              packageOp={ops.packageOp}
              editingSource={ops.editingSource}
              sourceDraft={ops.sourceDraft}
              externalUpdating={externalUpdating}
              updateDoctorReport={ops.updateDoctorReport}
              onEditingChange={ops.setEditingSource}
              onSourceDraftChange={ops.setSourceDraft}
              onUpdate={() => void ops.handleUpdatePackage()}
              onRemoveRequest={() => ops.setConfirmRemoveOpen(true)}
            />
          )}

          {/* Failure diagnostics box: structured stage, error code and full message */}
          {plugin.error && <PluginFailureDiagnosticCallout error={plugin.error} />}

          {/* 409 plugin_in_use confirmation: informed forced disable */}
          {ops.inUseConfirm && ops.inUseConfirm.plugin.id === plugin.id && (
            <PluginInUseConfirmCallout
              confirm={ops.inUseConfirm}
              toggling={toggling}
              onCancel={() => ops.setInUseConfirm(null)}
              onForceDisable={() => void ops.handleForceDisable()}
            />
          )}

          <PluginCapabilitiesCard plugin={plugin} skills={skills} onOpenSkill={onOpenSkill} actions={actions} />

          {/* Dynamic configuration options */}
          <Card
            variant="subtle"
            title={
              <Stack direction="horizontal" gap="xs" align="center" inline>
                <HelmxIcon name="sliders" size={13} />
                <span>{t('plugins.drawer.configuration')}</span>
              </Stack>
            }
          >
            {loadingConfig ? (
              <LoadingState label={t('plugins.drawer.loadingConfig')} />
            ) : configError ? (
              <Callout tone="err">
                <span className="callout-text selectable" role="alert">{configError}</span>
              </Callout>
            ) : config && config.pluginId === plugin.id ? (
              <PluginConfigForm
                key={plugin.id}
                pluginId={plugin.id}
                pluginName={pluginTitle}
                config={config}
                locale={locale}
                inline={inline}
                onSaved={() => void configLoader.reload(plugin.id)}
              />
            ) : (
              <HelperText>{t('plugins.drawer.configUnavailable')}</HelperText>
            )}
          </Card>

          {/* Extension settings panels */}
          {settingsPanels.length > 0 && (
            <PluginSettingsPanelsCard pluginId={plugin.id} panels={settingsPanels} locale={locale} t={t} />
          )}
        </>
      )}
    </DetailDrawer>
  )
}
