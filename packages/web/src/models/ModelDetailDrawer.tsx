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
} from '@helmx/ui'
import { useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  isProviderFilterEligible,
  parseCustomModelIds,
  validateCustomGatewayInput,
  type ProviderItem,
  type ProviderModelItem,
} from './model-center-model.js'
import {
  ProviderCredentialsSection,
  type ProviderCredentialsFormState,
  type ProviderTestResult,
} from './ProviderCredentialsSection.js'
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

interface ProviderDrawerDraft extends ProviderCredentialsFormState {
  models: ProviderModelItem[]
}

interface ProviderAsyncState {
  testing: boolean
  refreshingCatalog: boolean
  saving: boolean
  deleting: boolean
  testResult: ProviderTestResult | null
  saveError: string | null
}

type ProviderOpKind = 'test' | 'refresh' | 'del' | 'save'
type ProviderBusyFlag = 'testing' | 'refreshingCatalog' | 'deleting' | 'saving'

/** 在途操作代数令牌：scope 切换或同 kind 新操作递增代数，旧令牌随即失效。 */
interface ProviderOpToken {
  kind: ProviderOpKind
  seq: number
  scopeGen: number
}

const INITIAL_ASYNC_STATE: ProviderAsyncState = {
  testing: false,
  refreshingCatalog: false,
  saving: false,
  deleting: false,
  testResult: null,
  saveError: null,
}

function createInitialProviderDraft(
  provider: ProviderItem | null,
  isNewCustom: boolean,
): ProviderDrawerDraft {
  if (isNewCustom || !provider) {
    return {
      customId: '',
      customLabel: '',
      customProtocol: 'openai',
      customModelsText: '',
      apiKey: '',
      baseUrl: '',
      models: [],
    }
  }
  return {
    customId: provider.id,
    customLabel: provider.name ?? '',
    customProtocol: provider.protocol ?? 'openai',
    customModelsText: (provider.gatewayModels ?? provider.models?.map((m) => m.id) ?? []).join('\n'),
    apiKey: '',
    baseUrl: provider.baseUrl ?? '',
    models: provider.models ? provider.models.map((m) => ({ ...m })) : [],
  }
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
  const providerId = provider?.id
  const providerRef = useRef(provider)
  providerRef.current = provider

  const [draft, setDraft] = useState<ProviderDrawerDraft>(() =>
    createInitialProviderDraft(provider, isNewCustom),
  )
  const [asyncState, setAsyncState] = useState<ProviderAsyncState>(INITIAL_ASYNC_STATE)
  const [confirmDialog, setConfirmDialog] = useState<'none' | 'credential' | 'gateway'>('none')
  const [catalogView, setCatalogView] = useState<{ filter: string; expanded: boolean }>({
    filter: '',
    expanded: false,
  })

  const mountedRef = useRef(true)
  const scopeGenRef = useRef(0)
  const opGenRef = useRef({ test: 0, refresh: 0, del: 0, save: 0 })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const endpointEditable = isNewCustom || provider?.custom === true
  const canTestConnection = Boolean(!isNewCustom && provider && (onTestConnection || provider.dynamic))
  const filterEligible = isProviderFilterEligible(provider, catalogModels)

  // Reset form ONLY on open transition, provider ID switch, or create-mode switch
  // so background SSE refreshes of the same provider never wipe unsaved user edits.
  useEffect(() => {
    scopeGenRef.current += 1
    setConfirmDialog('none')
    setAsyncState(INITIAL_ASYNC_STATE)
    if (!open) return
    setDraft(createInitialProviderDraft(providerRef.current, isNewCustom))
    setCatalogView({ filter: '', expanded: false })
  }, [open, providerId, isNewCustom])

  // 代数令牌：scope 切换（打开/切供应商/切新建）或同 kind 新操作都会让旧令牌失效，
  // 迟到响应一律丢弃；失败落 saveError 与忙态收尾统一经 reportOpError / settleOp。
  const beginOp = useCallback((kind: ProviderOpKind): ProviderOpToken => {
    const scopeGen = scopeGenRef.current
    return { kind, seq: ++opGenRef.current[kind], scopeGen }
  }, [])

  const isCurrentOp = useCallback(
    (op: ProviderOpToken): boolean =>
      mountedRef.current && scopeGenRef.current === op.scopeGen && opGenRef.current[op.kind] === op.seq,
    [],
  )

  const reportOpError = useCallback(
    (op: ProviderOpToken, err: unknown): void => {
      if (!isCurrentOp(op)) return
      setAsyncState((prev) => ({ ...prev, saveError: err instanceof Error ? err.message : String(err) }))
    },
    [isCurrentOp],
  )

  const settleOp = useCallback(
    (op: ProviderOpToken, busy: ProviderBusyFlag): void => {
      if (!isCurrentOp(op)) return
      setAsyncState((prev) => ({ ...prev, [busy]: false }))
    },
    [isCurrentOp],
  )

  const updateForm = useCallback((patch: Partial<ProviderCredentialsFormState>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }, [])

  const handleToggleModel = (modelId: string) => {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.map((item) =>
        item.id === modelId ? { ...item, enabled: !item.enabled } : item,
      ),
    }))
  }

  const handleSelectAll = (matchedIds: ReadonlySet<string> | null) => {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: true } : item,
      ),
    }))
  }

  const handleClearAll = (matchedIds: ReadonlySet<string> | null) => {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.map((item) =>
        matchedIds === null || matchedIds.has(item.id) ? { ...item, enabled: false } : item,
      ),
    }))
  }

  const handleTest = async () => {
    if (!provider || !canTestConnection) return
    const op = beginOp('test')
    setAsyncState((prev) => ({ ...prev, testing: true, testResult: null, saveError: null }))
    try {
      let nextResult: ProviderTestResult | null = null
      if (onTestConnection) {
        nextResult = await onTestConnection(provider.id, draft.baseUrl.trim() || undefined)
      } else if (provider.dynamic) {
        const start = Date.now()
        const res = await assetsApi.refreshModels([provider.id])
        const latencyMs = Date.now() - start
        const refreshError = res.errors?.[provider.id]
        nextResult = refreshError
          ? { success: false, latencyMs, message: t('models.test.failed', { error: refreshError }) }
          : { success: true, latencyMs, message: t('models.test.ok') }
      }
      if (!isCurrentOp(op)) return
      setAsyncState((prev) => ({ ...prev, testResult: nextResult }))
    } catch (err) {
      reportOpError(op, err)
    } finally {
      settleOp(op, 'testing')
    }
  }

  const handleRefreshCatalog = async () => {
    if (!provider) return
    const op = beginOp('refresh')
    setAsyncState((prev) => ({ ...prev, refreshingCatalog: true, saveError: null }))
    try {
      const res = await assetsApi.refreshModels([provider.id])
      if (!isCurrentOp(op)) return
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      if (!isCurrentOp(op)) return
      const refreshError = res.errors?.[provider.id]
      if (refreshError) {
        setAsyncState((prev) => ({ ...prev, saveError: refreshError }))
      } else if (res.aborted) {
        setAsyncState((prev) => ({ ...prev, saveError: t('models.refresh.cancelled') }))
      } else {
        actions?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: t('models.notice.catalogRefreshed'),
          body: t('models.notice.catalogResynced', { name: provider.name }),
        })
      }
    } catch (err) {
      reportOpError(op, err)
    } finally {
      settleOp(op, 'refreshingCatalog')
    }
  }

  const handleDeleteCredential = async () => {
    if (!provider) return
    const op = beginOp('del')
    setAsyncState((prev) => ({ ...prev, deleting: true, saveError: null }))
    try {
      await assetsApi.deleteCredential(provider.id)
      if (!isCurrentOp(op)) return
      setDraft((prev) => ({ ...prev, apiKey: '' }))
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      if (!isCurrentOp(op)) return
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.notice.secretDeleted'),
        body: t('models.notice.secretDeletedBody', { name: provider.name }),
      })
      setConfirmDialog('none')
    } catch (err) {
      reportOpError(op, err)
    } finally {
      settleOp(op, 'deleting')
    }
  }

  const handleDeleteCustomGateway = async () => {
    if (!provider || provider.custom !== true || !onDeleteCustomGateway) return
    const op = beginOp('del')
    setAsyncState((prev) => ({ ...prev, deleting: true, saveError: null }))
    try {
      await onDeleteCustomGateway(provider.id)
      if (!isCurrentOp(op)) return
      setConfirmDialog('none')
    } catch (err) {
      reportOpError(op, err)
    } finally {
      settleOp(op, 'deleting')
    }
  }

  const handleSaveProvider = async () => {
    const op = beginOp('save')

    if (isNewCustom) {
      const validationError = validateCustomGatewayInput(
        {
          id: draft.customId,
          baseUrl: draft.baseUrl,
          modelsText: draft.customModelsText,
          isNew: true,
          existingIds: existingProviderIds,
        },
        t,
      )
      if (validationError !== null) {
        setAsyncState((prev) => ({ ...prev, saveError: validationError }))
        return
      }
      if (!onCreateCustomGateway) return
      setAsyncState((prev) => ({ ...prev, saving: true, saveError: null }))
      try {
        await onCreateCustomGateway({
          id: draft.customId.trim().toLowerCase(),
          label: draft.customLabel.trim() || undefined,
          protocol: draft.customProtocol,
          baseUrl: draft.baseUrl.trim(),
          models: parseCustomModelIds(draft.customModelsText),
          apiKey: draft.apiKey.trim() ? draft.apiKey.trim() : undefined,
        })
      } catch (err) {
        reportOpError(op, err)
      } finally {
        settleOp(op, 'saving')
      }
      return
    }

    if (!provider) return
    if (provider.custom === true) {
      const validationError = validateCustomGatewayInput(
        {
          id: provider.id,
          baseUrl: draft.baseUrl,
          modelsText: draft.customModelsText,
          isNew: false,
        },
        t,
      )
      if (validationError !== null) {
        setAsyncState((prev) => ({ ...prev, saveError: validationError }))
        return
      }
    }

    setAsyncState((prev) => ({ ...prev, saving: true, saveError: null }))
    try {
      if (onSave) {
        await onSave(provider.id, {
          apiKey: draft.apiKey.trim() ? draft.apiKey.trim() : undefined,
          baseUrl: draft.baseUrl.trim() ? draft.baseUrl.trim() : undefined,
          ...(provider.custom === true
            ? {
                label: draft.customLabel.trim(),
                protocol: draft.customProtocol,
                customModelIds: parseCustomModelIds(draft.customModelsText),
              }
            : {}),
          ...(filterEligible ? { models: draft.models } : {}),
        })
      } else if (draft.apiKey.trim()) {
        await assetsApi.setCredential(provider.id, draft.apiKey.trim())
        if (!isCurrentOp(op)) return
        if (actions?.refreshAssets) {
          await actions.refreshAssets()
        }
        actions?.pushNotice?.({
          type: 'notification',
          level: 'info',
          title: t('models.notice.providerUpdated'),
          body: t('models.notice.providerUpdatedBody', { providerId: provider.id }),
        })
      }
    } catch (err) {
      reportOpError(op, err)
    } finally {
      settleOp(op, 'saving')
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
              {asyncState.saveError && (
                <Callout tone="err">
                  <span className="callout-text" role="alert">{asyncState.saveError}</span>
                </Callout>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={asyncState.saving}
              onClick={handleSaveProvider}
              disabled={!isNewCustom && !provider}
            >
              {asyncState.saving
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
              hasDeleteCustomGateway={onDeleteCustomGateway !== undefined}
              form={draft}
              status={{
                testing: asyncState.testing,
                refreshingCatalog: asyncState.refreshingCatalog,
                deleting: asyncState.deleting,
                testResult: asyncState.testResult,
              }}
              actions={{
                onFormChange: updateForm,
                onRefreshCatalog: () => void handleRefreshCatalog(),
                onTest: () => void handleTest(),
                onRequestDeleteCredential: () => setConfirmDialog('credential'),
                onRequestDeleteGateway: () => setConfirmDialog('gateway'),
                onOpenPluginSettings: actions !== null
                  ? (pid) => actions.openTarget({ kind: 'plugins', pluginId: pid })
                  : undefined,
              }}
            />

            {!isNewCustom && provider && (
              <ProviderModelChipsSection
                provider={provider}
                models={draft.models}
                filterEligible={filterEligible}
                modelFilter={catalogView.filter}
                isExpanded={catalogView.expanded}
                onModelFilterChange={(filter) => setCatalogView((prev) => ({ ...prev, filter }))}
                onToggleExpanded={() =>
                  setCatalogView((prev) => ({ ...prev, expanded: !prev.expanded }))
                }
                onToggleModel={handleToggleModel}
                onSelectAll={handleSelectAll}
                onClearAll={handleClearAll}
              />
            )}
          </>
        )}
      </DetailDrawer>

      <ConfirmDialog
        open={confirmDialog === 'credential'}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmDialog('none')
        }}
        title={t('models.confirm.title')}
        description={t('models.confirm.body', {
          name: provider?.name ?? t('models.confirm.thisProvider'),
        })}
        confirmText={t('models.confirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={handleDeleteCredential}
        onCancel={() => setConfirmDialog('none')}
      />

      <ConfirmDialog
        open={confirmDialog === 'gateway'}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmDialog('none')
        }}
        title={t('models.custom.deleteConfirmTitle')}
        description={t('models.custom.deleteConfirmBody', {
          name: provider?.name ?? provider?.id ?? t('models.confirm.thisProvider'),
        })}
        confirmText={t('models.confirm.confirm')}
        cancelText={t('common.cancel')}
        danger
        inline={inline}
        onConfirm={handleDeleteCustomGateway}
        onCancel={() => setConfirmDialog('none')}
      />
    </>
  )
}
