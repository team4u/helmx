import React from 'react'
import { Badge, SelectCard, Stack, StatusLight } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { summarizeCardModels, type ProviderItem } from './model-center-model.js'

export interface ModelCardProps {
  provider: ProviderItem
  selected?: boolean
  onSelect: () => void
}

/**
 * Single provider card in the full-screen model center:
 * - built on SelectCard (<article> + <button aria-pressed> + sibling footer);
 * - header shows the provider name, status light, badges and mono ID;
 * - middle shows the capability description plus a preview of configured
 *   model short names (first 3 + remaining count);
 * - footer shows the available model count badge;
 * - strictly zero Emoji and WAI-ARIA keyboard-accessible interactions.
 */
export function ModelCard({
  provider,
  selected = false,
  onSelect,
}: ModelCardProps): React.JSX.Element {
  const { t } = useWebLocale()

  const { previewNames, remainingCount } = provider.configured
    ? summarizeCardModels(provider, 3)
    : { previewNames: [], remainingCount: 0 }

  return (
    <SelectCard
      className={provider.configured ? 'is-configured' : 'is-unconfigured'}
      selected={selected}
      onSelect={onSelect}
      aria-label={t('models.cardAria', { name: provider.name })}
      title={<span title={provider.name}>{provider.name}</span>}
      badges={
        <>
          <StatusLight
            tone={provider.configured ? 'done' : 'pending'}
            label={provider.configured ? t('models.configured') : t('models.notConfigured')}
          />
          {provider.dynamic && <Badge tone="neutral">{t('models.dynamicBadge')}</Badge>}
          {provider.custom && <Badge tone="neutral">{t('models.customBadge')}</Badge>}
        </>
      }
      subtitle={<span className="mono break-word">{provider.id}</span>}
      description={provider.description || t('models.cardFallbackDescription')}
      footer={
        <Badge tone="neutral" mono className="tabular-nums">
          {t('models.modelsAvailable', { count: provider.modelsCount })}
        </Badge>
      }
    >
      {/* Configured providers show the first 3 available model names plus the remaining count */}
      {previewNames.length > 0 && (
        <Stack direction="horizontal" gap="xs" align="center" wrap>
          {previewNames.map((name) => (
            <Badge key={name} tone="neutral" mono title={name}>
              {name}
            </Badge>
          ))}
          {remainingCount > 0 && (
            <Badge
              tone="neutral"
              className="tabular-nums"
              title={t('models.moreModels', { count: remainingCount })}
            >
              +{remainingCount}
            </Badge>
          )}
        </Stack>
      )}
    </SelectCard>
  )
}
