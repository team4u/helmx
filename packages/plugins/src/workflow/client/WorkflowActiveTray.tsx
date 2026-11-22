/**
 * builtin:workflow bottom in-flight activity tray (COMPOSER_DOCK_SLOT
 * extension point): renders a compact 32px single-line HUD only when the
 * current conversation or its descendants have in-flight tasks (running /
 * blocked / background subagents), with an expandable concurrent list and
 * one-click access to the workbench / drawer / abort / detach; returns null
 * once everything settles (0px, never occupying space).
 *
 * Interaction contract (card de-clutter pass, a11y-legal structure):
 * - the bar is a flex row whose main region is one real toggle <button>
 *   (aria-expanded / aria-controls); the Workbench action is a sibling
 *   button — no interactive element ever nests inside another;
 * - every expanded row is one real detail-entry <button> covering the row
 *   body (conversationId opens the ConversationDrawer, else runId focuses
 *   the run in the workbench); detach / abort are sibling buttons in the
 *   trailing action group — no stopPropagation acrobatics needed;
 * - the row body is a single-line layout isomorphic to the collapsed bar:
 *   status light, title / #id / progress / elapsed and the current execution
 *   content (live tool semantics / output / thinking / approval title,
 *   falling back to the model-provided doing digest) share one row — the
 *   live line takes the remaining width as a single-line ellipsis, so row
 *   height is constant and live-text length changes never make the tray or
 *   composer jump;
 * - live facts come from the host snapshot through useConversation with
 *   includeDetail:false (never an eager detail fetch) shared with the
 *   timeline subagent cards via resolveSubagentHeaderSnippet; collapsed bar
 *   prefers the current progress / approval content, expanded bar shows the
 *   concise task count instead of repeating task names.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  DockTray,
  DockTrayRow,
  formatStopwatchMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildActiveTraySummary, type ActiveTrayItem } from './model-active-tray.ts'
import { resolveSubagentHeaderSnippet } from './model-subagent-card.ts'
import {
  ACTION_ABORT,
  execConversationTitle,
  executionStatusLabel,
  TRAY_COLLAPSE,
  TRAY_EXPAND,
  TRAY_REGION_ARIA,
  TRAY_WORKBENCH,
  trayActionFailed,
  trayAwaitingApprovalElapsed,
  trayCount,
  trayRowOpenConversationLabel,
  trayRowOpenRunLabel,
  trayToggleLabel,
} from './copy.ts'

/**
 * Single row activity line: host-snapshot live facts via
 * useConversation(includeDetail:false) + resolveSubagentHeaderSnippet (same
 * derivation as the timeline subagent cards), falling back to the
 * model-provided doing digest when the host has no facts for the target.
 * Blocked-ness is judged from the activity conversation's own facts
 * (pendingAsk / status), never from the row aggregate — a container row
 * blocked elsewhere in its subtree must not fake an approval line onto a
 * working descendant. `inline` renders the one-line ellipsis bar variant
 * instead of the two-line row variant. A standalone component so the hook is
 * never called directly inside a list map.
 */
function ActiveTrayLiveLine(props: {
  conversationId: number | undefined
  runId?: string
  runs: ReadonlyArray<WorkflowRunSummary>
  fallback?: string
  inline?: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const conv = useConversation(props.conversationId, { includeDetail: false })
  const summary = conv.summary
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const backgroundRun =
    props.runId !== undefined ? props.runs.find((r) => r.id === props.runId) : undefined
  const hasHostFacts =
    summary !== undefined ||
    live !== undefined ||
    pendingAsk !== undefined ||
    backgroundRun !== undefined ||
    conv.loadError !== undefined
  const snippet =
    props.conversationId === undefined || !hasHostFacts
      ? undefined
      : resolveSubagentHeaderSnippet(
          {
            badgeStatus:
              pendingAsk !== undefined || (summary?.pendingAskCount ?? 0) > 0 || summary?.status === 'blocked'
                ? 'blocked'
                : 'working',
            ...(summary !== undefined ? { summary } : {}),
            ...(live !== undefined ? { live } : {}),
            ...(pendingAsk !== undefined ? { pendingAsk } : {}),
            ...(backgroundRun !== undefined ? { backgroundRun } : {}),
            ...(conv.loadError !== undefined ? { detailError: conv.loadError } : {}),
          },
          locale,
        )

  const text =
    snippet !== undefined
      ? snippet.tag !== undefined
        ? `${snippet.tag}: ${snippet.text}`
        : snippet.text
      : props.fallback
  if (text === undefined || text.trim() === '') return null
  return (
    <span
      className={
        props.inline === true
          ? 'dock-tray-frontline workflow-active-tray-frontline'
          : 'dock-tray-row-live workflow-active-tray-row-live'
      }
      title={text}
    >
      {text}
    </span>
  )
}

function WorkflowActiveTrayRow(props: {
  item: ActiveTrayItem
  rootConversationId: number
  runs: ReadonlyArray<WorkflowRunSummary>
  nowMs: number | undefined
  busy: boolean
  onAbort: (runId: string) => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { item } = props

  const waitingMs =
    item.isBlocked && props.nowMs !== undefined && item.pendingAskSince !== undefined
      ? Math.max(0, props.nowMs - item.pendingAskSince)
      : undefined
  const itemElapsed =
    waitingMs !== undefined
      ? trayAwaitingApprovalElapsed(formatStopwatchMs(waitingMs), locale)
      : props.nowMs !== undefined && item.startedAt !== undefined
        ? formatStopwatchMs(Math.max(0, props.nowMs - item.startedAt))
        : undefined
  const isFallbackConvTitle =
    item.conversationId !== undefined && item.title === execConversationTitle(item.conversationId, locale)
  const openRow = (): void => {
    if (item.conversationId !== undefined) {
      ctx.openConversationDrawer(item.conversationId)
      return
    }
    if (item.runId !== undefined) {
      ctx.openWorkbench('tasks', { runId: item.runId })
    }
  }
  const rowActivatable = item.conversationId !== undefined || item.runId !== undefined
  const rowLabel =
    item.conversationId !== undefined
      ? trayRowOpenConversationLabel(item.conversationId, locale)
      : item.runId !== undefined
        ? trayRowOpenRunLabel(item.runId, locale)
        : item.title
  const rowActions =
    item.canAbort && item.runId !== undefined ? (
      <button
        type="button"
        className="btn btn-xs btn-danger"
        disabled={props.busy}
        onClick={() => props.onAbort(item.runId!)}
      >
        <Icon name="square" size={11} />
        <span>{resolveLocalizedText(ACTION_ABORT, locale)}</span>
      </button>
    ) : undefined

  return (
    <DockTrayRow
      classPrefix="workflow-active-tray"
      status={item.isBlocked ? 'blocked' : 'running'}
      statusLabel={executionStatusLabel(item.isBlocked ? 'blocked' : 'working', locale)}
      title={item.title}
      idText={item.conversationId !== undefined && !isFallbackConvTitle ? `#${item.conversationId}` : undefined}
      badge={
        item.progress !== undefined ? (
          <span className="badge badge-neutral dock-tray-badge workflow-trace-badge tabular-nums">
            {`${item.progress.done}/${item.progress.total}`}
          </span>
        ) : undefined
      }
      elapsed={itemElapsed}
      live={
        <ActiveTrayLiveLine
          conversationId={item.activityConversationId ?? item.conversationId}
          runId={item.runId}
          runs={props.runs}
          fallback={item.doing}
        />
      }
      onOpen={rowActivatable ? openRow : undefined}
      openAriaLabel={`${item.title} — ${rowLabel}`}
      actions={rowActions}
    />
  )
}

export function WorkflowActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const runs = runsDoc?.runs ?? []
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const summary = useMemo(
    () =>
      conversationId === undefined
        ? undefined
        : buildActiveTraySummary(
            {
              rootConversationId: conversationId,
              conversations,
              runs,
            },
            locale,
          ),
    [conversationId, conversations, runs, locale],
  )

  const hasTimer =
    summary !== undefined &&
    summary.items.length > 0 &&
    (summary.earliestStartedAt !== undefined || summary.earliestPendingAskSince !== undefined)
  const nowMs = useElapsedNowMs(hasTimer)

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }

  const abortRun = (runId: string): void => {
    if (busyKey !== undefined) return
    setBusyKey(`abort:${runId}`)
    void ctx
      .callAction('abort', { runId })
      .catch((err: unknown) => {
        ctx.notify(trayActionFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => {
        setBusyKey(undefined)
      })
  }

  const countText = trayCount(summary.blockedCount, summary.runningCount, summary.activeCount, locale)
  const hasBlocked = summary.blockedCount > 0

  const singleItem = summary.items.length === 1 ? summary.items[0] : undefined
  const singleProgress = singleItem?.progress
  // Multi-task collapsed headline target: the first tray item carrying an
  // activity conversation of its own subtree (single-item trays reuse that
  // item); a container digest never overrides a real live target.
  const headlineItem =
    singleItem ?? summary.items.find((item) => item.activityConversationId !== undefined)
  const trayElapsed =
    hasBlocked && nowMs !== undefined && summary.earliestPendingAskSince !== undefined
      ? trayAwaitingApprovalElapsed(formatStopwatchMs(Math.max(0, nowMs - summary.earliestPendingAskSince)), locale)
      : nowMs !== undefined && summary.earliestStartedAt !== undefined
        ? formatStopwatchMs(Math.max(0, nowMs - summary.earliestStartedAt))
        : undefined
  const frontline =
    summary.approvals.length > 0 ? (
      <span className="dock-tray-frontline workflow-active-tray-frontline">{summary.approvals[0]!.text}</span>
    ) : headlineItem !== undefined ? (
      <ActiveTrayLiveLine
        conversationId={headlineItem.activityConversationId ?? headlineItem.conversationId}
        runId={headlineItem.runId}
        runs={runs}
        fallback={headlineItem.doing}
        inline
      />
    ) : summary.frontline.length > 0 ? (
      <span className="dock-tray-frontline workflow-active-tray-frontline">{summary.frontline[0]!.text}</span>
    ) : undefined

  return (
    <DockTray
      classPrefix="workflow-active-tray"
      warn={hasBlocked}
      regionLabel={resolveLocalizedText(TRAY_REGION_ARIA, locale)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={trayToggleLabel(expanded, countText, locale)}
      toggleTitle={resolveLocalizedText(expanded ? TRAY_COLLAPSE : TRAY_EXPAND, locale)}
      status={hasBlocked ? 'blocked' : 'running'}
      statusLabel={countText}
      badge={
        singleProgress !== undefined ? (
          <span className="badge badge-neutral dock-tray-badge workflow-trace-badge tabular-nums">
            {`${singleProgress.done}/${singleProgress.total}`}
          </span>
        ) : undefined
      }
      count={summary.items.length > 1 || expanded ? countText : undefined}
      frontline={frontline}
      elapsed={trayElapsed}
      barAction={
        <button
          type="button"
          className="btn btn-xs dock-tray-workbench workflow-active-tray-workbench"
          onClick={() => {
            const singleRunId = summary.items.length === 1 ? summary.items[0]?.runId : undefined
            ctx.openWorkbench('tasks', singleRunId !== undefined ? { runId: singleRunId } : undefined)
          }}
        >
          <Icon name="git-branch" size={11} />
          <span>{resolveLocalizedText(TRAY_WORKBENCH, locale)}</span>
        </button>
      }
    >
      {summary.items.map((item) => (
        <WorkflowActiveTrayRow
          key={item.key}
          item={item}
          rootConversationId={conversationId}
          runs={runs}
          nowMs={nowMs}
          busy={busyKey !== undefined}
          onAbort={abortRun}
        />
      ))}
    </DockTray>
  )
}
