import React, { useMemo } from 'react'
import { Card, Field, Input, ModelPickerControl, Select, Stack, Switch, useHostModels } from '@helmx/plugin-client'
import { resolveDefaultChainThinkingLevel } from '@helmx/plugin-client/pure'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useNodes } from '../../lib/store-context.js'
import { buildNodeSelectOptions } from '../../modals/nodes-modal-model.js'
import { useModelPickerControlAdapter } from '../../conversation/model-picker-adapter.js'
import type { ProfileFormState } from './profile-form-model.js'

export interface ProfileBasicFieldsCardProps {
  form: ProfileFormState
  isNew: boolean
  inline: boolean
  disabled: boolean
  /** 合并式更新：仅覆写给定字段。 */
  onChange: (patch: Partial<ProfileFormState>) => void
}

/** 基础字段：ID（新建可编辑）、名称、默认模型（共享模型选择器）、默认节点、工作目录与 cwd 护栏。 */
export function ProfileBasicFieldsCard({
  form,
  isNew,
  inline,
  disabled,
  onChange,
}: ProfileBasicFieldsCardProps): React.JSX.Element {
  const nodes = useNodes()
  const hostModels = useHostModels()
  const pickerAdapter = useModelPickerControlAdapter()
  const { t } = useWebLocale()

  // 默认节点下拉选项：未绑定项 + nodes 去重列表；既有值不在节点列表时补「未知节点」回退项
  const nodeOptions = useMemo(
    () =>
      buildNodeSelectOptions({
        nodes,
        selectedNodeId: form.nodeId,
        t,
        unboundLabel: t('profiles.drawer.unboundNode'),
        unknownNodeLabel: (id) => t('profiles.drawer.unknownNode', { id }),
      }),
    [nodes, form.nodeId, t],
  )

  return (
    <Card variant="subtle">
      <Stack direction="vertical" gap="md">
        <Field
          label={t('profiles.drawer.field.id')}
          htmlFor="profile-form-id"
          required={isNew}
          layout="horizontal"
        >
          {isNew ? (
            <Input
              mono
              placeholder={t('profiles.drawer.field.idPlaceholder')}
              value={form.id}
              onChange={(e) =>
                onChange({
                  id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                })
              }
            />
          ) : (
            <Input mono value={form.id} disabled readOnly />
          )}
        </Field>

        <Field
          label={t('profiles.drawer.field.name')}
          htmlFor="profile-form-name"
          layout="horizontal"
        >
          <Input
            placeholder={t('profiles.drawer.field.namePlaceholder')}
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>

        <Field
          label={t('profiles.drawer.field.defaultModel')}
          htmlFor="profile-form-model"
          hint={t('profiles.drawer.modelHint')}
          layout="horizontal"
        >
          {/* 共享模型选择器（与 Composer/全局默认同一实现）：行内思考档位
              chips 一并提交 model+level；点击行体仅应用模型，档位回落
              跟随默认链（保存时省略 thinkingLevel 键）。触发按钮显示该绑定
              实际运行的等级：档位预设 > 按模型默认 > Profile 等级（与内核同序）。 */}
          <ModelPickerControl
            buttonId="profile-form-model"
            buttonAriaLabel={t('profiles.drawer.field.defaultModel')}
            buttonTitle={form.model || t('profiles.modelOption.followSystemDefault')}
            placeholderLabel={t('profiles.modelOption.followSystemDefault')}
            effectiveModel={form.model}
            activeThinkingLevel={resolveDefaultChainThinkingLevel(hostModels, form.model, form.thinkingLevel)}
            resetLabel={t('profiles.modelOption.followSystemDefault')}
            resetTitle={t('profiles.modelOption.followSystemDefault')}
            popoverSide={inline ? 'bottom' : 'top'}
            enableShortcut={false}
            allowOrchestratorTiers={true}
            disabled={disabled}
            {...pickerAdapter}
            onApply={(model, level) =>
              onChange({ model, thinkingLevel: level ?? '' })
            }
            onResetDefault={() =>
              onChange({ model: '', thinkingLevel: '' })
            }
          />
        </Field>

        <Field
          label={t('profiles.drawer.field.defaultNode')}
          htmlFor="profile-form-node"
          layout="horizontal"
        >
          <Select
            value={form.nodeId}
            options={nodeOptions}
            popoverClassName="helmx-select-popover-wide"
            className="w-full mono"
            inline={inline}
            placeholder={t('profiles.drawer.unboundNode')}
            onChange={(e) => onChange({ nodeId: e.target.value })}
          />
        </Field>

        <Field
          label={t('profiles.drawer.field.cwd')}
          htmlFor="profile-form-cwd"
          layout="horizontal"
        >
          <Input
            mono
            placeholder={t('profiles.drawer.field.cwdPlaceholder')}
            value={form.cwd}
            onChange={(e) => onChange({ cwd: e.target.value })}
          />
        </Field>

        <Field
          label={t('profiles.drawer.field.restrictToCwd')}
          htmlFor="profile-form-restrict-cwd"
          hint={t('profiles.drawer.field.restrictToCwdHint')}
          layout="horizontal"
        >
          <Switch
            checked={form.restrictToCwd}
            onChange={(val) => onChange({ restrictToCwd: val })}
          />
        </Field>
      </Stack>
    </Card>
  )
}
