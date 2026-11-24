/**
 * Dedicated Settings panel surface entrypoint for builtin:magpie
 * (`MagpieSettingsPanel`). Loaded lazily only when Settings is opened.
 */
import './styles.css'
import type { ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  formatTime,
  HelmxIcon,
  KvGrid,
  LoadingState,
  usePluginAction,
  usePluginConfig,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  boolLabel,
  parseStatus,
  quotaRowRemainingText,
  quotaRowTone,
  type MagpieStatusView,
} from './models.ts'
import { resolveRefreshIntervalSec, resolveShowQuotaStatus } from './quota-model.ts'
import { noteMagpieManualRefresh } from './auto-refresh.ts'
import {
  MAGPIE_COL_PROVIDER,
  MAGPIE_DIAGNOSTICS_COL,
  MAGPIE_DIAGNOSTICS_EMPTY,
  MAGPIE_DIAGNOSTICS_SECTION,
  MAGPIE_KV_AUTO_REFRESH,
  MAGPIE_KV_GATEWAY_URL,
  MAGPIE_KV_LAST_ERROR,
  MAGPIE_KV_LAST_REFRESHED,
  MAGPIE_KV_LOCAL_LOOPBACK,
  MAGPIE_KV_MODELS,
  MAGPIE_KV_MODELS_CACHED,
  MAGPIE_KV_REACHABLE,
  MAGPIE_LOADING,
  MAGPIE_QUOTA_COL_ACCOUNT,
  MAGPIE_QUOTA_COL_REMAINING,
  MAGPIE_QUOTA_COL_RESET,
  MAGPIE_QUOTA_COL_WINDOW,
  MAGPIE_QUOTA_EMPTY,
  MAGPIE_QUOTA_SECTION,
  MAGPIE_REFRESH,
  MAGPIE_REFRESHING,
  MAGPIE_TITLE,
  magpieRefreshIntervalLabel,
} from './copy.ts'

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <Callout tone="err">
      <span>{message}</span>
    </Callout>
  )
}

function StatusSummary({ status, refreshIntervalSec }: { status: MagpieStatusView; refreshIntervalSec: number }): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  return (
    <KvGrid
      items={[
        { key: t(MAGPIE_KV_GATEWAY_URL), value: status.gatewayUrl || '—' },
        { key: t(MAGPIE_KV_LOCAL_LOOPBACK), value: boolLabel(status.local, locale) },
        {
          key: t(MAGPIE_KV_REACHABLE),
          value: <Badge tone={status.reachable ? 'ok' : 'warn'}>{boolLabel(status.reachable, locale)}</Badge>,
        },
        { key: status.reachable ? t(MAGPIE_KV_MODELS) : t(MAGPIE_KV_MODELS_CACHED), value: status.modelCount },
        {
          key: t(MAGPIE_KV_AUTO_REFRESH),
          value: <span className="mono tabular-nums">{magpieRefreshIntervalLabel(refreshIntervalSec, locale)}</span>,
        },
        { key: t(MAGPIE_KV_LAST_REFRESHED), value: formatTime(status.lastRefreshedAt) || '—' },
        ...(status.lastError !== undefined ? [{ key: t(MAGPIE_KV_LAST_ERROR), value: status.lastError }] : []),
      ]}
    />
  )
}

function DiagnosticsTable({ diagnostics }: { diagnostics: string[] }): ReactNode {
  const t = usePluginTranslator()
  return (
    <div className="helmx-table-wrap">
      <table className="helmx-table">
        <thead>
          <tr>
            <th>{t(MAGPIE_DIAGNOSTICS_COL)}</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.length === 0 ? (
            <tr>
              <td className="table-empty">{t(MAGPIE_DIAGNOSTICS_EMPTY)}</td>
            </tr>
          ) : (
            diagnostics.map((message, i) => (
              <tr key={i}>
                <td>{message}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function QuotaTable({ quotas }: { quotas: MagpieStatusView['quotas'] }): ReactNode {
  const t = usePluginTranslator()
  return (
    <div className="helmx-table-wrap">
      <table className="helmx-table">
        <thead>
          <tr>
            <th>{t(MAGPIE_COL_PROVIDER)}</th>
            <th>{t(MAGPIE_QUOTA_COL_ACCOUNT)}</th>
            <th>{t(MAGPIE_QUOTA_COL_WINDOW)}</th>
            <th>{t(MAGPIE_QUOTA_COL_REMAINING)}</th>
            <th>{t(MAGPIE_QUOTA_COL_RESET)}</th>
          </tr>
        </thead>
        <tbody>
          {quotas.length === 0 ? (
            <tr>
              <td colSpan={5} className="table-empty">
                {t(MAGPIE_QUOTA_EMPTY)}
              </td>
            </tr>
          ) : (
            quotas.map((q, i) => (
              <tr key={`${q.provider}:${i}`}>
                <td>{q.provider}</td>
                <td>{q.account ?? '—'}</td>
                <td>{q.windowLabel ?? '—'}</td>
                <td>
                  <Badge tone={quotaRowTone(q)}>{quotaRowRemainingText(q)}</Badge>
                </td>
                <td>{q.resetText ?? '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Magpie gateway settings panel (status + diagnostics + optional quotas + refresh action). */
export function MagpieSettingsPanel(): ReactNode {
  const t = usePluginTranslator()
  const doc = usePluginDoc<MagpieStatusView>('status')
  const config = usePluginConfig()
  const status = parseStatus(doc)
  const showQuotaStatus = resolveShowQuotaStatus(config)
  const refreshIntervalSec = showQuotaStatus ? resolveRefreshIntervalSec(config) : 0
  const refreshAction = usePluginAction({
    onSuccess: () => {
      noteMagpieManualRefresh()
    },
  })

  return (
    <div className="screen-container">
      <div className="screen-header">
        <div className="screen-section-title">
          <HelmxIcon name="server" size={13} />
          <span>{t(MAGPIE_TITLE)}</span>
        </div>
        <Button
          size="xs"
          icon="refresh-cw"
          pending={refreshAction.pending}
          onClick={() => void refreshAction.run('refresh', {})}
        >
          {refreshAction.pending ? t(MAGPIE_REFRESHING) : t(MAGPIE_REFRESH)}
        </Button>
      </div>
      {status.summaryText !== '' ? <div className="screen-subtitle">{status.summaryText}</div> : null}
      {refreshAction.error !== undefined ? <ActionError message={refreshAction.error} /> : null}
      {doc === undefined ? (
        <LoadingState label={t(MAGPIE_LOADING)} />
      ) : (
        <>
          <StatusSummary status={status} refreshIntervalSec={refreshIntervalSec} />
          <div className="screen-section">
            <div className="screen-section-title">
              <HelmxIcon name="activity" size={12} />
              <span>{t(MAGPIE_DIAGNOSTICS_SECTION)}</span>
            </div>
            <DiagnosticsTable diagnostics={status.diagnostics} />
          </div>
          {showQuotaStatus ? (
            <div className="screen-section">
              <div className="screen-section-title">
                <HelmxIcon name="gauge" size={12} />
                <span>{t(MAGPIE_QUOTA_SECTION)}</span>
              </div>
              <QuotaTable quotas={status.quotas} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
