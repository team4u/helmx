/**
 * Shared dynamic plugin client component loader & cache-invalidation subscription
 * hook used by PluginUiView and CodeBlockRenderer.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { ClientComponentRef, ComposerController, PluginClientContext } from '@helmx/protocol/browser'
import { createPluginClientContext, usePluginClientHost } from '@helmx/plugin-client'
import {
  getCachedClientComponent,
  getPluginClientCacheRevision,
  loadPluginClientModule,
  PluginClientError,
  requireClientExport,
  subscribePluginClientCacheInvalidation,
} from '../lib/plugin-client.js'

export type PluginClientLoadState<P extends object> =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; Component: ComponentType<P> }

export interface UsePluginClientComponentResult<P extends object> {
  ctx: PluginClientContext
  revision: string
  client: PluginClientLoadState<P>
  retryModule: () => void
}

export function usePluginClientComponent<P extends object>({
  pluginId,
  clientRef,
  expectedHash,
  conversationId,
  composer,
}: {
  pluginId: string
  clientRef: ClientComponentRef
  expectedHash?: string
  conversationId?: number
  composer?: ComposerController
}): UsePluginClientComponentResult<P> {
  const port = usePluginClientHost()
  const ctx = useMemo(
    () => createPluginClientContext(port, pluginId, conversationId, composer),
    [port, pluginId, conversationId, composer],
  )
  const revision = useSyncExternalStore(
    subscribePluginClientCacheInvalidation,
    () => getPluginClientCacheRevision(pluginId),
    () => getPluginClientCacheRevision(pluginId),
  )
  const [retryCount, setRetryCount] = useState(0)
  const [client, setClient] = useState<PluginClientLoadState<P>>(() => {
    const cached = getCachedClientComponent(pluginId, clientRef.module, clientRef.export, expectedHash)
    return cached !== undefined
      ? { phase: 'ready', Component: cached as unknown as ComponentType<P> }
      : { phase: 'loading' }
  })

  useEffect(() => {
    let cancelled = false
    if (getCachedClientComponent(pluginId, clientRef.module, clientRef.export, expectedHash) === undefined) {
      setClient((prev) => (prev.phase === 'loading' ? prev : { phase: 'loading' }))
    }
    void (async () => {
      try {
        const loaded = await loadPluginClientModule(pluginId, clientRef.module, expectedHash)
        const exported = requireClientExport(pluginId, clientRef.module, clientRef.export, loaded.module)
        if (typeof exported !== 'function') {
          throw new PluginClientError(
            'client_export_not_component',
            `Plugin ${pluginId} module ${clientRef.module} export ${clientRef.export} is not a component function`,
            0,
          )
        }
        if (!cancelled) {
          const Component = exported as unknown as ComponentType<P>
          setClient((prev) => (prev.phase === 'ready' && prev.Component === Component ? prev : { phase: 'ready', Component }))
        }
      } catch (err) {
        if (!cancelled) {
          setClient({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, clientRef.module, clientRef.export, expectedHash, retryCount, revision])

  const retryModule = useCallback(() => {
    setClient({ phase: 'loading' })
    setRetryCount((value) => value + 1)
  }, [])

  return { ctx, revision, client, retryModule }
}
