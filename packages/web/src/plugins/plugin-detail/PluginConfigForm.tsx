import React, { useEffect, useMemo, useState } from 'react'
import type { HelmxLocale } from '@helmx/protocol/browser'
import { pluginsApi, type PluginConfigResponse } from '../../lib/api.js'
import { useOptionalStoreActions } from '../../lib/store-context.js'
import { createWebTranslator } from '../../i18n/catalog.js'
import { Button, Callout, HelperText, Stack } from '@helmx/ui'
import { buildPluginConfigPayload, buildResetFieldPayload, type ConfigValue } from '../../modals/plugin-config-form-model.js'
import { PluginConfigFieldRow } from './PluginConfigFieldRow.js'
import { initialPluginConfigValues, resolveConfigFieldTitle } from './plugin-config-form-model.js'

export interface PluginConfigFormProps {
  pluginId: string
  /** Optional display name used in saved notification toast; defaults to pluginId. */
  pluginName?: string
  config: PluginConfigResponse
  /** 配置字段 label/description（LocalizedText）的解析 locale。 */
  locale: HelmxLocale
  onSaved: () => void
  /** 内联渲染下拉菜单（便于测试与抽屉内断言）。 */
  inline?: boolean
}

/**
 * 按 schema 自动生成的插件配置受控表单：
 * - 遵守 secret 安全规范（空串保持已存凭据，已配置掩码防覆写）；
 * - 支持 boolean、number、string 各类受控渲染（单字段行见 PluginConfigFieldRow）。
 */
export function PluginConfigForm({
  pluginId,
  pluginName,
  config,
  locale,
  onSaved,
  inline = false,
}: PluginConfigFormProps): React.JSX.Element {
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const actions = useOptionalStoreActions()
  const entries = Object.entries(config.schema ?? {})
  const [values, setValues] = useState<Record<string, ConfigValue>>(() => initialPluginConfigValues(config))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resettingKey, setResettingKey] = useState<string | null>(null)

  useEffect(() => {
    setValues(initialPluginConfigValues(config))
  }, [config])

  if (entries.length === 0) {
    return <HelperText>{t('plugins.config.empty')}</HelperText>
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await pluginsApi.setConfig(pluginId, buildPluginConfigPayload(config.schema ?? {}, values))
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.config.savedNoticeTitle'),
        body: t('plugins.config.savedNoticeBody', { name: pluginName || pluginId }),
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // 单字段重置：发送 { [key]: null } 清除用户显式覆写值（或已存密钥），回退 schema.default。
  const resetField = async (key: string) => {
    setResettingKey(key)
    setError(null)
    const fieldSchema = config.schema?.[key]
    const fieldTitle = fieldSchema === undefined ? key : resolveConfigFieldTitle(fieldSchema, key, locale)
    try {
      await pluginsApi.setConfig(pluginId, buildResetFieldPayload(key))
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t(fieldSchema?.secret ? 'plugins.config.clearedNoticeTitle' : 'plugins.config.resetNoticeTitle'),
        body: t(fieldSchema?.secret ? 'plugins.config.clearedNoticeBody' : 'plugins.config.resetNoticeBody', {
          field: fieldTitle,
        }),
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResettingKey(null)
    }
  }

  return (
    <Stack direction="vertical" gap="sm">
      <Stack direction="vertical" gap="sm" className="config-fields">
        {entries.map(([key, schema]) => (
          <PluginConfigFieldRow
            key={key}
            pluginId={pluginId}
            fieldKey={key}
            schema={schema}
            source={config.sources?.[key]}
            savedValue={config.values?.[key]}
            value={values[key]}
            locale={locale}
            t={t}
            inline={inline}
            saving={saving}
            resetting={resettingKey !== null}
            onChange={(next) => setValues((prev) => ({ ...prev, [key]: next }))}
            onReset={() => void resetField(key)}
          />
        ))}
      </Stack>
      {error && (
        <Callout tone="err">
          <span className="callout-text selectable" role="alert">{error}</span>
        </Callout>
      )}
      <div>
        <Button variant="primary" size="sm" icon="check" pending={saving} onClick={() => void save()}>
          {t('plugins.config.save')}
        </Button>
      </div>
    </Stack>
  )
}
