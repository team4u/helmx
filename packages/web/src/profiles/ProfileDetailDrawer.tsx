import React, { useEffect, useRef, useState } from 'react'
import { PROFILE_DETAIL_SECTION_SLOT } from '@helmx/protocol/browser'
import { Badge, Callout, DetailDrawer, MonoId, PluginSlot } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { isSystemProfile, profileIdValid, type Profile } from './profile-center-model.js'
import { ProfileBasicFieldsCard } from './profile-detail/ProfileBasicFieldsCard.js'
import { ProfileConfirmDialogs } from './profile-detail/ProfileConfirmDialogs.js'
import { ProfileDrawerFooter } from './profile-detail/ProfileDrawerFooter.js'
import { ProfileSkillsCard } from './profile-detail/ProfileSkillsCard.js'
import { ProfileStartersCard } from './profile-detail/ProfileStartersCard.js'
import { ProfileSystemPromptCard } from './profile-detail/ProfileSystemPromptCard.js'
import { useProfileForm } from './profile-detail/use-profile-form.js'

export interface ProfileDetailDrawerProps {
  profile: Profile | null
  isNew?: boolean
  open: boolean
  onClose: () => void
  inline?: boolean
  onSaved?: (saved: Profile) => void
  onDeleted?: (id: string) => void
}

/**
 * 智能体角色详情与配置抽屉（520px-560px 宽度）：
 * - 基于 Radix Dialog 原语实现平滑右侧滑出；
 * - 覆盖角色 ID、名称、描述、默认模型、默认节点、工作目录、系统提示词、插件扩展子插槽与技能白名单
 *   （候选技能超过 PROFILE_SKILL_SEARCH_THRESHOLD 时提供按名称 / ID / 描述搜索，焦点在搜索框时 Esc 先清空搜索再关抽屉）；
 * - 提供脏表单防护、新建校验与删除二次确认；
 * - 表单状态见 ./profile-detail/use-profile-form.ts，各分区卡片见 ./profile-detail/；
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
  const { t } = useWebLocale()
  const profileForm = useProfileForm({ profile, isNew, open, onSaved, onDeleted })
  const { form, setForm, isDirty, isSaving, isDeleting, error } = profileForm
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const skillSearchInputRef = useRef<HTMLInputElement | null>(null)
  const profileId = profile?.id

  // 与表单作用域同步的交互态：关闭时收起丢弃确认，打开 / 切角色时清空技能搜索词。
  useEffect(() => {
    if (!open) {
      setShowDiscardConfirm(false)
      return
    }
    setSkillQuery('')
  }, [open, profileId, isNew])

  const isSystem = Boolean(profile && isSystemProfile(profile))
  const canDelete = !isNew && !isSystem && Boolean(profile)

  // 关闭请求处理：脏表单时弹出确认
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true)
    } else {
      onClose()
    }
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
        <ProfileDrawerFooter
          canDelete={canDelete}
          isSaving={isSaving}
          isDeleting={isDeleting}
          saveDisabled={isNew && !profileIdValid(form.id.trim())}
          onRequestDelete={() => profileForm.setShowDeleteConfirm(true)}
          onRequestClose={handleRequestClose}
          onSave={() => void profileForm.handleSave()}
        />
      }
      aux={
        <ProfileConfirmDialogs
          inline={inline}
          deleteTargetName={form.name || form.id}
          showDeleteConfirm={profileForm.showDeleteConfirm}
          onShowDeleteChange={profileForm.setShowDeleteConfirm}
          isDeleting={isDeleting}
          onConfirmDelete={() => void profileForm.handleConfirmDelete()}
          showDiscardConfirm={showDiscardConfirm}
          onShowDiscardChange={setShowDiscardConfirm}
          onDiscard={() => {
            setShowDiscardConfirm(false)
            onClose()
          }}
        />
      }
    >
      {error && (
        <Callout tone="err">
          <span className="callout-text" role="alert">{error}</span>
        </Callout>
      )}

      <ProfileBasicFieldsCard
        form={form}
        isNew={isNew}
        inline={inline}
        disabled={isSaving || isDeleting}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      />

      <ProfileSystemPromptCard
        system={form.system}
        onSystemChange={(text) => setForm((prev) => ({ ...prev, system: text, systemEdited: true }))}
      />

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

      <ProfileStartersCard
        starters={form.starters}
        disabled={isSaving || isDeleting}
        onStartersChange={(next) => setForm((prev) => ({ ...prev, starters: next }))}
        onAdd={() =>
          setForm((prev) => ({
            ...prev,
            starters: [...prev.starters, { key: profileForm.createStarterKey(), label: '', prompt: '' }],
          }))
        }
      />

      <ProfileSkillsCard
        useAllSkills={form.useAllSkills}
        selectedSkillIds={form.selectedSkillIds}
        skillQuery={skillQuery}
        skillSearchInputRef={skillSearchInputRef}
        onUseAllSkillsChange={(val) => {
          // 切回「全部可用技能」时清空关键词，避免再次关闭白名单时列表被旧关键词过滤
          if (val) setSkillQuery('')
          setForm((prev) => ({ ...prev, useAllSkills: val }))
        }}
        onSkillQueryChange={setSkillQuery}
        onToggleSkill={handleToggleSkill}
      />
    </DetailDrawer>
  )
}
