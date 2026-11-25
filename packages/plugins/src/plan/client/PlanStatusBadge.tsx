/**
 * Composer status-row Plan mode indicator & toggle (`COMPOSER_STATUS_SLOT`).
 * Returns null on standby drafts (`conversation === undefined`) and non-top-level or
 * non-human conversations without subscribing to session docs.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerStatusSlotProps } from '@helmx/protocol/browser'
import {
  HelmxIcon,
  StatusLight,
  resolveLocalizedText,
  usePluginAction,
  usePluginLocale,
  usePluginSessionDocState,
} from '@helmx/plugin-client'
import { PLAN_COPY, planActionFailedNotice } from './copy.ts'
import {
  isPlanEligibleConversation,
  parsePlanSessionView,
  resolvePlanVisualState,
} from './models.ts'
import { PLAN_SESSION_DOC, type PlanSessionView } from './types.ts'

const DEFAULT_NORMAL_VIEW: PlanSessionView = {
  mode: 'normal',
  awaitingApproval: false,
}

function PlanStatusBadgeInner({ conversationId }: { conversationId: number }): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const docState = usePluginSessionDocState<unknown>(PLAN_SESSION_DOC, { conversationId })
  const rawDocRef = useRef<unknown>(docState.data)
  rawDocRef.current = docState.data

  const [pendingView, setPendingView] = useState<{
    conversationId: number
    baseDoc: unknown
    view: PlanSessionView
  } | null>(null)

  useEffect(() => {
    setPendingView((prev) =>
      prev !== null && prev.conversationId === conversationId && prev.baseDoc === docState.data ? prev : null,
    )
  }, [conversationId, docState.data])

  const docView = parsePlanSessionView(docState.data)
  const effectiveView =
    pendingView !== null && pendingView.conversationId === conversationId && pendingView.baseDoc === docState.data
      ? pendingView.view
      : (docView ?? DEFAULT_NORMAL_VIEW)

  const toggleAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      planActionFailedNotice(t(PLAN_COPY.actionToggle), err instanceof Error ? err.message : String(err), locale),
  })

  const visual = resolvePlanVisualState(effectiveView)
  const label =
    visual === 'awaiting'
      ? t(PLAN_COPY.badgeAwaiting)
      : visual === 'planning'
        ? t(PLAN_COPY.badgePlanning)
        : t(PLAN_COPY.badgeNormal)
  const baseTitle =
    visual === 'awaiting'
      ? t(PLAN_COPY.badgeTitleAwaiting)
      : visual === 'planning'
        ? t(PLAN_COPY.badgeTitlePlanning)
        : t(PLAN_COPY.badgeTitleNormal)
  const title = docState.status === 'error' && docState.error ? `${baseTitle} (${docState.error})` : baseTitle

  const handleToggle = (): void => {
    const baseDoc = rawDocRef.current
    void toggleAction.run(
      'toggle',
      { conversationId },
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

  const stateClass =
    visual === 'awaiting'
      ? 'plan-status-btn--awaiting'
      : visual === 'planning'
        ? 'plan-status-btn--planning'
        : 'plan-status-btn--normal'

  return (
    <button
      type="button"
      className={`plan-status-btn ${stateClass}`}
      aria-pressed={effectiveView.mode === 'planning'}
      aria-busy={toggleAction.pending || undefined}
      aria-label={title}
      title={title}
      disabled={toggleAction.pending}
      data-plan-mode={effectiveView.mode}
      data-plan-awaiting={effectiveView.awaitingApproval ? 'true' : 'false'}
      onClick={handleToggle}
    >
      {toggleAction.pending ? (
        <HelmxIcon name="loader" size={11} className="spin-slow" />
      ) : visual === 'awaiting' ? (
        <StatusLight tone="blocked" label={t(PLAN_COPY.modeAwaiting)} />
      ) : (
        <HelmxIcon name="list-tree" size={11} />
      )}
      <span className="plan-status-btn-label">{label}</span>
    </button>
  )
}

export function PlanStatusBadge(props: ComposerStatusSlotProps): ReactNode {
  if (!isPlanEligibleConversation(props.conversation)) {
    return null
  }
  return <PlanStatusBadgeInner conversationId={props.conversation.id} />
}
