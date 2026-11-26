import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewSpec } from '@helmx/protocol/browser'
import { HelmxIcon, Tooltip, useSharedNowMs } from '@helmx/plugin-client'
import { PluginUiView } from '../ui/PluginUiView.js'
import { MarkdownView } from './MarkdownView.js'
import { ProcessInspectorDrawer } from './ProcessInspectorDrawer.js'
import { useProcessInspector } from './process-inspector-context.js'
import {
  resolveSelectedStepIndex,
  stepKeyOf,
  thinkingPreviewLine,
  type ProcessInspectMode,
} from './process-inspector-model.js'
import {
  buildToolViewProps,
  toolStatusIcon,
  toolSummaryText,
  type FoldableStep,
  type ProcessShortcutCommand,
  type ToolTrace,
} from './timeline-model.js'
import { summarizeStepGroup, toolRowStats } from './tool-body-model.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs, formatStopwatchMs } from '../lib/format.js'

// ---------------------------------------------------------------------------
// 工具单行轨迹 / 思考折叠组（一级时间线流水 + 二级右侧单栏详情抽屉）
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

export const TraceRow = memo(function TraceRow({
  tool,
  conversationId,
  defaultOpen = false,
  inline = false,
  turnKey,
  inspecting,
  onInspect,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen?: boolean
  inline?: boolean
  turnKey?: string
  inspecting?: boolean
  onInspect?: () => void
}) {
  const inspector = useProcessInspector()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const { t } = useWebLocale()

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
  // 统一在行尾提供输入/输出检视开关（点击在右侧抽屉查看完整入参、输出与截断原文）；
  // 未设置时保持外层 trace-row + 下方 trace-toolview 的默认双栏形态，点击行进入抽屉查看。
  // 顶层业务卡标记 data-outline-card-id（tool.key）：会话大纲二级锚精确定位。
  const toolView = tool.toolView
  const replaceRow = toolView !== undefined && (toolView.spec as ToolViewSpec).replaceRow === true
  const toolViewProps = useMemo<Record<string, unknown> | undefined>(
    () => (toolView !== undefined ? { ...buildToolViewProps(tool, conversationId) } : undefined),
    [toolView, tool, conversationId],
  )

  const inspectMode: ProcessInspectMode = replaceRow ? 'io' : toolView !== undefined ? 'raw' : 'default'
  const usesContext = onInspect === undefined && inspector !== null && turnKey !== undefined
  const isInspecting =
    onInspect !== undefined
      ? inspecting === true
      : usesContext
        ? inspector.activeTarget?.kind === 'standalone-tool' &&
          inspector.activeTarget.turnKey === turnKey &&
          inspector.activeTarget.toolKey === tool.key &&
          inspector.activeTarget.mode === inspectMode
        : localOpen

  const handleInspect = (): void => {
    if (onInspect !== undefined) {
      onInspect()
      return
    }
    if (usesContext) {
      if (isInspecting) inspector.close()
      else inspector.openStandaloneTool(turnKey, tool.key, inspectMode)
      return
    }
    setLocalOpen((v) => !v)
  }

  const standaloneSteps = useMemo<FoldableStep[]>(() => [{ kind: 'tool', tool }], [tool])

  return (
    <div
      className={`trace-entry${rowFailed ? ' trace-entry-error' : ''}`}
      {...(toolView !== undefined ? { 'data-outline-card-id': tool.key } : {})}
    >
      {toolView !== undefined && replaceRow ? (
        <div className="trace-block">
          <div className="trace-block-head">
            <div className="trace-block-view">
              <PluginUiView
                pluginId={toolView.pluginId}
                spec={toolView.spec}
                conversationId={conversationId}
                label={t('conv.tool.viewLabel', { name: tool.toolName })}
                slotProps={toolViewProps}
              />
            </div>
            <Tooltip content={isInspecting ? t('conv.tool.hideIo') : t('conv.tool.showIo')}>
              <button
                type="button"
                className={`trace-io-toggle${isInspecting ? ' trace-io-toggle-open' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={isInspecting}
                aria-label={
                  isInspecting
                    ? t('conv.tool.hideIoAria', { name: tool.toolName })
                    : t('conv.tool.showIoAria', { name: tool.toolName })
                }
                onClick={handleInspect}
              >
                <HelmxIcon name="code" size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
      ) : (
        <>
          <div
            className={`trace-row${rowFailed ? ' trace-row-error' : ''}${isInspecting ? ' is-inspecting' : ''}`}
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-expanded={isInspecting}
            title={t('conv.process.openToolDrawer', { name: tool.toolName })}
            onClick={handleInspect}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleInspect()
              }
            }}
          >
            <span className="trace-row-left">
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
              <HelmxIcon name="chevron-right" size={11} className="trace-row-chevron" />
            </span>
          </div>
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
        </>
      )}
      {onInspect === undefined && !usesContext && localOpen ? (
        <ProcessInspectorDrawer
          open
          inline={inline}
          conversationId={conversationId}
          steps={standaloneSteps}
          active={tool.status === 'running'}
          selectedIndex={0}
          mode={inspectMode}
          onSelectStep={() => {}}
          onClose={() => setLocalOpen(false)}
        />
      ) : null}
    </div>
  )
})

export const StepGroup = memo(function StepGroup({
  steps,
  active,
  conversationId,
  shortcutToggle,
  turnKey,
  segmentKey,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  shortcutToggle?: ProcessShortcutCommand
  turnKey?: string
  segmentKey?: string
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
        turnKey={turnKey}
        segmentKey={segmentKey}
        stepKey={firstStep.thinking.key}
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
      turnKey={turnKey}
      segmentKey={segmentKey}
    />
  )
})

function MultiStepGroup({
  steps,
  active,
  conversationId,
  shortcutToggle,
  turnKey,
  segmentKey,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  shortcutToggle?: ProcessShortcutCommand
  turnKey?: string
  segmentKey?: string
}) {
  const inspector = useProcessInspector()
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const [prevActive, setPrevActive] = useState(active)
  const [prevShortcutSeq, setPrevShortcutSeq] = useState<number | undefined>(shortcutToggle?.seq)

  const [localDrawerOpen, setLocalDrawerOpen] = useState(false)
  const [localStepKey, setLocalStepKey] = useState<string | undefined>(undefined)
  const [localStepIndex, setLocalStepIndex] = useState<number | undefined>(undefined)
  const [localFollowLive, setLocalFollowLive] = useState<boolean>(active)
  const { t } = useWebLocale()

  const usesContext = inspector !== null && turnKey !== undefined && segmentKey !== undefined

  if (prevActive !== active) {
    setPrevActive(active)
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
    if (!active && !usesContext && localDrawerOpen && localFollowLive && steps.length > 0) {
      const lastIdx = steps.length - 1
      const lastStep = steps[lastIdx]!
      setLocalStepIndex(lastIdx)
      setLocalStepKey(stepKeyOf(lastStep, lastIdx))
    }
  }
  if (shortcutToggle !== undefined && shortcutToggle.seq !== prevShortcutSeq) {
    setPrevShortcutSeq(shortcutToggle.seq)
    setUserOverride(shortcutToggle.open)
  }
  const open = userOverride ?? active

  const activeTarget =
    usesContext &&
    inspector.activeTarget?.kind === 'step-group' &&
    inspector.activeTarget.turnKey === turnKey &&
    inspector.activeTarget.segmentKey === segmentKey
      ? inspector.activeTarget
      : undefined

  const activeContextIndex = useMemo(
    () =>
      usesContext && activeTarget !== undefined
        ? resolveSelectedStepIndex(steps, {
            selectedStepKey: activeTarget.selectedStepKey,
            selectedStepIndex: activeTarget.selectedStepIndex,
            followLive: activeTarget.followLive,
            active,
          })
        : -1,
    [usesContext, activeTarget, steps, active],
  )

  const localSelectedIndex = useMemo(
    () =>
      !usesContext && localDrawerOpen
        ? resolveSelectedStepIndex(steps, {
            selectedStepKey: localStepKey,
            selectedStepIndex: localStepIndex,
            followLive: localFollowLive,
            active,
          })
        : 0,
    [usesContext, localDrawerOpen, steps, localStepKey, localStepIndex, localFollowLive, active],
  )

  const inspectGroupStep = (stepIndex: number, stepKey: string): void => {
    if (usesContext) {
      if (activeTarget !== undefined && activeContextIndex === stepIndex) {
        inspector.close()
        return
      }
      inspector.openStepGroup(turnKey, segmentKey, { stepKey, stepIndex, followLive: false })
      return
    }
    if (localDrawerOpen && localSelectedIndex === stepIndex) {
      setLocalDrawerOpen(false)
      return
    }
    setLocalStepKey(stepKey)
    setLocalStepIndex(stepIndex)
    setLocalFollowLive(false)
    setLocalDrawerOpen(true)
  }

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
          onClick={() => setUserOverride(!open)}
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
          {steps.map((step, idx) => {
            const key = stepKeyOf(step, idx)
            const stepInspecting = usesContext
              ? activeTarget !== undefined && activeContextIndex === idx
              : localDrawerOpen && localSelectedIndex === idx
            if (step.kind === 'thinking') {
              return (
                <ThinkingRow
                  key={`think:${key}:${idx}`}
                  text={step.thinking.text}
                  active={step.thinking.active === true}
                  responseDurationMs={step.thinking.responseDurationMs}
                  inGroup
                  conversationId={conversationId}
                  inspecting={stepInspecting}
                  onInspect={() => inspectGroupStep(idx, key)}
                />
              )
            }
            return (
              <TraceRow
                key={step.tool.key}
                tool={step.tool}
                conversationId={conversationId}
                inspecting={stepInspecting}
                onInspect={() => inspectGroupStep(idx, key)}
              />
            )
          })}
        </div>
      ) : null}
      {!usesContext && localDrawerOpen ? (
        <ProcessInspectorDrawer
          open
          conversationId={conversationId}
          steps={steps}
          active={active}
          selectedIndex={localSelectedIndex}
          followLive={localFollowLive}
          onSelectStep={(idx, key) => {
            setLocalStepIndex(idx)
            setLocalStepKey(key)
            setLocalFollowLive(false)
          }}
          onToggleFollowLive={() => {
            setLocalFollowLive((prev) => !prev)
          }}
          onClose={() => setLocalDrawerOpen(false)}
        />
      ) : null}
    </div>
  )
}

export function ThinkingRow({
  text,
  conversationId,
  active = false,
  responseDurationMs,
  inGroup = false,
  defaultOpen = false,
  inline = false,
  shortcutToggle,
  turnKey,
  segmentKey,
  stepKey,
  inspecting,
  onInspect,
  isRootProcessToggle = false,
}: {
  text: string
  conversationId?: number
  active?: boolean
  responseDurationMs?: number
  inGroup?: boolean
  defaultOpen?: boolean
  inline?: boolean
  shortcutToggle?: ProcessShortcutCommand
  turnKey?: string
  segmentKey?: string
  stepKey?: string
  inspecting?: boolean
  onInspect?: () => void
  isRootProcessToggle?: boolean
}) {
  const inspector = useProcessInspector()
  const [activeInlineOverride, setActiveInlineOverride] = useState<boolean | null>(null)
  const [prevActive, setPrevActive] = useState(active)
  const [localDrawerOpen, setLocalDrawerOpen] = useState(defaultOpen)
  const [prevActiveShortcutSeq, setPrevActiveShortcutSeq] = useState<number | undefined>(shortcutToggle?.seq)
  const handledSettledShortcutSeqRef = useRef<number | undefined>(shortcutToggle?.seq)
  const { t } = useWebLocale()

  if (prevActive !== active) {
    setPrevActive(active)
    if (!active && activeInlineOverride !== null) {
      setActiveInlineOverride(null)
    }
  }

  if (active && isRootProcessToggle && shortcutToggle !== undefined && shortcutToggle.seq !== prevActiveShortcutSeq) {
    setPrevActiveShortcutSeq(shortcutToggle.seq)
    setActiveInlineOverride(shortcutToggle.open)
  }

  const usesContext = onInspect === undefined && inspector !== null && turnKey !== undefined && segmentKey !== undefined
  const isInspecting =
    onInspect !== undefined
      ? inspecting === true
      : usesContext
        ? inspector.activeTarget?.kind === 'step-group' &&
          inspector.activeTarget.turnKey === turnKey &&
          inspector.activeTarget.segmentKey === segmentKey
        : localDrawerOpen

  useEffect(() => {
    if (active || !isRootProcessToggle || shortcutToggle === undefined) return
    if (handledSettledShortcutSeqRef.current === shortcutToggle.seq) return
    handledSettledShortcutSeqRef.current = shortcutToggle.seq
    if (onInspect !== undefined) return
    if (usesContext) {
      if (shortcutToggle.open) {
        inspector.openStepGroup(turnKey, segmentKey, {
          ...(stepKey !== undefined ? { stepKey } : {}),
          stepIndex: 0,
          followLive: false,
        })
      } else {
        inspector.close()
      }
      return
    }
    setLocalDrawerOpen(shortcutToggle.open)
  }, [active, isRootProcessToggle, shortcutToggle, onInspect, usesContext, inspector, turnKey, segmentKey, stepKey])

  const openSettledDrawer = (): void => {
    if (onInspect !== undefined) {
      onInspect()
      return
    }
    if (usesContext) {
      if (isInspecting) inspector.close()
      else {
        inspector.openStepGroup(turnKey, segmentKey, {
          ...(stepKey !== undefined ? { stepKey } : {}),
          stepIndex: 0,
          followLive: false,
        })
      }
      return
    }
    setLocalDrawerOpen((v) => !v)
  }

  const standaloneSteps = useMemo<FoldableStep[]>(
    () => [
      {
        kind: 'thinking',
        thinking: {
          key: stepKey ?? 'think:0',
          text,
          active,
          ...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
        },
      },
    ],
    [stepKey, text, active, responseDurationMs],
  )
  const settledPreview = useMemo(() => (inGroup && !active ? thinkingPreviewLine(text) : ''), [inGroup, active, text])
  const settledDuration =
    inGroup && !active && responseDurationMs !== undefined && responseDurationMs > 0
      ? formatDurationMs(responseDurationMs)
      : ''

  if (active) {
    const inlineOpen = activeInlineOverride ?? true
    return (
      <div className="trace-group">
        <button
          type="button"
          className="trace-group-summary"
          aria-expanded={inlineOpen}
          {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
          onClick={() => setActiveInlineOverride(!inlineOpen)}
          title={inlineOpen ? t('conv.thinking.collapseThinking') : t('conv.thinking.expandThinking')}
        >
          <HelmxIcon name={inlineOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          <HelmxIcon name="loader" size={11} className="spin-slow" />
          {t('conv.thinking.activeLabel')}
        </button>
        {inlineOpen ? (
          <div className="trace-expanded-body selectable thinking-expanded-body">
            {/* Active thinking blocks are live text still growing */}
            <MarkdownView text={text} conversationId={conversationId} streaming />
          </div>
        ) : null}
      </div>
    )
  }

  const standaloneDrawerNode =
    onInspect === undefined && !usesContext && localDrawerOpen ? (
      <ProcessInspectorDrawer
        open
        inline={inline}
        conversationId={conversationId ?? 0}
        steps={standaloneSteps}
        active={false}
        selectedIndex={0}
        onSelectStep={() => {}}
        onClose={() => setLocalDrawerOpen(false)}
      />
    ) : null

  if (inGroup) {
    return (
      <div className="trace-entry">
        <div
          className={`trace-row trace-thinking-row${isInspecting ? ' is-inspecting' : ''}`}
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          aria-expanded={isInspecting}
          {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
          title={isInspecting ? t('conv.process.closeDrawer') : t('conv.process.openThinkingDrawer')}
          onClick={openSettledDrawer}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openSettledDrawer()
            }
          }}
        >
          <span className="trace-row-left">
            <HelmxIcon name="sparkles" size={12} />
            <span className="trace-thinking-title">{t('conv.thinking.label')}</span>
            {settledPreview !== '' ? <span className="trace-thinking-summary">{settledPreview}</span> : null}
          </span>
          <span className="trace-row-right">
            {settledDuration !== '' ? <span>{settledDuration}</span> : null}
            <HelmxIcon name="chevron-right" size={11} className="trace-row-chevron" />
          </span>
        </div>
        {standaloneDrawerNode}
      </div>
    )
  }

  return (
    <div className="trace-group">
      <button
        type="button"
        className={`trace-group-summary${isInspecting ? ' is-inspecting' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isInspecting}
        {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
        onClick={openSettledDrawer}
        title={isInspecting ? t('conv.process.closeDrawer') : t('conv.process.openThinkingDrawer')}
      >
        <HelmxIcon name="sparkles" size={12} />
        <span>{t('conv.thinking.label')}</span>
        <HelmxIcon name="chevron-right" size={11} className="trace-row-chevron" />
      </button>
      {standaloneDrawerNode}
    </div>
  )
}
