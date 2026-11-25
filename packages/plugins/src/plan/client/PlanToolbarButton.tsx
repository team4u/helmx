/**
 * Composer toolbar Plan mode toggle (`COMPOSER_TOOLBAR_SLOT`).
 * Works on both top-level human conversations (toggles persisted mode via `toggle` action)
 * and standby drafts (arms/clears per-draft `inputMeta['builtin:plan']` before first send).
 * Returns null on non-eligible conversations (subagents / `helmx`-owned) without subscribing.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerToolbarSlotProps } from '@helmx/protocol/browser'
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
  isStandbyPlanArmed,
  parsePlanSessionView,
  resolvePlanVisualState,
} from './models.ts'
import { PLAN_PLUGIN_ID, PLAN_SESSION_DOC, type PlanSessionView } from './types.ts'

const DEFAULT_NORMAL_VIEW: PlanSessionView = {
  mode: 'normal',
  awaitingApproval: false,
}

function PlanToolbarButtonConversation({ conversationId }: { conversationId: number }): ReactNode {
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
      ? t(PLAN_COPY.toolbarAwaiting)
      : visual === 'planning'
        ? t(PLAN_COPY.toolbarPlanning)
        : t(PLAN_COPY.toolbarNormal)
  const baseTitle =
    visual === 'awaiting'
      ? t(PLAN_COPY.toolbarTitleAwaiting)
      : visual === 'planning'
        ? t(PLAN_COPY.toolbarTitlePlanning)
        : t(PLAN_COPY.toolbarTitleNormal)
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
      ? 'plan-toolbar-btn--awaiting'
      : visual === 'planning'
        ? 'plan-toolbar-btn--planning'
        : 'plan-toolbar-btn--normal'

  return (
    <button
      type="button"
      className={`plan-toolbar-btn ${stateClass}`}
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
        <HelmxIcon name="loader" size={13} className="spin-slow" />
      ) : visual === 'awaiting' ? (
        <StatusLight tone="blocked" label={t(PLAN_COPY.modeAwaiting)} />
      ) : (
        <HelmxIcon name="list-tree" size={13} />
      )}
      <span className="plan-toolbar-btn-label">{label}</span>
    </button>
  )
}

function PlanToolbarButtonStandby({
  draftMeta,
  setDraftMeta,
  disabled,
}: {
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const armed = isStandbyPlanArmed(draftMeta)
  const label = t(armed ? PLAN_COPY.toolbarPlanning : PLAN_COPY.toolbarNormal)
  const title = t(armed ? PLAN_COPY.toolbarTitleStandbyArmed : PLAN_COPY.toolbarTitleStandbyNormal)

  return (
    <button
      type="button"
      className={`plan-toolbar-btn ${armed ? 'plan-toolbar-btn--planning' : 'plan-toolbar-btn--normal'}`}
      aria-pressed={armed}
      aria-label={title}
      title={title}
      disabled={disabled}
      data-plan-mode={armed ? 'planning' : 'normal'}
      data-plan-awaiting="false"
      onClick={() => setDraftMeta(PLAN_PLUGIN_ID, armed ? undefined : { mode: 'planning' })}
    >
      <HelmxIcon name="list-tree" size={13} />
      <span className="plan-toolbar-btn-label">{label}</span>
    </button>
  )
}

export function PlanToolbarButton(props: ComposerToolbarSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isPlanEligibleConversation(props.conversation)) {
      return null
    }
    return <PlanToolbarButtonConversation conversationId={props.conversation.id} />
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <PlanToolbarButtonStandby
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
    />
  )
}
