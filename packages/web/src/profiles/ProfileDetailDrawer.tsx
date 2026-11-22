import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  PROFILE_DETAIL_SECTION_SLOT,
  PROFILE_STARTERS_MAX_ITEMS,
} from '@helmx/protocol/browser'
import type { Profile, StarterDraft } from './profile-center-model.js'
import {
  buildProfileSavePayload,
  isSystemProfile,
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
  Switch,
} from '@helmx/plugin-client'
import { useNodes, useSkills } from '../lib/store-context.js'
import { summarizeSingleLine } from '../lib/format.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { buildNodeSelectOptions } from '../modals/nodes-modal-model.js'
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

interface StarterFormItem extends StarterDraft {
  /** Stable client-side React key for mutable starter rows. */
  key: string
}

let nextStarterKeySeq = 0
function createStarterKey(): string {
  nextStarterKeySeq += 1
  return `starter-${nextStarterKeySeq}`
}

function toStarterFormItems(starters: Profile['starters']): StarterFormItem[] {
  return startersToDrafts(starters).map((item) => ({ ...item, key: createStarterKey() }))
}

interface FormState {
  id: string
  name: string
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
  starters: StarterFormItem[]
  /** 保存时非表单字段（tags/managedByPlugin）从最近详情快照透传。 */
  source: Profile | null
}

function createInitialForm(profile: Profile | null, isNew: boolean): FormState {
  if (isNew || !profile) {
    return {
      id: '',
      name: '',
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
      source: null,
    }
  }

  return {
    id: profile.id,
    name: profile.name ?? '',
    model: resolveProfileModel(profile) ?? '',
    thinkingLevel: profile.thinkingLevel ?? '',
    nodeId: profile.nodeId ?? '',
    cwd: profile.cwd ?? '',
    restrictToCwd: profile.restrictToCwd === true,
    system: profile.system ?? '',
    systemEdited: false,
    useAllSkills: profile.skills === undefined,
    selectedSkillIds: Array.isArray(profile.skills) ? [...profile.skills] : [],
    starters: toStarterFormItems(profile.starters),
    source: profile,
  }
}

function mergeProfileDetailIntoForm(base: FormState, detail: Profile): FormState {
  return {
    ...base,
    name: detail.name ?? base.name,
    model: resolveProfileModel(detail) ?? base.model,
    thinkingLevel: detail.thinkingLevel ?? '',
    nodeId: detail.nodeId ?? base.nodeId,
    cwd: detail.cwd ?? base.cwd,
    restrictToCwd: detail.restrictToCwd === true,
    system: detail.system ?? base.system,
    systemEdited: false,
    useAllSkills: detail.skills === undefined,
    selectedSkillIds: Array.isArray(detail.skills) ? [...detail.skills] : base.selectedSkillIds,
    starters: toStarterFormItems(detail.starters),
    source: detail,
  }
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、默认节点、工作目录、系统提示词、插件扩展子插槽与技能白名单；
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
  const pickerAdapter = useModelPickerControlAdapter()
  const { t } = useWebLocale()
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
          const next = mergeProfileDetailIntoForm(initial, detail)
          setForm(next)
          setBaseline(next)
        })
        .catch((err) => {
          if (activeFetchIdRef.current !== targetId) return
          setError(err instanceof Error ? err.message : String(err))
        })
    }
  }, [open, profile, isNew])

  const isSystem = Boolean(profile && isSystemProfile(profile))
  const canDelete = !isNew && !isSystem && Boolean(profile)

  // 计算脏表单状态
  const isDirty = useMemo(() => {
    const startersDirty = (a: StarterDraft[], b: StarterDraft[]): boolean =>
      a.length !== b.length || a.some((item, i) => item.label !== b[i]?.label || item.prompt !== b[i]?.prompt)
    if (isNew) {
      return (
        form.id.trim() !== '' ||
        form.name.trim() !== '' ||
        form.model.trim() !== '' ||
        form.thinkingLevel !== '' ||
        form.nodeId.trim() !== '' ||
        form.cwd.trim() !== '' ||
        form.restrictToCwd ||
        form.system.trim() !== '' ||
        !form.useAllSkills ||
        form.selectedSkillIds.length > 0 ||
        form.starters.length > 0
      )
    }

    if (form.id !== baseline.id) return true
    if (form.name !== baseline.name) return true
    if (form.model !== baseline.model) return true
    if (form.thinkingLevel !== baseline.thinkingLevel) return true
    if (form.nodeId !== baseline.nodeId) return true
    if (form.cwd !== baseline.cwd) return true
    if (form.restrictToCwd !== baseline.restrictToCwd) return true
    if (form.systemEdited || form.system !== baseline.system) return true
    if (form.useAllSkills !== baseline.useAllSkills) return true
    if (startersDirty(form.starters, baseline.starters)) return true

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
                      <div key={starter.key} className="profile-starter-item">
                        <div className="profile-starter-fields">
                          <input
                            type="text"
                            className="input profile-starter-label"
                            placeholder={t('profiles.drawer.starters.labelPlaceholder')}
                            value={starter.label}
                            aria-label={t('profiles.drawer.starters.labelAria', { index: index + 1 })}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                starters: prev.starters.map((item) =>
                                  item.key === starter.key ? { ...item, label: e.target.value } : item,
                                ),
                              }))
                            }
                          />
                          <textarea
                            className="input profile-starter-prompt"
                            rows={2}
                            placeholder={t('profiles.drawer.starters.promptPlaceholder')}
                            value={starter.prompt}
                            aria-label={t('profiles.drawer.starters.promptAria', { index: index + 1 })}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                starters: prev.starters.map((item) =>
                                  item.key === starter.key ? { ...item, prompt: e.target.value } : item,
                                ),
                              }))
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
                              starters: prev.starters.filter((item) => item.key !== starter.key),
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
                    starters: [...prev.starters, { key: createStarterKey(), label: '', prompt: '' }],
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
