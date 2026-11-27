/**
 * Composer-dock plan tray (`COMPOSER_DOCK_SLOT`) for builtin:plan.
 * Returns null (0px height) in normal mode and on non-eligible conversations.
 * Automatically opens the Plan workbench panel on desktop when awaiting approval begins,
 * and includes an inline scrollable Markdown preview inside the expanded tray.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  DockTray,
  DockTrayRow,
  formatCompactTimestamp,
  resolveLocalizedText,
} from '@helmx/ui'
import {
  MarkdownView,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  usePluginSessionDocState,
} from '@helmx/plugin-client'
import { PLAN_COPY, planActionFailedNotice, planDraftTrayMeta, planVersionLabel } from './copy.ts'
import { isPlanEligibleConversation, parsePlanSessionView } from './models.ts'
import { PLAN_PANEL_ID, PLAN_SESSION_DOC, type PlanSessionView } from './types.ts'

const DESKTOP_AUTO_OPEN_MIN_WIDTH = 900

function PlanActiveTrayInner({ conversationId }: { conversationId: number }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const docState = usePluginSessionDocState<unknown>(PLAN_SESSION_DOC, { conversationId })
  const rawDocRef = useRef<unknown>(docState.data)
  rawDocRef.current = docState.data

  const [expanded, setExpanded] = useState(false)
  const [pendingView, setPendingView] = useState<{
    conversationId: number
    baseDoc: unknown
    view: PlanSessionView
  } | null>(null)

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  useEffect(() => {
    setPendingView((prev) =>
      prev !== null && prev.conversationId === conversationId && prev.baseDoc === docState.data ? prev : null,
    )
  }, [conversationId, docState.data])

  const exitAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      planActionFailedNotice(t(PLAN_COPY.actionExit), err instanceof Error ? err.message : String(err), locale),
  })

  const docView = parsePlanSessionView(docState.data)
  const effectiveView =
    pendingView !== null && pendingView.conversationId === conversationId && pendingView.baseDoc === docState.data
      ? pendingView.view
      : docView

  const settledApprovalRef = useRef<{ conversationId: number; awaitingApproval: boolean } | null>(null)
  useEffect(() => {
    if (docState.status === 'loading' && docView === undefined) return
    const currentAwaiting = effectiveView?.awaitingApproval === true
    const prev = settledApprovalRef.current
    if (prev === null || prev.conversationId !== conversationId) {
      settledApprovalRef.current = { conversationId, awaitingApproval: currentAwaiting }
      return
    }
    settledApprovalRef.current = { conversationId, awaitingApproval: currentAwaiting }
    if (
      !prev.awaitingApproval &&
      currentAwaiting &&
      typeof window !== 'undefined' &&
      window.innerWidth > DESKTOP_AUTO_OPEN_MIN_WIDTH
    ) {
      ctx.openWorkbench(PLAN_PANEL_ID)
    }
  }, [conversationId, docState.status, docView, effectiveView?.awaitingApproval, ctx])

  if (
    effectiveView === undefined ||
    effectiveView.mode !== 'planning' ||
    (effectiveView.draft === undefined && !effectiveView.awaitingApproval)
  ) {
    return null
  }

  const awaitingApproval = effectiveView.awaitingApproval
  const draft = effectiveView.draft
  const statusTone = awaitingApproval ? 'blocked' : 'working'
  const statusText = t(awaitingApproval ? PLAN_COPY.trayAwaitingStatus : PLAN_COPY.trayPlanningStatus)
  const draftTitle = draft?.title ?? t(PLAN_COPY.trayNoDraftHint)
  const updatedText =
    draft !== undefined && draft.updatedAt > 0 ? formatCompactTimestamp(draft.updatedAt) : undefined
  const rowMeta = planDraftTrayMeta(
    draft !== undefined,
    awaitingApproval,
    updatedText,
    locale,
  )
  const toggleVerb = t(expanded ? PLAN_COPY.trayCollapse : PLAN_COPY.trayExpand)

  const handleExit = (): void => {
    const baseDoc = rawDocRef.current
    void exitAction.run(
      'set_mode',
      { conversationId, mode: 'normal' },
      {
        conversationId,
        onSuccess: (raw) => {
          const parsed = parsePlanSessionView(raw)
          if (parsed !== undefined && rawDocRef.current === baseDoc) {
            setPendingView({ conversationId, baseDoc, view: parsed })
          }
        },
      },
    )
  }

  const versionBadge =
    draft !== undefined ? (
      <Badge tone={awaitingApproval ? 'warn' : 'accent'} className="dock-tray-badge tabular-nums">
        {planVersionLabel(draft.version)}
      </Badge>
    ) : undefined

  const openButton = (
    <Button
      variant="ghost"
      size="xs"
      icon="file-text"
      className="dock-tray-workbench dock-tray-workbench-btn"
      title={t(PLAN_COPY.trayOpenPlan)}
      aria-label={t(PLAN_COPY.trayOpenPlan)}
      onClick={() => ctx.openWorkbench(PLAN_PANEL_ID)}
    >
      <span className="dock-tray-action-label">{t(PLAN_COPY.trayOpenPlan)}</span>
    </Button>
  )

  const exitButton = (
    <Button
      variant="ghost"
      size="xs"
      icon="x"
      className="dock-tray-workbench plan-tray-exit-btn"
      pending={exitAction.pending}
      disabled={exitAction.pending}
      title={t(PLAN_COPY.trayExitPlanning)}
      aria-label={t(PLAN_COPY.trayExitPlanning)}
      onClick={handleExit}
    >
      <span className="dock-tray-action-label">{t(PLAN_COPY.trayExitPlanning)}</span>
    </Button>
  )

  return (
    <DockTray
      classPrefix="plan-tray"
      warn={awaitingApproval}
      regionLabel={t(PLAN_COPY.trayRegionAria)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={`${statusText} — ${toggleVerb}`}
      toggleTitle={toggleVerb}
      status={statusTone}
      statusLabel={statusText}
      badge={versionBadge}
      count={statusText}
      frontline={
        <span className="dock-tray-frontline" title={draftTitle}>
          {draftTitle}
        </span>
      }
      barAction={
        <div className="plan-tray-bar-actions">
          {openButton}
          {exitButton}
        </div>
      }
    >
      <DockTrayRow
        classPrefix="plan-tray"
        status={statusTone}
        statusLabel={statusText}
        title={draft?.title ?? t(PLAN_COPY.trayNoDraftTitle)}
        badge={versionBadge}
        live={
          <span className="dock-tray-row-live" title={rowMeta}>
            {rowMeta}
          </span>
        }
        onOpen={() => ctx.openWorkbench(PLAN_PANEL_ID)}
        openAriaLabel={t(PLAN_COPY.trayOpenPlan)}
        actions={
          <Button
            variant="ghost"
            size="xs"
            icon="x"
            pending={exitAction.pending}
            disabled={exitAction.pending}
            title={t(PLAN_COPY.trayExitPlanning)}
            aria-label={t(PLAN_COPY.trayExitPlanning)}
            onClick={handleExit}
          >
            <span className="dock-tray-action-label">{t(PLAN_COPY.trayExitPlanning)}</span>
          </Button>
        }
      />
      {draft !== undefined && draft.markdown.trim() !== '' ? (
        <MarkdownView
          className="plan-tray-preview selectable"
          text={draft.markdown}
          conversationId={conversationId}
        />
      ) : null}
    </DockTray>
  )
}

export function PlanActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  if (conversationId === undefined) return null
  if (props.conversation !== undefined && !isPlanEligibleConversation(props.conversation)) {
    return null
  }
  return <PlanActiveTrayInner conversationId={conversationId} />
}
