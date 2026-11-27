/**
 * Workbench-only workflow run card (`WorkflowRunCard`) and right workbench panel
 * (`WorkflowWorkbenchPanel`).
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  HelmxIcon,
  Input,
  KvGrid,
  LoadingState,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Stack,
  StatusLight,
  formatCompactTimestamp,
  formatOffsetMs,
  resolveLocalizedText,
  type HelmxLocale,
} from '@helmx/ui'
import {
  MarkdownView,
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts-types.js'
import {
  COPY,
  actionFailedNotice,
  replayAcceptedNotice,
  replayMetaText,
  resumeInitiatedNotice,
  runStatusLabel,
  selfVsSubtreeAriaLabel,
  statusLabel,
  workbenchResumeAllSkipped,
  workbenchResumeFailedButton,
  workbenchResumeInvalidResult,
  workbenchResumeStarted,
} from './copy.js'
import { WorkflowTimingClock } from './ElapsedClock.js'
import { ExecutionNodeRow } from './ExecutionNodeRow.js'
import {
  aggregateExecutionNodes,
  buildExecutionTree,
  buildWorkflowPhaseSections,
  canReplayWorkflowRun,
  canResumeWorkflowRun,
  effectiveRunStatus,
  executionLightStatus,
  extractWorkflowLogs,
  listResumableFailedRuns,
  resolveRunDisplayName,
  statusFromRun,
  type ExecutionNode,
} from './execution-model.js'
import { useInspectedRun, useWorkflowRunsDoc } from './hooks.js'
import { asPlainRecord, parseResumeFailedResult, parseWorkflowArgsInput, stringifyPretty, summarizeJsonPreview } from './parsers.js'

function nodeMatchesRunId(node: ExecutionNode, targetRunId: string): boolean {
  if (node.run?.id === targetRunId) return true
  return node.children.some((c) => nodeMatchesRunId(c, targetRunId))
}

function RunResultBody(props: {
  resultOpen: boolean
  inspected: {
    loading: boolean
    error?: string
    result?: unknown
    retry: () => void
  }
  conversationId: number
  resultPretty?: string
  collapsedPreview?: string
  locale: HelmxLocale
}): ReactNode {
  const { resultOpen, inspected, conversationId, resultPretty, collapsedPreview, locale } = props
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  if (!resultOpen) {
    if (!collapsedPreview) return null
    return (
      <div className="wf-result-preview selectable" title={collapsedPreview}>
        {collapsedPreview}
      </div>
    )
  }
  if (inspected.loading) return <LoadingState label={t(COPY.loading)} />
  if (inspected.error) {
    return (
      <Callout tone="err">
        <div>{inspected.error}</div>
        <Button size="xs" onClick={inspected.retry}>
          {t(COPY.retry)}
        </Button>
      </Callout>
    )
  }
  if (typeof inspected.result === 'string') {
    return (
      <MarkdownView
        text={inspected.result}
        conversationId={conversationId}
        className="wf-result-markdown selectable"
      />
    )
  }
  if (resultPretty !== undefined) {
    return (
      <pre className="code-block-pre wf-pre selectable">
        <code>{resultPretty}</code>
      </pre>
    )
  }
  return null
}

interface WorkflowRunCardProps {
  run: WorkflowRunSummary
  childNodes: ReadonlyArray<ExecutionNode>
  open: boolean
  onToggle: () => void
  resultOpen: boolean
  onToggleResult: () => void
}

function WorkflowRunCard(props: WorkflowRunCardProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { run, childNodes, open, onToggle, resultOpen, onToggleResult } = props
  const bodyId = useId()

  // Lazy full `inspect` only when the user expands a slimmed result (zero unnecessary requests on mount).
  const inspected = useInspectedRun(run, resultOpen)
  const displayRun = run

  const [replayOpen, setReplayOpen] = useState(false)
  const [replayArgs, setReplayArgs] = useState('')
  const [replayError, setReplayError] = useState<string | undefined>(undefined)

  const actionCtl = usePluginAction({
    notifyError: true,
    formatError: (err, id) =>
      actionFailedNotice(
        id === 'abort' ? t(COPY.abort) : id === 'run' ? t(COPY.replay) : t(COPY.resume),
        err instanceof Error ? err.message : String(err),
        locale,
      ),
  })

  // O(1) lookup map from node.id -> ExecutionNode children (avoids O(N^2) scans).
  const childrenByNodeId = useMemo(() => {
    const map = new Map<string, ReadonlyArray<ExecutionNode>>()
    for (const c of childNodes) {
      if (c.runNode?.id !== undefined) map.set(c.runNode.id, c.children)
    }
    return map
  }, [childNodes])

  const subtree = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const selfStatus = statusFromRun(displayRun)
  const effectiveStatus = effectiveRunStatus(displayRun, subtree)
  const statusAriaLabel =
    effectiveStatus !== selfStatus ? selfVsSubtreeAriaLabel(selfStatus, effectiveStatus, locale) : undefined
  const sections = useMemo(() => buildWorkflowPhaseSections(displayRun, locale), [displayRun, locale])
  const logs = useMemo(() => extractWorkflowLogs(displayRun), [displayRun])
  const displayName = resolveRunDisplayName(displayRun)
  const totalNodes = displayRun.nodes?.length ?? 0
  const doneNodes = displayRun.nodes?.filter((n) => n.status === 'done').length ?? 0
  const canResume = canResumeWorkflowRun(displayRun)
  const canReplay = canReplayWorkflowRun(displayRun)

  const handleReplay = (): void => {
    const parsed = parseWorkflowArgsInput(replayArgs, locale)
    if (!parsed.ok) {
      setReplayError(parsed.error)
      return
    }
    setReplayError(undefined)
    void actionCtl.run(
      'run',
      {
        resumeFromRunId: displayRun.id,
        conversationId: displayRun.conversationId,
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
      },
      {
        key: `replay:${displayRun.id}`,
        onSuccess: (raw) => {
          const newRunId = asPlainRecord(asPlainRecord(raw)?.['run'])?.['id']
          if (typeof newRunId === 'string') {
            ctx.notify(replayAcceptedNotice(newRunId, locale))
          }
          setReplayOpen(false)
          setReplayArgs('')
        },
        onError: (msg) => setReplayError(msg),
      },
    )
  }

  const collapsedPreview = useMemo(
    () => displayRun.resultPreview ?? summarizeJsonPreview(displayRun.result, 160),
    [displayRun.resultPreview, displayRun.result],
  )
  const resultPretty = useMemo(
    () => (inspected.hasResolvedResult ? stringifyPretty(inspected.result) : undefined),
    [inspected.hasResolvedResult, inspected.result],
  )

  const metaKv = useMemo(() => {
    const items: Array<{ key: ReactNode; value: ReactNode }> = [
      { key: t(COPY.runKvRunId), value: <span className="mono">{displayRun.id}</span> },
      { key: t(COPY.runKvStatus), value: runStatusLabel(displayRun.status, locale) },
      { key: t(COPY.runKvCreatedAt), value: <span className="tabular-nums">{formatCompactTimestamp(displayRun.createdAt)}</span> },
    ]
    if (displayRun.settledAt !== undefined) {
      items.push({ key: t(COPY.runKvSettledAt), value: <span className="tabular-nums">{formatCompactTimestamp(displayRun.settledAt)}</span> })
    }
    if (displayRun.savedName) {
      items.push({ key: t(COPY.runKvSavedDef), value: <span className="mono">{displayRun.savedName}</span> })
    }
    if (displayRun.replayedFrom) {
      items.push({ key: t(COPY.runKvSourceRun), value: <span className="mono">{displayRun.replayedFrom}</span> })
    }
    if (displayRun.resumedByRunId) {
      items.push({ key: t(COPY.runKvResumedBy), value: <span className="mono">{displayRun.resumedByRunId}</span> })
    }
    return items
  }, [displayRun, locale])

  return (
    <div className={`wf-run-card${effectiveStatus === 'error' ? ' wf-run-card-error' : ''}`}>
      <div className="wf-run-head">
        <button
          type="button"
          className="wf-run-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          <StatusLight
            status={executionLightStatus(effectiveStatus)}
            label={statusAriaLabel ?? statusLabel(effectiveStatus, locale)}
          />
          <span className="wf-run-title" title={displayName}>
            {displayName}
          </span>
          {displayRun.savedName ? <Badge tone="neutral">{t(COPY.runSavedBadge)}</Badge> : null}
          {totalNodes > 0 ? (
            <Badge tone="neutral" className="tabular-nums">{`${doneNodes}/${totalNodes}`}</Badge>
          ) : null}
          <WorkflowTimingClock run={displayRun} className="wf-run-elapsed" />
        </button>

        <div className="wf-run-actions">
          {displayRun.status === 'running' ? (
            <Button
              variant="danger"
              size="xs"
              icon="square"
              disabled={actionCtl.pending}
              onClick={() => void actionCtl.run('abort', { runId: displayRun.id }, { key: `abort:${displayRun.id}` })}
            >
              {t(COPY.abort)}
            </Button>
          ) : null}
          {canResume ? (
            <Button
              size="xs"
              icon="rotate-cw"
              pending={actionCtl.pendingKey === `resume:${displayRun.id}`}
              disabled={actionCtl.pending}
              onClick={() =>
                void actionCtl.run(
                  'run',
                  { resumeFromRunId: displayRun.id, conversationId: displayRun.conversationId },
                  {
                    key: `resume:${displayRun.id}`,
                    onSuccess: (raw) => {
                      const newId = asPlainRecord(asPlainRecord(raw)?.['run'])?.['id']
                      ctx.notify(resumeInitiatedNotice(typeof newId === 'string' ? newId : undefined, locale))
                    },
                  },
                )
              }
            >
              {t(COPY.resume)}
            </Button>
          ) : null}
          {canReplay ? (
            <PopoverRoot open={replayOpen} onOpenChange={setReplayOpen}>
              <PopoverTrigger asChild>
                <Button size="xs" icon="rotate-cw" disabled={actionCtl.pending}>
                  {t(COPY.replay)}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="wf-replay-popover">
                <div className="wf-replay-form">
                  <div className="wf-replay-meta">
                    {replayMetaText(displayRun.id, displayRun.conversationId, displayRun.savedName, locale)}
                  </div>
                  <div className="wf-replay-hint">{t(COPY.replayHint)}</div>
                  <div className="wf-replay-row">
                    <Input
                      type="text"
                      size="sm"
                      className="wf-replay-input"
                      invalid={replayError !== undefined}
                      placeholder={t(COPY.replayArgsPlaceholder)}
                      value={replayArgs}
                      onChange={(e) => {
                        setReplayArgs(e.target.value)
                        setReplayError(undefined)
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      icon="play"
                      pending={actionCtl.pendingKey === `replay:${displayRun.id}`}
                      disabled={actionCtl.pending}
                      onClick={handleReplay}
                    >
                      {t(COPY.replaySubmit)}
                    </Button>
                  </div>
                  {replayError ? <Callout tone="err">{replayError}</Callout> : null}
                </div>
              </PopoverContent>
            </PopoverRoot>
          ) : null}
        </div>
      </div>

      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="wf-run-body">
            {displayRun.error ? (
              <Callout tone={displayRun.status === 'aborted' ? 'warn' : 'err'}>{displayRun.error}</Callout>
            ) : null}

            <KvGrid items={metaKv} />

            {sections.every((s) => s.nodes.length === 0) ? (
              <div className="wf-muted-note">{t(COPY.runNoNodes)}</div>
            ) : (
              <div className="wf-phases">
                {sections.map((section) => (
                  <div key={section.key} className="wf-phase-section">
                    {section.title !== '' ? (
                      <div className="wf-phase-head">
                        <StatusLight status={executionLightStatus(section.status)} label={statusLabel(section.status, locale)} />
                        <span className="wf-phase-title">{section.title}</span>
                        {section.totalCount > 0 ? (
                          <Badge tone="neutral" className="tabular-nums">{`${section.doneCount}/${section.totalCount}`}</Badge>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="wf-phase-nodes">
                      {section.nodes.map((node: WorkflowNodeState) => (
                        <ExecutionNodeRow
                          key={node.id}
                          node={node}
                          run={displayRun}
                          parentConversationId={displayRun.conversationId}
                          childrenNodes={childrenByNodeId.get(node.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {logs.length > 0 ? (
              <div className="wf-detail-block">
                <div className="trace-section-label">{t(COPY.runLogsSection)}</div>
                <div className="wf-log-list tabular-nums">
                  {logs.map((line) => (
                    <div key={line.key} className="wf-log-row">
                      <span className="wf-log-offset">{formatOffsetMs(Math.max(0, line.at - displayRun.createdAt))}</span>
                      <span className="wf-log-msg">{line.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {displayRun.status === 'completed' && inspected.hasResult ? (
              <div className="wf-result-box">
                <div className="wf-result-header">
                  <span className="trace-section-label">{t(COPY.runResultSection)}</span>
                  <Button variant="ghost" size="xs" icon={resultOpen ? 'chevron-down' : 'chevron-right'} onClick={onToggleResult}>
                    {t(resultOpen ? COPY.runCollapseResult : COPY.runExpandResult)}
                  </Button>
                </div>
                <RunResultBody
                  resultOpen={resultOpen}
                  inspected={inspected}
                  conversationId={displayRun.conversationId}
                  resultPretty={resultPretty}
                  collapsedPreview={collapsedPreview}
                  locale={locale}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function WorkflowWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const { runs, status: runsStatus, retry: retryRuns } = useWorkflowRunsDoc(conversationId)

  const requestedRunId =
    typeof props?.params?.['runId'] === 'string' && props.params['runId'] !== '' ? props.params['runId'] : undefined
  const [focusedRunId, setFocusedRunId] = useState<string | undefined>(requestedRunId)
  const [openRunIds, setOpenRunIds] = useState<Record<string, boolean>>(() =>
    requestedRunId !== undefined ? { [requestedRunId]: true } : {},
  )
  const [resultOpenIds, setResultOpenIds] = useState<Record<string, boolean>>({})
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const scrolledToken = useRef<unknown>(undefined)
  const prevConversationId = useRef<number | undefined>(conversationId)

  useEffect(() => {
    const convChanged = prevConversationId.current !== conversationId
    if (convChanged) {
      prevConversationId.current = conversationId
      nodeRefs.current = {}
      scrolledToken.current = undefined
      setResultOpenIds({})
      setOpenRunIds(requestedRunId !== undefined ? { [requestedRunId]: true } : {})
    } else if (requestedRunId !== undefined) {
      setOpenRunIds((prev) => ({ ...prev, [requestedRunId]: true }))
    }
    setFocusedRunId(requestedRunId)
  }, [conversationId, props?.params, requestedRunId])

  const tree = useMemo(
    () =>
      conversationId !== undefined
        ? buildExecutionTree({ rootConversationId: conversationId, conversations, runs })
        : [],
    [conversationId, conversations, runs],
  )

  useEffect(() => {
    if (conversationId === undefined || focusedRunId === undefined) return
    const token = props?.params ?? focusedRunId
    if (scrolledToken.current === token) return
    const matched = tree.find((n) => nodeMatchesRunId(n, focusedRunId))
    if (matched === undefined) return
    const el = nodeRefs.current[matched.run?.id ?? matched.key]
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
    scrolledToken.current = token
  }, [conversationId, focusedRunId, props?.params, tree])

  const resumableRuns = useMemo(
    () => (conversationId !== undefined ? listResumableFailedRuns(runs, conversationId) : []),
    [runs, conversationId],
  )

  const batchResumeCtl = usePluginAction({
    notifyError: true,
    formatError: (err) => actionFailedNotice(t(COPY.resume), err instanceof Error ? err.message : String(err), locale),
  })

  const handleResumeFailed = (): void => {
    if (conversationId === undefined) return
    void batchResumeCtl.run(
      'resume_failed',
      { conversationId },
      {
        onSuccess: (raw) => {
          const parsed = parseResumeFailedResult(raw)
          if (parsed === undefined) {
            ctx.notify(workbenchResumeInvalidResult(locale), 'error')
            return
          }
          if (parsed.resumedCount === 0 && parsed.skippedCount > 0) {
            ctx.notify(workbenchResumeAllSkipped(parsed.skippedCount, locale), 'warning')
          } else if (parsed.resumedCount === 0) {
            ctx.notify(t(COPY.workbenchResumeNone))
          } else {
            ctx.notify(workbenchResumeStarted(parsed.resumedCount, parsed.skippedCount, locale))
          }
        },
      },
    )
  }

  return (
    <div className="wf-workbench">
      <div className="wf-workbench-head">
        <span className="wf-workbench-title">
          <HelmxIcon name="workflow" size={14} />
          <span>{t(COPY.workbenchTitle)}</span>
          {tree.length > 0 ? <Badge tone="neutral" className="tabular-nums">{tree.length}</Badge> : null}
        </span>
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          {conversationId !== undefined && resumableRuns.length > 0 ? (
            <Button
              size="xs"
              icon="rotate-cw"
              pending={batchResumeCtl.pending}
              title={t(COPY.workbenchResumeTitle)}
              onClick={handleResumeFailed}
            >
              {workbenchResumeFailedButton(resumableRuns.length, locale)}
            </Button>
          ) : null}
          <Button
            size="xs"
            icon="folder"
            onClick={() => ctx.openScreen(`screen:${ctx.pluginId}/library`)}
          >
            {t(COPY.workbenchLibrary)}
          </Button>
        </Stack>
      </div>

      {conversationId === undefined ? (
        <EmptyState compact title={t(COPY.workbenchNoConversation)} />
      ) : runsStatus === 'loading' && runs.length === 0 ? (
        <LoadingState label={t(COPY.loading)} />
      ) : runsStatus === 'error' && runs.length === 0 ? (
        <Callout tone="err">
          <div>{t(COPY.workbenchLoadError)}</div>
          <Button size="xs" onClick={retryRuns}>
            {t(COPY.retry)}
          </Button>
        </Callout>
      ) : tree.length === 0 ? (
        <EmptyState compact title={t(COPY.workbenchNoRuns)} />
      ) : (
        <div className="wf-workbench-list">
          {tree.map((node, idx) => {
            const run = node.run
            const refKey = run?.id ?? node.key
            const isFocused = focusedRunId !== undefined && nodeMatchesRunId(node, focusedRunId)
            return (
              <div
                key={node.key}
                data-run-id={run?.id}
                ref={(el) => {
                  nodeRefs.current[refKey] = el
                }}
                className={`wf-workbench-item${isFocused ? ' wf-workbench-focused' : ''}`}
              >
                {node.kind === 'workflow' && run !== undefined ? (
                  <WorkflowRunCard
                    run={run}
                    childNodes={node.children}
                    open={openRunIds[run.id] ?? (focusedRunId !== undefined ? isFocused : idx === 0 || run.status === 'running')}
                    onToggle={() => {
                      const def = focusedRunId !== undefined ? isFocused : idx === 0 || run.status === 'running'
                      setOpenRunIds((prev) => ({ ...prev, [run.id]: !(prev[run.id] ?? def) }))
                    }}
                    resultOpen={resultOpenIds[run.id] ?? false}
                    onToggleResult={() =>
                      setResultOpenIds((prev) => ({ ...prev, [run.id]: !(prev[run.id] ?? false) }))
                    }
                  />
                ) : (
                  <ExecutionNodeRow
                    node={
                      node.runNode ?? {
                        id: node.key,
                        kind: node.kind === 'action' ? 'action' : 'agent',
                        label: node.label ?? run?.name ?? node.key,
                        status:
                          node.status === 'working' || node.status === 'blocked'
                            ? 'running'
                            : node.status === 'done'
                              ? 'done'
                              : node.status === 'aborted'
                                ? 'aborted'
                                : node.status === 'error'
                                  ? 'failed'
                                  : 'pending',
                        ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
                        ...(run?.error !== undefined ? { error: run.error } : {}),
                      }
                    }
                    run={run}
                    parentConversationId={conversationId}
                    childrenNodes={node.children}
                    standalone
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
