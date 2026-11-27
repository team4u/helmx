import React, { useEffect, useRef, useState } from 'react'
import type { SkillSummary } from '@helmx/protocol/browser'
import { Badge, Button, copyToClipboard, SelectCard, type BadgeTone } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { getSkillSourceBadge } from './skill-center-model.js'

export interface SkillCardProps {
  skill: SkillSummary
  selected?: boolean
  onSelect: () => void
}

/**
 * One skill card in the full-screen skill center:
 * - built on SelectCard (<article> + <button aria-pressed> + sibling footer);
 * - header shows the name, effective source badge (built-in / shared /
 *   workspace / plugin) and the monospace ID;
 * - middle shows the description;
 * - footer shows the one-click-copy `/skill:<id>` command button and the
 *   reference file count badge (omitted when 0);
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillCard({
  skill,
  selected = false,
  onSelect,
}: SkillCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const sourceBadge = getSkillSourceBadge(skill, t)
  const refCount = skill.references?.length ?? 0
  const description = skill.description || t('skills.card.noDescription')
  const slashCommand = `/skill:${skill.id}`
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopyCommand = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const ok = await copyToClipboard(slashCommand)
    if (!ok) return
    setCopied(true)
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      setCopied(false)
      copyTimerRef.current = null
    }, 1500)
  }

  const badgeTone: BadgeTone =
    sourceBadge.variant === 'agents' || sourceBadge.variant === 'core' ? 'accent' : 'neutral'
  const sourceTitleLabel =
    sourceBadge.variant === 'core' && skill.managedByPlugin
      ? `${sourceBadge.label} (${skill.managedByPlugin})`
      : sourceBadge.label

  return (
    <SelectCard
      className="skill-card"
      selected={selected}
      onSelect={onSelect}
      data-skill-id={skill.id}
      title={<span title={skill.name || skill.id}>{skill.name || skill.id}</span>}
      badges={
        <Badge
          tone={badgeTone}
          mono={sourceBadge.variant === 'plugin'}
          title={t('skills.card.sourceTitle', { label: sourceTitleLabel })}
        >
          {sourceBadge.label}
        </Badge>
      }
      subtitle={
        <span className="mono break-word" title={skill.id}>
          {skill.id}
        </span>
      }
      description={<span title={description}>{description}</span>}
      footer={
        <>
          <Button
            variant="secondary"
            size="xs"
            icon={copied ? 'check' : 'copy'}
            className="mono"
            title={t('skills.card.copyCommandTitle', { command: slashCommand })}
            aria-label={t('skills.card.copyCommandTitle', { command: slashCommand })}
            onClick={(e) => void handleCopyCommand(e)}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {copied ? t('skills.card.copied') : slashCommand}
          </Button>
          {refCount > 0 && (
            <Badge
              tone="neutral"
              icon="file-text"
              className="tabular-nums"
              title={t('skills.card.referenceFiles', { count: refCount })}
            >
              <span aria-label={t('skills.card.referenceFiles', { count: refCount })}>{refCount}</span>
            </Badge>
          )}
        </>
      }
    />
  )
}
