import { memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewSpec } from '@helmx/protocol/browser'
import { HelmxIcon, Tooltip, useSharedNowMs } from '@helmx/plugin-client'
import { PluginUiView } from '../ui/PluginUiView.js'
import { ProcessInspectorDrawer } from './ProcessInspectorDrawer.js'
import { useProcessInspector } from './process-inspector-context.js'
import {
  liveThinkingTailPreview,
  resolveSelectedStepIndex,
  selectLivePreviewSteps,
  type ProcessInspectMode,
} from './process-inspector-model.js'
import {
  buildToolViewProps,
  toolStatusIcon,
  toolSummaryText,
  type FoldableStep,
  type ToolTrace,
} from './timeline-model.js'
import { summarizeStepGroup, toolRowStats } from './tool-body-model.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs, formatStopwatchMs } from '../lib/format.js'

// ---------------------------------------------------------------------------
// 工具单行轨迹 / 过程步骤触发行（详情由右侧宽抽屉 ProcessInspectorDrawer 承载）
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
  turnKey,
  segmentKey,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
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
      turnKey={turnKey}
      segmentKey={segmentKey}
    />
  )
})

function MultiStepGroup({
  steps,
  active,
  conversationId,
  turnKey,
  segmentKey,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  turnKey?: string
  segmentKey?: string
}) {
  const inspector = useProcessInspector()
  const [localOpen, setLocalOpen] = useState(false)
  const [localStepKey, setLocalStepKey] = useState<string | undefined>(undefined)
  const [localStepIndex, setLocalStepIndex] = useState<number | undefined>(undefined)
  const [localFollowLive, setLocalFollowLive] = useState<boolean>(active)
  const { t } = useWebLocale()

  const usesContext = inspector !== null && turnKey !== undefined && segmentKey !== undefined
  const activeTarget =
    usesContext &&
    inspector.activeTarget?.kind === 'step-group' &&
    inspector.activeTarget.turnKey === turnKey &&
    inspector.activeTarget.segmentKey === segmentKey
      ? inspector.activeTarget
      : undefined
  const isInspecting = usesContext ? activeTarget !== undefined : localOpen

  const openGroup = (): void => {
    if (usesContext) {
      if (isInspecting) inspector.close()
      else inspector.openStepGroup(turnKey, segmentKey, { followLive: active })
      return
    }
    if (localOpen) {
      setLocalOpen(false)
      return
    }
    setLocalStepKey(undefined)
    setLocalStepIndex(undefined)
    setLocalFollowLive(active)
    setLocalOpen(true)
  }

  const openAtStep = (stepKey: string, stepIndex: number): void => {
    if (usesContext) {
      inspector.openStepGroup(turnKey, segmentKey, { stepKey, stepIndex, followLive: false })
      return
    }
    setLocalStepKey(stepKey)
    setLocalStepIndex(stepIndex)
    setLocalFollowLive(false)
    setLocalOpen(true)
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
  const showErrorBadge = summary.errorCount > 0
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

  const livePreviewSteps = useMemo(
    () => (active ? selectLivePreviewSteps(steps) : []),
    [active, steps],
  )

  const localSelectedIndex = useMemo(
    () =>
      !usesContext && localOpen
        ? resolveSelectedStepIndex(steps, {
            selectedStepKey: localStepKey,
            selectedStepIndex: localStepIndex,
            followLive: localFollowLive,
            active,
          })
        : 0,
    [usesContext, localOpen, steps, localStepKey, localStepIndex, localFollowLive, active],
  )

  return (
    <div className="trace-group">
      <Tooltip content={timeDetails} disabled={!showTime} className="trace-group-time-tooltip">
        <button
          type="button"
          className={`trace-group-summary trace-group-summary-multi${showErrorBadge ? ' trace-group-summary-error' : ''}${isInspecting ? ' is-inspecting' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={isInspecting}
          data-process-toggle="root"
          onClick={openGroup}
          title={showTime ? undefined : isInspecting ? t('conv.process.closeDrawer') : t('conv.process.openDrawer')}
        >
          <span className="trace-group-leading" aria-hidden="true">
            <HelmxIcon
              name={active ? 'loader' : 'list-tree'}
              size={12}
              className={active ? 'spin-slow' : undefined}
            />
          </span>
          <span className="trace-group-title">{summaryTitle}</span>
          {showErrorBadge ? (
            <span className="trace-group-badge trace-group-badge-error">{t('conv.thinking.errorCount', { count: summary.errorCount })}</span>
          ) : null}
          {showTime ? (
            <span className="trace-group-meta tabular-nums">{formatDurationMs(durationMs)}</span>
          ) : null}
          <HelmxIcon name="panel-right" size={11} className="trace-group-drawer-cue" />
        </button>
      </Tooltip>
      {active && livePreviewSteps.length > 0 ? (
        <div className="trace-live-feed">
          {livePreviewSteps.map((item) => {
            if (item.step.kind === 'thinking') {
              const preview = liveThinkingTailPreview(item.step.thinking.text)
              return (
                <button
                  key={`live-think:${item.stepKey}:${item.index}`}
                  type="button"
                  className="trace-live-thinking"
                  title={t('conv.process.openThinkingDrawer')}
                  onClick={() => openAtStep(item.stepKey, item.index)}
                >
                  <span className="trace-live-thinking-head">
                    <HelmxIcon
                      name={item.step.thinking.active ? 'loader' : 'sparkles'}
                      size={11}
                      className={item.step.thinking.active ? 'spin-slow' : undefined}
                    />
                    <span>
                      {item.step.thinking.active ? t('conv.thinking.activeLabel') : t('conv.thinking.label')}
                    </span>
                  </span>
                  {preview.visible !== '' ? (
                    <div className="trace-live-thinking-preview">{preview.visible}</div>
                  ) : null}
                  {preview.truncated ? (
                    <span className="trace-live-thinking-more">{t('conv.process.liveTruncatedHint')}</span>
                  ) : null}
                </button>
              )
            }
            const stepSelected =
              isInspecting &&
              (usesContext
                ? activeTarget !== undefined &&
                  resolveSelectedStepIndex(steps, {
                    selectedStepKey: activeTarget.selectedStepKey,
                    selectedStepIndex: activeTarget.selectedStepIndex,
                    followLive: activeTarget.followLive,
                    active,
                  }) === item.index
                : localSelectedIndex === item.index)
            return (
              <TraceRow
                key={item.step.tool.key}
                tool={item.step.tool}
                conversationId={conversationId}
                inspecting={stepSelected}
                onInspect={() => openAtStep(item.stepKey, item.index)}
              />
            )
          })}
        </div>
      ) : null}
      {!usesContext && localOpen ? (
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
          onFollowLive={() => setLocalFollowLive(true)}
          onClose={() => setLocalOpen(false)}
        />
      ) : null}
    </div>
  )
}

export function ThinkingRow({
  text,
  conversationId,
  active = false,
  defaultOpen = false,
  inline = false,
  turnKey,
  segmentKey,
  stepKey,
  isRootProcessToggle = false,
}: {
  text: string
  conversationId?: number
  active?: boolean
  defaultOpen?: boolean
  inline?: boolean
  turnKey?: string
  segmentKey?: string
  stepKey?: string
  isRootProcessToggle?: boolean
}) {
  const inspector = useProcessInspector()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const { t } = useWebLocale()

  const usesContext = inspector !== null && turnKey !== undefined && segmentKey !== undefined
  const isInspecting = usesContext
    ? inspector.activeTarget?.kind === 'step-group' &&
      inspector.activeTarget.turnKey === turnKey &&
      inspector.activeTarget.segmentKey === segmentKey
    : localOpen

  const openThinkingDrawer = (): void => {
    if (usesContext) {
      if (isInspecting) inspector.close()
      else {
        inspector.openStepGroup(turnKey, segmentKey, {
          ...(stepKey !== undefined ? { stepKey } : {}),
          stepIndex: 0,
          followLive: active,
        })
      }
      return
    }
    setLocalOpen((v) => !v)
  }

  const standaloneSteps = useMemo<FoldableStep[]>(
    () => [
      {
        kind: 'thinking',
        thinking: {
          key: stepKey ?? 'think:0',
          text,
          active,
        },
      },
    ],
    [stepKey, text, active],
  )
  const preview = useMemo(
    () => (active ? liveThinkingTailPreview(text) : { visible: '', truncated: false }),
    [active, text],
  )

  return (
    <div className="trace-group">
      <button
        type="button"
        className={`trace-group-summary${isInspecting ? ' is-inspecting' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={isInspecting}
        {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
        onClick={openThinkingDrawer}
        title={isInspecting ? t('conv.process.closeDrawer') : t('conv.process.openThinkingDrawer')}
      >
        <HelmxIcon
          name={active ? 'loader' : 'sparkles'}
          size={12}
          className={active ? 'spin-slow' : undefined}
        />
        <span>{active ? t('conv.thinking.activeLabel') : t('conv.thinking.label')}</span>
        <HelmxIcon name="panel-right" size={11} className="trace-group-drawer-cue" />
      </button>
      {active && preview.visible !== '' ? (
        <button
          type="button"
          className="trace-live-thinking trace-live-thinking-single"
          title={t('conv.process.openThinkingDrawer')}
          onClick={() => {
            if (usesContext) {
              inspector.openStepGroup(turnKey, segmentKey, {
                ...(stepKey !== undefined ? { stepKey } : {}),
                stepIndex: 0,
                followLive: active,
              })
            } else {
              setLocalOpen(true)
            }
          }}
        >
          <div className="trace-live-thinking-preview">{preview.visible}</div>
          {preview.truncated ? (
            <span className="trace-live-thinking-more">{t('conv.process.liveTruncatedHint')}</span>
          ) : null}
        </button>
      ) : null}
      {!usesContext && localOpen ? (
        <ProcessInspectorDrawer
          open
          inline={inline}
          conversationId={conversationId ?? 0}
          steps={standaloneSteps}
          active={active}
          selectedIndex={0}
          onSelectStep={() => {}}
          onClose={() => setLocalOpen(false)}
        />
      ) : null}
    </div>
  )
}
