/**
 * Composer toolbar active-only Plan mode pill (`COMPOSER_TOOLBAR_SLOT`).
 * Renders zero visible chrome in normal/unarmed state while mounting a hidden
 * DOM anchor so host `Ctrl+.` panel shortcut (`toggle-plan-mode`) works at all
 * times. When active (planning / armed / awaiting), renders a compact pill with
 * quick exit affordance.
 * Returns null on non-eligible conversations (subagents / `helmx`-owned) without subscribing.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { ComposerToolbarSlotProps } from '@helmx/protocol/browser'
import {
  HelmxIcon,
  StatusLight,
  resolveLocalizedText,
  useComposerCommand,
  usePanelShortcut,
  usePluginLocale,
} from '@helmx/plugin-client'
import { PLAN_COPY } from './copy.ts'
import {
  isPlanEligibleConversation,
  isStandbyPlanArmed,
  resolvePlanVisualState,
} from './models.ts'
import { PLAN_COMMAND_ID, PLAN_PLUGIN_ID } from './types.ts'
import { usePlanConversationToggle } from './use-plan-toggle.ts'

function PlanToolbarButtonConversation({ conversationId }: { conversationId: number }): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { effectiveView, docError, pending, toggle } = usePlanConversationToggle(conversationId)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchorRef = useCallback((el: HTMLElement | null): void => {
    anchorRef.current = el
  }, [])

  const handleToggle = (): void => {
    if (!pending) {
      toggle()
    }
  }

  usePanelShortcut(anchorRef, 'toggle-plan-mode', handleToggle)
  useComposerCommand(PLAN_COMMAND_ID, handleToggle)

  const visual = resolvePlanVisualState(effectiveView)
  if (visual === 'normal') {
    return (
      <span
        ref={setAnchorRef}
        className="plan-shortcut-anchor"
        data-plan-mode="normal"
        data-plan-awaiting="false"
        hidden
      />
    )
  }

  const awaitingClarification = effectiveView.awaitingClarification === true && !effectiveView.awaitingApproval
  const label =
    visual === 'awaiting'
      ? t(awaitingClarification ? PLAN_COPY.toolbarAwaitingClarification : PLAN_COPY.toolbarAwaiting)
      : t(PLAN_COPY.toolbarPlanning)
  const baseTitle =
    visual === 'awaiting'
      ? t(awaitingClarification ? PLAN_COPY.toolbarTitleAwaitingClarification : PLAN_COPY.toolbarTitleAwaiting)
      : t(PLAN_COPY.toolbarTitlePlanning)
  const title = docError ? `${baseTitle} (${docError})` : baseTitle
  const stateClass = visual === 'awaiting' ? 'plan-toolbar-btn--awaiting' : 'plan-toolbar-btn--planning'

  return (
    <button
      ref={setAnchorRef}
      type="button"
      className={`plan-toolbar-btn ${stateClass}`}
      aria-pressed="true"
      aria-busy={pending || undefined}
      aria-label={title}
      title={title}
      disabled={pending}
      data-plan-mode={effectiveView.mode}
      data-plan-awaiting={effectiveView.awaitingApproval ? 'true' : 'false'}
      onClick={toggle}
    >
      {pending ? (
        <HelmxIcon name="loader" size={11} className="spin-slow" />
      ) : visual === 'awaiting' ? (
        <StatusLight
          tone="blocked"
          aria-label={t(awaitingClarification ? PLAN_COPY.modeClarifying : PLAN_COPY.modeAwaiting)}
        />
      ) : (
        <HelmxIcon name="list-tree" size={11.5} />
      )}
      <span className="plan-toolbar-btn-label">{label}</span>
      <HelmxIcon name="x" size={11} className="plan-toolbar-btn-close" />
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
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchorRef = useCallback((el: HTMLElement | null): void => {
    anchorRef.current = el
  }, [])
  const armed = isStandbyPlanArmed(draftMeta)

  const handleToggle = (): void => {
    if (!disabled) {
      setDraftMeta(PLAN_PLUGIN_ID, armed ? undefined : { mode: 'planning' })
    }
  }

  usePanelShortcut(anchorRef, 'toggle-plan-mode', handleToggle)
  useComposerCommand(PLAN_COMMAND_ID, handleToggle)

  if (!armed) {
    return (
      <span
        ref={setAnchorRef}
        className="plan-shortcut-anchor"
        data-plan-mode="normal"
        data-plan-awaiting="false"
        hidden
      />
    )
  }

  const label = t(PLAN_COPY.toolbarPlanning)
  const title = t(PLAN_COPY.toolbarTitleStandbyArmed)

  return (
    <button
      ref={setAnchorRef}
      type="button"
      className="plan-toolbar-btn plan-toolbar-btn--planning"
      aria-pressed="true"
      aria-label={title}
      title={title}
      disabled={disabled}
      data-plan-mode="planning"
      data-plan-awaiting="false"
      onClick={() => setDraftMeta(PLAN_PLUGIN_ID, undefined)}
    >
      <HelmxIcon name="list-tree" size={11.5} />
      <span className="plan-toolbar-btn-label">{label}</span>
      <HelmxIcon name="x" size={11} className="plan-toolbar-btn-close" />
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
