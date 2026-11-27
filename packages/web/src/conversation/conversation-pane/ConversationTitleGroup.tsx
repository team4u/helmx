/**
 * Title group of the conversation top bar: parent-conversation link, inline rename input or
 * the title button with its metadata popover (id / agent / node / cwd / ownership / model /
 * timing), and the environment subtitle (full + compact remote tag).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { HelmxIcon, Input, Popover, PopoverContent, PopoverTrigger } from '@helmx/ui'
import { useSharedNowMs } from '@helmx/plugin-client'
import { formatDurationMs, formatFullTimestamp, formatStopwatchMs, resolveConversationTiming } from '../../lib/format.js'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { formatEnvSubtitle } from '../composer-model.js'
import { conversationDurationNeedsLiveClock } from '../conversation-duration-model.js'

/** 顶栏标题浮层内的时间与耗时明细：仅在 Popover 打开并挂载时订阅共享时钟，关闭即零定时器。 */
function ConversationTitleTimingMeta({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useWebLocale()
  const liveActive = conversationDurationNeedsLiveClock(conversation)
  const nowMs = useSharedNowMs(liveActive)
  const timing = resolveConversationTiming(conversation, nowMs)
  const createdText = formatFullTimestamp(conversation.createdAt)
  return (
    <>
      {createdText !== '' ? (
        <>
          <span className="kv-key">{t('conv.pane.metaCreatedAt')}</span>
          <span className="kv-val mono tabular-nums">{createdText}</span>
        </>
      ) : null}
      {timing.totalRunMs !== undefined && timing.totalRunMs > 0 ? (
        <>
          <span className="kv-key">{t('conv.pane.metaTotalRun')}</span>
          <span className="kv-val mono tabular-nums">
            {timing.currentRunMs !== undefined
              ? formatStopwatchMs(timing.totalRunMs)
              : formatDurationMs(timing.totalRunMs)}
          </span>
        </>
      ) : null}
      {timing.currentRunMs !== undefined ? (
        <>
          <span className="kv-key">{t('conv.pane.metaCurrentRun')}</span>
          <span className="kv-val mono tabular-nums">{formatStopwatchMs(timing.currentRunMs)}</span>
        </>
      ) : null}
      {timing.waitingMs !== undefined ? (
        <>
          <span className="kv-key">{t('conv.pane.metaWaitingApproval')}</span>
          <span className="kv-val mono tabular-nums pane-title-meta-warn">
            {formatStopwatchMs(timing.waitingMs)}
          </span>
        </>
      ) : null}
      {conversation.completionSeq > 0 ? (
        <>
          <span className="kv-key">{t('conv.pane.metaSettledTurns')}</span>
          <span className="kv-val mono tabular-nums">{conversation.completionSeq}</span>
        </>
      ) : null}
    </>
  )
}

export interface ConversationTitleGroupProps {
  conversation: ConversationSummary
  currentNodeId: string
  renaming: boolean
  titleDraft: string
  onTitleDraftChange: (next: string) => void
  /** Enter / blur: leaves rename mode and persists the trimmed draft. */
  onRenameCommit: () => void
  /** Escape: leaves rename mode without persisting. */
  onRenameCancel: () => void
  parentConversationId?: number
  parentTitle: string
  onOpenParent: () => void
}

export function ConversationTitleGroup({
  conversation,
  currentNodeId,
  renaming,
  titleDraft,
  onTitleDraftChange,
  onRenameCommit,
  onRenameCancel,
  parentConversationId,
  parentTitle,
  onOpenParent,
}: ConversationTitleGroupProps) {
  const { t } = useWebLocale()
  const titleText = conversation.title === '' ? t('conv.pane.titleFallback', { id: conversation.id }) : conversation.title
  const envSubtitle = formatEnvSubtitle(
    { profileId: conversation.profileId, nodeId: currentNodeId, cwd: conversation.cwd },
    t,
  )
  const envSubtitleCompact = formatEnvSubtitle(
    { profileId: conversation.profileId, nodeId: currentNodeId, cwd: conversation.cwd, compact: true },
    t,
  )
  const remoteNodeTag = envSubtitleCompact.text !== '' ? envSubtitleCompact.text : null
  return (
    <div className="pane-title-group">
      {parentConversationId !== undefined ? (
        <button
          type="button"
          className="pane-parent-link"
          title={t('conv.pane.openParent', { title: parentTitle })}
          aria-label={t('conv.pane.openParent', { title: parentTitle })}
          onClick={onOpenParent}
        >
          <HelmxIcon name="arrow-left" size={11} />
          <span>{parentTitle}</span>
        </button>
      ) : null}
      {renaming ? (
        <Input
          size="sm"
          className="pane-title-rename-input"
          aria-label={t('conv.pane.renameConversation')}
          value={titleDraft}
          autoFocus
          onChange={(e) => onTitleDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit()
            else if (e.key === 'Escape') onRenameCancel()
          }}
          onBlur={onRenameCommit}
        />
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="pane-title pane-title-btn" title={titleText}>
              {titleText}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            portalled
            className="pane-title-popover"
            onCloseAutoFocus={(event) => {
              // Radix FocusScope defers close auto-focus via setTimeout(0); if another
              // control/overlay already claimed focus, never steal focus back and dismiss it.
              const active = document.activeElement
              if (active !== null && active !== document.body && active !== document.documentElement) {
                event.preventDefault()
              }
            }}
          >
            <div className="pane-title-popover-heading">{titleText}</div>
            <div className="kv-grid pane-title-popover-meta">
              <span className="kv-key">{t('conv.pane.metaConversationId')}</span>
              <span className="kv-val mono">#{conversation.id}</span>
              <span className="kv-key">{t('conv.pane.metaAgents')}</span>
              <span className="kv-val">{conversation.profileId}</span>
              <span className="kv-key">{t('conv.pane.metaNode')}</span>
              <span className="kv-val mono">{currentNodeId}</span>
              <span className="kv-key">{t('conv.pane.metaCwd')}</span>
              <span className="kv-val mono">{conversation.cwd || t('conv.pane.cwdNotSet')}</span>
              {conversation.ownedBy !== undefined ? (
                <>
                  <span className="kv-key">{t('conv.pane.metaOwnership')}</span>
                  <span className="kv-val mono">{conversation.ownedBy}</span>
                </>
              ) : null}
              {conversation.model !== '' ? (
                <>
                  <span className="kv-key">{t('conv.pane.metaModel')}</span>
                  <span className="kv-val mono">{conversation.model}</span>
                </>
              ) : null}
              <ConversationTitleTimingMeta conversation={conversation} />
            </div>
          </PopoverContent>
        </Popover>
      )}
      <span className="pane-cwd-subtitle" title={envSubtitle.tooltip}>
        <span className="env-subtitle-full">{envSubtitle.text}</span>
        {remoteNodeTag !== null ? <span className="env-subtitle-compact">{remoteNodeTag}</span> : null}
      </span>
    </div>
  )
}
