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
  EmptyState,
  formatTime,
  HelmxIcon,
  KvGrid,
  List,
  ListRow,
  LoadingState,
  ScreenSection,
  Stack,
  usePluginAction,
  usePluginConfig,
  usePluginContext,
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
  MAGPIE_QUOTA_EMPTY,
  MAGPIE_QUOTA_SECTION,
  MAGPIE_REFRESH,
  MAGPIE_REFRESHED_NOTICE,
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
        { key: t(MAGPIE_KV_GATEWAY_URL), value: <span className="mono">{status.gatewayUrl || '—'}</span> },
        { key: t(MAGPIE_KV_LOCAL_LOOPBACK), value: boolLabel(status.local, locale) },
        {
          key: t(MAGPIE_KV_REACHABLE),
          value: <Badge tone={status.reachable ? 'ok' : 'warn'}>{boolLabel(status.reachable, locale)}</Badge>,
        },
        {
          key: status.reachable ? t(MAGPIE_KV_MODELS) : t(MAGPIE_KV_MODELS_CACHED),
          value: <span className="tabular-nums">{status.modelCount}</span>,
        },
        {
          key: t(MAGPIE_KV_AUTO_REFRESH),
          value: <span className="mono tabular-nums">{magpieRefreshIntervalLabel(refreshIntervalSec, locale)}</span>,
        },
        {
          key: t(MAGPIE_KV_LAST_REFRESHED),
          value: <span className="tabular-nums">{formatTime(status.lastRefreshedAt) || '—'}</span>,
        },
        ...(status.lastError !== undefined ? [{ key: t(MAGPIE_KV_LAST_ERROR), value: status.lastError }] : []),
      ]}
    />
  )
}

function DiagnosticsList({ diagnostics }: { diagnostics: string[] }): ReactNode {
  const t = usePluginTranslator()
  if (diagnostics.length === 0) {
    return <EmptyState compact icon="activity" title={t(MAGPIE_DIAGNOSTICS_EMPTY)} />
  }
  return (
    <List density="compact" label={t(MAGPIE_DIAGNOSTICS_SECTION)}>
      {diagnostics.map((message, i) => (
        <ListRow
          key={i}
          interactive={false}
          tone="warn"
          className="magpie-diag-row"
          leading={<HelmxIcon name="alert-triangle" size={12} />}
          title={message}
        />
      ))}
    </List>
  )
}

function QuotaList({ quotas }: { quotas: MagpieStatusView['quotas'] }): ReactNode {
  const t = usePluginTranslator()
  if (quotas.length === 0) {
    return <EmptyState compact icon="gauge" title={t(MAGPIE_QUOTA_EMPTY)} />
  }
  return (
    <List density="compact" label={t(MAGPIE_QUOTA_SECTION)}>
      {quotas.map((q, i) => {
        const rowTone = quotaRowTone(q)
        const listTone = rowTone === 'err' ? 'danger' : rowTone === 'warn' ? 'warn' : 'default'
        const metaParts = [q.account, q.windowLabel].filter((v): v is string => Boolean(v && v.trim() !== ''))
        return (
          <ListRow
            key={`${q.provider}:${i}`}
            interactive={false}
            tone={listTone}
            title={<span className="mono">{q.provider}</span>}
            meta={metaParts.length > 0 ? <span>{metaParts.join(' · ')}</span> : undefined}
            trailing={
              <Stack direction="horizontal" align="center" gap="sm">
                <Badge tone={rowTone} mono className="tabular-nums">
                  {quotaRowRemainingText(q)}
                </Badge>
                {q.resetText ? <span className="text-muted mono tabular-nums">{q.resetText}</span> : null}
              </Stack>
            }
          />
        )
      })}
    </List>
  )
}

/** Magpie gateway settings panel (status + diagnostics + optional quotas + refresh action). */
export function MagpieSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const doc = usePluginDoc<MagpieStatusView>('status')
  const config = usePluginConfig()
  const status = parseStatus(doc)
  const showQuotaStatus = resolveShowQuotaStatus(config)
  const refreshIntervalSec = showQuotaStatus ? resolveRefreshIntervalSec(config) : 0
  const refreshAction = usePluginAction({
    onSuccess: () => {
      noteMagpieManualRefresh()
      ctx.notify(t(MAGPIE_REFRESHED_NOTICE))
    },
  })

  return (
    <Stack gap="md">
      <ScreenSection
        title={
          <>
            <HelmxIcon name="server" size={13} />
            <span>{t(MAGPIE_TITLE)}</span>
          </>
        }
        titleExtra={status.summaryText !== '' ? status.summaryText : undefined}
      >
        {refreshAction.error !== undefined ? <ActionError message={refreshAction.error} /> : null}
        {doc === undefined ? (
          <LoadingState label={t(MAGPIE_LOADING)} />
        ) : (
          <StatusSummary status={status} refreshIntervalSec={refreshIntervalSec} />
        )}
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon="refresh-cw"
            pending={refreshAction.pending}
            onClick={() => void refreshAction.run('refresh', {})}
          >
            {refreshAction.pending ? t(MAGPIE_REFRESHING) : t(MAGPIE_REFRESH)}
          </Button>
        </div>
      </ScreenSection>
      {doc !== undefined ? (
        <>
          <ScreenSection
            title={
              <>
                <HelmxIcon name="activity" size={12} />
                <span>{t(MAGPIE_DIAGNOSTICS_SECTION)}</span>
              </>
            }
          >
            <DiagnosticsList diagnostics={status.diagnostics} />
          </ScreenSection>
          {showQuotaStatus ? (
            <ScreenSection
              title={
                <>
                  <HelmxIcon name="gauge" size={12} />
                  <span>{t(MAGPIE_QUOTA_SECTION)}</span>
                </>
              }
            >
              <QuotaList quotas={status.quotas} />
            </ScreenSection>
          ) : null}
        </>
      ) : null}
    </Stack>
  )
}
