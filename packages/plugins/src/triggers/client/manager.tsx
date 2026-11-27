/**
 * builtin:triggers fullscreen manager surface (component exports only, Fast
 * Refresh contract):
 * - TriggersManagerScreen: unified single-bar `<Screen toolbar>` (`Cron | Webhook`
 *   `<SegmentedControl size="sm">` with `<TabCount>` + `<SearchBox variant="toolbar" size="sm">`)
 *   + `<List>` / `<ListRow>` + right-side `<DetailDrawer>` showing live run history
 *   projected directly from `useConversations()` (zero double-writing in docs)
 *   with one-click drawer peek (`openConversationDrawer`) and main-stage jump;
 * - Row actions (`cron_trigger` / `cron_delete` / `webhook_delete`) share one
 *   `usePluginAction` mutex across both tabs.
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
  DetailDrawer,
  EmptyState,
  HelmxIcon,
  IconButton,
  KvGrid,
  List,
  ListRow,
  LoadingState,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  SegmentedControl,
  Stack,
  StatusLight,
  TabCount,
  Tooltip,
  formatDurationMs,
  formatStopwatchMs,
  formatTime,
  resolveConversationTiming,
  type StatusLightTone,
} from '@helmx/ui'
import {
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useScreenDrawer,
  useSharedNowMs,
  type UsePluginActionResult,
} from '@helmx/plugin-client'
import {
  asAlertingRunStatus,
  encodeTriggerSelection,
  filterCronJobs,
  filterWebhooks,
  formatTriggerTargetSummary,
  parseCronJobs,
  parseTriggerSelection,
  parseWebhooks,
  selectTriggerRuns,
  summarizeTriggerRunHealth,
  triggerRunStatusLabel,
  type AlertingRunStatus,
  type CronJobRow,
  type TriggerDetailSelection,
  type TriggersManagerTab,
  type WebhookRow,
} from './models.ts'
import {
  TRIGGERS_CANCEL,
  TRIGGERS_CLOSE,
  TRIGGERS_COMMAND_SECTION,
  TRIGGERS_CONFIRM_DELETE_CRON_TITLE,
  TRIGGERS_CONFIRM_DELETE_WEBHOOK_TITLE,
  TRIGGERS_CRON_DETAIL_SUBTITLE,
  TRIGGERS_CRON_EMPTY,
  TRIGGERS_CRON_LOADING,
  TRIGGERS_CRON_SECTION,
  TRIGGERS_DELETE,
  TRIGGERS_DETAIL_TITLE,
  TRIGGERS_DISABLED,
  TRIGGERS_ENABLED,
  TRIGGERS_FILTER_EMPTY,
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
  TRIGGERS_RESET_FILTERS,
  TRIGGERS_RUNS_EMPTY,
  TRIGGERS_RUNS_SECTION,
  TRIGGERS_SCREEN_TITLE,
  TRIGGERS_SEARCH_PLACEHOLDER,
  TRIGGERS_SECRET_CONFIGURED,
  TRIGGERS_SECRET_MISSING,
  TRIGGERS_TARGET_CONVERSATION_SECTION,
  TRIGGERS_TRIGGER_NOW,
  TRIGGERS_WEBHOOK_DETAIL_SUBTITLE,
  TRIGGERS_WEBHOOK_EMPTY,
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
    <ListRow
      data-run-id={run.id}
      tone={run.status === 'error' ? 'danger' : run.status === 'blocked' ? 'warn' : 'default'}
      leading={<StatusLight status={run.status} label={statusLabel} />}
      title={
        <span className="tg-run-head">
          <span className="tg-run-title">{titleText}</span>
          <span className="tg-run-id mono">#{run.id}</span>
        </span>
      }
      meta={
        <>
          <span className="tabular-nums">{formatTime(run.createdAt) || '—'}</span>
          {durationText !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="mono tabular-nums">{durationText}</span>
            </>
          ) : null}
        </>
      }
      description={
        run.status === 'error' && run.lastError ? (
          <span className="tg-row-err" title={run.lastError}>{run.lastError}</span>
        ) : undefined
      }
      trailing={
        <Tooltip content={t(TRIGGERS_OPEN_CONVERSATION)} side="top">
          <IconButton
            icon="external-link"
            size="xs"
            variant="ghost"
            className="tg-run-open-btn"
            label={`${t(TRIGGERS_OPEN_CONVERSATION)} #${run.id}`}
            onClick={() => onOpen(run.id)}
          />
        </Tooltip>
      }
      aria-label={`${t(TRIGGERS_PEEK_CONVERSATION)} #${run.id}`}
      onSelect={() => onPeek(run.id)}
    />
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
      footer={
        cronJob !== undefined ? (
          <>
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
            <div className="flex-1" />
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
          </>
        ) : webhook !== undefined ? (
          <>
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
            <div className="flex-1" />
          </>
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
            <List density="compact" label={t(TRIGGERS_TARGET_CONVERSATION_SECTION)}>
              <TriggerRunRow
                run={targetConversation}
                nowMs={nowMs}
                onPeek={peekConversation}
                onOpen={openConversation}
              />
            </List>
          ) : (
            <Stack direction="horizontal" gap="sm" align="center" wrap>
              <Button
                variant="secondary"
                size="xs"
                icon="panel-right"
                onClick={() => peekConversation(targetConversationId)}
              >
                {t(TRIGGERS_PEEK_CONVERSATION)} #{targetConversationId}
              </Button>
              <Button
                variant="secondary"
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
            <List density="compact" label={t(TRIGGERS_RUNS_SECTION)}>
              {runs.map((run) => (
                <TriggerRunRow
                  key={run.id}
                  run={run}
                  nowMs={nowMs}
                  onPeek={peekConversation}
                  onOpen={openConversation}
                />
              ))}
            </List>
          )}
        </ScreenSection>
      )}
    </DetailDrawer>
  )
}

/** Trigger manager fullscreen view (single-bar segmented toolbar + Hairline Roster Lists + right-side DetailDrawer). */
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
  const jobs = useMemo(() => parseCronJobs(crons), [crons])
  const hooks = useMemo(() => parseWebhooks(webhooks), [webhooks])
  const docsLoading = crons === undefined && webhooks === undefined

  const [activeTab, setActiveTabState] = useState<TriggersManagerTab>(() =>
    props.params?.['tab'] === 'webhook' ? 'webhook' : 'cron',
  )
  const urlTab = props.params?.['tab']
  useEffect(() => {
    if (urlTab === 'webhook') setActiveTabState('webhook')
    else if (urlTab === 'cron') setActiveTabState('cron')
  }, [urlTab])

  const setActiveTab = (next: TriggersManagerTab): void => {
    setActiveTabState(next)
    props.setParams?.({ tab: next === 'cron' ? undefined : next })
  }

  const [query, setQuery] = useState('')
  const filteredJobs = useMemo(() => filterCronJobs(jobs, query), [jobs, query])
  const filteredHooks = useMemo(() => filterWebhooks(hooks, query), [hooks, query])

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
      title={t(TRIGGERS_SCREEN_TITLE)}
      toolbar={
        <ScreenToolbar
          label={t(TRIGGERS_SCREEN_TITLE)}
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder={t(TRIGGERS_SEARCH_PLACEHOLDER)}
              ariaLabel={t(TRIGGERS_SEARCH_PLACEHOLDER)}
            />
          }
        >
          <SegmentedControl
            size="sm"
            aria-label={t(TRIGGERS_SCREEN_TITLE)}
            value={activeTab}
            onValueChange={(next) => setActiveTab(next === 'webhook' ? 'webhook' : 'cron')}
            items={[
              {
                value: 'cron',
                label: t(TRIGGERS_CRON_SECTION),
                badge: <TabCount>{jobs.length}</TabCount>,
              },
              {
                value: 'webhook',
                label: t(TRIGGERS_WEBHOOK_SECTION),
                badge: <TabCount>{hooks.length}</TabCount>,
              },
            ]}
          />
        </ScreenToolbar>
      }
    >
      {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

      {activeTab === 'cron' ? (
        crons === undefined ? (
          <LoadingState label={t(TRIGGERS_CRON_LOADING)} />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon="clock"
            title={t(TRIGGERS_CRON_EMPTY)}
            hint={t(TRIGGERS_MANAGER_NOTE)}
            hintSubtle
          />
        ) : filteredJobs.length === 0 ? (
          <EmptyState
            icon="search"
            title={t(TRIGGERS_FILTER_EMPTY)}
            action={
              <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={() => setQuery('')}>
                {t(TRIGGERS_RESET_FILTERS)}
              </Button>
            }
          />
        ) : (
          <>
            <List label={t(TRIGGERS_CRON_SECTION)}>
              {filteredJobs.map((job) => {
                const runs = selectTriggerRuns(conversations, 'cron', job.id)
                const health = summarizeTriggerRunHealth(runs)
                const alerting = asAlertingRunStatus(health.status)
                const nextOrLastTime = formatTime(job.nextRunAt) || formatTime(job.lastRunAt)

                return (
                  <ListRow
                    key={job.id}
                    data-trigger-kind="cron"
                    data-trigger-id={job.id}
                    selected={selectedCron?.id === job.id}
                    tone={
                      job.lastError || alerting === 'error'
                        ? 'danger'
                        : alerting === 'blocked' || !job.enabled
                          ? 'warn'
                          : 'default'
                    }
                    leading={
                      alerting !== undefined ? (
                        <StatusLight
                          tone={triggerHealthTone(alerting)}
                          label={triggerRunStatusLabel(alerting, locale)}
                        />
                      ) : (
                        <StatusLight
                          tone={job.enabled ? 'done' : 'pending'}
                          label={job.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
                        />
                      )
                    }
                    title={<span className="mono">{job.id}</span>}
                    meta={
                      <>
                        <code className="mono">{job.schedule}</code>
                        <Badge tone={job.enabled ? 'ok' : 'neutral'}>
                          {job.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
                        </Badge>
                        {job.lastError ? (
                          <span className="tg-row-err" title={job.lastError}>
                            {job.lastError}
                          </span>
                        ) : null}
                      </>
                    }
                    description={job.text}
                    trailing={
                      <Stack direction="horizontal" align="center" gap="sm">
                        {nextOrLastTime ? (
                          <span className="mono text-muted tabular-nums tg-row-time">{nextOrLastTime}</span>
                        ) : null}
                        <Button
                          size="xs"
                          variant="secondary"
                          icon="zap"
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
                        >
                          {t(TRIGGERS_TRIGGER_NOW)}
                        </Button>
                      </Stack>
                    }
                    actions={
                      <IconButton
                        icon="trash-2"
                        size="xs"
                        variant="ghost"
                        className="tg-row-delete-btn"
                        label={`${t(TRIGGERS_DELETE)} ${job.id}`}
                        disabled={actions.pending}
                        pending={actions.pendingKey === `delete:${job.id}`}
                        onClick={() => setPendingDelete({ kind: 'cron', id: job.id })}
                      />
                    }
                    onSelect={() => drawer.openItem(encodeTriggerSelection({ kind: 'cron', id: job.id }))}
                  />
                )
              })}
            </List>
            <div className="tg-note">{t(TRIGGERS_MANAGER_NOTE)}</div>
          </>
        )
      ) : webhooks === undefined ? (
        <LoadingState label={t(TRIGGERS_WEBHOOK_LOADING)} />
      ) : hooks.length === 0 ? (
        <EmptyState
          icon="webhook"
          title={t(TRIGGERS_WEBHOOK_EMPTY)}
          hint={t(TRIGGERS_MANAGER_NOTE)}
          hintSubtle
        />
      ) : filteredHooks.length === 0 ? (
        <EmptyState
          icon="search"
          title={t(TRIGGERS_FILTER_EMPTY)}
          action={
            <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={() => setQuery('')}>
              {t(TRIGGERS_RESET_FILTERS)}
            </Button>
          }
        />
      ) : (
        <>
          <List label={t(TRIGGERS_WEBHOOK_SECTION)}>
            {filteredHooks.map((hook) => {
              const runs = selectTriggerRuns(conversations, 'webhook', hook.id)
              const health = summarizeTriggerRunHealth(runs)
              const alerting = asAlertingRunStatus(health.status)

              return (
                <ListRow
                  key={hook.id}
                  data-trigger-kind="webhook"
                  data-trigger-id={hook.id}
                  selected={selectedWebhook?.id === hook.id}
                  tone={alerting === 'error' ? 'danger' : alerting === 'blocked' ? 'warn' : 'default'}
                  leading={
                    alerting !== undefined ? (
                      <StatusLight
                        tone={triggerHealthTone(alerting)}
                        label={triggerRunStatusLabel(alerting, locale)}
                      />
                    ) : (
                      <HelmxIcon name="webhook" size={13} className="text-muted" />
                    )
                  }
                  title={<span className="mono">{hook.id}</span>}
                  meta={<Badge tone="neutral">{formatTriggerTargetSummary(hook, locale)}</Badge>}
                  description={hook.description || undefined}
                  trailing={
                    <span className="mono text-muted tabular-nums tg-row-time">
                      {formatTime(hook.createdAt) || '—'}
                    </span>
                  }
                  actions={
                    <IconButton
                      icon="trash-2"
                      size="xs"
                      variant="ghost"
                      className="tg-row-delete-btn"
                      label={`${t(TRIGGERS_DELETE)} ${hook.id}`}
                      disabled={actions.pending}
                      pending={actions.pendingKey === `webhook-delete:${hook.id}`}
                      onClick={() => setPendingDelete({ kind: 'webhook', id: hook.id })}
                    />
                  }
                  onSelect={() => drawer.openItem(encodeTriggerSelection({ kind: 'webhook', id: hook.id }))}
                />
              )
            })}
          </List>
          <div className="tg-note">{t(TRIGGERS_MANAGER_NOTE)}</div>
        </>
      )}

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
