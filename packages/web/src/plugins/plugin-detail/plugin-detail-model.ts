/**
 * 插件详情抽屉的纯推导（无组件导出）：标题 / 版本徽章 / 设置面板 / Screen 快捷入口 / 受管技能。
 */
import {
  isPluginSummaryActive,
  resolveLocalizedText,
  type HelmxLocale,
  type PluginSummary,
  type SettingsPanelSpec,
  type SkillSummary,
} from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { GroupedUiSpecs, QualifiedUiSpec } from '../../lib/types.js'
import { listPluginScreens, type PluginScreenRef } from '../plugin-card-model.js'

export function pluginDrawerVersionLabel(plugin: PluginSummary | null): string | null {
  return plugin?.version ? `v${plugin.version.replace(/^v/, '')}` : null
}

/** 抽屉标题：本地化名称 → 插件 ID → 兜底文案。 */
export function pluginDrawerTitle(
  plugin: PluginSummary | null,
  locale: HelmxLocale,
  t: WebMessageTranslator,
): string {
  return (
    (plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') ||
    plugin?.id ||
    t('plugins.drawer.titleFallback')
  )
}

export function pluginDrawerSettingsPanels(
  groupedUi: GroupedUiSpecs | undefined,
  plugin: PluginSummary | null,
): Array<QualifiedUiSpec<SettingsPanelSpec>> {
  return groupedUi?.settingsPanels?.filter((p) => p.pluginId === plugin?.id) ?? []
}

/** 仅活跃运行态且有 Screen 贡献时提供快捷打开（主屏/右屏）；enabled=true 但 status=failed 不显示可用 Screen。 */
export function pluginDrawerScreens(
  plugin: PluginSummary | null,
  groupedUi: GroupedUiSpecs | undefined,
): PluginScreenRef[] {
  return plugin !== null && groupedUi !== undefined && isPluginSummaryActive(plugin)
    ? listPluginScreens(groupedUi, plugin.id)
    : []
}

/** 隶属于该插件的受管技能（排除用户 agents 目录与节点来源）。 */
export function pluginManagedSkills(skills: SkillSummary[] | undefined, pluginId: string): SkillSummary[] {
  return (skills ?? []).filter(
    (s) => s.source !== 'agents' && s.source !== 'node' && s.managedByPlugin === pluginId,
  )
}
