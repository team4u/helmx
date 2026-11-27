import React from 'react'
import { Card, Field, Textarea } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'

export interface ProfileSystemPromptCardProps {
  system: string
  /** 用户编辑即标记 systemEdited（保存时才随 PUT 提交 SYSTEM.md）。 */
  onSystemChange: (text: string) => void
}

/** 系统提示词分节：字符 / 行数统计与等宽编辑器。 */
export function ProfileSystemPromptCard({ system, onSystemChange }: ProfileSystemPromptCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <Card
      variant="subtle"
      title={t('profiles.drawer.system.title')}
      actions={
        <span className="mono profile-editor-meta">
          {system
            ? t('profiles.drawer.system.charsAndLines', {
                chars: system.length,
                lines: system.split('\n').length,
              })
            : t('profiles.drawer.system.chars', { chars: system.length })}
        </span>
      }
    >
      <Field htmlFor="profile-form-system" hint={t('profiles.drawer.system.hint')}>
        <Textarea
          mono
          className="profile-editor-textarea"
          rows={10}
          placeholder={t('profiles.drawer.system.placeholder')}
          value={system}
          onChange={(e) => onSystemChange(e.target.value)}
          aria-label={t('profiles.drawer.system.aria')}
        />
      </Field>
    </Card>
  )
}
