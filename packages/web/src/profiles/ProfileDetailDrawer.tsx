import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  PROFILE_DETAIL_SECTION_SLOT,
  PROFILE_STARTERS_MAX_ITEMS,
  resolveLocalizedText,
  type ProfileRuntime,
} from '@helmx/protocol/browser'
import type { EnvPair, Profile, StarterDraft } from './profile-center-model.js'
import {
  argsTextToArgs,
  argsToText,
  buildProfileSavePayload,
  dedupeProfileRuntimeSpecs,
  envToPairs,
  isSystemProfile,
  normalizeRuntime,
  pairsToEnv,
  profileIdValid,
  profilesApi,
  resolveProfileModel,
  startersAtLimit,
  startersToDrafts,
  validateStarterDraft,
  validateStarterDrafts,
} from './profile-center-model.js'
import {
  Checkbox,
  ConfirmDialog,
  DetailDrawer,
  HelmxIcon,
  ModelPickerControl,
  PluginSlot,
  Select,
  type SelectOption,
  Switch,
} from '@helmx/plugin-client'
import { useNodes, useOptionalGroupedUi, useSkills } from '../lib/store-context.js'
import { summarizeSingleLine } from '../lib/format.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import { useModelPickerControlAdapter } from '../conversation/model-picker-adapter.js'

export interface ProfileDetailDrawerProps {
  profile: Profile | null
  isNew?: boolean
  open: boolean
  onClose: () => void
  inline?: boolean
  onSaved?: (saved: Profile) => void
  onDeleted?: (id: string) => void
}

interface FormState {
  id: string
  name: string
  description: string
  model: string
  thinkingLevel: string
  /** 绑定的默认计算节点 ID；空串 = 未绑定（回退本机 local）。 */
  nodeId: string
  cwd: string
  /** Profile.restrictToCwd 护栏：文件工具与子代理 cwd 限定在会话工作目录内。 */
  restrictToCwd: boolean
  system: string
  systemEdited: boolean
  useAllSkills: boolean
  selectedSkillIds: string[]
  starters: StarterDraft[]
  runtime: ProfileRuntime | undefined
  runtimeArgsText: string
  runtimeEnvPairs: EnvPair[]
  /** 保存时非表单字段（tags/managedByPlugin/humanSelectable）从最近详情快照透传。 */
  source: Profile | null
}

function createInitialForm(profile: Profile | null, isNew: boolean): FormState {
  if (isNew || !profile) {
    return {
      id: '',
      name: '',
      description: '',
      model: '',
      thinkingLevel: '',
      nodeId: '',
      cwd: '',
      restrictToCwd: false,
      system: '',
      systemEdited: false,
      useAllSkills: true,
      selectedSkillIds: [],
      starters: [],
      runtime: undefined,
      runtimeArgsText: '',
      runtimeEnvPairs: [],
      source: null,
    }
  }

  return {
    id: profile.id,
    name: profile.name ?? '',
    description: profile.description ?? '',
    model: resolveProfileModel(profile) ?? '',
    thinkingLevel: profile.thinkingLevel ?? '',
    nodeId: profile.nodeId ?? '',
    cwd: profile.cwd ?? '',
    restrictToCwd: profile.restrictToCwd === true,
    system: profile.system ?? '',
    systemEdited: false,
    useAllSkills: profile.skills === undefined,
    selectedSkillIds: Array.isArray(profile.skills) ? [...profile.skills] : [],
    starters: startersToDrafts(profile.starters),
    runtime: profile.runtime,
    runtimeArgsText: argsToText(profile.runtime?.args),
    runtimeEnvPairs: envToPairs(profile.runtime?.env),
    source: profile,
  }
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、默认节点、工作目录、外部运行时、系统提示词、插件扩展子插槽与技能白名单；
 * - 提供脏表单防护、新建校验与删除二次确认；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function ProfileDetailDrawer({
  profile,
  isNew = false,
  open,
  onClose,
  inline = false,
  onSaved,
  onDeleted,
}: ProfileDetailDrawerProps): React.JSX.Element {
  const nodes = useNodes()
  const skills = useSkills()
  const groupedUi = useOptionalGroupedUi()
  const pickerAdapter = useModelPickerControlAdapter()
  const { locale, t } = useWebLocale()
  const [form, setForm] = useState<FormState>(() => createInitialForm(profile, isNew))
  const [baseline, setBaseline] = useState<FormState>(() => createInitialForm(profile, isNew))
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const activeFetchIdRef = useRef<string | null>(null)

  // 当 Drawer 打开或传入的目标 profile / isNew 变化时重置表单态
  useEffect(() => {
    if (!open) {
      setError(null)
      setShowDeleteConfirm(false)
      setShowDiscardConfirm(false)
      activeFetchIdRef.current = null
      return
    }

    const initial = createInitialForm(profile, isNew)
    setForm(initial)
    setBaseline(initial)
    setError(null)

    // 若编辑已有角色，尝试拉取全文详情（含完整 SYSTEM.md；MEMORY.md 由
    // builtin:memory 插件子插槽自治拉取，不经宿主 Profile 表单）
    if (!isNew && profile?.id) {
      const targetId = profile.id
      activeFetchIdRef.current = targetId

      void profilesApi
        .get(targetId)
        .then((detail) => {
          if (activeFetchIdRef.current !== targetId) return
          setForm((prev) => {
            const next: FormState = {
              ...prev,
              name: detail.name ?? prev.name,
              description: detail.description ?? prev.description,
              model: resolveProfileModel(detail) ?? prev.model,
              thinkingLevel: detail.thinkingLevel ?? '',
              nodeId: detail.nodeId ?? prev.nodeId,
              cwd: detail.cwd ?? prev.cwd,
              restrictToCwd: detail.restrictToCwd === true,
              system: detail.system ?? prev.system,
              systemEdited: false,
              useAllSkills: detail.skills === undefined,
              selectedSkillIds: Array.isArray(detail.skills) ? [...detail.skills] : prev.selectedSkillIds,
              starters: startersToDrafts(detail.starters),
              runtime: detail.runtime,
              runtimeArgsText: argsToText(detail.runtime?.args),
              runtimeEnvPairs: envToPairs(detail.runtime?.env),
              source: detail,
            }
            setBaseline(next)
            return next
          })
        })
        .catch(() => {
          // 详情获取失败时静默维持基础信息
        })
    }
  }, [open, profile, isNew])

  const isSystem = Boolean(profile && isSystemProfile(profile))
  const canDelete = !isNew && !isSystem && Boolean(profile)

  const runtimeSpecs = useMemo(
    () => dedupeProfileRuntimeSpecs(groupedUi?.profileRuntimes ?? []),
    [groupedUi?.profileRuntimes],
  )
  const runtimeSpecsByKind = useMemo(
    () => new Map(runtimeSpecs.map((item) => [item.spec.kind, item] as const)),
    [runtimeSpecs],
  )
  const defaultRuntimeSpec = runtimeSpecs[0]
  const activeRuntimeSpec =
    form.runtime !== undefined ? runtimeSpecsByKind.get(form.runtime.kind) : undefined
  const canEditRuntime =
    runtimeSpecs.length > 0 && (form.runtime === undefined || activeRuntimeSpec !== undefined)

  // 计算脏表单状态
  const isDirty = useMemo(() => {
    const startersDirty = (a: StarterDraft[], b: StarterDraft[]): boolean =>
      a.length !== b.length || a.some((item, i) => item.label !== b[i]?.label || item.prompt !== b[i]?.prompt)
    if (isNew) {
      return (
        form.id.trim() !== '' ||
        form.name.trim() !== '' ||
        form.description.trim() !== '' ||
        form.model.trim() !== '' ||
        form.thinkingLevel !== '' ||
        form.nodeId.trim() !== '' ||
        form.cwd.trim() !== '' ||
        form.restrictToCwd ||
        form.system.trim() !== '' ||
        !form.useAllSkills ||
        form.selectedSkillIds.length > 0 ||
        form.starters.length > 0 ||
        form.runtime !== undefined
      )
    }

    if (form.id !== baseline.id) return true
    if (form.name !== baseline.name) return true
    if (form.description !== baseline.description) return true
    if (form.model !== baseline.model) return true
    if (form.thinkingLevel !== baseline.thinkingLevel) return true
    if (form.nodeId !== baseline.nodeId) return true
    if (form.cwd !== baseline.cwd) return true
    if (form.restrictToCwd !== baseline.restrictToCwd) return true
    if (form.systemEdited || form.system !== baseline.system) return true
    if (form.useAllSkills !== baseline.useAllSkills) return true
    if (startersDirty(form.starters, baseline.starters)) return true
    if (JSON.stringify(normalizeRuntime(form.runtime)) !== JSON.stringify(normalizeRuntime(baseline.runtime))) {
      return true
    }

    const sortedCurrent = [...form.selectedSkillIds].sort().join(',')
    const sortedBaseline = [...baseline.selectedSkillIds].sort().join(',')
    return sortedCurrent !== sortedBaseline
  }, [form, baseline, isNew])

  // 关闭请求处理：脏表单时弹出确认
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true)
    } else {
      onClose()
    }
  }

  // 默认节点下拉选项：未绑定项 + nodes 全量；既有值不在节点列表时补「未知节点」回退项
  const nodeOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: t('profiles.drawer.unboundNode'), icon: 'monitor' },
      ...nodes.map((n) => ({
        value: n.id,
        label: nodeOptionLabel(n, t),
        icon: n.id === 'local' || n.kind === 'local' ? 'monitor' : 'network',
        meta: n.kind === 'local' ? undefined : n.online ? t('common.online') : t('common.offline'),
      })),
    ]
    const current = form.nodeId.trim()
    if (current !== '' && !list.some((o) => o.value === current)) {
      list.push({ value: current, label: t('profiles.drawer.unknownNode', { id: current }), icon: 'alert-circle' })
    }
    return list
  }, [nodes, form.nodeId, t])

  const runtimeNodeOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = [
      { value: '', label: t('profiles.drawer.unboundNode'), icon: 'monitor' },
      ...nodes.map((n) => ({
        value: n.id,
        label: nodeOptionLabel(n, t),
        icon: n.id === 'local' || n.kind === 'local' ? 'monitor' : 'network',
        meta: n.kind === 'local' ? undefined : n.online ? t('common.online') : t('common.offline'),
      })),
    ]
    const current = form.runtime?.nodeId?.trim() ?? ''
    if (current !== '' && !list.some((o) => o.value === current)) {
      list.push({ value: current, label: t('profiles.drawer.unknownNode', { id: current }), icon: 'alert-circle' })
    }
    return list
  }, [nodes, form.runtime?.nodeId, t])

  const patchRuntimeField = (patch: Partial<ProfileRuntime>) => {
    setForm((prev) => {
      if (!prev.runtime) return prev
      return { ...prev, runtime: { ...prev.runtime, ...patch } }
    })
  }

  const switchRuntimeKind = (kind: string) => {
    setForm((prev) => ({
      ...prev,
      runtime: { kind, agent: '' },
      runtimeArgsText: '',
      runtimeEnvPairs: [],
    }))
  }

  // 可用技能列表
  const availableSkills = skills ?? []

  // 技能勾选切换
  const handleToggleSkill = (skillId: string, checked: boolean) => {
    setForm((prev) => {
      const set = new Set(prev.selectedSkillIds)
      if (checked) {
        set.add(skillId)
      } else {
        set.delete(skillId)
      }
      return { ...prev, selectedSkillIds: Array.from(set) }
    })
  }

  // 保存操作
  const handleSave = async () => {
    setError(null)
    const normalizedId = form.id.trim()
    if (!normalizedId) {
      setError(t('profiles.drawer.error.idRequired'))
      return
    }

    if (isNew && !profileIdValid(normalizedId)) {
      setError(t('profiles.drawer.error.idInvalid'))
      return
    }

    if (form.runtime !== undefined && form.runtime.agent.trim() === '') {
      setError(t('profiles.drawer.error.runtimeAgentRequired'))
      return
    }

    const starterError = validateStarterDrafts(form.starters, t)
    if (starterError !== null) {
      setError(t('profiles.drawer.error.starterPrefix', { index: starterError.index + 1, error: starterError.error }))
      return
    }

    setIsSaving(true)
    try {
      const payload = buildProfileSavePayload({
        id: normalizedId,
        name: form.name,
        model: form.model,
        thinkingLevel: form.thinkingLevel,
        nodeId: form.nodeId,
        cwd: form.cwd,
        restrictToCwd: form.restrictToCwd,
        system: form.system,
        skills: form.useAllSkills ? undefined : form.selectedSkillIds,
        starters: form.starters,
        runtime: form.runtime,
        source: form.source,
        isNew,
        includeSystem: form.systemEdited,
      })

      let saved: Profile
      if (isNew) {
        saved = await profilesApi.create(payload)
      } else {
        saved = await profilesApi.update(normalizedId, payload)
      }

      const settled: FormState = { ...form, systemEdited: false, source: saved }
      setForm(settled)
      setBaseline(settled)
      onSaved?.(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  // 删除操作
  const handleConfirmDelete = async () => {
    if (!profile || isNew) return
    setIsDeleting(true)
    setError(null)
    try {
      await profilesApi.delete(profile.id)
      setShowDeleteConfirm(false)
      onDeleted?.(profile.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setShowDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }

  const titleText = isNew
    ? t('profiles.drawer.newTitle')
    : form.name || form.id || profile?.name || profile?.id || t('profiles.drawer.titleFallback')

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={handleRequestClose}
      title={titleText}
      titleClassName="break-word"
      titleExtra={
        isSystem ? (
          <span className="badge badge-warn" title={t('profiles.drawer.systemPillTitle')}>
            <HelmxIcon name="lock" size={10} />
            <span>{t('profiles.card.systemPill')}</span>
          </span>
        ) : undefined
      }
      meta={!isNew && form.id ? form.id : undefined}
      metaClassName="text-subtle break-word"
      aria-label={titleText}
      closeLabel={t('common.close')}
      footer={
        <div className="flex-row-between">
          <div>
            {canDelete && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-err"
                disabled={isSaving || isDeleting}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <HelmxIcon name="trash" size={13} />
                <span>{t('profiles.drawer.delete')}</span>
              </button>
            )}
          </div>

          <div className="flex-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={isSaving || isDeleting}
              onClick={handleRequestClose}
            >
              {t('common.cancel')}
            </button>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                isSaving ||
                  isDeleting ||
                  (isNew && !profileIdValid(form.id.trim()))
              }
              onClick={() => void handleSave()}
            >
              <HelmxIcon name={isSaving ? 'loader' : 'check'} size={13} />
              <span>{isSaving ? t('profiles.drawer.saving') : t('profiles.drawer.save')}</span>
            </button>
          </div>
        </div>
      }
      aux={
        <>
          {/* Delete confirmation dialog */}
          <ConfirmDialog
            open={showDeleteConfirm}
            onOpenChange={setShowDeleteConfirm}
            title={t('profiles.drawer.delete')}
            description={t('profiles.drawer.deleteConfirm.body', { name: form.name || form.id })}
            confirmText={isDeleting ? t('profiles.drawer.deleting') : t('profiles.drawer.deleteConfirm.confirm')}
            cancelText={t('common.cancel')}
            danger
            inline={inline}
            onConfirm={() => void handleConfirmDelete()}
          />

          {/* Dirty form guard dialog */}
          <ConfirmDialog
            open={showDiscardConfirm}
            onOpenChange={setShowDiscardConfirm}
            title={t('profiles.drawer.discardConfirm.title')}
            description={t('profiles.drawer.discardConfirm.body')}
            confirmText={t('profiles.drawer.discardConfirm.confirm')}
            cancelText={t('profiles.drawer.discardConfirm.cancel')}
            danger
            inline={inline}
            onConfirm={() => {
              setShowDiscardConfirm(false)
              onClose()
            }}
          />
        </>
      }
    >
            {error && (
              <div className="callout callout-error" role="alert">
                <HelmxIcon name="alert-circle" size={14} />
                <span className="callout-text">{error}</span>
              </div>
            )}

            {/* Basic fields */}
            <section className="section-flat">
              <div className="form-grid">
                <label htmlFor="profile-form-id" className="form-grid-label">
                  {t('profiles.drawer.field.id')}
                </label>
                <div className="form-grid-value">
                  {isNew ? (
                    <input
                      id="profile-form-id"
                      type="text"
                      className="input mono"
                      placeholder={t('profiles.drawer.field.idPlaceholder')}
                      value={form.id}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                        }))
                      }
                    />
                  ) : (
                    <input
                      id="profile-form-id"
                      type="text"
                      className="input mono"
                      value={form.id}
                      disabled
                      readOnly
                    />
                  )}
                </div>

                <label htmlFor="profile-form-name" className="form-grid-label">
                  {t('profiles.drawer.field.name')}
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-name"
                    type="text"
                    className="input"
                    placeholder={t('profiles.drawer.field.namePlaceholder')}
                    value={form.name}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                  />
                </div>

                <label
                  htmlFor="profile-form-desc"
                  className="form-grid-label form-grid-align-start"
                >
                  {t('profiles.drawer.field.description')}
                </label>
                <div className="form-grid-value">
                  <textarea
                    id="profile-form-desc"
                    className="input profile-desc-textarea"
                    rows={3}
                    placeholder={t('profiles.drawer.field.descriptionPlaceholder')}
                    value={form.description}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, description: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-model" className="form-grid-label">
                  {t('profiles.drawer.field.defaultModel')}
                </label>
                <div className="form-grid-value">
                  {/* 共享模型选择器（与 Composer/全局默认同一实现）：行内思考档位
                      chips 一并提交 model+level；点击行体仅应用模型，档位回落
                      跟随默认链（保存时省略 thinkingLevel 键）。 */}
                  <ModelPickerControl
                    buttonId="profile-form-model"
                    buttonAriaLabel={t('profiles.drawer.field.defaultModel')}
                    buttonTitle={form.model || t('profiles.modelOption.followSystemDefault')}
                    placeholderLabel={t('profiles.modelOption.followSystemDefault')}
                    effectiveModel={form.model}
                    activeThinkingLevel={form.thinkingLevel}
                    resetLabel={t('profiles.modelOption.followSystemDefault')}
                    resetTitle={t('profiles.modelOption.followSystemDefault')}
                    popoverSide={inline ? 'bottom' : 'top'}
                    enableShortcut={false}
                    disabled={isSaving || isDeleting}
                    {...pickerAdapter}
                    onApply={(model, level) =>
                      setForm((prev) => ({ ...prev, model, thinkingLevel: level ?? '' }))
                    }
                    onResetDefault={() =>
                      setForm((prev) => ({ ...prev, model: '', thinkingLevel: '' }))
                    }
                  />
                  <span className="text-subtle">{t('profiles.drawer.modelHint')}</span>
                </div>

                <label htmlFor="profile-form-node" className="form-grid-label">
                  {t('profiles.drawer.field.defaultNode')}
                </label>
                <div className="form-grid-value">
                  <Select
                    id="profile-form-node"
                    value={form.nodeId}
                    options={nodeOptions}
                    popoverClassName="helmx-select-popover-wide"
                    className="w-full mono"
                    inline={inline}
                    placeholder={t('profiles.drawer.unboundNode')}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, nodeId: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-cwd" className="form-grid-label">
                  {t('profiles.drawer.field.cwd')}
                </label>
                <div className="form-grid-value">
                  <input
                    id="profile-form-cwd"
                    type="text"
                    className="input mono"
                    placeholder={t('profiles.drawer.field.cwdPlaceholder')}
                    value={form.cwd}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, cwd: e.target.value }))
                    }
                  />
                </div>

                <label htmlFor="profile-form-restrict-cwd" className="form-grid-label">
                  {t('profiles.drawer.field.restrictToCwd')}
                </label>
                <div className="form-grid-value flex-col">
                  <Switch
                    id="profile-form-restrict-cwd"
                    checked={form.restrictToCwd}
                    onChange={(val) =>
                      setForm((prev) => ({ ...prev, restrictToCwd: val }))
                    }
                    label={t('profiles.drawer.field.restrictToCwd')}
                  />
                  <div className="profile-editor-hint">
                    {t('profiles.drawer.field.restrictToCwdHint')}
                  </div>
                </div>
              </div>
            </section>

            {/* Unmanaged external runtime (plugin disabled or removed): preserve on save unless cleared explicitly */}
            {!canEditRuntime && form.runtime !== undefined && (
              <section className="section-flat flex-row-between" data-runtime-unmanaged={form.runtime.kind}>
                <span className="text-muted">
                  {t('profiles.drawer.runtime.unmanagedNotice', { kind: form.runtime.kind })}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  title={t('profiles.drawer.runtime.clearTitle')}
                  disabled={isSaving || isDeleting}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      runtime: undefined,
                      runtimeArgsText: '',
                      runtimeEnvPairs: [],
                    }))
                  }
                >
                  <HelmxIcon name="x" size={12} />
                  <span>{t('profiles.drawer.runtime.clear')}</span>
                </button>
              </section>
            )}

            {/* Dynamic external runtime section driven by ctx.ui.profileRuntime */}
            {canEditRuntime && (
              <section className="section-flat" data-runtime-section="true">
                {(() => {
                  const headerSpec = activeRuntimeSpec ?? defaultRuntimeSpec
                  const headerLabel = headerSpec ? resolveLocalizedText(headerSpec.spec.label, locale) : ''
                  const headerDesc =
                    headerSpec?.spec.description !== undefined
                      ? resolveLocalizedText(headerSpec.spec.description, locale)
                      : ''
                  return (
                    <div className="flex-col-xs">
                      <Switch
                        id="profile-form-runtime-switch"
                        checked={form.runtime !== undefined}
                        onChange={(enabled) => {
                          if (enabled && form.runtime === undefined && defaultRuntimeSpec) {
                            setForm((prev) => ({
                              ...prev,
                              runtime: { kind: defaultRuntimeSpec.spec.kind, agent: '' },
                              runtimeArgsText: '',
                              runtimeEnvPairs: [],
                            }))
                          } else if (!enabled) {
                            setForm((prev) => ({
                              ...prev,
                              runtime: undefined,
                              runtimeArgsText: '',
                              runtimeEnvPairs: [],
                            }))
                          }
                        }}
                        label={
                          <span className="section-flat-title flex-row">
                            <HelmxIcon name={headerSpec?.spec.icon || 'terminal'} size={13} />
                            <span>{headerLabel}</span>
                          </span>
                        }
                      />
                      {headerDesc !== '' && <div className="profile-editor-hint">{headerDesc}</div>}
                    </div>
                  )
                })()}

                {form.runtime !== undefined && (
                  <div className="flex-col">
                    <div className="form-grid">
                      {runtimeSpecs.length > 1 && (
                        <>
                          <label htmlFor="profile-form-runtime-kind" className="form-grid-label">
                            {t('profiles.drawer.runtime.kind')}
                          </label>
                          <div className="form-grid-value">
                            <Select
                              id="profile-form-runtime-kind"
                              value={form.runtime.kind}
                              options={runtimeSpecs.map((item) => ({
                                value: item.spec.kind,
                                label: resolveLocalizedText(item.spec.label, locale),
                                icon: item.spec.icon || 'terminal',
                              }))}
                              className="w-full"
                              inline={inline}
                              onChange={(e) => switchRuntimeKind(e.target.value)}
                            />
                          </div>
                        </>
                      )}

                      <label htmlFor="profile-form-runtime-agent" className="form-grid-label">
                        {t('profiles.drawer.runtime.agent')}
                      </label>
                      <div className="form-grid-value">
                        <input
                          id="profile-form-runtime-agent"
                          type="text"
                          className="input mono"
                          list="helmx-profile-runtime-agents"
                          value={form.runtime.agent}
                          placeholder={
                            (activeRuntimeSpec?.spec.agentSuggestions ?? []).slice(0, 4).join(' / ') ||
                            t('profiles.drawer.runtime.agentPlaceholder')
                          }
                          onChange={(e) => patchRuntimeField({ agent: e.target.value })}
                        />
                        <datalist id="helmx-profile-runtime-agents">
                          {(activeRuntimeSpec?.spec.agentSuggestions ?? []).map((suggestion) => (
                            <option key={suggestion} value={suggestion} />
                          ))}
                        </datalist>
                      </div>

                      <label htmlFor="profile-form-runtime-node" className="form-grid-label">
                        {t('profiles.drawer.runtime.node')}
                      </label>
                      <div className="form-grid-value">
                        <Select
                          id="profile-form-runtime-node"
                          value={form.runtime.nodeId ?? ''}
                          options={runtimeNodeOptions}
                          popoverClassName="helmx-select-popover-wide"
                          className="w-full mono"
                          inline={inline}
                          placeholder={t('profiles.drawer.unboundNode')}
                          onChange={(e) =>
                            patchRuntimeField({ nodeId: e.target.value === '' ? undefined : e.target.value })
                          }
                        />
                      </div>

                      <label htmlFor="profile-form-runtime-workspace" className="form-grid-label">
                        {t('profiles.drawer.runtime.workspace')}
                      </label>
                      <div className="form-grid-value">
                        <input
                          id="profile-form-runtime-workspace"
                          type="text"
                          className="input mono"
                          value={form.runtime.workspace ?? ''}
                          placeholder={t('profiles.drawer.runtime.workspacePlaceholder')}
                          onChange={(e) =>
                            patchRuntimeField({ workspace: e.target.value })
                          }
                        />
                      </div>

                      <label
                        htmlFor="profile-form-runtime-args"
                        className="form-grid-label form-grid-align-start"
                      >
                        {t('profiles.drawer.runtime.args')}
                      </label>
                      <div className="form-grid-value">
                        <textarea
                          id="profile-form-runtime-args"
                          className="input mono profile-runtime-args"
                          rows={3}
                          spellCheck={false}
                          value={form.runtimeArgsText}
                          placeholder={t('profiles.drawer.runtime.argsPlaceholder')}
                          onChange={(e) => {
                            const text = e.target.value
                            setForm((prev) => ({
                              ...prev,
                              runtimeArgsText: text,
                              runtime: prev.runtime
                                ? { ...prev.runtime, args: argsTextToArgs(text) }
                                : prev.runtime,
                            }))
                          }}
                        />
                      </div>
                    </div>

                    <div className="flex-col">
                      <span className="text-muted">{t('profiles.drawer.runtime.envTitle')}</span>
                      {form.runtimeEnvPairs.map((pair, idx) => (
                        <div key={`runtime-env-${idx}`} className="flex-row">
                          <input
                            id={`profile-form-runtime-env-key-${idx}`}
                            type="text"
                            className="input mono flex-1"
                            placeholder={t('profiles.drawer.runtime.envKeyPlaceholder')}
                            aria-label={t('profiles.drawer.runtime.envKeyAria', { index: idx + 1 })}
                            value={pair.key}
                            onChange={(e) => {
                              const next = [...form.runtimeEnvPairs]
                              next[idx] = { ...pair, key: e.target.value }
                              setForm((prev) => ({
                                ...prev,
                                runtimeEnvPairs: next,
                                runtime: prev.runtime
                                  ? { ...prev.runtime, env: pairsToEnv(next) }
                                  : prev.runtime,
                              }))
                            }}
                          />
                          <input
                            id={`profile-form-runtime-env-value-${idx}`}
                            type="text"
                            className="input mono flex-1"
                            placeholder={t('profiles.drawer.runtime.envValuePlaceholder')}
                            aria-label={t('profiles.drawer.runtime.envValueAria', { index: idx + 1 })}
                            value={pair.value}
                            onChange={(e) => {
                              const next = [...form.runtimeEnvPairs]
                              next[idx] = { ...pair, value: e.target.value }
                              setForm((prev) => ({
                                ...prev,
                                runtimeEnvPairs: next,
                                runtime: prev.runtime
                                  ? { ...prev.runtime, env: pairsToEnv(next) }
                                  : prev.runtime,
                              }))
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={t('profiles.drawer.runtime.envDeleteAria', {
                              name: pair.key || idx + 1,
                            })}
                            title={t('profiles.drawer.runtime.envDeleteTitle')}
                            disabled={isSaving || isDeleting}
                            onClick={() => {
                              const next = form.runtimeEnvPairs.filter((_, i) => i !== idx)
                              setForm((prev) => ({
                                ...prev,
                                runtimeEnvPairs: next,
                                runtime: prev.runtime
                                  ? { ...prev.runtime, env: pairsToEnv(next) }
                                  : prev.runtime,
                              }))
                            }}
                          >
                            <HelmxIcon name="x" size={12} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={isSaving || isDeleting}
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            runtimeEnvPairs: [...prev.runtimeEnvPairs, { key: '', value: '' }],
                          }))
                        }
                      >
                        <HelmxIcon name="plus" size={12} />
                        <span>{t('profiles.drawer.runtime.envAdd')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* System prompt section */}
            <section className="section-flat">
              <div className="section-flat-header flex-row-between">
                <span className="section-flat-title">{t('profiles.drawer.system.title')}</span>
                <span className="mono profile-editor-meta">
                  {form.system
                    ? t('profiles.drawer.system.charsAndLines', {
                        chars: form.system.length,
                        lines: form.system.split('\n').length,
                      })
                    : t('profiles.drawer.system.chars', { chars: form.system.length })}
                </span>
              </div>
              <textarea
                id="profile-form-system"
                className="input mono profile-editor-textarea"
                rows={10}
                placeholder={t('profiles.drawer.system.placeholder')}
                value={form.system}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, system: e.target.value, systemEdited: true }))
                }
                aria-label={t('profiles.drawer.system.aria')}
              />
              <div className="profile-editor-hint">
                {t('profiles.drawer.system.hint')}
              </div>
            </section>

            {/* Plugin extension slots (e.g. builtin:memory long-term memory section) */}
            <PluginSlot
              ownerPluginId="builtin:profile"
              name={PROFILE_DETAIL_SECTION_SLOT}
              slotProps={{
                profileId: form.id.trim(),
                isNew,
                disabled: isSaving || isDeleting,
              }}
            />

            {/* Empty-conversation starters (max 6) */}
            <section className="section-flat">
              <div className="section-flat-header profile-starters-header">
                <span className="section-flat-title">{t('profiles.drawer.starters.title')}</span>
                <span className="mono profile-editor-meta">
                  {form.starters.length}/{PROFILE_STARTERS_MAX_ITEMS}
                </span>
              </div>
              <div className="profile-starters-list">
                {form.starters.length === 0 ? (
                  <div className="text-subtle text-xs profile-starters-empty">
                    {t('profiles.drawer.starters.empty')}
                  </div>
                ) : (
                  form.starters.map((starter, index) => {
                    const issue = validateStarterDraft(starter, t)
                    return (
                      <div key={`starter-${index}`} className="profile-starter-item">
                        <div className="profile-starter-fields">
                          <input
                            type="text"
                            className="input profile-starter-label"
                            placeholder={t('profiles.drawer.starters.labelPlaceholder')}
                            value={starter.label}
                            aria-label={t('profiles.drawer.starters.labelAria', { index: index + 1 })}
                            onChange={(e) =>
                              setForm((prev) => {
                                const starters = [...prev.starters]
                                starters[index] = { ...starters[index]!, label: e.target.value }
                                return { ...prev, starters }
                              })
                            }
                          />
                          <textarea
                            className="input profile-starter-prompt"
                            rows={2}
                            placeholder={t('profiles.drawer.starters.promptPlaceholder')}
                            value={starter.prompt}
                            aria-label={t('profiles.drawer.starters.promptAria', { index: index + 1 })}
                            onChange={(e) =>
                              setForm((prev) => {
                                const starters = [...prev.starters]
                                starters[index] = { ...starters[index]!, prompt: e.target.value }
                                return { ...prev, starters }
                              })
                            }
                          />
                        </div>
                        {issue !== null ? (
                          <div className="profile-starter-error" role="alert">
                            {issue}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm profile-starter-remove"
                          aria-label={t('profiles.drawer.starters.deleteAria', { index: index + 1 })}
                          title={t('profiles.drawer.starters.deleteTitle')}
                          disabled={isSaving || isDeleting}
                          onClick={() =>
                            setForm((prev) => ({
                              ...prev,
                              starters: prev.starters.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          <HelmxIcon name="trash-2" size={12} />
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm profile-starter-add"
                disabled={isSaving || isDeleting || startersAtLimit(form.starters)}
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    starters: [...prev.starters, { label: '', prompt: '' }],
                  }))
                }
              >
                <HelmxIcon name="plus" size={12} />
                <span>{t('profiles.drawer.starters.add')}</span>
              </button>
            </section>

            {/* Skill allowlist */}
            <section className="section-flat">
              <div className="section-flat-header flex-row-between">
                <span className="section-flat-title">{t('profiles.drawer.skills.title')}</span>
                <Switch
                  id="profile-form-skills-switch"
                  checked={form.useAllSkills}
                  onChange={(val) =>
                    setForm((prev) => ({ ...prev, useAllSkills: val }))
                  }
                  label={t('profiles.card.allSkills')}
                />
              </div>

              {form.useAllSkills ? (
                <div className="text-subtle">
                  {t('profiles.drawer.skills.allHint')}
                </div>
              ) : (
                <div
                  className="flex-col"
                  style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {availableSkills.length === 0 ? (
                    <div className="text-subtle">{t('profiles.drawer.skills.empty')}</div>
                  ) : (
                    availableSkills.map((s) => {
                      const desc = summarizeSingleLine(s.description)
                      return (
                        <Checkbox
                          key={s.id}
                          checked={form.selectedSkillIds.includes(s.id)}
                          onChange={(checked) => handleToggleSkill(s.id, checked)}
                          label={
                            <span className="flex-col" style={{ gap: 1 }}>
                              <span className="flex-row text-muted">
                                <span>{s.name}</span>
                                <span className="mono text-subtle">({s.id})</span>
                              </span>
                              {desc !== '' ? (
                                <span className="profile-skill-desc" title={s.description}>
                                  {desc}
                                </span>
                              ) : null}
                            </span>
                          }
                        />
                      )
                    })
                  )}
                </div>
              )}
            </section>
    </DetailDrawer>
  )
}
