/**
 * Clean single-column right-side detail drawer for Level 2 inspection of a
 * settled thinking step, tool execution step, or plugin tool I/O payload.
 * Multi-step navigation lives unobtrusively in the header (`N / M` dropdown,
 * prev/next buttons, and Alt+Up/Down or [ / ] shortcuts).
 *
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from 'react'
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  useSharedNowMs,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs, formatStopwatchMs } from '../lib/format.js'
import { useIsMobile } from './composer-model.js'
import { MarkdownView } from './MarkdownView.js'
import {
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
  onToggleFollowLive?: () => void
  onClose: () => void
}

function StepElapsed({ startedAt }: { startedAt: number }): ReactNode {
  const nowMs = useSharedNowMs(true)
  if (nowMs === undefined) return null
  return <span className="tabular-nums">{formatStopwatchMs(Math.max(0, nowMs - startedAt))}</span>
}

function isStepBracketShortcutBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null) {
    return true
  }
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  return selection !== null && !selection.isCollapsed
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
  onToggleFollowLive,
  onClose,
}: ProcessInspectorDrawerProps): ReactNode {
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const detailScrollRef = useRef<HTMLDivElement | null>(null)
  const stickyBottomRef = useRef(true)
  const prevOpenRef = useRef(open)

  if (prevOpenRef.current !== open) {
    prevOpenRef.current = open
    if (!open && desktopFullscreen) {
      setDesktopFullscreen(false)
    }
  }

  const summary = useMemo(() => summarizeStepGroup(steps), [steps])
  const safeIndex = steps.length > 0 ? Math.max(0, Math.min(steps.length - 1, selectedIndex)) : -1
  const selectedStep = safeIndex >= 0 ? steps[safeIndex] : undefined
  const selectedStepKey = selectedStep !== undefined ? stepKeyOf(selectedStep, safeIndex) : ''
  const selectedRunning = selectedStep !== undefined && isStepRunning(selectedStep)
  const streamingContent =
    selectedStep === undefined
      ? ''
      : selectedStep.kind === 'thinking'
        ? selectedStep.thinking.text
        : (selectedStep.tool.resultText ?? '')

  // Reset scrollTop cleanly on step or mode switches without disturbing a settled step
  useEffect(() => {
    if (!open) return
    stickyBottomRef.current = true
    const el = detailScrollRef.current
    if (el !== null) {
      el.scrollTop = 0
    }
  }, [open, selectedStepKey, mode])

  // Pin scrolling to the bottom while actively streaming unless the user scrolled up
  useEffect(() => {
    if (!open || !selectedRunning || !stickyBottomRef.current) return
    const el = detailScrollRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  }, [open, selectedRunning, streamingContent])

  if (!open || steps.length === 0 || selectedStep === undefined) return null

  const isMulti = steps.length > 1
  const selectedFailed = isStepFailed(selectedStep)
  const selectedToolStats = selectedStep.kind === 'tool' ? toolRowStats(selectedStep.tool, t) : undefined
  const selectedToolSummary =
    selectedStep.kind === 'tool' ? toolSummaryText(selectedStep.tool.toolName, selectedStep.tool.input) : ''
  const nestedInDrawerStack =
    !inline && typeof document !== 'undefined' && document.querySelector('.drawer-stack-dialog') !== null

  const headerTitle: ReactNode =
    selectedStep.kind === 'thinking'
      ? selectedStep.thinking.active
        ? t('conv.thinking.activeLabel')
        : t('conv.thinking.label')
      : <span className="mono">{selectedStep.tool.toolName}</span>

  const headerIcon: ReactNode =
    selectedStep.kind === 'thinking' ? (
      <HelmxIcon
        name={selectedStep.thinking.active ? 'loader' : 'sparkles'}
        size={14}
        className={`process-drawer-status-icon${selectedStep.thinking.active ? ' spin-slow is-running' : ''}`}
      />
    ) : (
      <HelmxIcon
        name={toolStatusIcon(selectedStep.tool)}
        size={14}
        className={`process-drawer-status-icon${selectedStep.tool.status === 'running' ? ' spin-slow is-running' : ''}${selectedStep.tool.isError ? ' is-error' : ''}`}
      />
    )

  const prevStepIdx = safeIndex > 0 ? safeIndex - 1 : undefined
  const nextStepIdx = safeIndex < steps.length - 1 ? safeIndex + 1 : undefined

  const selectAtIndex = (index: number): void => {
    const step = steps[index]
    if (step === undefined) return
    onSelectStep(index, stepKeyOf(step, index))
  }

  // Non-hijacking step navigation: never consume bare ArrowUp/ArrowDown so detail scrolling stays native.
  const handleContentKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isMulti) return
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'ArrowUp' && prevStepIdx !== undefined) {
        event.preventDefault()
        selectAtIndex(prevStepIdx)
      } else if (event.key === 'ArrowDown' && nextStepIdx !== undefined) {
        event.preventDefault()
        selectAtIndex(nextStepIdx)
      }
      return
    }
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !isStepBracketShortcutBlocked(event.target)
    ) {
      if (event.key === '[' && prevStepIdx !== undefined) {
        event.preventDefault()
        selectAtIndex(prevStepIdx)
      } else if (event.key === ']' && nextStepIdx !== undefined) {
        event.preventDefault()
        selectAtIndex(nextStepIdx)
      }
    }
  }

  const handleDetailScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
  }

  const drawerClass = [
    'process-inspector-drawer',
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
        <DialogOverlay
          className={`modal-backdrop process-inspector-backdrop${nestedInDrawerStack ? ' process-inspector-backdrop-nested' : ''}`}
        />
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className={drawerClass}
          aria-label={t('conv.process.drawerAria')}
          aria-describedby={undefined}
          onKeyDown={handleContentKeyDown}
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
                    <span className="process-drawer-duration mono tabular-nums">
                      <StepElapsed startedAt={selectedStep.tool.startedAt} />
                    </span>
                  ) : selectedStep.tool.durationMs !== undefined ? (
                    <span className="process-drawer-duration mono tabular-nums">
                      {formatDurationMs(selectedStep.tool.durationMs)}
                    </span>
                  ) : null
                ) : selectedStep.thinking.responseDurationMs !== undefined &&
                  selectedStep.thinking.responseDurationMs > 0 ? (
                  <span className="process-drawer-duration mono tabular-nums">
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
            </div>

            <div className="process-drawer-actions">
              {selectedStep.kind === 'thinking' && selectedStep.thinking.text.trim() !== '' ? (
                <CopyButton text={selectedStep.thinking.text} label={t('conv.process.copyThinking')} />
              ) : null}
              {isMulti ? (
                <>
                  {active && onToggleFollowLive !== undefined ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className={followLive === true ? 'is-active' : undefined}
                      aria-pressed={followLive === true}
                      icon="arrow-down-to-line"
                      title={followLive ? t('conv.process.pauseFollowTitle') : t('conv.process.followLiveTitle')}
                      onClick={onToggleFollowLive}
                    >
                      {followLive ? t('conv.process.followingLive') : t('conv.process.followLive')}
                    </Button>
                  ) : null}
                  {inline ? (
                    <Badge tone="neutral" mono className="tabular-nums">
                      {t('conv.process.stepCounter', { current: safeIndex + 1, total: steps.length })}
                    </Badge>
                  ) : (
                    <DropdownMenuRoot>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={`process-step-picker-trigger${summary.errorCount > 0 ? ' has-error' : ''}`}
                          aria-label={t('conv.process.jumpToStepAria', {
                            current: safeIndex + 1,
                            total: steps.length,
                          })}
                          title={t('conv.process.jumpToStepAria', {
                            current: safeIndex + 1,
                            total: steps.length,
                          })}
                        >
                          <span className="mono tabular-nums">
                            {t('conv.process.stepCounter', { current: safeIndex + 1, total: steps.length })}
                          </span>
                          <HelmxIcon name="chevron-down" size={11} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuPortal inline={inline}>
                        <DropdownMenuContent className="process-step-menu" align="end">
                          {steps.map((step, idx) => {
                            const key = stepKeyOf(step, idx)
                            const itemSelected = idx === safeIndex
                            const itemFailed = isStepFailed(step)
                            const itemRunning = isStepRunning(step)
                            const itemTitle =
                              step.kind === 'thinking'
                                ? step.thinking.active
                                  ? t('conv.thinking.activeLabel')
                                  : t('conv.thinking.label')
                                : step.tool.toolName
                            const itemSummary =
                              step.kind === 'thinking'
                                ? thinkingPreviewLine(step.thinking.text)
                                : toolSummaryText(step.tool.toolName, step.tool.input)
                            return (
                              <DropdownMenuItem
                                key={`${key}:${idx}`}
                                className={`process-step-menu-item${itemSelected ? ' is-selected' : ''}${itemFailed ? ' is-error' : ''}${itemRunning ? ' is-running' : ''}`}
                                onSelect={() => selectAtIndex(idx)}
                              >
                                <span className="process-step-menu-index mono tabular-nums">{idx + 1}</span>
                                {step.kind === 'thinking' ? (
                                  <HelmxIcon
                                    name={step.thinking.active ? 'loader' : 'sparkles'}
                                    size={12}
                                    className={`process-step-menu-icon${step.thinking.active ? ' spin-slow is-running' : ''}`}
                                  />
                                ) : (
                                  <HelmxIcon
                                    name={toolStatusIcon(step.tool)}
                                    size={12}
                                    className={`process-step-menu-icon${step.tool.status === 'running' ? ' spin-slow is-running' : ''}${itemFailed ? ' is-error' : ''}`}
                                  />
                                )}
                                <span className="process-step-menu-text">
                                  <span className={`process-step-menu-title${step.kind === 'tool' ? ' mono' : ''}`}>
                                    {itemTitle}
                                  </span>
                                  {itemSummary !== '' ? (
                                    <span className={`process-step-menu-sub${step.kind === 'tool' ? ' mono' : ''}`}>
                                      {itemSummary}
                                    </span>
                                  ) : null}
                                </span>
                              </DropdownMenuItem>
                            )
                          })}
                        </DropdownMenuContent>
                      </DropdownMenuPortal>
                    </DropdownMenuRoot>
                  )}
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

          {selectedToolSummary !== '' ? (
            <div className="process-detail-subheader">
              <div className="process-detail-summary mono">{selectedToolSummary}</div>
            </div>
          ) : null}

          <div className="process-drawer-body">
            <div ref={detailScrollRef} className="process-drawer-detail" onScroll={handleDetailScroll}>
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
