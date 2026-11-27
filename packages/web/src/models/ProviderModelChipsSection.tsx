import React, { useMemo } from 'react'
import {
  Badge,
  Button,
  Card,
  HelperText,
  HelmxIcon,
  SearchBox,
  Stack,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { ProviderItem, ProviderModelItem } from './model-center-model.js'

/**
 * Maximum number of model pills rendered without a filter and before
 * expanding, so huge catalogs never flood the drawer in one frame.
 */
const CHIP_RENDER_LIMIT = 80

export interface ProviderModelChipsSectionProps {
  provider: ProviderItem
  models: ReadonlyArray<ProviderModelItem>
  filterEligible: boolean
  modelFilter: string
  isExpanded: boolean
  onModelFilterChange: (value: string) => void
  onToggleExpanded: () => void
  onToggleModel: (modelId: string) => void
  onSelectAll: (matchedIds: ReadonlySet<string> | null) => void
  onClearAll: (matchedIds: ReadonlySet<string> | null) => void
}

/**
 * Provider model catalog filter, bulk enable/disable controls, and model chips
 * cluster inside ModelDetailDrawer.
 */
export function ProviderModelChipsSection({
  provider,
  models,
  filterEligible,
  modelFilter,
  isExpanded,
  onModelFilterChange,
  onToggleExpanded,
  onToggleModel,
  onSelectAll,
  onClearAll,
}: ProviderModelChipsSectionProps): React.JSX.Element {
  const { t } = useWebLocale()

  const enabledCount = useMemo(
    () => models.reduce((sum, item) => sum + (item.enabled ? 1 : 0), 0),
    [models],
  )

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    if (q === '') return models
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.tags?.some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [models, modelFilter])

  const hasModelFilter = modelFilter.trim() !== ''

  const visibleModels = useMemo(() => {
    if (hasModelFilter || isExpanded) return filteredModels
    return filteredModels.slice(0, CHIP_RENDER_LIMIT)
  }, [filteredModels, hasModelFilter, isExpanded])

  const hiddenModelCount = filteredModels.length - visibleModels.length

  const matchedIds = useMemo(
    () => (hasModelFilter ? new Set(filteredModels.map((m) => m.id)) : null),
    [hasModelFilter, filteredModels],
  )

  return (
    <Card
      variant="subtle"
      title={
        <Stack direction="horizontal" gap="xs" align="center" inline>
          <HelmxIcon name="cpu" size={14} />
          <span>{t('models.models.section')}</span>
        </Stack>
      }
      actions={
        <Badge tone="neutral" mono className="tabular-nums">
          {t('models.models.countBadge', {
            enabled: enabledCount,
            total: models.length,
          })}
        </Badge>
      }
    >
      <HelperText>
        {filterEligible ? t('models.models.hint') : t('models.models.filterRequiresConfig')}
      </HelperText>

      {models.length === 0 ? (
        <HelperText>
          {provider.dynamic
            ? t('models.models.emptyDynamic')
            : t('models.models.emptyStatic')}
        </HelperText>
      ) : (
        <div className="models model-chips-container">
          <div className="mbulk model-chips-toolbar">
            <SearchBox
              size="sm"
              className="flex-1"
              value={modelFilter}
              onChange={onModelFilterChange}
              placeholder={t('models.models.filterPlaceholder')}
              ariaLabel={t('models.models.filterAria')}
            />
            <div className="model-chips-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={!filterEligible}
                onClick={() => onSelectAll(matchedIds)}
                title={hasModelFilter ? t('models.models.enableMatchesTitle') : t('models.models.enableAll')}
              >
                {hasModelFilter
                  ? t('models.models.enableMatches', { count: filteredModels.length })
                  : t('models.models.enableAll')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!filterEligible}
                onClick={() => onClearAll(matchedIds)}
                title={hasModelFilter ? t('models.models.disableMatchesTitle') : t('models.models.disableAll')}
              >
                {hasModelFilter
                  ? t('models.models.disableMatches', { count: filteredModels.length })
                  : t('models.models.disableAll')}
              </Button>
            </div>
          </div>

          <div
            className={`mchips model-drawer-tags-wrap ${isExpanded ? 'open is-expanded' : ''}`}
            role="group"
            aria-label={t('models.models.selectAria')}
          >
            {visibleModels.length === 0 ? (
              <HelperText>
                {t('models.models.noMatches')}
              </HelperText>
            ) : (
              visibleModels.map((model) => {
                const isChecked = Boolean(model.enabled)
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    disabled={!filterEligible}
                    className={`mchip pick model-drawer-tag ${isChecked ? 'on active' : ''}`}
                    onClick={() => onToggleModel(model.id)}
                    title={t(
                      isChecked
                        ? 'models.models.chipTitleDisable'
                        : 'models.models.chipTitleEnable',
                      { name: model.name, id: model.id },
                    )}
                  >
                    <span className="mchip-check" aria-hidden="true">
                      <HelmxIcon name="check" size={10} />
                    </span>
                    <span>{model.name}</span>
                    {model.tags?.map((tag) => (
                      <Badge key={tag} tone="neutral" className="mi-effort mchip-tag mtell">
                        {tag}
                      </Badge>
                    ))}
                  </button>
                )
              })
            )}
          </div>

          {models.length > 12 && (
            <Button
              variant="secondary"
              size="sm"
              className="mchips-fold"
              onClick={onToggleExpanded}
              aria-expanded={isExpanded}
              title={isExpanded ? t('models.models.collapseList') : t('models.models.expandAll')}
            >
              <span>
                {isExpanded
                  ? t('models.models.collapseList')
                  : hiddenModelCount > 0
                    ? t('models.models.expandAllHidden', { count: hiddenModelCount })
                    : t('models.models.expandAll')}
              </span>
              <HelmxIcon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={12} />
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
