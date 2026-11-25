/**
 * Unified Workbench execution node row (agent — native or external — and action)
 * plus single shared `<WorktreeSlots>` renderer for `builtin:workflow/worktree-inspect`
 * and `worktree-cleanup`.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Badge,
  Callout,
  HelmxIcon,
  IconButton,
  KvGrid,
  PluginSlot,
  StatusLight,
  formatCompactTimestamp,
  formatDurationMs,
  resolveLocalizedText,
  useConversation,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import type { WorkflowNodeState, WorkflowRunSummary, WorktreeExecutionDescriptor } from '../../contracts-types.js'
import {
  COPY,
  actionFailedNotice,
  attemptBadge,
  resumeInitiatedNotice,
  statusLabel,
  traceOpenChildLabel,
  worktreeBadgeTitle,
} from './copy.js'
import { ElapsedClock } from './ElapsedClock.js'
import {
  canResumeSubagentRun,
  executionLightStatus,
  formatNodeStats,
  isManagedSpawnBranch,
  resolveLiveSnippet,
  resolveNodeElapsedMs,
  resolveNodeTitle,
  statusFromConversation,
  statusFromRunNode,
  type ExecutionNode,
  type ExecutionStatus,
} from './execution-model.js'
import { asPlainRecord, isPlaceholderNodeLabel, stringifyPretty } from './parsers.js'

export interface WorktreeSlotsProps {
  worktree?: WorktreeExecutionDescriptor
  nodeId?: string
  taskLabel?: string
  parentConversationId?: number
  showCleanup?: boolean
  compactCleanup?: boolean
}

export function WorktreeSlots(props: WorktreeSlotsProps): ReactNode {
  const { worktree } = props
  if (worktree === undefined) return null
  return (
    <>
      <PluginSlot
        name="worktree-inspect"
        slotProps={{
          worktree: {
            path: worktree.path,
            branch: worktree.branch,
            ...(worktree.id !== undefined ? { id: worktree.id } : {}),
          },
          nodeId: props.nodeId,
          baseCommit: worktree.baseCommit,
          taskLabel: !isPlaceholderNodeLabel(props.taskLabel) ? props.taskLabel : undefined,
          parentConversationId: props.parentConversationId,
        }}
      />
      {props.showCleanup ? (
        <PluginSlot
          name="worktree-cleanup"
          inline
          slotProps={{
            worktree: {
              path: worktree.path,
              branch: worktree.branch,
              ...(worktree.id !== undefined ? { id: worktree.id } : {}),
            },
            ...(props.nodeId !== undefined ? { nodeId: props.nodeId } : {}),
            ...(props.compactCleanup ? { compact: true } : {}),
          }}
        />
      ) : null}
    </>
  )
}

export interface ExecutionNodeRowProps {
  /** Tree node (from buildExecutionTree) or standalone run node inside a WorkflowRunCard phase. */
  node: WorkflowNodeState
  /** Parent workflow or background subagent run owning this node (when applicable). */
  run?: WorkflowRunSummary
  /** Parent conversation id (for worktree review handoff). */
  parentConversationId: number
  /** Nested execution children (descendant subagents / workflows). */
  childrenNodes?: ReadonlyArray<ExecutionNode>
  /** True when rendered as a top-level standalone subagent card in the Workbench. */
  standalone?: boolean
  /** Indentation depth for nested rows. */
  depth?: number
}

export function ExecutionNodeRow(props: ExecutionNodeRowProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { node, run, parentConversationId, childrenNodes = [], standalone = false, depth = 0 } = props

  const convId = node.conversationId
  const isAction = node.kind === 'action'
  const conv = useConversation(convId, { includeDetail: false })
  const summary = conv.summary
  const pendingAsk = conv.pendingAsks[0]

  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const actionCtl = usePluginAction({
    notifyError: true,
    formatError: (err, id) =>
      actionFailedNotice(
        id === 'abort' ? t(COPY.abort) : t(COPY.resume),
        err instanceof Error ? err.message : String(err),
        locale,
      ),
  })

  const status: ExecutionStatus = useMemo(() => {
    if (isAction) return statusFromRunNode(node)
    if (convId !== undefined) {
      if (pendingAsk !== undefined) return 'blocked'
      const nodeToolStatus: 'running' | 'done' | 'error' | 'unknown' =
        node.status === 'running' ? 'running' : node.status === 'failed' ? 'error' : node.status === 'done' ? 'done' : 'unknown'
      return node.status === 'aborted'
        ? 'aborted'
        : statusFromConversation(summary, standalone ? run : undefined, nodeToolStatus)
    }
    return statusFromRunNode(node)
  }, [isAction, convId, pendingAsk, summary, standalone, run, node])

  const resolvedTitle = useMemo(
    () =>
      resolveNodeTitle(
        {
          kind: isAction ? 'action' : 'agent',
          conversationId: convId,
          summary,
          run: standalone ? run : undefined,
          runNode: node,
        },
        locale,
      ),
    [isAction, convId, summary, standalone, run, node, locale],
  )

  const snippet = useMemo(
    () =>
      resolveLiveSnippet(
        {
          status,
          summary,
          live: status === 'working' ? conv.live : undefined,
          pendingAsk,
          run: standalone ? run : undefined,
          runNode: node,
          loadError: conv.loadError,
        },
        locale,
      ),
    [status, summary, conv.live, conv.loadError, pendingAsk, standalone, run, node, locale],
  )

  const stats = useMemo(() => formatNodeStats(node), [node])
  const outputPretty = useMemo(() => stringifyPretty(node.output), [node.output])
  const hasDetailContent =
    node.agentType !== undefined ||
    node.executionId !== undefined ||
    node.nodeId !== undefined ||
    node.effectiveCwd !== undefined ||
    node.worktree !== undefined ||
    node.gateCommand !== undefined ||
    node.gate !== undefined ||
    node.prompt !== undefined ||
    outputPretty !== undefined ||
    node.error !== undefined

  const isRunning = status === 'working' || status === 'blocked'
  const startedAt = node.startedAt ?? (standalone ? run?.createdAt : undefined)
  const settledMs = resolveNodeElapsedMs(node)

  const showAbort = standalone && run !== undefined && run.status === 'running'
  const showResume = standalone && canResumeSubagentRun(run)
  const inspectNodeId = node.nodeId ?? (summary?.nodeId && summary.nodeId !== '' ? summary.nodeId : undefined)

  const kvItems = useMemo(() => {
    const items: Array<{ key: ReactNode; value: ReactNode }> = []
    if (node.startedAt !== undefined) {
      items.push({ key: t(COPY.runKvCreatedAt), value: <span className="tabular-nums">{formatCompactTimestamp(node.startedAt)}</span> })
    }
    if (node.agentType) items.push({ key: t(COPY.nodeKvBackend), value: <span className="mono">{node.agentType}</span> })
    if (node.executionId) items.push({ key: t(COPY.nodeKvExecution), value: <span className="mono">{node.executionId}</span> })
    if (inspectNodeId) items.push({ key: t(COPY.nodeKvNode), value: <span className="mono">{inspectNodeId}</span> })
    if (node.effectiveCwd) items.push({ key: t(COPY.nodeKvCwd), value: <span className="mono">{node.effectiveCwd}</span> })
    if (node.worktree) {
      items.push({ key: t(COPY.nodeKvWorktree), value: <span className="mono">{`${node.worktree.branch} @ ${node.worktree.path}`}</span> })
    }
    if (node.model) items.push({ key: t(COPY.nodeKvModel), value: <span className="mono">{node.model}</span> })
    if (settledMs !== undefined) items.push({ key: t(COPY.nodeKvDuration), value: <span className="tabular-nums">{formatDurationMs(settledMs)}</span> })
    if (node.tokens !== undefined && node.tokens > 0) {
      items.push({ key: t(COPY.nodeKvTokens), value: <span className="tabular-nums">{node.tokens.toLocaleString()}</span> })
    }
    return items
  }, [node, inspectNodeId, settledMs, locale])

  const rowClass = [
    'wf-node-card',
    status === 'error' ? 'wf-node-card-error' : '',
    status === 'blocked' ? 'wf-node-card-warn' : '',
    depth > 0 ? 'wf-node-card-nested' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const worktreeIsManaged = node.worktree !== undefined && isManagedSpawnBranch(node.worktree.branch)
  const worktreeTooltip =
    node.worktree !== undefined ? worktreeBadgeTitle(node.worktree.branch, node.worktree.path, locale) : undefined
  const hasMetaRow =
    Boolean(node.cached) ||
    (node.attempt !== undefined && node.attempt > 1) ||
    node.gate !== undefined ||
    stats.length > 0

  const headerCore = (
    <>
      <StatusLight status={executionLightStatus(status)} label={statusLabel(status, locale)} />
      <span className="wf-node-title" title={resolvedTitle.text}>
        {resolvedTitle.text}
      </span>
      {convId !== undefined && !resolvedTitle.isFallback ? (
        <span className="wf-node-id tabular-nums">{`#${convId}`}</span>
      ) : null}
      {convId === undefined && node.executionId ? (
        <span className="wf-node-id mono" title={node.executionId}>
          {node.executionId}
        </span>
      ) : null}
      {isAction ? (
        <Badge tone="neutral">{t(COPY.actionLabel)}</Badge>
      ) : null}
      {node.worktree ? (
        <Badge
          tone="neutral"
          icon="git-branch"
          className={`wf-wt-badge${worktreeIsManaged ? ' wf-wt-badge-compact' : ''}`}
          title={worktreeTooltip}
          aria-label={worktreeTooltip}
        >
          {!worktreeIsManaged ? <span className="wf-wt-branch">{node.worktree.branch}</span> : null}
        </Badge>
      ) : null}
      <ElapsedClock
        active={isRunning}
        startedAt={startedAt}
        settledMs={settledMs}
        awaitingApproval={status === 'blocked'}
        className="wf-node-elapsed"
      />
    </>
  )

  return (
    <div className={rowClass}>
      <div className="wf-node-header">
        {convId !== undefined ? (
          <button
            type="button"
            className="wf-node-main wf-node-clickable"
            aria-label={`${resolvedTitle.text} — ${traceOpenChildLabel(convId, locale)}`}
            onClick={() => ctx.openConversationDrawer(convId)}
          >
            {headerCore}
          </button>
        ) : hasDetailContent ? (
          <button
            type="button"
            className="wf-node-main wf-node-clickable"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((v) => !v)}
          >
            <HelmxIcon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={11} />
            {headerCore}
          </button>
        ) : (
          <div className="wf-node-main">{headerCore}</div>
        )}

        <div className="wf-node-actions">
          {convId !== undefined && hasDetailContent ? (
            <IconButton
              variant="ghost"
              size="xs"
              icon={detailsOpen ? 'chevron-down' : 'chevron-right'}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              label={t(detailsOpen ? COPY.collapseDetails : COPY.expandDetails)}
              onClick={() => setDetailsOpen((v) => !v)}
            />
          ) : null}
          {showAbort && run !== undefined ? (
            <IconButton
              variant="danger"
              size="xs"
              icon="square"
              disabled={actionCtl.pending}
              label={t(COPY.abort)}
              onClick={() => void actionCtl.run('abort', { runId: run.id }, { key: `abort:${run.id}` })}
            />
          ) : null}
          {showResume && run !== undefined ? (
            <IconButton
              variant="default"
              size="xs"
              icon="rotate-cw"
              pending={actionCtl.pendingKey === `resume:${run.id}`}
              disabled={actionCtl.pending}
              label={t(COPY.resume)}
              onClick={() =>
                void actionCtl.run(
                  'run',
                  { resumeFromRunId: run.id, conversationId: run.conversationId },
                  {
                    key: `resume:${run.id}`,
                    onSuccess: (raw) => {
                      const newId = asPlainRecord(asPlainRecord(raw)?.['run'])?.['id']
                      ctx.notify(resumeInitiatedNotice(typeof newId === 'string' ? newId : undefined, locale))
                    },
                  },
                )
              }
            />
          ) : null}
          {node.worktree !== undefined ? (
            <PluginSlot
              name="worktree-cleanup"
              inline
              slotProps={{
                worktree: {
                  path: node.worktree.path,
                  branch: node.worktree.branch,
                  ...(node.worktree.id !== undefined ? { id: node.worktree.id } : {}),
                },
                ...(inspectNodeId !== undefined ? { nodeId: inspectNodeId } : {}),
                compact: true,
              }}
            />
          ) : null}
        </div>
      </div>

      {hasMetaRow ? (
        <div className="wf-node-meta">
          {node.cached ? <Badge tone="warn">{t(COPY.runCachedBadge)}</Badge> : null}
          {node.attempt !== undefined && node.attempt > 1 ? (
            <Badge tone="neutral">{attemptBadge(node.attempt, locale)}</Badge>
          ) : null}
          {node.gate !== undefined ? (
            <Badge tone={node.gate.ok ? 'ok' : 'err'}>
              {t(node.gate.ok ? COPY.runGatePassed : COPY.runGateFailed)}
            </Badge>
          ) : null}
          {stats.length > 0 ? <span className="wf-node-stats tabular-nums">{stats.join(' · ')}</span> : null}
        </div>
      ) : null}

      {snippet !== undefined ? (
        <div className={`wf-node-subline${snippet.isError ? ' wf-node-subline-error' : ''}`}>
          <HelmxIcon name="corner-down-right" size={11} />
          {snippet.tag ? <span className="wf-node-subline-tag">{snippet.tag}</span> : null}
          <span className="wf-node-subline-text" title={snippet.text}>
            {snippet.text}
          </span>
        </div>
      ) : null}

      <div id={detailsId} hidden={!detailsOpen}>
        {detailsOpen && hasDetailContent ? (
          <div className="wf-node-details selectable">
            {kvItems.length > 0 ? <KvGrid items={kvItems} /> : null}
            {node.gateCommand !== undefined || node.gate !== undefined ? (
              <div className="wf-detail-block">
                <div className="trace-section-label">{t(COPY.nodeSectionGate)}</div>
                {node.gateCommand ? (
                  <pre className="code-block-pre wf-pre">
                    <code>{node.gateCommand}</code>
                  </pre>
                ) : null}
                {node.gate !== undefined && node.gate.output !== '' ? (
                  <pre className={`code-block-pre wf-pre${node.gate.ok ? '' : ' wf-pre-err'}`}>
                    <code>{node.gate.output}</code>
                  </pre>
                ) : null}
              </div>
            ) : null}
            {node.prompt ? (
              <div className="wf-detail-block">
                <div className="trace-section-label">{t(COPY.nodeSectionPrompt)}</div>
                <pre className="code-block-pre wf-pre">
                  <code>{node.prompt}</code>
                </pre>
              </div>
            ) : null}
            {outputPretty !== undefined ? (
              <div className="wf-detail-block">
                <div className="trace-section-label">{t(COPY.nodeSectionOutput)}</div>
                <pre className="code-block-pre wf-pre">
                  <code>{outputPretty}</code>
                </pre>
              </div>
            ) : null}
            {node.error ? (
              <Callout tone="err">{node.error}</Callout>
            ) : null}
          </div>
        ) : null}
      </div>

      {node.worktree !== undefined ? (
        <WorktreeSlots
          worktree={node.worktree}
          nodeId={inspectNodeId}
          taskLabel={node.label}
          parentConversationId={parentConversationId}
        />
      ) : null}

      {childrenNodes.length > 0 ? (
        <div className="wf-node-children">
          {childrenNodes.map((child) => {
            const syntheticNode: WorkflowNodeState = child.runNode ?? {
              id: child.key,
              kind: child.kind === 'action' ? 'action' : 'agent',
              label: child.label ?? child.run?.name ?? child.key,
              status:
                child.status === 'working' || child.status === 'blocked'
                  ? 'running'
                  : child.status === 'done'
                    ? 'done'
                    : child.status === 'aborted'
                      ? 'aborted'
                      : child.status === 'error'
                        ? 'failed'
                        : 'pending',
              ...(child.conversationId !== undefined ? { conversationId: child.conversationId } : {}),
            }
            return (
              <ExecutionNodeRow
                key={child.key}
                node={syntheticNode}
                run={child.run}
                parentConversationId={convId ?? parentConversationId}
                childrenNodes={child.children}
                standalone={child.run?.kind === 'subagent' && child.run !== run}
                depth={depth + 1}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
