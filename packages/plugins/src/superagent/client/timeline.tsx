/**
 * Dedicated timeline surface entrypoint for builtin:superagent
 * (`SuperAgentDispatchToolView` and `SuperAgentWorkerReportCard`).
 */
import './styles.css'
import type { ReactNode } from 'react'
import type { TimelineRendererProps, ToolViewProps } from '@helmx/protocol'
import {
  HelmxIcon,
  StatusLight,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  dispatchedWorkerId,
  dispatchInput,
  outcomeLabel,
  workerReportMeta,
} from './models.ts'
import {
  SA_ACTION_OPEN,
  SA_ACTION_SPLIT_OPEN,
  SA_DISPATCHING,
  SA_DISPATCH_DONE,
  SA_DISPATCH_FAILED,
  SA_DISPATCH_TITLE,
  SA_STATUS_COMPLETED,
  SA_STATUS_FAILED,
  SA_STATUS_RUNNING,
  SA_WORKER_REPORT,
  saArtifactTitle,
  saDispatchedWorker,
} from './copy.ts'
import { RowAction } from './shared.tsx'

export function SuperAgentDispatchToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const input = dispatchInput(props)
  const resultWorkerId = dispatchedWorkerId(props)

  const lightStatus =
    props.status === 'running' ? 'running' : props.status === 'error' ? 'failed' : 'completed'
  const receiptText =
    props.status === 'running'
      ? t(SA_DISPATCHING)
      : props.status === 'error'
        ? t(SA_DISPATCH_FAILED)
        : resultWorkerId !== undefined
          ? saDispatchedWorker(resultWorkerId, locale)
          : t(SA_DISPATCH_DONE)

  return (
    <div className="section-flat sa-widget sa-dispatch-receipt-card">
      <div className="sa-widget-title">
        <HelmxIcon name="boxes" size={13} />
        <span>{t(SA_DISPATCH_TITLE)}</span>
      </div>
      <div className="sa-dispatch-receipt">
        <StatusLight
          status={lightStatus}
          label={t(
            lightStatus === 'running'
              ? SA_STATUS_RUNNING
              : lightStatus === 'failed'
                ? SA_STATUS_FAILED
                : SA_STATUS_COMPLETED,
          )}
        />
        <span className="sa-dispatch-text">{receiptText}</span>
        {input.profileId !== undefined ? <span className="sa-dispatch-meta">Profile {input.profileId}</span> : null}
        {input.threadKey !== undefined ? <span className="sa-dispatch-meta mono">{input.threadKey}</span> : null}
        {resultWorkerId !== undefined ? (
          <RowAction
            label={t(SA_ACTION_OPEN)}
            iconName="external-link"
            onClick={() => ctx.openScreen(`conversation:${resultWorkerId}`)}
          />
        ) : null}
      </div>
    </div>
  )
}

export function SuperAgentWorkerReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const meta = workerReportMeta(props)

  return (
    <div className="sa-report">
      <div className="sa-report-header">
        <span className="badge badge-neutral">
          <HelmxIcon name="bot" size={11} />
          <span>{t(SA_WORKER_REPORT)}</span>
        </span>
        {meta.profileId !== undefined ? <span className="badge badge-neutral">{meta.profileId}</span> : null}
        {meta.outcome !== undefined ? (
          <StatusLight status={meta.outcome} label={outcomeLabel(meta.outcome, locale)} />
        ) : null}
      </div>
      <div className="sa-report-summary">{meta.summary ?? ''}</div>
      {meta.artifacts !== undefined && meta.artifacts.length > 0 ? (
        <div className="sa-report-meta">
          {meta.artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => ctx.openArtifact(a.id)}
              title={saArtifactTitle(a.name, a.size, locale)}
            >
              <HelmxIcon name="external-link" size={11} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="row-actions-group">
        <RowAction
          label={t(SA_ACTION_SPLIT_OPEN)}
          iconName="message-square"
          onClick={() => {
            if (meta.workerId !== undefined) ctx.openSplitScreen(`conversation:${meta.workerId}`)
          }}
        />
      </div>
    </div>
  )
}
