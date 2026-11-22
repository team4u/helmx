import { useContext, useMemo, useState } from 'react'
import type { ConversationEntry, ConversationSummary } from '@helmx/protocol/browser'
import { CopyButton, HelmxIcon, ToolActivityContext, Tooltip, useSharedNowMs } from '@helmx/plugin-client'
import { MarkdownView } from './MarkdownView.js'
import { StepGroup, TraceRow } from './TimelineRows.js'
import { ToolActivityProvider } from './ToolActivityProvider.js'
import { isAssistantTurnBusy, assistantModelFullLabel, assistantModelShortLabel, type AssistantModelIdentity, type AssistantTurn, type ProcessShortcutCommand } from './timeline-model.js'
import {
  formatDurationMs,
  formatFullTimestamp,
  formatMessageTime,
  formatStopwatchMs,
  resolveConversationTiming,
} from '../lib/format.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

// ---------------------------------------------------------------------------
// 实际生成模型边界（回看最近 assistant 回合模型不同时，锚定新模型 entry 之前；
// 判定纯函数见 timeline-model.ts 的 buildAssistantModelBoundaries）
// ---------------------------------------------------------------------------

export function AssistantModelBoundary({ model }: { model: AssistantModelIdentity }) {
  const { t } = useWebLocale()
  const full = assistantModelFullLabel(model, t)
  return (
    <div
      className="model-boundary"
      role="separator"
      aria-label={t('conv.model.boundarySwitchedTo', { model: full })}
      title={t('conv.model.boundarySwitched', { model: full })}
    >
      <span className="model-boundary-label">
        <HelmxIcon name="cpu" size={11} />
        <span className="mono">{assistantModelShortLabel(model)}</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant 回合（自 ConversationTimeline 拆出的子组件）
// ---------------------------------------------------------------------------

export interface AssistantTurnViewProps {
  turn: AssistantTurn
  conversation: ConversationSummary
  isLatestTurn?: boolean
  /** 是否为当前时间线末尾（忽略排队输入）的助手回合，用于在 blocked 态承接等待审批秒表。 */
  isTrailingTurn?: boolean
  /** 回合锚点对应的真实持久化 pi.assistant 条目（见 resolveAssistantAnchorEntry）。 */
  anchorEntry?: ConversationEntry
  /** Ctrl+O 过程步骤折叠指令（仅最新含过程步骤回合传入）。 */
  processShortcut?: ProcessShortcutCommand
  /** 从回合末条目分叉新会话（ConversationTimeline 统一实例化的动作服务）。 */
  onForkFromHere: (entryId: string) => Promise<void>
  /** 一键重新生成最新已完成助手回合（重发其对应的最后一条可编辑人类消息）。 */
  onRegenerate?: () => Promise<void>
}

export function AssistantTurnView(props: AssistantTurnViewProps) {
  return <ToolActivityProvider><AssistantTurnContent {...props} /></ToolActivityProvider>
}

function AssistantTurnContent({
  turn,
  conversation,
  isLatestTurn = false,
  isTrailingTurn,
  processShortcut,
  onForkFromHere,
  onRegenerate,
}: AssistantTurnViewProps) {
  const { t } = useWebLocale()
  const activeToolCallIds = useContext(ToolActivityContext)?.activeToolCallIds
  const [forking, setForking] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // 流式正文提示：live 回合的最后一个文本段是仍在增长的真 live 文本（流式增量
  // 总并入末段），传 streaming 启用 MarkdownView 流式渲染路径；已结算回合与
  // 其他静态 Markdown 不启用。
  const lastTextSegIndex = useMemo(() => {
    for (let i = turn.segments.length - 1; i >= 0; i--) {
      if (turn.segments[i]!.kind === 'text') return i
    }
    return -1
  }, [turn.segments])
  // 回合末尾复制按钮仅复制最后一个助手文本回复，避免把工具调用前的过程旁白混入剪贴板。
  const lastText = useMemo(() => {
    if (lastTextSegIndex < 0) return ''
    const seg = turn.segments[lastTextSegIndex]
    return seg?.kind === 'text' ? seg.text : ''
  }, [turn.segments, lastTextSegIndex])

  const forkFromHere = async (): Promise<void> => {
    const entryId = turn.entryIds.length > 0 ? turn.entryIds[turn.entryIds.length - 1]! : undefined
    if (entryId === undefined) return
    setForking(true)
    try {
      await onForkFromHere(entryId)
    } finally {
      setForking(false)
    }
  }

  const regenerateTurn = async (): Promise<void> => {
    if (onRegenerate === undefined || regenerating) return
    setRegenerating(true)
    try {
      await onRegenerate()
    } finally {
      setRegenerating(false)
    }
  }

  const effectiveTrailing = isTrailingTurn ?? isLatestTurn
  const hasPendingAsk =
    typeof conversation.pendingAskCount === 'number' &&
    Number.isFinite(conversation.pendingAskCount) &&
    conversation.pendingAskCount > 0
  const isConversationBlocked = conversation.status === 'blocked' || hasPendingAsk
  const liveTrackActive = turn.live || (effectiveTrailing && isConversationBlocked)
  const needsLiveClock =
    liveTrackActive &&
    (isConversationBlocked
      ? (conversation.pendingAskCount === undefined || hasPendingAsk) &&
        typeof conversation.pendingAskSince === 'number' &&
        Number.isFinite(conversation.pendingAskSince) &&
        conversation.pendingAskSince >= 0
      : conversation.status === 'working' &&
        typeof conversation.runStartedAt === 'number' &&
        Number.isFinite(conversation.runStartedAt) &&
        conversation.runStartedAt >= 0)
  const liveNowMs = useSharedNowMs(needsLiveClock)
  const liveTiming = liveTrackActive ? resolveConversationTiming(conversation, liveNowMs) : undefined

  const isBusy = isAssistantTurnBusy(turn, conversation, { isLatestTurn, activeToolCallIds })

  const timeMs = turn.settledAt ?? turn.startedAt
  const displayTime = formatMessageTime(timeMs)
  const durationText = turn.durationMs !== undefined && turn.durationMs > 0 ? formatDurationMs(turn.durationMs) : ''
  const hasTimeInfo = !isBusy && (displayTime !== '' || durationText !== '')
  const fullTimestamp = formatFullTimestamp(timeMs)
  let baseTooltipText = ''
  if (fullTimestamp !== '' && durationText !== '') {
    baseTooltipText = t('conv.turn.completedAtTook', { time: fullTimestamp, duration: durationText })
  } else if (fullTimestamp !== '') {
    baseTooltipText = t('conv.turn.completedAt', { time: fullTimestamp })
  } else if (durationText !== '') {
    baseTooltipText = t('conv.turn.took', { duration: durationText })
  }
  const hasModelDuration = turn.modelDurationMs !== undefined && turn.modelDurationMs > 0
  const hasToolDuration = turn.toolDurationMs !== undefined && turn.toolDurationMs > 0
  const showBreakdown =
    hasToolDuration ||
    (hasModelDuration && turn.durationMs !== undefined && turn.durationMs !== turn.modelDurationMs)
  const breakdownParts: string[] = []
  if (showBreakdown) {
    if (hasModelDuration) {
      breakdownParts.push(t('conv.turn.modelDuration', { duration: formatDurationMs(turn.modelDurationMs) }))
    }
    if (hasToolDuration) {
      breakdownParts.push(t('conv.turn.toolsDuration', { duration: formatDurationMs(turn.toolDurationMs) }))
    }
  }
  const tooltipLines = [baseTooltipText, breakdownParts.join(' · ')].filter((line) => line !== '')
  const tooltipText = tooltipLines.join('\n')

  const showHoverBar = !isBusy && (lastText !== '' || turn.entryIds.length > 0)
  // 实际生成模型标签：仅来自本回合已落库 pi.assistant 的可信身份；busy（live/
  // 在途）回合不展示，避免把待生成内容归到任何模型；缺失则不显示。
  const modelFull = turn.model !== undefined ? assistantModelFullLabel(turn.model, t) : ''
  const modelShort = turn.model !== undefined ? assistantModelShortLabel(turn.model) : ''
  const showModelTag = !isBusy && modelShort !== ''

  const showBlockedStopwatch = liveTiming?.isBlocked === true && liveTiming.waitingMs !== undefined
  const showWorkingStopwatch =
    !showBlockedStopwatch && turn.live && liveTiming?.currentRunMs !== undefined

  return (
    <div className="msg-ai-block" tabIndex={0}>
      {turn.segments.map((seg, segIndex) => {
        if (seg.kind === 'text') {
          return (
            <MarkdownView
              key={seg.key}
              text={seg.text}
              conversationId={conversation.id}
              streaming={turn.live && segIndex === lastTextSegIndex}
            />
          )
        }
        if (seg.kind === 'step-group') {
          return (
            <StepGroup
              key={seg.key}
              steps={seg.steps}
              active={seg.active === true}
              conversationId={conversation.id}
              shortcutToggle={processShortcut}
            />
          )
        }
        return (
          <TraceRow
            key={seg.key}
            tool={seg.tool}
            conversationId={conversation.id}
            defaultOpen={false}
          />
        )
      })}
      {showBlockedStopwatch ? (
        <span
          className="msg-origin-tag msg-live-indicator msg-live-indicator-warn"
          aria-label={t('conv.turn.awaitingApproval')}
          role="status"
        >
          <HelmxIcon name="clock" size={11} />
          <span className="msg-live-meta">
            <span className="msg-live-label">{t('conv.turn.awaitingApproval')}</span>
            <span className="msg-live-sep" aria-hidden="true">{' · '}</span>
            <span className="msg-live-elapsed mono tabular-nums">{formatStopwatchMs(liveTiming.waitingMs)}</span>
          </span>
        </span>
      ) : turn.live ? (
        <span className="msg-origin-tag msg-live-indicator" aria-label={t('conv.timeline.generating')} role="status">
          <span className="msg-live-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {showWorkingStopwatch ? (
            <span className="msg-live-meta">
              <span className="msg-live-label">{t('conv.turn.generatingShort')}</span>
              <span className="msg-live-sep" aria-hidden="true">{' · '}</span>
              <span className="msg-live-elapsed mono tabular-nums">{formatStopwatchMs(liveTiming.currentRunMs)}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {hasTimeInfo || showHoverBar || showModelTag ? (
        <div className="msg-ai-footer">
          {showModelTag ? (
            <Tooltip content={t('conv.model.effective', { model: modelFull })}>
              <span className="msg-time-meta" title={t('conv.model.effective', { model: modelFull })}>
                <HelmxIcon name="cpu" size={11} />
                <span className="mono">{modelShort}</span>
              </span>
            </Tooltip>
          ) : null}
          {hasTimeInfo ? (
            <Tooltip content={tooltipText} className={tooltipLines.length > 1 ? 'helmx-tooltip-multiline' : undefined}>
              <span className="msg-time-meta" title={tooltipText}>
                {displayTime !== '' ? <span>{displayTime}</span> : null}
                {displayTime !== '' && durationText !== '' ? <span className="msg-time-sep">·</span> : null}
                {durationText !== '' ? <span className="tabular-nums">{t('conv.turn.took', { duration: durationText })}</span> : null}
              </span>
            </Tooltip>
          ) : null}
          {showHoverBar ? (
            <span className="msg-hover-bar">
              {lastText !== '' ? <CopyButton text={lastText} /> : null}
              {isLatestTurn && onRegenerate !== undefined ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={t('conv.turn.regenerate')}
                  aria-label={t('conv.turn.regenerate')}
                  disabled={regenerating}
                  onClick={() => void regenerateTurn()}
                >
                  <HelmxIcon name={regenerating ? 'loader' : 'rotate-cw'} size={12} className={regenerating ? 'spin-slow' : undefined} />
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={t('conv.turn.forkFromHere')}
                disabled={forking || turn.entryIds.length === 0}
                onClick={() => void forkFromHere()}
              >
                <HelmxIcon name={forking ? 'loader' : 'git-fork'} size={12} />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
