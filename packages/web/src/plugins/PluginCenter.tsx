import type * as React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PluginSummary } from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import {
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
import { ApiClientError, pluginsApi } from '../lib/api.js'
import {
  useCatalogActions,
  useLocationTargets,
  useOptionalGroupedUi,
  usePlugins,
  useSkills,
  useStoreActions,
} from '../lib/store-context.js'
import type { PluginsCenterTab } from '../lib/types.js'
import { SystemCenterShell, SystemCenterToolbar } from '../ui/SystemCenterShell.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { CoreCapabilityCard } from './CoreCapabilityCard.js'
import { CoreCapabilityDetailDrawer } from './CoreCapabilityDetailDrawer.js'
import {
  buildCoreCapabilityOwners,
  coreCapabilityFilterLabel,
  filterCoreCapabilities,
  summarizeCoreCapabilities,
  type CoreCapabilityFilter,
} from './core-capability-model.js'
import { PluginCard } from './PluginCard.js'
import { PluginDetailDrawer } from './PluginDetailDrawer.js'
import { PluginInstallModal } from './PluginInstallModal.js'
import {
  filterPlugins,
  pluginStatusTabLabel,
  summarizePlugins,
  type PluginStatusFilter,
} from './plugin-center-model.js'
import {
  formatBatchUpdateSummary,
  formatUpdateResultDetail,
  listManagedPlugins,
  pluginPackageErrorText,
} from './plugin-package-model.js'

const PLUGIN_STATUS_TABS: PluginStatusFilter[] = ['all', 'views', 'enabled', 'disabled']
const CORE_FILTER_TABS: CoreCapabilityFilter[] = ['all', 'actions', 'skills']

export interface PluginCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉与弹窗是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

/**
 * 全屏插件中心（Plugin Center）主视图容器。
 */
export function PluginCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: PluginCenterProps): React.JSX.Element {
  const plugins = usePlugins() ?? []
  const catalogActions = useCatalogActions()
  const skills = useSkills()
  const groupedUi = useOptionalGroupedUi()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { syncPlugins, openTarget, pushNotice, refreshAssets } = useStoreActions()
  const { locale, t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<PluginStatusFilter>('all')
  const [coreQuery, setCoreQuery] = useState('')
  const [coreFilter, setCoreFilter] = useState<CoreCapabilityFilter>('all')
  const [refreshingCore, setRefreshingCore] = useState(false)
  const pluginsPanelId = useId()
  const corePanelId = useId()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [batchUpdate, setBatchUpdate] = useState<{ current: number; total: number } | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshGeneration = useRef(0)
  const updatingRef = useRef<Set<string>>(new Set())
  const batchRunningRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const managedPlugins = useMemo(() => listManagedPlugins(plugins), [plugins])

  const statusSummary = useMemo(() => summarizePlugins(plugins, groupedUi), [plugins, groupedUi])
  const pills = useMemo(
    () =>
      PLUGIN_STATUS_TABS.map((statusKey) => ({
        key: statusKey,
        label: pluginStatusTabLabel(statusKey, t),
        count:
          statusKey === 'all'
            ? statusSummary.total
            : statusKey === 'views'
              ? statusSummary.withViews
              : statusKey === 'enabled'
                ? statusSummary.enabled
                : statusSummary.disabled,
      })),
    [statusSummary, t],
  )

  const filteredPlugins = useMemo(
    () => filterPlugins(plugins, { query, status: statusFilter }, locale, groupedUi),
    [plugins, query, statusFilter, locale, groupedUi],
  )

  const currentTarget = isSplit ? splitTarget : primaryTarget
  const centerTab: PluginsCenterTab =
    currentTarget?.kind === 'plugins' &&
    (currentTarget.tab === 'core' || currentTarget.coreOwner !== undefined)
      ? 'core'
      : 'plugins'
  const selectedPluginId =
    currentTarget?.kind === 'plugins' && centerTab === 'plugins' ? currentTarget.pluginId : undefined
  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  )
  const isDrawerOpen = centerTab === 'plugins' && Boolean(selectedPluginId && selectedPlugin)

  const coreOwners = useMemo(
    () => buildCoreCapabilityOwners(catalogActions, skills, t),
    [catalogActions, skills, t],
  )
  const coreSummary = useMemo(() => summarizeCoreCapabilities(coreOwners), [coreOwners])
  const corePills = useMemo(
    () =>
      CORE_FILTER_TABS.map((filterKey) => ({
        key: filterKey,
        label: coreCapabilityFilterLabel(filterKey, t),
        count:
          filterKey === 'all'
            ? coreSummary.total
            : filterKey === 'actions'
              ? coreSummary.withActions
              : coreSummary.withSkills,
      })),
    [coreSummary, t],
  )
  const filteredCoreOwners = useMemo(
    () => filterCoreCapabilities(coreOwners, { query: coreQuery, filter: coreFilter }),
    [coreOwners, coreQuery, coreFilter],
  )
  const selectedCoreOwnerId =
    currentTarget?.kind === 'plugins' && centerTab === 'core' ? currentTarget.coreOwner : undefined
  const selectedCoreActionId =
    currentTarget?.kind === 'plugins' && centerTab === 'core' ? currentTarget.coreAction : undefined
  const selectedCoreOwner = useMemo(
    () => coreOwners.find((o) => o.id === selectedCoreOwnerId) ?? null,
    [coreOwners, selectedCoreOwnerId],
  )
  const isCoreDrawerOpen = centerTab === 'core' && Boolean(selectedCoreOwnerId && selectedCoreOwner)

  useEffect(() => {
    if (refreshTick === 0) return
    const generation = ++refreshGeneration.current
    void pluginsApi
      .list()
      .then((list) => {
        if (generation !== refreshGeneration.current) return
        syncPlugins?.(list)
      })
      .catch(() => {
        // 静默失败：SSE 快照仍是权威数据源，无需打断用户
      })
  }, [refreshTick, syncPlugins])

  const handlePackageChanged = () => setRefreshTick((tick) => tick + 1)

  const openPluginTarget = (pluginId?: string) => {
    openTarget(
      pluginId !== undefined ? { kind: 'plugins', pluginId } : { kind: 'plugins' },
      isSplit ? { split: true } : undefined,
    )
  }

  const openCoreTarget = (coreOwner?: string, coreAction?: string) => {
    openTarget(
      coreOwner !== undefined
        ? {
            kind: 'plugins',
            tab: 'core',
            coreOwner,
            ...(coreAction !== undefined ? { coreAction } : {}),
          }
        : { kind: 'plugins', tab: 'core' },
      isSplit ? { split: true } : undefined,
    )
  }

  const handleTabChange = (nextTab: string) => {
    if (nextTab === centerTab) return
    openTarget(
      nextTab === 'core' ? { kind: 'plugins', tab: 'core' } : { kind: 'plugins' },
      isSplit ? { split: true } : undefined,
    )
  }

  const handleOpenSkill = (skillId: string) => {
    openTarget({ kind: 'skills', skillId })
  }

  const handleRefreshCore = async () => {
    if (refreshingCore) return
    setRefreshingCore(true)
    try {
      await refreshAssets?.()
    } finally {
      if (mountedRef.current) setRefreshingCore(false)
    }
  }

  const handleInstalled = (pluginId: string, enableError?: { code: string; message: string }) => {
    openPluginTarget(pluginId)
    handlePackageChanged()
    if (enableError !== undefined) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('plugins.notice.installEnableFailedTitle'),
        body: `${enableError.code}: ${enableError.message}`,
      })
    }
  }

  const handleTogglePlugin = async (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => {
    if (plugin.locked || togglingId === plugin.id) return
    setTogglingId(plugin.id)
    const nextEnabled = targetEnabled !== undefined ? targetEnabled : !plugin.enabled
    const displayName = resolveLocalizedText(plugin.name, locale) || plugin.id
    try {
      if (nextEnabled) {
        await pluginsApi.enable(plugin.id)
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('plugins.notice.enabledTitle'),
          body: t('plugins.notice.enabledBody', { name: displayName }),
        })
      } else {
        await pluginsApi.disable(plugin.id, options)
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('plugins.notice.disabledTitle'),
          body: t('plugins.notice.disabledBody', { name: displayName }),
        })
      }
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: nextEnabled ? t('plugins.notice.enableFailedTitle') : t('plugins.notice.disableFailedTitle'),
        body:
          err instanceof ApiClientError && err.status === 409
            ? t('plugins.notice.liveTasksError', { code: err.code })
            : (err instanceof Error ? err.message : String(err)),
      })
      throw err
    } finally {
      setTogglingId(null)
    }
  }

  const handleUpdateSingle = async (plugin: PluginSummary): Promise<void> => {
    if (!plugin.managed || batchRunningRef.current || updatingRef.current.has(plugin.id)) return
    updatingRef.current.add(plugin.id)
    setUpdatingIds(new Set(updatingRef.current))
    const displayName = resolveLocalizedText(plugin.name, locale) || plugin.id
    try {
      const result = await pluginsApi.update(plugin.id)
      if (!mountedRef.current) return
      pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.updateNoticeTitle'),
        body: t('plugins.package.updateNoticeBody', {
          name: displayName,
          detail: formatUpdateResultDetail(result, t),
        }),
      })
      handlePackageChanged()
    } catch (err) {
      if (!mountedRef.current) return
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('plugins.package.updateFailedNoticeTitle'),
        body: t('plugins.package.updateNoticeBody', {
          name: displayName,
          detail: pluginPackageErrorText(err, t('plugins.package.action.update'), t),
        }),
      })
    } finally {
      updatingRef.current.delete(plugin.id)
      if (mountedRef.current) {
        setUpdatingIds(new Set(updatingRef.current))
      }
    }
  }

  const handleUpdateAll = async (): Promise<void> => {
    if (batchRunningRef.current || updatingRef.current.size > 0) return
    const targets = listManagedPlugins(plugins)
    if (targets.length === 0) return
    batchRunningRef.current = true
    let updated = 0
    let unchanged = 0
    const failures: string[] = []
    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (!mountedRef.current) break
        const target = targets[i]!
        updatingRef.current.add(target.id)
        setUpdatingIds(new Set(updatingRef.current))
        setBatchUpdate({ current: i + 1, total: targets.length })
        try {
          const result = await pluginsApi.update(target.id)
          if (result.changed) updated += 1
          else unchanged += 1
        } catch (err) {
          const displayName = resolveLocalizedText(target.name, locale) || target.id
          failures.push(`${displayName}: ${pluginPackageErrorText(err, t('plugins.package.action.update'), t)}`)
        } finally {
          updatingRef.current.delete(target.id)
          if (mountedRef.current) {
            setUpdatingIds(new Set(updatingRef.current))
          }
        }
      }
      if (!mountedRef.current) return
      handlePackageChanged()
      const summary = formatBatchUpdateSummary({ updated, unchanged, failed: failures.length }, t)
      pushNotice({
        type: 'notification',
        level: failures.length > 0 ? 'error' : 'info',
        title: failures.length > 0 ? t('plugins.package.updateAllPartialTitle') : t('plugins.package.updateAllDoneTitle'),
        body: failures.length > 0 ? `${summary} (${failures.join('; ')})` : summary,
      })
    } finally {
      batchRunningRef.current = false
      if (mountedRef.current) {
        setBatchUpdate(null)
      }
    }
  }

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () =>
      centerTab === 'core'
        ? {
            kind: 'plugins',
            tab: 'core',
            ...(selectedCoreOwnerId !== undefined ? { coreOwner: selectedCoreOwnerId } : {}),
            ...(selectedCoreActionId !== undefined ? { coreAction: selectedCoreActionId } : {}),
          }
        : { kind: 'plugins', ...(selectedPluginId !== undefined ? { pluginId: selectedPluginId } : {}) },
  })

  return (
    <SystemCenterShell
      dataView="plugin-center"
      isSplit={isSplit}
      isSplitActive={isSplitActive}
      onCloseSplit={onCloseSplit}
      onToggleSplit={toggleSplit}
      icon="puzzle"
      title={t('plugins.center.title')}
      wrapContent={false}
      headerActions={
        centerTab === 'plugins' ? (
          <>
            {managedPlugins.length > 0 && (
              <Button
                size="sm"
                icon={<HelmxIcon name="refresh-cw" size={12} className={batchUpdate !== null ? 'spin' : undefined} />}
                disabled={batchUpdate !== null || updatingIds.size > 0}
                title={t('plugins.center.updateAllTitle')}
                aria-label={t('plugins.center.updateAllAria')}
                onClick={() => void handleUpdateAll()}
              >
                <span className="pane-action-label">
                  {batchUpdate !== null
                    ? t('plugins.center.updatingAllProgress', { current: batchUpdate.current, total: batchUpdate.total })
                    : t('plugins.center.updateAll', { count: managedPlugins.length })}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              icon="download"
              title={t('plugins.center.installTitle')}
              aria-label={t('plugins.installPlugin')}
              onClick={() => setInstallOpen(true)}
            >
              <span className="pane-action-label">{t('plugins.installPlugin')}</span>
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            icon={<HelmxIcon name="refresh-cw" size={12} className={refreshingCore ? 'spin' : undefined} />}
            disabled={refreshingCore}
            title={t('plugins.center.refreshCoreTitle')}
            onClick={() => void handleRefreshCore()}
          >
            <span className="pane-action-label">{t('common.refresh')}</span>
          </Button>
        )
      }
      belowTopbar={
        <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-tabs">
          <TabsList aria-label={t('plugins.center.viewsAria')}>
            <TabsTrigger value="plugins" className="model-center-tab-btn">
              <HelmxIcon name="puzzle" size={13} />
              <span>{t('plugins.center.tabPlugins')}</span>
            </TabsTrigger>
            <TabsTrigger value="core" className="model-center-tab-btn">
              <HelmxIcon name="shield" size={13} />
              <span>{t('plugins.center.tabCore')}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
      overlays={
        <>
          <PluginDetailDrawer
            plugin={selectedPlugin}
            open={isDrawerOpen}
            onClose={() => openPluginTarget(undefined)}
            onToggleEnabled={(plugin: PluginSummary, targetEnabled?: boolean, options?: { force?: boolean }) =>
              handleTogglePlugin(plugin, targetEnabled, options)
            }
            toggling={togglingId === selectedPlugin?.id}
            externalUpdating={batchUpdate !== null || (selectedPlugin ? updatingIds.has(selectedPlugin.id) : false)}
            onPackageChanged={handlePackageChanged}
            onRemoved={() => openPluginTarget(undefined)}
            inline={inlineDrawer}
            skills={skills}
            onOpenSkill={handleOpenSkill}
          />
          <CoreCapabilityDetailDrawer
            owner={selectedCoreOwner}
            open={isCoreDrawerOpen}
            selectedActionId={selectedCoreActionId}
            onClose={() => openCoreTarget(undefined)}
            onSelectAction={(actionId) => {
              if (selectedCoreOwner) openCoreTarget(selectedCoreOwner.id, actionId)
            }}
            onOpenSkill={handleOpenSkill}
            inline={inlineDrawer}
          />
          <PluginInstallModal
            open={installOpen}
            onClose={() => setInstallOpen(false)}
            onInstalled={handleInstalled}
            inline={inlineDrawer}
          />
        </>
      }
    >
      <Tabs value={centerTab} onValueChange={handleTabChange} className="model-center-main-tabs">
        <TabsContent value="plugins" className="primary-center-content">
          <SystemCenterToolbar
            className="model-toolbar-inline"
            controlsId={pluginsPanelId}
            query={query}
            onQueryChange={setQuery}
            searchPlaceholder={t('plugins.center.searchPlaceholder')}
            searchAriaLabel={t('plugins.center.searchAria')}
            clearSearchLabel={t('plugins.center.clearSearch')}
            filterAriaLabel={t('plugins.center.filterAria')}
            pills={pills}
            activePill={statusFilter}
            onSelectPill={setStatusFilter}
          />
          <div id={pluginsPanelId} role="tabpanel">
            {filteredPlugins.length > 0 ? (
              <CardGrid minWidth="md" gap="md">
                {filteredPlugins.map((plugin) => (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    selected={selectedPluginId === plugin.id}
                    onSelect={() => openPluginTarget(plugin.id)}
                    onToggle={(enabled) => handleTogglePlugin(plugin, enabled)}
                    toggling={togglingId === plugin.id}
                    onUpdate={plugin.managed !== undefined ? () => handleUpdateSingle(plugin) : undefined}
                    updating={updatingIds.has(plugin.id)}
                    updateDisabled={batchUpdate !== null || updatingIds.size > 0}
                  />
                ))}
              </CardGrid>
            ) : (
              <EmptyState
                prominent
                icon="search"
                title={t('plugins.center.emptyTitle')}
                hint={t('plugins.center.emptyHint')}
                hintSubtle
                action={
                  Boolean(query) || statusFilter !== 'all' ? (
                    <Button
                      size="sm"
                      icon="rotate-ccw"
                      onClick={() => {
                        setQuery('')
                        setStatusFilter('all')
                      }}
                    >
                      {t('plugins.center.resetSearch')}
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="core" className="primary-center-content">
          <SystemCenterToolbar
            className="model-toolbar-inline"
            controlsId={corePanelId}
            query={coreQuery}
            onQueryChange={setCoreQuery}
            searchPlaceholder={t('plugins.core.searchPlaceholder')}
            searchAriaLabel={t('plugins.core.searchAria')}
            clearSearchLabel={t('plugins.core.clearSearch')}
            filterAriaLabel={t('plugins.core.filterAria')}
            pills={corePills}
            activePill={coreFilter}
            onSelectPill={setCoreFilter}
          />
          <div id={corePanelId} role="tabpanel">
            {filteredCoreOwners.length > 0 ? (
              <CardGrid minWidth="md" gap="md">
                {filteredCoreOwners.map((owner) => (
                  <CoreCapabilityCard
                    key={owner.id}
                    owner={owner}
                    selected={selectedCoreOwnerId === owner.id}
                    onSelect={() => openCoreTarget(owner.id)}
                  />
                ))}
              </CardGrid>
            ) : (
              <EmptyState
                prominent
                icon="search"
                title={t('plugins.core.emptyTitle')}
                hint={t('plugins.core.emptyHint')}
                hintSubtle
                action={
                  Boolean(coreQuery) || coreFilter !== 'all' ? (
                    <Button
                      size="sm"
                      icon="rotate-ccw"
                      onClick={() => {
                        setCoreQuery('')
                        setCoreFilter('all')
                      }}
                    >
                      {t('plugins.center.resetSearch')}
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </SystemCenterShell>
  )
}
