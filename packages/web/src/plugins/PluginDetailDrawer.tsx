import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  extractPluginUsages,
  getPluginDescription,
  pluginErrorStageLabel,
  type PluginUsageItem,
} from './plugin-card-model.js'
import type { HelmxLocale, PluginDoctorReport, PluginSummary, SkillSummary } from '@helmx/protocol/browser'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText } from '@helmx/protocol/browser'
import { ApiClientError, pluginsApi, type PluginConfigResponse } from '../lib/api.js'
import { isPluginSummaryActive } from '../lib/live-state.js'
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  Field,
  HelperText,
  HelmxIcon,
  Input,
  LoadingState,
  ModelPickerControl,
  MonoId,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Textarea,
} from '@helmx/plugin-client'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalGroupedUi, useOptionalLocale, useOptionalNodes, useOptionalProfiles, useOptionalStoreActions } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { buildModelPickerControlCopy, useModelPickerControlAdapter } from '../conversation/model-picker-adapter.js'
import {
  detectPluginSourceKind,
  extractDoctorReport,
  formatInstalledAt,
  formatUpdateResultDetail,
  isInstallSourceSubmittable,
  pluginPackageErrorText,
  pluginSourceBadgeLabel,
  pluginSourceDisplayText,
} from './plugin-package-model.js'
import { PluginDoctorChecks } from './PluginDoctorChecks.js'
import {
  buildEnumConfigOptions,
  buildNodeConfigOptions,
  buildPluginConfigPayload,
  buildProfileConfigOptions,
  buildResetFieldPayload,
  canResetConfigField,
  configFieldInitialValue,
  formatStringArrayInput,
  secretConfigured,
  type ConfigValue,
} from '../modals/plugin-config-form-model.js'
import { listPluginScreens } from './plugin-card-model.js'
import { isPluginFailed } from './plugin-center-model.js'

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
 * 表单字段初始值推导纯函数
 */
function initialFormValues(config: PluginConfigResponse): Record<string, ConfigValue> {
  const init: Record<string, ConfigValue> = {}
  for (const [key, schema] of Object.entries(config.schema ?? {})) {
    init[key] = configFieldInitialValue(schema, config.values?.[key])
  }
  return init
}

/**
 * 按 schema 自动生成的插件配置受控表单：
 * - 遵守 secret 安全规范（空串保持已存凭据，已配置掩码防覆写）；
 * - 支持 boolean、number、string 各类受控渲染。
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
  const nodes = useOptionalNodes() ?? []
  const profiles = useOptionalProfiles() ?? []
  const entries = Object.entries(config.schema ?? {})
  const { onNotice } = useModelPickerControlAdapter()
  const pickerCopy = useMemo(() => buildModelPickerControlCopy(t), [t])
  const [values, setValues] = useState<Record<string, ConfigValue>>(() => initialFormValues(config))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resettingKey, setResettingKey] = useState<string | null>(null)

  useEffect(() => {
    setValues(initialFormValues(config))
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
    const fieldTitle =
      fieldSchema?.label !== undefined ? resolveLocalizedText(fieldSchema.label, locale) || key : key
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
        {entries.map(([key, schema]) => {
          const fieldId = `helmx-plugin-config-${pluginId}-${key}`
          const source = config.sources?.[key]
          // 必填且无 default 的字段无值可回退，禁止清除（后端同样会拒绝）。
          const isRequiredWithoutDefault = schema.required === true && schema.default === undefined
          const canReset =
            !isRequiredWithoutDefault && canResetConfigField(schema, source, config.values?.[key])
          const isBoolean = schema.type === 'boolean'
          const fieldTitle =
            schema.label !== undefined ? resolveLocalizedText(schema.label, locale) || key : key
          return (
            <Field
              key={key}
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
                {isBoolean ? (
                  <Switch
                    id={fieldId}
                    checked={values[key] === true}
                    onChange={(checked) => setValues((prev) => ({ ...prev, [key]: checked }))}
                    label={values[key] === true ? t('plugins.config.switchOn') : t('plugins.config.switchOff')}
                  />
                ) : schema.type === 'string[]' && schema.enum !== undefined ? (
                  <MultiSelect
                    inline={inline}
                    popoverClassName="helmx-select-popover-wide"
                    aria-label={fieldTitle}
                    value={Array.isArray(values[key]) ? values[key] : []}
                    options={buildEnumConfigOptions(
                      schema.enum,
                      Array.isArray(values[key]) ? values[key] : [],
                      t,
                    )}
                    onValuesChange={(next) => setValues((prev) => ({ ...prev, [key]: next }))}
                  />
                ) : schema.type === 'string[]' ? (
                  <Textarea
                    rows={3}
                    placeholder={
                      schema.description !== undefined
                        ? resolveLocalizedText(schema.description, locale)
                        : undefined
                    }
                    value={formatStringArrayInput(values[key])}
                    onChange={(e) => {
                      const raw = e.target.value
                      setValues((prev) => ({ ...prev, [key]: raw === '' ? [] : raw.split(/\r?\n/) }))
                    }}
                  />
                ) : schema.enum !== undefined ? (
                  <Select
                    inline={inline}
                    popoverClassName="helmx-select-popover-wide"
                    aria-label={fieldTitle}
                    value={String(values[key] ?? '')}
                    options={buildEnumConfigOptions(
                      schema.enum,
                      typeof values[key] === 'string' || typeof values[key] === 'number' ? [values[key]] : [],
                      t,
                    )}
                    onChange={(event) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: schema.type === 'number' ? Number(event.target.value) : event.target.value,
                      }))
                    }
                  />
                ) : schema.type === 'number' ? (
                  <Input
                    type="number"
                    min={schema.minimum}
                    max={schema.maximum}
                    step={schema.integer === true ? 1 : 'any'}
                    value={String(values[key] ?? '')}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                    onInput={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: Number((e.target as HTMLInputElement).value),
                      }))
                    }
                  />
                ) : schema.format === 'model' ? (
                  <ModelPickerControl
                    buttonId={fieldId}
                    buttonAriaLabel={fieldTitle}
                    buttonTitle={String(values[key] ?? '') || t('plugins.config.modelUnset')}
                    placeholderLabel={t('plugins.config.modelUnset')}
                    effectiveModel={String(values[key] ?? '') || undefined}
                    activeThinkingLevel=""
                    resetLabel={t('plugins.config.modelUnset')}
                    resetTitle={t('plugins.config.resetDefaultTitle')}
                    popoverSide={inline ? 'bottom' : 'top'}
                    enableShortcut={false}
                    showThinkingLevels={false}
                    disabled={saving}
                    copy={pickerCopy}
                    onNotice={onNotice}
                    onApply={(id) => setValues((prev) => ({ ...prev, [key]: id }))}
                    onResetDefault={() => setValues((prev) => ({ ...prev, [key]: '' }))}
                  />
                ) : schema.format === 'node' || schema.format === 'profile' ? (
                  <Select
                    inline={inline}
                    popoverClassName="helmx-select-popover-wide"
                    aria-label={fieldTitle}
                    value={String(values[key] ?? '')}
                    options={
                      schema.format === 'node'
                        ? buildNodeConfigOptions(nodes, String(values[key] ?? ''), t)
                        : buildProfileConfigOptions(profiles, String(values[key] ?? ''), t)
                    }
                    onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                  />
                ) : (
                  <Input
                    mono={schema.secret === true}
                    type={schema.secret ? 'password' : 'text'}
                    placeholder={
                      schema.secret
                        ? secretConfigured(config.values?.[key])
                          ? t('plugins.config.secretConfiguredPlaceholder')
                          : (schema.description !== undefined
                              ? resolveLocalizedText(schema.description, locale)
                              : '') || t('plugins.config.secretUnconfiguredPlaceholder')
                        : schema.description !== undefined
                          ? resolveLocalizedText(schema.description, locale)
                          : undefined
                    }
                    value={String(values[key] ?? '')}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    onInput={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: (e.target as HTMLInputElement).value,
                      }))
                    }
                  />
                )}
                {canReset && (
                  <Button
                    variant="ghost"
                    size="xs"
                    icon="rotate-ccw"
                    disabled={saving || resettingKey !== null}
                    onClick={() => void resetField(key)}
                    title={schema.secret ? t('plugins.config.clearSecretTitle') : t('plugins.config.resetDefaultTitle')}
                  >
                    {schema.secret ? t('plugins.config.clear') : t('plugins.config.reset')}
                  </Button>
                )}
              </div>
            </Field>
          )
        })}
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

/**
 * 全屏插件中心右侧深度配置抽屉 (PluginDetailDrawer)：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 顶部元信息：大图标、完整名称、插件唯一 ID、版本与常驻核心状态；
 * - 启停操作区：主启停按钮（带防重复提交与 409 在途任务冲突处理）；
 * - 能力清单透视：折叠/展开 Tools、Actions、Hooks 详细清单；
 * - 动态配置项表单：带并发代数守卫（configGeneration）；
 * - 扩展设置面板：集成 PluginUiView 挂载 settingsPanels；
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
  const [config, setConfig] = useState<(PluginConfigResponse & { pluginId: string }) | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // 包管理互斥状态：idle | updating | removing（与启停 toggling 独立）
  const [packageOp, setPackageOp] = useState<'idle' | 'updating' | 'removing'>('idle')
  const [editingSource, setEditingSource] = useState(false)
  const [sourceDraft, setSourceDraft] = useState('')
  const [updateDoctorReport, setUpdateDoctorReport] = useState<PluginDoctorReport | null>(null)
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  // 409 plugin_in_use 占用确认：保存待确认的占用清单与目标插件
  const [inUseConfirm, setInUseConfirm] = useState<{ plugin: PluginSummary; usages: PluginUsageItem[] } | null>(null)

  // 代数并发保护：快速切换插件时迟到的旧响应不得写入新插件配置或状态
  const mountedRef = useRef(true)
  const configGeneration = useRef(0)
  const actionGeneration = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      configGeneration.current += 1
      actionGeneration.current += 1
    }
  }, [])

  const reloadConfig = async (id: string) => {
    const generation = ++configGeneration.current
    setLoadingConfig(true)
    setConfigError(null)
    try {
      const result = await pluginsApi.getConfig(id)
      if (!mountedRef.current || configGeneration.current !== generation) return
      setConfig({ ...result, pluginId: id })
    } catch (err) {
      if (!mountedRef.current || configGeneration.current !== generation) return
      setConfig(null)
      setConfigError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && configGeneration.current === generation) {
        setLoadingConfig(false)
      }
    }
  }

  useEffect(() => {
    configGeneration.current += 1
    actionGeneration.current += 1
    setConfig(null)
    setConfigError(null)
    setActionError(null)
    setPackageOp('idle')
    setEditingSource(false)
    setSourceDraft('')
    setUpdateDoctorReport(null)
    setConfirmRemoveOpen(false)
    setInUseConfirm(null)
    if (open && plugin?.id) {
      void reloadConfig(plugin.id)
    } else {
      setLoadingConfig(false)
    }
  }, [open, plugin?.id])

  const handleToggle = async (
    targetPlugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => {
    if (targetPlugin.locked || toggling) return
    const generation = ++actionGeneration.current
    setActionError(null)
    setInUseConfirm(null)
    try {
      await onToggleEnabled(targetPlugin, targetEnabled, options)
    } catch (err) {
      if (!mountedRef.current || actionGeneration.current !== generation) return
      if (err instanceof ApiClientError && err.status === 409 && err.code === 'plugin_in_use') {
        // 持久资源占用：展示占用清单供用户知情后选择强制停用（固定原始 targetPlugin）
        const usages = extractPluginUsages(err.details)
        if (usages.length > 0) {
          setInUseConfirm({ plugin: targetPlugin, usages })
        } else {
          setActionError(t('plugins.drawer.disableInUseError'))
        }
      } else if (err instanceof ApiClientError && err.status === 409) {
        setActionError(t('plugins.drawer.disableLiveTasksError', { code: err.code }))
      } else {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  // 受管插件包：重新拉取安装来源最新版本并重载（源未变化时 changed=false，如实回显）；展开换源时携带新来源。
  const handleUpdatePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle' || externalUpdating) return
    const nextSource = editingSource ? sourceDraft.trim() : undefined
    if (editingSource && (nextSource === undefined || !isInstallSourceSubmittable(nextSource))) return
    const targetPlugin = plugin
    const generation = ++actionGeneration.current
    setPackageOp('updating')
    setActionError(null)
    setUpdateDoctorReport(null)
    try {
      const result =
        nextSource !== undefined
          ? await pluginsApi.update(targetPlugin.id, { source: nextSource })
          : await pluginsApi.update(targetPlugin.id)
      const noticeBody = formatUpdateResultDetail(result, t)
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.updateNoticeTitle'),
        body: t('plugins.package.updateNoticeBody', {
          name: resolveLocalizedText(targetPlugin.name, locale) || targetPlugin.id,
          detail: noticeBody,
        }),
      })
      if (mountedRef.current && actionGeneration.current === generation) {
        setEditingSource(false)
        setSourceDraft('')
      }
      onPackageChanged?.()
    } catch (err) {
      if (mountedRef.current && actionGeneration.current === generation) {
        setActionError(pluginPackageErrorText(err, t('plugins.package.action.update'), t))
        setUpdateDoctorReport(extractDoctorReport(err))
      }
    } finally {
      if (mountedRef.current && actionGeneration.current === generation) {
        setPackageOp('idle')
      }
    }
  }

  // 受管插件包卸载：确认后清理安装目录与注册记录；成功后关闭抽屉并刷新列表。
  const handleRemovePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle') return
    const targetPlugin = plugin
    const generation = ++actionGeneration.current
    setPackageOp('removing')
    setActionError(null)
    try {
      await pluginsApi.remove(targetPlugin.id)
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.removeNoticeTitle'),
        body: t('plugins.package.removeNoticeBody', {
          name: resolveLocalizedText(targetPlugin.name, locale) || targetPlugin.id,
          id: targetPlugin.id,
        }),
      })
      if (mountedRef.current && actionGeneration.current === generation) {
        setConfirmRemoveOpen(false)
        onRemoved?.()
      }
      onPackageChanged?.()
    } catch (err) {
      if (mountedRef.current && actionGeneration.current === generation) {
        setActionError(pluginPackageErrorText(err, t('plugins.package.action.uninstall'), t))
        setConfirmRemoveOpen(false)
      }
    } finally {
      if (mountedRef.current && actionGeneration.current === generation) {
        setPackageOp('idle')
      }
    }
  }

  const handleForceDisable = async () => {
    const pending = inUseConfirm
    if (!pending) return
    setInUseConfirm(null)
    await handleToggle(pending.plugin, false, { force: true })
  }

  const versionLabel = plugin?.version ? `v${plugin.version.replace(/^v/, '')}` : null
  const settingsPanels =
    groupedUi?.settingsPanels?.filter((p) => p.pluginId === plugin?.id) ?? []
  // 仅活跃运行态且有 Screen 贡献时提供快捷打开（主屏/右屏）；enabled=true 但 status=failed 不显示可用 Screen。
  const pluginScreens =
    plugin !== null && groupedUi !== undefined && isPluginSummaryActive(plugin)
      ? listPluginScreens(groupedUi, plugin.id)
      : []
  const primaryScreen = pluginScreens[0] ?? null

  const pluginTitle =
    (plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') ||
    plugin?.id ||
    t('plugins.drawer.titleFallback')

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={onClose}
      title={pluginTitle}
      titleClassName="break-word"
      titleExtra={
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
      }
      meta={plugin?.id ? <MonoId value={plugin.id} /> : undefined}
      metaClassName="text-subtle break-word"
      belowTitle={
        plugin ? (
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
        ) : undefined
      }
      aria-label={
        plugin
          ? t('plugins.drawer.ariaSelected', {
              name: resolveLocalizedText(plugin.name, locale) || plugin.id,
            })
          : t('plugins.drawer.titleFallback')
      }
      closeLabel={t('common.close')}
      aux={
        <ConfirmDialog
          open={confirmRemoveOpen && Boolean(plugin?.managed)}
          inline={inline}
          contentClassName="plugin-remove-confirm"
          onOpenChange={(isOpen) => {
            if (!isOpen && packageOp !== 'removing') setConfirmRemoveOpen(false)
          }}
          title={t('plugins.package.uninstallPlugin')}
          description={t('plugins.package.confirmUninstallBody', {
            name: (plugin !== null ? resolveLocalizedText(plugin.name, locale) : '') || plugin?.id || '',
            id: plugin?.id ?? '',
          })}
          confirmText={packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.confirmUninstall')}
          cancelText={t('common.cancel')}
          danger
          pending={packageOp === 'removing'}
          onConfirm={() => void handleRemovePackage()}
          onCancel={() => setConfirmRemoveOpen(false)}
        />
      }
    >
      {!plugin ? (
        <EmptyState>{t('plugins.drawer.noSelection')}</EmptyState>
      ) : (
        <>
          {/* Quick actions and enable/disable bar */}
          <Card variant="subtle" className="plugin-drawer-action-card">
            <Stack direction="horizontal" gap="md" align="center" justify="between" wrap>
              <Stack direction="horizontal" gap="sm" align="center" className="plugin-drawer-status-wrap">
                <span className="text-subtle">{t('plugins.drawer.currentStatus')}</span>
                {isPluginFailed(plugin) ? (
                  <Badge tone="err" icon="alert-circle" title={t('plugins.drawer.errorBadgeTitle')}>
                    {t('plugins.status.error')}
                  </Badge>
                ) : isPluginSummaryActive(plugin) ? (
                  <Badge tone="ok" icon="check">
                    {t('common.enabled')}
                  </Badge>
                ) : (
                  <Badge tone="neutral">{t('common.disabled')}</Badge>
                )}
              </Stack>
              <Stack direction="horizontal" gap="xs" align="center" justify="end" wrap className="plugin-drawer-screen-actions">
                {primaryScreen !== null && actions !== null && (
                  <>
                    <Button
                      size="sm"
                      icon="play"
                      title={
                        pluginScreens.length > 1
                          ? t('plugins.drawer.openMainViewMultiTitle', {
                              screenId: primaryScreen.screenId,
                              count: pluginScreens.length,
                            })
                          : t('plugins.drawer.openMainViewTitle')
                      }
                      onClick={() =>
                        actions.openTarget({
                          kind: 'screen',
                          pluginId: primaryScreen.pluginId,
                          screenId: primaryScreen.screenId,
                        })
                      }
                    >
                      {t('plugins.openView')}
                    </Button>
                    <Button
                      size="sm"
                      icon="columns"
                      className="split-toggle-btn plugin-drawer-split-btn"
                      title={t('plugins.drawer.openSplitTitle')}
                      onClick={() =>
                        actions.openTarget(
                          {
                            kind: 'screen',
                            pluginId: primaryScreen.pluginId,
                            screenId: primaryScreen.screenId,
                          },
                          { split: true },
                        )
                      }
                    >
                      {t('plugins.drawer.openSplit')}
                    </Button>
                  </>
                )}
                <Button
                  variant={plugin.enabled ? 'default' : 'primary'}
                  size="sm"
                  icon={plugin.enabled ? 'square' : 'play'}
                  disabled={plugin.locked || toggling}
                  onClick={() => void handleToggle(plugin, plugin.enabled ? false : true)}
                >
                  {plugin.enabled
                    ? t('plugins.drawer.disablePlugin')
                    : t('plugins.drawer.enablePlugin')}
                </Button>
              </Stack>
            </Stack>
          </Card>

          {actionError && (
            <Callout tone="err">
              <span className="callout-text selectable" role="alert">{actionError}</span>
            </Callout>
          )}

          {/* Managed plugin package: source metadata + update/uninstall (hidden for built-in or unmanaged plugins) */}
          {plugin?.managed && (
            <Card
              variant="subtle"
              className="plugin-package-section"
              title={
                <Stack direction="horizontal" gap="xs" align="center" inline>
                  <HelmxIcon name="boxes" size={13} />
                  <span>{t('plugins.package.sectionTitle')}</span>
                </Stack>
              }
            >
              <Stack direction="vertical" gap="sm" className="plugin-package-meta">
                <Field
                  label={t('plugins.package.sourceLabel')}
                  htmlFor={false}
                  layout="horizontal"
                >
                  <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-package-source-row">
                    <Badge tone="neutral" mono data-source-kind={plugin.managed.source.kind}>
                      {pluginSourceBadgeLabel(plugin.managed.source, t)}
                    </Badge>
                    <span className="mono selectable plugin-package-source-text">
                      {pluginSourceDisplayText(plugin.managed.source)}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={packageOp !== 'idle' || externalUpdating}
                      onClick={() => {
                        if (editingSource) {
                          setEditingSource(false)
                          setSourceDraft('')
                        } else {
                          setEditingSource(true)
                          setSourceDraft(plugin.managed!.source.raw)
                        }
                      }}
                    >
                      {editingSource ? t('common.cancel') : t('plugins.package.changeSource')}
                    </Button>
                  </Stack>
                  {editingSource && (() => {
                    const draftTrimmed = sourceDraft.trim()
                    const draftHint = detectPluginSourceKind(draftTrimmed, t)
                    const draftSubmittable = draftTrimmed !== '' && isInstallSourceSubmittable(draftTrimmed)
                    return (
                      <Stack direction="vertical" gap="xs" className="plugin-package-source-editor">
                        <Input
                          mono
                          type="text"
                          value={sourceDraft}
                          invalid={draftTrimmed !== '' && draftHint.kind === 'unknown'}
                          placeholder={t('plugins.package.newSourcePlaceholder')}
                          aria-label={t('plugins.package.changeSource')}
                          spellCheck={false}
                          autoComplete="off"
                          disabled={packageOp !== 'idle' || externalUpdating}
                          onChange={(e) => setSourceDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && draftSubmittable) {
                              e.preventDefault()
                              void handleUpdatePackage()
                            }
                          }}
                        />
                        {draftTrimmed !== '' && (
                          <span
                            className={`plugin-source-hint${draftHint.kind === 'unknown' ? ' is-unknown' : ''}`}
                            data-source-kind={draftHint.kind}
                          >
                            {draftHint.label}
                          </span>
                        )}
                      </Stack>
                    )
                  })()}
                </Field>
                {plugin.managed.installedVersion !== '' && (
                  <Field
                    label={t('plugins.package.installedVersionLabel')}
                    htmlFor={false}
                    layout="horizontal"
                  >
                    <span className="form-grid-value mono">{plugin.managed.installedVersion}</span>
                  </Field>
                )}
                {formatInstalledAt(plugin.managed.installedAt, locale) !== '' && (
                  <Field
                    label={t('plugins.package.installedAtLabel')}
                    htmlFor={false}
                    layout="horizontal"
                  >
                    <span className="form-grid-value">{formatInstalledAt(plugin.managed.installedAt, locale)}</span>
                  </Field>
                )}
              </Stack>
              <Stack direction="horizontal" gap="sm" align="center" wrap className="plugin-package-actions">
                <Button
                  size="sm"
                  icon={
                    <HelmxIcon
                      name="refresh-cw"
                      size={12}
                      className={packageOp === 'updating' || externalUpdating ? 'spin' : undefined}
                    />
                  }
                  disabled={
                    packageOp !== 'idle' ||
                    externalUpdating ||
                    (editingSource && !isInstallSourceSubmittable(sourceDraft))
                  }
                  onClick={() => void handleUpdatePackage()}
                >
                  {packageOp === 'updating' || externalUpdating
                    ? t('plugins.package.updating')
                    : t('plugins.package.updatePlugin')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  disabled={packageOp !== 'idle' || externalUpdating}
                  onClick={() => setConfirmRemoveOpen(true)}
                >
                  {packageOp === 'removing' ? t('plugins.package.uninstalling') : t('plugins.package.uninstallPlugin')}
                </Button>
              </Stack>
              {updateDoctorReport && <PluginDoctorChecks report={updateDoctorReport} />}
            </Card>
          )}

          {/* Failure diagnostics box: structured stage, error code and full message */}
          {plugin.error && (
            <Callout tone="err">
              <div className="plugin-diagnostic-body" role="alert">
                <div className="plugin-diagnostic-title">{t('plugins.drawer.diagnosticTitle')}</div>
                <div className="text-subtle">
                  {t('plugins.drawer.diagnosticMetaPrefix', {
                    stage: pluginErrorStageLabel(plugin.error.stage, t),
                  })}
                  <span className="mono">{plugin.error.code}</span>
                </div>
                <div className="selectable plugin-diagnostic-message">{plugin.error.message}</div>
              </div>
            </Callout>
          )}

          {/* 409 plugin_in_use confirmation: informed forced disable */}
          {inUseConfirm && inUseConfirm.plugin.id === plugin.id && (
            <Callout tone="warn">
              <div className="plugin-inuse-body" role="alert">
                <div className="plugin-diagnostic-title">{t('plugins.drawer.inUseTitle')}</div>
                <div className="text-subtle">{t('plugins.drawer.inUseHint')}</div>
                <ul className="plugin-inuse-list">
                  {inUseConfirm.usages.map((usage) => (
                    <li key={`${usage.kind}/${usage.id}`} title={`${usage.kind}/${usage.id}`}>
                      {usage.label}
                    </li>
                  ))}
                </ul>
                <Stack direction="horizontal" gap="sm" align="center" justify="end" className="plugin-inuse-actions">
                  <Button variant="ghost" size="sm" onClick={() => setInUseConfirm(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button variant="danger" size="sm" icon="square" disabled={toggling} onClick={() => void handleForceDisable()}>
                    {t('plugins.drawer.forceDisable')}
                  </Button>
                </Stack>
              </div>
            </Callout>
          )}

          {/* Capability inventory */}
          <Card
            variant="subtle"
            title={
              <Stack direction="horizontal" gap="xs" align="center" inline>
                <HelmxIcon name="boxes" size={13} />
                <span>{t('plugins.drawer.capabilities')}</span>
              </Stack>
            }
          >
            <div className="plugin-drawer-capabilities">
              {/* Tools */}
              <div className="plugin-capability-group">
                <div className="plugin-capability-group-header">
                  <HelmxIcon name="wrench" size={11} />
                  <span className="plugin-capability-group-title">
                    Tools ({plugin.tools.length})
                  </span>
                </div>
                {plugin.tools.length > 0 ? (
                  <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-capability-tags">
                    {plugin.tools.map((tool) => (
                      <Badge key={tool} tone="neutral" mono title={tool}>
                        {tool}
                      </Badge>
                    ))}
                  </Stack>
                ) : (
                  <HelperText>{t('plugins.drawer.noTools')}</HelperText>
                )}
              </div>

              {/* Actions */}
              <div className="plugin-capability-group">
                <div className="plugin-capability-group-header">
                  <HelmxIcon name="zap" size={11} />
                  <span className="plugin-capability-group-title">
                    Actions ({plugin.actions.length})
                  </span>
                </div>
                {plugin.actions.length > 0 ? (
                  <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-capability-tags">
                    {plugin.actions.map((act) => (
                      <Badge key={act} tone="neutral" mono title={act}>
                        {act}
                      </Badge>
                    ))}
                  </Stack>
                ) : (
                  <HelperText>{t('plugins.drawer.noActions')}</HelperText>
                )}
              </div>

              {/* Hooks */}
              <div className="plugin-capability-group">
                <div className="plugin-capability-group-header">
                  <HelmxIcon name="layers" size={11} />
                  <span className="plugin-capability-group-title">
                    Hooks ({plugin.hooks.length})
                  </span>
                </div>
                {plugin.hooks.length > 0 ? (
                  <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-capability-tags">
                    {plugin.hooks.map((hook) => (
                      <Badge key={hook} tone="neutral" mono title={hook}>
                        {hook}
                      </Badge>
                    ))}
                  </Stack>
                ) : (
                  <HelperText>{t('plugins.drawer.noHooks')}</HelperText>
                )}
              </div>

              {/* Managed skills (bidirectional navigation to Skills Center) */}
              {(() => {
                const managedSkills = (skills ?? []).filter(
                  (s) => s.source !== 'agents' && s.source !== 'node' && s.managedByPlugin === plugin.id,
                )
                if (managedSkills.length === 0) return null
                const handleOpenSkill = (skillId: string) => {
                  if (onOpenSkill) onOpenSkill(skillId)
                  else actions?.openTarget({ kind: 'skills', skillId })
                }
                return (
                  <div className="plugin-capability-group">
                    <div className="plugin-capability-group-header">
                      <HelmxIcon name="sparkles" size={11} />
                      <span className="plugin-capability-group-title">
                        {t('plugins.drawer.managedSkillsTitle', { count: managedSkills.length })}
                      </span>
                    </div>
                    <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-capability-tags">
                      {managedSkills.map((skill) => (
                        <Button
                          key={skill.id}
                          variant="default"
                          size="xs"
                          icon="arrow-up-right"
                          data-plugin-managed-skill={skill.id}
                          title={t('plugins.drawer.openSkillTitle', { id: skill.id })}
                          onClick={() => handleOpenSkill(skill.id)}
                        >
                          <span className="mono">{skill.id}</span>
                        </Button>
                      ))}
                    </Stack>
                  </div>
                )
              })()}
            </div>
          </Card>

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
                onSaved={() => void reloadConfig(plugin.id)}
              />
            ) : (
              <HelperText>{t('plugins.drawer.configUnavailable')}</HelperText>
            )}
          </Card>

          {/* Extension settings panels */}
          {settingsPanels.length > 0 && (
            <Card
              variant="subtle"
              title={
                <Stack direction="horizontal" gap="xs" align="center" inline>
                  <HelmxIcon name="layout" size={13} />
                  <span>
                    {settingsPanels.length > 1
                      ? t('plugins.drawer.settingsPanelsCount', { count: settingsPanels.length })
                      : resolveLocalizedText(settingsPanels[0]!.spec.label, locale) ||
                        t('plugins.drawer.settingsPanels')}
                  </span>
                </Stack>
              }
            >
              {settingsPanels.map((panel) => (
                <div
                  key={`${panel.pluginId}/${panel.spec.id}`}
                  className="plugin-settings-panels"
                >
                  {settingsPanels.length > 1 && (
                    <div className="plugin-settings-panel-title">
                      {resolveLocalizedText(panel.spec.label, locale) || panel.spec.id}
                    </div>
                  )}
                  <PluginUiView
                    pluginId={plugin.id}
                    spec={panel.spec}
                    label={t('plugins.drawer.settingsPanelLabel', { id: panel.spec.id })}
                  />
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </DetailDrawer>
  )
}
