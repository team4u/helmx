import React, { useMemo } from 'react'
import {
  Button,
  Callout,
  Card,
  Field,
  HelmxIcon,
  Input,
  Select,
  Stack,
  Textarea,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { ProviderItem } from './model-center-model.js'

export interface ProviderTestResult {
  success: boolean
  latencyMs?: number
  message?: string
}

export interface ProviderCredentialsFormState {
  customId: string
  customLabel: string
  customProtocol: 'openai' | 'anthropic'
  customModelsText: string
  apiKey: string
  baseUrl: string
}

export interface ProviderCredentialsStatus {
  testing: boolean
  refreshingCatalog: boolean
  deleting: boolean
  testResult: ProviderTestResult | null
}

export interface ProviderCredentialsActions {
  onFormChange: (patch: Partial<ProviderCredentialsFormState>) => void
  onRefreshCatalog: () => void
  onTest: () => void
  onRequestDeleteCredential: () => void
  onRequestDeleteGateway: () => void
  onOpenPluginSettings?: (pluginId: string) => void
}

export interface ProviderCredentialsSectionProps {
  provider: ProviderItem | null
  isNewCustom: boolean
  endpointEditable: boolean
  canTestConnection: boolean
  inline: boolean
  hasDeleteCustomGateway: boolean
  form: ProviderCredentialsFormState
  status: ProviderCredentialsStatus
  actions: ProviderCredentialsActions
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
  hasDeleteCustomGateway,
  form,
  status,
  actions,
}: ProviderCredentialsSectionProps): React.JSX.Element {
  const { t } = useWebLocale()
  const { customId, customLabel, customProtocol, customModelsText, apiKey, baseUrl } = form
  const { testing, refreshingCatalog, deleting, testResult } = status
  const {
    onFormChange,
    onRefreshCatalog,
    onTest,
    onRequestDeleteCredential,
    onRequestDeleteGateway,
    onOpenPluginSettings,
  } = actions

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
    <Card
      variant="subtle"
      title={
        <Stack direction="horizontal" gap="xs" align="center" inline>
          <HelmxIcon name="key" size={14} />
          <span>{t('models.drawer.credentialsSection')}</span>
        </Stack>
      }
      actions={
        !isNewCustom && provider?.dynamic ? (
          <Button
            variant="ghost"
            size="xs"
            icon={<HelmxIcon name="refresh-cw" size={12} className={refreshingCatalog ? 'spin' : undefined} />}
            onClick={onRefreshCatalog}
            disabled={refreshingCatalog}
            title={t('models.drawer.resyncTitle')}
          >
            {refreshingCatalog ? t('models.refreshing') : t('models.refreshCatalog')}
          </Button>
        ) : undefined
      }
    >
      <Stack direction="vertical" gap="md">
        {isNewCustom && (
          <Field
            label={t('models.custom.idLabel')}
            htmlFor="model-drawer-custom-id"
            required
            layout="horizontal"
          >
            <Input
              mono
              value={customId}
              onChange={(e) => onFormChange({ customId: e.target.value })}
              placeholder={t('models.custom.idPlaceholder')}
              autoComplete="off"
            />
          </Field>
        )}

        {endpointEditable && (
          <>
            <Field
              label={t('models.custom.labelLabel')}
              htmlFor="model-drawer-custom-label"
              layout="horizontal"
            >
              <Input
                value={customLabel}
                onChange={(e) => onFormChange({ customLabel: e.target.value })}
                placeholder={t('models.custom.labelPlaceholder')}
                autoComplete="off"
              />
            </Field>

            <Field
              label={t('models.custom.protocolLabel')}
              htmlFor="model-drawer-custom-protocol"
              layout="horizontal"
            >
              <Select
                value={customProtocol}
                options={protocolOptions}
                inline={inline}
                onChange={(e) =>
                  onFormChange({
                    customProtocol: e.target.value === 'anthropic' ? 'anthropic' : 'openai',
                  })
                }
              />
            </Field>
          </>
        )}

        {!isNewCustom && provider?.pluginId ? (
          <Field
            label={t('models.apiKey')}
            htmlFor={false}
            hint={t('models.apiKey.pluginManagedHint')}
            layout="horizontal"
          >
            <Stack direction="vertical" gap="xs">
              <div className="provider-readonly-value" title={t('models.apiKey.pluginKeyTitle')}>
                {t('models.apiKey.pluginManaged', { pluginId: provider.pluginId })}
              </div>
              {onOpenPluginSettings !== undefined ? (
                <div>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon="puzzle"
                    onClick={() => onOpenPluginSettings(provider.pluginId!)}
                  >
                    {t('models.plugin.openSettings', { pluginId: provider.pluginId })}
                  </Button>
                </div>
              ) : null}
            </Stack>
          </Field>
        ) : (
          <Field
            label={t('models.apiKey')}
            htmlFor="model-drawer-api-key"
            hint={t('models.apiKey.secretHint')}
            layout="horizontal"
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => onFormChange({ apiKey: e.target.value })}
              placeholder={
                !isNewCustom && provider?.configured
                  ? t('models.apiKey.placeholderConfigured')
                  : t('models.apiKey.placeholderEnter')
              }
              autoComplete="off"
            />
          </Field>
        )}

        {endpointEditable ? (
          <Field
            label={t('models.endpoint')}
            htmlFor="model-drawer-base-url"
            hint={endpointHint}
            required
            layout="horizontal"
          >
            <Input
              mono
              value={baseUrl}
              onChange={(e) => onFormChange({ baseUrl: e.target.value })}
              placeholder={
                provider?.baseUrl ||
                (provider?.type === 'local'
                  ? 'http://127.0.0.1:11434'
                  : t('models.endpoint.defaultUrlPlaceholder'))
              }
            />
          </Field>
        ) : (
          <Field
            label={t('models.endpoint')}
            htmlFor={false}
            hint={endpointHint}
            layout="horizontal"
          >
            <div className="provider-readonly-value mono break-word selectable" title={t('models.endpoint.readOnlyTitle')}>
              {provider?.baseUrl || '—'}
            </div>
          </Field>
        )}

        {endpointEditable && (
          <Field
            label={t('models.custom.modelsLabel')}
            htmlFor="model-drawer-custom-models"
            hint={t('models.custom.modelsHint')}
            required
            layout="horizontal"
          >
            <Textarea
              mono
              rows={4}
              value={customModelsText}
              onChange={(e) => onFormChange({ customModelsText: e.target.value })}
              placeholder={t('models.custom.modelsPlaceholder')}
            />
          </Field>
        )}
      </Stack>

      {/* Connectivity test and destructive actions */}
      {!isNewCustom && provider && (canTestConnection || provider.configured || (provider.custom === true && hasDeleteCustomGateway)) && (
        <Stack direction="horizontal" gap="sm" align="center" justify="between" wrap>
          <Stack direction="horizontal" gap="sm" align="center">
            {canTestConnection && (
              <Button
                size="sm"
                icon="activity"
                pending={testing}
                onClick={onTest}
              >
                {testing ? t('models.test.testing') : t('models.test.action')}
              </Button>
            )}
          </Stack>

          <Stack direction="horizontal" gap="sm" align="center">
            {provider.configured && !provider.pluginId && (
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                className="text-err"
                onClick={onRequestDeleteCredential}
                disabled={deleting}
              >
                {t('models.credentials.delete')}
              </Button>
            )}
            {provider.custom === true && hasDeleteCustomGateway && (
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                className="text-err"
                onClick={onRequestDeleteGateway}
                disabled={deleting}
              >
                {t('models.custom.deleteAction')}
              </Button>
            )}
          </Stack>
        </Stack>
      )}

      {testResult && (
        <Callout tone={testResult.success ? 'ok' : 'err'}>
          <span
            className="callout-text selectable"
            role={testResult.success ? 'status' : 'alert'}
          >
            {testResult.message}
            {testResult.latencyMs !== undefined &&
              t('models.test.latency', { ms: testResult.latencyMs })}
          </span>
        </Callout>
      )}
    </Card>
  )
}
