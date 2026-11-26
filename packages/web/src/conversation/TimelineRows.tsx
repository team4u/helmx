import { memo, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewSpec } from '@helmx/protocol/browser'
import { Badge, HelmxIcon, Tooltip, useSharedNowMs, type BadgeTone } from '@helmx/plugin-client'
import { PluginUiView } from '../ui/PluginUiView.js'
import { ToolExpandedBody, ToolIoBody, ToolRawBody } from './ToolExpandedBody.js'
import { MarkdownView } from './MarkdownView.js'
import {
  buildToolViewProps,
  toolStatusIcon,
  toolSummaryText,
  type FoldableStep,
  type ProcessShortcutCommand,
  type ToolTrace,
} from './timeline-model.js'
import {
  formatAskUserInlineSummary,
  parseAskUserToolMeta,
  summarizeStepGroup,
  toolRowStats,
  type AskUserToolOutcome,
} from './tool-body-model.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs, formatStopwatchMs } from '../lib/format.js'

// ---------------------------------------------------------------------------
// 工具单行轨迹 / 思考折叠组（ConversationTimeline 的行级渲染单元）
// ---------------------------------------------------------------------------

/**
 * 运行中工具的实时已耗时秒表：起点为派发该调用的响应结束时刻（消息 timestamp+durationMs，
 * 见 timeline-model appendEntry），复用全局共享 1Hz 定时器（useSharedNowMs，无每行独立
 * interval）与整秒单调格式化（formatStopwatchMs，无 `.0s` 抖动），工具落定随行卸载。
 * 时钟源通过 PluginClientHostPort.getServerNow 接入 Hub 校准时钟域。
 */
function RunningElapsed({ startedAt }: { startedAt: number }): ReactNode {
  const nowMs = useSharedNowMs(true)
  if (nowMs === undefined) return null
  return <span className="tabular-nums">{formatStopwatchMs(Math.max(0, nowMs - startedAt))}</span>
}

/** 可折叠单行轨迹外壳：点击 / Enter / Space 切换展开态；左右两栏内容由调用方填充。 */
function TraceRowShell({
  failed,
  open,
  onToggle,
  children,
}: {
  failed: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`trace-row${failed ? ' trace-row-error' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
    >
      {children}
    </div>
  )
}

function askTraceOutcome(outcome: AskUserToolOutcome, t: WebMessageTranslator): { label: string; tone: BadgeTone } {
  switch (outcome) {
    case 'answered':
      return { label: t('conv.ask.replied'), tone: 'ok' }
    case 'cancelled':
      return { label: t('conv.ask.skipped'), tone: 'neutral' }
    case 'superseded':
      return { label: t('conv.ask.outcomeSuperseded'), tone: 'neutral' }
    case 'error':
      return { label: t('conv.ask.outcomeError'), tone: 'err' }
  }
}

export const TraceRow = memo(function TraceRow({
  tool,
  conversationId,
  defaultOpen,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ioPanelId = useId()
  const { t } = useWebLocale()

  const toolView = tool.toolView
  const isAskUserRow = toolView === undefined && tool.toolName === 'ask_user'
  const askMeta = useMemo(
    () => (isAskUserRow ? parseAskUserToolMeta(tool.presentationMeta) : undefined),
    [isAskUserRow, tool.presentationMeta],
  )

  const rowFailed = Boolean(tool.isError)
  // 运行中行右侧只显示实时已耗时秒表（左侧转圈已表意，与落定后的纯耗时形态一致）；
  // 响应缺少 durationMs 等无法诚实锚定起点的场景右侧留空，不编造起始时间。
  const right: ReactNode =
    tool.status === 'running'
      ? tool.startedAt !== undefined
        ? <RunningElapsed startedAt={tool.startedAt} />
        : ''
      : rowFailed && tool.durationMs === undefined
        ? t('conv.tool.statusFailed')
        : tool.durationMs !== undefined
          ? formatDurationMs(tool.durationMs)
          : tool.status === 'done'
            ? t('conv.tool.statusCompleted')
            : ''
  const rowIcon = toolStatusIcon(tool)

  // 单行极简统计（edit +N −N / write 行数）：只报事实，运行态不伪称成功。
  const stats = useMemo(() => toolRowStats(tool, t), [tool, t])

  // 命中插件 tool.view：replaceRow=true 时插件组件替换默认工具行，宿主同时
  // 统一在行首提供输入/输出折叠开关（左侧 chevron 只表折叠/展开，与默认行的
  // chevron 同在 x=8；任意插件卡片均可展开查看完整入参、输出与截断原文）；
  // 未设置时保持外层 trace-row + 下方 trace-toolview 的默认双栏形态。
  // inline 插件视图保留工具行的原始数据入口，专属展开体仅用于宿主工具。
  // 顶层业务卡标记 data-outline-card-id（tool.key）：会话大纲二级锚精确定位。
  const replaceRow = toolView !== undefined && (toolView.spec as ToolViewSpec).replaceRow === true
  const toolViewProps = useMemo<Record<string, unknown> | undefined>(
    () => (toolView !== undefined ? { ...buildToolViewProps(tool, conversationId) } : undefined),
    [toolView, tool, conversationId],
  )

  if (isAskUserRow) {
    const isRunning = tool.status === 'running'
    const askFailed = rowFailed || askMeta?.outcome === 'error'
    const askSummary = formatAskUserInlineSummary(askMeta, toolSummaryText(tool.toolName, tool.input))
    const askIcon = isRunning
      ? 'loader'
      : askFailed
        ? 'alert-triangle'
        : askMeta?.outcome === 'answered'
          ? 'check'
          : 'message-circle'
    const outcomeBadge = !isRunning && askMeta !== undefined ? askTraceOutcome(askMeta.outcome, t) : undefined
    return (
      <div className={`trace-entry${askFailed ? ' trace-entry-error' : ''}`}>
        <TraceRowShell failed={askFailed} open={open} onToggle={() => setOpen((v) => !v)}>
          <span className="trace-row-left">
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="trace-row-chevron" />
            <HelmxIcon
              name={askIcon}
              size={12}
              className={isRunning ? 'spin-slow' : undefined}
            />
            <span className="trace-tool-name">{t('conv.ask.questionRowTitle')}</span>
            {askSummary !== '' ? (
              <span className="trace-tool-summary" title={askSummary}>{askSummary}</span>
            ) : null}
          </span>
          <span className="trace-row-right">
            {isRunning ? (
              <>
                <span>{t('composer.ask.awaitingQuestion')}</span>
                {tool.startedAt !== undefined ? <RunningElapsed startedAt={tool.startedAt} /> : null}
              </>
            ) : outcomeBadge !== undefined ? (
              <Badge tone={outcomeBadge.tone}>{outcomeBadge.label}</Badge>
            ) : (
              right !== '' ? <span>{right}</span> : null
            )}
          </span>
        </TraceRowShell>
        {open ? (
          <div className="trace-expanded-body selectable">
            <ToolExpandedBody tool={tool} conversationId={conversationId} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={`trace-entry${rowFailed ? ' trace-entry-error' : ''}`}
      {...(toolView !== undefined ? { 'data-outline-card-id': tool.key } : {})}
    >
      {toolView !== undefined && replaceRow ? (
        <div className="trace-block">
          <div className="trace-block-head">
            <Tooltip content={open ? t('conv.tool.hideIo') : t('conv.tool.showIo')}>
              <button
                type="button"
                className={`trace-io-toggle${open ? ' trace-io-toggle-open' : ''}`}
                aria-expanded={open}
                aria-controls={ioPanelId}
                aria-label={
                  open
                    ? t('conv.tool.hideIoAria', { name: tool.toolName })
                    : t('conv.tool.showIoAria', { name: tool.toolName })
                }
                onClick={() => setOpen((v) => !v)}
              >
                <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
              </button>
            </Tooltip>
            <div className="trace-block-view">
              <PluginUiView
                pluginId={toolView.pluginId}
                spec={toolView.spec}
                conversationId={conversationId}
                label={t('conv.tool.viewLabel', { name: tool.toolName })}
                slotProps={toolViewProps}
              />
            </div>
          </div>
          <div id={ioPanelId} hidden={!open}>
            {open ? (
              <div className="trace-expanded-body selectable">
                <ToolIoBody tool={tool} conversationId={conversationId} />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <TraceRowShell failed={rowFailed} open={open} onToggle={() => setOpen((v) => !v)}>
            <span className="trace-row-left">
              <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="trace-row-chevron" />
              <HelmxIcon
                name={rowIcon}
                size={12}
                className={tool.status === 'running' ? 'spin-slow' : undefined}
              />
              <span className="trace-tool-name">{tool.toolName}</span>
              <span className="trace-tool-summary">{toolSummaryText(tool.toolName, tool.input)}</span>
              {stats !== undefined ? (
                <span className="trace-row-stats" title={stats.title}>
                  {stats.removeCount !== undefined ? (
                    <span className="trace-row-stats-remove">−{stats.removeCount}</span>
                  ) : null}
                  {stats.addCount !== undefined ? (
                    <span className="trace-row-stats-add">+{stats.addCount}</span>
                  ) : null}
                  {stats.text !== undefined ? <span>{stats.text}</span> : null}
                </span>
              ) : null}
            </span>
            <span className="trace-row-right">
              {right !== '' ? <span>{right}</span> : null}
            </span>
          </TraceRowShell>
          {toolView !== undefined ? (
            <div className="trace-toolview">
              <PluginUiView
                pluginId={toolView.pluginId}
                spec={toolView.spec}
                conversationId={conversationId}
                label={t('conv.tool.viewLabel', { name: tool.toolName })}
                slotProps={toolViewProps}
              />
            </div>
          ) : null}
          {open ? (
            <div className="trace-expanded-body selectable">
              {toolView === undefined
                ? <ToolExpandedBody tool={tool} conversationId={conversationId} />
                : <ToolRawBody tool={tool} conversationId={conversationId} />}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
})

export const StepGroup = memo(function StepGroup({
  steps,
  active,
  conversationId,
  shortcutToggle,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  shortcutToggle?: ProcessShortcutCommand
}) {
  const firstStep = steps[0]
  if (
    steps.length === 1 &&
    firstStep !== undefined &&
    firstStep.kind === 'thinking' &&
    firstStep.thinking.responseDurationMs === undefined
  ) {
    return (
      <ThinkingRow
        text={firstStep.thinking.text}
        active={firstStep.thinking.active === true}
        conversationId={conversationId}
        shortcutToggle={shortcutToggle}
        isRootProcessToggle
      />
    )
  }

  return (
    <MultiStepGroup
      steps={steps}
      active={active}
      conversationId={conversationId}
      shortcutToggle={shortcutToggle}
    />
  )
})

function MultiStepGroup({
  steps,
  active,
  conversationId,
  shortcutToggle,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  shortcutToggle?: ProcessShortcutCommand
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const [prevActive, setPrevActive] = useState(active)
  const [prevShortcutSeq, setPrevShortcutSeq] = useState<number | undefined>(shortcutToggle?.seq)
  const [shortcutExpandSeq, setShortcutExpandSeq] = useState<number | null>(null)
  const { t } = useWebLocale()
  if (prevActive !== active) {
    setPrevActive(active)
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
  }
  if (shortcutToggle !== undefined && shortcutToggle.seq !== prevShortcutSeq) {
    setPrevShortcutSeq(shortcutToggle.seq)
    setUserOverride(shortcutToggle.open)
    setShortcutExpandSeq(shortcutToggle.open ? shortcutToggle.seq : null)
  }
  const open = userOverride ?? active
  const openedByCurrentShortcut =
    shortcutToggle !== undefined &&
    shortcutToggle.open &&
    shortcutExpandSeq === shortcutToggle.seq

  const summary = useMemo(() => summarizeStepGroup(steps), [steps])
  const hasOnlyThinking = steps.every((s) => s.kind === 'thinking')
  const summaryTitle = hasOnlyThinking
    ? active
      ? t('conv.thinking.stepsActive', { count: steps.length })
      : t('conv.thinking.steps', { count: steps.length })
    : active
      ? t('conv.thinking.execActive', { count: steps.length })
      : t('conv.thinking.exec', { count: steps.length })
  const showErrorBadge = !open && summary.errorCount > 0
  // Parallel tools contribute their own durations; the tooltip explains the cumulative total.
  const durationMs = (summary.modelDurationMs ?? 0) + (summary.toolDurationMs ?? 0)
  const showTime = !active && durationMs > 0
  const timeDetails = [
    summary.modelDurationMs !== undefined
      ? t('conv.thinking.modelTime', { duration: formatDurationMs(summary.modelDurationMs) })
      : undefined,
    summary.toolDurationMs !== undefined
      ? t('conv.thinking.toolsTime', { duration: formatDurationMs(summary.toolDurationMs) })
      : undefined,
    t('conv.thinking.totalTimeTitle'),
  ].filter(Boolean).join('\n')

  return (
    <div className="trace-group">
      <Tooltip content={timeDetails} disabled={!showTime} className="trace-group-time-tooltip">
        <button
          type="button"
          className={`trace-group-summary trace-group-summary-multi${showErrorBadge ? ' trace-group-summary-error' : ''}`}
          aria-expanded={open}
          data-process-toggle="root"
          onClick={() => {
            setShortcutExpandSeq(null)
            setUserOverride(!open)
          }}
          title={showTime ? undefined : open ? t('conv.thinking.collapseExec') : t('conv.thinking.expandExec')}
        >
          <span className="trace-group-leading" aria-hidden="true">
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            {active ? <HelmxIcon name="loader" size={11} className="spin-slow" /> : null}
          </span>
          <span className="trace-group-title">{summaryTitle}</span>
          {showErrorBadge ? (
            <span className="trace-group-badge trace-group-badge-error">{t('conv.thinking.errorCount', { count: summary.errorCount })}</span>
          ) : null}
          {showTime ? (
            <span className="trace-group-meta tabular-nums">{formatDurationMs(durationMs)}</span>
          ) : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="trace-group-steps">
          {steps.map((step, idx) =>
            step.kind === 'thinking' ? (
              <ThinkingRow
                key={`think:${idx}`}
                text={step.thinking.text}
                active={step.thinking.active}
                conversationId={conversationId}
                defaultOpen={openedByCurrentShortcut}
                shortcutToggle={shortcutToggle}
              />
            ) : (
              <TraceRow
                key={step.tool.key}
                tool={step.tool}
                conversationId={conversationId}
                defaultOpen={false}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ThinkingRow({
  text,
  conversationId,
  active = false,
  defaultOpen = false,
  shortcutToggle,
  isRootProcessToggle = false,
}: {
  text: string
  conversationId?: number
  active?: boolean
  defaultOpen?: boolean
  shortcutToggle?: ProcessShortcutCommand
  isRootProcessToggle?: boolean
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const [prevActive, setPrevActive] = useState(active)
  const [prevShortcutSeq, setPrevShortcutSeq] = useState<number | undefined>(shortcutToggle?.seq)
  const { t } = useWebLocale()
  if (prevActive !== active) {
    setPrevActive(active)
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
  }
  if (shortcutToggle !== undefined && shortcutToggle.seq !== prevShortcutSeq) {
    setPrevShortcutSeq(shortcutToggle.seq)
    setUserOverride(shortcutToggle.open)
  }
  const open = userOverride ?? (active || defaultOpen)

  return (
    <div className="trace-group">
      <button
        type="button"
        className="trace-group-summary"
        aria-expanded={open}
        {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
        onClick={() => setUserOverride(!open)}
        title={open ? t('conv.thinking.collapseThinking') : t('conv.thinking.expandThinking')}
      >
        <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {active ? <HelmxIcon name="loader" size={11} className="spin-slow" /> : null}
        {active ? t('conv.thinking.activeLabel') : t('conv.thinking.label')}
      </button>
      {open ? (
        <div className="trace-expanded-body selectable thinking-expanded-body">
          {/* Active thinking blocks are live text still growing; static thinking never uses the streaming path */}
          <MarkdownView text={text} conversationId={conversationId} streaming={active} />
        </div>
      ) : null}
    </div>
  )
}
