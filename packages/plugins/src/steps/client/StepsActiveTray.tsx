/**
 * Composer-dock live task checklist (`COMPOSER_DOCK_SLOT`) for builtin:steps.
 * Returns null (0px height) when absent, dismissed, standby, or on non-eligible conversations.
 * Desktop (`innerWidth > 680`) defaults expanded while in progress and auto-collapses once terminal;
 * mobile defaults collapsed to the 32px single-line bar.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps, ConversationStatus } from '@helmx/protocol/browser'
import {
  Badge,
  DockTray,
  DockTrayRow,
  IconButton,
  resolveLocalizedText,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  usePluginSessionDocState,
} from '@helmx/plugin-client'
import {
  STEPS_COPY,
  stepsDismissFailedNotice,
  stepsHeaderStatusLabel,
  stepsItemStatusLabel,
  stepsTrayFrontline,
  stepsTrayHeaderCount,
} from './copy.ts'
import {
  DESKTOP_DEFAULT_EXPAND_MIN_WIDTH,
  deriveStepsTraySummary,
  isStepsEligibleConversation,
  parseStepsSessionView,
  resolveStepItemVisualTone,
} from './models.ts'
import { STEPS_SESSION_DOC } from './types.ts'

function isDesktopDefaultExpanded(): boolean {
  return typeof window === 'undefined' ? true : window.innerWidth > DESKTOP_DEFAULT_EXPAND_MIN_WIDTH
}

function StepsActiveTrayInner({
  conversationId,
  conversationStatus,
}: {
  conversationId: number
  conversationStatus: ConversationStatus | undefined
}): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const docState = usePluginSessionDocState<unknown>(STEPS_SESSION_DOC, { conversationId })
  const rawDocRef = useRef<unknown>(docState.data)
  rawDocRef.current = docState.data

  const docView = parseStepsSessionView(docState.data)
  const hasVisibleSteps = docView !== undefined && docView.steps.length > 0 && !docView.dismissed

  const [expanded, setExpanded] = useState<boolean>(() => isDesktopDefaultExpanded())
  const [pendingDismiss, setPendingDismiss] = useState<{
    conversationId: number
    baseDoc: unknown
    version: number
  } | null>(null)

  useEffect(() => {
    setPendingDismiss((prev) =>
      prev !== null && prev.conversationId === conversationId && prev.baseDoc === docState.data ? prev : null,
    )
  }, [conversationId, docState.data])

  const prevStateRef = useRef<{
    conversationId: number
    hasSteps: boolean
    allTerminal: boolean
  } | null>(null)

  useEffect(() => {
    if (docState.status === 'loading' && docView === undefined) return
    const nextHasSteps = hasVisibleSteps
    const nextAllTerminal = docView?.allTerminal === true
    const prev = prevStateRef.current
    prevStateRef.current = {
      conversationId,
      hasSteps: nextHasSteps,
      allTerminal: nextAllTerminal,
    }

    if (prev === null || prev.conversationId !== conversationId) {
      setExpanded(nextHasSteps ? isDesktopDefaultExpanded() && !nextAllTerminal : isDesktopDefaultExpanded())
      return
    }
    if (!prev.hasSteps && nextHasSteps) {
      setExpanded(isDesktopDefaultExpanded() && !nextAllTerminal)
      return
    }
    if (prev.hasSteps && nextHasSteps) {
      if (!prev.allTerminal && nextAllTerminal) {
        setExpanded(false)
      } else if (prev.allTerminal && !nextAllTerminal && isDesktopDefaultExpanded()) {
        setExpanded(true)
      }
    }
  }, [conversationId, docState.status, docView, hasVisibleSteps])

  const dismissAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      stepsDismissFailedNotice(err instanceof Error ? err.message : String(err), locale),
  })

  if (docView === undefined || docView.steps.length === 0 || docView.dismissed) {
    return null
  }
  if (
    pendingDismiss !== null &&
    pendingDismiss.conversationId === conversationId &&
    pendingDismiss.baseDoc === docState.data &&
    pendingDismiss.version === docView.version
  ) {
    return null
  }

  const summary = deriveStepsTraySummary(docView, conversationStatus)
  const headerStatusText = stepsHeaderStatusLabel(summary, locale)
  const headerCountText = stepsTrayHeaderCount(summary, locale)
  const frontlineText = stepsTrayFrontline(summary, locale)
  const toggleVerb = t(expanded ? STEPS_COPY.trayCollapse : STEPS_COPY.trayExpand)

  const handleDismiss = (): void => {
    if (dismissAction.pending) return
    const baseDoc = rawDocRef.current
    const targetVersion = docView.version
    void dismissAction.run(
      'dismiss',
      { conversationId },
      {
        conversationId,
        onSuccess: (raw) => {
          const parsed = parseStepsSessionView(raw)
          if (rawDocRef.current === baseDoc && (parsed === undefined || parsed.dismissed)) {
            setPendingDismiss({ conversationId, baseDoc, version: targetVersion })
          }
        },
      },
    )
  }

  return (
    <DockTray
      classPrefix="steps-tray"
      warn={summary.warn}
      regionLabel={t(STEPS_COPY.trayRegionAria)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={`${headerStatusText} — ${toggleVerb}`}
      toggleTitle={toggleVerb}
      status={summary.statusTone}
      statusLabel={headerStatusText}
      badge={
        <Badge tone={summary.badgeTone} mono className="dock-tray-badge tabular-nums">
          {`${summary.done}/${summary.total}`}
        </Badge>
      }
      count={headerCountText}
      frontline={
        frontlineText !== undefined ? (
          <span className="dock-tray-frontline" title={frontlineText}>
            {frontlineText}
          </span>
        ) : undefined
      }
      barAction={
        <IconButton
          icon="x"
          size="xs"
          label={t(STEPS_COPY.trayDismiss)}
          className="dock-tray-workbench steps-tray-dismiss-btn"
          pending={dismissAction.pending}
          disabled={dismissAction.pending}
          onClick={handleDismiss}
        />
      }
    >
      {docView.steps.map((step, index) => {
        const tone = resolveStepItemVisualTone(step.status, summary.isWorking, docView.settledOutcome)
        const itemStatusText = stepsItemStatusLabel(
          step.status,
          summary.isWorking,
          docView.settledOutcome,
          locale,
        )
        const showPausedTag = step.status === 'in_progress' && !summary.isWorking
        const rowBadge =
          step.status === 'failed' ? (
            <Badge tone="err" className="steps-tray-row-tag">
              {t(STEPS_COPY.statusFailed)}
            </Badge>
          ) : step.status === 'skipped' ? (
            <Badge tone="neutral" className="steps-tray-row-tag">
              {t(STEPS_COPY.statusSkipped)}
            </Badge>
          ) : showPausedTag ? (
            <Badge tone="warn" className="steps-tray-row-tag">
              {itemStatusText}
            </Badge>
          ) : undefined

        return (
          <DockTrayRow
            key={`${index}:${step.title}`}
            classPrefix="steps-tray"
            status={tone}
            statusLabel={itemStatusText}
            title={step.title}
            actions={rowBadge}
          />
        )
      })}
    </DockTray>
  )
}

export function StepsActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  if (conversationId === undefined) return null
  if (props.conversation !== undefined && !isStepsEligibleConversation(props.conversation)) {
    return null
  }
  return (
    <StepsActiveTrayInner
      conversationId={conversationId}
      conversationStatus={props.conversation?.status}
    />
  )
}
