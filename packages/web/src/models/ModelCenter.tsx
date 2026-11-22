import React, { useEffect, useMemo, useState } from 'react'
import type { ModelProviderSummary, ProviderConfig } from '@helmx/protocol/browser'
import { assetsApi } from '../lib/api.js'
import { HelmxIcon, SearchBox, Tabs, TabsContent, TabsList, TabsTrigger } from '@helmx/plugin-client'
import {
  useCredentials,
  useLocationTargets,
  useModels,
  useProviders,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { ModelsCenterTab } from '../lib/types.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
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
 * - a system-level full-stage view that fully replaces the legacy modal;
 * - top tabs switch between "Providers" (search + category pills + card grid)
 *   and "Global default" (inline default-model form); the tab state persists
 *   through the URL hash (#/settings/models/defaults) where defaults is a
 *   reserved path segment (the global-default tab);
 * - dynamic catalog loading: pulls the backend PI-native providers and plugin
 *   gateways live, with full listing and one-click refresh;
 * - details & credentials drawer: the right-side ModelDetailDrawer stays in
 *   sync with the URL hash deep link (#/settings/models/<providerId>);
 * - strictly zero Emoji; follows Fast Refresh and WAI-ARIA rules.
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
  const storeProviders = useProviders()
  const credentials = useCredentials()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, closeSplit, refreshAssets, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [statusTab, setStatusTab] = useState<ProviderFilterTab>('all')

  // Dynamic catalog and global default model state
  const [catalog, setCatalog] = useState<ModelProviderSummary[]>([])
  const [defaultModelInfo, setDefaultModelInfo] = useState<DefaultModelInfo | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [creatingCustom, setCreatingCustom] = useState(false)

  // On mount, fetch the full backend provider catalog and the global default
  // model config (generation guard: stale responses never overwrite on deps change).
  useEffect(() => {
    const generation = { cancelled: false }
    const fetchRemote = async () => {
      try {
        const [cat, def] = await Promise.all([
          assetsApi.listModelProviders().catch(() => []),
          assetsApi.getDefaultModel().catch(() => null),
        ])
        if (generation.cancelled) return
        if (Array.isArray(cat)) {
          setCatalog(cat)
        }
        if (def && typeof def === 'object') {
          setDefaultModelInfo(def)
        }
      } catch {
        // ignore
      }
    }
    void fetchRemote()
    return () => {
      generation.cancelled = true
    }
  }, [models, credentials])

  // Merge the mainstream presets with store credentials, gateways, the model
  // catalog and the full backend catalog (labels follow the active locale).
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

  // Combined filtering (by configuration status tab and keyword)
  const filteredProviders = useMemo(() => {
    return filterProviders(providers, { query, statusTab })
  }, [providers, query, statusTab])

  // Routing <-> drawer wiring: providerId and tab in both primary and split panes
  const currentTarget =
    isSplit && splitTarget?.kind === 'models'
      ? splitTarget
      : primaryTarget
  const selectedProviderId =
    currentTarget.kind === 'models' ? currentTarget.providerId : undefined
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

  // Tab changes write back to the URL: entering "Global default" clears the
  // providerId (the drawer never coexists with it).
  const handleTabChange = (tab: string) => {
    if (tab === centerTab) return
    setCreatingCustom(false)
    if (tab === 'defaults') {
      openTarget({ kind: 'models', tab: 'defaults' }, isSplit ? { split: true } : undefined)
    } else {
      openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)
    }
  }

  // Refresh the full model catalog
  const handleRefreshAll = async () => {
    setRefreshingCatalog(true)
    try {
      await assetsApi.refreshModels()
      const [cat, def] = await Promise.all([
        assetsApi.listModelProviders().catch(() => []),
        assetsApi.getDefaultModel().catch(() => null),
      ])
      if (Array.isArray(cat)) setCatalog(cat)
      if (def && typeof def === 'object') setDefaultModelInfo(def)
      if (refreshAssets) {
        await refreshAssets()
      }
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

  // Credential & model configuration save: credentials and model enablement
  // (full-replace semantics) are submitted separately; static preset providers
  // absent from the backend catalog skip the filter write (the catalog cannot
  // annotate them, so writing would be meaningless).
  const handleSave = async (
    providerId: string,
    data: ProviderSavePayload,
  ) => {
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
      // Custom gateway (providers.json) edit: full-replace updates only this
      // entry's baseUrl / protocol / label / models; other gateways stay intact.
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
        await assetsApi.saveProviders(
          gateways.map((g) => (g.id === providerId ? nextGateway : g)),
        )
      }
      if (data.models && filterEligible) {
        // Full replacement: the currently unchecked model ids are the
        // provider's complete disabled set (matching backend semantics).
        const disabledModels = data.models.filter((m) => !m.enabled).map((m) => m.id)
        await assetsApi.setModelFilter({ provider: providerId, disabledModels })
      }
      pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.providerUpdated'),
        body: t('models.notice.providerUpdatedBody', { providerId }),
      })
      if (refreshAssets) {
        await refreshAssets()
      }
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
      if (input.apiKey) {
        await assetsApi.setCredential(input.id, input.apiKey)
      }
      if (refreshAssets) {
        await refreshAssets()
      }
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
      if (refreshAssets) {
        await refreshAssets()
      }
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

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget(
      { kind: 'models', providerId: selectedProviderId, tab: centerTab },
      { split: true },
    )
  }

  const filterTabs = buildProviderFilterTabs(t)

  return (
    <div className={`primary-center${isSplit ? ' is-split' : ''}`} data-view="model-center">
      {/* Top bar */}
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name="cpu" size={14} />
            <span>{t('models.title')}</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions pane-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleOpenCreateCustom}
            title={t('models.addCustomGatewayTitle')}
          >
            <HelmxIcon name="plus" size={12} />
            <span className="pane-action-label">{t('models.addCustomGateway')}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRefreshAll}
            disabled={refreshingCatalog}
            title={t('models.refreshCatalogTitle')}
          >
            <HelmxIcon name="refresh-cw" size={12} className={refreshingCatalog ? 'spin' : undefined} />
            <span className="pane-action-label">{t('models.refreshCatalog')}</span>
          </button>
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>

      {/* Top tabs: providers / global defaults */}
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

      {/* Global default model compact status row */}
      <div className="model-defaults-status">
        <HelmxIcon name="sliders" size={13} />
        <span
          className={`badge ${defaultModelInfo?.defaultModel ? 'badge-ok' : 'badge-neutral'}`}
        >
          {defaultModelInfo?.defaultModel ? t('models.configured') : t('models.defaults.notSet')}
        </span>
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

      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-main-tabs">
        {/* Providers tab */}
        <TabsContent value="providers" className="primary-center-content">
          {/* Toolbar: search box, category pills and catalog refresh */}
          <div className="primary-center-toolbar model-toolbar-inline">
            <SearchBox
              className="primary-search-box"
              clearButtonClassName="btn btn-ghost btn-sm primary-search-clear"
              value={query}
              onChange={setQuery}
              placeholder={t('models.searchPlaceholder')}
              ariaLabel={t('models.searchAria')}
              clearLabel={t('models.searchClear')}
            />

            <div
              className="primary-category-pills"
              role="tablist"
              aria-label={t('models.filterAria')}
            >
              {filterTabs.map((tab) => {
                const count = statusCounts[tab.key] ?? 0
                const isActive = statusTab === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                    onClick={() => setStatusTab(tab.key)}
                  >
                    <span>{tab.label}</span>
                    <span className="badge tabular-nums">{count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Main card grid or empty state */}
          {filteredProviders.length === 0 ? (
            <div className="primary-center-empty">
              <div className="primary-center-empty-icon">
                <HelmxIcon name="search" size={22} />
              </div>
              <div className="primary-center-empty-text">{t('models.emptyTitle')}</div>
              <div className="primary-center-empty-hint">{t('models.emptyHint')}</div>
              {(query || statusTab !== 'all') && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setQuery('')
                    setStatusTab('all')
                  }}
                >
                  {t('models.resetFilters')}
                </button>
              )}
            </div>
          ) : (
            <div className="primary-center-grid">
              {filteredProviders.map((provider) => (
                <ModelCard
                  key={provider.id}
                  provider={provider}
                  selected={selectedProviderId === provider.id}
                  onSelect={() => handleSelectProvider(provider.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Global defaults tab */}
        <TabsContent value="defaults" className="primary-center-content">
          <GlobalDefaultsPanel
            defaultModelInfo={defaultModelInfo}
            onSaved={setDefaultModelInfo}
          />
        </TabsContent>
      </Tabs>

      {/* Provider details and credentials drawer */}
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
    </div>
  )
}
