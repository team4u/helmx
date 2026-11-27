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
import { useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ConversationSummary, ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  DetailDrawer,
  HelmxIcon,
  IconButton,
  KvGrid,
  Screen,
  ScreenSection,
  Stack,
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
  useScreenDrawer,
  useSharedNowMs,
  type StatusLightTone,
  type UsePluginActionResult,
} from '@helmx/plugin-client'
import {
  asAlertingRunStatus,
  encodeTriggerSelection,
  formatTriggerTargetSummary,
  parseCronJobs,
  parseTriggerSelection,
  parseWebhooks,
  selectableRowProps,
  selectTriggerRuns,
  summarizeTriggerRunHealth,
  triggerRunStatusLabel,
  type AlertingRunStatus,
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
  triggersCronDeletedNotice,
  triggersCronTriggeredNotice,
  triggersWebhookDeletedNotice,
} from './copy.ts'

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <Callout tone="err">
      <span className="callout-text">{message}</span>
    </Callout>
  )
}

function triggerHealthTone(status: AlertingRunStatus): StatusLightTone {
  return status === 'error' ? 'failed' : status
}

/** 表格首列：ID + 仅在告警态（error / blocked / working）常显的状态灯。 */
function TriggerIdCell({ id, status }: { id: string; status: AlertingRunStatus | undefined }): ReactNode {
  const locale = usePluginLocale()
  return (
    <td data-label="ID" className="mono">
      <span className="tg-id-cell">
        {status !== undefined ? (
          <StatusLight tone={triggerHealthTone(status)} label={triggerRunStatusLabel(status, locale)} />
        ) : null}
        <span>{id}</span>
      </span>
    </td>
  )
}

function RowAction({
  label,
  iconName,
  disabled,
  pending,
  danger,
  onClick,
}: {
  label: string
  iconName: string
  disabled?: boolean
  pending?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <Button
      size="xs"
      variant={danger === true ? 'danger' : 'secondary'}
      icon={iconName}
      disabled={disabled === true}
      pending={pending === true}
      onClick={onClick}
    >
      {label}
    </Button>
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
  const ctx = usePluginContext()
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
            return (
              <tr key={job.id} {...selectableRowProps(job.id, selectedId, onSelect)}>
                <TriggerIdCell id={job.id} status={asAlertingRunStatus(health.status)} />
                <td data-label={t(TRIGGERS_COL_SCHEDULE)} className="mono">{job.schedule}</td>
                <td data-label={t(TRIGGERS_COL_COMMAND)} className="cell-ellipsis" title={job.text}>{job.text}</td>
                <td data-label={t(TRIGGERS_COL_ENABLED)}>
                  <Badge tone={job.enabled ? 'ok' : 'neutral'}>
                    {job.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
                  </Badge>
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
                      pending={actions.pendingKey === `trigger:${job.id}`}
                      onClick={() =>
                        void actions.run(
                          'cron_trigger',
                          { id: job.id },
                          {
                            key: `trigger:${job.id}`,
                            onSuccess: () => ctx.notify(triggersCronTriggeredNotice(job.id, locale)),
                          },
                        )
                      }
                    />
                    <RowAction
                      label={t(TRIGGERS_DELETE)}
                      iconName="trash-2"
                      disabled={actions.pending}
                      pending={actions.pendingKey === `delete:${job.id}`}
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
            return (
              <tr key={hook.id} {...selectableRowProps(hook.id, selectedId, onSelect)}>
                <TriggerIdCell id={hook.id} status={asAlertingRunStatus(health.status)} />
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
                      pending={actions.pendingKey === `webhook-delete:${hook.id}`}
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
        <IconButton
          icon="external-link"
          size="xs"
          className="tg-run-open-btn"
          aria-label={`${t(TRIGGERS_OPEN_CONVERSATION)} #${run.id}`}
          onClick={() => onOpen(run.id)}
        />
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
          <Badge tone={cronJob.enabled ? 'ok' : 'neutral'}>
            {cronJob.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
          </Badge>
        ) : webhook !== undefined ? (
          <Badge tone="neutral">Webhook</Badge>
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
            <Button
              variant="danger"
              size="sm"
              icon="trash-2"
              disabled={actions.pending}
              pending={actions.pendingKey === `delete:${cronJob.id}`}
              onClick={() => onRequestDelete({ kind: 'cron', id: cronJob.id })}
            >
              {t(TRIGGERS_DELETE)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="zap"
              disabled={actions.pending}
              pending={actions.pendingKey === `trigger:${cronJob.id}`}
              onClick={() =>
                void actions.run(
                  'cron_trigger',
                  { id: cronJob.id },
                  {
                    key: `trigger:${cronJob.id}`,
                    onSuccess: () => ctx.notify(triggersCronTriggeredNotice(cronJob.id, locale)),
                  },
                )
              }
            >
              {t(TRIGGERS_TRIGGER_NOW)}
            </Button>
          </div>
        ) : webhook !== undefined ? (
          <Button
            variant="danger"
            size="sm"
            icon="trash-2"
            disabled={actions.pending}
            pending={actions.pendingKey === `webhook-delete:${webhook.id}`}
            onClick={() => onRequestDelete({ kind: 'webhook', id: webhook.id })}
          >
            {t(TRIGGERS_DELETE)}
          </Button>
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
            <Callout tone="err">
              <span className="callout-text selectable">{cronJob.lastError}</span>
            </Callout>
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
            <Stack direction="horizontal" gap="sm" align="center" wrap>
              <Button
                size="xs"
                icon="panel-right"
                onClick={() => peekConversation(targetConversationId)}
              >
                {t(TRIGGERS_PEEK_CONVERSATION)} #{targetConversationId}
              </Button>
              <Button
                size="xs"
                icon="external-link"
                onClick={() => openConversation(targetConversationId)}
              >
                {t(TRIGGERS_OPEN_CONVERSATION)}
              </Button>
            </Stack>
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
  const ctx = usePluginContext()
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
  const docsLoading = crons === undefined && webhooks === undefined
  const drawer = useScreenDrawer({
    param: 'trigger',
    hasItem: (raw) => {
      if (docsLoading) return true
      const parsed = parseTriggerSelection(raw)
      if (parsed === null) return false
      return parsed.kind === 'cron'
        ? jobs.some((job) => job.id === parsed.id)
        : hooks.some((hook) => hook.id === parsed.id)
    },
    scope: props,
  })
  const selection = parseTriggerSelection(drawer.itemId)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [pendingDelete, setPendingDelete] = useState<TriggerDetailSelection | null>(null)

  const selectedCron =
    selection?.kind === 'cron' ? jobs.find((job) => job.id === selection.id) : undefined
  const selectedWebhook =
    selection?.kind === 'webhook' ? hooks.find((hook) => hook.id === selection.id) : undefined
  const drawerVisible = selectedCron !== undefined || selectedWebhook !== undefined
  const wasDrawerVisibleRef = useRef(false)
  useEffect(() => {
    if (wasDrawerVisibleRef.current && !drawerVisible) {
      setPendingDelete(null)
    }
    wasDrawerVisibleRef.current = drawerVisible
  }, [drawerVisible])

  const confirmDelete = (): void => {
    const target = pendingDelete
    if (target === null) return
    setPendingDelete(null)
    if (target.kind === 'cron') {
      void actions.run(
        'cron_delete',
        { id: target.id },
        {
          key: `delete:${target.id}`,
          onSuccess: () => {
            ctx.notify(triggersCronDeletedNotice(target.id, locale))
            if (selectionRef.current?.kind === 'cron' && selectionRef.current.id === target.id) {
              drawer.close()
            }
          },
        },
      )
    } else {
      void actions.run(
        'webhook_delete',
        { id: target.id },
        {
          key: `webhook-delete:${target.id}`,
          onSuccess: () => {
            ctx.notify(triggersWebhookDeletedNotice(target.id, locale))
            if (selectionRef.current?.kind === 'webhook' && selectionRef.current.id === target.id) {
              drawer.close()
            }
          },
        },
      )
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
          onSelect={(id) => drawer.openItem(encodeTriggerSelection({ kind: 'cron', id }))}
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
          onSelect={(id) => drawer.openItem(encodeTriggerSelection({ kind: 'webhook', id }))}
          onRequestDelete={(id) => setPendingDelete({ kind: 'webhook', id })}
        />
      </ScreenSection>

      <div className="tg-note">{t(TRIGGERS_MANAGER_NOTE)}</div>

      {drawerVisible && (
        <TriggerDetailDrawer
          cronJob={selectedCron}
          webhook={selectedWebhook}
          conversations={conversations}
          actions={actions}
          inline={props.inlineDrawer}
          onClose={() => drawer.close()}
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
