import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PROFILE_DETAIL_SECTION_SLOT,
  PROFILE_STARTERS_MAX_ITEMS,
} from '@helmx/protocol/browser'
import type { Profile, StarterDraft } from './profile-center-model.js'
import {
  PROFILE_SKILL_SEARCH_THRESHOLD,
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
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  DetailDrawer,
  ErrorText,
  Field,
  HelperText,
  IconButton,
  Input,
  ModelPickerControl,
  MonoId,
  PluginSlot,
  SearchBox,
  Select,
  Stack,
  Switch,
  Textarea,
  useHostModels,
} from '@helmx/plugin-client'
import { resolveDefaultChainThinkingLevel } from '@helmx/plugin-client/pure'
import { useNodes, useSkills } from '../lib/store-context.js'
import { summarizeSingleLine } from '../lib/format.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { buildNodeSelectOptions } from '../modals/nodes-modal-model.js'
import { useModelPickerControlAdapter } from '../conversation/model-picker-adapter.js'
import { filterSkills } from '../skills/skill-center-model.js'

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

function toStarterFormItems(
  starters: Profile['starters'],
  nextKey: () => string,
): StarterFormItem[] {
  return startersToDrafts(starters).map((item) => ({ ...item, key: nextKey() }))
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

function createInitialForm(
  profile: Profile | null,
  isNew: boolean,
  nextKey: () => string,
): FormState {
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
    starters: toStarterFormItems(profile.starters, nextKey),
    source: profile,
  }
}

function mergeProfileDetailIntoForm(
  base: FormState,
  detail: Profile,
  nextKey: () => string,
): FormState {
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
    starters: toStarterFormItems(detail.starters, nextKey),
    source: detail,
  }
}

function sameStartersDraft(a: StarterDraft[], b: StarterDraft[]): boolean {
  return a.length === b.length && a.every((item, idx) => item.label === b[idx]?.label && item.prompt === b[idx]?.prompt)
}

function mergeHydratedDetailPreservingEdits(
  prev: FormState,
  initial: FormState,
  hydrated: FormState,
): FormState {
  const prevSkills = [...prev.selectedSkillIds].sort().join(',')
  const initSkills = [...initial.selectedSkillIds].sort().join(',')
  return {
    ...prev,
    name: prev.name === initial.name ? hydrated.name : prev.name,
    model: prev.model === initial.model ? hydrated.model : prev.model,
    thinkingLevel: prev.thinkingLevel === initial.thinkingLevel ? hydrated.thinkingLevel : prev.thinkingLevel,
    nodeId: prev.nodeId === initial.nodeId ? hydrated.nodeId : prev.nodeId,
    cwd: prev.cwd === initial.cwd ? hydrated.cwd : prev.cwd,
    restrictToCwd: prev.restrictToCwd === initial.restrictToCwd ? hydrated.restrictToCwd : prev.restrictToCwd,
    system: !prev.systemEdited && prev.system === initial.system ? hydrated.system : prev.system,
    useAllSkills: prev.useAllSkills === initial.useAllSkills ? hydrated.useAllSkills : prev.useAllSkills,
    selectedSkillIds: prevSkills === initSkills ? hydrated.selectedSkillIds : prev.selectedSkillIds,
    starters: sameStartersDraft(prev.starters, initial.starters) ? hydrated.starters : prev.starters,
    source: hydrated.source,
  }
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、默认节点、工作目录、系统提示词、插件扩展子插槽与技能白名单
 *   （候选技能超过 PROFILE_SKILL_SEARCH_THRESHOLD 时提供按名称 / ID / 描述搜索，焦点在搜索框时 Esc 先清空搜索再关抽屉）；
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
  const hostModels = useHostModels()
  const pickerAdapter = useModelPickerControlAdapter()
  const { t } = useWebLocale()
  const profileId = profile?.id
  const profileRef = useRef(profile)
  profileRef.current = profile
  const starterKeySeqRef = useRef(0)
  const createStarterKey = useCallback((): string => {
    starterKeySeqRef.current += 1
    return `starter-${starterKeySeqRef.current}`
  }, [])

  const [form, setForm] = useState<FormState>(() => createInitialForm(profile, isNew, createStarterKey))
  const [baseline, setBaseline] = useState<FormState>(() => createInitialForm(profile, isNew, createStarterKey))
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const skillSearchInputRef = useRef<HTMLInputElement | null>(null)

  const mountedRef = useRef(true)
  const formScopeGenRef = useRef(0)
  const opGenRef = useRef({ fetch: 0, save: 0, del: 0 })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Reset form (and skill search query) ONLY when opening/closing, switching profile ID, or toggling create mode
  // so SSE refreshes of the same profile never wipe unsaved edits.
  useEffect(() => {
    formScopeGenRef.current += 1
    const scopeGen = formScopeGenRef.current
    if (!open) {
      setError(null)
      setShowDeleteConfirm(false)
      setShowDiscardConfirm(false)
      setIsSaving(false)
      setIsDeleting(false)
      return
    }

    const initial = createInitialForm(profileRef.current, isNew, createStarterKey)
    setForm(initial)
    setBaseline(initial)
    setError(null)
    setIsSaving(false)
    setIsDeleting(false)
    setSkillQuery('')

    // 若编辑已有角色，尝试拉取全文详情（含完整 SYSTEM.md；MEMORY.md 由
    // builtin:memory 插件子插槽自治拉取，不经宿主 Profile 表单）
    if (!isNew && profileId) {
      const fetchSeq = ++opGenRef.current.fetch

      void profilesApi
        .get(profileId)
        .then((detail) => {
          if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.fetch !== fetchSeq) {
            return
          }
          const hydrated = mergeProfileDetailIntoForm(initial, detail, createStarterKey)
          setBaseline(hydrated)
          setForm((prev) => mergeHydratedDetailPreservingEdits(prev, initial, hydrated))
        })
        .catch((err) => {
          if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.fetch !== fetchSeq) {
            return
          }
          setError(err instanceof Error ? err.message : String(err))
        })
    }
  }, [open, profileId, isNew, createStarterKey])

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
  // 与技能中心同一匹配范围（id / name / description / references），不另写匹配逻辑
  const visibleSkills = useMemo(
    () => filterSkills(availableSkills, { query: skillQuery, categoryTab: 'all' }),
    [availableSkills, skillQuery],
  )

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

  // 分层 Esc（焦点限定：仅焦点在技能搜索框时介入，其余位置沿用原关闭链）。
  // Radix DismissableLayer 在 document 捕获阶段处理 Escape，React 合成事件拦不住，
  // 只能经 DetailDrawer 的 onEscapeKeyDown 钩子拦截。
  const handleDrawerEscapeKeyDown = (event: KeyboardEvent) => {
    if (skillSearchInputRef.current === null || document.activeElement !== skillSearchInputRef.current) {
      return
    }
    // IME 组合中 Esc 属于输入法（确认/取消候选），不关抽屉
    if (event.isComposing || event.keyCode === 229) {
      event.preventDefault()
      return
    }
    if (skillQuery !== '') {
      event.preventDefault()
      setSkillQuery('')
    }
  }

  // 保存操作
  const handleSave = async () => {
    setError(null)
    const submittedForm = form
    const normalizedId = submittedForm.id.trim()
    if (!normalizedId) {
      setError(t('profiles.drawer.error.idRequired'))
      return
    }

    if (isNew && !profileIdValid(normalizedId)) {
      setError(t('profiles.drawer.error.idInvalid'))
      return
    }

    const starterError = validateStarterDrafts(submittedForm.starters, t)
    if (starterError !== null) {
      setError(t('profiles.drawer.error.starterPrefix', { index: starterError.index + 1, error: starterError.error }))
      return
    }

    const scopeGen = formScopeGenRef.current
    const saveSeq = ++opGenRef.current.save
    setIsSaving(true)
    try {
      const payload = buildProfileSavePayload({
        id: normalizedId,
        name: submittedForm.name,
        model: submittedForm.model,
        thinkingLevel: submittedForm.thinkingLevel,
        nodeId: submittedForm.nodeId,
        cwd: submittedForm.cwd,
        restrictToCwd: submittedForm.restrictToCwd,
        system: submittedForm.system,
        skills: submittedForm.useAllSkills ? undefined : submittedForm.selectedSkillIds,
        starters: submittedForm.starters,
        source: submittedForm.source,
        isNew,
        includeSystem: submittedForm.systemEdited,
      })

      let saved: Profile
      if (isNew) {
        saved = await profilesApi.create(payload)
      } else {
        saved = await profilesApi.update(normalizedId, payload)
      }

      if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.save !== saveSeq) {
        return
      }

      const nextBaseline: FormState = { ...submittedForm, systemEdited: false, source: saved }
      setBaseline(nextBaseline)
      // Preserve any edits made while awaiting save rather than overwriting `form` with pre-await closure.
      setForm((prev) => ({
        ...prev,
        source: saved,
        systemEdited: prev.system === submittedForm.system ? false : prev.systemEdited,
      }))
      onSaved?.(saved)
    } catch (err) {
      if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.save !== saveSeq) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && formScopeGenRef.current === scopeGen && opGenRef.current.save === saveSeq) {
        setIsSaving(false)
      }
    }
  }

  // 删除操作
  const handleConfirmDelete = async () => {
    if (!profile || isNew) return
    const targetId = profile.id
    const scopeGen = formScopeGenRef.current
    const deleteSeq = ++opGenRef.current.del
    setIsDeleting(true)
    setError(null)
    try {
      await profilesApi.delete(targetId)
      if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.del !== deleteSeq) {
        return
      }
      setShowDeleteConfirm(false)
      onDeleted?.(targetId)
    } catch (err) {
      if (!mountedRef.current || formScopeGenRef.current !== scopeGen || opGenRef.current.del !== deleteSeq) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setShowDeleteConfirm(false)
    } finally {
      if (mountedRef.current && formScopeGenRef.current === scopeGen && opGenRef.current.del === deleteSeq) {
        setIsDeleting(false)
      }
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
      onEscapeKeyDown={handleDrawerEscapeKeyDown}
      title={titleText}
      titleClassName="break-word"
      titleExtra={
        isSystem ? (
          <Badge tone="warn" icon="lock" title={t('profiles.drawer.systemPillTitle')}>
            {t('profiles.card.systemPill')}
          </Badge>
        ) : undefined
      }
      meta={!isNew && form.id ? <MonoId value={form.id} /> : undefined}
      metaClassName="text-subtle break-word"
      aria-label={titleText}
      closeLabel={t('common.close')}
      footer={
        <Stack direction="horizontal" gap="sm" align="center" justify="between" className="flex-1">
          <div>
            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                className="text-err"
                disabled={isSaving || isDeleting}
                onClick={() => setShowDeleteConfirm(true)}
              >
                {t('profiles.drawer.delete')}
              </Button>
            )}
          </div>

          <Stack direction="horizontal" gap="sm" align="center">
            <Button
              variant="ghost"
              size="sm"
              disabled={isSaving || isDeleting}
              onClick={handleRequestClose}
            >
              {t('common.cancel')}
            </Button>

            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={isSaving}
              disabled={
                isDeleting ||
                  (isNew && !profileIdValid(form.id.trim()))
              }
              onClick={() => void handleSave()}
            >
              {isSaving ? t('profiles.drawer.saving') : t('profiles.drawer.save')}
            </Button>
          </Stack>
        </Stack>
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
        <Callout tone="err">
          <span className="callout-text" role="alert">{error}</span>
        </Callout>
      )}

      {/* Basic fields */}
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
                  setForm((prev) => ({
                    ...prev,
                    id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                  }))
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
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
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
              disabled={isSaving || isDeleting}
              {...pickerAdapter}
              onApply={(model, level) =>
                setForm((prev) => ({ ...prev, model, thinkingLevel: level ?? '' }))
              }
              onResetDefault={() =>
                setForm((prev) => ({ ...prev, model: '', thinkingLevel: '' }))
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
              onChange={(e) =>
                setForm((prev) => ({ ...prev, nodeId: e.target.value }))
              }
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
              onChange={(e) =>
                setForm((prev) => ({ ...prev, cwd: e.target.value }))
              }
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
              onChange={(val) =>
                setForm((prev) => ({ ...prev, restrictToCwd: val }))
              }
            />
          </Field>
        </Stack>
      </Card>

      {/* System prompt section */}
      <Card
        variant="subtle"
        title={t('profiles.drawer.system.title')}
        actions={
          <span className="mono profile-editor-meta">
            {form.system
              ? t('profiles.drawer.system.charsAndLines', {
                  chars: form.system.length,
                  lines: form.system.split('\n').length,
                })
              : t('profiles.drawer.system.chars', { chars: form.system.length })}
          </span>
        }
      >
        <Field htmlFor="profile-form-system" hint={t('profiles.drawer.system.hint')}>
          <Textarea
            mono
            className="profile-editor-textarea"
            rows={10}
            placeholder={t('profiles.drawer.system.placeholder')}
            value={form.system}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, system: e.target.value, systemEdited: true }))
            }
            aria-label={t('profiles.drawer.system.aria')}
          />
        </Field>
      </Card>

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
      <Card
        variant="subtle"
        title={t('profiles.drawer.starters.title')}
        actions={
          <span className="mono profile-editor-meta">
            {form.starters.length}/{PROFILE_STARTERS_MAX_ITEMS}
          </span>
        }
      >
        <div className="profile-starters-list">
          {form.starters.length === 0 ? (
            <HelperText className="profile-starters-empty">
              {t('profiles.drawer.starters.empty')}
            </HelperText>
          ) : (
            form.starters.map((starter, index) => {
              const issue = validateStarterDraft(starter, t)
              return (
                <div key={starter.key} className="profile-starter-item">
                  <div className="profile-starter-fields">
                    <Input
                      className="profile-starter-label"
                      placeholder={t('profiles.drawer.starters.labelPlaceholder')}
                      value={starter.label}
                      invalid={issue !== null}
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
                    <Textarea
                      className="profile-starter-prompt"
                      rows={2}
                      placeholder={t('profiles.drawer.starters.promptPlaceholder')}
                      value={starter.prompt}
                      invalid={issue !== null}
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
                    <ErrorText live className="profile-starter-error">
                      {issue}
                    </ErrorText>
                  ) : null}
                  <IconButton
                    icon="trash-2"
                    variant="ghost"
                    size="sm"
                    className="profile-starter-remove"
                    label={t('profiles.drawer.starters.deleteAria', { index: index + 1 })}
                    title={t('profiles.drawer.starters.deleteTitle')}
                    disabled={isSaving || isDeleting}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        starters: prev.starters.filter((item) => item.key !== starter.key),
                      }))
                    }
                  />
                </div>
              )
            })
          )}
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            className="profile-starter-add"
            disabled={isSaving || isDeleting || startersAtLimit(form.starters)}
            onClick={() =>
              setForm((prev) => ({
                ...prev,
                starters: [...prev.starters, { key: createStarterKey(), label: '', prompt: '' }],
              }))
            }
          >
            {t('profiles.drawer.starters.add')}
          </Button>
        </div>
      </Card>

      {/* Skill allowlist */}
      <Card
        variant="subtle"
        title={t('profiles.drawer.skills.title')}
        actions={
          <Switch
            id="profile-form-skills-switch"
            checked={form.useAllSkills}
            onChange={(val) => {
              // 切回「全部可用技能」时清空关键词，避免再次关闭白名单时列表被旧关键词过滤
              if (val) setSkillQuery('')
              setForm((prev) => ({ ...prev, useAllSkills: val }))
            }}
            label={t('profiles.card.allSkills')}
          />
        }
      >
        {form.useAllSkills ? (
          <HelperText>
            {t('profiles.drawer.skills.allHint')}
          </HelperText>
        ) : (
          <>
            {/* 搜索框在滚动容器外，列表滚动时保持可见；不传 clearOnEscape：Radix Dialog 内由抽屉级 onEscapeKeyDown 分层处理 */}
            {availableSkills.length > PROFILE_SKILL_SEARCH_THRESHOLD ? (
              <SearchBox
                value={skillQuery}
                onChange={setSkillQuery}
                inputRef={skillSearchInputRef}
                placeholder={t('profiles.drawer.skills.searchPlaceholder')}
                ariaLabel={t('profiles.drawer.skills.searchAria')}
                clearLabel={t('profiles.drawer.skills.clearSearch')}
                onCleared={() => skillSearchInputRef.current?.focus()}
              />
            ) : null}
            <Stack direction="vertical" gap="sm" className="profile-skills-scroll">
              {availableSkills.length === 0 ? (
                <HelperText>{t('profiles.drawer.skills.empty')}</HelperText>
              ) : visibleSkills.length === 0 ? (
                <HelperText>{t('profiles.drawer.skills.noMatches')}</HelperText>
              ) : (
                visibleSkills.map((s) => {
                  const desc = summarizeSingleLine(s.description)
                  return (
                    <Checkbox
                      key={s.id}
                      checked={form.selectedSkillIds.includes(s.id)}
                      onChange={(checked) => handleToggleSkill(s.id, checked)}
                      label={
                        <span className="profile-skill-option-label">
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
            </Stack>
          </>
        )}
      </Card>
    </DetailDrawer>
  )
}
