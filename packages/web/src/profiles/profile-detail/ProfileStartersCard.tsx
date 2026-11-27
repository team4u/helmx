import React from 'react'
import { PROFILE_STARTERS_MAX_ITEMS } from '@helmx/protocol/browser'
import { Button, Card, ErrorText, HelperText, IconButton, Input, Textarea } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { startersAtLimit, validateStarterDraft } from '../profile-center-model.js'
import type { StarterFormItem } from './profile-form-model.js'

export interface ProfileStartersCardProps {
  starters: StarterFormItem[]
  disabled: boolean
  /** 整体替换 starters（增删改均由本组件算好下一份数组）。 */
  onStartersChange: (next: StarterFormItem[]) => void
  /** 追加一行空 starter（key 由表单 Hook 的递增序号分配）。 */
  onAdd: () => void
}

/** 空会话开场建议（上限 PROFILE_STARTERS_MAX_ITEMS）：逐行校验并即时提示。 */
export function ProfileStartersCard({ starters, disabled, onStartersChange, onAdd }: ProfileStartersCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const patchStarter = (key: string, patch: { label?: string; prompt?: string }) => {
    onStartersChange(starters.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  return (
    <Card
      variant="subtle"
      title={t('profiles.drawer.starters.title')}
      actions={
        <span className="mono profile-editor-meta">
          {starters.length}/{PROFILE_STARTERS_MAX_ITEMS}
        </span>
      }
    >
      <div className="profile-starters-list">
        {starters.length === 0 ? (
          <HelperText className="profile-starters-empty">
            {t('profiles.drawer.starters.empty')}
          </HelperText>
        ) : (
          starters.map((starter, index) => {
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
                    onChange={(e) => patchStarter(starter.key, { label: e.target.value })}
                  />
                  <Textarea
                    className="profile-starter-prompt"
                    rows={2}
                    placeholder={t('profiles.drawer.starters.promptPlaceholder')}
                    value={starter.prompt}
                    invalid={issue !== null}
                    aria-label={t('profiles.drawer.starters.promptAria', { index: index + 1 })}
                    onChange={(e) => patchStarter(starter.key, { prompt: e.target.value })}
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
                  disabled={disabled}
                  onClick={() => onStartersChange(starters.filter((item) => item.key !== starter.key))}
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
          disabled={disabled || startersAtLimit(starters)}
          onClick={onAdd}
        >
          {t('profiles.drawer.starters.add')}
        </Button>
      </div>
    </Card>
  )
}
