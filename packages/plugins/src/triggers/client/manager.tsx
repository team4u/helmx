/**
 * builtin:triggers fullscreen manager surface (component exports only, Fast
 * Refresh contract):
 * - TriggersManagerScreen: cron / webhook management tables (`DataTable`) +
 *   right-side `DetailDrawer` opened by row clicks, showing live run history
 *   projected directly from `useConversations()` (zero double-writing in docs)
 *   with one-click drawer peek (`openConversationDrawer`) and main-stage jump;
 * - Row actions (`cron_trigger` / `cron_delete` / `webhook_delete`) share one
 *   `usePluginAction` mutex across both tables.
 */
import { useMemo, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ConversationSummary, ScreenProps } from '@helmx/protocol'
import {
  ConfirmDialog,
  DataTable,
  DetailDrawer,
  HelmxIcon,
  KvGrid,
  Screen,
  ScreenSection,
  StatusLight,
  Tooltip,
  formatDurationMs,
  formatStopwatchMs,
  formatTime,
  resolveConversationTiming,
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useSharedNowMs,
  type UsePluginActionResult,
} from '@helmx/plugin-client'
import {
  formatTriggerTargetSummary,
  parseCronJobs,
  parseWebhooks,
  selectTriggerRuns,
  summarizeTriggerRunHealth,
  triggerRunStatusLabel,
  type CronJobRow,
  type TriggerDetailSelection,
  type WebhookRow,
} from './models.ts'
import {
  TRIGGERS_CANCEL,
  TRIGGERS_CLOSE,
  TRIGGERS_COL_ACTIONS,
  TRIGGERS_COL_COMMAND,
  TRIGGERS_COL_CREATED,
  TRIGGERS_COL_DESCRIPTION,
  TRIGGERS_COL_ENABLED,
  TRIGGERS_COL_LAST_ERROR,
  TRIGGERS_COL_LAST_RUN,
  TRIGGERS_COL_NEXT_RUN,
  TRIGGERS_COL_SCHEDULE,
  TRIGGERS_COMMAND_SECTION,
  TRIGGERS_CONFIRM_DELETE_CRON_TITLE,
  TRIGGERS_CONFIRM_DELETE_WEBHOOK_TITLE,
  TRIGGERS_CRON_DETAIL_SUBTITLE,
  TRIGGERS_CRON_LOADING,
  TRIGGERS_CRON_SECTION,
  TRIGGERS_DELETE,
  TRIGGERS_DETAIL_TITLE,
  TRIGGERS_DISABLED,
  TRIGGERS_ENABLED,
  TRIGGERS_KV_CATCH_UP,
  TRIGGERS_KV_CREATED,
  TRIGGERS_KV_CRON_EXPRESSION,
  TRIGGERS_KV_DELIVERY_TARGET,
  TRIGGERS_KV_DESCRIPTION,
  TRIGGERS_KV_LAST_RUN,
  TRIGGERS_KV_LAST_SKIPPED,
  TRIGGERS_KV_NEXT_RUN,
  TRIGGERS_KV_SECRET_STATE,
  TRIGGERS_KV_TIMEZONE,
  TRIGGERS_MANAGER_NOTE,
  TRIGGERS_OFF,
  TRIGGERS_ON,
  TRIGGERS_OPEN_CONVERSATION,
  TRIGGERS_PEEK_CONVERSATION,
  TRIGGERS_RUNS_EMPTY,
  TRIGGERS_RUNS_SECTION,
  TRIGGERS_SCREEN_TITLE,
  TRIGGERS_SECRET_CONFIGURED,
  TRIGGERS_SECRET_MISSING,
  TRIGGERS_SPLIT_SUFFIX,
  TRIGGERS_TABLE_EMPTY,
  TRIGGERS_TARGET_CONVERSATION_SECTION,
  TRIGGERS_TRIGGER_NOW,
  TRIGGERS_WEBHOOK_DETAIL_SUBTITLE,
  TRIGGERS_WEBHOOK_LOADING,
  TRIGGERS_WEBHOOK_SECTION,
  triggersActionFailed,
  triggersConfirmDeleteBody,
} from './copy.ts'

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout-error" role="alert">
      <HelmxIcon name="alert-circle" size={13} />
      <span className="callout-text">{message}</span>
    </div>
  )
}

function RowAction({
  label,
  iconName,
  disabled,
  danger,
  onClick,
}: {
  label: string
  iconName: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      <HelmxIcon
        name={disabled === true ? 'loader' : iconName}
        size={11}
        className={disabled === true ? 'spin-slow' : undefined}
      />
      <span>{label}</span>
    </button>
  )
}

/** Cron jobs table (action mutex shared from above; row clicks open the detail drawer). */
function CronTable({
  jobs,
  conversations,
  loading,
  actions,
  selectedId,
  onSelect,
  onRequestDelete,
}: {
  jobs: CronJobRow[]
  conversations: ReadonlyArray<ConversationSummary>
  loading: boolean
  actions: UsePluginActionResult
  selectedId?: string
  onSelect: (id: string) => void
  onRequestDelete: (id: string) => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  return (
    <div className="tg-table-wrap">
      <DataTable
        columns={8}
        loading={loading}
        loadingLabel={t(TRIGGERS_CRON_LOADING)}
        empty={jobs.length === 0}
        emptyLabel={t(TRIGGERS_TABLE_EMPTY)}
      >
        <thead>
          <tr>
            <th>ID</th>
            <th>{t(TRIGGERS_COL_SCHEDULE)}</th>
            <th>{t(TRIGGERS_COL_COMMAND)}</th>
            <th>{t(TRIGGERS_COL_ENABLED)}</th>
            <th>{t(TRIGGERS_COL_LAST_RUN)}</th>
            <th>{t(TRIGGERS_COL_NEXT_RUN)}</th>
            <th>{t(TRIGGERS_COL_LAST_ERROR)}</th>
            <th className="cell-actions">{t(TRIGGERS_COL_ACTIONS)}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const runs = selectTriggerRuns(conversations, 'cron', job.id)
            const health = summarizeTriggerRunHealth(runs)
            const showLight = health.status === 'error' || health.status === 'blocked' || health.status === 'working'
            return (
              <tr
                key={job.id}
                className={selectedId === job.id ? 'tg-row is-selected' : 'tg-row'}
                tabIndex={0}
                onClick={() => onSelect(job.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(job.id)
                  }
                }}
              >
                <td data-label="ID" className="mono">
                  <span className="tg-id-cell">
                    {showLight && health.status !== null ? (
                      <StatusLight
                        status={health.status}
                        label={triggerRunStatusLabel(health.status, locale)}
                      />
                    ) : null}
                    <span>{job.id}</span>
                  </span>
                </td>
                <td data-label={t(TRIGGERS_COL_SCHEDULE)} className="mono">{job.schedule}</td>
                <td data-label={t(TRIGGERS_COL_COMMAND)} className="cell-ellipsis" title={job.text}>{job.text}</td>
                <td data-label={t(TRIGGERS_COL_ENABLED)}>
                  <span className={`badge badge-${job.enabled ? 'ok' : 'neutral'}`}>
                    <span>{job.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}</span>
                  </span>
                </td>
                <td data-label={t(TRIGGERS_COL_LAST_RUN)}>{formatTime(job.lastRunAt) || '—'}</td>
                <td data-label={t(TRIGGERS_COL_NEXT_RUN)}>{formatTime(job.nextRunAt) || '—'}</td>
                <td data-label={t(TRIGGERS_COL_LAST_ERROR)} className="cell-error" title={job.lastError ?? ''}>
                  {job.lastError ?? '—'}
                </td>
                <td data-label={t(TRIGGERS_COL_ACTIONS)} className="cell-actions">
                  <div
                    className="row-actions-group"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <RowAction
                      label={t(TRIGGERS_TRIGGER_NOW)}
                      iconName="zap"
                      disabled={actions.pending}
                      onClick={() => void actions.run('cron_trigger', { id: job.id }, { key: `trigger:${job.id}` })}
                    />
                    <RowAction
                      label={t(TRIGGERS_DELETE)}
                      iconName="trash-2"
                      disabled={actions.pending}
                      danger
                      onClick={() => onRequestDelete(job.id)}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )
}

/** Webhook endpoints table (action mutex shared from above; row clicks open the detail drawer). */
function WebhookTable({
  webhooks,
  conversations,
  loading,
  actions,
  selectedId,
  onSelect,
  onRequestDelete,
}: {
  webhooks: WebhookRow[]
  conversations: ReadonlyArray<ConversationSummary>
  loading: boolean
  actions: UsePluginActionResult
  selectedId?: string
  onSelect: (id: string) => void
  onRequestDelete: (id: string) => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  return (
    <div className="tg-table-wrap">
      <DataTable
        columns={4}
        loading={loading}
        loadingLabel={t(TRIGGERS_WEBHOOK_LOADING)}
        empty={webhooks.length === 0}
        emptyLabel={t(TRIGGERS_TABLE_EMPTY)}
      >
        <thead>
          <tr>
            <th>ID</th>
            <th>{t(TRIGGERS_COL_DESCRIPTION)}</th>
            <th>{t(TRIGGERS_COL_CREATED)}</th>
            <th className="cell-actions">{t(TRIGGERS_COL_ACTIONS)}</th>
          </tr>
        </thead>
        <tbody>
          {webhooks.map((hook) => {
            const runs = selectTriggerRuns(conversations, 'webhook', hook.id)
            const health = summarizeTriggerRunHealth(runs)
            const showLight = health.status === 'error' || health.status === 'blocked' || health.status === 'working'
            return (
              <tr
                key={hook.id}
                className={selectedId === hook.id ? 'tg-row is-selected' : 'tg-row'}
                tabIndex={0}
                onClick={() => onSelect(hook.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(hook.id)
                  }
                }}
              >
                <td data-label="ID" className="mono">
                  <span className="tg-id-cell">
                    {showLight && health.status !== null ? (
                      <StatusLight
                        status={health.status}
                        label={triggerRunStatusLabel(health.status, locale)}
                      />
                    ) : null}
                    <span>{hook.id}</span>
                  </span>
                </td>
                <td data-label={t(TRIGGERS_COL_DESCRIPTION)} className="cell-ellipsis" title={hook.description ?? ''}>
                  {hook.description ?? '—'}
                </td>
                <td data-label={t(TRIGGERS_COL_CREATED)}>{formatTime(hook.createdAt) || '—'}</td>
                <td data-label={t(TRIGGERS_COL_ACTIONS)} className="cell-actions">
                  <div
                    className="row-actions-group"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <RowAction
                      label={t(TRIGGERS_DELETE)}
                      iconName="trash-2"
                      disabled={actions.pending}
                      danger
                      onClick={() => onRequestDelete(hook.id)}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )
}

/** Single run row inside the detail drawer: click peeks in drawer, trailing button opens full conversation. */
function TriggerRunRow({
  run,
  nowMs,
  onPeek,
  onOpen,
}: {
  run: ConversationSummary
  nowMs?: number
  onPeek: (conversationId: number) => void
  onOpen: (conversationId: number) => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const timing = resolveConversationTiming(run, nowMs)
  const durationText =
    timing.waitingMs !== undefined
      ? formatStopwatchMs(timing.waitingMs)
      : timing.currentRunMs !== undefined
        ? formatStopwatchMs(timing.currentRunMs)
        : timing.settledRunMs > 0
          ? formatDurationMs(timing.settledRunMs)
          : undefined
  const titleText = run.title || `#${run.id}`
  const statusLabel = triggerRunStatusLabel(run.status, locale)

  return (
    <div className="tg-run-row">
      <button
        type="button"
        className="tg-run-main"
        title={t(TRIGGERS_PEEK_CONVERSATION)}
        onClick={() => onPeek(run.id)}
      >
        <StatusLight status={run.status} label={statusLabel} />
        <span className="tg-run-body">
          <span className="tg-run-head">
            <span className="tg-run-title">{titleText}</span>
            <span className="tg-run-id mono">#{run.id}</span>
          </span>
          <span className="tg-run-meta">
            <span>{formatTime(run.createdAt) || '—'}</span>
            {durationText !== undefined ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="mono tabular-nums">{durationText}</span>
              </>
            ) : null}
            {run.status === 'error' && run.lastError ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="tg-run-err" title={run.lastError}>{run.lastError}</span>
              </>
            ) : null}
          </span>
        </span>
      </button>
      <Tooltip content={t(TRIGGERS_OPEN_CONVERSATION)} side="top">
        <button
          type="button"
          className="btn btn-ghost btn-icon-xs tg-run-open-btn"
          aria-label={`${t(TRIGGERS_OPEN_CONVERSATION)} #${run.id}`}
          onClick={() => onOpen(run.id)}
        >
          <HelmxIcon name="external-link" size={12} />
        </button>
      </Tooltip>
    </div>
  )
}

function TriggerDetailDrawer({
  cronJob,
  webhook,
  conversations,
  actions,
  inline,
  onClose,
  onRequestDelete,
}: {
  cronJob?: CronJobRow
  webhook?: WebhookRow
  conversations: ReadonlyArray<ConversationSummary>
  actions: UsePluginActionResult
  inline?: boolean
  onClose: () => void
  onRequestDelete: (target: TriggerDetailSelection) => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const title = cronJob !== undefined ? cronJob.id : webhook !== undefined ? webhook.id : t(TRIGGERS_DETAIL_TITLE)
  const targetConversationId = cronJob?.targetConversationId ?? webhook?.targetConversationId

  const runs = useMemo(() => {
    if (cronJob !== undefined) return selectTriggerRuns(conversations, 'cron', cronJob.id)
    if (webhook !== undefined) return selectTriggerRuns(conversations, 'webhook', webhook.id)
    return []
  }, [conversations, cronJob, webhook])

  const targetConversation = useMemo(
    () =>
      targetConversationId !== undefined
        ? conversations.find((c) => c.id === targetConversationId)
        : undefined,
    [conversations, targetConversationId],
  )

  const needsLiveClock = runs.some((r) => r.status === 'working' || r.status === 'blocked' || r.pendingAskCount > 0)
  const nowMs = useSharedNowMs(needsLiveClock)

  const peekConversation = (id: number): void => ctx.openConversationDrawer(id)
  const openConversation = (id: number): void => ctx.openScreen(`conversation:${id}`)

  return (
    <DetailDrawer
      open
      inline={inline}
      onClose={onClose}
      aria-label={title}
      title={title}
      titleClassName="break-word mono"
      titleExtra={
        cronJob !== undefined ? (
          <span className={`badge badge-${cronJob.enabled ? 'ok' : 'neutral'}`}>
            {cronJob.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
          </span>
        ) : webhook !== undefined ? (
          <span className="badge badge-neutral">Webhook</span>
        ) : undefined
      }
      belowTitle={
        <div className="text-subtle">
          {cronJob !== undefined ? t(TRIGGERS_CRON_DETAIL_SUBTITLE) : t(TRIGGERS_WEBHOOK_DETAIL_SUBTITLE)}
        </div>
      }
      closeLabel={t(TRIGGERS_CLOSE)}
      closeButtonClassName="btn btn-ghost btn-icon-sm tg-drawer-close"
      footer={
        cronJob !== undefined ? (
          <div className="flex-row-between" style={{ width: '100%' }}>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={actions.pending}
              onClick={() => onRequestDelete({ kind: 'cron', id: cronJob.id })}
            >
              <HelmxIcon name="trash-2" size={12} />
              <span>{t(TRIGGERS_DELETE)}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={actions.pending}
              onClick={() => void actions.run('cron_trigger', { id: cronJob.id }, { key: `trigger:${cronJob.id}` })}
            >
              <HelmxIcon name="zap" size={12} />
              <span>{t(TRIGGERS_TRIGGER_NOW)}</span>
            </button>
          </div>
        ) : webhook !== undefined ? (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={actions.pending}
            onClick={() => onRequestDelete({ kind: 'webhook', id: webhook.id })}
          >
            <HelmxIcon name="trash-2" size={12} />
            <span>{t(TRIGGERS_DELETE)}</span>
          </button>
        ) : undefined
      }
    >
      {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

      {cronJob !== undefined ? (
        <>
          <KvGrid
            items={[
              { key: t(TRIGGERS_KV_DESCRIPTION), value: cronJob.description ?? '—' },
              { key: t(TRIGGERS_KV_CRON_EXPRESSION), value: <span className="mono">{cronJob.schedule}</span> },
              { key: t(TRIGGERS_KV_TIMEZONE), value: <span className="mono">{cronJob.timezone || 'UTC'}</span> },
              { key: t(TRIGGERS_KV_CATCH_UP), value: cronJob.catchUp ? t(TRIGGERS_ON) : t(TRIGGERS_OFF) },
              { key: t(TRIGGERS_KV_DELIVERY_TARGET), value: formatTriggerTargetSummary(cronJob, locale) },
              { key: t(TRIGGERS_KV_LAST_RUN), value: formatTime(cronJob.lastRunAt) || '—' },
              { key: t(TRIGGERS_KV_NEXT_RUN), value: formatTime(cronJob.nextRunAt) || '—' },
              ...(cronJob.lastSkippedAt !== undefined
                ? [
                    {
                      key: t(TRIGGERS_KV_LAST_SKIPPED),
                      value: cronJob.lastSkipReason
                        ? `${formatTime(cronJob.lastSkippedAt)} (${cronJob.lastSkipReason})`
                        : formatTime(cronJob.lastSkippedAt) || '—',
                    },
                  ]
                : []),
            ]}
          />

          <ScreenSection title={t(TRIGGERS_COMMAND_SECTION)}>
            <pre className="tg-detail-text selectable mono">{cronJob.text}</pre>
          </ScreenSection>

          {cronJob.lastError !== undefined && cronJob.lastError !== '' ? (
            <div className="callout callout-error" role="alert">
              <HelmxIcon name="alert-circle" size={13} />
              <span className="callout-text selectable">{cronJob.lastError}</span>
            </div>
          ) : null}
        </>
      ) : webhook !== undefined ? (
        <KvGrid
          items={[
            { key: t(TRIGGERS_KV_DESCRIPTION), value: webhook.description ?? '—' },
            { key: t(TRIGGERS_KV_DELIVERY_TARGET), value: formatTriggerTargetSummary(webhook, locale) },
            { key: t(TRIGGERS_KV_SECRET_STATE), value: webhook.hasSecret ? t(TRIGGERS_SECRET_CONFIGURED) : t(TRIGGERS_SECRET_MISSING) },
            { key: t(TRIGGERS_KV_CREATED), value: formatTime(webhook.createdAt) || '—' },
          ]}
        />
      ) : null}

      {targetConversationId !== undefined ? (
        <ScreenSection title={t(TRIGGERS_TARGET_CONVERSATION_SECTION)}>
          {targetConversation !== undefined ? (
            <TriggerRunRow
              run={targetConversation}
              nowMs={nowMs}
              onPeek={peekConversation}
              onOpen={openConversation}
            />
          ) : (
            <div className="tg-run-actions">
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => peekConversation(targetConversationId)}
              >
                <HelmxIcon name="panel-right" size={11} />
                <span>{t(TRIGGERS_PEEK_CONVERSATION)} #{targetConversationId}</span>
              </button>
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => openConversation(targetConversationId)}
              >
                <HelmxIcon name="external-link" size={11} />
                <span>{t(TRIGGERS_OPEN_CONVERSATION)}</span>
              </button>
            </div>
          )}
        </ScreenSection>
      ) : (
        <ScreenSection title={`${t(TRIGGERS_RUNS_SECTION)} (${runs.length})`}>
          {runs.length === 0 ? (
            <div className="tg-note">{t(TRIGGERS_RUNS_EMPTY)}</div>
          ) : (
            <div className="tg-runs-list">
              {runs.map((run) => (
                <TriggerRunRow
                  key={run.id}
                  run={run}
                  nowMs={nowMs}
                  onPeek={peekConversation}
                  onOpen={openConversation}
                />
              ))}
            </div>
          )}
        </ScreenSection>
      )}
    </DetailDrawer>
  )
}

/** Trigger manager fullscreen view (cron + webhook tables + row-click detail drawer; one shared action mutex across both tables). */
export function TriggersManagerScreen(
  props: ScreenProps & { inlineDrawer?: boolean },
): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const actions = usePluginAction({
    formatError: (err, actionId) =>
      triggersActionFailed(actionId, err instanceof Error ? err.message : String(err), locale),
  })
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const conversations = useConversations()
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)
  const [selection, setSelection] = useState<TriggerDetailSelection | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TriggerDetailSelection | null>(null)

  const selectedCron =
    selection?.kind === 'cron' ? jobs.find((job) => job.id === selection.id) : undefined
  const selectedWebhook =
    selection?.kind === 'webhook' ? hooks.find((hook) => hook.id === selection.id) : undefined

  const confirmDelete = (): void => {
    const target = pendingDelete
    if (target === null) return
    setPendingDelete(null)
    if (target.kind === 'cron') {
      void actions.run('cron_delete', { id: target.id }, { key: `delete:${target.id}` })
    } else {
      void actions.run('webhook_delete', { id: target.id }, { key: `webhook-delete:${target.id}` })
    }
  }

  return (
    <Screen
      title={
        <>
          <HelmxIcon name="clock" size={15} />
          <span>{t(TRIGGERS_SCREEN_TITLE)}</span>
        </>
      }
      subtitle={
        <>
          Cron {jobs.length} · Webhook {hooks.length}
          {props.isSplit ? t(TRIGGERS_SPLIT_SUFFIX) : ''}
        </>
      }
    >
      {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

      <ScreenSection
        title={
          <>
            <HelmxIcon name="clock" size={13} />
            <span>{t(TRIGGERS_CRON_SECTION)}</span>
          </>
        }
      >
        <CronTable
          jobs={jobs}
          conversations={conversations}
          loading={crons === undefined}
          actions={actions}
          selectedId={selectedCron?.id}
          onSelect={(id) => setSelection({ kind: 'cron', id })}
          onRequestDelete={(id) => setPendingDelete({ kind: 'cron', id })}
        />
      </ScreenSection>

      <ScreenSection
        title={
          <>
            <HelmxIcon name="webhook" size={13} />
            <span>{t(TRIGGERS_WEBHOOK_SECTION)}</span>
          </>
        }
      >
        <WebhookTable
          webhooks={hooks}
          conversations={conversations}
          loading={webhooks === undefined}
          actions={actions}
          selectedId={selectedWebhook?.id}
          onSelect={(id) => setSelection({ kind: 'webhook', id })}
          onRequestDelete={(id) => setPendingDelete({ kind: 'webhook', id })}
        />
      </ScreenSection>

      <div className="tg-note">{t(TRIGGERS_MANAGER_NOTE)}</div>

      {(selectedCron !== undefined || selectedWebhook !== undefined) && (
        <TriggerDetailDrawer
          cronJob={selectedCron}
          webhook={selectedWebhook}
          conversations={conversations}
          actions={actions}
          inline={props.inlineDrawer}
          onClose={() => setSelection(null)}
          onRequestDelete={setPendingDelete}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={
          pendingDelete?.kind === 'webhook'
            ? t(TRIGGERS_CONFIRM_DELETE_WEBHOOK_TITLE)
            : t(TRIGGERS_CONFIRM_DELETE_CRON_TITLE)
        }
        description={
          pendingDelete !== null
            ? triggersConfirmDeleteBody(pendingDelete.kind, pendingDelete.id, locale)
            : ''
        }
        confirmText={t(TRIGGERS_DELETE)}
        cancelText={t(TRIGGERS_CANCEL)}
        danger
        inline={props.inlineDrawer}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  )
}
