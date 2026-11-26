/**
 * 角色表单状态 Hook：初值 / 异步详情回填 / 保存 / 删除，统一带作用域代数守卫
 * （切角色、开关抽屉或新建模式切换后，迟到的旧响应不得写入新表单）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '@helmx/protocol/browser'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import {
  buildProfileSavePayload,
  profileIdValid,
  profilesApi,
  validateStarterDrafts,
} from '../profile-center-model.js'
import {
  createInitialForm,
  isProfileFormDirty,
  mergeHydratedDetailPreservingEdits,
  mergeProfileDetailIntoForm,
  type ProfileFormState,
} from './profile-form-model.js'

export interface ProfileFormOptions {
  profile: Profile | null
  isNew: boolean
  open: boolean
  onSaved?: (saved: Profile) => void
  onDeleted?: (id: string) => void
}

export function useProfileForm({ profile, isNew, open, onSaved, onDeleted }: ProfileFormOptions) {
  const { t } = useWebLocale()
  const profileId = profile?.id
  const profileRef = useRef(profile)
  profileRef.current = profile
  const starterKeySeqRef = useRef(0)
  const createStarterKey = useCallback((): string => {
    starterKeySeqRef.current += 1
    return `starter-${starterKeySeqRef.current}`
  }, [])

  const [form, setForm] = useState<ProfileFormState>(() => createInitialForm(profile, isNew, createStarterKey))
  const [baseline, setBaseline] = useState<ProfileFormState>(() => createInitialForm(profile, isNew, createStarterKey))
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const mountedRef = useRef(true)
  const formScopeGenRef = useRef(0)
  const opGenRef = useRef({ fetch: 0, save: 0, del: 0 })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Reset form ONLY when opening/closing, switching profile ID, or toggling create mode
  // so SSE refreshes of the same profile never wipe unsaved edits.
  useEffect(() => {
    formScopeGenRef.current += 1
    const scopeGen = formScopeGenRef.current
    if (!open) {
      setError(null)
      setShowDeleteConfirm(false)
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

  const isDirty = useMemo(() => isProfileFormDirty(form, baseline, isNew), [form, baseline, isNew])

  const isCurrentOp = (kind: 'save' | 'del', seq: number, scopeGen: number): boolean =>
    mountedRef.current && formScopeGenRef.current === scopeGen && opGenRef.current[kind] === seq

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

      if (!isCurrentOp('save', saveSeq, scopeGen)) {
        return
      }

      const nextBaseline: ProfileFormState = { ...submittedForm, systemEdited: false, source: saved }
      setBaseline(nextBaseline)
      // Preserve any edits made while awaiting save rather than overwriting `form` with pre-await closure.
      setForm((prev) => ({
        ...prev,
        source: saved,
        systemEdited: prev.system === submittedForm.system ? false : prev.systemEdited,
      }))
      onSaved?.(saved)
    } catch (err) {
      if (!isCurrentOp('save', saveSeq, scopeGen)) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrentOp('save', saveSeq, scopeGen)) {
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
      if (!isCurrentOp('del', deleteSeq, scopeGen)) {
        return
      }
      setShowDeleteConfirm(false)
      onDeleted?.(targetId)
    } catch (err) {
      if (!isCurrentOp('del', deleteSeq, scopeGen)) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setShowDeleteConfirm(false)
    } finally {
      if (isCurrentOp('del', deleteSeq, scopeGen)) {
        setIsDeleting(false)
      }
    }
  }

  return {
    form,
    setForm,
    isDirty,
    isSaving,
    isDeleting,
    error,
    showDeleteConfirm,
    setShowDeleteConfirm,
    createStarterKey,
    handleSave,
    handleConfirmDelete,
  }
}

export type ProfileForm = ReturnType<typeof useProfileForm>
