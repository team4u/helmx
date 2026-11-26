/**
 * Auxiliary timeline rows extracted from ConversationTimeline:
 * ContextDivider, PluginCard, TurnErrorNotice, and TimelineLiveWaitingRow.
 */
import { useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { Button, HelmxIcon, useSharedNowMs } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatStopwatchMs, resolveConversationTiming } from '../lib/format.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { MarkdownView } from './MarkdownView.js'
import type { DividerItem, EditRequestTarget, PluginCardItem } from './timeline-model.js'

export function ContextDivider({ item, conversationId }: { item: DividerItem; conversationId?: number }) {
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
              <span>{t('conv.divider.compacting')}</span>
            </>
          ) : (
            <>
              <HelmxIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
              <span>{item.divider === 'reset' ? t('conv.divider.reset') : t('conv.divider.compacted')}</span>
            </>
          )}
        </span>
      </div>
      {expandable !== undefined ? (
        <button
          type="button"
          className="trace-group-summary context-divider-expand-btn"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? t('conv.divider.collapse', { label: expandLabel }) : t('conv.divider.expand', { label: expandLabel })}
        </button>
      ) : null}
      {open && expandable !== undefined ? (
        <div className="trace-expanded-body selectable trace-expanded-body-flush context-divider-expanded">
          <div className="trace-section-label">{expandLabel}</div>
          <MarkdownView text={expandable} conversationId={conversationId} />
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
            <Button
              variant="primary"
              size="xs"
              icon="rotate-cw"
              pending={retrying}
              title={t('conv.turnFailed.retryTitle')}
              aria-label={t('conv.turnFailed.retryTitle')}
              onClick={() => {
                setRetrying(true)
                void onRetryTurn(editTarget).finally(() => setRetrying(false))
              }}
            >
              {t('conv.turnFailed.retryNow')}
            </Button>
            {' '}
            <Button
              variant="ghost"
              size="sm"
              icon={<HelmxIcon name="edit" size={12} />}
              title={t('conv.turnFailed.editLatest')}
              aria-label={t('conv.turnFailed.editLatest')}
              disabled={retrying}
              onClick={() => onRequestEdit(editTarget)}
            >
              {t('conv.human.editAndResend')}
            </Button>
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
