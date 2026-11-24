import React, { useCallback, useEffect, useRef, useState } from 'react'
import { assetsApi, type ModelDescriptor } from '../lib/api.js'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  MonoId,
  Stack,
} from '@helmx/plugin-client'
import { useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  isProviderFilterEligible,
  parseCustomModelIds,
  validateCustomGatewayInput,
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'
import { ProviderCredentialsSection, type ProviderTestResult } from './ProviderCredentialsSection.js'
import { ProviderModelChipsSection } from './ProviderModelChipsSection.js'

export interface ProviderSavePayload {
  apiKey?: string
  baseUrl?: string
  label?: string
  protocol?: 'openai' | 'anthropic'
  customModelIds?: string[]
  models?: ProviderModelItem[]
}

export interface CustomGatewayCreateInput {
  id: string
  label?: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  models: string[]
  apiKey?: string
}

export interface ModelDetailDrawerProps {
  provider: ProviderItem | null
  isNewCustom?: boolean
  existingProviderIds?: ReadonlyArray<string>
  open: boolean
  onClose: () => void
  inline?: boolean
  availableModels?: ModelDescriptor[]
  onSave?: (
    providerId: string,
    data: ProviderSavePayload,
  ) => Promise<void> | void
  onCreateCustomGateway?: (input: CustomGatewayCreateInput) => Promise<void> | void
  onDeleteCustomGateway?: (providerId: string) => Promise<void> | void
  onTestConnection?: (
    providerId: string,
    baseUrl?: string,
  ) => Promise<{ success: boolean; latencyMs?: number; message?: string }>
}

/**
 * Provider details & credentials drawer of the Models & Credentials Center:
 * - built on Radix UI Dialog primitives as a 540px right slide-over;
 * - composes ProviderCredentialsSection (credentials/gateway form) and
 *   ProviderModelChipsSection (catalog filter & model chips);
 * - credential and custom-gateway deletion are guarded by ConfirmDialog.
 */
export function ModelDetailDrawer({
  provider,
  isNewCustom = false,
  existingProviderIds = [],
  open,
  onClose,
  inline = false,
  availableModels,
  onSave,
  onCreateCustomGateway,
  onDeleteCustomGateway,
  onTestConnection,
}: ModelDetailDrawerProps): React.JSX.Element {
  const storeModels = useOptionalModels()
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const catalogModels = availableModels ?? storeModels ?? []

  const [customId, setCustomId] = useState('')
  const [customLabel, setCustomLabel] = useState(() => provider?.name ?? '')
  const [customProtocol, setCustomProtocol] = useState<'openai' | 'anthropic'>(() => provider?.protocol ?? 'openai')
  const [customModelsText, setCustomModelsText] = useState(() => (provider?.gatewayModels ?? []).join('\n'))
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(() => provider?.baseUrl ?? '')
  const [models, setModels] = useState<ProviderModelItem[]>(() =>
    provider?.models ? provider.models.map((m) => ({ ...m })) : [],
  )
  const [testing, setTesting] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteGatewayConfirmOpen, setDeleteGatewayConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)

  const saveSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearSaveSuccessTimer = useCallback(() => {
    if (saveSuccessTimerRef.current !== null) {
      clearTimeout(saveSuccessTimerRef.current)
      saveSuccessTimerRef.current = null
    }
  }, [])
  const flashSaveSuccess = useCallback(() => {
    clearSaveSuccessTimer()
    setSaveSuccess(true)
    saveSuccessTimerRef.current = setTimeout(() => {
      saveSuccessTimerRef.current = null
      setSaveSuccess(false)
    }, 2400)
  }, [clearSaveSuccessTimer])

  useEffect(() => clearSaveSuccessTimer, [clearSaveSuccessTimer])

  const endpointEditable = isNewCustom || provider?.custom === true
  const canTestConnection = Boolean(!isNewCustom && provider && (onTestConnection || provider.dynamic))
  const filterEligible = isProviderFilterEligible(provider, catalogModels)

  useEffect(() => {
    clearSaveSuccessTimer()
    if (isNewCustom || !provider) {
      setCustomId('')
      setCustomLabel('')
      setCustomProtocol('openai')
      setCustomModelsText('')
      setApiKey('')
      setBaseUrl('')
      setModels([])
    } else {
      setCustomId(provider.id)
      setCustomLabel(provider.name ?? '')
      setCustomProtocol(provider.protocol ?? 'openai')
      setCustomModelsText(
        (provider.gatewayModels ?? provider.models?.map((m) => m.id) ?? []).join('\n'),
      )
      setApiKey('')
      setBaseUrl(provider.baseUrl ?? '')
      setModels(provider.models ? provider.models.map((m) => ({ ...m })) : [])
    }
    setTestResult(null)
    setSaveError(null)
    setSaveSuccess(false)
    setModelFilter('')
    setIsExpanded(false)
  }, [provider, isNewCustom, clearSaveSuccessTimer])

  const handleToggleModel = (modelId: string) => {
    setModels((prev) =>
      prev.map((item) =>
        item.id === modelId ? { ...item, enabled: !item.enabled } : item,
      ),
    )
  }

  const handleSelectAll = (matchedIds: ReadonlySet<string> | null) => {
    setModels((prev) =>
      prev.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: true } : item,
      ),
    )
  }

  const handleClearAll = (matchedIds: ReadonlySet<string> | null) => {
    setModels((prev) =>
      prev.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: false } : item,
      ),
    )
  }

  const handleTest = async () => {
    if (!provider || !canTestConnection) return
    setTesting(true)
    setTestResult(null)
    setSaveError(null)
    try {
      if (onTestConnection) {
        const res = await onTestConnection(provider.id, baseUrl.trim() || undefined)
        setTestResult(res)
      } else if (provider.dynamic) {
        const start = Date.now()
        const res = await assetsApi.refreshModels([provider.id])
        const latencyMs = Date.now() - start
        const refreshError = res.errors?.[provider.id]
        if (refreshError) {
          setTestResult({
            success: false,
            latencyMs,
            message: t('models.test.failed', { error: refreshError }),
          })
        } else {
          setTestResult({
            success: true,
            latencyMs,
            message: t('models.test.ok'),
          })
        }
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }

  const handleRefreshCatalog = async () => {
    if (!provider) return
    setRefreshingCatalog(true)
    setSaveError(null)
    try {
      const res = await assetsApi.refreshModels([provider.id])
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      const refreshError = res.errors?.[provider.id]
      if (refreshError) {
        setSaveError(refreshError)
      } else if (res.aborted) {
        setSaveError(t('models.refresh.cancelled'))
      } else {
        flashSaveSuccess()
        actions?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: t('models.notice.catalogRefreshed'),
          body: t('models.notice.catalogResynced', { name: provider.name }),
        })
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshingCatalog(false)
    }
  }

  const handleDeleteCredential = async () => {
    if (!provider) return
    setDeleting(true)
    setSaveError(null)
    try {
      await assetsApi.deleteCredential(provider.id)
      setApiKey('')
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.secretDeleted'),
        body: t('models.notice.secretDeletedBody', { name: provider.name }),
      })
      setDeleteConfirmOpen(false)
      flashSaveSuccess()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteCustomGateway = async () => {
    if (!provider || provider.custom !== true || !onDeleteCustomGateway) return
    setDeleting(true)
    setSaveError(null)
    try {
      await onDeleteCustomGateway(provider.id)
      setDeleteGatewayConfirmOpen(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const handleSaveProvider = async () => {
    if (isNewCustom) {
      const validationError = validateCustomGatewayInput(
        {
          id: customId,
          baseUrl,
          modelsText: customModelsText,
          isNew: true,
          existingIds: existingProviderIds,
        },
        t,
      )
      if (validationError !== null) {
        clearSaveSuccessTimer()
        setSaveSuccess(false)
        setSaveError(validationError)
        return
      }
      if (!onCreateCustomGateway) return
      setSaving(true)
      setSaveError(null)
      try {
        await onCreateCustomGateway({
          id: customId.trim().toLowerCase(),
          label: customLabel.trim() || undefined,
          protocol: customProtocol,
          baseUrl: baseUrl.trim(),
          models: parseCustomModelIds(customModelsText),
          apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        })
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
      return
    }

    if (!provider) return
    if (provider.custom === true) {
      const validationError = validateCustomGatewayInput(
        {
          id: provider.id,
          baseUrl,
          modelsText: customModelsText,
          isNew: false,
        },
        t,
      )
      if (validationError !== null) {
        clearSaveSuccessTimer()
        setSaveSuccess(false)
        setSaveError(validationError)
        return
      }
    }
    setSaving(true)
    setSaveError(null)
    try {
      if (onSave) {
        await onSave(provider.id, {
          apiKey: apiKey.trim() ? apiKey.trim() : undefined,
          baseUrl: baseUrl.trim() ? baseUrl.trim() : undefined,
          ...(provider.custom === true
            ? {
                label: customLabel.trim(),
                protocol: customProtocol,
                customModelIds: parseCustomModelIds(customModelsText),
              }
            : {}),
          ...(filterEligible ? { models } : {}),
        })
      } else if (apiKey.trim()) {
        await assetsApi.setCredential(provider.id, apiKey.trim())
        if (actions?.refreshAssets) {
          await actions.refreshAssets()
        }
      }
      flashSaveSuccess()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DetailDrawer
        open={open}
        inline={inline}
        onClose={onClose}
        title={isNewCustom ? t('models.custom.drawerTitle') : (provider?.name || t('models.drawer.titleFallback'))}
        titleClassName="break-word"
        titleExtra={
          isNewCustom ? (
            <Badge tone="neutral">{t('models.customBadge')}</Badge>
          ) : (
            <>
              {provider?.configured ? (
                <Badge tone="ok">{t('models.configured')}</Badge>
              ) : (
                <Badge tone="neutral">{t('models.notConfigured')}</Badge>
              )}
              {provider?.dynamic && <Badge tone="neutral">{t('models.dynamicSyncBadge')}</Badge>}
              {provider?.custom && <Badge tone="neutral">{t('models.customBadge')}</Badge>}
            </>
          )
        }
        meta={!isNewCustom && provider?.id ? <MonoId value={provider.id} /> : undefined}
        metaClassName="text-subtle break-word"
        aria-label={
          isNewCustom
            ? t('models.custom.drawerTitle')
            : provider
              ? t('models.drawer.ariaSelected', { name: provider.name })
              : t('models.drawer.ariaDefault')
        }
        closeLabel={t('common.close')}
        footer={
          <Stack direction="horizontal" gap="sm" align="center" justify="between" className="flex-1">
            <div className="flex-1">
              {saveSuccess && (
                <span className="text-subtle" role="status">
                  {t('models.saveSuccess')}
                </span>
              )}
              {saveError && (
                <Callout tone="err">
                  <span className="callout-text" role="alert">{saveError}</span>
                </Callout>
              )}
            </div>
            <Button
              variant="primary"
              icon="check"
              pending={saving}
              onClick={handleSaveProvider}
              disabled={!isNewCustom && !provider}
            >
              {saving
                ? t('models.saving')
                : isNewCustom
                  ? t('models.custom.createAction')
                  : t('models.saveConfig')}
            </Button>
          </Stack>
        }
      >
        {!isNewCustom && !provider ? (
          <EmptyState title={t('models.drawer.noSelection')} />
        ) : (
          <>
            <ProviderCredentialsSection
              provider={provider}
              isNewCustom={isNewCustom}
              endpointEditable={endpointEditable}
              canTestConnection={canTestConnection}
              inline={inline}
              customId={customId}
              customLabel={customLabel}
              customProtocol={customProtocol}
              customModelsText={customModelsText}
              apiKey={apiKey}
              baseUrl={baseUrl}
              testing={testing}
              refreshingCatalog={refreshingCatalog}
              deleting={deleting}
              testResult={testResult}
              canOpenPluginSettings={actions !== null}
              hasDeleteCustomGateway={onDeleteCustomGateway !== undefined}
              onCustomIdChange={setCustomId}
              onCustomLabelChange={setCustomLabel}
              onCustomProtocolChange={setCustomProtocol}
              onCustomModelsTextChange={setCustomModelsText}
              onApiKeyChange={setApiKey}
              onBaseUrlChange={setBaseUrl}
              onRefreshCatalog={() => void handleRefreshCatalog()}
              onTest={() => void handleTest()}
              onRequestDeleteCredential={() => setDeleteConfirmOpen(true)}
              onRequestDeleteGateway={() => setDeleteGatewayConfirmOpen(true)}
              onOpenPluginSettings={(pluginId) => actions?.openTarget({ kind: 'plugins', pluginId })}
            />

            {!isNewCustom && provider && (
              <ProviderModelChipsSection
                provider={provider}
                models={models}
                filterEligible={filterEligible}
                modelFilter={modelFilter}
                isExpanded={isExpanded}
                onModelFilterChange={setModelFilter}
                onToggleExpanded={() => setIsExpanded((prev) => !prev)}
                onToggleModel={handleToggleModel}
                onSelectAll={handleSelectAll}
                onClearAll={handleClearAll}
              />
            )}
          </>
        )}
      </DetailDrawer>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('models.confirm.title')}
        description={t('models.confirm.body', {
          name: provider?.name ?? t('models.confirm.thisProvider'),
        })}
        confirmText={t('models.confirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={handleDeleteCredential}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

      <ConfirmDialog
        open={deleteGatewayConfirmOpen}
        onOpenChange={setDeleteGatewayConfirmOpen}
        title={t('models.custom.deleteConfirmTitle')}
        description={t('models.custom.deleteConfirmBody', {
          name: provider?.name ?? provider?.id ?? t('models.confirm.thisProvider'),
        })}
        confirmText={t('models.confirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={handleDeleteCustomGateway}
        onCancel={() => setDeleteGatewayConfirmOpen(false)}
      />
    </>
  )
}
