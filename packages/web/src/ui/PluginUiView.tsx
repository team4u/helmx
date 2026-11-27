/**
 * PluginUiView: the unified wrapper for every view-like UI extension point
 * (pure data registrations never pass through this component).
 * - Dynamic compiled client module loading / export validation errors render
 *   explicitly (never a silent blank); ViewBoundary isolates render crashes;
 * - injects a memoized PluginClientContext (usePluginContext) plus protocol-standard
 *   props, and subscribes selectively only to its own pluginId summary so unrelated
 *   plugin changes never cascade-re-render mounted plugin views;
 * - component-function validation: a non-function export fails explicitly.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ClientComponentRef, ComposerController } from '@helmx/protocol/browser'
import { PluginClientContext, PluginScope } from '@helmx/plugin-client'
import { Button, HelmxIcon, LoadingState, ViewBoundary } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { getPluginClientCacheRevision, subscribePluginClientCacheInvalidation } from '../lib/plugin-client.js'
import { usePluginClientHash } from '../lib/store-context.js'
import { usePluginClientComponent } from './use-plugin-client-component.js'

export interface PluginUiViewProps {
  pluginId: string
  /** client.tsx component reference (dangling refs are rejected at the registration boundary; a missing one is a contract violation and fails explicitly). */
  spec: { client?: ClientComponentRef }
  /** Protocol-standard props (screenId / entry / toolView / conversation, etc.). */
  slotProps?: Record<string, unknown>
  /** Conversation context id (omitted for conversation-less slots). */
  conversationId?: number
  /** Composer controller (provided by the host for composer slots only). */
  composer?: ComposerController
  /** ViewBoundary error title. */
  label?: string
}

export function PluginUiView(props: PluginUiViewProps): ReactNode {
  const { pluginId, spec } = props
  const clientRef = spec.client
  const expectedHash = usePluginClientHash(pluginId, clientRef?.module)
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  if (clientRef === undefined) {
    return <MissingTrackError pluginId={pluginId} />
  }
  return (
    <ClientPluginUiView
      key={JSON.stringify([pluginId, clientRef.module, clientRef.export, revision])}
      {...props}
      clientRef={clientRef}
      expectedHash={expectedHash}
    />
  )
}

function ClientPluginUiView({
  pluginId,
  clientRef,
  expectedHash,
  slotProps,
  conversationId,
  composer,
  label,
}: PluginUiViewProps & { clientRef: ClientComponentRef; expectedHash?: string }): ReactNode {
  const { t } = useWebLocale()
  const { ctx, client, retryModule } = usePluginClientComponent<Record<string, unknown>>({
    pluginId,
    clientRef,
    expectedHash,
    conversationId,
    composer,
  })

  if (client.phase === 'loading') {
    return (
      <div className="callout">
        <LoadingState label={t('ui.pluginUi.loading', { pluginId })} iconSize={13} />
      </div>
    )
  }
  if (client.phase === 'error') {
    return (
      <div className="callout callout-error" role="alert">
        <HelmxIcon name="alert-triangle" size={13} />
        <div>
          <strong>{t('ui.pluginUi.loadFailedTitle', { pluginId })}</strong>
          <p className="selectable">{client.message}</p>
          <Button size="sm" onClick={retryModule}>
            {t('ui.pluginUi.retry')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <ViewBoundary label={label ?? t('ui.pluginUi.boundaryLabel')}>
      <PluginClientContext.Provider value={ctx}>
        <PluginScope>
          <client.Component {...(slotProps ?? {})} />
        </PluginScope>
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}

/** Missing client declaration: explicit contract error (registration boundary already rejects it; this is render-time defense). */
function MissingTrackError({ pluginId }: { pluginId: string }): ReactNode {
  const { t } = useWebLocale()
  return (
    <div className="callout callout-warn" role="alert">
      <HelmxIcon name="alert-triangle" size={13} />
      <span>{t('ui.pluginUi.missingClient', { pluginId })}</span>
    </div>
  )
}
