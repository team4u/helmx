import React, { useMemo } from 'react'
import { HelmxIcon, Select } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { ProviderItem } from './model-center-model.js'

export interface ProviderTestResult {
  success: boolean
  latencyMs?: number
  message?: string
}

export interface ProviderCredentialsSectionProps {
  provider: ProviderItem | null
  isNewCustom: boolean
  endpointEditable: boolean
  canTestConnection: boolean
  inline: boolean
  customId: string
  customLabel: string
  customProtocol: 'openai' | 'anthropic'
  customModelsText: string
  apiKey: string
  baseUrl: string
  testing: boolean
  refreshingCatalog: boolean
  deleting: boolean
  testResult: ProviderTestResult | null
  canOpenPluginSettings: boolean
  hasDeleteCustomGateway: boolean
  onCustomIdChange: (value: string) => void
  onCustomLabelChange: (value: string) => void
  onCustomProtocolChange: (value: 'openai' | 'anthropic') => void
  onCustomModelsTextChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onBaseUrlChange: (value: string) => void
  onRefreshCatalog: () => void
  onTest: () => void
  onRequestDeleteCredential: () => void
  onRequestDeleteGateway: () => void
  onOpenPluginSettings: (pluginId: string) => void
}

/**
 * Provider credentials, custom-gateway endpoint/protocol/models form,
 * connectivity test action, and destructive action triggers inside ModelDetailDrawer.
 */
export function ProviderCredentialsSection({
  provider,
  isNewCustom,
  endpointEditable,
  canTestConnection,
  inline,
  customId,
  customLabel,
  customProtocol,
  customModelsText,
  apiKey,
  baseUrl,
  testing,
  refreshingCatalog,
  deleting,
  testResult,
  canOpenPluginSettings,
  hasDeleteCustomGateway,
  onCustomIdChange,
  onCustomLabelChange,
  onCustomProtocolChange,
  onCustomModelsTextChange,
  onApiKeyChange,
  onBaseUrlChange,
  onRefreshCatalog,
  onTest,
  onRequestDeleteCredential,
  onRequestDeleteGateway,
  onOpenPluginSettings,
}: ProviderCredentialsSectionProps): React.JSX.Element {
  const { t } = useWebLocale()

  const endpointHint =
    endpointEditable === true
      ? t('models.endpoint.hintCustom')
      : provider?.pluginId
        ? t('models.endpoint.hintPlugin', { pluginId: provider.pluginId })
        : t('models.endpoint.hintBuiltIn')

  const protocolOptions = useMemo(
    () => [
      { value: 'openai', label: t('models.custom.protocolOpenai') },
      { value: 'anthropic', label: t('models.custom.protocolAnthropic') },
    ],
    [t],
  )

  return (
    <div className="section-flat">
      <div className="section-flat-header flex-row-between">
        <div className="flex-row">
          <HelmxIcon name="key" size={14} />
          <span className="section-flat-title">{t('models.drawer.credentialsSection')}</span>
        </div>
        {!isNewCustom && provider?.dynamic && (
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={onRefreshCatalog}
            disabled={refreshingCatalog}
            title={t('models.drawer.resyncTitle')}
          >
            <HelmxIcon
              name="refresh-cw"
              size={12}
              className={refreshingCatalog ? 'spin' : ''}
            />
            <span>{refreshingCatalog ? t('models.refreshing') : t('models.refreshCatalog')}</span>
          </button>
        )}
      </div>
      <div className="form-grid">
        {isNewCustom && (
          <>
            <label htmlFor="model-drawer-custom-id" className="form-grid-label">
              {t('models.custom.idLabel')}
            </label>
            <div className="flex-col-xs">
              <input
                id="model-drawer-custom-id"
                type="text"
                className="input mono"
                value={customId}
                onChange={(e) => onCustomIdChange(e.target.value)}
                placeholder={t('models.custom.idPlaceholder')}
                autoComplete="off"
              />
            </div>
          </>
        )}

        {endpointEditable && (
          <>
            <label htmlFor="model-drawer-custom-label" className="form-grid-label">
              {t('models.custom.labelLabel')}
            </label>
            <div className="flex-col-xs">
              <input
                id="model-drawer-custom-label"
                type="text"
                className="input"
                value={customLabel}
                onChange={(e) => onCustomLabelChange(e.target.value)}
                placeholder={t('models.custom.labelPlaceholder')}
                autoComplete="off"
              />
            </div>

            <label htmlFor="model-drawer-custom-protocol" className="form-grid-label">
              {t('models.custom.protocolLabel')}
            </label>
            <div className="flex-col-xs">
              <Select
                id="model-drawer-custom-protocol"
                value={customProtocol}
                options={protocolOptions}
                inline={inline}
                onChange={(e) =>
                  onCustomProtocolChange(e.target.value === 'anthropic' ? 'anthropic' : 'openai')
                }
              />
            </div>
          </>
        )}

        <label htmlFor="model-drawer-api-key" className="form-grid-label">
          {t('models.apiKey')}
        </label>
        <div className="flex-col-xs">
          {!isNewCustom && provider?.pluginId ? (
            <>
              <div className="form-grid-value" title={t('models.apiKey.pluginKeyTitle')}>
                {t('models.apiKey.pluginManaged', { pluginId: provider.pluginId })}
              </div>
              <span className="text-subtle">
                {t('models.apiKey.pluginManagedHint')}
              </span>
              {canOpenPluginSettings ? (
                <div>
                  <button
                    type="button"
                    className="btn btn-xs btn-secondary"
                    onClick={() => onOpenPluginSettings(provider.pluginId!)}
                  >
                    <HelmxIcon name="puzzle" size={12} />
                    <span>{t('models.plugin.openSettings', { pluginId: provider.pluginId })}</span>
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <input
                id="model-drawer-api-key"
                type="password"
                className="input"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder={
                  !isNewCustom && provider?.configured
                    ? t('models.apiKey.placeholderConfigured')
                    : t('models.apiKey.placeholderEnter')
                }
                autoComplete="off"
              />
              <span className="text-subtle">
                {t('models.apiKey.secretHint')}
              </span>
            </>
          )}
        </div>

        <label htmlFor="model-drawer-base-url" className="form-grid-label">
          {t('models.endpoint')}
        </label>
        <div className="flex-col-xs">
          {endpointEditable ? (
            <input
              id="model-drawer-base-url"
              type="text"
              className="input mono"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder={
                provider?.baseUrl ||
                (provider?.type === 'local'
                  ? 'http://127.0.0.1:11434'
                  : t('models.endpoint.defaultUrlPlaceholder'))
              }
            />
          ) : (
            <div className="form-grid-value mono break-word" title={t('models.endpoint.readOnlyTitle')}>
              {provider?.baseUrl || '—'}
            </div>
          )}
          <span className="text-subtle">{endpointHint}</span>
        </div>

        {endpointEditable && (
          <>
            <label htmlFor="model-drawer-custom-models" className="form-grid-label form-grid-align-start">
              {t('models.custom.modelsLabel')}
            </label>
            <div className="flex-col-xs">
              <textarea
                id="model-drawer-custom-models"
                className="input mono"
                rows={4}
                value={customModelsText}
                onChange={(e) => onCustomModelsTextChange(e.target.value)}
                placeholder={t('models.custom.modelsPlaceholder')}
              />
              <span className="text-subtle">{t('models.custom.modelsHint')}</span>
            </div>
          </>
        )}
      </div>

      {/* Connectivity test and destructive actions */}
      {!isNewCustom && provider && (canTestConnection || provider.configured || (provider.custom === true && hasDeleteCustomGateway)) && (
        <div className="flex-row-between flex-row-wrap">
          <div className="flex-row">
            {canTestConnection && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onTest}
                disabled={testing}
              >
                <HelmxIcon name="activity" size={12} />
                <span>{testing ? t('models.test.testing') : t('models.test.action')}</span>
              </button>
            )}
          </div>

          <div className="flex-row">
            {provider.configured && !provider.pluginId && (
              <button
                type="button"
                className="btn btn-sm btn-ghost text-err"
                onClick={onRequestDeleteCredential}
                disabled={deleting}
              >
                <HelmxIcon name="trash" size={12} />
                <span>{t('models.credentials.delete')}</span>
              </button>
            )}
            {provider.custom === true && hasDeleteCustomGateway && (
              <button
                type="button"
                className="btn btn-sm btn-ghost text-err"
                onClick={onRequestDeleteGateway}
                disabled={deleting}
              >
                <HelmxIcon name="trash" size={12} />
                <span>{t('models.custom.deleteAction')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {testResult && (
        <div
          className={`callout ${testResult.success ? 'callout-ok' : 'callout-error'}`}
          role={testResult.success ? 'status' : 'alert'}
        >
          <HelmxIcon
            name={testResult.success ? 'check' : 'alert-circle'}
            size={13}
          />
          <span className="callout-text selectable">
            {testResult.message}
            {testResult.latencyMs !== undefined &&
              t('models.test.latency', { ms: testResult.latencyMs })}
          </span>
        </div>
      )}
    </div>
  )
}
