/**
 * Timeline 26px trace rows for builtin:workflow:
 * - SubagentToolView (subagent tool call; subscribes with `includeDetail: false, includeLive: false`
 *   to eliminate 60Hz token re-renders across historical timeline rows);
 * - WorkflowToolView (SubagentWorkflow tool call);
 * - BackgroundReportCard (helmx.input background settlement receipt).
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TimelineRendererProps, ToolViewProps } from '@helmx/protocol'
import {
  Callout,
  CopyButton,
  HelmxIcon,
  KvGrid,
  MarkdownText,
  StatusLight,
  ToolCallDetails,
  formatCompactTimestamp,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
  useTimelineToolCalls,
  useToolActivity,
} from '@helmx/plugin-client'
import {
  COPY,
  reportToggleLabel,
  runStatusLabel,
  statusLabel,
  traceOpenChildLabel,
  traceOpenWorkbenchRunLabel,
  worktreeBadgeTitle,
} from './copy.js'
import { ElapsedClock, WorkflowTimingClock } from './ElapsedClock.js'
import {
  aggregateExecutionNodes,
  buildExecutionTree,
  buildLeafNodesForRun,
  effectiveRunStatus,
  executionLightStatus,
  extractToolMetaLabel,
  isBackgroundWorkflowResultHandle,
  isLatestSubagentCallForTarget,
  isManagedSpawnBranch,
  resolveNodeTitle,
  resolveRunDisplayName,
  resolveSubagentConversationId,
  resolveSubagentElapsedMs,
  resolveSubagentExecutionMeta,
  resolveWorkflowRunForTool,
  resolveWorkflowToolFallbackLabel,
  statusFromConversation,
  type ExecutionStatus,
} from './execution-model.js'
import { useWorkflowRunsDoc } from './hooks.js'
import {
  backgroundReportPreview,
  cleanInlineMarkdown,
  isBackgroundReportDefaultOpen,
  isPlaceholderRunName,
  parseBackgroundReportEntry,
  parseSubagentExecutionInfo,
  readToolPresentationMeta,
  type BackgroundReportView,
} from './parsers.js'

// ---------------------------------------------------------------------------
// 1. SubagentToolView (`subagent` tool call)
// ---------------------------------------------------------------------------

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const conversations = useConversations()
  const subagentCalls = useTimelineToolCalls('subagent')
  const viewerConversationId = props.conversationId ?? ctx.conversationId
  const { runs } = useWorkflowRunsDoc(viewerConversationId)

  const presentationMeta = useMemo(() => readToolPresentationMeta(props), [props])
  const execInfo = useMemo(() => parseSubagentExecutionInfo(presentationMeta), [presentationMeta])
  const execMeta = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentExecutionMeta({ callId: props.callId, presentationMeta }, viewerConversationId, runs)
        : undefined,
    [props.callId, presentationMeta, viewerConversationId, runs],
  )
  const childId = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentConversationId(
            { callId: props.callId, input: props.input, presentationMeta },
            viewerConversationId,
            conversations,
          )
        : undefined,
    [props.callId, props.input, presentationMeta, viewerConversationId, conversations],
  )

  // Key perf fix: includeDetail:false AND includeLive:false prevents 60Hz token stream re-renders in timelines.
  const childConv = useConversation(childId, { includeDetail: false, includeLive: false })
  const childSummary = useMemo(
    () => (childId !== undefined ? (conversations.find((c) => c.id === childId) ?? childConv.summary) : undefined),
    [childId, conversations, childConv.summary],
  )
  const backgroundRun = useMemo(() => {
    if (execMeta?.run !== undefined) return execMeta.run
    if (execInfo?.runId !== undefined) return runs.find((r) => r.id === execInfo.runId)
    return undefined
  }, [execMeta?.run, execInfo?.runId, runs])

  const isLatest = useMemo(
    () =>
      viewerConversationId === undefined
        ? true
        : isLatestSubagentCallForTarget(
            { callId: props.callId, timelineCalls: subagentCalls, conversationId: viewerConversationId },
            childId,
            conversations,
            execMeta?.executionId ?? execInfo?.executionId,
          ),
    [props.callId, subagentCalls, viewerConversationId, childId, conversations, execMeta?.executionId, execInfo?.executionId],
  )

  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const isBgHandle = execInfo?.background === true && execInfo.runId !== undefined
  const hasPendingAsk = isLatest && (childConv.pendingAsks.length > 0 || (childSummary?.pendingAskCount ?? 0) > 0)

  const status: ExecutionStatus = useMemo(() => {
    if (hasPendingAsk) return 'blocked'
    if (!isLatest) {
      return props.status === 'error' ? 'error' : props.status === 'running' ? 'working' : 'done'
    }
    if (backgroundRun === undefined && isBgHandle && props.status === 'done' && execInfo?.status === 'running') {
      return 'working'
    }
    return statusFromConversation(childSummary, backgroundRun, props.status)
  }, [hasPendingAsk, isLatest, childSummary, backgroundRun, props.status, isBgHandle, execInfo?.status])

  const isRunningInBackground =
    status === 'working' &&
    isLatest &&
    (backgroundRun?.status === 'running' || (backgroundRun === undefined && isBgHandle && execInfo?.status === 'running'))
  const displayStatusLabel = isRunningInBackground ? t(COPY.backgroundRunning) : statusLabel(status, locale)

  const isActive = isLatest && (status === 'working' || status === 'blocked')
  useToolActivity(props.callId, isActive)

  const { label: toolLabel, prompt: toolPrompt } = useMemo(() => extractToolMetaLabel(props), [props])
  const resolvedTitle = useMemo(
    () =>
      resolveNodeTitle(
        {
          kind: 'agent',
          conversationId: childId,
          summary: childSummary,
          run: backgroundRun,
          toolLabel,
          toolPrompt,
        },
        locale,
      ),
    [childId, childSummary, backgroundRun, toolLabel, toolPrompt, locale],
  )

  const isError = status === 'error' || status === 'aborted' || props.status === 'error'
  const resultText = typeof props.result === 'string' ? props.result : undefined
  const errorFirstLine =
    props.status === 'error' && resultText?.trim()
      ? cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')
      : isError && backgroundRun?.error?.trim()
        ? cleanInlineMarkdown(backgroundRun.error.split(/\r?\n/, 1)[0] ?? '')
        : undefined
  const summaryParts = [execMeta?.nodeId, errorFirstLine].filter((p): p is string => Boolean(p))
  const displaySummary = summaryParts.length > 0 ? summaryParts.join(' · ') : undefined

  const targetWorkbenchRunId = backgroundRun?.id ?? execInfo?.runId
  const canOpenDrawer = childId !== undefined
  const canOpenWorkbench = !canOpenDrawer && targetWorkbenchRunId !== undefined

  const handleActivate = (): void => {
    if (canOpenDrawer && childId !== undefined) {
      ctx.openConversationDrawer(childId)
      return
    }
    if (canOpenWorkbench && targetWorkbenchRunId !== undefined) {
      ctx.openWorkbench('tasks', { runId: targetWorkbenchRunId })
      return
    }
    setDetailsOpen((v) => !v)
  }

  const actionAria = canOpenDrawer && childId !== undefined
    ? traceOpenChildLabel(childId, locale)
    : canOpenWorkbench && targetWorkbenchRunId !== undefined
      ? traceOpenWorkbenchRunLabel(targetWorkbenchRunId, locale)
      : t(detailsOpen ? COPY.collapseDetails : COPY.expandDetails)

  const idTag =
    childId !== undefined
      ? !resolvedTitle.isFallback
        ? `#${childId}`
        : undefined
      : execMeta?.executionId

  const settledMs = resolveSubagentElapsedMs({
    backgroundRun: isLatest ? backgroundRun : undefined,
    summary: isLatest ? childSummary : undefined,
    startedAt: props.startedAt,
    durationMs: props.durationMs,
    status,
    isBackgroundHandle: isBgHandle,
  })
  const liveStartAt =
    isActive
      ? (backgroundRun?.status === 'running' ? backgroundRun.createdAt : props.startedAt ?? childSummary?.runStartedAt)
      : undefined

  const worktreeBranch = execMeta?.worktree?.branch
  const worktreeIsManaged = worktreeBranch !== undefined && isManagedSpawnBranch(worktreeBranch)
  const worktreeTooltip =
    worktreeBranch !== undefined ? worktreeBadgeTitle(worktreeBranch, execMeta?.worktree?.path, locale) : undefined
  const canNavigate = canOpenDrawer || canOpenWorkbench

  return (
    <div className="trace-entry">
      <div className={`trace-row${isError ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left wf-trace-toggle"
          aria-expanded={canNavigate ? undefined : detailsOpen}
          aria-controls={canNavigate ? undefined : detailsId}
          aria-label={`${resolvedTitle.text} — ${actionAria}`}
          onClick={handleActivate}
        >
          <HelmxIcon name="bot" size={12} />
          <span className="trace-tool-name wf-trace-name" title={resolvedTitle.text}>
            {resolvedTitle.text}
          </span>
          {idTag ? (
            <span className="wf-trace-id tabular-nums" title={idTag}>
              {idTag}
            </span>
          ) : null}
          {childId !== undefined && childSummary?.profileId ? (
            <span
              className="badge badge-neutral wf-trace-badge wf-trace-profile"
              title={`@${childSummary.profileId}`}
            >
              <span>{`@${childSummary.profileId}`}</span>
            </span>
          ) : null}
          {worktreeBranch !== undefined ? (
            <span
              className={`badge badge-neutral wf-trace-badge wf-wt-badge${worktreeIsManaged ? ' wf-wt-badge-compact' : ''}`}
              title={worktreeTooltip}
              aria-label={worktreeTooltip}
            >
              <HelmxIcon name="git-branch" size={10} />
              {!worktreeIsManaged ? <span className="wf-wt-branch">{worktreeBranch}</span> : null}
            </span>
          ) : null}
          {!isLatest ? (
            <span className="badge badge-neutral wf-trace-badge">
              <span>{t(COPY.resumedBelow)}</span>
            </span>
          ) : null}
          {displaySummary ? (
            <span className={`trace-tool-summary${isError ? ' wf-trace-error' : ''}`} title={displaySummary}>
              {displaySummary}
            </span>
          ) : null}
        </button>

        <span className="trace-row-right wf-trace-right">
          <StatusLight status={executionLightStatus(status)} label={displayStatusLabel} />
          <ElapsedClock
            active={isActive}
            startedAt={liveStartAt}
            settledMs={settledMs}
            className="trace-duration"
          />
        </span>
      </div>

      {!canNavigate ? (
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <div className="trace-expanded-body">
              <ToolCallDetails input={props.input} result={props.result} artifactRef={props.artifactRef} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. WorkflowToolView (`SubagentWorkflow` tool call)
// ---------------------------------------------------------------------------

export function WorkflowToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const conversations = useConversations()
  const viewerConversationId = props.conversationId ?? ctx.conversationId
  const { runs } = useWorkflowRunsDoc(viewerConversationId)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const presentationMeta = useMemo(() => readToolPresentationMeta(props), [props])
  const run = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveWorkflowRunForTool({ callId: props.callId, presentationMeta }, viewerConversationId, runs)
        : undefined,
    [props.callId, presentationMeta, viewerConversationId, runs],
  )

  const subtree = useMemo(() => {
    if (run === undefined) return aggregateExecutionNodes([])
    if (viewerConversationId !== undefined && conversations.length > 0) {
      const tree = buildExecutionTree({ rootConversationId: viewerConversationId, conversations, runs })
      const matched = tree.find((n) => n.kind === 'workflow' && n.run?.id === run.id)
      if (matched !== undefined) return aggregateExecutionNodes(matched.children)
    }
    return aggregateExecutionNodes(buildLeafNodesForRun(run))
  }, [run, viewerConversationId, conversations, runs])

  const status: ExecutionStatus = useMemo(() => {
    if (run !== undefined) return effectiveRunStatus(run, subtree)
    if (props.status === 'error') return 'error'
    if (props.status === 'running' || isBackgroundWorkflowResultHandle(presentationMeta)) return 'working'
    return 'done'
  }, [run, subtree, props.status, presentationMeta])

  const toolActive = run !== undefined ? run.status === 'running' : props.status === 'running'
  useToolActivity(props.callId, toolActive)

  const isBgHandle = run === undefined && isBackgroundWorkflowResultHandle(presentationMeta)
  const title = run !== undefined ? resolveRunDisplayName(run) : resolveWorkflowToolFallbackLabel(props.input, locale, presentationMeta)
  const isError = status === 'error' || status === 'aborted' || props.status === 'error'
  const resultText = typeof props.result === 'string' ? props.result : undefined

  const activeNode = run?.nodes?.find((n) => n.status === 'running')
  const summaryText =
    isError && (run?.error?.trim() || resultText?.trim())
      ? cleanInlineMarkdown((run?.error ?? resultText ?? '').split(/\r?\n/, 1)[0] ?? '')
      : activeNode?.label
        ? activeNode.label
        : isBgHandle
          ? t(COPY.backgroundDispatched)
          : undefined

  const totalNodes = run?.nodes?.length ?? 0
  const doneNodes = run?.nodes?.filter((n) => n.status === 'done').length ?? 0

  const handleActivate = (): void => {
    if (run !== undefined) {
      ctx.openWorkbench('tasks', { runId: run.id })
      return
    }
    setDetailsOpen((v) => !v)
  }

  return (
    <div className="trace-entry">
      <div className={`trace-row${isError ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left wf-trace-toggle"
          aria-expanded={run !== undefined ? undefined : detailsOpen}
          aria-controls={run !== undefined ? undefined : detailsId}
          aria-label={run !== undefined ? `${title} — ${traceOpenWorkbenchRunLabel(run.id, locale)}` : `${title} — ${t(detailsOpen ? COPY.collapseDetails : COPY.expandDetails)}`}
          onClick={handleActivate}
        >
          <HelmxIcon name="workflow" size={12} />
          <span className="trace-tool-name wf-trace-name" title={title}>
            {title}
          </span>
          {totalNodes > 0 ? (
            <span className="badge badge-neutral wf-trace-badge tabular-nums">{`${doneNodes}/${totalNodes}`}</span>
          ) : null}
          {summaryText ? (
            <span className={`trace-tool-summary${isError ? ' wf-trace-error' : ''}`} title={summaryText}>
              {summaryText}
            </span>
          ) : null}
        </button>

        <span className="trace-row-right wf-trace-right">
          <StatusLight status={executionLightStatus(status)} label={statusLabel(status, locale)} />
          {run !== undefined ? (
            <WorkflowTimingClock run={run} className="trace-duration" />
          ) : (
            <ElapsedClock
              active={props.status === 'running' && !isBgHandle}
              startedAt={props.startedAt}
              settledMs={!isBgHandle ? props.durationMs : undefined}
              className="trace-duration"
            />
          )}
        </span>
      </div>

      {run === undefined ? (
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <div className="trace-expanded-body">
              <ToolCallDetails input={props.input} result={props.result} artifactRef={props.artifactRef} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. BackgroundReportCard (`helmx.input` background settlement receipt)
// ---------------------------------------------------------------------------

function ReportExpandedBody(props: { view: BackgroundReportView; onOpenChild?: () => void }): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { view, onOpenChild } = props
  const kvItems: Array<{ key: ReactNode; value: ReactNode }> = [
    ...(view.name !== undefined ? [{ key: t(COPY.reportKvName), value: view.name }] : []),
    { key: t(COPY.reportKvRunId), value: <span className="mono">{view.runId}</span> },
    ...(view.createdAt !== undefined
      ? [{ key: t(COPY.reportKvDeliveredAt), value: <span className="tabular-nums">{formatCompactTimestamp(view.createdAt)}</span> }]
      : []),
    {
      key: t(COPY.reportKvKind),
      value: t(view.kind === 'subagent_report' ? COPY.subagentLabel : COPY.workflowLabel),
    },
    ...(view.executionConversationId !== undefined
      ? [
          {
            key: t(COPY.reportKvSubagent),
            value: onOpenChild ? (
              <button type="button" className="btn btn-ghost btn-xs" onClick={onOpenChild}>
                {view.name ? `${view.name} (#${view.executionConversationId})` : `#${view.executionConversationId}`}
              </button>
            ) : (
              <span>{view.name ? `${view.name} (#${view.executionConversationId})` : `#${view.executionConversationId}`}</span>
            ),
          },
        ]
      : []),
  ]

  return (
    <>
      <KvGrid items={kvItems} />
      {view.error ? (
        <Callout tone={view.status === 'aborted' ? 'warn' : 'err'}>{view.error}</Callout>
      ) : null}
      {view.hasResult ? (
        <div className="wf-detail-block">
          <div className="trace-section-label">{t(COPY.reportResultSection)}</div>
          {typeof view.result === 'string' ? (
            <MarkdownText text={view.result} />
          ) : (
            <pre className="code-block-pre wf-pre">
              <code>{JSON.stringify(view.result, null, 2)}</code>
            </pre>
          )}
        </div>
      ) : (
        <div className="wf-muted-note">{t(COPY.reportNoResult)}</div>
      )}
      {view.otherRunningTasks.length > 0 ? (
        <div className="wf-detail-block">
          <div className="trace-section-label">{t(COPY.reportOtherTasks)}</div>
          <div className="wf-report-tasks">
            {view.otherRunningTasks.map((task) => (
              <span key={task.runId} className="badge badge-neutral wf-report-task-item">
                {!isPlaceholderRunName(task.name, task.runId) ? <span>{task.name}</span> : null}
                <span className="mono">{task.runId}</span>
                <span>{t(task.kind === 'subagent' ? COPY.subagentLabel : COPY.workflowLabel)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

export function BackgroundReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const view = useMemo(() => parseBackgroundReportEntry(props.entry), [props.entry])
  const [open, setOpen] = useState(() => isBackgroundReportDefaultOpen(view))
  const bodyId = useId()

  const convId = view.invalid ? undefined : view.executionConversationId
  const reportName = view.invalid ? undefined : view.name
  const isFailure = !view.invalid && (view.status === 'failed' || view.status === 'aborted')
  const title = view.invalid
    ? t(COPY.reportInvalidTitle)
    : view.kind === 'subagent_report'
      ? t(COPY.reportSubagentTitle)
      : t(COPY.reportWorkflowTitle)
  const preview = view.invalid ? t(COPY.reportInvalidPreview) : backgroundReportPreview(view, 120)
  const rowTitle = reportName
    ? `${title} · ${reportName}`
    : convId !== undefined
      ? `${title} #${convId}`
      : title

  return (
    <div className="trace-entry">
      <div className={`trace-row${isFailure || view.invalid ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left wf-trace-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={reportToggleLabel(rowTitle, open, locale)}
          onClick={() => setOpen((v) => !v)}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <HelmxIcon name={!view.invalid && view.kind === 'workflow_report' ? 'workflow' : 'bot'} size={12} />
          <span className="trace-tool-name wf-trace-name" title={rowTitle}>
            {rowTitle}
          </span>
          {reportName && convId !== undefined ? (
            <span className="wf-trace-id tabular-nums">{`#${convId}`}</span>
          ) : null}
          {preview ? (
            <span className={`trace-tool-summary${isFailure || view.invalid ? ' wf-trace-error' : ''}`} title={preview}>
              {preview}
            </span>
          ) : null}
        </button>

        <span className="trace-row-right wf-trace-right">
          {view.invalid ? (
            <StatusLight status="failed" label={t(COPY.reportInvalidBadge)} />
          ) : (
            <StatusLight status={view.status} label={runStatusLabel(view.status, locale)} />
          )}
          {view.createdAt !== undefined ? (
            <span className="trace-duration tabular-nums">{formatCompactTimestamp(view.createdAt)}</span>
          ) : null}
          <CopyButton text={view.rawText} className="btn btn-ghost btn-xs" />
          {convId !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              title={traceOpenChildLabel(convId, locale)}
              aria-label={traceOpenChildLabel(convId, locale)}
              onClick={() => ctx.openConversationDrawer(convId)}
            >
              <HelmxIcon name="external-link" size={11} />
            </button>
          ) : null}
        </span>
      </div>

      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="trace-expanded-body wf-report-expanded selectable">
            {view.invalid ? (
              <>
                <Callout tone="err">{t(COPY.reportInvalidCallout)}</Callout>
                <pre className="code-block-pre wf-pre selectable">
                  <code>{view.rawText}</code>
                </pre>
              </>
            ) : (
              <ReportExpandedBody
                view={view}
                onOpenChild={convId !== undefined ? () => ctx.openConversationDrawer(convId) : undefined}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
