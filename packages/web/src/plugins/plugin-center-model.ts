/**
 * 插件中心纯函数模型与检索过滤
 *
 * 提供多维检索（名称/ID/工具/动作）、状态筛选及指标统计。
 * 遵循前端规范：纯属性驱动，零 ID 硬编码猜测。
 */
import type { HelmxLocale, PluginSummary } from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { isPluginSummaryActive } from '../lib/live-state.js'
import type { GroupedUiSpecs } from '../lib/types.js'
import { pluginHasOpenableScreen } from './plugin-card-model.js'

export type PluginStatusFilter = 'all' | 'views' | 'enabled' | 'disabled'

/** Localized status filter tab label (reuses common.all / plugins.center.tabViews / common.enabled / common.disabled). */
export function pluginStatusTabLabel(
  status: PluginStatusFilter,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  switch (status) {
    case 'all':
      return t('common.all')
    case 'views':
      return t('plugins.center.tabViews')
    case 'enabled':
      return t('common.enabled')
    case 'disabled':
      return t('common.disabled')
  }
}

export interface PluginFilterState {
  query?: string
  status?: PluginStatusFilter
}

export interface PluginSummaryStats {
  total: number
  withViews: number
  enabled: number
  disabled: number
  failed: number
  totalTools: number
  totalActions: number
}

/**
 * 判定插件是否处于故障态：
 * - status === 'failed'（宿主显式标记加载或启用失败）；
 * - 或携带结构化诊断错误（error !== undefined，兼容旧内核未填 status 的降级诊断）。
 */
export function isPluginFailed(plugin: PluginSummary): boolean {
  return plugin.status === 'failed' || plugin.error !== undefined
}

/**
 * 按多维条件过滤插件列表（纯函数，返回新数组，不修改原数组）。
 * 名称匹配消费按当前 locale 解析后的显示名（display copy），机器 ID 与
 * tools/actions 契约名保持原样匹配；'views' 筛选仅保留活跃且至少声明一个 ctx.ui.screen 的插件。
 */
export function filterPlugins(
  plugins: PluginSummary[],
  filter: PluginFilterState,
  locale: HelmxLocale,
  groupedUi?: Pick<GroupedUiSpecs, 'screens'>,
): PluginSummary[] {
  if (!Array.isArray(plugins)) return []
  const query = filter.query?.trim().toLowerCase() ?? ''
  const status = filter.status ?? 'all'

  return plugins.filter((plugin) => {
    // 1. 状态/视图筛选（与 live-state 统一活跃谓词对齐：enabled=true 但 status=failed 不计入已启用/活跃）
    const active = isPluginSummaryActive(plugin)
    if (status === 'views' && (groupedUi === undefined || !pluginHasOpenableScreen(groupedUi, plugin))) {
      return false
    }
    if (status === 'enabled' && !active) return false
    if (status === 'disabled' && active) return false

    // 2. 关键字搜索匹配（name / id / tools / actions）
    if (query) {
      const matchName = resolveLocalizedText(plugin.name, locale).toLowerCase().includes(query)
      const matchId = (plugin.id ?? '').toLowerCase().includes(query)
      const matchTools = (plugin.tools ?? []).some((tool) => (tool ?? '').toLowerCase().includes(query))
      const matchActions = (plugin.actions ?? []).some((action) => (action ?? '').toLowerCase().includes(query))
      if (!matchName && !matchId && !matchTools && !matchActions) {
        return false
      }
    }

    return true
  })
}

/**
 * 汇总插件列表统计指标
 */
export function summarizePlugins(
  plugins: PluginSummary[],
  groupedUi?: Pick<GroupedUiSpecs, 'screens'>,
): PluginSummaryStats {
  if (!Array.isArray(plugins)) {
    return {
      total: 0,
      withViews: 0,
      enabled: 0,
      disabled: 0,
      failed: 0,
      totalTools: 0,
      totalActions: 0,
    }
  }

  let withViews = 0
  let enabled = 0
  let disabled = 0
  let failed = 0
  let totalTools = 0
  let totalActions = 0

  for (const plugin of plugins) {
    if (groupedUi !== undefined && pluginHasOpenableScreen(groupedUi, plugin)) {
      withViews++
    }
    if (isPluginSummaryActive(plugin)) {
      enabled++
    } else {
      disabled++
    }
    if (isPluginFailed(plugin)) failed++
    totalTools += plugin.tools?.length ?? 0
    totalActions += plugin.actions?.length ?? 0
  }

  return {
    total: plugins.length,
    withViews,
    enabled,
    disabled,
    failed,
    totalTools,
    totalActions,
  }
}
