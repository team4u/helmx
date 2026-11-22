/**
 * builtin:triggers settings panel surface (lightweight dedicated entrypoint,
 * decoupled from the manager tables & detail drawer; Fast Refresh compliant).
 */
import './styles.css'
import type { ReactNode } from 'react'
import {
  HelmxIcon,
  KvGrid,
  LoadingState,
  ScreenSection,
  usePluginContext,
  usePluginDoc,
  usePluginTranslator,
} from '@helmx/plugin-client'
import { parseCronJobs, parseWebhooks } from './models.ts'
import {
  TRIGGERS_KV_CRON_COUNT,
  TRIGGERS_KV_WEBHOOK_COUNT,
  TRIGGERS_OPEN_MANAGER,
  TRIGGERS_SETTINGS_LOADING,
  TRIGGERS_SETTINGS_NOTE,
  TRIGGERS_SETTINGS_SECTION,
} from './copy.ts'

/** Trigger settings panel: count overview + manager view / CLI guidance. */
export function TriggersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)

  return (
    <ScreenSection
      className="tg-settings"
      title={
        <>
          <HelmxIcon name="clock" size={13} />
          <span>{t(TRIGGERS_SETTINGS_SECTION)}</span>
        </>
      }
    >
      {crons === undefined || webhooks === undefined ? (
        <LoadingState label={t(TRIGGERS_SETTINGS_LOADING)} />
      ) : (
        <KvGrid
          items={[
            { key: t(TRIGGERS_KV_CRON_COUNT), value: jobs.length },
            { key: t(TRIGGERS_KV_WEBHOOK_COUNT), value: hooks.length },
          ]}
        />
      )}
      <div className="tg-note">{t(TRIGGERS_SETTINGS_NOTE)}</div>
      <div>
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => ctx.openScreen('screen:builtin:triggers/manager')}
        >
          <HelmxIcon name="external-link" size={11} />
          <span>{t(TRIGGERS_OPEN_MANAGER)}</span>
        </button>
      </div>
    </ScreenSection>
  )
}
