import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginSummary } from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ApiClientError, pluginsApi } from '../lib/api.js'
import { useLocationTargets, useOptionalGroupedUi, usePlugins, useStoreActions } from '../lib/store-context.js'
import { SystemCenterEmpty, SystemCenterShell, SystemCenterToolbar } from '../ui/SystemCenterShell.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { PluginCard } from './PluginCard.js'
import { PluginDetailDrawer } from './PluginDetailDrawer.js'
import { PluginInstallModal } from './PluginInstallModal.js'
import {
  filterPlugins,
  pluginStatusTabLabel,
  summarizePlugins,
  type PluginStatusFilter,
} from './plugin-center-model.js'

const PLUGIN_STATUS_TABS: PluginStatusFilter[] = ['all', 'views', 'enabled', 'disabled']

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
  const groupedUi = useOptionalGroupedUi()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { syncPlugins, openTarget, pushNotice } = useStoreActions()
  const { locale, t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<PluginStatusFilter>('all')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshGeneration = useRef(0)

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
  const selectedPluginId = currentTarget?.kind === 'plugins' ? currentTarget.pluginId : undefined
  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  )
  const isDrawerOpen = Boolean(selectedPluginId && selectedPlugin)

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

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'plugins', pluginId: selectedPluginId }),
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
      headerActions={
        <button
          type="button"
          className="btn btn-sm"
          title={t('plugins.center.installTitle')}
          aria-label={t('plugins.installPlugin')}
          onClick={() => setInstallOpen(true)}
        >
          <HelmxIcon name="download" size={12} />
          <span className="pane-action-label">{t('plugins.installPlugin')}</span>
        </button>
      }
      toolbar={
        <SystemCenterToolbar
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
            onPackageChanged={handlePackageChanged}
            onRemoved={() => openPluginTarget(undefined)}
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
      {filteredPlugins.length > 0 ? (
        <div className="primary-center-grid">
          {filteredPlugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              selected={selectedPluginId === plugin.id}
              onSelect={() => openPluginTarget(plugin.id)}
              onToggle={(enabled) => handleTogglePlugin(plugin, enabled)}
              toggling={togglingId === plugin.id}
            />
          ))}
        </div>
      ) : (
        <SystemCenterEmpty
          title={t('plugins.center.emptyTitle')}
          hint={t('plugins.center.emptyHint')}
          hintSubtle
          showReset={Boolean(query) || statusFilter !== 'all'}
          resetLabel={t('plugins.center.resetSearch')}
          onReset={() => {
            setQuery('')
            setStatusFilter('all')
          }}
        />
      )}
    </SystemCenterShell>
  )
}
