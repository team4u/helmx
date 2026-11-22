/**
 * Dedicated Settings panel surface entrypoint for builtin:superagent
 * (`SuperAgentSettingsPanel`). Loaded lazily only when Settings is opened.
 */
import './styles.css'
import type { ReactNode } from 'react'
import {
  HelmxIcon,
  LoadingState,
  usePluginDoc,
  usePluginTranslator,
} from '@helmx/plugin-client'
import { parseWorkers, type SuperAgentIndexDoc } from './models.ts'
import {
  SA_KV_ROUTER,
  SA_KV_WATCHDOG,
  SA_KV_WORKERS,
  SA_LOADING_MANAGED,
  SA_NOT_BOOTSTRAPPED,
  SA_SETTINGS_HINT,
  SA_SETTINGS_TITLE,
} from './copy.ts'

export function SuperAgentSettingsPanel(): ReactNode {
  const t = usePluginTranslator()
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const routerId = typeof index?.routerConversationId === 'number' ? index.routerConversationId : undefined
  const watchdogId = typeof index?.watchdogConversationId === 'number' ? index.watchdogConversationId : undefined
  const workers = parseWorkers(index)

  return (
    <div className="screen-container">
      <div className="screen-section-title">
        <HelmxIcon name="network" size={13} />
        <span>{t(SA_SETTINGS_TITLE)}</span>
      </div>
      <div className="sa-widget-muted">{t(SA_SETTINGS_HINT)}</div>
      {index === undefined ? (
        <LoadingState label={t(SA_LOADING_MANAGED)} />
      ) : (
        <div className="kv-list">
          <div className="kv-key">{t(SA_KV_ROUTER)}</div>
          <div className="kv-val">{routerId !== undefined ? `#${routerId}` : t(SA_NOT_BOOTSTRAPPED)}</div>
          <div className="kv-key">{t(SA_KV_WATCHDOG)}</div>
          <div className="kv-val">{watchdogId !== undefined ? `#${watchdogId}` : t(SA_NOT_BOOTSTRAPPED)}</div>
          <div className="kv-key">{t(SA_KV_WORKERS)}</div>
          <div className="kv-val">{workers.length}</div>
        </div>
      )}
    </div>
  )
}
