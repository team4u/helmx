/**
 * Unified right-side drawer for inspecting assistant thinking & tool execution
 * steps (master-detail split for multi-step groups, clean single-column view
 * for standalone thinking or tool calls).
 *
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  IconButton,
  Tooltip,
  useSharedNowMs,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs, formatStopwatchMs } from '../lib/format.js'
import { useIsMobile } from './composer-model.js'
import { MarkdownView } from './MarkdownView.js'
import {
  filterVisibleStepIndices,
  isStepFailed,
  isStepRunning,
  stepKeyOf,
  thinkingPreviewLine,
  type ProcessInspectMode,
} from './process-inspector-model.js'
import { toolStatusIcon, toolSummaryText, type FoldableStep } from './timeline-model.js'
import { summarizeStepGroup, toolRowStats } from './tool-body-model.js'
import { ToolExpandedBody, ToolIoBody, ToolRawBody } from './ToolExpandedBody.js'

export interface ProcessInspectorDrawerProps {
  open: boolean
  /** Force inline rendering without Portal (useful for SSR / isolated unit tests). */
  inline?: boolean
  conversationId: number
  steps: ReadonlyArray<FoldableStep>
  active: boolean
  selectedIndex: number
  mode?: ProcessInspectMode
  followLive?: boolean
  onSelectStep: (index: number, stepKey: string) => void
  onFollowLive?: () => void
  onClose: () => void
}

function StepElapsed({ startedAt }: { startedAt: number }): ReactNode {
  const nowMs = useSharedNowMs(true)
  if (nowMs === undefined) return null
  return <span className="tabular-nums">{formatStopwatchMs(Math.max(0, nowMs - startedAt))}</span>
}

export function ProcessInspectorDrawer({
  open,
  inline = false,
  conversationId,
  steps,
  active,
  selectedIndex,
  mode = 'default',
  followLive,
  onSelectStep,
  onFollowLive,
  onClose,
}: ProcessInspectorDrawerProps): ReactNode {
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const prevOpenRef = useRef(open)

  if (prevOpenRef.current !== open) {
    prevOpenRef.current = open
    if (!open) {
      if (onlyErrors) setOnlyErrors(false)
      if (desktopFullscreen) setDesktopFullscreen(false)
    }
  }

  const summary = useMemo(() => summarizeStepGroup(steps), [steps])
  const effectiveOnlyErrors = onlyErrors && summary.errorCount > 0
  const visibleIndices = useMemo(
    () => filterVisibleStepIndices(steps, effectiveOnlyErrors),
    [steps, effectiveOnlyErrors],
  )

  const safeIndex = steps.length > 0 ? Math.max(0, Math.min(steps.length - 1, selectedIndex)) : -1
  const selectedStep = safeIndex >= 0 ? steps[safeIndex] : undefined
  const selectedStepKey = selectedStep !== undefined ? stepKeyOf(selectedStep, safeIndex) : ''

  useEffect(() => {
    if (!open || steps.length <= 1 || safeIndex < 0) return
    const btn = optionRefs.current[safeIndex]
    btn?.scrollIntoView?.({ block: 'nearest' })
  }, [open, steps.length, safeIndex])

  if (!open || steps.length === 0 || selectedStep === undefined) return null

  const isMulti = steps.length > 1
  const hasOnlyThinking = steps.every((s) => s.kind === 'thinking')
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
  ]
    .filter(Boolean)
    .join('\n')

  const headerTitle: ReactNode = isMulti ? (
    hasOnlyThinking ? (
      active ? t('conv.thinking.stepsActive', { count: steps.length }) : t('conv.thinking.steps', { count: steps.length })
    ) : active ? (
      t('conv.thinking.execActive', { count: steps.length })
    ) : (
      t('conv.thinking.exec', { count: steps.length })
    )
  ) : selectedStep.kind === 'thinking' ? (
    active ? t('conv.thinking.activeLabel') : t('conv.thinking.label')
  ) : (
    <span className="mono">{selectedStep.tool.toolName}</span>
  )

  const headerIcon: ReactNode = active ? (
    <HelmxIcon name="loader" size={14} className="spin-slow process-drawer-status-icon" />
  ) : isMulti ? (
    <HelmxIcon name="list-tree" size={14} className="process-drawer-status-icon" />
  ) : selectedStep.kind === 'thinking' ? (
    <HelmxIcon name="sparkles" size={14} className="process-drawer-status-icon" />
  ) : (
    <HelmxIcon
      name={toolStatusIcon(selectedStep.tool)}
      size={14}
      className={`process-drawer-status-icon${selectedStep.tool.isError ? ' is-error' : ''}`}
    />
  )

  const visiblePos = visibleIndices.indexOf(safeIndex)
  const prevStepIdx = visiblePos > 0 ? visibleIndices[visiblePos - 1] : undefined
  const nextStepIdx =
    visiblePos >= 0 && visiblePos < visibleIndices.length - 1 ? visibleIndices[visiblePos + 1] : undefined

  const selectAtIndex = (index: number): void => {
    const step = steps[index]
    if (step === undefined) return
    onSelectStep(index, stepKeyOf(step, index))
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (visibleIndices.length === 0) return
    let nextTarget: number | undefined
    if (event.key === 'ArrowDown') {
      nextTarget = visiblePos >= 0 && visiblePos < visibleIndices.length - 1
        ? visibleIndices[visiblePos + 1]
        : visibleIndices[0]
    } else if (event.key === 'ArrowUp') {
      nextTarget = visiblePos > 0
        ? visibleIndices[visiblePos - 1]
        : visibleIndices[visibleIndices.length - 1]
    } else if (event.key === 'Home') {
      nextTarget = visibleIndices[0]
    } else if (event.key === 'End') {
      nextTarget = visibleIndices[visibleIndices.length - 1]
    }
    if (nextTarget === undefined) return
    event.preventDefault()
    selectAtIndex(nextTarget)
    optionRefs.current[nextTarget]?.focus({ preventScroll: true })
  }

  const selectedRunning = isStepRunning(selectedStep)
  const selectedFailed = isStepFailed(selectedStep)
  const selectedToolStats = selectedStep.kind === 'tool' ? toolRowStats(selectedStep.tool, t) : undefined
  const selectedToolSummary =
    selectedStep.kind === 'tool' ? toolSummaryText(selectedStep.tool.toolName, selectedStep.tool.input) : ''

  const drawerClass = [
    'process-inspector-drawer',
    isMulti ? 'process-inspector-drawer-multi' : 'process-inspector-drawer-single',
    !isMobile && desktopFullscreen ? 'process-inspector-drawer-fullscreen' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Dialog
      open
      inline={inline}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop process-inspector-backdrop" />
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className={drawerClass}
          aria-label={t('conv.process.drawerAria')}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
        >
          <div className="process-drawer-header">
            <div className="process-drawer-header-left">
              {headerIcon}
              <div className="process-drawer-title-group">
                <DialogTitle className="process-drawer-title">{headerTitle}</DialogTitle>
                {isMulti ? (
                  <Badge tone="neutral" mono className="tabular-nums">
                    {t('conv.process.stepCounter', { current: safeIndex + 1, total: steps.length })}
                  </Badge>
                ) : null}
                {active ? <Badge tone="accent">{t('conv.process.runningBadge')}</Badge> : null}
                {summary.errorCount > 0 ? (
                  <Badge tone="err" className="tabular-nums">
                    {t('conv.thinking.errorCount', { count: summary.errorCount })}
                  </Badge>
                ) : null}
                {showTime ? (
                  <Tooltip content={timeDetails} className="trace-group-time-tooltip">
                    <span className="process-drawer-duration mono tabular-nums">
                      {formatDurationMs(durationMs)}
                    </span>
                  </Tooltip>
                ) : null}
              </div>
            </div>

            <div className="process-drawer-actions">
              {isMulti && active && followLive === false && onFollowLive !== undefined ? (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="arrow-down-to-line"
                  title={t('conv.process.followLiveTitle')}
                  onClick={onFollowLive}
                >
                  {t('conv.process.followLive')}
                </Button>
              ) : null}
              {isMulti ? (
                <>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon="chevron-up"
                    label={t('conv.process.prevStep')}
                    disabled={prevStepIdx === undefined}
                    onClick={() => {
                      if (prevStepIdx !== undefined) selectAtIndex(prevStepIdx)
                    }}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    icon="chevron-down"
                    label={t('conv.process.nextStep')}
                    disabled={nextStepIdx === undefined}
                    onClick={() => {
                      if (nextStepIdx !== undefined) selectAtIndex(nextStepIdx)
                    }}
                  />
                </>
              ) : null}
              {!isMobile ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={desktopFullscreen ? 'minimize-2' : 'maximize-2'}
                  label={desktopFullscreen ? t('conv.process.exitFullscreen') : t('conv.process.enterFullscreen')}
                  active={desktopFullscreen}
                  onClick={() => setDesktopFullscreen((v) => !v)}
                />
              ) : null}
              <DialogClose asChild>
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon="x"
                  className="process-drawer-close-btn"
                  label={t('conv.process.closeDrawer')}
                  title={t('conv.process.closeTitle')}
                />
              </DialogClose>
            </div>
          </div>

          <div className={`process-drawer-body${isMulti ? ' process-drawer-body-split' : ''}`}>
            {isMulti ? (
              <aside className="process-drawer-sidebar">
                {summary.errorCount > 0 ? (
                  <div
                    className="process-drawer-filter"
                    role="group"
                    aria-label={t('conv.process.filterAria')}
                  >
                    <button
                      type="button"
                      className={`process-drawer-filter-btn${!effectiveOnlyErrors ? ' is-active' : ''}`}
                      aria-pressed={!effectiveOnlyErrors}
                      onClick={() => setOnlyErrors(false)}
                    >
                      {t('conv.process.filterAll', { count: steps.length })}
                    </button>
                    <button
                      type="button"
                      className={`process-drawer-filter-btn process-drawer-filter-btn-err${effectiveOnlyErrors ? ' is-active' : ''}`}
                      aria-pressed={effectiveOnlyErrors}
                      onClick={() => {
                        setOnlyErrors(true)
                        if (!isStepFailed(selectedStep)) {
                          const firstFailed = steps.findIndex((s) => isStepFailed(s))
                          if (firstFailed >= 0) selectAtIndex(firstFailed)
                        }
                      }}
                    >
                      {t('conv.process.filterErrors', { count: summary.errorCount })}
                    </button>
                  </div>
                ) : null}
                <div
                  className="process-step-list"
                  role="listbox"
                  tabIndex={-1}
                  aria-label={t('conv.process.stepsListAria')}
                  onKeyDown={handleListKeyDown}
                >
                  {visibleIndices.map((idx) => {
                    const step = steps[idx]!
                    const key = stepKeyOf(step, idx)
                    const isSelected = idx === safeIndex
                    const stepFailed = isStepFailed(step)
                    const stepRunning = isStepRunning(step)
                    const stats = step.kind === 'tool' ? toolRowStats(step.tool, t) : undefined
                    const subText =
                      step.kind === 'thinking'
                        ? thinkingPreviewLine(step.thinking.text)
                        : toolSummaryText(step.tool.toolName, step.tool.input)

                    return (
                      <button
                        key={`${key}:${idx}`}
                        ref={(el) => {
                          optionRefs.current[idx] = el
                        }}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={[
                          'process-step-item',
                          isSelected ? 'is-selected' : '',
                          stepFailed ? 'is-error' : '',
                          stepRunning ? 'is-running' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => selectAtIndex(idx)}
                      >
                        <div className="process-step-item-head">
                          <span className="process-step-index mono tabular-nums">{idx + 1}</span>
                          {step.kind === 'thinking' ? (
                            <HelmxIcon
                              name={step.thinking.active ? 'loader' : 'sparkles'}
                              size={12}
                              className={step.thinking.active ? 'spin-slow' : undefined}
                            />
                          ) : (
                            <HelmxIcon
                              name={toolStatusIcon(step.tool)}
                              size={12}
                              className={step.tool.status === 'running' ? 'spin-slow' : undefined}
                            />
                          )}
                          <span
                            className={`process-step-item-title${step.kind === 'tool' ? ' mono' : ''}`}
                          >
                            {step.kind === 'thinking'
                              ? step.thinking.active
                                ? t('conv.thinking.activeLabel')
                                : t('conv.thinking.label')
                              : step.tool.toolName}
                          </span>
                          <span className="process-step-item-meta mono tabular-nums">
                            {step.kind === 'tool' ? (
                              step.tool.status === 'running' ? (
                                step.tool.startedAt !== undefined ? (
                                  <StepElapsed startedAt={step.tool.startedAt} />
                                ) : null
                              ) : step.tool.durationMs !== undefined ? (
                                formatDurationMs(step.tool.durationMs)
                              ) : stepFailed ? (
                                t('conv.tool.statusFailed')
                              ) : null
                            ) : step.thinking.responseDurationMs !== undefined &&
                              step.thinking.responseDurationMs > 0 ? (
                              formatDurationMs(step.thinking.responseDurationMs)
                            ) : null}
                          </span>
                        </div>
                        {subText !== '' || stats !== undefined ? (
                          <div className="process-step-item-sub">
                            {subText !== '' ? (
                              <span className={`process-step-item-summary${step.kind === 'tool' ? ' mono' : ''}`}>
                                {subText}
                              </span>
                            ) : null}
                            {stats !== undefined ? (
                              <span className="trace-row-stats">
                                {stats.removeCount !== undefined ? (
                                  <span className="trace-row-stats-remove">−{stats.removeCount}</span>
                                ) : null}
                                {stats.addCount !== undefined ? (
                                  <span className="trace-row-stats-add">+{stats.addCount}</span>
                                ) : null}
                                {stats.text !== undefined ? <span>{stats.text}</span> : null}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </aside>
            ) : null}

            <div className="process-drawer-detail">
              <div className="process-detail-head">
                <div className="process-detail-head-row">
                  <div className="process-detail-title-wrap">
                    <span
                      className={`process-detail-title${selectedStep.kind === 'tool' ? ' mono' : ''}`}
                    >
                      {selectedStep.kind === 'thinking'
                        ? selectedStep.thinking.active
                          ? t('conv.thinking.activeLabel')
                          : t('conv.thinking.label')
                        : selectedStep.tool.toolName}
                    </span>
                    {isMulti ? (
                      <Badge tone="neutral" className="tabular-nums">
                        {t('conv.process.stepNumber', { index: safeIndex + 1 })}
                      </Badge>
                    ) : null}
                    {selectedRunning ? (
                      <Badge tone="accent">{t('conv.process.runningBadge')}</Badge>
                    ) : selectedFailed ? (
                      <Badge tone="err">{t('conv.process.statusError')}</Badge>
                    ) : selectedStep.kind === 'thinking' || selectedStep.tool.status === 'done' ? (
                      <Badge tone="ok">{t('conv.process.statusDone')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('conv.process.statusUnknown')}</Badge>
                    )}
                    {selectedStep.kind === 'tool' ? (
                      selectedStep.tool.status === 'running' && selectedStep.tool.startedAt !== undefined ? (
                        <span className="process-detail-elapsed mono tabular-nums">
                          <StepElapsed startedAt={selectedStep.tool.startedAt} />
                        </span>
                      ) : selectedStep.tool.durationMs !== undefined ? (
                        <span className="process-detail-elapsed mono tabular-nums">
                          {formatDurationMs(selectedStep.tool.durationMs)}
                        </span>
                      ) : null
                    ) : selectedStep.thinking.responseDurationMs !== undefined &&
                      selectedStep.thinking.responseDurationMs > 0 ? (
                      <span className="process-detail-elapsed mono tabular-nums">
                        {formatDurationMs(selectedStep.thinking.responseDurationMs)}
                      </span>
                    ) : null}
                    {selectedToolStats !== undefined ? (
                      <span className="trace-row-stats" title={selectedToolStats.title}>
                        {selectedToolStats.removeCount !== undefined ? (
                          <span className="trace-row-stats-remove">−{selectedToolStats.removeCount}</span>
                        ) : null}
                        {selectedToolStats.addCount !== undefined ? (
                          <span className="trace-row-stats-add">+{selectedToolStats.addCount}</span>
                        ) : null}
                        {selectedToolStats.text !== undefined ? <span>{selectedToolStats.text}</span> : null}
                      </span>
                    ) : null}
                  </div>
                  {selectedStep.kind === 'thinking' && selectedStep.thinking.text.trim() !== '' ? (
                    <CopyButton text={selectedStep.thinking.text} label={t('conv.process.copyThinking')} />
                  ) : null}
                </div>
                {selectedToolSummary !== '' ? (
                  <div className="process-detail-summary mono">{selectedToolSummary}</div>
                ) : null}
              </div>

              <div key={`${selectedStepKey}:${mode}`} className="process-detail-body selectable">
                {selectedStep.kind === 'thinking' ? (
                  <div className="process-thinking-body">
                    {selectedStep.thinking.text.trim() === '' ? (
                      <span className="trace-tool-note">{t('conv.process.emptyThinking')}</span>
                    ) : (
                      <MarkdownView
                        text={selectedStep.thinking.text}
                        conversationId={conversationId}
                        streaming={selectedStep.thinking.active === true}
                      />
                    )}
                  </div>
                ) : mode === 'io' ? (
                  <ToolIoBody tool={selectedStep.tool} conversationId={conversationId} surface="drawer" />
                ) : mode === 'raw' ? (
                  <ToolRawBody tool={selectedStep.tool} conversationId={conversationId} />
                ) : (
                  <ToolExpandedBody tool={selectedStep.tool} conversationId={conversationId} surface="drawer" />
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
