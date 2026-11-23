/**
 * Auxiliary timeline rows extracted from ConversationTimeline:
 * ContextDivider, PluginCard, ResolvedAskRow, TurnErrorNotice, and TimelineLiveWaitingRow.
 */
import { useState } from 'react'
import type { AskSpec, ConversationSummary } from '@helmx/protocol/browser'
import { HelmxIcon, useSharedNowMs } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatStopwatchMs, resolveConversationTiming } from '../lib/format.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import type { DividerItem, EditRequestTarget, PluginCardItem } from './timeline-model.js'

export function ContextDivider({ item }: { item: DividerItem }) {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const expandable = item.divider === 'reset' ? item.handoff : item.summary
  const expandLabel = item.divider === 'reset' ? t('conv.divider.handoffSummary') : t('conv.divider.compactionSummary')
  return (
    <div className="context-divider-wrap">
      <div className="context-divider">
        <span className="context-divider-label">
          {item.pending === true ? (
            <>
              <HelmxIcon name="loader" size={11} className="spin-slow" />
              {t('conv.divider.compacting')}
            </>
          ) : (
            <>
              <HelmxIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
              {item.divider === 'reset' ? t('conv.divider.reset') : t('conv.divider.compacted')}
            </>
          )}
        </span>
      </div>
      {expandable !== undefined ? (
        <button
          type="button"
          className="trace-group-summary context-divider-expand-btn"
          onClick={() => setOpen((v) => !v)}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? t('conv.divider.collapse', { label: expandLabel }) : t('conv.divider.expand', { label: expandLabel })}
        </button>
      ) : null}
      {open && expandable !== undefined ? (
        <div className="trace-expanded-body selectable trace-expanded-body-flush">
          <div className="trace-section-label">{expandLabel}</div>
          <pre className="code-block-pre">
            <code>{expandable}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}

export function PluginCard({ item, conversationId }: { item: PluginCardItem; conversationId: number }) {
  const { t } = useWebLocale()
  return (
    <div className="plugin-card">
      <PluginUiView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec}
        conversationId={conversationId}
        label={t('conv.timeline.cardsLabel')}
        slotProps={{ entry: item.entry, conversationId }}
      />
    </div>
  )
}

function resolvedAskLabel(status: string, t: WebMessageTranslator): string {
  if (status === 'answered') return t('conv.ask.approved')
  if (status === 'cancelled') return t('conv.ask.cancelled')
  if (status === 'superseded') return t('conv.ask.superseded')
  return status
}

export function ResolvedAskRow({ ask, status }: { ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }) {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-entry">
      <button type="button" className="trace-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="trace-row-left">
          <HelmxIcon name="check-circle" size={12} />
          <span className="trace-tool-name">{t('conv.ask.rowTitle')}</span>
          <span className="trace-tool-summary">{ask.title}</span>
        </span>
        <span className="trace-row-right">{resolvedAskLabel(status, t)}</span>
      </button>
      {open ? (
        <div className="trace-expanded-body selectable">
          {ask.description !== undefined ? <span>{ask.description}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export function TurnErrorNotice({
  conversation,
  editTarget,
  onRequestEdit,
  onRetryTurn,
}: {
  conversation: ConversationSummary
  editTarget: EditRequestTarget | undefined
  onRequestEdit: (target: EditRequestTarget) => void
  onRetryTurn: (target: EditRequestTarget) => Promise<void>
}) {
  const { t } = useWebLocale()
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="callout callout-error" role="alert" aria-label={t('conv.turnFailed.label')}>
      <HelmxIcon name="alert-triangle" size={12} />
      <span className="callout-text">
        {t('conv.turnFailed.prefix')}{conversation.lastError?.trim() || t('conv.turnFailed.fallback')}
        {editTarget !== undefined ? (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-primary btn-xs"
              title={t('conv.turnFailed.retryTitle')}
              aria-label={t('conv.turnFailed.retryTitle')}
              disabled={retrying}
              onClick={() => {
                setRetrying(true)
                void onRetryTurn(editTarget).finally(() => setRetrying(false))
              }}
            >
              <HelmxIcon name={retrying ? 'loader' : 'rotate-cw'} size={12} className={retrying ? 'spin-slow' : undefined} />
              {t('conv.turnFailed.retryNow')}
            </button>
            {' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={t('conv.turnFailed.editLatest')}
              aria-label={t('conv.turnFailed.editLatest')}
              disabled={retrying}
              onClick={() => onRequestEdit(editTarget)}
            >
              <HelmxIcon name="edit" size={12} />
              {t('conv.human.editAndResend')}
            </button>
          </>
        ) : null}
      </span>
    </div>
  )
}

/** 首 token 前等待行：独立挂载共享秒表（不触发整条时间线每秒重渲染），缺少起点绝不编造。 */
export function TimelineLiveWaitingRow({
  conversation,
  isWorking,
}: {
  conversation: ConversationSummary
  isWorking: boolean
}) {
  const { t } = useWebLocale()
  const clockActive =
    isWorking &&
    typeof conversation.runStartedAt === 'number' &&
    Number.isFinite(conversation.runStartedAt) &&
    conversation.runStartedAt >= 0
  const nowMs = useSharedNowMs(clockActive)
  const currentRunMs = clockActive ? resolveConversationTiming(conversation, nowMs).currentRunMs : undefined
  return (
    <div className="msg-ai-block" role="status" aria-live="polite">
      <span className="msg-origin-tag msg-live-waiting" aria-label={t('conv.timeline.generating')}>
        <span className="msg-live-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {currentRunMs !== undefined ? (
          <span className="msg-live-meta">
            <span className="msg-live-label">{t('conv.turn.generatingShort')}</span>
            <span className="msg-live-sep" aria-hidden="true">{' · '}</span>
            <span className="msg-live-elapsed mono tabular-nums">{formatStopwatchMs(currentRunMs)}</span>
          </span>
        ) : (
          <span className="msg-live-label">{t('conv.timeline.generating')}</span>
        )}
      </span>
    </div>
  )
}
