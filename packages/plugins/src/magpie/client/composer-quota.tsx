/**
 * Dedicated composer status-row quota indicator surface for builtin:magpie
 * (`COMPOSER_STATUS_SLOT`). Decoupled from `MagpieSettingsPanel` so every
 * conversation only downloads the compact quota badge & popover.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ComposerStatusSlotProps } from '@helmx/protocol/browser'
import {
  Badge,
  HelmxIcon,
  IconButton,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
} from '@helmx/ui'
import {
  useHostModels,
  usePluginAction,
  usePluginConfig,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useSharedNowMs,
} from '@helmx/plugin-client'
import { parseStatus, type MagpieStatusView } from './models.ts'
import {
  inlineSummaryWindows,
  resolveEffectiveMagpieModel,
  resolveRefreshIntervalSec,
  resolveShowQuotaStatus,
  selectModelQuotas,
  shouldShowInlineWindowLabel,
  type FormattedQuotaWindow,
  type ModelQuotaAccount,
} from './quota-model.ts'
import { noteMagpieManualRefresh, subscribeMagpieAutoRefresh } from './auto-refresh.ts'
import {
  MAGPIE_COMPOSER_ACTIVE_ACCOUNT,
  MAGPIE_COMPOSER_CLOSE,
  MAGPIE_COMPOSER_DEFAULT_ACCOUNT,
  MAGPIE_COMPOSER_NO_WINDOW_DATA,
  MAGPIE_COMPOSER_QUOTA_ARIA,
  MAGPIE_COMPOSER_QUOTA_NA_SHORT,
  MAGPIE_COMPOSER_REFRESH_NOW,
  MAGPIE_COMPOSER_ROUTING_GROUP_PREFIX,
  magpieMoreAccountsTitle,
  magpieRelativeAgeLabel,
} from './copy.ts'

function InlineWindowItems({ account }: { account: ModelQuotaAccount }): ReactNode {
  const t = usePluginTranslator()
  if (account.windows.length === 0) {
    return <span className="magpie-quota-trigger-item">{t(MAGPIE_COMPOSER_QUOTA_NA_SHORT)}</span>
  }
  const { visible, hiddenCount } = inlineSummaryWindows(account)
  return (
    <span className="magpie-quota-trigger-items mono tabular-nums">
      {visible.map((win, index) => (
        <Fragment key={`${win.label}:${index}`}>
          {index > 0 ? <span className="magpie-quota-trigger-sep" aria-hidden="true">·</span> : null}
          <span className="magpie-quota-trigger-item">
            {shouldShowInlineWindowLabel(win.label) ? <span>{win.label}</span> : null}
            <span>{win.valueText}</span>
            {win.resetText ? <span className="magpie-quota-trigger-reset">({win.resetText})</span> : null}
          </span>
        </Fragment>
      ))}
      {hiddenCount > 0 ? (
        <>
          <span className="magpie-quota-trigger-sep" aria-hidden="true">·</span>
          <span className="magpie-quota-trigger-item">+{hiddenCount}</span>
        </>
      ) : null}
    </span>
  )
}

function PopoverWindowRow({ win }: { win: FormattedQuotaWindow }): ReactNode {
  const toneClass =
    win.tone === 'err'
      ? ' magpie-quota-window-value--err'
      : win.tone === 'warn'
        ? ' magpie-quota-window-value--warn'
        : win.tone === 'ok'
          ? ' magpie-quota-window-value--ok'
          : ''
  return (
    <div className="magpie-quota-window-row">
      <span className="magpie-quota-window-label">{win.label}</span>
      <span className="magpie-quota-window-metrics mono tabular-nums">
        {win.detailText ? <span className="magpie-quota-window-detail">{win.detailText}</span> : null}
        <span className={`magpie-quota-window-value${toneClass}`}>{win.valueText}</span>
        {win.resetText ? <span className="magpie-quota-window-reset">{win.resetText}</span> : null}
      </span>
    </div>
  )
}

function PopoverAccountSection({
  account,
  isPrimary,
  showActiveBadge,
}: {
  account: ModelQuotaAccount
  isPrimary: boolean
  showActiveBadge: boolean
}): ReactNode {
  const t = usePluginTranslator()
  const displayName = account.account ?? t(MAGPIE_COMPOSER_DEFAULT_ACCOUNT)
  return (
    <div className="magpie-quota-account">
      <div className="magpie-quota-account-header">
        <span className="magpie-quota-account-name" title={displayName}>
          {displayName}
        </span>
        {showActiveBadge && isPrimary ? (
          <Badge tone="neutral">{t(MAGPIE_COMPOSER_ACTIVE_ACCOUNT)}</Badge>
        ) : null}
      </div>
      {account.windows.length > 0 ? (
        account.windows.map((win, idx) => <PopoverWindowRow key={`${win.label}:${idx}`} win={win} />)
      ) : (
        <div className="magpie-quota-window-detail">
          {account.error ?? t(MAGPIE_COMPOSER_NO_WINDOW_DATA)}
        </div>
      )}
    </div>
  )
}

export function MagpieComposerQuotaStatus(props: ComposerStatusSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const doc = usePluginDoc<MagpieStatusView>('status')
  const hostModels = useHostModels()
  const config = usePluginConfig()
  const [open, setOpen] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>(undefined)
  const [pollError, setPollError] = useState<string | undefined>(undefined)
  const refreshAction = usePluginAction({
    onSuccess: () => {
      const now = Date.now()
      noteMagpieManualRefresh(now)
      setLastCheckedAt(now)
      setPollError(undefined)
    },
  })

  const showQuotaStatus = resolveShowQuotaStatus(config)
  const rawModel = props.conversation?.model || props.effectiveModel
  const activeModel = useMemo(
    () => (showQuotaStatus ? resolveEffectiveMagpieModel(rawModel, hostModels?.modelTiers) : null),
    [showQuotaStatus, rawModel, hostModels?.modelTiers],
  )
  const isMagpieActive = activeModel !== null
  const refreshIntervalSec = resolveRefreshIntervalSec(config)
  const nowMs = useSharedNowMs(isMagpieActive, 15_000)

  const callActionRef = useRef(ctx.callAction)
  callActionRef.current = ctx.callAction

  useEffect(() => {
    if (!isMagpieActive) setOpen(false)
  }, [isMagpieActive])

  useEffect(() => {
    if (!isMagpieActive || refreshIntervalSec <= 0) return
    return subscribeMagpieAutoRefresh({
      intervalMs: refreshIntervalSec * 1000,
      run: async () => {
        await callActionRef.current('refresh', { onlyIfChanged: true })
      },
      onResult: (checkedAt, err) => {
        setLastCheckedAt(checkedAt)
        setPollError(err)
      },
    })
  }, [isMagpieActive, refreshIntervalSec])

  const handleManualRefresh = useCallback(() => {
    void refreshAction.run('refresh', {})
  }, [refreshAction])

  if (!activeModel) return null

  const status = parseStatus(doc)
  const summary = selectModelQuotas(activeModel, status, nowMs)
  const activeError =
    refreshAction.error ?? status.quotasError ?? pollError ?? (status.reachable ? undefined : status.lastError)

  if (summary.primary === null && activeError === undefined) {
    return null
  }

  const freshnessAt =
    lastCheckedAt !== undefined && (summary.updatedAt === undefined || lastCheckedAt > summary.updatedAt)
      ? lastCheckedAt
      : summary.updatedAt
  const ageLabel = magpieRelativeAgeLabel(freshnessAt, nowMs, locale)
  const triggerToneClass =
    summary.triggerTone === 'err'
      ? ' helmx-toolbar-pill--err magpie-quota-trigger--err'
      : summary.triggerTone === 'warn'
        ? ' helmx-toolbar-pill--warn magpie-quota-trigger--warn'
        : ''
  const hasMultipleAccounts = summary.extraAccountCount > 0
  const triggerTitle = hasMultipleAccounts
    ? magpieMoreAccountsTitle(summary.accounts.length, locale)
    : t(MAGPIE_COMPOSER_QUOTA_ARIA)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`helmx-toolbar-pill magpie-quota-trigger${triggerToneClass}`}
          aria-label={triggerTitle}
          title={triggerTitle}
          data-magpie-model={activeModel.bareModelId}
        >
          {summary.primary !== null ? (
            <InlineWindowItems account={summary.primary} />
          ) : (
            <span className="magpie-quota-trigger-item">{t(MAGPIE_COMPOSER_QUOTA_NA_SHORT)}</span>
          )}
          {hasMultipleAccounts ? (
            <span className="magpie-quota-trigger-more mono tabular-nums">
              <span>+{summary.extraAccountCount}</span>
              <HelmxIcon name="chevron-up" size={11} className="magpie-quota-trigger-chevron" />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        portalled
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="magpie-quota-popover"
      >
        <PopoverHeader
          divider
          className="magpie-quota-popover-header"
          title={<span className="magpie-quota-popover-title">{activeModel.displayModelName}</span>}
          subtitle={
            activeModel.isRoutingGroup && summary.providers.length > 0 ? (
              <span className="magpie-quota-popover-subtitle">
                {t(MAGPIE_COMPOSER_ROUTING_GROUP_PREFIX)} {summary.providers.join(', ')}
              </span>
            ) : undefined
          }
          trailing={
            <div className="magpie-quota-popover-actions">
              {ageLabel ? <span className="magpie-quota-popover-age">{ageLabel}</span> : null}
              <IconButton
                variant="ghost"
                size="xs"
                icon="refresh-cw"
                pending={refreshAction.pending}
                onClick={handleManualRefresh}
                label={t(MAGPIE_COMPOSER_REFRESH_NOW)}
              />
              <PopoverClose asChild>
                <IconButton
                  variant="ghost"
                  size="xs"
                  icon="x"
                  label={t(MAGPIE_COMPOSER_CLOSE)}
                />
              </PopoverClose>
            </div>
          }
        />
        {activeError !== undefined ? (
          <div className="magpie-quota-popover-error" role="alert">
            {activeError}
          </div>
        ) : null}
        {summary.accounts.length > 0 ? (
          <div className="magpie-quota-accounts">
            {summary.accounts.map((account, index) => (
              <PopoverAccountSection
                key={account.key}
                account={account}
                isPrimary={index === 0}
                showActiveBadge={summary.accounts.length > 1}
              />
            ))}
          </div>
        ) : (
          <div className="magpie-quota-empty">{t(MAGPIE_COMPOSER_NO_WINDOW_DATA)}</div>
        )}
      </PopoverContent>
    </Popover>
  )
}
