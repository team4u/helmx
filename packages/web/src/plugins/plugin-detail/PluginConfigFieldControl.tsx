import React, { useMemo } from 'react'
import type { HelmxLocale, PluginConfigFieldSchema } from '@helmx/protocol/browser'
import {
  Input,
  ModelPickerControl,
  MultiSelect,
  Select,
  Switch,
  Textarea,
} from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { useOptionalNodes, useOptionalProfiles } from '../../lib/store-context.js'
import { buildModelPickerControlCopy, useModelPickerControlAdapter } from '../../conversation/model-picker-adapter.js'
import {
  buildEnumConfigOptions,
  buildNodeConfigOptions,
  buildProfileConfigOptions,
  formatStringArrayInput,
  secretConfigured,
  type ConfigValue,
} from '../../modals/plugin-config-form-model.js'
import { resolveConfigFieldDescription } from './plugin-config-form-model.js'

export interface PluginConfigFieldControlProps {
  fieldId: string
  fieldTitle: string
  schema: PluginConfigFieldSchema
  value: ConfigValue | undefined
  /** 服务端已存值（secret 字段用于判断是否已配置，仅决定 placeholder）。 */
  savedValue: unknown
  locale: HelmxLocale
  t: WebMessageTranslator
  /** 内联渲染下拉菜单（便于测试与抽屉内断言）。 */
  inline: boolean
  /** 保存进行中：锁定模型选择器。 */
  disabled: boolean
  onChange: (next: ConfigValue) => void
}

/** 按 schema 类型 / format 分派的单字段受控控件（DOM 与类名与拆分前一致）。 */
export function PluginConfigFieldControl({
  fieldId,
  fieldTitle,
  schema,
  value,
  savedValue,
  locale,
  t,
  inline,
  disabled,
  onChange,
}: PluginConfigFieldControlProps): React.JSX.Element {
  const nodes = useOptionalNodes() ?? []
  const profiles = useOptionalProfiles() ?? []
  const { onNotice } = useModelPickerControlAdapter()
  const pickerCopy = useMemo(() => buildModelPickerControlCopy(t), [t])
  const description = resolveConfigFieldDescription(schema, locale)

  if (schema.type === 'boolean') {
    return (
      <Switch
        id={fieldId}
        checked={value === true}
        onChange={(checked) => onChange(checked)}
        label={value === true ? t('plugins.config.switchOn') : t('plugins.config.switchOff')}
      />
    )
  }
  if (schema.type === 'string[]' && schema.enum !== undefined) {
    const selected = Array.isArray(value) ? value : []
    return (
      <MultiSelect
        inline={inline}
        popoverClassName="helmx-select-popover-wide"
        aria-label={fieldTitle}
        value={selected}
        options={buildEnumConfigOptions(schema.enum, selected, t)}
        onValuesChange={(next) => onChange(next)}
      />
    )
  }
  if (schema.type === 'string[]') {
    return (
      <Textarea
        rows={3}
        placeholder={description}
        value={formatStringArrayInput(value)}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? [] : raw.split(/\r?\n/))
        }}
      />
    )
  }
  if (schema.enum !== undefined) {
    return (
      <Select
        inline={inline}
        popoverClassName="helmx-select-popover-wide"
        aria-label={fieldTitle}
        value={String(value ?? '')}
        options={buildEnumConfigOptions(
          schema.enum,
          typeof value === 'string' || typeof value === 'number' ? [value] : [],
          t,
        )}
        onChange={(event) => onChange(schema.type === 'number' ? Number(event.target.value) : event.target.value)}
      />
    )
  }
  if (schema.type === 'number') {
    return (
      <Input
        type="number"
        min={schema.minimum}
        max={schema.maximum}
        step={schema.integer === true ? 1 : 'any'}
        value={String(value ?? '')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    )
  }
  if (schema.format === 'model') {
    return (
      <ModelPickerControl
        variant="field"
        buttonId={fieldId}
        buttonAriaLabel={fieldTitle}
        buttonTitle={String(value ?? '') || t('plugins.config.modelUnset')}
        placeholderLabel={t('plugins.config.modelUnset')}
        effectiveModel={String(value ?? '') || undefined}
        activeThinkingLevel=""
        resetLabel={t('plugins.config.modelUnset')}
        resetTitle={t('plugins.config.resetDefaultTitle')}
        enableShortcut={false}
        showThinkingLevels={false}
        disabled={disabled}
        copy={pickerCopy}
        onNotice={onNotice}
        onApply={(id) => onChange(id)}
        onResetDefault={() => onChange('')}
      />
    )
  }
  if (schema.format === 'node' || schema.format === 'profile') {
    return (
      <Select
        inline={inline}
        popoverClassName="helmx-select-popover-wide"
        aria-label={fieldTitle}
        value={String(value ?? '')}
        options={
          schema.format === 'node'
            ? buildNodeConfigOptions(nodes, String(value ?? ''), t)
            : buildProfileConfigOptions(profiles, String(value ?? ''), t)
        }
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <Input
      mono={schema.secret === true}
      type={schema.secret ? 'password' : 'text'}
      placeholder={
        schema.secret
          ? secretConfigured(savedValue)
            ? t('plugins.config.secretConfiguredPlaceholder')
            : (description ?? '') || t('plugins.config.secretUnconfiguredPlaceholder')
          : description
      }
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
