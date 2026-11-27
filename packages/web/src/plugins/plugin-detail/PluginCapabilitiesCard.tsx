import React from 'react'
import type { PluginSummary, SkillSummary } from '@helmx/protocol/browser'
import { Badge, Button, Card, HelmxIcon, HelperText, Stack } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import type { HelmxStoreActions } from '../../lib/helmx-store.js'
import { pluginManagedSkills } from './plugin-detail-model.js'

export interface PluginCapabilitiesCardProps {
  plugin: PluginSummary
  /** 技能目录（可选）：用于列出该插件受管技能并提供跳转。 */
  skills?: SkillSummary[]
  onOpenSkill?: (skillId: string) => void
  actions: HelmxStoreActions | null
}

/** 单类能力标签行；清单为空时显示对应的空态文案。 */
function CapabilityTags({ items, emptyLabel }: { items: string[]; emptyLabel: string }): React.JSX.Element {
  return items.length > 0 ? (
    <Stack direction="horizontal" gap="xs" align="center" wrap className="plugin-capability-tags">
      {items.map((item) => (
        <Badge key={item} tone="neutral" mono title={item}>
          {item}
        </Badge>
      ))}
    </Stack>
  ) : (
    <HelperText>{emptyLabel}</HelperText>
  )
}

/** 能力清单透视：Tools / Actions / Hooks 清单与受管技能（双向跳转技能中心）。 */
export function PluginCapabilitiesCard({
  plugin,
  skills,
  onOpenSkill,
  actions,
}: PluginCapabilitiesCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const managedSkills = pluginManagedSkills(skills, plugin.id)
  const handleOpenSkill = (skillId: string) => {
    if (onOpenSkill) onOpenSkill(skillId)
    else actions?.openTarget({ kind: 'skills', skillId })
  }

  return (
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
        <div className="plugin-capability-group">
          <div className="plugin-capability-group-header">
            <HelmxIcon name="wrench" size={11} />
            <span className="plugin-capability-group-title">
              Tools ({plugin.tools.length})
            </span>
          </div>
          <CapabilityTags items={plugin.tools} emptyLabel={t('plugins.drawer.noTools')} />
        </div>

        <div className="plugin-capability-group">
          <div className="plugin-capability-group-header">
            <HelmxIcon name="zap" size={11} />
            <span className="plugin-capability-group-title">
              Actions ({plugin.actions.length})
            </span>
          </div>
          <CapabilityTags items={plugin.actions} emptyLabel={t('plugins.drawer.noActions')} />
        </div>

        <div className="plugin-capability-group">
          <div className="plugin-capability-group-header">
            <HelmxIcon name="layers" size={11} />
            <span className="plugin-capability-group-title">
              Hooks ({plugin.hooks.length})
            </span>
          </div>
          <CapabilityTags items={plugin.hooks} emptyLabel={t('plugins.drawer.noHooks')} />
        </div>

        {managedSkills.length > 0 && (
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
                  variant="secondary"
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
        )}
      </div>
    </Card>
  )
}
