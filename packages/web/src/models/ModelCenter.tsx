import type * as React from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import type { ModelProviderSummary, ProviderConfig } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  CardGrid,
  EmptyState,
  HelmxIcon,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { assetsApi } from '../lib/api.js'
import {
  useCredentials,
  useLocationTargets,
  useModelDefaults,
  useModels,
  useProviders,
  useStoreActions,
} from '../lib/store-context.js'
import type { ModelsCenterTab } from '../lib/types.js'
import { SystemCenterShell, SystemCenterToolbar } from '../ui/SystemCenterShell.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { GlobalDefaultsPanel, type DefaultModelInfo } from './GlobalDefaultsPanel.js'
import { ModelCard } from './ModelCard.js'
import { ModelDetailDrawer, type CustomGatewayCreateInput, type ProviderSavePayload } from './ModelDetailDrawer.js'
import {
  buildDefaultProviders,
  buildMergedProviders,
  buildProviderCategoryCounts,
  buildProviderFilterTabs,
  filterProviders,
  isProviderFilterEligible,
  sortProvidersConfiguredFirst,
  type ProviderFilterTab,
  type ProviderItem,
} from './model-center-model.js'

export interface ModelCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  inlineDrawer?: boolean
  providers?: ProviderItem[]
  onSaveProvider?: (
    providerId: string,
    data: ProviderSavePayload,
  ) => Promise<void> | void
  onTestConnection?: (
    providerId: string,
    baseUrl?: string,
  ) => Promise<{ success: boolean; latencyMs?: number; message?: string }>
}

/**
 * Full-screen Models & Credentials Center primary view container:
 * - reads global default model from store (`useModelDefaults`) with zero redundant `/api/models/default` fetch;
 * - pulls backend PI-native & dynamic plugin provider catalog live via `assetsApi.listModelProviders()`.
 */
export function ModelCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
  providers: customProviders,
  onSaveProvider,
  onTestConnection,
}: ModelCenterProps): React.JSX.Element {
  const models = useModels()
  const modelDefaults = useModelDefaults()
  const storeProviders = useProviders()
  const credentials = useCredentials()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, refreshAssets, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [statusTab, setStatusTab] = useState<ProviderFilterTab>('all')
  const providersPanelId = useId()

  const [catalog, setCatalog] = useState<ModelProviderSummary[]>([])
  const [savedDefaultOverride, setSavedDefaultOverride] = useState<DefaultModelInfo | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [creatingCustom, setCreatingCustom] = useState(false)

  useEffect(() => {
    setSavedDefaultOverride(null)
  }, [modelDefaults])

  const defaultModelInfo: DefaultModelInfo | null = useMemo(() => {
    if (savedDefaultOverride !== null) return savedDefaultOverride
    if (
      modelDefaults.defaultModel === undefined &&
      modelDefaults.defaultThinkingLevel === undefined &&
      modelDefaults.defaultCompactionModel === undefined &&
      modelDefaults.defaultCompactionThinkingLevel === undefined &&
      modelDefaults.modelThinkingLevels === undefined
    ) {
      return null
    }
    return {
      defaultModel: modelDefaults.defaultModel ?? '',
      defaultThinkingLevel: modelDefaults.defaultThinkingLevel ?? '',
      ...(modelDefaults.modelThinkingLevels !== undefined ? { modelThinkingLevels: modelDefaults.modelThinkingLevels } : {}),
      ...(modelDefaults.defaultCompactionModel !== undefined ? { defaultCompactionModel: modelDefaults.defaultCompactionModel } : {}),
      ...(modelDefaults.defaultCompactionThinkingLevel !== undefined
        ? { defaultCompactionThinkingLevel: modelDefaults.defaultCompactionThinkingLevel }
        : {}),
    }
  }, [modelDefaults, savedDefaultOverride])

  useEffect(() => {
    let cancelled = false
    void assetsApi
      .listModelProviders()
      .then((cat) => {
        if (!cancelled && Array.isArray(cat)) setCatalog(cat)
      })
      .catch(() => {
        // ignore transient catalog fetch errors
      })
    return () => {
      cancelled = true
    }
  }, [models, credentials])

  const providers = useMemo(() => {
    if (customProviders) return sortProvidersConfiguredFirst(customProviders)
    return buildMergedProviders(
      buildDefaultProviders(t),
      credentials,
      storeProviders,
      models,
      catalog,
      t,
    )
  }, [customProviders, credentials, storeProviders, models, catalog, t])

  const statusCounts = useMemo(() => buildProviderCategoryCounts(providers), [providers])
  const pills = useMemo(
    () =>
      buildProviderFilterTabs(t).map((tab) => ({
        key: tab.key,
        label: tab.label,
        count: statusCounts[tab.key] ?? 0,
      })),
    [statusCounts, t],
  )

  const filteredProviders = useMemo(
    () => filterProviders(providers, { query, statusTab }),
    [providers, query, statusTab],
  )

  const currentTarget = isSplit && splitTarget?.kind === 'models' ? splitTarget : primaryTarget
  const selectedProviderId = currentTarget.kind === 'models' ? currentTarget.providerId : undefined
  const centerTab: ModelsCenterTab = currentTarget.kind === 'models' ? currentTarget.tab ?? 'providers' : 'providers'

  const selectedProvider = useMemo(() => {
    if (!selectedProviderId) return null
    return providers.find((p) => p.id === selectedProviderId) ?? null
  }, [providers, selectedProviderId])

  const isDrawerOpen = creatingCustom || Boolean(selectedProviderId && selectedProvider)

  const handleSelectProvider = (providerId: string) => {
    setCreatingCustom(false)
    openTarget({ kind: 'models', providerId }, isSplit ? { split: true } : undefined)
  }

  const handleOpenCreateCustom = () => {
    setCreatingCustom(true)
    if (centerTab !== 'providers' || selectedProviderId !== undefined) {
      openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
    }
  }

  const handleCloseDrawer = () => {
    setCreatingCustom(false)
    openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
  }

  const handleTabChange = (tab: string) => {
    if (tab === centerTab) return
    setCreatingCustom(false)
    openTarget(
      tab === 'defaults' ? { kind: 'models', tab: 'defaults' } : { kind: 'models' },
      isSplit ? { split: true } : undefined,
    )
  }

  const handleRefreshAll = async () => {
    setRefreshingCatalog(true)
    try {
      await assetsApi.refreshModels()
      const cat = await assetsApi.listModelProviders().catch(() => [])
      if (Array.isArray(cat)) setCatalog(cat)
      if (refreshAssets) await refreshAssets()
      pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.catalogRefreshed'),
        body: t('models.notice.catalogRefreshedBody'),
      })
    } catch (err) {
      pushNotice?.({
        type: 'notification',
        level: 'error',
        title: t('models.notice.catalogRefreshFailed'),
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRefreshingCatalog(false)
    }
  }

  const handleSave = async (providerId: string, data: ProviderSavePayload) => {
    if (onSaveProvider) {
      await onSaveProvider(providerId, data)
      return
    }
    const provider = providers.find((p) => p.id === providerId)
    const filterEligible = isProviderFilterEligible(provider, models)

    try {
      if (data.apiKey) {
        await assetsApi.setCredential(providerId, data.apiKey)
      }
      if (provider?.custom === true && data.baseUrl !== undefined && data.baseUrl !== '') {
        const gateways = storeProviders ?? []
        const gateway = gateways.find((g) => g.id === providerId)
        if (gateway === undefined) {
          throw new Error(`Custom gateway ${providerId} not found in providers.json; cannot update the endpoint`)
        }
        const nextGateway: ProviderConfig = {
          ...gateway,
          baseUrl: data.baseUrl,
          ...(data.protocol !== undefined ? { protocol: data.protocol } : {}),
          ...(data.label !== undefined ? { label: data.label || undefined } : {}),
          ...(data.customModelIds !== undefined ? { models: data.customModelIds } : {}),
        }
        await assetsApi.saveProviders(gateways.map((g) => (g.id === providerId ? nextGateway : g)))
      }
      if (data.models && filterEligible) {
        const disabledModels = data.models.filter((m) => !m.enabled).map((m) => m.id)
        await assetsApi.setModelFilter({ provider: providerId, disabledModels })
      }
      pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.providerUpdated'),
        body: t('models.notice.providerUpdatedBody', { providerId }),
      })
      if (refreshAssets) await refreshAssets()
    } catch (err) {
      pushNotice?.({
        type: 'notification',
        level: 'error',
        title: t('models.notice.saveFailed'),
        body: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const handleCreateCustomGateway = async (input: CustomGatewayCreateInput) => {
    const gateways = storeProviders ?? []
    const nextConfig: ProviderConfig = {
      id: input.id,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      models: input.models,
      ...(input.label ? { label: input.label } : {}),
      enabled: true,
    }
    try {
      await assetsApi.saveProviders([...gateways, nextConfig])
      if (input.apiKey) await assetsApi.setCredential(input.id, input.apiKey)
      if (refreshAssets) await refreshAssets()
      pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.customCreated'),
        body: t('models.notice.customCreatedBody', { name: input.label || input.id, id: input.id }),
      })
      setCreatingCustom(false)
      openTarget({ kind: 'models', providerId: input.id }, isSplit ? { split: true } : undefined)
    } catch (err) {
      pushNotice?.({
        type: 'notification',
        level: 'error',
        title: t('models.notice.saveFailed'),
        body: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const handleDeleteCustomGateway = async (providerId: string) => {
    const gateways = storeProviders ?? []
    const target = providers.find((p) => p.id === providerId)
    try {
      await assetsApi.saveProviders(gateways.filter((g) => g.id !== providerId))
      if (refreshAssets) await refreshAssets()
      pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.customDeleted'),
        body: t('models.notice.customDeletedBody', { name: target?.name || providerId }),
      })
      handleCloseDrawer()
    } catch (err) {
      pushNotice?.({
        type: 'notification',
        level: 'error',
        title: t('models.notice.saveFailed'),
        body: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'models', providerId: selectedProviderId, tab: centerTab }),
  })

  return (
    <SystemCenterShell
      dataView="model-center"
      isSplit={isSplit}
      isSplitActive={isSplitActive}
      onCloseSplit={onCloseSplit}
      onToggleSplit={toggleSplit}
      icon="cpu"
      title={t('models.title')}
      wrapContent={false}
      headerActions={
        <>
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            onClick={handleOpenCreateCustom}
            title={t('models.addCustomGatewayTitle')}
          >
            <span className="pane-action-label">{t('models.addCustomGateway')}</span>
          </Button>
          <Button
            size="sm"
            icon={<HelmxIcon name="refresh-cw" size={12} className={refreshingCatalog ? 'spin' : undefined} />}
            onClick={handleRefreshAll}
            disabled={refreshingCatalog}
            title={t('models.refreshCatalogTitle')}
          >
            <span className="pane-action-label">{t('models.refreshCatalog')}</span>
          </Button>
        </>
      }
      belowTopbar={
        <>
          <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-tabs">
            <TabsList aria-label={t('models.viewsAria')}>
              <TabsTrigger value="providers" className="model-center-tab-btn">
                <HelmxIcon name="layers" size={13} />
                <span>{t('models.tab.providers')}</span>
              </TabsTrigger>
              <TabsTrigger value="defaults" className="model-center-tab-btn">
                <HelmxIcon name="sliders" size={13} />
                <span>{t('models.tab.defaults')}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="model-defaults-status">
            <HelmxIcon name="sliders" size={13} />
            <Badge tone={defaultModelInfo?.defaultModel ? 'ok' : 'neutral'}>
              {defaultModelInfo?.defaultModel ? t('models.configured') : t('models.defaults.notSet')}
            </Badge>
            {defaultModelInfo?.defaultModel ? (
              <span>
                {t('models.defaults.currentPrefix')} <strong className="mono">{defaultModelInfo.defaultModel}</strong>
                {defaultModelInfo.defaultThinkingLevel &&
                  defaultModelInfo.defaultThinkingLevel !== 'off' &&
                  t('models.defaults.thinkingLevelSuffix', { level: defaultModelInfo.defaultThinkingLevel })}
              </span>
            ) : (
              <span>{t('models.defaults.unsetHint')}</span>
            )}
            {defaultModelInfo?.defaultCompactionModel && (
              <span>
                {t('models.defaults.compactionCurrentPrefix')}{' '}
                <strong className="mono">{defaultModelInfo.defaultCompactionModel}</strong>
                {defaultModelInfo.defaultCompactionThinkingLevel &&
                  defaultModelInfo.defaultCompactionThinkingLevel !== 'off' &&
                  t('models.defaults.thinkingLevelSuffix', {
                    level: defaultModelInfo.defaultCompactionThinkingLevel,
                  })}
              </span>
            )}
            <span className="text-subtle">{t('models.defaults.inheritanceChain')}</span>
          </div>
        </>
      }
      overlays={
        <ModelDetailDrawer
          provider={creatingCustom ? null : selectedProvider}
          isNewCustom={creatingCustom}
          existingProviderIds={providers.map((p) => p.id)}
          open={isDrawerOpen}
          onClose={handleCloseDrawer}
          inline={inlineDrawer}
          onSave={handleSave}
          onCreateCustomGateway={handleCreateCustomGateway}
          onDeleteCustomGateway={handleDeleteCustomGateway}
          onTestConnection={onTestConnection}
        />
      }
    >
      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-main-tabs">
        <TabsContent value="providers" className="primary-center-content">
          <SystemCenterToolbar
            className="model-toolbar-inline"
            controlsId={providersPanelId}
            query={query}
            onQueryChange={setQuery}
            searchPlaceholder={t('models.searchPlaceholder')}
            searchAriaLabel={t('models.searchAria')}
            clearSearchLabel={t('models.searchClear')}
            filterAriaLabel={t('models.filterAria')}
            pills={pills}
            activePill={statusTab}
            onSelectPill={setStatusTab}
          />
          <div id={providersPanelId} role="tabpanel">
            {filteredProviders.length === 0 ? (
              <EmptyState
                prominent
                icon="search"
                iconSize={22}
                title={t('models.emptyTitle')}
                hint={t('models.emptyHint')}
                action={
                  Boolean(query) || statusTab !== 'all' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setQuery('')
                        setStatusTab('all')
                      }}
                    >
                      {t('models.resetFilters')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <CardGrid minWidth="md" gap="md">
                {filteredProviders.map((provider) => (
                  <ModelCard
                    key={provider.id}
                    provider={provider}
                    selected={selectedProviderId === provider.id}
                    onSelect={() => handleSelectProvider(provider.id)}
                  />
                ))}
              </CardGrid>
            )}
          </div>
        </TabsContent>
        <TabsContent value="defaults" className="primary-center-content">
          <GlobalDefaultsPanel
            defaultModelInfo={defaultModelInfo}
            onSaved={setSavedDefaultOverride}
          />
        </TabsContent>
      </Tabs>
    </SystemCenterShell>
  )
}
