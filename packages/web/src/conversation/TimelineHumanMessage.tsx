/**
 * Human / queued / external-origin input pill row for ConversationTimeline.
 */
import { memo, useId, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { CopyButton, HelmxIcon } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatFullTimestamp, formatMessageTime } from '../lib/format.js'
import { useStoreActions } from '../lib/store-context.js'
import { MarkdownView } from './MarkdownView.js'
import { AttachmentChips } from './TimelineAttachmentChips.js'
import {
  queuedAgentTextCollapse,
  type EditRequestTarget,
  type HumanInputItem,
} from './timeline-model.js'

const QUEUED_MODE_ICON: Record<'steer' | 'followUp', string> = {
  steer: 'corner-down-right',
  followUp: 'clock',
}

function originLabel(origin: string, t: WebMessageTranslator): string {
  if (origin === 'agent') return t('conv.origin.agentReport')
  if (origin === 'trigger') return t('conv.origin.trigger')
  return origin
}

function queuedModeText(mode: 'steer' | 'followUp', t: WebMessageTranslator): string {
  return mode === 'steer' ? t('conv.queued.steer') : t('conv.queued.followUp')
}

export interface TimelineHumanMessageProps {
  item: HumanInputItem
  conversation: ConversationSummary
  onRequestEdit: (target: EditRequestTarget) => void
  onForkFromHere: (entryId: string) => Promise<void>
  onWithdrawQueuedEdit: (subId: string, target: EditRequestTarget) => Promise<void>
}

export const TimelineHumanMessage = memo(function TimelineHumanMessage({
  item,
  conversation,
  onRequestEdit,
  onForkFromHere,
  onWithdrawQueuedEdit,
}: TimelineHumanMessageProps) {
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [forking, setForking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  const humanTime = formatMessageTime(item.createdAt)
  const humanFullTime = formatFullTimestamp(item.createdAt)
  const hasHumanTime = item.createdAt !== undefined && humanTime !== ''

  const [longOpen, setLongOpen] = useState(false)
  const queuedCollapse =
    item.queuedMode !== undefined && item.origin !== 'human'
      ? queuedAgentTextCollapse(item.text)
      : undefined
  const collapseBodyId = useId()

  const editRequest = async (): Promise<void> => {
    if (item.origin !== 'human') return
    const attachments =
      item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}
    if (item.queuedMode === undefined) {
      const numericId = Number(item.entryId)
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        pushNotice({
          type: 'notification',
          level: 'error',
          title: t('conv.human.cannotEditTitle'),
          body: t('conv.human.cannotEditBody', { entryId: item.entryId }),
          conversationId: conversation.id,
        })
        return
      }
      onRequestEdit({ text: item.text, entryId: numericId, ...attachments })
      return
    }
    const subId = item.entryId.startsWith('queued:') ? item.entryId.slice('queued:'.length) : item.entryId
    setWithdrawing(true)
    try {
      await onWithdrawQueuedEdit(subId, { text: item.text, ...attachments })
    } finally {
      setWithdrawing(false)
    }
  }

  const forkFromHere = async (): Promise<void> => {
    setForking(true)
    try {
      await onForkFromHere(item.entryId)
    } finally {
      setForking(false)
    }
  }

  const markdownBody = <MarkdownView text={item.text} conversationId={conversation.id} breaks />
  const bodyContent =
    queuedCollapse?.collapsed === true && !longOpen ? (
      <span id={collapseBodyId} className="msg-human-collapsed-text">
        {queuedCollapse.preview}
      </span>
    ) : queuedCollapse !== undefined ? (
      <div id={collapseBodyId}>{markdownBody}</div>
    ) : (
      markdownBody
    )

  return (
    <div className={`msg-human-row${item.origin !== 'human' ? ' msg-human-row-external' : ''}`}>
      {item.queuedMode !== undefined ? (
        <span className="msg-origin-tag" role="status">
          <HelmxIcon name={QUEUED_MODE_ICON[item.queuedMode]} size={11} />
          {queuedModeText(item.queuedMode, t)}
        </span>
      ) : item.origin !== 'human' ? (
        <span className="msg-origin-tag">
          <HelmxIcon name={item.origin === 'trigger' ? 'webhook' : 'bot'} size={11} />
          {originLabel(item.origin, t)}
        </span>
      ) : null}
      <div className={`msg-human-pill selectable${item.queuedMode !== undefined ? ' msg-human-pill-queued' : ''}${queuedCollapse?.collapsed === true ? ' msg-human-pill-collapsible' : ''}`}>
        {bodyContent}
        {queuedCollapse?.collapsed === true ? (
          <button
            type="button"
            className="msg-human-collapse-btn"
            aria-expanded={longOpen}
            aria-controls={collapseBodyId}
            onClick={() => setLongOpen((current) => !current)}
          >
            <HelmxIcon name={longOpen ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{longOpen ? t('common.collapse') : t('conv.human.expandFullText', { count: item.text.length })}</span>
          </button>
        ) : null}
      </div>
      {item.attachments !== undefined && item.attachments.length > 0 ? (
        <AttachmentChips attachments={item.attachments} conversationId={conversation.id} />
      ) : null}
      <div className="msg-human-footer">
        <span className="msg-hover-bar">
          <CopyButton text={item.text} />
          {item.origin === 'human' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={item.queuedMode !== undefined ? t('conv.human.withdrawQueueAndEdit') : t('conv.human.editAndResend')}
              aria-label={item.queuedMode !== undefined ? t('conv.human.withdrawQueueAndEdit') : t('conv.human.editAndResend')}
              disabled={withdrawing}
              onClick={() => void editRequest()}
            >
              <HelmxIcon name={withdrawing ? 'loader' : 'edit'} size={12} className={withdrawing ? 'spin-slow' : undefined} />
            </button>
          ) : null}
          {item.queuedMode === undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={t('conv.human.forkFromMessage')}
              aria-label={t('conv.human.forkFromMessage')}
              disabled={forking}
              onClick={() => void forkFromHere()}
            >
              <HelmxIcon name={forking ? 'loader' : 'git-fork'} size={12} />
            </button>
          ) : null}
        </span>
        {hasHumanTime ? (
          <span className="msg-time-meta" title={t('conv.human.sentAt', { time: humanFullTime })}>{humanTime}</span>
        ) : null}
      </div>
    </div>
  )
})
