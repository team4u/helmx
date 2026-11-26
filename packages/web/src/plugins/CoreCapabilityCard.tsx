import React, { useMemo } from 'react'
import { DEFAULT_HELMX_LOCALE } from '@helmx/protocol/browser'
import { Badge, SelectCard, Stack } from '@helmx/plugin-client'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalLocale } from '../lib/store-context.js'
import type { CoreCapabilityOwner } from './core-capability-model.js'

export interface CoreCapabilityCardProps {
  owner: CoreCapabilityOwner
  selected: boolean
  onSelect: () => void
}

/**
 * Core capability owner card rendered in the Plugin Center's Core tab:
 * - Built on SDK SelectCard with `data-core-owner` marker;
 * - Read-only kernel namespace card (no enable/disable switch);
 * - Summarizes owned core actions and managed skills in the footer.
 */
export function CoreCapabilityCard({
  owner,
  selected,
  onSelect,
}: CoreCapabilityCardProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])

  return (
    <SelectCard
      className="plugin-card core-capability-card"
      selected={selected}
      onSelect={onSelect}
      data-core-owner={owner.id}
      title={
        <span className="primary-card-title-row">
          <span className="primary-card-name" title={owner.name}>
            {owner.name}
          </span>
          <Badge tone="accent" icon="shield" title={t('plugins.core.readOnlyHint')}>
            {t('plugins.core.badge')}
          </Badge>
        </span>
      }
      subtitle={
        <span className="mono break-word" title={owner.id}>
          {owner.id}
        </span>
      }
      footer={
        <Stack direction="horizontal" gap="xs" align="center" wrap className="primary-card-pills">
          {owner.actions.length > 0 && (
            <Badge
              tone="neutral"
              mono
              icon="zap"
              title={t('plugins.core.actionsTitle', { count: owner.actions.length })}
            >
              {t('plugins.core.actionsPill', { count: owner.actions.length })}
            </Badge>
          )}
          {owner.skills.length > 0 && (
            <Badge
              tone="neutral"
              mono
              icon="sparkles"
              title={t('plugins.core.skillsTitle', { count: owner.skills.length })}
            >
              {t('plugins.core.skillsPill', { count: owner.skills.length })}
            </Badge>
          )}
        </Stack>
      }
    >
      <div className="primary-card-desc" title={owner.description}>
        {owner.description}
      </div>
    </SelectCard>
  )
}
