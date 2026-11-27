/**
 * 插件配置表单的纯数据模型（无组件导出）：初始值、字段 id / 标题解析与可重置判定。
 */
import { resolveLocalizedText, type HelmxLocale, type PluginConfigFieldSchema, type PluginConfigFieldSource } from '@helmx/protocol/browser'
import type { PluginConfigResponse } from '../../lib/api.js'
import {
  canResetConfigField,
  configFieldInitialValue,
  type ConfigValue,
} from '../../modals/plugin-config-form-model.js'

/** 按 schema 推导表单初始值（secret 恒为空串，避免把掩码当真值回写）。 */
export function initialPluginConfigValues(config: PluginConfigResponse): Record<string, ConfigValue> {
  const init: Record<string, ConfigValue> = {}
  for (const [key, schema] of Object.entries(config.schema ?? {})) {
    init[key] = configFieldInitialValue(schema, config.values?.[key])
  }
  return init
}

export function pluginConfigFieldId(pluginId: string, key: string): string {
  return `helmx-plugin-config-${pluginId}-${key}`
}

/** 字段标题：LocalizedText label 按 locale 解析，缺省回落字段 key。 */
export function resolveConfigFieldTitle(schema: PluginConfigFieldSchema, key: string, locale: HelmxLocale): string {
  return schema.label !== undefined ? resolveLocalizedText(schema.label, locale) || key : key
}

/**
 * 字段是否可重置：必填且无 default 的字段无值可回退，禁止清除（后端同样会拒绝）；
 * 其余按 sources / 掩码回显判定（见 canResetConfigField）。
 */
export function canResetPluginConfigField(
  schema: PluginConfigFieldSchema,
  source: PluginConfigFieldSource | undefined,
  savedValue: unknown,
): boolean {
  const isRequiredWithoutDefault = schema.required === true && schema.default === undefined
  return !isRequiredWithoutDefault && canResetConfigField(schema, source, savedValue)
}

/** 文本输入 placeholder：按 locale 解析 description。 */
export function resolveConfigFieldDescription(schema: PluginConfigFieldSchema, locale: HelmxLocale): string | undefined {
  return schema.description !== undefined ? resolveLocalizedText(schema.description, locale) : undefined
}
