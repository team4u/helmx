import React from 'react'
import type { HelmxLocale, PluginConfigFieldSchema, PluginConfigFieldSource } from '@helmx/protocol/browser'
import { Badge, Button, Field, HelmxIcon } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { ConfigValue } from '../../modals/plugin-config-form-model.js'
import { PluginConfigFieldControl } from './PluginConfigFieldControl.js'
import {
  canResetPluginConfigField,
  pluginConfigFieldId,
  resolveConfigFieldTitle,
} from './plugin-config-form-model.js'

export interface PluginConfigFieldRowProps {
  pluginId: string
  fieldKey: string
  schema: PluginConfigFieldSchema
  source: PluginConfigFieldSource | undefined
  savedValue: unknown
  value: ConfigValue | undefined
  locale: HelmxLocale
  t: WebMessageTranslator
  inline: boolean
  /** 保存进行中：锁定模型选择器与重置按钮。 */
  saving: boolean
  /** 任一字段重置进行中：锁定重置按钮。 */
  resetting: boolean
  onChange: (next: ConfigValue) => void
  /** 单字段重置：发送 `{ [key]: null }` 清除显式覆写（或已存密钥），回退 schema.default。 */
  onReset: () => void
}

/** 单个配置字段行：横向 Field（锁图标 + 标题 + 来源标识）、类型分派控件与重置按钮。 */
export function PluginConfigFieldRow({
  pluginId,
  fieldKey,
  schema,
  source,
  savedValue,
  value,
  locale,
  t,
  inline,
  saving,
  resetting,
  onChange,
  onReset,
}: PluginConfigFieldRowProps): React.JSX.Element {
  const fieldId = pluginConfigFieldId(pluginId, fieldKey)
  const isBoolean = schema.type === 'boolean'
  const canReset = canResetPluginConfigField(schema, source, savedValue)
  const fieldTitle = resolveConfigFieldTitle(schema, fieldKey, locale)

  return (
    <Field
      layout="horizontal"
      htmlFor={isBoolean ? false : fieldId}
      required={schema.required === true}
      className="plugin-config-row"
      label={
        <span className="plugin-config-field-label">
          {schema.secret === true && <HelmxIcon name="lock" size={11} />}
          <span className="plugin-config-field-name">{fieldTitle}</span>
          {source === 'configured' && (
            <Badge tone="neutral" className="plugin-config-source-tag" title={t('plugins.config.configuredTitle')}>
              {t('plugins.config.configured')}
            </Badge>
          )}
          {source === 'default' && (
            <span className="text-subtle plugin-config-source-tag" title={t('plugins.config.defaultTitle')}>
              {t('common.default')}
            </span>
          )}
        </span>
      }
    >
      <div className="plugin-config-field-value">
        <PluginConfigFieldControl
          fieldId={fieldId}
          fieldTitle={fieldTitle}
          schema={schema}
          value={value}
          savedValue={savedValue}
          locale={locale}
          t={t}
          inline={inline}
          disabled={saving}
          onChange={onChange}
        />
        {canReset && (
          <Button
            variant="ghost"
            size="xs"
            icon="rotate-ccw"
            disabled={saving || resetting}
            onClick={onReset}
            title={schema.secret ? t('plugins.config.clearSecretTitle') : t('plugins.config.resetDefaultTitle')}
          >
            {schema.secret ? t('plugins.config.clear') : t('plugins.config.reset')}
          </Button>
        )}
      </div>
    </Field>
  )
}
