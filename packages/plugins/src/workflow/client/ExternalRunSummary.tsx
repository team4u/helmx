/**
 * Background task summary component for external runtimes without a native
 * subagent conversation (shown honestly without fabricating a child drawer).
 */
import type { ReactNode } from 'react'
import {
  StatusLight,
  formatDurationMs,
  formatStopwatchMs,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useElapsedNowMs } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { isPlaceholderNodeLabel, isPlaceholderRunName } from './model-format.ts'
import { executionLightStatus } from './model-execution-status.ts'
import { subagentBadge, runFailureFallbackLabel } from './model-subagent-card.ts'
import { resolveNodeElapsedMs, resolveRunElapsedMs } from './model-run.ts'
import {
  EXTERNAL_TITLE,
  externalBackgroundTaskLabel,
  nodeStatusLabel,
  runStatusLabel,
  externalErrorJoiner,
  externalIdleLine,
  externalNodeFailedLabel,
  externalRunningNodes,
  worktreeBadgeTitle,
} from './copy.ts'

export function ExternalRunSummary(props: {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  toolStatus: 'running' | 'done' | 'error'
  executionId?: string
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { run, worktree, toolStatus, executionId } = props
  const nodes = run?.nodes ?? []
  const running = nodes.filter((n) => n.status === 'running').length
  const failed = nodes.find((n) => n.status === 'failed')
  const runError =
    run !== undefined && (run.status === 'failed' || run.status === 'aborted')
      ? [runFailureFallbackLabel(locale), run.error].filter(Boolean).join(externalErrorJoiner(locale))
      : undefined
  const badge = subagentBadge(undefined, toolStatus, run, undefined, locale)
  const active = badge.status === 'working'
  const failedState = badge.status === 'error'
  const nowMs = useElapsedNowMs((active && run?.status === 'running') || running > 0)
  const elapsedMs = run !== undefined ? resolveRunElapsedMs(run, nowMs) : undefined
  const primaryTitle =
    run !== undefined && !isPlaceholderRunName(run.name, run.id)
      ? run.name.trim()
      : !isPlaceholderNodeLabel(nodes[0]?.label)
        ? nodes[0]!.label!.trim()
        : undefined
  const lightStatus = executionLightStatus(badge.status, run, failed !== undefined)

  return (
    <div className="subagent-live-card subagent-external-card">
      <div className="subagent-live-header">
        <Icon name="bot" size={13} />
        <span className="subagent-live-title" title={primaryTitle ?? t(EXTERNAL_TITLE)}>
          <span className="subagent-live-title-text">{primaryTitle ?? t(EXTERNAL_TITLE)}</span>
          {primaryTitle !== undefined ? <span className="badge badge-neutral">{t(EXTERNAL_TITLE)}</span> : null}
          {executionId !== undefined ? <span className="badge badge-neutral mono">{executionId}</span> : null}
        </span>
        {worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={worktreeBadgeTitle(worktree.path, locale)}>
            <Icon name="git-branch" size={11} />
            {worktree.branch}
          </span>
        ) : null}
        <StatusLight
          status={lightStatus}
          label={lightStatus === 'aborted' ? runStatusLabel('aborted', locale) : badge.label}
        />
        {elapsedMs !== undefined ? (
          <span className="subagent-live-elapsed tabular-nums">
            {run?.status === 'running' ? formatStopwatchMs(elapsedMs) : formatDurationMs(elapsedMs)}
          </span>
        ) : null}
      </div>
      <div className="subagent-live-stream subagent-external-body">
        {nodes.length > 0 ? (
          <div className="workflow-node-list">
            {nodes.map((n) => {
              const nodeElapsedMs = resolveNodeElapsedMs(n, nowMs)
              return (
                <div key={n.id} className="workflow-node-line">
                  <StatusLight status={n.status} label={nodeStatusLabel(n.status, locale)} />
                  <span className="workflow-node-label">{n.label ?? n.id}</span>
                  {n.executionId !== undefined ? <span className="subagent-external-exec">{n.executionId}</span> : null}
                  {nodeElapsedMs !== undefined ? (
                    <span className="workflow-node-elapsed mono tabular-nums">
                      {n.status === 'running' ? formatStopwatchMs(nodeElapsedMs) : formatDurationMs(nodeElapsedMs)}
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="subagent-stream-line subagent-stream-empty">
            {run === undefined
              ? externalIdleLine(active ? 'active' : failedState ? 'error' : 'settled', locale)
              : externalBackgroundTaskLabel(run.id, locale)}
          </div>
        )}
        {runError !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={runError}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">{runError}</span>
          </div>
        ) : null}
        {failed !== undefined && failed.error !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={failed.error}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">{externalNodeFailedLabel(failed.error, locale)}</span>
          </div>
        ) : null}
        {running > 0 ? (
          <div className="subagent-stream-line subagent-stream-empty">{externalRunningNodes(running, locale)}</div>
        ) : null}
      </div>
    </div>
  )
}
