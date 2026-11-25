/**
 * Unified composer `+` menu item for builtin:plan (`COMPOSER_MENU_SLOT`).
 * Works on both top-level human conversations (toggles persisted mode via `toggle` action)
 * and standby drafts (arms/clears per-draft `inputMeta['builtin:plan']` before first send).
 * Returns null on non-eligible conversations (subagents / `helmx`-owned) without subscribing.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import type { ComposerMenuSlotProps } from '@helmx/protocol/browser'
import {
  DropdownMenuItem,
  HelmxIcon,
  resolveLocalizedText,
  usePluginLocale,
} from '@helmx/plugin-client'
import { PLAN_COPY } from './copy.ts'
import { isPlanEligibleConversation, isStandbyPlanArmed } from './models.ts'
import { PLAN_PLUGIN_ID } from './types.ts'
import { usePlanConversationToggle } from './use-plan-toggle.ts'

function PlanMenuItemConversation({
  conversationId,
  disabled,
  onCloseMenu,
}: {
  conversationId: number
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { effectiveView, pending, toggle } = usePlanConversationToggle(conversationId)
  const active = effectiveView.mode === 'planning'

  return (
    <DropdownMenuItem
      className={`plan-menu-item${active ? ' plan-menu-item--active' : ''}`}
      disabled={disabled || pending}
      data-plan-mode={effectiveView.mode}
      data-plan-awaiting={effectiveView.awaitingApproval ? 'true' : 'false'}
      onSelect={() => {
        toggle()
        onCloseMenu?.()
      }}
    >
      <HelmxIcon
        name={pending ? 'loader' : 'list-tree'}
        size={14}
        className={pending ? 'plan-menu-item-icon spin-slow' : 'plan-menu-item-icon'}
      />
      <span className="plan-menu-item-label">{t(PLAN_COPY.menuLabel)}</span>
      <span className="plan-menu-item-trailing">
        {active ? <HelmxIcon name="check" size={13} className="plan-menu-item-check" /> : null}
        <span className="plan-menu-item-kbd mono">Ctrl+.</span>
      </span>
    </DropdownMenuItem>
  )
}

function PlanMenuItemStandby({
  draftMeta,
  setDraftMeta,
  disabled,
  onCloseMenu,
}: {
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const armed = isStandbyPlanArmed(draftMeta)

  return (
    <DropdownMenuItem
      className={`plan-menu-item${armed ? ' plan-menu-item--active' : ''}`}
      disabled={disabled}
      data-plan-mode={armed ? 'planning' : 'normal'}
      data-plan-awaiting="false"
      onSelect={() => {
        setDraftMeta(PLAN_PLUGIN_ID, armed ? undefined : { mode: 'planning' })
        onCloseMenu?.()
      }}
    >
      <HelmxIcon name="list-tree" size={14} className="plan-menu-item-icon" />
      <span className="plan-menu-item-label">{t(PLAN_COPY.menuLabel)}</span>
      <span className="plan-menu-item-trailing">
        {armed ? <HelmxIcon name="check" size={13} className="plan-menu-item-check" /> : null}
        <span className="plan-menu-item-kbd mono">Ctrl+.</span>
      </span>
    </DropdownMenuItem>
  )
}

export function PlanMenuItem(props: ComposerMenuSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isPlanEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <PlanMenuItemConversation
        conversationId={props.conversation.id}
        disabled={props.disabled === true}
        onCloseMenu={props.onCloseMenu}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <PlanMenuItemStandby
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
      onCloseMenu={props.onCloseMenu}
    />
  )
}
