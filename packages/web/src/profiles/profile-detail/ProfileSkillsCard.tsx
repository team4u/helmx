import React, { useMemo, type RefObject } from 'react'
import { Card, Checkbox, HelperText, SearchBox, Stack, Switch } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { summarizeSingleLine } from '../../lib/format.js'
import { useSkills } from '../../lib/store-context.js'
import { PROFILE_SKILL_SEARCH_THRESHOLD } from '../profile-center-model.js'
import { filterSkills } from '../../skills/skill-center-model.js'

export interface ProfileSkillsCardProps {
  useAllSkills: boolean
  selectedSkillIds: string[]
  skillQuery: string
  /** 搜索框引用：抽屉级分层 Esc 仅在焦点位于此时介入。 */
  skillSearchInputRef: RefObject<HTMLInputElement | null>
  onUseAllSkillsChange: (useAll: boolean) => void
  onSkillQueryChange: (query: string) => void
  onToggleSkill: (skillId: string, checked: boolean) => void
}

/** 技能白名单：全部可用开关；关闭白名单时按名称 / ID / 描述过滤候选技能（候选过多才显示搜索框）。 */
export function ProfileSkillsCard({
  useAllSkills,
  selectedSkillIds,
  skillQuery,
  skillSearchInputRef,
  onUseAllSkillsChange,
  onSkillQueryChange,
  onToggleSkill,
}: ProfileSkillsCardProps): React.JSX.Element {
  const skills = useSkills()
  const { t } = useWebLocale()
  const availableSkills = skills ?? []
  // 与技能中心同一匹配范围（id / name / description / references），不另写匹配逻辑
  const visibleSkills = useMemo(
    () => filterSkills(availableSkills, { query: skillQuery, categoryTab: 'all' }),
    [availableSkills, skillQuery],
  )

  return (
    <Card
      variant="subtle"
      title={t('profiles.drawer.skills.title')}
      actions={
        <Switch
          id="profile-form-skills-switch"
          checked={useAllSkills}
          onChange={onUseAllSkillsChange}
          label={t('profiles.card.allSkills')}
        />
      }
    >
      {useAllSkills ? (
        <HelperText>
          {t('profiles.drawer.skills.allHint')}
        </HelperText>
      ) : (
        <>
          {/* 搜索框在滚动容器外，列表滚动时保持可见；不传 clearOnEscape：Radix Dialog 内由抽屉级 onEscapeKeyDown 分层处理 */}
          {availableSkills.length > PROFILE_SKILL_SEARCH_THRESHOLD ? (
            <SearchBox
              value={skillQuery}
              onChange={onSkillQueryChange}
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
                    checked={selectedSkillIds.includes(s.id)}
                    onChange={(checked) => onToggleSkill(s.id, checked)}
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
  )
}
