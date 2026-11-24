/**
 * Composer-dock in-flight activity HUD (`COMPOSER_DOCK_SLOT`) for builtin:workflow.
 * Returns null (0px) when no tasks are active; isolates 1Hz ticking inside the
 * active inner view so idle conversations incur zero timer renders.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import {
  Badge,
  Button,
  DockTray,
  DockTrayRow,
  formatStopwatchMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  useSharedNowMs,
} from '@helmx/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  COPY,
  actionFailedNotice,
  statusLabel,
  traceOpenChildLabel,
  traceOpenWorkbenchRunLabel,
  trayAwaitingElapsed,
  trayCountLabel,
} from './copy.js'
import {
  buildActiveTraySummary,
  executionLightStatus,
  resolveLiveSnippet,
  type ActiveTrayItem,
  type ActiveTraySummary,
} from './execution-model.js'
import { useWorkflowRunsDoc } from './hooks.js'

function ActiveTrayLiveLine(props: {
  conversationId: number | undefined
  runId?: string
  runs: ReadonlyArray<WorkflowRunSummary>
  fallback?: string
  inline?: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const conv = useConversation(props.conversationId, { includeDetail: false })
  const pendingAsk = conv.pendingAsks[0]
  const bgRun = props.runId !== undefined ? props.runs.find((r) => r.id === props.runId) : undefined
  const isBlocked = pendingAsk !== undefined || (conv.summary?.pendingAskCount ?? 0) > 0 || conv.summary?.status === 'blocked'
  const snippet =
    props.conversationId !== undefined &&
    (conv.summary !== undefined || conv.live !== undefined || pendingAsk !== undefined || bgRun !== undefined || conv.loadError !== undefined)
      ? resolveLiveSnippet(
          {
            status: isBlocked ? 'blocked' : 'working',
            summary: conv.summary,
            live: conv.live,
            pendingAsk,
            run: bgRun,
            loadError: conv.loadError,
          },
          locale,
        )
      : undefined
  const text = snippet !== undefined ? (snippet.tag ? `${snippet.tag}: ${snippet.text}` : snippet.text) : props.fallback
  if (!text || text.trim() === '') return null
  return (
    <span
      className={props.inline ? 'dock-tray-frontline' : 'dock-tray-row-live'}
      title={text}
    >
      {text}
    </span>
  )
}

function ActiveTrayInner(props: {
  conversationId: number
  summary: ActiveTraySummary
  runs: ReadonlyArray<WorkflowRunSummary>
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { conversationId, summary, runs } = props

  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const hasTimer = summary.earliestStartedAt !== undefined || summary.earliestPendingAskSince !== undefined
  const nowMs = useSharedNowMs(hasTimer)

  const abortCtl = usePluginAction({
    notifyError: true,
    formatError: (err) => actionFailedNotice(t(COPY.abort), err instanceof Error ? err.message : String(err), locale),
  })

  const hasBlocked = summary.blockedCount > 0
  const singleItem = summary.items.length === 1 ? summary.items[0] : undefined
  const headlineItem = singleItem ?? summary.items.find((i) => i.activityConversationId !== undefined)

  const trayElapsed =
    hasBlocked && nowMs !== undefined && summary.earliestPendingAskSince !== undefined
      ? trayAwaitingElapsed(formatStopwatchMs(Math.max(0, nowMs - summary.earliestPendingAskSince)), locale)
      : nowMs !== undefined && summary.earliestStartedAt !== undefined
        ? formatStopwatchMs(Math.max(0, nowMs - summary.earliestStartedAt))
        : undefined

  const countText = trayCountLabel(summary.blockedCount, summary.runningCount, summary.activeCount, locale)
  const frontline =
    headlineItem !== undefined ? (
      <ActiveTrayLiveLine
        conversationId={headlineItem.activityConversationId ?? headlineItem.conversationId}
        runId={headlineItem.runId}
        runs={runs}
        fallback={headlineItem.doing}
        inline
      />
    ) : undefined

  const renderRow = (item: ActiveTrayItem): ReactNode => {
    const waitingMs =
      item.isBlocked && nowMs !== undefined && item.pendingAskSince !== undefined
        ? Math.max(0, nowMs - item.pendingAskSince)
        : undefined
    const itemElapsed =
      waitingMs !== undefined
        ? trayAwaitingElapsed(formatStopwatchMs(waitingMs), locale)
        : nowMs !== undefined && item.startedAt !== undefined
          ? formatStopwatchMs(Math.max(0, nowMs - item.startedAt))
          : undefined

    const openRow =
      item.conversationId !== undefined
        ? () => ctx.openConversationDrawer(item.conversationId!)
        : item.runId !== undefined
          ? () => ctx.openWorkbench('tasks', { runId: item.runId })
          : undefined

    const openAria =
      item.conversationId !== undefined
        ? `${item.title} — ${traceOpenChildLabel(item.conversationId, locale)}`
        : item.runId !== undefined
          ? `${item.title} — ${traceOpenWorkbenchRunLabel(item.runId, locale)}`
          : item.title

    return (
      <DockTrayRow
        key={item.key}
        status={executionLightStatus(item.isBlocked ? 'blocked' : 'working')}
        statusLabel={statusLabel(item.isBlocked ? 'blocked' : 'working', locale)}
        title={item.title}
        idText={item.conversationId !== undefined && !item.isFallbackTitle ? `#${item.conversationId}` : undefined}
        badge={
          item.progress !== undefined ? (
            <Badge tone="neutral" className="dock-tray-badge tabular-nums">
              {`${item.progress.done}/${item.progress.total}`}
            </Badge>
          ) : undefined
        }
        elapsed={itemElapsed}
        live={
          <ActiveTrayLiveLine
            conversationId={item.activityConversationId ?? item.conversationId}
            runId={item.runId}
            runs={runs}
            fallback={item.doing}
          />
        }
        onOpen={openRow}
        openAriaLabel={openAria}
        actions={
          item.canAbort && item.runId !== undefined ? (
            <Button
              variant="danger"
              size="xs"
              icon="square"
              disabled={abortCtl.pending}
              title={t(COPY.abort)}
              aria-label={t(COPY.abort)}
              onClick={() => void abortCtl.run('abort', { runId: item.runId! }, { key: `abort:${item.runId!}` })}
            >
              <span className="dock-tray-action-label">{t(COPY.abort)}</span>
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <DockTray
      warn={hasBlocked}
      regionLabel={t(COPY.trayRegionAria)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={`${countText} — ${t(expanded ? COPY.trayCollapse : COPY.trayExpand)}`}
      toggleTitle={t(expanded ? COPY.trayCollapse : COPY.trayExpand)}
      status={executionLightStatus(hasBlocked ? 'blocked' : 'working')}
      statusLabel={statusLabel(hasBlocked ? 'blocked' : 'working', locale)}
      badge={
        singleItem?.progress !== undefined ? (
          <Badge tone="neutral" className="dock-tray-badge tabular-nums">
            {`${singleItem.progress.done}/${singleItem.progress.total}`}
          </Badge>
        ) : undefined
      }
      count={expanded || singleItem === undefined ? countText : singleItem.title}
      frontline={frontline}
      elapsed={trayElapsed}
      barAction={
        <Button
          variant="ghost"
          size="xs"
          icon="workflow"
          className="dock-tray-workbench dock-tray-workbench-btn"
          title={t(COPY.trayWorkbench)}
          aria-label={t(COPY.trayWorkbench)}
          onClick={() => ctx.openWorkbench('tasks')}
        >
          <span className="dock-tray-action-label">{t(COPY.trayWorkbench)}</span>
        </Button>
      }
    >
      {summary.items.map(renderRow)}
    </DockTray>
  )
}

export function WorkflowActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const { runs } = useWorkflowRunsDoc(conversationId)
  const conversations = useConversations()

  const summary = useMemo(
    () =>
      conversationId === undefined
        ? undefined
        : buildActiveTraySummary({ rootConversationId: conversationId, conversations, runs }, locale),
    [conversationId, conversations, runs, locale],
  )

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }
  return <ActiveTrayInner conversationId={conversationId} summary={summary} runs={runs} />
}
